import { createHash } from "node:crypto"
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { dirname, join, posix, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { containsSpecificReference } from "../../scripts/neutrality.mjs"
import {
  DOCUMENTATION_MANIFEST_FORMAT,
  DOCUMENTATION_URL,
  documentationSourcePaths,
} from "../../scripts/documentation-manifest.mjs"

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const SITE_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..")
const REPOSITORY_ROOT = resolve(SITE_DIRECTORY, "..")
const CONTENT_ROOT = join(SITE_DIRECTORY, "src", "content", "docs")
const PUBLIC_ROOT = join(SITE_DIRECTORY, "public", "generated")
const REPOSITORY_URL = "https://github.com/j-256/guildcontrol"
const TOKEN_PATTERN = /(?:mfa\.[A-Za-z0-9_-]{60,}|[A-Za-z0-9_-]{23,30}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,})/u
const PRIVATE_PATH_PATTERN = /(?:file:\/\/\/|\/Users\/|\/home\/[A-Za-z0-9._-]+\/)/u
const STABLE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/u

const REFERENCE_GROUPS = Object.freeze([
  {
    description: "Safety, setup, application surfaces, configuration, discovery, Gateway, observability, and prompts",
    label: "Foundations",
    slug: "foundations",
    titles: [
      "Safety model",
      "Requirements",
      "Discord bot setup",
      "Application security posture",
      "Complete bot-installation drift audit",
      "Application Activity-instance verification",
      "Application command exposure audit",
      "Reviewed guild application-command lifecycle",
      "Reviewed global application-command lifecycle",
      "Application linked-role metadata audit and reviewed changes",
      "Application SKU catalog audit",
      "Exact-beneficiary application monetization audit",
      "Reviewed application entitlement lifecycle",
      "Install",
      "Operator CLI",
      "Operational stdio shutdown",
      "Configuration",
      "Tools",
      "Interactive plan review",
      "Resources",
      "Policy-aware exact-ID completion",
      "Real-time Gateway events",
      "Native Discord Interaction ingress",
      "Privacy-safe observability",
      "Prompts",
    ],
  },
  {
    description: "Caller-retained catch-up, bounded community, live recall, search, task coordination, attachment, member, ban, thread, and forum reads",
    label: "Read and discovery",
    slug: "read-and-discovery",
    titles: [
      "Readable message text",
      "Caller-retained multi-channel message catch-up",
      "Privacy-safe community activity analysis",
      "Search",
      "Discord-native task coordination",
      "Native exact message-attachment reads",
      "Privacy-safe member directory",
      "Privacy-safe guild ban audit",
      "Threads and forums",
    ],
  },
  {
    description: "Reviewed thread, pin, announcement, forwarding, poll, and webhook workflows",
    label: "Messages and interactions",
    slug: "messages-and-interactions",
    titles: [
      "Reviewed thread creation",
      "Exact thread-state audit and reviewed governance",
      "Reviewed message pins",
      "Reviewed announcement crossposts",
      "Reviewed native message forwarding",
      "Reviewed announcement subscriptions",
      "Native polls",
      "Credential-safe webhook audit, administration, and private messages",
    ],
  },
  {
    description: "Integrations, invites, templates, onboarding, settings, incidents, expressions, automation, events, and stages",
    label: "Guild lifecycle",
    slug: "guild-lifecycle",
    titles: [
      "Privacy-safe guild integration audit and reviewed deletion",
      "Reviewed exact guild departure",
      "Capability-safe guild invite creation, audit, and revocation",
      "Capability-safe native Guild Template lifecycle",
      "Privacy-minimized guild onboarding and reviewed replacement",
      "Privacy-minimized Welcome Screens and reviewed replacement",
      "Privacy-minimized guild settings and reviewed changes",
      "Privacy-minimized Discord Community lifecycle",
      "Privacy-minimized guild incident actions and reviewed lockdown changes",
      "Privacy-bounded guild profiles and reviewed text changes",
      "Authenticated widget settings and reviewed changes",
      "Privacy-safe application-owned emojis and reviewed changes",
      "Reviewed application privileged-intent enablement",
      "Reviewed authenticated bot-profile lifecycle",
      "Privacy-safe guild expressions and reviewed changes",
      "Privacy-safe soundboard inventory and reviewed changes",
      "Privacy-safe AutoMod rules and reviewed changes",
      "Privacy-safe scheduled events, subscriber audit, and reviewed changes",
      "Privacy-safe Stage instances and reviewed lifecycle",
    ],
  },
  {
    description: "Permission evidence, audit logs, channels, roles, blueprints, and resumable scaffolds",
    label: "Channels and roles",
    slug: "channels-and-roles",
    titles: [
      "Reviewed channel permission overwrites",
      "Reviewed parent-category permission synchronization",
      "Permission explanations",
      "Privacy-safe guild audit logs",
      "Reviewed exact-channel metadata changes",
      "Reviewed exact voice-channel status changes",
      "Reviewed exact relative channel placement",
      "Reviewed exact channel retirement",
      "Reviewed atomic channel cloning",
      "Reviewed additive channel creation",
      "Reviewed forum-tag lifecycle",
      "Reviewed forum posts",
      "Role inventory and reviewed additive role creation",
      "Reviewed exact role configuration",
      "Reviewed exact role retirement",
      "Reviewed exact relative role ordering",
      "Caller-retained declarative guild blueprints",
      "Reviewed resumable guild scaffolds",
    ],
  },
  {
    description: "Static publications, reactions, direct messages, deletion, member changes, moderation, and pruning",
    label: "Publishing and members",
    slug: "publishing-and-members",
    titles: [
      "Reviewed local-file attachment messages",
      "Reviewed Components V2 messages",
      "Reviewed static rich-embed messages",
      "Reaction lifecycle",
      "Exact one-to-one private-message lifecycle",
      "Safe message interactions",
      "Deletion workflow",
      "Reviewed member nickname changes",
      "Reviewed member verification-bypass changes",
      "Reviewed member-role changes",
      "Reviewed bulk member-role changes",
      "Exact member voice-state audit and reviewed changes",
      "Member moderation workflow",
      "Reviewed native bulk guild-ban workflow",
      "Reviewed bounded guild-prune workflow",
    ],
  },
  {
    description: "Build evidence, release integrity, safe expansion, and licensing",
    label: "Verification",
    slug: "verification",
    titles: [
      "Verification",
      "Release integrity",
      "Expansion",
      "License",
    ],
  },
])

