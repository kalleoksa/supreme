import * as THREE from 'three';
import { clamp01 } from '../core/math.js';
import type { BoardState } from '../sim/BoardState.js';
import type { TerrainSampler } from '../sim/Terrain.js';
import { findLipAhead } from '../sim/Ollie.js';
import type { BoardTuning } from '../sim/boardTuning.js';

/**
 * Decals painted on the snow: the blob shadow and the lip band.
 *
 * Both exist because of one design decision. At 120 km/h the player's eyes are on the
 * terrain ahead, not on the corners of the screen, so anything that marks a *place*
 * has to live in world space where they are already looking.
 *
 * Each decal re-projects its vertices onto the terrain height every frame rather than
 * being a flat quad. A flat disc on rolling ground either clips through a crest or
 * floats over a hollow, and both read as a bug. The vertex counts are tiny (tens), so
 * doing it properly costs nothing.
 *
 * ## What is deliberately *not* here
 *
 * The charge indicator was originally specified as a ring painted on the snow at the
 * rider's feet, and it was built, and it did not work. The geometry, position, depth
 * bias and alpha were all verified correct, and it still could not be seen: the chase
 * camera sits about 3.4 m above the rider and 8 m back, so a 2 m ground ring is viewed
 * at roughly 23 degrees and compresses into a faint sliver mostly hidden by the rider's
 * own body.
 *
 * That is a placement problem, not a rendering one -- ground decals near the rider are
 * the least readable place on screen from this camera. Charge is now shown by the
 * rider's crouch (which reads clearly) plus a HUD meter. The lip band stays in world
 * space because it marks a location, which a HUD element fundamentally cannot do.
 */

/**
 * How far decals float above the surface, in metres.
 *
 * Raised from 0.05 after the decals drew (draw calls confirmed them submitted) but
 * produced no visible pixels. A decal fan and the terrain grid triangulate the same
 * heights differently, so within a single decal triangle the terrain can rise above the
 * decal's own plane and win the depth test. `polygonOffset` below handles the exactly
 * coplanar case; this handles the interpolation mismatch.
 */
const DECAL_LIFT = 0.14;

/** Unlit, additive-ish decal shader. Alpha comes from a per-vertex weight. */
function decalMaterial(color: number, extraUniforms: Record<string, { value: unknown }> = {}) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // The standard coplanar-decal fix: bias these fragments toward the camera in depth
    // so they are not in a coin-flip with the surface they are painted on.
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 1 },
      uRing: { value: 0 },
      ...extraUniforms,
    },
    vertexShader: /* glsl */ `
      attribute float aWeight;
      attribute float aAngle;
      varying float vWeight;
      varying float vAngle;
      void main() {
        vWeight = aWeight;
        vAngle = aAngle;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uFill;
      uniform float uRing;
      varying float vWeight;
      varying float vAngle;
      void main() {
        // uFill sweeps the charge arc: only the filled fraction of the ring draws.
        if (vAngle > uFill) discard;

        // vWeight is 1 at the centre and 0 at the rim, which is right for a soft blob.
        // It is wrong for the charge arc: the rider is standing on the centre, so a
        // centre-weighted disc is entirely hidden by their own body and reads as
        // nothing being drawn at all. uRing moves the alpha out to a band near the rim.
        float rr = 1.0 - vWeight;
        // Brightest at the rim and fading inward. Deliberately not a band with a
        // falloff on both sides: the disc is a coarse triangle fan, so a two-sided
        // profile needs radial resolution the geometry does not have -- with two rings
        // it peaked at 0.38 alpha and was invisible. A rim-weighted ramp resolves
        // cleanly at any ring count.
        float alpha = uRing > 0.5 ? smoothstep(0.45, 1.0, rr) : vWeight;
        gl_FragColor = vec4(uColor, alpha * uOpacity);
      }
    `,
  });
}

