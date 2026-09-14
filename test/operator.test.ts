import assert from "node:assert/strict"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"

import {
  CONFIG_FILE_ENVIRONMENT_VARIABLE,
  DEFAULT_TOKEN_ENVIRONMENT_VARIABLE,
  DISCORD_APPLICATION_FLAGS,
  MCP_ALWAYS_AVAILABLE_TOOL_NAMES,
  MCP_READ_RESPONSE_LIMITS,
  MCP_TOOLSET_NAMES,
} from "../src/constants.js"
import {
  BOT_INSTALLATION_AUDIT_PRIVACY,
  BOT_INSTALLATION_AUDIT_SCHEMA_VERSION,
} from "../src/bot-installation-audit-service.js"
import {
  projectApplicationPosture,
  type ApplicationPostureResult,
} from "../src/application-posture.js"
import {
  loadConnectorConfigDocument,
} from "../src/config.js"
import {
  createConnectorConfigDocument,
  loadConnectorConfigDocumentFile,
} from "../src/config-document.js"
import { writeConnectorConfigDocumentFile } from "../src/config-operator.js"
import type { DiscordToolService } from "../src/mcp.js"
import { MCP_TOOL_CATALOG } from "../src/mcp-tool-catalog.js"
import {
  diagnoseConnector as diagnoseNativeConnector,
  DOCTOR_CHECK_IDS,
  createStdioLaunchDescriptor,
  OPERATOR_REPORT_SCHEMA_VERSION,
  prepareSetup as prepareConfigSetup,
  smokeConnector as smokeNativeConnector,
  type SetupOptions,
  type SetupReport,
  type StatusProvider,
} from "../src/operator.js"
import {
  createConnectorProfile,
  loadProfile,
} from "../src/profile.js"
import { getSetupPreset } from "../src/setup-presets.js"
import {
  CONNECTOR_STATUS_PRIVACY,
  CONNECTOR_STATUS_SCHEMA_VERSION,
  type ConnectorService,
} from "../src/service.js"
import { DISCORD_PERMISSIONS } from "../src/permissions.js"
import {
  fixtureConfigInput,
  loadFixtureConfig,
  type FixtureConfigOverrides,
} from "./config-fixture.js"

const TOKEN = "test-discord-token"
const APPLICATION_ID = "100000000000000001"
const BOT_ID = "200000000000000001"
const GUILD_ID = "300000000000000001"
const OTHER_GUILD_ID = "300000000000000002"
const CHANNEL_ID = "400000000000000001"
const SOURCE_CHANNEL_ID = "400000000000000002"
const ROLE_ID = "500000000000000001"
const INTEGRATION_ID = "600000000000000001"
const USER_ID = "700000000000000001"
const TOKEN_ALIAS = "DISCORD_SUPPORT_BOT_TOKEN"
const SPAWNED_SMOKE_TOKEN_VARIABLE = "DISCORD_SMOKE_TOKEN"
const UNDECLARED_POLICY_ENVIRONMENT_VARIABLE = "GUILDCONTROL_UNDECLARED_POLICY"

function fixturePolicy(
  overrides: FixtureConfigOverrides = {},
): FixtureConfigOverrides {
  return {
    token: TOKEN,
    ...overrides,
    identity: {
      applicationId: APPLICATION_ID,
      botId: BOT_ID,
      ...overrides.identity,
    },
    readScope: {
      channelIds: [CHANNEL_ID],
      guildIds: [GUILD_ID],
      ...overrides.readScope,
    },
  }
}

function assertDefaultSecretForwarding(report: SetupReport): void {
  assert.deepEqual(report.launch.environment, {
    forward: [DEFAULT_TOKEN_ENVIRONMENT_VARIABLE],
    set: {},
  })
}

type FixtureSetupOptions = Omit<SetupOptions, "environment"> & {
  configOverrides?: FixtureConfigOverrides
  environment?: NodeJS.ProcessEnv
}

type FixtureDoctorOptions = Omit<
  NonNullable<Parameters<typeof diagnoseNativeConnector>[0]>,
  "environment"
> & {
  configOverrides?: FixtureConfigOverrides
  environment?: NodeJS.ProcessEnv
}

type FixtureSmokeOptions = Omit<
  NonNullable<Parameters<typeof smokeNativeConnector>[0]>,
  "environment"
> & {
  configOverrides?: FixtureConfigOverrides
  environment?: NodeJS.ProcessEnv
}

async function prepareSetup(options: FixtureSetupOptions): Promise<SetupReport> {
  const { configOverrides, ...nativeOptions } = options
  if (nativeOptions.configFile || nativeOptions.profileName) {
    return prepareConfigSetup(nativeOptions)
  }
  const fixture = fixtureConfigInput(configOverrides)
  const temporary = await mkdtemp(join(tmpdir(), "guildcontrol-operator-policy-"))
  const configFile = join(await realpath(temporary), "guildcontrol.json")
  try {
    await writeConnectorConfigDocumentFile(configFile, fixture.document)
    return await prepareConfigSetup({
      ...nativeOptions,
      configFile,
      environment: {
        ...fixture.environment,
        ...nativeOptions.environment,
      },
    })
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
}

function diagnoseConnector(
  options: FixtureDoctorOptions = {},
) {
  const { configOverrides, ...nativeOptions } = options
  if (configOverrides === undefined || nativeOptions.config) {
    return diagnoseNativeConnector(nativeOptions)
  }
  return diagnoseNativeConnector({
    ...nativeOptions,
    config: loadFixtureConfig(configOverrides),
  })
}

function smokeConnector(
  options: FixtureSmokeOptions = {},
) {
  const { configOverrides, ...nativeOptions } = options
  if (configOverrides === undefined || nativeOptions.config) {
    return smokeNativeConnector(nativeOptions)
  }
  return smokeNativeConnector({
    ...nativeOptions,
    config: loadFixtureConfig(configOverrides),
  })
}

function status(
  inScope = 1,
  messageContentIntent: "disabled" | "enabled" | "unknown" = "enabled",
  guildMembersIntent: "disabled" | "enabled" | "unknown" = "enabled",
  posture?: ApplicationPostureResult,
  configuredGuildIds: readonly string[] = [GUILD_ID],
): Awaited<ReturnType<ConnectorService["getStatus"]>> {
  const projectedPosture = projectApplicationPosture({
    bot_public: false,
    bot_require_code_grant: false,
    description: "",
    flags: 0,
    id: APPLICATION_ID,
    integration_types_config: { "0": {} },
    name: "Connector",
  }, BOT_ID, {
    guildMembersIntentRequired: false,
    messageContentIntent: "not-required",
    nativeInteractionIngressRequired: false,
  })
  const applicationPosture = posture ?? {
    ...projectedPosture,
    privilegedIntents: {
      guildMembers: guildMembersIntent,
      messageContent: messageContentIntent,
      presence: "disabled" as const,
    },
  }
  return {
    application: {
      guildMembersIntent,
      id: APPLICATION_ID,
      messageContentIntent,
    },
    applicationPosture,
    bot: {
      id: BOT_ID,
    },
    installationAudit: {
      completeness: {
        complete: true,
        maximumGuilds: 400,
        pageSize: 200,
        pagesRead: 1,
      },
      configuredGuildIds: [...configuredGuildIds],
      discardedGuildFieldCount: 2,
      drift: {
        detected: inScope !== configuredGuildIds.length,
        missingConfiguredGuildIds: configuredGuildIds.slice(inScope),
        unexpectedGuildIds: [],
      },
      identity: {
        applicationId: APPLICATION_ID,
        botId: BOT_ID,
      },
      installedGuildIds: [...configuredGuildIds.slice(0, inScope)],
      installedInScopeGuildIds: [...configuredGuildIds.slice(0, inScope)],
      privacy: BOT_INSTALLATION_AUDIT_PRIVACY,
      schemaVersion: BOT_INSTALLATION_AUDIT_SCHEMA_VERSION,
      status: "complete",
    },
    policy: {
      administrationEnabled: false,
      administrationGuildIds: [],
      applicationCommandChangesEnabled: false,
      applicationCommandGuildIds: [],
      globalApplicationCommandChangesEnabled: false,
      applicationEmojiAuditEnabled: false,
      applicationEmojiChangesEnabled: false,
      applicationEmojiCreationEnabled: false,
      applicationEmojiRootCount: 0,
      applicationConsumableEntitlementSkuIds: [],
      applicationConsumableEntitlementUserIds: [],
      applicationEntitlementConsumptionEnabled: false,
      applicationIntentChangesEnabled: false,
      botProfileAuditEnabled: false,
      botProfileChangesEnabled: false,
      botProfileImageReplacementEnabled: false,
      botProfileRootCount: 0,
      applicationEntitlementGuildIds: [],
      applicationEntitlementUserIds: [],
      applicationMonetizationAuditEnabled: false,
      applicationMonetizationSkuIds: [],
      applicationSubscriptionUserIds: [],
      applicationTestEntitlementChangesEnabled: false,
      applicationTestEntitlementGuildIds: [],
      applicationTestEntitlementSkuIds: [],
      applicationTestEntitlementUserIds: [],
      applicationRoleConnectionMetadataChangesEnabled: false,
      announcementCrosspostChannelIds: [],
      announcementCrosspostsEnabled: false,
      announcementSubscriptionAuditEnabled: false,
      announcementSubscriptionChangesEnabled: false,
      announcementSubscriptionSourceChannelIds: [],
      announcementSubscriptionTargetChannelIds: [],
      allowedChannelIds: [CHANNEL_ID],
      allowedGuildIds: [GUILD_ID],
      attachmentChannelIds: [],
      attachmentMaxBytes: 0,
      attachmentRootCount: 0,
      attachmentsEnabled: false,
      automodAlertChannelIds: [],
      automodAuditEnabled: false,
      automodChangesEnabled: false,
      automodGuildIds: [],
      banAuditEnabled: false,
      banAuditGuildIds: [],
      bulkBanAuditEnabled: false,
      bulkBanGuildIds: [],
      bulkBansEnabled: false,
      bulkMemberRoleChangesEnabled: false,
      bulkMemberRoleGuildIds: [],
      bulkMemberRoleCount: 0,
      channelCloneAuditEnabled: false,
      channelCloneGuildIds: [],
      channelCloneSourceIds: [],
      channelCloningEnabled: false,
      channelCreationEnabled: false,
      channelCreationGuildIds: [],
      channelDeletionAuditEnabled: false,
      channelDeletionIds: [],
      channelDeletionsEnabled: false,
      channelMetadataChangesEnabled: false,
      channelMetadataIds: [],
      channelOrderingAuditEnabled: false,
      channelOrderingChangesEnabled: false,
      channelOrderingGuildIds: [],
      componentLinkOrigins: [],
      deleteChannelIds: [],
      deletionsEnabled: false,
      directMessageAttachmentsEnabled: false,
      directMessageAuditEnabled: false,
      directMessageDeletionEnabled: false,
      directMessageDeliveryEnabled: false,
      directMessageEditingEnabled: false,
      directMessageUserIds: [],
      embedMessageChannelIds: [],
      embedMessagesEnabled: false,
      forumPostChannelIds: [],
      forumPostsEnabled: false,
      forumTagAuditEnabled: false,
      forumTagChangesEnabled: false,
      forumTagChannelIds: [],
      gatewayEnabled: false,
      gatewayEventBufferSize: 100,
      guildScaffoldGuildIds: [],
      guildScaffoldsEnabled: false,
      guildExpressionAuditEnabled: false,
      guildExpressionChangesEnabled: false,
      guildExpressionCreationEnabled: false,
      guildExpressionGuildIds: [],
      guildExpressionRootCount: 0,
      guildIncidentAuditEnabled: false,
      guildIncidentChangesEnabled: false,
      guildIncidentGuildIds: [],
      guildProfileAuditEnabled: false,
      guildProfileChangesEnabled: false,
      guildProfileGuildIds: [],
      guildPruneAuditEnabled: false,
      guildPruneGuildIds: [],
      guildPruneIncludeRoleIds: [],
      guildPruneMaxMembers: 0,
      guildPrunesEnabled: false,
      guildCommunityAuditEnabled: false,
      guildCommunityChangesEnabled: false,
      guildCommunityGuildIds: [],
      guildDepartureGuildIds: [],
      guildDeparturesEnabled: false,
      guildSettingsAuditEnabled: false,
      guildSettingsChangesEnabled: false,
      guildSettingsGuildIds: [],
      guildTemplateAuditEnabled: false,
      guildTemplateChangesEnabled: false,
      guildTemplateGuildIds: [],
      integrationAuditEnabled: false,
      integrationDeletionsEnabled: false,
      integrationGuildIds: [],
      integrationIds: [],
      scheduledEventAuditEnabled: false,
      scheduledEventChangesEnabled: false,
      scheduledEventCoverChangesEnabled: false,
      scheduledEventGuildIds: [],
      scheduledEventRootCount: 0,
      scheduledEventUserAuditEnabled: false,
      soundboardAuditEnabled: false,
      soundboardChangesEnabled: false,
      soundboardCreationEnabled: false,
      soundboardGuildIds: [],
      soundboardPlaybackChannelIds: [],
      soundboardPlaybackEnabled: false,
      soundboardPlaybackSourceGuildIds: [],
      soundboardRootCount: 0,
      stageChannelIds: [],
      stageInstanceAuditEnabled: false,
      stageInstanceChangesEnabled: false,
      stageStartNotificationsEnabled: false,
      interactionChannelIds: [],
      interactionMaxWritesPerMinute: 10,
      interactionMinWriteIntervalMs: 500,
      interactionsEnabled: false,
      inviteAuditEnabled: false,
      inviteCapabilityRootCount: 0,
      inviteCreationChannelIds: [],
      inviteCreationEnabled: false,
      inviteDeletionsEnabled: false,
      inviteGuildIds: [],
      inviteRoleAssignmentEnabled: false,
      inviteRoleIds: [],
      memberDirectoryEnabled: false,
      memberDirectoryGuildIds: [],
      nicknameChangesEnabled: false,
      nicknameGuildIds: [],
      otherMemberNicknameChangesEnabled: false,
      memberRoleChangesEnabled: false,
      memberRoleGuildIds: [],
      memberRoleCount: 0,
      memberVerificationChangesEnabled: false,
      memberVerificationGuildIds: [],
      memberVoiceAuditEnabled: false,
      memberVoiceChangesEnabled: false,
      memberVoiceChannelIds: [],
      memberVoiceGuildIds: [],
      crossGuildMessageForwardingEnabled: false,
      messageForwardingEnabled: false,
      messageForwardSourceChannelIds: [],
      messageForwardTargetChannelIds: [],
      nativeCommandChangesEnabled: false,
      nativeCommandName: "guildcontrol",
      nativeInteractionChannelIds: [],
      nativeInteractionGuildIds: [],
      nativeInteractionMaxPending: 25,
      nativeInteractionsEnabled: false,
      nativeInteractionTtlSeconds: 600,
      nativeInteractionUserIds: [],
      mentionUserCount: 0,
      mcpToolsets: [...MCP_TOOLSET_NAMES],
      mcpToolSurface: "full",
      mcpReadResponseMaxBytes: 1_048_576,
      onboardingAuditEnabled: false,
      onboardingChangesEnabled: false,
      onboardingGuildIds: [],
      permissionOverwriteChannelIds: [],
      permissionOverwritesEnabled: false,
      permissionSyncChannelIds: [],
      permissionSyncsEnabled: false,
      protectedUserCount: 0,
      pinChannelIds: [],
      pinManagementEnabled: false,
      pollAuditEnabled: false,
      pollChannelIds: [],
      pollCreationEnabled: false,
      pollEndingEnabled: false,
      pollVoterAuditEnabled: false,
      reactionChannelIds: [],
      reactionModerationEnabled: false,
      reactionUserAuditEnabled: false,
      readChannelScope: "allowlist",
      readGuildScope: "allowlist",
      roleCreationEnabled: false,
      roleCreationGuildIds: [],
      roleConfigurationEnabled: false,
      roleConfigurationIds: [],
      roleDeletionAuditEnabled: false,
      roleDeletionIds: [],
      roleDeletionsEnabled: false,
      roleOrderingAuditEnabled: false,
      roleOrderingChangesEnabled: false,
      roleOrderingGuildIds: [],
      threadCreationEnabled: false,
      threadAuditEnabled: false,
      threadChangesEnabled: false,
      threadGuildIds: [],
      threadIds: [],
      threadMemberUserIds: [],
      threadMessageWriteMode: "exact",
      threadParentIds: [],
      threadReadMode: "inherit",
      webhookAuditEnabled: false,
      webhookChannelIds: [],
      webhookGuildIds: [],
      webhookChangesEnabled: false,
      webhookCreationEnabled: false,
      webhookDeletionsEnabled: false,
      webhookMessageAuditEnabled: false,
      webhookMessageChannelIds: [],
      webhookMessageChangesEnabled: false,
      webhookMessageDeletionsEnabled: false,
      webhookMessageDeliveryEnabled: false,
      welcomeScreenAuditEnabled: false,
      welcomeScreenChangesEnabled: false,
      welcomeScreenGuildIds: [],
      widgetPublicExposureEnabled: false,
      widgetSettingsAuditEnabled: false,
      widgetSettingsChangesEnabled: false,
      widgetSettingsGuildIds: [],
      userMentionMode: "allowlist",
    },
    privacy: CONNECTOR_STATUS_PRIVACY,
    schemaVersion: CONNECTOR_STATUS_SCHEMA_VERSION,
    status: "ok",
    writeCoordination: {
      coverage: "receipt-backed-reviewed-writes",
      excludedWorkflows: ["ordinary-message-interactions"],
      localFilesystemRequired: true,
      mode: "durable-exact-target",
      resumableWorkflows: ["guild-scaffold"],
      sharedStateRootRequired: true,
    },
  }
}

function statusProvider(inScope = 1): StatusProvider {
  return {
    async getStatus() {
      return status(inScope)
    },
  }
}

function toolService(
  connectorStatus: Awaited<ReturnType<ConnectorService["getStatus"]>> = status(),
): DiscordToolService {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected smoke service call")
  }
  const unexpectedSync = (): never => {
    throw new Error("Unexpected smoke service call")
  }
  return {
    messageNotificationAuthorization: unexpectedSync,
    addReaction: unexpected,
    addReactions: unexpected,
    catchUpMessages: unexpected,
    checkSoundboardPlayback: unexpected,
    analyzeCommunityActivity: unexpected,
    createCoordinationAddress: unexpectedSync,
    listCoordinationAddresses: unexpected,
    listCoordinationNotes: unexpected,
    playSoundboardSound: unexpected,
    listMessageReplies: unexpected,
    sendCoordinationNote: unexpected,
    auditApplicationCommands: unexpected,
    auditBotInstallations: unexpected,
    auditApplicationEntitlements: unexpected,
    getApplicationEntitlement: unexpected,
    auditApplicationRoleConnectionMetadata: unexpected,
    auditApplicationSkus: unexpected,
    auditApplicationSubscriptions: unexpected,
    inspectApplicationActivityInstance: unexpected,
    auditGuildWebhooks: unexpected,
    captureGuildBlueprint: unexpected,
    executeDirectMessageChange: unexpected,
    getDirectMessage: unexpected,
    listDirectMessages: unexpected,
    planDirectMessageChange: unexpected,
    verifyDirectMessageChange: unexpected,
    getApplicationPosture: unexpected,
    getCurrentBotProfile: unexpected,
    auditChannelDeletion: unexpected,
    auditRoleDeletion: unexpected,
    auditChannelOrder: unexpected,
    auditForumTags: unexpected,
    auditRoleOrder: unexpected,
    executeAnnouncementCrosspost: unexpected,
    executeAnnouncementSubscription: unexpected,
    executeApplicationEmojiChange: unexpected,
    executeApplicationEntitlementConsumption: unexpected,
    executeApplicationIntentEnablement: unexpected,
    executeBotProfileChange: unexpected,
    executeApplicationRoleConnectionMetadataChange: unexpected,
    executeApplicationTestEntitlementChange: unexpected,
    executeMessageForward: unexpected,
    executeNativeInteractionCommand: unexpected,
    executeGuildApplicationCommandChange: unexpected,
    executeGlobalApplicationCommandChange: unexpected,
    executeRoleOrder: unexpected,
    executeMemberNicknameChange: unexpected,
    executeMemberVerificationChange: unexpected,
    executeMemberRoleChange: unexpected,
    executeBulkMemberRoleChange: unexpected,
    executeMemberVoiceChange: unexpected,
    executeThreadChange: unexpected,
    executeAutoModerationChange: unexpected,
    verifyAutoModerationChange: unexpected,
    executeGuildExpressionChange: unexpected,
    executeGuildTemplateChange: unexpected,
    executeGuildIntegrationDeletion: unexpected,
    executeGuildDeparture: unexpected,
    executeForumTagChange: unexpected,
    executeSoundboardChange: unexpected,
    executeInviteCreation: unexpected,
    executeInviteDeletion: unexpected,
    executeOnboardingChange: unexpected,
    executeWelcomeScreenChange: unexpected,
    executeWidgetSettingsChange: unexpected,
    executeGuildSettingsChange: unexpected,
    executeGuildCommunityChange: unexpected,
    executeGuildIncidentActionChange: unexpected,
    executeGuildProfileChange: unexpected,
    executePollCreation: unexpected,
    executePollEnd: unexpected,
    executeReactionModeration: unexpected,
    executeScheduledEventChange: unexpected,
    executeStageInstanceChange: unexpected,
    executeWebhookChange: unexpected,
    executeWebhookCreation: unexpected,
    executeWebhookDeletion: unexpected,
    executeWebhookMessageDeletion: unexpected,
    planAnnouncementCrosspost: unexpected,
    planAnnouncementSubscription: unexpected,
    planMessageForward: unexpected,
    planNativeInteractionCommand: unexpected,
    planGuildApplicationCommandChange: unexpected,
    planGlobalApplicationCommandChange: unexpected,
    getThreadMembership: unexpected,
    getThreadState: unexpected,
    planThreadChange: unexpected,
    planForumTagChange: unexpected,
    getGuildExpression: unexpected,
    getApplicationEmoji: unexpected,
    getGuildSoundboardSound: unexpected,
    listGuildTemplates: unexpected,
    listGuildIntegrations: unexpected,
    listGuildVoiceRegions: unexpected,
    getAutoModerationRule: unexpected,
    getScheduledEvent: unexpected,
    getStageInstance: unexpected,
    getChannelWebhook: unexpected,
    getWebhookMessage: unexpected,
    getPoll: unexpected,
    getGuildInvite: unexpected,
    getGuildVanityUrl: unexpected,
    getGuildOnboarding: unexpected,
    getGuildWelcomeScreen: unexpected,
    getGuildWidgetSettings: unexpected,
    getGuildSettings: unexpected,
    getGuildCommunity: unexpected,
    getGuildIncidentActions: unexpected,
    getGuildProfile: unexpected,
    listChannelWebhooks: unexpected,
    listAnnouncementSubscriptions: unexpected,
    listGuildInvites: unexpected,
    listGuildExpressions: unexpected,
    listApplicationEmojis: unexpected,
    listDefaultSoundboardSounds: unexpected,
    listGuildSoundboardSounds: unexpected,
    listAutoModerationRules: unexpected,
    listScheduledEvents: unexpected,
    listScheduledEventUsers: unexpected,
    listStageInstances: unexpected,
    listVoiceRegions: unexpected,
    planWebhookChange: unexpected,
    planWebhookCreation: unexpected,
    planWebhookDeletion: unexpected,
    planWebhookMessageDeletion: unexpected,
    previewComponentLayout() {
      throw new Error("Unexpected smoke service call")
    },
    previewEmbedMessage() {
      throw new Error("Unexpected embed-message preview")
    },
    planInviteCreation: unexpected,
    planInviteDeletion: unexpected,
    planOnboardingChange: unexpected,
    planWelcomeScreenChange: unexpected,
    planWidgetSettingsChange: unexpected,
    planGuildSettingsChange: unexpected,
    planGuildCommunityChange: unexpected,
    planGuildIncidentActionChange: unexpected,
    planGuildProfileChange: unexpected,
    planGuildExpressionChange: unexpected,
    planApplicationEmojiChange: unexpected,
    planApplicationEntitlementConsumption: unexpected,
    planApplicationIntentEnablement: unexpected,
    planBotProfileChange: unexpected,
    planApplicationRoleConnectionMetadataChange: unexpected,
    planApplicationTestEntitlementChange: unexpected,
    planGuildTemplateChange: unexpected,
    planGuildIntegrationDeletion: unexpected,
    planGuildDeparture: unexpected,
    planSoundboardChange: unexpected,
    planAutoModerationChange: unexpected,
    planMemberNicknameChange: unexpected,
    planMemberVerificationChange: unexpected,
    planMemberRoleChange: unexpected,
    planBulkMemberRoleChange: unexpected,
    planMemberVoiceChange: unexpected,
    planScheduledEventChange: unexpected,
    planStageInstanceChange: unexpected,
    auditChannelRoleAccess: unexpected,
    deleteMessages: unexpected,
    describePolicy() {
      return status().policy
    },
    editOwnMessage: unexpected,
    executeReviewedEditOwnMessage: unexpected,
    executeReviewedSendMessage: unexpected,
    executeAttachmentMessage: unexpected,
    executeComponentMessage: unexpected,
    executeEmbedMessage: unexpected,
    executeChannelCreation: unexpected,
    executeChannelDeletion: unexpected,
    executeChannelClone: unexpected,
    executeChannelOrder: unexpected,
    executeChannelMetadataChange: unexpected,
    executeVoiceChannelStatusChange: unexpected,
    executeChannelPermissionOverwrite: unexpected,
    executeChannelPermissionSync: unexpected,
    executeForumPost: unexpected,
    executeThreadCreation: unexpected,
    executeGuildBlueprint: unexpected,
    executeGuildScaffold: unexpected,
    executeMemberModeration: unexpected,
    executeBulkGuildBan: unexpected,
    executeGuildPrune: unexpected,
    executeMessagePin: unexpected,
    executeRoleCreation: unexpected,
    executeRoleConfiguration: unexpected,
    executeRoleDeletion: unexpected,
    explainChannelAccess: unexpected,
    explainPrincipalPermissions: unexpected,
    getGuildAuditEntry: unexpected,
    getChannel: unexpected,
    getVoiceChannelStatus: unexpected,
    getGuildBan: unexpected,
    getGuildMember: unexpected,
    getMemberVoiceState: unexpected,
    getMessage: unexpected,
    getMessageAttachment: unexpected,
    getRole: unexpected,
    async getStatus() {
      return connectorStatus
    },
    listActivity: unexpected,
    listActiveThreads: unexpected,
    listArchivedThreads: unexpected,
    listChannels: unexpected,
    listChannelPermissionOverwrites: unexpected,
    listGuilds: unexpected,
    listGuildAuditEntries: unexpected,
    listGuildBans: unexpected,
    listGuildMembers: unexpected,
    listMessagePins: unexpected,
    listPollAnswerVoters: unexpected,
    listMessageReactions: unexpected,
    listReactionUsers: unexpected,
    listRoles: unexpected,
    planMessageDeletion: unexpected,
    planEditOwnMessageNotifications: unexpected,
    planSendMessageNotifications: unexpected,
    planMessagePin: unexpected,
    planPollCreation: unexpected,
    planPollEnd: unexpected,
    planReactionModeration: unexpected,
    planAttachmentMessage: unexpected,
    planComponentMessage: unexpected,
    planEmbedMessage: unexpected,
    verifyComponentMessage: unexpected,
    verifyEmbedMessage: unexpected,
    planChannelCreation: unexpected,
    planChannelDeletion: unexpected,
    planChannelClone: unexpected,
    planChannelMetadataChange: unexpected,
    planVoiceChannelStatusChange: unexpected,
    planChannelOrder: unexpected,
    planChannelPermissionOverwrite: unexpected,
    planChannelPermissionSync: unexpected,
    planForumPost: unexpected,
    planThreadCreation: unexpected,
    planGuildBlueprint: unexpected,
    verifyGuildBlueprint: unexpected,
    planGuildScaffold: unexpected,
    verifyGuildScaffold: unexpected,
    planMemberModeration: unexpected,
    planBulkGuildBan: unexpected,
    planGuildPrune: unexpected,
    planRoleCreation: unexpected,
    planRoleConfiguration: unexpected,
    planRoleDeletion: unexpected,
    planRoleOrder: unexpected,
    readMessages: unexpected,
    recallConversation: unexpected,
    removeOwnReaction: unexpected,
    searchMessages: unexpected,
    searchGuildMembers: unexpected,
    sendMessage: unexpected,
    signalCommandProcessing: unexpected,
    sendWebhookMessage: unexpected,
    editWebhookMessage: unexpected,
  }
}

