# Release runbook

GuildControl MCP uses two normal operator phases: protected staged npm publication, followed by protected promotion through immutable OCI publication, an immutable GitHub Release, and MCP Registry registration. A credential-free first-publication candidate and a narrowly bounded GitHub Release recovery operation remain available outside the normal path. No operation contacts Discord or needs a Discord bot token.

## Public-source preflight

Changing the repository from private to public exposes its reachable Git history and Actions history, permits public forks, publishes repository activity, and disables existing push rulesets. Treat the change as an irreversible disclosure even though GitHub permits a later visibility change.

Before changing visibility:

1. Create a mirror clone of the exact private remote outside the working repository. Enumerate every advertised ref, run strict Git object verification, and retain the mirror until the public transition and protections are verified.
2. Run a reviewed credential scanner in full-redaction mode across every reachable commit, the selected current tree, every retained Actions log, and every retained artifact including nested archives. Classify every candidate from rule, path, and redacted context without printing the matched value. Rotate any real credential before proceeding.
3. Inspect commit author metadata, historical filenames, repository issues, pull requests, releases, deployments, Actions variables and secret names, environments, and public-facing repository metadata. Confirm that no private identity, path, discussion, artifact, or log should remain hidden.
4. Scan the current tree and every retained package for machine-local paths and model-, vendor-, client-, or harness-specific branding. Decide explicitly whether transparent historical references are acceptable. A zero-history-reference policy requires a separately authorized history rewrite with an external mirror backup and credential rotation where applicable.
5. Run the complete release metadata, test, coverage, build, package, dependency, and container gates on the exact commit intended for public exposure. Require the remote CI gate to pass as well.
6. Confirm that `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`, privacy-safe issue forms including operator questions and verified outcomes, the pull-request template, `SECURITY.md`, CODEOWNERS, and the release runbook are present and protected.

## Repository prerequisites

Before any publication:

1. Make `j-256/guildcontrol` public. npm provenance and public GitHub attestations fail for a private source repository, and the workflow enforces this boundary.
2. Set the repository description exactly to `Safety-first MCP server for Discord with privacy-safe reads, audits, and reviewed administration`. Replace its topics with the exact model- and harness-neutral topic set `ai-agents`, `automation`, `community-management`, `discord`, `discord-api`, `discord-bot`, `guildcontrol`, `least-privilege`, `mcp`, `mcp-server`, `model-context-protocol`, `moderation`, `security`, and `typescript`. Keep Issues enabled. Leave Discussions, Projects, and the wiki disabled until each has an owned maintenance purpose. Topic names are public even for a private repository, so apply this profile only after the visibility decision.
3. Create or re-enable protection for `main` after the visibility change and require the `CI gate` and CodeQL checks. Require CODEOWNERS review for workflows, package metadata, registry metadata, release scripts, security policy, and community files.
4. Require the canonical documentation portal at `https://docs.guildcontrol.lasers.app` to match the release commit under `node scripts/check-public-documentation.mjs`, and require its `Publish documentation portal` deployment to be green. Keep one-time hosting provisioning, credential rotation, domain cutover, rollback, and retirement procedures in the separate [documentation portal operations guide](documentation-portal.md).
5. Enable private vulnerability reporting and its maintainer notifications. Enable and verify Dependabot alerts, secret scanning, push protection, and code scanning; a skipped private-repository CodeQL run is not public-release evidence.
6. Create a repository ruleset that restricts creation of `v*` tags to the repository owner and prevents every update or deletion. Enable repository-level immutable Releases before publishing any GitHub Release. Create a GitHub Actions environment named `release`, require a human reviewer, prevent self-review when the repository plan supports it, allow deployments only from protected `v*` tags, and do not allow administrators to bypass the review gate.
7. Create a GitHub Actions environment named `release-credentials` with no reviewer, allow deployments only from protected `v*` tags, and add only the `MCP_REGISTRY_DNS_PRIVATE_KEY` environment secret. This environment is an unattended credential boundary behind the separately reviewed promotion dependency, not an approval gate. Do not use a repository secret for the Registry key.
8. Enable two-factor authentication on the npm maintainer account.
9. Confirm that the unscoped npm name `guildctl` is either available for the first publication or already owned by the `j-256` maintainer account for later releases.
10. Install npm 11.15 or newer for human `npm stage` review commands. The workflow uses a fixed Node.js release whose bundled npm satisfies this floor.
11. Confirm that the repository owner can administer the `guildcontrol` container package under `j-256`. The first image version is created by the protected workflow and requires one explicit visibility review before it can be made public.

