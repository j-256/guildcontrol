import {
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto"
import { setTimeout as wait } from "node:timers/promises"

import type {
  ActivityStore,
  InviteCreationActivity,
  InviteCreationActivityStatus,
  InviteDeletionActivity,
  InviteDeletionActivityStatus,
} from "./activity-log.js"
import {
  CONNECTOR_LIMITS,
  DISCORD_CHANNEL_TYPES,
  DISCORD_LIMITS,
  DISCORD_INVITE_URL_PATTERN,
  DISCORD_SNOWFLAKE_MAX,
  DISCORD_SNOWFLAKE_PATTERN,
  INVITE_CURSOR_PATTERN,
  INVITE_LIMITS,
  INVITE_REFERENCE_PATTERN,
  SCHEMA_VERSION,
} from "./constants.js"
import {
  encodeDiscordAuditReason,
  type DiscordClient,
  type DiscordDeletedInviteSummary,
  type DiscordGuildVanitySummary,
  type DiscordInviteIdentitySummary,
  type DiscordInviteSummary,
} from "./discord-client.js"
import {
  DiscordApiError,
  InviteCreationExecutionError,
  InviteCreationOperationConflictError,
  InviteCreationPlanChangedError,
  InviteDeletionExecutionError,
  InviteDeletionOperationConflictError,
  InviteDeletionPlanChangedError,
  InviteEvidenceError,
  errorMessage,
} from "./errors.js"
import type { GatewayChannelLayoutSource } from "./gateway-channel-layout.js"
import {
  collectGuildChannelEvidence,
  DIRECT_GUILD_CHANNEL_TYPES,
  GuildChannelEvidenceError,
  type GuildChannelEvidenceView,
} from "./guild-channel-evidence.js"
import { isGuildChannelTopologyType } from "./guild-channel-types.js"
import {
  guildChannelAnalysisCoverage,
  hasHiddenModeledChannel,
  type GuildChannelAnalysisCoverage,
} from "./guild-channel-coverage.js"
import { stableString } from "./normalize.js"
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
  evaluateBotChannelPermissions,
  evaluateGuildMemberPermissions,
  evaluatePrincipalPermissions,
  hasGuildPermission,
  parseDiscordPermissionBits,
  unknownDiscordPermissionBits,
  type DiscordPermissionName,
  type BotChannelPermissionResult,
  type GuildMemberPermissionResult,
  type PrincipalPermissionResult,
} from "./permissions.js"
import type { ScopePolicy } from "./policy.js"
import {
  type PrivateCapabilityFileReservation,
  type PrivateCapabilityFileSystem,
  type PrivateCapabilityTargetReview,
  DEFAULT_PRIVATE_CAPABILITY_FILE_SYSTEM,
  PrivateCapabilityFileError,
  reservePrivateCapabilityFile,
  reviewPrivateCapabilityTarget,
} from "./private-capability-file.js"
import {
  createReviewedPlanKey,
  REVIEWED_PLAN_DIGEST_PATTERN,
  reviewedPlanDigest,
} from "./reviewed-plan.js"
import { ROLE_CREATION_HIGH_RISK_PERMISSIONS } from "./role-administration-service.js"
import type {
  DiscordChannel,
  DiscordGuild,
  DiscordGuildMember,
  DiscordPermissionOverwrite,
  DiscordRole,
  RequestOptions,
} from "./types.js"

const INVITE_GUEST_FLAG = 1
const GUILD_FEATURE_PATTERN = /^[A-Z0-9_]+$/u
const MAX_PROJECTED_UNKNOWN_FIELDS = 256
const INVITE_REFERENCE_PREFIX = "iref_hmac_sha256_"
const INVITE_CURSOR_PREFIX = "icur_hmac_sha256_"
const STATE_UNAVAILABLE = "invite-state-unavailable"
const CREATION_STATE_UNAVAILABLE = "invite-creation-state-unavailable"
const DISCORD_INVITE_BASE_URL = "https://discord.gg"
const INVITE_CAPABILITY_FILE_FORMAT = "discord-invite-capability.v3"
const INVITE_CAPABILITY_FILE_SCHEMA_VERSION = 3
const INVITE_CREATION_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  DISCORD_CHANNEL_TYPES.announcement,
  DISCORD_CHANNEL_TYPES.forum,
  DISCORD_CHANNEL_TYPES.media,
  DISCORD_CHANNEL_TYPES.stageVoice,
  DISCORD_CHANNEL_TYPES.text,
  DISCORD_CHANNEL_TYPES.voice,
])
const INVITE_CREATION_BEARER_REQUIRED_PERMISSIONS = Object.freeze([
  "CREATE_INSTANT_INVITE",
  "VIEW_CHANNEL",
] as const satisfies readonly DiscordPermissionName[])
const HIGH_RISK_ROLE_PERMISSIONS: ReadonlySet<DiscordPermissionName> = new Set([
  "ADMINISTRATOR",
  "CREATE_INSTANT_INVITE",
  ...ROLE_CREATION_HIGH_RISK_PERMISSIONS,
])
const INVITE_ROLE_IMPACT_PERMISSIONS = Object.freeze([
  ...DISCORD_CHANNEL_PERMISSION_NAMES,
])
const INVITE_ROLE_CHANNEL_PERMISSION_MASK = DISCORD_CHANNEL_PERMISSION_NAMES.reduce(
  (mask, permission) => mask | DISCORD_PERMISSIONS[permission],
  0n,
)
const HYPOTHETICAL_INVITEE_ID = "0"
const URL_DOT_PATH_SEGMENTS: ReadonlySet<string> = new Set([".", ".."])
const VANITY_URL_FEATURE = "VANITY_URL"
const VANITY_LOCAL_CONSTRAINTS = Object.freeze({
  codeCharacters: INVITE_LIMITS.codeCharacters,
  codeDisclosure: "explicit-tool-opt-in" as const,
})

export const INVITE_OMITTED_FIELDS = Object.freeze([
  "approximateCounts",
  "code",
  "guildObject",
  "guildScheduledEvent",
  "inviterProfile",
  "rawDiscordObject",
  "roleNames",
  "roleVisuals",
  "stageInstance",
  "targetApplicationMetadata",
  "targetUserAcceptance",
  "targetUserProfile",
  "url",
] as const)

type InviteTargetOutcome = "settled" | "uncertain"

export interface InviteListOptions extends RequestOptions {
  cursor?: string
  limit?: number
}

export interface GuildVanityUrlOptions extends RequestOptions {
  includeCode?: boolean
}

export interface InviteDeletionRequest {
  auditReason: string
  guildId: string
  inviteRef: string
  operationKey: string
}

export interface NormalizedInviteDeletionRequest extends InviteDeletionRequest {
  operationKeyHash: string
}

export interface InviteChannelProjection {
  id: string
  name: string | null
  type: number
}

export interface InviteGrantedRoleProjection {
  highRiskPermissions: DiscordPermissionName[]
  permissionNames: DiscordPermissionName[]
  permissions: string
  roleId: string
  unknownPermissionBits: string
}

export interface ProjectedInvite {
  channel: InviteChannelProjection
  createdAt: string
  expiresAt: string | null
  flags: {
    guest: boolean
    raw: number
    unknownBits: string
  }
  inviteRef: string
  inviterUserId: string | null
  maxAgeSeconds: number
  maxUses: number
  riskFlags: string[]
  roles: InviteGrantedRoleProjection[]
  target: {
    id: string
    kind: "embedded-application" | "stream"
  } | null
  temporaryMembership: boolean
  uses: number
}

export interface InviteAccessEvidence {
  appliedRoleIds: string[]
  botAdministrator: boolean
  botIsGuildOwner: boolean
  complete: true
  effectivePermissionNames: DiscordPermissionName[]
  effectivePermissions: string
  manageGuild: true
  requiredPermission: "MANAGE_GUILD"
  unknownPermissionBits: string
}

export interface InvitePrivacyProjection {
  capabilitiesProjectedOut: true
  omittedFields: typeof INVITE_OMITTED_FIELDS
  persistence: "none"
  rawPayloads: "omitted"
}

export interface InviteInventoryResult {
  access: InviteAccessEvidence
  applicationId: string
  botId: string
  guild: {
    id: string
    name: string
  }
  invites: ProjectedInvite[]
  page: {
    cursor: string | null
    hasMore: boolean
    nextCursor: string | null
    requestedLimit: number
    returned: number
    safetyLimit: number
  }
  privacy: InvitePrivacyProjection
  schemaVersion: number
  status: "ok"
}

export interface InviteLookupResult extends Omit<
  InviteInventoryResult,
  "invites" | "page"
> {
  invite: ProjectedInvite
}

export interface GuildVanityUrlAuditResult {
  access: InviteAccessEvidence
  applicationId: string
  botId: string
  guildId: string
  localConstraints: typeof VANITY_LOCAL_CONSTRAINTS
  privacy: {
    code: "explicit-transient-opt-in"
    inviteUrl: "omitted"
    persistence: "none"
    rawPayloads: "omitted"
    unknownFields: "counts-only"
  }
  schemaVersion: number
  status: "ok"
  vanity: {
    code: string | null
    codeDisclosure: "included" | "omitted"
    configured: boolean
    eligible: boolean
    unknownFieldCount: number | null
    uses: number | null
  }
  verification: {
    endpointCalled: boolean
    guildCrossCheck: "match" | "not-applicable"
    writePerformed: false
  }
}

export interface InviteDeletionPlan {
  access: InviteAccessEvidence
  action: "delete"
  applicationId: string
  auditReason: string
  botId: string
  createdAt: string
  digest: string
  guild: {
    id: string
    name: string
  }
  operationKeyHash: string
  privacy: InvitePrivacyProjection
  schemaVersion: number
  status: "planned"
  target: ProjectedInvite
  visibleInventory: {
    channelLimit: number
    channels: number
    inviteLimit: number
    invites: number
    roleLimit: number
    roles: number
  }
  warnings: string[]
}

export interface InviteDeletionResult {
  activityId: string
  channelId: string
  guildId: string
  inviteRef: string
  operationKeyHash: string
  planDigest: string
  schemaVersion: number
  status: "completed" | "completed-with-drift"
  verifiedAbsent: boolean
}

export interface InviteCreationRequest {
  acceptance:
    | { kind: "bearer" }
    | { kind: "exact-users"; userIds: string[] }
  acknowledgeBearerCapability: true
  auditReason: string
  channelId: string
  guildId: string
  maxAgeSeconds: number
  maxUses: number
  operationKey: string
  outputFile: string
  roleAssignment:
    | { kind: "none" }
    | {
        acknowledgePersistentGrants: true
        kind: "grant"
        roleIds: string[]
      }
  temporaryMembership: boolean
}

export interface NormalizedInviteCreationRequest extends Omit<
  InviteCreationRequest,
  "acceptance"
> {
  acceptance:
    | { kind: "bearer" }
    | { kind: "exact-users"; userIds: string[] }
  operationKeyHash: string
}

export interface InviteCreationAccessEvidence {
  appliedRoleIds: string[]
  botAdministrator: boolean
  botHighestRoleIds: string[]
  botHighestRolePosition: number
  botIsGuildOwner: boolean
  complete: true
  createInstantInvite: true
  effectivePermissionNames: DiscordPermissionName[]
  effectivePermissions: string
  manageGuild: boolean
  manageRoles: boolean
  requiredPermissions: readonly DiscordPermissionName[]
  unknownPermissionBits: string
  viewChannel: true
}

export interface InviteCreationPlan {
  access: InviteCreationAccessEvidence
  action: "create"
  applicationId: string
  auditReason: string
  botId: string
  createdAt: string
  delivery: {
    format: typeof INVITE_CAPABILITY_FILE_FORMAT
    outputFile: string
    review: PrivateCapabilityTargetReview
  }
  digest: string
  guild: {
    id: string
    name: string
  }
  intent: {
    acceptance: NormalizedInviteCreationRequest["acceptance"]
    maxAgeSeconds: number
    maxUses: number
    roleAssignment: NormalizedInviteCreationRequest["roleAssignment"]
    temporaryMembership: boolean
    unique: true
  }
  operationKeyHash: string
  privacy: {
    capabilityDelivery: "private-file-only"
    mcpResult: "credential-free"
    persistence: "content-free-lifecycle-only"
    rawDiscordPayloads: "omitted"
  }
  roleAssignment: InviteRoleAssignmentReview
  schemaVersion: number
  status: "planned"
  target: InviteChannelProjection & {
    permissionOverwriteCount: number
  }
  visibleInventory: {
    channelLimit: number
    channels: number
    roleLimit: number
    roles: number
  }
  warnings: string[]
}

export interface InviteCreationResult {
  acceptance: {
    kind: "bearer" | "exact-users"
    targetUserCount: number
  }
  activityId: string
  capabilityFileWritten: true
  channelId: string
  guildId: string
  inviteRef: string
  operationKeyHash: string
  outputFile: string
  planDigest: string
  roleAssignment:
    | { kind: "none"; roleCount: 0 }
    | { kind: "grant"; roleCount: number; roleIds: string[] }
  schemaVersion: number
  status: "completed"
  verified: true
}

export interface InviteServiceClient extends Pick<
  DiscordClient,
  | "createChannelInvite"
  | "deleteInvite"
  | "getGuild"
  | "getGuildChannels"
  | "getGuildMember"
  | "getGuildRoles"
  | "getGuildVanityUrl"
  | "getInvite"
  | "getInviteTargetUserIds"
  | "getInviteTargetUsersJobStatus"
  | "listGuildInvites"
> {}

