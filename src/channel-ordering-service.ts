import { randomUUID } from "node:crypto"

import type {
  ActivityStore,
  ChannelOrderingActivity,
  ChannelOrderingActivityStatus,
} from "./activity-log.js"
import {
  DISCORD_CHANNEL_TYPES,
  DISCORD_LIMITS,
  DISCORD_SNOWFLAKE_MAX,
  DISCORD_SNOWFLAKE_PATTERN,
  SCHEMA_VERSION,
} from "./constants.js"
import {
  encodeDiscordAuditReason,
  type DiscordClient,
  type ModifyGuildChannelPositionInput,
} from "./discord-client.js"
import {
  ChannelOrderingEvidenceError,
  ChannelOrderingExecutionError,
  ChannelOrderingOperationConflictError,
  ChannelOrderingPlanChangedError,
  ChannelOrderingVerificationTimeoutError,
  DiscordApiError,
} from "./errors.js"
import type {
  GatewayChannelLayoutEntry,
  GatewayChannelLayoutSnapshot,
  GatewayChannelLayoutSource,
} from "./gateway-channel-layout.js"
import {
  collectGuildChannelEvidence,
  DIRECT_GUILD_CHANNEL_TYPES,
  exactGatewayChannelLayout,
  GuildChannelEvidenceError,
  type GuildChannelHttpEvidenceMode,
} from "./guild-channel-evidence.js"
import { isGuildChannelTopologyType } from "./guild-channel-types.js"
import { stableString } from "./normalize.js"
import {
  type OperationReceipt,
  type OperationStore,
  operationKeyHash,
} from "./operation-store.js"
import {
  discordPermissionNames,
  evaluateBotChannelPermissions,
  evaluateGuildMemberPermissions,
  hasGuildPermission,
  parseDiscordPermissionBits,
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

const STATE_UNAVAILABLE = "channel-ordering-state-unavailable"
const CHANNEL_ORDERING_LOCKS = new Map<string, Promise<ChannelOrderingTargetOutcome>>()
const CHANNEL_ORDERING_UNCERTAIN_GUILDS = new Set<string>()
const CHANNEL_NAME_CONTROL_PATTERN = /[\u0000-\u001F\u007F]/u
const DEFAULT_VERIFICATION_TIMEOUT_MS = 10_000
const MAX_VERIFICATION_TIMEOUT_MS = 60_000
const TEXT_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  DISCORD_CHANNEL_TYPES.announcement,
  DISCORD_CHANNEL_TYPES.forum,
  DISCORD_CHANNEL_TYPES.media,
  DISCORD_CHANNEL_TYPES.text,
])
const VOICE_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  DISCORD_CHANNEL_TYPES.stageVoice,
  DISCORD_CHANNEL_TYPES.voice,
])
const CHANNEL_RESPONSE_KEYS: ReadonlySet<string> = new Set([
  "applied_tags",
  "application_id",
  "available_tags",
  "bitrate",
  "default_auto_archive_duration",
  "default_forum_layout",
  "default_reaction_emoji",
  "default_sort_order",
  "default_tag_setting",
  "default_thread_rate_limit_per_user",
  "flags",
  "guild_id",
  "icon",
  "id",
  "last_message_id",
  "last_pin_timestamp",
  "managed",
  "member",
  "member_count",
  "message_count",
  "name",
  "nsfw",
  "owner_id",
  "parent_id",
  "permission_overwrites",
  "permissions",
  "position",
  "rate_limit_per_user",
  "recipients",
  "rtc_region",
  "thread_metadata",
  "topic",
  "total_message_sent",
  "type",
  "user_limit",
  "video_quality_mode",
])
const OVERWRITE_KEYS: ReadonlySet<string> = new Set([
  "allow",
  "deny",
  "id",
  "type",
])
const PRIVACY_OMISSIONS = Object.freeze([
  "auditReason",
  "channelContent",
  "hiddenChannelMetadata",
  "memberIdentities",
  "permissionOverwrites",
  "rawOperationKey",
  "rawPayloads",
] as const)

type ChannelOrderingTargetOutcome = "settled" | "uncertain"
export type ChannelOrderPlacement = "above" | "below"
export type ChannelOrderFamily = "category" | "text" | "unsupported" | "voice"
export type ChannelOrderMode = "cross-parent-move" | "same-parent-order"
export type ChannelOrderingHttpEvidenceMode = GuildChannelHttpEvidenceMode

export interface ChannelOrderingRequest {
  anchorChannelId: string
  auditReason: string
  channelId: string
  guildId: string
  operationKey: string
  placement: ChannelOrderPlacement
}

export interface NormalizedChannelOrderingRequest extends ChannelOrderingRequest {
  operationKeyHash: string
}

export interface ChannelOrderEntry {
  family: ChannelOrderFamily
  id: string
  metadataVisibility: "obfuscated" | "visible"
  name: string | null
  obfuscated: boolean
  parentChannelId: string | null
  rank: number
  rawPosition: number
  type: number
  unknownFieldCount: number | null
}

export interface ChannelOrderPermissionEvidence {
  administrator: boolean
  confidence: "complete" | "unavailable"
  effectivePermissionNames: DiscordPermissionName[]
  effectivePermissions: string | null
  manageChannels: boolean
  source: "guild" | "none" | "parent"
}

export interface ChannelOrderGroup {
  channels: ChannelOrderEntry[]
  family: ChannelOrderFamily
  parentChannelId: string | null
  permission: ChannelOrderPermissionEvidence
  unsupportedType: number | null
}

export interface ChannelOrderMovePermissionEvidence {
  administrator: boolean
  effectivePermissionNames: DiscordPermissionName[]
  effectivePermissions: string
  manageChannels: boolean
  viewChannel: boolean
}

export interface ChannelOrderParentCapacity {
  childCountAfter: number | null
  childCountBefore: number | null
  childLimit: number | null
  parentKind: "category" | "guild-root"
}

export interface ChannelOrderingPrivacyProjection {
  channelText: "transient-untrusted"
  hiddenMetadataReturned: false
  omittedFields: typeof PRIVACY_OMISSIONS
  persistence: "content-free-only"
}

export interface ChannelOrderAuditResult {
  applicationId: string
  botId: string
  groups: ChannelOrderGroup[]
  guild: {
    id: string
    name: string
    ownerId: string
  }
  httpEvidenceMode: ChannelOrderingHttpEvidenceMode
  layout: {
    obfuscatedChannels: number
    revision: number
    updatedAt: string
  }
  permission: {
    administrator: boolean
    botEffectivePermissionNames: DiscordPermissionName[]
    botEffectivePermissions: string
    confidence: "complete"
    guildManageChannels: boolean
  }
  privacy: ChannelOrderingPrivacyProjection
  schemaVersion: number
  status: "ok"
}

export interface ChannelOrderingAffectedChannel extends Omit<
  ChannelOrderEntry,
  "parentChannelId" | "rank"
> {
  afterParentChannelId: string | null
  afterRank: number
  beforeParentChannelId: string | null
  beforeRank: number
  submittedPosition: number
}

export interface ChannelOrderingPositionWrite {
  beforeRawPosition: number
  channelId: string
  parentChange: {
    destinationParentChannelId: string | null
    lockPermissions: false
    sourceParentChannelId: string | null
  } | null
  submittedPosition: number
}

export interface ChannelOrderingPlan {
  affectedChannels: ChannelOrderingAffectedChannel[]
  anchor: ChannelOrderEntry
  applicationId: string
  auditReason: string
  botId: string
  channel: ChannelOrderEntry
  createdAt: string
  current: {
    anchorRank: number
    channelRank: number
    destinationGroupOrder: string[]
    sourceGroupOrder: string[]
  }
  destinationCapacity: ChannelOrderParentCapacity
  destinationParentChannelId: string | null
  destinationPermission: ChannelOrderPermissionEvidence
  desired: {
    anchorRank: number
    channelRank: number
    destinationGroupOrder: string[]
    sourceGroupOrder: string[]
  }
  digest: string
  family: Exclude<ChannelOrderFamily, "unsupported">
  guild: ChannelOrderAuditResult["guild"]
  httpEvidenceMode: ChannelOrderingHttpEvidenceMode
  impact: {
    affectedChannelCount: number
    destinationGroupChannelCount: number
    parentChangeCount: number
    rankChangeCount: number
    rawPositionWriteCount: number
    sourceGroupChannelCount: number
  }
  layout: ChannelOrderAuditResult["layout"]
  mode: ChannelOrderMode
  operationKeyHash: string
  permissionOverwriteBehavior: "preserve"
  placement: ChannelOrderPlacement
  positionWrites: ChannelOrderingPositionWrite[]
  privacy: ChannelOrderingPrivacyProjection
  risks: string[]
  schemaVersion: number
  sourceCapacity: ChannelOrderParentCapacity
  sourceParentChannelId: string | null
  sourcePermission: ChannelOrderPermissionEvidence
  status: "already-current" | "planned"
  targetMovePermission: ChannelOrderMovePermissionEvidence | null
  warnings: string[]
  writeRequired: boolean
}

