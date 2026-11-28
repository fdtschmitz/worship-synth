/** Uma camada de osciladores tocando cada nota do acorde. */
export interface Layer {
  wave: OscillatorType;
  voices: number; // osciladores por nota
  spread: number; // desafinação total entre eles, em cents
  gain: number;
  octave?: number; // deslocamento em oitavas
  vibrato?: { rate: number; depth: number }; // Hz, cents
  /**
   * Síntese FM: um modulador em `ratio` × a frequência da nota desvia a
   * frequência do oscilador em `index` × a frequência. Com `sustain`, o índice
   * cai até `index * sustain` em `time` segundos (ataque brilhante, depois macio).
   */
  fm?: { ratio: number; index: number; sustain?: number; time?: number };
}

export interface Timbre {
  id: string;
  name: string;
  sampleSet?: string; // pasta em public/samples: usa gravações em vez de osciladores
  oneShot?: boolean; // a nota decai sozinha (piano): sem loop, ataque instantâneo
  memMB?: number; // memória aproximada das amostras decodificadas
  downloadMB?: number;
  noteAttack?: number; // ataque de cada nota nos modos Dedilhado/Arpejo (s)
  brokenGain?: number; // ajuste de volume no Dedilhado (padrão 1)
  arpGain?: number; // ajuste de volume no Arpejo (padrão 1)
  body: Layer[]; // passa pelo filtro principal
  shimmer: Layer[]; // camada aguda, controlada pelo slider "Shimmer"
  shimmerCutoff?: number; // lowpass da camada aguda (Hz); ausente = sem filtro
  bodyGain: number;
  cutoffScale: number; // multiplica o cutoff vindo do slider "Brilho"
  filterQ: number;
  highpass: number; // Hz; tira o "embolado" dos graves
  filterLfo: { rate: number; depth: number }; // movimento lento do filtro
  swell: boolean; // filtro abre junto com o fade in (ataque de arco)
  /** Filtros de formante (vogal), em paralelo, antes do filtro principal: som de coral. */
  formants?: { freq: number; q: number; gain: number }[];
  /**
   * Envelope do filtro a cada acorde/nota (metais): o cutoff sai de
   * `start` × o brilho, chega a `peak` × em `attack` s e volta ao brilho em `decay` s.
   */
  filterEnv?: { start: number; peak: number; attack: number; decay: number };
  /** Som percussivo: ataque instantâneo e o volume cai até `sustain` em `time` s. */
  decay?: { time: number; sustain: number };
  /** Volume cresce devagar e acelera no fim de cada acorde/nota, como fita tocada ao contrário. */
  reverse?: boolean;
}

