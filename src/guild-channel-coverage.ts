import type { GatewayChannelLayoutEntry } from "./gateway-channel-layout.js"
import { DIRECT_GUILD_CHANNEL_TYPES } from "./guild-channel-evidence.js"

type ChannelAnalysisEntry = Pick<
  GatewayChannelLayoutEntry,
  "channelId" | "parentChannelId" | "position" | "type"
>

export interface GuildChannelAnalysisCoverage {
  evaluatedChannelCount: number
  status: "complete" | "partial"
  totalChannelCount: number
  unsupportedChannels: ChannelAnalysisEntry[]
}

export function hasHiddenModeledChannel(channels: readonly GatewayChannelLayoutEntry[]): boolean {
  return channels.some((channel) => channel.obfuscated && DIRECT_GUILD_CHANNEL_TYPES.has(channel.type))
}

export function guildChannelAnalysisCoverage(
  channels: readonly ChannelAnalysisEntry[],
): GuildChannelAnalysisCoverage {
  const unsupportedChannels = channels
    .filter((channel) => !DIRECT_GUILD_CHANNEL_TYPES.has(channel.type))
    .map(({ channelId, parentChannelId, position, type }) => ({
      channelId, parentChannelId, position, type,
    }))
    .sort((left, right) => (
      BigInt(left.channelId) < BigInt(right.channelId) ? -1 : 1
    ))
  return {
    evaluatedChannelCount: channels.length - unsupportedChannels.length,
    status: unsupportedChannels.length === 0 ? "complete" : "partial",
    totalChannelCount: channels.length,
    unsupportedChannels,
  }
}
