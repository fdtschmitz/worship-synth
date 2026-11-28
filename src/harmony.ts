import { CHORDS, NOTE_NAMES, chordLabel, type ChordType } from './chords';

/** Acorde com baixo opcional (inversão / acorde com baixo trocado, ex.: D/F#). */
export interface Chord {
  root: number;
  type: ChordType;
  bass?: number;
}

export type SuggestionKind = 'dominant' | 'inversion' | 'walk' | 'common';

export interface Suggestion {
  chord: Chord;
  kind: SuggestionKind;
  /** 'insert': entra entre os dois acordes; 'replace': substitui o segundo. */
  action: 'insert' | 'replace';
  reason: string; // explicação curta
  bassLine: string; // ex.: "C → F# → G"
  score: number;
}

const mod = (n: number) => ((n % 12) + 12) % 12;
const bassOf = (c: Chord) => c.bass ?? c.root;
const name = (pc: number) => NOTE_NAMES[mod(pc)];

type Quality = 'maj' | 'min' | 'dim' | 'any';

/** Qualidade da tríade, para encaixar no campo harmônico. */
function quality(type: ChordType): Quality {
  switch (type) {
    case 'min':
    case 'm7':
      return 'min';
    case 'dim':
    case 'dim7':
      return 'dim';
    case 'sus2':
    case 'sus4':
    case '5':
      return 'any';
    default:
      return 'maj';
  }
}

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const DEGREE_TYPES: ChordType[] = ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'];
const DEGREE_NAMES = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];

interface Diatonic {
  root: number;
  type: ChordType;
  degree: number; // 0..6
}

function diatonicChords(key: number): Diatonic[] {
  return MAJOR_SCALE.map((s, d) => ({ root: mod(key + s), type: DEGREE_TYPES[d], degree: d }));
}

/** Grau do acorde no tom maior `key`, ou -1 se não pertence ao campo. */
function degreeIn(key: number, c: Chord): number {
  const q = quality(c.type);
  return diatonicChords(key).findIndex((d) => d.root === mod(c.root) && (q === 'any' || quality(d.type) === q));
}

/**
 * Escolhe o tom (maior; o relativo menor tem o mesmo campo) em que os dois
 * acordes se encaixam, preferindo o primeiro como tônica (I ou vi).
 */
export function detectKey(a: Chord, b: Chord): number {
  let best = mod(a.root);
  let bestScore = -Infinity;
  for (let k = 0; k < 12; k++) {
    const da = degreeIn(k, a);
    const db = degreeIn(k, b);
    let s = (da >= 0 ? 4 : 0) + (db >= 0 ? 4 : 0);
    if (da === 0) s += 3;
    else if (da === 5) s += 2;
    if (db === 0) s += 2;
    else if (db === 5) s += 1;
    if (da === 3 || da === 4) s += 1;
    if (db === 3 || db === 4) s += 1;
    if (s > bestScore) {
      bestScore = s;
      best = k;
    }
  }
  return best;
}

/** Notas (classes de altura) do acorde. */
function pitchClasses(c: Chord): Set<number> {
  return new Set(CHORDS[c.type].intervals.map((i) => mod(c.root + i)));
}

/** Terça e quinta do acorde (para inversões), se houver. */
function chordTones(type: ChordType): { third?: number; fifth?: number } {
  const iv = CHORDS[type].intervals;
  return {
    third: iv.find((i) => i === 3 || i === 4),
    fifth: iv.find((i) => i === 7 || i === 6),
  };
}

/** Distância (com sinal) do menor caminho entre duas notas: -6..+6. */
function step(from: number, to: number): number {
  const d = mod(to - from);
  return d > 6 ? d - 12 : d;
}

export const chordName = (c: Chord) => chordLabel(c.root, c.type, c.bass);

const same = (x: Chord, y: Chord) => x.root === y.root && x.type === y.type && mod(bassOf(x)) === mod(bassOf(y));

/**
 * Sugere inversões e acordes de passagem para suavizar a troca de `a` para `b`:
 * dominante secundária invertida (ex.: C → D/F# → G), inversão do segundo
 * acorde (baixo por grau conjunto), acordes do campo harmônico com o baixo
 * caminhando por graus conjuntos e acordes do campo com notas em comum.
 */