const SECURITY_GROUPS = Object.freeze([
  {
    label: "Boundary and exposure",
    titles: [
      "Credentials",
      "Unified configuration",
      "Host configuration inspection",
      "Reviewed host configuration installation",
      "Migration planning",
      "MCP result boundaries",
      "Exact Discord references",
      "Application posture",
      "Bot installation drift",
      "Application Activity instances",
      "Authenticated bot profile",
      "Application linked-role metadata",
      "Application SKU catalogs",
      "Application monetization audit",
      "Discord permissions",
      "Directed coordination routing",
      "Command-processing signals",
      "Guild audit logs",
      "MCP tool surface",
      "Gateway events",
      "Native Discord Interactions",
      "Guild application commands",
      "Global application commands",
      "Observability",
    ],
  },
  {
    label: "Reviewed operation safeguards",
    titles: [
      "Durable reviewed-write coordination",
      "Exact-recipient direct messages",
      "Native attachment reads",
      "Attachment messages",
      "Reviewed Components V2 messages",
      "Static rich-embed messages",
      "Application-owned emojis",
      "Guild expressions",
      "Soundboard",
      "AutoMod",
      "Scheduled events",
      "Stage instances",
      "Member voice state and moderation",
      "Bulk member-role changes",
      "Channel metadata",
      "Parent-category permission synchronization",
      "Channel ordering",
      "Channel deletion",
      "Channel creation",
      "Guild scaffolds",
      "Guild blueprints",
      "Forum tags",
      "Forum posts",
      "Thread creation",
      "Thread state and governance",
      "Role creation",
      "Role configuration",
      "Role deletion",
      "Role ordering",
      "Reactions",
      "Message pins",
      "Announcement crossposts",
      "Message forwarding",
      "Announcement subscriptions",
      "Native polls",
    ],
  },
  {
    label: "Guild administration safeguards",
    titles: [
      "Webhooks",
      "Guild integrations",
      "Guild departure",
      "Invites",
      "Guild Templates",
      "Guild Community lifecycle",
      "Onboarding",
      "Welcome Screens",
      "Guild settings",
      "Guild incident actions",
      "Authenticated widget settings",
      "Deletion",
      "Member administration",
    ],
  },
  {
    label: "Reporting and release custody",
    titles: [
      "Reporting",
      "Release credentials",
    ],
  },
])

