import assert from "node:assert/strict"
import test from "node:test"

import { guildChannelAnalysisCoverage } from "../src/guild-channel-coverage.js"

test("channel analysis coverage retains exact opaque topology in canonical order", () => {
  const coverage = guildChannelAnalysisCoverage([
    { channelId: "200000000000000003", parentChannelId: null, position: 2, type: 99 },
    { channelId: "200000000000000001", parentChannelId: null, position: 0, type: 0 },
    { channelId: "200000000000000002", parentChannelId: null, position: 1, type: 20 },
  ])
  assert.deepEqual(coverage, {
    evaluatedChannelCount: 1,
    status: "partial",
    totalChannelCount: 3,
    unsupportedChannels: [
      { channelId: "200000000000000002", parentChannelId: null, position: 1, type: 20 },
      { channelId: "200000000000000003", parentChannelId: null, position: 2, type: 99 },
    ],
  })
  assert.equal(guildChannelAnalysisCoverage([]).status, "complete")
  assert.equal(guildChannelAnalysisCoverage([
    { channelId: "200000000000000001", parentChannelId: null, position: 0, type: 0 },
  ]).status, "complete")
})