export interface InviteServiceOptions {
  activityStore: ActivityStore
  capabilityRoots?: readonly string[]
  client: InviteServiceClient
  clock?: () => Date
  layoutSource?: GatewayChannelLayoutSource
  operationStore: OperationStore
  planKey?: Uint8Array
  policy: Pick<
    ScopePolicy,
    | "assertGuildInviteAuditable"
    | "assertGuildInviteCreatable"
    | "assertGuildInviteDeletable"
    | "assertInviteRoleAssignmentAllowed"
  >
  privateFileSystem?: PrivateCapabilityFileSystem
  randomId?: () => string
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

interface ValidatedRole {
  id: string
  managed: boolean
  name: string
  permissionNames: DiscordPermissionName[]
  permissions: string
  position: number
  unknownPermissionBits: string
}

type InviteRolePermissionDecision = "allowed" | "denied" | "ineffective"

interface InviteRolePermissionChange {
  after: InviteRolePermissionDecision
  before: InviteRolePermissionDecision
  permission: DiscordPermissionName
}

interface InviteRoleChannelImpact {
  channelId: string
  channelName: string
  channelType: number
  changes: InviteRolePermissionChange[]
}

interface InviteRoleGuildPermissionImpact {
  added: DiscordPermissionName[]
  after: DiscordPermissionName[]
  before: DiscordPermissionName[]
}

interface InviteAssignedRoleProjection {
  highRiskPermissions: DiscordPermissionName[]
  id: string
  name: string
  permissionNames: DiscordPermissionName[]
  permissions: string
  position: number
}

type InviteRoleAssignmentReview =
  | { kind: "none" }
  | {
      acknowledgePersistentGrants: true
      assignedRoles: InviteAssignedRoleProjection[]
      channelEvidence: GuildChannelEvidenceView
      highRiskPermissionGains: DiscordPermissionName[]
      impact: {
        coverage: GuildChannelAnalysisCoverage
        changedChannels: number
        channels: InviteRoleChannelImpact[]
        evaluatedChannels: number
        guildPermissions: InviteRoleGuildPermissionImpact
        projection: "minimum-new-member"
      }
      kind: "grant"
      persistence: "manual-removal-required"
      roleIds: string[]
    }

type InviteRoleImpactChannel = DiscordChannel & {
  guild_id: string
  name: string
  permission_overwrites: DiscordPermissionOverwrite[]
}

interface InviteState {
  access: InviteAccessEvidence
  botMember: DiscordGuildMember
  channels: InviteChannelProjection[]
  guild: DiscordGuild & { owner_id: string }
  inventoryDigest: string
  projected: ProjectedInvite[]
  rawByReference: ReadonlyMap<string, DiscordInviteSummary>
  roles: ValidatedRole[]
}

interface InviteCreationState {
  access: InviteCreationAccessEvidence
  botMember: DiscordGuildMember
  channel: DiscordChannel & {
    guild_id: string
    name: string
    permission_overwrites: DiscordPermissionOverwrite[]
  }
  channels: InviteChannelProjection[]
  guild: DiscordGuild & { owner_id: string }
  roleAssignment: InviteRoleAssignmentReview
  roleGrantChannels: InviteRoleImpactChannel[]
  roles: ValidatedRole[]
}

interface PrivateInviteCreationPlan {
  plan: InviteCreationPlan
  request: NormalizedInviteCreationRequest
}

interface PrivateInviteDeletionPlan {
  code: string
  plan: InviteDeletionPlan
}

interface InviteCursorPayload {
  guildId: string
  inventoryDigest: string
  offset: number
  version: 1
}

function evidenceError(message: string): InviteEvidenceError {
  return new InviteEvidenceError(message)
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return wait(milliseconds, undefined, signal ? { signal } : undefined)
}

function positiveSnowflake(value: unknown): value is string {
  return typeof value === "string"
    && DISCORD_SNOWFLAKE_PATTERN.test(value)
    && BigInt(value) >= 1n
    && BigInt(value) <= DISCORD_SNOWFLAKE_MAX
}

function assertPositiveSnowflake(value: unknown, name: string): asserts value is string {
  if (!positiveSnowflake(value)) {
    throw new RangeError(`${name} must be a positive Discord snowflake`)
  }
}

function assertInviteReference(value: unknown): asserts value is string {
  if (typeof value !== "string" || !INVITE_REFERENCE_PATTERN.test(value)) {
    throw new RangeError("Discord invite reference is invalid or belongs to another process")
  }
}

export function assertInviteListInput(
  guildId: string,
  options: InviteListOptions,
): void {
  assertPositiveSnowflake(guildId, "Discord invite-audit guild ID")
  if (
    options.limit !== undefined
    && (
      !Number.isInteger(options.limit)
      || options.limit < 1
      || options.limit > INVITE_LIMITS.listPage
    )
  ) {
    throw new RangeError(
      `Discord invite-audit limit must be an integer between 1 and ${INVITE_LIMITS.listPage}`,
    )
  }
  if (
    options.cursor !== undefined
    && (
      options.cursor.length > INVITE_LIMITS.cursorCharacters
      || !INVITE_CURSOR_PATTERN.test(options.cursor)
    )
  ) {
    throw new RangeError("Discord invite-audit cursor is invalid or expired")
  }
}

export function assertInviteGetInput(guildId: string, inviteRef: string): void {
  assertPositiveSnowflake(guildId, "Discord invite-audit guild ID")
  assertInviteReference(inviteRef)
}

export function assertGuildVanityUrlInput(
  guildId: string,
  includeCode: boolean,
): void {
  assertPositiveSnowflake(guildId, "Discord guild vanity URL guild ID")
  if (typeof includeCode !== "boolean") {
    throw new RangeError("Discord guild vanity URL code disclosure must be a boolean")
  }
}

export function normalizeInviteDeletionRequest(
  request: InviteDeletionRequest,
): NormalizedInviteDeletionRequest {
  if (!request || typeof request !== "object") {
    throw new RangeError("Discord invite deletion request must be an object")
  }
  assertPositiveSnowflake(request.guildId, "Discord invite deletion guild ID")
  assertInviteReference(request.inviteRef)
  if (typeof request.auditReason !== "string") {
    throw new RangeError("Discord invite deletion audit reason must be a string")
  }
  encodeDiscordAuditReason(request.auditReason)
  if (DISCORD_INVITE_URL_PATTERN.test(request.auditReason)) {
    throw new RangeError("Discord invite deletion audit reason must not contain an invite URL")
  }
  return {
    auditReason: request.auditReason,
    guildId: request.guildId,
    inviteRef: request.inviteRef,
    operationKey: request.operationKey,
    operationKeyHash: operationKeyHash(request.operationKey),
  }
}

const INVITE_CREATION_REQUEST_KEYS: ReadonlySet<string> = new Set([
  "acceptance",
  "acknowledgeBearerCapability",
  "auditReason",
  "channelId",
  "guildId",
  "maxAgeSeconds",
  "maxUses",
  "operationKey",
  "outputFile",
  "roleAssignment",
  "temporaryMembership",
])

function compareSnowflakes(left: string, right: string): number {
  const leftValue = BigInt(left)
  const rightValue = BigInt(right)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

function normalizeInviteCreationAcceptance(
  value: unknown,
): NormalizedInviteCreationRequest["acceptance"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError("Discord invite acceptance must be one exact object")
  }
  const acceptance = value as Record<string, unknown>
  if (
    acceptance.kind === "bearer"
    && Object.keys(acceptance).length === 1
  ) return { kind: "bearer" }
  if (
    acceptance.kind !== "exact-users"
    || Object.keys(acceptance).sort().join("\0") !== "kind\0userIds"
    || !Array.isArray(acceptance.userIds)
    || acceptance.userIds.length < 1
    || acceptance.userIds.length > INVITE_LIMITS.targetUserIds
  ) {
    throw new RangeError(
      "Discord exact-user invite acceptance requires one bounded nonempty user ID list",
    )
  }
  for (const userId of acceptance.userIds) {
    assertPositiveSnowflake(userId, "Discord invite target user ID")
    if (BigInt(userId).toString() !== userId) {
      throw new RangeError("Discord invite target user IDs must be canonical")
    }
  }
  if (new Set(acceptance.userIds).size !== acceptance.userIds.length) {
    throw new RangeError("Discord invite target user IDs must be unique")
  }
  return {
    kind: "exact-users",
    userIds: [...acceptance.userIds].sort(compareSnowflakes),
  }
}

function normalizeInviteRoleAssignment(
  value: unknown,
): NormalizedInviteCreationRequest["roleAssignment"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError("Discord invite role assignment must be one exact object")
  }
  const assignment = value as Record<string, unknown>
  if (assignment.kind === "none" && Object.keys(assignment).length === 1) {
    return { kind: "none" }
  }
  if (
    assignment.kind !== "grant"
    || Object.keys(assignment).sort().join("\0")
      !== "acknowledgePersistentGrants\0kind\0roleIds"
    || assignment.acknowledgePersistentGrants !== true
    || !Array.isArray(assignment.roleIds)
    || assignment.roleIds.length < 1
    || assignment.roleIds.length > INVITE_LIMITS.roleIds
  ) {
    throw new RangeError(
      "Discord invite role assignment requires acknowledged bounded exact role IDs",
    )
  }
  for (const roleId of assignment.roleIds) {
    assertPositiveSnowflake(roleId, "Discord invite role-assignment role ID")
    if (BigInt(roleId).toString() !== roleId) {
      throw new RangeError("Discord invite role-assignment role IDs must be canonical")
    }
  }
  if (new Set(assignment.roleIds).size !== assignment.roleIds.length) {
    throw new RangeError("Discord invite role-assignment role IDs must be unique")
  }
  return {
    acknowledgePersistentGrants: true,
    kind: "grant",
    roleIds: [...assignment.roleIds].sort(compareSnowflakes),
  }
}

export function normalizeInviteCreationRequest(
  request: InviteCreationRequest,
): NormalizedInviteCreationRequest {
  if (
    !request
    || typeof request !== "object"
    || Array.isArray(request)
    || Object.keys(request).some((key) => !INVITE_CREATION_REQUEST_KEYS.has(key))
    || Object.keys(request).length !== INVITE_CREATION_REQUEST_KEYS.size
  ) {
    throw new RangeError("Discord invite creation request must be one exact object")
  }
  const acceptance = normalizeInviteCreationAcceptance(request.acceptance)
  const roleAssignment = normalizeInviteRoleAssignment(request.roleAssignment)
  assertPositiveSnowflake(request.guildId, "Discord invite-creation guild ID")
  assertPositiveSnowflake(request.channelId, "Discord invite-creation channel ID")
  if (request.acknowledgeBearerCapability !== true) {
    throw new RangeError(
      "Discord invite creation requires explicit bearer-capability acknowledgement",
    )
  }
  if (typeof request.auditReason !== "string") {
    throw new RangeError("Discord invite-creation audit reason must be a string")
  }
  encodeDiscordAuditReason(request.auditReason)
  if (DISCORD_INVITE_URL_PATTERN.test(request.auditReason)) {
    throw new RangeError("Discord invite-creation audit reason must not contain an invite URL")
  }
  if (
    !Number.isInteger(request.maxAgeSeconds)
    || request.maxAgeSeconds < INVITE_LIMITS.minAgeSeconds
    || request.maxAgeSeconds > INVITE_LIMITS.maxAgeSeconds
  ) {
    throw new RangeError(
      `Discord invite lifetime must be an integer between ${INVITE_LIMITS.minAgeSeconds} and ${INVITE_LIMITS.maxAgeSeconds} seconds`,
    )
  }
  if (
    !Number.isInteger(request.maxUses)
    || request.maxUses < 1
    || request.maxUses > INVITE_LIMITS.maxUses
  ) {
    throw new RangeError(
      `Discord invite use limit must be an integer between 1 and ${INVITE_LIMITS.maxUses}`,
    )
  }
  if (typeof request.temporaryMembership !== "boolean") {
    throw new RangeError(
      "Discord invite creation requires explicit temporary-membership intent",
    )
  }
  if (roleAssignment.kind === "grant" && request.temporaryMembership) {
    throw new RangeError(
      "Discord invite role assignment cannot claim temporary membership because granted roles persist",
    )
  }
  if (typeof request.outputFile !== "string") {
    throw new RangeError("Discord invite capability output file must be a string")
  }
  return {
    ...request,
    acceptance,
    operationKeyHash: operationKeyHash(request.operationKey),
    roleAssignment,
  }
}

function validText(value: unknown, maximum: number): value is string {
  if (
    typeof value !== "string"
    || [...value].length < 1
    || [...value].length > maximum
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) return false
  try {
    encodeURIComponent(value)
    return true
  } catch {
    return false
  }
}

function canonicalInviteTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value
}

function exactGuild(
  value: DiscordGuild,
  guildId: string,
): DiscordGuild & { owner_id: string } {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || value.id !== guildId
    || !validText(value.name, DISCORD_LIMITS.channelNameCharacters)
    || !positiveSnowflake(value.owner_id)
  ) {
    throw evidenceError("Discord returned incomplete or mismatched invite guild evidence")
  }
  return value as DiscordGuild & { owner_id: string }
}

function validVanityCode(value: unknown): value is string {
  return validText(value, INVITE_LIMITS.codeCharacters)
    && !URL_DOT_PATH_SEGMENTS.has(value)
}

function exactVanityGuild(
  value: DiscordGuild,
  guildId: string,
): DiscordGuild & {
  features: string[]
  owner_id: string
  vanity_url_code: string | null
} {
  const guild = exactGuild(value, guildId)
  if (
    !Array.isArray(guild.features)
    || guild.features.length > DISCORD_LIMITS.guildFeatures
    || new Set(guild.features).size !== guild.features.length
    || guild.features.some((feature) => (
      typeof feature !== "string"
      || feature.length < 1
      || feature.length > DISCORD_LIMITS.guildFeatureCharacters
      || !GUILD_FEATURE_PATTERN.test(feature)
    ))
    || !Object.hasOwn(guild, "vanity_url_code")
    || !(
      guild.vanity_url_code === null
      || validVanityCode(guild.vanity_url_code)
    )
  ) {
    throw evidenceError(
      "Discord returned incomplete or invalid guild vanity URL evidence",
    )
  }
  const eligible = guild.features.includes(VANITY_URL_FEATURE)
  if (!eligible && guild.vanity_url_code !== null) {
    throw evidenceError(
      "Discord returned contradictory guild vanity URL feature evidence",
    )
  }
  return guild as DiscordGuild & {
    features: string[]
    owner_id: string
    vanity_url_code: string | null
  }
}

