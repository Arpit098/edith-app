#!/usr/bin/env bash
# CI emulator job (.github/workflows/notifications.yml): posts each notification state from
# states.json through the debug build's DebugNotificationsReceiver, screenshots it (status bar and
# shade), and checks the behaviour around it:
#   - the foreground service runs while a turn is in progress or an approval waits, and stops after;
#   - Allow on the approval notification reaches the App API (mock-api.py) without opening the app;
#   - tapping a notification twice opens the one EDITH activity, never a second copy.
#
# Usage: post-states.sh <debug apk> <states.json> <screenshot dir> <mock api log>
#
# Waiting: adb has no way to subscribe to the notification shade or a service, so this polls
# `dumpsys` with a doubling delay (0.2 s → 2 s) and a 20 s timeout per wait. Unavoidable here, and
# CI-only; the app itself never polls.
set -euo pipefail

APK=$1 STATES=$2 OUT=$3 API_LOG=$4
PKG=com.arpit.edith
RECEIVER=$PKG/com.arpit.edith.system.DebugNotificationsReceiver
mkdir -p "$OUT"
FAILED=()

# On the way out (pass or fail): what Android has, for the artifact.
on_exit() {
  adb shell dumpsys notification --noredact >"$OUT/dumpsys-notification.txt" 2>&1 || true
  adb shell dumpsys activity services "$PKG" >"$OUT/dumpsys-services.txt" 2>&1 || true
}
trap on_exit EXIT

wait_until() { # <description> <command…>: until the command succeeds
  local what=$1 delay=0.2 deadline=$((SECONDS + 20))
  shift
  until "$@" >/dev/null 2>&1; do
    if ((SECONDS > deadline)); then
      echo "::error::timed out waiting for $what"
      return 1
    fi
    sleep "$delay"
    delay=$(awk -v d="$delay" 'BEGIN { d *= 2; print (d > 2 ? 2 : d) }')
  done
}

has_title() { adb shell dumpsys notification --noredact | grep -qF "android.title=String ($1)"; }
has_text() { adb shell dumpsys notification --noredact | grep -qF "$1"; }
service_running() { adb shell dumpsys activity services "$PKG" | grep -q "EdithSessionService"; }
service_stopped() { ! service_running; }
# What is on screen, from uiautomator (the shade isn't a focused window on Android 16, so `dumpsys
# window` can't tell whether it is open).
ui() { adb shell uiautomator dump /sdcard/ui.xml >/dev/null && adb exec-out cat /sdcard/ui.xml; }
on_screen() { ui | grep -qF "text=\"$1\""; }
off_screen() { ! on_screen "$1"; }
top_activity() { adb shell dumpsys activity activities | grep -m1 -E "topResumedActivity|ResumedActivity:"; }
launcher_on_top() { top_activity | grep -qi launcher; }
edith_on_top() { top_activity | grep -qF "$PKG/"; }
home() {
  adb shell input keyevent KEYCODE_HOME
  wait_until "the launcher" launcher_on_top
}
logged() { grep -qF "$1" "$API_LOG"; }

# A screenshot once two frames in a row match (the shade has settled), at most 10 tries.
shot() {
  local file="$OUT/$1.png" prev="" now delay=0.2
  for _ in $(seq 10); do
    adb exec-out screencap -p >"$file.tmp"
    now=$(md5sum <"$file.tmp")
    [ "$now" = "$prev" ] && break
    prev=$now
    sleep "$delay"
    delay=$(awk -v d="$delay" 'BEGIN { d *= 2; print (d > 1 ? 1 : d) }')
  done
  mv "$file.tmp" "$file"
  echo "screenshot $1.png"
}

# Both views of the current state: the status bar (Live Updates chip) and the open shade, which is
# open once the notification's title ($2) is on screen.
# A failed check here is recorded and the run goes on, so every state still gets its screenshots
# (plus the screen's UI tree, to see why); the job fails at the end.
shots() {
  adb shell cmd statusbar collapse
  wait_until "the shade to close" off_screen "$2" || FAILED+=("$1: shade did not close")
  shot "$1-statusbar"
  adb shell cmd statusbar expand-notifications
  if ! wait_until "the shade to show \"$2\"" on_screen "$2"; then
    FAILED+=("$1: \"$2\" not in the shade")
    ui >"$OUT/$1-shade-ui.xml" || true
  fi
  shot "$1-shade"
  adb shell cmd statusbar collapse
}

