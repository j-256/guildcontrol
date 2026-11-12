import assert from "node:assert/strict"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import type { ActivityEntry, ActivityStore } from "../src/activity-log.js"
import {
  DISCORD_CHANNEL_TYPES,
  INVITE_REFERENCE_PATTERN,
  SCHEMA_VERSION,
} from "../src/constants.js"
import type {
  CreateChannelInviteInput,
  DiscordInviteIdentitySummary,
  DiscordInviteSummary,
  DiscordInviteTargetUsersJobStatus,
} from "../src/discord-client.js"
import {
  DiscordApiError,
  InviteCreationExecutionError,
  InviteCreationOperationConflictError,
  InviteCreationPlanChangedError,
  InviteEvidenceError,
} from "../src/errors.js"
import {
  InviteService,
  normalizeInviteCreationRequest,
  type InviteCreationRequest,
  type InviteServiceOptions,
} from "../src/invite-service.js"
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

const APPLICATION_ID = "100000000000000001"
const GUILD_ID = "200000000000000001"
const BOT_ID = "300000000000000001"
const OWNER_ID = "300000000000000002"
const BOT_ROLE_ID = "400000000000000001"
const GRANTED_ROLE_ID = "400000000000000002"
const OTHER_GRANTED_ROLE_ID = "400000000000000003"
const CHANNEL_ID = "500000000000000001"
const PRIVATE_CODE = "private-created-invite"
const AUDIT_REASON = "Reviewed temporary access / case 17"
const OPERATION_KEY = "invite-creation-operation-0001"
const CREATED_AT = "2026-08-24T00:00:00.000Z"
const EXPIRES_AT = "2026-08-24T01:00:00.000Z"

class MemoryOperationStore implements OperationStore {
  finishFailure: unknown
  readonly events: string[]
  readonly receipts = new Map<string, OperationReceipt>()

  constructor(events: string[]) {
    this.events = events
  }

  async finish(receipt: OperationReceipt): Promise<void> {
    this.events.push(`operation:${receipt.status}`)
    if (this.finishFailure) throw this.finishFailure
    this.receipts.set(`${receipt.kind}:${receipt.operationKeyHash}`, receipt)
  }

  async get(kind: OperationReceipt["kind"], hash: string) {
    return this.receipts.get(`${kind}:${hash}`)
  }

  async reserve(receipt: OperationReceipt): Promise<OperationReservation> {
    this.events.push("operation:reserve")
    const key = `${receipt.kind}:${receipt.operationKeyHash}`
    const existing = this.receipts.get(key)
    if (existing) return { created: false, receipt: existing }
    this.receipts.set(key, receipt)
    return { created: true, receipt }
  }
}

interface FixtureState {
  activityFailureAt: number | null
  allowInviteRoleAssignment: boolean
  channel: DiscordChannel
  channelInventory: DiscordChannel[] | null
  createError: unknown
  created: DiscordInviteSummary
  inventoryVerification: DiscordInviteSummary[]
  inventoryVerificationError: unknown
  inviteRoleIds: string[]
  layoutComplete: boolean
  layoutObfuscated: boolean
  obfuscatedChannelIds: Set<string>
  layoutState: "ready" | "invalidated"
  member: DiscordGuildMember
  provideLayoutSource: boolean
  roles: DiscordRole[]
  targetUserIds: string[]
  targetUserJobStatuses: DiscordInviteTargetUsersJobStatus[]
  targetUserVerificationError: unknown
  verification: DiscordInviteIdentitySummary
  verificationError: unknown
}

function role(id: string, permissions: bigint, position: number): DiscordRole {
  return {
    id,
    managed: false,
    name: id === GUILD_ID ? "@everyone" : "connector-role",
    permissions: permissions.toString(),
    position,
  }
}

function channel(): DiscordChannel {
  return {
    guild_id: GUILD_ID,
    id: CHANNEL_ID,
    name: "private-invite-channel",
    permission_overwrites: [],
    position: 0,
    type: DISCORD_CHANNEL_TYPES.text,
  }
}

function createdInvite(overrides: Partial<DiscordInviteSummary> = {}): DiscordInviteSummary {
  return {
    channelId: CHANNEL_ID,
    code: PRIVATE_CODE,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    flags: 0,
    guildId: GUILD_ID,
    inviterUserId: BOT_ID,
    maxAge: 3_600,
    maxUses: 1,
    roleIds: [],
    targetApplicationId: null,
    targetType: null,
    targetUserId: null,
    temporary: false,
    type: 0,
    uses: 0,
    ...overrides,
  }
}

function roleGrantState(
  overrides: Partial<FixtureState> = {},
): Partial<FixtureState> {
  const grantedPermissions = DISCORD_PERMISSIONS.VIEW_CHANNEL
    | DISCORD_PERMISSIONS.SEND_MESSAGES
  return {
    allowInviteRoleAssignment: true,
    created: createdInvite({ roleIds: [GRANTED_ROLE_ID] }),
    inventoryVerification: [createdInvite({ roleIds: [GRANTED_ROLE_ID] })],
    inviteRoleIds: [GRANTED_ROLE_ID],
    provideLayoutSource: true,
    roles: [
      role(GUILD_ID, 0n, 0),
      role(
        BOT_ROLE_ID,
        grantedPermissions
          | DISCORD_PERMISSIONS.CREATE_INSTANT_INVITE
          | DISCORD_PERMISSIONS.MANAGE_ROLES,
        10,
      ),
      role(GRANTED_ROLE_ID, grantedPermissions, 5),
    ],
    verification: {
      channelId: CHANNEL_ID,
      code: PRIVATE_CODE,
      guildId: GUILD_ID,
      roleIds: [GRANTED_ROLE_ID],
      type: 0,
    },
    ...overrides,
  }
}

