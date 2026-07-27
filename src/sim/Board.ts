import { angleDelta, approach, clamp, clamp01, expDecay, lerp } from '../core/math.js';
import { WORLD_UP, cross3, dot3, normalize3, projectOntoPlane3, v3 } from '../core/vec3.js';
import type { InputState } from '../input/InputState.js';
import { TrickState, type BoardState } from './BoardState.js';
import type { BoardTuning } from './boardTuning.js';
import { EventBuffer } from './events.js';
import type { TerrainSampler } from './Terrain.js';

const GRAVITY = 9.81;

/**
 * Kinematic arcade board physics.
 *
 * ## Why not a rigid-body solver
 *
 * Because arcade feel *is* non-physical forces, and a solver spends its effort
 * fighting them. Sampling the heightfield analytically is O(1) and exact, it avoids
 * the internal-edge artifacts a heightfield collider produces (which read in play as
 * the board catching on nothing), and it leaves every scalar directly tunable. A
 * physics engine earns its place later for props, not for the ride.
 *
 * ## Determinism contract
 *
 * This function reads only `state`, `input`, `terrain` and `dt`. It must never call
 * `Date.now`, `performance.now` or `Math.random`, must never touch the DOM, and must
 * never depend on frame rate -- `dt` is always the fixed timestep, and every decay
 * goes through `expDecay`, which is analytic in dt so 30 fps and 120 fps agree
 * exactly. `architecture.test.ts` enforces the first three, `board.test.ts` the last.
 *
 * ## Step order is frozen
 *
 * Reordering changes results. That is allowed, but it invalidates recorded times, so
 * it should break the golden hash test and be done deliberately.
 *
 * ## Frames
 *
 * Grounded motion is solved in the board frame (forward / right on the contact
 * plane) because that is where carving, drag and braking are naturally expressed.
 * Airborne motion is solved in world space, because a contact plane belonging to
 * ground tens of metres below has nothing to do with a ballistic arc.
 */

/** Scratch vectors. Module-level and reused: the step loop allocates nothing. */
const nrm = v3();
const fwd = v3();
const rgt = v3();
const slopeAccel = v3();

export interface BoardStepContext {
  tuning: BoardTuning;
  events: EventBuffer;
  /**
   * Analog carve engagement, 0..1, when the backend offers it (a gamepad trigger);
   * 1 while held on a keyboard. Kept out of `InputState` so the digital latch stays
   * the thing the simulation branches on and partial edge stays a bonus.
   */
  carveAnalog: number;
}

export function createStepContext(tuning: BoardTuning): BoardStepContext {
  return { tuning, events: new EventBuffer(), carveAnalog: 1 };
}

