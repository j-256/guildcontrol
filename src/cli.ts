#!/usr/bin/env node

import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  exportDiscordActivityHtml,
  type DiscordActivityHtmlExportReport,
} from "./activity-html.js"
import {
  reviewDiscordActivity,
  type DiscordActivityReviewReport,
} from "./activity-review.js"
import {
  checkDiscordCatalog,
  runGuildControlCatalog,
  type DiscordCatalogCheckReport,
} from "./catalog.js"
import {
  exportDiscordCatalogHtml,
  type DiscordCatalogHtmlExportReport,
} from "./catalog-html.js"
import {
  createBotInstallPlan,
  type BotInstallPlan,
} from "./bot-install.js"
import {
  exportDiscordOnboardingHtml,
  type DiscordOnboardingHtmlExportReport,
} from "./onboarding-html.js"
import {
  exportOnboardHtml,
  type OnboardHtmlExportReport,
} from "./onboard-html.js"
import {
  ONBOARD_HOST_IDS,
  assertReusableOnboardPolicy,
  createOnboardReport,
  isOnboardHostId,
  onboardHostDescriptor,
  onboardHostSupportsCredentialFile,
  resolveAvailableOnboardHtmlFile,
  resolveDefaultOnboardConfigFile,
  reusableOnboardInstallPlan,
  type OnboardCredentialAccess,
  type OnboardHostId,
  type OnboardReport,
} from "./onboard.js"
import {
  exportDiscordHostActivationHtml,
  type DiscordHostActivationHtmlExportReport,
} from "./host-activation-html.js"
import {
  exportDiscordMigrationHtml,
  type DiscordMigrationHtmlExportReport,
} from "./migration-html.js"
import {
  createMigrationCatalog,
  createMigrationPlan,
  normalizeMigrationSourceId,
  type MigrationCatalogReport,
  type MigrationPlanReport,
} from "./migration-planner.js"
import {
  createHostActivationPlan,
  type HostActivationPlan,
} from "./host-activation.js"
import {
  HOST_ADAPTER_IDS,
  createHostAdapterCatalog,
  findHostAdapter,
  isHostAdapterId,
  type HostAdapter,
  type HostAdapterCatalog,
  type HostAdapterId,
} from "./host-adapters.js"
import {
  detectHosts,
  type HostDetectionOptions,
  type HostDetectionReport,
} from "./host-detection.js"
import {
  inspectHostAdapterFile,
  type HostInspectionReport,
} from "./host-inspection.js"
import {
  applyHostAdapterFile,
  planHostAdapterFile,
  type ApplyHostChangeOptions,
  type HostChangeApplyReport,
  type HostChangePlanReport,
} from "./host-installation.js"
import {
  CONNECTOR_CLI_COMMAND,
  CONNECTOR_NPX_ARGUMENTS,
  CONNECTOR_NPX_COMMAND,
  CONNECTOR_VERSION,
  CONFIG_FILE_ENVIRONMENT_VARIABLE,
  CONNECTOR_LIMITS,
  DEFAULT_TOKEN_ENVIRONMENT_VARIABLE,
  DISCORD_SNOWFLAKE_MAX,
  DISCORD_SNOWFLAKE_PATTERN,
  DISCORD_TOKEN_ENVIRONMENT_PATTERN,
} from "./constants.js"
import {
  loadConnectorConfig,
  resolveConnectorConfigDocumentAuditFile,
  type ConnectorConfig,
} from "./config.js"
import {
  applyConfigChange,
  planConfigChange,
  type ConfigChangeApplyOptions,
  type ConfigChangeApplyReport,
  type ConfigChangePlanOptions,
  type ConfigChangePlanReport,
} from "./config-review.js"
import {
  exportDiscordConfigWorkbenchHtml,
  type DiscordConfigWorkbenchHtmlExportReport,
} from "./config-workbench-html.js"
import {
  loadConnectorConfigDocumentFile,
  type ConnectorCredentialReference,
  type ConnectorConfigDocument,
} from "./config-document.js"
import {
  explainConnectorConfig,
  ensureConnectorConfigDirectory,
  initializeConnectorConfigFile,
  resolveConnectorConfigFile,
  resolveConnectorSecretFile,
  showConnectorConfigFile,
  validateConnectorConfigFile,
  type ConfigExplainReport,
  type ConfigInitOptions,
  type ConfigShowReport,
  type ConfigValidationReport,
  type ConfigWriteReport,
} from "./config-operator.js"
import {
  CONFIG_RECIPE_REPORT_SCHEMA_VERSION,
  CONFIG_RECIPES,
  applyConfigRecipe,
  getConfigRecipe,
  normalizeConfigRecipeRequest,
  planConfigRecipe,
  type ConfigRecipeApplyOptions,
  type ConfigRecipeApplyReport,
  type ConfigRecipeDescriptor,
  type ConfigRecipePlanOptions,
  type ConfigRecipePlanReport,
} from "./config-recipes.js"
import {
  ConfigurationError,
  CredentialUnavailableError,
  redactText,
  RuntimeConfigurationRequiredError,
} from "./errors.js"
import { isMainModule } from "./entrypoint.js"
import { runGuildControlServer } from "./mcp.js"
import {
  lowMemoryNodeArguments,
  STANDARD_RUNTIME_ARGUMENT,
} from "./node-runtime.js"
import {
  FileOperationStore,
  operationReceiptDirectory,
} from "./operation-store.js"
import {
  classifyCliFailure,
  safeCliFailureMessage,
  type CliFailureCategory,
  type CliFailureGuidance,
  type OperatorRecovery,
} from "./operator-recovery.js"
import {
  diagnoseConnector,
  createStdioLaunchDescriptor,
  OPERATOR_REPORT_SCHEMA_VERSION,
  prepareSetup,
  smokeConnector,
  type DoctorOptions,
  type DoctorReport,
  type SetupOptions,
  type SetupReport,
  type SmokeOptions,
  type SmokeReport,
} from "./operator.js"
import {
  activateProfile,
  listProfiles,
  loadProfile,
  normalizeProfileName,
  restoreProfile,
  trashProfile,
  type ActivatedProfile,
  type ConnectorProfile,
  type ProfileLocationOptions,
  type TrashedProfile,
} from "./profile.js"
import {
  FileWriteCoordinator,
  writeCoordinationDirectory,
  type WriteCoordinationList,
  type WriteCoordinationResolution,
} from "./write-coordination.js"
import {
  getSetupPreset,
  SETUP_PRESETS,
  type SetupPresetDescriptor,
  type SetupPresetSelection,
} from "./setup-presets.js"
import {
  CliInteractionCancelledError,
  DEFAULT_CLI_INTERACTION,
  type CliInteraction,
} from "./terminal-interaction.js"

const CLI_COMMANDS = Object.freeze([
  "activity",
  "catalog",
  "config",
  "coordination",
  "doctor",
  "help",
  "host",
  "migrate",
  "onboard",
  "preset",
  "profile",
  "recipe",
  "serve",
  "setup",
  "smoke",
  "version",
] as const)

const CLI_EXIT_CODES = Object.freeze({
  canceled: 130,
  failure: 2,
  success: 0,
  warning: 1,
} as const)

const CLI_HELP_FLAGS: ReadonlySet<string> = new Set(["--help", "-h"])

const CLI_OPTION_VALUE_NAMES: ReadonlySet<string> = new Set([
  "--adapter",
  "--application-id",
  "--bot-id",
  "--channel-id",
  "--command",
  "--config",
  "--confirm",
  "--confirm-installed",
  "--guild-id",
  "--host",
  "--host-file",
  "--html",
  "--inspect-host-file",
  "--limit",
  "--name",
  "--plan-digest",
  "--preset",
  "--profile",
  "--token-env",
  "--token-file",
  "--user-id",
])

const CLI_SHORT_OPTION_ALIASES: Readonly<
  Partial<Record<CliCommand, Readonly<Record<string, string>>>>
> = Object.freeze({
  activity: Object.freeze({
    "-c": "--config",
    "-j": "--json",
    "-l": "--limit",
    "-p": "--profile",
  }),
  catalog: Object.freeze({
    "-c": "--check",
    "-j": "--json",
  }),
  config: Object.freeze({ "-j": "--json" }),
  coordination: Object.freeze({
    "-c": "--config",
    "-j": "--json",
    "-p": "--profile",
  }),
  doctor: Object.freeze({
    "-c": "--config",
    "-j": "--json",
    "-o": "--online",
    "-p": "--profile",
    "-v": "--verbose",
  }),
  host: Object.freeze({
    "-c": "--config",
    "-j": "--json",
    "-p": "--profile",
  }),
  migrate: Object.freeze({ "-j": "--json" }),
  onboard: Object.freeze({
    "-c": "--config",
    "-j": "--json",
  }),
  preset: Object.freeze({ "-j": "--json" }),
  profile: Object.freeze({ "-j": "--json" }),
  recipe: Object.freeze({ "-j": "--json" }),
  serve: Object.freeze({
    "-c": "--config",
    "-p": "--profile",
  }),
  setup: Object.freeze({
    "-c": "--config",
    "-j": "--json",
    "-p": "--profile",
  }),
  smoke: Object.freeze({
    "-c": "--config",
    "-j": "--json",
    "-p": "--profile",
  }),
})

const CLI_COMMAND_ACTIONS = Object.freeze({
  config: Object.freeze([
    "init",
    "validate",
    "show",
    "explain",
    "workbench",
    "plan",
    "replace",
    "apply",
  ] as const),
  coordination: Object.freeze(["list", "resolve"] as const),
  host: Object.freeze(["detect", "generate", "plan", "apply"] as const),
  migrate: Object.freeze(["list", "plan"] as const),
  preset: Object.freeze(["list", "show", "install"] as const),
  profile: Object.freeze(["list", "show", "remove", "restore"] as const),
  recipe: Object.freeze(["list", "show", "plan", "enable", "apply"] as const),
})

type CliCommand = typeof CLI_COMMANDS[number]
type CliActionCommand = keyof typeof CLI_COMMAND_ACTIONS
type CliCommandAction = typeof CLI_COMMAND_ACTIONS[CliActionCommand][number]
type CliActionForCommand<C extends CliCommand> = C extends CliActionCommand
  ? typeof CLI_COMMAND_ACTIONS[C][number]
  : never

function isCliActionCommand(command: CliCommand): command is CliActionCommand {
  return Object.hasOwn(CLI_COMMAND_ACTIONS, command)
}

function isCliCommandAction<C extends CliCommand>(
  command: C,
  action: string,
): action is CliActionForCommand<C> {
  return isCliActionCommand(command)
    && (CLI_COMMAND_ACTIONS[command] as readonly string[]).includes(action)
}

function isCliHelpFlag(value: string | undefined): boolean {
  return value !== undefined && CLI_HELP_FLAGS.has(value)
}

export type ParsedCliArguments =
  | {
    command: "activity"
    configFile?: string
    htmlFile?: string
    json: boolean
    limit: number
    profileName?: string
  }
  | { check: boolean; command: "catalog"; htmlFile?: string; json: boolean }
  | {
    action: "apply"
    candidateFile: string
    command: "config"
    confirmation: string
    file: string
    json: boolean
    planDigest: string
  }
  | {
    acceptCurrentPlan: boolean
    action: "replace"
    candidateFile: string
    command: "config"
    confirmation?: string
    file: string
    json: boolean
  }
  | {
    action: "explain"
    command: "config"
    json: boolean
    path?: string
  }
  | {
    action: "init"
    applicationId: string
    botId: string
    channelIds: string[]
    command: "config"
    credentialFile?: string
    credentialVariable?: string
    file: string
    guildIds: string[]
    json: boolean
    name: string
    overwrite: boolean
    preset?: string
  }
  | {
    action: "plan"
    candidateFile: string
    command: "config"
    file: string
    json: boolean
  }
  | {
    action: "show" | "validate"
    command: "config"
    file: string
    json: boolean
  }
  | {
    action: "workbench"
    command: "config"
    file: string
    htmlFile: string
    json: boolean
  }
  | {
    action: "list"
    command: "coordination"
    configFile?: string
    json: boolean
    profileName?: string
  }
  | {
    action: "resolve"
    claimId: string
    command: "coordination"
    configFile?: string
    confirmation: string
    json: boolean
    profileName?: string
  }
  | {
    command: "doctor"
    configFile?: string
    json: boolean
    online: boolean
    profileName?: string
    verbose: boolean
  }
  | {
    action?: CliCommandAction
    command: "help"
    topic: CliCommand | undefined
  }
  | {
    action: "detect"
    command: "host"
    json: boolean
  }
  | {
    action: "generate"
    adapterId?: HostAdapterId
    command: "host"
    configFile?: string
    htmlFile?: string
    inspectHostFile?: string
    json: boolean
    launcherCommand: string | undefined
    packageLaunch?: true
    profileName?: string
    serverName: string | undefined
  }
  | {
    action: "plan"
    adapterId: HostAdapterId
    command: "host"
    configFile?: string
    hostFile: string
    json: boolean
    launcherCommand: string | undefined
    packageLaunch?: true
    profileName?: string
    serverName: string | undefined
  }
  | {
    action: "apply"
    adapterId: HostAdapterId
    command: "host"
    configFile?: string
    confirmation: string
    hostFile: string
    json: boolean
    launcherCommand: string | undefined
    packageLaunch?: true
    planDigest: string
    profileName?: string
    serverName: string | undefined
  }
  | {
    action: "list"
    command: "migrate"
    json: boolean
  }
  | {
    action: "plan"
    command: "migrate"
    htmlFile?: string
    json: boolean
    sourceId: string
  }
  | {
    applicationId?: string
    command: "onboard"
    configFile?: string
    confirmation?: string
    credentialFile?: string
    credentialVariable?: string
    detectHost: boolean
    guildId?: string
    hostId?: OnboardHostId
    htmlFile?: string
    json: boolean
    open: boolean
  }
  | {
    action: "install"
    applicationId: string
    command: "preset"
    guildId: string
    htmlFile?: string
    json: boolean
    name: string
  }
  | {
    action: "list"
    command: "preset"
    json: boolean
  }
  | {
    action: "show"
    command: "preset"
    json: boolean
    name: string
  }
  | {
    action: "list"
    command: "profile"
    json: boolean
  }
  | {
    action: "show"
    command: "profile"
    json: boolean
    name: string
  }
  | {
    action: "remove" | "restore"
    command: "profile"
    confirmation: string
    json: boolean
    name: string
  }
  | {
    action: "list"
    command: "recipe"
    json: boolean
  }
  | {
    action: "show"
    command: "recipe"
    json: boolean
    name: string
  }
  | {
    action: "plan"
    channelIds: string[]
    command: "recipe"
    file: string
    guildIds: string[]
    json: boolean
    name: string
    userIds: string[]
  }
  | {
    acceptCurrentPlan: boolean
    action: "enable"
    channelIds: string[]
    command: "recipe"
    confirmation?: string
    file: string
    guildIds: string[]
    json: boolean
    name: string
    userIds: string[]
  }
  | {
    action: "apply"
    channelIds: string[]
    command: "recipe"
    confirmation: string
    file: string
    guildIds: string[]
    json: boolean
    name: string
    planDigest: string
    userIds: string[]
  }
  | { command: "serve"; configFile?: string; profileName?: string }
  | {
    command: "setup"
    configFile?: string
    credentialFile?: string
    credentialVariable?: string
    json: boolean
    launcherCommand: string | undefined
    overwrite: boolean
    packageLaunch?: true
    preset?: SetupPresetSelection
    profileName?: string
    serverName: string | undefined
  }
  | { command: "smoke"; configFile?: string; json: boolean; profileName?: string }
  | { command: "version" }

export interface CliDependencies {
  activateProfile(
    name: string,
    options: ProfileLocationOptions,
  ): Promise<ActivatedProfile>
  applyHostFile(
    plan: HostActivationPlan,
    adapterId: HostAdapterId,
    file: string,
    options: ApplyHostChangeOptions,
  ): HostChangeApplyReport
  applyConfigChange(options: ConfigChangeApplyOptions): Promise<ConfigChangeApplyReport>
  catalog(options: {
    stderr: Pick<NodeJS.WriteStream, "write">
  }): unknown
  checkCatalog(): Promise<DiscordCatalogCheckReport>
  exportActivityHtml(
    file: string,
    report: DiscordActivityReviewReport,
  ): Promise<DiscordActivityHtmlExportReport>
  exportCatalogHtml(file: string): Promise<DiscordCatalogHtmlExportReport>
  exportConfigWorkbenchHtml(
    activeFile: string,
    outputFile: string,
  ): Promise<DiscordConfigWorkbenchHtmlExportReport>
  exportHostActivationHtml(
    file: string,
    plan: HostActivationPlan,
  ): Promise<DiscordHostActivationHtmlExportReport>
  exportMigrationHtml(
    file: string,
    plan: MigrationPlanReport,
  ): Promise<DiscordMigrationHtmlExportReport>
  exportOnboardHtml(
    file: string,
    report: OnboardReport,
  ): Promise<OnboardHtmlExportReport>
  exportOnboardingHtml(
    file: string,
    plan: BotInstallPlan,
  ): Promise<DiscordOnboardingHtmlExportReport>
  diagnose(options: DoctorOptions): Promise<DoctorReport>
  detectHosts(options: HostDetectionOptions): Promise<HostDetectionReport>
  ensureConfigDirectory(directory: string): Promise<string>
  explainConfig(path?: string): ConfigExplainReport
  initializeConfig(options: ConfigInitOptions): Promise<ConfigWriteReport>
  inspectHostFile(
    plan: HostActivationPlan,
    adapterId: HostAdapterId,
    file: string,
  ): HostInspectionReport
  listCoordination(activityFile: string): Promise<WriteCoordinationList>
  listProfiles(options: ProfileLocationOptions): Promise<ConnectorProfile[]>
  loadConfig(environment: NodeJS.ProcessEnv): ConnectorConfig
  loadConfigDocument(file: string): ConnectorConfigDocument
  loadProfile(name: string, options: ProfileLocationOptions): Promise<ConnectorProfile>
  prepareSetup(options: SetupOptions): Promise<SetupReport>
  migrationCatalog(): MigrationCatalogReport
  migrationPlan(sourceId: string): Promise<MigrationPlanReport>
  pathExists(file: string): boolean
  reviewActivity(
    activityFile: string,
    limit: number,
  ): Promise<DiscordActivityReviewReport>
  applyRecipe(options: ConfigRecipeApplyOptions): Promise<ConfigRecipeApplyReport>
  planRecipe(options: ConfigRecipePlanOptions): ConfigRecipePlanReport
  planConfigChange(options: ConfigChangePlanOptions): ConfigChangePlanReport
  planHostFile(
    plan: HostActivationPlan,
    adapterId: HostAdapterId,
    file: string,
  ): HostChangePlanReport
  resolveCoordination(
    activityFile: string,
    claimId: string,
    confirmation: string,
  ): Promise<WriteCoordinationResolution>
  restoreProfile(name: string, options: ProfileLocationOptions): Promise<TrashedProfile>
  serve(options: {
    exitOnShutdown: boolean
    config: ConnectorConfig
    environment: NodeJS.ProcessEnv
    stderr: Pick<NodeJS.WriteStream, "write">
  }): unknown
  smoke(options: SmokeOptions): Promise<SmokeReport>
  showConfig(file: string): ConfigShowReport
  trashProfile(name: string, options: ProfileLocationOptions): Promise<TrashedProfile>
  validateConfig(file: string): ConfigValidationReport
}

export interface CliOptions {
  args?: readonly string[]
  dependencies?: CliDependencies
  entrypointPath?: string
  environment?: NodeJS.ProcessEnv
  executablePath?: string
  interaction?: CliInteraction
  nodeVersion?: string
  stderr?: Pick<NodeJS.WriteStream, "write">
  stdin?: Pick<NodeJS.ReadStream, "isTTY">
  stdout?: Pick<NodeJS.WriteStream, "write">
}

export interface CliErrorReport {
  error: {
    category: CliFailureCategory
    message: string
    recovery: OperatorRecovery
    retryAfterMs?: number
  }
  schemaVersion: number
  status: "error"
}

const DEFAULT_DEPENDENCIES: CliDependencies = {
  activateProfile,
  applyConfigChange,
  applyHostFile: applyHostAdapterFile,
  applyRecipe: applyConfigRecipe,
  catalog: runGuildControlCatalog,
  checkCatalog: checkDiscordCatalog,
  diagnose: diagnoseConnector,
  detectHosts,
  ensureConfigDirectory: ensureConnectorConfigDirectory,
  exportActivityHtml: exportDiscordActivityHtml,
  exportCatalogHtml: exportDiscordCatalogHtml,
  exportConfigWorkbenchHtml: exportDiscordConfigWorkbenchHtml,
  exportHostActivationHtml: exportDiscordHostActivationHtml,
  exportMigrationHtml: exportDiscordMigrationHtml,
  exportOnboardHtml,
  exportOnboardingHtml: exportDiscordOnboardingHtml,
  explainConfig: explainConnectorConfig,
  initializeConfig: initializeConnectorConfigFile,
  inspectHostFile: inspectHostAdapterFile,
  listCoordination: async (auditFile) => {
    return new FileWriteCoordinator(
      writeCoordinationDirectory(auditFile),
      new FileOperationStore(operationReceiptDirectory(auditFile)),
    ).list()
  },
  listProfiles,
  loadConfig: loadConnectorConfig,
  loadConfigDocument: loadConnectorConfigDocumentFile,
  loadProfile,
  migrationCatalog: createMigrationCatalog,
  migrationPlan: createMigrationPlan,
  pathExists: existsSync,
  prepareSetup,
  planConfigChange,
  planHostFile: planHostAdapterFile,
  planRecipe: planConfigRecipe,
  reviewActivity: reviewDiscordActivity,
  resolveCoordination: async (auditFile, claimId, confirmation) => {
    return new FileWriteCoordinator(
      writeCoordinationDirectory(auditFile),
      new FileOperationStore(operationReceiptDirectory(auditFile)),
    ).resolve(claimId, confirmation)
  },
  restoreProfile,
  serve: runGuildControlServer,
  smoke: smokeConnector,
  showConfig: showConnectorConfigFile,
  trashProfile,
  validateConfig: validateConnectorConfigFile,
}

function isCommand(value: string): value is CliCommand {
  return (CLI_COMMANDS as readonly string[]).includes(value)
}

function normalizeCliShortOptions(
  command: CliCommand,
  args: readonly string[],
): readonly string[] {
  const aliases = CLI_SHORT_OPTION_ALIASES[command]
  if (!aliases) return args
  const normalized: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) continue
    const option = aliases[argument] || argument
    normalized.push(option)
    if (CLI_OPTION_VALUE_NAMES.has(option) && index + 1 < args.length) {
      index += 1
      const value = args[index]
      if (value !== undefined) normalized.push(value)
    }
  }
  return normalized
}

