import {
  DISCORD_CHANNEL_FLAGS,
  DISCORD_CHANNEL_TYPES,
  DISCORD_LIMITS,
  DISCORD_SNOWFLAKE_MAX,
  DISCORD_SNOWFLAKE_PATTERN,
  SCHEMA_VERSION,
} from "./constants.js"
import { isGuildChannelTopologyType } from "./guild-channel-types.js"

export type GatewayChannelLayoutState =
  | "disabled"
  | "invalidated"
  | "pending"
  | "ready"
  | "resuming"
  | "unavailable"

export type GatewayChannelLayoutReason =
  | "awaiting-guild-create"
  | "awaiting-resume"
  | "connection-gap"
  | "guild-deleted"
  | "guild-unavailable"
  | "layout-disabled"
  | "malformed-channel-dispatch"
  | "malformed-guild-create"
  | "new-identify"
  | "outside-scope"

export interface GatewayChannelLayoutEntry {
  channelId: string
  obfuscated: boolean
  parentChannelId: string | null
  position: number
  type: number
}

export interface GatewayChannelLayoutSnapshot {
  channels: readonly GatewayChannelLayoutEntry[]
  complete: boolean
  guildId: string
  reason: GatewayChannelLayoutReason | null
  revision: number
  schemaVersion: number
  state: GatewayChannelLayoutState
  updatedAt: string | null
}

export interface GatewayChannelLayoutStatus {
  channels: {
    obfuscated: number
    retained: number
  }
  enabled: boolean
  guilds: {
    invalidated: number
    pending: number
    ready: number
    resuming: number
    scoped: number
    unavailable: number
  }
  invalidations: number
  schemaVersion: number
  updates: number
}

export type GatewayChannelLayoutListener = (guildId: string) => void

export interface GatewayChannelLayoutSource {
  readonly layoutEnabled: boolean
  getChannelLayout(guildId: string): GatewayChannelLayoutSnapshot
  getChannelLayoutStatus(): GatewayChannelLayoutStatus
  subscribeChannelLayouts(listener: GatewayChannelLayoutListener): () => void
}

export interface GatewayChannelLayoutStoreOptions {
  clock?: () => Date
  enabled: boolean
  guildIds: ReadonlySet<string>
}