async function fixture(
  context: test.TestContext,
  overrides: Partial<FixtureState> = {},
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "guildcontrol-invite-creation-")),
  )
  const root = join(parent, "capabilities")
  await mkdir(root, { mode: 0o700 })
  await chmod(root, 0o700)
  context.after(async () => rm(parent, { force: true, recursive: true }))
  const outputFile = join(root, "invite.json")
  const state: FixtureState = {
    activityFailureAt: null,
    allowInviteRoleAssignment: false,
    channel: channel(),
    channelInventory: null,
    createError: undefined,
    created: createdInvite(),
    inventoryVerification: [createdInvite()],
    inventoryVerificationError: undefined,
    inviteRoleIds: [],
    layoutComplete: true,
    layoutObfuscated: false,
    obfuscatedChannelIds: new Set(),
    layoutState: "ready",
    member: {
      roles: [BOT_ROLE_ID],
      user: { bot: true, id: BOT_ID, username: "connector" },
    },
    roles: [
      role(GUILD_ID, 0n, 0),
      role(
        BOT_ROLE_ID,
        DISCORD_PERMISSIONS.VIEW_CHANNEL
          | DISCORD_PERMISSIONS.CREATE_INSTANT_INVITE,
        10,
      ),
    ],
    provideLayoutSource: false,
    targetUserIds: ["600000000000000001", "600000000000000002"],
    targetUserJobStatuses: [{
      completedAt: "2026-08-24T00:00:01.000Z",
      createdAt: CREATED_AT,
      errorPresent: false,
      processedUsers: 2,
      status: 2,
      totalUsers: 2,
      unknownFieldCount: 0,
    }],
    targetUserVerificationError: undefined,
    verification: {
      channelId: CHANNEL_ID,
      code: PRIVATE_CODE,
      guildId: GUILD_ID,
      roleIds: [],
      type: 0,
    },
    verificationError: undefined,
    ...overrides,
  }
  const activities: ActivityEntry[] = []
  const events: string[] = []
  const operationStore = new MemoryOperationStore(events)
  const createInputs: CreateChannelInviteInput[] = []
  let activityCalls = 0
  const activityStore: ActivityStore = {
    async append(entry) {
      activityCalls += 1
      events.push(`activity:${entry.status}`)
      if (state.activityFailureAt === activityCalls) throw new Error("activity unavailable")
      activities.push(entry)
    },
    async list() {
      return { entries: activities, file: "/memory/activity.jsonl", skippedLines: 0 }
    },
  }
  const policy = new ScopePolicy({
    adminGuildIds: new Set(),
    allowedChannelIds: new Set([CHANNEL_ID]),
    allowedGuildIds: new Set([GUILD_ID]),
    allowAdministration: false,
    allowDeletions: false,
    allowInteractions: false,
    allowInviteCreation: true,
    allowInviteRoleAssignment: state.allowInviteRoleAssignment,
    deleteChannelIds: new Set(),
    interactionChannelIds: new Set(),
    interactionMaxWritesPerMinute: 10,
    interactionMinWriteIntervalMs: 0,
    inviteCapabilityRoots: [root],
    inviteCreationChannelIds: new Set([CHANNEL_ID]),
    inviteRoleIds: new Set(state.inviteRoleIds),
    mentionUserIds: new Set(),
    protectedUserIds: new Set(),
  })
  const client: InviteServiceOptions["client"] = {
    async createChannelInvite(
      channelId: string,
      input: CreateChannelInviteInput,
      auditReason: string,
    ) {
      createInputs.push({
        ...input,
        roleIds: [...input.roleIds],
        targetUserIds: input.targetUserIds === null ? null : [...input.targetUserIds],
      })
      events.push(
        `write:create:${channelId}:${input.maxAgeSeconds}:${input.targetUserIds?.join(",") ?? "bearer"}:${auditReason}`,
      )
      if (state.createError) throw state.createError
      return state.created
    },
    async deleteInvite() {
      throw new Error("Unexpected invite deletion")
    },
    async getGuild() {
      events.push("read:guild")
      return { id: GUILD_ID, name: "Private Guild", owner_id: OWNER_ID }
    },
    async getGuildChannels() {
      events.push("read:channels")
      return state.channelInventory ?? [state.channel]
    },
    async getGuildMember() {
      events.push("read:member")
      return state.member
    },
    async getGuildRoles() {
      events.push("read:roles")
      return state.roles
    },
    async getGuildVanityUrl() {
      throw new Error("Unexpected guild vanity URL lookup")
    },
    async getInvite(code: string) {
      events.push("read:verify")
      assert.equal(code, PRIVATE_CODE)
      if (state.verificationError) throw state.verificationError
      return state.verification
    },
    async getInviteTargetUserIds(code: string) {
      events.push("read:target-users")
      assert.equal(code, PRIVATE_CODE)
      if (state.targetUserVerificationError) throw state.targetUserVerificationError
      return state.targetUserIds
    },
    async getInviteTargetUsersJobStatus(code: string) {
      events.push("read:target-user-job")
      assert.equal(code, PRIVATE_CODE)
      const index = events.filter((event) => event === "read:target-user-job").length - 1
      return state.targetUserJobStatuses[
        Math.min(index, state.targetUserJobStatuses.length - 1)
      ]!
    },
    async listGuildInvites() {
      events.push("read:inventory-verify")
      if (state.inventoryVerificationError) throw state.inventoryVerificationError
      return state.inventoryVerification
    },
  }
  const layoutSource: GatewayChannelLayoutSource = {
    layoutEnabled: true,
    getChannelLayout(guildId) {
      return {
        channels: (state.channelInventory ?? [state.channel]).map((channel) => ({
          channelId: channel.id,
          obfuscated: state.layoutObfuscated || state.obfuscatedChannelIds.has(channel.id),
          parentChannelId: channel.parent_id ?? null,
          position: channel.position ?? 0,
          type: channel.type,
        })),
        complete: state.layoutComplete,
        guildId,
        reason: state.layoutState === "ready" ? null : "connection-gap",
        revision: 1,
        schemaVersion: SCHEMA_VERSION,
        state: state.layoutState,
        updatedAt: CREATED_AT,
      }
    },
    getChannelLayoutStatus() {
      return {
        channels: {
          obfuscated: state.layoutObfuscated ? (state.channelInventory?.length ?? 1) : 0,
          retained: state.channelInventory?.length ?? 1,
        },
        enabled: true,
        guilds: {
          invalidated: state.layoutState === "invalidated" ? 1 : 0,
          pending: 0,
          ready: state.layoutState === "ready" ? 1 : 0,
          resuming: 0,
          scoped: 1,
          unavailable: 0,
        },
        invalidations: state.layoutState === "invalidated" ? 1 : 0,
        schemaVersion: SCHEMA_VERSION,
        updates: 1,
      }
    },
    subscribeChannelLayouts(_listener: GatewayChannelLayoutListener) {
      return () => undefined
    },
  }
  const service = new InviteService({
    activityStore,
    capabilityRoots: [root],
    client,
    clock: () => new Date(CREATED_AT),
    ...(state.provideLayoutSource ? { layoutSource } : {}),
    operationStore,
    planKey: new Uint8Array(32).fill(17),
    policy,
    randomId: () => "activity-creation-0001",
    sleep: async () => {
      events.push("sleep:target-user-job")
    },
  })
  return {
    activities,
    createInputs,
    events,
    operationStore,
    outputFile,
    root,
    service,
    state,
  }
}

