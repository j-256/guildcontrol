export const CONNECTOR_NAME = "guildcontrol"
export const CONNECTOR_TITLE = "GuildControl MCP"
export const CONNECTOR_VERSION = "2.3.0"
export const CONNECTOR_NPM_PACKAGE = "guildctl"
export const CONNECTOR_CLI_COMMAND = "guildctl"
export const CONNECTOR_NPX_COMMAND = "npx"
export const CONNECTOR_NPX_ARGUMENTS = Object.freeze([
  "--yes",
  `${CONNECTOR_NPM_PACKAGE}@${CONNECTOR_VERSION}`,
] as const)
export const CONNECTOR_DESCRIPTION = "Safety-first MCP server for Discord with privacy-safe reads, audits, and reviewed administration"
export const CONNECTOR_WEBSITE_URL = "https://docs.guildcontrol.lasers.app"
export const CONNECTOR_ICON_URL = `https://raw.githubusercontent.com/j-256/guildcontrol/v${CONNECTOR_VERSION}/assets/guildcontrol-icon.png`
export const CONNECTOR_ICON_MIME_TYPE = "image/png"
export const CONNECTOR_ICON_SIZES = Object.freeze(["1254x1254"] as const)
export const SCHEMA_VERSION = 1

export const DISCORD_API_BASE_URL = "https://discord.com/api/v10"
export const DISCORD_WEB_BASE_URL = "https://discord.com"
export const DISCORD_USER_AGENT = `DiscordBot (guildcontrol, ${CONNECTOR_VERSION})`
export const DISCORD_SNOWFLAKE_PATTERN = /^[0-9]{1,20}$/
export const DISCORD_SNOWFLAKE_MAX = 18_446_744_073_709_551_615n
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
export const GUILD_SCAFFOLD_SYMBOL_PATTERN = /^[a-z][a-z0-9_-]*$/
export const CONTENT_FREE_ERROR_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/
export const CONTENT_FREE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export const DISCORD_LOCALES = Object.freeze([
  "id",
  "da",
  "de",
  "en-GB",
  "en-US",
  "es-ES",
  "es-419",
  "fr",
  "hr",
  "it",
  "lt",
  "hu",
  "nl",
  "no",
  "pl",
  "pt-BR",
  "ro",
  "fi",
  "sv-SE",
  "vi",
  "tr",
  "cs",
  "el",
  "bg",
  "ru",
  "uk",
  "hi",
  "th",
  "zh-CN",
  "ja",
  "zh-TW",
  "ko",
] as const)

export type DiscordLocale = typeof DISCORD_LOCALES[number]

export const MCP_DISCOVERY_TOOL_NAME = "discover_discord_tools"
export const MCP_DOCUMENTATION_SEARCH_TOOL_NAME = "search_guildcontrol_docs"
export const MCP_ALWAYS_AVAILABLE_TOOL_NAMES = Object.freeze([
  MCP_DISCOVERY_TOOL_NAME,
  MCP_DOCUMENTATION_SEARCH_TOOL_NAME,
] as const)

export const MCP_TOOL_SURFACES = [
  "full",
  "progressive",
] as const

export type McpToolSurface = typeof MCP_TOOL_SURFACES[number]

export const MCP_TOOLSET_NAMES = [
  "activity",
  "application-commands",
  "application-emojis",
  "application-entitlement-changes",
  "application-monetization",
  "application-security",
  "announcement-crossposts",
  "announcement-subscriptions",
  "attachments",
  "audit-logs",
  "automod",
  "bans",
  "bot-profile",
  "bulk-bans",
  "channel-creation",
  "channel-deletion",
  "channel-cloning",
  "channel-metadata",
  "channel-ordering",
  "connector",
  "coordination",
  "deletion",
  "direct-messages",
  "embed-messages",
  "forum-posts",
  "forum-tags",
  "gateway",
  "guild-blueprints",
  "guild-community",
  "guild-departure",
  "guild-expressions",
  "guild-incidents",
  "guild-profile",
  "guild-prunes",
  "guild-scaffolds",
  "guild-settings",
  "guild-templates",
  "guilds",
  "integrations",
  "interactions",
  "invites",
  "linked-roles",
  "member-nicknames",
  "member-roles",
  "member-verification",
  "members",
  "message-forwarding",
  "message-writes",
  "messages",
  "moderation",
  "native-interactions",
  "observability",
  "onboarding",
  "permission-overwrites",
  "permission-sync",
  "permissions",
  "pins",
  "polls",
  "role-configuration",
  "role-creation",
  "role-deletion",
  "role-ordering",
  "roles",
  "scheduled-events",
  "soundboard",
  "stage-instances",
  "thread-governance",
  "threads",
  "voice-moderation",
  "welcome-screen",
  "webhooks",
  "widget-settings",
] as const

