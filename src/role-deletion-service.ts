import { randomUUID } from "node:crypto"

import type {
  ActivityStore,
  RoleDeletionActivity,
  RoleDeletionActivityStatus,
} from "./activity-log.js"
import {
  DISCORD_LIMITS,
  DISCORD_SNOWFLAKE_MAX,
  DISCORD_SNOWFLAKE_PATTERN,
  SCHEMA_VERSION,
} from "./constants.js"
import {
  encodeDiscordAuditReason,
  type DiscordAutoModerationRuleSummary,
  type DiscordClient,
  type DiscordGuildApplicationCommandPermissions,
  type DiscordGuildEmojiSummary,
  type DiscordGuildIntegrationSummary,
  type DiscordGuildOnboarding,
  type DiscordGuildRoleMemberCounts,
  type DiscordInviteSummary,
} from "./discord-client.js"
import {
  DiscordApiError,
  RoleDeletionEvidenceError,
  RoleDeletionExecutionError,
  RoleDeletionOperationConflictError,
  RoleDeletionPlanChangedError,
} from "./errors.js"
import type {
  GatewayChannelLayoutSnapshot,
  GatewayChannelLayoutSource,
} from "./gateway-channel-layout.js"
import {
  collectGuildChannelEvidence,
  DIRECT_GUILD_CHANNEL_TYPES,
  GuildChannelEvidenceError,
  type GuildChannelHttpEvidenceMode,
} from "./guild-channel-evidence.js"
import { isGuildChannelTopologyType } from "./guild-channel-types.js"
import {
  guildChannelAnalysisCoverage,
  hasHiddenModeledChannel,
  type GuildChannelAnalysisCoverage,
} from "./guild-channel-coverage.js"
import {
  guildBlueprintRoleRecoveryStateDigest,
} from "./guild-blueprint-capture-service.js"
import {
  createGuildRecoveryAttestationKey,
  guildDeletionRecoveryWarnings,
  guildDeletionRecoveryRequestDigestView,
  noGuildRecoveryArtifactEvidence,
  normalizeGuildDeletionRecoveryRequest,
  verifyGuildRecoveryAttestation,
  type GuildDeletionRecoveryEvidence,
  type GuildDeletionRecoveryRequest,
  type NormalizedGuildDeletionRecoveryRequest,
} from "./guild-recovery-attestation.js"
import { stableString } from "./normalize.js"
import {
  type OperationReceipt,
  type OperationStore,
  operationKeyHash,
} from "./operation-store.js"
import {
  evaluateGuildMemberPermissions,
  hasGuildPermission,
  parseDiscordPermissionBits,
  unknownDiscordPermissionBits,
  type DiscordPermissionName,
  type GuildMemberPermissionResult,
} from "./permissions.js"
import type { ScopePolicy } from "./policy.js"
import {
  createReviewedPlanKey,
  REVIEWED_PLAN_DIGEST_PATTERN,
  reviewedPlanDigest,
} from "./reviewed-plan.js"
import {
  DiscordRoleEvidenceError,
  normalizeDiscordRoleInventory,
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

const STATE_UNAVAILABLE = "role-deletion-state-unavailable"
const COMMUNITY_FEATURE = "COMMUNITY"
const AUTOMOD_FEATURE = "AUTO_MODERATION"
const ROLE_DELETION_LOCKS = new Map<string, Promise<RoleDeletionTargetOutcome>>()
const ROLE_NAME_CONTROL_PATTERN = /[\u0000-\u001F\u007F]/u

type RoleDeletionTargetOutcome = "settled" | "uncertain"

export type RoleDeletionBlockerKind =
  | "application-command-permission"
  | "automod-exempt-role"
  | "channel-overwrite"
  | "emoji-role-restriction"
  | "integration-role"
  | "invite-role-grant"
  | "managed-role"
  | "member-holder"
  | "onboarding-role-option"
  | "role-hierarchy"

export interface RoleDeletionRequest {
  acknowledgeIrreversibleRoleLoss: true
  auditReason: string
  guildId: string
  operationKey: string
  recovery: GuildDeletionRecoveryRequest
  roleId: string
}

export interface NormalizedRoleDeletionRequest
  extends Omit<RoleDeletionRequest, "recovery"> {
  operationKeyHash: string
  recovery: NormalizedGuildDeletionRecoveryRequest
}

export interface RoleDeletionBlocker {
  count: number
  kind: RoleDeletionBlockerKind
}

export interface RoleDeletionDependencyCounts {
  applicationCommandPermissions: number
  autoModerationExemptions: number
  channelOverwrites: number
  emojiRestrictions: number
  integrationRoles: number
  inviteRoleGrants: number
  onboardingOptions: number
}

export interface RoleDeletionReadiness {
  applicationId: string
  blockers: RoleDeletionBlocker[]
  botId: string
  dependencies: {
    coverage: GuildChannelAnalysisCoverage
    blockerCount: number
    counts: RoleDeletionDependencyCounts
    digest: string
  }
  evidenceDigest: string
  guild: {
    features: string[]
    id: string
    name: string
    ownerId: string
  }
  layout: {
    channelCount: number
    httpEvidenceMode: GuildChannelHttpEvidenceMode
    obfuscatedChannelCount: number
    revision: number
    updatedAt: string
  }
  memberCount: number
  permission: {
    administrator: boolean
    botEffectivePermissionNames: DiscordPermissionName[]
    botEffectivePermissions: string
    botHighestRoleIds: string[]
    botHighestRolePosition: number
    guildManageGuild: boolean
    guildManageRoles: boolean
  }
  privacy: {
    contentFetched: false
    dependencyIdentifiersPersisted: false
    roleNamePersisted: false
  }
  ready: boolean
  risks: string[]
  roleCount: number
  schemaVersion: number
  status: "blocked" | "ready"
  target: NormalizedDiscordRole
  warnings: string[]
}

export interface RoleDeletionPlan extends Omit<
  RoleDeletionReadiness,
  "evidenceDigest" | "ready" | "status"
> {
  acknowledgeIrreversibleRoleLoss: true
  auditReason: string
  createdAt: string
  digest: string
  operationKeyHash: string
  recovery: GuildDeletionRecoveryEvidence
  status: "blocked" | "planned"
  writeRequired: boolean
}

export interface RoleDeletionResult {
  activityId: string | null
  addedEvidence: RoleDeletionAddedEvidenceCounts
  baselineRoleCount: number
  blockerCount: number
  guildId: string
  memberCount: number
  observedRoleCount: number | null
  operationKeyHash: string
  planDigest: string
  roleId: string
  schemaVersion: number
  status:
    | "blocked"
    | "completed"
    | "completed-with-drift"
  verification: "drift" | "match" | "not-required"
}

export interface RoleDeletionAddedEvidenceCounts {
  applicationCommands: number
  autoModerationRules: number
  channels: number
  emojis: number
  integrations: number
  invites: number
  onboardingOptions: number
  roles: number
}

export interface RoleDeletionServiceClient extends Pick<
  DiscordClient,
  | "deleteGuildRole"
  | "getGuild"
  | "getGuildChannels"
  | "getGuildMember"
  | "getGuildOnboarding"
  | "getGuildRoleMemberCounts"
  | "getGuildRoles"
  | "listGuildApplicationCommandPermissions"
  | "listGuildAutoModerationRules"
  | "listGuildEmojis"
  | "listGuildIntegrations"
  | "listGuildInvites"
> {}

export interface RoleDeletionServiceOptions {
  activityStore: ActivityStore
  client: RoleDeletionServiceClient
  clock?: () => Date
  layoutSource: GatewayChannelLayoutSource
  operationStore: OperationStore
  planKey?: Uint8Array
  policy: Pick<
    ScopePolicy,
    "assertRoleDeletionAllowed" | "assertRoleDeletionAuditable"
  >
  randomId?: () => string
  recoveryAttestationKey?: Uint8Array
}

interface ValidatedGuild {
  features: string[]
  id: string
  name: string
  ownerId: string
}

interface RoleDependencyInventory {
  applicationCommands: Array<{
    commandId: string
    permissions: Array<{ allowed: boolean; id: string; type: 1 | 2 | 3 }>
  }>
  autoModerationRules: Array<{ exemptRoleIds: string[]; id: string }>
  channels: Array<{
    id: string
    opaqueRoleIds?: string[]
    overwrites: Array<{ allow: string; deny: string; id: string; type: 0 | 1 }>
  }>
  emojis: Array<{ id: string; roleIds: string[] }>
  integrations: Array<{ id: string; roleId: string | null }>
  invites: Array<{ code: string; roleIds: string[] }>
  onboardingOptions: Array<{ id: string; roleIds: string[] }>
}

interface RoleDeletionState {
  channelCoverage: GuildChannelAnalysisCoverage
  botMember: DiscordGuildMember
  botPermissions: GuildMemberPermissionResult
  counts: DiscordGuildRoleMemberCounts
  dependencies: RoleDependencyInventory
  guild: ValidatedGuild
  httpEvidenceMode: GuildChannelHttpEvidenceMode
  layout: GatewayChannelLayoutSnapshot
  roles: NormalizedDiscordRole[]
  target: NormalizedDiscordRole | null
}

interface BuiltRoleDeletionPlan {
  plan: RoleDeletionPlan
  request: NormalizedRoleDeletionRequest
  state: RoleDeletionState
}

interface RoleDeletionVerification {
  addedEvidence: RoleDeletionAddedEvidenceCounts
  observedRoleCount: number
  verification: "drift" | "match"
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function snowflake(value: unknown): string | undefined {
  if (typeof value !== "string" || !DISCORD_SNOWFLAKE_PATTERN.test(value)) return undefined
  const parsed = BigInt(value)
  return parsed >= 1n && parsed <= DISCORD_SNOWFLAKE_MAX ? value : undefined
}

function assertSnowflake(value: unknown, name: string): asserts value is string {
  if (!snowflake(value)) throw new RangeError(`${name} must be a Discord snowflake`)
}

function compareSnowflakes(left: string, right: string): number {
  const leftId = BigInt(left)
  const rightId = BigInt(right)
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
}

function evidenceError(message: string, cause?: unknown): RoleDeletionEvidenceError {
  return new RoleDeletionEvidenceError(
    message,
    cause === undefined ? undefined : { cause },
  )
}

export function normalizeRoleDeletionRequest(
  request: RoleDeletionRequest,
): NormalizedRoleDeletionRequest {
  if (
    !request
    || typeof request !== "object"
    || Array.isArray(request)
    || !hasOnlyKeys(request as unknown as Record<string, unknown>, [
      "acknowledgeIrreversibleRoleLoss",
      "auditReason",
      "guildId",
      "operationKey",
      "recovery",
      "roleId",
    ])
    || request.acknowledgeIrreversibleRoleLoss !== true
    || typeof request.auditReason !== "string"
    || typeof request.operationKey !== "string"
  ) throw new RangeError("Discord role-deletion request must be an exact acknowledged object")
  assertSnowflake(request.guildId, "Discord role-deletion guild ID")
  assertSnowflake(request.roleId, "Discord role-deletion role ID")
  encodeDiscordAuditReason(request.auditReason)
  return {
    ...request,
    operationKeyHash: operationKeyHash(request.operationKey),
    recovery: normalizeGuildDeletionRecoveryRequest(request.recovery),
  }
}

function exactGuild(value: DiscordGuild, guildId: string): ValidatedGuild {
  if (
    !recordValue(value)
    || value.id !== guildId
    || typeof value.name !== "string"
    || value.name.length < 1
    || value.name.length > DISCORD_LIMITS.guildNameCharacters
    || ROLE_NAME_CONTROL_PATTERN.test(value.name)
    || !snowflake(value.owner_id)
    || !Array.isArray(value.features)
    || value.features.length > DISCORD_LIMITS.guildFeatures
    || value.features.some((feature) => (
      typeof feature !== "string"
      || feature.length < 1
      || feature.length > DISCORD_LIMITS.guildFeatureCharacters
    ))
    || new Set(value.features).size !== value.features.length
  ) throw evidenceError("Discord returned invalid role-deletion guild evidence")
  return {
    features: [...value.features].sort(),
    id: guildId,
    name: value.name,
    ownerId: value.owner_id as string,
  }
}

function exactBotMember(
  value: DiscordGuildMember,
  botId: string,
  roles: readonly NormalizedDiscordRole[],
  guildId: string,
): DiscordGuildMember {
  const roleIds = new Set(roles.map((role) => role.id))
  if (
    !recordValue(value)
    || !value.user
    || value.user.id !== botId
    || value.user.bot !== true
    || !Array.isArray(value.roles)
    || value.roles.length > DISCORD_LIMITS.guildRoles
    || value.roles.includes(guildId)
    || value.roles.some((roleId) => !snowflake(roleId) || !roleIds.has(roleId))
    || new Set(value.roles).size !== value.roles.length
  ) throw evidenceError("Discord returned invalid connector membership evidence for role deletion")
  return {
    roles: [...value.roles].sort(compareSnowflakes),
    user: {
      bot: true,
      id: botId,
      username: value.user.username,
    },
  }
}

function exactCounts(
  value: DiscordGuildRoleMemberCounts,
  roles: readonly NormalizedDiscordRole[],
  guildId: string,
): DiscordGuildRoleMemberCounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw evidenceError("Discord returned invalid role member-count evidence")
  }
  const expectedIds = roles
    .map((role) => role.id)
    .filter((roleId) => roleId !== guildId)
    .sort(compareSnowflakes)
  const actualIds = Object.keys(value).sort(compareSnowflakes)
  if (
    actualIds.length > DISCORD_LIMITS.guildRoles - 1
    || actualIds.some((roleId) => !snowflake(roleId) || roleId === guildId)
    || stableString(actualIds) !== stableString(expectedIds)
  ) throw evidenceError("Discord role member-count evidence does not match the role inventory")
  const result: Record<string, number> = {}
  for (const roleId of actualIds) {
    const count = value[roleId]
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw evidenceError("Discord returned invalid role member-count evidence")
    }
    result[roleId] = count as number
  }
  return result
}

