#!/usr/bin/env bash
# Drive an interactive Pi for live tests: a throwaway one in detached tmux, or an existing herdr pane.
# Targets: tmux:<session> (from `start`) or herdr:<pane-id>.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: pi-live.sh start [cwd]           start Pi in a detached tmux session; prints its target
       pi-live.sh ask <target> <prompt> submit a prompt, wait until Pi settles, print the screen
       pi-live.sh cmd <target> <command> run a slash command (e.g. /reload), print the screen
       pi-live.sh read <target>         print the screen and recent scrollback
       pi-live.sh stop <target>         kill a tmux session started by `start`
EOF
  exit 2
}

PREFIX=pi-live-
TIMEOUT_S=${PI_LIVE_TIMEOUT:-1200}
SETTLE_S=${PI_LIVE_SETTLE:-8}

backend() { printf '%s\n' "${1%%:*}"; }
id() { printf '%s\n' "${1#*:}"; }

screen() {
  case "$(backend "$1")" in
    tmux) tmux capture-pane -p -J -S -300 -t "$(id "$1")" | sed 's/[[:space:]]*$//' ;;
    herdr) herdr agent read "$(id "$1")" ;;
    *) echo "unknown target: $1" >&2; exit 2 ;;
  esac
}

# tmux cannot report Pi's state: settled means the screen stopped changing (the delegate widget ticks).
settle() {
  local target="$1" last="" now stable=0 waited=0
  while [ "$waited" -lt "$TIMEOUT_S" ]; do
    sleep 2; waited=$((waited + 2))
    now="$(screen "$target")"
    if [ "$now" = "$last" ]; then
      stable=$((stable + 2))
      [ "$stable" -ge "$SETTLE_S" ] && return 0
    else
      stable=0; last="$now"
    fi
  done
  echo "timed out after ${TIMEOUT_S}s waiting for Pi to settle" >&2
  return 1
}

send_line() {
  local target="$1" text="$2"
  case "$(backend "$target")" in
    tmux) tmux send-keys -t "$(id "$target")" -l "$text"; sleep 0.3; tmux send-keys -t "$(id "$target")" Enter ;;
    herdr) herdr pane send-text "$(id "$target")" "$text"; herdr pane send-keys "$(id "$target")" Enter ;;
  esac
}

cmd_start() {
  local cwd="${1:-$PWD}" session="$PREFIX$$"
  tmux new-session -d -s "$session" -x 200 -y 60 -c "$cwd" pi
  local target="tmux:$session" waited=0
  until screen "$target" | grep -q 'ctrl+c/ctrl+d'; do
    sleep 1; waited=$((waited + 1))
    [ "$waited" -lt 60 ] || { echo "Pi did not start in $session" >&2; exit 1; }
  done
  settle "$target"
  printf '%s\n' "$target"
}

cmd_ask() {
  local target="$1" prompt="$2"
  case "$(backend "$target")" in
    herdr)
      # A prompt sent while Pi is still reloading is dropped (agent_prompt_stalled): retry once.
      herdr agent prompt "$(id "$target")" "$prompt" --wait --timeout $((TIMEOUT_S * 1000)) >/dev/null ||
        { sleep 3; herdr agent prompt "$(id "$target")" "$prompt" --wait --timeout $((TIMEOUT_S * 1000)) >/dev/null; } ;;
    tmux) send_line "$target" "$prompt"; settle "$target" ;;
    *) usage ;;
  esac
  screen "$target"
}

cmd_cmd() {
  local target="$1" command="$2"
  send_line "$target" "$command"
  sleep 1
  # Autocomplete can take the first Enter; a second one on an empty editor is harmless.
  case "$(backend "$target")" in
    tmux) tmux send-keys -t "$(id "$target")" Enter ;;
    herdr) herdr pane send-keys "$(id "$target")" Enter ;;
  esac
  settle "$target"
  screen "$target"
}

cmd_stop() {
  local target="$1"
  [ "$(backend "$target")" = tmux ] && [[ "$(id "$target")" == "$PREFIX"* ]] ||
    { echo "stop only kills tmux sessions started by start ($PREFIX*)" >&2; exit 2; }
  tmux kill-session -t "$(id "$target")"
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  ask) [ $# -eq 3 ] || usage; cmd_ask "$2" "$3" ;;
  cmd) [ $# -eq 3 ] || usage; cmd_cmd "$2" "$3" ;;
  read) [ $# -eq 2 ] || usage; screen "$2" ;;
  stop) [ $# -eq 2 ] || usage; cmd_stop "$2" ;;
  *) usage ;;
esac
