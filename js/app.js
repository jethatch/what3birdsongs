import { geocode, formatLatLng } from "./geocode.js";
import {
  buildWalkRoute, buildRoadRoute, buildPathRoute, RoutingError, pointAt, trackUpTo,
  stopsToGeoJSON, wrapLng,
} from "./routing.js";
import { GRIDS } from "./grid.js";
import { loadBirds, prepareBirds, birdsFor, catalogueInfo } from "./birds.js";
import { Aviary, Player, LiveRecorder, renderSong, songSeconds } from "./audio.js";
import { combine, licenceName, licenceUrl } from "./licences.js";
import { LiveSession, liveSupport, paceName } from "./live.js";
import { encodeState, decodeHash } from "./link.js";

const BASEMAPS = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
};
// Route colours live here rather than in CSS because the map is drawn on a canvas.
const MAP_COLOURS = {
  dark: { hex: "#ffe14d", played: "#ff4d8d", current: "#ffe14d", track: "rgba(255,255,255,0.55)", casing: "#0d0d0f" },
  light: { hex: "#17160f", played: "#d6004f", current: "#ffd60a", track: "rgba(23,22,15,0.5)", casing: "#fffdf8" },
};
const LENGTHS = {
  short: { name: "Short", stops: 10, explain: "About 10 stops at most. Big hexagons, a quick sketch of the trip." },
  medium: { name: "Medium", stops: 28, explain: "About 28 stops at most. A proper song." },
  long: { name: "Long", stops: 75, explain: "About 75 stops at most. Small hexagons, the album version." },
};
const MODES = {
  hex: { explain: "Greedy local routing: from each hexagon, step to whichever neighbour is nearest the destination. Worked out in your browser, and it ignores roads, rivers and lakes." },
  road: { explain: "Asks the public OSRM server for a driving route and plays the hexagons it passes through. If no road connects the two places, or either pin is far from any road, you get the hex walk instead." },
};
const PER_STOP_EXPLAIN = {
  3: "Each stop’s three birds sing one after another: the full address of every place you pass.",
  1: "Each stop’s three birds sing at once, a small dawn chorus, so the trip moves three times as fast.",
};
const PACES = {
  quick: { name: "Quick", seconds: 3, explain: "Each turn lasts 3 seconds: a snatch of each song." },
  steady: { name: "Steady", seconds: 4.5, explain: "Each turn lasts 4½ seconds." },
  slow: { name: "Slow", seconds: 6, explain: "Each turn lasts 6 seconds, the whole of each clip." },
};
const EXAMPLE = {
  start: { lat: 42.35883, lng: -71.05783, label: "Boston, Massachusetts" },
  end: { lat: 40.71273, lng: -74.00602, label: "New York, New York" },
};
const SECTIONS = ["more-route"];
const QUIET = "No birds here: outside the US, Canada and Mexico, or out at sea.";

const $ = (id) => document.getElementById(id);
const escapeHTML = (text) => String(text).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const state = {
  grid: "h3",
  start: null, // { lat, lng, label }
  end: null,
  mode: "hex",
  length: "medium",
  // A recorded route (from a live session or a shared link) that stands in
  // for start and end: [{ point: [lat, lng], res, birds }].
  path: null,
  pathShared: false, // whether the path may be written into the address bar
  pathTitle: "Recorded trip",
  perStop: 3, // 3: birds in turn; 1: all together
  pace: "steady",
  route: null,
  routePending: false, // a road route has been asked for and isn't back yet
  cueStop: 0,
  playing: null, // null | "route" | "spot" | "live"
  finished: false,
};

const aviary = new Aviary();
const player = new Player(aviary);
let map;
let mapParts; // where pins and popups come from: the map library, or nothing()
let theme = document.documentElement.dataset.theme;
let routeRequest = 0;
let routeAbort = null;
let song = null;
let spot = null; // { popup, birds } for the last clicked point
let live = null; // { session, recorder, started, fix } while a live session runs
let lastRecording = null; // { blob, birds } from the last live session
const objectUrls = [];
const markers = { start: null, end: null, playhead: null };
const places = {
  start: { input: $("start-input"), status: $("start-status"), candidates: $("start-candidates"), form: $("start-form"), lastQuery: "", searching: null, abort: null },
  end: { input: $("end-input"), status: $("end-status"), candidates: $("end-candidates"), form: $("end-form"), lastQuery: "", searching: null, abort: null },
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function formatKm(km) {
  if (km >= 100) return `${Math.round(km).toLocaleString()} km`;
  if (km >= 1) return `${km.toFixed(1)} km`;
  if (km >= 0.001 || km === 0) return `${Math.round(km * 1000)} m`;
  return `${Math.round(km * 100000)} cm`;
}

function formatClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function formatSize(bytes) {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

let toastTimer;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 7000);
}

function remember(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* private mode */ }
}

function recall(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (error) { return null; }
}

function objectUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}

function grid() {
  return GRIDS[state.grid];
}

function pace() {
  return PACES[state.pace].seconds;
}

function songTitle() {
  if (state.path) return state.pathTitle;
  return `${state.start.label} → ${state.end.label}`;
}

// ---------------------------------------------------------------------------
// Shareable state in the URL hash
// ---------------------------------------------------------------------------

// Safari refuses more than ~100 history updates in 30 seconds, so writes
// are collected.
let hashTimer;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(flushHash, 300);
}

