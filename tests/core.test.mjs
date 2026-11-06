import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decoder, Stream } from '@garmin/fitsdk';

import { parseSession } from '../js/parse.js';
import { segments, totals, wodSchedule, fmtPaceRange, sanitizeWorkout, DEFAULT_OPTS } from '../js/model.js';
import { parseRouteFile, extendRoute, placeCues, pointTimes, cumulative } from '../js/route.js';
import { buildGpx } from '../js/gpx.js';
import { buildFitCourse, buildFitWorkout } from '../js/fit.js';

const RUNNA_MULTILINE = `Tempo
Warm-up. 800m at conversational pace. No faster than 7:15/km.
Set. Repeat x3: 400m at 6:20/km, 400m at 6:55/km
Rest. 90s walking rest
Cool down. 800m at a conversational pace.`;

const RUNNA_ONELINE = '1.2km warm-up → Set: 3× (300m @ 6:15/km + 300m recovery @ 7:00/km) → Rest: 90s walking rest → 1km cool-down';

function decode(bytes) {
  const decoder = new Decoder(Stream.fromByteArray(Array.from(bytes)));
  assert.ok(decoder.isFIT(), 'is FIT');
  assert.ok(decoder.checkIntegrity(), 'CRC/integrity ok');
  const { messages, errors } = decoder.read({ convertTypesToStrings: true });
  assert.deepEqual(errors, []);
  return messages;
}

// a ~1km square loop
function squareLoopGpx() {
  const lat0 = 51.5, lon0 = -0.12, dLat = 0.00225, dLon = 0.0036;
  const corners = [[0, 0], [dLat, 0], [dLat, dLon], [0, dLon], [0, 0]];
  const pts = [];
  for (let c = 0; c < 4; c++) {
    const [a1, b1] = corners[c], [a2, b2] = corners[c + 1];
    for (let i = 0; i < 10; i++) pts.push([lat0 + a1 + ((a2 - a1) * i) / 10, lon0 + b1 + ((b2 - b1) * i) / 10]);
  }
  pts.push([lat0, lon0]);
  return `<?xml version="1.0"?><gpx version="1.1"><trk><name>Park &amp; loop</name><trkseg>${pts
    .map(([la, lo], i) => `<trkpt lon="${lo}" lat="${la}"><ele>${10 + (i % 5)}</ele></trkpt>`).join('')}</trkseg></trk></gpx>`;
}

test('parses Runna multi-line session with rest folded into the set', () => {
  const w = parseSession(RUNNA_MULTILINE);
  assert.equal(w.name, 'Tempo');
  assert.equal(w.unit, 'km');
  assert.equal(w.steps.length, 3);
  const [wu, set, cd] = w.steps;
  assert.equal(wu.kind, 'warmup');
  assert.equal(wu.distance, 800);
  assert.equal(wu.pace.fast, 435); // no faster than 7:15
  assert.equal(set.type, 'repeat');
  assert.equal(set.count, 3);
  assert.deepEqual(set.steps.map((s) => [s.end, s.distance || s.time]), [['distance', 400], ['distance', 400], ['time', 90]]);
  assert.equal(set.steps[2].kind, 'recovery');
  assert.equal(set.steps[2].walk, true);
  assert.equal(cd.kind, 'cooldown');
  assert.deepEqual(w.warnings, []);
});

test('parses Runna one-line arrow format', () => {
  const w = parseSession(RUNNA_ONELINE);
  assert.equal(w.steps[0].kind, 'warmup');
  assert.equal(w.steps[0].distance, 1200);
  const set = w.steps[1];
  assert.equal(set.count, 3);
  assert.equal(set.steps[0].kind, 'work');
  assert.equal(set.steps[1].kind, 'recovery');
  assert.equal(fmtPaceRange(set.steps[0].pace, 'km'), '6:10–6:20/km');
  assert.equal(w.steps.at(-1).kind, 'cooldown');
});

