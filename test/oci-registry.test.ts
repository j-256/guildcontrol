import assert from "node:assert/strict"
import { resolve } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

interface OciRegistryModule {
  followGitHubOciBlobRedirect(
    response: Response,
    options: { accept: string; expectedDigest: string },
  ): Promise<Response>
  requestGitHubOciBlob(options: {
    accept: string
    expectedDigest: string
    repository: string
    token: string
    url: string
  }): Promise<{ response: Response; token: string }>
  inspectAuthenticatedOciTag(input: {
    reference: string
    token: string
    username: string
  }): Promise<{ digest?: string; state: string }>
  parseOciReference(reference: string): {
    name: string
    repository: string
    tag: string
  }
  validateOciConfig(
    config: unknown,
    expected: { architecture: string; layerCount?: number; revision: string; version: string },
  ): Record<string, string>
  validateOciAttestationManifest(manifest: unknown, expectedSubject: unknown): {
    configFormat: string
    predicateTypes: string[]
  }
  validateOciAttestationConfig(config: unknown, layers: Array<{ digest: string }>, configFormat?: string): {
    configFormat: string
    layerDigests: string[]
  }
  validateInTotoStatement(statement: unknown, expectedPredicateType: string, expectedSubject?: unknown[]): {
    predicateType: string
    statementType: string
  }
  validateOciImageManifest(manifest: unknown): {
    configDescriptor: { digest: string }
    layerDescriptors: unknown[]
  }
  validateOciIndex(index: unknown): {
    attestationDigests: string[]
    platformDescriptors: unknown[]
    platforms: string[]
  }
}

const modulePath = pathToFileURL(resolve("scripts/oci-registry.mjs")).href
const oci = await import(modulePath) as OciRegistryModule
const VERSION = "2.2.1"
const REVISION = "a".repeat(40)
const IMAGE_CONFIG_MEDIA_TYPE = "application/vnd.oci.image.config.v1+json"
const GHCR_BLOB_CDN_ORIGIN = "https://pkg-containers.githubusercontent.com"

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`
}

function imageDescriptor(architecture: string, character: string): object {
  return {
    digest: digest(character),
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    platform: { architecture, os: "linux" },
    size: 100,
  }
}

function attestationDescriptor(subjectDigest: string, character: string): object {
  return {
    annotations: {
      "vnd.docker.reference.digest": subjectDigest,
      "vnd.docker.reference.type": "attestation-manifest",
    },
    digest: digest(character),
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    platform: { architecture: "unknown", os: "unknown" },
    size: 80,
  }
}

function validIndex(): object {
  const amd64 = imageDescriptor("amd64", "a")
  const arm64 = imageDescriptor("arm64", "b")
  return {
    annotations: {
      "org.opencontainers.image.description": "Safety-first MCP server for Discord with privacy-safe reads, audits, and reviewed administration",
      "org.opencontainers.image.source": "https://github.com/j-256/guildcontrol",
    },
    manifests: [
      amd64,
      attestationDescriptor(digest("a"), "c"),
      arm64,
      attestationDescriptor(digest("b"), "d"),
    ],
    mediaType: "application/vnd.oci.image.index.v1+json",
    schemaVersion: 2,
  }
}

function validConfig(): object {
  return {
    architecture: "amd64",
    config: {
      ArgsEscaped: true,
      Cmd: ["catalog"],
      Entrypoint: [
        "node",
        "--no-expose-wasm",
        "--lite-mode",
        "dist/cli.js",
      ],
      Env: [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "NODE_VERSION=22.23.2",
        "YARN_VERSION=1.22.22",
        "NODE_ENV=production",
      ],
      Labels: {
        "io.modelcontextprotocol.server.name": "app.lasers.guildcontrol/discord",
        "org.opencontainers.image.description": "Safety-first MCP server for Discord with privacy-safe reads, audits, and reviewed administration",
        "org.opencontainers.image.documentation": `https://github.com/j-256/guildcontrol/blob/v${VERSION}/README.md`,
        "org.opencontainers.image.licenses": "AGPL-3.0-only",
        "org.opencontainers.image.revision": REVISION,
        "org.opencontainers.image.source": "https://github.com/j-256/guildcontrol",
        "org.opencontainers.image.title": "GuildControl MCP",
        "org.opencontainers.image.url": "https://docs.guildcontrol.lasers.app",
        "org.opencontainers.image.version": VERSION,
      },
      User: "node",
      WorkingDir: "/app",
    },
    history: [{ created_by: "COPY dist /app/dist" }],
    os: "linux",
    rootfs: { diff_ids: [digest("e")], type: "layers" },
  }
}

