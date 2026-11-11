import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"

import { DOCUMENTATION_URL } from "./documentation-manifest.mjs"
import { dockerClientEnvironment } from "./docker-environment.mjs"
import {
  invariant,
  readJson,
  REPOSITORY_ROOT,
  run,
} from "./release-lib.mjs"

const CATALOG_EVIDENCE_FILENAME = "catalog-evidence.json"
const CONTAINER_EVIDENCE_FILENAME = "container-evidence.json"
const CONTAINER_EVIDENCE_FORMAT = "guildcontrol.container-evidence.v2"
const CONTAINER_CONFIG_FILE = "/configuration/guildcontrol.json"
const CONTAINER_CONFIG_SOURCE_FILE = "/source/guildcontrol.json"
const CONFIG_APPLICATION_ID = "100000000000000001"
const CONFIG_BOT_ID = "200000000000000001"
const CONFIG_GUILD_ID = "300000000000000001"
const IMAGE_NAME = "ghcr.io/j-256/guildcontrol"
const MCP_NAME = "app.lasers.guildcontrol/discord"
const REPOSITORY_URL = "https://github.com/j-256/guildcontrol"
const SAFETY_RESOURCE_URI = "discord://connector/safety"
const SENSITIVE_NAME_PATTERN = /(?:CREDENTIAL|PASS|PRIVATE_KEY|SECRET|TOKEN)/iu
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u
const RESTRICTED_RUNTIME_ARGUMENTS = Object.freeze([
  "--network=none",
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges:true",
  "--pids-limit=64",
])
const EXPECTED_TOP_LEVEL_PATHS = Object.freeze([
  "LICENSE",
  "PRIVACY.md",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "dist",
  "docs",
  "node_modules",
  "package.json",
])
const EXPECTED_ENVIRONMENT = Object.freeze([
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "NODE_VERSION=22.23.2",
  "YARN_VERSION=1.22.22",
  "NODE_ENV=production",
])

function parseArguments(args) {
  const options = {
    image: undefined,
    keepImage: false,
    output: undefined,
    pull: false,
    revision: undefined,
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--keep-image") {
      options.keepImage = true
      continue
    }
    if (argument === "--pull") {
      options.pull = true
      continue
    }
    const value = args[index + 1]
    invariant(value, `Option ${argument} requires a value`)
    index += 1
    if (argument === "--image") options.image = value
    else if (argument === "--output") options.output = resolve(value)
    else if (argument === "--revision") options.revision = value
    else throw new Error(`Unknown option ${argument}`)
  }
  invariant(!options.pull || options.image, "--pull requires --image")
  invariant(!options.keepImage || !options.image, "--keep-image applies only to a locally built image")
  invariant(
    options.revision === undefined || /^[a-f0-9]{40}$/u.test(options.revision),
    "--revision must be an exact Git commit",
  )
  return options
}

function sensitiveValues() {
  return [
    REPOSITORY_ROOT,
    process.env.HOME,
    ...Object.entries(process.env)
      .filter(([name]) => SENSITIVE_NAME_PATTERN.test(name))
      .map(([, value]) => value),
  ].map((value) => value?.trim()).filter((value) => value && value.length >= 8)
}

function assertSafeText(value, label) {
  for (const sensitive of sensitiveValues()) {
    invariant(!value.includes(sensitive), `${label} embeds a sensitive or machine-local value`)
  }
}

function restrictedRunArguments(image, command = [], entrypoint, runtimeArguments = []) {
  return [
    "run",
    "--rm",
    "-i",
    ...RESTRICTED_RUNTIME_ARGUMENTS,
    ...runtimeArguments,
    ...(entrypoint ? ["--entrypoint", entrypoint] : []),
    image,
    ...command,
  ]
}