const FULL_DOCUMENTS = Object.freeze([
  {
    description: "The complete project overview, quick start, capability map, safety model, trust model, and architecture",
    route: "understand/project-overview",
    source: "README.md",
  },
  {
    description: "Create an owner-managed bot and complete one verified read through a compatible MCP host",
    route: "start/manual-setup",
    source: "docs/getting-started.md",
    title: "Advanced manual setup and verification",
  },
  {
    description: "Map an audited GuildControl MCP release into least-privilege setup, policy, verification, and retirement steps",
    route: "start/migration",
    source: "docs/migration.md",
  },
  {
    description: "Custody, privacy, compatibility, operational constraints, and deliberately unsupported behavior",
    route: "understand/boundaries",
    source: "docs/limitations.md",
  },
  {
    description: "Threat, usability cost, retained controls, residual risk, and recovery rationale for each major safety decision",
    route: "understand/safety-decisions",
    source: "docs/safety-usability.md",
  },
  {
    description: "Credential custody, Discord-data handling, local records, observability, operator controls, and deletion",
    route: "understand/privacy",
    source: "PRIVACY.md",
  },
  {
    description: "Dated source-audited comparison of operator outcomes across the GuildControl MCP field",
    route: "understand/comparison",
    source: "docs/comparison.md",
  },
  {
    description: "Troubleshoot setup with privacy-safe evidence and choose the correct support route",
    route: "operate/troubleshooting",
    source: "SUPPORT.md",
  },
  {
    description: "Prepare, publish, verify, and recover releases with explicit evidence boundaries",
    route: "operate/release-verification",
    source: "docs/releasing.md",
  },
  {
    description: "Provision, deploy, rotate, cut over, and recover the verified documentation Worker",
    route: "contribute/documentation-portal",
    source: "docs/documentation-portal.md",
  },
  {
    description: "Development setup, capability design expectations, verification, and pull requests",
    route: "contribute/contributing",
    source: "CONTRIBUTING.md",
  },
  {
    description: "Expected behavior and enforcement for project community spaces",
    route: "contribute/code-of-conduct",
    source: "CODE_OF_CONDUCT.md",
  },
])

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(
        ([key, candidate]) => [key, sortedValue(candidate)],
      ),
    )
  }
  return value
}

function json(value) {
  return `${JSON.stringify(sortedValue(value), null, 2)}\n`
}

function stripInlineHtml(value) {
  let stripped = ""
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "<") {
      stripped += value[index]
      continue
    }
    const closingBracket = value.indexOf(">", index + 1)
    if (closingBracket !== -1) index = closingBracket
  }
  return stripped
}

function createSlugger() {
  const seen = new Map()
  return (heading) => {
    const markdownText = heading
      .normalize("NFKD")
      .toLocaleLowerCase("en-US")
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    const base = stripInlineHtml(markdownText)
      .replace(/[`*_~]/gu, "")
      .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
      .trim()
      .replace(/[\s_]+/gu, "-")
    invariant(base.length > 0, `Heading cannot produce an empty slug: ${heading}`)
    const count = seen.get(base) || 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}-${count}`
  }
}

function markdownHeadings(markdown, source) {
  const headings = []
  const slug = createSlugger()
  let fence
  const lines = markdown.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/u)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      if (fence === undefined) fence = marker
      else if (fence === marker) fence = undefined
      continue
    }
    if (fence !== undefined) continue
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/u)
    if (!match) continue
    const title = match[2].trim()
    headings.push({
      anchor: slug(title),
      depth: match[1].length,
      index,
      source,
      title,
    })
  }
  invariant(fence === undefined, `${source} has an unclosed Markdown fence`)
  return { headings, lines }
}

