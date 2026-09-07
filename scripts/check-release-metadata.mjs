import {
  lstat,
  readFile,
  readlink,
  readdir,
} from "node:fs/promises"
import { join } from "node:path"

import {
  canonicalJson,
  invariant,
  readJson,
  REPOSITORY_ROOT,
  run,
  sha256,
} from "./release-lib.mjs"
import { containsSpecificReference } from "./neutrality.mjs"
import {
  DOCUMENTATION_CONTENT_PATHS,
  DOCUMENTATION_MANIFEST_FORMAT,
  DOCUMENTATION_URL,
  documentationSourcePaths,
} from "./documentation-manifest.mjs"

const PACKAGE_NAME = "guildctl"
const MCP_NAME = "app.lasers.guildcontrol/discord"
const MCP_TITLE = "GuildControl MCP"
const MCP_DESCRIPTION = "Safety-first MCP server for Discord with privacy-safe reads, audits, and reviewed administration"
const TRADEMARK_DISCLAIMER = "GuildControl is an independent project and is not affiliated with or endorsed by Discord Inc. Discord is used only to identify the platform that GuildControl connects to."
const REPOSITORY_URL = "https://github.com/j-256/guildcontrol"
const PRODUCT_URL = "https://guildcontrol.lasers.app"
const PRODUCT_REDIRECT_REF = "guildcontrol_product_to_docs"
const REPOSITORY_ID = "1334461127"
const ICON_SHA256 = "4b65ca78a84dc8d5cc5ac5e1e19a08c4bab20d7d455cc0cb57185e6ff2ca15de"
const ICON_MIME_TYPE = "image/png"
const ICON_SIZE = "1254x1254"
const REGISTRY_SCHEMA = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json"
const NPM_REGISTRY = "https://registry.npmjs.org"
const NPM_CONFIGURATION = "registry=https://registry.npmjs.org/\nreplace-registry-host=never\n"
const FIRST_PUBLICATION_COMMAND = "npm publish ./guildctl-MAJOR.MINOR.PATCH.tgz --provenance=false"
const OCI_IMAGE_NAME = "ghcr.io/j-256/guildcontrol"
const NODE_IMAGE = "node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436"
const BINFMT_IMAGE = "tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0"
const BUILDKIT_IMAGE = "moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8"
const SBOM_GENERATOR_IMAGE = "docker.io/docker/buildkit-syft-scanner@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9"
const GITHUB_CLI_VERSION = "2.98.0"
const GITHUB_CLI_SHA256 = "3b8ac6b30336802fc1a858d7c084e11cdf24ac1a761ca90b68022d7d729208de"
const README_MAX_BYTES = 32 * 1024
const COMMUNITY_FILE_MAX_BYTES = 12 * 1024
const README_REQUIRED_HEADINGS = Object.freeze([
  "## Why this connector",
  "## Quick start",
  "## Capability map",
  "## Safety model",
  "## Trust and verification",
  "## Architecture",
  "## Documentation",
  "## Development",
  "## License",
])
const REFERENCE_REQUIRED_HEADINGS = Object.freeze([
  "## Safety model",
  "## Requirements",
  "## Operator CLI",
  "## Configuration",
  "## Tools",
  "## Resources",
  "## Deletion workflow",
  "## Verification",
  "## Release integrity",
])
const LIMITATIONS_REQUIRED_HEADINGS = Object.freeze([
  "## Fit check",
  "## Custody and privacy boundary",
  "## MCP host compatibility",
  "## Discord and operational constraints",
  "## Deliberately unsupported",
  "## What verification proves",
  "## Choose the next path",
])
const NARROW_COMPETITOR_LEAD_OUTCOMES = Object.freeze([
  "Update an existing generated default-path Codex launcher with one explicit apply command",
  "Inventory recognized tool-name references in a caller-selected source checkout",
  "Execute a complete multi-operation convergence from one apply call",
  "Repeat catch-up without caller-held cursor state",
  "Friendly aliases and personas",
])
const STABLE_SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/
const ABSOLUTE_HTTPS_REFERENCE = /\bhttps:\/\/[^\s<>"'`]+/gu
const EXPECTED_DEPENDENCIES = {
  "@modelcontextprotocol/client": "2.0.0",
  "@modelcontextprotocol/server": "2.0.0",
  "@opentelemetry/api": "1.9.1",
  "@opentelemetry/context-async-hooks": "2.10.0",
  "@opentelemetry/exporter-metrics-otlp-proto": "0.221.0",
  "@opentelemetry/exporter-trace-otlp-proto": "0.221.0",
  "@opentelemetry/otlp-exporter-base": "0.221.0",
  "@opentelemetry/resources": "2.10.0",
  "@opentelemetry/sdk-metrics": "2.10.0",
  "@opentelemetry/sdk-trace": "2.10.0",
  zod: "4.4.3",
}
const EXPECTED_DEV_DEPENDENCIES = {
  "@types/node": "26.4.0",
  ajv: "8.20.0",
  "ajv-formats": "3.0.1",
  esbuild: "0.28.2",
  fflate: "0.8.3",
  tsx: "4.23.12",
  typescript: "7.0.2",
}
const EXPECTED_SITE_DEV_DEPENDENCIES = {
  "@astrojs/check": "0.9.10",
  "@astrojs/markdown-remark": "7.2.4",
  "@astrojs/starlight": "0.41.9",
  "@axe-core/playwright": "4.13.0",
  astro: "7.2.9",
  playwright: "1.62.1",
  typescript: "6.0.3",
  wrangler: "4.126.0",
}
const EXPECTED_SITE_SCRIPTS = {
  "browser:install": "playwright install chromium",
  "browser:install:ci": "playwright install --with-deps chromium",
  build: "npm run generate && astro build",
  check: "npm run generate && astro check",
  deploy: "wrangler deploy",
  "deploy:dry-run": "wrangler deploy --dry-run --outdir .wrangler/dry-run",
  "deps:locked": "npm ci --ignore-scripts && npm rebuild esbuild@0.28.2 esbuild@0.28.1 workerd@1.20260825.1 --ignore-scripts=false",
  dev: "npm run generate && astro dev",
  generate: "node scripts/generate.mjs",
  preview: "astro preview",
  "security:check": "npm audit --audit-level=moderate && npm audit signatures",
  test: "node --test test/*.test.mjs",
  "test:browser": "node scripts/browser-test.mjs",
  "test:evidence-links": "node scripts/evidence-link-test.mjs",
  verify: "npm run check && npm run build && npm test && npm run test:browser",
}
const EXPECTED_SITE_PRERELEASE_DEPENDENCIES = {
  "node_modules/get-tsconfig": "5.0.0-beta.4",
  "node_modules/miniflare": "5.20260825.0-alpha",
  "node_modules/unenv": "2.0.0-rc.24",
  "node_modules/youch": "4.1.0-beta.10",
}
const LEGACY_IDENTITY_EXCEPTIONS = new Set([
  "docs/comparison.md",
  "src/migration-manifests.ts",
])
const LEGACY_IDENTITY_PATTERN = /discord[-_]?mcp/iu
const LEGACY_SELF_IDENTITY_PATTERN = new RegExp("j-256(?:\\/|%2f)discord" + "-mcp", "iu")
const LEGACY_SCOPED_PACKAGE_PATTERN = /(?:@|%40)j-256(?:\/|%2f)guildcontrol/iu

function referencesExactOrigin(source, expectedOrigin) {
  const expected = new URL(expectedOrigin)
  for (const [reference] of source.matchAll(ABSOLUTE_HTTPS_REFERENCE)) {
    let parsed
    try {
      parsed = new URL(reference)
    } catch {
      continue
    }
    if (parsed.origin === expected.origin) return true
  }
  return false
}

async function checkNeutrality() {
  const clientCompatibilityPaths = new Set([
    "README.md",
    "SUPPORT.md",
    "docs/comparison.md",
    "docs/getting-started.md",
    "docs/limitations.md",
    "docs/reference.md",
    "scripts/check-release-metadata.mjs",
    "scripts/pack-and-verify.mjs",
    "site/src/content/docs/index.mdx",
    "site/src/content/docs/operate/index.mdx",
    "site/src/content/docs/start/choose.mdx",
    "site/test/neutrality.test.mjs",
    "src/host-adapters.ts",
    "src/host-detection.ts",
    "src/host-inspection.ts",
    "src/host-installation.ts",
    "src/onboard-html.ts",
    "src/onboard.ts",
    "test/cli.test.ts",
    "test/host-activation-html.test.ts",
    "test/host-adapters.test.ts",
    "test/host-detection.test.ts",
    "test/host-inspection.test.ts",
    "test/host-installation.test.ts",
    "test/onboard-html.test.ts",
    "test/onboard.test.ts",
  ])
  const { stdout } = await run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { capture: true },
  )
  const paths = stdout.split("\0").filter(Boolean)
  for (const path of paths) {
    invariant(!containsSpecificReference(path), `${path} has model- or harness-specific branding`)
    const absolutePath = join(REPOSITORY_ROOT, path)
    let metadata
    try {
      metadata = await lstat(absolutePath)
    } catch (error) {
      if (error?.code === "ENOENT") continue
      throw error
    }
    const bytes = metadata.isSymbolicLink()
      ? Buffer.from(await readlink(absolutePath))
      : await readFile(absolutePath)
    const text = bytes.toString("latin1")
    invariant(
      !containsSpecificReference(text, {
        allowClientCompatibility: clientCompatibilityPaths.has(path),
      }),
      `${path} has model- or harness-specific branding`,
    )
    if (!LEGACY_IDENTITY_EXCEPTIONS.has(path)) {
      invariant(!LEGACY_IDENTITY_PATTERN.test(path), `${path} uses the retired product identity`)
      invariant(!LEGACY_IDENTITY_PATTERN.test(text), `${path} uses the retired product identity`)
    }
    invariant(!LEGACY_SELF_IDENTITY_PATTERN.test(text), `${path} uses the retired project identity`)
    invariant(!LEGACY_SCOPED_PACKAGE_PATTERN.test(text), `${path} uses a scoped GuildControl package identity`)
  }
}

const EXPECTED_PACKAGE_FILES = [
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "dist",
  "guildcontrol.config.schema.json",
  "docs/comparison.md",
  "docs/getting-started.md",
  "docs/limitations.md",
  "docs/migration.md",
  "docs/reference.md",
  "docs/releasing.md",
  "docs/safety-usability.md",
  "SUPPORT.md",
  "PRIVACY.md",
  "server.json",
]

const OCI_CONFIG_FILE = "/configuration/guildcontrol.json"
const REGISTRY_TOKEN_INPUT = Object.freeze({
  description: "Discord bot token sent only to fixed Discord REST and vetted Gateway origins",
  format: "string",
  isRequired: true,
  isSecret: true,
  name: "DISCORD_BOT_TOKEN",
})
const REGISTRY_CONFIG_ARGUMENT = Object.freeze({
  description: "Absolute path to one strict versioned non-secret configuration document",
  format: "filepath",
  isRequired: true,
  placeholder: "/absolute/path/to/guildcontrol.json",
  type: "positional",
  valueHint: "config_file",
})
const NPM_PACKAGE_ARGUMENTS = Object.freeze([
  { type: "positional", value: "serve" },
  { type: "positional", value: "--config" },
  REGISTRY_CONFIG_ARGUMENT,
])
const OCI_PACKAGE_ARGUMENTS = Object.freeze([
  { type: "positional", value: "serve" },
  { type: "positional", value: "--config" },
  { type: "positional", value: OCI_CONFIG_FILE },
])
const OCI_RUNTIME_ARGUMENTS = Object.freeze([
  { type: "positional", value: "--read-only" },
  { type: "positional", value: "--cap-drop=ALL" },
  { type: "positional", value: "--security-opt=no-new-privileges:true" },
  { type: "positional", value: "--pids-limit=64" },
  {
    description: "Read-only bind mount for the non-secret connector configuration",
    isRequired: true,
    name: "--mount",
    type: "named",
    value: `type=bind,source={config_file},target=${OCI_CONFIG_FILE},readonly`,
    variables: {
      config_file: {
        description: "Absolute host path to the connector configuration",
        format: "filepath",
        isRequired: true,
        placeholder: "/absolute/path/to/guildcontrol.json",
      },
    },
  },
])