Candidate, stage, and promote operations must be dispatched at the same tag supplied as their input. This makes GitHub and npm provenance identify the commit that produced the package rather than the default branch's dispatch commit. These operations accept only an existing stable `vMAJOR.MINOR.PATCH` tag that points at the checked-out commit and is an ancestor of `origin/main`. Package metadata, the lockfile, source constants, `server.json`, and the immutable icon URL must all contain the same version. Every ordinary release operation also requires the canonical public documentation manifest to contain that version and exact hashes for the release's documentation source frontier. The narrowly bounded publisher recovery operation described below is the only exception: it executes corrected workflow code from a separate protected audit tag while checking out and verifying the unchanged stable source tag and previously attested evidence.

## Registry DNS credential bootstrap and rotation

The canonical MCP Registry name is `app.lasers.guildcontrol/discord`. MCP Registry DNS authentication reverses the verified domain, so the proof at `guildcontrol.lasers.app` grants only `app.lasers.guildcontrol/*` and descendant namespaces. Do not move the proof to `lasers.app`: an apex proof would grant the much broader `app.lasers/*` organization namespace.

Generate one Ed25519 key with OpenSSL 3, retain the 32-byte private seed as exactly 64 lowercase hexadecimal characters in a protected private credential store, and publish only the derived public key. The DNS record at exactly `guildcontrol.lasers.app` has this shape:

```text
v=MCPv1; k=ed25519; p=BASE64_PUBLIC_KEY
```

The proof belongs at the product hostname itself, not `_mcp-auth.guildcontrol.lasers.app` or another selector. Keep exactly one MCP proof record at that name. The Registry's verifier may try a stale record first, so overlapping old and new proofs can make authentication fail even when one key is valid.

Create the credential environment and load the raw seed without placing it in shell arguments or logs:

```sh
gh api --method PUT repos/j-256/guildcontrol/environments/release-credentials \
  -F 'deployment_branch_policy[custom_branch_policies]=true' \
  -F 'deployment_branch_policy[protected_branches]=false'
gh api --method POST repos/j-256/guildcontrol/environments/release-credentials/deployment-branch-policies \
  -f name='v*' \
  -f type=tag
tr -d '\r\n' < PRIVATE_KEY_FILE |
  gh secret set MCP_REGISTRY_DNS_PRIVATE_KEY \
    --repo j-256/guildcontrol \
    --env release-credentials
```

Verify through the GitHub API that the environment has no reviewers, its only deployment policy is the `v*` tag pattern, and its only secret name is `MCP_REGISTRY_DNS_PRIVATE_KEY`. Verify public DNS independently with `dig +short TXT guildcontrol.lasers.app`. Never print the private file, command-substitute it into a logged command, upload it as workflow evidence, or put it in the public repository.

For ordinary restoration after loss of the GitHub secret, reload the retained seed over stdin and verify the environment metadata. For suspected compromise or loss of every seed copy, generate a new key, replace the DNS TXT value without overlap, wait for public resolvers to return only the new proof, replace the Actions secret over stdin, and run a Registry login and exact no-op verification. Domain control is the root of trust, so loss of the seed does not lose the namespace. A copied seed can authenticate until cached DNS proof expires; inspect Registry versions created during that interval and report any unauthorized entry.

### Approval and credential risk

The `release` environment remains the human decision boundary. Stage and promotion are separate workflow runs, so approving npm cannot authorize later public channels. Within promotion, the approval job has no repository permission; OCI, GitHub Release, and Registry jobs depend on it while retaining separate least-privilege tokens. Combining those publishers into one job would reduce YAML but would give every step the union of package, repository, attestation, and Registry authority.