export type McpToolsetName = typeof MCP_TOOLSET_NAMES[number]

export const GUILD_PROFILE_FIELDS = [
  "description",
  "name",
] as const

export type GuildProfileField = typeof GUILD_PROFILE_FIELDS[number]

export const GUILD_SETTINGS_FIELDS = [
  "afkChannelId",
  "afkTimeoutSeconds",
  "defaultMessageNotifications",
  "explicitContentFilter",
  "premiumProgressBarEnabled",
  "suppressedSystemNotifications",
  "systemChannelId",
  "verificationLevel",
] as const

export type GuildSettingsField = typeof GUILD_SETTINGS_FIELDS[number]

export const GUILD_COMMUNITY_CHANGE_FIELDS = [
  "communityEnabled",
  "publicUpdatesChannelId",
  "rulesChannelId",
  "safetyAlertsChannelId",
] as const

export type GuildCommunityChangeField =
  typeof GUILD_COMMUNITY_CHANGE_FIELDS[number]

export const GUILD_INCIDENT_ACTION_FIELDS = [
  "directMessages",
  "invites",
] as const

export type GuildIncidentActionField = typeof GUILD_INCIDENT_ACTION_FIELDS[number]

export const GUILD_VERIFICATION_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "very-high",
] as const

export type GuildVerificationLevel = typeof GUILD_VERIFICATION_LEVELS[number]

export const GUILD_DEFAULT_MESSAGE_NOTIFICATIONS = [
  "all-messages",
  "only-mentions",
] as const

export type GuildDefaultMessageNotifications =
  typeof GUILD_DEFAULT_MESSAGE_NOTIFICATIONS[number]

export const GUILD_EXPLICIT_CONTENT_FILTERS = [
  "disabled",
  "members-without-roles",
  "all-members",
] as const

export type GuildExplicitContentFilter = typeof GUILD_EXPLICIT_CONTENT_FILTERS[number]

export const GUILD_AFK_TIMEOUT_SECONDS = [
  60,
  300,
  900,
  1_800,
  3_600,
] as const

export type GuildAfkTimeoutSeconds = typeof GUILD_AFK_TIMEOUT_SECONDS[number]

export const GUILD_SYSTEM_NOTIFICATION_SUPPRESSIONS = [
  "guild-reminders",
  "join-notification-replies",
  "join-notifications",
  "premium-subscriptions",
  "role-subscription-purchase-notification-replies",
  "role-subscription-purchase-notifications",
] as const

export type GuildSystemNotificationSuppression =
  typeof GUILD_SYSTEM_NOTIFICATION_SUPPRESSIONS[number]

export const CONFIG_FILE_ENVIRONMENT_VARIABLE = "GUILDCONTROL_CONFIG_FILE"
export const DEFAULT_TOKEN_ENVIRONMENT_VARIABLE = "DISCORD_BOT_TOKEN"
export const DISCORD_TOKEN_ENVIRONMENT_PATTERN = /^DISCORD_(?:[A-Z0-9]+_)*TOKEN$/

export const GUILD_SYSTEM_CHANNEL_KNOWN_FLAG_MASK = 0b11_1111

export const GUILD_PRUNE_DEFAULTS = Object.freeze({
  maximumMemberCount: 25,
})

export const FORUM_TAG_ACTIONS = [
  "create",
  "delete",
  "update-metadata",
] as const

export type ForumTagAction = typeof FORUM_TAG_ACTIONS[number]

