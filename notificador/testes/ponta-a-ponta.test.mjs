// Teste de ponta a ponta sem internet: Supabase falso + serviço de push falso que
// descriptografa a mensagem como o celular faria (RFC 8291) e confere a assinatura VAPID.
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

// "Celular": par de chaves e segredo auth
function aparelho() {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  return { ecdh, p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
}
function descriptografar(corpo, ap) {
  const sal = corpo.subarray(0, 16), idlen = corpo[20], asPub = corpo.subarray(21, 21 + idlen), cif = corpo.subarray(21 + idlen);
  const segredo = ap.ecdh.computeSecret(asPub);
  const ikm = hmac(hmac(Buffer.from(ap.auth, 'base64url'), segredo), Buffer.concat([Buffer.from('WebPush: info\0'), ap.ecdh.getPublicKey(), asPub, Buffer.from([1])]));
  const prk = hmac(sal, ikm);
  const d = crypto.createDecipheriv('aes-128-gcm', hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12));
  d.setAuthTag(cif.subarray(-16));
  const claro = Buffer.concat([d.update(cif.subarray(0, -16)), d.final()]);
  assert.equal(claro[claro.length - 1], 2);
  return JSON.parse(claro.subarray(0, -1).toString());
}

const vapidPriv = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }).d;
const bancos = { wc_enviados: [], wc_inscricoes: [] };
const recebidas = {};
const apar = { borja: aparelho(), sp: aparelho(), velho: aparelho(), exigente: aparelho() };

