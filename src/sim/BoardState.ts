import { v3, type Vec3 } from '../core/vec3.js';
import { createContact, SurfaceId, type Contact } from './Terrain.js';

export const enum TrickState {
  Idle = 0,
  Charging = 1,
  Air = 2,
  Tricking = 3,
  Breaking = 4,
  Crashed = 5,
}

export const enum LandQuality {
  Crash = 0,
  Sketchy = 1,
  Clean = 2,
  Perfect = 3,
}

/**
 * Why a landing or a run went wrong, named.
 *
 * The single loudest complaint about the game this one descends from was that its
 * trick system was illegible -- you could not tell what you had done wrong. Naming
 * the failure and putting the name on screen is the fix, and it starts by the
 * simulation actually knowing the answer instead of just producing a lower number.
 */
export const enum FailReason {
  None = 0,
  UnderRotated = 1,
  OverRotated = 2,
  Sideways = 3,
  TooFlat = 4,
  HardImpact = 5,
  HitObstacle = 6,
  OutOfBounds = 7,
}

/**
 * The whole simulated board, as flat plain data.
 *
 * No methods and no class instances by design: a flat record of numbers can be
 * copied for render interpolation, hashed for a golden test, and snapshotted for a
 * ghost, all with a single loop and no reflection. It also keeps the door open to
 * moving to struct-of-arrays or an ECS later as a mechanical change rather than a
 * rewrite, if this ever needs to simulate a field of AI riders.
 */
export interface BoardState {
  /** Contact point of the board, not the rider's centre of mass. */
  pos: Vec3;
  vel: Vec3;

  /** Heading in radians. 0 = +X, PI/2 = +Z. */
  yaw: number;
  yawRate: number;

  /** Smoothed carve engagement, -1..1, signed by turn direction. */
  edge: number;
  /** How long the edge has been engaged, for the pump-on-release reward. */
  edgeHoldTime: number;

  grounded: boolean;
  /** Seconds since leaving the ground; 0 while grounded. */
  airTime: number;
  /** Metres between the board and the surface below it. */
  clearance: number;
  /** Peak height above the surface reached during the current air. */
  apexHeight: number;

  ground: Contact;
  /** Angle between the surface normal and world up, in radians. */
  slopeAngle: number;

  /**
   * Surface height a board-length ahead and behind. Presentation only -- RiderView
   * pitches the board across them. Letting two-point contact drive the forces makes
   * the board pitch into terrain and blurs the ground/air test the ollie depends on.
   */
  noseY: number;
  tailY: number;

  /** Velocity component along the board's forward axis. */
  vLong: number;
  /** Velocity component across the board. The basis of the skid metric. */
  vLat: number;
  /** 0..1 sideways-slide measure; drives spray, audio and the HUD edge meter. */
  skid: number;

  /** Board-frame axes on the contact plane, recomputed each step. */
  forward: Vec3;
  right: Vec3;

  trickState: TrickState;
  jumpCharge: number;

  /** Rotation accumulated during the current trick, in radians. */
  trickRot: number;
  trickId: number;
  trickBroken: boolean;

  launchSpeed: number;
  launchNormal: Vec3;

  score: number;
  comboCount: number;
  lastLandQuality: LandQuality;
  lastFailReason: FailReason;

  crashTimer: number;

  /** Monotonic simulation tick, for event stamping and hashing. */
  tick: number;
  /** Seconds of simulated time elapsed. Not wall time. */
  time: number;
}

export function createBoardState(): BoardState {
  return {
    pos: v3(),
    vel: v3(),
    yaw: 0,
    yawRate: 0,
    edge: 0,
    edgeHoldTime: 0,
    grounded: false,
    airTime: 0,
    clearance: 0,
    apexHeight: 0,
    ground: createContact(),
    slopeAngle: 0,
    noseY: 0,
    tailY: 0,
    vLong: 0,
    vLat: 0,
    skid: 0,
    forward: v3(1, 0, 0),
    right: v3(0, 0, 1),
    trickState: TrickState.Idle,
    jumpCharge: 0,
    trickRot: 0,
    trickId: 0,
    trickBroken: false,
    launchSpeed: 0,
    launchNormal: v3(0, 1, 0),
    score: 0,
    comboCount: 0,
    lastLandQuality: LandQuality.Clean,
    lastFailReason: FailReason.None,
    crashTimer: 0,
    tick: 0,
    time: 0,
  };
}

