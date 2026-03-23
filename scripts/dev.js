import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const SYNC_INTERVAL = 5 * 60 * 1000;

function loadEnv() {
  const env = readFileSync(resolve(__dir, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const [k, ...v] = line.split('=');
    if (k?.trim() && v.length) process.env[k.trim()] = v.join('=').trim();
  }
}
loadEnv();

// ── Shopify Theme Dev (preview en vivo) ───────────────────────────────────────
function startThemeDev() {
  console.log('🎨 Iniciando shopify theme dev...');
  const proc = spawn('shopify', ['theme', 'dev', '--store', process.env.SHOPIFY_STORE], {
    stdio: 'inherit',
    shell: true,
    cwd: resolve(__dir, '..')
  });
  proc.on('error', e => console.error('❌ theme dev error:', e.message));
  proc.on('exit', code => {
    if (code !== 0) {
      console.log('⚠️  theme dev se cerró, reiniciando en 5s...');
      setTimeout(startThemeDev, 5000);
    }
  });
}

// ── Auto-Sync Loop ────────────────────────────────────────────────────────────
function runSync() {
  const proc = spawn('node', [resolve(__dir, 'auto-sync.js')], {
    stdio: 'inherit',
    shell: false
  });
  proc.on('error', e => console.error('❌ sync error:', e.message));
}

// ── Arranque ──────────────────────────────────────────────────────────────────
console.log('🛠  El Estante CL — MODO DESARROLLO');
console.log('━'.repeat(50));
console.log('🎨 Theme dev activo — los cambios se ven en el preview');
console.log(`⏱  Auto-sync cada ${SYNC_INTERVAL / 60000} minutos`);
console.log('⚠️  NO afecta el tema live hasta que corras: npm run theme:push');
console.log('━'.repeat(50) + '\n');

startThemeDev();

setTimeout(() => {
  runSync();
  setInterval(runSync, SYNC_INTERVAL);
}, 10_000);

process.on('SIGINT', () => {
  console.log('\n👋 Cerrando modo dev...');
  process.exit(0);
});
