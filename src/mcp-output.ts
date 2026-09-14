import {
  ProtocolError,
  ProtocolErrorCode,
  type CallToolResult,
} from "@modelcontextprotocol/server"

import { SCHEMA_VERSION } from "./constants.js"
import { redactText } from "./errors.js"

export const MCP_READ_RESPONSE_TOO_LARGE_CODE = "MCP_READ_RESPONSE_TOO_LARGE"
export const MCP_READ_RESPONSE_TOO_LARGE_STATUS = "response-too-large"
export const GUILDCONTROL_RECEIPT_PREFIX = "GUILDCONTROL_RECEIPT "
export const GUILDCONTROL_RECEIPT_SCHEMA = "guildcontrol-result-receipt.v1"

const MCP_READ_RESPONSE_BUDGET_CONFIG_PATH = "$.limits.mcpReadResponseMaxBytes"
const MCP_READ_RESPONSE_RECOVERY = `Narrow the request or review ${MCP_READ_RESPONSE_BUDGET_CONFIG_PATH}.`
const MCP_READ_RESPONSE_TOO_LARGE_MESSAGE = `GuildControl MCP withheld an oversized read result. ${MCP_READ_RESPONSE_RECOVERY}`
const CONTENT_FREE_RECEIPT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
const CONTENT_FREE_RECEIPT_DIGEST_PATTERN = /^(?:hmac-sha256|sha256):[a-f0-9]{64}$/
const CONTENT_FREE_RECEIPT_TOKEN_PATTERN = /^[a-z][a-z0-9-]{0,95}$/
const CONTENT_FREE_RECEIPT_DIGEST_FIELDS = Object.freeze([
  "digest",
  "planDigest",
  "requestDigest",
  "operationKeyHash",
  "actualDigest",
  "expectedDigest",
] as const)

type McpReadSurface = "prompt" | "resource"

export function redactMcpValue<T>(
  value: T,
  secrets: readonly (string | undefined)[],
): T {
  if (typeof value === "string") return redactText(value, secrets) as T
  if (Array.isArray(value)) {
    return value.map((entry) => redactMcpValue(entry, secrets)) as T
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactMcpValue(entry, secrets),
      ]),
    ) as T
  }
  return value
}

export function redactedJson(
  value: unknown,
  secrets: readonly (string | undefined)[],
  indentation = 2,
): string {
  return JSON.stringify(redactMcpValue(value, secrets), null, indentation)
}

export function serializedMcpResultBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new TypeError("MCP application result must be JSON-serializable")
  }
  return Buffer.byteLength(serialized, "utf8")
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function contentFreeToolReceipt(
  structuredContent: unknown,
): Record<string, unknown> | undefined {
  const structured = objectValue(structuredContent)
  if (!structured) return undefined
  const receipt: Record<string, unknown> = {
    receiptSchema: GUILDCONTROL_RECEIPT_SCHEMA,
  }
  if (
    typeof structured.schemaVersion === "number"
    && Number.isSafeInteger(structured.schemaVersion)
    && structured.schemaVersion >= 1
  ) receipt.schemaVersion = structured.schemaVersion
  if (
    typeof structured.status === "string"
    && CONTENT_FREE_RECEIPT_TOKEN_PATTERN.test(structured.status)
  ) receipt.status = structured.status

  let continuationEvidence = false
  for (const field of CONTENT_FREE_RECEIPT_DIGEST_FIELDS) {
    const value = structured[field]
    if (
      typeof value === "string"
      && CONTENT_FREE_RECEIPT_DIGEST_PATTERN.test(value)
    ) {
      receipt[field] = value
      continuationEvidence = true
    }
  }
  if (
    typeof structured.nextAction === "string"
    && CONTENT_FREE_RECEIPT_TOKEN_PATTERN.test(structured.nextAction)
  ) {
    receipt.nextAction = structured.nextAction
    continuationEvidence = true
  }
  if (typeof structured.writeRequired === "boolean") {
    receipt.writeRequired = structured.writeRequired
  }

  const structuredError = objectValue(structured.error)
  if (structuredError) {
    const error: Record<string, unknown> = {}
    if (
      typeof structuredError.category === "string"
      && CONTENT_FREE_RECEIPT_TOKEN_PATTERN.test(structuredError.category)
    ) error.category = structuredError.category
    if (
      typeof structuredError.code === "string"
      && CONTENT_FREE_RECEIPT_CODE_PATTERN.test(structuredError.code)
    ) error.code = structuredError.code
    if (typeof structuredError.retriable === "boolean") {
      error.retriable = structuredError.retriable
    }
    if (Object.hasOwn(error, "code")) {
      receipt.error = error
      continuationEvidence = true
    }
  }

  return continuationEvidence ? receipt : undefined
}

export function withContentFreeToolReceipt<T extends CallToolResult>(
  result: T,
): T {
  const receipt = contentFreeToolReceipt(result.structuredContent)
  if (!receipt) return result
  const serialized = `${GUILDCONTROL_RECEIPT_PREFIX}${JSON.stringify(receipt)}`
  if (result.content.some((content) => (
    content.type === "text" && content.text === serialized
  ))) return result
  return {
    ...result,
    content: [
      ...result.content,
      { text: serialized, type: "text" },
    ],
  }
}

export function oversizedMcpToolResult(maxBytes: number): CallToolResult {
  return withContentFreeToolReceipt({
    content: [{
      text: MCP_READ_RESPONSE_TOO_LARGE_MESSAGE,
      type: "text",
    }],
    isError: true,
    structuredContent: {
      error: {
        category: "client",
        code: MCP_READ_RESPONSE_TOO_LARGE_CODE,
        recoveryHint: MCP_READ_RESPONSE_RECOVERY,
        retriable: false,
      },
      responseBudget: {
        limitBytes: maxBytes,
        measurement: "above-limit",
        scope: "mcp-read-result",
      },
      schemaVersion: SCHEMA_VERSION,
      status: MCP_READ_RESPONSE_TOO_LARGE_STATUS,
    },
  })
}

export function budgetMcpToolResult<T>(
  result: T,
  maxBytes: number,
  preserveMutationOutcome: boolean,
): T | CallToolResult {
  if (
    preserveMutationOutcome
    || serializedMcpResultBytes(result) <= maxBytes
  ) return result
  return oversizedMcpToolResult(maxBytes)
}

export function assertMcpReadResultBudget<T>(
  result: T,
  maxBytes: number,
  surface: McpReadSurface,
): T {
  if (serializedMcpResultBytes(result) <= maxBytes) return result
  throw new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    MCP_READ_RESPONSE_TOO_LARGE_MESSAGE,
    {
      code: MCP_READ_RESPONSE_TOO_LARGE_CODE,
      limitBytes: maxBytes,
      measurement: "above-limit",
      recoveryHint: MCP_READ_RESPONSE_RECOVERY,
      surface,
    },
  )
}