export interface ObservedChannelOrderEntry {
  id: string
  obfuscated: boolean
  parentChannelId: string | null
  rank: number
  rawPosition: number
  type: number
}

export interface ChannelOrderingResult {
  activityId: string | null
  anchorChannelId: string
  baselineLayoutRevision: number
  channelId: string
  guildId: string
  layoutMatched: boolean
  observedAffectedChannels: ObservedChannelOrderEntry[]
  observedLayoutRevision: number
  operationKeyHash: string
  planDigest: string
  schemaVersion: number
  status: "already-current" | "completed"
  verification: "match" | "not-required"
}

export interface ChannelOrderingServiceClient extends Pick<
  DiscordClient,
  | "getGuild"
  | "getGuildChannels"
  | "getGuildMember"
  | "getGuildRoles"
  | "modifyGuildChannelPositions"
> {}

export interface ChannelOrderingServiceOptions {
  activityStore: ActivityStore
  client: ChannelOrderingServiceClient
  clock?: () => Date
  layoutSource: GatewayChannelLayoutSource
  operationStore: OperationStore
  planKey?: Uint8Array
  policy: Pick<
    ScopePolicy,
    "assertChannelOrderingAuditable" | "assertChannelOrderingChangeable"
  >
  randomId?: () => string
  verificationTimeoutMs?: number
}

interface ValidatedGuild extends DiscordGuild {
  owner_id: string
}

interface HttpChannelEvidence {
  id: string
  metadataVisibility: "obfuscated" | "visible"
  name: string | null
  parentChannelId: string | null
  permissionOverwrites: DiscordPermissionOverwrite[] | null
  position: number
  type: number
  unknownFieldCount: number | null
}

interface ChannelOrderingState {
  botMember: DiscordGuildMember
  groups: ChannelOrderGroup[]
  guild: ValidatedGuild
  guildPermission: GuildMemberPermissionResult
  httpChannels: HttpChannelEvidence[]
  httpEvidenceMode: ChannelOrderingHttpEvidenceMode
  layout: GatewayChannelLayoutSnapshot
  rawRoles: DiscordRole[]
  roles: NormalizedDiscordRole[]
}

interface BuiltChannelOrderingPlan {
  baselineLayout: GatewayChannelLayoutSnapshot
  expectedTopology: readonly GatewayChannelLayoutEntry[]
  expectedGroupOrders: ReadonlyMap<string, readonly string[]>
  plan: ChannelOrderingPlan
  request: NormalizedChannelOrderingRequest
  targetHttpEvidence: HttpChannelEvidence
}

interface LayoutVerificationWatch {
  arm(): void
  close(): void
  latest(): GatewayChannelLayoutSnapshot | null
  wait(signal?: AbortSignal): Promise<GatewayChannelLayoutSnapshot>
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function snowflake(value: unknown): string | undefined {
  if (typeof value !== "string" || !DISCORD_SNOWFLAKE_PATTERN.test(value)) {
    return undefined
  }
  const parsed = BigInt(value)
  return parsed >= 1n && parsed <= DISCORD_SNOWFLAKE_MAX ? value : undefined
}

function assertSnowflake(value: unknown, description: string): asserts value is string {
  if (!snowflake(value)) throw new RangeError(`${description} must be an exact Discord snowflake`)
}

function validUnicode(value: string): boolean {
  try {
    encodeURIComponent(value)
    return true
  } catch {
    return false
  }
}

function compareSnowflakes(left: string, right: string): number {
  const leftId = BigInt(left)
  const rightId = BigInt(right)
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
}

function compareLayoutEntries(
  left: Pick<GatewayChannelLayoutEntry, "channelId" | "position">,
  right: Pick<GatewayChannelLayoutEntry, "channelId" | "position">,
): number {
  return left.position - right.position
    || compareSnowflakes(left.channelId, right.channelId)
}

function evidenceError(message: string, cause?: unknown): ChannelOrderingEvidenceError {
  return new ChannelOrderingEvidenceError(
    message,
    cause === undefined ? undefined : { cause },
  )
}

export function normalizeChannelOrderingRequest(
  request: ChannelOrderingRequest,
): NormalizedChannelOrderingRequest {
  if (
    !request
    || typeof request !== "object"
    || Array.isArray(request)
    || !hasOnlyKeys(request as unknown as Record<string, unknown>, [
      "anchorChannelId",
      "auditReason",
      "channelId",
      "guildId",
      "operationKey",
      "placement",
    ])
    || typeof request.auditReason !== "string"
    || typeof request.operationKey !== "string"
  ) throw new RangeError("Discord channel-ordering request must be an exact object")
  assertSnowflake(request.guildId, "Discord channel-ordering guild ID")
  assertSnowflake(request.channelId, "Discord channel-ordering channel ID")
  assertSnowflake(request.anchorChannelId, "Discord channel-ordering anchor channel ID")
  if (request.channelId === request.anchorChannelId) {
    throw new RangeError("Discord channel-ordering target and anchor channels must be distinct")
  }
  if (request.placement !== "above" && request.placement !== "below") {
    throw new RangeError("Discord channel-ordering placement must be above or below")
  }
  encodeDiscordAuditReason(request.auditReason)
  return {
    ...request,
    operationKeyHash: operationKeyHash(request.operationKey),
  }
}

function exactGuild(value: DiscordGuild, guildId: string): ValidatedGuild {
  const ownerId = snowflake(value?.owner_id)
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || value.id !== guildId
    || typeof value.name !== "string"
    || value.name.length < 1
    || value.name.length > 100
    || CHANNEL_NAME_CONTROL_PATTERN.test(value.name)
    || !validUnicode(value.name)
    || !ownerId
  ) throw evidenceError("Discord returned invalid channel-ordering guild evidence")
  return { ...value, owner_id: ownerId }
}

function exactBotMember(
  value: DiscordGuildMember,
  botId: string,
  roles: readonly NormalizedDiscordRole[],
  guildId: string,
): DiscordGuildMember {
  const roleIds = new Set(roles.map((role) => role.id))
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !value.user
    || value.user.id !== botId
    || value.user.bot !== true
    || !Array.isArray(value.roles)
    || value.roles.length > DISCORD_LIMITS.guildRoles
    || value.roles.includes(guildId)
    || value.roles.some((roleId) => !snowflake(roleId) || !roleIds.has(roleId))
    || new Set(value.roles).size !== value.roles.length
  ) throw evidenceError("Discord returned invalid connector membership for channel ordering")
  return {
    ...value,
    roles: [...value.roles].sort(compareSnowflakes),
    user: {
      bot: true,
      id: botId,
      username: typeof value.user.username === "string" ? value.user.username : "connector",
    },
  }
}

function exactGuildPermissions(
  guildId: string,
  member: DiscordGuildMember,
  roles: readonly DiscordRole[],
): GuildMemberPermissionResult {
  let result: GuildMemberPermissionResult
  try {
    result = evaluateGuildMemberPermissions({ guildId, member, roles })
  } catch (error) {
    throw evidenceError("Discord connector channel-ordering permission evidence is invalid", error)
  }
  if (!result.complete) {
    throw evidenceError(
      `Discord connector channel-ordering permission evidence is incomplete: ${result.warnings.join("; ")}`,
    )
  }
  return result
}

function exactLayout(
  value: GatewayChannelLayoutSnapshot,
  guildId: string,
): GatewayChannelLayoutSnapshot {
  try {
    return exactGatewayChannelLayout(value, guildId)
  } catch (error) {
    throw evidenceError("Discord Gateway channel-ordering layout evidence is invalid", error)
  }
}

function exactName(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > DISCORD_LIMITS.channelNameCharacters
    || CHANNEL_NAME_CONTROL_PATTERN.test(value)
    || !validUnicode(value)
  ) throw evidenceError("Discord returned invalid channel-ordering channel text")
  return value
}

