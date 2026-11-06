// Route parsing (GPX / TCX), geometry, and placing workout cues along a route.

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function decodeXml(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .trim();
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return m ? parseFloat(m[1]) : NaN;
}

function parseGpx(text) {
  const nameM = text.match(/<(?:trk|rte|metadata)\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/i);
  const read = (tagName) => {
    const pts = [];
    const re = new RegExp(`<${tagName}\\b([^>]*?)(\\/>|>([\\s\\S]*?)<\\/${tagName}>)`, 'gi');
    for (const m of text.matchAll(re)) {
      const lat = attr(m[1], 'lat'), lon = attr(m[1], 'lon');
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const p = { lat, lon };
      const ele = m[3] && m[3].match(/<ele>\s*([-\d.eE+]+)\s*<\/ele>/i);
      if (ele) p.ele = parseFloat(ele[1]);
      pts.push(p);
    }
    return pts;
  };
  let points = read('trkpt');
  if (points.length < 2) points = read('rtept');
  return { name: nameM ? decodeXml(nameM[1]) : null, points };
}

function parseTcx(text) {
  const nameM = text.match(/<(?:Name|Id)>([\s\S]*?)<\/(?:Name|Id)>/i);
  const points = [];
  for (const m of text.matchAll(/<Trackpoint>([\s\S]*?)<\/Trackpoint>/gi)) {
    const lat = m[1].match(/<LatitudeDegrees>\s*([-\d.eE+]+)/i);
    const lon = m[1].match(/<LongitudeDegrees>\s*([-\d.eE+]+)/i);
    if (!lat || !lon) continue;
    const p = { lat: parseFloat(lat[1]), lon: parseFloat(lon[1]) };
    const ele = m[1].match(/<AltitudeMeters>\s*([-\d.eE+]+)/i);
    if (ele) p.ele = parseFloat(ele[1]);
    points.push(p);
  }
  return { name: nameM ? decodeXml(nameM[1]) : null, points };
}

/** Parse GPX or TCX text into { name, points: [{lat, lon, ele?}] }. */
export function parseRouteFile(text, filename = '') {
  const isTcx = /\.tcx$/i.test(filename) || /<TrainingCenterDatabase/i.test(text);
  const route = isTcx ? parseTcx(text) : parseGpx(text);
  // drop consecutive duplicates
  route.points = route.points.filter((p, i, arr) => i === 0 || p.lat !== arr[i - 1].lat || p.lon !== arr[i - 1].lon);
  if (route.points.length < 2) throw new Error('No track or route points found in that file. Use a GPX or TCX route/track.');
  if (!route.name) route.name = filename.replace(/\.[^.]+$/, '') || 'Route';
  return route;
}

export function cumulative(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
  return cum;
}

/** Interpolated point at distance d along the polyline. */
export function pointAt(points, cum, d) {
  if (d <= 0) return { ...points[0] };
  const total = cum[cum.length - 1];
  if (d >= total) return { ...points[points.length - 1] };
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid;
  }
  const seg = cum[hi] - cum[lo];
  const t = seg > 0 ? (d - cum[lo]) / seg : 0;
  const a = points[lo], b = points[hi];
  const p = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
  if (a.ele != null && b.ele != null) p.ele = a.ele + (b.ele - a.ele) * t;
  return p;
}

export function isLoop(points, threshold = 100) {
  return haversine(points[0], points[points.length - 1]) <= threshold;
}

/**
 * Make a route long enough for the workout.
 * mode: 'auto' | 'loop' | 'outback' | 'none'
 * Returns { points, cum, length, mode, laps, short }
 */
export function extendRoute(points, needed, mode = 'auto') {
  let cum = cumulative(points);
  const base = cum[cum.length - 1];
  let resolved = mode === 'auto' ? (isLoop(points) ? 'loop' : 'outback') : mode;
  if (needed <= base + 1 || resolved === 'none' || base < 10) {
    return { points, cum, length: base, mode: needed <= base + 1 ? 'as-is' : resolved, laps: 1, short: needed > base + 1 };
  }
  const out = points.slice();
  let laps = 1;
  let forward = false;
  let len = base;
  while (len < needed && laps < 200) {
    let next;
    if (resolved === 'loop') next = points;
    else { next = forward ? points : points.slice().reverse(); forward = !forward; }
    const start = haversine(out[out.length - 1], next[0]) < 1 ? 1 : 0;
    for (let i = start; i < next.length; i++) out.push(next[i]);
    laps++;
    len = cumulative(out).at(-1);
  }
  cum = cumulative(out);
  return { points: out, cum, length: cum[cum.length - 1], mode: resolved, laps, short: false };
}

/**
 * Place a cue at the start of every workout segment, plus a finish cue.
 * startOffset: metres along the route at which the workout starts.
 */
export function placeCues(route, segs, startOffset = 0) {
  const cues = [];
  for (const s of segs) {
    if (s.length <= 0 && s.step.end !== 'open') continue;
    const d = startOffset + s.start;
    if (d > route.length + 1) break;
    cues.push({
      ...pointAt(route.points, route.cum, d),
      distance: d,
      time: s.startTime,
      name: s.label,
      kind: s.kind,
      estimated: s.estimated,
      desc: s.step.text || '',
    });
  }
  const last = segs[segs.length - 1];
  if (last) {
    const end = startOffset + last.start + last.length;
    if (end <= route.length + 1) {
      cues.push({ ...pointAt(route.points, route.cum, end), distance: end, time: last.startTime + last.duration, name: 'Finish', kind: 'finish', estimated: segs.some((s) => s.estimated), desc: 'Workout complete' });
    }
  }
  return cues;
}

/**
 * Timestamp (seconds from start) for each route point, following the workout's planned paces.
 * Points before the start offset or after the finish use fallbackPace.
 */
export function pointTimes(route, segs, startOffset, fallbackPace) {
  const times = new Array(route.points.length);
  let si = 0;
  const preTime = (startOffset * fallbackPace) / 1000;
  const lastSeg = segs[segs.length - 1];
  const endDist = lastSeg ? startOffset + lastSeg.start + lastSeg.length : startOffset;
  const endTime = preTime + (lastSeg ? lastSeg.startTime + lastSeg.duration : 0);
  for (let i = 0; i < route.points.length; i++) {
    const d = route.cum[i];
    if (d <= startOffset || !segs.length) { times[i] = (d * fallbackPace) / 1000; continue; }
    if (d >= endDist) { times[i] = endTime + ((d - endDist) * fallbackPace) / 1000; continue; }
    const rel = d - startOffset;
    while (si < segs.length - 1 && rel > segs[si].start + segs[si].length) si++;
    const s = segs[si];
    times[i] = preTime + s.startTime + ((rel - s.start) * s.secPerKm) / 1000;
  }
  // enforce strictly non-decreasing
  for (let i = 1; i < times.length; i++) if (times[i] < times[i - 1]) times[i] = times[i - 1];
  return times;
}