function toolServiceWithoutScopedGuilds(): DiscordToolService {
  return {
    ...toolService(),
    async getStatus() {
      return status(0)
    },
  }
}

test("doctor reports unsupported runtime and missing configuration without throwing", async () => {
  const report = await diagnoseConnector({
    environment: {},
    nodeVersion: "20.18.0",
  })

  assert.equal(report.status, "error")
  assert.equal(report.identity, null)
  assert.equal(
    report.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.nodeVersion)?.status,
    "fail",
  )
  assert.equal(
    report.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.token)?.status,
    "fail",
  )
  assert.equal(
    report.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.configuration)?.status,
    "fail",
  )
  for (const entry of report.checks.filter((candidate) => candidate.status !== "pass")) {
    assert.ok(entry.action)
    assert.ok(entry.reference)
  }
  const runtime = report.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.nodeVersion,
  )
  assert.match(runtime?.action || "", /Install Node\.js 22 or newer/)
  assert.equal(runtime?.reference, "docs/reference.md#requirements")
  const token = report.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.token)
  assert.match(token?.action || "", /environment variable or file referenced by credential/)
  assert.equal(token?.reference, "docs/reference.md#discord-bot-setup")
})

test("doctor resolves the credential variable referenced by a selected configuration", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "guildcontrol-doctor-policy-"))
  context.after(() => rm(temporary, { force: true, recursive: true }))
  const configFile = join(await realpath(temporary), "guildcontrol.json")
  await writeConnectorConfigDocumentFile(
    configFile,
    createConnectorConfigDocument({
      applicationId: APPLICATION_ID,
      botId: BOT_ID,
      channelIds: [CHANNEL_ID],
      credentialVariable: TOKEN_ALIAS,
      guildIds: [GUILD_ID],
      name: "doctor-policy",
      toolsets: MCP_TOOLSET_NAMES,
      toolSurface: "full",
    }),
  )

  const report = await diagnoseConnector({
    environment: {
      [CONFIG_FILE_ENVIRONMENT_VARIABLE]: configFile,
      [TOKEN_ALIAS]: TOKEN,
    },
    nodeVersion: "22.14.0",
  })

  assert.equal(
    report.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.token)?.status,
    "pass",
  )
  assert.equal(
    report.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.configuration)?.status,
    "pass",
  )
})

test("doctor inspects a strict document when its declared environment credential is missing", async () => {
  const document = createConnectorConfigDocument({
    applicationId: APPLICATION_ID,
    botId: BOT_ID,
    channelIds: [CHANNEL_ID],
    credentialVariable: TOKEN_ALIAS,
    guildIds: [GUILD_ID],
    name: "missing-environment-credential",
    toolsets: ["connector", "guilds"],
    toolSurface: "progressive",
  })

  const report = await diagnoseNativeConnector({
    document,
    environment: {},
    nodeVersion: "22.14.0",
  })

  assert.equal(report.status, "error")
  const token = report.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.token)
  assert.equal(token?.status, "fail")
  assert.match(token?.summary || "", new RegExp(TOKEN_ALIAS))
  assert.equal(
    report.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.configuration)?.status,
    "pass",
  )
  assert.equal(
    report.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.applicationIdentity)?.status,
    "pass",
  )
  assert.equal(
    report.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.toolSurface)?.status,
    "pass",
  )
  assert.doesNotMatch(JSON.stringify(report), /DISCORD_GUILDCONTROL_DOCTOR_TOKEN|credential-unavailable/)
})

test("doctor inspects a strict document when its file credential is unavailable", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "guildcontrol-doctor-missing-file-"))
  context.after(() => rm(temporary, { force: true, recursive: true }))
  const root = await realpath(temporary)
  const credentialFile = join(root, "missing-token")
  const document = createConnectorConfigDocument({
    applicationId: APPLICATION_ID,
    botId: BOT_ID,
    credentialFile,
    guildIds: [GUILD_ID],
    name: "missing-file-credential",
    toolsets: ["connector"],
    toolSurface: "full",
  })

  const report = await diagnoseNativeConnector({
    document,
    environment: {},
    nodeVersion: "22.14.0",
  })

  const token = report.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.token)
  assert.equal(token?.status, "fail")
  assert.match(token?.summary || "", /credential file was not found/)
  assert.doesNotMatch(token?.summary || "", new RegExp(credentialFile))
  assert.equal(
    report.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.configuration)?.status,
    "pass",
  )
})

test("online doctor never contacts Discord when the selected credential is unavailable", async () => {
  let statusCalls = 0
  const report = await diagnoseNativeConnector({
    document: createConnectorConfigDocument({
      applicationId: APPLICATION_ID,
      botId: BOT_ID,
      credentialVariable: TOKEN_ALIAS,
      guildIds: [GUILD_ID],
      name: "offline-credential",
      toolsets: ["connector"],
      toolSurface: "full",
    }),
    environment: {},
    nodeVersion: "22.14.0",
    online: true,
    service: {
      async getStatus() {
        statusCalls += 1
        return status()
      },
    },
  })

  assert.equal(statusCalls, 0)
  const access = report.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.guildAccess)
  assert.equal(access?.status, "fail")
  assert.match(access?.summary || "", /skipped.*credential is unavailable/i)
})

test("credential-independent doctor preserves undeclared ambient policy rejection", async () => {
  const report = await diagnoseNativeConnector({
    document: createConnectorConfigDocument({
      applicationId: APPLICATION_ID,
      botId: BOT_ID,
      credentialVariable: TOKEN_ALIAS,
      guildIds: [GUILD_ID],
      name: "ambient-conflict",
      toolsets: ["connector"],
      toolSurface: "full",
    }),
    environment: {
      [UNDECLARED_POLICY_ENVIRONMENT_VARIABLE]: "true",
      [TOKEN_ALIAS]: TOKEN,
    },
    nodeVersion: "22.14.0",
  })

  assert.equal(
    report.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.token)?.status,
    "pass",
  )
  const configuration = report.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.configuration,
  )
  assert.equal(configuration?.status, "fail")
  assert.match(configuration?.summary || "", /undeclared environment variables/)
  assert.equal(
    report.checks.some((entry) => entry.id === DOCTOR_CHECK_IDS.toolSurface),
    false,
  )
})

test("credential-independent doctor never masks a colliding ambient variable", async () => {
  const report = await diagnoseNativeConnector({
    document: createConnectorConfigDocument({
      applicationId: APPLICATION_ID,
      botId: BOT_ID,
      credentialVariable: TOKEN_ALIAS,
      guildIds: [GUILD_ID],
      name: "ambient-diagnostic-collision",
      toolsets: ["connector"],
      toolSurface: "full",
    }),
    environment: {
      DISCORD_GUILDCONTROL_DOCTOR_TOKEN: "hostile-policy-value",
    },
    nodeVersion: "22.14.0",
  })

  assert.equal(
    report.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.token)?.status,
    "fail",
  )
  const configuration = report.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.configuration,
  )
  assert.equal(configuration?.status, "fail")
  assert.match(configuration?.summary || "", /DISCORD_GUILDCONTROL_DOCTOR_TOKEN/)
})

test("doctor resolves file-backed credentials and redacts downstream failures", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "guildcontrol-doctor-file-secret-"))
  context.after(() => rm(temporary, { force: true, recursive: true }))
  const root = await realpath(temporary)
  const configFile = join(root, "guildcontrol.json")
  const credentialFile = join(root, "discord-token")
  await writeFile(credentialFile, `${TOKEN}\n`, { mode: 0o600 })
  await writeConnectorConfigDocumentFile(
    configFile,
    createConnectorConfigDocument({
      applicationId: APPLICATION_ID,
      botId: BOT_ID,
      credentialFile,
      guildIds: [GUILD_ID],
      name: "doctor-file-secret",
      toolsets: ["connector"],
      toolSurface: "full",
    }),
  )

  const report = await diagnoseConnector({
    environment: { [CONFIG_FILE_ENVIRONMENT_VARIABLE]: configFile },
    nodeVersion: "22.14.0",
    online: true,
    service: {
      async getStatus() {
        throw new Error(`Credential ${TOKEN} rejected`)
      },
    },
  })

  assert.equal(
    report.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.token)?.status,
    "pass",
  )
  const access = report.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.guildAccess)
  assert.equal(access?.status, "fail")
  assert.match(access?.summary || "", /Credential \[redacted\] rejected/)
  assert.doesNotMatch(JSON.stringify(report), new RegExp(TOKEN))
})

test("doctor distinguishes complete scope from a missing channel boundary", async () => {
  const scoped = await diagnoseConnector({
    configOverrides: fixturePolicy(),
    nodeVersion: "22.14.0",
  })
  const guildOnly = await diagnoseConnector({
    configOverrides: {
      token: TOKEN,
    },
    nodeVersion: "22.14.0",
  })

  assert.equal(scoped.status, "ok")
  assert.equal(scoped.checks.every((entry) => entry.status === "pass"), true)
  assert.equal(scoped.checks.every((entry) => !("action" in entry)), true)
  assert.equal(scoped.checks.every((entry) => !("reference" in entry)), true)
  assert.equal(guildOnly.status, "warning")
  assert.equal(
    guildOnly.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.channelScope)?.status,
    "warn",
  )
  assert.match(
    guildOnly.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.channelScope)?.action || "",
    /readScope\.channelIds/,
  )
  for (const entry of guildOnly.checks.filter((candidate) => candidate.status !== "pass")) {
    assert.ok(entry.action)
    assert.equal(entry.reference, "docs/reference.md#operator-cli")
  }
})

test("doctor gives feature-policy warnings a safe default recovery path", async () => {
  const report = await diagnoseConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        deletions: true,
      },
    }),
    nodeVersion: "22.14.0",
  })
  const deletion = report.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.deletionPolicy,
  )

  assert.equal(report.status, "warning")
  assert.equal(deletion?.status, "warn")
  assert.match(deletion?.action || "", /toggle and exact allowlists/)
  assert.equal(deletion?.reference, "docs/reference.md#configuration")
})

test("doctor and setup explain progressive risk-separated MCP toolsets", async () => {
  const configuredPolicy = fixturePolicy({
    capabilities: {
      interactions: true,
    },
    scopes: {
      interactionChannelIds: [CHANNEL_ID],
    },
    tools: {
      toolsets: ["connector", "messages"],
      surface: "progressive",
    },
  })
  const doctor = await diagnoseConnector({
    configOverrides: configuredPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: configuredPolicy,
    service: statusProvider(),
  })

  const toolSurface = doctor.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.toolSurface,
  )
  assert.equal(toolSurface?.status, "pass")
  assert.match(toolSurface?.summary || "", /progressive/)
  assert.match(
    toolSurface?.summary || "",
    new RegExp(`2 of ${MCP_TOOLSET_NAMES.length}`),
  )
  const configuredToolsets = new Set<string>(["connector", "messages"])
  const configuredToolCount = Object.values(MCP_TOOL_CATALOG)
    .filter(({ toolset }) => configuredToolsets.has(toolset))
    .length
  assert.match(
    toolSurface?.summary || "",
    new RegExp(`${configuredToolCount} canonical tools`),
  )
  const toolAccessContract = doctor.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.toolAccessContract,
  )
  assert.equal(toolAccessContract?.status, "pass")
  assert.match(toolAccessContract?.summary || "", /local discovery/)
  assert.match(toolAccessContract?.summary || "", /review-plan=/)
  assert.match(toolAccessContract?.summary || "", /review-execute=/)
  assert.match(toolAccessContract?.summary || "", /target readiness remains operation-specific/)
  const readResponseBudget = doctor.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.readResponseBudget,
  )
  assert.equal(readResponseBudget?.status, "pass")
  assert.match(readResponseBudget?.summary || "", /1048576 UTF-8 bytes/)
  assert.match(readResponseBudget?.summary || "", /fail whole without truncation/)
  assert.match(readResponseBudget?.summary || "", /mutation outcomes are preserved/)
  assert.equal(setup.toolSurface, "progressive")
  assert.deepEqual(setup.toolsets, ["connector", "messages"])
  assert.match(setup.warnings.join("\n"), /interactions toolset/)
})

test("doctor reports the configured lossless MCP read-response boundary", async () => {
  const report = await diagnoseConnector({
    configOverrides: {
      limits: {
        mcpReadResponseMaxBytes: MCP_READ_RESPONSE_LIMITS.minimumBytes,
      },
      token: TOKEN,
    },
    nodeVersion: "22.14.0",
  })
  const budget = report.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.readResponseBudget,
  )

  assert.equal(budget?.status, "pass")
  assert.match(
    budget?.summary || "",
    new RegExp(`${MCP_READ_RESPONSE_LIMITS.minimumBytes} UTF-8 bytes`),
  )
  assert.match(budget?.summary || "", /fail whole without truncation/)
  assert.match(budget?.summary || "", /mutation outcomes are preserved/)
})

test("doctor and setup explain effective interaction policy without Discord writes", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      interactions: true,
    },
    limits: {
      interactionMaxWritesPerMinute: 12,
    },
    scopes: {
      interactionChannelIds: [CHANNEL_ID],
    },
  })
  const report = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const warning = await diagnoseConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        interactions: true,
      },
    }),
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: fixturePolicy({
      capabilities: {
        interactions: true,
      },
    }),
    service: statusProvider(),
  })
  const missingIntent = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
    online: true,
    service: {
      async getStatus() {
        return status(1, "disabled")
      },
    },
  })
  const missingIntentSetup = await prepareSetup({
    configOverrides: enabledPolicy,
    service: {
      async getStatus() {
        return status(1, "unknown")
      },
    },
  })

  const interaction = report.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.interactionPolicy,
  )
  assert.equal(interaction?.status, "pass")
  assert.match(interaction?.summary || "", /12-write rolling budget/)
  assert.match(interaction?.summary || "", /0 exact link origins/)
  assert.equal(
    warning.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.interactionPolicy)?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /interaction-channel allowlist/)
  assert.equal(
    missingIntent.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.messageContentIntent,
    )?.status,
    "fail",
  )
  assert.match(missingIntentSetup.warnings.join("\n"), /component messages are blocked/)
})

