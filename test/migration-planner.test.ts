import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { checkDiscordCatalog } from "../src/catalog.js"
import {
  MIGRATION_SOURCE_DEFINITIONS,
  MIGRATION_SOURCE_IDS,
} from "../src/migration-manifests.js"
import {
  MIGRATION_CATALOG_FORMAT,
  MIGRATION_DIGEST_PATTERN,
  MIGRATION_PLAN_FORMAT,
  createMigrationCatalog,
  createMigrationPlan,
  normalizeMigrationSourceId,
  verifyMigrationPlan,
} from "../src/migration-planner.js"

const AMBIENT_SECRET = "migration-planner-ambient-secret"

test("migration catalog is deterministic, immutable, and accounts for every audited source tool", () => {
  const first = createMigrationCatalog()
  const second = createMigrationCatalog()

  assert.deepEqual(second, first)
  assert.equal(first.format, MIGRATION_CATALOG_FORMAT)
  assert.match(first.catalogDigest, MIGRATION_DIGEST_PATTERN)
  assert.deepEqual(first.sources.map(({ id }) => id), [...MIGRATION_SOURCE_IDS])
  assert.equal(new Set(first.sources.map(({ manifestDigest }) => manifestDigest)).size, first.sources.length)
  assert.equal(new Set(first.sources.map(({ sourceInventoryDigest }) => sourceInventoryDigest)).size, first.sources.length)
  assert.equal(Object.isFrozen(first), true)

  for (const [index, source] of first.sources.entries()) {
    const definition = MIGRATION_SOURCE_DEFINITIONS[index]
    assert.ok(definition)
    assert.equal(source.sourceInventoryDigest, definition.auditedInventoryDigest)
    assert.equal(source.sourceToolCount, definition.sourceTools.length)
    assert.equal(
      Object.values(source.dispositionToolCounts).reduce((sum, count) => sum + count, 0),
      source.sourceToolCount,
    )
    assert.equal(source.mappingCount, definition.groups.length)
    assert.match(source.registryUrl, /^https:\/\/registry\.modelcontextprotocol\.io\//)
    assert.match(source.evidenceUrl, /^https:\/\/github\.com\/[^/]+\/[^/]+\/tree\/[0-9a-f]{40}$/)
    assert.equal(source.id, `${source.id.split("@")[0]}@${source.version}`)
  }

  assert.deepEqual(first.execution, {
    activityRecordsCreated: false,
    configurationRead: false,
    credentialsRead: false,
    discordContacted: false,
    hostConfigurationRead: false,
    networkContacted: false,
    policyChanged: false,
    processStarted: false,
    sourceInspected: false,
    sourceOrHostChanged: false,
  })
})

test("migration sources exactly cover the scored local competitor release table", async () => {
  const comparison = await readFile("docs/comparison.md", "utf8")
  const section = comparison
    .split("## Audited releases and source limits\n")[1]
    ?.split("## Registry matches outside the scored local comparison\n")[0]
  assert.ok(section)
  const registryUrls = [...section.matchAll(/\]\((https:\/\/registry\.modelcontextprotocol\.io\/v0\.1\/servers\/[^)]+)\)/g)]
    .map((match) => match[1] as string)
    .sort()
  const catalogUrls = createMigrationCatalog().sources
    .map(({ registryUrl }) => registryUrl)
    .sort()

  assert.deepEqual(registryUrls, catalogUrls)
})

