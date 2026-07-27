import { describe, expect, it } from 'vitest';
import { generateTrack, stampCurvature } from '../../src/track/generate.js';
import { gradeAt } from '../../src/track/generate.js';
import { StampKind, type TrackSpec } from '../../src/track/TrackSpec.js';
import { TEST_SLOPE } from '../../src/track/tracks/testSlope.js';
import {
  formatReport,
  GRADE_STALL,
  IssueLevel,
  validateSpec,
  validateTrack,
} from '../../src/track/validate.js';
import { fnv1aFloats, toHex } from '../../src/core/hash.js';
import { SurfaceId, TerrainFlag } from '../../src/sim/Terrain.js';

describe('the spec compiles to the track it replaced', () => {
  it('reproduces the hand-written slope byte for byte', () => {
    // The whole point of the port. The tuning slope was hand-written first, and its golden
    // height hash is asserted in terrainGeneration.test.ts; the generator matching it
    // exactly is what proves the spec expresses the same terrain rather than something
    // that merely looks similar.
    const track = generateTrack(TEST_SLOPE);
    expect(toHex(fnv1aFloats(track.field.heights))).toBe('34714195');
  });

  it('is deterministic across calls', () => {
    const a = generateTrack(TEST_SLOPE);
    const b = generateTrack(TEST_SLOPE);
    expect(fnv1aFloats(b.field.heights)).toBe(fnv1aFloats(a.field.heights));
  });
});

describe('gradeAt', () => {
  const points = [
    { z: 0, grade: 0.5 },
    { z: 100, grade: 0.2 },
    { z: 200, grade: 0.4 },
  ];

  it('holds the first and last grades outside the profile', () => {
    expect(gradeAt(points, -50)).toBe(0.5);
    expect(gradeAt(points, 0)).toBe(0.5);
    expect(gradeAt(points, 5000)).toBe(0.4);
  });

  it('hits its control points exactly', () => {
    expect(gradeAt(points, 100)).toBeCloseTo(0.2, 10);
    expect(gradeAt(points, 200)).toBeCloseTo(0.4, 10);
  });

  it('smoothsteps rather than interpolating linearly', () => {
    // A linear ramp would give exactly the midpoint at the midpoint. Smoothstep also gives
    // the midpoint there, so the distinguishing property is the *derivative* at the ends:
    // it must be zero, because a slope discontinuity in the grade is an invisible bump the
    // physics reacts to and the player cannot see coming.
    const nearStart = gradeAt(points, 1);
    const quarter = gradeAt(points, 25);
    const linearQuarter = 0.5 + (0.2 - 0.5) * 0.25;
    expect(Math.abs(nearStart - 0.5)).toBeLessThan(0.001);
    // Smoothstep lags a linear ramp over the first quarter.
    expect(quarter).toBeGreaterThan(linearQuarter);
  });

  it('handles an empty profile', () => {
    expect(gradeAt([], 100)).toBe(0);
  });
});

describe('stamp curvature', () => {
  it('is -4h/r^2 at the crest', () => {
    expect(
      stampCurvature({ kind: StampKind.Bump, x: 0, z: 0, radiusX: 20, radiusZ: 10, height: 2 }),
    ).toBeCloseTo(-0.08, 10);
  });

  it('makes a tall tight roller a better launch than a broad low one', () => {
    const snappy = stampCurvature({
      kind: StampKind.Bump,
      x: 0,
      z: 0,
      radiusX: 20,
      radiusZ: 12,
      height: 3.1,
    });
    const mellow = stampCurvature({
      kind: StampKind.Bump,
      x: 0,
      z: 0,
      radiusX: 52,
      radiusZ: 30,
      height: 5.2,
    });
    // Taller, but much broader: less useful as a pop despite being a bigger feature.
    expect(-snappy).toBeGreaterThan(-mellow);
  });
});

describe('generated launch features', () => {
  const track = generateTrack(TEST_SLOPE);

  it('emits one per usable stamp, with a quality', () => {
    expect(track.launches).toHaveLength(TEST_SLOPE.stamps.length);
    for (const launch of track.launches) {
      expect(launch.curvature).toBeLessThan(0);
      expect(launch.quality).toBeGreaterThan(0);
      expect(launch.quality).toBeLessThanOrEqual(1);
    }
  });

  it('ranks the snappy roller above the mellow booter', () => {
    const snappy = track.launches.find((l) => l.z === 210)!;
    const mellow = track.launches.find((l) => l.z === 700)!;
    expect(snappy.quality).toBeGreaterThan(mellow.quality);
  });

  it('drops a stamp too mellow to launch from', () => {
    const scenery = generateTrack({
      ...TEST_SLOPE,
      stamps: [{ kind: StampKind.Bump, x: 0, z: 400, radiusX: 60, radiusZ: 60, height: 1 }],
    });
    // -4 * 1 / 3600 = -0.001, far below the launch threshold.
    expect(scenery.launches).toHaveLength(0);
  });
});

