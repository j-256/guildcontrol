# GuildControl MCP

<img src="https://raw.githubusercontent.com/j-256/guildcontrol/v2.2.1/assets/guildcontrol-icon.png" alt="GuildControl MCP shield and reviewed connection icon" width="128">

GuildControl MCP is a local stdio Model Context Protocol server for safe Discord guild and separately allowlisted one-to-one access through an operator-owned bot. It combines broad typed coverage with exact scope, privacy-minimized results, reviewed writes, content-free evidence, and explicit ambiguity handling.

**Least privilege. Review before mutation. Verifiable outcomes. No Discord-content persistence.**

[Documentation portal](https://docs.guildcontrol.lasers.app/) | [Verified product tour](https://docs.guildcontrol.lasers.app/generated/contract-explorer.html#tour) | [Get a verified read](docs/getting-started.md) | [Safety and usability decisions](docs/safety-usability.md) | [Switch from another MCP](docs/migration.md) | [Fit and boundaries](docs/limitations.md) | [Field comparison](docs/comparison.md) | [Complete reference](docs/reference.md) | [Privacy](PRIVACY.md) | [Security](SECURITY.md)

GuildControl is an independent project and is not affiliated with or endorsed by Discord Inc. Discord is used only to identify the platform that GuildControl connects to.

## Why this connector

| Concern | Enforced behavior |
| --- | --- |
| Discord reach | One strict non-secret policy file with verified application and bot identities, explicit guild and channel scope, a separate exact-user private-message scope, risk-separated toolsets, and read-only setup presets |
| Exact targeting | Canonical Discord jump links and official typed mentions convert locally into exact IDs without name lookup, Discord contact, input echo, persistence, or downstream authority |
| Read safety | Bounded requests, safe transient GET retries, lossless whole-result byte budgets, strict response validation, privacy-tiered projections, untrusted-content handling, caller-retained catch-up, exact attachment reads without local-file persistence, no private-channel discovery, and only explicit verified parent-thread inheritance |
| Write safety | Exact-ID requests, execute-first keyed planning, signed interactive approval, a final fresh-plan match, and action-specific Discord permission proof |
| Outcome integrity | Pending content-free evidence, non-retried writes, exact readback, durable coordination, ambiguity quarantine, and bounded local invalid-request pressure |
| Privacy | Tokens stay in a caller-owned secret source; Discord content, profiles, URLs, audit reasons, and raw operation keys are not persisted |
| Plan review | Complete evidence, MCP App display, and local authority-free blueprint preview |
| Release integrity | Exact dependency and base-image pins, credential-free contract fingerprints, reproducible npm and MCPB artifacts, hardened OCI checks, embedded and external SPDX evidence, signed-release automation, and source-bound public documentation |

Use the [first verified read guide](docs/getting-started.md) for setup and recovery. Read [product boundaries and host compatibility](docs/limitations.md) before adopting the custody, privacy, approval, and recovery model. The [complete reference](docs/reference.md) covers every policy, tool, permission, resource, prompt, command, and workflow limit.

## Quick start

The fastest supported outcome is an owner-managed read-only bot, one strict non-secret policy, one private host guide, and a successful channel inventory. You need Node.js 22 or newer, `Manage Server` authority in a Discord server you control, and a local stdio MCP host. GuildControl provides no shared bot, relay, or token store.

### Guided setup: start here

Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications), enable Developer Mode in Discord, and copy the Application ID and target Server ID. Then run:

```sh
npx guildctl
```

`npx guildctl` starts interactive onboarding: host selection, minimum `server-observer` policy creation or exact revalidation, live bot and MCP verification, and a private activation guide. It fails closed on drift and never stores the token, reads message content, enables writes, discovers host paths, or edits host configuration.

The result explains credential handoff; a one-time prompt is cleared after smoke. See the [first verified read guide](docs/getting-started.md) for custody and recovery.

Optional `guildctl host detect` checks path metadata only. `onboard --detect-host` selects one candidate; ambiguity requires a choice. Detection reads no candidate content or credential.

For unattended setup, supply every public decision and an existing secret reference:

