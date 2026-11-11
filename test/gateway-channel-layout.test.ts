import assert from "node:assert/strict"
import test from "node:test"

import {
  DISCORD_CHANNEL_FLAGS,
  DISCORD_CHANNEL_TYPES,
  DISCORD_LIMITS,
} from "../src/constants.js"
import {
  GatewayChannelLayoutStore,
  type GatewayChannelLayoutEntry,
} from "../src/gateway-channel-layout.js"
import { GatewayEventStore } from "../src/gateway-events.js"

const GUILD_ID = "100000000000000001"
const OTHER_GUILD_ID = "100000000000000002"
const CATEGORY_ID = "200000000000000001"
const TEXT_ID = "200000000000000002"
const VOICE_ID = "200000000000000003"
const OTHER_CHANNEL_ID = "200000000000000004"
const TOKEN = "test-discord-token"
const UNRECOGNIZED_CHANNEL_TYPES = [20, 99] as const

function layoutStore(guildIds: readonly string[] = [GUILD_ID]) {
  let milliseconds = Date.parse("2026-08-23T00:00:00.000Z")
  return new GatewayChannelLayoutStore({
    clock() {
      const value = new Date(milliseconds)
      milliseconds += 1_000
      return value
    },
    enabled: true,
    guildIds: new Set(guildIds),
  })
}

function directChannels() {
  return [
    {
      flags: 0,
      id: CATEGORY_ID,
      name: `category ${TOKEN}`,
      parent_id: null,
      permission_overwrites: [{ allow: TOKEN }],
      position: 0,
      topic: TOKEN,
      type: DISCORD_CHANNEL_TYPES.category,
    },
    {
      flags: DISCORD_CHANNEL_FLAGS.channelObfuscated,
      id: TEXT_ID,
      name: "___hidden___",
      parent_id: CATEGORY_ID,
      permission_overwrites: [{ deny: TOKEN }],
      position: 1,
      topic: TOKEN,
      type: DISCORD_CHANNEL_TYPES.text,
    },
  ]
}

function seed(store: GatewayChannelLayoutStore): void {
  assert.equal(store.ingestDispatch("GUILD_CREATE", {
    channels: directChannels(),
    id: GUILD_ID,
    name: TOKEN,
    threads: [{ id: VOICE_ID, name: TOKEN, type: DISCORD_CHANNEL_TYPES.publicThread }],
  }), true)
}

test("Gateway layouts retain only Discord's stable obfuscation-safe projection", () => {
  const store = layoutStore()
  assert.deepEqual(store.getChannelLayoutStatus(), {
    channels: { obfuscated: 0, retained: 0 },
    enabled: true,
    guilds: {
      invalidated: 0,
      pending: 1,
      ready: 0,
      resuming: 0,
      scoped: 1,
      unavailable: 0,
    },
    invalidations: 0,
    schemaVersion: 1,
    updates: 0,
  })

  seed(store)
  const snapshot = store.getChannelLayout(GUILD_ID)
  assert.deepEqual(snapshot, {
    channels: [
      {
        channelId: CATEGORY_ID,
        obfuscated: false,
        parentChannelId: null,
        position: 0,
        type: DISCORD_CHANNEL_TYPES.category,
      },
      {
        channelId: TEXT_ID,
        obfuscated: true,
        parentChannelId: CATEGORY_ID,
        position: 1,
        type: DISCORD_CHANNEL_TYPES.text,
      },
    ],
    complete: true,
    guildId: GUILD_ID,
    reason: null,
    revision: 1,
    schemaVersion: 1,
    state: "ready",
    updatedAt: "2026-08-23T00:00:00.000Z",
  })
  assert.deepEqual(store.getChannelLayoutStatus(), {
    channels: { obfuscated: 1, retained: 2 },
    enabled: true,
    guilds: {
      invalidated: 0,
      pending: 0,
      ready: 1,
      resuming: 0,
      scoped: 1,
      unavailable: 0,
    },
    invalidations: 0,
    schemaVersion: 1,
    updates: 1,
  })
  const rendered = JSON.stringify({ snapshot, status: store.getChannelLayoutStatus() })
  assert.doesNotMatch(rendered, new RegExp(TOKEN))
  assert.doesNotMatch(rendered, /___hidden___|name|topic|permission_overwrites|allow|deny/)

  const first = snapshot.channels[0]
  assert.ok(first)
  first.position = 999
  const mutableChannels = snapshot.channels as GatewayChannelLayoutEntry[]
  mutableChannels.pop()
  assert.equal(store.getChannelLayout(GUILD_ID).channels[0]?.position, 0)
  assert.equal(store.getChannelLayout(GUILD_ID).channels.length, 2)
})