The `release-credentials` environment deliberately has no reviewer. Adding one would make the dependency-chained Registry job ask for a second promotion approval after the operator already approved the exact preflight. Its residual risk is that workflow code on an allowed tag can request the seed. The `v*` ruleset therefore restricts tag creation to the repository owner and prevents tag movement or deletion, while protected `main` review governs the workflow code that can be tagged. A repository administrator can still weaken those controls; suspected administrative bypass requires DNS key rotation and an audit of environment, ruleset, workflow, and Registry changes.

The seed is stored directly rather than behind a hosted KMS because this one credential grants only the product namespace and DNS provides a simple rotation root. A hosted KMS would remove the raw seed from Actions but add another provider, workload identity, policy surface, billing dependency, and outage mode. Reconsider that tradeoff if more products share a key, more maintainers can trigger release workflows, or Registry publication becomes frequent enough to justify operating an external signer.

## First npm publication

npm requires a package to exist before staged or trusted publishing can be configured. Do not bridge that boundary with a token that bypasses two-factor authentication. The first version uses a credential-free protected workflow to produce an attested candidate, followed by an interactive maintainer publication:

1. Create and push the exact release tag after its commit has passed CI on `main`.
2. Dispatch `release.yml` at that tag with operation `candidate` and the same exact tag as input:

```sh
gh workflow run release.yml --ref vMAJOR.MINOR.PATCH -f operation=candidate -f tag=vMAJOR.MINOR.PATCH
```

3. Confirm that the ungated candidate job completed for the exact tag and source commit with an absent npm package, OCI tag, and MCP Registry version. The candidate receives no npm, package, repository-write, or Registry credential, so evidence generation does not consume an operator approval. It verifies source and supply-chain state, reconstructs the npm archive and MCPB twice, verifies their installed behavior, signs both artifacts, their SPDX SBOMs, and catalog evidence with GitHub artifact attestations, and retains the exact files.
4. Download the completed workflow artifact, inspect its npm archive, MCPB, catalog evidence, dependency notices, privacy policy, and SBOMs, and verify the artifact attestations before publication:

```sh
gh run download RUN_ID --name release-evidence-candidate-vMAJOR.MINOR.PATCH
gh attestation verify guildctl-MAJOR.MINOR.PATCH.tgz \
  --repo j-256/guildcontrol \
  --signer-workflow j-256/guildcontrol/.github/workflows/release.yml \
  --source-ref refs/tags/vMAJOR.MINOR.PATCH \
  --deny-self-hosted-runners
gh attestation verify guildctl-MAJOR.MINOR.PATCH.tgz \
  --repo j-256/guildcontrol \
  --signer-workflow j-256/guildcontrol/.github/workflows/release.yml \
  --source-ref refs/tags/vMAJOR.MINOR.PATCH \
  --deny-self-hosted-runners \
  --predicate-type https://spdx.dev/Document/v2.3
gh attestation verify guildcontrol-MAJOR.MINOR.PATCH.mcpb \
  --repo j-256/guildcontrol \
  --signer-workflow j-256/guildcontrol/.github/workflows/release.yml \
  --source-ref refs/tags/vMAJOR.MINOR.PATCH \
  --deny-self-hosted-runners
gh attestation verify guildcontrol-MAJOR.MINOR.PATCH.mcpb \
  --repo j-256/guildcontrol \
  --signer-workflow j-256/guildcontrol/.github/workflows/release.yml \
  --source-ref refs/tags/vMAJOR.MINOR.PATCH \
  --deny-self-hosted-runners \
  --predicate-type https://spdx.dev/Document/v2.3
```

5. From an authenticated maintainer workstation, publish that exact tarball and complete npm's interactive passkey challenge. Package metadata enables automatic provenance for normal OIDC releases, so this exceptional local first publication must explicitly disable it. The protected GitHub artifact attestations verified above remain the first version's public provenance:

```sh
npm login --auth-type=web
npm whoami
npm publish ./guildctl-MAJOR.MINOR.PATCH.tgz --provenance=false
```

6. After npm makes the version available, require its published SHA-512 integrity to match the candidate before any OCI or MCP Registry operation:

```sh
node scripts/check-published-artifacts.mjs \
  --tarball ./guildctl-MAJOR.MINOR.PATCH.tgz \
  --expect-package matching \
  --expect-npm matching \
  --expect-oci missing \
  --expect-registry missing
```

