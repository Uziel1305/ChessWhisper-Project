// Jest's defaults are otherwise correct for this project, so this file exists to
// register one thing: the gate that turns an application-level console.error
// into a failing test (test/helpers/serverErrors.js).
//
// Deliberately absent:
//   - maxWorkers. Parallelism is not what makes this suite reliable — the
//     lifecycle races reproduce identically under --runInBand — so pinning it
//     here would hide a concurrency bug rather than fix one. The `npm test`
//     script still passes --runInBand; `npx jest` still runs parallel, and both
//     are expected to agree.
//   - testTimeout / forceExit. Raising either would mask a hang instead of
//     reporting it.
module.exports = {
    setupFilesAfterEnv: ['<rootDir>/test/helpers/serverErrors.js'],
};