export function stepBoard(
  state: BoardState,
  input: InputState,
  terrain: TerrainSampler,
  dt: number,
  ctx: BoardStepContext,
): void {
  const t = ctx.tuning;

  state.tick++;
  state.time += dt;

  // ----------------------------------------------------------------- 1. Sample
  // `support()` rather than `height()`, always. Today it forwards to the ground;
  // the day rooftops and ridable logs exist, this call site will not change.
  const ground = state.ground;
  terrain.support(state.pos.x, state.pos.z, state.pos.y, t.SNAP_TOL, ground);
  nrm.x = ground.nx;
  nrm.y = ground.ny;
  nrm.z = ground.nz;
  state.slopeAngle = Math.acos(clamp(ground.ny, -1, 1));

  // ----------------------------------------------------- 2. Ground state / snap
  const surfaceY = ground.y + t.RIDE_HEIGHT;
  state.clearance = state.pos.y - surfaceY;

  const intoSurface = dot3(state.vel, nrm);
  // Grounded requires being close AND not moving away from the surface. Without the
  // second test the board re-grounds on the very tick it pops, eating the jump.
  const grounded = state.clearance <= t.SNAP_TOL && intoSurface <= 0.5;

  if (grounded) {
    // Hard snap, not a spring.
    //
    // A physics suspension spring adds bounce, jitter, two more tunables, and --
    // fatally -- a fuzzy ground/air boundary, which is exactly the thing the charged
    // ollie measures. The compression a player reads as suspension is a
    // critically-damped spring in RiderView, on the render side, where it cannot
    // touch the timing window.
    state.pos.y = surfaceY;
    if (intoSurface < 0) {
      state.vel.x -= nrm.x * intoSurface;
      state.vel.y -= nrm.y * intoSurface;
      state.vel.z -= nrm.z * intoSurface;
    }
    state.grounded = true;
    state.airTime = 0;
    state.apexHeight = 0;
  } else {
    state.grounded = false;
    state.airTime += dt;
    if (state.clearance > state.apexHeight) state.apexHeight = state.clearance;
  }

  // ------------------------------------------------------------ 3. Board basis
  fwd.x = Math.cos(state.yaw);
  fwd.y = 0;
  fwd.z = Math.sin(state.yaw);

  if (state.grounded) {
    // Project the heading onto the contact plane. On a slope the board's forward
    // axis is not the horizontal heading, and using the horizontal one would leak
    // vertical velocity into the longitudinal channel on every steep section.
    projectOntoPlane3(fwd, fwd, nrm);
    if (normalize3(fwd, fwd) < 1e-6) {
      // Degenerate only on a vertical face, where the heading is parallel to the
      // normal. Fall back to the horizontal heading rather than emitting NaN: this
      // is the normalize-a-zero-vector bug that makes riders silently vanish.
      fwd.x = Math.cos(state.yaw);
      fwd.y = 0;
      fwd.z = Math.sin(state.yaw);
      normalize3(fwd, fwd);
    }
    cross3(rgt, fwd, nrm);
  } else {
    cross3(rgt, fwd, WORLD_UP);
  }
  normalize3(rgt, rgt);

  state.forward.x = fwd.x;
  state.forward.y = fwd.y;
  state.forward.z = fwd.z;
  state.right.x = rgt.x;
  state.right.y = rgt.y;
  state.right.z = rgt.z;

  // ------------------------------------------------------- 4. Edge engagement
  const carveStrength = input.carve.held ? clamp01(ctx.carveAnalog) : 0;
  // Smoothed rather than binary: an instant full edge feels like a switch, and the
  // pump-on-release reward needs a continuous quantity to scale by.
  const edgeTarget = carveStrength * (input.steerX === 0 ? 1 : Math.sign(input.steerX));
  state.edge += (edgeTarget - state.edge) * (1 - expDecay(t.EDGE_RATE, dt));
  if (carveStrength > 0) state.edgeHoldTime += dt;
  else state.edgeHoldTime = 0;

  const tucking = Math.max(0, input.steerY);
  const braking = Math.max(0, -input.steerY);
  const speed = Math.hypot(state.vel.x, state.vel.z);

  // ------------------------------------------------------------- 5. Steering
  if (state.crashTimer > 0) {
    // No authority mid-crash. Recovery is on a timer, and the clock keeps running.
    state.yawRate = 0;
  } else if (state.grounded) {
    // Commanded turn radius, tightened by the edge. Yaw rate then follows from speed:
    // omega = v / r. See the note on TURN_RADIUS_* -- expressing this as a rate that
    // falls with speed creates a spin-out feedback loop, because turning scrubs speed
    // and lower speed would raise the rate.
    const radius = lerp(t.TURN_RADIUS_LOOSE, t.TURN_RADIUS_CARVE, carveStrength);
    let turnRate = Math.min(speed / radius, t.YAW_RATE_MAX);

    // A speed-independent pivot term, so a stopped rider can always turn around.
    turnRate += t.PIVOT_RATE;

    turnRate *= lerp(1, t.TUCK_TURN_MUL, tucking);
    if (state.trickState === TrickState.Charging) turnRate *= t.CHARGE_TURN_MUL;

    // Approach the desired rate rather than snapping to it, so steering has mass.
    state.yawRate = approach(state.yawRate, input.steerX * turnRate, t.YAW_ACCEL * dt);
  } else {
    // Airborne: enough authority to line the board up for a landing, no more.
    state.yawRate = input.steerX * t.AIR_YAW_RATE;
  }
  state.yaw += state.yawRate * dt;

  // Weathervane. A skidding board presents its broad side to the snow, and the drag
  // imbalance rotates it toward the direction it is actually travelling. Scaled by
  // skid from the previous step, so a clean carve is unaffected and this only ever
  // rescues a board that is already sliding.
  if (state.grounded && speed > 2 && state.skid > 0.02) {
    const travelYaw = Math.atan2(state.vel.z, state.vel.x);
    const align = angleDelta(state.yaw, travelYaw);
    state.yaw += align * (1 - expDecay(t.SKID_ALIGN_RATE * state.skid, dt));
  }

  if (state.grounded) {
    stepGrounded(state, input, ctx, dt, tucking, braking, carveStrength);
  } else {
    stepAirborne(state, ctx, dt);
  }

  // ------------------------------------------------------------ 6. Integrate
  // Semi-implicit Euler; the ground snap on the next step is the position
  // correction. At 42 m/s and dt = 1/120 the board covers 0.35 m per step against
  // 1 m cells, so terrain tunnelling is not a concern.
  state.pos.x += state.vel.x * dt;
  state.pos.y += state.vel.y * dt;
  state.pos.z += state.vel.z * dt;

  if (state.crashTimer > 0) {
    state.crashTimer = Math.max(0, state.crashTimer - dt);
    if (state.crashTimer === 0 && state.trickState === TrickState.Crashed) {
      state.trickState = state.grounded ? TrickState.Idle : TrickState.Air;
    }
  }

  // ------------------------------------------------- 7. Orientation sampling
  // Nose and tail surface heights, for the pitch RiderView applies. Deliberately
  // presentation-only: letting two-point contact drive the forces makes the board
  // pitch into terrain and turns the ground/air test ambiguous, and the ollie needs
  // that test crisp.
  const nfx = Math.cos(state.yaw);
  const nfz = Math.sin(state.yaw);
  state.noseY = terrain.height(state.pos.x + nfx * t.NOSE_LEN, state.pos.z + nfz * t.NOSE_LEN);
  state.tailY = terrain.height(state.pos.x - nfx * t.TAIL_LEN, state.pos.z - nfz * t.TAIL_LEN);
}