export function suggestTransitions(a: Chord, b: Chord, max = 6): Suggestion[] {
  if (mod(a.root) === mod(b.root) && a.type === b.type) return [];
  const key = detectKey(a, b);
  const diat = diatonicChords(key);
  const scale = new Set(MAJOR_SCALE.map((s) => mod(key + s)));
  const bA = mod(bassOf(a));
  const bB = mod(bassOf(b));
  const out: Suggestion[] = [];
  const line = (...pcs: number[]) => pcs.map(name).join(' → ');
  const add = (s: Suggestion) => {
    if (same(s.chord, a) || same(s.chord, b)) return;
    const prev = out.find((o) => same(o.chord, s.chord) && o.action === s.action);
    if (prev) {
      if (s.score > prev.score) Object.assign(prev, s);
      return;
    }
    out.push(s);
  };
  const qB = quality(b.type);

  // 1. Dominante (secundária) do segundo acorde, na 1ª inversão: o baixo é a
  //    sensível, meio tom abaixo do baixo de destino.
  if (qB !== 'dim') {
    const vRoot = mod(b.root + 7);
    const leading = mod(b.root + 11);
    const lt = chordLabel(vRoot, 'maj', leading).split('/')[1]; // sensível com a grafia certa (G#, não Ab)
    const isDiatonic = degreeIn(key, { root: vRoot, type: 'maj' }) >= 0;
    const alreadyV = mod(a.root) === vRoot && quality(a.type) !== 'min';
    if (!alreadyV) {
      const label =
        mod(b.root) === key
          ? 'Dominante (V)'
          : isDiatonic
            ? `Dominante de ${name(b.root)}`
            : `Dominante secundária (V/${name(b.root)})`;
      // Só se o destino está com o baixo na fundamental (a sensível resolve nele).
      if (bB === mod(b.root)) {
        add({
          chord: { root: vRoot, type: 'maj', bass: leading },
          kind: 'dominant',
          action: 'insert',
          reason: `${label} invertida: o baixo ${lt} sobe meio tom até ${name(b.root)}.`,
          bassLine: [name(bA), lt, name(bB)].join(' → '),
          score: 9 + (Math.abs(step(bA, leading)) <= 2 ? 2 : 0),
        });
      }
      add({
        chord: { root: vRoot, type: 'maj' },
        kind: 'dominant',
        action: 'insert',
        reason: `${label}: prepara a chegada em ${chordName(b)}.`,
        bassLine: line(bA, vRoot, bB),
        score: 5,
      });
    }
  }

  // 2. Inversão do segundo acorde: baixo mais perto do baixo do primeiro.
  {
    const { third, fifth } = chordTones(b.type);
    const opts: [number | undefined, string][] = [
      [third, '1ª inversão'],
      [fifth, '2ª inversão'],
    ];
    const direct = Math.abs(step(bA, bB));
    for (const [iv, label] of opts) {
      if (iv === undefined) continue;
      const nb = mod(b.root + iv);
      const d = Math.abs(step(bA, nb));
      if (nb === bB || d > 2 || d >= direct) continue;
      add({
        chord: { root: b.root, type: b.type, bass: nb },
        kind: 'inversion',
        action: 'replace',
        reason: `${label} de ${chordName({ root: b.root, type: b.type })}: ${
          d === 0 ? `o baixo fica parado em ${name(nb)}` : `o baixo anda só ${d === 1 ? 'meio tom' : 'um tom'}`
        }.`,
        bassLine: line(bA, nb),
        score: label === '1ª inversão' ? 8 : 6,
      });
    }
  }

  // 3. Baixo caminhando por graus conjuntos da escala entre os dois baixos.
  for (const dir of [1, -1]) {
    const notes: number[] = [];
    for (let n = mod(bA + dir), guard = 0; n !== bB && guard < 12; n = mod(n + dir), guard++) {
      if (scale.has(n)) notes.push(n);
    }
    if (notes.length === 0 || notes.length > 3) continue; // longe demais nessa direção
    const shortest = Math.sign(step(bA, bB)) === dir;
    for (const n of notes) {
      // Acorde do campo com essa nota no baixo: em estado fundamental ou 1ª inversão.
      for (const d of diat) {
        const { third } = chordTones(d.type);
        let bass: number | undefined;
        let score = shortest ? 6 : 4;
        if (d.root === n) {
          if (d.type === 'dim') continue; // vii° em estado fundamental soa tenso demais
          score += 1;
        } else if (third !== undefined && mod(d.root + third) === n) {
          bass = n;
        } else continue;
        // O próprio segundo acorde invertido já aparece como "trocar o 2º".
        if (d.root === mod(b.root) && quality(d.type) === quality(b.type)) continue;
        const chord: Chord = { root: d.root, type: d.type, bass };
        add({
          chord,
          kind: 'walk',
          action: 'insert',
          reason: `${DEGREE_NAMES[d.degree]} do campo de ${name(key)}: o baixo caminha por graus conjuntos.`,
          bassLine: line(bA, n, bB),
          score,
        });
      }
    }
  }

  // 4. Acorde do campo com notas em comum com os dois.
  {
    const pa = pitchClasses(a);
    const pb = pitchClasses(b);
    for (const d of diat) {
      if (d.type === 'dim') continue;
      const pd = pitchClasses(d);
      const ca = [...pd].filter((x) => pa.has(x)).length;
      const cb = [...pd].filter((x) => pb.has(x)).length;
      if (ca === 0 || cb === 0) continue;
      add({
        chord: { root: d.root, type: d.type },
        kind: 'common',
        action: 'insert',
        reason: `${DEGREE_NAMES[d.degree]} do campo de ${name(key)}: tem notas em comum com os dois acordes.`,
        bassLine: line(bA, d.root, bB),
        score: 3 + ca + cb,
      });
    }
  }

  return out.sort((x, y) => y.score - x.score).slice(0, max);
}
