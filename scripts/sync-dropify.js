/**
 * sync-dropify.js
 * - Publica productos con stock y los agrega a colecciones
 * - Oculta productos sin stock y los quita de Página de inicio
 * - El Inventario siempre muestra todo
 *
 * Uso:
 *   node scripts/sync-dropify.js          → modo real
 *   node scripts/sync-dropify.js --dry-run → solo muestra, no cambia
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

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

if (!STORE || !TOKEN) {
  console.error('❌ Configura SHOPIFY_STORE y SHOPIFY_TOKEN en .env');
  process.exit(1);
}

const BASE  = `https://${STORE}/admin/api/2024-10`;
const HEADS = { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' };

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: HEADS, ...opts });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return res.json();
}

async function getAllProducts() {
  const products = [];
  let pageInfo = null;
  while (true) {
    const qs = pageInfo
      ? `/products.json?limit=250&page_info=${pageInfo}`
      : `/products.json?limit=250`;
    const res = await fetch(`${BASE}${qs}`, { headers: HEADS });
    if (!res.ok) throw new Error(`${res.status} — ${qs}`);
    const data = await res.json();
    products.push(...data.products);
    const link = res.headers.get('link') || '';
    const next = link.match(/<[^>]+page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if (next) pageInfo = next[1];
    else break;
  }
  return products;
}

async function getCollections() {
  const [custom, smart] = await Promise.all([
    api('/custom_collections.json?limit=250'),
    api('/smart_collections.json?limit=250')
  ]);
  return [...custom.custom_collections, ...smart.smart_collections];
}

async function getCollects(collectionId) {
  const data = await api(`/collects.json?collection_id=${collectionId}&limit=250`);
  return data.collects;
}

async function addToCollection(productId, collectionId) {
  try {
    await api('/collects.json', {
      method: 'POST',
      body: JSON.stringify({ collect: { product_id: productId, collection_id: collectionId } })
    });
  } catch { /* ya existe */ }
}

async function removeFromCollection(productId, collectionId, collects) {
  const collect = collects.find(c => c.product_id === productId && c.collection_id === collectionId);
  if (collect) {
    await api(`/collects/${collect.id}.json`, { method: 'DELETE' });
  }
}

function hasStock(product) {
  return product.variants.some(v =>
    v.inventory_management === null ||
    v.inventory_quantity > 0 ||
    v.inventory_policy === 'continue'
  );
}

async function run() {
  console.log(`\n🔗 Conectando a ${STORE}...`);
  if (DRY_RUN) console.log('🧪 Modo DRY-RUN — no se aplicarán cambios\n');

  const [allProducts, collections] = await Promise.all([
    getAllProducts(),
    getCollections()
  ]);

  console.log(`📦 Total productos : ${allProducts.length}`);

  // Detectar colecciones
  const colInventario  = collections.find(c => c.title === 'El Inventario');
  const colInicio      = collections.find(c => c.title === 'Página de inicio');

  if (!colInventario) console.log('⚠️  Colección "El Inventario" no encontrada — créala en Shopify Admin');
  if (!colInicio)     console.log('⚠️  Colección "Página de inicio" no encontrada');

  // Traer collects actuales
  const collectsInventario = colInventario ? await getCollects(colInventario.id) : [];
  const collectsInicio     = colInicio     ? await getCollects(colInicio.id)     : [];

  const conStock    = allProducts.filter(hasStock);
  const sinStock    = allProducts.filter(p => !hasStock(p));
  const toPublish   = conStock.filter(p => p.status !== 'active');
  const toUnpublish = sinStock.filter(p => p.status === 'active');

  console.log(`✅ Con stock       : ${conStock.length}`);
  console.log(`🔴 Sin stock       : ${sinStock.length}`);
  console.log(`🚀 Para publicar   : ${toPublish.length}`);
  console.log(`⏸  Para ocultar    : ${toUnpublish.length}\n`);

  // Publicar con stock + tag em-stock
  for (const p of toPublish) {
    console.log(`  ▶ Publicando: ${p.title}`);
    if (!DRY_RUN) {
      const tags = addTag(p.tags, 'em-stock');
      await api(`/products/${p.id}.json`, {
        method: 'PUT',
        body: JSON.stringify({ product: { id: p.id, status: 'active', tags } })
      });
      await delay(300);
    }
  }

  // Actualizar tag em-stock en todos según stock actual
  for (const p of conStock) {
    if (!p.tags.includes('em-stock')) {
      console.log(`  🏷 Tag stock: ${p.title}`);
      if (!DRY_RUN) {
        await api(`/products/${p.id}.json`, {
          method: 'PUT',
          body: JSON.stringify({ product: { id: p.id, tags: addTag(p.tags, 'em-stock') } })
        });
        await delay(300);
      }
    }
  }

  for (const p of sinStock) {
    if (p.tags.includes('em-stock')) {
      console.log(`  🏷 Quitar tag stock: ${p.title}`);
      if (!DRY_RUN) {
        await api(`/products/${p.id}.json`, {
          method: 'PUT',
          body: JSON.stringify({ product: { id: p.id, tags: removeTag(p.tags, 'em-stock') } })
        });
        await delay(300);
      }
    }
  }

  // Ocultar sin stock (quitar de Inicio, mantener activo para El Inventario)
  for (const p of toUnpublish) {
    console.log(`  ⏸ Sin stock: ${p.title}`);
  }

  // Sincronizar colecciones
  if (!DRY_RUN) {
    // El Inventario → todos los productos
    if (colInventario) {
      const enInventario = new Set(collectsInventario.map(c => c.product_id));
      for (const p of allProducts) {
        if (!enInventario.has(p.id)) {
          await addToCollection(p.id, colInventario.id);
          await delay(200);
        }
      }
      console.log(`\n📚 El Inventario actualizado con ${allProducts.length} productos`);
    }

    // Página de inicio → solo con stock
    if (colInicio) {
      const enInicio = new Set(collectsInicio.map(c => c.product_id));
      for (const p of conStock) {
        if (!enInicio.has(p.id)) {
          await addToCollection(p.id, colInicio.id);
          await delay(200);
        }
      }
      for (const p of sinStock) {
        if (enInicio.has(p.id)) {
          await removeFromCollection(p.id, colInicio.id, collectsInicio);
          await delay(200);
        }
      }
      console.log(`🏠 Página de inicio: ${conStock.length} productos con stock`);
    }
  }

  console.log(`\n✅ Publicados : ${toPublish.length}`);
  console.log(`⏸  Ocultados  : ${toUnpublish.length}`);
  console.log(DRY_RUN ? '\n(Dry-run: sin cambios reales)' : '\n🎉 Sincronización completada.');
}

const delay = ms => new Promise(r => setTimeout(r, ms));
const addTag    = (tags, tag) => tags ? [...new Set([...tags.split(',').map(t=>t.trim()), tag])].join(', ') : tag;
const removeTag = (tags, tag) => tags ? tags.split(',').map(t=>t.trim()).filter(t=>t!==tag).join(', ') : '';

run().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
