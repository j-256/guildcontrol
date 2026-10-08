import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { BUILDKIT_IMAGE } from "./oci-registry.mjs"
import { REPOSITORY_ROOT, run } from "./release-lib.mjs"

const PINNED_BUILDER = Symbol("pinned-builder")
const SHARED_TEMP_DIRECTORY = await mkdtemp(join(REPOSITORY_ROOT, ".release-tmp-"))
const SBOM_OUTPUT = join(SHARED_TEMP_DIRECTORY, "sbom.spdx.json")
const BUILDER_CONFIGURATION = join(SHARED_TEMP_DIRECTORY, "buildkitd.toml")
const BUILD_PARALLELISM = 1

const CONTAINER_ENVIRONMENT = Object.freeze({
  ...process.env,
  TMPDIR: SHARED_TEMP_DIRECTORY,
})

const RELEASE_CHECKS = Object.freeze([
  ["Locked dependencies", "npm", ["run", "deps:locked"]],
  ["Release metadata", "npm", ["run", "metadata:check"]],
  ["Configuration schema", "npm", ["run", "config:schema:check"]],
  ["TypeScript", "npm", ["run", "typecheck"]],
  ["Tests", "npm", ["test"]],
  ["Coverage", "npm", ["run", "test:coverage"]],
  ["Build", "npm", ["run", "build"]],
  ["npm archive", "npm", ["run", "pack:verify"]],
  ["MCPB", "npm", ["run", "mcpb:verify"]],
  ["Container", "npm", ["run", "container:verify"], CONTAINER_ENVIRONMENT],
  ["Container index", "npm", ["run", "container:index:verify"], CONTAINER_ENVIRONMENT, PINNED_BUILDER],
  ["Dependency security", "npm", ["run", "security:check"]],
  ["SBOM", "npm", ["run", "--silent", "sbom", "--", "--output", SBOM_OUTPUT]],
])

async function runWithPinnedBuilder(command, arguments_, environment) {
  const builderName = `guildcontrol-release-${process.pid}-${randomUUID()}`
  // Serialize compiler-heavy platform builds on memory-limited local Docker hosts
  await writeFile(BUILDER_CONFIGURATION, `[worker.oci]\n  max-parallelism = ${BUILD_PARALLELISM}\n`)
  await run("docker", [
    "buildx",
    "create",
    "--name",
    builderName,
    "--driver",
    "docker-container",
    "--driver-opt",
    `image=${BUILDKIT_IMAGE}`,
    "--buildkitd-config",
    BUILDER_CONFIGURATION,
  ], { capture: true })
  try {
    await run(command, arguments_, {
      env: {
        ...environment,
        BUILDX_BUILDER: builderName,
      },
    })
  } finally {
    await run("docker", ["buildx", "rm", builderName], { capture: true })
  }
}

try {
  for (const [label, command, arguments_, environment, executionMode] of RELEASE_CHECKS) {
    process.stdout.write(`==> ${label}\n`)
    if (executionMode === PINNED_BUILDER) {
      await runWithPinnedBuilder(command, arguments_, environment)
    } else {
      await run(command, arguments_, environment ? { env: environment } : {})
    }
  }
} finally {
  await rm(SHARED_TEMP_DIRECTORY, { force: true, recursive: true })
}
