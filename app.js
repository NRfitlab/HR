'use strict';
/* HR Logger — Polar H10 via Web Bluetooth. Aucune dépendance. */
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const p2 = n => String(n).padStart(2, '0');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- IndexedDB ---------- */
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('hr-logger', 2);
  r.onupgradeneeded = () => {
    const db = r.result, has = n => db.objectStoreNames.contains(n);
    if (!has('sessions')) db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
    if (!has('samples')) db.createObjectStore('samples', { keyPath: 'id', autoIncrement: true }).createIndex('sessionId', 'sessionId');
    if (!has('markers')) db.createObjectStore('markers', { keyPath: 'id', autoIncrement: true }).createIndex('sessionId', 'sessionId');
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function run(stores, mode, fn) {
  const db = await dbp, t = db.transaction(stores, mode);
  let out;
  const done = new Promise((res, rej) => {
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
  const r = fn(t);
  if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
  return done;
}
const os = (t, n) => t.objectStore(n);
const getSessions = () => run('sessions', 'readonly', t => os(t, 'sessions').getAll());
const getBySession = (n, id) => run(n, 'readonly', t => os(t, n).index('sessionId').getAll(id));
const putSession = s => run('sessions', 'readwrite', t => os(t, 'sessions').put(s));
const putMarker = m => run('markers', 'readwrite', t => os(t, 'markers').put(m));
async function deleteSession(id) {
  const db = await dbp, t = db.transaction(['sessions', 'samples', 'markers'], 'readwrite');
  const done = new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  os(t, 'sessions').delete(id);
  for (const n of ['samples', 'markers']) {
    os(t, n).index('sessionId').openKeyCursor(IDBKeyRange.only(id)).onsuccess = e => {
      const c = e.target.result;
      if (c) { os(t, n).delete(c.primaryKey); c.continue(); }
    };
  }
  return done;
}

/* ---------- État ---------- */
const S = {
  device: null, connected: false, connecting: false, reconnecting: false, userDisc: false,
  rec: null, samples: [], markers: [], view: null, editing: null, last: null, wl: null, sessions: []
};

/* ---------- Formats ---------- */
function fmtHMS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s % 3600 / 60))}:${p2(s % 60)}`;
}
const fmtDT = t => { const d = new Date(t); return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const stamp = t => { const d = new Date(t); return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`; };
const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'seance';

function computeStats(samples) {
  let n = 0, sum = 0, max = 0, min = Infinity;
  for (const s of samples) if (s.hr > 0 && s.c !== 0) { n++; sum += s.hr; if (s.hr > max) max = s.hr; if (s.hr < min) min = s.hr; }
  return n ? { n, avg: Math.round(sum / n), max, min } : { n: 0 };
}

/* ---------- Données affichées ---------- */
function current() {
  if (S.view) {
    const v = S.view, last = v.samples.length ? v.samples[v.samples.length - 1].t : v.session.startedAt;
    return { live: false, samples: v.samples, markers: v.markers, t0: v.session.startedAt, tEnd: v.session.endedAt || last, name: v.session.name };
  }
  if (S.rec) return { live: true, samples: S.samples, markers: S.markers, t0: S.rec.startedAt, name: S.rec.name };
  return null;
}
const sortedMarkers = () => { const D = current(); return D ? [...D.markers].sort((a, b) => a.t - b.t) : []; };

/* ---------- Bluetooth ---------- */
async function setupGatt() {
  const server = await S.device.gatt.connect();
  const svc = await server.getPrimaryService('heart_rate');
  const ch = await svc.getCharacteristic('heart_rate_measurement');
  ch.addEventListener('characteristicvaluechanged', onHR);
  await ch.startNotifications();
  S.connected = true;
  setConn('on', `Connecté · ${S.device.name || 'capteur'}`);
  updateUI();
  readBattery(server);
}
async function readBattery(server) {
  try {
    const s = await server.getPrimaryService('battery_service');
    const c = await s.getCharacteristic('battery_level');
    $('batt').textContent = `Batterie ${(await c.readValue()).getUint8(0)} %`;
  } catch { /* optionnel */ }
}
async function connectClick() {
  S.userDisc = false; S.connecting = true; updateUI();
  try {
    S.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: ['heart_rate'] }],
      optionalServices: ['battery_service']
    });
    S.device.addEventListener('gattserverdisconnected', onDisc);
    setConn('wait', 'Connexion…');
    await setupGatt();
  } catch (e) {
    if (e.name !== 'NotFoundError') showBanner(`Connexion impossible : ${e.message}`, true);
    setConn('off', 'Déconnecté');
  } finally { S.connecting = false; updateUI(); }
}
function disconnectClick() {
  if (S.rec && !confirm('Un enregistrement est en cours. Déconnecter le capteur ?')) return;
  S.userDisc = true;
  if (S.device && S.device.gatt.connected) S.device.gatt.disconnect();
  S.connected = false; S.reconnecting = false; S.last = null;
  setConn('off', 'Déconnecté'); renderLive(); updateUI();
}
function onDisc() {
  S.connected = false; S.last = null; renderLive();
  if (S.userDisc) { setConn('off', 'Déconnecté'); updateUI(); return; }
  reconnectLoop();
}
async function reconnectLoop() {
  if (S.reconnecting) return;
  S.reconnecting = true; updateUI();
  let delay = 1000;
  while (!S.connected && !S.userDisc) {
    setConn('wait', 'Reconnexion…');
    try { await setupGatt(); break; }
    catch { await sleep(delay); delay = Math.min(delay * 1.5, 8000); }
  }
  S.reconnecting = false;
  if (!S.connected) setConn('off', 'Déconnecté');
  updateUI();
}