async function verifyMountedConfiguration(image) {
  const temporary = await mkdtemp(join(tmpdir(), "guildcontrol-container-config-"))
  const volume = `guildcontrol-container-config-${process.pid}-${randomUUID()}`
  try {
    const directory = await realpath(temporary)
    const configFile = join(directory, "guildcontrol.json")
    const hostEnvironment = {
      LANG: "C.UTF-8",
      PATH: process.env.PATH || "/usr/bin:/bin",
    }
    const initialized = await run(
      process.execPath,
      [
        join(REPOSITORY_ROOT, "dist", "cli.js"),
        "config",
        "init",
        configFile,
        "--name",
        "container-verification",
        "--application-id",
        CONFIG_APPLICATION_ID,
        "--bot-id",
        CONFIG_BOT_ID,
        "--guild-id",
        CONFIG_GUILD_ID,
        "--json",
      ],
      { capture: true, env: hostEnvironment },
    )
    const initReport = JSON.parse(initialized.stdout)
    invariant(initReport.status === "ok", "host config initialization failed")
    invariant(initReport.validation?.discordContacted === false, "config initialization contacted Discord")
    invariant(initReport.validation?.secretValuesRead === false, "config initialization read a secret")

    // Docker config and secret mounts are root-owned and readable by the image UID
    await chmod(configFile, 0o444)
    const created = await run("docker", ["volume", "create", volume], { capture: true })
    invariant(created.stdout.trim() === volume, "Docker configuration volume creation failed")
    const sourceMount = `type=bind,source=${configFile},target=${CONTAINER_CONFIG_SOURCE_FILE},readonly`
    const writableVolume = `type=volume,source=${volume},target=/configuration`
    await run(
      "docker",
      restrictedRunArguments(
        image,
        [
          "--input-type=module",
          "--eval",
          `import { chmodSync, copyFileSync } from "node:fs"; copyFileSync("${CONTAINER_CONFIG_SOURCE_FILE}", "${CONTAINER_CONFIG_FILE}"); chmodSync("${CONTAINER_CONFIG_FILE}", 0o444)`,
        ],
        "node",
        ["--user=root", `--mount=${sourceMount}`, `--mount=${writableVolume}`],
      ),
      { capture: true },
    )
    const mounted = `type=volume,source=${volume},target=/configuration,readonly`
    const validated = await run(
      "docker",
      restrictedRunArguments(
        image,
        ["config", "validate", CONTAINER_CONFIG_FILE, "--json"],
        undefined,
        [`--mount=${mounted}`],
      ),
      { capture: true },
    )
    assertSafeText(`${validated.stdout}\n${validated.stderr}`, "mounted config validation")
    const report = JSON.parse(validated.stdout)
    invariant(report.status === "ok", "mounted config validation failed")
    invariant(report.file === CONTAINER_CONFIG_FILE, "mounted config path changed")
    invariant(report.summary?.configSchemaVersion === 2, "mounted config schema changed")
    invariant(report.validation?.crossFieldPolicy === true, "mounted config policy was not validated")
    invariant(report.validation?.discordContacted === false, "mounted config validation contacted Discord")
    invariant(report.validation?.secretValuesRead === false, "mounted config validation read a secret")
    return {
      configSchemaVersion: report.summary.configSchemaVersion,
      crossFieldPolicy: true,
      discordContacted: false,
      mountedReadOnly: true,
      secretValuesRead: false,
    }
  } finally {
    await run("docker", ["volume", "rm", "--force", volume], {
      allowedExitCodes: [0, 1],
      capture: true,
    }).catch(() => undefined)
    await rm(temporary, { force: true, recursive: true })
  }
}

async function inspectImage(image, packageJson, revision) {
  const inspectResult = await run("docker", ["image", "inspect", image], { capture: true })
  const reports = JSON.parse(inspectResult.stdout)
  invariant(Array.isArray(reports) && reports.length === 1, "Docker returned an unexpected image inspection")
  const report = reports[0]
  const config = report.Config
  invariant(SHA256_DIGEST_PATTERN.test(report.Id), "container image ID is invalid")
  invariant(["amd64", "arm64"].includes(report.Architecture), "container architecture is unsupported")
  invariant(report.Os === "linux", "container operating system must be Linux")
  invariant(config.User === "node", "container must declare the unprivileged node user")
  invariant(config.WorkingDir === "/app", "container working directory is invalid")
  assert.deepEqual(config.Entrypoint, [
    "node",
    "--optimize-for-size",
    "dist/cli.js",
  ])
  assert.deepEqual(config.Cmd, ["catalog"])
  assert.deepEqual(config.Env, EXPECTED_ENVIRONMENT)
  invariant(
    config.Env.every((entry) => !SENSITIVE_NAME_PATTERN.test(entry.split("=", 1)[0] || "")),
    "container configuration declares a secret-bearing environment variable",
  )
  const expectedLabels = {
    "io.modelcontextprotocol.server.name": MCP_NAME,
    "org.opencontainers.image.description": "Safety-first MCP server for Discord with privacy-safe reads, audits, and reviewed administration",
    "org.opencontainers.image.documentation": `${REPOSITORY_URL}/blob/v${packageJson.version}/README.md`,
    "org.opencontainers.image.licenses": "AGPL-3.0-only",
    "org.opencontainers.image.revision": revision,
    "org.opencontainers.image.source": REPOSITORY_URL,
    "org.opencontainers.image.title": "GuildControl MCP",
    "org.opencontainers.image.url": DOCUMENTATION_URL,
    "org.opencontainers.image.version": packageJson.version,
  }
  assert.deepEqual(config.Labels, expectedLabels)
  invariant(report.RootFS?.Layers?.length > 0, "container image has no filesystem layers")
  assertSafeText(JSON.stringify({ config, history: report.History }), "container configuration")
  return {
    architecture: report.Architecture,
    id: report.Id,
    labels: expectedLabels,
    os: report.Os,
  }
}

