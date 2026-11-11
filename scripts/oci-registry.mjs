import assert from "node:assert/strict"
import { createHash } from "node:crypto"

import { canonicalJson, invariant, REPOSITORY_ROOT } from "./release-lib.mjs"
import { DOCUMENTATION_URL } from "./documentation-manifest.mjs"

const IMAGE_INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json"
const IMAGE_CONFIG_MEDIA_TYPE = "application/vnd.oci.image.config.v1+json"
const IMAGE_LAYER_MEDIA_TYPE = "application/vnd.oci.image.layer.v1.tar+gzip"
const IMAGE_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json"
const IN_TOTO_MEDIA_TYPE = "application/vnd.in-toto+json"
const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1"
const ATTESTATION_ARTIFACT_MEDIA_TYPE = "application/vnd.docker.attestation.manifest.v1+json"
const EMPTY_CONFIG_MEDIA_TYPE = "application/vnd.oci.empty.v1+json"
const EMPTY_CONFIG_DIGEST = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
const EMPTY_CONFIG_DATA = "e30="
const EMPTY_CONFIG_SIZE = 2
const ARTIFACT_ATTESTATION_CONFIG = "artifact"
const LEGACY_ATTESTATION_CONFIG = "legacy"
const GITHUB_API_VERSION = "2026-03-10"
const GHCR_BLOB_CDN_ORIGIN = "https://pkg-containers.githubusercontent.com"
const GHCR_BLOB_REDIRECT_STATUS = 307
const GHCR_BLOB_CDN_PATH_PATTERN = /^\/ghcr(?:blobs)?[0-9]+\/blobs\/(sha256:[a-f0-9]{64})$/u
export const BINFMT_IMAGE = "tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0"
export const BUILDKIT_IMAGE = "moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8"
export const IMAGE_NAME = "ghcr.io/j-256/guildcontrol"
const MCP_NAME = "app.lasers.guildcontrol/discord"
export const OCI_DESCRIPTION = "Safety-first MCP server for Discord with privacy-safe reads, audits, and reviewed administration"
export const REPOSITORY_URL = "https://github.com/j-256/guildcontrol"
const RESPONSE_BYTE_LIMIT = 2 * 1024 * 1024
const EVIDENCE_RESPONSE_BYTE_LIMIT = 16 * 1024 * 1024
export const SBOM_GENERATOR_IMAGE = "docker.io/docker/buildkit-syft-scanner@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9"
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u
const SENSITIVE_NAME_PATTERN = /(?:CREDENTIAL|PASS|PRIVATE_KEY|SECRET|TOKEN)/iu
export const SUPPORTED_PLATFORMS = Object.freeze(["linux/amd64", "linux/arm64"])
const EXPECTED_ENVIRONMENT = Object.freeze([
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "NODE_VERSION=22.23.2",
  "YARN_VERSION=1.22.22",
  "NODE_ENV=production",
])
const BUILDKIT_PREDICATE_TYPES = Object.freeze([
  "https://slsa.dev/provenance/v1",
  "https://spdx.dev/Document",
])
const BUILDKIT_BUILD_TYPE = "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md"

function assertNoSensitiveValues(value, label) {
  const serialized = JSON.stringify(value)
  const sensitiveValues = [
    REPOSITORY_ROOT,
    process.env.HOME,
    ...Object.entries(process.env)
      .filter(([name]) => SENSITIVE_NAME_PATTERN.test(name))
      .map(([, environmentValue]) => environmentValue),
  ].map((environmentValue) => environmentValue?.trim()).filter((environmentValue) => (
    environmentValue && environmentValue.length >= 8
  ))
  for (const sensitive of sensitiveValues) {
    invariant(!serialized.includes(sensitive), `${label} embeds a sensitive or machine-local value`)
  }
}

export function parseOciReference(reference) {
  const match = reference.match(/^(ghcr\.io\/j-256\/guildcontrol):([0-9]+\.[0-9]+\.[0-9]+)$/u)
  invariant(match, "OCI image reference must use the exact semantic-versioned project path")
  return {
    name: match[1],
    repository: "j-256/guildcontrol",
    tag: match[2],
  }
}

