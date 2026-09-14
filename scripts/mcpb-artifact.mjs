import assert from "node:assert/strict"
import { build } from "esbuild"
import { zipSync, unzipSync } from "fflate"
import Ajv from "ajv"
import addFormats from "ajv-formats"
import { once } from "node:events"
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { Client } from "@modelcontextprotocol/client"
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio"

import {
  canonicalJson,
  invariant,
  readJson,
  REPOSITORY_ROOT,
  run,
  sha256,
} from "./release-lib.mjs"
import { containsSpecificReference } from "./neutrality.mjs"

const MCPB_ARCHIVE_BYTE_LIMIT = 20 * 1024 * 1024
const MCPB_ENTRY_BYTE_LIMIT = 16 * 1024 * 1024
const MCPB_SCHEMA_SHA256 = "c9c44ccff69bc033736c1f4c7c7ba18cf55cbf66c5e38db11da8341bb98c7bbe"
const ICON_SHA256 = "4b65ca78a84dc8d5cc5ac5e1e19a08c4bab20d7d455cc0cb57185e6ff2ca15de"
const MCPB_MANIFEST_SCHEMA_URL = "https://raw.githubusercontent.com/modelcontextprotocol/mcpb/v2.1.2/schemas/mcpb-manifest-v0.3.schema.json"
const MCPB_TOKEN_INPUT_ENVIRONMENT_VARIABLE = "MCPB_DISCORD_BOT_SECRET"
const MCPB_VERIFY_TOKEN_VARIABLE = "DISCORD_GUILDCONTROL_BUNDLE_VERIFY_TOKEN"
const MCPB_VERIFY_TOKEN = "mcpb-artifact-verification-token"
const MCPB_READY_MESSAGE = "[mcp] GuildControl MCP stdio server ready\n"
const MCPB_LITE_MODE_WARNING_MAX_NODE_MAJOR = 23
const LEGACY_LITE_MODE_WARNING = "Warning: disabling flag --expose_wasm due to conflicting flags\n"
const MCPB_SHUTDOWN_DEADLINE_MS = 5_000
const MCPB_EXIT_TIMEOUT_MS = 7_000
const MCPB_SHUTDOWN_COMPONENTS = Object.freeze([
  "gateway", "native-interactions", "mcp", "tools", "telemetry",
])
const MCPB_DOCUMENTATION_ROOT = ".."
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const ZIP_END_SIGNATURE = 0x06054b50
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50
const ZIP_VERSION = 20
const ZIP_UNIX_ORIGIN = 3
const ZIP_DEFLATE_METHOD = 8
const ZIP_FIXED_DATE = 0x0021
const ZIP_FIXED_TIME = 0
const ZIP_REGULAR_FILE_MODE = 0o100644
const ZIP_END_BYTES = 22
const ZIP_CENTRAL_HEADER_BYTES = 46
const ZIP_LOCAL_HEADER_BYTES = 30
const ZIP_FILE_OPTIONS = Object.freeze({
  attrs: (ZIP_REGULAR_FILE_MODE << 16) >>> 0,
  level: 9,
  mtime: new Date(1980, 0, 1, 0, 0, 0),
  os: ZIP_UNIX_ORIGIN,
})

const MCPB_DOCUMENTATION_ENTRIES = Object.freeze([
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
])

export const MCPB_ARCHIVE_ENTRIES = Object.freeze([
  "LICENSE",
  ...MCPB_DOCUMENTATION_ENTRIES,
  "icon.png",
  "manifest.json",
  "server/THIRD_PARTY_NOTICES.md",
  "server/catalog-evidence.json",
  "server/guildcontrol.mjs",
  "server/guildcontrol.mjs.LEGAL.txt",
  "server/sbom.spdx.json",
])

function asBuffer(value) {
  return Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
}

function assertSafeArchivePath(path) {
  invariant(typeof path === "string" && path.length > 0 && path.length <= 180, "MCPB archive path is invalid")
  invariant(path === path.normalize("NFC"), `MCPB archive path is not normalized: ${path}`)
  invariant(!path.startsWith("/") && !path.endsWith("/"), `MCPB archive path is not a file: ${path}`)
  invariant(!path.includes("\\") && !path.includes("\0"), `MCPB archive path contains unsafe characters: ${path}`)
  invariant(path.split("/").every((part) => part && part !== "." && part !== ".."), `MCPB archive path escapes its root: ${path}`)
  invariant(/^[A-Za-z0-9._/-]+$/.test(path), `MCPB archive path contains unsupported characters: ${path}`)
}

