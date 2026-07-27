import * as THREE from 'three';
import type { ScatterInstance } from '../track/generate.js';
import type { ScatterSpecies } from '../track/TrackSpec.js';
import { LIGHTING_GLSL, type Environment } from './Environment.js';

/**
 * Scattered props, instanced.
 *
 * One `InstancedMesh` per species: thousands of trees for one draw call each. That is the
 * only reason a mountain can be populated at all inside a fifty-draw budget, and it is the
 * discipline the plan adopts from the first commit precisely because retrofitting it later
 * means rewriting whatever came to depend on per-object meshes.
 *
 * Geometry is built in code from cones and cylinders, like the rider -- no modelling
 * pipeline and no external assets, because art must not be able to block work on how the
 * ride feels.
 *
 * ## What scatter is actually for
 *
 * Two things, and the second is the one worth protecting. Props give the eye something to
 * judge speed against, which a smooth white field cannot. And they turn a wide open face
 * into a set of real route choices -- which is why the placement rules deliberately do
 * *not* clear the corridor centre. A bare racing line makes "freedom of line" mean only
 * that the corridor is wide.
 */

/** Vertical lift, so a trunk is not half-buried by the terrain triangulation. */
const SINK = 0.3;

function speciesGeometry(species: ScatterSpecies): THREE.BufferGeometry {
  // A conifer: a tapered trunk plus two stacked cones. Cheap, and the silhouette reads as a
  // tree at the distance that matters, which is all a speed reference has to do.
  const parts: THREE.BufferGeometry[] = [];

  const trunk = new THREE.CylinderGeometry(species.radius * 0.55, species.radius * 0.8, 1, 5);
  trunk.translate(0, 0.5, 0);
  parts.push(trunk);

  const lower = new THREE.ConeGeometry(1, 1, 6);
  lower.scale(1, 1, 1);
  lower.translate(0, 0.5, 0);
  parts.push(lower);

  const upper = new THREE.ConeGeometry(0.62, 0.75, 6);
  upper.translate(0, 1.05, 0);
  parts.push(upper);

  // Merged by hand rather than with BufferGeometryUtils: the utility pulls in a module for
  // three concatenations, and the attribute sets here are known and identical.
  return mergeGeometries(parts);
}

function mergeGeometries(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vertexCount = 0;
  let indexCount = 0;
  for (const part of parts) {
    vertexCount += part.getAttribute('position').count;
    indexCount += part.getIndex()?.count ?? part.getAttribute('position').count;
  }

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  // Per-vertex height fraction, so the shader can shade the canopy differently from the
  // trunk without a second material or a texture.
  const region = new Float32Array(vertexCount);
  const index = new Uint32Array(indexCount);

  let vOffset = 0;
  let iOffset = 0;
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    const pos = part.getAttribute('position');
    const nrm = part.getAttribute('normal');
    position.set(pos.array as Float32Array, vOffset * 3);
    normal.set(nrm.array as Float32Array, vOffset * 3);
    // Part 0 is the trunk; everything after it is canopy.
    region.fill(p === 0 ? 0 : 1, vOffset, vOffset + pos.count);

    const idx = part.getIndex();
    if (idx) {
      for (let k = 0; k < idx.count; k++) index[iOffset + k] = idx.getX(k) + vOffset;
      iOffset += idx.count;
    } else {
      for (let k = 0; k < pos.count; k++) index[iOffset + k] = k + vOffset;
      iOffset += pos.count;
    }
    vOffset += pos.count;
    part.dispose();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('aRegion', new THREE.BufferAttribute(region, 1));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  return geo;
}

function scatterMaterial(env: Environment): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...env.uniforms,
      uTrunk: { value: new THREE.Color(0x4a3b32) },
      uCanopy: { value: new THREE.Color(0x2f5541) },
    },
    vertexShader: /* glsl */ `
      attribute float aRegion;
      varying float vRegion;
      varying vec3 vNormalW;
      varying float vViewDepth;
      void main() {
        vRegion = aRegion;
        // instanceMatrix is supplied by three.js for an InstancedMesh.
        vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        vec4 viewPos = viewMatrix * worldPos;
        vViewDepth = -viewPos.z;
        gl_Position = projectionMatrix * viewPos;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uTrunk;
      uniform vec3 uCanopy;
      varying float vRegion;
      varying vec3 vNormalW;
      varying float vViewDepth;
      ${LIGHTING_GLSL}
      void main() {
        vec3 albedo = mix(uTrunk, uCanopy, step(0.5, vRegion));
        vec3 lit = applyLighting(albedo, normalize(vNormalW));
        gl_FragColor = vec4(applyFog(lit, vViewDepth), 1.0);
      }
    `,
  });
}

export class Scatter {
  readonly group = new THREE.Group();

  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly material: THREE.ShaderMaterial;

  constructor(
    env: Environment,
    species: readonly ScatterSpecies[],
    instances: readonly ScatterInstance[],
  ) {
    this.material = scatterMaterial(env);

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();

    for (let s = 0; s < species.length; s++) {
      const mine = instances.filter((inst) => inst.speciesIndex === s);
      if (mine.length === 0) continue;

      const geo = speciesGeometry(species[s]);
      const mesh = new THREE.InstancedMesh(geo, this.material, mine.length);
      // Static for the whole run: uploaded once, never touched again.
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

      for (let i = 0; i < mine.length; i++) {
        const inst = mine[i];
        position.set(inst.x, inst.y - SINK, inst.z);
        quaternion.setFromAxisAngle(UP, inst.rotation);
        // The unit geometry is 1 m tall and `radius` wide, so height scales Y and the
        // horizontal scale follows it -- a taller tree of a species is a bigger tree, not a
        // stretched one.
        const spread = inst.height / Math.max(0.001, species[s].height);
        scale.set(spread, inst.height, spread);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(i, matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();

      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  /** Draw calls this adds: one per species that actually placed anything. */
  get drawCalls(): number {
    return this.meshes.length;
  }

  get instanceCount(): number {
    return this.meshes.reduce((sum, m) => sum + m.count, 0);
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.material.dispose();
    this.meshes.length = 0;
    this.group.clear();
  }
}

const UP = new THREE.Vector3(0, 1, 0);
