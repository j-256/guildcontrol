export const MCPB_ARCHIVE_ENTRIES: readonly string[]

export interface McpbPackageMetadata {
  description: string
  homepage: string
  license: string
  name: string
  version: string
}

export function mcpbArchiveName(version: string): string

export function verifyMcpbStderr(stderr: string, nodeMajor: number): void

export function validateMcpbManifest(
  document: unknown,
  packageJson: McpbPackageMetadata,
): Promise<unknown>

export interface McpbBuildOptions {
  catalogEvidencePath?: string
  outputDirectory?: string
}

export interface McpbBuildReport {
  bytes: number
  digest: string
  entries: readonly string[]
  name: string
  outputPath?: string
}

export function buildAndVerifyMcpb(
  options?: McpbBuildOptions,
): Promise<McpbBuildReport>
