# Contributing

GuildControl MCP accepts focused fixes, tests, documentation improvements, and capabilities that preserve its least-privilege and privacy boundaries. Start with an issue for a substantial feature or architectural change so its authority, Discord prerequisites, persistence, and failure semantics can be reviewed before implementation.

## Protect credentials and Discord data

Never include a bot token, webhook credential, invite code, Guild Template code, collector header, npm credential, GitHub token, or other bearer value in an issue, pull request, commit, test fixture, screenshot, recording, log, or diagnostic attachment. Rotate a credential immediately if it may have been exposed.

Do not publish Discord message content, attachment URLs, embeds, components, audit-log reasons, usernames, profile names, role names, channel names, topics, avatars, or private guild, channel, user, message, application, or webhook identifiers. Use obviously synthetic fixtures. Report vulnerabilities through a [private GitHub Security Advisory](https://github.com/j-256/guildcontrol/security/advisories/new), following [SECURITY.md](SECURITY.md).

## Development setup

Use Node.js 22 or newer and the checked-in npm lockfile:

```sh
npm run deps:locked
```

Production dependencies are intentionally small and exactly pinned. Explain any dependency addition, the authority it gains during installation or runtime, its registry and integrity evidence, and why a native platform capability is insufficient.

Dependabot updates are review candidates. Review upstream changes and registry integrity, then update the matching dependency versions or action commit in `scripts/check-release-metadata.mjs` alongside the package lockfile or workflow. Keep the MCP SDK client and server on the same reviewed version; Dependabot groups their updates. A metadata rejection preserves the reviewed dependency boundary and must not be bypassed. When an update changes MCPB bytes, follow the [candidate version preparation procedure](docs/releasing.md#prepare-a-version) before integration so the new artifact has its own version and digest.

Keep the stdio transport, fixed-origin Discord client, policy, domain services, reviewed execution, durable coordination, activity evidence, Gateway, observability, and MCP adapter separate. Do not introduce a generic raw Discord request tool, caller-selected API origin, ambient policy fallback, shared bot custody, or automatic retry around a possible mutation.

## Designing a capability

A Discord capability proposal should identify:

- The official Discord route or Gateway event and the exact response evidence it provides
- The narrowest toolset, capability gate, exact scope, Discord permission, and privileged intent it requires
- Which Discord values are transient, returned, omitted, hashed, or persisted
- Whether the operation is read-only, additive, reversible, destructive, asynchronous, or ambiguous after transport failure
- The plan, approval, freshness, coordination, one-shot reservation, pending evidence, mutation, readback, and quarantine behavior required for every write
- How unknown fields, incomplete permission evidence, rate limits, process restarts, and concurrent external changes fail closed

Names are never substitutes for exact IDs. One safety gate is never a reason to remove another. A thin wrapper is not sufficient when Discord's real prerequisite, such as a healthy voice connection, carries its own protocol and privacy surface.

## Verification

Run the complete non-container gate before requesting review:

```sh
npm run metadata:check
npm run config:schema:check
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run pack:verify
npm run mcpb:verify
npm run security:check
```

Run `npm run mcpb:verify` when changing runtime, package, dependency, privacy, catalog, bundle, release, or Registry behavior. Run `npm run container:verify` and `npm run container:index:verify` when changing container, package, release, runtime, dependency, or Registry behavior. Default tests must use injected transports and must not contact Discord.

The documentation portal keeps its build dependencies outside the published server package. For a portal or canonical documentation change, install both lockfiles, build the server contract used by the generator, install the pinned browser once, and run the complete portal verifier:

```sh
npm run deps:locked
npm --prefix site run deps:locked
npm run build
npm --prefix site run browser:install
npm --prefix site run security:check
npm --prefix site run verify
```

Run `npm --prefix site run test:evidence-links` after changing the field comparison or its external sources. Scheduled CI repeats that network-dependent check; every pull request still verifies deterministic generation, local navigation and fragments, runtime asset privacy, browser behavior, responsive layout, search, and accessibility without depending on third-party availability.

Live probes are exceptional, explicit, read-only by default, and limited to a bot and guild controlled by the person running them. Do not fetch message content unless the exact probe and review require it. Never attach raw live output to a public report; summarize fixed error categories and privacy-safe counts instead.

## Pull requests

Keep each pull request to one logical change, add regression coverage, update every affected public contract, and complete the pull-request checklist. Use Conventional Commit subjects where practical. Contributions are accepted under the repository's [AGPL-3.0-only license](LICENSE).
