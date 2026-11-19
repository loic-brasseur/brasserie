/* Thème clair / sombre commun à toutes les apps de la brasserie.
   - Choix enregistré sur l'appareil (clé brasserie__theme, non synchronisée).
   - Mode sombre : les couleurs des feuilles de style, des styles en ligne et des SVG
     sont converties (fonds clairs -> sombres, textes sombres -> clairs, couleurs vives gardées).
   - Une page qui a son propre thème sombre (<html data-own-dark>) ne reçoit que la classe .dark. */
(function () {
  var KEY = 'brasserie__theme';
  var mode = 'light';
  try { mode = localStorage.getItem(KEY) || 'light'; } catch (e) {}
  var dark = mode === 'dark', root = document.documentElement;
  if (dark) root.classList.add('dark');
  var own = root.hasAttribute('data-own-dark');

  function setMode(m) { try { localStorage.setItem(KEY, m); } catch (e) {} location.reload(); }
  window.BrasserieTheme = { get: function () { return dark ? 'dark' : 'light'; }, set: setMode, toggle: function () { setMode(dark ? 'light' : 'dark'); } };

  if (dark && !own) {
    var pre = document.createElement('style'); pre.setAttribute('data-theme-skip', '');
    pre.textContent = 'html.dark{background:#16130e}html.dark body:not(.x){background-color:#16130e;color:#f3ecdc}html.dark{color-scheme:dark}';
    document.head.appendChild(pre);
    var mt = document.querySelector('meta[name=theme-color]'); if (mt) mt.setAttribute('content', '#16130e');
  }

  /* ---------- conversion des couleurs ---------- */
  function hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, h = 0, s = 0;
    if (mx !== mn) {
      var d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6;
    }
    return [h, s, l];
  }
  function rgb(h, s, l) {
    function f(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }
    if (!s) return [l * 255, l * 255, l * 255].map(Math.round);
    var q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return [f(p, q, h + 1 / 3), f(p, q, h), f(p, q, h - 1 / 3)].map(function (x) { return Math.round(x * 255); });
  }
  // kind : 'bg' (fond), 'fg' (texte / trait), 'shadow'
  function conv(r, g, b, a, kind) {
    if (kind === 'shadow') return [0, 0, 0, Math.min(1, a * 2.2)];
    var x = hsl(r, g, b), h = x[0], s = x[1], l = x[2], nl;
    if (s > .35 && l > .22 && l < .7) {           // couleur vive (cuivre, ambre, vert, rouge) : gardée, éclaircie
      nl = Math.min(.72, l + (kind === 'bg' ? .04 : .14));
      if (kind === 'bg' && a < .5) nl = l + .08;
    } else {                                        // neutre : clair <-> sombre
      nl = 1 - l;
      if (kind === 'bg' && a >= .9) nl = .07 + nl * .78;   // fonds pleins : de #16130e à #e9e0cf
      if (kind === 'fg') nl = Math.max(.12, Math.min(.94, nl));
      s = Math.min(s, .45);
    }
    var c = rgb(h, s, nl); c.push(a); return c;
  }
  var NAMED = { white: '#ffffff', black: '#000000' };
  var RE = /#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,\/]+([\d.]+%?))?\s*\)|\b(white|black)\b/gi;
  function convStr(v, kind) {
    if (!v || v.indexOf('var(') === 0 && v.indexOf('#') < 0 && v.indexOf('rgb') < 0) return v;
    return v.replace(RE, function (m, hex, r, g, b, a, nm) {
      if (nm) { hex = NAMED[nm.toLowerCase()].slice(1); }
      var R, G, B, A = 1;
      if (hex) {
        if (hex.length <= 4) hex = hex.split('').map(function (c) { return c + c; }).join('');
        R = parseInt(hex.slice(0, 2), 16); G = parseInt(hex.slice(2, 4), 16); B = parseInt(hex.slice(4, 6), 16);
        if (hex.length === 8) A = parseInt(hex.slice(6, 8), 16) / 255;
      } else { R = +r; G = +g; B = +b; if (a != null) A = a.indexOf('%') > 0 ? parseFloat(a) / 100 : +a; }
      var c = conv(R, G, B, A, kind);
      return c[3] >= 1 ? 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')' : 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (+c[3].toFixed(3)) + ')';
    });
  }
  function kindOf(prop, val) {
    if (/shadow/.test(prop)) return 'shadow';
    if (/^(color|fill|stroke|caret-color|-webkit-text-fill-color|text-decoration-color|outline-color|column-rule-color)$/.test(prop)) return 'fg';
    if (/^border|^outline/.test(prop)) return 'fg';
    if (/^--/.test(prop)) {                           // variable : devinée d'après son nom
      if (/shadow/.test(prop)) return 'shadow';
      if (/ink|text|muted|faint|soft$|fg|^--(amber|copper|gold|green|red|orange|accent|brew|cond|info|warn|prev)$|dark$|strong$|hover$/.test(prop) && !/bg|tint|paper|card|line|border/.test(prop)) return 'fg';
      if (/line|border/.test(prop)) return 'fg';
      return 'bg';
    }
    return 'bg';
  }
  var COLOR_PROPS = /color|background|border|outline|shadow|fill|stroke|^--/;
  var RULES = [];   // déclarations des feuilles de style converties : remises en clair pour l'impression / le PDF
  function convDecl(st, isRule) {
    for (var i = st.length - 1; i >= 0; i--) {
      var p = st[i]; if (!COLOR_PROPS.test(p)) continue;
      var v = st.getPropertyValue(p); if (!v || !/#|rgb|white|black/i.test(v)) continue;
      var nv = convStr(v, kindOf(p, v));
      if (nv !== v) { var pr = st.getPropertyPriority(p); st.setProperty(p, nv, pr); if (isRule) RULES.push({ st: st, p: p, old: v, nv: st.getPropertyValue(p), pr: pr }); }
    }
  }
  function walk(rules) {
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.media && /print/.test(r.media.mediaText) && !/screen/.test(r.media.mediaText)) continue;
      if (r.cssRules && !r.style) { walk(r.cssRules); continue; }
      if (r.style) convDecl(r.style, true);
      if (r.cssRules && r.cssRules.length) walk(r.cssRules);
    }
  }
  var done = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
  function convSheets() {
    for (var i = 0; i < document.styleSheets.length; i++) {
      var sh = document.styleSheets[i];
      if (done && done.has(sh)) continue;
      if (sh.ownerNode && sh.ownerNode.hasAttribute && sh.ownerNode.hasAttribute('data-theme-skip')) continue;
      var rules; try { rules = sh.cssRules; } catch (e) { continue; }   // feuilles externes (polices)
      if (!rules) continue;
      walk(rules); if (done) done.add(sh);
    }
  }
  var SVG_ATTRS = ['fill', 'stroke', 'stop-color', 'color'];
  // chaque attribut converti est mémorisé : une valeur identique n'est pas reconvertie (évite la double inversion)
  function convEl(el) {
    if (el.nodeType !== 1 || el.id === 'themeBtn' || el.id === 'backHome') return;
    var memo = el.__thm || (el.__thm = {});
    var sv = el.getAttribute('style');
    if (sv && memo.style !== sv) { convDecl(el.style); memo.style = el.getAttribute('style'); memo.ostyle = sv; }
    for (var i = 0; i < SVG_ATTRS.length; i++) {
      var a = SVG_ATTRS[i], v = el.getAttribute(a);
      if (v && memo[a] !== v && /#|rgb|white|black/i.test(v)) { var nv = convStr(v, a === 'fill' && el.tagName.toLowerCase() === 'rect' ? 'bg' : 'fg'); memo[a] = nv; memo['o' + a] = v; if (nv !== v) el.setAttribute(a, nv); }
    }
  }
  function convTree(n) {
    if (n.nodeType !== 1) return;
    convEl(n);
    var all = n.querySelectorAll('[style],[fill],[stroke],[stop-color]');
    for (var i = 0; i < all.length; i++) convEl(all[i]);
  }

  /* ---------- bouton de bascule ---------- */
  function addButton() {
    if (document.getElementById('themeBtn')) return;
    var b = document.createElement('button');
    b.id = 'themeBtn'; b.type = 'button';
    b.title = dark ? 'Passer en mode clair' : 'Passer en mode sombre';
    b.setAttribute('aria-label', b.title);
    b.textContent = dark ? '☀︎' : '☾';
    var home = document.getElementById('backHome');
    b.style.cssText = 'position:fixed;left:14px;bottom:' + (home ? '62px' : '14px') + ';z-index:99999;width:40px;height:40px;border-radius:999px;' +
      'border:1px solid rgba(128,118,100,.35);background:' + (dark ? '#2a251c' : '#FFFDF7') + ';color:' + (dark ? '#e0a93f' : '#1A1612') +
      ';font-size:18px;line-height:1;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.18);padding:0;display:grid;place-items:center';
    b.onclick = function () { setMode(dark ? 'light' : 'dark'); };
    document.body.appendChild(b);
    var ps = document.createElement('style'); ps.setAttribute('data-theme-skip', '');
    ps.textContent = '@media print{#themeBtn{display:none!important}}'; document.head.appendChild(ps);
  }

  /* ---------- impression et PDF : toujours en clair ---------- */
  var paused = false, pending = [], printLight = false;
  function eachConverted(f) { var all = document.querySelectorAll('[style],[fill],[stroke],[stop-color]'); for (var i = 0; i < all.length; i++) if (all[i].__thm) f(all[i], all[i].__thm); }
  function toLight() {
    if (!dark || printLight) return; printLight = true; paused = true;
    root.classList.remove('dark');
    if (own) return;
    if (pre && pre.sheet) pre.sheet.disabled = true;
    RULES.forEach(function (e) { try { e.st.setProperty(e.p, e.old, e.pr); } catch (x) {} });
    eachConverted(function (el, m) {
      if (m.ostyle != null && el.getAttribute('style') === m.style) el.setAttribute('style', m.ostyle);
      SVG_ATTRS.forEach(function (a) { if (m['o' + a] != null && el.getAttribute(a) === m[a]) el.setAttribute(a, m['o' + a]); });
    });
  }
  function toDark() {
    if (!printLight) return; printLight = false;
    root.classList.add('dark');
    if (!own) {
      if (pre && pre.sheet) pre.sheet.disabled = false;
      RULES.forEach(function (e) { try { e.st.setProperty(e.p, e.nv, e.pr); } catch (x) {} });
      eachConverted(function (el, m) {
        if (m.ostyle != null && el.getAttribute('style') === m.ostyle) el.setAttribute('style', m.style);
        SVG_ATTRS.forEach(function (a) { if (m['o' + a] != null && el.getAttribute(a) === m['o' + a]) el.setAttribute(a, m[a]); });
      });
    }
    paused = false; var p = pending; pending = []; if (p.length) handle(p);
  }
  if (dark) {
    window.addEventListener('beforeprint', toLight);
    window.addEventListener('afterprint', toDark);
    try { var mq = window.matchMedia('print'), onMq = function (e) { if (e.matches) toLight(); else toDark(); };
      if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq); } catch (e) {}
  }
  function handle(ms) {
    if (paused) { pending = pending.concat(ms); return; }
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i];
      if (m.type === 'attributes') { convEl(m.target); continue; }
      for (var j = 0; j < m.addedNodes.length; j++) {
        var n = m.addedNodes[j];
        if (n.nodeName === 'STYLE' || n.nodeName === 'LINK') { setTimeout(convSheets, 0); continue; }
        convTree(n);
      }
    }
  }

  function start() {
    addButton();
    if (!dark || own) return;
    convSheets();
    convTree(document.body);
    new MutationObserver(handle).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'fill', 'stroke'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
