import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  BulkMemberRoleService,
  normalizeBulkMemberRoleRequest,
  type BulkMemberRoleRequest,
  type BulkMemberRoleServiceOptions,
} from "../src/bulk-member-role-service.js"
import { CONNECTOR_LIMITS, SCHEMA_VERSION } from "../src/constants.js"
import {
  BulkMemberRoleEvidenceError,
  BulkMemberRoleExecutionError,
  BulkMemberRoleOperationConflictError,
  BulkMemberRolePlanChangedError,
  MemberRoleExecutionError,
} from "../src/errors.js"
import type {
  MemberRoleChangePlan,
  MemberRoleChangeRequest,
  MemberRoleChangeResult,
} from "../src/member-role-service.js"
import {
  operationKeyHash,
  type OperationKind,
  type OperationReceipt,
  type OperationReservation,
  type OperationStore,
} from "../src/operation-store.js"
import { DISCORD_PERMISSIONS } from "../src/permissions.js"
import { ScopePolicy } from "../src/policy.js"

const APPLICATION_ID = "100000000000000001"
const GUILD_ID = "200000000000000001"
const BOT_ID = "300000000000000001"
const OWNER_ID = "400000000000000001"
const BOT_ROLE_ID = "500000000000000001"
const ROLE_ID = "600000000000000001"
const USER_ONE = "700000000000000001"
const USER_TWO = "700000000000000002"
const USER_THREE = "700000000000000003"
const CHANNEL_ID = "800000000000000001"
const OPERATION_KEY = "bulk-member-role-operation-0001"
const NOW = "2026-08-27T00:00:00.000Z"

function digest(value: string): string {
  return `hmac-sha256:${createHash("sha256").update(value).digest("hex")}`
}

function request(
  overrides: Partial<BulkMemberRoleRequest> = {},
): BulkMemberRoleRequest {
  return {
    action: "add",
    auditReason: "Reviewed support cohort assignment",
    guildId: GUILD_ID,
    operationKey: OPERATION_KEY,
    roleId: ROLE_ID,
    userIds: [USER_TWO, USER_ONE],
    ...overrides,
  }
}

function policy(options: {
  batchEnabled?: boolean
  directEnabled?: boolean
  guildIds?: readonly string[]
  protectedUserIds?: readonly string[]
  roleIds?: readonly string[]
} = {}): ScopePolicy {
  return new ScopePolicy({
    adminGuildIds: new Set(),
    allowedChannelIds: new Set(),
    allowedGuildIds: new Set([GUILD_ID]),
    allowAdministration: false,
    allowBulkMemberRoleChanges: options.batchEnabled ?? true,
    allowDeletions: false,
    allowInteractions: false,
    allowMemberRoleChanges: options.directEnabled ?? false,
    bulkMemberRoleGuildIds: new Set(options.guildIds || [GUILD_ID]),
    bulkMemberRoleIds: new Set(options.roleIds || [ROLE_ID]),
    deleteChannelIds: new Set(),
    interactionChannelIds: new Set(),
    interactionMaxWritesPerMinute: 10,
    interactionMinWriteIntervalMs: 500,
    memberRoleGuildIds: new Set([GUILD_ID]),
    memberRoleIds: new Set([ROLE_ID]),
    mentionUserIds: new Set(),
    protectedUserIds: new Set(options.protectedUserIds || []),
  })
}

class MemoryOperationStore implements OperationStore {
  readonly receipts = new Map<string, OperationReceipt>()

  #key(kind: OperationKind, hash: string): string {
    return `${kind}\0${hash}`
  }

  async finish(receipt: OperationReceipt): Promise<void> {
    const key = this.#key(receipt.kind, receipt.operationKeyHash)
    const pending = this.receipts.get(key)
    assert.ok(pending)
    assert.equal(pending.status, "pending")
    assert.equal(pending.activityId, receipt.activityId)
    assert.equal(pending.planDigest, receipt.planDigest)
    this.receipts.set(key, receipt)
  }

  async get(
    kind: OperationKind,
    hash: string,
  ): Promise<OperationReceipt | undefined> {
    return this.receipts.get(this.#key(kind, hash))
  }

  async reserve(receipt: OperationReceipt): Promise<OperationReservation> {
    const key = this.#key(receipt.kind, receipt.operationKeyHash)
    const existing = this.receipts.get(key)
    if (existing) return { created: false, receipt: existing }
    this.receipts.set(key, receipt)
    return { created: true, receipt }
  }
}

