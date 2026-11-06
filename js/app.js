import { parseSession } from './parse.js';
import {
  KIND_LABEL, MI, DEFAULT_OPTS, newStep, segments, totals, wodSchedule, sanitizeWorkout,
  fmtPace, fmtPaceRange, fmtDistance, fmtDuration, parseMMSS, paceFromUnit,
} from './model.js';
import { parseRouteFile, extendRoute, placeCues, pointTimes, cumulative } from './route.js';
import { buildGpx } from './gpx.js';
import { buildFitCourse, buildFitWorkout } from './fit.js';

const $ = (s, el = document) => el.querySelector(s);
const STORE_KEY = 'runna-wod:v1';

const SAMPLE = `Threshold 400s
Warm-up. 1.5km at conversational pace. No faster than 6:40/km.
Set. Repeat x6: 400m at 4:10/km
Rest. 90s walking rest
Cool down. 1km at a conversational pace.`;

const state = {
  workout: null,
  warnings: [],
  opts: { ...DEFAULT_OPTS },
  route: null, // { name, points }
  extend: 'auto',
  offset: 0,
};

// ---------------------------------------------------------------- persistence

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ workout: state.workout, opts: state.opts, paste: $('#paste').value }));
  } catch { /* storage unavailable */ }
}

function load() {
  // share link wins over local storage
  const m = location.hash.match(/[#&]w=([^&]+)/);
  if (m) {
    try {
      state.workout = sanitizeWorkout(JSON.parse(b64urlDecode(m[1])));
      return;
    } catch { toast('That share link could not be read.'); }
  }
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved) {
      if (saved.opts) Object.assign(state.opts, pickOpts(saved.opts));
      if (saved.paste) $('#paste').value = saved.paste;
      if (saved.workout) state.workout = sanitizeWorkout(saved.workout);
    }
  } catch { /* ignore */ }
}

function pickOpts(o) {
  const out = {};
  for (const k of ['tolerance', 'easyPace', 'walkPace']) if (Number.isFinite(+o[k]) && +o[k] >= 0) out[k] = +o[k];
  return out;
}

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// ---------------------------------------------------------------- helpers

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function slug(s) {
  return (String(s || 'workout').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workout').slice(0, 40);
}

function unit() { return state.workout?.unit || 'km'; }

/** tolerance is stored in the plan's unit (s per km or s per mile) */
function tolKm() { return paceFromUnit(state.opts.tolerance, unit()); }

function getItem(path) {
  let list = state.workout.steps, item = null;
  for (let i = 0; i < path.length; i++) {
    item = list[path[i]];
    if (i < path.length - 1) list = item.steps;
  }
  return { item, list, index: path[path.length - 1] };
}

function parsePaceInput(str) {
  const s = String(str).trim().replace(/\s*\/\s*(km|mi)$/i, '');
  if (!s) return null;
  const m = s.match(/^(\d{1,2}:\d{2})\s*(?:-|–|to)\s*(\d{1,2}:\d{2})$/);
  const u = unit();
  if (m) {
    const a = paceFromUnit(parseMMSS(m[1]), u), b = paceFromUnit(parseMMSS(m[2]), u);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
    return { fast: Math.min(a, b), slow: Math.max(a, b) };
  }
  const p = paceFromUnit(parseMMSS(s), u);
  if (!Number.isFinite(p)) return undefined;
  return { fast: p - tolKm(), slow: p + tolKm(), target: p };
}

function parseAmountInput(str, end) {
  const s = String(str).trim().toLowerCase();
  if (end === 'time') {
    let m = s.match(/^(\d{1,3}):(\d{2})$/);
    if (m) return +m[1] * 60 + +m[2];
    m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hrs?|hours?)?$/);
    if (!m) return NaN;
    const v = +m[1], u2 = m[2] || 's';
    return Math.round(u2.startsWith('h') ? v * 3600 : u2.startsWith('m') ? v * 60 : v);
  }
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(m|metres?|meters?|km|k|mi|miles?)?$/);
  if (!m) return NaN;
  const v = +m[1];
  let u2 = m[2];
  if (!u2) u2 = v >= 50 ? 'm' : unit() === 'mi' ? 'mi' : 'km';
  if (u2 === 'km' || u2 === 'k') return v * 1000;
  if (u2.startsWith('mi')) return Math.round(v * MI * 10) / 10;
  return v;
}

function amountInputValue(step) {
  if (step.end === 'distance') return fmtDistance(step.distance, unit()).replace(' ', '');
  if (step.end === 'time') return step.time < 60 || step.time % 60 ? fmtDuration(step.time).replace(' min', ':00') : `${step.time / 60} min`;
  return '';
}

