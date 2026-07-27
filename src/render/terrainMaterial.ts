import * as THREE from 'three';
import type { Heightfield } from '../sim/Heightfield.js';
import { SURFACE_COUNT, SurfaceId } from '../sim/Terrain.js';
import { LIGHTING_GLSL, type Environment } from './Environment.js';

/**
 * Stylized snow palette, indexed by SurfaceId.
 *
 * Colour comes from a single R8 index texture plus this palette LUT, sampled in
 * the fragment shader -- NOT from per-chunk materials and NOT from vertex
 * colours. Both of those alternatives are dead ends: neither survives a move to a
 * geometry clipmap, which is the likely optimisation if a phone needs it. One
 * texture also means every chunk shares one material, so there are no shader
 * recompiles as chunks stream in.
 */
const PALETTE: Record<SurfaceId, number> = {
  [SurfaceId.Powder]: 0xf6f9ff,
  [SurfaceId.Groomed]: 0xe8f0f9,
  [SurfaceId.Packed]: 0xdae4ee,
  // Only slightly bluer than packed snow. A saturated blue here reads as standing
  // water rather than as scoured ice, which changes what the player thinks the
  // patch will do to them.
  [SurfaceId.Ice]: 0xc4d8e8,
  // Mid grey, not near-black. Exposed rock on a snowy face is pale and dusted;
  // dark rock plus a shaded normal produces a silhouette that looks like missing
  // geometry.
  [SurfaceId.Rock]: 0x7c8492,
};

export interface TerrainMaterialResult {
  material: THREE.ShaderMaterial;
  surfaceTexture: THREE.DataTexture;
  dispose(): void;
}

/**
 * One material for the whole terrain.
 *
 * `uFieldOrigin` / `uFieldSize` map world XZ into the surface texture, so chunk
 * geometry carries no world coordinates and no per-chunk uniforms. Chunk vertices
 * stay chunk-local (the world offset lives in the mesh matrix, computed in
 * double), which keeps float32 precision sane out at kilometre distances.
 */
export function createTerrainMaterial(field: Heightfield, env: Environment): TerrainMaterialResult {
  const { cols, rows } = field;

  const surfaceTexture = new THREE.DataTexture(
    field.surfaces,
    cols,
    rows,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  // Nearest: the index must not be interpolated, or a groomed/rock boundary
  // would sample a nonexistent material halfway between them.
  surfaceTexture.magFilter = THREE.NearestFilter;
  surfaceTexture.minFilter = THREE.NearestFilter;
  surfaceTexture.generateMipmaps = false;
  surfaceTexture.wrapS = THREE.ClampToEdgeWrapping;
  surfaceTexture.wrapT = THREE.ClampToEdgeWrapping;
  surfaceTexture.needsUpdate = true;

  const palette: THREE.Color[] = [];
  for (let i = 0; i < SURFACE_COUNT; i++) {
    palette.push(new THREE.Color(PALETTE[i as SurfaceId] ?? 0xff00ff));
  }

  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...env.uniforms,
      uSurface: { value: surfaceTexture },
      uPalette: { value: palette },
      uFieldOrigin: { value: new THREE.Vector2(field.originX, field.originZ) },
      uFieldSize: { value: new THREE.Vector2(field.widthMetres, field.depthMetres) },
      uTexel: { value: new THREE.Vector2(1 / cols, 1 / rows) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec2 vWorldXZ;
      varying float vViewDepth;

      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldXZ = worldPos.xz;
        // Terrain is never non-uniformly scaled or rotated, so the model matrix
        // upper 3x3 is orthonormal and this is the correct world normal.
        vNormalW = normalize(mat3(modelMatrix) * normal);

        vec4 viewPos = viewMatrix * worldPos;
        vViewDepth = -viewPos.z;
        gl_Position = projectionMatrix * viewPos;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;

      uniform sampler2D uSurface;
      uniform vec3 uPalette[${SURFACE_COUNT}];
      uniform vec2 uFieldOrigin;
      uniform vec2 uFieldSize;
      uniform vec2 uTexel;

      varying vec3 vNormalW;
      varying vec2 vWorldXZ;
      varying float vViewDepth;

      ${LIGHTING_GLSL}

      vec3 surfaceAlbedo(vec2 worldXZ) {
        vec2 uv = (worldXZ - uFieldOrigin) / uFieldSize;
        // Half-texel inset: post (i,j) sits at texel centre, so sampling the raw
        // normalized position would land on a boundary at the field edges.
        uv = clamp(uv, uTexel * 0.5, 1.0 - uTexel * 0.5);
        float idx = texture2D(uSurface, uv).r * 255.0;
        int i = int(idx + 0.5);
        vec3 c = uPalette[0];
        for (int k = 1; k < ${SURFACE_COUNT}; k++) {
          if (k == i) c = uPalette[k];
        }
        return c;
      }

      void main() {
        vec3 n = normalize(vNormalW);
        vec3 albedo = surfaceAlbedo(vWorldXZ);

        // Steep faces show rock through the snow, telling the player at a glance
        // which walls are ridable. Thresholds match the material assignment in the
        // generator (rock past ny < 0.5, i.e. ~60 degrees) and the blend is partial:
        // a fully-rock steep face would swallow the 40-degree containment
        // shoulders, which are meant to look ridable because they are.
        float steep = smoothstep(0.62, 0.40, n.y);
        albedo = mix(albedo, uPalette[${SurfaceId.Rock}], steep * 0.7);

        vec3 lit = applyLighting(albedo, n);
        gl_FragColor = vec4(applyFog(lit, vViewDepth), 1.0);
      }
    `,
  });

  return {
    material,
    surfaceTexture,
    dispose() {
      material.dispose();
      surfaceTexture.dispose();
    },
  };
}
