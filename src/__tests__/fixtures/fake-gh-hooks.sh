#!/usr/bin/env bash
# A fake `gh api` for scripts/check-coverage.sh tests. State lives under $FAKE_GH:
#   <owner>/<repo>/hooks.json         the repository's hooks
#   <owner>/<repo>/deliveries-<id>.json  a hook's deliveries, newest first
#   <owner>/<repo>/ping-status-<id>   the status a new ping gets (default 200)
# Every call is appended to $GH_CALLS. No real GitHub API is reached.
set -euo pipefail
printf '%s\n' "$*" >>"$GH_CALLS"

[ "$1" = api ] || { echo "unexpected gh call: $*" >&2; exit 1; }
shift
[ "${1:-}" = --paginate ] && shift
method=GET
if [ "${1:-}" = --method ]; then
  method="$2"
  shift 2
fi
path="$1"
shift

if [[ "$path" =~ ^repos/([^/]+/[^/]+)/hooks(/([0-9]+)(/(deliveries|pings))?)?$ ]]; then
  dir="$FAKE_GH/${BASH_REMATCH[1]}"
  id="${BASH_REMATCH[3]}"
  action="${BASH_REMATCH[5]}"
else
  echo "unexpected gh call: $*" >&2
  exit 1
fi

case "$method:$action" in
  GET:)
    cat "$dir/hooks.json"
    ;;
  GET:deliveries)
    cat "$dir/deliveries-$id.json" 2>/dev/null || echo '[]'
    ;;
  POST:pings)
    deliveries="$(cat "$dir/deliveries-$id.json" 2>/dev/null || echo '[]')"
    status="$(cat "$dir/ping-status-$id" 2>/dev/null || echo 200)"
    jq --argjson status "$status" \
      '[{id: ((map(.id) | max // 0) + 1), event: "ping", status_code: $status}] + .' \
      <<<"$deliveries" >"$dir/deliveries-$id.json"
    ;;
  PATCH:)
    active=null
    events='[]'
    while [ "$#" -gt 0 ]; do
      case "$1:$2" in
        -F:active=*) active="${2#active=}" ;;
        -f:events\[\]=*) events="$(jq -c --arg e "${2#events[]=}" '. + [$e]' <<<"$events")" ;;
        *) echo "unexpected PATCH field: $1 $2" >&2; exit 1 ;;
      esac
      shift 2
    done
    jq --argjson id "$id" --argjson active "$active" --argjson events "$events" \
      'map(if .id == $id then .active = $active | .events = $events else . end)' \
      "$dir/hooks.json" >"$dir/hooks.next" && mv "$dir/hooks.next" "$dir/hooks.json"
    jq --argjson id "$id" '.[] | select(.id == $id)' "$dir/hooks.json"
    ;;
  *)
    echo "unexpected gh call: $method $path" >&2
    exit 1
    ;;
esac
