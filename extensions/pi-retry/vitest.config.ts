export default {
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    reporters: 'dot',
    silent: 'passed-only',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
};
