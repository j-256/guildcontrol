import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs"
import type { BigIntStats } from "node:fs"
import {
  dirname,
  isAbsolute,
  resolve,
} from "node:path"
import { TextDecoder } from "node:util"

import { z } from "zod"

import {
  COMPONENT_LINK_LIMITS,
  canonicalComponentLinkOrigin,
} from "./component-link.js"
import {
  CONNECTOR_LIMITS,
  DEFAULT_TOKEN_ENVIRONMENT_VARIABLE,
  DISCORD_LIMITS,
  DISCORD_SNOWFLAKE_PATTERN,
  DISCORD_TOKEN_ENVIRONMENT_PATTERN,
  GATEWAY_DEFAULTS,
  MCP_READ_RESPONSE_DEFAULTS,
  MCP_READ_RESPONSE_LIMITS,
  MCP_TOOLSET_NAMES,
  MCP_TOOL_SURFACES,
  type McpToolsetName,
  type McpToolSurface,
} from "./constants.js"
import {
  ConfigDocumentError,
  CredentialUnavailableError,
} from "./errors.js"

export const CONFIG_DOCUMENT_SCHEMA_VERSION = 2
export const CONFIG_DOCUMENT_SCHEMA_ID =
  "https://raw.githubusercontent.com/j-256/guildcontrol/main/guildcontrol.config.schema.json"

export const CONFIG_READ_SCOPE_MODES = Object.freeze([
  "all-visible",
  "allowlist",
] as const)
export const CONFIG_USER_MENTION_MODES = Object.freeze([
  "disabled",
  "allowlist",
  "reviewed",
] as const)
export const CONFIG_THREAD_SCOPE_MODES = Object.freeze([
  "exact",
  "inherit",
] as const)

export type ConnectorConfigReadScopeMode = typeof CONFIG_READ_SCOPE_MODES[number]
export type ConnectorConfigUserMentionMode = typeof CONFIG_USER_MENTION_MODES[number]
export type ConnectorConfigThreadScopeMode = typeof CONFIG_THREAD_SCOPE_MODES[number]

const CONFIG_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/
const HEADER_ENVIRONMENT_PATTERN = /^[A-Z][A-Z0-9_]{0,118}_HEADERS$/
const CONFIG_JSON_MAX_DEPTH = 64
const FILE_OVERFLOW_PROBE_BYTES = 1
const CONFIG_STRING_CHARACTERS = 4_096
const CONFIG_SCOPE_ENTRIES = 1_000
const CONFIG_ROOT_ENTRIES = 32

export const CONFIG_SCOPE_GROUP_LIMITS = Object.freeze({
  groupsPerType: 100,
  idsPerGroup: CONFIG_SCOPE_ENTRIES,
} as const)

export interface EnvironmentSecretReference {
  provider: "environment"
  variable: string
}

export interface FileSecretReference {
  path: string
  provider: "file"
}

export type ConnectorCredentialReference =
  | EnvironmentSecretReference
  | FileSecretReference

export interface ConnectorConfigDocumentObservabilitySignal {
  compression?: string
  endpoint?: string
  headers?: EnvironmentSecretReference
  protocol?: string
  timeoutMs?: number
}

export interface ConnectorConfigDocumentObservability {
  compression?: string
  endpoint?: string
  exportEnabled?: boolean
  headers?: EnvironmentSecretReference
  jsonLogsEnabled?: boolean
  metrics?: ConnectorConfigDocumentObservabilitySignal
  protocol?: string
  serviceName?: string
  timeoutMs?: number
  traceSampleRatio?: number
  traceSampler?: string
  traces?: ConnectorConfigDocumentObservabilitySignal
}

export interface ConnectorConfigDocument {
  $schema?: typeof CONFIG_DOCUMENT_SCHEMA_ID
  capabilities: Readonly<Partial<Record<ConnectorConfigCapabilityName, boolean>>>
  credential: ConnectorCredentialReference
  gateway: {
    enabled: boolean
    eventBufferSize: number
  }
  groups: ConnectorConfigDocumentScopeGroups
  identity: {
    applicationId: string
    botId: string
  }
  limits: Readonly<Partial<Record<ConnectorConfigLimitName, number>>>
  name: string
  notifications: {
    userMentions: ConnectorConfigUserMentionMode
  }
  observability: ConnectorConfigDocumentObservability
  readScope: {
    channelMode: ConnectorConfigReadScopeMode
    channelIds: readonly string[]
    guildMode: ConnectorConfigReadScopeMode
    guildIds: readonly string[]
  }
  runtime: Readonly<Partial<Record<ConnectorConfigRuntimeName, string>>>
  schemaVersion: 2
  scopes: Readonly<Partial<Record<ConnectorConfigScopeName, readonly string[]>>>
  storage: ConnectorConfigDocumentStorage
  threads: {
    messageWrites: ConnectorConfigThreadScopeMode
    reads: ConnectorConfigThreadScopeMode
  }
  tools: {
    surface: McpToolSurface
    toolsets: readonly McpToolsetName[]
  }
}

export interface ConfigDocumentField {
  defaultValue: boolean | number | string | readonly string[] | Readonly<Record<string, readonly string[]>> | undefined
  description: string
  kind: "boolean" | "group-map" | "integer" | "number" | "path" | "paths" | "scope-entries" | "secret-reference" | "snowflake" | "snowflakes" | "string" | "strings"
  path: string
  required: boolean
}

export interface ConnectorConfigDocumentFileInspection {
  document: ConnectorConfigDocument
  file: string
  hardLinkCount: number
  symbolicLink: boolean
  targetFile: string
}

function humanizeConfigKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\bIds$/, "IDs")
    .toLowerCase()
}

export const CONFIG_CAPABILITY_NAMES = Object.freeze([
  "administration",
  "applicationCommandChanges",
  "globalApplicationCommandChanges",
  "applicationEmojiAudit",
  "applicationEmojiChanges",
  "applicationEntitlementConsumption",
  "applicationMonetizationAudit",
  "applicationTestEntitlementChanges",
  "applicationIntentChanges",
  "applicationRoleConnectionMetadataChanges",
  "botProfileAudit",
  "botProfileChanges",
  "announcementCrossposts",
  "announcementSubscriptionAudit",
  "announcementSubscriptionChanges",
  "attachments",
  "automodAudit",
  "automodChanges",
  "banAudit",
  "bulkBanAudit",
  "bulkBans",
  "bulkMemberRoleChanges",
  "channelCreation",
  "channelDeletionAudit",
  "channelDeletions",
  "channelCloneAudit",
  "channelCloning",
  "channelMetadataChanges",
  "channelOrderingAudit",
  "channelOrderingChanges",
  "deletions",
  "directMessageAudit",
  "directMessageAttachments",
  "directMessageDeletion",
  "directMessageDelivery",
  "directMessageEditing",
  "embedMessages",
  "forumPosts",
  "forumTagAudit",
  "forumTagChanges",
  "guildExpressionAudit",
  "guildExpressionChanges",
  "guildCommunityAudit",
  "guildCommunityChanges",
  "guildDepartures",
  "guildIncidentAudit",
  "guildIncidentChanges",
  "guildProfileAudit",
  "guildProfileChanges",
  "guildPruneAudit",
  "guildPrunes",
  "guildScaffolds",
  "guildSettingsAudit",
  "guildSettingsChanges",
  "guildTemplateAudit",
  "guildTemplateChanges",
  "integrationAudit",
  "integrationDeletions",
  "interactions",
  "inviteAudit",
  "inviteCreation",
  "inviteRoleAssignment",
  "inviteDeletions",
  "memberDirectory",
  "nicknameChanges",
  "otherMemberNicknameChanges",
  "memberRoleChanges",
  "memberVerificationChanges",
  "memberVoiceAudit",
  "memberVoiceChanges",
  "messageForwarding",
  "crossGuildMessageForwarding",
  "nativeCommandChanges",
  "nativeInteractions",
  "onboardingAudit",
  "onboardingChanges",
  "pinManagement",
  "permissionOverwrites",
  "permissionSyncs",
  "pollAudit",
  "pollCreation",
  "pollEnding",
  "pollVoterAudit",
  "reactionModeration",
  "reactionUserAudit",
  "roleCreation",
  "roleConfiguration",
  "roleDeletionAudit",
  "roleDeletions",
  "roleOrderingAudit",
  "roleOrderingChanges",
  "scheduledEventAudit",
  "scheduledEventUserAudit",
  "scheduledEventChanges",
  "soundboardAudit",
  "soundboardChanges",
  "soundboardPlayback",
  "stageInstanceAudit",
  "stageInstanceChanges",
  "stageStartNotifications",
  "threadCreation",
  "threadAudit",
  "threadChanges",
  "welcomeScreenAudit",
  "welcomeScreenChanges",
  "webhookAudit",
  "webhookChanges",
  "webhookCreation",
  "webhookDeletions",
  "webhookMessageAudit",
  "webhookMessageChanges",
  "webhookMessageDeletions",
  "webhookMessageDelivery",
  "widgetPublicExposure",
  "widgetSettingsAudit",
  "widgetSettingsChanges",
] as const)

