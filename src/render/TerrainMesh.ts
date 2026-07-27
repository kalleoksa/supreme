import * as THREE from 'three';
import type { Heightfield } from '../sim/Heightfield.js';
import { createTerrainMaterial } from './terrainMaterial.js';
import { buildChunkGeometry } from './terrainGeometry.js';
import type { Environment } from './Environment.js';

export interface TerrainMeshOptions {
  /** Cells per chunk edge. 128 cells at 1 m spacing = a 128 m chunk. */
  chunkCells?: number;
  /**
   * Distance in metres at which each successive LOD takes over. Index 0 is the
   * LOD0 (full-resolution) radius.
   */
  lodDistances?: number[];
}

interface Chunk {
  mesh: THREE.Mesh;
  /** Post index of the chunk's (0,0) corner. */
  pi: number;
  pj: number;
  cellsX: number;
  cellsZ: number;
  centreX: number;
  centreZ: number;
  activeStride: number;
  cache: Map<number, THREE.BufferGeometry>;
}

/**
 * Chunked terrain rendering.
 *
 * Two things here are load-bearing beyond "draw the ground":
 *
 *  1. **The diagonal split matches `Heightfield`** exactly -- each cell splits on
 *     (i,j)-(i+1,j+1) with the triangles wound to face +Y. At LOD0 the drawn
 *     surface and the simulated surface are therefore the same surface, which is
 *     what `tests/unit/heightfield.test.ts` asserts by raycasting this mesh.
 *  2. **Chunk vertices are chunk-local.** The world offset lives in the mesh
 *     matrix, which JS computes in double precision. Baking world coordinates into
 *     float32 vertex attributes produces visible jitter kilometres from the origin,
 *     and it is a prerequisite for ever moving to a geometry clipmap.
 *
 * Coarser LODs deliberately diverge from the physics surface. That is fine: LOD0
 * always covers the player, so the mismatch only exists where the board isn't.
 */
export class TerrainMesh {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;

  private readonly chunks: Chunk[] = [];
  private readonly strides: number[];
  private readonly lodDistances: number[];
  private readonly disposeMaterial: () => void;

  constructor(
    private readonly field: Heightfield,
    env: Environment,
    options: TerrainMeshOptions = {},
  ) {
    const chunkCells = options.chunkCells ?? 128;
    // M1 ships a single LOD. The machinery below is real and tested, but the
    // default is one level, for a reason worth recording.
    //
    // A coarser ring under-samples convex micro-relief and so sits slightly below
    // the full-resolution surface. On a near-flat corridor viewed from 2.5 m eye
    // height, that step lands at a constant distance from the camera -- which is a
    // constant *screen height* -- so it renders as a hard horizontal band straight
    // across the mountain, with the crack-filling skirt darkening it further. It
    // looks like a rendering bug and it wrecks the terrain readability the whole
    // charged-ollie mechanic depends on.
    //
    // Fixing it properly means the vertex morph from the plan: blend the dropped
    // vertices toward the coarse edge across the outer band of each ring so the
    // transition slides instead of stepping. That is a mobile-phase task. Until
    // then one LOD costs ~25 visible chunks and stays inside the draw budget on
    // desktop, which is all M1 targets.
    this.lodDistances = options.lodDistances ?? [Number.POSITIVE_INFINITY];
    // One stride per LOD band: full res, then halving. Strides must divide
    // chunkCells so chunk borders always land on a shared post.
    this.strides = this.lodDistances.map((_, i) => Math.min(1 << i, chunkCells));

    const mat = createTerrainMaterial(field, env);
    this.material = mat.material;
    this.disposeMaterial = mat.dispose;

    const cellsX = field.cols - 1;
    const cellsZ = field.rows - 1;

    for (let pj = 0; pj < cellsZ; pj += chunkCells) {
      for (let pi = 0; pi < cellsX; pi += chunkCells) {
        const cx = Math.min(chunkCells, cellsX - pi);
        const cz = Math.min(chunkCells, cellsZ - pj);
        if (cx <= 0 || cz <= 0) continue;

        const mesh = new THREE.Mesh(undefined, this.material);
        mesh.position.set(
          field.originX + pi * field.spacing,
          0,
          field.originZ + pj * field.spacing,
        );
        mesh.frustumCulled = true;
        this.group.add(mesh);

        this.chunks.push({
          mesh,
          pi,
          pj,
          cellsX: cx,
          cellsZ: cz,
          centreX: field.originX + (pi + cx * 0.5) * field.spacing,
          centreZ: field.originZ + (pj + cz * 0.5) * field.spacing,
          activeStride: 0,
          cache: new Map(),
        });
      }
    }

    // Start everything at the coarsest LOD so the first frame is never empty.
    const coarsest = this.strides[this.strides.length - 1];
    for (const chunk of this.chunks) this.setStride(chunk, coarsest);
  }

  get chunkCount(): number {
    return this.chunks.length;
  }

  /** Pick a LOD per chunk from its distance to the viewer. Call once per frame. */
  update(viewX: number, viewZ: number): void {
    for (const chunk of this.chunks) {
      const dx = chunk.centreX - viewX;
      const dz = chunk.centreZ - viewZ;
      const dist = Math.sqrt(dx * dx + dz * dz);

      let level = this.lodDistances.length - 1;
      for (let i = 0; i < this.lodDistances.length; i++) {
        if (dist <= this.lodDistances[i]) {
          level = i;
          break;
        }
      }
      const stride = this.strides[level];
      if (stride !== chunk.activeStride) this.setStride(chunk, stride);
    }
  }

  private setStride(chunk: Chunk, stride: number): void {
    let geo = chunk.cache.get(stride);
    if (!geo) {
      geo = buildChunkGeometry(this.field, {
        pi: chunk.pi,
        pj: chunk.pj,
        cellsX: chunk.cellsX,
        cellsZ: chunk.cellsZ,
        stride,
      });
      chunk.cache.set(stride, geo);
    }
    chunk.mesh.geometry = geo;
    chunk.activeStride = stride;
  }

  dispose(): void {
    for (const chunk of this.chunks) {
      for (const geo of chunk.cache.values()) geo.dispose();
      chunk.cache.clear();
      this.group.remove(chunk.mesh);
    }
    this.chunks.length = 0;
    this.disposeMaterial();
  }
}
