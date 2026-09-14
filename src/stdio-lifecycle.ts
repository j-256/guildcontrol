import { randomUUID } from "node:crypto"
import { performance } from "node:perf_hooks"

export const STDIO_SHUTDOWN_TIMEOUT_MS = 5_000
export const STDIO_SHUTDOWN_COMPONENTS = Object.freeze([
  "gateway", "native-interactions", "mcp", "tools", "telemetry",
] as const)

const SHUTDOWN_REASONS = Object.freeze([
  "caller", "stdin-ended", "stdin-error", "stdout-closed", "stdout-error",
  "transport-closed", "startup-failed", "SIGINT", "SIGTERM",
] as const)
const FAILURE_REASONS: readonly StdioShutdownReason[] = ["stdin-error", "stdout-error", "startup-failed"]
export type StdioShutdownReason = typeof SHUTDOWN_REASONS[number]
type Component = typeof STDIO_SHUTDOWN_COMPONENTS[number]
type ComponentStatus = "waiting" | "running" | "complete" | "failed"

export interface StdioShutdownReport {
  readonly event: "stdio-shutdown"
  readonly schemaVersion: 1
  readonly shutdownId: string
  readonly reason: StdioShutdownReason
  readonly status: "complete" | "failed" | "timeout"
  readonly deadlineMs: number
  readonly durationMs: number
  readonly activeTools: number
  readonly components: readonly {
    readonly name: Component
    readonly status: ComponentStatus
    readonly durationMs: number | null
  }[]
}

export class StdioShutdownError extends Error {
  constructor(readonly report: StdioShutdownReport) {
    super(`Stdio shutdown ${report.status}; inspect the content-free shutdown report`)
    this.name = "StdioShutdownError"
  }
}

export interface StdioLifecycleOptions {
  readonly gateway: () => Promise<void>
  readonly nativeInteractions: () => Promise<void>
  readonly mcp: () => Promise<void>
  readonly telemetry: () => Promise<void>
  readonly report: (report: StdioShutdownReport) => void
  readonly timeoutMs?: number
}

export class StdioLifecycle {
  readonly closed: Promise<StdioShutdownReport>
  readonly #options: StdioLifecycleOptions
  readonly #timeoutMs: number
  readonly #states = new Map<Component, { status: ComponentStatus; started?: number; durationMs: number | null }>(
    STDIO_SHUTDOWN_COMPONENTS.map((name) => [name, { status: "waiting", durationMs: null }]),
  )
  #resolveClosed!: (report: StdioShutdownReport) => void
  #closePromise: Promise<void> | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #started = 0
  #reason: StdioShutdownReason = "caller"
  #shutdownId = ""
  #terminal = false
  #failed = false
  #activeTools = 0
  #resolveDrained: (() => void) | undefined

  constructor(options: StdioLifecycleOptions) {
    this.#options = options
    this.#timeoutMs = options.timeoutMs ?? STDIO_SHUTDOWN_TIMEOUT_MS
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > STDIO_SHUTDOWN_TIMEOUT_MS) {
      throw new Error("Stdio shutdown timeout must be a positive integer within the default deadline")
    }
    this.closed = new Promise((resolve) => { this.#resolveClosed = resolve })
  }

  get closing(): boolean {
    return this.#closePromise !== undefined
  }

  async runTool<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) throw new Error("Stdio server is shutting down; no new tool work is accepted")
    this.#activeTools += 1
    try {
      return await operation()
    } finally {
      this.#activeTools -= 1
      if (this.#activeTools === 0) this.#resolveDrained?.()
    }
  }

  close(reason: StdioShutdownReason = "caller"): Promise<void> {
    if (!SHUTDOWN_REASONS.includes(reason)) throw new Error("Invalid stdio shutdown reason")
    if (!this.#terminal && FAILURE_REASONS.includes(reason)) this.#failed = true
    if (this.#closePromise) return this.#closePromise
    this.#started = performance.now()
    this.#reason = reason
    this.#shutdownId = randomUUID()
    this.#closePromise = this.closed.then((report) => {
      if (report.status !== "complete") throw new StdioShutdownError(report)
    })
    this.#timer = setTimeout(() => this.#finish("timeout"), this.#timeoutMs)
    // Assign the shared promise before invoking callbacks that can reenter close
    void Promise.resolve().then(async () => {
      const gateway = this.#run("gateway", this.#options.gateway)
      const native = this.#run("native-interactions", this.#options.nativeInteractions)
      const mcp = this.#run("mcp", this.#options.mcp)
      const tools = this.#run("tools", () => this.#activeTools === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => { this.#resolveDrained = resolve }))
      // Preserve final tool and broker evidence without waiting for Gateway cleanup
      const telemetry = Promise.all([native, mcp, tools])
        .then(() => this.#run("telemetry", this.#options.telemetry))
      await Promise.all([gateway, native, mcp, tools, telemetry])
      const failed = this.#failed
        || [...this.#states.values()].some(({ status }) => status === "failed")
      this.#finish(failed ? "failed" : "complete")
    })
    return this.#closePromise
  }

  async #run(name: Component, operation: () => Promise<void>): Promise<void> {
    if (this.#terminal) return
    const state = this.#states.get(name)!
    state.status = "running"
    state.started = performance.now()
    let status: ComponentStatus = "complete"
    try {
      await operation()
    } catch {
      status = "failed"
    }
    if (!this.#terminal) {
      state.status = status
      state.durationMs = Math.round(performance.now() - state.started)
    }
  }

  #finish(status: StdioShutdownReport["status"]): void {
    if (this.#terminal) return
    this.#terminal = true
    clearTimeout(this.#timer)
    const ended = performance.now()
    const report: StdioShutdownReport = Object.freeze({
      event: "stdio-shutdown",
      schemaVersion: 1,
      shutdownId: this.#shutdownId,
      reason: this.#reason,
      status,
      deadlineMs: this.#timeoutMs,
      durationMs: Math.round(ended - this.#started),
      activeTools: this.#activeTools,
      components: Object.freeze(STDIO_SHUTDOWN_COMPONENTS.map((name) => {
        const state = this.#states.get(name)!
        return Object.freeze({
          name,
          status: state.status,
          durationMs: state.durationMs ?? (state.started === undefined ? null : Math.round(ended - state.started)),
        })
      })),
    })
    try {
      this.#options.report(report)
    } catch {}
    this.#resolveClosed(report)
  }
}