function assertExactKeys(value, expected, label) {
  invariant(
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort()),
    `${label} keys are invalid`,
  )
}

export function mcpbArchiveName(version) {
  invariant(/^\d+\.\d+\.\d+$/.test(version), `Invalid stable MCPB version ${version}`)
  return `guildcontrol-${version}.mcpb`
}

export async function validateMcpbManifest(document, packageJson) {
  const schemaPath = join(REPOSITORY_ROOT, "mcpb", "mcpb-manifest-v0.3.schema.json")
  const schemaBytes = await readFile(schemaPath)
  invariant(sha256(schemaBytes) === MCPB_SCHEMA_SHA256, "Pinned MCPB manifest schema digest changed")
  const schema = JSON.parse(schemaBytes.toString("utf8"))
  const ajv = new Ajv({ allErrors: true, strict: true })
  addFormats(ajv)
  const validate = ajv.compile(schema)
  const valid = validate(document)
  invariant(
    valid,
    `MCPB manifest schema validation failed: ${ajv.errorsText(validate.errors, { separator: "; " })}`,
  )
  invariant(document.$schema === MCPB_MANIFEST_SCHEMA_URL, "MCPB manifest schema source is invalid")
  invariant(document.manifest_version === "0.3", "MCPB manifest version is invalid")
  invariant(document.name === "guildcontrol", "MCPB manifest name is invalid")
  invariant(document.display_name === "GuildControl MCP", "MCPB manifest display name is invalid")
  invariant(document.version === packageJson.version, "MCPB manifest version differs from package.json")
  invariant(document.description === packageJson.description, "MCPB manifest description differs from package.json")
  invariant(document.license === packageJson.license, "MCPB manifest license differs from package.json")
  invariant(document.homepage === packageJson.homepage, "MCPB manifest homepage differs from package.json")
  assertExactKeys(document.server.mcp_config.env, [MCPB_TOKEN_INPUT_ENVIRONMENT_VARIABLE], "MCPB server environment")
  assert.deepEqual(document.server, {
    entry_point: "server/guildcontrol.mjs",
    mcp_config: {
      args: [
        "--lite-mode",
        "${__dirname}/server/guildcontrol.mjs",
        "serve",
        "--config",
        "${user_config.config_file}",
      ],
      command: "node",
      env: {
        [MCPB_TOKEN_INPUT_ENVIRONMENT_VARIABLE]: "${user_config.bot_token}",
      },
    },
    type: "node",
  })
  assert.deepEqual(document.compatibility, {
    platforms: ["darwin", "win32", "linux"],
    runtimes: { node: ">=22 <27" },
  })
  assert.deepEqual(document.user_config, {
    bot_token: {
      description: "Token for your own Discord bot. Never use a user token or place this value in the configuration file.",
      required: true,
      sensitive: true,
      title: "Discord bot token",
      type: "string",
    },
    config_file: {
      description: "Select one strict versioned non-secret GuildControl MCP JSON configuration file.",
      required: true,
      title: "GuildControl MCP configuration",
      type: "file",
    },
  })
  assert.deepEqual(document.privacy_policies, [
    `https://github.com/j-256/guildcontrol/blob/v${packageJson.version}/PRIVACY.md`,
    "https://discord.com/privacy",
  ])
  invariant(document.icon === "icon.png", "MCPB manifest icon path is invalid")
  invariant(document.tools_generated === true, "MCPB manifest must declare generated tools")
  invariant(document.prompts_generated === true, "MCPB manifest must declare generated prompts")
  return document
}