test("doctor and setup explain reviewed static embed-message policy", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      embedMessages: true,
    },
    limits: {
      interactionMaxWritesPerMinute: 12,
    },
    scopes: {
      embedMessageChannelIds: [CHANNEL_ID],
    },
  })
  const report = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const disabled = await diagnoseConnector({
    configOverrides: fixturePolicy(),
    nodeVersion: "22.14.0",
  })
  const omitted = await prepareSetup({
    configOverrides: fixturePolicy({
      capabilities: {
        embedMessages: true,
      },
      scopes: {
        embedMessageChannelIds: [CHANNEL_ID],
      },
      tools: {
        toolsets: ["connector"],
      },
    }),
    service: statusProvider(),
  })
  const missingIntent = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
    online: true,
    service: {
      async getStatus() {
        return status(1, "disabled")
      },
    },
  })
  const missingIntentSetup = await prepareSetup({
    configOverrides: enabledPolicy,
    service: {
      async getStatus() {
        return status(1, "unknown")
      },
    },
  })

  const embedMessage = report.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.embedMessagePolicy,
  )
  assert.equal(embedMessage?.status, "pass")
  assert.match(embedMessage?.summary || "", /1 channels/)
  assert.match(embedMessage?.summary || "", /shared 12-write rolling budget/)
  assert.match(
    disabled.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.embedMessagePolicy,
    )?.summary || "",
    /disabled/,
  )
  assert.match(omitted.warnings.join("\n"), /embed-messages toolset/)
  assert.equal(
    missingIntent.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.messageContentIntent,
    )?.status,
    "fail",
  )
  assert.match(missingIntentSetup.warnings.join("\n"), /rich-embed messages are blocked/)
})

test("doctor and setup explain exact-user private-message boundaries without contact", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      directMessageAudit: true,
      directMessageDeletion: true,
      directMessageDelivery: true,
      directMessageEditing: true,
    },
    scopes: {
      directMessageUserIds: [USER_ID],
    },
  })
  const report = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: enabledPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: { toolsets: ["connector"] },
    },
    service: statusProvider(),
  })

  const audit = report.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.directMessageAuditPolicy,
  )
  const attachment = report.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.directMessageAttachmentPolicy,
  )
  const delivery = report.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.directMessageDeliveryPolicy,
  )
  const editing = report.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.directMessageEditingPolicy,
  )
  const deletion = report.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.directMessageDeletionPolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /caller-known one-to-one channel IDs/)
  assert.match(audit?.summary || "", /normalized static Components V2/)
  assert.match(audit?.summary || "", /no DM discovery/)
  assert.match(audit?.summary || "", /no persistence/)
  assert.equal(attachment?.status, "pass")
  assert.match(attachment?.summary || "", /owned-file delivery is disabled/)
  assert.equal(delivery?.status, "pass")
  assert.match(delivery?.summary || "", /plain-text or static Components V2/)
  assert.match(delivery?.summary || "", /forced empty mentions/)
  assert.match(delivery?.summary || "", /request-bound schema-v2 receipts/)
  assert.equal(editing?.status, "pass")
  assert.match(editing?.summary || "", /same-format connector-authored/)
  assert.equal(deletion?.status, "pass")
  assert.match(deletion?.summary || "", /static Components V2/)
  assert.match(deletion?.summary || "", /single-attachment messages/)
  assert.match(deletion?.summary || "", /irreversible acknowledgement/)
  assert.equal(setup.warnings.some((warning) => warning.includes("direct-messages toolset")), false)
  assert.match(omitted.warnings.join("\n"), /direct-messages toolset/)
})

test("doctor explains independently gated private-file delivery without reading files", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "guildcontrol-operator-private-attachment-"))
  context.after(() => rm(temporary, { force: true, recursive: true }))
  const root = await realpath(temporary)
  const report = await diagnoseConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        directMessageAttachments: true,
        directMessageDelivery: true,
      },
      limits: { attachmentMaxBytes: 4_096 },
      scopes: { directMessageUserIds: [USER_ID] },
      storage: { attachmentRoots: [root] },
    }),
    nodeVersion: "22.14.0",
  })
  const attachment = report.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.directMessageAttachmentPolicy,
  )

  assert.equal(attachment?.status, "pass")
  assert.match(attachment?.summary || "", /1 exact users/)
  assert.match(attachment?.summary || "", /1 canonical roots/)
  assert.match(attachment?.summary || "", /4096-byte ceiling/)
  assert.match(attachment?.summary || "", /non-retried multipart upload/)
  assert.match(attachment?.summary || "", /URL-free readback/)
  assert.doesNotMatch(attachment?.summary || "", new RegExp(root))
})

test("doctor and setup explain reviewed attachment scope without reading files or writing to Discord", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "guildcontrol-operator-attachment-"))
  context.after(() => rm(temporary, { force: true, recursive: true }))
  const root = await realpath(temporary)
  const enabled = await diagnoseConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        attachments: true,
      },
      limits: {
        attachmentMaxBytes: 4096,
      },
      scopes: {
        attachmentChannelIds: [CHANNEL_ID],
      },
      storage: {
        attachmentRoots: [root],
      },
    }),
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      attachments: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: fixturePolicy({
      capabilities: {
        attachments: true,
      },
      scopes: {
        attachmentChannelIds: [CHANNEL_ID],
      },
      storage: {
        attachmentRoots: [root],
      },
      tools: {
        toolsets: ["connector"],
      },
    }),
    service: statusProvider(),
  })

  const attachment = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.attachmentPolicy,
  )
  assert.equal(attachment?.status, "pass")
  assert.match(attachment?.summary || "", /1 channels and 1 canonical roots/)
  assert.match(attachment?.summary || "", /4096-byte ceiling/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.attachmentPolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /attachment-channel allowlist/)
  assert.match(omitted.warnings.join("\n"), /attachments toolset/)
})

test("doctor and setup explain exact administration scope without Discord writes", async () => {
  const enabled = await diagnoseConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        administration: true,
      },
      scopes: {
        adminGuildIds: [GUILD_ID],
        protectedUserIds: ["400000000000000001"],
      },
    }),
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      administration: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })

  const administration = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.administrationPolicy,
  )
  assert.equal(administration?.status, "pass")
  assert.match(administration?.summary || "", /1 guilds with 1 protected users/)
  assert.match(administration?.summary || "", /durable exact-member coordination/)
  assert.match(administration?.summary || "", /exact fresh readback/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.administrationPolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /administration-guild allowlist/)
})

test("doctor and setup explain reviewed native bulk-ban boundaries without Discord writes", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      bulkBanAudit: true,
      bulkBans: true,
    },
    scopes: {
      bulkBanGuildIds: [GUILD_ID],
      protectedUserIds: ["400000000000000001"],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const omitted = await prepareSetup({
    configOverrides: fixturePolicy({
      capabilities: {
        bulkBanAudit: true,
        bulkBans: true,
      },
      scopes: {
        bulkBanGuildIds: [GUILD_ID],
      },
      tools: {
        toolsets: ["connector"],
      },
    }),
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.bulkBanAuditPolicy,
  )
  const changes = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.bulkBanChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /BAN_MEMBERS plus MANAGE_GUILD/)
  assert.match(audit?.summary || "", /per-target hierarchy checks/)
  assert.equal(changes?.status, "pass")
  assert.match(changes?.summary || "", /complete-set durable member claims/)
  assert.match(changes?.summary || "", /one non-retried native batch request/)
  assert.match(changes?.summary || "", /explicit partial outcomes/)
  assert.match(omitted.warnings.join("\n"), /bulk-bans toolset/)
})

test("doctor and setup explain bounded non-exact guild-prune boundaries without Discord writes", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      guildPruneAudit: true,
      guildPrunes: true,
    },
    limits: {
      guildPruneMaxMembers: 12,
    },
    scopes: {
      guildPruneGuildIds: [GUILD_ID],
      guildPruneIncludeRoleIds: ["300000000000000001"],
      protectedUserIds: ["400000000000000001"],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const omitted = await prepareSetup({
    configOverrides: fixturePolicy({
      capabilities: {
        guildPruneAudit: true,
        guildPrunes: true,
      },
      scopes: {
        guildPruneGuildIds: [GUILD_ID],
      },
      tools: {
        toolsets: ["connector"],
      },
    }),
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.guildPruneAuditPolicy,
  )
  const changes = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.guildPruneChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /1 exact guilds/)
  assert.match(audit?.summary || "", /1 optional include roles/)
  assert.match(audit?.summary || "", /12-member policy ceiling/)
  assert.match(audit?.summary || "", /KICK_MEMBERS plus MANAGE_GUILD/)
  assert.equal(changes?.status, "pass")
  assert.match(changes?.summary || "", /two pre-dispatch count ceilings/)
  assert.match(changes?.summary || "", /durable member-collection and exact-role claims/)
  assert.match(changes?.summary || "", /returned-count settlement/)
  assert.match(changes?.summary || "", /no exact-member or rollback claim/)
  assert.match(omitted.warnings.join("\n"), /guild-prunes toolset/)
})

test("doctor and setup explain reviewed channel-creation scope without Discord writes", async () => {
  const enabled = await diagnoseConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        channelCreation: true,
      },
      scopes: {
        channelCreationGuildIds: [GUILD_ID],
      },
    }),
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      channelCreation: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: fixturePolicy({
      capabilities: {
        channelCreation: true,
      },
      scopes: {
        channelCreationGuildIds: [GUILD_ID],
      },
      tools: {
        toolsets: ["connector"],
      },
    }),
    service: statusProvider(),
  })

  const creation = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.channelCreationPolicy,
  )
  assert.equal(creation?.status, "pass")
  assert.match(creation?.summary || "", /1 guilds with reviewed one-shot execution/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.channelCreationPolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /channel-creation guild allowlist/)
  assert.match(omitted.warnings.join("\n"), /channel-creation toolset/)
})

test("doctor and setup explain reviewed forum-post scope without Discord writes", async () => {
  const enabled = await diagnoseConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        forumPosts: true,
      },
      scopes: {
        forumPostChannelIds: [CHANNEL_ID],
      },
    }),
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      forumPosts: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: fixturePolicy({
      capabilities: {
        forumPosts: true,
      },
      scopes: {
        forumPostChannelIds: [CHANNEL_ID],
      },
      tools: {
        toolsets: ["connector"],
      },
    }),
    service: statusProvider(),
  })

  const forumPost = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.forumPostPolicy,
  )
  assert.equal(forumPost?.status, "pass")
  assert.match(forumPost?.summary || "", /1 exact channels/)
  assert.match(forumPost?.summary || "", /exact readback/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.forumPostPolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /forum-channel allowlist/)
  assert.match(omitted.warnings.join("\n"), /forum-posts toolset/)
})

test("doctor and setup explain exact forum-tag scope without Discord writes", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      forumTagAudit: true,
      forumTagChanges: true,
    },
    scopes: {
      forumTagChannelIds: [CHANNEL_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      forumTagAudit: true,
      forumTagChanges: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: fixturePolicy({
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    }),
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.forumTagAuditPolicy,
  )
  const change = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.forumTagChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /1 exact stable forums/)
  assert.match(audit?.summary || "", /no post enumeration/)
  assert.equal(change?.status, "pass")
  assert.match(change?.summary || "", /one non-retried replacement/)
  assert.match(change?.summary || "", /fresh readback/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.forumTagAuditPolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.forumTagChangePolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /stable-forum allowlist/)
  assert.match(omitted.warnings.join("\n"), /forum-tags toolset/)
})

test("doctor and setup explain reviewed thread-creation scope without Discord writes", async () => {
  const enabled = await diagnoseConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        threadCreation: true,
      },
      scopes: {
        threadParentIds: [CHANNEL_ID],
      },
    }),
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      threadCreation: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: fixturePolicy({
      capabilities: {
        threadCreation: true,
      },
      scopes: {
        threadParentIds: [CHANNEL_ID],
      },
      tools: {
        toolsets: ["connector"],
      },
    }),
    service: statusProvider(),
  })

  const threadCreation = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.threadCreationPolicy,
  )
  assert.equal(threadCreation?.status, "pass")
  assert.match(threadCreation?.summary || "", /1 exact parents/)
  assert.match(threadCreation?.summary || "", /anchored recovery/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.threadCreationPolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /parent-channel allowlist/)
  assert.match(omitted.warnings.join("\n"), /threads toolset/)
})

test("doctor and setup explain privacy-safe reviewed thread governance", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      threadAudit: true,
      threadChanges: true,
    },
    scopes: {
      threadGuildIds: [GUILD_ID],
      threadIds: [CHANNEL_ID],
      threadMemberUserIds: [BOT_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      threadAudit: true,
      threadChanges: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.threadAuditPolicy,
  )
  const change = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.threadChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /without member enumeration or persistence/)
  assert.equal(change?.status, "pass")
  assert.match(change?.summary || "", /uncertainty quarantine/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.threadAuditPolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.threadChangePolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /exact guild and thread allowlists/)
  assert.match(omitted.warnings.join("\n"), /thread-governance toolset/)
  assertDefaultSecretForwarding(setup)
})

test("doctor and setup explain reviewed message-pin scope without Discord writes", async () => {
  const enabled = await diagnoseConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        pinManagement: true,
      },
      scopes: {
        pinChannelIds: [CHANNEL_ID],
      },
    }),
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      pinManagement: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: fixturePolicy({
      capabilities: {
        pinManagement: true,
      },
      scopes: {
        pinChannelIds: [CHANNEL_ID],
      },
      tools: {
        toolsets: ["connector"],
      },
    }),
    service: statusProvider(),
  })

  const messagePin = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.messagePinPolicy,
  )
  assert.equal(messagePin?.status, "pass")
  assert.match(messagePin?.summary || "", /1 exact channels/)
  assert.match(messagePin?.summary || "", /exact state plus review-snapshot readback/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.messagePinPolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /pin-channel allowlist/)
  assert.match(omitted.warnings.join("\n"), /pins toolset/)
})

test("doctor and setup explain privacy-safe reaction audit and moderation", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      reactionModeration: true,
      reactionUserAudit: true,
    },
    scopes: {
      reactionChannelIds: [CHANNEL_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const disabled = await diagnoseConnector({
    configOverrides: fixturePolicy(),
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: enabledPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const userAudit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.reactionUserAuditPolicy,
  )
  const moderation = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.reactionModerationPolicy,
  )
  assert.equal(userAudit?.status, "pass")
  assert.match(userAudit?.summary || "", /bounded ID-and-bot-only pages/)
  assert.equal(moderation?.status, "pass")
  assert.match(moderation?.summary || "", /exact-message coordination/)
  assert.match(moderation?.summary || "", /target-absence readback/)
  assert.match(
    disabled.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.reactionUserAuditPolicy,
    )?.summary || "",
    /aggregate reaction reads remain available/,
  )
  assert.match(omitted.warnings.join("\n"), /interactions toolset/)
  assertDefaultSecretForwarding(setup)
})

test("doctor and setup enforce reviewed announcement-crosspost prerequisites", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      announcementCrossposts: true,
    },
    scopes: {
      announcementCrosspostChannelIds: [CHANNEL_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      announcementCrossposts: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })
  const omittedMissingIntent = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: {
      async getStatus() {
        return status(1, "disabled")
      },
    },
  })
  const missingIntent = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
    online: true,
    service: {
      async getStatus() {
        return status(1, "unknown")
      },
    },
  })
  const missingIntentSetup = await prepareSetup({
    configOverrides: enabledPolicy,
    service: {
      async getStatus() {
        return status(1, "disabled")
      },
    },
  })

  const policy = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.announcementCrosspostPolicy,
  )
  assert.equal(policy?.status, "pass")
  assert.match(policy?.summary || "", /authorship-sensitive permission proof/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.announcementCrosspostPolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /announcement-channel allowlist/)
  assert.match(omitted.warnings.join("\n"), /announcement-crossposts toolset/)
  assert.doesNotMatch(
    omittedMissingIntent.warnings.join("\n"),
    /Message Content intent/,
  )
  assert.equal(
    missingIntent.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.messageContentIntent,
    )?.status,
    "fail",
  )
  assert.equal(missingIntent.status, "error")
  assert.match(missingIntentSetup.warnings.join("\n"), /crossposts are blocked/)
  assert.match(missingIntentSetup.warnings.join("\n"), /native search may be unavailable/)
  assertDefaultSecretForwarding(setup)
})

test("doctor and setup explain reviewed message-forward scope and intent gates", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      messageForwarding: true,
    },
    readScope: {
      channelIds: [CHANNEL_ID, SOURCE_CHANNEL_ID],
    },
    scopes: {
      messageForwardSourceChannelIds: [SOURCE_CHANNEL_ID],
      messageForwardTargetChannelIds: [CHANNEL_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: enabledPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })
  const missingIntent = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
    online: true,
    service: {
      async getStatus() {
        return status(1, "disabled")
      },
    },
  })
  const missingIntentSetup = await prepareSetup({
    configOverrides: enabledPolicy,
    service: {
      async getStatus() {
        return status(1, "unknown")
      },
    },
  })

  const policy = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.messageForwardPolicy,
  )
  assert.equal(policy?.status, "pass")
  assert.match(policy?.summary || "", /forced empty mentions/)
  assert.match(policy?.summary || "", /age-restriction downgrade prevention/)
  assert.match(policy?.summary || "", /immutable-snapshot validation/)
  assert.match(omitted.warnings.join("\n"), /message-forwarding toolset/)
  assert.equal(
    missingIntent.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.messageContentIntent,
    )?.status,
    "fail",
  )
  assert.match(missingIntentSetup.warnings.join("\n"), /message forwarding.*blocked/)
  assertDefaultSecretForwarding(setup)
})

test("doctor and setup explain announcement-subscription scope and review gates", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      announcementSubscriptionAudit: true,
      announcementSubscriptionChanges: true,
    },
    readScope: {
      channelIds: [CHANNEL_ID, SOURCE_CHANNEL_ID],
    },
    scopes: {
      announcementSubscriptionSourceChannelIds: [SOURCE_CHANNEL_ID],
      announcementSubscriptionTargetChannelIds: [CHANNEL_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const auditWarning = await diagnoseConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        announcementSubscriptionAudit: true,
      },
    }),
    nodeVersion: "22.14.0",
  })
  const changeWarningPolicy = fixturePolicy({
    capabilities: {
      announcementSubscriptionAudit: true,
      announcementSubscriptionChanges: true,
    },
    scopes: {
      announcementSubscriptionTargetChannelIds: [CHANNEL_ID],
    },
  })
  const changeWarning = await diagnoseConnector({
    configOverrides: changeWarningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: changeWarningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.announcementSubscriptionAuditPolicy,
  )
  const changes = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.announcementSubscriptionChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /unrelated webhook IDs omitted/)
  assert.match(audit?.summary || "", /no message access/)
  assert.equal(changes?.status, "pass")
  assert.match(changes?.summary || "", /duplicate and capacity checks/)
  assert.match(changes?.summary || "", /one non-retried mutation/)
  assert.equal(
    auditWarning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.announcementSubscriptionAuditPolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    changeWarning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.announcementSubscriptionChangePolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /source-channel allowlist/)
  assert.match(omitted.warnings.join("\n"), /announcement-subscriptions toolset/)
  assertDefaultSecretForwarding(setup)
})

test("doctor and setup explain native poll privacy and reviewed write scope", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      pollAudit: true,
      pollCreation: true,
      pollEnding: true,
      pollVoterAudit: true,
    },
    scopes: {
      pollChannelIds: [CHANNEL_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      pollAudit: true,
      pollCreation: true,
      pollEnding: true,
      pollVoterAudit: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const expected = [
    [DOCTOR_CHECK_IDS.pollAuditPolicy, /bounded transient aggregate results/],
    [DOCTOR_CHECK_IDS.pollVoterAuditPolicy, /bounded ID-only pages/],
    [DOCTOR_CHECK_IDS.pollCreationPolicy, /nonce-bound one-shot execution/],
    [DOCTOR_CHECK_IDS.pollEndPolicy, /live-count-bound approval/],
  ] as const
  for (const [id, summary] of expected) {
    const entry = enabled.checks.find((check) => check.id === id)
    assert.equal(entry?.status, "pass")
    assert.match(entry?.summary || "", summary)
    assert.equal(
      warning.checks.find((check) => check.id === id)?.status,
      "warn",
    )
  }
  assert.match(setup.warnings.join("\n"), /poll-channel allowlist/)
  assert.match(omitted.warnings.join("\n"), /polls toolset/)
  assertDefaultSecretForwarding(setup)
})

