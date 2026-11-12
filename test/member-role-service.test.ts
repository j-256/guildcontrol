import assert from "node:assert/strict"
import test from "node:test"

import type { ActivityEntry, ActivityStore } from "../src/activity-log.js"
import { BULK_MEMBER_ROLE_AUTHORITY } from "../src/bulk-member-role-authority.js"
import { CONNECTOR_LIMITS, SCHEMA_VERSION } from "../src/constants.js"
import {
  DiscordApiError,
  MemberRoleExecutionError,
  MemberRoleOperationConflictError,
  MemberRolePlanChangedError,
} from "../src/errors.js"
import {
  MemberRoleService,
  normalizeMemberRoleChangeRequest,
  type MemberRoleChangeRequest,
  type MemberRoleServiceOptions,
} from "../src/member-role-service.js"
import type {
  GatewayChannelLayoutListener,
  GatewayChannelLayoutSource,
} from "../src/gateway-channel-layout.js"
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
const APPLICATION_ID = "150000000000000001"
const BOT_ID = "200000000000000001"
const OWNER_ID = "300000000000000001"
const BOT_ROLE_ID = "400000000000000001"
const USER_ID = "500000000000000001"
const ROLE_ID = "600000000000000001"
const CHANNEL_ID = "700000000000000001"
const OPAQUE_CHANNEL_ID = "700000000000000002"
const AUDIT_REASON = "Reviewed support role assignment"
const OPERATION_KEY = "member-role-operation-0001"
const NOW = "2026-08-21T00:00:00.000Z"

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
  id = CHANNEL_ID,
  overrides: Partial<DiscordChannel> = {},
): DiscordChannel {
  return {
    guild_id: GUILD_ID,
    id,
    name: "private-channel-name",
    parent_id: null,
    permission_overwrites: [],
    position: 0,
    type: 0,
    ...overrides,
  }
}

function request(
  overrides: Partial<MemberRoleChangeRequest> = {},
): MemberRoleChangeRequest {
  return {
    action: "add",
    auditReason: AUDIT_REASON,
    guildId: GUILD_ID,
    operationKey: OPERATION_KEY,
    roleId: ROLE_ID,
    userId: USER_ID,
    ...overrides,
  }
}

