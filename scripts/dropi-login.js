import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dir = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(__dir, '../.env');

function loadEnv() {
  try {
    const env = readFileSync(ENV_FILE, 'utf8');
    for (const line of env.split('\n')) {
      const [k, ...v] = line.split('=');
      if (k?.trim() && v.length) process.env[k.trim()] = v.join('=').trim();
    }
  } catch {}
}

function updateEnv(key, value) {
  let content = '';
  try { content = readFileSync(ENV_FILE, 'utf8'); } catch {}
  const lines = content.split('\n');
  const idx = lines.findIndex(l => l.startsWith(key + '='));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(ENV_FILE, lines.join('\n'));
}

function ask(question, hidden = false) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      process.stdout.write(question);
      process.stdin.setRawMode(true);
      let input = '';
      process.stdin.on('data', (char) => {
        char = char.toString();
        if (char === '\n' || char === '\r') {
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          rl.close();
          resolve(input);
        } else if (char === '\u0003') {
          process.exit();
        } else if (char === '\u007f') {
          input = input.slice(0, -1);
        } else {
          input += char;
          process.stdout.write('*');
        }
      });
    } else {
      rl.question(question, (ans) => { rl.close(); resolve(ans); });
    }
  });
}

async function run() {
  loadEnv();
  console.log('\n🔐 Login Dropi — obtener token de usuario');
  console.log('─'.repeat(45));

  const email = await ask('Email Dropi: ');
  const password = await ask('Contraseña: ', true);

  console.log('\n⏳ Obteniendo token...');

  const res = await fetch('https://api.dropi.cl/integrations/login/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, white_brand_id: 4 })
  });

  const data = await res.json();

  if (!data.isSuccess || !data.token) {
    console.error(`❌ Error: ${data.message || 'Login fallido'}`);
    process.exit(1);
  }

  updateEnv('DROPI_USER_TOKEN', data.token);

  console.log('✅ Token guardado en .env como DROPI_USER_TOKEN');
  console.log(`   Usuario ID: ${data.user?.id || 'N/A'}`);
  console.log('\nYa puedes correr: npm run dropi:sync');
}

run().catch(e => { console.error('❌', e.message); process.exit(1); });
