#!/usr/bin/env sh
# beacon-sdk for shell scripts:  . ./beacon-sdk.sh
# JSON strings are built with printf and a minimal escaper (no jq needed).

_beacon_esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS="\\n"}{print}' | sed 's/\\n$//'; }

# beacon_emit TITLE [SUBTITLE] [VALUE] [ACTION]   (list mode)
beacon_emit() {
  printf '{"title":"%s"' "$(_beacon_esc "$1")"
  [ -n "$2" ] && printf ',"subtitle":"%s"' "$(_beacon_esc "$2")"
  [ -n "$3" ] && printf ',"value":"%s"' "$(_beacon_esc "$3")"
  [ -n "$4" ] && printf ',"action":"%s"' "$(_beacon_esc "$4")"
  printf '}\n'
}

# beacon_notify TITLE [BODY]
beacon_notify() {
  if [ -n "$2" ]; then printf '@@beacon {"type":"notify","title":"%s","body":"%s"}\n' "$(_beacon_esc "$1")" "$(_beacon_esc "$2")"
  else printf '@@beacon {"type":"notify","title":"%s"}\n' "$(_beacon_esc "$1")"; fi
}

# beacon_progress VALUE_0_TO_1 [LABEL]
beacon_progress() {
  if [ -n "$2" ]; then printf '@@beacon {"type":"progress","value":%s,"label":"%s"}\n' "$1" "$(_beacon_esc "$2")"
  else printf '@@beacon {"type":"progress","value":%s}\n' "$1"; fi
}
