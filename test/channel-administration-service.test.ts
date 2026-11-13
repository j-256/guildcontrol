import assert from "node:assert/strict"
import test from "node:test"

import type {
  ActivityEntry,
  ActivityStore,
} from "../src/activity-log.js"
import {
  ChannelAdministrationService,
  logicalChannelNameKey,
  normalizeChannelCreationRequest,
  type ChannelAdministrationServiceOptions,
  type ChannelCreationRequest,
} from "../src/channel-administration-service.js"
import { DISCORD_CHANNEL_TYPES } from "../src/constants.js"
import {
  ChannelCreationExecutionError,
  ChannelCreationOperationConflictError,
  ChannelCreationPlanChangedError,
  DiscordApiError,
} from "../src/errors.js"
import type { GuildScaffoldAuthority } from "../src/guild-scaffold-authority.js"
import type {
  OperationReceipt,
  OperationReservation,
  OperationStore,
} from "../src/operation-store.js"
import { DISCORD_PERMISSIONS } from "../src/permissions.js"
import { ScopePolicy } from "../src/policy.js"
import type {
  DiscordChannel,
  DiscordGuildMember,
  DiscordRole,
} from "../src/types.js"

const GUILD_ID = "100000000000000001"
const BOT_ID = "200000000000000001"
const OWNER_ID = "300000000000000001"
const BOT_ROLE_ID = "400000000000000001"
const CATEGORY_ID = "500000000000000001"
const CREATED_CHANNEL_ID = "600000000000000001"
const AUDIT_REASON = "Reviewed support channel creation"
const OPERATION_KEY = "channel-create-operation-0001"
const NOW = "2026-08-20T00:00:00.000Z"

test("logical channel name keys collapse separators and trim their boundaries", () => {
  assert.equal(logicalChannelNameKey(" _Customer---Help_ "), "customer-help")
  assert.equal(logicalChannelNameKey("---"), "")
  assert.equal(logicalChannelNameKey("Customer-Help"), "customer-help")
  assert.equal(
    logicalChannelNameKey(`alpha${"-".repeat(100_000)}omega`),
    "alpha-omega",
  )
})

function role(
  id: string,
  permissions: bigint,
  position: number,
): DiscordRole {
  return {
    id,
    managed: false,
    name: id === GUILD_ID ? "@everyone" : "connector",
    permissions: permissions.toString(),
    position,
  }
}

function category(overrides: Partial<DiscordChannel> = {}): DiscordChannel {
  return {
    guild_id: GUILD_ID,
    id: CATEGORY_ID,
    name: "Support",
    parent_id: null,
    permission_overwrites: [],
    position: 0,
    type: DISCORD_CHANNEL_TYPES.category,
    ...overrides,
  }
}

function createdChannel(overrides: Partial<DiscordChannel> = {}): DiscordChannel {
  return {
    default_auto_archive_duration: 1_440,
    guild_id: GUILD_ID,
    id: CREATED_CHANNEL_ID,
    name: "customer-help",
    nsfw: false,
    parent_id: CATEGORY_ID,
    permission_overwrites: [],
    position: 1,
    rate_limit_per_user: 0,
    topic: "Private support queue",
    type: DISCORD_CHANNEL_TYPES.text,
    ...overrides,
  }
}

function request(overrides: Partial<ChannelCreationRequest> = {}): ChannelCreationRequest {
  return {
    auditReason: AUDIT_REASON,
    guildId: GUILD_ID,
    kind: "text",
    name: "customer-help",
    operationKey: OPERATION_KEY,
    parentId: CATEGORY_ID,
    topic: "Private support queue",
    ...overrides,
  }
}

function policy(options: { enabled?: boolean; guildIds?: readonly string[] } = {}): ScopePolicy {
  return new ScopePolicy({
    adminGuildIds: new Set(),
    allowedChannelIds: new Set(),
    allowedGuildIds: new Set([GUILD_ID]),
    allowAdministration: false,
    allowChannelCreation: options.enabled ?? true,
    allowDeletions: false,
    allowInteractions: false,
    channelCreationGuildIds: new Set(options.guildIds || [GUILD_ID]),
    deleteChannelIds: new Set(),
    interactionChannelIds: new Set(),
    interactionMaxWritesPerMinute: 10,
    interactionMinWriteIntervalMs: 500,
    mentionUserIds: new Set(),
    protectedUserIds: new Set(),
  })
}