test("every migration plan binds complete source accounting to the negotiated target catalog", async () => {
  const targetCatalog = await checkDiscordCatalog()
  const targetNames = new Set(targetCatalog.toolNames)

  for (const sourceId of MIGRATION_SOURCE_IDS) {
    const first = await createMigrationPlan(sourceId, {
      checkCatalog: async () => targetCatalog,
    })
    const second = await createMigrationPlan(sourceId, {
      checkCatalog: async () => targetCatalog,
    })

    assert.deepEqual(second, first)
    assert.equal(first.format, MIGRATION_PLAN_FORMAT)
    assert.equal(first.source.id, sourceId)
    assert.equal(first.target.catalogContractDigest, targetCatalog.contractDigest)
    assert.equal(first.summary.sourceToolCount, first.source.sourceToolCount)
    assert.equal(first.mappings.flatMap(({ sourceTools }) => sourceTools).length, first.source.sourceToolCount)
    assert.equal(new Set(first.mappings.flatMap(({ sourceTools }) => sourceTools)).size, first.source.sourceToolCount)
    assert.equal(verifyMigrationPlan(first), true)
    assert.match(first.planDigest, MIGRATION_DIGEST_PATTERN)
    assert.deepEqual(first.mappings.map(({ id }) => id), [...first.mappings.map(({ id }) => id)].sort())
    assert.equal(first.steps[0]?.id, "inspect-target")
    assert.equal(first.steps.at(-1)?.id, "retire-source")
    assert.equal(first.argumentsTranslated, false)
    assert.equal(first.configurationImported, false)
    assert.equal(first.hostSettingsChanged, false)

    for (const mapping of first.mappings) {
      assert.deepEqual(mapping.sourceTools, [...mapping.sourceTools].sort())
      assert.deepEqual(mapping.targetTools, [...mapping.targetTools].sort())
      assert.deepEqual(mapping.recipes, [...mapping.recipes].sort())
      if (mapping.disposition === "intentionally-excluded") {
        assert.deepEqual(mapping.targetTools, [])
        assert.deepEqual(mapping.recipes, [])
      }
      for (const tool of mapping.targetTools) assert.equal(targetNames.has(tool), true, tool)
    }
  }
})

test("migration planning reads no ambient credential, source tree, configuration, or network", async () => {
  const targetCatalog = await checkDiscordCatalog()
  const previousSecret = process.env.DISCORD_BOT_TOKEN
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  try {
    process.env.DISCORD_BOT_TOKEN = AMBIENT_SECRET
    globalThis.fetch = (async () => {
      fetchCalls += 1
      throw new Error("Migration planning attempted network access")
    }) as typeof fetch

    const plan = await createMigrationPlan("cappyeo@0.26.0", {
      checkCatalog: async () => targetCatalog,
    })
    const text = JSON.stringify(plan)

    assert.equal(fetchCalls, 0)
    assert.doesNotMatch(text, new RegExp(AMBIENT_SECRET))
    assert.doesNotMatch(text, /\/tmp\/|\/Users\/|file:\/\//)
    assert.deepEqual(plan.execution, createMigrationCatalog().execution)
  } finally {
    globalThis.fetch = originalFetch
    if (previousSecret === undefined) delete process.env.DISCORD_BOT_TOKEN
    else process.env.DISCORD_BOT_TOKEN = previousSecret
  }
})

test("migration source selection is version-exact and rejects aliases, paths, and unknown releases", () => {
  assert.equal(normalizeMigrationSourceId(" CAPPYEO@0.26.0 "), "cappyeo@0.26.0")
  assert.throws(() => normalizeMigrationSourceId("cappyeo"), /must be one of/u)
  assert.throws(() => normalizeMigrationSourceId("cappyeo@latest"), /must be one of/u)
  assert.throws(() => normalizeMigrationSourceId("./source-checkout"), /must be one of/u)
  assert.throws(() => normalizeMigrationSourceId("pasympa@2.1.1"), /must be one of/u)
})

test("migration plan verification rejects any post-plan mutation", async () => {
  const targetCatalog = await checkDiscordCatalog()
  const plan = await createMigrationPlan("hypark@0.1.1", {
    checkCatalog: async () => targetCatalog,
  })

  assert.equal(verifyMigrationPlan({
    ...plan,
    configurationImported: true as never,
  }), false)
  assert.equal(verifyMigrationPlan({
    ...plan,
    planDigest: `sha256:${"0".repeat(64)}`,
  }), false)
})
