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
| `npm run validate`             | Grade, drop and launch-feature report per track       |
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
  track/    TrackSpec, the pure spec -> heightfield generator, the validator
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

### Landings name their failure

The loudest historical complaint about the game this descends from was that its trick
system was illegible — "far too easy to get it wrong". The deeper problem was not
difficulty: a failure told you nothing. You lost your points with no idea which of four
things you had done wrong.

So the grader knows _why_ and says so. `UNDER-ROTATED` and `SIDEWAYS` are opposite
corrections, and being told which one you made is the difference between improving and
guessing. Every reason the grader can produce has display text, and a test asserts that —
a reason the HUD cannot name is worse than useless.

The grade is a weighted sum of flatness, alignment and rotation, then **multiplied by its
worst component**. A pure sum was too forgiving: a landing completely sideways at 22 km/h
still scored 0.65 and graded Clean, because the other two components masked it. You
cannot land clean while pointing 90° off your direction of travel, however good the rest
of it was.

### Keyboard input had never worked

Worth recording as a process lesson. `InputRouter.poll()` was never called anywhere, so
the router had no frame time origin, every button edge failed its tick-window
comparison, and **no key press had ever reached the simulation**. It survived three
phases because every e2e test drove the game through `simulate()`, which writes a
scripted `InputState` directly and bypasses the router entirely.

There are now tests that press a real key and assert the simulation responds. If you add
gameplay tests, at least one of them must go through the real input path.

### A track is data, compiled by a pure function

Authoring truth is a `TrackSpec` (`src/track/TrackSpec.ts`); runtime truth is a
`Float32Array` heightfield. `src/track/generate.ts` compiles one to the other,
deterministically, with no dependencies beyond `core`.

The composition order **is** the format:

1. `grade` — integrate a grade profile into a centreline elevation. Authoring
   grades rather than absolute heights means editing one section leaves everything
   downhill of it consistent.
2. `cross` — sweep a cross-section: a near-flat ridable corridor, then shoulders
   that climb to turn back a wandering rider.
3. `stamps` — analytic features, each writing its falloff into a feature mask.
4. `noise` — detail bands multiplied by `1 - featureMask`.
5. `smoothing` — weighted by `1 - featureMask` so stamp interiors survive.
6. `surfaces` — materials and flags from slope, position and noise.

**Step 4 is the one that matters.** Detail noise suppressed inside authored
features and amplified out on the wild shoulders is the difference between a
mountain a player can read and a field of bumps that drowns every deliberately
placed lip. A unit test pins it: generate the same spec with and without the noise
bands, and the heights must agree inside a stamp while differing by a metre on the
open shoulder.

Because the generator is a pure function called from a module Vite already hot
reloads, editing a track re-bakes the terrain in the browser — the loop that
decides whether a track is fun needs no build step and no baker script. The tuning
slope was ported to this format against its **golden height hash**, so the spec
provably expresses the same terrain rather than something that merely looks similar.

`npm run validate` reports what tuning actually needs:

```
testslope: 1164 m of course, 282 m vertical
  median grade 22.7%, uphill 1.7%, 10 launch features
  shallowest 20 m -1.2% at z=986, steepest 62.7% at z=706
  no issues
```

Errors mean a run cannot continue (a section shallow enough to stall, a boundary
off the heightfield); warnings mean it is probably not what the author intended but
is rideable, so tuning is never blocked. One subtlety worth knowing: a roller's
approach ramp genuinely climbs, and raw grade cannot tell that apart from a flat
section that kills a run — so the stall check consults the feature mask. That was
found by the check firing on the tuning slope at z=986, which is exactly the
leading edge of the roller stamped at z=1010.

### Comfort settings ship, and are not gated behind a transition

Motion sickness tolerance varies enormously, and a camera that makes someone ill is
unplayable for them no matter how good the game is. Four knobs — field-of-view
widening, shake, camera distance, camera roll — reachable from the riding HUD with no
menu, since someone who starts feeling queasy thirty seconds in should not have to
quit to find the fix. Camera roll defaults to **zero**: it is the single strongest
nausea trigger in a chase camera, so it is opt-in only. When the OS asks for reduced
motion, shake starts at zero and FOV-with-speed starts off.

The panel is shown with `display`, not a fade, and that is a bug fix rather than a
style preference. The first version transitioned opacity and visibility, and under
software GL it never appeared at all: CSS transitions advance on the document
animation timeline, and a frame that takes hundreds of milliseconds starves it — the
transitions sat at `currentTime: 0` more than a second after the class changed. The
panel was interactive and invisible. A player on a weak GPU is the most likely person
to need comfort settings and the least likely to be able to see a faded-in panel, so
this element trades the nicety for certainty. The results panel got the same
treatment, because a run's finish time is not something to risk on a transition.

Worth knowing if you write tests here: **Playwright's `toBeVisible()` does not catch
this** — its visibility rules ignore `opacity: 0`. Only reading the computed style
does, which is what those tests now do.

Stored settings are clamped on load rather than trusted. A hand-edited
`distanceScale` of 500 would put the camera in orbit with no visible cause.

### Trees are not cleared from the racing line

This is the design rule most likely to be "tidied up" by someone reasonably assuming
a racing line should be clear. Obstacles inside the ridable area are what turn a
240 m wide face into a set of real route choices; without them, freedom of line
means only that the corridor is wide. So corridor density is scaled down (0.12x),
never to zero — and props are excluded around authored launch features, because a
tree in a landing zone punishes the player for doing exactly what the terrain
invited.