async function inspectHistory(image) {
  const historyResult = await run(
    "docker",
    ["image", "history", "--no-trunc", "--format", "{{json .}}", image],
    { capture: true },
  )
  const history = historyResult.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  invariant(history.length > 0, "container image history is empty")
  const serialized = JSON.stringify(history)
  assertSafeText(serialized, "container history")
  invariant(!SENSITIVE_NAME_PATTERN.test(serialized), "container history names secret-bearing input")
  return history.length
}

const RUNTIME_PROBE = `
import assert from "node:assert/strict"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { networkInterfaces } from "node:os"

const topLevelPaths = readdirSync("/app").sort()
assert.deepEqual(topLevelPaths, ${JSON.stringify(EXPECTED_TOP_LEVEL_PATHS)})
const status = readFileSync("/proc/self/status", "utf8")
const capabilityMask = status.match(/^CapEff:\\s*([0-9a-f]+)$/mu)?.[1]
const noNewPrivileges = status.match(/^NoNewPrivs:\\s*(\\d+)$/mu)?.[1]
assert.match(capabilityMask || "", /^0+$/u)
assert.equal(noNewPrivileges, "1")
const pidsPath = ["/sys/fs/cgroup/pids.max", "/sys/fs/cgroup/pids/pids.max"]
  .find((path) => {
    try {
      readFileSync(path)
      return true
    } catch {
      return false
    }
  })
assert.ok(pidsPath)
const pidsMax = readFileSync(pidsPath, "utf8").trim()
assert.equal(pidsMax, "64")
let rootWritable = true
try {
  writeFileSync("/container-write-probe", "forbidden")
} catch {
  rootWritable = false
}
assert.equal(rootWritable, false)
const interfaces = Object.keys(networkInterfaces()).sort()
assert.ok(interfaces.every((name) => name === "lo"))
const { searchGuildControlDocumentation } = await import("/app/dist/documentation-search.js")
const documentation = await searchGuildControlDocumentation({
  limit: 1,
  query: "outside the notification scope",
})
assert.equal(documentation.authorityGranted, false)
assert.equal(documentation.credentialsRequired, false)
assert.equal(documentation.discordContacted, false)
assert.equal(
  documentation.matches[0]?.source,
  "docs/reference.md#expanding-the-user-mention-allowlist",
)
process.stdout.write(JSON.stringify({
  capabilityMask,
  documentationSearch: "available",
  gid: process.getgid?.(),
  interfaces,
  noNewPrivileges,
  pidsMax,
  rootFilesystem: "read-only",
  topLevelPaths,
  uid: process.getuid?.(),
}))
`

async function verifyRestrictedRuntime(image) {
  const probeResult = await run(
    "docker",
    restrictedRunArguments(image, ["--input-type=module", "--eval", RUNTIME_PROBE], "node"),
    { capture: true },
  )
  const report = JSON.parse(probeResult.stdout)
  assert.deepEqual(report.topLevelPaths, EXPECTED_TOP_LEVEL_PATHS)
  invariant(report.uid === 1000 && report.gid === 1000, "container process is not the declared unprivileged user")
  invariant(report.rootFilesystem === "read-only", "container root filesystem was writable")
  invariant(report.capabilityMask === "0000000000000000", "container retained Linux capabilities")
  invariant(report.noNewPrivileges === "1", "container permits privilege escalation")
  invariant(report.pidsMax === "64", "container process limit changed")
  invariant(report.documentationSearch === "available", "container documentation search is unavailable")
  assert.deepEqual(report.interfaces, ["lo"])
  return report
}

async function readCatalog(command, args, options = {}) {
  const result = await run(command, args, {
    capture: true,
    env: options.env,
  })
  assertSafeText(`${result.stdout}\n${result.stderr}`, "catalog output")
  return { bytes: result.stdout, report: JSON.parse(result.stdout) }
}