function validateCatalogEvidence(document, version) {
  invariant(document.evidenceFormat === "guildcontrol.catalog-evidence.v3", "MCPB catalog evidence format is invalid")
  invariant(document.schemaVersion === 1, "MCPB catalog evidence schema is invalid")
  invariant(document.serverVersion === version, "MCPB catalog evidence version is invalid")
  invariant(document.status === "ok", "MCPB catalog evidence status is invalid")
  invariant(document.credentialsRequired === false, "MCPB catalog evidence requires credentials")
  invariant(document.discordExecution === "disabled", "MCPB catalog evidence contacted Discord")
  invariant(document.executionGuard === "CATALOG_ONLY", "MCPB catalog evidence execution guard is invalid")
  invariant(document.gateway === "disabled", "MCPB catalog evidence enabled Gateway access")
  invariant(document.observabilityExport === "disabled", "MCPB catalog evidence exported telemetry")
  invariant(document.activityRecordsCreated === false, "MCPB catalog evidence persisted activity")
  invariant(
    document.toolAccessManifest?.format === "guildcontrol.tool-access-manifest.v2"
      && document.toolAccessManifest.entries?.length === document.toolCount
      && document.toolAccessManifest.requirementCoverage?.complete === true
      && document.toolAccessManifest.requirementCoverage?.unknownEntries === 0
      && document.toolAccessManifest.requirementCoverage?.targetAccessProven === false,
    "MCPB catalog static requirement coverage is invalid",
  )
  invariant(/^sha256:[0-9a-f]{64}$/.test(document.contractDigest), "MCPB catalog contract digest is invalid")
  invariant(/^sha256:[0-9a-f]{64}$/.test(document.safetyResourceDigest), "MCPB safety resource digest is invalid")
  return document
}