function request(
  outputFile: string,
  overrides: Partial<InviteCreationRequest> = {},
): InviteCreationRequest {
  return {
    acceptance: { kind: "bearer" } as const,
    acknowledgeBearerCapability: true as const,
    auditReason: AUDIT_REASON,
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    maxAgeSeconds: 3_600,
    maxUses: 1,
    operationKey: OPERATION_KEY,
    outputFile,
    roleAssignment: { kind: "none" },
    temporaryMembership: false,
    ...overrides,
  }
}

function apiError(status: number): DiscordApiError {
  return new DiscordApiError({
    message: "Discord rejected invite creation",
    method: "POST",
    route: "/channels/{channel.id}/invites",
    status,
  })
}

test("invite creation plans and delivers one finite capability only through a private file", async (context) => {
  const { activities, events, operationStore, outputFile, service } = await fixture(context)
  const input = request(outputFile)

  const plan = await service.planCreation(APPLICATION_ID, BOT_ID, input)
  const result = await service.executeCreation(
    APPLICATION_ID,
    BOT_ID,
    input,
    plan.digest,
  )

  assert.equal(plan.access.createInstantInvite, true)
  assert.equal(plan.access.manageGuild, false)
  assert.equal(plan.access.viewChannel, true)
  assert.equal(plan.access.complete, true)
  assert.deepEqual(plan.access.requiredPermissions, [
    "CREATE_INSTANT_INVITE",
    "VIEW_CHANNEL",
  ])
  assert.equal(plan.delivery.format, "discord-invite-capability.v3")
  assert.equal(plan.delivery.outputFile, outputFile)
  assert.equal(plan.delivery.review.fileMode, "0600")
  assert.deepEqual(plan.intent, {
    acceptance: { kind: "bearer" },
    maxAgeSeconds: 3_600,
    maxUses: 1,
    roleAssignment: { kind: "none" },
    temporaryMembership: false,
    unique: true,
  })
  assert.equal(result.capabilityFileWritten, true)
  assert.equal(result.verified, true)
  assert.match(result.inviteRef, INVITE_REFERENCE_PATTERN)
  assert.equal(JSON.stringify(result).includes(PRIVATE_CODE), false)
  const capability = JSON.parse(await readFile(outputFile, "utf8")) as Record<string, unknown>
  assert.deepEqual(capability, {
    acceptance: { kind: "bearer", targetUserCount: 0 },
    channelId: CHANNEL_ID,
    code: PRIVATE_CODE,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    guildId: GUILD_ID,
    kind: "discord-invite-capability",
    maxAgeSeconds: 3_600,
    maxUses: 1,
    roleAssignment: { kind: "none", roleCount: 0 },
    schemaVersion: 3,
    temporaryMembership: false,
    url: `https://discord.gg/${PRIVATE_CODE}`,
  })
  assert.equal((await lstat(outputFile)).mode & 0o777, 0o600)
  assert.deepEqual(activities.map((entry) => entry.status), ["pending", "completed"])
  assert.doesNotMatch(JSON.stringify(activities), /private-created-invite|invite\.json|Reviewed/)
  assert.doesNotMatch(JSON.stringify([...operationStore.receipts.values()]), /private-created-invite|invite\.json|Reviewed/)
  assert.deepEqual(events.slice(-6), [
    "operation:reserve",
    "activity:pending",
    `write:create:${CHANNEL_ID}:3600:bearer:${AUDIT_REASON}`,
    "read:verify",
    "operation:completed",
    "activity:completed",
  ])
})

test("invite creation withholds exact-user capability until job and CSV verification", async (context) => {
  const setup = await fixture(context, {
    roles: [
      role(GUILD_ID, 0n, 0),
      role(
        BOT_ROLE_ID,
        DISCORD_PERMISSIONS.VIEW_CHANNEL
          | DISCORD_PERMISSIONS.CREATE_INSTANT_INVITE
          | DISCORD_PERMISSIONS.MANAGE_GUILD,
        10,
      ),
    ],
    targetUserJobStatuses: [
      {
        completedAt: null,
        createdAt: CREATED_AT,
        errorPresent: false,
        processedUsers: 0,
        status: 1,
        totalUsers: 2,
        unknownFieldCount: 0,
      },
      {
        completedAt: "2026-08-24T00:00:01.000Z",
        createdAt: CREATED_AT,
        errorPresent: false,
        processedUsers: 2,
        status: 2,
        totalUsers: 2,
        unknownFieldCount: 0,
      },
    ],
  })
  const input = request(setup.outputFile, {
    acceptance: {
      kind: "exact-users",
      userIds: ["600000000000000002", "600000000000000001"],
    },
  })

  const plan = await setup.service.planCreation(APPLICATION_ID, BOT_ID, input)
  const result = await setup.service.executeCreation(
    APPLICATION_ID,
    BOT_ID,
    input,
    plan.digest,
  )

  assert.deepEqual(plan.intent.acceptance, {
    kind: "exact-users",
    userIds: ["600000000000000001", "600000000000000002"],
  })
  assert.equal(plan.access.manageGuild, true)
  assert.deepEqual(plan.access.requiredPermissions, [
    "CREATE_INSTANT_INVITE",
    "MANAGE_GUILD",
    "VIEW_CHANNEL",
  ])
  assert.deepEqual(result.acceptance, {
    kind: "exact-users",
    targetUserCount: 2,
  })
  const capability = JSON.parse(
    await readFile(setup.outputFile, "utf8"),
  ) as Record<string, unknown>
  assert.deepEqual(capability.acceptance, {
    kind: "exact-users",
    targetUserCount: 2,
  })
  assert.doesNotMatch(
    JSON.stringify(capability),
    /600000000000000001|600000000000000002/,
  )
  assert.deepEqual(setup.events.slice(-10), [
    "operation:reserve",
    "activity:pending",
    `write:create:${CHANNEL_ID}:3600:600000000000000001,600000000000000002:${AUDIT_REASON}`,
    "read:inventory-verify",
    "read:target-user-job",
    "sleep:target-user-job",
    "read:target-user-job",
    "read:target-users",
    "operation:completed",
    "activity:completed",
  ])
  assert.doesNotMatch(
    JSON.stringify(setup.activities),
    /600000000000000001|600000000000000002/,
  )
})