function exactPermissions(
  guildId: string,
  member: DiscordGuildMember,
  roles: readonly DiscordRole[],
): GuildMemberPermissionResult {
  let result: GuildMemberPermissionResult
  try {
    result = evaluateGuildMemberPermissions({ guildId, member, roles })
  } catch (error) {
    throw evidenceError("Discord connector role-deletion permission evidence is invalid", error)
  }
  if (!result.complete || result.warnings.length > 0) {
    throw evidenceError("Discord connector role-deletion permission evidence is incomplete")
  }
  if (!hasGuildPermission(result, "MANAGE_ROLES")) {
    throw evidenceError("Discord connector lacks guild-level MANAGE_ROLES for role deletion")
  }
  if (!hasGuildPermission(result, "MANAGE_GUILD")) {
    throw evidenceError("Discord connector lacks guild-level MANAGE_GUILD for dependency audit")
  }
  return result
}

function exactChannelDependencies(
  channels: readonly DiscordChannel[],
  guildId: string,
): RoleDependencyInventory["channels"] {
  return channels.map((channel) => {
    if (!DIRECT_GUILD_CHANNEL_TYPES.has(channel.type)) {
      const opaqueRoleIds = new Set<string>()
      const overwrites = Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites : []
      if (overwrites.length > DISCORD_LIMITS.channelPermissionOverwrites) {
        throw evidenceError("Discord returned invalid bounded opaque channel role-reference evidence")
      }
      for (const value of overwrites) {
        const overwrite = recordValue(value)
        if (overwrite?.type === 0 && snowflake(overwrite.id)) {
          opaqueRoleIds.add(overwrite.id as string)
        }
      }
      return {
        id: channel.id,
        opaqueRoleIds: [...opaqueRoleIds].sort(compareSnowflakes),
        overwrites: [],
      }
    }
    if (
      channel.guild_id !== guildId
      || !snowflake(channel.id)
      || !isGuildChannelTopologyType(channel.type)
      || !Array.isArray(channel.permission_overwrites)
      || channel.permission_overwrites.length > DISCORD_LIMITS.channelPermissionOverwrites
    ) throw evidenceError("Discord returned incomplete channel overwrite evidence")
    const keys = new Set<string>()
    const overwrites = channel.permission_overwrites.map((overwrite: DiscordPermissionOverwrite) => {
      const record = recordValue(overwrite)
      const allowValue = overwrite.allow
      const denyValue = overwrite.deny
      if (
        !record
        || !hasOnlyKeys(record, ["allow", "deny", "id", "type"])
        || !snowflake(overwrite.id)
        || !(overwrite.type === 0 || overwrite.type === 1)
        || typeof allowValue !== "string"
        || typeof denyValue !== "string"
      ) throw evidenceError("Discord returned invalid channel overwrite evidence")
      let allow: bigint
      let deny: bigint
      try {
        allow = parseDiscordPermissionBits(allowValue, "channel overwrite allow")
        deny = parseDiscordPermissionBits(denyValue, "channel overwrite deny")
      } catch (error) {
        throw evidenceError("Discord returned invalid channel overwrite evidence", error)
      }
      if (
        (allow & deny) !== 0n
        || unknownDiscordPermissionBits(allow | deny) !== 0n
      ) throw evidenceError("Discord returned unknown channel overwrite permission evidence")
      const key = `${overwrite.type}:${overwrite.id}`
      if (keys.has(key)) throw evidenceError("Discord returned duplicate channel overwrite evidence")
      keys.add(key)
      return {
        allow: allow.toString(),
        deny: deny.toString(),
        id: overwrite.id,
        type: overwrite.type as 0 | 1,
      }
    }).sort((left, right) => (
      left.type - right.type || compareSnowflakes(left.id, right.id)
    ))
    return { id: channel.id, overwrites }
  }).sort((left, right) => compareSnowflakes(left.id, right.id))
}