export const CONFIG_SCOPE_NAMES = Object.freeze([
  "adminGuildIds",
  "applicationCommandGuildIds",
  "applicationConsumableEntitlementSkuIds",
  "applicationConsumableEntitlementUserIds",
  "applicationEntitlementGuildIds",
  "applicationEntitlementUserIds",
  "applicationMonetizationSkuIds",
  "applicationSubscriptionUserIds",
  "applicationTestEntitlementGuildIds",
  "applicationTestEntitlementSkuIds",
  "applicationTestEntitlementUserIds",
  "announcementCrosspostChannelIds",
  "announcementSubscriptionSourceChannelIds",
  "announcementSubscriptionTargetChannelIds",
  "attachmentChannelIds",
  "automodAlertChannelIds",
  "automodGuildIds",
  "banAuditGuildIds",
  "bulkBanGuildIds",
  "bulkMemberRoleGuildIds",
  "bulkMemberRoleIds",
  "channelCreationGuildIds",
  "channelDeletionIds",
  "channelCloneGuildIds",
  "channelCloneSourceIds",
  "channelMetadataIds",
  "channelOrderingGuildIds",
  "componentLinkOrigins",
  "deleteChannelIds",
  "directMessageUserIds",
  "embedMessageChannelIds",
  "forumPostChannelIds",
  "forumTagChannelIds",
  "guildScaffoldGuildIds",
  "guildCommunityGuildIds",
  "guildDepartureGuildIds",
  "guildExpressionGuildIds",
  "guildIncidentGuildIds",
  "guildProfileGuildIds",
  "guildPruneGuildIds",
  "guildPruneIncludeRoleIds",
  "guildSettingsGuildIds",
  "guildTemplateGuildIds",
  "integrationGuildIds",
  "integrationIds",
  "interactionChannelIds",
  "inviteCreationChannelIds",
  "inviteRoleIds",
  "inviteGuildIds",
  "mentionUserIds",
  "memberDirectoryGuildIds",
  "nicknameGuildIds",
  "memberRoleGuildIds",
  "memberRoleIds",
  "memberVerificationGuildIds",
  "memberVoiceChannelIds",
  "memberVoiceGuildIds",
  "messageForwardSourceChannelIds",
  "messageForwardTargetChannelIds",
  "nativeInteractionChannelIds",
  "nativeInteractionGuildIds",
  "nativeInteractionUserIds",
  "onboardingGuildIds",
  "protectedUserIds",
  "pinChannelIds",
  "pollChannelIds",
  "reactionChannelIds",
  "permissionOverwriteChannelIds",
  "permissionSyncChannelIds",
  "roleCreationGuildIds",
  "roleConfigurationIds",
  "roleDeletionIds",
  "roleOrderingGuildIds",
  "scheduledEventGuildIds",
  "soundboardGuildIds",
  "soundboardPlaybackChannelIds",
  "soundboardPlaybackSourceGuildIds",
  "stageChannelIds",
  "threadParentIds",
  "threadGuildIds",
  "threadIds",
  "threadMemberUserIds",
  "welcomeScreenGuildIds",
  "webhookChannelIds",
  "webhookGuildIds",
  "webhookMessageChannelIds",
  "widgetSettingsGuildIds",
] as const)

export const CONFIG_SCOPE_GROUP_TYPES = Object.freeze([
  "channels",
  "guilds",
  "roles",
  "users",
] as const)

export const CONFIG_LIMIT_NAMES = Object.freeze([
  "attachmentMaxBytes",
  "guildPruneMaxMembers",
  "interactionMaxWritesPerMinute",
  "interactionMinWriteIntervalMs",
  "mcpReadResponseMaxBytes",
  "nativeInteractionMaxPending",
  "nativeInteractionTtlSeconds",
] as const)

export const CONFIG_STORAGE_NAMES = Object.freeze([
  "applicationEmojiRoots",
  "attachmentRoots",
  "auditFile",
  "botProfileRoots",
  "guildExpressionRoots",
  "inviteCapabilityRoots",
  "scheduledEventRoots",
  "soundboardRoots",
  "webhookCredentialRoot",
] as const)

export const CONFIG_RUNTIME_NAMES = Object.freeze([
  "nativeCommandName",
] as const)

export type ConnectorConfigCapabilityName = (typeof CONFIG_CAPABILITY_NAMES)[number]
export type ConnectorConfigLimitName = (typeof CONFIG_LIMIT_NAMES)[number]
export type ConnectorConfigRuntimeName = (typeof CONFIG_RUNTIME_NAMES)[number]
export type ConnectorConfigScopeName = (typeof CONFIG_SCOPE_NAMES)[number]
export type ConnectorConfigScopeGroupType = (typeof CONFIG_SCOPE_GROUP_TYPES)[number]

export interface ConnectorConfigDocumentScopeGroups {
  channels?: Readonly<Record<string, readonly string[]>>
  guilds?: Readonly<Record<string, readonly string[]>>
  roles?: Readonly<Record<string, readonly string[]>>
  users?: Readonly<Record<string, readonly string[]>>
}

const GUILD_SCOPE_NAMES = Object.freeze([
  "adminGuildIds",
  "applicationCommandGuildIds",
  "applicationEntitlementGuildIds",
  "applicationTestEntitlementGuildIds",
  "automodGuildIds",
  "banAuditGuildIds",
  "bulkBanGuildIds",
  "bulkMemberRoleGuildIds",
  "channelCreationGuildIds",
  "channelCloneGuildIds",
  "channelOrderingGuildIds",
  "guildCommunityGuildIds",
  "guildDepartureGuildIds",
  "guildExpressionGuildIds",
  "guildIncidentGuildIds",
  "guildProfileGuildIds",
  "guildPruneGuildIds",
  "guildScaffoldGuildIds",
  "guildSettingsGuildIds",
  "guildTemplateGuildIds",
  "integrationGuildIds",
  "inviteGuildIds",
  "memberDirectoryGuildIds",
  "memberRoleGuildIds",
  "memberVerificationGuildIds",
  "memberVoiceGuildIds",
  "nativeInteractionGuildIds",
  "nicknameGuildIds",
  "onboardingGuildIds",
  "roleCreationGuildIds",
  "roleOrderingGuildIds",
  "scheduledEventGuildIds",
  "soundboardGuildIds",
  "soundboardPlaybackSourceGuildIds",
  "threadGuildIds",
  "webhookGuildIds",
  "welcomeScreenGuildIds",
  "widgetSettingsGuildIds",
] satisfies readonly ConnectorConfigScopeName[])

const CHANNEL_SCOPE_NAMES = Object.freeze([
  "announcementCrosspostChannelIds",
  "announcementSubscriptionSourceChannelIds",
  "announcementSubscriptionTargetChannelIds",
  "attachmentChannelIds",
  "automodAlertChannelIds",
  "channelCloneSourceIds",
  "channelDeletionIds",
  "channelMetadataIds",
  "deleteChannelIds",
  "embedMessageChannelIds",
  "forumPostChannelIds",
  "forumTagChannelIds",
  "interactionChannelIds",
  "inviteCreationChannelIds",
  "memberVoiceChannelIds",
  "messageForwardSourceChannelIds",
  "messageForwardTargetChannelIds",
  "nativeInteractionChannelIds",
  "permissionOverwriteChannelIds",
  "permissionSyncChannelIds",
  "pinChannelIds",
  "pollChannelIds",
  "reactionChannelIds",
  "soundboardPlaybackChannelIds",
  "stageChannelIds",
  "threadIds",
  "threadParentIds",
  "webhookChannelIds",
  "webhookMessageChannelIds",
] satisfies readonly ConnectorConfigScopeName[])

const ROLE_SCOPE_NAMES = Object.freeze([
  "bulkMemberRoleIds",
  "guildPruneIncludeRoleIds",
  "inviteRoleIds",
  "memberRoleIds",
  "roleConfigurationIds",
  "roleDeletionIds",
] satisfies readonly ConnectorConfigScopeName[])

const USER_SCOPE_NAMES = Object.freeze([
  "applicationConsumableEntitlementUserIds",
  "applicationEntitlementUserIds",
  "applicationSubscriptionUserIds",
  "applicationTestEntitlementUserIds",
  "directMessageUserIds",
  "mentionUserIds",
  "nativeInteractionUserIds",
  "protectedUserIds",
  "threadMemberUserIds",
] satisfies readonly ConnectorConfigScopeName[])

export const CONFIG_SCOPE_RESOURCE_TYPES = Object.freeze(Object.fromEntries([
  ...GUILD_SCOPE_NAMES.map((name) => [name, "guilds"] as const),
  ...CHANNEL_SCOPE_NAMES.map((name) => [name, "channels"] as const),
  ...ROLE_SCOPE_NAMES.map((name) => [name, "roles"] as const),
  ...USER_SCOPE_NAMES.map((name) => [name, "users"] as const),
]) as Readonly<Partial<Record<ConnectorConfigScopeName, ConnectorConfigScopeGroupType>>>)

export interface ConnectorConfigDocumentStorage {
  applicationEmojiRoots?: readonly string[]
  attachmentRoots?: readonly string[]
  auditFile?: string
  botProfileRoots?: readonly string[]
  guildExpressionRoots?: readonly string[]
  inviteCapabilityRoots?: readonly string[]
  scheduledEventRoots?: readonly string[]
  soundboardRoots?: readonly string[]
  webhookCredentialRoot?: string
}

function canonicalArray<T extends string>(
  values: readonly T[],
  order?: readonly T[],
): boolean {
  const canonical = order
    ? order.filter((entry) => values.includes(entry))
    : [...values].sort()
  return new Set(values).size === values.length
    && canonical.every((entry, index) => entry === values[index])
}

const snowflakeSchema = z.string()
  .regex(DISCORD_SNOWFLAKE_PATTERN, "must be a Discord snowflake")

const scopeGroupNameSchema = z.string()
  .regex(CONFIG_NAME_PATTERN, "must be a bounded lowercase group name")