The first version's public provenance is the GitHub artifact attestation bound to the protected workflow, tag, and source commit. Publishing the exact tarball preserves that byte identity. npm OIDC provenance begins with later stage-only trusted publications because npm cannot configure that trust relationship before the package exists.

7. After the published `guildctl` package passes the matching checks, deprecate the superseded package without removing its release:

```sh
npm deprecate 'guildcontrol@*' 'Package renamed to guildctl. Run npx guildctl to get started.'
```

## Configure trusted staged publishing

Immediately after the first publication, configure the npm package's trusted publisher with these exact boundaries:

- Provider: GitHub Actions
- Repository owner: `j-256`
- Repository: `guildcontrol`
- Workflow: `release.yml`
- Environment: `release`
- Permission: allow staged publishing and disallow direct publishing

Set package publishing access to require two-factor authentication and disallow tokens. The trusted publisher may run `npm stage publish`; a human still supplies 2FA for `npm stage approve`. No npm token belongs in any release workflow.

## Prepare a version

1. Write one private input JSON document for the release's public summary. Its `version` must be the exact target, `paragraphs` must explain the release and any unusual version transition, and `highlights` must describe the durable user-facing outcomes. Each list accepts one to six single-line entries. The guarded command copies the validated content into the protected `release-summaries.json` history without retaining the input path.

```json
{
  "version": "MAJOR.MINOR.PATCH",
  "paragraphs": ["Explain the release and compatibility boundary."],
  "highlights": ["Describe one durable outcome"]
}
```

2. From a clean `main` that exactly matches a freshly fetched `origin/main`, run the guarded version preparation with the reviewed UTC build day and summary input:

```sh
npm run version:prepare -- MAJOR.MINOR.PATCH \
  --source-date YYYY-MM-DD \
  --release-summary /absolute/private/release-summary.json
```

The command rejects a reused tag or a non-increasing version, verifies the complete current release before mutation, synchronizes the package, lockfiles, source constant, npm and OCI Registry metadata, Docker default, MCPB manifest, tests, and every versioned public reference, records the UTC day boundary, rebuilds the MCPB, binds its SHA-256 to `server.json`, and reruns the complete release gate. The OCI index check uses the same digest-pinned BuildKit image as CI and the release workflow while keeping the active Docker context unchanged. The command leaves every change unstaged for review and never commits, tags, pushes, stages npm, or publishes.

When a reviewed dependency or source repair changes the MCPB bytes before it can merge, prepare the version on its clean task branch with `--candidate-head FULL_COMMIT_SHA`. The task must include freshly fetched `origin/main`, and its head must match the exact reviewed commit. This mode checks metadata, configuration schema, and dependency security before mutation, then runs the complete release gate against the prepared version, including strict MCPB digest binding. It does not compare candidate bytes with the previous published version's digest. Preparation rolls back its version changes if verification fails or the source commit or integration base moves. Merge the resulting release preparation through the protected PR path before tagging or publishing it.

3. Inspect the full diff and confirm that the MCPB URL names `guildcontrol-MAJOR.MINOR.PATCH.mcpb` under the exact `vMAJOR.MINOR.PATCH` GitHub Release. `npm run release:check` independently reruns the same complete local gate:

```sh
npm run deps:locked
npm run metadata:check
npm run config:schema:check
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run pack:verify
npm run mcpb:verify
npm run container:verify
npm run container:index:verify
npm run security:check
npm run --silent sbom -- --output sbom.spdx.json
```

4. Commit the version as a release preparation change and let every CI job pass on `main`, including `Publish documentation portal`.
5. Run `node scripts/check-public-documentation.mjs` from that exact commit and require an exact result.
6. Create the exact `vMAJOR.MINOR.PATCH` tag on that commit and push the tag.

Do not include `sbom.spdx.json` from the local command in the commit. The workflow reconstructs its own SBOM and release archive.

## Stage and approve npm

1. Dispatch the protected workflow:

```sh
gh workflow run release.yml --ref vMAJOR.MINOR.PATCH -f operation=stage -f tag=vMAJOR.MINOR.PATCH
```

