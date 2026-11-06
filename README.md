# Runna → WorkOutDoors

A small static web app, hosted on GitHub Pages, that puts a structured **Runna** session onto your wrist in the **WorkOutDoors** Apple Watch app. Reps, recoveries, target paces and your route all carry across.

Everything runs in the browser. Nothing is uploaded.

## How it works

Neither app has an official bridge to the other:

- **Runna** has no session export. It only syncs to Garmin, COROS and Apple's own Workout app.
- **WorkOutDoors** imports **routes** (GPX, and FIT/TCX since v6), and it alerts you at the waypoints and course points on a route. It does **not** import structured workouts. You build interval schedules by hand in its iPhone app.

So the app works like this:

1. **Session.** Paste the session text from Runna. The parser understands Runna's formats:
   - Section lines: `Warm-up. 800m at conversational pace. No faster than 7:15/km.`, `Set. Repeat x3: …`, `Rest. 90s walking rest`, `Cool down…`
   - The one-line arrow form: `1.2km warm-up → Set: 3× (300m @ 6:15/km + 300m recovery) → …`
   - Free text, including km or miles, pace ranges and nested repeats.

   You can then fix anything in the step editor.
2. **Route** (optional). Attach a GPX or TCX route. The app puts a cue at the start of every step plus a finish cue, for example `Rep 3/6 400m @ 4:05–4:15` or `Walk 90s`. If the route is shorter than the workout, it is extended as repeated laps or as an out-and-back.
3. **Export:**
   - **FIT course** or **GPX**: the route with the step cues. Records are timed to your planned paces, so a virtual partner runs the session. Open it in WorkOutDoors on iPhone.
   - **Interval schedule card**: the exact steps to enter in *WorkOutDoors → Settings → Interval Schedules*: end condition, pace range and repeat blocks. WorkOutDoors has no nested repeats, so nested repeats are unrolled for you.
   - **FIT workout**: the standard structured-workout file (steps, repeats, speed targets). It works with Garmin, COROS and others, and will work with WorkOutDoors if it ever adds FIT workout import.
   - **Share link / .json**: send the session to your phone.

### Accuracy notes

- Runna gives a single pace per step. WorkOutDoors wants a range, so the app uses target ± 5 s per km (or per mile). You can change this under *Pace assumptions*.
- "No faster than X" becomes the range X to X + 1:00.
- Steps measured by time, such as a 90s walk, are placed on the route by estimating how far you'll travel at your easy or walk pace. Those cues are marked ≈. Distance steps are exact.

## Development

No build step. The site is plain ES modules.

```sh
npm install     # only needed for tests (Garmin FIT SDK used to verify generated files)
npm test        # parser, route, GPX and FIT tests
npm start       # serve locally on http://localhost:8080
```

| File | Purpose |
| --- | --- |
| `js/parse.js` | Runna text → workout model |
| `js/model.js` | Workout model, formatting, segments, WorkOutDoors schedule flattening |
| `js/route.js` | GPX/TCX parsing, route extension, cue placement, planned timing |
| `js/gpx.js` | GPX writer (track + waypoints) |
| `js/fit.js` | FIT encoder: course files (records + course points) and workout files |
| `js/app.js` | UI |

## Deploying

`.github/workflows/pages.yml` runs the tests and deploys to GitHub Pages on every push to `main` or `master`. To turn it on, go to the repository's **Settings → Pages** and set **Source** to **GitHub Actions**.

Not affiliated with Runna or WorkOutDoors.
