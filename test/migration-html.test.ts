import assert from "node:assert/strict"
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"

import { checkDiscordCatalog } from "../src/catalog.js"
import { ConfigurationError } from "../src/errors.js"
import {
  MIGRATION_HTML_FORMAT,
  exportDiscordMigrationHtml,
  renderDiscordMigrationHtml,
} from "../src/migration-html.js"
import {
  createMigrationPlan,
  type MigrationPlanReport,
} from "../src/migration-planner.js"

async function migrationPlan(source = "cappyeo@0.26.0"): Promise<MigrationPlanReport> {
  const targetCatalog = await checkDiscordCatalog()
  return createMigrationPlan(source, {
    checkCatalog: async () => targetCatalog,
  })
}

test("migration HTML renders the complete plan as one deterministic offline guide", async () => {
  const plan = await migrationPlan()
  const html = renderDiscordMigrationHtml(plan)
  const repeated = renderDiscordMigrationHtml(plan)

  assert.equal(repeated, html)
  assert.match(html, /^<!doctype html>/)
  assert.match(html, new RegExp(plan.planDigest))
  assert.match(html, new RegExp(plan.source.manifestDigest))
  assert.match(html, new RegExp(plan.target.catalogContractDigest))
  assert.match(html, /Release-exact migration plan/)
  assert.match(html, /Complete outcome map/)
  assert.match(html, /Staged switching path/)
  assert.match(html, /data-disposition="supported"/)
  assert.match(html, /data-disposition="review-required"/)
  assert.match(html, /data-disposition="intentionally-excluded"/)
  assert.match(html, /id="search"/)
  assert.match(html, /id="disposition"/)
  assert.match(html, /data-check/)
  assert.match(html, /role="status" aria-live="polite"/)
  assert.match(html, /Content-Security-Policy/)
  assert.match(html, new RegExp(MIGRATION_HTML_FORMAT))
  assert.match(html, /connect-src 'none'/)
  assert.match(html, /default-src 'none'/)
  assert.match(html, /prefers-reduced-motion/)

  for (const mapping of plan.mappings) {
    assert.match(html, new RegExp(`data-disposition="${mapping.disposition}"`))
    assert.ok(html.includes(mapping.outcome))
    for (const tool of mapping.sourceTools) assert.ok(html.includes(`<code>${tool}</code>`), tool)
    for (const tool of mapping.targetTools) assert.ok(html.includes(`<code>${tool}</code>`), tool)
  }
  for (const step of plan.steps) assert.ok(html.includes(step.title), step.id)

  assert.doesNotMatch(html, /<script\s+src=/)
  assert.doesNotMatch(html, /<link\b/)
  assert.doesNotMatch(html, /url\(https?:/)
  assert.doesNotMatch(html, /\bfetch\s*\(/)
  assert.doesNotMatch(html, /XMLHttpRequest|WebSocket|localStorage|sessionStorage/)
})

test("migration HTML exporter is exclusive, private, deterministic, and path-free", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "guildcontrol-migration-html-test-"))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const plan = await migrationPlan("pasympa@2.2.0")
  const first = join(directory, "first.html")
  const second = join(directory, "second.html")
  const existing = join(directory, "existing.html")

  const firstReport = await exportDiscordMigrationHtml(first, plan)
  const secondReport = await exportDiscordMigrationHtml(second, plan)
  const firstBytes = await readFile(first)
  const secondBytes = await readFile(second)

  assert.deepEqual(secondBytes, firstBytes)
  assert.equal(secondReport.htmlDigest, firstReport.htmlDigest)
  assert.equal(secondReport.bytes, firstReport.bytes)
  assert.equal(firstReport.file, resolve(first))
  assert.equal(firstReport.format, MIGRATION_HTML_FORMAT)
  assert.equal(firstReport.planDigest, plan.planDigest)
  assert.equal(firstReport.sourceId, plan.source.id)
  assert.equal(firstReport.bytes, firstBytes.byteLength)
  assert.equal((await stat(first)).mode & 0o777, 0o600)
  assert.doesNotMatch(firstBytes.toString("utf8"), new RegExp(directory))
  assert.equal(firstReport.credentialValuesEmbedded, false)
  assert.equal(firstReport.credentialValuesRead, false)
  assert.equal(firstReport.discordContacted, false)
  assert.equal(firstReport.configurationChanged, false)
  assert.equal(firstReport.statePersistence, "disabled")

  await writeFile(existing, "operator-owned", "utf8")
  await assert.rejects(
    exportDiscordMigrationHtml(existing, plan),
    (error: unknown) => (
      error instanceof ConfigurationError
      && /already exists/.test(error.message)
      && !error.message.includes(existing)
    ),
  )
  assert.equal(await readFile(existing, "utf8"), "operator-owned")
})

test("migration HTML exporter removes a partial file when its exclusive write fails", async () => {
  const plan = await migrationPlan("hypark@0.1.1")
  const file = "/virtual/migration.html"
  const events: string[] = []

  await assert.rejects(
    exportDiscordMigrationHtml(file, plan, {
      fileSystem: {
        async open(received, flags, mode) {
          assert.equal(received, file)
          assert.equal(flags, "wx")
          assert.equal(mode, 0o600)
          return {
            async close() {
              events.push("close")
            },
            async sync() {
              events.push("sync")
            },
            async writeFile() {
              events.push("write")
              throw new Error("disk full")
            },
          }
        },
        async unlink(received) {
          assert.equal(received, file)
          events.push("unlink")
        },
      },
    }),
    (error: unknown) => error instanceof ConfigurationError && /could not be written/.test(error.message),
  )
  assert.deepEqual(events, ["write", "close", "unlink"])
})

test("migration HTML fails closed for a stale or hostile modified plan", async () => {
  const plan = await migrationPlan("targeted-reader@1.0.0")
  const hostile = `</script><img src=x onerror="alert('migration')">&`
  const modified = {
    ...plan,
    source: {
      ...plan.source,
      product: hostile,
    },
  }

  assert.throws(
    () => renderDiscordMigrationHtml(modified),
    /requires an exact verified plan/u,
  )
})
