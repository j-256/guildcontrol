import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate } from "node:timers/promises"

import {
  StdioLifecycle,
  StdioShutdownError,
  type StdioLifecycleOptions,
  type StdioShutdownReport,
} from "../src/stdio-lifecycle.js"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(overrides: Partial<StdioLifecycleOptions> = {}) {
  const calls: string[] = []
  const reports: StdioShutdownReport[] = []
  const lifecycle = new StdioLifecycle({
    gateway: async () => { calls.push("gateway") },
    nativeInteractions: async () => { calls.push("native-interactions") },
    mcp: async () => { calls.push("mcp") },
    telemetry: async () => { calls.push("telemetry") },
    report: (report) => { reports.push(report) },
    ...overrides,
  })
  return { lifecycle, calls, reports }
}

test("stdio shutdown starts independent cleanup and flushes while Gateway is stalled", async () => {
  const gateway = deferred()
  const native = deferred()
  const mcp = deferred()
  const started: string[] = []
  const { lifecycle, calls, reports } = fixture({
    gateway: () => { started.push("gateway"); return gateway.promise },
    nativeInteractions: () => { started.push("native-interactions"); return native.promise },
    mcp: () => { started.push("mcp"); return mcp.promise },
  })
  const close = lifecycle.close("stdin-ended")
  assert.equal(lifecycle.closing, true)
  await setImmediate()
  assert.deepEqual(started, ["gateway", "native-interactions", "mcp"])
  assert.deepEqual(calls, [])
  native.resolve()
  await setImmediate()
  assert.deepEqual(calls, [])
  mcp.resolve()
  await setImmediate()
  assert.deepEqual(calls, ["telemetry"])
  assert.equal(reports.length, 0)
  gateway.resolve()
  await close
  assert.equal(reports[0]?.status, "complete")
  assert.equal(reports[0]?.reason, "stdin-ended")
  assert.ok(reports[0]?.components.every(({ status }) => status === "complete"))
})

test("stdio shutdown drains active tools before telemetry and rejects new work", async () => {
  const pending = deferred()
  const { lifecycle, calls } = fixture()
  const operation = lifecycle.runTool(async () => {
    await pending.promise
    calls.push("tool-finished")
    return "result"
  })
  const close = lifecycle.close()
  await assert.rejects(lifecycle.runTool(async () => {
    assert.fail("A closing server admitted new work")
  }), /no new tool work/)
  await setImmediate()
  assert.deepEqual(calls, ["gateway", "native-interactions", "mcp"])
  pending.resolve()
  assert.equal(await operation, "result")
  await close
  assert.deepEqual(calls, ["gateway", "native-interactions", "mcp", "tool-finished", "telemetry"])
  assert.equal((await lifecycle.closed).activeTools, 0)
})

test("stdio shutdown shares one result across repeated and reentrant requests", async () => {
  let reentrant: Promise<void> | undefined
  const { lifecycle, reports } = fixture({
    gateway: async () => { reentrant = lifecycle.close("SIGTERM") },
  })
  const close = lifecycle.close("stdin-ended")
  assert.equal(lifecycle.close("SIGINT"), close)
  await close
  assert.equal(reentrant, close)
  assert.equal(lifecycle.close(), close)
  assert.equal(reports.length, 1)
  assert.equal(reports[0]?.reason, "stdin-ended")
})

test("stdio shutdown retains a subsequent pipe failure without changing the first trigger", async () => {
  const { lifecycle } = fixture()
  const close = lifecycle.close("stdin-ended")
  assert.equal(lifecycle.close("stdout-error"), close)
  await assert.rejects(close, StdioShutdownError)
  assert.equal((await lifecycle.closed).reason, "stdin-ended")
  assert.equal((await lifecycle.closed).status, "failed")
})

test("stdio shutdown reports failed cleanup without leaking errors or skipping other resources", async () => {
  const privateDetail = "private-token message-content https://example.test/attachment"
  const { lifecycle, reports, calls } = fixture({
    gateway: () => { throw new Error(privateDetail) },
    nativeInteractions: async () => { throw new Error(privateDetail) },
  })
  await assert.rejects(lifecycle.close(), StdioShutdownError)
  const report = await lifecycle.closed
  assert.deepEqual(calls, ["mcp", "telemetry"])
  assert.equal(report.status, "failed")
  assert.equal(reports.length, 1)
  assert.deepEqual(report.components.filter(({ status }) => status === "failed").map(({ name }) => name), [
    "gateway", "native-interactions",
  ])
  assert.doesNotMatch(JSON.stringify(report), /private-token|message-content|https:/)
  assert.match(report.shutdownId, /^[a-f0-9-]{36}$/)
})

test("stdio shutdown bounds stalled work and keeps its terminal report stable after late completion", async () => {
  const pending = deferred()
  const { lifecycle, reports, calls } = fixture({ timeoutMs: 30 })
  const operation = lifecycle.runTool(() => pending.promise)
  await assert.rejects(lifecycle.close(), StdioShutdownError)
  const report = await lifecycle.closed
  assert.equal(report.status, "timeout")
  assert.equal(report.activeTools, 1)
  assert.equal(report.deadlineMs, 30)
  assert.ok(report.durationMs >= 20)
  assert.deepEqual(report.components.filter(({ status }) => status !== "complete").map(({ name, status }) => ({ name, status })), [
    { name: "tools", status: "running" },
    { name: "telemetry", status: "waiting" },
  ])
  const terminal = JSON.stringify(report)
  pending.resolve()
  await operation
  await setImmediate()
  assert.equal(reports.length, 1)
  assert.equal(JSON.stringify(report), terminal)
  assert.deepEqual(calls, ["gateway", "native-interactions", "mcp"])
})

test("stdio shutdown deadline includes a stalled final telemetry flush", async () => {
  const { lifecycle } = fixture({ telemetry: () => new Promise(() => {}), timeoutMs: 30 })
  await assert.rejects(lifecycle.close(), StdioShutdownError)
  const report = await lifecycle.closed
  assert.equal(report.status, "timeout")
  assert.equal(report.components.find(({ name }) => name === "telemetry")?.status, "running")
})

test("stdio shutdown reports input failures and completes even if the diagnostic sink throws", async () => {
  const { lifecycle } = fixture({ report: () => { throw new Error("closed pipe") } })
  await assert.rejects(lifecycle.close("stdin-error"), StdioShutdownError)
  assert.equal((await lifecycle.closed).status, "failed")
})

test("stdio shutdown deadline overrides can only shorten the finite default", () => {
  for (const timeoutMs of [0, -1, 1.5, 5_001, Infinity, NaN]) {
    assert.throws(() => fixture({ timeoutMs }), /within the default deadline/)
  }
})