function stepGrounded(
  state: BoardState,
  input: InputState,
  ctx: BoardStepContext,
  dt: number,
  tucking: number,
  braking: number,
  carveStrength: number,
): void {
  const t = ctx.tuning;
  const ground = state.ground;

  let vLong = dot3(state.vel, fwd);
  let vLat = dot3(state.vel, rgt);

  // --- Gravity along the slope. Projecting it onto the contact plane leaves exactly
  // the component that accelerates you down the fall line.
  const gy = -GRAVITY * t.GRAVITY_SCALE;
  slopeAccel.x = -nrm.x * (gy * nrm.y);
  slopeAccel.y = gy - nrm.y * (gy * nrm.y);
  slopeAccel.z = -nrm.z * (gy * nrm.y);
  vLong += dot3(slopeAccel, fwd) * dt;
  vLat += dot3(slopeAccel, rgt) * dt;

  // --- Lateral grip. Carving bites, skidding does not, and the surface scales both:
  // ice holds a fraction of what groomed snow does.
  const lat = lerp(t.BASE_LAT_FRICTION, t.CARVE_LAT_FRICTION, carveStrength);
  vLat *= expDecay(lat * ground.grip, dt);
  state.skid = clamp01(Math.abs(vLat) / t.SKID_REF);

  // --- Aero drag, sign-aware so it can never accelerate a reversing board.
  const dragMul = lerp(1, t.TUCK_DRAG_MUL, tucking);
  vLong -= t.DRAG_QUAD * vLong * Math.abs(vLong) * dragMul * dt;

  // --- Snow friction, a constant deceleration that must not push the board
  // backwards through zero.
  vLong = decelerate(vLong, ground.drag * GRAVITY * dt);

  if (braking > 0) vLong = decelerate(vLong, t.BRAKE_DECEL * braking * dt);

  // --- Charging crouches the rider, and that costs speed. Charge is meant to be the
  // slow, safe option next to timing a lip.
  if (state.trickState === TrickState.Charging) vLong -= t.CHARGE_FRICTION * dt;

  // --- Soft cap: extra drag above SOFT_CAP, asymptoting toward MAX_SPEED. A hard
  // clamp reads as hitting an invisible wall; this reads as running out of hill.
  if (vLong > t.SOFT_CAP) {
    const over = (vLong - t.SOFT_CAP) / Math.max(t.MAX_SPEED - t.SOFT_CAP, 1e-3);
    vLong -= over * over * 18 * dt;
  }
  if (vLong > t.MAX_SPEED) vLong = t.MAX_SPEED;

  state.vLong = vLong;
  state.vLat = vLat;

  state.vel.x = fwd.x * vLong + rgt.x * vLat;
  state.vel.y = fwd.y * vLong + rgt.y * vLat;
  state.vel.z = fwd.z * vLong + rgt.z * vLat;

  void input;
}

function stepAirborne(state: BoardState, ctx: BoardStepContext, dt: number): void {
  const t = ctx.tuning;

  // World space, not the contact frame: gravity is vertical and the ground below is
  // irrelevant to the arc.
  state.vel.y -= GRAVITY * t.AIR_GRAVITY_SCALE * dt;

  const horiz = Math.hypot(state.vel.x, state.vel.z);
  if (horiz > 1e-6) {
    const decay = 1 - t.AIR_DRAG * horiz * dt;
    state.vel.x *= decay;
    state.vel.z *= decay;
  }

  // Diagnostics only while airborne; nothing reads them for forces.
  state.vLong = dot3(state.vel, fwd);
  state.vLat = dot3(state.vel, rgt);
  state.skid = 0;
}

/** Reduce magnitude by `amount` without crossing zero. */
function decelerate(v: number, amount: number): number {
  if (Math.abs(v) <= amount) return 0;
  return v - Math.sign(v) * amount;
}