2. Review the preflight job's npm archive, MCPB, deterministic catalog evidence, SPDX artifacts, and GitHub attestation summary. The preflight verifies source, dependency locks, registry signatures, vulnerabilities, the public versioned icon, official MCP and MCPB manifest validation, byte-for-byte repeatability, installed CLI behavior, an unpacked bundle handshake, and a content-free installed MCP handshake.
3. Approve the `release` environment after confirming the exact tag, source commit, and absent npm version, OCI tag, and Registry version. The gated stage job has only read access to the retained evidence and OIDC authority for npm, reverifies the tag and public state, and submits that exact tarball to npm's private staging area.
4. Inspect the private npm stage from a maintainer workstation:

```sh
npm stage list guildctl
npm stage view STAGE_ID
npm stage download STAGE_ID
```

5. Compare the downloaded stage with the workflow artifact. Reject it if any digest or metadata differs.
6. Approve with human 2FA:

```sh
npm stage approve STAGE_ID
```

If the candidate is wrong, use `npm stage reject STAGE_ID`, fix the source, and create a new version. A staged semantic version cannot be reused until the rejected stage is removed.

## Promote OCI, GitHub Release, and MCP Registry

After npm exposes the exact approved version, dispatch one promotion run:

```sh
gh workflow run release.yml --ref vMAJOR.MINOR.PATCH -f operation=promote -f tag=vMAJOR.MINOR.PATCH
```

The ungated preflight reconstructs and attests the npm archive, MCPB, catalog evidence, and SPDX SBOM. It requires public npm integrity to match, permits OCI and Registry state only when absent or already exact, and retains the evidence before asking for approval. Approve the `release` environment once after reviewing the exact tag, source commit, npm integrity, artifact attestations, absent-or-matching downstream state, and repository-level immutable-Releases setting. The approval job itself has no repository permission.

The dependent image job reconstructs the npm archive from the tag and requires it to match public npm before inspecting the exact OCI tag through an authenticated registry request. If the tag is absent, it builds and publishes `linux/amd64` and `linux/arm64` manifests under `ghcr.io/j-256/guildcontrol:MAJOR.MINOR.PATCH`. Both stages use the same reviewed digest-pinned Node.js base. The image runs as an unprivileged user, defaults to credential-free catalog mode, and contains only the compiled server, production dependencies, package metadata, and license.

Before publishing, the workflow exports and validates the complete multi-architecture OCI layout with digest-pinned BuildKit, architecture-emulation, and SBOM-generator images. It verifies every referenced blob and requires the exact platform, annotation, configuration, layer-binding, provenance, and SPDX structure. BuildKit evidence may use its legacy compatibility image config or its OCI artifact encoding. The artifact form must name the exact runnable manifest as its subject and use OCI's canonical empty JSON config descriptor. The release build then binds BuildKit provenance and SPDX records for both platform manifests into the root index and pushes signed GitHub provenance for that exact root digest. It requires the public index to match the preflight invariants, runs the pulled image with a read-only root filesystem and no network or Linux capabilities, compares its catalog evidence to the source contract, and verifies the signed root claim against the exact repository, workflow, tag ref, and source commit.

BuildKit `mode=max` identifies the provenance record's detail level, not a maximum security or SLSA assurance level. The [provenance, SBOM, and attestation boundaries](reference.md#provenance-sbom-and-attestation-boundaries) distinguish the build receipt, detected software inventory, signed artifact binding, and guarantees that still require independent review.

GitHub creates a new personal container package as private by default. On the first image publication, the workflow may publish and attest the immutable tag and then fail its anonymous-read check with a recovery instruction. Open the package settings, confirm that the source repository is linked, review the package contents and permissions, and change visibility to Public. Visibility changes are consequential and may be irreversible, so do this only after the review. Rerun the same `promote` operation. It detects the existing exact tag, does not overwrite or re-attest it, and completes only if the now-public digest and behavior match the release.

If the exact image tag already exists but any digest, platform, annotation, image configuration, attestation, or runtime proof differs, the image job fails closed and the GitHub Release and Registry jobs do not run. Fix the source and publish a new semantic version; never replace a published tag.