test("Gateway layout scope is exact and channel-only event scope retains no guild layout", () => {
  const store = layoutStore()
  assert.equal(store.ingestDispatch("GUILD_CREATE", {
    channels: directChannels(),
    id: OTHER_GUILD_ID,
  }), false)
  assert.equal(store.getChannelLayout(OTHER_GUILD_ID).state, "disabled")
  assert.equal(store.getChannelLayout(GUILD_ID).state, "pending")
  for (const invalidId of ["not-a-snowflake", "0", "18446744073709551616"]) {
    assert.throws(
      () => store.getChannelLayout(invalidId),
      /must be a Discord snowflake/,
    )
    assert.throws(
      () => new GatewayChannelLayoutStore({
        enabled: true,
        guildIds: new Set([invalidId]),
      }),
      /must contain Discord snowflake IDs/,
    )
  }

  const channelOnly = new GatewayEventStore({
    allowedChannelIds: new Set([TEXT_ID]),
    allowedGuildIds: new Set(),
    enabled: true,
  })
  assert.equal(channelOnly.layoutEnabled, false)
  assert.equal(channelOnly.getChannelLayout(GUILD_ID).reason, "layout-disabled")
  assert.deepEqual(channelOnly.getStatus().layout.guilds, {
    invalidated: 0,
    pending: 0,
    ready: 0,
    resuming: 0,
    scoped: 0,
    unavailable: 0,
  })
})

test("Gateway layouts retain unrecognized direct types as opaque topology", () => {
  for (const type of UNRECOGNIZED_CHANNEL_TYPES) {
    const store = layoutStore()
    const opaqueChannel = {
      flags: 0,
      id: OTHER_CHANNEL_ID,
      name: TOKEN,
      parent_id: null,
      position: 2,
      type,
    }
    store.ingestDispatch("GUILD_CREATE", {
      channels: [...directChannels(), opaqueChannel],
      id: GUILD_ID,
    })
    const snapshot = store.getChannelLayout(GUILD_ID)
    assert.equal(snapshot.state, "ready")
    assert.equal(snapshot.complete, true)
    assert.deepEqual(snapshot.channels.find((entry) => entry.channelId === OTHER_CHANNEL_ID), {
      channelId: OTHER_CHANNEL_ID,
      obfuscated: false,
      parentChannelId: null,
      position: 2,
      type,
    })
    assert.equal(JSON.stringify(snapshot).includes(TOKEN), false)
    store.ingestDispatch("CHANNEL_UPDATE", { ...opaqueChannel, guild_id: GUILD_ID, position: 3 })
    assert.equal(store.getChannelLayout(GUILD_ID).channels.find((entry) => entry.channelId === OTHER_CHANNEL_ID)?.position, 3)
    store.ingestDispatch("CHANNEL_DELETE", { ...opaqueChannel, guild_id: GUILD_ID, position: 3 })
    assert.equal(store.getChannelLayout(GUILD_ID).state, "ready")
    assert.equal(store.getChannelLayout(GUILD_ID).channels.length, 2)
  }
})

