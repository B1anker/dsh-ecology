import { defineConfig } from '@rstest/core'

/** Node-side Git integration tests with the repository-standard V8 coverage provider. */
export default defineConfig({
  include: ['test/**/*.test.ts'],
  coverage: {
    enabled: false,
    provider: 'v8',
    include: ['src/**/*.ts'],
    reporters: ['text'],
  },
})
