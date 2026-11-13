import { randomUUID } from "node:crypto"

import type {
  ActivityStore,
  ChannelCreationActivity,
  ChannelCreationActivityStatus,
} from "./activity-log.js"
import {
  CHANNEL_CREATION_KINDS,
  CHANNEL_DEFAULT_AUTO_ARCHIVE_DURATIONS,
  DISCORD_CHANNEL_TYPES,
  DISCORD_LIMITS,
  DISCORD_SNOWFLAKE_PATTERN,
  SCHEMA_VERSION,
  type ChannelCreationKind,
} from "./constants.js"
import {
  encodeDiscordAuditReason,
  type CreateGuildChannelInput,
  type DiscordClient,
} from "./discord-client.js"
import {
  ChannelCreationExecutionError,
  ChannelCreationOperationConflictError,
  ChannelCreationPlanChangedError,
  DiscordApiError,
  errorMessage,
} from "./errors.js"
import {
  assertGuildScaffoldAuthority,
  type GuildScaffoldAuthority,
} from "./guild-scaffold-authority.js"
import {
  type OperationReceipt,
  type OperationStore,
  operationKeyHash,
} from "./operation-store.js"
import {
  evaluateBotChannelPermissions,
  evaluateGuildMemberPermissions,
  hasGuildPermission,
  type BotChannelPermissionResult,
  type GuildMemberPermissionResult,
} from "./permissions.js"
import type { ScopePolicy } from "./policy.js"
import {
  createReviewedPlanKey,
  REVIEWED_PLAN_DIGEST_PATTERN,
  reviewedPlanDigest,
} from "./reviewed-plan.js"
import type {
  DiscordChannel,
  DiscordGuild,
  DiscordGuildMember,
  DiscordRole,
  RequestOptions,
} from "./types.js"

const STATE_UNAVAILABLE = "channel-creation-state-unavailable"
const CHANNEL_NAME_CONTROL_PATTERN = /[\u0000-\u001F\u007F]/u
const CHANNEL_TOPIC_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
const DEFAULT_AUTO_ARCHIVE_DURATION = 1_440
const REQUIRED_PERMISSIONS = ["MANAGE_CHANNELS", "VIEW_CHANNEL"] as const

const CHANNEL_TYPE_BY_KIND: Readonly<Record<ChannelCreationKind, number>> = Object.freeze({
  category: DISCORD_CHANNEL_TYPES.category,
  forum: DISCORD_CHANNEL_TYPES.forum,
  text: DISCORD_CHANNEL_TYPES.text,
})
type ChannelCreationTargetOutcome = "settled" | "uncertain"
type ChannelCreationAuthority = "direct" | "guild-scaffold"
const CHANNEL_CREATION_TARGET_LOCKS = new Map<
  string,
  Promise<ChannelCreationTargetOutcome>
>()

export interface ChannelCreationRequest {
  auditReason: string
  defaultAutoArchiveDuration?: number
  guildId: string
  kind: ChannelCreationKind
  name: string
  nsfw?: boolean
  operationKey: string
  parentId?: string
  rateLimitPerUser?: number
  topic?: string
}

export interface NormalizedChannelCreationRequest {
  auditReason: string
  defaultAutoArchiveDuration: number | null
  guildId: string
  kind: ChannelCreationKind
  name: string
  nsfw: boolean | null
  operationKey: string
  operationKeyHash: string
  parentId: string | null
  rateLimitPerUser: number | null
  topic: string | null
}

export interface ObservedCreatedChannel {
  defaultAutoArchiveDuration: number | null
  id: string
  name: string
  nsfw: boolean | null
  parentId: string | null
  rateLimitPerUser: number | null
  topic: string | null
  type: number
}

export interface ChannelCreationPlan {
  action: "create" | "none"
  auditReason: string
  createdAt: string
  digest: string
  existingChannel: ObservedCreatedChannel | null
  guild: {
    id: string
    name: string
    ownerId: string
  }
  operationKeyHash: string
  parent: {
    id: string
    name: string
    visibleChildren: number
  } | null
  permission: {
    botAdministrator: boolean
    guildManageChannels: boolean
    guildViewChannel: boolean
    parentManageChannels: boolean | null
    parentViewChannel: boolean | null
  }
  schemaVersion: number
  status: "already-current" | "planned"
  target: {
    defaultAutoArchiveDuration: number | null
    kind: ChannelCreationKind
    name: string
    nsfw: boolean | null
    parentId: string | null
    rateLimitPerUser: number | null
    topic: string | null
    type: number
  }
  visibleInventory: {
    guildChannels: number
    guildLimit: number
    parentChildren: number | null
    parentLimit: number | null
  }
  warnings: string[]
}