export const DISCORD_LIMITS = Object.freeze({
  applicationCommandAggregateCharacters: 8_000,
  applicationCommandChoiceCharacters: 100,
  applicationCommandChoices: 25,
  applicationCommandDescriptionCharacters: 100,
  applicationCommandFileTypes: 10,
  applicationCommandGlobalCommands: 131,
  applicationCommandGlobalChatInputCommands: 100,
  applicationCommandGlobalMessageCommands: 15,
  applicationCommandGlobalPrimaryEntryPointCommands: 1,
  applicationCommandGlobalUserCommands: 15,
  applicationCommandGuildCommands: 130,
  applicationCommandGuildChatInputCommands: 100,
  applicationCommandGuildMessageCommands: 15,
  applicationCommandGuildUserCommands: 15,
  applicationCommandInventoryResponseBytes: 2_500_000,
  applicationCommandNameCharacters: 32,
  applicationCommandOptions: 25,
  applicationCommandStringCharacters: 6_000,
  applicationRoleConnectionMetadataDescriptionCharacters: 200,
  applicationRoleConnectionMetadataFields: 32,
  applicationRoleConnectionMetadataKeyCharacters: 50,
  applicationRoleConnectionMetadataLocalizations: 64,
  applicationRoleConnectionMetadataNameCharacters: 100,
  applicationRoleConnectionMetadataRecords: 5,
  applicationRoleConnectionMetadataRequestBytes: 65_536,
  applicationRoleConnectionMetadataResponseBytes: 524_288,
  applicationEntitlementFields: 32,
  applicationEntitlementPage: 100,
  applicationEntitlementRecordResponseBytes: 65_536,
  applicationEntitlementResponseBytes: 2_097_152,
  applicationSkuFields: 32,
  applicationSkuNameCharacters: 80,
  applicationSkuOwnerCreatedRecords: 50,
  applicationSkuRecords: 100,
  applicationSkuResponseBytes: 1_048_576,
  applicationSkuSlugCharacters: 256,
  applicationSubscriptionFields: 32,
  applicationSubscriptionPage: 100,
  applicationSubscriptionResponseBytes: 2_097_152,
  allowedMentionUsers: 100,
  applicationCommandPermissionOverwrites: 100,
  applicationEmojis: 2_000,
  attachmentBytes: 10 * 1_024 * 1_024,
  attachmentDescriptionCharacters: 1_024,
  attachmentFilenameCharacters: 240,
  autoModerationActions: 3,
  autoModerationAllowListKeywords: 100,
  autoModerationAllowListPresetKeywords: 1_000,
  autoModerationCustomMessageCharacters: 150,
  autoModerationExemptChannels: 50,
  autoModerationExemptRoles: 20,
  autoModerationKeywordCharacters: 60,
  autoModerationKeywordEntries: 1_000,
  autoModerationMentionLimit: 50,
  autoModerationRegexCharacters: 260,
  autoModerationRegexPatterns: 10,
  autoModerationRuleNameCharacters: 100,
  autoModerationRules: 10,
  autoModerationTimeoutSeconds: 2_419_200,
  auditReasonEncodedCharacters: 512,
  automaticRetryWaitMs: 5_000,
  archivedThreads: 100,
  archivedThreadsMinimum: 2,
  bulkDeleteAgeMs: 14 * 24 * 60 * 60 * 1_000,
  bulkDeleteSafetyMarginMs: 60_000,
  bulkGuildBanResponseBytes: 16_384,
  bulkGuildBanUsers: 200,
  botUsernameCharacters: 32,
  botUsernameMinimumCharacters: 2,
  banDeleteMessageSeconds: 7 * 24 * 60 * 60,
  channelMessages: 100,
  channelPins: 50,
  channelBitrateMinimum: 8_000,
  channelPermissionOverwrites: 1_000,
  channelNameCharacters: 100,
  channelRateLimitSeconds: 21_600,
  channelTopicCharacters: 1_024,
  guildNicknameCharacters: 32,
  guildPruneDaysMaximum: 30,
  guildPruneDaysMinimum: 1,
  guildPruneIncludeRoles: 100,
  guildPruneResponseBytes: 1_024,
  interactionMessageResponseBytes: 1_048_576,
  guildDescriptionCharacters: 120,
  guildNameCharacters: 100,
  guildNameMinimumCharacters: 2,
  forumChannelTopicCharacters: 4_096,
  categoryChannels: 50,
  currentUserGuilds: 200,
  currentUserGuildResponseBytes: 8 * 1_024 * 1_024,
  deletionMessages: 100,
  guildMessageSearch: 25,
  guildApplicationCommandPermissions: 262,
  forumAppliedTags: 5,
  forumAvailableTags: 20,
  forumTagNameCharacters: 20,
  guildRoles: 250,
  guildEmojis: 1_000,
  guildFeatureCharacters: 100,
  guildFeatures: 256,
  guildIntegrations: 50,
  guildWebhookResponseBytes: 8 * 1_024 * 1_024,
  guildWebhooks: 7_500,
  guildStickers: 100,
  guildChannels: 500,
  voiceChannelStatusCharacters: 500,
  emojiBytes: 256 * 1_024,
  emojiNameCharacters: 32,
  messageContentCharacters: 2_000,
  messageNonceCharacters: 25,
  requestTimeoutMs: 30_000,
  retries: 3,
  roleColor: 0xFF_FF_FF,
  roleIconBytes: 256 * 1_024,
  roleIconPixels: 64,
  roleNameCharacters: 100,
  scheduledEventCoverBytes: 8 * 1_024 * 1_024,
  scheduledEventDescriptionCharacters: 1_000,
  scheduledEventLocationCharacters: 100,
  scheduledEventNameCharacters: 100,
  scheduledEvents: 100,
  scheduledEventUsers: 100,
  soundboardBytes: 512 * 1_024,
  soundboardDurationSeconds: 5.2,
  soundboardNameCharacters: 32,
  soundboardNameMinimumCharacters: 2,
  soundboardSounds: 250,
  stageChannelBitrateMaximum: 64_000,
  stageChannelUserLimit: 10_000,
  stageTopicCharacters: 120,
  searchChannelIds: 500,
  searchContentCharacters: 1_024,
  searchFilenameCharacters: 1_024,
  searchFilterCharacters: 256,
  searchFilterIds: 100,
  searchFilterStrings: 100,
  searchOffset: 9_975,
  searchSlop: 100,
  snowflakeCharacters: 20,
  stickerBytes: 512 * 1_024,
  stickerDescriptionCharacters: 100,
  stickerDurationSeconds: 5,
  stickerNameCharacters: 30,
  stickerPixels: 320,
  stickerTagCharacters: 200,
  webhookNameCharacters: 80,
  webhookTokenCharacters: 2_048,
  webhooksPerChannel: 15,
  voiceChannelBitrateMaximum: 384_000,
  voiceChannelUserLimit: 99,
  voiceRegionIdCharacters: 100,
  voiceRegionNameCharacters: 100,
  voiceRegions: 100,
})

