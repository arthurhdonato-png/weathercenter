// Web Push sem dependências (só o Node): criptografia da mensagem (RFC 8291, aes128gcm)
// e identificação do remetente com chaves VAPID (RFC 8292).
// Funciona com Chrome/Android (FCM), Firefox, Edge e Safari/iPhone (app na tela de início).
import crypto from 'node:crypto';

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const deB64url = (s) => Buffer.from(String(s).replace(/=+$/, ''), 'base64url');

const hmac = (chave, dados) => crypto.createHmac('sha256', chave).update(dados).digest();

// Chave VAPID: a parte privada (32 bytes em base64url) fica no GitHub Secrets.
// A parte pública é calculada a partir dela e publicada para o app.
export function chavesVapid(privadaB64) {
  const d = deB64url(privadaB64);
  if (d.length !== 32) throw new Error('VAPID_PRIVATE_KEY inválida: esperado 32 bytes em base64url');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const publica = ecdh.getPublicKey(); // 65 bytes, formato "não comprimido"
  const jwk = { kty: 'EC', crv: 'P-256', d: b64url(d), x: b64url(publica.subarray(1, 33)), y: b64url(publica.subarray(33, 65)) };
  return { publica: b64url(publica), chave: crypto.createPrivateKey({ key: jwk, format: 'jwk' }) };
}

// Cabeçalho Authorization com o JWT assinado (ES256) para a origem do serviço de push
export function cabecalhoVapid(endpoint, vapid, contato, validadeSeg = 12 * 3600) {
  const aud = new URL(endpoint).origin;
  const cab = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const corpo = b64url(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + validadeSeg, sub: contato }));
  const assinatura = crypto.sign('sha256', Buffer.from(`${cab}.${corpo}`), { key: vapid.chave, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${cab}.${corpo}.${b64url(assinatura)}, k=${vapid.publica}`;
}

// Criptografa a mensagem para uma inscrição (p256dh e auth vêm do navegador).
// `teste` permite fixar a chave temporária e o "sal" (usado só para conferir com o exemplo da RFC 8291).
export function criptografar(texto, p256dh, auth, teste = {}) {
  const uaPublica = deB64url(p256dh);
  const segredoAuth = deB64url(auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (teste.privadaTemporaria) ecdh.setPrivateKey(deB64url(teste.privadaTemporaria)); else ecdh.generateKeys();
  const asPublica = ecdh.getPublicKey();
  const segredo = ecdh.computeSecret(uaPublica);
  const sal = teste.sal ? deB64url(teste.sal) : crypto.randomBytes(16);

  const prkChave = hmac(segredoAuth, segredo);
  const ikm = hmac(prkChave, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublica, asPublica, Buffer.from([1])]));
  const prk = hmac(sal, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const cifra = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const cifrado = Buffer.concat([cifra.update(Buffer.concat([Buffer.from(texto), Buffer.from([2])])), cifra.final(), cifra.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([sal, rs, Buffer.from([asPublica.length]), asPublica, cifrado]);
}

// Envia uma notificação. Devolve { ok, status, expirada } — expirada = a pessoa saiu (apagar a inscrição).
export async function enviarPush(inscricao, dados, vapid, contato, { ttl = 6 * 3600, urgencia = 'high', timeoutMs = 15000 } = {}) {
  const corpo = criptografar(typeof dados === 'string' ? dados : JSON.stringify(dados), inscricao.p256dh, inscricao.auth);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(inscricao.endpoint, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: cabecalhoVapid(inscricao.endpoint, vapid, contato),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttl),
        Urgency: urgencia,
      },
      body: corpo,
    });
    const detalhe = r.ok ? '' : (await r.text().catch(() => '')).slice(0, 200);
    return { ok: r.ok, status: r.status, expirada: r.status === 404 || r.status === 410, detalhe };
  } catch (e) {
    return { ok: false, status: 0, expirada: false, detalhe: e.message };
  } finally {
    clearTimeout(t);
  }
}
