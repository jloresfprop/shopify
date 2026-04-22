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

// WhatsApp vía Green API (gratis 500 msg/mes — green-api.com)
const WA_INSTANCE = process.env.WHATSAPP_INSTANCE_ID;
const WA_TOKEN    = process.env.WHATSAPP_TOKEN;
const WA_PHONE    = process.env.WHATSAPP_PHONE;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text: msg })
    });
  } catch (_) {}
}

async function sendWhatsApp(msg) {
  if (!WA_INSTANCE || !WA_TOKEN || !WA_PHONE) return;
  try {
    await fetch(`https://api.green-api.com/waInstance${WA_INSTANCE}/sendMessage/${WA_TOKEN}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: `${WA_PHONE}@c.us`, message: msg })
    });
  } catch (_) {}
}

async function notify(msg) {
  await Promise.all([sendTelegram(msg), sendWhatsApp(msg)]);
}

const DROPI_TOKEN = process.env.DROPI_USER_TOKEN;
const DROPI_HEADS = DROPI_TOKEN ? {
  'x-authorization': `Bearer ${DROPI_TOKEN}`,
  'Content-Type': 'application/json',
  'Origin': 'https://app.dropi.cl',
  'Referer': 'https://app.dropi.cl/'
} : {};

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

// Busca la variante Shopify primero por mapping (ML item ID → Shopify product),
// y solo como fallback por título (poco confiable con nombres similares).
async function findShopifyVariant(mlItemId, mlItemTitle) {
  // Intento 1: mapping exacto ML item ID → Shopify product ID
  const mapping = loadMapping();
  const shopifyProductId = Object.keys(mapping).find(
    k => getMlId(mapping[k]) === String(mlItemId)
  );
  if (shopifyProductId) {
    try {
      const res = await fetch(
        `https://${SHOPIFY_STORE}/admin/api/2024-10/products/${shopifyProductId}.json?fields=id,variants`,
        { headers: SHOPIFY_HEADS }
      );
      const { product } = await res.json();
      if (product?.variants?.length) return product.variants[0];
    } catch { }
  }

  // Fallback: búsqueda por título (imprecisa, solo si no hay mapping)
  console.log(`  ⚠️  ML item ${mlItemId} no está en mapping — buscando por título`);
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
    const variant = await findShopifyVariant(item.item.id, item.item.title);
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

// ── Dropi ─────────────────────────────────────────────────────────────────────

const MAPPING_FILE = resolve(__dir, '../ml-mapping.json');
function loadMapping() {
  if (existsSync(MAPPING_FILE)) return JSON.parse(readFileSync(MAPPING_FILE, 'utf8'));
  return {};
}
function getMlId(val) { return typeof val === 'object' ? val?.id : val; }

// Verifica en Shopify que no exista ya la orden (anti-duplicado)
async function shopifyOrderExistsByMLId(mlOrderId) {
  try {
    const res = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-10/orders.json?status=any&fields=id,note&limit=250`,
      { headers: SHOPIFY_HEADS }
    );
    const data = await res.json();
    return (data.orders || []).some(o => o.note?.includes(`ML #${mlOrderId}`) || o.note?.includes(`Orden ML #${mlOrderId}`));
  } catch { return false; }
}