export const APPLICATION_ACTIVITY_INSTANCE_LIMITS = Object.freeze({
  instanceIdCharacters: 256,
  locationFields: 16,
  locationIdCharacters: 256,
  participants: 1_000,
  responseBytes: 256 * 1_024,
  responseFields: 16,
})

export const CHANNEL_INVENTORY_LIMITS = Object.freeze({
  cursorCharacters: 512,
  page: 100,
  pageDefault: 50,
})

export const CHANNEL_INVENTORY_CURSOR_PATTERN = /^ccur_hmac_sha256_[A-Za-z0-9_-]+\.[a-f0-9]{64}$/

export const PERMISSION_LIMITS = Object.freeze({
  auditActions: 5,
  auditRolePage: 100,
  auditRolePageDefault: 50,
  overwritePage: 100,
  overwritePageDefault: 50,
})

export const MEMBER_DIRECTORY_LIMITS = Object.freeze({
  listPage: 100,
  listPageDefault: 25,
  nameCharacters: 100,
  queryCharacters: 100,
  queryMinimumCharacters: 2,
  searchPage: 25,
  searchPageDefault: 10,
})

export const AUDIT_LOG_LIMITS = Object.freeze({
  changes: 100,
  entryPage: 50,
  entryPageDefault: 25,
  options: 50,
  reasonCharacters: 512,
  reflectedKeyCharacters: 100,
  responseEntries: 100,
})

export const BAN_AUDIT_LIMITS = Object.freeze({
  listPage: 100,
  listPageDefault: 25,
  reasonCharacters: 512,
  responseEntries: 101,
  userTextCharacters: 100,
})

export const POLL_LIMITS = Object.freeze({
  answerCharacters: 55,
  answers: 10,
  answersMinimum: 2,
  durationHours: 32 * 24,
  questionCharacters: 300,
  voterPage: 100,
  voterPageDefault: 25,
})

export const REACTION_TYPES = Object.freeze({
  burst: 1,
  normal: 0,
})