After exact image verification, the dependent GitHub Release job alone receives `contents: write`, plus read-only access to that run's artifacts and GitHub attestations. It installs the exact SHA-256-pinned GitHub CLI archive, downloads only the promotion run's evidence, resolves the protected tag to the exact source commit, and generates deterministic release notes and `SHA256SUMS`. GitHub does not expose its repository-level immutable-Releases setting to `GITHUB_TOKEN`, so the promotion reviewer must confirm that setting before approval; automation receives no standing repository-administration credential.

An absent Release is created as a draft. An existing draft may be reconciled only for the exact asset set below, then its tag, title, notes, asset names, sizes, SHA-256 digests, download URLs, and source commit are verified before publication:

- `guildctl-MAJOR.MINOR.PATCH.tgz`
- `guildcontrol-MAJOR.MINOR.PATCH.mcpb`
- `catalog-evidence.json`
- `release-notes.md`
- `sbom.spdx.json`
- `SHA256SUMS`

Publishing locks the tag and assets when repository-level immutable Releases remain enabled and creates GitHub's Release attestation over the tag, commit, and assets. GitHub still permits the displayed Release title and body to be edited, so `release-notes.md` is the canonical immutable copy and is covered by `SHA256SUMS`. The workflow waits for the immutable postcondition, verifies the Release attestation and every asset attestation, downloads every public asset, compares each byte-for-byte with the protected evidence, and verifies the checksum manifest. A matching immutable Release is a successful no-op. A mutable published Release, mismatched immutable Release, prerelease, unexpected asset, or draft that cannot be reconciled exactly fails closed. The workflow never deletes a Release or an unexpected asset.

Only after the immutable Release and every public asset verify does the Registry job receive the `release-credentials` environment. It reconstructs notes and checksums, verifies public npm and OCI identity, verifies the exact immutable Release again, downloads MCP Registry publisher `v1.8.1` from the official release, verifies the pinned Linux archive SHA-256, validates `server.json`, and authenticates the product namespace with the DNS Ed25519 seed. It publishes only when the exact Registry version is absent.

Metadata checks require the npm entry to pass one config-file argument, the OCI entry to use one read-only config mount and hardened operational command, and the MCPB entry to name the exact immutable Release URL and SHA-256. Only the MCPB entry asks for the non-secret config file and sensitive bot token; the runtime policy remains inside that selected file. An already matching Registry entry is a successful no-op. Existing mismatched metadata, mutable or mismatched Release state, or altered public asset fails closed.

### Recover a failed publisher job

Use the recovery operation only when a promotion preflight completed and retained exact evidence, but its dependent `github_release` job failed before completing the immutable Release. Fix the workflow defect on `main` through the normal pull-request and required-check path. Do not move the release tag, replace the retained artifact, or publish locally.

Create and push a new annotated recovery audit tag on the exact green fix commit. The tag must use the form `vMAJOR.MINOR.PATCH-recovery.N`, where `N` starts at 1 and increases for each distinct recovery attempt. Retain every recovery tag as public audit evidence and never move or delete one.

Dispatch the corrected workflow at that recovery tag while naming the original stable release tag and failed run:

```sh
gh workflow run release.yml \
  --ref vMAJOR.MINOR.PATCH-recovery.N \
  -f operation=github-release-recovery \
  -f tag=vMAJOR.MINOR.PATCH \
  -f evidence_run_id=FAILED_RUN_ID
```

The protected recovery job checks that its execution ref is a distinct recovery tag whose commit is on `main`, checks that the source release tag still resolves to the exact package source, and accepts only a completed failed `release.yml` workflow-dispatch run from that source tag and commit. It downloads only that run's exact `release-evidence-promote-vMAJOR.MINOR.PATCH` artifact, rejects missing, duplicate, expired, oversized, cross-repository, cross-tag, or cross-commit evidence, and verifies the npm archive, MCPB, catalog, and both SPDX claims against the release workflow, source ref, source commit, and GitHub-hosted runner boundary. The unchanged source checkout reconstructs the deterministic evidence, while release inspection and verification run from the exact protected recovery audit tag after its package version is proven equal to the source version. This separation lets a reviewed recovery fix correct publisher validation without changing the release source or retained bytes. The job then repeats the package, npm, OCI, MCP Registry, release-note, checksum, draft, immutable-Release, public-download, and asset-attestation checks used by the normal publisher job.

