import * as THREE from 'three';
import { clamp, lerp, smoothTowards } from '../core/math.js';
import type { BoardState } from '../sim/BoardState.js';
import { LIGHTING_GLSL, type Environment } from './Environment.js';

/**
 * The rider, built from primitives in code.
 *
 * No modelling pipeline, no external assets, no rigging -- a blocky figure and a
 * board, leaned and pitched procedurally. That is deliberate for the vertical slice:
 * art must not be able to block work on how the ride feels, and a placeholder that
 * reads clearly at speed is worth more here than a good-looking one that arrives
 * late.
 *
 * The suspension the player sees lives here rather than in the physics. The board
 * snaps hard to the surface in `Board.ts`, and this class adds a critically-damped
 * visual spring on top -- so the compression reads as suspension without putting any
 * softness into the ground/air boundary that the charged ollie times against.
 */
export class RiderView {
  readonly group = new THREE.Group();

  private readonly board: THREE.Mesh;
  private readonly rider: THREE.Group;

  /** Visual suspension: current offset and its velocity, in metres. */
  private squash = 0;
  private squashVel = 0;
  private visualPitch = 0;
  private visualRoll = 0;
  private visualLean = 0;

  private readonly materials: THREE.Material[] = [];

  constructor(env: Environment) {
    const boardMat = this.stylizedMaterial(env, 0x2f6fdb);
    const suitMat = this.stylizedMaterial(env, 0xe8523f);
    const darkMat = this.stylizedMaterial(env, 0x22262e);

    // Board: 1.55 m long, slightly tapered. Long axis along +X to match yaw 0.
    const boardGeo = new THREE.BoxGeometry(1.55, 0.055, 0.29);
    this.board = new THREE.Mesh(boardGeo, boardMat);
    this.board.castShadow = false;
    this.group.add(this.board);

    this.rider = new THREE.Group();

    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.62, 0.34), darkMat);
    legs.position.y = 0.34;
    this.rider.add(legs);

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.62, 0.44), suitMat);
    torso.position.y = 0.94;
    this.rider.add(torso);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), darkMat);
    head.position.y = 1.4;
    this.rider.add(head);

    // Arms out for balance. They do most of the work of making the rider's roll and
    // rotation readable from a chase camera, so they are deliberately long and wide.
    const armGeo = new THREE.BoxGeometry(0.15, 0.54, 0.15);
    const armL = new THREE.Mesh(armGeo, suitMat);
    armL.position.set(0.04, 0.95, 0.4);
    armL.rotation.x = -0.62;
    this.rider.add(armL);
    const armR = new THREE.Mesh(armGeo, suitMat);
    armR.position.set(0.04, 0.95, -0.4);
    armR.rotation.x = 0.62;
    this.rider.add(armR);

    // Stance angle. A snowboarder stands across the board, which from directly behind
    // presents edge-on -- a featureless column with both arms hidden behind the
    // torso. Angling to about 50 degrees instead shows a three-quarter back view, so
    // the shoulders give the silhouette width and the arms stay visible. It is the
    // same cheat every snowboarding game uses, and it is what makes rotation legible.
    this.rider.rotation.y = Math.PI * 0.28;
    this.group.add(this.rider);
  }

  private stylizedMaterial(env: Environment, color: number): THREE.ShaderMaterial {
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...env.uniforms, uColor: { value: new THREE.Color(color) } },
      vertexShader: /* glsl */ `
        varying vec3 vNormalW;
        varying float vViewDepth;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vec4 viewPos = viewMatrix * worldPos;
          vViewDepth = -viewPos.z;
          gl_Position = projectionMatrix * viewPos;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uColor;
        varying vec3 vNormalW;
        varying float vViewDepth;
        ${LIGHTING_GLSL}
        void main() {
          vec3 lit = applyLighting(uColor, normalize(vNormalW));
          gl_FragColor = vec4(applyFog(lit, vViewDepth), 1.0);
        }
      `,
    });
    this.materials.push(mat);
    return mat;
  }

  /**
   * Pose the rider from interpolated simulation state.
   *
   * `dt` is real frame time, not the fixed timestep: everything here is presentation,
   * so it is allowed to be frame-rate dependent in a way the simulation is not.
   */
  update(state: BoardState, dt: number): void {
    // --- Visual suspension. Critically damped at omega = 18 rad/s, driven by how
    // hard the board just met the surface.
    const omega = 18;
    const target = state.grounded ? -clamp(state.skid * 0.05, 0, 0.06) : 0.02;
    const accel = omega * omega * (target - this.squash) - 2 * omega * this.squashVel;
    this.squashVel += accel * Math.min(dt, 0.05);
    this.squash += this.squashVel * Math.min(dt, 0.05);

    this.group.position.set(state.pos.x, state.pos.y + this.squash, state.pos.z);

    // --- Pitch across the board from nose and tail surface heights. Airborne, ease
    // back to the velocity direction so the board points where it is going.
    let pitchTarget: number;
    if (state.grounded) {
      const span = 1.24;
      pitchTarget = Math.atan2(state.noseY - state.tailY, span);
    } else {
      const horiz = Math.hypot(state.vel.x, state.vel.z);
      pitchTarget = Math.atan2(state.vel.y, Math.max(horiz, 1e-3));
    }
    this.visualPitch = smoothTowards(this.visualPitch, pitchTarget, 0.09, dt);

    // --- Roll from the surface across the board, plus the rider's own lean into the
    // turn. The lean is what makes a carve look committed rather than a slide.
    const acrossRoll = Math.asin(clamp(-state.right.y, -1, 1));
    const leanTarget = clamp(state.edge, -1, 1) * 0.42;
    this.visualRoll = smoothTowards(this.visualRoll, acrossRoll, 0.07, dt);
    this.visualLean = smoothTowards(this.visualLean, leanTarget, 0.11, dt);

    // Order matters: yaw, then pitch along the board, then roll across it.
    this.group.rotation.set(0, 0, 0);
    this.group.rotateY(-state.yaw);
    this.group.rotateZ(this.visualPitch);
    this.group.rotateX(this.visualRoll + this.visualLean);

    // Crouch while charging: the visual tell that a pop is coming, and the same
    // motion that costs speed in the simulation.
    const crouch = lerp(1, 0.72, state.jumpCharge);
    this.rider.scale.set(1, crouch, 1);
  }

  dispose(): void {
    for (const mat of this.materials) mat.dispose();
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
  }
}
