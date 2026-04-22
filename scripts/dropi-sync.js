/**
 * dropi-sync.js
 * Para cada producto Shopify con metafield dropi:_dropi_product:
 *  1. Stock Shopify = stock real de Dropi (scraper dropi-products.json si existe, sino metafield)
 *  2. Refresca metafield con datos del scraper si hay stock distinto
 *  3. Actualiza descripción, costo e imágenes si cambiaron
 *
 * SKU y barcode: este script NO los modifica. Son fijos, definidos en la migración inicial.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
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

function updateEnv(key, value) {
  const envFile = resolve(__dir, '../.env');
  let content = readFileSync(envFile, 'utf8');
  const lines = content.split('\n');
  const idx = lines.findIndex(l => l.startsWith(key + '='));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(envFile, lines.join('\n'));
}

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;
const HEADS = { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' };
const CDN   = 'https://d39ru7awumhhs2.cloudfront.net/';
const SCRAPER_FILE = resolve(__dir, '../dropi-products.json');
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Auto-renovar token Dropi si expiró ───────────────────────────────────────
async function ensureDropiToken() {
  const current = process.env.DROPI_USER_TOKEN;
  if (current) {
    try {
      const payload = JSON.parse(Buffer.from(current.split('.')[1], 'base64').toString());
      if (payload.exp * 1000 > Date.now() + 60_000) return current;
    } catch {}
  }
  const email = process.env.DROPI_EMAIL, password = process.env.DROPI_PASSWORD;
  if (!email || !password) return null;
  console.log('  🔄 Renovando DROPI_USER_TOKEN...');
  try {
    const res = await fetch('https://api.dropi.cl/integrations/login/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, white_brand_id: 4 })
    });
    const data = await res.json();
    if (!data.isSuccess || !data.token) throw new Error(data.message || 'login failed');
    updateEnv('DROPI_USER_TOKEN', data.token);
    process.env.DROPI_USER_TOKEN = data.token;
    console.log('  ✅ Token Dropi renovado');
    return data.token;
  } catch (e) {
    console.log(`  ⚠️  No se pudo renovar token: ${e.message}`);
    return null;
  }
}

// ── Datos scraper ─────────────────────────────────────────────────────────────
function loadScraperData() {
  if (!existsSync(SCRAPER_FILE)) return {};
  const list = JSON.parse(readFileSync(SCRAPER_FILE, 'utf8'));
  const map = {};
  for (const d of list) map[String(d.id)] = d;
  return map;
}

// ── Shopify helpers ───────────────────────────────────────────────────────────
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
    if (!meta) return { meta: null, metaId: null };
    return { meta: JSON.parse(meta.value), metaId: meta.id };
  } catch { return { meta: null, metaId: null }; }
}

// ── Stock ─────────────────────────────────────────────────────────────────────
function getStock(d) {
  if (d.warehouse_product?.length > 0) return d.warehouse_product.reduce((s, w) => s + (w.stock || 0), 0);
  return d.stock || 0;
}

async function setShopifyStock(variant, newStock) {
  if (!variant?.inventory_item_id) return;
  const { locations } = await shopify('/locations.json');
  const loc = (locations || []).find(l => l.active);
  if (!loc) return;
  await shopify('/inventory_levels/set.json', {
    method: 'POST',
    body: JSON.stringify({ location_id: loc.id, inventory_item_id: variant.inventory_item_id, available: newStock })
  });
}

// ── Imágenes ──────────────────────────────────────────────────────────────────
function extractImgsFromHtml(html = '') {
  const urls = [];
  for (const m of html.matchAll(/src="(https?:\/\/[^"]+\.(jpg|jpeg|png|webp)[^"]*)"/gi)) {
    const url = m[1].replace(/\\"/g, '').replace(/\\/g, '');
    if (!url.includes('gstatic') && !url.includes('google')) urls.push(url);
  }
  return urls;
}

function buildImageUrls(gallery = []) {
  return gallery.filter(img => img.urlS3 || img.url).map(img => {
    if (img.urlS3) {
      const parts = img.urlS3.split('/'), file = encodeURIComponent(parts.pop());
      return CDN + parts.join('/') + '/' + file;
    }
    return img.url;
  }).filter(Boolean);
}

// ── Sync principal ─────────────────────────────────────────────────────────────
async function run() {
  console.log(`\n🔄 Dropi Sync${DRY_RUN ? ' [DRY-RUN]' : ''}`);
  console.log('━'.repeat(50));

  await ensureDropiToken();

  const scraperData = loadScraperData();
  const hasScraperData = Object.keys(scraperData).length > 0;
  if (hasScraperData) console.log(`📂 dropi-products.json: ${Object.keys(scraperData).length} productos (stock fresco)`);
  else console.log(`⚠️  Sin dropi-products.json — stock puede estar desactualizado. Ejecuta: npm run dropi:scraper\n`);

  const products = await getAllProducts();
  console.log(`📦 ${products.length} productos Shopify\n`);

  let stockFix = 0, metaFix = 0, imgFix = 0, sinMeta = 0, errores = 0;

  for (const p of products) {
    const { meta: dropi, metaId } = await getDropiMeta(p.id);
    await delay(200);

    if (!dropi) { sinMeta++; continue; }

    const dropiId      = String(dropi.id);
    const scraper      = scraperData[dropiId];
    const stockFuente  = scraper ? 'scraper' : 'metafield';
    const dropiStock   = scraper ? getStock(scraper) : getStock(dropi);
    const shopifyStock = p.variants[0]?.inventory_quantity ?? 0;
    const metaStock    = getStock(dropi);

    const needsStock  = dropiStock !== shopifyStock;
    const needsMeta   = scraper && dropiStock !== metaStock;
    const needsDesc   = dropi.description && dropi.description !== p.body_html;
    const imageUrls   = buildImageUrls(dropi.gallery || []);
    const needsImg    = imageUrls.length > p.images.length;
    const costPrice   = parseFloat(dropi.sale_price || 0);

    console.log(`📦 ${p.title}`);
    console.log(`   Dropi ID: ${dropiId} | SKU: ${p.variants[0]?.sku || '(vacío)'} | Shopify: ${shopifyStock} | Dropi(${stockFuente}): ${dropiStock}`);

    if (!needsStock && !needsMeta && !needsDesc && !needsImg) {
      console.log(`   ✓ Sin cambios`);
      await delay(100);
      continue;
    }

    if (DRY_RUN) {
      if (needsStock) console.log(`   → Stock: ${shopifyStock} → ${dropiStock} (${stockFuente})`);
      if (needsMeta)  console.log(`   → Metafield refresh (stock metafield: ${metaStock} → scraper: ${dropiStock})`);
      if (needsDesc)  console.log(`   → Descripción actualiza`);
      if (needsImg)   console.log(`   → Imágenes: +${imageUrls.length - p.images.length}`);
      continue;
    }

    try {
      if (needsStock) {
        await setShopifyStock(p.variants[0], dropiStock);
        console.log(`   📦 Stock: ${shopifyStock} → ${dropiStock} (${stockFuente})`);
        stockFix++;
        await delay(300);
      }

      if (needsMeta && scraper) {
        const fresh = { ...dropi, stock: scraper.stock ?? dropi.stock, warehouse_product: scraper.warehouse_product || dropi.warehouse_product };
        const body = { metafield: { id: metaId, value: JSON.stringify(fresh), type: 'json' } };
        await shopify(`/metafields/${metaId}.json`, { method: 'PUT', body: JSON.stringify(body) });
        console.log(`   🔄 Metafield stock actualizado`);
        metaFix++;
        await delay(300);
      }

      if (needsDesc) {
        await shopify(`/products/${p.id}.json`, {
          method: 'PUT', body: JSON.stringify({ product: { id: p.id, body_html: dropi.description } })
        });
        console.log(`   📝 Descripción actualizada`);
        await delay(300);
      }

      const allImgUrls = [...new Set([...imageUrls, ...extractImgsFromHtml(dropi.description || '')])];
      const existing = p.images.map(i => i.src);
      let added = 0;
      for (const url of allImgUrls) {
        const file = url.split('/').pop().split('?')[0];
        if (existing.some(s => s.includes(file) || s.includes(encodeURIComponent(file)))) continue;
        try {
          const r = await shopify(`/products/${p.id}/images.json`, { method: 'POST', body: JSON.stringify({ image: { src: url } }) });
          if (r.image?.id) { added++; existing.push(url); }
          await delay(400);
        } catch {}
      }
      if (added > 0) { console.log(`   📸 +${added} imágenes`); imgFix += added; }

      if (costPrice > 0 && p.variants[0]?.inventory_item_id) {
        await shopify(`/inventory_items/${p.variants[0].inventory_item_id}.json`, {
          method: 'PUT', body: JSON.stringify({ inventory_item: { id: p.variants[0].inventory_item_id, cost: String(costPrice) } })
        });
        console.log(`   💰 Costo: $${costPrice.toLocaleString('es-CL')}`);
        await delay(300);
      }

    } catch (e) {
      console.log(`   ❌ Error: ${e.message}`);
      errores++;
    }

    await delay(300);
  }

  console.log('\n' + '━'.repeat(50));
  console.log(`Stock sync     : ${stockFix}`);
  console.log(`Metafield fresh: ${metaFix}`);
  console.log(`Imágenes       : +${imgFix}`);
  console.log(`Sin metafield  : ${sinMeta}`);
  console.log(`Errores        : ${errores}`);
  if (!hasScraperData) {
    console.log(`\n💡 Para stock real desde Dropi: npm run dropi:scraper && npm run dropi:sync`);
  }
}

run().catch(console.error);