test("doctor and setup explain credential-safe webhook administration and messages", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "guildcontrol-webhook-operator-"))
  context.after(() => rm(temporary, { force: true, recursive: true }))
  const webhookCredentialRoot = await realpath(temporary)
  const enabledPolicy = fixturePolicy({
    capabilities: {
      webhookAudit: true,
      webhookChanges: true,
      webhookCreation: true,
      webhookDeletions: true,
      webhookMessageAudit: true,
      webhookMessageChanges: true,
      webhookMessageDeletions: true,
      webhookMessageDelivery: true,
    },
    scopes: {
      webhookChannelIds: [CHANNEL_ID],
      webhookMessageChannelIds: [CHANNEL_ID],
    },
    storage: {
      webhookCredentialRoot,
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      webhookAudit: true,
      webhookChanges: true,
      webhookCreation: true,
      webhookDeletions: true,
      webhookMessageAudit: true,
      webhookMessageChanges: true,
      webhookMessageDeletions: true,
      webhookMessageDelivery: true,
    },
    storage: {
      webhookCredentialRoot,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const guildAuditPolicy = fixturePolicy({
    capabilities: {
      webhookAudit: true,
    },
    scopes: {
      webhookGuildIds: [GUILD_ID],
    },
  })
  const guildAudit = await diagnoseConnector({
    configOverrides: guildAuditPolicy,
    nodeVersion: "22.14.0",
  })
  const guildAuditSetup = await prepareSetup({
    configOverrides: guildAuditPolicy,
    service: statusProvider(),
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.webhookAuditPolicy,
  )
  const deletion = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.webhookDeletionPolicy,
  )
  const creation = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.webhookCreationPolicy,
  )
  const change = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.webhookChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /credential-redacted webhook inventory/i)
  assert.match(audit?.summary || "", /1 exact channels/)
  const guildAuditCheck = guildAudit.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.webhookAuditPolicy,
  )
  assert.equal(guildAuditCheck?.status, "pass")
  assert.match(guildAuditCheck?.summary || "", /0 exact channels and 1 exact guilds/)
  assert.doesNotMatch(guildAuditSetup.warnings.join("\n"), /webhook-audit toggle/)
  assert.equal(deletion?.status, "pass")
  assert.match(deletion?.summary || "", /Incoming-webhook deletion/)
  assert.match(deletion?.summary || "", /one-shot execution and absence readback/)
  assert.equal(creation?.status, "pass")
  assert.match(creation?.summary || "", /Incoming-webhook creation/)
  assert.match(creation?.summary || "", /private credential custody/)
  assert.equal(change?.status, "pass")
  assert.match(change?.summary || "", /rename and same-guild move/)
  assert.match(change?.summary || "", /complete inventory readback/)
  const messageChecks = [
    [DOCTOR_CHECK_IDS.webhookMessageAuditPolicy, /no content persistence/],
    [DOCTOR_CHECK_IDS.webhookMessageDeliveryPolicy, /mention containment/],
    [DOCTOR_CHECK_IDS.webhookMessageChangePolicy, /exact readback/],
    [DOCTOR_CHECK_IDS.webhookMessageDeletionPolicy, /signed approval/],
  ] as const
  for (const [id, summary] of messageChecks) {
    const entry = enabled.checks.find((check) => check.id === id)
    assert.equal(entry?.status, "pass")
    assert.match(entry?.summary || "", summary)
    assert.equal(
      warning.checks.find((check) => check.id === id)?.status,
      "warn",
    )
  }
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.webhookAuditPolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.webhookDeletionPolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.webhookCreationPolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.webhookChangePolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /webhook-audit toggle/)
  assert.match(setup.warnings.join("\n"), /webhook-change toggle/)
  assert.match(setup.warnings.join("\n"), /webhook-creation toggle/)
  assert.match(setup.warnings.join("\n"), /webhook-deletion toggle/)
  assert.match(setup.warnings.join("\n"), /webhook-message-audit toggle/)
  assert.match(setup.warnings.join("\n"), /webhook-message-delivery toggle/)
  assert.match(setup.warnings.join("\n"), /webhook-message-change toggle/)
  assert.match(setup.warnings.join("\n"), /webhook-message-deletion toggle/)
  assert.match(omitted.warnings.join("\n"), /webhooks toolset/)
  assertDefaultSecretForwarding(setup)
})

test("doctor and setup explain privacy-safe integration audit and deletion", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      integrationAudit: true,
      integrationDeletions: true,
    },
    scopes: {
      integrationGuildIds: [GUILD_ID],
      integrationIds: [INTEGRATION_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      integrationAudit: true,
      integrationDeletions: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.integrationAuditPolicy,
  )
  const deletion = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.integrationDeletionPolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /privacy-safe integration inventory/i)
  assert.match(audit?.summary || "", /MANAGE_GUILD/)
  assert.equal(deletion?.status, "pass")
  assert.match(deletion?.summary || "", /1 exact integrations/)
  assert.match(deletion?.summary || "", /side-effect acknowledgments/)
  assert.match(deletion?.summary || "", /full-inventory readback/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.integrationAuditPolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.integrationDeletionPolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /integration-audit toggle/)
  assert.match(setup.warnings.join("\n"), /integration-deletion toggle/)
  assert.match(omitted.warnings.join("\n"), /integrations toolset/)
  assertDefaultSecretForwarding(setup)
})

test("doctor and setup explain reviewed guild departure", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: { guildDepartures: true },
    scopes: { guildDepartureGuildIds: [GUILD_ID] },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: enabledPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: { toolsets: ["connector"] },
    },
    service: statusProvider(),
  })

  const departure = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.guildDeparturePolicy,
  )
  assert.equal(departure?.status, "pass")
  assert.match(departure?.summary || "", /1 exact guilds/)
  assert.match(departure?.summary || "", /non-owner evidence/)
  assert.match(departure?.summary || "", /access-loss, re-entry, and quiescence/)
  assert.match(departure?.summary || "", /complete absence readback/)
  assert.doesNotMatch(setup.warnings.join("\n"), /guild-departure toggle/)
  assert.match(omitted.warnings.join("\n"), /guild-departure toolset/)
  assertDefaultSecretForwarding(setup)
})

test("doctor and setup explain capability-safe invite creation, audit, and revocation", async (context) => {
  const capabilityRoot = await realpath(await mkdtemp(join(tmpdir(), "guildcontrol-invite-capabilities-")))
  context.after(() => rm(capabilityRoot, { recursive: true, force: true }))
  const enabledPolicy = fixturePolicy({
    capabilities: {
      inviteAudit: true,
      inviteCreation: true,
      inviteDeletions: true,
      inviteRoleAssignment: true,
    },
    gateway: { enabled: true },
    scopes: {
      inviteCreationChannelIds: [CHANNEL_ID],
      inviteGuildIds: [GUILD_ID],
      inviteRoleIds: [ROLE_ID],
    },
    storage: {
      inviteCapabilityRoots: [capabilityRoot],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      inviteAudit: true,
      inviteDeletions: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.inviteAuditPolicy,
  )
  const deletion = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.inviteDeletionPolicy,
  )
  const creation = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.inviteCreationPolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /opaque references/)
  assert.match(audit?.summary || "", /MANAGE_GUILD/)
  assert.equal(deletion?.status, "pass")
  assert.match(deletion?.summary || "", /one-shot execution/)
  assert.match(deletion?.summary || "", /full-inventory absence readback/)
  assert.equal(creation?.status, "pass")
  assert.match(creation?.summary || "", /1 exact channels and 1 private-file roots/)
  assert.match(creation?.summary || "", /VIEW_CHANNEL and CREATE_INSTANT_INVITE/)
  assert.match(creation?.summary || "", /conditional MANAGE_GUILD/)
  assert.match(creation?.summary || "", /explicit finite acceptance/)
  assert.match(creation?.summary || "", /delivery after verification/)
  assert.match(creation?.summary || "", /exclusive 0600 delivery/)
  assert.match(creation?.summary || "", /no invite capability in MCP results or lifecycle records/)
  assert.match(creation?.summary || "", /1 exact roles/)
  assert.match(creation?.summary || "", /complete Gateway channel evidence/)
  assert.match(creation?.summary || "", /MANAGE_ROLES/)
  assert.match(creation?.summary || "", /minimum new-member impact review/)
  assert.match(creation?.summary || "", /persistence acknowledgement/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.inviteAuditPolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.inviteDeletionPolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /invite-audit toggle/)
  assert.match(setup.warnings.join("\n"), /invite-deletion toggle/)
  assert.match(omitted.warnings.join("\n"), /invites toolset/)
})

test("doctor and setup explain privacy-safe reviewed onboarding", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      onboardingAudit: true,
      onboardingChanges: true,
    },
    scopes: {
      onboardingGuildIds: [GUILD_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      onboardingAudit: true,
      onboardingChanges: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.onboardingAuditPolicy,
  )
  const change = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.onboardingChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /default text omission/)
  assert.match(audit?.summary || "", /future-field counts only/)
  assert.equal(change?.status, "pass")
  assert.match(change?.summary || "", /complete-state review/)
  assert.match(change?.summary || "", /signed approval/)
  assert.match(change?.summary || "", /authoritative response plus API readback/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.onboardingAuditPolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.onboardingChangePolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /onboarding-audit toggle/)
  assert.match(setup.warnings.join("\n"), /onboarding-change toggle/)
  assert.match(omitted.warnings.join("\n"), /onboarding toolset/)
})

test("doctor and setup explain privacy-safe reviewed Welcome Screens", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      welcomeScreenAudit: true,
      welcomeScreenChanges: true,
    },
    scopes: {
      welcomeScreenGuildIds: [GUILD_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      welcomeScreenAudit: true,
      welcomeScreenChanges: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.welcomeScreenAuditPolicy,
  )
  const change = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.welcomeScreenChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /default text omission/)
  assert.match(audit?.summary || "", /future-field counts only/)
  assert.equal(change?.status, "pass")
  assert.match(change?.summary || "", /complete-state review/)
  assert.match(change?.summary || "", /signed approval/)
  assert.match(change?.summary || "", /authoritative response plus API readback/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.welcomeScreenAuditPolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.welcomeScreenChangePolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /Welcome Screen audit toggle/)
  assert.match(setup.warnings.join("\n"), /Welcome Screen change toggle/)
  assert.match(omitted.warnings.join("\n"), /welcome-screen toolset/)
})

test("doctor and setup explain authenticated reviewed widget settings", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      widgetPublicExposure: true,
      widgetSettingsAudit: true,
      widgetSettingsChanges: true,
    },
    scopes: {
      widgetSettingsGuildIds: [GUILD_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      widgetPublicExposure: true,
      widgetSettingsAudit: true,
      widgetSettingsChanges: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.widgetSettingsAuditPolicy,
  )
  const change = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.widgetSettingsChangePolicy,
  )
  const exposure = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.widgetPublicExposurePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /no anonymous endpoint calls/)
  assert.match(audit?.summary || "", /unknown-field counts only/)
  assert.equal(change?.status, "pass")
  assert.match(change?.summary || "", /complete-state review/)
  assert.match(change?.summary || "", /signed approval/)
  assert.match(change?.summary || "", /authoritative response plus API readback/)
  assert.equal(exposure?.status, "pass")
  assert.match(exposure?.summary || "", /enabling the widget/)
  assert.match(exposure?.summary || "", /different non-null channel/)
  for (const id of [
    DOCTOR_CHECK_IDS.widgetSettingsAuditPolicy,
    DOCTOR_CHECK_IDS.widgetSettingsChangePolicy,
    DOCTOR_CHECK_IDS.widgetPublicExposurePolicy,
  ]) {
    assert.equal(
      warning.checks.find((entry) => entry.id === id)?.status,
      "warn",
    )
  }
  assert.match(setup.warnings.join("\n"), /widget-settings audit toggle/)
  assert.match(setup.warnings.join("\n"), /widget-settings change toggle/)
  assert.match(setup.warnings.join("\n"), /widget public-exposure toggle/)
  assert.match(omitted.warnings.join("\n"), /widget-settings toolset/)
  assertDefaultSecretForwarding(setup)
  assert.doesNotMatch(JSON.stringify(enabled), /private-channel|audit reason/u)
})

test("doctor and setup explain privacy-minimized reviewed guild settings", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      guildSettingsAudit: true,
      guildSettingsChanges: true,
    },
    scopes: {
      guildSettingsGuildIds: [GUILD_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const disabled = await diagnoseConnector({
    configOverrides: fixturePolicy(),
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: enabledPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.guildSettingsAuditPolicy,
  )
  const change = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.guildSettingsChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /continuity-safe channel evidence/)
  assert.match(audit?.summary || "", /named privacy-minimized state/)
  assert.equal(change?.status, "pass")
  assert.match(change?.summary || "", /sparse named-field review/)
  assert.match(change?.summary || "", /signed approval/)
  assert.match(change?.summary || "", /authoritative response plus API readback/)
  assert.match(
    disabled.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.guildSettingsAuditPolicy,
    )?.summary || "",
    /audit is disabled/,
  )
  assert.match(omitted.warnings.join("\n"), /guild-settings toolset/)
  assertDefaultSecretForwarding(setup)
  assert.doesNotMatch(JSON.stringify(enabled), /guild name|channel name|audit reason/u)
})

test("doctor and setup explain reviewed monotonic guild Community changes", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      guildCommunityAudit: true,
      guildCommunityChanges: true,
    },
    scopes: {
      guildCommunityGuildIds: [GUILD_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const disabled = await diagnoseConnector({
    configOverrides: fixturePolicy(),
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: enabledPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.guildCommunityAuditPolicy,
  )
  const change = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.guildCommunityChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /verified identity/u)
  assert.match(audit?.summary || "", /content-free feature digests/u)
  assert.match(audit?.summary || "", /exact routing IDs/u)
  assert.equal(change?.status, "pass")
  assert.match(change?.summary || "", /monotonic feature preservation/u)
  assert.match(change?.summary || "", /ADMINISTRATOR or MANAGE_GUILD/u)
  assert.match(change?.summary || "", /signed approval/u)
  assert.match(change?.summary || "", /authoritative response plus API readback/u)
  assert.match(
    disabled.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.guildCommunityAuditPolicy,
    )?.summary || "",
    /audit is disabled/u,
  )
  assert.match(omitted.warnings.join("\n"), /guild-community toolset/u)
  assertDefaultSecretForwarding(setup)
  assert.doesNotMatch(
    JSON.stringify(enabled),
    /guild name|channel name|feature value|audit reason/u,
  )
})

test("doctor and setup explain privacy-minimized reviewed guild incident actions", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      guildIncidentAudit: true,
      guildIncidentChanges: true,
    },
    scopes: {
      guildIncidentGuildIds: [GUILD_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const disabled = await diagnoseConnector({
    configOverrides: fixturePolicy(),
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: enabledPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.guildIncidentAuditPolicy,
  )
  const change = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.guildIncidentChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /boolean-only detection evidence/)
  assert.match(audit?.summary || "", /unknown-field counts/)
  assert.match(audit?.summary || "", /MANAGE_GUILD authority/)
  assert.equal(change?.status, "pass")
  assert.match(change?.summary || "", /sparse 24-hour review/)
  assert.match(change?.summary || "", /local-only reason binding/)
  assert.match(change?.summary || "", /non-retried one-shot execution/)
  assert.match(change?.summary || "", /strict response plus fresh readback/)
  assert.match(
    disabled.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.guildIncidentAuditPolicy,
    )?.summary || "",
    /audit is disabled/,
  )
  assert.match(omitted.warnings.join("\n"), /guild-incidents toolset/)
  assertDefaultSecretForwarding(setup)
  assert.doesNotMatch(
    JSON.stringify(enabled),
    /detection timestamp|disabled-until value|audit reason/u,
  )
})

test("doctor and setup explain transient reviewed guild profile text", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      guildProfileAudit: true,
      guildProfileChanges: true,
    },
    scopes: {
      guildProfileGuildIds: [GUILD_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const disabled = await diagnoseConnector({
    configOverrides: fixturePolicy(),
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: enabledPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.guildProfileAuditPolicy,
  )
  const change = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.guildProfileChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /transient text/)
  assert.match(audit?.summary || "", /presence-only media/)
  assert.match(audit?.summary || "", /complete permission evidence/)
  assert.equal(change?.status, "pass")
  assert.match(change?.summary || "", /sparse text-field review/)
  assert.match(change?.summary || "", /signed approval/)
  assert.match(change?.summary || "", /exact readback/)
  assert.match(
    disabled.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.guildProfileAuditPolicy,
    )?.summary || "",
    /audit is disabled/,
  )
  assert.match(omitted.warnings.join("\n"), /guild-profile toolset/)
  assertDefaultSecretForwarding(setup)
  assert.doesNotMatch(
    JSON.stringify(enabled),
    /guild profile text|guild name|description value|audit reason/u,
  )
})

test("doctor and setup explain reviewed exact-channel metadata changes", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      channelMetadataChanges: true,
    },
    readScope: {
      channelIds: [CHANNEL_ID],
    },
    scopes: {
      channelMetadataIds: [CHANNEL_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      channelMetadataChanges: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const policy = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.channelMetadataPolicy,
  )
  assert.equal(policy?.status, "pass")
  assert.match(policy?.summary || "", /1 exact channels/)
  assert.match(policy?.summary || "", /partial one-shot execution/)
  assert.match(policy?.summary || "", /complete response plus fresh readback/)
  const voiceStatus = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.voiceChannelStatusPolicy,
  )
  assert.equal(voiceStatus?.status, "pass")
  assert.match(voiceStatus?.summary || "", /1 exact metadata-scope candidates/)
  assert.match(voiceStatus?.summary || "", /ordinary voice type at read time/)
  assert.match(voiceStatus?.summary || "", /connection-sensitive permission proof/)
  assert.match(voiceStatus?.summary || "", /GUILDS-only Gateway channel-info evidence/)
  const gateway = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.gatewayPolicy,
  )
  assert.match(gateway?.summary || "", /1 exact voice-status candidates/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.channelMetadataPolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.voiceChannelStatusPolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /channel-metadata toggle/)
  assert.match(omitted.warnings.join("\n"), /channel-metadata toolset/)
})