const scopeGroupReferenceSchema = z.string()
  .regex(/^@[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/, "must be an @group reference")

const scopedIdSchema = z.union([
  snowflakeSchema,
  scopeGroupReferenceSchema,
])

const absolutePathSchema = z.string()
  .min(1)
  .max(CONFIG_STRING_CHARACTERS)
  .refine(
    (value) => (
      value.trim() === value
      && !/[\u0000-\u001F\u007F]/u.test(value)
      && isAbsolute(value)
      && resolve(value) === value
    ),
    "must be an absolute canonical path",
  )

function snowflakeArraySchema(minimum: number, maximum: number): z.ZodType<string[]> {
  return z.array(snowflakeSchema)
    .min(minimum)
    .max(maximum, `must contain at most ${maximum} unique IDs`)
    .refine((values) => canonicalArray(values), "must contain unique sorted Discord snowflakes")
}

function scopedIdArraySchema(minimum: number, maximum: number): z.ZodType<string[]> {
  return z.array(scopedIdSchema)
    .min(minimum)
    .max(maximum, `must contain at most ${maximum} unique IDs or group references`)
    .refine(
      (values) => canonicalArray(values),
      "must contain unique sorted Discord snowflakes and @group references",
    )
}

const scopeGroupMapSchema = z.record(
  scopeGroupNameSchema,
  snowflakeArraySchema(1, CONFIG_SCOPE_GROUP_LIMITS.idsPerGroup),
).superRefine((value, context) => {
  const names = Object.keys(value)
  if (names.length > CONFIG_SCOPE_GROUP_LIMITS.groupsPerType) {
    context.addIssue({
      code: "custom",
      message: `must define at most ${CONFIG_SCOPE_GROUP_LIMITS.groupsPerType} groups`,
    })
  }
  if (!canonicalArray(names)) {
    context.addIssue({
      code: "custom",
      message: "must define groups in canonical name order",
    })
  }
})

const scopeGroupsSchema = z.strictObject({
  channels: scopeGroupMapSchema.optional(),
  guilds: scopeGroupMapSchema.optional(),
  roles: scopeGroupMapSchema.optional(),
  users: scopeGroupMapSchema.optional(),
})

const rootArraySchema = z.array(absolutePathSchema)
  .max(CONFIG_ROOT_ENTRIES)
  .refine((values) => canonicalArray(values), "must contain unique sorted paths")

const configNameSchema = z.string()
  .regex(CONFIG_NAME_PATTERN, "must be a bounded lowercase filename-safe identifier")
  .refine((value) => !WINDOWS_DEVICE_NAME_PATTERN.test(value), "must not be a reserved filename")

const tokenReferenceSchema = z.strictObject({
  provider: z.literal("environment"),
  variable: z.string()
    .max(128)
    .regex(DISCORD_TOKEN_ENVIRONMENT_PATTERN, "must name an uppercase Discord token environment variable"),
})

const credentialFileReferenceSchema = z.strictObject({
  path: absolutePathSchema.refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "must not contain control characters",
  ).describe("Absolute canonical path to a bounded externally managed Discord token file"),
  provider: z.literal("file"),
})

const credentialReferenceSchema = z.discriminatedUnion("provider", [
  tokenReferenceSchema,
  credentialFileReferenceSchema,
]).describe("Environment or bounded file reference for the Discord bot token")

const headerReferenceSchema = z.strictObject({
  provider: z.literal("environment"),
  variable: z.string()
    .max(128)
    .regex(HEADER_ENVIRONMENT_PATTERN, "must name an uppercase header environment variable"),
}).describe("Environment reference for an OTLP header string")

const CHANNEL_METADATA_CAPABILITY_DESCRIPTION = "Enable reviewed channel metadata and exact ordinary voice-channel status policy"
const CHANNEL_METADATA_SCOPE_DESCRIPTION = "Exact Discord ID allowlist for reviewed channel metadata and ordinary voice-channel status"
const INVITE_CREATION_CAPABILITY_DESCRIPTION = "Enable reviewed finite invite creation with private-file capability delivery"
const INVITE_CREATION_SCOPE_DESCRIPTION = "Exact direct guild-channel ID allowlist for reviewed finite invite creation"
const INVITE_ROLE_ASSIGNMENT_CAPABILITY_DESCRIPTION = "Enable reviewed persistent role assignment through finite privately delivered invites"
const INVITE_ROLE_SCOPE_DESCRIPTION = "Exact role ID allowlist for reviewed persistent invite role assignment"
const INVITE_CAPABILITY_ROOT_DESCRIPTION = "Canonical process-owned roots for exclusive private invite capability files"
const APPLICATION_INTENT_CHANGES_CAPABILITY_DESCRIPTION = "Enable reviewed additive application privileged-intent enablement"
const APPLICATION_COMMAND_CHANGES_CAPABILITY_DESCRIPTION = "Enable reviewed exact-guild application-command creation, complete-state update, and exact-ID deletion"
const GLOBAL_APPLICATION_COMMAND_CHANGES_CAPABILITY_DESCRIPTION = "Enable reviewed application-wide global command creation, complete-state update, and exact-ID deletion"
const APPLICATION_COMMAND_GUILD_SCOPE_DESCRIPTION = "Exact guild ID allowlist for reviewed application-command changes"
const APPLICATION_ROLE_CONNECTION_METADATA_CHANGES_CAPABILITY_DESCRIPTION = "Enable reviewed complete current-application linked-role metadata replacement and clearance"
const BOT_PROFILE_AUDIT_CAPABILITY_DESCRIPTION = "Enable privacy-bounded reads of the authenticated current bot profile"
const BOT_PROFILE_CHANGES_CAPABILITY_DESCRIPTION = "Enable reviewed application-wide current-bot username, avatar, and banner changes"
const BOT_PROFILE_ROOT_DESCRIPTION = "Canonical process-owned roots for reviewed current-bot avatar and banner images"
const BULK_BAN_AUDIT_CAPABILITY_DESCRIPTION = "Enable reviewed exact-target Bulk Guild Ban planning"
const BULK_BANS_CAPABILITY_DESCRIPTION = "Enable reviewed exact-target Bulk Guild Ban execution"
const BULK_MEMBER_ROLE_CHANGES_CAPABILITY_DESCRIPTION = "Enable reviewed exact-target bulk member-role changes"
const BULK_BAN_SCOPE_DESCRIPTION = "Exact guild ID allowlist for reviewed Bulk Guild Ban planning and execution"
const BULK_MEMBER_ROLE_GUILD_SCOPE_DESCRIPTION = "Exact guild ID allowlist for reviewed bulk member-role changes"
const BULK_MEMBER_ROLE_ROLE_SCOPE_DESCRIPTION = "Exact role ID allowlist for reviewed bulk member-role changes"
const GUILD_PRUNE_AUDIT_CAPABILITY_DESCRIPTION = "Enable reviewed non-exact guild prune planning"
const GUILD_PRUNES_CAPABILITY_DESCRIPTION = "Enable reviewed non-exact guild prune execution"
const GUILD_PRUNE_GUILD_SCOPE_DESCRIPTION = "Exact guild ID allowlist for reviewed guild prune planning and execution"
const GUILD_PRUNE_ROLE_SCOPE_DESCRIPTION = "Exact role ID allowlist for optional reviewed guild prune cohort widening"
const WEBHOOK_MESSAGE_AUDIT_CAPABILITY_DESCRIPTION = "Enable exact credential-safe Incoming-webhook message lookup without content persistence"
const WEBHOOK_MESSAGE_CHANGE_CAPABILITY_DESCRIPTION = "Enable exact credential-safe Incoming-webhook message edits with one-shot coordination"
const WEBHOOK_MESSAGE_DELETION_CAPABILITY_DESCRIPTION = "Enable reviewed exact Incoming-webhook message deletion with transient content-bound planning"
const WEBHOOK_MESSAGE_DELIVERY_CAPABILITY_DESCRIPTION = "Enable bounded plain-text Incoming-webhook message delivery with mention containment and one-shot coordination"
const WEBHOOK_MESSAGE_SCOPE_DESCRIPTION = "Exact direct text or announcement channel ID allowlist for privately credentialed Incoming-webhook message access"
const DIRECT_MESSAGE_AUDIT_CAPABILITY_DESCRIPTION = "Enable exact-recipient one-to-one direct-message reads without content persistence"
const DIRECT_MESSAGE_ATTACHMENTS_CAPABILITY_DESCRIPTION = "Enable reviewed owned local-file attachments in exact-recipient direct messages"
const DIRECT_MESSAGE_DELETION_CAPABILITY_DESCRIPTION = "Enable reviewed deletion of exact connector-authored direct messages"
const DIRECT_MESSAGE_DELIVERY_CAPABILITY_DESCRIPTION = "Enable reviewed plain-text direct-message sends and replies"
const DIRECT_MESSAGE_EDITING_CAPABILITY_DESCRIPTION = "Enable reviewed edits of exact connector-authored direct messages"
const DIRECT_MESSAGE_USER_SCOPE_DESCRIPTION = "Exact ordinary Discord user ID allowlist for isolated one-to-one direct-message access"
const EMBED_MESSAGE_CAPABILITY_DESCRIPTION = "Enable reviewed remote-free static rich-embed message creation and exact bot-owned replacement"
const EMBED_MESSAGE_SCOPE_DESCRIPTION = "Exact Discord channel or thread ID allowlist for reviewed static rich-embed messages"
const APPLICATION_MONETIZATION_AUDIT_CAPABILITY_DESCRIPTION = "Enable exact-beneficiary entitlement and exact-user subscription lifecycle audits"
const APPLICATION_ENTITLEMENT_CONSUMPTION_CAPABILITY_DESCRIPTION = "Enable reviewed exact-user consumable entitlement fulfillment acknowledgement and consumption"
const APPLICATION_TEST_ENTITLEMENT_CHANGES_CAPABILITY_DESCRIPTION = "Enable reviewed subscription test-entitlement creation and receipt-proven deletion"
const APPLICATION_CONSUMABLE_ENTITLEMENT_SKU_SCOPE_DESCRIPTION = "Exact current-application consumable SKU ID allowlist for reviewed entitlement consumption"
const APPLICATION_CONSUMABLE_ENTITLEMENT_USER_SCOPE_DESCRIPTION = "Exact user beneficiary ID allowlist for reviewed entitlement consumption"
const APPLICATION_ENTITLEMENT_GUILD_SCOPE_DESCRIPTION = "Exact guild beneficiary ID allowlist for application entitlement audit"
const APPLICATION_ENTITLEMENT_USER_SCOPE_DESCRIPTION = "Exact user beneficiary ID allowlist for application entitlement audit"
const APPLICATION_MONETIZATION_SKU_SCOPE_DESCRIPTION = "Exact current-application SKU ID evidence allowlist shared by monetization audit and reviewed entitlement lifecycle changes"
const APPLICATION_SUBSCRIPTION_USER_SCOPE_DESCRIPTION = "Exact user ID allowlist for application subscription lifecycle audit"
const APPLICATION_TEST_ENTITLEMENT_GUILD_SCOPE_DESCRIPTION = "Exact guild beneficiary ID allowlist for reviewed subscription test entitlements"
const APPLICATION_TEST_ENTITLEMENT_SKU_SCOPE_DESCRIPTION = "Exact current-application subscription SKU ID allowlist for reviewed test entitlements"
const APPLICATION_TEST_ENTITLEMENT_USER_SCOPE_DESCRIPTION = "Exact user beneficiary ID allowlist for reviewed subscription test entitlements"
const GUILD_COMMUNITY_AUDIT_CAPABILITY_DESCRIPTION = "Enable privacy-minimized Discord Community routing and authority audits"
const GUILD_COMMUNITY_CHANGES_CAPABILITY_DESCRIPTION = "Enable reviewed monotonic Community enablement and exact routing changes"
const GUILD_COMMUNITY_SCOPE_DESCRIPTION = "Exact guild ID allowlist for Discord Community audit and reviewed changes"
const GUILD_DEPARTURES_CAPABILITY_DESCRIPTION = "Enable reviewed exact-guild connector departure with access-loss, re-entry, and quiescence acknowledgments"
const GUILD_DEPARTURE_SCOPE_DESCRIPTION = "Exact guild ID allowlist for reviewed connector departure"
const MEMBER_VERIFICATION_CHANGES_CAPABILITY_DESCRIPTION = "Enable reviewed exact-member changes to Discord's named BYPASSES_VERIFICATION state"
const MEMBER_VERIFICATION_GUILD_SCOPE_DESCRIPTION = "Exact guild ID allowlist for reviewed member verification-bypass changes"
const PERMISSION_SYNCS_CAPABILITY_DESCRIPTION = "Enable reviewed complete parent-category permission synchronization with explicit replacement and future-propagation acknowledgment"
const PERMISSION_SYNC_SCOPE_DESCRIPTION = "Exact direct child channel ID allowlist for reviewed parent-category permission synchronization"
const SOUNDBOARD_PLAYBACK_CAPABILITY_DESCRIPTION = "Enable exact-scope guarded soundboard playback with live voice-state and permission proof"
const SOUNDBOARD_PLAYBACK_CHANNEL_SCOPE_DESCRIPTION = "Exact ordinary voice-channel ID allowlist for guarded soundboard playback"
const SOUNDBOARD_PLAYBACK_SOURCE_GUILD_SCOPE_DESCRIPTION = "Exact custom-sound source guild ID allowlist for guarded soundboard playback"

