export interface VersionPreparationOptions {
  sourceDate: string
  summaryPath: string
  version: string
}

export interface ReleaseSummary {
  highlights: string[]
  paragraphs: string[]
  version: string
}

export function compareVersions(left: string, right: string): number
export function parseArguments(arguments_: string[]): VersionPreparationOptions
export function sourceDateEpoch(value: string): number
export function validateReleaseSummary(summary: unknown, version: string): ReleaseSummary
export function validateVersionFrontier(actual: string[], includesReleaseSummary: boolean): void
