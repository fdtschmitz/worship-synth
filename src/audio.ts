import { midiToHz } from './chords';
import { loadStrings, nearest, type SampleSet } from './samples';
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

class Voice {
  private oscs: AudioScheduledSourceNode[] = [];
  readonly env: GainNode;
  readonly filter: BiquadFilterNode;
  readonly shimmerGain: GainNode;
  private stopped = false;

  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
    body: number[],
    shimmer: number[],
    private s: PadSettings,
    readonly timbre: Timbre,
    samples: SampleSet | null,
  ) {
    this.env = ctx.createGain();
    this.env.gain.value = 0;
    this.env.connect(dest);

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = timbre.highpass;
    hp.Q.value = 0.5;
    hp.connect(this.env);

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = timbre.filterQ;
    this.filter.frequency.value = this.cutoff();
    this.filter.connect(hp);

    // LFO lento no filtro: dá "respiração" ao pad.
    this.lfo(timbre.filterLfo.rate, timbre.filterLfo.depth, [this.filter.frequency]);

    const bodyBus = ctx.createGain();
    bodyBus.gain.value = timbre.bodyGain / Math.sqrt(body.length);
    bodyBus.connect(this.filter);
    if (samples) for (const note of body) this.addSample(samples, note, bodyBus);
    else for (const layer of timbre.body) this.addLayer(layer, body, bodyBus);

    this.shimmerGain = ctx.createGain();
    this.shimmerGain.gain.value = s.shimmer * 0.09;
    if (timbre.shimmerCutoff) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = timbre.shimmerCutoff;
      lp.Q.value = 0.5;
      this.shimmerGain.connect(lp).connect(hp);
    } else {
      this.shimmerGain.connect(hp);
    }
    if (samples) for (const note of shimmer) this.addSample(samples, note, this.shimmerGain, 4);
    else for (const layer of timbre.shimmer) this.addLayer(layer, shimmer, this.shimmerGain);
  }

  /** Toca a amostra mais próxima, transposta para a nota, em loop. */
  private addSample(set: SampleSet, note: number, dest: AudioNode, gain = 1) {
    const i = nearest(set, note);
    const src = this.ctx.createBufferSource();
    src.buffer = set.buffers[i];
    src.playbackRate.value = Math.pow(2, (note - set.notes[i]) / 12);
    src.loop = true;
    src.loopStart = set.loopStart;
    src.loopEnd = set.loopEnd[i];
    let out: AudioNode = src;
    if (gain !== 1) {
      const g = this.ctx.createGain();
      g.gain.value = gain;
      out = src.connect(g);
    }
    out.connect(dest);
    // Início em pontos diferentes: notas que usam a mesma amostra não ficam em fase.
    src.start(this.ctx.currentTime, Math.random() * 0.6);
    this.oscs.push(src);
  }

  cutoff() {
    return cutoffFor(this.s.brightness) * this.timbre.cutoffScale;
  }

  private lfo(rate: number, depth: number, targets: AudioParam[]) {
    const o = this.ctx.createOscillator();
    o.frequency.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = depth;
    o.connect(g);
    for (const t of targets) g.connect(t);
    o.start(this.ctx.currentTime + Math.random() * 0.5);
    this.oscs.push(o);
  }

  private addLayer(layer: Layer, notes: number[], dest: AudioNode) {
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
        o.start(this.ctx.currentTime + Math.random() * 0.02);
        this.oscs.push(o);
        if (layer.vibrato) vibTargets[n++ % 3].push(o.detune);
      }
    }
    if (layer.vibrato) {
      const { rate, depth } = layer.vibrato;
      vibTargets.forEach((targets, i) => this.lfo(rate * (0.88 + i * 0.12), depth, targets));
    }
  }

  fadeIn(seconds: number) {
    fade(this.ctx, this.env.gain, 1, seconds);
    if (this.timbre.swell) {
      // Ataque de arco: o filtro abre do escuro até o brilho configurado.
      const now = this.ctx.currentTime;
      const c = this.cutoff();
      this.filter.frequency.setValueAtTime(c * 0.3, now);
      this.filter.frequency.exponentialRampToValueAtTime(c, now + Math.max(0.05, seconds));
    }
  }

  fadeOut(seconds: number, onDone: () => void) {
    if (this.stopped) return;
    this.stopped = true;
    fade(this.ctx, this.env.gain, 0, seconds);
    const end = this.ctx.currentTime + Math.max(0.03, seconds) + 0.1;
    for (const o of this.oscs) o.stop(end);
    this.oscs[0].onended = () => {
      this.env.disconnect();
      onDone();
    };
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

export class PadEngine {
  private ctx: AudioContext | null = null;
  private bus!: GainNode;
  private master!: GainNode;
  private dry!: GainNode;
  private wet!: GainNode;
  private active = new Map<string, Voice>();

  constructor(private s: PadSettings) {}

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

  private samples: Promise<SampleSet> | null = null;
  private loadedSamples: SampleSet | null = null;

  /** Baixa e decodifica as amostras (uma vez). Exige unlock() antes. */
  ensureSamples(onProgress?: (done: number, total: number) => void): Promise<SampleSet> {
    if (!this.ctx) throw new Error('AudioContext não iniciado');
    if (!this.samples) {
      this.samples = loadStrings(this.ctx, onProgress).then(
        (set) => (this.loadedSamples = set),
        (err) => {
          this.samples = null;
          throw err;
        },
      );
    }
    return this.samples;
  }

  get samplesReady() {
    return this.loadedSamples !== null;
  }

  get samplesBytes() {
    return this.loadedSamples?.bytes ?? 0;
  }

  update(s: Partial<PadSettings>) {
    Object.assign(this.s, s);
    // Saiu do timbre com amostras: libera a memória (vozes que ainda estão
    // em fade out mantêm seus buffers até terminar).
    if ('timbre' in s && !timbreById(this.s.timbre).samples) {
      this.samples = null;
      this.loadedSamples = null;
    }
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

  start(key: string, body: number[], shimmer: number[]) {
    if (!this.ctx || this.active.has(key)) return;
    const timbre = timbreById(this.s.timbre);
    if (timbre.samples && !this.loadedSamples) return; // main aguarda ensureSamples()
    const v = new Voice(this.ctx, this.bus, body, shimmer, this.s, timbre, timbre.samples ? this.loadedSamples : null);
    this.active.set(key, v);
    v.fadeIn(this.s.fadeIn);
  }

  stop(key: string) {
    const v = this.active.get(key);
    if (!v) return;
    this.active.delete(key);
    v.fadeOut(this.s.fadeOut, () => {});
  }

  stopAll() {
    for (const k of [...this.active.keys()]) this.stop(k);
  }
}
