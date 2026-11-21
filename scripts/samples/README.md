# Preparo das amostras de orquestra

Gera `public/samples/<conjunto>/` (strings, organ, horn, flute, piano) a partir do VSCO 2 CE (CC0). Só é preciso rodar de novo para trocar ou adicionar notas.

1. `python -I fetch.py <pasta-destino> ViolinEnsSusVib-Quiet.xrni ViolaEnsSusVib-Quiet.xrni CelloEnsSusVib-Quiet.xrni ContrabassSusVB-Quiet.xrni OrganQuiet.xrni FHornSus.xrni FluteSusNV.xrni UprightPiano.xrni`
   baixa só esses instrumentos do zip oficial (777 MB no total), por requisições parciais.
2. `node build-samples.mjs <pasta-destino> ../../public/samples [conjunto...]`
   escolhe as notas (objeto `SETS`), usa a camada de dinâmica mais suave, corta, normaliza e gera MP3 + `manifest.json`.
   Requer `playwright-core` (usa o Edge para decodificar FLAC) e `@breezystack/lamejs`, instalados à parte.

Os pontos de loop e o tempo de ataque não ficam no arquivo: o app calcula os dois depois de decodificar (`src/samples.ts`).