function validImageManifest(): object {
  return {
    config: {
      digest: digest("e"),
      mediaType: "application/vnd.oci.image.config.v1+json",
      size: 100,
    },
    layers: [{
      digest: digest("f"),
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
      size: 200,
    }],
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2,
  }
}

function validAttestationManifest(): object {
  return {
    config: {
      digest: digest("a"),
      mediaType: "application/vnd.oci.image.config.v1+json",
      size: 100,
    },
    layers: [
      {
        annotations: { "in-toto.io/predicate-type": "https://spdx.dev/Document" },
        digest: digest("b"),
        mediaType: "application/vnd.in-toto+json",
        size: 200,
      },
      {
        annotations: { "in-toto.io/predicate-type": "https://slsa.dev/provenance/v1" },
        digest: digest("c"),
        mediaType: "application/vnd.in-toto+json",
        size: 300,
      },
    ],
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2,
  }
}

function validArtifactAttestationManifest(expectedSubject: object): object {
  const subject = expectedSubject as {
    digest: string
    mediaType: string
    size: number
  }
  return {
    artifactType: "application/vnd.docker.attestation.manifest.v1+json",
    config: {
      data: "e30=",
      digest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      mediaType: "application/vnd.oci.empty.v1+json",
      size: 2,
    },
    layers: [
      {
        annotations: { "in-toto.io/predicate-type": "https://spdx.dev/Document" },
        digest: digest("b"),
        mediaType: "application/vnd.in-toto+json",
        size: 200,
      },
      {
        annotations: { "in-toto.io/predicate-type": "https://slsa.dev/provenance/v1" },
        digest: digest("c"),
        mediaType: "application/vnd.in-toto+json",
        size: 300,
      },
    ],
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2,
    subject: {
      digest: subject.digest,
      mediaType: subject.mediaType,
      size: subject.size,
    },
  }
}

function validAttestationConfig(): object {
  return {
    architecture: "unknown",
    config: {},
    os: "unknown",
    rootfs: {
      diff_ids: [digest("b"), digest("c")],
      type: "layers",
    },
  }
}

function validProvenanceStatement(): object {
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
        externalParameters: {},
        internalParameters: {},
        resolvedDependencies: [],
      },
      runDetails: {
        builder: { id: "" },
        metadata: {},
      },
    },
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [],
  }
}

function validSpdxStatement(): object {
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicate: {
      SPDXID: "SPDXRef-DOCUMENT",
      creationInfo: {},
      dataLicense: "CC0-1.0",
      documentNamespace: "https://example.invalid/sbom",
      files: [],
      hasExtractedLicensingInfos: [],
      name: "image",
      packages: [],
      relationships: [],
      spdxVersion: "SPDX-2.3",
    },
    predicateType: "https://spdx.dev/Document",
    subject: [],
  }
}

test("parses only the exact project image with a stable version tag", () => {
  assert.deepEqual(oci.parseOciReference("ghcr.io/j-256/guildcontrol:2.2.1"), {
    name: "ghcr.io/j-256/guildcontrol",
    repository: "j-256/guildcontrol",
    tag: "2.2.1",
  })
  assert.throws(() => oci.parseOciReference("ghcr.io/j-256/guildcontrol:latest"))
  assert.throws(() => oci.parseOciReference("docker.io/j-256/guildcontrol:2.2.1"))
})