const EXPECTED_ACTION_PINS = new Map([
  ["actions/attest", "1e69f48acb82d1966a394da916b4c1698aa569d6"],
  ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
  ["actions/download-artifact", "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"],
  ["actions/setup-node", "820762786026740c76f36085b0efc47a31fe5020"],
  ["actions/upload-artifact", "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"],
  ["docker/build-push-action", "53b7df96c91f9c12dcc8a07bcb9ccacbed38856a"],
  ["docker/login-action", "dbcb813823bdd20940b903addbd779551569679f"],
  ["docker/setup-buildx-action", "37fe631027851001ddb9b187196cc803df7f5f0e"],
  ["docker/setup-qemu-action", "96fe6ef7f33517b61c61be40b68a1882f3264fb8"],
  ["github/codeql-action/analyze", "cdf488f595d80d6e07e03d4674febd5ab45fa938"],
  ["github/codeql-action/init", "cdf488f595d80d6e07e03d4674febd5ab45fa938"],
])

function assertEqual(actual, expected, message) {
  invariant(canonicalJson(actual) === canonicalJson(expected), message)
}

function assertPinnedDependencies(packageJson) {
  for (const [name, version] of Object.entries({
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  })) {
    invariant(STABLE_SEMVER.test(version), `${name} must use an exact stable version`)
  }
}

async function checkPackageAndLock() {
  const packageJson = await readJson(join(REPOSITORY_ROOT, "package.json"))
  const lock = await readJson(join(REPOSITORY_ROOT, "package-lock.json"))
  invariant(packageJson.name === PACKAGE_NAME, "package name does not match the release identity")
  invariant(STABLE_SEMVER.test(packageJson.version), "package version must be stable semantic versioning")
  invariant(packageJson.private === undefined, "publishable package must not be private")
  invariant(packageJson.description === MCP_DESCRIPTION, "package description is invalid")
  invariant(packageJson.author === "j-256", "package author is invalid")
  invariant(packageJson.mcpName === MCP_NAME, "package mcpName does not match the registry identity")
  invariant(packageJson.license === "AGPL-3.0-only", "package license does not match LICENSE")
  invariant(packageJson.engines?.node === ">=22", "package Node.js floor must remain 22")
  invariant(packageJson.main === "./dist/index.js", "package main entrypoint is invalid")
  invariant(packageJson.types === "./dist/index.d.ts", "package types entrypoint is invalid")
  invariant(packageJson.bin?.guildctl === "dist/bin.js", "package CLI entrypoint is invalid")
  assertEqual(packageJson.exports, {
    ".": {
      import: "./dist/index.js",
      types: "./dist/index.d.ts",
    },
  }, "package exports are invalid")
  assertEqual(packageJson.dependencies, EXPECTED_DEPENDENCIES, "production dependency set changed")
  assertEqual(packageJson.devDependencies, EXPECTED_DEV_DEPENDENCIES, "development dependency set changed")
  assertEqual([...packageJson.keywords].sort(), [
    "ai-agent",
    "discord",
    "least-privilege",
    "mcp",
    "model-context-protocol",
    "moderation",
  ], "package keywords are invalid")
  assertEqual([...packageJson.files].sort(), [...EXPECTED_PACKAGE_FILES].sort(), "package file allowlist is invalid")
  assertEqual(packageJson.publishConfig, { provenance: true }, "publish configuration must require provenance")
  assertEqual(packageJson.repository, {
    type: "git",
    url: "git+https://github.com/j-256/guildcontrol.git",
  }, "package repository metadata is invalid")
  invariant(packageJson.homepage === DOCUMENTATION_URL, "package homepage is invalid")
  invariant(packageJson.bugs?.url === `${REPOSITORY_URL}/issues`, "package issue tracker is invalid")
  assertEqual(packageJson.allowScripts, {
    "esbuild@0.28.2": true,
    fsevents: false,
  }, "install-script allowlist is invalid")
  assertPinnedDependencies(packageJson)
  assertEqual(packageJson.scripts, {
    build: "tsc -p tsconfig.build.json",
    "container:index:verify": "node scripts/verify-oci-layout.mjs",
    "container:verify": "npm run build && node scripts/verify-container.mjs",
    "config:schema": "node --import tsx scripts/generate-config-schema.mjs",
    "config:schema:check": "node --import tsx scripts/generate-config-schema.mjs --check",
    "deps:locked": "npm ci --ignore-scripts && npm rebuild esbuild@0.28.2 --ignore-scripts=false",
    mcp: "node dist/bin.js serve",
    "metadata:check": "node scripts/check-release-metadata.mjs",
    "mcpb:verify": "node scripts/build-mcpb.mjs",
    "pack:verify": "node scripts/pack-and-verify.mjs",
    prepack: "npm run config:schema:check && npm run metadata:check && npm run build",
    "probe:live": "node dist/bin.js doctor --online --json",
    "release:check": "node scripts/release-check.mjs",
    sbom: "node scripts/generate-sbom.mjs",
    "security:check": "npm audit --audit-level=moderate && npm audit signatures",
    test: "tsx --test test/*.test.ts",
    "test:coverage": "tsx --test --experimental-test-coverage --test-coverage-lines=85 --test-coverage-branches=75 --test-coverage-functions=80 test/*.test.ts",
    typecheck: "tsc --noEmit",
    "version:prepare": "node scripts/prepare-version.mjs",
  }, "package scripts do not match the verified release contract")

  invariant(lock.name === packageJson.name, "lockfile package name is out of sync")
  invariant(lock.version === packageJson.version, "lockfile package version is out of sync")
  invariant(lock.lockfileVersion === 3, "lockfile version must remain npm lockfile v3")
  invariant(lock.requires === true, "lockfile must preserve dependency requirements")
  const root = lock.packages?.[""]
  invariant(root?.name === packageJson.name, "lockfile root package name is out of sync")
  invariant(root?.version === packageJson.version, "lockfile root package version is out of sync")
  assertEqual(root?.dependencies, packageJson.dependencies, "lockfile production dependencies are out of sync")
  assertEqual(root?.devDependencies, packageJson.devDependencies, "lockfile development dependencies are out of sync")
  const installScripts = Object.entries(lock.packages)
    .filter(([, metadata]) => metadata.hasInstallScript === true)
    .map(([path, metadata]) => `${path.replace(/^node_modules\//, "")}@${metadata.version}`)
    .sort()
  assertEqual(installScripts, ["esbuild@0.28.2", "fsevents@2.3.3"], "lockfile install-script packages changed")
  for (const [path, metadata] of Object.entries(lock.packages)) {
    if (!path) continue
    invariant(metadata.link !== true, `${path} must not be a linked dependency`)
    invariant(STABLE_SEMVER.test(metadata.version), `${path} must use a stable package version`)
    invariant(typeof metadata.resolved === "string", `${path} lacks an immutable registry archive`)
    invariant(metadata.resolved.startsWith(`${NPM_REGISTRY}/`), `${path} is not locked to the public npm registry`)
    invariant(typeof metadata.integrity === "string" && metadata.integrity.startsWith("sha512-"), `${path} lacks SHA-512 integrity`)
  }
  return packageJson
}

async function checkReleaseSummaries(packageJson) {
  const summaries = await readJson(join(REPOSITORY_ROOT, "release-summaries.json"))
  invariant(summaries && typeof summaries === "object" && !Array.isArray(summaries), "release summaries must be an object")
  for (const [version, summary] of Object.entries(summaries)) {
    invariant(STABLE_SEMVER.test(version), `release summary version ${version} is invalid`)
    invariant(summary?.version === version, `release summary ${version} has a mismatched version`)
    assertEqual(Object.keys(summary).sort(), ["highlights", "paragraphs", "version"], `release summary ${version} fields are invalid`)
    for (const [name, entries] of [["paragraphs", summary.paragraphs], ["highlights", summary.highlights]]) {
      invariant(Array.isArray(entries) && entries.length > 0 && entries.length <= 6, `release summary ${version} ${name} are invalid`)
      for (const entry of entries) {
        invariant(typeof entry === "string" && entry.length > 0 && entry.length <= 600, `release summary ${version} ${name} entry is invalid`)
        invariant(entry.trim() === entry && !/[\r\n]/u.test(entry), `release summary ${version} ${name} entry must be one trimmed line`)
      }
    }
  }
  if (!packageJson.version.startsWith("0.")) {
    invariant(summaries[packageJson.version], `stable release ${packageJson.version} lacks a public summary`)
  }
}

