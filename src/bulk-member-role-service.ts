import {
  createHash,
  createHmac,
  randomUUID,
} from "node:crypto"

import { BULK_MEMBER_ROLE_AUTHORITY } from "./bulk-member-role-authority.js"
import {
  CONNECTOR_LIMITS,
  DISCORD_SNOWFLAKE_MAX,
  DISCORD_SNOWFLAKE_PATTERN,
  MEMBER_ROLE_ACTIONS,
  SCHEMA_VERSION,
  type MemberRoleAction,
} from "./constants.js"
import { encodeDiscordAuditReason } from "./discord-client.js"
import {
  BulkMemberRoleEvidenceError,
  BulkMemberRoleExecutionError,
  BulkMemberRoleOperationConflictError,
  BulkMemberRolePlanChangedError,
  DiscordApiError,
} from "./errors.js"
import type {
  MemberRoleChangePlan,
  MemberRoleChangeRequest,
  MemberRoleChangeResult,
  MemberRoleService,
} from "./member-role-service.js"
import {
  type OperationReceipt,
  type OperationStore,
  operationKeyHash,
} from "./operation-store.js"
import type { ScopePolicy } from "./policy.js"
import {
  createReviewedPlanKey,
  REVIEWED_PLAN_DIGEST_PATTERN,
  reviewedPlanDigest,
} from "./reviewed-plan.js"
import type { RequestOptions } from "./types.js"

const REQUEST_KEYS = [
  "action",
  "auditReason",
  "guildId",
  "operationKey",
  "roleId",
  "userIds",
] as const
const BATCH_LOCKS = new Map<string, Promise<void>>()
const STATE_UNAVAILABLE = "bulk-member-role-state-unavailable"

export interface BulkMemberRoleRequest {
  action: MemberRoleAction
  auditReason: string
  guildId: string
  operationKey: string
  roleId: string
  userIds: readonly string[]
}

export interface NormalizedBulkMemberRoleRequest {
  action: MemberRoleAction
  auditReason: string
  guildId: string
  operationKey: string
  operationKeyHash: string
  roleId: string
  targetSetDigest: string
  userIds: string[]
}

export type BulkMemberRoleTargetState = "already-current" | "completed" | "ready"

export interface BulkMemberRoleTargetPlan {
  checkpoint: {
    activityId: string
    planDigest: string
    timestamp: string
  } | null
  childOperationKeyHash: string
  highRiskPermissionGains: MemberRoleChangePlan["highRiskPermissionGains"]
  impact: MemberRoleChangePlan["impact"]
  inspectionPlanDigest: string
  member: MemberRoleChangePlan["member"]
  permission: {
    targetBelowBot: boolean
    targetHighestRoleIds: string[]
    targetHighestRolePosition: number
  }
  state: BulkMemberRoleTargetState
  userId: string
}

export interface BulkMemberRolePlan {
  action: MemberRoleAction
  applicationId: string
  auditReason: string
  botId: string
  channelEvidence: MemberRoleChangePlan["channelEvidence"]
  commonEvidenceDigest: string
  counts: {
    alreadyCurrent: number
    completed: number
    ready: number
    total: number
  }
  createdAt: string
  digest: string
  executionFrontier: {
    userIds: string[]
  }
  guild: MemberRoleChangePlan["guild"]
  highRiskPermissions: MemberRoleChangePlan["highRiskPermissions"]
  operation: {
    operationKeyHash: string
    requestDigest: string
    status: OperationReceipt["status"] | "unreserved"
  }
  permission: {
    botAdministrator: boolean
    botEffectivePermissionNames: MemberRoleChangePlan["permission"]["botEffectivePermissionNames"]
    botEffectivePermissions: string
    botHighestRoleIds: string[]
    botHighestRolePosition: number
    channelOverwriteUnknownPermissionBits: string
    guildManageRoles: boolean
    guildRoleUnknownPermissionBits: string
    roleBelowBot: boolean
    roleOverwriteUnknownPermissionBits: string
    rolePermissionsSubset: boolean
  }
  role: MemberRoleChangePlan["role"]
  schemaVersion: number
  status: "already-current" | "completed" | "planned" | "resume-ready"
  targetCount: number
  targetSetDigest: string
  targets: BulkMemberRoleTargetPlan[]
  verificationBoundary: {
    automaticRetry: false
    exactReadbackPerWrite: true
    maximumWrites: number
    rollback: "never"
    sequence: "canonical-user-id"
    stopOnUnsettledTarget: true
  }
  warnings: string[]
}