# Tap the centre of the first on-screen node whose text or description is $1 (uiautomator).
tap() {
  local xy
  xy=$(ui | python3 -c '
import re, sys, xml.etree.ElementTree as ET
want = sys.argv[1].lower()
for n in ET.parse(sys.stdin).iter("node"):
    if want in (n.get("text", "").lower(), n.get("content-desc", "").lower()):
        x1, y1, x2, y2 = map(int, re.findall(r"\d+", n.get("bounds")))
        print((x1 + x2) // 2, (y1 + y2) // 2)
        break
' "$1")
  [ -n "$xy" ] || { echo "::error::no \"$1\" on screen"; return 1; }
  adb shell input tap $xy
}

send() { # <kind> [json]
  if [ $# -gt 1 ]; then
    adb shell am broadcast -n "$RECEIVER" --es kind "$1" --es payload "$(printf '%s' "$2" | base64 -w0)" >/dev/null
  else
    adb shell am broadcast -n "$RECEIVER" --es kind "$1" >/dev/null
  fi
}

activities() { adb shell dumpsys activity activities | grep -cE "Hist +#[0-9]+: ActivityRecord\{[^}]*$PKG/" || true; }

adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
home # boot is over once the launcher is up (a screenshot before that is black)
adb install -r -g "$APK" # -g: POST_NOTIFICATIONS granted, as after Arpit's "Allow"
adb shell settings put global heads_up_notifications_enabled 0 # heads-up pop-ups would cover the status bar
adb shell am start -W -n "$PKG/.MainActivity" >/dev/null # in the foreground, as when Arpit sends a message:
# Android allows the foreground service only then. (The debug build's JS shows a dev error screen
# here: there is no Metro; the notifications are all native.)

now_ms=$(($(date +%s) * 1000))
count=$(jq '.states | length' "$STATES")
for i in $(seq 0 $((count - 1))); do
  state=$(jq -c ".states[$i]" "$STATES")
  name=$(jq -r .name <<<"$state")
  kind=$(jq -r .kind <<<"$state")
  # The turn started 42 s ago, whatever the clock says.
  payload=$(jq -c --argjson now "$now_ms" '.payload | if .startedAt then .startedAt = ($now - 42000) else . end' <<<"$state")
  echo "::group::$name"
  send "$kind" "$payload"
  wait_until "$name to show" has_title "$(jq -r .title <<<"$payload")"
  if [ "$kind" = status ]; then
    if [ "$(jq -r .keepAlive <<<"$payload")" = true ]; then
      wait_until "the foreground service to run ($name)" service_running
    else
      wait_until "the foreground service to stop ($name)" service_stopped
    fi
    [ "$i" = 0 ] && home # EDITH in the background from here on
  fi
  shots "$((i + 1))-$name" "$(jq -r .title <<<"$payload")"
  echo "::endgroup::"
  if [ "$name" = status-speaking ]; then
    send clear
    wait_until "the live status to clear" bash -c "! adb shell dumpsys notification --noredact | grep -qF 'android.title=String (EDITH is speaking)'"
  fi
done

echo "::group::Allow from the notification, without opening the app"
# Only the approval left, so the shade shows it expanded with its buttons.
for tag in $(jq -r '.states[] | select(.kind == "notify" and .payload.channel != "approvals") | .payload.tag' "$STATES"); do
  send cancel "$tag"
done
wait_until "the other notifications to go" bash -c "! adb shell dumpsys notification --noredact | grep -qF 'android.title=String (EDITH replied)'"
adb shell cmd statusbar expand-notifications
wait_until "the shade to show Allow" on_screen Allow
tap Allow
wait_until "the Allow to reach the App API" logged "permission p2 allow=true"
wait_until "the notification to say Allowed" has_text "Allowed"
shot "$((count + 1))-approval-allowed-shade"
if edith_on_top; then echo "::error::Allow opened EDITH"; exit 1; fi
adb shell cmd statusbar collapse
echo "::endgroup::"

echo "::group::A tapped notification opens the one EDITH activity"
reply=$(jq -c '.states[] | select(.name == "notify-reply") | .payload' "$STATES")
for n in 1 2; do
  send notify "$reply"
  wait_until "the reply notification" has_title "EDITH replied"
  adb shell cmd statusbar expand-notifications
  wait_until "the shade to show the reply" on_screen "EDITH replied"
  tap "EDITH replied"
  wait_until "EDITH to come forward ($n)" edith_on_top
  home
done
found=$(activities)
echo "EDITH activities: $found"
[ "$found" = 1 ] || { echo "::error::expected one EDITH activity, found $found"; exit 1; }
echo "::endgroup::"

if ((${#FAILED[@]})); then
  printf '::error::%s\n' "${FAILED[@]}"
  exit 1
fi