class MemoryOperationStore implements OperationStore {
  finishFailure: unknown
  readonly events: string[]
  receipt: OperationReceipt | undefined

  constructor(events: string[]) {
    this.events = events
  }

  async finish(receipt: OperationReceipt): Promise<void> {
    this.events.push(`operation:${receipt.status}`)
    if (this.finishFailure) throw this.finishFailure
    this.receipt = receipt
  }

  async get(): Promise<OperationReceipt | undefined> {
    return this.receipt
  }

  async reserve(receipt: OperationReceipt): Promise<OperationReservation> {
    this.events.push("operation:reserve")
    if (this.receipt) return { created: false, receipt: this.receipt }
    this.receipt = receipt
    return { created: true, receipt }
  }
}

interface FixtureState {
  activityFailureAt: number | null
  addCreatedToChannels: boolean
  botMember: DiscordGuildMember
  channels: DiscordChannel[]
  createError: unknown
  createGate: Promise<void> | null
  createStarted: (() => void) | null
  created: DiscordChannel
  guildId: string
  guildName: string
  ownerId: string
  readback: DiscordChannel
  readbackError: unknown
  roles: DiscordRole[]
}

function fixture(options: {
  policy?: ScopePolicy
  state?: Partial<FixtureState>
} = {}) {
  const permissions = DISCORD_PERMISSIONS.MANAGE_CHANNELS
    | DISCORD_PERMISSIONS.VIEW_CHANNEL
  const state: FixtureState = {
    activityFailureAt: null,
    addCreatedToChannels: false,
    botMember: {
      roles: [BOT_ROLE_ID],
      user: { bot: true, id: BOT_ID, username: "connector" },
    },
    channels: [category()],
    createError: undefined,
    createGate: null,
    createStarted: null,
    created: createdChannel(),
    guildId: GUILD_ID,
    guildName: "Private Guild Name",
    ownerId: OWNER_ID,
    readback: createdChannel(),
    readbackError: undefined,
    roles: [
      role(GUILD_ID, permissions, 0),
      role(BOT_ROLE_ID, 0n, 10),
    ],
    ...options.state,
  }
  const activities: ActivityEntry[] = []
  const events: string[] = []
  let activityCalls = 0
  const activityStore: ActivityStore = {
    async append(entry) {
      activityCalls += 1
      events.push(`activity:${entry.status}`)
      if (state.activityFailureAt === activityCalls) {
        throw new Error("activity unavailable")
      }
      activities.push(entry)
    },
    async list() {
      return { entries: activities, file: "/memory/activity.jsonl", skippedLines: 0 }
    },
  }
  const operationStore = new MemoryOperationStore(events)
  const client: ChannelAdministrationServiceOptions["client"] = {
    async createGuildChannel(_guildId, _input, _reason) {
      events.push("write:create")
      state.createStarted?.()
      if (state.createGate) await state.createGate
      if (state.createError) throw state.createError
      if (
        state.addCreatedToChannels
        && !state.channels.some((channel) => channel.id === state.created.id)
      ) {
        state.channels.push(state.created)
      }
      return state.created
    },
    async getChannel() {
      events.push("read:created")
      if (state.readbackError) throw state.readbackError
      return state.readback
    },
    async getGuild() {
      events.push("read:guild")
      return {
        id: state.guildId,
        name: state.guildName,
        owner_id: state.ownerId,
      }
    },
    async getGuildChannels() {
      events.push("read:channels")
      return state.channels
    },
    async getGuildMember() {
      events.push("read:member")
      return state.botMember
    },
    async getGuildRoles() {
      events.push("read:roles")
      return state.roles
    },
  }
  const service = new ChannelAdministrationService({
    activityStore,
    client,
    clock: () => new Date(NOW),
    operationStore,
    planKey: new Uint8Array(32).fill(7),
    policy: options.policy || policy(),
    randomId: () => "activity-0001",
  })
  return {
    activityStore,
    activities,
    client,
    events,
    operationStore,
    service,
    state,
  }
}

function siblingService(
  target: ReturnType<typeof fixture>,
  operationStore: OperationStore,
): ChannelAdministrationService {
  return new ChannelAdministrationService({
    activityStore: target.activityStore,
    client: target.client,
    clock: () => new Date(NOW),
    operationStore,
    planKey: new Uint8Array(32).fill(7),
    policy: policy(),
    randomId: () => "activity-sibling",
  })
}

function executionResult(error: unknown): Record<string, unknown> {
  assert.ok(error instanceof ChannelCreationExecutionError)
  assert.ok(error.result && typeof error.result === "object")
  return error.result as Record<string, unknown>
}

