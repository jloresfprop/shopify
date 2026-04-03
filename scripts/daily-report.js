import { readFileSync, existsSync } from 'fs';
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

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;
const SHEET_ID       = process.env.GOOGLE_SHEET_ID;
const SHOPIFY_STORE  = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN  = process.env.SHOPIFY_TOKEN;
const CREDS_FILE     = resolve(__dir, '../el-estante-cl.json');

async function getSheetsClient() {
  if (!existsSync(CREDS_FILE)) return null;
  const auth = new google.auth.GoogleAuth({ keyFile: CREDS_FILE, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

async function sendTelegram(msg) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text: msg, parse_mode: 'HTML' })
  });
}

async function getYesterdayOrders() {
  const ayer = new Date();
  ayer.setDate(ayer.getDate() - 1);
  const desde = new Date(ayer); desde.setHours(0, 0, 0, 0);
  const hasta = new Date(ayer); hasta.setHours(23, 59, 59, 999);

  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2024-10/orders.json?status=any&created_at_min=${desde.toISOString()}&created_at_max=${hasta.toISOString()}&limit=50`,
    { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
  );
  const data = await res.json();
  return data.orders || [];
}

async function getLogStats() {
  const sheets = await getSheetsClient();
  if (!sheets || !SHEET_ID) return { precios: 0, imagenes: 0, mlNuevos: 0, errores: 0 };

  const ayer = new Date();
  ayer.setDate(ayer.getDate() - 1);
  const ayerStr = ayer.toLocaleDateString('es-CL');

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Log!A:D'
    });
    const rows = res.data.values || [];
    const deAyer = rows.filter(r => (r[0] || '').includes(ayerStr));

    return {
      precios:   deAyer.filter(r => r[2] === 'Precio web').length,
      imagenes:  deAyer.filter(r => r[2] === 'Imágenes ML' || r[2] === 'IA Imágenes').length,
      mlNuevos:  deAyer.filter(r => r[2] === 'ML Nuevo').length,
      errores:   deAyer.filter(r => r[1] === 'ERROR').length,
    };
  } catch {
    return { precios: 0, imagenes: 0, mlNuevos: 0, errores: 0 };
  }
}

async function run() {
  const ayer = new Date();
  ayer.setDate(ayer.getDate() - 1);
  const fechaAyer = ayer.toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });

  const [orders, stats] = await Promise.all([getYesterdayOrders(), getLogStats()]);

  const totalVentas = orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
  const mlOrders    = orders.filter(o => o.tags?.includes('mercadolibre') || o.source_name === 'MercadoLibre');
  const webOrders   = orders.filter(o => !mlOrders.includes(o));

  let msg = `Resumen El Estante CL\n`;
  msg += `${fechaAyer.charAt(0).toUpperCase() + fechaAyer.slice(1)}\n`;
  msg += `${'─'.repeat(30)}\n\n`;

  // Ventas
  if (orders.length === 0) {
    msg += `Sin ventas ayer\n\n`;
  } else {
    msg += `Ventas: ${orders.length} orden${orders.length > 1 ? 'es' : ''}\n`;
    msg += `Total recaudado: $${Math.round(totalVentas).toLocaleString('es-CL')}\n`;
    if (mlOrders.length > 0) msg += `  - MercadoLibre: ${mlOrders.length}\n`;
    if (webOrders.length > 0) msg += `  - Web/Shopify: ${webOrders.length}\n`;
    msg += `\n`;

    if (mlOrders.length > 0) {
      msg += `Detalle ML:\n`;
      for (const o of mlOrders) {
        const items = o.line_items?.map(i => `${i.title} x${i.quantity}`).join(', ') || '';
        msg += `  • $${Math.round(o.total_price).toLocaleString('es-CL')} — ${items.slice(0, 50)}\n`;
      }
      msg += `\n`;
    }
  }

  // Actividad del sync
  msg += `Actividad automatica:\n`;
  msg += `  • Precios actualizados: ${stats.precios}\n`;
  msg += `  • Imagenes agregadas: ${stats.imagenes} productos\n`;
  msg += `  • Nuevos en ML: ${stats.mlNuevos}\n`;
  if (stats.errores > 0) msg += `  • Errores: ${stats.errores} (revisar Log)\n`;

  msg += `\n─────────────────────────────\n`;
  msg += `El Estante CL — Reporte diario 10:30 AM`;

  await sendTelegram(msg);
  console.log('Reporte enviado por Telegram.');
}

run().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