test("invite creation reviews and privately delivers persistent role grants", async (context) => {
  const setup = await fixture(context, roleGrantState())
  const input = request(setup.outputFile, {
    roleAssignment: {
      acknowledgePersistentGrants: true,
      kind: "grant",
      roleIds: [GRANTED_ROLE_ID],
    },
  })

  const plan = await setup.service.planCreation(APPLICATION_ID, BOT_ID, input)
  const result = await setup.service.executeCreation(
    APPLICATION_ID,
    BOT_ID,
    input,
    plan.digest,
  )

  assert.equal(plan.access.manageRoles, true)
  assert.deepEqual(plan.access.requiredPermissions, [
    "CREATE_INSTANT_INVITE",
    "VIEW_CHANNEL",
    "MANAGE_ROLES",
  ])
  assert.equal(plan.roleAssignment.kind, "grant")
  if (plan.roleAssignment.kind !== "grant") throw new Error("Expected role grant review")
  assert.deepEqual(plan.roleAssignment.roleIds, [GRANTED_ROLE_ID])
  assert.equal(plan.roleAssignment.persistence, "manual-removal-required")
  assert.deepEqual(plan.roleAssignment.assignedRoles, [{
    highRiskPermissions: [],
    id: GRANTED_ROLE_ID,
    name: "connector-role",
    permissionNames: ["VIEW_CHANNEL", "SEND_MESSAGES"],
    permissions: (
      DISCORD_PERMISSIONS.VIEW_CHANNEL | DISCORD_PERMISSIONS.SEND_MESSAGES
    ).toString(),
    position: 5,
  }])
  assert.deepEqual(plan.roleAssignment.channelEvidence, {
    gatewayChannelCount: 1,
    httpChannelCount: 1,
    httpMode: "complete",
    layoutRevision: 1,
    layoutUpdatedAt: CREATED_AT,
    metadataCoverage: "complete",
    obfuscatedChannelCount: 0,
    trustedMetadataCount: 1,
  })
  assert.equal(plan.roleAssignment.impact.projection, "minimum-new-member")
  assert.deepEqual(plan.roleAssignment.impact.guildPermissions.added, [
    "VIEW_CHANNEL",
    "SEND_MESSAGES",
  ])
  assert.equal(plan.roleAssignment.impact.evaluatedChannels, 1)
  assert.equal(plan.roleAssignment.impact.changedChannels, 1)
  assert.match(plan.warnings.join(" "), /persist after the invite expires or is deleted/)
  assert.match(plan.warnings.join(" "), /point-in-time snapshot/)
  assert.deepEqual(setup.createInputs, [{
    maxAgeSeconds: 3_600,
    maxUses: 1,
    roleIds: [GRANTED_ROLE_ID],
    targetUserIds: null,
    temporaryMembership: false,
  }])
  assert.deepEqual(result.roleAssignment, {
    kind: "grant",
    roleCount: 1,
    roleIds: [GRANTED_ROLE_ID],
  })
  const capability = JSON.parse(
    await readFile(setup.outputFile, "utf8"),
  ) as Record<string, unknown>
  assert.deepEqual(capability.roleAssignment, {
    kind: "grant",
    roleCount: 1,
    roleIds: [GRANTED_ROLE_ID],
  })
  assert.match(String(capability.persistentRoleWarning), /remain after the invite expires/)
  assert.match(String(capability.persistentRoleWarning), /channel overwrites can change/)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(PRIVATE_CODE))
  assert.doesNotMatch(JSON.stringify(setup.activities), /connector-role|private-created-invite/)
})

test("invite creation normalizes exact finite acknowledged intent", () => {
  const valid = request("/private/invite.json")
  assert.match(normalizeInviteCreationRequest(valid).operationKeyHash, /^sha256:/)
  assert.deepEqual(normalizeInviteCreationRequest({
    ...valid,
    acceptance: {
      kind: "exact-users",
      userIds: ["600000000000000002", "600000000000000001"],
    },
  }).acceptance, {
    kind: "exact-users",
    userIds: ["600000000000000001", "600000000000000002"],
  })
  assert.deepEqual(normalizeInviteCreationRequest({
    ...valid,
    roleAssignment: {
      acknowledgePersistentGrants: true,
      kind: "grant",
      roleIds: [OTHER_GRANTED_ROLE_ID, GRANTED_ROLE_ID],
    },
  }).roleAssignment, {
    acknowledgePersistentGrants: true,
    kind: "grant",
    roleIds: [GRANTED_ROLE_ID, OTHER_GRANTED_ROLE_ID],
  })
  assert.throws(
    () => normalizeInviteCreationRequest({
      ...valid,
      acknowledgeBearerCapability: false,
    } as unknown as InviteCreationRequest),
    /acknowledgement/,
  )
  assert.throws(
    () => normalizeInviteCreationRequest({ ...valid, maxAgeSeconds: 0 }),
    /lifetime/,
  )
  assert.throws(
    () => normalizeInviteCreationRequest({ ...valid, maxUses: 0 }),
    /use limit/,
  )
  assert.throws(
    () => normalizeInviteCreationRequest({
      ...valid,
      extra: true,
    } as InviteCreationRequest),
    /exact object/,
  )
  assert.throws(
    () => normalizeInviteCreationRequest({
      ...valid,
      auditReason: "Share https://discord.gg/private",
    }),
    /must not contain an invite URL/,
  )
  for (const acceptance of [
    { kind: "exact-users", userIds: [] },
    { kind: "exact-users", userIds: ["600000000000000001", "600000000000000001"] },
    { kind: "exact-users", userIds: ["0"] },
    { kind: "exact-users", userIds: ["0600000000000000001"] },
    { kind: "bearer", userIds: ["600000000000000001"] },
  ]) {
    assert.throws(
      () => normalizeInviteCreationRequest({
        ...valid,
        acceptance,
      } as InviteCreationRequest),
      /acceptance|canonical|unique|snowflake/,
    )
  }
  for (const roleAssignment of [
    null,
    { extra: true, kind: "none" },
    {
      acknowledgePersistentGrants: false,
      kind: "grant",
      roleIds: [GRANTED_ROLE_ID],
    },
    {
      acknowledgePersistentGrants: true,
      kind: "grant",
      roleIds: [],
    },
    {
      acknowledgePersistentGrants: true,
      kind: "grant",
      roleIds: [GRANTED_ROLE_ID, GRANTED_ROLE_ID],
    },
    {
      acknowledgePersistentGrants: true,
      kind: "grant",
      roleIds: ["0"],
    },
    {
      acknowledgePersistentGrants: true,
      kind: "grant",
      roleIds: [`0${GRANTED_ROLE_ID}`],
    },
  ]) {
    assert.throws(
      () => normalizeInviteCreationRequest({
        ...valid,
        roleAssignment,
      } as unknown as InviteCreationRequest),
      /role assignment|role-assignment|canonical|unique|snowflake/,
    )
  }
  assert.throws(
    () => normalizeInviteCreationRequest({
      ...valid,
      roleAssignment: {
        acknowledgePersistentGrants: true,
        kind: "grant",
        roleIds: [GRANTED_ROLE_ID],
      },
      temporaryMembership: true,
    }),
    /cannot claim temporary membership/,
  )
})

