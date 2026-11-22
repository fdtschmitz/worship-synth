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
- `src/timbres.ts`: definição dos timbres (sintetizados: Pad clássico, Cordas etéreas, Atmosfera; gravados: Orquestra, Órgão, Trompas, Piano, Flauta)
- `src/sequencer.ts`: modos Dedilhado e Arpejo (padrão 4/4, notas, oitavas, direção)
- `src/samples.ts`: carregamento das amostras gravadas e loop sem emenda
- `src/main.ts`: interface (abas, grade de 12 pads, sequência, configurações)
- `public/`: manifest, ícone e service worker (offline)
- `public/samples/`: amostras do VSCO 2 CE (CC0) para os timbres gravados. Veja `scripts/samples/` para regerar.

Os timbres gravados são opcionais: cada um baixa de 0,6 a 1,5 MB na primeira vez e ocupa de 16 a 40 MB de memória, só enquanto está selecionado. Os timbres sintetizados não carregam nada. O piano não usa loop: cada nota decai naturalmente, por isso ele brilha mais nos modos Dedilhado e Arpejo.

## Modos de execução

- **Pad**: o acorde sustentado, com fade in/out.
- **Dedilhado**: o acorde quebrado em colcheias, num compasso 4/4 (baixo, quinta, oitava, terça, nota aguda e volta).
- **Arpejo**: notas do acorde em sequência, com escolha de quantas notas (tônica, 3ª, 5ª, 7ª, 9ª, 11ª/13ª), oitavas, direção e figura rítmica.

O tempo é ajustado por slider ou pelo botão TAP. Nos modos rítmicos, o padrão começa no instante do toque.

## Observações para celular

- Instale na tela inicial ("Adicionar à Tela de Início") para abrir em tela cheia.
- O iOS só libera o áudio após o primeiro toque. No iOS 17+ o app toca mesmo com a chave de silencioso ligada.
- A tela é mantida acesa enquanto um pad toca (Wake Lock API).
- Uso offline: em Configurações → "Uso offline", os timbres gravados podem ser baixados de uma vez (~5 MB). Eles ficam num cache próprio, e o app pede armazenamento permanente ao navegador. Se o sistema encerrar a aba para liberar memória, as amostras são recarregadas do aparelho ao voltar, sem internet.
- No iPhone, dados de sites podem ser apagados após 7 dias sem uso; apps instalados na tela inicial não têm esse limite.
