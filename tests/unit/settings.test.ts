import { describe, expect, it } from 'vitest';
import { COMFORT_RANGES, sanitizeComfort } from '../../src/app/settings.js';
import { DEFAULT_COMFORT } from '../../src/render/ChaseCamera.js';

/**
 * `loadSettings` and `saveSettings` touch `localStorage`, which does not exist in the Node
 * test environment -- they are covered end to end in `tests/e2e/comfort.spec.ts`, in a real
 * browser, which is the only place the storage behaviour is real anyway.
 *
 * What is worth testing here is the sanitizer, because it is the part that has to hold
 * against text a user can edit by hand and against a blob written by an older version.
 */
describe('comfort settings sanitizer', () => {
  it('passes valid settings through', () => {
    const stored = { fovWithSpeed: false, shakeScale: 0.5, distanceScale: 1.2, rollDegrees: 4 };
    expect(sanitizeComfort(stored, DEFAULT_COMFORT)).toEqual(stored);
  });

  it('falls back to the defaults for anything unusable', () => {
    expect(sanitizeComfort(null, DEFAULT_COMFORT)).toEqual(DEFAULT_COMFORT);
    expect(sanitizeComfort('nonsense', DEFAULT_COMFORT)).toEqual(DEFAULT_COMFORT);
    expect(sanitizeComfort(42, DEFAULT_COMFORT)).toEqual(DEFAULT_COMFORT);
    expect(sanitizeComfort({}, DEFAULT_COMFORT)).toEqual(DEFAULT_COMFORT);
  });

  it('keeps the fields it understands and defaults the rest', () => {
    // The older-version case: a blob missing a knob added later must not lose the knobs it
    // does have.
    const partial = sanitizeComfort({ shakeScale: 0.25 }, DEFAULT_COMFORT);
    expect(partial.shakeScale).toBe(0.25);
    expect(partial.fovWithSpeed).toBe(DEFAULT_COMFORT.fovWithSpeed);
    expect(partial.distanceScale).toBe(DEFAULT_COMFORT.distanceScale);
  });

  it('clamps rather than trusting a stored number', () => {
    // Hand-edited storage with distanceScale 500 would put the camera in orbit, and the
    // player would have no way to work out why. Clamping is not paranoia here; it is the
    // difference between a weird setting and an unplayable game with no visible cause.
    const wild = sanitizeComfort(
      { shakeScale: 900, distanceScale: -50, rollDegrees: 1e9 },
      DEFAULT_COMFORT,
    );
    expect(wild.shakeScale).toBe(COMFORT_RANGES.shakeScale[1]);
    expect(wild.distanceScale).toBe(COMFORT_RANGES.distanceScale[0]);
    expect(wild.rollDegrees).toBe(COMFORT_RANGES.rollDegrees[1]);
  });

  it('rejects non-finite numbers', () => {
    const bad = sanitizeComfort(
      { shakeScale: Number.NaN, distanceScale: Infinity, rollDegrees: '3' },
      DEFAULT_COMFORT,
    );
    expect(bad.shakeScale).toBe(DEFAULT_COMFORT.shakeScale);
    expect(bad.distanceScale).toBe(DEFAULT_COMFORT.distanceScale);
    expect(bad.rollDegrees).toBe(DEFAULT_COMFORT.rollDegrees);
  });

  it('rejects a non-boolean for the toggle', () => {
    expect(sanitizeComfort({ fovWithSpeed: 'yes' }, DEFAULT_COMFORT).fovWithSpeed).toBe(
      DEFAULT_COMFORT.fovWithSpeed,
    );
  });

  it('defaults camera roll to zero', () => {
    // Roll is the single strongest nausea trigger in a chase camera, so it is opt-in only.
    expect(DEFAULT_COMFORT.rollDegrees).toBe(0);
  });

  it('has a range for every numeric knob', () => {
    // Guards the pairing: a knob added to the settings without a range would be sanitized
    // against `undefined` and clamp to NaN.
    for (const [key, range] of Object.entries(COMFORT_RANGES)) {
      expect(range[0], key).toBeLessThan(range[1]);
      expect(DEFAULT_COMFORT[key as keyof typeof COMFORT_RANGES]).toBeGreaterThanOrEqual(range[0]);
      expect(DEFAULT_COMFORT[key as keyof typeof COMFORT_RANGES]).toBeLessThanOrEqual(range[1]);
    }
  });
});