test("invite role assignment fails closed on policy and Gateway evidence", async (context) => {
  for (const [overrides, expected] of [
    [roleGrantState({ allowInviteRoleAssignment: false }), /role assignment is disabled/],
    [roleGrantState({ inviteRoleIds: [OTHER_GRANTED_ROLE_ID] }), /outside the invite role-assignment scope/],
    [roleGrantState({ provideLayoutSource: false }), /requires Gateway channel-layout evidence/],
    [roleGrantState({ layoutComplete: false }), /channel evidence is incomplete/],
    [roleGrantState({ layoutState: "invalidated" }), /channel evidence is incomplete/],
    [roleGrantState({ layoutObfuscated: true }), /complete metadata for every direct guild channel/],
  ] as const) {
    const setup = await fixture(context, overrides)
    await assert.rejects(
      () => setup.service.planCreation(
        APPLICATION_ID,
        BOT_ID,
        request(setup.outputFile, {
          roleAssignment: {
            acknowledgePersistentGrants: true,
            kind: "grant",
            roleIds: [GRANTED_ROLE_ID],
          },
        }),
      ),
      expected,
    )
    assert.equal(setup.events.some((entry) => entry.startsWith("write:")), false)
  }
})

test("invite role assignment proceeds with explicit partial channel impact", async (context) => {
  for (const type of [20, 99]) {
    const opaqueChannel = { ...channel(), id: "500000000000000002", type }
    delete opaqueChannel.name
    delete opaqueChannel.permission_overwrites
    const setup = await fixture(context, roleGrantState({
      channelInventory: [channel(), opaqueChannel],
    }))
    const input = request(setup.outputFile, {
        roleAssignment: {
          acknowledgePersistentGrants: true,
          kind: "grant",
          roleIds: [GRANTED_ROLE_ID],
        },
    })
    const plan = await setup.service.planCreation(APPLICATION_ID, BOT_ID, input)
    assert.equal(plan.roleAssignment.kind, "grant")
    if (plan.roleAssignment.kind !== "grant") throw new Error("Expected grant")
    assert.equal(plan.roleAssignment.impact.coverage.status, "partial")
    assert.equal(plan.roleAssignment.impact.evaluatedChannels, 1)
    assert.deepEqual(plan.roleAssignment.impact.coverage.unsupportedChannels, [{
      channelId: opaqueChannel.id, parentChannelId: null, position: 0, type,
    }])
    const result = await setup.service.executeCreation(APPLICATION_ID, BOT_ID, input, plan.digest)
    assert.equal(result.status, "completed")
    assert.equal(setup.createInputs.length, 1)
  }
})

test("invite role grants tolerate hidden opaque metadata without using it", async (context) => {
  const opaque = { ...channel(), id: "500000000000000002", name: "hidden-opaque-secret", type: 20 }
  const setup = await fixture(context, roleGrantState({
    channelInventory: [channel(), opaque], obfuscatedChannelIds: new Set([opaque.id]),
  }))
  const input = request(setup.outputFile, {
    roleAssignment: { acknowledgePersistentGrants: true, kind: "grant", roleIds: [GRANTED_ROLE_ID] },
  })
  const plan = await setup.service.planCreation(APPLICATION_ID, BOT_ID, input)
  if (plan.roleAssignment.kind !== "grant") throw new Error("Expected grant")
  assert.equal(plan.roleAssignment.impact.coverage.status, "partial")
  assert.equal(plan.roleAssignment.impact.coverage.totalChannelCount, 2)
  assert.equal(plan.roleAssignment.channelEvidence.obfuscatedChannelCount, 1)
  assert.doesNotMatch(JSON.stringify(plan), /hidden-opaque-secret/)
  assert.equal((await setup.service.executeCreation(APPLICATION_ID, BOT_ID, input, plan.digest)).status, "completed")
})

test("invite role assignment rejects changed unsupported coverage before creating an invite", async (context) => {
  const opaque = { ...channel(), id: "500000000000000002", type: 20 }
  const setup = await fixture(context, roleGrantState({ channelInventory: [channel(), opaque] }))
  const input = request(setup.outputFile, {
    roleAssignment: { acknowledgePersistentGrants: true, kind: "grant", roleIds: [GRANTED_ROLE_ID] },
  })
  const plan = await setup.service.planCreation(APPLICATION_ID, BOT_ID, input)
  setup.state.channelInventory = [channel(), { ...opaque, type: 99 }]
  await assert.rejects(
    setup.service.executeCreation(APPLICATION_ID, BOT_ID, input, plan.digest),
    InviteCreationPlanChangedError,
  )
  assert.equal(setup.createInputs.length, 0)
})