function exactVanitySummary(
  value: DiscordGuildVanitySummary,
): DiscordGuildVanitySummary {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !(value.code === null || validVanityCode(value.code))
    || !Number.isSafeInteger(value.uses)
    || value.uses < 0
    || !Number.isSafeInteger(value.unknownFieldCount)
    || value.unknownFieldCount < 0
    || value.unknownFieldCount > MAX_PROJECTED_UNKNOWN_FIELDS
  ) {
    throw evidenceError("Discord returned invalid projected guild vanity URL evidence")
  }
  return value
}

function exactBotMember(
  value: DiscordGuildMember,
  guildId: string,
  botId: string,
): DiscordGuildMember {
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
    || value.roles.some((roleId) => !positiveSnowflake(roleId))
    || new Set(value.roles).size !== value.roles.length
  ) {
    throw evidenceError("Discord returned incomplete or mismatched invite bot evidence")
  }
  return value
}

function exactRoles(value: readonly DiscordRole[], guildId: string): ValidatedRole[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > DISCORD_LIMITS.guildRoles) {
    throw evidenceError("Discord returned an invalid bounded invite role inventory")
  }
  const roles: ValidatedRole[] = []
  const roleIds = new Set<string>()
  for (const role of value) {
    if (
      !role
      || typeof role !== "object"
      || Array.isArray(role)
      || !positiveSnowflake(role.id)
      || !validText(role.name, DISCORD_LIMITS.roleNameCharacters)
      || typeof role.managed !== "boolean"
      || !Number.isInteger(role.position)
      || role.position < 0
      || roleIds.has(role.id)
    ) {
      throw evidenceError("Discord returned invalid or duplicate invite role evidence")
    }
    let permissions: bigint
    try {
      permissions = parseDiscordPermissionBits(role.permissions, `role ${role.id}`)
    } catch (error) {
      throw new InviteEvidenceError("Discord returned invalid invite role permissions", {
        cause: error,
      })
    }
    roleIds.add(role.id)
    const unknownPermissionBits = unknownDiscordPermissionBits(permissions)
    roles.push({
      id: role.id,
      managed: role.managed,
      name: role.name,
      permissionNames: discordPermissionNames(permissions),
      permissions: permissions.toString(),
      position: role.position,
      unknownPermissionBits: unknownPermissionBits.toString(),
    })
  }
  const everyone = roles.find((role) => role.id === guildId)
  if (
    !everyone
    || everyone.name !== "@everyone"
    || everyone.managed
    || everyone.position !== 0
  ) {
    throw evidenceError("Discord returned invalid invite @everyone role evidence")
  }
  return roles.sort((left, right) => left.id.localeCompare(right.id))
}

function exactChannels(
  value: readonly DiscordChannel[],
  guildId: string,
): InviteChannelProjection[] {
  if (!Array.isArray(value) || value.length > DISCORD_LIMITS.guildChannels) {
    throw evidenceError("Discord returned an invalid bounded invite channel inventory")
  }
  const channels: InviteChannelProjection[] = []
  const ids = new Set<string>()
  for (const channel of value) {
    if (
      !channel
      || typeof channel !== "object"
      || Array.isArray(channel)
      || !positiveSnowflake(channel.id)
      || channel.guild_id !== guildId
      || (DIRECT_GUILD_CHANNEL_TYPES.has(channel.type)
        && !validText(channel.name, DISCORD_LIMITS.channelNameCharacters))
      || !Number.isSafeInteger(channel.type)
      || channel.type < 0
      || ids.has(channel.id)
    ) {
      throw evidenceError("Discord returned invalid or duplicate invite channel evidence")
    }
    ids.add(channel.id)
    channels.push({
      id: channel.id,
      name: DIRECT_GUILD_CHANNEL_TYPES.has(channel.type) ? channel.name as string : null,
      type: channel.type,
    })
  }
  return channels.sort((left, right) => left.id.localeCompare(right.id))
}

const INVITE_OVERWRITE_KEYS: ReadonlySet<string> = new Set([
  "allow",
  "deny",
  "id",
  "type",
])

function exactInviteCreationChannel(
  value: readonly DiscordChannel[],
  guildId: string,
  channelId: string,
  roles: readonly ValidatedRole[],
): InviteCreationState["channel"] {
  const channel = value.find((entry) => entry.id === channelId)
  if (
    !channel
    || channel.guild_id !== guildId
    || !INVITE_CREATION_CHANNEL_TYPES.has(channel.type)
    || !validText(channel.name, DISCORD_LIMITS.channelNameCharacters)
    || !Array.isArray(channel.permission_overwrites)
    || channel.permission_overwrites.length > DISCORD_LIMITS.channelPermissionOverwrites
  ) {
    throw evidenceError(
      "Discord invite creation requires one supported direct guild channel with complete overwrite evidence",
    )
  }
  const rolesById = new Set(roles.map((role) => role.id))
  const seen = new Set<string>()
  const permissionOverwrites = channel.permission_overwrites.map((overwrite) => {
    if (
      !overwrite
      || typeof overwrite !== "object"
      || Array.isArray(overwrite)
      || Object.keys(overwrite).some((key) => !INVITE_OVERWRITE_KEYS.has(key))
      || Object.keys(overwrite).length !== INVITE_OVERWRITE_KEYS.size
      || !positiveSnowflake(overwrite.id)
      || (overwrite.type !== 0 && overwrite.type !== 1)
      || typeof overwrite.allow !== "string"
      || typeof overwrite.deny !== "string"
      || (overwrite.type === 0 && !rolesById.has(overwrite.id))
    ) {
      throw evidenceError("Discord returned invalid invite-creation overwrite evidence")
    }
    let allow: bigint
    let deny: bigint
    try {
      allow = parseDiscordPermissionBits(overwrite.allow, "invite-creation overwrite allow")
      deny = parseDiscordPermissionBits(overwrite.deny, "invite-creation overwrite deny")
    } catch (error) {
      throw new InviteEvidenceError(
        "Discord returned invalid invite-creation overwrite permissions",
        { cause: error },
      )
    }
    if ((allow & deny) !== 0n) {
      throw evidenceError("Discord returned contradictory invite-creation overwrites")
    }
    const key = `${overwrite.type}:${overwrite.id}`
    if (seen.has(key)) {
      throw evidenceError("Discord returned duplicate invite-creation overwrites")
    }
    seen.add(key)
    return {
      allow: allow.toString(),
      deny: deny.toString(),
      id: overwrite.id,
      type: overwrite.type,
    }
  }).sort((left, right) => (
    left.type - right.type || left.id.localeCompare(right.id)
  ))
  return {
    ...channel,
    guild_id: guildId,
    name: channel.name,
    permission_overwrites: permissionOverwrites,
  }
}

function canonicalInviteRoleOverwrites(
  channel: DiscordChannel,
): Array<{ allow: bigint; deny: bigint; id: string; type: 0 | 1 }> {
  if (
    !Array.isArray(channel.permission_overwrites)
    || channel.permission_overwrites.length > DISCORD_LIMITS.channelPermissionOverwrites
  ) {
    throw evidenceError(
      "Discord invite role assignment requires complete bounded channel overwrite evidence",
    )
  }
  const seen = new Set<string>()
  const overwrites = channel.permission_overwrites.map((overwrite) => {
    if (
      !overwrite
      || typeof overwrite !== "object"
      || Array.isArray(overwrite)
      || Object.keys(overwrite).some((key) => !INVITE_OVERWRITE_KEYS.has(key))
      || Object.keys(overwrite).length !== INVITE_OVERWRITE_KEYS.size
      || !positiveSnowflake(overwrite.id)
      || (overwrite.type !== 0 && overwrite.type !== 1)
      || typeof overwrite.allow !== "string"
      || typeof overwrite.deny !== "string"
    ) {
      throw evidenceError("Discord returned invalid invite role-assignment overwrites")
    }
    const key = `${overwrite.type}\0${overwrite.id}`
    if (seen.has(key)) {
      throw evidenceError("Discord returned duplicate invite role-assignment overwrites")
    }
    seen.add(key)
    let allow: bigint
    let deny: bigint
    try {
      allow = parseDiscordPermissionBits(
        overwrite.allow,
        `invite role-assignment overwrite ${overwrite.id} allow`,
      )
      deny = parseDiscordPermissionBits(
        overwrite.deny,
        `invite role-assignment overwrite ${overwrite.id} deny`,
      )
    } catch (error) {
      throw new InviteEvidenceError(
        "Discord returned invalid invite role-assignment overwrite permissions",
        { cause: error },
      )
    }
    if ((allow & deny) !== 0n) {
      throw evidenceError("Discord returned contradictory invite role-assignment overwrites")
    }
    if (((allow | deny) & ALL_KNOWN_PERMISSION_BITS
      & ~INVITE_ROLE_CHANNEL_PERMISSION_MASK) !== 0n) {
      throw evidenceError(
        "Discord invite role-assignment overwrite contains known permissions that are not channel-scoped",
      )
    }
    return {
      allow,
      deny,
      id: overwrite.id,
      type: overwrite.type as 0 | 1,
    }
  })
  return overwrites.sort((left, right) => (
    compareSnowflakes(left.id, right.id) || left.type - right.type
  ))
}

function exactInviteRoleImpactChannels(
  value: readonly DiscordChannel[],
  guildId: string,
  roles: readonly ValidatedRole[],
): InviteRoleImpactChannel[] {
  if (!Array.isArray(value) || value.length > DISCORD_LIMITS.guildChannels) {
    throw evidenceError(
      "Discord returned an invalid bounded invite role-assignment channel inventory",
    )
  }
  const roleIds = new Set(roles.map((role) => role.id))
  const channelIds = new Set<string>()
  const channels = value.map((channel) => {
    if (
      !channel
      || typeof channel !== "object"
      || Array.isArray(channel)
      || !positiveSnowflake(channel.id)
      || channelIds.has(channel.id)
      || channel.guild_id !== guildId
      || !isGuildChannelTopologyType(channel.type)
      || !Number.isSafeInteger(channel.position)
      || (channel.position as number) < 0
      || (
        DIRECT_GUILD_CHANNEL_TYPES.has(channel.type)
        && !validText(channel.name, DISCORD_LIMITS.channelNameCharacters)
      )
      || (
        channel.parent_id !== undefined
        && channel.parent_id !== null
        && !positiveSnowflake(channel.parent_id)
      )
    ) {
      throw evidenceError(
        "Discord returned incomplete or mismatched invite role-assignment channel evidence",
      )
    }
    channelIds.add(channel.id)
    for (const overwrite of DIRECT_GUILD_CHANNEL_TYPES.has(channel.type)
      ? canonicalInviteRoleOverwrites(channel) : []) {
      if (overwrite.type === 0 && !roleIds.has(overwrite.id)) {
        throw evidenceError(
          "Discord returned an unresolved invite role-assignment role overwrite",
        )
      }
    }
    return channel
  })
  const channelsById = new Map(channels.map((channel) => [channel.id, channel]))
  for (const channel of channels) {
    if (channel.type === DISCORD_CHANNEL_TYPES.category && channel.parent_id) {
      throw evidenceError("Discord returned a parented invite role-assignment category")
    }
    if (channel.parent_id) {
      const parent = channelsById.get(channel.parent_id)
      if (!parent || parent.type !== DISCORD_CHANNEL_TYPES.category) {
        throw evidenceError(
          "Discord returned an unresolved invite role-assignment channel parent",
        )
      }
    }
  }
  return channels.filter((channel) => DIRECT_GUILD_CHANNEL_TYPES.has(channel.type))
    .sort((left, right) => compareSnowflakes(left.id, right.id)) as InviteRoleImpactChannel[]
}

function inviteRolePermissionDecision(
  result: PrincipalPermissionResult,
  permission: DiscordPermissionName,
): InviteRolePermissionDecision {
  if (result.missingPermissions.includes(permission)) return "denied"
  if (result.ineffectivePermissions.includes(permission)) return "ineffective"
  return "allowed"
}

function effectiveGuildPermissionNames(
  result: GuildMemberPermissionResult,
): DiscordPermissionName[] {
  return result.administrator
    ? [...DISCORD_PERMISSION_NAMES]
    : [...result.effectivePermissionNames]
}

function inviteRoleGuildPermissionImpact(
  before: GuildMemberPermissionResult,
  after: GuildMemberPermissionResult,
): InviteRoleGuildPermissionImpact {
  const beforeNames = effectiveGuildPermissionNames(before)
  const afterNames = effectiveGuildPermissionNames(after)
  const beforeSet = new Set(beforeNames)
  return {
    added: afterNames.filter((permission) => !beforeSet.has(permission)),
    after: afterNames,
    before: beforeNames,
  }
}