export const REACTION_LIMITS = Object.freeze({
  addSetEmojis: 10,
  addSetEmojisMinimum: 2,
  aggregatesPerMessage: 100,
  burstColorsPerReaction: 16,
  userPage: 100,
  userPageDefault: 25,
})

export const INVITE_LIMITS = Object.freeze({
  capabilityFileBytes: 4_096,
  capabilityPathCharacters: 4_096,
  codeCharacters: 256,
  cursorCharacters: 512,
  inventory: 1_000,
  listPage: 100,
  listPageDefault: 25,
  maxAgeSeconds: 604_800,
  maxUses: 100,
  minAgeSeconds: 60,
  roleIds: 250,
  targetUserIds: 100,
  targetUsersCsvBytes: 4_096,
  targetUsersPollAttempts: 40,
  targetUsersPollIntervalMs: 250,
})

export const INVITE_REFERENCE_PATTERN = /^iref_hmac_sha256_[a-f0-9]{64}$/
export const INVITE_CURSOR_PATTERN = /^icur_hmac_sha256_[A-Za-z0-9_-]+\.[a-f0-9]{64}$/
export const DISCORD_INVITE_URL_PATTERN = /(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)/iu

export const GUILD_TEMPLATE_LIMITS = Object.freeze({
  codeCharacters: 256,
  descriptionCharacters: 120,
  inventory: 100,
  nameCharacters: 100,
  snapshotPermissionOverwrites: 10_000,
})

export const GUILD_TEMPLATE_REFERENCE_PATTERN = /^tref_hmac_sha256_[a-f0-9]{64}$/

export const ONBOARDING_LIMITS = Object.freeze({
  auditOptionsPerPrompt: 100,
  auditPrompts: 32,
  auditReferencesPerOption: 250,
  auditTextCharacters: 4_096,
  auditTotalOptions: 1_000,
  defaultChannels: 25,
  enabledDefaultChannels: 7,
  enabledSendableDefaultChannels: 5,
  optionDescriptionCharacters: 100,
  optionReferences: 25,
  optionTitleCharacters: 100,
  optionsPerPrompt: 25,
  promptTitleCharacters: 100,
  prompts: 5,
})

export const WELCOME_SCREEN_LIMITS = Object.freeze({
  channelDescriptionCharacters: 50,
  channels: 5,
  descriptionCharacters: 140,
})