function parseBooleanOptions(
  args: readonly string[],
  allowed: ReadonlySet<string>,
): ReadonlySet<string> {
  const present = new Set<string>()
  for (const argument of args) {
    if (!allowed.has(argument)) {
      throw new ConfigurationError(`Unknown option ${argument}`)
    }
    if (present.has(argument)) {
      throw new ConfigurationError(`Option ${argument} may be provided only once`)
    }
    present.add(argument)
  }
  return present
}

function parseSetupOptions(args: readonly string[]): Extract<ParsedCliArguments, { command: "setup" }> {
  const channelIds: string[] = []
  let configFile: string | undefined
  let credentialFile: string | undefined
  let credentialVariable: string | undefined
  const guildIds: string[] = []
  let json = false
  let launcherCommand: string | undefined
  let overwrite = false
  let packageLaunch = false
  let presetName: string | undefined
  let profileName: string | undefined
  let serverName: string | undefined
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument?.startsWith("--")) {
      throw new ConfigurationError(`Unexpected setup argument ${argument || ""}`)
    }
    const repeatable = argument === "--channel-id" || argument === "--guild-id"
    if (!repeatable && seen.has(argument)) {
      throw new ConfigurationError(`Option ${argument} may be provided only once`)
    }
    if (!repeatable) seen.add(argument)
    if (argument === "--json") {
      json = true
      continue
    }
    if (argument === "--force") {
      overwrite = true
      continue
    }
    if (argument === "--npx") {
      packageLaunch = true
      continue
    }
    if (![
      "--channel-id",
      "--command",
      "--config",
      "--guild-id",
      "--name",
      "--npx",
      "--preset",
      "--profile",
      "--token-file",
      "--token-env",
    ].includes(argument)) {
      throw new ConfigurationError(`Unknown option ${argument}`)
    }
    const value = args[index + 1]
    if (!value || value.startsWith("--")) {
      throw new ConfigurationError(`Option ${argument} requires a value`)
    }
    index += 1
    if (argument === "--channel-id") channelIds.push(value)
    if (argument === "--command") launcherCommand = value
    if (argument === "--config") configFile = value
    if (argument === "--guild-id") guildIds.push(value)
    if (argument === "--name") serverName = value
    if (argument === "--preset") presetName = value
    if (argument === "--profile") profileName = value
    if (argument === "--token-file") credentialFile = value
    if (argument === "--token-env") credentialVariable = value
  }
  if (configFile && profileName) {
    throw new ConfigurationError("Options --config and --profile are mutually exclusive")
  }
  if (!configFile && !profileName) {
    throw new ConfigurationError("Setup requires --config FILE or --profile NAME")
  }
  if (credentialFile !== undefined && credentialVariable !== undefined) {
    throw new ConfigurationError("Options --token-file and --token-env are mutually exclusive")
  }
  if (packageLaunch && launcherCommand !== undefined) {
    throw new ConfigurationError("Options --npx and --command are mutually exclusive")
  }
  if (!presetName && (
    credentialFile !== undefined
    || credentialVariable !== undefined
    || overwrite
  )) {
    throw new ConfigurationError("--token-env, --token-file, and --force require --preset")
  }
  if (!presetName && (guildIds.length > 0 || channelIds.length > 0)) {
    throw new ConfigurationError("--guild-id and --channel-id require --preset")
  }
  if (presetName && guildIds.length === 0) {
    throw new ConfigurationError("--preset requires at least one --guild-id")
  }
  const preset = presetName ? getSetupPreset(presetName) : undefined
  if (
    preset?.requirements.channelIds === "required"
    && channelIds.length === 0
  ) {
    throw new ConfigurationError(
      `Setup preset ${preset.name} requires at least one --channel-id`,
    )
  }
  return {
    command: "setup",
    ...(configFile ? { configFile } : {}),
    ...(credentialFile ? { credentialFile } : {}),
    ...(credentialVariable ? { credentialVariable } : {}),
    json,
    launcherCommand,
    overwrite,
    ...(packageLaunch ? { packageLaunch: true as const } : {}),
    ...(preset
      ? {
          preset: {
            channelIds,
            guildIds,
            name: preset.name,
          },
        }
      : {}),
    ...(profileName ? { profileName } : {}),
    serverName,
  }
}

function parseOnboardOptions(
  args: readonly string[],
): Extract<ParsedCliArguments, { command: "onboard" }> {
  let applicationId: string | undefined
  let configFile: string | undefined
  let confirmation: string | undefined
  let credentialFile: string | undefined
  let credentialVariable: string | undefined
  let detectHost = false
  let guildId: string | undefined
  let hostId: OnboardHostId | undefined
  let htmlFile: string | undefined
  let json = false
  let open = false
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument?.startsWith("--")) {
      throw new ConfigurationError(`Unexpected onboard argument ${argument || ""}`)
    }
    if (seen.has(argument)) {
      throw new ConfigurationError(`Option ${argument} may be provided only once`)
    }
    seen.add(argument)
    if (argument === "--json") {
      json = true
      continue
    }
    if (argument === "--detect-host") {
      detectHost = true
      continue
    }
    if (argument === "--open") {
      open = true
      continue
    }
    if (![
      "--application-id",
      "--config",
      "--confirm-installed",
      "--guild-id",
      "--host",
      "--html",
      "--token-env",
      "--token-file",
    ].includes(argument)) {
      throw new ConfigurationError(`Unknown option ${argument}`)
    }
    const value = args[index + 1]
    if (!value || value.startsWith("--")) {
      throw new ConfigurationError(`Option ${argument} requires a value`)
    }
    index += 1
    if (argument === "--application-id") applicationId = value
    if (argument === "--config") configFile = value
    if (argument === "--confirm-installed") confirmation = value
    if (argument === "--guild-id") guildId = value
    if (argument === "--host") {
      if (!isOnboardHostId(value)) {
        throw new ConfigurationError(
          `Option --host must be one of ${ONBOARD_HOST_IDS.join(", ")}`,
        )
      }
      hostId = value
    }
    if (argument === "--html") htmlFile = value
    if (argument === "--token-env") credentialVariable = value
    if (argument === "--token-file") credentialFile = value
  }
  if (credentialFile !== undefined && credentialVariable !== undefined) {
    throw new ConfigurationError("Options --token-file and --token-env are mutually exclusive")
  }
  if (json && open) {
    throw new ConfigurationError("Onboarding options --json and --open are mutually exclusive")
  }
  return {
    ...(applicationId ? { applicationId } : {}),
    command: "onboard",
    ...(configFile ? { configFile } : {}),
    ...(confirmation ? { confirmation } : {}),
    ...(credentialFile ? { credentialFile } : {}),
    ...(credentialVariable ? { credentialVariable } : {}),
    detectHost,
    ...(guildId ? { guildId } : {}),
    ...(hostId ? { hostId } : {}),
    ...(htmlFile ? { htmlFile } : {}),
    json,
    open,
  }
}

function parseHostOptions(args: readonly string[]): Extract<ParsedCliArguments, { command: "host" }> {
  const explicitAction = args[0]
  const action = explicitAction && isCliCommandAction("host", explicitAction)
    ? explicitAction
    : "generate"
  const options = action === explicitAction ? args.slice(1) : args
  if (action === "detect") {
    const present = parseBooleanOptions(options, new Set(["--json"]))
    return {
      action,
      command: "host",
      json: present.has("--json"),
    }
  }
  let adapterId: HostAdapterId | undefined
  let configFile: string | undefined
  let confirmation: string | undefined
  let htmlFile: string | undefined
  let hostFile: string | undefined
  let inspectHostFile: string | undefined
  let json = false
  let launcherCommand: string | undefined
  let packageLaunch = false
  let planDigest: string | undefined
  let profileName: string | undefined
  let serverName: string | undefined
  const seen = new Set<string>()
  for (let index = 0; index < options.length; index += 1) {
    const argument = options[index]
    if (!argument?.startsWith("--")) {
      throw new ConfigurationError(`Unexpected host argument ${argument || ""}`)
    }
    if (seen.has(argument)) {
      throw new ConfigurationError(`Option ${argument} may be provided only once`)
    }
    seen.add(argument)
    if (argument === "--json") {
      json = true
      continue
    }
    if (argument === "--npx") {
      packageLaunch = true
      continue
    }
    if (![
      "--adapter",
      "--command",
      "--config",
      "--confirm",
      "--html",
      "--host-file",
      "--inspect-host-file",
      "--name",
      "--plan-digest",
      "--profile",
    ].includes(argument)) {
      throw new ConfigurationError(`Unknown option ${argument}`)
    }
    const value = options[index + 1]
    if (!value || value.startsWith("--")) {
      throw new ConfigurationError(`Option ${argument} requires a value`)
    }
    index += 1
    if (argument === "--adapter") {
      if (!isHostAdapterId(value)) {
        throw new ConfigurationError(`Option --adapter must be one of ${HOST_ADAPTER_IDS.join(", ")}`)
      }
      adapterId = value
    }
    if (argument === "--command") launcherCommand = value
    if (argument === "--config") configFile = value
    if (argument === "--confirm") confirmation = value
    if (argument === "--html") htmlFile = value
    if (argument === "--host-file") hostFile = value
    if (argument === "--inspect-host-file") inspectHostFile = value
    if (argument === "--name") serverName = value
    if (argument === "--plan-digest") planDigest = value
    if (argument === "--profile") profileName = value
  }
  if (configFile && profileName) {
    throw new ConfigurationError("Options --config and --profile are mutually exclusive")
  }
  if (!configFile && !profileName) {
    throw new ConfigurationError("Host activation requires --config FILE or --profile NAME")
  }
  if (packageLaunch && launcherCommand !== undefined) {
    throw new ConfigurationError("Options --npx and --command are mutually exclusive")
  }
  if (inspectHostFile && !adapterId) {
    throw new ConfigurationError("Option --inspect-host-file requires --adapter")
  }
  if (action === "generate") {
    if (hostFile || confirmation || planDigest) {
      throw new ConfigurationError(
        "Host generation does not accept --host-file, --confirm, or --plan-digest",
      )
    }
    return {
      action,
      ...(adapterId ? { adapterId } : {}),
      command: "host",
      ...(configFile ? { configFile } : {}),
      ...(htmlFile ? { htmlFile } : {}),
      ...(inspectHostFile ? { inspectHostFile } : {}),
      json,
      launcherCommand,
      ...(packageLaunch ? { packageLaunch: true as const } : {}),
      ...(profileName ? { profileName } : {}),
      serverName,
    }
  }
  if (htmlFile || inspectHostFile) {
    throw new ConfigurationError(
      `Host ${action} does not accept --html or --inspect-host-file`,
    )
  }
  if (!adapterId) {
    throw new ConfigurationError(`Host ${action} requires --adapter`)
  }
  if (!hostFile) {
    throw new ConfigurationError(`Host ${action} requires --host-file`)
  }
  if (action === "plan") {
    if (confirmation || planDigest) {
      throw new ConfigurationError("Host plan does not accept --confirm or --plan-digest")
    }
    return {
      action,
      adapterId,
      command: "host",
      ...(configFile ? { configFile } : {}),
      hostFile,
      json,
      launcherCommand,
      ...(packageLaunch ? { packageLaunch: true as const } : {}),
      ...(profileName ? { profileName } : {}),
      serverName,
    }
  }
  if (!planDigest) {
    throw new ConfigurationError("Host apply requires --plan-digest")
  }
  if (!confirmation) {
    throw new ConfigurationError("Host apply requires --confirm")
  }
  return {
    action,
    adapterId,
    command: "host",
    ...(configFile ? { configFile } : {}),
    confirmation,
    hostFile,
    json,
    launcherCommand,
    ...(packageLaunch ? { packageLaunch: true as const } : {}),
    planDigest,
    ...(profileName ? { profileName } : {}),
    serverName,
  }
}

function parseMigrationCommand(
  args: readonly string[],
): Extract<ParsedCliArguments, { command: "migrate" }> {
  const action = args[0]
  if (!action || !isCliCommandAction("migrate", action)) {
    throw new ConfigurationError("migrate requires list or plan")
  }
  if (action === "list") {
    const options = parseBooleanOptions(args.slice(1), new Set(["--json"]))
    return {
      action,
      command: "migrate",
      json: options.has("--json"),
    }
  }
  const source = args[1]
  if (!source || source.startsWith("--")) {
    throw new ConfigurationError("migrate plan requires an exact source ID")
  }
  const sourceId = normalizeMigrationSourceId(source)
  let htmlFile: string | undefined
  let json = false
  const seen = new Set<string>()
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument || !["--html", "--json"].includes(argument)) {
      throw new ConfigurationError(`Unknown option ${argument || ""}`)
    }
    if (seen.has(argument)) {
      throw new ConfigurationError(`Option ${argument} may be provided only once`)
    }
    seen.add(argument)
    if (argument === "--json") {
      json = true
      continue
    }
    const value = args[index + 1]
    if (!value || value.startsWith("--")) {
      throw new ConfigurationError("Option --html requires a file path")
    }
    htmlFile = value
    index += 1
  }
  return {
    action: "plan",
    command: "migrate",
    ...(htmlFile ? { htmlFile } : {}),
    json,
    sourceId,
  }
}

function parseConfigCommand(
  args: readonly string[],
): Extract<ParsedCliArguments, { command: "config" }> {
  const action = args[0]
  if (!action || !isCliCommandAction("config", action)) {
    throw new ConfigurationError(
      "config requires apply, explain, init, plan, replace, show, validate, or workbench",
    )
  }
  if (action === "plan" || action === "replace" || action === "apply") {
    const file = args[1]
    const candidateFile = args[2]
    if (!file || file.startsWith("--")) {
      throw new ConfigurationError(`config ${action} requires an active file path`)
    }
    if (!candidateFile || candidateFile.startsWith("--")) {
      throw new ConfigurationError(`config ${action} requires a candidate file path`)
    }
    if (action === "plan") {
      const options = parseBooleanOptions(args.slice(3), new Set(["--json"]))
      return {
        action,
        candidateFile,
        command: "config",
        file,
        json: options.has("--json"),
      }
    }
    if (action === "replace") {
      let acceptCurrentPlan = false
      let confirmation: string | undefined
      let json = false
      const seen = new Set<string>()
      for (let index = 3; index < args.length; index += 1) {
        const argument = args[index]
        if (
          !argument
          || !["--accept-current-plan", "--confirm", "--json"].includes(argument)
        ) {
          throw new ConfigurationError(`Unknown option ${argument || ""}`)
        }
        if (seen.has(argument)) {
          throw new ConfigurationError(`Option ${argument} may be provided only once`)
        }
        seen.add(argument)
        if (argument === "--accept-current-plan") {
          acceptCurrentPlan = true
          continue
        }
        if (argument === "--json") {
          json = true
          continue
        }
        const value = args[index + 1]
        if (!value || value.startsWith("--")) {
          throw new ConfigurationError("Option --confirm requires a value")
        }
        confirmation = value
        index += 1
      }
      if (acceptCurrentPlan !== (confirmation !== undefined)) {
        throw new ConfigurationError(
          "config replace requires --accept-current-plan and --confirm together",
        )
      }
      if (json && !acceptCurrentPlan) {
        throw new ConfigurationError(
          "config replace --json requires --accept-current-plan and --confirm",
        )
      }
      return {
        acceptCurrentPlan,
        action,
        candidateFile,
        command: "config",
        ...(confirmation === undefined ? {} : { confirmation }),
        file,
        json,
      }
    }
    let confirmation: string | undefined
    let json = false
    let planDigest: string | undefined
    const seen = new Set<string>()
    for (let index = 3; index < args.length; index += 1) {
      const argument = args[index]
      if (!argument || !["--confirm", "--json", "--plan-digest"].includes(argument)) {
        throw new ConfigurationError(`Unknown option ${argument || ""}`)
      }
      if (seen.has(argument)) {
        throw new ConfigurationError(`Option ${argument} may be provided only once`)
      }
      seen.add(argument)
      if (argument === "--json") {
        json = true
        continue
      }
      const value = args[index + 1]
      if (!value || value.startsWith("--")) {
        throw new ConfigurationError(`Option ${argument} requires a value`)
      }
      index += 1
      if (argument === "--confirm") confirmation = value
      if (argument === "--plan-digest") planDigest = value
    }
    if (!planDigest) {
      throw new ConfigurationError("config apply requires --plan-digest")
    }
    if (!confirmation) {
      throw new ConfigurationError("config apply requires --confirm")
    }
    return {
      action,
      candidateFile,
      command: "config",
      confirmation,
      file,
      json,
      planDigest,
    }
  }
  if (action === "explain") {
    const path = args[1]?.startsWith("--") ? undefined : args[1]
    const options = parseBooleanOptions(
      args.slice(path ? 2 : 1),
      new Set(["--json"]),
    )
    return {
      action,
      command: "config",
      json: options.has("--json"),
      ...(path ? { path } : {}),
    }
  }

  const file = args[1]
  if (!file || file.startsWith("--")) {
    throw new ConfigurationError(`config ${action} requires a file path`)
  }
  if (action === "workbench") {
    let htmlFile: string | undefined
    let json = false
    const seen = new Set<string>()
    for (let index = 2; index < args.length; index += 1) {
      const argument = args[index]
      if (!argument || !["--html", "--json"].includes(argument)) {
        throw new ConfigurationError(`Unknown option ${argument || ""}`)
      }
      if (seen.has(argument)) {
        throw new ConfigurationError(`Option ${argument} may be provided only once`)
      }
      seen.add(argument)
      if (argument === "--json") {
        json = true
        continue
      }
      const value = args[index + 1]
      if (!value || value.startsWith("--")) {
        throw new ConfigurationError("Option --html requires a value")
      }
      htmlFile = value
      index += 1
    }
    if (!htmlFile) {
      throw new ConfigurationError("config workbench requires --html")
    }
    return {
      action,
      command: "config",
      file,
      htmlFile,
      json,
    }
  }
  if (action === "show" || action === "validate") {
    const options = parseBooleanOptions(args.slice(2), new Set(["--json"]))
    return {
      action,
      command: "config",
      file,
      json: options.has("--json"),
    }
  }

  let applicationId: string | undefined
  let botId: string | undefined
  const channelIds: string[] = []
  let credentialFile: string | undefined
  let credentialVariable: string | undefined
  const guildIds: string[] = []
  let json = false
  let name: string | undefined
  let overwrite = false
  let preset: string | undefined
  const seen = new Set<string>()
  const allowed = new Set([
    "--application-id",
    "--bot-id",
    "--channel-id",
    "--guild-id",
    "--name",
    "--preset",
    "--token-env",
    "--token-file",
  ])
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument?.startsWith("--")) {
      throw new ConfigurationError(`Unexpected config ${action} argument ${argument || ""}`)
    }
    const repeatable = argument === "--channel-id" || argument === "--guild-id"
    if (!repeatable && seen.has(argument)) {
      throw new ConfigurationError(`Option ${argument} may be provided only once`)
    }
    if (!repeatable) seen.add(argument)
    if (argument === "--force") {
      overwrite = true
      continue
    }
    if (argument === "--json") {
      json = true
      continue
    }
    if (!allowed.has(argument)) {
      throw new ConfigurationError(`Unknown option ${argument}`)
    }
    const value = args[index + 1]
    if (!value || value.startsWith("--")) {
      throw new ConfigurationError(`Option ${argument} requires a value`)
    }
    index += 1
    if (argument === "--application-id") applicationId = value
    if (argument === "--bot-id") botId = value
    if (argument === "--channel-id") channelIds.push(value)
    if (argument === "--guild-id") guildIds.push(value)
    if (argument === "--name") name = value
    if (argument === "--preset") preset = value
    if (argument === "--token-file") credentialFile = value
    if (argument === "--token-env") credentialVariable = value
  }

  if (credentialFile !== undefined && credentialVariable !== undefined) {
    throw new ConfigurationError("Options --token-file and --token-env are mutually exclusive")
  }
  if (!applicationId || !botId || !name || guildIds.length === 0) {
    throw new ConfigurationError(
      "config init requires --name, --application-id, --bot-id, and at least one --guild-id",
    )
  }
  return {
    action: "init",
    applicationId,
    botId,
    channelIds,
    command: "config",
    ...(credentialFile ? { credentialFile } : {}),
    ...(credentialVariable ? { credentialVariable } : {}),
    file,
    guildIds,
    json,
    name,
    overwrite,
    ...(preset ? { preset } : {}),
  }
}

function parsePresetCommand(
  args: readonly string[],
): Extract<ParsedCliArguments, { command: "preset" }> {
  const action = args[0]
  if (!action || !isCliCommandAction("preset", action)) {
    throw new ConfigurationError("preset requires install, list, or show")
  }
  if (action === "list") {
    const options = parseBooleanOptions(args.slice(1), new Set(["--json"]))
    return { action, command: "preset", json: options.has("--json") }
  }
  const name = args[1]
  if (!name || name.startsWith("--")) {
    throw new ConfigurationError(`preset ${action} requires a preset name`)
  }
  if (action === "install") {
    let applicationId: string | undefined
    let guildId: string | undefined
    let htmlFile: string | undefined
    let json = false
    const seen = new Set<string>()
    for (let index = 2; index < args.length; index += 1) {
      const argument = args[index]
      if (!argument || !["--application-id", "--guild-id", "--html", "--json"].includes(argument)) {
        throw new ConfigurationError(`Unknown option ${argument || ""}`)
      }
      if (seen.has(argument)) {
        throw new ConfigurationError(`Option ${argument} may be provided only once`)
      }
      seen.add(argument)
      if (argument === "--json") {
        json = true
        continue
      }
      const value = args[index + 1]
      if (!value || value.startsWith("--")) {
        throw new ConfigurationError(`Option ${argument} requires a value`)
      }
      index += 1
      if (argument === "--application-id") applicationId = value
      if (argument === "--guild-id") guildId = value
      if (argument === "--html") htmlFile = value
    }
    if (!applicationId) {
      throw new ConfigurationError("preset install requires --application-id")
    }
    if (!guildId) {
      throw new ConfigurationError("preset install requires --guild-id")
    }
    const plan = createBotInstallPlan({ applicationId, guildId, preset: name })
    return {
      action: "install",
      applicationId: plan.applicationId,
      command: "preset",
      guildId: plan.guildId,
      ...(htmlFile ? { htmlFile } : {}),
      json,
      name: plan.preset.name,
    }
  }
  const options = parseBooleanOptions(args.slice(2), new Set(["--json"]))
  return {
    action: "show",
    command: "preset",
    json: options.has("--json"),
    name,
  }
}

