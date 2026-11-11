import assert from "node:assert/strict"
import test from "node:test"

import { runGuildControlBin } from "../src/bin.js"

const EXECUTABLE = "/runtime/node"
const LAUNCHER = "/package/dist/bin.js"
const CLI = "/package/dist/cli.js"

test("package bin passes the selected standard runtime through to the CLI", async () => {
  let observedProfile: string | undefined
  const exitCode = await runGuildControlBin({
    argv: [EXECUTABLE, LAUNCHER, "--standard-runtime", "smoke"],
    cliEntrypoint: CLI,
    execArgv: [],
    execPath: EXECUTABLE,
    execve() {
      throw new Error("The standard runtime must not replace the process")
    },
    nodeVersion: "24.22.2",
    runCli: async (args, profile) => {
      assert.deepEqual(args, ["smoke"])
      observedProfile = profile
      return 0
    },
  })
  assert.equal(exitCode, 0)
  assert.equal(observedProfile, "standard")
})

test("package bin forwards its environment when replacing the process", async () => {
  const replacement = new Error("process replaced")
  let observed: {
    args: readonly string[] | undefined
    file: string
  } | undefined
  let cliCalled = false
  let environmentForwarded = false
  await assert.rejects(runGuildControlBin({
    argv: [EXECUTABLE, LAUNCHER, "version"],
    cliEntrypoint: CLI,
    execArgv: [],
    execPath: EXECUTABLE,
    execve(file, args, environment) {
      observed = { args, file }
      environmentForwarded = environment === process.env
      throw replacement
    },
    nodeVersion: "22.22.0",
    runCli: async () => {
      cliCalled = true
      return 0
    },
  }), replacement)
  assert.equal(cliCalled, false)
  assert.equal(environmentForwarded, true)
  assert.deepEqual(observed, {
    args: [EXECUTABLE, "--optimize-for-size", CLI, "version"],
    file: EXECUTABLE,
  })
})

test("package bin runs the CLI directly when replacement is unavailable", async () => {
  let observed: readonly string[] | undefined
  const exitCode = await runGuildControlBin({
    argv: [EXECUTABLE, LAUNCHER, "help"],
    cliEntrypoint: CLI,
    execArgv: [],
    execPath: EXECUTABLE,
    execve: null,
    nodeVersion: "26.7.0",
    runCli: async (args) => {
      observed = args
      return 7
    },
  })
  assert.equal(exitCode, 7)
  assert.deepEqual(observed, ["help"])
})
