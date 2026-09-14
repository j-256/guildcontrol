# Product boundaries and host compatibility

[Getting started](getting-started.md) | [Safety and usability decisions](safety-usability.md) | [Complete reference](reference.md) | [Privacy policy](../PRIVACY.md) | [Project overview](../README.md) | [Support](../SUPPORT.md)

GuildControl MCP is designed for an operator-owned bot, a local stdio MCP host, exact least-privilege policy, transient Discord content, and review before consequential changes. This guide helps decide whether that model fits before a token is created, a host is configured, or a write capability is enabled.

The [complete reference](reference.md) remains authoritative for each tool's exact permissions, privacy projection, unsupported Discord states, planning evidence, and recovery behavior.

## Fit check

| Need | Fit | Product behavior |
| --- | --- | --- |
| Inspect or administer exact guilds through your own bot | Designed fit | The operator owns the Discord application, bot installation, token custody, policy, and effective Discord permissions |
| Start read-only and add narrowly reviewed capabilities | Designed fit | Presets establish bounded reads; additive recipes and explicit policy gates expose later workflows without granting Discord authority themselves |
| Catch up once across selected exact channels without creating an inbox | Designed fit | Every channel is preflighted before bounded chronological preview reads, while independent next cursors stay with the caller and no content or unread state is persisted |
| Find a vaguely remembered conversation without building a local archive | Designed fit | One to five caller-supplied literal variants use Discord's live relevance index, fuse duplicate targets, and return freshly verified bounded current context without connector-owned persistence |
| Read one exact current guild attachment without saving it | Designed fit | Fresh message evidence binds the exact attachment before transient native or embedded MCP delivery within the read budget |
| Publish a common Components V2 announcement or status card | Designed fit | Typed local templates compile into the bounded static DSL, then use the same reviewed plan, signed execution, durable receipt, and exact verification lifecycle |
| Send without notifying anyone or occasionally notify one exact user | Designed fit | Notifications are suppressed independently of message delivery; policy can disable them, use a strict ID allowlist, or require signed review for an unlisted exact visible user |
| Synchronize one exact child channel to its live parent category | Designed fit | A separate reviewed workflow replaces the complete overwrite set only after structural impact, connector authority, future propagation, and stopped-concurrency review |
| Receive private slash-command or request-button requests and send bounded follow-ups without exposing Discord's Interaction credential | Designed fit | Exact scopes, authenticated button sources, ephemeral responses, default token disposal, and rotating bounded continuations preserve custody |
| Keep Discord content out of connector-owned storage and telemetry | Designed fit | Content is projected transiently and excluded from activity, operation, coordination, diagnostic, and telemetry records |
| Use a compatible one-click MCPB host with an environment-backed token policy | Designed fit | Import one deterministic cross-platform bundle, select the complete strict policy, and enter only the token through the host's sensitive prompt |
| Use another local MCP host or a file-backed token policy | Designed fit | `host` emits a pinned model-neutral launch contract, deterministic host adapters, and an optional private interactive activation guide |
| Verify that one static generated JSON host projection has not drifted | Designed fit | `host --adapter ID --inspect-host-file FILE` compares the explicitly selected JSON destination with the exact installed-release adapter and returns only fixed path- and value-free evidence |
| Plan a switch from a scored local GuildControl MCP release | Designed fit | `migrate` accounts for every audited source tool and maps outcomes into target presets, recipes, tools, and trust-model changes without reading or changing either deployment |
| Use read and planning tools in a host without interactive elicitation | Partial fit | Reads and plans remain usable, but reviewed writes cannot execute through that host |
| Use a third-party shared bot or hosted remote endpoint | Not provided | Each operator runs a local process with their own bot; the project operates no bot, relay, HTTP service, or account |
| Use a Discord user account or selfbot | Not supported | The connector accepts a Discord bot token and verifies the pinned application and bot identities |
| Mirror, archive, index, or train on Discord content | Not supported | The connector provides bounded transient reads, not a background content database or retrieval corpus |
| Save inbound attachments to a connector-managed inbox or download directory | Not supported | Exact attachment reads return transient MCP content and deliberately create no local file; any host-side retention falls outside the connector's custody claims |
| Target destructive work by display name or let the connector guess | Not supported | Consequential workflows use exact IDs and fail closed on incomplete or changed evidence |
| Run unattended destructive automation with retries or rollback | Not supported | Reviewed writes require interactive confirmation and stop on ambiguity; external effects are never guessed, blindly retried, or automatically reversed |
| Prepare bounded recovery evidence before one exact channel or role retirement | Designed fit | A stable two-pass blueprint capture returns short-lived process-bound exact-target attestations; deletion planning verifies the matching current captured projection or requires explicit acknowledgement that no artifact is retained |
| Create a complete Discord backup or lossless restore point | Not supported | Blueprints, recovery attestations, and native Guild Templates are bounded structural aids, not backups, and provide no message recovery, original-ID restoration, automatic rollback, or lossless restore |