function parseRecipeCommand(
  args: readonly string[],
): Extract<ParsedCliArguments, { command: "recipe" }> {
  const action = args[0]
  if (!action || !isCliCommandAction("recipe", action)) {
    throw new ConfigurationError("recipe requires apply, enable, list, plan, or show")
  }
  if (action === "list") {
    const options = parseBooleanOptions(args.slice(1), new Set(["--json"]))
    return { action, command: "recipe", json: options.has("--json") }
  }

  const name = args[1]
  if (!name || name.startsWith("--")) {
    throw new ConfigurationError(`recipe ${action} requires a recipe name`)
  }
  if (action === "show") {
    const options = parseBooleanOptions(args.slice(2), new Set(["--json"]))
    return {
      action,
      command: "recipe",
      json: options.has("--json"),
      name: getConfigRecipe(name).name,
    }
  }

  const file = args[2]
  if (!file || file.startsWith("--")) {
    throw new ConfigurationError(`recipe ${action} requires a file path`)
  }
  const channelIds: string[] = []
  let acceptCurrentPlan = false
  let confirmation: string | undefined
  const guildIds: string[] = []
  let json = false
  let planDigest: string | undefined
  const userIds: string[] = []
  const seen = new Set<string>()
  const allowed = new Set([
    "--channel-id",
    "--guild-id",
    "--json",
    "--user-id",
    ...(action === "apply" ? ["--confirm", "--plan-digest"] : []),
    ...(action === "enable" ? ["--accept-current-plan", "--confirm"] : []),
  ])
  for (let index = 3; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument || !allowed.has(argument)) {
      throw new ConfigurationError(`Unknown option ${argument || ""}`)
    }
    const repeatable = argument === "--channel-id"
      || argument === "--guild-id"
      || argument === "--user-id"
    if (!repeatable && seen.has(argument)) {
      throw new ConfigurationError(`Option ${argument} may be provided only once`)
    }
    if (!repeatable) seen.add(argument)
    if (argument === "--accept-current-plan") {
      acceptCurrentPlan = true
      continue
    }
    if (argument === "--json") {
      json = true
      continue
    }
    const value = args[index + 1]
    if (!value || value.startsWith("--")) {
      throw new ConfigurationError(`Option ${argument} requires a value`)
    }
    index += 1
    if (argument === "--channel-id") channelIds.push(value)
    if (argument === "--confirm") confirmation = value
    if (argument === "--guild-id") guildIds.push(value)
    if (argument === "--plan-digest") planDigest = value
    if (argument === "--user-id") userIds.push(value)
  }
  const request = normalizeConfigRecipeRequest({
    channelIds,
    guildIds,
    name,
    userIds,
  })
  const selection = {
    channelIds: request.scope.kind === "channel" ? [...request.scope.ids] : [],
    file,
    guildIds: request.scope.kind === "guild" ? [...request.scope.ids] : [],
    json,
    name: request.name,
    userIds: request.scope.kind === "user" ? [...request.scope.ids] : [],
  }
  if (action === "plan") {
    return { action, command: "recipe", ...selection }
  }
  if (action === "enable") {
    if (acceptCurrentPlan !== (confirmation !== undefined)) {
      throw new ConfigurationError(
        "recipe enable requires --accept-current-plan and --confirm together",
      )
    }
    if (json && !acceptCurrentPlan) {
      throw new ConfigurationError(
        "recipe enable --json requires --accept-current-plan and --confirm",
      )
    }
    return {
      acceptCurrentPlan,
      action,
      command: "recipe",
      ...(confirmation === undefined ? {} : { confirmation }),
      ...selection,
    }
  }
  if (planDigest === undefined) {
    throw new ConfigurationError("recipe apply requires --plan-digest DIGEST")
  }
  if (confirmation === undefined) {
    throw new ConfigurationError("recipe apply requires --confirm NAME")
  }
  return {
    action: "apply",
    command: "recipe",
    confirmation,
    planDigest,
    ...selection,
  }
}

function parseRuntimeSelectionOptions(
  args: readonly string[],
  booleanOptions: ReadonlySet<string>,
): { configFile?: string; present: ReadonlySet<string>; profileName?: string } {
  let configFile: string | undefined
  const present = new Set<string>()
  let profileName: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument?.startsWith("--")) {
      throw new ConfigurationError(`Unexpected argument ${argument || ""}`)
    }
    if (present.has(argument)) {
      throw new ConfigurationError(`Option ${argument} may be provided only once`)
    }
    present.add(argument)
    if (argument === "--config" || argument === "--profile") {
      const value = args[index + 1]
      if (!value || value.startsWith("--")) {
        throw new ConfigurationError(`Option ${argument} requires a value`)
      }
      if (argument === "--config") configFile = value
      if (argument === "--profile") profileName = value
      index += 1
      continue
    }
    if (!booleanOptions.has(argument)) {
      throw new ConfigurationError(`Unknown option ${argument}`)
    }
  }
  if (configFile && profileName) {
    throw new ConfigurationError("Options --config and --profile are mutually exclusive")
  }
  return {
    ...(configFile ? { configFile } : {}),
    present,
    ...(profileName ? { profileName } : {}),
  }
}

function parseProfileCommand(
  args: readonly string[],
): Extract<ParsedCliArguments, { command: "profile" }> {
  const action = args[0]
  if (!action || !isCliCommandAction("profile", action)) {
    throw new ConfigurationError("profile requires list, show, remove, or restore")
  }
  if (action === "list") {
    const options = parseBooleanOptions(args.slice(1), new Set(["--json"]))
    return { action, command: "profile", json: options.has("--json") }
  }
  const name = args[1]
  if (!name || name.startsWith("--")) {
    throw new ConfigurationError(`profile ${action} requires a profile name`)
  }
  if (action === "show") {
    const options = parseBooleanOptions(args.slice(2), new Set(["--json"]))
    return { action, command: "profile", json: options.has("--json"), name }
  }
  let confirmation: string | undefined
  let json = false
  const seen = new Set<string>()
  const options = args.slice(2)
  for (let index = 0; index < options.length; index += 1) {
    const argument = options[index]
    if (argument !== "--confirm" && argument !== "--json") {
      throw new ConfigurationError(`Unknown option ${argument || ""}`)
    }
    if (seen.has(argument)) {
      throw new ConfigurationError(`Option ${argument} may be provided only once`)
    }
    seen.add(argument)
    if (argument === "--json") {
      json = true
      continue
    }
    const value = options[index + 1]
    if (!value || value.startsWith("--")) {
      throw new ConfigurationError("Option --confirm requires a value")
    }
    confirmation = value
    index += 1
  }
  if (confirmation === undefined) {
    throw new ConfigurationError(`profile ${action} requires --confirm NAME`)
  }
  return {
    action: action as "remove" | "restore",
    command: "profile",
    confirmation,
    json,
    name,
  }
}

function parseActivityCommand(
  args: readonly string[],
): Extract<ParsedCliArguments, { command: "activity" }> {
  let configFile: string | undefined
  let htmlFile: string | undefined
  let json = false
  let limit: number = CONNECTOR_LIMITS.activityPageDefault
  let profileName: string | undefined
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (
      argument !== "--config"
      && argument !== "--html"
      && argument !== "--json"
      && argument !== "--limit"
      && argument !== "--profile"
    ) {
      throw new ConfigurationError(`Unknown option ${argument || ""}`)
    }
    if (seen.has(argument)) {
      throw new ConfigurationError(`Option ${argument} may be provided only once`)
    }
    seen.add(argument)
    if (argument === "--json") {
      json = true
      continue
    }
    const value = args[index + 1]
    if (!value || value.startsWith("--")) {
      throw new ConfigurationError(`Option ${argument} requires a value`)
    }
    if (argument === "--config") configFile = value
    if (argument === "--html") htmlFile = value
    if (argument === "--profile") profileName = value
    if (argument === "--limit") {
      if (!/^[1-9][0-9]*$/.test(value)) {
        throw new ConfigurationError(
          `Option --limit must be an integer between 1 and ${CONNECTOR_LIMITS.activityEntries}`,
        )
      }
      limit = Number(value)
      if (limit > CONNECTOR_LIMITS.activityEntries) {
        throw new ConfigurationError(
          `Option --limit must be an integer between 1 and ${CONNECTOR_LIMITS.activityEntries}`,
        )
      }
    }
    index += 1
  }
  if (configFile && profileName) {
    throw new ConfigurationError("Options --config and --profile are mutually exclusive")
  }
  return {
    command: "activity",
    ...(configFile ? { configFile } : {}),
    ...(htmlFile ? { htmlFile } : {}),
    json,
    limit,
    ...(profileName ? { profileName } : {}),
  }
}

function parseCoordinationCommand(
  args: readonly string[],
): Extract<ParsedCliArguments, { command: "coordination" }> {
  const action = args[0]
  if (!action || !isCliCommandAction("coordination", action)) {
    throw new ConfigurationError("coordination requires list or resolve")
  }
  if (action === "list") {
    const options = parseRuntimeSelectionOptions(args.slice(1), new Set(["--json"]))
    return {
      action,
      command: "coordination",
      ...(options.configFile ? { configFile: options.configFile } : {}),
      json: options.present.has("--json"),
      ...(options.profileName ? { profileName: options.profileName } : {}),
    }
  }
  const claimId = args[1]
  if (!claimId || claimId.startsWith("--")) {
    throw new ConfigurationError("coordination resolve requires a claim ID")
  }
  let confirmation: string | undefined
  let configFile: string | undefined
  let json = false
  let profileName: string | undefined
  const seen = new Set<string>()
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]
    if (
      argument !== "--config"
      && argument !== "--confirm"
      && argument !== "--json"
      && argument !== "--profile"
    ) {
      throw new ConfigurationError(`Unknown option ${argument || ""}`)
    }
    if (seen.has(argument)) {
      throw new ConfigurationError(`Option ${argument} may be provided only once`)
    }
    seen.add(argument)
    if (argument === "--json") {
      json = true
      continue
    }
    const value = args[index + 1]
    if (!value || value.startsWith("--")) {
      throw new ConfigurationError(`Option ${argument} requires a value`)
    }
    if (argument === "--config") configFile = value
    if (argument === "--confirm") confirmation = value
    if (argument === "--profile") profileName = value
    index += 1
  }
  if (configFile && profileName) {
    throw new ConfigurationError("Options --config and --profile are mutually exclusive")
  }
  if (confirmation === undefined) {
    throw new ConfigurationError(
      "coordination resolve requires --confirm CLAIM_ID",
    )
  }
  return {
    action: "resolve",
    claimId,
    command: "coordination",
    ...(configFile ? { configFile } : {}),
    confirmation,
    json,
    ...(profileName ? { profileName } : {}),
  }
}

export function parseCliArguments(args: readonly string[]): ParsedCliArguments {
  if (args.length === 0) return { command: "serve" }
  const command = args[0]
  if (isCliHelpFlag(command)) {
    const rest = args.slice(1)
    if (rest.length > 0) throw new ConfigurationError(`${command} does not accept arguments`)
    return { command: "help", topic: undefined }
  }
  if (command === "--version" || command === "-v") {
    const rest = args.slice(1)
    if (rest.length > 0) throw new ConfigurationError(`${command} does not accept arguments`)
    return { command: "version" }
  }
  if (!command || !isCommand(command)) {
    throw new ConfigurationError(`Unknown command ${command || ""}`)
  }
  const rest = normalizeCliShortOptions(command, args.slice(1))
  if (command === "help") {
    if (rest.length === 1 && isCliHelpFlag(rest[0])) {
      return { command: "help", topic: undefined }
    }
    const topic = rest[0]
    const action = rest[1]
    if (
      rest.length > 2
      || (topic !== undefined && !isCommand(topic))
      || (action !== undefined && (
        topic === undefined
        || !isCommand(topic)
        || !isCliCommandAction(topic, action)
      ))
    ) {
      throw new ConfigurationError(
        "help accepts at most one command and one optional known action",
      )
    }
    return {
      ...(action ? { action: action as CliCommandAction } : {}),
      command: "help",
      topic: topic as CliCommand | undefined,
    }
  }
  if (rest.some((argument) => isCliHelpFlag(argument))) {
    if (rest.length === 1 && isCliHelpFlag(rest[0])) {
      return { command: "help", topic: command }
    }
    if (
      rest.length === 2
      && rest[0] !== undefined
      && isCliCommandAction(command, rest[0])
      && isCliHelpFlag(rest[1])
    ) {
      return { action: rest[0], command: "help", topic: command }
    }
    throw new ConfigurationError(
      "--help or -h must be used alone or after one known action",
    )
  }
  if (command === "version") {
    if (rest.length > 0) throw new ConfigurationError(`${command} does not accept options`)
    return { command }
  }
  if (command === "serve") {
    const options = parseRuntimeSelectionOptions(rest, new Set())
    return {
      command,
      ...(options.configFile ? { configFile: options.configFile } : {}),
      ...(options.profileName ? { profileName: options.profileName } : {}),
    }
  }
  if (command === "doctor") {
    const normalized = rest.map((argument) => (
      argument === "-v" ? "--verbose" : argument
    ))
    const options = parseRuntimeSelectionOptions(
      normalized,
      new Set(["--json", "--online", "--verbose"]),
    )
    return {
      command,
      ...(options.configFile ? { configFile: options.configFile } : {}),
      json: options.present.has("--json"),
      online: options.present.has("--online"),
      ...(options.profileName ? { profileName: options.profileName } : {}),
      verbose: options.present.has("--verbose"),
    }
  }
  if (command === "activity") return parseActivityCommand(rest)
  if (command === "catalog") {
    let check = false
    let htmlFile: string | undefined
    let json = false
    const seen = new Set<string>()
    for (let index = 0; index < rest.length; index += 1) {
      const argument = rest[index]
      if (!argument || !["--check", "--html", "--json"].includes(argument)) {
        throw new ConfigurationError(`Unknown option ${argument || ""}`)
      }
      if (seen.has(argument)) {
        throw new ConfigurationError(`Option ${argument} may be provided only once`)
      }
      seen.add(argument)
      if (argument === "--check") check = true
      if (argument === "--json") json = true
      if (argument === "--html") {
        const value = rest[index + 1]
        if (!value || value.startsWith("--")) {
          throw new ConfigurationError("Option --html requires a file path")
        }
        htmlFile = value
        index += 1
      }
    }
    if (htmlFile && json) {
      throw new ConfigurationError("Catalog options --html and --json are mutually exclusive")
    }
    if (json && !check) {
      throw new ConfigurationError("catalog --json requires --check")
    }
    return { check, command, ...(htmlFile ? { htmlFile } : {}), json }
  }
  if (command === "config") return parseConfigCommand(rest)
  if (command === "coordination") return parseCoordinationCommand(rest)
  if (command === "host") return parseHostOptions(rest)
  if (command === "migrate") return parseMigrationCommand(rest)
  if (command === "onboard") return parseOnboardOptions(rest)
  if (command === "setup") return parseSetupOptions(rest)
  if (command === "preset") return parsePresetCommand(rest)
  if (command === "profile") return parseProfileCommand(rest)
  if (command === "recipe") return parseRecipeCommand(rest)
  const options = parseRuntimeSelectionOptions(rest, new Set(["--json"]))
  return {
    command: "smoke",
    ...(options.configFile ? { configFile: options.configFile } : {}),
    json: options.present.has("--json"),
    ...(options.profileName ? { profileName: options.profileName } : {}),
  }
}

interface CliActionHelpEntry {
  readonly description: string
  readonly synopsis: string
}

type CliActionHelpCatalog = {
  readonly [C in CliActionCommand]: Readonly<
    Record<CliActionForCommand<C>, CliActionHelpEntry>
  >
}

const CLI_ACTION_HELP: CliActionHelpCatalog = Object.freeze({
  config: Object.freeze({
    init: {
      description: "Create one strict schema-v2 non-secret policy at FILE. The parent must already be a canonical process-owned private directory. The command stores only a credential variable name or absolute protected-file reference, resolves no secret, contacts no network or Discord endpoint, and refuses replacement unless --force is explicit.",
      synopsis: "init FILE --name NAME --application-id ID --bot-id ID --guild-id ID... [--preset PRESET] [--channel-id ID...] [--token-env VARIABLE | --token-file FILE] [--force] [--json]",
    },
    validate: {
      description: "Validate one strict non-secret policy, including its complete cross-field authority and safety rules, without resolving credentials, contacting Discord, or changing the file. Exit status is 0 for a valid document and 2 for a usage or validation failure.",
      synopsis: "validate FILE [--json]",
    },
    show: {
      description: "Render one validated policy as a secret-free operator report without resolving a credential, contacting Discord, or changing the file. Add --json for the equivalent structured report.",
      synopsis: "show FILE [--json]",
    },
    explain: {
      description: "Explain the complete configuration contract or one exact dotted schema path without reading a policy, resolving a credential, contacting Discord, or changing state. Add --json for the equivalent structured report.",
      synopsis: "explain [PATH] [--json]",
    },
    workbench: {
      description: "Read one validated active policy and exclusively create a private standalone candidate editor at OUTPUT_FILE. The editor has no credential, network, Discord, active-file write, or approval authority and never replaces an existing output file.",
      synopsis: "workbench ACTIVE_FILE --html OUTPUT_FILE [--json]",
    },
    plan: {
      description: "Compare one active policy with one candidate, validate both complete documents, and return the exact changes plus a path-bound fresh digest without resolving credentials, contacting Discord, or changing either file.",
      synopsis: "plan ACTIVE_FILE CANDIDATE_FILE [--json]",
    },
    replace: {
      description: "Plan, display, confirm, recompute, and atomically replace one active policy in a single interactive command while preserving the detached plan and apply path. Non-interactive or JSON use requires both --accept-current-plan and the active-policy name; identity changes remain forbidden.",
      synopsis: "replace ACTIVE_FILE CANDIDATE_FILE [--accept-current-plan --confirm ACTIVE_NAME] [--json]",
    },
    apply: {
      description: "Recompute one policy-change plan, require its exact digest and active-policy name, preserve a recoverable backup, publish atomically, and verify the result. The pinned application and bot identities cannot change, and no credential or Discord endpoint is used.",
      synopsis: "apply ACTIVE_FILE CANDIDATE_FILE --plan-digest DIGEST --confirm ACTIVE_NAME [--json]",
    },
  }),
  coordination: Object.freeze({
    list: {
      description: "Inspect one selected policy's content-free durable reviewed-write claims without resolving credentials, contacting Discord, or changing activity or coordination state. Add --json for the equivalent structured report.",
      synopsis: "list [--config FILE | --profile NAME] [--json]",
    },
    resolve: {
      description: "Resolve one exact durable claim only after stopping its owner and independently inspecting Discord. Exact claim-ID confirmation is required; this local recovery action does not undo Discord state, prove the external outcome, or authorize a retry.",
      synopsis: "resolve CLAIM_ID --confirm CLAIM_ID [--config FILE | --profile NAME] [--json]",
    },
  }),
  host: Object.freeze({
    detect: {
      description: "Inspect only documented host-owned path metadata after this explicit request and report plausible MCP hosts. Detection reads no candidate file content or credential, initiates no network request, changes nothing, and selects a host only when exactly one candidate exists.",
      synopsis: "detect [--json]",
    },
    generate: {
      description: "Generate one credential-free local stdio activation plus verified client adapters from an explicit policy. Optional HTML exclusively creates a private guide. Generation resolves no credential, contacts no network or Discord endpoint, discovers no host, and changes no host file.",
      synopsis: "generate (--config FILE | --profile NAME) [--name NAME] [--npx | --command COMMAND] [--adapter ID [--inspect-host-file FILE]] [--html FILE] [--json]",
    },
    plan: {
      description: "Read one explicitly selected private static host JSON file and return a metadata-fresh path- and value-free change plan for one adapter. Planning resolves no credential, contacts no network, starts no process, and changes no file.",
      synopsis: "plan (--config FILE | --profile NAME) --adapter ID --host-file FILE [--name NAME] [--npx | --command COMMAND] [--json]",
    },
    apply: {
      description: "Recompute one host-file plan, require its exact digest and server-name confirmation, preserve unrelated records and a recoverable backup, publish atomically, and reread the owned projection. A successful file update does not prove that the host loaded or started it.",
      synopsis: "apply (--config FILE | --profile NAME) --adapter ID --host-file FILE [--name NAME] [--npx | --command COMMAND] --plan-digest DIGEST --confirm SERVER_NAME [--json]",
    },
  }),
  migrate: Object.freeze({
    list: {
      description: "List every immutable release-scored migration source and its evidence contract without reading configuration, credentials, environment values, source checkouts, host state, or any network.",
      synopsis: "list [--json]",
    },
    plan: {
      description: "Map one exact versioned competitor release into supported, review-required, and intentionally excluded outcomes. Planning changes nothing and reads no source checkout, configuration, host setting, credential, environment value, network, or Discord endpoint; optional HTML exclusively creates a private standalone guide.",
      synopsis: "plan SOURCE [--html FILE] [--json]",
    },
  }),
  preset: Object.freeze({
    list: {
      description: "List deterministic least-privilege read-only setup presets and their stable public contracts without a credential, Discord request, Gateway connection, telemetry export, or local write.",
      synopsis: "list [--json]",
    },
    show: {
      description: "Show one exact read-only preset's tools, risk classes, scope requirements, Discord permissions, privileged-intent guidance, and zero-write boundary without a credential or Discord access.",
      synopsis: "show NAME [--json]",
    },
    install: {
      description: "Generate one callback-free, exact-guild-locked Discord bot installation plan for a read-only preset. The command needs no bot token, makes no Discord request, opens no browser, and optionally creates a deterministic private standalone checklist without replacing an existing file.",
      synopsis: "install NAME --application-id ID --guild-id ID [--html FILE] [--json]",
    },
  }),
  profile: Object.freeze({
    list: {
      description: "List private managed profile metadata without resolving a credential, contacting Discord, or changing profile state. Secret values and Discord presentation data are never returned.",
      synopsis: "list [--json]",
    },
    show: {
      description: "Show one validated non-secret managed profile and its exact policy metadata without resolving a credential, contacting Discord, or changing profile state.",
      synopsis: "show NAME [--json]",
    },
    remove: {
      description: "Move one exact managed profile into recoverable private trash after exact name confirmation. This removes no external credential, revokes no Discord token, and contacts no network or Discord endpoint.",
      synopsis: "remove NAME --confirm NAME [--json]",
    },
    restore: {
      description: "Restore one exact recoverably removed managed profile after exact name confirmation. Restoration refuses conflicts, resolves no credential, and contacts no network or Discord endpoint.",
      synopsis: "restore NAME --confirm NAME [--json]",
    },
  }),
  recipe: Object.freeze({
    list: {
      description: "List immutable additive workflow recipes and their stable public contracts without reading a policy or credential, contacting Discord, or changing state.",
      synopsis: "list [--json]",
    },
    show: {
      description: "Show one recipe's exact capabilities, scopes, tools, Discord permissions, intents, risks, warnings, and outer-boundary requirements without reading a policy or credential or contacting Discord.",
      synopsis: "show NAME [--json]",
    },
    plan: {
      description: "Apply one recipe and its exact guild, channel, or user scope to a validated policy in memory and return the complete proposed document, changes, requirements, and fresh digest. Planning resolves no credential, contacts no Discord endpoint, and changes no file.",
      synopsis: "plan NAME FILE (--guild-id ID... | --channel-id ID... | --user-id ID...) [--json]",
    },
    enable: {
      description: "Plan, display, confirm, recompute, and atomically enable one additive recipe in a single interactive command. Non-interactive or JSON use requires both --accept-current-plan and the recipe name; exact scope, backup, and verification behavior remain unchanged.",
      synopsis: "enable NAME FILE (--guild-id ID... | --channel-id ID... | --user-id ID...) [--accept-current-plan --confirm NAME] [--json]",
    },
    apply: {
      description: "Recompute one additive recipe plan, require its exact digest and recipe-name confirmation, preserve a recoverable backup, publish atomically, and verify the policy. Application resolves no credential, contacts no Discord endpoint, and never grants Discord authority by itself.",
      synopsis: "apply NAME FILE (--guild-id ID... | --channel-id ID... | --user-id ID...) --plan-digest DIGEST --confirm NAME [--json]",
    },
  }),
})

