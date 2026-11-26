# Como o WeatherCenter detecta e prevê eventos adversos

O WeatherCenter tem um sistema próprio, automático, que gera alertas com a fonte **WeatherCenter**.
Eles aparecem no app junto com os avisos oficiais (INMET, Defesa Civil, Marinha), com o selo
**"automático, não oficial"** e contorno tracejado no mapa.

> **Importante:** são alertas gerados por computador, sem um meteorologista revisando. Servem para
> você ficar atento mais cedo. Eles **não substituem** os avisos oficiais: siga sempre a Defesa Civil
> (199) e o INMET.

## As quatro partes

| Parte | O que olha | Antecedência | Atualização |
|---|---|---|---|
| **Raios por satélite** (GOES-19, sensor GLM) | Todas as tempestades com raios do Brasil, inclusive onde não há radar | 0 a 60 min | a cada ~5 min (dados com ~1 min de atraso) |
| **Radar** (mosaico RainViewer) | Núcleos de chuva muito forte e granizo | 0 a 60 min | a cada 10 min |
| **Aeroportos** (METAR/SPECI, ~150 estações) | Vento forte, granizo, tornado/nuvem funil e trovoada forte já acontecendo | agora | a cada ~5 min |
| **Previsão** (modelos GFS da NOAA e IFS do ECMWF) | Chuva, vento, temporais e ambiente para tornado | até 48 h | 4 rodadas por dia de cada modelo, verificado a cada 30 min |

### 1. Tempestades pelos raios (nowcasting)

1. Os raios dos últimos 10 minutos são somados numa grade de 0,05° (~5,5 km).
2. **Tempestade** = área ligada com pelo menos 10 raios em 10 min num quadrado de ~27 km.
3. **Deslocamento**: compara a posição dos raios de 10 em 10 minutos (correlação) e mistura com o vento
   médio entre 850 e 500 hPa dos modelos (as tempestades andam a ~80% desse vento). Também suaviza com a
   velocidade medida na execução anterior.
4. **Salto de raios** (*lightning jump*, Schultz et al. 2009, método 2σ): taxa de raios em blocos de 2 min
   nos últimos 30 min; salto = aumento recente maior que 2 desvios-padrão dos 10 min anteriores, com pelo
   menos 10 raios/min. Costuma anteceder granizo, vendaval e tornado em 10 a 30 min.
5. **Caminho**: a área ativa da tempestade é arrastada pelos próximos 60 min, de 5 em 5 min, crescendo
   25% da distância percorrida (incerteza). As cidades no caminho recebem o horário estimado de chegada.

**Classificação** (densidade de raios = raios/min no núcleo de ~27 km):

| Nível | Critério |
|---|---|
| Moderado | 6 raios/min ou mais |
| Severo | 15 raios/min ou mais; ou salto de raios com 9 ou mais |
| Extremo | 30 raios/min ou mais **e** (ambiente organizado: cisalhamento 0-6 km ≥ 15 m/s ou SCP ≥ 2, ou salto de raios); ou severo num ambiente de supercélula/tornado (SCP ≥ 4 ou STP ≥ 1) |

- Radar com 60 dBZ ou mais dentro da tempestade sobe um nível (granizo provável); 50 dBZ garante pelo menos moderado.
- Tempestade severa ou extrema num ambiente com STP ≥ 1 (ou SCP ≥ 4 com salto de raios) vira
  **"Tempestade severa com risco de tornado"**.
- O nível fica mantido por 15 min depois do pico, para o alerta não piscar.

### 2. Radar

- Usa a cor de cada pixel da imagem para estimar a refletividade (±2 dBZ): 40 dBZ = chuva forte,
  50 = muito forte, 60 = granizo provável.
- **Ecos fixos** (morros, prédios e o próprio radar aparecem sempre no mesmo lugar) são aprendidos
  automaticamente: célula com eco forte em quase todas as imagens recentes é ignorada.
- Alerta só de radar (sem raios): núcleo de 50 dBZ ou mais, maior que ~120 km², que esteja se movendo.
  Moderado; severo se passar de 58 dBZ.

### 3. Aeroportos

| Observado | Nível |
|---|---|
| Rajada 60-80 km/h / 80-100 / acima de 100 | moderado / severo / extremo |
| Granizo (GR) ou linha de instabilidade (SQ) | severo |
| Nuvem funil ou tornado (FC) | extremo |
| Trovoada forte (+TS) | moderado |

Alerta num raio de 30 km da estação, válido por 90 min.

### 4. Previsão de 48 h (consenso de modelos)

A cada rodada nova, baixamos só os campos necessários do GFS (0,25°) e do IFS/ECMWF (0,25°) a cada 3 h
até 48 h e calculamos, em cada ponto (~27 km):

