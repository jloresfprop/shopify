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

const SHOPIFY_STORE  = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN  = process.env.SHOPIFY_TOKEN;
const ML_CLIENT_ID   = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const ML_USER_ID     = process.env.ML_USER_ID;
const PROCESSED_FILE = resolve(__dir, '../ml-processed-orders.json');
const POLL_INTERVAL  = 2 * 60 * 1000; // 2 minutos
const DRY_RUN        = process.argv.includes('--dry-run');

const SHOPIFY_HEADS = {
  'X-Shopify-Access-Token': SHOPIFY_TOKEN,
  'Content-Type': 'application/json'
};

function loadProcessed() {
  if (existsSync(PROCESSED_FILE)) return new Set(JSON.parse(readFileSync(PROCESSED_FILE, 'utf8')));
  return new Set();
}
function saveProcessed(set) {
  writeFileSync(PROCESSED_FILE, JSON.stringify([...set], null, 2));
}

// ── MercadoLibre ─────────────────────────────────────────────────────────────

async function getMLToken() {
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

async function getMLOrders(token) {
  const res = await fetch(
    `https://api.mercadolibre.com/orders/search?seller=${ML_USER_ID}&order.status=paid&sort=date_desc&limit=50`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.results || [];
}

async function getMLOrderDetail(orderId, token) {
  const res = await fetch(
    `https://api.mercadolibre.com/orders/${orderId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.json();
}

async function getMLShipping(shippingId, token) {
  if (!shippingId) return null;
  const res = await fetch(
    `https://api.mercadolibre.com/shipments/${shippingId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.json();
}

// ── Shopify ───────────────────────────────────────────────────────────────────

async function findShopifyVariant(mlItemTitle) {
  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2024-10/products.json?title=${encodeURIComponent(mlItemTitle)}&fields=id,title,variants`,
    { headers: SHOPIFY_HEADS }
  );
  const { products } = await res.json();
  if (!products?.length) return null;
  return products[0].variants[0];
}

async function createShopifyOrder(mlOrder, shipping) {
  const buyer = mlOrder.buyer;
  const items = mlOrder.order_items;

  // Construir line items
  const lineItems = [];
  for (const item of items) {
    const variant = await findShopifyVariant(item.item.title);
    if (variant) {
      lineItems.push({ variant_id: variant.id, quantity: item.quantity, price: item.unit_price });
    } else {
      lineItems.push({ title: item.item.title, quantity: item.quantity, price: item.unit_price });
    }
  }

  // Dirección de envío
  const addr = shipping?.receiver_address;
  const shippingAddress = addr ? {
    first_name: buyer.first_name || buyer.nickname || 'Cliente',
    last_name:  buyer.last_name  || 'ML',
    address1:   `${addr.street_name || ''} ${addr.street_number || ''}`.trim() || 'Dirección pendiente',
    city:       addr.city?.name || addr.state?.name || 'Chile',
    country:    'CL',
    zip:        addr.zip_code || '',
    phone:      buyer.phone?.number || ''
  } : {
    first_name: buyer.first_name || buyer.nickname || 'Cliente ML',
    last_name:  buyer.last_name  || '',
    address1:   'Dirección por confirmar',
    city:       'Chile',
    country:    'CL'
  };

  const order = {
    order: {
      line_items: lineItems,
      financial_status: 'paid',
      fulfillment_status: null,
      source_name: 'MercadoLibre',
      note: `Orden ML #${mlOrder.id}`,
      tags: 'mercadolibre',
      customer: {
        first_name: buyer.first_name || buyer.nickname || 'Cliente',
        last_name:  buyer.last_name  || 'ML',
        email:      buyer.email      || `ml-${buyer.id}@noreply.com`
      },
      shipping_address: shippingAddress,
      billing_address: shippingAddress,
      transactions: [{
        kind: 'sale',
        status: 'success',
        amount: mlOrder.total_amount,
        gateway: 'MercadoLibre'
      }]
    }
  };

  if (DRY_RUN) {
    console.log(`  🧪 [DRY] Orden ML #${mlOrder.id} → Shopify:`);
    console.log(`     Cliente: ${shippingAddress.first_name} ${shippingAddress.last_name}`);
    console.log(`     Items: ${lineItems.map(i => i.title || `variant:${i.variant_id}`).join(', ')}`);
    console.log(`     Total: $${mlOrder.total_amount?.toLocaleString('es-CL')}`);
    return { id: 'DRY_' + mlOrder.id };
  }

  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2024-10/orders.json`,
    { method: 'POST', headers: SHOPIFY_HEADS, body: JSON.stringify(order) }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Shopify error ${res.status}: ${JSON.stringify(data.errors)}`);
  return data.order;
}

// ── Loop principal ────────────────────────────────────────────────────────────

async function checkOrders() {
  const now = new Date().toLocaleTimeString('es-CL');
  console.log(`\n[${now}] Revisando órdenes ML...`);

  const token = await getMLToken();
  const orders = await getMLOrders(token);
  const processed = loadProcessed();

  const nuevas = orders.filter(o => !processed.has(String(o.id)));
  console.log(`  📬 Órdenes pagadas: ${orders.length} | Nuevas: ${nuevas.length}`);

  for (const order of nuevas) {
    try {
      const detail   = await getMLOrderDetail(order.id, token);
      const shipping = await getMLShipping(detail.shipping?.id, token);
      const shopifyOrder = await createShopifyOrder(detail, shipping);

      processed.add(String(order.id));
      if (!DRY_RUN) saveProcessed(processed);

      console.log(`  ✅ ML #${order.id} → Shopify #${shopifyOrder.id} | Dropi procesará automáticamente`);
    } catch (err) {
      console.log(`  ❌ ML #${order.id}: ${err.message}`);
    }
  }
}

async function run() {
  console.log('🔗 Bridge MercadoLibre → Shopify → Dropi');
  console.log(`⏱  Revisando cada ${POLL_INTERVAL / 60000} minutos`);
  if (DRY_RUN) console.log('🧪 Modo DRY-RUN activo\n');

  await checkOrders();

  if (!DRY_RUN) {
    setInterval(checkOrders, POLL_INTERVAL);
    console.log('\n✅ Bridge activo. Ctrl+C para detener.');
  }
}

run().catch(console.error);