function inviteRoleChannelImpact(
  guild: DiscordGuild & { owner_id: string },
  roles: readonly ValidatedRole[],
  channels: readonly InviteRoleImpactChannel[],
  roleIds: readonly string[],
): InviteRoleChannelImpact[] {
  const beforeMember: DiscordGuildMember = { roles: [] }
  const afterMember: DiscordGuildMember = { roles: [...roleIds] }
  const impact: InviteRoleChannelImpact[] = []
  for (const channel of channels) {
    let before: PrincipalPermissionResult
    let after: PrincipalPermissionResult
    try {
      before = evaluatePrincipalPermissions({
        channel,
        guildId: guild.id,
        guildOwnerId: guild.owner_id,
        permissionChannel: channel,
        requestedPermissions: INVITE_ROLE_IMPACT_PERMISSIONS,
        roles,
        subject: {
          id: HYPOTHETICAL_INVITEE_ID,
          kind: "member",
          member: beforeMember,
        },
      })
      after = evaluatePrincipalPermissions({
        channel,
        guildId: guild.id,
        guildOwnerId: guild.owner_id,
        permissionChannel: channel,
        requestedPermissions: INVITE_ROLE_IMPACT_PERMISSIONS,
        roles,
        subject: {
          id: HYPOTHETICAL_INVITEE_ID,
          kind: "member",
          member: afterMember,
        },
      })
    } catch (error) {
      throw new InviteEvidenceError(
        `Discord invite role-assignment channel impact is invalid: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    if (before.confidence !== "complete" || after.confidence !== "complete") {
      throw evidenceError(
        `Discord invite role-assignment channel impact is incomplete for channel ${channel.id}`,
      )
    }
    const changes = INVITE_ROLE_IMPACT_PERMISSIONS.flatMap((permission) => {
      const beforeDecision = inviteRolePermissionDecision(before, permission)
      const afterDecision = inviteRolePermissionDecision(after, permission)
      return beforeDecision === afterDecision
        ? []
        : [{ after: afterDecision, before: beforeDecision, permission }]
    })
    if (changes.length > 0) {
      impact.push({
        channelId: channel.id,
        channelName: channel.name,
        channelType: channel.type,
        changes,
      })
    }
  }
  if (impact.length > CONNECTOR_LIMITS.memberRoleImpactChannels) {
    throw evidenceError(
      `Discord invite role assignment affects more than ${CONNECTOR_LIMITS.memberRoleImpactChannels} direct channels`,
    )
  }
  return impact
}

function assertInviteRoleChannelPermissionSubset(options: {
  botMember: DiscordGuildMember
  channels: readonly InviteRoleImpactChannel[]
  guild: DiscordGuild & { owner_id: string }
  impact: readonly InviteRoleChannelImpact[]
  roleIds: readonly string[]
  roles: readonly ValidatedRole[]
}): void {
  const selectedRoleIds = new Set(options.roleIds)
  const impactByChannelId = new Map(
    options.impact.map((entry) => [entry.channelId, entry]),
  )
  for (const channel of options.channels) {
    const selectedAllows = new Set<DiscordPermissionName>()
    for (const overwrite of canonicalInviteRoleOverwrites(channel)) {
      if (overwrite.type !== 0 || !selectedRoleIds.has(overwrite.id)) continue
      for (const permission of discordPermissionNames(overwrite.allow)) {
        selectedAllows.add(permission)
      }
      if (unknownDiscordPermissionBits(overwrite.allow | overwrite.deny) !== 0n) {
        throw evidenceError(
          `Discord selected invite role overwrite contains unknown permissions in channel ${channel.id}`,
        )
      }
    }
    const gains = impactByChannelId.get(channel.id)?.changes.filter((change) => (
      change.before !== "allowed" && change.after === "allowed"
    )) ?? []
    if (selectedAllows.size === 0 && gains.length === 0) continue
    let botPermissions: PrincipalPermissionResult
    try {
      botPermissions = evaluatePrincipalPermissions({
        channel,
        guildId: options.guild.id,
        guildOwnerId: options.guild.owner_id,
        permissionChannel: channel,
        requestedPermissions: INVITE_ROLE_IMPACT_PERMISSIONS,
        roles: options.roles,
        subject: {
          id: options.botMember.user?.id as string,
          kind: "member",
          member: options.botMember,
        },
      })
    } catch (error) {
      throw new InviteEvidenceError(
        `Discord connector invite role-assignment channel permissions are invalid: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    if (botPermissions.confidence !== "complete") {
      throw evidenceError(
        `Discord connector invite role-assignment channel permissions are incomplete for channel ${channel.id}`,
      )
    }
    const required = new Set([
      ...selectedAllows,
      ...gains.map((change) => change.permission),
    ])
    for (const permission of required) {
      if (inviteRolePermissionDecision(botPermissions, permission) === "allowed") continue
      throw evidenceError(
        `Discord connector bot cannot grant channel permission ${permission} through invite role assignment in channel ${channel.id}`,
      )
    }
  }
}

function inviteRoleChannelSnapshot(channels: readonly InviteRoleImpactChannel[]) {
  return channels.map((channel) => ({
    id: channel.id,
    overwrites: canonicalInviteRoleOverwrites(channel).map((overwrite) => ({
      allow: overwrite.allow.toString(),
      deny: overwrite.deny.toString(),
      id: overwrite.id,
      type: overwrite.type,
    })),
    parentId: channel.parent_id ?? null,
    type: channel.type,
  }))
}

function buildInviteRoleAssignmentReview(options: {
  coverage: GuildChannelAnalysisCoverage
  botMember: DiscordGuildMember
  channelEvidence: GuildChannelEvidenceView
  channels: readonly InviteRoleImpactChannel[]
  guild: DiscordGuild & { owner_id: string }
  request: NormalizedInviteCreationRequest & {
    roleAssignment: Extract<NormalizedInviteCreationRequest["roleAssignment"], { kind: "grant" }>
  }
  roles: readonly ValidatedRole[]
}): InviteRoleAssignmentReview {
  const botPermissions = completePermissions(
    options.botMember,
    options.guild.id,
    options.roles,
  )
  if (botPermissions.highestRoleIds.length !== 1) {
    throw evidenceError(
      "Discord connector bot highest-role evidence is ambiguous for invite role assignment",
    )
  }
  const selectedRoles = options.request.roleAssignment.roleIds.map((roleId) => {
    const role = options.roles.find((candidate) => candidate.id === roleId)
    if (!role) {
      throw evidenceError(
        `Discord invite role-assignment inventory omitted selected role ${roleId}`,
      )
    }
    if (
      role.id === options.guild.id
      || role.managed
      || role.position < 1
    ) {
      throw evidenceError(
        "Discord invite role assignment requires standard unmanaged roles other than @everyone",
      )
    }
    if (botPermissions.highestRolePosition <= role.position) {
      throw evidenceError(
        `Discord invite role ${role.id} must be strictly below the connector bot's highest role`,
      )
    }
    const permissionBits = BigInt(role.permissions)
    if ((permissionBits & DISCORD_PERMISSIONS.ADMINISTRATOR) !== 0n) {
      throw evidenceError("Discord invite role assignment never grants ADMINISTRATOR")
    }
    if (BigInt(role.unknownPermissionBits) !== 0n) {
      throw evidenceError(
        `Discord invite role ${role.id} contains permissions unknown to this build`,
      )
    }
    const botBits = BigInt(botPermissions.effectivePermissions)
    const grantable = botPermissions.administrator
      ? botBits | ALL_KNOWN_PERMISSION_BITS
      : botBits
    const unavailable = permissionBits & ~grantable
    if (unavailable !== 0n) {
      throw evidenceError(
        `Discord connector bot cannot grant invite role ${role.id} permissions: ${discordPermissionNames(unavailable).join(", ") || unavailable.toString()}`,
      )
    }
    return role
  })
  const beforePermissions = completePermissions(
    { roles: [] },
    options.guild.id,
    options.roles,
  )
  const afterPermissions = completePermissions(
    { roles: [...options.request.roleAssignment.roleIds] },
    options.guild.id,
    options.roles,
  )
  const guildPermissions = inviteRoleGuildPermissionImpact(
    beforePermissions,
    afterPermissions,
  )
  const impact = inviteRoleChannelImpact(
    options.guild,
    options.roles,
    options.channels,
    options.request.roleAssignment.roleIds,
  )
  assertInviteRoleChannelPermissionSubset({
    botMember: options.botMember,
    channels: options.channels,
    guild: options.guild,
    impact,
    roleIds: options.request.roleAssignment.roleIds,
    roles: options.roles,
  })
  const gains = new Set<DiscordPermissionName>(guildPermissions.added)
  for (const channel of impact) {
    for (const change of channel.changes) {
      if (change.before !== "allowed" && change.after === "allowed") {
        gains.add(change.permission)
      }
    }
  }
  const highRiskPermissionGains = DISCORD_PERMISSION_NAMES.filter((permission) => (
    gains.has(permission) && HIGH_RISK_ROLE_PERMISSIONS.has(permission)
  ))
  return {
    acknowledgePersistentGrants: true,
    assignedRoles: selectedRoles.map((role) => ({
      highRiskPermissions: role.permissionNames.filter((permission) => (
        HIGH_RISK_ROLE_PERMISSIONS.has(permission)
      )),
      id: role.id,
      name: role.name,
      permissionNames: [...role.permissionNames],
      permissions: role.permissions,
      position: role.position,
    })),
    channelEvidence: options.channelEvidence,
    highRiskPermissionGains,
    impact: {
      coverage: options.coverage,
      changedChannels: impact.length,
      channels: impact,
      evaluatedChannels: options.channels.length,
      guildPermissions,
      projection: "minimum-new-member",
    },
    kind: "grant",
    persistence: "manual-removal-required",
    roleIds: [...options.request.roleAssignment.roleIds],
  }
}

function completePermissions(
  member: DiscordGuildMember,
  guildId: string,
  roles: readonly ValidatedRole[],
): GuildMemberPermissionResult {
  let result: GuildMemberPermissionResult
  try {
    result = evaluateGuildMemberPermissions({ guildId, member, roles })
  } catch (error) {
    throw new InviteEvidenceError("Discord returned invalid invite permission evidence", {
      cause: error,
    })
  }
  if (!result.complete) {
    throw evidenceError("Discord returned incomplete invite permission evidence")
  }
  return result
}

function inviteCreationAccessEvidence(
  botId: string,
  guild: DiscordGuild & { owner_id: string },
  member: DiscordGuildMember,
  roles: readonly ValidatedRole[],
  channel: InviteCreationState["channel"],
  acceptanceKind: NormalizedInviteCreationRequest["acceptance"]["kind"],
  roleAssignmentKind: NormalizedInviteCreationRequest["roleAssignment"]["kind"],
): InviteCreationAccessEvidence {
  let permissions: BotChannelPermissionResult
  try {
    permissions = evaluateBotChannelPermissions({
      botId,
      channel,
      guildId: guild.id,
      member,
      permissionChannel: channel,
      roles,
    })
  } catch (error) {
    throw new InviteEvidenceError(
      "Discord returned invalid invite-creation permission evidence",
      { cause: error },
    )
  }
  if (permissions.confidence !== "complete") {
    throw evidenceError("Discord returned incomplete invite-creation permission evidence")
  }
  const botIsGuildOwner = guild.owner_id === botId
  const effectivePermissions = botIsGuildOwner
    ? (ALL_KNOWN_PERMISSION_BITS | BigInt(permissions.effectivePermissions)).toString()
    : permissions.effectivePermissions
  const effectivePermissionNames = botIsGuildOwner
    ? [...DISCORD_PERMISSION_NAMES]
    : [...permissions.effectivePermissionNames]
  const guildPermissions = completePermissions(member, guild.id, roles)
  const manageGuild = botIsGuildOwner || hasGuildPermission(guildPermissions, "MANAGE_GUILD")
  const manageRoles = botIsGuildOwner || hasGuildPermission(guildPermissions, "MANAGE_ROLES")
  const requiredPermissions: DiscordPermissionName[] = [
    ...INVITE_CREATION_BEARER_REQUIRED_PERMISSIONS,
    ...(acceptanceKind === "exact-users" ? ["MANAGE_GUILD" as const] : []),
    ...(roleAssignmentKind === "grant" ? ["MANAGE_ROLES" as const] : []),
  ].sort((left, right) => DISCORD_PERMISSION_NAMES.indexOf(left)
    - DISCORD_PERMISSION_NAMES.indexOf(right))
  for (const permission of INVITE_CREATION_BEARER_REQUIRED_PERMISSIONS) {
    if (!effectivePermissionNames.includes(permission)) {
      throw evidenceError(
        `Discord connector bot lacks channel-level ${permission} for invite creation`,
      )
    }
  }
  if (acceptanceKind === "exact-users" && !manageGuild) {
    throw evidenceError(
      "Discord connector bot lacks guild-level MANAGE_GUILD for exact-user invite creation",
    )
  }
  if (roleAssignmentKind === "grant" && !manageRoles) {
    throw evidenceError(
      "Discord connector bot lacks guild-level MANAGE_ROLES for invite role assignment",
    )
  }
  return {
    appliedRoleIds: [...permissions.appliedRoleIds].sort(),
    botAdministrator: permissions.administrator,
    botHighestRoleIds: [...guildPermissions.highestRoleIds],
    botHighestRolePosition: guildPermissions.highestRolePosition,
    botIsGuildOwner,
    complete: true,
    createInstantInvite: true,
    effectivePermissionNames,
    effectivePermissions,
    manageGuild,
    manageRoles,
    requiredPermissions,
    unknownPermissionBits: permissions.unknownPermissionBits,
    viewChannel: true,
  }
}

function accessEvidence(
  permissions: GuildMemberPermissionResult,
  botIsGuildOwner: boolean,
): InviteAccessEvidence {
  return {
    appliedRoleIds: permissions.appliedRoleIds,
    botAdministrator: permissions.administrator,
    botIsGuildOwner,
    complete: true,
    effectivePermissionNames: permissions.effectivePermissionNames,
    effectivePermissions: permissions.effectivePermissions,
    manageGuild: true,
    requiredPermission: "MANAGE_GUILD",
    unknownPermissionBits: unknownDiscordPermissionBits(
      BigInt(permissions.effectivePermissions),
    ).toString(),
  }
}

function privacyProjection(): InvitePrivacyProjection {
  return {
    capabilitiesProjectedOut: true,
    omittedFields: INVITE_OMITTED_FIELDS,
    persistence: "none",
    rawPayloads: "omitted",
  }
}

function hmacHex(key: Uint8Array, domain: string, payload: string): string {
  return createHmac("sha256", key)
    .update(domain)
    .update("\0")
    .update(payload)
    .digest("hex")
}

function createInviteReference(
  key: Uint8Array,
  guildId: string,
  code: string,
): string {
  return `${INVITE_REFERENCE_PREFIX}${hmacHex(
    key,
    "guildcontrol-invite-reference.v1",
    `${guildId}\0${code}`,
  )}`
}

function roleProjection(
  roleId: string,
  guildId: string,
  rolesById: ReadonlyMap<string, ValidatedRole>,
): InviteGrantedRoleProjection {
  const role = rolesById.get(roleId)
  if (!role || roleId === guildId) {
    throw evidenceError("Discord invite references an absent or invalid granted role")
  }
  const bits = BigInt(role.permissions)
  const permissionNames = discordPermissionNames(bits)
  return {
    highRiskPermissions: permissionNames.filter((name) => (
      HIGH_RISK_ROLE_PERMISSIONS.has(name)
    )),
    permissionNames,
    permissions: bits.toString(),
    roleId,
    unknownPermissionBits: unknownDiscordPermissionBits(bits).toString(),
  }
}

function projectedInvite(
  invite: DiscordInviteSummary,
  guildId: string,
  channelsById: ReadonlyMap<string, InviteChannelProjection>,
  rolesById: ReadonlyMap<string, ValidatedRole>,
  planKey: Uint8Array,
): ProjectedInvite {
  if (
    !invite
    || typeof invite !== "object"
    || Array.isArray(invite)
    || invite.type !== 0
    || invite.guildId !== guildId
    || !positiveSnowflake(invite.channelId)
    || !validText(invite.code, INVITE_LIMITS.codeCharacters)
    || !canonicalInviteTimestamp(invite.createdAt)
    || !(invite.expiresAt === null || canonicalInviteTimestamp(invite.expiresAt))
    || invite.expiresAt !== null && Date.parse(invite.expiresAt) < Date.parse(invite.createdAt)
    || !Number.isSafeInteger(invite.flags)
    || invite.flags < 0
    || !(invite.inviterUserId === null || positiveSnowflake(invite.inviterUserId))
    || !Number.isSafeInteger(invite.maxAge)
    || invite.maxAge < 0
    || invite.maxAge > INVITE_LIMITS.maxAgeSeconds
    || (invite.maxAge === 0) !== (invite.expiresAt === null)
    || !Number.isSafeInteger(invite.maxUses)
    || invite.maxUses < 0
    || invite.maxUses > INVITE_LIMITS.maxUses
    || !Array.isArray(invite.roleIds)
    || invite.roleIds.length > INVITE_LIMITS.roleIds
    || invite.roleIds.some((roleId) => !positiveSnowflake(roleId))
    || new Set(invite.roleIds).size !== invite.roleIds.length
    || !(invite.targetApplicationId === null || positiveSnowflake(invite.targetApplicationId))
    || !(invite.targetType === null || invite.targetType === 1 || invite.targetType === 2)
    || !(invite.targetUserId === null || positiveSnowflake(invite.targetUserId))
    || typeof invite.temporary !== "boolean"
    || !Number.isSafeInteger(invite.uses)
    || invite.uses < 0
    || invite.uses > invite.maxUses && invite.maxUses !== 0
  ) {
    throw evidenceError("Discord returned contradictory guild invite evidence")
  }
  const channel = channelsById.get(invite.channelId)
  if (!channel) {
    throw evidenceError("Discord invite references a channel outside the visible guild inventory")
  }
  const roles = invite.roleIds
    .map((roleId) => roleProjection(roleId, guildId, rolesById))
    .sort((left, right) => left.roleId.localeCompare(right.roleId))
  let target: ProjectedInvite["target"] = null
  if (invite.targetType === 1) {
    if (!invite.targetUserId || invite.targetApplicationId) {
      throw evidenceError("Discord returned contradictory stream invite evidence")
    }
    target = { id: invite.targetUserId, kind: "stream" }
  } else if (invite.targetType === 2) {
    if (!invite.targetApplicationId || invite.targetUserId) {
      throw evidenceError("Discord returned contradictory application invite evidence")
    }
    target = { id: invite.targetApplicationId, kind: "embedded-application" }
  } else if (
    invite.targetType !== null
    || invite.targetUserId !== null
    || invite.targetApplicationId !== null
  ) {
    throw evidenceError("Discord returned an unknown or contradictory invite target")
  }
  const unknownBits = (BigInt(invite.flags) & ~BigInt(INVITE_GUEST_FLAG)).toString()
  const guest = (invite.flags & INVITE_GUEST_FLAG) === INVITE_GUEST_FLAG
  const riskFlags = [
    ...(invite.uses > 0 ? ["already-used"] : []),
    ...(guest ? ["guest-access"] : []),
    ...(roles.length > 0 ? ["role-grant"] : []),
    ...(roles.some((role) => role.highRiskPermissions.length > 0)
      ? ["high-risk-role-grant"]
      : []),
    ...(roles.some((role) => role.unknownPermissionBits !== "0")
      ? ["unknown-role-permissions"]
      : []),
    ...(invite.expiresAt === null || invite.maxAge === 0 ? ["non-expiring"] : []),
    ...(invite.maxUses === 0 ? ["unlimited-use"] : []),
    ...(invite.temporary ? ["temporary-membership"] : []),
    ...(target ? ["targeted"] : []),
    ...(unknownBits !== "0" ? ["unknown-flags"] : []),
  ].sort()
  return {
    channel,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    flags: {
      guest,
      raw: invite.flags,
      unknownBits,
    },
    inviteRef: createInviteReference(planKey, guildId, invite.code),
    inviterUserId: invite.inviterUserId,
    maxAgeSeconds: invite.maxAge,
    maxUses: invite.maxUses,
    riskFlags,
    roles,
    target,
    temporaryMembership: invite.temporary,
    uses: invite.uses,
  }
}

function cursorSignature(
  key: Uint8Array,
  encodedPayload: string,
): string {
  return hmacHex(key, "guildcontrol-invite-cursor.v1", encodedPayload)
}

function encodeCursor(key: Uint8Array, payload: InviteCursorPayload): string {
  const encoded = Buffer.from(stableString(payload), "utf8").toString("base64url")
  const cursor = `${INVITE_CURSOR_PREFIX}${encoded}.${cursorSignature(key, encoded)}`
  if (cursor.length > INVITE_LIMITS.cursorCharacters) {
    throw evidenceError("Discord invite cursor exceeded its local safety bound")
  }
  return cursor
}

function decodeCursor(
  key: Uint8Array,
  cursor: string,
  guildId: string,
): InviteCursorPayload {
  if (!INVITE_CURSOR_PATTERN.test(cursor) || cursor.length > INVITE_LIMITS.cursorCharacters) {
    throw new RangeError("Discord invite-audit cursor is invalid or expired")
  }
  const separator = cursor.lastIndexOf(".")
  const encoded = cursor.slice(INVITE_CURSOR_PREFIX.length, separator)
  const signature = cursor.slice(separator + 1)
  const expected = cursorSignature(key, encoded)
  const signatureBytes = Buffer.from(signature, "hex")
  const expectedBytes = Buffer.from(expected, "hex")
  if (
    signatureBytes.length !== expectedBytes.length
    || !timingSafeEqual(signatureBytes, expectedBytes)
  ) {
    throw new RangeError("Discord invite-audit cursor is invalid or expired")
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown
  } catch {
    throw new RangeError("Discord invite-audit cursor is invalid or expired")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError("Discord invite-audit cursor is invalid or expired")
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).sort().join("\0") !== [
      "guildId",
      "inventoryDigest",
      "offset",
      "version",
    ].join("\0")
    || record.version !== 1
    || record.guildId !== guildId
    || typeof record.inventoryDigest !== "string"
    || !REVIEWED_PLAN_DIGEST_PATTERN.test(record.inventoryDigest)
    || !Number.isSafeInteger(record.offset)
    || (record.offset as number) < 1
    || (record.offset as number) > INVITE_LIMITS.inventory
  ) {
    throw new RangeError("Discord invite-audit cursor is invalid or expired")
  }
  return record as unknown as InviteCursorPayload
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
    inviteRef: receipt.resourceId,
    operationKeyHash: receipt.operationKeyHash,
    status: receipt.status,
    timestamp: receipt.timestamp,
    verification: receipt.verification,
  }
}

