#!/usr/bin/env bash
# Add the Repo Pulse webhook to GitHub repositories with the gh CLI.
# Repositories that already send to the same URL are skipped, so reruns are safe.
#
# Usage: scripts/subscribe.sh <worker-url> <owner/repo>...
# The webhook secret is read from $REPO_PULSE_SECRET_FILE,
# defaulting to ~/.config/repo-pulse/webhook-secret.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <worker-url> <owner/repo>..." >&2
  exit 2
fi

url="${1%/}"
case "$url" in
  */webhook) ;;
  *) url="$url/webhook" ;;
esac
shift

secret_file="${REPO_PULSE_SECRET_FILE:-$HOME/.config/repo-pulse/webhook-secret}"
if [ ! -s "$secret_file" ]; then
  echo "webhook secret file is missing or empty: $secret_file" >&2
  exit 1
fi
# $(<file) drops trailing newlines, which GitHub would otherwise keep as part of the secret.
secret="$(<"$secret_file")"

for repo in "$@"; do
  existing="$(gh api "repos/$repo/hooks" --jq '.[] | "\(.id) \(.config.url)"' |
    awk -v url="$url" '$2 == url { print $1 }')"
  if [ -n "$existing" ]; then
    echo "$repo: already subscribed (hook $existing)"
    continue
  fi

  # The secret goes through stdin so it never shows up in the process list.
  id="$(printf '%s' "$secret" | gh api --method POST "repos/$repo/hooks" \
    -f 'name=web' -F 'active=true' \
    -f 'events[]=fork' -f 'events[]=issues' -f 'events[]=pull_request' \
    -f 'events[]=push' -f 'events[]=release' -f 'events[]=star' \
    -f "config[url]=$url" -f 'config[content_type]=json' -f 'config[insecure_ssl]=0' \
    -F 'config[secret]=@-' --jq '.id')"
  echo "$repo: subscribed (hook $id)"
done
