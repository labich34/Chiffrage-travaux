// API Nettoyage cuisine — McDonald's La Côte
// Stockage : Vercel Blob (store public, connecté au projet → BLOB_READ_WRITE_TOKEN)
//   cfg/config-<suffixe aléatoire>.json   { salt, hash, keys:{GD,NC,ND} }
//   <SITE>/eq/<ts>-<suffixe>.json           [{id,nom}]
//   <SITE>/done/<lundi>/<id>/<pid>          coche (date = uploadedAt, pid = qui : id collaborateur, 'admin' ou '_' lien resto)
//   <SITE>/photo/<id>-<suffixe>.jpg         photo équipement
const { put, list, del } = require('@vercel/blob');
const crypto = require('crypto');

const SITES = { GD: 'Gland', NC: 'Nyon Centre', ND: 'Nyon Drive' };
const DEF_EQ = ['Friteuses', 'Grills', 'Toasters', 'Armoires de maintien (UHC)', 'Hotte et filtres',
  'Tables de préparation', 'Frigos sous-comptoir', 'Chambre froide', 'Congélateur', 'Machine à glace',
  'Machine à boissons', 'Machine à glaçons', 'Machine à café (McCafé)', 'Lave-vaisselle / plonge'];
const KEEP_WEEKS = 12;

let cfgCache = null, cfgAt = 0;

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function ymd(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
// Lundi de la semaine en cours, heure de Zurich
function curMonday() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
    .formatToParts(new Date()).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  const w = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - w);
  return ymd(d);
}
function addWeeks(mon, n) { const d = new Date(mon + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 7 * n); return ymd(d); }
function rnd(n) { return crypto.randomBytes(n).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, n); }
function hash(code, salt) { return crypto.scryptSync(String(code), salt, 32).toString('hex'); }
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

async function listAll(prefix) {
  let out = [], cursor;
  do {
    const r = await list({ prefix, cursor, limit: 1000 });
    out = out.concat(r.blobs);
    cursor = r.hasMore ? r.cursor : null;
  } while (cursor);
  return out;
}
async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('lecture ' + r.status);
  return r.json();
}

async function getCfg(force) {
  if (!force && cfgCache && Date.now() - cfgAt < 120000) return cfgCache;
  const b = (await listAll('cfg/')).sort((x, y) => new Date(y.uploadedAt) - new Date(x.uploadedAt));
  cfgCache = b.length ? Object.assign(await fetchJson(b[0].url), { _old: b.slice(1).map(x => x.url) }) : null;
  cfgAt = Date.now();
  return cfgCache;
}
async function saveCfg(c) {
  const clean = { salt: c.salt, hash: c.hash, keys: c.keys, people: c.people || {} };
  const prev = await listAll('cfg/');
  await put('cfg/config.json', JSON.stringify(clean), { access: 'public', addRandomSuffix: true, contentType: 'application/json', cacheControlMaxAge: 60 });
  if (prev.length) await del(prev.map(x => x.url));
  cfgCache = clean; cfgAt = Date.now();
}

function auth(cfg, key) {
  if (!cfg || !key) return null;
  if (safeEq(hash(key, cfg.salt), cfg.hash)) return { role: 'admin' };
  for (const s in cfg.keys) if (safeEq(key, cfg.keys[s])) return { role: 'equipier', site: s, pid: '_' };
  const pp = cfg.people || {};
  for (const pid in pp) if (pp[pid] && safeEq(key, pp[pid].key)) return { role: 'equipier', site: pp[pid].site, pid };
  return null;
}

async function readSite(site, week, prune) {
  const blobs = await listAll(site + '/');
  const eqB = [], done = {}, by = {}, photos = {}, old = [];
  const lim = addWeeks(curMonday(), -KEEP_WEEKS);
  for (const b of blobs) {
    const rest = b.pathname.slice(site.length + 1);
    if (rest.startsWith('eq/')) eqB.push(b);
    else if (rest.startsWith('done/')) {
      const parts = rest.split('/'); // done/<lundi>/<id>[/<pid>]
      if (parts[1] === week) {
        const t = new Date(b.uploadedAt).getTime();
        if (!done[parts[2]] || t > done[parts[2]]) { done[parts[2]] = t; by[parts[2]] = parts[3] || '_'; }
      }
      if (parts[1] < lim) old.push(b.url);
    } else if (rest.startsWith('photo/')) {
      const f = rest.slice(6), id = f.slice(0, f.lastIndexOf('-'));
      if (!photos[id] || photos[id].t < new Date(b.uploadedAt).getTime()) photos[id] = { url: b.url, t: new Date(b.uploadedAt).getTime() };
    }
  }
  eqB.sort((x, y) => new Date(y.uploadedAt) - new Date(x.uploadedAt));
  let eq = null;
  if (eqB.length) { try { eq = await fetchJson(eqB[0].url); } catch (e) { eq = null; } }
  if (!Array.isArray(eq)) eq = DEF_EQ.map((n, i) => ({ id: site + '_' + i, nom: n }));
  if (prune) {
    const kill = old.concat(eqB.slice(1).map(x => x.url));
    if (kill.length) await del(kill).catch(() => {});
  }
  const ph = {};
  for (const id in photos) ph[id] = photos[id].url;
  return { nom: SITES[site], eq, done, by, photos: ph };
}

