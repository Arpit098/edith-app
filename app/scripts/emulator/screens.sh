#!/usr/bin/env bash
# CI screens job (.github/workflows/screens.yml), for Arpit's approval of Phase 2b (PLAN.md §4.11):
# a release-mode APK on an Android 16 emulator, connected to the demo App API (demo-api.py), and:
#   - screenshots of the main screens with real glass, and one with battery saver on (flat glass);
#   - frame times (dumpsys gfxinfo) for the same scripted scrolling and tab switching, glass on and
#     off. An emulator renders with SwiftShader (the CPU), so these numbers are only comparable with
#     each other: phone numbers come from Settings → Performance on the 13R;
#   - a short screen recording: tab switches (the droplet), scrolling under the glass, the attach menu.
#
# Usage: screens.sh <apk> <out dir>
#
# Waiting: adb can't subscribe to what's on screen, so this polls uiautomator with a doubling delay
# (0.2 s → 2 s) and a 30 s timeout per wait. CI-only; the app itself never polls. The pauses in the
# recording are there so a person can follow it, not to wait for anything.
set -euo pipefail

APK=$1 OUT=$2
PKG=com.arpit.edith
mkdir -p "$OUT"

wait_until() { # <description> <command…>
  local what=$1 delay=0.2 deadline=$((SECONDS + ${WAIT_S:-30}))
  shift
  until "$@" >/dev/null 2>&1; do
    dismiss_anr
    if ((SECONDS > deadline)); then
      echo "::error::timed out waiting for $what"
      ui >"$OUT/timeout-ui.xml" || true
      adb exec-out screencap -p >"$OUT/timeout.png" || true
      save_logs timeout
      return 1
    fi
    sleep "$delay"
    delay=$(awk -v d="$delay" 'BEGIN { d *= 2; print (d > 2 ? 2 : d) }')
  done
}

# The device log since EDITH started (logcat is cleared just before): the whole log, and what
# matters for a stuck or crashing app (its JS console and errors, React Native, crashes, native
# aborts), also printed into the job log. Plus whether the app process is still alive.
save_logs() {
  local tag=$1
  adb logcat -d -v time >"$OUT/logcat-$tag-all.txt" 2>&1 || true
  adb logcat -d -v time ReactNativeJS:V ReactNative:V ReactNativeJNI:V AndroidRuntime:V DEBUG:V libc:F ActivityManager:W '*:S' >"$OUT/logcat-$tag.txt" 2>&1 || true
  grep -E "FATAL|Exception|Error|crash|$PKG" "$OUT/logcat-$tag-all.txt" | grep -v "uiautomator" | tail -80 >>"$OUT/logcat-$tag.txt" || true
  echo "EDITH process: $(adb shell pidof "$PKG" || echo 'not running')" | tee -a "$OUT/logcat-$tag.txt"
  echo "::group::logcat ($tag)"
  tail -120 "$OUT/logcat-$tag.txt"
  echo "::endgroup::"
}
# uiautomator dumps only a UI that goes idle; when it can't, it fails and leaves the last file
# behind, so the old one is deleted first (a stale screen must never pass for the current one).
ui() { adb shell rm -f /sdcard/ui.xml && adb shell uiautomator dump /sdcard/ui.xml >/dev/null && adb exec-out cat /sdcard/ui.xml; }
# A CPU-rendered emulator is slow enough that System UI (or another app) sometimes hits an ANR
# right after boot; its "isn't responding" dialog covers the screen. Answer "Wait" and go on.
dismiss_anr() {
  if ui | grep -qF "isn't responding"; then
    echo "an ANR dialog: Wait"
    tap Wait || true
  fi
}
on_screen() { ui | grep -qF "=\"$1\""; } # a node's text or content-desc
top_activity() { adb shell dumpsys activity activities | grep -m1 -E "topResumedActivity|ResumedActivity:"; }
launcher_on_top() { top_activity | grep -qi launcher; }
keyboard_shown() { adb shell dumpsys input_method | grep -q "mInputShown=true"; }

