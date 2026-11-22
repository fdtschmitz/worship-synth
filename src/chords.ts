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

export function chordLabel(root: number, type: ChordType): string {
  return NOTE_NAMES[root] + CHORDS[type].label;
}

/**
 * Voicing de pad: baixo (fundamental uma oitava abaixo) + tríade/tétrade aberta
 * no registro médio. Tons de F# a B descem uma oitava para manter o timbre
 * uniforme entre todos os acordes.
 */
export function padVoicing(root: number, type: ChordType): { body: number[]; shimmer: number[] } {
  let base = 48 + root; // C3 = 48
  if (root >= 6) base -= 12;
  const iv = CHORDS[type].intervals;
  const body = [base - 12, ...iv.map((i) => base + i), base + 12];
  // Camada "shimmer": fundamental e quinta duas oitavas acima.
  const shimmer = [base + 24, base + 31];
  return { body, shimmer };
}

export const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
