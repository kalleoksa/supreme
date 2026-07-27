import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node, not jsdom. A sim file that reaches for `document` should fail the
    // test suite -- that is free enforcement of the render/sim boundary.
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    /**
     * Generous, because several tests here do genuinely heavy numeric work: the
     * mesh-versus-sampler check raycasts real geometry at 4000 points (~2 s
     * locally), and the physics fuzz test runs 20,000 simulation steps. Those are
     * the most valuable tests in the suite and should not be traded away for
     * speed.
     *
     * Shared CI runners are commonly 2-3x slower than a dev machine, so the 5 s
     * default was close enough to flake -- and did: a per-element assertion loop
     * over 481,601 heightfield posts took 5.9 s on a runner and passed locally.
     * That one was a badly written test and got fixed, but the margin is the real
     * problem. If something in here starts taking 20 s, it is broken, not slow.
     */
    testTimeout: 20_000,
  },
});
