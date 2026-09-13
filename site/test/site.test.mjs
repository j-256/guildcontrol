import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, readdir, stat } from "node:fs/promises"
import { dirname, extname, join, relative, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const execFileAsync = promisify(execFile)
const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const SITE_DIRECTORY = resolve(TEST_DIRECTORY, "..")
const REPOSITORY_ROOT = resolve(SITE_DIRECTORY, "..")
const DIST_DIRECTORY = join(SITE_DIRECTORY, "dist")
const SITE_ORIGIN = "https://docs.guildcontrol.lasers.app"
const SITE_URL = SITE_ORIGIN
const REQUIRED_CSP = "default-src 'none'"
const STABLE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/u
const SAFE_LINK_PROTOCOLS = new Set(["data:", "http:", "https:", "mailto:"])

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

async function collectFiles(directory, rejectUnsupported = false) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const candidate = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(candidate, rejectUnsupported))
    else if (entry.isFile()) files.push(candidate)
    else if (rejectUnsupported) assert.fail(`${relative(SITE_DIRECTORY, candidate)} has an unsupported file type`)
  }
  return files
}

async function exists(file) {
  try {
    return (await stat(file)).isFile()
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

function pageUrl(file) {
  const path = relative(DIST_DIRECTORY, file).replaceAll("\\", "/")
  if (path === "index.html") return `${SITE_URL}/`
  if (path === "404.html") return `${SITE_URL}/404.html`
  if (path.endsWith("/index.html")) return `${SITE_URL}/${path.slice(0, -"index.html".length)}`
  return `${SITE_URL}/${path}`
}

function htmlAttributes(markup) {
  const tags = []
  for (const match of markup.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/giu)) {
    const attributes = new Map()
    for (const attribute of match[2].matchAll(/\b([a-z][a-z0-9:-]*)="([^"]*)"/giu)) {
      attributes.set(attribute[1].toLocaleLowerCase("en-US"), attribute[2].replaceAll("&amp;", "&"))
    }
    tags.push({ attributes, name: match[1].toLocaleLowerCase("en-US") })
  }
  return tags
}

