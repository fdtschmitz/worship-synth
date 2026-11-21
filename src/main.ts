import './style.css';
import { PadEngine, type PadSettings } from './audio';
import { CHORDS, NOTE_NAMES, SPECIAL_TYPES, chordLabel, type ChordType } from './chords';
import { ARP_NOTE_LABELS, type ArpDir, type PlayMode, type RhythmSettings } from './sequencer';
import { TIMBRES, sampleWarning, timbreById } from './timbres';

type Tab = 'maj' | 'min' | 'special' | 'seq';
interface Step {
  root: number;
  type: ChordType;
}

// ---------- Persistência ----------
const load = <T>(k: string, def: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? { ...def, ...JSON.parse(v) } : def;
  } catch {
    return def;
  }
};
const save = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* modo privado */
  }
};

const settings: PadSettings = load('settings', {
  timbre: 'classic',
  fadeIn: 3,
  fadeOut: 3,
  volume: 0.8,
  brightness: 0.45,
  reverb: 0.6,
  shimmer: 0.4,
});
const rhythm: RhythmSettings = load('rhythm', {
  mode: 'pad' as PlayMode,
  bpm: 72,
  arpNotes: 3,
  arpOctaves: 2,
  arpDir: 'up' as ArpDir,
  arpDiv: 8 as 4 | 8 | 16,
});
const ui = load('ui', { tab: 'maj' as Tab, special: 'sus2' as ChordType });
let sequence: Step[] = (() => {
  try {
    return JSON.parse(localStorage.getItem('sequence') || '[]');
  } catch {
    return [];
  }
})();

const engine = new PadEngine(settings, rhythm);
let activeKey: string | null = null;
let seqIndex = -1;

// ---------- Wake lock (tela não apaga enquanto toca) ----------
let wakeLock: { release(): Promise<void> } | null = null;
async function syncWakeLock() {
  const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<any> } };
  try {
    if (activeKey && !wakeLock && nav.wakeLock) wakeLock = await nav.wakeLock.request('screen');
    else if (!activeKey && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    wakeLock = null;
    syncWakeLock();
  }
});

// ---------- Lógica de toggle ----------
const keyOf = (s: Step) => `${s.root}:${s.type}`;

// ---------- Amostras (carregadas sob demanda) ----------
let loadingText: string | null = null;

/** Garante que as amostras do timbre atual estão carregadas. */
async function prepareSamples() {
  if (!timbreById(settings.timbre).sampleSet || engine.samplesReady) return;
  loadingText = 'Carregando…';
  refreshActive();
  try {
    await engine.ensureSamples((done, total) => {
      loadingText = `Carregando ${done}/${total}`;
      refreshActive();
    });
  } catch (err) {
    console.error(err);
    alert('Não foi possível carregar as amostras. Verifique a conexão.\nUsando “Cordas etéreas” no lugar.');
    await setTimbre('strings');
  } finally {
    loadingText = null;
    refreshActive();
    renderTimbres();
  }
}

async function setTimbre(id: string) {
  engine.update({ timbre: id });
  save('settings', settings);
  renderTimbres();
  await prepareSamples();
  if (settings.timbre === id) restartActive();
}

/** Recria o acorde que está tocando (troca de timbre ou de modo). */
function restartActive() {
  if (!activeKey) return;
  const [r, t] = activeKey.split(':');
  engine.play(activeKey, Number(r), t as ChordType, true);
}

async function toggle(step: Step) {
  await engine.unlock();
  await prepareSamples();
  const key = keyOf(step);
  if (activeKey === key) {
    engine.stop(key);
    activeKey = null;
  } else {
    engine.play(key, step.root, step.type); // faz crossfade / troca de padrão
    activeKey = key;
  }
  refreshActive();
  syncWakeLock();
}

function stopAll() {
  engine.stopAll();
  activeKey = null;
  refreshActive();
  syncWakeLock();
}