describe('the feature mask', () => {
  const track = generateTrack(TEST_SLOPE);

  it('is 1 at a stamp centre and 0 far from every stamp', () => {
    const { field, featureMask } = track;
    const at = (x: number, z: number): number => {
      const i = Math.round((x - field.originX) / field.spacing);
      const j = Math.round((z - field.originZ) / field.spacing);
      return featureMask[j * field.cols + i];
    };
    // Centre of the roller at z=120, x=0.
    expect(at(0, 120)).toBeCloseTo(1, 5);
    // Well off every stamp.
    expect(at(-150, 60)).toBe(0);
  });

  it('suppresses detail noise inside a stamp', () => {
    // The layer that makes an authored mountain rather than noise mush. Same spec twice,
    // once with the noise bands removed: inside a stamp the two must agree closely, and out
    // on the open shoulder they must not.
    const noiseless = generateTrack({ ...TEST_SLOPE, noise: [] });
    const withNoise = track;

    const insideStamp = Math.abs(withNoise.field.height(0, 120) - noiseless.field.height(0, 120));
    const openShoulder = Math.abs(
      withNoise.field.height(-150, 120) - noiseless.field.height(-150, 120),
    );

    // The contrast is the assertion, not the absolute amplitude: measured at 0.99 m of
    // noise on the open shoulder against 0.02 m inside the stamp.
    expect(insideStamp).toBeLessThan(0.25);
    expect(openShoulder).toBeGreaterThan(0.5);
    expect(openShoulder).toBeGreaterThan(insideStamp * 4);
  });
});

describe('surfaces and flags from the spec', () => {
  const track = generateTrack(TEST_SLOPE);

  it('grooms the corridor and packs the shoulder', () => {
    // Groomed, or an occasional ice patch: both are corridor surfaces.
    expect([SurfaceId.Groomed, SurfaceId.Ice]).toContain(track.field.surface(0, 400));
    expect(track.field.surface(105, 400)).toBe(SurfaceId.Packed);
  });

  it('flags the bounds, not the grooming', () => {
    // The distinction matters: the shoulders are ridable on purpose, so the boundary sits
    // past the groomed edge rather than on it.
    expect(track.field.flags(0, 400) & TerrainFlag.InCorridor).toBe(TerrainFlag.InCorridor);
    expect(track.field.flags(110, 400) & TerrainFlag.InCorridor).toBe(TerrainFlag.InCorridor);
    expect(track.field.flags(180, 400) & TerrainFlag.InCorridor).toBe(0);
  });

  it('omits ice entirely when the spec does not ask for it', () => {
    // Omit the key rather than setting it to undefined: `exactOptionalPropertyTypes` makes
    // that distinction real, and "absent" is what an optional field means.
    const { ice: _ice, ...withoutIce } = TEST_SLOPE.surfaces;
    const noIce = generateTrack({ ...TEST_SLOPE, surfaces: withoutIce });
    let iceCount = 0;
    for (const s of noIce.field.surfaces) if (s === SurfaceId.Ice) iceCount++;
    expect(iceCount).toBe(0);
  });
});

