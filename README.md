# Worship Pad

Web app (PWA) para tocar pads de acordes no estilo worship. O som é sintetizado no próprio aparelho via Web Audio API. Não há backend nem arquivos de áudio.

## Rodar

```bash
npm install
npm run dev       # abre em http://localhost:5173 (e na rede local, para testar no celular)
npm run build     # gera /dist (estático, pode ser hospedado em qualquer lugar com HTTPS)
```

## Estrutura

- `src/audio.ts`: motor de som (osciladores desafinados, filtro com LFO, camada shimmer, reverb por convolução, fades equal-power)
- `src/chords.ts`: tipos de acorde e voicings
- `src/main.ts`: interface (abas, grade de 12 pads, sequência, configurações)
- `public/`: manifest, ícone e service worker (offline)

## Observações para celular

- Instale na tela inicial ("Adicionar à Tela de Início") para abrir em tela cheia.
- O iOS só libera o áudio após o primeiro toque. No iOS 17+ o app toca mesmo com a chave de silencioso ligada.
- A tela é mantida acesa enquanto um pad toca (Wake Lock API).
