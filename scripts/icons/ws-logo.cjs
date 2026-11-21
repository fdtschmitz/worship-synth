// Gera o SVG do logo "WS" com a fonte Inter convertida em contornos (sem depender de fonte instalada).
const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');

const [weight, out] = process.argv.slice(2);
const fontFile = require.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff`);
const font = opentype.parse(fs.readFileSync(fontFile).buffer);

const CAP = 164; // altura das maiúsculas no ícone de 512 px
const size = CAP / (font.tables.os2.sCapHeight / font.unitsPerEm);
const scale = size / font.unitsPerEm;
const tracking = -0.02 * size; // levemente mais justo, como no estilo da Apple

const glyphs = font.stringToGlyphs('WS');
const full = new opentype.Path();
let x = 0;
glyphs.forEach((g, i) => {
  full.extend(g.getPath(x, 0, size));
  const kern = i < glyphs.length - 1 ? font.getKerningValue(g, glyphs[i + 1]) * scale : 0;
  x += g.advanceWidth * scale + kern + tracking;
});

// Centraliza no quadro de 512 px
const bb = full.getBoundingBox();
const dx = 256 - (bb.x1 + bb.x2) / 2;
const dy = 256 - (bb.y1 + bb.y2) / 2;
for (const c of full.commands) {
  for (const k of ['x', 'y', 'x1', 'y1', 'x2', 'y2']) {
    if (c[k] === undefined) continue;
    c[k] += k.startsWith('x') ? dx : dy;
  }
}
const d = full.toPathData(1);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <!-- Fundo preto rosado: brilho rosa suave no centro, quase preto nas bordas -->
    <radialGradient id="bg" cx="50%" cy="42%" r="75%">
      <stop offset="0" stop-color="#3d1430"/>
      <stop offset="0.55" stop-color="#1e0a19"/>
      <stop offset="1" stop-color="#0d050b"/>
    </radialGradient>
    <linearGradient id="ink" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff0f6"/>
      <stop offset="1" stop-color="#ffb3d4"/>
    </linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="9" result="b"/>
      <feComponentTransfer in="b" result="soft"><feFuncA type="linear" slope="0.55"/></feComponentTransfer>
      <feMerge><feMergeNode in="soft"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <!-- "WS" em Inter ${weight} (SIL Open Font License), convertido em contornos -->
  <path fill="url(#ink)" filter="url(#glow)" d="${d}"/>
</svg>
`;
fs.writeFileSync(out, svg);
console.log(`ok: largura ${(bb.x2 - bb.x1).toFixed(0)} px, altura ${(bb.y2 - bb.y1).toFixed(0)} px`);
