# Support

GuildControl MCP is self-hosted local stdio software. Its maintainers do not operate a shared bot, receive or store operator tokens, access operator guilds, monitor live Discord incidents, or provide emergency moderation. Check [product boundaries and host compatibility](docs/limitations.md) and the [privacy policy](PRIVACY.md) before filing a setup issue or enabling a write capability.

## Start with offline evidence

Follow the [first verified read and recovery guide](docs/getting-started.md), then search existing issues. Use the [complete reference](docs/reference.md) when the problem involves a specific policy or workflow. Prefer credential-free checks before opening a report:

```sh
guildctl config validate FILE
guildctl doctor --config FILE
guildctl catalog --check --json
```

When switching from another Discord MCP, run `guildctl migrate list`, select the exact `product@version` source, and generate `guildctl migrate plan SOURCE --html PRIVATE_FILE`. The [migration guide](docs/migration.md) explains every disposition and the staged verification path. The planner does not scan the old deployment or import its configuration, credentials, prompts, arguments, or host settings. If a source is absent, report its public release and evidence URL through a feature proposal rather than substituting the nearest listed version.

If MCPB import fails before startup, confirm that the host supports manifest version 0.3, Node.js 22.15 through 26, local file selection, and sensitive string input. Keep the token out of the selected config. A file-backed credential policy is intentionally incompatible with the bundle's prompted secret; preserve that policy and use the adapter path.

If an MCP host reports that the connection closed during initialization, run `guildctl host --npx --config FILE --html PRIVATE_FILE` and choose the guide's common MCP JSON, Cursor, VS Code, or Gemini CLI projection. For a supported static JSON destination, run `guildctl host plan --npx --config FILE --adapter ID --host-file HOST_JSON_FILE`, review the path- and value-free summary, then run the matching `host apply` with its exact plan digest and server-name confirmation; apply preserves unrelated shared entries, retains a recoverable backup, rereads exactly, and rolls back on failed verification. Run `guildctl host --npx --config FILE --adapter ID --inspect-host-file HOST_JSON_FILE` afterward. Status 1 identifies only fixed drift categories and returns no observed value, raw content, unrelated entry, or host path; replan and repair, reload the host, and require status 0. Do not attach the guide, adapter JSON, Cursor install URI, host file, or backup to an issue because they contain Discord identifiers, may contain local paths, and may contain credentials. `dist/index.js` is the package library entrypoint and does not run a server; direct execution fails with a fixed correction instead of closing silently. An operational source checkout must run `node dist/bin.js serve --config FILE`, while a pinned published launch uses `npx --yes guildctl@VERSION serve --config FILE`. Then run `guildctl smoke --config FILE` outside the host to verify the same spawned stdio path without sharing a token or raw diagnostic output. The [ordered recovery ladder](docs/getting-started.md#recovery-ladder) separates policy, credential, Discord, stdio, and host failures.

Run `doctor --online` or another live probe only with a bot and guild you control and only when its documented Discord reads are acceptable. Do not publish raw probe output.

If online doctor reports `guild-installation-drift`, review the exact IDs privately in Discord and the selected policy. A missing configured guild means the pinned bot is not installed there; an unexpected guild means the same bot is installed outside local read scope, not that the connector can act there. Remove an unintended installation through Discord, or add an intended guild to policy only through ordinary scope review, then rerun the audit after membership changes settle. Do not post the private IDs in an issue.

## Choose a route

- Use the operator-question form for setup, policy, Discord permission or intent, MCP host, migration-plan interpretation, blocked cutover, diagnostic, recovery, package, or container questions
- Use the bug form for a reproducible product defect with a minimal synthetic reproduction
- Use the feature-proposal form for a new capability or authority boundary
- Use the verified-outcome form after a successful or blocked journey to share coarse setup time, first friction, repeat-use intent, and next-workflow demand without posting Discord evidence
- Use a [private GitHub Security Advisory](https://github.com/j-256/guildcontrol/security/advisories/new) for an undisclosed vulnerability, following [SECURITY.md](SECURITY.md)

## Share only privacy-safe evidence

Useful public evidence includes the exact package version or image tag, installation method, Node.js major version, operating-system family, architecture, MCP host family, public preset or recipe name, toolset or command name, fixed error code or category, sanitized counts, and an offline check's pass, warning, or failure state.

Never post a bot token, webhook credential, invite or template code, collector header, configuration file, secret-variable value, local path, raw log, raw Discord payload, message content, attachment URL, embed, component, audit-log reason, username, profile name, role name, channel name, topic, avatar, screenshot, recording, or private guild, channel, user, message, application, or webhook identifier. Replace paths and IDs with obvious synthetic values. Rotate any credential that may have been exposed.

## Support boundaries

Community support is best effort and has no response-time guarantee. Maintainers cannot administer an operator's Discord account, application, bot, guild, MCP host, or secret store. The connector's privacy guarantees do not govern retention by Discord, an MCP host, a model provider, the operating system, terminal capture, or operator-created infrastructure. For an active safety incident, use Discord's own moderation, account-security, and support controls first; a public project issue is not an incident-response channel.
