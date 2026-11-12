import { randomUUID } from "node:crypto"

import type {
  ActivityStore,
  MemberRoleActivity,
  MemberRoleActivityStatus,
} from "./activity-log.js"
import {
  assertBulkMemberRoleAuthority,
  type BulkMemberRoleAuthority,
} from "./bulk-member-role-authority.js"
import {
  CONNECTOR_LIMITS,
  DISCORD_CHANNEL_TYPES,
  DISCORD_LIMITS,
  DISCORD_SNOWFLAKE_MAX,
  DISCORD_SNOWFLAKE_PATTERN,
  MEMBER_DIRECTORY_LIMITS,
  MEMBER_ROLE_ACTIONS,
  SCHEMA_VERSION,
  type MemberRoleAction,
} from "./constants.js"
import {
  encodeDiscordAuditReason,
  type DiscordClient,
} from "./discord-client.js"
import {
  DiscordApiError,
  MemberRoleExecutionError,
  MemberRoleOperationConflictError,
  MemberRolePlanChangedError,
  errorMessage,
} from "./errors.js"
import type { GatewayChannelLayoutSource } from "./gateway-channel-layout.js"
import {
  collectGuildChannelEvidence,
  DIRECT_GUILD_CHANNEL_TYPES,
  GuildChannelEvidenceError,
  reconcileGuildChannelHttpEvidence,
  type GuildChannelEvidenceView,
} from "./guild-channel-evidence.js"
import { isGuildChannelTopologyType } from "./guild-channel-types.js"
import {
  guildChannelAnalysisCoverage,
  hasHiddenModeledChannel,
  type GuildChannelAnalysisCoverage,
} from "./guild-channel-coverage.js"
import {
  type OperationReceipt,
  type OperationStore,
  operationKeyHash,
} from "./operation-store.js"
import {
  ALL_KNOWN_PERMISSION_BITS,
  DISCORD_CHANNEL_PERMISSION_NAMES,
  DISCORD_PERMISSION_NAMES,
  DISCORD_PERMISSIONS,
  discordPermissionNames,
  evaluateGuildMemberPermissions,
  evaluatePrincipalPermissions,
  hasGuildPermission,
  parseDiscordPermissionBits,
  unknownDiscordPermissionBits,
  type DiscordPermissionName,
  type GuildMemberPermissionResult,
  type PrincipalPermissionResult,
} from "./permissions.js"
import type { ScopePolicy } from "./policy.js"
import {
  createReviewedPlanKey,
  REVIEWED_PLAN_DIGEST_PATTERN,
  reviewedPlanDigest,
} from "./reviewed-plan.js"
import {
  normalizeDiscordRoleInventory,
  ROLE_CREATION_HIGH_RISK_PERMISSIONS,
  type NormalizedDiscordRole,
} from "./role-administration-service.js"
import type {
  DiscordChannel,
  DiscordGuild,
  DiscordGuildMember,
  DiscordPermissionOverwrite,
  DiscordRole,
  RequestOptions,
} from "./types.js"

const STATE_UNAVAILABLE = "member-role-state-unavailable"
const MEMBER_ROLE_LOCKS = new Map<string, Promise<MemberRoleTargetOutcome>>()
const MEMBER_ROLE_HIGH_RISK_PERMISSIONS = Object.freeze([
  "ADMINISTRATOR",
  ...ROLE_CREATION_HIGH_RISK_PERMISSIONS,
] satisfies readonly DiscordPermissionName[])
const HIGH_RISK_PERMISSION_SET = new Set<DiscordPermissionName>(
  MEMBER_ROLE_HIGH_RISK_PERMISSIONS,
)
const CHANNEL_PERMISSION_MASK = DISCORD_CHANNEL_PERMISSION_NAMES.reduce(
  (mask, permission) => mask | DISCORD_PERMISSIONS[permission],
  0n,
)
const MEMBER_TEXT_CONTROL_PATTERN = /[\u0000-\u001F\u007F]/u

export const MEMBER_ROLE_IMPACT_PERMISSIONS = Object.freeze([
  ...DISCORD_CHANNEL_PERMISSION_NAMES,
])

export type MemberRolePermissionDecision = "allowed" | "denied" | "ineffective"

export interface MemberRoleChangeRequest {
  action: MemberRoleAction
  auditReason: string
  guildId: string
  operationKey: string
  roleId: string
  userId: string
}

export interface NormalizedMemberRoleChangeRequest {
  action: MemberRoleAction
  auditReason: string
  guildId: string
  operationKey: string
  operationKeyHash: string
  roleId: string
  userId: string
}

export interface MemberRolePermissionChange {
  after: MemberRolePermissionDecision
  before: MemberRolePermissionDecision
  permission: DiscordPermissionName
}

export interface MemberRoleChannelImpact {
  channelId: string
  channelType: number
  changes: MemberRolePermissionChange[]
}

export interface MemberRoleGuildPermissionImpact {
  added: DiscordPermissionName[]
  after: DiscordPermissionName[]
  before: DiscordPermissionName[]
  removed: DiscordPermissionName[]
}

export interface MemberRoleChangePlan {
  action: MemberRoleAction | "none"
  applicationId: string
  auditReason: string
  botId: string
  channelEvidence: GuildChannelEvidenceView
  commonEvidenceDigest: string
  createdAt: string
  digest: string
  guild: {
    id: string
    name: string
    ownerId: string
  }
  highRiskPermissions: DiscordPermissionName[]
  highRiskPermissionGains: DiscordPermissionName[]
  impact: {
    coverage: GuildChannelAnalysisCoverage
    changedChannels: number
    channels: MemberRoleChannelImpact[]
    evaluatedChannels: number
    guildPermissions: MemberRoleGuildPermissionImpact
    permissions: DiscordPermissionName[]
  }
  member: {
    afterRoleIds: string[]
    beforeRoleIds: string[]
    id: string
    username: string
  }
  operationKeyHash: string
  permission: {
    botAdministrator: boolean
    botEffectivePermissionNames: DiscordPermissionName[]
    botEffectivePermissions: string
    botHighestRoleIds: string[]
    botHighestRolePosition: number
    channelPermissionEscalationSubset: boolean | null
    channelOverwriteUnknownPermissionBits: string
    guildRoleUnknownPermissionBits: string
    guildManageRoles: boolean
    roleBelowBot: boolean
    roleOverwriteUnknownPermissionBits: string
    rolePermissionsSubset: boolean
    targetBelowBot: boolean
    targetHighestRoleIds: string[]
    targetHighestRolePosition: number
  }
  requestedAction: MemberRoleAction
  role: NormalizedDiscordRole
  schemaVersion: number
  status: "already-current" | "planned"
  warnings: string[]
}

export interface MemberRoleChangeResult {
  action: MemberRoleAction
  activityId: string | null
  guildId: string
  observedRoleIds: string[]
  operationKeyHash: string
  planDigest: string
  roleId: string
  rolePresent: boolean
  roleSnapshotMatched: boolean
  schemaVersion: number
  status: "already-current" | "completed" | "completed-with-drift"
  userId: string
}

export interface MemberRoleBatchPlanningResult {
  baselineCommonEvidenceDigest: string
  plans: MemberRoleChangePlan[]
}

export interface MemberRoleServiceOptions {
  activityStore: ActivityStore
  client: Pick<
    DiscordClient,
    | "addGuildMemberRole"
    | "getGuild"
    | "getGuildChannels"
    | "getGuildMember"
    | "getGuildRoles"
    | "removeGuildMemberRole"
  >
  clock?: () => Date
  layoutSource: GatewayChannelLayoutSource
  operationStore: OperationStore
  planKey?: Uint8Array
  policy: ScopePolicy
  randomId?: () => string
}

