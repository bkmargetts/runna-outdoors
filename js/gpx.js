// GPX writer: the route as a track plus a waypoint at each workout step boundary.

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const f = (n, dp = 7) => Number(n).toFixed(dp);

/**
 * buildGpx({ name, desc, points, cues, times?, startDate? })
 * times (optional) are seconds from start for each point — written as <time> so apps can
 * show a "virtual partner" at your planned paces.
 */
export function buildGpx({ name, desc = '', points, cues = [], times = null, startDate = null }) {
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<gpx version="1.1" creator="Runna → WorkOutDoors" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">');
  lines.push(`  <metadata><name>${esc(name)}</name>${desc ? `<desc>${esc(desc)}</desc>` : ''}</metadata>`);
  for (const c of cues) {
    lines.push(`  <wpt lat="${f(c.lat)}" lon="${f(c.lon)}">`);
    if (c.ele != null) lines.push(`    <ele>${f(c.ele, 1)}</ele>`);
    lines.push(`    <name>${esc(c.name)}</name>`);
    const d = [c.desc, c.estimated ? 'position estimated from planned pace' : ''].filter(Boolean).join(' · ');
    if (d) lines.push(`    <desc>${esc(d)}</desc>`);
    lines.push(`    <sym>${c.kind === 'finish' ? 'Flag, Red' : c.kind === 'work' ? 'Flag, Green' : 'Flag, Blue'}</sym>`);
    lines.push(`    <type>${esc(c.kind)}</type>`);
    lines.push('  </wpt>');
  }
  lines.push('  <trk>');
  lines.push(`    <name>${esc(name)}</name>`);
  lines.push('    <type>running</type>');
  lines.push('    <trkseg>');
  const t0 = startDate ? startDate.getTime() : 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let inner = '';
    if (p.ele != null) inner += `<ele>${f(p.ele, 1)}</ele>`;
    if (times && startDate) inner += `<time>${new Date(t0 + times[i] * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')}</time>`;
    lines.push(`      <trkpt lat="${f(p.lat)}" lon="${f(p.lon)}">${inner}</trkpt>`);
  }
  lines.push('    </trkseg>');
  lines.push('  </trk>');
  lines.push('</gpx>');
  return lines.join('\n') + '\n';
}
