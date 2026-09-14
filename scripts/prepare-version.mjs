import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import {
  canonicalJson,
  invariant,
  readJson,
  REPOSITORY_ROOT,
  run,
} from "./release-lib.mjs"

const RELEASE_BRANCH = "main"
const RELEASE_SUMMARIES_FILE = "release-summaries.json"
const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const UTC_DAY = /^(?<year>[0-9]{4})-(?<month>[0-9]{2})-(?<day>[0-9]{2})$/
const PACKAGE_VERSION_FILES = Object.freeze([
  "package-lock.json",
  "package.json",
])
const VERSION_SOURCE_FILES = Object.freeze([
  "Dockerfile",
  "PRIVACY.md",
  "README.md",
  "docs/getting-started.md",
  "docs/reference.md",
  "mcpb/manifest.json",
  "scripts/check-published-artifacts.mjs",
  "server.json",
  "src/constants.ts",
  "test/cli.test.ts",
  "test/github-release.test.ts",
  "test/oci-registry.test.ts",
  "test/operator.test.ts",
])
const VERSION_MATCH_EXCEPTIONS = Object.freeze([
  // Pinned third-party releases and parser fixtures do not follow the package version
  "docs/comparison.md",
  "docs/migration.md",
  "scripts/pack-and-verify.mjs",
  "site/package-lock.json",
  "src/migration-manifests.ts",
  "test/migration-html.test.ts",
  "test/prepare-version.test.ts",
])
const MUTATED_FILES = Object.freeze([
  ...PACKAGE_VERSION_FILES,
  ...VERSION_SOURCE_FILES,
  RELEASE_SUMMARIES_FILE,
  "mcpb/reproducible-build.json",
])

function versionParts(version) {
  invariant(STABLE_VERSION.test(version), `Invalid stable version ${version}`)
  return version.split(".").map(Number)
}

export function compareVersions(left, right) {
  const leftParts = versionParts(left)
  const rightParts = versionParts(right)
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index]
    if (difference !== 0) return difference
  }
  return 0
}

export function sourceDateEpoch(value) {
  const match = UTC_DAY.exec(value)
  invariant(match?.groups, `Invalid UTC source date ${value}`)
  const epochMilliseconds = Date.UTC(
    Number(match.groups.year),
    Number(match.groups.month) - 1,
    Number(match.groups.day),
  )
  const date = new Date(epochMilliseconds)
  invariant(date.toISOString() === `${value}T00:00:00.000Z`, `Invalid UTC source date ${value}`)
  return epochMilliseconds / 1_000
}

function assertSummaryLine(value, label) {
  invariant(typeof value === "string" && value.length > 0 && value.length <= 600, `${label} is invalid`)
  invariant(value.trim() === value && !/[\r\n]/u.test(value), `${label} must be one trimmed line`)
}

export function validateReleaseSummary(summary, version) {
  invariant(summary && typeof summary === "object" && !Array.isArray(summary), "Release summary must be an object")
  invariant(
    canonicalJson(Object.keys(summary).sort()) === canonicalJson(["highlights", "paragraphs", "version"]),
    "Release summary fields are invalid",
  )
  invariant(summary.version === version, "Release summary version does not match the target")
  for (const [name, entries] of [["paragraphs", summary.paragraphs], ["highlights", summary.highlights]]) {
    invariant(Array.isArray(entries) && entries.length > 0 && entries.length <= 6, `Release summary ${name} are invalid`)
    entries.forEach((entry, index) => assertSummaryLine(entry, `Release summary ${name}[${index}]`))
  }
  return summary
}

export function parseArguments(arguments_) {
  const options = { sourceDate: undefined, summaryPath: undefined, version: undefined }
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === "--source-date" || argument === "--release-summary") {
      const value = arguments_[index + 1]
      invariant(value, `Option ${argument} requires a value`)
      index += 1
      if (argument === "--source-date") {
        invariant(options.sourceDate === undefined, `Duplicate option ${argument}`)
        options.sourceDate = value
      } else {
        invariant(options.summaryPath === undefined, `Duplicate option ${argument}`)
        options.summaryPath = resolve(value)
      }
      continue
    }
    invariant(!argument.startsWith("-"), `Unknown option ${argument}`)
    invariant(options.version === undefined, `Unexpected argument ${argument}`)
    options.version = argument
  }
  invariant(options.version, "Target version is required")
  versionParts(options.version)
  invariant(options.sourceDate, "Option --source-date is required")
  sourceDateEpoch(options.sourceDate)
  invariant(options.summaryPath, "Option --release-summary is required")
  return options
}

async function gitOutput(arguments_, allowedExitCodes = [0]) {
  const result = await run("git", arguments_, { allowedExitCodes, capture: true })
  return { code: result.code, value: result.stdout.trim() }
}

