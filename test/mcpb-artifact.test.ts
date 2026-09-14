import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  MCPB_ARCHIVE_ENTRIES,
  mcpbArchiveName,
  validateMcpbManifest,
  verifyMcpbStderr,
} from "../scripts/mcpb-artifact.mjs"

const packageJson = JSON.parse(await readFile("package.json", "utf8"))
const manifest = JSON.parse(await readFile("mcpb/manifest.json", "utf8"))

function shutdownReport() {
  return {
    event: "stdio-shutdown",
    schemaVersion: 1,
    shutdownId: "00000000-0000-4000-8000-000000000001",
    reason: "stdin-ended",
    status: "complete",
    deadlineMs: 5_000,
    durationMs: 2,
    activeTools: 0,
    components: ["gateway", "native-interactions", "mcp", "tools", "telemetry"].map((name) => ({
      name, status: "complete", durationMs: 1,
    })),
  }
}

const READY_MESSAGE = "[mcp] GuildControl MCP stdio server ready\n"

test("MCPB stderr acceptance requires exact content-free EOF shutdown evidence", () => {
  const output = `${READY_MESSAGE}${JSON.stringify(shutdownReport())}\n`
  verifyMcpbStderr(output, 24)
  verifyMcpbStderr(`Warning: disabling flag --expose_wasm due to conflicting flags\n${output}`, 22)
  for (const invalid of [
    READY_MESSAGE,
    output + "private extra diagnostic\n",
    output + JSON.stringify(shutdownReport()) + "\n",
    output.trimEnd(),
    `private startup text\n${output}`,
  ]) assert.throws(() => verifyMcpbStderr(invalid, 24))
})

test("MCPB stderr acceptance rejects incomplete, oversized, or content-bearing shutdown evidence", () => {
  for (const invalid of [
    { ...shutdownReport(), status: "timeout" },
    { ...shutdownReport(), reason: "sigterm" },
    { ...shutdownReport(), activeTools: 1 },
    { ...shutdownReport(), durationMs: 8_000 },
    { ...shutdownReport(), shutdownId: "invalid" },
    { ...shutdownReport(), privateContent: "withheld" },
    { ...shutdownReport(), components: [] },
    { ...shutdownReport(), components: [{ name: "mcp", status: "failed", durationMs: 1 }] },
  ]) assert.throws(() => verifyMcpbStderr(`${READY_MESSAGE}${JSON.stringify(invalid)}\n`, 24))
})

test("MCPB manifest is pinned, model-neutral, and exact", async () => {
  await validateMcpbManifest(manifest, packageJson)
  assert.equal(mcpbArchiveName(packageJson.version), `guildcontrol-${packageJson.version}.mcpb`)
})

test("MCPB archive allowlist is canonical and content-bearing", () => {
  assert.deepEqual(MCPB_ARCHIVE_ENTRIES, [...MCPB_ARCHIVE_ENTRIES].sort())
  assert.ok(MCPB_ARCHIVE_ENTRIES.includes("server/sbom.spdx.json"))
  assert.ok(MCPB_ARCHIVE_ENTRIES.includes("server/THIRD_PARTY_NOTICES.md"))
  assert.ok(MCPB_ARCHIVE_ENTRIES.includes("server/catalog-evidence.json"))
  assert.ok(MCPB_ARCHIVE_ENTRIES.includes("docs/reference.md"))
  assert.ok(MCPB_ARCHIVE_ENTRIES.includes("docs/safety-usability.md"))
  assert.ok(MCPB_ARCHIVE_ENTRIES.includes("README.md"))
  assert.equal(MCPB_ARCHIVE_ENTRIES.some((name) => name.endsWith("/")), false)
})
