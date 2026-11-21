// Prepara as amostras de cordas (VSCO 2 CE, CC0) para o app.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { Mp3Encoder } = await import('@breezystack/lamejs');

const [vscoDir, outDir] = process.argv.slice(2);
// instrumento -> notas MIDI (BaseNote do Instrument.xml)
const PICK = {
  ContrabassSusVB: [30, 34, 38, 42],
  CelloEnsSusVib: [36, 40, 43, 47],
  ViolaEnsSusVib: [48, 52, 55, 59, 62, 65],
  ViolinEnsSusVib: [66, 69, 72, 76, 79, 83],
};
const SHORT = { ContrabassSusVB: 'bass', CelloEnsSusVib: 'cello', ViolaEnsSusVib: 'viola', ViolinEnsSusVib: 'violin' };

function mapping(dir) {
  const xml = fs.readFileSync(path.join(dir, 'Instrument.xml'), 'utf8');
  const out = {};
  for (const m of xml.matchAll(/<Sample>[\s\S]*?<Name>([^<]+)<\/Name>[\s\S]*?<BaseNote>(\d+)<\/BaseNote>/g)) {
    if (!(m[2] in out)) out[m[2]] = m[1];
  }
  return out;
}

fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage();
const manifest = [];

for (const [inst, notes] of Object.entries(PICK)) {
  const dir = path.join(vscoDir, inst + '-Quiet');
  const map = mapping(dir);
  const files = fs.readdirSync(path.join(dir, 'SampleData'));
  for (const note of notes) {
    const name = map[note];
    const file = files.find((f) => f.includes(`(${name})`));
    if (!file) throw new Error(`sem amostra ${inst} ${note}`);
    const b64 = fs.readFileSync(path.join(dir, 'SampleData', file)).toString('base64');
    const r = await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const ctx = new OfflineAudioContext(2, 1, 44100);
      const buf = await ctx.decodeAudioData(bytes.buffer);
      const sr = buf.sampleRate;
      const chs = [0, 1].map((c) => buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)));
      let onset = 0;
      while (onset < buf.length && Math.abs(chs[0][onset]) < 0.003 && Math.abs(chs[1][onset]) < 0.003) onset++;
      const start = Math.max(0, onset - Math.floor(0.01 * sr));
      const len = Math.min(buf.length - start, Math.floor(5 * sr));
      // RMS do trecho sustentado (após o ataque) para normalizar
      let sum = 0, n = 0;
      for (let i = start + sr; i < start + len; i++) { sum += chs[0][i] ** 2 + chs[1][i] ** 2; n += 2; }
      const rms = Math.sqrt(sum / n);
      let gain = Math.pow(10, -18 / 20) / rms;
      let peak = 0;
      for (const ch of chs) for (let i = start; i < start + len; i++) peak = Math.max(peak, Math.abs(ch[i]));
      gain = Math.min(gain, 0.95 / peak);
      const fadeLen = Math.floor(0.02 * sr);
      const out = chs.map((ch) => {
        const o = new Int16Array(len);
        for (let i = 0; i < len; i++) {
          const f = i > len - fadeLen ? (len - i) / fadeLen : 1;
          o[i] = Math.max(-32767, Math.min(32767, Math.round(ch[start + i] * gain * f * 32767)));
        }
        let s = ''; const u8 = new Uint8Array(o.buffer);
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
        return btoa(s);
      });
      return { out, dur: buf.duration, used: len / sr, gainDb: 20 * Math.log10(gain) };
    }, b64);
    const [L, R] = r.out.map((s) => new Int16Array(new Uint8Array(Buffer.from(s, 'base64')).buffer));
    const enc = new Mp3Encoder(2, 44100, 112);
    const chunks = [];
    for (let i = 0; i < L.length; i += 1152) {
      const c = enc.encodeBuffer(L.subarray(i, i + 1152), R.subarray(i, i + 1152));
      if (c.length) chunks.push(Buffer.from(c));
    }
    chunks.push(Buffer.from(enc.flush()));
    const outName = `${SHORT[inst]}-${note}.mp3`;
    fs.writeFileSync(path.join(outDir, outName), Buffer.concat(chunks));
    manifest.push({ file: outName, note });
    console.log(`${outName.padEnd(16)} original ${r.dur.toFixed(1)}s  usado ${r.used.toFixed(1)}s  ganho ${r.gainDb.toFixed(1)} dB`);
  }
}
manifest.sort((a, b) => a.note - b.note);
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
await browser.close();