function paceInputValue(step) {
  if (!step.pace) return '';
  const centred = step.pace.target != null && Math.abs((step.pace.fast + step.pace.slow) / 2 - step.pace.target) < 0.5;
  if (centred) return fmtPace(step.pace.target, unit());
  return fmtPaceRange(step.pace, unit(), false).replace('–', '-');
}

// ---------------------------------------------------------------- editor

function renderEditor() {
  const html = (items, path) => items.map((it, i) => {
    const p = [...path, i].join('.');
    if (it.type === 'repeat') {
      return `<div class="repeat" data-path="${p}">
        <div class="repeat-head">Repeat <input type="number" min="1" max="99" value="${it.count}" data-f="count" aria-label="Repeat count"> ×
          <span class="sp"></span>
          <button class="icon" data-act="add-child" title="Add step to block">+ step</button>
          ${tools()}
        </div>
        <div class="children">${html(it.steps, [...path, i])}</div>
      </div>`;
    }
    return `<div class="step k-${it.kind}" data-path="${p}">
      <div class="fields">
        <label>Type<select data-f="kind">${Object.entries(KIND_LABEL).map(([k, v]) => `<option value="${k}"${k === it.kind ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Ends after<span class="inline"><select data-f="end">
          <option value="distance"${it.end === 'distance' ? ' selected' : ''}>Distance</option>
          <option value="time"${it.end === 'time' ? ' selected' : ''}>Time</option>
          <option value="open"${it.end === 'open' ? ' selected' : ''}>Lap btn</option>
        </select></span></label>
        <label>${it.end === 'open' ? '&nbsp;' : it.end === 'time' ? 'Duration' : 'Distance'}<input data-f="amount" value="${esc(amountInputValue(it))}" ${it.end === 'open' ? 'disabled placeholder="—"' : ''} inputmode="text" autocomplete="off"></label>
        <label>Pace /${unit()}<input data-f="pace" value="${esc(paceInputValue(it))}" placeholder="${it.walk ? 'walk' : 'none'}" inputmode="text" autocomplete="off"></label>
      </div>
      <div class="tools">${tools()}</div>
      ${it.text ? `<div class="note" title="${esc(it.text)}">“${esc(it.text)}”</div>` : ''}
    </div>`;
  }).join('');
  const tools = () => `<span class="inline"><button class="icon" data-act="up" title="Move up" aria-label="Move up">↑</button><button class="icon" data-act="down" title="Move down" aria-label="Move down">↓</button><button class="icon" data-act="del" title="Delete" aria-label="Delete">✕</button></span>`;
  $('#editor').innerHTML = html(state.workout.steps, []);
}

function onEditorChange(e) {
  const el = e.target;
  const host = el.closest('[data-path]');
  if (!host || !el.dataset.f) return;
  const path = host.dataset.path.split('.').map(Number);
  const { item } = getItem(path);
  const f = el.dataset.f;
  if (f === 'count') item.count = Math.max(1, Math.min(99, parseInt(el.value, 10) || 1));
  else if (f === 'kind') item.kind = el.value;
  else if (f === 'end') {
    item.end = el.value;
    if (item.end === 'distance' && !item.distance) item.distance = 400;
    if (item.end === 'time' && !item.time) item.time = 60;
  } else if (f === 'amount') {
    const v = parseAmountInput(el.value, item.end);
    if (!Number.isFinite(v) || v <= 0) { toast(item.end === 'time' ? 'Use e.g. 90s, 2 min or 1:30' : 'Use e.g. 400m, 1.2km or 1mi'); }
    else if (item.end === 'time') item.time = v; else item.distance = v;
  } else if (f === 'pace') {
    const p = parsePaceInput(el.value);
    if (p === undefined) toast('Use a pace like 4:10 or a range like 4:05-4:15');
    else item.pace = p;
  }
  update();
}

function onEditorClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const host = btn.closest('[data-path]');
  const path = host.dataset.path.split('.').map(Number);
  const { item, list, index } = getItem(path);
  const act = btn.dataset.act;
  if (act === 'del') list.splice(index, 1);
  if (act === 'up' && index > 0) [list[index - 1], list[index]] = [list[index], list[index - 1]];
  if (act === 'down' && index < list.length - 1) [list[index + 1], list[index]] = [list[index], list[index + 1]];
  if (act === 'add-child') item.steps.push(newStep('work'));
  update();
}

// ---------------------------------------------------------------- summary + timeline

function renderSummary() {
  const w = state.workout;
  const segs = segments(w, state.opts);
  const t = totals(w, state.opts);
  const reps = segs.filter((s) => s.kind === 'work').length;
  $('#summary').innerHTML = `
    <span><b>${t.estimated ? '≈ ' : ''}${fmtDistance(t.distance, w.unit)}</b> total</span>
    <span><b>≈ ${fmtDuration(t.time)}</b> at target paces</span>
    <span><b>${segs.length}</b> steps · <b>${reps}</b> run${reps === 1 ? '' : 's'}</span>`;
  const H = { warmup: 45, work: 100, recovery: 25, cooldown: 45 };
  const total = segs.reduce((n, s) => n + s.duration, 0) || 1;
  $('#timeline').innerHTML = segs.map((s) => `<div class="k-${s.kind}" style="flex:${(s.duration / total).toFixed(5)};height:${H[s.kind]}%" title="${esc(s.label)}"></div>`).join('');
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.unit === w.unit)));
  $('#w-name').value = w.name;
  document.querySelectorAll('.u').forEach((u) => { u.textContent = `/${w.unit}`; });
  $('#opt-tol').value = state.opts.tolerance;
  $('#opt-easy').value = fmtPace(state.opts.easyPace, w.unit);
  $('#opt-walk').value = fmtPace(state.opts.walkPace, w.unit);
}

function renderWarnings() {
  const ul = $('#warnings');
  ul.hidden = !state.warnings.length;
  ul.innerHTML = state.warnings.map((w) => `<li>${esc(w)}</li>`).join('');
}

// ---------------------------------------------------------------- route

let map = null, mapLayer = null;

function routeProduct() {
  if (!state.route || !state.workout) return null;
  const segs = segments(state.workout, state.opts);
  const need = state.offset + totals(state.workout, state.opts).distance;
  const ext = extendRoute(state.route.points, need, state.extend);
  const cues = placeCues(ext, segs, state.offset);
  const times = pointTimes(ext, segs, state.offset, state.opts.easyPace);
  return { segs, ext, cues, times, need };
}

function renderRoute() {
  const has = !!state.route;
  $('#btn-clear-route').hidden = !has;
  $('#route-info').hidden = !has;
  $('#route-opts').hidden = !has;
  $('#map').hidden = !has;
  $('#cue-list').hidden = !has || !state.workout;
  document.getElementById('exp-course').classList.toggle('no-route', !has);
  document.querySelectorAll('#exp-course button').forEach((b) => { b.disabled = !has || !state.workout; });
  if (!has) return;

  const u = unit();
  const baseLen = cumulative(state.route.points).at(-1);
  const prod = state.workout ? routeProduct() : null;
  let info = `<span><b>${esc(state.route.name)}</b></span><span>${fmtDistance(baseLen, u)} route</span>`;
  if (prod) {
    const modeTxt = { loop: `repeated ×${prod.ext.laps} laps`, outback: `out-and-back ×${prod.ext.laps} legs`, 'as-is': 'long enough', none: 'not extended' }[prod.ext.mode] || prod.ext.mode;
    info += `<span>Workout needs ${fmtDistance(prod.need, u)} — ${modeTxt}</span><span><b>${prod.cues.length}</b> cues</span>`;
    if (prod.ext.short) info += `<span style="color:var(--warn-ink)">Route ends before the workout does — later cues are dropped.</span>`;
  }
  $('#route-info').innerHTML = info;
  $('#opt-extend').value = state.extend;
  $('#opt-offset').value = state.offset;

  if (prod) {
    $('#cue-list').innerHTML = prod.cues.map((c) => `<li class="k-${c.kind}"><span class="dot"></span><span class="d">${c.estimated ? '≈' : ''}${fmtDistance(c.distance, u)}</span><span>${esc(c.name)}</span></li>`).join('');
  }
  drawMap(prod ? prod.ext.points : state.route.points, prod ? prod.cues : []);
}

function drawMap(points, cues) {
  const L = window.L;
  const el = $('#map');
  if (!L) { el.innerHTML = '<p class="hint" style="padding:12px">Map unavailable offline — the route and cues still work.</p>'; return; }
  if (!map) {
    map = L.map(el, { zoomControl: true, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
  }
  if (mapLayer) mapLayer.remove();
  mapLayer = L.layerGroup().addTo(map);
  const line = L.polyline(points.map((p) => [p.lat, p.lon]), { color: '#f97316', weight: 4, opacity: 0.85 }).addTo(mapLayer);
  const seen = new Map();
  for (const c of cues) {
    // cues on repeated laps land on the same spot — group their labels
    const key = `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
    if (seen.has(key)) { seen.get(key).push(c.name); continue; }
    const names = [c.name];
    seen.set(key, names);
    const icon = L.divIcon({ className: '', html: `<div class="cue-pin k-${c.kind}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });
    L.marker([c.lat, c.lon], { icon, keyboard: false }).addTo(mapLayer).bindTooltip(() => names.map(esc).join('<br>'));
  }
  setTimeout(() => { map.invalidateSize(); map.fitBounds(line.getBounds(), { padding: [20, 20] }); }, 0);
}

async function onRouteFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    state.route = parseRouteFile(text, file.name);
    state.offset = 0;
    update();
    toast(`Loaded ${state.route.points.length} points`);
  } catch (err) {
    toast(err.message || 'Could not read that route file');
  }
}

// ---------------------------------------------------------------- schedule card

function scheduleItems() {
  return wodSchedule(state.workout.steps);
}

function stepEndText(s) {
  if (s.end === 'distance') return `Ends after ${fmtDistance(s.distance, unit())}`;
  if (s.end === 'time') return `Ends after ${fmtDuration(s.time)}`;
  return 'Ends on lap button';
}

function renderCard() {
  const u = unit();
  let n = 0;
  const li = (s) => {
    n++;
    const pace = s.pace
      ? `${fmtPaceRange(s.pace, u, false)}<small>pace /${u}</small>`
      : `<small>${s.walk ? 'walk' : 'no target'}</small>`;
    return `<li class="s k-${s.kind}"><span class="no">${n}</span><span><div class="what">${KIND_LABEL[s.kind]}</div><div class="sub">${stepEndText(s)}</div></span><span class="pace">${pace}</span></li>`;
  };
  const items = scheduleItems();
  const t = totals(state.workout, state.opts);
  const body = items.map((it) => (it.type === 'repeat'
    ? `<li class="r"><div class="rh">Repeat ×${it.count}</div><ol>${it.steps.map(li).join('')}</ol></li>`
    : li(it))).join('');
  $('#card').innerHTML = `<header><b>${esc(state.workout.name)}</b><span>${t.estimated ? '≈ ' : ''}${fmtDistance(t.distance, u)} · ≈ ${fmtDuration(t.time)} · WorkOutDoors → Settings → Interval Schedules</span></header><ol>${body}</ol>`;
}

function scheduleText() {
  const u = unit();
  const lines = [`${state.workout.name} — WorkOutDoors interval schedule`, ''];
  let n = 0;
  const one = (s, indent = '') => {
    n++;
    const pace = s.pace ? `pace ${fmtPaceRange(s.pace, u)}` : (s.walk ? 'walk' : 'no target');
    lines.push(`${indent}${n}. ${KIND_LABEL[s.kind]} — ${stepEndText(s).replace('Ends after ', '')} — ${pace}`);
  };
  for (const it of scheduleItems()) {
    if (it.type === 'repeat') {
      lines.push(`Repeat ×${it.count}:`);
      it.steps.forEach((s) => one(s, '   '));
    } else one(it);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- exports

function makeFile(kind) {
  const w = state.workout;
  const base = slug(w.name);
  if (kind === 'json') {
    return new File([JSON.stringify(w, null, 2)], `${base}.json`, { type: 'application/json' });
  }
  if (kind === 'fit-workout') {
    return new File([buildFitWorkout(w)], `${base}-workout.fit`, { type: 'application/vnd.ant.fit' });
  }
  const prod = routeProduct();
  if (!prod) throw new Error('Attach a route first');
  const name = `${w.name}`.slice(0, 31);
  const start = new Date();
  start.setSeconds(0, 0);
  if (kind === 'gpx') {
    const t = totals(w, state.opts);
    const gpx = buildGpx({
      name, points: prod.ext.points, cues: prod.cues, times: prod.times, startDate: start,
      desc: `${fmtDistance(t.distance, w.unit)} structured session from Runna. ${scheduleText().split('\n').slice(2).join(' | ')}`,
    });
    return new File([gpx], `${base}.gpx`, { type: 'application/gpx+xml' });
  }
  const fit = buildFitCourse({ name, points: prod.ext.points, cum: prod.ext.cum, times: prod.times, cues: prod.cues, startDate: start });
  return new File([fit], `${base}-course.fit`, { type: 'application/vnd.ant.fit' });
}

function download(kind) {
  try {
    const file = makeFile(kind);
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (err) { toast(err.message); }
}

async function share(kind) {
  try {
    const file = makeFile(kind);
    // iOS needs a generic type to offer "Open in…" apps for FIT
    const shareFile = new File([file], file.name, { type: 'application/octet-stream' });
    await navigator.share({ files: [shareFile], title: state.workout.name });
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message || 'Sharing failed — use Download instead');
  }
}

async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { prompt('Copy this:', text); }
}

function renderExport() {
  const has = !!state.workout;
  $('#export').hidden = !has;
  $('#export-empty').hidden = has;
  if (has && !$('#card').hidden) renderCard();
}

// ---------------------------------------------------------------- main update

function update() {
  const has = !!state.workout;
  $('#editor-wrap').hidden = !has;
  if (has) {
    renderEditor();
    renderSummary();
  }
  renderWarnings();
  renderRoute();
  renderExport();
  save();
}

function setUnit(u) {
  state.workout.unit = u;
  update();
}

function retarget(oldTolKm) {
  // re-centre any single-target paces on the new tolerance
  const walk = (items) => items.forEach((it) => {
    if (it.type === 'repeat') return walk(it.steps);
    const p = it.pace;
    if (p && p.target != null && Math.abs((p.fast + p.slow) / 2 - p.target) < 0.5 && Math.abs(p.slow - p.target - oldTolKm) < 0.5) {
      p.fast = p.target - tolKm();
      p.slow = p.target + tolKm();
    }
  });
  walk(state.workout.steps);
}

function init() {
  load();
  if (navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.gpx', { type: 'application/octet-stream' })] })) {
    document.body.classList.add('can-share');
  }

  $('#btn-parse').addEventListener('click', () => {
    const text = $('#paste').value;
    if (!text.trim()) { toast('Paste a session first'); return; }
    const w = parseSession(text, { tolerance: state.opts.tolerance });
    if (!w.steps.length) { toast('No steps found — check the text or add steps by hand'); }
    state.warnings = w.warnings;
    state.workout = { name: w.name, unit: w.unit, steps: w.steps };
    if (!w.steps.length) state.workout.steps.push(newStep('work'));
    update();
    $('#editor-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#btn-sample').addEventListener('click', () => { $('#paste').value = SAMPLE; $('#btn-parse').click(); });
  $('#file-json').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { state.workout = sanitizeWorkout(JSON.parse(await f.text())); state.warnings = []; update(); }
    catch { toast('That is not a session file from this app'); }
  });

  $('#editor').addEventListener('change', onEditorChange);
  $('#editor').addEventListener('click', onEditorClick);
  document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
    state.workout.steps.push(b.dataset.add === 'repeat'
      ? { type: 'repeat', count: 4, steps: [newStep('work'), { ...newStep('recovery'), end: 'time', time: 90, distance: 0 }] }
      : newStep('work'));
    update();
  }));
  $('#w-name').addEventListener('change', (e) => { state.workout.name = e.target.value.trim() || 'Runna session'; update(); });
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setUnit(b.dataset.unit)));

  $('#opt-tol').addEventListener('change', (e) => {
    const old = tolKm();
    state.opts.tolerance = Math.max(0, Math.min(60, +e.target.value || 0));
    retarget(old);
    update();
  });
  for (const [id, key] of [['#opt-easy', 'easyPace'], ['#opt-walk', 'walkPace']]) {
    $(id).addEventListener('change', (e) => {
      const v = parseMMSS(e.target.value);
      if (Number.isFinite(v) && v > 60) state.opts[key] = paceFromUnit(v, unit());
      else toast('Use a pace like 6:30');
      update();
    });
  }

  $('#file-route').addEventListener('change', onRouteFile);
  $('#btn-clear-route').addEventListener('click', () => { state.route = null; update(); });
  $('#opt-extend').addEventListener('change', (e) => { state.extend = e.target.value; update(); });
  $('#opt-offset').addEventListener('change', (e) => { state.offset = Math.max(0, +e.target.value || 0); update(); });

  document.querySelectorAll('[data-dl]').forEach((b) => b.addEventListener('click', () => download(b.dataset.dl)));
  document.querySelectorAll('[data-share]').forEach((b) => b.addEventListener('click', () => share(b.dataset.share)));
  $('#btn-card').addEventListener('click', () => {
    const c = $('#card');
    c.hidden = !c.hidden;
    $('#btn-card').textContent = c.hidden ? 'Show schedule card' : 'Hide schedule card';
    if (!c.hidden) { renderCard(); c.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  });
  $('#btn-copy').addEventListener('click', () => copy(scheduleText(), 'Schedule copied'));
  $('#btn-link').addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}#w=${b64urlEncode(JSON.stringify(state.workout))}`;
    copy(url, 'Share link copied — open it on your phone');
  });

  update();
}

init();
