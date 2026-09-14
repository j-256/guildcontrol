import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = join(root, 'docs/screenshots/cover.png')
const args = process.argv.slice(2)
if (args.includes('-h') || args.includes('--help')) {
  console.log('Usage: node site/scripts/capture-cover.mjs\n\nBuild GuildControl and capture its credential-free MCP Contract Explorer.\nWrites docs/screenshots/cover.png. Requires Node 22+, npm run deps:locked in\nthe root and site directories, and npm --prefix site run browser:install.\nNo Discord credentials or network access are used by the capture.\nExit status: 0 success, 1 capture failure, 2 usage error, 3 missing dependency.')
  process.exit(0)
}
if (args.length) {
  console.error('capture-cover: unexpected argument; see --help')
  process.exit(2)
}
const { chromium } = await import('playwright').catch((error) => {
  console.error(`capture-cover: install site dependencies first: ${error.message}`)
  process.exit(3)
})
const temporary = await mkdtemp(join(tmpdir(), 'guildcontrol-cover-'))
let browser
try {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit', timeout: 120_000 })
  const catalog = join(temporary, 'catalog.html')
  execFileSync(process.execPath, ['dist/bin.js', 'catalog', '--html', catalog], { cwd: root, stdio: 'inherit', timeout: 60_000 })
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route(/^https?:/, (route) => route.abort())
  await page.goto(pathToFileURL(catalog).href)
  await page.getByRole('heading', { name: /MCP Contract Explorer/ }).waitFor()
  await page.evaluate(() => document.fonts.ready)
  if (errors.length) throw new Error(errors.join('\n'))
  await mkdir(join(root, 'docs/screenshots'), { recursive: true })
  const staged = join(root, 'docs/screenshots/cover.tmp.png')
  await writeFile(staged, await page.screenshot({ animations: 'disabled' }))
  await rename(staged, output)
  console.log(`Captured MCP Contract Explorer: ${output}`)
} catch (error) {
  console.error(`capture-cover: ${error.stack ?? error}`)
  process.exitCode = /Executable doesn't exist|MODULE_NOT_FOUND/.test(error.message) ? 3 : 1
} finally {
  await browser?.close()
  await rm(temporary, { recursive: true, force: true })
  await rm(join(root, 'docs/screenshots/cover.tmp.png'), { force: true })
}