export const CONNECTOR_LIMITS = Object.freeze({
  activityEntries: 100,
  activityPageDefault: 25,
  activeThreads: 100,
  applicationMonetizationPageDefault: 25,
  applicationMonetizationSkuAllowlist: 50,
  applicationMonetizationSkuFilters: 10,
  applicationMonetizationSubjectAllowlist: 100,
  applicationEntitlementFulfillmentReferenceCharacters: 128,
  applicationEntitlementFulfillmentReferenceMinimumCharacters: 16,
  botProfileImageBytes: 8 * 1_024 * 1_024,
  botProfileReviewReasonCharacters: 512,
  attachmentPathCharacters: 4_096,
  bulkGuildBanReadConcurrency: 4,
  bulkMemberRoleReadConcurrency: 4,
  bulkMemberRoleTargets: 25,
  communityActivityChannels: 10,
  communityActivityMessagesDefault: 100,
  communityActivityMessagesPerChannel: 500,
  communityActivityMessagesTotal: 2_000,
  conversationRecallContextRadius: 5,
  conversationRecallContextRadiusDefault: 2,
  conversationRecallMatches: 5,
  conversationRecallPerPhraseCandidates: 10,
  conversationRecallPhraseCharactersTotal: 4_096,
  conversationRecallPhrases: 5,
  conversationRecallSlopDefault: 10,
  contentPreviewCharacters: 240,
  gatewayChannelMappings: 10_000,
  gatewayCursorCharacters: 128,
  gatewayEventBufferSize: 1_000,
  gatewayEventPage: 100,
  guildCommunityGuildAllowlist: 100,
  guildDepartureGuildAllowlist: 100,
  guildDepartureGuildPages: 50,
  guildDepartureReviewReasonCharacters: 512,
  guildProfileGuildAllowlist: 100,
  guildPruneIncludeRoles: 5,
  guildPruneMaximumMembers: 250,
  guildPruneRoleAllowlist: 100,
  guildBlueprintConvergenceTargets: 25,
  guildBlueprintPublications: 10,
  directMessageMaxWritesPerMinute: 5,
  directMessageMinWriteIntervalMs: 5_000,
  directMessagePage: 50,
  directMessagePageDefault: 25,
  directMessageReviewReasonCharacters: 512,
  directMessageUserAllowlist: 25,
  guildIncidentGuildAllowlist: 100,
  guildSettingsGuildAllowlist: 100,
  idempotencyKeyCharacters: 128,
  idempotencyKeyMinimumCharacters: 16,
  interactionEmojiCharacters: 100,
  interactionLedgerEntries: 1_000,
  interactionLedgerTtlMs: 10 * 60 * 1_000,
  commandProcessingFutureSkewMs: 5_000,
  commandProcessingSignalLedgerEntries: 1_000,
  commandProcessingSourceAgeMs: 2 * 60 * 1_000,
  interactionMaxWritesPerMinute: 60,
  interactionMinWriteIntervalMs: 60_000,
  typingIndicatorTtlMs: 10_000,
  interactionNotificationUsers: 10,
  integrationGuildAllowlist: 100,
  integrationIdAllowlist: 100,
  integrationObjectFields: 100,
  integrationOauthScopes: 100,
  nativeInteractionChannelAllowlist: 100,
  nativeInteractionGuildAllowlist: 100,
  nativeInteractionMaxPending: 100,
  nativeInteractionUserAllowlist: 100,
  permissionSyncChannelAllowlist: 100,
  permissionSyncChangedTargets: 100,
  memberNicknameGuildAllowlist: 100,
  memberRoleAllowlist: 100,
  memberRoleImpactChannels: 50,
  memberVoiceChannelAllowlist: 100,
  memberVoiceGuildAllowlist: 100,
  messageCatchupChannels: 10,
  messageCatchupMessagesDefault: 5,
  messageCatchupMessagesPerChannel: 10,
  messageCatchupMessagesTotal: 50,
  messageCatchupPreviewCharacters: 160,
  messageForwardChannelAllowlist: 100,
  mentionUserAllowlist: 100,
  messagePageDefault: 50,
  documentationSearchExcerptCharacters: 4_000,
  documentationSearchMatches: 5,
  documentationSearchQueryCharacters: 300,
  toolDiscoveryMatches: 8,
  toolDiscoveryQueryCharacters: 200,
  toolDiscoverySummaryCharacters: 200,
  observabilityHeaders: 32,
  observabilityHeaderValueCharacters: 4_096,
  observabilityOtlpEndpointCharacters: 2_048,
  observabilityServiceNameCharacters: 64,
  observabilityTimeoutMs: 60_000,
  configBytes: 131_072,
  applicationCommandGuildAllowlist: 100,
  credentialFileBytes: 4_096,
  operationReceiptBytes: 16_384,
  scaffoldChannels: 20,
  scaffoldRoles: 10,
  scaffoldStepLimit: 10,
  scaffoldSteps: 25,
  scaffoldSymbolCharacters: 32,
  protectedUserAllowlist: 100,
  reactionChannelAllowlist: 100,
  channelCloneGuildAllowlist: 100,
  channelCloneSourceAllowlist: 100,
  channelDeletionAllowlist: 100,
  channelOrderingGuildAllowlist: 100,
  roleConfigurationAllowlist: 100,
  roleDeletionAllowlist: 100,
  roleOrderingGuildAllowlist: 100,
  searchFilterIds: 25,
  searchFilterStrings: 25,
  scheduledEventUserPageDefault: 25,
  soundboardGuildAllowlist: 100,
  soundboardPlaybackChannelAllowlist: 100,
  soundboardPlaybackEventTimeoutMs: 2_000,
  soundboardPlaybackSourceGuildAllowlist: 100,
  stageInstanceChannels: 25,
  threadGovernanceGuildAllowlist: 100,
  threadGovernanceThreadAllowlist: 100,
  threadGovernanceUserAllowlist: 100,
  threadPageDefault: 50,
  welcomeScreenGuildAllowlist: 100,
  widgetSettingsGuildAllowlist: 100,
})

export const MCP_READ_RESPONSE_DEFAULTS = Object.freeze({
  maxBytes: 1_024 * 1_024,
})

export const MCP_READ_RESPONSE_LIMITS = Object.freeze({
  maximumBytes: 8 * 1_024 * 1_024,
  minimumBytes: 64 * 1_024,
})

