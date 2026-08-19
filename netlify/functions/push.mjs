// ---------------------------------------------------------------------------
// Studio Au Bas des Crêtes — abonnements et envoi des notifications push
// (Web Push / VAPID, même principe que l'app PRODETEC)
//
// GET                                   -> { publicKey }  (clé publique VAPID)
// POST { action:'subscribe', ... }      -> enregistre un appareil (mot de passe requis)
// POST { action:'unsubscribe', ... }    -> retire un appareil (mot de passe requis)
// POST { action:'list' }                -> liste des appareils abonnés (mot de passe requis)
// POST { action:'test' }                -> envoie une notification de test (mot de passe requis)
//
// Variables d'environnement Netlify :
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT (mailto:…)
//   ADMIN_PASSWORD, NETLIFY_SITE_ID, NETLIFY_API_TOKEN
// ---------------------------------------------------------------------------
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';

const KEY = 'push_subs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function openStore() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN;
  if (siteID && token) return getStore({ name: 'studio', siteID, token });
  return getStore('studio');
}

const json = (statusCode, data) => ({
  statusCode,
  headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(data)
});

async function readSubs(store) {
  try { return (await store.get(KEY, { type: 'json' })) || []; } catch (e) { return []; }
}

// Envoi partagé avec la fonction "order"
export async function sendToAll(payloadObj) {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return { envoye: 0, erreur: 'Clés VAPID absentes' };

  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:contact@example.com', pub, priv);

  const store = openStore();
  const subs = await readSubs(store);
  if (!subs.length) return { envoye: 0, raison: 'aucun appareil abonné' };

  const payload = JSON.stringify(payloadObj);
  let ok = 0;
  const morts = [];
  const echecs = [];

  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 86400 }
      );
      ok++;
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) morts.push(s.endpoint);
      echecs.push({ nom: s.nom, code: code || String(e).slice(0, 80) });
    }
  }

  if (morts.length) {
    const restants = subs.filter((s) => !morts.includes(s.endpoint));
    try { await store.setJSON(KEY, restants); } catch (e) { /* ignore */ }
  }

  return { envoye: ok, appareils: subs.length, nettoyes: morts.length, echecs };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  if (event.httpMethod === 'GET') {
    return json(200, { publicKey: process.env.VAPID_PUBLIC_KEY || '' });
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  const token = event.headers['x-admin-token'];
  if (!process.env.ADMIN_PASSWORD || token !== process.env.ADMIN_PASSWORD) {
    return json(401, { error: 'unauthorized' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad json' }); }

  let store;
  try { store = openStore(); } catch (e) { return json(500, { error: 'store init failed' }); }

  const action = body.action;

  if (action === 'subscribe') {
    const sub = body.subscription;
    if (!sub || !sub.endpoint || !sub.keys) return json(400, { error: 'abonnement invalide' });
    const subs = await readSubs(store);
    const sansDoublon = subs.filter((s) => s.endpoint !== sub.endpoint);
    sansDoublon.push({
      nom: String(body.nom || 'Hôte').slice(0, 40),
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      ua: String(body.ua || '').slice(0, 160),
      date: new Date().toISOString()
    });
    await store.setJSON(KEY, sansDoublon);
    return json(200, { ok: true, appareils: sansDoublon.length });
  }

  if (action === 'unsubscribe') {
    const subs = await readSubs(store);
    const restants = subs.filter((s) => s.endpoint !== body.endpoint);
    await store.setJSON(KEY, restants);
    return json(200, { ok: true, appareils: restants.length });
  }

  if (action === 'list') {
    const subs = await readSubs(store);
    return json(200, {
      appareils: subs.map((s) => ({ nom: s.nom, date: s.date, ua: s.ua, endpoint: s.endpoint }))
    });
  }

  if (action === 'test') {
    const r = await sendToAll({
      titre: '🔔 Test — Studio Au Bas des Crêtes',
      message: 'Les notifications fonctionnent : vous serez prévenu à chaque commande.',
      url: './#admin'
    });
    return json(200, r);
  }

  return json(400, { error: 'action inconnue' });
};