function exactInvites(
  value: readonly DiscordInviteSummary[],
  guildId: string,
): RoleDependencyInventory["invites"] {
  if (!Array.isArray(value)) throw evidenceError("Discord returned invalid invite evidence")
  const codes = new Set<string>()
  return value.map((invite) => {
    if (
      !recordValue(invite)
      || invite.guildId !== guildId
      || typeof invite.code !== "string"
      || invite.code.length < 1
      || codes.has(invite.code)
      || !Array.isArray(invite.roleIds)
      || invite.roleIds.some((roleId: unknown) => !snowflake(roleId))
      || new Set(invite.roleIds).size !== invite.roleIds.length
      || (invite.unknownFieldCount ?? 0) !== 0
    ) throw evidenceError("Discord returned invalid or unknown invite role evidence")
    const code = invite.code as string
    const roleIds = invite.roleIds as string[]
    codes.add(code)
    return { code, roleIds: [...roleIds].sort(compareSnowflakes) }
  }).sort((left, right) => left.code.localeCompare(right.code))
}

function exactEmojis(
  value: readonly DiscordGuildEmojiSummary[],
): RoleDependencyInventory["emojis"] {
  if (!Array.isArray(value) || value.length > DISCORD_LIMITS.guildEmojis) {
    throw evidenceError("Discord returned invalid emoji role evidence")
  }
  const ids = new Set<string>()
  return value.map((emoji) => {
    if (
      !recordValue(emoji)
      || !snowflake(emoji.id)
      || ids.has(emoji.id)
      || !Array.isArray(emoji.roleIds)
      || emoji.roleIds.some((roleId: unknown) => !snowflake(roleId))
      || new Set(emoji.roleIds).size !== emoji.roleIds.length
      || (emoji.unknownFieldCount ?? 0) !== 0
    ) throw evidenceError("Discord returned invalid or unknown emoji role evidence")
    ids.add(emoji.id)
    return { id: emoji.id, roleIds: [...(emoji.roleIds as string[])].sort(compareSnowflakes) }
  }).sort((left, right) => compareSnowflakes(left.id, right.id))
}

