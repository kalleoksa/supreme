import { DEFAULT_AUDIO, type AudioSettings } from '../audio/Audio.js';
import { clamp } from '../core/math.js';
import { DEFAULT_COMFORT, type CameraComfort } from '../render/ChaseCamera.js';

/**
 * Player settings, in `localStorage`.
 *
 * Same discipline as `bestRun.ts`: storage throws outright in Safari's private mode, can be
 * full, and holds user-editable text that may have been written by an older version. A
 * corrupt settings blob must degrade to the defaults, never to a crash on boot -- and
 * *especially* not here, since these are the settings someone who gets motion sick has
 * already had to find once.
 *
 * Every value is clamped on load rather than trusted. A `distanceScale` of 500 read out of
 * hand-edited storage would put the camera in orbit with no obvious way for the player to
 * work out why.
 */

const KEY = 'whiteout.settings.v1';

export interface Settings {
  comfort: CameraComfort;
  audio: AudioSettings;
}

/**
 * Defaults, with one accessibility decision baked in.
 *
 * When the operating system asks for reduced motion, screen shake starts at zero and
 * field-of-view-with-speed starts off. Both are motion effects a player who set that
 * preference has already told us they do not want, and honouring it silently is better than
 * making them find this panel after the first crash.
 */
export function defaultSettings(): Settings {
  const reduceMotion =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return {
    comfort: {
      ...DEFAULT_COMFORT,
      shakeScale: reduceMotion ? 0 : DEFAULT_COMFORT.shakeScale,
      fovWithSpeed: reduceMotion ? false : DEFAULT_COMFORT.fovWithSpeed,
    },
    audio: { ...DEFAULT_AUDIO },
  };
}

/** Bounds for each knob: `[min, max]`. Also what the panel builds its sliders from. */
export const COMFORT_RANGES = {
  shakeScale: [0, 1.5],
  distanceScale: [0.7, 1.8],
  rollDegrees: [0, 10],
} as const;

export const AUDIO_RANGES = { volume: [0, 1] } as const;

/** A stored number, clamped to its range, or the fallback when it is not usable at all. */
function num(value: unknown, fallback: number, range: readonly [number, number]): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, range[0], range[1])
    : fallback;
}

export function sanitizeComfort(raw: unknown, base: CameraComfort): CameraComfort {
  if (typeof raw !== 'object' || raw === null) return { ...base };
  const v = raw as Partial<CameraComfort>;
  return {
    fovWithSpeed: typeof v.fovWithSpeed === 'boolean' ? v.fovWithSpeed : base.fovWithSpeed,
    shakeScale: num(v.shakeScale, base.shakeScale, COMFORT_RANGES.shakeScale),
    distanceScale: num(v.distanceScale, base.distanceScale, COMFORT_RANGES.distanceScale),
    rollDegrees: num(v.rollDegrees, base.rollDegrees, COMFORT_RANGES.rollDegrees),
  };
}

export function sanitizeAudio(raw: unknown, base: AudioSettings): AudioSettings {
  if (typeof raw !== 'object' || raw === null) return { ...base };
  const v = raw as Partial<AudioSettings>;
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : base.enabled,
    volume: num(v.volume, base.volume, AUDIO_RANGES.volume),
  };
}

export function loadSettings(): Settings {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return base;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return base;
    const stored = parsed as { comfort?: unknown; audio?: unknown };
    return {
      comfort: sanitizeComfort(stored.comfort, base.comfort),
      audio: sanitizeAudio(stored.audio, base.audio),
    };
  } catch {
    return base;
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Full, or blocked. The setting still applies for this session.
  }
}