function onHR(e) {
  const t = Date.now(), { hr, contact, rr } = parseHR(e.target.value);
  S.last = { hr, contact, t };
  if (S.rec) {
    const s = { sessionId: S.rec.id, t, hr, rr, c: contact };
    S.samples.push(s);
    run('samples', 'readwrite', tx => os(tx, 'samples').add(s)).catch(console.error);
  }
  renderLive();
  if (S.rec && !S.view) draw();
}

/* ---------- Enregistrement ---------- */
async function startRec() {
  const t0 = Date.now();
  const name = $('session-name').value.trim() || `Séance ${fmtDT(t0)}`;
  const id = await run('sessions', 'readwrite', t => os(t, 'sessions').add({ name, startedAt: t0, endedAt: null, device: S.device ? S.device.name : null }));
  S.rec = { id, name, startedAt: t0 }; S.samples = []; S.markers = []; S.view = null;
  navigator.storage && navigator.storage.persist && navigator.storage.persist();
  requestWake();
  $('chart-title').textContent = `En cours : ${name}`;
  renderMarkers(); renderLive(); renderSessions(); updateUI(); draw();
}
async function stopRec() {
  if (!S.rec || !confirm('Arrêter l\'enregistrement ?')) return;
  await commitEditing();
  const rec = S.rec, end = Date.now(), stats = computeStats(S.samples);
  S.rec = null;
  releaseWake();
  const s = (await getSessions()).find(x => x.id === rec.id);
  s.endedAt = end; s.stats = stats;
  await putSession(s);
  $('timer').textContent = '00:00:00';
  const full = await loadFull(rec.id);
  S.view = full; // affiche la séance terminée
  const base = `${slug(full.session.name)}_${stamp(full.session.startedAt)}`;
  download(`${base}.csv`, samplesCSV(full.session, full.samples, full.markers), 'text/csv;charset=utf-8');
  showBanner(`Séance exportée : ${base}.csv (dossier Téléchargements). Copie conservée dans la liste ci-dessous.`, false);
  updateTitle(); renderMarkers(); renderSessions(); renderLive(); updateUI(); draw();
}
async function recoverInterrupted() {
  for (const s of await getSessions()) {
    if (s.endedAt != null) continue;
    const samples = (await getBySession('samples', s.id)).sort((a, b) => a.t - b.t);
    s.endedAt = samples.length ? samples[samples.length - 1].t : s.startedAt;
    s.stats = computeStats(samples);
    await putSession(s);
  }
}
async function requestWake() {
  try {
    if ('wakeLock' in navigator && !S.wl) {
      S.wl = await navigator.wakeLock.request('screen');
      S.wl.addEventListener('release', () => { S.wl = null; });
    }
  } catch { /* non critique */ }
}
function releaseWake() { if (S.wl) { S.wl.release().catch(() => {}); S.wl = null; } }
document.addEventListener('visibilitychange', () => { if (S.rec && document.visibilityState === 'visible') requestWake(); });
window.addEventListener('beforeunload', e => { if (S.rec) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- Marqueurs ---------- */
async function addMarker() {
  if (!S.rec) return;
  const t = Date.now();
  await commitEditing();
  const rec = { sessionId: S.rec.id, t, comment: '' };
  const id = await run('markers', 'readwrite', tx => os(tx, 'markers').add(rec));
  const m = { ...rec, id };
  S.markers.push(m);
  const b = $('btn-marker'); b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
  renderMarkers(); draw(); openForm(m);
}
function openForm(m) {
  S.editing = m;
  const D = current(), n = sortedMarkers().indexOf(m) + 1;
  $('marker-label').textContent = `Marqueur #${n} — ${fmtHMS(m.t - D.t0)}`;
  $('marker-form').hidden = false;
  const i = $('marker-comment'); i.value = m.comment; i.focus(); i.select();
}
async function commitEditing() {
  const m = S.editing;
  if (!m) return;
  S.editing = null; $('marker-form').hidden = true;
  const v = $('marker-comment').value.trim();
  if (v !== m.comment) { m.comment = v; await putMarker(m); }
  renderMarkers(); draw();
}
function cancelEditing() { S.editing = null; $('marker-form').hidden = true; }
async function deleteMarker(m) {
  if (S.editing === m) cancelEditing();
  await run('markers', 'readwrite', tx => os(tx, 'markers').delete(m.id));
  const arr = current().markers; arr.splice(arr.indexOf(m), 1);
  renderMarkers(); draw();
}

/* ---------- Exports ---------- */
const csvEsc = v => { v = String(v == null ? '' : v); return /[;"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
const toCSV = rows => '﻿' + rows.map(r => r.map(csvEsc).join(';')).join('\r\n') + '\r\n';
function samplesCSV(session, samples, markers) {
  const ms = [...markers].sort((a, b) => a.t - b.t).map((m, i) => ({ ...m, n: i + 1 }));
  const rows = [['elapsed_ms', 'elapsed', 'timestamp_iso', 'hr_bpm', 'rr_ms', 'contact', 'marqueur']];
  let mi = 0;
  const label = m => `#${m.n}${m.comment ? ': ' + m.comment : ''}`;
  for (const s of samples) {
    const tags = [];
    while (mi < ms.length && ms[mi].t <= s.t) tags.push(label(ms[mi++]));
    rows.push([s.t - session.startedAt, fmtHMS(s.t - session.startedAt), new Date(s.t).toISOString(), s.hr, (s.rr || []).join(' '), s.c == null ? '' : s.c, tags.join(' | ')]);
  }
  while (mi < ms.length) { // marqueurs après le dernier échantillon
    const m = ms[mi++];
    rows.push([m.t - session.startedAt, fmtHMS(m.t - session.startedAt), new Date(m.t).toISOString(), '', '', '', label(m)]);
  }
  return toCSV(rows);
}
function markersCSV(session, markers) {
  const rows = [['n', 'elapsed_ms', 'elapsed', 'timestamp_iso', 'commentaire']];
  [...markers].sort((a, b) => a.t - b.t).forEach((m, i) =>
    rows.push([i + 1, m.t - session.startedAt, fmtHMS(m.t - session.startedAt), new Date(m.t).toISOString(), m.comment]));
  return toCSV(rows);
}
function download(name, text, type) {
  const u = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = u; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
async function loadFull(id) {
  const session = (await getSessions()).find(s => s.id === id);
  const samples = (await getBySession('samples', id)).sort((a, b) => a.t - b.t);
  const markers = (await getBySession('markers', id)).sort((a, b) => a.t - b.t);
  return { session, samples, markers };
}
async function exportSession(id, kind) {
  const { session, samples, markers } = await loadFull(id);
  const base = `${slug(session.name)}_${stamp(session.startedAt)}`;
  if (kind === 'csv') download(`${base}.csv`, samplesCSV(session, samples, markers), 'text/csv;charset=utf-8');
  if (kind === 'mcsv') download(`${base}_marqueurs.csv`, markersCSV(session, markers), 'text/csv;charset=utf-8');
  if (kind === 'json') download(`${base}.json`, JSON.stringify({ session, samples, markers }, null, 1), 'application/json');
}

/* ---------- UI ---------- */
function setConn(state, text) { const p = $('conn'); p.className = `pill ${state}`; p.textContent = text; if (state === 'off') $('batt').textContent = ''; }
function showBanner(msg, err) { const b = $('banner'); b.textContent = msg; b.className = err ? 'banner' : 'banner info'; b.hidden = false; }
function updateTitle() {
  const D = current();
  $('chart-title').textContent = !D ? 'Graphique' : D.live ? `En cours : ${D.name}` : `Revue : ${D.name}`;
  $('btn-live').hidden = !S.view;
}
function updateUI() {
  const c = S.connected, r = !!S.rec;
  $('btn-connect').hidden = c || S.connecting || S.reconnecting || !navigator.bluetooth;
  $('btn-disconnect').hidden = !(c || S.reconnecting);
  $('btn-disconnect').textContent = c ? 'Déconnecter' : 'Annuler';
  $('btn-start').hidden = r; $('btn-start').disabled = !c;
  $('btn-stop').hidden = !r;
  $('btn-marker').disabled = !r;
  $('session-name').disabled = r;
  document.querySelectorAll('#sessions [data-a="view"]').forEach(b => { b.disabled = r; });
  updateTitle();
}
function renderLive() {
  const l = S.last, ok = l && l.hr > 0 && l.contact !== 0;
  $('hr').textContent = ok ? l.hr : '--';
  $('contact').textContent = l && !ok ? 'Contact capteur perdu — humidifier les électrodes' : '';
  const st = computeStats(S.rec ? S.samples : []);
  $('st-avg').textContent = st.n ? st.avg : '--';
  $('st-max').textContent = st.n ? st.max : '--';
  $('st-min').textContent = st.n ? st.min : '--';
}
function renderMarkers() {
  const D = current(), ol = $('markers'), ms = sortedMarkers();
  ol.innerHTML = '';
  $('markers-empty').hidden = ms.length > 0;
  ms.forEach((m, i) => {
    const li = document.createElement('li');
    li.dataset.id = m.id;
    li.innerHTML = `<span class="n">${i + 1}</span><span class="t">${fmtHMS(m.t - D.t0)}</span><span class="c"></span>` +
      `<button data-a="edit" title="Modifier le commentaire">✎</button><button data-a="del" title="Supprimer">✕</button>`;
    li.querySelector('.c').textContent = m.comment || '—';
    ol.append(li);
  });
}
async function renderSessions() {
  S.sessions = (await getSessions()).sort((a, b) => b.startedAt - a.startedAt);
  const ul = $('sessions'); ul.innerHTML = '';
  $('sessions-empty').hidden = S.sessions.length > 0;
  for (const s of S.sessions) {
    const live = S.rec && S.rec.id === s.id;
    const dur = live ? 'en cours' : fmtHMS((s.endedAt || s.startedAt) - s.startedAt);
    const st = s.stats && s.stats.n ? ` · moy ${s.stats.avg} · max ${s.stats.max} bpm` : '';
    const li = document.createElement('li');
    li.dataset.id = s.id;
    li.innerHTML = `<div class="info"><b>${esc(s.name)}</b><span>${fmtDT(s.startedAt)} · ${dur}${st}</span></div>` +
      `<div class="acts">${live ? '' :
        `<button class="btn" data-a="view">Revoir</button><button class="btn" data-a="csv">CSV</button>` +
        `<button class="btn" data-a="mcsv">Marqueurs CSV</button><button class="btn" data-a="json">JSON</button>` +
        `<button class="btn" data-a="del">Supprimer</button>`}</div>`;
    ul.append(li);
  }
  updateUI();
}

/* ---------- Graphique ---------- */
function niceStep(target, arr) { return arr.find(v => v >= target) || arr[arr.length - 1]; }
function tickLabel(ms) {
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h}:${p2(m)}:${p2(s % 60)}` : `${p2(m)}:${p2(s % 60)}`;
}
function draw() {
  const cv = $('chart'), dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const cs = getComputedStyle(document.documentElement), C = k => cs.getPropertyValue(k).trim();
  g.font = '11px system-ui,sans-serif';
  const D = current();
  if (!D) { g.fillStyle = C('--mute'); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('Aucune donnée — démarre un enregistrement ou ouvre une séance.', W / 2, H / 2); return; }

  const L = 44, R = 12, T = 22, B = 24, pw = W - L - R, ph = H - T - B;
  const now = D.live ? Date.now() : D.tEnd, win = +$('window').value;
  let x0 = D.t0, x1 = Math.max(now, D.t0 + 30000);
  if (D.live && win > 0) { x1 = now; x0 = Math.max(D.t0, now - win * 60000); if (x1 - x0 < 30000) x1 = x0 + 30000; }
  else if (!D.live && win > 0) { x1 = Math.max(D.tEnd, D.t0 + 30000); x0 = Math.max(D.t0, x1 - win * 60000); }
  const pts = D.samples.filter(s => s.hr > 0 && s.c !== 0 && s.t >= x0 && s.t <= x1);
  let lo = Infinity, hi = -Infinity;
  for (const s of pts) { if (s.hr < lo) lo = s.hr; if (s.hr > hi) hi = s.hr; }
  if (!pts.length) { lo = 60; hi = 100; }
  lo = Math.floor((lo - 5) / 5) * 5; hi = Math.ceil((hi + 5) / 5) * 5;
  if (hi - lo < 30) { lo = Math.floor(((hi + lo) / 2 - 15) / 5) * 5; hi = lo + 30; }
  const X = t => L + (t - x0) / (x1 - x0) * pw, Y = v => T + (1 - (v - lo) / (hi - lo)) * ph;

  g.lineWidth = 1; g.textAlign = 'right'; g.textBaseline = 'middle';
  const ys = niceStep((hi - lo) / 5, [5, 10, 20, 25, 50]);
  for (let v = Math.ceil(lo / ys) * ys; v <= hi; v += ys) {
    const y = Y(v);
    g.strokeStyle = C('--grid'); g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke();
    g.fillStyle = C('--mute'); g.fillText(String(v), L - 6, y);
  }
  const xs = niceStep((x1 - x0) / 6, [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map(v => v * 1000));
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (let rel = Math.ceil((x0 - D.t0) / xs) * xs; D.t0 + rel <= x1; rel += xs) {
    const x = X(D.t0 + rel);
    g.strokeStyle = C('--grid'); g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke();
    g.fillStyle = C('--mute'); g.fillText(tickLabel(rel), x, T + ph + 6);
  }
  g.strokeStyle = C('--hr'); g.lineWidth = 2; g.lineJoin = 'round'; g.beginPath();
  let prev = null;
  for (const s of pts) { const x = X(s.t), y = Y(s.hr); if (prev !== null && s.t - prev < 5000) g.lineTo(x, y); else g.moveTo(x, y); prev = s.t; }
  g.stroke();
  if (pts.length) { const s = pts[pts.length - 1]; g.fillStyle = C('--hr'); g.beginPath(); g.arc(X(s.t), Y(s.hr), 3.5, 0, 7); g.fill(); }

  sortedMarkers().forEach((m, i) => {
    if (m.t < x0 || m.t > x1) return;
    const x = X(m.t), label = String(i + 1), w = Math.max(16, g.measureText(label).width + 8);
    g.strokeStyle = C('--marker'); g.lineWidth = 1.5; g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke(); g.setLineDash([]);
    g.fillStyle = C('--marker'); g.beginPath();
    if (g.roundRect) g.roundRect(x - w / 2, 3, w, 16, 8); else g.rect(x - w / 2, 3, w, 16);
    g.fill();
    g.fillStyle = '#1a1400'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, x, 11);
  });
}

/* ---------- Événements ---------- */
$('btn-connect').addEventListener('click', connectClick);
$('btn-disconnect').addEventListener('click', disconnectClick);
$('btn-start').addEventListener('click', startRec);
$('btn-stop').addEventListener('click', stopRec);
$('btn-marker').addEventListener('click', addMarker);
$('window').addEventListener('change', draw);
$('btn-live').addEventListener('click', () => { S.view = null; cancelEditing(); updateTitle(); renderMarkers(); draw(); });
$('marker-form').addEventListener('submit', e => { e.preventDefault(); commitEditing(); });
$('marker-comment').addEventListener('keydown', e => { if (e.key === 'Escape') cancelEditing(); });
document.addEventListener('keydown', e => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || (e.key !== 'm' && e.key !== 'M')) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (S.rec) { e.preventDefault(); addMarker(); }
});
$('markers').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const m = current().markers.find(x => x.id === +b.closest('li').dataset.id);
  if (!m) return;
  if (b.dataset.a === 'edit') openForm(m);
  if (b.dataset.a === 'del' && confirm('Supprimer ce marqueur ?')) deleteMarker(m);
});
$('sessions').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  const id = +b.closest('li').dataset.id, a = b.dataset.a;
  if (a === 'view' && !S.rec) {
    cancelEditing(); S.view = await loadFull(id);
    updateTitle(); renderMarkers(); draw(); $('chart').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (a === 'del') {
    if (!confirm('Supprimer définitivement cette séance (mesures et marqueurs) ?')) return;
    await deleteSession(id);
    if (S.view && S.view.session.id === id) { S.view = null; cancelEditing(); renderMarkers(); }
    await renderSessions(); draw();
  } else exportSession(id, a);
});

let tickN = 0;
setInterval(() => {
  if (!S.rec) return;
  $('timer').textContent = fmtHMS(Date.now() - S.rec.startedAt);
  if (++tickN % 4 === 0 && !S.view) draw();
}, 250);
window.addEventListener('resize', draw);
if (window.ResizeObserver) new ResizeObserver(draw).observe($('chart'));

(async function init() {
  if (!navigator.bluetooth) {
    showBanner('Web Bluetooth indisponible : utilise Chrome, Edge ou Opera (bureau/Android) en HTTPS ou sur localhost. Safari et Firefox ne le supportent pas.', true);
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  await recoverInterrupted();
  await renderSessions();
  renderMarkers(); renderLive(); updateUI(); draw();
})();
