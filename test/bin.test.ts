import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { runGuildControlBin } from "../src/bin.js"
import { fixtureConfigInput } from "./config-fixture.js"

const EXECUTABLE = "/runtime/node"
const LAUNCHER = "/package/dist/bin.js"
const CLI = "/package/dist/cli.js"

test("standard package-bin child launches bypass the default runtime bootstrap", async (context) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "guildcontrol-bin-standard-"))
  context.after(() => rm(root, { force: true, recursive: true }))
  const configFile = join(root, "config.json")
  await writeFile(configFile, `${JSON.stringify(fixtureConfigInput().document)}\n`, { mode: 0o600 })
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--import", "tsx", fileURLToPath(new URL("../src/bin.ts", import.meta.url)),
    "--standard-runtime", "host", "--config", configFile, "--json",
  ], { env: { PATH: process.env.PATH } })
  const report = JSON.parse(stdout)
  assert.deepEqual(report.launch.args, [
    fileURLToPath(new URL("../src/cli.js", import.meta.url)),
    "serve", "--config", configFile,
  ])
})

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