function contextualHelpText(
  topic: CliCommand,
  action: CliCommandAction,
): string {
  if (!isCliActionCommand(topic) || !isCliCommandAction(topic, action)) {
    throw new ConfigurationError("Contextual help requires one known action")
  }
  const entries = CLI_ACTION_HELP[topic] as Partial<
    Record<CliCommandAction, CliActionHelpEntry>
  >
  const entry = entries[action]
  if (!entry) {
    throw new ConfigurationError("Contextual help is unavailable for this action")
  }
  return [
    `Usage: ${CONNECTOR_CLI_COMMAND} ${topic} ${entry.synopsis}`,
    "",
    entry.description,
  ].join("\n")
}

function shortOptionHelpText(
  topic: CliCommand | undefined,
  action?: CliCommandAction,
): string {
  if (topic === undefined) {
    return [
      "Short options:",
      "  -h  --help",
      "  -v  --version (or --verbose for doctor)",
      "  -c  --config (or --check for catalog)",
      "  -j  --json",
      "  -l  --limit (activity)",
      "  -o  --online (doctor)",
      "  -p  --profile",
    ].join("\n")
  }
  const aliases = topic === "host" && action === "detect"
    ? { "-j": "--json" }
    : CLI_SHORT_OPTION_ALIASES[topic]
  return [
    "Short options:",
    "  -h  --help",
    ...Object.entries(aliases || {}).map(([shortName, longName]) => (
      `  ${shortName}  ${longName}`
    )),
  ].join("\n")
}

function completeHelpText(
  topic: CliCommand | undefined,
  action?: CliCommandAction,
): string {
  return `${helpText(topic, action)}\n\n${shortOptionHelpText(topic, action)}`
}

function helpText(
  topic: CliCommand | undefined,
  action?: CliCommandAction,
): string {
  if (topic !== undefined && action !== undefined) {
    return contextualHelpText(topic, action)
  }
  if (topic === "activity") {
    return `Usage: ${CONNECTOR_CLI_COMMAND} activity [--config FILE | --profile NAME] [--limit N] [--html FILE] [--json]\n\nReview bounded recent content-free write lifecycles together with durable coordination claims. The command resolves no credential, contacts no network or Discord endpoint, changes no activity or coordination state, and omits the local activity-file path. Optional HTML exclusively creates the requested private output file from the exact digest-bound report. Exit status is 0 when clear, 1 when evidence needs attention, and 2 on command failure.`
  }
  if (topic === "catalog") {
    return `Usage: ${CONNECTOR_CLI_COMMAND} catalog [--check] [--json] [--html FILE]\n\nAdvertise the exact production MCP catalog without credentials or execution. Add --check to verify and fingerprint the packaged contract; --json emits deterministic evidence and requires --check. Add --html FILE to perform the same check and exclusively write a standalone interactive contract explorer without replacing an existing file.`
  }
  if (topic === "config") {
    return [
      `Usage: ${CONNECTOR_CLI_COMMAND} config <action> [options]`,
      "",
      "Actions:",
      "  init FILE --name NAME --application-id ID --bot-id ID --guild-id ID... [--preset PRESET] [--channel-id ID...] [--token-env VARIABLE | --token-file FILE] [--force] [--json]",
      "  validate FILE [--json]",
      "  show FILE [--json]",
      "  explain [PATH] [--json]",
      "  workbench ACTIVE_FILE --html OUTPUT_FILE [--json]",
      "  plan ACTIVE_FILE CANDIDATE_FILE [--json]",
      "  replace ACTIVE_FILE CANDIDATE_FILE [--accept-current-plan --confirm ACTIVE_NAME] [--json]",
      "  apply ACTIVE_FILE CANDIDATE_FILE --plan-digest DIGEST --confirm ACTIVE_NAME [--json]",
      "",
      "Normal operation uses one strict non-secret configuration file plus only the environment or file secrets it references. The private offline workbench writes only a standalone candidate editor; it cannot resolve secrets, contact Discord, or replace the active policy. Replace is the interactive plan-review-apply path; detached plan and apply remain available for automation and independent review. Every write fresh-checks both files, preserves a recoverable backup, and cannot change the pinned Discord identity.",
    ].join("\n")
  }
  if (topic === "doctor") {
    return `Usage: ${CONNECTOR_CLI_COMMAND} doctor (--config FILE | --profile NAME) [--online] [-v | --verbose] [--json]\n\nValidate the selected configuration and policy even when its referenced bot credential is unavailable. Credential availability is reported as its own check instead of aborting offline diagnostics. Add --online to verify Discord identity and scoped guild access; Discord is not contacted when the credential is unavailable. Default human output shows totals plus only actionable warnings and failures; -v or --verbose shows every check, while --json always emits the complete report. Pass --config for normal operation; the non-secret GUILDCONTROL_CONFIG_FILE selector is available for hosts that cannot supply arguments. Every warning or failure includes a next action and documentation reference. Exit status is 0 for clean, 1 for warnings, and 2 for failures.`
  }
  if (topic === "host") {
    return [
      `Usage: ${CONNECTOR_CLI_COMMAND} host detect [--json]`,
      `       ${CONNECTOR_CLI_COMMAND} host [generate] (--config FILE | --profile NAME) [--name NAME] [--npx | --command COMMAND] [--adapter ID [--inspect-host-file FILE]] [--html FILE] [--json]`,
      `       ${CONNECTOR_CLI_COMMAND} host plan (--config FILE | --profile NAME) --adapter ID --host-file FILE [--name NAME] [--npx | --command COMMAND] [--json]`,
      `       ${CONNECTOR_CLI_COMMAND} host apply (--config FILE | --profile NAME) --adapter ID --host-file FILE [--name NAME] [--npx | --command COMMAND] --plan-digest DIGEST --confirm SERVER_NAME [--json]`,
      "",
      "host detect is opt-in and checks only documented path existence and type. It reads no candidate configuration content or credential, initiates no network request, and changes nothing. One candidate can be selected by onboard --detect-host; zero or multiple candidates require an explicit host choice. Marker existence remains only a hint, and JSON contains private local paths.",
      "",
      `Generate creates one exact credential-free local stdio activation plus verified adapters for ${HOST_ADAPTER_IDS.join(", ")}. The default launcher uses this installed entrypoint; --npx selects the exact published package version and --command selects an installed executable. --adapter appends one adapter's exact configuration and guidance to human output; JSON output always includes the complete adapter catalog.`,
      "",
      "--inspect-host-file safely reads one explicitly selected bounded private JSON file for a JSON adapter, compares only that adapter's owned projection, returns fixed path- and value-free drift evidence, and never edits the file. Optional HTML exclusively creates a mode-0600 interactive guide. Generation and inspection contact no network or Discord endpoint, start no process, discover no host, and change no policy or host configuration.",
      "",
      "host plan reads only the explicit static JSON target for a JSON adapter and returns a metadata-fresh plan without returning its path, values, unrelated state, or a stable hash of private bytes. host apply requires the same activation and adapter, exact plan digest, and exact server-name confirmation. It preserves unrelated shared JSON records, rejects ambiguous structures, keeps an owner-mode recovery backup for replacements, publishes atomically, rereads exactly, and rolls back on failed verification. TOML adapters remain reviewable manual projections. These commands do not discover paths, create directories, resolve credentials, contact Discord or another network endpoint, start a process, or change connector policy. A successful file change still does not prove the host loaded the file or can start the connector.",
      "",
      "Exit status is 0 on generation, exact inspection, a ready plan, or successful apply; 1 on inspection drift; and 2 on command failure.",
    ].join("\n")
  }
  if (topic === "migrate") {
    return [
      `Usage: ${CONNECTOR_CLI_COMMAND} migrate <action> [options]`,
      "",
      "Actions:",
      "  list [--json]",
      "  plan SOURCE [--html FILE] [--json]",
      "",
      "Generate a release-exact, complete outcome map from one scored GuildControl MCP source release into this connector's strict presets, recipes, tools, and reviewed lifecycles. SOURCE must be a versioned ID shown by migrate list. Planning reads no source checkout, configuration, host setting, credential, environment value, network, or Discord endpoint and changes nothing. It does not rewrite prompts, arguments, configuration, credentials, or host settings. Optional HTML exclusively creates a mode-0600 standalone interactive guide without replacing an existing file.",
    ].join("\n")
  }
  if (topic === "onboard") {
    return [
      `Usage: ${CONNECTOR_CLI_COMMAND} onboard [options]`,
      "",
      "Guided setup:",
      `  ${CONNECTOR_CLI_COMMAND} onboard`,
      "  Answer menus with a number, host ID, or displayed name. Invalid interactive answers can be corrected without restarting, and credential sub-prompts accept :back to choose another source.",
      "",
      "Automation:",
      `  ${CONNECTOR_CLI_COMMAND} onboard (--host HOST | --detect-host) --application-id ID --guild-id ID --config FILE --confirm-installed ID [--token-env VARIABLE | --token-file FILE] [--html FILE] [--json]`,
      "  Every required value is strict and invalid automation input fails immediately. --json never prompts or opens a browser.",
      "",
      "Options:",
      "  --host HOST             MCP host to activate first",
      "  --detect-host            Opt in to metadata-only host marker detection when --host is absent",
      "  --application-id ID     Discord application snowflake",
      "  --guild-id ID           Exact Discord guild snowflake",
      "  --config FILE           Private non-secret policy file",
      "  --confirm-installed ID  Exact guild ID after installation",
      "  --token-env VARIABLE    Existing protected environment variable",
      "  --token-file FILE       Existing protected token file when the host supports it",
      "  --html FILE             Private activation guide output",
      "  --open                  Authorize opening the install URL and activation guide",
      "  --json                  Emit deterministic JSON for automation",
      "",
      "Five verified stages:",
      "  1. Identify the host and exact local policy",
      "  2. Install or reverify the bounded read-only bot",
      "  3. Verify identity and installation, then create or revalidate one private policy",
      "  4. Smoke-test the real MCP stdio path without reading message content",
      "  5. Create a credential-free host activation handoff",
      "",
      `Supported hosts: ${ONBOARD_HOST_IDS.map((id) => `${onboardHostDescriptor(id).title} (${id})`).join(", ")}.`,
      "The default credential reference is DISCORD_BOT_TOKEN. An existing environment or protected-file source can be reused when the selected host supports that custody path. A one-time hidden prompt verifies setup but is cleared after smoke, so the selected host still needs its own protected credential entry. Detection is never implicit, reads no host configuration content, and chooses only one unambiguous candidate; an explicit --host always takes precedence. An interactive rerun with an exact existing onboarding policy derives its public IDs from that policy, skips repeated installation ceremony, revalidates it and the live bot without replacement, and chooses the next available default guide filename; drift fails closed. Automation remains fully explicit. GuildControl never writes a host configuration, stores a token value, requests Administrator, enables write tools, or reads Discord message content during onboarding.",
      "",
      "Exit status is 0 on a fully verified handoff and 2 on invalid input, exhausted interactive attempts, failed identity or installation verification, policy creation or revalidation failure, stdio failure, or guide export failure.",
    ].join("\n")
  }
  if (topic === "coordination") {
    return [
      `Usage: ${CONNECTOR_CLI_COMMAND} coordination <action> [options]`,
      "",
      "Actions:",
      "  list [--config FILE | --profile NAME] [--json]",
      "  resolve CLAIM_ID --confirm CLAIM_ID [--config FILE | --profile NAME] [--json]",
      "",
      "Inspect content-free reviewed-write claims for one selected policy without resolving credentials or contacting Discord. Stop the owning process and inspect Discord before resolving a claim that requires review.",
    ].join("\n")
  }
  if (topic === "setup") {
    return `Usage: ${CONNECTOR_CLI_COMMAND} setup (--config FILE | --profile NAME) [--preset PRESET --guild-id ID... [--channel-id ID...] [--token-env VARIABLE | --token-file FILE] [--force]] [--name NAME] [--npx | --command COMMAND] [--json]\n\nVerify one schema-v2 policy, optionally create it from an exact-scope read-only preset, and print a credential-free portable stdio launch descriptor. Add --npx for a stable exact-version package launch instead of the current executable and entrypoint. A configuration parent must already exist as a canonical process-owned private directory. Completed setup exits 0 even when it reports non-blocking warnings; a command, policy, credential, identity, installation, or Discord verification failure exits 2.`
  }
  if (topic === "smoke") {
    return `Usage: ${CONNECTOR_CLI_COMMAND} smoke (--config FILE | --profile NAME) [--json]\n\nLaunch this CLI's serve entrypoint as a child, negotiate stable MCP 2026-07-28 over stdio, validate tool, resource, and prompt contracts, and call only discovery plus read-only connector status. The child receives a safe process baseline and exact secret environment values named by the selected policy. Normal configured runtimes start and shut down with the child. Pass --config for normal operation; the non-secret GUILDCONTROL_CONFIG_FILE selector is available for hosts that cannot supply arguments.`
  }
  if (topic === "serve") {
    return `Usage: ${CONNECTOR_CLI_COMMAND} serve (--config FILE | --profile NAME)\n\nRun the local stdio MCP server. This is the default for a zero-argument non-interactive launch; a zero-argument interactive terminal starts guided onboarding instead. Pass --config for normal operation; the non-secret GUILDCONTROL_CONFIG_FILE selector is available for hosts that cannot supply arguments.`
  }
  if (topic === "profile") {
    return [
      `Usage: ${CONNECTOR_CLI_COMMAND} profile <action> [options]`,
      "",
      "Actions:",
      "  list [--json]",
      "  show NAME [--json]",
      "  remove NAME --confirm NAME [--json]",
      "  restore NAME --confirm NAME [--json]",
      "",
      "Inspect profiles without credentials or Discord access. Removal is recoverable and never revokes the external credential.",
    ].join("\n")
  }
  if (topic === "preset") {
    return [
      `Usage: ${CONNECTOR_CLI_COMMAND} preset <action> [options]`,
      "",
      "Actions:",
      "  list [--json]",
      "  show NAME [--json]",
      "  install NAME --application-id ID --guild-id ID [--html FILE] [--json]",
      "",
      "Inspect deterministic least-privilege setup presets or generate a callback-free, guild-locked bot installation plan without credentials or Discord access.",
    ].join("\n")
  }
  if (topic === "recipe") {
    return [
      `Usage: ${CONNECTOR_CLI_COMMAND} recipe <action> [options]`,
      "",
      "Actions:",
      "  list [--json]",
      "  show NAME [--json]",
      "  plan NAME FILE (--guild-id ID... | --channel-id ID... | --user-id ID...) [--json]",
      "  enable NAME FILE (--guild-id ID... | --channel-id ID... | --user-id ID...) [--accept-current-plan --confirm NAME] [--json]",
      "  apply NAME FILE (--guild-id ID... | --channel-id ID... | --user-id ID...) --plan-digest DIGEST --confirm NAME [--json]",
      "",
      "Review and add one bounded workflow to an existing strict policy. Enable is the interactive plan-review-apply path; detached plan and apply remain available for automation and independent review. Recipe commands do not resolve secrets or contact Discord, and every application recomputes the exact plan, rejects concurrent source changes, and preserves a recoverable backup.",
    ].join("\n")
  }
  if (topic === "version") return `Usage: ${CONNECTOR_CLI_COMMAND} version\n\nPrint the package version.`
  return [
    `Usage: ${CONNECTOR_CLI_COMMAND} <command> [options]`,
    `       ${CONNECTOR_CLI_COMMAND} ${STANDARD_RUNTIME_ARGUMENT} <command> [options]`,
    "",
    "A zero-argument interactive terminal starts onboarding; a zero-argument non-interactive launch starts the stdio server.",
    "The public launcher uses a memory-optimized Node profile by default. Add --standard-runtime to favor execution speed instead.",
    "",
    "Commands:",
    "  activity  Review content-free write outcomes and durable claims",
    "  catalog  Inspect or verify the credential-free, execution-disabled MCP contract",
    "  config   Create, validate, inspect, and review one non-secret policy file",
    "  coordination  Inspect or resolve one policy's durable reviewed-write claims",
    "  serve    Run the stdio MCP server with a selected policy (non-interactive default)",
    "  setup    Create or verify a policy and generate a portable launch descriptor",
    "  host     Project one verified policy into safe local MCP host adapters",
    "  migrate  Plan a release-exact switch from another Discord MCP",
    "  onboard  Install, verify, smoke-test, and activate the host-first golden path",
    "  preset   Inspect presets or generate an exact bot installation plan",
    "  profile  Inspect, recoverably remove, or restore non-secret profiles",
    "  recipe   Review and add a bounded workflow to an existing policy",
    "  doctor   Diagnose a selected policy and optional Discord access",
    "  smoke    Verify real stdio startup and the read-only MCP path",
    "  version  Print the package version",
    "  help     Show command help",
  ].join("\n")
}

function renderCatalog(report: DiscordCatalogCheckReport): string {
  const accessStages = Object.entries(report.accessStageCounts)
    .map(([stage, count]) => `${stage}=${count}`)
    .join(", ")
  const riskClasses = Object.entries(report.riskClassCounts)
    .map(([risk, count]) => `${risk}=${count}`)
    .join(", ")
  const restMethods = Object.entries(report.restMethodCounts)
    .map(([method, count]) => `${method}=${count}`)
    .join(", ")
  const authenticationClasses = Object.entries(
    report.toolAccessManifest.requirementCoverage.authenticationCounts,
  ).map(([name, count]) => `${name}=${count}`).join(", ")
  const permissionModes = Object.entries(
    report.toolAccessManifest.requirementCoverage.permissionModeCounts,
  ).map(([name, count]) => `${name}=${count}`).join(", ")
  const targetScopes = Object.entries(
    report.toolAccessManifest.requirementCoverage.targetScopeCounts,
  ).map(([name, count]) => `${name}=${count}`).join(", ")
  return [
    "GuildControl MCP catalog: ok",
    `Server: ${report.serverName}@${report.serverVersion}`,
    `Evidence format: ${report.evidenceFormat}`,
    `Contract digest: ${report.contractDigest}`,
    `Tool access resource digest: ${report.toolAccessResourceDigest}`,
    `Safety resource digest: ${report.safetyResourceDigest}`,
    `Plan review app HTML digest: ${report.planReviewApp.htmlDigest}`,
    `Plan review app resource digest: ${report.planReviewApp.resourceDigest}`,
    `Plan review app linkage: ${report.planReviewApp.linkedToolCount} model-visible plan tools`,
    "Plan review app authority: display-only, no external network, permissions, or server tools",
    `Tools: ${report.toolCount}`,
    `Toolsets: ${report.toolsetNames.length}`,
    `Access stages: ${accessStages}`,
    `Static requirement coverage: complete=${report.toolAccessManifest.requirementCoverage.complete}, unknown=${report.toolAccessManifest.requirementCoverage.unknownEntries}, target-access-proven=${report.toolAccessManifest.requirementCoverage.targetAccessProven}`,
    `Authentication classes: ${authenticationClasses}`,
    `Permission modes: ${permissionModes}`,
    `Target scopes: ${targetScopes}`,
    `Risk classes: ${riskClasses}`,
    `Prompts: ${report.promptCount}`,
    `Resources: ${report.resourceCount}`,
    `Resource templates: ${report.resourceTemplateCount}`,
    `Discord REST operations: ${report.restOperationCount} (${restMethods})`,
    `Execution guard: ${report.executionGuard}`,
    "Credentials required: no",
    "Discord execution: disabled",
    "Gateway: disabled",
    "Observability export: disabled",
    "Activity records created: no",
  ].join("\n")
}

function renderCatalogHtmlExport(report: DiscordCatalogHtmlExportReport): string {
  return [
    "GuildControl MCP catalog HTML: ok",
    `File: ${report.file}`,
    `Format: ${report.format}`,
    `Contract digest: ${report.contractDigest}`,
    `Tools: ${report.toolCount}`,
    `Bytes: ${report.bytes}`,
    "Credentials required: no",
    "Discord execution: disabled",
    "Activity records created: no",
  ].join("\n")
}

function renderActivityReview(report: DiscordActivityReviewReport): string {
  const lines = [
    `GuildControl MCP activity review: ${report.outcome}`,
    `Report digest: ${report.reportDigest}`,
    `Recent records: ${report.summary.records} (limit ${report.limit})`,
    `Current activities: ${report.summary.currentActivities}`,
    `Activities needing attention: ${report.summary.attentionActivities}`,
    `Durable claims: ${report.claims.length} (${report.summary.reviewRequiredClaims} review required, ${report.summary.unmatchedClaims} without recent activity)`,
    `Skipped recent lines: ${report.skippedLines}`,
    `Snapshot consistency: ${report.snapshotConsistency}`,
    "Credentials read: no",
    "Discord contacted: no",
    "Activity/coordination state changed: no",
    "Activity-file path exposed: no",
  ]
  if (report.records.length === 0) {
    lines.push("", "No content-free write activity exists in this recent window.")
  } else {
    lines.push("", "Recent activity lifecycles (newest first):")
    for (const record of report.records) {
      lines.push(
        `${record.current ? "CURRENT" : "HISTORY"} ${record.entry.timestamp} ${record.entry.kind}/${record.entry.status} [${record.disposition}]`,
        `  Activity: ${record.entry.id}`,
        `  Claims: ${record.claimIds.length > 0 ? record.claimIds.join(", ") : "none in recent correlation"}`,
        `  Next: ${record.guidance}`,
        `  Evidence: ${JSON.stringify(record.entry)}`,
      )
    }
  }
  if (report.claims.length === 0) {
    lines.push("", "Durable claims: none")
  } else {
    lines.push("", "Durable claims:")
    for (const claim of report.claims) {
      lines.push(
        `${claim.state.toUpperCase()} ${claim.claimId} ${claim.kind}`,
        `  Owner: ${claim.ownerState} / PID ${claim.ownerPid}`,
        `  Receipt: ${claim.receiptState}`,
        `  Targets: ${JSON.stringify(claim.targets)}`,
        `  Recent activity correlation: ${report.unmatchedClaimIds.includes(claim.claimId) ? "none in bounded window" : "matched by operation-key hash and plan digest"}`,
        `  Next: ${claim.state === "review-required" ? "Stop the owner, inspect exact Discord state and audit log, then use coordination resolve with exact confirmation" : claim.state === "active" ? "Do not interfere with or retry the active operation" : "A later writer may reclaim only through existing safe receipt evidence"}`,
      )
    }
  }
  if (report.skippedLines > 0) {
    lines.push(
      "",
      "WARNING: Recent non-empty journal lines failed the strict content-free schema. Treat this review as incomplete.",
    )
  }
  return lines.join("\n")
}

