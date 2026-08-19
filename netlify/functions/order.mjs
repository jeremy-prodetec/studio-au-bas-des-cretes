// ---------------------------------------------------------------------------
// Studio Au Bas des Crêtes — réception des commandes et des demandes
//
// POST (public) { type:'commande'|'demande', ... }  -> enregistre + notifie l'hôte
// POST { action:'list' }     (mot de passe)         -> journal des commandes
// POST { action:'done', id } (mot de passe)         -> marque comme traitée
// POST { action:'clear' }    (mot de passe)         -> vide le journal
// ---------------------------------------------------------------------------
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';

const ORDERS = 'orders';
const SUBS = 'push_subs';
const MAX_ORDERS = 200;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
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

// retire les caractères de contrôle et limite la longueur
const clean = (v, max = 300) =>
  String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);

async function notifier(titre, message) {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return { envoye: 0, erreur: 'cles VAPID absentes' };
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:contact@example.com', pub, priv);

  let subs = [];
  try { subs = (await lire(SUBS)) || []; } catch (e) { subs = []; }
  if (!subs.length) return { envoye: 0, raison: 'aucun appareil abonne' };

  const payload = JSON.stringify({ titre, message: message.slice(0, 300), url: './#admin', urgent: true });
  let ok = 0;
  const morts = [];
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
    }
  }
  if (morts.length) {
    try { await ecrire(SUBS, subs.filter((s) => !morts.includes(s.endpoint))); } catch (e) { /* ignore */ }
  }
  return { envoye: ok, appareils: subs.length };
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
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
  if ((event.body || '').length > 20000) return json(413, { error: 'trop volumineux' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad json' }); }

  const readOrders = async () => {
    try { return (await lire(ORDERS)) || []; } catch (e) { return []; }
  };

  // ---------- Actions réservées à l'hôte ----------
  if (body.action) {
    const token = event.headers['x-admin-token'];
    if (!process.env.ADMIN_PASSWORD || token !== process.env.ADMIN_PASSWORD) {
      return json(401, { error: 'unauthorized' });
    }
    const orders = await readOrders();

    if (body.action === 'list') return json(200, { commandes: orders });

    if (body.action === 'done') {
      const maj = orders.map((o) => (o.id === body.id ? { ...o, traite: !o.traite } : o));
      try { await ecrire(ORDERS, maj); } catch (e) { return json(500, { error: 'stockage indisponible' }); }
      return json(200, { ok: true, commandes: maj });
    }

    if (body.action === 'clear') {
      try { await ecrire(ORDERS, []); } catch (e) { return json(500, { error: 'stockage indisponible' }); }
      return json(200, { ok: true, commandes: [] });
    }

    return json(400, { error: 'action inconnue' });
  }

  // ---------- Nouvelle commande / demande (public) ----------
  const type = body.type === 'demande' ? 'demande' : 'commande';
  const now = new Date();

  const commande = {
    id: 'o' + now.getTime().toString(36) + Math.random().toString(36).slice(2, 6),
    type,
    date: now.toISOString(),
    client: clean(body.client, 80),
    tel: clean(body.tel, 40),
    sejour: clean(body.sejour, 120),
    message: clean(body.message, 600),
    paiement: clean(body.paiement, 40),
    total: Number(body.total) || 0,
    titre: clean(body.titre, 80),
    lignes: Array.isArray(body.lignes)
      ? body.lignes.slice(0, 40).map((l) => ({
          nom: clean(l.nom, 80),
          qte: Number(l.qte) || 1,
          prix: Number(l.prix) || 0
        }))
      : [],
    reponses: Array.isArray(body.reponses)
      ? body.reponses.slice(0, 15).map((r) => ({ label: clean(r.label, 80), valeur: clean(r.valeur, 200) }))
      : [],
    traite: false
  };

  if (type === 'commande' && !commande.lignes.length) return json(400, { error: 'commande vide' });

  const orders = await readOrders();
  orders.unshift(commande);
  let enregistre = true;
  try { await ecrire(ORDERS, orders.slice(0, MAX_ORDERS)); } catch (e) { enregistre = false; }

  // ---------- Notification push ----------
  let titre, message;
  if (type === 'commande') {
    titre = '🛎️ Nouvelle commande — ' + (commande.total ? commande.total + ' €' : 'studio');
    message =
      (commande.client ? commande.client + ' : ' : '') +
      commande.lignes.map((l) => l.nom + ' ×' + l.qte).join(', ') +
      (commande.paiement ? ' — ' + commande.paiement : '');
  } else {
    titre = '✉️ ' + (commande.titre || 'Nouvelle demande');
    message =
      (commande.client ? commande.client + ' : ' : '') +
      commande.reponses.map((r) => r.label + ' : ' + r.valeur).join(' · ') +
      (commande.message ? ' — ' + commande.message : '');
  }

  const push = await notifier(titre, message || 'Voir le détail dans l’espace hôte.');

  return json(200, { ok: true, id: commande.id, enregistre, push });
};