export const STAGE_INSTANCE_ACTIONS = [
  "end",
  "start",
  "update",
] as const

export type StageInstanceAction = typeof STAGE_INSTANCE_ACTIONS[number]

export const SOUNDBOARD_ACTIONS = [
  "create",
  "delete",
  "update",
] as const

export type SoundboardAction = typeof SOUNDBOARD_ACTIONS[number]

export const GATEWAY_DEFAULTS = Object.freeze({
  authenticationTimeoutMs: 30_000,
  channelInfoTimeoutMs: 10_000,
  channelRouteConcurrency: 4,
  channelRouteResponseBytes: 16_384,
  connectionTimeoutMs: 30_000,
  discoveryResponseBytes: 16_384,
  eventBufferSize: 100,
  eventPage: 50,
  heartbeatMaximumMs: 120_000,
  heartbeatMinimumMs: 1_000,
  identifyBudget: 10,
  identifyBudgetWindowMs: 60 * 60 * 1_000,
  identifyMinimumIntervalMs: 5_000,
  maximumPayloadBytes: 1_048_576,
  outboundCommandAdmissionLimit: 60,
  outboundCommandQueueCapacity: 100,
  outboundCommandQueueTimeoutMs: 10_000,
  outboundEventLimit: 120,
  outboundPayloadBytes: 4_096,
  outboundWindowMs: 60_000,
  reconnectMaximumMs: 30_000,
  reconnectMinimumMs: 1_000,
  voiceChannelStatusUpdateTimeoutMs: 1_500,
})

export const OBSERVABILITY_DEFAULTS = Object.freeze({
  durationBucketsMs: [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000],
  exportIntervalMs: 30_000,
  exportTimeoutMs: 10_000,
  otlpBaseUrl: "http://localhost:4318",
  serviceName: CONNECTOR_NAME,
  shutdownTimeoutMs: 5_000,
})

export const DISCORD_GATEWAY_INTENTS = Object.freeze({
  guildMessages: 1 << 9,
  guildMessagePolls: 1 << 24,
  guildMessageReactions: 1 << 10,
  guildVoiceStates: 1 << 7,
  guilds: 1 << 0,
})

export const DISCORD_GATEWAY_INTENT_MASK = DISCORD_GATEWAY_INTENTS.guilds
  | DISCORD_GATEWAY_INTENTS.guildMessages
  | DISCORD_GATEWAY_INTENTS.guildMessagePolls
  | DISCORD_GATEWAY_INTENTS.guildMessageReactions

export const ADMINISTRATION_LIMITS = Object.freeze({
  timeoutMinutes: 28 * 24 * 60 - 1,
})

export const CHANNEL_CREATION_KINDS = [
  "category",
  "forum",
  "text",
] as const

export type ChannelCreationKind = typeof CHANNEL_CREATION_KINDS[number]

export const THREAD_CREATION_MODES = [
  "from-message",
  "standalone-private",
  "standalone-public",
] as const

export type ThreadCreationMode = typeof THREAD_CREATION_MODES[number]

export const THREAD_CHANGE_ACTIONS = [
  "add-member",
  "archive",
  "join",
  "leave",
  "lock",
  "remove-member",
  "rename",
  "set-auto-archive-duration",
  "set-invitable",
  "set-slowmode",
  "unarchive",
  "unlock",
] as const

export type ThreadChangeAction = typeof THREAD_CHANGE_ACTIONS[number]

export const CHANNEL_DEFAULT_AUTO_ARCHIVE_DURATIONS = [
  60,
  1_440,
  4_320,
  10_080,
] as const

export const MEMBER_MODERATION_ACTIONS = [
  "ban",
  "kick",
  "remove-timeout",
  "timeout",
  "unban",
] as const

export type MemberModerationAction = typeof MEMBER_MODERATION_ACTIONS[number]

export const MEMBER_VOICE_ACTIONS = [
  "disconnect",
  "move",
  "set-server-deafen",
  "set-server-mute",
] as const

export type MemberVoiceAction = typeof MEMBER_VOICE_ACTIONS[number]

export const MEMBER_ROLE_ACTIONS = [
  "add",
  "remove",
] as const

export type MemberRoleAction = typeof MEMBER_ROLE_ACTIONS[number]

export const INTERACTION_DEFAULTS = Object.freeze({
  maxWritesPerMinute: 10,
  minWriteIntervalMs: 500,
})

