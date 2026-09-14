import { runGuildControlServer } from "../../src/mcp.js"
import { loadObservabilityDocumentConfig } from "../../src/observability-config.js"
import { OperationalTelemetry } from "../../src/observability.js"
import { loadFixtureConfig } from "../config-fixture.js"
import { shutdownGateway } from "../shutdown-fixture.js"

const mode = process.argv[2]
const timeoutMs = 80
const blocked = () => new Promise<void>(() => {})
const observabilityRuntime = new OperationalTelemetry({
  config: loadObservabilityDocumentConfig({ exportEnabled: true }, {}, []),
  otlpFactory() {
    return {
      forceFlush: mode === "telemetry" ? blocked : async () => {},
      async shutdown() {},
    }
  },
})

runGuildControlServer({
  config: loadFixtureConfig({ token: "shutdown-fixture-token" }),
  environment: {},
  exitOnShutdown: true,
  gatewayRuntime: shutdownGateway({
    stop: mode === "gateway" ? blocked : async () => {},
  }),
  observabilityRuntime,
  shutdownTimeoutMs: timeoutMs,
})

// A retained runtime handle must not keep an owned process alive after its deadline
setInterval(() => {}, 1_000)
