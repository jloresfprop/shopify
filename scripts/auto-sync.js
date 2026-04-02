import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';

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
const MAPPING_FILE        = resolve(__dir, '../ml-mapping.json');
const PROCESSED_FILE      = resolve(__dir, '../ml-processed-orders.json');
const SHEET_ID            = process.env.GOOGLE_SHEET_ID;
const CREDS_FILE          = resolve(__dir, '../el-estante-cl.json');
const DROPI_PRODUCTS_FILE  = resolve(__dir, '../dropi-products.json');
const ML_IMAGES_CACHE_FILE = resolve(__dir, '../ml-images-cache.json');

function loadMLImagesCache() {
  if (existsSync(ML_IMAGES_CACHE_FILE)) return JSON.parse(readFileSync(ML_IMAGES_CACHE_FILE, 'utf8'));
  return {};
}
function saveMLImagesCache(cache) { writeFileSync(ML_IMAGES_CACHE_FILE, JSON.stringify(cache, null, 2)); }

const SHOPIFY_HEADS = { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' };

// Sheet names
const SHEET_PRODUCTS = 'Productos';
const SHEET_ORDERS   = 'Órdenes';
const SHEET_LOG      = 'Log';
const SHEET_AI       = 'IA Uso';

const TELEGRAM_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT   = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text: msg, parse_mode: 'HTML' })
    });
  } catch (_) {}
}

const AI_PRICING = {
  'claude-haiku-4-5':  { input: 1.00 / 1_000_000, output:  5.00 / 1_000_000 },
  'claude-sonnet-4-6': { input: 3.00 / 1_000_000, output: 15.00 / 1_000_000 }
};

// Acumulador de uso IA por ciclo de sync
const aiRunUsage = { input: 0, output: 0, costUsd: 0 };

// Flag global: si la IA falla por créditos, se desactiva para el resto del sync
let aiDisabled = false;
function checkAICreditsError(e) {
  if (e.message?.includes('credit balance is too low') || e.status === 400 && e.message?.includes('credit')) {
    if (!aiDisabled) {
      aiDisabled = true;
      console.log('  ⚠️  Sin créditos Anthropic — IA desactivada para este ciclo, usando lógica estándar');
    }
    return true;
  }
  return false;
}

function loadMapping() {
  if (existsSync(MAPPING_FILE)) return JSON.parse(readFileSync(MAPPING_FILE, 'utf8'));
  return {};
}
function saveMapping(m) { writeFileSync(MAPPING_FILE, JSON.stringify(m, null, 2)); }
// El mapping puede ser string (legacy) u objeto { id, price, stock }
function getMlId(val)    { return typeof val === 'object' ? val?.id    : val; }
function getMlPrice(val) { return typeof val === 'object' ? val?.price : null; }
function getMlStock(val) { return typeof val === 'object' ? val?.stock : null; }
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

// Google Sheets requiere comillas simples si el nombre tiene espacios
function sr(name) { return name.includes(' ') ? `'${name}'` : name; }

async function sheetsAppend(sheetName, values) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets || !SHEET_ID) return;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${sr(sheetName)}!A1`,
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
      range: `${sr(sheetName)}!A2:Z5000`
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
      range: `${sr(sheetName)}!A1`,
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

// ── IA Uso — contabilidad de tokens ──────────────────────────────────────────
async function ensureAISheet() {
  const sheets = await getSheetsClient();
  if (!sheets || !SHEET_ID) return;

  // Verificar si la pestaña existe; crearla si no
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const exists = meta.data.sheets?.some(s => s.properties.title === SHEET_AI);
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: SHEET_AI } } }] }
      });
      console.log(`  📋 Pestaña "${SHEET_AI}" creada`);
    }
  } catch (e) {
    console.log(`  ⚠️  ensureAISheet (crear pestaña): ${e.message}`);
    return;
  }

  // Verificar si ya tiene encabezados en fila 10
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${sr(SHEET_AI)}!A10`
    });
    if (res.data.values?.[0]?.[0] === 'Fecha ISO') return;
  } catch { }

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${sr(SHEET_AI)}!A10`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['Fecha ISO', 'Función', 'Modelo', 'Tokens entrada', 'Tokens salida', 'Costo USD']] }
    });
  } catch (e) {
    console.log(`  ⚠️  ensureAISheet: ${e.message}`);
  }
}

async function logAITokens(funcName, model, usage) {
  if (!usage) return;
  const p = AI_PRICING[model] || { input: 0, output: 0 };
  const costUsd = (usage.input_tokens || 0) * p.input + (usage.output_tokens || 0) * p.output;
  aiRunUsage.input   += usage.input_tokens || 0;
  aiRunUsage.output  += usage.output_tokens || 0;
  aiRunUsage.costUsd += costUsd;
  const now = new Date().toISOString();
  await sheetsAppend(SHEET_AI, [[
    now, funcName, model,
    usage.input_tokens || 0, usage.output_tokens || 0,
    costUsd.toFixed(6)
  ]]);
}

async function updateAIUsageSummary() {
  const sheets = await getSheetsClient();
  if (!sheets || !SHEET_ID) return;

  const now      = new Date();
  const today    = now.toISOString().slice(0, 10);  // YYYY-MM-DD
  const month    = now.toISOString().slice(0, 7);   // YYYY-MM
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonth = prevDate.toISOString().slice(0, 7);
  const budget   = parseFloat(process.env.AI_MONTHLY_BUDGET_USD || '10');
  const usdToClp = parseInt(process.env.USD_TO_CLP || '950', 10);

  let rows = [];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${sr(SHEET_AI)}!A11:G5000`
    });
    rows = res.data.values || [];
  } catch { }

  const sumOf = (filtered) => ({
    input:   filtered.reduce((s, r) => s + (parseInt(r[3])   || 0), 0),
    output:  filtered.reduce((s, r) => s + (parseInt(r[4])   || 0), 0),
    costUsd: filtered.reduce((s, r) => s + (parseFloat(r[5]) || 0), 0)
  });

  const tod = sumOf(rows.filter(r => r[0]?.startsWith(today)));
  const mon = sumOf(rows.filter(r => r[0]?.startsWith(month)));
  const prv = sumOf(rows.filter(r => r[0]?.startsWith(prevMonth)));
  const pct = budget > 0 ? (mon.costUsd / budget * 100).toFixed(1) : '0.0';

  const summary = [
    ['📊 IA Uso — Contabilidad de Tokens'],
    ['Presupuesto mensual', `$${budget} USD`],
    [],
    ['HOY', today],
    ['Tokens entrada', tod.input, 'Tokens salida', tod.output, 'Costo USD', `$${tod.costUsd.toFixed(4)}`],
    [],
    ['MES ACTUAL', month],
    ['Tokens entrada', mon.input, 'Tokens salida', mon.output, 'Costo USD', `$${mon.costUsd.toFixed(4)}`, '% presupuesto', `${pct}%`],
    [`Mes anterior (${prevMonth})`, '', 'Costo USD', `$${prv.costUsd.toFixed(4)}`]
  ];

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${sr(SHEET_AI)}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: summary }
    });
  } catch (e) {
    console.log(`  ⚠️  updateAIUsageSummary: ${e.message}`);
  }
}

