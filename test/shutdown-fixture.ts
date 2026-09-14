import type { GatewayRuntime } from "../src/discord-gateway.js"
import { GatewayEventStore } from "../src/gateway-events.js"

export function shutdownGateway(overrides: Partial<Pick<GatewayRuntime, "start" | "stop">> = {}): GatewayRuntime {
  const feed = new GatewayEventStore({
    allowedChannelIds: new Set(),
    allowedGuildIds: new Set(),
    enabled: false,
    eventFeedEnabled: false,
    layoutGuildIds: new Set(),
  })
  return {
    enabled: false,
    layoutEnabled: false,
    soundboardPlaybackEventsEnabled: false,
    voiceChannelStatusEnabled: false,
    getChannelLayout: (guildId) => feed.getChannelLayout(guildId),
    getChannelLayoutStatus: () => feed.getChannelLayoutStatus(),
    getStatus: () => feed.getStatus(),
    listEvents: (options) => feed.listEvents(options),
    subscribe: (listener) => feed.subscribe(listener),
    subscribeChannelLayouts: (listener) => feed.subscribeChannelLayouts(listener),
    async getVoiceChannelStatus() { throw new Error("Disabled fixture") },
    async waitForSoundboardPlaybackEvent() { throw new Error("Disabled fixture") },
    async waitForVoiceChannelStatusUpdate() { throw new Error("Disabled fixture") },
    async start() {},
    async stop() {},
    ...overrides,
  }
}