function validateSbom(document, packageJson, reproducibleBuild) {
  invariant(document.spdxVersion === "SPDX-2.3", "MCPB SBOM version is invalid")
  invariant(document.dataLicense === "CC0-1.0", "MCPB SBOM data license is invalid")
  invariant(document.SPDXID === "SPDXRef-DOCUMENT", "MCPB SBOM document identity is invalid")
  invariant(document.name === `${packageJson.name}@${packageJson.version}`, "MCPB SBOM package identity is invalid")
  invariant(
    document.creationInfo?.created === new Date(reproducibleBuild.sourceDateEpoch * 1_000).toISOString().replace(".000Z", "Z"),
    "MCPB SBOM creation time is not reproducible",
  )
  assert.deepEqual(document.creationInfo?.creators, ["Tool: guildcontrol-sbom/1"])
  invariant(
    typeof document.documentNamespace === "string"
      && /^http:\/\/spdx\.org\/spdxdocs\/guildctl-[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{64}$/.test(document.documentNamespace),
    "MCPB SBOM namespace is invalid",
  )
  invariant(Array.isArray(document.packages) && document.packages.length > 1, "MCPB SBOM package inventory is missing")
  invariant(
    document.packages.some((entry) => (
      entry?.name === packageJson.name
      && entry?.versionInfo === packageJson.version
      && entry?.licenseDeclared === packageJson.license
    )),
    "MCPB SBOM root package is missing",
  )
  invariant(document.packages.every((entry) => entry.filesAnalyzed === false), "MCPB SBOM overstates file analysis")
  return document
}

function validateNotices(text) {
  invariant(text.startsWith("# Third-party notices\n"), "MCPB third-party notices heading is invalid")
  invariant(text.includes("## Dependency inventory\n"), "MCPB third-party inventory is missing")
  invariant(text.includes("## License texts\n"), "MCPB third-party license texts are missing")
  invariant(text.endsWith("\n") && !text.includes("\0"), "MCPB third-party notices encoding is invalid")
  return text
}

function assertNeutralAndCredentialFree(entries) {
  const discordTokenPattern = /(?:mfa\.[A-Za-z0-9_-]{40,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,})/u
  const sensitiveValues = [
    REPOSITORY_ROOT,
    process.env.HOME,
    ...Object.entries(process.env)
      .filter(([name]) => /(?:CREDENTIAL|PASS|PRIVATE_KEY|SECRET|TOKEN)/i.test(name))
      .map(([, value]) => value),
  ].map((value) => value?.trim()).filter((value) => value && value.length >= 8)
  for (const [name, value] of Object.entries(entries)) {
    const text = asBuffer(value).toString("latin1")
    invariant(
      !containsSpecificReference(text, {
        allowClientCompatibility: MCPB_DOCUMENTATION_ENTRIES.includes(name),
      }),
      `MCPB archive entry ${name} has model- or harness-specific branding`,
    )
    invariant(!discordTokenPattern.test(text), `MCPB archive entry ${name} resembles a Discord credential`)
    for (const sensitive of sensitiveValues) {
      invariant(!text.includes(sensitive), `MCPB archive entry ${name} contains a sensitive environment value`)
    }
  }
}

function parseCentralDirectory(bytes) {
  invariant(bytes.length > ZIP_END_BYTES && bytes.length <= MCPB_ARCHIVE_BYTE_LIMIT, "MCPB archive size is invalid")
  const endOffset = bytes.length - ZIP_END_BYTES
  invariant(bytes.readUInt32LE(endOffset) === ZIP_END_SIGNATURE, "MCPB ZIP end record is invalid")
  invariant(bytes.readUInt16LE(endOffset + 4) === 0, "MCPB ZIP spans multiple disks")
  invariant(bytes.readUInt16LE(endOffset + 6) === 0, "MCPB ZIP central directory spans multiple disks")
  const diskEntries = bytes.readUInt16LE(endOffset + 8)
  const totalEntries = bytes.readUInt16LE(endOffset + 10)
  invariant(diskEntries === totalEntries, "MCPB ZIP entry counts differ across disks")
  invariant(totalEntries === MCPB_ARCHIVE_ENTRIES.length, "MCPB ZIP entry count is invalid")
  const centralSize = bytes.readUInt32LE(endOffset + 12)
  const centralOffset = bytes.readUInt32LE(endOffset + 16)
  invariant(bytes.readUInt16LE(endOffset + 20) === 0, "MCPB ZIP comment is not empty")
  invariant(centralOffset + centralSize === endOffset, "MCPB ZIP central directory boundary is invalid")

  const entries = []
  let cursor = centralOffset
  let expectedLocalOffset = 0
  for (let index = 0; index < totalEntries; index += 1) {
    invariant(bytes.readUInt32LE(cursor) === ZIP_CENTRAL_DIRECTORY_SIGNATURE, "MCPB ZIP central entry signature is invalid")
    const madeBy = bytes.readUInt16LE(cursor + 4)
    const needed = bytes.readUInt16LE(cursor + 6)
    const flags = bytes.readUInt16LE(cursor + 8)
    const compression = bytes.readUInt16LE(cursor + 10)
    const modifiedTime = bytes.readUInt16LE(cursor + 12)
    const modifiedDate = bytes.readUInt16LE(cursor + 14)
    const crc32 = bytes.readUInt32LE(cursor + 16)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const uncompressedSize = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const disk = bytes.readUInt16LE(cursor + 34)
    const internalAttributes = bytes.readUInt16LE(cursor + 36)
    const externalAttributes = bytes.readUInt32LE(cursor + 38)
    const localOffset = bytes.readUInt32LE(cursor + 42)
    const name = bytes.subarray(cursor + ZIP_CENTRAL_HEADER_BYTES, cursor + ZIP_CENTRAL_HEADER_BYTES + nameLength).toString("utf8")
    assertSafeArchivePath(name)
    invariant((madeBy & 0xff) === ZIP_VERSION && (madeBy >>> 8) === ZIP_UNIX_ORIGIN, `MCPB ZIP origin is invalid for ${name}`)
    invariant(needed === ZIP_VERSION, `MCPB ZIP required version is invalid for ${name}`)
    invariant((flags & 0x0001) === 0 && (flags & 0x0008) === 0, `MCPB ZIP uses unsafe flags for ${name}`)
    invariant(compression === ZIP_DEFLATE_METHOD, `MCPB ZIP compression is invalid for ${name}`)
    invariant(modifiedTime === ZIP_FIXED_TIME && modifiedDate === ZIP_FIXED_DATE, `MCPB ZIP timestamp is not reproducible for ${name}`)
    invariant(uncompressedSize > 0 && uncompressedSize <= MCPB_ENTRY_BYTE_LIMIT, `MCPB ZIP entry size is invalid for ${name}`)
    invariant(compressedSize > 0 && compressedSize <= MCPB_ENTRY_BYTE_LIMIT, `MCPB ZIP compressed size is invalid for ${name}`)
    invariant(nameLength === Buffer.byteLength(name), `MCPB ZIP entry name encoding is invalid for ${name}`)
    invariant(extraLength === 0 && commentLength === 0, `MCPB ZIP entry metadata is not empty for ${name}`)
    invariant(disk === 0 && internalAttributes === 0, `MCPB ZIP entry disk metadata is invalid for ${name}`)
    invariant((externalAttributes >>> 16) === ZIP_REGULAR_FILE_MODE, `MCPB ZIP mode is invalid for ${name}`)
    invariant(localOffset === expectedLocalOffset, `MCPB ZIP local entry order is invalid for ${name}`)

    invariant(bytes.readUInt32LE(localOffset) === ZIP_LOCAL_FILE_SIGNATURE, `MCPB ZIP local signature is invalid for ${name}`)
    invariant(bytes.readUInt16LE(localOffset + 4) === needed, `MCPB ZIP local version differs for ${name}`)
    invariant(bytes.readUInt16LE(localOffset + 6) === flags, `MCPB ZIP local flags differ for ${name}`)
    invariant(bytes.readUInt16LE(localOffset + 8) === compression, `MCPB ZIP local compression differs for ${name}`)
    invariant(bytes.readUInt16LE(localOffset + 10) === modifiedTime, `MCPB ZIP local time differs for ${name}`)
    invariant(bytes.readUInt16LE(localOffset + 12) === modifiedDate, `MCPB ZIP local date differs for ${name}`)
    invariant(bytes.readUInt32LE(localOffset + 14) === crc32, `MCPB ZIP local checksum differs for ${name}`)
    invariant(bytes.readUInt32LE(localOffset + 18) === compressedSize, `MCPB ZIP local compressed size differs for ${name}`)
    invariant(bytes.readUInt32LE(localOffset + 22) === uncompressedSize, `MCPB ZIP local size differs for ${name}`)
    const localNameLength = bytes.readUInt16LE(localOffset + 26)
    const localExtraLength = bytes.readUInt16LE(localOffset + 28)
    invariant(localNameLength === nameLength && localExtraLength === 0, `MCPB ZIP local name metadata differs for ${name}`)
    const localName = bytes.subarray(localOffset + ZIP_LOCAL_HEADER_BYTES, localOffset + ZIP_LOCAL_HEADER_BYTES + localNameLength).toString("utf8")
    invariant(localName === name, `MCPB ZIP local name differs for ${name}`)
    expectedLocalOffset = localOffset + ZIP_LOCAL_HEADER_BYTES + localNameLength + compressedSize
    invariant(expectedLocalOffset <= centralOffset, `MCPB ZIP local data exceeds its boundary for ${name}`)
    entries.push({ compressedSize, crc32, name, uncompressedSize })
    cursor += ZIP_CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength
  }
  invariant(cursor === endOffset && expectedLocalOffset === centralOffset, "MCPB ZIP directory layout is invalid")
  return entries
}

export function inspectMcpbArchive(value) {
  const bytes = asBuffer(value)
  const centralEntries = parseCentralDirectory(bytes)
  const names = centralEntries.map(({ name }) => name)
  invariant(canonicalJson(names) === canonicalJson(MCPB_ARCHIVE_ENTRIES), "MCPB ZIP entries are not in canonical order")
  const unpacked = Object.fromEntries(
    Object.entries(unzipSync(bytes)).map(([name, data]) => [name, asBuffer(data)]),
  )
  invariant(canonicalJson(Object.keys(unpacked)) === canonicalJson(MCPB_ARCHIVE_ENTRIES), "MCPB unpacked entry set is invalid")
  for (const entry of centralEntries) {
    invariant(unpacked[entry.name].length === entry.uncompressedSize, `MCPB unpacked size differs for ${entry.name}`)
  }
  return { bytes, centralEntries, unpacked }
}

async function assertRegularFile(path, label) {
  const metadata = await lstat(path)
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be one regular file`)
  invariant(metadata.size > 0 && metadata.size <= MCPB_ENTRY_BYTE_LIMIT, `${label} size is invalid`)
}

async function generateCatalogEvidence(path, packageJson, suppliedPath) {
  if (suppliedPath) {
    await assertRegularFile(suppliedPath, "supplied MCPB catalog evidence")
    await copyFile(suppliedPath, path)
  } else {
    const result = await run(
      process.execPath,
      ["dist/bin.js", "catalog", "--check", "--json"],
      { capture: true, env: {} },
    )
    await writeFile(path, result.stdout, { flag: "wx" })
  }
  const bytes = await readFile(path)
  invariant(bytes.toString("utf8").endsWith("\n"), "MCPB catalog evidence is not newline terminated")
  validateCatalogEvidence(JSON.parse(bytes.toString("utf8")), packageJson.version)
}

async function buildServerBundle(path) {
  const result = await build({
    absWorkingDir: REPOSITORY_ROOT,
    banner: {
      js: 'import { createRequire as __guildControlCreateRequire } from "node:module"; const require = __guildControlCreateRequire(import.meta.url);',
    },
    bundle: true,
    charset: "ascii",
    define: {
      __GUILDCONTROL_DOCUMENTATION_ROOT__: JSON.stringify(MCPB_DOCUMENTATION_ROOT),
      "import.meta.url": JSON.stringify("file:///__guildcontrol_internal__.mjs"),
    },
    entryPoints: ["src/mcpb-main.ts"],
    format: "esm",
    legalComments: "external",
    logLevel: "silent",
    metafile: true,
    minifySyntax: true,
    minifyWhitespace: true,
    outfile: path,
    platform: "node",
    sourcemap: false,
    target: "node22",
    treeShaking: true,
  })
  invariant(result.warnings.length === 0, "esbuild reported MCPB bundle warnings")
  const inputs = Object.keys(result.metafile.inputs)
  invariant(inputs.includes("src/mcpb-main.ts"), "MCPB bundle entrypoint is missing from esbuild metadata")
  invariant(inputs.every((input) => !input.startsWith("test/") && !input.includes("/test/")), "MCPB bundle includes test code")
}

async function createStagingDirectory(root, packageJson, catalogEvidencePath) {
  await mkdir(join(root, "server"), { recursive: true })
  await mkdir(join(root, "docs"), { recursive: true })
  const manifestPath = join(REPOSITORY_ROOT, "mcpb", "manifest.json")
  const manifest = await readJson(manifestPath)
  await validateMcpbManifest(manifest, packageJson)
  await Promise.all([
    copyFile(join(REPOSITORY_ROOT, "LICENSE"), join(root, "LICENSE")),
    ...MCPB_DOCUMENTATION_ENTRIES.map((name) => (
      copyFile(join(REPOSITORY_ROOT, name), join(root, name))
    )),
    copyFile(join(REPOSITORY_ROOT, "assets", "guildcontrol-icon.png"), join(root, "icon.png")),
    copyFile(manifestPath, join(root, "manifest.json")),
  ])
  await Promise.all([
    buildServerBundle(join(root, "server", "guildcontrol.mjs")),
    run(process.execPath, [
      "scripts/generate-sbom.mjs",
      "--output",
      join(root, "server", "sbom.spdx.json"),
    ], { capture: true }),
    run(process.execPath, [
      "scripts/generate-third-party-notices.mjs",
      "--output",
      join(root, "server", "THIRD_PARTY_NOTICES.md"),
    ], { capture: true }),
    generateCatalogEvidence(
      join(root, "server", "catalog-evidence.json"),
      packageJson,
      catalogEvidencePath,
    ),
  ])
  const files = Object.fromEntries(await Promise.all(MCPB_ARCHIVE_ENTRIES.map(async (name) => {
    const path = join(root, ...name.split("/"))
    await assertRegularFile(path, `MCPB source entry ${name}`)
    return [name, await readFile(path)]
  })))
  invariant(sha256(files["icon.png"]) === ICON_SHA256, "MCPB icon digest is invalid")
  validateCatalogEvidence(JSON.parse(files["server/catalog-evidence.json"].toString("utf8")), packageJson.version)
  const reproducibleBuild = await readJson(join(REPOSITORY_ROOT, "mcpb", "reproducible-build.json"))
  validateSbom(JSON.parse(files["server/sbom.spdx.json"].toString("utf8")), packageJson, reproducibleBuild)
  validateNotices(files["server/THIRD_PARTY_NOTICES.md"].toString("utf8"))
  assertNeutralAndCredentialFree(files)
  return files
}

function createArchive(files) {
  const zippable = Object.fromEntries(MCPB_ARCHIVE_ENTRIES.map((name) => [
    name,
    [files[name], ZIP_FILE_OPTIONS],
  ]))
  const bytes = asBuffer(zipSync(zippable))
  const inspected = inspectMcpbArchive(bytes)
  for (const name of MCPB_ARCHIVE_ENTRIES) {
    invariant(inspected.unpacked[name].equals(files[name]), `MCPB archived bytes differ for ${name}`)
  }
  return inspected
}

async function extractArchive(unpacked, root) {
  for (const name of MCPB_ARCHIVE_ENTRIES) {
    const path = join(root, ...name.split("/"))
    invariant(path.startsWith(`${root}${sep}`), `MCPB extraction path escapes its root: ${name}`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, unpacked[name], { flag: "wx", mode: 0o600 })
  }
}

export function verifyMcpbStderr(stderr, nodeMajor) {
  const prefix = `${nodeMajor <= MCPB_LITE_MODE_WARNING_MAX_NODE_MAJOR
    ? LEGACY_LITE_MODE_WARNING : ""}${MCPB_READY_MESSAGE}`
  assert.ok(stderr.startsWith(prefix), "Unpacked MCPB startup diagnostic is invalid")
  const report = JSON.parse(stderr.slice(prefix.length))
  assert.match(report.shutdownId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
  const durations = [report.durationMs, ...report.components.map(({ durationMs }) => durationMs)]
  assert.ok(durations.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= MCPB_EXIT_TIMEOUT_MS))
  assert.deepEqual(report, {
    event: "stdio-shutdown",
    schemaVersion: 1,
    shutdownId: report.shutdownId,
    reason: "stdin-ended",
    status: "complete",
    deadlineMs: MCPB_SHUTDOWN_DEADLINE_MS,
    durationMs: report.durationMs,
    activeTools: 0,
    components: MCPB_SHUTDOWN_COMPONENTS.map((name, index) => ({
      name, status: "complete", durationMs: report.components[index]?.durationMs,
    })),
  })
  assert.equal(stderr, `${prefix}${JSON.stringify(report)}\n`, "Unpacked MCPB emitted unexpected stderr")
}

async function verifyMcpHandshake(unpacked, root, packageJson) {
  const extraction = join(root, "unpacked")
  await mkdir(extraction)
  await extractArchive(unpacked, extraction)
  const { createConnectorConfigDocument } = await import(
    new URL("../dist/config-document.js", import.meta.url)
  )
  const configFile = join(root, "guildcontrol.json")
  const config = createConnectorConfigDocument({
    applicationId: "300000000000000001",
    botId: "400000000000000001",
    channelIds: ["200000000000000001"],
    credentialVariable: MCPB_VERIFY_TOKEN_VARIABLE,
    guildIds: ["100000000000000001"],
    name: "mcpb-verify",
    toolsets: ["connector", "messages"],
    toolSurface: "progressive",
  })
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  const environment = getDefaultEnvironment()
  for (const name of Object.keys(environment)) {
    if (/^DISCORD_(?:[A-Z0-9]+_)*TOKEN$/.test(name)) delete environment[name]
  }
  environment[MCPB_TOKEN_INPUT_ENVIRONMENT_VARIABLE] = MCPB_VERIFY_TOKEN
  const manifest = JSON.parse(unpacked["manifest.json"].toString("utf8"))
  const manifestArguments = manifest.server.mcp_config.args.map((argument) => argument
    .replaceAll("${__dirname}", extraction)
    .replaceAll("${user_config.config_file}", configFile))
  invariant(
    manifestArguments.every((argument) => !argument.includes("${")),
    "Unpacked MCPB launch arguments retain an unresolved placeholder",
  )
  const transport = new StdioClientTransport({
    args: manifestArguments,
    command: process.execPath,
    env: environment,
    stderr: "pipe",
  })
  const stderr = []
  invariant(transport.stderr, "Unpacked MCPB stderr capture is unavailable")
  transport.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
  const client = new Client(
    { name: "guildcontrol-mcpb-verifier", version: "1.0.0" },
    { capabilities: {} },
  )
  try {
    await client.connect(transport)
    const identity = client.getServerVersion()
    invariant(identity?.name === "guildcontrol", "Unpacked MCPB server name is invalid")
    invariant(identity?.version === packageJson.version, "Unpacked MCPB server version is invalid")
    const [tools, resources, templates, prompts] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listResourceTemplates(),
      client.listPrompts(),
    ])
    assert.deepEqual(
      tools.tools.map(({ name }) => name),
      ["discover_discord_tools", "search_guildcontrol_docs"],
    )
    const documentation = await client.callTool({
      arguments: { query: "outside the notification scope" },
      name: "search_guildcontrol_docs",
    })
    assert.equal(documentation.isError, undefined)
    assert.equal(documentation.structuredContent.authorityGranted, false)
    assert.equal(documentation.structuredContent.credentialsRequired, false)
    assert.equal(documentation.structuredContent.discordContacted, false)
    assert.equal(
      documentation.structuredContent.matches[0]?.source,
      "docs/reference.md#expanding-the-user-mention-allowlist",
    )
    invariant(resources.resources.length > 0, "Unpacked MCPB resources are missing")
    invariant(templates.resourceTemplates.length > 0, "Unpacked MCPB resource templates are missing")
    invariant(prompts.prompts.length > 0, "Unpacked MCPB prompts are missing")
    // Closing the SDK client first can conceal a bundle hang with its kill fallback
    const child = transport._process
    invariant(child?.stdin, "Unpacked MCPB child input is unavailable")
    const closed = once(child, "close", { signal: AbortSignal.timeout(MCPB_EXIT_TIMEOUT_MS) })
    child.stdin.end()
    const [code, signal] = await closed
    assert.equal(code, 0, "Unpacked MCPB did not exit successfully after EOF")
    assert.equal(signal, null, "Unpacked MCPB required a termination signal")
  } finally {
    await client.close().catch(() => undefined)
  }
  const nodeMajor = Number.parseInt(process.versions.node.split(".", 1)[0] || "", 10)
  verifyMcpbStderr(Buffer.concat(stderr).toString("utf8"), nodeMajor)
}

export async function buildAndVerifyMcpb(options = {}) {
  const packageJson = await readJson(join(REPOSITORY_ROOT, "package.json"))
  const workDirectory = await realpath(await mkdtemp(join(tmpdir(), "guildcontrol-mcpb-")))
  try {
    const firstRoot = join(workDirectory, "first")
    const secondRoot = join(workDirectory, "second")
    await mkdir(firstRoot)
    await mkdir(secondRoot)
    const firstFiles = await createStagingDirectory(firstRoot, packageJson, options.catalogEvidencePath)
    const secondFiles = await createStagingDirectory(secondRoot, packageJson, options.catalogEvidencePath)
    for (const name of MCPB_ARCHIVE_ENTRIES) {
      invariant(firstFiles[name].equals(secondFiles[name]), `Independent MCPB source bytes differ for ${name}`)
    }
    const first = createArchive(firstFiles)
    const second = createArchive(secondFiles)
    invariant(first.bytes.equals(second.bytes), "Independent MCPB archives are not byte-identical")
    await verifyMcpHandshake(first.unpacked, workDirectory, packageJson)
    const name = mcpbArchiveName(packageJson.version)
    const digest = sha256(first.bytes)
    let outputPath
    if (options.outputDirectory) {
      await mkdir(options.outputDirectory, { recursive: true })
      outputPath = join(options.outputDirectory, name)
      await writeFile(outputPath, first.bytes, { flag: "wx" })
    }
    return {
      bytes: first.bytes.length,
      digest: `sha256:${digest}`,
      entries: MCPB_ARCHIVE_ENTRIES,
      name,
      ...(outputPath ? { outputPath } : {}),
    }
  } finally {
    await rm(workDirectory, { force: true, recursive: true })
  }
}
