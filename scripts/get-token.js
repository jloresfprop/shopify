/**
 * get-token.js
 * Obtiene el Admin API token via OAuth e instala la app en la tienda.
 * Uso: node scripts/get-token.js
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

const __dir = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  try {
    const env = readFileSync(resolve(__dir, '../.env'), 'utf8');
    for (const line of env.split('\n')) {
      const [k, ...v] = line.split('=');
      if (k && v.length) process.env[k.trim()] = v.join('=').trim();
    }
  } catch {}
}
loadEnv();

const CLIENT_ID     = process.env.SHOPIFY_API_KEY;
const CLIENT_SECRET = process.env.SHOPIFY_API_SECRET;
const STORE         = process.env.SHOPIFY_STORE;
const PORT          = 3000;
const REDIRECT_URI  = `http://localhost:${PORT}/callback`;
const SCOPES        = 'read_products,write_products,read_inventory,write_inventory,read_orders,write_orders,read_customers,write_customers,read_content,write_content,read_themes,write_themes,read_script_tags,write_script_tags,read_online_store_navigation,write_online_store_navigation,read_publications,write_publications,read_price_rules,read_discounts,write_discounts,read_shipping,read_locations,read_metaobjects,write_metaobjects';

if (!CLIENT_ID || !CLIENT_SECRET || !STORE) {
  console.error('❌ Faltan variables en .env: SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_STORE');
  process.exit(1);
}

const state = Math.random().toString(36).slice(2);

const authUrl = `https://${STORE}/admin/oauth/authorize?` +
  `client_id=${CLIENT_ID}` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&state=${state}`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname !== '/callback') {
    res.end('Esperando callback...');
    return;
  }

  const code       = url.searchParams.get('code');
  const stateBack  = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam) {
    res.end(`<h2>Error: ${errorParam}</h2>`);
    server.close();
    return;
  }

  if (stateBack !== state) {
    res.end('<h2>Error: state inválido</h2>');
    server.close();
    return;
  }

  console.log('\n🔄 Intercambiando código por token...');

  try {
    const tokenRes = await fetch(`https://${STORE}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code })
    });

    const data = await tokenRes.json();

    if (!data.access_token) {
      console.error('❌ Respuesta inesperada:', data);
      res.end('<h2>Error obteniendo token. Revisa la terminal.</h2>');
      server.close();
      return;
    }

    // Guardar token en .env
    const envPath = resolve(__dir, '../.env');
    let envContent = readFileSync(envPath, 'utf8');
    envContent = envContent.replace(/SHOPIFY_TOKEN=.*/g, `SHOPIFY_TOKEN=${data.access_token}`);
    if (!envContent.includes('SHOPIFY_TOKEN=')) {
      envContent += `\nSHOPIFY_TOKEN=${data.access_token}`;
    }
    writeFileSync(envPath, envContent);

    console.log(`\n✅ Token obtenido y guardado en .env`);
    console.log(`   Scopes: ${data.scope}`);
    console.log(`\n🚀 Ahora puedes correr: npm run sync:dry\n`);

    res.end(`
      <html><body style="font-family:sans-serif;padding:2rem;text-align:center">
        <h2 style="color:green">✅ ¡Autorización exitosa!</h2>
        <p>Token guardado. Cierra esta pestaña y vuelve a la terminal.</p>
      </body></html>
    `);
    server.close();
  } catch (err) {
    console.error('❌ Error:', err.message);
    res.end('<h2>Error. Revisa la terminal.</h2>');
    server.close();
  }
});

server.listen(PORT, () => {
  console.log('\n🔑 Servidor OAuth iniciado...');
  console.log(`\n➡️  Abriendo navegador para autorizar la app en ${STORE}...\n`);

  // Abrir navegador en Windows
  exec(`start "" "${authUrl}"`);
});

server.on('close', () => process.exit(0));
