#!/usr/bin/env node

import process from "node:process"
import { fileURLToPath } from "node:url"

import { isMainModule } from "./entrypoint.js"
import { resolveNodeRuntime } from "./node-runtime.js"

type ProcessReplacement = (
  file: string,
  args?: readonly string[],
  environment?: NodeJS.ProcessEnv,
) => never

export interface GuildControlBinOptions {
  readonly argv?: readonly string[]
  readonly cliEntrypoint?: string
  readonly execArgv?: readonly string[]
  readonly execPath?: string
  readonly execve?: ProcessReplacement | null
  readonly nodeVersion?: string
  readonly runCli?: (args: readonly string[]) => Promise<number>
}

export async function runGuildControlBin(
  options: GuildControlBinOptions = {},
): Promise<number> {
  const execve = options.execve === undefined
    ? process.execve
    : options.execve || undefined
  const resolution = resolveNodeRuntime({
    argv: options.argv ?? process.argv,
    cliEntrypoint: options.cliEntrypoint
      ?? fileURLToPath(new URL("./cli.js", import.meta.url)),
    execArgv: options.execArgv ?? process.execArgv,
    execPath: options.execPath ?? process.execPath,
    nodeVersion: options.nodeVersion ?? process.versions.node,
    processReplacementAvailable: typeof execve === "function",
  })
  if (resolution.replacement && execve) {
    execve(resolution.replacement.file, resolution.replacement.args, process.env)
  }
  const runCli = options.runCli ?? (async (args: readonly string[]) => {
    const { runCli: run } = await import("./cli.js")
    return run({ args })
  })
  return runCli(resolution.cliArguments)
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runGuildControlBin()
}
