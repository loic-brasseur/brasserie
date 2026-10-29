/* ============================================================================
   Synchronisation des apps brasserie entre appareils + sauvegarde complète
   ----------------------------------------------------------------------------
   - Toutes les données des apps sont dans localStorage (clés « brasserie… »).
   - Chaque clé est enregistrée dans un dépôt GitHub PRIVÉ (data/<clé>.json) :
     l'historique du dépôt garde toutes les versions.
   - Chargé en premier dans chaque page : intercepte les écritures pour savoir
     ce qui a changé, envoie les modifications et récupère celles des autres
     appareils (au chargement, au retour sur la page, toutes les minutes).
   - Réglages (dépôt, jeton, nom de l'appareil) : clé brasserie__sync_cfg,
     jamais envoyée ni incluse dans les sauvegardes.
   ========================================================================== */
(function () {
  'use strict';
  var LS; try { LS = window.localStorage; } catch (e) { return; }
  if (!LS || window.BrasserieSync) return;

  var CFG = 'brasserie__sync_cfg', META = 'brasserie__sync_meta', LAST = 'brasserie__sync_last',
      BK = 'brasserie__backup_ts', CONF = 'brasserie__sync_conflits';
  var DEFAULT_REPO = 'loic-brasseur/brasserie-donnees';
  var SP = Storage.prototype, rawSet = SP.setItem, rawRemove = SP.removeItem, rawGet = SP.getItem;
  var LABELS = {
    brasserie_recettes_v1: 'Carnet de brassage', brasserie_stock_v2: 'Stock', brasserie_cuves_v1: 'Suivi des cuves',
    brasserie_brewlog_v1: 'Brew Log', brasserie_packaging_v1: 'Packaging Log', brasserie_carbo_v1: 'Carbonatation',
    brasserie_inventaire_v1: 'Inventaire', brasserie_qc_v1: 'Contrôle qualité', brasserie_rapports_v1: 'Rapports',
    brasserie_planning_v1: 'Planning', brasserie_planning_v3: 'Planning de brassage', brasserie_bieres_v1: 'Registre des bières'
  };

  var LOCAL_ONLY = { brasserie_recette_auto: 1 };   // brouillon d'édition propre à chaque appareil
  function isData(k) { return typeof k === 'string' && k.indexOf('brasserie') === 0 && k.indexOf('brasserie__') !== 0 && !LOCAL_ONLY[k]; }
  function jget(k, d) { try { var v = JSON.parse(rawGet.call(LS, k)); return v == null ? d : v; } catch (e) { return d; } }
  function jset(k, v) { try { rawSet.call(LS, k, JSON.stringify(v)); } catch (e) {} }
  function cfg() { return jget(CFG, null); }
  function meta() { var m = jget(META, null); if (!m || typeof m.keys !== 'object') m = { keys: {} }; return m; }
  function label(k) { return LABELS[k] || k.replace(/^brasserie_/, ''); }
  function dataKeys() { var a = []; for (var i = 0; i < LS.length; i++) { var k = LS.key(i); if (isData(k)) a.push(k); } return a; }
  function hhmm(t) { var d = new Date(t); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function fmtDay(t) { return new Date(t).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' + hhmm(t); }
  function guessDevice() { var u = navigator.userAgent || ''; if (/iPad/.test(u) || (/Macintosh/.test(u) && navigator.maxTouchPoints > 1)) return 'iPad'; if (/iPhone/.test(u)) return 'iPhone'; if (/Mac/.test(u)) return 'Mac'; if (/Android/.test(u)) return 'Android'; return 'Ordinateur'; }

  /* ---------- détection des modifications ---------- */
  var applying = false, timer = null, running = false, again = false, loadedAt = Date.now(), touched = false;
  function markDirty(k) {
    var m = meta(), e = m.keys[k] || {}; e.dirty = true; e.ts = Date.now(); m.keys[k] = e; jset(META, m);
    if (ready()) { status(navigator.onLine ? 'pending' : 'offline'); schedule(4000); }
  }
  SP.setItem = function (k, v) {
    if (this === LS && isData(k) && !applying) { var old = rawGet.call(this, k); rawSet.call(this, k, v); if (old !== String(v)) markDirty(k); return; }
    return rawSet.call(this, k, v);
  };
  SP.removeItem = function (k) {
    if (this === LS && isData(k) && !applying) { var had = rawGet.call(this, k) !== null; rawRemove.call(this, k); if (had) markDirty(k); return; }
    return rawRemove.call(this, k);
  };

  /* ---------- API GitHub ---------- */
  function ready() { var c = cfg(); return !!(c && c.token && c.repo && c.init); }
  function api(path, opt) {
    var c = cfg(); opt = opt || {};
    var h = { 'Authorization': 'Bearer ' + c.token, 'Accept': opt.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json' };
    if (opt.body) h['Content-Type'] = 'application/json';
    return fetch('https://api.github.com/repos/' + c.repo + path, { method: opt.method || 'GET', headers: h, body: opt.body ? JSON.stringify(opt.body) : undefined, cache: 'no-store' });
  }
  function b64(str) { var b = new TextEncoder().encode(str), s = ''; for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
  function errMsg(r) { return r.status === 401 ? 'jeton refusé (expiré ou incorrect)' : r.status === 403 ? 'accès refusé : vérifie les droits du jeton (Contents : lecture et écriture)' : r.status === 404 ? 'dépôt introuvable ou jeton sans accès à ce dépôt' : 'erreur GitHub ' + r.status; }
  async function listRemote() {
    var r = await api('/contents/data');
    if (r.status === 404) { var t = await api(''); if (!t.ok) throw new Error(errMsg(t)); return {}; }
    if (!r.ok) throw new Error(errMsg(r));
    var a = await r.json(), out = {};
    (Array.isArray(a) ? a : []).forEach(function (f) { if (f.type === 'file' && /\.json$/.test(f.name)) out[f.name.replace(/\.json$/, '')] = f.sha; });
    return out;
  }
  async function download(k) {
    var r = await api('/contents/data/' + encodeURIComponent(k) + '.json', { raw: true });
    if (!r.ok) throw new Error(errMsg(r));
    var txt = await r.text(); return JSON.parse(txt);
  }
  async function pushKey(k) {
    var c = cfg(), m = meta(), e = m.keys[k] || {}, tsAt = e.ts, v = rawGet.call(LS, k), r;
    if (v === null) {
      if (e.sha) { r = await api('/contents/data/' + encodeURIComponent(k) + '.json', { method: 'DELETE', body: { message: (c.device || 'Appareil') + ' · suppression ' + label(k), sha: e.sha } }); if (!r.ok && r.status !== 404) return r.status === 409 || r.status === 422 ? 'conflict' : Promise.reject(new Error(errMsg(r))); }
      m = meta(); delete m.keys[k]; jset(META, m); return true;
    }
    var body = { message: (c.device || 'Appareil') + ' · ' + label(k), content: b64(JSON.stringify({ key: k, ts: e.ts || Date.now(), device: c.device || '', value: v })) };
    if (e.sha) body.sha = e.sha;
    r = await api('/contents/data/' + encodeURIComponent(k) + '.json', { method: 'PUT', body: body });
    if (r.ok) { var j = await r.json(); m = meta(); var x = m.keys[k] || {}; x.prev = e.sha; x.sha = j.content.sha; x.synced = Date.now(); if (x.ts === tsAt) x.dirty = false; m.keys[k] = x; jset(META, m); return true; }
    if (r.status === 409 || r.status === 422) return 'conflict';
    throw new Error(errMsg(r));
  }
  function applyRemote(k, obj) {
    applying = true;
    try { if (obj.value == null) rawRemove.call(LS, k); else rawSet.call(LS, k, obj.value); } finally { applying = false; }
  }
  function keepConflict(k, value, ts) {
    var a = jget(CONF, []); a.unshift({ key: k, label: label(k), date: Date.now(), ts: ts, value: value }); jset(CONF, a.slice(0, 10));
  }

  /* ---------- cycle de synchronisation ---------- */
  async function run(mode) {
    var c = cfg(); if (!c || !c.token) { status('off'); return; }
    if (!c.init && !mode) { status('off'); return; }
    if (!navigator.onLine) { status('offline'); return; }
    running = true; status('busy');
    var changed = [], from = {};
    try {
      var remote = await listRemote(), m, e, k;
      for (k in remote) {
        m = meta(); e = m.keys[k] || {};
        if (mode === 'push') { e.sha = remote[k]; if (rawGet.call(LS, k) !== null) { e.dirty = true; e.ts = Date.now(); } m.keys[k] = e; jset(META, m); continue; }
        if (mode !== 'pull' && (e.sha === remote[k] || (e.prev && e.prev === remote[k]))) continue;   // inchangé, ou ancienne version encore servie juste après un envoi
        var obj = await download(k);
        m = meta(); e = m.keys[k] || {};
        if (mode !== 'pull' && !e.dirty && e.ts && (obj.ts || 0) < e.ts - 120000) { m.keys[k] = e; jset(META, m); continue; }   // version en ligne plus ancienne que la nôtre : ignorée
        if (mode !== 'pull' && e.dirty && (e.ts || 0) > (obj.ts || 0)) { e.sha = remote[k]; }            // cet appareil est plus récent : il écrasera la version en ligne
        else {
          var local = rawGet.call(LS, k);
          if (e.dirty && local !== null && local !== obj.value) keepConflict(k, local, e.ts);              // version locale écrasée : gardée de côté
          if (local !== obj.value) { applyRemote(k, obj); changed.push(k); from[obj.device || 'un autre appareil'] = 1; }
          e = { sha: remote[k], ts: obj.ts, dirty: false, synced: Date.now() };
        }
        m.keys[k] = e; jset(META, m);
      }
      m = meta();
      dataKeys().forEach(function (k2) { var x = m.keys[k2]; if (!x) m.keys[k2] = { dirty: true, ts: Date.now() }; else if (x.sha && !remote[k2]) { delete x.sha; x.dirty = true; x.ts = x.ts || Date.now(); } });
      jset(META, m);
      if (mode) { c = cfg(); c.init = true; jset(CFG, c); }
      var keys = Object.keys(meta().keys).filter(function (k3) { return meta().keys[k3].dirty; });
      for (var i = 0; i < keys.length; i++) { var res = await pushKey(keys[i]); if (res === 'conflict') again = true; }
      jset(LAST, { t: Date.now(), ok: true });
      status(pendingCount() ? 'pending' : 'ok');
      if (changed.length) onChanged(changed, Object.keys(from));
      return { changed: changed };
    } catch (err) {
      jset(LAST, { t: Date.now(), ok: false, err: err.message }); status('error', err.message); throw err;
    } finally {
      running = false; if (again) { again = false; schedule(1500); }
    }
  }
  function sync(mode) {
    if (running) { again = true; return Promise.resolve(); }
    var go = function () { return run(mode).catch(function () {}); };
    if (navigator.locks && navigator.locks.request) return navigator.locks.request('brasserie-sync', go);
    return go();
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(function () { sync(); }, ms); }
  function pendingCount() { var m = meta(); return Object.keys(m.keys).filter(function (k) { return m.keys[k].dirty; }).length; }
  function onChanged(keys, devices) {
    var busy = touched || (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName));
    if (!busy && Date.now() - loadedAt < 10000) { location.reload(); return; }
    banner('Données mises à jour depuis ' + (devices.join(', ') || 'un autre appareil') + ' (' + keys.map(label).join(', ') + ').');
  }

  /* ---------- interface : pastille d'état ---------- */
  var css = '#bsync-pill{position:fixed;right:max(12px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom));z-index:9000;font:600 12px/1 system-ui,-apple-system,sans-serif;padding:8px 11px;border-radius:999px;border:1px solid rgba(26,22,18,.15);background:rgba(255,253,247,.94);color:#5b5244;box-shadow:0 2px 10px rgba(26,22,18,.12);cursor:pointer;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}' +
    '#bsync-pill.ok{color:#4F6B2F}#bsync-pill.err{color:#B3261E;border-color:rgba(179,38,30,.4)}#bsync-pill.warn{color:#9A6A12;border-color:rgba(207,152,43,.5)}' +
    '#bsync-ban{position:fixed;left:50%;transform:translateX(-50%);top:max(12px,env(safe-area-inset-top));z-index:9001;background:#1A1612;color:#FBF5EC;font:500 13px/1.35 system-ui,-apple-system,sans-serif;padding:10px 12px;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;gap:10px;align-items:center;max-width:min(92vw,560px)}#bsync-ban button{all:unset;cursor:pointer;background:#CF982B;color:#1A1612;font-weight:700;padding:6px 10px;border-radius:8px;white-space:nowrap}' +
    '#bsync-ov{position:fixed;inset:0;z-index:9002;background:rgba(26,22,18,.45);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:5vh 12px}' +
    '#bsync-m{background:#FFFDF7;color:#1A1612;border-radius:16px;max-width:560px;width:100%;padding:20px 20px 16px;font:400 14px/1.45 system-ui,-apple-system,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.3)}' +
    '#bsync-m h2{font:600 20px/1.2 Fraunces,Georgia,serif;margin:0 0 4px}#bsync-m h3{font:700 12px/1 system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#7A6F5C;margin:18px 0 8px}' +
    '#bsync-m label{display:block;font-size:12px;font-weight:700;color:#7A6F5C;margin:8px 0 3px}#bsync-m input{width:100%;box-sizing:border-box;font:500 14px system-ui,sans-serif;padding:9px 10px;border:1px solid rgba(26,22,18,.2);border-radius:9px;background:#fff;color:#1A1612}' +
    '#bsync-m .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}#bsync-m button{font:700 13px system-ui,sans-serif;padding:9px 12px;border-radius:9px;border:1px solid rgba(26,22,18,.2);background:#fff;color:#1A1612;cursor:pointer}' +
    '#bsync-m button.pri{background:#A8541B;border-color:#A8541B;color:#fff}#bsync-m button.red{color:#B3261E}#bsync-m .st{padding:9px 11px;border-radius:10px;background:#F4ECDC;font-weight:600;margin-top:8px}#bsync-m .st.err{background:rgba(179,38,30,.1);color:#8C1D16}#bsync-m .st.ok{background:rgba(79,107,47,.12);color:#3d5424}' +
    '#bsync-m ol{margin:6px 0 0 18px;padding:0}#bsync-m li{margin:4px 0}#bsync-m a{color:#A8541B;font-weight:700}#bsync-m small{color:#7A6F5C}' +
    '@media print{#bsync-pill,#bsync-ban,#bsync-ov{display:none!important}}';
  var pill = null, lastState = 'off', lastDetail = '';
  function ensureUI() {
    if (pill || !document.body) return;
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    pill = document.createElement('button'); pill.id = 'bsync-pill'; pill.type = 'button'; pill.title = 'Synchronisation et sauvegarde';
    pill.onclick = function () { openPanel(); }; document.body.appendChild(pill); paint();
  }
  function status(s, detail) { lastState = s; lastDetail = detail || ''; paint(); if (panelOpen) renderPanel(); }
  function paint() {
    if (!pill) return; var l = jget(LAST, null), txt, cls = '';
    if (lastState === 'off') {
      var bk = jget(BK, 0), days = bk ? Math.floor((Date.now() - bk) / 864e5) : null;
      if (!cfg() || !cfg().token) { txt = days == null ? '☁︎ Sauvegarde à faire' : days >= 7 ? '☁︎ Dernière sauvegarde : ' + days + ' j' : '☁︎ Non synchronisé'; cls = days == null || days >= 7 ? 'warn' : ''; }
      else { txt = '☁︎ Synchro à finir de configurer'; cls = 'warn'; }
    } else if (lastState === 'busy') txt = '☁︎ Synchronisation…';
    else if (lastState === 'offline') { txt = '☁︎ Hors ligne' + (pendingCount() ? ' · ' + pendingCount() + ' en attente' : ''); cls = 'warn'; }
    else if (lastState === 'pending') { txt = '☁︎ Envoi en attente…'; }
    else if (lastState === 'error') { txt = '☁︎ Erreur de synchro'; cls = 'err'; }
    else { txt = '☁︎ Synchronisé ' + (l && l.t ? hhmm(l.t) : ''); cls = 'ok'; }
    pill.textContent = txt; pill.className = cls;
  }
  function banner(msg) {
    var b = document.getElementById('bsync-ban'); if (b) b.remove();
    b = document.createElement('div'); b.id = 'bsync-ban';
    b.innerHTML = '<span></span><button type="button">Recharger</button>'; b.firstChild.textContent = msg;
    b.lastChild.onclick = function () { location.reload(); }; document.body.appendChild(b);
  }

  /* ---------- interface : panneau de réglages ---------- */
  var panelOpen = false, step = null, msg = '';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function openPanel(st) { ensureUI(); panelOpen = true; step = st || null; msg = ''; renderPanel(); }
  function closePanel() { panelOpen = false; var o = document.getElementById('bsync-ov'); if (o) o.remove(); }
  function renderPanel() {
    var o = document.getElementById('bsync-ov');
    if (!o) { o = document.createElement('div'); o.id = 'bsync-ov'; o.addEventListener('click', function (e) { if (e.target === o) closePanel(); }); document.body.appendChild(o); }
    var c = cfg() || {}, l = jget(LAST, null), bk = jget(BK, 0), conf = jget(CONF, []), connected = !!(c.token && c.init);
    var h = '<div id="bsync-m"><h2>Synchronisation &amp; sauvegarde</h2><small>Les données de toutes les apps sont partagées entre tes appareils via un dépôt GitHub privé. Chaque modification y est gardée : rien n\'est perdu.</small>';
    if (connected) {
      h += '<div class="st ' + (lastState === 'error' ? 'err' : 'ok') + '">' + (lastState === 'error' ? '⚠ ' + esc(lastDetail) : lastState === 'busy' ? 'Synchronisation en cours…' : 'Connecté : <b>' + esc(c.repo) + '</b> — appareil « ' + esc(c.device) + ' »' + (l && l.t ? '<br><small>Dernière synchro ' + fmtDay(l.t) + (pendingCount() ? ' · ' + pendingCount() + ' modification(s) en attente' : '') + '</small>' : '')) + '</div>' +
        '<div class="row"><button class="pri" data-a="now">Synchroniser maintenant</button><button data-a="link">Lien pour un autre appareil</button><a href="https://github.com/' + esc(c.repo) + '/commits/main" target="_blank" rel="noopener" style="align-self:center">Historique des versions</a></div>' +
        (msg ? '<div class="st">' + msg + '</div>' : '') +
        (conf.length ? '<div class="st" style="margin-top:10px">' + conf.length + ' version(s) locale(s) remplacée(s) par une modification plus récente d\'un autre appareil. <button data-a="conf" style="margin-left:6px">Télécharger</button></div>' : '') +
        '<div class="row"><button class="red" data-a="off">Déconnecter cet appareil</button></div>';
    } else if (step === 'choose' || (c.token && !c.init)) {
      h += '<div class="st">Connecté à <b>' + esc(c.repo) + '</b>. Des données existent déjà en ligne : que faire sur cet appareil ?</div>' +
        '<div class="row" style="flex-direction:column"><button class="pri" data-a="pull">Récupérer les données en ligne (nouvel appareil — recommandé)</button><button data-a="push">Envoyer les données de cet appareil (remplace celles en ligne)</button></div>' +
        '<small>Les données remplacées restent récupérables dans l\'historique du dépôt.</small>' + (msg ? '<div class="st err">' + msg + '</div>' : '') +
        '<div class="row"><button class="red" data-a="off">Annuler</button></div>';
    } else {
      h += '<h3>Mise en place (une seule fois)</h3><ol>' +
        '<li>Crée un dépôt <b>privé</b> nommé <b>brasserie-donnees</b> : <a href="https://github.com/new?name=brasserie-donnees&visibility=private" target="_blank" rel="noopener">créer le dépôt</a>.</li>' +
        '<li>Crée un jeton : <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">nouveau jeton</a> → nom « brasserie », expiration 1 an → <i>Only select repositories</i> : brasserie-donnees → <i>Repository permissions</i> → <b>Contents : Read and write</b> → Generate.</li>' +
        '<li>Colle le jeton ci-dessous et connecte. Pour les autres appareils, utilise ensuite « Lien pour un autre appareil ».</li></ol>' +
        '<label>Dépôt</label><input id="bs-repo" value="' + esc(c.repo || DEFAULT_REPO) + '">' +
        '<label>Jeton GitHub</label><input id="bs-tok" type="password" autocomplete="off" value="' + esc(c.token || '') + '" placeholder="github_pat_…">' +
        '<label>Nom de cet appareil</label><input id="bs-dev" value="' + esc(c.device || guessDevice()) + '">' +
        (msg ? '<div class="st err">' + msg + '</div>' : '') +
        '<div class="row"><button class="pri" data-a="connect">Connecter</button></div>';
    }
    h += '<h3>Sauvegarde complète (fichier)</h3><small>Toutes les apps dans un seul fichier, à garder en lieu sûr. ' + (bk ? 'Dernière : ' + fmtDay(bk) + '.' : 'Aucune sauvegarde faite sur cet appareil.') + '</small>' +
      '<div class="row"><button data-a="bk">Télécharger la sauvegarde</button><button data-a="rs">Restaurer une sauvegarde</button><input type="file" id="bs-file" accept=".json,application/json" style="display:none"></div>' +
      '<div class="row" style="justify-content:flex-end"><button data-a="close">Fermer</button></div></div>';
    o.innerHTML = h;
    o.querySelectorAll('[data-a]').forEach(function (b) { b.onclick = function () { act(b.getAttribute('data-a')); }; });
    var f = o.querySelector('#bs-file'); if (f) f.onchange = function () { if (f.files[0]) restore(f.files[0]); };
  }
  async function act(a) {
    var c = cfg() || {};
    if (a === 'close') return closePanel();
    if (a === 'bk') return backup();
    if (a === 'rs') return document.getElementById('bs-file').click();
    if (a === 'now') { msg = ''; await sync(); msg = lastState === 'error' ? '' : 'Synchronisation terminée.'; return renderPanel(); }
    if (a === 'off') { if (c.init && !confirm('Déconnecter cet appareil ? Ses données restent sur l\'appareil mais ne seront plus synchronisées.')) return; rawRemove.call(LS, CFG); status('off'); step = null; msg = ''; return renderPanel(); }
    if (a === 'link') {
      var url = location.origin + location.pathname.replace(/[^/]*$/, '') + 'index.html#sync=' + encodeURIComponent(btoa(JSON.stringify({ repo: c.repo, token: c.token })));
      try { await navigator.clipboard.writeText(url); msg = 'Lien copié. Envoie-le-toi (AirDrop, Notes…) et ouvre-le sur l\'autre appareil. <b>Il contient ton jeton : ne le partage avec personne.</b>'; }
      catch (e) { prompt('Copie ce lien et ouvre-le sur l\'autre appareil (il contient ton jeton : ne le partage pas) :', url); msg = ''; }
      return renderPanel();
    }
    if (a === 'conf') { dl('versions-remplacees-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(jget(CONF, []), null, 1)); return; }
    if (a === 'connect') {
      var repo = document.getElementById('bs-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, ''), tok = document.getElementById('bs-tok').value.trim(), dev = document.getElementById('bs-dev').value.trim() || guessDevice();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !tok) { msg = 'Indique le dépôt (propriétaire/nom) et le jeton.'; return renderPanel(); }
      jset(CFG, { repo: repo, token: tok, device: dev, init: false }); msg = ''; status('busy');
      try {
        var r = await api(''); if (!r.ok) throw new Error(errMsg(r)); var j = await r.json();
        if (!j.private) { rawRemove.call(LS, CFG); msg = 'Ce dépôt est PUBLIC : tes données seraient visibles par tous. Rends-le privé (Settings → Danger Zone → Change visibility) puis reconnecte.'; status('off'); return renderPanel(); }
        var remote = await listRemote();
        if (Object.keys(remote).length) { status('off'); step = 'choose'; return renderPanel(); }
        await run('push'); step = null; msg = 'Connecté : les données de cet appareil sont en ligne.'; return renderPanel();
      } catch (e) { rawRemove.call(LS, CFG); msg = esc(e.message); status('off'); return renderPanel(); }
    }
    if (a === 'pull' || a === 'push') {
      if (a === 'push' && !confirm('Remplacer les données en ligne par celles de cet appareil ?')) return;
      try { await run(a); step = null; msg = a === 'pull' ? 'Données récupérées.' : 'Données de cet appareil envoyées.'; renderPanel(); if (a === 'pull') setTimeout(function () { location.reload(); }, 900); }
      catch (e) { msg = esc(e.message); renderPanel(); }
    }
  }

  /* ---------- sauvegarde / restauration fichier ---------- */
  function dl(name, txt) { var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'application/json' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
  function backup() {
    var data = {}; dataKeys().forEach(function (k) { data[k] = rawGet.call(LS, k); });
    dl('sauvegarde-brasserie-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify({ app: 'Brasserie — sauvegarde complète', version: 1, date: new Date().toISOString(), device: (cfg() || {}).device || guessDevice(), data: data }));
    jset(BK, Date.now()); paint(); if (panelOpen) renderPanel();
  }
  function restore(file) {
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var j = JSON.parse(rd.result); if (!j || typeof j.data !== 'object') throw new Error('ce n\'est pas une sauvegarde complète');
        var keys = Object.keys(j.data).filter(isData);
        if (!confirm('Restaurer la sauvegarde du ' + (j.date ? fmtDay(Date.parse(j.date)) : '?') + ' (' + keys.length + ' app(s) : ' + keys.map(label).join(', ') + ') ?\nLes données actuelles de ces apps seront remplacées' + (ready() ? ' sur tous les appareils synchronisés' : '') + '.')) return;
        keys.forEach(function (k) { if (j.data[k] == null) LS.removeItem(k); else LS.setItem(k, j.data[k]); });
        if (ready()) sync().then(function () { location.reload(); }); else location.reload();
      } catch (e) { alert('Fichier invalide : ' + e.message); }
    };
    rd.readAsText(file);
  }

  /* ---------- lien de configuration (#sync=…) ---------- */
  function fromHash() {
    var m = /[#&]sync=([^&]+)/.exec(location.hash || ''); if (!m) return false;
    try { var o = JSON.parse(atob(decodeURIComponent(m[1]))); if (o.repo && o.token) jset(CFG, { repo: o.repo, token: o.token, device: guessDevice(), init: false }); } catch (e) {}
    history.replaceState(null, '', location.pathname + location.search); return true;
  }

  /* ---------- démarrage ---------- */
  window.BrasserieSync = { open: openPanel, sync: sync, backup: backup, status: function () { return lastState; } };
  function start() {
    ensureUI();
    ['pointerdown', 'keydown'].forEach(function (ev) { document.addEventListener(ev, function () { touched = true; }, { once: true, capture: true }); });
    if (fromHash()) {
      // jeton reçu par lien : on vérifie l'accès puis on propose de récupérer les données
      status('busy'); listRemote().then(function (r) { if (Object.keys(r).length) openPanel('choose'); else run('push').then(function () { openPanel(); }); }).catch(function (e) { var c = cfg(); if (c) { c.init = false; jset(CFG, c); } status('error', e.message); openPanel(); });
      return;
    }
    if (ready()) setTimeout(function () { sync(); }, 300); else status('off');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && ready()) sync(); });
  window.addEventListener('online', function () { if (ready()) sync(); });
  window.addEventListener('offline', function () { if (ready()) status('offline'); });
  setInterval(function () { if (document.visibilityState === 'visible' && ready() && !running) sync(); }, 60000);
})();
