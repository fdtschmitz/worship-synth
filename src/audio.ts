import { midiToHz, padVoicing, type ChordType } from './chords';
import { fitNote, loadSampleSet, nearest, type SampleSet } from './samples';
import { arpIndex, arpPool, brokenStep, stepSeconds, type NoteEvent, type RhythmSettings } from './sequencer';
import { isStruck, timbreById, type Layer, type Timbre } from './timbres';

/** Um acorde do loop e sua duração, em tempos. */
export interface LoopStep {
  root: number;
  type: ChordType;
  bass?: number; // baixo, em inversões (ex.: D/F#)
  beats: number;
}

export interface PadSettings {
  timbre: string; // id em TIMBRES
  fadeIn: number; // segundos
  fadeOut: number; // segundos
  volume: number; // 0..1
  brightness: number; // 0..1 (abertura do filtro)
  reverb: number; // 0..1
  shimmer: number; // 0..1
}

const cutoffFor = (b: number) => 250 * Math.pow(2, b * 4.5); // ~250 Hz .. ~5.6 kHz

/** Rampa com curva equal-power a partir do valor atual (interrompível). */
function fade(ctx: AudioContext, param: AudioParam, target: number, seconds: number) {
  const now = ctx.currentTime;
  const from = param.value;
  const dur = Math.max(0.03, seconds);
  param.cancelScheduledValues(now);
  if (Math.abs(target - from) < 1e-4) {
    param.setValueAtTime(target, now);
    return;
  }
  const n = 128;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const shape = target > from ? Math.sin((t * Math.PI) / 2) : 1 - Math.cos((t * Math.PI) / 2);
    curve[i] = from + (target - from) * shape;
  }
  try {
    param.setValueCurveAtTime(curve, now, dur);
  } catch {
    param.setValueAtTime(from, now);
    param.linearRampToValueAtTime(target, now + dur);
  }
}

/**
 * Cadeia comum a todas as vozes:
 * fontes → bodyBus → lowpass (Brilho, com LFO) → highpass → env (fades) → saída.
 */
abstract class Voice {
  protected sources = new Set<AudioScheduledSourceNode>();
  private lfoSrc!: OscillatorNode;
  readonly env: GainNode;
  readonly filter: BiquadFilterNode;
  readonly shimmerGain: GainNode;
  protected readonly hp: BiquadFilterNode;
  protected readonly bodyBus: GainNode;
  protected hardEnd = Infinity; // nada toca depois disso (fim do fade out)
  stopped = false;
  onEnded: () => void = () => {};