function renderActivityHtmlExport(
  report: DiscordActivityHtmlExportReport,
): string {
  return [
    "GuildControl MCP activity HTML: ok",
    `File: ${report.file}`,
    `Format: ${report.format}`,
    `Review digest: ${report.reportDigest}`,
    `HTML digest: ${report.htmlDigest}`,
    `Bytes: ${report.bytes}`,
    "Output file created: yes",
    "Credentials embedded: no",
    "Automatic network: disabled",
    "Browser opened: no",
    "Activity state changed: no",
    "State persistence: disabled",
  ].join("\n")
}

function doctorCountLabel(
  count: number,
  singular: string,
  plural: string,
): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function renderDoctor(report: DoctorReport, verbose = false): string {
  const counts = {
    fail: report.checks.filter(({ status }) => status === "fail").length,
    pass: report.checks.filter(({ status }) => status === "pass").length,
    warn: report.checks.filter(({ status }) => status === "warn").length,
  }
  const outcome = report.status === "ok"
    ? "ready"
    : report.status === "warning"
      ? "ready with warnings"
      : "not ready"
  const lines = [
    `GuildControl MCP doctor: ${outcome}`,
    `Checks: ${doctorCountLabel(counts.pass, "pass", "passes")}, ${doctorCountLabel(counts.warn, "warning", "warnings")}, ${doctorCountLabel(counts.fail, "failure", "failures")}`,
  ]
  const visible = verbose
    ? report.checks
    : report.checks.filter(({ status }) => status !== "pass")
  if (visible.length === 0) lines.push("No warnings or failures")
  for (const entry of visible) {
    lines.push(`${entry.status.toUpperCase()} ${entry.id}: ${entry.summary}`)
    if (entry.action) lines.push(`  Next: ${entry.action}`)
    if (entry.reference) lines.push(`  See: ${entry.reference}`)
  }
  if (!verbose) {
    lines.push("Full evidence: rerun with --verbose or --json")
  }
  return lines.join("\n")
}

function cliErrorReport(
  message: string,
  guidance: CliFailureGuidance,
): CliErrorReport {
  return {
    error: {
      category: guidance.category,
      message,
      recovery: guidance.recovery,
      ...(guidance.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: guidance.retryAfterMs }),
    },
    schemaVersion: OPERATOR_REPORT_SCHEMA_VERSION,
    status: "error",
  }
}

function renderCliFailure(
  message: string,
  guidance: CliFailureGuidance,
): string {
  return [
    `${CONNECTOR_CLI_COMMAND}: ${message}`,
    `Next: ${guidance.recovery.action}`,
    `See: ${guidance.recovery.reference}`,
  ].join("\n")
}

function requestsJson(
  args: readonly string[],
  parsed: ParsedCliArguments | undefined,
): boolean {
  if (parsed) return "json" in parsed && parsed.json
  return args.includes("--json")
}

function failureExitCode(
  parsed: ParsedCliArguments | undefined,
): typeof CLI_EXIT_CODES.failure | typeof CLI_EXIT_CODES.warning {
  if (parsed?.command === "serve") return CLI_EXIT_CODES.warning
  if (parsed?.command === "catalog" && !parsed.check) return CLI_EXIT_CODES.warning
  return CLI_EXIT_CODES.failure
}

function renderCoordinationList(report: WriteCoordinationList): string {
  if (report.claims.length === 0) {
    return "No active Discord write coordination claims"
  }
  return report.claims.map((claim) => [
    `${claim.claimId}: ${claim.state}`,
    `  Operation: ${claim.kind}`,
    `  Owner: PID ${claim.ownerPid} (${claim.ownerState})`,
    `  Receipt: ${claim.receiptState}`,
    `  Created: ${claim.createdAt}`,
    `  Targets: ${JSON.stringify(claim.targets)}`,
  ].join("\n")).join("\n")
}

function renderCoordinationResolution(report: WriteCoordinationResolution): string {
  const result = report.status === "resolved"
    ? `Resolved Discord write claim ${report.claimId}`
    : `Discord write claim ${report.claimId} was already resolved`
  return [
    result,
    `Released targets: ${report.releasedTargetCount}`,
    "The immutable operation receipt and operation-key reservation were not removed.",
  ].join("\n")
}

function renderSetup(report: SetupReport): string {
  const lines = [
    "GuildControl MCP setup: ready",
    `Verified application ${report.applicationId} and bot ${report.botId}`,
    `Guild installations: ${report.configuredGuildCount} configured, ${report.installedGuildCount} installed, ${report.installedInScopeGuildCount} in scope, ${report.unexpectedGuildCount} unexpected`,
    `Tools: ${report.toolSurface} surface; ${report.toolsets.join(", ")}`,
  ]
  if (report.preset) {
    lines.push(
      `Preset: ${report.preset.name} (${report.preset.toolNames.length} read-only tools; Gateway disabled)`,
    )
  }
  if (report.profile) {
    lines.push(`Profile: ${report.profile.name}`)
  }
  if (report.configFile) {
    lines.push(`Configuration: ${report.configFile}`)
  }
  if (report.configBackupFile) {
    lines.push(`Previous configuration backup: ${report.configBackupFile}`)
  }
  if (report.profile || report.configFile) {
    lines.push(report.credential.provider === "environment"
      ? `Credential environment variable: ${report.credential.variable}`
      : `Credential file: ${report.credential.path}`)
  }
  if (report.warnings.length > 0) {
    lines.push(
      "",
      `Warnings (${report.warnings.length}):`,
      ...report.warnings.map((warning) => `- ${warning}`),
    )
  }
  lines.push(
    "",
    "Next:",
    "1. Add the launch descriptor below to the MCP host.",
    "2. Restart or reload the host, then confirm the Discord server is connected.",
    "3. Ask the host to list channels in the configured server for the first verified read.",
    "Optional assurance: run doctor --online or smoke with the same policy selection.",
    "",
    "Portable stdio launch descriptor:",
    "",
    JSON.stringify(report.launch, null, 2),
    "",
    "The descriptor names exact secret inputs but includes no secret value",
    "Translate the requirements into the MCP host's required-server, write-approval, elicitation, and timeout settings.",
  )
  return lines.join("\n")
}

function renderOnboard(
  report: OnboardReport,
  guide: OnboardHtmlExportReport,
  browser: { guideOpened: boolean; installOpened: boolean },
  hostDetection?: HostDetectionReport,
): string {
  return [
    "GuildControl onboarding: ready",
    `Host: ${report.host.title}`,
    ...(hostDetection
      ? [
          hostDetection.selection.automatic
            ? "Host selection: metadata-only detection of one candidate"
            : `Host selection: interactive choice after metadata-only detection (${hostDetection.selection.reason})`,
          "Host configuration content read during detection: no",
        ]
      : ["Host selection: explicit operator choice"]),
    `Verified application: ${report.setup.applicationId}`,
    `Verified bot: ${report.setup.botId}`,
    `Exact guild: ${report.install.guildId}`,
    `Policy: ${report.configFile} (${report.policyDisposition})`,
    `MCP smoke test: ${report.smoke.transport} passed with ${report.smoke.toolCount} tools`,
    `Private activation guide: ${guide.file}`,
    `Install page opened: ${browser.installOpened ? "yes" : "no"}`,
    `Activation guide opened: ${browser.guideOpened ? "yes" : "no"}`,
    `Evidence digest: ${report.onboardDigest}`,
    "",
    `Credential handoff: ${report.credentialHandoff.summary}`,
    ...report.credentialHandoff.details.map((detail) => `- ${detail}`),
    "",
    "First read-only request:",
    report.firstRead.prompt,
    "",
    "No token value was written to the policy, guide, report, or command arguments. No host configuration was changed.",
  ].join("\n")
}

function renderHostDetection(report: HostDetectionReport): string {
  const candidates = report.candidates.length === 0
    ? ["  none"]
    : report.candidates.flatMap((candidate) => [
        `  ${candidate.title} (${candidate.hostId})`,
        ...candidate.markers.map((marker) => (
          `    ${marker.path} [${marker.scope} ${marker.kind}]`
        )),
      ])
  const unavailable = report.unavailableMarkers.length === 0
    ? ["  none"]
    : report.unavailableMarkers.map((marker) => (
      `  ${marker.hostId}: ${marker.path} [${marker.reason}]`
    ))
  const next = report.status === "selected"
    ? `Next: Use ${CONNECTOR_CLI_COMMAND} onboard --detect-host, or override it with --host.`
    : report.status === "choice-required"
      ? `Next: Choose one candidate explicitly with ${CONNECTOR_CLI_COMMAND} onboard --host HOST.`
      : `Next: Choose a supported host explicitly with ${CONNECTOR_CLI_COMMAND} onboard --host HOST.`
  return [
    `GuildControl MCP host detection: ${report.status}`,
    `Platform: ${report.platform}`,
    `Automatic selection: ${report.selection.hostId || "none"}`,
    `Markers checked: ${report.coverage.checkedMarkerCount}`,
    "Filesystem inspection: metadata only",
    "Host configuration content read: no",
    "Credential values read: no",
    "Candidates:",
    ...candidates,
    "Unavailable markers:",
    ...unavailable,
    "Limitations:",
    ...report.limitations.map((limitation) => `  - ${limitation}`),
    "",
    next,
  ].join("\n")
}

function renderHostActivation(
  plan: HostActivationPlan,
  adapterCatalog: HostAdapterCatalog,
): string {
  const source = plan.policy.source.kind === "config"
    ? `configuration ${plan.policy.source.file}`
    : `managed profile ${plan.policy.source.name}`
  return [
    "GuildControl MCP host activation: ok",
    `Activation digest: ${plan.activationDigest}`,
    `Policy: ${plan.policy.name} from ${source}`,
    `Application: ${plan.policy.identity.applicationId}`,
    `Bot: ${plan.policy.identity.botId}`,
    `Guild scope: ${plan.policy.readScope.guildIds.join(", ")}`,
    `Channel scope: ${plan.policy.readScope.channelIds.join(", ") || "all visible channels in exact guild scope"}`,
    `Tool surface: ${plan.policy.tools.surface}`,
    `Toolsets: ${plan.policy.tools.toolsets.join(", ")}`,
    `Credential environment names: ${plan.launch.secrets.environmentVariables.join(", ") || "none"}`,
    `Credential files: ${plan.launch.secrets.files.join(", ") || "none"}`,
    "",
    "Portable stdio launch descriptor:",
    JSON.stringify(plan.launch, null, 2),
    "",
    "Verified host adapters:",
    ...adapterCatalog.adapters.map((adapter) => `${adapter.id}: ${adapter.adapterDigest}`),
    "",
    "Read-only host verification request:",
    plan.verification.prompt,
    "",
    "No credential value was read or embedded. Discord and the network were not contacted. No process was started, no host was discovered, and no policy or host configuration was changed.",
  ].join("\n")
}

function renderHostAdapter(adapter: HostAdapter): string {
  return [
    `GuildControl MCP host adapter: ${adapter.title} (${adapter.id})`,
    `Adapter digest: ${adapter.adapterDigest}`,
    `Activation digest: ${adapter.activationDigest}`,
    `Host server name: ${adapter.hostServerName}`,
    `Secret strategy: ${adapter.secret.strategy}`,
    `Credential environment names: ${adapter.secret.environmentVariables.join(", ") || "none"}`,
    "Destinations:",
    ...adapter.destinations.map((destination) => `- ${destination}`),
    ...(adapter.installUri
      ? [
          "Cursor install URI (private; review before use):",
          adapter.installUri,
        ]
      : []),
    `Exact ${adapter.format.toUpperCase()}:`,
    adapter.content.trimEnd(),
    "Instructions:",
    ...adapter.instructions.map((instruction) => `- ${instruction}`),
    "Limitations:",
    ...adapter.limitations.map((limitation) => `- ${limitation}`),
    `Specification: ${adapter.specification.title} (${adapter.specification.url})`,
  ].join("\n")
}

function renderHostActivationHtmlExport(
  report: DiscordHostActivationHtmlExportReport,
): string {
  return [
    "GuildControl MCP host activation guide: ok",
    `File: ${report.file}`,
    `Format: ${report.format}`,
    `Activation digest: ${report.activationDigest}`,
    `Verified adapters: ${report.adapterIds.join(", ")}`,
    ...report.adapterIds.map((id, index) => `${id}: ${report.adapterDigests[index]}`),
    `HTML digest: ${report.htmlDigest}`,
    `Bytes: ${report.bytes}`,
    "Boundary: private mode-0600 standalone HTML with memory-only checklist state and no external navigation",
    "The guide contains private Discord identifiers and may contain local paths. It contains no credential value and must not be shared or committed.",
    "No credential value was read, Discord and the network were not contacted, no browser or process was started, no host was discovered, and no policy or host configuration was changed.",
  ].join("\n")
}

function renderHostInspection(report: HostInspectionReport): string {
  return [
    `GuildControl MCP host inspection: ${report.status}`,
    `Inspection digest: ${report.inspectionDigest}`,
    `Adapter: ${report.adapter.title} (${report.adapter.id})`,
    `Adapter digest: ${report.adapter.adapterDigest}`,
    `Activation digest: ${report.adapter.activationDigest}`,
    `Host server name: ${report.adapter.hostServerName}`,
    `Server entry: ${report.comparison.serverEntry}`,
    `Sensitive inputs: ${report.comparison.matchedSensitiveInputCount}/${report.comparison.expectedSensitiveInputCount} exact`,
    `Unrelated host state: ${report.comparison.unrelatedState}`,
    "Differences:",
    ...(report.comparison.differences.length > 0
      ? report.comparison.differences.map((difference) => `- ${difference}`)
      : ["- none"]),
    `File review: bounded canonical regular single-link stable read; owner ${report.fileReview.owner}; access ${report.fileReview.access}`,
    "Possible credential material was read only as part of the explicit file; no value, raw host content, host path, unrelated state, or activity record was returned or persisted.",
    ...(report.status === "drift"
      ? ["Next: Regenerate this exact adapter, merge only its owned projection, restart or reload the host, rerun inspection, then run smoke."]
      : ["Next: Restart or reload the host if needed, then run smoke to verify real MCP startup and read-only Discord access."]),
    "Limits:",
    ...report.limitations.map((limitation) => `- ${limitation}`),
  ].join("\n")
}

function renderHostChangePlan(report: HostChangePlanReport): string {
  const inputs = report.change.sensitiveInputs
  return [
    "GuildControl MCP host configuration plan: ready",
    `Plan digest: ${report.planDigest}`,
    `Adapter: ${report.adapter.title} (${report.adapter.id})`,
    `Adapter digest: ${report.adapter.adapterDigest}`,
    `Activation digest: ${report.adapter.activationDigest}`,
    `Host server name: ${report.adapter.hostServerName}`,
    `Target state: ${report.fileReview.state}`,
    `Operation: ${report.change.operation}`,
    `Strategy: ${report.change.strategy}`,
    `Server entry: ${report.change.serverEntry}`,
    `Sensitive inputs: add=${inputs.added}, replace=${inputs.replaced}, unchanged=${inputs.unchanged}`,
    `Unrelated state: ${report.change.unrelatedState}`,
    `Canonical JSON rewrite: ${report.change.canonicalJsonRewrite ? "required" : "not required"}`,
    `Recovery backup: ${report.change.backupRequired ? "required" : "not required"}`,
    `Confirmation value: ${report.confirmation.requiredValue}`,
    report.privacy.possibleCredentialMaterialRead
      ? "Possible credential material was read only from the explicit existing file. No value, raw host content, host path, unrelated state, stable private-byte hash, or activity record was returned or persisted."
      : "The selected target was absent, so no host configuration or possible credential material was read. No host path or activity record was returned or persisted.",
    "Next: review this fixed summary, then rerun the same activation selector, adapter, and host file with host apply, this plan digest, and the exact confirmation value.",
    "Limits:",
    ...report.limitations.map((limitation) => `- ${limitation}`),
  ].join("\n")
}

function renderHostChangeApply(report: HostChangeApplyReport): string {
  return [
    `GuildControl MCP host configuration apply: ${report.status}`,
    `Plan digest: ${report.planDigest}`,
    `Adapter: ${report.adapter.title} (${report.adapter.id})`,
    `Adapter digest: ${report.adapter.adapterDigest}`,
    `Activation digest: ${report.adapter.activationDigest}`,
    `Host server name: ${report.adapter.hostServerName}`,
    `Operation: ${report.change.operation}`,
    `Backup: ${report.backup.file ?? "not created"}`,
    `Exact inspection: ${report.inspection.status} (${report.inspection.inspectionDigest})`,
    "No credential value, raw host content, unrelated state, or activity record was returned. A backup path is returned only when a recoverable copy was created.",
    "Next: restart or reload the host, rerun static inspection if desired, then run smoke and one read-only host request.",
    "Limits:",
    ...report.limitations.map((limitation) => `- ${limitation}`),
  ].join("\n")
}

function renderMigrationCatalog(report: MigrationCatalogReport): string {
  return [
    "GuildControl MCP release-exact migration sources",
    `Catalog digest: ${report.catalogDigest}`,
    "",
    ...report.sources.flatMap((source, index) => [
      ...(index > 0 ? [""] : []),
      `${source.id} - ${source.product}`,
      `  Audit fidelity: ${source.auditFidelity}`,
      `  Registry identity: ${source.registryName}`,
      `  Source inventory: ${source.sourceToolCount} tools (${source.sourceInventoryDigest})`,
      `  Outcome groups: ${source.mappingCount}`,
      `  Dispositions: supported=${source.dispositionToolCounts.supported}, review-required=${source.dispositionToolCounts["review-required"]}, intentionally-excluded=${source.dispositionToolCounts["intentionally-excluded"]}`,
      `  Baseline preset: ${source.baselinePreset}`,
      `  Manifest digest: ${source.manifestDigest}`,
      `  Source evidence: ${source.evidenceUrl}`,
      `  Registry release: ${source.registryUrl}`,
      ...source.limitations.map((limitation) => `  Limit: ${limitation}`),
    ]),
    "",
    "No source, configuration, host setting, credential, environment value, network, or Discord endpoint was read. Nothing was changed.",
  ].join("\n")
}

function renderMigrationPlan(report: MigrationPlanReport): string {
  const lines = [
    `GuildControl MCP migration plan: ${report.source.id} -> ${report.target.package}@${report.target.version}`,
    `Plan digest: ${report.planDigest}`,
    `Source manifest digest: ${report.source.manifestDigest}`,
    `Source inventory digest: ${report.source.sourceInventoryDigest}`,
    `Migration catalog digest: ${report.catalogDigest}`,
    `Target catalog digest: ${report.target.catalogContractDigest}`,
    `Audit fidelity: ${report.source.auditFidelity}`,
    `Source evidence: ${report.source.evidenceUrl}`,
    `Registry release: ${report.source.registryUrl}`,
    `Source tools accounted: ${report.summary.sourceToolCount}`,
    `Outcome groups: ${report.summary.mappingCount}`,
    `Dispositions: supported=${report.summary.dispositionToolCounts.supported}, review-required=${report.summary.dispositionToolCounts["review-required"]}, intentionally-excluded=${report.summary.dispositionToolCounts["intentionally-excluded"]}`,
    `Least-privilege baseline: ${report.target.preset}`,
    "",
    "Complete outcome map:",
  ]
  for (const mapping of report.mappings) {
    lines.push(
      `${mapping.id}: ${mapping.outcome} [${mapping.disposition}]`,
      `  Source tools: ${mapping.sourceTools.join(", ")}`,
      `  Target tools: ${mapping.targetTools.join(", ") || "deliberately no connector equivalent"}`,
      `  Recipes: ${mapping.recipes.join(", ") || "baseline or exact-scope workbench"}`,
      `  Route: ${mapping.instruction}`,
      `  Trust-model change: ${mapping.trustChange}`,
    )
  }
  lines.push("", "Staged switching path:")
  for (const [index, step] of report.steps.entries()) {
    lines.push(`${index + 1}. ${step.title}`)
    for (const command of step.commands) lines.push(`   ${command}`)
    lines.push(`   Done when: ${step.completion}`)
  }
  lines.push(
    "",
    "Limits:",
    ...report.limitations.map((limitation) => `- ${limitation}`),
    "",
    "Arguments translated: no",
    "Configuration imported: no",
    "Host settings changed: no",
    "Credentials read: no",
    "Source inspected: no",
    "Network or Discord contacted: no",
    "Policy, source, host, or activity state changed: no",
  )
  return lines.join("\n")
}

function renderMigrationHtmlExport(
  report: DiscordMigrationHtmlExportReport,
): string {
  return [
    "GuildControl MCP migration HTML: ok",
    `File: ${report.file}`,
    `Format: ${report.format}`,
    `Source: ${report.sourceId}`,
    `Plan digest: ${report.planDigest}`,
    `HTML digest: ${report.htmlDigest}`,
    `Bytes: ${report.bytes}`,
    "Output file created: yes",
    "Credentials embedded or read: no",
    "Automatic network: disabled",
    "Browser opened: no",
    "Configuration changed: no",
    "State persistence: disabled",
  ].join("\n")
}

interface PresetListReport {
  presets: readonly SetupPresetDescriptor[]
  schemaVersion: number
  status: "ok"
}

interface PresetShowReport {
  preset: SetupPresetDescriptor
  schemaVersion: number
  status: "ok"
}