type FailureMode = "failed" | "prewrite"

function memberPlan(
  value: MemberRoleChangeRequest,
  rolePresent: boolean,
  commonEvidenceDigest: string,
): MemberRoleChangePlan {
  const alreadyCurrent = value.action === "add" ? rolePresent : !rolePresent
  const beforeRoleIds = rolePresent ? [ROLE_ID] : []
  const afterRoleIds = alreadyCurrent
    ? beforeRoleIds
    : value.action === "add" ? [ROLE_ID] : []
  const selectedPermissions = DISCORD_PERMISSIONS.VIEW_CHANNEL
    | DISCORD_PERMISSIONS.SEND_MESSAGES
  return {
    action: alreadyCurrent ? "none" : value.action,
    applicationId: APPLICATION_ID,
    auditReason: value.auditReason,
    botId: BOT_ID,
    channelEvidence: {
      gatewayChannelCount: 1,
      httpChannelCount: 1,
      httpMode: "complete",
      layoutRevision: 1,
      layoutUpdatedAt: NOW,
      metadataCoverage: "complete",
      obfuscatedChannelCount: 0,
      trustedMetadataCount: 1,
    },
    commonEvidenceDigest,
    createdAt: NOW,
    digest: digest(`${operationKeyHash(value.operationKey)}\0${rolePresent}\0${commonEvidenceDigest}`),
    guild: { id: GUILD_ID, name: "Private guild", ownerId: OWNER_ID },
    highRiskPermissions: [],
    highRiskPermissionGains: [],
    impact: {
      changedChannels: alreadyCurrent ? 0 : 1,
      coverage: { evaluatedChannelCount: 1, status: "complete", totalChannelCount: 1, unsupportedChannels: [] },
      channels: alreadyCurrent ? [] : [{
        channelId: CHANNEL_ID,
        channelType: 0,
        changes: [{
          after: value.action === "add" ? "allowed" : "denied",
          before: value.action === "add" ? "denied" : "allowed",
          permission: "SEND_MESSAGES",
        }],
      }],
      evaluatedChannels: 1,
      guildPermissions: {
        added: value.action === "add" && !alreadyCurrent ? ["SEND_MESSAGES"] : [],
        after: afterRoleIds.length > 0
          ? ["VIEW_CHANNEL", "SEND_MESSAGES"]
          : ["VIEW_CHANNEL"],
        before: beforeRoleIds.length > 0
          ? ["VIEW_CHANNEL", "SEND_MESSAGES"]
          : ["VIEW_CHANNEL"],
        removed: value.action === "remove" && !alreadyCurrent ? ["SEND_MESSAGES"] : [],
      },
      permissions: ["VIEW_CHANNEL", "SEND_MESSAGES"],
    },
    member: {
      afterRoleIds,
      beforeRoleIds,
      id: value.userId,
      username: `untrusted-${value.userId}`,
    },
    operationKeyHash: operationKeyHash(value.operationKey),
    permission: {
      botAdministrator: false,
      botEffectivePermissionNames: ["MANAGE_ROLES", "VIEW_CHANNEL", "SEND_MESSAGES"],
      botEffectivePermissions: (
        DISCORD_PERMISSIONS.MANAGE_ROLES | selectedPermissions
      ).toString(),
      botHighestRoleIds: [BOT_ROLE_ID],
      botHighestRolePosition: 10,
      channelPermissionEscalationSubset: true,
      channelOverwriteUnknownPermissionBits: "0",
      guildRoleUnknownPermissionBits: "0",
      guildManageRoles: true,
      roleBelowBot: true,
      roleOverwriteUnknownPermissionBits: "0",
      rolePermissionsSubset: true,
      targetBelowBot: true,
      targetHighestRoleIds: [GUILD_ID],
      targetHighestRolePosition: 0,
    },
    requestedAction: value.action,
    role: {
      colors: {
        primaryColor: 0,
        secondaryColor: null,
        tertiaryColor: null,
      },
      flags: 0,
      hoist: false,
      icon: null,
      id: ROLE_ID,
      managed: false,
      management: { id: null, type: "standard" },
      mentionable: false,
      name: "Untrusted role",
      permissionNames: ["VIEW_CHANNEL", "SEND_MESSAGES"],
      permissions: selectedPermissions.toString(),
      position: 2,
      unicodeEmoji: null,
      unknownFieldCount: 0,
      unknownPermissionBits: "0",
    },
    schemaVersion: SCHEMA_VERSION,
    status: alreadyCurrent ? "already-current" : "planned",
    warnings: [],
  }
}