# Navigate with the header's menu (top right): open it, pick the screen (its item says
# "<name>, current screen" when it's the one shown).
go_to() {
  tap Menu || return 1
  wait_until "the menu" on_screen "Close the menu" || return 1
  if on_screen "$1, current screen"; then tap "$1, current screen" || return 1; else tap "$1" || return 1; fi
  wait_until "the menu to close" on_screen Menu
}

# Tap the centre of the first node whose content-desc (or, failing that, text) is $1.
tap() {
  local xy
  xy=$(ui | python3 -c '
import re, sys, xml.etree.ElementTree as ET
want = sys.argv[1]
nodes = list(ET.parse(sys.stdin).iter("node"))
for attr in ("content-desc", "text"):
    for n in nodes:
        if n.get(attr) == want:
            x1, y1, x2, y2 = map(int, re.findall(r"\d+", n.get("bounds")))
            print((x1 + x2) // 2, (y1 + y2) // 2)
            sys.exit()
' "$1")
  [ -n "$xy" ] || { echo "::error::no \"$1\" on screen"; return 1; }
  adb shell input tap $xy
}

# A screenshot once two frames in a row match (springs have settled), at most 12 tries.
shot() {
  local file="$OUT/$1.png" prev="" now delay=0.2
  dismiss_anr
  for _ in $(seq 12); do
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

read -r W H < <(adb shell wm size | sed -n 's/.*: \([0-9]*\)x\([0-9]*\).*/\1 \2/p' | tail -1)
scroll_up() { adb shell input swipe $((W / 2)) $((H * 35 / 100)) $((W / 2)) $((H * 70 / 100)) "${1:-400}"; } # older messages
scroll_down() { adb shell input swipe $((W / 2)) $((H * 70 / 100)) $((W / 2)) $((H * 35 / 100)) "${1:-400}"; }

# Scroll the current screen down until $1 is on it (Settings is longer than the screen), at most 6 swipes.
scroll_to() {
  for _ in 1 2 3 4 5 6; do
    on_screen "$1" && return 0
    adb shell input swipe $((W / 2)) $((H * 75 / 100)) $((W / 2)) $((H * 30 / 100)) 300
  done
  wait_until "\"$1\" on screen" on_screen "$1"
}

battery_saver() { # on|off: the glass goes flat while it's on (edith-glass's PowerManager broadcast)
  if [ "$1" = on ]; then
    adb shell dumpsys battery unplug
    adb shell settings put global low_power 1
  else
    adb shell settings put global low_power 0
    adb shell dumpsys battery reset
  fi
}

# Frame times for one scripted run: scroll the transcript up and down, then go round the tabs.
measure() {
  local label=$1
  go_to Live || return 1
  wait_until "the live tab" on_screen "Now run the server tests and tell me if anything fails" || return 1
  adb shell dumpsys gfxinfo "$PKG" reset >/dev/null
  for _ in 1 2 3; do
    scroll_up 300
    scroll_down 300
  done
  for t in Sessions Tools Settings Live; do go_to "$t" || return 1; done
  adb shell dumpsys gfxinfo "$PKG" >"$OUT/gfxinfo-$label.txt"
  {
    echo "#### $label"
    grep -E "Total frames rendered|Janky frames|50th percentile|90th percentile|95th percentile|99th percentile" "$OUT/gfxinfo-$label.txt" | head -6 | sed 's/^/    /'
  } >>"$OUT/frames.md"
}

# A clean status bar: a fixed clock, full signal and battery, no notifications.
adb shell settings put global sysui_demo_allowed 1
demo() { adb shell am broadcast -a com.android.systemui.demo -e command "$@" >/dev/null; }

adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
# Let the fresh image settle before the app starts: no crash/ANR dialogs over the screen, no
# package verification, and the post-boot app compilation done now (bounded) instead of under us.
adb shell settings put global hide_error_dialogs 1
adb shell settings put global package_verifier_enable 0
timeout 600 adb shell cmd package bg-dexopt-job >/dev/null 2>&1 || echo "bg-dexopt-job didn't finish in 10 min: going on"
adb shell input keyevent KEYCODE_HOME
wait_until "the launcher" launcher_on_top
adb install -r -g "$APK"
demo enter
demo clock -e hhmm 0930
demo battery -e level 100 -e plugged false
demo network -e wifi show -e level 4
demo notifications -e visible false

adb logcat -c || true # from here, the log is EDITH's start
adb shell am start -W -n "$PKG/.MainActivity" >/dev/null
WAIT_S=90 wait_until "the connect screen" on_screen "Server address"
shot 00-connect
tap "Server address"
adb shell input text "10.0.2.2:8787"
tap "Token"
adb shell input text "ci-token"
keyboard_shown && adb shell input keyevent KEYCODE_BACK
tap Connect
wait_until "the live session" on_screen "Now run the server tests and tell me if anything fails"
keyboard_shown && adb shell input keyevent KEYCODE_BACK

screenshots() {
shot 01-live
# The status card open over the long chat (Arpit's second screenshot): tap the pill, shoot, close.
tap Idle || return 1
wait_until "the status card" on_screen "edith-notify" || return 1
shot 01b-status-card-open
tap Idle || return 1
scroll_up
shot 02-live-scrolled-under-the-glass
scroll_down
# Arpit's first screenshot: back at the end, then a short drag so the long reply sits under the composer.
adb shell input swipe $((W / 2)) $((H * 45 / 100)) $((W / 2)) $((H * 62 / 100)) 400
shot 02b-composer-over-the-long-reply
scroll_down
go_to Sessions || return 1
wait_until "sessions" on_screen "Morning briefing" || return 1
shot 03-sessions
go_to Tools || return 1
shot 04-tools
go_to Settings || return 1
scroll_to "Measure frames" || return 1
shot 05-settings
go_to Live || return 1
tap "Attach a photo or audio file" || return 1
wait_until "the attach menu" on_screen "Camera" || return 1
shot 06-attach-menu
tap "Close the attach menu" || return 1
tap Menu || return 1
wait_until "the menu" on_screen "Close the menu" || return 1
shot 06b-navigation-menu-open
tap "Close the menu" || return 1
battery_saver on
go_to Settings || return 1
scroll_to "Glass: flat" || return 1
go_to Live || return 1
shot 07-live-battery-saver-flat
battery_saver off
}

frames() {
echo "### Frame times on the emulator (SwiftShader: compare the two runs, not with a phone)" >"$OUT/frames.md"
measure glass || return 1
battery_saver on
measure flat-battery-saver || return 1
battery_saver off
cat "$OUT/frames.md"
}

recording() {
go_to Live || return 1
wait_until "the live tab" on_screen "Now run the server tests and tell me if anything fails" || return 1
adb shell screenrecord --time-limit 90 --bit-rate 8000000 /sdcard/clip.mp4 &
rec=$!
sleep 1.5
for t in Sessions Tools Settings Live; do
  go_to "$t" || return 1
  sleep 1.4
done
scroll_up 700
sleep 1
scroll_up 700
sleep 1
scroll_down 700
sleep 1
scroll_down 700
sleep 1
tap "Attach a photo or audio file" || return 1
sleep 1.5
tap "Close the attach menu" || return 1
sleep 1
go_to Sessions || return 1
sleep 1.2
go_to Live || return 1
# Last, the task starts (the demo API's /demo/work): the working blob and the spinner. From here
# the UI never goes idle, so nothing reads the screen with uiautomator after this.
curl -s -X POST localhost:8787/demo/work >/dev/null
wait $rec || true
adb pull /sdcard/clip.mp4 "$OUT/phase-2b-clip.mp4"
shot 08-live-working # the task running: blob, spinner, the status pill's step
}
# Each part runs even if one before it failed (a failure is recorded, its screen saved), so the
# artifact always has what could be made; the job fails at the end.
FAILED=()
for part in screenshots frames recording; do
  echo "::group::$part"
  if ! "$part"; then
    FAILED+=("$part")
    adb exec-out screencap -p >"$OUT/failed-$part.png" || true
    save_logs "$part"
    battery_saver off || true
  fi
  echo "::endgroup::"
done
demo exit
if ((${#FAILED[@]})); then
  echo "::error::failed: ${FAILED[*]}"
  exit 1
fi
