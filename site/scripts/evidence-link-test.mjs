import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  assertComparisonRegistryCoverage,
  collectCurrentRegistryCompetitors,
  comparisonExternalLinks,
  comparisonRegistryClassificationLinks,
  loadCurrentRegistryPages,
} from "./comparison-registry.mjs"

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const COMPARISON_FILE = resolve(SCRIPT_DIRECTORY, "..", "..", "docs", "comparison.md")
const CONCURRENCY = 4
const EXTERNAL_LINK_REQUEST_TIMEOUT_MS = 20_000
const REGISTRY_REQUEST_TIMEOUT_MS = 60_000
const RETRY_DELAYS_MS = Object.freeze([0, 750, 2_500])
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const USER_AGENT = "guildcontrol-documentation-link-verifier/1.0"

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

async function fetchStatus(url) {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      range: "bytes=0-0",
      "user-agent": USER_AGENT,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(EXTERNAL_LINK_REQUEST_TIMEOUT_MS),
  })
  const status = response.status
  await response.body?.cancel()
  return status
}

async function fetchRegistryResponse(url) {
  let lastFailure
  for (const retryDelay of RETRY_DELAYS_MS) {
    if (retryDelay > 0) await delay(retryDelay)
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": USER_AGENT,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS),
      })
      if (response.ok) return await response.json()
      const status = response.status
      await response.body?.cancel()
      lastFailure = new Error(`HTTP ${status}`)
      if (!RETRYABLE_STATUS.has(status)) break
    } catch (error) {
      lastFailure = error
    }
  }
  throw new Error(`${url}: ${lastFailure?.message || "unknown failure"}`)
}

async function verifyLink(url) {
  let lastFailure
  for (const retryDelay of RETRY_DELAYS_MS) {
    if (retryDelay > 0) await delay(retryDelay)
    try {
      const status = await fetchStatus(url)
      if (status >= 200 && status < 400) return
      lastFailure = new Error(`HTTP ${status}`)
      if (!RETRYABLE_STATUS.has(status)) break
    } catch (error) {
      lastFailure = error
    }
  }
  throw new Error(`${url}: ${lastFailure?.message || "unknown failure"}`)
}

async function main() {
  const markdown = await readFile(COMPARISON_FILE, "utf8")
  const queue = comparisonExternalLinks(markdown)
  const classificationLinks = comparisonRegistryClassificationLinks(markdown)
  const registryPages = await loadCurrentRegistryPages(fetchRegistryResponse)
  const competitors = collectCurrentRegistryCompetitors(registryPages)
  const coverage = assertComparisonRegistryCoverage(classificationLinks, competitors)
  const total = queue.length
  const failures = []
  const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, async () => {
    while (queue.length > 0) {
      const url = queue.shift()
      try {
        await verifyLink(url)
      } catch (error) {
        failures.push(error.message)
      }
    }
  })
  await Promise.all(workers)
  if (failures.length > 0) {
    throw new Error(`Comparison evidence has unreachable links:\n${failures.join("\n")}`)
  }
  process.stdout.write(`Verified ${coverage.competitorCount} current Registry competitors and ${total} external comparison evidence links\n`)
}

await main()
