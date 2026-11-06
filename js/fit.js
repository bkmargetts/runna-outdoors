// Minimal FIT (Flexible and Interoperable Data Transfer) encoder for
//   - Course files  (route + course points at each workout step) — importable by WorkOutDoors 6+
//   - Workout files (structured steps, repeats, pace targets) — for Garmin/COROS/etc and future-proofing

import { forEachExecuted } from './model.js';

const FIT_EPOCH = 631065600; // 1989-12-31T00:00:00Z in unix seconds

const T = {
  enum: { id: 0x00, size: 1, invalid: 0xff },
  uint8: { id: 0x02, size: 1, invalid: 0xff },
  sint32: { id: 0x85, size: 4, invalid: 0x7fffffff },
  uint16: { id: 0x84, size: 2, invalid: 0xffff },
  uint32: { id: 0x86, size: 4, invalid: 0xffffffff },
  uint32z: { id: 0x8c, size: 4, invalid: 0 },
  string: { id: 0x07 },
};

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

export function crc16(bytes, crc = 0) {
  for (const byte of bytes) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf];
  }
  return crc;
}

const enc = new TextEncoder();

function fitString(str, size) {
  const out = new Uint8Array(size); // zero-filled => null-terminated
  let bytes = enc.encode(String(str ?? ''));
  if (bytes.length > size - 1) {
    // truncate on a UTF-8 character boundary
    let n = size - 1;
    while (n > 0 && (bytes[n] & 0xc0) === 0x80) n--;
    bytes = bytes.slice(0, n);
  }
  out.set(bytes);
  return out;
}

class FitWriter {
  constructor() {
    this.chunks = [];
    this.defs = new Map();
  }

  /** fields: [{ num, type: 'uint32'|..., size? (strings) , key }] */
  define(local, globalNum, fields) {
    const b = [0x40 | local, 0, 0, globalNum & 0xff, (globalNum >> 8) & 0xff, fields.length];
    for (const fd of fields) {
      const t = T[fd.type];
      b.push(fd.num, fd.type === 'string' ? fd.size : t.size, t.id);
    }
    this.chunks.push(Uint8Array.from(b));
    this.defs.set(local, fields);
  }

  write(local, values) {
    const fields = this.defs.get(local);
    const size = 1 + fields.reduce((n, fd) => n + (fd.type === 'string' ? fd.size : T[fd.type].size), 0);
    const buf = new Uint8Array(size);
    const dv = new DataView(buf.buffer);
    buf[0] = local;
    let o = 1;
    for (const fd of fields) {
      const t = T[fd.type];
      const v = values[fd.key];
      if (fd.type === 'string') { buf.set(fitString(v, fd.size), o); o += fd.size; continue; }
      const val = v == null || !Number.isFinite(v) ? t.invalid : Math.round(v);
      switch (t.size) {
        case 1: dv.setUint8(o, val & 0xff); break;
        case 2: dv.setUint16(o, val, true); break;
        case 4:
          if (fd.type === 'sint32') dv.setInt32(o, val, true); else dv.setUint32(o, val >>> 0, true);
          break;
      }
      o += t.size;
    }
    this.chunks.push(buf);
  }

  finish() {
    const dataSize = this.chunks.reduce((n, c) => n + c.length, 0);
    const header = new Uint8Array(14);
    const hv = new DataView(header.buffer);
    header[0] = 14;
    header[1] = 0x20; // protocol 2.0
    hv.setUint16(2, 2132, true); // profile version 21.32
    hv.setUint32(4, dataSize, true);
    header.set(enc.encode('.FIT'), 8);
    hv.setUint16(12, crc16(header.subarray(0, 12)), true);
    const out = new Uint8Array(14 + dataSize + 2);
    out.set(header, 0);
    let o = 14;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    const crc = crc16(out.subarray(0, o));
    out[o] = crc & 0xff;
    out[o + 1] = crc >> 8;
    return out;
  }
}

const semi = (deg) => Math.round((deg * 2 ** 31) / 180);
const fitTime = (date) => Math.floor(date.getTime() / 1000) - FIT_EPOCH;

function fileId(w, type, created) {
  w.define(0, 0, [
    { num: 0, type: 'enum', key: 'type' },
    { num: 1, type: 'uint16', key: 'manufacturer' },
    { num: 2, type: 'uint16', key: 'product' },
    { num: 3, type: 'uint32z', key: 'serial' },
    { num: 4, type: 'uint32', key: 'created' },
  ]);
  w.write(0, { type, manufacturer: 255 /* development */, product: 1, serial: 0x52574f44, created: fitTime(created) });
}

/**
 * FIT course: route records timed at planned paces, with a course point at each step.
 * buildFitCourse({ name, points, times, cues, startDate })
 */