The collision asymmetry follows from the same argument. Below
`OBSTACLE_CRASH_SPEED` a contact pushes the rider clear, deflects and slows them; at
or above it, the run is over for `CRASH_RECOVER` seconds. If every contact were a
crash, the only correct play would be to avoid the trees entirely and the routes
they exist to create would stop being routes.

Getting the _shape_ of that penalty right mattered more than its magnitude, and a
measurement is what showed it. A flat per-tick multiplier compounds while a rider
stays in contact: the headless bot came down the mountain with **8,551 scrape events
at a mean speed of 9.1 m/s**, against 28.5 with no trees. Trees had stopped being an
obstacle and become a grinder. Scaling the penalty by the speed _into_ the trunk
means sliding along one is free and only the genuine impact is paid for — after
which the bot runs 57.6 s at 20.2 m/s, against 40.8 s on bare terrain. Both halves
are asserted, because trees have to cost something without costing the run.

3,628 props render in **2 draw calls** via `InstancedMesh`. Geometry is built in
code from cones and cylinders, like the rider: no modelling pipeline, because art
must not be able to block work on how the ride feels.

### Race progress is a baked geodesic field, not a centreline

Projecting the rider onto a spline down the middle of the course would contradict
the freedom-of-line pillar outright: it produces nonsense the moment someone takes
a branch, cuts a bowl or rides a shoulder, and it makes "shortcut or cheat" an
unanswerable question.

Instead `src/race/ProgressField.ts` floods the in-bounds terrain with geodesic
distance to the finish — Dijkstra on a 4 m grid, no diagonal corner-cutting — and
normalizes it. Progress is then a bilinear lookup that works on _any_ line. One
artifact answers a surprising number of questions:

| Question                    | Answer                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| How far along am I?         | `progressAt(x, z)`, valid on every route                                                                                  |
| Shortcut or cheat?          | The flood respects the mask, so cutting off-course earns no progress at all — it _is_ out of bounds, with no special case |
| Where is the split?         | A progress threshold, not a trigger volume a wide face lets you ride around                                               |
| Where does its banner go?   | Traced from the `progress == threshold` isoline, so the marker cannot drift out of sync with the checkpoint               |
| Which way is down-course?   | `−∇progress`: the wrong-way arrow and the return-to-course arrow, free                                                    |
| Is the course even ridable? | `reachable` — a broken route fails the build, not a play session                                                          |

The finish is interpolated _inside_ the physics step
(`t = tPrev + dt·(threshold − pPrev)/(p − pPrev)`). Without that the clock
quantizes to the 8.3 ms timestep, which is 0.2 m of course at speed — enough for
two identical runs to report different times.

Out of bounds gives three seconds of vignette and countdown, then puts the rider
back at the furthest valid pose from a 10 Hz ring buffer. **The clock keeps
running** — that is the whole punishment. No menu, no fade, no confirmation: an
interruption breaks flow far worse than losing three seconds does.

Containment is geometry, never an invisible wall. The cross profile's rising
shoulders are what turn a wandering rider back, and `tests/unit/botRun.test.ts`
asserts a bot gets down the whole course needing at most one recovery — so a
shoulder that stops doing its job fails a test rather than a run.

### Ghosts record transforms, not input

Replaying a recorded input stream through the same simulation would cost a few
hundred bytes a run and verify the physics for free. It is not safe: ECMA-262
leaves the precision of `sin`, `cos`, `pow` and `exp` implementation-defined, and
the board physics uses `Math.exp` for frame-rate-independent decay. So an input
replay is not guaranteed bit-identical across browsers, or across two versions of
one browser — and a ghost that silently desyncs on someone else's machine is worse
than no ghost.

`src/race/GhostRecorder.ts` stores where the rider _was_, at 20 Hz: position as
float32, riding pose as an int16 quaternion, trick rotation kept separate so a
viewer can spin the board without spinning the camera, speed, and a flags byte.
25 bytes a frame, ~45 KB for a 90-second run. Recording is driven from the
simulation step rather than the frame, so a 30 fps machine captures the same ghost
a 144 Hz one does — asserted, along with the wire format round-trip.

The determinism disciplines stay anyway (fixed timestep, seeded integer noise, no
wall clock in the sim). They cost nothing and are what a verified leaderboard would
need later; this just does not depend on them today.

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
- [x] Phase 5 — tricks and landing, with named failure reasons
- [ ] Phase 6 — the authored track
      — done: race logic (progress field, countdown, splits, sub-frame finish,
      out-of-bounds recovery, stored best), the `TrackSpec` format, the generator,
      the validator, and instanced scatter with collision. Remaining: authoring
      `alpine01` with its three route choices — which the feel gate below
      deliberately blocks, because content on a bad ride is wasted content.
- [x] Phase 7 — ghost recording (transform capture; playback is M2)
- [ ] Phase 8 — audio, tuning, feel pass (comfort settings done)

Phase 8 is not polish. It is where the game becomes good or doesn't, and it is
gated on seven concrete criteria — chief among them that holding a five-second
carve through a bend comes out _faster_ than the straight line, and that
releasing the jump at a crest with zero charge sends you as high as a full
standing charge.
