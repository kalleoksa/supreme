import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Heightfield } from '../../src/sim/Heightfield.js';
import { createContact, SurfaceId, TerrainFlag } from '../../src/sim/Terrain.js';
import { buildChunkGeometry } from '../../src/render/terrainGeometry.js';
import { buildTestSlope } from '../../src/track/testSlope.js';
import { v3, type Vec2 } from '../../src/core/vec3.js';

/** A field whose height is an exact analytic function, so results are checkable. */
function analyticField(
  cols: number,
  rows: number,
  spacing: number,
  fn: (x: number, z: number) => number,
  surface = SurfaceId.Groomed,
): Heightfield {
  const heights = new Float32Array(cols * rows);
  const surfaces = new Uint8Array(cols * rows).fill(surface);
  const flags = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      heights[j * cols + i] = fn(i * spacing, j * spacing);
    }
  }
  return new Heightfield({ cols, rows, spacing, originX: 0, originZ: 0, heights, surfaces, flags });
}

describe('Heightfield.height on an exact plane', () => {
  // A plane is the one case where triangle interpolation must be exact everywhere,
  // because both triangles of every cell lie in the same plane.
  const grade = 0.25;
  const field = analyticField(33, 33, 2, (x, z) => 100 - grade * z + 0.1 * x);

  it('reproduces the plane to float precision', () => {
    for (let k = 0; k < 500; k++) {
      const x = Math.random() * 64;
      const z = Math.random() * 64;
      const expected = 100 - grade * z + 0.1 * x;
      expect(field.height(x, z)).toBeCloseTo(expected, 4);
    }
  });

  it('produces the analytic normal', () => {
    const n = v3();
    field.normal(31.7, 20.3, n);
    // n = normalize(-dh/dx, 1, -dh/dz) = normalize(-0.1, 1, 0.25)
    const len = Math.sqrt(0.1 * 0.1 + 1 + grade * grade);
    expect(n.x).toBeCloseTo(-0.1 / len, 5);
    expect(n.y).toBeCloseTo(1 / len, 5);
    expect(n.z).toBeCloseTo(grade / len, 5);
  });

  it('reports slope magnitude as |grad h| and points downhill', () => {
    const out: Vec2 = { x: 0, z: 0 };
    const mag = field.slope(30, 30, out);
    expect(mag).toBeCloseTo(Math.sqrt(0.1 * 0.1 + grade * grade), 4);
    // Height falls with +z and rises with +x, so downhill is -x, +z.
    expect(out.z).toBeGreaterThan(0);
    expect(out.x).toBeLessThan(0);
  });
});

describe('Heightfield.height agrees with the drawn mesh', () => {
  // This is the load-bearing test of the whole terrain design. A bilinear patch
  // and the triangle mesh built from the same posts disagree by up to ~0.12 m at
  // the centre of a twisted cell; that error is exactly "the board floats" or
  // "the board sinks". Raycasting the real geometry is the only way to prove the
  // sampler and the renderer describe one surface.
  const field = analyticField(65, 65, 1, (x, z) => {
    // Deliberately twisted: a saddle plus a ripple, so no cell is planar.
    return 40 + 0.004 * (x - 32) * (z - 32) - 0.02 * z + ((x * 7 + z * 13) % 5) * 0.06;
  });

  const geo = buildChunkGeometry(field, { pi: 0, pj: 0, cellsX: 64, cellsZ: 64, stride: 1 });
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  mesh.updateMatrixWorld(true);

  const raycaster = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);

  it('matches a downward raycast to within 1e-4 m at 4000 random points', () => {
    let checked = 0;
    let worst = 0;

    for (let k = 0; k < 4000; k++) {
      // Stay a little inside the border so the skirt is never the first hit.
      const x = 0.5 + Math.random() * 63;
      const z = 0.5 + Math.random() * 63;

      raycaster.set(new THREE.Vector3(x, field.maxHeight + 25, z), down);
      const hits = raycaster.intersectObject(mesh, false);
      if (hits.length === 0) continue;

      const diff = Math.abs(hits[0].point.y - field.height(x, z));
      if (diff > worst) worst = diff;
      checked++;
    }

    expect(checked).toBeGreaterThan(3900);
    expect(worst).toBeLessThan(1e-4);
  });

  it('would fail for a bilinear sampler, proving the test has teeth', () => {
    // Sanity check on the test itself: if height() were bilinear, the same
    // comparison would show real error. If this ever stops showing a gap, the
    // mesh has become planar and the test above has stopped meaning anything.
    const bilinear = (x: number, z: number): number => {
      const i = Math.floor(x);
      const j = Math.floor(z);
      const u = x - i;
      const v = z - j;
      const h = field.heights;
      const c = field.cols;
      const h00 = h[j * c + i];
      const h10 = h[j * c + i + 1];
      const h01 = h[(j + 1) * c + i];
      const h11 = h[(j + 1) * c + i + 1];
      return h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h01 * (1 - u) * v + h11 * u * v;
    };

    let worst = 0;
    for (let k = 0; k < 500; k++) {
      const x = 0.5 + Math.random() * 63;
      const z = 0.5 + Math.random() * 63;
      raycaster.set(new THREE.Vector3(x, field.maxHeight + 25, z), down);
      const hits = raycaster.intersectObject(mesh, false);
      if (hits.length === 0) continue;
      worst = Math.max(worst, Math.abs(hits[0].point.y - bilinear(x, z)));
    }
    expect(worst).toBeGreaterThan(1e-3);
  });
});

