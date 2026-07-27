import { generateTrack, stampCurvature, type GeneratedTrack } from './generate.js';
import type { TrackSpec } from './TrackSpec.js';

/**
 * Static analysis of a track.
 *
 * The point is to catch the failures that are invisible in a screenshot and obvious after
 * thirty seconds of riding: a section shallow enough to stall, a pitch steep enough to be
 * uncontrollable, a roller mellowed out until the jump feels dead. Each of those is a
 * number, and a number can fail a test.
 *
 * Severity matters here. An `error` means the track is broken -- somewhere a run cannot
 * continue. A `warning` means it is probably not what the author intended but is rideable,
 * so it never blocks a build. Tuning is allowed to be in progress; stalling is not.
 */

export const enum IssueLevel {
  Warning = 0,
  Error = 1,
}

export interface TrackIssue {
  level: IssueLevel;
  /** Machine-readable kind, so tests can assert on a class of problem. */
  code: string;
  message: string;
  /** Metres along the course, when the issue has a location. */
  z?: number;
}

/**
 * Grade thresholds, from the plan's table of what makes a fun descent.
 *
 * The stall floor is the important one. Below about 5% a rider decelerates to a crawl and
 * the run stops being a run -- and unlike a too-steep section, it is not exciting, just
 * dead. The ceiling is where control goes rather than where it gets hard.
 */
export const GRADE_STALL = 0.05;
export const GRADE_UNCONTROLLABLE = 0.55;
/** A stamp below this crest curvature is scenery rather than a launch feature. */
export const LAUNCH_DEAD_CURVATURE = 0.02;
/**
 * Mean stamp coverage above which a window counts as inside an authored feature, and so is
 * exempt from the grade checks.
 *
 * Low on purpose. A window only needs to be meaningfully touched by a stamp for its grade to
 * be the stamp's business rather than the grade profile's.
 */
export const STAMP_COVERAGE = 0.08;

export interface TrackReport {
  id: string;
  issues: TrackIssue[];
  /** Grade sampled every metre along the centreline. */
  grades: Float32Array;
  medianGrade: number;
  /** Fraction of the centreline running uphill. */
  uphillFraction: number;
  /** Metres of vertical drop from the start to the finish. */
  verticalDrop: number;
  /** Geodesic-free straight-line course length, in metres. */
  courseLength: number;
  launchCount: number;
  /** Shallowest and steepest 20 m windows on the centreline, as grades. */
  shallowestWindow: { z: number; grade: number };
  steepestWindow: { z: number; grade: number };
  /** False when any issue is an error, meaning the track cannot be ridden as specified. */
  readonly ok: boolean;
}

/**
 * Walk a generated track and report on it.
 *
 * Takes the *generated* track rather than only the spec, because the questions worth asking
 * are about the surface the player actually rides -- after masked noise and smoothing --
 * not about the authored grade profile in isolation. A grade profile that reads fine and a
 * noise band that puts uphill ripples all through the corridor is exactly the combination
 * this is meant to catch.
 */
