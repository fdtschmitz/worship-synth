import { midiToHz } from './chords';

export interface PadSettings {
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
  private oscs: OscillatorNode[] = [];
  readonly env: GainNode;
  readonly filter: BiquadFilterNode;
  readonly shimmerGain: GainNode;
  private stopped = false;

  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
    body: number[],
    shimmer: number[],
    s: PadSettings,
  ) {
    this.env = ctx.createGain();
    this.env.gain.value = 0;
    this.env.connect(dest);

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 0.6;
    this.filter.frequency.value = cutoffFor(s.brightness);
    this.filter.connect(this.env);

    // LFO lento no filtro: dá "respiração" ao pad.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.11;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 180;
    lfo.connect(lfoDepth).connect(this.filter.frequency);
    lfo.start();
    this.oscs.push(lfo);

    const bodyBus = ctx.createGain();
    bodyBus.gain.value = 0.32 / Math.sqrt(body.length);
    bodyBus.connect(this.filter);

    for (const note of body) {
      const f = midiToHz(note);
      // Duas serras desafinadas (coro) + um triângulo para corpo.
      for (const [type, detune, g] of [
        ['sawtooth', -9, 0.5],
        ['sawtooth', 9, 0.5],
        ['triangle', 0, 0.7],
      ] as const) {
        this.addOsc(type, f, detune + (Math.random() * 4 - 2), g, bodyBus);
      }
    }

    this.shimmerGain = ctx.createGain();
    this.shimmerGain.gain.value = s.shimmer * 0.09;
    this.shimmerGain.connect(this.env); // sem filtro: brilho no topo
    for (const note of shimmer) {
      this.addOsc('sine', midiToHz(note), 0, 0.5, this.shimmerGain);
      this.addOsc('sine', midiToHz(note), 6, 0.3, this.shimmerGain);
    }
  }

  private addOsc(type: OscillatorType, freq: number, detune: number, gain: number, dest: AudioNode) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    o.connect(g).connect(dest);
    o.start(this.ctx.currentTime + Math.random() * 0.02);
    this.oscs.push(o);
  }

  fadeIn(seconds: number) {
    fade(this.ctx, this.env.gain, 1, seconds);
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

  update(s: Partial<PadSettings>) {
    Object.assign(this.s, s);
    if (!this.ctx) return;
    this.applyMix();
    const t = this.ctx.currentTime;
    for (const v of this.active.values()) {
      v.filter.frequency.setTargetAtTime(cutoffFor(this.s.brightness), t, 0.1);
      v.shimmerGain.gain.setTargetAtTime(this.s.shimmer * 0.09, t, 0.1);
    }
  }

  start(key: string, body: number[], shimmer: number[]) {
    if (!this.ctx || this.active.has(key)) return;
    const v = new Voice(this.ctx, this.bus, body, shimmer, this.s);
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
