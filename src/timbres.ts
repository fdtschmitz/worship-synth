/** Uma camada de osciladores tocando cada nota do acorde. */
export interface Layer {
  wave: OscillatorType;
  voices: number; // osciladores por nota
  spread: number; // desafinação total entre eles, em cents
  gain: number;
  octave?: number; // deslocamento em oitavas
  vibrato?: { rate: number; depth: number }; // Hz, cents
}

export interface Timbre {
  id: string;
  name: string;
  samples?: boolean; // usa amostras gravadas em vez de osciladores
  warning?: string; // aviso exibido nas configurações
  body: Layer[]; // passa pelo filtro principal
  shimmer: Layer[]; // camada aguda, controlada pelo slider "Shimmer"
  shimmerCutoff?: number; // lowpass da camada aguda (Hz); ausente = sem filtro
  bodyGain: number;
  cutoffScale: number; // multiplica o cutoff vindo do slider "Brilho"
  filterQ: number;
  highpass: number; // Hz; tira o "embolado" dos graves
  filterLfo: { rate: number; depth: number }; // movimento lento do filtro
  swell: boolean; // filtro abre junto com o fade in (ataque de arco)
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
    id: 'orchestra',
    name: 'Orquestra (amostras)',
    samples: true,
    warning:
      'Usa gravações reais de naipes de cordas: cerca de 40 MB de memória e 1,5 MB de download na primeira vez. ' +
      'Em aparelhos com pouca memória, o navegador pode recarregar a página.',
    body: [],
    shimmer: [],
    bodyGain: 1.25,
    cutoffScale: 3,
    filterQ: 0.4,
    highpass: 35,
    filterLfo: { rate: 0.06, depth: 150 },
    swell: true,
  },
];

export const timbreById = (id: string) => TIMBRES.find((t) => t.id === id) ?? TIMBRES[0];