function platformName(descriptor) {
  const os = descriptor?.platform?.os
  const architecture = descriptor?.platform?.architecture
  return `${os}/${architecture}`
}

export function validateOciIndex(index) {
  invariant(index?.schemaVersion === 2, "OCI image index schema version is invalid")
  invariant(index?.mediaType === IMAGE_INDEX_MEDIA_TYPE, "OCI image must publish an OCI image index")
  invariant(index.artifactType === undefined && index.subject === undefined, "OCI image index has an unexpected artifact shape")
  invariant(Array.isArray(index.manifests), "OCI image index has no manifests")
  assert.deepEqual(index.annotations, {
    "org.opencontainers.image.description": OCI_DESCRIPTION,
    "org.opencontainers.image.source": REPOSITORY_URL,
  })
  const runnable = index.manifests.filter((descriptor) => descriptor?.platform?.os === "linux")
  const attestations = index.manifests.filter((descriptor) => descriptor?.platform?.os === "unknown")
  invariant(runnable.length + attestations.length === index.manifests.length, "OCI image index contains an unsupported descriptor")
  assert.deepEqual(runnable.map(platformName).sort(), SUPPORTED_PLATFORMS)
  invariant(attestations.length === runnable.length, "OCI image must attach evidence to every platform")
  const runnableDigests = new Set(runnable.map(({ digest }) => digest))
  for (const descriptor of runnable) {
    validateDescriptor(descriptor, IMAGE_MANIFEST_MEDIA_TYPE, "OCI runnable descriptor")
    invariant(descriptor.annotations === undefined, "OCI runnable descriptor has unexpected annotations")
    assert.deepEqual(descriptor.platform, {
      architecture: descriptor.platform.architecture,
      os: "linux",
    })
  }
  for (const descriptor of attestations) {
    validateDescriptor(descriptor, IMAGE_MANIFEST_MEDIA_TYPE, "OCI evidence descriptor")
    assert.deepEqual(descriptor.platform, { architecture: "unknown", os: "unknown" })
    assert.deepEqual(descriptor.annotations, {
      "vnd.docker.reference.digest": descriptor.annotations?.["vnd.docker.reference.digest"],
      "vnd.docker.reference.type": "attestation-manifest",
    })
    invariant(
      runnableDigests.has(descriptor.annotations?.["vnd.docker.reference.digest"]),
      "OCI image evidence is not bound to a published platform",
    )
  }
  invariant(
    new Set(attestations.map((descriptor) => descriptor.annotations["vnd.docker.reference.digest"])).size === runnable.length,
    "OCI image evidence does not cover each platform exactly once",
  )
  return {
    attestationDescriptors: attestations,
    attestationDigests: attestations.map(({ digest }) => digest).sort(),
    platformDescriptors: runnable,
    platforms: runnable.map(platformName).sort(),
  }
}

function validateDescriptor(descriptor, mediaType, label) {
  invariant(descriptor?.mediaType === mediaType, `${label} has the wrong media type`)
  invariant(SHA256_DIGEST_PATTERN.test(descriptor.digest), `${label} has an invalid digest`)
  invariant(Number.isSafeInteger(descriptor.size) && descriptor.size > 0, `${label} has an invalid size`)
  invariant(descriptor.data === undefined, `${label} must not inline blob data`)
  invariant(descriptor.urls === undefined, `${label} must not redirect blob retrieval`)
}

