import { clamp } from '../core/math.js';
import { quat, quatFromRiderPose, type Quat } from '../core/quat.js';
import { TrickState, type BoardState } from '../sim/BoardState.js';

/**
 * Records a run as a stream of transforms.
 *
 * ## Why transforms rather than input
 *
 * The tempting alternative is to record the input stream and replay it through the same
 * simulation -- a few hundred bytes per run, and it verifies the physics for free. It was
 * rejected, and the reason is in the language spec: ECMA-262 leaves the precision of
 * `sin`, `cos`, `pow` and `exp` implementation-defined, and the board physics uses
 * `Math.exp` for frame-rate-independent decay. So an input replay is not guaranteed to be
 * bit-identical between two browsers, or between two versions of one browser. A ghost that
 * silently desyncs on someone else's machine is worse than no ghost.
 *
 * Transform capture is immune by construction: it stores where the rider *was*, so nothing
 * has to be recomputed. At 20 Hz it costs about 25 bytes a frame -- roughly 45 KB for a
 * 90-second run, near 12 KB gzipped -- which is nothing next to being correct.
 *
 * The determinism disciplines stay in place anyway (fixed timestep, seeded integer noise,
 * no wall clock in the sim). They cost nothing and they are what a verified leaderboard
 * would need later; this just does not depend on them today.
 *
 * ## What it is immediately good for
 *
 * Playback lands in M2, but the recording is a physics debugging tool right now: a run that
 * ended somewhere impossible leaves a complete, inspectable trace of how it got there, at a
 * resolution no log line would give.
 */

/** Samples per second. 20 Hz is smooth once interpolated and cheap to store. */
export const GHOST_HZ = 20;

/** Bytes per recorded frame. */
export const GHOST_FRAME_BYTES = 25;

/** `WHTG`, so a truncated or foreign buffer fails loudly rather than decoding to noise. */
export const GHOST_MAGIC = 0x57485447;
export const GHOST_VERSION = 1;
/** magic, version+hz, frameCount, duration. */
export const GHOST_HEADER_BYTES = 16;

export const enum GhostFlag {
  Grounded = 1 << 0,
  Tricking = 1 << 1,
  Charging = 1 << 2,
  Crashed = 1 << 3,
}

export interface GhostFrame {
  time: number;
  x: number;
  y: number;
  z: number;
  rotation: Quat;
  /** Trick rotation in radians, kept out of the pose quaternion. */
  trickRot: number;
  /** Horizontal speed in m/s. */
  speed: number;
  flags: number;
}

/** Board length between the nose and tail samples, for the pitch angle. */
const PITCH_SPAN = 1.24;
/** How far the rider leans into a carve, matching `RiderView`. */
const LEAN_SCALE = 0.42;

const Q_SCALE = 32767;
const TRICK_SCALE = 1000;
const SPEED_SCALE = 100;

export class GhostRecorder {
  /** Frames recorded so far. */
  count = 0;

  private capacity: number;
  private data: DataView;
  private buffer: ArrayBuffer;
  private timer = 0;
  private lastTime = 0;
  private readonly pose: Quat = quat();

  constructor(
    readonly hz = GHOST_HZ,
    capacitySeconds = 180,
  ) {
    this.capacity = Math.max(1, Math.ceil(hz * capacitySeconds));
    this.buffer = new ArrayBuffer(this.capacity * GHOST_FRAME_BYTES);
    this.data = new DataView(this.buffer);
  }

  reset(): void {
    this.count = 0;
    this.timer = 0;
    this.lastTime = 0;
  }

  /**
   * Sample the board, at the recorder's rate.
   *
   * Call once per simulation step with the race clock; the recorder decides whether this
   * step is a sample. Driving it from the sim step rather than the frame means a 30 fps
   * display records exactly the same ghost as a 144 Hz one.
   */
  record(board: BoardState, time: number, dt: number): void {
    this.timer += dt;
    const interval = 1 / this.hz;
    const first = this.count === 0;
    if (!first && this.timer < interval) return;
    // Carry the remainder rather than zeroing. Zeroing drops the fraction of a step that
    // overshot the interval, and the error compounds: at 120 Hz six steps sum to a hair
    // under 0.05 s in float, so every sample needed a seventh step and a five-second run
    // recorded 86 frames instead of 100. Measured, then fixed here.
    this.timer = first ? 0 : this.timer - interval;
    this.lastTime = time;

    if (this.count >= this.capacity) this.grow();

    const pitch = board.grounded
      ? Math.atan2(board.noseY - board.tailY, PITCH_SPAN)
      : Math.atan2(board.vel.y, Math.max(Math.hypot(board.vel.x, board.vel.z), 1e-3));
    const roll = Math.asin(clamp(-board.right.y, -1, 1)) + clamp(board.edge, -1, 1) * LEAN_SCALE;
    quatFromRiderPose(this.pose, board.yaw, pitch, roll);

