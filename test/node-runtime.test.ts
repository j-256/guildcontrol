import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  LOW_MEMORY_NODE_ARGUMENTS,
  lowMemoryNodeArguments,
  resolveNodeRuntime,
  STANDARD_RUNTIME_ARGUMENT,
} from "../src/node-runtime.js"

const EXECUTABLE = "/runtime/node"
const LAUNCHER = "/package/dist/bin.js"
const CLI = "/package/dist/cli.js"
const RUNTIME_HTTP_TIMEOUT_MS = 15_000

function assertNativeHttpFetch(nodeArguments: readonly string[]): void {
  const result = spawnSync(process.execPath, [
    ...nodeArguments,
    "--input-type=module",
    "--eval",
    `
      import { createServer } from "node:http"
      const server = createServer((_request, response) => response.end("runtime-http-ok"))
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
      try {
        const response = await fetch("http://127.0.0.1:" + server.address().port)
        console.log(JSON.stringify({ status: response.status, body: await response.text() }))
      } finally {
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
      }
    `,
  ], { encoding: "utf8", timeout: RUNTIME_HTTP_TIMEOUT_MS })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { status: 200, body: "runtime-http-ok" })
}

test("the default Node runtime profile can perform native HTTP fetch", () => {
  assertNativeHttpFetch(lowMemoryNodeArguments(process.versions.node))
})

test("the MCPB Node runtime profile can perform native HTTP fetch", () => {
  const manifest = JSON.parse(readFileSync(new URL("../mcpb/manifest.json", import.meta.url), "utf8"))
  const arguments_: string[] = manifest.server.mcp_config.args
  const entrypointIndex = arguments_.indexOf("${__dirname}/server/guildcontrol.mjs")
  assert.ok(entrypointIndex > 0)
  assertNativeHttpFetch(arguments_.slice(0, entrypointIndex))
})

test("Node runtime replacement preserves arguments and adds one exact low-memory profile", () => {
  const resolution = resolveNodeRuntime({
    argv: [EXECUTABLE, LAUNCHER, "serve", "--config", "/private/policy.json"],
    cliEntrypoint: CLI,
    execArgv: ["--enable-source-maps"],
    execPath: EXECUTABLE,
    nodeVersion: "22.22.0",
    processReplacementAvailable: true,
  })
  assert.equal(resolution.profile, "low-memory")
  assert.deepEqual(resolution.cliArguments, ["serve", "--config", "/private/policy.json"])
  assert.deepEqual(resolution.replacement, {
    args: [
      EXECUTABLE,
      "--enable-source-maps",
      "--optimize-for-size",
      CLI,
      "serve",
      "--config",
      "/private/policy.json",
    ],
    file: EXECUTABLE,
  })
})

test("Node runtime avoids duplicate active low-memory flags", () => {
  const resolution = resolveNodeRuntime({
    argv: [EXECUTABLE, LAUNCHER, "version"],
    cliEntrypoint: CLI,
    execArgv: ["--optimize_for_size"],
    execPath: EXECUTABLE,
    nodeVersion: "22.22.0",
    processReplacementAvailable: true,
  })
  assert.equal(resolution.profile, "low-memory")
  assert.equal(resolution.replacement, undefined)
  assert.deepEqual(resolution.cliArguments, ["version"])
})

test("Node runtime recognizes the universal low-memory profile", () => {
  const resolution = resolveNodeRuntime({
    argv: [EXECUTABLE, LAUNCHER, "version"],
    cliEntrypoint: CLI,
    execArgv: ["--optimize-for-size"],
    execPath: EXECUTABLE,
    nodeVersion: "26.7.0",
    processReplacementAvailable: true,
  })
  assert.equal(resolution.profile, "low-memory")
  assert.equal(resolution.replacement, undefined)
  assert.deepEqual(resolution.cliArguments, ["version"])
})

test("Node runtime respects explicit standard-runtime choices", () => {
  for (const execArgv of [
    ["--no-optimize-for-size"],
    ["--no-lite-mode"],
    ["--expose-wasm"],
    ["--lite-mode=false"],
  ]) {
    const resolution = resolveNodeRuntime({
      argv: [EXECUTABLE, LAUNCHER, "serve"],
      cliEntrypoint: CLI,
      execArgv,
      execPath: EXECUTABLE,
      nodeVersion: "26.7.0",
      processReplacementAvailable: true,
    })
    assert.equal(resolution.profile, "standard")
    assert.equal(resolution.replacement, undefined)
  }

  const explicit = resolveNodeRuntime({
    argv: [EXECUTABLE, LAUNCHER, STANDARD_RUNTIME_ARGUMENT, "serve"],
    cliEntrypoint: CLI,
    execArgv: [],
    execPath: EXECUTABLE,
    nodeVersion: "26.7.0",
    processReplacementAvailable: true,
  })
  assert.equal(explicit.profile, "standard")
  assert.deepEqual(explicit.cliArguments, ["serve"])
  assert.equal(explicit.replacement, undefined)
})

test("Node runtime treats the standard profile switch only as a launcher prefix", () => {
  const resolution = resolveNodeRuntime({
    argv: [
      EXECUTABLE,
      LAUNCHER,
      "serve",
      "--config",
      STANDARD_RUNTIME_ARGUMENT,
    ],
    cliEntrypoint: CLI,
    execArgv: [],
    execPath: EXECUTABLE,
    nodeVersion: "26.7.0",
    processReplacementAvailable: false,
  })
  assert.deepEqual(resolution.cliArguments, [
    "serve",
    "--config",
    STANDARD_RUNTIME_ARGUMENT,
  ])
})

test("Node runtime falls back without process replacement", () => {
  const resolution = resolveNodeRuntime({
    argv: [EXECUTABLE, LAUNCHER, "help"],
    cliEntrypoint: CLI,
    execArgv: [],
    execPath: EXECUTABLE,
    nodeVersion: "26.7.0",
    processReplacementAvailable: false,
  })
  assert.equal(resolution.profile, "standard")
  assert.deepEqual(resolution.cliArguments, ["help"])
  assert.equal(resolution.replacement, undefined)
})

test("Node runtime falls back to the standard profile on an unverified future line", () => {
  const resolution = resolveNodeRuntime({
    argv: [EXECUTABLE, LAUNCHER, "serve"],
    cliEntrypoint: CLI,
    execArgv: [],
    execPath: EXECUTABLE,
    nodeVersion: "27.0.0",
    processReplacementAvailable: true,
  })
  assert.equal(resolution.profile, "standard")
  assert.deepEqual(resolution.cliArguments, ["serve"])
  assert.equal(resolution.replacement, undefined)
})

test("Node runtime selects only flags supported by each Node line", () => {
  assert.deepEqual(lowMemoryNodeArguments("22.15.0"), [
    "--optimize-for-size",
  ])
  assert.deepEqual(lowMemoryNodeArguments("23.11.1"), [
    "--optimize-for-size",
  ])
  assert.deepEqual(lowMemoryNodeArguments("24.8.0"), LOW_MEMORY_NODE_ARGUMENTS)
  assert.deepEqual(lowMemoryNodeArguments("25.9.0"), LOW_MEMORY_NODE_ARGUMENTS)
  assert.deepEqual(lowMemoryNodeArguments("26.7.0"), LOW_MEMORY_NODE_ARGUMENTS)
  assert.deepEqual(lowMemoryNodeArguments("27.0.0"), [])
  assert.deepEqual(lowMemoryNodeArguments("invalid"), [])
})