function activityEntry(options: {
  activityId: string
  error?: string | null
  guildId: string
  plan: InviteDeletionPlan
  request: NormalizedInviteDeletionRequest
  status: InviteDeletionActivityStatus
  timestamp: string
  verification?: "drift" | "match" | null
}): InviteDeletionActivity {
  return {
    channelId: options.plan.target.channel.id,
    error: options.error ?? null,
    guildId: options.guildId,
    id: options.activityId,
    inviteRef: options.request.inviteRef,
    kind: "invite-deletion",
    operationKeyHash: options.request.operationKeyHash,
    planDigest: options.plan.digest,
    schemaVersion: SCHEMA_VERSION,
    status: options.status,
    timestamp: options.timestamp,
    verification: options.verification ?? null,
  }
}

function operationReceipt(options: {
  activityId: string
  error?: string | null
  guildId: string
  plan: InviteDeletionPlan
  request: NormalizedInviteDeletionRequest
  status: OperationReceipt["status"]
  timestamp: string
  verification?: "drift" | "match" | null
}): OperationReceipt {
  return {
    activityId: options.activityId,
    error: options.error ?? null,
    guildId: options.guildId,
    kind: "invite-deletion",
    operationKeyHash: options.request.operationKeyHash,
    planDigest: options.plan.digest,
    resourceId: options.status === "completed" ? options.request.inviteRef : null,
    schemaVersion: 1,
    status: options.status,
    timestamp: options.timestamp,
    verification: options.verification ?? null,
  }
}

function inviteCreationActivityEntry(options: {
  activityId: string
  capabilityFileWritten?: boolean
  error?: string | null
  inviteRef?: string | null
  plan: InviteCreationPlan
  request: NormalizedInviteCreationRequest
  status: InviteCreationActivityStatus
  timestamp: string
  verification?: "match" | null
}): InviteCreationActivity {
  return {
    capabilityFileWritten: options.capabilityFileWritten ?? false,
    channelId: options.request.channelId,
    error: options.error ?? null,
    guildId: options.request.guildId,
    id: options.activityId,
    inviteRef: options.inviteRef ?? null,
    kind: "invite-creation",
    operationKeyHash: options.request.operationKeyHash,
    planDigest: options.plan.digest,
    schemaVersion: SCHEMA_VERSION,
    status: options.status,
    timestamp: options.timestamp,
    verification: options.verification ?? null,
  }
}

function inviteCreationOperationReceipt(options: {
  activityId: string
  error?: string | null
  inviteRef?: string | null
  plan: InviteCreationPlan
  request: NormalizedInviteCreationRequest
  status: OperationReceipt["status"]
  timestamp: string
  verification?: "match" | null
}): OperationReceipt {
  return {
    activityId: options.activityId,
    error: options.error ?? null,
    guildId: options.request.guildId,
    kind: "invite-creation",
    operationKeyHash: options.request.operationKeyHash,
    planDigest: options.plan.digest,
    resourceId: options.inviteRef ?? null,
    schemaVersion: 1,
    status: options.status,
    timestamp: options.timestamp,
    verification: options.verification ?? null,
  }
}

function assertCreatedInvite(
  invite: DiscordInviteSummary,
  botId: string,
  request: NormalizedInviteCreationRequest,
): void {
  if (
    invite.type !== 0
    || invite.guildId !== request.guildId
    || invite.channelId !== request.channelId
    || invite.inviterUserId !== botId
    || invite.maxAge !== request.maxAgeSeconds
    || invite.maxUses !== request.maxUses
    || invite.temporary !== request.temporaryMembership
    || invite.uses !== 0
    || invite.flags !== 0
    || stableString(invite.roleIds) !== stableString(
      request.roleAssignment.kind === "grant"
        ? request.roleAssignment.roleIds
        : [],
    )
    || invite.targetApplicationId !== null
    || invite.targetType !== null
    || invite.targetUserId !== null
    || invite.unknownFieldCount !== undefined
    || !canonicalInviteTimestamp(invite.createdAt)
    || !canonicalInviteTimestamp(invite.expiresAt)
    || Date.parse(invite.expiresAt) - Date.parse(invite.createdAt)
      !== request.maxAgeSeconds * 1_000
  ) {
    throw evidenceError("Discord returned mismatched invite-creation evidence")
  }
}

function assertInviteVerification(
  observed: DiscordInviteIdentitySummary,
  invite: DiscordInviteSummary,
  request: NormalizedInviteCreationRequest,
): void {
  if (
    observed.type !== 0
    || observed.guildId !== request.guildId
    || observed.channelId !== request.channelId
    || observed.code !== invite.code
    || stableString(observed.roleIds) !== stableString(invite.roleIds)
  ) {
    throw evidenceError("Discord returned mismatched exact invite verification evidence")
  }
}

function inviteAcceptanceSummary(
  request: NormalizedInviteCreationRequest,
): InviteCreationResult["acceptance"] {
  return {
    kind: request.acceptance.kind,
    targetUserCount: request.acceptance.kind === "exact-users"
      ? request.acceptance.userIds.length
      : 0,
  }
}

function inviteRoleAssignmentSummary(
  request: NormalizedInviteCreationRequest,
): InviteCreationResult["roleAssignment"] {
  return request.roleAssignment.kind === "none"
    ? { kind: "none", roleCount: 0 }
    : {
        kind: "grant",
        roleCount: request.roleAssignment.roleIds.length,
        roleIds: [...request.roleAssignment.roleIds],
      }
}

function inviteCapabilityContent(
  invite: DiscordInviteSummary,
  request: NormalizedInviteCreationRequest,
): string {
  return `${JSON.stringify({
    acceptance: inviteAcceptanceSummary(request),
    channelId: request.channelId,
    code: invite.code,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    guildId: request.guildId,
    kind: "discord-invite-capability",
    maxAgeSeconds: request.maxAgeSeconds,
    maxUses: request.maxUses,
    roleAssignment: inviteRoleAssignmentSummary(request),
    ...(request.roleAssignment.kind === "grant"
      ? {
          persistentRoleWarning: "Accepting this invite grants roles that remain after the invite expires or is deleted; role permissions and channel overwrites can change after this file is created or accepted",
        }
      : {}),
    schemaVersion: INVITE_CAPABILITY_FILE_SCHEMA_VERSION,
    temporaryMembership: request.temporaryMembership,
    url: `${DISCORD_INVITE_BASE_URL}/${encodeURIComponent(invite.code)}`,
  }, null, 2)}\n`
}

function uncertainExecution(error: unknown): boolean {
  if (
    !(error instanceof InviteDeletionExecutionError)
    || !error.result
    || typeof error.result !== "object"
    || !("status" in error.result)
  ) return false
  return error.result.status === "uncertain"
}

function uncertainInviteCreationExecution(error: unknown): boolean {
  if (
    !(error instanceof InviteCreationExecutionError)
    || !error.result
    || typeof error.result !== "object"
    || !("status" in error.result)
  ) return false
  const status = error.result.status
  return typeof status === "string" && (
    status === "uncertain"
    || status.startsWith("completed-")
  )
}