function exactOverwrites(value: unknown): {
  overwrites: DiscordPermissionOverwrite[]
  unknownFieldCount: number
} {
  if (!Array.isArray(value) || value.length > DISCORD_LIMITS.channelPermissionOverwrites) {
    throw evidenceError("Discord returned invalid channel-ordering overwrite evidence")
  }
  const seen = new Set<string>()
  let unknownFieldCount = 0
  const overwrites = value.map((entry) => {
    const record = recordValue(entry)
    const id = snowflake(record?.id)
    if (
      !record
      || !id
      || (record.type !== 0 && record.type !== 1)
      || typeof record.allow !== "string"
      || typeof record.deny !== "string"
      || seen.has(id)
    ) throw evidenceError("Discord returned invalid channel-ordering overwrite evidence")
    let allow: bigint
    let deny: bigint
    try {
      allow = parseDiscordPermissionBits(record.allow, "channel-ordering overwrite allow")
      deny = parseDiscordPermissionBits(record.deny, "channel-ordering overwrite deny")
    } catch (error) {
      throw evidenceError("Discord returned invalid channel-ordering overwrite evidence", error)
    }
    if ((allow & deny) !== 0n) {
      throw evidenceError("Discord returned conflicting channel-ordering overwrite evidence")
    }
    seen.add(id)
    unknownFieldCount += Object.keys(record)
      .filter((key) => !OVERWRITE_KEYS.has(key)).length
    return {
      allow: record.allow,
      deny: record.deny,
      id,
      type: record.type,
    }
  }).sort((left, right) => (
    compareSnowflakes(left.id, right.id) || left.type - right.type
  ))
  return { overwrites, unknownFieldCount }
}

function exactHttpChannels(
  value: readonly DiscordChannel[],
  layout: GatewayChannelLayoutSnapshot,
  mode: ChannelOrderingHttpEvidenceMode,
): {
  channels: HttpChannelEvidence[]
  mode: ChannelOrderingHttpEvidenceMode
} {
  const layoutById = new Map(layout.channels.map((channel) => [channel.channelId, channel]))
  const channels = new Map<string, HttpChannelEvidence>()
  for (const rawChannel of value) {
    const record = recordValue(rawChannel)
    const id = snowflake(record?.id)
    const parentChannelId = record?.parent_id === undefined || record.parent_id === null
      ? null
      : snowflake(record.parent_id)
    const position = record?.position
    const type = record?.type
    if (
      !record
      || !id
      || channels.has(id)
      || !(record.parent_id === undefined || record.parent_id === null || parentChannelId)
      || !Number.isSafeInteger(position)
      || (position as number) < 0
      || !Number.isSafeInteger(type)
      || !isGuildChannelTopologyType(type)
    ) throw evidenceError("Discord returned invalid channel-ordering HTTP inventory evidence")
    const layoutChannel = layoutById.get(id)
    if (
      !layoutChannel
      || layoutChannel.obfuscated
      || layoutChannel.type !== type
      || layoutChannel.position !== position
      || layoutChannel.parentChannelId !== parentChannelId
    ) throw evidenceError("Discord HTTP and Gateway channel-ordering evidence do not match")
    const recognizedType = DIRECT_GUILD_CHANNEL_TYPES.has(type)
    const projectedOverwrites = recognizedType
      ? exactOverwrites(record.permission_overwrites)
      : { overwrites: [], unknownFieldCount: 0 }
    channels.set(id, {
      id,
      metadataVisibility: "visible",
      name: recognizedType ? exactName(record.name) : null,
      parentChannelId,
      permissionOverwrites: projectedOverwrites.overwrites,
      position: position as number,
      type: type as number,
      unknownFieldCount: Object.keys(record)
        .filter((key) => !CHANNEL_RESPONSE_KEYS.has(key)).length
        + projectedOverwrites.unknownFieldCount,
    })
  }
  for (const layoutChannel of layout.channels) {
    if (!layoutChannel.obfuscated) {
      if (!channels.has(layoutChannel.channelId)) {
        throw evidenceError("Discord channel-ordering metadata evidence is incomplete")
      }
      continue
    }
    channels.set(layoutChannel.channelId, {
      id: layoutChannel.channelId,
      metadataVisibility: "obfuscated",
      name: null,
      parentChannelId: layoutChannel.parentChannelId,
      permissionOverwrites: null,
      position: layoutChannel.position,
      type: layoutChannel.type,
      unknownFieldCount: null,
    })
  }
  return {
    channels: [...channels.values()].sort((left, right) => compareSnowflakes(left.id, right.id)),
    mode,
  }
}

function channelFamily(type: number): ChannelOrderFamily {
  if (type === DISCORD_CHANNEL_TYPES.category) return "category"
  if (TEXT_CHANNEL_TYPES.has(type)) return "text"
  if (VOICE_CHANNEL_TYPES.has(type)) return "voice"
  return "unsupported"
}

function groupKey(
  parentChannelId: string | null,
  family: ChannelOrderFamily,
  unsupportedType: number | null,
): string {
  return `${parentChannelId ?? "top"}\0${family}\0${unsupportedType ?? "supported"}`
}

function channelGroupKey(channel: GatewayChannelLayoutEntry): string {
  const family = channelFamily(channel.type)
  return groupKey(
    channel.parentChannelId,
    family,
    family === "unsupported" ? channel.type : null,
  )
}

function groupOrders(
  channels: readonly GatewayChannelLayoutEntry[],
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, GatewayChannelLayoutEntry[]>()
  for (const channel of channels) {
    const key = channelGroupKey(channel)
    const entries = grouped.get(key) ?? []
    entries.push(channel)
    grouped.set(key, entries)
  }
  return new Map([...grouped].map(([key, entries]) => [
    key,
    entries.sort(compareLayoutEntries).map((channel) => channel.channelId),
  ]))
}

function groupPermission(
  botId: string,
  guildId: string,
  parentChannelId: string | null,
  guildPermission: GuildMemberPermissionResult,
  httpById: ReadonlyMap<string, HttpChannelEvidence>,
  member: DiscordGuildMember,
  roles: readonly DiscordRole[],
): ChannelOrderPermissionEvidence {
  const administrator = guildPermission.administrator
  if (hasGuildPermission(guildPermission, "MANAGE_CHANNELS")) {
    return {
      administrator,
      confidence: "complete",
      effectivePermissionNames: discordPermissionNames(
        BigInt(guildPermission.effectivePermissions),
      ),
      effectivePermissions: guildPermission.effectivePermissions,
      manageChannels: true,
      source: "guild",
    }
  }
  if (parentChannelId === null) {
    return {
      administrator,
      confidence: "complete",
      effectivePermissionNames: discordPermissionNames(
        BigInt(guildPermission.effectivePermissions),
      ),
      effectivePermissions: guildPermission.effectivePermissions,
      manageChannels: false,
      source: "none",
    }
  }
  const parent = httpById.get(parentChannelId)
  if (
    !parent
    || parent.metadataVisibility !== "visible"
    || parent.permissionOverwrites === null
  ) {
    return {
      administrator,
      confidence: "unavailable",
      effectivePermissionNames: [],
      effectivePermissions: null,
      manageChannels: false,
      source: "none",
    }
  }
  let evaluated
  try {
    const category: DiscordChannel = {
      guild_id: guildId,
      id: parent.id,
      name: parent.name,
      parent_id: null,
      permission_overwrites: parent.permissionOverwrites,
      position: parent.position,
      type: DISCORD_CHANNEL_TYPES.category,
    }
    evaluated = evaluateBotChannelPermissions({
      botId,
      channel: category,
      guildId,
      member,
      permissionChannel: category,
      roles,
    })
  } catch (error) {
    throw evidenceError("Discord parent channel-ordering permission evidence is invalid", error)
  }
  if (evaluated.confidence !== "complete") {
    throw evidenceError(
      `Discord parent channel-ordering permission evidence is incomplete: ${evaluated.warnings.join("; ")}`,
    )
  }
  const manageChannels = evaluated.effectivePermissionNames.includes("MANAGE_CHANNELS")
  return {
    administrator: evaluated.administrator,
    confidence: "complete",
    effectivePermissionNames: evaluated.effectivePermissionNames,
    effectivePermissions: evaluated.effectivePermissions,
    manageChannels,
    source: manageChannels ? "parent" : "none",
  }
}