interface MemberRoleState {
  channelCoverage: GuildChannelAnalysisCoverage
  afterMember: DiscordGuildMember
  afterPermissions: GuildMemberPermissionResult
  beforePermissions: GuildMemberPermissionResult
  botMember: DiscordGuildMember
  botPermissions: GuildMemberPermissionResult
  channelOverwriteUnknownPermissionBits: bigint
  channelEvidence: GuildChannelEvidenceView
  channels: DirectGuildChannel[]
  guild: DiscordGuild & { owner_id: string }
  guildRoleUnknownPermissionBits: bigint
  impact: MemberRoleChannelImpact[]
  roles: NormalizedDiscordRole[]
  rawRoles: DiscordRole[]
  roleOverwriteUnknownPermissionBits: bigint
  rolePermissionsSubset: boolean
  selectedRole: NormalizedDiscordRole
  targetMember: DiscordGuildMember & { user: NonNullable<DiscordGuildMember["user"]> }
}

interface MemberRoleCommonDiscordEvidence {
  botMember: DiscordGuildMember
  channels: DiscordChannel[]
  guild: DiscordGuild
  roles: DiscordRole[]
}

interface MemberRoleCommonRawEvidence extends MemberRoleCommonDiscordEvidence {
  channelCoverage: GuildChannelAnalysisCoverage
  channelEvidence: GuildChannelEvidenceView
}

interface MemberRoleRawEvidence extends MemberRoleCommonRawEvidence {
  targetMember: DiscordGuildMember
}

interface MemberRoleRawEvidenceCollection {
  baseline: MemberRoleRawEvidence[] | null
  current: MemberRoleRawEvidence[]
}

type DirectGuildChannel = DiscordChannel & {
  guild_id: string
  permission_overwrites: DiscordPermissionOverwrite[]
}

type MemberRoleTargetOutcome = "settled" | "uncertain"
type MemberRoleAuthority = "bulk" | "direct"

class MemberRoleStateError extends Error {
  override name = "MemberRoleStateError"
}

function compareSnowflakes(left: string, right: string): number {
  const leftId = BigInt(left)
  const rightId = BigInt(right)
  if (leftId === rightId) return 0
  return leftId < rightId ? -1 : 1
}

function canonicalRoleIds(roleIds: readonly string[]): string[] {
  return [...roleIds].sort(compareSnowflakes)
}

function sameRoleIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((roleId, index) => roleId === right[index])
}

function positiveSnowflake(value: unknown): value is string {
  return typeof value === "string"
    && DISCORD_SNOWFLAKE_PATTERN.test(value)
    && BigInt(value) >= 1n
    && BigInt(value) <= DISCORD_SNOWFLAKE_MAX
}

export function normalizeMemberRoleChangeRequest(
  request: MemberRoleChangeRequest,
): NormalizedMemberRoleChangeRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new RangeError("Discord member-role change request must be an object")
  }
  if (!MEMBER_ROLE_ACTIONS.includes(request.action)) {
    throw new RangeError("Discord member-role action must be add or remove")
  }
  for (const [name, value] of [
    ["guild", request.guildId],
    ["role", request.roleId],
    ["user", request.userId],
  ] as const) {
    if (!positiveSnowflake(value)) {
      throw new RangeError(`Discord member-role change requires an exact ${name} snowflake`)
    }
  }
  if (typeof request.auditReason !== "string") {
    throw new RangeError("Discord member-role audit reason must be a string")
  }
  encodeDiscordAuditReason(request.auditReason)
  return {
    action: request.action,
    auditReason: request.auditReason,
    guildId: request.guildId,
    operationKey: request.operationKey,
    operationKeyHash: operationKeyHash(request.operationKey),
    roleId: request.roleId,
    userId: request.userId,
  }
}

function exactGuild(
  guild: DiscordGuild,
  guildId: string,
): DiscordGuild & { owner_id: string } {
  if (
    !guild
    || typeof guild !== "object"
    || Array.isArray(guild)
    || guild.id !== guildId
    || typeof guild.name !== "string"
    || guild.name.length < 1
    || !positiveSnowflake(guild.owner_id)
  ) {
    throw new MemberRoleStateError(
      "Discord returned incomplete or mismatched member-role guild evidence",
    )
  }
  return guild as DiscordGuild & { owner_id: string }
}

function exactMember(
  member: DiscordGuildMember,
  guildId: string,
  userId: string,
  description: string,
): DiscordGuildMember & { user: NonNullable<DiscordGuildMember["user"]> } {
  if (
    !member
    || typeof member !== "object"
    || Array.isArray(member)
    || !member.user
    || member.user.id !== userId
    || typeof member.user.username !== "string"
    || member.user.username.length < 1
    || member.user.username.length > MEMBER_DIRECTORY_LIMITS.nameCharacters
    || MEMBER_TEXT_CONTROL_PATTERN.test(member.user.username)
    || !Array.isArray(member.roles)
    || member.roles.length > DISCORD_LIMITS.guildRoles
    || member.roles.some((roleId) => !positiveSnowflake(roleId))
    || member.roles.includes(guildId)
    || new Set(member.roles).size !== member.roles.length
    || (member.pending !== undefined && typeof member.pending !== "boolean")
    || !validTimeout(member.communication_disabled_until)
  ) {
    throw new MemberRoleStateError(
      `Discord returned incomplete or mismatched ${description} member evidence`,
    )
  }
  try {
    encodeURIComponent(member.user.username)
  } catch (error) {
    throw new MemberRoleStateError(
      `Discord returned invalid Unicode in ${description} member evidence`,
      { cause: error },
    )
  }
  return member as DiscordGuildMember & {
    user: NonNullable<DiscordGuildMember["user"]>
  }
}

function validTimeout(value: unknown): boolean {
  return value === undefined
    || value === null
    || (typeof value === "string" && Number.isFinite(Date.parse(value)))
}

function timeoutActive(member: DiscordGuildMember, now: Date): boolean {
  const value = member.communication_disabled_until
  return typeof value === "string" && Date.parse(value) > now.getTime()
}

function canonicalOverwrites(
  channel: DiscordChannel,
): Array<{ allow: bigint; deny: bigint; id: string; type: 0 | 1 }> {
  if (
    !Array.isArray(channel.permission_overwrites)
    || channel.permission_overwrites.length
      > DISCORD_LIMITS.channelPermissionOverwrites
  ) {
    throw new MemberRoleStateError(
      "Discord member-role impact requires complete bounded channel overwrite evidence",
    )
  }
  const seen = new Set<string>()
  const result = channel.permission_overwrites.map((value) => {
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || typeof value.id !== "string"
      || !positiveSnowflake(value.id)
      || (value.type !== 0 && value.type !== 1)
      || typeof value.allow !== "string"
      || typeof value.deny !== "string"
    ) {
      throw new MemberRoleStateError(
        "Discord returned invalid member-role channel overwrite evidence",
      )
    }
    const key = `${value.type}\0${value.id}`
    if (seen.has(key)) {
      throw new MemberRoleStateError(
        "Discord returned duplicate member-role channel overwrite evidence",
      )
    }
    seen.add(key)
    let allow: bigint
    let deny: bigint
    try {
      allow = parseDiscordPermissionBits(
        value.allow,
        `channel ${channel.id} overwrite ${value.id} allow`,
      )
      deny = parseDiscordPermissionBits(
        value.deny,
        `channel ${channel.id} overwrite ${value.id} deny`,
      )
    } catch (error) {
      throw new MemberRoleStateError(errorMessage(error), { cause: error })
    }
    if ((allow & deny) !== 0n) {
      throw new MemberRoleStateError(
        `Discord returned overlapping member-role overwrite bits for ${value.id}`,
      )
    }
    if (((allow | deny) & ALL_KNOWN_PERMISSION_BITS & ~CHANNEL_PERMISSION_MASK) !== 0n) {
      throw new MemberRoleStateError(
        "Discord member-role channel overwrite contains known permissions that are not channel-scoped",
      )
    }
    return { allow, deny, id: value.id, type: value.type as 0 | 1 }
  })
  return result.sort((left, right) => (
    compareSnowflakes(left.id, right.id) || left.type - right.type
  ))
}