// ── Tokens ────────────────────────────────────────────────────────────────────
function saveEnvVar(key, value) {
  const envPath = resolve(__dir, '../.env');
  let content = readFileSync(envPath, 'utf8');
  if (content.includes(`${key}=`)) {
    content = content.replace(new RegExp(`${key}=.*`), `${key}=${value}`);
  } else {
    content += `\n${key}=${value}`;
  }
  writeFileSync(envPath, content);
  process.env[key] = value;
}

function mlTokenExpiresSoon() {
  const token = process.env.ML_USER_TOKEN;
  if (!token) return true;
  // Usar timestamp guardado (para tokens opacos que no son JWT)
  const expiresAt = parseInt(process.env.ML_TOKEN_EXPIRES_AT || '0', 10);
  if (expiresAt > 0) {
    return Date.now() > expiresAt - 30 * 60 * 1000;
  }
  // Fallback: intentar decodificar JWT
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    if (payload.exp) return Date.now() > payload.exp * 1000 - 30 * 60 * 1000;
  } catch { }
  return true; // sin info de expiración → renovar
}

async function getMLToken() {
  const refreshToken = process.env.ML_REFRESH_TOKEN;
  if (refreshToken && ML_CLIENT_ID && ML_CLIENT_SECRET && mlTokenExpiresSoon()) {
    try {
      const res = await fetch('https://api.mercadolibre.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: ML_CLIENT_ID,
          client_secret: ML_CLIENT_SECRET,
          refresh_token: refreshToken
        })
      });
      const data = await res.json();
      if (data.access_token) {
        saveEnvVar('ML_USER_TOKEN', data.access_token);
        if (data.refresh_token) saveEnvVar('ML_REFRESH_TOKEN', data.refresh_token);
        const expiresAt = Date.now() + (data.expires_in || 21600) * 1000;
        saveEnvVar('ML_TOKEN_EXPIRES_AT', String(expiresAt));
        console.log('  🔑 Token ML renovado');
        return data.access_token;
      }
    } catch { }
  }
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

// ── Datos Dropi desde metafields (costo, precio sugerido, stock) ─────────────
function getDropiStock(dropi) {
  if (dropi.warehouse_product?.length > 0) {
    return dropi.warehouse_product.reduce((s, w) => s + (w.stock || 0), 0);
  }
  return dropi.stock || 0;
}

async function fetchDropiMetaData(products) {
  const data = {}; // productId → { cost, suggested, stock }
  for (const p of products) {
    try {
      const res = await fetch(
        `https://${SHOPIFY_STORE}/admin/api/2024-10/products/${p.id}/metafields.json`,
        { headers: SHOPIFY_HEADS }
      );
      const { metafields } = await res.json();
      const meta = metafields?.find(m => m.namespace === 'dropi' && m.key === '_dropi_product');
      if (meta) {
        const dropi = JSON.parse(meta.value);
        data[String(p.id)] = {
          cost:      Math.round(parseFloat(dropi.sale_price || 0)),
          suggested: Math.round(parseFloat(dropi.suggested_price || 0)),
          stock:     getDropiStock(dropi)
        };
      }
    } catch { /* sin metafield */ }
    await new Promise(r => setTimeout(r, 150));
  }
  return data;
}


// ── IMÁGENES DROPI ───────────────────────────────────────────────────────────
const CDN_DROPI = 'https://d39ru7awumhhs2.cloudfront.net/';

function dropiImageUrls(dropi) {
  const urls = [];
  // Galería principal
  for (const img of (dropi.gallery || [])) {
    if (img.urlS3) {
      const parts = img.urlS3.split('/');
      const file  = encodeURIComponent(parts.pop());
      urls.push(CDN_DROPI + parts.join('/') + '/' + file);
    } else if (img.url) urls.push(img.url);
  }
  // Imágenes embebidas en descripción HTML
  const desc = dropi.description || '';
  for (const m of desc.matchAll(/src="(https?:\/\/[^"]+\.(jpg|jpeg|png|webp)[^"]*)"/gi)) {
    const url = m[1].replace(/\\/g, '');
    if (!url.includes('gstatic') && !url.includes('google.com')) urls.push(url);
  }
  return [...new Set(urls)];
}

// Carga dropi-products.json si existe (generado por npm run dropi:scraper)
function loadScraperData() {
  if (!existsSync(DROPI_PRODUCTS_FILE)) return {};
  const list = JSON.parse(readFileSync(DROPI_PRODUCTS_FILE, 'utf8'));
  const map  = {};
  for (const d of list) map[String(d.id)] = d;
  return map;
}

