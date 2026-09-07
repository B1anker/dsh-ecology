/** Coordinates entry without delaying slow startups further or navigating after cancellation. */
export class EntryTransition {
  private started = Date.now()
  private cancelled = false
  private skipped = false
  private release: (() => void) | undefined
  private completion: Promise<boolean> | undefined
  constructor(
    private options: {
      warp(): void
      navigate(url: string): void
      holdMs?: number
      warpMs?: number
    },
  ) {}
  skip() {
    this.skipped = true
    this.release?.()
  }
  cancel() {
    this.cancelled = true
    this.release?.()
  }
  finish(url: string): Promise<boolean> {
    return (this.completion ??= this.run(url))
  }
  private wait(ms: number) {
    if (this.cancelled || this.skipped || ms <= 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.release = undefined
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.release = done
    })
  }
  private async run(url: string) {
    await this.wait((this.options.holdMs ?? 800) - (Date.now() - this.started))
    if (this.cancelled) return false
    if (!this.skipped) {
      this.options.warp()
      await this.wait(this.options.warpMs ?? 1250)
    }
    if (this.cancelled) return false
    this.options.navigate(url)
    return true
  }
}
