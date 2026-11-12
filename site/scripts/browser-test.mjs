import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { readFile, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import AxeBuilder from "@axe-core/playwright"
import { chromium } from "playwright"

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const SITE_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..")
const PACKAGE = JSON.parse(await readFile(resolve(SITE_DIRECTORY, "..", "package.json"), "utf8"))
const EXPECTED_RELEASE_CONTEXT = `${PACKAGE.name}@${PACKAGE.version}`
const HOST = "127.0.0.1"
const PORT = 4327
const ORIGIN = `http://${HOST}:${PORT}`
const BASE_URL = ORIGIN
const ASTRO_CLI = join(SITE_DIRECTORY, "node_modules", "astro", "bin", "astro.mjs")
const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 5_000
const PAGE_TIMEOUT_MS = 30_000
const ACCESSIBILITY_TIMEOUT_MS = 45_000
const EXPECTED_NOT_FOUND_CONSOLE = "error: Failed to load resource: the server responded with a status of 404 (Not Found)"
const CHANNEL_COMPATIBILITY_PATH = "/reference/capabilities/channels-and-roles/channel-type-compatibility/"
const TEST_PATHS = [
  "/",
  "/start/getting-started/",
  "/start/manual-setup/",
  "/start/migration/",
  "/understand/boundaries/",
  "/understand/comparison/",
  "/understand/privacy/",
  "/understand/safety-decisions/",
  "/reference/",
  "/reference/capabilities/foundations/safety-model/",
  CHANNEL_COMPATIBILITY_PATH,
  "/security/",
]

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

function reportProgress(message) {
  process.stdout.write(`Documentation browser: ${message}\n`)
}

async function withTimeout(label, milliseconds, operation) {
  let timeout
  try {
    return await Promise.race([
      operation(),
      new Promise((_resolvePromise, rejectPromise) => {
        timeout = setTimeout(
          () => rejectPromise(new Error(`${label} exceeded ${milliseconds}ms`)),
          milliseconds,
        )
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForPreview(processHandle) {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`Documentation preview exited with ${processHandle.exitCode}`)
    try {
      const response = await fetch(`${BASE_URL}/`)
      if (response.ok) return
    } catch {
      await delay(100)
      continue
    }
    await delay(100)
  }
  throw new Error("Documentation preview did not become ready")
}

async function waitForExit(processHandle) {
  if (processHandle.exitCode !== null) return
  await Promise.race([
    once(processHandle, "exit"),
    delay(STOP_TIMEOUT_MS),
  ])
}

async function stopPreview(processHandle) {
  if (processHandle.exitCode === null) {
    processHandle.kill("SIGTERM")
    await waitForExit(processHandle)
  }
  if (processHandle.exitCode === null) {
    processHandle.kill("SIGKILL")
    await once(processHandle, "exit")
  }
  await rm(join(SITE_DIRECTORY, ".astro", "preview.json"), { force: true })
}

async function assertAccessible(page, path) {
  const result = await withTimeout(`Accessibility scan for ${path}`, ACCESSIBILITY_TIMEOUT_MS, () => (
    new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze()
  ))
  assert.deepEqual(
    result.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      nodes: nodes.map(({ failureSummary, target }) => ({ failureSummary, target })),
    })),
    [],
    `${path} has accessibility violations`,
  )
}

async function main() {
  const preview = spawn(
    process.execPath,
    [ASTRO_CLI, "preview", "--host", HOST, "--port", String(PORT)],
    {
      cwd: SITE_DIRECTORY,
      env: { ...process.env, ASTRO_PREVIEW_BACKGROUND: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  let previewOutput = ""
  preview.stdout.on("data", (chunk) => { previewOutput += chunk })
  preview.stderr.on("data", (chunk) => { previewOutput += chunk })
  try {
    reportProgress("starting preview")
    await waitForPreview(preview)
    reportProgress("preview ready")
    const browser = await chromium.launch({ headless: true })
    try {
      const context = await browser.newContext({ viewport: { height: 900, width: 1440 } })
      const page = await context.newPage()
      page.setDefaultTimeout(PAGE_TIMEOUT_MS)
      page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS)
      const consoleFailures = []
      const pageFailures = []
      const remoteRequests = []
      page.on("console", (message) => {
        if (["error", "warning"].includes(message.type())) consoleFailures.push(`${message.type()}: ${message.text()}`)
      })
      page.on("pageerror", (error) => pageFailures.push(error.message))
      page.on("request", (request) => {
        if (new URL(request.url()).origin !== ORIGIN) remoteRequests.push(request.url())
      })

      for (const path of TEST_PATHS) {
        reportProgress(`checking ${path}`)
        const response = await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle" })
        assert.equal(response?.status(), 200, path)
        await page.getByRole("heading", { level: 1 }).waitFor()
        await assertAccessible(page, path)
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        assert.ok(overflow <= 1, `${path} overflows the desktop viewport by ${overflow}px`)
      }

      reportProgress("checking primary navigation")
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" })
      assert.equal(await page.getByRole("link", { name: "Get a verified read" }).count(), 1)
      assert.equal(await page.getByRole("link", { name: "Switch from another Discord MCP" }).count(), 1)
      assert.equal(await page.getByRole("link", { name: "Take the verified product tour" }).count(), 1)
      const releaseIdentity = await page.locator(".release-context code").innerText()
      assert.equal(releaseIdentity, EXPECTED_RELEASE_CONTEXT)
      const releaseContext = await page.locator(".release-context").innerText()
      assert.match(releaseContext, /not affiliated with or endorsed by Discord Inc\./u)
      await page.keyboard.press("Tab")
      assert.equal(await page.locator(":focus").innerText(), "Skip to content")
      await page.getByRole("link", { name: "Get a verified read" }).click()
      await page.waitForURL(`${BASE_URL}/start/getting-started/`)
      assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "Getting started: first verified Discord read")

      reportProgress("checking migration and search")
      await page.goto(`${BASE_URL}/start/migration/`, { waitUntil: "networkidle" })
      assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "Migrate from another Discord MCP")

      await page.goto(`${BASE_URL}/reference/`, { waitUntil: "networkidle" })
      const searchButton = page.getByRole("button", { name: "Search" })
      await searchButton.waitFor({ state: "visible" })
      assert.equal(await searchButton.isEnabled(), true)
      await searchButton.click()
      const searchInput = page.locator("#starlight__search input").first()
      await searchInput.waitFor({ state: "visible" })
      await searchInput.fill("provenance SBOM")
      await page.locator("#starlight__search a").first().waitFor({ state: "visible" })

      reportProgress("checking contract explorer")
      await page.goto(`${BASE_URL}/generated/contract-explorer.html`, { waitUntil: "networkidle" })
      assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "GuildControl MCP Contract Explorer")
      const scopeTab = page.getByRole("tab", { name: /Scope/u })
      const routeTab = page.getByRole("tab", { name: /Route/u })
      const recoverTab = page.getByRole("tab", { name: /Recover/u })
      const inspectTab = page.getByRole("tab", { name: /Inspect/u })
      await scopeTab.click()
      assert.equal(await scopeTab.getAttribute("aria-selected"), "true")
      assert.equal(await page.getByRole("heading", { name: "Create a narrow read-only boundary" }).isVisible(), true)
      await scopeTab.press("ArrowRight")
      assert.equal(await routeTab.getAttribute("aria-selected"), "true")
      await routeTab.press("End")
      assert.equal(await recoverTab.getAttribute("aria-selected"), "true")
      await recoverTab.press("Home")
      assert.equal(await inspectTab.getAttribute("aria-selected"), "true")
      await page.getByRole("searchbox", { name: "Search" }).fill("delete")
      assert.match(await page.getByRole("status").innerText(), /tools shown/u)
      await assertAccessible(page, "/generated/contract-explorer.html")

      reportProgress("checking not-found behavior")
      const consoleCountBeforeNotFound = consoleFailures.length
      const notFound = await page.goto(`${BASE_URL}/route-that-does-not-exist/`, { waitUntil: "networkidle" })
      assert.equal(notFound?.status(), 404)
      assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "Page not found")
      await assertAccessible(page, "/route-that-does-not-exist/")
      const notFoundConsole = consoleFailures.splice(consoleCountBeforeNotFound)
      assert.ok(
        notFoundConsole.every((message) => message === EXPECTED_NOT_FOUND_CONSOLE),
        `Not-found route emitted unexpected console output: ${notFoundConsole.join("\n")}`,
      )

      reportProgress("checking mobile layouts")
      await page.setViewportSize({ height: 844, width: 390 })
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" })
      const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      assert.ok(mobileOverflow <= 1, `Home overflows the mobile viewport by ${mobileOverflow}px`)
      await assertAccessible(page, "/ mobile")

      await page.goto(`${BASE_URL}/understand/comparison/`, { waitUntil: "networkidle" })
      const comparisonOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      assert.ok(comparisonOverflow <= 1, `Comparison overflows the mobile viewport by ${comparisonOverflow}px`)
      const comparisonTable = page.locator("table").first()
      assert.ok(await comparisonTable.isVisible(), "Comparison matrix is not visible")
      assert.ok(
        await comparisonTable.evaluate((table) => table.scrollWidth > table.clientWidth),
        "Comparison matrix does not provide bounded horizontal scrolling on mobile",
      )
      await assertAccessible(page, "/understand/comparison/ mobile")

      await page.goto(`${BASE_URL}${CHANNEL_COMPATIBILITY_PATH}`, { waitUntil: "networkidle" })
      const compatibilityOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      assert.ok(compatibilityOverflow <= 1, `Channel compatibility overflows the mobile viewport by ${compatibilityOverflow}px`)
      await assertAccessible(page, `${CHANNEL_COMPATIBILITY_PATH} mobile`)

      await page.goto(`${BASE_URL}/generated/contract-explorer.html#tour`, { waitUntil: "networkidle" })
      const explorerOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      assert.ok(explorerOverflow <= 1, `Contract explorer overflows the mobile viewport by ${explorerOverflow}px`)
      const tourTabs = page.getByRole("tablist", { name: "Guided product tour steps" })
      assert.ok(
        await tourTabs.evaluate((tabs) => tabs.scrollWidth > tabs.clientWidth),
        "Guided product tour does not provide bounded horizontal scrolling on mobile",
      )
      await assertAccessible(page, "/generated/contract-explorer.html mobile")

      assert.deepEqual(remoteRequests, [], "Documentation made remote runtime requests")
      assert.deepEqual(pageFailures, [], "Documentation raised page errors")
      assert.deepEqual(consoleFailures, [], "Documentation emitted console warnings or errors")
      reportProgress("closing browser context")
      await context.close()
    } finally {
      await browser.close()
    }
  } catch (error) {
    if (previewOutput.trim()) process.stderr.write(previewOutput)
    throw error
  } finally {
    await stopPreview(preview)
  }
  process.stdout.write("Documentation browser verification passed\n")
}

await main()
