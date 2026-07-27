/**
 * Every scalar that decides how the board feels, in one JSON-serializable object.
 *
 * One object, not constants scattered through `Board.ts`, for three reasons: the
 * debug panel can generate sliders from it, a good tuning session can be copied out
 * as JSON and pasted back here, and its hash can be recorded alongside a ghost so a
 * time is always attributable to the physics that produced it.
 *
 * Units are metres, seconds and radians throughout. Rates written "per second" are
 * applied as `v *= exp(-k * dt)`, which is analytic in dt and therefore identical
 * at 30 fps and 120 fps.
 */
export interface BoardTuning {
  // --- Gravity and ground contact
  GRAVITY_SCALE: number;
  AIR_GRAVITY_SCALE: number;
  RIDE_HEIGHT: number;
  SNAP_TOL: number;
  NOSE_LEN: number;
  TAIL_LEN: number;

  // --- Steering
  TURN_RADIUS_LOOSE: number;
  TURN_RADIUS_CARVE: number;
  YAW_RATE_MAX: number;
  PIVOT_RATE: number;
  YAW_ACCEL: number;
  CARVE_TURN_MUL: number;
  TUCK_TURN_MUL: number;
  STEER_RATE: number;

  // --- Grip and the carve model
  BASE_LAT_FRICTION: number;
  CARVE_LAT_FRICTION: number;
  SKID_ALIGN_RATE: number;
  SKID_REF: number;
  CARVE_DRAG: number;
  EDGE_RATE: number;
  PUMP_MIN_HOLD: number;
  PUMP_MIN_ALIGN: number;
  PUMP_BOOST: number;

  // --- Longitudinal
  DRAG_QUAD: number;
  TUCK_DRAG_MUL: number;
  BRAKE_DECEL: number;
  SOFT_CAP: number;
  MAX_SPEED: number;
  AIR_DRAG: number;

  // --- The charged ollie
  CHARGE_TIME: number;
  CHARGE_FRICTION: number;
  CHARGE_TURN_MUL: number;
  MIN_POP: number;
  MAX_POP: number;
  LIP_REF: number;
  LIP_WEIGHT: number;
  POP_NORMAL_BIAS: number;

  // --- Air and tricks
  AIR_YAW_RATE: number;
  SPIN_RATE: number;
  FLIP_RATE: number;
  BREAK_TIME: number;
  BREAK_SCORE_KEEP: number;

  // --- Landing
  LAND_ANGLE_MAX: number;
  LAND_ALIGN_MAX: number;
  LAND_ROT_TOL: number;
  IMPACT_MAX: number;
  LAND_BOOST: number;
  CRASH_RECOVER: number;
  CRASH_PENALTY: number;
}

