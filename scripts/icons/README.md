# Ícones do app

O logo "WS" usa a fonte Inter semibold (SIL Open Font License), convertida em contornos.

1. `node ws-logo.cjs 600 icon-source.svg`: gera o desenho (requer `opentype.js` e `@fontsource/inter`).
2. `node build-icons.cjs`: gera os PNGs em `public/icons/` e copia o SVG para `public/icon.svg`
   (requer `playwright-core` e o Microsoft Edge).

O iOS só aceita PNG na tela inicial (`apple-touch-icon.png`, 180 px).
