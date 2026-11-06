// Parse a Runna session description (pasted text) into a structured workout.
//
// Handles the shapes Runna uses, e.g.
//   Warm-up. 800m at conversational pace. No faster than 7:15/km.
//   Set. Repeat x3: 400m at 6:20/km, 400m at 6:55/km
//   Rest. 90s walking rest
//   Cool down. 800m at a conversational pace.
// and the one-line form
//   1.2km warm-up → Set: 3× (300m @ 6:15/km + 300m recovery @ 7:00/km) → Rest: 90s walking rest → 1km cool-down
// plus common free-text variants ("6 x 400m @ 4:10/km with 90s jog rest", "2 x (3 x 1km ...)").

import { MI, DEFAULT_OPTS } from './model.js';

const HEADER_RE = /^(warm[\s-]*up|cool[\s-]*down|main\s+set|the\s+set|set\s*\d*|rest|recovery|intervals?|tempo|strides|easy\s+run|long\s+run)\s*(?:[.:\-–—]+\s*|$)/i;

const PACE_RE = /(?:(no\s+faster\s+than|no\s+slower\s+than|faster\s+than|slower\s+than|under|sub|around|about|approx\.?|~)\s*)?(\d{1,2}:\d{2})(?:\s*(?:-|–|to)\s*(\d{1,2}:\d{2}))?\s*(?:min(?:utes|s)?\s*)?(?:\/|per\s+)\s*(km|kilomet(?:er|re)|k|mi(?:le)?)\b/gi;
const BARE_PACE_RE = /(?:@|\bat)\s*(\d{1,2}:\d{2})(?:\s*(?:-|–|to)\s*(\d{1,2}:\d{2}))?(?!\s*(?:min|mins|minutes|:|\d|\/|s\b|sec))/gi;
const DIST_RE = /(\d+(?:\.\d+)?)\s*(kilomet(?:er|re)s?|km|k|met(?:er|re)s?|m|miles?|mi)\b(?!\s*\/)/i;
const DUR_RE = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|min|seconds?|secs?|sec|s)\b/gi;
const MMSS_RE = /\b(\d{1,2}):(\d{2})\b/;

function normalize(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[×✕]/g, 'x')
    .replace(/[‐‑–—]/g, '-')
    .replace(/\s*(?:→|->|⟶|➜|=>)\s*/g, '\n');
}

function mmss(str) {
  const [m, s] = str.split(':').map(Number);
  return m * 60 + s;
}

/** Replace parenthesised content with placeholders so separators inside parens are ignored. */
function maskParens(str) {
  let depth = 0, out = '';
  for (const ch of str) {
    if (ch === '(' || ch === '[') { depth++; out += ch; continue; }
    if ((ch === ')' || ch === ']') && depth > 0) { depth--; out += ch; continue; }
    out += depth > 0 ? '\u0001' : ch;
  }
  return out;
}