export interface ChannelCreationResult {
  activityId: string | null
  channelId: string
  guildId: string
  observed: ObservedCreatedChannel
  operationKeyHash: string
  planDigest: string
  schemaVersion: number
  status: "already-current" | "completed" | "completed-with-drift"
}

export interface ChannelAdministrationServiceOptions {
  activityStore: ActivityStore
  client: Pick<
    DiscordClient,
    | "createGuildChannel"
    | "getChannel"
    | "getGuild"
    | "getGuildChannels"
    | "getGuildMember"
    | "getGuildRoles"
  >
  clock?: () => Date
  operationStore: OperationStore
  planKey?: Uint8Array
  policy: ScopePolicy
  randomId?: () => string
}

interface ChannelCreationState {
  botMember: DiscordGuildMember
  botPermissions: GuildMemberPermissionResult
  candidates: DiscordChannel[]
  channels: DiscordChannel[]
  exactChannel: DiscordChannel | null
  guild: DiscordGuild
  parent: DiscordChannel | null
  parentChildren: string[]
  parentPermissions: BotChannelPermissionResult | null
  roles: DiscordRole[]
}

class ChannelCreationStateError extends Error {
  override name = "ChannelCreationStateError"
}

class ChannelCreationResponseIdentityError extends Error {
  override name = "ChannelCreationResponseIdentityError"
}

function assertValidUnicode(value: string, name: string): void {
  try {
    encodeURIComponent(value)
  } catch (error) {
    throw new RangeError(`${name} contains invalid Unicode`, { cause: error })
  }
}

function assertIntegerRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
}

export function normalizeChannelCreationRequest(
  request: ChannelCreationRequest,
): NormalizedChannelCreationRequest {
  if (
    typeof request.kind !== "string"
    || !(CHANNEL_CREATION_KINDS as readonly string[]).includes(request.kind)
  ) {
    throw new RangeError("Discord channel creation kind is not supported")
  }
  if (
    typeof request.guildId !== "string"
    || !DISCORD_SNOWFLAKE_PATTERN.test(request.guildId)
    || (request.parentId !== undefined
      && (
        typeof request.parentId !== "string"
        || !DISCORD_SNOWFLAKE_PATTERN.test(request.parentId)
      ))
  ) {
    throw new RangeError("Discord channel creation requires exact snowflake IDs")
  }
  if (
    typeof request.name !== "string"
    || request.name.length < 1
    || request.name.length > DISCORD_LIMITS.channelNameCharacters
    || request.name.trim() !== request.name
    || CHANNEL_NAME_CONTROL_PATTERN.test(request.name)
  ) {
    throw new RangeError(
      `Discord channel name must contain 1-${DISCORD_LIMITS.channelNameCharacters} characters without surrounding whitespace or controls`,
    )
  }
  assertValidUnicode(request.name, "Discord channel name")
  if (typeof request.auditReason !== "string") {
    throw new RangeError("Discord channel creation audit reason must be a string")
  }
  encodeDiscordAuditReason(request.auditReason)
  const keyHash = operationKeyHash(request.operationKey)

  if (request.kind === "category") {
    if (
      request.defaultAutoArchiveDuration !== undefined
      || request.nsfw !== undefined
      || request.parentId !== undefined
      || request.rateLimitPerUser !== undefined
      || request.topic !== undefined
    ) {
      throw new RangeError("Discord category creation does not accept channel-specific settings")
    }
    return {
      auditReason: request.auditReason,
      defaultAutoArchiveDuration: null,
      guildId: request.guildId,
      kind: request.kind,
      name: request.name,
      nsfw: null,
      operationKey: request.operationKey,
      operationKeyHash: keyHash,
      parentId: null,
      rateLimitPerUser: null,
      topic: null,
    }
  }

  if (request.topic !== undefined) {
    if (
      typeof request.topic !== "string"
      || !request.topic.trim()
      || request.topic.length > DISCORD_LIMITS.channelTopicCharacters
      || CHANNEL_TOPIC_CONTROL_PATTERN.test(request.topic)
    ) {
      throw new RangeError(
        `Discord channel topic must be nonblank and at most ${DISCORD_LIMITS.channelTopicCharacters} characters without unsupported controls`,
      )
    }
    assertValidUnicode(request.topic, "Discord channel topic")
  }
  if (request.nsfw !== undefined && typeof request.nsfw !== "boolean") {
    throw new RangeError("Discord channel NSFW setting must be a boolean")
  }
  const rateLimitPerUser = request.rateLimitPerUser ?? 0
  assertIntegerRange(
    rateLimitPerUser,
    0,
    DISCORD_LIMITS.channelRateLimitSeconds,
    "Discord channel slowmode seconds",
  )
  const defaultAutoArchiveDuration = request.defaultAutoArchiveDuration
    ?? DEFAULT_AUTO_ARCHIVE_DURATION
  if (
    !(CHANNEL_DEFAULT_AUTO_ARCHIVE_DURATIONS as readonly number[])
      .includes(defaultAutoArchiveDuration)
  ) {
    throw new RangeError("Discord channel default auto-archive duration is not supported")
  }
  return {
    auditReason: request.auditReason,
    defaultAutoArchiveDuration,
    guildId: request.guildId,
    kind: request.kind,
    name: request.name,
    nsfw: request.nsfw ?? false,
    operationKey: request.operationKey,
    operationKeyHash: keyHash,
    parentId: request.parentId ?? null,
    rateLimitPerUser,
    topic: request.topic ?? null,
  }
}