function flushHash() {
  clearTimeout(hashTimer);
  // A travelled route only goes into the address once its owner has chosen
  // to share it (or it arrived in a link in the first place).
  const hash = encodeState(state, state.pathShared);
  try {
    history.replaceState(null, "", `${location.pathname}${location.search}${hash ? `#${hash}` : ""}`);
  } catch (error) {
    // The link just goes a little stale; nothing else depends on it.
  }
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

function pinElement(letter, which) {
  const el = document.createElement("div");
  el.className = `marker-pin ${letter.toLowerCase()}`;
  el.title = `${which === "start" ? "Start" : "End"} (drag to move)`;
  el.setAttribute("aria-label", `${which === "start" ? "Start" : "End"} pin. Drag to move, or edit the ${which} field.`);
  el.innerHTML = `<svg viewBox="0 0 30 38" aria-hidden="true"><path d="M15 37C8 27 2 21 2 14a13 13 0 0 1 26 0c0 7-6 13-13 23z" stroke="#0d0d0f" stroke-width="1.5"/><text x="15" y="19" text-anchor="middle">${letter}</text></svg>`;
  return el;
}

function playheadElement() {
  const el = document.createElement("div");
  el.className = "playhead";
  el.innerHTML = `<svg class="pick" viewBox="0 0 26 26" aria-hidden="true"><path d="M13 24C7 18.5 2.5 13 2.5 8.5a10.5 6.5 0 0 1 21 0C23.5 13 19 18.5 13 24z"/></svg>`;
  return el;
}

// Web Mercator stops short of the poles; pins beyond that sit on the edge.
function clampToMap(lat) {
  return Math.max(-85, Math.min(85, lat));
}

// Stands in for the map, and for the pins and popups that go on it, when
// the browser can't draw one: any property of it is itself, any call
// returns itself, and read as a number it is 0. So `map.flyTo(...)` and
// `new mapParts.Marker(...).setLngLat(...).addTo(map)` simply do nothing.
function nothing() {
  const self = new Proxy(function () {}, {
    get: (target, key) => (key === Symbol.toPrimitive ? () => 0 : key === "then" ? undefined : self),
    set: () => true,
    apply: () => self,
    construct: () => self,
  });
  return self;
}

function initMap() {
  const only = state.start && state.end ? null : state.start || state.end;
  const view = only
    ? { center: [only.lng, clampToMap(only.lat)], zoom: 10 }
    : { center: [-98, 40], zoom: 2.6 };
  try {
    // ?nomap shows the page as it is for a browser that can't draw the map.
    if (new URLSearchParams(location.search).has("nomap")) throw new Error("Map switched off by ?nomap");
    map = new maplibregl.Map({
      container: "map",
      style: BASEMAPS[theme],
      ...view,
      maxZoom: 22,
      attributionControl: { compact: true },
    });
    mapParts = maplibregl;
  } catch (error) {
    // The map needs WebGL, which a browser may have switched off or may
    // refuse to use with the machine's graphics driver. Trips, sound,
    // sharing and downloads don't need the map, so carry on without it.
    console.warn("No map:", error.message);
    map = mapParts = nothing();
    $("map").replaceChildren();
    document.body.classList.add("no-map");
    $("map-missing").hidden = false;
    return;
  }
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  const locate = new maplibregl.GeolocateControl({ fitBoundsOptions: { maxZoom: 14 } });
  locate.on("geolocate", (fix) => {
    if (!live) openSpot(fix.coords.latitude, fix.coords.longitude, false);
  });
  map.addControl(locate, "top-right");
  map.touchZoomRotate.disableRotation();
  map.dragRotate.disable();
  map.keyboard.disableRotation();

  map.on("style.load", addRouteLayers);
  map.on("click", (event) => {
    hideArrival();
    // A live session owns the sound and the route; nothing to pin.
    if (!live) openSpot(event.lngLat.lat, wrapLng(event.lngLat.lng), true);
  });
  map.on("dragstart", (event) => {
    if (event.originalEvent && $("follow").checked) $("follow").checked = false;
  });
  map.on("error", (event) => console.warn("Map error:", event.error && event.error.message));
}

// (Re)creates the route layers; a theme switch replaces the whole style.
function addRouteLayers() {
  if (map.getSource("stops")) return;
  const colours = MAP_COLOURS[theme];
  // Above every road, building and border the basemap draws, below its
  // labels. (The two basemaps put their first label layer in different
  // places, so look for the last thing that isn't a label.)
  const layers = map.getStyle().layers;
  let top = layers.length - 1;
  while (top >= 0 && layers[top].type === "symbol") top--;
  const before = layers[top + 1] ? layers[top + 1].id : undefined;
  const empty = { type: "FeatureCollection", features: [] };

  map.addSource("stops", { type: "geojson", data: empty });
  map.addSource("track", { type: "geojson", data: empty });
  map.addSource("travelled", { type: "geojson", data: empty });
  map.addLayer({
    id: "stops-fill", type: "fill", source: "stops",
    paint: { "fill-color": colours.hex, "fill-opacity": theme === "dark" ? 0.1 : 0.07 },
  }, before);
  map.addLayer({
    id: "stops-played", type: "fill", source: "stops", filter: ["<", ["get", "i"], 0],
    paint: { "fill-color": colours.played, "fill-opacity": 0.34 },
  }, before);
  map.addLayer({
    id: "stops-current", type: "fill", source: "stops", filter: ["==", ["get", "i"], -1],
    paint: { "fill-color": colours.current, "fill-opacity": 0.7 },
  }, before);
  map.addLayer({
    id: "stops-outline", type: "line", source: "stops",
    paint: { "line-color": colours.hex, "line-width": 1.4, "line-opacity": 0.9 },
  }, before);
  map.addLayer({
    id: "stops-current-outline", type: "line", source: "stops", filter: ["==", ["get", "i"], -1],
    paint: { "line-color": colours.hex, "line-width": 2.5 },
  }, before);
  map.addLayer({
    id: "track-casing", type: "line", source: "track",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": colours.casing, "line-width": 6, "line-opacity": 0.6 },
  }, before);
  map.addLayer({
    id: "track-line", type: "line", source: "track",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": colours.track, "line-width": 3 },
  }, before);
  map.addLayer({
    id: "travelled-line", type: "line", source: "travelled",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": colours.played, "line-width": 3.5 },
  }, before);
  drawRoute();
}

function lineFeature(coordinates) {
  return coordinates.length > 1
    ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } }
    : { type: "FeatureCollection", features: [] };
}

function drawRoute() {
  if (!map.getSource("stops")) return;
  const route = state.route;
  map.getSource("stops").setData(route ? stopsToGeoJSON(route) : { type: "FeatureCollection", features: [] });
  map.getSource("track").setData(lineFeature(route ? route.track : []));
  shownStop = null;
  shownKm = null;
  renderPlayhead();
}

function setMarker(which) {
  const place = state[which];
  if (!place) {
    if (markers[which]) markers[which].remove();
    markers[which] = null;
    return;
  }
  if (!markers[which]) {
    const marker = new mapParts.Marker({
      element: pinElement(which === "start" ? "A" : "B", which),
      anchor: "bottom",
      draggable: true,
    });
    marker.on("dragend", () => {
      const at = marker.getLngLat();
      const lat = Math.max(-90, Math.min(90, at.lat));
      setPlace(which, { lat, lng: wrapLng(at.lng), label: formatLatLng(lat, wrapLng(at.lng)) }, { move: false });
    });
    // A click on a pin shouldn't also open the spot popup underneath it.
    marker.getElement().addEventListener("click", (event) => event.stopPropagation());
    markers[which] = marker;
  }
  markers[which].setLngLat([place.lng, clampToMap(place.lat)]).addTo(map);
}

