export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export type ChordType = 'maj' | 'min' | 'sus2' | 'sus4' | 'add9' | 'maj7' | 'm7' | '5' | 'dim' | 'dim7';

export interface ChordDef {
  label: string; // sufixo exibido no botão
  name: string; // nome por extenso
  intervals: number[];
}

export const CHORDS: Record<ChordType, ChordDef> = {
  maj: { label: '', name: 'Maior', intervals: [0, 4, 7] },
  min: { label: 'm', name: 'Menor', intervals: [0, 3, 7] },
  sus2: { label: 'sus2', name: 'sus2', intervals: [0, 2, 7] },
  sus4: { label: 'sus4', name: 'sus4', intervals: [0, 5, 7] },
  add9: { label: 'add9', name: 'add9', intervals: [0, 4, 7, 14] },
  maj7: { label: '7M', name: '7M', intervals: [0, 4, 7, 11] },
  m7: { label: 'm7', name: 'm7', intervals: [0, 3, 7, 10] },
  '5': { label: '5', name: 'Quinta', intervals: [0, 7] },
  dim: { label: '°', name: 'Diminuto (°)', intervals: [0, 3, 6] },
  dim7: { label: '°7', name: 'Diminuto 7 (°7)', intervals: [0, 3, 6, 9] },
};

export const SPECIAL_TYPES: ChordType[] = ['sus2', 'sus4', 'add9', 'maj7', 'm7', 'dim', 'dim7', '5'];

/** Nome do acorde; com `bass` diferente da fundamental, acorde com baixo (ex.: D/F#). */
export function chordLabel(root: number, type: ChordType, bass?: number): string {
  const name = NOTE_NAMES[root] + CHORDS[type].label;
  if (bass === undefined || bass === root) return name;
  // Terça maior de tom sem bemol é grafada com sustenido (E/G#, B/D#).
  const sharp = (bass - root + 12) % 12 === 4 && !NOTE_NAMES[root].includes('b');
  return `${name}/${sharp ? SHARP_NAMES[bass] : NOTE_NAMES[bass]}`;
}
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Nota grave do acorde: a fundamental uma oitava abaixo ou, com `bass`, essa nota logo acima dela. */
export function bassNote(root: number, bass?: number): number {
  let base = 48 + root; // C3 = 48
  if (root >= 6) base -= 12;
  return base - 12 + (bass === undefined ? 0 : (bass - root + 12) % 12);
}

/**
 * Voicing de pad: baixo (fundamental uma oitava abaixo, ou o baixo indicado
 * em inversões) + tríade/tétrade aberta no registro médio. Tons de F# a B
 * descem uma oitava para manter o timbre uniforme entre todos os acordes.
 */
export function padVoicing(root: number, type: ChordType, bass?: number): { body: number[]; shimmer: number[] } {
  let base = 48 + root; // C3 = 48
  if (root >= 6) base -= 12;
  const iv = CHORDS[type].intervals;
  const body = [bassNote(root, bass), ...iv.map((i) => base + i), base + 12];
  // Camada "shimmer": fundamental e quinta duas oitavas acima.
  const shimmer = [base + 24, base + 31];
  return { body, shimmer };
}

export const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
