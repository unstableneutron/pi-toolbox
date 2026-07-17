export default {
  test: {
    include: [
      '*.test.ts',
      'src/**/*.test.ts',
      'tests/**/*.test.ts',
      'extensions/**/*.test.ts',
      'packages/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    reporters: 'dot',
    silent: 'passed-only',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
};
