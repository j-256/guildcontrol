import assert from "node:assert/strict"

export const MCP_REGISTRY_ORIGIN = "https://registry.modelcontextprotocol.io"
export const SELF_REGISTRY_NAME = "app.lasers.guildcontrol/discord"
export const SUPERSEDED_SELF_REGISTRY_NAME = [
  "io.github.j-256",
  ["discord", "mcp"].join("-"),
].join("/")
export const SELF_REGISTRY_NAMES = Object.freeze([
  SELF_REGISTRY_NAME,
  SUPERSEDED_SELF_REGISTRY_NAME,
])

const LATEST_METADATA_KEY = "io.modelcontextprotocol.registry/official"
const MAXIMUM_PAGE_RESULTS = 100
const MAXIMUM_PAGES = 10
const MAXIMUM_CURSOR_CHARACTERS = 2_048
const MAXIMUM_SERVER_NAME_CHARACTERS = 200
const MAXIMUM_VERSION_CHARACTERS = 255
const REGISTRY_SERVER_NAME = /^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/u

function strictRecord(value, description) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), description)
  return value
}

function characterCount(value) {
  return [...value].length
}

function validUnicode(value) {
  try {
    encodeURIComponent(value)
    return true
  } catch {
    return false
  }
}

function exactText(value, pattern, maximumCharacters, description) {
  assert.equal(typeof value, "string", description)
  const characters = characterCount(value)
  assert.ok(
    characters > 0
      && characters <= maximumCharacters
      && validUnicode(value),
    description,
  )
  if (pattern !== null) assert.match(value, pattern, description)
  return value
}

function normalizedExternalLinks(markdown) {
  assert.equal(typeof markdown, "string", "Comparison Markdown must be text")
  assert.doesNotMatch(markdown, /\]\(http:\/\//u, "Comparison evidence links must use HTTPS")
  return [...markdown.matchAll(/!?\[[^\]]*\]\((https:\/\/[^)\s]+)(?:\s+["'][^"']*["'])?\)/gu)]
    .map((match) => new URL(match[1]))
    .map((url) => {
      url.hash = ""
      return url.href
    })
}

export function comparisonExternalLinks(markdown) {
  const links = normalizedExternalLinks(markdown)
  assert.ok(links.length > 0, "Comparison contains no external evidence links")
  return [...new Set(links)].sort()
}

export function comparisonRegistryClassificationLinks(markdown) {
  assert.equal(typeof markdown, "string", "Comparison Markdown must be text")
  const startHeading = "## Audited releases and source limits"
  const endHeading = "## Maintenance rule"
  const start = markdown.indexOf(startHeading)
  const end = markdown.indexOf(endHeading)
  assert.ok(start >= 0 && end > start, "Comparison Registry classification sections are invalid")
  const tableRows = markdown
    .slice(start + startHeading.length, end)
    .split("\n")
    .filter((line) => line.startsWith("| "))
    .join("\n")
  const links = normalizedExternalLinks(tableRows)
  assert.ok(links.length > 0, "Comparison Registry classifications contain no evidence links")
  return links.sort()
}

export function registrySearchUrl(cursor = null) {
  const url = new URL("/v0.1/servers", MCP_REGISTRY_ORIGIN)
  url.searchParams.set("search", "discord")
  url.searchParams.set("version", "latest")
  url.searchParams.set("limit", String(MAXIMUM_PAGE_RESULTS))
  if (cursor !== null) {
    url.searchParams.set(
      "cursor",
      exactText(cursor, null, MAXIMUM_CURSOR_CHARACTERS, "MCP Registry cursor is invalid"),
    )
  }
  return url.href
}

export function registryVersionUrl(name, version) {
  const normalizedName = exactText(
    name,
    REGISTRY_SERVER_NAME,
    MAXIMUM_SERVER_NAME_CHARACTERS,
    "MCP Registry server name is invalid",
  )
  const normalizedVersion = exactText(
    version,
    null,
    MAXIMUM_VERSION_CHARACTERS,
    "MCP Registry server version is invalid",
  )
  return `${MCP_REGISTRY_ORIGIN}/v0.1/servers/${encodeURIComponent(normalizedName)}/versions/${encodeURIComponent(normalizedVersion)}`
}