  constructor(
    protected ctx: AudioContext,
    dest: AudioNode,
    protected s: PadSettings,
    readonly timbre: Timbre,
    protected samples: SampleSet | null,
    bodyGain: number,
  ) {
    this.env = ctx.createGain();
    this.env.gain.value = 0;
    this.env.connect(dest);

    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = timbre.highpass;
    this.hp.Q.value = 0.5;
    this.hp.connect(this.env);

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = timbre.filterQ;
    this.filter.frequency.value = this.cutoff();
    this.filter.connect(this.hp);

    // LFO lento no filtro: dá "respiração" ao som.
    this.lfoSrc = this.lfo(timbre.filterLfo.rate, timbre.filterLfo.depth, [this.filter.frequency], ctx.currentTime)[0];

    this.bodyBus = ctx.createGain();
    this.bodyBus.gain.value = bodyGain;
    if (timbre.formants) {
      // Coral: formantes da vogal em paralelo, somados antes do filtro principal.
      for (const f of timbre.formants) {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = f.freq;
        bp.Q.value = f.q;
        const g = ctx.createGain();
        g.gain.value = f.gain;
        this.bodyBus.connect(bp).connect(g).connect(this.filter);
      }
    } else {
      this.bodyBus.connect(this.filter);
    }

    this.shimmerGain = ctx.createGain();
    this.shimmerGain.gain.value = s.shimmer * 0.09;
    if (timbre.shimmerCutoff) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = timbre.shimmerCutoff;
      lp.Q.value = 0.5;
      this.shimmerGain.connect(lp).connect(this.hp);
    } else {
      this.shimmerGain.connect(this.hp);
    }
  }

  /** Cutoff vindo do slider "Brilho", ajustado pelo timbre. */
  protected baseCutoff() {
    return cutoffFor(this.s.brightness) * this.timbre.cutoffScale;
  }

  cutoff() {
    return this.baseCutoff();
  }

  /** Envelope de filtro (metais) num parâmetro de cutoff, a partir de `t`. */
  protected filterHit(param: AudioParam, t: number) {
    const fe = this.timbre.filterEnv;
    if (!fe) return;
    const c = this.baseCutoff();
    param.cancelScheduledValues(t);
    param.setValueAtTime(c * fe.start, t);
    param.exponentialRampToValueAtTime(c * fe.peak, t + fe.attack);
    param.setTargetAtTime(c, t + fe.attack, fe.decay / 3);
  }

  level() {
    return this.env.gain.value;
  }

  private track(src: AudioScheduledSourceNode) {
    this.sources.add(src);
    src.addEventListener('ended', () => this.sources.delete(src));
  }

  private lfo(rate: number, depth: number, targets: AudioParam[], when: number): OscillatorNode[] {
    const o = this.ctx.createOscillator();
    o.frequency.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = depth;
    o.connect(g);
    for (const t of targets) g.connect(t);
    o.start(when + Math.random() * 0.5);
    this.track(o);
    return [o];
  }

  /** Amostra mais próxima, transposta para a nota, em loop. */
  protected addSample(note: number, dest: AudioNode, when: number, offset: number): AudioBufferSourceNode {
    const set = this.samples!;
    const i = nearest(set, note);
    const src = this.ctx.createBufferSource();
    src.buffer = set.buffers[i];
    src.playbackRate.value = Math.pow(2, (note - set.notes[i]) / 12);
    if (!this.timbre.oneShot) {
      src.loop = true;
      src.loopStart = set.loopStart;
      src.loopEnd = set.loopEnd[i];
    }
    src.connect(dest);
    src.start(when, offset);
    this.track(src);
    return src;
  }

  /** Osciladores de uma camada para cada nota. Retorna as fontes criadas. */
  protected addLayer(layer: Layer, notes: number[], dest: AudioNode, when: number): AudioScheduledSourceNode[] {
    const created: AudioScheduledSourceNode[] = [];
    const g = this.ctx.createGain();
    g.gain.value = layer.gain / Math.sqrt(layer.voices);
    g.connect(dest);

    // Vibrato de naipe: 3 LFOs com velocidades ligeiramente diferentes,
    // distribuídos entre os osciladores (cada "músico" oscila do seu jeito).
    const vibTargets: AudioParam[][] = layer.vibrato ? [[], [], []] : [];
    const shift = (layer.octave ?? 0) * 1200;
    let n = 0;
    for (const note of notes) {
      const f = midiToHz(note);
      for (let v = 0; v < layer.voices; v++) {
        const o = this.ctx.createOscillator();
        o.type = layer.wave;
        o.frequency.value = f;
        const spreadPos = layer.voices === 1 ? 0 : v / (layer.voices - 1) - 0.5;
        o.detune.value = shift + spreadPos * layer.spread + (Math.random() * 4 - 2);
        o.connect(g);
        const start = layer.fm ? when : when + Math.random() * 0.02; // FM: fase junto com o modulador
        o.start(start);
        this.track(o);
        created.push(o);
        if (layer.fm) {
          const { ratio, index, sustain, time = 1 } = layer.fm;
          const fc = f * Math.pow(2, shift / 1200);
          const m = this.ctx.createOscillator();
          m.frequency.value = fc * ratio;
          const mg = this.ctx.createGain();
          mg.gain.setValueAtTime(fc * index, start);
          if (sustain !== undefined) mg.gain.setTargetAtTime(fc * index * sustain, start, time / 3);
          m.connect(mg).connect(o.frequency);
          m.start(start);
          this.track(m);
          created.push(m);
        }
        if (layer.vibrato) vibTargets[n++ % 3].push(o.detune);
      }
    }
    if (layer.vibrato) {
      const { rate, depth } = layer.vibrato;
      vibTargets.forEach((targets, i) => created.push(...this.lfo(rate * (0.88 + i * 0.12), depth, targets, when)));
    }
    return created;
  }

  fadeIn(seconds: number) {
    const from = this.level();
    if (this.timbre.reverse && from < 0.5) {
      // Crescendo exponencial: começa quase inaudível e acelera no fim.
      const now = this.ctx.currentTime;
      const g = this.env.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(Math.max(from, 0.005), now);
      g.exponentialRampToValueAtTime(1, now + Math.max(1.5, seconds));
    } else fade(this.ctx, this.env.gain, 1, seconds);
    if (this.timbre.swell && from < 0.5) {
      // Ataque de arco: o filtro abre do escuro até o brilho configurado.
      const now = this.ctx.currentTime;
      const c = this.cutoff();
      this.filter.frequency.setValueAtTime(c * 0.3, now);
      this.filter.frequency.exponentialRampToValueAtTime(c, now + Math.max(0.05, seconds));
    }
  }

  /** `force`: refaz o fade mesmo se a saída já estava agendada (parar o loop). */
  fadeOut(seconds: number, force = false) {
    if (this.stopped && !force) return;
    this.stopped = true;
    fade(this.ctx, this.env.gain, 0, seconds);
    this.hardEnd = this.ctx.currentTime + Math.max(0.03, seconds) + 0.1;
    for (const src of this.sources) src.stop(this.hardEnd);
    this.lfoSrc.onended = () => {
      this.env.disconnect();
      this.onEnded();
    };
  }

  /**
   * Entrada direta em `t` (loop): sem fade, só uma rampa curta contra estalos.
   * Timbre reverso: cresce ao longo de quase todo o acorde (`dur` segundos).
   */
  enterAt(t: number, dur = 0, ramp = 0.015) {
    const g = this.env.gain;
    g.cancelScheduledValues(0);
    g.setValueAtTime(0, this.ctx.currentTime);
    if (this.timbre.reverse && dur > 0.2) {
      g.setValueAtTime(0.005, t);
      g.exponentialRampToValueAtTime(1, t + dur * 0.92);
      return;
    }
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(1, t + ramp);
  }

  /** Saída direta em `t` (loop): nada desta voz soa depois de t + ramp. */
  leaveAt(t: number, ramp = 0.02) {
    if (this.stopped) return;
    this.stopped = true;
    const g = this.env.gain;
    g.setValueAtTime(1, t);
    g.linearRampToValueAtTime(0, t + ramp);
    this.hardEnd = t + ramp + 0.05;
    for (const src of this.sources) src.stop(this.hardEnd);
    this.lfoSrc.onended = () => {
      this.env.disconnect();
      this.onEnded();
    };
  }
}