// ---------- DOM ----------
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const app = $('#app');

app.innerHTML = `
  <header class="top">
    <nav class="tabs" role="tablist">
      <button data-tab="maj">Maiores</button>
      <button data-tab="min">Menores</button>
      <button data-tab="special">Especiais</button>
      <button data-tab="seq">Sequência</button>
    </nav>
  </header>
  <div class="modebar">
    <div class="seg" id="modes">
      <button data-mode="pad">Pad</button>
      <button data-mode="broken">Dedilhado</button>
      <button data-mode="arp">Arpejo</button>
    </div>
    <div class="tempo" id="tempo">
      <span id="bpm-label"></span>
      <button id="tap" class="ghost">TAP</button>
    </div>
  </div>
  <main id="view"></main>
  <footer class="bottom">
    <button id="stop" class="ghost">■ Parar</button>
    <span id="now" class="now">—</span>
    <button id="open-settings" class="ghost" aria-label="Configurações">⚙︎</button>
  </footer>
  <p class="credit">Created by fdtschmitz - 2026</p>
  <div id="sheet" class="sheet" hidden>
    <div class="sheet-panel">
      <div class="sheet-head"><h2>Configurações</h2><button id="close-settings" class="ghost">Fechar</button></div>
      <div class="field-label">Timbre</div>
      <div class="chips" id="timbres"></div>
      <p class="hint" id="timbre-hint" hidden></p>
      <section id="rhythm-section" class="section">
        <label class="slider">
          <span>Tempo</span><output id="o-bpm"></output>
          <input type="range" id="bpm" min="40" max="200" step="1">
        </label>
        <div id="arp-section" class="section">
          <div class="field-label">Notas do arpejo</div>
          <div class="chips" id="arp-notes"></div>
          <p class="caption" id="arp-notes-desc"></p>
          <div class="field-label">Oitavas</div>
          <div class="chips" id="arp-oct"></div>
          <div class="field-label">Direção</div>
          <div class="chips" id="arp-dir"></div>
          <div class="field-label">Figura</div>
          <div class="chips" id="arp-div"></div>
        </div>
      </section>
      <div id="sliders"></div>
    </div>
  </div>
  <div id="picker" class="sheet" hidden>
    <div class="sheet-panel">
      <div class="sheet-head"><h2>Adicionar acorde</h2><button id="close-picker" class="ghost">Fechar</button></div>
      <div class="chips" id="picker-types"></div>
      <div class="grid small" id="picker-roots"></div>
    </div>
  </div>
`;

const view = $('#view');

function render() {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === ui.tab);
  });
  if (ui.tab === 'seq') renderSequence();
  else renderGrid();
  refreshActive();
}

function gridButtons(type: ChordType) {
  return NOTE_NAMES.map(
    (_, root) =>
      `<button class="pad" data-key="${root}:${type}" data-root="${root}" data-type="${type}">
        <span>${chordLabel(root, type)}</span>
      </button>`,
  ).join('');
}

function renderGrid() {
  const type: ChordType = ui.tab === 'maj' ? 'maj' : ui.tab === 'min' ? 'min' : ui.special;
  const chips =
    ui.tab === 'special'
      ? `<div class="chips">${SPECIAL_TYPES.map(
          (t) => `<button class="chip ${t === ui.special ? 'on' : ''}" data-special="${t}">${CHORDS[t].name}</button>`,
        ).join('')}</div>`
      : '';
  view.innerHTML = `${chips}<div class="grid">${gridButtons(type)}</div>`;
}

