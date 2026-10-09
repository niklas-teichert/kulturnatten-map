/* Kulturnatten 2026 map. Static, no build step. Data: events.json + meta.json (see fetch_events.py). */
(function () {
  'use strict';

  // Official "Event type" values (Danish) -> German label + dot colour.
  const TYPE_INFO = {
    'Opdagelse på egen hånd': { label: 'Auf eigene Faust entdecken', color: '#6d28d9' },
    'Udstilling': { label: 'Ausstellung', color: '#dc2626' },
    'Rundvisning': { label: 'Führung', color: '#0284c7' },
    'Musik': { label: 'Musik', color: '#ea580c' },
    'Workshop': { label: 'Workshop', color: '#15803d' },
    'Koncert': { label: 'Konzert', color: '#db2777' },
    'Foredrag': { label: 'Vortrag', color: '#1e3a8a' },
    'Lysinstallation': { label: 'Lichtinstallation', color: '#ca8a04' },
    'Forestilling': { label: 'Vorstellung', color: '#0f766e' },
    'Teater og optræden': { label: 'Theater & Auftritt', color: '#92400e' },
  };
  const EXTRA_COLORS = ['#475569', '#4d7c0f', '#be185d', '#7c2d12'];
  const OTHER_COLOR = '#64748b';
  const STORE = { filter: 'kn26.filter', favs: 'kn26.favs', route: 'kn26.route', geo: 'kn26.geo' };
  const SOON_MS = 60 * 60 * 1000;
  const MAX_WAYPOINTS = 9;
  const TAP_RADIUS = 20;    // px: a tap picks the nearest visible dot within this distance
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function load(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode etc. */ }
  }

  let toastTimer = null;
  function toast(msg, ms) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 4000);
  }

  // ---------------------------------------------------------------- state
  let meta = null;
  let events = [];          // all events from events.json
  let mappable = [];        // with coordinates and not cancelled
  const byId = new Map();
  let typeOrder = [];       // event types, most common first
  const typeColor = {};
  const typeCount = {};

  const savedFilter = load(STORE.filter, {});
  const state = {
    types: new Set(Array.isArray(savedFilter.types) ? savedFilter.types : []),
    fav: !!savedFilter.fav,
    now: !!savedFilter.now,
    favs: new Set(load(STORE.favs, [])),
    route: load(STORE.route, []),
    selected: null,
    me: null,               // { lat, lng, acc }
    sheet: null,            // 'event' | 'route' | null
  };

  // ---------------------------------------------------------------- time
  function toDate(hhmm) {
    if (!hhmm) return null;
    const d = new Date(meta.event_date + 'T' + hhmm + ':00' + meta.utc_offset);
    if (parseInt(hhmm.slice(0, 2), 10) < 12) d.setTime(d.getTime() + 864e5); // after midnight
    return d;
  }
  function makeSlot(s, e, fallbackEnd) {
    const start = toDate(s);
    if (!start) return null;
    let end = toDate(e) || fallbackEnd;
    if (!end || end <= start) end = new Date(start.getTime() + 30 * 60 * 1000);
    return { s: start, e: end };
  }
  function prepareTimes(ev) {
    ev._open = makeSlot(ev.start, ev.end, null);
    ev._items = (ev.items || []).map((it) => ({
      title: it.title,
      times: it.times,
      slots: it.times.map((t) => makeSlot(t[0], t[1], ev._open && ev._open.e)).filter(Boolean),
    })).sort((a, b) => ((a.slots[0] && a.slots[0].s) || 0) - ((b.slots[0] && b.slots[0].s) || 0));
    const slots = [];
    ev._items.forEach((it) => slots.push.apply(slots, it.slots));
    ev._slots = slots.length ? slots : (ev._open ? [ev._open] : []);
  }
  function slotState(slots, now) {
    if (!slots.length) return null;
    if (slots.some((s) => s.s <= now && s.e > now)) return 'now';
    if (slots.some((s) => s.s > now && s.s - now <= SOON_MS)) return 'soon';
    if (slots.every((s) => s.e <= now)) return 'over';
    return 'later';
  }
  const isNowSoon = (ev, now) => { const st = slotState(ev._slots, now); return st === 'now' || st === 'soon'; };
  const fmtTimes = (pairs) => pairs.map((t) => t[0] + (t[1] ? '–' + t[1] : '')).join(', ');
  function minutesUntil(d, now) { return Math.max(1, Math.round((d - now) / 60000)); }
  function venueStatus(ev, now) {
    if (ev.canceled) return '<span class="state canceled">Abgesagt</span>';
    const o = ev._open;
    if (!o) return '';
    if (now < o.s) {
      return o.s - now <= SOON_MS
        ? '<span class="state soon">Öffnet in ' + minutesUntil(o.s, now) + ' Min.</span>'
        : 'Öffnet um ' + esc(ev.start);
    }
    if (now < o.e) return '<span class="state now">Jetzt geöffnet</span>';
    return '<span class="state over">Geschlossen</span>';
  }

  // ---------------------------------------------------------------- geometry
  function distM(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const ll = (p) => p.lat.toFixed(6) + ',' + p.lng.toFixed(6);

  // ---------------------------------------------------------------- map
  const map = L.map('map', { zoomControl: false, preferCanvas: true, minZoom: 10, maxZoom: 19, zoomSnap: 0.25 });
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' +
      ' · Programm: <a href="https://kulturnatten.dk/en/program-map/" target="_blank" rel="noopener">kulturnatten.dk</a>',
  }).addTo(map);
  map.setView([55.6761, 12.5683], 13);

  map.createPane('routePane').style.zIndex = 390;   // route line + accuracy circle, below the dots
  map.createPane('mePane').style.zIndex = 450;      // own position, above the dots
  map.getPane('mePane').style.pointerEvents = 'none';
  const dotRenderer = L.canvas({ padding: 0.5 });
  const routeRenderer = L.svg({ pane: 'routePane' });
  const meRenderer = L.svg({ pane: 'mePane' });

  const dotsLayer = L.layerGroup().addTo(map);
  const ringsLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const selRing = L.circleMarker([0, 0], {
    renderer: dotRenderer, radius: 11, weight: 3, color: '#2563eb', opacity: 0.95, fill: false, interactive: false,
  });

  function colorFor(ev) {
    if (state.types.size) {
      for (const t of typeOrder) if (state.types.has(t) && ev.types.includes(t)) return typeColor[t];
    }
    return ev._primary ? typeColor[ev._primary] : OTHER_COLOR;
  }
  function isVisible(ev, now) {
    if (state.types.size && !ev.types.some((t) => state.types.has(t))) return false;
    if (state.fav && !state.favs.has(ev.id)) return false;
    if (state.now && !isNowSoon(ev, now)) return false;
    return true;
  }

  function renderMap() {
    const now = new Date();
    const inRoute = new Set(state.route);
    ringsLayer.clearLayers();
    for (const ev of mappable) {
      const show = isVisible(ev, now) || inRoute.has(ev.id) || state.selected === ev.id;
      const fill = colorFor(ev);
      if (ev._dot.options.fillColor !== fill) ev._dot.setStyle({ fillColor: fill });
      if (show && !dotsLayer.hasLayer(ev._dot)) dotsLayer.addLayer(ev._dot);
      if (!show && dotsLayer.hasLayer(ev._dot)) dotsLayer.removeLayer(ev._dot);
      if (show && state.favs.has(ev.id)) {
        ringsLayer.addLayer(L.circleMarker([ev.lat, ev.lng], {
          renderer: dotRenderer, radius: 8.5, weight: 1.75, color: '#16181d', opacity: 0.95, fill: false, interactive: false,
        }));
      }
    }
    renderRouteLayer();
    renderChips(now);
    const n = state.route.length;
    $('routeCount').textContent = n;
    $('routeBtn').dataset.empty = String(n === 0);
    $('routeBtn').setAttribute('aria-label', n ? 'Route anzeigen (' + n + (n === 1 ? ' Stopp)' : ' Stopps)') : 'Route anzeigen');
  }

  function routeStops() {
    return state.route.map((id) => byId.get(id)).filter((ev) => ev && ev.lat != null);
  }
  function renderRouteLayer() {
    routeLayer.clearLayers();
    const stops = routeStops();
    if (!stops.length) return;
    const pts = stops.map((ev) => [ev.lat, ev.lng]);
    if (state.me) {
      routeLayer.addLayer(L.polyline([[state.me.lat, state.me.lng], pts[0]], {
        renderer: routeRenderer, color: '#16181d', weight: 2.5, opacity: 0.7, dashArray: '3 7', interactive: false,
      }));
    }
    if (pts.length > 1) {
      routeLayer.addLayer(L.polyline(pts, {
        renderer: routeRenderer, color: '#16181d', weight: 3, opacity: 0.75, interactive: false,
      }));
    }
    stops.forEach((ev, i) => {
      routeLayer.addLayer(L.marker([ev.lat, ev.lng], {
        icon: L.divIcon({ className: 'route-label', html: '<span>' + (i + 1) + '</span>', iconSize: [0, 0] }),
        interactive: false, keyboard: false,
      }));
    });
  }

  // ---------------------------------------------------------------- chips
  function renderChips(now) {
    const nowCount = mappable.filter((ev) => isNowSoon(ev, now)).length;
    const anyFilter = state.types.size || state.fav || state.now;
    let html = chip('all', '', 'Alle', mappable.length, !anyFilter) +
      chip('fav', '', '★ Favoriten', state.favs.size, state.fav) +
      chip('now', '', 'Jetzt / bald', nowCount, state.now) +
      '<span class="chip-sep" aria-hidden="true"></span>';
    for (const t of typeOrder) {
      html += chip('type', t, (TYPE_INFO[t] && TYPE_INFO[t].label) || t, typeCount[t] || 0, state.types.has(t), typeColor[t]);
    }
    const el = $('chips');
    const scroll = el.scrollLeft;
    el.innerHTML = html;
    el.scrollLeft = scroll;
    updateChipFade();
  }
  function chip(kind, type, label, count, pressed, color) {
    return '<button type="button" class="chip" data-kind="' + kind + '" data-type="' + esc(type) + '" aria-pressed="' + pressed + '"' +
      (type ? ' title="' + esc(type) + '"' : '') + '>' +
      (color ? '<span class="swatch" style="background:' + color + '"></span>' : '') +
      esc(label) + ' <span class="n">' + count + '</span></button>';
  }
  // The chip bar sits outside the map container; keep Leaflet out of its touches anyway.
  L.DomEvent.disableClickPropagation($('chips'));
  L.DomEvent.disableScrollPropagation($('chips'));
  function updateChipFade() {
    const el = $('chips');
    el.dataset.atEnd = String(el.scrollLeft + el.clientWidth >= el.scrollWidth - 4);
  }
  $('chips').addEventListener('scroll', updateChipFade, { passive: true });
  window.addEventListener('resize', updateChipFade);

  $('chips').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    const kind = btn.dataset.kind;
    if (kind === 'all') { state.types.clear(); state.fav = false; state.now = false; }
    if (kind === 'fav') {
      state.fav = !state.fav;
      if (state.fav && !state.favs.size) toast('Noch keine Favoriten. Öffne eine Veranstaltung und tippe auf „☆ Favorit“.');
    }
    if (kind === 'now') state.now = !state.now;
    if (kind === 'type') {
      const t = btn.dataset.type;
      if (state.types.has(t)) state.types.delete(t); else state.types.add(t);
    }
    save(STORE.filter, { types: Array.from(state.types), fav: state.fav, now: state.now });
    renderMap();
  });

  // ---------------------------------------------------------------- sheets
  function openSheet(which) {
    state.sheet = which;
    $('eventSheet').hidden = which !== 'event';
    $('routeSheet').hidden = which !== 'route';
  }
  function closeSheets() {
    state.sheet = null;
    state.selected = null;
    $('eventSheet').hidden = true;
    $('routeSheet').hidden = true;
    map.removeLayer(selRing);
    renderMap();
  }
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });
  // Dots are drawn non-interactive; a tap opens the NEAREST visible dot within TAP_RADIUS,
  // so small dots stay easy to hit and neighbours never steal the tap.
  map.on('click', (e) => {
    let best = null, bestD = TAP_RADIUS;
    for (const ev of mappable) {
      if (!ev._dot._map) continue;
      const q = map.latLngToContainerPoint([ev.lat, ev.lng]);
      const d = Math.hypot(q.x - e.containerPoint.x, q.y - e.containerPoint.y);
      if (d <= bestD) { best = ev; bestD = d; }
    }
    if (best) openEvent(best.id);
    else if (state.sheet) closeSheets();
  });

  // swipe down on the grip closes a sheet
  document.querySelectorAll('[data-close-swipe]').forEach((grip) => {
    const sheet = grip.parentElement;
    let y0 = null;
    grip.addEventListener('pointerdown', (e) => { y0 = e.clientY; sheet.style.transition = 'none'; grip.setPointerCapture(e.pointerId); });
    grip.addEventListener('pointermove', (e) => {
      if (y0 == null) return;
      sheet.style.transform = 'translateY(' + Math.max(0, e.clientY - y0) + 'px)';
    });
    const end = (e) => {
      if (y0 == null) return;
      const dy = e.clientY - y0;
      y0 = null;
      sheet.style.transition = '';
      sheet.style.transform = '';
      if (dy > 70) closeSheets();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  });

  function keepVisible(latlng) {
    setTimeout(() => {
      const sheetEl = state.sheet === 'event' ? $('eventSheet') : $('routeSheet');
      const bottom = window.innerHeight - (sheetEl.hidden ? 0 : sheetEl.offsetHeight) - 24;
      const top = 70;
      const p = map.latLngToContainerPoint(latlng);
      const w = map.getSize().x;
      let dx = 0, dy = 0;
      if (p.y > bottom || p.y < top) dy = p.y - (top + Math.max(top, bottom)) / 2;
      if (p.x < 24 || p.x > w - 24) dx = p.x - w / 2;
      if (dx || dy) map.panBy([dx, dy]);
    }, 30);
  }

  function directionsUrl(ev) {
    const dest = ev.lat.toFixed(6) + ',' + ev.lng.toFixed(6);
    return IS_IOS
      ? 'https://maps.apple.com/?daddr=' + dest
      : 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(dest);
  }

  function openEvent(id, opts) {
    const ev = byId.get(id);
    if (!ev) return;
    state.selected = id;
    renderEventSheet();
    openSheet('event');
    if (ev.lat != null) {
      selRing.setLatLng([ev.lat, ev.lng]).addTo(map);
      if (opts && opts.fly) map.setView([ev.lat, ev.lng], Math.max(map.getZoom(), 16));
      keepVisible([ev.lat, ev.lng]);
    }
    renderMap();
    $('eventBody').scrollTop = 0;
  }

  function renderEventSheet() {
    const ev = byId.get(state.selected);
    if (!ev) return;
    const now = new Date();
    const isFav = state.favs.has(ev.id);
    const inRoute = state.route.includes(ev.id);
    const kicker = [ev.number ? '#' + ev.number : '', ev.area || ''].filter(Boolean).join(' · ');
    const tags = ev.types.map((t) =>
      '<li><span class="swatch" style="background:' + (typeColor[t] || OTHER_COLOR) + '"></span>' +
      esc((TYPE_INFO[t] && TYPE_INFO[t].label) || t) + '</li>').join('');
    const items = ev._items.map((it) => {
      const st = slotState(it.slots, now);
      return '<li class="' + (st ? 'is-' + st : '') + '"><span class="t">' +
        it.times.map((t) => esc(t[0] + (t[1] ? '–' + t[1] : ''))).join('<br>') +
        '</span><span>' + esc(it.title) + '</span></li>';
    }).join('');
    $('eventBody').innerHTML =
      (kicker ? '<p class="kicker">' + esc(kicker) + '</p>' : '') +
      '<h2 id="evTitle">' + esc(ev.title) + '</h2>' +
      (ev.title_orig && ev.title_orig !== ev.title ? '<p class="orig" lang="en">' + esc(ev.title_orig) + '</p>' : '') +
      (ev.venue && ev.venue !== ev.title ? '<p class="venue">' + esc(ev.venue) + '</p>' : '') +
      (ev.address ? '<p class="addr">' + esc(ev.address) + '</p>' : '') +
      '<p class="when">' + (ev.start || ev.end ? esc(fmtTimes([[ev.start || '?', ev.end]])) + ' · ' : '') +
      venueStatus(ev, now) + (ev.sold_out ? ' · <span class="state over">Ausverkauft</span>' : '') + '</p>' +
      (tags ? '<ul class="tags">' + tags + '</ul>' : '') +
      '<div class="actions">' +
      '<button type="button" class="btn' + (isFav ? ' on' : '') + '" data-act="fav" aria-pressed="' + isFav + '">' +
      (isFav ? '★ Favorit' : '☆ Favorit') + '</button>' +
      '<button type="button" class="btn' + (inRoute ? ' on' : '') + '" data-act="route">' +
      (inRoute ? '− Aus Route entfernen' : '+ Zur Route hinzufügen') + '</button>' +
      '<a class="btn primary" href="' + esc(ev.url) + '" target="_blank" rel="noopener">Offizielle Seite öffnen</a>' +
      (ev.lat != null ? '<a class="btn" href="' + esc(directionsUrl(ev)) + '" target="_blank" rel="noopener">Wegbeschreibung</a>' : '') +
      '</div>' +
      (items ? '<p class="section-title">Programm</p><ul class="programme">' + items + '</ul>' : '');
  }
  $('eventBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = state.selected;
    if (btn.dataset.act === 'fav') {
      if (state.favs.has(id)) state.favs.delete(id); else state.favs.add(id);
      save(STORE.favs, Array.from(state.favs));
    }
    if (btn.dataset.act === 'route') {
      const i = state.route.indexOf(id);
      if (i >= 0) state.route.splice(i, 1); else state.route.push(id);
      save(STORE.route, state.route);
      if (i < 0) toast('Als Stopp ' + state.route.length + ' zur Route hinzugefügt.', 2500);
    }
    renderEventSheet();
    renderMap();
  });

  // ---------------------------------------------------------------- route sheet
  function routeLegs(stops) {
    // Google Maps: origin + up to 9 waypoints + destination per link.
    const pts = (state.me ? [{ lat: state.me.lat, lng: state.me.lng, n: 0 }] : [])
      .concat(stops.map((ev, i) => ({ lat: ev.lat, lng: ev.lng, n: i + 1 })));
    if (pts.length === 1) {
      return [{ from: 1, to: 1, url: 'https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=' + encodeURIComponent(ll(pts[0])) }];
    }
    const legs = [];
    for (let i = 0; i < pts.length - 1;) {
      const end = Math.min(i + MAX_WAYPOINTS + 1, pts.length - 1);
      const leg = pts.slice(i, end + 1);
      let url = 'https://www.google.com/maps/dir/?api=1&travelmode=walking' +
        '&origin=' + encodeURIComponent(ll(leg[0])) +
        '&destination=' + encodeURIComponent(ll(leg[leg.length - 1]));
      const way = leg.slice(1, -1);
      if (way.length) url += '&waypoints=' + encodeURIComponent(way.map(ll).join('|'));
      legs.push({ from: Math.max(1, leg[0].n), to: leg[leg.length - 1].n, url: url });
      i = end;
    }
    return legs;
  }

  function renderRouteSheet() {
    const stops = state.route.map((id) => byId.get(id)).filter(Boolean);
    let body = '<h2 id="routeTitle">Meine Route</h2>';
    if (!stops.length) {
      body += '<p class="note">Noch keine Stopps. Tippe auf einen Punkt auf der Karte und dann auf „+ Zur Route hinzufügen“.</p>';
      $('routeBody').innerHTML = body;
      return;
    }
    let km = 0;
    for (let i = 1; i < stops.length; i++) km += distM(stops[i - 1], stops[i]) / 1000;
    body += '<p class="note">' + stops.length + (stops.length === 1 ? ' Stopp' : ' Stopps') +
      (stops.length > 1 ? ' · etwa ' + km.toFixed(1).replace('.', ',') + ' km zwischen den Stopps (Luftlinie)' : '') + '</p>';
    body += '<ol class="stops">' + stops.map((ev, i) =>
      '<li data-id="' + ev.id + '"><span class="num">' + (i + 1) + '</span>' +
      '<button type="button" class="what" data-act="show"><b>' + esc(ev.venue || ev.title) + '</b><small>' +
      esc([ev.canceled ? 'ABGESAGT' : '', ev.start && ev.end ? ev.start + '–' + ev.end : '', ev.venue && ev.venue !== ev.title ? ev.title : ''].filter(Boolean).join(' · ')) +
      '</small></button>' +
      '<button type="button" class="icon-btn" data-act="up" aria-label="Nach oben"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button type="button" class="icon-btn" data-act="down" aria-label="Nach unten"' + (i === stops.length - 1 ? ' disabled' : '') + '>↓</button>' +
      '<button type="button" class="icon-btn" data-act="remove" aria-label="Entfernen">✕</button></li>').join('') + '</ol>';
    const legs = routeLegs(stops.filter((ev) => ev.lat != null));
    body += '<div class="route-actions">' +
      '<button type="button" class="btn" data-act="sort"' + (stops.length < 2 ? ' disabled' : '') + '>' +
      (state.me ? 'Nach Entfernung sortieren' : 'Nach Entfernung sortieren (ab Stopp 1)') + '</button>';
    if (legs.length) {
      body += '<a class="btn primary" href="' + esc(legs[0].url) + '" target="_blank" rel="noopener">' +
        (legs.length > 1 ? 'Fußweg in Google Maps öffnen, Stopps ' + legs[0].from + '–' + legs[0].to : 'Fußweg in Google Maps öffnen') + '</a>';
    }
    if (legs.length > 1) {
      body += '<p class="note">Google Maps nimmt höchstens ' + MAX_WAYPOINTS + ' Zwischenstopps. Die Route ist deshalb in ' +
        legs.length + ' Teile geteilt:</p>' + legs.slice(1).map((leg) =>
        '<a class="btn" href="' + esc(leg.url) + '" target="_blank" rel="noopener">Nächster Teil: Stopps ' + leg.from + '–' + leg.to + '</a>').join('');
    }
    body += '</div>' + (state.me ? '' : '<p class="note">Tipp: Tippe unten rechts auf „Mein Standort“, damit die Route bei dir beginnt.</p>');
    $('routeBody').innerHTML = body;
  }

  function sortByDistance() {
    const stops = state.route.map((id) => byId.get(id)).filter((ev) => ev && ev.lat != null);
    if (stops.length < 2) return;
    const rest = stops.slice();
    const ordered = [];
    let cur = state.me;
    if (!cur) { cur = rest.shift(); ordered.push(cur); }
    while (rest.length) {
      let best = 0;
      for (let i = 1; i < rest.length; i++) if (distM(cur, rest[i]) < distM(cur, rest[best])) best = i;
      cur = rest.splice(best, 1)[0];
      ordered.push(cur);
    }
    const missing = state.route.filter((id) => !ordered.some((ev) => ev.id === id));
    state.route = ordered.map((ev) => ev.id).concat(missing);
    save(STORE.route, state.route);
  }

  $('routeBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    const li = btn.closest('li');
    const id = li ? Number(li.dataset.id) : null;
    const i = id != null ? state.route.indexOf(id) : -1;
    if (act === 'show') { openEvent(id, { fly: true }); return; }
    if (act === 'up' && i > 0) state.route.splice(i - 1, 0, state.route.splice(i, 1)[0]);
    if (act === 'down' && i >= 0 && i < state.route.length - 1) state.route.splice(i + 1, 0, state.route.splice(i, 1)[0]);
    if (act === 'remove' && i >= 0) state.route.splice(i, 1);
    if (act === 'sort') { sortByDistance(); toast(state.me ? 'Ab deinem Standort sortiert.' : 'Ab Stopp 1 sortiert.', 2500); }
    save(STORE.route, state.route);
    renderRouteSheet();
    renderMap();
  });

  $('routeBtn').addEventListener('click', () => {
    if (state.sheet === 'route') { closeSheets(); return; }
    state.selected = null;
    map.removeLayer(selRing);
    renderRouteSheet();
    openSheet('route');
    renderMap();
    const stops = routeStops();
    if (stops.length) {
      const pts = stops.map((ev) => [ev.lat, ev.lng]);
      if (state.me) pts.push([state.me.lat, state.me.lng]);
      setTimeout(() => {
        map.fitBounds(L.latLngBounds(pts), {
          paddingTopLeft: [30, 70], paddingBottomRight: [30, $('routeSheet').offsetHeight + 30], maxZoom: 16,
        });
      }, 30);
    }
  });

  // ---------------------------------------------------------------- location
  let watchId = null;
  let centerOnFix = false;
  let meDot = null, accCircle = null;
  const locateBtn = $('locateBtn');

  function geoError(err, loud) {
    const msgs = {
      1: 'Der Standortzugriff ist blockiert. Erlaube ihn für diese Seite in den Browser-Einstellungen (iPhone: Einstellungen › Datenschutz & Sicherheit › Ortungsdienste › Safari-Websites).',
      2: 'Dein Standort ist gerade nicht verfügbar.',
      3: 'Die Standortsuche hat zu lange gedauert. Bitte noch einmal versuchen.',
    };
    if (err.code === 1 && watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    if (err.code === 1) save(STORE.geo, false);
    locateBtn.classList.remove('active');
    locateBtn.classList.add('error');
    if (loud) toast(msgs[err.code] || 'Der Standort konnte nicht bestimmt werden.', 6000);
  }

  function startWatch(loud) {
    if (!('geolocation' in navigator)) { if (loud) toast('Dieser Browser kann den Standort nicht bestimmen.'); return; }
    if (!window.isSecureContext) { if (loud) toast('Der Standort braucht eine sichere Verbindung (https).'); return; }
    if (watchId != null) return;
    watchId = navigator.geolocation.watchPosition((pos) => {
      const first = !state.me;
      state.me = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
      save(STORE.geo, true);
      locateBtn.classList.remove('error');
      locateBtn.classList.add('active');
      const latlng = [state.me.lat, state.me.lng];
      if (!meDot) {
        accCircle = L.circle(latlng, { renderer: routeRenderer, radius: state.me.acc, color: '#2563eb', weight: 1, opacity: 0.5, fillColor: '#2563eb', fillOpacity: 0.12, interactive: false }).addTo(map);
        meDot = L.circleMarker(latlng, { renderer: meRenderer, radius: 7, color: '#ffffff', weight: 2.5, fillColor: '#2563eb', fillOpacity: 1, interactive: false }).addTo(map);
      } else {
        meDot.setLatLng(latlng);
        accCircle.setLatLng(latlng).setRadius(state.me.acc);
      }
      if (centerOnFix) { centerOnFix = false; map.setView(latlng, Math.max(map.getZoom(), 16)); }
      renderRouteLayer();
      if (first && state.sheet === 'route') renderRouteSheet();
    }, (err) => geoError(err, loud || centerOnFix), { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  }

  locateBtn.addEventListener('click', () => {
    if (state.me && watchId != null) {
      map.setView([state.me.lat, state.me.lng], Math.max(map.getZoom(), 16));
      return;
    }
    centerOnFix = true;
    toast('Standort wird gesucht …', 2500);
    if (watchId == null) startWatch(true);
  });

  // Resume location silently if the visitor already allowed it.
  function resumeLocation() {
    if (!('geolocation' in navigator) || !window.isSecureContext) return;
    const fallback = () => { if (load(STORE.geo, false)) startWatch(false); };
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' })
        .then((p) => { if (p.state === 'granted') startWatch(false); else if (p.state === 'prompt') fallback(); })
        .catch(fallback);
    } else {
      fallback();
    }
  }

  // ---------------------------------------------------------------- data
  function init(evs, m) {
    meta = m;
    events = evs;
    events.forEach((ev) => { byId.set(ev.id, ev); prepareTimes(ev); });
    mappable = events.filter((ev) => ev.lat != null && ev.lng != null && !ev.canceled);

    const counts = {};
    mappable.forEach((ev) => ev.types.forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
    typeOrder = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
    let extra = 0;
    typeOrder.forEach((t) => {
      typeCount[t] = counts[t];
      typeColor[t] = (TYPE_INFO[t] && TYPE_INFO[t].color) || EXTRA_COLORS[extra++ % EXTRA_COLORS.length];
    });
    state.types.forEach((t) => { if (!counts[t]) state.types.delete(t); });
    state.favs.forEach((id) => { if (!byId.has(id)) state.favs.delete(id); });
    state.route = state.route.filter((id) => byId.has(id));

    for (const ev of mappable) {
      // Dot colour without a filter: the event's rarest type is the most telling one.
      ev._primary = ev.types.slice().sort((a, b) => counts[a] - counts[b])[0] || null;
      ev._dot = L.circleMarker([ev.lat, ev.lng], {
        renderer: dotRenderer, radius: 5, weight: 1.5, color: '#ffffff', opacity: 1, fillOpacity: 1,
        fillColor: ev._primary ? typeColor[ev._primary] : OTHER_COLOR, interactive: false,
      });
    }

    renderMap();
    if (mappable.length) {
      map.fitBounds(L.latLngBounds(mappable.map((ev) => [ev.lat, ev.lng])), {
        paddingTopLeft: [16, 60], paddingBottomRight: [16, 90],
      });
    }
    resumeLocation();
    setInterval(() => {
      renderMap();
      if (state.sheet === 'event') renderEventSheet();
    }, 60000);
  }

  Promise.all([
    fetch('events.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    fetch('meta.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
  ]).then(([evs, m]) => init(evs, m))
    .catch(() => toast('Das Programm konnte nicht geladen werden. Bitte Verbindung prüfen und neu laden.', 10000));

  window.__kn = { state, byId, map, openEvent }; // for debugging / tests
})();
