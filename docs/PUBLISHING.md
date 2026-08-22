# Publishing the 3 sister packages

The cluster's `pi-sandbox` image installs the 3 sister packages at
`@latest` from the npm registry. Every cluster rebuild picks up the
newest published version automatically — no version pinning, no
`local-source/` patching.

This document walks through the publish flow end-to-end.

## The 3 packages

| Package | Role | Version |
|---|---|---|
| `pi-voice-telegram-scripts` | Runtime CLIs (`tts-minimax`, `tts-openai`, `fw-openai-sts`) | v0.1.0 |
| `pi-openai-stt` | STT provider (OpenAI-compatible) | v0.3.0 |
| `pi-telegram-stt` | STT orchestrator + 🎙️ echo | v0.7.0 |

## The preferred path: GitHub Actions with OIDC

`.github/workflows/publish.yml` runs on every `v*` tag push. It uses
**Trusted Publishing via OIDC** — short-lived tokens issued by GitHub
Actions to npm on each run. No stored secret, no 2FA prompt, no
`bypass2fa` granular token.

### Trigger

```bash
# 1. Bump the version in each of the 3 packages (manually or via npm)
cd extensions/pi-voice-telegram-scripts && npm version patch
cd ../pi-openai-stt && npm version patch
cd ../pi-telegram-stt && npm version patch
cd ../..  # back to repo root

# 2. Commit + push the version bumps
git add -A
git commit -m "chore(release): v0.7.1"
git push

# 3. Tag + push the tag (triggers the workflow)
git tag v0.7.1
git push --follow-tags

# 4. Watch the workflow run
#    https://github.com/<owner>/<repo>/actions/workflows/publish.yml
#    On success, all 3 packages are on npm, and a GitHub Release
#    is created with auto-generated notes.
```

The workflow:
1. Verifies all 3 packages are at the same version (the tag's `v<X.Y.Z>`)
2. Publishes them in dependency order (leaves first)
3. Creates a GitHub Release with the tag's name

### One-time setup: OIDC trusted publishing on npm

For each of the 3 packages, configure Trusted Publishing on npmjs.com:

1. Go to `https://www.npmjs.com/package/<name>/access`
2. "Publishing access" → "Add a trusted publisher"
3. Fill in:
   - **Repository:** `johnlam1968/pi-voice-telegram`
   - **Workflow file:** `.github/workflows/publish.yml`
   - **Environment:** *(leave blank for the simple flow; or set up
     a GitHub Environment with required reviewers for an extra gate)*
4. Save

Repeat for all 3 packages. After this, every tag push publishes
without you ever touching the CLI.

### First publish bootstrap (chicken-and-egg)

Trusted Publishing only works for **existing** packages. The very
first publish of each package has to happen via some path that
creates the package on npm:

| Path | When to use |
|---|---|
| **npm web UI** (drag-and-drop tarball) | Easiest. `npm pack` from each package dir to get the tarball, then go to `npmjs.com` → "publish a package" → upload. |
| **`npm publish --otp <code>` from a host with TOTP** | If you have an authenticator app (Google Authenticator, Authy, etc.) on a phone. |
| **Bootstrap a TOTP app + use `--otp`** | If you don't already have 2FA set up. Install Google Authenticator, scan the QR from npmjs.com → Account Settings → 2FA, then use the codes. |

After the first publish, configure Trusted Publishing (above) and
every subsequent release is a tag push.

## The fallback path: local CLI publish

`.github/workflows/publish.yml` is the canonical release path.
`scripts/publish.sh` is kept for:

- **Verifying** (`--dry-run`) that the packages are publishable, without
  actually publishing
- **Emergency** local publishes when CI is broken
- **First publish** bootstrap (if you can read a TOTP code on the host)

### 2FA on the CLI (npm v12+)

As of npm v12, GATs (granular access tokens) with "bypass 2FA" can
**no longer publish directly** — they can only stage a publish (which
then needs human 2FA approval) or read private packages. See
[npm's July 8, 2026 changelog](https://github.blog/changelog/2026-07-08-...-gat-bypass2fa-deprecation/)
for the full timeline (the last bastion of bypass-2FA direct publish
goes away in January 2027).

For local CLI publishing with 2FA:

```bash
# 1. Read the 6-digit code from your authenticator app
# 2. Run with --otp
./scripts/publish.sh --otp 123456

# Or via env var (avoids the code in shell history)
NPM_CONFIG_OTP=123456 ./scripts/publish.sh
```

`scripts/publish.sh` exports `NPM_CONFIG_OTP` so the child
`npm publish` calls pick it up. The auth challenge is satisfied
inline; no interactive prompt.

## Why a tag, not a workflow_dispatch?

The workflow supports `workflow_dispatch` (manual run) as a
fallback. But the preferred trigger is a tag push because:

- **It's automated.** No need to remember to trigger the workflow.
- **It's audit-friendly.** The tag is a permanent record of what
  was published when. The GitHub Release adds a human-readable
  changelog.
- **It can't bypass the version check.** The workflow verifies
  that all 3 packages are at the tag's version. A manual
  `workflow_dispatch` can publish whatever version is in
  package.json — easy to mess up.

## What happens to the cluster after a publish

The cluster's `Dockerfile.pi` does:
```bash
npm install --legacy-peer-deps    # pi-extensions.package.json has all 6 at "latest"
```

So the next `docker build` after a publish will pull the new
versions automatically. `scripts/deploy-pi-voice-telegram.sh` in
the cluster repo does this rebuild + agent restart.

## References

- [npm install-time security and GAT bypass2fa deprecation (Jul 8, 2026)](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)
- [Restricting npm bypass-2FA granular access tokens (Jul 31, 2026)](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/)
- [Upcoming changes to npm 2FA-bypass GATs (community discussion #201329)](https://github.com/orgs/community/discussions/201329)
- [npm Trusted Publishers docs](https://docs.npmjs.com/trusted-publishers)