async function syncDropiImages(products) {
  const scraperData = loadScraperData();
  const hasScraperData = Object.keys(scraperData).length > 0;
  if (hasScraperData) console.log(`  📂 Usando dropi-products.json (${Object.keys(scraperData).length} productos)`);

  let totalAdded = 0;

  for (const p of products) {
    try {
      // Leer metafield para obtener el ID de Dropi
      const res = await fetch(
        `https://${SHOPIFY_STORE}/admin/api/2024-10/products/${p.id}/metafields.json`,
        { headers: SHOPIFY_HEADS }
      );
      const { metafields } = await res.json();
      const meta = metafields?.find(m => m.namespace === 'dropi' && m.key === '_dropi_product');
      if (!meta) { await new Promise(r => setTimeout(r, 150)); continue; }

      const dropiMeta = JSON.parse(meta.value);
      const dropiId   = String(dropiMeta.id);

      // Fuente de imágenes: scraper (más completo) o metafield como fallback
      const scraperProduct = scraperData[dropiId];
      let imgUrls;
      if (scraperProduct) {
        const photos = [...(scraperProduct.gallery || []), ...(scraperProduct.photos || [])];
        imgUrls = photos
          .filter(img => img?.urlS3 || img?.url)
          .map(img => {
            if (img.urlS3) {
              const parts = img.urlS3.split('/');
              const file  = encodeURIComponent(parts.pop());
              return CDN_DROPI + parts.join('/') + '/' + file;
            }
            return img.url;
          })
          .filter(Boolean);
        imgUrls = [...new Set(imgUrls)];
      } else {
        imgUrls = dropiImageUrls(dropiMeta);
      }

      if (imgUrls.length <= p.images.length) { await new Promise(r => setTimeout(r, 150)); continue; }

      const existing = p.images.map(i => i.src);
      let added = 0;

      for (const url of imgUrls) {
        const file   = decodeURIComponent(url.split('/').pop().split('?')[0]);
        const exists = existing.some(s => s.includes(file) || s.includes(encodeURIComponent(file)));
        if (exists) continue;
        try {
          const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-10/products/${p.id}/images.json`, {
            method: 'POST', headers: SHOPIFY_HEADS,
            body: JSON.stringify({ image: { src: url } })
          });
          const d = await r.json();
          if (d.image?.id) { added++; totalAdded++; existing.push(url); }
          await new Promise(r => setTimeout(r, 400));
        } catch { }
      }

      if (added > 0) {
        console.log(`  📸 ${p.title}: +${added} imágenes (Dropi:${imgUrls.length} → Shopify:${p.images.length + added})`);
        await logToSheet('INFO', 'Imágenes Dropi', `${p.title}: +${added} imágenes`);
      }
    } catch (e) {
      console.log(`  ⚠️  ${p.title}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  if (totalAdded === 0) console.log('  ✓ Imágenes Dropi al día');
  else console.log(`  📸 Total agregadas a Shopify: ${totalAdded}`);
}

// ── 1. SYNC STOCK SHOPIFY desde metafield Dropi ───────────────────────────────
async function syncShopifyStock(products, dropiMeta) {
  // Obtener todas las ubicaciones activas una sola vez
  const locRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-10/locations.json`, { headers: SHOPIFY_HEADS });
  const { locations } = await locRes.json();
  const activeLocations = (locations || []).filter(l => l.active);
  if (!activeLocations.length) { console.log('  ❌ Sin ubicaciones activas'); return; }

  let updated = 0, sinMeta = 0;

  for (const p of products) {
    const pid  = String(p.id);
    const meta = dropiMeta[pid];
    if (!meta) { sinMeta++; continue; }

    const dropiStock   = meta.stock;
    const shopifyStock = p.variants.reduce((s, v) => s + (v.inventory_quantity || 0), 0);
    if (shopifyStock === dropiStock) continue; // sin cambio

    for (const variant of p.variants) {
      if (!variant.inventory_item_id) continue;

      // Obtener los inventory_levels de esta variante para saber en qué ubicaciones está
      const lvlRes = await fetch(
        `https://${SHOPIFY_STORE}/admin/api/2024-10/inventory_levels.json?inventory_item_ids=${variant.inventory_item_id}`,
        { headers: SHOPIFY_HEADS }
      );
      const { inventory_levels } = await lvlRes.json();

      for (const level of (inventory_levels || [])) {
        await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-10/inventory_levels/set.json`, {
          method: 'POST', headers: SHOPIFY_HEADS,
          body: JSON.stringify({
            location_id:       level.location_id,
            inventory_item_id: variant.inventory_item_id,
            available:         dropiStock
          })
        });
        await new Promise(r => setTimeout(r, 200));
      }
    }

    updated++;
    console.log(`  📦 ${p.title}: ${shopifyStock} → ${dropiStock}`);
    await logToSheet('INFO', 'Stock actualizado', `${p.title}: ${shopifyStock} → ${dropiStock}`);
    await new Promise(r => setTimeout(r, 200));
  }

  const conStock = Object.values(dropiMeta).filter(m => m.stock > 0).length;
  console.log(`  📦 ${products.length} productos | ${conStock} con stock en Dropi | ${updated} actualizados | ${sinMeta} sin metafield`);
}

// ── IA: resolución de categoría y atributos ML ────────────────────────────────
// Si no hay ANTHROPIC_API_KEY, retorna null y el sync usa la lógica de fallback.
async function aiResolveMLPublish(product, candidates, token) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || aiDisabled) return null;

  try {
    const client = new Anthropic({ apiKey });

    // Preparar descripción de candidatos con sus atributos requeridos
    const candidateDetails = await Promise.all(
      candidates.map(async c => {
        const r = await fetch(`https://api.mercadolibre.com/categories/${c.category_id}/attributes`,
          { headers: { Authorization: `Bearer ${token}` } });
        const attrs = await r.json();
        const required = (attrs || []).filter(a => a.tags?.required || a.tags?.catalog_required);
        return { ...c, requiredAttrs: required };
      })
    );

    const candidatesText = candidateDetails.map((c, i) =>
      `[${i}] ${c.category_id} — ${c.category_name} (${c.domain_name})\n` +
      (c.requiredAttrs.length
        ? '    Atributos requeridos: ' + c.requiredAttrs.map(a => {
            const vals = a.values?.slice(0, 6).map(v => v.name).join(' | ');
            return `${a.id}(${a.name})${vals ? ': ' + vals : ': texto libre'}`;
          }).join('; ')
        : '    Sin atributos adicionales requeridos')
    ).join('\n');

    const productDesc = (product.body_html || '').replace(/<[^>]*>/g, '').slice(0, 300);

    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `Eres experto en publicaciones de MercadoLibre Chile.

Producto a publicar:
- Título: "${product.title}"
- Tipo Shopify: "${product.product_type || ''}"
- Descripción: "${productDesc}"

Categorías candidatas:
${candidatesText}

Tarea:
1. Elige el índice de la categoría más apropiada.
2. Para cada atributo requerido de esa categoría, elige el valor más adecuado para este producto.
   - Si hay opciones, elige una de las opciones listadas (texto exacto).
   - Si es texto libre, escribe un valor descriptivo corto.

Responde SOLO con JSON (sin explicaciones):
{
  "categoryIndex": 0,
  "attributes": [
    {"id": "ATTR_ID", "value_name": "valor"}
  ]
}`
      }]
    });

    await logAITokens('aiResolveMLPublish', 'claude-haiku-4-5', response.usage);
    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const result = JSON.parse(jsonMatch[0]);
    // Validar que el índice esté dentro del rango de candidatos
    const idx = typeof result.categoryIndex === 'number' && result.categoryIndex >= 0 && result.categoryIndex < candidateDetails.length
      ? result.categoryIndex : 0;
    const chosen = candidateDetails[idx];
    console.log(`  🤖 Categorías ML encontradas: ${candidateDetails.map((c,i) => `[${i}]${c.category_name}`).join(' | ')}`);
    console.log(`  🤖 IA eligió: [${idx}] ${chosen.category_name} (${chosen.category_id})`);
    return { categoryId: chosen.category_id, attributes: result.attributes || [] };
  } catch (e) {
    if (!checkAICreditsError(e)) console.log(`  ⚠️  IA error: ${e.message} — usando lógica de fallback`);
    return null;
  }
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

