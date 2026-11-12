import type { ConnectorConfig } from "./config.js"
import {
  DISCORD_CHANNEL_TYPES,
  DISCORD_LIMITS,
  DISCORD_SNOWFLAKE_MAX,
  DISCORD_SNOWFLAKE_PATTERN,
  SCHEMA_VERSION,
} from "./constants.js"
import type {
  GatewayChannelLayoutEntry,
  GatewayChannelLayoutSnapshot,
  GatewayChannelLayoutSource,
} from "./gateway-channel-layout.js"
import { stableString } from "./normalize.js"
import { isGuildChannelTopologyType } from "./guild-channel-types.js"
import type { DiscordChannel } from "./types.js"

export const DIRECT_GUILD_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  DISCORD_CHANNEL_TYPES.announcement,
  DISCORD_CHANNEL_TYPES.category,
  DISCORD_CHANNEL_TYPES.directory,
  DISCORD_CHANNEL_TYPES.forum,
  DISCORD_CHANNEL_TYPES.media,
  DISCORD_CHANNEL_TYPES.stageVoice,
  DISCORD_CHANNEL_TYPES.text,
  DISCORD_CHANNEL_TYPES.voice,
])

const LAYOUT_KEYS: ReadonlySet<string> = new Set([
  "channels",
  "complete",
  "guildId",
  "reason",
  "revision",
  "schemaVersion",
  "state",
  "updatedAt",
])
const LAYOUT_CHANNEL_KEYS: ReadonlySet<string> = new Set([
  "channelId",
  "obfuscated",
  "parentChannelId",
  "position",
  "type",
])

export type GuildChannelHttpEvidenceMode = "complete" | "visibility-bounded"
export type GuildChannelMetadataCoverage = "complete" | "visibility-bounded"

export interface GuildChannelEvidenceView {
  gatewayChannelCount: number
  httpChannelCount: number
  httpMode: GuildChannelHttpEvidenceMode
  layoutRevision: number
  layoutUpdatedAt: string
  metadataCoverage: GuildChannelMetadataCoverage
  obfuscatedChannelCount: number
  trustedMetadataCount: number
}

export interface GuildChannelEvidence<TChannel extends DiscordChannel = DiscordChannel> {
  channels: TChannel[]
  layout: GatewayChannelLayoutSnapshot
  view: GuildChannelEvidenceView
}

export class GuildChannelEvidenceError extends Error {
  override name = "GuildChannelEvidenceError"
}