test("invite role assignment enforces permission, hierarchy, and role evidence", async (context) => {
  const grantedPermissions = DISCORD_PERMISSIONS.VIEW_CHANNEL
    | DISCORD_PERMISSIONS.SEND_MESSAGES
  const botPermissions = grantedPermissions
    | DISCORD_PERMISSIONS.CREATE_INSTANT_INVITE
    | DISCORD_PERMISSIONS.MANAGE_ROLES
  const unknownPermission = 1n << 60n
  const cases: Array<[Partial<FixtureState>, RegExp]> = [
    [roleGrantState({
      roles: [
        role(GUILD_ID, 0n, 0),
        role(BOT_ROLE_ID, grantedPermissions | DISCORD_PERMISSIONS.CREATE_INSTANT_INVITE, 10),
        role(GRANTED_ROLE_ID, grantedPermissions, 5),
      ],
    }), /MANAGE_ROLES/],
    [roleGrantState({
      roles: [role(GUILD_ID, 0n, 0), role(BOT_ROLE_ID, botPermissions, 10)],
    }), /omitted selected role/],
    [roleGrantState({
      roles: [
        role(GUILD_ID, 0n, 0),
        role(BOT_ROLE_ID, botPermissions, 10),
        { ...role(GRANTED_ROLE_ID, grantedPermissions, 5), managed: true },
      ],
    }), /standard unmanaged roles/],
    [roleGrantState({
      roles: [
        role(GUILD_ID, 0n, 0),
        role(BOT_ROLE_ID, botPermissions, 10),
        role(GRANTED_ROLE_ID, grantedPermissions, 10),
      ],
    }), /strictly below/],
    [roleGrantState({
      roles: [
        role(GUILD_ID, 0n, 0),
        role(BOT_ROLE_ID, botPermissions, 10),
        role(GRANTED_ROLE_ID, DISCORD_PERMISSIONS.ADMINISTRATOR, 5),
      ],
    }), /never grants ADMINISTRATOR/],
    [roleGrantState({
      roles: [
        role(GUILD_ID, 0n, 0),
        role(BOT_ROLE_ID, botPermissions, 10),
        role(GRANTED_ROLE_ID, unknownPermission, 5),
      ],
    }), /permissions unknown to this build/],
    [roleGrantState({
      roles: [
        role(GUILD_ID, 0n, 0),
        role(BOT_ROLE_ID, botPermissions, 10),
        role(GRANTED_ROLE_ID, DISCORD_PERMISSIONS.KICK_MEMBERS, 5),
      ],
    }), /cannot grant invite role/],
    [roleGrantState({
      channel: {
        ...channel(),
        permission_overwrites: [{
          allow: unknownPermission.toString(),
          deny: "0",
          id: GRANTED_ROLE_ID,
          type: 0,
        }],
      },
    }), /unknown permissions|impact is incomplete/],
    [roleGrantState({
      channel: {
        ...channel(),
        permission_overwrites: [{
          allow: DISCORD_PERMISSIONS.MANAGE_MESSAGES.toString(),
          deny: "0",
          id: GRANTED_ROLE_ID,
          type: 0,
        }],
      },
      roles: [
        role(GUILD_ID, 0n, 0),
        role(
          BOT_ROLE_ID,
          DISCORD_PERMISSIONS.VIEW_CHANNEL
            | DISCORD_PERMISSIONS.CREATE_INSTANT_INVITE
            | DISCORD_PERMISSIONS.MANAGE_ROLES,
          10,
        ),
        role(GRANTED_ROLE_ID, 0n, 5),
      ],
    }), /cannot grant channel permission MANAGE_MESSAGES/],
  ]

  for (const [overrides, expected] of cases) {
    const setup = await fixture(context, overrides)
    await assert.rejects(
      () => setup.service.planCreation(
        APPLICATION_ID,
        BOT_ID,
        request(setup.outputFile, {
          roleAssignment: {
            acknowledgePersistentGrants: true,
            kind: "grant",
            roleIds: [GRANTED_ROLE_ID],
          },
        }),
      ),
      expected,
    )
    assert.equal(setup.events.some((entry) => entry.startsWith("write:")), false)
  }
})

test("invite role-assignment plans bind exact role and channel evidence", async (context) => {
  const setup = await fixture(context, roleGrantState())
  const input = request(setup.outputFile, {
    roleAssignment: {
      acknowledgePersistentGrants: true,
      kind: "grant",
      roleIds: [GRANTED_ROLE_ID],
    },
  })
  const first = await setup.service.planCreation(APPLICATION_ID, BOT_ID, input)
  const selectedRole = setup.state.roles.find(({ id }) => id === GRANTED_ROLE_ID)
  assert.ok(selectedRole)
  selectedRole.position = 4
  const changedRole = await setup.service.planCreation(APPLICATION_ID, BOT_ID, input)
  assert.notEqual(changedRole.digest, first.digest)

  setup.state.channel.permission_overwrites = [{
    allow: "0",
    deny: DISCORD_PERMISSIONS.SPEAK.toString(),
    id: GUILD_ID,
    type: 0,
  }]
  const changedChannel = await setup.service.planCreation(APPLICATION_ID, BOT_ID, input)
  assert.notEqual(changedChannel.digest, changedRole.digest)
})

test("invite creation rejects incomplete permissions and unsupported channels before mutation", async (context) => {
  const missingPermission = await fixture(context, {
    roles: [role(GUILD_ID, 0n, 0), role(BOT_ROLE_ID, DISCORD_PERMISSIONS.VIEW_CHANNEL, 10)],
  })
  await assert.rejects(
    () => missingPermission.service.planCreation(
      APPLICATION_ID,
      BOT_ID,
      request(missingPermission.outputFile),
    ),
    /CREATE_INSTANT_INVITE/,
  )
  assert.equal(missingPermission.events.some((entry) => entry.startsWith("write:")), false)

  const missingManageGuild = await fixture(context)
  await assert.rejects(
    () => missingManageGuild.service.planCreation(
      APPLICATION_ID,
      BOT_ID,
      request(missingManageGuild.outputFile, {
        acceptance: {
          kind: "exact-users",
          userIds: ["600000000000000001"],
        },
      }),
    ),
    /MANAGE_GUILD/,
  )
  assert.equal(
    missingManageGuild.events.some((entry) => entry.startsWith("write:")),
    false,
  )

  const category = await fixture(context, {
    channel: { ...channel(), type: DISCORD_CHANNEL_TYPES.category },
  })
  await assert.rejects(
    () => category.service.planCreation(
      APPLICATION_ID,
      BOT_ID,
      request(category.outputFile),
    ),
    InviteEvidenceError,
  )
  assert.equal(category.events.some((entry) => entry.startsWith("write:")), false)
})

test("invite creation applies exact channel overwrites to the connector bot", async (context) => {
  const denied = await fixture(context, {
    channel: {
      ...channel(),
      permission_overwrites: [{
        allow: "0",
        deny: DISCORD_PERMISSIONS.CREATE_INSTANT_INVITE.toString(),
        id: BOT_ID,
        type: 1,
      }],
    },
  })
  await assert.rejects(
    () => denied.service.planCreation(
      APPLICATION_ID,
      BOT_ID,
      request(denied.outputFile),
    ),
    /CREATE_INSTANT_INVITE/,
  )

  const allowed = await fixture(context, {
    channel: {
      ...channel(),
      permission_overwrites: [{
        allow: DISCORD_PERMISSIONS.CREATE_INSTANT_INVITE.toString(),
        deny: "0",
        id: BOT_ID,
        type: 1,
      }],
    },
    roles: [
      role(GUILD_ID, 0n, 0),
      role(BOT_ROLE_ID, DISCORD_PERMISSIONS.VIEW_CHANNEL, 10),
    ],
  })
  const plan = await allowed.service.planCreation(
    APPLICATION_ID,
    BOT_ID,
    request(allowed.outputFile),
  )
  assert.equal(plan.access.createInstantInvite, true)
  assert.equal(plan.access.viewChannel, true)
})