test("doctor and setup explain privacy-safe reviewed guild expression scope", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "guildcontrol-expressions-"))
  context.after(() => rm(root, { force: true, recursive: true }))
  const canonicalRoot = await realpath(root)
  const enabledPolicy = fixturePolicy({
    capabilities: {
      guildExpressionAudit: true,
      guildExpressionChanges: true,
    },
    scopes: {
      guildExpressionGuildIds: [GUILD_ID],
    },
    storage: {
      guildExpressionRoots: [canonicalRoot],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const missingGuildPolicy = fixturePolicy({
    capabilities: {
      guildExpressionAudit: true,
      guildExpressionChanges: true,
    },
  })
  const missingGuild = await diagnoseConnector({
    configOverrides: missingGuildPolicy,
    nodeVersion: "22.14.0",
  })
  const missingRootPolicy = fixturePolicy({
    capabilities: {
      guildExpressionAudit: true,
      guildExpressionChanges: true,
    },
    scopes: {
      guildExpressionGuildIds: [GUILD_ID],
    },
  })
  const missingRoot = await diagnoseConnector({
    configOverrides: missingRootPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: missingRootPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.guildExpressionAuditPolicy,
  )
  const changes = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.guildExpressionChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /privacy-safe guild emoji and sticker inventory/i)
  assert.match(audit?.summary || "", /1 exact guilds/)
  assert.equal(changes?.status, "pass")
  assert.match(changes?.summary || "", /1 canonical creation roots/)
  assert.match(changes?.summary || "", /exact metadata or absence readback/)
  assert.equal(
    missingGuild.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.guildExpressionAuditPolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    missingGuild.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.guildExpressionChangePolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    missingRoot.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.guildExpressionChangePolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /creation remains blocked/)
  assert.match(omitted.warnings.join("\n"), /guild-expressions toolset/)
})

test("doctor and setup explain identity-bound reviewed application emoji scope", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "guildcontrol-application-emojis-"))
  context.after(() => rm(root, { force: true, recursive: true }))
  const canonicalRoot = await realpath(root)
  const enabledPolicy = fixturePolicy({
    capabilities: {
      applicationEmojiAudit: true,
      applicationEmojiChanges: true,
    },
    storage: {
      applicationEmojiRoots: [canonicalRoot],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const missingRootPolicy = fixturePolicy({
    capabilities: {
      applicationEmojiAudit: true,
      applicationEmojiChanges: true,
    },
  })
  const missingRoot = await diagnoseConnector({
    configOverrides: missingRootPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: missingRootPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.applicationEmojiAuditPolicy,
  )
  const changes = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.applicationEmojiChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /verified pinned current application/)
  assert.equal(changes?.status, "pass")
  assert.match(changes?.summary || "", /application-wide coordination/)
  assert.match(changes?.summary || "", /1 canonical creation roots/)
  assert.equal(
    missingRoot.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.applicationEmojiChangePolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /creation remains blocked/)
  assert.match(omitted.warnings.join("\n"), /application-emojis toolset/)
})

test("doctor and setup explain identity-bound reviewed bot-profile scope", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "guildcontrol-bot-profile-"))
  context.after(() => rm(root, { force: true, recursive: true }))
  const canonicalRoot = await realpath(root)
  const enabledPolicy = fixturePolicy({
    capabilities: {
      botProfileAudit: true,
      botProfileChanges: true,
    },
    storage: {
      botProfileRoots: [canonicalRoot],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const missingRootPolicy = fixturePolicy({
    capabilities: {
      botProfileAudit: true,
      botProfileChanges: true,
    },
  })
  const missingRoot = await diagnoseConnector({
    configOverrides: missingRootPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: missingRootPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.botProfileAuditPolicy,
  )
  const changes = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.botProfileChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /pinned application and bot identities/u)
  assert.match(audit?.summary || "", /transient username/u)
  assert.equal(changes?.status, "pass")
  assert.match(changes?.summary || "", /fresh file evidence/u)
  assert.match(changes?.summary || "", /application-wide one-shot coordination/u)
  assert.match(changes?.summary || "", /independent exact editable-state readback/u)
  assert.match(changes?.summary || "", /1 canonical image roots/u)
  assert.equal(
    missingRoot.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.botProfileChangePolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /image replacement remains blocked/u)
  assert.match(omitted.warnings.join("\n"), /bot-profile toolset/u)
})

test("doctor and setup explain exact-beneficiary application monetization audit", async () => {
  const skuId = "610000000000000001"
  const enabledPolicy = fixturePolicy({
    capabilities: {
      applicationMonetizationAudit: true,
    },
    scopes: {
      applicationEntitlementGuildIds: [GUILD_ID],
      applicationEntitlementUserIds: [USER_ID],
      applicationMonetizationSkuIds: [skuId],
      applicationSubscriptionUserIds: [USER_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const disabled = await diagnoseConnector({
    configOverrides: fixturePolicy(),
    nodeVersion: "22.14.0",
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const check = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.applicationMonetizationAuditPolicy,
  )
  assert.equal(check?.status, "pass")
  assert.match(check?.summary || "", /1 exact current-application SKUs/)
  assert.match(check?.summary || "", /1 exact entitlement guild beneficiaries/)
  assert.match(check?.summary || "", /1 exact entitlement user beneficiaries/)
  assert.match(check?.summary || "", /1 exact subscription users/)
  assert.match(check?.summary || "", /entitlement-only access authority/)
  assert.match(check?.summary || "", /no persistence/)
  assert.match(check?.summary || "", /no monetization mutations/)
  assert.match(omitted.warnings.join("\n"), /application-monetization toolset/)
  assert.match(
    disabled.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.applicationMonetizationAuditPolicy,
    )?.summary || "",
    /disabled/,
  )
})

test("doctor and setup explain independently scoped application entitlement changes", async () => {
  const skuId = "610000000000000001"
  const enabledPolicy = fixturePolicy({
    capabilities: {
      applicationEntitlementConsumption: true,
      applicationTestEntitlementChanges: true,
    },
    scopes: {
      applicationConsumableEntitlementSkuIds: [skuId],
      applicationConsumableEntitlementUserIds: [USER_ID],
      applicationMonetizationSkuIds: [skuId],
      applicationTestEntitlementGuildIds: [GUILD_ID],
      applicationTestEntitlementSkuIds: [skuId],
      applicationTestEntitlementUserIds: [USER_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const disabled = await diagnoseConnector({
    configOverrides: fixturePolicy(),
    nodeVersion: "22.14.0",
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: { toolsets: ["connector"] },
    },
    service: statusProvider(),
  })

  const testChanges = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.applicationTestEntitlementChangePolicy,
  )
  assert.equal(testChanges?.status, "pass")
  assert.match(testChanges?.summary || "", /exact current-application subscription SKUs/u)
  assert.match(testChanges?.summary || "", /receipt-proven deletion/u)
  assert.match(testChanges?.summary || "", /content-free checkpoints/u)
  const consumption = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.applicationEntitlementConsumptionPolicy,
  )
  assert.equal(consumption?.status, "pass")
  assert.match(consumption?.summary || "", /external-fulfillment acknowledgement/u)
  assert.match(consumption?.summary || "", /hashed fulfillment references/u)
  assert.match(consumption?.summary || "", /exact consumed-state readback/u)
  assert.match(
    omitted.warnings.join("\n"),
    /application-entitlement-changes toolset/u,
  )
  assert.match(
    disabled.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.applicationTestEntitlementChangePolicy,
    )?.summary || "",
    /disabled/u,
  )
  assert.match(
    disabled.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.applicationEntitlementConsumptionPolicy,
    )?.summary || "",
    /disabled/u,
  )
})

test("doctor and setup explain reviewed guild application-command scope", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      applicationCommandChanges: true,
    },
    scopes: {
      applicationCommandGuildIds: [GUILD_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const disabled = await diagnoseConnector({
    configOverrides: fixturePolicy(),
    nodeVersion: "22.14.0",
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const check = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.applicationCommandChangePolicy,
  )
  assert.equal(check?.status, "pass")
  assert.match(check?.summary || "", /1 exact guilds/)
  assert.match(check?.summary || "", /complete typed definitions/)
  assert.match(check?.summary || "", /full-localization and permission-inventory review/)
  assert.match(check?.summary || "", /one non-retried write/)
  assert.match(check?.summary || "", /exact survivor readback/)
  assert.match(omitted.warnings.join("\n"), /application-commands toolset/)
  assert.match(
    disabled.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.applicationCommandChangePolicy,
    )?.summary || "",
    /disabled/,
  )
})

test("doctor and setup explain reviewed global application-command scope", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      globalApplicationCommandChanges: true,
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const disabled = await diagnoseConnector({
    configOverrides: fixturePolicy(),
    nodeVersion: "22.14.0",
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const check = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.globalApplicationCommandChangePolicy,
  )
  assert.equal(check?.status, "pass")
  assert.match(check?.summary || "", /verified pinned current application/)
  assert.match(check?.summary || "", /explicit installation contexts/)
  assert.match(check?.summary || "", /complete localized inventory review/)
  assert.match(check?.summary || "", /application-wide coordination/)
  assert.match(check?.summary || "", /one non-retried write/)
  assert.match(check?.summary || "", /exact survivor readback/)
  assert.match(omitted.warnings.join("\n"), /application-commands toolset/)
  assert.match(
    disabled.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.globalApplicationCommandChangePolicy,
    )?.summary || "",
    /disabled/,
  )
})

test("doctor and setup explain reviewed application linked-role metadata changes", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      applicationRoleConnectionMetadataChanges: true,
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const disabled = await diagnoseConnector({
    configOverrides: fixturePolicy(),
    nodeVersion: "22.14.0",
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const check = enabled.checks.find(
    (entry) => entry.id
      === DOCTOR_CHECK_IDS.applicationRoleConnectionMetadataChangePolicy,
  )
  assert.equal(check?.status, "pass")
  assert.match(check?.summary || "", /verified pinned current application/)
  assert.match(check?.summary || "", /maximum-five-record schemas/)
  assert.match(check?.summary || "", /label-free signed approval state/)
  assert.match(check?.summary || "", /one non-retried PUT/)
  assert.match(check?.summary || "", /independent readback verification/)
  assert.match(omitted.warnings.join("\n"), /linked-roles toolset/)
  assert.match(
    disabled.checks.find(
      (entry) => entry.id
        === DOCTOR_CHECK_IDS.applicationRoleConnectionMetadataChangePolicy,
    )?.summary || "",
    /disabled/,
  )
})

test("doctor and setup explain reviewed application privileged-intent enablement", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      applicationIntentChanges: true,
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const disabled = await diagnoseConnector({
    configOverrides: fixturePolicy(),
    nodeVersion: "22.14.0",
  })
  const inertPolicy = fixturePolicy({
    capabilities: {
      applicationIntentChanges: true,
    },
    tools: {
      toolsets: ["connector"],
    },
  })
  const inert = await diagnoseConnector({
    configOverrides: inertPolicy,
    nodeVersion: "22.14.0",
  })
  const omitted = await prepareSetup({
    configOverrides: inertPolicy,
    service: statusProvider(),
  })

  const enabledCheck = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.applicationIntentChangePolicy,
  )
  assert.equal(enabledCheck?.status, "pass")
  assert.match(enabledCheck?.summary || "", /additive-only/)
  assert.match(enabledCheck?.summary || "", /policy-justified/)
  assert.match(enabledCheck?.summary || "", /content-free audited/)
  assert.match(enabledCheck?.summary || "", /exact-readback verified/)
  const disabledCheck = disabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.applicationIntentChangePolicy,
  )
  assert.equal(disabledCheck?.status, "pass")
  assert.match(disabledCheck?.summary || "", /disabled/)
  const inertCheck = inert.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.applicationIntentChangePolicy,
  )
  assert.equal(inertCheck?.status, "warn")
  assert.match(inertCheck?.summary || "", /does not require or recommend/)
  assert.match(omitted.warnings.join("\n"), /no configured capability requires or recommends/)
  assert.match(omitted.warnings.join("\n"), /application-security toolset/)
})

test("doctor and setup explain privacy-safe reviewed scheduled event scope", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "guildcontrol-events-"))
  context.after(() => rm(root, { force: true, recursive: true }))
  const canonicalRoot = await realpath(root)
  const enabledPolicy = fixturePolicy({
    capabilities: {
      scheduledEventAudit: true,
      scheduledEventChanges: true,
      scheduledEventUserAudit: true,
    },
    scopes: {
      scheduledEventGuildIds: [GUILD_ID],
    },
    storage: {
      scheduledEventRoots: [canonicalRoot],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const missingGuildPolicy = fixturePolicy({
    capabilities: {
      scheduledEventAudit: true,
      scheduledEventChanges: true,
      scheduledEventUserAudit: true,
    },
  })
  const missingGuild = await diagnoseConnector({
    configOverrides: missingGuildPolicy,
    nodeVersion: "22.14.0",
  })
  const missingRootPolicy = fixturePolicy({
    capabilities: {
      scheduledEventAudit: true,
      scheduledEventChanges: true,
      scheduledEventUserAudit: true,
    },
    scopes: {
      scheduledEventGuildIds: [GUILD_ID],
    },
  })
  const missingRoot = await diagnoseConnector({
    configOverrides: missingRootPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: missingRootPolicy,
    service: statusProvider(),
  })
  const missingGuildSetup = await prepareSetup({
    configOverrides: missingGuildPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.scheduledEventAuditPolicy,
  )
  const changes = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.scheduledEventChangePolicy,
  )
  const users = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.scheduledEventUserAuditPolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /privacy-safe scheduled event inventory/i)
  assert.match(audit?.summary || "", /1 exact guilds/)
  assert.equal(changes?.status, "pass")
  assert.match(changes?.summary || "", /1 canonical cover roots/)
  assert.match(changes?.summary || "", /exact state or absence readback/)
  assert.equal(users?.status, "pass")
  assert.match(users?.summary || "", /ID-and-bot-only pages/)
  assert.match(users?.summary || "", /member expansion disabled/)
  assert.equal(
    missingGuild.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.scheduledEventAuditPolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    missingGuild.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.scheduledEventChangePolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    missingGuild.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.scheduledEventUserAuditPolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    missingRoot.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.scheduledEventChangePolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /cover updates remain blocked/)
  assert.match(missingGuildSetup.warnings.join("\n"), /user-audit toggle/)
  assert.match(omitted.warnings.join("\n"), /scheduled-events toolset/)
})

test("doctor and setup explain privacy-safe reviewed soundboard scope", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "guildcontrol-soundboard-"))
  context.after(() => rm(root, { force: true, recursive: true }))
  const canonicalRoot = await realpath(root)
  const enabledPolicy = fixturePolicy({
    capabilities: {
      soundboardAudit: true,
      soundboardChanges: true,
    },
    scopes: {
      soundboardGuildIds: [GUILD_ID],
    },
    storage: {
      soundboardRoots: [canonicalRoot],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const missingGuildPolicy = fixturePolicy({
    capabilities: {
      soundboardAudit: true,
      soundboardChanges: true,
    },
  })
  const missingGuild = await diagnoseConnector({
    configOverrides: missingGuildPolicy,
    nodeVersion: "22.14.0",
  })
  const missingRootPolicy = fixturePolicy({
    capabilities: {
      soundboardAudit: true,
      soundboardChanges: true,
    },
    scopes: {
      soundboardGuildIds: [GUILD_ID],
    },
  })
  const missingRoot = await diagnoseConnector({
    configOverrides: missingRootPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: missingRootPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.soundboardAuditPolicy,
  )
  const changes = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.soundboardChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /privacy-safe default and guild soundboard inventory/i)
  assert.match(audit?.summary || "", /1 exact guilds/)
  assert.equal(changes?.status, "pass")
  assert.match(changes?.summary || "", /1 canonical creation roots/)
  assert.match(changes?.summary || "", /exact metadata or absence readback/)
  assert.equal(
    missingGuild.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.soundboardAuditPolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    missingGuild.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.soundboardChangePolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    missingRoot.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.soundboardChangePolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /creation remains blocked/)
  assert.match(omitted.warnings.join("\n"), /soundboard toolset/)
})

test("doctor explains guarded exact-scope soundboard playback", async () => {
  const customSoundPolicy = fixturePolicy({
    capabilities: {
      soundboardPlayback: true,
    },
    scopes: {
      soundboardPlaybackChannelIds: [CHANNEL_ID],
      soundboardPlaybackSourceGuildIds: [GUILD_ID],
    },
  })
  const customSound = await diagnoseConnector({
    configOverrides: customSoundPolicy,
    nodeVersion: "22.14.0",
  })
  const defaultsOnly = await diagnoseConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        soundboardPlayback: true,
      },
      scopes: {
        soundboardPlaybackChannelIds: [CHANNEL_ID],
      },
    }),
    nodeVersion: "22.14.0",
  })

  const customSoundCheck = customSound.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.soundboardPlaybackPolicy,
  )
  const defaultsOnlyCheck = defaultsOnly.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.soundboardPlaybackPolicy,
  )
  assert.equal(customSoundCheck?.status, "pass")
  assert.match(customSoundCheck?.summary || "", /1 exact ordinary voice channels/)
  assert.match(customSoundCheck?.summary || "", /1 exact custom-sound source guilds/)
  assert.match(customSoundCheck?.summary || "", /GUILDS plus GUILD_VOICE_STATES/)
  assert.equal(defaultsOnlyCheck?.status, "pass")
  assert.match(defaultsOnlyCheck?.summary || "", /Discord default sounds only/)
})

test("doctor and setup explain reviewed Stage-instance scope", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      stageInstanceAudit: true,
      stageInstanceChanges: true,
      stageStartNotifications: true,
    },
    scopes: {
      stageChannelIds: [CHANNEL_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const missingChannelPolicy = fixturePolicy({
    capabilities: {
      stageInstanceAudit: true,
      stageInstanceChanges: true,
      stageStartNotifications: true,
    },
  })
  const missingChannel = await diagnoseConnector({
    configOverrides: missingChannelPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: missingChannelPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.stageInstanceAuditPolicy,
  )
  const changes = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.stageInstanceChangePolicy,
  )
  const notifications = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.stageStartNotificationPolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /privacy-safe Stage-instance inventory/i)
  assert.match(audit?.summary || "", /1 exact Stage channels/)
  assert.equal(changes?.status, "pass")
  assert.match(changes?.summary || "", /signed approval/)
  assert.match(changes?.summary || "", /ambiguity quarantine/)
  assert.equal(notifications?.status, "pass")
  assert.match(notifications?.summary || "", /Mention Everyone permission evidence/)
  for (const checkId of [
    DOCTOR_CHECK_IDS.stageInstanceAuditPolicy,
    DOCTOR_CHECK_IDS.stageInstanceChangePolicy,
    DOCTOR_CHECK_IDS.stageStartNotificationPolicy,
  ]) {
    assert.equal(
      missingChannel.checks.find((entry) => entry.id === checkId)?.status,
      "warn",
    )
  }
  assert.match(setup.warnings.join("\n"), /Stage-instance audit toggle/)
  assert.match(setup.warnings.join("\n"), /Stage-instance change toggle/)
  assert.match(omitted.warnings.join("\n"), /stage-instances toolset/)
})

test("doctor and setup explain privacy-safe reviewed AutoMod scope", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      automodAudit: true,
      automodChanges: true,
    },
    scopes: {
      automodGuildIds: [GUILD_ID],
      automodAlertChannelIds: [CHANNEL_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const missingGuildPolicy = fixturePolicy({
    capabilities: {
      automodAudit: true,
      automodChanges: true,
    },
  })
  const missingGuild = await diagnoseConnector({
    configOverrides: missingGuildPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: missingGuildPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.automodAuditPolicy,
  )
  const changes = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.automodChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /privacy-safe AutoMod inventory/i)
  assert.match(audit?.summary || "", /1 exact guilds/)
  assert.equal(changes?.status, "pass")
  assert.match(changes?.summary || "", /1 exact alert channels/)
  assert.match(changes?.summary || "", /exact state or absence readback/)
  assert.equal(
    missingGuild.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.automodAuditPolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    missingGuild.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.automodChangePolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /AutoMod audit toggle/)
  assert.match(setup.warnings.join("\n"), /AutoMod change toggle/)
  assert.match(omitted.warnings.join("\n"), /automod toolset/)
})

test("doctor and setup explain reviewed permission-overwrite scope without Discord writes", async () => {
  const enabled = await diagnoseConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        permissionOverwrites: true,
      },
      scopes: {
        permissionOverwriteChannelIds: [CHANNEL_ID],
      },
    }),
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      permissionOverwrites: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: fixturePolicy({
      capabilities: {
        permissionOverwrites: true,
      },
      scopes: {
        permissionOverwriteChannelIds: [CHANNEL_ID],
      },
      tools: {
        toolsets: ["connector"],
      },
    }),
    service: statusProvider(),
  })

  const overwrite = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.permissionOverwritePolicy,
  )
  assert.equal(overwrite?.status, "pass")
  assert.match(overwrite?.summary || "", /1 exact channels/)
  assert.match(overwrite?.summary || "", /named deltas/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.permissionOverwritePolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /exact channel allowlist/)
  assert.match(omitted.warnings.join("\n"), /permission-overwrites toolset/)
})

test("doctor and setup explain reviewed parent-category permission-sync scope without Discord writes", async () => {
  const policy = fixturePolicy({
    capabilities: { permissionSyncs: true },
    scopes: { permissionSyncChannelIds: [CHANNEL_ID] },
  })
  const enabled = await diagnoseConnector({
    configOverrides: policy,
    nodeVersion: "22.14.0",
  })
  const omitted = await prepareSetup({
    configOverrides: fixturePolicy({
      capabilities: { permissionSyncs: true },
      scopes: { permissionSyncChannelIds: [CHANNEL_ID] },
      tools: { toolsets: ["connector"] },
    }),
    service: statusProvider(),
  })

  const permissionSync = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.permissionSyncPolicy,
  )
  assert.equal(permissionSync?.status, "pass")
  assert.match(permissionSync?.summary || "", /1 exact direct child channels/)
  assert.match(permissionSync?.summary || "", /complete child and parent overwrite review/)
  assert.match(permissionSync?.summary || "", /exact synchronized-state readback/)
  assert.match(omitted.warnings.join("\n"), /permission-sync toolset/)
})

test("doctor and setup explain reviewed role-creation scope without Discord writes", async () => {
  const enabled = await diagnoseConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        roleCreation: true,
      },
      scopes: {
        roleCreationGuildIds: [GUILD_ID],
      },
    }),
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      roleCreation: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: fixturePolicy({
      capabilities: {
        roleCreation: true,
      },
      scopes: {
        roleCreationGuildIds: [GUILD_ID],
      },
      tools: {
        toolsets: ["connector"],
      },
    }),
    service: statusProvider(),
  })

  const creation = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.roleCreationPolicy,
  )
  assert.equal(creation?.status, "pass")
  assert.match(creation?.summary || "", /1 guilds with reviewed one-shot execution/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.roleCreationPolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /role-creation guild allowlist/)
  assert.match(omitted.warnings.join("\n"), /role-creation toolset/)
})

test("doctor and setup explain exact reviewed role-configuration scope", async () => {
  const enabled = await diagnoseConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        roleConfiguration: true,
      },
      scopes: {
        roleConfigurationIds: [ROLE_ID],
      },
      storage: {
        guildExpressionRoots: [process.cwd()],
      },
    }),
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      roleConfiguration: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const imageWarning = await diagnoseConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        roleConfiguration: true,
      },
      scopes: {
        roleConfigurationIds: [ROLE_ID],
      },
    }),
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: fixturePolicy({
      capabilities: {
        roleConfiguration: true,
      },
      scopes: {
        roleConfigurationIds: [ROLE_ID],
      },
      tools: {
        toolsets: ["connector"],
      },
    }),
    service: statusProvider(),
  })

  const configuration = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.roleConfigurationPolicy,
  )
  assert.equal(configuration?.status, "pass")
  assert.match(configuration?.summary || "", /1 exact roles/)
  assert.match(configuration?.summary || "", /complete readback/)
  assert.match(configuration?.summary || "", /1 canonical local-image roots/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.roleConfigurationPolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    imageWarning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.roleConfigurationPolicy,
    )?.status,
    "warn",
  )
  assert.match(
    imageWarning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.roleConfigurationPolicy,
    )?.summary || "",
    /local-image role icons are blocked/,
  )
  assert.match(setup.warnings.join("\n"), /exact role allowlist/)
  assert.match(omitted.warnings.join("\n"), /role-configuration toolset/)
})

test("doctor and setup separate role-order audit from reviewed changes", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      roleOrderingAudit: true,
      roleOrderingChanges: true,
    },
    scopes: {
      roleOrderingGuildIds: [GUILD_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      roleOrderingAudit: true,
      roleOrderingChanges: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.roleOrderingAuditPolicy,
  )
  const changes = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.roleOrderingChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /1 exact guilds/)
  assert.match(audit?.summary || "", /aggregate holder evidence/)
  assert.equal(changes?.status, "pass")
  assert.match(changes?.summary || "", /signed approval/)
  assert.match(changes?.summary || "", /durable collection coordination/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.roleOrderingAuditPolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.roleOrderingChangePolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /role-ordering audit toggle/)
  assert.match(setup.warnings.join("\n"), /role-ordering change toggle/)
  assert.match(omitted.warnings.join("\n"), /role-ordering toolset/)
  assertDefaultSecretForwarding(setup)
})

test("doctor and setup explain exact reviewed channel cloning", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      channelCloneAudit: true,
      channelCloning: true,
    },
    scopes: {
      channelCloneGuildIds: [GUILD_ID],
      channelCloneSourceIds: [CHANNEL_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: enabledPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.channelCloneAuditPolicy,
  )
  const changes = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.channelCloneChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /1 exact sources across 1 exact guilds/)
  assert.match(audit?.summary || "", /obfuscation-safe topology/)
  assert.equal(changes?.status, "pass")
  assert.match(changes?.summary || "", /signed approval/)
  assert.match(changes?.summary || "", /atomic one-shot creation/)
  assert.match(changes?.summary || "", /content-free auditing/)
  assert.match(omitted.warnings.join("\n"), /channel-cloning toolset/)
  assertDefaultSecretForwarding(setup)
})

test("doctor and setup separate channel-order audit from reviewed changes", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      channelOrderingAudit: true,
      channelOrderingChanges: true,
    },
    scopes: {
      channelOrderingGuildIds: [GUILD_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: enabledPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.channelOrderingAuditPolicy,
  )
  const changes = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.channelOrderingChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /1 exact guilds/)
  assert.match(audit?.summary || "", /obfuscation-safe Gateway layout/)
  assert.equal(changes?.status, "pass")
  assert.match(changes?.summary || "", /signed approval/)
  assert.match(changes?.summary || "", /cross-parent authority and overwrite preservation/)
  assert.match(changes?.summary || "", /complete Gateway plus HTTP verification/)
  assert.match(omitted.warnings.join("\n"), /channel-ordering toolset/)
  assertDefaultSecretForwarding(setup)
})