function targetMovePermission(
  botId: string,
  guildId: string,
  target: HttpChannelEvidence,
  member: DiscordGuildMember,
  roles: readonly DiscordRole[],
): ChannelOrderMovePermissionEvidence {
  if (
    target.metadataVisibility !== "visible"
    || target.name === null
    || target.permissionOverwrites === null
  ) {
    throw evidenceError("Discord cross-parent channel moves require visible exact target evidence")
  }
  let evaluated
  try {
    const channel: DiscordChannel = {
      guild_id: guildId,
      id: target.id,
      name: target.name,
      parent_id: target.parentChannelId,
      permission_overwrites: target.permissionOverwrites,
      position: target.position,
      type: target.type,
    }
    evaluated = evaluateBotChannelPermissions({
      botId,
      channel,
      guildId,
      member,
      permissionChannel: channel,
      roles,
    })
  } catch (error) {
    throw evidenceError("Discord target channel-move permission evidence is invalid", error)
  }
  if (evaluated.confidence !== "complete") {
    throw evidenceError(
      `Discord target channel-move permission evidence is incomplete: ${evaluated.warnings.join("; ")}`,
    )
  }
  const manageChannels = evaluated.effectivePermissionNames.includes("MANAGE_CHANNELS")
  const viewChannel = evaluated.effectivePermissionNames.includes("VIEW_CHANNEL")
  if (!manageChannels || !viewChannel) {
    throw evidenceError(
      "Discord connector lacks complete VIEW_CHANNEL and MANAGE_CHANNELS authority on the moved channel",
    )
  }
  return {
    administrator: evaluated.administrator,
    effectivePermissionNames: evaluated.effectivePermissionNames,
    effectivePermissions: evaluated.effectivePermissions,
    manageChannels,
    viewChannel,
  }
}

function parentCapacity(
  layout: GatewayChannelLayoutSnapshot,
  parentChannelId: string | null,
  childCountDelta: -1 | 0 | 1,
): ChannelOrderParentCapacity {
  if (parentChannelId === null) {
    return {
      childCountAfter: null,
      childCountBefore: null,
      childLimit: null,
      parentKind: "guild-root",
    }
  }
  const parent = layout.channels.find((entry) => (
    entry.channelId === parentChannelId
  ))
  if (
    !parent
    || parent.type !== DISCORD_CHANNEL_TYPES.category
    || parent.parentChannelId !== null
  ) throw evidenceError("Discord channel-ordering parent is not an exact root category")
  const childCountBefore = layout.channels.filter((entry) => (
    entry.parentChannelId === parentChannelId
  )).length
  const childCountAfter = childCountBefore + childCountDelta
  if (childCountAfter < 0) {
    throw evidenceError("Discord channel-ordering parent capacity evidence is inconsistent")
  }
  if (childCountAfter > DISCORD_LIMITS.categoryChannels) {
    throw evidenceError("Discord channel-ordering destination category is at capacity")
  }
  return {
    childCountAfter,
    childCountBefore,
    childLimit: DISCORD_LIMITS.categoryChannels,
    parentKind: "category",
  }
}

function buildGroups(options: {
  botId: string
  guildId: string
  guildPermission: GuildMemberPermissionResult
  httpChannels: readonly HttpChannelEvidence[]
  layout: GatewayChannelLayoutSnapshot
  member: DiscordGuildMember
  rawRoles: readonly DiscordRole[]
}): ChannelOrderGroup[] {
  const httpById = new Map(options.httpChannels.map((channel) => [channel.id, channel]))
  const grouped = new Map<string, {
    channels: GatewayChannelLayoutEntry[]
    family: ChannelOrderFamily
    parentChannelId: string | null
    unsupportedType: number | null
  }>()
  for (const channel of options.layout.channels) {
    const family = channelFamily(channel.type)
    const unsupportedType = family === "unsupported" ? channel.type : null
    const key = groupKey(channel.parentChannelId, family, unsupportedType)
    const group = grouped.get(key) ?? {
      channels: [],
      family,
      parentChannelId: channel.parentChannelId,
      unsupportedType,
    }
    group.channels.push(channel)
    grouped.set(key, group)
  }
  const familyRank: Readonly<Record<ChannelOrderFamily, number>> = {
    category: 0,
    text: 1,
    voice: 2,
    unsupported: 3,
  }
  return [...grouped.values()]
    .sort((left, right) => {
      if (left.parentChannelId === null && right.parentChannelId !== null) return -1
      if (left.parentChannelId !== null && right.parentChannelId === null) return 1
      if (left.parentChannelId && right.parentChannelId) {
        const parentOrder = compareSnowflakes(left.parentChannelId, right.parentChannelId)
        if (parentOrder !== 0) return parentOrder
      }
      return familyRank[left.family] - familyRank[right.family]
        || (left.unsupportedType ?? 0) - (right.unsupportedType ?? 0)
    })
    .map((group) => ({
      channels: group.channels.sort(compareLayoutEntries).map((channel, rank) => {
        const metadata = httpById.get(channel.channelId)
        return {
          family: group.family,
          id: channel.channelId,
          metadataVisibility: channel.obfuscated ? "obfuscated" : "visible",
          name: channel.obfuscated ? null : metadata?.name ?? null,
          obfuscated: channel.obfuscated,
          parentChannelId: channel.parentChannelId,
          rank,
          rawPosition: channel.position,
          type: channel.type,
          unknownFieldCount: channel.obfuscated
            ? null
            : metadata?.unknownFieldCount ?? null,
        }
      }),
      family: group.family,
      parentChannelId: group.parentChannelId,
      permission: groupPermission(
        options.botId,
        options.guildId,
        group.parentChannelId,
        options.guildPermission,
        httpById,
        options.member,
        options.rawRoles,
      ),
      unsupportedType: group.unsupportedType,
    }))
}

function privacyProjection(): ChannelOrderingPrivacyProjection {
  return {
    channelText: "transient-untrusted",
    hiddenMetadataReturned: false,
    omittedFields: PRIVACY_OMISSIONS,
    persistence: "content-free-only",
  }
}

function memberSnapshot(member: DiscordGuildMember) {
  return {
    roles: [...member.roles].sort(compareSnowflakes),
    user: {
      bot: member.user?.bot,
      id: member.user?.id,
    },
  }
}

function rolesSnapshot(roles: readonly NormalizedDiscordRole[]) {
  return [...roles]
    .sort((left, right) => compareSnowflakes(left.id, right.id))
    .map((role) => ({
      id: role.id,
      managed: role.managed,
      permissions: role.permissions,
      position: role.position,
      unknownFieldCount: role.unknownFieldCount,
      unknownPermissionBits: role.unknownPermissionBits,
    }))
}

function httpSnapshot(channels: readonly HttpChannelEvidence[]) {
  return channels.map((channel) => ({
    id: channel.id,
    metadataVisibility: channel.metadataVisibility,
    name: channel.name,
    parentChannelId: channel.parentChannelId,
    permissionOverwrites: channel.permissionOverwrites,
    position: channel.position,
    type: channel.type,
    unknownFieldCount: channel.unknownFieldCount,
  }))
}

function desiredOrder(
  destinationOrder: readonly ChannelOrderEntry[],
  target: ChannelOrderEntry,
  request: NormalizedChannelOrderingRequest,
): ChannelOrderEntry[] {
  const remaining = destinationOrder.filter((entry) => entry.id !== request.channelId)
  const anchorIndex = remaining.findIndex((entry) => entry.id === request.anchorChannelId)
  if (anchorIndex < 0) throw evidenceError("Discord channel-ordering anchor is missing")
  const insertionIndex = request.placement === "above" ? anchorIndex : anchorIndex + 1
  return [
    ...remaining.slice(0, insertionIndex),
    target,
    ...remaining.slice(insertionIndex),
  ]
}

function affectedChannels(
  currentGroups: readonly (readonly ChannelOrderEntry[])[],
  desiredGroups: readonly (readonly ChannelOrderEntry[])[],
): ChannelOrderingAffectedChannel[] {
  const current = new Map<string, { entry: ChannelOrderEntry; rank: number }>()
  const desired = new Map<string, { entry: ChannelOrderEntry; rank: number }>()
  for (const group of currentGroups) {
    group.forEach((entry, rank) => current.set(entry.id, { entry, rank }))
  }
  for (const group of desiredGroups) {
    group.forEach((entry, rank) => desired.set(entry.id, { entry, rank }))
  }
  if (current.size !== desired.size) {
    throw evidenceError("Discord channel-ordering affected groups are incomplete")
  }
  return [...current].flatMap(([id, before]) => {
    const after = desired.get(id)
    if (!after) throw evidenceError("Discord channel-ordering affected groups are incomplete")
    if (
      before.rank === after.rank
      && before.entry.parentChannelId === after.entry.parentChannelId
    ) return []
    const { parentChannelId: beforeParentChannelId, rank: _rank, ...projected } = before.entry
    return [{
      ...projected,
      afterParentChannelId: after.entry.parentChannelId,
      afterRank: after.rank,
      beforeParentChannelId,
      beforeRank: before.rank,
      submittedPosition: after.rank,
    }]
  }).sort((left, right) => (
    compareSnowflakes(left.id, right.id)
  ))
}