/** Modo Pad: todas as notas do acorde sustentadas. */
class PadVoice extends Voice {
  constructor(
    ctx: AudioContext,
    dest: AudioNode,
    s: PadSettings,
    timbre: Timbre,
    samples: SampleSet | null,
    root: number,
    type: ChordType,
    bass: number | undefined,
    when = ctx.currentTime, // no loop, a voz é criada antes e começa na divisa
  ) {
    let { body, shimmer } = padVoicing(root, type, bass);
    if (samples) {
      // Encaixa na extensão do instrumento e remove notas repetidas.
      body = [...new Set(body.map((n) => fitNote(samples, n)))];
      shimmer = [...new Set(shimmer.map((n) => fitNote(samples, n)))];
    }
    // Piano: o acorde decai, então o ataque recebe um pouco mais de volume.
    super(ctx, dest, s, timbre, samples, (timbre.bodyGain * (timbre.oneShot ? 1.4 : 1)) / Math.sqrt(body.length));
    const now = when;
    if (samples && timbre.oneShot) {
      // Piano: acorde tocado do grave para o agudo, com um leve "rolar" (12 ms
      // entre notas), e cada nota decaindo naturalmente.
      body.forEach((n, k) => this.addSample(n, this.bodyBus, now + k * 0.012, 0));
      const g = ctx.createGain();
      g.gain.value = 2;
      g.connect(this.shimmerGain);
      shimmer.forEach((n, k) => this.addSample(n, g, now + (body.length + k) * 0.012, 0));
    } else if (samples) {
      // Início em pontos diferentes: notas com a mesma amostra não ficam em fase.
      for (const n of body) this.addSample(n, this.bodyBus, now, Math.random() * 0.6);
      const g = ctx.createGain();
      g.gain.value = 4;
      g.connect(this.shimmerGain);
      for (const n of shimmer) this.addSample(n, g, now, Math.random() * 0.6);
    } else {
      for (const layer of timbre.body) this.addLayer(layer, body, this.bodyBus, now);
      for (const layer of timbre.shimmer) this.addLayer(layer, shimmer, this.shimmerGain, now);
      this.filterHit(this.filter.frequency, now);
      if (timbre.decay) {
        // Percussivo (piano elétrico, sinos): o acorde decai sozinho.
        const g = this.bodyBus.gain;
        const v = g.value;
        g.setValueAtTime(v, now);
        g.setTargetAtTime(v * timbre.decay.sustain, now, timbre.decay.time / 3);
      }
    }
  }
}

