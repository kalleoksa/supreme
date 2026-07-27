import * as THREE from 'three';
import { clamp01 } from '../core/math.js';
import { mulberry32 } from '../core/rng.js';
import type { BoardState } from '../sim/BoardState.js';
import type { Environment } from './Environment.js';

const MAX_PARTICLES = 320;

/**
 * Snow thrown off the board's edge.
 *
 * This is the other half of making grip legible, alongside the edge meter. A number
 * on a bar tells the player they are skidding; a rooster tail of snow *shows* them,
 * in the place they are already looking. It is also the cheapest possible feedback
 * for the difference between a railed carve and a slide, which is the distinction the
 * whole carve model rests on.
 *
 * One `THREE.Points` cloud, so one draw call. Particles live in a fixed pool with no
 * allocation after construction -- the render path must not hand the collector work
 * mid-carve.
 */
export class Spray {
  readonly points: THREE.Points;

  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private next = 0;
  private emitAccum = 0;
  /** Seeded, so a replayed run throws the same snow. */
  private readonly rng = mulberry32(0x5b0a12);

  constructor(env: Environment) {
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.velocities = new Float32Array(MAX_PARTICLES * 3);
    this.life = new Float32Array(MAX_PARTICLES);
    this.size = new Float32Array(MAX_PARTICLES);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    // Never culled: the cloud follows the rider, and a bounding sphere computed from
    // a mostly-dead pool sitting at the origin would cull it at the worst moments.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        ...env.uniforms,
        uPixelScale: { value: 620 },
      },
      vertexShader: /* glsl */ `
        attribute float aLife;
        attribute float aSize;
        uniform float uPixelScale;
        varying float vLife;
        void main() {
          vLife = aLife;
          vec4 viewPos = viewMatrix * modelMatrix * vec4(position, 1.0);
          // Perspective-correct point size, so spray does not turn into confetti at
          // distance.
          gl_PointSize = aSize * uPixelScale / max(-viewPos.z, 1.0);
          gl_Position = projectionMatrix * viewPos;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uSkyColor;
        varying float vLife;
        void main() {
          // Round, soft-edged particles from the point coordinate; no texture needed.
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d);
          if (r > 0.25) discard;
          float alpha = vLife * vLife * (1.0 - r * 4.0);
          gl_FragColor = vec4(mix(vec3(1.0), uSkyColor, 0.25), alpha * 0.85);
        }
      `,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
  }

  update(state: BoardState, dt: number): void {
    const step = Math.min(dt, 0.05);

    // Emit from the trailing edge, at a rate set by how hard the board is scrubbing.
    // A clean carve throws a thin ribbon; a full slide throws a wall.
    const intensity = state.grounded ? clamp01(state.skid * 1.15) : 0;
    const speed = Math.hypot(state.vel.x, state.vel.z);
    const rate = intensity * 190 * clamp01(speed / 12);

    this.emitAccum += rate * step;
    const toEmit = Math.min(Math.floor(this.emitAccum), 24);
    this.emitAccum -= toEmit;

    for (let i = 0; i < toEmit; i++) this.emit(state, intensity, speed);

    // Integrate and age the whole pool.
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) continue;
      const p = i * 3;
      this.velocities[p + 1] -= 9.81 * 0.55 * step;
      this.positions[p] += this.velocities[p] * step;
      this.positions[p + 1] += this.velocities[p + 1] * step;
      this.positions[p + 2] += this.velocities[p + 2] * step;
      this.life[i] = Math.max(0, this.life[i] - step * 2.4);
      if (this.life[i] === 0) this.size[i] = 0;
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aLife.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
  }

  private emit(state: BoardState, intensity: number, speed: number): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX_PARTICLES;
    const p = i * 3;

    const jitter = (): number => this.rng() - 0.5;

    // Origin: at the board, spread along its length.
    const along = jitter() * 1.4;
    this.positions[p] = state.pos.x + state.forward.x * along + jitter() * 0.2;
    this.positions[p + 1] = state.pos.y + 0.05;
    this.positions[p + 2] = state.pos.z + state.forward.z * along + jitter() * 0.2;

    // Thrown mostly sideways, away from the edge that is cutting, plus a little back
    // along travel and up. The sideways sign follows which edge is engaged.
    const side = state.edge >= 0 ? 1 : -1;
    const lateral = (1.6 + intensity * 3.4) * side;
    const back = -speed * 0.1;
    const up = 1.4 + intensity * 2.6;

    this.velocities[p] = state.right.x * lateral + state.forward.x * back + jitter() * 1.2;
    this.velocities[p + 1] = up + jitter() * 0.8;
    this.velocities[p + 2] = state.right.z * lateral + state.forward.z * back + jitter() * 1.2;

    this.life[i] = 0.75 + this.rng() * 0.35;
    this.size[i] = 0.09 + this.rng() * 0.13 + intensity * 0.07;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
