import assert from "node:assert/strict"
import test from "node:test"

import { DISCORD_CHANNEL_TYPES, SCHEMA_VERSION } from "../src/constants.js"
import {
  collectGuildChannelEvidence,
  exactGatewayChannelLayout,
  GuildChannelEvidenceError,
  guildChannelLayoutGuildIds,
} from "../src/guild-channel-evidence.js"
import type {
  GatewayChannelLayoutListener,
  GatewayChannelLayoutSnapshot,
  GatewayChannelLayoutSource,
  GatewayChannelLayoutStatus,
} from "../src/gateway-channel-layout.js"
import type { DiscordChannel } from "../src/types.js"

const GUILD_ID = "100000000000000001"
const VISIBLE_CHANNEL_ID = "200000000000000001"
const HIDDEN_CHANNEL_ID = "200000000000000002"
const SECOND_GUILD_ID = "100000000000000002"
const CLONE_GUILD_ID = "100000000000000003"
const UNRECOGNIZED_CHANNEL_ID = "200000000000000003"

test("complete guild channel evidence retains unrecognized direct types", async () => {
  for (const type of [20, 99]) {
    const source = new LayoutSource()
    source.current.channels = [...source.current.channels, {
      channelId: UNRECOGNIZED_CHANNEL_ID,
      obfuscated: false,
      parentChannelId: null,
      position: 2,
      type,
    }]
    const evidence = await collectGuildChannelEvidence({
      guildId: GUILD_ID,
      layoutSource: source,
      readChannels: async () => [
        channel(VISIBLE_CHANNEL_ID),
        channel(HIDDEN_CHANNEL_ID),
        channel(UNRECOGNIZED_CHANNEL_ID, { position: 2, type }),
      ],
    })
    assert.equal(evidence.view.httpMode, "complete")
    assert.equal(evidence.view.httpChannelCount, 3)
    assert.equal(evidence.layout.channels.find((entry) => entry.channelId === UNRECOGNIZED_CHANNEL_ID)?.type, type)
    assert.equal(evidence.channels.find((entry) => entry.id === UNRECOGNIZED_CHANNEL_ID)?.type, type)
  }
})

function channel(
  id: string,
  overrides: Partial<DiscordChannel> = {},
): DiscordChannel {
  return {
    guild_id: GUILD_ID,
    id,
    name: `channel-${id}`,
    parent_id: null,
    permission_overwrites: [],
    position: id === VISIBLE_CHANNEL_ID ? 0 : 1,
    type: DISCORD_CHANNEL_TYPES.text,
    ...overrides,
  }
}

function snapshot(options: {
  obfuscatedIds?: readonly string[]
  revision?: number
} = {}): GatewayChannelLayoutSnapshot {
  const obfuscatedIds = new Set(options.obfuscatedIds ?? [])
  return {
    channels: [VISIBLE_CHANNEL_ID, HIDDEN_CHANNEL_ID].map((channelId, position) => ({
      channelId,
      obfuscated: obfuscatedIds.has(channelId),
      parentChannelId: null,
      position,
      type: DISCORD_CHANNEL_TYPES.text,
    })),
    complete: true,
    guildId: GUILD_ID,
    reason: null,
    revision: options.revision ?? 1,
    schemaVersion: SCHEMA_VERSION,
    state: "ready",
    updatedAt: "2026-08-23T00:00:00.000Z",
  }
}

class LayoutSource implements GatewayChannelLayoutSource {
  layoutEnabled = true
  current = snapshot()

  getChannelLayout(guildId: string): GatewayChannelLayoutSnapshot {
    if (guildId === GUILD_ID) return structuredClone(this.current)
    return {
      channels: [],
      complete: false,
      guildId,
      reason: "outside-scope",
      revision: 0,
      schemaVersion: SCHEMA_VERSION,
      state: "unavailable",
      updatedAt: null,
    }
  }

  getChannelLayoutStatus(): GatewayChannelLayoutStatus {
    return {
      channels: {
        obfuscated: this.current.channels.filter((entry) => entry.obfuscated).length,
        retained: this.current.channels.length,
      },
      enabled: this.layoutEnabled,
      guilds: {
        invalidated: 0,
        pending: 0,
        ready: 1,
        resuming: 0,
        scoped: 1,
        unavailable: 0,
      },
      invalidations: 0,
      schemaVersion: SCHEMA_VERSION,
      updates: this.current.revision,
    }
  }

  subscribeChannelLayouts(_listener: GatewayChannelLayoutListener): () => void {
    return () => undefined
  }
}

test("collectGuildChannelEvidence accepts a complete visible inventory", async () => {
  const source = new LayoutSource()
  const evidence = await collectGuildChannelEvidence({
    guildId: GUILD_ID,
    layoutSource: source,
    readChannels: async () => [channel(VISIBLE_CHANNEL_ID), channel(HIDDEN_CHANNEL_ID)],
  })

  assert.deepEqual(evidence.channels.map((entry) => entry.id), [
    VISIBLE_CHANNEL_ID,
    HIDDEN_CHANNEL_ID,
  ])
  assert.deepEqual(evidence.view, {
    gatewayChannelCount: 2,
    httpChannelCount: 2,
    httpMode: "complete",
    layoutRevision: 1,
    layoutUpdatedAt: "2026-08-23T00:00:00.000Z",
    metadataCoverage: "complete",
    obfuscatedChannelCount: 0,
    trustedMetadataCount: 2,
  })
})

