import * as THREE from 'three';
import type { Vec2 } from '../core/vec3.js';
import type { ProgressField } from '../race/ProgressField.js';
import type { TerrainSampler } from '../sim/Terrain.js';
import { LIGHTING_GLSL, type Environment } from './Environment.js';

/**
 * The finish line and the split banners, standing in the world.
 *
 * These are the one piece of the race the player has to be able to see, and they have to
 * be visible from a long way off: on a 240-metre-wide face at 100 km/h, a stripe painted
 * on the snow is nearly edge-on and invisible until it is too late to aim for. So each
 * marker is a **row of tall translucent banners** standing on the terrain, which reads
 * from hundreds of metres away and still says exactly where the line is when crossed.
 *
 * ## Gaps, fog and alpha, all learned the hard way
 *
 * The first version was a continuous unfogged curtain, and a screenshot from the approach
 * showed why that fails: a saturated wall of colour across the entire frame, hiding the
 * terrain the player is supposed to be reading. Three fixes, all of them necessary:
 *
 *  - **Gaps.** Banners are `BANNER_METRES` wide on a `PERIOD_METRES` pitch, so most of the
 *    view through the line is open snow. A gate you can see through is still obviously a
 *    gate, and the terrain past it stays readable -- which matters more, because that is
 *    where the next lip is.
 *  - **Fog, including on alpha.** Every other surface fades into the distance; a marker
 *    that does not is the brightest thing on a 900 m course. Fading alpha rather than only
 *    tinting toward the fog colour means a distant line disappears instead of becoming a
 *    fog-coloured band across the horizon.
 *  - **Low base opacity.** These mark a place. They are not scenery and must never be
 *    mistaken for something to avoid hitting.
 *
 * ## Where the geometry comes from
 *
 * Nothing here is authored. The finish is the two endpoints the track already declares,
 * and each split banner is traced from the `progress == threshold` isoline of the baked
 * field. That is the concrete payoff of measuring splits as thresholds instead of trigger
 * volumes: the marker cannot drift out of sync with the checkpoint, because the marker is
 * *derived from* the checkpoint. Moving a split moves its banner by doing nothing at all.
 *
 * Two draw calls: one for the finish, one for every split merged together.
 */

/** How tall the banners stand, in metres. */
const BANNER_HEIGHT = 8;
/** Width of one banner, in metres. */
const BANNER_METRES = 4;
/** Distance from one banner to the next, in metres. */
const PERIOD_METRES = 15;
/** Resampling step along a marker line, in metres. Must divide the banner sensibly. */
const SAMPLE_METRES = 2;
/** Opacity at the snow. Fades to zero at the top. */
const BASE_OPACITY = 0.5;

function bannerMaterial(env: Environment, color: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    // No depth write: banners overlap in view along the course, and writing depth would
    // let a nearer one punch a hole in a further one.
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { ...env.uniforms, uColor: { value: new THREE.Color(color) } },
    vertexShader: /* glsl */ `
      attribute float aFade;
      varying float vFade;
      varying float vViewDepth;
      void main() {
        vFade = aFade;
        vec4 viewPos = viewMatrix * modelMatrix * vec4(position, 1.0);
        vViewDepth = -viewPos.z;
        gl_Position = projectionMatrix * viewPos;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uColor;
      varying float vFade;
      varying float vViewDepth;
      ${LIGHTING_GLSL}
      void main() {
        // Same fog curve as every other surface, applied to alpha as well as colour so a
        // distant marker fades out rather than becoming a coloured band on the horizon.
        float f = 1.0 - exp(-uFogDensity * uFogDensity * vViewDepth * vViewDepth);
        f = clamp(f, 0.0, 1.0);
        float alpha = vFade * ${BASE_OPACITY.toFixed(2)} * (1.0 - f);
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(mix(uColor, uFogColor, f), alpha);
      }
    `,
  });
}

/** Resample a polyline at a fixed step, keeping the cumulative distance along it. */
function resample(line: readonly Vec2[]): { x: number; z: number; along: number }[] {
  const out: { x: number; z: number; along: number }[] = [];
  let along = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.round(span / SAMPLE_METRES));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, along: along + span * t });
    }
    along += span;
  }
  const last = line[line.length - 1];
  out.push({ x: last.x, z: last.z, along });
  return out;
}

/**
 * Append banner quads along a ground polyline.
 *
 * Each banner's base samples the terrain per vertex rather than sitting on a flat quad --
 * the same reason the decals in `WorldHints` project per-vertex. A flat base either clips
 * through a crest or floats over a hollow, and both read as a bug.
 */
function appendBanners(
  line: readonly Vec2[],
  terrain: TerrainSampler,
  positions: number[],
  fades: number[],
): void {
  if (line.length < 2) return;
  const samples = resample(line);

  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    // Include the segment only where it falls inside a banner rather than a gap.
    const mid = (a.along + b.along) * 0.5;
    if (mid - Math.floor(mid / PERIOD_METRES) * PERIOD_METRES >= BANNER_METRES) continue;

    const ay = terrain.height(a.x, a.z);
    const by = terrain.height(b.x, b.z);
    const quad = [
      [a.x, ay, a.z, 1],
      [b.x, by, b.z, 1],
      [b.x, by + BANNER_HEIGHT, b.z, 0],
      [a.x, ay, a.z, 1],
      [b.x, by + BANNER_HEIGHT, b.z, 0],
      [a.x, ay + BANNER_HEIGHT, a.z, 0],
    ];
    for (const [x, y, z, fade] of quad) {
      positions.push(x, y, z);
      fades.push(fade);
    }
  }
}

function buildMesh(
  lines: readonly (readonly Vec2[])[],
  terrain: TerrainSampler,
  env: Environment,
  color: number,
): THREE.Mesh | undefined {
  const positions: number[] = [];
  const fades: number[] = [];
  for (const line of lines) appendBanners(line, terrain, positions, fades);
  if (positions.length === 0) return undefined;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aFade', new THREE.Float32BufferAttribute(fades, 1));
  const mesh = new THREE.Mesh(geo, bannerMaterial(env, color));
  // Static geometry spanning a kilometre of course: a bounding-sphere test would only
  // ever answer "visible", and skipping it avoids three.js computing the sphere at all.
  mesh.frustumCulled = false;
  // Drawn after the terrain, which transparent geometry has to be.
  mesh.renderOrder = 2;
  return mesh;
}

export class RaceMarkers {
  readonly group = new THREE.Group();

  private readonly meshes: THREE.Mesh[] = [];

  constructor(
    terrain: TerrainSampler,
    env: Environment,
    progressField: ProgressField,
    finish: readonly [Vec2, Vec2],
    splits: readonly number[],
  ) {
    const finishMesh = buildMesh([finish], terrain, env, 0x35e08a);
    if (finishMesh) this.add(finishMesh);

    // Every split in one geometry. They share a colour and never move, so separate
    // meshes would spend draw calls on nothing.
    const splitLines = splits.map((p) => progressField.isoline(p)).filter((l) => l.length >= 2);
    const splitMesh = buildMesh(splitLines, terrain, env, 0x3aa0f0);
    if (splitMesh) this.add(splitMesh);
  }

  private add(mesh: THREE.Mesh): void {
    this.meshes.push(mesh);
    this.group.add(mesh);
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.meshes.length = 0;
    this.group.clear();
  }
}