function exactChannels(
  channels: DiscordChannel[],
  guildId: string,
  roleIds: ReadonlySet<string>,
): DirectGuildChannel[] {
  if (!Array.isArray(channels) || channels.length > DISCORD_LIMITS.guildChannels) {
    throw new MemberRoleStateError(
      "Discord returned an invalid bounded member-role channel inventory",
    )
  }
  const ids = new Set<string>()
  const result = channels.map((channel) => {
    if (
      !channel
      || typeof channel !== "object"
      || Array.isArray(channel)
      || typeof channel.id !== "string"
      || !positiveSnowflake(channel.id)
      || ids.has(channel.id)
      || !Number.isSafeInteger(channel.type)
      || !isGuildChannelTopologyType(channel.type)
      || !Number.isSafeInteger(channel.position)
      || (channel.position as number) < 0
      || channel.guild_id !== guildId
      || (
        channel.parent_id !== undefined
        && channel.parent_id !== null
        && !positiveSnowflake(channel.parent_id)
      )
    ) {
      throw new MemberRoleStateError(
        "Discord returned incomplete or mismatched member-role channel evidence",
      )
    }
    ids.add(channel.id)
    if (DIRECT_GUILD_CHANNEL_TYPES.has(channel.type)) canonicalOverwrites(channel)
    return channel
  })
  const channelsById = new Map(result.map((channel) => [channel.id, channel]))
  for (const channel of result) {
    if (channel.type === DISCORD_CHANNEL_TYPES.category && channel.parent_id) {
      throw new MemberRoleStateError(
        "Discord returned a parented category in member-role channel evidence",
      )
    }
    if (channel.parent_id) {
      const parent = channelsById.get(channel.parent_id)
      if (!parent || parent.type !== DISCORD_CHANNEL_TYPES.category) {
        throw new MemberRoleStateError(
          "Discord returned an unresolved member-role channel parent",
        )
      }
    }
    if (!DIRECT_GUILD_CHANNEL_TYPES.has(channel.type)) continue
    for (const overwrite of canonicalOverwrites(channel)) {
      if (overwrite.type === 0 && !roleIds.has(overwrite.id)) {
        throw new MemberRoleStateError(
          "Discord returned an unresolved member-role channel role overwrite",
        )
      }
    }
  }
  return result
    .filter((channel) => DIRECT_GUILD_CHANNEL_TYPES.has(channel.type))
    .sort((left, right) => compareSnowflakes(left.id, right.id)) as DirectGuildChannel[]
}

function assertCompletePermissions(
  result: GuildMemberPermissionResult,
  description: string,
): void {
  if (!result.complete) {
    throw new MemberRoleStateError(
      `${description} permission evidence is incomplete: ${result.warnings.join("; ")}`,
    )
  }
}

function permissionDecision(
  result: PrincipalPermissionResult,
  permission: DiscordPermissionName,
): MemberRolePermissionDecision {
  if (result.missingPermissions.includes(permission)) return "denied"
  if (result.ineffectivePermissions.includes(permission)) return "ineffective"
  return "allowed"
}