export const DEFAULT_TUNING: BoardTuning = {
  GRAVITY_SCALE: 1.0,
  /**
   * Airborne gravity is stronger than grounded. Two gravities is an old arcade
   * cheat and worth having from the start: it keeps jump arcs snappy and readable
   * instead of floaty, without making the ride down feel heavy.
   */
  AIR_GRAVITY_SCALE: 1.35,
  RIDE_HEIGHT: 0.06,
  /**
   * Ground/air hysteresis. Kept small on purpose -- the charged ollie's timing
   * window depends on the transition being crisp, so a generous tolerance would
   * blur exactly the thing the mechanic measures.
   */
  SNAP_TOL: 0.08,
  NOSE_LEN: 0.62,
  TAIL_LEN: 0.62,

  /**
   * Steering is a commanded turn *radius*, not a commanded yaw rate.
   *
   * The obvious model -- a yaw rate that falls as speed rises, so the board gains
   * weight -- has a vicious failure that only shows up in play: turning scrubs
   * speed, lower speed raises the turn rate, and the higher rate scrubs more speed.
   * The board spirals into a stationary spin from a single held input, and measured
   * on the test slope a one-second carve at 87 km/h rotated it 134 degrees and left
   * it at 2 km/h facing uphill.
   *
   * Radius inverts the coupling: `omega = speed / radius`, so losing speed tightens
   * nothing and the feedback loop cannot run away. It is also closer to how a board
   * actually behaves, since edge angle sets radius rather than rate. Weight at speed
   * comes from YAW_ACCEL and the cap instead.
   */
  TURN_RADIUS_LOOSE: 26,
  TURN_RADIUS_CARVE: 11,
  /** Ceiling on yaw rate, so a hard carve at 150 km/h stays a carve and not a spin. */
  YAW_RATE_MAX: 1.6,
  /**
   * Yaw authority independent of speed. Without it `omega = speed / radius` means a
   * stopped rider can never turn around, which is a dead end with no way out.
   */
  PIVOT_RATE: 0.55,
  YAW_ACCEL: 12.0,
  CARVE_TURN_MUL: 1.55,
  TUCK_TURN_MUL: 0.7,
  STEER_RATE: 6.0,

  /**
   * Off-edge lateral grip, as an exponential decay rate on sideways velocity.
   *
   * Was 5.0, which combined with surface grip gave a 0.24 s time constant -- the
   * board effectively railed whether or not the player was carving. Two things
   * followed: carving bought almost nothing, so the central mechanic was invisible;
   * and a rider turned across the fall line could never be pulled sideways downhill,
   * so they hockey-stopped to a permanent halt. 1.3 lets a flat board drift.
   */
  BASE_LAT_FRICTION: 1.3,
  CARVE_LAT_FRICTION: 11.0,
  /**
   * Weathervane rate: how strongly a *skidding* board is dragged back into line with
   * its direction of travel.
   *
   * This is a real drag couple, not a cheat -- a board sliding sideways has far more
   * resistance on its broad side than along its length, and the imbalance rotates it
   * toward travel. Leaving it out was noticeable: after a hard carve the board stayed
   * locked at whatever angle it ended on and slid down the hill sideways until the
   * player manually steered out, which felt like standing on ice rather than on snow.
   *
   * Scaled by `skid`, so it is nearly absent during a clean carve and cannot fight a
   * deliberate turn -- it only ever helps when the board is already sliding.
   */
  SKID_ALIGN_RATE: 2.6,
  SKID_REF: 6.0,
  CARVE_DRAG: 0.9,
  EDGE_RATE: 9.0,
  PUMP_MIN_HOLD: 0.35,
  /**
   * How closely the exit must point down the fall line to earn the pump, as a dot
   * product. 0.35 is roughly 70 degrees.
   *
   * A threshold rather than "any positive alignment" for two reasons. The obvious
   * one: a rider coming out almost sideways should not be told they nailed it, and
   * without a floor they were -- releasing at exactly 90 degrees still paid out,
   * because `sin(PI)` is 1.2e-16 rather than 0. The better one: a crisp threshold is
   * a *learnable* rule. "Come out pointing down the hill" is something a player can
   * internalise; "more alignment is proportionally more boost, asymptotically" is not.
   */
  PUMP_MIN_ALIGN: 0.35,
  PUMP_BOOST: 2.5,

  DRAG_QUAD: 0.0022,
  TUCK_DRAG_MUL: 0.62,
  BRAKE_DECEL: 14.0,
  SOFT_CAP: 34,
  MAX_SPEED: 42,
  AIR_DRAG: 0.0012,

  CHARGE_TIME: 0.55,
  CHARGE_FRICTION: 0.7,
  CHARGE_TURN_MUL: 0.85,
  MIN_POP: 2.0,
  MAX_POP: 8.2,
  /**
   * Curvature that counts as a perfect lip, in 1/m. The measured crest curvature on
   * the test slope runs about -0.02 for the mellowest authored roller up to -0.09
   * for the snappiest, so 0.055 puts a good pop in reach across most of them while
   * leaving the tightest rollers as the ones that reward precision.
   */
  LIP_REF: 0.055,
  /**
   * 1.0 means a perfectly-timed release at a crest is worth a full charge on its
   * own. This is the whole risk/reward primitive: charge is the safe route, timing
   * is the fast one.
   */
  LIP_WEIGHT: 1.0,
  POP_NORMAL_BIAS: 0.65,

  AIR_YAW_RATE: 2.2,
  SPIN_RATE: 5.2,
  FLIP_RATE: 4.4,
  BREAK_TIME: 0.18,
  BREAK_SCORE_KEEP: 0.35,

  LAND_ANGLE_MAX: 40,
  LAND_ALIGN_MAX: 55,
  LAND_ROT_TOL: 25,
  IMPACT_MAX: 14.0,
  LAND_BOOST: 1.8,
  CRASH_RECOVER: 1.4,
  CRASH_PENALTY: 500,
};

export function cloneTuning(src: BoardTuning = DEFAULT_TUNING): BoardTuning {
  return { ...src };
}

/**
 * Stable hash of a tuning set, so a recorded time can be tied to the physics that
 * produced it. Key order is sorted rather than declaration order, so reordering the
 * interface does not invalidate old recordings.
 */
export function tuningHash(tuning: BoardTuning): string {
  const keys = Object.keys(tuning).toSorted();
  let h = 0x811c9dc5 >>> 0;
  for (const key of keys) {
    const text = `${key}=${(tuning as unknown as Record<string, number>)[key]};`;
    for (let i = 0; i < text.length; i++) {
      h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