function exactIntegrations(
  value: readonly DiscordGuildIntegrationSummary[],
): RoleDependencyInventory["integrations"] {
  if (!Array.isArray(value) || value.length > DISCORD_LIMITS.guildIntegrations) {
    throw evidenceError("Discord returned invalid integration role evidence")
  }
  const ids = new Set<string>()
  return value.map((integration) => {
    const counts = integration?.unknownFieldCounts
    if (
      !recordValue(integration)
      || !snowflake(integration.id)
      || ids.has(integration.id)
      || !(integration.roleId === null || snowflake(integration.roleId))
      || !counts
      || Object.values(counts).some((count) => !Number.isSafeInteger(count) || count !== 0)
      || integration.unknownScopeCount !== 0
    ) throw evidenceError("Discord returned invalid or unknown integration role evidence")
    ids.add(integration.id)
    return { id: integration.id, roleId: integration.roleId }
  }).sort((left, right) => compareSnowflakes(left.id, right.id))
}

function exactOnboarding(
  value: DiscordGuildOnboarding | null,
  guildId: string,
): RoleDependencyInventory["onboardingOptions"] {
  if (value === null) return []
  if (
    !recordValue(value)
    || value.guildId !== guildId
    || value.unknownEnumCount !== 0
    || value.unknownFieldCount !== 0
    || !Array.isArray(value.prompts)
  ) throw evidenceError("Discord returned invalid or unknown onboarding role evidence")
  const ids = new Set<string>()
  const options = value.prompts.flatMap((prompt) => {
    if (!recordValue(prompt) || !Array.isArray(prompt.options)) {
      throw evidenceError("Discord returned invalid onboarding role evidence")
    }
    return prompt.options.map((option) => {
      if (
        !recordValue(option)
        || !snowflake(option.id)
        || ids.has(option.id)
        || !Array.isArray(option.roleIds)
        || option.roleIds.some((roleId: unknown) => !snowflake(roleId))
        || new Set(option.roleIds).size !== option.roleIds.length
      ) throw evidenceError("Discord returned invalid onboarding role evidence")
      ids.add(option.id)
      return { id: option.id, roleIds: [...(option.roleIds as string[])].sort(compareSnowflakes) }
    })
  })
  return options.sort((left, right) => compareSnowflakes(left.id, right.id))
}

function exactAutoModerationRules(
  value: readonly DiscordAutoModerationRuleSummary[],
  guildId: string,
): RoleDependencyInventory["autoModerationRules"] {
  if (!Array.isArray(value) || value.length > DISCORD_LIMITS.autoModerationRules) {
    throw evidenceError("Discord returned invalid AutoMod role evidence")
  }
  const ids = new Set<string>()
  return value.map((rule) => {
    if (
      !recordValue(rule)
      || rule.guildId !== guildId
      || !snowflake(rule.id)
      || ids.has(rule.id)
      || !Array.isArray(rule.exemptRoleIds)
      || rule.exemptRoleIds.some((roleId: unknown) => !snowflake(roleId))
      || new Set(rule.exemptRoleIds).size !== rule.exemptRoleIds.length
      || (rule.unknownFieldCount ?? 0) !== 0
    ) throw evidenceError("Discord returned invalid or unknown AutoMod role evidence")
    ids.add(rule.id)
    return {
      exemptRoleIds: [...(rule.exemptRoleIds as string[])].sort(compareSnowflakes),
      id: rule.id,
    }
  }).sort((left, right) => compareSnowflakes(left.id, right.id))
}

function exactCommandPermissions(
  value: readonly DiscordGuildApplicationCommandPermissions[],
  applicationId: string,
  guildId: string,
): RoleDependencyInventory["applicationCommands"] {
  if (
    !Array.isArray(value)
    || value.length > DISCORD_LIMITS.guildApplicationCommandPermissions
  ) {
    throw evidenceError("Discord returned invalid application-command role evidence")
  }
  const commandIds = new Set<string>()
  return value.map((command) => {
    if (
      !recordValue(command)
      || command.applicationId !== applicationId
      || command.guildId !== guildId
      || !snowflake(command.commandId)
      || commandIds.has(command.commandId)
      || command.unknownFieldCount !== 0
      || !Array.isArray(command.permissions)
      || command.permissions.length > DISCORD_LIMITS.applicationCommandPermissionOverwrites
    ) throw evidenceError("Discord returned invalid or unknown application-command role evidence")
    commandIds.add(command.commandId)
    const permissionKeys = new Set<string>()
    const permissions: Array<{ allowed: boolean; id: string; type: 1 | 2 | 3 }> =
      command.permissions.map((permission: {
        allowed: boolean
        id: string
        type: 1 | 2 | 3
        unknownFieldCount: number
      }) => {
        const key = `${permission.type}:${permission.id}`
        if (
          !recordValue(permission)
          || !snowflake(permission.id)
          || !(permission.type === 1 || permission.type === 2 || permission.type === 3)
          || typeof permission.allowed !== "boolean"
          || permission.unknownFieldCount !== 0
          || permissionKeys.has(key)
        ) throw evidenceError("Discord returned invalid application-command permission evidence")
        permissionKeys.add(key)
        return {
          allowed: permission.allowed,
          id: permission.id,
          type: permission.type as 1 | 2 | 3,
        }
      }).sort((
        left: { allowed: boolean; id: string; type: 1 | 2 | 3 },
        right: { allowed: boolean; id: string; type: 1 | 2 | 3 },
      ) => left.type - right.type || compareSnowflakes(left.id, right.id))
    return { commandId: command.commandId, permissions }
  }).sort((left, right) => compareSnowflakes(left.commandId, right.commandId))
}

function dependencyCounts(
  inventory: RoleDependencyInventory,
  roleId: string,
): RoleDeletionDependencyCounts {
  return {
    applicationCommandPermissions: inventory.applicationCommands.reduce(
      (count, command) => count + command.permissions.filter((permission) => (
        permission.type === 1 && permission.id === roleId
      )).length,
      0,
    ),
    autoModerationExemptions: inventory.autoModerationRules.filter((rule) => (
      rule.exemptRoleIds.includes(roleId)
    )).length,
    channelOverwrites: inventory.channels.reduce(
      (count, channel) => count + channel.overwrites.filter((overwrite) => (
        overwrite.type === 0 && overwrite.id === roleId
      )).length + (channel.opaqueRoleIds?.includes(roleId) ? 1 : 0),
      0,
    ),
    emojiRestrictions: inventory.emojis.filter((emoji) => emoji.roleIds.includes(roleId)).length,
    integrationRoles: inventory.integrations.filter((entry) => entry.roleId === roleId).length,
    inviteRoleGrants: inventory.invites.filter((invite) => invite.roleIds.includes(roleId)).length,
    onboardingOptions: inventory.onboardingOptions.filter((option) => (
      option.roleIds.includes(roleId)
    )).length,
  }
}