describe('the validator', () => {
  it('passes the tuning slope', () => {
    const report = validateSpec(TEST_SLOPE);
    expect(report.ok, formatReport(report)).toBe(true);
    expect(report.issues.filter((i) => i.level === IssueLevel.Error)).toHaveLength(0);
  });

  it('reports the numbers the grade profile was tuned against', () => {
    const report = validateSpec(TEST_SLOPE);
    // Measured: a 23% median with under 1% of the corridor running uphill, which is the
    // trade the ROLLING noise band's scale and amplitude were chosen to hit.
    expect(report.medianGrade).toBeGreaterThan(0.15);
    expect(report.medianGrade).toBeLessThan(0.35);
    expect(report.uphillFraction).toBeLessThan(0.05);
    expect(report.verticalDrop).toBeGreaterThan(200);
    expect(report.launchCount).toBe(TEST_SLOPE.stamps.length);
  });

  it('catches a section flat enough to stall a rider', () => {
    const flat: TrackSpec = {
      ...TEST_SLOPE,
      // A dead-flat middle, which is the failure a screenshot cannot show.
      grade: {
        summit: 300,
        points: [
          { z: 0, grade: 0.3 },
          { z: 400, grade: 0.3 },
          { z: 500, grade: 0.0 },
          { z: 800, grade: 0.0 },
          { z: 900, grade: 0.3 },
          { z: 1200, grade: 0.3 },
        ],
      },
      noise: [],
      stamps: [],
    };
    const report = validateSpec(flat);
    expect(report.ok).toBe(false);
    const stalls = report.issues.filter((i) => i.code === 'stall');
    expect(stalls.length).toBeGreaterThan(5);
    // And it says where.
    expect(stalls.some((i) => i.z !== undefined && i.z > 450 && i.z < 850)).toBe(true);
    expect(report.shallowestWindow.grade).toBeLessThan(GRADE_STALL);
  });

  it('does not report a roller approach ramp as a stall', () => {
    // The face of a roller climbs, and that is the feature working -- it is what the rider
    // pops off the top of. Raw grade cannot tell it apart from a flat section that kills a
    // run, so the feature mask does. Found by this check firing on the tuning slope at
    // z=986, the leading edge of the roller stamped at z=1010.
    const shallowWithRoller: TrackSpec = {
      ...TEST_SLOPE,
      noise: [],
      grade: {
        summit: 200,
        points: [
          { z: 0, grade: 0.12 },
          { z: 1200, grade: 0.12 },
        ],
      },
      stamps: [{ kind: StampKind.Bump, x: 0, z: 600, radiusX: 40, radiusZ: 20, height: 4 }],
    };
    const report = validateSpec(shallowWithRoller);
    expect(report.ok, formatReport(report)).toBe(true);

    // But the same uphill grade with no stamp under it is still an error, so the exemption
    // is narrow rather than a way to silence the check.
    const bareDip = validateSpec({
      ...shallowWithRoller,
      stamps: [],
      grade: {
        summit: 200,
        points: [
          { z: 0, grade: 0.12 },
          { z: 560, grade: -0.05 },
          { z: 640, grade: -0.05 },
          { z: 700, grade: 0.12 },
          { z: 1200, grade: 0.12 },
        ],
      },
    });
    expect(bareDip.ok).toBe(false);
    expect(bareDip.issues.some((i) => i.code === 'stall')).toBe(true);
  });

  it('warns about a pitch past the control ceiling', () => {
    const cliff = validateSpec({
      ...TEST_SLOPE,
      grade: {
        summit: 900,
        points: [
          { z: 0, grade: 0.3 },
          { z: 400, grade: 0.9 },
          { z: 600, grade: 0.9 },
          { z: 1200, grade: 0.3 },
        ],
      },
      noise: [],
      stamps: [],
    });
    // Steep is a warning, not an error: a chute is a legitimate design choice and tuning is
    // allowed to be in progress. Only a track that cannot be ridden is an error.
    expect(cliff.ok).toBe(true);
    expect(cliff.issues.some((i) => i.code === 'uncontrollable')).toBe(true);
  });

  it('catches a boundary that is off the heightfield', () => {
    const report = validateSpec({
      ...TEST_SLOPE,
      cross: { ...TEST_SLOPE.cross, boundsHalfWidth: 500 },
    });
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'bounds-off-field')).toBe(true);
  });

  it('catches a boundary inside the groomed corridor', () => {
    const report = validateSpec({
      ...TEST_SLOPE,
      cross: { ...TEST_SLOPE.cross, corridorHalfWidth: 130, boundsHalfWidth: 120 },
    });
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'bounds-inside-corridor')).toBe(true);
  });

  it('catches unordered grade control points', () => {
    const report = validateSpec({
      ...TEST_SLOPE,
      grade: {
        summit: 300,
        points: [
          { z: 0, grade: 0.3 },
          { z: 500, grade: 0.2 },
          { z: 200, grade: 0.3 },
        ],
      },
    });
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'grade-unordered')).toBe(true);
  });

  it('warns about noise that ripples the corridor uphill', () => {
    // The other half of the crest-spacing trade. Amplitude pushed far past what its
    // wavelength supports is the failure this catches, and it is why the tuning slope's
    // ROLLING band was measured rather than guessed.
    const rippled = validateSpec({
      ...TEST_SLOPE,
      noise: [{ ...TEST_SLOPE.noise[0], amplitude: 6 }],
    });
    expect(rippled.issues.some((i) => i.code === 'uphill-ripple')).toBe(true);
  });

  it('warns about a stamp hanging off the edge of the field', () => {
    const report = validateSpec({
      ...TEST_SLOPE,
      stamps: [{ kind: StampKind.Bump, x: 190, z: 400, radiusX: 40, radiusZ: 14, height: 3 }],
    });
    expect(report.issues.some((i) => i.code === 'stamp-clipped')).toBe(true);
    // Clipped is cosmetic, so it must not fail a build.
    expect(report.ok).toBe(true);
  });

  it('warns about a stamp too mellow to be a launch', () => {
    const report = validateSpec({
      ...TEST_SLOPE,
      stamps: [
        { kind: StampKind.Bump, x: 0, z: 400, radiusX: 60, radiusZ: 60, height: 1, label: 'mound' },
      ],
    });
    const dead = report.issues.find((i) => i.code === 'dead-stamp');
    expect(dead).toBeDefined();
    expect(dead!.message).toContain('mound');
  });

  it('formats a readable report', () => {
    const text = formatReport(validateSpec(TEST_SLOPE));
    expect(text).toContain('testslope');
    expect(text).toContain('median grade');
    expect(text).toContain('launch features');
  });

  it('leaves the per-metre grade profile in course order', () => {
    // The report exposes `grades` for plotting, and the median is computed from a copy. A
    // sort in place would hand the caller a histogram labelled as a profile.
    const report = validateTrack(generateTrack(TEST_SLOPE));
    let ascending = true;
    for (let i = 1; i < report.grades.length; i++) {
      if (report.grades[i] < report.grades[i - 1]) ascending = false;
    }
    expect(ascending).toBe(false);
  });
});
