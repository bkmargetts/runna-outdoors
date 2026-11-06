// Workout model + formatting helpers.
//
// A workout is { name, unit: 'km'|'mi', steps: Item[] }
//   Item = Step | Repeat
//   Step   = { type:'step', kind, end:'distance'|'time'|'open', distance (m), time (s),
//              pace: { fast, slow, target? } | null   (seconds per km), walk?, text? }
//   Repeat = { type:'repeat', count, steps: Item[] }
// Paces are always stored internally as seconds per kilometre.

export const MI = 1609.344;

export const KIND_LABEL = {
  warmup: 'Warm-up',
  work: 'Run',
  recovery: 'Recover',
  cooldown: 'Cool-down',
};

export function newStep(kind = 'work') {
  return { type: 'step', kind, end: 'distance', distance: 400, time: 0, pace: null };
}

// ---- pace / time / distance formatting -------------------------------------

export function paceToUnit(secPerKm, unit) {
  return unit === 'mi' ? (secPerKm * MI) / 1000 : secPerKm;
}

export function paceFromUnit(sec, unit) {
  return unit === 'mi' ? (sec * 1000) / MI : sec;
}

export function fmtMMSS(sec) {
  let m = Math.floor(sec / 60);
  let s = Math.round(sec - m * 60);
  if (s === 60) { m += 1; s = 0; }
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtPace(secPerKm, unit) {
  return fmtMMSS(paceToUnit(secPerKm, unit));
}

export function fmtPaceRange(pace, unit, withUnit = true) {
  if (!pace) return '';
  const u = withUnit ? `/${unit}` : '';
  if (Math.round(pace.fast) === Math.round(pace.slow)) return fmtPace(pace.fast, unit) + u;
  return `${fmtPace(pace.fast, unit)}–${fmtPace(pace.slow, unit)}${u}`;
}

/** "4:10" -> seconds; returns NaN if invalid. */
export function parseMMSS(str) {
  const m = String(str).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function fmtDuration(sec) {
  sec = Math.round(sec);
  if (sec < 60 || (sec <= 120 && sec % 60)) return `${sec}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return s ? `${m}:${String(s).padStart(2, '0')}` : `${m} min`;
  }
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function trimNum(n, dp) {
  return n.toFixed(dp).replace(/\.?0+$/, '');
}

export function fmtDistance(m, unit) {
  if (unit === 'mi') {
    if (m < 800 && Math.abs(m - Math.round(m / 50) * 50) < 1) return `${Math.round(m)}m`;
    return `${trimNum(m / MI, 2)} mi`;
  }
  if (m < 1000) return `${Math.round(m)}m`;
  return `${trimNum(m / 1000, 2)}km`;
}

// ---- traversal ----------------------------------------------------------------

/**
 * Walk the workout in execution order, expanding repeats.
 * Calls fn(step, reps) where reps = [{i, n}, ...] from outermost to innermost.
 */
export function forEachExecuted(items, fn, reps = []) {
  for (const item of items) {
    if (item.type === 'repeat') {
      for (let i = 1; i <= item.count; i++) {
        forEachExecuted(item.steps, fn, [...reps, { i, n: item.count }]);
      }
    } else {
      fn(item, reps);
    }
  }
}

export function countWorkReps(items) {
  let n = 0;
  forEachExecuted(items, (s) => { if (s.kind === 'work') n++; });
  return n;
}

// ---- estimation -----------------------------------------------------------------

export const DEFAULT_OPTS = {
  tolerance: 5, // +/- seconds per km around a single target pace
  easyPace: 390, // 6:30/km — used to estimate steps with no pace target
  walkPace: 600, // 10:00/km — used for walking recoveries
};

export function midPace(step, opts = DEFAULT_OPTS) {
  if (step.pace) return (step.pace.fast + step.pace.slow) / 2;
  if (step.walk) return opts.walkPace;
  return opts.easyPace;
}

/** Distance (m) and duration (s) a single step will take, plus whether either is an estimate. */
export function stepExtent(step, opts = DEFAULT_OPTS) {
  const p = midPace(step, opts);
  if (step.end === 'distance') {
    return { distance: step.distance, time: (step.distance * p) / 1000, estDistance: false };
  }
  if (step.end === 'time') {
    return { distance: (step.time * 1000) / p, time: step.time, estDistance: true };
  }
  return { distance: 0, time: 0, estDistance: true };
}

export function totals(workout, opts = DEFAULT_OPTS) {
  let distance = 0, time = 0, estimated = false;
  forEachExecuted(workout.steps, (s) => {
    const e = stepExtent(s, opts);
    distance += e.distance;
    time += e.time;
    if (e.estDistance) estimated = true;
  });
  return { distance, time, estimated };
}

function repPrefix(reps) {
  if (!reps.length) return '';
  if (reps.length === 1) return `${reps[0].i}/${reps[0].n}`;
  return reps.map((r) => `${r.i}/${r.n}`).join('·');
}

export function stepAmount(step, unit) {
  if (step.end === 'distance') return fmtDistance(step.distance, unit);
  if (step.end === 'time') return fmtDuration(step.time);
  return 'open';
}

/** Short human label for a step (used for cues on the watch). */
export function stepLabel(step, reps, unit) {
  const amount = stepAmount(step, unit);
  const pace = step.pace ? ` @ ${fmtPaceRange(step.pace, unit, false)}` : '';
  const rp = repPrefix(reps);
  switch (step.kind) {
    case 'warmup': return `Warm-up ${amount}${pace}`;
    case 'cooldown': return `Cool-down ${amount}${pace}`;
    case 'recovery': return `${step.walk ? 'Walk' : 'Recover'} ${amount}${pace}`;
    default: return `${rp ? `Rep ${rp} ` : ''}${amount}${pace}`;
  }
}

/**
 * Linear list of executed segments with cumulative start distance/time.
 * Used to place cues along a route and to time the FIT course.
 */
export function segments(workout, opts = DEFAULT_OPTS) {
  const out = [];
  let start = 0, startTime = 0;
  forEachExecuted(workout.steps, (step, reps) => {
    const e = stepExtent(step, opts);
    out.push({
      step,
      reps,
      kind: step.kind,
      label: stepLabel(step, reps, workout.unit),
      start,
      length: e.distance,
      startTime,
      duration: e.time,
      estimated: e.estDistance,
      secPerKm: midPace(step, opts),
    });
    start += e.distance;
    startTime += e.time;
  });
  return out;
}

// ---- WorkOutDoors schedule ---------------------------------------------------------

/**
 * WorkOutDoors interval schedules support repeats but not nested repeats.
 * Unroll any repeat that contains another repeat (outer level), keeping the inner ones.
 */
export function wodSchedule(items) {
  const out = [];
  for (const item of items) {
    if (item.type !== 'repeat') { out.push(item); continue; }
    const hasNested = item.steps.some((s) => s.type === 'repeat');
    if (!hasNested) { out.push(item); continue; }
    for (let i = 0; i < item.count; i++) out.push(...wodSchedule(item.steps));
  }
  // Merge adjacent identical simple-step runs is not needed; return as-is.
  return out;
}

export function cloneWorkout(w) {
  return JSON.parse(JSON.stringify(w));
}

/** Validate/normalise something that claims to be a workout (e.g. from a share link). */
export function sanitizeWorkout(w) {
  if (!w || typeof w !== 'object' || !Array.isArray(w.steps)) throw new Error('Not a workout');
  const kinds = new Set(Object.keys(KIND_LABEL));
  const fixItems = (items, depth) => items.map((it) => {
    if (it.type === 'repeat') {
      if (depth > 3) throw new Error('Repeats nested too deeply');
      return { type: 'repeat', count: Math.max(1, Math.min(99, Number(it.count) || 1)), steps: fixItems(it.steps || [], depth + 1) };
    }
    const end = ['distance', 'time', 'open'].includes(it.end) ? it.end : 'open';
    const pace = it.pace && Number.isFinite(+it.pace.fast) && Number.isFinite(+it.pace.slow)
      ? { fast: Math.min(+it.pace.fast, +it.pace.slow), slow: Math.max(+it.pace.fast, +it.pace.slow), ...(Number.isFinite(+it.pace.target) ? { target: +it.pace.target } : {}) }
      : null;
    return {
      type: 'step',
      kind: kinds.has(it.kind) ? it.kind : 'work',
      end,
      distance: Math.max(0, Number(it.distance) || 0),
      time: Math.max(0, Number(it.time) || 0),
      pace,
      ...(it.walk ? { walk: true } : {}),
      ...(it.text ? { text: String(it.text).slice(0, 200) } : {}),
    };
  });
  return {
    name: String(w.name || 'Runna session').slice(0, 80),
    unit: w.unit === 'mi' ? 'mi' : 'km',
    steps: fixItems(w.steps, 0),
  };
}