test("channel creation normalization is exact, type-specific, and content bounded", () => {
  const normalized = normalizeChannelCreationRequest(request())
  assert.deepEqual(normalized, {
    auditReason: AUDIT_REASON,
    defaultAutoArchiveDuration: 1_440,
    guildId: GUILD_ID,
    kind: "text",
    name: "customer-help",
    nsfw: false,
    operationKey: OPERATION_KEY,
    operationKeyHash: normalized.operationKeyHash,
    parentId: CATEGORY_ID,
    rateLimitPerUser: 0,
    topic: "Private support queue",
  })
  assert.match(normalized.operationKeyHash, /^sha256:[a-f0-9]{64}$/)
  assert.throws(
    () => normalizeChannelCreationRequest(request({ kind: "category" })),
    /does not accept/,
  )
  assert.throws(
    () => normalizeChannelCreationRequest(request({ name: " customer-help" })),
    /surrounding whitespace/,
  )
  assert.throws(
    () => normalizeChannelCreationRequest(request({ topic: "private\u0000topic" })),
    /unsupported controls/,
  )
  assert.throws(
    () => normalizeChannelCreationRequest(request({ rateLimitPerUser: 21_601 })),
    /between 0 and 21600/,
  )
  assert.throws(
    () => normalizeChannelCreationRequest(request({ defaultAutoArchiveDuration: 30 })),
    /not supported/,
  )
})

test("channel creation rejects forged guild scaffold authority", async () => {
  const target = fixture()
  await assert.rejects(
    target.service.planForGuildScaffold(
      {} as GuildScaffoldAuthority,
      BOT_ID,
      request(),
    ),
    /scaffold authority is invalid/,
  )
  assert.deepEqual(target.events, [])
})

test("channel creation plans bind live evidence and return an exact current no-op", async () => {
  const plannedFixture = fixture()
  const first = await plannedFixture.service.plan(BOT_ID, request())
  const second = await plannedFixture.service.plan(BOT_ID, request())

  assert.equal(first.status, "planned")
  assert.equal(first.action, "create")
  assert.equal(first.digest, second.digest)
  assert.equal(first.parent?.id, CATEGORY_ID)
  assert.equal(first.permission.guildManageChannels, true)
  assert.equal(first.permission.parentViewChannel, true)
  assert.match(first.warnings.join(" "), /visibility-bounded/)

  const currentFixture = fixture({ state: { channels: [category(), createdChannel()] } })
  const current = await currentFixture.service.plan(BOT_ID, request())
  const result = await currentFixture.service.execute(BOT_ID, request(), current.digest)

  assert.equal(current.status, "already-current")
  assert.equal(result.status, "already-current")
  assert.equal(result.channelId, CREATED_CHANNEL_ID)
  assert.equal(result.activityId, null)
  assert.equal(currentFixture.events.includes("write:create"), false)
  assert.equal(currentFixture.operationStore.receipt, undefined)

  const administratorFixture = fixture({
    state: {
      roles: [
        role(GUILD_ID, DISCORD_PERMISSIONS.ADMINISTRATOR, 0),
        role(BOT_ROLE_ID, 0n, 10),
      ],
    },
  })
  const administratorPlan = await administratorFixture.service.plan(BOT_ID, request())
  assert.equal(administratorPlan.permission.botAdministrator, true)
  assert.match(administratorPlan.warnings.join(" "), /has ADMINISTRATOR/)
})