test("invite creation treats a rejected mutation as failed and removes its empty reservation", async (context) => {
  const first = await fixture(context, { createError: apiError(403) })
  const input = request(first.outputFile)
  const plan = await first.service.planCreation(APPLICATION_ID, BOT_ID, input)

  await assert.rejects(
    () => first.service.executeCreation(
      APPLICATION_ID,
      BOT_ID,
      input,
      plan.digest,
    ),
    (error: unknown) => {
      assert.ok(error instanceof InviteCreationExecutionError)
      assert.equal((error.result as { status: string }).status, "failed")
      assert.equal(JSON.stringify(error).includes(PRIVATE_CODE), false)
      return true
    },
  )
  await assert.rejects(() => lstat(first.outputFile), { code: "ENOENT" })
  assert.equal(first.activities.at(-1)?.status, "failed")
})

test("invite creation treats rate limits and server failures as uncertain without retry", async (context) => {
  for (const status of [429, 500]) {
    const setup = await fixture(context, { createError: apiError(status) })
    const input = request(setup.outputFile)
    const plan = await setup.service.planCreation(APPLICATION_ID, BOT_ID, input)

    await assert.rejects(
      () => setup.service.executeCreation(
        APPLICATION_ID,
        BOT_ID,
        input,
        plan.digest,
      ),
      (error: unknown) => {
        assert.ok(error instanceof InviteCreationExecutionError)
        assert.equal((error.result as { status: string }).status, "uncertain")
        return true
      },
    )
    assert.equal(
      setup.events.filter((entry) => entry.startsWith("write:create:")).length,
      1,
    )
    await assert.rejects(() => lstat(setup.outputFile), { code: "ENOENT" })
  }
})

test("invite creation blocks before local or Discord writes when pending activity fails", async (context) => {
  const setup = await fixture(context, { activityFailureAt: 1 })
  const input = request(setup.outputFile)
  const plan = await setup.service.planCreation(APPLICATION_ID, BOT_ID, input)

  await assert.rejects(
    () => setup.service.executeCreation(
      APPLICATION_ID,
      BOT_ID,
      input,
      plan.digest,
    ),
    (error: unknown) => {
      assert.ok(error instanceof InviteCreationExecutionError)
      assert.equal((error.result as { status: string }).status, "blocked-audit-failed")
      return true
    },
  )
  assert.equal(setup.events.some((entry) => entry.startsWith("write:create:")), false)
  await assert.rejects(() => lstat(setup.outputFile), { code: "ENOENT" })
  assert.equal(
    [...setup.operationStore.receipts.values()].at(-1)?.status,
    "failed",
  )
})

test("invite creation preserves verified capability evidence across terminal record failures", async (context) => {
  const receiptFailure = await fixture(context)
  const receiptInput = request(receiptFailure.outputFile)
  const receiptPlan = await receiptFailure.service.planCreation(
    APPLICATION_ID,
    BOT_ID,
    receiptInput,
  )
  receiptFailure.operationStore.finishFailure = new Error("receipt unavailable")
  await assert.rejects(
    () => receiptFailure.service.executeCreation(
      APPLICATION_ID,
      BOT_ID,
      receiptInput,
      receiptPlan.digest,
    ),
    (error: unknown) => {
      assert.ok(error instanceof InviteCreationExecutionError)
      assert.equal(
        (error.result as { status: string }).status,
        "completed-operation-record-failed",
      )
      assert.doesNotMatch(JSON.stringify(error), new RegExp(PRIVATE_CODE))
      return true
    },
  )
  assert.match(await readFile(receiptFailure.outputFile, "utf8"), new RegExp(PRIVATE_CODE))

  const activityFailure = await fixture(context, { activityFailureAt: 2 })
  const activityInput = request(activityFailure.outputFile)
  const activityPlan = await activityFailure.service.planCreation(
    APPLICATION_ID,
    BOT_ID,
    activityInput,
  )
  await assert.rejects(
    () => activityFailure.service.executeCreation(
      APPLICATION_ID,
      BOT_ID,
      activityInput,
      activityPlan.digest,
    ),
    (error: unknown) => {
      assert.ok(error instanceof InviteCreationExecutionError)
      assert.equal(
        (error.result as { status: string }).status,
        "completed-audit-failed",
      )
      return true
    },
  )
  assert.match(await readFile(activityFailure.outputFile, "utf8"), new RegExp(PRIVATE_CODE))
  assert.equal(
    [...activityFailure.operationStore.receipts.values()].at(-1)?.status,
    "completed",
  )
})

test("invite creation rejects a spent operation key without touching its output target", async (context) => {
  const setup = await fixture(context)
  const input = request(setup.outputFile)
  const plan = await setup.service.planCreation(APPLICATION_ID, BOT_ID, input)
  await setup.operationStore.reserve({
    activityId: "prior-activity",
    error: null,
    guildId: GUILD_ID,
    kind: "invite-creation",
    operationKeyHash: plan.operationKeyHash,
    planDigest: plan.digest,
    resourceId: null,
    schemaVersion: 1,
    status: "pending",
    timestamp: CREATED_AT,
    verification: null,
  })

  await assert.rejects(
    () => setup.service.executeCreation(
      APPLICATION_ID,
      BOT_ID,
      input,
      plan.digest,
    ),
    InviteCreationOperationConflictError,
  )
  assert.equal(setup.events.some((entry) => entry.startsWith("write:create:")), false)
  await assert.rejects(() => lstat(setup.outputFile), { code: "ENOENT" })
})