test("inspects an exact private tag through scoped registry authentication", async () => {
  const expectedDigest = digest("f")
  const originalFetch = globalThis.fetch
  const requests: Array<{ authorization: string | undefined; url: string }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    const authorization = headers.get("authorization") || undefined
    requests.push({ authorization, url })
    if (url.startsWith("https://ghcr.io/token")) {
      const parsed = new URL(url)
      assert.equal(parsed.searchParams.get("scope"), "repository:j-256/guildcontrol:pull,push")
      assert.equal(authorization, `Basic ${Buffer.from("release-actor:credential-value").toString("base64")}`)
      return Response.json({ token: "registry-bearer" })
    }
    if (!authorization) {
      return new Response(null, {
        headers: {
          "www-authenticate": "Bearer realm=\"https://ghcr.io/token\",service=\"ghcr.io\",scope=\"repository:j-256/guildcontrol:pull\"",
        },
        status: 401,
      })
    }
    assert.equal(authorization, "Bearer registry-bearer")
    return Response.json({}, {
      headers: { "docker-content-digest": expectedDigest },
    })
  }) as typeof fetch
  try {
    assert.deepEqual(await oci.inspectAuthenticatedOciTag({
      reference: "ghcr.io/j-256/guildcontrol:2.2.1",
      token: "credential-value",
      username: "release-actor",
    }), {
      digest: expectedDigest,
      state: "present",
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(requests.length, 3)
})

test("rejects an oversized registry token response while streaming", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.startsWith("https://ghcr.io/token")) {
      return new Response(JSON.stringify({ token: "x".repeat(2 * 1024 * 1024) }))
    }
    return new Response(null, {
      headers: {
        "www-authenticate": "Bearer realm=\"https://ghcr.io/token\",service=\"ghcr.io\",scope=\"repository:j-256/guildcontrol:pull\"",
      },
      status: 401,
    })
  }) as typeof fetch
  try {
    await assert.rejects(
      oci.inspectAuthenticatedOciTag({
        reference: "ghcr.io/j-256/guildcontrol:2.2.1",
        token: "credential-value",
        username: "release-actor",
      }),
      /response limit/u,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("requests a GHCR blob with manual redirect handling and strips registry credentials from the CDN hop", async () => {
  const expectedDigest = digest("e")
  const registryUrl = `https://ghcr.io/v2/j-256/guildcontrol/blobs/${expectedDigest}`
  const redirectUrl = `${GHCR_BLOB_CDN_ORIGIN}/ghcr1/blobs/${expectedDigest}?signature=opaque`
  const originalFetch = globalThis.fetch
  let requestCount = 0
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestCount += 1
    const headers = new Headers(init?.headers)
    assert.equal(headers.get("accept"), IMAGE_CONFIG_MEDIA_TYPE)
    if (requestCount === 1) {
      assert.equal(String(input), registryUrl)
      assert.equal(init?.redirect, "manual")
      assert.equal(headers.get("authorization"), "Bearer registry-bearer")
      return new Response(null, {
        headers: { location: redirectUrl },
        status: 307,
      })
    }
    assert.equal(String(input), redirectUrl)
    assert.equal(init?.redirect, "error")
    assert.equal(headers.get("authorization"), null)
    return Response.json({ verified: true })
  }) as typeof fetch
  try {
    const result = await oci.requestGitHubOciBlob({
      accept: IMAGE_CONFIG_MEDIA_TYPE,
      expectedDigest,
      repository: "j-256/guildcontrol",
      token: "registry-bearer",
      url: registryUrl,
    })
    assert.equal(result.response.status, 200)
    assert.equal(result.token, "registry-bearer")
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(requestCount, 2)
})

test("rejects unsafe GHCR blob redirect targets before fetching", async () => {
  const expectedDigest = digest("e")
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error("unsafe redirect must not be fetched")
  }) as typeof fetch
  const unsafeTargets = [
    `https://example.invalid/ghcrblobs11/blobs/${expectedDigest}`,
    `${GHCR_BLOB_CDN_ORIGIN}/unexpected/blobs/${expectedDigest}`,
    `${GHCR_BLOB_CDN_ORIGIN}/ghcrblobs11/blobs/${digest("f")}`,
    `https://user@pkg-containers.githubusercontent.com/ghcrblobs11/blobs/${expectedDigest}`,
  ]
  try {
    for (const location of unsafeTargets) {
      await assert.rejects(
        oci.followGitHubOciBlobRedirect(new Response(null, {
          headers: { location },
          status: 307,
        }), {
          accept: IMAGE_CONFIG_MEDIA_TYPE,
          expectedDigest,
        }),
      )
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("does not follow other redirect statuses or a second CDN redirect", async () => {
  const expectedDigest = digest("e")
  const redirectUrl = `${GHCR_BLOB_CDN_ORIGIN}/ghcrblobs11/blobs/${expectedDigest}?signature=opaque`
  const originalFetch = globalThis.fetch
  let requestCount = 0
  globalThis.fetch = (async () => {
    requestCount += 1
    return new Response(null, {
      headers: { location: `${GHCR_BLOB_CDN_ORIGIN}/unexpected` },
      status: 307,
    })
  }) as typeof fetch
  try {
    const unhandled = new Response(null, {
      headers: { location: redirectUrl },
      status: 302,
    })
    assert.equal(await oci.followGitHubOciBlobRedirect(unhandled, {
      accept: IMAGE_CONFIG_MEDIA_TYPE,
      expectedDigest,
    }), unhandled)
    assert.equal(requestCount, 0)
    await assert.rejects(
      oci.followGitHubOciBlobRedirect(new Response(null, {
        headers: { location: redirectUrl },
        status: 307,
      }), {
        accept: IMAGE_CONFIG_MEDIA_TYPE,
        expectedDigest,
      }),
      /another redirect/u,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(requestCount, 1)
})

test("requires two release platforms with one bound attestation each", () => {
  const result = oci.validateOciIndex(validIndex())
  assert.deepEqual(result.platforms, ["linux/amd64", "linux/arm64"])
  assert.equal(result.platformDescriptors.length, 2)
  assert.deepEqual(result.attestationDigests, [digest("c"), digest("d")])

  const missingAttestation = validIndex() as { manifests: unknown[] }
  missingAttestation.manifests.pop()
  assert.throws(() => oci.validateOciIndex(missingAttestation), /evidence/u)

  const unboundAttestation = validIndex() as {
    manifests: Array<{ annotations?: Record<string, string> }>
  }
  const attestation = unboundAttestation.manifests[1]
  assert.ok(attestation?.annotations)
  attestation.annotations["vnd.docker.reference.digest"] = digest("f")
  assert.throws(() => oci.validateOciIndex(unboundAttestation), /not bound/u)

  const wrongSource = validIndex() as { annotations: Record<string, string> }
  wrongSource.annotations["org.opencontainers.image.source"] = "https://example.invalid/repository"
  assert.throws(() => oci.validateOciIndex(wrongSource), /source/u)
})

test("requires the exact non-root catalog-first image configuration", () => {
  const labels = oci.validateOciConfig(validConfig(), {
    architecture: "amd64",
    revision: REVISION,
    version: VERSION,
  })
  assert.equal(labels["io.modelcontextprotocol.server.name"], "app.lasers.guildcontrol/discord")

  const root = validConfig() as { config: { User: string } }
  root.config.User = "root"
  assert.throws(
    () => oci.validateOciConfig(root, { architecture: "amd64", revision: REVISION, version: VERSION }),
    /unprivileged/u,
  )

  const secretEnvironment = validConfig() as { config: { Env: string[] } }
  secretEnvironment.config.Env.push("DISCORD_BOT_TOKEN=forbidden")
  assert.throws(
    () => oci.validateOciConfig(secretEnvironment, { architecture: "amd64", revision: REVISION, version: VERSION }),
    /secret-bearing/u,
  )

  const immediateServe = validConfig() as { config: { Cmd: string[] } }
  immediateServe.config.Cmd = ["serve"]
  assert.throws(
    () => oci.validateOciConfig(immediateServe, { architecture: "amd64", revision: REVISION, version: VERSION }),
  )
})

test("requires ordinary image layers and both BuildKit evidence predicates", () => {
  const image = oci.validateOciImageManifest(validImageManifest())
  assert.equal(image.configDescriptor.digest, digest("e"))
  assert.equal(image.layerDescriptors.length, 1)

  const expectedSubject = imageDescriptor("amd64", "d")
  const evidence = oci.validateOciAttestationManifest(
    validAttestationManifest(),
    expectedSubject,
  )
  assert.equal(evidence.configFormat, "legacy")
  assert.deepEqual(evidence.predicateTypes, [
    "https://slsa.dev/provenance/v1",
    "https://spdx.dev/Document",
  ])
  assert.deepEqual(
    oci.validateOciAttestationConfig(validAttestationConfig(), [
      { digest: digest("b") },
      { digest: digest("c") },
    ]).layerDigests,
    [digest("b"), digest("c")],
  )

  const artifactEvidence = oci.validateOciAttestationManifest(
    validArtifactAttestationManifest(expectedSubject),
    expectedSubject,
  )
  assert.equal(artifactEvidence.configFormat, "artifact")
  assert.deepEqual(
    oci.validateOciAttestationConfig(
      {},
      [{ digest: digest("b") }, { digest: digest("c") }],
      artifactEvidence.configFormat,
    ),
    {
      configFormat: "artifact",
      layerDigests: [digest("b"), digest("c")],
    },
  )

  const externalEmptyConfig = validArtifactAttestationManifest(expectedSubject) as {
    config: { data?: string }
  }
  delete externalEmptyConfig.config.data
  assert.equal(
    oci.validateOciAttestationManifest(externalEmptyConfig, expectedSubject).configFormat,
    "artifact",
  )

  const redirectingLayer = validImageManifest() as { layers: Array<{ urls?: string[] }> }
  redirectingLayer.layers[0]!.urls = ["https://example.invalid/layer"]
  assert.throws(() => oci.validateOciImageManifest(redirectingLayer), /redirect/u)

  const incompleteEvidence = validAttestationManifest() as { layers: unknown[] }
  incompleteEvidence.layers.pop()
  assert.throws(() => oci.validateOciAttestationManifest(incompleteEvidence, expectedSubject))

  const mismatchedSubject = validArtifactAttestationManifest(expectedSubject) as {
    subject: { digest: string }
  }
  mismatchedSubject.subject.digest = digest("f")
  assert.throws(
    () => oci.validateOciAttestationManifest(mismatchedSubject, expectedSubject),
  )

  const invalidEmptyConfig = validArtifactAttestationManifest(expectedSubject) as {
    config: { data: string }
  }
  invalidEmptyConfig.config.data = "e30K"
  assert.throws(
    () => oci.validateOciAttestationManifest(invalidEmptyConfig, expectedSubject),
  )

  const mismatchedConfiguration = validAttestationConfig() as { rootfs: { diff_ids: string[] } }
  mismatchedConfiguration.rootfs.diff_ids.reverse()
  assert.throws(() => oci.validateOciAttestationConfig(mismatchedConfiguration, [
    { digest: digest("b") },
    { digest: digest("c") },
  ]))

  assert.equal(
    oci.validateInTotoStatement(validProvenanceStatement(), "https://slsa.dev/provenance/v1").statementType,
    "https://in-toto.io/Statement/v1",
  )
  assert.equal(
    oci.validateInTotoStatement(validSpdxStatement(), "https://spdx.dev/Document").predicateType,
    "https://spdx.dev/Document",
  )

  const publishedSubject = [{
    digest: { sha256: "d".repeat(64) },
    name: `pkg:docker/ghcr.io/j-256/guildcontrol@${VERSION}?platform=linux%2Famd64`,
  }]
  const boundStatement = validProvenanceStatement() as { subject: unknown[] }
  boundStatement.subject = structuredClone(publishedSubject)
  assert.equal(
    oci.validateInTotoStatement(
      boundStatement,
      "https://slsa.dev/provenance/v1",
      publishedSubject,
    ).statementType,
    "https://in-toto.io/Statement/v1",
  )

  const mismatchedPredicate = validSpdxStatement() as { predicateType: string }
  mismatchedPredicate.predicateType = "https://slsa.dev/provenance/v1"
  assert.throws(
    () => oci.validateInTotoStatement(mismatchedPredicate, "https://spdx.dev/Document"),
    /does not match/u,
  )

  const embeddedSubject = validProvenanceStatement() as { subject: unknown[] }
  embeddedSubject.subject.push({ digest: { sha256: "forbidden" }, name: "unexpected" })
  assert.throws(
    () => oci.validateInTotoStatement(embeddedSubject, "https://slsa.dev/provenance/v1"),
  )
})