interface StoredGuildLayout {
  channels: ReadonlyMap<string, GatewayChannelLayoutEntry>
  reason: Exclude<GatewayChannelLayoutReason, "layout-disabled" | "outside-scope"> | null
  revision: number
  state: Exclude<GatewayChannelLayoutState, "disabled">
  updatedAt: string | null
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function snowflake(value: unknown): string | undefined {
  if (typeof value !== "string" || !DISCORD_SNOWFLAKE_PATTERN.test(value)) {
    return undefined
  }
  const parsed = BigInt(value)
  return parsed >= 1n && parsed <= DISCORD_SNOWFLAKE_MAX ? value : undefined
}

function safeNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function parseChannel(
  value: unknown,
  expectedGuildId: string,
): GatewayChannelLayoutEntry | undefined {
  const record = recordValue(value)
  if (!record) return undefined
  const explicitGuildId = record.guild_id === undefined
    ? undefined
    : snowflake(record.guild_id)
  if (
    record.guild_id !== undefined
    && (!explicitGuildId || explicitGuildId !== expectedGuildId)
  ) return undefined
  const channelId = snowflake(record.id)
  const type = safeNonnegativeInteger(record.type)
  const position = safeNonnegativeInteger(record.position)
  if (
    !channelId
    || type === undefined
    || position === undefined
    || !isGuildChannelTopologyType(type)
  ) return undefined
  const parentChannelId = record.parent_id === undefined || record.parent_id === null
    ? null
    : snowflake(record.parent_id)
  if (record.parent_id !== undefined && record.parent_id !== null && !parentChannelId) {
    return undefined
  }
  const flags = record.flags === undefined
    ? 0
    : safeNonnegativeInteger(record.flags)
  if (flags === undefined) return undefined
  return {
    channelId,
    obfuscated: (BigInt(flags) & BigInt(DISCORD_CHANNEL_FLAGS.channelObfuscated)) !== 0n,
    parentChannelId: parentChannelId ?? null,
    position,
    type,
  }
}

function validTopology(channels: ReadonlyMap<string, GatewayChannelLayoutEntry>): boolean {
  if (channels.size > DISCORD_LIMITS.guildChannels) return false
  for (const channel of channels.values()) {
    if (channel.type === DISCORD_CHANNEL_TYPES.category) {
      if (channel.parentChannelId !== null) return false
      continue
    }
    if (channel.parentChannelId === null) continue
    const parent = channels.get(channel.parentChannelId)
    if (!parent || parent.type !== DISCORD_CHANNEL_TYPES.category) return false
  }
  return true
}

function compareSnowflakes(left: string, right: string): number {
  const leftValue = BigInt(left)
  const rightValue = BigInt(right)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

function cloneChannels(
  channels: ReadonlyMap<string, GatewayChannelLayoutEntry>,
): GatewayChannelLayoutEntry[] {
  return [...channels.values()]
    .sort((left, right) => compareSnowflakes(left.channelId, right.channelId))
    .map((channel) => ({ ...channel }))
}

export class GatewayChannelLayoutStore implements GatewayChannelLayoutSource {
  readonly #clock: () => Date
  readonly #guildIds: ReadonlySet<string>
  readonly #guilds = new Map<string, StoredGuildLayout>()
  #invalidations = 0
  readonly #listeners = new Set<GatewayChannelLayoutListener>()
  #resumePending = false
  #updates = 0
  readonly layoutEnabled: boolean

  constructor(options: GatewayChannelLayoutStoreOptions) {
    for (const guildId of options.guildIds) {
      if (!snowflake(guildId)) {
        throw new RangeError("Gateway channel-layout scope must contain Discord snowflake IDs")
      }
    }
    this.layoutEnabled = options.enabled && options.guildIds.size > 0
    this.#clock = options.clock || (() => new Date())
    this.#guildIds = this.layoutEnabled
      ? new Set(options.guildIds)
      : new Set()
    for (const guildId of this.#guildIds) {
      this.#guilds.set(guildId, {
        channels: new Map(),
        reason: "awaiting-guild-create",
        revision: 0,
        state: "pending",
        updatedAt: null,
      })
    }
  }

