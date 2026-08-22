#!/usr/bin/env bash
#
# publish.sh — publish the three source packages to the npm registry.
#
# Packages published (in dependency order, leaves first):
#   1. pi-voice-telegram-scripts   (no peer deps; the runtime CLIs)
#   2. pi-openai-stt               (STT provider; no peer on pi-telegram-stt at runtime)
#   3. pi-telegram-stt              (STT orchestrator; peers on pi-openai-stt)
#
# Why in this order: pi-telegram-stt declares pi-openai-stt as a peer
# dep. npm peer-dep resolution doesn't fail on publish (only on install),
# but the README references the order anyway.
#
# Usage:
#   ./scripts/publish.sh                 # publish each package, then git tag
#   ./scripts/publish.sh --dry-run      # run `npm publish --dry-run` for each
#   ./scripts/publish.sh --skip-git     # publish but don't tag or commit
#   ./scripts/publish.sh --only pi-voice-telegram-scripts   # publish a subset
#
# Prerequisites (one-time):
#   1. `npm login` once on the host (or set NPM_TOKEN in env)
#   2. Bump the version in the package's package.json (manual or
#      `npm version patch` in the package's directory)
#
# The script refuses to publish a package whose `version` is already
# on the npm registry at the same version (npm itself errors, but
# we fail earlier with a clearer message).
#
# Tagging: after a successful publish of all 3 packages, a git tag
# `v<pi-telegram-stt-version>` is created (pi-telegram-stt is the
# last-published package, so its version anchors the release).
# Example: if pi-telegram-stt is at v0.7.0, the tag is v0.7.0.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

DRY_RUN=0
SKIP_GIT=0
ONLY=()
ALL_PACKAGES=(pi-voice-telegram-scripts pi-openai-stt pi-telegram-stt)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --skip-git) SKIP_GIT=1; shift ;;
    --only) shift; while [[ $# -gt 0 && "$1" != --* ]]; do ONLY+=("$1"); shift; done ;;
    -h|--help)
      sed -n '2,32p' "$0"
      exit 0 ;;
    *) echo "publish.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Default --only to all packages if not specified
if [[ ${#ONLY[@]} -eq 0 ]]; then
  ONLY=("${ALL_PACKAGES[@]}")
fi

# ---------------------------------------------------------------------------
# Sanity checks
# ---------------------------------------------------------------------------

# Verify all 3 source packages exist
for pkg in "${ONLY[@]}"; do
  if [[ ! -d "extensions/$pkg" ]]; then
    echo "publish.sh: FAIL — extensions/$pkg does not exist" >&2
    exit 3
  fi
done

# Verify we're on master (not a feature branch) unless --skip-git
if [[ $SKIP_GIT -eq 0 ]] && [[ $(git branch --show-current) != "master" ]] && [[ $(git branch --show-current) != "main" ]]; then
  echo "publish.sh: FAIL — not on master/main (current: $(git branch --show-current))" >&2
  echo "  hint: use --skip-git to publish from a feature branch (not recommended)" >&2
  exit 3
fi

# Verify no uncommitted changes unless --skip-git
if [[ $SKIP_GIT -eq 0 ]] && ! git diff --quiet HEAD; then
  echo "publish.sh: FAIL — uncommitted changes" >&2
  echo "  hint: commit first or use --skip-git" >&2
  exit 3
fi

# Verify npm auth
if ! npm whoami >/dev/null 2>&1; then
  echo "publish.sh: FAIL — not logged in to npm" >&2
  echo "  hint: \`npm login\` or set NPM_TOKEN env var" >&2
  exit 3
fi
NPM_USER=$(npm whoami)
echo "publish.sh: logged in to npm as '$NPM_USER'"

# ---------------------------------------------------------------------------
# Publish each package
# ---------------------------------------------------------------------------

# Track the last successfully published version for git tagging
LAST_VERSION=""

for pkg in "${ONLY[@]}"; do
  pkg_dir="extensions/$pkg"
  pkg_version=$(python3 -c "import json;print(json.load(open('$pkg_dir/package.json'))['version'])")
  echo ""
  echo "→ $pkg@$pkg_version"

  # Check if this version is already published (skip with --dry-run)
  if [[ $DRY_RUN -eq 0 ]]; then
    existing=$(npm view "$pkg@$pkg_version" version 2>/dev/null || echo "")
    if [[ -n "$existing" ]]; then
      echo "  FAIL — $pkg@$pkg_version already on npm (refusing to overwrite)" >&2
      exit 4
    fi
  fi

  # Publish (or dry-run)
  if [[ $DRY_RUN -eq 1 ]]; then
    (cd "$pkg_dir" && npm publish --dry-run --access public 2>&1 | tail -10)
  else
    (cd "$pkg_dir" && npm publish --access public 2>&1 | tail -10)
  fi
  LAST_VERSION="$pkg_version"
done

# ---------------------------------------------------------------------------
# Git tag
# ---------------------------------------------------------------------------

if [[ $SKIP_GIT -eq 1 ]]; then
  echo ""
  echo "publish.sh: --skip-git set; not creating tag"
  exit 0
fi

if [[ $DRY_RUN -eq 1 ]]; then
  echo ""
  echo "publish.sh: --dry-run set; not creating tag"
  exit 0
fi

# Tag the commit with the anchor package's version
TAG="v${LAST_VERSION}"
echo ""
echo "→ Creating git tag $TAG"
git tag -a "$TAG" -m "$TAG — published pi-voice-telegram-scripts@$LAST_VERSION, pi-openai-stt@$LAST_VERSION, pi-telegram-stt@$LAST_VERSION"
echo ""
echo "publish.sh: DONE"
echo "  Pushed: ${ONLY[@]}"
echo "  Tag:    $TAG (run \`git push --follow-tags\` to publish)"
