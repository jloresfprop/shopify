import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dir, '../.env'), 'utf8');
for (const line of env.split('\n')) {
  const [k, ...v] = line.split('=');
  if (k?.trim() && v.length) process.env[k.trim()] = v.join('=').trim();
}
const HEADS = { 'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN };
const STORE = process.env.SHOPIFY_STORE;

async function run() {
  const [r1, r2] = await Promise.all([
    fetch(`https://${STORE}/admin/api/2024-10/products.json?limit=250&status=active`, { headers: HEADS }),
    fetch(`https://${STORE}/admin/api/2024-10/products.json?limit=250&status=draft`, { headers: HEADS })
  ]);
  const [{ products: active }, { products: drafts }] = await Promise.all([r1.json(), r2.json()]);
  const all = [...(active||[]), ...(drafts||[])];

  console.log('Producto                              | Precio web  | Compare at  | Stock');
  console.log('─'.repeat(80));
  for (const p of all) {
    const v = p.variants[0];
    const price = parseFloat(v.price || 0);
    const compare = parseFloat(v.compare_at_price || 0);
    const stock = p.variants.reduce((s, v) => s + (v.inventory_quantity || 0), 0);
    const flag = price < 500 ? ' ⚠️  PRECIO BAJO' : '';
    console.log(`${p.title.slice(0,36).padEnd(36)} | ${String(Math.round(price)).padStart(11)} | ${String(Math.round(compare)).padStart(11)} | ${stock}${flag}`);
  }
}

run().catch(console.error);
