import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { resolve as resolvePath, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir         = dirname(fileURLToPath(import.meta.url));
const SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutos

function loadEnv() {
  const env = readFileSync(resolvePath(__dir, '../.env'), 'utf8');
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
  return new Promise(done => {
    const args = [resolvePath(__dir, 'auto-sync.js')];
    if (ordersOnly) args.push('--orders-only');
    if (noImages)   args.push('--no-images');
    const proc = spawn('node', args, { stdio: 'inherit', shell: false });
    proc.on('error', e => { console.error('❌ sync error:', e.message); done(); });
    proc.on('close', () => done());
  });
}

async function loop() {
  while (true) {
    await runSync();
    console.log(`\n⏳ Esperando ${SYNC_INTERVAL / 60000} min para el siguiente sync...`);
    await new Promise(r => setTimeout(r, SYNC_INTERVAL));
  }
}

// ── Arranque ──────────────────────────────────────────────────────────────────
const modo = ordersOnly ? 'Solo órdenes ML' : noImages ? 'Sin imágenes' : 'Completo';
console.log('🚀 El Estante CL — ' + modo);
console.log('━'.repeat(50));
console.log(`⏱  Auto-sync cada ${SYNC_INTERVAL / 60000} min (espera a que termine antes de reiniciar)`);
console.log('━'.repeat(50) + '\n');

setTimeout(() => loop(), 10_000);

process.on('SIGINT', () => {
  console.log('\n👋 Cerrando...');
  process.exit(0);
});