/** Modos Dedilhado e Arpejo: notas individuais disparadas pelo relógio. */
class PatternVoice extends Voice {
  next = 0; // instante do próximo passo (cada voz tem o próprio relógio)
  private i = 0;
  private prevIdx = -1;
  private genEnd = Infinity;
  private pending: { src: AudioScheduledSourceNode; at: number }[] = [];

  constructor(
    ctx: AudioContext,
    dest: AudioNode,
    s: PadSettings,
    timbre: Timbre,
    samples: SampleSet | null,
    private r: RhythmSettings,
    private root: number,
    private type: ChordType,
    private bass?: number,
  ) {
    // Ganho por nota: no Dedilhado várias notas se sobrepõem; no Arpejo, menos.
    super(
      ctx,
      dest,
      s,
      timbre,
      samples,
      timbre.bodyGain * (r.mode === 'broken' ? 0.6 * (timbre.brokenGain ?? 1) : 0.9 * (timbre.arpGain ?? 1)),
    );
  }

  generatingAt(t: number) {
    return t < this.genEnd && t < this.hardEnd;
  }

  /** Metais: cada nota tem o próprio filtro; o principal fica aberto até o pico. */
  cutoff() {
    const fe = this.timbre.filterEnv;
    return fe ? this.baseCutoff() * fe.peak : this.baseCutoff();
  }

  leaveAt(t: number, ramp = 0.06) {
    this.genEnd = Math.min(this.genEnd, t);
    super.leaveAt(t, ramp);
  }

  fadeOut(seconds: number, force = false) {
    // Parar o loop: o padrão que está soando continua durante o fade out.
    if (force) this.genEnd = Infinity;
    super.fadeOut(seconds, force);
  }

  /** Agenda o próximo passo do padrão no instante `time`. */
  step(time: number, stepDur: number) {
    if (!this.generatingAt(time)) return;
    let events: NoteEvent[];
    let release: number;
    if (this.r.mode === 'broken') {
      events = brokenStep(this.root, this.type, this.i, this.bass);
      release = 0.6;
    } else {
      const pool = arpPool(this.root, this.type, this.r.arpNotes, this.r.arpOctaves, this.bass);
      const idx = arpIndex(pool.length, this.r.arpDir, this.i, this.prevIdx);
      this.prevIdx = idx;
      const stepsPerBeat = Math.max(1, this.r.div / 4);
      events = [{ note: pool[idx], len: 0.9, vel: this.i % stepsPerBeat === 0 ? 1 : 0.8 }];
      release = 0.25;
    }
    for (const e of events) this.playNote(e.note, time, e.len * stepDur, e.vel, release);
    this.i++;
  }

  private playNote(note: number, time: number, dur: number, vel: number, release: number) {
    if (this.samples) note = fitNote(this.samples, note);
    const t = this.timbre;
    const reverse = !this.samples && t.reverse;
    const atk = this.samples ? 0.012 : reverse ? Math.max(0.03, dur * 0.85) : t.noteAttack ?? 0.02;
    if (reverse) release = 0.06; // nota "ao contrário": cresce e é cortada
    const hold = time + Math.max(atk, dur);
    const g = this.ctx.createGain();
    if (reverse) {
      g.gain.setValueAtTime(0.001, time);
      g.gain.exponentialRampToValueAtTime(vel, time + atk);
    } else {
      g.gain.setValueAtTime(0, time);
      g.gain.linearRampToValueAtTime(vel, time + atk);
    }
    if (!this.samples && t.decay) g.gain.setTargetAtTime(vel * t.decay.sustain, time + atk, t.decay.time / 3);
    else g.gain.setValueAtTime(vel, hold);
    g.gain.setTargetAtTime(0, hold, release / 4);
    if (!this.samples && t.filterEnv) {
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = t.filterQ;
      this.filterHit(lp.frequency, time);
      g.connect(lp).connect(this.bodyBus);
    } else g.connect(this.bodyBus);
    const end = Math.min(hold + release * 1.5, this.hardEnd);
    // Amostras começam já no som sustentado (o crescendo lento do arco não
    // caberia numa colcheia); o ataque curto do envelope dá a articulação.
    const srcs = this.samples
      ? [this.addSample(note, g, time, this.samples.attack[nearest(this.samples, note)])]
      : this.timbre.body.flatMap((layer) => this.addLayer(layer, [note], g, time));
    for (const src of srcs) {
      src.stop(Math.max(end, time + 0.01));
      this.pending.push({ src, at: time });
    }
    srcs[0].addEventListener('ended', () => g.disconnect());
    const now = this.ctx.currentTime;
    this.pending = this.pending.filter((p) => p.at > now - 0.5);
  }