export function logicalChannelNameKey(value: string): string {
  let key = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\s_-]+/gu, "-")
  if (key.startsWith("-")) key = key.slice(1)
  if (key.endsWith("-")) key = key.slice(0, -1)
  return key
}

function targetLockKey(request: NormalizedChannelCreationRequest): string {
  return [
    request.guildId,
    request.parentId ?? "",
    logicalChannelNameKey(request.name),
  ].join("\0")
}

function uncertainExecution(error: unknown): boolean {
  if (
    !(error instanceof ChannelCreationExecutionError)
    || !error.result
    || typeof error.result !== "object"
    || !("status" in error.result)
  ) return false
  return error.result.status === "uncertain"
}

async function withTargetLock<T>(
  key: string,
  operation: () => Promise<T>,
  priorUncertainError: () => ChannelCreationExecutionError,
): Promise<T> {
  const prior = CHANNEL_CREATION_TARGET_LOCKS.get(key)
    ?? Promise.resolve("settled" as const)
  let release: (outcome: ChannelCreationTargetOutcome) => void = () => undefined
  const tail = new Promise<ChannelCreationTargetOutcome>((resolve) => {
    release = resolve
  })
  CHANNEL_CREATION_TARGET_LOCKS.set(key, tail)
  let outcome: ChannelCreationTargetOutcome = "settled"
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
    if (CHANNEL_CREATION_TARGET_LOCKS.get(key) === tail) {
      CHANNEL_CREATION_TARGET_LOCKS.delete(key)
    }
  }
}

function exactMember(
  member: DiscordGuildMember,
  botId: string,
): DiscordGuildMember {
  if (!member.user || member.user.id !== botId) {
    throw new ChannelCreationStateError(
      "Discord returned a different connector bot member than requested",
    )
  }
  return member
}

export function assertGuildChannelInventory(
  channels: readonly DiscordChannel[],
  guildId: string,
): void {
  if (channels.length > DISCORD_LIMITS.guildChannels) {
    throw new ChannelCreationStateError(
      "Discord returned a guild channel inventory above the documented limit",
    )
  }
  const ids = new Set<string>()
  for (const channel of channels) {
    if (
      typeof channel.id !== "string"
      || !DISCORD_SNOWFLAKE_PATTERN.test(channel.id)
      || !Number.isInteger(channel.type)
      || channel.guild_id !== guildId
      || !(channel.parent_id === undefined || channel.parent_id === null || (
        typeof channel.parent_id === "string"
        && DISCORD_SNOWFLAKE_PATTERN.test(channel.parent_id)
      ))
    ) {
      throw new ChannelCreationStateError(
        "Discord returned invalid or mismatched guild channel evidence",
      )
    }
    if (ids.has(channel.id)) {
      throw new ChannelCreationStateError("Discord returned duplicate guild channel evidence")
    }
    ids.add(channel.id)
    if (
      Object.values(CHANNEL_TYPE_BY_KIND).includes(channel.type)
      && typeof channel.name !== "string"
    ) {
      throw new ChannelCreationStateError("Discord returned a supported channel without a name")
    }
  }
}