function safeErrorCode(error: unknown): string {
  if (error instanceof DiscordApiError) {
    return `DiscordApiError.${error.status}.${error.code ?? "unknown"}`
  }
  const name = error instanceof Error ? error.name : "UnknownError"
  const normalized = name.replace(/[^A-Za-z0-9._:-]/gu, "").slice(0, 128)
  return normalized || "UnknownError"
}

function activityEntry(options: {
  activityId: string
  error?: string | null
  observedRevision?: number | null
  plan: ChannelOrderingPlan
  request: NormalizedChannelOrderingRequest
  status: ChannelOrderingActivityStatus
  timestamp: string
  verification?: "match" | null
}): ChannelOrderingActivity {
  return {
    anchorChannelId: options.request.anchorChannelId,
    baselineRevision: options.plan.layout.revision,
    channelId: options.request.channelId,
    destinationParentChannelId: options.plan.destinationParentChannelId,
    error: options.error ?? null,
    guildId: options.request.guildId,
    id: options.activityId,
    kind: "channel-ordering",
    observedRevision: options.observedRevision ?? null,
    operationKeyHash: options.request.operationKeyHash,
    placement: options.request.placement,
    planDigest: options.plan.digest,
    schemaVersion: SCHEMA_VERSION,
    sourceParentChannelId: options.plan.sourceParentChannelId,
    status: options.status,
    timestamp: options.timestamp,
    verification: options.verification ?? null,
  }
}

function operationReceipt(options: {
  activityId: string
  error?: string | null
  plan: ChannelOrderingPlan
  request: NormalizedChannelOrderingRequest
  status: OperationReceipt["status"]
  timestamp: string
  verification?: "match" | null
}): OperationReceipt {
  return {
    activityId: options.activityId,
    error: options.error ?? null,
    guildId: options.request.guildId,
    kind: "channel-ordering",
    operationKeyHash: options.request.operationKeyHash,
    planDigest: options.plan.digest,
    resourceId: options.status === "completed" || options.status === "uncertain"
      ? options.request.channelId
      : null,
    schemaVersion: 1,
    status: options.status,
    timestamp: options.timestamp,
    verification: options.verification ?? null,
  }
}

function receiptView(receipt: OperationReceipt) {
  return {
    activityId: receipt.activityId,
    channelId: receipt.resourceId,
    error: receipt.error,
    guildId: receipt.guildId,
    operationKeyHash: receipt.operationKeyHash,
    status: receipt.status,
    timestamp: receipt.timestamp,
    verification: receipt.verification,
  }
}

function uncertainExecution(error: unknown): boolean {
  if (
    !(error instanceof ChannelOrderingExecutionError)
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
  priorUncertainError: () => ChannelOrderingExecutionError,
): Promise<T> {
  const prior = CHANNEL_ORDERING_LOCKS.get(guildId) ?? Promise.resolve(
    CHANNEL_ORDERING_UNCERTAIN_GUILDS.has(guildId)
      ? "uncertain" as const
      : "settled" as const,
  )
  let release: (outcome: ChannelOrderingTargetOutcome) => void = () => undefined
  const tail = new Promise<ChannelOrderingTargetOutcome>((resolve) => {
    release = resolve
  })
  CHANNEL_ORDERING_LOCKS.set(guildId, tail)
  let outcome: ChannelOrderingTargetOutcome = "settled"
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
    if (outcome === "uncertain") CHANNEL_ORDERING_UNCERTAIN_GUILDS.add(guildId)
    release(outcome)
    if (CHANNEL_ORDERING_LOCKS.get(guildId) === tail) {
      CHANNEL_ORDERING_LOCKS.delete(guildId)
    }
  }
}

function sameTopology(
  expected: readonly GatewayChannelLayoutEntry[],
  observed: GatewayChannelLayoutSnapshot,
): boolean {
  if (expected.length !== observed.channels.length) return false
  const observedById = new Map(observed.channels.map((channel) => [channel.channelId, channel]))
  return expected.every((channel) => {
    const candidate = observedById.get(channel.channelId)
    return candidate
      && candidate.type === channel.type
      && candidate.parentChannelId === channel.parentChannelId
      && candidate.obfuscated === channel.obfuscated
  })
}

function matchingLayout(
  baseline: GatewayChannelLayoutSnapshot,
  observed: GatewayChannelLayoutSnapshot,
  expectedTopology: readonly GatewayChannelLayoutEntry[],
  expectedGroupOrders: ReadonlyMap<string, readonly string[]>,
): boolean {
  if (
    observed.revision <= baseline.revision
    || !sameTopology(expectedTopology, observed)
  ) {
    return false
  }
  const observedOrders = groupOrders(observed.channels)
  if (observedOrders.size !== expectedGroupOrders.size) return false
  for (const [key, expectedIds] of expectedGroupOrders) {
    if (stableString(observedOrders.get(key)) !== stableString(expectedIds)) return false
  }
  return true
}

function layoutVerificationWatch(options: {
  baseline: GatewayChannelLayoutSnapshot
  expectedGroupOrders: ReadonlyMap<string, readonly string[]>
  expectedTopology: readonly GatewayChannelLayoutEntry[]
  guildId: string
  source: GatewayChannelLayoutSource
  timeoutMs: number
}): LayoutVerificationWatch {
  let armed = false
  let closed = false
  let latest: GatewayChannelLayoutSnapshot | null = null
  let matched: GatewayChannelLayoutSnapshot | null = null
  let notify: (() => void) | null = null
  const inspect = () => {
    if (closed) return
    try {
      const candidate = exactLayout(
        options.source.getChannelLayout(options.guildId),
        options.guildId,
      )
      if (candidate.revision <= options.baseline.revision) return
      latest = candidate
      if (
        armed
        && matchingLayout(
          options.baseline,
          candidate,
          options.expectedTopology,
          options.expectedGroupOrders,
        )
      ) {
        matched = candidate
        notify?.()
      }
    } catch {}
  }
  const unsubscribe = options.source.subscribeChannelLayouts((guildId) => {
    if (guildId === options.guildId) inspect()
  })
  inspect()
  return {
    arm() {
      if (closed || armed) {
        throw evidenceError("Discord channel-ordering verification watch is not armable")
      }
      const current = exactLayout(
        options.source.getChannelLayout(options.guildId),
        options.guildId,
      )
      if (
        current.revision !== options.baseline.revision
        || stableString(current.channels) !== stableString(options.baseline.channels)
      ) throw evidenceError("Discord channel-ordering layout changed before mutation")
      armed = true
    },
    close() {
      if (closed) return
      closed = true
      unsubscribe()
    },
    latest() {
      return latest
    },
    wait(signal?: AbortSignal) {
      inspect()
      if (matched) return Promise.resolve(matched)
      return new Promise<GatewayChannelLayoutSnapshot>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let abort: () => void = () => undefined
        const finish = (snapshot?: GatewayChannelLayoutSnapshot) => {
          if (timer !== undefined) clearTimeout(timer)
          signal?.removeEventListener("abort", abort)
          notify = null
          if (snapshot) resolve(snapshot)
          else reject(new ChannelOrderingVerificationTimeoutError(
              "Discord channel-ordering Gateway verification did not complete",
          ))
        }
        abort = () => finish()
        notify = () => finish(matched ?? undefined)
        if (signal?.aborted) {
          finish()
          return
        }
        signal?.addEventListener("abort", abort, { once: true })
        timer = setTimeout(() => finish(), options.timeoutMs)
        inspect()
        if (matched) finish(matched)
      })
    },
  }
}

function observedEntries(
  snapshot: GatewayChannelLayoutSnapshot,
  affectedChannelIds: ReadonlySet<string>,
): ObservedChannelOrderEntry[] {
  const ranks = new Map<string, number>()
  for (const ids of groupOrders(snapshot.channels).values()) {
    ids.forEach((id, rank) => ranks.set(id, rank))
  }
  return snapshot.channels.flatMap((channel) => {
    if (!affectedChannelIds.has(channel.channelId)) return []
    const rank = ranks.get(channel.channelId)
    if (rank === undefined) return []
    return [{
      id: channel.channelId,
      obfuscated: channel.obfuscated,
      parentChannelId: channel.parentChannelId,
      rank,
      rawPosition: channel.position,
      type: channel.type,
    }]
  }).sort((left, right) => compareSnowflakes(left.id, right.id))
}