function localFileFor(url) {
  const decodedPath = decodeURIComponent(url.pathname)
  assert.equal(url.origin, SITE_ORIGIN, `Local URL escapes site origin: ${url.href}`)
  const path = decodedPath.replace(/^\//u, "")
  if (path === "") return join(DIST_DIRECTORY, "index.html")
  if (path.endsWith("/")) return join(DIST_DIRECTORY, path, "index.html")
  if (extname(path) === "") return join(DIST_DIRECTORY, path, "index.html")
  return join(DIST_DIRECTORY, path)
}

function generatedSnapshot(manifest) {
  return {
    manifest: sha256(JSON.stringify(manifest)),
    outputs: manifest.outputs,
    sources: manifest.sources,
  }
}

test("documentation generation is deterministic and source-bound", async () => {
  const manifestFile = join(SITE_DIRECTORY, "public", "generated", "docs-manifest.json")
  const before = JSON.parse(await readFile(manifestFile, "utf8"))
  await execFileAsync(process.execPath, [join(SITE_DIRECTORY, "scripts", "generate.mjs")], {
    cwd: SITE_DIRECTORY,
  })
  const after = JSON.parse(await readFile(manifestFile, "utf8"))
  assert.deepEqual(generatedSnapshot(after), generatedSnapshot(before))
  assert.equal(after.format, "guildcontrol.docs-manifest.v1")
  assert.equal(after.package.name, "guildctl")
  assert.match(after.package.version, STABLE_VERSION)
  assert.equal(new Set(after.outputs.map(({ path }) => path)).size, after.outputs.length)
  assert.equal(new Set(after.sources.map(({ path }) => path)).size, after.sources.length)
  for (const source of after.sources) {
    assert.equal(sha256(await readFile(join(REPOSITORY_ROOT, source.path))), source.sha256, source.path)
  }
  for (const output of after.outputs) {
    assert.equal(sha256(await readFile(join(SITE_DIRECTORY, output.path))), output.sha256, output.path)
  }
})

test("documentation dependencies and install scripts are exact", async () => {
  const packageJson = JSON.parse(await readFile(join(SITE_DIRECTORY, "package.json"), "utf8"))
  const lock = JSON.parse(await readFile(join(SITE_DIRECTORY, "package-lock.json"), "utf8"))
  assert.equal(packageJson.private, true)
  assert.equal(packageJson.engines.node, ">=22.12")
  for (const [name, version] of Object.entries(packageJson.devDependencies)) {
    assert.match(version, STABLE_VERSION, name)
  }
  const installScripts = Object.entries(lock.packages)
    .filter(([, candidate]) => candidate.hasInstallScript)
    .map(([path, candidate]) => `${path.replace(/^node_modules\//u, "")}@${candidate.version}`)
    .sort()
  assert.deepEqual(installScripts, [
    "esbuild@0.28.2",
    "fsevents@2.3.2",
    "vite/node_modules/fsevents@2.3.3",
    "workerd@1.20260910.1",
    "wrangler/node_modules/esbuild@0.28.1",
    "wrangler/node_modules/fsevents@2.3.3",
  ])
  assert.deepEqual(packageJson.allowScripts, {
    "esbuild@0.28.2": true,
    "fsevents@2.3.2": false,
    "fsevents@2.3.3": false,
    "esbuild@0.28.1": true,
    "workerd@1.20260910.1": true,
  })
  const rootPackage = JSON.parse(await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"))
  assert.ok(!rootPackage.files.includes("site"))
  assert.ok(!Object.hasOwn(rootPackage.dependencies, "astro"))
  assert.ok(!Object.hasOwn(rootPackage.devDependencies, "astro"))
})

test("built documentation has complete local navigation and no remote runtime assets", async () => {
  const files = await collectFiles(DIST_DIRECTORY, true)
  const htmlFiles = files.filter((file) => file.endsWith(".html"))
  assert.ok(htmlFiles.length > 0)
  assert.ok(await exists(join(DIST_DIRECTORY, "pagefind", "pagefind.js")))
  assert.ok(await exists(join(DIST_DIRECTORY, "generated", "contract-explorer.html")))
  assert.ok(await exists(join(DIST_DIRECTORY, "generated", "contract-evidence.json")))
  assert.ok(await exists(join(DIST_DIRECTORY, "generated", "guildcontrol.config.schema.json")))
  assert.ok(await exists(join(DIST_DIRECTORY, "contribute", "documentation-portal", "index.html")))
  assert.ok(await exists(join(DIST_DIRECTORY, "start", "manual-setup", "index.html")))
  assert.ok(await exists(join(DIST_DIRECTORY, "start", "migration", "index.html")))
  assert.ok(await exists(join(DIST_DIRECTORY, "understand", "safety-decisions", "index.html")))
  assert.ok(await exists(join(DIST_DIRECTORY, "llms.txt")))
  assert.ok(await exists(join(DIST_DIRECTORY, "llms-full.txt")))
  const comparisonMarkup = await readFile(
    join(DIST_DIRECTORY, "understand", "comparison", "index.html"),
    "utf8",
  )
  assert.match(comparisonMarkup, /Cappyeo's /u)
  assert.doesNotMatch(comparisonMarkup, /Cappyeo\u2019s /u)

  const htmlByFile = new Map()
  for (const file of htmlFiles) htmlByFile.set(file, await readFile(file, "utf8"))
  for (const [file, markup] of htmlByFile) {
    const ids = [...markup.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1])
    assert.equal(new Set(ids).size, ids.length, `${relative(DIST_DIRECTORY, file)} has duplicate IDs`)
    for (const table of markup.match(/<table\b[^>]*>/gu) || []) {
      assert.match(table, /\btabindex="0"/u, `${relative(DIST_DIRECTORY, file)} has a non-focusable table`)
    }
    const isContractExplorer = file.endsWith(join("generated", "contract-explorer.html"))
    const isNotFoundPage = file.endsWith("404.html")
    assert.ok(markup.includes(REQUIRED_CSP), `${relative(DIST_DIRECTORY, file)} lacks the restrictive CSP`)
    if (!isContractExplorer) {
      assert.ok(markup.includes('name="referrer"'), `${relative(DIST_DIRECTORY, file)} lacks referrer policy`)
    }
    if (!isContractExplorer && !isNotFoundPage) {
      assert.ok(markup.includes('data-pagefind-body'), `${relative(DIST_DIRECTORY, file)} lacks search indexing`)
    }
    const sourceUrl = new URL(pageUrl(file))
    for (const tag of htmlAttributes(markup)) {
      for (const attributeName of ["href", "src"]) {
        const value = tag.attributes.get(attributeName)
        if (!value || value.startsWith("#")) continue
        const target = new URL(value, sourceUrl)
        assert.ok(
          SAFE_LINK_PROTOCOLS.has(target.protocol),
          `${sourceUrl.href} contains an unsafe URL scheme`,
        )
        if (target.protocol === "data:" || target.protocol === "mailto:") continue
        if (target.origin !== SITE_ORIGIN) {
          assert.equal(tag.name, "a", `${sourceUrl.href} loads a remote ${tag.name} resource: ${target.href}`)
          continue
        }
        const targetFile = localFileFor(target)
        assert.ok(await exists(targetFile), `${sourceUrl.href} links to missing ${target.href}`)
        if (!target.hash || !targetFile.endsWith(".html")) continue
        const targetMarkup = htmlByFile.get(targetFile) || await readFile(targetFile, "utf8")
        const identifier = decodeURIComponent(target.hash.slice(1))
        assert.ok(
          new RegExp(`\\bid="${identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`, "u").test(targetMarkup),
          `${sourceUrl.href} links to missing fragment ${target.href}`,
        )
      }
    }
  }

  for (const file of files.filter((candidate) => candidate.endsWith(".css"))) {
    const css = await readFile(file, "utf8")
    assert.doesNotMatch(css, /url\(\s*["']?https?:/iu, `${relative(DIST_DIRECTORY, file)} loads a remote asset`)
  }
})

test("published machine-readable artifacts preserve credential-free evidence", async () => {
  const packageJson = JSON.parse(await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"))
  const evidence = JSON.parse(await readFile(join(DIST_DIRECTORY, "generated", "contract-evidence.json"), "utf8"))
  assert.equal(evidence.status, "ok")
  assert.equal(evidence.serverVersion, packageJson.version)
  assert.equal(evidence.credentialsRequired, false)
  assert.equal(evidence.discordExecution, "disabled")
  assert.equal(evidence.gateway, "disabled")
  assert.equal(evidence.observabilityExport, "disabled")
  assert.equal(evidence.activityRecordsCreated, false)
  assert.equal(evidence.policyCompletionValuesExposed, false)
  assert.equal(evidence.planReviewApp.serverToolAuthority, false)
  assert.deepEqual(evidence.planReviewApp.externalNetworkDomains, [])
  const llms = await readFile(join(DIST_DIRECTORY, "llms.txt"), "utf8")
  assert.match(llms, new RegExp(`${packageJson.name.replace("/", "\\/")}@${packageJson.version}`, "u"))
  assert.match(llms, /\/start\/migration\//u)
  const llmsFull = await readFile(join(DIST_DIRECTORY, "llms-full.txt"), "utf8")
  assert.match(llmsFull, /===== SOURCE: docs\/migration\.md =====/u)
  assert.match(llmsFull, /===== SOURCE: docs\/safety-usability\.md =====/u)
  const unpinnedPackage = new RegExp(`${packageJson.name.replace("/", "\\/")}@latest\\b`, "u")
  assert.doesNotMatch(llms, unpinnedPackage)
  const allTrackedSiteText = (await collectFiles(SITE_DIRECTORY))
    .filter((file) => !file.includes(`${join(SITE_DIRECTORY, "node_modules")}`))
    .filter((file) => !file.includes(`${join(SITE_DIRECTORY, "dist")}`))
    .filter((file) => !file.includes(`${join(SITE_DIRECTORY, ".astro")}`))
    .filter((file) => [".astro", ".css", ".js", ".json", ".md", ".mdx", ".mjs", ".ts"].includes(extname(file)))
  for (const file of allTrackedSiteText) {
    assert.doesNotMatch(await readFile(file, "utf8"), unpinnedPackage, relative(SITE_DIRECTORY, file))
  }
})