async function checkDocumentationPortal() {
  const packageJson = await readJson(join(REPOSITORY_ROOT, "site/package.json"))
  const lock = await readJson(join(REPOSITORY_ROOT, "site/package-lock.json"))
  const astroConfiguration = await readFile(join(REPOSITORY_ROOT, "site/astro.config.mjs"), "utf8")
  const wranglerConfiguration = await readJson(join(REPOSITORY_ROOT, "site/wrangler.jsonc"))
  const generator = await readFile(join(REPOSITORY_ROOT, "site/scripts/generate.mjs"), "utf8")
  const publicVerifier = await readFile(
    join(REPOSITORY_ROOT, "scripts/check-public-documentation.mjs"),
    "utf8",
  )
  invariant(packageJson.name === "guildcontrol-docs", "documentation package name is invalid")
  invariant(packageJson.version === "0.0.0", "documentation package must remain non-published")
  invariant(packageJson.private === true, "documentation package must remain private")
  invariant(packageJson.license === "AGPL-3.0-only", "documentation package license is invalid")
  invariant(packageJson.type === "module", "documentation package must use ESM")
  invariant(packageJson.engines?.node === ">=22.12", "documentation package Node.js floor is invalid")
  invariant(packageJson.dependencies === undefined, "documentation package must not add production dependencies")
  assertEqual(packageJson.devDependencies, EXPECTED_SITE_DEV_DEPENDENCIES, "documentation dependencies changed")
  assertEqual(packageJson.scripts, EXPECTED_SITE_SCRIPTS, "documentation scripts changed")
  assertEqual(packageJson.allowScripts, {
    "esbuild@0.28.2": true,
    "fsevents@2.3.2": false,
    "fsevents@2.3.3": false,
    "esbuild@0.28.1": true,
    "workerd@1.20260825.1": true,
  }, "documentation install-script allowlist changed")
  assertPinnedDependencies(packageJson)

  invariant(lock.name === packageJson.name, "documentation lockfile package name is out of sync")
  invariant(lock.version === packageJson.version, "documentation lockfile package version is out of sync")
  invariant(lock.lockfileVersion === 3, "documentation lockfile must remain npm lockfile v3")
  invariant(lock.requires === true, "documentation lockfile must preserve dependency requirements")
  const root = lock.packages?.[""]
  invariant(root?.name === packageJson.name, "documentation lockfile root package name is out of sync")
  invariant(root?.version === packageJson.version, "documentation lockfile root package version is out of sync")
  invariant(root?.license === packageJson.license, "documentation lockfile license is out of sync")
  assertEqual(root?.devDependencies, packageJson.devDependencies, "documentation lockfile dependencies are out of sync")
  assertEqual(root?.engines, packageJson.engines, "documentation lockfile Node.js floor is out of sync")
  const installScripts = Object.entries(lock.packages)
    .filter(([, metadata]) => metadata.hasInstallScript === true)
    .map(([path, metadata]) => `${path.replace(/^node_modules\//, "")}@${metadata.version}`)
    .sort()
  assertEqual(
    installScripts,
    [
      "esbuild@0.28.2",
      "fsevents@2.3.2",
      "vite/node_modules/fsevents@2.3.3",
      "workerd@1.20260825.1",
      "wrangler/node_modules/esbuild@0.28.1",
      "wrangler/node_modules/fsevents@2.3.3",
    ],
    "documentation lockfile install-script packages changed",
  )
  const prereleaseDependencies = Object.fromEntries(
    Object.entries(lock.packages)
      .filter(([path, metadata]) => path && !STABLE_SEMVER.test(metadata.version))
      .map(([path, metadata]) => [path, metadata.version]),
  )
  assertEqual(
    prereleaseDependencies,
    EXPECTED_SITE_PRERELEASE_DEPENDENCIES,
    "documentation prerelease dependency set changed",
  )
  for (const [path, metadata] of Object.entries(lock.packages)) {
    if (!path) continue
    invariant(metadata.link !== true, `${path} must not be a linked documentation dependency`)
    invariant(typeof metadata.resolved === "string", `${path} lacks an immutable documentation archive`)
    invariant(metadata.resolved.startsWith(`${NPM_REGISTRY}/`), `${path} is not locked to the public npm registry`)
    invariant(typeof metadata.integrity === "string" && metadata.integrity.startsWith("sha512-"), `${path} lacks documentation SHA-512 integrity`)
  }
  assertEqual(DOCUMENTATION_CONTENT_PATHS, [
    "README.md",
    "docs/getting-started.md",
    "docs/migration.md",
    "docs/limitations.md",
    "PRIVACY.md",
    "docs/comparison.md",
    "SUPPORT.md",
    "docs/documentation-portal.md",
    "docs/releasing.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "docs/reference.md",
    "docs/safety-usability.md",
    "SECURITY.md",
    "guildcontrol.config.schema.json",
    "server.json",
    "LICENSE",
    "assets/guildcontrol-icon.png",
    "package.json",
  ], "documentation source frontier changed")
  const documentationSources = await documentationSourcePaths()
  for (const required of [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    "package-lock.json",
    "scripts/check-public-documentation.mjs",
    "scripts/check-release-metadata.mjs",
    "scripts/documentation-manifest.mjs",
    "scripts/neutrality.mjs",
    "scripts/release-lib.mjs",
    "docs/documentation-portal.md",
    "site/astro.config.mjs",
    "site/package-lock.json",
    "site/package.json",
    "site/plugins/accessible-tables.mjs",
    "site/scripts/browser-test.mjs",
    "site/scripts/comparison-registry.mjs",
    "site/scripts/evidence-link-test.mjs",
    "site/scripts/generate.mjs",
    "site/src/components/ReleaseFooter.astro",
    "site/src/content.config.ts",
    "site/src/pages/404.astro",
    "site/src/styles/custom.css",
    "site/test/comparison-registry.test.mjs",
    "site/test/site.test.mjs",
    "site/tsconfig.json",
    "site/wrangler.jsonc",
    "src/catalog.ts",
    "src/constants.ts",
    "test/public-documentation.test.ts",
    "tsconfig.build.json",
    "tsconfig.json",
  ]) {
    invariant(documentationSources.includes(required), `documentation source frontier lacks ${required}`)
  }
  invariant(DOCUMENTATION_MANIFEST_FORMAT === "guildcontrol.docs-manifest.v1", "documentation manifest format changed")
  invariant(astroConfiguration.includes(`const SITE_ORIGIN = "${DOCUMENTATION_URL}"`), "documentation origin is invalid")
  invariant(!astroConfiguration.includes("\n  base:"), "documentation must publish at the canonical origin root")
  assertEqual(wranglerConfiguration, {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: "guildcontrol-docs",
    compatibility_date: "2026-08-30",
    send_metrics: false,
    workers_dev: true,
    preview_urls: false,
    assets: {
      directory: "./dist",
      html_handling: "auto-trailing-slash",
      not_found_handling: "404-page",
    },
  }, "documentation Worker configuration changed")
  for (const binding of [
    "DOCUMENTATION_MANIFEST_FORMAT",
    "documentationSourcePaths",
    "DOCUMENTATION_URL",
  ]) {
    invariant(generator.includes(binding), `documentation generator does not use ${binding}`)
  }
  invariant(!generator.includes(DOCUMENTATION_URL), "documentation generator duplicates its canonical URL")
  invariant(publicVerifier.includes("--manifest FILE"), "public documentation verifier lacks exact-artifact mode")
  invariant(publicVerifier.includes("Exit status 0 means matching"), "public documentation verifier lacks exit semantics")
}

