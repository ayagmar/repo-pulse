#!/usr/bin/env bash
# Check that every listed repository has a working Repo Pulse webhook, before the
# Worker stops admitting GitHub App deliveries. A repository is covered when a hook
# whose URL is exactly the Worker's webhook URL is active, subscribes to all six
# events (or to everything), and answers a fresh ping with 200.
#
# Prints one line per uncovered repository, with the reason, and exits 1 if there
# is any; prints nothing and exits 0 when all are covered.
#
# With --repair, a matching hook that is inactive or misses events is first set
# active with the six events. Hooks with other URLs are never changed, and the
# hook secret is never read.
#
# Usage: scripts/check-coverage.sh [--repair] <worker-url> <covered-list-file>
# The list has one owner/repo per line. REPO_PULSE_PING_ATTEMPTS (default 10) and
# REPO_PULSE_PING_INTERVAL (seconds, default 2) bound the wait for each ping.
set -euo pipefail
# A failed gh call inside $(...) stops the script instead of passing as no problem.
shopt -s inherit_errexit

repair=false
if [ "${1:-}" = "--repair" ]; then
  repair=true
  shift
fi

if [ "$#" -ne 2 ]; then
  echo "usage: $0 [--repair] <worker-url> <covered-list-file>" >&2
  exit 2
fi

url="${1%/}"
case "$url" in
  */webhook) ;;
  *) url="$url/webhook" ;;
esac
list="$2"

events=(fork issues pull_request push release star)
events_json="$(printf '%s\n' "${events[@]}" | jq -R . | jq -sc .)"
attempts="${REPO_PULSE_PING_ATTEMPTS:-10}"
interval="${REPO_PULSE_PING_INTERVAL:-2}"

# The newest ping delivery of a hook, as "<id> <status_code>", or nothing.
newest_ping() {
  gh api "repos/$1/hooks/$2/deliveries" </dev/null |
    jq -r '[.[] | select(.event == "ping")][0] // empty | "\(.id) \(.status_code)"'
}

# Why a hook does not cover its repository, or nothing when it does.
hook_problem() {
  local repo="$1" hook="$2"
  local id active missing
  id="$(jq -r '.id' <<<"$hook")"

  if [ "$repair" = true ] &&
    ! jq -e --argjson want "$events_json" \
      '.active == true and ((.events | index("*")) or ($want - .events == []))' \
      <<<"$hook" >/dev/null; then
    local args=(-F active=true)
    for event in "${events[@]}"; do
      args+=(-f "events[]=$event")
    done
    hook="$(gh api --method PATCH "repos/$repo/hooks/$id" "${args[@]}" </dev/null |
      jq -c '{id, active, events}')"
  fi

  active="$(jq -r '.active' <<<"$hook")"
  if [ "$active" != true ]; then
    echo "inactive"
    return
  fi
  missing="$(jq -r --argjson want "$events_json" \
    'if (.events | index("*")) then "" else ($want - .events) | join(", ") end' <<<"$hook")"
  if [ -n "$missing" ]; then
    echo "missing events: $missing"
    return
  fi

  # Only a ping sent now counts: an earlier answer says nothing about the hook today.
  local before after
  before="$(newest_ping "$repo" "$id")"
  gh api --method POST "repos/$repo/hooks/$id/pings" </dev/null >/dev/null
  for ((attempt = 0; attempt < attempts; attempt++)); do
    after="$(newest_ping "$repo" "$id")"
    if [ -n "$after" ] && [ "${after%% *}" != "${before%% *}" ]; then
      local code="${after#* }"
      [ "$code" = 200 ] || echo "ping $code"
      return
    fi
    sleep "$interval"
  done
  echo "ping not delivered"
}

failed=0
while read -r repo || [ -n "$repo" ]; do
  case "$repo" in '' | '#'*) continue ;; esac

  hooks="$(gh api --paginate "repos/$repo/hooks" </dev/null |
    jq -c --arg url "$url" '.[] | select(.config.url == $url) | {id, active, events}')"
  if [ -z "$hooks" ]; then
    echo "$repo: no hook"
    failed=1
    continue
  fi

  # Covered when any matching hook works; otherwise report each one's problem.
  problems=()
  covered=false
  while IFS= read -r hook; do
    problem="$(hook_problem "$repo" "$hook")"
    if [ -z "$problem" ]; then
      covered=true
      break
    fi
    problems+=("$problem")
  done <<<"$hooks"

  if [ "$covered" = false ]; then
    reasons="$(printf '%s; ' "${problems[@]}")"
    echo "$repo: ${reasons%; }"
    failed=1
  fi
done <"$list"

exit "$failed"