function dependencyBlockers(
  counts: RoleDeletionDependencyCounts,
): RoleDeletionBlocker[] {
  const candidates: readonly [RoleDeletionBlockerKind, number][] = [
    ["application-command-permission", counts.applicationCommandPermissions],
    ["automod-exempt-role", counts.autoModerationExemptions],
    ["channel-overwrite", counts.channelOverwrites],
    ["emoji-role-restriction", counts.emojiRestrictions],
    ["integration-role", counts.integrationRoles],
    ["invite-role-grant", counts.inviteRoleGrants],
    ["onboarding-role-option", counts.onboardingOptions],
  ]
  return candidates
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => ({ count, kind }))
}

function roleSnapshot(role: NormalizedDiscordRole) {
  return {
    colors: role.colors,
    flags: role.flags,
    hoist: role.hoist,
    icon: role.icon,
    id: role.id,
    managed: role.managed,
    management: role.management,
    mentionable: role.mentionable,
    name: role.name,
    permissions: role.permissions,
    unicodeEmoji: role.unicodeEmoji,
    unknownFieldCount: role.unknownFieldCount,
    unknownPermissionBits: role.unknownPermissionBits,
  }
}

function rolesSnapshot(roles: readonly NormalizedDiscordRole[]) {
  return [...roles]
    .sort((left, right) => compareSnowflakes(left.id, right.id))
    .map(roleSnapshot)
}

function roleOrder(roles: readonly NormalizedDiscordRole[], ids?: ReadonlySet<string>): string[] {
  return roles
    .filter((role) => !ids || ids.has(role.id))
    .map((role) => role.id)
}

function safeErrorCode(error: unknown): string {
  if (error instanceof DiscordApiError) {
    return `DiscordApiError.${error.status}.${error.code ?? "unknown"}`
  }
  const name = error instanceof Error ? error.name : "UnknownError"
  const normalized = name.replace(/[^A-Za-z0-9._:-]/gu, "").slice(0, 128)
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
  observedRoleCount?: number | null
  plan: RoleDeletionPlan
  request: NormalizedRoleDeletionRequest
  status: RoleDeletionActivityStatus
  timestamp: string
  verification?: "drift" | "match" | null
}): RoleDeletionActivity {
  return {
    baselineRoleCount: options.plan.roleCount,
    blockerCount: options.plan.blockers.length,
    error: options.error ?? null,
    guildId: options.request.guildId,
    id: options.activityId,
    kind: "role-deletion",
    memberCount: options.plan.memberCount,
    observedRoleCount: options.observedRoleCount ?? null,
    operationKeyHash: options.request.operationKeyHash,
    planDigest: options.plan.digest,
    roleId: options.request.roleId,
    schemaVersion: SCHEMA_VERSION,
    status: options.status,
    timestamp: options.timestamp,
    verification: options.verification ?? null,
  }
}

function operationReceipt(options: {
  activityId: string
  error?: string | null
  plan: RoleDeletionPlan
  request: NormalizedRoleDeletionRequest
  status: OperationReceipt["status"]
  timestamp: string
  verification?: "drift" | "match" | null
}): OperationReceipt {
  return {
    activityId: options.activityId,
    error: options.error ?? null,
    guildId: options.request.guildId,
    kind: "role-deletion",
    operationKeyHash: options.request.operationKeyHash,
    planDigest: options.plan.digest,
    resourceId: ["completed", "uncertain"].includes(options.status)
      ? options.request.roleId
      : null,
    schemaVersion: 1,
    status: options.status,
    timestamp: options.timestamp,
    verification: options.verification ?? null,
  }
}

function uncertainExecution(error: unknown): boolean {
  if (
    !(error instanceof RoleDeletionExecutionError)
    || !error.result
    || typeof error.result !== "object"
    || !("status" in error.result)
  ) return false
  return error.result.status === "uncertain"
    || error.result.status === "completed-operation-record-failed"
}

async function withGuildLock<T>(
  guildId: string,
  operation: () => Promise<T>,
  priorUncertainError: () => RoleDeletionExecutionError,
): Promise<T> {
  const prior = ROLE_DELETION_LOCKS.get(guildId) ?? Promise.resolve("settled" as const)
  let release: (outcome: RoleDeletionTargetOutcome) => void = () => undefined
  const tail = new Promise<RoleDeletionTargetOutcome>((resolve) => {
    release = resolve
  })
  ROLE_DELETION_LOCKS.set(guildId, tail)
  let outcome: RoleDeletionTargetOutcome = "settled"
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
    if (outcome === "settled" && ROLE_DELETION_LOCKS.get(guildId) === tail) {
      ROLE_DELETION_LOCKS.delete(guildId)
    }
  }
}

function compareCollection<T extends { id: string }>(
  baseline: readonly T[],
  observed: readonly T[],
): { added: number; preserved: boolean } {
  const observedById = new Map(observed.map((entry) => [entry.id, entry]))
  const preserved = baseline.every((entry) => (
    stableString(observedById.get(entry.id)) === stableString(entry)
  ))
  const baselineIds = new Set(baseline.map((entry) => entry.id))
  return {
    added: observed.filter((entry) => !baselineIds.has(entry.id)).length,
    preserved,
  }
}

function noAddedEvidence(): RoleDeletionAddedEvidenceCounts {
  return {
    applicationCommands: 0,
    autoModerationRules: 0,
    channels: 0,
    emojis: 0,
    integrations: 0,
    invites: 0,
    onboardingOptions: 0,
    roles: 0,
  }
}