function capabilityDescription(documentKey: string): string {
  if (documentKey === "guildCommunityAudit") {
    return GUILD_COMMUNITY_AUDIT_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "guildCommunityChanges") {
    return GUILD_COMMUNITY_CHANGES_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "guildDepartures") {
    return GUILD_DEPARTURES_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "applicationMonetizationAudit") {
    return APPLICATION_MONETIZATION_AUDIT_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "applicationEntitlementConsumption") {
    return APPLICATION_ENTITLEMENT_CONSUMPTION_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "applicationTestEntitlementChanges") {
    return APPLICATION_TEST_ENTITLEMENT_CHANGES_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "applicationCommandChanges") {
    return APPLICATION_COMMAND_CHANGES_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "globalApplicationCommandChanges") {
    return GLOBAL_APPLICATION_COMMAND_CHANGES_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "applicationIntentChanges") {
    return APPLICATION_INTENT_CHANGES_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "applicationRoleConnectionMetadataChanges") {
    return APPLICATION_ROLE_CONNECTION_METADATA_CHANGES_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "botProfileAudit") {
    return BOT_PROFILE_AUDIT_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "botProfileChanges") {
    return BOT_PROFILE_CHANGES_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "channelMetadataChanges") {
    return CHANNEL_METADATA_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "bulkBanAudit") {
    return BULK_BAN_AUDIT_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "bulkBans") {
    return BULK_BANS_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "bulkMemberRoleChanges") {
    return BULK_MEMBER_ROLE_CHANGES_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "inviteCreation") {
    return INVITE_CREATION_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "inviteRoleAssignment") {
    return INVITE_ROLE_ASSIGNMENT_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "guildPruneAudit") {
    return GUILD_PRUNE_AUDIT_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "guildPrunes") {
    return GUILD_PRUNES_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "webhookMessageAudit") {
    return WEBHOOK_MESSAGE_AUDIT_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "webhookMessageChanges") {
    return WEBHOOK_MESSAGE_CHANGE_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "webhookMessageDeletions") {
    return WEBHOOK_MESSAGE_DELETION_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "webhookMessageDelivery") {
    return WEBHOOK_MESSAGE_DELIVERY_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "directMessageAudit") {
    return DIRECT_MESSAGE_AUDIT_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "directMessageAttachments") {
    return DIRECT_MESSAGE_ATTACHMENTS_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "directMessageDeletion") {
    return DIRECT_MESSAGE_DELETION_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "directMessageDelivery") {
    return DIRECT_MESSAGE_DELIVERY_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "directMessageEditing") {
    return DIRECT_MESSAGE_EDITING_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "embedMessages") {
    return EMBED_MESSAGE_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "memberVerificationChanges") {
    return MEMBER_VERIFICATION_CHANGES_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "permissionSyncs") {
    return PERMISSION_SYNCS_CAPABILITY_DESCRIPTION
  }
  if (documentKey === "soundboardPlayback") {
    return SOUNDBOARD_PLAYBACK_CAPABILITY_DESCRIPTION
  }
  return `Enable ${humanizeConfigKey(documentKey)} policy`
}

function scopeDescription(documentKey: string): string {
  if (documentKey === "componentLinkOrigins") {
    return "Exact canonical HTTPS origin allowlist for Components V2 link buttons"
  }
  if (documentKey === "guildCommunityGuildIds") {
    return GUILD_COMMUNITY_SCOPE_DESCRIPTION
  }
  if (documentKey === "guildDepartureGuildIds") {
    return GUILD_DEPARTURE_SCOPE_DESCRIPTION
  }
  if (documentKey === "applicationEntitlementGuildIds") {
    return APPLICATION_ENTITLEMENT_GUILD_SCOPE_DESCRIPTION
  }
  if (documentKey === "applicationEntitlementUserIds") {
    return APPLICATION_ENTITLEMENT_USER_SCOPE_DESCRIPTION
  }
  if (documentKey === "applicationMonetizationSkuIds") {
    return APPLICATION_MONETIZATION_SKU_SCOPE_DESCRIPTION
  }
  if (documentKey === "applicationSubscriptionUserIds") {
    return APPLICATION_SUBSCRIPTION_USER_SCOPE_DESCRIPTION
  }
  if (documentKey === "applicationConsumableEntitlementSkuIds") {
    return APPLICATION_CONSUMABLE_ENTITLEMENT_SKU_SCOPE_DESCRIPTION
  }
  if (documentKey === "applicationConsumableEntitlementUserIds") {
    return APPLICATION_CONSUMABLE_ENTITLEMENT_USER_SCOPE_DESCRIPTION
  }
  if (documentKey === "applicationTestEntitlementGuildIds") {
    return APPLICATION_TEST_ENTITLEMENT_GUILD_SCOPE_DESCRIPTION
  }
  if (documentKey === "applicationTestEntitlementSkuIds") {
    return APPLICATION_TEST_ENTITLEMENT_SKU_SCOPE_DESCRIPTION
  }
  if (documentKey === "applicationTestEntitlementUserIds") {
    return APPLICATION_TEST_ENTITLEMENT_USER_SCOPE_DESCRIPTION
  }
  if (documentKey === "applicationCommandGuildIds") {
    return APPLICATION_COMMAND_GUILD_SCOPE_DESCRIPTION
  }
  if (documentKey === "channelMetadataIds") {
    return CHANNEL_METADATA_SCOPE_DESCRIPTION
  }
  if (documentKey === "inviteCreationChannelIds") {
    return INVITE_CREATION_SCOPE_DESCRIPTION
  }
  if (documentKey === "inviteRoleIds") {
    return INVITE_ROLE_SCOPE_DESCRIPTION
  }
  if (documentKey === "bulkBanGuildIds") {
    return BULK_BAN_SCOPE_DESCRIPTION
  }
  if (documentKey === "bulkMemberRoleGuildIds") {
    return BULK_MEMBER_ROLE_GUILD_SCOPE_DESCRIPTION
  }
  if (documentKey === "bulkMemberRoleIds") {
    return BULK_MEMBER_ROLE_ROLE_SCOPE_DESCRIPTION
  }
  if (documentKey === "guildPruneGuildIds") {
    return GUILD_PRUNE_GUILD_SCOPE_DESCRIPTION
  }
  if (documentKey === "guildPruneIncludeRoleIds") {
    return GUILD_PRUNE_ROLE_SCOPE_DESCRIPTION
  }
  if (documentKey === "webhookMessageChannelIds") {
    return WEBHOOK_MESSAGE_SCOPE_DESCRIPTION
  }
  if (documentKey === "directMessageUserIds") {
    return DIRECT_MESSAGE_USER_SCOPE_DESCRIPTION
  }
  if (documentKey === "embedMessageChannelIds") {
    return EMBED_MESSAGE_SCOPE_DESCRIPTION
  }
  if (documentKey === "memberVerificationGuildIds") {
    return MEMBER_VERIFICATION_GUILD_SCOPE_DESCRIPTION
  }
  if (documentKey === "permissionSyncChannelIds") {
    return PERMISSION_SYNC_SCOPE_DESCRIPTION
  }
  if (documentKey === "soundboardPlaybackChannelIds") {
    return SOUNDBOARD_PLAYBACK_CHANNEL_SCOPE_DESCRIPTION
  }
  if (documentKey === "soundboardPlaybackSourceGuildIds") {
    return SOUNDBOARD_PLAYBACK_SOURCE_GUILD_SCOPE_DESCRIPTION
  }
  return `Exact Discord ID allowlist for ${humanizeConfigKey(documentKey)}`
}

function authoredScopeDescription(name: ConnectorConfigScopeName): string {
  const type = CONFIG_SCOPE_RESOURCE_TYPES[name]
  return type === undefined
    ? scopeDescription(name)
    : `${scopeDescription(name)}; exact ${type} groups may be referenced as @name`
}

function storageDescription(documentKey: string): string {
  if (documentKey === "botProfileRoots") {
    return BOT_PROFILE_ROOT_DESCRIPTION
  }
  if (documentKey === "guildExpressionRoots") {
    return "Owned local roots shared by guild-expression creation and reviewed role-icon images"
  }
  if (documentKey === "inviteCapabilityRoots") {
    return INVITE_CAPABILITY_ROOT_DESCRIPTION
  }
  if (documentKey === "webhookCredentialRoot") {
    return "Canonical process-owned 0700 root for exact-ID webhook credential files with stable 0600 custody"
  }
  return `Owned local roots for ${humanizeConfigKey(documentKey)}`
}