function splitMarkdown(markdown, source) {
  const { headings, lines } = markdownHeadings(markdown, source)
  const h1 = headings.filter(({ depth }) => depth === 1)
  invariant(h1.length === 1, `${source} must contain exactly one level-one heading`)
  const h2 = headings.filter(({ depth }) => depth === 2)
  invariant(h2.length > 0, `${source} must contain level-two sections`)
  const intro = lines.slice(h1[0].index + 1, h2[0].index).join("\n").trim()
  const sections = h2.map((heading, sectionIndex) => {
    const end = h2[sectionIndex + 1]?.index ?? lines.length
    const sectionHeadings = headings.filter(({ index }) => index > heading.index && index < end)
    const localSlug = createSlugger()
    const aliases = new Map()
    for (const child of sectionHeadings) {
      const localAnchor = localSlug(child.title)
      if (localAnchor !== child.anchor) aliases.set(child.index, child.anchor)
    }
    const bodyLines = []
    for (let index = heading.index + 1; index < end; index += 1) {
      const alias = aliases.get(index)
      if (alias) bodyLines.push(`<a id="${alias}" aria-hidden="true"></a>`)
      bodyLines.push(lines[index])
    }
    return {
      anchor: heading.anchor,
      body: bodyLines.join("\n").trim(),
      childHeadings: sectionHeadings,
      title: heading.title,
    }
  })
  return { intro, sections, title: h1[0].title }
}

function frontmatter({ description, editUrl, hidden = false, order, title }) {
  const lines = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    `editUrl: ${editUrl}`,
  ]
  if (hidden || order !== undefined) {
    lines.push("sidebar:")
    if (hidden) lines.push("  hidden: true")
    if (order !== undefined) lines.push(`  order: ${order}`)
  }
  lines.push("---", "")
  return lines.join("\n")
}

function sourceEditUrl(source) {
  return `${REPOSITORY_URL}/edit/main/${source}`
}

function sourceViewUrl(source) {
  return `${REPOSITORY_URL}/blob/main/${source}`
}

function pageFile(route) {
  return join(CONTENT_ROOT, `${route}.md`)
}

function relativeTarget(fromRoute, target, document = true) {
  let value = posix.relative(fromRoute, target)
  if (!value.startsWith(".")) value = `./${value}`
  if (document && !value.endsWith("/")) value = `${value}/`
  return value
}

function splitDestination(destination) {
  const hashIndex = destination.indexOf("#")
  if (hashIndex === -1) return { fragment: "", path: destination }
  return {
    fragment: destination.slice(hashIndex + 1),
    path: destination.slice(0, hashIndex),
  }
}

function transformOutsideFences(markdown, transform) {
  let fence
  return markdown.split("\n").map((line) => {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/u)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      if (fence === undefined) fence = marker
      else if (fence === marker) fence = undefined
      return line
    }
    return fence === undefined ? transform(line) : line
  }).join("\n")
}

function buildLinkResolver({ anchorRoutes, sourceRoutes }) {
  const publicTargets = new Map([
    ["guildcontrol.config.schema.json", "generated/guildcontrol.config.schema.json"],
    ["server.json", "generated/server.json"],
    ["LICENSE", "generated/LICENSE.txt"],
    ["assets/guildcontrol-icon.png", "generated/guildcontrol-icon.png"],
  ])
  return (source, fromRoute, destination) => {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(destination) || destination.startsWith("//")) {
      return destination
    }
    const { fragment, path: destinationPath } = splitDestination(destination)
    if (destinationPath === "") {
      const anchored = anchorRoutes.get(source)?.get(fragment)
      if (!anchored) return destination
      const suffix = anchored.fragment ? `#${anchored.fragment}` : ""
      return `${relativeTarget(fromRoute, anchored.route)}${suffix}`
    }
    const sourceDirectory = posix.dirname(source)
    const resolvedSource = posix.normalize(posix.join(sourceDirectory, destinationPath))
    if (publicTargets.has(resolvedSource)) {
      invariant(fragment.length === 0, `Public artifact link cannot contain a fragment: ${destination}`)
      return relativeTarget(fromRoute, publicTargets.get(resolvedSource), false)
    }
    if (resolvedSource === "LICENSE") return `${REPOSITORY_URL}/blob/main/LICENSE`
    const targetRoute = sourceRoutes.get(resolvedSource)
    invariant(targetRoute, `${source} links to unsupported local target ${destination}`)
    const anchored = fragment ? anchorRoutes.get(resolvedSource)?.get(fragment) : undefined
    if (fragment && anchorRoutes.has(resolvedSource)) {
      invariant(anchored, `${source} links to unknown anchor ${destination}`)
    }
    const route = anchored?.route || targetRoute
    const suffix = anchored?.fragment
      ? `#${anchored.fragment}`
      : fragment && !anchorRoutes.has(resolvedSource)
        ? `#${fragment}`
        : ""
    return `${relativeTarget(fromRoute, route)}${suffix}`
  }
}

