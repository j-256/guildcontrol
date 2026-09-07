import assert from "node:assert/strict"
import test from "node:test"

import {
  assertComparisonRegistryCoverage,
  collectCurrentRegistryCompetitors,
  comparisonExternalLinks,
  comparisonRegistryClassificationLinks,
  loadCurrentRegistryPages,
  projectRegistryPage,
  registrySearchUrl,
  registryVersionUrl,
  SELF_REGISTRY_NAME,
  SUPERSEDED_SELF_REGISTRY_NAME,
} from "../scripts/comparison-registry.mjs"

const COMPETITOR_ONE = "io.github.example/discord-one"
const COMPETITOR_TWO = "ai.smithery/discord-two"
const VERSION_ONE = "1.2.3"
const VERSION_TWO = "2.0.0-beta.1"

function registryEntry(name, version) {
  return {
    _meta: {
      "io.modelcontextprotocol.registry/official": {
        isLatest: true,
      },
    },
    server: { name, version },
  }
}

function registryPage(entries, nextCursor = null) {
  return {
    metadata: { nextCursor },
    servers: entries,
  }
}

test("comparison evidence links are HTTPS, normalized, and unique", () => {
  assert.deepEqual(comparisonExternalLinks([
    `[one](${registryVersionUrl(COMPETITOR_ONE, VERSION_ONE)}#fragment)`,
    `[duplicate](${registryVersionUrl(COMPETITOR_ONE, VERSION_ONE)})`,
    "[source](https://github.com/example/project)",
  ].join("\n")), [
    "https://github.com/example/project",
    registryVersionUrl(COMPETITOR_ONE, VERSION_ONE),
  ])
  assert.throws(
    () => comparisonExternalLinks("[unsafe](http://example.com)"),
    /must use HTTPS/u,
  )
})

test("Registry coverage considers only explicit release-classification tables", () => {
  const classified = registryVersionUrl(COMPETITOR_ONE, VERSION_ONE)
  const unclassified = registryVersionUrl(COMPETITOR_TWO, VERSION_TWO)
  const markdown = [
    `An unrelated citation cannot classify [two](${unclassified}).`,
    "## Audited releases and source limits",
    "",
    "| Product | Registry release |",
    "| --- | --- |",
    `| One | [record](${classified}) |`,
    `| Duplicate one | [record](${classified}) |`,
    "",
    "## Registry matches outside the scored local comparison",
    "",
    "| Registry entry | Classification |",
    "| --- | --- |",
    "",
    "## Maintenance rule",
  ].join("\n")
  assert.deepEqual(comparisonRegistryClassificationLinks(markdown), [classified, classified])
})

test("Registry URLs bind the complete latest Discord query and exact version records", () => {
  assert.equal(
    registrySearchUrl(),
    "https://registry.modelcontextprotocol.io/v0.1/servers?search=discord&version=latest&limit=100",
  )
  assert.equal(
    registrySearchUrl("next-cursor"),
    "https://registry.modelcontextprotocol.io/v0.1/servers?search=discord&version=latest&limit=100&cursor=next-cursor",
  )
  assert.equal(
    registryVersionUrl(COMPETITOR_ONE, VERSION_ONE),
    "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.example%2Fdiscord-one/versions/1.2.3",
  )
  assert.equal(
    registryVersionUrl(COMPETITOR_ONE, "release 1"),
    "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.example%2Fdiscord-one/versions/release%201",
  )
})

test("Registry pages project strict latest records and competitors exclude every project identity", () => {
  assert.equal(projectRegistryPage({
    metadata: { count: 1 },
    servers: [registryEntry(SELF_REGISTRY_NAME, "0.1.1")],
  }).nextCursor, null)
  const pages = [
    projectRegistryPage(registryPage([
      registryEntry(COMPETITOR_ONE, VERSION_ONE),
      registryEntry(SELF_REGISTRY_NAME, "0.1.1"),
      registryEntry(SUPERSEDED_SELF_REGISTRY_NAME, "0.1.1"),
    ], "page-two")),
    projectRegistryPage(registryPage([
      registryEntry(COMPETITOR_TWO, VERSION_TWO),
    ])),
  ]
  assert.deepEqual(collectCurrentRegistryCompetitors(pages), [
    { name: COMPETITOR_TWO, version: VERSION_TWO },
    { name: COMPETITOR_ONE, version: VERSION_ONE },
  ])
})

test("Registry pagination follows each bounded cursor exactly once", async () => {
  const urls = []
  const pages = await loadCurrentRegistryPages(async (url) => {
    urls.push(url)
    return urls.length === 1
      ? registryPage([registryEntry(SELF_REGISTRY_NAME, "0.1.1")], "page-two")
      : registryPage([registryEntry(COMPETITOR_ONE, VERSION_ONE)])
  })
  assert.equal(pages.length, 2)
  assert.deepEqual(urls, [
    registrySearchUrl(),
    registrySearchUrl("page-two"),
  ])

  await assert.rejects(
    loadCurrentRegistryPages(async () => registryPage([], "repeated")),
    /repeated a pagination cursor/u,
  )
})

test("Registry projection rejects malformed, non-latest, and duplicate evidence", () => {
  assert.throws(() => projectRegistryPage(null), /response is invalid/u)
  assert.throws(
    () => projectRegistryPage(registryPage([
      {
        ...registryEntry(COMPETITOR_ONE, VERSION_ONE),
        _meta: {
          "io.modelcontextprotocol.registry/official": { isLatest: false },
        },
      },
    ])),
    /non-latest/u,
  )
  const duplicatePage = projectRegistryPage(registryPage([
    registryEntry(COMPETITOR_ONE, VERSION_ONE),
    registryEntry(COMPETITOR_ONE, VERSION_ONE),
    registryEntry(SELF_REGISTRY_NAME, "0.1.1"),
  ]))
  assert.throws(
    () => collectCurrentRegistryCompetitors([duplicatePage]),
    /duplicate server/u,
  )
  assert.throws(
    () => collectCurrentRegistryCompetitors([
      projectRegistryPage(registryPage([registryEntry(COMPETITOR_ONE, VERSION_ONE)])),
    ]),
    (error) => {
      assert.equal(error.message, `MCP Registry latest search omitted ${SELF_REGISTRY_NAME}`)
      return true
    },
  )
})

test("comparison coverage reports missing, stale, and duplicate Registry records", () => {
  const competitors = [
    { name: COMPETITOR_ONE, version: VERSION_ONE },
    { name: COMPETITOR_TWO, version: VERSION_TWO },
  ]
  const currentLinks = competitors.map(({ name, version }) => registryVersionUrl(name, version))
  assert.deepEqual(assertComparisonRegistryCoverage(currentLinks, competitors), {
    competitorCount: 2,
    registryVersionUrls: [...currentLinks].sort(),
  })
  assert.throws(
    () => assertComparisonRegistryCoverage(currentLinks.slice(0, 1), competitors),
    /missing current MCP Registry records/u,
  )
  assert.throws(
    () => assertComparisonRegistryCoverage([
      ...currentLinks,
      registryVersionUrl(COMPETITOR_ONE, "1.2.2"),
    ], competitors),
    /stale or unscored MCP Registry records/u,
  )
  assert.throws(
    () => assertComparisonRegistryCoverage([...currentLinks, currentLinks[0]], competitors),
    /duplicate MCP Registry classification records/u,
  )
})
