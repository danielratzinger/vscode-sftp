// The end-to-end suite runs real servers and real sockets, so it is slower and
// kept out of `npm test`.
module.exports = {
  verbose: true,
  moduleFileExtensions: ['ts', 'js'],
  transform: { '^.+\\.ts$': '<rootDir>/test/preprocessor.js' },
  testMatch: ['<rootDir>/e2e/**/*.e2e.ts'],
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/e2e/setup.js'],
  // Serially: these run real servers on real sockets with real timers, and a
  // webpack build in one suite starves the timing in another.
  maxWorkers: 1,
};
