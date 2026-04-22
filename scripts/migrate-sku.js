/**
 * migrate-sku.js  — EJECUTAR UNA SOLA VEZ
 *
 * Para cada producto Shopify con metafield dropi:_dropi_product:
 *   • variant.sku     = dropi.sku        (el código SKU de Dropi, ej: "GC19-01-25")
 *   • variant.barcode = String(dropi.id) (el ID numérico de Dropi, ej: "48190")
 *
 * Después de correr este script, dropi-sync.js NUNCA vuelve a tocar SKU ni barcode.
 *
 * Uso:
 *   node scripts/migrate-sku.js --dry-run    → muestra cambios sin aplicar
 *   node scripts/migrate-sku.js              → aplica los cambios
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

async function run() {
  console.log(`\n🔁 Migración SKU/Barcode Dropi → Shopify${DRY_RUN ? ' [DRY-RUN]' : ''}`);
  console.log('━'.repeat(55));
  if (!DRY_RUN) console.log('⚠️  Modo real — se aplicarán cambios en Shopify\n');

  const products = await getAllProducts();
  console.log(`📦 ${products.length} productos en Shopify\n`);

  let ok = 0, sinCambio = 0, sinMeta = 0, errores = 0;

  for (const p of products) {
    // Leer metafield Dropi
    let dropi = null;
    try {
      const { metafields } = await shopify(`/products/${p.id}/metafields.json`);
      const meta = (metafields || []).find(m => m.namespace === 'dropi' && m.key === '_dropi_product');
      if (meta) dropi = JSON.parse(meta.value);
    } catch {}
    await delay(150);

    if (!dropi) {
      console.log(`⏭  ${p.title} — sin metafield Dropi`);
      sinMeta++;
      continue;
    }

    const dropiSku      = dropi.sku || '';
    const dropiBarcode  = String(dropi.id);

    if (!dropiSku) {
      console.log(`⚠️  ${p.title} — Dropi no tiene SKU (id: ${dropi.id})`);
      sinMeta++;
      continue;
    }

    for (const variant of p.variants) {
      const skuActual      = variant.sku || '';
      const barcodeActual  = variant.barcode || '';
      const skuIgual       = skuActual === dropiSku;
      const barcodeIgual   = barcodeActual === dropiBarcode;

      console.log(`📦 ${p.title}`);
      console.log(`   Dropi ID: ${dropi.id} | Dropi SKU: "${dropiSku}"`);
      console.log(`   SKU actual: "${skuActual}"${skuIgual ? ' ✓' : ` → "${dropiSku}"`}`);
      console.log(`   Barcode actual: "${barcodeActual}"${barcodeIgual ? ' ✓' : ` → "${dropiBarcode}"`}`);

      if (skuIgual && barcodeIgual) {
        console.log(`   ✓ Sin cambios\n`);
        sinCambio++;
        continue;
      }

      if (!DRY_RUN) {
        try {
          await shopify(`/variants/${variant.id}.json`, {
            method: 'PUT',
            body: JSON.stringify({
              variant: {
                id: variant.id,
                sku: dropiSku,
                barcode: dropiBarcode
              }
            })
          });
          console.log(`   ✅ Actualizado\n`);
          ok++;
          await delay(300);
        } catch (e) {
          console.log(`   ❌ Error: ${e.message}\n`);
          errores++;
        }
      } else {
        console.log(`   [DRY] Se aplicaría\n`);
        ok++;
      }
    }
  }

  console.log('━'.repeat(55));
  console.log(`Actualizados : ${ok}`);
  console.log(`Sin cambio   : ${sinCambio}`);
  console.log(`Sin metafield: ${sinMeta}`);
  console.log(`Errores      : ${errores}`);

  if (DRY_RUN) {
    console.log(`\n💡 Para aplicar cambios reales: node scripts/migrate-sku.js`);
  } else {
    console.log(`\n✅ Migración completada. SKU y barcode ya NO serán modificados por dropi-sync.js`);
  }
}

run().catch(console.error);