test("doctor and setup explain reviewed exact channel deletion", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      channelDeletionAudit: true,
      channelDeletions: true,
    },
    gateway: {
      enabled: true,
    },
    scopes: {
      channelDeletionIds: [CHANNEL_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: enabledPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.channelDeletionAuditPolicy,
  )
  const changes = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.channelDeletionChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /1 exact channels/)
  assert.match(audit?.summary || "", /complete topology, dependency, permission, and privacy-safe evidence/)
  assert.equal(changes?.status, "pass")
  assert.match(changes?.summary || "", /irreversible acknowledgement/)
  assert.match(changes?.summary || "", /newer Gateway absence verification/)
  assert.match(omitted.warnings.join("\n"), /channel-deletion toolset/)
  assertDefaultSecretForwarding(setup)
})

test("doctor and setup explain reviewed exact role deletion", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      roleDeletions: true,
      roleDeletionAudit: true,
    },
    gateway: {
      enabled: true,
    },
    scopes: {
      roleDeletionIds: [ROLE_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: enabledPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector", "gateway"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.roleDeletionAuditPolicy,
  )
  const changes = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.roleDeletionChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /1 exact roles/)
  assert.match(audit?.summary || "", /holder, hierarchy, dependency, permission/)
  assert.equal(changes?.status, "pass")
  assert.match(changes?.summary || "", /irreversible acknowledgement/)
  assert.match(changes?.summary || "", /fresh absence verification/)
  assert.match(omitted.warnings.join("\n"), /role-deletion toolset/)
  assertDefaultSecretForwarding(setup)
})

test("doctor and setup explain reviewed member-role scope without Discord writes", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      memberRoleChanges: true,
    },
    scopes: {
      memberRoleGuildIds: [GUILD_ID],
      memberRoleIds: [ROLE_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      memberRoleChanges: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const memberRole = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.memberRolePolicy,
  )
  assert.equal(memberRole?.status, "pass")
  assert.match(memberRole?.summary || "", /1 exact guilds and 1 exact roles/)
  assert.match(memberRole?.summary || "", /permission-impact review and one-shot execution/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.memberRolePolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /exact guild and role allowlists/)
  assert.match(omitted.warnings.join("\n"), /member-roles toolset/)
})

test("doctor and setup explain independent reviewed bulk member-role scope", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      bulkMemberRoleChanges: true,
    },
    scopes: {
      bulkMemberRoleGuildIds: [GUILD_ID],
      bulkMemberRoleIds: [ROLE_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      bulkMemberRoleChanges: true,
    },
  })
  assert.throws(
    () => loadFixtureConfig(warningPolicy),
    /requires exact batch guild and role allowlists/,
  )
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const batch = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.bulkMemberRolePolicy,
  )
  assert.equal(batch?.status, "pass")
  assert.match(batch?.summary || "", /1 exact guilds and 1 exact roles/)
  assert.match(batch?.summary || "", /complete per-target permission review/)
  assert.match(batch?.summary || "", /sequential non-retried writes/)
  assert.match(batch?.summary || "", /restart-safe verified checkpoints/)
  assert.match(omitted.warnings.join("\n"), /member-roles toolset/)
})

test("doctor and setup explain reviewed member nickname scope without Discord writes", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      nicknameChanges: true,
      otherMemberNicknameChanges: true,
    },
    scopes: {
      nicknameGuildIds: [GUILD_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      nicknameChanges: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const currentBot = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.memberNicknamePolicy,
  )
  const otherMember = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.otherMemberNicknamePolicy,
  )
  assert.equal(currentBot?.status, "pass")
  assert.match(currentBot?.summary || "", /1 exact guilds/)
  assert.match(currentBot?.summary || "", /CHANGE_NICKNAME evidence/)
  assert.match(currentBot?.summary || "", /signed approval, one-shot execution, and exact readback/)
  assert.equal(otherMember?.status, "pass")
  assert.match(otherMember?.summary || "", /protected-user/)
  assert.match(otherMember?.summary || "", /MANAGE_NICKNAMES/)
  assert.match(otherMember?.summary || "", /strict hierarchy checks/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.memberNicknamePolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /exact guild allowlist/)
  assert.match(omitted.warnings.join("\n"), /member-nicknames toolset/)
  assertDefaultSecretForwarding(setup)
})

test("doctor and setup explain reviewed member verification-bypass scope", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      memberVerificationChanges: true,
    },
    scopes: {
      memberVerificationGuildIds: [GUILD_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  assert.throws(
    () => loadFixtureConfig(fixturePolicy({
      capabilities: {
        memberVerificationChanges: true,
      },
    })),
    /requires.*memberVerificationGuildIds/u,
  )
  const setup = await prepareSetup({
    configOverrides: enabledPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const verification = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.memberVerificationPolicy,
  )
  assert.equal(verification?.status, "pass")
  assert.match(verification?.summary || "", /1 exact guilds/u)
  assert.match(verification?.summary || "", /named-bit preservation/u)
  assert.match(verification?.summary || "", /documented alternative permission evidence/u)
  assert.match(verification?.summary || "", /protected and special-member exclusions/u)
  assert.match(verification?.summary || "", /signed approval, one-shot execution, and exact readback/u)
  assert.match(omitted.warnings.join("\n"), /member-verification toolset/u)
  assertDefaultSecretForwarding(setup)
})

test("doctor and setup explain privacy-safe reviewed member voice scope", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      memberVoiceAudit: true,
      memberVoiceChanges: true,
    },
    scopes: {
      memberVoiceChannelIds: [CHANNEL_ID],
      memberVoiceGuildIds: [GUILD_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      memberVoiceAudit: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...enabledPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.memberVoiceAuditPolicy,
  )
  const changes = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.memberVoiceChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /1 exact guilds and 1 exact voice-scope channels/)
  assert.match(audit?.summary || "", /without occupant enumeration or state persistence/)
  assert.equal(changes?.status, "pass")
  assert.match(changes?.summary || "", /permission and hierarchy review/)
  assert.match(changes?.summary || "", /signed approval, and one-shot execution/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.memberVoiceAuditPolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /exact guild and voice-channel allowlists/)
  assert.match(omitted.warnings.join("\n"), /voice-moderation toolset/)
})

test("doctor and setup explain resumable guild-scaffold scope without Discord writes", async () => {
  const enabled = await diagnoseConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        guildScaffolds: true,
      },
      scopes: {
        guildScaffoldGuildIds: [GUILD_ID],
      },
    }),
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      guildScaffolds: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: fixturePolicy({
      capabilities: {
        guildScaffolds: true,
      },
      scopes: {
        guildScaffoldGuildIds: [GUILD_ID],
      },
      tools: {
        toolsets: ["connector"],
      },
    }),
    service: statusProvider(),
  })
  const blueprintOmitted = await prepareSetup({
    configOverrides: fixturePolicy({
      capabilities: {
        guildProfileAudit: true,
        guildProfileChanges: true,
        guildScaffolds: true,
      },
      scopes: {
        guildProfileGuildIds: [GUILD_ID],
        guildScaffoldGuildIds: [GUILD_ID],
      },
      tools: {
        toolsets: ["connector"],
      },
    }),
    service: statusProvider(),
  })

  const scaffold = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.guildScaffoldPolicy,
  )
  assert.equal(scaffold?.status, "pass")
  assert.match(scaffold?.summary || "", /1 guilds with durable bounded resumption/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.guildScaffoldPolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /guild-scaffold allowlist/)
  assert.match(omitted.warnings.join("\n"), /guild-scaffolds toolset/)
  assert.match(blueprintOmitted.warnings.join("\n"), /guild-blueprints toolset/)
})

test("doctor and setup explain capability-safe Guild Template scope without Discord writes", async () => {
  const enabled = await diagnoseConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        guildTemplateAudit: true,
        guildTemplateChanges: true,
      },
      scopes: {
        guildTemplateGuildIds: [GUILD_ID],
      },
    }),
    nodeVersion: "22.14.0",
  })
  const warningPolicy = fixturePolicy({
    capabilities: {
      guildTemplateAudit: true,
      guildTemplateChanges: true,
    },
  })
  const warning = await diagnoseConnector({
    configOverrides: warningPolicy,
    nodeVersion: "22.14.0",
  })
  const setup = await prepareSetup({
    configOverrides: warningPolicy,
    service: statusProvider(),
  })
  const omitted = await prepareSetup({
    configOverrides: fixturePolicy({
      capabilities: {
        guildTemplateAudit: true,
        guildTemplateChanges: true,
      },
      scopes: {
        guildTemplateGuildIds: [GUILD_ID],
      },
      tools: {
        toolsets: ["connector"],
      },
    }),
    service: statusProvider(),
  })

  const audit = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.guildTemplateAuditPolicy,
  )
  const changes = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.guildTemplateChangePolicy,
  )
  assert.equal(audit?.status, "pass")
  assert.match(audit?.summary || "", /opaque process-local references/)
  assert.match(audit?.summary || "", /count-only snapshot evidence/)
  assert.equal(changes?.status, "pass")
  assert.match(changes?.summary || "", /full private-inventory planning/)
  assert.match(changes?.summary || "", /one-shot execution, and exact readback/)
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.guildTemplateAuditPolicy,
    )?.status,
    "warn",
  )
  assert.equal(
    warning.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.guildTemplateChangePolicy,
    )?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /Guild Template audit toggle/)
  assert.match(setup.warnings.join("\n"), /Guild Template change toggle/)
  assert.match(omitted.warnings.join("\n"), /guild-templates toolset/)
})

test("doctor reports the privacy-safe Gateway policy without opening a connection", async () => {
  const enabled = await diagnoseConnector({
    configOverrides: fixturePolicy({
      gateway: {
        enabled: true,
        eventBufferSize: 250,
      },
    }),
    nodeVersion: "22.14.0",
  })
  const disabled = await diagnoseConnector({
    configOverrides: fixturePolicy(),
    nodeVersion: "22.14.0",
  })

  const enabledCheck = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.gatewayPolicy,
  )
  assert.equal(enabledCheck?.status, "pass")
  assert.match(enabledCheck?.summary || "", /250-event content-free buffer/)
  assert.match(enabledCheck?.summary || "", /nonprivileged intents/)
  assert.match(
    disabled.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.gatewayPolicy,
    )?.summary || "",
    /disabled/,
  )
})

test("doctor and setup explain native Interaction ingress and command boundaries", async () => {
  const configuredPolicy = fixturePolicy({
    capabilities: {
      nativeCommandChanges: true,
      nativeInteractions: true,
    },
    limits: {
      nativeInteractionMaxPending: 7,
      nativeInteractionTtlSeconds: 180,
    },
    runtime: {
      nativeCommandName: "ask",
    },
    scopes: {
      nativeInteractionChannelIds: [CHANNEL_ID],
      nativeInteractionGuildIds: [GUILD_ID],
      nativeInteractionUserIds: [BOT_ID],
    },
  })
  const report = await diagnoseConnector({
    configOverrides: configuredPolicy,
    nodeVersion: "22.14.0",
  })
  const disabled = await diagnoseConnector({
    configOverrides: fixturePolicy(),
    nodeVersion: "22.14.0",
  })
  const omitted = await prepareSetup({
    configOverrides: {
      ...configuredPolicy,
      tools: {
        toolsets: ["connector"],
      },
    },
    service: statusProvider(),
  })

  const command = report.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.nativeInteractionCommandPolicy,
  )
  const ingress = report.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.nativeInteractionIngressPolicy,
  )
  assert.equal(command?.status, "pass")
  assert.match(command?.summary || "", /\/ask in 1 exact guilds/)
  assert.match(command?.summary || "", /full-inventory readback/)
  assert.equal(ingress?.status, "pass")
  assert.match(ingress?.summary || "", /at most 7 requests for 180 seconds/)
  assert.match(ingress?.summary || "", /intents-free Gateway connection/)
  assert.match(ingress?.summary || "", /endpoint and command verification/)
  assert.match(ingress?.summary || "", /response tokens stay broker-private/)
  assert.match(ingress?.summary || "", /initial replies close by default/)
  assert.match(ingress?.summary || "", /rotating one-shot continuations/)
  assert.match(omitted.warnings.join("\n"), /native-interactions toolset/)
  assert.match(
    disabled.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.nativeInteractionCommandPolicy,
    )?.summary || "",
    /disabled/,
  )
  assert.match(
    disabled.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.nativeInteractionIngressPolicy,
    )?.summary || "",
    /disabled/,
  )
})

test("doctor and setup report observability without opening collectors or exposing headers", async () => {
  const collectorHeader = "Bearer private-collector-credential"
  const configuredPolicy = fixturePolicy({
    secretEnvironment: {
      DISCORD_OBSERVABILITY_HEADERS: `authorization=${encodeURIComponent(collectorHeader)}`,
    },
    observability: {
      endpoint: "https://collector.example.test/otlp",
      exportEnabled: true,
      headers: {
        provider: "environment",
        variable: "DISCORD_OBSERVABILITY_HEADERS",
      },
      jsonLogsEnabled: true,
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: configuredPolicy,
    nodeVersion: "22.14.0",
  })
  const disabled = await diagnoseConnector({
    configOverrides: fixturePolicy(),
    nodeVersion: "22.14.0",
  })
  const defaultCollector = await prepareSetup({
    configOverrides: fixturePolicy({
      observability: {
        exportEnabled: true,
      },
    }),
    service: statusProvider(),
  })

  const enabledCheck = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.observability,
  )
  assert.equal(enabledCheck?.status, "pass")
  assert.match(enabledCheck?.summary || "", /OTLP\/HTTP protobuf export is enabled/)
  assert.match(enabledCheck?.summary || "", /explicit collector endpoints/)
  assert.match(enabledCheck?.summary || "", /configured authentication headers/)
  assert.match(enabledCheck?.summary || "", /structured stderr logs are enabled/)
  assert.equal(JSON.stringify(enabled).includes("collector.example.test"), false)
  assert.equal(JSON.stringify(enabled).includes(collectorHeader), false)
  assert.match(
    disabled.checks.find(
      (entry) => entry.id === DOCTOR_CHECK_IDS.observability,
    )?.summary || "",
    /OTLP export is disabled/,
  )
  assert.match(defaultCollector.warnings.join("\n"), /default loopback collector/)
})

test("doctor verifies identity online and redacts online failures", async () => {
  let calls = 0
  const verified = await diagnoseConnector({
    configOverrides: fixturePolicy({
      token: `  ${TOKEN}  `,
    }),
    nodeVersion: "22.14.0",
    online: true,
    service: {
      async getStatus() {
        calls += 1
        return status()
      },
    },
  })
  const failed = await diagnoseConnector({
    configOverrides: fixturePolicy({
      token: `  ${TOKEN}  `,
    }),
    nodeVersion: "22.14.0",
    online: true,
    service: {
      async getStatus() {
        throw new Error(`Discord rejected ${TOKEN}`)
      },
    },
  })

  assert.equal(calls, 1)
  assert.deepEqual(verified.identity, {
    applicationId: APPLICATION_ID,
    botId: BOT_ID,
    configuredGuildCount: 1,
    installedGuildCount: 1,
    installedInScopeGuildCount: 1,
    missingConfiguredGuildCount: 0,
    unexpectedGuildCount: 0,
  })
  assert.equal(verified.status, "ok")
  assert.equal(failed.status, "error")
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(TOKEN))
  assert.match(JSON.stringify(failed), /\[redacted\]/)
})

test("doctor and setup turn current application posture into actionable findings", async () => {
  const defaultPermissions = DISCORD_PERMISSIONS.ADMINISTRATOR | (1n << 90n)
  const posture = projectApplicationPosture({
    bot_public: true,
    bot_require_code_grant: true,
    custom_install_url: "https://install.invalid/private",
    description: "private application description",
    event_webhooks_status: 2,
    event_webhooks_url: "https://events.invalid/private",
    flags_new: DISCORD_APPLICATION_FLAGS.gatewayPresenceLimited.toString(),
    id: APPLICATION_ID,
    integration_types_config: {
      "0": {
        oauth2_install_params: {
          permissions: defaultPermissions.toString(),
          scopes: ["bot", "future.scope"],
        },
      },
    },
    interactions_endpoint_url: "https://interactions.invalid/private",
    name: "private application name",
  }, BOT_ID, {
    guildMembersIntentRequired: false,
    messageContentIntent: "not-required",
    nativeInteractionIngressRequired: true,
  })
  const configuredPolicy = fixturePolicy({
    capabilities: {
      nativeInteractions: true,
    },
    scopes: {
      nativeInteractionChannelIds: [CHANNEL_ID],
      nativeInteractionGuildIds: [GUILD_ID],
      nativeInteractionUserIds: [BOT_ID],
    },
    tools: {
      toolsets: ["connector", "native-interactions"],
    },
  })
  const provider = {
    async getStatus() {
      return status(1, "disabled", "disabled", posture)
    },
  }

  const report = await diagnoseConnector({
    configOverrides: configuredPolicy,
    nodeVersion: "22.14.0",
    online: true,
    service: provider,
  })
  const setup = await prepareSetup({
    configOverrides: configuredPolicy,
    service: provider,
  })

  const expected = [
    [DOCTOR_CHECK_IDS.applicationInstall, "fail"],
    [DOCTOR_CHECK_IDS.applicationBotVisibility, "warn"],
    [DOCTOR_CHECK_IDS.applicationDefaultPermissions, "warn"],
    [DOCTOR_CHECK_IDS.applicationInteractionDelivery, "fail"],
    [DOCTOR_CHECK_IDS.applicationPresenceIntent, "warn"],
    [DOCTOR_CHECK_IDS.applicationEventWebhooks, "warn"],
  ] as const
  for (const [id, expectedStatus] of expected) {
    const entry = report.checks.find((check) => check.id === id)
    assert.equal(entry?.status, expectedStatus, id)
    assert.equal(entry?.reference, "docs/reference.md#application-security-posture")
    assert.match(entry?.action || "", /Developer Portal/)
  }
  assert.equal(report.status, "error")
  assert.match(setup.warnings.join("\n"), /full OAuth2 code grant/)
  assert.match(setup.warnings.join("\n"), /requests Administrator/)
  assert.match(setup.warnings.join("\n"), /other than the application owner/)
  assert.match(setup.warnings.join("\n"), /event webhooks are enabled/)
  assert.doesNotMatch(JSON.stringify({ report, setup }), /https:\/\//u)
  assert.doesNotMatch(JSON.stringify({ report, setup }), /private application/u)
})

test("doctor and setup report Message Content intent needed by native search", async () => {
  const report = await diagnoseConnector({
    configOverrides: fixturePolicy(),
    nodeVersion: "22.14.0",
    online: true,
    service: {
      async getStatus() {
        return status(1, "disabled")
      },
    },
  })
  const setup = await prepareSetup({
    configOverrides: fixturePolicy(),
    service: {
      async getStatus() {
        return status(1, "unknown")
      },
    },
  })
  const withoutMessages = await prepareSetup({
    configOverrides: fixturePolicy({
      tools: {
        toolsets: ["connector"],
      },
    }),
    service: {
      async getStatus() {
        return status(1, "unknown")
      },
    },
  })

  assert.equal(report.status, "warning")
  assert.equal(
    report.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.messageContentIntent)?.status,
    "warn",
  )
  assert.match(setup.warnings.join("\n"), /Message Content intent/)
  assert.doesNotMatch(withoutMessages.warnings.join("\n"), /Message Content intent/)
})

test("doctor and setup diagnose the separately gated Guild Members intent", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      memberDirectory: true,
    },
    scopes: {
      memberDirectoryGuildIds: [GUILD_ID],
    },
  })
  const offline = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const empty = await diagnoseConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        memberDirectory: true,
      },
    }),
    nodeVersion: "22.14.0",
  })
  const disabledIntent = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
    online: true,
    service: {
      async getStatus() {
        return status(1, "enabled", "disabled")
      },
    },
  })
  const unknownIntentSetup = await prepareSetup({
    configOverrides: enabledPolicy,
    service: {
      async getStatus() {
        return status(1, "enabled", "unknown")
      },
    },
  })
  const disabledDirectory = await diagnoseConnector({
    configOverrides: fixturePolicy(),
    nodeVersion: "22.14.0",
    online: true,
    service: {
      async getStatus() {
        return status(1, "enabled", "disabled")
      },
    },
  })
  const omittedToolset = await prepareSetup({
    configOverrides: fixturePolicy({
      capabilities: {
        memberDirectory: true,
      },
      scopes: {
        memberDirectoryGuildIds: [GUILD_ID],
      },
      tools: {
        toolsets: ["connector"],
      },
    }),
    service: statusProvider(),
  })

  assert.equal(
    offline.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.memberDirectoryPolicy)?.status,
    "pass",
  )
  assert.match(
    offline.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.memberDirectoryPolicy)?.summary || "",
    /privacy-minimized pages/,
  )
  assert.equal(
    empty.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.memberDirectoryPolicy)?.status,
    "warn",
  )
  assert.equal(
    disabledIntent.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.guildMembersIntent)?.status,
    "fail",
  )
  assert.equal(disabledIntent.status, "error")
  assert.match(unknownIntentSetup.warnings.join("\n"), /Guild Members intent/)
  assert.equal(
    disabledDirectory.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.guildMembersIntent)?.status,
    "pass",
  )
  assert.match(omittedToolset.warnings.join("\n"), /members toolset/)
})

test("doctor and setup explain privacy-safe ban audit without privileged intent", async () => {
  const enabledPolicy = fixturePolicy({
    capabilities: {
      banAudit: true,
    },
    scopes: {
      banAuditGuildIds: [GUILD_ID],
    },
  })
  const enabled = await diagnoseConnector({
    configOverrides: enabledPolicy,
    nodeVersion: "22.14.0",
  })
  const empty = await diagnoseConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        banAudit: true,
      },
    }),
    nodeVersion: "22.14.0",
  })
  const omittedToolset = await prepareSetup({
    configOverrides: fixturePolicy({
      capabilities: {
        banAudit: true,
      },
      scopes: {
        banAuditGuildIds: [GUILD_ID],
      },
      tools: {
        toolsets: ["connector"],
      },
    }),
    service: statusProvider(),
  })
  const setup = await prepareSetup({
    configOverrides: enabledPolicy,
    service: {
      async getStatus() {
        return status(1, "enabled", "disabled")
      },
    },
  })

  const policy = enabled.checks.find(
    (entry) => entry.id === DOCTOR_CHECK_IDS.banAuditPolicy,
  )
  assert.equal(policy?.status, "pass")
  assert.match(policy?.summary || "", /BAN_MEMBERS/)
  assert.match(policy?.summary || "", /default-redacted reasons/)
  assert.equal(
    empty.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.banAuditPolicy)?.status,
    "warn",
  )
  assert.match(omittedToolset.warnings.join("\n"), /bans toolset/)
  assert.doesNotMatch(setup.warnings.join("\n"), /Guild Members intent/)
})