function evidenceError(message: string, cause?: unknown): GuildChannelEvidenceError {
  return new GuildChannelEvidenceError(message, cause === undefined ? {} : { cause })
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function snowflake(value: unknown): string | undefined {
  if (typeof value !== "string" || !DISCORD_SNOWFLAKE_PATTERN.test(value)) {
    return undefined
  }
  const parsed = BigInt(value)
  return parsed >= 1n && parsed <= DISCORD_SNOWFLAKE_MAX ? value : undefined
}

function nonnegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function compareSnowflakes(left: string, right: string): number {
  const leftValue = BigInt(left)
  const rightValue = BigInt(right)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

function canonicalLayoutChannels(
  channels: readonly GatewayChannelLayoutEntry[],
): GatewayChannelLayoutEntry[] {
  return channels
    .map((channel) => ({ ...channel }))
    .sort((left, right) => compareSnowflakes(left.channelId, right.channelId))
}

export function exactGatewayChannelLayout(
  value: GatewayChannelLayoutSnapshot,
  guildId: string,
): GatewayChannelLayoutSnapshot {
  const record = recordValue(value)
  if (
    !record
    || !hasOnlyKeys(record, LAYOUT_KEYS)
    || value.schemaVersion !== SCHEMA_VERSION
    || value.guildId !== guildId
    || value.complete !== true
    || value.state !== "ready"
    || value.reason !== null
    || !Number.isSafeInteger(value.revision)
    || value.revision < 1
    || typeof value.updatedAt !== "string"
    || Number.isNaN(Date.parse(value.updatedAt))
    || new Date(value.updatedAt).toISOString() !== value.updatedAt
    || !Array.isArray(value.channels)
    || value.channels.length > DISCORD_LIMITS.guildChannels
  ) throw evidenceError("Discord Gateway channel layout is not complete and ready")

  const channels = new Map<string, GatewayChannelLayoutEntry>()
  for (const candidate of value.channels) {
    const channelRecord = recordValue(candidate)
    if (
      !channelRecord
      || !hasOnlyKeys(channelRecord, LAYOUT_CHANNEL_KEYS)
      || !snowflake(candidate.channelId)
      || channels.has(candidate.channelId)
      || typeof candidate.obfuscated !== "boolean"
      || !(candidate.parentChannelId === null || snowflake(candidate.parentChannelId))
      || nonnegativeSafeInteger(candidate.position) === undefined
      || nonnegativeSafeInteger(candidate.type) === undefined
      || !isGuildChannelTopologyType(candidate.type)
    ) throw evidenceError("Discord Gateway returned invalid channel layout evidence")
    channels.set(candidate.channelId, { ...candidate })
  }

  for (const channel of channels.values()) {
    if (channel.type === DISCORD_CHANNEL_TYPES.category) {
      if (channel.parentChannelId !== null) {
        throw evidenceError("Discord Gateway returned invalid channel category topology")
      }
      continue
    }
    if (channel.parentChannelId === null) continue
    const parent = channels.get(channel.parentChannelId)
    if (!parent || parent.type !== DISCORD_CHANNEL_TYPES.category) {
      throw evidenceError("Discord Gateway returned incomplete channel parent topology")
    }
  }

  return {
    ...value,
    channels: canonicalLayoutChannels([...channels.values()]),
  }
}

export function sameGatewayChannelLayout(
  left: GatewayChannelLayoutSnapshot,
  right: GatewayChannelLayoutSnapshot,
): boolean {
  return left.revision === right.revision
    && left.updatedAt === right.updatedAt
    && stableString(left.channels) === stableString(right.channels)
}

export function reconcileGuildChannelHttpEvidence<TChannel extends DiscordChannel>(
  value: readonly TChannel[],
  guildId: string,
  layout: GatewayChannelLayoutSnapshot,
): {
  channels: TChannel[]
  httpMode: GuildChannelHttpEvidenceMode
  httpChannelCount: number
} {
  if (!Array.isArray(value) || value.length > DISCORD_LIMITS.guildChannels) {
    throw evidenceError("Discord returned invalid guild channel HTTP inventory evidence")
  }
  const layoutById = new Map(layout.channels.map((channel) => [channel.channelId, channel]))
  const observedIds = new Set<string>()
  const channels: TChannel[] = []
  for (const candidate of value) {
    const record = recordValue(candidate)
    const channelId = snowflake(record?.id)
    const channelGuildId = snowflake(record?.guild_id)
    const parentChannelId = record?.parent_id === undefined || record.parent_id === null
      ? null
      : snowflake(record.parent_id)
    const position = nonnegativeSafeInteger(record?.position)
    const type = nonnegativeSafeInteger(record?.type)
    if (
      !record
      || !channelId
      || channelGuildId !== guildId
      || observedIds.has(channelId)
      || !(record.parent_id === undefined || record.parent_id === null || parentChannelId)
      || position === undefined
      || type === undefined
      || !isGuildChannelTopologyType(type)
    ) throw evidenceError("Discord returned invalid guild channel HTTP inventory evidence")
    const layoutChannel = layoutById.get(channelId)
    if (
      !layoutChannel
      || layoutChannel.type !== type
      || layoutChannel.position !== position
      || layoutChannel.parentChannelId !== parentChannelId
    ) throw evidenceError("Discord HTTP and Gateway channel evidence do not match")
    observedIds.add(channelId)
    if (!layoutChannel.obfuscated) channels.push({ ...candidate })
  }

  const actualIds = [...observedIds].sort(compareSnowflakes)
  const completeIds = layout.channels.map((channel) => channel.channelId)
  const visibleIds = layout.channels
    .filter((channel) => !channel.obfuscated)
    .map((channel) => channel.channelId)
  const complete = stableString(actualIds) === stableString(completeIds)
  const visibilityBounded = stableString(actualIds) === stableString(visibleIds)
  if (!complete && !visibilityBounded) {
    throw evidenceError(
      "Discord guild channel HTTP inventory is neither complete nor visibility-bounded",
    )
  }
  return {
    channels: channels.sort((left, right) => compareSnowflakes(left.id, right.id)),
    httpChannelCount: value.length,
    httpMode: complete ? "complete" : "visibility-bounded",
  }
}

export async function collectGuildChannelEvidence<
  TChannel extends DiscordChannel = DiscordChannel,
>(options: {
  guildId: string
  layoutSource: GatewayChannelLayoutSource
  readChannels: () => Promise<readonly TChannel[]>
}): Promise<GuildChannelEvidence<TChannel>> {
  if (!options.layoutSource.layoutEnabled) {
    throw evidenceError("Discord Gateway channel layout is disabled")
  }
  const before = exactGatewayChannelLayout(
    options.layoutSource.getChannelLayout(options.guildId),
    options.guildId,
  )
  const rawChannels = await options.readChannels()
  const after = exactGatewayChannelLayout(
    options.layoutSource.getChannelLayout(options.guildId),
    options.guildId,
  )
  if (!sameGatewayChannelLayout(before, after)) {
    throw evidenceError("Discord Gateway channel layout changed during evidence collection")
  }
  const reconciled = reconcileGuildChannelHttpEvidence(rawChannels, options.guildId, after)
  const obfuscatedChannelCount = after.channels.filter((channel) => channel.obfuscated).length
  return {
    channels: reconciled.channels,
    layout: after,
    view: {
      gatewayChannelCount: after.channels.length,
      httpChannelCount: reconciled.httpChannelCount,
      httpMode: reconciled.httpMode,
      layoutRevision: after.revision,
      layoutUpdatedAt: after.updatedAt as string,
      metadataCoverage: obfuscatedChannelCount === 0
        ? "complete"
        : "visibility-bounded",
      obfuscatedChannelCount,
      trustedMetadataCount: reconciled.channels.length,
    },
  }
}

export function guildChannelLayoutGuildIds(
  config: Pick<
    ConnectorConfig,
    "allowedGuildIds" | "allowGateway"
  > & Partial<Pick<
    ConnectorConfig,
    | "allowChannelCloneAudit"
    | "allowChannelOrderingAudit"
    | "allowBulkMemberRoleChanges"
    | "allowGuildTemplateAudit"
    | "allowGuildCommunityAudit"
    | "allowGuildSettingsAudit"
    | "allowMemberRoleChanges"
    | "allowOnboardingAudit"
    | "channelCloneGuildIds"
    | "channelOrderingGuildIds"
    | "bulkMemberRoleGuildIds"
    | "guildTemplateGuildIds"
    | "guildCommunityGuildIds"
    | "guildSettingsGuildIds"
    | "memberRoleGuildIds"
    | "onboardingGuildIds"
  >>,
): ReadonlySet<string> {
  const guildIds = new Set<string>()
  const add = (enabled: boolean, values: ReadonlySet<string>) => {
    if (!enabled) return
    for (const guildId of values) guildIds.add(guildId)
  }
  add(config.allowGateway, config.allowedGuildIds)
  add(config.allowChannelCloneAudit === true, config.channelCloneGuildIds ?? new Set())
  add(config.allowChannelOrderingAudit === true, config.channelOrderingGuildIds ?? new Set())
  add(
    config.allowBulkMemberRoleChanges === true,
    config.bulkMemberRoleGuildIds ?? new Set(),
  )
  add(config.allowGuildTemplateAudit === true, config.guildTemplateGuildIds ?? new Set())
  add(config.allowGuildCommunityAudit === true, config.guildCommunityGuildIds ?? new Set())
  add(config.allowGuildSettingsAudit === true, config.guildSettingsGuildIds ?? new Set())
  add(config.allowMemberRoleChanges === true, config.memberRoleGuildIds ?? new Set())
  add(config.allowOnboardingAudit === true, config.onboardingGuildIds ?? new Set())
  return guildIds
}
