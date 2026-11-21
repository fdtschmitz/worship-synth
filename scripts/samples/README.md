# Preparo das amostras de orquestra

Gera `public/samples/strings/` a partir do VSCO 2 CE (CC0). Só é preciso rodar de novo para trocar ou adicionar notas.

1. `python -I fetch.py <pasta-destino> ViolinEnsSusVib-Quiet.xrni ViolaEnsSusVib-Quiet.xrni CelloEnsSusVib-Quiet.xrni ContrabassSusVB-Quiet.xrni`
   baixa só esses instrumentos do zip oficial (~43 MB de 777 MB), por requisições parciais.
2. `node build-samples.mjs <pasta-destino> ../../public/samples/strings`
   escolhe as notas (lista `PICK`), corta em 5 s, normaliza e gera MP3 + `manifest.json`.
   Requer `playwright-core` (usa o Edge para decodificar FLAC) e `@breezystack/lamejs`, instalados à parte.

Os pontos de loop não ficam no arquivo: o app aplica o crossfade depois de decodificar (`src/samples.ts`).
