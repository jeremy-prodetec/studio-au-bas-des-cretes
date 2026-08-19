// Fonction Netlify : lecture/écriture du contenu de l'app (Netlify Blobs)
import { getStore } from '@netlify/blobs';

const KEY = 'content';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

/* --- Accès au stockage Netlify Blobs, tolérant aux pannes ---------------
   1) mode automatique (aucune variable à maintenir) ;
   2) repli sur NETLIFY_SITE_ID + NETLIFY_API_TOKEN si le mode auto échoue.
   Chaque opération essaie les deux avant d'abandonner.                     */
function candidats() {
  const out = [];
  try { out.push(getStore('studio')); } catch (e) { /* environnement Blobs absent */ }
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN;
  if (siteID && token) {
    try { out.push(getStore({ name: 'studio', siteID, token })); } catch (e) { /* ignore */ }
  }
  return out;
}

async function avecStore(fn) {
  const list = candidats();
  if (!list.length) throw new Error('Netlify Blobs indisponible (aucune configuration exploitable)');
  let derniere;
  for (const st of list) {
    try { return await fn(st); } catch (e) { derniere = e; }
  }
  throw derniere;
}

const lire = (cle) => avecStore((st) => st.get(cle, { type: 'json' }));
const ecrire = (cle, valeur) => avecStore((st) => st.setJSON(cle, valeur));

const json = (statusCode, data) => ({
  statusCode,
  headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(data)
});

export const handler = async (event) => {
  try {
    return await router(event);
  } catch (e) {
    return json(500, { error: 'erreur interne', detail: String((e && e.message) || e).slice(0, 300) });
  }
};

const router = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  if (event.httpMethod === 'GET') {
    // ?debug=1 renvoie l'erreur de stockage au lieu de la masquer
    const debug = /[?&]debug=1/.test(event.rawQuery || event.rawUrl || '');
    try {
      const data = await lire(KEY);
      return json(200, data ?? null);
    } catch (e) {
      if (debug) return json(500, { error: 'stockage indisponible', detail: String((e && e.message) || e).slice(0, 300) });
      return json(200, null); // l'app garde ses valeurs par défaut
    }
  }

  if (event.httpMethod === 'POST') {
    const token = event.headers['x-admin-token'];
    if (!process.env.ADMIN_PASSWORD || token !== process.env.ADMIN_PASSWORD) {
      return json(401, { error: 'unauthorized' });
    }

    let payload;
    try { payload = JSON.parse(event.body || '{}'); }
    catch (e) { return json(400, { error: 'bad json' }); }

    if (payload && payload.verify === true) return json(200, { ok: true });

    if (!payload || typeof payload.config !== 'object' || !Array.isArray(payload.services)) {
      return json(400, { error: 'invalid content' });
    }

    try {
      await ecrire(KEY, payload);
    } catch (e) {
      return json(500, { error: 'enregistrement impossible', detail: String((e && e.message) || e).slice(0, 300) });
    }
    return json(200, { ok: true });
  }

  return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
};