function renderPreset(preset: SetupPresetDescriptor): string {
  const privilegedIntents = preset.requirements.privilegedIntents.length === 0
    ? "none"
    : preset.requirements.privilegedIntents
      .map((intent) => `${intent.name} (${intent.status})`)
      .join(", ")
  return [
    `${preset.name}${preset.recommended ? " (recommended)" : ""}`,
    `  ${preset.description}`,
    `  Scope: guild IDs ${preset.requirements.guildIds}; channel IDs ${preset.requirements.channelIds}`,
    `  Thread scope: ${preset.requirements.threadScope}`,
    `  Message Content intent: ${preset.requirements.messageContentIntent}`,
    `  Bot permissions: ${preset.requirements.botPermissions.join(", ")} (${preset.requirements.botPermissionBitfield})`,
    `  Privileged intents: ${privilegedIntents}`,
    `  Tool surface: ${preset.toolSurface}`,
    `  Toolsets: ${preset.toolsets.join(", ")}`,
    `  Tools (${preset.toolNames.length}): ${preset.toolNames.join(", ")}`,
    `  Risk classes: ${preset.riskClasses.join(", ")}`,
    "  Writes: disabled",
    "  Gateway: disabled",
  ].join("\n")
}

function renderBotInstallPlan(report: BotInstallPlan): string {
  const intents = report.privilegedIntents.length === 0
    ? "none required for this preset"
    : report.privilegedIntents
      .map((intent) => `${intent.name} (${intent.status})`)
      .join(", ")
  const [setup, validate, doctor, smoke, hostActivation] = report.postInstall.commands
  return [
    `GuildControl MCP bot install plan: ${report.preset.name}`,
    `Application: ${report.applicationId}`,
    `Guild: ${report.guildId} (selection locked)`,
    `Bot permissions: ${report.permissions.names.join(", ")} (${report.permissions.bitfield})`,
    "Administrator: not requested",
    `Privileged intents: ${intents}`,
    "Authorization: guild install, bot scope only, no callback or user token",
    "",
    "1. In the Discord Developer Portal, enable Guild Install and keep Public Bot disabled unless you intend to share this application.",
    `2. Review privileged intents: ${intents}.`,
    "3. Open this callback-free, guild-locked URL and approve only the permissions listed above:",
    report.installUrl,
    `4. Make the bot token available to setup as ${report.postInstall.credentialVariable} through a protected environment or secret launcher. Later configure the MCP host to supply the same reference. Never put its value in the config file or command line.`,
    `5. From a canonical process-owned private directory, ${report.preset.name === "channel-reader" ? "replace CHANNEL_ID, then run" : "run"} verified setup to create the strict non-secret policy file:`,
    `   ${setup}`,
    "6. Add the portable launch descriptor printed by setup to the MCP host, or generate a private host activation guide:",
    `   ${hostActivation}`,
    "7. Reload the host, then complete this first read-only outcome:",
    `   ${report.postInstall.firstRead.prompt}`,
    `   Required tools: ${report.postInstall.firstRead.toolNames.join(", ")}. Discord writes: disabled.`,
    "8. Optional assurance or troubleshooting only:",
    `   ${validate}`,
    `   ${doctor}`,
    `   ${smoke}`,
    "",
    "Discord was not contacted and no browser was opened. Guild roles and channel overrides determine effective access; verified setup is the post-install readiness gate, while doctor and smoke provide deeper independent evidence when needed.",
  ].join("\n")
}

function renderOnboardingHtmlExport(
  report: DiscordOnboardingHtmlExportReport,
): string {
  return [
    "GuildControl MCP onboarding HTML: ok",
    `File: ${report.file}`,
    `Format: ${report.format}`,
    `Plan digest: ${report.planDigest}`,
    `HTML digest: ${report.htmlDigest}`,
    `Bytes: ${report.bytes}`,
    "Credentials embedded: no",
    "Automatic network: disabled",
    "Browser opened: no",
    "State persistence: disabled",
  ].join("\n")
}

function renderPresetList(report: PresetListReport): string {
  return [
    "GuildControl MCP least-privilege setup presets",
    "",
    ...report.presets.flatMap((preset, index) => [
      ...(index > 0 ? [""] : []),
      renderPreset(preset),
    ]),
  ].join("\n")
}

interface RecipeListReport {
  recipes: readonly ConfigRecipeDescriptor[]
  schemaVersion: number
  status: "ok"
}

interface RecipeShowReport {
  recipe: ConfigRecipeDescriptor
  schemaVersion: number
  status: "ok"
}

function renderRecipe(recipe: ConfigRecipeDescriptor): string {
  const privilegedIntents = recipe.requirements.privilegedIntents.length === 0
    ? "none"
    : recipe.requirements.privilegedIntents
      .map((intent) => `${intent.name} (${intent.status})`)
      .join(", ")
  const gatewayEvidence = recipe.requirements.gateway.evidenceConnection === "none"
    ? `none; event-feed policy ${recipe.requirements.gateway.eventFeedPolicy}`
    : `${recipe.requirements.gateway.evidenceConnection} with ${recipe.requirements.gateway.intents.join(", ")}; event-feed policy ${recipe.requirements.gateway.eventFeedPolicy}`
  return [
    recipe.name,
    `  ${recipe.description}`,
    `  Scope input: ${recipe.requirements.scope.option} (${recipe.requirements.scope.minimum}-${recipe.requirements.scope.maximum})`,
    `  Outer boundary: ${recipe.requirements.scope.outerBoundary ?? "independent exact-user scope"}`,
    `  Added scopes: ${recipe.requirements.scope.targets.join(", ")}`,
    `  Thread scope: ${recipe.requirements.threads
      ? `reads ${recipe.requirements.threads.reads}; message writes ${recipe.requirements.threads.messageWrites}`
      : "unchanged"}`,
    `  Bot permissions: ${recipe.requirements.botPermissions.length === 0 ? "none" : recipe.requirements.botPermissions.join(", ")} (${recipe.requirements.botPermissionBitfield})`,
    `  Privileged intents: ${privilegedIntents}`,
    `  Gateway evidence: ${gatewayEvidence}`,
    `  Toolsets: ${recipe.toolsets.join(", ")}`,
    `  Tools (${recipe.toolNames.length}): ${recipe.toolNames.join(", ")}`,
    `  Risk classes: ${recipe.riskClasses.join(", ")}`,
    recipe.writeCapable
      ? "  Writes: enabled only through the underlying reviewed workflow gates"
      : "  Writes: disabled; this recipe adds a bounded read workflow only",
    "  Risks:",
    ...recipe.risks.map((risk) => `    - ${risk}`),
    "  Warnings:",
    ...recipe.warnings.map((warning) => `    - ${warning}`),
  ].join("\n")
}

function renderRecipeList(report: RecipeListReport): string {
  return [
    "GuildControl MCP additive configuration recipes",
    "",
    ...report.recipes.flatMap((recipe, index) => [
      ...(index > 0 ? [""] : []),
      renderRecipe(recipe),
    ]),
  ].join("\n")
}

function renderRecipePlan(
  report: ConfigRecipePlanReport | ConfigRecipeApplyReport,
): string {
  const scope = report.request.scope
  const changes = report.changes.length === 0
    ? ["  none"]
    : report.changes.map((change) => (
        `  ${change.path}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`
      ))
  const nextChecks = report.nextChecks.map((next) => (
    `  ${JSON.stringify({ args: next.args, command: next.command })}`
  ))
  const applied = report.action === "apply" ? report : undefined
  const applyHandoff = report.action === "plan"
    ? [
        "Exact reviewed apply command:",
        `  ${JSON.stringify({
          args: report.applyCommand.args,
          command: report.applyCommand.command,
        })}`,
      ]
    : []
  return [
    `GuildControl MCP configuration recipe ${report.action}: ${report.recipe.name} (${report.status})`,
    `File: ${report.file}`,
    `Resolved target: ${report.targetFile}`,
    `Exact ${scope.kind} scope: ${scope.ids.join(", ")}`,
    `Current document digest: ${report.currentDocumentDigest}`,
    `Proposed document digest: ${report.proposedDocumentDigest}`,
    `Recipe contract digest: ${report.recipeContractDigest}`,
    `Plan digest: ${report.planDigest}`,
    `Required confirmation: ${report.confirmation.requiredValue}`,
    ...applyHandoff,
    `Configuration written: ${report.execution.configurationWritten ? "yes" : "no"}`,
    ...(report.action === "plan" && report.status === "planned"
      ? ["Write recovery: atomic replacement preserves a recoverable prior-version backup"]
      : []),
    ...(applied?.backupFile
      ? [`Recoverable prior version: ${applied.backupFile}`]
      : []),
    `Bot permissions: ${report.recipe.requirements.botPermissions.join(", ")} (${report.recipe.requirements.botPermissionBitfield})`,
    `Thread scope: ${report.recipe.requirements.threads
      ? `reads ${report.recipe.requirements.threads.reads}; message writes ${report.recipe.requirements.threads.messageWrites}`
      : "unchanged"}`,
    `Privileged intents: ${report.recipe.requirements.privilegedIntents.length === 0
      ? "none"
      : report.recipe.requirements.privilegedIntents
        .map((intent) => `${intent.name} (${intent.status})`)
        .join(", ")}`,
    `Gateway evidence: ${report.recipe.requirements.gateway.evidenceConnection === "none"
      ? `none; event-feed policy ${report.recipe.requirements.gateway.eventFeedPolicy}`
      : `${report.recipe.requirements.gateway.evidenceConnection} with ${report.recipe.requirements.gateway.intents.join(", ")}; event-feed policy ${report.recipe.requirements.gateway.eventFeedPolicy}`}`,
    `Risk classes: ${report.recipe.riskClasses.join(", ")}`,
    "Changes:",
    ...changes,
    "Risks:",
    ...report.risks.map((risk) => `  - ${risk}`),
    "Warnings:",
    ...report.warnings.map((warning) => `  - ${warning}`),
    "",
    "Complete proposed non-secret configuration:",
    JSON.stringify(report.proposedDocument, null, 2),
    "",
    "Post-application checks as structured commands:",
    ...nextChecks,
    "",
    "No secret value was read and Discord was not contacted.",
  ].join("\n")
}

interface ProfileSummary {
  applicationId: string
  botId: string
  channelCount: number
  credentialProvider: "environment" | "file"
  credentialReference: string
  gatewayEnabled: boolean
  guildCount: number
  name: string
  toolsets: string[]
  toolSurface: string
}

interface ProfileListReport {
  profiles: ProfileSummary[]
  schemaVersion: number
  status: "ok"
}

interface ProfileShowReport {
  profile: ConnectorProfile
  schemaVersion: number
  status: "ok"
}

interface ProfileActionReport {
  action: "remove" | "restore"
  credentialUnaffected: true
  name: string
  recoverable?: true
  schemaVersion: number
  status: "ok"
}

function profileSummary(profile: ConnectorProfile): ProfileSummary {
  return {
    applicationId: profile.identity.applicationId,
    botId: profile.identity.botId,
    channelCount: profile.readScope.channelIds.length,
    credentialProvider: profile.credential.provider,
    credentialReference: profile.credential.provider === "environment"
      ? profile.credential.variable
      : profile.credential.path,
    gatewayEnabled: profile.gateway.enabled,
    guildCount: profile.readScope.guildIds.length,
    name: profile.name,
    toolsets: [...profile.tools.toolsets],
    toolSurface: profile.tools.surface,
  }
}

function renderProfileList(report: ProfileListReport): string {
  if (report.profiles.length === 0) return "No saved GuildControl MCP profiles"
  return report.profiles.map((profile) => (
    `${profile.name}: application ${profile.applicationId}, bot ${profile.botId}, ${profile.guildCount} guilds, ${profile.channelCount} channels, ${profile.toolSurface} tools, Gateway ${profile.gatewayEnabled ? "enabled" : "disabled"}, credential ${profile.credentialProvider} ${profile.credentialReference}`
  )).join("\n")
}

function renderProfileShow(report: ProfileShowReport): string {
  return [
    `GuildControl MCP profile: ${report.profile.name}`,
    JSON.stringify(report.profile, null, 2),
  ].join("\n\n")
}

function renderProfileAction(report: ProfileActionReport): string {
  const lifecycle = report.action === "remove"
    ? `Profile ${report.name} moved to recoverable trash`
    : `Profile ${report.name} restored from recoverable trash`
  return [
    lifecycle,
    "The referenced external credential and Discord token were not modified or revoked.",
  ].join("\n")
}

function renderConfigSummary(report: ConfigValidationReport): string {
  const summary = report.summary
  const configuredScopes = summary.scopesConfigured.length > 0
    ? summary.scopesConfigured
      .map((entry) => `${entry.name}=${entry.count}`)
      .join(", ")
    : "none"
  const configuredGroups = summary.groupsConfigured.length > 0
    ? summary.groupsConfigured
      .map((entry) => `${entry.type}=${entry.groupCount} groups/${entry.exactIdCount} exact IDs`)
      .join(", ")
    : "none"
  return [
    `Configuration: ${summary.name}`,
    `File: ${report.file}`,
    ...(report.targetFile === report.file ? [] : [`Resolved target: ${report.targetFile}`]),
    `Document schema: ${summary.configSchemaVersion}`,
    `Application: ${summary.identity.applicationId}`,
    `Bot: ${summary.identity.botId}`,
    `Guild scope: ${summary.readScope.guildIds.join(", ")}`,
    `Channel scope: ${summary.readScope.channelIds.join(", ") || "all visible channels in scope"}`,
    `Tool surface: ${summary.tools.surface}`,
    `Toolsets: ${summary.tools.toolsets.join(", ")}`,
    `Gateway: ${summary.gateway.enabled ? "enabled" : "disabled"}`,
    `Credential: ${summary.credential.provider} ${summary.credential.provider === "environment" ? summary.credential.variable : summary.credential.path}`,
    `Enabled capabilities: ${summary.capabilitiesEnabled.join(", ") || "none"}`,
    `Scope groups: ${configuredGroups}`,
    `Configured feature scopes: ${configuredScopes}`,
    `Referenced secret environment variables: ${summary.secretEnvironmentVariables.join(", ") || "none"}`,
    `Referenced secret files: ${summary.secretFilePaths.join(", ") || "none"}`,
  ].join("\n")
}

function renderConfigValidation(report: ConfigValidationReport): string {
  return [
    "GuildControl MCP configuration: valid",
    renderConfigSummary(report),
    "Validation used placeholders, read no secret values, and did not contact Discord.",
  ].join("\n")
}

function renderConfigShow(report: ConfigShowReport): string {
  return [
    renderConfigValidation(report),
    "",
    JSON.stringify(report.document, null, 2),
  ].join("\n")
}

function renderConfigExplain(report: ConfigExplainReport): string {
  return [
    `GuildControl MCP configuration fields: ${report.query}`,
    `Schema: ${report.schemaId}`,
    "Operational policy source: one selected schema-v2 configuration document",
    "Secret values: external references only; never stored in the policy document",
    "",
    ...report.fields.flatMap((field, index) => [
      ...(index > 0 ? [""] : []),
      field.path,
      `  ${field.description}`,
      `  Type: ${field.kind}`,
      `  Required: ${field.required ? "yes" : "no"}`,
      `  Default: ${field.defaultValue === undefined ? "none" : JSON.stringify(field.defaultValue)}`,
    ]),
  ].join("\n")
}

function renderConfigWrite(report: ConfigWriteReport): string {
  const result = report.created ? "created" : "replaced"
  return [
    `GuildControl MCP configuration ${result}: ${report.file}`,
    `Source: ${report.source}`,
    ...(report.backupFile
      ? [`Recoverable prior version: ${report.backupFile}`]
      : []),
    renderConfigSummary(report),
    "",
    "Next: Run guildctl doctor --config with the file path shown above.",
  ].join("\n")
}

function renderConfigWorkbench(
  report: DiscordConfigWorkbenchHtmlExportReport,
): string {
  return [
    `GuildControl MCP configuration workbench: ${report.file}`,
    `Validated active file: ${report.activeFile}`,
    `Suggested candidate filename: ${report.candidateFilename}`,
    `Active document digest: ${report.activeDocumentDigest}`,
    `Schema digest: ${report.schemaDigest}`,
    `HTML digest: ${report.htmlDigest}`,
    `Bytes: ${report.bytes}`,
    "Boundary: private standalone HTML, memory-only edits, explicit candidate download, no active-file write",
    "No secret value was read, Discord was not contacted, no browser was opened, and no network or browser persistence authority is present.",
    "Next: Open the private file locally, download a candidate, then run config plan against the active and candidate files.",
  ].join("\n")
}

function renderConfigChange(
  report: ConfigChangePlanReport | ConfigChangeApplyReport,
): string {
  const changes = report.changes.length === 0
    ? ["  none"]
    : report.changes.flatMap((change) => [
        `  ${change.path} [${change.category}; ${change.impact}]`,
        `    Before: ${JSON.stringify(change.before)}`,
        `    After: ${JSON.stringify(change.after)}`,
      ])
  const addedTools = report.tools.added.length > 0
    ? report.tools.added.join(", ")
    : "none"
  const removedTools = report.tools.removed.length > 0
    ? report.tools.removed.join(", ")
    : "none"
  return [
    `GuildControl MCP configuration change ${report.action}: ${report.status}`,
    `Active file: ${report.file}`,
    `Active target: ${report.targetFile}`,
    `Candidate file: ${report.candidateFile}`,
    `Candidate target: ${report.candidateTargetFile}`,
    `Current document digest: ${report.currentDocumentDigest}`,
    `Candidate document digest: ${report.candidateDocumentDigest}`,
    `Plan digest: ${report.planDigest}`,
    `Required confirmation: ${report.confirmation.requiredValue}`,
    `Configuration written: ${report.execution.configurationWritten ? "yes" : "no"}`,
    ...(report.action === "plan" && report.status === "planned"
      ? ["Write recovery: atomic replacement preserves a recoverable prior-version backup"]
      : []),
    ...(report.action === "apply" && report.backupFile
      ? [`Recoverable prior version: ${report.backupFile}`]
      : []),
    `Impact: expansions=${report.impact.authorityExpansions}, reductions=${report.impact.authorityReductions}, redistributions=${report.impact.authorityRedistributions}, operational=${report.impact.operationalChanges}, metadata=${report.impact.metadataOnly}`,
    `Canonical tools added: ${addedTools}`,
    `Canonical tools removed: ${removedTools}`,
    "Changes:",
    ...changes,
    "Warnings:",
    ...report.warnings.map((warning) => `  - ${warning}`),
    "",
    "Complete candidate non-secret configuration:",
    JSON.stringify(report.candidateDocument, null, 2),
    "",
    "Post-application checks as structured commands:",
    ...report.nextChecks.map((next) => (
      `  ${JSON.stringify({ args: next.args, command: next.command })}`
    )),
    "",
    "No secret value was read and Discord was not contacted.",
  ].join("\n")
}

function renderSmoke(report: SmokeReport): string {
  return [
    "GuildControl MCP smoke: ok",
    `Transport: ${report.transport}`,
    `Protocol: ${report.protocolVersion}`,
    `Server: ${report.serverName} ${report.serverVersion}`,
    `Application: ${report.applicationId}`,
    `Bot: ${report.botId}`,
    `Tool surface: ${report.toolSurface}`,
    `Toolsets: ${report.toolsets.join(", ")}`,
    `Tools: ${report.toolCount}`,
    `Read-only tools: ${report.readOnlyTools.join(", ")}`,
    `Write-capable tools: ${report.writeCapableTools.join(", ")}`,
    `Destructive subset: ${report.destructiveTools.join(", ")}`,
    `Resources: ${report.resourceUris.join(", ")}`,
    `Resource templates: ${report.resourceTemplateUris.join(", ")}`,
    `Prompts: ${report.promptNames.join(", ")}`,
  ].join("\n")
}

function safeWrite(
  stream: Pick<NodeJS.WriteStream, "write">,
  value: string,
  environment: NodeJS.ProcessEnv,
): void {
  const secrets = Object.entries(environment)
    .filter(([name]) => DISCORD_TOKEN_ENVIRONMENT_PATTERN.test(name))
    .flatMap(([, token]) => [token, token?.trim()])
  stream.write(`${redactText(value, secrets)}\n`)
}

function jsonReport(value: object): string {
  return JSON.stringify(value, null, 2)
}

function currentEntrypointLaunch(options: CliOptions): {
  args: string[]
  command: string
} {
  const entrypointPath = options.entrypointPath || process.argv[1]
  return entrypointPath
    ? {
        args: [
          ...lowMemoryNodeArguments(options.nodeVersion || process.versions.node),
          entrypointPath,
          "serve",
        ],
        command: options.executablePath || process.execPath,
      }
    : {
        args: ["serve"],
        command: CONNECTOR_CLI_COMMAND,
      }
}

function publishedPackageLaunch(): {
  args: string[]
  command: string
} {
  return {
    args: [...CONNECTOR_NPX_ARGUMENTS, "serve"],
    command: CONNECTOR_NPX_COMMAND,
  }
}

interface OnboardCredentialSelection {
  readonly access: OnboardCredentialAccess
  readonly credentialFile?: string
  readonly credentialVariable?: string
  readonly hiddenToken?: string
}

interface OnboardExecutionResult {
  readonly browser: {
    readonly guideOpened: boolean
    readonly installOpened: boolean
  }
  readonly guide: OnboardHtmlExportReport
  readonly hostDetection?: HostDetectionReport
  readonly report: OnboardReport
}

const ONBOARD_PROMPT_ATTEMPTS = 3
const ONBOARD_STAGE_COUNT = 5
const ONBOARD_BACK_INPUT = ":back"
const ONBOARD_BACK = Symbol("onboard-back")

type OnboardBack = typeof ONBOARD_BACK

type OnboardPromptValidation<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly message: string; readonly ok: false }

async function promptValidated<Value>(
  interaction: CliInteraction,
  message: string,
  validate: (value: string) => OnboardPromptValidation<Value>,
): Promise<Value> {
  let correction = ""
  for (let attempt = 0; attempt < ONBOARD_PROMPT_ATTEMPTS; attempt += 1) {
    const value = await interaction.promptText(
      correction ? `${correction}\n${message}` : message,
    )
    const result = validate(value)
    if (result.ok) return result.value
    correction = result.message
  }
  throw new ConfigurationError(
    `${correction} No valid answer was received after ${ONBOARD_PROMPT_ATTEMPTS} attempts`,
  )
}

function requiredValue(
  value: string,
  label: string,
): OnboardPromptValidation<string> {
  const normalized = value.trim()
  return normalized
    ? { ok: true, value: normalized }
    : { message: `${label} must not be empty`, ok: false }
}

function discordSnowflake(
  value: string,
  label: string,
): OnboardPromptValidation<string> {
  const normalized = value.trim()
  if (
    !DISCORD_SNOWFLAKE_PATTERN.test(normalized)
    || BigInt(normalized) < 1n
    || BigInt(normalized) > DISCORD_SNOWFLAKE_MAX
  ) {
    return {
      message: `${label} must be a Discord snowflake containing only decimal digits`,
      ok: false,
    }
  }
  return { ok: true, value: normalized }
}