## Custody and privacy boundary

The operator creates and installs the Discord bot, chooses its Discord permissions, stores its token, selects exact local policy, and controls the MCP host. The connector does not create a shared service identity and does not receive operator credentials through a maintainer-operated service.

Standalone configuration and portable profiles store a credential reference, never the token value. The runtime still has to read that referenced secret to authenticate to Discord. Protect the secret at its source and in the host's process environment; the connector cannot make a token safe after it is copied into a host configuration, shell history, transcript, crash report, screenshot, or untrusted secret facility.

The connector's non-persistence claims cover connector-owned profiles, activity, operation and coordination state, generated evidence, diagnostics, and telemetry. They do not control retention by Discord, the MCP host, the model provider, the operating system, terminal capture, reverse proxies added by an operator, or other software on the machine. Tool inputs and transient results may contain Discord content when a selected capability requires it, so the host's transcript and data policy remain part of the trust boundary.

Discord permissions remain the outer authority boundary. Local policy can only narrow what the bot can do; it cannot grant a Discord permission, bypass channel overwrites or role hierarchy, or prove consent from a message recipient.

## MCP host compatibility

The one-click MCPB path requires a host that implements manifest version 0.3, local file selection, sensitive string input, stdio launch, and the declared Node.js runtime. The same bundle supports macOS, Windows, and Linux. Its form does not duplicate policy fields: the selected strict config remains the only source for identity, scope, tools, capabilities, writes, Gateway, storage, and observability. The prompted token is mapped in memory only to the exact environment variable declared by that policy. The bundle refuses a file-backed credential policy because replacing that custody contract with an interactive secret would be an unsafe implicit migration.

MCPB compatibility is a host capability, not a universal MCP requirement. The project verifies its own manifest, archive, unpacked runtime, and stdio catalogs, but cannot guarantee that every host implements MCPB inputs, file pickers, sensitive-value retention, Node.js discovery, approval, or elicitation correctly. The host and its secret store remain inside the operator's trust boundary. Use the generated adapter path when the host does not support the bundle or the policy deliberately uses a protected token file.

