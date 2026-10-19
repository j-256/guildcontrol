import { readFileSync } from "node:fs"

const packageJson = JSON.parse(readFileSync("package.json", "utf8"))
const server = JSON.parse(readFileSync("server.json", "utf8"))
const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
AbortSignal.timeout = (duration) => originalTimeout(Math.max(1, Math.round(duration / 1_000)))

const jsonResponse = (value) => new Response(JSON.stringify(value), {
  headers: { "content-type": "application/json" },
})

globalThis.fetch = async (input, options) => {
  const url = new URL(input)
  if (url.origin === "https://registry.npmjs.org" && url.pathname === `/${packageJson.name}`) {
    return jsonResponse({
      name: packageJson.name,
      "dist-tags": { latest: "2.3.1" },
      versions: { "2.3.1": { mcpName: packageJson.mcpName, repository: packageJson.repository } },
    })
  }
  if (url.origin === "https://registry.npmjs.org" && url.pathname === `/${packageJson.name}/${packageJson.version}`) {
    return new Response(null, { status: 404 })
  }
  if (url.origin === "https://registry.modelcontextprotocol.io"
    && url.pathname === `/v0.1/servers/${encodeURIComponent(server.name)}/versions/${server.version}`) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(null, { status: 404 })), Number(process.env.TEST_REGISTRY_DELAY_MS))
      options.signal.addEventListener("abort", () => {
        clearTimeout(timer)
        reject(options.signal.reason)
      }, { once: true })
    })
  }
  throw new Error(`Unexpected release lookup ${url.origin}${url.pathname}`)
}