const capabilityShape = Object.fromEntries(
  CONFIG_CAPABILITY_NAMES.map((name) => [
    name,
    z.boolean()
      .describe(capabilityDescription(name))
      .optional(),
  ]),
) as Record<string, z.ZodOptional<z.ZodBoolean>>

const componentLinkOriginSchema = z.string()
  .max(COMPONENT_LINK_LIMITS.urlCharacters)
  .regex(/^https:\/\/[^/?#@\s]+$/u)
  .refine((value) => {
    try {
      canonicalComponentLinkOrigin(value)
      return true
    } catch {
      return false
    }
  }, "must be an exact canonical HTTPS origin without a path, query, fragment, credentials, or trailing slash")

function scopeEntryMaximum(name: ConnectorConfigScopeName): number {
  if (name === "directMessageUserIds") {
    return CONNECTOR_LIMITS.directMessageUserAllowlist
  }
  if (
    name === "applicationEntitlementGuildIds"
    || name === "applicationEntitlementUserIds"
    || name === "applicationSubscriptionUserIds"
    || name === "applicationConsumableEntitlementUserIds"
    || name === "applicationTestEntitlementGuildIds"
    || name === "applicationTestEntitlementUserIds"
  ) {
    return CONNECTOR_LIMITS.applicationMonetizationSubjectAllowlist
  }
  if (
    name === "applicationMonetizationSkuIds"
    || name === "applicationConsumableEntitlementSkuIds"
    || name === "applicationTestEntitlementSkuIds"
  ) {
    return CONNECTOR_LIMITS.applicationMonetizationSkuAllowlist
  }
  if (name === "memberRoleIds" || name === "bulkMemberRoleIds") {
    return CONNECTOR_LIMITS.memberRoleAllowlist
  }
  return CONFIG_SCOPE_ENTRIES
}

const scopeShape = Object.fromEntries(
  CONFIG_SCOPE_NAMES.map((name) => [
    name,
    (name === "componentLinkOrigins"
      ? z.array(componentLinkOriginSchema)
        .max(COMPONENT_LINK_LIMITS.origins)
        .refine(
          (values) => canonicalArray(values),
          "must contain unique origins in canonical order",
        )
      : CONFIG_SCOPE_RESOURCE_TYPES[name] === undefined
        ? snowflakeArraySchema(0, scopeEntryMaximum(name))
        : scopedIdArraySchema(0, scopeEntryMaximum(name)))
      .describe(authoredScopeDescription(name))
      .optional(),
  ]),
) as Record<string, z.ZodOptional<z.ZodType<string[]>>>

const limitShape = Object.fromEntries(
  CONFIG_LIMIT_NAMES.map((name) => [
    name,
    z.number()
      .int()
      .min(name === "mcpReadResponseMaxBytes"
        ? MCP_READ_RESPONSE_LIMITS.minimumBytes
        : 0)
      .max(name === "mcpReadResponseMaxBytes"
        ? MCP_READ_RESPONSE_LIMITS.maximumBytes
        : Number.MAX_SAFE_INTEGER)
      .describe(name === "mcpReadResponseMaxBytes"
        ? "Maximum UTF-8 bytes for one complete redacted MCP read result"
        : `Numeric policy limit for ${humanizeConfigKey(name)}`)
      .optional(),
  ]),
) as Record<string, z.ZodOptional<z.ZodNumber>>

const storageShape = Object.fromEntries(
  CONFIG_STORAGE_NAMES.map((name) => [
    name,
    name === "auditFile" || name === "webhookCredentialRoot"
      ? absolutePathSchema
        .describe(name === "auditFile"
          ? "Absolute path for the content-free activity log"
          : storageDescription(name))
        .optional()
      : rootArraySchema
        .describe(storageDescription(name))
        .optional(),
  ]),
) as Record<string, z.ZodType>

const runtimeShape = Object.fromEntries(
  CONFIG_RUNTIME_NAMES.map((name) => [
    name,
    z.string()
      .min(1)
      .max(CONFIG_STRING_CHARACTERS)
      .describe(`Runtime setting for ${humanizeConfigKey(name)}`)
      .optional(),
  ]),
) as Record<string, z.ZodOptional<z.ZodString>>

const observabilitySignalSchema = z.strictObject({
  compression: z.string().min(1).max(CONFIG_STRING_CHARACTERS)
    .describe("OTLP compression mode")
    .optional(),
  endpoint: z.string().min(1).max(CONFIG_STRING_CHARACTERS)
    .describe("Credential-free absolute OTLP endpoint")
    .optional(),
  headers: headerReferenceSchema.optional(),
  protocol: z.string().min(1).max(CONFIG_STRING_CHARACTERS)
    .describe("OTLP transport protocol")
    .optional(),
  timeoutMs: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
    .describe("OTLP request timeout in milliseconds")
    .optional(),
})

export const CONNECTOR_CONFIG_DOCUMENT_SCHEMA = z.strictObject({
  $schema: z.literal(CONFIG_DOCUMENT_SCHEMA_ID)
    .describe("Editor schema identifier for this configuration format")
    .optional(),
  capabilities: z.strictObject(capabilityShape)
    .describe("Explicit capability gates; omitted gates remain disabled")
    .default({}),
  credential: credentialReferenceSchema,
  gateway: z.strictObject({
    enabled: z.boolean().describe("Enable the optional privacy-safe Discord Gateway client"),
    eventBufferSize: z.number().int().min(1).max(CONNECTOR_LIMITS.gatewayEventBufferSize)
      .describe("Maximum bounded Gateway event buffer size"),
  }).describe("Optional Discord Gateway policy"),
  groups: scopeGroupsSchema
    .describe("Reusable typed aliases whose members are exact Discord IDs")
    .optional(),
  identity: z.strictObject({
    applicationId: snowflakeSchema.describe("Expected Discord application identity"),
    botId: snowflakeSchema.describe("Expected Discord bot user identity"),
  }).describe("Pinned Discord application and bot identity"),
  limits: z.strictObject(limitShape)
    .describe("Optional numeric policy limits")
    .default({}),
  name: configNameSchema.describe("Bounded lowercase identifier for this policy"),
  notifications: z.strictObject({
    userMentions: z.enum(CONFIG_USER_MENTION_MODES)
      .describe("User notification policy: disabled, exact allowlist, or signed interactive review")
      .optional(),
  }).describe("Discord notification behavior").optional(),
  observability: z.strictObject({
    compression: z.string().min(1).max(CONFIG_STRING_CHARACTERS)
      .describe("Common OTLP compression mode")
      .optional(),
    endpoint: z.string().min(1).max(CONFIG_STRING_CHARACTERS)
      .describe("Common credential-free absolute OTLP endpoint")
      .optional(),
    exportEnabled: z.boolean().describe("Enable OTLP export").optional(),
    headers: headerReferenceSchema.optional(),
    jsonLogsEnabled: z.boolean().describe("Enable content-free JSON operational logs").optional(),
    metrics: observabilitySignalSchema.optional(),
    protocol: z.string().min(1).max(CONFIG_STRING_CHARACTERS)
      .describe("Common OTLP transport protocol")
      .optional(),
    serviceName: z.string().min(1).max(CONFIG_STRING_CHARACTERS)
      .describe("Bounded non-identifying telemetry service name")
      .optional(),
    timeoutMs: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
      .describe("Common OTLP request timeout in milliseconds")
      .optional(),
    traceSampleRatio: z.number().min(0).max(1)
      .describe("Trace sampling ratio")
      .optional(),
    traceSampler: z.string().min(1).max(CONFIG_STRING_CHARACTERS)
      .describe("Trace sampler name")
      .optional(),
    traces: observabilitySignalSchema.optional(),
  }).describe("Optional content-free local and OTLP observability policy").default({}),
  readScope: z.strictObject({
    channelMode: z.enum(CONFIG_READ_SCOPE_MODES)
      .describe("Whether channel reads use exact IDs or all visible channels inside guild scope")
      .optional(),
    channelIds: scopedIdArraySchema(0, DISCORD_LIMITS.searchChannelIds)
      .describe("Optional exact channel IDs and channel-group references inside the guild boundary"),
    guildMode: z.enum(CONFIG_READ_SCOPE_MODES)
      .describe("Whether guild reads use exact IDs or every guild visible to the bot")
      .optional(),
    guildIds: scopedIdArraySchema(0, DISCORD_LIMITS.currentUserGuilds)
      .describe("Exact guild IDs and guild-group references forming the outer read boundary"),
  }).describe("Required outer Discord read boundary"),
  runtime: z.strictObject(runtimeShape)
    .describe("Optional non-secret runtime settings")
    .default({}),
  schemaVersion: z.literal(CONFIG_DOCUMENT_SCHEMA_VERSION)
    .describe("Configuration format version"),
  scopes: z.strictObject(scopeShape)
    .describe("Exact per-feature Discord ID, compatible typed-group, and HTTPS origin allowlists")
    .default({}),
  storage: z.strictObject(storageShape)
    .describe("Local content-free activity and owned-file paths")
    .default({}),
  threads: z.strictObject({
    messageWrites: z.enum(CONFIG_THREAD_SCOPE_MODES)
      .describe("Whether message-class write scopes may inherit an exact parent channel")
      .optional(),
    reads: z.enum(CONFIG_THREAD_SCOPE_MODES)
      .describe("Whether an exact parent channel read scope includes its child threads")
      .optional(),
  }).describe("Controlled child-thread scope inheritance").optional(),
  tools: z.strictObject({
    surface: z.enum(MCP_TOOL_SURFACES).describe("MCP tool discovery surface"),
    toolsets: z.array(z.enum(MCP_TOOLSET_NAMES))
      .min(1)
      .max(MCP_TOOLSET_NAMES.length)
      .refine(
        (values) => canonicalArray(values, MCP_TOOLSET_NAMES),
        "must contain unique toolsets in canonical order",
      )
      .describe("Canonical MCP toolset selection"),
  }).describe("Advertised MCP tool surface"),
}).meta({
  description: "Strict non-secret configuration for guildcontrol",
  // Keep the root inline; connectorConfigJsonSchema adds the public $id
  title: "guildcontrol configuration",
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function issuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "$"
  return path.reduce<string>((result, entry) => (
    typeof entry === "number"
      ? `${result}[${entry}]`
      : `${result}.${String(entry)}`
  ), "$")
}

function schemaError(
  error: z.ZodError,
  prefix: readonly PropertyKey[] = [],
): ConfigDocumentError {
  const issue = error.issues[0]
  if (!issue) return new ConfigDocumentError("Configuration document is invalid")
  return new ConfigDocumentError(
    `Configuration document ${issuePath([...prefix, ...issue.path])} ${issue.message}`,
    { cause: error },
  )
}

function parseConnectorCredentialReference(
  value: unknown,
): ConnectorCredentialReference {
  const result = credentialReferenceSchema.safeParse(value)
  if (!result.success) throw schemaError(result.error, ["credential"])
  return result.data
}

export function normalizeConfigName(value: string): string {
  const result = configNameSchema.safeParse(value.trim())
  if (!result.success) throw schemaError(result.error)
  return result.data
}

function environmentSecretReferences(document: ConnectorConfigDocument): readonly {
  path: string
  reference: EnvironmentSecretReference
}[] {
  const result: {
    path: string
    reference: EnvironmentSecretReference
  }[] = []
  if (document.credential.provider === "environment") result.push({
    path: "$.credential",
    reference: document.credential,
  })
  const common = document.observability.headers
  const traces = document.observability.traces?.headers
  const metrics = document.observability.metrics?.headers
  if (common) result.push({
    path: "$.observability.headers",
    reference: common,
  })
  if (traces) result.push({
    path: "$.observability.traces.headers",
    reference: traces,
  })
  if (metrics) result.push({
    path: "$.observability.metrics.headers",
    reference: metrics,
  })
  return result
}

export function connectorConfigSecretEnvironmentNames(
  document: ConnectorConfigDocument,
): readonly string[] {
  return Object.freeze([
    ...new Set(environmentSecretReferences(parseConnectorConfigDocument(document))
      .map((entry) => entry.reference.variable)),
  ])
}

export function connectorConfigSecretFilePaths(
  document: ConnectorConfigDocument,
): readonly string[] {
  const parsed = parseConnectorConfigDocument(document)
  return Object.freeze(parsed.credential.provider === "file"
    ? [parsed.credential.path]
    : [])
}

function referencedScopeGroupName(value: string): string | undefined {
  return value.startsWith("@") ? value.slice(1) : undefined
}

function scopeGroupDefinitionPath(
  document: ConnectorConfigDocument,
  name: string,
): string | undefined {
  for (const type of CONFIG_SCOPE_GROUP_TYPES) {
    const groups = document.groups[type]
    if (groups && Object.hasOwn(groups, name)) {
      return `$.groups.${type}[${JSON.stringify(name)}]`
    }
  }
  return undefined
}

function scopeGroupValues(
  document: ConnectorConfigDocument,
  type: ConnectorConfigScopeGroupType,
  name: string,
): readonly string[] | undefined {
  const groups = document.groups[type]
  return groups && Object.hasOwn(groups, name) ? groups[name] : undefined
}

export function expandConnectorConfigIdEntries(
  document: ConnectorConfigDocument,
  type: ConnectorConfigScopeGroupType,
  entries: readonly string[],
  path: string,
  maximum: number,
): readonly string[] {
  const expanded: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const groupName = referencedScopeGroupName(entry)
    const values = groupName === undefined
      ? [entry]
      : scopeGroupValues(document, type, groupName)
    if (groupName !== undefined && values === undefined) {
      const definedAt = scopeGroupDefinitionPath(document, groupName)
      throw new ConfigDocumentError(definedAt === undefined
        ? `Configuration document ${path} references unknown ${type} group @${groupName}`
        : `Configuration document ${path} references @${groupName} as ${type}, but it is defined at ${definedAt}`)
    }
    for (const value of values || []) {
      if (seen.has(value)) {
        throw new ConfigDocumentError(
          `Configuration document ${path} expands to duplicate Discord ID ${value}`,
        )
      }
      seen.add(value)
      expanded.push(value)
      if (expanded.length > maximum) {
        throw new ConfigDocumentError(
          `Configuration document ${path} must contain at most ${maximum} unique IDs after group expansion`,
        )
      }
    }
  }
  return Object.freeze(expanded.sort())
}

export function expandedConnectorReadScope(
  document: ConnectorConfigDocument,
): Readonly<{
  channelIds: readonly string[]
  guildIds: readonly string[]
}> {
  return Object.freeze({
    channelIds: expandConnectorConfigIdEntries(
      document,
      "channels",
      document.readScope.channelIds,
      "$.readScope.channelIds",
      DISCORD_LIMITS.searchChannelIds,
    ),
    guildIds: expandConnectorConfigIdEntries(
      document,
      "guilds",
      document.readScope.guildIds,
      "$.readScope.guildIds",
      DISCORD_LIMITS.currentUserGuilds,
    ),
  })
}

export function expandedConnectorScope(
  document: ConnectorConfigDocument,
  name: ConnectorConfigScopeName,
  maximum = scopeEntryMaximum(name),
): readonly string[] {
  const entries = document.scopes[name] ?? []
  const type = CONFIG_SCOPE_RESOURCE_TYPES[name]
  if (type === undefined) return Object.freeze([...entries])
  return expandConnectorConfigIdEntries(
    document,
    type,
    entries,
    `$.scopes.${name}`,
    maximum,
  )
}

function validateConnectorConfigScopeGroups(document: ConnectorConfigDocument): void {
  expandedConnectorReadScope(document)
  for (const name of CONFIG_SCOPE_NAMES) expandedConnectorScope(document, name)
}

export function parseConnectorConfigDocument(
  value: unknown,
  expectedName?: string,
): ConnectorConfigDocument {
  if (isRecord(value) && value.schemaVersion !== CONFIG_DOCUMENT_SCHEMA_VERSION) {
    throw new ConfigDocumentError(
      `Unsupported configuration schema version: ${String(value.schemaVersion)}`,
    )
  }
  const result = CONNECTOR_CONFIG_DOCUMENT_SCHEMA.safeParse(value)
  if (!result.success) throw schemaError(result.error)
  const parsed = result.data
  const channelMode = parsed.readScope.channelMode
    ?? (parsed.readScope.channelIds.length > 0 ? "allowlist" : "all-visible")
  const guildMode = parsed.readScope.guildMode
    ?? (parsed.readScope.guildIds.length > 0 ? "allowlist" : "all-visible")
  const document = {
    ...parsed,
    groups: parsed.groups ?? {},
    notifications: {
      userMentions: parsed.notifications?.userMentions ?? "allowlist",
    },
    readScope: {
      channelIds: parsed.readScope.channelIds,
      channelMode,
      guildIds: parsed.readScope.guildIds,
      guildMode,
    },
    threads: {
      messageWrites: parsed.threads?.messageWrites ?? "exact",
      reads: parsed.threads?.reads ?? "inherit",
    },
  } as ConnectorConfigDocument
  const expandedReadScope = expandedConnectorReadScope(document)
  if (channelMode === "allowlist" && expandedReadScope.channelIds.length === 0) {
    throw new ConfigDocumentError(
      "Configuration document $.readScope.channelMode allowlist requires at least one channel ID",
    )
  }
  if (channelMode === "all-visible" && parsed.readScope.channelIds.length > 0) {
    throw new ConfigDocumentError(
      "Configuration document $.readScope.channelIds must be empty when channelMode is all-visible",
    )
  }
  if (guildMode === "allowlist" && expandedReadScope.guildIds.length === 0) {
    throw new ConfigDocumentError(
      "Configuration document $.readScope.guildMode allowlist requires at least one guild ID",
    )
  }
  if (guildMode === "all-visible" && parsed.readScope.guildIds.length > 0) {
    throw new ConfigDocumentError(
      "Configuration document $.readScope.guildIds must be empty when guildMode is all-visible",
    )
  }
  validateConnectorConfigScopeGroups(document)
  if (expectedName !== undefined && document.name !== normalizeConfigName(expectedName)) {
    throw new ConfigDocumentError("Configuration name does not match its filename")
  }
  return document
}

export function createConnectorConfigDocument(options: {
  applicationId: string
  botId: string
  capabilities?: ConnectorConfigDocument["capabilities"]
  channelIds?: readonly string[]
  credentialFile?: string
  credentialVariable?: string
  gatewayEnabled?: boolean
  gatewayEventBufferSize?: number
  groups?: ConnectorConfigDocumentScopeGroups
  guildIds: readonly string[]
  limits?: ConnectorConfigDocument["limits"]
  name: string
  observability?: ConnectorConfigDocumentObservability
  readChannelMode?: ConnectorConfigReadScopeMode
  readGuildMode?: ConnectorConfigReadScopeMode
  runtime?: ConnectorConfigDocument["runtime"]
  scopes?: ConnectorConfigDocument["scopes"]
  storage?: ConnectorConfigDocumentStorage
  threadMessageWriteMode?: ConnectorConfigThreadScopeMode
  threadReadMode?: ConnectorConfigThreadScopeMode
  toolsets: readonly McpToolsetName[]
  toolSurface: McpToolSurface
  userMentionMode?: ConnectorConfigUserMentionMode
}): ConnectorConfigDocument {
  if (options.credentialFile !== undefined && options.credentialVariable !== undefined) {
    throw new ConfigDocumentError(
      "Configuration credential file and environment variable are mutually exclusive",
    )
  }
  return parseConnectorConfigDocument({
    $schema: CONFIG_DOCUMENT_SCHEMA_ID,
    capabilities: options.capabilities ?? {},
    credential: options.credentialFile === undefined
      ? {
          provider: "environment",
          variable: options.credentialVariable ?? DEFAULT_TOKEN_ENVIRONMENT_VARIABLE,
        }
      : {
          path: options.credentialFile,
          provider: "file",
        },
    gateway: {
      enabled: options.gatewayEnabled ?? false,
      eventBufferSize: options.gatewayEventBufferSize ?? GATEWAY_DEFAULTS.eventBufferSize,
    },
    groups: options.groups ?? {},
    identity: {
      applicationId: options.applicationId,
      botId: options.botId,
    },
    limits: options.limits ?? {},
    name: options.name,
    notifications: {
      userMentions: options.userMentionMode
        ?? ((options.scopes?.mentionUserIds?.length ?? 0) > 0
          ? "allowlist"
          : "disabled"),
    },
    observability: options.observability ?? {},
    readScope: {
      channelMode: options.readChannelMode
        ?? ((options.channelIds?.length ?? 0) > 0 ? "allowlist" : "all-visible"),
      channelIds: [...(options.channelIds ?? [])].sort(),
      guildMode: options.readGuildMode ?? "allowlist",
      guildIds: [...options.guildIds].sort(),
    },
    runtime: options.runtime ?? {},
    schemaVersion: CONFIG_DOCUMENT_SCHEMA_VERSION,
    scopes: options.scopes ?? {},
    storage: options.storage ?? {},
    threads: {
      messageWrites: options.threadMessageWriteMode ?? "exact",
      reads: options.threadReadMode ?? "inherit",
    },
    tools: {
      surface: options.toolSurface,
      toolsets: MCP_TOOLSET_NAMES.filter((entry) => options.toolsets.includes(entry)),
    },
  })
}

class JsonCursor {
  readonly #text: string
  #index = 0

  constructor(text: string) {
    this.#text = text
  }

  assertNoDuplicateKeys(): void {
    this.#skipWhitespace()
    this.#value(0, "$")
    this.#skipWhitespace()
    if (this.#index !== this.#text.length) this.#invalid()
  }

  #invalid(message = "Configuration file is not valid JSON"): never {
    throw new ConfigDocumentError(message)
  }

  #skipWhitespace(): void {
    while (/\s/.test(this.#text[this.#index] || "")) this.#index += 1
  }

  #string(): string {
    if (this.#text[this.#index] !== "\"") this.#invalid()
    const start = this.#index
    this.#index += 1
    let escaped = false
    while (this.#index < this.#text.length) {
      const character = this.#text[this.#index]
      this.#index += 1
      if (escaped) {
        escaped = false
        continue
      }
      if (character === "\\") {
        escaped = true
        continue
      }
      if (character === "\"") {
        const raw = this.#text.slice(start, this.#index)
        try {
          return JSON.parse(raw) as string
        } catch (error) {
          throw new ConfigDocumentError("Configuration file is not valid JSON", {
            cause: error,
          })
        }
      }
      if (character !== undefined && character.charCodeAt(0) < 0x20) this.#invalid()
    }
    this.#invalid()
  }

  #value(depth: number, path: string): void {
    if (depth > CONFIG_JSON_MAX_DEPTH) {
      this.#invalid("Configuration file exceeds the maximum JSON nesting depth")
    }
    this.#skipWhitespace()
    const character = this.#text[this.#index]
    if (character === "{") return this.#object(depth, path)
    if (character === "[") return this.#array(depth, path)
    if (character === "\"") {
      this.#string()
      return
    }
    const remainder = this.#text.slice(this.#index)
    const token = remainder.match(/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/)?.[0]
    if (!token) this.#invalid()
    this.#index += token.length
  }

  #object(depth: number, path: string): void {
    this.#index += 1
    this.#skipWhitespace()
    if (this.#text[this.#index] === "}") {
      this.#index += 1
      return
    }
    const keys = new Set<string>()
    while (true) {
      const key = this.#string()
      if (keys.has(key)) {
        throw new ConfigDocumentError(
          `Configuration file contains duplicate object key at ${path}.${key}`,
        )
      }
      keys.add(key)
      this.#skipWhitespace()
      if (this.#text[this.#index] !== ":") this.#invalid()
      this.#index += 1
      this.#value(depth + 1, `${path}.${key}`)
      this.#skipWhitespace()
      const separator = this.#text[this.#index]
      if (separator === "}") {
        this.#index += 1
        return
      }
      if (separator !== ",") this.#invalid()
      this.#index += 1
      this.#skipWhitespace()
    }
  }

  #array(depth: number, path: string): void {
    this.#index += 1
    this.#skipWhitespace()
    if (this.#text[this.#index] === "]") {
      this.#index += 1
      return
    }
    let index = 0
    while (true) {
      this.#value(depth + 1, `${path}[${index}]`)
      index += 1
      this.#skipWhitespace()
      const separator = this.#text[this.#index]
      if (separator === "]") {
        this.#index += 1
        return
      }
      if (separator !== ",") this.#invalid()
      this.#index += 1
      this.#skipWhitespace()
    }
  }
}

export function parseStrictConfigJson(text: string): unknown {
  if (!text.endsWith("\n") || text.includes("\0")) {
    throw new ConfigDocumentError(
      "Configuration file must contain one complete newline-terminated JSON document",
    )
  }
  new JsonCursor(text).assertNoDuplicateKeys()
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    if (error instanceof ConfigDocumentError) throw error
    throw new ConfigDocumentError("Configuration file is not valid JSON", { cause: error })
  }
}

