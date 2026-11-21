// Gera os ícones PNG a partir de icon-source.svg (o iOS não aceita SVG na tela inicial).
// Uso: node build-icons.cjs   (requer playwright-core e o Microsoft Edge instalados)
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const svg = fs.readFileSync(path.join(__dirname, 'icon-source.svg'), 'utf8');
const SIZES = { 'apple-touch-icon.png': 180, 'icon-192.png': 192, 'icon-512.png': 512 };

(async () => {
  const outDir = path.join(root, 'public', 'icons');
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  for (const [file, size] of Object.entries(SIZES)) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<body style="margin:0"><div style="width:${size}px;height:${size}px">${svg}</div></body>`);
    await page.screenshot({ path: path.join(outDir, file), omitBackground: false });
    await page.close();
    console.log(file, size);
  }
  fs.copyFileSync(path.join(__dirname, 'icon-source.svg'), path.join(root, 'public', 'icon.svg'));
  await browser.close();
})();