function okId(s) { return typeof s === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(s); }
function okWeek(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) { console.error('NETT: BLOB_READ_WRITE_TOKEN absent'); return res.status(500).json({ err: 'Stockage Blob non connecté au projet' }); }
    const key = String(req.headers['x-key'] || '');
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    let cfg = await getCfg(false);

    // ---------- 1re installation : choix du code admin ----------
    if (!cfg) cfg = await getCfg(true);
    if (!cfg) {
      if (req.method === 'POST' && body.a === 'setup') {
        const code = String(body.code || '');
        if (code.length < 6) return res.status(400).json({ err: 'Code trop court (6 caractères min.)' });
        const salt = rnd(16);
        const c = { salt, hash: hash(code, salt), keys: { GD: rnd(12), NC: rnd(12), ND: rnd(12) } };
        await saveCfg(c);
        return res.json({ ok: true });
      }
      return res.json({ setup: true });
    }

    let who = auth(cfg, key);
    if (!who && key) { cfg = await getCfg(true); who = auth(cfg, key); }
    if (!who) return res.status(401).json({ err: 'Code ou lien invalide' });
    const cur = curMonday();

    if (req.method === 'GET') {
      const week = okWeek(req.query.w) ? req.query.w : cur;
      const out = { role: who.role, cur, week, sites: {} };
      if (who.role === 'equipier') {
        out.site = who.site;
        out.sites[who.site] = await readSite(who.site, week, false);
        delete out.sites[who.site].by; // les noms ne sont visibles que par l'admin
      } else {
        const ks = Object.keys(SITES);
        const prune = Math.random() < 0.2;
        const r = await Promise.all(ks.map(s => readSite(s, week, prune)));
        ks.forEach((s, i) => { out.sites[s] = r[i]; });
        out.keys = cfg.keys;
        const people = cfg.people || {}, names = { admin: 'Toi', _: 'Lien resto' };
        for (const pid in people) names[pid] = people[pid].nom;
        ks.forEach(s => { const b = out.sites[s].by; for (const id in b) b[id] = names[b[id]] || 'Lien supprimé'; });
        out.people = people;
      }
      return res.json(out);
    }

    if (req.method !== 'POST') return res.status(405).json({ err: 'Méthode' });
    const site = body.site;
    if (!SITES[site]) return res.status(400).json({ err: 'Site' });
    if (who.role === 'equipier' && site !== who.site) return res.status(403).json({ err: 'Accès refusé' });

    if (body.a === 'toggle') {
      if (!okId(body.id)) return res.status(400).json({ err: 'Équipement' });
      const base = site + '/done/' + cur + '/' + body.id;
      const pid = who.role === 'admin' ? 'admin' : who.pid;
      if (body.on) await put(base + '/' + pid, '1', { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'text/plain' });
      else {
        const marks = (await listAll(base + '/')).map(x => x.url);
        await del(marks.concat([base])).catch(() => {});
      }
      return res.json({ ok: true, t: Date.now() });
    }

    if (who.role !== 'admin') return res.status(403).json({ err: 'Réservé à l’admin' });

    if (body.a === 'eq') {
      if (!Array.isArray(body.eq) || body.eq.length > 80) return res.status(400).json({ err: 'Liste' });
      const eq = [];
      for (const e of body.eq) {
        if (!e || !okId(e.id)) continue;
        const nom = String(e.nom || '').trim().slice(0, 60);
        if (nom) eq.push({ id: e.id, nom });
      }
      await put(site + '/eq/' + Date.now() + '.json', JSON.stringify(eq), { access: 'public', addRandomSuffix: true, contentType: 'application/json' });
      return res.json({ ok: true });
    }

    if (body.a === 'photo') {
      if (!okId(body.id)) return res.status(400).json({ err: 'Équipement' });
      const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
      if (!m) return res.status(400).json({ err: 'Image' });
      const buf = Buffer.from(m[1], 'base64');
      if (buf.length > 600000) return res.status(400).json({ err: 'Image trop lourde' });
      const old = await listAll(site + '/photo/' + body.id + '-');
      const r = await put(site + '/photo/' + body.id + '.jpg', buf, { access: 'public', addRandomSuffix: true, contentType: 'image/jpeg' });
      if (old.length) await del(old.map(x => x.url)).catch(() => {});
      return res.json({ ok: true, url: r.url });
    }

    if (body.a === 'delphoto') {
      if (!okId(body.id)) return res.status(400).json({ err: 'Équipement' });
      const old = await listAll(site + '/photo/' + body.id + '-');
      if (old.length) await del(old.map(x => x.url));
      return res.json({ ok: true });
    }

    if (body.a === 'addPerson') {
      const nom = String(body.nom || '').trim().slice(0, 40);
      if (!nom) return res.status(400).json({ err: 'Nom manquant' });
      const c = await getCfg(true);
      c.people = c.people || {};
      const pid = 'p' + rnd(8), k = rnd(14);
      c.people[pid] = { nom, site, key: k };
      await saveCfg(c);
      return res.json({ ok: true, pid, person: c.people[pid] });
    }

    if (body.a === 'delPerson') {
      const c = await getCfg(true);
      if (c.people && c.people[body.pid]) { delete c.people[body.pid]; await saveCfg(c); }
      return res.json({ ok: true });
    }

    if (body.a === 'regen') {
      const c = await getCfg(true);
      c.keys[site] = rnd(12);
      await saveCfg(c);
      return res.json({ ok: true, key: c.keys[site] });
    }

    return res.status(400).json({ err: 'Action inconnue' });
  } catch (e) {
    console.error('NETT error', e && e.stack || e);
    return res.status(500).json({ err: 'Erreur serveur : ' + (e && e.message ? e.message : e) });
  }
};
