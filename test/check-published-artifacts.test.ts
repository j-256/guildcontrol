import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import test from "node:test"

const FETCH_FIXTURE = resolve("test/fixtures/published-artifacts-fetch.mjs")
const SCRIPT = resolve("scripts/check-published-artifacts.mjs")

function runPublishedCheck(registryDelayMs: number) {
  return spawnSync(process.execPath, [
    "--import", FETCH_FIXTURE,
    SCRIPT,
    "--tarball", "package-lock.json",
    "--expect-package", "matching",
    "--expect-npm", "missing",
    "--expect-oci", "unchecked",
    "--expect-registry", "missing",
    "--json",
  ], {
    encoding: "utf8",
    env: { ...process.env, TEST_REGISTRY_DELAY_MS: String(registryDelayMs) },
  })
}

test("release check accepts a slow absent MCP Registry version", () => {
  const result = runPublishedCheck(30)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).registryVersion, "missing")
})

test("release check names the MCP Registry when its read times out", () => {
  const result = runPublishedCheck(100)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /MCP Registry/)
  assert.match(result.stderr, /timed out/)
})