function fixture(options: {
  baselineCommonEvidenceDigest?: string
  commonEvidenceByUser?: Readonly<Record<string, string>>
  driftAfterUser?: string
  failureByUser?: Readonly<Record<string, FailureMode>>
  initialRoles?: Readonly<Record<string, boolean>>
  policy?: ScopePolicy
} = {}) {
  const operationStore = new MemoryOperationStore()
  const roleState = new Map<string, boolean>([
    [USER_ONE, options.initialRoles?.[USER_ONE] ?? false],
    [USER_TWO, options.initialRoles?.[USER_TWO] ?? false],
    [USER_THREE, options.initialRoles?.[USER_THREE] ?? false],
  ])
  const executionOrder: string[] = []
  const planningBatches: string[][] = []
  const common = digest("common-evidence")
  const memberRoleService: BulkMemberRoleServiceOptions["memberRoleService"] = {
    async planBatchForBulk(_authority, _applicationId, _botId, values) {
      planningBatches.push(values.map((value) => value.userId))
      return {
        baselineCommonEvidenceDigest: options.baselineCommonEvidenceDigest ?? common,
        plans: values.map((value) => memberPlan(
          value,
          roleState.get(value.userId) ?? false,
          options.commonEvidenceByUser?.[value.userId] ?? common,
        )),
      }
    },
    async executeForBulk(
      _authority,
      _applicationId,
      _botId,
      value,
      expectedDigest,
    ): Promise<MemberRoleChangeResult> {
      const plan = memberPlan(
        value,
        roleState.get(value.userId) ?? false,
        options.commonEvidenceByUser?.[value.userId] ?? common,
      )
      assert.equal(plan.digest, expectedDigest)
      executionOrder.push(value.userId)
      const failure = options.failureByUser?.[value.userId]
      if (failure === "prewrite") {
        throw new Error("planning transport unavailable")
      }
      const receiptBase = {
        activityId: `child-${value.userId}`,
        error: null,
        guildId: value.guildId,
        kind: "member-role-change" as const,
        operationKeyHash: operationKeyHash(value.operationKey),
        planDigest: plan.digest,
        resourceId: null,
        schemaVersion: 1 as const,
        status: "pending" as const,
        timestamp: NOW,
        verification: null,
      }
      await operationStore.reserve(receiptBase)
      if (failure === "failed") {
        await operationStore.finish({
          ...receiptBase,
          error: "DiscordApiError.403.50013",
          status: "failed",
        })
        throw new MemberRoleExecutionError("Member role failed", {
          status: "failed",
          userId: value.userId,
        })
      }
      roleState.set(value.userId, value.action === "add")
      await operationStore.finish({
        ...receiptBase,
        resourceId: value.roleId,
        status: "completed",
        verification: "match",
      })
      if (options.driftAfterUser === value.userId) roleState.set(USER_ONE, false)
      return {
        action: value.action,
        activityId: receiptBase.activityId,
        guildId: value.guildId,
        observedRoleIds: value.action === "add" ? [value.roleId] : [],
        operationKeyHash: receiptBase.operationKeyHash,
        planDigest: plan.digest,
        roleId: value.roleId,
        rolePresent: value.action === "add",
        roleSnapshotMatched: true,
        schemaVersion: SCHEMA_VERSION,
        status: "completed",
        userId: value.userId,
      }
    },
  }
  const createService = (planKey: Uint8Array) => new BulkMemberRoleService({
    clock: () => new Date(NOW),
    memberRoleService,
    operationStore,
    planKey,
    policy: options.policy ?? policy(),
    randomId: () => "bulk-member-role-parent",
  })
  const service = createService(Buffer.alloc(32, 9))
  return {
    executionOrder,
    operationStore,
    planningBatches,
    restart: () => createService(Buffer.alloc(32, 10)),
    roleState,
    service,
  }
}

