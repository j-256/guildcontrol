import assert from "node:assert/strict"
import test from "node:test"

import { dockerClientEnvironment } from "../scripts/docker-environment.mjs"

test("container MCP verification preserves the selected Docker connection without ambient credentials", () => {
  const environment = dockerClientEnvironment({
    HOME: "/fixture/home",
    PATH: "/fixture/bin",
    DOCKER_CONTEXT: "fixture-context",
    DOCKER_HOST: "unix:///fixture/docker.sock",
    DOCKER_CONFIG: "/fixture/docker-config",
    DOCKER_CERT_PATH: "/fixture/certificates",
    DOCKER_TLS: "true",
    DOCKER_TLS_VERIFY: "1",
    DOCKER_API_VERSION: "1.48",
    SSH_AUTH_SOCK: "/fixture/ssh.sock",
    DISCORD_BOT_TOKEN: "fixture-token",
    NPM_TOKEN: "fixture-npm-token",
    NODE_OPTIONS: "--require=/fixture/untrusted.cjs",
  })
  assert.deepEqual(environment, {
    HOME: "/fixture/home",
    PATH: "/fixture/bin",
    DOCKER_CONTEXT: "fixture-context",
    DOCKER_HOST: "unix:///fixture/docker.sock",
    DOCKER_CONFIG: "/fixture/docker-config",
    DOCKER_CERT_PATH: "/fixture/certificates",
    DOCKER_TLS: "true",
    DOCKER_TLS_VERIFY: "1",
    DOCKER_API_VERSION: "1.48",
    SSH_AUTH_SOCK: "/fixture/ssh.sock",
  })
})

test("container MCP verification keeps safe defaults without inventing a Docker connection", () => {
  assert.deepEqual(dockerClientEnvironment({}), {
    HOME: "",
    PATH: "/usr/bin:/bin",
  })
})
