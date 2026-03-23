import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

const __dir = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const env = readFileSync(resolve(__dir, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const [k, ...v] = line.split('=');
    if (k?.trim() && v.length) process.env[k.trim()] = v.join('=').trim();
  }
}
loadEnv();

const SHOPIFY_STORE    = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN    = process.env.SHOPIFY_TOKEN;
const ML_CLIENT_ID     = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const ML_USER_TOKEN    = process.env.ML_USER_TOKEN;
const ML_SITE_ID       = process.env.ML_SITE_ID || 'MLC';
const ML_USER_ID       = process.env.ML_USER_ID;
const MAPPING_FILE     = resolve(__dir, '../ml-mapping.json');
const PROCESSED_FILE   = resolve(__dir, '../ml-processed-orders.json');
const SHEET_ID         = process.env.GOOGLE_SHEET_ID;
const CREDS_FILE       = resolve(__dir, '../el-estante-cl.json');

const SHOPIFY_HEADS = { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' };

// Sheet names
const SHEET_PRODUCTS = 'Productos';
const SHEET_ORDERS   = 'Órdenes';
const SHEET_LOG      = 'Log';

function loadMapping() {
  if (existsSync(MAPPING_FILE)) return JSON.parse(readFileSync(MAPPING_FILE, 'utf8'));
  return {};
}
function saveMapping(m) { writeFileSync(MAPPING_FILE, JSON.stringify(m, null, 2)); }
function loadProcessed() {
  if (existsSync(PROCESSED_FILE)) return new Set(JSON.parse(readFileSync(PROCESSED_FILE, 'utf8')));
  return new Set();
}
function saveProcessed(s) { writeFileSync(PROCESSED_FILE, JSON.stringify([...s], null, 2)); }

// ── Google Sheets ─────────────────────────────────────────────────────────────
let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  if (!existsSync(CREDS_FILE)) { console.log('  ⚠️  Sin credenciales Google Sheets'); return null; }
  const creds = JSON.parse(readFileSync(CREDS_FILE, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

async function sheetsAppend(sheetName, values) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets || !SHEET_ID) return;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values }
    });
  } catch (e) {
    console.log(`  ⚠️  Sheets error: ${e.message}`);
  }
}

async function sheetsClear(sheetName) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets || !SHEET_ID) return;
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A2:Z5000`
    });
  } catch (e) {
    console.log(`  ⚠️  Sheets clear error: ${e.message}`);
  }
}

async function sheetsUpdate(sheetName, values) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets || !SHEET_ID) return;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });
  } catch (e) {
    console.log(`  ⚠️  Sheets update error: ${e.message}`);
  }
}

async function logToSheet(nivel, accion, detalle) {
  const now = new Date().toLocaleString('es-CL');
  await sheetsAppend(SHEET_LOG, [[now, nivel, accion, detalle]]);
}

// ── Tokens ────────────────────────────────────────────────────────────────────
async function getMLToken() {
  if (ML_USER_TOKEN) return ML_USER_TOKEN;
  const res = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: ML_CLIENT_ID, client_secret: ML_CLIENT_SECRET })
  });
  const data = await res.json();
  return data.access_token;
}

// ── Shopify ───────────────────────────────────────────────────────────────────
async function getShopifyProducts() {
  // Trae activos y borradores — el usuario controla el estado manualmente
  const [r1, r2] = await Promise.all([
    fetch(`https://${SHOPIFY_STORE}/admin/api/2024-10/products.json?limit=250&status=active`, { headers: SHOPIFY_HEADS }),
    fetch(`https://${SHOPIFY_STORE}/admin/api/2024-10/products.json?limit=250&status=draft`, { headers: SHOPIFY_HEADS })
  ]);
  const [{ products: active }, { products: drafts }] = await Promise.all([r1.json(), r2.json()]);
  return [...(active || []), ...(drafts || [])];
}

// ── Costo Dropi desde inventory items ────────────────────────────────────────
async function fetchDropiCosts(products) {
  const costs = {};
  const ids = products.flatMap(p => p.variants.map(v => v.inventory_item_id)).filter(Boolean);
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100).join(',');
    try {
      const res = await fetch(
        `https://${SHOPIFY_STORE}/admin/api/2024-10/inventory_items.json?ids=${batch}`,
        { headers: SHOPIFY_HEADS }
      );
      const { inventory_items } = await res.json();
      for (const item of (inventory_items || [])) {
        if (item.cost) costs[item.id] = Math.round(parseFloat(item.cost));
      }
    } catch { /* sin costo */ }
  }
  return costs; // inventory_item_id → costo
}


