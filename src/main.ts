import './style.css';
import { PadEngine, type PadSettings } from './audio';
import { CHORDS, NOTE_NAMES, SPECIAL_TYPES, chordLabel, padVoicing, type ChordType } from './chords';
import { TIMBRES, timbreById } from './timbres';

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
const ui = load('ui', { tab: 'maj' as Tab, special: 'sus2' as ChordType });
let sequence: Step[] = (() => {
  try {
    return JSON.parse(localStorage.getItem('sequence') || '[]');
  } catch {
    return [];
  }
})();

const engine = new PadEngine(settings);
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
  if (!timbreById(settings.timbre).samples || engine.samplesReady) return;
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
  // Se algo está tocando, faz crossfade do mesmo acorde para o novo timbre.
  if (activeKey && settings.timbre === id) {
    const [r, t] = activeKey.split(':');
    const { body, shimmer } = padVoicing(Number(r), t as ChordType);
    engine.stop(activeKey);
    engine.start(activeKey, body, shimmer);
  }
}

async function toggle(step: Step) {
  await engine.unlock();
  await prepareSamples();
  const key = keyOf(step);
  if (activeKey === key) {
    engine.stop(key);
    activeKey = null;
  } else {
    if (activeKey) engine.stop(activeKey); // crossfade: um sai enquanto o outro entra
    const { body, shimmer } = padVoicing(step.root, step.type);
    engine.start(key, body, shimmer);
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
  <main id="view"></main>
  <footer class="bottom">
    <button id="stop" class="ghost">■ Parar</button>
    <span id="now" class="now">—</span>
    <button id="open-settings" class="ghost" aria-label="Configurações">⚙︎</button>
  </footer>
  <div id="sheet" class="sheet" hidden>
    <div class="sheet-panel">
      <div class="sheet-head"><h2>Configurações</h2><button id="close-settings" class="ghost">Fechar</button></div>
      <div class="field-label">Timbre</div>
      <div class="chips" id="timbres"></div>
      <p class="hint" id="timbre-hint" hidden></p>
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
      `<button class="chip ${t.id === settings.timbre ? 'on' : ''}" data-timbre="${t.id}">${t.name}${t.warning ? ' <span class="warn-mark">⚠︎</span>' : ''}</button>`,
  ).join('');
  const t = timbreById(settings.timbre);
  const hint = $('#timbre-hint');
  hint.hidden = !t.warning;
  if (t.warning) {
    const mb = engine.samplesBytes / 1e6;
    hint.textContent = `⚠︎ ${t.warning}${mb ? ` Em uso agora: ${Math.round(mb)} MB.` : ''}`;
  }
}

$('#timbres').addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-timbre]');
  const id = b?.dataset.timbre;
  if (!id || id === settings.timbre) return;
  const t = timbreById(id);
  if (t.warning && !localStorage.getItem('samplesWarned')) {
    if (!confirm(`${t.warning}\n\nDeseja continuar?`)) return;
    save('samplesWarned', true);
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

renderTimbres();
render();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