export function validateOciImageManifest(manifest, label = "OCI image manifest") {
  invariant(manifest?.schemaVersion === 2, `${label} schema version is invalid`)
  invariant(manifest?.mediaType === IMAGE_MANIFEST_MEDIA_TYPE, `${label} has the wrong media type`)
  invariant(manifest.artifactType === undefined && manifest.subject === undefined, `${label} is not a runnable image`)
  invariant(manifest.annotations === undefined, `${label} has unexpected annotations`)
  validateDescriptor(manifest.config, IMAGE_CONFIG_MEDIA_TYPE, `${label} configuration`)
  invariant(manifest.config.annotations === undefined, `${label} configuration has unexpected annotations`)
  invariant(Array.isArray(manifest.layers) && manifest.layers.length > 0, `${label} has no layers`)
  for (const layer of manifest.layers) {
    validateDescriptor(layer, IMAGE_LAYER_MEDIA_TYPE, `${label} layer`)
    invariant(layer.annotations === undefined, `${label} layer has unexpected annotations`)
  }
  return {
    configDescriptor: manifest.config,
    layerDescriptors: manifest.layers,
  }
}

export function validateOciAttestationManifest(
  manifest,
  expectedSubject,
  label = "OCI attestation manifest",
) {
  invariant(manifest?.schemaVersion === 2, `${label} schema version is invalid`)
  invariant(manifest?.mediaType === IMAGE_MANIFEST_MEDIA_TYPE, `${label} has the wrong media type`)
  invariant(manifest.annotations === undefined, `${label} has unexpected annotations`)
  validateDescriptor(expectedSubject, IMAGE_MANIFEST_MEDIA_TYPE, `${label} subject`)
  const expectedSubjectReference = {
    digest: expectedSubject.digest,
    mediaType: expectedSubject.mediaType,
    size: expectedSubject.size,
  }
  let configFormat
  if (manifest.artifactType === ATTESTATION_ARTIFACT_MEDIA_TYPE) {
    assert.deepEqual(manifest.subject, expectedSubjectReference)
    const expectedConfig = {
      ...(manifest.config?.data === undefined ? {} : { data: EMPTY_CONFIG_DATA }),
      digest: EMPTY_CONFIG_DIGEST,
      mediaType: EMPTY_CONFIG_MEDIA_TYPE,
      size: EMPTY_CONFIG_SIZE,
    }
    assert.deepEqual(manifest.config, expectedConfig)
    configFormat = ARTIFACT_ATTESTATION_CONFIG
  } else {
    invariant(manifest.artifactType === undefined && manifest.subject === undefined, `${label} has an unexpected subject shape`)
    validateDescriptor(manifest.config, IMAGE_CONFIG_MEDIA_TYPE, `${label} configuration`)
    invariant(manifest.config.annotations === undefined, `${label} configuration has unexpected annotations`)
    configFormat = LEGACY_ATTESTATION_CONFIG
  }
  invariant(Array.isArray(manifest.layers), `${label} has no evidence layers`)
  for (const layer of manifest.layers) {
    validateDescriptor(layer, IN_TOTO_MEDIA_TYPE, `${label} evidence layer`)
    assert.deepEqual(layer.annotations, {
      "in-toto.io/predicate-type": layer.annotations?.["in-toto.io/predicate-type"],
    })
  }
  const predicateTypes = manifest.layers.map((layer) => layer.annotations?.["in-toto.io/predicate-type"]).sort()
  assert.deepEqual(predicateTypes, BUILDKIT_PREDICATE_TYPES)
  return {
    configDescriptor: manifest.config,
    configFormat,
    layerDescriptors: manifest.layers,
    predicateTypes,
  }
}

export function validateOciAttestationConfig(
  configDocument,
  layerDescriptors,
  configFormat = LEGACY_ATTESTATION_CONFIG,
) {
  if (configFormat === ARTIFACT_ATTESTATION_CONFIG) {
    assert.deepEqual(configDocument, {})
    return {
      configFormat,
      layerDigests: layerDescriptors.map(({ digest }) => digest),
    }
  }
  invariant(configFormat === LEGACY_ATTESTATION_CONFIG, "OCI attestation configuration format is invalid")
  assert.deepEqual(configDocument, {
    architecture: "unknown",
    config: {},
    os: "unknown",
    rootfs: {
      diff_ids: layerDescriptors.map(({ digest }) => digest),
      type: "layers",
    },
  })
  return {
    configFormat,
    layerDigests: configDocument.rootfs.diff_ids,
  }
}