test("channel creation planning fails closed on conflicts, capacity, and incomplete permissions", async () => {
  await assert.rejects(
    () => fixture({
      state: {
        channels: [category(), createdChannel({ name: "Customer Help" })],
      },
    }).service.plan(BOT_ID, request()),
    /conflicts with an existing channel/,
  )
  await assert.rejects(
    () => fixture({
      state: {
        channels: [
          category(),
          createdChannel({ type: DISCORD_CHANNEL_TYPES.forum }),
        ],
      },
    }).service.plan(BOT_ID, request()),
    /conflicts with an existing channel/,
  )
  await assert.rejects(
    () => fixture({
      state: {
        channels: [
          category(),
          createdChannel(),
          createdChannel({ id: "600000000000000002" }),
        ],
      },
    }).service.plan(BOT_ID, request()),
    /ambiguous/,
  )
  const manyChannels = Array.from({ length: 500 }, (_, index) => ({
    guild_id: GUILD_ID,
    id: String(700_000_000_000_000_000n + BigInt(index)),
    name: `other-${index}`,
    parent_id: null,
    type: DISCORD_CHANNEL_TYPES.voice,
  }))
  const uncategorizedRequest = request()
  delete uncategorizedRequest.parentId
  await assert.rejects(
    () => fixture({ state: { channels: manyChannels } }).service.plan(
      BOT_ID,
      uncategorizedRequest,
    ),
    /500-channel limit/,
  )
  await assert.rejects(
    () => fixture({
      state: {
        roles: [
          role(GUILD_ID, DISCORD_PERMISSIONS.VIEW_CHANNEL, 0),
          role(BOT_ROLE_ID, 0n, 10),
        ],
      },
    }).service.plan(BOT_ID, request()),
    /lacks guild-level MANAGE_CHANNELS/,
  )
  const incompleteParent = category()
  delete incompleteParent.permission_overwrites
  await assert.rejects(
    () => fixture({
      state: { channels: [incompleteParent] },
    }).service.plan(BOT_ID, request()),
    /parent permission evidence is incomplete/,
  )
  const fullCategory = Array.from({ length: 50 }, (_, index) => ({
    guild_id: GUILD_ID,
    id: String(800_000_000_000_000_000n + BigInt(index)),
    name: `child-${index}`,
    parent_id: CATEGORY_ID,
    type: DISCORD_CHANNEL_TYPES.voice,
  }))
  await assert.rejects(
    () => fixture({
      state: { channels: [category(), ...fullCategory] },
    }).service.plan(BOT_ID, request()),
    /50-channel limit/,
  )
  await assert.rejects(
    () => fixture({ state: { guildName: "" } }).service.plan(BOT_ID, request()),
    /incomplete or mismatched channel-creation guild evidence/,
  )
  const missingGuildIdentity = category()
  delete missingGuildIdentity.guild_id
  await assert.rejects(
    () => fixture({
      state: { channels: [missingGuildIdentity] },
    }).service.plan(BOT_ID, request()),
    /invalid or mismatched guild channel evidence/,
  )
  await assert.rejects(
    () => fixture({
      state: { channels: [category({ id: 500_000_000_000_000_001 as never })] },
    }).service.plan(BOT_ID, request()),
    /invalid or mismatched guild channel evidence/,
  )
})

test("channel creation policy is independently disabled and exact-guild scoped", async () => {
  await assert.rejects(
    () => fixture({ policy: policy({ enabled: false }) }).service.plan(BOT_ID, request()),
    /creation is disabled/,
  )
  await assert.rejects(
    () => fixture({ policy: policy({ guildIds: ["999"] }) }).service.plan(BOT_ID, request()),
    /outside the channel creation scope/,
  )
})

test("channel creation reserves, journals, writes once, and stores no Discord content", async () => {
  const target = fixture()
  const plan = await target.service.plan(BOT_ID, request())
  const result = await target.service.execute(BOT_ID, request(), plan.digest)

  assert.equal(result.status, "completed")
  assert.equal(result.channelId, CREATED_CHANNEL_ID)
  assert.deepEqual(
    target.events.filter((event) => (
      event.startsWith("operation:")
      || event.startsWith("activity:")
      || event === "write:create"
    )),
    [
      "operation:reserve",
      "activity:pending",
      "write:create",
      "operation:completed",
      "activity:completed",
    ],
  )
  assert.equal(target.activities.length, 2)
  const persisted = JSON.stringify({
    activities: target.activities,
    receipt: target.operationStore.receipt,
  })
  assert.doesNotMatch(
    persisted,
    /customer-help|Private support queue|Reviewed support|channel-create-operation-0001/,
  )
  assert.match(persisted, /600000000000000001/)
})

test("channel creation refuses changed plans and spent operation keys before writing", async () => {
  const changed = fixture()
  const plan = await changed.service.plan(BOT_ID, request())
  changed.state.channels.push({
    guild_id: GUILD_ID,
    id: "700000000000000001",
    name: "unrelated",
    parent_id: null,
    type: DISCORD_CHANNEL_TYPES.voice,
  })
  await assert.rejects(
    () => changed.service.execute(BOT_ID, request(), plan.digest),
    ChannelCreationPlanChangedError,
  )
  assert.equal(changed.events.includes("write:create"), false)

  const spent = fixture()
  const spentPlan = await spent.service.plan(BOT_ID, request())
  spent.operationStore.receipt = {
    activityId: "prior-activity",
    error: null,
    guildId: GUILD_ID,
    kind: "channel-creation",
    operationKeyHash: spentPlan.operationKeyHash,
    planDigest: spentPlan.digest,
    resourceId: null,
    schemaVersion: 1,
    status: "pending",
    timestamp: NOW,
    verification: null,
  }
  await assert.rejects(
    () => spent.service.execute(BOT_ID, request(), spentPlan.digest),
    ChannelCreationOperationConflictError,
  )
  assert.equal(spent.events.includes("write:create"), false)
})