// ── Fotos ML: sincroniza todas las imágenes Shopify a un item ML ──────────────
async function syncMlPictures(mlId, shopifyImages, token) {
  if (!shopifyImages.length) return 0;

  // Obtener fotos actuales con sus IDs (ML requiere enviarlos para no perderlas)
  const res = await fetch(`https://api.mercadolibre.com/items/${mlId}?attributes=pictures`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  const currentPics = data.pictures || []; // [{ id, url, secure_url }]

  // Fotos existentes por ID + nuevas de Shopify por source URL, máximo 12 (límite ML)
  const existing = currentPics.map(p => ({ id: p.id }));
  const nuevas   = shopifyImages.map(i => ({ source: i.src }));
  const pictures = [...existing, ...nuevas].slice(0, 12);

  const putRes = await fetch(`https://api.mercadolibre.com/items/${mlId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pictures })
  });
  const putData = await putRes.json();
  if (!putRes.ok) throw new Error(putData.message || putRes.status);
  return shopifyImages.length;
}

// ── 2. PRECIO COMPETITIVO ML (con comisión incluida) ──────────────────────────
// Retorna { mlPrice, competitorMedian } — la competencia informa ambos precios
async function getMLPriceData(title, basePrice, token) {
  const minML = mlMinPrice(basePrice);
  try {
    const myIds = new Set(Object.values(loadMapping()).map(v => getMlId(v)).filter(id => id && !id.startsWith('DRY_')));
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

// ── IA: investigación de precio para producto nuevo ──────────────────────────
// Usa visión para identificar el producto desde su imagen y luego analiza
// la competencia en ML para recomendar el precio óptimo.
// Solo se llama la primera vez que se publica un producto (sin mlId).
async function aiResearchFirstTimePrice(product, basePrice, token) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || aiDisabled) return getMLPriceData(product.title, basePrice, token);

  const client  = new Anthropic({ apiKey });
  const minML   = mlMinPrice(basePrice);
  const myIds   = new Set(Object.values(loadMapping()).map(v => getMlId(v)).filter(Boolean));

  try {
    // Paso 1: identificar el producto con visión (imagen) o título como fallback
    let searchQuery = product.title;
    const imageUrl  = product.images[0]?.src;

    if (imageUrl) {
      const visionRes = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: imageUrl } },
            { type: 'text', text: `El producto se llama: "${product.title}". Confirma si la imagen corresponde y agrega modelo o características específicas visibles para afinar la búsqueda de precios. Responde solo con el término de búsqueda en español, manteniendo el nombre original como base. Si la imagen no corresponde, responde solo con el nombre original.` }
          ]
        }]
      });
      await logAITokens('aiResearchFirstTimePrice:vision', 'claude-haiku-4-5', visionRes.usage);
      const identified = visionRes.content[0]?.text?.trim();
      if (identified) {
        const titleWords = product.title.toLowerCase().split(' ').filter(w => w.length > 3);
        const identLower = identified.toLowerCase();
        if (titleWords.some(w => identLower.includes(w))) {
          searchQuery = identified;
          console.log(`  👁️  IA identificó: ${identified.slice(0, 80)}`);
        }
      }
    }

    // Paso 2: buscar competidores en ML con el término identificado
    const searchRes = await fetch(
      `https://api.mercadolibre.com/sites/${ML_SITE_ID}/search?q=${encodeURIComponent(searchQuery.slice(0, 60))}&limit=10&sort=sold_quantity_desc`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const searchData = await searchRes.json();
    const competitors = (searchData.results || []).filter(r => r.price > 0 && !myIds.has(r.id));

    if (!competitors.length) return getMLPriceData(product.title, basePrice, token);

    // Paso 3: IA analiza precios y recomienda el óptimo
    const compSummary = competitors.slice(0, 8)
      .map(c => `- "${c.title.slice(0, 50)}": $${c.price.toLocaleString('es-CL')} (${c.sold_quantity ?? 0} vendidos)`)
      .join('\n');

    const analysisRes = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Eres experto en pricing para MercadoLibre Chile.

Producto: "${product.title}"
Costo: $${basePrice.toLocaleString('es-CL')}
Precio mínimo viable (con comisión 14% + tarifa $700): $${minML.toLocaleString('es-CL')}

Competidores en ML por unidades vendidas:
${compSummary}

Recomienda el precio de publicación óptimo: competitivo pero sin perder dinero.
Considera el volumen vendido de cada competidor como señal de precio aceptable.

Responde SOLO con JSON (sin texto adicional):
{"price": 9990, "reason": "una oración explicando la decisión"}`
      }]
    });

    await logAITokens('aiResearchFirstTimePrice:analysis', 'claude-haiku-4-5', analysisRes.usage);
    const raw = analysisRes.content[0]?.text || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return getMLPriceData(product.title, basePrice, token);

    const { price, reason } = JSON.parse(match[0]);
    const mlPrice = attractivePrice(Math.max(Number(price) || minML, minML));
    console.log(`  💡 IA precio: $${mlPrice.toLocaleString('es-CL')} — ${reason}`);
    return { mlPrice, median: null };

  } catch (e) {
    if (!checkAICreditsError(e)) console.log(`  ⚠️  IA pricing error: ${e.message} — usando precio estándar`);
    return getMLPriceData(product.title, basePrice, token);
  }
}

// ── 3. SYNC PRECIOS (web + ML) ────────────────────────────────────────────────
// Una sola llamada a ML por producto:
//   1. Consulta competencia → decide precio ML atractivo
//   2. Deriva precio web desde lo que se neta en ML
//   3. Actualiza Shopify si el precio web cambió
//   4. Actualiza/publica en ML
async function syncPricesAndListings(products, token, dropiMeta = {}) {
  const mapping = loadMapping();
  let mlUpdated = 0, mlPaused = 0, mlPublished = 0, webUpdated = 0;

  for (const p of products) {
    const pid        = String(p.id);
    const stock      = p.variants.reduce((s, v) => s + (v.inventory_quantity || 0), 0);
    const currentWeb = Math.round(parseFloat(p.variants[0]?.price || 0));
    const mlId       = getMlId(mapping[pid]);
    // Costo real Dropi — piso absoluto para no vender a pérdida
    const dropiCost  = dropiMeta[pid]?.cost || 0;

    // Precio placeholder de Dropi ($1, $30, etc.)
    // Si tenemos costo Dropi, la IA puede investigar competidores y fijar el precio.
    // Solo omitir si tampoco hay costo disponible.
    if (currentWeb < MIN_VALID_PRICE) {
      if (dropiCost <= 0) {
        console.log(`  ⚠️  Sin precio ni costo: ${p.title} — omitido`);
        await logToSheet('WARN', 'Sin precio/costo', `${p.title}: $${currentWeb} — sin datos Dropi`);
        continue;
      }
      console.log(`  💡 Precio placeholder ($${currentWeb}), buscando precio via competidores IA...`);
    }

    // Sin stock: pausar ML si estaba publicado, o simplemente saltar
    if (stock === 0) {
      if (mlId && !mlId.startsWith('DRY_')) {
        await fetch(`https://api.mercadolibre.com/items/${mlId}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'paused' })
        });
        const wasActive = getMlStock(mapping[pid]) !== 0;
        mapping[pid] = { id: mlId, price: getMlPrice(mapping[pid]), stock: 0 };
        saveMapping(mapping);
        if (wasActive) mlPaused++;
        console.log(`  ⏸  ML pausado: ${p.title}`);
        await logToSheet('INFO', 'ML Pausado', `${p.title} | ${mlId}`);
      } else {
        console.log(`  ⏭  Sin stock aún (Shopify): ${p.title} — se publicará en próximo ciclo`);
      }
      await new Promise(r => setTimeout(r, 200));
      continue;
    }

    // Precio ML: siempre buscar competencia para mantenerse competitivo
    const esPlaceholder = currentWeb < MIN_VALID_PRICE;
    const costBase = dropiCost > 0 ? dropiCost : currentWeb;

    let mlPrice, median;
    if (!mlId || esPlaceholder) {
      ({ mlPrice, median } = await aiResearchFirstTimePrice(p, costBase, token));
    } else {
      ({ mlPrice, median } = await getMLPriceData(p.title, costBase, token));
    }

    // Precio web Shopify: solo cambiar si es placeholder o si la diferencia supera el 15%
    const floorByHistory = currentWeb >= MIN_VALID_PRICE ? Math.round(currentWeb * 0.8) : 0;
    const minWeb  = Math.max(dropiCost, floorByHistory);
    const newWeb  = Math.max(mlPrice, minWeb);
    const diffPct = currentWeb >= MIN_VALID_PRICE ? Math.abs(newWeb - currentWeb) / currentWeb : 1;
    const competMsg = median ? ` (competencia: $${median.toLocaleString('es-CL')})` : '';

    if (p.variants[0]?.id && (esPlaceholder || diffPct >= 0.15) && newWeb !== currentWeb) {
      await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-10/variants/${p.variants[0].id}.json`, {
        method: 'PUT', headers: SHOPIFY_HEADS,
        body: JSON.stringify({ variant: { id: p.variants[0].id, price: String(newWeb) } })
      });
      webUpdated++;
      const razon = esPlaceholder ? ' (era placeholder)' : ` (cambio ${Math.round(diffPct * 100)}%)`;
      console.log(`  💲 Web: ${p.title} $${currentWeb.toLocaleString('es-CL')} → $${newWeb.toLocaleString('es-CL')}${competMsg}${razon}`);
      await logToSheet('INFO', 'Precio web', `${p.title}: $${currentWeb.toLocaleString('es-CL')} → $${newWeb.toLocaleString('es-CL')}${razon}`);
    }

    // Actualizar ML si ya estaba publicado — precio ML siempre actualizado con competencia
    if (mlId && !mlId.startsWith('DRY_')) {
      const lastStock = getMlStock(mapping[pid]);
      const stockChanged = lastStock !== null && lastStock !== stock;

      await fetch(`https://api.mercadolibre.com/items/${mlId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ available_quantity: stock, price: mlPrice, status: 'active' })
      });

      // Sincronizar fotos cuando Shopify tiene más imágenes de las que se enviaron a ML
      const prev = typeof mapping[pid] === 'object' ? mapping[pid] : {};
      const syncedCount = prev.syncedImageCount || 0;
      if (p.images.length > syncedCount) {
        try {
          await syncMlPictures(mlId, p.images, token);
          console.log(`  📸 ML fotos: ${p.title} | ${p.images.length} imágenes enviadas`);
        } catch (e) { console.log(`  ⚠️  ML fotos error (${p.title}): ${e.message}`); }
      }
      mapping[pid] = { ...prev, id: mlId, price: mlPrice, stock, syncedImageCount: p.images.length };
      saveMapping(mapping);
      if (stockChanged) {
        mlUpdated++;
        console.log(`  ✅ ML stock: ${p.title} | ${lastStock} → ${stock}`);
        await logToSheet('INFO', 'ML Stock', `${p.title}: ${lastStock} → ${stock}`);
      }

    // Publicar nuevo en ML
    } else if (!mlId) {
      try {
        // Buscar múltiples candidatos de categoría para que la IA elija el mejor
        const catQuery = [p.title.slice(0, 50), p.product_type].filter(Boolean).join(' ');
        const catRes = await fetch(
          `https://api.mercadolibre.com/sites/${ML_SITE_ID}/domain_discovery/search?q=${encodeURIComponent(catQuery)}&limit=5`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const candidates = await catRes.json();
        if (!candidates?.length) {
          console.log(`  ⚠️  ML sin categoría: ${p.title} — no se puede publicar`);
          await logToSheet('WARN', 'ML Sin categoría', p.title);
          await new Promise(r => setTimeout(r, 300));
          continue;
        }

        const sku = p.variants[0]?.sku || String(p.id);

        // ── IA: elige categoría y atributos óptimos ──
        const aiResult = await aiResolveMLPublish(p, candidates, token);

        let categoryId, extraAttrs;
        if (aiResult) {
          categoryId  = aiResult.categoryId;
          extraAttrs  = aiResult.attributes;
        } else {
          // Fallback sin IA: primer candidato + first-value para atributos requeridos
          categoryId = candidates[0].category_id;
          console.log(`  📂 Fallback categoría: ${candidates[0].category_name} (${candidates[0].category_id})`);
          const attrsRes = await fetch(
            `https://api.mercadolibre.com/categories/${categoryId}/attributes`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const catAttrs = await attrsRes.json();
          extraAttrs = (catAttrs || [])
            .filter(a => a.tags?.required || a.tags?.catalog_required)
            .flatMap(a => {
              // Atributo con valores predefinidos → usar el primero
              if (a.values?.[0]) return [{ id: a.id, value_name: a.values[0].name }];
              // Atributo numérico → intentar extraer del título, sino usar default por unidad
              if (a.value_type === 'number_unit' || a.value_type === 'number') {
                const units = (a.allowed_units || []).map(u => u.id).join('|') || 'mL|L|ml|l|oz|cc|g|kg|W|V|cm|mm|m';
                const match = p.title.match(new RegExp(`(\\d+[\\.,]?\\d*)\\s*(${units})`, 'i'));
                if (match) return [{ id: a.id, value_name: `${match[1]} ${match[2]}` }];
                // Default razonable por unidad más común del atributo
                const defaultUnit = a.allowed_units?.[0]?.id || 'mL';
                return [{ id: a.id, value_name: `500 ${defaultUnit}` }];
              }
              // Atributo de texto libre → usar título
              return [{ id: a.id, value_name: p.title.slice(0, 60) }];
            });
        }

        // Combinar atributos base + extras de IA/fallback (sin duplicar)
        const baseAttrs = [
          { id: 'BRAND',       value_name: p.vendor || 'Genérico' },
          { id: 'PART_NUMBER', value_name: sku },
          { id: 'MODEL',       value_name: p.title.slice(0, 60) },
        ];
        const baseIds = new Set(baseAttrs.map(a => a.id));
        const allAttrs = [...baseAttrs, ...(extraAttrs || []).filter(a => !baseIds.has(a.id))];

        const body = {
          title: p.title.slice(0, 60), category_id: categoryId,
          price: mlPrice, currency_id: 'CLP', available_quantity: stock,
          buying_mode: 'buy_it_now', condition: 'new', listing_type_id: 'gold_special',
          description: { plain_text: p.body_html?.replace(/<[^>]*>/g, '') || p.title },
          tags: ['immediate_payment'],
          shipping: { mode: 'me2', local_pick_up: false, free_shipping: false },
          attributes: allAttrs
        };
        if (p.images.length > 0) body.pictures = p.images.map(i => ({ source: i.src }));

        const res = await fetch('https://api.mercadolibre.com/items', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const item = await res.json();
        if (item.id) {
          mapping[pid] = { id: item.id, price: mlPrice, stock, syncedImageCount: p.images.length };
          saveMapping(mapping);
          mlPublished++;
          console.log(`  🆕 ML nuevo: ${p.title} → ${item.id} | $${mlPrice.toLocaleString('es-CL')} | ${p.images.length} fotos`);
          await logToSheet('INFO', 'ML Nuevo', `${p.title} → ${item.id} | $${mlPrice.toLocaleString('es-CL')} | ${p.images.length} fotos`);
        } else {
          const mlErrDetail = item.cause?.map(c => `${c.code}: ${c.message}`).join(' | ') || item.message || item.error || '';
          console.log(`  ❌ ML rechazó: ${p.title} — ${mlErrDetail}`);
          console.log(`     Detalle ML: ${JSON.stringify(item).slice(0, 300)}`);
          await logToSheet('ERROR', 'ML Rechazado', `${p.title}: ${mlErrDetail}`);
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

      // Notificación Telegram
      const itemsText = lineItems.map(i => `• ${i.title} x${i.quantity} — $${i.price?.toLocaleString('es-CL')}`).join('\n');
      await sendTelegram(
        `Nueva orden de MercadoLibre\n\n` +
        `Cliente: ${shippingAddress.first_name} ${shippingAddress.last_name}\n` +
        `Total: $${detail.total_amount?.toLocaleString('es-CL')}\n\n` +
        `${itemsText}\n\n` +
        `ML #${order.id} → Shopify #${shopifyId}`
      );

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
async function updateProductsSheet(products, dropiMeta) {
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
    const meta       = dropiMeta[pid] || {};
    const cost       = meta.cost || '';
    const suggested  = meta.suggested || Math.round(parseFloat(p.variants[0]?.compare_at_price || 0));
    const mlId       = getMlId(mapping[pid]) || '';
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

// ── SHEET Imágenes ────────────────────────────────────────────────────────────
const SHEET_IMAGES = 'Imágenes';

async function ensureImagesSheetHeader() {
  const sheets = await getSheetsClient();
  if (!sheets || !SHEET_ID) return;

  // Verificar si la pestaña existe
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const exists = meta.data.sheets?.some(s => s.properties.title === SHEET_IMAGES);
    if (!exists) {
      // Crear la pestaña
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: SHEET_IMAGES } } }] }
      });
    }
  } catch { }

  // Escribir cabecera si no existe
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: `${SHEET_IMAGES}!A1:I1`
    });
    if (res.data.values?.[0]?.[0] === 'Fecha') return;
  } catch { }

  await sheetsUpdate(SHEET_IMAGES, [[
    'Fecha', 'Producto Shopify', 'ID Shopify', 'Fuente ML', 'Título fuente ML',
    'Link fuente ML', 'Fotos encontradas', 'Fotos agregadas', 'Descripción (preview)'
  ]]);
}