function verifyDeletion(
  baseline: RoleDeletionState,
  observed: RoleDeletionState,
  roleId: string,
): RoleDeletionVerification {
  if (observed.target) throw evidenceError("Discord role-deletion target remains present")
  const baselineSurvivors = baseline.roles.filter((role) => role.id !== roleId)
  const survivorIds = new Set(baselineSurvivors.map((role) => role.id))
  const roleComparison = compareCollection(
    baselineSurvivors.map(roleSnapshot),
    observed.roles.map(roleSnapshot),
  )
  const memberCountsPreserved = baselineSurvivors.every((role) => (
    role.id === baseline.guild.id
      || observed.counts[role.id] === baseline.counts[role.id]
  ))
  const roleOrderPreserved = stableString(roleOrder(baselineSurvivors))
    === stableString(roleOrder(observed.roles, survivorIds))
  const channelComparison = compareCollection(
    baseline.dependencies.channels,
    observed.dependencies.channels,
  )
  const opaqueChannelComparison = compareCollection(
    baseline.channelCoverage.unsupportedChannels.map((entry) => ({ ...entry, id: entry.channelId })),
    observed.channelCoverage.unsupportedChannels.map((entry) => ({ ...entry, id: entry.channelId })),
  )
  const baselineChannelIds = new Set(baseline.layout.channels.map((entry) => entry.channelId))
  const addedChannels = observed.layout.channels.filter((entry) => !baselineChannelIds.has(entry.channelId)).length
  const emojiComparison = compareCollection(
    baseline.dependencies.emojis,
    observed.dependencies.emojis,
  )
  const integrationComparison = compareCollection(
    baseline.dependencies.integrations,
    observed.dependencies.integrations,
  )
  const onboardingComparison = compareCollection(
    baseline.dependencies.onboardingOptions,
    observed.dependencies.onboardingOptions,
  )
  const automodComparison = compareCollection(
    baseline.dependencies.autoModerationRules,
    observed.dependencies.autoModerationRules,
  )
  const commandComparison = compareCollection(
    baseline.dependencies.applicationCommands.map((entry) => ({
      id: entry.commandId,
      permissions: entry.permissions,
    })),
    observed.dependencies.applicationCommands.map((entry) => ({
      id: entry.commandId,
      permissions: entry.permissions,
    })),
  )
  const baselineInvites = baseline.dependencies.invites
  const observedInviteMap = new Map(observed.dependencies.invites.map((entry) => [entry.code, entry]))
  const invitesPreserved = baselineInvites.every((entry) => (
    stableString(observedInviteMap.get(entry.code)) === stableString(entry)
  ))
  const baselineInviteCodes = new Set(baselineInvites.map((entry) => entry.code))
  const addedInvites = observed.dependencies.invites.filter((entry) => (
    !baselineInviteCodes.has(entry.code)
  )).length
  if (
    !roleComparison.preserved
    || !memberCountsPreserved
    || !roleOrderPreserved
    || !channelComparison.preserved
    || !opaqueChannelComparison.preserved
    || !emojiComparison.preserved
    || !integrationComparison.preserved
    || !onboardingComparison.preserved
    || !automodComparison.preserved
    || !commandComparison.preserved
    || !invitesPreserved
  ) throw evidenceError("Discord role deletion changed or removed surviving reviewed evidence")
  const addedEvidence = {
    applicationCommands: commandComparison.added,
    autoModerationRules: automodComparison.added,
    channels: addedChannels,
    emojis: emojiComparison.added,
    integrations: integrationComparison.added,
    invites: addedInvites,
    onboardingOptions: onboardingComparison.added,
    roles: roleComparison.added,
  }
  return {
    addedEvidence,
    observedRoleCount: observed.roles.length,
    verification: Object.values(addedEvidence).some((count) => count > 0)
      ? "drift"
      : "match",
  }
}

export class RoleDeletionService {
  readonly #activityStore: ActivityStore
  readonly #client: RoleDeletionServiceClient
  readonly #clock: () => Date
  readonly #layoutSource: GatewayChannelLayoutSource
  readonly #operationStore: OperationStore
  readonly #planKey: Uint8Array
  readonly #policy: RoleDeletionServiceOptions["policy"]
  readonly #randomId: () => string
  readonly #recoveryAttestationKey: Uint8Array