function policy(options: {
  batchEnabled?: boolean
  batchGuildIds?: readonly string[]
  batchRoleIds?: readonly string[]
  enabled?: boolean
  guildIds?: readonly string[]
  protectedUserIds?: readonly string[]
  roleIds?: readonly string[]
} = {}): ScopePolicy {
  return new ScopePolicy({
    adminGuildIds: new Set(),
    allowedChannelIds: new Set(),
    allowedGuildIds: new Set([GUILD_ID]),
    allowAdministration: false,
    allowBulkMemberRoleChanges: options.batchEnabled ?? false,
    allowDeletions: false,
    allowInteractions: false,
    allowMemberRoleChanges: options.enabled ?? true,
    bulkMemberRoleGuildIds: new Set(options.batchGuildIds || [GUILD_ID]),
    bulkMemberRoleIds: new Set(options.batchRoleIds || [ROLE_ID]),
    deleteChannelIds: new Set(),
    interactionChannelIds: new Set(),
    interactionMaxWritesPerMinute: 10,
    interactionMinWriteIntervalMs: 500,
    memberRoleGuildIds: new Set(options.guildIds || [GUILD_ID]),
    memberRoleIds: new Set(options.roleIds || [ROLE_ID]),
    mentionUserIds: new Set(),
    protectedUserIds: new Set(options.protectedUserIds || []),
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
  applyMutation: boolean
  botMember: DiscordGuildMember
  channels: DiscordChannel[]
  guildName: string
  mutationError: unknown
  mutationGate: Promise<void> | null
  mutationStarted: (() => void) | null
  obfuscatedChannelIds: Set<string>
  ownerId: string
  readbackError: unknown
  roles: DiscordRole[]
  rolesAfterFirstRead: DiscordRole[] | null
  targetMember: DiscordGuildMember
  targetMembers: Record<string, DiscordGuildMember>
}

function fixture(options: {
  policy?: ScopePolicy
  state?: Partial<FixtureState>
} = {}) {
  const selectedPermissions = DISCORD_PERMISSIONS.VIEW_CHANNEL
    | DISCORD_PERMISSIONS.SEND_MESSAGES
    | DISCORD_PERMISSIONS.ATTACH_FILES
  const botPermissions = DISCORD_PERMISSIONS.MANAGE_ROLES | selectedPermissions
  const state: FixtureState = {
    activityFailureAt: null,
    applyMutation: true,
    botMember: {
      roles: [BOT_ROLE_ID],
      user: { bot: true, id: BOT_ID, username: "connector" },
    },
    channels: [channel()],
    guildName: "Private Guild Name",
    mutationError: undefined,
    mutationGate: null,
    mutationStarted: null,
    obfuscatedChannelIds: new Set(),
    ownerId: OWNER_ID,
    readbackError: undefined,
    roles: [
      role(GUILD_ID, "@everyone", DISCORD_PERMISSIONS.VIEW_CHANNEL, 0),
      role(ROLE_ID, "Support", selectedPermissions, 2),
      role(BOT_ROLE_ID, "connector", botPermissions, 10, {
        managed: true,
        tags: { bot_id: BOT_ID },
      }),
    ],
    rolesAfterFirstRead: null,
    targetMember: {
      roles: [],
      user: { id: USER_ID, username: "target-user" },
    },
    targetMembers: {},
    ...options.state,
  }
  const activities: ActivityEntry[] = []
  const events: string[] = []
  let activityCalls = 0
  let roleReads = 0
  let writes = 0
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
  const layoutSource: GatewayChannelLayoutSource = {
    layoutEnabled: true,
    getChannelLayout(guildId) {
      return {
        channels: state.channels.map((entry, position) => ({
          channelId: entry.id,
          obfuscated: state.obfuscatedChannelIds.has(entry.id),
          parentChannelId: entry.parent_id ?? null,
          position: entry.position ?? position,
          type: entry.type,
        })),
        complete: true,
        guildId,
        reason: null,
        revision: 1,
        schemaVersion: SCHEMA_VERSION,
        state: "ready",
        updatedAt: NOW,
      }
    },
    getChannelLayoutStatus() {
      return {
        channels: {
          obfuscated: state.obfuscatedChannelIds.size,
          retained: state.channels.length,
        },
        enabled: true,
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
        updates: 1,
      }
    },
    subscribeChannelLayouts(_listener: GatewayChannelLayoutListener) {
      return () => undefined
    },
  }
  async function mutate(action: "add" | "remove") {
    writes += 1
    events.push(`write:${action}`)
    state.mutationStarted?.()
    if (state.mutationGate) await state.mutationGate
    if (state.mutationError) throw state.mutationError
    if (!state.applyMutation) return
    const roles = new Set(state.targetMember.roles)
    if (action === "add") roles.add(ROLE_ID)
    else roles.delete(ROLE_ID)
    state.targetMember.roles = [...roles]
  }
  const client: MemberRoleServiceOptions["client"] = {
    async addGuildMemberRole() {
      await mutate("add")
    },
    async getGuild() {
      events.push("read:guild")
      return {
        id: GUILD_ID,
        name: state.guildName,
        owner_id: state.ownerId,
      }
    },
    async getGuildChannels() {
      events.push("read:channels")
      return state.channels
    },
    async getGuildMember(_guildId, userId) {
      events.push(`read:member:${userId}`)
      if (userId === BOT_ID) return state.botMember
      if (writes > 0 && state.readbackError) throw state.readbackError
      return userId === USER_ID
        ? state.targetMember
        : state.targetMembers[userId] ?? state.targetMember
    },
    async getGuildRoles() {
      events.push("read:roles")
      roleReads += 1
      return roleReads > 1 && state.rolesAfterFirstRead
        ? state.rolesAfterFirstRead
        : state.roles
    },
    async removeGuildMemberRole() {
      await mutate("remove")
    },
  }
  const service = new MemberRoleService({
    activityStore,
    client,
    clock: () => new Date(NOW),
    layoutSource,
    operationStore,
    planKey: new Uint8Array(32).fill(7),
    policy: options.policy || policy(),
    randomId: () => "member-role-activity-0001",
  })
  return {
    activities,
    activityStore,
    client,
    events,
    layoutSource,
    operationStore,
    service,
    state,
  }
}

function siblingService(
  target: ReturnType<typeof fixture>,
  operationStore: OperationStore,
): MemberRoleService {
  return new MemberRoleService({
    activityStore: target.activityStore,
    client: target.client,
    clock: () => new Date(NOW),
    layoutSource: target.layoutSource,
    operationStore,
    planKey: new Uint8Array(32).fill(7),
    policy: policy(),
    randomId: () => "member-role-activity-sibling",
  })
}

function executionResult(error: unknown): Record<string, unknown> {
  assert.ok(error instanceof MemberRoleExecutionError)
  assert.ok(error.result && typeof error.result === "object")
  return error.result as Record<string, unknown>
}

test("member-role normalization requires exact action, IDs, reason, and operation key", () => {
  const normalized = normalizeMemberRoleChangeRequest(request())
  assert.equal(normalized.action, "add")
  assert.equal(normalized.userId, USER_ID)
  assert.match(normalized.operationKeyHash, /^sha256:[a-f0-9]{64}$/)
  assert.throws(
    () => normalizeMemberRoleChangeRequest(request({ action: "replace" as "add" })),
    /action must be add or remove/,
  )
  assert.throws(
    () => normalizeMemberRoleChangeRequest(request({ roleId: "0" })),
    /exact role snowflake/,
  )
  assert.throws(
    () => normalizeMemberRoleChangeRequest(request({ auditReason: "\ud800" })),
    /invalid Unicode/,
  )
  assert.throws(
    () => normalizeMemberRoleChangeRequest(request({ operationKey: "short" })),
    /operation key/,
  )
})

test("member-role planning reports exact direct-channel impact and executes one reviewed add", async () => {
  const target = fixture()
  const plan = await target.service.plan(APPLICATION_ID, BOT_ID, request())
  assert.equal(plan.status, "planned")
  assert.equal(plan.action, "add")
  assert.equal(plan.member.beforeRoleIds.includes(ROLE_ID), false)
  assert.equal(plan.member.afterRoleIds.includes(ROLE_ID), true)
  assert.equal(plan.impact.evaluatedChannels, 1)
  assert.equal(plan.impact.changedChannels, 1)
  assert.deepEqual(plan.impact.guildPermissions.before, ["VIEW_CHANNEL"])
  assert.deepEqual(plan.impact.guildPermissions.after, [
    "VIEW_CHANNEL",
    "SEND_MESSAGES",
    "ATTACH_FILES",
  ])
  assert.deepEqual(plan.impact.guildPermissions.added, [
    "SEND_MESSAGES",
    "ATTACH_FILES",
  ])
  assert.deepEqual(plan.impact.guildPermissions.removed, [])
  assert.equal(plan.permission.channelPermissionEscalationSubset, true)
  assert.deepEqual(
    plan.impact.channels[0]?.changes
      .filter(({ permission }) => ["ATTACH_FILES", "SEND_MESSAGES"].includes(permission))
      .map(({ after, before, permission }) => ({ after, before, permission })),
    [
      { after: "allowed", before: "denied", permission: "SEND_MESSAGES" },
      { after: "allowed", before: "denied", permission: "ATTACH_FILES" },
    ],
  )

  const result = await target.service.execute(
    APPLICATION_ID,
    BOT_ID,
    request(),
    plan.digest,
  )
  assert.equal(result.status, "completed")
  assert.equal(result.rolePresent, true)
  assert.equal(result.roleSnapshotMatched, true)
  assert.equal(target.events.filter((entry) => entry === "write:add").length, 1)
  assert.deepEqual(target.events.slice(-5), [
    "activity:pending",
    "write:add",
    "read:member:500000000000000001",
    "operation:completed",
  ].concat("activity:completed"))
  const durable = JSON.stringify({
    activities: target.activities,
    receipt: target.operationStore.receipt,
  })
  assert.doesNotMatch(durable, /Private Guild Name|Support|target-user/)
  assert.doesNotMatch(durable, /Reviewed support role assignment/)
  assert.doesNotMatch(durable, new RegExp(OPERATION_KEY))
})

test("member-role batch authority uses only the independent batch policy", async () => {
  const target = fixture({ policy: policy({ batchEnabled: true, enabled: false }) })
  await assert.rejects(
    target.service.plan(APPLICATION_ID, BOT_ID, request()),
    /member-role changes are disabled/,
  )
  const plan = await target.service.planForBulk(
    BULK_MEMBER_ROLE_AUTHORITY,
    APPLICATION_ID,
    BOT_ID,
    request(),
  )
  assert.match(plan.commonEvidenceDigest, /^hmac-sha256:[a-f0-9]{64}$/)
  const result = await target.service.executeForBulk(
    BULK_MEMBER_ROLE_AUTHORITY,
    APPLICATION_ID,
    BOT_ID,
    request(),
    plan.digest,
  )
  assert.equal(result.status, "completed")
  assert.equal(target.events.filter((entry) => entry === "write:add").length, 1)
})

test("member-role batch planning brackets target reads with coherent common snapshots", async () => {
  const userIds = Array.from(
    { length: CONNECTOR_LIMITS.bulkMemberRoleTargets },
    (_, index) => (BigInt(USER_ID) + BigInt(index)).toString(),
  )
  const targetMembers = Object.fromEntries(userIds.slice(1).map((userId, index) => [
    userId,
    {
      roles: [],
      user: { id: userId, username: `target-user-${index + 2}` },
    },
  ]))
  const target = fixture({
    policy: policy({ batchEnabled: true, enabled: false }),
    state: { targetMembers },
  })
  const requests = userIds.map((userId, index) => request({
    operationKey: `member-role-batch-operation-${index + 1}`,
    userId,
  }))

  const batch = await target.service.planBatchForBulk(
    BULK_MEMBER_ROLE_AUTHORITY,
    APPLICATION_ID,
    BOT_ID,
    requests,
  )
  const plans = batch.plans

  assert.deepEqual(plans.map((plan) => plan.member.id), userIds)
  assert.equal(new Set(plans.map((plan) => plan.commonEvidenceDigest)).size, 1)
  assert.equal(batch.baselineCommonEvidenceDigest, plans[0]?.commonEvidenceDigest)
  assert.equal(target.events.filter((entry) => entry === "read:guild").length, 2)
  assert.equal(target.events.filter((entry) => entry === "read:channels").length, 2)
  assert.equal(target.events.filter((entry) => entry === "read:roles").length, 2)
  assert.equal(
    target.events.filter((entry) => entry === `read:member:${BOT_ID}`).length,
    2,
  )
  assert.deepEqual(
    target.events
      .filter((entry) => entry.startsWith("read:member:") && entry !== `read:member:${BOT_ID}`)
      .map((entry) => entry.slice("read:member:".length)),
    userIds,
  )
  assert.equal(
    target.events.filter((entry) => entry.startsWith("read:")).length,
    CONNECTOR_LIMITS.bulkMemberRoleTargets + 8,
  )

  const individualPlans = []
  for (const childRequest of requests) {
    individualPlans.push(await target.service.planForBulk(
      BULK_MEMBER_ROLE_AUTHORITY,
      APPLICATION_ID,
      BOT_ID,
      childRequest,
    ))
  }
  assert.deepEqual(plans, individualPlans)
})

test("member-role batch planning surfaces common role drift across target reads", async () => {
  const secondUserId = (BigInt(USER_ID) + 1n).toString()
  const target = fixture({
    policy: policy({ batchEnabled: true, enabled: false }),
    state: {
      targetMembers: {
        [secondUserId]: {
          roles: [],
          user: { id: secondUserId, username: "target-user-2" },
        },
      },
    },
  })
  target.state.rolesAfterFirstRead = target.state.roles.map((entry) => (
    entry.id === ROLE_ID ? { ...entry, position: entry.position + 1 } : entry
  ))

  const batch = await target.service.planBatchForBulk(
    BULK_MEMBER_ROLE_AUTHORITY,
    APPLICATION_ID,
    BOT_ID,
    [
      request({ operationKey: "member-role-batch-common-drift-1" }),
      request({
        operationKey: "member-role-batch-common-drift-2",
        userId: secondUserId,
      }),
    ],
  )

  assert.notEqual(
    batch.baselineCommonEvidenceDigest,
    batch.plans[0]?.commonEvidenceDigest,
  )
  assert.equal(target.events.filter((entry) => entry === "read:roles").length, 2)
})

test("member-role batch planning rejects late layout drift after every target read", async () => {
  const secondUserId = (BigInt(USER_ID) + 1n).toString()
  const target = fixture({
    policy: policy({ batchEnabled: true, enabled: false }),
    state: {
      targetMembers: {
        [secondUserId]: {
          roles: [],
          user: { id: secondUserId, username: "target-user-2" },
        },
      },
    },
  })
  const originalLayout = target.layoutSource.getChannelLayout.bind(target.layoutSource)
  let layoutReads = 0
  target.layoutSource.getChannelLayout = (guildId) => {
    const layout = originalLayout(guildId)
    layoutReads += 1
    return layoutReads === 2
      ? { ...layout, revision: layout.revision + 1 }
      : layout
  }

  await assert.rejects(
    target.service.planBatchForBulk(
      BULK_MEMBER_ROLE_AUTHORITY,
      APPLICATION_ID,
      BOT_ID,
      [
        request({ operationKey: "member-role-batch-drift-1" }),
        request({
          operationKey: "member-role-batch-drift-2",
          userId: secondUserId,
        }),
      ],
    ),
    /channel evidence is incomplete: Discord Gateway channel layout changed/,
  )
  assert.equal(layoutReads, 2)
  assert.equal(
    target.events.filter((entry) => entry === `read:member:${USER_ID}`).length,
    1,
  )
  assert.equal(
    target.events.filter((entry) => entry === `read:member:${secondUserId}`).length,
    1,
  )
})

test("member-role batch planning rejects inconsistent or protected targets before reads", async () => {
  const secondUserId = (BigInt(USER_ID) + 1n).toString()
  const protectedTarget = fixture({
    policy: policy({
      batchEnabled: true,
      enabled: false,
      protectedUserIds: [secondUserId],
    }),
    state: {
      targetMembers: {
        [secondUserId]: {
          roles: [],
          user: { id: secondUserId, username: "target-user-2" },
        },
      },
    },
  })
  await assert.rejects(
    protectedTarget.service.planBatchForBulk(
      BULK_MEMBER_ROLE_AUTHORITY,
      APPLICATION_ID,
      BOT_ID,
      [
        request({ operationKey: "member-role-batch-protected-1" }),
        request({
          operationKey: "member-role-batch-protected-2",
          userId: secondUserId,
        }),
      ],
    ),
    /is protected from administration/,
  )
  assert.equal(protectedTarget.events.some((entry) => entry.startsWith("read:")), false)

  const inconsistent = fixture({
    policy: policy({ batchEnabled: true, enabled: false }),
  })
  await assert.rejects(
    inconsistent.service.planBatchForBulk(
      BULK_MEMBER_ROLE_AUTHORITY,
      APPLICATION_ID,
      BOT_ID,
      [
        request({ operationKey: "member-role-batch-mixed-1" }),
        request({
          action: "remove",
          operationKey: "member-role-batch-mixed-2",
          userId: secondUserId,
        }),
      ],
    ),
    /one exact action, reason, guild, and role/,
  )
  await assert.rejects(
    inconsistent.service.planBatchForBulk(
      BULK_MEMBER_ROLE_AUTHORITY,
      APPLICATION_ID,
      BOT_ID,
      [
        request({
          operationKey: "member-role-batch-order-2",
          userId: secondUserId,
        }),
        request({ operationKey: "member-role-batch-order-1" }),
      ],
    ),
    /strictly ordered unique canonical targets/,
  )
  assert.equal(inconsistent.events.some((entry) => entry.startsWith("read:")), false)
})

test("member-role plans and executes exact removals", async () => {
  const target = fixture({ state: {
    targetMember: {
      roles: [ROLE_ID],
      user: { id: USER_ID, username: "target-user" },
    },
  } })
  const remove = request({ action: "remove" })
  const plan = await target.service.plan(APPLICATION_ID, BOT_ID, remove)
  assert.equal(plan.action, "remove")
  assert.equal(plan.member.afterRoleIds.includes(ROLE_ID), false)
  const result = await target.service.execute(
    APPLICATION_ID,
    BOT_ID,
    remove,
    plan.digest,
  )
  assert.equal(result.status, "completed")
  assert.equal(result.rolePresent, false)
  assert.equal(target.events.filter((entry) => entry === "write:remove").length, 1)
})

test("member-role no-ops do not reserve, audit, or write", async () => {
  const addCurrent = fixture({ state: {
    targetMember: {
      roles: [ROLE_ID],
      user: { id: USER_ID, username: "target-user" },
    },
  } })
  const addPlan = await addCurrent.service.plan(APPLICATION_ID, BOT_ID, request())
  const addResult = await addCurrent.service.execute(
    APPLICATION_ID,
    BOT_ID,
    request(),
    addPlan.digest,
  )
  assert.equal(addPlan.status, "already-current")
  assert.equal(addResult.status, "already-current")
  assert.equal(addCurrent.operationStore.receipt, undefined)
  assert.equal(addCurrent.events.some((entry) => entry.startsWith("write:")), false)
  assert.equal(addCurrent.activities.length, 0)

  const removeCurrent = fixture()
  const remove = request({ action: "remove" })
  const removePlan = await removeCurrent.service.plan(APPLICATION_ID, BOT_ID, remove)
  const removeResult = await removeCurrent.service.execute(
    APPLICATION_ID,
    BOT_ID,
    remove,
    removePlan.digest,
  )
  assert.equal(removeResult.status, "already-current")
  assert.equal(removeCurrent.operationStore.receipt, undefined)

  const highRiskCurrent = fixture({ state: {
    targetMember: {
      roles: [ROLE_ID],
      user: { id: USER_ID, username: "target-user" },
    },
  } })
  const selectedRole = highRiskCurrent.state.roles.find(
    ({ id }) => id === ROLE_ID,
  ) as DiscordRole
  selectedRole.permissions = DISCORD_PERMISSIONS.ADMINISTRATOR.toString()
  const highRiskPlan = await highRiskCurrent.service.plan(
    APPLICATION_ID,
    BOT_ID,
    request(),
  )
  assert.equal(highRiskPlan.status, "already-current")
  assert.equal(highRiskPlan.permission.rolePermissionsSubset, false)
  assert.deepEqual(highRiskPlan.highRiskPermissions, ["ADMINISTRATOR"])
  assert.match(highRiskPlan.warnings.join(" "), /No write is required/)
})

test("member-role additions block dangerous permission and overwrite escalation", async () => {
  const unknownBit = 1n << 60n
  const unknownRole = fixture({ state: {
    roles: [
      role(GUILD_ID, "@everyone", DISCORD_PERMISSIONS.VIEW_CHANNEL, 0),
      role(ROLE_ID, "Future", unknownBit, 2),
      role(
        BOT_ROLE_ID,
        "connector",
        DISCORD_PERMISSIONS.MANAGE_ROLES,
        10,
        { managed: true, tags: { bot_id: BOT_ID } },
      ),
    ],
  } })
  await assert.rejects(
    unknownRole.service.plan(APPLICATION_ID, BOT_ID, request()),
    /unknown permission bits/,
  )

  const administrator = fixture()
  const selected = administrator.state.roles.find(({ id }) => id === ROLE_ID) as DiscordRole
  selected.permissions = DISCORD_PERMISSIONS.ADMINISTRATOR.toString()
  await assert.rejects(
    administrator.service.plan(APPLICATION_ID, BOT_ID, request()),
    /never grant ADMINISTRATOR/,
  )

  const unavailable = fixture()
  const unavailableRole = unavailable.state.roles.find(({ id }) => id === ROLE_ID) as DiscordRole
  unavailableRole.permissions = (
    DISCORD_PERMISSIONS.VIEW_CHANNEL | DISCORD_PERMISSIONS.BAN_MEMBERS
  ).toString()
  await assert.rejects(
    unavailable.service.plan(APPLICATION_ID, BOT_ID, request()),
    /cannot grant selected-role permissions: BAN_MEMBERS/,
  )

  const overwrite = fixture({ state: {
    channels: [channel(CHANNEL_ID, { permission_overwrites: [{
      allow: unknownBit.toString(),
      deny: "0",
      id: ROLE_ID,
      type: 0,
    }] })],
  } })
  await assert.rejects(
    overwrite.service.plan(APPLICATION_ID, BOT_ID, request()),
    /unknown selected-role overwrite bits/,
  )

  const ungrantableOverwrite = fixture({ state: {
    channels: [channel(CHANNEL_ID, { permission_overwrites: [{
      allow: DISCORD_PERMISSIONS.SEND_MESSAGES.toString(),
      deny: "0",
      id: ROLE_ID,
      type: 0,
    }] })],
    roles: [
      role(GUILD_ID, "@everyone", DISCORD_PERMISSIONS.VIEW_CHANNEL, 0),
      role(ROLE_ID, "Channel sender", DISCORD_PERMISSIONS.VIEW_CHANNEL, 2),
      role(
        BOT_ROLE_ID,
        "connector",
        DISCORD_PERMISSIONS.MANAGE_ROLES | DISCORD_PERMISSIONS.VIEW_CHANNEL,
        10,
        { managed: true, tags: { bot_id: BOT_ID } },
      ),
    ],
  } })
  await assert.rejects(
    ungrantableOverwrite.service.plan(APPLICATION_ID, BOT_ID, request()),
    /cannot grant channel permission SEND_MESSAGES/,
  )

  const existingRoleId = "650000000000000001"
  const dormantUngrantableOverwrite = fixture({ state: {
    channels: [channel(CHANNEL_ID, { permission_overwrites: [{
      allow: DISCORD_PERMISSIONS.SEND_MESSAGES.toString(),
      deny: "0",
      id: ROLE_ID,
      type: 0,
    }] })],
    roles: [
      role(GUILD_ID, "@everyone", DISCORD_PERMISSIONS.VIEW_CHANNEL, 0),
      role(ROLE_ID, "Channel sender", DISCORD_PERMISSIONS.VIEW_CHANNEL, 2),
      role(existingRoleId, "Existing sender", DISCORD_PERMISSIONS.SEND_MESSAGES, 3),
      role(
        BOT_ROLE_ID,
        "connector",
        DISCORD_PERMISSIONS.MANAGE_ROLES | DISCORD_PERMISSIONS.VIEW_CHANNEL,
        10,
        { managed: true, tags: { bot_id: BOT_ID } },
      ),
    ],
    targetMember: {
      roles: [existingRoleId],
      user: { id: USER_ID, username: "target-user" },
    },
  } })
  await assert.rejects(
    dormantUngrantableOverwrite.service.plan(APPLICATION_ID, BOT_ID, request()),
    /cannot grant channel permission SEND_MESSAGES/,
  )

  const nonChannelOverwrite = fixture({ state: {
    channels: [channel(CHANNEL_ID, { permission_overwrites: [{
      allow: DISCORD_PERMISSIONS.ADMINISTRATOR.toString(),
      deny: "0",
      id: ROLE_ID,
      type: 0,
    }] })],
  } })
  await assert.rejects(
    nonChannelOverwrite.service.plan(APPLICATION_ID, BOT_ID, request()),
    /known permissions that are not channel-scoped/,
  )

  const highRiskOverwrite = fixture({ state: {
    channels: [channel(CHANNEL_ID, { permission_overwrites: [{
      allow: DISCORD_PERMISSIONS.MANAGE_MESSAGES.toString(),
      deny: "0",
      id: ROLE_ID,
      type: 0,
    }] })],
    roles: [
      role(GUILD_ID, "@everyone", DISCORD_PERMISSIONS.VIEW_CHANNEL, 0),
      role(ROLE_ID, "Channel moderator", DISCORD_PERMISSIONS.VIEW_CHANNEL, 2),
      role(
        BOT_ROLE_ID,
        "connector",
        DISCORD_PERMISSIONS.MANAGE_ROLES
          | DISCORD_PERMISSIONS.MANAGE_MESSAGES
          | DISCORD_PERMISSIONS.VIEW_CHANNEL,
        10,
        { managed: true, tags: { bot_id: BOT_ID } },
      ),
    ],
  } })
  const highRiskPlan = await highRiskOverwrite.service.plan(
    APPLICATION_ID,
    BOT_ID,
    request(),
  )
  assert.deepEqual(highRiskPlan.highRiskPermissions, [])
  assert.deepEqual(highRiskPlan.highRiskPermissionGains, ["MANAGE_MESSAGES"])
  assert.match(highRiskPlan.warnings.join(" "), /high-risk effective permissions/)
})

test("member-role removals may de-escalate unknown permissions", async () => {
  const unknownBit = 1n << 60n
  const target = fixture({ state: {
    channels: [channel(CHANNEL_ID, { permission_overwrites: [{
      allow: unknownBit.toString(),
      deny: "0",
      id: ROLE_ID,
      type: 0,
    }] })],
    roles: [
      role(GUILD_ID, "@everyone", DISCORD_PERMISSIONS.VIEW_CHANNEL, 0),
      role(ROLE_ID, "Future", unknownBit, 2),
      role(
        BOT_ROLE_ID,
        "connector",
        DISCORD_PERMISSIONS.MANAGE_ROLES,
        10,
        { managed: true, tags: { bot_id: BOT_ID } },
      ),
    ],
    targetMember: {
      roles: [ROLE_ID],
      user: { id: USER_ID, username: "target-user" },
    },
  } })
  const plan = await target.service.plan(
    APPLICATION_ID,
    BOT_ID,
    request({ action: "remove" }),
  )
  assert.equal(plan.permission.rolePermissionsSubset, false)
  assert.equal(
    plan.permission.roleOverwriteUnknownPermissionBits,
    unknownBit.toString(),
  )
  assert.match(plan.warnings.join(" "), /unknown selected-role permission bits/)
  assert.match(plan.warnings.join(" "), /unknown selected-role overwrite bits/)
  assert.match(plan.warnings.join(" "), /outside the connector bot's effective/)
})

test("member-role plans disclose unknown bits elsewhere in complete inventories", async () => {
  const unknownBit = 1n << 60n
  const unrelatedRoleId = "650000000000000001"
  const target = fixture({ state: {
    channels: [channel(CHANNEL_ID, { permission_overwrites: [{
      allow: "0",
      deny: unknownBit.toString(),
      id: unrelatedRoleId,
      type: 0,
    }] })],
    roles: [
      role(GUILD_ID, "@everyone", DISCORD_PERMISSIONS.VIEW_CHANNEL, 0),
      role(ROLE_ID, "Support", DISCORD_PERMISSIONS.SEND_MESSAGES, 2),
      role(unrelatedRoleId, "Future", unknownBit, 3),
      role(
        BOT_ROLE_ID,
        "connector",
        DISCORD_PERMISSIONS.MANAGE_ROLES | DISCORD_PERMISSIONS.SEND_MESSAGES,
        10,
        { managed: true, tags: { bot_id: BOT_ID } },
      ),
    ],
  } })

  const plan = await target.service.plan(APPLICATION_ID, BOT_ID, request())

  assert.equal(plan.permission.guildRoleUnknownPermissionBits, unknownBit.toString())
  assert.equal(
    plan.permission.channelOverwriteUnknownPermissionBits,
    unknownBit.toString(),
  )
  assert.match(plan.warnings.join(" "), /Guild role inventory contains/)
  assert.match(plan.warnings.join(" "), /Direct-channel overwrite inventory contains/)
})

test("member-role planning enforces local scope, identities, target state, and hierarchy", async () => {
  await assert.rejects(
    fixture({ policy: policy({ enabled: false }) }).service.plan(
      APPLICATION_ID,
      BOT_ID,
      request(),
    ),
    /disabled/,
  )
  await assert.rejects(
    fixture({ policy: policy({ protectedUserIds: [USER_ID] }) }).service.plan(
      APPLICATION_ID,
      BOT_ID,
      request(),
    ),
    /protected/,
  )
  await assert.rejects(
    fixture().service.plan(APPLICATION_ID, BOT_ID, request({ userId: BOT_ID })),
    /connector bot/,
  )
  await assert.rejects(
    fixture({ state: { ownerId: USER_ID } }).service.plan(
      APPLICATION_ID,
      BOT_ID,
      request(),
    ),
    /guild owner/,
  )
  const otherBot = fixture({ state: {
    targetMember: {
      roles: [],
      user: { bot: true, id: USER_ID, username: "other-connector" },
    },
  } })
  assert.equal(
    (await otherBot.service.plan(APPLICATION_ID, BOT_ID, request())).status,
    "planned",
  )
  await assert.rejects(
    fixture({ state: {
      targetMember: {
        pending: true,
        roles: [],
        user: { id: USER_ID, username: "target-user" },
      },
    } }).service.plan(APPLICATION_ID, BOT_ID, request()),
    /pending membership-screening/,
  )
  await assert.rejects(
    fixture({ state: {
      targetMember: {
        communication_disabled_until: "2026-08-21T01:00:00.000Z",
        roles: [],
        user: { id: USER_ID, username: "target-user" },
      },
    } }).service.plan(APPLICATION_ID, BOT_ID, request()),
    /actively timed-out/,
  )

  const noManage = fixture()
  const botRole = noManage.state.roles.find(({ id }) => id === BOT_ROLE_ID) as DiscordRole
  botRole.permissions = DISCORD_PERMISSIONS.VIEW_CHANNEL.toString()
  await assert.rejects(
    noManage.service.plan(APPLICATION_ID, BOT_ID, request()),
    /lacks guild-level MANAGE_ROLES/,
  )

  const roleAbove = fixture()
  const selected = roleAbove.state.roles.find(({ id }) => id === ROLE_ID) as DiscordRole
  selected.position = 10
  await assert.rejects(
    roleAbove.service.plan(APPLICATION_ID, BOT_ID, request()),
    /strictly below/,
  )

  const targetAbove = fixture({ state: {
    roles: [
      role(GUILD_ID, "@everyone", DISCORD_PERMISSIONS.VIEW_CHANNEL, 0),
      role(ROLE_ID, "Support", DISCORD_PERMISSIONS.VIEW_CHANNEL, 2),
      role("650000000000000001", "Target high role", 0n, 10),
      role(
        BOT_ROLE_ID,
        "connector",
        DISCORD_PERMISSIONS.MANAGE_ROLES | DISCORD_PERMISSIONS.VIEW_CHANNEL,
        10,
        { managed: true, tags: { bot_id: BOT_ID } },
      ),
    ],
    targetMember: {
      roles: ["650000000000000001"],
      user: { id: USER_ID, username: "target-user" },
    },
  } })
  await assert.rejects(
    targetAbove.service.plan(APPLICATION_ID, BOT_ID, request()),
    /target member must be strictly below/,
  )

  const managed = fixture()
  const managedRole = managed.state.roles.find(({ id }) => id === ROLE_ID) as DiscordRole
  managedRole.managed = true
  managedRole.tags = { bot_id: "650000000000000001" }
  await assert.rejects(
    managed.service.plan(APPLICATION_ID, BOT_ID, request()),
    /standard non-managed role/,
  )

  const everyone = fixture({
    policy: policy({ roleIds: [GUILD_ID] }),
  })
  await assert.rejects(
    everyone.service.plan(
      APPLICATION_ID,
      BOT_ID,
      request({ roleId: GUILD_ID }),
    ),
    /standard non-managed role/,
  )

  const ambiguous = fixture()
  ambiguous.state.roles.push(role(
    "650000000000000001",
    "tie",
    0n,
    10,
  ))
  ambiguous.state.botMember.roles.push("650000000000000001")
  await assert.rejects(
    ambiguous.service.plan(APPLICATION_ID, BOT_ID, request()),
    /highest-role evidence is ambiguous/,
  )
})

test("member-role changes proceed with explicit partial channel impact", async () => {
  for (const type of [20, 99]) {
    for (const action of ["add", "remove"] as const) {
      const opaque = channel(OPAQUE_CHANNEL_ID, { position: 1, type })
      delete opaque.name
      delete opaque.permission_overwrites
      const setup = fixture({ state: { channels: [channel(), opaque] } })
      setup.state.targetMember.roles = action === "remove" ? [ROLE_ID] : []
      const input = request({ action })
      const plan = await setup.service.plan(APPLICATION_ID, BOT_ID, input)
      assert.equal(plan.impact.coverage.status, "partial")
      assert.equal(plan.impact.evaluatedChannels, 1)
      assert.equal(plan.impact.coverage.totalChannelCount, 2)
      assert.deepEqual(plan.impact.coverage.unsupportedChannels, [{
        channelId: OPAQUE_CHANNEL_ID, parentChannelId: null, position: 1, type,
      }])
      assert.equal(plan.permission.channelPermissionEscalationSubset, null)
      const result = await setup.service.execute(APPLICATION_ID, BOT_ID, input, plan.digest)
      assert.equal(result.status, "completed")
      assert.equal(setup.events.filter((event) => event === `write:${action}`).length, 1)
    }
  }
})

test("member-role partial coverage is bound into single and bulk reviewed evidence", async () => {
  const opaque = channel(OPAQUE_CHANNEL_ID, { position: 1, type: 20 })
  const secondUserId = "500000000000000002"
  const setup = fixture({
    policy: policy({ batchEnabled: true }),
    state: {
      channels: [channel(), opaque],
      targetMembers: { [secondUserId]: { roles: [], user: { id: secondUserId, username: "second" } } },
    },
  })
  const batch = await setup.service.planBatchForBulk(
    BULK_MEMBER_ROLE_AUTHORITY, APPLICATION_ID, BOT_ID,
    [request(), request({ operationKey: "member-role-operation-0002", userId: secondUserId })],
  )
  assert.equal(batch.plans[0]?.impact.coverage.status, "partial")
  const plan = await setup.service.plan(APPLICATION_ID, BOT_ID, request())
  for (const change of [
    { type: 99 },
    { position: 2 },
    { id: "700000000000000003" },
  ]) {
    setup.state.channels = [channel(), { ...opaque, ...change }]
    const changed = await setup.service.plan(APPLICATION_ID, BOT_ID, request())
    assert.notEqual(changed.digest, plan.digest)
    assert.notEqual(changed.commonEvidenceDigest, plan.commonEvidenceDigest)
    await assert.rejects(
      setup.service.execute(APPLICATION_ID, BOT_ID, request(), plan.digest),
      MemberRolePlanChangedError,
    )
  }
  assert.equal(setup.events.some((event) => event.startsWith("write:")), false)
  setup.state.channels = [channel(), opaque]
  const bulkResult = await setup.service.executeForBulk(
    BULK_MEMBER_ROLE_AUTHORITY, APPLICATION_ID, BOT_ID, request(), batch.plans[0]!.digest,
  )
  assert.equal(bulkResult.status, "completed")
})

test("member-role partial coverage does not bypass known-channel escalation checks", async () => {
  const setup = fixture({ state: { channels: [
    channel(CHANNEL_ID, { permission_overwrites: [{
      id: ROLE_ID, type: 0, allow: DISCORD_PERMISSIONS.MANAGE_MESSAGES.toString(), deny: "0",
    }] }),
    channel(OPAQUE_CHANNEL_ID, { position: 1, type: 20 }),
  ] } })
  await assert.rejects(
    setup.service.plan(APPLICATION_ID, BOT_ID, request()),
    /cannot grant channel permission MANAGE_MESSAGES/,
  )
  assert.equal(setup.events.some((event) => event.startsWith("write:")), false)
})

test("member-role changes tolerate hidden opaque metadata without using it", async () => {
  const secondUserId = "500000000000000002"
  const setup = fixture({ policy: policy({ batchEnabled: true }), state: {
    channels: [channel(), channel(OPAQUE_CHANNEL_ID, { name: "hidden-opaque-secret", position: 1, type: 20 })],
    obfuscatedChannelIds: new Set([OPAQUE_CHANNEL_ID]),
    targetMembers: { [secondUserId]: { roles: [], user: { id: secondUserId, username: "second" } } },
  } })
  const batch = await setup.service.planBatchForBulk(
    BULK_MEMBER_ROLE_AUTHORITY, APPLICATION_ID, BOT_ID,
    [request(), request({ userId: secondUserId, operationKey: "member-role-hidden-operation-0002" })],
  )
  assert.equal(batch.plans[0]?.impact.coverage.totalChannelCount, 2)
  assert.equal(batch.plans[0]?.commonEvidenceDigest, batch.baselineCommonEvidenceDigest)
  const plan = await setup.service.plan(APPLICATION_ID, BOT_ID, request())
  assert.equal(plan.impact.coverage.status, "partial")
  assert.equal(plan.impact.coverage.totalChannelCount, 2)
  assert.equal(plan.impact.coverage.unsupportedChannels[0]?.channelId, OPAQUE_CHANNEL_ID)
  assert.equal(plan.channelEvidence.obfuscatedChannelCount, 1)
  assert.doesNotMatch(JSON.stringify(plan), /hidden-opaque-secret/)
  const result = await setup.service.execute(APPLICATION_ID, BOT_ID, request(), plan.digest)
  assert.equal(result.status, "completed")
})

test("member-role planning fails closed on malformed or excessive impact evidence", async () => {
  const malformedChannel = channel()
  delete malformedChannel.permission_overwrites
  const malformed = fixture({ state: {
    channels: [malformedChannel],
  } })
  await assert.rejects(
    malformed.service.plan(APPLICATION_ID, BOT_ID, request()),
    /complete bounded channel overwrite evidence/,
  )

  const incompleteOverwrite = fixture({ state: {
    channels: [channel(CHANNEL_ID, { permission_overwrites: [{
      allow: "0",
      id: ROLE_ID,
      type: 0,
    }] })],
  } })
  await assert.rejects(
    incompleteOverwrite.service.plan(APPLICATION_ID, BOT_ID, request()),
    /invalid member-role channel overwrite evidence/,
  )

  const unresolvedOverwrite = fixture({ state: {
    channels: [channel(CHANNEL_ID, { permission_overwrites: [{
      allow: "0",
      deny: "0",
      id: "650000000000000001",
      type: 0,
    }] })],
  } })
  await assert.rejects(
    unresolvedOverwrite.service.plan(APPLICATION_ID, BOT_ID, request()),
    /unresolved member-role channel role overwrite/,
  )

  const unresolvedParent = fixture({ state: {
    channels: [channel(CHANNEL_ID, { parent_id: "750000000000000001" })],
  } })
  await assert.rejects(
    unresolvedParent.service.plan(APPLICATION_ID, BOT_ID, request()),
    /incomplete channel parent topology|unresolved member-role channel parent/,
  )

  const explicitEveryone = fixture({ state: {
    targetMember: {
      roles: [GUILD_ID],
      user: { id: USER_ID, username: "target-user" },
    },
  } })
  await assert.rejects(
    explicitEveryone.service.plan(APPLICATION_ID, BOT_ID, request()),
    /incomplete or mismatched target member evidence/,
  )

  const invalidRoleId = fixture()
  invalidRoleId.state.roles.push(role("0", "invalid", 0n, 1))
  await assert.rejects(
    invalidRoleId.service.plan(APPLICATION_ID, BOT_ID, request()),
    /invalid role snowflake/,
  )

  const invalidSelectedPosition = fixture()
  const selectedRole = invalidSelectedPosition.state.roles.find(
    ({ id }) => id === ROLE_ID,
  ) as DiscordRole
  selectedRole.position = 0
  await assert.rejects(
    invalidSelectedPosition.service.plan(APPLICATION_ID, BOT_ID, request()),
    /standard non-managed role/,
  )

  const excessiveChannels = Array.from(
    { length: CONNECTOR_LIMITS.memberRoleImpactChannels + 1 },
    (_, index) => channel((BigInt(CHANNEL_ID) + BigInt(index)).toString()),
  )
  const excessive = fixture({ state: { channels: excessiveChannels } })
  await assert.rejects(
    excessive.service.plan(APPLICATION_ID, BOT_ID, request()),
    /affects more than/,
  )
})

test("member-role additions and removals require complete channel metadata", async () => {
  for (const action of ["add", "remove"] as const) {
    const target = fixture({
      state: {
        obfuscatedChannelIds: new Set([CHANNEL_ID]),
        targetMember: {
          roles: action === "remove" ? [ROLE_ID] : [],
          user: { id: USER_ID, username: "target-user" },
        },
      },
    })
    await assert.rejects(
      target.service.plan(APPLICATION_ID, BOT_ID, request({ action })),
      /require complete metadata for every direct guild channel/,
    )
    assert.equal(target.events.some((event) => event.startsWith("write:")), false)
  }
})

test("member-role execution refuses changed plans, application drift, and spent keys", async () => {
  const changed = fixture()
  const plan = await changed.service.plan(APPLICATION_ID, BOT_ID, request())
  changed.state.guildName = "Changed Guild"
  await assert.rejects(
    changed.service.execute(APPLICATION_ID, BOT_ID, request(), plan.digest),
    MemberRolePlanChangedError,
  )
  assert.equal(changed.events.some((entry) => entry.startsWith("write:")), false)

  const identity = fixture()
  const identityPlan = await identity.service.plan(APPLICATION_ID, BOT_ID, request())
  await assert.rejects(
    identity.service.execute(
      "150000000000000002",
      BOT_ID,
      request(),
      identityPlan.digest,
    ),
    MemberRolePlanChangedError,
  )

  const spent = fixture()
  const spentPlan = await spent.service.plan(APPLICATION_ID, BOT_ID, request())
  spent.operationStore.receipt = {
    activityId: "prior-activity",
    error: null,
    guildId: GUILD_ID,
    kind: "member-role-change",
    operationKeyHash: spentPlan.operationKeyHash,
    planDigest: spentPlan.digest,
    resourceId: ROLE_ID,
    schemaVersion: 1,
    status: "completed",
    timestamp: NOW,
    verification: "match",
  }
  await assert.rejects(
    spent.service.plan(APPLICATION_ID, BOT_ID, request()),
    MemberRoleOperationConflictError,
  )
})

test("member-role execution serializes same-member writes and blocks queued work after uncertainty", async () => {
  let releaseMutation: () => void = () => undefined
  const mutationGate = new Promise<void>((resolve) => {
    releaseMutation = resolve
  })
  let mutationStarted: () => void = () => undefined
  const started = new Promise<void>((resolve) => {
    mutationStarted = resolve
  })
  const target = fixture({ state: { mutationGate, mutationStarted } })
  const firstPlan = await target.service.plan(APPLICATION_ID, BOT_ID, request())
  const sibling = siblingService(target, new MemoryOperationStore(target.events))
  const secondRequest = request({ operationKey: "member-role-operation-0002" })
  const secondPlan = await sibling.plan(APPLICATION_ID, BOT_ID, secondRequest)
  const first = target.service.execute(
    APPLICATION_ID,
    BOT_ID,
    request(),
    firstPlan.digest,
  )
  await started
  const second = sibling.execute(
    APPLICATION_ID,
    BOT_ID,
    secondRequest,
    secondPlan.digest,
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(target.events.filter((entry) => entry === "write:add").length, 1)
  releaseMutation()
  assert.equal((await first).status, "completed")
  await assert.rejects(second, MemberRolePlanChangedError)

  const uncertain = fixture({ state: {
    mutationError: new Error("network disconnected"),
  } })
  const uncertainPlan = await uncertain.service.plan(APPLICATION_ID, BOT_ID, request())
  const uncertainSibling = siblingService(
    uncertain,
    new MemoryOperationStore(uncertain.events),
  )
  const queuedRequest = request({ operationKey: "member-role-operation-0003" })
  const queuedPlan = await uncertainSibling.plan(APPLICATION_ID, BOT_ID, queuedRequest)
  const uncertainFirst = uncertain.service.execute(
    APPLICATION_ID,
    BOT_ID,
    request(),
    uncertainPlan.digest,
  )
  const uncertainSecond = uncertainSibling.execute(
    APPLICATION_ID,
    BOT_ID,
    queuedRequest,
    queuedPlan.digest,
  )
  await assert.rejects(
    uncertainFirst,
    (error) => executionResult(error).status === "uncertain",
  )
  await assert.rejects(
    uncertainSecond,
    (error) => executionResult(error).status === "blocked-prior-uncertain",
  )
  assert.equal(uncertain.events.filter((entry) => entry === "write:add").length, 1)
})

test("member-role execution blocks on pending audit failure and classifies write outcomes", async () => {
  const auditFailure = fixture({ state: { activityFailureAt: 1 } })
  const auditPlan = await auditFailure.service.plan(APPLICATION_ID, BOT_ID, request())
  await assert.rejects(
    auditFailure.service.execute(
      APPLICATION_ID,
      BOT_ID,
      request(),
      auditPlan.digest,
    ),
    (error) => executionResult(error).status === "blocked-audit-failed",
  )
  assert.equal(auditFailure.events.includes("write:add"), false)

  const rejected = fixture({ state: {
    mutationError: new DiscordApiError({
      code: 50_013,
      message: "missing permissions",
      method: "PUT",
      route: `/guilds/${GUILD_ID}/members/${USER_ID}/roles/${ROLE_ID}`,
      status: 403,
    }),
  } })
  const rejectedPlan = await rejected.service.plan(APPLICATION_ID, BOT_ID, request())
  await assert.rejects(
    rejected.service.execute(
      APPLICATION_ID,
      BOT_ID,
      request(),
      rejectedPlan.digest,
    ),
    (error) => executionResult(error).status === "failed",
  )
  assert.equal(rejected.operationStore.receipt?.status, "failed")

  const readback = fixture({ state: { readbackError: new Error("connection reset") } })
  const readbackPlan = await readback.service.plan(APPLICATION_ID, BOT_ID, request())
  await assert.rejects(
    readback.service.execute(
      APPLICATION_ID,
      BOT_ID,
      request(),
      readbackPlan.digest,
    ),
    (error) => executionResult(error).status === "uncertain",
  )
  assert.equal(readback.operationStore.receipt?.status, "uncertain")
})

test("member-role execution reports verified drift without retry or rollback", async () => {
  const target = fixture({ state: { applyMutation: false } })
  const plan = await target.service.plan(APPLICATION_ID, BOT_ID, request())
  const result = await target.service.execute(
    APPLICATION_ID,
    BOT_ID,
    request(),
    plan.digest,
  )
  assert.equal(result.status, "completed-with-drift")
  assert.equal(result.rolePresent, false)
  assert.equal(result.roleSnapshotMatched, false)
  assert.equal(target.events.filter((entry) => entry === "write:add").length, 1)
  assert.equal(target.operationStore.receipt?.verification, "drift")
  assert.equal(target.activities.at(-1)?.status, "completed-with-drift")
})

test("member-role execution reports concurrent unrelated role drift", async () => {
  const unrelatedRoleId = "650000000000000001"
  const target = fixture({ state: {
    mutationStarted: () => {
      target.state.targetMember.roles = [unrelatedRoleId]
    },
    roles: [
      role(GUILD_ID, "@everyone", DISCORD_PERMISSIONS.VIEW_CHANNEL, 0),
      role(
        ROLE_ID,
        "Support",
        DISCORD_PERMISSIONS.VIEW_CHANNEL | DISCORD_PERMISSIONS.SEND_MESSAGES,
        2,
      ),
      role(unrelatedRoleId, "Concurrent", 0n, 3),
      role(
        BOT_ROLE_ID,
        "connector",
        DISCORD_PERMISSIONS.MANAGE_ROLES
          | DISCORD_PERMISSIONS.VIEW_CHANNEL
          | DISCORD_PERMISSIONS.SEND_MESSAGES,
        10,
        { managed: true, tags: { bot_id: BOT_ID } },
      ),
    ],
  } })
  const plan = await target.service.plan(APPLICATION_ID, BOT_ID, request())

  const result = await target.service.execute(
    APPLICATION_ID,
    BOT_ID,
    request(),
    plan.digest,
  )

  assert.equal(result.rolePresent, true)
  assert.equal(result.roleSnapshotMatched, false)
  assert.equal(result.status, "completed-with-drift")
  assert.deepEqual(result.observedRoleIds, [ROLE_ID, unrelatedRoleId])
})

test("member-role execution reports completed local receipt and activity failures", async () => {
  const receiptFailure = fixture()
  const receiptPlan = await receiptFailure.service.plan(APPLICATION_ID, BOT_ID, request())
  receiptFailure.operationStore.finishFailure = new Error("receipt unavailable")
  await assert.rejects(
    receiptFailure.service.execute(
      APPLICATION_ID,
      BOT_ID,
      request(),
      receiptPlan.digest,
    ),
    (error) => executionResult(error).status === "completed-operation-record-failed",
  )
  assert.equal(receiptFailure.events.filter((entry) => entry === "write:add").length, 1)
  assert.equal(receiptFailure.activities.at(-1)?.status, "completed")

  const activityFailure = fixture({ state: { activityFailureAt: 2 } })
  const activityPlan = await activityFailure.service.plan(APPLICATION_ID, BOT_ID, request())
  await assert.rejects(
    activityFailure.service.execute(
      APPLICATION_ID,
      BOT_ID,
      request(),
      activityPlan.digest,
    ),
    (error) => executionResult(error).status === "completed-audit-failed",
  )
  assert.equal(activityFailure.events.filter((entry) => entry === "write:add").length, 1)
  assert.equal(activityFailure.operationStore.receipt?.status, "completed")
})
