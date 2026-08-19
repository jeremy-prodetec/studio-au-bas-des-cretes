// ---------------------------------------------------------------------------
// Studio Au Bas des Crêtes — abonnements et envoi des notifications push
// (Web Push / VAPID, même principe que l'app PRODETEC)
//
// GET                                -> { publicKey }
// POST { action:'subscribe', ... }   -> enregistre un appareil (mot de passe requis)
// POST { action:'unsubscribe', ... } -> retire un appareil
// POST { action:'list' }             -> liste des appareils abonnés
// POST { action:'test' }             -> notification de test
// POST { action:'diag' }             -> état des variables et du stockage
//
// Variables Netlify : VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
//                     ADMIN_PASSWORD (+ NETLIFY_SITE_ID / NETLIFY_API_TOKEN en secours)
// ---------------------------------------------------------------------------
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';

const KEY = 'push_subs';

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

async function readSubs() {
  try { return (await lire(KEY)) || []; } catch (e) { return []; }
}

async function sendToAll(payloadObj) {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return { envoye: 0, erreur: 'cles VAPID absentes' };

  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:contact@example.com', pub, priv);

  const subs = await readSubs();
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
    try { await ecrire(KEY, subs.filter((s) => !morts.includes(s.endpoint))); } catch (e) { /* ignore */ }
  }

  return { envoye: ok, appareils: subs.length, nettoyes: morts.length, echecs };
}

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
    return json(200, { publicKey: process.env.VAPID_PUBLIC_KEY || '' });
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  const token = event.headers['x-admin-token'];
  if (!process.env.ADMIN_PASSWORD || token !== process.env.ADMIN_PASSWORD) {
    return json(401, { error: 'unauthorized' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad json' }); }

  const action = body.action;

  // --- diagnostic ---
  if (action === 'diag') {
    const vars = {
      ADMIN_PASSWORD: !!process.env.ADMIN_PASSWORD,
      VAPID_PUBLIC_KEY: !!process.env.VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: !!process.env.VAPID_PRIVATE_KEY,
      VAPID_SUBJECT: !!process.env.VAPID_SUBJECT,
      NETLIFY_SITE_ID: !!process.env.NETLIFY_SITE_ID,
      NETLIFY_API_TOKEN: !!process.env.NETLIFY_API_TOKEN
    };
    let stockage = 'ok';
    let mode = '';
    try {
      // on note quel accès a fonctionné
      const list = candidats();
      let i = 0, reussi = -1, derniere;
      for (const st of list) {
        try { await st.setJSON('diag', { t: new Date().toISOString() }); reussi = i; break; }
        catch (e) { derniere = e; i++; }
      }
      if (reussi < 0) throw derniere || new Error('aucun accès au stockage');
      mode = reussi === 0 && list.length ? 'automatique' : 'via NETLIFY_API_TOKEN';
      const relu = await lire('diag');
      if (!relu || !relu.t) stockage = 'écriture ok mais relecture vide';
    } catch (e) {
      stockage = 'ERREUR : ' + String((e && (e.name + ' — ' + e.message)) || e).slice(0, 250);
    }
    return json(200, { variables: vars, stockage, mode });
  }

  if (action === 'subscribe') {
    const sub = body.subscription;
    if (!sub || !sub.endpoint || !sub.keys) return json(400, { error: 'abonnement invalide' });
    try {
      const subs = await readSubs();
      const sansDoublon = subs.filter((s) => s.endpoint !== sub.endpoint);
      sansDoublon.push({
        nom: String(body.nom || 'Hôte').slice(0, 40),
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        ua: String(body.ua || '').slice(0, 160),
        date: new Date().toISOString()
      });
      await ecrire(KEY, sansDoublon);
      return json(200, { ok: true, appareils: sansDoublon.length });
    } catch (e) {
      return json(500, { error: 'stockage indisponible', detail: String((e && e.message) || e).slice(0, 300) });
    }
  }

  if (action === 'unsubscribe') {
    try {
      const subs = await readSubs();
      const restants = subs.filter((s) => s.endpoint !== body.endpoint);
      await ecrire(KEY, restants);
      return json(200, { ok: true, appareils: restants.length });
    } catch (e) {
      return json(500, { error: 'stockage indisponible', detail: String((e && e.message) || e).slice(0, 300) });
    }
  }

  if (action === 'list') {
    const subs = await readSubs();
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