function rewriteMarkdown(markdown, source, route, resolveLink) {
  return transformOutsideFences(markdown, (line) => {
    const withMarkdownLinks = line.replace(/(!?\[[^\]]*\])\(([^)]+)\)/gu, (match, label, rawDestination) => {
      const destinationMatch = rawDestination.match(/^(\S+)(\s+["'].*["'])?$/u)
      if (!destinationMatch) return match
      const rewritten = resolveLink(source, route, destinationMatch[1])
      return `${label}(${rewritten}${destinationMatch[2] || ""})`
    })
    return withMarkdownLinks.replace(
      /src="https:\/\/raw\.githubusercontent\.com\/j-256\/guildcontrol\/v[0-9]+\.[0-9]+\.[0-9]+\/assets\/guildcontrol-icon\.png"/gu,
      `src="${relativeTarget(route, "generated/guildcontrol-icon.png", false)}"`,
    )
  })
}

async function writeText(file, content) {
  const normalized = content.endsWith("\n") ? content : `${content}\n`
  invariant(!containsSpecificReference(normalized, { allowClientCompatibility: true }), `${relative(REPOSITORY_ROOT, file)} violates model and harness neutrality`)
  invariant(!TOKEN_PATTERN.test(normalized), `${relative(REPOSITORY_ROOT, file)} contains a token-shaped value`)
  invariant(!PRIVATE_PATH_PATTERN.test(normalized), `${relative(REPOSITORY_ROOT, file)} contains a private absolute path`)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, normalized, "utf8")
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const candidate = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(candidate))
    else if (entry.isFile()) files.push(candidate)
  }
  return files
}

function assertExactTitles(actualSections, expectedTitles, source) {
  const actual = actualSections.map(({ title }) => title)
  invariant(
    JSON.stringify(actual) === JSON.stringify(expectedTitles),
    `${source} section map changed; update the documentation information architecture explicitly`,
  )
}

function sectionAnchorRoutes(sections, routeForTitle) {
  const routes = new Map()
  for (const section of sections) {
    const route = routeForTitle(section.title)
    routes.set(section.anchor, { fragment: "", route })
    for (const heading of section.childHeadings) {
      routes.set(heading.anchor, { fragment: heading.anchor, route })
    }
  }
  return routes
}

function securityIndex(securityGroups, securityRoutes) {
  const sections = securityGroups.map((group) => {
    const links = group.titles.map((title) => `- [${title}](${relativeTarget("security", securityRoutes.get(title))})`)
    return `## ${group.label}\n\n${links.join("\n")}`
  })
  return [
    frontmatter({
      description: "Searchable sections derived from the canonical credential, privacy, operation, administration, reporting, and release security policy",
      editUrl: sourceEditUrl("SECURITY.md"),
      order: 9,
      title: "Security details",
    }),
    "The security policy is split into task-sized pages for navigation and search. Every page is generated from `SECURITY.md`; private vulnerability reports belong in a GitHub Security Advisory rather than a public issue.",
    "",
    ...sections,
    "",
    `Canonical source: [SECURITY.md](${sourceViewUrl("SECURITY.md")})`,
  ].join("\n")
}

function referenceGroupIndex(group) {
  const route = `reference/capabilities/${group.slug}`
  const links = group.titles.map((title) => `- [${title}](${relativeTarget(route, `${route}/${stableRouteSlug(title)}`)})`)
  return [
    frontmatter({
      description: group.description,
      editUrl: sourceEditUrl("docs/reference.md"),
      order: 0,
      title: group.label,
    }),
    group.description,
    "",
    ...links,
    "",
    `Canonical source: [docs/reference.md](${sourceViewUrl("docs/reference.md")})`,
  ].join("\n")
}

