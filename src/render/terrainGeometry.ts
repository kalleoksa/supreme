import * as THREE from 'three';
import type { Heightfield } from '../sim/Heightfield.js';

export interface ChunkGeometrySpec {
  /** Post index of the chunk's (0,0) corner. */
  pi: number;
  pj: number;
  cellsX: number;
  cellsZ: number;
  /** Posts to skip per vertex. 1 = full resolution. */
  stride: number;
}

/**
 * Build one terrain chunk's geometry, in chunk-local coordinates.
 *
 * Pure CPU work with no GL context required, which is deliberate: it lets the
 * unit suite raycast the *actual drawn geometry* in Node and assert it agrees with
 * `Heightfield.height()` to 1e-5. That test is the entire guarantee that the board
 * neither floats above nor sinks into the surface the player can see, and it will
 * catch any future change here that breaks the agreement.
 *
 * ## The diagonal split
 *
 * Every cell splits on the (i,j)-(i+1,j+1) diagonal, with triangles
 * `(a, d, b)` and `(a, c, d)` so face normals point +Y. `Heightfield.height()`
 * picks its triangle with `u >= v` against the same diagonal. These two facts must
 * stay in lockstep.
 */
export function buildChunkGeometry(
  field: Heightfield,
  spec: ChunkGeometrySpec,
): THREE.BufferGeometry {
  const { spacing, cols, rows, heights, normals: fieldNormals } = field;
  const s = Math.max(1, Math.min(spec.stride, spec.cellsX, spec.cellsZ));

  const nx = Math.max(1, Math.floor(spec.cellsX / s));
  const nz = Math.max(1, Math.floor(spec.cellsZ / s));
  const vx = nx + 1;
  const vz = nz + 1;

  const surfaceVerts = vx * vz;
  const skirtVerts = 2 * (vx + vz);
  const total = surfaceVerts + skirtVerts;

  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);

  for (let l = 0; l < vz; l++) {
    const pj = Math.min(spec.pj + l * s, rows - 1);
    for (let k = 0; k < vx; k++) {
      const pi = Math.min(spec.pi + k * s, cols - 1);
      const post = pj * cols + pi;
      const v = (l * vx + k) * 3;

      positions[v] = k * s * spacing;
      positions[v + 1] = heights[post];
      positions[v + 2] = l * s * spacing;

      normals[v] = fieldNormals[post * 3];
      normals[v + 1] = fieldNormals[post * 3 + 1];
      normals[v + 2] = fieldNormals[post * 3 + 2];
    }
  }

  const indices: number[] = [];
  for (let l = 0; l < nz; l++) {
    for (let k = 0; k < nx; k++) {
      const a = l * vx + k; // (k,   l)
      const b = a + 1; // (k+1, l)
      const c = a + vx; // (k,   l+1)
      const d = c + 1; // (k+1, l+1)
      indices.push(a, d, b);
      indices.push(a, c, d);
    }
  }

  // Skirt: a dropped copy of the border ring, stitched into a wall. This is what
  // hides the crack where a fine chunk abuts a coarse one; depth scales with cell
  // size because that bounds how far a coarse LOD can deviate.
  const skirtDepth = Math.max(1.5, s * spacing * 1.5);
  let sv = surfaceVerts;
  const addSkirt = (border: number[]): void => {
    const first = sv;
    for (const bi of border) {
      const src = bi * 3;
      const dst = sv * 3;
      positions[dst] = positions[src];
      positions[dst + 1] = positions[src + 1] - skirtDepth;
      positions[dst + 2] = positions[src + 2];
      normals[dst] = normals[src];
      normals[dst + 1] = normals[src + 1];
      normals[dst + 2] = normals[src + 2];
      sv++;
    }
    for (let m = 0; m < border.length - 1; m++) {
      indices.push(border[m], first + m, border[m + 1]);
      indices.push(border[m + 1], first + m, first + m + 1);
    }
  };

  // The four borders are gathered so they wind the same way around the chunk
  // (south and west built backwards), which keeps the stitched wall's facing
  // consistent all the way round.
  const north: number[] = [];
  const south: number[] = [];
  for (let k = 0; k < vx; k++) {
    north.push(k);
    south.push((vz - 1) * vx + (vx - 1 - k));
  }
  const west: number[] = [];
  const east: number[] = [];
  for (let l = 0; l < vz; l++) {
    west.push((vz - 1 - l) * vx);
    east.push(l * vx + (vx - 1));
  }
  addSkirt(north);
  addSkirt(south);
  addSkirt(west);
  addSkirt(east);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

/** Triangle count of the surface (excluding the skirt), for budget assertions. */
export function chunkSurfaceTriangles(spec: ChunkGeometrySpec): number {
  const s = Math.max(1, Math.min(spec.stride, spec.cellsX, spec.cellsZ));
  const nx = Math.max(1, Math.floor(spec.cellsX / s));
  const nz = Math.max(1, Math.floor(spec.cellsZ / s));
  return nx * nz * 2;
}