function verifyHttpReadback(
  value: readonly DiscordChannel[],
  observed: GatewayChannelLayoutSnapshot,
  mode: ChannelOrderingHttpEvidenceMode,
  targetBefore: HttpChannelEvidence,
): void {
  const projected = exactHttpChannels(value, observed, mode)
  const targetAfter = projected.channels.find((entry) => entry.id === targetBefore.id)
  if (!targetAfter) {
    throw evidenceError("Discord channel-ordering readback omitted the exact target")
  }
  if (
    targetAfter.metadataVisibility !== targetBefore.metadataVisibility
    || targetAfter.type !== targetBefore.type
    || stableString(targetAfter.permissionOverwrites)
      !== stableString(targetBefore.permissionOverwrites)
  ) {
    throw evidenceError(
      "Discord channel-ordering readback did not preserve exact target semantics and overwrites",
    )
  }
}

export class ChannelOrderingService {
  readonly #activityStore: ActivityStore
  readonly #client: ChannelOrderingServiceClient
  readonly #clock: () => Date
  readonly #layoutSource: GatewayChannelLayoutSource
  readonly #operationStore: OperationStore
  readonly #planKey: Uint8Array
  readonly #policy: ChannelOrderingServiceOptions["policy"]
  readonly #randomId: () => string
  readonly #verificationTimeoutMs: number

  constructor(options: ChannelOrderingServiceOptions) {
    const verificationTimeoutMs = options.verificationTimeoutMs
      ?? DEFAULT_VERIFICATION_TIMEOUT_MS
    if (
      !Number.isSafeInteger(verificationTimeoutMs)
      || verificationTimeoutMs < 1
      || verificationTimeoutMs > MAX_VERIFICATION_TIMEOUT_MS
    ) throw new RangeError("Discord channel-ordering verification timeout is invalid")
    this.#activityStore = options.activityStore
    this.#client = options.client
    this.#clock = options.clock ?? (() => new Date())
    this.#layoutSource = options.layoutSource
    this.#operationStore = options.operationStore
    this.#planKey = options.planKey ?? createReviewedPlanKey()
    this.#policy = options.policy
    this.#randomId = options.randomId ?? randomUUID
    this.#verificationTimeoutMs = verificationTimeoutMs
  }

