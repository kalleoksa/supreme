# whiteout

An arcade downhill snowboarding game that runs in a browser.

Codename only — the shipping title is undecided. It lives in one constant,
`TITLE` in `src/app/config.ts`.

Inspired by the feel of late-90s arcade snowboarding games, _Supreme
Snowboarding_ (Housemarque, 1999) in particular. It is an original work: its own
tracks, art, characters and name, sharing no assets or code with anything else.

## Why a web game

The goal is to be playable without going through an app store. One static build
is simultaneously the browser version, a macOS "Add to Dock" app, and an iOS
Home Screen web app. No store review, no signing, no gatekeepers.

Milestone 1 targets desktop browsers only. Four disciplines are in place from the
first commit so that adding phones later is content-and-UI work rather than an
architecture rewrite: the simulation is delta-time driven at a fixed timestep,
device pixel ratio is capped at 1.5, draw calls stay under 50 with all scatter
instanced, and input sits behind an interface a touch backend can implement.

## Design pillars

Three things carried over from what made those games good, and they are the
things to protect:

1. **Three input verbs, high expressive ceiling.** Carve, jump, trick modifier.
   Not twelve buttons. Depth comes from combination and timing.
2. **The charged ollie.** Hold to charge, and releasing at the lip of a terrain
   crest gives full power with no charge at all — timing against the mountain
   substitutes for charge duration. Risk and reward in four lines of code.
3. **Freedom of line.** Slopes wide enough for genuinely competing routes, with
   shortcuts worth 0.8–2.0 s that cost 3+ s when they go wrong. Not a corridor.

And one thing deliberately fixed rather than inherited: the original's trick
system was widely called illegible. Here the timing-critical information goes
into world space, on the snow — a predicted "release here" band ahead of the
rider, a time-to-ground bar so you can see whether a rotation will finish, and
named crash reasons instead of silent failure.

## Getting started

```
npm install
npm run dev
```

Controls: arrows or WASD to steer (up = tuck, down = scrub), **Space** to charge
and pop, **Shift** to carve, **K** for the trick modifier. A gamepad works too.
Deliberately not the original's Ctrl/Alt — browsers and assistive tech intercept
both.

## Commands

|                                |                                                       |
| ------------------------------ | ----------------------------------------------------- |
| `npm run dev`                  | Vite dev server with HMR                              |
| `npm run test`                 | Unit tests (Node, no GPU needed)                      |
| `npm run test:e2e`             | Playwright browser tests                              |
| `npm run ci`                   | Everything: typecheck, lint, format, unit, build, e2e |
| `node tools/capture-views.mjs` | Diagnostic screenshots of a track from rider height   |

## Architecture

One rule holds the whole thing up:

> **The simulation is a pure function of `(state, input, terrain, dt)`.** No
> Three.js, no DOM, no wall clock.

`src/sim`, `src/track`, `src/race` and `src/core` obey it; `src/render`, `src/hud`
and `src/audio` read from them and never the reverse. It is enforced twice, by an
oxlint rule and by `tests/unit/architecture.test.ts`, because it pays for itself
repeatedly: most of the game — board physics, landing grading, the whole race — is
testable in Node with no GPU, ghost recording falls out for free, and a touch
input backend is one new file.

```
src/
  app/      loop, clock, config, wiring
  core/     math, vectors, seeded rng, noise, hashing
  input/    normalized input state; keyboard and gamepad backends
  sim/      heightfield sampler, board physics, tricks, landing, race   [pure]
  track/    track spec and the deterministic spec -> heightfield generator
  render/   three.js: terrain, rider, camera, environment
  hud/      DOM overlay
```

### Two decisions worth knowing before editing terrain

**Height sampling reads the rendered triangle, not a bilinear patch.** A bilinear
patch and the mesh built from the same posts disagree by up to ~12 cm at the
centre of a twisted 1 m cell, and that error _is_ the board visibly floating or
sinking. `Heightfield.height()` and `buildChunkGeometry()` share one global
diagonal split, and a unit test raycasts the real geometry to prove they agree to
1e-4 m. If you change either, that test is the thing keeping you honest.

**Normals come from interpolated per-post normals**, not from the patch
derivative — that derivative is discontinuous across cell boundaries and reads in
play as a tick in board orientation every metre.

### Steering is a commanded radius, not a commanded yaw rate

