# Migrate from another Discord MCP

[Getting started](getting-started.md) | [Field comparison](comparison.md) | [Complete reference](reference.md) | [Privacy policy](../PRIVACY.md) | [Support](../SUPPORT.md)

GuildControl MCP can produce a complete, release-exact switching plan for every competitor in the scored local comparison and retains the audited versions offered by previous published GuildControl releases. The planner maps audited source tools into operator outcomes, then routes each outcome to this connector's least-privilege presets, additive recipes, exact target tools, and reviewed lifecycles.

It is deliberately a planner, not an importer. It does not scan another checkout, read an existing policy or MCP host file, resolve a credential, contact a network or Discord endpoint, rewrite prompts or arguments, or change anything. Source environment variables never become an alternate policy interface. The only environment value shown in staged commands is a non-secret reference to the bot-token variable selected by a new schema-v2 configuration file.

## Supported source releases

Run `migrate list` instead of guessing an alias:

```bash
guildctl migrate list
guildctl migrate list --json
```

The catalog contains these immutable source IDs:

| Source ID | Audit basis | Baseline |
| --- | --- | --- |
| `cappyeo@0.25.0` | Public version tag resolved to a commit-pinned source snapshot | `channel-reader` |
| `cappyeo@0.26.0` | Public version tag resolved to a commit-pinned source snapshot | `channel-reader` |
| `cappyeo@0.27.1` | Public version tag resolved to a commit-pinned source snapshot | `channel-reader` |
| `cappyeo@0.31.1` | Public version tag resolved to a commit-pinned source snapshot | `channel-reader` |
| `cappyeo@0.32.0` | Public version tag resolved to a commit-pinned source snapshot | `channel-reader` |
| `cappyeo@0.32.1` | Public version tag resolved to a commit-pinned source snapshot | `channel-reader` |
| `cappyeo@0.34.1` | Exact tagged source, including conditional discovery, architecture alias, and optional Event tools | `channel-reader` |
| `hypark@0.1.1` | Public version tag resolved to a commit-pinned source snapshot | `channel-reader` |
| `jaimen-bell@0.1.1` | Exact PyPI release and matching commit-pinned public source without a source tag | `server-observer` |
| `oratorian@1.1.4` | Public version tag resolved to a commit-pinned source snapshot | `channel-reader` |
| `orygn@2.0.0` | Exact tagged source with complete selected-toolset registration accounting | `channel-reader` |
| `pasympa@2.1.1` | Public version tag resolved to a commit-pinned source snapshot | `channel-reader` |
| `pasympa@2.2.0` | Public version tag resolved to a commit-pinned source snapshot | `channel-reader` |
| `pasympa@2.4.0` | Exact tagged source covering full, selected-toolset, and read-only registration | `channel-reader` |
| `pr5ias@1.1.1` | Exact `1.1.1` tag matches npm source and published files; includes dynamic-pack and raw dispatch tools | `channel-reader` |
| `qungtai@0.2.0` | Exact tagged source with complete recursively loaded operation descriptors | `channel-reader` |
| `targeted-reader@1.0.0` | Version-matching commit-pinned public source without a source tag or installable Registry package | `channel-reader` |
| `thestreamcode@0.2.0` | Exact tagged runtime source; runtime equivalence to the distinct npm publishing source was checked | `channel-reader` |
| `willuhm@1.1.1` | Public version tag resolved to a commit-pinned source snapshot | `channel-reader` |

This table describes the catalog built from this source revision. The [field comparison](comparison.md) scores the latest audited release of each competitor, while older rows here preserve release-exact planning for source versions offered by published GuildControl releases. An installed package may have a different catalog; use its `migrate list` output to select a supported ID.

Each entry includes its Registry identity, commit-pinned evidence URL, audit fidelity, complete source-tool inventory digest, mapping summary, limitations, and manifest digest. Untagged evidence stays visibly weaker; the planner does not turn a version-matching public source snapshot into a tagged-source claim.

## Generate the exact plan

Choose the source ID shown by `migrate list`:

```bash
guildctl migrate plan cappyeo@0.34.1
```

The terminal report accounts for every audited source tool exactly once. Each outcome group includes:

- The source tool names covered by that group
- A `supported`, `review-required`, or `intentionally-excluded` disposition
- Canonical target tools when an outcome exists
- A named additive recipe when one safely represents the policy change
- The operator action required when exact configuration needs the offline workbench
- The trust-model change between the source operation and the target lifecycle

