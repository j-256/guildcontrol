import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import { fileURLToPath } from "node:url"

import { runGuildControlServer } from "../src/mcp.js"
import { createDisabledNativeInteractionSource } from "../src/native-interaction-broker.js"
import { loadObservabilityDocumentConfig } from "../src/observability-config.js"
import { OperationalTelemetry } from "../src/observability.js"
import { FileOperationStore, operationKeyHash, operationReceiptDirectory } from "../src/operation-store.js"
import { StdioShutdownError, type StdioShutdownReport } from "../src/stdio-lifecycle.js"
import { loadFixtureConfig } from "./config-fixture.js"
import { shutdownGateway } from "./shutdown-fixture.js"

const TOKEN = "shutdown-fixture-token"
const TEST_TIMEOUT_MS = 10_000

test("stdio runner skips background startup after an already-closed input", async () => {
  const stdin = new PassThrough()
  stdin.destroy()
  let starts = 0
  const signalListeners = process.listenerCount("SIGTERM")
  const handle = runGuildControlServer({
    config: loadFixtureConfig({ token: TOKEN }),
    environment: {},
    stdin,
    stdout: new PassThrough(),
    stderr: { write: () => true },
    gatewayRuntime: shutdownGateway({ start: async () => { starts += 1 } }),
  })
  await handle.close()
  assert.equal(starts, 0)
  assert.equal((await handle.closed).reason, "stdin-ended")
  assert.equal(process.listenerCount("SIGTERM"), signalListeners)
  assert.equal(stdin.listenerCount("end"), 0)
})

test("stdio runner prevents late native preflight from starting Gateway after EOF", async () => {
  const config = loadFixtureConfig({ token: TOKEN })
  let release!: () => void
  const preflight = new Promise<void>((resolve) => { release = resolve })
  let starts = 0
  let stops = 0
  const stdin = new PassThrough()
  const handle = runGuildControlServer({
    config,
    environment: {},
    stdin,
    stdout: new PassThrough(),
    stderr: { write: () => true },
    gatewayRuntime: shutdownGateway({ start: async () => { starts += 1 } }),
    nativeInteractionRuntime: {
      ...createDisabledNativeInteractionSource(config),
      ingestInteraction() {},
      start: () => preflight,
      async stop() { stops += 1 },
    },
  })
  stdin.end()
  await handle.closed
  release()
  await setImmediate()
  await handle.close()
  assert.equal(starts, 0)
  assert.equal(stops, 1)
})

for (const stream of ["stdin", "stdout"] as const) {
  test(`stdio runner reports an already-failed ${stream} without starting Gateway`, async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const failed = stream === "stdin" ? stdin : stdout
    failed.destroy(new Error(TOKEN))
    let starts = 0
    const handle = runGuildControlServer({
      config: loadFixtureConfig({ token: TOKEN }),
      environment: {},
      stdin,
      stdout,
      stderr: { write: () => true },
      gatewayRuntime: shutdownGateway({ start: async () => { starts += 1 } }),
    })
    await assert.rejects(handle.close(), StdioShutdownError)
    const report = await handle.closed
    assert.equal(report.reason, `${stream}-error`)
    assert.equal(report.status, "failed")
    assert.equal(starts, 0)
  })
}

test("stdio runner cleans up a synchronous background startup failure", async () => {
  let report!: (value: StdioShutdownReport) => void
  const closed = new Promise<StdioShutdownReport>((resolve) => { report = resolve })
  let stops = 0
  assert.throws(() => runGuildControlServer({
    config: loadFixtureConfig({ token: TOKEN }),
    environment: {},
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: {
      write(value) {
        const line = String(value)
        if (line.startsWith("{")) report(JSON.parse(line) as StdioShutdownReport)
        return true
      },
    },
    gatewayRuntime: shutdownGateway({
      start() { throw new Error("Fixture startup failed") },
      async stop() { stops += 1 },
    }),
  }), /Fixture startup failed/)
  assert.equal((await closed).reason, "startup-failed")
  assert.equal(stops, 1)
})