const srv = http.createServer((req, res) => {
  let b = []; req.on('data', (c) => b.push(c)); req.on('end', () => {
    b = Buffer.concat(b);
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/push/')) {
      const nome = u.pathname.slice(6);
      if (nome === 'velho') { res.writeHead(410); return res.end(); }
      assert.match(req.headers.authorization, /^vapid t=.+, k=/);
      assert.equal(req.headers['content-encoding'], 'aes128gcm');
      (recebidas[nome] ||= []).push(descriptografar(b, apar[nome]));
      res.writeHead(201); return res.end();
    }
    assert.equal(req.headers.apikey, 'sb_secret_teste');
    const tabela = u.pathname.split('/').pop();
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(bancos[tabela])); }
    if (req.method === 'POST') { for (const r of JSON.parse(b)) if (!bancos[tabela].some((x) => x.chave === r.chave)) bancos[tabela].push({ ...r, enviado_em: new Date().toISOString() }); res.writeHead(201); return res.end(); }
    if (req.method === 'DELETE') {
      const ep = u.searchParams.get('endpoint');
      if (ep) bancos[tabela] = bancos[tabela].filter((x) => `eq.${x.endpoint}` !== ep);
      res.writeHead(204); return res.end();
    }
  });
});
await new Promise((ok) => srv.listen(0, ok));
const base = `http://127.0.0.1:${srv.address().port}`;
const ins = (nome, cidades, nivel_min = 1) => ({ endpoint: `${base}/push/${nome}`, p256dh: apar[nome].p256dh, auth: apar[nome].auth, cidades, nivel_min });
bancos.wc_inscricoes = [
  ins('borja', [{ id: '4318002', nome: 'São Borja', uf: 'RS', lat: -28.66, lon: -56.0 }]),
  ins('sp', [{ id: '3550308', nome: 'São Paulo', uf: 'SP', lat: -23.53, lon: -46.64 }]),
  ins('velho', [{ id: '3550308', nome: 'São Paulo', uf: 'SP', lat: -23.53, lon: -46.64 }]),
  ins('exigente', [{ id: '3550308', nome: 'São Paulo', uf: 'SP', lat: -23.53, lon: -46.64 }], 3),
];

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-'));
const fim = new Date(Date.now() + 86400e3).toISOString();
const quadrado = (lat, lon) => [[lat - .5, lon - .5], [lat - .5, lon + .5], [lat + .5, lon + .5], [lat + .5, lon - .5]];
const escrever = (alertas, inmet) => {
  fs.writeFileSync(path.join(pasta, 'alertas.json'), JSON.stringify({ alertas }));
  fs.writeFileSync(path.join(pasta, 'inmet.json'), JSON.stringify(inmet));
};
const rodar = async () => (await promisify(execFile)('node', [path.join(aqui, '..', 'enviar.mjs'), pasta], {
  env: { ...process.env, VAPID_PRIVATE_KEY: vapidPriv, SUPABASE_URL: base, SUPABASE_SECRET_KEY: 'sb_secret_teste', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_teste', GITHUB_STEP_SUMMARY: '' },
})).stdout;

const dcBorja = { id: 'defesa-civil-1', fonte: 'Defesa Civil', titulo: 'Inundações – São Borja/RS', severidade: 'Extrema', nivel: 3, fim, riscos: ['Defesa Civil:RS: Alerta VERMELHO: INUNDACAO do rio Uruguai.'], geocodes: [], estados: ['RS'], poligonos: [quadrado(-28.66, -56.0)], areaTexto: 'São Borja/RS' };
const marinha = { id: 'marinha-1', fonte: 'Marinha', titulo: 'Ressaca', nivel: 3, maritimo: true, fim, geocodes: [], poligonos: [quadrado(-23.53, -46.64)] };
const inmetSP = (sev) => ({ id: 777, descricao: 'Tempestade', severidade: sev, inicio: '2026-11-26 10:00', fim: '2099-11-27 10:00', geocodes: '3550308,3509502,', poligono: '', riscos: "['Chuva entre 30 e 60 mm/h, ventos intensos (60-100 km/h).']" });

// 1ª rodada: só marca o que já existe, não envia
escrever([dcBorja], { hoje: [inmetSP('Perigo Potencial')], futuro: [] });
console.log(await rodar());
assert.deepEqual(recebidas, {});
assert.equal(bancos.wc_enviados.length, 2);
const pub = JSON.parse(fs.readFileSync(path.join(pasta, 'push.json')));
assert.equal(pub.supabaseKey, 'sb_publishable_teste'); assert.ok(!JSON.stringify(pub).includes('secret'));

// 2ª rodada: mesmos alertas → nada; + alerta próprio WeatherCenter (polígono) + Marinha (ignorado)
const wcSP = { id: 'weathercenter-1', fonte: 'WeatherCenter', titulo: 'Temporal com rajadas', severidade: 'Severo', nivel: 2, fim, riscos: ['Rajadas acima de 80 km/h nas próximas 2 horas.'], geocodes: [], poligonos: [quadrado(-23.53, -46.64)] };
escrever([dcBorja, marinha, wcSP], { hoje: [inmetSP('Perigo Potencial')], futuro: [] });
console.log(await rodar());
assert.equal(recebidas.sp.length, 1);
assert.match(recebidas.sp[0].titulo, /🟠 Temporal/);
assert.match(recebidas.sp[0].corpo, /Fonte: WeatherCenter/);
assert.match(recebidas.sp[0].url, /\?cidade=3550308#previsao$/);
assert.equal(recebidas.borja, undefined);
assert.equal(recebidas.exigente, undefined, 'nível mínimo 3 não recebe laranja');
assert.equal(bancos.wc_inscricoes.length, 3, 'inscrição expirada (410) removida');

// 3ª rodada: INMET sobe para Grande Perigo → "agravado", inclusive para quem só quer vermelho
escrever([dcBorja, wcSP], { hoje: [inmetSP('Grande Perigo')], futuro: [] });
console.log(await rodar());
assert.equal(recebidas.sp.length, 2);
assert.match(recebidas.sp[1].titulo, /🔴 Alerta agravado: Tempestade/);
assert.match(recebidas.sp[1].corpo, /São Paulo · Grande Perigo · até/);
assert.match(recebidas.sp[1].corpo, /Fonte: INMET/);
assert.equal(recebidas.exigente.length, 1);

// 4ª rodada: nada novo → nada enviado
console.log(await rodar());
assert.equal(recebidas.sp.length, 2);
console.log('ok: ponta a ponta', JSON.stringify(recebidas.sp[1]));
srv.close();