test('parses free text, miles, ranges and nested repeats', () => {
  let w = parseSession('Warm up\n1.5km easy\n6 x 400m @ 4:10/km with 90s jog recovery\nCool down\n1km easy');
  assert.equal(w.steps[1].count, 6);
  assert.deepEqual(w.steps[1].steps.map((s) => s.kind), ['work', 'recovery']);
  assert.equal(w.steps[2].kind, 'cooldown');

  w = parseSession('2 x (3 x 1km at 4:30-4:40/km with 2 min jog) with 3 min walk between sets');
  const outer = w.steps[0];
  assert.equal(outer.count, 2);
  assert.equal(outer.steps[0].type, 'repeat');
  assert.equal(outer.steps[0].steps.length, 2);
  assert.equal(outer.steps[1].time, 180);
  // WorkOutDoors has no nested repeats: outer gets unrolled
  const wod = wodSchedule(w.steps);
  assert.equal(wod.length, 4);
  assert.ok(wod.every((it, i) => (i % 2 === 0 ? it.type === 'repeat' : it.type === 'step')));

  w = parseSession('Repeat x4:\n  - 1 mile at 7:45/mi\n  - 2:00 walking rest\n1 mile cool down');
  assert.equal(w.unit, 'mi');
  assert.equal(w.steps[0].steps.length, 2);
  assert.equal(w.steps[0].steps[1].time, 120);
  assert.equal(w.steps[1].kind, 'cooldown');
  assert.equal(fmtPaceRange(w.steps[0].steps[0].pace, 'mi', false), '7:40–7:50');
});

test('segments, totals and labels', () => {
  const w = parseSession(RUNNA_MULTILINE);
  const segs = segments(w);
  assert.equal(segs.length, 1 + 3 * 3 + 1);
  assert.equal(segs[1].label, 'Rep 1/3 400m @ 6:15–6:25');
  assert.equal(segs[3].label, 'Walk 90s');
  assert.ok(segs[3].estimated);
  const t = totals(w);
  assert.ok(t.estimated);
  assert.ok(Math.abs(t.distance - (800 + 3 * (800 + 90 * 1000 / DEFAULT_OPTS.walkPace) + 800)) < 0.01);
});

test('route parse, loop extension, cues, GPX', () => {
  const route = parseRouteFile(squareLoopGpx(), 'park.gpx');
  assert.equal(route.name, 'Park & loop');
  const base = cumulative(route.points).at(-1);
  assert.ok(base > 900 && base < 1100, `loop length ${base}`);

  const w = parseSession(RUNNA_MULTILINE);
  const segs = segments(w);
  const need = totals(w).distance;
  const ext = extendRoute(route.points, need, 'auto');
  assert.equal(ext.mode, 'loop');
  assert.ok(ext.length >= need);
  const cues = placeCues(ext, segs, 0);
  assert.equal(cues.length, segs.length + 1);
  assert.equal(cues.at(-1).name, 'Finish');
  assert.ok(Math.abs(cues[1].distance - 800) < 1e-6);

  const times = pointTimes(ext, segs, 0, DEFAULT_OPTS.easyPace);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1]);

  const gpx = buildGpx({ name: 'Tempo', points: ext.points, cues, times, startDate: new Date('2026-01-01T07:00:00Z') });
  assert.match(gpx, /<wpt lat=/);
  assert.equal((gpx.match(/<wpt /g) || []).length, cues.length);
  assert.match(gpx, /<time>2026-01-01T07:00:00Z<\/time>/);
  // round-trips through our own parser
  assert.equal(parseRouteFile(gpx, 'x.gpx').points.length, ext.points.length);
});

test('non-loop routes become out-and-back', () => {
  const gpx = `<gpx><rte><rtept lat="51.5" lon="-0.1"/><rtept lat="51.505" lon="-0.1"/></rte></gpx>`;
  const r = parseRouteFile(gpx, 'line.gpx');
  const ext = extendRoute(r.points, 2000, 'auto');
  assert.equal(ext.mode, 'outback');
  assert.ok(ext.length >= 2000);
});