export const TIMBRES: Timbre[] = [
  {
    id: 'classic',
    name: 'Pad clássico',
    body: [
      { wave: 'sawtooth', voices: 2, spread: 18, gain: 0.7 },
      { wave: 'triangle', voices: 1, spread: 0, gain: 0.7 },
    ],
    shimmer: [{ wave: 'sine', voices: 2, spread: 6, gain: 0.57 }],
    bodyGain: 0.32,
    cutoffScale: 1,
    filterQ: 0.6,
    highpass: 30,
    filterLfo: { rate: 0.11, depth: 180 },
    swell: false,
  },
  {
    id: 'strings',
    name: 'Cordas etéreas',
    body: [{ wave: 'sawtooth', voices: 5, spread: 24, gain: 1, vibrato: { rate: 5.2, depth: 7 } }],
    // "Violinos" agudos, uma camada de serras suavizadas acima do corpo.
    shimmer: [{ wave: 'sawtooth', voices: 3, spread: 16, gain: 0.55, vibrato: { rate: 5.7, depth: 8 } }],
    shimmerCutoff: 2600,
    bodyGain: 0.35,
    cutoffScale: 0.85,
    filterQ: 0.5,
    highpass: 90,
    filterLfo: { rate: 0.07, depth: 260 },
    swell: true,
  },
  {
    id: 'atmos',
    name: 'Atmosfera',
    body: [
      { wave: 'triangle', voices: 2, spread: 12, gain: 0.8 },
      { wave: 'sine', voices: 1, spread: 0, gain: 0.45, octave: 1 },
    ],
    shimmer: [{ wave: 'sine', voices: 3, spread: 10, gain: 0.9 }],
    bodyGain: 0.34,
    cutoffScale: 1.4,
    filterQ: 0.4,
    highpass: 40,
    filterLfo: { rate: 0.05, depth: 400 },
    swell: false,
  },
  {
    id: 'supersaw',
    name: 'Supersaw',
    // Muitas serras bem abertas: o pad largo e brilhante do louvor moderno.
    body: [{ wave: 'sawtooth', voices: 7, spread: 42, gain: 1 }],
    shimmer: [{ wave: 'sawtooth', voices: 3, spread: 28, gain: 0.45 }],
    shimmerCutoff: 4500,
    bodyGain: 0.3,
    cutoffScale: 1.25,
    filterQ: 0.5,
    highpass: 120,
    filterLfo: { rate: 0.08, depth: 300 },
    swell: false,
  },
  {
    id: 'warm',
    name: 'Pad quente',
    // Triângulos e senoide uma oitava abaixo, filtro fechado: macio, para oração.
    body: [
      { wave: 'triangle', voices: 2, spread: 10, gain: 0.9 },
      { wave: 'sine', voices: 1, spread: 0, gain: 0.55, octave: -1 },
    ],
    shimmer: [{ wave: 'sine', voices: 2, spread: 4, gain: 0.35 }],
    bodyGain: 0.42,
    cutoffScale: 0.6,
    filterQ: 0.7,
    highpass: 25,
    filterLfo: { rate: 0.06, depth: 120 },
    swell: false,
  },
  {
    id: 'synthorgan',
    name: 'Órgão sintético',
    // Registros de órgão (16', 8', 5 1/3', 4', 2'), com leve vibrato tipo Leslie.
    body: [
      { wave: 'sine', voices: 1, spread: 0, gain: 0.45, octave: -1 },
      { wave: 'sine', voices: 1, spread: 0, gain: 0.8, vibrato: { rate: 6.4, depth: 5 } },
      { wave: 'sine', voices: 1, spread: 0, gain: 0.35, octave: 7 / 12, vibrato: { rate: 6.4, depth: 5 } },
      { wave: 'sine', voices: 1, spread: 0, gain: 0.5, octave: 1, vibrato: { rate: 6.4, depth: 5 } },
      { wave: 'sine', voices: 1, spread: 0, gain: 0.25, octave: 2 },
    ],
    shimmer: [],
    bodyGain: 0.3,
    noteAttack: 0.006,
    cutoffScale: 2.5,
    filterQ: 0.3,
    highpass: 40,
    filterLfo: { rate: 0.05, depth: 0 },
    swell: false,
  },
  {
    id: 'sub',
    name: 'Pad grave',
    // Fundo grave e escuro, para preencher por baixo do violão (pede caixa de som/fone).
    body: [
      { wave: 'sine', voices: 1, spread: 0, gain: 1, octave: -1 },
      { wave: 'triangle', voices: 2, spread: 8, gain: 0.45 },
    ],
    shimmer: [],
    bodyGain: 0.5,
    cutoffScale: 0.35,
    filterQ: 0.6,
    highpass: 20,
    filterLfo: { rate: 0.05, depth: 60 },
    swell: false,
  },
  {
    id: 'glass',
    name: 'Cristal',
    // Senoides e triângulos agudos, levemente desafinados, com muito shimmer.
    body: [
      { wave: 'triangle', voices: 2, spread: 8, gain: 0.5, octave: 1 },
      { wave: 'sine', voices: 2, spread: 6, gain: 0.6 },
    ],
    shimmer: [{ wave: 'sine', voices: 3, spread: 14, gain: 1 }],
    bodyGain: 0.32,
    cutoffScale: 2.2,
    filterQ: 0.4,
    highpass: 250,
    filterLfo: { rate: 0.09, depth: 500 },
    swell: false,
  },
  {
    id: 'choir',
    name: 'Coral',
    // Naipe de serras com vibrato passando por formantes da vogal "Aah".
    body: [{ wave: 'sawtooth', voices: 4, spread: 22, gain: 1, vibrato: { rate: 5, depth: 10 } }],
    shimmer: [{ wave: 'sine', voices: 2, spread: 8, gain: 0.3 }],
    formants: [
      { freq: 750, q: 7, gain: 3.2 },
      { freq: 1150, q: 8, gain: 2.2 },
      { freq: 2800, q: 10, gain: 1.2 },
    ],
    bodyGain: 0.45,
    cutoffScale: 2,
    filterQ: 0.4,
    highpass: 110,
    filterLfo: { rate: 0.06, depth: 150 },
    swell: true,
  },
  {
    id: 'synthbrass',
    name: 'Metais sintéticos',
    // Serras com o filtro abrindo rápido no ataque de cada acorde/nota.
    body: [{ wave: 'sawtooth', voices: 3, spread: 14, gain: 1 }],
    shimmer: [],
    filterEnv: { start: 0.25, peak: 2.4, attack: 0.09, decay: 0.45 },
    bodyGain: 0.3,
    noteAttack: 0.03,
    cutoffScale: 0.7,
    filterQ: 1.3,
    highpass: 70,
    filterLfo: { rate: 0.06, depth: 80 },
    swell: false,
  },
  {
    id: 'epiano',
    name: 'Piano elétrico',
    // FM: corpo suave (razão 1) + "tine" agudo (razão 14) que some rápido.
    body: [
      { wave: 'sine', voices: 1, spread: 0, gain: 1, fm: { ratio: 1, index: 1.6, sustain: 0.25, time: 0.8 } },
      { wave: 'sine', voices: 1, spread: 0, gain: 0.25, fm: { ratio: 14, index: 0.5, sustain: 0, time: 0.15 } },
    ],
    shimmer: [],
    decay: { time: 2.5, sustain: 0.3 },
    bodyGain: 0.45,
    noteAttack: 0.004,
    brokenGain: 1.2,
    cutoffScale: 3,
    filterQ: 0.3,
    highpass: 40,
    filterLfo: { rate: 0.05, depth: 0 },
    swell: false,
  },
  {
    id: 'bells',
    name: 'Sinos',
    // FM com razão inarmônica (3,5): som metálico que decai como um sino.
    body: [
      { wave: 'sine', voices: 1, spread: 0, gain: 1, fm: { ratio: 3.5, index: 2.2, sustain: 0.1, time: 1.5 } },
      { wave: 'sine', voices: 1, spread: 0, gain: 0.3, octave: 1 },
    ],
    shimmer: [],
    decay: { time: 4, sustain: 0.08 },
    bodyGain: 0.32,
    noteAttack: 0.003,
    cutoffScale: 4,
    filterQ: 0.3,
    highpass: 150,
    filterLfo: { rate: 0.05, depth: 0 },
    swell: false,
  },
  {
    id: 'reverse',
    name: 'Pad reverso',
    // Cada acorde cresce e é cortado no fim, como fita tocada ao contrário.
    body: [
      { wave: 'sawtooth', voices: 3, spread: 20, gain: 0.8 },
      { wave: 'triangle', voices: 1, spread: 0, gain: 0.6 },
    ],
    shimmer: [{ wave: 'sine', voices: 2, spread: 8, gain: 0.6 }],
    reverse: true,
    bodyGain: 0.34,
    cutoffScale: 1.1,
    filterQ: 0.5,
    highpass: 60,
    filterLfo: { rate: 0.07, depth: 200 },
    swell: true,
  },
  {
    id: 'orchestra',
    name: 'Orquestra',
    sampleSet: 'strings',
    memMB: 40,
    downloadMB: 1.5,
    body: [],
    shimmer: [],
    bodyGain: 1.25,
    brokenGain: 1.2,
    arpGain: 1.9,
    cutoffScale: 3,
    filterQ: 0.4,
    highpass: 35,
    filterLfo: { rate: 0.06, depth: 150 },
    swell: true,
  },
  {
    id: 'organ',
    name: 'Órgão',
    sampleSet: 'organ',
    memMB: 27,
    downloadMB: 1,
    body: [],
    shimmer: [],
    bodyGain: 1.25,
    arpGain: 1.6,
    cutoffScale: 4,
    filterQ: 0.4,
    highpass: 30,
    filterLfo: { rate: 0.05, depth: 80 },
    swell: false,
  },
  {
    id: 'horn',
    name: 'Trompas',
    sampleSet: 'horn',
    memMB: 22,
    downloadMB: 0.8,
    body: [],
    shimmer: [],
    bodyGain: 1.1,
    brokenGain: 0.8,
    arpGain: 0.75,
    cutoffScale: 3,
    filterQ: 0.4,
    highpass: 35,
    filterLfo: { rate: 0.06, depth: 120 },
    swell: true,
  },
  {
    id: 'piano',
    name: 'Piano',
    sampleSet: 'piano',
    oneShot: true,
    memMB: 39,
    downloadMB: 1.4,
    body: [],
    shimmer: [],
    bodyGain: 0.5,
    cutoffScale: 6,
    filterQ: 0.3,
    highpass: 30,
    filterLfo: { rate: 0.05, depth: 0 },
    swell: false,
  },
  {
    id: 'flute',
    name: 'Flauta',
    sampleSet: 'flute',
    memMB: 16,
    downloadMB: 0.6,
    body: [],
    shimmer: [],
    bodyGain: 1.25,
    brokenGain: 0.7,
    cutoffScale: 4,
    filterQ: 0.4,
    highpass: 60,
    filterLfo: { rate: 0.05, depth: 100 },
    swell: false,
  },
];

/** Aviso de memória dos timbres com amostras. */
export function sampleWarning(t: Timbre): string | null {
  if (!t.sampleSet) return null;
  return (
    `Usa gravações reais: cerca de ${t.memMB} MB de memória e ${String(t.downloadMB).replace('.', ',')} MB ` +
    'de download na primeira vez. Em aparelhos com pouca memória, o navegador pode recarregar a página.'
  );
}

export const timbreById = (id: string) => TIMBRES.find((t) => t.id === id) ?? TIMBRES[0];

/** Timbres de ataque instantâneo (o fade in configurado não se aplica). */
export const isStruck = (t: Timbre) => !!t.oneShot || !!t.decay;