export function validateInTotoStatement(statement, expectedPredicateType, expectedSubject = []) {
  invariant(BUILDKIT_PREDICATE_TYPES.includes(expectedPredicateType), "OCI evidence predicate type is unsupported")
  assert.deepEqual(Object.keys(statement || {}).sort(), ["_type", "predicate", "predicateType", "subject"])
  invariant(statement._type === IN_TOTO_STATEMENT_TYPE, "OCI evidence uses an unsupported in-toto statement version")
  invariant(statement.predicateType === expectedPredicateType, "OCI evidence predicate does not match its descriptor")
  assert.deepEqual(statement.subject, expectedSubject)
  invariant(statement.predicate && typeof statement.predicate === "object" && !Array.isArray(statement.predicate), "OCI evidence predicate is invalid")
  const predicate = statement.predicate
  if (expectedPredicateType === "https://slsa.dev/provenance/v1") {
    assert.deepEqual(Object.keys(predicate).sort(), ["buildDefinition", "runDetails"])
    invariant(predicate.buildDefinition?.buildType === BUILDKIT_BUILD_TYPE, "OCI provenance build type changed")
    assert.deepEqual(Object.keys(predicate.buildDefinition).sort(), [
      "buildType",
      "externalParameters",
      "internalParameters",
      "resolvedDependencies",
    ])
    invariant(
      predicate.buildDefinition.externalParameters && typeof predicate.buildDefinition.externalParameters === "object",
      "OCI provenance external parameters are invalid",
    )
    invariant(
      predicate.buildDefinition.internalParameters && typeof predicate.buildDefinition.internalParameters === "object",
      "OCI provenance internal parameters are invalid",
    )
    invariant(Array.isArray(predicate.buildDefinition.resolvedDependencies), "OCI provenance dependencies are invalid")
    assert.deepEqual(Object.keys(predicate.runDetails).sort(), ["builder", "metadata"])
    invariant(typeof predicate.runDetails.builder?.id === "string", "OCI provenance builder identity is invalid")
    invariant(predicate.runDetails.metadata && typeof predicate.runDetails.metadata === "object", "OCI provenance metadata is invalid")
  } else {
    assert.deepEqual(Object.keys(predicate).sort(), [
      "SPDXID",
      "creationInfo",
      "dataLicense",
      "documentNamespace",
      "files",
      "hasExtractedLicensingInfos",
      "name",
      "packages",
      "relationships",
      "spdxVersion",
    ])
    invariant(predicate.spdxVersion === "SPDX-2.3", "OCI SBOM version changed")
    invariant(predicate.dataLicense === "CC0-1.0", "OCI SBOM data license changed")
    invariant(predicate.SPDXID === "SPDXRef-DOCUMENT", "OCI SBOM document identity changed")
    invariant(typeof predicate.documentNamespace === "string" && predicate.documentNamespace.length > 0, "OCI SBOM namespace is invalid")
    invariant(typeof predicate.name === "string" && predicate.name.length > 0, "OCI SBOM name is invalid")
    invariant(predicate.creationInfo && typeof predicate.creationInfo === "object", "OCI SBOM creation metadata is invalid")
    for (const field of ["files", "hasExtractedLicensingInfos", "packages", "relationships"]) {
      invariant(Array.isArray(predicate[field]), `OCI SBOM ${field} is invalid`)
    }
  }
  assertNoSensitiveValues(statement, "OCI evidence")
  return {
    predicateType: statement.predicateType,
    statementType: statement._type,
  }
}