// ── 1. SYNC STOCK SHOPIFY ─────────────────────────────────────────────────────
async function syncShopifyStock(products) {
  const conStock = products.filter(p => p.variants.reduce((s, v) => s + (v.inventory_quantity || 0), 0) > 0).length;
  console.log(`  📦 ${products.length} productos | ${conStock} con stock`);
}

// ── Comisión ML: 14% + $700 fijo ─────────────────────────────────────────────
const ML_COMMISSION = 0.14;
const ML_FIXED_FEE  = 700;

// Precio mínimo a publicar en ML para no perder plata
function mlMinPrice(basePrice) {
  return Math.ceil((basePrice + ML_FIXED_FEE) / (1 - ML_COMMISSION));
}

// Lo que realmente recibes después de la comisión
function mlNetReceived(mlPrice) {
  return Math.round(mlPrice * (1 - ML_COMMISSION) - ML_FIXED_FEE);
}

// Comisión total cobrada por ML
function mlCommission(mlPrice) {
  return Math.round(mlPrice * ML_COMMISSION + ML_FIXED_FEE);
}

// Redondea al número limpio más cercano: X.000, X.500, X.490, X.990
// Si hay empate de distancia, prefiere el número redondo (X000/X500)
function attractivePrice(price) {
  const lo = Math.floor(price / 500) * 500;
  const hi = Math.ceil(price / 500) * 500;
  const candidates = [...new Set([lo, lo - 10, hi, hi - 10])].filter(c => c > 0);
  candidates.sort((a, b) => {
    const da = Math.abs(price - a);
    const db = Math.abs(price - b);
    if (da !== db) return da - db;
    return (a % 500 === 0 ? 0 : 1) - (b % 500 === 0 ? 0 : 1);
  });
  return candidates[0];
}

const MIN_VALID_PRICE = 500; // Precios bajo este valor son placeholders de Dropi