The report also binds the source manifest and complete inventory to the negotiated production catalog. A target tool missing from that catalog stops planning instead of producing stale guidance. The final plan digest covers the normalized source, target, mappings, staged commands, limits, and non-execution disclosures.

Add `--json` for deterministic machine-readable evidence:

```bash
guildctl migrate plan cappyeo@0.34.1 --json
```

JSON is suitable for review automation, but it is not a generated policy. `configurationImported`, `argumentsTranslated`, and `hostSettingsChanged` remain `false`.

## Open the private interactive guide

Add `--html FILE` to create a standalone guide without replacing an existing file:

```bash
guildctl migrate plan cappyeo@0.34.1 --html ./cappyeo-migration.html
```

The file is created exclusively with mode `0600`. It contains the exact plan, source and target evidence, searchable outcome cards, disposition filters, tool-level accounting, copyable commands, visible limitations, and an in-memory checklist. It loads no external asset, makes no automatic request, persists no browser state, and embeds neither the output path nor a credential value. Activating a source or Registry evidence link is an explicit browser navigation.

`--html` can accompany `--json`. The JSON output then includes the HTML export receipt with its path, byte size, plan digest, and HTML digest.

## Read the dispositions correctly

`supported` means the target has the complete operator outcome and the planner names its canonical route. It does not mean source arguments can be copied unchanged or that Discord permissions are ready.

`review-required` means the outcome exists but its authority, input, result, or failure model materially changes. Immediate source writes commonly become a plan and execute pair with exact local scope, permission and hierarchy proof, signed approval, durable coordination, non-retry behavior, exact readback, and ambiguity quarantine. Review the named target tools and enable only the required recipe or workbench fields.

Cappyeo's bundled component-template send maps to `compile_component_template` before the ordinary component-message lifecycle. Select one typed local template and supply its named fields, or rebuild a custom layout with `preview_component_layout`; never copy a source `vars` map, custom ID, remote-media URL, or raw component tree into the target request. A source link button may become only an explicit strict `cta` or callback-free `link-row`: inspect the complete normalized destination, add its exact canonical HTTPS origin to `scopes.componentLinkOrigins`, and retain the destination through review. A source custom-ID button has no mechanical mapping. Only when its intended outcome is one private bounded request may you replace it with a `request-row` label and optional style after separately configuring exact native Interaction guild, channel, and user scope and installing the managed command; the connector generates a new authenticated ID and never preserves the source callback route. Selects, modals, generic callbacks, and automatic actions remain intentionally excluded. Compilation sends nothing, inspects no policy, and grants no authority. Copy its exact returned `components` and reviewed notification IDs into `plan_component_message`, then retain the exact request through execution and verification.

Cappyeo 0.32.0's `members_bulk_add_role` maps to the separately scoped `plan_bulk_member_role_change` and `execute_bulk_member_role_change` lifecycle. Select one exact role and 2-25 exact members per reviewed batch; use the single-member role workflow for one target, and split larger source batches only after reviewing each target set and the previous batch's terminal evidence. Source success counts and member IDs do not substitute for GuildControl's durable child checkpoints or fresh continuation plan.

Cappyeo's `channels_modify` with `lock_permissions: true` can move a child and copy the destination category's overwrites in one PATCH. GuildControl maps an existing child's synchronization to `plan_channel_permission_sync` and `execute_channel_permission_sync` after complete review. A move to another category first needs the separate reviewed channel-placement workflow, followed by a fresh synchronization plan for the new live parent. Inspect the intermediate access state and do not treat the two reviewed changes as one atomic source operation.

`intentionally-excluded` means no complete connector equivalent is offered. Connector-owned AI calls, arbitrary API dispatch, background automations, content archives, generic workflow execution, and automatic restore stay outside this boundary. A nearby manual route is not an equivalent executor. Keep a separately chosen source service if an excluded outcome is required; do not silently drop it when switching.

## Release-specific differences