test("invite creation quarantines a mismatched mutation response without leaking its code", async (context) => {
  const setup = await fixture(context, {
    created: createdInvite({ maxUses: 2 }),
  })
  const input = request(setup.outputFile)
  const plan = await setup.service.planCreation(APPLICATION_ID, BOT_ID, input)

  await assert.rejects(
    () => setup.service.executeCreation(
      APPLICATION_ID,
      BOT_ID,
      input,
      plan.digest,
    ),
    (error: unknown) => {
      assert.ok(error instanceof InviteCreationExecutionError)
      assert.equal((error.result as { status: string }).status, "uncertain")
      assert.doesNotMatch(JSON.stringify(error), new RegExp(PRIVATE_CODE))
      return true
    },
  )
  await assert.rejects(() => lstat(setup.outputFile), { code: "ENOENT" })
  assert.equal(setup.activities.at(-1)?.status, "uncertain")

  await assert.rejects(
    () => setup.service.executeCreation(
      APPLICATION_ID,
      BOT_ID,
      request(setup.outputFile, { operationKey: "invite-creation-operation-0002" }),
      plan.digest,
    ),
    /prior same-channel operation ended with an uncertain outcome/,
  )
})

test("invite creation withholds capability when exact verification is uncertain", async (context) => {
  const setup = await fixture(context, {
    verification: {
      channelId: "500000000000000002",
      code: PRIVATE_CODE,
      guildId: GUILD_ID,
      roleIds: [],
      type: 0,
    },
  })
  const input = request(setup.outputFile)
  const plan = await setup.service.planCreation(APPLICATION_ID, BOT_ID, input)

  await assert.rejects(
    () => setup.service.executeCreation(
      APPLICATION_ID,
      BOT_ID,
      input,
      plan.digest,
    ),
    (error: unknown) => {
      assert.ok(error instanceof InviteCreationExecutionError)
      const result = error.result as {
        capabilityFileWritten: boolean
        inviteRef: string
        status: string
      }
      assert.equal(result.status, "uncertain")
      assert.equal(result.capabilityFileWritten, false)
      assert.match(result.inviteRef, INVITE_REFERENCE_PATTERN)
      assert.doesNotMatch(JSON.stringify(error), new RegExp(PRIVATE_CODE))
      return true
    },
  )
  await assert.rejects(() => lstat(setup.outputFile), { code: "ENOENT" })
  assert.equal(setup.activities.at(-1)?.status, "uncertain")
  assert.doesNotMatch(JSON.stringify(setup.activities), new RegExp(PRIVATE_CODE))
})

test("invite role assignment requires exact mutation and independent role readback", async (context) => {
  for (const overrides of [
    roleGrantState({ created: createdInvite({ roleIds: [] }) }),
    roleGrantState({
      verification: {
        channelId: CHANNEL_ID,
        code: PRIVATE_CODE,
        guildId: GUILD_ID,
        roleIds: [],
        type: 0,
      },
    }),
  ]) {
    const setup = await fixture(context, overrides)
    const input = request(setup.outputFile, {
      roleAssignment: {
        acknowledgePersistentGrants: true,
        kind: "grant",
        roleIds: [GRANTED_ROLE_ID],
      },
    })
    const plan = await setup.service.planCreation(APPLICATION_ID, BOT_ID, input)

    await assert.rejects(
      () => setup.service.executeCreation(
        APPLICATION_ID,
        BOT_ID,
        input,
        plan.digest,
      ),
      (error: unknown) => {
        assert.ok(error instanceof InviteCreationExecutionError)
        const result = error.result as {
          roleAssignment: unknown
          status: string
        }
        assert.equal(result.status, "uncertain")
        assert.deepEqual(result.roleAssignment, {
          kind: "grant",
          roleCount: 1,
          roleIds: [GRANTED_ROLE_ID],
        })
        assert.doesNotMatch(JSON.stringify(error), new RegExp(PRIVATE_CODE))
        return true
      },
    )
    await assert.rejects(() => lstat(setup.outputFile), { code: "ENOENT" })
  }
})

test("invite creation withholds exact-user capability after job or CSV failure", async (context) => {
  const failures: Partial<FixtureState>[] = [
    {
      inventoryVerification: [createdInvite({ channelId: "500000000000000002" })],
    },
    {
      targetUserJobStatuses: [{
        completedAt: null,
        createdAt: CREATED_AT,
        errorPresent: false,
        processedUsers: 0,
        status: 1,
        totalUsers: 2,
        unknownFieldCount: 0,
      }],
    },
    {
      targetUserJobStatuses: [{
        completedAt: "2026-08-24T00:00:01.000Z",
        createdAt: CREATED_AT,
        errorPresent: true,
        processedUsers: 1,
        status: 3,
        totalUsers: 2,
        unknownFieldCount: 0,
      }],
    },
    { targetUserIds: ["600000000000000003"] },
    { targetUserVerificationError: new Error(`private CSV ${PRIVATE_CODE}`) },
  ]
  for (const overrides of failures) {
    const setup = await fixture(context, {
      ...overrides,
      roles: [
        role(GUILD_ID, 0n, 0),
        role(
          BOT_ROLE_ID,
          DISCORD_PERMISSIONS.VIEW_CHANNEL
            | DISCORD_PERMISSIONS.CREATE_INSTANT_INVITE
            | DISCORD_PERMISSIONS.MANAGE_GUILD,
          10,
        ),
      ],
    })
    const input = request(setup.outputFile, {
      acceptance: {
        kind: "exact-users",
        userIds: ["600000000000000001", "600000000000000002"],
      },
    })
    const plan = await setup.service.planCreation(APPLICATION_ID, BOT_ID, input)

    await assert.rejects(
      () => setup.service.executeCreation(
        APPLICATION_ID,
        BOT_ID,
        input,
        plan.digest,
      ),
      (error: unknown) => {
        assert.ok(error instanceof InviteCreationExecutionError)
        assert.equal((error.result as { status: string }).status, "uncertain")
        assert.doesNotMatch(JSON.stringify(error), new RegExp(PRIVATE_CODE))
        return true
      },
    )
    await assert.rejects(() => lstat(setup.outputFile), { code: "ENOENT" })
    assert.equal(setup.activities.at(-1)?.status, "uncertain")
  }
})

test("invite creation fresh-checks output absence before reserving any write", async (context) => {
  const setup = await fixture(context)
  const input = request(setup.outputFile)
  const plan = await setup.service.planCreation(APPLICATION_ID, BOT_ID, input)
  await writeFile(setup.outputFile, "preserve\n", { mode: 0o600 })

  await assert.rejects(
    () => setup.service.executeCreation(
      APPLICATION_ID,
      BOT_ID,
      input,
      plan.digest,
    ),
    InviteCreationPlanChangedError,
  )
  assert.equal(await readFile(setup.outputFile, "utf8"), "preserve\n")
  assert.equal(setup.events.includes("operation:reserve"), false)
  assert.equal(setup.events.some((entry) => entry.startsWith("write:")), false)
})