export const NATIVE_INTERACTION_DEFAULTS = Object.freeze({
  commandName: "guildcontrol",
  maximumFollowups: 3,
  maximumPending: 25,
  pendingPerUser: 3,
  requestCharacters: 2_000,
  responseCharacters: 2_000,
  tokenCharacters: 512,
  ttlSeconds: 10 * 60,
})

export const NATIVE_INTERACTION_LIMITS = Object.freeze({
  commandDescriptionCharacters: 100,
  commandNameCharacters: 32,
  commandOptionDescriptionCharacters: 100,
  maximumTtlSeconds: 14 * 60,
  minimumTtlSeconds: 30,
})

export const NATIVE_INTERACTION_COMMAND_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/

export const DISCORD_APPLICATION_FLAGS = Object.freeze({
  applicationAutoModerationRuleCreateBadge: 1n << 6n,
  applicationCommandBadge: 1n << 23n,
  embedded: 1n << 17n,
  gatewayGuildMembers: 1n << 14n,
  gatewayGuildMembersLimited: 1n << 15n,
  gatewayMessageContent: 1n << 18n,
  gatewayMessageContentLimited: 1n << 19n,
  gatewayPresence: 1n << 12n,
  gatewayPresenceLimited: 1n << 13n,
  verificationPendingGuildLimit: 1n << 16n,
})

export const DISCORD_GUILD_MEMBER_FLAGS = Object.freeze({
  bypassesVerification: 1 << 2,
})

export const DISCORD_CHANNEL_TYPES = Object.freeze({
  announcement: 5,
  announcementThread: 10,
  category: 4,
  directory: 14,
  dm: 1,
  forum: 15,
  groupDm: 3,
  media: 16,
  privateThread: 12,
  publicThread: 11,
  stageVoice: 13,
  text: 0,
  voice: 2,
})

export const DISCORD_CHANNEL_FLAGS = Object.freeze({
  channelObfuscated: 1 << 17,
  hideMediaDownloadOptions: 1 << 15,
  isSpoilerChannel: 1 << 21,
  requireTag: 1 << 4,
})

export const DISCORD_VIDEO_QUALITY_MODES = Object.freeze({
  auto: 1,
  full: 2,
})

export const DISCORD_FORUM_SORT_ORDERS = Object.freeze({
  creationDate: 1,
  latestActivity: 0,
})

export const DISCORD_FORUM_LAYOUTS = Object.freeze({
  gallery: 2,
  list: 1,
  notSet: 0,
})

export const DISCORD_MESSAGE_REFERENCE_TYPES = Object.freeze({
  default: 0,
  forward: 1,
})

export const DISCORD_MESSAGE_FLAGS = Object.freeze({
  crossposted: 1 << 0,
  ephemeral: 1 << 6,
  hasSnapshot: 1 << 14,
  isComponentsV2: 1 << 15,
  isCrosspost: 1 << 1,
  suppressEmbeds: 1 << 2,
  suppressNotifications: 1 << 12,
})

export const DISCORD_MESSAGE_TYPES = Object.freeze({
  chatInputCommand: 20,
  contextMenuCommand: 23,
  default: 0,
  reply: 19,
})

export const CHANNEL_TYPE_NAMES = Object.freeze({
  [DISCORD_CHANNEL_TYPES.text]: "guild-text",
  [DISCORD_CHANNEL_TYPES.dm]: "dm",
  [DISCORD_CHANNEL_TYPES.voice]: "guild-voice",
  [DISCORD_CHANNEL_TYPES.groupDm]: "group-dm",
  [DISCORD_CHANNEL_TYPES.category]: "guild-category",
  [DISCORD_CHANNEL_TYPES.announcement]: "guild-announcement",
  [DISCORD_CHANNEL_TYPES.announcementThread]: "announcement-thread",
  [DISCORD_CHANNEL_TYPES.publicThread]: "public-thread",
  [DISCORD_CHANNEL_TYPES.privateThread]: "private-thread",
  [DISCORD_CHANNEL_TYPES.stageVoice]: "guild-stage-voice",
  [DISCORD_CHANNEL_TYPES.directory]: "guild-directory",
  [DISCORD_CHANNEL_TYPES.forum]: "guild-forum",
  [DISCORD_CHANNEL_TYPES.media]: "guild-media",
} as const)
