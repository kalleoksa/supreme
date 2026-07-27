import * as THREE from 'three';
import { VIEW_DISTANCE } from '../app/config.js';

/**
 * Lighting, fog and sky, as a set of shared uniform objects.
 *
 * This is the *only* writer of fog, sun and ambient. Weather is deferred out of
 * M1, but the hook is here now for a reason: every terrain and scatter material
 * shares these uniform objects, so switching preset is a uniform write rather
 * than a material rebuild. Rebuilding materials mid-menu means a multi-second
 * shader recompile hitch, and discovering that later means touching every
 * material in the game.
 */
export interface WeatherPreset {
  readonly id: string;
  readonly fogColor: number;
  readonly fogDensity: number;
  readonly sunDirection: THREE.Vector3;
  readonly sunColor: number;
  readonly sunIntensity: number;
  readonly skyColor: number;
  readonly groundBounce: number;
  readonly ambientIntensity: number;
  /** Scales view distance. Heavy weather is legitimately a performance lever. */
  readonly visibilityScale: number;
}

export const OVERCAST: WeatherPreset = {
  id: 'overcast',
  fogColor: 0xd7e2ec,
  fogDensity: 0.0016,
  // Low, raking light: it is what makes snow relief readable at all. A high sun
  // flattens a white surface into a featureless sheet.
  sunDirection: new THREE.Vector3(-0.42, 0.66, -0.62).normalize(),
  sunColor: 0xfff4e2,
  // Ambient dominates, and the sun is a modest shaping light on top. That ratio is
  // what a snowfield actually looks like: the surface bounces so much light that a
  // strong directional term crushes shadowed faces to black, which reads as tar
  // rather than as snow in shade.
  sunIntensity: 0.55,
  skyColor: 0xc6dbef,
  groundBounce: 0xa8bccf,
  ambientIntensity: 0.85,
  visibilityScale: 1,
};

export class Environment {
  /** Shared with every material that wants to be lit and fogged. */
  readonly uniforms = {
    uSunDir: { value: new THREE.Vector3() },
    uSunColor: { value: new THREE.Color() },
    uSunIntensity: { value: 1 },
    uSkyColor: { value: new THREE.Color() },
    uGroundColor: { value: new THREE.Color() },
    uAmbient: { value: 0.5 },
    uFogColor: { value: new THREE.Color() },
    uFogDensity: { value: 0.0016 },
  };

  private preset: WeatherPreset = OVERCAST;

  constructor(private readonly scene: THREE.Scene) {
    this.apply(OVERCAST);
  }

  apply(preset: WeatherPreset): void {
    this.preset = preset;
    const u = this.uniforms;
    u.uSunDir.value.copy(preset.sunDirection).normalize();
    u.uSunColor.value.setHex(preset.sunColor);
    u.uSunIntensity.value = preset.sunIntensity;
    u.uSkyColor.value.setHex(preset.skyColor);
    u.uGroundColor.value.setHex(preset.groundBounce);
    u.uAmbient.value = preset.ambientIntensity;
    u.uFogColor.value.setHex(preset.fogColor);
    u.uFogDensity.value = preset.fogDensity / preset.visibilityScale;

    this.scene.background = u.uFogColor.value.clone();
  }

  get current(): WeatherPreset {
    return this.preset;
  }

  get viewDistance(): number {
    return VIEW_DISTANCE * this.preset.visibilityScale;
  }
}

/**
 * GLSL shared by every lit surface: hemispheric ambient plus one banded
 * directional term, then exponential-squared fog.
 *
 * The banding is the whole stylized look. A continuous lambert term on snow
 * reads as a washed-out grey mush; quantizing it into a few steps gives the
 * terrain legible shape, which matters more here than realism because the player
 * is reading the surface for launch lips at speed.
 */
export const LIGHTING_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;

vec3 applyLighting(vec3 albedo, vec3 normal) {
  // Wrapped hemispheric ambient. The 0.35 floor keeps a face turned fully away
  // from the sky from going black -- on snow there is no such thing as an unlit
  // surface, and a black shoulder reads as a hole in the world.
  float hemi = normal.y * 0.5 + 0.5;
  vec3 ambient = mix(uGroundColor, uSkyColor, 0.35 + 0.65 * hemi) * uAmbient;

  // Wrapped diffuse: shifting the terminator past 90 degrees softens it, which is
  // how a highly-scattering surface like snow behaves and also stops the banding
  // below from producing a hard line across an otherwise smooth slope.
  float ndl = dot(normal, uSunDir) * 0.5 + 0.5;
  ndl = max(ndl * ndl, 0.0);

  // Six bands, half-mixed back toward continuous. The banding is the stylized
  // look and, more usefully, it makes terrain shape legible at speed -- a
  // continuous lambert term on white snow is a washed-out mush you cannot read a
  // launch lip out of.
  float banded = floor(ndl * 6.0) / 6.0;
  banded = mix(banded, ndl, 0.5);
  vec3 direct = uSunColor * uSunIntensity * banded;

  return albedo * (ambient + direct);
}

vec3 applyFog(vec3 color, float viewDepth) {
  float f = 1.0 - exp(-uFogDensity * uFogDensity * viewDepth * viewDepth);
  return mix(color, uFogColor, clamp(f, 0.0, 1.0));
}
`;