  /**
   * Troca de acorde: para de gerar notas, cancela as já agendadas para o
   * futuro e abafa as que estão soando (como levantar o pedal do piano).
   */
  cut() {
    const now = this.ctx.currentTime;
    this.genEnd = now;
    this.fadeOut(0.35); // antes: o fadeOut reagenda o stop de todas as fontes
    for (const p of this.pending) if (p.at > now) p.src.stop(now);
  }
}

function makeImpulse(ctx: AudioContext, seconds = 5, decay = 2.8): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

const LOOKAHEAD = 0.12; // segundos agendados à frente
const TICK_MS = 25;

export class PadEngine {
  private ctx: AudioContext | null = null;
  private bus!: GainNode;
  private master!: GainNode;
  private dry!: GainNode;
  private wet!: GainNode;
  private active = new Map<string, Voice>();
  private patterns = new Set<PatternVoice>(); // inclui as que estão em fade out
  private timer: ReturnType<typeof setInterval> | null = null;
  private loop: {
    steps: LoopStep[];
    i: number; // passo que será agendado a seguir
    next: number; // instante da próxima troca de acorde
    bus: GainNode; // fade in/out do loop inteiro
    voices: Voice[]; // a que soa e a já agendada
    onStep: (index: number) => void;
  } | null = null;

  constructor(
    private s: PadSettings,
    private r: RhythmSettings, // lido a cada passo: mudanças valem na hora
  ) {}

  /** Chamado quando o contexto de áudio precisou ser recriado (o que tocava parou). */
  onReset: () => void = () => {};

  /**
   * Garante o áudio rodando. Precisa ser chamado dentro de um gesto do usuário
   * (exigência do iOS). Depois de muito tempo inativo, o navegador pode deixar
   * o contexto fechado ou "interrompido" e a retomada nunca terminar; nesse
   * caso o contexto é recriado (as amostras já decodificadas são reaproveitadas).
   */
  async unlock() {
    if (this.ctx?.state === 'closed') this.reset();
    if (!this.ctx) this.init();
    if (await this.tryResume(this.ctx!)) return;
    this.reset();
    this.init();
    await this.tryResume(this.ctx!);
  }