Approve the `release` environment only after reviewing the recovery commit, audit tag, original release tag and commit, failed run ID and logs, retained artifact, and repository-level immutable-Releases setting. If the prior evidence is unavailable or fails any binding, or if public state is mutable or mismatched, do not weaken recovery validation. Publish a corrected semantic version instead.

## Independent verification

Verify the immutable GitHub Release, download its exact assets, verify each local asset against GitHub's Release attestation, and check the checksum manifest:

```sh
mkdir guildcontrol-release
gh release verify vMAJOR.MINOR.PATCH --repo j-256/guildcontrol
gh release download vMAJOR.MINOR.PATCH --repo j-256/guildcontrol --dir guildcontrol-release
gh release verify-asset vMAJOR.MINOR.PATCH guildcontrol-release/guildctl-MAJOR.MINOR.PATCH.tgz --repo j-256/guildcontrol
gh release verify-asset vMAJOR.MINOR.PATCH guildcontrol-release/guildcontrol-MAJOR.MINOR.PATCH.mcpb --repo j-256/guildcontrol
gh release verify-asset vMAJOR.MINOR.PATCH guildcontrol-release/release-notes.md --repo j-256/guildcontrol
(cd guildcontrol-release && shasum -a 256 -c SHA256SUMS)
```

`gh release verify` establishes GitHub's signed binding among the immutable tag, source commit, and complete asset digest set. `gh release verify-asset` establishes that the local file is one exact attested asset. The checksum manifest makes the package, MCPB, catalog evidence, canonical notes, and SBOM directly comparable with ordinary local tools. These integrity checks establish identity and origin, not freedom from defects, vulnerabilities, malicious source, or scanner omissions.

Download the exact npm package and verify both provenance and its SBOM attestation:

```sh
npm pack guildctl@MAJOR.MINOR.PATCH
gh attestation verify guildctl-MAJOR.MINOR.PATCH.tgz \
  --repo j-256/guildcontrol \
  --signer-workflow j-256/guildcontrol/.github/workflows/release.yml \
  --source-ref refs/tags/vMAJOR.MINOR.PATCH \
  --deny-self-hosted-runners
gh attestation verify guildctl-MAJOR.MINOR.PATCH.tgz \
  --repo j-256/guildcontrol \
  --signer-workflow j-256/guildcontrol/.github/workflows/release.yml \
  --source-ref refs/tags/vMAJOR.MINOR.PATCH \
  --deny-self-hosted-runners \
  --predicate-type https://spdx.dev/Document/v2.3
gh attestation verify catalog-evidence.json \
  --repo j-256/guildcontrol \
  --signer-workflow j-256/guildcontrol/.github/workflows/release.yml \
  --source-ref refs/tags/vMAJOR.MINOR.PATCH \
  --deny-self-hosted-runners
gh attestation verify guildcontrol-release/guildcontrol-MAJOR.MINOR.PATCH.mcpb \
  --repo j-256/guildcontrol \
  --signer-workflow j-256/guildcontrol/.github/workflows/release.yml \
  --source-ref refs/tags/vMAJOR.MINOR.PATCH \
  --deny-self-hosted-runners
gh attestation verify guildcontrol-release/guildcontrol-MAJOR.MINOR.PATCH.mcpb \
  --repo j-256/guildcontrol \
  --signer-workflow j-256/guildcontrol/.github/workflows/release.yml \
  --source-ref refs/tags/vMAJOR.MINOR.PATCH \
  --deny-self-hosted-runners \
  --predicate-type https://spdx.dev/Document/v2.3
```

From an isolated consumer directory, install the downloaded archive without lifecycle scripts and save the credential-free catalog evidence:

```sh
npm install --ignore-scripts ./guildctl-MAJOR.MINOR.PATCH.tgz
./node_modules/.bin/guildctl catalog --check --json > catalog-evidence.json
```

The evidence must be identical across repeated runs of the same installed archive. Review its exact inventories and accounting fields, including complete per-tool authentication, connector policy, Discord permission, conditional case, Gateway intent, hierarchy, curated setup, access-lifecycle, and live-verification contracts with zero unknown requirement entries. Preserve its `contractDigest` for contract comparison and its separate `safetyResourceDigest` for focused safety-guidance comparison. The report must state that credentials, Discord execution, Gateway access, telemetry export, activity persistence, authority grants, and target-readiness claims are disabled.