async function withTargetLock<T>(
  locks: Map<string, Promise<InviteTargetOutcome>>,
  key: string,
  operation: () => Promise<T>,
  priorUncertainError: () => InviteDeletionExecutionError,
): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve("settled" as const)
  let release: (outcome: InviteTargetOutcome) => void = () => undefined
  const tail = new Promise<InviteTargetOutcome>((resolve) => {
    release = resolve
  })
  locks.set(key, tail)
  let outcome: InviteTargetOutcome = "settled"
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
    if (outcome === "settled" && locks.get(key) === tail) locks.delete(key)
  }
}

async function withInviteCreationTargetLock<T>(
  locks: Map<string, Promise<InviteTargetOutcome>>,
  key: string,
  operation: () => Promise<T>,
  priorUncertainError: () => InviteCreationExecutionError,
): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve("settled" as const)
  let release: (outcome: InviteTargetOutcome) => void = () => undefined
  const tail = new Promise<InviteTargetOutcome>((resolve) => {
    release = resolve
  })
  locks.set(key, tail)
  let outcome: InviteTargetOutcome = "settled"
  try {
    if (await prior === "uncertain") {
      outcome = "uncertain"
      throw priorUncertainError()
    }
    return await operation()
  } catch (error) {
    if (uncertainInviteCreationExecution(error)) outcome = "uncertain"
    throw error
  } finally {
    release(outcome)
    if (outcome === "settled" && locks.get(key) === tail) locks.delete(key)
  }
}

export class InviteService {
  readonly #activityStore: ActivityStore
  readonly #capabilityRoots: readonly string[]
  readonly #client: InviteServiceClient
  readonly #clock: () => Date
  readonly #layoutSource: GatewayChannelLayoutSource | undefined
  readonly #operationStore: OperationStore
  readonly #planKey: Uint8Array
  readonly #policy: InviteServiceOptions["policy"]
  readonly #privateFileSystem: PrivateCapabilityFileSystem
  readonly #randomId: () => string
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  readonly #creationTargetLocks = new Map<string, Promise<InviteTargetOutcome>>()
  readonly #targetLocks = new Map<string, Promise<InviteTargetOutcome>>()

  constructor(options: InviteServiceOptions) {
    this.#activityStore = options.activityStore
    this.#capabilityRoots = options.capabilityRoots ?? []
    this.#client = options.client
    this.#clock = options.clock || (() => new Date())
    this.#layoutSource = options.layoutSource
    this.#operationStore = options.operationStore
    this.#planKey = options.planKey || createReviewedPlanKey()
    this.#policy = options.policy
    this.#privateFileSystem = options.privateFileSystem
      ?? DEFAULT_PRIVATE_CAPABILITY_FILE_SYSTEM
    this.#randomId = options.randomId || randomUUID
    this.#sleep = options.sleep || defaultSleep
  }

