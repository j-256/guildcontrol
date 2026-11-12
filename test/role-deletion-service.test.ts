import assert from "node:assert/strict"
import test from "node:test"

import type {
  ActivityEntry,
  ActivityList,
  ActivityStore,
} from "../src/activity-log.js"
import {
  DISCORD_CHANNEL_TYPES,
  DISCORD_LIMITS,
  SCHEMA_VERSION,
} from "../src/constants.js"
import {
  DISCORD_AUTO_MODERATION_EVENT_TYPES,
  DISCORD_AUTO_MODERATION_TRIGGER_TYPES,
  type DiscordAutoModerationRuleSummary,
  type DiscordGuildApplicationCommandPermissions,
  type DiscordGuildEmojiSummary,
  type DiscordGuildIntegrationSummary,
  type DiscordGuildOnboarding,
  type DiscordGuildRoleMemberCounts,
  type DiscordInviteSummary,
} from "../src/discord-client.js"
import {
  DiscordApiError,
  RoleDeletionEvidenceError,
  RoleDeletionExecutionError,
  RoleDeletionOperationConflictError,
  RoleDeletionPlanChangedError,
} from "../src/errors.js"
import type {
  GatewayChannelLayoutListener,
  GatewayChannelLayoutSnapshot,
  GatewayChannelLayoutSource,
  GatewayChannelLayoutStatus,
} from "../src/gateway-channel-layout.js"
import type {
  OperationKind,
  OperationReceipt,
  OperationReservation,
  OperationStore,
} from "../src/operation-store.js"
import { DISCORD_PERMISSIONS } from "../src/permissions.js"
import { ScopePolicy } from "../src/policy.js"
import { guildBlueprintRoleRecoveryStateDigest } from "../src/guild-blueprint-capture-service.js"
import { createGuildRecoveryAttestation } from "../src/guild-recovery-attestation.js"
import {
  normalizeRoleDeletionRequest,
  type RoleDeletionRequest,
  RoleDeletionService,
  type RoleDeletionServiceClient,
} from "../src/role-deletion-service.js"
import type {
  DiscordChannel,
  DiscordGuild,
  DiscordGuildMember,
  DiscordRole,
} from "../src/types.js"

const APPLICATION_ID = "910000000000000001"
const BOT_ID = "920000000000000001"
const GUILD_ID = "930000000000000001"
const UNCERTAIN_GUILD_ID = "930000000000000099"
const OWNER_ID = "930000000000000002"
const CHANNEL_ID = "940000000000000001"
const TARGET_ROLE_ID = "950000000000000001"
const BOT_ROLE_ID = "950000000000000002"
const ADDED_ROLE_ID = "950000000000000003"
const COMMAND_ID = "960000000000000001"
const EMOJI_ID = "970000000000000001"
const INTEGRATION_ID = "970000000000000002"
const ONBOARDING_OPTION_ID = "970000000000000003"
const AUTOMOD_RULE_ID = "970000000000000004"
const OPERATION_KEY = "role-deletion-operation-001"
const PLAN_KEY = new Uint8Array(32).fill(29)
const RECOVERY_KEY = new Uint8Array(32).fill(37)

function role(
  id: string,
  name: string,
  permissions: bigint,
  position: number,
  overrides: Partial<DiscordRole> = {},
): DiscordRole {
  return {
    color: 0,
    colors: {
      primary_color: 0,
      secondary_color: null,
      tertiary_color: null,
    },
    flags: 0,
    hoist: false,
    icon: null,
    id,
    managed: false,
    mentionable: false,
    name,
    permissions: permissions.toString(),
    position,
    unicode_emoji: null,
    ...overrides,
  }
}

function channel(guildId: string): DiscordChannel {
  return {
    guild_id: guildId,
    id: CHANNEL_ID,
    name: "private-channel",
    parent_id: null,
    permission_overwrites: [],
    position: 0,
    type: DISCORD_CHANNEL_TYPES.text,
  }
}

function layoutSnapshot(
  channels: readonly DiscordChannel[],
  guildId: string,
  revision = 1,
): GatewayChannelLayoutSnapshot {
  return {
    channels: channels.map((entry) => ({
      channelId: entry.id,
      obfuscated: false,
      parentChannelId: entry.parent_id ?? null,
      position: entry.position ?? 0,
      type: entry.type,
    })),
    complete: true,
    guildId,
    reason: null,
    revision,
    schemaVersion: SCHEMA_VERSION,
    state: "ready",
    updatedAt: new Date(Date.UTC(2026, 7, 23, 12, 0, revision)).toISOString(),
  }
}

class FixtureLayoutSource implements GatewayChannelLayoutSource {
  layoutEnabled = true
  readonly listeners = new Set<GatewayChannelLayoutListener>()
  snapshot: GatewayChannelLayoutSnapshot

  constructor(channels: readonly DiscordChannel[], guildId: string) {
    this.snapshot = layoutSnapshot(channels, guildId)
  }

  getChannelLayout(guildId: string): GatewayChannelLayoutSnapshot {
    if (guildId !== this.snapshot.guildId) {
      return {
        channels: [],
        complete: false,
        guildId,
        reason: "outside-scope",
        revision: 0,
        schemaVersion: SCHEMA_VERSION,
        state: "unavailable",
        updatedAt: null,
      }
    }
    return structuredClone(this.snapshot)
  }