function renderSequence() {
  const steps = sequence
    .map(
      (s, i) =>
        `<button class="pad step ${i === seqIndex ? 'cursor' : ''}" data-key="${keyOf(s)}" data-root="${s.root}" data-type="${s.type}" data-index="${i}">
          <small>${i + 1}</small><span>${chordLabel(s.root, s.type)}</span>
        </button>`,
    )
    .join('');
  view.innerHTML = `
    <div class="seq-actions">
      <button id="seq-prev" class="ghost">◀ Anterior</button>
      <button id="seq-next" class="primary">Próximo ▶</button>
    </div>
    <div class="grid">${steps || '<p class="empty">Nenhum acorde na sequência.<br>Toque em “+ Adicionar”.</p>'}</div>
    <div class="seq-actions">
      <button id="seq-add" class="ghost">+ Adicionar</button>
      <button id="seq-undo" class="ghost" ${sequence.length ? '' : 'disabled'}>Remover último</button>
      <button id="seq-clear" class="ghost" ${sequence.length ? '' : 'disabled'}>Limpar</button>
    </div>`;
}

function refreshActive() {
  document.querySelectorAll<HTMLButtonElement>('#view .pad').forEach((b) => {
    const on = b.dataset.key === activeKey && (ui.tab !== 'seq' || Number(b.dataset.index) === seqIndex);
    b.classList.toggle('active', on);
  });
  document.documentElement.style.setProperty('--fade-in', `${settings.fadeIn}s`);
  document.documentElement.style.setProperty('--fade-out', `${settings.fadeOut}s`);
  if (loadingText) {
    $('#now').textContent = loadingText;
  } else if (activeKey) {
    const [r, t] = activeKey.split(':');
    $('#now').textContent = chordLabel(Number(r), t as ChordType);
  } else $('#now').textContent = '—';
}

function goSeq(i: number) {
  if (!sequence.length) return;
  seqIndex = (i + sequence.length) % sequence.length;
  const step = sequence[seqIndex];
  if (activeKey !== keyOf(step)) toggle(step);
  else refreshActive();
  renderSequence();
  refreshActive();
}

function saveSeq() {
  save('sequence', sequence);
}

// ---------- Eventos ----------
$('.tabs').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
  if (!b) return;
  ui.tab = b.dataset.tab as Tab;
  save('ui', ui);
  render();
});

view.addEventListener('click', (e) => {
  const el = e.target as HTMLElement;
  const chip = el.closest<HTMLButtonElement>('[data-special]');
  if (chip) {
    ui.special = chip.dataset.special as ChordType;
    save('ui', ui);
    render();
    return;
  }
  const pad = el.closest<HTMLButtonElement>('.pad');
  if (pad) {
    const step = { root: Number(pad.dataset.root), type: pad.dataset.type as ChordType };
    if (pad.dataset.index !== undefined) {
      const i = Number(pad.dataset.index);
      if (i === seqIndex && activeKey === keyOf(step)) {
        toggle(step); // desliga
      } else {
        seqIndex = i;
        if (activeKey !== keyOf(step)) toggle(step);
        renderSequence();
      }
      refreshActive();
    } else {
      toggle(step);
    }
    return;
  }
  const id = el.closest('button')?.id;
  if (id === 'seq-next') goSeq(seqIndex + 1);
  else if (id === 'seq-prev') goSeq(seqIndex - 1);
  else if (id === 'seq-add') openPicker();
  else if (id === 'seq-undo') {
    sequence.pop();
    if (seqIndex >= sequence.length) seqIndex = sequence.length - 1;
    saveSeq();
    render();
  } else if (id === 'seq-clear') {
    if (confirm('Limpar a sequência?')) {
      sequence = [];
      seqIndex = -1;
      saveSeq();
      render();
    }
  }
});

// Evita zoom por duplo toque no iOS sem atrasar o toque.
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

$('#stop').addEventListener('click', stopAll);