function channelImpact(
  guild: DiscordGuild & { owner_id: string },
  memberBefore: DiscordGuildMember,
  memberAfter: DiscordGuildMember,
  roles: readonly DiscordRole[],
  channels: readonly DirectGuildChannel[],
  now: Date,
): MemberRoleChannelImpact[] {
  const impact: MemberRoleChannelImpact[] = []
  for (const channel of channels) {
    let before: PrincipalPermissionResult
    let after: PrincipalPermissionResult
    try {
      before = evaluatePrincipalPermissions({
        channel,
        guildId: guild.id,
        guildOwnerId: guild.owner_id,
        now,
        permissionChannel: channel,
        requestedPermissions: MEMBER_ROLE_IMPACT_PERMISSIONS,
        roles,
        subject: {
          id: memberBefore.user?.id as string,
          kind: "member",
          member: memberBefore,
        },
      })
      after = evaluatePrincipalPermissions({
        channel,
        guildId: guild.id,
        guildOwnerId: guild.owner_id,
        now,
        permissionChannel: channel,
        requestedPermissions: MEMBER_ROLE_IMPACT_PERMISSIONS,
        roles,
        subject: {
          id: memberAfter.user?.id as string,
          kind: "member",
          member: memberAfter,
        },
      })
    } catch (error) {
      throw new MemberRoleStateError(
        `Discord member-role channel impact evidence is invalid: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    if (before.confidence !== "complete" || after.confidence !== "complete") {
      throw new MemberRoleStateError(
        `Discord member-role channel impact is incomplete for channel ${channel.id}`,
      )
    }
    const changes = MEMBER_ROLE_IMPACT_PERMISSIONS.flatMap((permission) => {
      const beforeDecision = permissionDecision(before, permission)
      const afterDecision = permissionDecision(after, permission)
      return beforeDecision === afterDecision
        ? []
        : [{ after: afterDecision, before: beforeDecision, permission }]
    })
    if (changes.length > 0) {
      impact.push({
        channelId: channel.id,
        channelType: channel.type,
        changes,
      })
    }
  }
  if (impact.length > CONNECTOR_LIMITS.memberRoleImpactChannels) {
    throw new MemberRoleStateError(
      `Discord member-role change affects more than ${CONNECTOR_LIMITS.memberRoleImpactChannels} direct channels`,
    )
  }
  return impact
}

function assertChannelPermissionEscalationSubset(
  guild: DiscordGuild & { owner_id: string },
  botMember: DiscordGuildMember,
  roles: readonly DiscordRole[],
  channels: readonly DirectGuildChannel[],
  impact: readonly MemberRoleChannelImpact[],
  selectedRoleId: string,
  now: Date,
): void {
  const impactByChannelId = new Map(impact.map((entry) => [entry.channelId, entry]))
  for (const channel of channels) {
    const channelImpact = impactByChannelId.get(channel.id)
    const selectedOverwrite = canonicalOverwrites(channel).find((overwrite) => (
      overwrite.type === 0 && overwrite.id === selectedRoleId
    ))
    const selectedAllowNames = discordPermissionNames(selectedOverwrite?.allow ?? 0n)
    const effectiveGains = channelImpact?.changes.filter((change) => (
      change.before !== "allowed" && change.after === "allowed"
    )) ?? []
    if (selectedAllowNames.length === 0 && effectiveGains.length === 0) continue
    let botPermissions: PrincipalPermissionResult
    try {
      botPermissions = evaluatePrincipalPermissions({
        channel,
        guildId: guild.id,
        guildOwnerId: guild.owner_id,
        now,
        permissionChannel: channel,
        requestedPermissions: MEMBER_ROLE_IMPACT_PERMISSIONS,
        roles,
        subject: {
          id: botMember.user?.id as string,
          kind: "member",
          member: botMember,
        },
      })
    } catch (error) {
      throw new MemberRoleStateError(
        `Discord connector bot channel permission evidence is invalid: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    if (botPermissions.confidence !== "complete") {
      throw new MemberRoleStateError(
        `Discord connector bot channel permission evidence is incomplete for channel ${channel.id}`,
      )
    }
    for (const permission of selectedAllowNames) {
      if (permissionDecision(botPermissions, permission) === "allowed") continue
      throw new MemberRoleStateError(
        `Discord connector bot cannot grant channel permission ${permission} in channel ${channel.id}`,
      )
    }
    for (const change of effectiveGains) {
      if (permissionDecision(botPermissions, change.permission) === "allowed") continue
      throw new MemberRoleStateError(
        `Discord connector bot cannot grant channel permission ${change.permission} in channel ${channel.id}`,
      )
    }
  }
}

function selectedRoleOverwriteUnknownBits(
  channels: readonly DirectGuildChannel[],
  roleId: string,
): bigint {
  let unknown = 0n
  for (const channel of channels) {
    for (const overwrite of canonicalOverwrites(channel)) {
      if (overwrite.type !== 0 || overwrite.id !== roleId) continue
      unknown |= unknownDiscordPermissionBits(overwrite.allow | overwrite.deny)
    }
  }
  return unknown
}

function roleInventoryUnknownBits(
  roles: readonly NormalizedDiscordRole[],
): bigint {
  return roles.reduce(
    (unknown, role) => unknown | BigInt(role.unknownPermissionBits),
    0n,
  )
}

function channelOverwriteUnknownBits(
  channels: readonly DirectGuildChannel[],
): bigint {
  let unknown = 0n
  for (const channel of channels) {
    for (const overwrite of canonicalOverwrites(channel)) {
      unknown |= unknownDiscordPermissionBits(overwrite.allow | overwrite.deny)
    }
  }
  return unknown
}

function effectiveGuildPermissionNames(
  result: GuildMemberPermissionResult,
): DiscordPermissionName[] {
  return result.administrator
    ? [...DISCORD_PERMISSION_NAMES]
    : [...result.effectivePermissionNames]
}

function guildPermissionImpact(
  before: GuildMemberPermissionResult,
  after: GuildMemberPermissionResult,
): MemberRoleGuildPermissionImpact {
  const beforeNames = effectiveGuildPermissionNames(before)
  const afterNames = effectiveGuildPermissionNames(after)
  const beforeSet = new Set(beforeNames)
  const afterSet = new Set(afterNames)
  return {
    added: afterNames.filter((permission) => !beforeSet.has(permission)),
    after: afterNames,
    before: beforeNames,
    removed: beforeNames.filter((permission) => !afterSet.has(permission)),
  }
}

function highRiskPermissionGains(
  guildPermissions: MemberRoleGuildPermissionImpact,
  channels: readonly MemberRoleChannelImpact[],
): DiscordPermissionName[] {
  const gained = new Set<DiscordPermissionName>(guildPermissions.added)
  for (const channel of channels) {
    for (const change of channel.changes) {
      if (change.before !== "allowed" && change.after === "allowed") {
        gained.add(change.permission)
      }
    }
  }
  return DISCORD_PERMISSION_NAMES.filter((permission) => (
    gained.has(permission) && HIGH_RISK_PERMISSION_SET.has(permission)
  ))
}

function roleSnapshot(roles: readonly NormalizedDiscordRole[]) {
  return [...roles]
    .sort((left, right) => compareSnowflakes(left.id, right.id))
    .map((role) => ({
      id: role.id,
      managed: role.managed,
      management: role.management,
      name: role.name,
      permissions: role.permissions,
      position: role.position,
    }))
}

function channelSnapshot(channels: readonly DirectGuildChannel[]) {
  return channels.map((channel) => ({
    id: channel.id,
    overwrites: canonicalOverwrites(channel).map((overwrite) => ({
      allow: overwrite.allow.toString(),
      deny: overwrite.deny.toString(),
      id: overwrite.id,
      type: overwrite.type,
    })),
    parentId: channel.parent_id ?? null,
    type: channel.type,
  }))
}

function targetLockKey(request: NormalizedMemberRoleChangeRequest): string {
  return `${request.guildId}\0${request.userId}`
}

function uncertainExecution(error: unknown): boolean {
  if (
    !(error instanceof MemberRoleExecutionError)
    || !error.result
    || typeof error.result !== "object"
    || !("status" in error.result)
  ) return false
  return error.result.status === "uncertain"
}

async function withTargetLock<T>(
  key: string,
  operation: () => Promise<T>,
  priorUncertainError: () => MemberRoleExecutionError,
): Promise<T> {
  const prior = MEMBER_ROLE_LOCKS.get(key) ?? Promise.resolve("settled" as const)
  let release: (outcome: MemberRoleTargetOutcome) => void = () => undefined
  const tail = new Promise<MemberRoleTargetOutcome>((resolve) => {
    release = resolve
  })
  MEMBER_ROLE_LOCKS.set(key, tail)
  let outcome: MemberRoleTargetOutcome = "settled"
  try {
    if (await prior === "uncertain") {
      outcome = "uncertain"
      throw priorUncertainError()
    }
    return await operation()
  } catch (error) {
    if (uncertainExecution(error)) outcome = "uncertain"
    throw error
  } finally {
    release(outcome)
    if (MEMBER_ROLE_LOCKS.get(key) === tail) MEMBER_ROLE_LOCKS.delete(key)
  }
}

async function mapInBatches<T, U>(
  values: readonly T[],
  concurrency: number,
  callback: (value: T) => Promise<U>,
): Promise<U[]> {
  const output: U[] = []
  for (let index = 0; index < values.length; index += concurrency) {
    const batch = values.slice(index, index + concurrency)
    const settled = await Promise.allSettled(batch.map(callback))
    const failure = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    if (failure) throw failure.reason
    output.push(...settled.map((result) => (result as PromiseFulfilledResult<U>).value))
  }
  return output
}

function safeErrorCode(error: unknown): string {
  if (error instanceof DiscordApiError) {
    return `DiscordApiError.${error.status}.${error.code ?? "unknown"}`
  }
  const name = error instanceof Error ? error.name : "UnknownError"
  const normalized = name.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 128)
  return normalized || "UnknownError"
}

function receiptView(receipt: OperationReceipt) {
  return {
    activityId: receipt.activityId,
    error: receipt.error,
    guildId: receipt.guildId,
    operationKeyHash: receipt.operationKeyHash,
    roleId: receipt.resourceId,
    status: receipt.status,
    timestamp: receipt.timestamp,
    verification: receipt.verification,
  }
}

function activityEntry(options: {
  activityId: string
  error?: string | null
  plan: MemberRoleChangePlan
  request: NormalizedMemberRoleChangeRequest
  status: MemberRoleActivityStatus
  timestamp: string
  verification?: "drift" | "match" | null
}): MemberRoleActivity {
  return {
    action: options.request.action,
    error: options.error ?? null,
    guildId: options.request.guildId,
    id: options.activityId,
    kind: "member-role-change",
    operationKeyHash: options.request.operationKeyHash,
    planDigest: options.plan.digest,
    roleId: options.request.roleId,
    schemaVersion: SCHEMA_VERSION,
    status: options.status,
    timestamp: options.timestamp,
    userId: options.request.userId,
    verification: options.verification ?? null,
  }
}

function operationReceipt(options: {
  activityId: string
  error?: string | null
  plan: MemberRoleChangePlan
  request: NormalizedMemberRoleChangeRequest
  status: OperationReceipt["status"]
  timestamp: string
  verification?: "drift" | "match" | null
}): OperationReceipt {
  return {
    activityId: options.activityId,
    error: options.error ?? null,
    guildId: options.request.guildId,
    kind: "member-role-change",
    operationKeyHash: options.request.operationKeyHash,
    planDigest: options.plan.digest,
    resourceId: options.status === "pending" || options.status === "failed"
      ? null
      : options.request.roleId,
    schemaVersion: 1,
    status: options.status,
    timestamp: options.timestamp,
    verification: options.verification ?? null,
  }
}

export class MemberRoleService {
  readonly #activityStore: ActivityStore
  readonly #client: MemberRoleServiceOptions["client"]
  readonly #clock: () => Date
  readonly #layoutSource: GatewayChannelLayoutSource
  readonly #operationStore: OperationStore
  readonly #planKey: Uint8Array
  readonly #policy: ScopePolicy
  readonly #randomId: () => string

  constructor(options: MemberRoleServiceOptions) {
    this.#activityStore = options.activityStore
    this.#client = options.client
    this.#clock = options.clock || (() => new Date())
    this.#layoutSource = options.layoutSource
    this.#operationStore = options.operationStore
    this.#planKey = options.planKey || createReviewedPlanKey()
    this.#policy = options.policy
    this.#randomId = options.randomId || randomUUID
  }

  async #assertRequestAvailable(
    botId: string,
    request: NormalizedMemberRoleChangeRequest,
    authority: MemberRoleAuthority,
  ): Promise<void> {
    if (authority === "bulk") {
      this.#policy.assertBulkMemberRoleChangeAllowed(
        request.guildId,
        request.userId,
        request.roleId,
      )
    } else {
      this.#policy.assertMemberRoleChangeAllowed(
        request.guildId,
        request.userId,
        request.roleId,
      )
    }
    if (request.userId === botId) {
      throw new MemberRoleStateError(
        "Discord member-role changes cannot target the connector bot",
      )
    }
    const existingReceipt = await this.#operationStore.get(
      "member-role-change",
      request.operationKeyHash,
    )
    if (existingReceipt) {
      throw new MemberRoleOperationConflictError(receiptView(existingReceipt))
    }
  }

  async #readCommonDiscordEvidence(
    guildId: string,
    botId: string,
    options: RequestOptions,
  ): Promise<MemberRoleCommonDiscordEvidence> {
    const [guild, botMember, roles, channels] = await Promise.all([
      this.#client.getGuild(guildId, options),
      this.#client.getGuildMember(guildId, botId, options),
      this.#client.getGuildRoles(guildId, options),
      this.#client.getGuildChannels(guildId, options),
    ])
    return { botMember, channels, guild, roles }
  }

  async #collectRawEvidence(
    botId: string,
    requests: readonly NormalizedMemberRoleChangeRequest[],
    options: RequestOptions,
    verifyCommonContinuity = false,
  ): Promise<MemberRoleRawEvidenceCollection> {
    const first = requests[0]
    if (!first || requests.some((request) => request.guildId !== first.guildId)) {
      throw new RangeError(
        "Discord member-role evidence requires one nonempty exact guild request set",
      )
    }
    let baselineEvidence: MemberRoleCommonDiscordEvidence | undefined
    let currentEvidence: MemberRoleCommonDiscordEvidence | undefined
    let targetMembers: DiscordGuildMember[] | undefined
    let channelEvidence
    try {
      channelEvidence = await collectGuildChannelEvidence({
        guildId: first.guildId,
        layoutSource: this.#layoutSource,
        readChannels: async () => {
          const readMembers = () => mapInBatches(
            requests,
            CONNECTOR_LIMITS.bulkMemberRoleReadConcurrency,
            (request) => this.#client.getGuildMember(
              first.guildId,
              request.userId,
              options,
            ),
          )
          if (verifyCommonContinuity) {
            baselineEvidence = await this.#readCommonDiscordEvidence(
              first.guildId,
              botId,
              options,
            )
            targetMembers = await readMembers()
            currentEvidence = await this.#readCommonDiscordEvidence(
              first.guildId,
              botId,
              options,
            )
          } else {
            const [common, members] = await Promise.all([
              this.#readCommonDiscordEvidence(first.guildId, botId, options),
              readMembers(),
            ])
            currentEvidence = common
            targetMembers = members
          }
          return currentEvidence.channels
        },
      })
      if (baselineEvidence) {
        // Bulk baseline and current evidence must use the same visibility projection
        baselineEvidence = {
          ...baselineEvidence,
          channels: reconcileGuildChannelHttpEvidence(
            baselineEvidence.channels, first.guildId, channelEvidence.layout,
          ).channels,
        }
      }
    } catch (error) {
      if (error instanceof GuildChannelEvidenceError) {
        throw new MemberRoleStateError(
          `Discord member-role channel evidence is incomplete: ${error.message}`,
          { cause: error },
        )
      }
      throw error
    }
    if (!currentEvidence || !targetMembers || targetMembers.length !== requests.length) {
      throw new MemberRoleStateError("Discord member-role supporting evidence is unavailable")
    }
    if (hasHiddenModeledChannel(channelEvidence.layout.channels)) {
      throw new MemberRoleStateError(
        "Discord member-role changes require complete metadata for every direct guild channel",
      )
    }
    const current: MemberRoleCommonRawEvidence = {
      ...currentEvidence,
      channelCoverage: guildChannelAnalysisCoverage(channelEvidence.layout.channels),
      channelEvidence: channelEvidence.view,
      channels: channelEvidence.channels,
    }
    const baseline: MemberRoleCommonRawEvidence | null = baselineEvidence
      ? {
          ...baselineEvidence,
          channelCoverage: current.channelCoverage,
          channelEvidence: channelEvidence.view,
        }
      : null
    return {
      baseline: baseline
        ? targetMembers.map((targetMember) => ({ ...baseline, targetMember }))
        : null,
      current: targetMembers.map((targetMember) => ({ ...current, targetMember })),
    }
  }

  #stateFromEvidence(
    botId: string,
    request: NormalizedMemberRoleChangeRequest,
    evidence: MemberRoleRawEvidence,
    now: Date,
  ): MemberRoleState {
    const {
      botMember: rawBotMember,
      guild: rawGuild,
      roles: rawRoles,
      targetMember: rawTargetMember,
    } = evidence
    const rawChannels = evidence.channels
    const guild = exactGuild(rawGuild, request.guildId)
    if (request.userId === guild.owner_id) {
      throw new MemberRoleStateError(
        "Discord member-role changes cannot target the guild owner",
      )
    }
    const botMember = exactMember(
      rawBotMember,
      request.guildId,
      botId,
      "connector bot",
    )
    const targetMember = exactMember(
      rawTargetMember,
      request.guildId,
      request.userId,
      "target",
    )
    if (targetMember.pending) {
      throw new MemberRoleStateError(
        "Discord member-role changes cannot target a pending membership-screening member",
      )
    }
    if (timeoutActive(targetMember, now)) {
      throw new MemberRoleStateError(
        "Discord member-role changes cannot target an actively timed-out member because permission impact is temporarily masked",
      )
    }
    let roles: NormalizedDiscordRole[]
    try {
      roles = normalizeDiscordRoleInventory(rawRoles, request.guildId)
    } catch (error) {
      throw new MemberRoleStateError(
        `Discord member-role inventory evidence is invalid: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    if (roles.some((role) => !positiveSnowflake(role.id))) {
      throw new MemberRoleStateError(
        "Discord member-role inventory contains an invalid role snowflake",
      )
    }
    const selectedRole = roles.find((role) => role.id === request.roleId)
    if (!selectedRole) {
      throw new MemberRoleStateError(
        "Discord member-role inventory omitted the exact selected role",
      )
    }
    if (
      selectedRole.management.type !== "standard"
      || selectedRole.managed
      || selectedRole.id === request.guildId
      || selectedRole.position < 1
    ) {
      throw new MemberRoleStateError(
        "Discord member-role changes require a standard non-managed role other than @everyone",
      )
    }
    const channels = exactChannels(
      rawChannels,
      request.guildId,
      new Set(roles.map((role) => role.id)),
    )
    const channelCoverage = evidence.channelCoverage
    let botPermissions: GuildMemberPermissionResult
    let beforePermissions: GuildMemberPermissionResult
    try {
      botPermissions = evaluateGuildMemberPermissions({
        guildId: request.guildId,
        member: botMember,
        roles: rawRoles,
      })
      beforePermissions = evaluateGuildMemberPermissions({
        guildId: request.guildId,
        member: targetMember,
        roles: rawRoles,
      })
    } catch (error) {
      throw new MemberRoleStateError(
        `Discord member-role permission evidence is invalid: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    assertCompletePermissions(botPermissions, "Discord connector bot")
    assertCompletePermissions(beforePermissions, "Discord target member")
    if (botPermissions.highestRoleIds.length !== 1) {
      throw new MemberRoleStateError(
        "Discord connector bot highest-role evidence is ambiguous",
      )
    }
    if (beforePermissions.highestRoleIds.length !== 1) {
      throw new MemberRoleStateError(
        "Discord target member highest-role evidence is ambiguous",
      )
    }
    if (!hasGuildPermission(botPermissions, "MANAGE_ROLES")) {
      throw new MemberRoleStateError(
        "Discord connector bot lacks guild-level MANAGE_ROLES",
      )
    }
    if (botPermissions.highestRolePosition <= selectedRole.position) {
      throw new MemberRoleStateError(
        "Discord selected role must be strictly below the connector bot's highest role",
      )
    }
    if (botPermissions.highestRolePosition <= beforePermissions.highestRolePosition) {
      throw new MemberRoleStateError(
        "Discord target member must be strictly below the connector bot's highest role",
      )
    }

    const beforeRoleIds = canonicalRoleIds(targetMember.roles)
    const afterRoleIds = request.action === "add"
      ? canonicalRoleIds([...new Set([...beforeRoleIds, request.roleId])])
      : beforeRoleIds.filter((roleId) => roleId !== request.roleId)
    const afterMember = { ...targetMember, roles: afterRoleIds }
    let afterPermissions: GuildMemberPermissionResult
    try {
      afterPermissions = evaluateGuildMemberPermissions({
        guildId: request.guildId,
        member: afterMember,
        roles: rawRoles,
      })
    } catch (error) {
      throw new MemberRoleStateError(
        `Discord proposed member-role permission evidence is invalid: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    assertCompletePermissions(afterPermissions, "Discord proposed target member")

    const alreadyCurrent = request.action === "add"
      ? beforeRoleIds.includes(request.roleId)
      : !beforeRoleIds.includes(request.roleId)
    const selectedBits = BigInt(selectedRole.permissions)
    const botBits = BigInt(botPermissions.effectivePermissions)
    const grantable = botPermissions.administrator
      ? botBits | ALL_KNOWN_PERMISSION_BITS
      : botBits
    const rolePermissionsSubset = (selectedBits & ~grantable) === 0n
    const roleOverwriteUnknownPermissionBits = selectedRoleOverwriteUnknownBits(
      channels,
      request.roleId,
    )
    const impact = channelImpact(
      guild,
      targetMember,
      afterMember,
      rawRoles,
      channels,
      now,
    )

    if (request.action === "add" && !alreadyCurrent) {
      if (beforePermissions.administrator) {
        throw new MemberRoleStateError(
          "Discord member-role additions cannot target an existing administrator",
        )
      }
      if ((selectedBits & DISCORD_PERMISSIONS.ADMINISTRATOR) !== 0n) {
        throw new MemberRoleStateError(
          "Discord member-role additions never grant ADMINISTRATOR",
        )
      }
      if (unknownDiscordPermissionBits(selectedBits) !== 0n) {
        throw new MemberRoleStateError(
          "Discord member-role additions cannot apply a role with unknown permission bits",
        )
      }
      if (roleOverwriteUnknownPermissionBits !== 0n) {
        throw new MemberRoleStateError(
          "Discord member-role additions cannot apply unknown selected-role overwrite bits",
        )
      }
      if (!rolePermissionsSubset) {
        throw new MemberRoleStateError(
          `Discord connector bot cannot grant selected-role permissions: ${discordPermissionNames(selectedBits & ~grantable).join(", ")}`,
        )
      }
      assertChannelPermissionEscalationSubset(
        guild,
        botMember,
        rawRoles,
        channels,
        impact,
        request.roleId,
        now,
      )
    }

    return {
      afterMember,
      channelCoverage,
      afterPermissions,
      beforePermissions,
      botMember,
      botPermissions,
      channelEvidence: evidence.channelEvidence,
      channelOverwriteUnknownPermissionBits: channelOverwriteUnknownBits(channels),
      channels,
      guild,
      guildRoleUnknownPermissionBits: roleInventoryUnknownBits(roles),
      impact,
      rawRoles,
      roleOverwriteUnknownPermissionBits,
      rolePermissionsSubset,
      roles,
      selectedRole,
      targetMember,
    }
  }

  async #state(
    botId: string,
    request: NormalizedMemberRoleChangeRequest,
    authority: MemberRoleAuthority,
    options: RequestOptions,
  ): Promise<MemberRoleState> {
    await this.#assertRequestAvailable(botId, request, authority)
    const evidence = (await this.#collectRawEvidence(botId, [request], options)).current[0]
    if (!evidence) {
      throw new MemberRoleStateError("Discord member-role supporting evidence is unavailable")
    }
    return this.#stateFromEvidence(botId, request, evidence, this.#clock())
  }

  #assertPlanningIdentity(applicationId: string, botId: string): void {
    if (!positiveSnowflake(applicationId) || !positiveSnowflake(botId)) {
      throw new RangeError(
        "Discord member-role planning requires exact application and bot snowflakes",
      )
    }
  }

  #commonPlanEvidence(
    applicationId: string,
    botId: string,
    state: MemberRoleState,
  ) {
    return {
      applicationId,
      botId,
      botMember: {
        roles: canonicalRoleIds(state.botMember.roles),
        userId: state.botMember.user?.id ?? null,
      },
      botPermissions: {
        administrator: state.botPermissions.administrator,
        effectivePermissions: state.botPermissions.effectivePermissions,
        highestRoleIds: state.botPermissions.highestRoleIds,
        highestRolePosition: state.botPermissions.highestRolePosition,
      },
      channelEvidence: state.channelEvidence,
      channelCoverage: state.channelCoverage,
      channels: channelSnapshot(state.channels),
      guild: {
        id: state.guild.id,
        name: state.guild.name,
        ownerId: state.guild.owner_id,
      },
      roles: roleSnapshot(state.roles),
    }
  }

  #commonEvidenceDigest(commonEvidence: Record<string, unknown>): string {
    return reviewedPlanDigest(this.#planKey, {
      ...commonEvidence,
      domain: "guildcontrol-member-role-common-evidence.v1",
    })
  }

  #planFromState(
    applicationId: string,
    botId: string,
    request: NormalizedMemberRoleChangeRequest,
    authority: MemberRoleAuthority,
    state: MemberRoleState,
  ): MemberRoleChangePlan {
    const beforeRoleIds = canonicalRoleIds(state.targetMember.roles)
    const afterRoleIds = canonicalRoleIds(state.afterMember.roles)
    const alreadyCurrent = request.action === "add"
      ? beforeRoleIds.includes(request.roleId)
      : !beforeRoleIds.includes(request.roleId)
    const action = alreadyCurrent ? "none" : request.action
    const commonEvidence = this.#commonPlanEvidence(applicationId, botId, state)
    const commonEvidenceDigest = this.#commonEvidenceDigest(commonEvidence)
    const digest = reviewedPlanDigest(this.#planKey, {
      action,
      authority,
      commonEvidence,
      commonEvidenceDigest,
      impact: state.impact,
      localPolicy: {
        authority,
        featureEnabled: true,
        guildAllowed: request.guildId,
        roleAllowed: request.roleId,
        targetProtected: false,
      },
      request: {
        action: request.action,
        auditReason: request.auditReason,
        guildId: request.guildId,
        operationKeyHash: request.operationKeyHash,
        roleId: request.roleId,
        userId: request.userId,
      },
      targetMember: {
        communicationDisabledUntil:
          state.targetMember.communication_disabled_until ?? null,
        pending: state.targetMember.pending ?? false,
        roles: beforeRoleIds,
        userId: state.targetMember.user.id,
        username: state.targetMember.user.username,
      },
      targetPermissions: {
        after: state.afterPermissions.effectivePermissions,
        before: state.beforePermissions.effectivePermissions,
        highestRoleIds: state.beforePermissions.highestRoleIds,
        highestRolePosition: state.beforePermissions.highestRolePosition,
      },
    })
    const highRiskPermissions = state.selectedRole.permissionNames.filter((permission) => (
      HIGH_RISK_PERMISSION_SET.has(permission)
    ))
    const guildPermissions = guildPermissionImpact(
      state.beforePermissions,
      state.afterPermissions,
    )
    const permissionGains = highRiskPermissionGains(
      guildPermissions,
      state.impact,
    )
    return {
      action,
      applicationId,
      auditReason: request.auditReason,
      botId,
      channelEvidence: state.channelEvidence,
      commonEvidenceDigest,
      createdAt: this.#clock().toISOString(),
      digest,
      guild: {
        id: state.guild.id,
        name: state.guild.name,
        ownerId: state.guild.owner_id,
      },
      highRiskPermissions,
      highRiskPermissionGains: permissionGains,
      impact: {
        coverage: state.channelCoverage,
        changedChannels: state.impact.length,
        channels: state.impact,
        evaluatedChannels: state.channels.length,
        guildPermissions,
        permissions: [...MEMBER_ROLE_IMPACT_PERMISSIONS],
      },
      member: {
        afterRoleIds,
        beforeRoleIds,
        id: request.userId,
        username: state.targetMember.user.username,
      },
      operationKeyHash: request.operationKeyHash,
      permission: {
        botAdministrator: state.botPermissions.administrator,
        botEffectivePermissionNames: state.botPermissions.effectivePermissionNames,
        botEffectivePermissions: state.botPermissions.effectivePermissions,
        botHighestRoleIds: state.botPermissions.highestRoleIds,
        botHighestRolePosition: state.botPermissions.highestRolePosition,
        channelPermissionEscalationSubset: state.channelCoverage.status === "complete" ? true : null,
        channelOverwriteUnknownPermissionBits:
          state.channelOverwriteUnknownPermissionBits.toString(),
        guildRoleUnknownPermissionBits:
          state.guildRoleUnknownPermissionBits.toString(),
        guildManageRoles: true,
        roleBelowBot: true,
        roleOverwriteUnknownPermissionBits:
          state.roleOverwriteUnknownPermissionBits.toString(),
        rolePermissionsSubset: state.rolePermissionsSubset,
        targetBelowBot: true,
        targetHighestRoleIds: state.beforePermissions.highestRoleIds,
        targetHighestRolePosition: state.beforePermissions.highestRolePosition,
      },
      requestedAction: request.action,
      role: state.selectedRole,
      schemaVersion: SCHEMA_VERSION,
      status: alreadyCurrent ? "already-current" : "planned",
      warnings: [
        ...(state.botPermissions.administrator
          ? ["Discord connector bot has ADMINISTRATOR; replace it with narrowly scoped MANAGE_ROLES and only the permissions this workflow must grant"]
          : []),
        ...(highRiskPermissions.length > 0
          ? [`Selected role contains high-risk permissions: ${highRiskPermissions.join(", ")}`]
          : []),
        ...(permissionGains.length > 0
          ? [`Member-role change grants high-risk effective permissions: ${permissionGains.join(", ")}`]
          : []),
        ...(state.guildRoleUnknownPermissionBits !== 0n
          ? [`Guild role inventory contains permission bits unknown to this build: ${state.guildRoleUnknownPermissionBits.toString()}`]
          : []),
        ...(state.channelOverwriteUnknownPermissionBits !== 0n
          ? [`Direct-channel overwrite inventory contains permission bits unknown to this build: ${state.channelOverwriteUnknownPermissionBits.toString()}`]
          : []),
        ...(request.action === "remove" && state.selectedRole.unknownPermissionBits !== "0"
          ? [`Removal de-escalates unknown selected-role permission bits: ${state.selectedRole.unknownPermissionBits}`]
          : []),
        ...(request.action === "remove" && state.roleOverwriteUnknownPermissionBits !== 0n
          ? [`Removal de-escalates unknown selected-role overwrite bits: ${state.roleOverwriteUnknownPermissionBits.toString()}`]
          : []),
        ...(request.action === "remove" && !state.rolePermissionsSubset
          ? ["Removal de-escalates selected-role permissions outside the connector bot's effective grantable set"]
          : []),
        ...(alreadyCurrent && state.selectedRole.unknownPermissionBits !== "0"
          ? [`No write is required, but the selected role contains unknown permission bits: ${state.selectedRole.unknownPermissionBits}`]
          : []),
        ...(alreadyCurrent && state.roleOverwriteUnknownPermissionBits !== 0n
          ? [`No write is required, but selected-role overwrites contain unknown permission bits: ${state.roleOverwriteUnknownPermissionBits.toString()}`]
          : []),
        ...(alreadyCurrent && !state.rolePermissionsSubset
          ? ["No write is required, but the selected role contains permissions outside the connector bot's effective grantable set"]
          : []),
        ...(state.channelCoverage.status === "partial"
          ? ["Channel impact and escalation analysis is partial; unsupported channel types are retained in coverage but their effects are not evaluated"]
          : []),
        "Permission impact covers modeled direct guild channels in a continuity-stable Gateway layout; active threads are not included in that inventory",
        "Same-member serialization is process-local; do not run multiple connector processes with overlapping member-role scope",
        "The operation key is one-shot and cannot be retried after reservation, including after an uncertain outcome",
        "This workflow performs one exact role add or remove and never replaces the member's complete role array, retries, or rolls back",
      ],
    }
  }

  async #planNormalized(
    applicationId: string,
    botId: string,
    request: NormalizedMemberRoleChangeRequest,
    authority: MemberRoleAuthority,
    options: RequestOptions,
  ): Promise<MemberRoleChangePlan> {
    this.#assertPlanningIdentity(applicationId, botId)
    const state = await this.#state(botId, request, authority, options)
    return this.#planFromState(applicationId, botId, request, authority, state)
  }

  plan(
    applicationId: string,
    botId: string,
    request: MemberRoleChangeRequest,
    options: RequestOptions = {},
  ): Promise<MemberRoleChangePlan> {
    return this.#planNormalized(
      applicationId,
      botId,
      normalizeMemberRoleChangeRequest(request),
      "direct",
      options,
    )
  }

  async planForBulk(
    authority: BulkMemberRoleAuthority,
    applicationId: string,
    botId: string,
    request: MemberRoleChangeRequest,
    options: RequestOptions = {},
  ): Promise<MemberRoleChangePlan> {
    assertBulkMemberRoleAuthority(authority)
    return this.#planNormalized(
      applicationId,
      botId,
      normalizeMemberRoleChangeRequest(request),
      "bulk",
      options,
    )
  }

  async planBatchForBulk(
    authority: BulkMemberRoleAuthority,
    applicationId: string,
    botId: string,
    requests: readonly MemberRoleChangeRequest[],
    options: RequestOptions = {},
  ): Promise<MemberRoleBatchPlanningResult> {
    assertBulkMemberRoleAuthority(authority)
    this.#assertPlanningIdentity(applicationId, botId)
    const normalized = requests.map(normalizeMemberRoleChangeRequest)
    const first = normalized[0]
    const orderedTargets = normalized.every((request, index) => {
      const previous = normalized[index - 1]
      return index === 0
        || previous !== undefined && compareSnowflakes(previous.userId, request.userId) < 0
    })
    if (
      !first
      || normalized.length < 2
      || normalized.length > CONNECTOR_LIMITS.bulkMemberRoleTargets
      || normalized.some((request) => (
        request.action !== first.action
        || request.auditReason !== first.auditReason
        || request.guildId !== first.guildId
        || request.roleId !== first.roleId
        || BigInt(request.userId).toString() !== request.userId
      ))
      || !orderedTargets
      || new Set(normalized.map((request) => request.userId)).size !== normalized.length
      || new Set(normalized.map((request) => request.operationKeyHash)).size
        !== normalized.length
    ) {
      throw new RangeError(
        `Discord bulk member-role planning requires 2-${CONNECTOR_LIMITS.bulkMemberRoleTargets} strictly ordered unique canonical targets with one exact action, reason, guild, and role`,
      )
    }
    for (const request of normalized) {
      await this.#assertRequestAvailable(botId, request, "bulk")
    }
    const evidence = await this.#collectRawEvidence(
      botId,
      normalized,
      options,
      true,
    )
    const baselineEvidence = evidence.baseline?.[0]
    if (!baselineEvidence) {
      throw new MemberRoleStateError(
        "Discord member-role baseline evidence is unavailable",
      )
    }
    const now = this.#clock()
    const baselineState = this.#stateFromEvidence(
      botId,
      first,
      baselineEvidence,
      now,
    )
    const baselineCommonEvidenceDigest = this.#commonEvidenceDigest(
      this.#commonPlanEvidence(applicationId, botId, baselineState),
    )
    const plans = normalized.map((request, index) => {
      const targetEvidence = evidence.current[index]
      if (!targetEvidence) {
        throw new MemberRoleStateError(
          "Discord member-role supporting evidence is unavailable",
        )
      }
      const state = this.#stateFromEvidence(botId, request, targetEvidence, now)
      return this.#planFromState(
        applicationId,
        botId,
        request,
        "bulk",
        state,
      )
    })
    return { baselineCommonEvidenceDigest, plans }
  }

  async execute(
    applicationId: string,
    botId: string,
    request: MemberRoleChangeRequest,
    expectedDigest: string,
    options: RequestOptions = {},
  ): Promise<MemberRoleChangeResult> {
    const normalized = normalizeMemberRoleChangeRequest(request)
    if (!REVIEWED_PLAN_DIGEST_PATTERN.test(expectedDigest)) {
      throw new RangeError("Discord member-role plan digest is invalid")
    }
    return withTargetLock(
      targetLockKey(normalized),
      () => this.#executeNormalized(
        applicationId,
        botId,
        normalized,
        expectedDigest,
        "direct",
        options,
      ),
      () => new MemberRoleExecutionError(
        "Discord member-role change was blocked because a prior same-member operation ended with an uncertain outcome",
        {
          action: normalized.action,
          guildId: normalized.guildId,
          operationKeyHash: normalized.operationKeyHash,
          planDigest: expectedDigest,
          roleId: normalized.roleId,
          schemaVersion: SCHEMA_VERSION,
          status: "blocked-prior-uncertain",
          userId: normalized.userId,
        },
      ),
    )
  }

  async executeForBulk(
    authority: BulkMemberRoleAuthority,
    applicationId: string,
    botId: string,
    request: MemberRoleChangeRequest,
    expectedDigest: string,
    options: RequestOptions = {},
  ): Promise<MemberRoleChangeResult> {
    assertBulkMemberRoleAuthority(authority)
    const normalized = normalizeMemberRoleChangeRequest(request)
    if (!REVIEWED_PLAN_DIGEST_PATTERN.test(expectedDigest)) {
      throw new RangeError("Discord member-role plan digest is invalid")
    }
    return withTargetLock(
      targetLockKey(normalized),
      () => this.#executeNormalized(
        applicationId,
        botId,
        normalized,
        expectedDigest,
        "bulk",
        options,
      ),
      () => new MemberRoleExecutionError(
        "Discord bulk member-role change was blocked because a prior same-member operation ended with an uncertain outcome",
        {
          action: normalized.action,
          guildId: normalized.guildId,
          operationKeyHash: normalized.operationKeyHash,
          planDigest: expectedDigest,
          roleId: normalized.roleId,
          schemaVersion: SCHEMA_VERSION,
          status: "blocked-prior-uncertain",
          userId: normalized.userId,
        },
      ),
    )
  }

  async #executeNormalized(
    applicationId: string,
    botId: string,
    request: NormalizedMemberRoleChangeRequest,
    expectedDigest: string,
    authority: MemberRoleAuthority,
    options: RequestOptions,
  ): Promise<MemberRoleChangeResult> {
    let plan: MemberRoleChangePlan
    try {
      plan = await this.#planNormalized(
        applicationId,
        botId,
        request,
        authority,
        options,
      )
    } catch (error) {
      if (
        error instanceof MemberRoleStateError
        || error instanceof DiscordApiError && error.status === 404
      ) {
        throw new MemberRolePlanChangedError(expectedDigest, STATE_UNAVAILABLE)
      }
      throw error
    }
    if (plan.digest !== expectedDigest) {
      throw new MemberRolePlanChangedError(expectedDigest, plan.digest)
    }
    const baseResult = {
      action: request.action,
      guildId: request.guildId,
      operationKeyHash: request.operationKeyHash,
      planDigest: plan.digest,
      roleId: request.roleId,
      schemaVersion: SCHEMA_VERSION,
      userId: request.userId,
    }
    if (plan.action === "none") {
      return {
        ...baseResult,
        activityId: null,
        observedRoleIds: plan.member.beforeRoleIds,
        rolePresent: plan.member.beforeRoleIds.includes(request.roleId),
        roleSnapshotMatched: true,
        status: "already-current",
      }
    }

    const activityId = this.#randomId()
    const reservation = await this.#operationStore.reserve(operationReceipt({
      activityId,
      plan,
      request,
      status: "pending",
      timestamp: this.#clock().toISOString(),
    }))
    if (!reservation.created) {
      throw new MemberRoleOperationConflictError(receiptView(reservation.receipt))
    }
    try {
      await this.#activityStore.append(activityEntry({
        activityId,
        plan,
        request,
        status: "pending",
        timestamp: this.#clock().toISOString(),
      }))
    } catch (error) {
      let operationRecordError: string | null = null
      try {
        await this.#operationStore.finish(operationReceipt({
          activityId,
          error: safeErrorCode(error),
          plan,
          request,
          status: "failed",
          timestamp: this.#clock().toISOString(),
        }))
      } catch (receiptError) {
        operationRecordError = safeErrorCode(receiptError)
      }
      throw new MemberRoleExecutionError(
        "Discord member-role change was blocked because pending activity could not be recorded",
        {
          ...baseResult,
          activityId,
          error: safeErrorCode(error),
          operationRecordError,
          status: "blocked-audit-failed",
        },
        { cause: error },
      )
    }

    let mutationCompleted = false
    let observedRoleIds: string[] = []
    let rolePresent: boolean | null = null
    try {
      if (request.action === "add") {
        await this.#client.addGuildMemberRole(
          request.guildId,
          request.userId,
          request.roleId,
          request.auditReason,
          options,
        )
      } else {
        await this.#client.removeGuildMemberRole(
          request.guildId,
          request.userId,
          request.roleId,
          request.auditReason,
          options,
        )
      }
      mutationCompleted = true
      const readback = exactMember(
        await this.#client.getGuildMember(request.guildId, request.userId, options),
        request.guildId,
        request.userId,
        "readback target",
      )
      observedRoleIds = canonicalRoleIds(readback.roles)
      rolePresent = observedRoleIds.includes(request.roleId)
    } catch (error) {
      const status = !mutationCompleted
        && error instanceof DiscordApiError
        && error.status >= 400
        && error.status < 500
        ? "failed"
        : "uncertain"
      const errorCode = safeErrorCode(error)
      let operationRecordError: string | null = null
      try {
        await this.#operationStore.finish(operationReceipt({
          activityId,
          error: errorCode,
          plan,
          request,
          status,
          timestamp: this.#clock().toISOString(),
        }))
      } catch (receiptError) {
        operationRecordError = safeErrorCode(receiptError)
      }
      let activityRecordError: string | null = null
      try {
        await this.#activityStore.append(activityEntry({
          activityId,
          error: errorCode,
          plan,
          request,
          status,
          timestamp: this.#clock().toISOString(),
        }))
      } catch (activityError) {
        activityRecordError = safeErrorCode(activityError)
      }
      throw new MemberRoleExecutionError(
        "Discord member-role change did not complete with a verified successful outcome",
        {
          ...baseResult,
          activityId,
          activityRecordError,
          error: errorCode,
          observedRoleIds,
          operationRecordError,
          retryAfterMs: error instanceof DiscordApiError
            ? error.retryAfterMs ?? null
            : null,
          rolePresent,
          status,
        },
        { cause: error },
      )
    }

    const expectedRolePresent = request.action === "add"
    const roleSnapshotMatched = sameRoleIds(
      observedRoleIds,
      plan.member.afterRoleIds,
    )
    const verification = rolePresent === expectedRolePresent && roleSnapshotMatched
      ? "match"
      : "drift"
    const status = verification === "match" ? "completed" : "completed-with-drift"
    const result: MemberRoleChangeResult = {
      ...baseResult,
      activityId,
      observedRoleIds,
      rolePresent: rolePresent as boolean,
      roleSnapshotMatched,
      status,
    }
    try {
      await this.#operationStore.finish(operationReceipt({
        activityId,
        plan,
        request,
        status: "completed",
        timestamp: this.#clock().toISOString(),
        verification,
      }))
    } catch (error) {
      let activityRecordError: string | null = null
      try {
        await this.#activityStore.append(activityEntry({
          activityId,
          error: safeErrorCode(error),
          plan,
          request,
          status,
          timestamp: this.#clock().toISOString(),
          verification,
        }))
      } catch (activityError) {
        activityRecordError = safeErrorCode(activityError)
      }
      throw new MemberRoleExecutionError(
        "Discord member-role change completed but the operation receipt failed",
        {
          ...result,
          activityRecordError,
          operationRecordError: safeErrorCode(error),
          status: "completed-operation-record-failed",
        },
        { cause: error },
      )
    }
    try {
      await this.#activityStore.append(activityEntry({
        activityId,
        plan,
        request,
        status,
        timestamp: this.#clock().toISOString(),
        verification,
      }))
    } catch (error) {
      throw new MemberRoleExecutionError(
        "Discord member-role change completed but the final activity record failed",
        {
          ...result,
          activityRecordError: safeErrorCode(error),
          status: "completed-audit-failed",
        },
        { cause: error },
      )
    }
    return result
  }
}
