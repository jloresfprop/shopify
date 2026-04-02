/**
 * ml-auth.js
 * Obtiene access_token + refresh_token de MercadoLibre via OAuth.
 * Uso: node scripts/ml-auth.js
 *
 * La redirect URI registrada en la app ML es:
 *   https://el-estante-cl.myshopify.com/callback
 *
 * Flujo:
 *  1. Se abre el navegador con la URL de autorización
 *  2. Autorizas en MercadoLibre
 *  3. ML redirige a https://el-estante-cl.myshopify.com/callback?code=XXX
 *  4. Copias el valor de "code" de la barra de direcciones
 *  5. Lo pegas aquí en la terminal
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { createInterface } from 'readline';

const __dir  = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dir, '../.env');

function loadEnv() {
  try {
    const env = readFileSync(ENV_PATH, 'utf8');
    for (const line of env.split('\n')) {
      const [k, ...v] = line.split('=');
      if (k?.trim() && v.length) process.env[k.trim()] = v.join('=').trim();
    }
  } catch {}
}
loadEnv();

function saveEnvVar(key, value) {
  let content = readFileSync(ENV_PATH, 'utf8');
  if (content.includes(`${key}=`)) {
    content = content.replace(new RegExp(`${key}=.*`), `${key}=${value}`);
  } else {
    content += `\n${key}=${value}`;
  }
  writeFileSync(ENV_PATH, content);
}

const CLIENT_ID     = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const REDIRECT_URI  = 'https://el-estante-cl.myshopify.com/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Faltan ML_CLIENT_ID y ML_CLIENT_SECRET en .env');
  process.exit(1);
}

const authUrl = `https://auth.mercadolibre.cl/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

console.log('\n🔑 Abriendo navegador para autorizar MercadoLibre...');
console.log('   Si no abre solo, copia esta URL en el navegador:');
console.log(`\n   ${authUrl}\n`);
exec(`start "" "${authUrl}"`);

console.log('📋 Después de autorizar, ML te redirigirá a tu tienda Shopify.');
console.log('   La URL tendrá un parámetro "code=XXXXXX"');
console.log('   Ejemplo: https://el-estante-cl.myshopify.com/callback?code=TU_CODIGO\n');

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question('Pega aquí el código (solo el valor después de code=): ', async (code) => {
  rl.close();
  code = code.trim();
  if (!code) { console.error('❌ No pegaste ningún código.'); process.exit(1); }

  console.log('\n🔄 Intercambiando código por tokens...');
  try {
    const res = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri:  REDIRECT_URI
      })
    });
    const data = await res.json();

    if (!data.access_token) {
      console.error('❌ Error ML:', JSON.stringify(data, null, 2));
      process.exit(1);
    }

    saveEnvVar('ML_USER_TOKEN',    data.access_token);
    saveEnvVar('ML_REFRESH_TOKEN', data.refresh_token);
    if (data.user_id) saveEnvVar('ML_USER_ID', String(data.user_id));

    console.log('\n✅ Tokens ML guardados en .env');
    console.log(`   User ID  : ${data.user_id}`);
    console.log(`   Expira en: ${data.expires_in}s (~6h)`);
    console.log('\n   El auto-sync renovará el token automáticamente desde ahora.\n');
  } catch (e) {
    console.error('❌', e.message);
    process.exit(1);
  }
});