```sh
npx --yes guildctl@2.2.1 onboard \
  --host codex \
  --application-id YOUR_APPLICATION_ID \
  --guild-id YOUR_GUILD_ID \
  --config /absolute/private/guildcontrol.json \
  --confirm-installed YOUR_GUILD_ID \
  --token-env DISCORD_BOT_TOKEN \
  --json
```

JSON mode never prompts or opens a browser. The [first verified read guide](docs/getting-started.md) covers supported hosts, default paths, alternate credential custody, the manual route, and recovery.

Do not grant the bot `Administrator`. Generate the exact initial permission grant from a read-only preset, then narrow the installed bot role with category or channel overrides. The [bot setup guide](docs/reference.md#discord-bot-setup) explains bot ownership, optional intents, and later feature-specific permissions.

### Optional preflight: inspect without credentials

Inspect an exact release and its read-only preset without a token or Discord request:

```sh
npx --yes guildctl@2.2.1 catalog --check
npx --yes guildctl@2.2.1 catalog --html ./guildcontrol-contract.html
npx --yes guildctl@2.2.1 preset show server-observer
```

`catalog --check` verifies the credential-free, execution-disabled production contract, including complete per-tool setup and readiness metadata. `catalog --html FILE` renders it as a release-exact guided, searchable offline explorer with no external asset, runtime request, credential, or configured completion ID.

### Switch from another Discord MCP

Generate a complete release-exact outcome map before creating policy or changing the old deployment:

```sh
npx --yes guildctl@2.2.1 migrate list
npx --yes guildctl@2.2.1 migrate plan cappyeo@0.26.0 --html ./guildcontrol-migration.html
```

The [migration guide](docs/migration.md) covers every scored peer release. Planning scans no checkout, reads no configuration, host setting, environment value, or credential, contacts no network or Discord endpoint, and changes nothing. It maps every audited source tool into supported, review-required, or intentionally excluded outcomes and validates target routes against the negotiated production catalog. It does not rewrite prompts, arguments, configuration, credentials, or host settings.

### Install your owner-managed bot

Create a Discord application and bot in the [Developer Portal](https://discord.com/developers/applications), copy the public Application ID and target Server ID, and generate a callback-free install link whose guild and least-privilege permission grant come from the recommended preset:

```sh
npx --yes guildctl@2.2.1 preset install server-observer \
  --application-id YOUR_APPLICATION_ID \
  --guild-id YOUR_GUILD_ID \
  --html ./guildcontrol-onboarding.html
```

Open the printed URL while signed in as a member allowed to manage that server. It requests only `View Channel` for `server-observer`, locks the server selector to the supplied ID, requests no user token, and never sends the bot token to the connector command. Keep Public Bot disabled unless other people should be able to install your application. Use `channel-reader` instead to request `View Channel` plus `Read Message History`; its plan also identifies Message Content as the recommended Developer Portal intent.

Optional `--html FILE` adds a deterministic standalone checklist, copy controls, explicit Discord navigation, pinned follow-up commands, and exact plan evidence without a token, external asset, background request, persisted browser state, automatic browser launch, or overwrite. The terminal plan remains complete without HTML.

### Create the safest first configuration

From a canonical process-owned private directory, keep the token in a secret-capable launching environment, verify one exact guild, save the complete non-secret policy in one file, and test the full MCP path:

```bash
export DISCORD_BOT_TOKEN
printf 'Discord bot token: '
read -r -s DISCORD_BOT_TOKEN
printf '\n'
npx --yes guildctl@2.2.1 setup \
  --npx \
  --config ./guildcontrol.json \
  --preset server-observer \
  --guild-id YOUR_GUILD_ID
npx --yes guildctl@2.2.1 host --npx --config ./guildcontrol.json --html ./guildcontrol-host-activation.html
```

On PowerShell 7.1 or newer, read the token into the current process without displaying it or placing its value in command history, then run the same commands:

```powershell
$env:DISCORD_BOT_TOKEN = Read-Host "Discord bot token" -MaskInput
```

Enter each displayed multi-line shell command on one line in PowerShell; the `npx` arguments remain the same. With older Windows PowerShell, use an MCP host secret facility or protected token file instead of a token literal in command history.

If the launcher, container runtime, or orchestrator mounts the token as a file, select that input instead. The path must be absolute, the file must already exist for verified setup, and `--token-file` cannot be combined with `--token-env` or an ambient `DISCORD_BOT_TOKEN`:

```sh
npx --yes guildctl@2.2.1 setup \
  --npx \
  --config ./guildcontrol.json \
  --preset server-observer \
  --guild-id YOUR_GUILD_ID \
  --token-file /run/secrets/discord_bot_token
```

The `server-observer` preset exposes guild metadata, roles, permission diagnostics, connector health, content-free activity, and tool discovery without enabling writes, the Gateway, telemetry, persistence, or Message Content access. Setup is the first-run readiness gate: it validates the strict policy, verifies the application and bot, audits the exact guild installation, stores public IDs and a credential reference but never the token, and prints the launch descriptor. A ready setup exits successfully even when it reports non-blocking warnings for deliberate review. `route_discord_goal` safely routes later discovery, reads, and reviewed planning, never mutation; it creates bookkeeping keys itself instead of asking the operator to invent them.

The versioned file is the only policy boundary. It covers identity, explicit read modes, typed reusable exact-ID groups, notification and thread behavior, tools, capabilities, scopes, limits, storage, Gateway, runtime, and observability. A typical deployment has one JSON policy and one external bot-token secret. The [JSON Schema](guildcontrol.config.schema.json), `config show`, and `config explain` support secret-free inspection; managed profiles use the same document.

Operational commands require `--config FILE`, `--profile NAME`, or the non-secret `GUILDCONTROL_CONFIG_FILE` selector. Ambient policy variables are rejected and there is no alternate environment-policy or automatic import mode. The offline `migrate` planner never becomes a runtime policy source. Running `setup` without a preset verifies an existing policy without rewriting it, while a preset explicitly creates or replaces the selected target.

### Connect with the one-click bundle or a generated adapter

After setup reports `ready`, compatible MCPB hosts can import `guildcontrol-2.2.1.mcpb` from the [immutable GitHub Release](https://github.com/j-256/guildcontrol/releases) or MCP Registry. Select the strict config and enter only the token through the sensitive prompt. The verified bundle supports macOS, Windows, and Linux, duplicates no policy field, embeds privacy and dependency evidence, and completes a real unpacked MCP handshake.

For a file-backed token or another host, `host` emits deterministic adapters for Claude Code, Codex, Cursor, VS Code, Gemini CLI, and common MCP JSON. Optional `host detect` reports plausible hosts from metadata only. `host plan` and `host apply` review and install one static JSON projection without resolving credentials or replacing unrelated entries; Codex receives an exact reviewable TOML projection, and `--inspect-host-file` reports exact JSON drift without returning observed values. The [connection guide](docs/getting-started.md#7-connect-the-mcp-host) covers setup and verification.

Once the host is connected, the first useful request can stay natural and narrow:

```text
Show me the channels in Discord server YOUR_GUILD_ID using GuildControl MCP. Do not make changes.
```

`config validate`, `doctor`, and `smoke` are optional assurance and recovery tools after successful setup. Offline `doctor` can inspect policy without an available credential; `--online` contacts Discord only when it is available, while `smoke` verifies a child MCP handshake. Human doctor output shows actionable warnings and failures; add `--verbose` for every check or `--json` for complete evidence. Doctor exits 1 for warnings, including `ready with warnings`.

```sh
npx --yes guildctl@2.2.1 config validate ./guildcontrol.json
npx --yes guildctl@2.2.1 doctor --config ./guildcontrol.json --online
npx --yes guildctl@2.2.1 smoke --config ./guildcontrol.json
```

### Review any policy replacement

Keep the active policy unchanged while editing a separate candidate, then use the integrated review path:

```sh
npx --yes guildctl@2.2.1 config workbench \
  ./guildcontrol.json \
  --html ./guildcontrol-workbench.html
npx --yes guildctl@2.2.1 config replace \
  ./guildcontrol.json \
  ./guildcontrol.candidate.json
```

`config replace` prints the plan before named confirmation, recomputes under lock, writes atomically, keeps a backup, and verifies the result. Detached review remains available:

```sh
npx --yes guildctl@2.2.1 config plan \
  ./guildcontrol.json \
  ./guildcontrol.candidate.json
npx --yes guildctl@2.2.1 config apply \
  ./guildcontrol.json \
  ./guildcontrol.candidate.json \
  --plan-digest SHA256_FROM_THE_PLAN \
  --confirm ACTIVE_POLICY_NAME
```

The private workbench keeps edits in memory until explicit candidate download and has no secret, network, persistence, Discord, active-file write, or approval authority. Both application paths reread the files, reject identity or file drift, and preserve a recoverable backup. The active document remains the only policy source.

Review recent write outcomes and durable cross-process claims from the same selected policy without making a Discord request or resolving its credential:

```sh
npx --yes guildctl@2.2.1 activity \
  --config ./guildcontrol.json \
  --html ./guildcontrol-activity.html
```

The bounded review collapses each activity into its newest outcome, retains superseded history, joins durable claims only through content-free digests, and warns on every unsettled state. Its optional private explorer adds search and filters but cannot contact Discord, resolve a claim, retry an operation, or persist browser state. Use `coordination resolve` only after stopping the owner and checking the exact Discord state and audit log.

Feature policy uses the same document shape. Reviewed features retain separate capabilities, exact scopes, bounded limits, and documented toolsets; single-member authority never grants batch authority. No environment-policy interface, legacy alias, fallback parser, or automatic migration layer exists.

Use `channel-reader` only when bounded message history, caller-retained channel catch-up, and native search are needed. It requires at least one exact channel:

```sh
npx --yes guildctl@2.2.1 setup \
  --npx \
  --config ./discord-reader.json \
  --preset channel-reader \
  --guild-id YOUR_GUILD_ID \
  --channel-id YOUR_CHANNEL_ID
```

### Expand the policy through review

Keep first setup read-only, then enable one additive recipe through integrated review. `message-channel` is the narrowest first write: plain sends, replies, connector-owned edits in exact channels or eligible child threads, and exact-target typing. `coordination-channel` adds directed notes; `channel-publisher` adds broader publishing; `guild-starter` adds reviewed public layouts with nonprivileged `GUILDS` evidence; `guild-builder` adds blueprint lifecycle; `incident-response` adds lockdown; and [`direct-messenger`](docs/reference.md#exact-one-to-one-private-message-lifecycle) adds exact-user private messaging. Every recipe reports permissions, intents, scopes, risks, and exclusions.

```sh
npx --yes guildctl@2.2.1 recipe list
npx --yes guildctl@2.2.1 recipe enable message-channel ./guildcontrol.json \
  --channel-id YOUR_MESSAGE_CHANNEL_ID
npx --yes guildctl@2.2.1 recipe enable direct-messenger ./guildcontrol.json \
  --user-id EXPECTED_RECIPIENT_USER_ID
npx --yes guildctl@2.2.1 recipe enable guild-starter ./guildcontrol.json \
  --guild-id YOUR_GUILD_ID
```

The detached automation path remains explicit:

```sh
npx --yes guildctl@2.2.1 recipe plan guild-starter ./guildcontrol.json \
  --guild-id YOUR_GUILD_ID
npx --yes guildctl@2.2.1 recipe apply guild-starter ./guildcontrol.json \
  --guild-id YOUR_GUILD_ID \
  --plan-digest SHA256_FROM_THE_PLAN \
  --confirm guild-starter
```

Both paths show the complete policy delta, requirements, risks, warnings, and path-bound evidence without a secret or Discord request. Application recomputes, requires name confirmation, rejects drift, and keeps a backup. Recipes grant no Discord authority.

Online doctor verifies identity, complete ID-only installation drift, and application posture. Smoke launches `serve`, negotiates stable MCP over stdio, validates catalogs and read-only status, writes nothing to Discord, and shuts down configured runtimes. See the [operator reference](docs/reference.md#operator-cli).

### Build from source

```sh
git clone https://github.com/j-256/guildcontrol.git
cd guildcontrol
npm run deps:locked
npm run build
node dist/bin.js catalog --check
```

The exact [installation](docs/reference.md#install), [operator CLI](docs/reference.md#operator-cli), and [configuration](docs/reference.md#configuration) references cover standalone configuration, managed profiles, OCI bind mounts, progressive discovery, toolsets, allowlists, optional Gateway modes, observability, and every independently gated feature.

## Capability map

| Area | Selected capabilities |
| --- | --- |
| Discovery and reads | Scoped guild, channel, message, thread, forum, member, moderation, audit, application, event, voice, and configuration reads; exact-ID parsing and attachment access; caller-retained multi-channel catch-up, native search, bounded recall, aggregate activity, and privacy-minimized outputs |
| Messages and communities | Idempotent delivery; authority-free directed notes and exact-message task coordination; reviewed private messages; Components V2, remote-free embeds, attachments, reactions, polls, crossposts, forwarding, threads, pins, and exact deletion |
| Guild structure | Deterministic starters and caller-retained blueprints; additive channels, roles, forums, permissions, onboarding, AutoMod, and publications; reviewed cloning, ordering, metadata, synchronization, and retirement |
| Members and moderation | Privacy-minimized directories and ban audits; reviewed exact-member moderation, roles, nicknames, verification, voice, and thread membership; resumable batches, native bulk bans, and protected guild pruning |
| Community configuration | Application, command, linked-role, monetization, webhook, integration, invite, template, profile, settings, Community, expression, soundboard, event, Stage, and AutoMod audits and reviewed lifecycles |
| Operations | Progressive tool discovery and packaged documentation search; resources and prompts; model-neutral playbooks; strict configuration, profiles, host guides, presets, and recipes; content-free audit and coordination; bounded Gateway and native Interaction runtimes; OpenTelemetry diagnostics |

Capabilities are exposed only when their toolset and policy gates are selected. A toolset narrows the callable surface but never grants Discord or local write authority. Browse the exact [tool reference](docs/reference.md#tools), [resources](docs/reference.md#resources), and [prompts](docs/reference.md#prompts).

## Safety model

Discord permissions are the outer boundary. Connector policy narrows that authority further.

- Production traffic uses fixed Discord REST and vetted Gateway origins; runtime configuration cannot redirect credentials
- Each Gateway shard counts every successful outbound event in one rolling connection budget, bounds caller-command pressure below reserved lifecycle capacity, and discards queued exact-ID requests on every connection boundary
- Exact scopes cover guilds, channels, roles, members, features, and HTTPS link origins
- Guild tools reject DMs. Private-message tools require an independent exact ordinary-user allowlist and caller-known one-to-one channel IDs, support only plain text or bounded static Components V2, suppress mentions, enforce fixed anti-spam limits, and provide no discovery, bulk targeting, callback-bearing components, arbitrary embed URLs, or Gateway feed
- Components V2 links require exact HTTPS origins; the connector never fetches them or follows redirects
- Components V2 request Buttons use connector-generated HMAC IDs, require ready exact native Interaction ingress, create only a private bounded request for an exact allowlisted user, and never run a Discord write or administration action automatically
- Discord names, messages, embeds, components, filenames, URLs, and other remote text are treated as untrusted data rather than instructions
- Discord content may be returned transiently when explicitly requested, but it is not cached, journaled, exported, or persisted by the connector
- New invite codes and URLs are delivered only through a caller-selected exclusive private file; MCP results, lifecycle records, errors, logs, and telemetry remain bearer-capability-free
- Incoming-webhook credentials remain in exclusive exact-ID private files; MCP accepts only webhook and message IDs, and persistent activity, receipts, errors, logs, and telemetry remain credential- and content-free
- Entitlement writes are separately scoped; test deletion needs creation proof, and consumption stores only a fulfillment-reference hash
- Every consequential write retains its domain-specific permission, freshness, approval, audit, readback, and uncertainty gates
- Message deletion accepts exact message IDs only and preserves every independent deletion gate
- Channel deletion requires exact scope, complete dependency and permission evidence, irreversible-loss acknowledgement, and an exact target-bound blueprint attestation or no-artifact choice before signed review and Gateway absence proof; it never reads messages
- Role deletion requires exact scope, zero holders, complete hierarchy, permission, and dependency evidence, irreversible-loss acknowledgement, an exact target-bound blueprint attestation or no-artifact choice, signed review, and fresh absence plus survivor-preservation proof
- Guild pruning requires a separate exact guild allowlist, optional exact include-role allowlist, explicit acknowledgement that Discord does not reveal the candidate IDs, protected-identity role shields, a fresh native estimate below both requested and configured ceilings, signed review, and one non-retried request with strict count-only outcome evidence
- Guild incident actions require one exact allowlisted guild, complete known `MANAGE_GUILD` or owner evidence, future deadlines no more than 24 hours ahead, signed review, one non-retried sparse write, and exact response plus fresh readback; clearing protection early is treated as destructive
- Privileged-intent enablement accepts only Guild Members or Message Content when the strict policy proves that intent is required or recommended, preserves every observed non-target application flag, and excludes Presence, disabling, generic application editing, and automatic remediation

The common reviewed-write sequence starts from the execute tool. Callers can still supply a digest from a detached plan when independent review requires it:

```text
exact execute request -> fresh keyed plan -> human review -> signed approval
             -> final fresh-plan match -> pending content-free evidence
             -> one non-retried write -> exact readback or quarantine
```

Already-current requests are record-free no-ops where the Discord operation permits that proof. A known client rejection settles as failed. A transport failure, server failure, malformed success response, or missing readback is uncertain and must not be retried blindly. Durable claims keep the affected exact targets quarantined across connector processes until safe receipt evidence or explicit operator resolution proves what may proceed.

Read the [complete safety model](docs/reference.md#safety-model) and [security policy](SECURITY.md) before enabling a write surface.

## Trust and verification

| Command | What it proves | Discord access |
| --- | --- | --- |
| `guildctl catalog --check --json` | Exact production MCP inventories, access lifecycles, schemas, annotations, zero-value policy-completion proof, plan-review app authority, execution guard, and stable contract and resource digests | None |
| `guildctl catalog --html FILE` | Guided product tour and searchable rendering of the exact negotiated contract, including schemas, filters, completions, app source, resources, and safety guidance | None |
| `guildctl preset show server-observer --json` | Exact read-only tools, scope requirements, intents, and zero-write boundary for the recommended preset | None |
| `guildctl preset install server-observer --application-id ID --guild-id ID [--html FILE]` | Fixed-origin, guild-locked bot authorization plan plus an optional credential-free standalone checklist with exact digests and post-install commands | None |
| `guildctl config workbench ACTIVE --html FILE` | Private offline in-memory editor and explicit candidate download for one validated schema-v2 policy, with no active-file write or approval authority | None |
| `guildctl config replace ACTIVE CANDIDATE` | Integrated complete review, named confirmation, fresh locked recomputation, atomic replacement, backup, and readback | None |
| `guildctl config plan ACTIVE CANDIDATE --json` | Complete candidate policy, exact semantic changes, authority impacts, tool exposure, warnings, identity lock, and fresh path-bound digest | None |
| `guildctl config apply ACTIVE CANDIDATE --plan-digest DIGEST --confirm ACTIVE_NAME` | Exact fresh local policy replacement with stale-file rejection, atomic publication, and a recoverable prior version | None |
| `guildctl recipe show guild-starter --json` | Exact additive capability, scope, toolset, permission, intent, Gateway-evidence, and risk contract | None |
| `guildctl recipe plan guild-starter FILE --guild-id ID --json` | Complete proposed policy, exact changes, requirements, warnings, and source-, path-, request-, and contract-bound digest | None |
| `guildctl migrate plan SOURCE [--html FILE] [--json]` | Complete release-exact source-tool accounting, safer target routes, staged switching commands, and deterministic plan evidence without reading or changing either deployment | None |
| `guildctl activity --config FILE [--html FILE] [--json]` | Bounded current write lifecycles, superseded history, exact content-free evidence, and correlated durable claims with warning status when operator attention is required | None |
| `guildctl doctor --config FILE` | Local Node.js, credential availability, identity pins, policy, scope, tool surface, lossless read-response budget, Gateway, observability, and write-gate diagnostics, even before a secret is available | None |
| `guildctl doctor --config FILE --online` | Strict policy, pinned application and bot identity, intent flags, complete bounded ID-only installed-guild inventory, and exact configured-scope drift | Read-only |
| `guildctl smoke --config FILE` | Spawned stdio negotiation, discovery, annotations, and connector identity through the selected policy | Read-only |
| `guildctl host detect`; `host`; `host plan`; `host apply` | Opt-in metadata-only candidate detection, credential-free adapters, reviewed freshness-bound static JSON installation with a recoverable backup and rollback, and value-free drift inspection | None |
| `npm run container:verify` | Pinned-base build, non-root filesystem and process restrictions, secret-free metadata, deterministic catalog identity, MCP behavior, and safe credential failure | None |
| `npm run container:index:verify` | Exact multi-architecture index, platform configurations and blobs, and per-platform provenance plus SBOM records | Public image registries only |
| `npm run pack:verify` | Reproducible archives, exact package contents, isolated install, installed CLI, deterministic catalog evidence and HTML, and content-free MCP handshake | None |
| `npm run mcpb:verify` | Byte-identical cross-platform bundles, strict ZIP metadata and contents, embedded evidence, Registry hash binding, isolated token mapping, and a real unpacked MCP handshake | None |
| `npm run security:check` | Dependency vulnerabilities, registry signatures, and attestations | Public package registry only |

`catalog --check --json` is designed for independent comparison. It needs no credential, ignores ambient connector authority, returns no configured completion identifiers, executes no Discord operation, opens no Gateway, exports no telemetry, and creates no activity record. Matching contract digests identify matching normalized MCP instructions, server capabilities, tool access lifecycles, policy-completion bindings, tool schemas and annotations, prompts, resources, templates, safety response, review app, and execution guard.

Release automation verifies reproducible npm and MCPB artifacts, hardened OCI, SPDX inventories, and signed provenance, then publishes an immutable GitHub Release before registering `app.lasers.guildcontrol/discord`. Normal releases require one protected npm-stage approval and one promotion approval; package, Release, and Registry authority stays in separate jobs. Provenance is a build receipt, an SBOM a parts list, and an attestation their artifact-and-issuer binding; none certifies security or completeness. See the [evidence boundaries](docs/reference.md#provenance-sbom-and-attestation-boundaries) and [release runbook](docs/releasing.md).

## Architecture

The stdio transport, Discord REST client, scope policy, domain services, reviewed planning, durable coordination, activity log, observability, Gateway, and MCP adapter remain separate. Production uses native `fetch`, TypeScript ESM, exact dependencies, and lazy schemas that skip registration cost for excluded tools.

This keeps transport, permission evidence, local authority, reviewed writes, persistence, and MCP presentation independently testable. New capabilities must fit those boundaries rather than add a generic Discord dispatcher.

## Documentation

- [Verified documentation portal](https://docs.guildcontrol.lasers.app/)
- [First verified read and initialization recovery](docs/getting-started.md)
- [Safety and usability decision record](docs/safety-usability.md)
- [Release-exact migration from another Discord MCP](docs/migration.md)
- [Product boundaries, honest limitations, and host compatibility](docs/limitations.md)
- [Source-audited field comparison](docs/comparison.md)
- [Complete operator and capability reference](docs/reference.md)
- [Setup and operator support](SUPPORT.md)
- [Privacy policy](PRIVACY.md)
- [Security model and reporting](SECURITY.md)
- [Release and independent verification runbook](docs/releasing.md)
- [MCP Registry manifest](server.json)
- [AGPL-3.0-only license](LICENSE)

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for changes and [SUPPORT.md](SUPPORT.md) for setup and operator questions. Default tests use injected transports and do not contact Discord:

```sh
npm run metadata:check
npm run config:schema:check
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run pack:verify
npm run mcpb:verify
npm run container:verify
npm run container:index:verify
npm run security:check
```

Live probes are explicit and read-only by default. No default verification command fetches message content or performs a Discord mutation.

## License

AGPL-3.0-only