test("bulk member-role normalization is strict, bounded, and canonical", () => {
  const normalized = normalizeBulkMemberRoleRequest(request())
  assert.deepEqual(normalized.userIds, [USER_ONE, USER_TWO])
  assert.match(normalized.targetSetDigest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(normalized.operationKeyHash, operationKeyHash(OPERATION_KEY))
  assert.throws(
    () => normalizeBulkMemberRoleRequest(request({ userIds: [USER_ONE] })),
    /requires one action/,
  )
  assert.throws(
    () => normalizeBulkMemberRoleRequest(request({ userIds: [USER_ONE, USER_ONE] })),
    /unique canonical positive user/,
  )
  assert.throws(
    () => normalizeBulkMemberRoleRequest(request({
      userIds: [USER_ONE, `0${USER_ONE}`],
    })),
    /unique canonical positive user/,
  )
  assert.throws(
    () => normalizeBulkMemberRoleRequest({
      ...request(),
      unexpected: true,
    } as BulkMemberRoleRequest),
    /requires one action/,
  )
  const excessive = Array.from(
    { length: CONNECTOR_LIMITS.bulkMemberRoleTargets + 1 },
    (_, index) => String(9_000_000_000_000_000n + BigInt(index)),
  )
  assert.throws(
    () => normalizeBulkMemberRoleRequest(request({ userIds: excessive })),
    /unique canonical positive user/,
  )
})

test("bulk member-role planning uses independent batch policy and coherent evidence", async () => {
  const { planningBatches, service } = fixture()
  const plan = await service.plan(APPLICATION_ID, BOT_ID, request())
  assert.equal(plan.status, "planned")
  assert.deepEqual(plan.counts, {
    alreadyCurrent: 0,
    completed: 0,
    ready: 2,
    total: 2,
  })
  assert.deepEqual(plan.executionFrontier.userIds, [USER_ONE, USER_TWO])
  assert.equal(plan.permission.guildManageRoles, true)
  assert.equal(plan.verificationBoundary.maximumWrites, 2)
  assert.ok(plan.warnings.includes(
    "Batch planning requires matching common authority evidence before and after bounded target-member reads",
  ))
  assert.deepEqual(planningBatches, [[USER_ONE, USER_TWO]])

  await assert.rejects(
    fixture({ policy: policy({ batchEnabled: false, directEnabled: true }) }).service.plan(
      APPLICATION_ID,
      BOT_ID,
      request(),
    ),
    /bulk member-role changes are disabled/,
  )
  await assert.rejects(
    fixture({ policy: policy({ protectedUserIds: [USER_TWO] }) }).service.plan(
      APPLICATION_ID,
      BOT_ID,
      request(),
    ),
    /protected/,
  )
  await assert.rejects(
    fixture({
      commonEvidenceByUser: {
        [USER_ONE]: digest("first"),
        [USER_TWO]: digest("second"),
      },
    }).service.plan(APPLICATION_ID, BOT_ID, request()),
    BulkMemberRoleEvidenceError,
  )
  await assert.rejects(
    fixture({
      baselineCommonEvidenceDigest: digest("baseline"),
    }).service.plan(APPLICATION_ID, BOT_ID, request()),
    BulkMemberRoleEvidenceError,
  )
  await assert.rejects(
    fixture({ baselineCommonEvidenceDigest: "invalid" }).service.plan(
      APPLICATION_ID,
      BOT_ID,
      request(),
    ),
    BulkMemberRoleEvidenceError,
  )
})

test("bulk member-role no-op batches do not reserve or write", async () => {
  const { executionOrder, operationStore, service } = fixture({
    initialRoles: { [USER_ONE]: true, [USER_TWO]: true },
  })
  const plan = await service.plan(APPLICATION_ID, BOT_ID, request())
  assert.equal(plan.status, "already-current")
  const result = await service.execute(
    APPLICATION_ID,
    BOT_ID,
    request(),
    plan.digest,
  )
  assert.equal(result.status, "already-current")
  assert.deepEqual(executionOrder, [])
  assert.equal(operationStore.receipts.size, 0)
})

test("bulk member-role execution classifies common-window drift as a changed plan", async () => {
  const options: { baselineCommonEvidenceDigest?: string } = {}
  const target = fixture(options)
  const plan = await target.service.plan(APPLICATION_ID, BOT_ID, request())
  options.baselineCommonEvidenceDigest = digest("later-baseline")
  await assert.rejects(
    target.service.execute(APPLICATION_ID, BOT_ID, request(), plan.digest),
    BulkMemberRolePlanChangedError,
  )
  assert.deepEqual(target.executionOrder, [])
})

test("bulk member-role execution writes sequentially and checkpoints every target", async () => {
  const { executionOrder, operationStore, planningBatches, roleState, service } = fixture()
  const plan = await service.plan(APPLICATION_ID, BOT_ID, request())
  const result = await service.execute(
    APPLICATION_ID,
    BOT_ID,
    request(),
    plan.digest,
  )
  assert.equal(result.status, "completed")
  assert.deepEqual(executionOrder, [USER_ONE, USER_TWO])
  assert.equal(roleState.get(USER_ONE), true)
  assert.equal(roleState.get(USER_TWO), true)
  assert.equal(result.executedTargets.length, 2)
  assert.deepEqual(planningBatches, [
    [USER_ONE, USER_TWO],
    [USER_ONE, USER_TWO],
    [USER_ONE, USER_TWO],
  ])
  assert.equal(
    operationStore.receipts.get(
      `bulk-member-role-change\0${operationKeyHash(OPERATION_KEY)}`,
    )?.status,
    "completed",
  )
  assert.equal(
    [...operationStore.receipts.values()].filter(
      (receipt) => receipt.kind === "member-role-change",
    ).length,
    2,
  )
})

test("bulk member-role execution removes one exact role from every target", async () => {
  const fixtureValue = fixture({
    initialRoles: { [USER_ONE]: true, [USER_TWO]: true },
  })
  const value = request({ action: "remove" })
  const plan = await fixtureValue.service.plan(APPLICATION_ID, BOT_ID, value)
  const result = await fixtureValue.service.execute(
    APPLICATION_ID,
    BOT_ID,
    value,
    plan.digest,
  )
  assert.equal(result.status, "completed")
  assert.deepEqual(fixtureValue.executionOrder, [USER_ONE, USER_TWO])
  assert.equal(fixtureValue.roleState.get(USER_ONE), false)
  assert.equal(fixtureValue.roleState.get(USER_TWO), false)
})

test("bulk member-role completed parents require exact verified role evidence", async () => {
  for (const terminal of [
    { resourceId: USER_ONE, verification: "match" as const },
    { resourceId: ROLE_ID, verification: "drift" as const },
  ]) {
    const fixtureValue = fixture({
      initialRoles: { [USER_ONE]: true, [USER_TWO]: true },
    })
    const plan = await fixtureValue.service.plan(
      APPLICATION_ID,
      BOT_ID,
      request(),
    )
    fixtureValue.operationStore.receipts.set(
      `bulk-member-role-change\0${operationKeyHash(OPERATION_KEY)}`,
      {
        activityId: "bulk-member-role-parent",
        error: null,
        guildId: GUILD_ID,
        kind: "bulk-member-role-change",
        operationKeyHash: operationKeyHash(OPERATION_KEY),
        planDigest: plan.operation.requestDigest,
        resourceId: terminal.resourceId,
        schemaVersion: 1,
        status: "completed",
        timestamp: NOW,
        verification: terminal.verification,
      },
    )
    await assert.rejects(
      fixtureValue.service.plan(APPLICATION_ID, BOT_ID, request()),
      /lacks exact verified role evidence/,
    )
  }
})

test("bulk member-role execution stops permanently after a failed child", async () => {
  const value = request({ userIds: [USER_ONE, USER_TWO, USER_THREE] })
  const { executionOrder, operationStore, roleState, service } = fixture({
    failureByUser: { [USER_TWO]: "failed" },
  })
  const plan = await service.plan(APPLICATION_ID, BOT_ID, value)
  await assert.rejects(
    service.execute(APPLICATION_ID, BOT_ID, value, plan.digest),
    (error: unknown) => {
      assert.ok(error instanceof BulkMemberRoleExecutionError)
      assert.equal((error.result as { status: string }).status, "failed")
      return true
    },
  )
  assert.deepEqual(executionOrder, [USER_ONE, USER_TWO])
  assert.equal(roleState.get(USER_ONE), true)
  assert.equal(roleState.get(USER_THREE), false)
  assert.equal(
    operationStore.receipts.get(
      `bulk-member-role-change\0${operationKeyHash(OPERATION_KEY)}`,
    )?.status,
    "failed",
  )
  await assert.rejects(
    service.plan(APPLICATION_ID, BOT_ID, value),
    BulkMemberRoleOperationConflictError,
  )
})

test("bulk member-role pending parents resume from verified child checkpoints", async () => {
  const failures: Record<string, FailureMode> = { [USER_TWO]: "prewrite" }
  const fixtureValue = fixture({ failureByUser: failures })
  const firstPlan = await fixtureValue.service.plan(APPLICATION_ID, BOT_ID, request())
  const paused = await fixtureValue.service.execute(
    APPLICATION_ID,
    BOT_ID,
    request(),
    firstPlan.digest,
  )
  assert.equal(paused.status, "paused")
  assert.deepEqual(fixtureValue.executionOrder, [USER_ONE, USER_TWO])
  assert.equal(fixtureValue.roleState.get(USER_ONE), true)
  assert.equal(
    fixtureValue.operationStore.receipts.get(
      `bulk-member-role-change\0${operationKeyHash(OPERATION_KEY)}`,
    )?.status,
    "pending",
  )

  delete failures[USER_TWO]
  const resumePlan = await fixtureValue.service.plan(
    APPLICATION_ID,
    BOT_ID,
    request(),
  )
  assert.equal(resumePlan.status, "resume-ready")
  assert.deepEqual(
    resumePlan.targets.map((target) => [target.userId, target.state]),
    [[USER_ONE, "completed"], [USER_TWO, "ready"]],
  )
  const completed = await fixtureValue.service.execute(
    APPLICATION_ID,
    BOT_ID,
    request(),
    resumePlan.digest,
  )
  assert.equal(completed.status, "completed")
  assert.deepEqual(fixtureValue.executionOrder, [USER_ONE, USER_TWO, USER_TWO])
})

test("bulk member-role verified pauses resume under a fresh process plan key", async () => {
  const failures: Record<string, FailureMode> = { [USER_TWO]: "prewrite" }
  const fixtureValue = fixture({ failureByUser: failures })
  const firstPlan = await fixtureValue.service.plan(APPLICATION_ID, BOT_ID, request())
  const paused = await fixtureValue.service.execute(
    APPLICATION_ID,
    BOT_ID,
    request(),
    firstPlan.digest,
  )
  assert.equal(paused.status, "paused")

  delete failures[USER_TWO]
  const restartedService = fixtureValue.restart()
  const resumePlan = await restartedService.plan(APPLICATION_ID, BOT_ID, request())
  assert.equal(resumePlan.status, "resume-ready")
  assert.notEqual(resumePlan.digest, firstPlan.digest)
  assert.equal(resumePlan.operation.requestDigest, firstPlan.operation.requestDigest)
  const completed = await restartedService.execute(
    APPLICATION_ID,
    BOT_ID,
    request(),
    resumePlan.digest,
  )
  assert.equal(completed.status, "completed")
  assert.deepEqual(fixtureValue.executionOrder, [USER_ONE, USER_TWO, USER_TWO])
})

test("bulk member-role checkpoints fail closed when live goal state drifts", async () => {
  const fixtureValue = fixture()
  const plan = await fixtureValue.service.plan(APPLICATION_ID, BOT_ID, request())
  await fixtureValue.service.execute(APPLICATION_ID, BOT_ID, request(), plan.digest)
  fixtureValue.roleState.set(USER_ONE, false)
  await assert.rejects(
    fixtureValue.service.plan(APPLICATION_ID, BOT_ID, request()),
    BulkMemberRoleOperationConflictError,
  )
})

test("bulk member-role final checkpoint drift becomes terminal uncertainty", async () => {
  const fixtureValue = fixture({ driftAfterUser: USER_TWO })
  const plan = await fixtureValue.service.plan(APPLICATION_ID, BOT_ID, request())
  await assert.rejects(
    fixtureValue.service.execute(APPLICATION_ID, BOT_ID, request(), plan.digest),
    (error: unknown) => {
      assert.ok(error instanceof BulkMemberRoleExecutionError)
      const result = error.result as {
        remainingUserIds: string[]
        status: string
        userId: string | null
      }
      assert.equal(result.status, "uncertain")
      assert.equal(result.userId, USER_ONE)
      assert.deepEqual(result.remainingUserIds, [USER_ONE])
      return true
    },
  )
  assert.equal(
    fixtureValue.operationStore.receipts.get(
      `bulk-member-role-change\0${operationKeyHash(OPERATION_KEY)}`,
    )?.status,
    "uncertain",
  )
  await assert.rejects(
    fixtureValue.service.plan(APPLICATION_ID, BOT_ID, request()),
    BulkMemberRoleOperationConflictError,
  )
})
