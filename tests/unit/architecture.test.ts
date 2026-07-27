import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Enforces the one architectural rule the whole design rests on: the simulation
 * is a pure function of (state, input, terrain, dt).
 *
 * oxlint enforces this too, but a test is what keeps it true when someone runs a
 * codemod, disables a lint rule, or adds a file the lint globs miss. The payoff is
 * concrete: because sim/ has no renderer and no DOM, the board physics, the
 * landing grader and the whole race can be tested in Node with no GPU.
 */

const ROOT = new URL('../../', import.meta.url).pathname;
const PURE_DIRS = ['src/sim', 'src/track', 'src/race', 'src/core'];

function collectFiles(dir: string): string[] {
  const abs = join(ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(abs, entry);
    if (statSync(full).isDirectory()) out.push(...collectFiles(join(dir, entry)));
    else if (entry.endsWith('.ts')) out.push(join(dir, entry));
  }
  return out;
}

const pureFiles = PURE_DIRS.flatMap(collectFiles);

describe('simulation purity', () => {
  it('finds the pure modules (guards against the glob silently matching nothing)', () => {
    expect(pureFiles.length).toBeGreaterThan(5);
  });

  it.each(pureFiles)('%s does not import the renderer, DOM or audio', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const spec of imports) {
      expect(spec, `${rel} imports ${spec}`).not.toBe('three');
      expect(spec, `${rel} imports ${spec}`).not.toMatch(/^three\//);
      expect(spec, `${rel} imports ${spec}`).not.toMatch(/\/(render|hud|audio|dev)\//);
      // `node` types are enabled project-wide for the config files and the test
      // suite, so tsc will not stop a sim file reaching for the filesystem. This
      // will. A pure module that needs node has stopped being portable to the
      // browser, which is where it actually runs.
      expect(spec, `${rel} imports ${spec}`).not.toMatch(/^node:/);
    }
  });

  it.each(pureFiles)('%s does not read a wall clock or global RNG', (rel) => {
    const src = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
    // Math.random makes a run unreproducible; Date.now / performance.now make the
    // result depend on how fast the machine is, which is the definition of a
    // frame-rate-dependent bug.
    expect(src, `${rel} uses Math.random`).not.toMatch(/\bMath\s*\.\s*random\b/);
    expect(src, `${rel} uses Date.now`).not.toMatch(/\bDate\s*\.\s*now\b/);
    expect(src, `${rel} uses performance.now`).not.toMatch(/\bperformance\s*\.\s*now\b/);
  });

  it.each(pureFiles)('%s does not touch the DOM', (rel) => {
    const src = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
    expect(src, `${rel} touches document`).not.toMatch(/\bdocument\s*\./);
    expect(src, `${rel} touches window`).not.toMatch(/\bwindow\s*\./);
    expect(src, `${rel} touches localStorage`).not.toMatch(/\blocalStorage\b/);
  });
});

describe('terrain generation portability', () => {
  // Terrain generation feeds a golden hash that is meant to hold across JS
  // engines, and ECMA-262 leaves the precision of exp/log/sin/cos/tan/pow
  // implementation-defined. So that path is restricted to + - * / and sqrt.
  //
  // Note this rule applies to terrain generation only. The board physics does use
  // Math.exp for frame-rate-independent decay, which is fine: ghosts are recorded
  // as transforms rather than replayed inputs, so cross-engine bit-exactness is
  // not required there.
  const generationFiles = collectFiles('src/track').concat(collectFiles('src/core'));

  // `src/core` is swept wholesale rather than by an allowlist, because a new helper is far
  // more likely to be reached by the generator than not, and the failure mode of missing
  // one is a golden hash that quietly stops being portable. These are the files that are
  // demonstrably *not* on the generation path, each exempt for a stated reason:
  //
  //  - math.ts     exports expDecay, which is Math.exp on purpose. Used by the board
  //                physics for frame-rate-independent decay, never by the generator.
  //  - quat.ts     orientation for ghost recording. Ghosts are transform captures, so
  //                nothing about them needs to be reproducible on another engine.
  const NOT_GENERATION = ['math.ts', 'quat.ts'];

  it.each(generationFiles.filter((f) => !NOT_GENERATION.some((name) => f.endsWith(name))))(
    '%s avoids implementation-defined transcendentals',
    (rel) => {
      const src = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
      for (const fn of ['sin', 'cos', 'tan', 'pow', 'exp', 'log', 'atan2', 'asin', 'acos']) {
        expect(src, `${rel} uses Math.${fn}`).not.toMatch(new RegExp(`\\bMath\\s*\\.\\s*${fn}\\b`));
      }
    },
  );
});

/** Strip comments so prose about `Math.random` does not fail the test. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
