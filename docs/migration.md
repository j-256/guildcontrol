# Migrate from another Discord MCP

[Getting started](getting-started.md) | [Field comparison](comparison.md) | [Complete reference](reference.md) | [Privacy policy](../PRIVACY.md) | [Support](../SUPPORT.md)

GuildControl MCP can produce a complete, release-exact switching plan for every competitor in the scored local comparison. The planner maps audited source tools into operator outcomes, then routes each outcome to this connector's least-privilege presets, additive recipes, exact target tools, and reviewed lifecycles.

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
| `cappyeo@0.26.0` | Public version tag resolved to a commit-pinned source snapshot | `channel-reader` |
| `hypark@0.1.1` | Public version tag resolved to a commit-pinned source snapshot | `channel-reader` |
| `jaimen-bell@0.1.1` | Exact PyPI release and matching commit-pinned public source without a source tag | `server-observer` |
| `oratorian@1.1.4` | Public version tag resolved to a commit-pinned source snapshot | `channel-reader` |
| `pasympa@2.2.0` | Public version tag resolved to a commit-pinned source snapshot | `channel-reader` |
| `targeted-reader@1.0.0` | Version-matching commit-pinned public source without a source tag or installable Registry package | `channel-reader` |

Each entry includes its Registry identity, commit-pinned evidence URL, audit fidelity, complete source-tool inventory digest, mapping summary, limitations, and manifest digest. Untagged evidence stays visibly weaker; the planner does not turn a version-matching public source snapshot into a tagged-source claim.

## Generate the exact plan

Choose the source ID shown by `migrate list`:

```bash
guildctl migrate plan cappyeo@0.26.0
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
guildctl migrate plan cappyeo@0.26.0 --json
```

JSON is suitable for review automation, but it is not a generated policy. `configurationImported`, `argumentsTranslated`, and `hostSettingsChanged` remain `false`.

## Open the private interactive guide

Add `--html FILE` to create a standalone guide without replacing an existing file:

```bash
guildctl migrate plan cappyeo@0.26.0 --html ./cappyeo-migration.html
```

The file is created exclusively with mode `0600`. It contains the exact plan, source and target evidence, searchable outcome cards, disposition filters, tool-level accounting, copyable commands, visible limitations, and an in-memory checklist. It loads no external asset, makes no automatic request, persists no browser state, and embeds neither the output path nor a credential value. Activating a source or Registry evidence link is an explicit browser navigation.

`--html` can accompany `--json`. The JSON output then includes the HTML export receipt with its path, byte size, plan digest, and HTML digest.

## Read the dispositions correctly

`supported` means the target has the complete operator outcome and the planner names its canonical route. It does not mean source arguments can be copied unchanged or that Discord permissions are ready.

`review-required` means the outcome exists but its authority, input, result, or failure model materially changes. Immediate source writes commonly become a plan and execute pair with exact local scope, permission and hierarchy proof, signed approval, durable coordination, non-retry behavior, exact readback, and ambiguity quarantine. Review the named target tools and enable only the required recipe or workbench fields.

Cappyeo's bundled component-template send maps to `compile_component_template` before the ordinary component-message lifecycle. Select one typed local template and supply its named fields, or rebuild a custom layout with `preview_component_layout`; never copy a source `vars` map, custom ID, remote-media URL, or raw component tree into the target request. A source link button may become only an explicit strict `cta` or callback-free `link-row`: inspect the complete normalized destination, add its exact canonical HTTPS origin to `scopes.componentLinkOrigins`, and retain the destination through review. A source custom-ID button has no mechanical mapping. Only when its intended outcome is one private bounded request may you replace it with a `request-row` label and optional style after separately configuring exact native Interaction guild, channel, and user scope and installing the managed command; the connector generates a new authenticated ID and never preserves the source callback route. Selects, modals, generic callbacks, and automatic actions remain intentionally excluded. Compilation sends nothing, inspects no policy, and grants no authority. Copy its exact returned `components` and reviewed notification IDs into `plan_component_message`, then retain the exact request through execution and verification.

`intentionally-excluded` means no connector equivalent is offered. For example, connector-owned AI calls and unrelated third-party emoji search stay outside this model-neutral Discord boundary. Keep reasoning in the MCP host or selected model provider and send only the deliberate Discord operation to the connector.

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

The [field comparison](comparison.md#migration-planning-head-to-head) records the released source that inspired this outcome and the remaining differences. Tests require the migration catalog to cover the exact Registry links in the scored local release table, require every source inventory to match its audited digest, and require every source tool to appear in one outcome group. A source release change must update the source audit, manifest, documentation, and comparison together.