function fitRoute(animate = true) {
  const route = state.route;
  if (!route || document.body.classList.contains("no-map")) return;
  const bounds = new maplibregl.LngLatBounds();
  for (const point of route.track) bounds.extend(point);
  for (const cell of stopsToGeoJSON(route).features) {
    for (const vertex of cell.geometry.coordinates[0]) bounds.extend(vertex);
  }
  const stage = $("stage").getBoundingClientRect();
  const deck = $("deck").getBoundingClientRect();
  // On wide screens the deck floats over the bottom of the map.
  const overlap = Math.max(0, stage.bottom - deck.top);
  const side = Math.min(70, stage.width * 0.12);
  map.fitBounds(bounds, {
    padding: { top: 60, left: side, right: side, bottom: Math.min(stage.height * 0.5, overlap + 40) },
    maxZoom: 21,
    duration: animate ? 900 : 0,
  });
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

function setStatus(which, text, isError = false) {
  const el = places[which].status;
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function setPlace(which, place, { move = true } = {}) {
  const ui = places[which];
  if (ui.abort) ui.abort.abort();
  // Choosing a place starts a planned trip; a recorded one makes way.
  if (state.path) setLiveStatus("");
  state.path = null;
  state.pathShared = false;
  state[which] = place;
  ui.input.value = place ? place.label : "";
  ui.lastQuery = ui.input.value.trim();
  ui.candidates.replaceChildren();
  setStatus(which, "");
  setMarker(which);
  hideArrival();
  closeSpot();
  if (place && move && !(state.start && state.end)) {
    map.flyTo({ center: [place.lng, clampToMap(place.lat)], zoom: Math.max(map.getZoom(), 10), duration: 900 });
  }
  writeHash();
  rebuildRoute({ fit: move });
}

async function findPlace(which, force = false) {
  const ui = places[which];
  const text = ui.input.value.trim();
  // Enter fires both "change" and "submit"; one lookup is enough.
  if (text === ui.searching || (!force && text === ui.lastQuery)) return;
  ui.lastQuery = text;
  if (ui.abort) ui.abort.abort();
  ui.candidates.replaceChildren();
  if (!text) {
    if (state[which]) setPlace(which, null);
    setStatus(which, "");
    return;
  }
  const abort = new AbortController();
  ui.abort = abort;
  ui.searching = text;
  const button = ui.form.querySelector("button");
  button.disabled = true;
  setStatus(which, "Searching…");
  let results;
  try {
    results = await geocode(text, abort.signal);
  } catch (error) {
    if (abort.signal.aborted) return;
    ui.lastQuery = "";
    setStatus(which, error.message, true);
    return;
  } finally {
    if (ui.abort === abort) {
      button.disabled = false;
      ui.searching = null;
    }
  }
  if (abort.signal.aborted) return;
  if (!results.length) {
    setStatus(which, `No match for “${text}”. Try adding a state, province or country, or click the map.`, true);
    return;
  }
  setPlace(which, results[0]);
  showCandidates(which, results, results[0]);
}

// The other matches for a search, tucked away until asked for. Picking one
// keeps the list, so the first answer can be picked again.
function showCandidates(which, results, chosen, open = false) {
  const box = places[which].candidates;
  box.replaceChildren();
  const others = results.filter((result) => result !== chosen);
  if (!others.length) return;
  const details = document.createElement("details");
  details.open = open;
  const summary = document.createElement("summary");
  summary.textContent = `Not the right one? ${others.length} other ${others.length === 1 ? "match" : "matches"}`;
  details.append(summary);
  for (const other of others) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "candidate";
    button.textContent = other.detail;
    button.title = other.detail;
    button.addEventListener("click", () => {
      setPlace(which, other);
      showCandidates(which, results, other, true);
    });
    details.append(button);
  }
  box.append(details);
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

// The birds of each stop, taken at the centre of its hexagon. The range
// tiles the stops need are fetched first.
async function giveBirds(stops) {
  await prepareBirds(stops.map((stop) => stop.point));
  for (const stop of stops) {
    const found = birdsFor(stop.point[0], stop.point[1]);
    stop.birds = found ? found.birds : [];
    stop.local = found ? found.local : 0;
  }
}

async function pathRoute() {
  const route = buildPathRoute(grid(), state.path);
  // A recorded stop plays its cell's birds, taken at the centre, so they
  // don't depend on the exact point stored or shared.
  const fresh = route.stops.filter((stop, i) => !state.path[i].birds);
  await giveBirds(fresh);
  route.stops.forEach((stop, i) => {
    const entry = state.path[i];
    if (!entry.birds) {
      entry.birds = stop.birds;
      entry.local = stop.local;
    }
    stop.birds = entry.birds;
    stop.local = entry.local;
  });
  return route;
}

async function rebuildRoute({ fit = true } = {}) {
  const request = ++routeRequest;
  if (routeAbort) routeAbort.abort();
  stopPlayback();
  state.cueStop = 0;
  state.finished = false;
  // Nothing is playable until the new route exists; an old route left in
  // place could be played and then swapped out from under the song.
  state.route = null;
  state.routePending = false;

  if (state.path) {
    let route;
    try {
      route = await pathRoute();
    } catch (error) {
      console.warn(error);
      if (request !== routeRequest) return;
      toast("The bird lists for this route didn’t load. Check your connection and try again.");
      renderRoute();
      return;
    }
    if (request !== routeRequest) return;
    state.route = route;
  } else if (state.start && state.end) {
    const a = [state.start.lat, state.start.lng];
    const b = [state.end.lat, state.end.lng];
    const maxStops = LENGTHS[state.length].stops;
    let route;
    let note = "";
    if (state.mode === "road") {
      routeAbort = new AbortController();
      state.routePending = true;
      drawRoute();
      renderRoute();
      try {
        route = await buildRoadRoute(grid(), a, b, maxStops, routeAbort.signal);
      } catch (error) {
        if (request !== routeRequest) return;
        if (!(error instanceof RoutingError)) console.warn(error);
        const why = error instanceof RoutingError ? error.message : "road routing failed";
        note = `Couldn’t follow roads: ${why}. Walked the hexagons instead.`;
      }
      if (request !== routeRequest) return;
    }
    if (!route) route = buildWalkRoute(grid(), a, b, maxStops);
    state.routePending = true;
    renderRoute();
    try {
      await giveBirds(route.stops);
    } catch (error) {
      console.warn(error);
      if (request !== routeRequest) return;
      state.routePending = false;
      renderRoute();
      toast("The bird lists for this trip didn’t load. Check your connection and try again.");
      return;
    }
    if (request !== routeRequest) return;
    state.routePending = false;
    route.note = note;
    state.route = route;
  }
  drawRoute();
  renderRoute();
  if (fit) fitRoute();
}

function renderRoute() {
  const route = state.route;
  const summary = $("route-summary");
  // During a live session there is nothing to play until a position arrives.
  $("play").disabled = live ? !live.started : !route;
  $("play").title = live && !live.started ? "Waiting for your location" : "";
  $("stop").disabled = !route && !live;
  for (const id of ["share", "download"]) {
    $(id).disabled = !route || Boolean(live);
    $(id).title = live ? "Available when the live session ends" : $(id).getAttribute("aria-label");
  }
  // A recorded route keeps the stops it was travelled with.
  $("route-choices").disabled = Boolean(state.path);
  $("route-note").hidden = !state.path;
  summary.classList.toggle("busy", state.routePending);
  renderSummaries();
  if (!route) {
    summary.textContent = state.routePending ? (state.mode === "road" ? "Finding a road route…" : "Finding the birds…") : "";
    $("deck-title").textContent = live
      ? "Finding you…"
      : state.routePending
        ? "Finding the birds…"
        : state.start || state.end
          ? `Now add ${state.start ? "an end" : "a start"} to write a song.`
          : "Pick a start and an end to write a song.";
    $("deck-sub").textContent = "";
    $("chart").replaceChildren();
    $("now").replaceChildren();
    $("progress-bar").style.width = "0";
    return;
  }
  const count = `${route.stops.length} ${route.stops.length === 1 ? "stop" : "stops"}`;
  const notes = [];
  let facts;
  if (route.mode === "path") {
    facts = `${formatKm(route.distanceKm)} travelled`;
  } else {
    const distance = route.straightKm === 0
      ? "no distance at all"
      : route.mode === "road"
        ? `${formatKm(route.distanceKm)} by road`
        : `${formatKm(route.straightKm)} as the crow flies`;
    facts = `${distance} · hexagons about ${formatKm(route.grid.spacingKm(route.res))} across`;
    if (route.note) notes.push(route.note);
    if (route.mode === "road" && route.snapKm) {
      const far = Math.max(...route.snapKm);
      if (far > Math.max(1, route.distanceKm * 0.02)) {
        notes.push(`The nearest road is ${formatKm(far)} from ${route.snapKm[0] >= route.snapKm[1] ? "the start" : "the end"}; the line jumps straight to it.`);
      }
    }
    if (route.straightKm === 0) notes.push("Start and end are the same spot, so this is a very short song.");
  }
  const quiet = route.stops.filter((stop) => !stop.birds.length).length;
  if (quiet === route.stops.length) {
    notes.push("None of these stops has any birds: the area is the US, Canada and Mexico, on land and near the coast.");
  } else if (quiet) {
    notes.push(`${quiet} ${quiet === 1 ? "stop is" : "stops are"} outside the area or out at sea, and stay quiet.`);
  }
  summary.innerHTML = `<strong>${count}</strong> · ${escapeHTML(facts)}` +
    notes.map((text) => `<span class="note">${escapeHTML(text)}</span>`).join("");
  $("deck-title").textContent = live && !live.started ? "Finding you…" : songTitle();
  renderChart();
  renderSongInfo();
  renderPlayhead();
}

function renderChart() {
  const route = state.route;
  const items = route.stops.map((stop, i) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    const names = stop.birds.length
      ? stop.birds.map((bird, which) => `<span class="c" data-which="${which}">${escapeHTML(bird.name)}</span>`).join("")
      : '<span class="c quiet">no birds</span>';
    button.innerHTML = `<span class="n">${i + 1}</span>${names}`;
    button.setAttribute("aria-label", `Stop ${i + 1}: ${stop.birds.length ? stop.birds.map((bird) => bird.name).join(", ") : "no birds"}`);
    button.tabIndex = i === 0 ? 0 : -1;
    button.addEventListener("click", () => jumpToStop(i));
    li.append(button);
    return li;
  });
  $("chart").replaceChildren(...items);
  shownStop = null;
}

// The chart is one tab stop; arrow keys walk along it.
function onChartKey(event) {
  const step = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity }[event.key];
  if (!step) return;
  const buttons = [...$("chart").querySelectorAll("button")];
  const from = buttons.indexOf(document.activeElement);
  if (from < 0) return;
  event.preventDefault();
  const to = Math.max(0, Math.min(buttons.length - 1, from + step));
  buttons.forEach((button, i) => { button.tabIndex = i === to ? 0 : -1; });
  buttons[to].focus();
}

