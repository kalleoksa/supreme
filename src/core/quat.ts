/**
 * Plain-object quaternions.
 *
 * Same reason `vec3.ts` exists: the pure layer must not import `THREE.Quaternion`, and
 * keeping orientation as plain data is what lets a ghost frame be written straight into
 * an `ArrayBuffer` with no conversion step.
 *
 * Only what the ghost recorder needs -- Euler composition and multiplication. Not a
 * general quaternion library, and it should not grow into one; if the renderer needs
 * quaternion work it already has three.js.
 */

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export function quat(x = 0, y = 0, z = 0, w = 1): Quat {
  return { x, y, z, w };
}

/** Rotation of `angle` about a principal axis: 0 = X, 1 = Y, 2 = Z. */
export function quatFromAxis(out: Quat, axis: 0 | 1 | 2, angle: number): Quat {
  const h = angle * 0.5;
  const s = Math.sin(h);
  out.x = axis === 0 ? s : 0;
  out.y = axis === 1 ? s : 0;
  out.z = axis === 2 ? s : 0;
  out.w = Math.cos(h);
  return out;
}

/** `out = a * b`. Safe to alias `out` with either input. */
export function quatMul(out: Quat, a: Quat, b: Quat): Quat {
  const ax = a.x;
  const ay = a.y;
  const az = a.z;
  const aw = a.w;
  const bx = b.x;
  const by = b.y;
  const bz = b.z;
  const bw = b.w;
  out.x = aw * bx + ax * bw + ay * bz - az * by;
  out.y = aw * by - ax * bz + ay * bw + az * bx;
  out.z = aw * bz + ax * by - ay * bx + az * bw;
  out.w = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

export function quatNormalize(out: Quat): Quat {
  const len = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z + out.w * out.w);
  if (len < 1e-12) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    out.w = 1;
    return out;
  }
  out.x /= len;
  out.y /= len;
  out.z /= len;
  out.w /= len;
  return out;
}

const tmpA = quat();
const tmpB = quat();

/**
 * The rider's orientation, composed in the order `RiderView` applies it: yaw about Y,
 * then pitch along the board (Z), then roll across it (X).
 *
 * The order is not incidental and must match the renderer exactly -- rotations do not
 * commute, so composing pitch before yaw tilts the board in the world instead of along
 * its own length. Any change to the pose order in `RiderView` has to be mirrored here or
 * recorded ghosts will lean the wrong way.
 */
export function quatFromRiderPose(out: Quat, yaw: number, pitch: number, roll: number): Quat {
  quatFromAxis(out, 1, -yaw);
  quatMul(out, out, quatFromAxis(tmpA, 2, pitch));
  quatMul(out, out, quatFromAxis(tmpB, 0, roll));
  return quatNormalize(out);
}