// ---------- Configurações ----------
type NumericSetting = Exclude<keyof PadSettings, 'timbre'>;
const sliderDefs: { key: NumericSetting; label: string; min: number; max: number; step: number; fmt: (v: number) => string }[] = [
  { key: 'fadeIn', label: 'Fade in', min: 0, max: 15, step: 0.5, fmt: (v) => `${v.toFixed(1)} s` },
  { key: 'fadeOut', label: 'Fade out', min: 0, max: 15, step: 0.5, fmt: (v) => `${v.toFixed(1)} s` },
  { key: 'volume', label: 'Volume', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'brightness', label: 'Brilho', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'reverb', label: 'Reverb', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'shimmer', label: 'Shimmer', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
];

function renderTimbres() {
  $('#timbres').innerHTML = TIMBRES.map(
    (t) =>
      `<button class="chip ${t.id === settings.timbre ? 'on' : ''}" data-timbre="${t.id}">${t.name}${t.sampleSet ? ' <span class="warn-mark">⚠︎</span>' : ''}</button>`,
  ).join('');
  const t = timbreById(settings.timbre);
  const warning = sampleWarning(t);
  const hint = $('#timbre-hint');
  hint.hidden = !warning;
  if (warning) {
    const mb = engine.samplesBytes / 1e6;
    hint.textContent = `⚠︎ ${warning}${mb ? ` Em uso agora: ${Math.round(mb)} MB.` : ''}`;
  }
}

$('#timbres').addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-timbre]');
  const id = b?.dataset.timbre;
  if (!id || id === settings.timbre) return;
  const t = timbreById(id);
  const warning = sampleWarning(t);
  if (warning && !localStorage.getItem(`warned:${id}`)) {
    if (!confirm(`${t.name}: ${warning}\n\nDeseja continuar?`)) return;
    save(`warned:${id}`, true);
  }
  await engine.unlock(); // ainda dentro do gesto do usuário
  await setTimbre(id);
});

$('#sliders').innerHTML = sliderDefs
  .map(
    (d) => `<label class="slider">
      <span>${d.label}</span><output id="o-${d.key}">${d.fmt(settings[d.key])}</output>
      <input type="range" data-key="${d.key}" min="${d.min}" max="${d.max}" step="${d.step}" value="${settings[d.key]}">
    </label>`,
  )
  .join('');

$('#sliders').addEventListener('input', (e) => {
  const input = e.target as HTMLInputElement;
  const key = input.dataset.key as NumericSetting;
  const def = sliderDefs.find((d) => d.key === key)!;
  const v = Number(input.value);
  engine.update({ [key]: v });
  $(`#o-${key}`).textContent = def.fmt(v);
  save('settings', settings);
  refreshActive();
});

const sheet = $('#sheet');
$('#open-settings').addEventListener('click', () => (sheet.hidden = false));
$('#close-settings').addEventListener('click', () => (sheet.hidden = true));
sheet.addEventListener('click', (e) => e.target === sheet && (sheet.hidden = true));

// ---------- Picker da sequência ----------
const picker = $('#picker');
let pickType: ChordType = 'maj';
const ALL_TYPES: ChordType[] = ['maj', 'min', ...SPECIAL_TYPES];

function renderPicker() {
  $('#picker-types').innerHTML = ALL_TYPES.map(
    (t) => `<button class="chip ${t === pickType ? 'on' : ''}" data-pick-type="${t}">${CHORDS[t].name}</button>`,
  ).join('');
  $('#picker-roots').innerHTML = NOTE_NAMES.map(
    (_, r) => `<button class="pad" data-pick-root="${r}"><span>${chordLabel(r, pickType)}</span></button>`,
  ).join('');
}
function openPicker() {
  renderPicker();
  picker.hidden = false;
}
picker.addEventListener('click', (e) => {
  const el = e.target as HTMLElement;
  if (el === picker || el.closest('#close-picker')) {
    picker.hidden = true;
    return;
  }
  const t = el.closest<HTMLElement>('[data-pick-type]');
  if (t) {
    pickType = t.dataset.pickType as ChordType;
    renderPicker();
    return;
  }
  const r = el.closest<HTMLElement>('[data-pick-root]');
  if (r) {
    sequence.push({ root: Number(r.dataset.pickRoot), type: pickType });
    saveSeq();
    r.classList.add('flash');
    setTimeout(() => r.classList.remove('flash'), 250);
    render();
  }
});