test("channel creation serializes concurrent logical targets across operation keys", async () => {
  let releaseCreate: () => void = () => undefined
  let markCreateStarted: () => void = () => undefined
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve
  })
  const createStarted = new Promise<void>((resolve) => {
    markCreateStarted = resolve
  })
  const target = fixture({
    state: {
      addCreatedToChannels: true,
      createGate,
      createStarted: markCreateStarted,
    },
  })
  const siblingStore = new MemoryOperationStore(target.events)
  const sibling = siblingService(target, siblingStore)
  const firstRequest = request({ operationKey: "channel-create-concurrent-0001" })
  const secondRequest = request({ operationKey: "channel-create-concurrent-0002" })
  const firstPlan = await target.service.plan(BOT_ID, firstRequest)
  const secondPlan = await sibling.plan(BOT_ID, secondRequest)
  const firstExecution = target.service.execute(BOT_ID, firstRequest, firstPlan.digest)
  await createStarted
  const secondExecution = assert.rejects(
    () => sibling.execute(BOT_ID, secondRequest, secondPlan.digest),
    ChannelCreationPlanChangedError,
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(target.events.filter((event) => event === "write:create").length, 1)
  releaseCreate()
  assert.equal((await firstExecution).status, "completed")
  await secondExecution
  assert.equal(target.events.filter((event) => event === "write:create").length, 1)
  assert.equal(siblingStore.receipt, undefined)
})

test("channel creation blocks a queued logical target after an uncertain write", async () => {
  let releaseCreate: () => void = () => undefined
  let markCreateStarted: () => void = () => undefined
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve
  })
  const createStarted = new Promise<void>((resolve) => {
    markCreateStarted = resolve
  })
  const target = fixture({
    state: {
      createGate,
      createStarted: markCreateStarted,
      readbackError: new Error("network unavailable"),
    },
  })
  const siblingStore = new MemoryOperationStore(target.events)
  const sibling = siblingService(target, siblingStore)
  const firstRequest = request({ operationKey: "channel-create-uncertain-0001" })
  const secondRequest = request({ operationKey: "channel-create-uncertain-0002" })
  const firstPlan = await target.service.plan(BOT_ID, firstRequest)
  const secondPlan = await sibling.plan(BOT_ID, secondRequest)
  const firstExecution = assert.rejects(
    () => target.service.execute(BOT_ID, firstRequest, firstPlan.digest),
    (error) => {
      assert.equal(executionResult(error).status, "uncertain")
      return true
    },
  )
  await createStarted
  const secondExecution = assert.rejects(
    () => sibling.execute(BOT_ID, secondRequest, secondPlan.digest),
    (error) => {
      assert.equal(executionResult(error).status, "blocked-prior-uncertain")
      return true
    },
  )
  releaseCreate()
  await Promise.all([firstExecution, secondExecution])
  assert.equal(target.events.filter((event) => event === "write:create").length, 1)
  assert.equal(siblingStore.receipt, undefined)
})

test("channel creation blocks the write when pending activity fails", async () => {
  const target = fixture({ state: { activityFailureAt: 1 } })
  const plan = await target.service.plan(BOT_ID, request())

  await assert.rejects(
    () => target.service.execute(BOT_ID, request(), plan.digest),
    (error) => {
      const result = executionResult(error)
      assert.equal(result.status, "blocked-audit-failed")
      return true
    },
  )
  assert.equal(target.events.includes("write:create"), false)
  assert.equal(target.operationStore.receipt?.status, "failed")
})