test("stdio runner bounds failed cleanup and preserves pending durable receipts", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "guildcontrol-shutdown-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const config = loadFixtureConfig({ token: TOKEN, stateHome: directory })
  const operationDirectory = operationReceiptDirectory(config.auditFile)
  const store = new FileOperationStore(operationDirectory)
  const pending = {
    activityId: "shutdown-pending-operation",
    error: null,
    guildId: "100000000000000001",
    kind: "channel-creation" as const,
    operationKeyHash: operationKeyHash("shutdown-pending-key-0001"),
    planDigest: `hmac-sha256:${"a".repeat(64)}`,
    resourceId: null,
    schemaVersion: 1 as const,
    status: "pending" as const,
    timestamp: "2026-09-14T00:00:00.000Z",
    verification: null,
  }
  await store.reserve(pending)
  const receiptFiles = await readdir(operationDirectory, { recursive: true })
  const receiptPath = join(operationDirectory, receiptFiles.find((name) => name.endsWith("pending.json"))!)
  const before = await readFile(receiptPath)
  let flushes = 0
  const observabilityRuntime = new OperationalTelemetry({
    config: loadObservabilityDocumentConfig({ exportEnabled: true }, {}, []),
    otlpFactory() {
      return {
        async forceFlush() { flushes += 1 },
        async shutdown() {},
      }
    },
  })
  let diagnostics = ""
  const handle = runGuildControlServer({
    config,
    environment: {},
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: { write(value) { diagnostics += String(value); return true } },
    gatewayRuntime: shutdownGateway({ stop: () => new Promise(() => {}) }),
    observabilityRuntime,
    shutdownTimeoutMs: 30,
  })
  await assert.rejects(handle.close(), StdioShutdownError)
  const report = await handle.closed
  assert.equal(report.status, "timeout")
  assert.equal(report.components.find(({ name }) => name === "gateway")?.status, "running")
  assert.equal(report.components.find(({ name }) => name === "telemetry")?.status, "complete")
  assert.equal(flushes, 1)
  assert.deepEqual(await store.get(pending.kind, pending.operationKeyHash), pending)
  assert.deepEqual(await readdir(operationDirectory, { recursive: true }), receiptFiles)
  assert.deepEqual(await readFile(receiptPath), before)
  assert.doesNotMatch(diagnostics, new RegExp(`${TOKEN}|${directory}|${pending.guildId}|${pending.planDigest}`))
})

test("stdio runner reports exporter failure even when the exporter runtime settles", async () => {
  const observabilityRuntime = new OperationalTelemetry({
    config: loadObservabilityDocumentConfig({ exportEnabled: true }, {}, []),
    otlpFactory() {
      return {
        async forceFlush() { throw new Error(TOKEN) },
        async shutdown() {},
      }
    },
  })
  const handle = runGuildControlServer({
    config: loadFixtureConfig({ token: TOKEN }),
    environment: {},
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: { write: () => true },
    observabilityRuntime,
  })
  await assert.rejects(handle.close(), StdioShutdownError)
  assert.equal((await handle.closed).components.find(({ name }) => name === "telemetry")?.status, "failed")
})

for (const mode of ["clean", "gateway", "telemetry", "SIGINT", "SIGTERM"]) {
  test(`owned stdio process exits on ${mode} without a client kill fallback`, { timeout: TEST_TIMEOUT_MS }, async (context) => {
    const child = spawn(process.execPath, [
      "--import", "tsx", fileURLToPath(new URL("./fixtures/shutdown-server.ts", import.meta.url)), mode,
    ], { stdio: ["pipe", "pipe", "pipe"] })
    context.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL") })
    const exited = once(child, "exit")
    const closed = once(child, "close")
    let diagnostics = ""
    child.stderr.on("data", (value: Buffer) => { diagnostics += value.toString() })
    child.stdout.resume()
    if (mode.startsWith("SIG")) {
      while (!diagnostics.includes("stdio server ready")) await once(child.stderr, "data")
      child.kill(mode as NodeJS.Signals)
    } else {
      child.stdin.end()
    }
    const [code, signal] = await exited
    await closed
    assert.equal(signal, null)
    assert.equal(code, ["gateway", "telemetry"].includes(mode) ? 1 : 0)
    const reports = diagnostics.split("\n").filter((line) => line.startsWith("{\"event\":\"stdio-shutdown\""))
      .map((line) => JSON.parse(line) as StdioShutdownReport)
    assert.equal(reports.length, 1)
    const report = reports[0]!
    assert.equal(report.status, code === 0 ? "complete" : "timeout")
    assert.equal(report.reason, mode.startsWith("SIG") ? mode : "stdin-ended")
    assert.equal(report.deadlineMs, 80)
    assert.doesNotMatch(diagnostics, new RegExp(TOKEN))
  })
}
