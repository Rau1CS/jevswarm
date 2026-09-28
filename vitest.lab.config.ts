import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/lab/**/*.lab.ts'], testTimeout: 3_600_000 },
});