async function verifyCatalog(image) {
  const hostEnvironment = {
    LANG: "C.UTF-8",
    PATH: process.env.PATH || "/usr/bin:/bin",
  }
  const source = await readCatalog(
    process.execPath,
    [join(REPOSITORY_ROOT, "dist", "cli.js"), "catalog", "--check", "--json"],
    { env: hostEnvironment },
  )
  const first = await readCatalog(
    "docker",
    restrictedRunArguments(image, ["catalog", "--check", "--json"]),
  )
  const second = await readCatalog(
    "docker",
    restrictedRunArguments(image, ["catalog", "--check", "--json"]),
  )
  assert.equal(second.bytes, first.bytes, "container catalog evidence is not deterministic")
  assert.deepEqual(first.report, source.report, "container catalog differs from the source contract")
  invariant(first.report.credentialsRequired === false, "container catalog unexpectedly requires credentials")
  invariant(first.report.discordExecution === "disabled", "container catalog enables Discord execution")
  invariant(first.report.executionGuard === "CATALOG_ONLY", "container execution guard changed")
  invariant(SHA256_DIGEST_PATTERN.test(first.report.contractDigest), "container contract digest is invalid")
  invariant(SHA256_DIGEST_PATTERN.test(first.report.safetyResourceDigest), "container safety digest is invalid")
  return first
}

async function verifyBotInstallPlan(image) {
  const command = [
    "preset",
    "install",
    "channel-reader",
    "--application-id",
    CONFIG_APPLICATION_ID,
    "--guild-id",
    CONFIG_GUILD_ID,
    "--json",
  ]
  const hostEnvironment = {
    LANG: "C.UTF-8",
    PATH: process.env.PATH || "/usr/bin:/bin",
  }
  const source = await run(
    process.execPath,
    [join(REPOSITORY_ROOT, "dist", "cli.js"), ...command],
    { capture: true, env: hostEnvironment },
  )
  const first = await run(
    "docker",
    restrictedRunArguments(image, command),
    { capture: true },
  )
  const second = await run(
    "docker",
    restrictedRunArguments(image, command),
    { capture: true },
  )
  for (const [label, result] of [["source", source], ["container", first], ["repeated container", second]]) {
    assertSafeText(`${result.stdout}\n${result.stderr}`, `${label} bot installation plan`)
  }
  assert.equal(second.stdout, first.stdout, "container bot installation plan is not deterministic")
  assert.equal(first.stdout, source.stdout, "container bot installation plan differs from source")
  const report = JSON.parse(first.stdout)
  assert.deepEqual(report.authorization, {
    callbackRequired: false,
    guildSelectionLocked: true,
    installContext: "guild",
    scopes: ["bot"],
    userTokenRequested: false,
  })
  assert.deepEqual(report.execution, {
    browserOpened: false,
    credentialsRequired: false,
    discordContacted: false,
  })
  assert.deepEqual(report.permissions, {
    administratorRequested: false,
    bitfield: "66560",
    names: ["VIEW_CHANNEL", "READ_MESSAGE_HISTORY"],
  })
  assert.equal(
    report.installUrl,
    `https://discord.com/oauth2/authorize?client_id=${CONFIG_APPLICATION_ID}&scope=bot&permissions=66560&guild_id=${CONFIG_GUILD_ID}&disable_guild_select=true`,
  )
}

async function verifyMcp(image, catalog) {
  const transport = new StdioClientTransport({
    args: restrictedRunArguments(image),
    command: "docker",
    env: dockerClientEnvironment(),
  })
  const client = new Client(
    { name: "container-catalog-verifier", version: "1.0.0" },
    { capabilities: {} },
  )
  try {
    await client.connect(transport)
    const [tools, prompts, resources, templates] = await Promise.all([
      client.listTools(),
      client.listPrompts(),
      client.listResources(),
      client.listResourceTemplates(),
    ])
    assert.deepEqual(tools.tools.map(({ name }) => name).sort(), catalog.toolNames)
    assert.deepEqual(prompts.prompts.map(({ name }) => name).sort(), catalog.promptNames)
    assert.deepEqual(resources.resources.map(({ uri }) => uri).sort(), catalog.resourceUris)
    assert.deepEqual(
      templates.resourceTemplates.map(({ uriTemplate }) => uriTemplate).sort(),
      catalog.resourceTemplateUris,
    )
    const guard = await client.callTool({ arguments: {}, name: "read_messages" })
    invariant(guard.isError === true, "container catalog allowed a Discord tool call")
    invariant(guard.structuredContent?.error?.code === "CATALOG_ONLY", "container catalog returned the wrong execution guard")
    invariant(guard.content.length === 2, "container catalog omitted the content-free receipt")
    invariant(guard.content[1]?.type === "text" && guard.content[1].text.startsWith("GUILDCONTROL_RECEIPT ") && guard.content[1].text.includes("CATALOG_ONLY"), "container catalog returned an invalid content-free receipt")
    const safety = await client.readResource({ uri: SAFETY_RESOURCE_URI })
    invariant(safety.contents.length === 1, "container safety resource changed")
    return {
      guard: guard.structuredContent.error.code,
      promptCount: prompts.prompts.length,
      resourceCount: resources.resources.length,
      resourceTemplateCount: templates.resourceTemplates.length,
      safetyResource: SAFETY_RESOURCE_URI,
      toolCount: tools.tools.length,
    }
  } finally {
    await client.close().catch(() => undefined)
  }
}