// Busca Dropi product ID por ML item ID (mapping inverso + metafield)
async function getDropiProductIdForMLItem(mlItemId) {
  try {
    const mapping = loadMapping();
    const shopifyProductId = Object.keys(mapping).find(
      k => getMlId(mapping[k]) === String(mlItemId)
    );
    if (!shopifyProductId) return null;
    const res = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-10/products/${shopifyProductId}/metafields.json`,
      { headers: SHOPIFY_HEADS }
    );
    const { metafields } = await res.json();
    const meta = metafields?.find(m => m.namespace === 'dropi' && m.key === '_dropi_product');
    if (!meta) return null;
    const dropi = JSON.parse(meta.value);
    return dropi.id || null;
  } catch { return null; }
}

// Crea orden en Dropi
async function createDropiOrder(mlOrderId, detail, shipping) {
  if (!DROPI_TOKEN) {
    console.log('  ⚠️  DROPI_USER_TOKEN no configurado — omitiendo creación en Dropi');
    return null;
  }
  const buyer = detail.buyer;
  const addr  = shipping?.receiver_address;
  const products = [];
  for (const item of detail.order_items) {
    const dropiId = await getDropiProductIdForMLItem(item.item.id);
    if (dropiId) products.push({ id: dropiId, quantity: item.quantity });
    else console.log(`  ⚠️  Sin producto Dropi para ML item ${item.item.id}`);
  }
  if (products.length === 0) {
    console.log(`  ⚠️  ML #${mlOrderId}: sin productos Dropi — no se crea orden`);
    return null;
  }
  const payload = {
    products,
    customer: {
      name:    `${buyer.first_name || buyer.nickname || 'Cliente'} ${buyer.last_name || ''}`.trim(),
      phone:   buyer.phone?.number || '',
      email:   buyer.email || `ml-${buyer.id}@noreply.com`,
      address: addr ? `${addr.street_name || ''} ${addr.street_number || ''}`.trim() : 'Por confirmar',
      city:    addr?.city?.name || addr?.state?.name || 'Chile',
      commune: addr?.city?.name || addr?.state?.name || 'Chile'
    },
    note: `ML #${mlOrderId}`
  };
  try {
    const res  = await fetch('https://api.dropi.cl/integrations/orders/', {
      method: 'POST', headers: DROPI_HEADS, body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) { console.log(`  ❌ Dropi error ${res.status}: ${JSON.stringify(data)}`); return null; }
    console.log(`  🚚 Dropi orden creada: #${data.id || data.object?.id || JSON.stringify(data)}`);
    return data;
  } catch (e) {
    console.log(`  ❌ Dropi excepción: ${e.message}`);
    return null;
  }
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
      // Segunda capa anti-duplicado: verificar en Shopify
      if (!DRY_RUN) {
        const yaExiste = await shopifyOrderExistsByMLId(order.id);
        if (yaExiste) {
          console.log(`  ⚠️  Orden ML #${order.id} ya existe en Shopify — marcando procesada`);
          processed.add(String(order.id));
          saveProcessed(processed);
          continue;
        }
      }

      const detail   = await getMLOrderDetail(order.id, token);
      const shipping = await getMLShipping(detail.shipping?.id, token);
      const shopifyOrder = await createShopifyOrder(detail, shipping);

      processed.add(String(order.id));
      if (!DRY_RUN) saveProcessed(processed);

      console.log(`  ✅ ML #${order.id} → Shopify #${shopifyOrder.id}`);

      // Enviar a Dropi para despacho
      if (!DRY_RUN) {
        const dropiResult = await createDropiOrder(order.id, detail, shipping);
        const buyer = detail.buyer;
        const items = detail.order_items.map(i => `• ${i.item.title} x${i.quantity}`).join('\n');
        if (dropiResult) {
          await notify(
            `✅ Nueva venta MercadoLibre\n\nCliente: ${buyer.first_name || buyer.nickname} ${buyer.last_name || ''}\nTotal: $${detail.total_amount?.toLocaleString('es-CL')}\n\n${items}\n\nML #${order.id} → Shopify #${shopifyOrder.id}\nDropi: ✅ enviado`
          );
        } else {
          await notify(
            `⚠️ VENTA — REVISAR DROPI\n\nCliente: ${buyer.first_name || buyer.nickname} ${buyer.last_name || ''}\nTotal: $${detail.total_amount?.toLocaleString('es-CL')}\n\n${items}\n\nML #${order.id} → Shopify #${shopifyOrder.id}\nDropi: ❌ no se pudo enviar — intervenir manualmente`
          );
        }
      }
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