// ── 2. PRECIO COMPETITIVO ML (con comisión incluida) ──────────────────────────
// Retorna { mlPrice, competitorMedian } — la competencia informa ambos precios
async function getMLPriceData(title, basePrice, token) {
  const minML = mlMinPrice(basePrice);
  try {
    const myIds = new Set(Object.values(loadMapping()).filter(id => !id.startsWith('DRY_')));
    const res = await fetch(
      `https://api.mercadolibre.com/sites/${ML_SITE_ID}/search?q=${encodeURIComponent(title)}&limit=10&sort=sold_quantity_desc`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    const results = (data.results || []).filter(r => r.price > 0 && !myIds.has(r.id));
    if (!results.length) return { mlPrice: attractivePrice(minML), median: null };

    const sorted = results.map(r => r.price).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const competitive = Math.round(median * 0.95);          // 5% bajo la mediana
    const mlPrice = attractivePrice(Math.max(competitive, minML));
    return { mlPrice, median };
  } catch {
    return { mlPrice: attractivePrice(minML), median: null };
  }
}

// ── 3. SYNC PRECIOS (web + ML) ────────────────────────────────────────────────
// Una sola llamada a ML por producto:
//   1. Consulta competencia → decide precio ML atractivo
//   2. Deriva precio web desde lo que se neta en ML
//   3. Actualiza Shopify si el precio web cambió
//   4. Actualiza/publica en ML
async function syncPricesAndListings(products, token) {
  const mapping = loadMapping();
  let mlUpdated = 0, mlPaused = 0, mlPublished = 0, webUpdated = 0;

  for (const p of products) {
    const pid   = String(p.id);
    const stock = p.variants.reduce((s, v) => s + (v.inventory_quantity || 0), 0);
    const currentWeb = Math.round(parseFloat(p.variants[0]?.price || 0));
    const mlId  = mapping[pid];

    // Precio inválido de Dropi ($1, $30, etc.) — saltar
    if (currentWeb < MIN_VALID_PRICE) {
      console.log(`  ⚠️  Precio pendiente: ${p.title} ($${currentWeb}) — omitido`);
      await logToSheet('WARN', 'Precio pendiente', `${p.title}: $${currentWeb} — configurar en Dropi`);
      continue;
    }

    // Sin stock: solo pausar ML si estaba publicado
    if (stock === 0) {
      if (mlId && !mlId.startsWith('DRY_')) {
        await fetch(`https://api.mercadolibre.com/items/${mlId}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'paused' })
        });
        mlPaused++;
        console.log(`  ⏸  ML pausado: ${p.title}`);
        await logToSheet('INFO', 'ML Pausado', `${p.title} | ${mlId}`);
      }
      await new Promise(r => setTimeout(r, 200));
      continue;
    }

    // Consulta competencia → precio ML atractivo
    const { mlPrice, median } = await getMLPriceData(p.title, currentWeb, token);

    // Precio web: derivado del neto que se recibe del precio ML competitivo
    // Límites: no bajar más del 10% ni subir más del 30% del precio actual
    const netFromML   = mlNetReceived(mlPrice);
    const rawWebPrice = attractivePrice(netFromML);
    const newWeb = Math.min(
      Math.max(rawWebPrice, Math.round(currentWeb * 0.9)),
      Math.round(currentWeb * 1.3)
    );

    const competMsg = median ? ` (competencia mediana: $${median.toLocaleString('es-CL')})` : '';

    // Actualizar precio web en Shopify si cambió
    if (newWeb !== currentWeb && p.variants[0]?.id) {
      await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-10/variants/${p.variants[0].id}.json`, {
        method: 'PUT', headers: SHOPIFY_HEADS,
        body: JSON.stringify({ variant: { id: p.variants[0].id, price: String(newWeb) } })
      });
      webUpdated++;
      console.log(`  💲 Web: ${p.title} $${currentWeb.toLocaleString('es-CL')} → $${newWeb.toLocaleString('es-CL')}${competMsg}`);
      await logToSheet('INFO', 'Precio web', `${p.title}: $${currentWeb.toLocaleString('es-CL')} → $${newWeb.toLocaleString('es-CL')}${competMsg}`);
    }

    // Actualizar ML si ya estaba publicado
    if (mlId && !mlId.startsWith('DRY_')) {
      await fetch(`https://api.mercadolibre.com/items/${mlId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ available_quantity: stock, price: mlPrice, status: 'active' })
      });
      if (p.images?.[0]?.src) {
        await fetch(`https://api.mercadolibre.com/items/${mlId}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ pictures: [{ source: p.images[0].src }] })
        });
      }
      mlUpdated++;
      console.log(`  ✅ ML: ${p.title} | stock:${stock} | $${mlPrice.toLocaleString('es-CL')}${competMsg}`);
      await logToSheet('INFO', 'ML Actualizado', `${p.title} | stock:${stock} | ML $${mlPrice.toLocaleString('es-CL')} | web $${newWeb.toLocaleString('es-CL')}`);

    // Publicar nuevo en ML
    } else if (!mlId) {
      try {
        const catRes = await fetch(
          `https://api.mercadolibre.com/sites/${ML_SITE_ID}/domain_discovery/search?q=${encodeURIComponent(p.title.slice(0,60))}&limit=1`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const catData = await catRes.json();
        const categoryId = catData[0]?.category_id;
        if (!categoryId) { await new Promise(r => setTimeout(r, 300)); continue; }

        const body = {
          title: p.title.slice(0, 60), category_id: categoryId,
          price: mlPrice, currency_id: 'CLP', available_quantity: stock,
          buying_mode: 'buy_it_now', condition: 'new', listing_type_id: 'gold_special',
          description: { plain_text: p.body_html?.replace(/<[^>]*>/g, '') || p.title },
          tags: ['immediate_payment'],
          shipping: { mode: 'me2', local_pick_up: false, free_shipping: false },
          attributes: [
            { id: 'BRAND',       value_name: p.vendor || 'Genérico' },
            { id: 'PART_NUMBER', value_name: p.variants[0]?.sku || String(p.id) }
          ]
        };
        if (p.images?.[0]?.src) body.pictures = [{ source: p.images[0].src }];

        const res = await fetch('https://api.mercadolibre.com/items', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const item = await res.json();
        if (item.id) {
          mapping[pid] = item.id;
          saveMapping(mapping);
          mlPublished++;
          console.log(`  🆕 ML nuevo: ${p.title} → ${item.id} | $${mlPrice.toLocaleString('es-CL')}`);
          await logToSheet('INFO', 'ML Nuevo', `${p.title} → ${item.id} | $${mlPrice.toLocaleString('es-CL')}`);
        }
      } catch (e) {
        console.log(`  ❌ Error publicando ${p.title}: ${e.message}`);
        await logToSheet('ERROR', 'ML Publicar', `${p.title}: ${e.message}`);
      }
    }

    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`  🛒 ML: ${mlPublished} nuevos | ${mlUpdated} actualizados | ${mlPaused} pausados`);
  console.log(`  💲 Web: ${webUpdated} precios ajustados por competencia`);
  return { mlPublished, mlUpdated, mlPaused, webUpdated };
}

// ── 4. ÓRDENES ML → SHOPIFY ───────────────────────────────────────────────────
async function syncMLOrders(token) {
  const res = await fetch(
    `https://api.mercadolibre.com/orders/search?seller=${ML_USER_ID}&order.status=paid&sort=date_desc&limit=50`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  const orders = data.results || [];
  const processed = loadProcessed();
  const nuevas = orders.filter(o => !processed.has(String(o.id)));

  for (const order of nuevas) {
    try {
      const detail = await (await fetch(`https://api.mercadolibre.com/orders/${order.id}`, { headers: { Authorization: `Bearer ${token}` } })).json();
      const shipping = detail.shipping?.id ? await (await fetch(`https://api.mercadolibre.com/shipments/${detail.shipping.id}`, { headers: { Authorization: `Bearer ${token}` } })).json() : null;
      const buyer = detail.buyer;
      const addr = shipping?.receiver_address;

      const lineItems = detail.order_items.map(item => ({
        title: item.item.title, quantity: item.quantity, price: item.unit_price
      }));

      const shippingAddress = {
        first_name: buyer.first_name || buyer.nickname || 'Cliente ML',
        last_name: buyer.last_name || '',
        address1: addr ? `${addr.street_name || ''} ${addr.street_number || ''}`.trim() : 'Por confirmar',
        city: addr?.city?.name || 'Chile', country: 'CL', zip: addr?.zip_code || ''
      };

      const shopifyOrder = {
        order: {
          line_items: lineItems, financial_status: 'paid',
          source_name: 'MercadoLibre', note: `ML #${order.id}`, tags: 'mercadolibre',
          customer: { first_name: shippingAddress.first_name, last_name: shippingAddress.last_name, email: buyer.email || `ml-${buyer.id}@noreply.com` },
          shipping_address: shippingAddress, billing_address: shippingAddress,
          transactions: [{ kind: 'sale', status: 'success', amount: detail.total_amount, gateway: 'MercadoLibre' }]
        }
      };

      const shopifyRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-10/orders.json`, {
        method: 'POST', headers: SHOPIFY_HEADS, body: JSON.stringify(shopifyOrder)
      });
      const shopifyData = await shopifyRes.json();
      const shopifyId = shopifyData.order?.id;

      processed.add(String(order.id));
      saveProcessed(processed);
      console.log(`  📦 Orden ML #${order.id} → Shopify #${shopifyId}`);

      // Registrar orden en Google Sheets
      const now = new Date().toLocaleString('es-CL');
      const items = lineItems.map(i => `${i.title} x${i.quantity}`).join(' | ');
      await sheetsAppend(SHEET_ORDERS, [[
        now,
        String(order.id),
        String(shopifyId || ''),
        `${shippingAddress.first_name} ${shippingAddress.last_name}`.trim(),
        buyer.email || `ml-${buyer.id}@noreply.com`,
        items,
        `$${detail.total_amount?.toLocaleString('es-CL') || 0}`,
        'Pagado',
        'MercadoLibre',
        addr?.city?.name || 'Chile'
      ]]);
      await logToSheet('INFO', 'Orden ML→Shopify', `ML #${order.id} → Shopify #${shopifyId} | ${items}`);
    } catch (e) {
      console.log(`  ❌ Orden ML #${order.id}: ${e.message}`);
      await logToSheet('ERROR', 'Orden ML', `#${order.id}: ${e.message}`);
    }
  }
  if (nuevas.length === 0) console.log(`  📬 Sin órdenes nuevas en ML`);
  return nuevas.length;
}

// ── 5. ACTUALIZAR HOJA PRODUCTOS (incremental) ───────────────────────────────
async function updateProductsSheet(products, dropiCosts) {
  const sheets = await getSheetsClient();
  if (!sheets || !SHEET_ID) return;

  const mapping = loadMapping();
  const now = new Date().toLocaleString('es-CL');

  // Traer borradores también
  const draftRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-10/products.json?limit=250&status=draft`, { headers: SHOPIFY_HEADS });
  const { products: drafts } = await draftRes.json();
  const allProducts = [...products, ...(drafts || [])];

  // Leer estado actual del sheet (valores sin formatear para comparación exacta)
  let existingRows = [];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_PRODUCTS}!A1:H1000`,
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    existingRows = res.data.values || [];
  } catch { /* vacío */ }

  // Mapa: shopifyId → número de fila (1-based)
  const rowMap = {};
  for (let i = 2; i < existingRows.length; i++) {
    const id = existingRows[i]?.[0];
    if (id) rowMap[id] = i + 1;
  }

  const updates = [];
  const newRows = [];

  // Siempre actualizar timestamp (A1)
  updates.push({ range: `${SHEET_PRODUCTS}!A1`, values: [['Última actualización: ' + now]] });

  // Cabecera si no existe o cambió estructura
  const HEADERS = ['ID Shopify', 'Producto', 'Stock', 'Costo Dropi', 'P. Sugerido Dropi', 'Precio Web', 'Precio ML', 'Comisión ML', 'Neto recibido', 'Estado', 'ID MercadoLibre', 'URL ML'];
  if (existingRows[1]?.[0] !== 'ID Shopify' || existingRows[1]?.length !== HEADERS.length) {
    updates.push({ range: `${SHEET_PRODUCTS}!A2:L2`, values: [HEADERS] });
  }

  for (const p of allProducts) {
    const pid = String(p.id);
    const stock      = p.variants.reduce((s, v) => s + (v.inventory_quantity || 0), 0);
    const webPrice   = Math.round(parseFloat(p.variants[0]?.price || 0));
    const suggested  = Math.round(parseFloat(p.variants[0]?.compare_at_price || 0));
    const invItemId  = p.variants[0]?.inventory_item_id;
    const cost       = dropiCosts[invItemId] || '';
    const mlId       = mapping[pid] || '';
    const mlUrl      = mlId && !mlId.startsWith('DRY_') ? `https://articulo.mercadolibre.cl/${mlId.replace(/^([A-Z]+)(\d)/, '$1-$2')}` : '';
    const publishedML = mlId && !mlId.startsWith('DRY_');
    const mlPrice    = publishedML ? attractivePrice(mlMinPrice(webPrice)) : '';
    const commission = publishedML ? mlCommission(mlPrice) : '';
    const net        = publishedML ? mlNetReceived(mlPrice) : '';

    const precioInvalido = webPrice < MIN_VALID_PRICE;
    const estado = precioInvalido ? '⚠️ Precio pendiente' : (p.status === 'active' ? 'Activo' : 'Borrador');

    const newRow = [
      pid,
      p.title,
      String(stock),
      String(cost),
      suggested ? String(suggested) : '',
      String(webPrice),
      precioInvalido ? '' : String(mlPrice),
      precioInvalido ? '' : String(commission),
      precioInvalido ? '' : String(net),
      estado,
      mlId,
      mlUrl
    ];

    if (rowMap[pid]) {
      // Comparar campos que cambian: Stock(2), Costo(3), Precio Web(5), Precio ML(6), Estado(9), ML ID(10)
      const existing = (existingRows[rowMap[pid] - 1] || []).map(String);
      const changed = [2, 3, 5, 6, 9, 10].some(i => newRow[i] !== (existing[i] || ''));
      if (changed) {
        updates.push({ range: `${SHEET_PRODUCTS}!A${rowMap[pid]}:L${rowMap[pid]}`, values: [newRow] });
      }
    } else {
      newRows.push(newRow);
    }
  }

  // Batch update de filas modificadas
  const dataUpdates = updates.filter(u => !u.range.endsWith('!A1') && !u.range.includes('!A2:L2'));
  if (updates.length > 0) {
    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { valueInputOption: 'RAW', data: updates }
      });
    } catch (e) {
      console.log(`  ⚠️  Sheets batchUpdate error: ${e.message}`);
    }
  }

  // Append productos nuevos
  if (newRows.length > 0) {
    await sheetsAppend(SHEET_PRODUCTS, newRows);
  }

  console.log(`  📊 Sheets: ${dataUpdates.length} actualizados, ${newRows.length} nuevos`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function run() {
  const now = new Date().toLocaleString('es-CL');
  console.log(`\n🔄 AUTO-SYNC | ${now}`);
  console.log('━'.repeat(50));

  await logToSheet('INFO', 'Inicio Sync', now);

  const token = await getMLToken();
  const products = await getShopifyProducts();
  const dropiCosts = await fetchDropiCosts(products);

  console.log('\n[1/4] Sync stock Shopify...');
  await syncShopifyStock(products);

  console.log('\n[2/4] Sync precios (competencia ML → web + ML)...');
  await syncPricesAndListings(products, token);

  console.log('\n[3/4] Órdenes ML → Shopify...');
  await syncMLOrders(token);

  console.log('\n[4/4] Actualizando Google Sheets...');
  const freshProducts = await getShopifyProducts();
  await updateProductsSheet(freshProducts, dropiCosts);

  await logToSheet('INFO', 'Fin Sync', `OK — ${freshProducts.length} productos`);
  console.log('\n✅ Sync completado.');
}

run().catch(async (e) => {
  console.error(e);
  await logToSheet('ERROR', 'Sync Fatal', e.message).catch(() => {});
});