test("doctor fails online verification when local scope contains no accessible guild", async () => {
  const report = await diagnoseConnector({
    configOverrides: fixturePolicy(),
    nodeVersion: "22.14.0",
    online: true,
    service: statusProvider(0),
  })

  assert.equal(report.status, "error")
  assert.equal(
    report.checks.find((entry) => entry.id === DOCTOR_CHECK_IDS.guildAccess)?.status,
    "fail",
  )
})

test("stdio launch descriptor requires one policy and forwards only its secrets", () => {
  const file = "/configuration/discord.json"
  const document = createConnectorConfigDocument({
    applicationId: APPLICATION_ID,
    botId: BOT_ID,
    channelIds: [CHANNEL_ID],
    credentialVariable: DEFAULT_TOKEN_ENVIRONMENT_VARIABLE,
    guildIds: [GUILD_ID],
    name: "team-discord",
    toolsets: ["connector"],
    toolSurface: "full",
  })
  const config = { document, file }
  const result = createStdioLaunchDescriptor({
    applicationId: APPLICATION_ID,
    botId: BOT_ID,
    command: "/opt/GuildControl MCP/bin/guildctl",
    config,
    serverName: "team-discord",
  })

  assert.deepEqual(result, {
    args: ["serve", "--config", file],
    command: "/opt/GuildControl MCP/bin/guildctl",
    environment: {
      forward: [DEFAULT_TOKEN_ENVIRONMENT_VARIABLE],
      set: {},
    },
    requirements: {
      elicitation: "required-for-reviewed-writes",
      requiredServer: true,
      toolApproval: "writes",
    },
    secrets: {
      environmentVariables: [DEFAULT_TOKEN_ENVIRONMENT_VARIABLE],
      files: [],
    },
    serverName: "team-discord",
    timeouts: {
      startupSeconds: 30,
      toolSeconds: 180,
    },
    transport: "stdio",
  })
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN))
  assert.throws(
    () => createStdioLaunchDescriptor({
      applicationId: APPLICATION_ID,
      botId: BOT_ID,
    }),
    /require a schema-v2 configuration or profile/,
  )
  assert.throws(
    () => createStdioLaunchDescriptor({
      applicationId: APPLICATION_ID,
      botId: BOT_ID,
      config,
      serverName: "bad.name",
    }),
    /MCP server name/,
  )
  assert.throws(
    () => createStdioLaunchDescriptor({
      applicationId: "not-a-snowflake",
      botId: BOT_ID,
      config,
    }),
    /snowflake/,
  )
  assert.throws(
    () => createStdioLaunchDescriptor({
      applicationId: APPLICATION_ID,
      botId: "not-a-snowflake",
      config,
    }),
    /bot ID must be a snowflake/,
  )
  assert.throws(
    () => createStdioLaunchDescriptor({
      applicationId: APPLICATION_ID,
      botId: BOT_ID,
      command: " ",
      config,
    }),
    /command must not be empty/,
  )
  assert.throws(
    () => createStdioLaunchDescriptor({
      applicationId: APPLICATION_ID,
      args: ["serve", ""],
      botId: BOT_ID,
      config,
    }),
    /arguments must be non-empty strings/,
  )
})

test("stdio launch descriptor makes a saved profile the complete non-overridable policy", () => {
  const profile = createConnectorProfile({
    applicationId: APPLICATION_ID,
    botId: BOT_ID,
    channelIds: [CHANNEL_ID],
    credentialVariable: TOKEN_ALIAS,
    gatewayEnabled: true,
    gatewayEventBufferSize: 250,
    guildIds: [GUILD_ID],
    name: "support-bot",
    toolsets: ["connector", "messages"],
    toolSurface: "progressive",
  })
  const result = createStdioLaunchDescriptor({
    applicationId: APPLICATION_ID,
    args: ["/srv/guildcontrol/dist/cli.js", "serve"],
    botId: BOT_ID,
    command: "/usr/bin/node",
    profile,
  })

  assert.deepEqual(result.args, [
    "/srv/guildcontrol/dist/cli.js",
    "serve",
    "--profile",
    "support-bot",
  ])
  assert.deepEqual(result.environment, {
    forward: [TOKEN_ALIAS],
    set: {},
  })
  assert.throws(
    () => createStdioLaunchDescriptor({
      applicationId: "999999999999999999",
      botId: BOT_ID,
      profile,
    }),
    /does not match the verified Discord identity/,
  )
  assert.throws(
    () => createStdioLaunchDescriptor({
      applicationId: APPLICATION_ID,
      args: ["serve", "--profile", "other"],
      botId: BOT_ID,
      profile,
    }),
    /already select a configuration/,
  )
})

test("stdio launch descriptor makes a standalone configuration the only policy input", () => {
  const document = createConnectorConfigDocument({
    applicationId: APPLICATION_ID,
    botId: BOT_ID,
    channelIds: [CHANNEL_ID],
    credentialVariable: TOKEN_ALIAS,
    guildIds: [GUILD_ID],
    name: "support-bot",
    toolsets: ["connector", "messages"],
    toolSurface: "progressive",
  })
  const file = "/configuration/discord.json"
  const result = createStdioLaunchDescriptor({
    applicationId: APPLICATION_ID,
    args: ["serve"],
    botId: BOT_ID,
    config: { document, file },
  })

  assert.deepEqual(result.args, ["serve", "--config", file])
  assert.deepEqual(result.environment, {
    forward: [TOKEN_ALIAS],
    set: {},
  })
  assert.throws(
    () => createStdioLaunchDescriptor({
      applicationId: APPLICATION_ID,
      botId: BOT_ID,
      config: { document, file },
      profile: document,
    }),
    /mutually exclusive/,
  )
  assert.throws(
    () => createStdioLaunchDescriptor({
      applicationId: "999999999999999999",
      botId: BOT_ID,
      config: { document, file },
    }),
    /does not match the verified Discord identity/,
  )
  assert.throws(
    () => createStdioLaunchDescriptor({
      applicationId: APPLICATION_ID,
      args: ["serve", "--config", file],
      botId: BOT_ID,
      config: { document, file },
    }),
    /already select a configuration/,
  )
})

test("setup verifies in-scope access and emits a credential-free report", async () => {
  const report = await prepareSetup({
    args: ["/srv/guildcontrol/dist/cli.js", "serve"],
    command: "/usr/bin/node",
    configOverrides: fixturePolicy(),
    serverName: "discord-safe",
    service: statusProvider(),
  })

  assert.equal(report.status, "ok")
  assert.equal(report.schemaVersion, OPERATOR_REPORT_SCHEMA_VERSION)
  assert.equal(report.applicationId, APPLICATION_ID)
  assert.equal(report.botId, BOT_ID)
  assert.equal(report.serverName, "discord-safe")
  assert.equal(report.toolSurface, "full")
  assert.deepEqual(report.toolsets, MCP_TOOLSET_NAMES)
  assert.deepEqual(report.launch.args, [
    "/srv/guildcontrol/dist/cli.js",
    "serve",
    "--config",
    report.configFile,
  ])
  assert.equal(report.launch.command, "/usr/bin/node")
  assert.equal(report.launch.serverName, "discord-safe")
  assert.deepEqual(report.launch.environment, {
    forward: [DEFAULT_TOKEN_ENVIRONMENT_VARIABLE],
    set: {},
  })
  assert.equal(report.preset, null)
  assert.equal(report.profile, null)
  assert.deepEqual(report.warnings, [])
  assert.doesNotMatch(JSON.stringify(report), new RegExp(TOKEN))

  await assert.rejects(
    () => prepareSetup({
      configOverrides: fixturePolicy(),
      service: statusProvider(0),
    }),
    /missing 1 of 1 exact configured guild installations/,
  )
})

test("preset setup saves resolved read-only authority and forwards only its credential", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "guildcontrol-setup-preset-"))
  context.after(() => rm(temporary, { force: true, recursive: true }))
  const profileDirectory = join(await realpath(temporary), "profiles")
  const source = { [TOKEN_ALIAS]: TOKEN }
  const before = { ...source }

  const observer = await prepareSetup({
    credentialVariable: TOKEN_ALIAS,
    environment: source,
    profileDirectory,
    profileName: "observer",
    preset: {
      channelIds: [CHANNEL_ID],
      guildIds: [GUILD_ID],
      name: "server-observer",
    },
    service: {
      async getStatus() {
        return status(1, "disabled")
      },
    },
  })

  assert.deepEqual(source, before)
  assert.deepEqual(observer.preset, getSetupPreset("server-observer"))
  assert.deepEqual(observer.profile?.readScope, {
    channelIds: [CHANNEL_ID],
    channelMode: "allowlist",
    guildIds: [GUILD_ID],
    guildMode: "allowlist",
  })
  assert.deepEqual(observer.profile?.tools, {
    surface: "progressive",
    toolsets: [...getSetupPreset("server-observer").toolsets],
  })
  assert.equal(observer.profile?.gateway.enabled, false)
  assert.deepEqual(observer.launch.environment.forward, [TOKEN_ALIAS])
  assert.deepEqual(observer.launch.environment.set, {})
  assert.doesNotMatch(observer.warnings.join("\n"), /Message Content intent/)
  assert.doesNotMatch(JSON.stringify(observer), new RegExp(TOKEN))
  assert.deepEqual(
    await loadProfile("observer", { directory: profileDirectory }),
    observer.profile,
  )

  await assert.rejects(
    () => prepareSetup({
      credentialVariable: TOKEN_ALIAS,
      environment: source,
      expectedApplicationId: "999999999999999999",
      profileDirectory,
      profileName: "wrong-application",
      preset: {
        guildIds: [GUILD_ID],
        name: "server-observer",
      },
      service: {
        async getStatus() {
          return status()
        },
      },
    }),
    /belongs to application .* expected 999999999999999999/,
  )

  const reader = await prepareSetup({
    credentialVariable: TOKEN_ALIAS,
    environment: source,
    profileDirectory,
    profileName: "reader",
    preset: {
      channelIds: [CHANNEL_ID],
      guildIds: [GUILD_ID],
      name: "channel-reader",
    },
    service: {
      async getStatus() {
        return status(1, "unknown")
      },
    },
  })
  assert.deepEqual(reader.preset, getSetupPreset("channel-reader"))
  assert.match(reader.warnings.join("\n"), /Message Content intent/)
  assert.deepEqual(reader.launch.environment.forward, [TOKEN_ALIAS])

  await assert.rejects(
    () => prepareSetup({
      credentialVariable: TOKEN_ALIAS,
      environment: source,
      profileDirectory,
      profileName: "partial-scope",
      preset: {
        guildIds: [GUILD_ID, OTHER_GUILD_ID],
        name: "server-observer",
      },
      service: {
        async getStatus() {
          return status(
            1,
            "enabled",
            "enabled",
            undefined,
            [GUILD_ID, OTHER_GUILD_ID],
          )
        },
      },
    }),
    /missing 1 of 2 exact configured guild installations/,
  )
})

test("setup creates and verifies a preset-backed profile without persisting or reporting its credential", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "guildcontrol-setup-profile-"))
  context.after(() => rm(temporary, { force: true, recursive: true }))
  const profileDirectory = join(await realpath(temporary), "profiles")
  const source = { [TOKEN_ALIAS]: TOKEN }
  const before = { ...source }

  const report = await prepareSetup({
    args: ["/srv/guildcontrol/dist/cli.js", "serve"],
    command: "/usr/bin/node",
    credentialVariable: TOKEN_ALIAS,
    environment: source,
    profileDirectory,
    profileName: "support-bot",
    preset: {
      channelIds: [CHANNEL_ID],
      guildIds: [GUILD_ID],
      name: "channel-reader",
    },
    service: statusProvider(),
  })

  assert.deepEqual(source, before)
  assert.equal(report.schemaVersion, OPERATOR_REPORT_SCHEMA_VERSION)
  assert.equal(report.profile?.name, "support-bot")
  assert.deepEqual(report.profile?.credential, {
    provider: "environment",
    variable: TOKEN_ALIAS,
  })
  assert.equal(report.profile?.identity.applicationId, APPLICATION_ID)
  assert.equal(report.profile?.identity.botId, BOT_ID)
  assert.deepEqual(report.profile?.readScope, {
    channelIds: [CHANNEL_ID],
    channelMode: "allowlist",
    guildIds: [GUILD_ID],
    guildMode: "allowlist",
  })
  assert.deepEqual(report.profile?.tools, {
    surface: "progressive",
    toolsets: [...getSetupPreset("channel-reader").toolsets],
  })
  assert.deepEqual(report.profile?.gateway, {
    enabled: false,
    eventBufferSize: 100,
  })
  assert.equal(
    report.profile?.schemaVersion === 2
      ? report.profile.capabilities.deletions
      : undefined,
    undefined,
  )
  assert.deepEqual(
    report.profile?.schemaVersion === 2
      ? report.profile.scopes.deleteChannelIds
      : undefined,
    undefined,
  )
  assert.deepEqual(
    await loadProfile("support-bot", { directory: profileDirectory }),
    report.profile,
  )
  assert.deepEqual(report.launch.args, [
    "/srv/guildcontrol/dist/cli.js",
    "serve",
    "--profile",
    "support-bot",
  ])
  assert.deepEqual(report.launch.environment.set, {})
  assert.deepEqual(report.launch.environment.forward, [TOKEN_ALIAS])
  assert.doesNotMatch(JSON.stringify(report), new RegExp(TOKEN))

  await assert.rejects(
    () => prepareSetup({
      credentialVariable: TOKEN_ALIAS,
      environment: source,
      profileDirectory,
      profileName: "support-bot",
      preset: {
        channelIds: [CHANNEL_ID],
        guildIds: [GUILD_ID],
        name: "channel-reader",
      },
      service: statusProvider(),
    }),
    /already exists/,
  )
  const saved = await readFile(join(profileDirectory, "support-bot.json"), "utf8")
  const verified = await prepareSetup({
    environment: { [TOKEN_ALIAS]: TOKEN },
    profileDirectory,
    profileName: "support-bot",
    service: statusProvider(),
  })
  assert.deepEqual(verified.profile, report.profile)
  assert.equal(
    await readFile(join(profileDirectory, "support-bot.json"), "utf8"),
    saved,
  )
  await assert.rejects(
    () => prepareSetup({
      environment: { [TOKEN_ALIAS]: TOKEN },
      overwriteProfile: true,
      profileDirectory,
      profileName: "support-bot",
      service: statusProvider(),
    }),
    /require --preset/,
  )
})

test("setup creates and verifies a preset-backed configuration with recoverable replacement", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "guildcontrol-setup-config-"))
  context.after(() => rm(temporary, { force: true, recursive: true }))
  const configFile = join(await realpath(temporary), "discord.json")
  const source = { [TOKEN_ALIAS]: TOKEN }
  const before = { ...source }

  const report = await prepareSetup({
    args: ["/srv/guildcontrol/dist/cli.js", "serve"],
    command: "/usr/bin/node",
    configFile,
    credentialVariable: TOKEN_ALIAS,
    environment: source,
    preset: {
      guildIds: [GUILD_ID],
      name: "server-observer",
    },
    service: statusProvider(),
  })

  assert.deepEqual(source, before)
  assert.equal(report.configBackupFile, null)
  assert.equal(report.configFile, configFile)
  assert.deepEqual(report.credential, {
    provider: "environment",
    variable: TOKEN_ALIAS,
  })
  assert.equal(report.profile, null)
  assert.deepEqual(report.launch.args, [
    "/srv/guildcontrol/dist/cli.js",
    "serve",
    "--config",
    configFile,
  ])
  assert.deepEqual(report.launch.environment, {
    forward: [TOKEN_ALIAS],
    set: {},
  })
  const initial = loadConnectorConfigDocumentFile(configFile)
  assert.equal(initial.name, "discord")
  assert.deepEqual(initial.credential, {
    provider: "environment",
    variable: TOKEN_ALIAS,
  })
  assert.equal(initial.gateway.enabled, false)
  assert.deepEqual(initial.tools.toolsets, getSetupPreset("server-observer").toolsets)
  assert.doesNotMatch(await readFile(configFile, "utf8"), new RegExp(TOKEN))
  assert.doesNotMatch(JSON.stringify(report), new RegExp(TOKEN))

  await assert.rejects(
    () => prepareSetup({
      configFile,
      credentialVariable: TOKEN_ALIAS,
      environment: source,
      preset: {
        guildIds: [GUILD_ID],
        name: "server-observer",
      },
      service: statusProvider(),
    }),
    /already exists/,
  )

  const saved = await readFile(configFile, "utf8")
  const reused = await prepareSetup({
    args: ["/srv/guildcontrol/dist/cli.js", "serve"],
    command: "/usr/bin/node",
    configFile,
    environment: { [TOKEN_ALIAS]: TOKEN },
    expectedApplicationId: APPLICATION_ID,
    preset: {
      guildIds: [GUILD_ID],
      name: "server-observer",
    },
    reuseExistingConfig: true,
    service: statusProvider(),
  })
  assert.deepEqual(reused.preset, getSetupPreset("server-observer"))
  assert.equal(reused.configBackupFile, null)
  assert.equal(await readFile(configFile, "utf8"), saved)

  await assert.rejects(
    () => prepareSetup({
      configFile,
      environment: { [TOKEN_ALIAS]: TOKEN },
      expectedApplicationId: APPLICATION_ID,
      preset: {
        guildIds: [OTHER_GUILD_ID],
        name: "server-observer",
      },
      reuseExistingConfig: true,
      service: statusProvider(),
    }),
    /does not exactly match the requested application, guild, read-only preset, identity, and credential custody/,
  )
  assert.equal(await readFile(configFile, "utf8"), saved)

  await assert.rejects(
    () => prepareSetup({
      configFile,
      credentialVariable: TOKEN_ALIAS,
      environment: { [TOKEN_ALIAS]: TOKEN },
      preset: {
        guildIds: [GUILD_ID],
        name: "server-observer",
      },
      reuseExistingConfig: true,
      service: statusProvider(),
    }),
    /owns its credential reference/,
  )

  const verified = await prepareSetup({
    configFile,
    environment: { [TOKEN_ALIAS]: TOKEN },
    service: statusProvider(),
  })
  assert.equal(verified.configBackupFile, null)
  assert.equal(await readFile(configFile, "utf8"), saved)

  const replacement = await prepareSetup({
    configFile,
    credentialVariable: TOKEN_ALIAS,
    environment: source,
    overwriteConfig: true,
    preset: {
      channelIds: [CHANNEL_ID],
      guildIds: [GUILD_ID],
      name: "channel-reader",
    },
    service: statusProvider(),
  })
  assert.ok(replacement.configBackupFile)
  assert.deepEqual(
    loadConnectorConfigDocumentFile(replacement.configBackupFile),
    initial,
  )
  assert.deepEqual(
    loadConnectorConfigDocumentFile(configFile).tools.toolsets,
    getSetupPreset("channel-reader").toolsets,
  )

  const changedIdentity = status()
  changedIdentity.application.id = "100000000000000002"
  await assert.rejects(
    () => prepareSetup({
      configFile,
      credentialVariable: TOKEN_ALIAS,
      environment: source,
      overwriteConfig: true,
      preset: {
        guildIds: [GUILD_ID],
        name: "server-observer",
      },
      service: {
        async getStatus() {
          return changedIdentity
        },
      },
    }),
    /locked to its existing Discord identity/,
  )
})

test("setup records and verifies a file-backed credential without forwarding an environment secret", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "guildcontrol-setup-file-secret-"))
  context.after(() => rm(temporary, { force: true, recursive: true }))
  const root = await realpath(temporary)
  const configFile = join(root, "discord.json")
  const credentialFile = join(root, "discord-token")
  await writeFile(credentialFile, `${TOKEN}\n`, { mode: 0o600 })

  const report = await prepareSetup({
    configFile,
    credentialFile,
    environment: { PATH: "/usr/bin" },
    preset: {
      guildIds: [GUILD_ID],
      name: "server-observer",
    },
    service: statusProvider(),
  })

  assert.deepEqual(report.credential, {
    path: credentialFile,
    provider: "file",
  })
  assert.deepEqual(report.launch.environment, { forward: [], set: {} })
  assert.deepEqual(report.launch.secrets, {
    environmentVariables: [],
    files: [credentialFile],
  })
  assert.deepEqual(loadConnectorConfigDocumentFile(configFile).credential, {
    path: credentialFile,
    provider: "file",
  })
  assert.doesNotMatch(JSON.stringify(report), new RegExp(TOKEN))
  assert.deepEqual(
    (await prepareSetup({
      configFile,
      environment: { PATH: "/usr/bin" },
      service: statusProvider(),
    })).credential,
    report.credential,
  )

  await assert.rejects(
    () => prepareSetup({
      configFile: join(root, "redaction.json"),
      credentialFile,
      environment: { PATH: "/usr/bin" },
      preset: {
        guildIds: [GUILD_ID],
        name: "server-observer",
      },
      service: {
        async getStatus() {
          throw new Error(`Credential ${TOKEN} rejected`)
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Credential \[redacted\] rejected/)
      assert.doesNotMatch(error.message, new RegExp(TOKEN))
      return true
    },
  )
})

