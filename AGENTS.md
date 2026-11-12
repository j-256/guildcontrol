# Project guidance

## Scope

This repository implements a local stdio MCP server for Discord guild access. Keep the transport, Discord REST client, scope policy, reviewed planning, deletion and administration services, activity log, and MCP adapter separate so each can evolve independently.

## Safety invariants

Never print, persist, return, or commit a Discord bot token. Production code must use the fixed Discord API origin; only tests may inject another transport or origin.

Portable profiles may persist only a non-secret credential-variable name, verified application and bot IDs, exact read scope, selected tool policy, and Gateway policy. Keep write authority and every local path or telemetry setting outside profiles, reject unsafe profile files, and never let ambient read policy override an activated profile.

Message deletion must remain exact-ID based and require every existing gate: the environment toggle, deletion-channel allowlist, destructive MCP annotation, MCP host write approval, a fresh matching keyed plan digest, signed MCP request state, interactive confirmation, a final fresh-plan check, and a pending content-free audit record. Do not weaken or bypass one gate because another exists.

Invite role assignment must remain an optional extension of finite private-file invite creation with a separate capability and exact role allowlist. Preserve complete Gateway topology and unobfuscated metadata for modeled channels, strict standard-role hierarchy, `MANAGE_ROLES`, guild permission-subset proof, modeled-channel permission checks, explicit signed partial coverage for unsupported channel types, minimum new-member impact review, explicit persistent-grant acknowledgement, signed confirmation, selected-role coordination, exact create-response and independent readback agreement, and warnings that existing members can accept, granted roles survive invite expiry or deletion, and later role or overwrite edits can change authority. Never add temporary role-grant membership, an immediate path, caller-authored role payloads, automatic role removal, or capability-bearing MCP output.

Member administration must remain exact-ID based and require every existing gate: the environment toggle, administration-guild allowlist, protected-user denylist, verified bot and target identities, complete permission and strict role-hierarchy evidence, destructive MCP annotation, MCP host write approval, a fresh matching keyed plan digest, signed MCP request state, interactive confirmation, a final fresh-plan check, and a pending content-free audit record. Do not add an immediate moderation path.

Global application-command changes must remain bound to the pinned current application and require explicit complete contexts and installation types, fresh complete application support and localized inventory evidence, exact-ID update and deletion targets, global exposure and cross-guild permission-reset acknowledgements, destructive MCP annotation, MCP host write approval, a fresh matching keyed plan digest, signed MCP request state, interactive confirmation, durable application-wide coordination, one-shot reservation, pending content-free audit, one non-retried mutation, and exact complete survivor readback. Never add application-default inheritance, bulk overwrite, raw or partial definitions, name-targeted writes, type changes, command-permission writes, automatic retries, or rollback.

Guild scaffolds must remain additive-only, exact-guild scoped, and limited to bounded roles, categories, text channels, and forum channels. Preserve verified application and bot binding, complete role and visibility-bounded channel evidence, exact symbolic parent graphs, permission and capacity checks, fresh reviewed frontiers, signed confirmation, durable content-free request and per-step checkpoints, non-retried writes, exact readbacks, and restart-safe fail-closed resumption. A newly created category must force a fresh plan before child creation. Never add edits, moves, assignments, permission overwrites, deletion, rollback, or best-effort continuation to the scaffold workflow.

Never persist message content, attachment URLs, embeds, components, Discord audit-log reasons, Discord usernames or profile names, role names, channel names or topics, scaffold symbols, or avatars. Activity records and operation receipts may contain Discord identifiers, timestamps, numeric action parameters, domain-separated hashes, plan digests, strategies, sanitized errors, and outcomes.

Unsupported direct channel types remain opaque topology. Their presence alone must not block member-role changes, invite role grants, or role deletion. Preserve required authorization and modeled-risk checks, disclose exact partial analysis coverage in plans and confirmations, bind unsupported topology into freshness evidence, and retain discovered role references as deletion blockers. Never substitute a browser, user session, or user token for bot access.

## Development

Target Node.js 22 or newer and TypeScript ESM. Keep production dependencies small and pinned exactly. Use native fetch for Discord REST calls.

Run npm run typecheck, npm test, and npm run build before committing. Live tests must be explicitly invoked, read-only by default, and must not fetch message content unless their command and documentation say so.

Use comments only when they explain a non-obvious invariant, and do not end comments with periods.
