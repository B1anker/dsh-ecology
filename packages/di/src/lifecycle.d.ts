/**
 * The one lifecycle convention the container understands: a service with a
 * `dispose()` method is disposed with the container that built it.
 *
 * @module @seaveyon/dsh-di/lifecycle
 */
/** Something that releases what it holds when asked. */
export interface IDisposable {
  dispose(): void
}
/** True when `value` has a callable `dispose` — the whole test the container applies. */
export declare function isDisposable(value: unknown): value is IDisposable
/** Wrap a teardown function as a disposable, for registering non-class resources. */
export declare function toDisposable(dispose: () => void): IDisposable
