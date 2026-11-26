# Testes com casos reais

Cada teste roda o detector com os dados reais daquele dia, **como se fosse aquela hora** (só usa
rodadas de modelo que já estariam publicadas e raios até o momento simulado).

## 1. Tornado de Rio Bonito do Iguaçu (PR), 07/11/2025

Tornado F3 (300-330 km/h segundo o Simepar) por volta das **18h**; no mesmo dia, tornados F2 em
Guarapuava (Entre Rios) e Turvo.

**Raios por satélite** (`caso_raios.py 2025-11-07T19:30Z 2025-11-07T22:30Z -25.49 -52.53`, a cada 10 min):

| Hora (Brasília) | Situação de Rio Bonito do Iguaçu |
|---|---|
| 16h30 | dentro de alerta **moderado** ("tempestade com muitos raios se aproximando"; chegada estimada às 17h00) |
| 16h50 | **extremo – tempestade severa com risco de tornado** (salto de raios + ambiente de supercélula) |
| 17h00-19h30 | extremo mantido; a tempestade seguinte (que passou por Guarapuava) também em extremo com risco de tornado |
| ~18h00 | tornado atinge a cidade |

Antecedência do alerta extremo: **~70 min**. No país inteiro, nesse período, houve de 3 a 8 alertas
extremos ao mesmo tempo, quase todos no oeste do PR e de SC (onde houve os tornados e muitos vendavais).

**Previsão** (`caso_modelos.py 2025-11-07T15:00Z -25.49 -52.53`, só GFS 06z): ao meio-dia, a cidade estava
em "condições favoráveis a tornado" (moderado) e havia áreas **severas** a oeste (Frederico Westphalen,
Itapiranga) e em Ipuaçu/Entre Rios (SC) para 16h30-19h30. Ambiente no local: CAPE 417 J/kg, cisalhamento
0-6 km de 110 km/h, helicidade 277 m²/s², SCP 3,2 — o típico ambiente de pouca instabilidade e muito
cisalhamento do Sul, que o critério extra "HSLC" foi feito para pegar.

## 2. Ciclone extratropical e enxurrada de Caraá (RS), 15-16/06/2023

`caso_modelos.py 2023-06-15T12:00Z -29.79 -50.43` (só GFS): na véspera, a região de Caraá e da Grande Porto
Alegre ficou em **chuva extrema** para a noite de 15 e o dia 16 (41 municípios), com severo e moderado em
volta, e vento moderado no litoral norte. Acertou o local e o período da enxurrada.

## 3. Chuvas de maio de 2024 no RS

`caso_modelos.py 2024-04-30T12:00Z -29.46 -51.96` (Lajeado, só GFS): a previsão marcou chuva **severa a
extrema** no centro do RS e na Grande Porto Alegre para 1º e 2 de maio (Santa Maria, Porto Alegre, Canoas),
mas **não pôs o Vale do Taquari em extremo** naquela rodada. É a limitação esperada de modelos globais de
~27 km em vales e serras; por isso o sistema também usa radar, raios e observações, e por isso os avisos
oficiais continuam indispensáveis.

## 4. Dia comum (teste de alarme falso)

Execução ao vivo em 26/11/2026, 19h50 (Brasília): 9 tempestades com alerta no país (7 moderadas e 2
severas: Candeias do Jamari/RO e Santa Vitória/MG), nenhuma extrema. Numa versão anterior, o radar sozinho
gerou 5 alertas de "chuva muito forte" que, conferindo a última hora de imagens, eram ecos fixos (perto do
radar de São Luís e no ES, sempre no mesmo lugar). Por isso o radar agora aprende os ecos fixos e só emite
alerta sozinho depois de ~6 execuções de histórico, para núcleos que estejam se movendo.

## Como repetir

```
pip install -r detector/requirements.txt
python3 detector/testes/caso_raios.py INICIO FIM [lat lon]     # ex.: 2025-11-07T19:30Z 2025-11-07T22:30Z -25.49 -52.53
python3 detector/testes/caso_modelos.py HORA [lat lon]         # ex.: 2025-11-07T15:00Z -25.49 -52.53
```

Variáveis úteis: `DETECTOR_MODELOS=gfs` (só um modelo), `COM_MODELOS=1` (raios com o ambiente do modelo),
`PASSO_MIN=10` (intervalo entre execuções simuladas), `SO_ALVO=1` (mostra só os alertas do ponto).
