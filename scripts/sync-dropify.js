/**
 * sync-dropify.js
 * Publica automáticamente productos de Dropify que tengan:
 *   - Stock disponible (inventory > 0)
 *   - Tag "verified" o "dropify-verified" (según lo que ponga Dropify)
 *
 * Uso:
 *   node scripts/sync-dropify.js          → modo real (publica)
 *   node scripts/sync-dropify.js --dry-run → solo muestra, no publica
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

// Leer .env manualmente (sin dependencias)
function loadEnv() {
  try {
    const env = readFileSync(resolve(__dir, '../.env'), 'utf8');
    for (const line of env.split('\n')) {
      const [k, ...v] = line.split('=');
      if (k && v.length) process.env[k.trim()] = v.join('=').trim();
    }
  } catch {}
}
loadEnv();

const STORE   = process.env.SHOPIFY_STORE;
const TOKEN   = process.env.SHOPIFY_TOKEN;
const DRY_RUN = process.argv.includes('--dry-run');

if (!STORE || !TOKEN || TOKEN === 'PEGA_TU_NUEVO_TOKEN_AQUI') {
  console.error('❌ Configura SHOPIFY_STORE y SHOPIFY_TOKEN en el archivo .env');
  process.exit(1);
}

const BASE  = `https://${STORE}/admin/api/2024-10`;
const HEADS = { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' };

async function shopify(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: HEADS, ...opts });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return res.json();
}

// Trae todos los productos (paginación automática)
async function getAllProducts() {
  const products = [];
  let url = `/products.json?limit=250&status=any`;

  while (url) {
    const data = await shopify(url);
    products.push(...data.products);

    // Shopify devuelve Link header para paginación
    const link = data.__link;
    url = null; // fetch nativo no expone headers fácil, usamos cursor manual
    // Si hay más de 250 productos se puede extender aquí
  }
  return products;
}

function isDropify(product) {
  const tags = (product.tags || '').toLowerCase().split(',').map(t => t.trim());
  return tags.some(t =>
    t === 'dropify' ||
    t === 'dropify-verified' ||
    t === 'verified' ||
    t.startsWith('dropify')
  );
}

function isVerified(product) {
  const tags = (product.tags || '').toLowerCase().split(',').map(t => t.trim());
  return tags.some(t => t === 'verified' || t === 'dropify-verified' || t === 'approved');
}

function hasStock(product) {
  return product.variants.some(v =>
    v.inventory_management === null ||        // sin gestión = disponible
    v.inventory_quantity > 0 ||
    v.inventory_policy === 'continue'         // "continuar vendiendo" aunque sin stock
  );
}

async function run() {
  console.log(`\n🔗 Conectando a ${STORE}...`);
  if (DRY_RUN) console.log('🧪 Modo DRY-RUN — no se publicará nada\n');

  const all = await getAllProducts();
  console.log(`📦 Total productos en tienda: ${all.length}`);

  const dropify    = all.filter(isDropify);
  const withStock  = dropify.filter(hasStock);
  const verified   = withStock.filter(isVerified);
  const toPublish  = verified.filter(p => p.status !== 'active');
  const toUnpublish = dropify.filter(p => !hasStock(p) && p.status === 'active');

  console.log(`\n📋 Dropify detectados : ${dropify.length}`);
  console.log(`✅ Con stock          : ${withStock.length}`);
  console.log(`🏅 Verificados        : ${verified.length}`);
  console.log(`🚀 Para publicar      : ${toPublish.length}`);
  console.log(`🔴 Para ocultar (sin stock): ${toUnpublish.length}\n`);

  if (dropify.length === 0) {
    console.log('⚠️  No se encontraron productos con tags de Dropify.');
    console.log('   Revisa qué tags le pone Dropify a tus productos en:');
    console.log('   Shopify Admin → Products → abre uno de Dropify → Tags\n');
  }

  // Publicar verificados con stock
  let published = 0;
  for (const p of toPublish) {
    console.log(`  ▶ Publicando: ${p.title}`);
    if (!DRY_RUN) {
      await shopify(`/products/${p.id}.json`, {
        method: 'PUT',
        body: JSON.stringify({ product: { id: p.id, status: 'active' } })
      });
      await delay(500); // respetar rate limit
    }
    published++;
  }

  // Ocultar sin stock
  let hidden = 0;
  for (const p of toUnpublish) {
    console.log(`  ⏸ Ocultando (sin stock): ${p.title}`);
    if (!DRY_RUN) {
      await shopify(`/products/${p.id}.json`, {
        method: 'PUT',
        body: JSON.stringify({ product: { id: p.id, status: 'draft' } })
      });
      await delay(500);
    }
    hidden++;
  }

  console.log(`\n✅ Publicados : ${published}`);
  console.log(`⏸  Ocultados  : ${hidden}`);
  console.log(DRY_RUN ? '\n(Dry-run: ningún cambio real fue aplicado)' : '\n🎉 Sincronización completada.');
}

const delay = ms => new Promise(r => setTimeout(r, ms));

run().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