async function verifyMissingCredentialFailure(image) {
  const result = await run(
    "docker",
    restrictedRunArguments(image, ["serve"]),
    { allowedExitCodes: [1], capture: true },
  )
  invariant(result.stdout === "", "credential failure wrote to stdout")
  invariant(result.stderr.includes("Next:"), "credential failure lacks a recovery action")
  invariant(result.stderr.includes("See:"), "credential failure lacks a documentation reference")
  assertSafeText(result.stderr, "credential failure")
  invariant(!result.stderr.includes("/app/"), "credential failure exposes an image path")
  return {
    exitCode: result.code,
    recovery: true,
    stderrOnly: true,
  }
}

async function writeEvidence(outputDirectory, catalog, containerEvidence) {
  if (!outputDirectory) return
  await mkdir(outputDirectory, { recursive: true })
  const catalogPath = join(outputDirectory, CATALOG_EVIDENCE_FILENAME)
  const containerPath = join(outputDirectory, CONTAINER_EVIDENCE_FILENAME)
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, { flag: "wx" })
  await writeFile(containerPath, `${JSON.stringify(containerEvidence, null, 2)}\n`, { flag: "wx" })
  const dockerfileCopy = join(outputDirectory, basename("Dockerfile"))
  await copyFile(join(REPOSITORY_ROOT, "Dockerfile"), dockerfileCopy, constants.COPYFILE_EXCL)
}

const options = parseArguments(process.argv.slice(2))
const packageJson = await readJson(join(REPOSITORY_ROOT, "package.json"))
const localImage = `${IMAGE_NAME}:verify-${process.pid}-${randomUUID()}`
const image = options.image || localImage
const builtLocally = options.image === undefined
const revision = options.revision || (builtLocally ? "local" : undefined)
invariant(revision, "--image requires --revision")
invariant(revision === "local" || /^[a-f0-9]{40}$/u.test(revision), "image revision must be local or an exact Git commit")
let createdImage = false
try {
  await run(process.execPath, ["scripts/check-release-metadata.mjs"])
  await run("docker", ["info", "--format", "{{.ServerVersion}}"])
  if (options.pull) await run("docker", ["pull", image])
  if (builtLocally) {
    await run("docker", [
      "build",
      "--file",
      "Dockerfile",
      "--tag",
      image,
      "--build-arg",
      `VERSION=${packageJson.version}`,
      "--build-arg",
      `REVISION=${revision}`,
      ".",
    ])
    createdImage = true
  }
  const imageEvidence = await inspectImage(image, packageJson, revision)
  const historyEntries = await inspectHistory(image)
  const runtime = await verifyRestrictedRuntime(image)
  const configuration = await verifyMountedConfiguration(image)
  await verifyBotInstallPlan(image)
  const catalog = await verifyCatalog(image)
  const mcp = await verifyMcp(image, catalog.report)
  const missingCredential = await verifyMissingCredentialFailure(image)
  const evidence = {
    catalog: {
      contractDigest: catalog.report.contractDigest,
      promptCount: catalog.report.promptCount,
      resourceCount: catalog.report.resourceCount,
      resourceTemplateCount: catalog.report.resourceTemplateCount,
      safetyResourceDigest: catalog.report.safetyResourceDigest,
      toolCount: catalog.report.toolCount,
    },
    configuration,
    evidenceFormat: CONTAINER_EVIDENCE_FORMAT,
    historyEntries,
    image: imageEvidence,
    mcp,
    missingCredential,
    restrictions: {
      capabilities: "none",
      network: "none",
      noNewPrivileges: true,
      processLimit: 64,
      rootFilesystem: "read-only",
    },
    runtime,
  }
  await writeEvidence(options.output, catalog.report, evidence)
  process.stdout.write([
    `Verified OCI image ${imageEvidence.id}`,
    `Contract ${catalog.report.contractDigest}`,
    `Safety ${catalog.report.safetyResourceDigest}`,
  ].join("\n") + "\n")
} finally {
  if (createdImage && !options.keepImage) {
    await run("docker", ["image", "rm", image], {
      allowedExitCodes: [0, 1],
      capture: true,
    }).catch(() => undefined)
  }
}