The [completed comparable-release audits](comparison.md#current-comparable-release-audits) record both useful source capabilities and the limits of replacement. Exact source names, supported target routes, unsupported fields, and trust changes appear in each generated plan. `review-required` may cover a deliberately narrower reauthored payload; inspect its instructions before treating a grouped source tool as fully replaceable.

For Cappyeo 0.34.1, the inventory includes progressive wrappers, the architecture alias, and optional Event tools, not only the canonical catalog. Older published source IDs remain available with their earlier inventory scope; use the new audited ID for the complete conditional union. Progressive wrappers become outcome discovery followed by canonical typed calls. The architecture entry point requires a newly authored supported blueprint and grants no model generation or execution authority. Generic workflows, existing-guild convergence and selective restore, durable Event delivery and accepted-event-bound replies have no complete target equivalent. Host-side tool sequences and separately reviewed message or DM workflows do not port their durable execution state or delivery guarantees.

Cappyeo's application-object settings are distinct from global bot-user profile changes. Whole-registry command overwrite and caller-OAuth command-permission writes remain excluded. Native response/follow-up creation has a private bounded target route; source reusable-token response-message reads, edits, and deletes do not. Public widgets, global premium sticker packs, Stage suppression/request-to-speak state, standalone DM channel opening, arbitrary user lookup, thread-member enumeration, and arbitrary typing signals also have no matching target lifecycle. Supported entitlement consumption and test-entitlement changes use their own reviewed application-bound routes.

For PaSympa 2.4.0, combined active/archive thread discovery becomes separate bounded target reads with explicit coverage and caller state. Membership-screening form terms and descriptions are a different Discord resource from Community onboarding and an individual member's verification bypass. The screening tools remain excluded, including in the corrected historical mappings. Classic embed DMs and forum-post thread deletion also lack equivalent target lifecycles; text, Components V2, private-file DMs, and thread archive/lock are distinct alternatives. An event-associated invite is not reproduced merely by creating an ordinary invite.

For OrygnsCode 2.0.0, mixed build execution, structural undo, scheduling, stored blueprint management, runtime subscription changes, and fuzzy cross-resource name resolution are not imported. A caller-retained structural capture is only the supported subset of source blueprint export. Source default per-server bot-profile edits must not become global profile changes: the self nickname has an exact member route, while per-guild avatar/banner/bio and image restoration are not supported. Source global username/avatar/banner edits require the separate global acknowledgement. Member-role filters must be replaced with an independently enumerated finite exact-ID set and reviewed batches; their automatic filtered executor is not preserved. Thread and voice occupant enumeration and thread/post retirement are also excluded.

For qungtai 0.2.0, existing-invite target-user administration and processing jobs, recurring-event occurrence exceptions, join-request review, account connections, arbitrary public-only resources, standalone DM creation, thread-member enumeration, and persisted attachment downloads are excluded. GuildControl separately supports a new finite private-file invite with exact-user acceptance and verified target-user processing, plus recurring scheduled-event series changes. Transient native attachment inspection returns no saved-file path. Source bulk guild-role updates mean role positioning, not member-role grants. Verification-bypass changes use their own reviewed lifecycle; whole-role-set replacement and unsupported member flags are not copied.

For TheStreamCode 0.2.0, ordinary structural and administration operations have reviewed routes, but persistent snapshots, stored diffs, automatic pre-restore backups, cross-guild restore, and optional restore deletion are not imported. Caller-retained capture and additive reconstruction do not preserve that recovery system or its data. The tagged runtime matches the npm publication source, while publishing metadata and workflow differ; the audit does not attribute the tag's workflow to the published package.

For pr5ias 1.1.1, source packs and nested discovery become canonical target discovery and explicit calls. The raw API dispatcher, automatic template importer/builder, persistent role-menu/ticket/welcome/rule/staff-command runtime, generic jobs, filtered background role jobs, content backups and replay, feedback reports, multi-bot credential routing, in-band authority changes, and guild creation are excluded. A manually authored blueprint or smaller reviewed role batch is an adjacent alternative. Source rich compound send/pin/crosspost/repost is not reproduced atomically by separate target operations. Remote embed media and identity overrides must not enter the target's plain or static message contracts.

Across these releases, new standalone target channel creation supports categories, text channels, and forum channels. Source creation of voice, Stage, announcement, or media channels and atomic create-with-overwrites/private/position requests are not reproduced; cloning an existing channel is a different operation. Do not create an exposed intermediate channel and assume a later permission write makes the source private-creation request equivalent. Separate guild profile, settings, Community, onboarding, voice, forum, and template resources retain their own lifecycles. Unsupported guild media, locale, arbitrary feature toggles, Community disablement, forum applied-tag/pin edits, raw webhook payloads, and compound multi-field writes are not silently imported.

Target direct-channel retirement covers exact guild categories, forums, media, Stage, text, and voice channels. A generic source delete-channel tool does not gain a thread or DM deletion route through that mapping. Forum-post deletion and thread-member enumeration remain distinct unsupported outcomes.

## Follow the staged path

First generate `guildctl migrate plan SOURCE` as shown above. That report emits the source-specific commands in this sequence; `catalog --check` only verifies the installed target contract.

1. Run the report's emitted `guildctl catalog --check` command to fingerprint the installed target contract without credentials or execution.
2. Run the same report's emitted `guildctl setup --preset ...` command from a canonical private directory after replacing placeholder Discord IDs. This creates a new strict schema-v2 policy and references the token without embedding its value.
3. For each needed recipe, run the emitted `recipe plan`, review the complete proposed configuration and risks, then use its fresh digest in the emitted `recipe apply` command. Skip recipes for outcomes you do not need.
4. Use `config workbench` for an exact capability not represented by a named recipe. Download and validate a candidate, then use the separate config plan and confirmed apply workflow. Do not edit broad authority into the source plan.
5. Run `host --config ... --html ...` to generate the selected MCP host projection without changing the host. For a supported static JSON destination, use `host plan` and its exact confirmed `host apply` to preserve unrelated state with a recoverable backup, then run read-only host inspection. Otherwise merge only the owned projection manually.
6. Run offline doctor, online doctor, and smoke in that order, then reload the host and complete one read-only request. A clean smoke result proves a real stdio negotiation and read-only connector path, not correct third-party host translation or every future Discord operation.
7. Check each required source outcome against the complete mapping before disabling the old server. Revoke any obsolete source credential separately; this planner never changes Discord Developer Portal state.

Placeholder values such as `GUILD_ID`, `CHANNEL_ID`, `USER_ID`, and `PLAN_DIGEST` are intentionally invalid until replaced with reviewed operator input. Commands never contain inferred IDs or a token value.

## Configuration remains a clean break

Migration guidance does not restore legacy environment-policy compatibility. Normal operation still accepts one strict non-secret configuration file or one non-secret managed profile, plus only the exact secret sources referenced by it. A source project's broad write toggle, allowlist variables, transport mode, or provider settings are evidence to review, not policy to import.

The planner recommends the narrowest read-only preset that can represent the source's normal read outcome. Write authority is separate. A named recipe is additive and cannot remove or silently redistribute existing policy. Other features require explicit workbench review because a generic recipe would overstate equivalence.

## Privacy and custody

Planning is fully offline. It reads the compiled target catalog in memory, but it does not execute a target tool. It reads no source file, local policy, host setting, environment value, secret file, token, Discord content, activity journal, or coordination record. It starts no child process, opens no Gateway, exports no telemetry, and creates no activity record.

The source manifests contain public release identities, public evidence URLs, public tool names, target route names, and durable explanatory text. They contain no local path, Discord identifier, username, role name, channel name, message content, credential, or host-specific state.

## What the plan cannot prove

The plan cannot prove that the source deployment used every released tool, that private patches match public source, that prompts use compatible arguments, that a target bot has Discord permission, that an MCP host honors approval and elicitation, or that the old credential was revoked. Run the emitted checks and inspect the live host configuration.

Hosted or non-auditable Registry entries are not offered as source IDs because their exact released implementation cannot be mapped honestly. A different source version also requires a new audited manifest. Do not use the nearest version as a substitute.

## Troubleshooting

If the source ID is rejected, run `guildctl migrate list` and copy the complete `product@version` value. Unversioned names and source paths are intentionally invalid.

If HTML creation reports that the target exists, move the existing file or choose a new path. The exporter never overwrites operator-owned content. A failed partial write is removed before the command reports failure.

If planning reports a missing target tool, stop and run `guildctl catalog --check --json`. The installed package and migration manifest do not describe the same production contract. Reinstall one exact package release rather than editing the plan.

If setup or live verification fails, use the [recovery ladder](getting-started.md#recovery-ladder). Do not broaden Discord permissions, add policy environment variables, paste a token into static host configuration, or skip the exact failing layer.

## Evidence maintenance

The [field comparison](comparison.md#migration-planning-head-to-head) scores the latest audited source releases and records the remaining differences. Tests require the migration catalog to cover every Registry link in the scored local release table, retain the source IDs offered by published GuildControl releases, match every source inventory to its audited digest, and assign every source tool to one outcome group. A newly audited source release needs a source audit, manifest, and documentation update. Update the scored comparison when that release becomes the latest audited version; keep older supported manifests available.
