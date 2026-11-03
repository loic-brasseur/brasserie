/* ============================================================================
   Traçabilité des lots fournisseurs + valorisation des sorties de stock
   ----------------------------------------------------------------------------
   Recalculé à partir de l'historique des mouvements du Stock (brasserie_stock_v2) :
   - chaque réception crée une « couche » (n° de lot fournisseur, quantité, prix) ;
   - chaque sortie (Brew Log, Packaging Log, sortie manuelle) consomme les couches
     les plus anciennes d'abord (FIFO) ;
   - le stock présent avant le premier mouvement enregistré forme une couche
     « stock initial » (lot non renseigné, prix de l'article).
   Prix utilisé : prix saisi à la réception > prix de l'article > tarif du Carnet
   de brassage (brasserie_prix_v1, €/kg ou €/L converti dans l'unité du stock).
   ========================================================================== */
(function () {
  'use strict';
  function pN(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘`]/g, "'").toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function num(v) { if (v === '' || v == null) return null; var n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : null; }
  /* facteur pour passer d'un prix au kg (ou au L) au prix par unité de stock */
  function unitFactor(u) {
    u = pN(u);
    if (/^(g|gr|grs|gramme|grammes)$/.test(u)) return 1 / 1000;
    if (/^(kg|kgs|kilo|kilos|kilogramme|kilogrammes)$/.test(u)) return 1;
    if (/^(l|litre|litres)$/.test(u)) return 1;
    if (/^(ml|millilitre|millilitres)$/.test(u)) return 1 / 1000;
    if (/^(cl)$/.test(u)) return 1 / 100;
    return null;
  }
  var tarifCache = null;
  function tarifs() {
    if (tarifCache) return tarifCache;
    var p = null; try { p = JSON.parse(localStorage.getItem('brasserie_prix_v1')); } catch (e) {}
    tarifCache = p && p.items ? Object.keys(p.items).map(function (k) { return p.items[k]; }).filter(function (t) { return t && t.n && pN(t.n).length >= 3; }) : [];
    return tarifCache;
  }
  function tarifCarnet(it) {
    var f = unitFactor(it.unit); if (f == null) return null;
    var n = ' ' + pN(it.name) + ' ', bio = / bio /.test(n), best = null;
    tarifs().forEach(function (t) { var tn = pN(t.n); if (n.indexOf(' ' + tn + ' ') >= 0 && (!best || tn.length > pN(best.n).length)) best = t; });
    if (!best) return null;
    var pr = bio && best.b != null ? best.b : (best.c != null ? best.c : best.b);
    return pr == null ? null : { p: pr * f, src: 'tarif Carnet (' + best.n + (bio ? ', bio' : '') + ')' };
  }
  function itemPrice(it) {
    var p = num(it && it.price); if (p != null) return { p: p, src: 'prix article' };
    var t = it ? tarifCarnet(it) : null; return t || { p: null, src: null };
  }
  function compute(st) {
    tarifCache = null;
    st = st || {}; var items = {}; (st.items || []).forEach(function (i) { items[i.id] = i; });
    var moves = (st.moves || []).filter(function (m) { return m && (m.type === 'reception' || m.type === 'usage'); }).slice()
      .sort(function (a, b) { return String(a.date || '').localeCompare(String(b.date || '')) || (a.createdAt || 0) - (b.createdAt || 0); });
    var rec = {}, use = {};
    moves.forEach(function (m) { (m.lines || []).forEach(function (l) { var q = num(l.qty) || 0; if (m.type === 'reception') rec[l.id] = (rec[l.id] || 0) + q; else use[l.id] = (use[l.id] || 0) + q; }); });
    var layers = {};
    (st.items || []).forEach(function (it) {
      var open = (num(it.qty) || 0) - (rec[it.id] || 0) + (use[it.id] || 0), ip = itemPrice(it);
      layers[it.id] = open > 1e-9 ? [{ lot: '', init: true, qty: open, q0: open, price: ip.p, psrc: ip.src, aa: null, date: null, party: 'Stock initial' }] : [];
    });
    var alloc = {};
    moves.forEach(function (m) {
      if (m.type === 'reception') {
        (m.lines || []).forEach(function (l) {
          var it = items[l.id]; if (!it) return; var pr = num(l.price), ip = pr == null ? itemPrice(it) : null;
          (layers[l.id] = layers[l.id] || []).push({ lot: String(l.lot || '').trim(), dluo: l.dluo || '', aa: num(l.aa), qty: num(l.qty) || 0, q0: num(l.qty) || 0, price: pr != null ? pr : ip.p, psrc: pr != null ? 'prix de réception' : ip.src, date: m.date, party: m.party || '', moveId: m.id });
        });
      } else {
        alloc[m.id] = (m.lines || []).map(function (l) {
          var it = items[l.id], need = num(l.qty) || 0, parts = [], L = layers[l.id] || [];
          var take = function (f) { var t = Math.min(need, f.qty);
            parts.push({ lot: f.lot, dluo: f.dluo, aa: f.aa, qty: t, price: f.price, psrc: f.psrc, date: f.date, party: f.party, init: !!f.init, chosen: !!want });
            f.qty -= t; need -= t; };
          // lot choisi à la sortie : pris en premier, le reste éventuel suit l'ordre FIFO
          var want = String(l.lot || '').trim();
          if (want) { L.forEach(function (f) { if (need > 1e-9 && f.lot === want && f.qty > 1e-9) take(f); }); for (var z = L.length - 1; z >= 0; z--) if (L[z].qty <= 1e-9) L.splice(z, 1); want = ''; }
          while (need > 1e-9 && L.length) { take(L[0]); if (L[0].qty <= 1e-9) L.shift(); }
          if (need > 1e-9) { var ip = it ? itemPrice(it) : { p: null }; parts.push({ lot: '', qty: need, price: ip.p, psrc: ip.src, unknown: true }); }
          var cost = 0, miss = false; parts.forEach(function (p) { if (p.price == null) miss = true; else cost += p.price * p.qty; });
          return { id: l.id, item: it, name: it ? it.name : '(article supprimé)', unit: it ? it.unit || '' : '', cat: it ? it.cat : '', qty: num(l.qty) || 0, k: l.k || null, parts: parts, cost: cost, missingPrice: miss };
        });
      }
    });
    return { alloc: alloc, layers: layers, items: items, moves: moves };
  }
  function stockValue(st, res) {
    res = res || compute(st); var v = 0, miss = [];
    Object.keys(res.layers).forEach(function (id) { var it = res.items[id]; if (!it) return; var has = false;
      res.layers[id].forEach(function (L) { if (L.qty > 1e-9) { if (L.price == null) has = true; else v += L.price * L.qty; } }); if (has) miss.push(it.name); });
    return { value: v, missing: miss };
  }
  /* lots de bière ayant utilisé un lot fournisseur donné (recherche « rappel ») */
  function whereUsed(st, query, res) {
    res = res || compute(st); var q = pN(query); if (!q) return [];
    var out = [];
    res.moves.forEach(function (m) {
      if (m.type !== 'usage') return;
      (res.alloc[m.id] || []).forEach(function (l) { l.parts.forEach(function (p) { if (p.lot && pN(p.lot).indexOf(q) >= 0) out.push({ move: m, line: l, part: p }); }); });
    });
    return out;
  }
  /* lots restant en stock pour un article (avant la sortie skipMoveId, pour pouvoir la modifier) */
  function lotChoices(st, itemId, skipMoveId) {
    var st2 = st;
    if (skipMoveId) {
      var mv = (st.moves || []).find(function (m) { return m.id === skipMoveId; }), back = 0;
      if (mv) (mv.lines || []).forEach(function (l) { if (l.id === itemId) back += num(l.qty) || 0; });
      st2 = { items: (st.items || []).map(function (i) { return i.id === itemId ? Object.assign({}, i, { qty: (num(i.qty) || 0) + (mv && mv.type === 'usage' ? back : -back) }) : i; }),
              moves: (st.moves || []).filter(function (m) { return m.id !== skipMoveId; }) };
    }
    var r = compute(st2);
    return (r.layers[itemId] || []).filter(function (L) { return L.qty > 1e-9; }).map(function (L) { return { lot: L.lot, qty: L.qty, aa: L.aa, date: L.date, init: !!L.init, party: L.party }; });
  }
  /* options d'un <select> « Lot utilisé » : vide = le plus ancien (FIFO) */
  function lotOptions(st, itemId, chosen, unit, skipMoveId) {
    var L = lotChoices(st, itemId, skipMoveId), named = L.filter(function (x) { return x.lot; });
    if (!named.length && !chosen) return '';
    var e = function (t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    var q = function (v) { return (+v).toLocaleString('fr-FR', { maximumFractionDigits: 2 }); };
    var first = L[0];
    var h = '<option value="">Le plus ancien' + (first ? ' — ' + e(first.lot || (first.init ? 'stock initial' : 'lot non renseigné')) : '') + '</option>';
    var seen = {};
    named.forEach(function (x) { if (seen[x.lot]) { seen[x.lot].qty += x.qty; return; } seen[x.lot] = x; });
    Object.keys(seen).forEach(function (k) { var x = seen[k];
      h += '<option value="' + e(k) + '"' + (k === chosen ? ' selected' : '') + '>Lot ' + e(k) + ' — ' + q(x.qty) + ' ' + e(unit || '') + (x.aa != null ? ' · ' + String(x.aa).replace('.', ',') + ' % AA' : '') + (x.date ? ' · reçu ' + x.date.slice(8, 10) + '/' + x.date.slice(5, 7) : '') + '</option>'; });
    if (chosen && !seen[chosen]) h += '<option value="' + e(chosen) + '" selected>Lot ' + e(chosen) + ' (épuisé)</option>';
    return h;
  }
  window.BrasserieTrace = { lotChoices: lotChoices, lotOptions: lotOptions, compute: compute, itemPrice: itemPrice, unitFactor: unitFactor, stockValue: stockValue, whereUsed: whereUsed };
})();
