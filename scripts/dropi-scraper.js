import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ENV_FILE  = resolve(__dir, '../.env');
const OUT_FILE  = resolve(__dir, '../dropi-products.json');

function loadEnv() {
  try {
    const env = readFileSync(ENV_FILE, 'utf8');
    for (const line of env.split('\n')) {
      const [k, ...v] = line.split('=');
      if (k?.trim() && v.length) process.env[k.trim()] = v.join('=').trim();
    }
  } catch {}
}
loadEnv();

const DROPI_EMAIL    = process.env.DROPI_EMAIL;
const DROPI_PASSWORD = process.env.DROPI_PASSWORD;

if (!DROPI_EMAIL || !DROPI_PASSWORD) {
  console.error('❌ Agrega DROPI_EMAIL y DROPI_PASSWORD al .env');
  process.exit(1);
}

async function run() {
  console.log('🌐 Abriendo navegador...');
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext();
  const page    = await context.newPage();

  // Interceptar respuestas de la API de Dropi
  const dropiProducts = [];
  const capturedTokens = new Set();

  context.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('api.dropi.cl')) return;

    // Capturar token de sesión
    const req = response.request();
    const auth = req.headers()['x-authorization'];
    if (auth) capturedTokens.add(auth);

    // Capturar respuestas de productos
    if (url.includes('/product') || url.includes('/products')) {
      try {
        const body = await response.json().catch(() => null);
        if (body?.objects && Array.isArray(body.objects) && body.objects.length > 0) {
          console.log(`  📦 Capturados ${body.objects.length} productos de ${url.split('api.dropi.cl')[1]}`);
          for (const p of body.objects) {
            if (p.id && !dropiProducts.find(x => x.id === p.id)) {
              dropiProducts.push(p);
            }
          }
        }
        // Producto individual
        if (body?.object?.id) {
          const p = body.object;
          if (!dropiProducts.find(x => x.id === p.id)) {
            dropiProducts.push(p);
            console.log(`  📦 Producto individual: ${p.name} | ${p.photos?.length} fotos`);
          }
        }
      } catch {}
    }
  });

  // Ir a Dropi
  console.log('🔐 Entrando a Dropi...');
  await page.goto('https://app.dropi.cl/auth/login');
  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 20000 });

  await page.fill('input[type="email"], input[name="email"]', DROPI_EMAIL);
  await page.waitForTimeout(500);
  await page.fill('input[type="password"], input[name="password"]', DROPI_PASSWORD);
  await page.waitForTimeout(500);
  await page.click('button[type="submit"]');

  // Esperar a que la URL cambie desde /auth/login (cualquier redirección post-login)
  await page.waitForFunction(
    () => !window.location.href.includes('/auth/login'),
    { timeout: 30000 }
  );
  console.log(`✅ Login exitoso → ${page.url()}`);

  // Navegar a productos
  console.log('📦 Navegando a productos...');
  await page.goto('https://app.dropi.cl/products');
  await page.waitForTimeout(3000);

  // Scroll para cargar todos los productos
  console.log('⏳ Cargando productos...');
  let lastCount = 0;
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
    if (dropiProducts.length === lastCount && i > 3) break;
    lastCount = dropiProducts.length;
    process.stdout.write(`\r  Productos capturados: ${dropiProducts.length}`);
  }
  console.log('');

  // Si hay paginación, navegar por páginas
  let pageNum = 2;
  while (true) {
    const nextBtn = await page.$('[aria-label="Next"], .pagination-next, button:has-text("Siguiente")');
    if (!nextBtn) break;
    const disabled = await nextBtn.getAttribute('disabled');
    if (disabled !== null) break;
    await nextBtn.click();
    await page.waitForTimeout(2000);
    process.stdout.write(`\r  Página ${pageNum} — Productos: ${dropiProducts.length}`);
    pageNum++;
    if (pageNum > 50) break;
  }
  console.log('');

  // Guardar token si lo capturamos
  if (capturedTokens.size > 0) {
    const token = [...capturedTokens][0].replace('Bearer ', '');
    console.log(`🔑 Token de sesión capturado`);
    let envContent = readFileSync(ENV_FILE, 'utf8');
    if (envContent.includes('DROPI_SESSION_TOKEN=')) {
      envContent = envContent.replace(/DROPI_SESSION_TOKEN=.*/, `DROPI_SESSION_TOKEN=${token}`);
    } else {
      envContent += `\nDROPI_SESSION_TOKEN=${token}`;
    }
    writeFileSync(ENV_FILE, envContent);
  }

  // Guardar productos
  writeFileSync(OUT_FILE, JSON.stringify(dropiProducts, null, 2));
  console.log(`\n✅ ${dropiProducts.length} productos guardados en dropi-products.json`);

  // Mostrar resumen de imágenes
  const conFotos = dropiProducts.filter(p => p.photos?.length > 1);
  console.log(`📸 Productos con más de 1 imagen: ${conFotos.length}`);
  if (dropiProducts[0]) {
    const p = dropiProducts[0];
    console.log(`\nEjemplo — ${p.name}:`);
    console.log(`  Stock: ${p.stock}`);
    console.log(`  Precio sugerido: ${p.suggested_price}`);
    console.log(`  Imágenes: ${p.photos?.length}`);
    p.photos?.slice(0,2).forEach((f,i) => console.log(`    [${i+1}] ${f.urlS3 ? 'https://d39ru7awumhhs2.cloudfront.net/' + f.urlS3 : f.url}`));
  }

  await browser.close();
}

run().catch(async e => {
  console.error('❌', e.message);
  process.exit(1);
});
