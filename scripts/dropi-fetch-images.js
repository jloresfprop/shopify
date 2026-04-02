/**
 * dropi-fetch-images.js
 * Usa el token del metafield de Dropi para pedir las imágenes
 * de cada producto directamente a la API de Dropi,
 * y las sube a Shopify.
 */
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

const STORE   = process.env.SHOPIFY_STORE;
const TOKEN   = process.env.SHOPIFY_TOKEN;
const HEADS   = { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' };
const CDN     = 'https://d39ru7awumhhs2.cloudfront.net/';
const delay   = ms => new Promise(r => setTimeout(r, ms));

async function getAllProducts() {
  const [r1, r2] = await Promise.all([
    fetch(`https://${STORE}/admin/api/2024-10/products.json?limit=250&status=active`, { headers: HEADS }),
    fetch(`https://${STORE}/admin/api/2024-10/products.json?limit=250&status=draft`,  { headers: HEADS })
  ]);
  const [d1, d2] = await Promise.all([r1.json(), r2.json()]);
  return [...(d1.products || []), ...(d2.products || [])];
}

async function getDropiMeta(productId) {
  const res = await fetch(`https://${STORE}/admin/api/2024-10/products/${productId}/metafields.json`, { headers: HEADS });
  const { metafields } = await res.json();
  const meta = metafields?.find(m => m.namespace === 'dropi' && m.key === '_dropi_product');
  if (!meta) return null;
  return JSON.parse(meta.value);
}

async function fetchDropiProduct(dropiId, token) {
  // Intenta obtener el producto completo desde la API de Dropi usando su token
  const endpoints = [
    `/integrations/products/${dropiId}`,
    `/api/v1/products/${dropiId}`,
    `/products/${dropiId}`
  ];
  for (const path of endpoints) {
    try {
      const res = await fetch(`https://api.dropi.cl${path}`, {
        headers: {
          'x-authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Origin': 'https://app.dropi.cl',
          'Referer': 'https://app.dropi.cl/'
        }
      });
      const data = await res.json();
      if (data.object?.id || data.id) {
        return data.object || data;
      }
    } catch { }
  }
  return null;
}

function buildUrls(gallery = [], photos = []) {
  const urls = [];
  for (const img of [...gallery, ...photos]) {
    if (!img) continue;
    if (img.urlS3) {
      const parts = img.urlS3.split('/');
      const file  = encodeURIComponent(parts.pop());
      urls.push(CDN + parts.join('/') + '/' + file);
    } else if (img.url) {
      urls.push(img.url);
    }
  }
  return [...new Set(urls)];
}

async function uploadImages(shopifyId, newUrls, existingImgs) {
  let added = 0;
  for (const url of newUrls) {
    const file = decodeURIComponent(url.split('/').pop().split('?')[0]);
    const exists = existingImgs.some(s => s.includes(file) || s.includes(encodeURIComponent(file)));
    if (exists) continue;
    try {
      const r = await fetch(`https://${STORE}/admin/api/2024-10/products/${shopifyId}/images.json`, {
        method: 'POST', headers: HEADS,
        body: JSON.stringify({ image: { src: url } })
      });
      const d = await r.json();
      if (d.image?.id) { added++; existingImgs.push(url); }
      else if (d.errors) console.log(`    ⚠️  Error subiendo imagen: ${JSON.stringify(d.errors)}`);
      await delay(400);
    } catch { }
  }
  return added;
}

async function run() {
  console.log('\n🔄 Dropi → Shopify: sincronizando imágenes via API Dropi\n');

  const products = await getAllProducts();
  let totalAdded = 0;

  for (const p of products) {
    const dropi = await getDropiMeta(p.id);
    await delay(150);
    if (!dropi) continue;

    // Intentar obtener datos frescos de Dropi usando el token del metafield
    const dropiToken = dropi.tokens;
    let freshDropi = null;
    if (dropiToken) {
      freshDropi = await fetchDropiProduct(dropi.id, dropiToken);
      await delay(500);
    }

    const source = freshDropi || dropi;
    const gallery = source.gallery || source.photos || [];
    const photos  = source.photos  || [];
    const urls    = buildUrls(gallery, photos);

    if (urls.length <= p.images.length) {
      console.log(`✓ ${p.title} — ya tiene todas las imágenes (${p.images.length})`);
      continue;
    }

    console.log(`📸 ${p.title} — Dropi:${urls.length} Shopify:${p.images.length}`);
    const existing = p.images.map(i => i.src);
    const added = await uploadImages(p.id, urls, existing);
    if (added > 0) {
      console.log(`   ✅ +${added} imágenes agregadas`);
      totalAdded += added;
    }

    await delay(300);
  }

  console.log(`\n✅ Total imágenes agregadas: ${totalAdded}`);
}

run().catch(console.error);
