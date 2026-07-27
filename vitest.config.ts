import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node, not jsdom. A sim file that reaches for `document` should fail the
    // test suite -- that is free enforcement of the render/sim boundary.
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
