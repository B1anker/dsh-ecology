import { defineConfig } from '@rstest/core'

/**
 * Test configuration.
 *
 * The suite is Node-side throughout: it opens real sockets, writes real files
 * into temporary directories, and derives real scrypt keys. `node` is rstest's
 * default environment, but it is stated explicitly because a DOM environment
 * here would not fail loudly — it would quietly shadow globals this code takes
 * from Node.
 */
export default defineConfig({
  testEnvironment: 'node',
  include: ['test/**/*.test.ts'],
  // Each file gets a fresh module registry. The integration suite mutates
  // `process.env` and decorates a shared registry object, so leaking state
  // between files would make failures depend on execution order.
  isolate: true,
  coverage: {
    // Off by default and on in CI, because collecting it costs about a third of
    // the run and the answer only has to be right before a merge.
    enabled: false,
    provider: 'v8',
    include: [
      // Top-level Node modules only. `src/client/**` is React UI for the shell
      // host and is covered by focused unit tests, not v8 instrumentation here.
      'src/*.ts',
    ],
    exclude: [
      // A top-level script: importing it runs it, prompts for a password, and
      // writes a file. It is covered by spawning the built binary in
      // `test/unit/hash-password-cli.test.ts`, which the provider cannot see
      // into, so counting it here would report a hole the suite does fill.
      'src/hash-password.ts',
      'src/create-recovery.ts',
      // Declarations only. It emits no JavaScript, so it is permanently 0% and
      // would drag every total down by a constant that means nothing.
      'src/types.ts',
      // Process discovery / detached spawn against the live host. Unit tests
      // cover the pure argv helpers; the ps/kill/relaunch path is best-effort
      // OS glue that cannot be exercised without faking the host machine.
      'src/restart-dsh.ts',
    ],
    reporters: ['text', 'html'],
    thresholds: {
      // Set just under where the suite already sits. A threshold above the
      // current number is a wish; one below it is a ratchet, which is the only
      // thing it can usefully be — it fails the build when a change removes
      // coverage rather than when someone forgets to add it.
      //
      // Ratched down for the GitHub OAuth / enrollment surface: those modules
      // are exercised by integration tests for the happy and reject paths, but
      // not every error branch yet. Raise again as those suites grow.
      statements: 85,
      functions: 92,
      branches: 79,
      lines: 87,
      // The two modules that decide whether a request carries a live session.
      // A branch here is not a line of code, it is a way in.
      'src/{cookies,sessions}.ts': {
        statements: 100,
        branches: 100,
        perFile: true,
      },
      // The third such module, held one point lower for one reason: the
      // callback `crypto.scrypt` invokes on failure. At fixed cost parameters
      // and a length-checked password there is no input that reaches it, so the
      // alternative to this number is a test that fakes the failure and proves
      // only that the fake works.
      'src/verifier.ts': {
        statements: 97,
        branches: 95,
        perFile: true,
      },
    },
  },
})
