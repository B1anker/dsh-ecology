/**
 * Small, runner-independent primitives shared by contract scenarios.
 *
 * A contract is deliberately expressed in terms of a driver instead of a
 * concrete mock. This lets the same behaviour run against a cheap in-memory
 * double and an opt-in real DSH composition without making either depend on a
 * particular test runner.
 */

/** A value that may require asynchronous setup or cleanup. */
export type Awaitable<T> = T | PromiseLike<T>

/** A test driver that owns resources such as a socket or a Cordis fiber. */
export interface DisposableDriver {
  dispose: () => Awaitable<void>
}

/** One named, portable behavioural assertion. */
export interface ContractCase<Driver extends DisposableDriver> {
  /** Stable identifier for compatibility reports. */
  id: string
  /** Human-readable assertion title. */
  title: string
  /** Exercise a fresh driver. Implementations should throw on failure. */
  run: (driver: Driver) => Awaitable<void>
  /** Optional assertion after the driver has completed its own cleanup. */
  afterDispose?: (driver: Driver) => Awaitable<void>
}

/** Create a fresh driver for one contract assertion. */
export type DriverFactory<Driver extends DisposableDriver> = () => Awaitable<Driver>

/** One assertion outcome, suitable for a CI compatibility artifact. */
export interface ContractCaseResult {
  id: string
  title: string
  status: 'pass' | 'fail'
  durationMs: number
  error?: string
}

/** Results for every scenario in one contract run. */
export interface ContractReport {
  cases: ContractCaseResult[]
  passed: boolean
}

/**
 * Run contract scenarios sequentially, always disposing each fresh driver.
 *
 * The helper records every case instead of failing on the first one so CI can
 * write a useful compatibility report. It does not swallow failures: callers
 * receive a report and can decide whether the lane should fail.
 */
export async function verifyContract<Driver extends DisposableDriver>(
  cases: readonly ContractCase<Driver>[],
  create: DriverFactory<Driver>,
): Promise<ContractReport> {
  const results: ContractCaseResult[] = []

  for (const scenario of cases) {
    const started = performance.now()
    let driver: Driver | undefined
    try {
      driver = await create()
      await scenario.run(driver)
      results.push({
        id: scenario.id,
        title: scenario.title,
        status: 'pass',
        durationMs: performance.now() - started,
      })
    } catch (error) {
      results.push({
        id: scenario.id,
        title: scenario.title,
        status: 'fail',
        durationMs: performance.now() - started,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      })
    } finally {
      if (driver !== undefined) {
        await driver.dispose()
        await scenario.afterDispose?.(driver)
      }
    }
  }

  return { cases: results, passed: results.every((result) => result.status === 'pass') }
}