export function buildFitCourse({ name, points, cum, times, cues, startDate = new Date() }) {
  const w = new FitWriter();
  const t0 = fitTime(startDate);
  fileId(w, 6 /* course */, startDate);

  w.define(1, 31, [
    { num: 4, type: 'enum', key: 'sport' },
    { num: 5, type: 'string', size: 32, key: 'name' },
  ]);
  w.write(1, { sport: 1 /* running */, name });

  const totalTime = times[times.length - 1];
  const first = points[0], last = points[points.length - 1];
  w.define(2, 19, [
    { num: 253, type: 'uint32', key: 'timestamp' },
    { num: 2, type: 'uint32', key: 'start' },
    { num: 3, type: 'sint32', key: 'slat' },
    { num: 4, type: 'sint32', key: 'slon' },
    { num: 5, type: 'sint32', key: 'elat' },
    { num: 6, type: 'sint32', key: 'elon' },
    { num: 7, type: 'uint32', key: 'elapsed' },
    { num: 8, type: 'uint32', key: 'timer' },
    { num: 9, type: 'uint32', key: 'dist' },
  ]);
  w.write(2, {
    timestamp: t0, start: t0,
    slat: semi(first.lat), slon: semi(first.lon), elat: semi(last.lat), elon: semi(last.lon),
    elapsed: totalTime * 1000, timer: totalTime * 1000, dist: cum[cum.length - 1] * 100,
  });

  w.define(3, 21, [
    { num: 253, type: 'uint32', key: 'timestamp' },
    { num: 0, type: 'enum', key: 'event' },
    { num: 1, type: 'enum', key: 'eventType' },
    { num: 4, type: 'uint8', key: 'group' },
  ]);
  w.write(3, { timestamp: t0, event: 0, eventType: 0, group: 0 });

  const hasEle = points.every((p) => p.ele != null);
  const recFields = [
    { num: 253, type: 'uint32', key: 'timestamp' },
    { num: 0, type: 'sint32', key: 'lat' },
    { num: 1, type: 'sint32', key: 'lon' },
    { num: 5, type: 'uint32', key: 'dist' },
  ];
  if (hasEle) recFields.push({ num: 2, type: 'uint16', key: 'alt' });
  w.define(4, 20, recFields);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    w.write(4, {
      timestamp: t0 + Math.round(times[i]),
      lat: semi(p.lat), lon: semi(p.lon), dist: cum[i] * 100,
      alt: hasEle ? (p.ele + 500) * 5 : null,
    });
  }

  w.define(5, 32, [
    { num: 254, type: 'uint16', key: 'index' },
    { num: 1, type: 'uint32', key: 'timestamp' },
    { num: 2, type: 'sint32', key: 'lat' },
    { num: 3, type: 'sint32', key: 'lon' },
    { num: 4, type: 'uint32', key: 'dist' },
    { num: 5, type: 'enum', key: 'type' },
    { num: 6, type: 'string', size: 32, key: 'name' },
  ]);
  cues.forEach((c, i) => {
    w.write(5, {
      index: i,
      timestamp: t0 + Math.round(timeAtDistance(cum, times, c.distance)),
      lat: semi(c.lat), lon: semi(c.lon), dist: c.distance * 100,
      type: 0, // generic
      name: c.name,
    });
  });

  w.write(3, { timestamp: t0 + Math.round(totalTime), event: 0, eventType: 9 /* stop_disable_all */, group: 0 });
  return w.finish();
}

function timeAtDistance(cum, times, d) {
  if (d <= 0) return times[0];
  for (let i = 1; i < cum.length; i++) {
    if (cum[i] >= d) {
      const seg = cum[i] - cum[i - 1];
      const t = seg > 0 ? (d - cum[i - 1]) / seg : 0;
      return times[i - 1] + (times[i] - times[i - 1]) * t;
    }
  }
  return times[times.length - 1];
}

const INTENSITY = { warmup: 2, cooldown: 3, recovery: 4, work: 0 };

/** Flatten nested items into FIT workout steps (repeat steps reference their first child index). */
function fitSteps(items, unit, out = []) {
  for (const it of items) {
    if (it.type === 'repeat') {
      const from = out.length;
      fitSteps(it.steps, unit, out);
      out.push({ repeatFrom: from, count: it.count, name: `Repeat x${it.count}` });
    } else {
      out.push({ step: it });
    }
  }
  return out;
}

/** FIT workout file with steps, repeats and pace (speed) ranges. */
export function buildFitWorkout(workout, created = new Date()) {
  const w = new FitWriter();
  fileId(w, 5 /* workout */, created);
  const steps = fitSteps(workout.steps, workout.unit);

  w.define(1, 26, [
    { num: 4, type: 'enum', key: 'sport' },
    { num: 6, type: 'uint16', key: 'num' },
    { num: 8, type: 'string', size: 32, key: 'name' },
  ]);
  w.write(1, { sport: 1, num: steps.length, name: workout.name });

  w.define(2, 27, [
    { num: 254, type: 'uint16', key: 'index' },
    { num: 0, type: 'string', size: 32, key: 'name' },
    { num: 1, type: 'enum', key: 'durType' },
    { num: 2, type: 'uint32', key: 'durVal' },
    { num: 3, type: 'enum', key: 'tgtType' },
    { num: 4, type: 'uint32', key: 'tgtVal' },
    { num: 5, type: 'uint32', key: 'low' },
    { num: 6, type: 'uint32', key: 'high' },
    { num: 7, type: 'enum', key: 'intensity' },
    { num: 8, type: 'string', size: 64, key: 'notes' },
  ]);
  steps.forEach((s, index) => {
    if (s.repeatFrom != null) {
      w.write(2, { index, name: s.name, durType: 6, durVal: s.repeatFrom, tgtType: 2, tgtVal: s.count, low: null, high: null, intensity: null, notes: '' });
      return;
    }
    const st = s.step;
    const durType = st.end === 'time' ? 0 : st.end === 'distance' ? 1 : 5;
    const durVal = st.end === 'time' ? st.time * 1000 : st.end === 'distance' ? st.distance * 100 : null;
    const p = st.pace;
    w.write(2, {
      index,
      name: { warmup: 'Warm-up', cooldown: 'Cool-down', recovery: st.walk ? 'Walk' : 'Recover', work: 'Run' }[st.kind],
      durType, durVal,
      tgtType: p ? 0 : 2,
      tgtVal: 0,
      // speed in mm/s; low speed = slow pace
      low: p ? (1000 / p.slow) * 1000 : null,
      high: p ? (1000 / p.fast) * 1000 : null,
      intensity: INTENSITY[st.kind] ?? 0,
      notes: st.text || '',
    });
  });
  return w.finish();
}

// exported for tests
export const _internal = { FIT_EPOCH, semi, forEachExecuted };
