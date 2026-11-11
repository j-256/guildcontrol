import { DISCORD_CHANNEL_TYPES } from "./constants.js"

const NON_DIRECT_GUILD_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  DISCORD_CHANNEL_TYPES.dm,
  DISCORD_CHANNEL_TYPES.groupDm,
  DISCORD_CHANNEL_TYPES.announcementThread,
  DISCORD_CHANNEL_TYPES.publicThread,
  DISCORD_CHANNEL_TYPES.privateThread,
])

export function isGuildChannelTopologyType(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && !NON_DIRECT_GUILD_CHANNEL_TYPES.has(value)
}
