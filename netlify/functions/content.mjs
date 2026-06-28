// Fonction Netlify : lecture/écriture du contenu de l'app (Netlify Blobs)
import { getStore } from '@netlify/blobs';

const KEY = 'content';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function openStore() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN;
  if (siteID && token) {
    return getStore({ name: 'studio', siteID, token });
  }
  return getStore('studio');
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  let store;
  try {
    store = openStore();
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'store init failed', detail: String(e && e.message || e) }) };
  }

  if (event.httpMethod === 'GET') {
    let data = null;
    try { data = await store.get(KEY, { type: 'json' }); } catch (e) { data = null; }
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify(data ?? null)
    };
  }

  if (event.httpMethod === 'POST') {
    const token = event.headers['x-admin-token'];
    const ok = process.env.ADMIN_PASSWORD && token === process.env.ADMIN_PASSWORD;
    if (!ok) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    let payload;
    try { payload = JSON.parse(event.body || '{}'); }
    catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'bad json' }) }; }

    if (payload && payload.verify === true) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
    }

    if (!payload || !payload.config || !Array.isArray(payload.services)) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'invalid content' }) };
    }

    try {
      await store.setJSON(KEY, payload);
    } catch (e) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'save failed', detail: String(e && e.message || e) }) };
    }
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
};