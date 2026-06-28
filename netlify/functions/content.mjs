// Fonction Netlify : lecture/écriture du contenu de l'app (Netlify Blobs)
// GET  -> renvoie le contenu courant (public)
// POST -> { verify:true }  : vérifie le mot de passe (header x-admin-token)
//         sinon            : enregistre le contenu (mot de passe requis)
import { getStore } from '@netlify/blobs';

const KEY = 'content';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

export const handler = async (event) => {
  const store = getStore('studio');

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
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

    // Connexion : on vérifie seulement le mot de passe, sans rien écrire
    if (payload && payload.verify === true) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
    }

    // Sécurité minimale : on n'enregistre qu'un contenu bien formé
    if (!payload || !payload.config || !Array.isArray(payload.services)) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'invalid content' }) };
    }

    await store.setJSON(KEY, payload);
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
};