export function projectRegistryPage(value) {
  const page = strictRecord(value, "MCP Registry response is invalid")
  assert.ok(Array.isArray(page.servers), "MCP Registry response lacks a server list")
  assert.ok(page.servers.length <= MAXIMUM_PAGE_RESULTS, "MCP Registry response exceeds its requested page bound")
  const metadata = strictRecord(page.metadata, "MCP Registry response lacks pagination metadata")
  const nextCursor = Object.hasOwn(metadata, "nextCursor") ? metadata.nextCursor : null
  if (nextCursor !== null) {
    exactText(
      nextCursor,
      null,
      MAXIMUM_CURSOR_CHARACTERS,
      "MCP Registry response has an invalid next cursor",
    )
  }
  const records = page.servers.map((valueEntry) => {
    const entry = strictRecord(valueEntry, "MCP Registry server entry is invalid")
    const server = strictRecord(entry.server, "MCP Registry server metadata is invalid")
    const official = strictRecord(
      entry._meta?.[LATEST_METADATA_KEY],
      "MCP Registry server entry lacks official metadata",
    )
    assert.equal(official.isLatest, true, "MCP Registry latest search returned a non-latest entry")
    const name = exactText(
      server.name,
      REGISTRY_SERVER_NAME,
      MAXIMUM_SERVER_NAME_CHARACTERS,
      "MCP Registry server name is invalid",
    )
    const version = exactText(
      server.version,
      null,
      MAXIMUM_VERSION_CHARACTERS,
      "MCP Registry server version is invalid",
    )
    return Object.freeze({ name, version })
  })
  return Object.freeze({ nextCursor, records: Object.freeze(records) })
}

export async function loadCurrentRegistryPages(fetchPage) {
  assert.equal(typeof fetchPage, "function", "MCP Registry page loader is invalid")
  const pages = []
  const cursors = new Set()
  let cursor = null
  for (let pageNumber = 0; pageNumber < MAXIMUM_PAGES; pageNumber += 1) {
    const page = projectRegistryPage(await fetchPage(registrySearchUrl(cursor)))
    pages.push(page)
    if (page.nextCursor === null) return Object.freeze(pages)
    assert.ok(
      !cursors.has(page.nextCursor),
      "MCP Registry latest search repeated a pagination cursor",
    )
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  throw new Error("MCP Registry latest search exceeded its page bound")
}

export function collectCurrentRegistryCompetitors(pages) {
  assert.ok(Array.isArray(pages) && pages.length > 0, "MCP Registry search returned no pages")
  assert.ok(pages.length <= MAXIMUM_PAGES, "MCP Registry search exceeded its page bound")
  for (const selfName of SELF_REGISTRY_NAMES) {
    exactText(
      selfName,
      REGISTRY_SERVER_NAME,
      MAXIMUM_SERVER_NAME_CHARACTERS,
      "Self MCP Registry server name is invalid",
    )
  }
  const byName = new Map()
  for (const pageValue of pages) {
    const page = strictRecord(pageValue, "Projected MCP Registry page is invalid")
    assert.ok(Array.isArray(page.records), "Projected MCP Registry page lacks records")
    for (const recordValue of page.records) {
      const record = strictRecord(recordValue, "Projected MCP Registry record is invalid")
      const name = exactText(
        record.name,
        REGISTRY_SERVER_NAME,
        MAXIMUM_SERVER_NAME_CHARACTERS,
        "MCP Registry server name is invalid",
      )
      const version = exactText(
        record.version,
        null,
        MAXIMUM_VERSION_CHARACTERS,
        "MCP Registry server version is invalid",
      )
      assert.ok(!byName.has(name), `MCP Registry latest search returned duplicate server ${name}`)
      byName.set(name, Object.freeze({ name, version }))
    }
  }
  assert.ok(byName.has(SELF_REGISTRY_NAME), `MCP Registry latest search omitted ${SELF_REGISTRY_NAME}`)
  for (const selfName of SELF_REGISTRY_NAMES) byName.delete(selfName)
  assert.ok(byName.size > 0, "MCP Registry latest search returned no Discord competitors")
  return Object.freeze([...byName.values()].sort((left, right) => left.name.localeCompare(right.name)))
}

export function assertComparisonRegistryCoverage(links, competitors) {
  assert.ok(Array.isArray(links), "Comparison link inventory is invalid")
  assert.ok(Array.isArray(competitors) && competitors.length > 0, "MCP Registry competitor inventory is invalid")
  const expected = competitors.map(({ name, version }) => registryVersionUrl(name, version)).sort()
  const registryLinks = links.filter((link) => {
    const url = new URL(link)
    return url.origin === MCP_REGISTRY_ORIGIN
      && url.pathname.startsWith("/v0.1/servers/")
      && url.pathname.includes("/versions/")
  })
  const duplicateLinks = registryLinks.filter((link, index) => registryLinks.indexOf(link) !== index)
  assert.deepEqual(
    [...new Set(duplicateLinks)].sort(),
    [],
    "Comparison contains duplicate MCP Registry classification records",
  )
  const actual = [...new Set(registryLinks)].sort()
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  const missing = expected.filter((url) => !actualSet.has(url))
  const stale = actual.filter((url) => !expectedSet.has(url))
  if (missing.length > 0 || stale.length > 0) {
    const sections = []
    if (missing.length > 0) {
      sections.push(`Comparison is missing current MCP Registry records:\n${missing.join("\n")}`)
    }
    if (stale.length > 0) {
      sections.push(`Comparison cites stale or unscored MCP Registry records:\n${stale.join("\n")}`)
    }
    throw new Error(sections.join("\n"))
  }
  return Object.freeze({ competitorCount: competitors.length, registryVersionUrls: Object.freeze(expected) })
}