test("setup requires one schema-v2 target and rejects ambient policy or implicit replacement", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "guildcontrol-setup-selection-"))
  context.after(() => rm(temporary, { force: true, recursive: true }))
  const root = await realpath(temporary)
  const configFile = join(root, "discord.json")
  const document = createConnectorConfigDocument({
    applicationId: APPLICATION_ID,
    botId: BOT_ID,
    channelIds: [CHANNEL_ID],
    credentialVariable: TOKEN_ALIAS,
    guildIds: [GUILD_ID],
    name: "discord",
    toolsets: ["connector", "messages"],
    toolSurface: "progressive",
  })

  await assert.rejects(
    () => prepareConfigSetup({
      environment: { [TOKEN_ALIAS]: TOKEN },
      service: statusProvider(),
    }),
    /requires a configuration file or profile/,
  )
  await assert.rejects(
    () => prepareConfigSetup({
      configFile,
      environment: { [TOKEN_ALIAS]: TOKEN },
      service: statusProvider(),
    }),
    /target was not found/,
  )
  await writeConnectorConfigDocumentFile(configFile, document)
  await assert.rejects(
    () => prepareConfigSetup({
      configFile,
      credentialVariable: TOKEN_ALIAS,
      environment: { [TOKEN_ALIAS]: TOKEN },
      service: statusProvider(),
    }),
    /require --preset/,
  )
  await assert.rejects(
    () => prepareConfigSetup({
      configFile,
      environment: {
        [TOKEN_ALIAS]: TOKEN,
        [UNDECLARED_POLICY_ENVIRONMENT_VARIABLE]: "true",
      },
      service: statusProvider(),
    }),
    /conflicts with undeclared environment variables/,
  )
  await assert.rejects(
    () => prepareConfigSetup({
      configFile,
      environment: {
        [CONFIG_FILE_ENVIRONMENT_VARIABLE]: join(root, "other.json"),
        [TOKEN_ALIAS]: TOKEN,
      },
      service: statusProvider(),
    }),
    new RegExp(`conflicts with ${CONFIG_FILE_ENVIRONMENT_VARIABLE}`),
  )
  const profileDirectory = join(root, "profiles")
  await prepareConfigSetup({
    credentialVariable: TOKEN_ALIAS,
    environment: { [TOKEN_ALIAS]: TOKEN },
    preset: {
      guildIds: [GUILD_ID],
      name: "server-observer",
    },
    profileDirectory,
    profileName: "observer",
    service: statusProvider(),
  })
  await assert.rejects(
    () => prepareConfigSetup({
      environment: {
        [CONFIG_FILE_ENVIRONMENT_VARIABLE]: configFile,
        [TOKEN_ALIAS]: TOKEN,
      },
      profileDirectory,
      profileName: "observer",
      service: statusProvider(),
    }),
    new RegExp(`conflicts with ${CONFIG_FILE_ENVIRONMENT_VARIABLE}`),
  )
})

test("MCP smoke negotiates the adapter, validates risk annotations, and calls status only", async () => {
  const report = await smokeConnector({
    configOverrides: fixturePolicy(),
    service: toolService(),
  })

  assert.equal(report.status, "ok")
  assert.equal(report.transport, "in-memory")
  assert.match(report.protocolVersion, /^2025-/)
  assert.equal(report.serverName, "guildcontrol")
  assert.equal(report.serverVersion, "2.2.1")
  assert.equal(report.applicationId, APPLICATION_ID)
  assert.equal(report.botId, BOT_ID)
  assert.equal(
    report.toolCount,
    Object.keys(MCP_TOOL_CATALOG).length + MCP_ALWAYS_AVAILABLE_TOOL_NAMES.length,
  )
  assert.equal(
    report.readOnlyTools.length + report.writeCapableTools.length,
    report.toolCount,
  )
  assert.equal(
    report.destructiveTools.every((name) => report.writeCapableTools.includes(name)),
    true,
  )
  assert.equal(report.writeCapableTools.includes("send_message"), true)
  assert.equal(report.writeCapableTools.includes("signal_command_processing"), true)
  assert.equal(report.writeCapableTools.includes("execute_channel_creation"), true)
  assert.equal(report.toolSurface, "full")
  assert.deepEqual(report.toolsets, MCP_TOOLSET_NAMES)
  assert.deepEqual(report.promptNames, [
    "audit_bot_installations",
    "author_guild_blueprint",
    "catch_up_discord_channels",
    "find_guild_members",
    "inspect_directed_discord_notes",
    "inspect_discord_coordination_task",
    "inspect_discord_poll",
    "inspect_guild_ban",
    "prepare_guild_recovery",
    "recall_discord_conversation",
    "review_announcement_crosspost",
    "review_announcement_subscription",
    "review_application_commands",
    "review_application_emoji_change",
    "review_application_entitlement_consumption",
    "review_application_intent_enablement",
    "review_application_monetization",
    "review_application_role_connection_metadata",
    "review_application_role_connection_metadata_change",
    "review_application_skus",
    "review_application_test_entitlement_change",
    "review_attachment_message",
    "review_automod_change",
    "review_bot_profile_change",
    "review_bulk_guild_ban",
    "review_bulk_member_role_change",
    "review_channel_clone",
    "review_channel_creation",
    "review_channel_deletion",
    "review_channel_metadata_change",
    "review_channel_order",
    "review_channel_permission_overwrite",
    "review_channel_permission_sync",
    "review_direct_message_change",
    "review_embed_message",
    "review_forum_post",
    "review_forum_tag_change",
    "review_global_application_command_change",
    "review_guild_application_command_change",
    "review_guild_blueprint",
    "review_guild_community_change",
    "review_guild_departure",
    "review_guild_expression_change",
    "review_guild_incident_action_change",
    "review_guild_integration_deletion",
    "review_guild_profile_change",
    "review_guild_prune",
    "review_guild_scaffold",
    "review_guild_settings_change",
    "review_guild_template_change",
    "review_guild_webhooks",
    "review_invite_creation",
    "review_invite_deletion",
    "review_member_moderation",
    "review_member_nickname_change",
    "review_member_role_change",
    "review_member_verification_change",
    "review_member_voice_change",
    "review_message_deletion",
    "review_message_forward",
    "review_message_pin",
    "review_onboarding_change",
    "review_pending_native_interactions",
    "review_poll_creation",
    "review_poll_end",
    "review_reaction_moderation",
    "review_role_configuration",
    "review_role_creation",
    "review_role_deletion",
    "review_role_order",
    "review_scheduled_event_change",
    "review_soundboard_change",
    "review_stage_instance_change",
    "review_thread_change",
    "review_voice_channel_status_change",
    "review_webhook_change",
    "review_webhook_creation",
    "review_webhook_deletion",
    "review_webhook_message_deletion",
    "review_welcome_screen_change",
    "review_widget_settings_change",
    "route_discord_goal",
    "search_guild_messages",
    "summarize_channel",
  ])
  assert.deepEqual(report.resourceUris, [
    "discord://application/emojis",
    "discord://application/posture",
    "discord://application/role-connection-metadata",
    "discord://application/skus",
    "discord://connector/activity",
    "discord://connector/component-templates",
    "discord://connector/coordination",
    "discord://connector/guild-blueprint-starters",
    "discord://connector/installations",
    "discord://connector/observability",
    "discord://connector/policy",
    "discord://connector/safety",
    "discord://connector/tool-access",
    "discord://gateway/events",
    "discord://gateway/status",
    "discord://guilds",
    "discord://interactions/continuations",
    "discord://interactions/pending",
    "discord://interactions/status",
    "discord://soundboard/defaults",
    "discord://voice/regions",
    "ui://guildcontrol/plan-review",
  ])
  assert.deepEqual(report.resourceTemplateUris, [
    "discord://application/commands/{guildId}",
    "discord://channels/{channelId}",
    "discord://channels/{channelId}/access",
    "discord://channels/{channelId}/announcement-subscriptions",
    "discord://channels/{channelId}/forum-tags",
    "discord://channels/{channelId}/messages/{messageId}",
    "discord://channels/{channelId}/messages/{messageId}/attachments/{attachmentId}",
    "discord://channels/{channelId}/messages/{messageId}/reactions",
    "discord://channels/{channelId}/permission-overwrites",
    "discord://channels/{channelId}/webhooks",
    "discord://connector/tool-access/{toolName}",
    "discord://guilds/{guildId}/automod-rules",
    "discord://guilds/{guildId}/bans/{userId}",
    "discord://guilds/{guildId}/channel-order",
    "discord://guilds/{guildId}/channels",
    "discord://guilds/{guildId}/channels/{channelId}/deletion-readiness",
    "discord://guilds/{guildId}/channels/{channelId}/stage-instance",
    "discord://guilds/{guildId}/channels/{channelId}/voice-status",
    "discord://guilds/{guildId}/community",
    "discord://guilds/{guildId}/emojis",
    "discord://guilds/{guildId}/incident-actions",
    "discord://guilds/{guildId}/integrations",
    "discord://guilds/{guildId}/invites/{inviteRef}",
    "discord://guilds/{guildId}/members/{userId}",
    "discord://guilds/{guildId}/members/{userId}/voice-state",
    "discord://guilds/{guildId}/onboarding",
    "discord://guilds/{guildId}/profile",
    "discord://guilds/{guildId}/role-order",
    "discord://guilds/{guildId}/roles",
    "discord://guilds/{guildId}/roles/{roleId}",
    "discord://guilds/{guildId}/roles/{roleId}/deletion-readiness",
    "discord://guilds/{guildId}/scheduled-events",
    "discord://guilds/{guildId}/settings",
    "discord://guilds/{guildId}/soundboard",
    "discord://guilds/{guildId}/soundboard/{soundId}",
    "discord://guilds/{guildId}/stickers",
    "discord://guilds/{guildId}/templates",
    "discord://guilds/{guildId}/threads/{threadId}",
    "discord://guilds/{guildId}/threads/{threadId}/members/{userId}",
    "discord://guilds/{guildId}/vanity-url",
    "discord://guilds/{guildId}/voice-regions",
    "discord://guilds/{guildId}/webhooks",
    "discord://guilds/{guildId}/welcome-screen",
    "discord://guilds/{guildId}/widget-settings",
  ])
  assert.deepEqual(report.destructiveTools, [
    "delete_messages",
    "edit_own_message",
    "edit_webhook_message",
    "execute_announcement_crosspost",
    "execute_announcement_subscription",
    "execute_application_emoji_change",
    "execute_application_entitlement_consumption",
    "execute_application_intent_enablement",
    "execute_application_role_connection_metadata_change",
    "execute_application_test_entitlement_change",
    "execute_automod_change",
    "execute_bot_profile_change",
    "execute_bulk_guild_ban",
    "execute_bulk_member_role_change",
    "execute_channel_clone",
    "execute_channel_deletion",
    "execute_channel_metadata_change",
    "execute_channel_order",
    "execute_channel_permission_overwrite",
    "execute_channel_permission_sync",
    "execute_component_message",
    "execute_direct_message_change",
    "execute_embed_message",
    "execute_forum_tag_change",
    "execute_global_application_command_change",
    "execute_guild_application_command_change",
    "execute_guild_blueprint",
    "execute_guild_community_change",
    "execute_guild_departure",
    "execute_guild_expression_change",
    "execute_guild_incident_action_change",
    "execute_guild_integration_deletion",
    "execute_guild_profile_change",
    "execute_guild_prune",
    "execute_guild_settings_change",
    "execute_guild_soundboard_change",
    "execute_guild_template_change",
    "execute_guild_welcome_screen_change",
    "execute_guild_widget_settings_change",
    "execute_invite_deletion",
    "execute_member_moderation",
    "execute_member_nickname_change",
    "execute_member_role_change",
    "execute_member_verification_change",
    "execute_member_voice_change",
    "execute_message_forward",
    "execute_message_pin",
    "execute_native_interaction_command",
    "execute_onboarding_change",
    "execute_poll_end",
    "execute_reaction_moderation",
    "execute_role_configuration",
    "execute_role_deletion",
    "execute_role_order",
    "execute_scheduled_event_change",
    "execute_stage_instance_change",
    "execute_thread_change",
    "execute_voice_channel_status_change",
    "execute_webhook_change",
    "execute_webhook_creation",
    "execute_webhook_deletion",
    "execute_webhook_message_deletion",
    "remove_own_reaction",
  ])
  assert.equal(report.readOnlyTools.includes("get_connector_status"), true)
  assert.equal(report.readOnlyTools.includes("parse_discord_reference"), true)
  assert.equal(report.readOnlyTools.includes("get_observability_status"), true)
  assert.equal(report.readOnlyTools.includes("discover_discord_tools"), true)
  assert.equal(report.readOnlyTools.includes("search_guildcontrol_docs"), true)
  assert.equal(report.readOnlyTools.includes("plan_channel_creation"), true)
  assert.equal(
    report.readOnlyTools.includes("plan_application_intent_enablement"),
    true,
  )
  assert.equal(report.readOnlyTools.includes("get_current_bot_profile"), true)
  assert.equal(report.readOnlyTools.includes("plan_bot_profile_change"), true)
  assert.equal(report.readOnlyTools.includes("audit_channel_order"), true)
  assert.equal(report.readOnlyTools.includes("plan_channel_clone"), true)
  assert.equal(report.readOnlyTools.includes("plan_channel_order"), true)
  assert.equal(report.readOnlyTools.includes("get_voice_channel_status"), true)
  assert.equal(report.readOnlyTools.includes("plan_voice_channel_status_change"), true)
  assert.equal(report.readOnlyTools.includes("plan_forum_post"), true)
  assert.equal(report.readOnlyTools.includes("audit_forum_tags"), true)
  assert.equal(report.readOnlyTools.includes("plan_forum_tag_change"), true)
  assert.equal(report.readOnlyTools.includes("plan_guild_blueprint"), true)
  assert.equal(report.readOnlyTools.includes("verify_guild_blueprint"), true)
  assert.equal(report.readOnlyTools.includes("plan_attachment_message"), true)
  assert.equal(report.readOnlyTools.includes("preview_component_layout"), true)
  assert.equal(report.readOnlyTools.includes("plan_component_message"), true)
  assert.equal(report.readOnlyTools.includes("preview_embed_message"), true)
  assert.equal(report.readOnlyTools.includes("plan_embed_message"), true)
  assert.equal(report.readOnlyTools.includes("verify_embed_message"), true)
  assert.equal(report.readOnlyTools.includes("plan_member_role_change"), true)
  assert.equal(report.readOnlyTools.includes("get_member_voice_state"), true)
  assert.equal(report.readOnlyTools.includes("plan_member_voice_change"), true)
  assert.equal(report.readOnlyTools.includes("get_thread_state"), true)
  assert.equal(report.readOnlyTools.includes("get_thread_membership"), true)
  assert.equal(report.readOnlyTools.includes("plan_thread_change"), true)
  assert.equal(report.readOnlyTools.includes("plan_message_forward"), true)
  assert.equal(report.readOnlyTools.includes("plan_role_creation"), true)
  assert.equal(report.readOnlyTools.includes("plan_role_configuration"), true)
  assert.equal(report.readOnlyTools.includes("plan_poll_creation"), true)
  assert.equal(report.readOnlyTools.includes("plan_poll_end"), true)
  assert.equal(report.destructiveTools.includes("execute_channel_creation"), false)
  assert.equal(report.destructiveTools.includes("execute_role_creation"), false)
  assert.equal(report.destructiveTools.includes("execute_attachment_message"), false)
  assert.equal(report.destructiveTools.includes("execute_forum_post"), false)
  assert.equal(report.destructiveTools.includes("execute_poll_creation"), false)
  assert.doesNotMatch(JSON.stringify(report), new RegExp(TOKEN))

  await assert.rejects(
    () => smokeConnector({
      configOverrides: fixturePolicy(),
      service: toolServiceWithoutScopedGuilds(),
    }),
    /incomplete configured guild installations/,
  )
})

test("MCP smoke negotiates the stable protocol through a minimized spawned stdio process", async () => {
  const token = "spawned-stdio-smoke-token"
  const environment = {
    [SPAWNED_SMOKE_TOKEN_VARIABLE]: token,
    UNRELATED_PRIVATE_VALUE: "must-not-reach-child",
  }
  const document = createConnectorConfigDocument({
    applicationId: APPLICATION_ID,
    botId: BOT_ID,
    credentialVariable: SPAWNED_SMOKE_TOKEN_VARIABLE,
    guildIds: [GUILD_ID],
    name: "spawned-smoke",
    toolsets: ["connector"],
    toolSurface: "full",
  })
  const config = loadConnectorConfigDocument(document, environment)
  const report = await smokeNativeConnector({
    config,
    environment,
    launch: {
      args: [
        "--import",
        "tsx",
        resolve("test/fixtures/stdio-smoke-server.ts"),
      ],
      command: process.execPath,
    },
  })

  assert.equal(report.status, "ok")
  assert.equal(report.transport, "stdio")
  assert.equal(report.protocolVersion, "2026-07-28")
  assert.equal(report.serverName, "guildcontrol")
  assert.equal(report.serverVersion, "2.2.1")
  assert.equal(report.applicationId, APPLICATION_ID)
  assert.equal(report.botId, BOT_ID)
  assert.equal(report.toolsets.includes("connector"), true)
  assert.doesNotMatch(JSON.stringify(report), new RegExp(token))
  assert.doesNotMatch(JSON.stringify(report), /must-not-reach-child/)
})

test("Spawned MCP smoke bounds and redacts startup failure diagnostics", async () => {
  const token = "spawned-stdio-private-token"
  const environment = { [SPAWNED_SMOKE_TOKEN_VARIABLE]: token }
  const document = createConnectorConfigDocument({
    applicationId: APPLICATION_ID,
    botId: BOT_ID,
    credentialVariable: SPAWNED_SMOKE_TOKEN_VARIABLE,
    guildIds: [GUILD_ID],
    name: "spawned-smoke-failure",
    toolsets: ["connector"],
    toolSurface: "full",
  })
  const config = loadConnectorConfigDocument(document, environment)

  await assert.rejects(
    () => smokeNativeConnector({
      config,
      environment,
      launch: {
        args: [
          "--import",
          "tsx",
          resolve("test/fixtures/stdio-smoke-server.ts"),
        ],
        command: process.execPath,
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Spawned stdio MCP smoke failed/)
      assert.match(error.message, /\[redacted\]/)
      assert.doesNotMatch(error.message, new RegExp(token))
      assert.ok(Buffer.byteLength(error.message, "utf8") < 9_000)
      return true
    },
  )
})

test("MCP smoke validates voice-channel status policy without opening its Gateway", async () => {
  const report = await smokeConnector({
    configOverrides: fixturePolicy({
      capabilities: {
        channelMetadataChanges: true,
      },
      scopes: {
        channelMetadataIds: [CHANNEL_ID],
      },
    }),
    service: toolService(),
  })

  assert.equal(report.status, "ok")
  assert.equal(report.readOnlyTools.includes("get_voice_channel_status"), true)
  assert.equal(report.readOnlyTools.includes("plan_voice_channel_status_change"), true)
  assert.equal(
    report.promptNames.includes("review_voice_channel_status_change"),
    true,
  )
  assert.equal(
    report.resourceTemplateUris.includes(
      "discord://guilds/{guildId}/channels/{channelId}/voice-status",
    ),
    true,
  )
})

test("MCP smoke expands a progressive subset without broadening configured toolsets", async () => {
  const report = await smokeConnector({
    configOverrides: fixturePolicy({
      tools: {
        toolsets: ["messages", "activity"],
        surface: "progressive",
      },
    }),
    service: toolService(),
  })

  assert.equal(report.status, "ok")
  assert.equal(report.toolSurface, "progressive")
  assert.deepEqual(report.toolsets, ["activity", "messages"])
  assert.equal(report.toolCount, 11)
  assert.deepEqual(report.destructiveTools, [])
  assert.deepEqual(report.writeCapableTools, [])
  assert.deepEqual(report.promptNames, [
    "catch_up_discord_channels",
    "inspect_discord_coordination_task",
    "recall_discord_conversation",
    "route_discord_goal",
    "search_guild_messages",
    "summarize_channel",
  ])
  assert.deepEqual(report.readOnlyTools, [
    "analyze_community_activity",
    "catch_up_messages",
    "discover_discord_tools",
    "get_message",
    "list_activity",
    "list_message_replies",
    "read_message_attachment",
    "read_messages",
    "recall_conversation",
    "search_guildcontrol_docs",
    "search_messages",
  ])
})

test("MCP smoke rejects connector status disclosure and altered privacy evidence", async () => {
  const safeStatus = status()
  const unsafeStatuses = [
    {
      ...safeStatus,
      application: {
        ...safeStatus.application,
        name: "private-application-profile",
      },
      auditFile: "/private/connector/activity.jsonl",
      bot: {
        ...safeStatus.bot,
        username: "private-bot-profile",
      },
    },
    {
      ...safeStatus,
      privacy: {
        ...safeStatus.privacy,
        localPaths: "included",
      },
    },
    {
      ...safeStatus,
      privacy: undefined,
    },
    {
      ...safeStatus,
      installationAudit: {
        ...safeStatus.installationAudit,
        completeness: {
          ...safeStatus.installationAudit.completeness,
          pagesRead: 2,
        },
      },
    },
    {
      ...safeStatus,
      installationAudit: {
        ...safeStatus.installationAudit,
        configuredGuildIds: [OTHER_GUILD_ID],
      },
    },
  ] as unknown as Array<Awaited<ReturnType<ConnectorService["getStatus"]>>>

  for (const connectorStatus of unsafeStatuses) {
    await assert.rejects(
      () => smokeConnector({
        configOverrides: fixturePolicy(),
        service: toolService(connectorStatus),
      }),
      /get_connector_status returned an invalid privacy report/u,
    )
  }
})
