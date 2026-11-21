/**
 * Amostras de naipe de cordas (VSCO 2 Community Edition, domínio público / CC0).
 * Os arquivos ficam em public/samples/strings e são carregados sob demanda.
 */
export interface SampleSet {
  notes: number[]; // nota MIDI de cada buffer
  buffers: AudioBuffer[];
  loopStart: number; // segundos
  loopEnd: number[]; // segundos, por buffer
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

export async function loadStrings(ctx: BaseAudioContext, onProgress?: (done: number, total: number) => void): Promise<SampleSet> {
  const base = `${import.meta.env.BASE_URL}samples/strings/`;
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
  return {
    notes: list.map((s) => s.note),
    buffers,
    loopStart: LOOP_START,
    loopEnd: buffers.map(bakeLoop),
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
