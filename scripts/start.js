import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir         = dirname(fileURLToPath(import.meta.url));
const SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutos

function loadEnv() {
  const env = readFileSync(resolve(__dir, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const [k, ...v] = line.split('=');
    if (k?.trim() && v.length) process.env[k.trim()] = v.join('=').trim();
  }
}
loadEnv();

const ordersOnly = process.argv.includes('--orders-only');
const noImages   = process.argv.includes('--no-images');

// ── Auto-Sync Loop ────────────────────────────────────────────────────────────
function runSync() {
  const args = [resolve(__dir, 'auto-sync.js')];
  if (ordersOnly) args.push('--orders-only');
  if (noImages)   args.push('--no-images');
  const proc = spawn('node', args, {
    stdio: 'inherit', shell: false
  });
  proc.on('error', e => console.error('❌ sync error:', e.message));
}

// ── Arranque ──────────────────────────────────────────────────────────────────
const modo = ordersOnly ? 'Solo órdenes ML' : noImages ? 'Sin imágenes' : 'Completo';
console.log('🚀 El Estante CL — ' + modo);
console.log('━'.repeat(50));
console.log(`⏱  Auto-sync cada ${SYNC_INTERVAL / 60000} minutos`);
console.log('━'.repeat(50) + '\n');

setTimeout(() => {
  runSync();
  setInterval(runSync, SYNC_INTERVAL);
}, 10_000);

process.on('SIGINT', () => {
  console.log('\n👋 Cerrando...');
  process.exit(0);
});