  #timestamp(): string {
    return this.#clock().toISOString()
  }

  #emit(guildId: string): void {
    for (const listener of this.#listeners) {
      try {
        listener(guildId)
      } catch {}
    }
  }

  #scoped(guildId: string): boolean {
    return this.layoutEnabled && this.#guildIds.has(guildId)
  }

  #replace(
    guildId: string,
    channels: ReadonlyMap<string, GatewayChannelLayoutEntry>,
  ): boolean {
    const previous = this.#guilds.get(guildId)
    if (!previous) return false
    this.#guilds.set(guildId, {
      channels,
      reason: this.#resumePending ? "awaiting-resume" : null,
      revision: previous.revision + 1,
      state: this.#resumePending ? "resuming" : "ready",
      updatedAt: this.#timestamp(),
    })
    this.#updates += 1
    this.#emit(guildId)
    return true
  }

  #setUnavailable(
    guildId: string,
    reason: "guild-deleted" | "guild-unavailable",
  ): boolean {
    const previous = this.#guilds.get(guildId)
    if (!previous) return false
    this.#guilds.set(guildId, {
      channels: new Map(),
      reason,
      revision: previous.revision + 1,
      state: "unavailable",
      updatedAt: this.#timestamp(),
    })
    this.#updates += 1
    this.#emit(guildId)
    return true
  }

  #invalidate(
    guildId: string,
    reason:
      | "connection-gap"
      | "malformed-channel-dispatch"
      | "malformed-guild-create"
      | "new-identify",
  ): boolean {
    const previous = this.#guilds.get(guildId)
    if (!previous) return false
    this.#guilds.set(guildId, {
      channels: new Map(),
      reason,
      revision: previous.revision + 1,
      state: "invalidated",
      updatedAt: this.#timestamp(),
    })
    this.#invalidations += 1
    this.#emit(guildId)
    return true
  }

  #invalidateEveryGuild(
    reason: "connection-gap" | "malformed-channel-dispatch" | "malformed-guild-create" | "new-identify",
    onlyEstablished = false,
  ): boolean {
    let changed = false
    for (const [guildId, state] of this.#guilds) {
      if (
        onlyEstablished
        && state.state !== "ready"
        && state.state !== "resuming"
        && state.state !== "unavailable"
      ) continue
      changed = this.#invalidate(guildId, reason) || changed
    }
    return changed
  }

  #guildCreate(raw: unknown): boolean {
    const record = recordValue(raw)
    const guildId = snowflake(record?.id)
    if (!record || !guildId) {
      return this.#invalidateEveryGuild("malformed-guild-create")
    }
    if (!this.#scoped(guildId)) return false
    if (record.unavailable === true) {
      return this.#setUnavailable(guildId, "guild-unavailable")
    }
    if (record.unavailable !== undefined && record.unavailable !== false) {
      return this.#invalidate(guildId, "malformed-guild-create")
    }
    if (
      !Array.isArray(record.channels)
      || record.channels.length > DISCORD_LIMITS.guildChannels
    ) {
      return this.#invalidate(guildId, "malformed-guild-create")
    }
    const channels = new Map<string, GatewayChannelLayoutEntry>()
    for (const rawChannel of record.channels) {
      const channel = parseChannel(rawChannel, guildId)
      if (!channel || channels.has(channel.channelId)) {
        return this.#invalidate(guildId, "malformed-guild-create")
      }
      channels.set(channel.channelId, channel)
    }
    if (!validTopology(channels)) {
      return this.#invalidate(guildId, "malformed-guild-create")
    }
    return this.#replace(guildId, channels)
  }

  #guildDelete(raw: unknown): boolean {
    const record = recordValue(raw)
    const guildId = snowflake(record?.id)
    if (!record || !guildId) {
      return this.#invalidateEveryGuild("malformed-channel-dispatch")
    }
    if (!this.#scoped(guildId)) return false
    if (record.unavailable !== undefined && typeof record.unavailable !== "boolean") {
      return this.#invalidate(guildId, "malformed-channel-dispatch")
    }
    return this.#setUnavailable(
      guildId,
      record.unavailable === true ? "guild-unavailable" : "guild-deleted",
    )
  }

  #channelDispatch(
    name: "CHANNEL_CREATE" | "CHANNEL_DELETE" | "CHANNEL_UPDATE",
    raw: unknown,
  ): boolean {
    const record = recordValue(raw)
    const guildId = snowflake(record?.guild_id)
    if (!record || !guildId) {
      return this.#invalidateEveryGuild("malformed-channel-dispatch")
    }
    if (!this.#scoped(guildId)) return false
    const channel = parseChannel(record, guildId)
    if (!channel) return this.#invalidate(guildId, "malformed-channel-dispatch")
    const current = this.#guilds.get(guildId)
    if (
      !current
      || (current.state !== "ready" && current.state !== "resuming")
    ) return false
    const channels = new Map(current.channels)
    if (name === "CHANNEL_DELETE") {
      const deleted = channels.get(channel.channelId)
      if (!deleted) return this.#invalidate(guildId, "malformed-channel-dispatch")
      channels.delete(channel.channelId)
      if (deleted.type === DISCORD_CHANNEL_TYPES.category) {
        for (const [channelId, child] of channels) {
          if (child.parentChannelId !== deleted.channelId) continue
          channels.set(channelId, { ...child, parentChannelId: null })
        }
      }
    } else {
      channels.set(channel.channelId, channel)
    }
    if (!validTopology(channels)) {
      return this.#invalidate(guildId, "malformed-channel-dispatch")
    }
    return this.#replace(guildId, channels)
  }

  ingestDispatch(name: string, raw: unknown): boolean {
    if (!this.layoutEnabled) return false
    switch (name) {
      case "GUILD_CREATE":
        return this.#guildCreate(raw)
      case "GUILD_DELETE":
        return this.#guildDelete(raw)
      case "CHANNEL_CREATE":
      case "CHANNEL_DELETE":
      case "CHANNEL_UPDATE":
        return this.#channelDispatch(name, raw)
      default:
        return false
    }
  }

  invalidateForContinuityGap(): boolean {
    if (!this.layoutEnabled) return false
    this.#resumePending = false
    return this.#invalidateEveryGuild("connection-gap", true)
  }

  invalidateForIdentify(): boolean {
    if (!this.layoutEnabled) return false
    this.#resumePending = false
    return this.#invalidateEveryGuild("new-identify", true)
  }

  suspendForResume(): boolean {
    if (!this.layoutEnabled || this.#resumePending) return false
    this.#resumePending = true
    let changed = false
    for (const [guildId, state] of this.#guilds) {
      if (state.state !== "ready") continue
      this.#guilds.set(guildId, {
        channels: state.channels,
        reason: "awaiting-resume",
        revision: state.revision + 1,
        state: "resuming",
        updatedAt: this.#timestamp(),
      })
      this.#emit(guildId)
      changed = true
    }
    return changed
  }

  confirmResume(): boolean {
    if (!this.layoutEnabled || !this.#resumePending) return false
    this.#resumePending = false
    let changed = false
    for (const [guildId, state] of this.#guilds) {
      if (state.state !== "resuming") continue
      this.#guilds.set(guildId, {
        channels: state.channels,
        reason: null,
        revision: state.revision + 1,
        state: "ready",
        updatedAt: this.#timestamp(),
      })
      this.#emit(guildId)
      changed = true
    }
    return changed
  }

  getChannelLayout(guildId: string): GatewayChannelLayoutSnapshot {
    if (!snowflake(guildId)) {
      throw new RangeError("Gateway channel-layout guild ID must be a Discord snowflake")
    }
    const state = this.#guilds.get(guildId)
    if (!this.layoutEnabled || !state) {
      return {
        channels: [],
        complete: false,
        guildId,
        reason: this.layoutEnabled ? "outside-scope" : "layout-disabled",
        revision: 0,
        schemaVersion: SCHEMA_VERSION,
        state: "disabled",
        updatedAt: null,
      }
    }
    return {
      channels: state.state === "ready" ? cloneChannels(state.channels) : [],
      complete: state.state === "ready",
      guildId,
      reason: state.reason,
      revision: state.revision,
      schemaVersion: SCHEMA_VERSION,
      state: state.state,
      updatedAt: state.updatedAt,
    }
  }

  getChannelLayoutStatus(): GatewayChannelLayoutStatus {
    let invalidated = 0
    let obfuscated = 0
    let pending = 0
    let ready = 0
    let retained = 0
    let resuming = 0
    let unavailable = 0
    for (const state of this.#guilds.values()) {
      if (state.state === "invalidated") invalidated += 1
      if (state.state === "pending") pending += 1
      if (state.state === "ready") ready += 1
      if (state.state === "resuming") resuming += 1
      if (state.state === "ready" || state.state === "resuming") {
        retained += state.channels.size
        for (const channel of state.channels.values()) {
          if (channel.obfuscated) obfuscated += 1
        }
      }
      if (state.state === "unavailable") unavailable += 1
    }
    return {
      channels: { obfuscated, retained },
      enabled: this.layoutEnabled,
      guilds: {
        invalidated,
        pending,
        ready,
        resuming,
        scoped: this.#guildIds.size,
        unavailable,
      },
      invalidations: this.#invalidations,
      schemaVersion: SCHEMA_VERSION,
      updates: this.#updates,
    }
  }

  subscribeChannelLayouts(listener: GatewayChannelLayoutListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
}
