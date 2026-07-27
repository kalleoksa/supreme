import * as THREE from 'three';
import { clamp, invLerp01, lerp, smoothTowards } from '../core/math.js';
import type { BoardState } from '../sim/BoardState.js';
import type { TerrainSampler } from '../sim/Terrain.js';

/**
 * Comfort settings, exposed from day one.
 *
 * Motion sickness tolerance varies enormously between people, and a camera that
 * makes someone ill is unplayable for them no matter how good the game is. These
 * knobs cost ten minutes now and cannot be retrofitted after players have already
 * bounced off.
 */
export interface CameraComfort {
  /** Widen the field of view with speed. The strongest sell of speed, and a trigger. */
  fovWithSpeed: boolean;
  /** 0 disables screen shake entirely. */
  shakeScale: number;
  /** Multiplies the follow distance, for players who want more of the board visible. */
  distanceScale: number;
  /**
   * Lateral roll with cornering, in degrees. Defaults to zero: roll is the single
   * strongest nausea trigger in a chase camera, so it is opt-in only.
   */
  rollDegrees: number;
}

export const DEFAULT_COMFORT: CameraComfort = {
  fovWithSpeed: true,
  shakeScale: 1,
  distanceScale: 1,
  rollDegrees: 0,
};

const SPEED_LO = 8;
const SPEED_HI = 40;

const DIST_LO = 6.5;
const DIST_HI = 9.5;
const DIST_TAU = 0.35;

const HEIGHT = 2.6;

/**
 * Field of view, specified **horizontally** in degrees.
 *
 * three.js takes a vertical FOV, and conflating the two is an easy and expensive
 * mistake: 62-74 as a vertical FOV is a 100-110 degree horizontal fisheye, which
 * shrinks the rider to a speck and flattens the terrain relief the player is
 * supposed to be reading launch lips out of.
 *
 * Specifying horizontally is also the right call for a game that will eventually run
 * on phones: a vertical FOV silently narrows the view as the aspect ratio widens, so
 * a landscape phone would see less of the mountain than a desktop monitor rather
 * than more.
 */
const FOV_LO = 62;
const FOV_HI = 74;
const FOV_TAU = 0.5;
const FOV_KICK = 3;
const KICK_TIME = 0.14;

/** Convert a horizontal FOV to the vertical one three.js wants. */
function verticalFov(horizontalDeg: number, aspect: number): number {
  const h = (horizontalDeg * Math.PI) / 180;
  return (2 * Math.atan(Math.tan(h / 2) / Math.max(aspect, 0.1)) * 180) / Math.PI;
}

const YAW_TAU = 0.22;

const LEAD_LO = 6;
const LEAD_HI = 18;

const MIN_TERRAIN_CLEARANCE = 1.2;

/**
 * Third-person chase camera.
 *
 * Render-side only, and never consulted by the simulation -- so it cannot affect
 * determinism, and a recorded ghost is camera-agnostic.
 *
 * Three decisions carry most of the weight:
 *
 *  1. **It follows the velocity heading, not the board yaw.** When the board slides
 *     sideways the camera keeps looking down the direction of travel, which makes a
 *     drift readable instead of vertiginous. Following the board instead would swing
 *     the whole world every time the tail stepped out.
 *  2. **It never inherits trick rotation.** The rider spins; the camera does not.
 *     This is the primary anti-nausea rule, and also a legibility one: a rotation
 *     dial is unreadable on a spinning screen.
 *  3. **It leads well ahead of the rider.** The charged ollie is unplayable if you
 *     cannot see the crest you are about to hit, so look-ahead is a mechanic
 *     requirement rather than a stylistic choice.
 */
export class ChaseCamera {
  comfort: CameraComfort = { ...DEFAULT_COMFORT };

  private followYaw = 0;
  private distance = DIST_LO;
  private fov = FOV_LO;
  private camY = 0;
  private kickTimer = 0;
  private shakeTimer = 0;
  private initialized = false;