export function parseConnectorConfigJson(text: string): ConnectorConfigDocument {
  return parseConnectorConfigDocument(parseStrictConfigJson(text))
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code
}

function assertConfigDocumentFileMetadata(
  metadata: BigIntStats,
  options: {
    platform: NodeJS.Platform
    processUserId: number | undefined
  },
): void {
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink < 1n
    || metadata.size < 3n
    || metadata.size > BigInt(CONNECTOR_LIMITS.configBytes)
    || (
      options.platform !== "win32"
      && (
        options.processUserId === undefined
        || ![0n, BigInt(options.processUserId)].includes(metadata.uid)
        || (metadata.mode & 0o022n) !== 0n
      )
    )
  ) {
    throw new ConfigDocumentError(
      "Configuration file target must be a bounded regular file owned by the process user or root with no group or world write access",
    )
  }
}

export function inspectConnectorConfigDocumentFile(
  file: string,
  options: {
    platform?: NodeJS.Platform
    processUserId?: number
  } = {},
): ConnectorConfigDocumentFileInspection {
  const normalized = file.trim()
  if (
    !normalized
    || normalized.includes("\0")
    || !isAbsolute(normalized)
    || resolve(normalized) !== normalized
  ) {
    throw new ConfigDocumentError("Configuration file path must be absolute and canonical")
  }
  const platform = options.platform ?? process.platform
  const processUserId = options.processUserId
    ?? (typeof process.getuid === "function" ? process.getuid() : undefined)
  let handle: number | undefined
  try {
    const parent = dirname(normalized)
    if (realpathSync.native(parent) !== parent) {
      throw new ConfigDocumentError(
        "Configuration file path may use only one explicit final symlink",
      )
    }
    const beforeLink = lstatSync(normalized, { bigint: true })
    if (!beforeLink.isFile() && !beforeLink.isSymbolicLink()) {
      throw new ConfigDocumentError(
        "Configuration file path must name a regular file or one explicit symlink",
      )
    }
    const canonical = realpathSync.native(normalized)
    const symbolicLink = beforeLink.isSymbolicLink()
    if (!symbolicLink && canonical !== normalized) {
      throw new ConfigDocumentError(
        "Configuration file path may use only one explicit final symlink",
      )
    }
    const beforeTarget = lstatSync(canonical, { bigint: true })
    assertConfigDocumentFileMetadata(beforeTarget, { platform, processUserId })
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
      ? fsConstants.O_NOFOLLOW
      : 0
    handle = openSync(canonical, fsConstants.O_RDONLY | noFollow)
    const beforeRead = fstatSync(handle, { bigint: true })
    assertConfigDocumentFileMetadata(beforeRead, { platform, processUserId })
    if (
      beforeTarget.dev !== beforeRead.dev
      || beforeTarget.ino !== beforeRead.ino
    ) {
      throw new ConfigDocumentError(
        "Configuration file target changed while it was opened",
      )
    }
    const bytes = readBoundedFileBytes(handle, Number(beforeRead.size))
    const afterRead = fstatSync(handle, { bigint: true })
    const afterTarget = lstatSync(canonical, { bigint: true })
    const afterLink = lstatSync(normalized, { bigint: true })
    const finalCanonical = realpathSync.native(normalized)
    if (
      bytes.byteLength !== Number(beforeRead.size)
      || !sameStableFileMetadata(beforeRead, afterRead)
      || !sameStableFileMetadata(afterRead, afterTarget)
      || !sameStableFileMetadata(beforeLink, afterLink)
      || finalCanonical !== canonical
    ) {
      throw new ConfigDocumentError(
        "Configuration file target changed while it was read",
      )
    }
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch (error) {
      throw new ConfigDocumentError(
        "Configuration file must contain valid UTF-8",
        { cause: error },
      )
    }
    return Object.freeze({
      document: parseConnectorConfigJson(text),
      file: normalized,
      hardLinkCount: Number(afterRead.nlink),
      symbolicLink,
      targetFile: canonical,
    })
  } catch (error) {
    if (error instanceof ConfigDocumentError) throw error
    const message = isNodeError(error, "ENOENT")
      ? "Configuration file was not found"
      : "Unable to inspect or read configuration file"
    throw new ConfigDocumentError(message, { cause: error })
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}

export function loadConnectorConfigDocumentFile(
  file: string,
  options: {
    platform?: NodeJS.Platform
    processUserId?: number
  } = {},
): ConnectorConfigDocument {
  return inspectConnectorConfigDocumentFile(file, options).document
}

function nonEmptyEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = environment[name]?.trim()
  return value ? value : undefined
}