test("channel creation distinguishes known Discord rejection from uncertain outcomes", async () => {
  const known = fixture({
    state: {
      createError: new DiscordApiError({
        code: 50013,
        message: "Discord API POST returned 403: Missing Permissions",
        method: "POST",
        route: `/guilds/${GUILD_ID}/channels`,
        status: 403,
      }),
    },
  })
  const knownPlan = await known.service.plan(BOT_ID, request())
  await assert.rejects(
    () => known.service.execute(BOT_ID, request(), knownPlan.digest),
    (error) => {
      assert.equal(executionResult(error).status, "failed")
      return true
    },
  )
  assert.equal(known.operationStore.receipt?.status, "failed")

  const uncertain = fixture({ state: { readbackError: new Error("network unavailable") } })
  const uncertainPlan = await uncertain.service.plan(BOT_ID, request())
  await assert.rejects(
    () => uncertain.service.execute(BOT_ID, request(), uncertainPlan.digest),
    (error) => {
      const result = executionResult(error)
      assert.equal(result.status, "uncertain")
      assert.equal(result.channelId, CREATED_CHANNEL_ID)
      return true
    },
  )
  assert.equal(uncertain.operationStore.receipt?.status, "uncertain")
  assert.equal(uncertain.operationStore.receipt?.resourceId, CREATED_CHANNEL_ID)

  const mismatchedReadback = fixture({
    state: {
      readback: createdChannel({ id: "600000000000000002" }),
    },
  })
  const mismatchedPlan = await mismatchedReadback.service.plan(BOT_ID, request())
  await assert.rejects(
    () => mismatchedReadback.service.execute(BOT_ID, request(), mismatchedPlan.digest),
    (error) => {
      const result = executionResult(error)
      assert.equal(result.status, "uncertain")
      assert.equal(result.channelId, CREATED_CHANNEL_ID)
      return true
    },
  )
  assert.equal(mismatchedReadback.operationStore.receipt?.status, "uncertain")

  const malformedReadback = fixture({
    state: {
      readback: createdChannel({ nsfw: "false" as never }),
    },
  })
  const malformedPlan = await malformedReadback.service.plan(BOT_ID, request())
  await assert.rejects(
    () => malformedReadback.service.execute(BOT_ID, request(), malformedPlan.digest),
    (error) => {
      assert.equal(executionResult(error).status, "uncertain")
      return true
    },
  )
  assert.equal(malformedReadback.operationStore.receipt?.status, "uncertain")

  const malformedCreated = fixture({
    state: {
      created: createdChannel({ id: 600_000_000_000_000_001 as never }),
    },
  })
  const malformedCreatedPlan = await malformedCreated.service.plan(BOT_ID, request())
  await assert.rejects(
    () => malformedCreated.service.execute(BOT_ID, request(), malformedCreatedPlan.digest),
    (error) => {
      const result = executionResult(error)
      assert.equal(result.status, "uncertain")
      assert.equal(result.channelId, null)
      return true
    },
  )
  assert.equal(malformedCreated.operationStore.receipt?.resourceId, null)
  assert.equal(malformedCreated.events.includes("read:created"), false)
})

test("channel creation reports verified server drift without retrying or rolling back", async () => {
  const target = fixture({
    state: { readback: createdChannel({ name: "customer-help-normalized" }) },
  })
  const plan = await target.service.plan(BOT_ID, request())
  const result = await target.service.execute(BOT_ID, request(), plan.digest)

  assert.equal(result.status, "completed-with-drift")
  assert.equal(result.observed.name, "customer-help-normalized")
  assert.equal(target.operationStore.receipt?.status, "completed")
  assert.equal(target.operationStore.receipt?.verification, "drift")
  assert.equal(target.events.filter((event) => event === "write:create").length, 1)
})

test("channel creation reports completed local record failures with the known channel ID", async () => {
  const receiptFailure = fixture()
  receiptFailure.operationStore.finishFailure = new Error("receipt unavailable")
  const receiptPlan = await receiptFailure.service.plan(BOT_ID, request())
  await assert.rejects(
    () => receiptFailure.service.execute(BOT_ID, request(), receiptPlan.digest),
    (error) => {
      const result = executionResult(error)
      assert.equal(result.status, "completed-operation-record-failed")
      assert.equal(result.channelId, CREATED_CHANNEL_ID)
      return true
    },
  )

  const auditFailure = fixture({ state: { activityFailureAt: 2 } })
  const auditPlan = await auditFailure.service.plan(BOT_ID, request())
  await assert.rejects(
    () => auditFailure.service.execute(BOT_ID, request(), auditPlan.digest),
    (error) => {
      const result = executionResult(error)
      assert.equal(result.status, "completed-audit-failed")
      assert.equal(result.channelId, CREATED_CHANNEL_ID)
      return true
    },
  )
  assert.equal(auditFailure.operationStore.receipt?.status, "completed")
})