The obvious way to make a board feel heavy is a yaw rate that falls as speed rises.
Don't. It has a failure that only shows up in play: turning scrubs speed, lower
speed raises the turn rate, and the higher rate scrubs more speed. One held input
spirals the board into a stationary spin — measured on the test slope, a
one-second carve at 87 km/h rotated it 134° and left it at 2 km/h facing uphill,
with no way back.

`omega = speed / radius` inverts the coupling so it cannot run away, and it is
closer to how a board really behaves, since edge angle sets radius rather than
rate. `PIVOT_RATE` is what keeps a stopped rider able to turn around at all.

Relatedly, off-edge lateral grip is deliberately _loose_ (`BASE_LAT_FRICTION`
1.3, not 5). High off-edge grip made carving nearly invisible — the board railed
whether or not you asked it to — and let a rider turned across the fall line
hockey-stop to a permanent halt. The `SKID_ALIGN_RATE` weathervane, scaled by
skid so it never fights a clean carve, is what stops a skidding board sliding
sideways down the whole mountain.

### The carve has to cost something

Carve drag scales with **turn rate**, not with edge engagement alone. A flat cost for
having the edge down makes carving strictly worse than not carving — a one-second
full carve at 87 km/h already loses 87→70 from lateral scrubbing, and a 0.9/s decay
on top takes the exit to ~28. Scaling by how hard the board is turning means an edge
running nearly straight is cheap and a violent direction change is expensive, which
is what makes a good line faster than a brutal one.

The reward is the pump: release a committed edge coming out onto the fall line and it
pays speed back. Measured entering a bend 60° off the fall line on a 20% slope:

| line                             | exit      | off fall line |
| -------------------------------- | --------- | ------------- |
| carve, released on the fall line | 90.0 km/h | 7°            |
| steering only, no edge           | 88.7 km/h | 14°           |
| released too early (a flick)     | 86.8 km/h | 48°           |
| held past the fall line          | 68.4 km/h | 53°           |

The good-versus-skid margin is thinner than ideal and is on the list for the feel
pass. A speed advantage decays back toward terminal velocity, so the pump's value is
transient — it compounds across linked turns rather than showing up after a long
runout.

### Keyboard input had never worked

Worth recording as a process lesson. `InputRouter.poll()` was never called anywhere, so
the router had no frame time origin, every button edge failed its tick-window
comparison, and **no key press had ever reached the simulation**. It survived three
phases because every e2e test drove the game through `simulate()`, which writes a
scripted `InputState` directly and bypasses the router entirely.

There are now tests that press a real key and assert the simulation responds. If you add
gameplay tests, at least one of them must go through the real input path.

### Terrain is tuned against measurements

Crest spacing along the fall line, grade distribution, and stall/uphill fractions
are all asserted in `tests/unit/terrainGeneration.test.ts`. This matters because
the two ends pull against each other: crest density comes from short-wavelength
relief, and too much of it makes the descent ripple uphill. Both ends are pinned,
so tuning one cannot silently wreck the other — and a "tidy up the noise" commit
cannot quietly leave the jump mechanic with nothing to bite on.

Terrain generation is also restricted to `+ - * /` and `sqrt`: ECMA-262 leaves
the precision of `exp`/`sin`/`cos`/`pow` implementation-defined, so avoiding them
keeps the golden height hash valid across JS engines. The board physics does use
`Math.exp` for frame-rate-independent decay, which is fine — ghosts are recorded
as transforms rather than replayed inputs, so cross-engine bit-exactness is not
required there.

## Status

Milestone 1, a playable vertical slice: one track, one boarder, carving, jumps
and tricks, a timer and a finish line.

- [x] Phase 0 — scaffold, renderer, context-loss handling, CI
- [x] Phase 1 — fixed-timestep loop, heightfield sampler, chunked terrain
- [x] Phase 2 — input, first ride: it plays, at ~87 km/h
- [x] Phase 3 — carve model: a cost, a reward, and a way to notice it
- [x] Phase 4 — charged ollie: the mechanic this was all built around
- [ ] Phase 5 — tricks and landing
- [ ] Phase 6 — the authored track
- [ ] Phase 7 — ghost recording
- [ ] Phase 8 — audio, comfort settings, feel pass

Phase 8 is not polish. It is where the game becomes good or doesn't, and it is
gated on seven concrete criteria — chief among them that holding a five-second
carve through a bend comes out _faster_ than the straight line, and that
releasing the jump at a crest with zero charge sends you as high as a full
standing charge.