// ---------- Ritmo (Dedilhado / Arpejo) ----------
const DIRS: [ArpDir, string][] = [
  ['up', 'Sobe'],
  ['down', 'Desce'],
  ['updown', 'Sobe e desce'],
  ['random', 'Aleatória'],
];
const DIVS: [4 | 8 | 16, string][] = [
  [4, 'Semínima'],
  [8, 'Colcheia'],
  [16, 'Semicolcheia'],
];
const chipRow = <T extends string | number>(attr: string, items: [T, string][], current: T) =>
  items.map(([v, label]) => `<button class="chip ${v === current ? 'on' : ''}" data-${attr}="${v}">${label}</button>`).join('');

function renderRhythm() {
  document.querySelectorAll<HTMLButtonElement>('#modes button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === rhythm.mode);
  });
  $('#tempo').hidden = rhythm.mode === 'pad';
  $('#bpm-label').textContent = `♩ ${rhythm.bpm}`;
  $('#rhythm-section').hidden = rhythm.mode === 'pad';
  $('#arp-section').hidden = rhythm.mode !== 'arp';
  $<HTMLInputElement>('#bpm').value = String(rhythm.bpm);
  $('#o-bpm').textContent = `${rhythm.bpm} BPM`;
  $('#arp-notes').innerHTML = chipRow('arp-notes', ARP_NOTE_LABELS.map((_, i): [number, string] => [i + 1, String(i + 1)]), rhythm.arpNotes);
  $('#arp-notes-desc').textContent = ARP_NOTE_LABELS.slice(0, rhythm.arpNotes).join(' ');
  $('#arp-oct').innerHTML = chipRow('arp-oct', [[1, '1'], [2, '2'], [3, '3']], rhythm.arpOctaves);
  $('#arp-dir').innerHTML = chipRow('arp-dir', DIRS, rhythm.arpDir);
  $('#arp-div').innerHTML = chipRow('arp-div', DIVS, rhythm.arpDiv);
}

function setRhythm(patch: Partial<RhythmSettings>) {
  const modeChanged = patch.mode !== undefined && patch.mode !== rhythm.mode;
  Object.assign(rhythm, patch); // o engine lê o mesmo objeto: vale no próximo passo
  save('rhythm', rhythm);
  renderRhythm();
  if (modeChanged) restartActive();
}

$('#modes').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]');
  if (b) setRhythm({ mode: b.dataset.mode as PlayMode });
});

$('#bpm').addEventListener('input', (e) => setRhythm({ bpm: Number((e.target as HTMLInputElement).value) }));

$('#arp-section').addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.chip');
  if (!el) return;
  const d = el.dataset;
  if (d.arpNotes) setRhythm({ arpNotes: Number(d.arpNotes) });
  else if (d.arpOct) setRhythm({ arpOctaves: Number(d.arpOct) });
  else if (d.arpDir) setRhythm({ arpDir: d.arpDir as ArpDir });
  else if (d.arpDiv) setRhythm({ arpDiv: Number(d.arpDiv) as 4 | 8 | 16 });
});

// Tap tempo: média dos últimos intervalos (uma pausa de mais de 2 s recomeça a contagem).
let taps: number[] = [];
$('#tap').addEventListener('click', () => {
  const t = performance.now();
  if (taps.length && t - taps[taps.length - 1] > 2000) taps = [];
  taps.push(t);
  taps = taps.slice(-5);
  const tap = $('#tap');
  tap.classList.remove('flash');
  void tap.offsetWidth; // reinicia a animação
  tap.classList.add('flash');
  if (taps.length < 2) return;
  const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
  setRhythm({ bpm: Math.max(40, Math.min(200, Math.round(60000 / avg))) });
});

renderRhythm();
renderTimbres();
render();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
