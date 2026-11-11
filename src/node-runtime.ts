export const LOW_MEMORY_NODE_ARGUMENTS = Object.freeze([
  "--optimize-for-size",
] as const)

const FIRST_LOW_MEMORY_NODE_MAJOR = 22
const LAST_VERIFIED_LOW_MEMORY_NODE_MAJOR = 26
const STANDARD_NODE_ARGUMENTS = Object.freeze([] as const)

export const STANDARD_RUNTIME_ARGUMENT = "--standard-runtime"
export type NodeRuntimeProfile = "low-memory" | "standard"

export interface NodeRuntimeResolution {
  readonly cliArguments: readonly string[]
  readonly profile: NodeRuntimeProfile
  readonly replacement?: {
    readonly args: readonly string[]
    readonly file: string
  }
}

export interface ResolveNodeRuntimeOptions {
  readonly argv: readonly string[]
  readonly cliEntrypoint: string
  readonly execArgv: readonly string[]
  readonly execPath: string
  readonly nodeVersion: string
  readonly processReplacementAvailable: boolean
}

export function lowMemoryNodeArguments(
  nodeVersion: string,
): readonly string[] {
  const major = Number.parseInt(nodeVersion.split(".", 1)[0] || "", 10)
  if (
    major >= FIRST_LOW_MEMORY_NODE_MAJOR
    && major <= LAST_VERIFIED_LOW_MEMORY_NODE_MAJOR
  ) {
    return LOW_MEMORY_NODE_ARGUMENTS
  }
  return STANDARD_NODE_ARGUMENTS
}

function booleanFlagState(
  args: readonly string[],
  name: string,
): boolean | undefined {
  let state: boolean | undefined
  for (const argument of args) {
    const [rawName = "", rawValue] = argument.split("=", 2)
    const normalized = rawName.replaceAll("_", "-")
    if (normalized === `--${name}`) {
      state = rawValue === undefined || rawValue === "true"
        ? true
        : rawValue === "false"
          ? false
          : state
    } else if (normalized === `--no-${name}` && rawValue === undefined) {
      state = false
    }
  }
  return state
}

export function isLowMemoryNodeRuntime(
  execArgv: readonly string[],
): boolean {
  return booleanFlagState(execArgv, "optimize-for-size") === true
}

export function resolveNodeRuntime(
  options: ResolveNodeRuntimeOptions,
): NodeRuntimeResolution {
  const suppliedCliArguments = options.argv.slice(2)
  const launcherStandardRequested = suppliedCliArguments[0]
    === STANDARD_RUNTIME_ARGUMENT
  const cliArguments = launcherStandardRequested
    ? suppliedCliArguments.slice(1)
    : suppliedCliArguments
  const standardRequested = launcherStandardRequested
    || booleanFlagState(options.execArgv, "optimize-for-size") === false
    || booleanFlagState(options.execArgv, "lite-mode") === false
    || booleanFlagState(options.execArgv, "expose-wasm") === true
  if (standardRequested) {
    return Object.freeze({
      cliArguments: Object.freeze(cliArguments),
      profile: "standard" as const,
    })
  }
  if (isLowMemoryNodeRuntime(options.execArgv)) {
    return Object.freeze({
      cliArguments: Object.freeze(cliArguments),
      profile: "low-memory" as const,
    })
  }
  const lowMemoryArguments = lowMemoryNodeArguments(options.nodeVersion)
  if (
    !options.processReplacementAvailable
    || lowMemoryArguments.length === 0
  ) {
    return Object.freeze({
      cliArguments: Object.freeze(cliArguments),
      profile: "standard" as const,
    })
  }
  const nodeArguments = [...options.execArgv]
  for (const argument of lowMemoryArguments) {
    if (
      argument === "--optimize-for-size"
      && booleanFlagState(nodeArguments, "optimize-for-size") !== true
    ) {
      nodeArguments.push(argument)
    }
  }
  return Object.freeze({
    cliArguments: Object.freeze(cliArguments),
    profile: "low-memory" as const,
    replacement: Object.freeze({
      args: Object.freeze([
        options.execPath,
        ...nodeArguments,
        options.cliEntrypoint,
        ...cliArguments,
      ]),
      file: options.execPath,
    }),
  })
}
