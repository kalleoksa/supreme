import { describe, expect, it } from 'vitest';
import { buildTestSlope } from '../../src/track/testSlope.js';
import { fnv1aFloats, hash2i, toHex } from '../../src/core/hash.js';
import { fbm2s, valueNoise2 } from '../../src/core/noise.js';
import { mulberry32 } from '../../src/core/rng.js';
import { SurfaceId, TerrainFlag } from '../../src/sim/Terrain.js';
import { v3 } from '../../src/core/vec3.js';

describe('seeded primitives are stable', () => {
  // These digests are the tripwire. If terrain ever changes shape unintentionally
  // -- a reordered loop, a changed constant, a different noise call -- it shows up
  // here as a failing hash rather than as a track that quietly stopped being fun.
  it('hash2i is stable', () => {
    expect(toHex(hash2i(0, 0, 0))).toBe(toHex(hash2i(0, 0, 0)));
    const samples: number[] = [];
    for (let i = 0; i < 8; i++) samples.push(hash2i(i, i * 3, 0x5eed));
    expect(samples.map(toHex).join(',')).toMatchInlineSnapshot(
      `"660a87c2,05d70c3a,b90542fe,8a42bfa2,ea5df5cb,1d507705,e3a68b44,f4d40142"`,
    );
  });

  it('mulberry32 is stable', () => {
    const rng = mulberry32(12345);
    const out = [rng(), rng(), rng(), rng()].map((v) => v.toFixed(10));
    expect(out.join(',')).toMatchInlineSnapshot(
      `"0.9797282678,0.3067522645,0.4842054215,0.8179344125"`,
    );
  });

  it('value noise stays inside [0, 1) and is continuous', () => {
    for (let k = 0; k < 2000; k++) {
      const x = (Math.random() - 0.5) * 400;
      const y = (Math.random() - 0.5) * 400;
      const v = valueNoise2(x, y, 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    // Straddling an integer lattice line is where a broken fade shows up.
    const a = valueNoise2(5 - 1e-7, 3.25, 7);
    const b = valueNoise2(5 + 1e-7, 3.25, 7);
    expect(Math.abs(a - b)).toBeLessThan(1e-5);
  });

  it('fbm is bounded and repeatable', () => {
    const p = { scale: 40, octaves: 3, gain: 0.5, lacunarity: 2, seed: 99 };
    for (let k = 0; k < 500; k++) {
      const x = Math.random() * 1000;
      const z = Math.random() * 1000;
      const v = fbm2s(x, z, p);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
      expect(fbm2s(x, z, p)).toBe(v);
    }
  });
});

describe('the test slope', () => {
  const slope = buildTestSlope();
  const field = slope.field;

  it('has the expected extent at 1 m posts', () => {
    expect(field.spacing).toBe(1);
    expect(field.cols).toBe(401);
    expect(field.rows).toBe(1201);
    expect(field.widthMetres).toBe(400);
    expect(field.depthMetres).toBe(1200);
  });

  it('is byte-for-byte reproducible', () => {
    const again = buildTestSlope();
    expect(fnv1aFloats(again.field.heights)).toBe(fnv1aFloats(field.heights));
  });

  it('matches its golden height hash', () => {
    expect(toHex(fnv1aFloats(field.heights))).toMatchInlineSnapshot(`"34714195"`);
  });

  it('descends monotonically along the centreline', () => {
    // A downhill course that ever rises along the fall line would stall the rider.
    let prev = field.height(0, 0);
    for (let z = 1; z <= 1200; z += 1) {
      const h = field.height(0, z);
      // Rollers are deliberate local rises; the constraint is that no single metre
      // climbs more than a roller's flank can account for.
      expect(h - prev).toBeLessThan(0.75);
      prev = h;
    }
    expect(field.height(0, 1200)).toBeLessThan(field.height(0, 0) - 200);
  });

  it('keeps the corridor grade inside a ridable band', () => {
    // Below ~5% the rider stalls; above ~55% it stops being controllable. This is
    // the validator that catches "the track is broken" without anyone playing it.
    const out = { x: 0, z: 0 };
    let stalls = 0;
    let cliffs = 0;
    for (let z = 20; z < 1180; z += 5) {
      for (const x of [-60, -20, 0, 20, 60]) {
        const grade = field.slope(x, z, out);
        if (grade < 0.05) stalls++;
        if (grade > 0.55) cliffs++;
      }
    }
    const samples = Math.ceil((1180 - 20) / 5) * 5;
    // A few flat or steep posts are fine; a systemic problem is not.
    expect(stalls / samples).toBeLessThan(0.06);
    expect(cliffs / samples).toBeLessThan(0.06);
  });

  it('contains the rider with rising geometry rather than an invisible wall', () => {
    // Freedom of line is the design pillar, so the boundary has to be terrain the
    // player can see and feel, not a hard stop.
    for (const z of [200, 600, 1000]) {
      const centre = field.height(0, z);
      const edge = field.height(190, z);
      expect(edge).toBeGreaterThan(centre + 25);
    }
  });

  it('grooms the corridor and leaves the shoulders wild', () => {
    let groomedIn = 0;
    let looseOut = 0;
    for (let z = 50; z < 1150; z += 17) {
      const inner = field.surface(0, z);
      if (inner === SurfaceId.Groomed || inner === SurfaceId.Ice) groomedIn++;
      const outer = field.surface(150, z);
      if (outer === SurfaceId.Powder || outer === SurfaceId.Rock) looseOut++;
    }
    const n = Math.ceil((1150 - 50) / 17);
    expect(groomedIn / n).toBeGreaterThan(0.9);
    expect(looseOut / n).toBeGreaterThan(0.7);
  });

  it('flags the corridor', () => {
    expect(field.flags(0, 400) & TerrainFlag.InCorridor).toBe(TerrainFlag.InCorridor);
    expect(field.flags(180, 400) & TerrainFlag.InCorridor).toBe(0);
  });

  it('has rollers that read as crests to the ollie detector', () => {
    // The charged ollie pays out on negative along-path convexity. If the authored
    // rollers do not register as crests, the core mechanic has nothing to bite on.
    let crests = 0;
    for (const z of [120, 210, 300, 395, 500, 585, 700, 820, 905, 1010]) {
      // Scan across the roller's neighbourhood for the strongest crest.
      let best = 0;
      for (let dz = -6; dz <= 6; dz += 1) {
        for (let x = -50; x <= 50; x += 5) {
          const c = field.convexity(x, z + dz, 0, 1);
          if (c < best) best = c;
        }
      }
      if (best < -0.02) crests++;
    }
    expect(crests).toBe(10);
  });

  it('offers a crest to pop off roughly every 20 m of travel', () => {
    // The authored rollers alone are one feature every 120 m -- one every five
    // seconds at speed, which is nothing like a snowboarding run. The rolling noise
    // band is what makes the surface continuously poppable, and this is the
    // assertion that keeps it that way: it is very easy to smooth this band out of
    // existence while "just tidying up the noise" and never notice that the jump
    // stopped having anything to bite on.
    const gaps: number[] = [];
    for (const x of [-40, -20, 0, 20, 40]) {
      let last: number | null = null;
      for (let z = 20; z <= 1180; z += 1) {
        if (field.convexity(x, z, 0, 1) < -0.02) {
          // Group adjacent samples: one crest is several metres wide.
          if (last !== null && z - last > 5) gaps.push(z - last);
          if (last === null || z - last > 5) last = z;
        }
      }
    }
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    expect(gaps.length).toBeGreaterThan(80);
    expect(median).toBeLessThanOrEqual(30);
  });

  it('does not buy crest density by rippling the fall line uphill', () => {
    // The other end of the same trade. Crest density comes from short-wavelength
    // relief, and too much of it makes the descent run uphill in places or drop
    // below the ~5% grade where the rider stalls. Both ends need pinning or tuning
    // one silently wrecks the other.
    const grades: number[] = [];
    for (const x of [-40, -20, 0, 20, 40]) {
      for (let z = 20; z <= 1180; z += 1) {
        grades.push((field.height(x, z - 3) - field.height(x, z + 3)) / 6);
      }
    }
    const uphill = grades.filter((g) => g < 0).length / grades.length;
    const stalling = grades.filter((g) => g < 0.05).length / grades.length;
    expect(uphill).toBeLessThan(0.03);
    expect(stalling).toBeLessThan(0.08);

    grades.sort((a, b) => a - b);
    const median = grades[Math.floor(grades.length / 2)];
    expect(median).toBeGreaterThan(0.15);
    expect(median).toBeLessThan(0.32);
  });

  it('produces finite heights and unit normals everywhere', () => {
    // Scan with a plain loop and assert once, rather than calling expect() per
    // element. There are 481,601 posts, and an assertion each took ~6 s on a CI
    // runner -- enough to blow the default test timeout. Reporting the offending
    // index is also far more useful than "expected true, got false" 480,000 times.
    let badHeight = -1;
    for (let i = 0; i < field.heights.length; i++) {
      if (!Number.isFinite(field.heights[i])) {
        badHeight = i;
        break;
      }
    }
    expect(badHeight, `non-finite height at post index ${badHeight}`).toBe(-1);

    const n = v3();
    let worstNormalError = 0;
    let worstAt = '';
    for (let k = 0; k < 3000; k++) {
      const x = -200 + Math.random() * 400;
      const z = Math.random() * 1200;
      if (!Number.isFinite(field.height(x, z))) {
        throw new Error(`non-finite sampled height at (${x}, ${z})`);
      }
      field.normal(x, z, n);
      const err = Math.abs(Math.hypot(n.x, n.y, n.z) - 1);
      if (err > worstNormalError) {
        worstNormalError = err;
        worstAt = `(${x.toFixed(1)}, ${z.toFixed(1)})`;
      }
    }
    expect(worstNormalError, `worst non-unit normal at ${worstAt}`).toBeLessThan(1e-6);
  });

  it('spawns the rider on the surface facing downhill', () => {
    expect(field.contains(slope.startX, slope.startZ)).toBe(true);
    // Yaw PI/2 points along +Z, which is downhill.
    expect(slope.startYaw).toBeCloseTo(Math.PI / 2, 6);
    const ahead = field.height(slope.startX, slope.startZ + 20);
    expect(ahead).toBeLessThan(field.height(slope.startX, slope.startZ));
  });
});
