import type { BestRun } from '../race/Race.js';

/**
 * The personal best, in `localStorage`.
 *
 * Lives in `app/` because the simulation is not allowed to know about storage -- that
 * is the same rule that lets the whole race be tested in Node. The race produces a
 * `BestRun`; this decides where it goes.
 *
 * Everything here treats storage as untrustworthy. `localStorage` throws outright in
 * Safari's private mode, it can be full, and its contents are user-editable text that
 * may have been written by an older version of the game. A corrupt best time must
 * degrade to "no best time yet", never to a crash on boot.
 */

/**
 * Storage key, versioned by track and by schema.
 *
 * The `v1` is the part that matters: a tuning change alters what a time on this track
 * means, and comparing against a best set under different physics is worse than having
 * no best at all. Bumping the suffix retires old times cleanly.
 */
export function bestRunKey(track: string): string {
  return `whiteout.best.v1.${track}`;
}

function isBestRun(value: unknown): value is BestRun {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<BestRun>;
  return (
    typeof v.time === 'number' &&
    Number.isFinite(v.time) &&
    v.time > 0 &&
    Array.isArray(v.splits) &&
    v.splits.every((s) => typeof s === 'number' && Number.isFinite(s)) &&
    typeof v.score === 'number' &&
    typeof v.resets === 'number'
  );
}

export function loadBestRun(track: string): BestRun | undefined {
  try {
    const raw = localStorage.getItem(bestRunKey(track));
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isBestRun(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Store `run` if it beats `previous`.
 *
 * @returns the best run after the comparison, so the caller can keep using one value
 *   without re-reading storage.
 */
export function saveBestRun(track: string, run: BestRun, previous?: BestRun): BestRun {
  if (previous !== undefined && previous.time <= run.time) return previous;
  try {
    localStorage.setItem(bestRunKey(track), JSON.stringify(run));
  } catch {
    // Full, or blocked. The run still counts for this session.
  }
  return run;
}