async function checkSourceIdentity(packageJson) {
  const source = await readFile(join(REPOSITORY_ROOT, "src/constants.ts"), "utf8")
  const connectorName = source.match(/export const CONNECTOR_NAME = "([^"]+)"/)?.[1]
  const connectorTitle = source.match(/export const CONNECTOR_TITLE = "([^"]+)"/)?.[1]
  const connectorVersion = source.match(/export const CONNECTOR_VERSION = "([^"]+)"/)?.[1]
  const connectorNpmPackage = source.match(/export const CONNECTOR_NPM_PACKAGE = "([^"]+)"/)?.[1]
  const connectorDescription = source.match(/export const CONNECTOR_DESCRIPTION = "([^"]+)"/)?.[1]
  const connectorWebsiteUrl = source.match(/export const CONNECTOR_WEBSITE_URL = "([^"]+)"/)?.[1]
  const connectorIconUrl = source.match(/export const CONNECTOR_ICON_URL = `([^`]+)`/)?.[1]
  const connectorIconMimeType = source.match(/export const CONNECTOR_ICON_MIME_TYPE = "([^"]+)"/)?.[1]
  const connectorIconSize = source.match(
    /export const CONNECTOR_ICON_SIZES = Object\.freeze\(\["([^"]+)"\] as const\)/,
  )?.[1]
  const configSelector = source.match(
    /export const CONFIG_FILE_ENVIRONMENT_VARIABLE = "([^"]+)"/,
  )?.[1]
  const defaultTokenVariable = source.match(
    /export const DEFAULT_TOKEN_ENVIRONMENT_VARIABLE = "([^"]+)"/,
  )?.[1]
  const policyEnvironmentNames = [
    ...new Set(
      [...source.matchAll(/"((?:GUILDCONTROL_|OTEL_)[A-Z0-9_]+)"/g)]
        .map((match) => match[1]),
    ),
  ].sort()
  invariant(connectorName === "guildcontrol", "source connector name is out of sync")
  invariant(connectorTitle === MCP_TITLE, "source connector title is out of sync")
  invariant(connectorVersion === packageJson.version, "source connector version is out of sync")
  invariant(connectorNpmPackage === packageJson.name, "source npm package is out of sync")
  invariant(connectorDescription === MCP_DESCRIPTION, "source connector description is out of sync")
  invariant(connectorWebsiteUrl === DOCUMENTATION_URL, "source connector website is out of sync")
  invariant(
    connectorIconUrl === "https://raw.githubusercontent.com/j-256/guildcontrol/v${CONNECTOR_VERSION}/assets/guildcontrol-icon.png",
    "source connector icon URL is out of sync",
  )
  invariant(connectorIconMimeType === ICON_MIME_TYPE, "source connector icon media type is out of sync")
  invariant(connectorIconSize === ICON_SIZE, "source connector icon size is out of sync")
  invariant(
    configSelector === "GUILDCONTROL_CONFIG_FILE",
    "source configuration selector is out of sync",
  )
  invariant(
    defaultTokenVariable === "DISCORD_BOT_TOKEN",
    "source default token reference is out of sync",
  )
  invariant(
    !source.includes("ENVIRONMENT_NAMES"),
    "source must not add an alternate policy environment catalog",
  )
  assertEqual(
    policyEnvironmentNames,
    ["GUILDCONTROL_CONFIG_FILE"],
    "source must expose only the non-secret configuration selector",
  )
}

async function checkDocumentation(packageJson) {
  const readme = await readFile(join(REPOSITORY_ROOT, "README.md"), "utf8")
  const releaseFooter = await readFile(
    join(REPOSITORY_ROOT, "site/src/components/ReleaseFooter.astro"),
    "utf8",
  )
  const security = await readFile(join(REPOSITORY_ROOT, "SECURITY.md"), "utf8")
  const gettingStarted = await readFile(
    join(REPOSITORY_ROOT, "docs/getting-started.md"),
    "utf8",
  )
  const limitations = await readFile(
    join(REPOSITORY_ROOT, "docs/limitations.md"),
    "utf8",
  )
  const migration = await readFile(
    join(REPOSITORY_ROOT, "docs/migration.md"),
    "utf8",
  )
  const comparison = await readFile(join(REPOSITORY_ROOT, "docs/comparison.md"), "utf8")
  const documentationPortal = await readFile(
    join(REPOSITORY_ROOT, "docs/documentation-portal.md"),
    "utf8",
  )
  const releasing = await readFile(join(REPOSITORY_ROOT, "docs/releasing.md"), "utf8")
  const safetyUsability = await readFile(
    join(REPOSITORY_ROOT, "docs/safety-usability.md"),
    "utf8",
  )
  const reference = await readFile(
    join(REPOSITORY_ROOT, "docs/reference.md"),
    "utf8",
  )
  const documentation = `${readme}\n${gettingStarted}\n${migration}\n${limitations}\n${comparison}\n${safetyUsability}\n${reference}`
  const documentedVersions = [...documentation.matchAll(/\bguildctl@([0-9]+\.[0-9]+\.[0-9]+)/g)]
    .map((match) => match[1])
  invariant(documentedVersions.length > 0, "README does not show a pinned npm installation")
  invariant(documentedVersions.every((version) => version === packageJson.version), "documentation npm versions are out of sync")
  invariant(readme.includes(`https://raw.githubusercontent.com/j-256/guildcontrol/v${packageJson.version}/assets/guildcontrol-icon.png`), "README icon URL is out of sync")
  invariant(readme.includes(`[Documentation portal](${DOCUMENTATION_URL}/)`), "README lacks the public documentation portal")
  invariant(!referencesExactOrigin(readme, PRODUCT_URL), "README must not identify the temporary product origin as documentation")
  invariant(readme.includes(TRADEMARK_DISCLAIMER), "README lacks the independent-project trademark disclaimer")
  invariant(releaseFooter.includes(TRADEMARK_DISCLAIMER), "documentation portal lacks the independent-project trademark disclaimer")
  invariant(releasing.includes("[documentation portal operations guide](documentation-portal.md)"), "release runbook lacks the documentation operations boundary")
  invariant(releasing.includes("node scripts/check-public-documentation.mjs"), "release runbook lacks the documentation release precondition")
  invariant(!referencesExactOrigin(releasing, PRODUCT_URL), "release runbook must require the canonical documentation origin")
  invariant(documentationPortal.includes(`Set the GitHub repository homepage to \`${DOCUMENTATION_URL}\``), "documentation operations guide lacks the canonical homepage")
  invariant(documentationPortal.includes("node scripts/check-public-documentation.mjs"), "documentation operations guide lacks public verification")
  invariant(documentationPortal.includes("CLOUDFLARE_WORKERS_DEPLOY_TOKEN"), "documentation operations guide lacks the purpose-specific deployment secret")
  invariant(documentationPortal.includes(`stable ref \`${PRODUCT_REDIRECT_REF}\``), "documentation operations guide lacks the stable product redirect reference")
  invariant(documentationPortal.includes("HTTP 307"), "documentation operations guide lacks the temporary redirect status")
  invariant(documentationPortal.includes("path and query string"), "documentation operations guide lacks redirect preservation")
  invariant(documentationPortal.includes("AAAA 100::"), "documentation operations guide lacks the originless redirect placeholder")
  invariant(documentationPortal.includes("MCP verification `TXT`"), "documentation operations guide lacks exact-name TXT preservation")
  invariant(Buffer.byteLength(readme) <= README_MAX_BYTES, "README must remain a concise landing page")
  invariant((readme.match(/^# /gm) || []).length === 1, "README must contain one top-level heading")
  let previousHeading = -1
  for (const heading of README_REQUIRED_HEADINGS) {
    const position = readme.indexOf(heading)
    invariant(position > previousHeading, `README is missing or misorders ${heading}`)
    previousHeading = position
  }
  for (const required of [
    "[Complete reference](docs/reference.md)",
    "[Safety and usability decisions](docs/safety-usability.md)",
    `[Verified product tour](${DOCUMENTATION_URL}/generated/contract-explorer.html#tour)`,
    "--preset server-observer",
    "preset install server-observer",
    "--config ./guildcontrol.json",
    "catalog --check --json",
    "config validate ./guildcontrol.json",
    "doctor --config ./guildcontrol.json --online",
    "host --npx --config ./guildcontrol.json --html ./guildcontrol-host-activation.html",
    "--inspect-host-file",
    "incident-response",
    "coordination-channel",
    "message-channel",
    "recipe list",
    "recipe enable guild-starter",
    "recipe plan guild-starter",
    "recipe apply guild-starter",
    "smoke --config ./guildcontrol.json",
  ]) {
    invariant(readme.includes(required), `README is missing ${required}`)
  }
  invariant(reference.includes("preset install server-observer"), "complete reference lacks preset-derived bot installation")
  invariant(reference.includes("guided product tour and searchable standalone explorer"), "complete reference lacks the guided catalog tour")
  invariant(reference.includes("recipe show guild-starter --json"), "complete reference lacks starter recipe inspection")
  invariant(reference.includes("recipe show guild-builder --json"), "complete reference lacks broad blueprint recipe inspection")
  invariant(reference.includes("recipe show coordination-channel --json"), "complete reference lacks coordination recipe inspection")
  invariant(reference.includes("recipe show message-channel --json"), "complete reference lacks plain-message recipe inspection")
  invariant(reference.includes("## Complete bot-installation drift audit"), "complete reference lacks bot-installation drift guidance")
  invariant(reference.includes("`discord://connector/installations`"), "complete reference lacks the bot-installation resource")
  invariant(reference.includes("`audit_bot_installations`"), "complete reference lacks the bot-installation tool and prompt")
  invariant(security.includes("## Bot installation drift"), "security policy lacks bot-installation drift requirements")
  invariant(security.includes("require one commit-pinned GitHub tree URL"), "security policy lacks pinned migration evidence")
  invariant(reference.includes("--plan-digest PLAN_DIGEST --confirm guild-starter"), "complete reference lacks reviewed starter recipe application")
  invariant(reference.includes("No recipe removes or disables existing policy"), "complete reference lacks additive-only recipe policy")
  invariant(reference.includes("## Privacy-minimized guild incident actions and reviewed lockdown changes"), "complete reference lacks reviewed guild incident actions")
  invariant(reference.includes("does not document `X-Audit-Log-Reason`"), "complete reference lacks the guild incident audit-header boundary")
  invariant(security.includes("## Guild incident actions"), "security policy lacks reviewed guild incident actions")
  invariant(readme.includes("reviewed public layouts with nonprivileged `GUILDS` evidence"), "README lacks guild-starter Gateway evidence disclosure")
  invariant(reference.includes("privacy-minimized `GUILDS`-only layout connection"), "complete reference lacks guild-builder Gateway evidence disclosure")
  invariant(security.includes("Gateway evidence requirement"), "security policy lacks recipe Gateway disclosure")
  invariant(readme.includes("there is no alternate environment-policy or automatic import mode"), "README lacks clean-break configuration policy")
  invariant(reference.includes("There is no environment-policy or automatic configuration-import command"), "complete reference lacks clean-break configuration policy")
  invariant(security.includes("no environment-policy compatibility shape is accepted"), "security policy lacks clean-break configuration policy")
  invariant(security.includes("An already-current application is a no-write, no-backup operation"), "security policy lacks guarded recipe application")
  invariant(reference.startsWith("# GuildControl MCP complete reference\n"), "complete reference heading is invalid")
  invariant(reference.includes("[Getting started and first verified read](getting-started.md)"), "complete reference lacks the getting-started link")
  invariant(reference.includes("[Safety and usability decisions](safety-usability.md)"), "complete reference lacks the safety-decision link")
  invariant(reference.includes("[Project overview](../README.md)"), "complete reference lacks the landing-page link")
  invariant(reference.includes("config replace ACTIVE_FILE CANDIDATE_FILE"), "complete reference lacks integrated configuration review")
  invariant(reference.includes("node dist/bin.js host detect"), "complete reference lacks opt-in host detection")
  invariant(safetyUsability.includes("### Why a strict user ID list still exists"), "safety decision record lacks mention-allowlist rationale")
  invariant(safetyUsability.includes('`notifications.userMentions: "reviewed"`'), "safety decision record lacks reviewed mention policy")
  invariant(safetyUsability.includes("## Reads retry safely; mutations do not"), "safety decision record lacks retry analysis")
  invariant(gettingStarted.startsWith("# Getting started: first verified Discord read\n"), "getting-started heading is invalid")
  invariant(limitations.startsWith("# Product boundaries and host compatibility\n"), "limitations guide heading is invalid")
  invariant(Buffer.byteLength(limitations) <= README_MAX_BYTES, "limitations guide must remain concise")
  for (const heading of LIMITATIONS_REQUIRED_HEADINGS) {
    invariant(limitations.includes(heading), `limitations guide is missing ${heading}`)
  }
  for (const required of [
    "operator-owned bot",
    "The connector's non-persistence claims",
    "the host's transcript and data policy remain part of the trust boundary",
    "`notifications/tools/list_changed`",
    "does not identify the human approver",
    "Shared bot, multi-tenant relay, public HTTP listener, or hosted control plane",
    "These are architectural boundaries, not a backlog promise",
    "strong contract evidence",
    "private interactive activation guide",
  ]) {
    invariant(limitations.includes(required), `limitations guide is missing ${required}`)
  }
  invariant(!/DISCORD_BOT_TOKEN\s*=\s*["']YOUR_DISCORD_BOT_TOKEN["']/.test(documentation), "documentation must not teach token literals in command history")
  for (const required of [
    "--npx",
    "list_channels",
    "Setup is the first-run readiness gate",
    "Show me the channels in Discord server YOUR_GUILD_ID using GuildControl MCP.",
    "## Recovery ladder",
    "dist/index.js",
    "environment.forward",
    "host --npx --config ./guildcontrol.json --html ./guildcontrol-host-activation.html",
    "release-exact credential-free guided tour",
  ]) {
    invariant(gettingStarted.includes(required), `getting-started guide is missing ${required}`)
  }
  invariant(readme.includes("[Get a verified read](docs/getting-started.md)"), "README lacks the getting-started route")
  invariant(readme.includes("[Switch from another MCP](docs/migration.md)"), "README lacks the migration route")
  invariant(readme.includes("[Fit and boundaries](docs/limitations.md)"), "README lacks the product-boundaries route")
  invariant(readme.includes("[Field comparison](docs/comparison.md)"), "README lacks the field-comparison route")
  invariant(comparison.startsWith("# GuildControl MCP field comparison\n"), "field comparison heading is invalid")
  for (const required of [
    "## How to read the matrix",
    "## Head-to-head matrix",
    "## Narrower competitor leads and product gaps",
    "## Why each lead is material",
    "## Soundboard playback head-to-head",
    "## Bot-installation drift head-to-head",
    "## Host configuration drift head-to-head",
    "## Migration planning head-to-head",
    "## Audited releases and source limits",
    "## Registry matches outside the scored local comparison",
    "## Maintenance rule",
    "Not demonstrated",
    "Different fit",
    "Not auditable",
    "official Registry's complete current Discord search",
    "captioned live walkthrough",
    "credential-free offline tour bound to required negotiated prompts, tools, and access stages",
  ]) {
    invariant(comparison.includes(required), `field comparison is missing ${required}`)
  }
  const comparisonMatrix = comparison
    .split("## Head-to-head matrix\n", 2)[1]
    ?.split("\n## Narrower competitor leads and product gaps", 1)[0]
  invariant(comparisonMatrix !== undefined, "field comparison matrix cannot be parsed")
  const comparisonRows = comparisonMatrix
    .split("\n")
    .filter((line) => line.startsWith("| "))
  invariant(comparisonRows.length > 2, "field comparison has no scored outcomes")
  invariant(
    comparisonRows[0]?.startsWith("| Aggregate operator outcome | GuildControl MCP |"),
    "field comparison has an invalid header",
  )
  invariant(
    /^\|(?: --- \|)+$/u.test(comparisonRows[1] ?? ""),
    "field comparison has an invalid separator",
  )
  invariant(
    comparisonRows.slice(2).every((row) => row.split("|")[2]?.trim() === "**Lead**"),
    "field comparison contains an outcome GuildControl MCP does not lead",
  )
  const comparisonLines = comparison.split("\n")
  const sourceHeadSectionStart = comparisonLines.indexOf(
    "## Broader unregistered field scan",
  )
  const sourceHeadSectionEnd = comparisonLines.indexOf(
    "## Audited releases and source limits",
  )
  invariant(
    sourceHeadSectionStart >= 0 && sourceHeadSectionEnd > sourceHeadSectionStart,
    "field comparison source-head section cannot be parsed",
  )
  let scoredComparisonTables = 0
  let sourceHeadComparisonTables = 0
  const missingNarrowCompetitorLeadOutcomes = new Set(NARROW_COMPETITOR_LEAD_OUTCOMES)
  for (let index = 0; index < comparisonLines.length; index += 1) {
    const header = comparisonLines[index]
      ?.split("|")
      .slice(1, -1)
      .map((cell) => cell.trim())
    if (header?.[1] !== "GuildControl MCP") continue
    const sourceHeadComparison = index > sourceHeadSectionStart
      && index < sourceHeadSectionEnd
    if (sourceHeadComparison) sourceHeadComparisonTables += 1
    else scoredComparisonTables += 1
    const separator = comparisonLines[index + 1]
      ?.split("|")
      .slice(1, -1)
      .map((cell) => cell.trim())
    invariant(
      separator?.length === header.length
      && separator.every((cell) => /^---$/u.test(cell)),
      `field comparison table ${header[0]} has an invalid separator`,
    )
    let scoredRows = 0
    for (let rowIndex = index + 2; rowIndex < comparisonLines.length; rowIndex += 1) {
      const line = comparisonLines[rowIndex]
      if (!line?.startsWith("| ")) break
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim())
      const outcome = cells[0] ?? ""
      const guildControlLeads = cells[1]?.startsWith("**Lead") ?? false
      const competitorLeads = cells.slice(2).some((cell) => cell.startsWith("**Lead"))
      const declaredCompetitorLead = missingNarrowCompetitorLeadOutcomes.has(outcome)
      if (declaredCompetitorLead) {
        invariant(
          !guildControlLeads && competitorLeads,
          `field comparison table ${header[0]} does not preserve declared competitor lead ${outcome}`,
        )
        missingNarrowCompetitorLeadOutcomes.delete(outcome)
      } else {
        invariant(
          guildControlLeads,
          `field comparison table ${header[0]} contains an undeclared row GuildControl MCP does not lead`,
        )
      }
      scoredRows += 1
    }
    invariant(scoredRows > 0, `field comparison table ${header[0]} has no scored rows`)
  }
  invariant(
    scoredComparisonTables > 1,
    "field comparison lacks focused head-to-head tables",
  )
  invariant(
    sourceHeadComparisonTables > 0,
    "field comparison lacks focused source-head tables",
  )
  invariant(
    missingNarrowCompetitorLeadOutcomes.size === 0,
    `field comparison lacks declared competitor leads: ${[...missingNarrowCompetitorLeadOutcomes].join(", ")}`,
  )
  invariant(migration.startsWith("# Migrate from another Discord MCP\n"), "migration guide heading is invalid")
  for (const required of [
    "## Supported source releases",
    "guildctl migrate list",
    "guildctl migrate plan cappyeo@0.26.0",
    "## Read the dispositions correctly",
    "## Follow the staged path",
    "## Configuration remains a clean break",
    "## Privacy and custody",
    "## What the plan cannot prove",
    "## Troubleshooting",
    "supported`, `review-required`, or `intentionally-excluded",
    "reads no source file",
    "rewrite prompts or arguments",
  ]) {
    invariant(migration.includes(required), `migration guide is missing ${required}`)
  }
  invariant(gettingStarted.includes("[product boundaries and host compatibility](limitations.md)"), "getting-started guide lacks the product-boundaries route")
  invariant(gettingStarted.includes("`adapterCatalog`"), "getting-started guide lacks the complete host adapter output")
  invariant(gettingStarted.includes("`${input:guildcontrol-credential-1}`"), "getting-started guide lacks secure VS Code activation")
  invariant(gettingStarted.includes("--inspect-host-file"), "getting-started guide lacks exact host drift inspection")
  invariant(gettingStarted.includes("host plan"), "getting-started guide lacks reviewed host planning")
  invariant(gettingStarted.includes("host apply"), "getting-started guide lacks reviewed host application")
  invariant(gettingStarted.includes("`--standard-runtime`"), "getting-started guide lacks the standard-runtime recovery choice")
  invariant(gettingStarted.includes("bundle supports macOS, Windows, and Linux with Node.js 22 through 26"), "getting-started guide lacks the exact MCPB runtime range")
  invariant(reference.includes("[Product boundaries and host compatibility](limitations.md)"), "complete reference lacks the product-boundaries route")
  invariant(reference.includes("public CLI launcher is `dist/bin.js`"), "complete reference lacks the public package launcher")
  invariant(reference.includes("V8's `--lite-mode`"), "complete reference lacks the low-memory runtime contract")
  invariant(reference.includes("cross-platform manifest requires Node.js 22 through 26"), "complete reference lacks the exact MCPB runtime range")
  invariant(reference.includes("bundle verification rejects any other stderr"), "complete reference lacks the MCPB warning boundary")
  invariant(reference.includes("The `host` generation form requires one explicit `--config FILE` or `--profile NAME`"), "complete reference lacks the host activation contract")
  invariant(reference.includes("`guildcontrol.host-adapters.v1`"), "complete reference lacks verified host adapters")
  invariant(reference.includes("### Reviewed host configuration installation"), "complete reference lacks reviewed host installation")
  invariant(reference.includes("`guildcontrol.host-change-plan.v1`"), "complete reference lacks the host change-plan contract")
  invariant(reference.includes("`guildcontrol.host-change-apply.v1`"), "complete reference lacks the host change-apply contract")
  invariant(reference.includes("### Host configuration drift inspection"), "complete reference lacks host drift inspection")
  invariant(security.includes("## Host configuration inspection"), "security policy lacks host inspection requirements")
  invariant(security.includes("## Reviewed host configuration installation"), "security policy lacks host installation requirements")
  invariant(limitations.includes("Generated adapter"), "product boundaries lack adapter-specific compatibility")
  invariant(limitations.includes("`--inspect-host-file FILE`"), "product boundaries lack host inspection limits")
  invariant(limitations.includes("`host plan --adapter ID --host-file FILE`"), "product boundaries lack host installation planning")
  invariant(limitations.includes("Native-process memory parity"), "product boundaries lack the native-memory limitation")
  invariant(readme.includes("deterministic adapters for Claude Code, Codex, Cursor, VS Code, Gemini CLI, and common MCP JSON"), "README lacks verified host adapter discovery")
  invariant(readme.includes("`host plan` and `host apply`"), "README lacks reviewed host installation")
  invariant(comparison.includes("A `Lead` classification applies only to its row"), "field comparison lacks its scoped classification claim")
  invariant(comparison.includes("while focused rows below identify narrower tasks where a competitor leads"), "field comparison lacks its competitor-lead qualification")
  invariant(comparison.includes("one deterministic MCPB for macOS, Windows, or Linux"), "field comparison lacks the cross-platform one-click outcome")
  invariant(comparison.includes("executes the unpacked server handshake"), "field comparison lacks bundle execution evidence")
  invariant(comparison.includes("Optional host discovery plus reviewed configuration installation, drift inspection, and recovery"), "field comparison lacks usable reviewed host installation")
  invariant(reference.includes("[release runbook](releasing.md)"), "complete reference release link is invalid")
  invariant(readme.includes("[CONTRIBUTING.md](CONTRIBUTING.md)"), "README lacks the contributor guide link")
  invariant(readme.includes("[SUPPORT.md](SUPPORT.md)"), "README lacks the support guide link")
  invariant(releasing.includes(`description exactly to \`${MCP_DESCRIPTION}\``), "release runbook lacks the canonical repository description")
  invariant(releasing.includes("exact model- and harness-neutral topic set"), "release runbook lacks the repository topic policy")
  assertEqual(
    releasing.match(/^npm publish .+$/gm) || [],
    [FIRST_PUBLICATION_COMMAND],
    "release runbook first-publication command must explicitly disable local automatic provenance",
  )
  for (const topic of [
    "ai-agents",
    "automation",
    "community-management",
    "discord",
    "discord-api",
    "discord-bot",
    "guildcontrol",
    "least-privilege",
    "mcp",
    "mcp-server",
    "model-context-protocol",
    "moderation",
    "security",
    "typescript",
  ]) {
    invariant(releasing.includes(`\`${topic}\``), `release runbook lacks the ${topic} repository topic`)
  }
  invariant(reference.length > readme.length, "complete reference must retain the detailed contract")
  for (const heading of REFERENCE_REQUIRED_HEADINGS) {
    invariant(reference.includes(heading), `complete reference is missing ${heading}`)
  }
}

async function checkCommunityFiles() {
  const contributing = await readFile(join(REPOSITORY_ROOT, "CONTRIBUTING.md"), "utf8")
  const conduct = await readFile(join(REPOSITORY_ROOT, "CODE_OF_CONDUCT.md"), "utf8")
  const privacy = await readFile(join(REPOSITORY_ROOT, "PRIVACY.md"), "utf8")
  const support = await readFile(join(REPOSITORY_ROOT, "SUPPORT.md"), "utf8")
  const issueDirectory = join(REPOSITORY_ROOT, ".github/ISSUE_TEMPLATE")
  const bugReport = await readFile(join(issueDirectory, "bug_report.yml"), "utf8")
  const featureRequest = await readFile(join(issueDirectory, "feature_request.yml"), "utf8")
  const operatorQuestion = await readFile(join(issueDirectory, "operator_question.yml"), "utf8")
  const verifiedOutcome = await readFile(join(issueDirectory, "verified_outcome.yml"), "utf8")
  const issueConfig = await readFile(join(issueDirectory, "config.yml"), "utf8")
  const pullRequest = await readFile(
    join(REPOSITORY_ROOT, ".github/pull_request_template.md"),
    "utf8",
  )
  const files = new Map([
    ["CONTRIBUTING.md", contributing],
    ["CODE_OF_CONDUCT.md", conduct],
    ["PRIVACY.md", privacy],
    ["SUPPORT.md", support],
    [".github/ISSUE_TEMPLATE/bug_report.yml", bugReport],
    [".github/ISSUE_TEMPLATE/feature_request.yml", featureRequest],
    [".github/ISSUE_TEMPLATE/operator_question.yml", operatorQuestion],
    [".github/ISSUE_TEMPLATE/verified_outcome.yml", verifiedOutcome],
    [".github/ISSUE_TEMPLATE/config.yml", issueConfig],
    [".github/pull_request_template.md", pullRequest],
  ])
  for (const [path, contents] of files) {
    invariant(contents.length > 0, `${path} must not be empty`)
    invariant(
      Buffer.byteLength(contents) <= COMMUNITY_FILE_MAX_BYTES,
      `${path} must remain concise`,
    )
  }
  invariant(contributing.startsWith("# Contributing\n"), "contributor guide heading is invalid")
  for (const required of [
    "Never include a bot token",
    "Do not publish Discord message content",
    "private GitHub Security Advisory",
    "npm run metadata:check",
    "npm run test:coverage",
    "One safety gate is never a reason to remove another",
    "AGPL-3.0-only license",
  ]) {
    invariant(contributing.includes(required), `contributor guide is missing ${required}`)
  }
  invariant(
    conduct.startsWith("# Contributor Covenant Code of Conduct\n"),
    "code of conduct heading is invalid",
  )
  for (const required of [
    "Publishing credentials, private Discord identifiers or content",
    "GitHub Support",
    "private GitHub Security Advisory",
  ]) {
    invariant(conduct.includes(required), `code of conduct is missing ${required}`)
  }
  invariant(support.startsWith("# Support\n"), "support guide heading is invalid")
  for (const required of [
    "do not operate a shared bot",
    "Start with offline evidence",
    "Share only privacy-safe evidence",
    "Never post a bot token",
    "verified-outcome form",
    "private GitHub Security Advisory",
    "no response-time guarantee",
    "guild-installation-drift",
    "guildctl migrate plan SOURCE --html PRIVATE_FILE",
  ]) {
    invariant(support.includes(required), `support guide is missing ${required}`)
  }
  invariant(support.includes("[product boundaries and host compatibility](docs/limitations.md)"), "support guide lacks the product-boundaries route")
  invariant(support.includes("guildctl host --npx --config FILE --html PRIVATE_FILE"), "support guide lacks private host activation recovery")
  invariant(support.includes("node dist/bin.js serve --config FILE"), "support guide lacks the public source launcher")
  invariant(support.includes("Node.js 22 through 26"), "support guide lacks the exact MCPB runtime range")
  invariant(privacy.startsWith("# Privacy policy\n"), "privacy policy heading is invalid")
  for (const required of [
    "## Credentials",
    "## Discord data",
    "## Local records and observability",
    "## Control and deletion",
    "does not provide a hosted service, shared bot, advertising, analytics",
    "does not print, persist, return, or include the token",
    "The connector does not independently retain message content",
    "The bot-installation audit reads",
    "Your MCP host, model provider, terminal, operating system, Discord",
  ]) {
    invariant(privacy.includes(required), `privacy policy is missing ${required}`)
  }
  for (const [name, form] of [
    ["bug report", bugReport],
    ["feature proposal", featureRequest],
    ["operator question", operatorQuestion],
    ["verified outcome", verifiedOutcome],
  ]) {
    invariant(form.startsWith("name: "), `${name} form heading is invalid`)
    invariant(form.includes("type: checkboxes"), `${name} form lacks its privacy acknowledgement`)
    invariant(form.includes("required: true"), `${name} form lacks required evidence`)
    invariant(!form.includes("type: upload"), `${name} form must not solicit file uploads`)
    invariant(
      !/^\s+id:\s*(?:token|credential|content|guild_id|channel_id|user_id|message_id)\s*$/imu.test(form),
      `${name} form requests prohibited private input`,
    )
  }
  invariant(bugReport.includes("Do not paste bot tokens"), "bug form lacks its credential warning")
  invariant(bugReport.includes("Minimal synthetic reproduction"), "bug form lacks synthetic reproduction guidance")
  invariant(featureRequest.includes("No Discord content"), "feature form lacks its privacy warning")
  invariant(featureRequest.includes("Freshness and failure safety"), "feature form lacks reviewed-write analysis")
  invariant(operatorQuestion.includes("Read SUPPORT.md and docs/limitations.md"), "operator form lacks its support and product-boundaries routes")
  invariant(operatorQuestion.includes("do not paste a configuration document"), "operator form lacks its configuration privacy boundary")
  invariant(operatorQuestion.includes("Exact question"), "operator form lacks a bounded question field")
  invariant(verifiedOutcome.includes("No Discord IDs"), "outcome form lacks its identifier privacy boundary")
  invariant(verifiedOutcome.includes("First friction point"), "outcome form lacks first-friction evidence")
  invariant(verifiedOutcome.includes("Repeat-use intent"), "outcome form lacks repeat-use evidence")
  invariant(verifiedOutcome.includes("Voluntary outcome reports never authorize"), "outcome form lacks its maintainer-authority boundary")
  invariant(issueConfig.startsWith("blank_issues_enabled: false\n"), "blank issues must remain disabled")
  invariant(issueConfig.includes(`${REPOSITORY_URL}/security/advisories/new`), "issue routing lacks private vulnerability reporting")
  invariant(issueConfig.includes(`${REPOSITORY_URL}/blob/main/docs/getting-started.md`), "issue routing lacks the getting-started guide")
  invariant(issueConfig.includes(`${REPOSITORY_URL}/blob/main/docs/limitations.md`), "issue routing lacks the product-boundaries guide")
  invariant(issueConfig.includes(`${REPOSITORY_URL}/blob/main/docs/reference.md`), "issue routing lacks the operator reference")
  invariant(pullRequest.startsWith("## Summary\n"), "pull-request template heading is invalid")
  for (const required of [
    "## Authority and privacy impact",
    "## Failure and recovery impact",
    "No bot token, bearer credential, Discord content",
    "Every write retains planning",
    "Dependencies and external actions remain minimal, exactly pinned, and justified",
  ]) {
    invariant(pullRequest.includes(required), `pull-request template is missing ${required}`)
  }
}

async function checkMcpbSource(packageJson) {
  const manifest = await readJson(join(REPOSITORY_ROOT, "mcpb", "manifest.json"))
  const reproducibleBuild = await readJson(
    join(REPOSITORY_ROOT, "mcpb", "reproducible-build.json"),
  )
  const sourceGuide = await readFile(join(REPOSITORY_ROOT, "mcpb", "README.md"), "utf8")
  const {
    MCPB_ARCHIVE_ENTRIES,
    mcpbArchiveName,
    validateMcpbManifest,
  } = await import("./mcpb-artifact.mjs")
  await validateMcpbManifest(manifest, packageJson)
  assertEqual(MCPB_ARCHIVE_ENTRIES, [
    "LICENSE",
    "PRIVACY.md",
    "README.md",
    "SECURITY.md",
    "SUPPORT.md",
    "docs/comparison.md",
    "docs/getting-started.md",
    "docs/limitations.md",
    "docs/migration.md",
    "docs/reference.md",
    "docs/releasing.md",
    "docs/safety-usability.md",
    "icon.png",
    "manifest.json",
    "server/THIRD_PARTY_NOTICES.md",
    "server/catalog-evidence.json",
    "server/guildcontrol.mjs",
    "server/guildcontrol.mjs.LEGAL.txt",
    "server/sbom.spdx.json",
  ], "MCPB archive allowlist is invalid")
  invariant(
    mcpbArchiveName(packageJson.version) === `guildcontrol-${packageJson.version}.mcpb`,
    "MCPB archive name is invalid",
  )
  assertEqual(Object.keys(reproducibleBuild), ["sourceDateEpoch"], "MCPB reproducible build metadata is invalid")
  invariant(
    Number.isSafeInteger(reproducibleBuild.sourceDateEpoch)
      && reproducibleBuild.sourceDateEpoch >= 315_532_800,
    "MCPB reproducible build epoch is invalid",
  )
  const sourceDate = new Date(reproducibleBuild.sourceDateEpoch * 1_000)
  invariant(
    Number.isFinite(sourceDate.valueOf())
      && sourceDate.getUTCHours() === 0
      && sourceDate.getUTCMinutes() === 0
      && sourceDate.getUTCSeconds() === 0,
    "MCPB reproducible build epoch must select a UTC day boundary",
  )
  invariant(sourceGuide.startsWith("# MCPB source contract\n"), "MCPB source guide heading is invalid")
  invariant(sourceGuide.includes("modelcontextprotocol/mcpb/blob/v2.1.2"), "MCPB source guide lacks the pinned official schema source")
  invariant(sourceGuide.includes("model-neutral projection"), "MCPB source guide lacks its neutrality boundary")
}

async function checkRegistryManifest(packageJson) {
  const server = await readJson(join(REPOSITORY_ROOT, "server.json"))
  invariant(server.$schema === REGISTRY_SCHEMA, "registry manifest schema is invalid")
  invariant(server.name === MCP_NAME, "registry server name is invalid")
  invariant(server.title === MCP_TITLE, "registry server title is invalid")
  invariant(server.version === packageJson.version, "registry server version is out of sync")
  invariant(server.description === MCP_DESCRIPTION, "registry description is invalid")
  invariant(server.description.length <= 100, "registry description must contain at most 100 characters")
  assertEqual(server.repository, {
    id: REPOSITORY_ID,
    source: "github",
    url: REPOSITORY_URL,
  }, "registry repository identity is invalid")
  invariant(server.websiteUrl === DOCUMENTATION_URL, "registry website is invalid")
  invariant(server.icons?.length === 1, "registry manifest must declare one project icon")
  const icon = server.icons[0]
  invariant(icon.src === `https://raw.githubusercontent.com/j-256/guildcontrol/v${packageJson.version}/assets/guildcontrol-icon.png`, "registry icon URL must use the exact release tag")
  invariant(icon.mimeType === ICON_MIME_TYPE, "registry icon media type is invalid")
  const iconBytes = await readFile(join(REPOSITORY_ROOT, "assets/guildcontrol-icon.png"))
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  invariant(iconBytes.subarray(0, pngSignature.length).equals(pngSignature), "project icon is not a PNG")
  invariant(sha256(iconBytes) === ICON_SHA256, "project icon checksum changed")
  const iconSize = `${iconBytes.readUInt32BE(16)}x${iconBytes.readUInt32BE(20)}`
  invariant(iconSize === ICON_SIZE, "project icon dimensions changed")
  assertEqual(icon.sizes, [iconSize], "registry icon size does not match the PNG")

  invariant(server.packages?.length === 3, "registry manifest must declare npm, OCI, and MCPB packages")
  assertEqual(server.packages.map(({ registryType }) => registryType), ["npm", "oci", "mcpb"], "registry package order is invalid")
  const npmPackage = server.packages[0]
  invariant(npmPackage.registryType === "npm", "npm registry package type is invalid")
  invariant(npmPackage.registryBaseUrl === NPM_REGISTRY, "npm registry package origin is invalid")
  invariant(npmPackage.identifier === packageJson.name, "npm registry package name is out of sync")
  invariant(npmPackage.version === packageJson.version, "npm registry package version is out of sync")
  invariant(npmPackage.runtimeHint === "npx", "npm registry runtime hint is invalid")
  assertEqual(npmPackage.transport, { type: "stdio" }, "npm registry transport must remain stdio")
  assertEqual(npmPackage.packageArguments, NPM_PACKAGE_ARGUMENTS, "npm package arguments are invalid")
  invariant(npmPackage.runtimeArguments === undefined, "npm package must not declare runtime arguments")
  const ociPackage = server.packages[1]
  invariant(ociPackage.registryType === "oci", "OCI registry package type is invalid")
  invariant(ociPackage.identifier === `${OCI_IMAGE_NAME}:${packageJson.version}`, "OCI image reference is out of sync")
  invariant(ociPackage.runtimeHint === "docker", "OCI registry runtime hint is invalid")
  assertEqual(ociPackage.transport, { type: "stdio" }, "OCI registry transport must remain stdio")
  assertEqual(ociPackage.packageArguments, OCI_PACKAGE_ARGUMENTS, "OCI package arguments are invalid")
  assertEqual(ociPackage.runtimeArguments, OCI_RUNTIME_ARGUMENTS, "OCI runtime arguments are invalid")
  for (const forbidden of ["fileSha256", "registryBaseUrl", "version"]) {
    invariant(ociPackage[forbidden] === undefined, `OCI registry package must omit ${forbidden}`)
  }
  const mcpbPackage = server.packages[2]
  invariant(mcpbPackage.registryType === "mcpb", "MCPB registry package type is invalid")
  invariant(
    mcpbPackage.identifier === `https://github.com/j-256/guildcontrol/releases/download/v${packageJson.version}/guildcontrol-${packageJson.version}.mcpb`,
    "MCPB registry package URL is out of sync",
  )
  invariant(/^[0-9a-f]{64}$/.test(mcpbPackage.fileSha256), "MCPB registry package digest is invalid")
  assertEqual(mcpbPackage.transport, { type: "stdio" }, "MCPB registry transport must remain stdio")
  for (const forbidden of [
    "environmentVariables",
    "packageArguments",
    "registryBaseUrl",
    "runtimeArguments",
    "runtimeHint",
    "version",
  ]) {
    invariant(mcpbPackage[forbidden] === undefined, `MCPB registry package must omit ${forbidden}`)
  }
  assertEqual(npmPackage.environmentVariables, [REGISTRY_TOKEN_INPUT], "npm registry inputs are invalid")
  assertEqual(ociPackage.environmentVariables, [REGISTRY_TOKEN_INPUT], "OCI registry inputs are invalid")
}

async function checkContainerSource(packageJson) {
  const dockerfile = await readFile(join(REPOSITORY_ROOT, "Dockerfile"), "utf8")
  const dockerignore = await readFile(join(REPOSITORY_ROOT, ".dockerignore"), "utf8")
  invariant(
    dockerfile.startsWith(`ARG NODE_IMAGE=${NODE_IMAGE}\n`),
    "Dockerfile base image is not pinned to the reviewed digest",
  )
  invariant((dockerfile.match(/FROM \$\{NODE_IMAGE\}/g) || []).length === 2, "every container stage must use the pinned base")
  for (const required of [
    "npm ci --ignore-scripts",
    "npm prune --omit=dev --ignore-scripts",
    `ARG VERSION=${packageJson.version}`,
    "ARG REVISION=local",
    `org.opencontainers.image.url="${DOCUMENTATION_URL}"`,
    "org.opencontainers.image.documentation=\"https://github.com/j-256/guildcontrol/blob/v${VERSION}/README.md\"",
    "org.opencontainers.image.licenses=\"AGPL-3.0-only\"",
    "io.modelcontextprotocol.server.name=\"app.lasers.guildcontrol/discord\"",
    "ENV NODE_ENV=production",
    "COPY --from=build --chown=node:node /app/dist ./dist",
    "COPY --from=build --chown=node:node /app/node_modules ./node_modules",
    "COPY --chown=node:node README.md PRIVACY.md SECURITY.md SUPPORT.md ./",
    "COPY --chown=node:node docs/comparison.md docs/getting-started.md docs/limitations.md docs/migration.md docs/reference.md docs/releasing.md docs/safety-usability.md ./docs/",
    "USER node",
    "ENTRYPOINT [\"node\", \"--no-expose-wasm\", \"--lite-mode\", \"dist/cli.js\"]",
    "CMD [\"catalog\"]",
  ]) {
    invariant(dockerfile.includes(required), `Dockerfile is missing ${required}`)
  }
  invariant(!/(?:DISCORD|OTEL)_[A-Z0-9_]+\s*=/.test(dockerfile), "Dockerfile must not declare connector configuration")
  assertEqual(
    dockerignore.split("\n").filter(Boolean),
    [
      "**",
      "!.dockerignore",
      "!.npmrc",
      "!Dockerfile",
      "!LICENSE",
      "!PRIVACY.md",
      "!README.md",
      "!SECURITY.md",
      "!SUPPORT.md",
      "!docs",
      "!docs/comparison.md",
      "!docs/getting-started.md",
      "!docs/limitations.md",
      "!docs/migration.md",
      "!docs/reference.md",
      "!docs/releasing.md",
      "!docs/safety-usability.md",
      "!package-lock.json",
      "!package.json",
      "!src",
      "!src/**",
      "!tsconfig.build.json",
      "!tsconfig.json",
    ],
    "container build context allowlist changed",
  )
}

async function checkAutomation(packageJson) {
  const npmConfiguration = await readFile(join(REPOSITORY_ROOT, ".npmrc"), "utf8")
  invariant(npmConfiguration === NPM_CONFIGURATION, "project npm registry configuration is invalid")
  const releaseCheck = await readFile(join(REPOSITORY_ROOT, "scripts/release-check.mjs"), "utf8")
  for (const required of [
    'import { BUILDKIT_IMAGE } from "./oci-registry.mjs"',
    'const SHARED_TEMP_DIRECTORY = await mkdtemp(join(REPOSITORY_ROOT, ".release-tmp-"))',
    'const SBOM_OUTPUT = join(SHARED_TEMP_DIRECTORY, "sbom.spdx.json")',
    'TMPDIR: SHARED_TEMP_DIRECTORY',
    '"buildx",',
    '"create",',
    '"docker-container",',
    '`image=${BUILDKIT_IMAGE}`',
    'BUILDX_BUILDER: builderName',
    '["buildx", "rm", builderName]',
    'await rm(SHARED_TEMP_DIRECTORY, { force: true, recursive: true })',
  ]) {
    invariant(releaseCheck.includes(required), `local release check is missing ${required}`)
  }
  invariant(!releaseCheck.includes("colima"), "local release check must use the active Docker context")
  const workflowsDirectory = join(REPOSITORY_ROOT, ".github/workflows")
  const workflowNames = (await readdir(workflowsDirectory)).filter((name) => name.endsWith(".yml")).sort()
  assertEqual(workflowNames, ["ci.yml", "codeql.yml", "release.yml"], "workflow catalog is invalid")
  for (const name of workflowNames) {
    const workflow = await readFile(join(workflowsDirectory, name), "utf8")
    invariant(!workflow.includes("pull_request_target:"), `${name} must not use pull_request_target`)
    const useLines = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^@\s]+)@([^\s#]+)/gm)]
    for (const [, action, reference] of useLines) {
      invariant(EXPECTED_ACTION_PINS.has(action), `${name} uses unreviewed action ${action}`)
      invariant(FULL_COMMIT_SHA.test(reference), `${name} must pin ${action} to a full commit SHA`)
      invariant(reference === EXPECTED_ACTION_PINS.get(action), `${name} uses an unreviewed commit for ${action}`)
    }
    const externalUseCount = (workflow.match(/^\s*(?:-\s*)?uses:\s*[^.]/gm) || []).length
    invariant(useLines.length === externalUseCount, `${name} contains an unparsable external action reference`)
    const checkoutCount = useLines.filter(([, action]) => action === "actions/checkout").length
    const credentialGuards = (workflow.match(/persist-credentials:\s*false/g) || []).length
    invariant(credentialGuards >= checkoutCount, `${name} must disable persisted checkout credentials`)
  }
  const release = await readFile(join(workflowsDirectory, "release.yml"), "utf8")
  for (const required of [
    "environment: release",
    "environment: release-credentials",
    "candidate",
    "stage",
    "promote",
    "image",
    "github-release-recovery",
    "evidence_run_id",
    "Require a clean first-publication candidate",
    "Verify promotion prerequisites",
    "Reverify exact staged npm evidence",
    "Authorize the exact stable tag",
    "Authorize the exact recovery tag",
    "npm stage publish",
    "--provenance",
    "test \"$(node --version)\" = \"v24.19.0\"",
    "test \"$(npm --version)\" = \"11.17.0\"",
    "package-manager-cache: false",
    "registry-url: https://registry.npmjs.org",
    "refs/tags/$RELEASE_TAG",
    "Verify versioned public icon",
    "Verify exact public documentation",
    "scripts/check-public-documentation.mjs",
    "cmp assets/guildcontrol-icon.png",
    "--proto-redir '=https'",
    "mcp-publisher_linux_amd64.tar.gz",
    "test \"$(uname -m)\" = \"x86_64\"",
    "mcp-publisher 1.8.1 ",
    "Attest catalog evidence",
    "Attest reproducible MCPB",
    "Attest MCPB SPDX SBOM",
    "Attest exact OCI image provenance",
    "Verify exact public promotion before Registry authentication",
    "Authenticate the product DNS namespace",
    "MCP_REGISTRY_DNS_PRIVATE_KEY",
    "app.lasers.guildcontrol/discord",
    "guildcontrol.lasers.app",
    "login dns",
    "-algorithm ed25519",
    "Verify exact tag and prepare immutable release evidence",
    "Verify protected recovery provenance",
    "Verify recovered artifact attestations",
    "Select exact GitHub Release verifier",
    "Retain recovery source verification",
    ".release-recovery-control/scripts/github-release.mjs verify-recovery-run",
    "GITHUB_RELEASE_VERIFIER",
    "Create an absent release as an editable draft",
    "Reconcile and verify the editable draft",
    "Publish the exact draft immutably",
    "Verify immutable release and every public asset",
    "Retain immutable GitHub Release verification",
    "scripts/github-release.mjs prepare",
    "scripts/github-release.mjs verify",
    "scripts/github-release.mjs verify-recovery-run",
    "node \"$GITHUB_RELEASE_VERIFIER\" inspect",
    "node \"$GITHUB_RELEASE_VERIFIER\" verify",
    "gh release create",
    "gh release upload",
    "gh release verify",
    "gh release verify-asset",
    "SHA256SUMS",
    "release-notes.md",
    `GITHUB_CLI_SHA256: ${GITHUB_CLI_SHA256}`,
    `GITHUB_CLI_VERSION: ${GITHUB_CLI_VERSION}`,
    "gh_${GITHUB_CLI_VERSION}_linux_amd64.tar.gz",
    "subject-name: ${{ steps.release.outputs.image_name }}",
    "catalog-evidence.json",
    "guildcontrol-${RELEASE_TAG#v}.mcpb",
    "guildctl-${RELEASE_TAG#v}.tgz",
    "container-evidence.json",
    "ghcr.io/j-256/guildcontrol:$version",
    "linux/amd64,linux/arm64",
    `index:org.opencontainers.image.description=${MCP_DESCRIPTION}`,
    "npm run container:verify",
    "npm run container:index:verify",
    "--expect-oci matching",
    "provenance: mode=max",
    `sbom: generator=${SBOM_GENERATOR_IMAGE}`,
    "--bundle-from-oci",
    "matching-or-migration",
    "v1.8.1",
    "a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc",
  ]) {
    invariant(release.includes(required), `release workflow is missing ${required}`)
  }
  for (const forbidden of [
    "NPM_BOOTSTRAP_TOKEN",
    "NODE_AUTH_TOKEN",
    "_authToken",
    "operation == 'bootstrap'",
    'npm publish "$TARBALL"',
    "guildcontrol-${RELEASE_TAG#v}.tgz",
    "login github-oidc",
    "secrets.NPM_TOKEN",
  ]) {
    invariant(!release.includes(forbidden), `release workflow contains forbidden first-publication automation ${forbidden}`)
  }
  const ci = await readFile(join(workflowsDirectory, "ci.yml"), "utf8")
  invariant(
    /if:\s*\$\{\{\s*matrix\.node == '24'\s*\}\}\s*\n\s*run:\s*npm run test:coverage/u.test(ci),
    "CI must enforce coverage thresholds on Node 24",
  )
  invariant(
    /if:\s*\$\{\{\s*matrix\.node != '24'\s*\}\}\s*\n\s*run:\s*npm test/u.test(ci),
    "CI must retain ordinary compatibility tests outside Node 24",
  )
  for (const pinnedImage of [BINFMT_IMAGE, BUILDKIT_IMAGE]) {
    invariant(release.includes(pinnedImage), `release workflow does not pin ${pinnedImage}`)
    invariant(ci.includes(pinnedImage), `CI workflow does not pin ${pinnedImage}`)
  }
  const ociLayoutVerifier = await readFile(join(REPOSITORY_ROOT, "scripts/verify-oci-layout.mjs"), "utf8")
  const ociRegistry = await readFile(join(REPOSITORY_ROOT, "scripts/oci-registry.mjs"), "utf8")
  const githubReleaseHelper = await readFile(join(REPOSITORY_ROOT, "scripts/github-release.mjs"), "utf8")
  const mcpbBuilder = await readFile(join(REPOSITORY_ROOT, "scripts/build-mcpb.mjs"), "utf8")
  const publishedArtifactChecker = await readFile(join(REPOSITORY_ROOT, "scripts/check-published-artifacts.mjs"), "utf8")
  invariant(release.includes(SBOM_GENERATOR_IMAGE), "release workflow does not pin its SBOM generator")
  invariant(ociRegistry.includes(SBOM_GENERATOR_IMAGE), "OCI utilities do not pin their SBOM generator")
  invariant(ociLayoutVerifier.includes("SBOM_GENERATOR_IMAGE"), "OCI preflight does not use the pinned SBOM generator")
  invariant(!githubReleaseHelper.includes("/immutable-releases"), "GitHub Release automation must not require unavailable repository administration authority")
  invariant(mcpbBuilder.includes("MCPB artifact digest differs from server.json"), "MCPB builder must bind output to Registry metadata")
  invariant(mcpbBuilder.includes("--allow-registry-mismatch"), "MCPB builder lacks the explicit release-preparation escape hatch")
  for (const migrationBoundary of [
    'fromName: "io.github.j-256/guildcontrol"',
    'fromVersion: "0.3.0"',
    `toName: "${MCP_NAME}"`,
    `toVersion: "${packageJson.version}"`,
    '"matching-or-migration"',
  ]) {
    invariant(publishedArtifactChecker.includes(migrationBoundary), `npm identity migration is missing ${migrationBoundary}`)
  }
  const mcpbCompileStep = mcpbBuilder.indexOf("await run(process.execPath, [TYPESCRIPT_COMPILER")
  const mcpbArtifactStep = mcpbBuilder.indexOf("await buildAndVerifyMcpb(options)")
  invariant(
    mcpbCompileStep >= 0 && mcpbCompileStep < mcpbArtifactStep,
    "MCPB builder must compile the current source before producing evidence",
  )
  for (const workflowName of ["ci.yml", "release.yml"]) {
    const workflow = await readFile(join(workflowsDirectory, workflowName), "utf8")
    invariant(workflow.includes("NPM_CONFIG_REGISTRY: https://registry.npmjs.org"), `${workflowName} must pin the npm registry`)
    invariant(workflow.includes("NPM_CONFIG_REPLACE_REGISTRY_HOST: never"), `${workflowName} must preserve lockfile registry origins`)
  }
  invariant((release.match(/uses: actions\/attest@/g) || []).length === 6, "release workflow must attest package, MCPB, catalog, and image evidence")
  invariant((release.match(/name: Verify exact public documentation/g) || []).length === 2, "every release path must verify public documentation")
  invariant((release.match(/node scripts\/check-public-documentation\.mjs/g) || []).length === 2, "every release path must run the public documentation verifier")
  const releaseDocumentationCheck = release.indexOf("name: Verify exact public documentation")
  const imageJobStart = release.indexOf("\n  image:")
  const imageDocumentationCheck = release.indexOf("name: Verify exact public documentation", imageJobStart)
  invariant(
    releaseDocumentationCheck > 0 && releaseDocumentationCheck < release.indexOf("npm stage publish"),
    "non-image releases must verify documentation before publication",
  )
  invariant(
    imageDocumentationCheck > imageJobStart && imageDocumentationCheck < release.indexOf("uses: docker/login-action", imageJobStart),
    "image releases must verify documentation before registry authentication",
  )
  invariant((release.match(/artifact-metadata: write/g) || []).length === 1, "only file attestations may write artifact metadata")
  invariant(release.includes("create-storage-record: false"), "personal image attestation must disable unsupported storage records")
  invariant((release.match(/packages: write/g) || []).length === 1, "only the image release job may write packages")
  invariant((release.match(/packages: read/g) || []).length === 1, "only release preflight may use read-only package access")
  invariant((release.match(/contents: write/g) || []).length === 1, "only the immutable GitHub Release job may write repository contents")
  invariant((release.match(/actions: read/g) || []).length === 3, "only npm staging, GitHub Release, and Registry jobs may read retained workflow evidence")
  invariant((release.match(/attestations: read/g) || []).length === 1, "only the immutable GitHub Release job may use read-only attestation authority")
  invariant((release.match(/^    environment: release$/gm) || []).length === 3, "normal npm, promotion, and recovery approvals must remain separate explicit gates")
  invariant((release.match(/^    environment: release-credentials$/gm) || []).length === 1, "only Registry publication may receive the DNS credential environment")
  invariant((release.match(/secrets\.MCP_REGISTRY_DNS_PRIVATE_KEY/g) || []).length === 1, "only one Registry authentication step may receive the DNS private key")
  invariant((release.match(/id-token: write/g) || []).length === 3, "only preflight attestations, npm staging, and image publication may mint OIDC tokens")
  invariant((release.match(/name: Install verified GitHub CLI/g) || []).length === 2, "every GitHub CLI consumer must install the reviewed binary")
  const preflightStart = release.indexOf("\n  preflight:")
  const stageStart = release.indexOf("\n  stage:", preflightStart)
  const promotionApprovalStart = release.indexOf("\n  promotion_approval:", stageStart)
  const recoveryApprovalStart = release.indexOf("\n  recovery_approval:", promotionApprovalStart)
  const githubReleaseStart = release.indexOf("\n  github_release:")
  const githubReleaseEnd = release.indexOf("\n  image:", githubReleaseStart)
  const registryStart = release.indexOf("\n  registry:", githubReleaseEnd)
  invariant(
    preflightStart > 0
      && stageStart > preflightStart
      && promotionApprovalStart > stageStart
      && recoveryApprovalStart > promotionApprovalStart
      && githubReleaseStart > recoveryApprovalStart
      && githubReleaseEnd > githubReleaseStart
      && registryStart > githubReleaseEnd,
    "release job boundaries are invalid",
  )
  const preflightJob = release.slice(preflightStart, stageStart)
  const stageJob = release.slice(stageStart, promotionApprovalStart)
  const promotionApprovalJob = release.slice(promotionApprovalStart, recoveryApprovalStart)
  const recoveryApprovalJob = release.slice(recoveryApprovalStart, githubReleaseStart)
  const githubReleaseJob = release.slice(githubReleaseStart, githubReleaseEnd)
  const imageJob = release.slice(githubReleaseEnd, registryStart)
  const registryJob = release.slice(registryStart)
  for (const required of [
    "artifact-metadata: write",
    "attestations: write",
    "contents: read",
    "id-token: write",
    "packages: read",
    "release-evidence-${{ inputs.operation }}-${{ inputs.tag }}",
    "Verify promotion prerequisites",
  ]) {
    invariant(preflightJob.includes(required), `release preflight job is missing ${required}`)
  }
  invariant(!preflightJob.includes("environment:"), "release preflight must not require an operator approval")
  for (const required of [
    "needs: preflight",
    "environment: release",
    "actions: read",
    "contents: read",
    "id-token: write",
    "release-evidence-stage-${{ inputs.tag }}",
    "matching-or-migration",
    "npm stage publish",
  ]) {
    invariant(stageJob.includes(required), `npm staging job is missing ${required}`)
  }
  for (const [job, label] of [
    [promotionApprovalJob, "promotion approval"],
    [recoveryApprovalJob, "recovery approval"],
  ]) {
    invariant(job.includes("environment: release"), `${label} job lacks protected review`)
    invariant(job.includes("permissions: {}"), `${label} job must not receive repository authority`)
  }
  invariant(promotionApprovalJob.includes("needs: preflight"), "promotion approval must follow exact preflight evidence")
  for (const required of [
    "- image",
    "- promotion_approval",
    "- recovery_approval",
    "actions: read",
    "attestations: read",
    "contents: write",
    "--expect-package matching",
    "--expect-npm matching",
    "--expect-oci matching",
    "--expect-registry missing-or-matching",
    "--expect draft",
    "--expect immutable",
    "--draft=false",
    "--verify-tag",
    "--clobber",
    "release-notes.md",
    "sha256sum -c SHA256SUMS",
  ]) {
    invariant(githubReleaseJob.includes(required), `immutable GitHub Release job is missing ${required}`)
  }
  for (const forbidden of [
    "environment:",
    "attestations: write",
    "artifact-metadata: write",
    "id-token: write",
    "packages: read",
    "packages: write",
    "administration:",
    "secrets.",
    "gh release delete",
    "gh release delete-asset",
  ]) {
    invariant(!githubReleaseJob.includes(forbidden), `immutable GitHub Release job contains forbidden authority ${forbidden}`)
  }
  for (const required of [
    "- preflight",
    "- promotion_approval",
    "packages: write",
    "attestations: write",
    "id-token: write",
    "--expect-registry missing-or-matching",
  ]) {
    invariant(imageJob.includes(required), `image publication job is missing ${required}`)
  }
  invariant(!imageJob.includes("environment:"), "image publication must reuse the promotion approval dependency")
  for (const required of [
    "- github_release",
    "- image",
    "- promotion_approval",
    "environment: release-credentials",
    "actions: read",
    "contents: read",
    "release-evidence-promote-${{ inputs.tag }}",
    "Verify exact public promotion before Registry authentication",
    "--expect immutable",
    "secrets.MCP_REGISTRY_DNS_PRIVATE_KEY",
    "login dns",
    "-algorithm ed25519",
    "-domain guildcontrol.lasers.app",
    '"$RUNNER_TEMP/mcp-publisher" publish server.json',
  ]) {
    invariant(registryJob.includes(required), `Registry publication job is missing ${required}`)
  }
  for (const forbidden of [
    "contents: write",
    "packages: write",
    "attestations: write",
    "artifact-metadata: write",
    "id-token: write",
    "login github-oidc",
    "secrets.NPM_TOKEN",
  ]) {
    invariant(!registryJob.includes(forbidden), `Registry publication job contains forbidden authority ${forbidden}`)
  }
  invariant(!release.includes("secrets.NPM_TOKEN"), "release workflow must not use a standing npm token")
  invariant(
    (ci.match(/catalog-evidence\.json/g) || []).length >= 2,
    "CI must retain and compare catalog evidence across runtimes",
  )
  invariant(ci.includes("set -- packages/package-node-*/*.mcpb"), "CI must collect every runtime's MCPB")
  invariant(ci.includes('cmp "$bundle_reference" "$candidate"'), "CI must compare MCPB bytes across runtimes")
  invariant(ci.includes("name: Hardened OCI image"), "CI must verify the hardened OCI image")
  invariant(ci.includes("cmp \"$evidence_reference\" container/catalog-evidence.json"), "CI must compare package and container contracts")
  for (const required of [
    "name: Documentation portal",
    "site/package-lock.json",
    "npm run browser:install:ci",
    "npm run verify",
    "npm run test:evidence-links",
    "name: documentation-portal",
    "DOCUMENTATION_RESULT",
  ]) {
    invariant(ci.includes(required), `CI documentation verification is missing ${required}`)
  }
  invariant(ci.includes("- verify\n          - deploy-documentation"), "CI documentation dispatch operations changed")
  invariant(
    ci.includes("github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.operation == 'verify')"),
    "external documentation evidence checks must remain scheduled or explicitly dispatched",
  )
  const documentationJobStart = ci.indexOf("\n  documentation:")
  const gateJobStart = ci.indexOf("\n  gate:", documentationJobStart)
  const workersJobStart = ci.indexOf("\n  workers:", gateJobStart)
  invariant(
    documentationJobStart > 0 && gateJobStart > documentationJobStart && workersJobStart > gateJobStart,
    "documentation publication job boundaries are invalid",
  )
  const documentationJob = ci.slice(documentationJobStart, gateJobStart)
  const gateJob = ci.slice(gateJobStart, workersJobStart)
  const workersJob = ci.slice(workersJobStart)
  for (const required of [
    "npm run deploy:dry-run",
    "uses: actions/upload-artifact@",
    "name: documentation-portal",
    "path: site/dist",
    "retention-days: 7",
  ]) {
    invariant(documentationJob.includes(required), `documentation artifact verification is missing ${required}`)
  }
  for (const forbidden of [
    "CLOUDFLARE_",
    "secrets.",
    "npm run deploy --",
  ]) {
    invariant(!documentationJob.includes(forbidden), `documentation verification contains forbidden deployment authority ${forbidden}`)
  }
  invariant(gateJob.includes("DOCUMENTATION_RESULT"), "CI gate does not require documentation verification")
  for (const required of [
    "name: Publish documentation portal",
    "(github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.operation == 'deploy-documentation'))",
    "github.ref == 'refs/heads/main'",
    "needs.gate.result == 'success'",
    "needs: gate",
    "name: documentation",
    `url: ${DOCUMENTATION_URL}`,
    "actions: read",
    "contents: read",
    "node-version: \"24.19.0\"",
    "cache: npm",
    "cache-dependency-path: site/package-lock.json",
    "npm run deps:locked",
    "name: documentation-portal",
    "path: site/dist",
    "name: Deploy exact verified documentation artifact",
    'run: npm run deploy -- --message "GitHub Actions ${GITHUB_SHA}"',
    "working-directory: site",
    "CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}",
    "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_WORKERS_DEPLOY_TOKEN }}",
    "name: Verify exact public documentation",
    "--manifest site/dist/generated/docs-manifest.json",
    "--attempts 6",
    "--delay-ms 10000",
  ]) {
    invariant(workersJob.includes(required), `documentation deployment is missing ${required}`)
  }
  for (const forbidden of [
    "contents: write",
    "id-token: write",
    "pages: write",
    "packages: write",
    "npm publish",
    "docker/login-action",
    "secrets.CLOUDFLARE_API_TOKEN",
  ]) {
    invariant(!workersJob.includes(forbidden), `documentation deployment contains forbidden authority ${forbidden}`)
  }
  invariant((ci.match(/npm run deploy:dry-run/g) || []).length === 1, "CI must dry-run one documentation deployment")
  invariant((ci.match(/npm run deploy -- --message/g) || []).length === 1, "CI must deploy one verified documentation artifact")
  invariant((ci.match(/secrets\.CLOUDFLARE_WORKERS_DEPLOY_TOKEN/g) || []).length === 1, "CI must use one purpose-specific Workers token")
  invariant((ci.match(/vars\.CLOUDFLARE_ACCOUNT_ID/g) || []).length === 1, "CI must use one non-secret Cloudflare account identifier")
  invariant((ci.match(/CLOUDFLARE_API_TOKEN:/g) || []).length === 1, "only the documentation deployment may receive a Cloudflare token")
  invariant(!ci.includes("pages: write"), "CI must not retain GitHub Pages write authority")
  invariant(!ci.includes("id-token: write"), "CI documentation publication must not require OIDC")
  invariant(!ci.includes("actions/upload-pages-artifact"), "CI must not retain the GitHub Pages artifact wrapper")
  invariant(!ci.includes("actions/configure-pages"), "CI must not configure GitHub Pages")
  invariant(!ci.includes("actions/deploy-pages"), "CI must not deploy GitHub Pages")
  const codeowners = await readFile(join(REPOSITORY_ROOT, ".github/CODEOWNERS"), "utf8")
  for (const path of [
    "/.github/",
    "/.dockerignore",
    "/.npmrc",
    "/assets/",
    "/CODE_OF_CONDUCT.md",
    "/CONTRIBUTING.md",
    "/docs/",
    "/Dockerfile",
    "/package.json",
    "/package-lock.json",
    "/release-summaries.json",
    "/server.json",
    "/scripts/",
    "/SECURITY.md",
    "/site/",
    "/SUPPORT.md",
  ]) {
    invariant(codeowners.includes(`${path} @j-256`), `CODEOWNERS does not protect ${path}`)
  }
}

const packageJson = await checkPackageAndLock()
await checkReleaseSummaries(packageJson)
await checkDocumentationPortal()
await checkNeutrality()
await checkSourceIdentity(packageJson)
await checkDocumentation(packageJson)
await checkCommunityFiles()
await checkMcpbSource(packageJson)
await checkRegistryManifest(packageJson)
await checkContainerSource(packageJson)
await checkAutomation(packageJson)
process.stdout.write(`Release metadata verified for ${packageJson.name}@${packageJson.version}\n`)