export function validateTrack(track: GeneratedTrack): TrackReport {
  const { spec, field } = track;
  const issues: TrackIssue[] = [];

  const start = spec.start.z;
  const finishZ = spec.lengthMetres - spec.finishInset;
  const span = Math.max(1, Math.round(finishZ - start));
  const grades = new Float32Array(span);

  // Stamp coverage along the same line, so an authored feature can be told apart from a
  // defect. Sampled at the nearest post rather than interpolated: the mask is only ever used
  // to decide "is this inside a feature", and a post is a metre.
  const maskAlong = new Float32Array(span);
  const col = Math.round((spec.start.x - field.originX) / field.spacing);

  let uphill = 0;
  for (let i = 0; i < span; i++) {
    const z = start + i;
    // Downhill is +Z, so a fall in height is a positive grade.
    const grade = field.height(spec.start.x, z) - field.height(spec.start.x, z + 1);
    grades[i] = grade;
    if (grade < 0) uphill++;

    const row = Math.round((z - field.originZ) / field.spacing);
    const idx = row * field.cols + col;
    maskAlong[i] = idx >= 0 && idx < track.featureMask.length ? track.featureMask[idx] : 0;
  }

  // toSorted, not sort: `grades` is returned in the report, and sorting it in place would
  // hand the caller a per-metre profile silently reordered into a histogram.
  const sorted = grades.toSorted();
  const medianGrade = sorted[sorted.length >> 1];
  const uphillFraction = uphill / span;

  // --- Stall and uncontrollable windows.
  //
  // Assessed over a 20 m window rather than per post, because a single metre of shallow
  // ground is a ripple the rider carries straight through, while twenty is a section they
  // slow down in. Per-post checks on noisy terrain report hundreds of issues that no player
  // would ever notice.
  const WINDOW = 20;
  let worstStall = { z: 0, grade: Infinity };
  let worstSteep = { z: 0, grade: 0 };
  for (let i = 0; i + WINDOW <= span; i += WINDOW) {
    let sum = 0;
    let maskSum = 0;
    for (let k = 0; k < WINDOW; k++) {
      sum += grades[i + k];
      maskSum += maskAlong[i + k];
    }
    const mean = sum / WINDOW;
    const meanMask = maskSum / WINDOW;
    const z = start + i;
    if (mean < worstStall.grade) worstStall = { z, grade: mean };
    if (mean > worstSteep.grade) worstSteep = { z, grade: mean };

    // A roller's approach ramp genuinely climbs, and that is the feature working -- it is
    // the face the rider pops off the top of. Measuring raw grade cannot tell it apart from
    // a flat section that stalls a run, so the feature mask does: inside a stamp, an uphill
    // window is authored intent. This was found by the check firing on the tuning slope at
    // z=986, which is exactly the leading edge of the roller stamped at z=1010.
    if (meanMask > STAMP_COVERAGE) {
      continue;
    }

    if (mean < GRADE_STALL) {
      issues.push({
        level: IssueLevel.Error,
        code: 'stall',
        z,
        message: `grade ${pct(mean)} over ${WINDOW} m from z=${z} is below the ${pct(GRADE_STALL)} stall floor`,
      });
    } else if (mean > GRADE_UNCONTROLLABLE) {
      issues.push({
        level: IssueLevel.Warning,
        code: 'uncontrollable',
        z,
        message: `grade ${pct(mean)} over ${WINDOW} m from z=${z} is past the ${pct(GRADE_UNCONTROLLABLE)} control ceiling`,
      });
    }
  }

  // --- Uphill ripples in the corridor.
  if (uphillFraction > 0.05) {
    issues.push({
      level: IssueLevel.Warning,
      code: 'uphill-ripple',
      message: `${pct(uphillFraction)} of the centreline runs uphill; detail noise amplitude is probably too high for its wavelength`,
    });
  }

  // --- Dead stamps.
  for (const stamp of spec.stamps) {
    const curvature = stampCurvature(stamp);
    if (-curvature < LAUNCH_DEAD_CURVATURE) {
      issues.push({
        level: IssueLevel.Warning,
        code: 'dead-stamp',
        z: stamp.z,
        message: `stamp${stamp.label ? ` "${stamp.label}"` : ''} at z=${stamp.z} has crest curvature ${curvature.toFixed(3)} 1/m, below ${LAUNCH_DEAD_CURVATURE}: it is scenery, not a launch`,
      });
    }
  }

  // --- Geometry sanity, the checks that mean the track cannot be ridden at all.
  if (spec.cross.boundsHalfWidth <= spec.cross.corridorHalfWidth) {
    issues.push({
      level: IssueLevel.Error,
      code: 'bounds-inside-corridor',
      message:
        'boundsHalfWidth must exceed corridorHalfWidth, or the groomed line is out of bounds',
    });
  }
  if (spec.cross.boundsHalfWidth > spec.widthMetres / 2) {
    issues.push({
      level: IssueLevel.Error,
      code: 'bounds-off-field',
      message: `boundsHalfWidth ${spec.cross.boundsHalfWidth} exceeds the field's half-width ${spec.widthMetres / 2}: the boundary is off the heightfield`,
    });
  }
  if (finishZ <= start) {
    issues.push({
      level: IssueLevel.Error,
      code: 'finish-behind-start',
      message: `finish at z=${finishZ} is not past the start at z=${start}`,
    });
  }
  for (const stamp of spec.stamps) {
    const halfWidth = spec.widthMetres / 2;
    if (Math.abs(stamp.x) + stamp.radiusX > halfWidth) {
      issues.push({
        level: IssueLevel.Warning,
        code: 'stamp-clipped',
        z: stamp.z,
        message: `stamp at x=${stamp.x} r=${stamp.radiusX} extends past the field edge and will be clipped`,
      });
    }
  }
  const ascending = spec.grade.points.every((p, i) => i === 0 || p.z > spec.grade.points[i - 1].z);
  if (!ascending) {
    issues.push({
      level: IssueLevel.Error,
      code: 'grade-unordered',
      message: 'grade control points must be strictly ascending in z',
    });
  }

  const verticalDrop = field.height(spec.start.x, start) - field.height(spec.start.x, finishZ);

  return {
    id: spec.id,
    issues,
    grades,
    medianGrade,
    uphillFraction,
    verticalDrop,
    courseLength: finishZ - start,
    launchCount: track.launches.length,
    shallowestWindow: worstStall,
    steepestWindow: worstSteep,
    ok: !issues.some((i) => i.level === IssueLevel.Error),
  };
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/** A report as lines of text, for a CLI or a test failure message. */
export function formatReport(report: TrackReport): string {
  const lines = [
    `${report.id}: ${report.courseLength.toFixed(0)} m of course, ${report.verticalDrop.toFixed(0)} m vertical`,
    `  median grade ${pct(report.medianGrade)}, uphill ${pct(report.uphillFraction)}, ${report.launchCount} launch features`,
    `  shallowest 20 m ${pct(report.shallowestWindow.grade)} at z=${report.shallowestWindow.z}, steepest ${pct(report.steepestWindow.grade)} at z=${report.steepestWindow.z}`,
  ];
  if (report.issues.length === 0) lines.push('  no issues');
  for (const issue of report.issues) {
    lines.push(
      `  ${issue.level === IssueLevel.Error ? 'ERROR' : 'warn '} ${issue.code}: ${issue.message}`,
    );
  }
  return lines.join('\n');
}

/** Generate a spec and validate the result. */
export function validateSpec(spec: TrackSpec): TrackReport {
  return validateTrack(generateTrack(spec));
}
