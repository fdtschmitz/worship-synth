// Prepara as amostras de cordas (VSCO 2 CE, CC0) para o app.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { Mp3Encoder } = await import('@breezystack/lamejs');

const [vscoDir, samplesDir, ...only] = process.argv.slice(2);
const range = (a, b, step) => Array.from({ length: Math.floor((b - a) / step) + 1 }, (_, i) => a + i * step);
// conjunto -> pasta do instrumento (dentro de vscoDir) -> [apelido, notas MIDI (BaseNote)]
const SETS = {
  strings: {
    seconds: 5,
    inst: {
      'ContrabassSusVB-Quiet': ['bass', [30, 34, 38, 42]],
      'CelloEnsSusVib-Quiet': ['cello', [36, 40, 43, 47]],
      'ViolaEnsSusVib-Quiet': ['viola', [48, 52, 55, 59, 62, 65]],
      'ViolinEnsSusVib-Quiet': ['violin', [66, 69, 72, 76, 79, 83]],
    },
  },
  organ: { seconds: 4, inst: { OrganQuiet: ['organ', range(36, 84, 3)] } },
  horn: { seconds: 5, inst: { FHornSus: ['horn', [33, 36, 39, 43, 46, 50, 53, 57, 60, 74, 77]] } },
  flute: { seconds: 5, inst: { FluteSusNV: ['flute', [60, 64, 69, 72, 76, 81, 84, 88]] } },
  // Piano: a nota decai sozinha (sem loop). Graves soam mais tempo; fim com fade longo.
  piano: {
    seconds: (note) => (note < 45 ? 7 : note < 69 ? 6 : 4.5),
    fade: 1.2,
    norm: 'peak',
    layer: 'dyn2', // mf
    inst: { UprightPiano: ['piano', range(29, 97, 4)] },
  },
};

function mapping(dir, layer) {
  const xml = fs.readFileSync(path.join(dir, 'Instrument.xml'), 'utf8');
  const out = {};
  const best = {};
  for (const block of xml.split('<Sample>').slice(1)) {
    const name = block.match(/<Name>([^<]+)<\/Name>/)?.[1];
    const note = block.match(/<BaseNote>(\d+)<\/BaseNote>/)?.[1];
    const vel = Number(block.match(/<VelocityStart>(\d+)<\/VelocityStart>/)?.[1] ?? 0);
    if (!name || !note || (layer && !name.includes(layer))) continue;
    if (!(note in best) || vel < best[note]) { best[note] = vel; out[note] = name; } // camada mais suave
  }
  return out;
}

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage();

for (const [set, cfg] of Object.entries(SETS)) {
  if (only.length && !only.includes(set)) continue;
  const outDir = path.join(samplesDir, set);
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = [];
for (const [inst, [short, notes]] of Object.entries(cfg.inst)) {
  const dir = path.join(vscoDir, inst);
  const map = mapping(dir, cfg.layer);
  const files = fs.readdirSync(path.join(dir, 'SampleData'));
  for (const note of notes) {
    const name = map[note];
    const file = files.find((f) => f.includes(`(${name})`));
    if (!file) throw new Error(`sem amostra ${inst} ${note}`);
    const b64 = fs.readFileSync(path.join(dir, 'SampleData', file)).toString('base64');
    const seconds = typeof cfg.seconds === 'function' ? cfg.seconds(note) : cfg.seconds;
    const r = await page.evaluate(async ([b64, seconds, fadeSec, norm]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const ctx = new OfflineAudioContext(2, 1, 44100);
      const buf = await ctx.decodeAudioData(bytes.buffer);
      const sr = buf.sampleRate;
      const chs = [0, 1].map((c) => buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)));
      let onset = 0;
      while (onset < buf.length && Math.abs(chs[0][onset]) < 0.003 && Math.abs(chs[1][onset]) < 0.003) onset++;
      const start = Math.max(0, onset - Math.floor(0.01 * sr));
      const len = Math.min(buf.length - start, Math.floor(seconds * sr));
      // RMS do trecho sustentado (após o ataque) para normalizar
      let sum = 0, n = 0;
      for (let i = start + sr; i < start + len; i++) { sum += chs[0][i] ** 2 + chs[1][i] ** 2; n += 2; }
      const rms = Math.sqrt(sum / n);
      let peak = 0;
      for (const ch of chs) for (let i = start; i < start + len; i++) peak = Math.max(peak, Math.abs(ch[i]));
      let gain = norm === 'peak' ? 0.9 / peak : Math.pow(10, -18 / 20) / rms;
      gain = Math.min(gain, 0.95 / peak);
      const fadeLen = Math.floor(fadeSec * sr);
      const out = chs.map((ch) => {
        const o = new Int16Array(len);
        for (let i = 0; i < len; i++) {
          const f = i > len - fadeLen ? Math.pow((len - i) / fadeLen, 2) : 1;
          o[i] = Math.max(-32767, Math.min(32767, Math.round(ch[start + i] * gain * f * 32767)));
        }
        let s = ''; const u8 = new Uint8Array(o.buffer);
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
        return btoa(s);
      });
      return { out, dur: buf.duration, used: len / sr, gainDb: 20 * Math.log10(gain) };
    }, [b64, seconds, cfg.fade ?? 0.02, cfg.norm ?? 'rms']);
    const [L, R] = r.out.map((s) => new Int16Array(new Uint8Array(Buffer.from(s, 'base64')).buffer));
    const enc = new Mp3Encoder(2, 44100, 112);
    const chunks = [];
    for (let i = 0; i < L.length; i += 1152) {
      const c = enc.encodeBuffer(L.subarray(i, i + 1152), R.subarray(i, i + 1152));
      if (c.length) chunks.push(Buffer.from(c));
    }
    chunks.push(Buffer.from(enc.flush()));
    const outName = `${short}-${note}.mp3`;
    fs.writeFileSync(path.join(outDir, outName), Buffer.concat(chunks));
    manifest.push({ file: outName, note });
    console.log(`${outName.padEnd(16)} original ${r.dur.toFixed(1)}s  usado ${r.used.toFixed(1)}s  ganho ${r.gainDb.toFixed(1)} dB`);
  }
}
  manifest.sort((a, b) => a.note - b.note);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
}
await browser.close();
