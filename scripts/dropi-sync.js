/**
 * dropi-sync.js
 * Lee los metafields dropi:_dropi_product de cada producto en Shopify
 * y actualiza: stock, descripción, imágenes, precios de costo.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

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

async function shopify(path, opts = {}) {
  const r = await fetch(`https://${STORE}/admin/api/2024-10${path}`, { headers: HEADS, ...opts });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

async function getAllProducts() {
  const products = [];
  let pageInfo = null;
  while (true) {
    const qs = pageInfo ? `/products.json?limit=250&page_info=${pageInfo}` : `/products.json?limit=250`;
    const res = await fetch(`https://${STORE}/admin/api/2024-10${qs}`, { headers: HEADS });
    const data = await res.json();
    products.push(...(data.products || []));
    const link = res.headers.get('link') || '';
    const next = link.match(/<[^>]+page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if (next) pageInfo = next[1]; else break;
  }
  return products;
}

async function getDropiMeta(productId) {
  try {
    const { metafields } = await shopify(`/products/${productId}/metafields.json`);
    const meta = metafields.find(m => m.namespace === 'dropi' && m.key === '_dropi_product');
    if (!meta) return null;
    return JSON.parse(meta.value);
  } catch { return null; }
}

function extractImgsFromHtml(html = '') {
  const urls = [];
  const matches = html.matchAll(/src="(https?:\/\/[^"]+\.(jpg|jpeg|png|webp)[^"]*)"/gi);
  for (const m of matches) {
    const url = m[1].replace(/\\"/g, '').replace(/\\/g, '');
    if (!url.includes('gstatic') && !url.includes('google')) urls.push(url);
  }
  return urls;
}

function buildImageUrls(gallery = []) {
  return gallery
    .filter(img => img.urlS3 || img.url)
    .map(img => {
      if (img.urlS3) {
        const parts = img.urlS3.split('/');
        const filename = encodeURIComponent(parts.pop());
        return CDN + parts.join('/') + '/' + filename;
      }
      return img.url;
    })
    .filter(Boolean);
}

function getStock(dropi) {
  if (dropi.warehouse_product?.length > 0) {
    return dropi.warehouse_product.reduce((s, w) => s + (w.stock || 0), 0);
  }
  return dropi.stock || 0;
}

async function updateProduct(shopifyProduct, dropi) {
  const updates = {};
  const variantUpdates = {};

  // Descripción
  const dropiDesc = dropi.description || '';
  if (dropiDesc && dropiDesc !== shopifyProduct.body_html) {
    updates.body_html = dropiDesc;
  }

  // Precio de costo (inventory_item)
  const costPrice = parseFloat(dropi.sale_price || 0);

  // Stock desde warehouse
  const dropiStock = getStock(dropi);

  // Imágenes
  const imageUrls = buildImageUrls(dropi.gallery || []);

  if (DRY_RUN) {
    console.log(`  [DRY] ${shopifyProduct.title}`);
    console.log(`    Stock Dropi: ${dropiStock} | Imágenes: ${imageUrls.length} | Costo: $${costPrice}`);
    if (updates.body_html) console.log(`    → Actualiza descripción`);
    return;
  }

  // Actualizar producto (descripción)
  if (Object.keys(updates).length > 0) {
    await shopify(`/products/${shopifyProduct.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ product: { id: shopifyProduct.id, ...updates } })
    });
    await delay(300);
  }

  // Combinar imágenes: gallery + imágenes de la descripción HTML
  const descImgs = extractImgsFromHtml(dropi.description || '');
  const allImgUrls = [...new Set([...imageUrls, ...descImgs])];

  // Agregar imágenes que faltan
  const existingImgs = shopifyProduct.images.map(i => i.src);
  let added = 0;
  for (const url of allImgUrls) {
    const filename = url.split('/').pop().split('?')[0];
    const alreadyExists = existingImgs.some(src => src.includes(encodeURIComponent(filename)) || src.includes(filename));
    if (!alreadyExists) {
      try {
        const r = await shopify(`/products/${shopifyProduct.id}/images.json`, {
          method: 'POST',
          body: JSON.stringify({ image: { src: url } })
        });
        if (r.image?.id) added++;
        await delay(400);
      } catch (e) {
        // imagen no accesible, ignorar
      }
    }
  }
  return added;

  // Actualizar costo en inventory_item
  if (costPrice > 0 && shopifyProduct.variants[0]?.inventory_item_id) {
    await shopify(`/inventory_items/${shopifyProduct.variants[0].inventory_item_id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ inventory_item: { id: shopifyProduct.variants[0].inventory_item_id, cost: String(costPrice) } })
    });
    await delay(300);
  }
}

async function run() {
  console.log(`\n🔄 Dropi Sync desde metafields${DRY_RUN ? ' [DRY-RUN]' : ''}`);
  console.log('━'.repeat(50));

  const products = await getAllProducts();
  console.log(`📦 ${products.length} productos en Shopify\n`);

  let updated = 0, sinMeta = 0, errores = 0;

  for (const p of products) {
    const dropi = await getDropiMeta(p.id);
    await delay(200);

    if (!dropi) {
      sinMeta++;
      continue;
    }

    const dropiStock = getStock(dropi);
    const imageUrls  = buildImageUrls(dropi.gallery || []);
    const needsImg   = imageUrls.length > p.images.length;
    const needsDesc  = dropi.description && dropi.description !== p.body_html;
    const costPrice  = parseFloat(dropi.sale_price || 0);

    console.log(`📦 ${p.title}`);
    console.log(`   ID Dropi: ${dropi.id} | Stock: ${dropiStock} | Imágenes Dropi: ${imageUrls.length} | Shopify: ${p.images.length}`);

    if (!needsImg && !needsDesc && !costPrice) {
      console.log(`   ✓ Sin cambios`);
      continue;
    }

    try {
      const added = await updateProduct(p, dropi);
      if (!DRY_RUN) {
        if (added > 0)  console.log(`   📸 +${added} imágenes agregadas`);
        if (needsDesc)  console.log(`   📝 Descripción actualizada`);
        if (costPrice)  console.log(`   💰 Costo: $${costPrice.toLocaleString('es-CL')}`);
      }
      updated++;
    } catch (e) {
      console.log(`   ❌ Error: ${e.message}`);
      errores++;
    }

    await delay(300);
  }

  console.log(`\n✅ Completado: ${updated} actualizados | ${sinMeta} sin metafield | ${errores} errores`);
}

run().catch(console.error);
