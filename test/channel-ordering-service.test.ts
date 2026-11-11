import assert from "node:assert/strict"
import test from "node:test"

import type {
  ActivityEntry,
  ActivityList,
  ActivityStore,
} from "../src/activity-log.js"
import {
  type ChannelOrderingRequest,
  ChannelOrderingService,
  type ChannelOrderingServiceClient,
  normalizeChannelOrderingRequest,
} from "../src/channel-ordering-service.js"
import {
  DISCORD_CHANNEL_TYPES,
  SCHEMA_VERSION,
} from "../src/constants.js"
import type { ModifyGuildChannelPositionInput } from "../src/discord-client.js"
import {
  ChannelOrderingEvidenceError,
  ChannelOrderingExecutionError,
  ChannelOrderingOperationConflictError,
  ChannelOrderingPlanChangedError,
  DiscordApiError,
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
import type {
  DiscordChannel,
  DiscordGuild,
  DiscordGuildMember,
  DiscordRole,
} from "../src/types.js"

const APPLICATION_ID = "710000000000000001"
const BOT_ID = "720000000000000001"
const GUILD_ID = "730000000000000001"
const OWNER_ID = "730000000000000002"
const CATEGORY_ID = "740000000000000001"
const TARGET_CHANNEL_ID = "740000000000000002"
const MID_CHANNEL_ID = "740000000000000003"
const ANCHOR_CHANNEL_ID = "740000000000000004"
const TOP_CHANNEL_ID = "740000000000000005"
const VOICE_CHANNEL_ID = "740000000000000006"
const BOT_ROLE_ID = "750000000000000001"
const OPERATION_KEY = "channel-ordering-operation-001"
const PLAN_KEY = new Uint8Array(32).fill(18)

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

function channel(
  id: string,
  name: string,
  type: number,
  position: number,
  parentId: string | null,
): DiscordChannel {
  return {
    guild_id: GUILD_ID,
    id,
    name,
    parent_id: parentId,
    permission_overwrites: [],
    position,
    type,
  }
}

function layoutSnapshot(
  channels: readonly DiscordChannel[],
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
    guildId: GUILD_ID,
    reason: null,
    revision,
    schemaVersion: SCHEMA_VERSION,
    state: "ready",
    updatedAt: `2026-08-23T12:00:${String(revision).padStart(2, "0")}.000Z`,
  }
}

class FixtureLayoutSource implements GatewayChannelLayoutSource {
  layoutEnabled = true
  readonly listeners = new Set<GatewayChannelLayoutListener>()
  snapshot: GatewayChannelLayoutSnapshot

