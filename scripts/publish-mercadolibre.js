import { readFileSync, writeFileSync, existsSync } from 'fs';
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

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const ML_CLIENT_ID = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const ML_SITE_ID = process.env.ML_SITE_ID || 'MLC';
const ML_USER_ID = process.env.ML_USER_ID;
const ML_USER_TOKEN = process.env.ML_USER_TOKEN;
const DRY_RUN = process.argv.includes('--dry-run');
const MAPPING_FILE = resolve(__dir, '../ml-mapping.json');

// Cargar mapping existente (shopify_id → ml_id)
function loadMapping() {
  if (existsSync(MAPPING_FILE)) return JSON.parse(readFileSync(MAPPING_FILE, 'utf8'));
  return {};
}
function saveMapping(map) {
  writeFileSync(MAPPING_FILE, JSON.stringify(map, null, 2));
}

// Token MercadoLibre
async function getMLToken() {
  if (ML_USER_TOKEN) return ML_USER_TOKEN;
  const res = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token ML fallido: ' + JSON.stringify(data));
  return data.access_token;
}

// Productos Shopify con stock
async function getShopifyProducts() {
  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2024-10/products.json?limit=250&status=active`,
    { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
  );
  const { products } = await res.json();
  return products.filter(p =>
    p.variants.some(v => v.inventory_quantity > 0)
  );
}

// Predecir categoría ML desde título
async function predictCategory(title, token) {
  const res = await fetch(
    `https://api.mercadolibre.com/sites/${ML_SITE_ID}/domain_discovery/search?q=${encodeURIComponent(title)}&limit=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data[0]?.category_id || null;
}

// Publicar producto en ML
async function publishProduct(product, token) {
  const variant = product.variants.find(v => v.inventory_quantity > 0);
  const price = Math.round(parseFloat(variant.price));
  const qty = variant.inventory_quantity;
  const title = product.title.slice(0, 60);

  const categoryId = await predictCategory(title, token);
  if (!categoryId) throw new Error(`No se encontró categoría para: ${title}`);

  const brand = product.vendor || 'Genérico';
  const partNumber = variant.sku || '';

  const body = {
    title,
    category_id: categoryId,
    price,
    currency_id: 'CLP',
    available_quantity: qty,
    buying_mode: 'buy_it_now',
    condition: 'new',
    listing_type_id: 'gold_special',
    description: { plain_text: product.body_html?.replace(/<[^>]*>/g, '') || title },
    tags: ['immediate_payment'],
    shipping: { mode: 'me2', local_pick_up: false, free_shipping: false },
    attributes: [
      { id: 'BRAND', value_name: brand },
      ...(partNumber ? [{ id: 'PART_NUMBER', value_name: partNumber }] : [])
    ]
  };

  // Agregar imagen si existe
  if (product.images?.length > 0) {
    body.pictures = [{ source: product.images[0].src }];
  }

  if (DRY_RUN) {
    console.log(`  🧪 [DRY] ${title} → cat:${categoryId} $${price.toLocaleString('es-CL')} qty:${qty}`);
    return { id: 'DRY_' + product.id };
  }

  const res = await fetch('https://api.mercadolibre.com/items', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`ML error ${res.status}: ${JSON.stringify(data.cause || data)}`);
  return data;
}

async function run() {
  console.log('\n🛒 Publicador Shopify → MercadoLibre');
  if (DRY_RUN) console.log('🧪 Modo DRY-RUN — no se publicará nada\n');

  const token = await getMLToken();
  console.log('✅ Token ML obtenido\n');

  const products = await getShopifyProducts();
  console.log(`📦 Productos Shopify con stock: ${products.length}`);

  const mapping = loadMapping();
  let published = 0, skipped = 0, errors = 0;

  for (const product of products) {
    const pid = String(product.id);
    if (mapping[pid]) {
      console.log(`  ⏭  Ya publicado: ${product.title} → ${mapping[pid]}`);
      skipped++;
      continue;
    }

    try {
      const item = await publishProduct(product, token);
      mapping[pid] = item.id;
      published++;
      if (!DRY_RUN) {
        console.log(`  ✅ ${product.title} → https://articulo.mercadolibre.cl/${item.id}`);
      }
    } catch (err) {
      console.log(`  ❌ ${product.title}: ${err.message}`);
      errors++;
    }

    // Pausa para evitar rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  if (!DRY_RUN) saveMapping(mapping);

  console.log(`\n📊 Resultado:`);
  console.log(`  ✅ Publicados : ${published}`);
  console.log(`  ⏭  Ya existían: ${skipped}`);
  console.log(`  ❌ Errores    : ${errors}`);
  console.log('\n🎉 Listo.');
}

run().catch(console.error);