function observedChannel(channel: DiscordChannel): ObservedCreatedChannel {
  const category = channel.type === DISCORD_CHANNEL_TYPES.category
  const defaultAutoArchiveDuration = channel.default_auto_archive_duration ?? null
  const nsfw = channel.nsfw ?? false
  const rateLimitPerUser = channel.rate_limit_per_user ?? 0
  const topic = channel.topic ?? null
  if (
    typeof channel.id !== "string"
    || !DISCORD_SNOWFLAKE_PATTERN.test(channel.id)
    || typeof channel.name !== "string"
    || channel.name.length < 1
    || channel.name.length > DISCORD_LIMITS.channelNameCharacters
    || CHANNEL_NAME_CONTROL_PATTERN.test(channel.name)
    || (!category && (
      (defaultAutoArchiveDuration !== null && (
        !Number.isInteger(defaultAutoArchiveDuration)
        || !(CHANNEL_DEFAULT_AUTO_ARCHIVE_DURATIONS as readonly number[])
          .includes(defaultAutoArchiveDuration)
      ))
      || typeof nsfw !== "boolean"
      || !Number.isInteger(rateLimitPerUser)
      || rateLimitPerUser < 0
      || rateLimitPerUser > DISCORD_LIMITS.channelRateLimitSeconds
      || (topic !== null && (
        typeof topic !== "string"
        || topic.length > DISCORD_LIMITS.channelTopicCharacters
        || CHANNEL_TOPIC_CONTROL_PATTERN.test(topic)
      ))
    ))
  ) {
    throw new ChannelCreationResponseIdentityError(
      "Discord returned incomplete created channel identity",
    )
  }
  try {
    assertValidUnicode(channel.name, "Discord returned channel name")
    if (topic !== null) assertValidUnicode(topic, "Discord returned channel topic")
  } catch (error) {
    throw new ChannelCreationResponseIdentityError(
      "Discord returned invalid Unicode in created channel state",
      { cause: error },
    )
  }
  return {
    defaultAutoArchiveDuration: category
      ? null
      : defaultAutoArchiveDuration,
    id: channel.id,
    name: channel.name,
    nsfw: category ? null : nsfw,
    parentId: channel.parent_id ?? null,
    rateLimitPerUser: category ? null : rateLimitPerUser,
    topic: category ? null : topic,
    type: channel.type,
  }
}

export function channelMatchesRequest(
  channel: DiscordChannel,
  request: NormalizedChannelCreationRequest,
): boolean {
  const observed = observedChannel(channel)
  return observed.type === CHANNEL_TYPE_BY_KIND[request.kind]
    && observed.parentId === request.parentId
    && observed.name === request.name
    && observed.topic === request.topic
    && observed.nsfw === request.nsfw
    && observed.rateLimitPerUser === request.rateLimitPerUser
    && observed.defaultAutoArchiveDuration === request.defaultAutoArchiveDuration
}

function observedMatchesRequest(
  observed: ObservedCreatedChannel,
  request: NormalizedChannelCreationRequest,
): boolean {
  return observed.type === CHANNEL_TYPE_BY_KIND[request.kind]
    && observed.parentId === request.parentId
    && observed.name === request.name
    && observed.topic === request.topic
    && observed.nsfw === request.nsfw
    && observed.rateLimitPerUser === request.rateLimitPerUser
    && observed.defaultAutoArchiveDuration === request.defaultAutoArchiveDuration
}