  async #creationState(
    botId: string,
    request: NormalizedInviteCreationRequest,
    options: RequestOptions,
  ): Promise<InviteCreationState> {
    assertPositiveSnowflake(botId, "Discord connector bot ID")
    this.#policy.assertGuildInviteCreatable(request.guildId, request.channelId)
    if (request.roleAssignment.kind === "grant") {
      this.#policy.assertInviteRoleAssignmentAllowed(request.roleAssignment.roleIds)
    }
    const receipt = await this.#operationStore.get(
      "invite-creation",
      request.operationKeyHash,
    )
    if (receipt) {
      throw new InviteCreationOperationConflictError(receiptView(receipt))
    }
    let rawGuild: DiscordGuild
    let rawBotMember: DiscordGuildMember
    let rawRoles: DiscordRole[]
    let rawChannels: DiscordChannel[]
    let channelEvidence: GuildChannelEvidenceView | undefined
    let channelCoverage: GuildChannelAnalysisCoverage | undefined
    if (request.roleAssignment.kind === "grant") {
      if (!this.#layoutSource) {
        throw evidenceError(
          "Discord invite role assignment requires Gateway channel-layout evidence",
        )
      }
      let supportingEvidence: {
        botMember: DiscordGuildMember
        guild: DiscordGuild
        roles: DiscordRole[]
      } | undefined
      try {
        const evidence = await collectGuildChannelEvidence({
          guildId: request.guildId,
          layoutSource: this.#layoutSource,
          readChannels: async () => {
            const [guild, botMember, roles, channels] = await Promise.all([
              this.#client.getGuild(request.guildId, options),
              this.#client.getGuildMember(request.guildId, botId, options),
              this.#client.getGuildRoles(request.guildId, options),
              this.#client.getGuildChannels(request.guildId, options),
            ])
            supportingEvidence = { botMember, guild, roles }
            return channels
          },
        })
        if (hasHiddenModeledChannel(evidence.layout.channels)) {
          throw evidenceError(
            "Discord invite role assignment requires complete metadata for every direct guild channel",
          )
        }
        if (!supportingEvidence) {
          throw evidenceError(
            "Discord invite role-assignment supporting evidence is unavailable",
          )
        }
        rawGuild = supportingEvidence.guild
        rawBotMember = supportingEvidence.botMember
        rawRoles = supportingEvidence.roles
        rawChannels = evidence.channels
        channelEvidence = evidence.view
        channelCoverage = guildChannelAnalysisCoverage(evidence.layout.channels)
      } catch (error) {
        if (error instanceof GuildChannelEvidenceError) {
          throw new InviteEvidenceError(
            `Discord invite role-assignment channel evidence is incomplete: ${error.message}`,
            { cause: error },
          )
        }
        throw error
      }
    } else {
      [rawGuild, rawBotMember, rawRoles, rawChannels] = await Promise.all([
        this.#client.getGuild(request.guildId, options),
        this.#client.getGuildMember(request.guildId, botId, options),
        this.#client.getGuildRoles(request.guildId, options),
        this.#client.getGuildChannels(request.guildId, options),
      ])
    }
    const guild = exactGuild(rawGuild, request.guildId)
    const botMember = exactBotMember(rawBotMember, request.guildId, botId)
    const roles = exactRoles(rawRoles, request.guildId)
    const roleGrantChannels = request.roleAssignment.kind === "grant"
      ? exactInviteRoleImpactChannels(rawChannels, request.guildId, roles)
      : []
    const channels = exactChannels(rawChannels, request.guildId)
    const channel = exactInviteCreationChannel(
      rawChannels,
      request.guildId,
      request.channelId,
      roles,
    )
    const access = inviteCreationAccessEvidence(
      botId,
      guild,
      botMember,
      roles,
      channel,
      request.acceptance.kind,
      request.roleAssignment.kind,
    )
    const roleAssignment = request.roleAssignment.kind === "grant"
      ? buildInviteRoleAssignmentReview({
          coverage: channelCoverage as GuildChannelAnalysisCoverage,
          botMember,
          channelEvidence: channelEvidence as GuildChannelEvidenceView,
          channels: roleGrantChannels,
          guild,
          request: request as NormalizedInviteCreationRequest & {
            roleAssignment: Extract<
              NormalizedInviteCreationRequest["roleAssignment"],
              { kind: "grant" }
            >
          },
          roles,
        })
      : { kind: "none" as const }
    return {
      access,
      botMember,
      channel,
      channels,
      guild,
      roleAssignment,
      roleGrantChannels,
      roles,
    }
  }

  async #verifyInviteAcceptance(
    code: string,
    request: NormalizedInviteCreationRequest,
    options: RequestOptions,
  ): Promise<void> {
    if (request.acceptance.kind === "bearer") return
    const expectedIds = request.acceptance.userIds
    for (let attempt = 1; attempt <= INVITE_LIMITS.targetUsersPollAttempts; attempt += 1) {
      const status = await this.#client.getInviteTargetUsersJobStatus(code, options)
      if (
        status.unknownFieldCount !== 0
        || status.totalUsers > expectedIds.length
        || status.processedUsers > expectedIds.length
      ) {
        throw evidenceError(
          "Discord returned mismatched invite target-user processing evidence",
        )
      }
      if (status.status === 2) {
        if (
          status.completedAt === null
          || status.errorPresent
          || status.totalUsers !== expectedIds.length
          || status.processedUsers !== expectedIds.length
        ) {
          throw evidenceError(
            "Discord returned incomplete invite target-user completion evidence",
          )
        }
        const observedIds = await this.#client.getInviteTargetUserIds(code, options)
        if (stableString(observedIds) !== stableString(expectedIds)) {
          throw evidenceError(
            "Discord returned mismatched invite target-user acceptance evidence",
          )
        }
        return
      }
      if (
        status.status === 3
        || status.completedAt !== null
        || status.errorPresent
      ) {
        throw evidenceError("Discord invite target-user processing failed")
      }
      if (attempt < INVITE_LIMITS.targetUsersPollAttempts) {
        await this.#sleep(INVITE_LIMITS.targetUsersPollIntervalMs, options.signal)
      }
    }
    throw evidenceError("Discord invite target-user processing did not complete in time")
  }

  async #verifyCreatedInviteIdentity(
    invite: DiscordInviteSummary,
    botId: string,
    request: NormalizedInviteCreationRequest,
    options: RequestOptions,
  ): Promise<void> {
    if (request.acceptance.kind === "bearer") {
      const observed = await this.#client.getInvite(invite.code, options)
      assertInviteVerification(observed, invite, request)
      return
    }
    const inventory = await this.#client.listGuildInvites(request.guildId, options)
    if (!Array.isArray(inventory) || inventory.length > INVITE_LIMITS.inventory) {
      throw evidenceError("Discord returned an excessive invite-creation inventory")
    }
    const matches = inventory.filter((candidate) => candidate.code === invite.code)
    const match = matches[0]
    if (matches.length !== 1 || !match) {
      throw evidenceError(
        "Discord returned mismatched exact-user invite identity evidence",
      )
    }
    assertCreatedInvite(match, botId, request)
  }

  async #buildCreationPlan(
    applicationId: string,
    botId: string,
    request: NormalizedInviteCreationRequest,
    options: RequestOptions,
  ): Promise<PrivateInviteCreationPlan> {
    assertPositiveSnowflake(applicationId, "Discord connector application ID")
    assertPositiveSnowflake(botId, "Discord connector bot ID")
    const [state, targetReview] = await Promise.all([
      this.#creationState(botId, request, options),
      reviewPrivateCapabilityTarget(
        request.outputFile,
        this.#capabilityRoots,
        this.#privateFileSystem,
      ),
    ])
    const delivery: InviteCreationPlan["delivery"] = {
      format: INVITE_CAPABILITY_FILE_FORMAT,
      outputFile: request.outputFile,
      review: targetReview,
    }
    const intent: InviteCreationPlan["intent"] = {
      acceptance: request.acceptance,
      maxAgeSeconds: request.maxAgeSeconds,
      maxUses: request.maxUses,
      roleAssignment: request.roleAssignment,
      temporaryMembership: request.temporaryMembership,
      unique: true,
    }
    const privacy: InviteCreationPlan["privacy"] = {
      capabilityDelivery: "private-file-only",
      mcpResult: "credential-free",
      persistence: "content-free-lifecycle-only",
      rawDiscordPayloads: "omitted",
    }
    const target: InviteCreationPlan["target"] = {
      id: state.channel.id,
      name: state.channel.name,
      permissionOverwriteCount: state.channel.permission_overwrites.length,
      type: state.channel.type,
    }
    const visibleInventory = {
      channelLimit: DISCORD_LIMITS.guildChannels,
      channels: state.channels.length,
      roleLimit: DISCORD_LIMITS.guildRoles,
      roles: state.roles.length,
    }
    const warnings = [
      ...(state.roleAssignment.kind === "grant" && state.roleAssignment.impact.coverage.status === "partial"
        ? ["Role impact and escalation analysis is partial; unsupported channel types are retained in coverage but their effects are not evaluated"]
        : []),
      ...(state.access.botAdministrator
        ? [
            request.roleAssignment.kind === "grant"
              ? request.acceptance.kind === "exact-users"
                ? "Discord connector bot has ADMINISTRATOR; replace it with MANAGE_GUILD, MANAGE_ROLES, and channel-scoped VIEW_CHANNEL plus CREATE_INSTANT_INVITE"
                : "Discord connector bot has ADMINISTRATOR; replace it with MANAGE_ROLES and channel-scoped VIEW_CHANNEL plus CREATE_INSTANT_INVITE"
              : request.acceptance.kind === "exact-users"
                ? "Discord connector bot has ADMINISTRATOR; replace it with MANAGE_GUILD plus channel-scoped VIEW_CHANNEL and CREATE_INSTANT_INVITE"
                : "Discord connector bot has ADMINISTRATOR; replace it with channel-scoped VIEW_CHANNEL and CREATE_INSTANT_INVITE",
          ]
        : []),
      ...(state.access.botIsGuildOwner
        ? ["Discord connector bot owns the guild and therefore bypasses narrower channel permission controls"]
        : []),
      ...(request.acceptance.kind === "bearer"
        ? ["Anyone who obtains the private file can use the invite within the reviewed finite limits"]
        : [
            "Discord must complete and exactly verify the reviewed target-user set before the connector writes the private capability file",
            "Discord exposes no conditional target-user snapshot, so prevent external invite administration between verification and private capability delivery",
            "A failed or incomplete target-user job can leave a remote invite whose undisclosed code requires manual invite inventory review",
          ]),
      "The created invite remains a bearer capability even when Discord also restricts acceptance to exact users",
      "The connector exclusively creates one private file and never returns the invite code or URL through MCP",
      "The output target must remain absent, canonical, process-owned, and inside the configured private root until execution",
      "Invite creation performs one non-retried Discord mutation and cannot be rolled back automatically",
      "A file-write or verification failure after Discord accepts the request leaves an uncertain outcome that must be inspected manually",
      "The one-shot operation key cannot be reused after reservation, including after an uncertain outcome",
      "Same-channel serialization is process-local; do not run overlapping invite creation in multiple connector processes",
      "Temporary-membership behavior remains subject to Discord's member and role lifecycle",
      ...(state.roleAssignment.kind === "grant"
        ? [
            "Anyone who accepts the invite receives every reviewed role, including users who already belong to the guild",
            "Granted roles persist after the invite expires or is deleted and require a separate manual or reviewed role-removal action",
            "The permission impact is the minimum projection for a new ordinary member; existing members can retain additional permissions from other roles and member overwrites",
            "The permission review is a point-in-time snapshot; later role or channel-overwrite changes can alter authority before or after invite acceptance",
            ...(state.roleAssignment.highRiskPermissionGains.length > 0
              ? [`Invite acceptance grants high-risk permissions: ${state.roleAssignment.highRiskPermissionGains.join(", ")}`]
              : []),
          ]
        : []),
    ]
    const digest = reviewedPlanDigest(this.#planKey, {
      access: state.access,
      applicationId,
      botId,
      delivery,
      domain: "guildcontrol-invite-creation-plan.v3",
      guild: {
        id: state.guild.id,
        name: state.guild.name,
        ownerId: state.guild.owner_id,
      },
      intent,
      operationKeyHash: request.operationKeyHash,
      privacy,
      roleAssignment: state.roleAssignment,
      roleGrantChannels: inviteRoleChannelSnapshot(state.roleGrantChannels),
      roles: state.roles,
      request: {
        acknowledgeBearerCapability: request.acknowledgeBearerCapability,
        auditReason: request.auditReason,
        channelId: request.channelId,
        guildId: request.guildId,
        outputFile: request.outputFile,
      },
      target,
      visibleInventory,
      warnings,
    })
    return {
      plan: {
        access: state.access,
        action: "create",
        applicationId,
        auditReason: request.auditReason,
        botId,
        createdAt: this.#clock().toISOString(),
        delivery,
        digest,
        guild: { id: state.guild.id, name: state.guild.name },
        intent,
        operationKeyHash: request.operationKeyHash,
        privacy,
        roleAssignment: state.roleAssignment,
        schemaVersion: SCHEMA_VERSION,
        status: "planned",
        target,
        visibleInventory,
        warnings,
      },
      request,
    }
  }

  async planCreation(
    applicationId: string,
    botId: string,
    request: InviteCreationRequest,
    options: RequestOptions = {},
  ): Promise<InviteCreationPlan> {
    return (await this.#buildCreationPlan(
      applicationId,
      botId,
      normalizeInviteCreationRequest(request),
      options,
    )).plan
  }

  executeCreation(
    applicationId: string,
    botId: string,
    request: InviteCreationRequest,
    expectedDigest: string,
    options: RequestOptions = {},
  ): Promise<InviteCreationResult> {
    const normalized = normalizeInviteCreationRequest(request)
    if (!REVIEWED_PLAN_DIGEST_PATTERN.test(expectedDigest)) {
      throw new RangeError("Discord invite-creation plan digest is invalid")
    }
    const lockKey = `${normalized.guildId}:${normalized.channelId}`
    return withInviteCreationTargetLock(
      this.#creationTargetLocks,
      lockKey,
      () => this.#executeCreationNormalized(
        applicationId,
        botId,
        normalized,
        expectedDigest,
        options,
      ),
      () => new InviteCreationExecutionError(
        "Discord invite creation was blocked because a prior same-channel operation ended with an uncertain outcome",
        {
          acceptance: inviteAcceptanceSummary(normalized),
          capabilityFileWritten: false,
          channelId: normalized.channelId,
          guildId: normalized.guildId,
          inviteRef: null,
          operationKeyHash: normalized.operationKeyHash,
          outputFile: normalized.outputFile,
          planDigest: expectedDigest,
          roleAssignment: inviteRoleAssignmentSummary(normalized),
          schemaVersion: SCHEMA_VERSION,
          status: "blocked-prior-uncertain",
        },
      ),
    )
  }

  async #executeCreationNormalized(
    applicationId: string,
    botId: string,
    request: NormalizedInviteCreationRequest,
    expectedDigest: string,
    options: RequestOptions,
  ): Promise<InviteCreationResult> {
    let privatePlan: PrivateInviteCreationPlan
    try {
      privatePlan = await this.#buildCreationPlan(
        applicationId,
        botId,
        request,
        options,
      )
    } catch (error) {
      if (
        error instanceof InviteEvidenceError
        || error instanceof PrivateCapabilityFileError
        || error instanceof DiscordApiError && error.status === 404
      ) {
        throw new InviteCreationPlanChangedError(
          expectedDigest,
          CREATION_STATE_UNAVAILABLE,
        )
      }
      throw error
    }
    const { plan } = privatePlan
    if (plan.digest !== expectedDigest) {
      throw new InviteCreationPlanChangedError(expectedDigest, plan.digest)
    }
    const baseResult = {
      acceptance: inviteAcceptanceSummary(request),
      capabilityFileWritten: false,
      channelId: request.channelId,
      guildId: request.guildId,
      inviteRef: null as string | null,
      operationKeyHash: request.operationKeyHash,
      outputFile: request.outputFile,
      planDigest: plan.digest,
      roleAssignment: inviteRoleAssignmentSummary(request),
      schemaVersion: SCHEMA_VERSION,
    }
    const activityId = this.#randomId()
    const reservation = await this.#operationStore.reserve(
      inviteCreationOperationReceipt({
        activityId,
        plan,
        request,
        status: "pending",
        timestamp: this.#clock().toISOString(),
      }),
    )
    if (!reservation.created) {
      throw new InviteCreationOperationConflictError(receiptView(reservation.receipt))
    }
    try {
      await this.#activityStore.append(inviteCreationActivityEntry({
        activityId,
        plan,
        request,
        status: "pending",
        timestamp: this.#clock().toISOString(),
      }))
    } catch (error) {
      let operationRecordError: string | null = null
      try {
        await this.#operationStore.finish(inviteCreationOperationReceipt({
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
      throw new InviteCreationExecutionError(
        "Discord invite creation was blocked because pending activity could not be recorded",
        {
          ...baseResult,
          activityId,
          error: safeErrorCode(error),
          operationRecordError,
          status: "blocked-audit-failed",
        },
      )
    }

    let capabilityFile: PrivateCapabilityFileReservation | undefined
    let capabilityFileWritten = false
    let inviteRef: string | null = null
    let mutationDispatched = false
    try {
      capabilityFile = await reservePrivateCapabilityFile(
        request.outputFile,
        this.#capabilityRoots,
        this.#privateFileSystem,
      )
      mutationDispatched = true
      const invite = await this.#client.createChannelInvite(
        request.channelId,
        {
          maxAgeSeconds: request.maxAgeSeconds,
          maxUses: request.maxUses,
          roleIds: request.roleAssignment.kind === "grant"
            ? request.roleAssignment.roleIds
            : [],
          targetUserIds: request.acceptance.kind === "exact-users"
            ? request.acceptance.userIds
            : null,
          temporaryMembership: request.temporaryMembership,
        },
        request.auditReason,
        options,
      )
      assertCreatedInvite(invite, botId, request)
      inviteRef = createInviteReference(this.#planKey, request.guildId, invite.code)
      await this.#verifyCreatedInviteIdentity(invite, botId, request, options)
      await this.#verifyInviteAcceptance(invite.code, request, options)
      await capabilityFile.write(inviteCapabilityContent(invite, request))
      capabilityFileWritten = true
    } catch (error) {
      const definiteFailure = !mutationDispatched || (
        inviteRef === null
        && error instanceof DiscordApiError
        && error.status >= 400
        && error.status < 500
        && error.status !== 429
      )
      const status = definiteFailure ? "failed" : "uncertain"
      const errorCode = safeErrorCode(error)
      const capabilityFileDiscarded = capabilityFileWritten
        ? false
        : await capabilityFile?.discard().catch(() => false) ?? true
      let operationRecordError: string | null = null
      try {
        await this.#operationStore.finish(inviteCreationOperationReceipt({
          activityId,
          error: errorCode,
          inviteRef: status === "uncertain" ? inviteRef : null,
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
        await this.#activityStore.append(inviteCreationActivityEntry({
          activityId,
          capabilityFileWritten,
          error: errorCode,
          inviteRef: status === "uncertain" ? inviteRef : null,
          plan,
          request,
          status,
          timestamp: this.#clock().toISOString(),
        }))
      } catch (activityError) {
        activityRecordError = safeErrorCode(activityError)
      }
      throw new InviteCreationExecutionError(
        "Discord invite creation did not complete with a verified successful outcome",
        {
          ...baseResult,
          activityId,
          activityRecordError,
          capabilityFileDiscarded,
          capabilityFileWritten,
          error: errorCode,
          inviteRef,
          operationRecordError,
          retryAfterMs: error instanceof DiscordApiError
            ? error.retryAfterMs ?? null
            : null,
          status,
        },
      )
    }

    if (!capabilityFileWritten || inviteRef === null) {
      throw new InviteCreationExecutionError(
        "Discord invite creation reached an invalid local terminal state",
        {
          ...baseResult,
          activityId,
          status: "uncertain",
        },
      )
    }
    const result: InviteCreationResult = {
      acceptance: inviteAcceptanceSummary(request),
      activityId,
      capabilityFileWritten: true,
      channelId: request.channelId,
      guildId: request.guildId,
      inviteRef,
      operationKeyHash: request.operationKeyHash,
      outputFile: request.outputFile,
      planDigest: plan.digest,
      roleAssignment: inviteRoleAssignmentSummary(request),
      schemaVersion: SCHEMA_VERSION,
      status: "completed",
      verified: true,
    }
    try {
      await this.#operationStore.finish(inviteCreationOperationReceipt({
        activityId,
        inviteRef,
        plan,
        request,
        status: "completed",
        timestamp: this.#clock().toISOString(),
        verification: "match",
      }))
    } catch (error) {
      let activityRecordError: string | null = null
      try {
        await this.#activityStore.append(inviteCreationActivityEntry({
          activityId,
          capabilityFileWritten: true,
          error: safeErrorCode(error),
          inviteRef,
          plan,
          request,
          status: "completed",
          timestamp: this.#clock().toISOString(),
          verification: "match",
        }))
      } catch (activityError) {
        activityRecordError = safeErrorCode(activityError)
      }
      throw new InviteCreationExecutionError(
        "Discord invite creation completed but the operation receipt failed",
        {
          ...result,
          activityRecordError,
          operationRecordError: safeErrorCode(error),
          status: "completed-operation-record-failed",
        },
      )
    }
    try {
      await this.#activityStore.append(inviteCreationActivityEntry({
        activityId,
        capabilityFileWritten: true,
        inviteRef,
        plan,
        request,
        status: "completed",
        timestamp: this.#clock().toISOString(),
        verification: "match",
      }))
    } catch (error) {
      throw new InviteCreationExecutionError(
        "Discord invite creation completed but the final activity record failed",
        {
          ...result,
          activityRecordError: safeErrorCode(error),
          status: "completed-audit-failed",
        },
      )
    }
    return result
  }

  async #state(
    botId: string,
    guildId: string,
    mode: "audit" | "delete",
    options: RequestOptions,
    operationKeyHashValue?: string,
  ): Promise<InviteState> {
    assertPositiveSnowflake(botId, "Discord connector bot ID")
    assertPositiveSnowflake(guildId, "Discord invite-audit guild ID")
    if (mode === "delete") {
      this.#policy.assertGuildInviteDeletable(guildId)
    } else {
      this.#policy.assertGuildInviteAuditable(guildId)
    }
    if (operationKeyHashValue) {
      const receipt = await this.#operationStore.get(
        "invite-deletion",
        operationKeyHashValue,
      )
      if (receipt) {
        throw new InviteDeletionOperationConflictError(receiptView(receipt))
      }
    }
    const [rawGuild, rawBotMember, rawRoles, rawChannels, rawInvites] = await Promise.all([
      this.#client.getGuild(guildId, options),
      this.#client.getGuildMember(guildId, botId, options),
      this.#client.getGuildRoles(guildId, options),
      this.#client.getGuildChannels(guildId, options),
      this.#client.listGuildInvites(guildId, options),
    ])
    const guild = exactGuild(rawGuild, guildId)
    const botMember = exactBotMember(rawBotMember, guildId, botId)
    const roles = exactRoles(rawRoles, guildId)
    const channels = exactChannels(rawChannels, guildId)
    const permissions = completePermissions(botMember, guildId, roles)
    const botIsGuildOwner = guild.owner_id === botId
    if (!botIsGuildOwner && !hasGuildPermission(permissions, "MANAGE_GUILD")) {
      throw evidenceError("Discord connector bot lacks guild-level MANAGE_GUILD")
    }
    if (!Array.isArray(rawInvites) || rawInvites.length > INVITE_LIMITS.inventory) {
      throw evidenceError("Discord returned an invalid bounded guild invite inventory")
    }
    const channelsById = new Map(channels.map((channel) => [channel.id, channel]))
    const rolesById = new Map(roles.map((role) => [role.id, role]))
    const rawByReference = new Map<string, DiscordInviteSummary>()
    const projected = rawInvites.map((invite) => {
      const value = projectedInvite(
        invite,
        guildId,
        channelsById,
        rolesById,
        this.#planKey,
      )
      if (rawByReference.has(value.inviteRef)) {
        throw evidenceError("Discord returned duplicate guild invite capabilities")
      }
      rawByReference.set(value.inviteRef, invite)
      return value
    }).sort((left, right) => left.inviteRef.localeCompare(right.inviteRef))
    const access = accessEvidence(permissions, botIsGuildOwner)
    const inventoryDigest = reviewedPlanDigest(this.#planKey, {
      access,
      botMemberRoleIds: [...botMember.roles].sort(),
      channels,
      domain: "guildcontrol-invite-inventory.v1",
      guild: {
        id: guild.id,
        name: guild.name,
        ownerId: guild.owner_id,
      },
      invites: projected,
      roles: roles.map((role) => ({
        id: role.id,
        managed: role.managed,
        permissions: role.permissions,
        position: role.position,
      })),
    })
    return {
      access,
      botMember,
      channels,
      guild,
      inventoryDigest,
      projected,
      rawByReference,
      roles,
    }
  }

  async list(
    applicationId: string,
    botId: string,
    guildId: string,
    options: InviteListOptions = {},
  ): Promise<InviteInventoryResult> {
    assertInviteListInput(guildId, options)
    assertPositiveSnowflake(applicationId, "Discord invite-audit application ID")
    assertPositiveSnowflake(botId, "Discord invite-audit bot ID")
    const cursor = options.cursor
      ? decodeCursor(this.#planKey, options.cursor, guildId)
      : undefined
    const state = await this.#state(botId, guildId, "audit", options)
    if (cursor && cursor.inventoryDigest !== state.inventoryDigest) {
      throw evidenceError("Discord invite inventory changed; restart pagination")
    }
    const offset = cursor?.offset ?? 0
    if (offset > state.projected.length) {
      throw evidenceError("Discord invite cursor is outside the fresh inventory")
    }
    const limit = options.limit ?? INVITE_LIMITS.listPageDefault
    const invites = state.projected.slice(offset, offset + limit)
    const nextOffset = offset + invites.length
    const hasMore = nextOffset < state.projected.length
    return {
      access: state.access,
      applicationId,
      botId,
      guild: { id: state.guild.id, name: state.guild.name },
      invites,
      page: {
        cursor: options.cursor ?? null,
        hasMore,
        nextCursor: hasMore
          ? encodeCursor(this.#planKey, {
              guildId,
              inventoryDigest: state.inventoryDigest,
              offset: nextOffset,
              version: 1,
            })
          : null,
        requestedLimit: limit,
        returned: invites.length,
        safetyLimit: INVITE_LIMITS.inventory,
      },
      privacy: privacyProjection(),
      schemaVersion: SCHEMA_VERSION,
      status: "ok",
    }
  }

  async getVanityUrl(
    applicationId: string,
    botId: string,
    guildId: string,
    options: GuildVanityUrlOptions = {},
  ): Promise<GuildVanityUrlAuditResult> {
    const includeCode = options.includeCode ?? false
    assertGuildVanityUrlInput(guildId, includeCode)
    assertPositiveSnowflake(applicationId, "Discord guild vanity URL application ID")
    assertPositiveSnowflake(botId, "Discord guild vanity URL bot ID")
    this.#policy.assertGuildInviteAuditable(guildId)
    const requestOptions: RequestOptions = options.signal
      ? { signal: options.signal }
      : {}
    const [rawGuild, rawBotMember, rawRoles] = await Promise.all([
      this.#client.getGuild(guildId, requestOptions),
      this.#client.getGuildMember(guildId, botId, requestOptions),
      this.#client.getGuildRoles(guildId, requestOptions),
    ])
    const guild = exactVanityGuild(rawGuild, guildId)
    const botMember = exactBotMember(rawBotMember, guildId, botId)
    const roles = exactRoles(rawRoles, guildId)
    const permissions = completePermissions(botMember, guildId, roles)
    const botIsGuildOwner = guild.owner_id === botId
    if (!botIsGuildOwner && !hasGuildPermission(permissions, "MANAGE_GUILD")) {
      throw evidenceError(
        "Discord connector bot lacks guild-level MANAGE_GUILD for vanity URL audit",
      )
    }
    const access = accessEvidence(permissions, botIsGuildOwner)
    const eligible = guild.features.includes(VANITY_URL_FEATURE)
    const privacy = {
      code: "explicit-transient-opt-in" as const,
      inviteUrl: "omitted" as const,
      persistence: "none" as const,
      rawPayloads: "omitted" as const,
      unknownFields: "counts-only" as const,
    }
    if (!eligible) {
      return {
        access,
        applicationId,
        botId,
        guildId,
        localConstraints: VANITY_LOCAL_CONSTRAINTS,
        privacy,
        schemaVersion: SCHEMA_VERSION,
        status: "ok",
        vanity: {
          code: null,
          codeDisclosure: includeCode ? "included" : "omitted",
          configured: false,
          eligible: false,
          unknownFieldCount: null,
          uses: null,
        },
        verification: {
          endpointCalled: false,
          guildCrossCheck: "not-applicable",
          writePerformed: false,
        },
      }
    }
    const vanity = exactVanitySummary(
      await this.#client.getGuildVanityUrl(guildId, requestOptions),
    )
    if (vanity.code !== guild.vanity_url_code) {
      throw evidenceError(
        "Discord guild vanity URL changed during the audit; retry the read",
      )
    }
    return {
      access,
      applicationId,
      botId,
      guildId,
      localConstraints: VANITY_LOCAL_CONSTRAINTS,
      privacy,
      schemaVersion: SCHEMA_VERSION,
      status: "ok",
      vanity: {
        code: includeCode ? vanity.code : null,
        codeDisclosure: includeCode ? "included" : "omitted",
        configured: vanity.code !== null,
        eligible: true,
        unknownFieldCount: vanity.unknownFieldCount,
        uses: vanity.uses,
      },
      verification: {
        endpointCalled: true,
        guildCrossCheck: "match",
        writePerformed: false,
      },
    }
  }

  async get(
    applicationId: string,
    botId: string,
    guildId: string,
    inviteRef: string,
    options: RequestOptions = {},
  ): Promise<InviteLookupResult> {
    assertInviteGetInput(guildId, inviteRef)
    assertPositiveSnowflake(applicationId, "Discord invite-audit application ID")
    assertPositiveSnowflake(botId, "Discord invite-audit bot ID")
    const state = await this.#state(botId, guildId, "audit", options)
    const invite = state.projected.find((entry) => entry.inviteRef === inviteRef)
    if (!invite) {
      throw evidenceError("Discord invite reference is absent or expired for this process")
    }
    return {
      access: state.access,
      applicationId,
      botId,
      guild: { id: state.guild.id, name: state.guild.name },
      invite,
      privacy: privacyProjection(),
      schemaVersion: SCHEMA_VERSION,
      status: "ok",
    }
  }

  async #buildPlan(
    applicationId: string,
    botId: string,
    request: NormalizedInviteDeletionRequest,
    options: RequestOptions,
  ): Promise<PrivateInviteDeletionPlan> {
    assertPositiveSnowflake(applicationId, "Discord connector application ID")
    assertPositiveSnowflake(botId, "Discord connector bot ID")
    const state = await this.#state(
      botId,
      request.guildId,
      "delete",
      options,
      request.operationKeyHash,
    )
    const target = state.projected.find((invite) => invite.inviteRef === request.inviteRef)
    const raw = state.rawByReference.get(request.inviteRef)
    if (!target || !raw) {
      throw evidenceError("Discord invite reference is absent or expired for this process")
    }
    if (
      request.auditReason.includes(raw.code)
    ) {
      throw evidenceError("Discord invite deletion audit reason must not contain the target invite code")
    }
    const privacy = privacyProjection()
    const visibleInventory = {
      channelLimit: DISCORD_LIMITS.guildChannels,
      channels: state.channels.length,
      inviteLimit: INVITE_LIMITS.inventory,
      invites: state.projected.length,
      roleLimit: DISCORD_LIMITS.guildRoles,
      roles: state.roles.length,
    }
    const warnings = [
      ...(state.access.botAdministrator
        ? ["Discord connector bot has ADMINISTRATOR; replace it with narrowly scoped MANAGE_GUILD"]
        : []),
      "Invite deletion permanently revokes the selected access capability",
      "Invite deletion does not remove members or roles granted by earlier uses",
      "The invite code and URL are projected out and never enter the MCP result or persistent state",
      "Opaque invite references are process-local and expire when the connector restarts",
      "Guild, channel, and untrusted Discord text are never persisted by this workflow",
      "Same-target serialization is process-local; do not run overlapping invite-deletion scope in multiple connector processes",
      "The operation key is one-shot and cannot be retried after reservation, including after an uncertain outcome",
      "Discord deletes by secret code after a non-atomic inventory read; prevent concurrent invite administration during execution",
    ]
    const requestProjection = {
      auditReason: request.auditReason,
      guildId: request.guildId,
      inviteRef: request.inviteRef,
      operationKeyHash: request.operationKeyHash,
    }
    const digest = reviewedPlanDigest(this.#planKey, {
      applicationId,
      botId,
      domain: "guildcontrol-invite-deletion-plan.v1",
      inventoryDigest: state.inventoryDigest,
      privacy,
      request: requestProjection,
      target,
      visibleInventory,
      warnings,
    })
    return {
      code: raw.code,
      plan: {
        access: state.access,
        action: "delete",
        applicationId,
        auditReason: request.auditReason,
        botId,
        createdAt: this.#clock().toISOString(),
        digest,
        guild: { id: state.guild.id, name: state.guild.name },
        operationKeyHash: request.operationKeyHash,
        privacy,
        schemaVersion: SCHEMA_VERSION,
        status: "planned",
        target,
        visibleInventory,
        warnings,
      },
    }
  }

  async plan(
    applicationId: string,
    botId: string,
    request: InviteDeletionRequest,
    options: RequestOptions = {},
  ): Promise<InviteDeletionPlan> {
    return (await this.#buildPlan(
      applicationId,
      botId,
      normalizeInviteDeletionRequest(request),
      options,
    )).plan
  }

  execute(
    applicationId: string,
    botId: string,
    request: InviteDeletionRequest,
    expectedDigest: string,
    options: RequestOptions = {},
  ): Promise<InviteDeletionResult> {
    const normalized = normalizeInviteDeletionRequest(request)
    if (!REVIEWED_PLAN_DIGEST_PATTERN.test(expectedDigest)) {
      throw new RangeError("Discord invite deletion plan digest is invalid")
    }
    return withTargetLock(
      this.#targetLocks,
      normalized.inviteRef,
      () => this.#executeNormalized(
        applicationId,
        botId,
        normalized,
        expectedDigest,
        options,
      ),
      () => new InviteDeletionExecutionError(
        "Discord invite deletion was blocked because a prior same-target operation ended with an uncertain outcome",
        {
          guildId: normalized.guildId,
          inviteRef: normalized.inviteRef,
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
    request: NormalizedInviteDeletionRequest,
    expectedDigest: string,
    options: RequestOptions,
  ): Promise<InviteDeletionResult> {
    let privatePlan: PrivateInviteDeletionPlan
    try {
      privatePlan = await this.#buildPlan(applicationId, botId, request, options)
    } catch (error) {
      if (
        error instanceof InviteEvidenceError
        || error instanceof DiscordApiError && error.status === 404
      ) {
        throw new InviteDeletionPlanChangedError(expectedDigest, STATE_UNAVAILABLE)
      }
      throw error
    }
    const { code, plan } = privatePlan
    if (plan.digest !== expectedDigest) {
      throw new InviteDeletionPlanChangedError(expectedDigest, plan.digest)
    }
    const baseResult = {
      channelId: plan.target.channel.id,
      guildId: request.guildId,
      inviteRef: request.inviteRef,
      operationKeyHash: request.operationKeyHash,
      planDigest: plan.digest,
      schemaVersion: SCHEMA_VERSION,
    }
    const activityId = this.#randomId()
    const reservation = await this.#operationStore.reserve(operationReceipt({
      activityId,
      guildId: request.guildId,
      plan,
      request,
      status: "pending",
      timestamp: this.#clock().toISOString(),
    }))
    if (!reservation.created) {
      throw new InviteDeletionOperationConflictError(receiptView(reservation.receipt))
    }
    try {
      await this.#activityStore.append(activityEntry({
        activityId,
        guildId: request.guildId,
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
          guildId: request.guildId,
          plan,
          request,
          status: "failed",
          timestamp: this.#clock().toISOString(),
        }))
      } catch (receiptError) {
        operationRecordError = safeErrorCode(receiptError)
      }
      throw new InviteDeletionExecutionError(
        "Discord invite deletion was blocked because pending activity could not be recorded",
        {
          ...baseResult,
          activityId,
          error: safeErrorCode(error),
          operationRecordError,
          status: "blocked-audit-failed",
        },
      )
    }

    let mutationCompleted = false
    let verifiedAbsent: boolean | null = null
    try {
      const deleted = await this.#client.deleteInvite(
        code,
        request.auditReason,
        options,
      )
      mutationCompleted = true
      this.#assertDeletedResponse(deleted, plan.target, request.guildId)
      const observed = await this.#state(botId, request.guildId, "audit", options)
      verifiedAbsent = !observed.rawByReference.has(request.inviteRef)
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
          guildId: request.guildId,
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
          guildId: request.guildId,
          plan,
          request,
          status,
          timestamp: this.#clock().toISOString(),
        }))
      } catch (activityError) {
        activityRecordError = safeErrorCode(activityError)
      }
      throw new InviteDeletionExecutionError(
        "Discord invite deletion did not complete with a verified successful outcome",
        {
          ...baseResult,
          activityId,
          activityRecordError,
          error: errorCode,
          operationRecordError,
          retryAfterMs: error instanceof DiscordApiError
            ? error.retryAfterMs ?? null
            : null,
          status,
          verifiedAbsent,
        },
      )
    }

    const verification = verifiedAbsent ? "match" : "drift"
    const status = verifiedAbsent ? "completed" : "completed-with-drift"
    const result: InviteDeletionResult = {
      ...baseResult,
      activityId,
      status,
      verifiedAbsent,
    }
    try {
      await this.#operationStore.finish(operationReceipt({
        activityId,
        guildId: request.guildId,
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
          guildId: request.guildId,
          plan,
          request,
          status,
          timestamp: this.#clock().toISOString(),
          verification,
        }))
      } catch (activityError) {
        activityRecordError = safeErrorCode(activityError)
      }
      throw new InviteDeletionExecutionError(
        "Discord invite deletion completed but the operation receipt failed",
        {
          ...result,
          activityRecordError,
          operationRecordError: safeErrorCode(error),
          status: "completed-operation-record-failed",
        },
      )
    }
    try {
      await this.#activityStore.append(activityEntry({
        activityId,
        guildId: request.guildId,
        plan,
        request,
        status,
        timestamp: this.#clock().toISOString(),
        verification,
      }))
    } catch (error) {
      throw new InviteDeletionExecutionError(
        "Discord invite deletion completed but the final activity record failed",
        {
          ...result,
          activityRecordError: safeErrorCode(error),
          status: "completed-audit-failed",
        },
      )
    }
    return result
  }

  #assertDeletedResponse(
    deleted: DiscordDeletedInviteSummary,
    target: ProjectedInvite,
    guildId: string,
  ): void {
    if (
      deleted.type !== 0
      || deleted.guildId !== guildId
      || deleted.channelId !== target.channel.id
      || createInviteReference(this.#planKey, guildId, deleted.code) !== target.inviteRef
    ) {
      throw evidenceError("Discord returned mismatched invite deletion evidence")
    }
  }
}