  constructor(channels: readonly DiscordChannel[]) {
    this.snapshot = layoutSnapshot(channels)
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
        invalidated: this.snapshot.state === "invalidated" ? 1 : 0,
        pending: 0,
        ready: this.snapshot.state === "ready" ? 1 : 0,
        resuming: 0,
        scoped: 1,
        unavailable: 0,
      },
      invalidations: 0,
      schemaVersion: SCHEMA_VERSION,
      updates: this.snapshot.revision,
    }
  }

  publish(snapshot: GatewayChannelLayoutSnapshot): void {
    this.snapshot = structuredClone(snapshot)
    for (const listener of this.listeners) listener(snapshot.guildId)
  }

  subscribeChannelLayouts(listener: GatewayChannelLayoutListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

class MemoryActivityStore implements ActivityStore {
  readonly entries: ActivityEntry[] = []
  failAt: number | null = null
  onAppend: (() => void) | null = null

  async append(entry: ActivityEntry): Promise<void> {
    if (this.failAt === this.entries.length + 1) throw new Error("activity unavailable")
    this.entries.push(structuredClone(entry))
    this.onAppend?.()
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
  failFinish = false
  reserveCalls = 0

  #key(kind: OperationKind, operationKeyHash: string): string {
    return `${kind}:${operationKeyHash}`
  }

  async finish(receipt: OperationReceipt): Promise<void> {
    if (this.failFinish) throw new Error("operation receipt unavailable")
    this.receipts.set(this.#key(receipt.kind, receipt.operationKeyHash), structuredClone(receipt))
  }

  async get(
    kind: OperationKind,
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

class FixtureClient implements ChannelOrderingServiceClient {
  afterModify: (() => void) | null = null
  channels: DiscordChannel[]
  guild: DiscordGuild
  member: DiscordGuildMember
  modifyError: unknown
  patchCalls: Array<{
    auditReason: string
    guildId: string
    positions: ModifyGuildChannelPositionInput[]
  }> = []
  publishMutation = true
  roles: DiscordRole[]
  source: FixtureLayoutSource

  constructor(guildId = GUILD_ID) {
    this.channels = [
      channel(CATEGORY_ID, "Private category", DISCORD_CHANNEL_TYPES.category, 0, null),
      channel(TARGET_CHANNEL_ID, "Private target", DISCORD_CHANNEL_TYPES.text, 1, CATEGORY_ID),
      channel(MID_CHANNEL_ID, "Middle", DISCORD_CHANNEL_TYPES.forum, 2, CATEGORY_ID),
      channel(ANCHOR_CHANNEL_ID, "Private anchor", DISCORD_CHANNEL_TYPES.media, 3, CATEGORY_ID),
      channel(TOP_CHANNEL_ID, "Top level", DISCORD_CHANNEL_TYPES.text, 0, null),
      channel(VOICE_CHANNEL_ID, "Voice", DISCORD_CHANNEL_TYPES.voice, 0, CATEGORY_ID),
    ]
    this.channels.forEach((entry) => {
      entry.guild_id = guildId
    })
    this.source = new FixtureLayoutSource(this.channels)
    this.source.snapshot = { ...this.source.snapshot, guildId }
    this.guild = {
      features: [],
      id: guildId,
      name: "Private guild",
      owner_id: OWNER_ID,
    }
    this.member = {
      roles: [BOT_ROLE_ID],
      user: { bot: true, id: BOT_ID, username: "connector" },
    }
    this.roles = [
      role(guildId, "@everyone", DISCORD_PERMISSIONS.VIEW_CHANNEL, 0),
      role(BOT_ROLE_ID, "connector", DISCORD_PERMISSIONS.MANAGE_CHANNELS, 1, {
        managed: true,
        tags: { bot_id: BOT_ID },
      }),
    ]
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

  async getGuildRoles() {
    return structuredClone(this.roles)
  }

  async modifyGuildChannelPositions(
    guildId: string,
    positions: readonly ModifyGuildChannelPositionInput[],
    auditReason: string,
  ): Promise<void> {
    this.patchCalls.push({
      auditReason,
      guildId,
      positions: structuredClone([...positions]),
    })
    if (this.modifyError) throw this.modifyError
    for (const requested of positions) {
      const current = this.channels.find((entry) => entry.id === requested.id)
      assert.ok(current)
      current.position = requested.position
      if ("parentId" in requested) current.parent_id = requested.parentId
    }
    this.afterModify?.()
    if (!this.publishMutation) return
    const next = layoutSnapshot(
      this.channels,
      this.source.snapshot.revision + 1,
    )
    next.guildId = guildId
    this.source.publish(next)
  }
}

function policy(guildId = GUILD_ID, audit = true, changes = true) {
  return new ScopePolicy({
    adminGuildIds: new Set<string>(),
    allowedChannelIds: new Set<string>(),
    allowedGuildIds: new Set([guildId]),
    allowAdministration: false,
    allowChannelOrderingAudit: audit,
    allowChannelOrderingChanges: changes,
    allowDeletions: false,
    allowInteractions: false,
    channelOrderingGuildIds: new Set([guildId]),
    deleteChannelIds: new Set<string>(),
    interactionChannelIds: new Set<string>(),
    interactionMaxWritesPerMinute: 10,
    interactionMinWriteIntervalMs: 500,
    mentionUserIds: new Set<string>(),
    protectedUserIds: new Set<string>(),
  })
}

function request(
  overrides: Partial<ChannelOrderingRequest> = {},
): ChannelOrderingRequest {
  return {
    anchorChannelId: ANCHOR_CHANNEL_ID,
    auditReason: "Reviewed channel layout change",
    channelId: TARGET_CHANNEL_ID,
    guildId: GUILD_ID,
    operationKey: OPERATION_KEY,
    placement: "above",
    ...overrides,
  }
}

function fixture(options: {
  client?: FixtureClient
  policy?: ScopePolicy
  verificationTimeoutMs?: number
} = {}) {
  const activityStore = new MemoryActivityStore()
  const client = options.client ?? new FixtureClient()
  const operationStore = new MemoryOperationStore()
  const service = new ChannelOrderingService({
    activityStore,
    client,
    clock: () => new Date("2026-08-23T12:00:00.000Z"),
    layoutSource: client.source,
    operationStore,
    planKey: PLAN_KEY,
    policy: options.policy ?? policy(client.guild.id),
    randomId: () => "activity-channel-ordering-001",
    verificationTimeoutMs: options.verificationTimeoutMs ?? 20,
  })
  return { activityStore, client, operationStore, service }
}

function executionResult(error: unknown): Record<string, unknown> {
  assert.ok(error instanceof ChannelOrderingExecutionError)
  assert.ok(error.result && typeof error.result === "object")
  return error.result as Record<string, unknown>
}

test("channel-ordering request normalization is exact, relative, and key-safe", () => {
  const normalized = normalizeChannelOrderingRequest(request())

  assert.equal(normalized.placement, "above")
  assert.match(normalized.operationKeyHash, /^sha256:[a-f0-9]{64}$/)
  assert.doesNotMatch(normalized.operationKeyHash, new RegExp(OPERATION_KEY))
  assert.throws(
    () => normalizeChannelOrderingRequest({ ...request(), future: true } as never),
    /exact object/,
  )
  assert.throws(
    () => normalizeChannelOrderingRequest(request({
      anchorChannelId: TARGET_CHANNEL_ID,
    })),
    /must be distinct/,
  )
  assert.throws(
    () => normalizeChannelOrderingRequest(request({ placement: "sideways" as never })),
    /above or below/,
  )
})

test("channel-order audit returns canonical complete layout and privacy evidence", async () => {
  const target = fixture()

  const audit = await target.service.audit(APPLICATION_ID, BOT_ID, GUILD_ID)

  assert.equal(audit.status, "ok")
  assert.equal(audit.httpEvidenceMode, "complete")
  assert.equal(audit.layout.revision, 1)
  assert.equal(audit.permission.guildManageChannels, true)
  const textGroup = audit.groups.find((group) => (
    group.parentChannelId === CATEGORY_ID && group.family === "text"
  ))
  assert.ok(textGroup)
  assert.deepEqual(textGroup.channels.map((entry) => entry.id), [
    TARGET_CHANNEL_ID,
    MID_CHANNEL_ID,
    ANCHOR_CHANNEL_ID,
  ])
  assert.deepEqual(textGroup.channels.map((entry) => entry.rank), [0, 1, 2])
  assert.deepEqual(audit.privacy, {
    channelText: "transient-untrusted",
    hiddenMetadataReturned: false,
    omittedFields: [
      "auditReason",
      "channelContent",
      "hiddenChannelMetadata",
      "memberIdentities",
      "permissionOverwrites",
      "rawOperationKey",
      "rawPayloads",
    ],
    persistence: "content-free-only",
  })
})

test("channel-order audit retains unrecognized types without interpreting their metadata", async () => {
  const client = new FixtureClient()
  const opaque = channel("740000000000000007", "Opaque", 20, 0, null)
  delete opaque.name
  delete opaque.permission_overwrites
  client.channels.push(opaque)
  client.source.snapshot = layoutSnapshot(client.channels)
  const { service } = fixture({ client })
  const audit = await service.audit(APPLICATION_ID, BOT_ID, GUILD_ID)
  const group = audit.groups.find((entry) => entry.family === "unsupported")
  assert.ok(group)
  assert.equal(group.unsupportedType, 20)
  assert.equal(group.channels[0]?.id, opaque.id)
  const plan = await service.plan(APPLICATION_ID, BOT_ID, request())
  assert.equal(plan.writeRequired, true)
  assert.equal(plan.positionWrites.some((entry) => entry.channelId === opaque.id), false)
})

test("channel-order changes reject an unrecognized target or affected sibling", async () => {
  const client = new FixtureClient()
  client.channels.push(channel("740000000000000007", "Opaque", 20, 4, CATEGORY_ID))
  client.source.snapshot = layoutSnapshot(client.channels)
  const { service } = fixture({ client })
  await assert.rejects(service.plan(APPLICATION_ID, BOT_ID, request()), /unsupported direct channel type/)
  await assert.rejects(service.plan(APPLICATION_ID, BOT_ID, request({ channelId: "740000000000000007" })), /supported channel family/)
})

test("channel-order planning binds complete groups and normalizes the whole family", async () => {
  const { service } = fixture()

  const plan = await service.plan(APPLICATION_ID, BOT_ID, request())

  assert.equal(plan.status, "planned")
  assert.equal(plan.writeRequired, true)
  assert.deepEqual(plan.current, {
    anchorRank: 2,
    channelRank: 0,
    destinationGroupOrder: [TARGET_CHANNEL_ID, MID_CHANNEL_ID, ANCHOR_CHANNEL_ID],
    sourceGroupOrder: [TARGET_CHANNEL_ID, MID_CHANNEL_ID, ANCHOR_CHANNEL_ID],
  })
  assert.deepEqual(plan.desired, {
    anchorRank: 2,
    channelRank: 1,
    destinationGroupOrder: [MID_CHANNEL_ID, TARGET_CHANNEL_ID, ANCHOR_CHANNEL_ID],
    sourceGroupOrder: [MID_CHANNEL_ID, TARGET_CHANNEL_ID, ANCHOR_CHANNEL_ID],
  })
  assert.deepEqual(plan.positionWrites, [
    {
      beforeRawPosition: 2,
      channelId: MID_CHANNEL_ID,
      parentChange: null,
      submittedPosition: 0,
    },
    {
      beforeRawPosition: 1,
      channelId: TARGET_CHANNEL_ID,
      parentChange: null,
      submittedPosition: 1,
    },
    {
      beforeRawPosition: 3,
      channelId: ANCHOR_CHANNEL_ID,
      parentChange: null,
      submittedPosition: 2,
    },
  ])
  assert.equal(plan.impact.rawPositionWriteCount, 3)
  assert.match(plan.digest, /^hmac-sha256:[a-f0-9]{64}$/)

  const noOp = await service.plan(APPLICATION_ID, BOT_ID, request({
    anchorChannelId: MID_CHANNEL_ID,
  }))
  assert.equal(noOp.status, "already-current")
  assert.equal(noOp.writeRequired, false)
  assert.deepEqual(noOp.positionWrites, [])
})

test("cross-parent planning binds exact destination, capacity, authority, and overwrite preservation", async () => {
  const { service } = fixture()
  const moveRequest = request({ anchorChannelId: TOP_CHANNEL_ID })

  const plan = await service.plan(APPLICATION_ID, BOT_ID, moveRequest)

  assert.equal(plan.status, "planned")
  assert.equal(plan.mode, "cross-parent-move")
  assert.equal(plan.sourceParentChannelId, CATEGORY_ID)
  assert.equal(plan.destinationParentChannelId, null)
  assert.equal(plan.permissionOverwriteBehavior, "preserve")
  assert.deepEqual(plan.destinationCapacity, {
    childCountAfter: null,
    childCountBefore: null,
    childLimit: null,
    parentKind: "guild-root",
  })
  assert.deepEqual(plan.sourceCapacity, {
    childCountAfter: 3,
    childCountBefore: 4,
    childLimit: 50,
    parentKind: "category",
  })
  assert.deepEqual(plan.current.sourceGroupOrder, [
    TARGET_CHANNEL_ID,
    MID_CHANNEL_ID,
    ANCHOR_CHANNEL_ID,
  ])
  assert.deepEqual(plan.current.destinationGroupOrder, [TOP_CHANNEL_ID])
  assert.deepEqual(plan.desired.sourceGroupOrder, [
    MID_CHANNEL_ID,
    ANCHOR_CHANNEL_ID,
  ])
  assert.deepEqual(plan.desired.destinationGroupOrder, [
    TARGET_CHANNEL_ID,
    TOP_CHANNEL_ID,
  ])
  assert.deepEqual(plan.targetMovePermission, {
    administrator: false,
    effectivePermissionNames: ["MANAGE_CHANNELS", "VIEW_CHANNEL"],
    effectivePermissions: (
      DISCORD_PERMISSIONS.VIEW_CHANNEL | DISCORD_PERMISSIONS.MANAGE_CHANNELS
    ).toString(),
    manageChannels: true,
    viewChannel: true,
  })
  assert.deepEqual(plan.positionWrites, [
    {
      beforeRawPosition: 2,
      channelId: MID_CHANNEL_ID,
      parentChange: null,
      submittedPosition: 0,
    },
    {
      beforeRawPosition: 3,
      channelId: ANCHOR_CHANNEL_ID,
      parentChange: null,
      submittedPosition: 1,
    },
    {
      beforeRawPosition: 1,
      channelId: TARGET_CHANNEL_ID,
      parentChange: {
        destinationParentChannelId: null,
        lockPermissions: false,
        sourceParentChannelId: CATEGORY_ID,
      },
      submittedPosition: 0,
    },
    {
      beforeRawPosition: 0,
      channelId: TOP_CHANNEL_ID,
      parentChange: null,
      submittedPosition: 1,
    },
  ])
  assert.equal(plan.impact.parentChangeCount, 1)
  assert.equal(plan.impact.rawPositionWriteCount, 4)
})

test("cross-parent execution moves once, preserves overwrites, and verifies Gateway plus HTTP", async () => {
  const target = fixture()
  const moved = target.client.channels.find((entry) => entry.id === TARGET_CHANNEL_ID)
  assert.ok(moved)
  moved.permission_overwrites = [{
    allow: DISCORD_PERMISSIONS.MANAGE_CHANNELS.toString(),
    deny: "0",
    id: BOT_ROLE_ID,
    type: 0,
  }]
  target.client.source.snapshot = layoutSnapshot(target.client.channels)
  const moveRequest = request({ anchorChannelId: TOP_CHANNEL_ID })
  const plan = await target.service.plan(APPLICATION_ID, BOT_ID, moveRequest)

  const result = await target.service.execute(
    APPLICATION_ID,
    BOT_ID,
    moveRequest,
    plan.digest,
  )

  assert.equal(result.status, "completed")
  assert.equal(result.layoutMatched, true)
  assert.deepEqual(target.client.patchCalls, [{
    auditReason: "Reviewed channel layout change",
    guildId: GUILD_ID,
    positions: [
      { id: MID_CHANNEL_ID, position: 0 },
      { id: ANCHOR_CHANNEL_ID, position: 1 },
      {
        id: TARGET_CHANNEL_ID,
        lockPermissions: false,
        parentId: null,
        position: 0,
      },
      { id: TOP_CHANNEL_ID, position: 1 },
    ],
  }])
  const observed = target.client.channels.find((entry) => entry.id === TARGET_CHANNEL_ID)
  assert.equal(observed?.parent_id, null)
  assert.deepEqual(observed?.permission_overwrites, [{
    allow: DISCORD_PERMISSIONS.MANAGE_CHANNELS.toString(),
    deny: "0",
    id: BOT_ROLE_ID,
    type: 0,
  }])
  const durable = target.activityStore.entries as Array<
    ActivityEntry & Record<string, unknown>
  >
  assert.equal(durable[0]?.sourceParentChannelId, CATEGORY_ID)
  assert.equal(durable[0]?.destinationParentChannelId, null)
})

test("cross-parent execution moves a root channel into a category and removes the empty source group", async () => {
  const target = fixture()
  const moveRequest = request({
    anchorChannelId: ANCHOR_CHANNEL_ID,
    channelId: TOP_CHANNEL_ID,
  })
  const plan = await target.service.plan(APPLICATION_ID, BOT_ID, moveRequest)

  assert.equal(plan.sourceParentChannelId, null)
  assert.equal(plan.destinationParentChannelId, CATEGORY_ID)
  assert.deepEqual(plan.sourceCapacity, {
    childCountAfter: null,
    childCountBefore: null,
    childLimit: null,
    parentKind: "guild-root",
  })
  assert.deepEqual(plan.destinationCapacity, {
    childCountAfter: 5,
    childCountBefore: 4,
    childLimit: 50,
    parentKind: "category",
  })
  assert.deepEqual(plan.desired.sourceGroupOrder, [])
  assert.deepEqual(plan.desired.destinationGroupOrder, [
    TARGET_CHANNEL_ID,
    MID_CHANNEL_ID,
    TOP_CHANNEL_ID,
    ANCHOR_CHANNEL_ID,
  ])

  const result = await target.service.execute(
    APPLICATION_ID,
    BOT_ID,
    moveRequest,
    plan.digest,
  )

  assert.equal(result.status, "completed")
  assert.equal(
    target.client.channels.find((entry) => entry.id === TOP_CHANNEL_ID)?.parent_id,
    CATEGORY_ID,
  )
  assert.deepEqual(target.client.patchCalls[0]?.positions, [
    { id: TARGET_CHANNEL_ID, position: 0 },
    { id: MID_CHANNEL_ID, position: 1 },
    {
      id: TOP_CHANNEL_ID,
      lockPermissions: false,
      parentId: CATEGORY_ID,
      position: 2,
    },
    { id: ANCHOR_CHANNEL_ID, position: 3 },
  ])
})

test("visibility-bounded HTTP evidence never reveals obfuscated metadata", async () => {
  const client = new FixtureClient()
  client.source.snapshot = {
    ...client.source.snapshot,
    channels: client.source.snapshot.channels.map((entry) => (
      entry.channelId === TARGET_CHANNEL_ID
        ? { ...entry, obfuscated: true }
        : entry
    )),
  }
  client.channels = client.channels.filter((entry) => entry.id !== TARGET_CHANNEL_ID)

  const plan = await fixture({ client }).service.plan(
    APPLICATION_ID,
    BOT_ID,
    request(),
  )

  assert.equal(plan.httpEvidenceMode, "visibility-bounded")
  assert.equal(plan.channel.obfuscated, true)
  assert.equal(plan.channel.name, null)
  assert.equal(plan.channel.metadataVisibility, "obfuscated")
  assert.equal(plan.privacy.hiddenMetadataReturned, false)
})

test("legacy complete HTTP evidence discards metadata for Gateway-obfuscated channels", async () => {
  const client = new FixtureClient()
  const targetHttp = client.channels.find((entry) => entry.id === TARGET_CHANNEL_ID)
  assert.ok(targetHttp)
  Object.assign(targetHttp, { future_private_field: "must-not-leak" })
  client.source.snapshot = {
    ...client.source.snapshot,
    channels: client.source.snapshot.channels.map((entry) => (
      entry.channelId === TARGET_CHANNEL_ID
        ? { ...entry, obfuscated: true }
        : entry
    )),
  }

  const audit = await fixture({ client }).service.audit(
    APPLICATION_ID,
    BOT_ID,
    GUILD_ID,
  )

  assert.equal(audit.httpEvidenceMode, "complete")
  const targetEntry = audit.groups.flatMap((group) => group.channels)
    .find((entry) => entry.id === TARGET_CHANNEL_ID)
  assert.ok(targetEntry)
  assert.equal(targetEntry.name, null)
  assert.equal(targetEntry.unknownFieldCount, null)
  assert.doesNotMatch(JSON.stringify(audit), /must-not-leak/)
})

test("planning fails closed on scope, family, parent, unsupported siblings, evidence, and authority", async () => {
  await assert.rejects(
    fixture({ policy: policy(GUILD_ID, false, false) }).service.plan(
      APPLICATION_ID,
      BOT_ID,
      request(),
    ),
    /audit is disabled/,
  )
  await assert.rejects(
    fixture({ policy: policy(GUILD_ID, true, false) }).service.plan(
      APPLICATION_ID,
      BOT_ID,
      request(),
    ),
    /changes are disabled/,
  )
  await assert.rejects(
    fixture().service.plan(APPLICATION_ID, BOT_ID, request({
      anchorChannelId: VOICE_CHANNEL_ID,
    })),
    /share one sortable family/,
  )
  const unsupported = new FixtureClient()
  const directory = channel(
    "740000000000000007",
    "Directory",
    DISCORD_CHANNEL_TYPES.directory,
    4,
    CATEGORY_ID,
  )
  unsupported.channels.push(directory)
  unsupported.source.snapshot = layoutSnapshot(unsupported.channels)
  await assert.rejects(
    fixture({ client: unsupported }).service.plan(APPLICATION_ID, BOT_ID, request()),
    /unsupported direct channel type/,
  )

  const missing = new FixtureClient()
  missing.channels = missing.channels.filter((entry) => entry.id !== MID_CHANNEL_ID)
  await assert.rejects(
    fixture({ client: missing }).service.audit(APPLICATION_ID, BOT_ID, GUILD_ID),
    /neither complete nor visibility-bounded/,
  )

  const unauthorized = new FixtureClient()
  ;(unauthorized.roles.find((entry) => entry.id === BOT_ROLE_ID) as DiscordRole)
    .permissions = "0"
  await assert.rejects(
    fixture({ client: unauthorized }).service.plan(APPLICATION_ID, BOT_ID, request()),
    /lacks complete MANAGE_CHANNELS authority/,
  )
})

test("cross-parent planning fails closed on target visibility, target authority, destination authority, and capacity", async () => {
  const obfuscated = new FixtureClient()
  obfuscated.source.snapshot = {
    ...obfuscated.source.snapshot,
    channels: obfuscated.source.snapshot.channels.map((entry) => (
      entry.channelId === TARGET_CHANNEL_ID
        ? { ...entry, obfuscated: true }
        : entry
    )),
  }
  obfuscated.channels = obfuscated.channels.filter((entry) => (
    entry.id !== TARGET_CHANNEL_ID
  ))
  await assert.rejects(
    fixture({ client: obfuscated }).service.plan(
      APPLICATION_ID,
      BOT_ID,
      request({ anchorChannelId: TOP_CHANNEL_ID }),
    ),
    /require visible exact target evidence/,
  )

  const targetDenied = new FixtureClient()
  const deniedTarget = targetDenied.channels.find((entry) => (
    entry.id === TARGET_CHANNEL_ID
  ))
  assert.ok(deniedTarget)
  deniedTarget.permission_overwrites = [{
    allow: "0",
    deny: DISCORD_PERMISSIONS.MANAGE_CHANNELS.toString(),
    id: BOT_ROLE_ID,
    type: 0,
  }]
  targetDenied.source.snapshot = layoutSnapshot(targetDenied.channels)
  await assert.rejects(
    fixture({ client: targetDenied }).service.plan(
      APPLICATION_ID,
      BOT_ID,
      request({ anchorChannelId: TOP_CHANNEL_ID }),
    ),
    /lacks complete VIEW_CHANNEL and MANAGE_CHANNELS authority/,
  )

  const destinationDenied = new FixtureClient()
  ;(destinationDenied.roles.find((entry) => entry.id === BOT_ROLE_ID) as DiscordRole)
    .permissions = "0"
  const sourceCategory = destinationDenied.channels.find((entry) => (
    entry.id === CATEGORY_ID
  ))
  const scopedTarget = destinationDenied.channels.find((entry) => (
    entry.id === TARGET_CHANNEL_ID
  ))
  assert.ok(sourceCategory)
  assert.ok(scopedTarget)
  sourceCategory.permission_overwrites = [{
    allow: DISCORD_PERMISSIONS.MANAGE_CHANNELS.toString(),
    deny: "0",
    id: BOT_ROLE_ID,
    type: 0,
  }]
  scopedTarget.permission_overwrites = [{
    allow: DISCORD_PERMISSIONS.MANAGE_CHANNELS.toString(),
    deny: "0",
    id: BOT_ROLE_ID,
    type: 0,
  }]
  destinationDenied.source.snapshot = layoutSnapshot(destinationDenied.channels)
  await assert.rejects(
    fixture({ client: destinationDenied }).service.plan(
      APPLICATION_ID,
      BOT_ID,
      request({ anchorChannelId: TOP_CHANNEL_ID }),
    ),
    /lacks complete MANAGE_CHANNELS authority for the destination group/,
  )

  const full = new FixtureClient()
  for (let index = 0; index < 46; index += 1) {
    full.channels.push(channel(
      (760_000_000_000_000_000n + BigInt(index)).toString(),
      `Capacity ${index}`,
      DISCORD_CHANNEL_TYPES.text,
      4 + index,
      CATEGORY_ID,
    ))
  }
  full.source.snapshot = layoutSnapshot(full.channels)
  await assert.rejects(
    fixture({ client: full }).service.plan(
      APPLICATION_ID,
      BOT_ID,
      request({
        anchorChannelId: ANCHOR_CHANNEL_ID,
        channelId: TOP_CHANNEL_ID,
      }),
    ),
    /destination category is at capacity/,
  )
})

test("visible parent-category MANAGE_CHANNELS authority permits obfuscated child ordering", async () => {
  const client = new FixtureClient()
  ;(client.roles.find((entry) => entry.id === BOT_ROLE_ID) as DiscordRole)
    .permissions = "0"
  const category = client.channels.find((entry) => entry.id === CATEGORY_ID)
  assert.ok(category)
  category.permission_overwrites = [{
    allow: DISCORD_PERMISSIONS.MANAGE_CHANNELS.toString(),
    deny: "0",
    id: BOT_ROLE_ID,
    type: 0,
  }]
  client.source.snapshot = {
    ...client.source.snapshot,
    channels: client.source.snapshot.channels.map((entry) => (
      entry.channelId === TARGET_CHANNEL_ID
        ? { ...entry, obfuscated: true }
        : entry
    )),
  }
  client.channels = client.channels.filter((entry) => entry.id !== TARGET_CHANNEL_ID)

  const plan = await fixture({ client }).service.plan(
    APPLICATION_ID,
    BOT_ID,
    request(),
  )

  assert.equal(plan.httpEvidenceMode, "visibility-bounded")
  assert.equal(plan.channel.obfuscated, true)
  assert.equal(plan.channel.name, null)
  assert.equal(plan.sourcePermission.manageChannels, true)
  assert.equal(plan.sourcePermission.source, "parent")
})

test("execution sends one complete position payload and verifies a newer whole-guild layout", async () => {
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
  assert.equal(result.baselineLayoutRevision, 1)
  assert.equal(result.observedLayoutRevision, 2)
  assert.deepEqual(target.client.patchCalls, [{
    auditReason: "Reviewed channel layout change",
    guildId: GUILD_ID,
    positions: [
      { id: MID_CHANNEL_ID, position: 0 },
      { id: TARGET_CHANNEL_ID, position: 1 },
      { id: ANCHOR_CHANNEL_ID, position: 2 },
    ],
  }])
  assert.deepEqual(target.activityStore.entries.map((entry) => entry.status), [
    "pending",
    "completed",
  ])
  const persisted = JSON.stringify([
    ...target.activityStore.entries,
    ...target.operationStore.receipts.values(),
  ])
  assert.doesNotMatch(persisted, /Reviewed channel layout change|Private target|Private anchor/)
  assert.doesNotMatch(persisted, new RegExp(OPERATION_KEY))
})

test("accepted cross-parent overwrite drift is uncertain and quarantined", async () => {
  const guildId = "735000000000000001"
  const client = new FixtureClient(guildId)
  const target = client.channels.find((entry) => entry.id === TARGET_CHANNEL_ID)
  assert.ok(target)
  target.permission_overwrites = [{
    allow: DISCORD_PERMISSIONS.MANAGE_CHANNELS.toString(),
    deny: "0",
    id: BOT_ROLE_ID,
    type: 0,
  }]
  client.source.snapshot = { ...layoutSnapshot(client.channels), guildId }
  client.afterModify = () => {
    const moved = client.channels.find((entry) => entry.id === TARGET_CHANNEL_ID)
    assert.ok(moved)
    moved.permission_overwrites = []
  }
  const targetFixture = fixture({ client })
  const moveRequest = request({
    anchorChannelId: TOP_CHANNEL_ID,
    guildId,
  })
  const plan = await targetFixture.service.plan(
    APPLICATION_ID,
    BOT_ID,
    moveRequest,
  )

  await assert.rejects(
    targetFixture.service.execute(
      APPLICATION_ID,
      BOT_ID,
      moveRequest,
      plan.digest,
    ),
    (error) => executionResult(error).status === "uncertain",
  )
  assert.equal(client.patchCalls.length, 1)
})

test("already-current ordering spends no key and records no activity", async () => {
  const target = fixture()
  const noOpRequest = request({ anchorChannelId: MID_CHANNEL_ID })
  const plan = await target.service.plan(APPLICATION_ID, BOT_ID, noOpRequest)

  const result = await target.service.execute(
    APPLICATION_ID,
    BOT_ID,
    noOpRequest,
    plan.digest,
  )

  assert.equal(result.status, "already-current")
  assert.equal(result.activityId, null)
  assert.equal(target.client.patchCalls.length, 0)
  assert.equal(target.activityStore.entries.length, 0)
  assert.equal(target.operationStore.reserveCalls, 0)
})

test("channel-ordering reconciliation admits only a matching completed receipt and live state", async () => {
  const target = fixture()
  const plan = await target.service.plan(APPLICATION_ID, BOT_ID, request())
  await target.service.execute(APPLICATION_ID, BOT_ID, request(), plan.digest)

  const reconciled = await target.service.reconcilePlan(
    APPLICATION_ID,
    BOT_ID,
    request(),
  )
  assert.equal(reconciled.status, "already-current")
  assert.equal(reconciled.writeRequired, false)
  await assert.rejects(
    target.service.plan(APPLICATION_ID, BOT_ID, request()),
    ChannelOrderingOperationConflictError,
  )

  target.client.channels = new FixtureClient().channels
  target.client.source.publish(layoutSnapshot(target.client.channels, 3))
  await assert.rejects(
    target.service.reconcilePlan(APPLICATION_ID, BOT_ID, request()),
    ChannelOrderingOperationConflictError,
  )
})

test("fresh layout drift and reserved operation keys block before mutation", async () => {
  const changed = fixture()
  const plan = await changed.service.plan(APPLICATION_ID, BOT_ID, request())
  const changedChannels = structuredClone(changed.client.channels)
  const middle = changedChannels.find((entry) => entry.id === MID_CHANNEL_ID)
  assert.ok(middle)
  middle.position = 8
  changed.client.channels = changedChannels
  changed.client.source.publish(layoutSnapshot(changedChannels, 2))
  await assert.rejects(
    changed.service.execute(APPLICATION_ID, BOT_ID, request(), plan.digest),
    ChannelOrderingPlanChangedError,
  )
  assert.equal(changed.client.patchCalls.length, 0)

  const conflict = fixture()
  const conflictPlan = await conflict.service.plan(APPLICATION_ID, BOT_ID, request())
  await conflict.operationStore.reserve({
    activityId: "prior-channel-ordering-activity",
    error: null,
    guildId: GUILD_ID,
    kind: "channel-ordering",
    operationKeyHash: conflictPlan.operationKeyHash,
    planDigest: conflictPlan.digest,
    resourceId: null,
    schemaVersion: 1,
    status: "pending",
    timestamp: "2026-08-23T11:59:00.000Z",
    verification: null,
  })
  await assert.rejects(
    conflict.service.plan(APPLICATION_ID, BOT_ID, request()),
    ChannelOrderingOperationConflictError,
  )
  assert.equal(conflict.client.patchCalls.length, 0)
})

test("subscribed pre-write layout drift is detected and never mistaken for verification", async () => {
  const target = fixture()
  const plan = await target.service.plan(APPLICATION_ID, BOT_ID, request())
  target.activityStore.onAppend = () => {
    const drifted = structuredClone(target.client.channels)
    const middle = drifted.find((entry) => entry.id === MID_CHANNEL_ID)
    assert.ok(middle)
    middle.position = 9
    target.client.source.publish(layoutSnapshot(drifted, 2))
  }

  await assert.rejects(
    target.service.execute(APPLICATION_ID, BOT_ID, request(), plan.digest),
    (error) => executionResult(error).status === "failed",
  )
  assert.equal(target.client.patchCalls.length, 0)
  assert.equal(target.operationStore.reserveCalls, 1)
})

test("known refusal settles while accepted mismatch is uncertain and quarantines the guild", async () => {
  const refusalGuildId = "731000000000000001"
  const refusalClient = new FixtureClient(refusalGuildId)
  const refusal = fixture({ client: refusalClient })
  const refusalRequest = request({ guildId: refusalGuildId })
  const refusalPlan = await refusal.service.plan(
    APPLICATION_ID,
    BOT_ID,
    refusalRequest,
  )
  refusalClient.modifyError = new DiscordApiError({
    code: 50_013,
    message: "refused",
    method: "PATCH",
    route: `/guilds/${refusalGuildId}/channels`,
    status: 403,
  })
  await assert.rejects(
    refusal.service.execute(
      APPLICATION_ID,
      BOT_ID,
      refusalRequest,
      refusalPlan.digest,
    ),
    (error) => executionResult(error).status === "failed",
  )

  const uncertainGuildId = "732000000000000001"
  const uncertainClient = new FixtureClient(uncertainGuildId)
  uncertainClient.publishMutation = false
  const uncertain = fixture({ client: uncertainClient, verificationTimeoutMs: 5 })
  const uncertainRequest = request({ guildId: uncertainGuildId })
  const uncertainPlan = await uncertain.service.plan(
    APPLICATION_ID,
    BOT_ID,
    uncertainRequest,
  )
  await assert.rejects(
    uncertain.service.execute(
      APPLICATION_ID,
      BOT_ID,
      uncertainRequest,
      uncertainPlan.digest,
    ),
    (error) => executionResult(error).status === "uncertain",
  )
  assert.equal(uncertainClient.patchCalls.length, 1)

  const quarantined = fixture({ client: uncertainClient })
  await assert.rejects(
    quarantined.service.execute(
      APPLICATION_ID,
      BOT_ID,
      request({
        guildId: uncertainGuildId,
        operationKey: "channel-ordering-after-uncertain",
      }),
      `hmac-sha256:${"a".repeat(64)}`,
    ),
    (error) => executionResult(error).status === "blocked-prior-uncertain",
  )
  assert.equal(uncertainClient.patchCalls.length, 1)
})

test("pending evidence gates mutation and completed local failures preserve truth", async () => {
  const blocked = fixture()
  blocked.activityStore.failAt = 1
  const blockedPlan = await blocked.service.plan(APPLICATION_ID, BOT_ID, request())
  await assert.rejects(
    blocked.service.execute(APPLICATION_ID, BOT_ID, request(), blockedPlan.digest),
    (error) => executionResult(error).status === "blocked-audit-failed",
  )
  assert.equal(blocked.client.patchCalls.length, 0)

  const receiptGuildId = "733000000000000001"
  const receiptClient = new FixtureClient(receiptGuildId)
  const receiptFailure = fixture({ client: receiptClient })
  receiptFailure.operationStore.failFinish = true
  const receiptRequest = request({ guildId: receiptGuildId })
  const receiptPlan = await receiptFailure.service.plan(
    APPLICATION_ID,
    BOT_ID,
    receiptRequest,
  )
  await assert.rejects(
    receiptFailure.service.execute(
      APPLICATION_ID,
      BOT_ID,
      receiptRequest,
      receiptPlan.digest,
    ),
    (error) => executionResult(error).status === "completed-operation-record-failed",
  )
  assert.equal(receiptClient.patchCalls.length, 1)

  const activityGuildId = "734000000000000001"
  const activityClient = new FixtureClient(activityGuildId)
  const activityFailure = fixture({ client: activityClient })
  activityFailure.activityStore.failAt = 2
  const activityRequest = request({ guildId: activityGuildId })
  const activityPlan = await activityFailure.service.plan(
    APPLICATION_ID,
    BOT_ID,
    activityRequest,
  )
  await assert.rejects(
    activityFailure.service.execute(
      APPLICATION_ID,
      BOT_ID,
      activityRequest,
      activityPlan.digest,
    ),
    (error) => executionResult(error).status === "completed-audit-failed",
  )
  assert.equal(activityClient.patchCalls.length, 1)
  assert.equal(
    [...activityFailure.operationStore.receipts.values()].at(-1)?.status,
    "completed",
  )
})

test("malformed and incoherent Gateway or HTTP evidence fails closed", async () => {
  const disabled = new FixtureClient()
  disabled.source.layoutEnabled = false
  await assert.rejects(
    fixture({ client: disabled }).service.audit(APPLICATION_ID, BOT_ID, GUILD_ID),
    ChannelOrderingEvidenceError,
  )

  const malformed = new FixtureClient()
  malformed.source.snapshot = {
    ...malformed.source.snapshot,
    channels: [
      ...malformed.source.snapshot.channels,
      structuredClone(malformed.source.snapshot.channels[0] as object) as never,
    ],
  }
  await assert.rejects(
    fixture({ client: malformed }).service.audit(APPLICATION_ID, BOT_ID, GUILD_ID),
    ChannelOrderingEvidenceError,
  )

  const mismatch = new FixtureClient()
  const targetHttp = mismatch.channels.find((entry) => entry.id === TARGET_CHANNEL_ID)
  assert.ok(targetHttp)
  targetHttp.position = 99
  await assert.rejects(
    fixture({ client: mismatch }).service.audit(APPLICATION_ID, BOT_ID, GUILD_ID),
    ChannelOrderingEvidenceError,
  )
})