function splitTop(str, re) {
  const masked = maskParens(str);
  const parts = [];
  let last = 0;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (const m of masked.matchAll(g)) {
    parts.push(str.slice(last, m.index));
    last = m.index + m[0].length;
  }
  parts.push(str.slice(last));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function stripPaces(s) {
  return s.replace(PACE_RE, ' ').replace(BARE_PACE_RE, ' ');
}

function hasQuantity(s) {
  const t = stripPaces(s);
  DUR_RE.lastIndex = 0;
  return DIST_RE.test(t) || DUR_RE.test(t) || MMSS_RE.test(t);
}

function hasPace(s) {
  PACE_RE.lastIndex = 0;
  BARE_PACE_RE.lastIndex = 0;
  return PACE_RE.test(s) || BARE_PACE_RE.test(s);
}

/** Split on separators, but glue pieces without a distance/time back onto the previous piece. */
function splitSteps(str, re) {
  const pieces = splitTop(str, re);
  const out = [];
  for (const p of pieces) {
    if (out.length && !hasQuantity(p) && !REPEAT_RE.test(p)) out[out.length - 1] += ', ' + p;
    else out.push(p);
  }
  return out;
}

const STRONG_SEP = /\s*(?:;|,?\s*\bthen\b|,?\s*\bfollowed\s+by\b)\s*/i;
const WEAK_SEP = /\s*(?:,|\+|&|\band\b|\bwith\b)\s*/i;

const REPEAT_RE = /^(?:repeat\s*|reps?\s*|do\s+)?(?:x\s*(\d+)\b|(\d+)\s*(?:x(?=\s|\d|\(|:|$)|times\b|reps?\b(?:\s*of\b)?|sets?\s+of\b|rounds?\s+of\b))\s*[:\-.]?\s*/i;
const TRAILING_REPEAT_RE = /^(.*?\S)\s*(?:x\s*(\d+)|(\d+)\s*times)\s*\.?$/i;

function kindFromHeader(h) {
  if (!h) return null;
  if (/warm/i.test(h)) return 'warmup';
  if (/cool/i.test(h)) return 'cooldown';
  if (/rest|recovery/i.test(h)) return 'recovery';
  return 'work';
}

function detectKind(s, hint) {
  if (/warm[\s-]*up/i.test(s)) return 'warmup';
  if (/cool[\s-]*down/i.test(s)) return 'cooldown';
  const isJog = /\bjog(?:ging)?\b/i.test(s) && !hasPace(s);
  if (isJog || /\b(rest|recover(?:y|ies)?|walk(?:ing)?|float|standing)\b/i.test(s)) {
    // "walk" inside a warm-up / cool-down section keeps that section's kind
    if (hint === 'warmup' || hint === 'cooldown') return hint;
    return 'recovery';
  }
  return hint || 'work';
}

function paceTarget(s, tol, planUnit) {
  PACE_RE.lastIndex = 0;
  let m = PACE_RE.exec(s);
  let mod, a, b, unit;
  if (m) {
    [, mod, a, b, unit] = m;
    unit = /^mi/i.test(unit) ? 'mi' : 'km';
  } else {
    BARE_PACE_RE.lastIndex = 0;
    m = BARE_PACE_RE.exec(s);
    if (!m) return null;
    [, a, b] = m;
    unit = planUnit;
  }
  const toKm = (v) => (unit === 'mi' ? (v * 1000) / MI : v);
  let p1 = toKm(mmss(a));
  if (b) {
    const p2 = toKm(mmss(b));
    return { fast: Math.min(p1, p2), slow: Math.max(p1, p2) };
  }
  // tolerance and caps are expressed in the plan's unit (e.g. ±5s per mile in a miles plan)
  const t = toKm(tol);
  const cap = toKm(60), under = toKm(30);
  mod = (mod || '').toLowerCase().replace(/\s+/g, ' ');
  if (mod === 'no faster than' || mod === 'slower than') return { fast: p1, slow: p1 + cap, target: p1 };
  if (mod === 'no slower than' || mod === 'faster than' || mod === 'under' || mod === 'sub') return { fast: p1 - under, slow: p1, target: p1 };
  return { fast: p1 - t, slow: p1 + t, target: p1 };
}

function parseStep(raw, hint, opts) {
  const s = raw.trim().replace(/^[-*•·]\s*/, '');
  const noPace = stripPaces(s);
  const step = { type: 'step', kind: detectKind(s, hint), end: 'open', distance: 0, time: 0, pace: null };
  const d = noPace.match(DIST_RE);
  DUR_RE.lastIndex = 0;
  const durs = [...noPace.matchAll(DUR_RE)];
  if (d) {
    const v = parseFloat(d[1]);
    const u = d[2].toLowerCase();
    let metres;
    if (u === 'km' || u === 'k' || u.startsWith('kilo')) metres = v * 1000;
    else if (u === 'mi' || u.startsWith('mile')) metres = v * MI;
    else metres = v;
    step.end = 'distance';
    step.distance = Math.round(metres * 10) / 10;
  } else if (durs.length) {
    let sec = 0;
    for (const m of durs) {
      const v = parseFloat(m[1]);
      const u = m[2].toLowerCase();
      if (u.startsWith('h')) sec += v * 3600;
      else if (u.startsWith('m')) sec += v * 60;
      else sec += v;
    }
    step.end = 'time';
    step.time = Math.round(sec);
  } else {
    const t = noPace.match(MMSS_RE);
    if (t) { step.end = 'time'; step.time = mmss(t[0]); }
  }
  step.pace = paceTarget(s, opts.tolerance, opts.unit);
  if (/\bwalk/i.test(s)) step.walk = true;
  step.text = s.replace(/\s+/g, ' ').replace(/[.,;:\s]+$/, '');
  return step;
}

/** Parse a list of pieces; a bare repeat ("3 x 1km") swallows the pieces that follow it. */
function parsePieces(pieces, hint, opts) {
  const out = [];
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const m = p.match(REPEAT_RE);
    if (m && !/^[([]/.test(p.slice(m[0].length).trim()) && i < pieces.length - 1) {
      out.push(...parseSegment(pieces.slice(i).join(', '), hint, opts));
      break;
    }
    out.push(...parseSegment(p, hint, opts));
  }
  return out;
}

/** Returns an array of items. A repeat with no inline steps is returned with `open: true`. */
function parseSegment(str, hint, opts) {
  str = str.trim().replace(/^[-*•·]\s*/, '');
  const m = str.match(REPEAT_RE);
  if (m) {
    const count = parseInt(m[1] || m[2], 10);
    let rest = str.slice(m[0].length).trim();
    let children = [];
    if (rest.startsWith('(') || rest.startsWith('[')) {
      // find matching close
      let depth = 0, end = -1;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '(' || rest[i] === '[') depth++;
        else if (rest[i] === ')' || rest[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
      }
      const inner = end > 0 ? rest.slice(1, end) : rest.slice(1);
      const after = end > 0 ? rest.slice(end + 1).trim() : '';
      children = parsePieces(splitSteps(inner, WEAK_SEP), hint === 'recovery' ? null : hint, opts);
      if (after) {
        const tail = splitSteps(after.replace(/^[,;]\s*/, ''), WEAK_SEP)
          .flatMap((p) => parseSegment(p, 'recovery', opts));
        children.push(...tail);
      }
    } else if (rest) {
      children = splitSteps(rest, WEAK_SEP).flatMap((p) => parseSegment(p, hint === 'recovery' ? null : hint, opts));
    }
    if (count > 1 || children.length) {
      return [{ type: 'repeat', count: Math.max(1, count), steps: children, ...(children.length ? {} : { open: true }) }];
    }
  }
  const t = str.match(TRAILING_REPEAT_RE);
  if (t && hasQuantity(t[1])) {
    const count = parseInt(t[2] || t[3], 10);
    const children = splitSteps(t[1], WEAK_SEP).flatMap((p) => parseSegment(p, hint, opts));
    return [{ type: 'repeat', count, steps: children }];
  }
  return [parseStep(str, hint, opts)];
}

function detectUnit(text) {
  const mi = (text.match(/\/\s*mi(?:le)?\b|\d\s*(?:mi|miles?)\b/gi) || []).length;
  const km = (text.match(/\/\s*km\b|\d\s*(?:km|k)\b/gi) || []).length;
  return mi > km ? 'mi' : 'km';
}

/**
 * Parse pasted Runna text into { name, unit, steps, warnings }.
 * opts: { tolerance } (seconds per km either side of a single target pace)
 */
export function parseSession(text, options = {}) {
  const raw = normalize(text);
  const unit = detectUnit(raw);
  const opts = { ...DEFAULT_OPTS, ...options, unit };
  const lines = raw.split('\n');
  const steps = [];
  const warnings = [];
  let name = null;
  let pendingHint = null;
  let openBlock = null; // repeat waiting for child lines
  let openBlockIndented = false;
  let lastStep = null;

  const attachNote = (txt) => {
    if (!lastStep) return false;
    const pace = paceTarget(txt, opts.tolerance, unit);
    if (pace && !lastStep.pace) lastStep.pace = pace;
    lastStep.text = [lastStep.text, txt.replace(/[.\s]+$/, '')].filter(Boolean).join('. ');
    if (/\bwalk/i.test(txt)) lastStep.walk = true;
    return true;
  };

  // A first line that starts with a word (not a number, header or repeat), has no pace and is
  // followed by more lines is the session title — even if it contains a number ("Threshold 400s").
  const nonEmpty = lines.filter((l) => l.trim());
  if (nonEmpty.length > 1) {
    const first = nonEmpty[0].trim();
    if (/^[A-Za-z]/.test(first) && !HEADER_RE.test(first) && !REPEAT_RE.test(first) && !hasPace(first) && !/[,;:]/.test(first) && first.length <= 60) {
      name = first.replace(/[.\s]+$/, '');
      lines.splice(lines.indexOf(nonEmpty[0]), 1);
    }
  }

  for (const original of lines) {
    if (!original.trim()) continue;
    const indented = /^(\s{2,}|\t|\s*[-*•·]\s)/.test(original);
    let line = original.trim().replace(/^[-*•·]\s*/, '').replace(/^\d+[.)]\s+(?=\D)/, '');
    let hint = null;
    let header = null;
    const h = line.match(HEADER_RE);
    if (h) {
      header = h[1];
      hint = kindFromHeader(header);
      line = line.slice(h[0].length).trim();
      // A bare "Rest" / "Recovery" line is itself a step with no amount; keep the word.
      if (!line && hint === 'recovery') line = '';
    }

    if (header && !line) {
      if (!steps.length && !name && hint === 'work') name = original.trim().replace(/[.:\s]+$/, '');
      pendingHint = hint;
      if (hint !== 'recovery') { openBlock = null; }
      continue;
    }
    if (!hint && pendingHint === 'warmup' && REPEAT_RE.test(line)) pendingHint = null; // the set starts
    hint = hint || pendingHint;
    if (header) pendingHint = null;

    // Lines with no amount: title, or extra detail for the previous step.
    if (!hasQuantity(line) && !REPEAT_RE.test(line)) {
      if (!steps.length && !name && !hasPace(line)) { name = line.replace(/[.:\s]+$/, ''); continue; }
      if (attachNote(line)) continue;
      warnings.push(`Ignored: “${line}”`);
      continue;
    }

    // Close an open repeat block when an un-indented line follows indented children,
    // or when a new non-rest section header starts.
    if (openBlock) {
      const closesByHeader = header && hint !== 'recovery';
      const closesByIndent = openBlockIndented && !indented;
      if (closesByHeader || closesByIndent) { openBlock = null; }
    }

    const pieces = splitSteps(line, STRONG_SEP);
    for (const piece of pieces) {
      const items = parseSegment(piece, hint, opts);
      for (const item of items) {
        if (item.type === 'repeat' && item.open) {
          delete item.open;
          steps.push(item);
          openBlock = item;
          openBlockIndented = false;
          lastStep = null;
          continue;
        }
        if (openBlock) {
          openBlock.steps.push(item);
          if (indented) openBlockIndented = true;
        } else if (
          item.type === 'step' && item.kind === 'recovery' && header && /rest|recovery/i.test(header) &&
          steps.length && steps[steps.length - 1].type === 'repeat' &&
          !endsWithRecovery(steps[steps.length - 1])
        ) {
          // Runna lists the between-rep rest as its own "Rest" line right after the set.
          steps[steps.length - 1].steps.push(item);
        } else {
          steps.push(item);
        }
        if (item.type === 'step') lastStep = item;
        else lastStep = lastLeaf(item);
      }
    }
  }

  if (!name) name = guessName(steps);
  cleanup(steps, warnings);
  return { name, unit, steps, warnings };
}

function endsWithRecovery(rep) {
  const last = rep.steps[rep.steps.length - 1];
  return last && last.type === 'step' && last.kind === 'recovery';
}

function lastLeaf(item) {
  if (item.type === 'step') return item;
  for (let i = item.steps.length - 1; i >= 0; i--) {
    const l = lastLeaf(item.steps[i]);
    if (l) return l;
  }
  return null;
}

function cleanup(items, warnings) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === 'repeat') {
      cleanup(it.steps, warnings);
      if (!it.steps.length) {
        warnings.push(`Repeat x${it.count} had no steps — removed.`);
        items.splice(i, 1);
      }
    } else if (it.end === 'open') {
      warnings.push(`Couldn't find a distance or time in “${it.text}” — set to open (lap button).`);
    }
  }
}

function guessName(steps) {
  let reps = 0, hasRepeat = false;
  for (const s of steps) if (s.type === 'repeat') { hasRepeat = true; reps += s.count; }
  if (hasRepeat) return `Intervals (${reps} reps)`;
  return 'Runna session';
}