/** A flat disc in XZ, as a triangle fan, with alpha falling off toward the rim. */
function discGeometry(segments: number, rings: number): THREE.BufferGeometry {
  const count = 1 + segments * rings;
  const positions = new Float32Array(count * 3);
  const weight = new Float32Array(count);
  const angle = new Float32Array(count);

  weight[0] = 1;
  angle[0] = 0;

  let v = 1;
  for (let r = 1; r <= rings; r++) {
    const rr = r / rings;
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      positions[v * 3] = Math.cos(a) * rr;
      positions[v * 3 + 2] = Math.sin(a) * rr;
      weight[v] = 1 - rr;
      angle[v] = s / segments;
      v++;
    }
  }

  const indices: number[] = [];
  for (let s = 0; s < segments; s++) {
    indices.push(0, 1 + s, 1 + ((s + 1) % segments));
  }
  for (let r = 1; r < rings; r++) {
    const base = 1 + (r - 1) * segments;
    const next = 1 + r * segments;
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments;
      indices.push(base + s, next + s, next + s2);
      indices.push(base + s, next + s2, base + s2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aWeight', new THREE.BufferAttribute(weight, 1));
  geo.setAttribute('aAngle', new THREE.BufferAttribute(angle, 1));
  geo.setIndex(indices);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return geo;
}

/** A ribbon of `segments` quads laid across the travel direction. */
function bandGeometry(segments: number): THREE.BufferGeometry {
  const count = (segments + 1) * 2;
  const positions = new Float32Array(count * 3);
  const weight = new Float32Array(count);
  const angle = new Float32Array(count);

  for (let i = 0; i <= segments; i++) {
    // Alpha tapers toward the ends so the band fades out rather than stopping dead.
    const t = i / segments;
    const taper = Math.sin(t * Math.PI);
    weight[i * 2] = taper;
    weight[i * 2 + 1] = taper;
  }

  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 3);
    indices.push(a, a + 3, a + 2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aWeight', new THREE.BufferAttribute(weight, 1));
  geo.setAttribute('aAngle', new THREE.BufferAttribute(angle, 1));
  geo.setIndex(indices);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return geo;
}

export class WorldHints {
  readonly group = new THREE.Group();

  /** Set false to hide the lip band for players who want no assists. */
  lipBandEnabled = true;

  private readonly shadow: THREE.Mesh;
  private readonly band: THREE.Mesh;

  private readonly shadowGeo: THREE.BufferGeometry;
  private readonly bandGeo: THREE.BufferGeometry;

  private readonly shadowMat: THREE.ShaderMaterial;
  private readonly bandMat: THREE.ShaderMaterial;

  /**
   * Rolling average of the player's lip timing. The band fades out as they get good at
   * it -- an assist that never withdraws stops being an assist and becomes the
   * interface, and the goal is for them to end up reading the snow itself.
   */
  private skill = 0;

  constructor(
    private readonly terrain: TerrainSampler,
    private readonly tuning: BoardTuning,
  ) {
    this.shadowGeo = discGeometry(20, 3);
    this.bandGeo = bandGeometry(12);

    // A dark, soft blob rather than a real shadow map. It is also not decoration: it is
    // the only cue that tells a player how high they are, and without it judging a
    // landing from a chase camera is guesswork.
    this.shadowMat = decalMaterial(0x0a1420, { uFill: { value: 1 } });
    this.bandMat = decalMaterial(0xfff07a, { uFill: { value: 1 } });

    this.shadow = new THREE.Mesh(this.shadowGeo, this.shadowMat);
    this.band = new THREE.Mesh(this.bandGeo, this.bandMat);
    for (const mesh of [this.shadow, this.band]) {
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
  }

  /** Feed back how well the player timed a pop, to fade the assist out over time. */
  recordPop(lipQuality: number): void {
    this.skill += (lipQuality - this.skill) * 0.12;
  }

  update(state: BoardState): void {
    this.updateShadow(state);
    this.updateBand(state);
  }

  private updateShadow(state: BoardState): void {
    // Grows and fades with height, which is what makes the height readable.
    const clearance = Math.max(state.clearance, 0);
    const radius = 0.95 + clearance * 0.055;
    const opacity = 0.42 * (1 - clamp01(clearance / 22));

    this.shadowMat.uniforms.uOpacity.value = opacity;
    this.shadow.visible = opacity > 0.01;
    if (this.shadow.visible) {
      this.projectDisc(this.shadowGeo, state.pos.x, state.pos.z, radius);
    }
  }

  private updateBand(state: BoardState): void {
    // Only while charging: it answers "when do I let go", so showing it otherwise is
    // clutter the player has no use for.
    const charging = state.jumpCharge > 0.01 && state.grounded;
    const fade = 1 - clamp01(this.skill * 1.25);
    if (!this.lipBandEnabled || !charging || fade < 0.05) {
      this.band.visible = false;
      return;
    }

    const found = findLipAhead(state, this.terrain, this.tuning);
    if (found.distance < 0) {
      this.band.visible = false;
      return;
    }

    const speed = Math.hypot(state.vel.x, state.vel.z);
    const dx = state.vel.x / speed;
    const dz = state.vel.z / speed;
    // Across the travel direction.
    const px = -dz;
    const pz = dx;

    const cx = state.pos.x + dx * found.distance;
    const cz = state.pos.z + dz * found.distance;
    const halfWidth = 3.4;
    const halfDepth = 0.75;

    const positions = this.bandGeo.attributes.position.array as Float32Array;
    const segments = positions.length / 6 - 1;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const offset = (t - 0.5) * 2 * halfWidth;
      for (let side = 0; side < 2; side++) {
        const depth = side === 0 ? -halfDepth : halfDepth;
        const x = cx + px * offset + dx * depth;
        const z = cz + pz * offset + dz * depth;
        const v = (i * 2 + side) * 3;
        positions[v] = x;
        positions[v + 1] = this.terrain.height(x, z) + DECAL_LIFT;
        positions[v + 2] = z;
      }
    }
    this.bandGeo.attributes.position.needsUpdate = true;

    this.band.visible = true;
    this.bandMat.uniforms.uOpacity.value = 0.75 * found.quality * fade;
  }

  /**
   * Re-lay a disc's vertices around (cx, cz) at `radius`, snapping each to the terrain.
   *
   * Positions are absolute world coordinates and the mesh matrix stays identity: these
   * decals are rebuilt every frame anyway, so there is nothing to gain from a local
   * frame and one less transform to keep in sync.
   */
  private projectDisc(geo: THREE.BufferGeometry, cx: number, cz: number, radius: number): void {
    const positions = geo.attributes.position.array as Float32Array;
    const count = positions.length / 3;

    // Vertex 0 is the fan centre; the rest were laid out on a unit circle at build
    // time, so their direction is recoverable from the stored angle attribute.
    const angles = geo.attributes.aAngle.array as Float32Array;
    const weights = geo.attributes.aWeight.array as Float32Array;

    positions[0] = cx;
    positions[1] = this.terrain.height(cx, cz) + DECAL_LIFT;
    positions[2] = cz;

    for (let v = 1; v < count; v++) {
      // aWeight encodes 1 - normalizedRadius, so the ring index comes back out of it.
      const rr = 1 - weights[v];
      const a = angles[v] * Math.PI * 2;
      const x = cx + Math.cos(a) * rr * radius;
      const z = cz + Math.sin(a) * rr * radius;
      positions[v * 3] = x;
      positions[v * 3 + 1] = this.terrain.height(x, z) + DECAL_LIFT;
      positions[v * 3 + 2] = z;
    }
    geo.attributes.position.needsUpdate = true;
  }

  dispose(): void {
    for (const geo of [this.shadowGeo, this.bandGeo]) geo.dispose();
    for (const mat of [this.shadowMat, this.bandMat]) mat.dispose();
  }
}
