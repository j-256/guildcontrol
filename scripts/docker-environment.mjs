const DOCKER_CONNECTION_VARIABLES = Object.freeze([
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_API_VERSION",
  "SSH_AUTH_SOCK",
])

export function dockerClientEnvironment(environment = process.env) {
  return {
    HOME: environment.HOME || "",
    PATH: environment.PATH || "/usr/bin:/bin",
    ...Object.fromEntries(DOCKER_CONNECTION_VARIABLES
      .filter((name) => environment[name] !== undefined)
      .map((name) => [name, environment[name]])),
  }
}
