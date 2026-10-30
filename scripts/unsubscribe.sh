#!/usr/bin/env bash
# Remove the Repo Pulse webhook from GitHub repositories with the gh CLI, once the
# GitHub App delivers their events. Only hooks whose URL is exactly the Worker's
# webhook URL are deleted. Each one is first appended to an inventory file, so it
# can be recreated with scripts/subscribe.sh.
#
# Usage: scripts/unsubscribe.sh [--dry-run] <worker-url> <owner/repo>...
# The inventory is $REPO_PULSE_HOOK_INVENTORY,
# defaulting to ~/.config/repo-pulse/removed-hooks.jsonl.
set -euo pipefail

dry_run=false
if [ "${1:-}" = "--dry-run" ]; then
  dry_run=true
  shift
fi

if [ "$#" -lt 2 ]; then
  echo "usage: $0 [--dry-run] <worker-url> <owner/repo>..." >&2
  exit 2
fi

url="${1%/}"
case "$url" in
  */webhook) ;;
  *) url="$url/webhook" ;;
esac
shift

inventory="${REPO_PULSE_HOOK_INVENTORY:-$HOME/.config/repo-pulse/removed-hooks.jsonl}"
if [ "$dry_run" = false ]; then
  mkdir -p "$(dirname "$inventory")"
fi

for repo in "$@"; do
  hooks="$(gh api --paginate "repos/$repo/hooks" |
    jq -c --arg url "$url" --arg repo "$repo" \
      '.[] | select(.config.url == $url) | {repo: $repo, id, url: .config.url, events}')"
  if [ -z "$hooks" ]; then
    echo "$repo: no Repo Pulse webhook"
    continue
  fi

  while IFS= read -r hook; do
    id="$(jq -r '.id' <<<"$hook")"
    if [ "$dry_run" = true ]; then
      echo "$repo: would delete hook $id"
      continue
    fi
    printf '%s\n' "$hook" >>"$inventory"
    gh api --method DELETE "repos/$repo/hooks/$id" >/dev/null
    echo "$repo: deleted hook $id (recorded in $inventory)"
  done <<<"$hooks"
done