  getChannelLayoutStatus(): GatewayChannelLayoutStatus {
    return {
      channels: {
        obfuscated: this.snapshot.channels.filter((entry) => entry.obfuscated).length,
        retained: this.snapshot.channels.length,
      },
      enabled: this.layoutEnabled,
      guilds: {
        invalidated: 0,
        pending: 0,
        ready: 1,
        resuming: 0,
        scoped: 1,
        unavailable: 0,
      },
      invalidations: 0,
      schemaVersion: SCHEMA_VERSION,
      updates: this.snapshot.revision,
    }
  }

  subscribeChannelLayouts(listener: GatewayChannelLayoutListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

class MemoryActivityStore implements ActivityStore {
  readonly entries: ActivityEntry[] = []
  failAt: number | null = null

  async append(entry: ActivityEntry): Promise<void> {
    if (this.failAt === this.entries.length + 1) throw new Error("activity unavailable")
    this.entries.push(structuredClone(entry))
  }

  async list(): Promise<ActivityList> {
    return {
      entries: structuredClone(this.entries),
      file: "/private/activity.jsonl",
      skippedLines: 0,
    }
  }
}

class MemoryOperationStore implements OperationStore {
  readonly receipts = new Map<string, OperationReceipt>()
  reserveCalls = 0

  #key(kind: OperationKind, operationKeyHash: string): string {
    return `${kind}:${operationKeyHash}`
  }

  async finish(receipt: OperationReceipt): Promise<void> {
    this.receipts.set(this.#key(receipt.kind, receipt.operationKeyHash), structuredClone(receipt))
  }

  async get(
    kind: OperationReceipt["kind"],
    operationKeyHash: string,
  ): Promise<OperationReceipt | undefined> {
    const receipt = this.receipts.get(this.#key(kind, operationKeyHash))
    return receipt ? structuredClone(receipt) : undefined
  }

  async reserve(receipt: OperationReceipt): Promise<OperationReservation> {
    this.reserveCalls += 1
    const key = this.#key(receipt.kind, receipt.operationKeyHash)
    const existing = this.receipts.get(key)
    if (existing) return { created: false, receipt: structuredClone(existing) }
    this.receipts.set(key, structuredClone(receipt))
    return { created: true, receipt: structuredClone(receipt) }
  }
}

function invite(roleIds: string[] = []): DiscordInviteSummary {
  return {
    channelId: CHANNEL_ID,
    code: "private-invite-code",
    createdAt: "2026-08-23T00:00:00.000Z",
    expiresAt: null,
    flags: 0,
    guildId: GUILD_ID,
    inviterUserId: null,
    maxAge: 0,
    maxUses: 0,
    roleIds,
    targetApplicationId: null,
    targetType: null,
    targetUserId: null,
    temporary: false,
    type: 0,
    unknownFieldCount: 0,
    uses: 0,
  }
}

function emoji(roleIds: string[] = []): DiscordGuildEmojiSummary {
  return {
    animated: false,
    available: true,
    creatorUserId: null,
    id: EMOJI_ID,
    managed: false,
    name: "private-emoji",
    requiresColons: true,
    roleIds,
    unknownFieldCount: 0,
  }
}

function integration(roleId: string | null = null): DiscordGuildIntegrationSummary {
  return {
    accountPresent: true,
    applicationId: null,
    associatedBotUserId: null,
    enableEmoticons: null,
    enabled: true,
    expireBehavior: null,
    expireGracePeriod: null,
    id: INTEGRATION_ID,
    knownScopes: [],
    linkedUserPresent: false,
    revoked: null,
    roleId,
    subscriberCount: null,
    syncedAt: null,
    syncing: null,
    type: "discord",
    unknownFieldCounts: {
      account: 0,
      application: 0,
      bot: 0,
      integration: 0,
      user: 0,
    },
    unknownScopeCount: 0,
  }
}

function onboarding(roleIds: string[] = []): DiscordGuildOnboarding {
  return {
    defaultChannelIds: [],
    enabled: true,
    guildId: GUILD_ID,
    mode: 0,
    prompts: [{
      id: "970000000000000005",
      inOnboarding: true,
      options: [{
        channelIds: [],
        description: "Private onboarding option",
        emoji: null,
        id: ONBOARDING_OPTION_ID,
        roleIds,
        title: "Private onboarding title",
      }],
      required: false,
      singleSelect: false,
      title: "Private onboarding prompt",
      type: 0,
    }],
    unknownEnumCount: 0,
    unknownFieldCount: 0,
  }
}

function automod(roleIds: string[] = []): DiscordAutoModerationRuleSummary {
  return {
    actions: [],
    creatorUserId: BOT_ID,
    enabled: false,
    eventType: DISCORD_AUTO_MODERATION_EVENT_TYPES.messageSend,
    exemptChannelIds: [],
    exemptRoleIds: roleIds,
    guildId: GUILD_ID,
    id: AUTOMOD_RULE_ID,
    name: "Private AutoMod policy",
    trigger: {
      allowList: [],
      keywordFilter: [],
      regexPatterns: [],
      type: DISCORD_AUTO_MODERATION_TRIGGER_TYPES.keyword,
    },
    unknownFieldCount: 0,
  }
}

function commandPermissions(
  roleId?: string,
  guildId = GUILD_ID,
): DiscordGuildApplicationCommandPermissions[] {
  return [{
    applicationId: APPLICATION_ID,
    commandId: COMMAND_ID,
    guildId,
    permissions: roleId
      ? [{ allowed: true, id: roleId, type: 1, unknownFieldCount: 0 }]
      : [],
    unknownFieldCount: 0,
  }]
}

class FixtureClient implements RoleDeletionServiceClient {
  autoModerationRules: DiscordAutoModerationRuleSummary[] = []
  channels: DiscordChannel[]
  commandPermissions: DiscordGuildApplicationCommandPermissions[]
  counts: Record<string, number>
  deleteCalls: Array<{ auditReason: string; guildId: string; roleId: string }> = []
  deleteError: unknown
  deleteMutates = true
  emojis: DiscordGuildEmojiSummary[] = []
  guild: DiscordGuild
  integrations: DiscordGuildIntegrationSummary[] = []
  invites: DiscordInviteSummary[] = []
  member: DiscordGuildMember
  onboardingState: DiscordGuildOnboarding
  roles: DiscordRole[]
  readonly source: FixtureLayoutSource
  afterDelete: (() => void) | undefined

  constructor(guildId = GUILD_ID) {
    const required = DISCORD_PERMISSIONS.MANAGE_GUILD | DISCORD_PERMISSIONS.MANAGE_ROLES
    this.channels = [channel(guildId)]
    this.source = new FixtureLayoutSource(this.channels, guildId)
    this.guild = {
      features: [],
      id: guildId,
      name: "Private guild",
      owner_id: OWNER_ID,
    }
    this.roles = [
      role(guildId, "@everyone", 0n, 0),
      role(TARGET_ROLE_ID, "Private retiring role", 0n, 5),
      role(BOT_ROLE_ID, "connector", required, 10, {
        managed: true,
        tags: { bot_id: BOT_ID },
      }),
    ]
    this.member = {
      roles: [BOT_ROLE_ID],
      user: { bot: true, id: BOT_ID, username: "connector" },
    }
    this.counts = {
      [BOT_ROLE_ID]: 1,
      [TARGET_ROLE_ID]: 0,
    }
    this.commandPermissions = commandPermissions(undefined, guildId)
    this.onboardingState = onboarding()
  }

  async deleteGuildRole(guildId: string, roleId: string, auditReason: string) {
    this.deleteCalls.push({ auditReason, guildId, roleId })
    if (this.deleteError) throw this.deleteError
    if (this.deleteMutates) {
      this.roles = this.roles.filter((entry) => entry.id !== roleId)
      delete this.counts[roleId]
    }
    this.afterDelete?.()
  }

  async getGuild() {
    return structuredClone(this.guild)
  }

  async getGuildChannels() {
    return structuredClone(this.channels)
  }

  async getGuildMember() {
    return structuredClone(this.member)
  }

  async getGuildOnboarding() {
    return structuredClone(this.onboardingState)
  }

  async getGuildRoleMemberCounts(): Promise<DiscordGuildRoleMemberCounts> {
    return structuredClone(this.counts)
  }

  async getGuildRoles() {
    return structuredClone(this.roles)
  }

  async listGuildApplicationCommandPermissions() {
    return structuredClone(this.commandPermissions)
  }

  async listGuildAutoModerationRules() {
    return structuredClone(this.autoModerationRules)
  }

  async listGuildEmojis() {
    return structuredClone(this.emojis)
  }

  async listGuildIntegrations() {
    return structuredClone(this.integrations)
  }

  async listGuildInvites() {
    return structuredClone(this.invites)
  }
}

function policy(guildId = GUILD_ID, audit = true, changes = true): ScopePolicy {
  return new ScopePolicy({
    adminGuildIds: new Set<string>(),
    allowedChannelIds: new Set<string>(),
    allowedGuildIds: new Set([guildId]),
    allowAdministration: false,
    allowDeletions: false,
    allowInteractions: false,
    allowRoleDeletionAudit: audit,
    allowRoleDeletions: changes,
    deleteChannelIds: new Set<string>(),
    interactionChannelIds: new Set<string>(),
    interactionMaxWritesPerMinute: 10,
    interactionMinWriteIntervalMs: 500,
    mentionUserIds: new Set<string>(),
    protectedUserIds: new Set<string>(),
    roleDeletionIds: new Set([TARGET_ROLE_ID]),
  })
}

function request(overrides: Partial<RoleDeletionRequest> = {}): RoleDeletionRequest {
  return {
    acknowledgeIrreversibleRoleLoss: true,
    auditReason: "Reviewed role retirement",
    guildId: GUILD_ID,
    operationKey: OPERATION_KEY,
    recovery: {
      acknowledgeNoRecoveryArtifact: true,
      mode: "none",
    },
    roleId: TARGET_ROLE_ID,
    ...overrides,
  }
}

function fixture(options: {
  client?: FixtureClient
  policy?: ScopePolicy
} = {}) {
  const activityStore = new MemoryActivityStore()
  const client = options.client ?? new FixtureClient()
  const operationStore = new MemoryOperationStore()
  const service = new RoleDeletionService({
    activityStore,
    client,
    clock: () => new Date("2026-08-23T12:00:00.000Z"),
    layoutSource: client.source,
    operationStore,
    planKey: PLAN_KEY,
    policy: options.policy ?? policy(client.guild.id),
    randomId: () => "activity-role-deletion-001",
    recoveryAttestationKey: RECOVERY_KEY,
  })
  return { activityStore, client, operationStore, service }
}

function executionResult(error: unknown): Record<string, unknown> {
  assert.ok(error instanceof RoleDeletionExecutionError)
  assert.ok(error.result && typeof error.result === "object")
  return error.result as Record<string, unknown>
}

test("role-deletion request normalization requires exact irreversible acknowledgement", () => {
  const normalized = normalizeRoleDeletionRequest(request())

  assert.match(normalized.operationKeyHash, /^sha256:[a-f0-9]{64}$/)
  assert.doesNotMatch(normalized.operationKeyHash, new RegExp(OPERATION_KEY))
  assert.throws(
    () => normalizeRoleDeletionRequest({ ...request(), future: true } as never),
    /exact acknowledged object/,
  )
  assert.throws(
    () => normalizeRoleDeletionRequest({
      ...request(),
      acknowledgeIrreversibleRoleLoss: false,
    } as never),
    /exact acknowledged object/,
  )
})

test("role-deletion readiness and plan bind complete transient evidence", async () => {
  const target = fixture()

  const readiness = await target.service.audit(
    APPLICATION_ID,
    BOT_ID,
    GUILD_ID,
    TARGET_ROLE_ID,
  )
  const plan = await target.service.plan(APPLICATION_ID, BOT_ID, request())

  assert.equal(readiness.status, "ready")
  assert.equal(readiness.ready, true)
  assert.equal(readiness.memberCount, 0)
  assert.equal(readiness.permission.guildManageRoles, true)
  assert.equal(readiness.permission.guildManageGuild, true)
  assert.equal(readiness.target.id, TARGET_ROLE_ID)
  assert.equal(readiness.target.name, "Private retiring role")
  assert.deepEqual(readiness.blockers, [])
  assert.match(readiness.evidenceDigest, /^hmac-sha256:[a-f0-9]{64}$/)
  assert.match(readiness.dependencies.digest, /^hmac-sha256:[a-f0-9]{64}$/)
  assert.ok(readiness.warnings.some((warning) => warning.includes("historical role mentions")))
  assert.ok(readiness.warnings.some((warning) => warning.includes("other applications")))
  assert.equal(plan.status, "planned")
  assert.equal(plan.writeRequired, true)
  assert.equal(plan.acknowledgeIrreversibleRoleLoss, true)
  assert.match(plan.digest, /^hmac-sha256:[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(plan).includes(OPERATION_KEY), false)
})

test("role-deletion verifies fresh exact-target blueprint recovery evidence", async () => {
  const target = fixture()
  const selectedRole = target.client.roles.find((entry) => (
    entry.id === TARGET_ROLE_ID
  ))
  assert.ok(selectedRole)
  const readiness = await target.service.audit(
    APPLICATION_ID,
    BOT_ID,
    GUILD_ID,
    TARGET_ROLE_ID,
  )
  assert.equal(readiness.status, "ready")
  if (readiness.status !== "ready") assert.fail("Expected ready role evidence")
  const binding = createGuildRecoveryAttestation(RECOVERY_KEY, {
    applicationId: APPLICATION_ID,
    blueprintKey: `role-${TARGET_ROLE_ID}`,
    botId: BOT_ID,
    captureDigest: `sha256:${"d".repeat(64)}`,
    capturedAt: "2026-08-23T11:50:00.000Z",
    guildId: GUILD_ID,
    omissionCodes: ["ROLE_ORDER_OMITTED"],
    resourceId: TARGET_ROLE_ID,
    resourceType: "role",
    targetStateDigest: guildBlueprintRoleRecoveryStateDigest(readiness.target),
  })
  const capturedRequest = request({
    recovery: {
      acknowledgeCallerRetentionAndLimitations: true,
      attestation: binding.attestation,
      mode: "verified-blueprint-capture",
    },
  })
  const capturedPlan = await target.service.plan(
    APPLICATION_ID,
    BOT_ID,
    capturedRequest,
  )
  const noArtifactPlan = await target.service.plan(
    APPLICATION_ID,
    BOT_ID,
    request(),
  )

  assert.deepEqual(capturedPlan.recovery, {
    capture: {
      blueprintKey: `role-${TARGET_ROLE_ID}`,
      captureDigest: binding.captureDigest,
      capturedAt: binding.capturedAt,
      expiresAt: binding.expiresAt,
      omissionCodes: ["ROLE_ORDER_OMITTED"],
      targetStateDigest: binding.targetStateDigest,
    },
    limitations: {
      atomicSnapshot: false,
      automaticRollback: false,
      completeBackup: false,
      connectorPersistence: false,
      crossGuildPortable: false,
      losslessRestore: false,
      messageRecovery: false,
      originalIdRestoration: false,
    },
    mode: "verified-blueprint-capture",
    verified: true,
  })
  assert.notEqual(capturedPlan.digest, noArtifactPlan.digest)
  assert.doesNotMatch(JSON.stringify(capturedPlan), new RegExp(binding.attestation))
  assert.ok(capturedPlan.warnings.some((warning) => (
    warning.includes("ROLE_ORDER_OMITTED")
  )))
  assert.ok(noArtifactPlan.warnings.some((warning) => (
    warning.includes("No recovery artifact is attested")
  )))

  selectedRole.name = "Changed after capture"
  await assert.rejects(
    () => target.service.plan(APPLICATION_ID, BOT_ID, capturedRequest),
    /invalid, expired, mismatched, or stale/u,
  )
})

test("role-deletion never persists a recovery attestation", async () => {
  const target = fixture()
  const readiness = await target.service.audit(
    APPLICATION_ID,
    BOT_ID,
    GUILD_ID,
    TARGET_ROLE_ID,
  )
  assert.equal(readiness.status, "ready")
  if (readiness.status !== "ready") assert.fail("Expected ready role evidence")
  const binding = createGuildRecoveryAttestation(RECOVERY_KEY, {
    applicationId: APPLICATION_ID,
    blueprintKey: `role-${TARGET_ROLE_ID}`,
    botId: BOT_ID,
    captureDigest: `sha256:${"a".repeat(64)}`,
    capturedAt: "2026-08-23T11:50:00.000Z",
    guildId: GUILD_ID,
    omissionCodes: [],
    resourceId: TARGET_ROLE_ID,
    resourceType: "role",
    targetStateDigest: guildBlueprintRoleRecoveryStateDigest(readiness.target),
  })
  const capturedRequest = request({
    recovery: {
      acknowledgeCallerRetentionAndLimitations: true,
      attestation: binding.attestation,
      mode: "verified-blueprint-capture",
    },
  })
  const plan = await target.service.plan(
    APPLICATION_ID,
    BOT_ID,
    capturedRequest,
  )
  const result = await target.service.execute(
    APPLICATION_ID,
    BOT_ID,
    capturedRequest,
    plan.digest,
  )
  const durableAndReturnedState = JSON.stringify({
    activity: target.activityStore.entries,
    receipts: [...target.operationStore.receipts.values()],
    result,
  })

  assert.equal(result.status, "completed")
  assert.equal(durableAndReturnedState.includes(binding.attestation), false)
})

test("role-deletion reports every discoverable dependency as a blocker", async () => {
  const client = new FixtureClient()
  client.guild.features = ["AUTO_MODERATION", "COMMUNITY"]
  const selectedChannel = client.channels[0]
  assert.ok(selectedChannel)
  selectedChannel.permission_overwrites = [{
    allow: "0",
    deny: "0",
    id: TARGET_ROLE_ID,
    type: 0,
  }]
  client.invites = [invite([TARGET_ROLE_ID])]
  client.emojis = [emoji([TARGET_ROLE_ID])]
  client.integrations = [integration(TARGET_ROLE_ID)]
  client.commandPermissions = commandPermissions(TARGET_ROLE_ID)
  client.onboardingState = onboarding([TARGET_ROLE_ID])
  client.autoModerationRules = [automod([TARGET_ROLE_ID])]

  const plan = await fixture({ client }).service.plan(APPLICATION_ID, BOT_ID, request())

  assert.equal(plan.status, "blocked")
  assert.deepEqual(plan.blockers, [
    { count: 1, kind: "application-command-permission" },
    { count: 1, kind: "automod-exempt-role" },
    { count: 1, kind: "channel-overwrite" },
    { count: 1, kind: "emoji-role-restriction" },
    { count: 1, kind: "integration-role" },
    { count: 1, kind: "invite-role-grant" },
    { count: 1, kind: "onboarding-role-option" },
  ])
  assert.equal(plan.dependencies.blockerCount, 7)
  assert.equal(JSON.stringify(plan).includes("private-invite-code"), false)
})

test("role-deletion blocks holders, managed roles, and hierarchy violations", async () => {
  const holderClient = new FixtureClient()
  holderClient.counts[TARGET_ROLE_ID] = 2
  const holder = await fixture({ client: holderClient }).service.plan(
    APPLICATION_ID,
    BOT_ID,
    request(),
  )
  assert.ok(holder.blockers.some((entry) => (
    entry.kind === "member-holder" && entry.count === 2
  )))

  const managedClient = new FixtureClient()
  const managedRole = managedClient.roles.find((entry) => entry.id === TARGET_ROLE_ID)
  assert.ok(managedRole)
  managedRole.managed = true
  const managed = await fixture({ client: managedClient }).service.plan(
    APPLICATION_ID,
    BOT_ID,
    request(),
  )
  assert.ok(managed.blockers.some((entry) => entry.kind === "managed-role"))

  const hierarchyClient = new FixtureClient()
  const hierarchyRole = hierarchyClient.roles.find((entry) => entry.id === TARGET_ROLE_ID)
  assert.ok(hierarchyRole)
  hierarchyRole.position = 11
  const hierarchy = await fixture({ client: hierarchyClient }).service.plan(
    APPLICATION_ID,
    BOT_ID,
    request(),
  )
  assert.ok(hierarchy.blockers.some((entry) => entry.kind === "role-hierarchy"))
})

test("role-deletion proceeds with explicit partial dependency coverage", async () => {
  for (const type of [20, 99]) {
    const client = new FixtureClient()
    const opaque = { ...channel(GUILD_ID), id: "700000000000000002", position: 1, type }
    delete opaque.name
    delete opaque.permission_overwrites
    client.channels.push(opaque)
    client.source.snapshot = layoutSnapshot(client.channels, GUILD_ID)
    const { service } = fixture({ client })
    const audit = await service.audit(APPLICATION_ID, BOT_ID, GUILD_ID, TARGET_ROLE_ID)
    assert.equal(audit.ready, true)
    assert.equal(audit.dependencies.coverage.status, "partial")
    assert.equal(audit.dependencies.coverage.evaluatedChannelCount, 1)
    assert.deepEqual(audit.dependencies.coverage.unsupportedChannels, [{
      channelId: opaque.id, parentChannelId: null, position: 1, type,
    }])
    const plan = await service.plan(APPLICATION_ID, BOT_ID, request())
    const result = await service.execute(APPLICATION_ID, BOT_ID, request(), plan.digest)
    assert.equal(result.status, "completed")
    assert.equal(result.verification, "match")
    assert.equal(client.deleteCalls.length, 1)
  }
})

test("role-deletion partial coverage changes invalidate the reviewed plan", async () => {
  const client = new FixtureClient()
  const opaque = { ...channel(GUILD_ID), id: "700000000000000002", position: 1, type: 20 }
  client.channels.push(opaque)
  client.source.snapshot = layoutSnapshot(client.channels, GUILD_ID)
  const { service } = fixture({ client })
  const plan = await service.plan(APPLICATION_ID, BOT_ID, request())
  opaque.type = 99
  client.source.snapshot = layoutSnapshot(client.channels, GUILD_ID)
  await assert.rejects(
    service.execute(APPLICATION_ID, BOT_ID, request(), plan.digest),
    RoleDeletionPlanChangedError,
  )
  assert.equal(client.deleteCalls.length, 0)
})

test("role-deletion ignores hidden opaque metadata and reports partial coverage", async () => {
  const client = new FixtureClient()
  const opaque = {
    ...channel(GUILD_ID), id: "700000000000000002", name: "hidden-opaque-secret", position: 1, type: 20,
    permission_overwrites: [{ id: TARGET_ROLE_ID, type: 0, allow: "0", deny: "0" }],
  }
  client.channels.push(opaque)
  client.source.snapshot = layoutSnapshot(client.channels, GUILD_ID)
  client.source.snapshot.channels.find((entry) => entry.channelId === opaque.id)!.obfuscated = true
  const { service } = fixture({ client })
  const plan = await service.plan(APPLICATION_ID, BOT_ID, request())
  assert.equal(plan.status, "planned")
  assert.equal(plan.dependencies.coverage.status, "partial")
  assert.equal(plan.layout.obfuscatedChannelCount, 1)
  assert.equal(plan.dependencies.counts.channelOverwrites, 0)
  assert.doesNotMatch(JSON.stringify(plan), /hidden-opaque-secret/)
  const result = await service.execute(APPLICATION_ID, BOT_ID, request(), plan.digest)
  assert.equal(result.status, "completed")
})

test("role-deletion keeps explicit overwrite references as blockers on opaque channels", async () => {
  const client = new FixtureClient()
  client.channels.push({
    ...channel(GUILD_ID), id: "700000000000000002", position: 1, type: 20,
    permission_overwrites: [{ id: TARGET_ROLE_ID, type: 0, allow: "0", deny: "0" }],
  })
  client.source.snapshot = layoutSnapshot(client.channels, GUILD_ID)
  const { service } = fixture({ client })
  const audit = await service.audit(APPLICATION_ID, BOT_ID, GUILD_ID, TARGET_ROLE_ID)
  assert.equal(audit.ready, false)
  assert.equal(audit.dependencies.counts.channelOverwrites, 1)
  assert.equal(audit.dependencies.coverage.status, "partial")
})

test("role-deletion bounds opaque role-reference inspection", async () => {
  const client = new FixtureClient()
  client.channels.push({
    ...channel(GUILD_ID), id: "700000000000000002", position: 1, type: 20,
    permission_overwrites: Array.from({ length: DISCORD_LIMITS.channelPermissionOverwrites + 1 }, () => ({
      id: TARGET_ROLE_ID, type: 0, allow: "0", deny: "0",
    })),
  })
  client.source.snapshot = layoutSnapshot(client.channels, GUILD_ID)
  await assert.rejects(
    fixture({ client }).service.plan(APPLICATION_ID, BOT_ID, request()),
    /bounded opaque channel role-reference/,
  )
})

test("role-deletion counts added opaque topology once regardless of metadata visibility", async () => {
  for (const obfuscated of [false, true]) {
    const client = new FixtureClient()
    const opaque = { ...channel(GUILD_ID), id: "700000000000000002", position: 1, type: 20 }
    client.afterDelete = () => {
      client.channels.push(opaque)
      client.source.snapshot = layoutSnapshot(client.channels, GUILD_ID)
      client.source.snapshot.channels.find((entry) => entry.channelId === opaque.id)!.obfuscated = obfuscated
    }
    const { service } = fixture({ client })
    const plan = await service.plan(APPLICATION_ID, BOT_ID, request())
    const result = await service.execute(APPLICATION_ID, BOT_ID, request(), plan.digest)
    assert.equal(result.status, "completed-with-drift")
    assert.equal(result.verification, "drift")
    assert.equal(result.addedEvidence.channels, 1)
    assert.equal(client.deleteCalls.length, 1)
  }
})

test("role-deletion detects opaque topology drift after dispatch", async () => {
  const guildId = "980000000000000020"
  const client = new FixtureClient(guildId)
  const opaque = { ...channel(guildId), id: "700000000000000002", position: 1, type: 20 }
  client.channels.push(opaque)
  client.source.snapshot = layoutSnapshot(client.channels, guildId)
  client.afterDelete = () => {
    opaque.position = 2
    client.source.snapshot = layoutSnapshot(client.channels, guildId)
  }
  const { service } = fixture({ client })
  const input = request({ guildId })
  const plan = await service.plan(APPLICATION_ID, BOT_ID, input)
  await assert.rejects(
    service.execute(APPLICATION_ID, BOT_ID, input, plan.digest),
    (error: unknown) => {
      assert.equal(executionResult(error).status, "uncertain")
      return true
    },
  )
  assert.equal(client.deleteCalls.length, 1)
})

test("role-deletion fails closed on unknown and incomplete evidence", async () => {
  const unknownRoleClient = new FixtureClient()
  const targetRole = unknownRoleClient.roles.find((entry) => entry.id === TARGET_ROLE_ID)
  assert.ok(targetRole)
  ;(targetRole as DiscordRole & { future_role_field: true }).future_role_field = true
  await assert.rejects(
    fixture({ client: unknownRoleClient }).service.plan(APPLICATION_ID, BOT_ID, request()),
    /unknown role-deletion role evidence/,
  )

  const unknownInviteClient = new FixtureClient()
  unknownInviteClient.invites = [{ ...invite(), unknownFieldCount: 1 }]
  await assert.rejects(
    fixture({ client: unknownInviteClient }).service.plan(APPLICATION_ID, BOT_ID, request()),
    /unknown invite role evidence/,
  )

  const obfuscatedClient = new FixtureClient()
  const gatewayChannel = obfuscatedClient.source.snapshot.channels[0]
  assert.ok(gatewayChannel)
  gatewayChannel.obfuscated = true
  obfuscatedClient.channels = []
  await assert.rejects(
    fixture({ client: obfuscatedClient }).service.plan(APPLICATION_ID, BOT_ID, request()),
    RoleDeletionEvidenceError,
  )

  const disabledGatewayClient = new FixtureClient()
  disabledGatewayClient.source.layoutEnabled = false
  await assert.rejects(
    fixture({ client: disabledGatewayClient }).service.plan(APPLICATION_ID, BOT_ID, request()),
    /layout is disabled/,
  )
})

test("role-deletion rejects stale reviewed evidence before reservation", async () => {
  const target = fixture()
  const plan = await target.service.plan(APPLICATION_ID, BOT_ID, request())
  target.client.counts[TARGET_ROLE_ID] = 1

  await assert.rejects(
    target.service.execute(APPLICATION_ID, BOT_ID, request(), plan.digest),
    RoleDeletionPlanChangedError,
  )
  assert.equal(target.client.deleteCalls.length, 0)
  assert.equal(target.operationStore.reserveCalls, 0)
})

test("role-deletion journals pending evidence, deletes once, and proves absence", async () => {
  const target = fixture()
  const plan = await target.service.plan(APPLICATION_ID, BOT_ID, request())

  const result = await target.service.execute(
    APPLICATION_ID,
    BOT_ID,
    request(),
    plan.digest,
  )

  assert.equal(result.status, "completed")
  assert.equal(result.verification, "match")
  assert.equal(result.baselineRoleCount, 3)
  assert.equal(result.observedRoleCount, 2)
  assert.deepEqual(target.client.deleteCalls, [{
    auditReason: "Reviewed role retirement",
    guildId: GUILD_ID,
    roleId: TARGET_ROLE_ID,
  }])
  assert.deepEqual(target.activityStore.entries.map((entry) => (
    "status" in entry ? entry.status : null
  )), ["pending", "completed"])
  const serialized = JSON.stringify(target.activityStore.entries)
  for (const forbidden of [
    "Private retiring role",
    "Reviewed role retirement",
    OPERATION_KEY,
  ]) assert.equal(serialized.includes(forbidden), false)
  const receipt = [...target.operationStore.receipts.values()][0]
  assert.equal(receipt?.kind, "role-deletion")
  assert.equal(receipt?.resourceId, TARGET_ROLE_ID)
  assert.equal(receipt?.verification, "match")
  await assert.rejects(
    target.service.plan(APPLICATION_ID, BOT_ID, request()),
    RoleDeletionOperationConflictError,
  )
})

test("role-deletion blocks mutation when pending activity cannot be recorded", async () => {
  const target = fixture()
  const plan = await target.service.plan(APPLICATION_ID, BOT_ID, request())
  target.activityStore.failAt = 1

  await assert.rejects(
    target.service.execute(APPLICATION_ID, BOT_ID, request(), plan.digest),
    (error: unknown) => {
      assert.equal(executionResult(error).status, "blocked-audit-failed")
      return true
    },
  )
  assert.equal(target.client.deleteCalls.length, 0)
  assert.equal([...target.operationStore.receipts.values()][0]?.status, "failed")
})

test("role-deletion distinguishes known refusal from uncertain outcomes", async () => {
  const refused = fixture()
  const refusedPlan = await refused.service.plan(APPLICATION_ID, BOT_ID, request())
  refused.client.deleteError = new DiscordApiError({
    code: 50_013,
    message: "Missing permissions",
    method: "DELETE",
    route: "/guilds/{guild.id}/roles/{role.id}",
    status: 403,
  })
  await assert.rejects(
    refused.service.execute(APPLICATION_ID, BOT_ID, request(), refusedPlan.digest),
    (error: unknown) => {
      assert.equal(executionResult(error).status, "failed")
      return true
    },
  )
  assert.equal([...refused.operationStore.receipts.values()][0]?.status, "failed")

  const uncertainClient = new FixtureClient(UNCERTAIN_GUILD_ID)
  const uncertain = fixture({
    client: uncertainClient,
    policy: policy(UNCERTAIN_GUILD_ID),
  })
  const uncertainRequest = request({ guildId: UNCERTAIN_GUILD_ID })
  const uncertainPlan = await uncertain.service.plan(
    APPLICATION_ID,
    BOT_ID,
    uncertainRequest,
  )
  uncertainClient.deleteMutates = false
  await assert.rejects(
    uncertain.service.execute(
      APPLICATION_ID,
      BOT_ID,
      uncertainRequest,
      uncertainPlan.digest,
    ),
    (error: unknown) => {
      assert.equal(executionResult(error).status, "uncertain")
      return true
    },
  )
  await assert.rejects(
    uncertain.service.execute(
      APPLICATION_ID,
      BOT_ID,
      request({
        guildId: UNCERTAIN_GUILD_ID,
        operationKey: "role-deletion-operation-002",
      }),
      uncertainPlan.digest,
    ),
    (error: unknown) => {
      assert.equal(executionResult(error).status, "blocked-prior-uncertain")
      return true
    },
  )
})

test("role-deletion accepts added-only drift but rejects changed survivors", async () => {
  const driftClient = new FixtureClient()
  driftClient.afterDelete = () => {
    driftClient.roles.push(role(ADDED_ROLE_ID, "Concurrent new role", 0n, 1))
    driftClient.counts[ADDED_ROLE_ID] = 0
  }
  const drift = fixture({ client: driftClient })
  const driftPlan = await drift.service.plan(APPLICATION_ID, BOT_ID, request())
  const driftResult = await drift.service.execute(
    APPLICATION_ID,
    BOT_ID,
    request(),
    driftPlan.digest,
  )
  assert.equal(driftResult.status, "completed-with-drift")
  assert.equal(driftResult.verification, "drift")
  assert.deepEqual(driftResult.addedEvidence, {
    applicationCommands: 0,
    autoModerationRules: 0,
    channels: 0,
    emojis: 0,
    integrations: 0,
    invites: 0,
    onboardingOptions: 0,
    roles: 1,
  })

  const dependencyDriftGuildId = "930000000000000097"
  const dependencyDriftClient = new FixtureClient(dependencyDriftGuildId)
  dependencyDriftClient.afterDelete = () => {
    dependencyDriftClient.emojis.push({
      ...emoji(),
      id: "970000000000000099",
      roleIds: [],
    })
  }
  const dependencyDrift = fixture({
    client: dependencyDriftClient,
    policy: policy(dependencyDriftGuildId),
  })
  const dependencyDriftRequest = request({ guildId: dependencyDriftGuildId })
  const dependencyDriftPlan = await dependencyDrift.service.plan(
    APPLICATION_ID,
    BOT_ID,
    dependencyDriftRequest,
  )
  const dependencyDriftResult = await dependencyDrift.service.execute(
    APPLICATION_ID,
    BOT_ID,
    dependencyDriftRequest,
    dependencyDriftPlan.digest,
  )
  assert.equal(dependencyDriftResult.status, "completed-with-drift")
  assert.equal(dependencyDriftResult.addedEvidence.emojis, 1)
  assert.equal(dependencyDriftResult.addedEvidence.roles, 0)

  const changedGuildId = "930000000000000098"
  const changedClient = new FixtureClient(changedGuildId)
  changedClient.afterDelete = () => {
    const botRole = changedClient.roles.find((entry) => entry.id === BOT_ROLE_ID)
    assert.ok(botRole)
    botRole.hoist = true
  }
  const changed = fixture({
    client: changedClient,
    policy: policy(changedGuildId),
  })
  const changedRequest = request({ guildId: changedGuildId })
  const changedPlan = await changed.service.plan(
    APPLICATION_ID,
    BOT_ID,
    changedRequest,
  )
  await assert.rejects(
    changed.service.execute(
      APPLICATION_ID,
      BOT_ID,
      changedRequest,
      changedPlan.digest,
    ),
    (error: unknown) => {
      assert.equal(executionResult(error).status, "uncertain")
      return true
    },
  )
})