  constructor(options: RoleDeletionServiceOptions) {
    this.#activityStore = options.activityStore
    this.#client = options.client
    this.#clock = options.clock ?? (() => new Date())
    this.#layoutSource = options.layoutSource
    this.#operationStore = options.operationStore
    this.#planKey = options.planKey ?? createReviewedPlanKey()
    this.#policy = options.policy
    this.#randomId = options.randomId ?? randomUUID
    this.#recoveryAttestationKey = new Uint8Array(
      options.recoveryAttestationKey ?? createGuildRecoveryAttestationKey(),
    )
  }

  async #state(
    applicationId: string,
    botId: string,
    guildId: string,
    roleId: string,
    options: RequestOptions,
    allowMissingTarget = false,
  ): Promise<RoleDeletionState> {
    if (!this.#layoutSource.layoutEnabled) {
      throw evidenceError("Discord Gateway role-deletion layout is disabled")
    }
    let supporting: Omit<RoleDeletionState, "channelCoverage" | "httpEvidenceMode" | "layout"> | undefined
    try {
      const channelEvidence = await collectGuildChannelEvidence({
        guildId,
        layoutSource: this.#layoutSource,
        readChannels: async () => {
          const [
            guildValue,
            memberValue,
            rawRoles,
            countsValue,
            channels,
            inviteValue,
            emojiValue,
            integrationValue,
            commandValue,
          ] = await Promise.all([
            this.#client.getGuild(guildId, options),
            this.#client.getGuildMember(guildId, botId, options),
            this.#client.getGuildRoles(guildId, options),
            this.#client.getGuildRoleMemberCounts(guildId, options),
            this.#client.getGuildChannels(guildId, options),
            this.#client.listGuildInvites(guildId, options),
            this.#client.listGuildEmojis(guildId, options),
            this.#client.listGuildIntegrations(guildId, options),
            this.#client.listGuildApplicationCommandPermissions(applicationId, guildId, options),
          ])
          const guild = exactGuild(guildValue, guildId)
          let roles: NormalizedDiscordRole[]
          try {
            roles = normalizeDiscordRoleInventory(rawRoles, guildId)
          } catch (error) {
            throw evidenceError("Discord returned invalid role-deletion role evidence", error)
          }
          if (roles.some((role) => (
            role.unknownFieldCount !== 0 || role.unknownPermissionBits !== "0"
          ))) throw evidenceError("Discord returned unknown role-deletion role evidence")
          const botMember = exactBotMember(memberValue, botId, roles, guildId)
          const botPermissions = exactPermissions(guildId, botMember, rawRoles)
          const counts = exactCounts(countsValue, roles, guildId)
          const target = roles.find((role) => role.id === roleId) ?? null
          if (!target && !allowMissingTarget) {
            throw evidenceError("Discord role-deletion target is absent from the complete inventory")
          }
          const [onboardingValue, automodValue] = await Promise.all([
            guild.features.includes(COMMUNITY_FEATURE)
              ? this.#client.getGuildOnboarding(guildId, options)
              : Promise.resolve(null),
            guild.features.includes(AUTOMOD_FEATURE)
              ? this.#client.listGuildAutoModerationRules(guildId, options)
              : Promise.resolve([]),
          ])
          supporting = {
            botMember,
            botPermissions,
            counts,
            dependencies: {
              applicationCommands: exactCommandPermissions(
                commandValue,
                applicationId,
                guildId,
              ),
              autoModerationRules: exactAutoModerationRules(automodValue, guildId),
              channels: [],
              emojis: exactEmojis(emojiValue),
              integrations: exactIntegrations(integrationValue),
              invites: exactInvites(inviteValue, guildId),
              onboardingOptions: exactOnboarding(onboardingValue, guildId),
            },
            guild,
            roles,
            target,
          }
          return channels
        },
      })
      if (!supporting) throw evidenceError("Discord role-deletion supporting evidence is unavailable")
      if (hasHiddenModeledChannel(channelEvidence.layout.channels)) {
        throw evidenceError("Discord role deletion requires complete metadata for modeled channels")
      }
      // Derive channel dependencies only from reconciled, non-obfuscated metadata
      return {
        ...supporting,
        dependencies: {
          ...supporting.dependencies,
          channels: exactChannelDependencies(channelEvidence.channels, guildId),
        },
        channelCoverage: guildChannelAnalysisCoverage(channelEvidence.layout.channels),
        httpEvidenceMode: channelEvidence.view.httpMode,
        layout: channelEvidence.layout,
      }
    } catch (error) {
      if (error instanceof RoleDeletionEvidenceError) throw error
      if (error instanceof GuildChannelEvidenceError) {
        throw evidenceError(`Discord role-deletion evidence is incomplete: ${error.message}`, error)
      }
      throw evidenceError("Discord role-deletion evidence collection failed", error)
    }
  }

  #readiness(
    applicationId: string,
    botId: string,
    state: RoleDeletionState,
  ): RoleDeletionReadiness {
    const target = state.target
    if (!target) throw evidenceError("Discord role-deletion target is absent")
    const counts = dependencyCounts(state.dependencies, target.id)
    const blockers = dependencyBlockers(counts)
    const memberCount = state.counts[target.id]
    if (memberCount === undefined) {
      throw evidenceError("Discord role-deletion target member count is absent")
    }
    if (memberCount > 0) blockers.push({ count: memberCount, kind: "member-holder" })
    if (target.managed || target.management.type !== "standard" || target.id === state.guild.id) {
      blockers.push({ count: 1, kind: "managed-role" })
    }
    if (state.botPermissions.highestRolePosition <= target.position) {
      blockers.push({ count: 1, kind: "role-hierarchy" })
    }
    const dependencyDigest = reviewedPlanDigest(this.#planKey, {
      channelCoverage: state.channelCoverage,
      dependencies: state.dependencies,
      guildId: state.guild.id,
      targetRoleId: target.id,
    })
    const evidenceDigest = reviewedPlanDigest(this.#planKey, {
      applicationId,
      botId,
      botMember: {
        roles: state.botMember.roles,
        userId: state.botMember.user?.id ?? null,
      },
      botPermissions: {
        administrator: state.botPermissions.administrator,
        effectivePermissions: state.botPermissions.effectivePermissions,
        highestRoleIds: state.botPermissions.highestRoleIds,
        highestRolePosition: state.botPermissions.highestRolePosition,
      },
      counts: state.counts,
      dependencies: state.dependencies,
      guild: state.guild,
      httpEvidenceMode: state.httpEvidenceMode,
      layout: state.layout,
      roles: rolesSnapshot(state.roles),
      roleOrder: roleOrder(state.roles),
      target: roleSnapshot(target),
    })
    const warnings = [
      ...(state.channelCoverage.status === "partial"
        ? ["Channel dependency analysis is partial; unsupported channel types may contain role references that this audit cannot inspect"]
        : []),
      "The target role name is untrusted Discord text and is never persisted by this workflow",
      "Discord exposes no complete search for historical role mentions; deleting the role can leave non-clickable historical mentions",
      "Discord exposes this application's command permission overrides only; overrides owned by other applications are not discoverable",
      "Guild Template snapshots can retain historical role state and are not enumerable at role-reference granularity",
      ...(state.botPermissions.administrator
        ? ["Discord connector has ADMINISTRATOR; replace it with narrowly scoped MANAGE_ROLES and MANAGE_GUILD"]
        : []),
      "Discord exposes no conditional role deletion, so external same-guild administration can race the reviewed write",
      "Deletion planning requires either a fresh exact target-bound caller-retained blueprint attestation or explicit acknowledgement that no recovery artifact is retained",
    ]
    const risks = [
      "Guild role deletion is irreversible and removes the role identity from Discord",
      "The DELETE is sent once without automatic retry, rollback, or dependent-resource cleanup",
      "A transport ambiguity or post-write evidence contradiction is uncertain and quarantines same-process guild role deletion",
      "The operation key is one-shot and cannot be retried after reservation, including after uncertainty",
    ]
    return {
      applicationId,
      blockers,
      botId,
      dependencies: {
        coverage: state.channelCoverage,
        blockerCount: blockers.reduce((total, blocker) => total + blocker.count, 0),
        counts,
        digest: dependencyDigest,
      },
      evidenceDigest,
      guild: state.guild,
      layout: {
        channelCount: state.layout.channels.length,
        httpEvidenceMode: state.httpEvidenceMode,
        obfuscatedChannelCount: state.layout.channels.filter((channel) => channel.obfuscated).length,
        revision: state.layout.revision,
        updatedAt: state.layout.updatedAt as string,
      },
      memberCount,
      permission: {
        administrator: state.botPermissions.administrator,
        botEffectivePermissionNames: state.botPermissions.effectivePermissionNames,
        botEffectivePermissions: state.botPermissions.effectivePermissions,
        botHighestRoleIds: state.botPermissions.highestRoleIds,
        botHighestRolePosition: state.botPermissions.highestRolePosition,
        guildManageGuild: true,
        guildManageRoles: true,
      },
      privacy: {
        contentFetched: false,
        dependencyIdentifiersPersisted: false,
        roleNamePersisted: false,
      },
      ready: blockers.length === 0,
      risks,
      roleCount: state.roles.length,
      schemaVersion: SCHEMA_VERSION,
      status: blockers.length === 0 ? "ready" : "blocked",
      target,
      warnings,
    }
  }

  audit(
    applicationId: string,
    botId: string,
    guildId: string,
    roleId: string,
    options: RequestOptions = {},
  ): Promise<RoleDeletionReadiness> {
    assertSnowflake(applicationId, "Discord connector application ID")
    assertSnowflake(botId, "Discord connector bot ID")
    assertSnowflake(guildId, "Discord role-deletion guild ID")
    assertSnowflake(roleId, "Discord role-deletion role ID")
    this.#policy.assertRoleDeletionAuditable(guildId, roleId)
    return this.#state(applicationId, botId, guildId, roleId, options)
      .then((state) => this.#readiness(applicationId, botId, state))
  }

  async #buildPlan(
    applicationId: string,
    botId: string,
    request: NormalizedRoleDeletionRequest,
    options: RequestOptions,
  ): Promise<BuiltRoleDeletionPlan> {
    assertSnowflake(applicationId, "Discord connector application ID")
    assertSnowflake(botId, "Discord connector bot ID")
    this.#policy.assertRoleDeletionAllowed(request.guildId, request.roleId)
    const existingReceipt = await this.#operationStore.get(
      "role-deletion",
      request.operationKeyHash,
    )
    if (existingReceipt) {
      throw new RoleDeletionOperationConflictError(receiptView(existingReceipt))
    }
    const state = await this.#state(
      applicationId,
      botId,
      request.guildId,
      request.roleId,
      options,
    )
    const readiness = this.#readiness(applicationId, botId, state)
    const recovery = request.recovery.mode === "none"
      ? noGuildRecoveryArtifactEvidence()
      : verifyGuildRecoveryAttestation(
          this.#recoveryAttestationKey,
          request.recovery.attestation,
          {
            applicationId,
            botId,
            guildId: request.guildId,
            resourceId: request.roleId,
            resourceType: "role",
            targetStateDigest: guildBlueprintRoleRecoveryStateDigest(
              readiness.target,
            ),
          },
          this.#clock(),
        )
    const digest = reviewedPlanDigest(this.#planKey, {
      acknowledgeIrreversibleRoleLoss: request.acknowledgeIrreversibleRoleLoss,
      auditReason: request.auditReason,
      evidenceDigest: readiness.evidenceDigest,
      operationKeyHash: request.operationKeyHash,
      recovery: guildDeletionRecoveryRequestDigestView(request.recovery),
      recoveryEvidence: recovery,
    })
    const {
      evidenceDigest: _evidenceDigest,
      ready: _ready,
      status: _readinessStatus,
      ...shared
    } = readiness
    const plan: RoleDeletionPlan = {
      ...shared,
      acknowledgeIrreversibleRoleLoss: true,
      auditReason: request.auditReason,
      createdAt: this.#clock().toISOString(),
      digest,
      operationKeyHash: request.operationKeyHash,
      recovery,
      status: readiness.ready ? "planned" : "blocked",
      warnings: [...shared.warnings, ...guildDeletionRecoveryWarnings(recovery)],
      writeRequired: readiness.ready,
    }
    return { plan, request, state }
  }

  plan(
    applicationId: string,
    botId: string,
    request: RoleDeletionRequest,
    options: RequestOptions = {},
  ): Promise<RoleDeletionPlan> {
    return this.#buildPlan(
      applicationId,
      botId,
      normalizeRoleDeletionRequest(request),
      options,
    ).then(({ plan }) => plan)
  }

  execute(
    applicationId: string,
    botId: string,
    request: RoleDeletionRequest,
    expectedDigest: string,
    options: RequestOptions = {},
  ): Promise<RoleDeletionResult> {
    const normalized = normalizeRoleDeletionRequest(request)
    if (!REVIEWED_PLAN_DIGEST_PATTERN.test(expectedDigest)) {
      throw new RangeError("Discord role-deletion plan digest is invalid")
    }
    return withGuildLock(
      normalized.guildId,
      () => this.#executeNormalized(
        applicationId,
        botId,
        normalized,
        expectedDigest,
        options,
      ),
      () => new RoleDeletionExecutionError(
        "Discord role deletion was blocked because a prior same-guild operation ended uncertain",
        {
          guildId: normalized.guildId,
          operationKeyHash: normalized.operationKeyHash,
          planDigest: expectedDigest,
          roleId: normalized.roleId,
          schemaVersion: SCHEMA_VERSION,
          status: "blocked-prior-uncertain",
        },
      ),
    )
  }

  async #executeNormalized(
    applicationId: string,
    botId: string,
    request: NormalizedRoleDeletionRequest,
    expectedDigest: string,
    options: RequestOptions,
  ): Promise<RoleDeletionResult> {
    let built: BuiltRoleDeletionPlan
    try {
      built = await this.#buildPlan(applicationId, botId, request, options)
    } catch (error) {
      if (
        error instanceof RoleDeletionEvidenceError
        || error instanceof DiscordRoleEvidenceError
        || error instanceof RangeError
        || error instanceof DiscordApiError && error.status === 404
      ) throw new RoleDeletionPlanChangedError(expectedDigest, STATE_UNAVAILABLE)
      throw error
    }
    const { plan, state } = built
    if (plan.digest !== expectedDigest) {
      throw new RoleDeletionPlanChangedError(expectedDigest, plan.digest)
    }
    const baseResult = {
      baselineRoleCount: plan.roleCount,
      blockerCount: plan.blockers.length,
      guildId: request.guildId,
      memberCount: plan.memberCount,
      operationKeyHash: request.operationKeyHash,
      planDigest: plan.digest,
      roleId: request.roleId,
      schemaVersion: SCHEMA_VERSION,
    }
    if (!plan.writeRequired) {
      return {
        ...baseResult,
        activityId: null,
        addedEvidence: noAddedEvidence(),
        observedRoleCount: null,
        status: "blocked",
        verification: "not-required",
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
      throw new RoleDeletionOperationConflictError(receiptView(reservation.receipt))
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
      throw new RoleDeletionExecutionError(
        "Discord role deletion was blocked because pending activity could not be recorded",
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

    let mutationAccepted = false
    let mutationStarted = false
    let verification: RoleDeletionVerification | null = null
    try {
      mutationStarted = true
      await this.#client.deleteGuildRole(
        request.guildId,
        request.roleId,
        request.auditReason,
        options,
      )
      mutationAccepted = true
      const observed = await this.#state(
        applicationId,
        botId,
        request.guildId,
        request.roleId,
        options,
        true,
      )
      verification = verifyDeletion(state, observed, request.roleId)
    } catch (error) {
      const settled = !mutationStarted || (
        !mutationAccepted
        && error instanceof DiscordApiError
        && error.status >= 400
        && error.status < 500
        && error.status !== 429
      )
      const status = settled ? "failed" : "uncertain"
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
      throw new RoleDeletionExecutionError(
        "Discord role deletion did not complete with a verified successful outcome",
        {
          ...baseResult,
          activityId,
          activityRecordError,
          error: errorCode,
          operationRecordError,
          retryAfterMs: error instanceof DiscordApiError ? error.retryAfterMs ?? null : null,
          status,
        },
        { cause: error },
      )
    }

    const completedStatus = verification.verification === "drift"
      ? "completed-with-drift" as const
      : "completed" as const
    const result: RoleDeletionResult = {
      ...baseResult,
      activityId,
      addedEvidence: verification.addedEvidence,
      observedRoleCount: verification.observedRoleCount,
      status: completedStatus,
      verification: verification.verification,
    }
    try {
      await this.#operationStore.finish(operationReceipt({
        activityId,
        plan,
        request,
        status: "completed",
        timestamp: this.#clock().toISOString(),
        verification: verification.verification,
      }))
    } catch (error) {
      let activityRecordError: string | null = null
      try {
        await this.#activityStore.append(activityEntry({
          activityId,
          error: safeErrorCode(error),
          observedRoleCount: verification.observedRoleCount,
          plan,
          request,
          status: "uncertain",
          timestamp: this.#clock().toISOString(),
        }))
      } catch (activityError) {
        activityRecordError = safeErrorCode(activityError)
      }
      throw new RoleDeletionExecutionError(
        "Discord role deletion completed but the operation receipt failed",
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
        observedRoleCount: verification.observedRoleCount,
        plan,
        request,
        status: completedStatus,
        timestamp: this.#clock().toISOString(),
        verification: verification.verification,
      }))
    } catch (error) {
      throw new RoleDeletionExecutionError(
        "Discord role deletion completed but the final activity record failed",
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
