/**
 * Amostras gravadas (VSCO 2 Community Edition, domínio público / CC0).
 * Cada conjunto fica em public/samples/<nome> e é carregado sob demanda.
 */
export interface SampleSet {
  notes: number[]; // nota MIDI de cada buffer
  buffers: AudioBuffer[];
  loopStart: number; // segundos
  loopEnd: number[]; // segundos, por buffer
  attack: number[]; // segundos até o som atingir o nível sustentado (pula o crescendo do arco)
  bytes: number; // memória ocupada pelo áudio decodificado
}

const LOOP_START = 1.5; // depois do ataque do arco
const TAIL = 0.35; // ignora o fade no fim do arquivo
const XFADE = 1.0; // crossfade do loop

/**
 * Aplica um crossfade equal-power no fim do trecho de loop, de modo que
 * loopEnd emende sem clique em loopStart. Feito após decodificar (e não no
 * arquivo) porque o MP3 desloca alguns milissegundos o início do áudio.
 */
function bakeLoop(buf: AudioBuffer): number {
  const sr = buf.sampleRate;
  const l1 = Math.floor(LOOP_START * sr);
  const l2 = buf.length - Math.floor(TAIL * sr);
  const x = Math.min(Math.floor(XFADE * sr), l1, l2 - l1);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < x; i++) {
      const t = i / x;
      const p = l2 - x + i;
      d[p] = d[p] * Math.cos((t * Math.PI) / 2) + d[l1 - x + i] * Math.sin((t * Math.PI) / 2);
    }
  }
  return l2 / sr;
}

/**
 * Tempo até a amostra chegar perto (−6 dB) do nível sustentado. Gravações de
 * naipe começam com um crescendo lento; nos modos rítmicos a nota começa daí.
 */
function measureAttack(buf: AudioBuffer, loopEnd: number): number {
  const sr = buf.sampleRate;
  const d = buf.getChannelData(0);
  const rms = (a: number, b: number) => {
    let s = 0;
    for (let i = a; i < b; i++) s += d[i] * d[i];
    return Math.sqrt(s / Math.max(1, b - a));
  };
  const sustain = rms(Math.floor(LOOP_START * sr), Math.floor(loopEnd * sr));
  const w = Math.floor(0.01 * sr);
  for (let i = 0; i + w < d.length; i += w) {
    if (rms(i, i + w) >= sustain * 0.5) return Math.max(0, i / sr - 0.02);
  }
  return 0;
}

export async function loadSampleSet(
  ctx: BaseAudioContext,
  name: string,
  onProgress?: (done: number, total: number) => void,
  loop = true, // false: notas que decaem sozinhas (piano), tocadas até o fim
): Promise<SampleSet> {
  const base = `${import.meta.env.BASE_URL}samples/${name}/`;
  const list: { file: string; note: number }[] = await (await fetch(base + 'manifest.json')).json();
  let done = 0;
  const buffers = await Promise.all(
    list.map(async ({ file }) => {
      const res = await fetch(base + file);
      if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
      const buf = await ctx.decodeAudioData(await res.arrayBuffer());
      onProgress?.(++done, list.length);
      return buf;
    }),
  );
  const loopEnd = loop ? buffers.map(bakeLoop) : buffers.map((b) => b.duration);
  return {
    notes: list.map((s) => s.note),
    buffers,
    loopStart: LOOP_START,
    loopEnd,
    attack: loop ? buffers.map((b, i) => Math.min(measureAttack(b, loopEnd[i]), LOOP_START - 0.1)) : buffers.map(() => 0),
    bytes: buffers.reduce((n, b) => n + b.length * b.numberOfChannels * 4, 0),
  };
}

/** Índice da amostra mais próxima da nota pedida. */
export function nearest(set: SampleSet, note: number): number {
  let best = 0;
  for (let i = 1; i < set.notes.length; i++) {
    if (Math.abs(set.notes[i] - note) < Math.abs(set.notes[best] - note)) best = i;
  }
  return best;
}

/**
 * Leva a nota para a região coberta pelas amostras, deslocando por oitavas
 * (ex.: graves na flauta, a região sem gravação da trompa). Transpor uma
 * amostra muito longe soa artificial; mudar de oitava soa natural.
 */
export function fitNote(set: SampleSet, note: number): number {
  const dist = (n: number) => Math.abs(set.notes[nearest(set, n)] - n);
  if (dist(note) <= 3) return note;
  let best = note;
  for (const shift of [-12, 12, -24, 24, -36, 36]) {
    if (dist(note + shift) <= 3) return note + shift;
    if (dist(note + shift) < dist(best)) best = note + shift;
  }
  return best;
}