function stableRouteSlug(title) {
  return createSlugger()(title)
}

function llmsIndex(packageJson) {
  return `# GuildControl MCP

> Owner-managed local stdio Discord access with exact scope, reviewed writes, privacy-minimized results, and content-free evidence.

Package: ${packageJson.name}@${packageJson.version}
Repository: ${REPOSITORY_URL}
Documentation: ${DOCUMENTATION_URL}/

## Start

- [Choose your path](${DOCUMENTATION_URL}/start/choose/): Route to setup, fit, recovery, verification, or contribution
- [First verified read](${DOCUMENTATION_URL}/start/getting-started/): Linear owner-managed bot setup with a read-only first outcome
- [Switch from another Discord MCP](${DOCUMENTATION_URL}/start/migration/): Release-exact outcome mapping and a staged least-privilege cutover
- [Fit and boundaries](${DOCUMENTATION_URL}/understand/boundaries/): Custody, privacy, compatibility, and operational constraints
- [Privacy policy](${DOCUMENTATION_URL}/understand/privacy/): Credential, Discord-data, local-record, observability, and deletion boundaries
- [Field comparison](${DOCUMENTATION_URL}/understand/comparison/): Dated head-to-head rubric with direct released-source evidence

## Safety and operation

- [Safety model](${DOCUMENTATION_URL}/understand/safety/): Scope, exact IDs, reviewed writes, privacy, and ambiguity handling
- [Safety and usability decisions](${DOCUMENTATION_URL}/understand/safety-decisions/): Risk analysis for retained, internalized, optional, and relaxed restrictions
- [Operator path](${DOCUMENTATION_URL}/operate/): Evidence ladder and deliberate expansion
- [Troubleshooting](${DOCUMENTATION_URL}/operate/troubleshooting/): Privacy-safe setup recovery
- [Release verification](${DOCUMENTATION_URL}/operate/release-verification/): Provenance, inventory, signature, and reproducibility boundaries

## Exact references

- [Reference directory](${DOCUMENTATION_URL}/reference/): Searchable canonical capability documentation
- [Security details](${DOCUMENTATION_URL}/security/): Searchable canonical security policy
- [Contract explorer](${DOCUMENTATION_URL}/generated/contract-explorer.html): Credential-free production MCP contract
- [Contract evidence](${DOCUMENTATION_URL}/generated/contract-evidence.json): Deterministic catalog verification report
- [Configuration schema](${DOCUMENTATION_URL}/generated/guildcontrol.config.schema.json): Strict non-secret policy schema
- [Full machine-readable documentation](${DOCUMENTATION_URL}/llms-full.txt): Canonical public documents with source labels

## Safety constraints

- The operator creates, installs, and controls the Discord bot
- Keep tokens in a caller-owned environment or protected file, never a static host configuration
- Keep initial setup read-only and never grant Administrator
- A local policy, Discord permission, interactive approval, and reviewed plan are independent gates
- Discord content, names, profiles, topics, URLs, and audit reasons are not persisted
- Catalog inspection requires no credential and cannot execute a tool or contact Discord
`
}