  private readonly desired = new THREE.Vector3();
  private readonly lookAt = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly terrain: TerrainSampler,
  ) {}

  /** A short FOV punch, on a pop or a landing. Sells impact without moving the camera. */
  kick(): void {
    this.kickTimer = KICK_TIME;
  }

  /** Screen shake, on a crash only. */
  shake(seconds = 0.35): void {
    this.shakeTimer = Math.max(this.shakeTimer, seconds);
  }

  reset(state: BoardState): void {
    this.initialized = false;
    this.update(state, 1 / 60);
  }

  update(state: BoardState, dt: number): void {
    const step = Math.min(dt, 0.1);
    const speed = Math.hypot(state.vel.x, state.vel.z);
    const speed01 = invLerp01(SPEED_LO, SPEED_HI, speed);

    // --- Follow the direction of travel, falling back to the board heading when
    // nearly stopped (where the velocity direction is meaningless noise).
    const travelYaw = speed > 1.5 ? Math.atan2(state.vel.z, state.vel.x) : state.yaw;
    if (!this.initialized) {
      this.followYaw = travelYaw;
      this.distance = lerp(DIST_LO, DIST_HI, speed01);
      this.fov = lerp(FOV_LO, FOV_HI, speed01);
      this.camY = state.pos.y + HEIGHT;
      this.initialized = true;
    } else {
      // Shortest-path so crossing the +/-PI seam does not whip the camera around.
      let delta = travelYaw - this.followYaw;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this.followYaw += delta * (1 - Math.exp(-step / YAW_TAU));
    }

    // --- Distance. Airborne gets extra standoff so jump height reads.
    const airBonus = state.grounded ? 1 : 1.15;
    const distTarget = lerp(DIST_LO, DIST_HI, speed01) * airBonus * this.comfort.distanceScale;
    this.distance = smoothTowards(this.distance, distTarget, DIST_TAU, step);

    // --- Anchor. Mostly world up, only slightly following the surface normal:
    // tracking the normal fully pitches the horizon on every roller, which is a
    // primary nausea source.
    const upBlend = 0.25;
    const upX = state.ground.nx * upBlend;
    const upY = lerp(1, state.ground.ny, upBlend);
    const upZ = state.ground.nz * upBlend;

    const behindX = -Math.cos(this.followYaw);
    const behindZ = -Math.sin(this.followYaw);

    this.desired.set(
      state.pos.x + behindX * this.distance + upX * HEIGHT,
      state.pos.y + upY * HEIGHT,
      state.pos.z + behindZ * this.distance + upZ * HEIGHT,
    );

    // --- Never clip through a ridge. Asymmetric smoothing: rise fast to clear an
    // obstacle, settle slowly so the camera does not bob on every bump.
    const floor = this.terrain.height(this.desired.x, this.desired.z) + MIN_TERRAIN_CLEARANCE;
    const wanted = Math.max(this.desired.y, floor);
    this.camY =
      wanted > this.camY
        ? lerp(this.camY, wanted, 1 - Math.exp(-step / 0.06))
        : lerp(this.camY, wanted, 1 - Math.exp(-step / 0.3));

    this.camera.position.set(this.desired.x, this.camY, this.desired.z);

    // --- Look ahead, along travel, snapped above the terrain there. This is the
    // single biggest readability factor in a downhill game.
    const lead = lerp(LEAD_LO, LEAD_HI, speed01);
    const aheadX = state.pos.x + Math.cos(this.followYaw) * lead;
    const aheadZ = state.pos.z + Math.sin(this.followYaw) * lead;
    const aheadY = Math.max(this.terrain.height(aheadX, aheadZ) + 1.5, state.pos.y - 6);

    // Airborne, bias the look target toward the rider so they do not slide off the
    // top of the frame on a big air.
    const airBias = state.grounded ? 0 : 0.45;
    this.lookAt.set(
      lerp(aheadX, state.pos.x, airBias),
      lerp(aheadY, state.pos.y + 1, airBias),
      lerp(aheadZ, state.pos.z, airBias),
    );

    if (this.shakeTimer > 0) {
      this.shakeTimer = Math.max(0, this.shakeTimer - step);
      const amp = this.shakeTimer * 0.9 * this.comfort.shakeScale;
      // Deterministic wobble from simulated time: no RNG, so a replay looks the same.
      this.lookAt.x += Math.sin(state.time * 91) * amp;
      this.lookAt.y += Math.sin(state.time * 137) * amp;
    }

    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.lookAt);

    // Optional, off by default.
    if (this.comfort.rollDegrees !== 0) {
      const roll = clamp(state.edge, -1, 1) * this.comfort.rollDegrees * (Math.PI / 180);
      this.camera.rotateZ(-roll);
    }

    // --- FOV. Widening with speed is the cheapest and strongest sell of speed there
    // is, and also the setting most likely to make someone queasy, hence the toggle.
    let fovTarget = this.comfort.fovWithSpeed ? lerp(FOV_LO, FOV_HI, speed01) : FOV_LO;
    if (this.kickTimer > 0) {
      this.kickTimer = Math.max(0, this.kickTimer - step);
      fovTarget += FOV_KICK * (this.kickTimer / KICK_TIME);
    }
    this.fov = smoothTowards(this.fov, fovTarget, FOV_TAU, step);
    const vertical = verticalFov(this.fov, this.camera.aspect);
    if (Math.abs(this.camera.fov - vertical) > 0.01) {
      this.camera.fov = vertical;
      this.camera.updateProjectionMatrix();
    }
  }
}