function totalBars() {
  return state.route.stops.length * state.perStop;
}

function renderSongInfo(position) {
  if (!state.route) return;
  const stops = state.route.stops.length;
  const count = `${stops} ${stops === 1 ? "stop" : "stops"}`;
  if (live) {
    const fix = live.fix;
    const gps = fix ? ` · ${paceName(fix.pace)} · GPS ±${Math.round(fix.accuracy)} m` : "";
    $("deck-sub").textContent = live.started
      ? `Live · ${count} · ${formatKm(state.route.distanceKm)}${gps}`
      : "Waiting for a location fix…";
    return;
  }
  const total = songSeconds(totalBars(), pace());
  if (position && state.playing === "route") {
    const elapsed = position.ending ? total : (position.bar + position.fraction) * pace();
    const stop = position.ending ? stops : position.info.stop + 1;
    $("deck-sub").textContent = `Stop ${stop}/${stops} · ${formatClock(elapsed)} / ${formatClock(total)}`;
  } else {
    const from = state.cueStop > 0 ? ` · starts at stop ${state.cueStop + 1}` : "";
    $("deck-sub").textContent = `${count} · about ${formatClock(total)}${from}`;
  }
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

function makeSong() {
  const stops = state.route.stops;
  return {
    per: state.perStop,
    get bars() { return stops.length * this.per; },
    barAt(bar) {
      const stop = Math.floor(bar / this.per);
      const birds = stops[stop].birds;
      if (this.per === 1) return { birds, stop, which: -1 };
      const which = bar % 3;
      return { birds: birds[which] ? [birds[which]] : [], stop, which };
    },
  };
}

function setPlayButton() {
  const playing = (state.playing === "route" || state.playing === "live") && player.state === "playing";
  $("play").classList.toggle("playing", playing);
  $("play").setAttribute("aria-label", playing ? "Pause" : "Play");
  $("stop").setAttribute("aria-label", live ? "End the live session" : "Stop and go back to the start");
}

async function startAudio(run) {
  const button = $("play");
  button.classList.add("busy");
  try {
    await run();
    return true;
  } catch (error) {
    console.warn(error);
    toast(error.message || "Audio couldn’t start in this browser.");
    stopPlayback();
    return false;
  } finally {
    button.classList.remove("busy");
  }
}

async function togglePlay() {
  hideArrival();
  if (live) {
    // During a live session the button only mutes and unmutes the birds.
    if (state.playing !== "live") return;
    if (player.state === "playing") player.pause();
    else await startAudio(() => player.resume());
    setPlayButton();
    return;
  }
  if (!state.route) return;
  if (state.playing === "route" && player.state === "playing") {
    player.pause();
  } else if (state.playing === "route" && player.state === "paused") {
    await startAudio(() => player.resume());
  } else {
    if (state.finished) {
      state.finished = false;
      state.cueStop = 0;
    }
    song = makeSong();
    state.playing = "route";
    const request = routeRequest;
    await startAudio(() => player.play(song, state.cueStop * song.per));
    // The route changed while the recordings were still loading.
    if (request !== routeRequest) stopPlayback();
  }
  setPlayButton();
}

function stopPlayback() {
  player.stop();
  state.playing = null;
  setPlayButton();
  highlightSpot(-1);
}

function stopAndRewind() {
  if (live) {
    endLive();
    return;
  }
  stopPlayback();
  state.cueStop = 0;
  state.finished = false;
  renderSongInfo();
  renderPlayhead();
}

function jumpToStop(index) {
  if (!state.route || live) return;
  state.finished = false;
  if (state.playing === "route" && player.state === "playing") {
    player.seek(index * song.per);
    return;
  }
  stopPlayback();
  state.cueStop = index;
  renderSongInfo();
  renderPlayhead();
}

player.onEnd = () => {
  const wasRoute = state.playing === "route";
  stopPlayback();
  if (wasRoute) {
    state.finished = true;
    state.cueStop = 0;
    renderSongInfo();
    renderPlayhead();
  }
};

// ---------------------------------------------------------------------------
// Playhead rendering
// ---------------------------------------------------------------------------

let shownStop = null; // "stop:which" currently painted in the chart and cards
let shownKm = null; // how far the travelled line has been drawn
let shownBar = null;

function placePlayhead(lat, lng, visible) {
  if (!markers.playhead) markers.playhead = new mapParts.Marker({ element: playheadElement(), anchor: "center" });
  markers.playhead.setLngLat([lng, clampToMap(lat)]).addTo(map);
  const el = markers.playhead.getElement();
  el.style.visibility = visible ? "" : "hidden";
  el.classList.toggle("live", Boolean(live));
}

function drawTravelled(route, km) {
  // Redrawing the travelled line is the one costly step, so only do it
  // once the playhead has visibly moved on.
  const moved = shownKm === null || Math.abs(km - shownKm) >= route.distanceKm / 1500;
  if ((moved || km === 0 || km === route.distanceKm) && km !== shownKm && map.getSource("travelled")) {
    map.getSource("travelled").setData(lineFeature(trackUpTo(route, km)));
    shownKm = km;
  }
}

// Marks which stop and bird are up: cells on the map, the bird cards and
// the chart. `which` is the bird singing, or -1 for all three together.
function showStop(route, stop, which, played, sounding) {
  const key = `${stop}:${which}:${played}:${sounding}:${route.stops.length}:${state.perStop}`;
  if (key === shownStop) return;
  shownStop = key;
  const stops = route.stops;
  const current = played > stops.length - 1 ? -1 : stop;
  if (map.getLayer("stops-played")) {
    map.setFilter("stops-played", ["<", ["get", "i"], played]);
    map.setFilter("stops-current", ["==", ["get", "i"], current]);
    map.setFilter("stops-current-outline", ["==", ["get", "i"], current]);
  }
  renderNow(stops[stop], which, sounding);
  const items = $("chart").children;
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle("played", i < played);
    items[i].classList.toggle("current", i === current);
    for (const span of items[i].querySelectorAll(".c")) {
      span.classList.toggle("on", i === current && sounding && (which === -1 || Number(span.dataset.which) === which));
    }
  }
  const item = items[stop];
  if (item && sounding) {
    const chart = $("chart");
    const target = item.offsetLeft - chart.offsetLeft - chart.clientWidth / 2 + item.offsetWidth / 2;
    chart.scrollTo({ left: target, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
}

// Paints everything that depends on where the song is: marker, cells,
// progress line, bird cards and chart. With no position, shows the cue.
function renderPlayhead(position) {
  const route = state.route;
  if (!route) {
    if (markers.playhead) markers.playhead.remove();
    return;
  }
  if (live) {
    // Until the first fix, the old trip is still on screen; leave it be.
    if (live.started) renderLive(position);
    return;
  }
  const stops = route.stops;
  const last = stops.length - 1;
  let stop;
  let which;
  let km;
  let played; // stops fully behind us
  if (position && !position.ending) {
    stop = position.info.stop;
    which = position.info.which;
    if (!stops[stop]) return;
    const per = song.per;
    const into = per === 3 ? ((position.bar % 3) + position.fraction) / 3 : position.fraction;
    const next = stops[Math.min(last, stop + 1)].trackKm;
    km = stops[stop].trackKm + (next - stops[stop].trackKm) * into;
    played = stop;
  } else if (position || state.finished) {
    stop = last;
    which = state.perStop === 3 ? 0 : -1;
    km = route.distanceKm;
    played = stops.length;
  } else {
    stop = Math.min(last, state.cueStop);
    which = state.perStop === 3 ? 0 : -1;
    km = stops[stop].trackKm;
    played = stop;
  }

  const at = pointAt(route, km);
  // Parked on the start or end it would only hide the pin.
  placePlayhead(at[0], at[1], Boolean(position) || (km > 0 && km < route.distanceKm));
  if (position && $("follow").checked) map.jumpTo({ center: [at[1], at[0]] });
  drawTravelled(route, km);
  const total = position && !position.ending ? (position.bar + position.fraction) / song.bars : played / stops.length;
  $("progress-bar").style.width = `${Math.min(100, total * 100).toFixed(2)}%`;
  showStop(route, stop, which, played, Boolean(position) && !position.ending);
}

// A live session has no end to move towards: the marker is wherever the
// device is, and the newest stop is the one being played.
function renderLive(position) {
  const route = state.route;
  const stop = route.stops.length - 1;
  const fix = live.fix;
  if (fix) placePlayhead(fix.point[0], fix.point[1], true);
  drawTravelled(route, route.distanceKm);
  $("progress-bar").style.width = "0";
  const sounding = Boolean(position) && player.state === "playing";
  showStop(route, stop, position ? position.info.which : 0, stop, sounding);
}

// ---------------------------------------------------------------------------
// Birds on screen
// ---------------------------------------------------------------------------

function birdCard(bird, className = "") {
  const photo = bird.photo
    ? `<img src="${escapeHTML(bird.photo)}" alt="" loading="lazy" decoding="async">`
    : '<span class="no-photo" aria-hidden="true"></span>';
  return `<button type="button" class="bird-card ${className}" data-bird="${bird.index}" aria-label="${escapeHTML(bird.name)}: who recorded it, and on what terms">${photo}<span class="name">${escapeHTML(bird.name)}</span></button>`;
}

// The three birds of the stop under the playhead.
function renderNow(stop, which, sounding) {
  if (!stop.birds.length) {
    $("now").innerHTML = `<p class="now-quiet">${escapeHTML(QUIET)}</p>`;
    return;
  }
  $("now").innerHTML = stop.birds.map((bird, i) => {
    const on = sounding && (which === -1 || i === which);
    return birdCard(bird, on ? "on" : "");
  }).join("");
}

// Who recorded a bird and took its picture, and on what terms. Opens when
// a bird card is selected; the sonogram is only fetched then.
function openBird(index) {
  const bird = catalogueInfo().birds[index];
  if (!bird) return;
  const rec = bird.rec;
  $("bird-title").textContent = bird.name;
  $("bird-sci").textContent = bird.sci;
  $("bird-photo").src = bird.photo || "";
  $("bird-photo").hidden = !bird.photo;
  const rows = [
    ["Recording", `<a href="https://xeno-canto.org/${encodeURIComponent(rec.xc)}" target="_blank" rel="noopener">XC${escapeHTML(rec.xc)}</a> by ${escapeHTML(rec.by || "unknown")}${rec.where ? `, recorded in ${escapeHTML(rec.where)}` : ""}${rec.type ? ` (${escapeHTML(rec.type)})` : ""}`],
    ["Licence", `<a href="${escapeHTML(rec.licUrl || licenceUrl(rec.lic))}" target="_blank" rel="noopener">${escapeHTML(licenceName(rec.lic))}</a>. Cut to a few seconds and re-encoded here.`],
  ];
  if (bird.photo) {
    rows.push(["Photo", `${escapeHTML(bird.photoBy || "")}${bird.inat ? ` · <a href="${escapeHTML(bird.inat)}" target="_blank" rel="noopener">iNaturalist</a>` : ""}`]);
  }
  $("bird-credits").innerHTML = rows.map(([term, text]) => `<dt>${term}</dt><dd>${text}</dd>`).join("");
  $("bird-sono-figure").hidden = !rec.sono;
  $("bird-sono").src = rec.sono || "";
  $("bird-dialog").showModal();
}

// ---------------------------------------------------------------------------
// Clicking the map: hear one spot
// ---------------------------------------------------------------------------

// Closes the spot popup, or forgets one still waiting for its birds.
function closeSpot() {
  if (!spot) return;
  if (spot.popup) spot.popup.remove();
  spot = null;
}

function highlightSpot(which) {
  if (!spot) return;
  const element = spot.popup && spot.popup.getElement();
  const cards = element ? element.querySelectorAll(".bird-card") : [];
  cards.forEach((card, i) => card.classList.toggle("on", which === -1 ? false : which === 3 || i === which));
}

async function playSpot() {
  if (!spot || live || !spot.birds.length) return;
  // Hearing a spot interrupts the song; remember the stop so Play picks
  // it up again from there.
  const position = state.playing === "route" ? player.position() : null;
  stopPlayback();
  if (position && !position.ending) state.cueStop = position.info.stop;
  renderSongInfo();
  renderPlayhead();
  const birds = spot.birds;
  const together = state.perStop === 1;
  state.playing = "spot";
  await startAudio(() => player.play({
    bars: together ? 1 : 3,
    barAt: (bar) => (together ? { birds, which: 3 } : { birds: [birds[bar]], which: bar }),
  }));
}

async function openSpot(lat, lng, autoplay) {
  closeSpot();
  const content = document.createElement("div");
  content.className = "spot";
  const opened = { popup: null, birds: [] };
  spot = opened;
  let found = null;
  try {
    await prepareBirds([[lat, lng]]);
    found = birdsFor(lat, lng);
  } catch (error) {
    console.warn(error);
  }
  if (spot !== opened) return;
  opened.birds = found ? found.birds : [];
  content.innerHTML = `
    <p class="spot-title">${escapeHTML(formatLatLng(lat, lng))}${found ? ` · three of the ${found.local} birds expected here` : ""}</p>
    ${found
      ? `<div class="spot-birds">${found.birds.map((bird) => birdCard(bird)).join("")}</div>`
      : `<p class="spot-quiet">${escapeHTML(QUIET)}</p>`}
    <div class="spot-actions">
      ${found ? '<button type="button" class="button" data-action="hear">▶ Hear it</button>' : ""}
      <button type="button" class="button quiet" data-action="start">Start here</button>
      <button type="button" class="button quiet" data-action="end">End here</button>
    </div>`;
  content.addEventListener("click", (event) => {
    const card = event.target.closest(".bird-card");
    if (card) {
      openBird(Number(card.dataset.bird));
      return;
    }
    const action = event.target.closest("button") && event.target.closest("button").dataset.action;
    if (action === "hear") playSpot();
    else if (action) setPlace(action, { lat, lng, label: formatLatLng(lat, lng) }, { move: false });
  });
  opened.popup = new mapParts.Popup({ offset: 10, focusAfterOpen: false, maxWidth: "340px" })
    .setLngLat([lng, lat])
    .setDOMContent(content)
    .addTo(map);
  opened.popup.on("close", () => {
    if (spot !== opened) return;
    if (state.playing === "spot") stopPlayback();
    spot = null;
  });
  // Don't talk over a song that's already going.
  if (autoplay && !state.playing && found) playSpot();
}

// ---------------------------------------------------------------------------
// Live session: the song follows the device
// ---------------------------------------------------------------------------

function setLiveStatus(text, isError = false) {
  $("live-status").textContent = text;
  $("live-status").classList.toggle("error", isError);
}

function renderLiveControls() {
  const on = Boolean(live);
  $("live-label").textContent = on ? "End session" : "Go live";
  $("live-toggle").classList.toggle("on", on);
  $("live-pitch").hidden = on;
  $("live-note").hidden = !on;
  $("trip-fields").disabled = on;
  $("trip").classList.toggle("is-live", on);
  setPlayButton();
}

function startLive() {
  const problem = liveSupport();
  if (problem) {
    setLiveStatus(problem, true);
    return;
  }
  stopPlayback();
  hideArrival();
  closeSpot();
  // Unlock audio while this click still counts; the first bird has to wait
  // for a position.
  Tone.start();
  live = {
    session: new LiveSession(grid(), { onStop: onLiveStop, onFix: onLiveFix, onError: onLiveError }),
    recorder: null,
    started: false,
    fix: null,
  };
  setLiveStatus("Finding you…");
  $("live-download").hidden = true;
  lastRecording = null;
  renderLiveControls();
  renderRoute();
  live.session.start();
}

function onLiveError(message, fatal) {
  if (!live) return;
  if (fatal) {
    endLive();
    setLiveStatus(message, true);
  } else {
    setLiveStatus(message);
  }
}

function onLiveFix(fix) {
  if (!live) return;
  const first = !live.fix;
  live.fix = fix;
  if (first || $("follow").checked) {
    // Close enough to see a few cells around you.
    const metresPerPixel = (grid().spacingKm(fix.res) * 1000) / 110;
    const zoom = Math.log2((78271.5 * Math.cos((fix.point[0] * Math.PI) / 180)) / metresPerPixel);
    map.easeTo({ center: [fix.point[1], fix.point[0]], zoom: first ? Math.min(19, zoom) : map.getZoom(), duration: 600 });
  }
  if (first) $("follow").checked = true;
  renderSongInfo();
  if (player.state !== "playing") renderPlayhead();
}

async function onLiveStop(stop) {
  if (!live) return;
  const session = live;
  const entry = { point: stop.point, res: stop.res };
  if (session.started) {
    state.path.push(entry);
  } else {
    // The trip that was on screen gives way to the one being travelled.
    session.started = true;
    routeRequest++;
    if (routeAbort) routeAbort.abort();
    for (const which of ["start", "end"]) {
      state[which] = null;
      places[which].input.value = "";
      places[which].lastQuery = "";
      places[which].candidates.replaceChildren();
      setStatus(which, "");
      setMarker(which);
    }
    state.path = [entry];
    state.pathShared = false;
    state.pathTitle = "Live session";
    state.routePending = false;
    state.cueStop = 0;
    state.finished = false;
    setLiveStatus("");
    writeHash();
  }
  let route;
  try {
    route = await pathRoute();
  } catch (error) {
    console.warn(error);
    setLiveStatus("The birds for this spot didn’t load; trying again at the next one.");
    return;
  }
  if (live !== session) return;
  state.route = route;
  drawRoute();
  renderRoute();
  if (!session.sounding) {
    session.sounding = true;
    beginLiveSound();
  }
}

async function beginLiveSound() {
  const session = live;
  state.playing = "live";
  const started = await startAudio(() => player.play({
    bars: Infinity,
    // Always the newest stop; its birds go round until there's a newer one.
    barAt: (bar) => {
      const stops = state.route.stops;
      const birds = stops[stops.length - 1].birds;
      if (state.perStop === 1) return { birds, stop: stops.length - 1, which: -1 };
      const which = bar % 3;
      return { birds: birds[which] ? [birds[which]] : [], stop: stops.length - 1, which };
    },
  }));
  if (live !== session) {
    // Ended while the recordings were loading.
    if (started && !live) stopPlayback();
    return;
  }
  if (!started) {
    state.playing = "live";
    setLiveStatus("The sound didn’t start. Tap play to try again.", true);
  } else if (LiveRecorder.supported) {
    try {
      session.recorder = new LiveRecorder(aviary);
      session.recorder.start();
    } catch (error) {
      session.recorder = null;
    }
  }
  setPlayButton();
}

async function endLive() {
  const session = live;
  if (!session) return;
  live = null;
  session.session.stop();
  stopPlayback();
  renderLiveControls();
  $("follow").checked = false;
  if (!session.started) {
    setLiveStatus("");
    renderRoute();
    return;
  }
  const stops = state.path.length;
  setLiveStatus(`Recorded ${stops} ${stops === 1 ? "stop" : "stops"}. Replay it, change the sound, or share it. It isn’t kept if you close this page.`);
  renderRoute();
  fitRoute();
  if (session.recorder) {
    try {
      const blob = await session.recorder.stop();
      if (blob.size > 0) {
        lastRecording = { blob, birds: uniqueBirds(state.route.stops.flatMap((stop) => stop.birds)) };
        $("live-download").textContent = `Download what you heard (${formatSize(blob.size)})`;
        $("live-download").hidden = false;
      }
    } catch (error) {
      console.warn(error);
    }
  }
}

// ---------------------------------------------------------------------------
// Sharing and downloading
// ---------------------------------------------------------------------------

async function share() {
  if (!state.route || live) return;
  if (state.path && !state.pathShared) {
    // A travelled route says where someone has been; ask first.
    $("share-title").textContent = "Share this route?";
    $("share-text").textContent = "The link will draw the route you travelled, hexagon by hexagon, including where you started and stopped. Anyone who has the link can see it.";
    $("share-link").hidden = true;
    $("share-confirm").hidden = false;
    $("share-cancel").textContent = "Cancel";
    $("share-dialog").showModal();
    return;
  }
  flushHash();
  const url = location.href;
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    try {
      await navigator.share({ title: "what3birdsongs", text: songTitle(), url });
    } catch (error) {
      // Dismissing the share sheet isn't a failure.
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied. It opens this trip with this sound.");
  } catch (error) {
    // No clipboard access (an insecure page, or permission refused): show
    // the link to copy by hand.
    $("share-title").textContent = "Copy this link";
    $("share-text").textContent = "It opens this trip with this sound.";
    $("share-link").value = url;
    $("share-link").hidden = false;
    $("share-confirm").hidden = true;
    $("share-cancel").textContent = "Done";
    $("share-dialog").showModal();
    $("share-link").select();
  }
}

// "Boston → New York" -> "boston-to-new-york"
function fileStem(title) {
  return title.toLowerCase().replace(/→/g, "to").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "song";
}

function uniqueBirds(birds) {
  return [...new Map(birds.map((bird) => [bird.index, bird])).values()];
}

// The birds a song actually plays, in order of first appearance.
function songBirds(song) {
  const birds = [];
  for (let bar = 0; bar < song.bars; bar++) birds.push(...song.barAt(bar).birds);
  return uniqueBirds(birds);
}

// A plain-text list of everyone whose work is in the file.
function creditsText(title, birds, licence) {
  const lines = [
    title,
    "",
    "Made with what3birdsongs (https://jethatch.github.io/what3birdsongs/).",
    `This recording mixes the bird recordings below, each cut to a few seconds and re-encoded. Taken together, their licences allow it to be shared under ${licence}, with every recordist credited as below.`,
    "",
    "Recordings, from xeno-canto (https://xeno-canto.org/):",
  ];
  for (const bird of birds) {
    const rec = bird.rec;
    lines.push(`- ${bird.name} (${bird.sci}): XC${rec.xc} by ${rec.by || "unknown"}, ${licenceName(rec.lic)}, https://xeno-canto.org/${rec.xc}`);
  }
  lines.push("", "Which birds a place gets comes from iNaturalist's open range maps (CC BY 4.0).");
  return lines.join("\n") + "\n";
}

// Offers a finished file and its credits, or says why it can't be offered.
function offerFile(title, blob, extension, birds) {
  const check = combine(birds.map((bird) => bird.rec.lic));
  const links = $("download-links");
  links.replaceChildren();
  if (!check.ok) {
    $("download-title").textContent = "Not available for download";
    $("download-text").textContent = `This song can’t be downloaded: ${check.why}. You can still play it here and share its link.`;
    $("download-dialog").showModal();
    return;
  }
  const stem = fileStem(title);
  const credits = new Blob([creditsText(title, birds, check.licence)], { type: "text/plain" });
  for (const [label, file, name] of [
    [`Song (${formatSize(blob.size)})`, blob, `${stem}.${extension}`],
    ["Credits", credits, `${stem}-credits.txt`],
  ]) {
    const link = document.createElement("a");
    link.className = "button";
    link.href = objectUrl(file);
    link.download = name;
    link.textContent = label;
    links.append(link);
  }
  $("download-title").textContent = "Your song";
  $("download-text").textContent = `It mixes ${birds.length} ${birds.length === 1 ? "recording" : "recordings"}, so it is shared under ${check.licence}. Keep the credits with it: they name every recordist.`;
  $("download-dialog").showModal();
}

async function downloadSong() {
  if (!state.route || live) return;
  const button = $("download");
  if (button.classList.contains("busy")) return;
  const made = makeSong();
  const birds = songBirds(made);
  if (!birds.length) {
    toast("There are no birds on this trip to download.");
    return;
  }
  const check = combine(birds.map((bird) => bird.rec.lic));
  if (!check.ok) {
    offerFile(songTitle(), null, "wav", birds);
    return;
  }
  button.classList.add("busy");
  const title = songTitle();
  const progress = (fraction) => toast(`Rendering the song… ${Math.round(fraction * 100)}%`);
  progress(0);
  try {
    const blob = await renderSong(made, pace(), progress);
    $("toast").hidden = true;
    offerFile(title, blob, "wav", birds);
  } catch (error) {
    console.warn(error);
    toast(error.message || "The song couldn’t be rendered in this browser.");
  } finally {
    button.classList.remove("busy");
  }
}

function downloadRecording() {
  if (!lastRecording) return;
  const { blob, birds } = lastRecording;
  const extension = /mp4/.test(blob.type) ? "m4a" : /ogg/.test(blob.type) ? "ogg" : "webm";
  offerFile(`what3birdsongs live session ${new Date().toISOString().slice(0, 10)}`, blob, extension, birds);
}

// The prompt shown when the page was opened from a link to a song: browsers
// won't start sound without a click, so make the click obvious.
function showArrival() {
  if (!state.route) return;
  $("arrival-what").textContent = `${songTitle()} · ${state.perStop === 3 ? "birds in turn" : "all together"} · ${PACES[state.pace].name.toLowerCase()}`;
  $("arrival").hidden = false;
}

function hideArrival() {
  $("arrival").hidden = true;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function radioValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`).value;
}

// The one-line "what's selected" text on the collapsed route options.
function renderSummaries() {
  const walk = state.mode === "hex" ? "Hex walk" : "Roads";
  $("route-now").textContent = state.path ? "Recorded route" : `${walk} · ${LENGTHS[state.length].name}`;
}

function setPerStop(per) {
  const old = state.perStop;
  if (per === old) return;
  state.perStop = per;
  $("perstop-explain").textContent = PER_STOP_EXPLAIN[per];
  writeHash();
  if (!state.route) return;
  if (state.playing === "route") {
    // Finish the turn in progress, then carry on from the next stop
    // boundary counted the new way.
    const playing = song;
    player.onNextBarLine((bar) => {
      const stop = Math.ceil(bar / playing.per);
      playing.per = per;
      return stop * per;
    });
  }
  renderChart();
  if (state.playing !== "route") {
    renderSongInfo();
    renderPlayhead();
  }
}

function setPace(id) {
  state.pace = id;
  $("pace-explain").textContent = PACES[id].explain;
  player.setPace(pace());
  writeHash();
  if (state.playing !== "route") renderSongInfo();
}

function setTheme(next) {
  theme = next;
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("w3b-theme", next); } catch (error) { /* private mode */ }
  document.querySelector('meta[name="theme-color"]').content = next === "dark" ? "#0d0d0f" : "#f3efe5";
  map.setStyle(BASEMAPS[next]);
}

function bindControls() {
  for (const which of ["start", "end"]) {
    const ui = places[which];
    ui.form.addEventListener("submit", (event) => {
      event.preventDefault();
      const place = state[which];
      if (place && ui.input.value.trim() === place.label) {
        // Already found: "Find" just shows where it is.
        map.flyTo({ center: [place.lng, place.lat], zoom: Math.max(map.getZoom(), 10) });
      } else {
        findPlace(which, true);
      }
    });
    // Tabbing on to the next field without pressing Enter still counts.
    ui.input.addEventListener("change", () => findPlace(which));
  }
  $("swap").addEventListener("click", () => {
    if (!state.start && !state.end) return;
    const { start, end } = state;
    state.start = end;
    state.end = start;
    for (const which of ["start", "end"]) {
      const ui = places[which];
      // A lookup still in flight would land in the wrong field.
      if (ui.abort) ui.abort.abort();
      ui.input.value = state[which] ? state[which].label : "";
      ui.lastQuery = ui.input.value;
      ui.candidates.replaceChildren();
      setStatus(which, "");
      setMarker(which);
    }
    writeHash();
    rebuildRoute();
  });

  for (const input of document.querySelectorAll('input[name="mode"]')) {
    input.addEventListener("change", () => {
      state.mode = radioValue("mode");
      $("mode-explain").textContent = MODES[state.mode].explain;
      writeHash();
      rebuildRoute();
    });
  }
  for (const input of document.querySelectorAll('input[name="length"]')) {
    input.addEventListener("change", () => {
      state.length = radioValue("length");
      $("length-explain").textContent = LENGTHS[state.length].explain;
      writeHash();
      rebuildRoute();
    });
  }
  for (const input of document.querySelectorAll('input[name="perstop"]')) {
    input.addEventListener("change", () => setPerStop(Number(radioValue("perstop"))));
  }
  for (const input of document.querySelectorAll('input[name="pace"]')) {
    input.addEventListener("change", () => setPace(radioValue("pace")));
  }

  for (const id of SECTIONS) {
    $(id).addEventListener("toggle", () => remember("w3b-open", SECTIONS.filter((section) => $(section).open)));
  }

  $("example").addEventListener("click", () => {
    setPlace("start", { ...EXAMPLE.start });
    setPlace("end", { ...EXAMPLE.end });
  });
  $("live-toggle").addEventListener("click", () => (live ? endLive() : startLive()));
  $("live-download").addEventListener("click", downloadRecording);
  $("chart").addEventListener("keydown", onChartKey);
  $("now").addEventListener("click", (event) => {
    const card = event.target.closest(".bird-card");
    if (card) openBird(Number(card.dataset.bird));
  });
  // Our own updates use replaceState, which doesn't fire this; a hash that
  // changes any other way is a different link being opened.
  window.addEventListener("hashchange", () => location.reload());

  $("play").addEventListener("click", togglePlay);
  $("arrival-play").addEventListener("click", togglePlay);
  $("arrival-close").addEventListener("click", hideArrival);
  $("stop").addEventListener("click", stopAndRewind);
  $("share").addEventListener("click", share);
  $("download").addEventListener("click", downloadSong);
  $("share-cancel").addEventListener("click", () => $("share-dialog").close());
  $("share-confirm").addEventListener("click", () => {
    $("share-dialog").close();
    state.pathShared = true;
    share();
  });
  $("follow").addEventListener("change", () => {
    if (!$("follow").checked || !state.route) return;
    // Close enough that neighbouring stops are about 110 px apart.
    const at = markers.playhead ? markers.playhead.getLngLat() : map.getCenter();
    const metresPerPixel = (state.route.grid.spacingKm(state.route.res) * 1000) / 110;
    const zoom = Math.log2((78271.5 * Math.cos((at.lat * Math.PI) / 180)) / metresPerPixel);
    map.easeTo({ center: at, zoom: Math.max(1.5, Math.min(21, zoom)), duration: 600 });
  });
  $("theme-toggle").addEventListener("click", () => setTheme(theme === "dark" ? "light" : "dark"));
  $("about-open").addEventListener("click", () => $("about").showModal());
  $("what-open").addEventListener("click", () => $("what").showModal());
  for (const id of ["about", "what", "share-dialog", "bird-dialog", "download-dialog"]) {
    // A click on the backdrop closes the dialog. The backdrop reports the
    // dialog as its target, and so does the dialog's own padding, so go by
    // where the click landed.
    $(id).addEventListener("click", (event) => {
      if (event.target !== $(id)) return;
      const box = $(id).getBoundingClientRect();
      const inside = event.clientX >= box.left && event.clientX <= box.right &&
        event.clientY >= box.top && event.clientY <= box.bottom;
      if (!inside) $(id).close();
    });
  }

  // Phones suspend audio when the screen locks or a call comes in. Try to
  // pick it up again on return; if the browser wants a tap first, say so.
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || player.state !== "playing") return;
    if (Tone.getContext().state === "running") return;
    try {
      await Tone.start();
    } catch (error) {
      // Falls through to the check below.
    }
    if (Tone.getContext().state !== "running") {
      player.pause();
      setPlayButton();
      toast("The sound was paused while you were away. Press play to carry on.");
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target && target.closest("input, select, textarea, button, summary, a, dialog, [contenteditable]")) return;
    event.preventDefault();
    togglePlay();
  });
}

function syncControls() {
  document.querySelector(`input[name="mode"][value="${state.mode}"]`).checked = true;
  document.querySelector(`input[name="length"][value="${state.length}"]`).checked = true;
  document.querySelector(`input[name="perstop"][value="${state.perStop}"]`).checked = true;
  document.querySelector(`input[name="pace"][value="${state.pace}"]`).checked = true;
  $("mode-explain").textContent = MODES[state.mode].explain;
  $("length-explain").textContent = LENGTHS[state.length].explain;
  $("perstop-explain").textContent = PER_STOP_EXPLAIN[state.perStop];
  $("pace-explain").textContent = PACES[state.pace].explain;
  renderSummaries();
  for (const which of ["start", "end"]) {
    places[which].input.value = state[which] ? state[which].label : "";
    places[which].lastQuery = places[which].input.value;
  }
  for (const id of recall("w3b-open") || []) {
    if (SECTIONS.includes(id)) $(id).open = true;
  }
  const support = liveSupport();
  if (support) {
    $("live-toggle").disabled = true;
    $("live-pitch").textContent = support;
  }
}

function frame() {
  requestAnimationFrame(frame);
  if (!state.playing) return;
  const position = player.position();
  if (!position) return;
  if (state.playing === "spot") {
    highlightSpot(position.ending ? -1 : position.info.which);
    return;
  }
  renderPlayhead(position);
  if (state.playing === "route") renderSongInfo(position);
  // A small hop of the marker as each turn begins.
  const bar = position.ending ? null : position.bar;
  if (bar !== shownBar) {
    shownBar = bar;
    if (bar !== null && position.info.birds.length && markers.playhead) {
      const el = markers.playhead.getElement();
      el.classList.remove("hit");
      void el.offsetWidth;
      el.classList.add("hit");
    }
  }
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

async function main() {
  const missing = ["maplibregl", "h3", "Tone"].filter((name) => !(name in window));
  if (missing.length) throw new Error("Some of the page’s libraries didn’t load. Check your connection and reload.");
  const fromLink = decodeHash(location.hash);
  Object.assign(state, fromLink);
  // A route that arrived in a link is already out there.
  state.pathShared = Boolean(fromLink.path);
  syncControls();
  bindControls();
  const catalogue = await loadBirds("./data/birds.json");
  $("geomodel-version").textContent = `geomodel ${(catalogue.geomodel || []).join(", ")}`;
  player.setPace(pace());
  initMap();
  setMarker("start");
  setMarker("end");
  renderRoute();
  rebuildRoute({ fit: false }).then(() => {
    fitRoute(false);
    if (fromLink.path || (fromLink.start && fromLink.end)) showArrival();
  });
  requestAnimationFrame(frame);
  $("loading").classList.add("done");
  try { sessionStorage.removeItem("w3b-refreshed"); } catch (error) { /* private mode */ }
}

main().catch((error) => {
  console.error(error);
  $("loading").classList.add("failed");
  $("loading-text").textContent = error.message || "Something went wrong while loading.";
  const retry = document.createElement("button");
  retry.className = "button";
  retry.textContent = "Reload";
  retry.addEventListener("click", () => {
    // Drop the link's settings too, in case they are what broke.
    history.replaceState(null, "", location.pathname);
    location.reload();
  });
  $("loading-text").after(retry);
});