async function promptDiscordSnowflake(
  interaction: CliInteraction,
  message: string,
  label: string,
  supplied: string | undefined,
): Promise<string> {
  if (supplied !== undefined) {
    const result = discordSnowflake(supplied, label)
    if (result.ok) return result.value
    throw new ConfigurationError(result.message)
  }
  return promptValidated(
    interaction,
    message,
    (value) => discordSnowflake(value, label),
  )
}

async function promptYesNo(
  interaction: CliInteraction,
  message: string,
  defaultValue: boolean,
): Promise<boolean> {
  return promptValidated(interaction, message, (value) => {
    const normalized = value.trim().toLowerCase()
    if (!normalized) return { ok: true, value: defaultValue }
    if (["y", "yes"].includes(normalized)) return { ok: true, value: true }
    if (["n", "no"].includes(normalized)) return { ok: true, value: false }
    return { message: "Enter yes or no", ok: false }
  })
}

function integratedReviewMode(options: {
  acceptCurrentPlan: boolean
  command: "config replace" | "recipe enable"
  json: boolean
  terminal: boolean
}): "accepted" | "interactive" {
  if (options.acceptCurrentPlan) return "accepted"
  if (options.json || !options.terminal) {
    throw new ConfigurationError(
      `${options.command} requires an interactive terminal or both --accept-current-plan and --confirm`,
    )
  }
  return "interactive"
}

function acceptedCurrentPlanConfirmation(
  value: string | undefined,
  command: "config replace" | "recipe enable",
): string {
  if (value === undefined) {
    throw new ConfigurationError(
      `${command} requires --confirm with --accept-current-plan`,
    )
  }
  return value
}

async function promptReviewedConfirmation(
  interaction: CliInteraction,
  requiredValue: string,
  subject: string,
): Promise<string> {
  const confirmation = await interaction.promptText(
    `Type ${requiredValue} to apply the reviewed ${subject}, or press Ctrl-C to cancel: `,
  )
  if (confirmation !== requiredValue) {
    throw new ConfigurationError(
      `Confirmation must exactly match ${requiredValue}`,
    )
  }
  return confirmation
}

function matchOnboardHost(
  value: string,
  availableHostIds: readonly OnboardHostId[],
): OnboardHostId | undefined {
  const normalized = value.trim().toLowerCase()
  if (/^[0-9]+$/.test(normalized)) {
    return availableHostIds[Number(normalized) - 1]
  }
  return availableHostIds.find((id) => (
    id.toLowerCase() === normalized
    || onboardHostDescriptor(id).title.toLowerCase() === normalized
  ))
}

async function selectOnboardHost(
  interaction: CliInteraction,
  supplied: OnboardHostId | undefined,
  availableHostIds: readonly OnboardHostId[] = ONBOARD_HOST_IDS,
  heading = "Choose the MCP host to activate first:",
): Promise<OnboardHostId> {
  if (supplied) return supplied
  return promptValidated(
    interaction,
    [
      heading,
      ...availableHostIds.map((id, index) => `  ${index + 1}. ${onboardHostDescriptor(id).title} (${id})`),
      "Host [number, ID, or name]: ",
    ].join("\n"),
    (value) => {
      const hostId = matchOnboardHost(value, availableHostIds)
      return hostId
        ? { ok: true, value: hostId }
        : {
            message: `Host was not recognized. Enter 1-${availableHostIds.length}, a host ID, or a displayed name`,
            ok: false,
          }
    },
  )
}

function requireAvailableCredentialVariable(
  variable: string,
  environment: NodeJS.ProcessEnv,
): string {
  const normalized = variable.trim()
  if (!normalized) {
    throw new ConfigurationError("Credential environment variable name must not be empty")
  }
  if (!environment[normalized]?.trim()) {
    throw new CredentialUnavailableError("environment", normalized)
  }
  return normalized
}

async function promptAvailableCredentialVariable(
  interaction: CliInteraction,
  environment: NodeJS.ProcessEnv,
): Promise<string | OnboardBack> {
  return promptValidated<string | OnboardBack>(
    interaction,
    `Environment variable [${DEFAULT_TOKEN_ENVIRONMENT_VARIABLE}; ${ONBOARD_BACK_INPUT} to choose another source]: `,
    (value) => {
      const variable = value.trim() || DEFAULT_TOKEN_ENVIRONMENT_VARIABLE
      if (variable.toLowerCase() === ONBOARD_BACK_INPUT) {
        return { ok: true, value: ONBOARD_BACK }
      }
      if (!environment[variable]?.trim()) {
        return {
          message: `Environment variable ${variable} is not set in this process. Enter another name or ${ONBOARD_BACK_INPUT} to choose another source`,
          ok: false,
        }
      }
      return { ok: true, value: variable }
    },
  )
}

async function promptProtectedCredentialFile(
  interaction: CliInteraction,
): Promise<string | OnboardBack> {
  return promptValidated<string | OnboardBack>(
    interaction,
    `Protected token file [${ONBOARD_BACK_INPUT} to choose another source]: `,
    (value) => {
      const file = value.trim()
      if (file.toLowerCase() === ONBOARD_BACK_INPUT) {
        return { ok: true, value: ONBOARD_BACK }
      }
      return requiredValue(file, "Protected token file")
    },
  )
}

async function promptHiddenToken(
  interaction: CliInteraction,
  credentialVariable = DEFAULT_TOKEN_ENVIRONMENT_VARIABLE,
): Promise<string> {
  const label = credentialVariable === DEFAULT_TOKEN_ENVIRONMENT_VARIABLE
    ? "Discord bot token"
    : `Discord bot token for ${credentialVariable}`
  for (let attempt = 0; attempt < ONBOARD_PROMPT_ATTEMPTS; attempt += 1) {
    const message = attempt === 0
      ? `${label}: `
      : `Token was empty. ${label}: `
    const value = await interaction.promptSecret(message)
    if (value.trim()) return value.trim()
  }
  throw new ConfigurationError(
    `Discord bot token must not be empty. No token was received after ${ONBOARD_PROMPT_ATTEMPTS} attempts`,
  )
}

type OnboardCredentialSource = "environment" | "file" | "prompt"

async function selectExistingOnboardCredential(
  parsed: Extract<ParsedCliArguments, { command: "onboard" }>,
  hostId: OnboardHostId,
  interactive: boolean,
  interaction: CliInteraction,
  environment: NodeJS.ProcessEnv,
  credential: ConnectorCredentialReference,
): Promise<OnboardCredentialSelection> {
  if (credential.provider === "file") {
    if (!onboardHostSupportsCredentialFile(hostId)) {
      throw new ConfigurationError(
        "The existing file-backed policy cannot be activated through the selected MCPB host; choose another host or policy",
      )
    }
    if (parsed.credentialVariable) {
      throw new ConfigurationError(
        "The existing onboarding policy uses a protected token file; --token-env cannot replace its credential custody",
      )
    }
    if (
      parsed.credentialFile
      && resolveConnectorSecretFile(parsed.credentialFile) !== credential.path
    ) {
      throw new ConfigurationError(
        "Option --token-file does not match the existing onboarding policy's protected credential path",
      )
    }
    return {
      access: "protected-file",
      credentialFile: credential.path,
    }
  }
  if (parsed.credentialFile) {
    throw new ConfigurationError(
      `The existing onboarding policy uses environment variable ${credential.variable}; --token-file cannot replace its credential custody`,
    )
  }
  if (
    parsed.credentialVariable
    && parsed.credentialVariable.trim() !== credential.variable
  ) {
    throw new ConfigurationError(
      `Option --token-env must match existing onboarding variable ${credential.variable}`,
    )
  }
  if (environment[credential.variable]?.trim()) {
    return {
      access: "existing-environment",
      credentialVariable: credential.variable,
    }
  }
  if (!interactive) {
    throw new CredentialUnavailableError("environment", credential.variable)
  }
  return {
    access: "one-time-prompt",
    credentialVariable: credential.variable,
    hiddenToken: await promptHiddenToken(interaction, credential.variable),
  }
}

async function selectOnboardCredentialSource(
  interaction: CliInteraction,
  credentialFileSupported: boolean,
): Promise<OnboardCredentialSource> {
  return promptValidated(
    interaction,
    [
      "Choose how GuildControl should access the bot token:",
      "  1. One-time hidden prompt (setup only; host entry still required)",
      "  2. Existing environment variable (reusable when the host inherits it)",
      ...(credentialFileSupported ? ["  3. Existing protected token file (reused by the policy)"] : []),
      "Token source [1]: ",
    ].join("\n"),
    (value) => {
      const normalized = value.trim().toLowerCase()
      if (!normalized || ["1", "prompt", "hidden", "hidden prompt"].includes(normalized)) {
        return { ok: true, value: "prompt" }
      }
      if (["2", "environment", "env", "environment variable"].includes(normalized)) {
        return { ok: true, value: "environment" }
      }
      if (
        credentialFileSupported
        && ["3", "file", "protected file", "token file"].includes(normalized)
      ) {
        return { ok: true, value: "file" }
      }
      return {
        message: credentialFileSupported
          ? "Token source was not recognized. Enter 1-3 or a displayed name"
          : "Token source was not recognized. Enter 1-2 or a displayed name",
        ok: false,
      }
    },
  )
}

async function selectOnboardCredential(
  parsed: Extract<ParsedCliArguments, { command: "onboard" }>,
  hostId: OnboardHostId,
  interactive: boolean,
  interaction: CliInteraction,
  environment: NodeJS.ProcessEnv,
  existingCredential?: ConnectorCredentialReference,
): Promise<OnboardCredentialSelection> {
  if (existingCredential) {
    return selectExistingOnboardCredential(
      parsed,
      hostId,
      interactive,
      interaction,
      environment,
      existingCredential,
    )
  }
  const credentialFileSupported = onboardHostSupportsCredentialFile(hostId)
  if (parsed.credentialFile) {
    if (!credentialFileSupported) {
      throw new ConfigurationError(
        "The selected MCPB host requires an environment-backed policy; use a protected environment variable or hidden prompt",
      )
    }
    return {
      access: "protected-file",
      credentialFile: parsed.credentialFile,
    }
  }
  if (parsed.credentialVariable) {
    return {
      access: "existing-environment",
      credentialVariable: requireAvailableCredentialVariable(
        parsed.credentialVariable,
        environment,
      ),
    }
  }
  if (environment[DEFAULT_TOKEN_ENVIRONMENT_VARIABLE]?.trim()) {
    return {
      access: "existing-environment",
      credentialVariable: DEFAULT_TOKEN_ENVIRONMENT_VARIABLE,
    }
  }
  if (!interactive) {
    throw new CredentialUnavailableError(
      "environment",
      DEFAULT_TOKEN_ENVIRONMENT_VARIABLE,
    )
  }
  for (;;) {
    const source = await selectOnboardCredentialSource(
      interaction,
      credentialFileSupported,
    )
    if (source === "prompt") {
      const hiddenToken = await promptHiddenToken(interaction)
      return {
        access: "one-time-prompt",
        credentialVariable: DEFAULT_TOKEN_ENVIRONMENT_VARIABLE,
        hiddenToken,
      }
    }
    if (source === "environment") {
      const credentialVariable = await promptAvailableCredentialVariable(
        interaction,
        environment,
      )
      if (credentialVariable === ONBOARD_BACK) continue
      return {
        access: "existing-environment",
        credentialVariable,
      }
    }
    if (credentialFileSupported) {
      const credentialFile = await promptProtectedCredentialFile(interaction)
      if (credentialFile === ONBOARD_BACK) continue
      return {
        access: "protected-file",
        credentialFile,
      }
    }
    throw new ConfigurationError("The selected host does not support protected token files")
  }
}

async function confirmOnboardInstallation(
  interaction: CliInteraction,
  guildId: string,
  supplied: string | undefined,
): Promise<string> {
  const validate = (value: string): OnboardPromptValidation<string> => {
    const normalized = value.trim()
    return normalized === guildId
      ? { ok: true, value: normalized }
      : {
          message: `Installation confirmation must exactly match guild ${guildId}`,
          ok: false,
        }
  }
  if (supplied !== undefined) {
    const result = validate(supplied)
    if (result.ok) return result.value
    throw new ConfigurationError(result.message)
  }
  return promptValidated(
    interaction,
    `After Discord shows the bot in guild ${guildId}, type that guild ID exactly: `,
    validate,
  )
}

function assertNonInteractiveOnboardArguments(
  parsed: Extract<ParsedCliArguments, { command: "onboard" }>,
): void {
  const missing = [
    ["--host or --detect-host", parsed.hostId || parsed.detectHost],
    ["--application-id", parsed.applicationId],
    ["--guild-id", parsed.guildId],
    ["--config", parsed.configFile],
    ["--confirm-installed", parsed.confirmation],
  ].filter(([, value]) => !value).map(([name]) => name)
  if (missing.length > 0) {
    throw new ConfigurationError(
      `Non-interactive onboarding requires ${missing.join(", ")}`,
    )
  }
}

async function executeOnboard(
  parsed: Extract<ParsedCliArguments, { command: "onboard" }>,
  options: CliOptions,
  dependencies: CliDependencies,
  environment: NodeJS.ProcessEnv,
): Promise<OnboardExecutionResult> {
  const interaction = options.interaction || DEFAULT_CLI_INTERACTION
  const interactive = !parsed.json && Boolean((options.stdin || process.stdin).isTTY)
  const stderr = options.stderr || process.stderr
  const progress = (
    stage: number,
    message: string,
    progressEnvironment: NodeJS.ProcessEnv = environment,
  ): void => {
    if (interactive) {
      safeWrite(
        stderr,
        `[${stage}/${ONBOARD_STAGE_COUNT}] ${message}`,
        progressEnvironment,
      )
    }
  }
  if (!interactive) assertNonInteractiveOnboardArguments(parsed)

  progress(1, "Identify the MCP host and exact local policy")
  let hostDetection: HostDetectionReport | undefined
  let hostId: OnboardHostId
  if (parsed.hostId) {
    hostId = parsed.hostId
  } else if (parsed.detectHost) {
    hostDetection = await dependencies.detectHosts({ environment })
    if (hostDetection.selection.hostId) {
      hostId = hostDetection.selection.hostId
    } else if (!interactive) {
      const candidates = hostDetection.candidates.map(({ hostId: id }) => id)
      throw new ConfigurationError(candidates.length > 0
        ? `Host detection found multiple candidates: ${candidates.join(", ")}; pass one exact --host ID`
        : "Host detection found no candidate; pass one exact --host ID")
    } else {
      const candidates = hostDetection.candidates.map(({ hostId: id }) => id)
      hostId = await selectOnboardHost(
        interaction,
        undefined,
        candidates.length > 0 ? candidates : ONBOARD_HOST_IDS,
        candidates.length > 0
          ? "Host detection found multiple plausible hosts. Choose one:"
          : "Host detection found no plausible host. Choose one explicitly:",
      )
    }
  } else {
    hostId = await selectOnboardHost(interaction, undefined)
  }
  const defaultConfig = parsed.configFile === undefined
  const configFile = resolveConnectorConfigFile(
    parsed.configFile || resolveDefaultOnboardConfigFile({ environment }),
  )
  const policyExists = dependencies.pathExists(configFile)
  const existingDocument = policyExists
    ? dependencies.loadConfigDocument(configFile)
    : undefined
  const existingInstall = existingDocument
    ? reusableOnboardInstallPlan(existingDocument, configFile)
    : undefined
  const applicationId = await promptDiscordSnowflake(
    interaction,
    "Discord Application ID: ",
    "Application ID",
    parsed.applicationId ?? existingInstall?.applicationId,
  )
  const guildId = await promptDiscordSnowflake(
    interaction,
    "Discord Guild ID: ",
    "Guild ID",
    parsed.guildId ?? existingInstall?.guildId,
  )
  const install = createBotInstallPlan({
    applicationId,
    guildId,
    preset: "server-observer",
  })
  if (existingDocument) {
    assertReusableOnboardPolicy(existingDocument, configFile, install)
  }
  if (!onboardHostSupportsCredentialFile(hostId) && parsed.credentialFile) {
    throw new ConfigurationError(
      "The selected MCPB host requires an environment-backed policy; use --token-env or the hidden prompt",
    )
  }

  progress(
    2,
    policyExists
      ? "Reverify the bounded bot installation pinned by the existing policy"
      : "Install the bounded read-only bot and confirm the exact guild",
  )
  let installOpened = false
  if (!policyExists && interactive && parsed.confirmation === undefined) {
    const shouldOpen = parsed.open || await promptYesNo(
      interaction,
      [
        "GuildControl will request only the listed read permissions, lock the grant to the exact guild, and request no Administrator permission.",
        `Install URL: ${install.installUrl}`,
        "Open Discord to install the bot? [Y/n]: ",
      ].join("\n"),
      true,
    )
    if (shouldOpen) {
      await interaction.openExternal(install.installUrl)
      installOpened = true
    }
  }

  if (!policyExists || parsed.confirmation !== undefined) {
    await confirmOnboardInstallation(
      interaction,
      install.guildId,
      parsed.confirmation,
    )
  }

  progress(
    3,
    policyExists
      ? "Verify identity and installation against the existing private policy"
      : "Verify identity and installation, then publish the private policy",
  )
  const credential = await selectOnboardCredential(
    parsed,
    hostId,
    interactive,
    interaction,
    environment,
    existingDocument?.credential,
  )
  if (defaultConfig && !policyExists) {
    await dependencies.ensureConfigDirectory(dirname(configFile))
  }
  const hiddenCredentialVariable = credential.hiddenToken
    ? credential.credentialVariable
    : undefined
  if (credential.hiddenToken && !hiddenCredentialVariable) {
    throw new ConfigurationError(
      "One-time onboarding credential access requires one exact environment variable",
    )
  }
  const executionEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    [CONFIG_FILE_ENVIRONMENT_VARIABLE]: configFile,
    ...(credential.hiddenToken && hiddenCredentialVariable
      ? { [hiddenCredentialVariable]: credential.hiddenToken }
      : {}),
  }
  const launcher = publishedPackageLaunch()
  let report: OnboardReport
  try {
    const setup = await dependencies.prepareSetup({
      args: launcher.args,
      command: launcher.command,
      configFile,
      ...(policyExists
        ? { reuseExistingConfig: true }
        : {
            ...(credential.credentialFile
              ? { credentialFile: credential.credentialFile }
              : {}),
            ...(credential.credentialVariable
              ? { credentialVariable: credential.credentialVariable }
              : {}),
          }),
      environment: executionEnvironment,
      expectedApplicationId: install.applicationId,
      preset: {
        channelIds: [],
        guildIds: [install.guildId],
        name: "server-observer",
      },
    })
    const document = dependencies.loadConfigDocument(configFile)
    const config = dependencies.loadConfig(executionEnvironment)
    progress(4, "Smoke-test the real MCP stdio path", executionEnvironment)
    const smoke = await dependencies.smoke({
      config,
      environment: executionEnvironment,
      launch: {
        args: setup.launch.args,
        command: setup.launch.command,
      },
    })
    const activation = createHostActivationPlan({
      document,
      launch: setup.launch,
      source: { file: configFile, kind: "config" },
    })
    report = createOnboardReport({
      activation,
      configFile,
      credentialAccess: credential.access,
      hostId,
      install,
      policyDisposition: policyExists ? "reused" : "created",
      setup,
      smoke,
    })
    if (
      credential.hiddenToken
      && JSON.stringify(report).includes(credential.hiddenToken)
    ) {
      throw new ConfigurationError("Onboarding evidence unexpectedly contained a credential value")
    }
  } catch (error) {
    if (!credential.hiddenToken) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ConfigurationError(redactText(message, [credential.hiddenToken]))
  } finally {
    if (hiddenCredentialVariable) {
      delete executionEnvironment[hiddenCredentialVariable]
    }
  }

  const htmlFile = parsed.htmlFile
    ? resolve(parsed.htmlFile)
    : resolveAvailableOnboardHtmlFile(configFile, dependencies.pathExists)
  progress(5, `Create the private ${onboardHostDescriptor(hostId).title} activation handoff`)
  const guide = await dependencies.exportOnboardHtml(htmlFile, report)
  let guideOpened = false
  const shouldOpenGuide = parsed.open || (interactive && await promptYesNo(
    interaction,
    "Open the private host activation guide now? [Y/n]: ",
    true,
  ))
  if (shouldOpenGuide) {
    await interaction.openExternal(pathToFileURL(guide.file).href)
    guideOpened = true
  }
  return {
    browser: { guideOpened, installOpened },
    guide,
    ...(hostDetection ? { hostDetection } : {}),
    report,
  }
}

function configSelectionEnvironment(
  file: string | undefined,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!file) return environment
  if (!file.trim() || file.includes("\0")) {
    throw new ConfigurationError("Option --config requires a valid file path")
  }
  const selected = resolve(file)
  const ambient = environment[CONFIG_FILE_ENVIRONMENT_VARIABLE]?.trim()
  if (ambient && resolve(ambient) !== selected) {
    throw new ConfigurationError(
      `Option --config conflicts with ${CONFIG_FILE_ENVIRONMENT_VARIABLE}`,
    )
  }
  return {
    ...environment,
    [CONFIG_FILE_ENVIRONMENT_VARIABLE]: selected,
  }
}

const CONFIG_SELECTION_REQUIRED_MESSAGE =
  "Operational commands require --config FILE, --profile NAME, or GUILDCONTROL_CONFIG_FILE; create a policy with guildctl config init or setup --preset"

interface RuntimeSelection {
  config: ConnectorConfig
  environment: NodeJS.ProcessEnv
}

interface DoctorSelection {
  document?: ConnectorConfigDocument
  environment: NodeJS.ProcessEnv
  selectionFailure?: unknown
}

async function runtimeSelection(
  selection: { configFile?: string; profileName?: string },
  environment: NodeJS.ProcessEnv,
  dependencies: CliDependencies,
): Promise<RuntimeSelection> {
  if (selection.profileName) {
    const activated = await dependencies.activateProfile(selection.profileName, { environment })
    return { config: activated.config, environment }
  }
  const selected = configSelectionEnvironment(selection.configFile, environment)
  if (!selected[CONFIG_FILE_ENVIRONMENT_VARIABLE]?.trim()) {
    throw new RuntimeConfigurationRequiredError(CONFIG_SELECTION_REQUIRED_MESSAGE)
  }
  return {
    config: dependencies.loadConfig(selected),
    environment: selected,
  }
}

async function doctorSelection(
  selection: { configFile?: string; profileName?: string },
  environment: NodeJS.ProcessEnv,
  dependencies: CliDependencies,
): Promise<DoctorSelection> {
  if (selection.profileName) {
    if (environment[CONFIG_FILE_ENVIRONMENT_VARIABLE]?.trim()) {
      throw new ConfigurationError(
        `Option --profile conflicts with ${CONFIG_FILE_ENVIRONMENT_VARIABLE}`,
      )
    }
    try {
      return {
        document: await dependencies.loadProfile(selection.profileName, { environment }),
        environment,
      }
    } catch (error) {
      return { environment, selectionFailure: error }
    }
  }
  const selected = configSelectionEnvironment(selection.configFile, environment)
  const file = selected[CONFIG_FILE_ENVIRONMENT_VARIABLE]?.trim()
  if (!file) throw new RuntimeConfigurationRequiredError(CONFIG_SELECTION_REQUIRED_MESSAGE)
  try {
    return {
      document: dependencies.loadConfigDocument(file),
      environment: selected,
    }
  } catch (error) {
    return { environment: selected, selectionFailure: error }
  }
}