- **Chuva**: acumulado em 3 h e em 24 h.
- **Rajadas** de vento.
- **CAPE** (instabilidade), **cisalhamento 0-6 km** (diferença do vento entre 10 m e 500 hPa),
  **helicidade 0-3 km** (SRH, relativa ao movimento de Bunkers da supercélula ciclônica do hemisfério sul,
  calculada igual para os dois modelos), **altura da base da nuvem** (LCL), **CIN** e isoterma de 0 °C (GFS).
- **SCP** (índice de supercélula) = (CAPE/1000) × (SRH/50) × (cisalhamento/20).
- **STP** (índice de tornado significativo, camada fixa) = (CAPE de superfície/1500) × fator da base da nuvem
  × (SRH/200) × (cisalhamento/20) × fator do CIN.
- **Convecção prevista**: refletividade simulada ≥ 40 dBZ (GFS) ou chuva de 5-6 mm em 3 h com CAPE ≥ 300,
  com tolerância de ±50 km de posição.

Os limiares seguem as faixas do INMET; onde o modelo representa a média de uma área de ~27 km, o limiar
fica no meio da faixa:

| Evento | Moderado (Perigo Potencial) | Severo (Perigo) | Extremo (Grande Perigo) |
|---|---|---|---|
| Chuva | ≥ 50 mm/24 h ou ≥ 25 mm/3 h | ≥ 80 mm/24 h ou ≥ 40 mm/3 h | ≥ 120 mm/24 h, ≥ 180 mm/48 h ou ≥ 60 mm/3 h |
| Vento | rajadas ≥ 60 km/h | ≥ 80 km/h | ≥ 100 km/h |
| Tempestade | convecção + CAPE ≥ 800 + cisalhamento ≥ 10 m/s | convecção + CAPE ≥ 1500 + cisalhamento ≥ 15 m/s + SCP ≥ 1 (ou CAPE ≥ 2500 + cisalhamento ≥ 12) | convecção + CAPE ≥ 2000 + cisalhamento ≥ 20 m/s + SCP ≥ 4 |
| Tornado (ambiente favorável) | convecção + STP ≥ 0,5; ou pouca instabilidade e muito cisalhamento (CAPE ≥ 250, cisalhamento ≥ 25 m/s, SRH ≥ 150, base ≤ 1000 m), comum no Sul | convecção + STP ≥ 1 + SCP ≥ 2 | convecção + STP ≥ 3 + SCP ≥ 6 |

**Consenso**: com os dois modelos, vale o menor nível, ou o maior menos um (o que for mais alto). Um
evento extremo num modelo e nada no outro vira severo; um moderado que só um modelo vê é descartado.
Se só um modelo estiver disponível, ele é usado sozinho e o alerta diz "confiança média".

**Áreas**: os pontos são agrupados em eventos ligados no espaço e no tempo, em períodos de até 12 h
(9h-21h e 21h-9h de Brasília). Cada cidade aparece só no alerta do maior nível que a atinge; o desenho de
um nível inclui as áreas dos níveis acima, como nos avisos do INMET.

## Testes com casos reais

Os scripts em `detector/testes/` repetem o sistema num dia passado, como se rodasse naquela hora:

```
python3 detector/testes/caso_raios.py 2025-11-07T19:30Z 2025-11-07T22:30Z -25.49 -52.53
python3 detector/testes/caso_modelos.py 2025-11-07T15:00Z -25.49 -52.53
```

Resultados em [testes/RESULTADOS.md](testes/RESULTADOS.md).

## Limitações

- **Não é aviso oficial** e não tem revisão humana. Pode haver alarmes falsos e eventos não detectados.
- **Tornados** não podem ser vistos diretamente por satélite nem pelo radar disponível. O sistema indica
  ambiente favorável e tempestades com sinais de severidade; a maioria dos alertas de "risco de tornado"
  não terá tornado.
- **Modelos** globais (~27 km) não representam bem chuva localizada e subestimam picos; em vales e serras
  a chuva real pode ser bem maior (ex.: Vale do Taquari em 2024).
- **Raios**: o GLM detecta ~70-90% dos raios; tempestades fortes com poucos raios (comuns no inverno do
  Sul) podem passar como moderadas.
- **Radar**: a cobertura no Brasil tem buracos (Norte, parte do Nordeste e do Centro-Oeste) e a
  refletividade é estimada pela cor da imagem.
- **Horários**: o GitHub Actions roda a cada ~5 min, mas em horários de pico pode atrasar.
- **Aeroportos**: ~150 estações, muito espaçadas; o INMET tem centenas de estações automáticas, mas a API
  exige cadastro.

## Fontes de dados (todas gratuitas, sem chave)

- GOES-19 GLM L2 (NOAA, AWS Open Data: `noaa-goes19`)
- GFS 0,25° (NOAA, AWS Open Data: `noaa-gfs-bdp-pds`)
- ECMWF IFS open data 0,25° (CC BY 4.0, AWS: `ecmwf-forecasts`, e data.ecmwf.int)
- RainViewer (API pública)
- METAR/SPECI (aviationweather.gov, NOAA)
- Municípios: IBGE (códigos e sedes via kelvins/municipios-brasileiros)