async function main() {
  const packageJson = JSON.parse(await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"))
  invariant(packageJson.name === "guildctl", "Unexpected package identity")
  invariant(STABLE_VERSION.test(packageJson.version), "Documentation requires a stable package version")

  const documentationSources = await documentationSourcePaths()
  const sourceContents = new Map()
  for (const source of documentationSources) {
    sourceContents.set(source, await readFile(join(REPOSITORY_ROOT, source)))
  }

  const reference = splitMarkdown(sourceContents.get("docs/reference.md").toString("utf8"), "docs/reference.md")
  const security = splitMarkdown(sourceContents.get("SECURITY.md").toString("utf8"), "SECURITY.md")
  const expectedReferenceTitles = REFERENCE_GROUPS.flatMap(({ titles }) => titles)
  const expectedSecurityTitles = SECURITY_GROUPS.flatMap(({ titles }) => titles)
  assertExactTitles(reference.sections, expectedReferenceTitles, "docs/reference.md")
  assertExactTitles(security.sections, expectedSecurityTitles, "SECURITY.md")

  const referenceRoutes = new Map()
  for (const group of REFERENCE_GROUPS) {
    for (const title of group.titles) {
      referenceRoutes.set(title, `reference/capabilities/${group.slug}/${stableRouteSlug(title)}`)
    }
  }
  const securityRoutes = new Map(
    SECURITY_GROUPS.flatMap(({ titles }) => titles.map((title) => [title, `security/details/${stableRouteSlug(title)}`])),
  )

  const sourceRoutes = new Map(FULL_DOCUMENTS.map(({ route, source }) => [source, route]))
  sourceRoutes.set("docs/reference.md", "reference")
  sourceRoutes.set("SECURITY.md", "security")
  const anchorRoutes = new Map([
    ["docs/reference.md", sectionAnchorRoutes(reference.sections, (title) => referenceRoutes.get(title))],
    ["SECURITY.md", sectionAnchorRoutes(security.sections, (title) => securityRoutes.get(title))],
  ])
  const resolveLink = buildLinkResolver({ anchorRoutes, sourceRoutes })

  await Promise.all([
    rm(join(CONTENT_ROOT, "reference", "capabilities"), { force: true, recursive: true }),
    rm(join(CONTENT_ROOT, "security", "details"), { force: true, recursive: true }),
    rm(PUBLIC_ROOT, { force: true, recursive: true }),
  ])

  for (const document of FULL_DOCUMENTS) {
    const markdown = sourceContents.get(document.source).toString("utf8")
    const parsed = markdownHeadings(markdown, document.source)
    const h1 = parsed.headings.filter(({ depth }) => depth === 1)
    invariant(h1.length === 1, `${document.source} must contain exactly one level-one heading`)
    const body = parsed.lines.slice(h1[0].index + 1).join("\n").trim()
    const content = [
      frontmatter({
        description: document.description,
        editUrl: sourceEditUrl(document.source),
        title: document.title ?? h1[0].title,
      }),
      rewriteMarkdown(body, document.source, document.route, resolveLink),
      "",
      `Canonical source: [${document.source}](${sourceViewUrl(document.source)})`,
    ].join("\n")
    await writeText(pageFile(document.route), content)
  }

  for (const group of REFERENCE_GROUPS) {
    await writeText(pageFile(`reference/capabilities/${group.slug}/index`), referenceGroupIndex(group))
  }
  for (const [index, section] of reference.sections.entries()) {
    const route = referenceRoutes.get(section.title)
    const body = index === 0 && reference.intro
      ? `${reference.intro}\n\n${section.body}`
      : section.body
    const content = [
      frontmatter({
        description: `Canonical GuildControl MCP reference for ${section.title.toLocaleLowerCase("en-US")}`,
        editUrl: sourceEditUrl("docs/reference.md"),
        order: index + 1,
        title: section.title,
      }),
      rewriteMarkdown(body, "docs/reference.md", route, resolveLink),
      "",
      `Canonical source: [docs/reference.md](${sourceViewUrl("docs/reference.md")})`,
    ].join("\n")
    await writeText(pageFile(route), content)
  }

  await writeText(pageFile("security/index"), securityIndex(SECURITY_GROUPS, securityRoutes))
  for (const section of security.sections) {
    const route = securityRoutes.get(section.title)
    const content = [
      frontmatter({
        description: `Canonical GuildControl MCP security requirements for ${section.title.toLocaleLowerCase("en-US")}`,
        editUrl: sourceEditUrl("SECURITY.md"),
        hidden: true,
        title: section.title,
      }),
      rewriteMarkdown(section.body, "SECURITY.md", route, resolveLink),
      "",
      `Canonical source: [SECURITY.md](${sourceViewUrl("SECURITY.md")})`,
    ].join("\n")
    await writeText(pageFile(route), content)
  }

  const catalogModule = join(REPOSITORY_ROOT, "dist", "catalog.js")
  const catalogHtmlModule = join(REPOSITORY_ROOT, "dist", "catalog-html.js")
  try {
    await stat(catalogModule)
    await stat(catalogHtmlModule)
  } catch {
    throw new Error("Compiled catalog modules are missing; run npm run build from the repository root")
  }
  const { inspectDiscordCatalog } = await import(pathToFileURL(catalogModule).href)
  const { renderDiscordCatalogHtml } = await import(pathToFileURL(catalogHtmlModule).href)
  const snapshot = await inspectDiscordCatalog()
  invariant(snapshot.report.serverVersion === packageJson.version, "Catalog and package versions differ")
  invariant(snapshot.report.credentialsRequired === false, "Catalog evidence unexpectedly requires credentials")
  invariant(snapshot.report.discordExecution === "disabled", "Catalog evidence unexpectedly permits Discord execution")
  invariant(snapshot.report.activityRecordsCreated === false, "Catalog evidence unexpectedly creates activity records")

  await mkdir(PUBLIC_ROOT, { recursive: true })
  await writeText(join(PUBLIC_ROOT, "contract-evidence.json"), json(snapshot.report))
  await writeText(join(PUBLIC_ROOT, "contract-explorer.html"), renderDiscordCatalogHtml(snapshot))
  await writeText(join(PUBLIC_ROOT, "guildcontrol.config.schema.json"), sourceContents.get("guildcontrol.config.schema.json").toString("utf8"))
  await writeText(join(PUBLIC_ROOT, "server.json"), sourceContents.get("server.json").toString("utf8"))
  await writeText(join(PUBLIC_ROOT, "LICENSE.txt"), sourceContents.get("LICENSE").toString("utf8"))
  await copyFile(join(REPOSITORY_ROOT, "assets", "guildcontrol-icon.png"), join(PUBLIC_ROOT, "guildcontrol-icon.png"))
  await writeText(join(SITE_DIRECTORY, "public", "llms.txt"), llmsIndex(packageJson))

  const fullSources = [
    "README.md",
    "docs/getting-started.md",
    "docs/migration.md",
    "docs/limitations.md",
    "docs/safety-usability.md",
    "PRIVACY.md",
    "docs/comparison.md",
    "docs/reference.md",
    "SECURITY.md",
    "SUPPORT.md",
    "docs/documentation-portal.md",
    "docs/releasing.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
  ]
  const fullText = [
    "# GuildControl MCP full documentation",
    "",
    `Package: ${packageJson.name}@${packageJson.version}`,
    `Repository: ${REPOSITORY_URL}`,
    "",
    "Canonical public documents follow in source order. GuildControl MCP is local owner-managed stdio software. Keep credentials in a caller-owned secret source, start read-only, and treat every write as a reviewed workflow.",
    "",
    ...fullSources.flatMap((source) => [
      `===== SOURCE: ${source} =====`,
      "",
      sourceContents.has(source)
        ? sourceContents.get(source).toString("utf8").trim()
        : "",
      "",
    ]),
  ].join("\n")
  await writeText(join(SITE_DIRECTORY, "public", "llms-full.txt"), fullText)

  const generatedFiles = [
    ...await collectFiles(join(CONTENT_ROOT, "reference", "capabilities")),
    ...await collectFiles(join(CONTENT_ROOT, "security", "details")),
    ...FULL_DOCUMENTS.map(({ route }) => pageFile(route)),
    pageFile("security/index"),
    ...await collectFiles(PUBLIC_ROOT),
    join(SITE_DIRECTORY, "public", "llms.txt"),
    join(SITE_DIRECTORY, "public", "llms-full.txt"),
  ]
  const manifest = {
    format: DOCUMENTATION_MANIFEST_FORMAT,
    outputs: await Promise.all(generatedFiles.sort().map(async (file) => ({
      path: relative(SITE_DIRECTORY, file),
      sha256: sha256(await readFile(file)),
    }))),
    package: {
      name: packageJson.name,
      version: packageJson.version,
    },
    sources: documentationSources.map((source) => ({
      path: source,
      sha256: sha256(sourceContents.get(source)),
    })),
  }
  await writeText(join(PUBLIC_ROOT, "docs-manifest.json"), json(manifest))
  process.stdout.write(`Generated GuildControl MCP documentation for ${packageJson.version}\n`)
}

await main()