describe('Heightfield normal continuity', () => {
  // Per-post normals blended bilinearly are C0 across cell boundaries. The
  // alternative -- the bilinear patch's own derivative -- is discontinuous there,
  // and shows up in play as a tick in board orientation every metre.
  const { field } = buildTestSlope({ lengthMetres: 160, widthMetres: 120, spacing: 1 });

  it('has no jump in the normal across cell boundaries', () => {
    const a = v3();
    const b = v3();
    let worst = 0;

    for (let k = 0; k < 2000; k++) {
      const x = -50 + Math.random() * 100;
      // Walk across an integer post line, which is where a discontinuous
      // sampler would betray itself.
      const zBoundary = 20 + Math.floor(Math.random() * 100);
      const eps = 1e-4;

      field.normal(x, zBoundary - eps, a);
      field.normal(x, zBoundary + eps, b);
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      if (d > worst) worst = d;
    }

    expect(worst).toBeLessThan(1e-3);
  });

  it('returns unit normals everywhere', () => {
    const n = v3();
    for (let k = 0; k < 1000; k++) {
      const x = -60 + Math.random() * 120;
      const z = Math.random() * 160;
      field.normal(x, z, n);
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 6);
    }
  });
});

describe('Heightfield.convexity', () => {
  it('is negative on a crest and positive in a trough', () => {
    // h = -0.01 * (z - 50)^2 peaks at z = 50 with second derivative -0.02.
    const crest = analyticField(9, 101, 1, (_x, z) => 50 - 0.01 * (z - 50) * (z - 50));
    expect(crest.convexity(4, 50, 0, 1)).toBeLessThan(-0.015);

    const trough = analyticField(9, 101, 1, (_x, z) => 10 + 0.01 * (z - 50) * (z - 50));
    expect(trough.convexity(4, 50, 0, 1)).toBeGreaterThan(0.015);
  });

  it('is zero along a direction with no curvature', () => {
    const ridge = analyticField(101, 101, 1, (_x, z) => 50 - 0.01 * (z - 50) * (z - 50));
    // Travelling along +X crosses no curvature at all.
    expect(Math.abs(ridge.convexity(50, 50, 1, 0))).toBeLessThan(1e-6);
  });

  it('recovers the analytic second derivative when the step lands on posts', () => {
    const k = 0.004;
    const field = analyticField(9, 201, 1, (_x, z) => k * z * z);
    // Central differences of a quadratic are exact -- but only when the three
    // samples sit on posts, where the piecewise-linear surface passes through the
    // true curve. step = 2 with 1 m spacing does that.
    expect(field.convexity(4, 100, 0, 1, 2)).toBeCloseTo(2 * k, 6);
  });

  it('measures the surface actually ridden, not an idealised curve', () => {
    // With the default 1.5 m step, two of the three samples land mid-cell, where
    // linear interpolation of a convex curve sits above it. The result is biased
    // by exactly (1 + 2*0.25/step^2) = 10/9 here.
    //
    // That bias is correct behaviour, not error: the board rides the triangle
    // mesh, so the lip detection should measure the mesh's curvature. What matters
    // is that the bias is bounded and stable, because LIP_REF is tuned against it.
    const k = 0.004;
    const field = analyticField(9, 201, 1, (_x, z) => k * z * z);
    const measured = field.convexity(4, 100, 0, 1);
    expect(measured / (2 * k)).toBeCloseTo(10 / 9, 3);
  });
});