    let flags = 0;
    if (board.grounded) flags |= GhostFlag.Grounded;
    if (board.trickState === TrickState.Tricking) flags |= GhostFlag.Tricking;
    if (board.trickState === TrickState.Charging) flags |= GhostFlag.Charging;
    if (board.trickState === TrickState.Crashed) flags |= GhostFlag.Crashed;

    const at = this.count * GHOST_FRAME_BYTES;
    const d = this.data;
    d.setFloat32(at, board.pos.x, true);
    d.setFloat32(at + 4, board.pos.y, true);
    d.setFloat32(at + 8, board.pos.z, true);
    // A unit quaternion fits int16 with room to spare: 1/32767 is far below any angle a
    // viewer can see, and it halves the cost of the largest field in the frame.
    d.setInt16(at + 12, Math.round(this.pose.x * Q_SCALE), true);
    d.setInt16(at + 14, Math.round(this.pose.y * Q_SCALE), true);
    d.setInt16(at + 16, Math.round(this.pose.z * Q_SCALE), true);
    d.setInt16(at + 18, Math.round(this.pose.w * Q_SCALE), true);
    // Trick rotation stays separate from the pose so a viewer can show the board spinning
    // without the camera inheriting it -- the same anti-nausea rule the live camera follows.
    d.setInt16(at + 20, Math.round(clamp(board.trickRot * TRICK_SCALE, -32767, 32767)), true);
    d.setUint16(
      at + 22,
      Math.round(clamp(Math.hypot(board.vel.x, board.vel.z) * SPEED_SCALE, 0, 65535)),
      true,
    );
    d.setUint8(at + 24, flags);
    this.count++;
  }

  /**
   * Double the buffer.
   *
   * Allocating inside the step loop is normally forbidden here, and it is worth being
   * precise about why this is allowed: the buffer starts at three minutes, so growth
   * happens only on a run that has already gone very wrong, at most a handful of times,
   * and never during the 90 seconds anybody is timing.
   */
  private grow(): void {
    const bigger = new ArrayBuffer(this.buffer.byteLength * 2);
    new Uint8Array(bigger).set(new Uint8Array(this.buffer));
    this.buffer = bigger;
    this.data = new DataView(bigger);
    this.capacity *= 2;
  }

  /** The recorded run, header included, sized exactly to what was captured. */
  serialize(): ArrayBuffer {
    const out = new ArrayBuffer(GHOST_HEADER_BYTES + this.count * GHOST_FRAME_BYTES);
    const d = new DataView(out);
    d.setUint32(0, GHOST_MAGIC, true);
    d.setUint16(4, GHOST_VERSION, true);
    d.setUint16(6, this.hz, true);
    d.setUint32(8, this.count, true);
    d.setFloat32(12, this.lastTime, true);
    new Uint8Array(out, GHOST_HEADER_BYTES).set(
      new Uint8Array(this.buffer, 0, this.count * GHOST_FRAME_BYTES),
    );
    return out;
  }

  get byteLength(): number {
    return GHOST_HEADER_BYTES + this.count * GHOST_FRAME_BYTES;
  }
}

export interface Ghost {
  hz: number;
  duration: number;
  frames: GhostFrame[];
}

/**
 * Decode a serialized ghost.
 *
 * Playback is M2, so today this exists for the tests and for inspecting a run that went
 * somewhere it should not have. It is written now because a format with no reader is a
 * format nobody can check.
 */
export function decodeGhost(buffer: ArrayBuffer): Ghost {
  if (buffer.byteLength < GHOST_HEADER_BYTES) throw new Error('ghost: buffer too short');
  const d = new DataView(buffer);
  if (d.getUint32(0, true) !== GHOST_MAGIC) throw new Error('ghost: bad magic');
  const version = d.getUint16(4, true);
  if (version !== GHOST_VERSION) throw new Error(`ghost: unsupported version ${version}`);
  const hz = d.getUint16(6, true);
  const count = d.getUint32(8, true);
  const duration = d.getFloat32(12, true);
  const expected = GHOST_HEADER_BYTES + count * GHOST_FRAME_BYTES;
  if (buffer.byteLength !== expected) {
    throw new Error(`ghost: expected ${expected} bytes, got ${buffer.byteLength}`);
  }

  const frames: GhostFrame[] = [];
  for (let i = 0; i < count; i++) {
    const at = GHOST_HEADER_BYTES + i * GHOST_FRAME_BYTES;
    frames.push({
      time: hz > 0 ? i / hz : 0,
      x: d.getFloat32(at, true),
      y: d.getFloat32(at + 4, true),
      z: d.getFloat32(at + 8, true),
      rotation: {
        x: d.getInt16(at + 12, true) / Q_SCALE,
        y: d.getInt16(at + 14, true) / Q_SCALE,
        z: d.getInt16(at + 16, true) / Q_SCALE,
        w: d.getInt16(at + 18, true) / Q_SCALE,
      },
      trickRot: d.getInt16(at + 20, true) / TRICK_SCALE,
      speed: d.getUint16(at + 22, true) / SPEED_SCALE,
      flags: d.getUint8(at + 24),
    });
  }
  return { hz, duration, frames };
}