test("Gateway layout seeds reject partial, duplicate, non-guild, and invalid topology atomically", () => {
  for (const payload of [
    { id: GUILD_ID },
    { channels: null, id: GUILD_ID },
    { channels: [], id: GUILD_ID, unavailable: "true" },
  ]) {
    const store = layoutStore()
    seed(store)
    assert.equal(store.ingestDispatch("GUILD_CREATE", payload), true)
    assert.equal(store.getChannelLayout(GUILD_ID).state, "invalidated")
  }

  const malformedChannels: unknown[][] = [
    [
      ...directChannels(),
      { ...directChannels()[1], id: TEXT_ID },
    ],
    ...[DISCORD_CHANNEL_TYPES.dm, DISCORD_CHANNEL_TYPES.groupDm].map((type) => [
      { id: TEXT_ID, parent_id: null, position: 0, type },
    ]),
    [{ id: "18446744073709551616", parent_id: null, position: 0, type: DISCORD_CHANNEL_TYPES.text }],
    [{ id: TEXT_ID, parent_id: null, position: 0, type: DISCORD_CHANNEL_TYPES.publicThread }],
    [{ id: CATEGORY_ID, parent_id: TEXT_ID, position: 0, type: DISCORD_CHANNEL_TYPES.category }],
    [{ id: TEXT_ID, parent_id: OTHER_CHANNEL_ID, position: 0, type: DISCORD_CHANNEL_TYPES.text }],
    [{ flags: -1, id: TEXT_ID, parent_id: null, position: 0, type: DISCORD_CHANNEL_TYPES.text }],
    [{ guild_id: OTHER_GUILD_ID, id: TEXT_ID, parent_id: null, position: 0, type: DISCORD_CHANNEL_TYPES.text }],
  ]

  for (const channels of malformedChannels) {
    const store = layoutStore()
    seed(store)
    assert.equal(store.ingestDispatch("GUILD_CREATE", { channels, id: GUILD_ID }), true)
    const snapshot = store.getChannelLayout(GUILD_ID)
    assert.equal(snapshot.state, "invalidated")
    assert.equal(snapshot.reason, "malformed-guild-create")
    assert.deepEqual(snapshot.channels, [])
    assert.equal(snapshot.complete, false)
  }

  const overLimit = layoutStore()
  const channels = Array.from({ length: DISCORD_LIMITS.guildChannels + 1 }, (_, index) => ({
    id: String(300000000000000000n + BigInt(index)),
    parent_id: null,
    position: index,
    type: DISCORD_CHANNEL_TYPES.text,
  }))
  assert.equal(overLimit.ingestDispatch("GUILD_CREATE", { channels, id: GUILD_ID }), true)
  assert.equal(overLimit.getChannelLayout(GUILD_ID).state, "invalidated")

  const missingGuild = layoutStore([GUILD_ID, OTHER_GUILD_ID])
  seed(missingGuild)
  assert.equal(missingGuild.ingestDispatch("GUILD_CREATE", { channels: [] }), true)
  assert.equal(missingGuild.getChannelLayout(GUILD_ID).state, "invalidated")
  assert.equal(missingGuild.getChannelLayout(OTHER_GUILD_ID).state, "invalidated")
})

