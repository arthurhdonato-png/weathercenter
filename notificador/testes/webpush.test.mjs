// Confere a criptografia com o exemplo oficial da RFC 8291 (apêndice A) e a assinatura VAPID.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { criptografar, chavesVapid, cabecalhoVapid, deB64url } from '../webpush.mjs';

const esperado = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
const saida = criptografar('When I grow up, I want to be a watermelon',
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  'BTBZMqHH6r4Tts7J_aSIgg',
  { privadaTemporaria: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', sal: 'DGv6ra1nlYgDCS1FRnbzlw' });
assert.equal(saida.toString('base64url'), esperado);
console.log('ok: criptografia igual ao exemplo da RFC 8291');

const priv = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }).d;
const v = chavesVapid(priv);
const cab = cabecalhoVapid('https://fcm.googleapis.com/fcm/send/abc', v, 'https://exemplo.org/');
const [, jwt, k] = cab.match(/^vapid t=([^,]+), k=(.+)$/);
assert.equal(k, v.publica);
const [h, c, s] = jwt.split('.');
const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: deB64url(k).subarray(1, 33).toString('base64url'), y: deB64url(k).subarray(33).toString('base64url') }, format: 'jwk' });
assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, deB64url(s)));
assert.equal(JSON.parse(deB64url(c)).aud, 'https://fcm.googleapis.com');
console.log('ok: assinatura VAPID válida');