async function selectedActivityFile(
  selection: { configFile?: string; profileName?: string },
  environment: NodeJS.ProcessEnv,
  dependencies: CliDependencies,
): Promise<string> {
  let document: ConnectorConfigDocument
  if (selection.profileName) {
    if (environment[CONFIG_FILE_ENVIRONMENT_VARIABLE]?.trim()) {
      throw new ConfigurationError(
        `Option --profile conflicts with ${CONFIG_FILE_ENVIRONMENT_VARIABLE}`,
      )
    }
    const profile = await dependencies.loadProfile(selection.profileName, { environment })
    document = profile
  } else {
    const selected = configSelectionEnvironment(selection.configFile, environment)
    const file = selected[CONFIG_FILE_ENVIRONMENT_VARIABLE]?.trim()
    if (!file) throw new RuntimeConfigurationRequiredError(CONFIG_SELECTION_REQUIRED_MESSAGE)
    document = dependencies.showConfig(file).document
  }
  return resolveConnectorConfigDocumentAuditFile(document, environment)
}

export async function runCli(options: CliOptions = {}): Promise<number> {
  const suppliedArgs = options.args || process.argv.slice(2)
  const stdin = options.stdin || process.stdin
  const args = suppliedArgs.length === 0 && Boolean(stdin.isTTY)
    ? ["onboard"]
    : suppliedArgs
  const environment = options.environment || process.env
  const stdout = options.stdout || process.stdout
  const stderr = options.stderr || process.stderr
  const dependencies = options.dependencies || DEFAULT_DEPENDENCIES
  let parsed: ParsedCliArguments | undefined
  try {
    parsed = parseCliArguments(args)
    switch (parsed.command) {
      case "activity": {
        const activityFile = await selectedActivityFile(
          parsed,
          environment,
          dependencies,
        )
        const report = await dependencies.reviewActivity(
          activityFile,
          parsed.limit,
        )
        const html = parsed.htmlFile
          ? await dependencies.exportActivityHtml(parsed.htmlFile, report)
          : undefined
        safeWrite(
          stdout,
          parsed.json
            ? jsonReport({ ...report, ...(html ? { html } : {}) })
            : [
                renderActivityReview(report),
                ...(html ? [renderActivityHtmlExport(html)] : []),
              ].join("\n\n"),
          environment,
        )
        return report.outcome === "attention"
          ? CLI_EXIT_CODES.warning
          : CLI_EXIT_CODES.success
      }
      case "catalog": {
        if (parsed.htmlFile) {
          const report = await dependencies.exportCatalogHtml(parsed.htmlFile)
          safeWrite(stdout, renderCatalogHtmlExport(report), environment)
          return CLI_EXIT_CODES.success
        }
        if (!parsed.check) {
          dependencies.catalog({ stderr })
          return CLI_EXIT_CODES.success
        }
        const report = await dependencies.checkCatalog()
        safeWrite(stdout, parsed.json ? jsonReport(report) : renderCatalog(report), environment)
        return CLI_EXIT_CODES.success
      }
      case "doctor": {
        const diagnostic = await doctorSelection(
          parsed,
          environment,
          dependencies,
        )
        const report = await dependencies.diagnose({
          ...(diagnostic.document ? { document: diagnostic.document } : {}),
          environment: diagnostic.environment,
          ...(options.nodeVersion ? { nodeVersion: options.nodeVersion } : {}),
          online: parsed.online,
          ...(diagnostic.selectionFailure === undefined
            ? {}
            : { selectionFailure: diagnostic.selectionFailure }),
        })
        safeWrite(
          stdout,
          parsed.json ? jsonReport(report) : renderDoctor(report, parsed.verbose),
          diagnostic.environment,
        )
        if (report.status === "error") return CLI_EXIT_CODES.failure
        if (report.status === "warning") return CLI_EXIT_CODES.warning
        return CLI_EXIT_CODES.success
      }
      case "config": {
        if (parsed.action === "workbench") {
          const report = await dependencies.exportConfigWorkbenchHtml(
            parsed.file,
            parsed.htmlFile,
          )
          safeWrite(
            stdout,
            parsed.json ? jsonReport(report) : renderConfigWorkbench(report),
            environment,
          )
          return CLI_EXIT_CODES.success
        }
        if (parsed.action === "plan") {
          const report = dependencies.planConfigChange({
            candidateFile: parsed.candidateFile,
            file: parsed.file,
          })
          safeWrite(
            stdout,
            parsed.json ? jsonReport(report) : renderConfigChange(report),
            environment,
          )
          return CLI_EXIT_CODES.success
        }
        if (parsed.action === "replace") {
          const mode = integratedReviewMode({
            acceptCurrentPlan: parsed.acceptCurrentPlan,
            command: "config replace",
            json: parsed.json,
            terminal: Boolean(stdin.isTTY),
          })
          const plan = dependencies.planConfigChange({
            candidateFile: parsed.candidateFile,
            file: parsed.file,
          })
          if (mode === "interactive") {
            safeWrite(stdout, renderConfigChange(plan), environment)
          }
          const confirmation = plan.status === "already-current"
            ? plan.confirmation.requiredValue
            : mode === "accepted"
              ? acceptedCurrentPlanConfirmation(
                  parsed.confirmation,
                  "config replace",
                )
              : await promptReviewedConfirmation(
                  options.interaction || DEFAULT_CLI_INTERACTION,
                  plan.confirmation.requiredValue,
                  "configuration replacement",
                )
          const report = await dependencies.applyConfigChange({
            candidateFile: parsed.candidateFile,
            confirmation,
            file: parsed.file,
            planDigest: plan.planDigest,
          })
          safeWrite(
            stdout,
            parsed.json ? jsonReport(report) : renderConfigChange(report),
            environment,
          )
          return CLI_EXIT_CODES.success
        }
        if (parsed.action === "apply") {
          const report = await dependencies.applyConfigChange({
            candidateFile: parsed.candidateFile,
            confirmation: parsed.confirmation,
            file: parsed.file,
            planDigest: parsed.planDigest,
          })
          safeWrite(
            stdout,
            parsed.json ? jsonReport(report) : renderConfigChange(report),
            environment,
          )
          return CLI_EXIT_CODES.success
        }
        if (parsed.action === "explain") {
          const report = dependencies.explainConfig(parsed.path)
          safeWrite(
            stdout,
            parsed.json ? jsonReport(report) : renderConfigExplain(report),
            environment,
          )
          return CLI_EXIT_CODES.success
        }
        if (parsed.action === "validate") {
          const report = dependencies.validateConfig(parsed.file)
          safeWrite(
            stdout,
            parsed.json ? jsonReport(report) : renderConfigValidation(report),
            environment,
          )
          return CLI_EXIT_CODES.success
        }
        if (parsed.action === "show") {
          const report = dependencies.showConfig(parsed.file)
          safeWrite(
            stdout,
            parsed.json ? jsonReport(report) : renderConfigShow(report),
            environment,
          )
          return CLI_EXIT_CODES.success
        }
        if (parsed.action !== "init") {
          throw new ConfigurationError("Unsupported config action")
        }
        const report = await dependencies.initializeConfig({
          applicationId: parsed.applicationId,
          botId: parsed.botId,
          channelIds: parsed.channelIds,
          ...(parsed.credentialFile
            ? { credentialFile: parsed.credentialFile }
            : {}),
          ...(parsed.credentialVariable
            ? { credentialVariable: parsed.credentialVariable }
            : {}),
          file: parsed.file,
          guildIds: parsed.guildIds,
          name: parsed.name,
          overwrite: parsed.overwrite,
          ...(parsed.preset ? { preset: parsed.preset } : {}),
        })
        safeWrite(
          stdout,
          parsed.json ? jsonReport(report) : renderConfigWrite(report),
          environment,
        )
        return CLI_EXIT_CODES.success
      }
      case "coordination": {
        const activityFile = await selectedActivityFile(
          parsed,
          environment,
          dependencies,
        )
        const report = parsed.action === "list"
          ? await dependencies.listCoordination(activityFile)
          : await dependencies.resolveCoordination(
            activityFile,
            parsed.claimId,
            parsed.confirmation,
          )
        safeWrite(
          stdout,
          parsed.json
            ? jsonReport(report)
            : parsed.action === "list"
              ? renderCoordinationList(report as WriteCoordinationList)
              : renderCoordinationResolution(report as WriteCoordinationResolution),
          environment,
        )
        return CLI_EXIT_CODES.success
      }
      case "help":
        safeWrite(
          stdout,
          completeHelpText(parsed.topic, parsed.action),
          {},
        )
        return CLI_EXIT_CODES.success
      case "host": {
        if (parsed.action === "detect") {
          const report = await dependencies.detectHosts({ environment })
          safeWrite(
            stdout,
            parsed.json ? jsonReport(report) : renderHostDetection(report),
            {},
          )
          return CLI_EXIT_CODES.success
        }
        const defaultLauncher = currentEntrypointLaunch(options)
        const launcher = parsed.packageLaunch
          ? publishedPackageLaunch()
          : parsed.launcherCommand
            ? { args: ["serve"], command: parsed.launcherCommand }
            : defaultLauncher
        let plan: HostActivationPlan
        if (parsed.configFile) {
          const file = resolveConnectorConfigFile(parsed.configFile)
          const document = dependencies.loadConfigDocument(file)
          const launch = createStdioLaunchDescriptor({
            applicationId: document.identity.applicationId,
            args: launcher.args,
            botId: document.identity.botId,
            command: launcher.command,
            config: { document, file },
            ...(parsed.serverName ? { serverName: parsed.serverName } : {}),
          })
          plan = createHostActivationPlan({
            document,
            launch,
            source: { file, kind: "config" },
          })
        } else {
          const name = normalizeProfileName(parsed.profileName || "")
          const profile = await dependencies.loadProfile(name, { environment })
          const launch = createStdioLaunchDescriptor({
            applicationId: profile.identity.applicationId,
            args: launcher.args,
            botId: profile.identity.botId,
            command: launcher.command,
            profile,
            ...(parsed.serverName ? { serverName: parsed.serverName } : {}),
          })
          plan = createHostActivationPlan({
            document: profile,
            launch,
            source: { kind: "profile", name: profile.name },
          })
        }
        const adapterCatalog = createHostAdapterCatalog(plan)
        if (parsed.action === "plan") {
          const report = dependencies.planHostFile(
            plan,
            parsed.adapterId,
            parsed.hostFile,
          )
          safeWrite(
            stdout,
            parsed.json ? jsonReport(report) : renderHostChangePlan(report),
            {},
          )
          return CLI_EXIT_CODES.success
        }
        if (parsed.action === "apply") {
          const report = dependencies.applyHostFile(
            plan,
            parsed.adapterId,
            parsed.hostFile,
            {
              confirmation: parsed.confirmation,
              planDigest: parsed.planDigest,
            },
          )
          safeWrite(
            stdout,
            parsed.json ? jsonReport(report) : renderHostChangeApply(report),
            {},
          )
          return CLI_EXIT_CODES.success
        }
        const inspection = parsed.inspectHostFile && parsed.adapterId
          ? dependencies.inspectHostFile(plan, parsed.adapterId, parsed.inspectHostFile)
          : undefined
        const guide = parsed.htmlFile
          ? await dependencies.exportHostActivationHtml(parsed.htmlFile, plan)
          : undefined
        safeWrite(
          stdout,
          parsed.json
            ? jsonReport({
                ...plan,
                adapterCatalog,
                ...(inspection ? { inspection } : {}),
                ...(guide ? { guide } : {}),
              })
            : [
                renderHostActivation(plan, adapterCatalog),
                ...(parsed.adapterId
                  ? [renderHostAdapter(findHostAdapter(adapterCatalog, parsed.adapterId))]
                  : []),
                ...(inspection ? [renderHostInspection(inspection)] : []),
                ...(guide ? [renderHostActivationHtmlExport(guide)] : []),
              ].join("\n\n"),
          {},
        )
        return inspection?.status === "drift"
          ? CLI_EXIT_CODES.warning
          : CLI_EXIT_CODES.success
      }
      case "migrate": {
        if (parsed.action === "list") {
          const report = dependencies.migrationCatalog()
          safeWrite(
            stdout,
            parsed.json ? jsonReport(report) : renderMigrationCatalog(report),
            {},
          )
          return CLI_EXIT_CODES.success
        }
        const report = await dependencies.migrationPlan(parsed.sourceId)
        const guide = parsed.htmlFile
          ? await dependencies.exportMigrationHtml(parsed.htmlFile, report)
          : undefined
        safeWrite(
          stdout,
          parsed.json
            ? jsonReport({ ...report, ...(guide ? { guide } : {}) })
            : [
                renderMigrationPlan(report),
                ...(guide ? [renderMigrationHtmlExport(guide)] : []),
              ].join("\n\n"),
          {},
        )
        return CLI_EXIT_CODES.success
      }
      case "onboard": {
        const result = await executeOnboard(
          parsed,
          options,
          dependencies,
          environment,
        )
        safeWrite(
          stdout,
          parsed.json
            ? jsonReport({
                ...result.report,
                browser: result.browser,
                guide: result.guide,
                ...(result.hostDetection
                  ? { hostDetection: result.hostDetection }
                  : {}),
              })
            : renderOnboard(
                result.report,
                result.guide,
                result.browser,
                result.hostDetection,
              ),
          environment,
        )
        return CLI_EXIT_CODES.success
      }
      case "profile": {
        const location = { environment }
        if (parsed.action === "list") {
          const profiles = await dependencies.listProfiles(location)
          const report: ProfileListReport = {
            profiles: profiles.map(profileSummary),
            schemaVersion: OPERATOR_REPORT_SCHEMA_VERSION,
            status: "ok",
          }
          safeWrite(
            stdout,
            parsed.json ? jsonReport(report) : renderProfileList(report),
            environment,
          )
          return CLI_EXIT_CODES.success
        }
        const name = normalizeProfileName(parsed.name)
        if (parsed.action === "show") {
          const profile = await dependencies.loadProfile(name, location)
          const report: ProfileShowReport = {
            profile,
            schemaVersion: OPERATOR_REPORT_SCHEMA_VERSION,
            status: "ok",
          }
          safeWrite(
            stdout,
            parsed.json ? jsonReport(report) : renderProfileShow(report),
            environment,
          )
          return CLI_EXIT_CODES.success
        }
        if (parsed.confirmation !== name) {
          throw new ConfigurationError(
            `Confirmation must exactly match profile ${name}`,
          )
        }
        if (parsed.action === "remove") {
          await dependencies.trashProfile(name, location)
        } else {
          await dependencies.restoreProfile(name, location)
        }
        const report: ProfileActionReport = {
          action: parsed.action,
          credentialUnaffected: true,
          name,
          ...(parsed.action === "remove" ? { recoverable: true as const } : {}),
          schemaVersion: OPERATOR_REPORT_SCHEMA_VERSION,
          status: "ok",
        }
        safeWrite(
          stdout,
          parsed.json ? jsonReport(report) : renderProfileAction(report),
          environment,
        )
        return CLI_EXIT_CODES.success
      }
      case "preset": {
        if (parsed.action === "install") {
          const report = createBotInstallPlan({
            applicationId: parsed.applicationId,
            guildId: parsed.guildId,
            preset: parsed.name,
          })
          const guide = parsed.htmlFile
            ? await dependencies.exportOnboardingHtml(parsed.htmlFile, report)
            : undefined
          safeWrite(
            stdout,
            parsed.json
              ? jsonReport({ ...report, ...(guide ? { guide } : {}) })
              : [
                  renderBotInstallPlan(report),
                  ...(guide ? [renderOnboardingHtmlExport(guide)] : []),
                ].join("\n\n"),
            environment,
          )
          return CLI_EXIT_CODES.success
        }
        if (parsed.action === "list") {
          const report: PresetListReport = {
            presets: SETUP_PRESETS,
            schemaVersion: OPERATOR_REPORT_SCHEMA_VERSION,
            status: "ok",
          }
          safeWrite(
            stdout,
            parsed.json ? jsonReport(report) : renderPresetList(report),
            environment,
          )
          return CLI_EXIT_CODES.success
        }
        const report: PresetShowReport = {
          preset: getSetupPreset(parsed.name),
          schemaVersion: OPERATOR_REPORT_SCHEMA_VERSION,
          status: "ok",
        }
        safeWrite(
          stdout,
          parsed.json ? jsonReport(report) : renderPreset(report.preset),
          environment,
        )
        return CLI_EXIT_CODES.success
      }
      case "recipe": {
        if (parsed.action === "list") {
          const report: RecipeListReport = {
            recipes: CONFIG_RECIPES,
            schemaVersion: CONFIG_RECIPE_REPORT_SCHEMA_VERSION,
            status: "ok",
          }
          safeWrite(
            stdout,
            parsed.json ? jsonReport(report) : renderRecipeList(report),
            environment,
          )
          return CLI_EXIT_CODES.success
        }
        if (parsed.action === "show") {
          const report: RecipeShowReport = {
            recipe: getConfigRecipe(parsed.name),
            schemaVersion: CONFIG_RECIPE_REPORT_SCHEMA_VERSION,
            status: "ok",
          }
          safeWrite(
            stdout,
            parsed.json ? jsonReport(report) : renderRecipe(report.recipe),
            environment,
          )
          return CLI_EXIT_CODES.success
        }
        const selection = {
          channelIds: parsed.channelIds,
          file: parsed.file,
          guildIds: parsed.guildIds,
          name: parsed.name,
          userIds: parsed.userIds,
        }
        if (parsed.action === "enable") {
          const mode = integratedReviewMode({
            acceptCurrentPlan: parsed.acceptCurrentPlan,
            command: "recipe enable",
            json: parsed.json,
            terminal: Boolean(stdin.isTTY),
          })
          const plan = dependencies.planRecipe(selection)
          if (mode === "interactive") {
            safeWrite(stdout, renderRecipePlan(plan), environment)
          }
          const confirmation = plan.status === "already-current"
            ? plan.confirmation.requiredValue
            : mode === "accepted"
              ? acceptedCurrentPlanConfirmation(
                  parsed.confirmation,
                  "recipe enable",
                )
              : await promptReviewedConfirmation(
                  options.interaction || DEFAULT_CLI_INTERACTION,
                  plan.confirmation.requiredValue,
                  "recipe enablement",
                )
          const report = await dependencies.applyRecipe({
            ...selection,
            confirmation,
            planDigest: plan.planDigest,
          })
          safeWrite(
            stdout,
            parsed.json ? jsonReport(report) : renderRecipePlan(report),
            environment,
          )
          return CLI_EXIT_CODES.success
        }
        const report = parsed.action === "plan"
          ? dependencies.planRecipe(selection)
          : await dependencies.applyRecipe({
              ...selection,
              confirmation: parsed.confirmation,
              planDigest: parsed.planDigest,
            })
        safeWrite(
          stdout,
          parsed.json ? jsonReport(report) : renderRecipePlan(report),
          environment,
        )
        return CLI_EXIT_CODES.success
      }
      case "serve":
        const runtime = await runtimeSelection(parsed, environment, dependencies)
        dependencies.serve({
          exitOnShutdown: true,
          config: runtime.config,
          environment: runtime.environment,
          stderr,
        })
        return CLI_EXIT_CODES.success
      case "setup": {
        const defaultLauncher = currentEntrypointLaunch(options)
        const launcher = parsed.packageLaunch
          ? publishedPackageLaunch()
          : parsed.launcherCommand
            ? { args: ["serve"], command: parsed.launcherCommand }
            : defaultLauncher
        const report = await dependencies.prepareSetup({
          args: launcher.args,
          command: launcher.command,
          ...(parsed.configFile
            ? {
                configFile: parsed.configFile,
                overwriteConfig: parsed.overwrite,
              }
            : { overwriteProfile: parsed.overwrite }),
          ...(parsed.credentialVariable
            ? { credentialVariable: parsed.credentialVariable }
            : {}),
          ...(parsed.credentialFile
            ? { credentialFile: parsed.credentialFile }
            : {}),
          environment,
          ...(parsed.preset ? { preset: parsed.preset } : {}),
          ...(parsed.profileName ? { profileName: parsed.profileName } : {}),
          ...(parsed.serverName ? { serverName: parsed.serverName } : {}),
        })
        safeWrite(stdout, parsed.json ? jsonReport(report) : renderSetup(report), environment)
        return CLI_EXIT_CODES.success
      }
      case "smoke": {
        const runtime = await runtimeSelection(
          parsed,
          environment,
          dependencies,
        )
        const launch = currentEntrypointLaunch(options)
        if (parsed.configFile) {
          const configFile = runtime.environment[CONFIG_FILE_ENVIRONMENT_VARIABLE]
          if (!configFile) {
            throw new RuntimeConfigurationRequiredError(
              CONFIG_SELECTION_REQUIRED_MESSAGE,
            )
          }
          launch.args.push("--config", configFile)
        }
        if (parsed.profileName) {
          launch.args.push("--profile", parsed.profileName)
        }
        const report = await dependencies.smoke({
          config: runtime.config,
          environment: runtime.environment,
          launch,
        })
        safeWrite(
          stdout,
          parsed.json ? jsonReport(report) : renderSmoke(report),
          runtime.environment,
        )
        return CLI_EXIT_CODES.success
      }
      case "version":
        safeWrite(stdout, CONNECTOR_VERSION, environment)
        return CLI_EXIT_CODES.success
    }
  } catch (error) {
    if (error instanceof CliInteractionCancelledError) {
      safeWrite(
        stderr,
        `${CONNECTOR_CLI_COMMAND}: ${parsed?.command || "command"} canceled`,
        {},
      )
      return CLI_EXIT_CODES.canceled
    }
    const helpTopic = args[0] && isCommand(args[0]) ? args[0] : undefined
    const context = {
      ...(helpTopic ? { helpTopic } : {}),
      usage: parsed === undefined,
    }
    const guidance = classifyCliFailure(error, context)
    const message = safeCliFailureMessage(error, context)
    const outputEnvironment = args[0] === "host" ? {} : environment
    if (requestsJson(args, parsed)) {
      safeWrite(stdout, jsonReport(cliErrorReport(message, guidance)), outputEnvironment)
    } else {
      safeWrite(stderr, renderCliFailure(message, guidance), outputEnvironment)
    }
    return failureExitCode(parsed)
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runCli()
}