test("collectGuildChannelEvidence discards obfuscated HTTP metadata", async () => {
  for (const type of [DISCORD_CHANNEL_TYPES.text, 20, 99]) {
    const source = new LayoutSource()
    source.current = snapshot({ obfuscatedIds: [HIDDEN_CHANNEL_ID] })
    source.current.channels = source.current.channels.map((entry) => (
      entry.channelId === HIDDEN_CHANNEL_ID ? { ...entry, type } : entry
    ))
    const evidence = await collectGuildChannelEvidence({
      guildId: GUILD_ID,
      layoutSource: source,
      readChannels: async () => [
        channel(VISIBLE_CHANNEL_ID),
        channel(HIDDEN_CHANNEL_ID, { name: "must-not-survive", type }),
      ],
    })

    assert.deepEqual(evidence.channels.map((entry) => entry.id), [VISIBLE_CHANNEL_ID])
    assert.equal(JSON.stringify(evidence).includes("must-not-survive"), false)
    assert.equal(evidence.view.httpMode, "complete")
    assert.equal(evidence.view.metadataCoverage, "visibility-bounded")
    assert.equal(evidence.view.obfuscatedChannelCount, 1)
  }
})

test("collectGuildChannelEvidence accepts the exact non-obfuscated HTTP subset", async () => {
  const source = new LayoutSource()
  source.current = snapshot({ obfuscatedIds: [HIDDEN_CHANNEL_ID] })
  const evidence = await collectGuildChannelEvidence({
    guildId: GUILD_ID,
    layoutSource: source,
    readChannels: async () => [channel(VISIBLE_CHANNEL_ID)],
  })

  assert.equal(evidence.view.httpMode, "visibility-bounded")
  assert.equal(evidence.view.httpChannelCount, 1)
  assert.equal(evidence.view.trustedMetadataCount, 1)
})

test("collectGuildChannelEvidence rejects arbitrary omissions and topology mismatch", async () => {
  const source = new LayoutSource()
  await assert.rejects(
    collectGuildChannelEvidence({
      guildId: GUILD_ID,
      layoutSource: source,
      readChannels: async () => [channel(VISIBLE_CHANNEL_ID)],
    }),
    (error: unknown) => error instanceof GuildChannelEvidenceError
      && /neither complete nor visibility-bounded/.test(error.message),
  )
  await assert.rejects(
    collectGuildChannelEvidence({
      guildId: GUILD_ID,
      layoutSource: source,
      readChannels: async () => [
        channel(VISIBLE_CHANNEL_ID, { position: 9 }),
        channel(HIDDEN_CHANNEL_ID),
      ],
    }),
    /HTTP and Gateway channel evidence do not match/,
  )
})

test("collectGuildChannelEvidence rejects a continuity change around the HTTP read", async () => {
  const source = new LayoutSource()
  await assert.rejects(
    collectGuildChannelEvidence({
      guildId: GUILD_ID,
      layoutSource: source,
      readChannels: async () => {
        source.current = {
          ...snapshot({ revision: 2 }),
          updatedAt: "2026-08-23T00:00:01.000Z",
        }
        return [channel(VISIBLE_CHANNEL_ID), channel(HIDDEN_CHANNEL_ID)]
      },
    }),
    /layout changed during evidence collection/,
  )
})

test("exactGatewayChannelLayout rejects malformed topology", () => {
  const baseline = snapshot()
  const malformed: GatewayChannelLayoutSnapshot = {
    ...baseline,
    channels: baseline.channels.map((entry, index) => index === 0
      ? { ...entry, parentChannelId: HIDDEN_CHANNEL_ID }
      : entry),
  }
  assert.throws(
    () => exactGatewayChannelLayout(malformed, GUILD_ID),
    /incomplete channel parent topology/,
  )
})

test("guildChannelLayoutGuildIds unions only enabled exact scopes", () => {
  const ids = guildChannelLayoutGuildIds({
    allowedGuildIds: new Set([GUILD_ID]),
    allowChannelCloneAudit: true,
    allowChannelOrderingAudit: true,
    allowBulkMemberRoleChanges: true,
    allowGateway: false,
    allowGuildTemplateAudit: true,
    allowGuildSettingsAudit: true,
    allowMemberRoleChanges: false,
    allowOnboardingAudit: true,
    channelCloneGuildIds: new Set([CLONE_GUILD_ID]),
    channelOrderingGuildIds: new Set([GUILD_ID]),
    bulkMemberRoleGuildIds: new Set(["100000000000000005"]),
    guildTemplateGuildIds: new Set([SECOND_GUILD_ID]),
    guildSettingsGuildIds: new Set(["100000000000000004"]),
    memberRoleGuildIds: new Set(["100000000000000003"]),
    onboardingGuildIds: new Set([SECOND_GUILD_ID]),
  })

  assert.deepEqual([...ids], [
    CLONE_GUILD_ID,
    GUILD_ID,
    "100000000000000005",
    SECOND_GUILD_ID,
    "100000000000000004",
  ])
})
