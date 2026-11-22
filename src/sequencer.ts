import { CHORDS, padVoicing, type ChordType } from './chords';

export type PlayMode = 'pad' | 'broken' | 'arp';
export type ArpDir = 'up' | 'down' | 'updown' | 'random';

export interface RhythmSettings {
  mode: PlayMode;
  bpm: number;
  arpNotes: number; // 1 = tônica, 2 = +3ª, 3 = +5ª, 4 = +7ª, 5 = +9ª, 6 = +11ª/13ª
  arpOctaves: number;
  arpDir: ArpDir;
  arpDiv: 4 | 8 | 16; // figura de cada nota: semínima, colcheia, semicolcheia
}

export interface NoteEvent {
  note: number;
  beats: number; // duração, em tempos
  vel: number; // 0..1
}

/** Duração de um passo do sequenciador, em segundos. */
export function stepSeconds(r: RhythmSettings): number {
  const beat = 60 / r.bpm;
  return r.mode === 'broken' ? beat / 2 : (beat * 4) / r.arpDiv;
}

// ---------- Dedilhado (broken chord) ----------

/**
 * Compasso 4/4 em colcheias (8 passos): baixo, quinta, oitava, terça acima,
 * nota mais aguda, e volta descendo. O baixo soa o compasso inteiro e as
 * outras notas se sobrepõem, como um piano com pedal.
 */
export function brokenStep(root: number, type: ChordType, i: number): NoteEvent[] {
  const step = i % 8;
  const bass = padVoicing(root, type).body[0];
  const iv = CHORDS[type].intervals;
  const base = bass + 12;
  const fifth = iv.includes(7) ? 7 : iv.includes(6) ? 6 : iv[iv.length - 1]; // diminutos: 5ª diminuta
  const third = iv[1] < 7 ? iv[1] : fifth; // em "5" (sem terça) usa a quinta
  const ext = iv.find((x) => x > 7); // 7ª ou 9ª, se houver
  const F = base + fifth;
  const O = base + 12;
  const T = base + 12 + third;
  // Ponto mais agudo: a extensão (7ª/9ª) logo acima da terça; sem extensão, a quinta.
  const X = ext !== undefined ? T + ((((bass + ext) % 12) - (T % 12) + 12) % 12 || 12) : base + 12 + fifth;
  const pattern = [bass, F, O, T, X, T, O, F];
  const vel = step === 0 ? 1 : step % 2 === 0 ? 0.85 : 0.68;
  const events: NoteEvent[] = [{ note: pattern[step], beats: step === 0 ? 4 : 1.5, vel }];
  return events;
}

// ---------- Arpejador ----------

/**
 * Notas do acorde empilhadas em terças, na ordem em que entram conforme o
 * "tamanho da escala". Em acordes sus a "terça" é a 2ª ou a 4ª.
 */
const STACKS: Record<ChordType, number[]> = {
  maj: [0, 4, 7, 11, 2, 9],
  min: [0, 3, 7, 10, 2, 5],
  sus2: [0, 2, 7, 11, 9, 5],
  sus4: [0, 5, 7, 10, 2, 9],
  add9: [0, 4, 7, 2, 11, 9],
  maj7: [0, 4, 7, 11, 2, 9],
  m7: [0, 3, 7, 10, 2, 5],
  '5': [0, 7, 2, 9, 5, 11],
  // Diminutos: tensões da escala diminuta (tom-semitom): 9ª e 11ª
  dim: [0, 3, 6, 9, 2, 5],
  dim7: [0, 3, 6, 9, 2, 5],
};

export const ARP_NOTE_LABELS = ['Tônica', '+ 3ª', '+ 5ª', '+ 7ª', '+ 9ª', '+ 11ª/13ª'];

export function arpPool(root: number, type: ChordType, size: number, octaves: number): number[] {
  let base = 60 + root; // C4
  if (root >= 6) base -= 12;
  const pcs = [...new Set(STACKS[type].slice(0, size).map((x) => x % 12))].sort((a, b) => a - b);
  const pool: number[] = [];
  for (let o = 0; o < octaves; o++) for (const pc of pcs) pool.push(base + pc + 12 * o);
  return pool;
}

/** Índice da nota no passo i, conforme a direção. */
export function arpIndex(len: number, dir: ArpDir, i: number, prev: number): number {
  if (len <= 1) return 0;
  switch (dir) {
    case 'up':
      return i % len;
    case 'down':
      return len - 1 - (i % len);
    case 'updown': {
      const period = 2 * len - 2;
      const p = i % period;
      return p < len ? p : period - p;
    }
    case 'random': {
      let n = Math.floor(Math.random() * (len - 1));
      if (n >= prev) n++; // nunca repete a nota anterior
      return n;
    }
  }
}