function sameStableFileMetadata(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.ctimeNs === right.ctimeNs
    && left.mtimeNs === right.mtimeNs
}

function assertCredentialFileMetadata(
  metadata: BigIntStats,
  options: {
    platform: NodeJS.Platform
    processUserId: number | undefined
  },
): void {
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1n
    || metadata.size < 1n
    || metadata.size > BigInt(CONNECTOR_LIMITS.credentialFileBytes)
    || (
      options.platform !== "win32"
      && (
        options.processUserId === undefined
        || ![0n, BigInt(options.processUserId)].includes(metadata.uid)
        || (metadata.mode & 0o022n) !== 0n
      )
    )
  ) {
    throw new ConfigDocumentError(
      "Configuration credential file must be a bounded regular file owned by the process user or root with one hard link and no group or world write access",
    )
  }
}

function readBoundedFileBytes(
  handle: number,
  expectedBytes: number,
): Buffer {
  const buffer = Buffer.allocUnsafe(
    expectedBytes + FILE_OVERFLOW_PROBE_BYTES,
  )
  let offset = 0
  while (offset < buffer.byteLength) {
    const bytesRead = readSync(
      handle,
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    )
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return buffer.subarray(0, offset)
}

export function loadConnectorCredentialFile(
  file: string,
  options: {
    platform?: NodeJS.Platform
    processUserId?: number
  } = {},
): string {
  const reference = parseConnectorCredentialReference({ path: file, provider: "file" })
  if (reference.provider !== "file") {
    throw new ConfigDocumentError("Configuration credential file reference is invalid")
  }
  const platform = options.platform ?? process.platform
  const processUserId = options.processUserId
    ?? (typeof process.getuid === "function" ? process.getuid() : undefined)
  let handle: number | undefined
  try {
    const canonical = realpathSync.native(reference.path)
    const beforePath = lstatSync(canonical, { bigint: true })
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
      ? fsConstants.O_NOFOLLOW
      : 0
    handle = openSync(canonical, fsConstants.O_RDONLY | noFollow)
    const beforeRead = fstatSync(handle, { bigint: true })
    assertCredentialFileMetadata(beforePath, { platform, processUserId })
    assertCredentialFileMetadata(beforeRead, { platform, processUserId })
    if (
      beforePath.dev !== beforeRead.dev
      || beforePath.ino !== beforeRead.ino
    ) {
      throw new ConfigDocumentError(
        "Configuration credential file changed while it was opened",
      )
    }
    const bytes = readBoundedFileBytes(handle, Number(beforeRead.size))
    const afterRead = fstatSync(handle, { bigint: true })
    const afterPath = lstatSync(canonical, { bigint: true })
    const finalCanonical = realpathSync.native(reference.path)
    if (
      bytes.byteLength !== Number(beforeRead.size)
      || !sameStableFileMetadata(beforeRead, afterRead)
      || !sameStableFileMetadata(afterRead, afterPath)
      || finalCanonical !== canonical
    ) {
      throw new ConfigDocumentError(
        "Configuration credential file changed while it was read",
      )
    }
    let token: string
    try {
      token = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim()
    } catch (error) {
      throw new ConfigDocumentError(
        "Configuration credential file must contain valid UTF-8",
        { cause: error },
      )
    }
    if (!token || /[\u0000-\u001f\u007f]/u.test(token)) {
      throw new ConfigDocumentError(
        "Configuration credential file must contain one non-empty token without control characters",
      )
    }
    return token
  } catch (error) {
    if (error instanceof ConfigDocumentError) throw error
    if (isNodeError(error, "ENOENT")) {
      throw new CredentialUnavailableError("file", reference.path, {
        cause: error,
      })
    }
    throw new ConfigDocumentError(
      "Unable to inspect or read configuration credential file",
      { cause: error },
    )
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}

export function resolveConnectorCredential(
  referenceValue: ConnectorCredentialReference,
  source: NodeJS.ProcessEnv,
): string {
  const reference = parseConnectorCredentialReference(referenceValue)
  if (reference.provider === "file") {
    return loadConnectorCredentialFile(reference.path)
  }
  const value = nonEmptyEnvironmentValue(source, reference.variable)
  if (!value) {
    throw new CredentialUnavailableError("environment", reference.variable)
  }
  return value
}

export function connectorConfigJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(CONNECTOR_CONFIG_DOCUMENT_SCHEMA, {
    target: "draft-2020-12",
  }) as Record<string, unknown>
  return {
    ...schema,
    $id: CONFIG_DOCUMENT_SCHEMA_ID,
    description: "Strict non-secret configuration for guildcontrol",
    title: "guildcontrol configuration",
  }
}

export function connectorConfigFields(): readonly ConfigDocumentField[] {
  return Object.freeze([
    {
      defaultValue: undefined,
      description: "Editor schema identifier for this configuration format",
      kind: "string",
      path: "$.$schema",
      required: false,
    },
    {
      defaultValue: CONFIG_DOCUMENT_SCHEMA_VERSION,
      description: "Configuration format version",
      kind: "integer",
      path: "$.schemaVersion",
      required: true,
    },
    {
      defaultValue: undefined,
      description: "Bounded lowercase identifier for this policy",
      kind: "string",
      path: "$.name",
      required: true,
    },
    {
      defaultValue: undefined,
      description: "Environment or bounded file reference for the Discord bot token",
      kind: "secret-reference",
      path: "$.credential",
      required: true,
    },
    ...([
      "$.identity.applicationId",
      "$.identity.botId",
    ] as const).map((path) => ({
      defaultValue: undefined,
      description: path.endsWith("applicationId")
        ? "Expected Discord application identity"
        : "Expected Discord bot user identity",
      kind: "snowflake" as const,
      path,
      required: true,
    })),
    ...CONFIG_SCOPE_GROUP_TYPES.map((type) => ({
      defaultValue: {},
      description: `Named ${type} groups whose members are exact Discord IDs`,
      kind: "group-map" as const,
      path: `$.groups.${type}`,
      required: false,
    })),
    ...([
      ["$.readScope.guildMode", "allowlist"],
      ["$.readScope.guildIds", undefined],
      ["$.readScope.channelMode", "all-visible"],
      ["$.readScope.channelIds", []],
    ] as const).map(([path, defaultValue]) => ({
      defaultValue,
      description: path.endsWith("guildMode")
        ? "Whether guild reads use exact IDs or every guild visible to the bot"
        : path.endsWith("channelMode")
          ? "Whether channel reads use exact IDs or all visible channels inside guild scope"
          : path.endsWith("guildIds")
            ? "Exact guild allowlist forming the outer read boundary"
            : "Optional exact channel allowlist inside the guild boundary",
      kind: (path.endsWith("Mode") ? "string" : "scope-entries") as "scope-entries" | "string",
      path,
      required: true,
    })),
    {
      defaultValue: "disabled",
      description: "User notification policy: disabled, exact allowlist, or signed interactive review",
      kind: "string",
      path: "$.notifications.userMentions",
      required: true,
    },
    {
      defaultValue: "inherit",
      description: "Whether an exact parent channel read scope includes its child threads",
      kind: "string",
      path: "$.threads.reads",
      required: true,
    },
    {
      defaultValue: "exact",
      description: "Whether message-class write scopes may inherit an exact parent channel",
      kind: "string",
      path: "$.threads.messageWrites",
      required: true,
    },
    {
      defaultValue: "progressive",
      description: "MCP tool discovery surface",
      kind: "string",
      path: "$.tools.surface",
      required: true,
    },
    {
      defaultValue: undefined,
      description: "Canonical MCP toolset selection",
      kind: "strings",
      path: "$.tools.toolsets",
      required: true,
    },
    {
      defaultValue: false,
      description: "Enable the optional privacy-safe Discord Gateway client",
      kind: "boolean",
      path: "$.gateway.enabled",
      required: true,
    },
    {
      defaultValue: GATEWAY_DEFAULTS.eventBufferSize,
      description: "Maximum bounded Gateway event buffer size",
      kind: "integer",
      path: "$.gateway.eventBufferSize",
      required: true,
    },
    ...CONFIG_CAPABILITY_NAMES.map((name) => ({
      defaultValue: false,
      description: capabilityDescription(name),
      kind: "boolean" as const,
      path: `$.capabilities.${name}`,
      required: false,
    })),
    ...CONFIG_SCOPE_NAMES.map((name) => ({
      defaultValue: [],
      description: authoredScopeDescription(name),
      kind: name === "componentLinkOrigins"
        ? "strings" as const
        : CONFIG_SCOPE_RESOURCE_TYPES[name] === undefined
          ? "snowflakes" as const
          : "scope-entries" as const,
      path: `$.scopes.${name}`,
      required: false,
    })),
    ...CONFIG_LIMIT_NAMES.map((name) => ({
      defaultValue: name === "mcpReadResponseMaxBytes"
        ? MCP_READ_RESPONSE_DEFAULTS.maxBytes
        : undefined,
      description: name === "mcpReadResponseMaxBytes"
        ? "Maximum UTF-8 bytes for one complete redacted MCP read result"
        : `Numeric policy limit for ${humanizeConfigKey(name)}`,
      kind: "integer" as const,
      path: `$.limits.${name}`,
      required: false,
    })),
    ...CONFIG_STORAGE_NAMES.map((name) => ({
      defaultValue: name === "auditFile" || name === "webhookCredentialRoot"
        ? undefined
        : [],
      description: name === "auditFile"
        ? "Absolute path for the content-free activity log"
        : storageDescription(name),
      kind: (name === "auditFile" || name === "webhookCredentialRoot"
        ? "path"
        : "paths") as "path" | "paths",
      path: `$.storage.${name}`,
      required: false,
    })),
    ...CONFIG_RUNTIME_NAMES.map((name) => ({
      defaultValue: undefined,
      description: `Runtime setting for ${humanizeConfigKey(name)}`,
      kind: "string" as const,
      path: `$.runtime.${name}`,
      required: false,
    })),
    ...([
      ["$.observability.compression", "string"],
      ["$.observability.endpoint", "string"],
      ["$.observability.exportEnabled", "boolean"],
      ["$.observability.headers", "secret-reference"],
      ["$.observability.jsonLogsEnabled", "boolean"],
      ["$.observability.metrics.compression", "string"],
      ["$.observability.metrics.endpoint", "string"],
      ["$.observability.metrics.headers", "secret-reference"],
      ["$.observability.metrics.protocol", "string"],
      ["$.observability.metrics.timeoutMs", "number"],
      ["$.observability.protocol", "string"],
      ["$.observability.serviceName", "string"],
      ["$.observability.timeoutMs", "number"],
      ["$.observability.traceSampleRatio", "number"],
      ["$.observability.traceSampler", "string"],
      ["$.observability.traces.compression", "string"],
      ["$.observability.traces.endpoint", "string"],
      ["$.observability.traces.headers", "secret-reference"],
      ["$.observability.traces.protocol", "string"],
      ["$.observability.traces.timeoutMs", "number"],
    ] as const).map(([path, kind]) => ({
      defaultValue: undefined,
      description: `Observability setting for ${humanizeConfigKey(path.split(".").at(-1) || path)}`,
      kind,
      path,
      required: false,
    })),
  ])
}