// ── BÚSQUEDA DE IMÁGENES EN ML ────────────────────────────────────────────────
// ── IA: búsqueda y selección de imágenes para producto nuevo ─────────────────
// 1. Identifica el producto vía visión
// 2. Busca en Google/web (Claude con web_search) + ML como fuentes combinadas
// 3. Claude evalúa visualmente cuáles coinciden con el producto
// 4. Sube las seleccionadas a Shopify
async function aiSearchAndUploadImages(product, token) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return 0;

  const client = new Anthropic({ apiKey });
  const existingUrls = product.images.map(i => i.src);
  const myIds = new Set(Object.values(loadMapping()).map(v => getMlId(v)).filter(Boolean));

  // Paso 1: Claude ve la imagen y genera descripción visual detallada para búsqueda
  // Esto es equivalente a "buscar por imagen" — más preciso que solo el título
  let searchQuery = product.title;
  const refImageUrl = product.images[0]?.src;
  if (refImageUrl) {
    try {
      const vRes = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 150,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'url', url: refImageUrl } },
          { type: 'text', text: `El producto se llama "${product.title}". Describe este producto con máximo detalle visual para usarlo como query de búsqueda de imágenes: color exacto, forma, materiales visibles, marca o modelo si se lee, características únicas. Responde SOLO con el término de búsqueda en español (máximo 15 palabras), empezando siempre por "${product.title}".` }
        ]}]
      });
      await logAITokens('aiSearchAndUploadImages:vision', 'claude-haiku-4-5', vRes.usage);
      const visionResult = vRes.content[0]?.text?.trim();
      if (visionResult) searchQuery = visionResult;
    } catch { }
  }
  console.log(`  🔍 Buscando imágenes: "${searchQuery.slice(0, 80)}"`);

  // Paso 2a: imágenes desde ML (rápido, sin costo IA)
  const mlUrls = [];
  try {
    const mlRes = await fetch(
      `https://api.mercadolibre.com/sites/${ML_SITE_ID}/search?q=${encodeURIComponent(searchQuery.slice(0, 60))}&limit=3&sort=sold_quantity_desc`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const mlData = await mlRes.json();
    for (const item of (mlData.results || []).filter(r => !myIds.has(r.id)).slice(0, 3)) {
      const ir = await fetch(`https://api.mercadolibre.com/items/${item.id}?attributes=pictures`,
        { headers: { Authorization: `Bearer ${token}` } });
      const id = await ir.json();
      for (const pic of (id.pictures || []).slice(0, 3)) {
        const url = pic.secure_url || pic.url;
        if (url) mlUrls.push(url);
      }
      await new Promise(r => setTimeout(r, 200));
    }
  } catch { }

  // Paso 2b: imágenes desde DuckDuckGo (gratis, sin API key)
  const webUrls = [];
  try {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
    const q  = encodeURIComponent(searchQuery.slice(0, 80));

    // 1) Obtener token vqd
    const initRes = await fetch(`https://duckduckgo.com/?q=${q}&iax=images&ia=images`, {
      headers: { 'User-Agent': ua }
    });
    const html = await initRes.text();
    const vqd  = html.match(/vqd=['"]([^'"]{10,})['"]/)?.[1];

    if (vqd) {
      // 2) Buscar imágenes
      const imgRes = await fetch(
        `https://duckduckgo.com/i.js?q=${q}&vqd=${encodeURIComponent(vqd)}&o=json&p=1&f=,,,,,`,
        { headers: { 'User-Agent': ua, 'Referer': 'https://duckduckgo.com/' } }
      );
      const imgData = await imgRes.json();
      const found = (imgData.results || []).slice(0, 8).map(r => r.image).filter(u => u?.startsWith('https'));
      webUrls.push(...found);
      console.log(`  🌐 DuckDuckGo: ${found.length} imágenes encontradas`);
    } else {
      console.log(`  ⚠️  DuckDuckGo: no se obtuvo token vqd`);
    }
  } catch (e) {
    console.log(`  ⚠️  DuckDuckGo error: ${e.message.slice(0, 100)}`);
  }

  console.log(`  📋 ML:${mlUrls.length} web:${webUrls.length}`);
  // Combinar fuentes (ML + web), eliminar duplicados
  const allUrls = [...new Set([...mlUrls, ...webUrls])];
  if (!allUrls.length) { console.log(`  🖼️  Sin imágenes encontradas`); return 0; }

  // Paso 3: Claude evalúa visualmente cuáles son del mismo producto
  const toEval = allUrls.slice(0, 8);
  let selectedUrls = toEval; // fallback: todas

  if (refImageUrl) {
    try {
      const content = [
        { type: 'text', text: `Producto: "${product.title}"\nFoto de referencia:` },
        { type: 'image', source: { type: 'url', url: refImageUrl } },
        { type: 'text', text: '\nImágenes candidatas (evalúa si son del mismo producto):' }
      ];
      for (let i = 0; i < toEval.length; i++) {
        content.push({ type: 'text', text: `[${i}]` });
        content.push({ type: 'image', source: { type: 'url', url: toEval[i] } });
      }
      content.push({ type: 'text', text: '\nResponde SOLO con JSON array de índices relevantes. Ejemplo: [0,2,4]. Si ninguna: []' });

      const evalRes = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 80,
        messages: [{ role: 'user', content }]
      });
      await logAITokens('aiSearchAndUploadImages:eval', 'claude-haiku-4-5', evalRes.usage);
      const raw = evalRes.content[0]?.text || '';
      const match = raw.match(/\[[\d,\s]*\]/);
      if (match) {
        const idxs = JSON.parse(match[0]);
        if (idxs.length) selectedUrls = idxs.map(i => toEval[i]).filter(Boolean);
      }
    } catch { /* usa todas como fallback */ }
  }

  if (!selectedUrls.length) { console.log(`  🖼️  IA: ninguna imagen coincide`); return 0; }

  // Paso 4: subir a Shopify
  let added = 0;
  for (const url of selectedUrls) {
    const file = url.split('/').pop().split('?')[0];
    if (existingUrls.some(s => s.includes(file))) continue;
    try {
      const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-10/products/${product.id}/images.json`, {
        method: 'POST', headers: SHOPIFY_HEADS,
        body: JSON.stringify({ image: { src: url } })
      });
      const d = await r.json();
      if (d.image?.id) { added++; existingUrls.push(url); }
      else if (d.errors) console.log(`    ⚠️  Imagen rechazada: ${JSON.stringify(d.errors).slice(0, 60)}`);
      await new Promise(r => setTimeout(r, 400));
    } catch { }
  }
  return added;
}

async function searchAndSyncMLImages(products, token) {
  const mapping = loadMapping();
  const cache   = loadMLImagesCache();

  // Solo productos con < 3 imágenes que no hayan sido buscados con ese mismo count
  const needsImages = products.filter(p => {
    if (p.images.length >= 3) return false;
    const cached = cache[String(p.id)];
    return !cached || cached.searchedAtCount !== p.images.length;
  });

  if (needsImages.length === 0) {
    console.log('  ✓ Búsqueda ML imágenes al día');
    return;
  }
  console.log(`  🔍 ${needsImages.length} productos nuevos — buscando imágenes en ML...`);

  await ensureImagesSheetHeader();
  let totalAdded = 0;

  for (const p of needsImages) {
    const myMlId = getMlId(mapping[String(p.id)]);
    let added = 0, picCount = 0, noResults = false;

    try {
      // Buscar en ML por nombre de producto
      const searchRes = await fetch(
        `https://api.mercadolibre.com/sites/${ML_SITE_ID}/search?q=${encodeURIComponent(p.title.slice(0, 60))}&limit=5&sort=sold_quantity_desc`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const searchData = await searchRes.json();
      const candidates = (searchData.results || []).filter(r => r.id !== myMlId);
      if (!candidates.length) {
        console.log(`  🔍 ${p.title}: sin resultados en ML`);
        noResults = true;
        await new Promise(r => setTimeout(r, 300));
      } else {
        // Tomar el primer resultado y pedir su detalle completo
        const topItem = candidates[0];
        const [itemRes, descRes] = await Promise.all([
          fetch(`https://api.mercadolibre.com/items/${topItem.id}`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`https://api.mercadolibre.com/items/${topItem.id}/description`, { headers: { Authorization: `Bearer ${token}` } })
        ]);
        const [item, desc] = await Promise.all([itemRes.json(), descRes.json()]);

        const pictures = item.pictures || [];
        picCount = pictures.length;
        const descText = (desc.plain_text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        const mlLink   = `https://articulo.mercadolibre.cl/${topItem.id.replace(/^([A-Z]+)(\d)/, '$1-$2')}`;

        // Subir imágenes que faltan a Shopify
        const existing = p.images.map(i => i.src);
        for (const pic of pictures) {
          const url = pic.url || pic.secure_url;
          if (!url) continue;
          const file = url.split('/').pop().split('?')[0];
          if (existing.some(s => s.includes(file))) continue;
          try {
            const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-10/products/${p.id}/images.json`, {
              method: 'POST', headers: SHOPIFY_HEADS,
              body: JSON.stringify({ image: { src: url } })
            });
            const d = await r.json();
            if (d.image?.id) {
              added++; totalAdded++; existing.push(url);
            } else {
              console.log(`    ⚠️  Imagen rechazada: ${(d.errors?.image || d.error || JSON.stringify(d)).toString().slice(0, 80)}`);
            }
            await new Promise(r => setTimeout(r, 400));
          } catch (e) {
            console.log(`    ⚠️  Error subiendo imagen: ${e.message}`);
          }
        }

        // Registrar en sheet Imágenes
        const now = new Date().toLocaleString('es-CL');
        await sheetsAppend(SHEET_IMAGES, [[
          now, p.title, String(p.id), topItem.id, topItem.title,
          mlLink, picCount, added, descText
        ]]);

        if (added > 0) {
          console.log(`  🖼️  ${p.title}: +${added} imágenes desde ML (${topItem.title.slice(0, 40)})`);
          await logToSheet('INFO', 'Imágenes ML', `${p.title}: +${added} desde ${topItem.id}`);
        } else {
          console.log(`  🔍 ${p.title}: ${picCount} fotos en ML — ya están todas en Shopify`);
        }
      }
    } catch (e) {
      console.log(`  ⚠️  ${p.title}: ${e.message}`);
    }

    // Cachear solo si se agregaron imágenes o si ML no tenía resultados
    // Si encontró fotos pero fallaron uploads → NO cachear → reintenta próximo ciclo
    if (added > 0 || noResults || picCount === 0) {
      cache[String(p.id)] = { searchedAtCount: p.images.length, date: new Date().toISOString() };
      saveMLImagesCache(cache);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (totalAdded > 0) console.log(`  🖼️  Total imágenes ML agregadas: ${totalAdded}`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function run() {
  const withImages   = !process.argv.includes('--no-images');
  const ordersOnly   = process.argv.includes('--orders-only');
  const now = new Date().toLocaleString('es-CL');

  if (ordersOnly) {
    console.log(`\n📦 ÓRDENES ML | ${now}`);
    console.log('━'.repeat(50));
    await logToSheet('INFO', 'Inicio Sync Órdenes', now);

    const token = await getMLToken();

    console.log('\n[1/2] Revisando órdenes ML → Shopify...');
    const nuevas = await syncMLOrders(token);

    console.log('\n[2/2] Google Sheets...');
    if (nuevas > 0) {
      console.log(`  ✅ ${nuevas} orden(es) nueva(s) registrada(s) en pestaña "Órdenes"`);
    } else {
      console.log('  📬 Sin órdenes nuevas — sheet sin cambios');
    }

    await logToSheet('INFO', 'Fin Sync Órdenes', `OK — ${nuevas} nueva(s)`);
    console.log('\n✅ Listo.');
    return;
  }

  console.log(`\n🔄 AUTO-SYNC${withImages ? '' : ' (sin imágenes)'} | ${now}`);
  console.log('━'.repeat(50));

  await logToSheet('INFO', 'Inicio Sync', now);
  await ensureAISheet();

  const token = await getMLToken();
  const products = await getShopifyProducts();
  const dropiMeta = await fetchDropiMetaData(products);

  console.log('\n[1/6] Sync imágenes Dropi...');
  await syncDropiImages(products);

  console.log('\n[2/6] IA: búsqueda de imágenes (todos los productos con < 4 fotos)...');
  if (!withImages) {
    console.log('  ⏭  Omitido (modo sin imágenes)');
  } else {
  const productsAfterDropi = await getShopifyProducts();
  const imgCache = loadMLImagesCache();
  const conPocasImagenes = productsAfterDropi.filter(p => p.images.length < 4);

  if (conPocasImagenes.length === 0) {
    console.log('  ✓ Todos los productos tienen 4+ imágenes');
  } else {
    console.log(`  📸 ${conPocasImagenes.length} productos con < 4 imágenes — buscando...`);
    for (const p of conPocasImagenes) {
      const added = await aiSearchAndUploadImages(p, token);
      imgCache[String(p.id)] = {
        ...(imgCache[String(p.id)] || {}),
        aiLastSearched: new Date().toISOString(),
        aiFoundCount: added
      };
      saveMLImagesCache(imgCache);
      if (added > 0) {
        console.log(`  🖼️  ${p.title}: +${added} imágenes`);
        await logToSheet('INFO', 'IA Imágenes', `${p.title}: +${added}`);
      }
    }
  }
  } // fin bloque withImages

  console.log('\n[3/6] Sync stock Shopify desde metafield Dropi...');
  await syncShopifyStock(products, dropiMeta);

  // Esperar a que Shopify refleje los cambios de inventario
  await new Promise(r => setTimeout(r, 3000));
  const productsConStock = await getShopifyProducts();

  console.log('\n[4/6] Sync precios (competencia ML → web + ML)...');
  const dropiMetaFresh = await fetchDropiMetaData(productsConStock);
  await syncPricesAndListings(productsConStock, token, dropiMetaFresh);

  console.log('\n[5/6] Órdenes ML → Shopify...');
  await syncMLOrders(token);

  console.log('\n[6/6] Actualizando Google Sheets...');
  const freshProducts = await getShopifyProducts();
  const freshMeta = await fetchDropiMetaData(freshProducts);
  await updateProductsSheet(freshProducts, freshMeta);
  await updateAIUsageSummary();

  await logToSheet('INFO', 'Fin Sync', `OK — ${freshProducts.length} productos`);
  console.log('\n✅ Sync completado.');
}

run().catch(async (e) => {
  console.error(e);
  await logToSheet('ERROR', 'Sync Fatal', e.message).catch(() => {});
});