export function validateOciConfig(configDocument, expected) {
  assertNoSensitiveValues(configDocument, "OCI image configuration")
  invariant(configDocument?.architecture === expected.architecture, "OCI image configuration architecture changed")
  invariant(configDocument?.os === "linux", "OCI image configuration operating system changed")
  invariant(configDocument?.rootfs?.type === "layers", "OCI image root filesystem type changed")
  invariant(Array.isArray(configDocument?.rootfs?.diff_ids) && configDocument.rootfs.diff_ids.length > 0, "OCI image configuration has no root filesystem")
  invariant(
    configDocument.rootfs.diff_ids.every((digest) => SHA256_DIGEST_PATTERN.test(digest)),
    "OCI image configuration contains an invalid layer digest",
  )
  if (expected.layerCount !== undefined) {
    invariant(configDocument.rootfs.diff_ids.length === expected.layerCount, "OCI image layer and root filesystem counts differ")
  }
  const config = configDocument.config
  assert.deepEqual(Object.keys(config || {}).sort(), [
    "ArgsEscaped",
    "Cmd",
    "Entrypoint",
    "Env",
    "Labels",
    "User",
    "WorkingDir",
  ])
  invariant(config.ArgsEscaped === true, "OCI image argument encoding changed")
  invariant(config?.User === "node", "OCI image must declare the unprivileged node user")
  invariant(config?.WorkingDir === "/app", "OCI image working directory changed")
  assert.deepEqual(config?.Entrypoint, [
    "node",
    "--optimize-for-size",
    "dist/cli.js",
  ])
  assert.deepEqual(config?.Cmd, ["catalog"])
  invariant(Array.isArray(config.Env), "OCI image environment is invalid")
  invariant(
    config.Env.every((entry) => !SENSITIVE_NAME_PATTERN.test(entry.split("=", 1)[0] || "")),
    "OCI image configuration declares a secret-bearing environment variable",
  )
  assert.deepEqual(config.Env, EXPECTED_ENVIRONMENT)
  const labels = {
    "io.modelcontextprotocol.server.name": MCP_NAME,
    "org.opencontainers.image.description": OCI_DESCRIPTION,
    "org.opencontainers.image.documentation": `${REPOSITORY_URL}/blob/v${expected.version}/README.md`,
    "org.opencontainers.image.licenses": "AGPL-3.0-only",
    "org.opencontainers.image.revision": expected.revision,
    "org.opencontainers.image.source": REPOSITORY_URL,
    "org.opencontainers.image.title": "GuildControl MCP",
    "org.opencontainers.image.url": DOCUMENTATION_URL,
    "org.opencontainers.image.version": expected.version,
  }
  invariant(canonicalJson(config.Labels) === canonicalJson(labels), "OCI image labels do not match the release identity")
  const history = JSON.stringify(configDocument.history || [])
  invariant(!SENSITIVE_NAME_PATTERN.test(history), "OCI image history names secret-bearing input")
  return labels
}

function parseBearerChallenge(value, expectedScope) {
  invariant(value?.startsWith("Bearer "), "OCI registry returned an unsupported authentication challenge")
  const fields = Object.fromEntries(
    [...value.slice("Bearer ".length).matchAll(/([a-z]+)="([^"]*)"/gu)]
      .map(([, name, fieldValue]) => [name, fieldValue]),
  )
  const realm = new URL(fields.realm)
  invariant(realm.origin === "https://ghcr.io" && realm.pathname === "/token", "OCI registry returned an unexpected token service")
  invariant(fields.service === "ghcr.io", "OCI registry returned an unexpected token audience")
  invariant(fields.scope === expectedScope, "OCI registry returned an unexpected token scope")
  return { realm, service: fields.service, scope: fields.scope }
}