  private async tryResume(ctx: AudioContext): Promise<boolean> {
    if (ctx.state === 'running') return true;
    try {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1500))]);
    } catch {
      /* resume rejeitado: tratado como falha */
    }
    return (ctx.state as string) === 'running';
  }

  /** Descarta o contexto atual e tudo que dependia dele. */
  private reset() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.active.clear();
    this.patterns.clear();
    this.loop = null;
    const old = this.ctx;
    this.ctx = null;
    if (old && old.state !== 'closed') old.close().catch(() => {});
    this.onReset();
  }

  private init() {
    // iOS 17+: toca mesmo com a chave de silencioso ligada.
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    if (nav.audioSession) nav.audioSession.type = 'playback';

    const ctx = new AudioContext({ latencyHint: 'playback' });
    this.ctx = ctx;

    this.bus = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(ctx);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    comp.attack.value = 0.05;
    comp.release.value = 0.4;

    this.master = ctx.createGain();

    this.bus.connect(this.dry).connect(comp);
    this.bus.connect(reverb).connect(this.wet).connect(comp);
    comp.connect(this.master).connect(ctx.destination);

    this.applyMix();
  }

  private applyMix() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.s.volume, t, 0.05);
    this.dry.gain.setTargetAtTime(1 - this.s.reverb * 0.6, t, 0.05);
    this.wet.gain.setTargetAtTime(this.s.reverb * 1.2, t, 0.05);
  }

  // ---------- Amostras ----------
  private samples: Promise<SampleSet> | null = null;
  private loadedSamples: SampleSet | null = null;
  private samplesName: string | null = null;

  /** Baixa (ou lê do aparelho) e decodifica as amostras do timbre atual, uma vez. */
  ensureSamples(onProgress?: (done: number, total: number) => void): Promise<SampleSet> {
    // Decodificar não exige gesto do usuário: o contexto pode nascer suspenso.
    if (this.ctx?.state === 'closed') this.reset();
    if (!this.ctx) this.init();
    const ctx = this.ctx!;
    const name = timbreById(this.s.timbre).sampleSet;
    if (!name) throw new Error('Timbre sem amostras');
    if (this.samplesName !== name) this.releaseSamples();
    if (!this.samples) {
      this.samplesName = name;
      this.samples = loadSampleSet(ctx, name, onProgress, !timbreById(this.s.timbre).oneShot).then(
        (set) => {
          if (this.samplesName === name) this.loadedSamples = set;
          return set;
        },
        (err) => {
          this.releaseSamples();
          throw err;
        },
      );
    }
    return this.samples;
  }

  /** Vozes que ainda estão em fade out mantêm seus buffers até terminar. */
  private releaseSamples() {
    this.samples = null;
    this.loadedSamples = null;
    this.samplesName = null;
  }

  get samplesReady() {
    const name = timbreById(this.s.timbre).sampleSet;
    return !!name && this.samplesName === name && this.loadedSamples !== null;
  }

  get samplesBytes() {
    return this.loadedSamples?.bytes ?? 0;
  }

  update(s: Partial<PadSettings>) {
    Object.assign(this.s, s);
    if ('timbre' in s && timbreById(this.s.timbre).sampleSet !== this.samplesName) this.releaseSamples();
    if (!this.ctx) return;
    this.applyMix();
    const t = this.ctx.currentTime;
    for (const v of this.active.values()) {
      if ('brightness' in s) {
        v.filter.frequency.cancelScheduledValues(t);
        v.filter.frequency.setTargetAtTime(v.cutoff(), t, 0.1);
      }
      if ('shimmer' in s) v.shimmerGain.gain.setTargetAtTime(this.s.shimmer * 0.09, t, 0.1);
    }
  }

  // ---------- Tocar ----------

  /**
   * Toca o acorde. No modo Pad faz crossfade com o que estiver soando; nos
   * modos rítmicos o padrão novo começa no instante do toque e o anterior é
   * abafado. `force` recria a voz mesmo se o acorde já estiver tocando
   * (troca de timbre ou de modo).
   */
  play(key: string, root: number, type: ChordType, bass?: number, force = false) {
    const ctx = this.ctx;
    if (!ctx || (this.active.has(key) && !force)) return;
    const timbre = timbreById(this.s.timbre);
    if (timbre.sampleSet && !this.samplesReady) return; // main aguarda ensureSamples()
    const samples = timbre.sampleSet ? this.loadedSamples : null;

    if (this.r.mode === 'pad') {
      for (const v of this.active.values()) v.fadeOut(this.s.fadeOut);
      this.active.clear();
      const v = new PadVoice(ctx, this.bus, this.s, timbre, samples, root, type, bass);
      this.active.set(key, v);
      v.fadeIn(isStruck(timbre) ? 0.01 : this.s.fadeIn); // piano: o ataque é a própria nota
      return;
    }

    // Continua do volume em que o padrão anterior estava (sem "buraco").
    let level = 0;
    for (const v of this.active.values()) {
      if (v instanceof PatternVoice) {
        level = Math.max(level, v.level());
        v.cut();
      } else v.fadeOut(this.s.fadeOut);
    }
    for (const p of this.patterns) {
      if (p.generatingAt(ctx.currentTime)) {
        level = Math.max(level, p.level());
        p.cut();
      }
    }
    this.active.clear();

    const v = new PatternVoice(ctx, this.bus, this.s, timbre, samples, this.r, root, type, bass);
    v.env.gain.value = level;
    v.onEnded = () => this.patterns.delete(v);
    this.patterns.add(v);
    this.active.set(key, v);
    v.fadeIn(this.s.fadeIn);
    v.next = ctx.currentTime + 0.02; // o compasso começa no toque
    this.ensureTimer();
    this.tick();
  }

  private ensureTimer() {
    if (this.timer === null) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private tick() {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const L = this.loop;
    if (L) {
      if (L.next < now) L.next = now + 0.01; // após a aba ficar em segundo plano
      while (L.next < now + LOOKAHEAD) this.scheduleLoopStep(L, L.next);
    }
    const dur = stepSeconds(this.r);
    for (const p of this.patterns) {
      if (p.next < now - 0.05) p.next = now + 0.01;
      while (p.next < now + LOOKAHEAD && p.generatingAt(p.next)) {
        p.step(p.next, dur);
        p.next += dur;
      }
    }
    if (!L && ![...this.patterns].some((p) => p.generatingAt(now))) {
      clearInterval(this.timer!);
      this.timer = null;
    }
  }

  // ---------- Loop (aba Sequência) ----------

  get looping() {
    return this.loop !== null;
  }

  /**
   * Toca a sequência em ciclo. As trocas de acorde são agendadas no relógio
   * de áudio, exatamente na duração de cada passo, e são diretas (sem fade).
   * O fade in/out configurado vale só para iniciar e parar o loop.
   */
  startLoop(steps: LoopStep[], onStep: (index: number) => void) {
    const ctx = this.ctx;
    if (!ctx || !steps.length) return;
    this.stopLoop();
    this.stopAll();
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.connect(this.bus);
    fade(ctx, bus.gain, 1, isStruck(timbreById(this.s.timbre)) ? 0.01 : this.s.fadeIn);
    this.loop = { steps, i: 0, next: ctx.currentTime + 0.05, bus, voices: [], onStep };
    this.ensureTimer();
    this.tick();
  }

  /** Atualiza os passos com o loop tocando (vale a partir da próxima troca). */
  setLoopSteps(steps: LoopStep[]) {
    if (this.loop && steps.length) this.loop.steps = steps;
    else if (this.loop) this.stopLoop();
  }

  stopLoop() {
    const L = this.loop;
    if (!L || !this.ctx) return;
    this.loop = null;
    fade(this.ctx, L.bus.gain, 0, this.s.fadeOut);
    for (const v of L.voices) v.fadeOut(this.s.fadeOut + 0.05, true);
    setTimeout(() => L.bus.disconnect(), (this.s.fadeOut + 0.5) * 1000);
  }

  private scheduleLoopStep(L: NonNullable<PadEngine['loop']>, t: number) {
    const ctx = this.ctx!;
    const index = L.i % L.steps.length;
    const step = L.steps[index];
    const timbre = timbreById(this.s.timbre);
    const prev = L.voices[L.voices.length - 1];
    // Timbre gravado ainda carregando (troca de timbre no meio do loop): pula este acorde.
    if (!timbre.sampleSet || this.samplesReady) {
      const samples = timbre.sampleSet ? this.loadedSamples : null;
      let v: Voice;
      if (this.r.mode === 'pad') {
        v = new PadVoice(ctx, L.bus, this.s, timbre, samples, step.root, step.type, step.bass, t);
      } else {
        const pv = new PatternVoice(ctx, L.bus, this.s, timbre, samples, this.r, step.root, step.type, step.bass);
        pv.next = t; // o padrão recomeça junto com o acorde
        pv.onEnded = () => this.patterns.delete(pv);
        this.patterns.add(pv);
        v = pv;
      }
      v.enterAt(t, this.r.mode === 'pad' ? (step.beats * 60) / this.r.bpm : 0);
      L.voices.push(v);
    }
    prev?.leaveAt(t);
    L.voices = L.voices.slice(-2);
    const delay = Math.max(0, (t - ctx.currentTime) * 1000);
    setTimeout(() => this.loop === L && L.onStep(index), delay); // destaque na tela, na hora certa
    L.next = t + (step.beats * 60) / this.r.bpm;
    L.i++;
  }

  stop(key: string) {
    const v = this.active.get(key);
    if (!v) return;
    this.active.delete(key);
    v.fadeOut(this.s.fadeOut); // nos modos rítmicos o padrão segue tocando durante o fade
  }

  stopAll() {
    for (const k of [...this.active.keys()]) this.stop(k);
  }
}