  async #state(
    botId: string,
    guildId: string,
    options: RequestOptions,
  ): Promise<ChannelOrderingState> {
    if (!this.#layoutSource.layoutEnabled) {
      throw evidenceError("Discord Gateway channel-ordering layout is disabled")
    }
    let supportingEvidence: {
      guild: DiscordGuild
      member: DiscordGuildMember
      roles: DiscordRole[]
    } | undefined
    let channelEvidence
    try {
      channelEvidence = await collectGuildChannelEvidence({
        guildId,
        layoutSource: this.#layoutSource,
        readChannels: async () => {
          const [guild, member, roles, channels] = await Promise.all([
            this.#client.getGuild(guildId, options),
            this.#client.getGuildMember(guildId, botId, options),
            this.#client.getGuildRoles(guildId, options),
            this.#client.getGuildChannels(guildId, options),
          ])
          supportingEvidence = { guild, member, roles }
          return channels
        },
      })
    } catch (error) {
      if (error instanceof GuildChannelEvidenceError) {
        throw evidenceError(
          `Discord channel-ordering evidence is incomplete: ${error.message}`,
          error,
        )
      }
      throw error
    }
    if (!supportingEvidence) {
      throw evidenceError("Discord channel-ordering supporting evidence is unavailable")
    }
    const {
      guild: guildValue,
      member: memberValue,
      roles: rawRoles,
    } = supportingEvidence
    const after = channelEvidence.layout
    const guild = exactGuild(guildValue, guildId)
    let roles: NormalizedDiscordRole[]
    try {
      roles = normalizeDiscordRoleInventory(rawRoles, guildId)
    } catch (error) {
      throw evidenceError("Discord returned invalid channel-ordering role evidence", error)
    }
    const botMember = exactBotMember(memberValue, botId, roles, guildId)
    const guildPermission = exactGuildPermissions(guildId, botMember, rawRoles)
    const http = exactHttpChannels(
      channelEvidence.channels,
      after,
      channelEvidence.view.httpMode,
    )
    const groups = buildGroups({
      botId,
      guildId,
      guildPermission,
      httpChannels: http.channels,
      layout: after,
      member: botMember,
      rawRoles,
    })
    return {
      botMember,
      groups,
      guild,
      guildPermission,
      httpChannels: http.channels,
      httpEvidenceMode: http.mode,
      layout: after,
      rawRoles,
      roles,
    }
  }

  async audit(
    applicationId: string,
    botId: string,
    guildId: string,
    options: RequestOptions = {},
  ): Promise<ChannelOrderAuditResult> {
    assertSnowflake(applicationId, "Discord connector application ID")
    assertSnowflake(botId, "Discord connector bot ID")
    assertSnowflake(guildId, "Discord channel-ordering guild ID")
    this.#policy.assertChannelOrderingAuditable(guildId)
    const state = await this.#state(botId, guildId, options)
    return {
      applicationId,
      botId,
      groups: state.groups,
      guild: {
        id: state.guild.id,
        name: state.guild.name,
        ownerId: state.guild.owner_id,
      },
      httpEvidenceMode: state.httpEvidenceMode,
      layout: {
        obfuscatedChannels: state.layout.channels.filter((channel) => (
          channel.obfuscated
        )).length,
        revision: state.layout.revision,
        updatedAt: state.layout.updatedAt as string,
      },
      permission: {
        administrator: state.guildPermission.administrator,
        botEffectivePermissionNames: discordPermissionNames(
          BigInt(state.guildPermission.effectivePermissions),
        ),
        botEffectivePermissions: state.guildPermission.effectivePermissions,
        confidence: "complete",
        guildManageChannels: hasGuildPermission(
          state.guildPermission,
          "MANAGE_CHANNELS",
        ),
      },
      privacy: privacyProjection(),
      schemaVersion: SCHEMA_VERSION,
      status: "ok",
    }
  }

  async #buildPlan(
    applicationId: string,
    botId: string,
    request: NormalizedChannelOrderingRequest,
    options: RequestOptions,
    allowCompletedReceipt = false,
  ): Promise<BuiltChannelOrderingPlan> {
    assertSnowflake(applicationId, "Discord connector application ID")
    assertSnowflake(botId, "Discord connector bot ID")
    this.#policy.assertChannelOrderingChangeable(request.guildId)
    const existingReceipt = await this.#operationStore.get(
      "channel-ordering",
      request.operationKeyHash,
    )
    if (
      existingReceipt
      && !(
        allowCompletedReceipt
        && existingReceipt.status === "completed"
        && existingReceipt.verification === "match"
        && existingReceipt.guildId === request.guildId
        && existingReceipt.resourceId === request.channelId
      )
    ) {
      throw new ChannelOrderingOperationConflictError(receiptView(existingReceipt))
    }
    const state = await this.#state(botId, request.guildId, options)
    const targetGroup = state.groups.find((group) => (
      group.channels.some((channel) => channel.id === request.channelId)
    ))
    const anchorGroup = state.groups.find((group) => (
      group.channels.some((channel) => channel.id === request.anchorChannelId)
    ))
    if (!targetGroup || !anchorGroup) {
      throw evidenceError("Discord channel-ordering target or anchor is absent from the complete layout")
    }
    if (targetGroup.family === "unsupported" || anchorGroup.family === "unsupported") {
      throw evidenceError("Discord channel-ordering target and anchor must use a supported channel family")
    }
    if (targetGroup.family !== anchorGroup.family) {
      throw evidenceError("Discord channel-ordering target and anchor must share one sortable family")
    }
    const crossParentMove = targetGroup.parentChannelId !== anchorGroup.parentChannelId
    const mode: ChannelOrderMode = crossParentMove
      ? "cross-parent-move"
      : "same-parent-order"
    for (const parentChannelId of new Set([
      targetGroup.parentChannelId,
      anchorGroup.parentChannelId,
    ])) {
      if (state.layout.channels.some((entry) => (
        entry.parentChannelId === parentChannelId
        && channelFamily(entry.type) === "unsupported"
      ))) {
        throw evidenceError(
          "Discord channel-ordering source or destination contains an unsupported direct channel type",
        )
      }
    }
    if (
      targetGroup.permission.confidence !== "complete"
      || !targetGroup.permission.manageChannels
    ) throw evidenceError("Discord connector lacks complete MANAGE_CHANNELS authority for the source group")
    if (
      anchorGroup.permission.confidence !== "complete"
      || !anchorGroup.permission.manageChannels
    ) throw evidenceError("Discord connector lacks complete MANAGE_CHANNELS authority for the destination group")
    const channel = targetGroup.channels.find((entry) => entry.id === request.channelId)
    const anchor = anchorGroup.channels.find((entry) => entry.id === request.anchorChannelId)
    if (!channel || !anchor) {
      throw evidenceError("Discord channel-ordering target or anchor is missing")
    }
    const targetHttpEvidence = state.httpChannels.find((entry) => (
      entry.id === request.channelId
    ))
    if (!targetHttpEvidence) {
      throw evidenceError("Discord channel-ordering target HTTP evidence is missing")
    }
    const targetPermission = crossParentMove
      ? targetMovePermission(
          botId,
          request.guildId,
          targetHttpEvidence,
          state.botMember,
          state.rawRoles,
        )
      : null
    const sourceCapacity = parentCapacity(
      state.layout,
      targetGroup.parentChannelId,
      crossParentMove ? -1 : 0,
    )
    const capacity = parentCapacity(
      state.layout,
      anchorGroup.parentChannelId,
      crossParentMove ? 1 : 0,
    )
    const movedChannel: ChannelOrderEntry = crossParentMove
      ? { ...channel, parentChannelId: anchorGroup.parentChannelId }
      : channel
    const sourceCurrent = targetGroup.channels
    const destinationCurrent = crossParentMove
      ? anchorGroup.channels
      : targetGroup.channels
    const sourceDesired = crossParentMove
      ? sourceCurrent.filter((entry) => entry.id !== request.channelId)
      : desiredOrder(destinationCurrent, movedChannel, request)
    const destinationDesired = crossParentMove
      ? desiredOrder(destinationCurrent, movedChannel, request)
      : sourceDesired
    const sourceCurrentOrder = sourceCurrent.map((entry) => entry.id)
    const destinationCurrentOrder = destinationCurrent.map((entry) => entry.id)
    const sourceDesiredOrder = sourceDesired.map((entry) => entry.id)
    const destinationDesiredOrder = destinationDesired.map((entry) => entry.id)
    const writeRequired = crossParentMove || (
      stableString(sourceCurrentOrder) !== stableString(sourceDesiredOrder)
    )
    const currentGroups = crossParentMove
      ? [sourceCurrent, destinationCurrent]
      : [sourceCurrent]
    const desiredGroups = crossParentMove
      ? [sourceDesired, destinationDesired]
      : [destinationDesired]
    const affected = affectedChannels(currentGroups, desiredGroups)
    const beforeById = new Map(
      currentGroups.flatMap((group) => group).map((entry) => [entry.id, entry]),
    )
    const positionWrites: ChannelOrderingPositionWrite[] = writeRequired
      ? desiredGroups.flatMap((group) => group.map((entry, submittedPosition) => {
          const before = beforeById.get(entry.id)
          if (!before) {
            throw evidenceError("Discord channel-ordering position evidence is incomplete")
          }
          return {
            beforeRawPosition: before.rawPosition,
            channelId: entry.id,
            parentChange: crossParentMove && entry.id === request.channelId
              ? {
                  destinationParentChannelId: anchorGroup.parentChannelId,
                  lockPermissions: false as const,
                  sourceParentChannelId: targetGroup.parentChannelId,
                }
              : null,
            submittedPosition,
          }
        }))
      : []
    const expectedTopology = state.layout.channels.map((entry) => (
      crossParentMove && entry.channelId === request.channelId
        ? { ...entry, parentChannelId: anchorGroup.parentChannelId }
        : { ...entry }
    ))
    const expectedGroupOrders = new Map(groupOrders(expectedTopology))
    const sourceKey = groupKey(
      targetGroup.parentChannelId,
      targetGroup.family,
      null,
    )
    const destinationKey = groupKey(
      anchorGroup.parentChannelId,
      anchorGroup.family,
      null,
    )
    if (sourceDesiredOrder.length > 0) {
      expectedGroupOrders.set(sourceKey, sourceDesiredOrder)
    } else {
      expectedGroupOrders.delete(sourceKey)
    }
    expectedGroupOrders.set(destinationKey, destinationDesiredOrder)
    const digest = reviewedPlanDigest(this.#planKey, {
      applicationId,
      botId,
      botMember: memberSnapshot(state.botMember),
      capacity,
      destinationDesiredOrder,
      destinationPermission: anchorGroup.permission,
      expectedGroupOrders: [...expectedGroupOrders],
      expectedTopology,
      guild: {
        id: state.guild.id,
        name: state.guild.name,
        ownerId: state.guild.owner_id,
      },
      guildPermission: state.guildPermission,
      httpChannels: httpSnapshot(state.httpChannels),
      httpEvidenceMode: state.httpEvidenceMode,
      layout: state.layout,
      positionWrites,
      request: {
        anchorChannelId: request.anchorChannelId,
        auditReason: request.auditReason,
        channelId: request.channelId,
        guildId: request.guildId,
        operationKeyHash: request.operationKeyHash,
        placement: request.placement,
      },
      roles: rolesSnapshot(state.roles),
      sourceCapacity,
      sourceDesiredOrder,
      sourcePermission: targetGroup.permission,
      targetMovePermission: targetPermission,
    })
    const obfuscatedChannels = state.layout.channels.filter((entry) => entry.obfuscated).length
    const rankChangeCount = affected.filter((entry) => (
      entry.beforeRank !== entry.afterRank
    )).length
    const warnings = [
      "Channel names are untrusted Discord text and are never persisted by this workflow",
      ...(obfuscatedChannels > 0
        ? [`The complete layout contains ${obfuscatedChannels} obfuscated channel IDs whose metadata remains hidden`]
        : []),
      ...(targetGroup.permission.administrator
        || anchorGroup.permission.administrator
        || targetPermission?.administrator
        ? ["Discord connector has ADMINISTRATOR; replace it with narrowly scoped MANAGE_CHANNELS"]
        : []),
      ...(crossParentMove
        ? ["The target's exact permission overwrites remain unsynchronized with the destination category"]
        : []),
      "Discord exposes no conditional channel-order update, so external same-guild administration can race the reviewed write",
      "The operation key is one-shot and cannot be retried after reservation, including after uncertainty",
      "The MCP facade durably coordinates the guild channel collection and exact endpoints; direct service consumers must provide equivalent exclusion",
    ]
    const risks = [
      "Changing channel order changes navigation and can affect how members discover text, voice, Stage, forum, and media spaces",
      crossParentMove
        ? "The move changes the target's category and normalizes both complete affected sortable groups to the sequential positions shown in the plan"
        : "The reorder normalizes the complete same-parent sortable group to the sequential positions shown in the plan",
      "The PATCH is sent once without automatic retry, rollback, permission syncing, flag changes, or metadata changes",
      "Success requires a newer complete matching Gateway layout plus coherent HTTP readback preserving exact target overwrites; timeout, continuity loss, or contradiction is uncertain and quarantines the guild channel collection",
    ]
    const destinationDesiredRanks = new Map(
      destinationDesired.map((entry, rank) => [entry.id, rank]),
    )
    const plan: ChannelOrderingPlan = {
      affectedChannels: affected,
      anchor,
      applicationId,
      auditReason: request.auditReason,
      botId,
      channel,
      createdAt: this.#clock().toISOString(),
      current: {
        anchorRank: anchor.rank,
        channelRank: channel.rank,
        destinationGroupOrder: destinationCurrentOrder,
        sourceGroupOrder: sourceCurrentOrder,
      },
      destinationCapacity: capacity,
      destinationParentChannelId: anchorGroup.parentChannelId,
      destinationPermission: anchorGroup.permission,
      desired: {
        anchorRank: destinationDesiredRanks.get(anchor.id) as number,
        channelRank: destinationDesiredRanks.get(channel.id) as number,
        destinationGroupOrder: destinationDesiredOrder,
        sourceGroupOrder: sourceDesiredOrder,
      },
      digest,
      family: targetGroup.family,
      guild: {
        id: state.guild.id,
        name: state.guild.name,
        ownerId: state.guild.owner_id,
      },
      httpEvidenceMode: state.httpEvidenceMode,
      impact: {
        affectedChannelCount: affected.length,
        destinationGroupChannelCount: destinationCurrent.length,
        parentChangeCount: crossParentMove ? 1 : 0,
        rankChangeCount,
        rawPositionWriteCount: positionWrites.length,
        sourceGroupChannelCount: sourceCurrent.length,
      },
      layout: {
        obfuscatedChannels,
        revision: state.layout.revision,
        updatedAt: state.layout.updatedAt as string,
      },
      mode,
      operationKeyHash: request.operationKeyHash,
      permissionOverwriteBehavior: "preserve",
      placement: request.placement,
      positionWrites,
      privacy: privacyProjection(),
      risks,
      schemaVersion: SCHEMA_VERSION,
      sourceCapacity,
      sourceParentChannelId: targetGroup.parentChannelId,
      sourcePermission: targetGroup.permission,
      status: writeRequired ? "planned" : "already-current",
      targetMovePermission: targetPermission,
      warnings,
      writeRequired,
    }
    if (existingReceipt && plan.writeRequired) {
      throw new ChannelOrderingOperationConflictError(receiptView(existingReceipt))
    }
    return {
      baselineLayout: state.layout,
      expectedTopology,
      expectedGroupOrders,
      plan,
      request,
      targetHttpEvidence,
    }
  }

  plan(
    applicationId: string,
    botId: string,
    request: ChannelOrderingRequest,
    options: RequestOptions = {},
  ): Promise<ChannelOrderingPlan> {
    return this.#buildPlan(
      applicationId,
      botId,
      normalizeChannelOrderingRequest(request),
      options,
    ).then(({ plan }) => plan)
  }

  reconcilePlan(
    applicationId: string,
    botId: string,
    request: ChannelOrderingRequest,
    options: RequestOptions = {},
  ): Promise<ChannelOrderingPlan> {
    return this.#buildPlan(
      applicationId,
      botId,
      normalizeChannelOrderingRequest(request),
      options,
      true,
    ).then(({ plan }) => plan)
  }

  execute(
    applicationId: string,
    botId: string,
    request: ChannelOrderingRequest,
    expectedDigest: string,
    options: RequestOptions = {},
  ): Promise<ChannelOrderingResult> {
    const normalized = normalizeChannelOrderingRequest(request)
    if (!REVIEWED_PLAN_DIGEST_PATTERN.test(expectedDigest)) {
      throw new RangeError("Discord channel-ordering plan digest is invalid")
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
      () => new ChannelOrderingExecutionError(
        "Discord channel ordering was blocked because a prior same-guild operation ended uncertain",
        {
          anchorChannelId: normalized.anchorChannelId,
          channelId: normalized.channelId,
          guildId: normalized.guildId,
          operationKeyHash: normalized.operationKeyHash,
          planDigest: expectedDigest,
          schemaVersion: SCHEMA_VERSION,
          status: "blocked-prior-uncertain",
        },
      ),
    )
  }

  async #executeNormalized(
    applicationId: string,
    botId: string,
    request: NormalizedChannelOrderingRequest,
    expectedDigest: string,
    options: RequestOptions,
  ): Promise<ChannelOrderingResult> {
    let built: BuiltChannelOrderingPlan
    try {
      built = await this.#buildPlan(applicationId, botId, request, options)
    } catch (error) {
      if (
        error instanceof ChannelOrderingEvidenceError
        || error instanceof DiscordRoleEvidenceError
        || error instanceof RangeError
        || error instanceof DiscordApiError && error.status === 404
      ) throw new ChannelOrderingPlanChangedError(expectedDigest, STATE_UNAVAILABLE)
      throw error
    }
    const {
      baselineLayout,
      expectedGroupOrders,
      expectedTopology,
      plan,
      targetHttpEvidence,
    } = built
    if (plan.digest !== expectedDigest) {
      throw new ChannelOrderingPlanChangedError(expectedDigest, plan.digest)
    }
    const baseResult = {
      anchorChannelId: request.anchorChannelId,
      baselineLayoutRevision: plan.layout.revision,
      channelId: request.channelId,
      guildId: request.guildId,
      operationKeyHash: request.operationKeyHash,
      planDigest: plan.digest,
      schemaVersion: SCHEMA_VERSION,
    }
    const affectedIds = new Set(plan.affectedChannels.map((channel) => channel.id))
    if (!plan.writeRequired) {
      return {
        ...baseResult,
        activityId: null,
        layoutMatched: true,
        observedAffectedChannels: plan.affectedChannels.map((entry) => ({
          id: entry.id,
          obfuscated: entry.obfuscated,
          parentChannelId: entry.beforeParentChannelId,
          rank: entry.beforeRank,
          rawPosition: entry.rawPosition,
          type: entry.type,
        })),
        observedLayoutRevision: plan.layout.revision,
        status: "already-current",
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
      throw new ChannelOrderingOperationConflictError(receiptView(reservation.receipt))
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
      throw new ChannelOrderingExecutionError(
        "Discord channel ordering was blocked because pending activity could not be recorded",
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
    let observedLayoutRevision: number | null = null
    let observedAffectedChannels: ObservedChannelOrderEntry[] = []
    let watch: LayoutVerificationWatch | undefined
    try {
      const writes: ModifyGuildChannelPositionInput[] = plan.positionWrites.map((write) => ({
        id: write.channelId,
        ...(write.parentChange
          ? {
              lockPermissions: false as const,
              parentId: write.parentChange.destinationParentChannelId,
            }
          : {}),
        position: write.submittedPosition,
      } as ModifyGuildChannelPositionInput))
      watch = layoutVerificationWatch({
        baseline: baselineLayout,
        expectedGroupOrders,
        expectedTopology,
        guildId: request.guildId,
        source: this.#layoutSource,
        timeoutMs: this.#verificationTimeoutMs,
      })
      watch.arm()
      mutationStarted = true
      await this.#client.modifyGuildChannelPositions(
        request.guildId,
        writes,
        request.auditReason,
        options,
      )
      mutationAccepted = true
      const observed = await watch.wait(options.signal)
      observedLayoutRevision = observed.revision
      observedAffectedChannels = observedEntries(
        observed,
        affectedIds,
      )
      const readback = await this.#client.getGuildChannels(request.guildId, options)
      verifyHttpReadback(
        readback,
        observed,
        plan.httpEvidenceMode,
        targetHttpEvidence,
      )
    } catch (error) {
      const latest = watch?.latest() ?? null
      if (latest) {
        observedLayoutRevision = latest.revision
        observedAffectedChannels = observedEntries(
          latest,
          affectedIds,
        )
      }
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
          observedRevision: observedLayoutRevision,
          plan,
          request,
          status,
          timestamp: this.#clock().toISOString(),
        }))
      } catch (activityError) {
        activityRecordError = safeErrorCode(activityError)
      }
      throw new ChannelOrderingExecutionError(
        "Discord channel ordering did not complete with a verified successful outcome",
        {
          ...baseResult,
          activityId,
          activityRecordError,
          error: errorCode,
          layoutMatched: false,
          observedAffectedChannels,
          observedLayoutRevision,
          operationRecordError,
          retryAfterMs: error instanceof DiscordApiError
            ? error.retryAfterMs ?? null
            : null,
          status,
        },
        { cause: error },
      )
    } finally {
      watch?.close()
    }

    const result: ChannelOrderingResult = {
      ...baseResult,
      activityId,
      layoutMatched: true,
      observedAffectedChannels,
      observedLayoutRevision: observedLayoutRevision as number,
      status: "completed",
      verification: "match",
    }
    try {
      await this.#operationStore.finish(operationReceipt({
        activityId,
        plan,
        request,
        status: "completed",
        timestamp: this.#clock().toISOString(),
        verification: "match",
      }))
    } catch (error) {
      let activityRecordError: string | null = null
      try {
        await this.#activityStore.append(activityEntry({
          activityId,
          error: safeErrorCode(error),
          observedRevision: observedLayoutRevision,
          plan,
          request,
          status: "uncertain",
          timestamp: this.#clock().toISOString(),
        }))
      } catch (activityError) {
        activityRecordError = safeErrorCode(activityError)
      }
      throw new ChannelOrderingExecutionError(
        "Discord channel ordering completed but the operation receipt failed",
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
        observedRevision: observedLayoutRevision,
        plan,
        request,
        status: "completed",
        timestamp: this.#clock().toISOString(),
        verification: "match",
      }))
    } catch (error) {
      throw new ChannelOrderingExecutionError(
        "Discord channel ordering completed but the final activity record failed",
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
