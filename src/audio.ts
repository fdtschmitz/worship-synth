import { midiToHz, padVoicing, type ChordType } from './chords';
import { fitNote, loadSampleSet, nearest, type SampleSet } from './samples';
import { arpIndex, arpPool, brokenStep, stepSeconds, type NoteEvent, type RhythmSettings } from './sequencer';
import { timbreById, type Layer, type Timbre } from './timbres';

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
    this.bodyBus.connect(this.filter);

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

  cutoff() {
    return cutoffFor(this.s.brightness) * this.timbre.cutoffScale;
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
        o.start(when + Math.random() * 0.02);
        this.track(o);
        created.push(o);
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
    fade(this.ctx, this.env.gain, 1, seconds);
    if (this.timbre.swell && from < 0.5) {
      // Ataque de arco: o filtro abre do escuro até o brilho configurado.
      const now = this.ctx.currentTime;
      const c = this.cutoff();
      this.filter.frequency.setValueAtTime(c * 0.3, now);
      this.filter.frequency.exponentialRampToValueAtTime(c, now + Math.max(0.05, seconds));
    }
  }

  fadeOut(seconds: number) {
    if (this.stopped) return;
    this.stopped = true;
    fade(this.ctx, this.env.gain, 0, seconds);
    this.hardEnd = this.ctx.currentTime + Math.max(0.03, seconds) + 0.1;
    for (const src of this.sources) src.stop(this.hardEnd);
    this.lfoSrc.onended = () => {
      this.env.disconnect();
      this.onEnded();
    };
  }
}

/** Modo Pad: todas as notas do acorde sustentadas. */
class PadVoice extends Voice {
  constructor(ctx: AudioContext, dest: AudioNode, s: PadSettings, timbre: Timbre, samples: SampleSet | null, root: number, type: ChordType) {
    let { body, shimmer } = padVoicing(root, type);
    if (samples) {
      // Encaixa na extensão do instrumento e remove notas repetidas.
      body = [...new Set(body.map((n) => fitNote(samples, n)))];
      shimmer = [...new Set(shimmer.map((n) => fitNote(samples, n)))];
    }
    // Piano: o acorde decai, então o ataque recebe um pouco mais de volume.
    super(ctx, dest, s, timbre, samples, (timbre.bodyGain * (timbre.oneShot ? 1.4 : 1)) / Math.sqrt(body.length));
    const now = ctx.currentTime;
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
    }
  }
}

/** Modos Dedilhado e Arpejo: notas individuais disparadas pelo relógio. */
class PatternVoice extends Voice {
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

  /** Agenda o próximo passo do padrão no instante `time`. */
  step(time: number, stepDur: number) {
    if (!this.generatingAt(time)) return;
    const beat = 60 / this.r.bpm;
    let events: NoteEvent[];
    let release: number;
    if (this.r.mode === 'broken') {
      events = brokenStep(this.root, this.type, this.i);
      release = 0.6;
    } else {
      const pool = arpPool(this.root, this.type, this.r.arpNotes, this.r.arpOctaves);
      const idx = arpIndex(pool.length, this.r.arpDir, this.i, this.prevIdx);
      this.prevIdx = idx;
      const stepsPerBeat = this.r.arpDiv / 4;
      events = [{ note: pool[idx], beats: (0.9 * stepDur) / beat, vel: this.i % stepsPerBeat === 0 ? 1 : 0.8 }];
      release = 0.25;
    }
    for (const e of events) this.playNote(e.note, time, e.beats * beat, e.vel, release);
    this.i++;
  }

  private playNote(note: number, time: number, dur: number, vel: number, release: number) {
    if (this.samples) note = fitNote(this.samples, note);
    const atk = this.samples ? 0.012 : this.timbre.noteAttack ?? 0.02;
    const hold = time + Math.max(atk, dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(vel, time + atk);
    g.gain.setValueAtTime(vel, hold);
    g.gain.setTargetAtTime(0, hold, release / 4);
    g.connect(this.bodyBus);
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
  private nextTime = 0;

  constructor(
    private s: PadSettings,
    private r: RhythmSettings, // lido a cada passo: mudanças valem na hora
  ) {}

  /** Precisa ser chamado dentro de um gesto do usuário (exigência do iOS). */
  async unlock() {
    if (!this.ctx) this.init();
    const ctx = this.ctx!;
    if (ctx.state !== 'running') await ctx.resume();
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

  /** Baixa e decodifica as amostras do timbre atual (uma vez). Exige unlock() antes. */
  ensureSamples(onProgress?: (done: number, total: number) => void): Promise<SampleSet> {
    if (!this.ctx) throw new Error('AudioContext não iniciado');
    const name = timbreById(this.s.timbre).sampleSet;
    if (!name) throw new Error('Timbre sem amostras');
    if (this.samplesName !== name) this.releaseSamples();
    if (!this.samples) {
      this.samplesName = name;
      this.samples = loadSampleSet(this.ctx, name, onProgress, !timbreById(this.s.timbre).oneShot).then(
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
  play(key: string, root: number, type: ChordType, force = false) {
    const ctx = this.ctx;
    if (!ctx || (this.active.has(key) && !force)) return;
    const timbre = timbreById(this.s.timbre);
    if (timbre.sampleSet && !this.samplesReady) return; // main aguarda ensureSamples()
    const samples = timbre.sampleSet ? this.loadedSamples : null;

    if (this.r.mode === 'pad') {
      for (const v of this.active.values()) v.fadeOut(this.s.fadeOut);
      this.active.clear();
      const v = new PadVoice(ctx, this.bus, this.s, timbre, samples, root, type);
      this.active.set(key, v);
      v.fadeIn(timbre.oneShot ? 0.01 : this.s.fadeIn); // piano: o ataque é a própria nota
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

    const v = new PatternVoice(ctx, this.bus, this.s, timbre, samples, this.r, root, type);
    v.env.gain.value = level;
    v.onEnded = () => this.patterns.delete(v);
    this.patterns.add(v);
    this.active.set(key, v);
    v.fadeIn(this.s.fadeIn);
    // O compasso começa no toque.
    this.nextTime = ctx.currentTime + 0.02;
    if (this.timer === null) this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private tick() {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    if (this.nextTime < now) this.nextTime = now + 0.01; // após a aba ficar em segundo plano
    while (this.nextTime < now + LOOKAHEAD) {
      const dur = stepSeconds(this.r);
      for (const p of this.patterns) p.step(this.nextTime, dur);
      this.nextTime += dur;
    }
    if (![...this.patterns].some((p) => p.generatingAt(now))) {
      clearInterval(this.timer!);
      this.timer = null;
    }
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
