// Dropi API Proxy — Cloudflare Worker
// Permite llamar a la API de Dropi desde cualquier IP

const DROPI_BASE = 'https://api.dropi.cl';
const ALLOWED_ORIGIN = 'https://el-estante-cl.myshopify.com';

export default {
  async fetch(request, env) {
    // SECRET_KEY viene de Cloudflare Dashboard → Settings → Variables
    const SECRET_KEY = env.SECRET_KEY || '';

    const origin = request.headers.get('Origin') || '';
    const corsOrigin = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : ALLOWED_ORIGIN;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': corsOrigin,
          'Access-Control-Allow-Methods': 'POST, GET',
          'Access-Control-Allow-Headers': 'x-proxy-secret, x-dropi-token, x-dropi-method, x-dropi-auth-type, Content-Type'
        }
      });
    }

    // Verificar clave secreta
    const secret = request.headers.get('x-proxy-secret');
    if (!SECRET_KEY || secret !== SECRET_KEY) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Obtener path destino y token de Dropi
    const url = new URL(request.url);
    const path = url.searchParams.get('path') || '/integrations/products/index';
    const dropiToken = request.headers.get('x-dropi-token');
    const method = request.headers.get('x-dropi-method') || 'POST';

    if (!dropiToken) {
      return new Response(JSON.stringify({ error: 'Missing dropi token' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Construir request hacia Dropi
    const dropiUrl = `${DROPI_BASE}${path}`;
    const authHeader = request.headers.get('x-dropi-auth-type') === 'session'
      ? { 'x-authorization': `Bearer ${dropiToken}` }
      : { 'dropi-integration-key': dropiToken };

    const dropiHeaders = {
      'Content-Type': 'application/json',
      ...authHeader,
      'Origin': 'https://app.dropi.cl',
      'Referer': 'https://app.dropi.cl/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };

    let dropiOptions = { method, headers: dropiHeaders };
    if (method === 'POST' || method === 'PUT') {
      dropiOptions.body = await request.text();
    }

    // Llamar a Dropi
    const dropiRes = await fetch(dropiUrl, dropiOptions);
    const data = await dropiRes.text();

    return new Response(data, {
      status: dropiRes.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': corsOrigin
      }
    });
  }
};