export interface BulkMemberRoleExecutedTarget {
  activityId: string | null
  status: MemberRoleChangeResult["status"]
  userId: string
}

export interface BulkMemberRoleResult {
  action: MemberRoleAction
  activityId: string | null
  executedTargets: BulkMemberRoleExecutedTarget[]
  guildId: string
  operationKeyHash: string
  planDigest: string
  remainingUserIds: string[]
  requestDigest: string
  roleId: string
  schemaVersion: number
  status: "already-current" | "completed" | "paused"
  targetSetDigest: string
}

export interface BulkMemberRoleServiceOptions {
  clock?: () => Date
  memberRoleService: Pick<MemberRoleService, "executeForBulk" | "planBatchForBulk">
  operationStore: OperationStore
  planKey?: Uint8Array
  policy: ScopePolicy
  randomId?: () => string
}

interface PlannedTarget {
  childRequest: MemberRoleChangeRequest
  plan: MemberRoleChangePlan
  receipt: OperationReceipt | undefined
  target: BulkMemberRoleTargetPlan
}

interface PreparedTarget {
  childRequest: MemberRoleChangeRequest
  planningRequest: MemberRoleChangeRequest
  receipt: OperationReceipt | undefined
  userId: string
}

function positiveSnowflake(value: unknown): value is string {
  return typeof value === "string"
    && DISCORD_SNOWFLAKE_PATTERN.test(value)
    && BigInt(value) >= 1n
    && BigInt(value) <= DISCORD_SNOWFLAKE_MAX
    && BigInt(value).toString() === value
}

function compareSnowflakes(left: string, right: string): number {
  const leftId = BigInt(left)
  const rightId = BigInt(right)
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
}

function targetSetDigest(userIds: readonly string[]): string {
  const hash = createHash("sha256")
  hash.update("guildcontrol-bulk-member-role-targets.v1\0")
  for (const userId of userIds) hash.update(userId).update("\0")
  return `sha256:${hash.digest("hex")}`
}

export function normalizeBulkMemberRoleRequest(
  request: BulkMemberRoleRequest,
): NormalizedBulkMemberRoleRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new RangeError("Discord bulk member-role request must be an exact object")
  }
  const record = request as unknown as Record<string, unknown>
  if (
    Object.keys(record).some((key) => !(REQUEST_KEYS as readonly string[]).includes(key))
    || !MEMBER_ROLE_ACTIONS.includes(request.action)
    || typeof request.auditReason !== "string"
    || typeof request.operationKey !== "string"
    || !positiveSnowflake(request.guildId)
    || !positiveSnowflake(request.roleId)
    || !Array.isArray(request.userIds)
    || request.userIds.length < 2
    || request.userIds.length > CONNECTOR_LIMITS.bulkMemberRoleTargets
    || request.userIds.some((userId) => !positiveSnowflake(userId))
    || new Set(request.userIds).size !== request.userIds.length
  ) {
    throw new RangeError(
      `Discord bulk member-role request requires one action, canonical positive guild and role snowflakes, and 2-${CONNECTOR_LIMITS.bulkMemberRoleTargets} unique canonical positive user snowflakes`,
    )
  }
  encodeDiscordAuditReason(request.auditReason)
  const userIds = [...request.userIds].sort(compareSnowflakes)
  return {
    action: request.action,
    auditReason: request.auditReason,
    guildId: request.guildId,
    operationKey: request.operationKey,
    operationKeyHash: operationKeyHash(request.operationKey),
    roleId: request.roleId,
    targetSetDigest: targetSetDigest(userIds),
    userIds,
  }
}