async function assertReleaseCheckout(targetVersion) {
  const branch = await gitOutput(["branch", "--show-current"])
  invariant(branch.value === RELEASE_BRANCH, `Version preparation requires ${RELEASE_BRANCH}, not ${branch.value || "detached HEAD"}`)
  const status = await gitOutput(["status", "--porcelain=v1", "--untracked-files=all"])
  invariant(status.value === "", "Version preparation requires a clean working tree")
  await run("git", ["fetch", "--quiet", "origin", RELEASE_BRANCH])
  const localRevision = await gitOutput(["rev-parse", "HEAD"])
  const remoteRevision = await gitOutput(["rev-parse", `refs/remotes/origin/${RELEASE_BRANCH}`])
  invariant(localRevision.value === remoteRevision.value, `${RELEASE_BRANCH} must match origin/${RELEASE_BRANCH}`)
  const localTag = await gitOutput(["rev-parse", "--verify", "--quiet", `refs/tags/v${targetVersion}`], [0, 1])
  invariant(localTag.code === 1, `Local tag v${targetVersion} already exists`)
  const remoteTag = await gitOutput(["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/v${targetVersion}`], [0, 2])
  invariant(remoteTag.code === 2, `Remote tag v${targetVersion} already exists`)
}

export function validateVersionFrontier(actual, includesReleaseSummary) {
  const expected = [...PACKAGE_VERSION_FILES, ...VERSION_SOURCE_FILES]
  if (includesReleaseSummary) expected.push(RELEASE_SUMMARIES_FILE)
  const expectedSet = new Set(expected)
  const exceptions = new Set(VERSION_MATCH_EXCEPTIONS)
  const missing = expected.filter((path) => !actual.includes(path)).sort()
  const unexpected = actual.filter((path) => !expectedSet.has(path) && !exceptions.has(path)).sort()
  invariant(
    missing.length === 0 && unexpected.length === 0,
    `Current version source frontier differs: missing ${missing.join(", ") || "none"}; unexpected ${unexpected.join(", ") || "none"}`,
  )
}

async function assertVersionFrontier(currentVersion) {
  const result = await gitOutput(["grep", "-l", "--fixed-strings", currentVersion, "--"], [0, 1])
  const actual = result.value ? result.value.split("\n").sort() : []
  const summaries = await readJson(resolve(REPOSITORY_ROOT, RELEASE_SUMMARIES_FILE))
  validateVersionFrontier(actual, summaries[currentVersion] !== undefined)
}

async function replaceVersion(path, currentVersion, targetVersion) {
  const absolutePath = resolve(REPOSITORY_ROOT, path)
  const source = await readFile(absolutePath, "utf8")
  const updated = source.replaceAll(currentVersion, targetVersion)
  invariant(updated !== source, `${path} does not contain ${currentVersion}`)
  await writeFile(absolutePath, updated)
}

async function updateMcpbDigest(version) {
  const result = await run(
    process.execPath,
    ["scripts/build-mcpb.mjs", "--allow-registry-mismatch"],
    { capture: true },
  )
  const lines = result.stdout.trim().split("\n")
  const report = JSON.parse(lines.at(-1))
  invariant(/^sha256:[0-9a-f]{64}$/.test(report.digest), "Prepared MCPB digest is invalid")
  invariant(report.name === `guildcontrol-${version}.mcpb`, "Prepared MCPB archive name is invalid")
  const serverPath = resolve(REPOSITORY_ROOT, "server.json")
  const server = await readJson(serverPath)
  const packages = server.packages?.filter(({ registryType }) => registryType === "mcpb")
  invariant(packages?.length === 1, "server.json must declare one MCPB package")
  packages[0].fileSha256 = report.digest.slice("sha256:".length)
  await writeFile(serverPath, `${JSON.stringify(server, null, 2)}\n`)
  process.stdout.write(`Prepared ${report.name} with ${report.digest}\n`)
}

async function snapshotMutatedFiles() {
  const snapshots = new Map()
  for (const path of MUTATED_FILES) {
    snapshots.set(path, await readFile(resolve(REPOSITORY_ROOT, path), "utf8"))
  }
  return snapshots
}

async function restoreMutatedFiles(snapshots) {
  await Promise.all(
    [...snapshots.entries()].map(([path, contents]) => writeFile(resolve(REPOSITORY_ROOT, path), contents)),
  )
}

async function prepareVersion(options) {
  const packageJson = await readJson(resolve(REPOSITORY_ROOT, "package.json"))
  const currentVersion = packageJson.version
  invariant(compareVersions(options.version, currentVersion) > 0, `Target version must be greater than ${currentVersion}`)
  const summary = validateReleaseSummary(
    JSON.parse(await readFile(options.summaryPath, "utf8")),
    options.version,
  )
  await assertReleaseCheckout(options.version)
  await assertVersionFrontier(currentVersion)

  process.stdout.write(`==> Verifying ${currentVersion} before version preparation\n`)
  await run("npm", ["run", "release:check"])

  const snapshots = await snapshotMutatedFiles()
  try {
    await run("npm", ["version", options.version, "--no-git-tag-version", "--ignore-scripts"])
    await Promise.all(VERSION_SOURCE_FILES.map((path) => replaceVersion(path, currentVersion, options.version)))
    await writeFile(
      resolve(REPOSITORY_ROOT, "mcpb/reproducible-build.json"),
      `${JSON.stringify({ sourceDateEpoch: sourceDateEpoch(options.sourceDate) }, null, 2)}\n`,
    )
    const summariesPath = resolve(REPOSITORY_ROOT, RELEASE_SUMMARIES_FILE)
    const summaries = await readJson(summariesPath)
    invariant(summaries[options.version] === undefined, `Release summary ${options.version} already exists`)
    summaries[options.version] = summary
    const orderedSummaries = Object.fromEntries(
      Object.entries(summaries).sort(([left], [right]) => compareVersions(left, right)),
    )
    await writeFile(summariesPath, `${JSON.stringify(orderedSummaries, null, 2)}\n`)
    await updateMcpbDigest(options.version)

    process.stdout.write(`==> Verifying prepared ${options.version}\n`)
    await run("npm", ["run", "release:check"])
    await run("git", ["diff", "--check"])
  } catch (error) {
    await restoreMutatedFiles(snapshots)
    throw error
  }
  const status = await gitOutput(["status", "--short"])
  process.stdout.write(`Prepared ${options.version}; inspect and commit these unstaged changes:\n${status.value}\n`)
}

async function main() {
  try {
    await prepareVersion(parseArguments(process.argv.slice(2)))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`version preparation: ${message}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
