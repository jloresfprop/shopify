/**
 * dropi-upload-images.js
 * Lee dropi-products.json (generado por dropi:scraper)
 * y sube todas las imágenes a cada producto en Shopify.
 * Uso: npm run dropi:upload
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir   = dirname(fileURLToPath(import.meta.url));
const IN_FILE = resolve(__dir, '../dropi-products.json');

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
const delay = ms => new Promise(r => setTimeout(r, ms));

if (!existsSync(IN_FILE)) {
  console.error('❌ No existe dropi-products.json — corre primero: npm run dropi:scraper');
  process.exit(1);
}

const dropiProducts = JSON.parse(readFileSync(IN_FILE, 'utf8'));
console.log(`📦 ${dropiProducts.length} productos en dropi-products.json`);

// Indexar por Dropi ID para búsqueda rápida
const dropiById = {};
for (const p of dropiProducts) dropiById[String(p.id)] = p;

function buildUrls(photos = []) {
  const urls = [];
  for (const img of photos) {
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

async function getAllShopifyProducts() {
  const [r1, r2] = await Promise.all([
    fetch(`https://${STORE}/admin/api/2024-10/products.json?limit=250&status=active`, { headers: HEADS }),
    fetch(`https://${STORE}/admin/api/2024-10/products.json?limit=250&status=draft`,  { headers: HEADS })
  ]);
  const [d1, d2] = await Promise.all([r1.json(), r2.json()]);
  return [...(d1.products || []), ...(d2.products || [])];
}

async function getDropiId(shopifyProductId) {
  const res = await fetch(`https://${STORE}/admin/api/2024-10/products/${shopifyProductId}/metafields.json`, { headers: HEADS });
  const { metafields } = await res.json();
  const meta = metafields?.find(m => m.namespace === 'dropi' && m.key === '_dropi_product');
  if (!meta) return null;
  const dropi = JSON.parse(meta.value);
  return String(dropi.id);
}

async function run() {
  console.log('\n🔄 Subiendo imágenes de Dropi a Shopify...\n');

  const products = await getAllShopifyProducts();
  let totalAdded = 0;

  for (const p of products) {
    const dropiId = await getDropiId(p.id);
    await delay(150);
    if (!dropiId) continue;

    const dropiProduct = dropiById[dropiId];
    if (!dropiProduct) {
      console.log(`⚠️  ${p.title} — ID Dropi ${dropiId} no encontrado en dropi-products.json`);
      continue;
    }

    // Combinar gallery + photos del scraper
    const photos = [...(dropiProduct.gallery || []), ...(dropiProduct.photos || [])];
    const urls   = buildUrls(photos);

    if (urls.length === 0) {
      console.log(`⚠️  ${p.title} — sin imágenes en Dropi`);
      continue;
    }

    const existing = p.images.map(i => i.src);
    let added = 0;

    for (const url of urls) {
      const file   = decodeURIComponent(url.split('/').pop().split('?')[0]);
      const exists = existing.some(s => s.includes(file) || s.includes(encodeURIComponent(file)));
      if (exists) continue;

      try {
        const r = await fetch(`https://${STORE}/admin/api/2024-10/products/${p.id}/images.json`, {
          method: 'POST', headers: HEADS,
          body: JSON.stringify({ image: { src: url } })
        });
        const d = await r.json();
        if (d.image?.id) {
          added++;
          totalAdded++;
          existing.push(url);
        } else {
          console.log(`    ❌ ${url.split('/').pop().slice(0, 60)}: ${JSON.stringify(d.errors || d)}`);
        }
        await delay(400);
      } catch (e) {
        console.log(`    ❌ Error: ${e.message}`);
      }
    }

    const status = added > 0 ? `+${added} imágenes` : '✓ ya al día';
    console.log(`${added > 0 ? '📸' : '✓'} ${p.title} — Dropi:${urls.length} Shopify:${existing.length} | ${status}`);
    await delay(300);
  }

  console.log(`\n✅ Total imágenes agregadas a Shopify: ${totalAdded}`);
  console.log('   Corre ahora npm run auto-sync para sincronizarlas a MercadoLibre.\n');
}

run().catch(console.error);