async function responseJson(response, label, expectedDigest, byteLimit = RESPONSE_BYTE_LIMIT) {
  const declaredLength = response.headers.get("content-length")
  if (declaredLength !== null) {
    invariant(/^(?:0|[1-9][0-9]*)$/u.test(declaredLength), `${label} returned an invalid content length`)
    invariant(Number(declaredLength) <= byteLimit, `${label} exceeds the response limit`)
  }
  invariant(response.body, `${label} returned no response body`)
  const chunks = []
  let byteLength = 0
  for await (const chunk of response.body) {
    byteLength += chunk.byteLength
    invariant(byteLength <= byteLimit, `${label} exceeds the response limit`)
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
  }
  const bytes = Buffer.concat(chunks, byteLength)
  if (expectedDigest) {
    invariant(`sha256:${createHash("sha256").update(bytes).digest("hex")}` === expectedDigest, `${label} digest does not match its descriptor`)
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
}

async function fetchWithTimeout(url, options = {}, redirect = "error") {
  return fetch(url, {
    ...options,
    redirect,
    signal: AbortSignal.timeout(15_000),
  })
}

export async function followGitHubOciBlobRedirect(response, { accept, expectedDigest }) {
  if (response.status !== GHCR_BLOB_REDIRECT_STATUS) return response
  invariant(SHA256_DIGEST_PATTERN.test(expectedDigest), "OCI blob redirect expected digest is invalid")
  invariant(typeof accept === "string" && accept.length > 0, "OCI blob redirect media type is invalid")
  const location = response.headers.get("location")
  invariant(location, "OCI blob redirect omitted its target")
  let target
  try {
    target = new URL(location)
  } catch {
    throw new Error("OCI blob redirect target is invalid")
  }
  invariant(target.origin === GHCR_BLOB_CDN_ORIGIN, "OCI blob redirect target has an unexpected origin")
  invariant(target.username === "" && target.password === "" && target.hash === "", "OCI blob redirect target has unexpected URL state")
  const pathMatch = target.pathname.match(GHCR_BLOB_CDN_PATH_PATTERN)
  invariant(pathMatch?.[1] === expectedDigest, "OCI blob redirect target does not preserve the descriptor digest")
  const redirected = await fetchWithTimeout(target, {
    headers: { accept },
  })
  invariant(
    redirected.status < 300 || redirected.status >= 400,
    "OCI blob CDN returned another redirect",
  )
  return redirected
}

async function registryToken(repository, challenge, credentials) {
  const challengeScope = `repository:${repository}:pull`
  const parsed = parseBearerChallenge(challenge, challengeScope)
  const requestedScope = credentials ? `repository:${repository}:pull,push` : parsed.scope
  parsed.realm.searchParams.set("service", parsed.service)
  parsed.realm.searchParams.set("scope", requestedScope)
  const response = await fetchWithTimeout(parsed.realm, {
    headers: {
      accept: "application/json",
      ...(credentials
        ? { authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}` }
        : {}),
    },
  })
  invariant(response.ok, `OCI registry token service returned HTTP ${response.status}`)
  const body = await responseJson(response, "OCI registry token service")
  const token = body.token || body.access_token
  invariant(typeof token === "string" && token.length > 0, "OCI registry token service omitted its bearer token")
  return token
}

async function registryRequest(url, repository, accept, token, credentials, redirect = "error") {
  let response = await fetchWithTimeout(url, {
    headers: {
      accept,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  }, redirect)
  if (response.status !== 401 || token) return { response, token }
  const nextToken = await registryToken(repository, response.headers.get("www-authenticate"), credentials)
  response = await fetchWithTimeout(url, {
    headers: { accept, authorization: `Bearer ${nextToken}` },
  }, redirect)
  return { response, token: nextToken }
}

export async function requestGitHubOciBlob({ url, repository, accept, token, expectedDigest }) {
  const result = await registryRequest(url, repository, accept, token, undefined, "manual")
  return {
    ...result,
    response: await followGitHubOciBlobRedirect(result.response, { accept, expectedDigest }),
  }
}

export async function inspectGitHubOciTag({ reference, token }) {
  const parsed = parseOciReference(reference)
  invariant(typeof token === "string" && token.length > 0, "source host package inspection requires a scoped token")
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": GITHUB_API_VERSION,
  }
  for (let page = 1; page <= 10; page += 1) {
    const url = new URL("https://api.github.com/users/j-256/packages/container/guildcontrol/versions")
    url.searchParams.set("page", String(page))
    url.searchParams.set("per_page", "100")
    const response = await fetchWithTimeout(url, { headers })
    if (response.status === 404) return { state: "missing" }
    invariant(response.ok, `source host package API returned HTTP ${response.status}`)
    const versions = await responseJson(response, "source host package API")
    invariant(Array.isArray(versions), "source host package API returned an invalid version list")
    const matching = versions.find((version) => version?.metadata?.container?.tags?.includes(parsed.tag))
    if (matching) {
      invariant(SHA256_DIGEST_PATTERN.test(matching.name), "source host package API returned an invalid image digest")
      return { digest: matching.name, state: "present" }
    }
    if (versions.length < 100) return { state: "missing" }
  }
  throw new Error("source host package version lookup exceeded its page limit")
}

export async function inspectAuthenticatedOciTag({ reference, token, username }) {
  const parsed = parseOciReference(reference)
  invariant(typeof username === "string" && username.length > 0, "authenticated OCI inspection requires a registry username")
  invariant(typeof token === "string" && token.length > 0, "authenticated OCI inspection requires a scoped token")
  const result = await registryRequest(
    `https://ghcr.io/v2/${parsed.repository}/manifests/${parsed.tag}`,
    parsed.repository,
    [IMAGE_INDEX_MEDIA_TYPE, IMAGE_MANIFEST_MEDIA_TYPE].join(", "),
    undefined,
    { password: token, username },
  )
  if (result.response.status === 404) return { state: "missing" }
  invariant(result.response.ok, `authenticated OCI registry returned HTTP ${result.response.status}`)
  const digest = result.response.headers.get("docker-content-digest")
  invariant(SHA256_DIGEST_PATTERN.test(digest), "authenticated OCI registry omitted the immutable image digest")
  return { digest, state: "present" }
}

function assertResponseDigest(response, expected) {
  const digest = response.headers.get("docker-content-digest")
  invariant(digest === expected, "OCI registry response digest does not match its descriptor")
}

export async function inspectPublicOciImage({ githubToken, reference, revision, version }) {
  const parsed = parseOciReference(reference)
  invariant(parsed.name === IMAGE_NAME && parsed.tag === version, "OCI image identity does not match the release version")
  let knownPresent = false
  if (githubToken) {
    const result = await inspectGitHubOciTag({ reference, token: githubToken })
    if (result.state === "missing") return result
    knownPresent = true
  }
  const baseUrl = `https://ghcr.io/v2/${parsed.repository}`
  const accept = [IMAGE_INDEX_MEDIA_TYPE, IMAGE_MANIFEST_MEDIA_TYPE].join(", ")
  let initial
  try {
    initial = await registryRequest(
      `${baseUrl}/manifests/${parsed.tag}`,
      parsed.repository,
      accept,
    )
  } catch (error) {
    if (knownPresent) {
      throw new Error("OCI image tag exists but is not publicly readable; change package visibility to Public and rerun", { cause: error })
    }
    throw new Error(
      "OCI image is absent or not publicly readable; provide a scoped source-host token to distinguish those states",
      { cause: error },
    )
  }
  if (initial.response.status === 404) return { state: "missing" }
  invariant(initial.response.ok, `OCI registry returned HTTP ${initial.response.status}`)
  invariant(initial.token, "OCI registry did not require an anonymous scoped token")
  const digest = initial.response.headers.get("docker-content-digest")
  invariant(SHA256_DIGEST_PATTERN.test(digest), "OCI registry omitted the immutable image digest")
  const index = await responseJson(initial.response, "OCI image index", digest)
  const validated = validateOciIndex(index)
  const labelsByPlatform = {}
  for (const descriptor of validated.platformDescriptors) {
    const platform = platformName(descriptor)
    const manifestResult = await registryRequest(
      `${baseUrl}/manifests/${descriptor.digest}`,
      parsed.repository,
      IMAGE_MANIFEST_MEDIA_TYPE,
      initial.token,
    )
    invariant(manifestResult.response.ok, `OCI registry returned HTTP ${manifestResult.response.status} for ${platform}`)
    assertResponseDigest(manifestResult.response, descriptor.digest)
    const manifest = await responseJson(manifestResult.response, `OCI ${platform} manifest`, descriptor.digest)
    const validatedManifest = validateOciImageManifest(manifest, `OCI ${platform} manifest`)
    const configResult = await requestGitHubOciBlob({
      accept: IMAGE_CONFIG_MEDIA_TYPE,
      expectedDigest: validatedManifest.configDescriptor.digest,
      repository: parsed.repository,
      token: initial.token,
      url: `${baseUrl}/blobs/${validatedManifest.configDescriptor.digest}`,
    })
    invariant(configResult.response.ok, `OCI registry returned HTTP ${configResult.response.status} for ${platform} configuration`)
    const config = await responseJson(
      configResult.response,
      `OCI ${platform} configuration`,
      validatedManifest.configDescriptor.digest,
    )
    labelsByPlatform[platform] = validateOciConfig(config, {
      architecture: descriptor.platform.architecture,
      layerCount: validatedManifest.layerDescriptors.length,
      revision,
      version,
    })
  }
  const buildkitPredicateTypes = {}
  for (const descriptor of validated.attestationDescriptors) {
    const subjectDigest = descriptor.annotations["vnd.docker.reference.digest"]
    const attestationResult = await registryRequest(
      `${baseUrl}/manifests/${descriptor.digest}`,
      parsed.repository,
      IMAGE_MANIFEST_MEDIA_TYPE,
      initial.token,
    )
    invariant(attestationResult.response.ok, `OCI registry returned HTTP ${attestationResult.response.status} for platform evidence`)
    assertResponseDigest(attestationResult.response, descriptor.digest)
    const manifest = await responseJson(attestationResult.response, "OCI attestation manifest", descriptor.digest)
    const subjectDescriptor = validated.platformDescriptors.find(({ digest }) => digest === subjectDigest)
    invariant(subjectDescriptor, "OCI image evidence subject is missing")
    const expectedStatementSubject = [{
      digest: { sha256: subjectDigest.slice("sha256:".length) },
      name: `pkg:docker/${IMAGE_NAME}@${version}?platform=${encodeURIComponent(platformName(subjectDescriptor))}`,
    }]
    const validatedManifest = validateOciAttestationManifest(manifest, subjectDescriptor)
    const attestationConfigResult = await requestGitHubOciBlob({
      accept: validatedManifest.configDescriptor.mediaType,
      expectedDigest: validatedManifest.configDescriptor.digest,
      repository: parsed.repository,
      token: initial.token,
      url: `${baseUrl}/blobs/${validatedManifest.configDescriptor.digest}`,
    })
    invariant(
      attestationConfigResult.response.ok,
      `OCI registry returned HTTP ${attestationConfigResult.response.status} for platform evidence configuration`,
    )
    const attestationConfig = await responseJson(
      attestationConfigResult.response,
      "OCI attestation configuration",
      validatedManifest.configDescriptor.digest,
    )
    validateOciAttestationConfig(
      attestationConfig,
      validatedManifest.layerDescriptors,
      validatedManifest.configFormat,
    )
    for (const layer of validatedManifest.layerDescriptors) {
      invariant(layer.size <= EVIDENCE_RESPONSE_BYTE_LIMIT, "OCI evidence exceeds the response limit")
      const evidenceResult = await requestGitHubOciBlob({
        accept: IN_TOTO_MEDIA_TYPE,
        expectedDigest: layer.digest,
        repository: parsed.repository,
        token: initial.token,
        url: `${baseUrl}/blobs/${layer.digest}`,
      })
      invariant(evidenceResult.response.ok, `OCI registry returned HTTP ${evidenceResult.response.status} for platform evidence payload`)
      const statement = await responseJson(
        evidenceResult.response,
        "OCI evidence payload",
        layer.digest,
        EVIDENCE_RESPONSE_BYTE_LIMIT,
      )
      validateInTotoStatement(
        statement,
        layer.annotations["in-toto.io/predicate-type"],
        expectedStatementSubject,
      )
    }
    buildkitPredicateTypes[subjectDigest] = validatedManifest.predicateTypes
  }
  return {
    attestationDigests: validated.attestationDigests,
    buildkitPredicateTypes,
    digest,
    labelsByPlatform,
    platforms: validated.platforms,
    state: "matching",
  }
}