test('FIT course decodes with the Garmin SDK', () => {
  const route = parseRouteFile(squareLoopGpx(), 'park.gpx');
  const w = parseSession(RUNNA_MULTILINE);
  const segs = segments(w);
  const ext = extendRoute(route.points, totals(w).distance, 'auto');
  const cues = placeCues(ext, segs, 0);
  const times = pointTimes(ext, segs, 0, DEFAULT_OPTS.easyPace);
  const bytes = buildFitCourse({ name: w.name, points: ext.points, cum: ext.cum, times, cues, startDate: new Date('2026-01-01T07:00:00Z') });
  const m = decode(bytes);
  assert.equal(m.fileIdMesgs[0].type, 'course');
  assert.equal(m.courseMesgs[0].name, 'Tempo');
  assert.equal(m.courseMesgs[0].sport, 'running');
  assert.equal(m.recordMesgs.length, ext.points.length);
  assert.equal(m.coursePointMesgs.length, cues.length);
  assert.equal(m.coursePointMesgs[1].name, 'Rep 1/3 400m @ 6:15–6:25');
  assert.ok(Math.abs(m.coursePointMesgs[1].distance - 800) < 0.02);
  assert.ok(Math.abs(m.recordMesgs[3].positionLat - Math.round(ext.points[3].lat * 2 ** 31 / 180)) <= 1);
  assert.equal(m.lapMesgs.length, 1);
  assert.equal(m.eventMesgs.length, 2);
});

test('FIT workout decodes with repeats and pace targets', () => {
  const w = parseSession('2 x (3 x 1km at 4:30-4:40/km with 2 min jog) with 3 min walk between sets');
  const m = decode(buildFitWorkout(w));
  assert.equal(m.fileIdMesgs[0].type, 'workout');
  const steps = m.workoutStepMesgs;
  assert.equal(m.workoutMesgs[0].numValidSteps, steps.length);
  // 0: 1km, 1: 2min jog, 2: repeat inner x3 from 0, 3: walk, 4: repeat outer x2 from 0
  assert.equal(steps.length, 5);
  assert.equal(steps[0].durationType, 'distance');
  assert.equal(steps[0].durationDistance, 1000);
  assert.equal(steps[0].targetType, 'speed');
  assert.ok(Math.abs(steps[0].customTargetSpeedHigh - 1000 / 270) < 0.002);
  assert.ok(Math.abs(steps[0].customTargetSpeedLow - 1000 / 280) < 0.002);
  assert.equal(steps[1].durationType, 'time');
  assert.equal(steps[1].durationTime, 120);
  assert.equal(steps[2].durationType, 'repeatUntilStepsCmplt');
  assert.equal(steps[2].durationStep, 0);
  assert.equal(steps[2].repeatSteps, 3);
  assert.equal(steps[4].repeatSteps, 2);
});

test('sanitizeWorkout rejects junk and normalises', () => {
  assert.throws(() => sanitizeWorkout({}));
  const w = sanitizeWorkout({ name: 'x', unit: 'yd', steps: [{ type: 'repeat', count: 500, steps: [{ kind: 'evil', end: 'time', time: '60' }] }] });
  assert.equal(w.unit, 'km');
  assert.equal(w.steps[0].count, 99);
  assert.equal(w.steps[0].steps[0].kind, 'work');
  assert.equal(w.steps[0].steps[0].time, 60);
});

test('a title line containing a number is not mistaken for a step', () => {
  const w = parseSession('Threshold 400s\nWarm-up. 1.5km easy\nSet. Repeat x6: 400m at 4:10/km\nRest. 90s walking rest');
  assert.equal(w.name, 'Threshold 400s');
  assert.equal(w.steps[0].kind, 'warmup');
  // but a single line with a step is still a step
  assert.equal(parseSession('5km easy run').steps[0].distance, 5000);
  assert.equal(parseSession('Easy run 8 miles at 9:30/mi\n').steps[0].end, 'distance');
});