test("Gateway layout applies direct channel updates and category deletion semantics", () => {
  const store = layoutStore()
  const changedGuilds: string[] = []
  const unsubscribe = store.subscribeChannelLayouts((guildId) => changedGuilds.push(guildId))
  seed(store)

  assert.equal(store.ingestDispatch("CHANNEL_UPDATE", {
    flags: 0,
    guild_id: GUILD_ID,
    id: TEXT_ID,
    name: TOKEN,
    parent_id: CATEGORY_ID,
    position: 3,
    type: DISCORD_CHANNEL_TYPES.text,
  }), true)
  assert.equal(store.ingestDispatch("CHANNEL_CREATE", {
    flags: DISCORD_CHANNEL_FLAGS.channelObfuscated,
    guild_id: GUILD_ID,
    id: VOICE_ID,
    name: TOKEN,
    parent_id: CATEGORY_ID,
    position: 2,
    type: DISCORD_CHANNEL_TYPES.voice,
  }), true)
  assert.equal(store.ingestDispatch("CHANNEL_DELETE", {
    flags: 0,
    guild_id: GUILD_ID,
    id: CATEGORY_ID,
    parent_id: null,
    position: 0,
    type: DISCORD_CHANNEL_TYPES.category,
  }), true)

  const snapshot = store.getChannelLayout(GUILD_ID)
  assert.equal(snapshot.revision, 4)
  assert.deepEqual(snapshot.channels, [
    {
      channelId: TEXT_ID,
      obfuscated: false,
      parentChannelId: null,
      position: 3,
      type: DISCORD_CHANNEL_TYPES.text,
    },
    {
      channelId: VOICE_ID,
      obfuscated: true,
      parentChannelId: null,
      position: 2,
      type: DISCORD_CHANNEL_TYPES.voice,
    },
  ])
  assert.deepEqual(changedGuilds, [GUILD_ID, GUILD_ID, GUILD_ID, GUILD_ID])
  unsubscribe()

  assert.equal(store.ingestDispatch("CHANNEL_DELETE", {
    guild_id: GUILD_ID,
    id: OTHER_CHANNEL_ID,
    parent_id: null,
    position: 0,
    type: DISCORD_CHANNEL_TYPES.text,
  }), true)
  assert.equal(store.getChannelLayout(GUILD_ID).state, "invalidated")
  assert.equal(store.getChannelLayout(GUILD_ID).reason, "malformed-channel-dispatch")
  assert.equal(changedGuilds.length, 4)
})

test("Gateway layout availability, continuity, and reseeding fail closed", () => {
  const store = layoutStore()
  seed(store)
  assert.equal(store.ingestDispatch("GUILD_DELETE", {
    id: GUILD_ID,
    unavailable: true,
  }), true)
  assert.deepEqual(store.getChannelLayout(GUILD_ID), {
    channels: [],
    complete: false,
    guildId: GUILD_ID,
    reason: "guild-unavailable",
    revision: 2,
    schemaVersion: 1,
    state: "unavailable",
    updatedAt: "2026-08-23T00:00:01.000Z",
  })
  seed(store)
  assert.equal(store.getChannelLayout(GUILD_ID).state, "ready")
  assert.equal(store.invalidateForContinuityGap(), true)
  assert.equal(store.getChannelLayout(GUILD_ID).reason, "connection-gap")
  assert.deepEqual(store.getChannelLayout(GUILD_ID).channels, [])
  assert.equal(store.invalidateForIdentify(), false)
  seed(store)
  assert.equal(store.getChannelLayout(GUILD_ID).state, "ready")
  assert.equal(store.invalidateForIdentify(), true)
  assert.equal(store.getChannelLayout(GUILD_ID).reason, "new-identify")
  seed(store)
  assert.equal(store.ingestDispatch("GUILD_DELETE", { id: GUILD_ID }), true)
  assert.equal(store.getChannelLayout(GUILD_ID).reason, "guild-deleted")
})

test("Gateway event store collects layouts without enabling its public event feed", () => {
  const changes: string[] = []
  const store = new GatewayEventStore({
    allowedChannelIds: new Set(),
    allowedGuildIds: new Set([GUILD_ID]),
    cursorNamespace: "layoutonly12",
    enabled: true,
    eventFeedEnabled: false,
    layoutGuildIds: new Set([GUILD_ID]),
  })
  store.subscribe((kind) => changes.push(kind))

  assert.equal(store.ingestDispatch("GUILD_CREATE", {
    channels: directChannels(),
    id: GUILD_ID,
  }), false)
  assert.equal(store.getChannelLayout(GUILD_ID).state, "ready")
  assert.equal(store.listEvents().status, "disabled")
  assert.deepEqual(store.listEvents().events, [])
  assert.deepEqual(store.getStatus().intents, ["GUILDS"])
  assert.deepEqual(changes, ["layout", "status"])
  store.recordContinuityGap()
  assert.equal(store.getChannelLayout(GUILD_ID).state, "invalidated")
  assert.deepEqual(changes.slice(-3), ["layout", "events", "status"])
})