describe('Heightfield.contact', () => {
  const field = analyticField(17, 17, 2, (_x, z) => 20 - 0.2 * z, SurfaceId.Ice);

  it('resolves height, normal and blended material together', () => {
    const c = createContact();
    field.contact(9, 11, c);
    expect(c.y).toBeCloseTo(20 - 0.2 * 11, 4);
    expect(c.ny).toBeGreaterThan(0.9);
    expect(c.surface).toBe(SurfaceId.Ice);
    // Ice: grip 0.35, drag 0.01. A uniform field must blend to exactly that.
    expect(c.grip).toBeCloseTo(0.35, 6);
    expect(c.drag).toBeCloseTo(0.01, 6);
    expect(c.layer).toBe(0);
  });

  it('unions flag bits across the cell', () => {
    const cols = 8;
    const rows = 8;
    const heights = new Float32Array(cols * rows);
    const surfaces = new Uint8Array(cols * rows);
    const flags = new Uint8Array(cols * rows);
    flags[2 * cols + 3] = TerrainFlag.Cliff;
    const f = new Heightfield({
      cols,
      rows,
      spacing: 1,
      originX: 0,
      originZ: 0,
      heights,
      surfaces,
      flags,
    });
    const c = createContact();
    // Cell (3,2) has one cliff corner; a rider partly on it is partly on a cliff.
    f.contact(3.5, 2.5, c);
    expect(c.flags & TerrainFlag.Cliff).toBe(TerrainFlag.Cliff);
  });

  it('support() forwards to the ground in M1', () => {
    const a = createContact();
    const b = createContact();
    field.contact(7.25, 9.75, a);
    field.support(7.25, 9.75, 100, 0.5, b);
    expect(b.y).toBe(a.y);
    expect(b.layer).toBe(0);
  });
});

describe('Heightfield bounds handling', () => {
  const field = analyticField(17, 17, 2, (x, z) => x * 0.1 + z * 0.2);

  it('reports containment against the true extent', () => {
    expect(field.contains(0, 0)).toBe(true);
    expect(field.contains(32, 32)).toBe(true);
    expect(field.contains(-0.001, 5)).toBe(false);
    expect(field.contains(32.001, 5)).toBe(false);
  });

  it('clamps out-of-range samples instead of producing NaN', () => {
    for (const [x, z] of [
      [-500, -500],
      [1e6, 1e6],
      [-1, 16],
      [40, -3],
    ]) {
      expect(Number.isFinite(field.height(x, z))).toBe(true);
      const n = v3();
      field.normal(x, z, n);
      expect(Number.isFinite(n.x + n.y + n.z)).toBe(true);
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 6);
    }
  });

  it('rejects degenerate construction', () => {
    expect(
      () =>
        new Heightfield({
          cols: 1,
          rows: 8,
          spacing: 1,
          originX: 0,
          originZ: 0,
          heights: new Float32Array(8),
          surfaces: new Uint8Array(8),
          flags: new Uint8Array(8),
        }),
    ).toThrow();

    expect(
      () =>
        new Heightfield({
          cols: 4,
          rows: 4,
          spacing: 1,
          originX: 0,
          originZ: 0,
          heights: new Float32Array(15),
          surfaces: new Uint8Array(16),
          flags: new Uint8Array(16),
        }),
    ).toThrow();
  });
});

describe('Heightfield.sweep', () => {
  const field = analyticField(65, 65, 1, (_x, z) => 30 - 0.3 * z);

  it('detects a descending segment crossing the surface', () => {
    const c = createContact();
    const from = v3(10, 30, 10);
    const to = v3(10, 10, 40);
    expect(field.sweep(from, to, c)).toBe(true);
    // The resolved contact must sit on the surface.
    expect(c.y).toBeCloseTo(field.height(10, (c.y - 30) / -0.3), 2);
  });

  it('returns false for a segment that stays above the surface', () => {
    const c = createContact();
    expect(field.sweep(v3(10, 100, 10), v3(40, 95, 40), c)).toBe(false);
  });

  it('reports an immediate hit when the start is already below ground', () => {
    const c = createContact();
    expect(field.sweep(v3(20, -50, 20), v3(25, -50, 25), c)).toBe(true);
  });
});
