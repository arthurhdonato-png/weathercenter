// Sonda temporária: abre o ClimaRS num navegador e lista as chamadas de dados que a página faz
import { chromium } from 'playwright';
const paginas = process.argv.slice(2);
const nav = await chromium.launch();
for (const url of paginas) {
  const pg = await nav.newPage({ userAgent: 'Mozilla/5.0 WeatherCenter-sonda' });
  const vistos = [];
  pg.on('response', async (r) => {
    const t = r.request().resourceType();
    if (!['xhr', 'fetch', 'document', 'script'].includes(t)) return;
    let corpo = '';
    if (t === 'xhr' || t === 'fetch') { try { corpo = (await r.text()).slice(0, 700); } catch { } }
    vistos.push(`${r.status()} ${t} ${r.request().method()} ${r.url()}${corpo ? `\n      ${corpo.replace(/\s+/g, ' ')}` : ''}`);
  });
  try { await pg.goto(url, { waitUntil: 'networkidle', timeout: 60000 }); } catch (e) { console.log('erro', url, e.message); }
  await pg.waitForTimeout(8000);
  console.log(`===== ${url}`);
  for (const v of vistos) console.log('  ', v);
  const texto = (await pg.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  console.log('  TEXTO:', texto.slice(0, 2500));
  await pg.close();
}
await nav.close();