`host --npx --config FILE --html PRIVATE_FILE` emits a credential-free pinned launch contract plus adapters for Claude Code, Codex, Cursor, VS Code, Gemini CLI, and common MCP JSON. Each binds its destination, secret strategy, requirements, limits, and schema source to the activation digest. The private no-network guide adds copy controls and a read-only verification request. It may contain Discord IDs, local paths, or an encoded Cursor URI, so do not share or commit it. Generated adapter details and host-specific custody limits are in the [complete reference](reference.md#configuration).

`host detect` is an opt-in check of fixed marker path types. It reads no candidate content or credential, contacts no network, and changes nothing. `onboard --detect-host` selects only one unambiguous candidate; otherwise the operator chooses. Markers can be stale or absent and prove neither installation nor compatibility. Reported paths are private.

`--adapter ID` selects one adapter; `--json` emits all. Generation does not edit. For JSON adapters, `host plan --adapter ID --host-file FILE` reviews one static change; `host apply` requires its fresh digest and name confirmation, preserves unrelated entries, backs up, verifies, and reports rollback. Codex TOML remains manual. Detection never supplies a destination to either path, and neither returns existing values or proves host loading.

`--inspect-host-file FILE` reads only the caller-selected JSON adapter target and returns a fixed value- and path-free comparison without editing. POSIX ownership and mode checks apply where available. A match proves the generated projection, not host loading, secret availability, approval, startup, or Discord access. Use `smoke` and a real host read for executable and end-to-end evidence.

| Host capability | Requirement | Behavior when absent or incomplete |
| --- | --- | --- |
| MCPB manifest 0.3, file selection, and sensitive string input | Required only for one-click import | Use the generated host adapter without changing the selected policy or placing a token in static JSON |
| Local process execution over stdio | Required | The connector exposes no Streamable HTTP or hosted transport |
| Node.js 22+ for npm or source and 22-26 for MCPB | Required | Use `smoke --config FILE` to separate package or stdio failure from host translation failure |
| Direct access to the generated static JSON destination | Optional for exact drift inspection | Compare manually when the host stores an opaque database, generated runtime state, or another format; the connector never discovers or extracts it |
| Forwarding the named environment secret or preserving access to a referenced private credential file | Required | Startup fails without falling back to another token or legacy policy source |
| MCP initialization, `tools/list`, and `tools/call` | Required | The operational server cannot negotiate or expose its typed tools |
| A host that can accept the complete tool catalog | Required for `tools.surface: full` | Use the progressive surface only when the host reliably refreshes tools after `notifications/tools/list_changed` |
| `notifications/tools/list_changed` refresh | Required for progressive discovery | Hidden canonical tools stay unavailable until the host refreshes; discovery never grants a tool omitted by policy |
| MCP resources and prompts | Optional | Equivalent canonical tools remain available; prompts never execute a write |
| Native image, audio, embedded blob, or resource-link handling | Required only for attachment consumption | The connector emits standard MCP content and an equivalent private binary resource, but each host and model decides which media types it can render or pass through |
| MCP Apps support | Optional | Plan results still include complete text and structured JSON; the app adds display-only review and has no approval or execution authority |
| Interactive MCP elicitation | Required for reviewed writes | Execution returns a signed input request and performs no mutation unless the host returns the exact accepted response bound to that request |
| Write-aware host approval | Required operator control for writes | Tool annotations expose read, write, and destructive intent, but the connector cannot attest how a host renders or enforces its own approval interface |

Signed elicitation state detects a changed or orphaned confirmation round and binds the response to the reviewed request. It does not identify the human approver, certify the host's user interface, or replace the host's own write approval. A host without elicitation remains suitable for read-only and plan-only policy.

Progressive discovery is an ergonomics mode, not an authority mechanism. It reveals only canonical schemas already permitted by configured toolsets. Choose `full` when a host does not implement reliable list-change refresh, even if that means presenting a larger initial catalog.

Reviewed execution normally starts by calling the exact execute tool without `planDigest`. The connector computes the fresh plan, presents it through signed elicitation, and repeats the service-level plan check before mutation. Standalone planners and explicit digests remain available for detached review. This removes digest copy and paste but does not make a host without elicitation write-capable.

Local component templates and public guild starters are finite authority-free compilers, not remote loaders, callback registries, or live simulations. Reviewed workflows still enforce exact link origins, targets, permissions, and one fresh executable frontier at a time. Use the bounded layout DSL or a caller-authored blueprint when the catalog does not fit; planning alone resolves future IDs and state.

## Discord and operational constraints

- Effective access is the intersection of Discord installation grants, bot-role hierarchy, guild and channel overwrites, privileged-intent state, connector policy, selected toolsets, and action-specific gates
- A bot cannot manage a member or role at or above its own highest role, and some Discord resources remain invisible without the exact permissions needed to prove a safe result
- Message Content, Guild Members, and other sensitive surfaces remain unavailable unless the relevant feature documents and verifies their separate requirement; setup does not enable privileged intents by default
- The installed-guild audit completes bounded ID-only pagination and exact configured-versus-installed classification, but Discord does not provide an atomic multi-page snapshot; rerun it after concurrent bot installations or departures settle, and treat an audit beyond 400 installed guilds as explicitly unsupported rather than partial success
- A current-bot username, avatar, or banner change affects every guild installation and direct conversation for that bot; Discord exposes post-upload media state but not enough evidence to prove remote image-byte equality
- Guild departure immediately ends the bot's access and has no connector rollback or re-entry path. Durable collection claims cannot identify every resource-only workflow or external Discord actor, so the required stopped-work acknowledgment remains an operator-controlled quiescence boundary
- Discord rate limits are dynamic and may include traffic outside this process. Connector diagnostics report only observed local evidence and never claim a complete IP-wide total
- Bounded GET requests can retry transport failures, trustworthy rate-limit delays, and selected transient service responses within the configured wait ceiling. Each accepted response still passes the original identity, ordering, completeness, byte, and shape checks. Non-GET requests do not inherit this retry behavior
- Discord attachment delivery URLs are signed and expiring. Each native attachment read refetches the exact message, accepts only the current bound URL, and can fail if the attachment changes, disappears, expires during delivery, or cannot fit the configured MCP response budget; it never retries or saves a fallback file automatically
- A Components V2 link-button allowlist constrains only the exact normalized first-hop HTTPS origin. The connector does not fetch the destination, resolve DNS, follow redirects, inspect remote content, or prove where a Discord client ultimately arrives
- Multi-channel catch-up is a bounded caller-directed read, not an inbox, unread counter, watcher, or complete history. Initialization may omit older messages; a full catch-up page may leave newer messages; bot and webhook filtering advances across omitted traffic; cursors are channel-specific caller state; and a boundary contradiction or deletion race fails the whole call instead of guessing continuity
- Conversation recall is bounded literal search, not semantic retrieval or complete history. It depends on caller-supplied phrase variants and Discord's index, discards every partial candidate when any phrase reports indexing, and rejects the whole result when a ranked target changes before current context verification
- Discord task coordination is bounded and non-persistent. It is not a queue, mailbox, directory, identity, authorization, or liveness system; routing labels and reactions are visible and spoofable
- Parent-thread inheritance is a dynamic scope. When enabled, eligible child threads created later beneath an exact parent can become readable or writable for the documented message operations after fresh relationship, lifecycle, membership, and permission proof. Governance, reactions, typing, deletion, and administration retain exact child scope
- Notification scope does not establish recipient consent. `allowlist` is a stable automation ceiling, while `reviewed` permits an unlisted exact visible user only through a workflow with signed mention review. Role, `@everyone`, and `@here` notifications remain disabled
- Discord can change between planning, confirmation, mutation, and readback. Relevant drift invalidates a plan; a known post-write difference may complete with drift, while an ambiguous boundary is reported as uncertain
- Parent-category permission synchronization is a complete overwrite replacement, not per-target inheritance. It enables future parent propagation only while exact synchronization remains, reviews member overwrites structurally without fetching profiles or proving every member's combined effective access, and cannot pause Discord administrators, other bots, or connectors using a different state root
- Native Interaction continuations exist only in the running process, share pending-request capacity, expire with the original broker lifetime, and allow at most three follow-ups. A restart, shutdown, refusal, uncertain transmission, verification drift, or failed completion record ends the capability without recovery or replay
- A command-processing signal is a one-shot transient hint with no Discord readback and a documented ten-second expiry. Duplicate coalescing is process-local, so a restart can repeat the hint for the same still-fresh source; use it only before work expected to take several seconds, never as completion evidence or a wait primitive
- Guild recovery attestations expire after 30 minutes, are valid only in the connector process that created them, cover only the represented blueprint projection and reported omissions, and prove neither that the caller retained the blueprint nor that Discord content or original IDs can be restored
- Guild blueprint role, hierarchy, channel, and overwrite intent is same-guild and caller-authored. Capture omits `roleConfigurations`, `roleOrder`, `channelMetadata`, `channelOrders`, and `channelPermissionOverwrites`. Role and channel order accept exact or receipt-bound references; channel chains converge bottom-up, preserve overwrites, and require explicit reparenting acknowledgement. Overwrites require an allowlisted exact channel plus an exact member or exact or receipt-bound role. Parent-category synchronization remains separate. A matching receipt proves only fresh exact state; drift needs new reviewed intent and key
- Discord errors, lost responses, failed readback, or [shutdown deadline expiry](reference.md#operational-stdio-shutdown) can leave a write uncertain. Pending recovery evidence is preserved; reserved operations are never retried automatically
- Unknown future fields, unsupported channel or message types, incomplete inventories, hidden permission overwrites, and malformed Discord responses are rejected or projected out according to the exact workflow rather than guessed
- A successful exact workflow proves only that operation and readback. It does not establish future Discord availability, permission stability, recipient consent, or correctness of another capability

For an uncertain write, inspect the exact Discord target and audit evidence, retain the caller's original request and operation key, and use the workflow's documented verification or coordination-resolution path. Resolution releases a local quarantine only after operator review; it does not undo Discord state or make blind replay safe.

## Deliberately unsupported

| Shortcut or surface | Boundary | Supported direction |
| --- | --- | --- |
| Generic Discord REST dispatcher or raw request body | No broad escape hatch around typed schemas and policy | Use the narrow canonical tool whose evidence and privacy projection match the action |
| Fuzzy name, ordinal, or model-selected destructive targets | Names are untrusted presentation, not authority | Discover the resource, retain its exact ID, then plan the exact action |
| Name-adopting or broad best-effort declarative reconciliation | A logical match can select the wrong duplicate, while partial retry after ambiguous writes can repeat effects | Use exact or receipt-bound blueprint convergence for supported role, channel, ordering, and permission fields; use the standalone reviewed workflows for one-off placement or parent-category overwrite synchronization |
| Immediate delete, moderation, administration, or structural mutation | A destructive annotation alone is not sufficient protection | Call the reviewed execute tool for a fresh elicited plan, or use detached plan and digest mode; both retain final freshness, one-shot evidence, and readback |
| Arbitrary permission-copy source, raw overwrite replacement, or best-effort bulk synchronization | A complete overwrite set can alter access for every matching role or member and create future propagation | Use the exact direct-child parent-category workflow with all three acknowledgments and structural review |
| Blind retry, best-effort continuation, compensation, or automatic rollback after uncertainty | Discord may have accepted an operation whose response was lost | Stop, inspect exact state, and follow the workflow's recovery contract |
| Raw Interaction token tools or arbitrary follow-up CRUD and rich payloads | An Interaction token is a reusable short-lived credential whose guild scope cannot be proven from the opaque value alone | Use the broker's exact allowlisted ingress, default-close initial response, and rotating bounded ephemeral plain-text continuation |
| Generic typing loop, arbitrary presence, or remote wait primitive | Repeated ambient signals create spam, imply progress the connector cannot verify, and lack an exact initiating user intent | Use one `signal_command_processing` call bound to a fresh ordinary-user message that explicitly mentions the verified bot |
| Caller-supplied remote media or attachment URL, arbitrary media fetch, or raw attachment forwarding | External media inputs add credential, tracking, substitution, and content risks | For inbound guild content, select exact channel, message, and attachment IDs so the connector can bind a fresh Discord-supplied signed URL internally; for outbound files, use only a separately enabled bounded local-file workflow where one exists |
| Caller-selected custom-ID button, select, modal, or arbitrary callback registration | A visible control that invokes the application adds inbound event authority and a new state, identity, replay, and abuse boundary | Use callback-free style-5 link rows for reviewed outbound navigation or the connector's HMAC-authenticated request rows for private bounded broker requests; other interactive behavior needs a separately designed lifecycle |
| Wildcard, unallowlisted, non-HTTPS, or credential-bearing component link | A broad or ambiguous destination policy hides where reviewed messages can send a reader | Configure each exact canonical HTTPS origin, review every complete normalized destination, and treat redirects and final destinations as unverified |
| Connector-owned message archive, unread mailbox, high-water file, background watcher, vector index, or Gateway content cache | Persistent content and ambient channel state expand privacy, ambiguity, and breach impact | Use bounded live reads or `catch_up_messages` with explicit exact channels and caller-retained cursors, and keep any downstream retention outside the connector's claims |
| Shared bot, multi-tenant relay, public HTTP listener, or hosted control plane | Shared custody changes the threat and authorization model | Run one local stdio connector per operator-managed bot boundary |
| Native-process memory parity | V8's default low-memory profile reduces Node overhead but remains above a compact native process | Use the default profile, or `--standard-runtime` when CPU throughput matters more |
| Environment-variable policy compatibility layer | Multiple ambient policy sources make effective authority harder to review | Use one strict non-secret configuration file or one managed profile; environment input is limited to the config selector and referenced secrets |
| Automatic source, prompt, argument, policy, credential, or host migration | Apparent field compatibility can silently widen authority or misstate an operation's failure model | Use the release-exact offline planner, review every outcome disposition, and apply only the emitted strict setup and policy workflows |
| Full server backup, cross-guild clone, or lossless restore | Discord APIs and privacy rules do not expose a complete reversible image | Use caller-retained blueprints, target-bound recovery attestations, or native Guild Templates only within their documented omissions and never as rollback authority |
| Automatic adoption of unknown Discord fields or object types | Silent interpretation can expand authority or leak data | Upgrade to a version that explicitly models and tests the new contract |

These are architectural boundaries, not a backlog promise. A future capability needs its own authority, privacy, failure, recovery, and verification design before it can become supported.

## What verification proves

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| `catalog --check --json` | The installed credential-free MCP contract is internally consistent and execution is guarded | Bot identity, Discord access, host configuration, or live tool behavior |
| `config validate FILE` | The non-secret policy matches the strict schema and local invariants | Credential validity, Discord permissions, or MCP negotiation |
| `doctor --config FILE` | Local runtime, policy, path, and credential-availability diagnostics without contacting Discord | Whether the token authenticates or the bot can access the intended guild |
| `doctor --config FILE --online` | Pinned application and bot identity, complete bounded ID-only bot-installation inventory, exact configured-scope drift, and application posture through documented read-only calls | Channel visibility, every feature permission, an atomic cross-page snapshot, a host launch, or any Discord write |
| `smoke --config FILE` | The selected packaged stdio entrypoint negotiates MCP, exposes the expected catalogs, starts configured optional runtimes, and completes its documented read-only identity path | Correct translation into a third-party host or every operational tool |
| `host detect` | Plausible hosts from an explicit metadata-only local probe | Installation, operator intent, compatibility, configuration content, secret availability, startup, approval, or Discord access |
| `host`, `host plan`, or `host apply` | Exact mapping, reviewed metadata-fresh publication, recoverable backup, reread, rollback result, and host read request | Host loading, schema acceptance, secret resolution, startup, Discord access, or approval |
| Verified MCPB plus its checksum and attestation | Exact deterministic bundle structure, embedded dependency and privacy evidence, isolated token mapping, and an unpacked stdio catalog handshake | A particular host's import behavior, token retention, approval UX, Discord access, or freedom from software defects |
| Default automated tests and coverage | Deterministic contracts against injected transports, malformed evidence, policy boundaries, and failure cases without contacting Discord | Universal correctness against Discord's live service or every host implementation |
| Package and container verification | Reproducible contents, safe packaged startup, contract identity, and documented runtime constraints | Live Discord behavior or absence of software defects |
| Provenance, SBOMs, and attestations | Artifact origin, build inputs and process claims, component inventories, and digest bindings within their documented trust model | Security certification, vulnerability absence, license compliance, or completeness |
| A completed reviewed write with exact readback | The exact requested operation reached its workflow's terminal evidence state | Future stability, another workflow, or an unobserved side effect outside Discord's returned evidence |

The default suite is intentionally offline and uses injected transports. Treat a passing release as strong contract evidence, not as a claim that every Discord mutation has been exercised against every guild shape, host, permission layout, and API response. Test newly enabled authority in a private guild with the narrowest policy and inspect the first plan before execution.

See [provenance, SBOM, and attestation boundaries](reference.md#provenance-sbom-and-attestation-boundaries) for the precise supply-chain claims.

## Choose the next path

- If the fit and custody model work, complete the [first verified read](getting-started.md) before enabling writes
- Use the [safety and usability decision record](safety-usability.md) to choose explicit read, notification, thread, discovery, and review modes
- If the host lacks dynamic tool refresh, use the full tool surface; if it lacks elicitation, keep the policy read-only or plan-only
- If a specific capability is needed, inspect its toolset, scope, permissions, gates, privacy projection, and recovery contract in the [complete reference](reference.md)
- If setup or negotiation fails, use the [recovery ladder](getting-started.md#recovery-ladder) and [support guide](../SUPPORT.md)
- If the question concerns secrets, stored evidence, or vulnerability reporting, read the [security policy](../SECURITY.md)
- If artifact identity matters, use the [release and independent verification runbook](releasing.md)
