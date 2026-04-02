import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
function loadEnv() {
  const env = readFileSync(resolve(__dir, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const [k, ...v] = line.split('=');
    if (k?.trim() && v.length) process.env[k.trim()] = v.join('=').trim();
  }
}
loadEnv();

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;
const HEADS = { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' };
const CDN   = 'https://d39ru7awumhhs2.cloudfront.net/';

const DROPI_ID = process.argv[2] || '';

const res = await fetch(`https://${STORE}/admin/api/2024-10/products.json?limit=250`, { headers: HEADS });
const { products } = await res.json();

for (const p of products) {
  const mRes = await fetch(`https://${STORE}/admin/api/2024-10/products/${p.id}/metafields.json`, { headers: HEADS });
  const { metafields } = await mRes.json();
  const meta = metafields?.find(m => m.namespace === 'dropi' && m.key === '_dropi_product');
  if (!meta) continue;

  const dropi = JSON.parse(meta.value);
  if (DROPI_ID && !String(dropi.id).includes(DROPI_ID)) continue;

  console.log(`\n📦 ${p.title}`);
  console.log(`   Shopify ID : ${p.id}`);
  console.log(`   Dropi ID   : ${dropi.id}`);
  console.log(`\n   Imágenes en Shopify (${p.images.length}):`);
  p.images.forEach((img, i) => console.log(`     [${i+1}] ${img.src}`));

  // Mostrar todos los campos del objeto Dropi
  console.log('\n   Campos disponibles en el metafield Dropi:');
  for (const [k, v] of Object.entries(dropi)) {
    const preview = Array.isArray(v) ? `Array(${v.length})` : typeof v === 'object' && v ? `Object` : String(v).slice(0, 80);
    console.log(`     ${k}: ${preview}`);
  }

  const gallery = dropi.gallery || [];
  const photos  = dropi.photos  || [];
  console.log(`\n   gallery (${gallery.length}): ${JSON.stringify(gallery.map(i => i.urlS3 || i.url))}`);
  console.log(`   photos  (${photos.length}): ${JSON.stringify(photos.map(i => i.urlS3 || i.url))}`);

  const allImgs = [...gallery, ...photos];
  console.log(`\n   URLs construidas (${allImgs.length}):`);
  for (const img of allImgs) {
    let url = '';
    if (img.urlS3) {
      const parts = img.urlS3.split('/');
      const file  = encodeURIComponent(parts.pop());
      url = CDN + parts.join('/') + '/' + file;
    } else url = img.url || '(sin url)';
    console.log(`     → ${url}`);
  }

  // Imágenes extraídas del HTML de descripción
  const desc = dropi.description || '';
  const descImgs = [];
  for (const m of desc.matchAll(/src="(https?:\/\/[^"]+\.(jpg|jpeg|png|webp|gif)[^"]*)"/gi)) {
    const url = m[1].replace(/\\/g, '');
    if (!url.includes('gstatic') && !url.includes('google.com')) descImgs.push(url);
  }
  console.log(`\n   Imágenes en descripción HTML (${descImgs.length}):`);
  descImgs.forEach(u => console.log(`     → ${u.slice(0, 100)}`));

  console.log(`\n   Prueba de acceso:`);
  for (const img of allImgs) {
    let url = '';
    if (img.urlS3) {
      const parts = img.urlS3.split('/');
      const file  = encodeURIComponent(parts.pop());
      url = CDN + parts.join('/') + '/' + file;
    } else url = img.url || '';
    if (!url) continue;
    try {
      const r = await fetch(url, { method: 'HEAD' });
      console.log(`     ${r.ok ? '✅' : '❌'} ${r.status} ${url.slice(0, 80)}`);
    } catch (e) {
      console.log(`     ❌ Error: ${e.message} | ${url.slice(0, 80)}`);
    }
  }
  break;
}
