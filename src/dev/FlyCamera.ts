import * as THREE from 'three';
import { clamp } from '../core/math.js';

/**
 * Free-fly debug camera: WASD to move, QE for altitude, drag to look, shift to
 * sprint.
 *
 * Exists so the terrain can be inspected before there is a rider to attach a
 * chase camera to. Phase 2 replaces it as the default view but keeps it available
 * for looking at the track.
 */
export class FlyCamera {
  enabled = false;
  speed = 40;

  private readonly keys = new Set<string>();
  private yaw = 0;
  private pitch = -0.25;
  private dragging = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly element: HTMLElement,
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    element.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointermove', this.onPointerMove);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    this.dragging = true;
    this.element.setPointerCapture(e.pointerId);
  };

  private onPointerUp = (): void => {
    this.dragging = false;
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.enabled || !this.dragging) return;
    this.yaw -= e.movementX * 0.0025;
    this.pitch = clamp(this.pitch - e.movementY * 0.0025, -1.5, 1.5);
  };

  /**
   * Point the camera at a world position from a sensible standoff.
   *
   * Applies the orientation immediately rather than waiting for `update()`, which
   * only runs when the fly controls are enabled. Without that, a build with debug
   * off would place the camera correctly and then leave it pointing at its default
   * heading -- away from the mountain, drawing nothing.
   */
  lookFrom(x: number, y: number, z: number, yaw: number): void {
    this.setPose(x, y, z, yaw, -0.2);
  }

  setPose(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.camera.position.set(x, y, z);
    this.yaw = yaw;
    this.pitch = clamp(pitch, -1.5, 1.5);
    this.applyOrientation();
  }

  private applyOrientation(): THREE.Quaternion {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    this.camera.quaternion.copy(q);
    return q;
  }

  update(dt: number): void {
    if (!this.enabled) return;

    const q = this.applyOrientation();

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);

    const move = new THREE.Vector3();
    if (this.keys.has('KeyW')) move.add(forward);
    if (this.keys.has('KeyS')) move.sub(forward);
    if (this.keys.has('KeyD')) move.add(right);
    if (this.keys.has('KeyA')) move.sub(right);
    if (this.keys.has('KeyE')) move.y += 1;
    if (this.keys.has('KeyQ')) move.y -= 1;

    if (move.lengthSq() > 0) {
      move.normalize();
      const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 4 : 1;
      this.camera.position.addScaledVector(move, this.speed * sprint * dt);
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointermove', this.onPointerMove);
  }
}