Authenticate the container client, pull the exact image, verify its signed root provenance from the OCI registry, inspect the root-bound per-platform SPDX records, and run its credential-free catalog under the recommended restrictions:

```sh
docker pull ghcr.io/j-256/guildcontrol:MAJOR.MINOR.PATCH
gh attestation verify oci://ghcr.io/j-256/guildcontrol:MAJOR.MINOR.PATCH \
  --repo j-256/guildcontrol \
  --signer-workflow j-256/guildcontrol/.github/workflows/release.yml \
  --source-ref refs/tags/vMAJOR.MINOR.PATCH \
  --deny-self-hosted-runners \
  --bundle-from-oci
docker run --rm -i \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges:true \
  --pids-limit=64 \
  ghcr.io/j-256/guildcontrol:MAJOR.MINOR.PATCH catalog --check --json > container-catalog-evidence.json
```

Review the image index with `docker buildx imagetools inspect ghcr.io/j-256/guildcontrol:MAJOR.MINOR.PATCH`. It must expose only `linux/amd64` and `linux/arm64` as runnable platforms, retain the reviewed index description and source annotations, and bind BuildKit evidence to both manifests. The container catalog evidence must be byte-identical across repeated runs and match the installed npm package's evidence.

From a checkout of the same tag, compare npm and MCP Registry state with the same code used by release automation:

```sh
node scripts/check-published-artifacts.mjs \
  --tarball guildctl-MAJOR.MINOR.PATCH.tgz \
  --expect-package matching \
  --expect-npm matching \
  --expect-oci matching \
  --expect-registry matching
```

The exact registry response is also available from `https://registry.modelcontextprotocol.io/v0.1/servers/app.lasers.guildcontrol%2Fdiscord/versions/MAJOR.MINOR.PATCH`.

## Failed or compromised releases

- Reject an unapproved npm stage and publish a corrected new version
- Deprecate a flawed public npm version and publish a corrected new version rather than overwriting it
- Publish a corrected OCI image under a new semantic version rather than overwriting or reusing an existing tag
- Rerun the same promotion after a transient downstream failure; every already matching immutable target is a no-op and every mismatch fails closed
- Leave a malformed draft unpublished for explicit maintainer cleanup; publish a corrected semantic version if an immutable GitHub Release is wrong
- Use the protected recovery operation only for exact retained evidence from a failed GitHub Release publisher job; never move the stable release tag or substitute local evidence
- Rotate a suspected Registry key through DNS and the credential environment, inspect versions created during DNS cache expiry, and preserve workflow logs without copying secrets into an issue
- Use npm unpublish only for a confirmed security emergency and after evaluating downstream breakage
- Publish corrected MCP Registry metadata under the corrected package version; never claim mismatched metadata is equivalent

## Platform references

- [npm staged publishing](https://docs.npmjs.com/staged-publishing/)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [npm scoped public package publication](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [npm bypass-2FA token restrictions](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)
- [GitHub workflow event refs and SHAs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)
- [GitHub repository visibility consequences](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)
- [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)
- [GitHub security and analysis settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-security-and-analysis-settings-for-your-repository)
- [GitHub artifact and SBOM attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- [GitHub immutable Releases](https://docs.github.com/en/enterprise-cloud@latest/code-security/concepts/supply-chain-security/immutable-releases)
- [GitHub Release integrity verification](https://docs.github.com/en/enterprise-cloud@latest/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity)
- [GitHub container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [GitHub package visibility and access](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)
- [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- [GitHub repository rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)
- [Docker multi-platform images](https://docs.docker.com/build/ci/github-actions/multi-platform/)
- [OCI annotations with Buildx](https://docs.docker.com/build/metadata/annotations/)
- [BuildKit attestation storage](https://github.com/moby/buildkit/blob/master/docs/attestations/attestation-storage.md)
- [MCPB format, manifest, and tooling](https://github.com/modelcontextprotocol/mcpb/tree/v2.1.2)
- [MCP Registry publishing quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx)
- [MCP Registry authentication](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/authentication.mdx)
- [MCP Registry publisher commands](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/cli/commands.md)