function derivedOperationKey(
  request: NormalizedBulkMemberRoleRequest,
  userId: string,
  purpose: "execute" | "inspect",
): string {
  const digest = createHmac("sha256", request.operationKey)
    .update("guildcontrol-bulk-member-role-child.v1\0")
    .update(purpose)
    .update("\0")
    .update(request.action)
    .update("\0")
    .update(request.guildId)
    .update("\0")
    .update(request.roleId)
    .update("\0")
    .update(userId)
    .digest("hex")
  return `bulk-member-role:${purpose}:${digest}`
}

function childRequest(
  request: NormalizedBulkMemberRoleRequest,
  userId: string,
  purpose: "execute" | "inspect",
): MemberRoleChangeRequest {
  return {
    action: request.action,
    auditReason: request.auditReason,
    guildId: request.guildId,
    operationKey: derivedOperationKey(request, userId, purpose),
    roleId: request.roleId,
    userId,
  }
}

function requestSnapshot(request: NormalizedBulkMemberRoleRequest) {
  return {
    action: request.action,
    auditReason: request.auditReason,
    guildId: request.guildId,
    operationKeyHash: request.operationKeyHash,
    roleId: request.roleId,
    targetSetDigest: request.targetSetDigest,
    userIds: request.userIds,
  }
}

function receiptView(receipt: OperationReceipt | undefined) {
  return receipt
    ? {
        activityId: receipt.activityId,
        error: receipt.error,
        guildId: receipt.guildId,
        operationKeyHash: receipt.operationKeyHash,
        planDigest: receipt.planDigest,
        resourceId: receipt.resourceId,
        status: receipt.status,
        timestamp: receipt.timestamp,
        verification: receipt.verification,
      }
    : null
}

function topReceipt(options: {
  activityId: string
  error?: string | null
  request: NormalizedBulkMemberRoleRequest
  requestDigest: string
  status: OperationReceipt["status"]
  timestamp: string
  verification?: "drift" | "match" | null
}): OperationReceipt {
  return {
    activityId: options.activityId,
    error: options.error ?? null,
    guildId: options.request.guildId,
    kind: "bulk-member-role-change",
    operationKeyHash: options.request.operationKeyHash,
    planDigest: options.requestDigest,
    resourceId: options.status === "completed" ? options.request.roleId : null,
    schemaVersion: 1,
    status: options.status,
    timestamp: options.timestamp,
    verification: options.verification ?? null,
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof DiscordApiError) {
    return `DiscordApiError.${error.status}.${error.code ?? "unknown"}`
  }
  const name = error instanceof Error ? error.name : "UnknownError"
  const normalized = name.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 128)
  return normalized || "UnknownError"
}

function targetCounts(targets: readonly BulkMemberRoleTargetPlan[]) {
  return {
    alreadyCurrent: targets.filter((target) => target.state === "already-current").length,
    completed: targets.filter((target) => target.state === "completed").length,
    ready: targets.filter((target) => target.state === "ready").length,
    total: targets.length,
  }
}

async function withBatchLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const prior = BATCH_LOCKS.get(key) ?? Promise.resolve()
  let release: (() => void) | undefined
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = prior.then(() => current)
  BATCH_LOCKS.set(key, queued)
  await prior
  try {
    return await operation()
  } finally {
    release?.()
    if (BATCH_LOCKS.get(key) === queued) BATCH_LOCKS.delete(key)
  }
}

export class BulkMemberRoleService {
  readonly #clock: () => Date
  readonly #memberRoleService: BulkMemberRoleServiceOptions["memberRoleService"]
  readonly #operationStore: OperationStore
  readonly #planKey: Uint8Array
  readonly #policy: ScopePolicy
  readonly #randomId: () => string

  constructor(options: BulkMemberRoleServiceOptions) {
    this.#clock = options.clock || (() => new Date())
    this.#memberRoleService = options.memberRoleService
    this.#operationStore = options.operationStore
    this.#planKey = options.planKey || createReviewedPlanKey()
    this.#policy = options.policy
    this.#randomId = options.randomId || randomUUID
  }