/** Deep copy. Used to keep the previous state for render interpolation. */
export function copyBoardState(out: BoardState, src: BoardState): BoardState {
  out.pos.x = src.pos.x;
  out.pos.y = src.pos.y;
  out.pos.z = src.pos.z;
  out.vel.x = src.vel.x;
  out.vel.y = src.vel.y;
  out.vel.z = src.vel.z;
  out.yaw = src.yaw;
  out.yawRate = src.yawRate;
  out.edge = src.edge;
  out.edgeHoldTime = src.edgeHoldTime;
  out.grounded = src.grounded;
  out.airTime = src.airTime;
  out.clearance = src.clearance;
  out.apexHeight = src.apexHeight;
  out.slopeAngle = src.slopeAngle;
  out.noseY = src.noseY;
  out.tailY = src.tailY;
  out.vLong = src.vLong;
  out.vLat = src.vLat;
  out.skid = src.skid;
  out.forward.x = src.forward.x;
  out.forward.y = src.forward.y;
  out.forward.z = src.forward.z;
  out.right.x = src.right.x;
  out.right.y = src.right.y;
  out.right.z = src.right.z;
  out.trickState = src.trickState;
  out.jumpCharge = src.jumpCharge;
  out.trickRot = src.trickRot;
  out.trickId = src.trickId;
  out.trickBroken = src.trickBroken;
  out.launchSpeed = src.launchSpeed;
  out.launchNormal.x = src.launchNormal.x;
  out.launchNormal.y = src.launchNormal.y;
  out.launchNormal.z = src.launchNormal.z;
  out.score = src.score;
  out.comboCount = src.comboCount;
  out.lastLandQuality = src.lastLandQuality;
  out.lastFailReason = src.lastFailReason;
  out.crashTimer = src.crashTimer;
  out.tick = src.tick;
  out.time = src.time;

  out.ground.y = src.ground.y;
  out.ground.nx = src.ground.nx;
  out.ground.ny = src.ground.ny;
  out.ground.nz = src.ground.nz;
  out.ground.surface = src.ground.surface;
  out.ground.grip = src.ground.grip;
  out.ground.drag = src.ground.drag;
  out.ground.landForgive = src.ground.landForgive;
  out.ground.flags = src.ground.flags;
  out.ground.layer = src.ground.layer;

  return out;
}

/** Horizontal speed in m/s -- what "how fast am I going" means on a mountain. */
export function groundSpeed(state: BoardState): number {
  return Math.sqrt(state.vel.x * state.vel.x + state.vel.z * state.vel.z);
}

/**
 * Flatten state into a numeric array for hashing.
 *
 * Only fields that affect behaviour are included, so a golden hash failing means
 * the physics changed rather than a derived display value drifting.
 */
export function snapshotBoardState(state: BoardState, out: Float64Array): Float64Array {
  out[0] = state.pos.x;
  out[1] = state.pos.y;
  out[2] = state.pos.z;
  out[3] = state.vel.x;
  out[4] = state.vel.y;
  out[5] = state.vel.z;
  out[6] = state.yaw;
  out[7] = state.yawRate;
  out[8] = state.edge;
  out[9] = state.edgeHoldTime;
  out[10] = state.grounded ? 1 : 0;
  out[11] = state.airTime;
  out[12] = state.jumpCharge;
  out[13] = state.trickState;
  out[14] = state.trickRot;
  out[15] = state.score;
  out[16] = state.crashTimer;
  return out;
}

export const SNAPSHOT_SIZE = 17;

/**
 * Reset to a spawn pose. Used at race start and after an out-of-bounds reset.
 *
 * `normal` is the surface normal at the spawn point, and passing it matters: the
 * initial velocity is projected onto the contact plane rather than left horizontal.
 * A horizontal velocity on a descending slope has a component pointing *away* from
 * the surface, so the board would register as leaving the ground on its very first
 * step -- spawning mid-air, briefly losing steering authority, and then landing. On
 * a 40% pitch at speed that away-component is over 10 m/s, so it is not subtle.
 */
export function resetBoardState(
  state: BoardState,
  x: number,
  y: number,
  z: number,
  yaw: number,
  speed: number,
  normal: Vec3 = { x: 0, y: 1, z: 0 },
): void {
  state.pos.x = x;
  state.pos.y = y;
  state.pos.z = z;
  state.yaw = yaw;
  state.yawRate = 0;

  // Heading projected onto the contact plane, then scaled to `speed`.
  const hx = Math.cos(yaw);
  const hz = Math.sin(yaw);
  const d = hx * normal.x + hz * normal.z;
  let fx = hx - normal.x * d;
  let fy = -normal.y * d;
  let fz = hz - normal.z * d;
  const len = Math.sqrt(fx * fx + fy * fy + fz * fz);
  if (len > 1e-6) {
    fx /= len;
    fy /= len;
    fz /= len;
  } else {
    fx = hx;
    fy = 0;
    fz = hz;
  }
  state.vel.x = fx * speed;
  state.vel.y = fy * speed;
  state.vel.z = fz * speed;
  state.edge = 0;
  state.edgeHoldTime = 0;
  state.grounded = true;
  state.airTime = 0;
  state.apexHeight = 0;
  state.trickState = TrickState.Idle;
  state.jumpCharge = 0;
  state.trickRot = 0;
  state.trickBroken = false;
  state.crashTimer = 0;
  state.lastFailReason = FailReason.None;
  state.ground.surface = SurfaceId.Groomed;
}