function relevantRoleSnapshot(
  roles: readonly DiscordRole[],
  roleIds: readonly string[],
) {
  const relevant = new Set(roleIds)
  return roles
    .filter((role) => relevant.has(role.id))
    .map((role) => ({
      id: role.id,
      permissions: role.permissions,
      position: role.position,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

function overwriteSnapshot(channel: DiscordChannel | null) {
  return (channel?.permission_overwrites || [])
    .map((overwrite) => ({
      allow: overwrite.allow ?? "0",
      deny: overwrite.deny ?? "0",
      id: overwrite.id,
      type: overwrite.type,
    }))
    .sort((left, right) => (
      left.id.localeCompare(right.id) || left.type - right.type
    ))
}

function candidateSnapshot(channels: readonly DiscordChannel[]) {
  return channels
    .map((channel) => ({
      defaultAutoArchiveDuration: channel.default_auto_archive_duration ?? null,
      id: channel.id,
      name: channel.name ?? null,
      nsfw: channel.nsfw ?? false,
      parentId: channel.parent_id ?? null,
      rateLimitPerUser: channel.rate_limit_per_user ?? 0,
      topic: channel.topic ?? null,
      type: channel.type,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

function parentPermission(
  result: BotChannelPermissionResult | null,
  permission: "MANAGE_CHANNELS" | "VIEW_CHANNEL",
): boolean | null {
  return result ? result.effectivePermissionNames.includes(permission) : null
}

function assertCompleteGuildPermissions(result: GuildMemberPermissionResult): void {
  if (!result.complete) {
    throw new ChannelCreationStateError(
      `Discord connector bot permission evidence is incomplete: ${result.warnings.join("; ")}`,
    )
  }
  for (const permission of REQUIRED_PERMISSIONS) {
    if (!hasGuildPermission(result, permission)) {
      throw new ChannelCreationStateError(
        `Discord connector bot lacks guild-level ${permission}`,
      )
    }
  }
}

function assertCompleteParentPermissions(result: BotChannelPermissionResult): void {
  if (result.confidence !== "complete") {
    throw new ChannelCreationStateError(
      `Discord parent permission evidence is incomplete: ${result.warnings.join("; ")}`,
    )
  }
  for (const permission of REQUIRED_PERMISSIONS) {
    if (!result.effectivePermissionNames.includes(permission)) {
      throw new ChannelCreationStateError(
        `Discord connector bot lacks parent-category ${permission}`,
      )
    }
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

function createInput(
  request: NormalizedChannelCreationRequest,
): CreateGuildChannelInput {
  const type = CHANNEL_TYPE_BY_KIND[request.kind]
  if (request.kind === "category") return { name: request.name, type }
  return {
    defaultAutoArchiveDuration: request.defaultAutoArchiveDuration as number,
    name: request.name,
    nsfw: request.nsfw as boolean,
    ...(request.parentId ? { parentId: request.parentId } : {}),
    rateLimitPerUser: request.rateLimitPerUser as number,
    topic: request.topic,
    type,
  }
}

function assertCreatedStructure(
  channel: DiscordChannel,
  request: NormalizedChannelCreationRequest,
  expectedId?: string,
): void {
  if (
    typeof channel.id !== "string"
    || !DISCORD_SNOWFLAKE_PATTERN.test(channel.id)
    || (expectedId !== undefined && channel.id !== expectedId)
    || channel.guild_id !== request.guildId
    || channel.type !== CHANNEL_TYPE_BY_KIND[request.kind]
    || (channel.parent_id ?? null) !== request.parentId
  ) {
    throw new ChannelCreationResponseIdentityError(
      "Discord returned a different created channel than requested",
    )
  }
}

function activityEntry(options: {
  activityId: string
  channelId?: string | null
  error?: string | null
  plan: ChannelCreationPlan
  request: NormalizedChannelCreationRequest
  status: ChannelCreationActivityStatus
  timestamp: string
  verification?: "drift" | "match" | null
}): ChannelCreationActivity {
  return {
    channelId: options.channelId ?? null,
    channelKind: options.request.kind,
    error: options.error ?? null,
    guildId: options.request.guildId,
    id: options.activityId,
    kind: "channel-create",
    operationKeyHash: options.request.operationKeyHash,
    parentId: options.request.parentId,
    planDigest: options.plan.digest,
    schemaVersion: SCHEMA_VERSION,
    status: options.status,
    timestamp: options.timestamp,
    verification: options.verification ?? null,
  }
}

function operationReceipt(options: {
  activityId: string
  channelId?: string | null
  error?: string | null
  plan: ChannelCreationPlan
  request: NormalizedChannelCreationRequest
  status: OperationReceipt["status"]
  timestamp: string
  verification?: "drift" | "match" | null
}): OperationReceipt {
  return {
    activityId: options.activityId,
    error: options.error ?? null,
    guildId: options.request.guildId,
    kind: "channel-creation",
    operationKeyHash: options.request.operationKeyHash,
    planDigest: options.plan.digest,
    resourceId: options.channelId ?? null,
    schemaVersion: 1,
    status: options.status,
    timestamp: options.timestamp,
    verification: options.verification ?? null,
  }
}

export class ChannelAdministrationService {
  readonly #activityStore: ActivityStore
  readonly #client: ChannelAdministrationServiceOptions["client"]
  readonly #clock: () => Date
  readonly #operationStore: OperationStore
  readonly #planKey: Uint8Array
  readonly #policy: ScopePolicy
  readonly #randomId: () => string

  constructor(options: ChannelAdministrationServiceOptions) {
    this.#activityStore = options.activityStore
    this.#client = options.client
    this.#clock = options.clock || (() => new Date())
    this.#operationStore = options.operationStore
    this.#planKey = options.planKey || createReviewedPlanKey()
    this.#policy = options.policy
    this.#randomId = options.randomId || randomUUID
  }

  async #state(
    botId: string,
    request: NormalizedChannelCreationRequest,
    authority: ChannelCreationAuthority,
    options: RequestOptions,
  ): Promise<ChannelCreationState> {
    if (authority === "guild-scaffold") {
      this.#policy.assertGuildScaffoldAllowed(request.guildId)
    } else {
      this.#policy.assertChannelCreationAllowed(request.guildId)
    }
    const existingReceipt = await this.#operationStore.get(
      "channel-creation",
      request.operationKeyHash,
    )
    if (existingReceipt) {
      throw new ChannelCreationOperationConflictError(receiptView(existingReceipt))
    }

    const [guild, botMember, roles, channels] = await Promise.all([
      this.#client.getGuild(request.guildId, options),
      this.#client.getGuildMember(request.guildId, botId, options),
      this.#client.getGuildRoles(request.guildId, options),
      this.#client.getGuildChannels(request.guildId, options),
    ])
    if (
      guild.id !== request.guildId
      || typeof guild.name !== "string"
      || guild.name.length < 1
      || typeof guild.owner_id !== "string"
      || !DISCORD_SNOWFLAKE_PATTERN.test(guild.owner_id)
    ) {
      throw new ChannelCreationStateError(
        "Discord returned incomplete or mismatched channel-creation guild evidence",
      )
    }
    exactMember(botMember, botId)
    assertGuildChannelInventory(channels, request.guildId)

    let botPermissions: GuildMemberPermissionResult
    try {
      botPermissions = evaluateGuildMemberPermissions({
        guildId: request.guildId,
        member: botMember,
        roles,
      })
    } catch (error) {
      throw new ChannelCreationStateError(
        `Discord connector bot permission evidence is invalid: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    assertCompleteGuildPermissions(botPermissions)

    let parent: DiscordChannel | null = null
    let parentPermissions: BotChannelPermissionResult | null = null
    let parentChildren: string[] = []
    if (request.parentId) {
      parent = channels.find((channel) => channel.id === request.parentId) || null
      if (!parent || parent.type !== DISCORD_CHANNEL_TYPES.category) {
        throw new ChannelCreationStateError(
          "Discord channel creation parent is not one exact visible category",
        )
      }
      try {
        parentPermissions = evaluateBotChannelPermissions({
          botId,
          channel: parent,
          guildId: request.guildId,
          member: botMember,
          permissionChannel: parent,
          roles,
        })
      } catch (error) {
        throw new ChannelCreationStateError(
          `Discord parent permission evidence is invalid: ${errorMessage(error)}`,
          { cause: error },
        )
      }
      assertCompleteParentPermissions(parentPermissions)
      parentChildren = channels
        .filter((channel) => channel.parent_id === request.parentId)
        .map((channel) => channel.id)
        .sort()
    }

    const requestedNameKey = logicalChannelNameKey(request.name)
    const candidates = channels.filter((channel) => (
      Object.values(CHANNEL_TYPE_BY_KIND).includes(channel.type)
      && (channel.parent_id ?? null) === request.parentId
      && typeof channel.name === "string"
      && logicalChannelNameKey(channel.name) === requestedNameKey
    ))
    if (candidates.length > 1) {
      throw new ChannelCreationStateError(
        "Discord channel creation target is ambiguous at the reviewed logical location",
      )
    }
    const candidate = candidates[0]
    if (candidate && !channelMatchesRequest(candidate, request)) {
      throw new ChannelCreationStateError(
        "Discord channel creation conflicts with an existing channel at the reviewed logical location",
      )
    }
    const exactChannel = candidate || null
    if (!exactChannel && channels.length >= DISCORD_LIMITS.guildChannels) {
      throw new ChannelCreationStateError(
        `Visible Discord guild channel count has reached the ${DISCORD_LIMITS.guildChannels}-channel limit`,
      )
    }
    if (
      !exactChannel
      && parent
      && parentChildren.length >= DISCORD_LIMITS.categoryChannels
    ) {
      throw new ChannelCreationStateError(
        `Visible Discord category child count has reached the ${DISCORD_LIMITS.categoryChannels}-channel limit`,
      )
    }

    return {
      botMember,
      botPermissions,
      candidates,
      channels,
      exactChannel,
      guild,
      parent,
      parentChildren,
      parentPermissions,
      roles,
    }
  }

  async #planNormalized(
    botId: string,
    request: NormalizedChannelCreationRequest,
    authority: ChannelCreationAuthority,
    options: RequestOptions,
  ): Promise<ChannelCreationPlan> {
    const state = await this.#state(botId, request, authority, options)
    const action = state.exactChannel ? "none" : "create"
    const digest = reviewedPlanDigest(this.#planKey, {
      action,
      botId,
      botMember: {
        roles: [...state.botMember.roles].sort(),
        userId: state.botMember.user?.id ?? null,
      },
      botPermissions: state.botPermissions.effectivePermissions,
      candidates: candidateSnapshot(state.candidates),
      guild: {
        id: state.guild.id,
        name: state.guild.name,
        ownerId: state.guild.owner_id,
      },
      parent: state.parent
        ? {
            id: state.parent.id,
            name: state.parent.name ?? null,
            overwrites: overwriteSnapshot(state.parent),
            type: state.parent.type,
          }
        : null,
      parentChildren: state.parentChildren,
      parentPermissions: state.parentPermissions?.effectivePermissions ?? null,
      request,
      roles: relevantRoleSnapshot(state.roles, state.botPermissions.appliedRoleIds),
      visibleGuildChannelCount: state.channels.length,
    })
    const existingChannel = state.exactChannel
      ? observedChannel(state.exactChannel)
      : null
    return {
      action,
      auditReason: request.auditReason,
      createdAt: this.#clock().toISOString(),
      digest,
      existingChannel,
      guild: {
        id: state.guild.id,
        name: state.guild.name,
        ownerId: state.guild.owner_id as string,
      },
      operationKeyHash: request.operationKeyHash,
      parent: state.parent
        ? {
            id: state.parent.id,
            name: state.parent.name as string,
            visibleChildren: state.parentChildren.length,
          }
        : null,
      permission: {
        botAdministrator: state.botPermissions.administrator,
        guildManageChannels: hasGuildPermission(
          state.botPermissions,
          "MANAGE_CHANNELS",
        ),
        guildViewChannel: hasGuildPermission(state.botPermissions, "VIEW_CHANNEL"),
        parentManageChannels: parentPermission(
          state.parentPermissions,
          "MANAGE_CHANNELS",
        ),
        parentViewChannel: parentPermission(state.parentPermissions, "VIEW_CHANNEL"),
      },
      schemaVersion: SCHEMA_VERSION,
      status: action === "create" ? "planned" : "already-current",
      target: {
        defaultAutoArchiveDuration: request.defaultAutoArchiveDuration,
        kind: request.kind,
        name: request.name,
        nsfw: request.nsfw,
        parentId: request.parentId,
        rateLimitPerUser: request.rateLimitPerUser,
        topic: request.topic,
        type: CHANNEL_TYPE_BY_KIND[request.kind],
      },
      visibleInventory: {
        guildChannels: state.channels.length,
        guildLimit: DISCORD_LIMITS.guildChannels,
        parentChildren: state.parent ? state.parentChildren.length : null,
        parentLimit: state.parent ? DISCORD_LIMITS.categoryChannels : null,
      },
      warnings: [
        ...(state.botPermissions.administrator
          ? ["Discord connector bot has ADMINISTRATOR; replace it with narrowly scoped MANAGE_CHANNELS and VIEW_CHANNEL permissions"]
          : []),
        "Discord guild channel listings can omit channels the bot cannot view; inventory and collision evidence is visibility-bounded",
        "Same-target serialization is process-local; do not run multiple connector processes with overlapping channel-creation scope",
        "The operation key is one-shot and cannot be retried after reservation, including after an uncertain outcome",
        "This workflow never edits permission overwrites and never deletes or rolls back a channel",
      ],
    }
  }

  async plan(
    botId: string,
    request: ChannelCreationRequest,
    options: RequestOptions = {},
  ): Promise<ChannelCreationPlan> {
    return this.#planNormalized(
      botId,
      normalizeChannelCreationRequest(request),
      "direct",
      options,
    )
  }

  async planForGuildScaffold(
    authority: GuildScaffoldAuthority,
    botId: string,
    request: ChannelCreationRequest,
    options: RequestOptions = {},
  ): Promise<ChannelCreationPlan> {
    assertGuildScaffoldAuthority(authority)
    return this.#planNormalized(
      botId,
      normalizeChannelCreationRequest(request),
      "guild-scaffold",
      options,
    )
  }

  async execute(
    botId: string,
    request: ChannelCreationRequest,
    expectedDigest: string,
    options: RequestOptions = {},
  ): Promise<ChannelCreationResult> {
    const normalized = normalizeChannelCreationRequest(request)
    if (!REVIEWED_PLAN_DIGEST_PATTERN.test(expectedDigest)) {
      throw new RangeError("Discord channel creation plan digest is invalid")
    }
    return withTargetLock(
      targetLockKey(normalized),
      () => this.#executeNormalized(
        botId,
        normalized,
        expectedDigest,
        "direct",
        options,
      ),
      () => new ChannelCreationExecutionError(
        "Discord channel creation was blocked because a concurrent creation at the same logical target ended with an uncertain outcome",
        {
          guildId: normalized.guildId,
          operationKeyHash: normalized.operationKeyHash,
          planDigest: expectedDigest,
          schemaVersion: SCHEMA_VERSION,
          status: "blocked-prior-uncertain",
        },
      ),
    )
  }

  async executeForGuildScaffold(
    authority: GuildScaffoldAuthority,
    botId: string,
    request: ChannelCreationRequest,
    expectedDigest: string,
    options: RequestOptions = {},
  ): Promise<ChannelCreationResult> {
    assertGuildScaffoldAuthority(authority)
    const normalized = normalizeChannelCreationRequest(request)
    if (!REVIEWED_PLAN_DIGEST_PATTERN.test(expectedDigest)) {
      throw new RangeError("Discord channel creation plan digest is invalid")
    }
    return withTargetLock(
      targetLockKey(normalized),
      () => this.#executeNormalized(
        botId,
        normalized,
        expectedDigest,
        "guild-scaffold",
        options,
      ),
      () => new ChannelCreationExecutionError(
        "Discord scaffold channel creation was blocked because a concurrent creation at the same logical target ended with an uncertain outcome",
        {
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
    botId: string,
    normalized: NormalizedChannelCreationRequest,
    expectedDigest: string,
    authority: ChannelCreationAuthority,
    options: RequestOptions,
  ): Promise<ChannelCreationResult> {
    let plan: ChannelCreationPlan
    try {
      plan = await this.#planNormalized(botId, normalized, authority, options)
    } catch (error) {
      if (
        error instanceof ChannelCreationStateError
        || error instanceof ChannelCreationResponseIdentityError
        || (error instanceof DiscordApiError && error.status === 404)
      ) {
        throw new ChannelCreationPlanChangedError(expectedDigest, STATE_UNAVAILABLE)
      }
      throw error
    }
    if (plan.digest !== expectedDigest) {
      throw new ChannelCreationPlanChangedError(expectedDigest, plan.digest)
    }
    if (plan.action === "none" && plan.existingChannel) {
      return {
        activityId: null,
        channelId: plan.existingChannel.id,
        guildId: normalized.guildId,
        observed: plan.existingChannel,
        operationKeyHash: normalized.operationKeyHash,
        planDigest: plan.digest,
        schemaVersion: SCHEMA_VERSION,
        status: "already-current",
      }
    }

    const activityId = this.#randomId()
    const pendingReceipt = operationReceipt({
      activityId,
      plan,
      request: normalized,
      status: "pending",
      timestamp: this.#clock().toISOString(),
    })
    const reservation = await this.#operationStore.reserve(pendingReceipt)
    if (!reservation.created) {
      throw new ChannelCreationOperationConflictError(receiptView(reservation.receipt))
    }

    try {
      await this.#activityStore.append(activityEntry({
        activityId,
        plan,
        request: normalized,
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
          request: normalized,
          status: "failed",
          timestamp: this.#clock().toISOString(),
        }))
      } catch (receiptError) {
        operationRecordError = safeErrorCode(receiptError)
      }
      throw new ChannelCreationExecutionError(
        "Discord channel creation was blocked because pending activity could not be recorded",
        {
          activityId,
          channelId: null,
          error: safeErrorCode(error),
          guildId: normalized.guildId,
          operationKeyHash: normalized.operationKeyHash,
          operationRecordError,
          planDigest: plan.digest,
          schemaVersion: SCHEMA_VERSION,
          status: "blocked-audit-failed",
        },
        { cause: error },
      )
    }

    let channelId: string | null = null
    let observed: ObservedCreatedChannel | null = null
    try {
      const created = await this.#client.createGuildChannel(
        normalized.guildId,
        createInput(normalized),
        normalized.auditReason,
        options,
      )
      if (
        created
        && typeof created.id === "string"
        && DISCORD_SNOWFLAKE_PATTERN.test(created.id)
      ) channelId = created.id
      assertCreatedStructure(created, normalized)
      const readback = await this.#client.getChannel(created.id, options)
      assertCreatedStructure(readback, normalized, created.id)
      observed = observedChannel(readback)
    } catch (error) {
      const status = channelId === null
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
          channelId,
          error: errorCode,
          plan,
          request: normalized,
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
          channelId,
          error: errorCode,
          plan,
          request: normalized,
          status,
          timestamp: this.#clock().toISOString(),
        }))
      } catch (activityError) {
        activityRecordError = safeErrorCode(activityError)
      }
      throw new ChannelCreationExecutionError(
        "Discord channel creation did not complete with a verified successful outcome",
        {
          activityId,
          activityRecordError,
          channelId,
          error: errorCode,
          guildId: normalized.guildId,
          operationKeyHash: normalized.operationKeyHash,
          operationRecordError,
          planDigest: plan.digest,
          retryAfterMs: error instanceof DiscordApiError
            ? error.retryAfterMs ?? null
            : null,
          schemaVersion: SCHEMA_VERSION,
          status,
        },
        { cause: error },
      )
    }

    const verification = observedMatchesRequest(observed, normalized) ? "match" : "drift"
    const status = verification === "match" ? "completed" : "completed-with-drift"
    const result: ChannelCreationResult = {
      activityId,
      channelId: observed.id,
      guildId: normalized.guildId,
      observed,
      operationKeyHash: normalized.operationKeyHash,
      planDigest: plan.digest,
      schemaVersion: SCHEMA_VERSION,
      status,
    }
    try {
      await this.#operationStore.finish(operationReceipt({
        activityId,
        channelId: observed.id,
        plan,
        request: normalized,
        status: "completed",
        timestamp: this.#clock().toISOString(),
        verification,
      }))
    } catch (error) {
      let activityRecordError: string | null = null
      try {
        await this.#activityStore.append(activityEntry({
          activityId,
          channelId: observed.id,
          error: safeErrorCode(error),
          plan,
          request: normalized,
          status,
          timestamp: this.#clock().toISOString(),
          verification,
        }))
      } catch (activityError) {
        activityRecordError = safeErrorCode(activityError)
      }
      throw new ChannelCreationExecutionError(
        "Discord channel creation completed but the operation receipt failed",
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
        channelId: observed.id,
        plan,
        request: normalized,
        status,
        timestamp: this.#clock().toISOString(),
        verification,
      }))
    } catch (error) {
      throw new ChannelCreationExecutionError(
        "Discord channel creation completed but the final activity record failed",
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