  #requestDigest(
    applicationId: string,
    botId: string,
    request: NormalizedBulkMemberRoleRequest,
  ): string {
    return reviewedPlanDigest(Buffer.from(request.operationKey, "utf8"), {
      applicationId,
      botId,
      domain: "guildcontrol-bulk-member-role-request.v1",
      request: requestSnapshot(request),
    })
  }

  #assertTopReceipt(
    receipt: OperationReceipt | undefined,
    request: NormalizedBulkMemberRoleRequest,
    requestDigest: string,
  ): void {
    if (!receipt) return
    if (
      receipt.guildId !== request.guildId
      || receipt.operationKeyHash !== request.operationKeyHash
      || receipt.planDigest !== requestDigest
      || receipt.kind !== "bulk-member-role-change"
    ) {
      throw new BulkMemberRoleOperationConflictError(
        "Discord bulk member-role operation key is bound to another exact request or identity",
        receiptView(receipt),
      )
    }
    if (receipt.status === "failed" || receipt.status === "uncertain") {
      throw new BulkMemberRoleOperationConflictError(
        "Discord bulk member-role operation is terminal and cannot be resumed",
        receiptView(receipt),
      )
    }
    if (
      receipt.status === "completed"
      && (
        receipt.resourceId !== request.roleId
        || receipt.verification !== "match"
      )
    ) {
      throw new BulkMemberRoleOperationConflictError(
        "Completed Discord bulk member-role receipt lacks exact verified role evidence",
        receiptView(receipt),
      )
    }
  }

  async #prepareTarget(
    request: NormalizedBulkMemberRoleRequest,
    userId: string,
  ): Promise<PreparedTarget> {
    this.#policy.assertBulkMemberRoleChangeAllowed(
      request.guildId,
      userId,
      request.roleId,
    )
    const executionRequest = childRequest(request, userId, "execute")
    const childOperationKeyHash = operationKeyHash(executionRequest.operationKey)
    const receipt = await this.#operationStore.get(
      "member-role-change",
      childOperationKeyHash,
    )
    const planningRequest = receipt
      ? childRequest(request, userId, "inspect")
      : executionRequest
    return {
      childRequest: executionRequest,
      planningRequest,
      receipt,
      userId,
    }
  }

  #plannedTarget(
    request: NormalizedBulkMemberRoleRequest,
    prepared: PreparedTarget,
    plan: MemberRoleChangePlan,
  ): PlannedTarget {
    const { childRequest, receipt, userId } = prepared
    const childOperationKeyHash = operationKeyHash(childRequest.operationKey)
    let state: BulkMemberRoleTargetState = plan.status === "already-current"
      ? "already-current"
      : "ready"
    if (receipt) {
      if (
        receipt.status !== "completed"
        || receipt.verification !== "match"
        || receipt.guildId !== request.guildId
        || receipt.resourceId !== request.roleId
        || receipt.operationKeyHash !== childOperationKeyHash
        || plan.status !== "already-current"
      ) {
        throw new BulkMemberRoleOperationConflictError(
          `Discord bulk member-role target ${userId} has an incomplete, mismatched, or drifting checkpoint`,
          receiptView(receipt),
          userId,
        )
      }
      state = "completed"
    }
    return {
      childRequest,
      plan,
      receipt,
      target: {
        checkpoint: receipt
          ? {
              activityId: receipt.activityId,
              planDigest: receipt.planDigest,
              timestamp: receipt.timestamp,
            }
          : null,
        childOperationKeyHash,
        highRiskPermissionGains: plan.highRiskPermissionGains,
        impact: plan.impact,
        inspectionPlanDigest: plan.digest,
        member: plan.member,
        permission: {
          targetBelowBot: plan.permission.targetBelowBot,
          targetHighestRoleIds: plan.permission.targetHighestRoleIds,
          targetHighestRolePosition: plan.permission.targetHighestRolePosition,
        },
        state,
        userId,
      },
    }
  }

  async #planNormalized(
    applicationId: string,
    botId: string,
    request: NormalizedBulkMemberRoleRequest,
    options: RequestOptions,
  ): Promise<BulkMemberRolePlan> {
    if (!positiveSnowflake(applicationId) || !positiveSnowflake(botId)) {
      throw new RangeError(
        "Discord bulk member-role planning requires exact application and bot snowflakes",
      )
    }
    const requestDigest = this.#requestDigest(applicationId, botId, request)
    const receipt = await this.#operationStore.get(
      "bulk-member-role-change",
      request.operationKeyHash,
    )
    this.#assertTopReceipt(receipt, request, requestDigest)
    const prepared: PreparedTarget[] = []
    for (const userId of request.userIds) {
      prepared.push(await this.#prepareTarget(request, userId))
    }
    const batch = await this.#memberRoleService.planBatchForBulk(
      BULK_MEMBER_ROLE_AUTHORITY,
      applicationId,
      botId,
      prepared.map((target) => target.planningRequest),
      options,
    )
    const plans = batch.plans
    if (
      plans.length !== prepared.length
      || !REVIEWED_PLAN_DIGEST_PATTERN.test(batch.baselineCommonEvidenceDigest)
    ) {
      throw new BulkMemberRoleEvidenceError(
        "Discord bulk member-role planning returned incomplete target evidence",
      )
    }
    if (plans[0]?.commonEvidenceDigest !== batch.baselineCommonEvidenceDigest) {
      throw new BulkMemberRoleEvidenceError(
        "Discord guild, role, permission, or channel evidence changed while the batch was being planned",
      )
    }
    const planned = prepared.map((target, index) => {
      const plan = plans[index]
      if (!plan) {
        throw new BulkMemberRoleEvidenceError(
          "Discord bulk member-role planning returned incomplete target evidence",
        )
      }
      return this.#plannedTarget(request, target, plan)
    })
    const first = planned[0]
    if (!first) {
      throw new BulkMemberRoleEvidenceError(
        "Discord bulk member-role planning produced no target evidence",
      )
    }
    if (planned.some((entry) => (
      entry.plan.commonEvidenceDigest !== first.plan.commonEvidenceDigest
      || entry.plan.applicationId !== applicationId
      || entry.plan.botId !== botId
      || entry.plan.guild.id !== request.guildId
      || entry.plan.role.id !== request.roleId
      || entry.plan.requestedAction !== request.action
      || entry.plan.member.id !== entry.target.userId
    ))) {
      throw new BulkMemberRoleEvidenceError(
        "Discord guild, role, permission, or channel evidence changed while the batch was being planned",
      )
    }
    const targets = planned.map((entry) => entry.target)
    const counts = targetCounts(targets)
    if (receipt?.status === "completed" && counts.ready > 0) {
      throw new BulkMemberRoleOperationConflictError(
        "Completed Discord bulk member-role receipt does not match live target state",
        receiptView(receipt),
      )
    }
    const executionFrontier = targets
      .filter((target) => target.state === "ready")
      .map((target) => target.userId)
    const verificationBoundary: BulkMemberRolePlan["verificationBoundary"] = {
      automaticRetry: false,
      exactReadbackPerWrite: true,
      maximumWrites: executionFrontier.length,
      rollback: "never",
      sequence: "canonical-user-id",
      stopOnUnsettledTarget: true,
    }
    const digest = reviewedPlanDigest(this.#planKey, {
      applicationId,
      botId,
      commonEvidenceDigest: first.plan.commonEvidenceDigest,
      domain: "guildcontrol-bulk-member-role-plan.v1",
      executionFrontier,
      request: requestSnapshot(request),
      requestDigest,
      targets: planned.map((entry) => ({
        checkpoint: receiptView(entry.receipt),
        childOperationKeyHash: entry.target.childOperationKeyHash,
        livePlanDigest: entry.plan.digest,
        state: entry.target.state,
        target: entry.target,
      })),
      topReceipt: receiptView(receipt),
      verificationBoundary,
    })
    const status: BulkMemberRolePlan["status"] = receipt?.status === "completed"
      ? "completed"
      : receipt?.status === "pending"
        ? "resume-ready"
        : counts.ready > 0
          ? "planned"
          : "already-current"
    return {
      action: request.action,
      applicationId,
      auditReason: request.auditReason,
      botId,
      channelEvidence: first.plan.channelEvidence,
      commonEvidenceDigest: first.plan.commonEvidenceDigest,
      counts,
      createdAt: this.#clock().toISOString(),
      digest,
      executionFrontier: { userIds: executionFrontier },
      guild: first.plan.guild,
      highRiskPermissions: first.plan.highRiskPermissions,
      operation: {
        operationKeyHash: request.operationKeyHash,
        requestDigest,
        status: receipt?.status ?? "unreserved",
      },
      permission: {
        botAdministrator: first.plan.permission.botAdministrator,
        botEffectivePermissionNames: first.plan.permission.botEffectivePermissionNames,
        botEffectivePermissions: first.plan.permission.botEffectivePermissions,
        botHighestRoleIds: first.plan.permission.botHighestRoleIds,
        botHighestRolePosition: first.plan.permission.botHighestRolePosition,
        channelOverwriteUnknownPermissionBits:
          first.plan.permission.channelOverwriteUnknownPermissionBits,
        guildManageRoles: first.plan.permission.guildManageRoles,
        guildRoleUnknownPermissionBits:
          first.plan.permission.guildRoleUnknownPermissionBits,
        roleBelowBot: first.plan.permission.roleBelowBot,
        roleOverwriteUnknownPermissionBits:
          first.plan.permission.roleOverwriteUnknownPermissionBits,
        rolePermissionsSubset: first.plan.permission.rolePermissionsSubset,
      },
      role: first.plan.role,
      schemaVersion: SCHEMA_VERSION,
      status,
      targetCount: targets.length,
      targetSetDigest: request.targetSetDigest,
      targets,
      verificationBoundary,
      warnings: [
        ...(first.plan.permission.botAdministrator
          ? ["Discord connector bot has ADMINISTRATOR; replace it with narrowly scoped MANAGE_ROLES and only the permissions this workflow must grant"]
          : []),
        ...(first.plan.highRiskPermissions.length > 0
          ? [`Selected role contains high-risk permissions: ${first.plan.highRiskPermissions.join(", ")}`]
          : []),
        "Each exact target passed the mandatory single-member authorization, modeled permission, and hierarchy checks",
        "Batch planning requires matching common authority evidence before and after bounded target-member reads",
        "Permission impact covers modeled direct guild channels in continuity-stable layout evidence; each target discloses unsupported coverage and active threads are outside that inventory",
        "Username and guild and role names are transient untrusted Discord content and are never persisted",
        "Targets execute sequentially by canonical user ID with one non-retried exact role endpoint and readback each",
        "The first failed, uncertain, drifting, or incomplete checkpoint stops the batch and no target is rolled back",
        "The parent key and every derived child key are one-shot; resumption requires the original request and fresh review",
        "Write coordination claims the exact role, member collection, and every exact member before the first write",
      ],
    }
  }

  plan(
    applicationId: string,
    botId: string,
    request: BulkMemberRoleRequest,
    options: RequestOptions = {},
  ): Promise<BulkMemberRolePlan> {
    return this.#planNormalized(
      applicationId,
      botId,
      normalizeBulkMemberRoleRequest(request),
      options,
    )
  }

  async #finishTop(
    pending: OperationReceipt,
    request: NormalizedBulkMemberRoleRequest,
    requestDigest: string,
    status: "completed" | "failed" | "uncertain",
    error: string | null,
  ): Promise<void> {
    await this.#operationStore.finish(topReceipt({
      activityId: pending.activityId,
      error,
      request,
      requestDigest,
      status,
      timestamp: this.#clock().toISOString(),
      verification: status === "completed" ? "match" : null,
    }))
  }

  #baseResult(
    request: NormalizedBulkMemberRoleRequest,
    plan: BulkMemberRolePlan,
    activityId: string | null,
    executedTargets: BulkMemberRoleExecutedTarget[],
    remainingUserIds: string[],
  ) {
    return {
      action: request.action,
      activityId,
      executedTargets,
      guildId: request.guildId,
      operationKeyHash: request.operationKeyHash,
      planDigest: plan.digest,
      remainingUserIds,
      requestDigest: plan.operation.requestDigest,
      roleId: request.roleId,
      schemaVersion: SCHEMA_VERSION,
      targetSetDigest: request.targetSetDigest,
    }
  }

  async #executeNormalized(
    applicationId: string,
    botId: string,
    request: NormalizedBulkMemberRoleRequest,
    expectedDigest: string,
    options: RequestOptions,
  ): Promise<BulkMemberRoleResult> {
    let plan: BulkMemberRolePlan
    try {
      plan = await this.#planNormalized(applicationId, botId, request, options)
    } catch (error) {
      if (
        error instanceof BulkMemberRoleEvidenceError
        || error instanceof DiscordApiError && error.status === 404
      ) {
        throw new BulkMemberRolePlanChangedError(expectedDigest, STATE_UNAVAILABLE)
      }
      throw error
    }
    if (plan.digest !== expectedDigest) {
      throw new BulkMemberRolePlanChangedError(expectedDigest, plan.digest)
    }
    if (plan.status === "completed") {
      const receipt = await this.#operationStore.get(
        "bulk-member-role-change",
        request.operationKeyHash,
      )
      return {
        ...this.#baseResult(request, plan, receipt?.activityId ?? null, [], []),
        status: "completed",
      }
    }
    if (plan.status === "already-current") {
      return {
        ...this.#baseResult(request, plan, null, [], []),
        status: "already-current",
      }
    }

    let pending = await this.#operationStore.get(
      "bulk-member-role-change",
      request.operationKeyHash,
    )
    if (!pending) {
      const reservation = await this.#operationStore.reserve(topReceipt({
        activityId: this.#randomId(),
        request,
        requestDigest: plan.operation.requestDigest,
        status: "pending",
        timestamp: this.#clock().toISOString(),
      }))
      pending = reservation.receipt
      if (!reservation.created) {
        this.#assertTopReceipt(pending, request, plan.operation.requestDigest)
      }
    }
    if (pending.status !== "pending") {
      throw new BulkMemberRoleOperationConflictError(
        "Discord bulk member-role operation is not resumable",
        receiptView(pending),
      )
    }

    const planByUserId = new Map(plan.targets.map((target) => [target.userId, target]))
    const executedTargets: BulkMemberRoleExecutedTarget[] = []
    for (const userId of plan.executionFrontier.userIds) {
      const target = planByUserId.get(userId)
      if (!target || target.state !== "ready") {
        throw new BulkMemberRoleExecutionError(
          "Discord bulk member-role execution frontier is internally inconsistent",
          {
            ...this.#baseResult(
              request,
              plan,
              pending.activityId,
              executedTargets,
              plan.executionFrontier.userIds,
            ),
            status: "paused-frontier-invalid",
          },
        )
      }
      const targetRequest = childRequest(request, userId, "execute")
      try {
        const result = await this.#memberRoleService.executeForBulk(
          BULK_MEMBER_ROLE_AUTHORITY,
          applicationId,
          botId,
          targetRequest,
          target.inspectionPlanDigest,
          options,
        )
        executedTargets.push({
          activityId: result.activityId,
          status: result.status,
          userId,
        })
        if (result.status === "completed-with-drift") {
          let topRecordError: string | null = null
          try {
            await this.#finishTop(
              pending,
              request,
              plan.operation.requestDigest,
              "uncertain",
              "BulkMemberRoleTargetDrift",
            )
          } catch (error) {
            topRecordError = safeErrorCode(error)
          }
          throw new BulkMemberRoleExecutionError(
            "Discord bulk member-role execution stopped after target readback drift",
            {
              ...this.#baseResult(
                request,
                plan,
                pending.activityId,
                executedTargets,
                plan.executionFrontier.userIds.filter((id) => id !== userId),
              ),
              status: "uncertain",
              topRecordError,
              userId,
            },
          )
        }
      } catch (error) {
        if (error instanceof BulkMemberRoleExecutionError) throw error
        const childOperationKeyHash = operationKeyHash(targetRequest.operationKey)
        const childReceipt = await this.#operationStore.get(
          "member-role-change",
          childOperationKeyHash,
        )
        const remainingUserIds = plan.executionFrontier.userIds.filter(
          (candidate) => !executedTargets.some((entry) => entry.userId === candidate),
        )
        if (!childReceipt || (
          childReceipt.status === "completed"
          && childReceipt.verification === "match"
          && childReceipt.resourceId === request.roleId
        )) {
          return {
            ...this.#baseResult(
              request,
              plan,
              pending.activityId,
              executedTargets,
              remainingUserIds,
            ),
            status: "paused",
          }
        }
        const terminalStatus = childReceipt.status === "failed" ? "failed" : "uncertain"
        let topRecordError: string | null = null
        try {
          await this.#finishTop(
            pending,
            request,
            plan.operation.requestDigest,
            terminalStatus,
            safeErrorCode(error),
          )
        } catch (recordError) {
          topRecordError = safeErrorCode(recordError)
        }
        throw new BulkMemberRoleExecutionError(
          "Discord bulk member-role execution stopped after an unsettled target",
          {
            ...this.#baseResult(
              request,
              plan,
              pending.activityId,
              executedTargets,
              remainingUserIds,
            ),
            childReceipt: receiptView(childReceipt),
            error: safeErrorCode(error),
            status: terminalStatus,
            topRecordError,
            userId,
          },
          { cause: error },
        )
      }
    }

    let refreshed: BulkMemberRolePlan
    try {
      refreshed = await this.#planNormalized(applicationId, botId, request, options)
    } catch (error) {
      if (error instanceof BulkMemberRoleOperationConflictError) {
        let topRecordError: string | null = null
        try {
          await this.#finishTop(
            pending,
            request,
            plan.operation.requestDigest,
            "uncertain",
            "BulkMemberRoleCheckpointConflict",
          )
        } catch (recordError) {
          topRecordError = safeErrorCode(recordError)
        }
        throw new BulkMemberRoleExecutionError(
          "Discord bulk member-role execution stopped after final checkpoint drift",
          {
            ...this.#baseResult(
              request,
              plan,
              pending.activityId,
              executedTargets,
              error.userId ? [error.userId] : [],
            ),
            checkpointReceipt: error.receipt,
            status: "uncertain",
            topRecordError,
            userId: error.userId,
          },
          { cause: error },
        )
      }
      return {
        ...this.#baseResult(
          request,
          plan,
          pending.activityId,
          executedTargets,
          request.userIds.filter(
            (userId) => !executedTargets.some((entry) => entry.userId === userId),
          ),
        ),
        status: "paused",
      }
    }
    if (refreshed.counts.ready > 0) {
      return {
        ...this.#baseResult(
          request,
          plan,
          pending.activityId,
          executedTargets,
          refreshed.executionFrontier.userIds,
        ),
        status: "paused",
      }
    }
    try {
      await this.#finishTop(
        pending,
        request,
        plan.operation.requestDigest,
        "completed",
        null,
      )
    } catch (error) {
      throw new BulkMemberRoleExecutionError(
        "Discord bulk member-role execution completed but the parent receipt failed",
        {
          ...this.#baseResult(
            request,
            plan,
            pending.activityId,
            executedTargets,
            [],
          ),
          error: safeErrorCode(error),
          status: "completed-operation-record-failed",
        },
        { cause: error },
      )
    }
    return {
      ...this.#baseResult(
        request,
        plan,
        pending.activityId,
        executedTargets,
        [],
      ),
      status: "completed",
    }
  }

  async execute(
    applicationId: string,
    botId: string,
    requestValue: BulkMemberRoleRequest,
    expectedDigest: string,
    options: RequestOptions = {},
  ): Promise<BulkMemberRoleResult> {
    if (!REVIEWED_PLAN_DIGEST_PATTERN.test(expectedDigest)) {
      throw new RangeError("Discord bulk member-role plan digest is invalid")
    }
    const request = normalizeBulkMemberRoleRequest(requestValue)
    return withBatchLock(
      `${request.guildId}\0${request.operationKeyHash}`,
      () => this.#executeNormalized(
        applicationId,
        botId,
        request,
        expectedDigest,
        options,
      ),
    )
  }
}
