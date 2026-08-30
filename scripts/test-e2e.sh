#!/usr/bin/env bash
set -euo pipefail

if [[ ${NIMF_E2E_PRIVATE_BUS:-0} != 1 ]]; then
  exec env NIMF_E2E_PRIVATE_BUS=1 dbus-run-session -- "$0" "$@"
fi

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
test_root=$(mktemp -d /tmp/nimf-shell-e2e.XXXXXX)
page_url=${NIMF_E2E_URL:-file://$project_dir/tests/chromium-fields.html}
page_match=${NIMF_E2E_WINDOW_MATCH:-NIMF-E2E}
test_data="$test_root/data"
test_config="$test_root/config"
test_runtime="$test_root/runtime"
test_nimf_runtime="$test_runtime/nimf"
runtime_override="$test_root/libnimf-runtime-override.so"
test_wayland_display="nimf-e2e-$$"
bridge_uuid='nimf-tiv3@dock-memo.local'
driver_uuid='nimf-e2e-driver@dock-memo.local'
bridge_pid=''
nimf_pid=''
shell_pid=''
chrome_pid=''
host_window_id=''

cleanup() {
  local pid

  pkill -TERM -f -- "--user-data-dir=$test_root/chrome-data" \
    2>/dev/null || true
  for pid in "$chrome_pid" "$shell_pid" "$bridge_pid" "$nimf_pid"; do
    if [[ -n $pid ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  for pid in "$chrome_pid" "$shell_pid" "$bridge_pid" "$nimf_pid"; do
    if [[ -n $pid ]]; then
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

shell_version=$(gnome-shell --version)
case "$shell_version" in
  'GNOME Shell 42.'*)
    bridge_source="$project_dir/extension/extension.js"
    bridge_metadata="$project_dir/extension/metadata.json"
    ;;
  *)
    printf 'E2E driver currently supports GNOME Shell 42 (found: %s).\n' \
      "$shell_version" >&2
    exit 1
    ;;
esac

install -d -m 0700 \
  "$test_data/gnome-shell/extensions/$bridge_uuid" \
  "$test_data/gnome-shell/extensions/$driver_uuid" \
  "$test_config" \
  "$test_runtime" \
  "$test_root/chrome-data"
install -m 0644 "$bridge_metadata" \
  "$test_data/gnome-shell/extensions/$bridge_uuid/metadata.json"
install -m 0644 "$bridge_source" \
  "$test_data/gnome-shell/extensions/$bridge_uuid/extension.js"
install -m 0644 "$project_dir/tests/e2e-driver/metadata.json" \
  "$test_data/gnome-shell/extensions/$driver_uuid/metadata.json"
install -m 0644 "$project_dir/tests/e2e-driver/extension.js" \
  "$test_data/gnome-shell/extensions/$driver_uuid/extension.js"
cc -std=c11 -Wall -Wextra -Werror \
  "$project_dir/tests/focus-x11-window.c" \
  -o "$test_root/focus-x11-window" \
  $(pkg-config --cflags --libs x11)
cc -std=c11 -Wall -Wextra -Werror -fPIC -shared \
  "$project_dir/tests/nimf-runtime-override.c" \
  -o "$runtime_override"

export XDG_DATA_HOME="$test_data"
export XDG_CONFIG_HOME="$test_config"
export XDG_RUNTIME_DIR="$test_runtime"
export GSETTINGS_BACKEND=keyfile

gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions \
  "['$bridge_uuid', '$driver_uuid']"
gsettings set org.gnome.desktop.peripherals.keyboard repeat true
gsettings set org.gnome.desktop.peripherals.keyboard delay 300
gsettings set org.gnome.desktop.peripherals.keyboard repeat-interval 30

env LD_PRELOAD="$runtime_override" \
  NIMF_TEST_RUNTIME_DIR="$test_nimf_runtime" \
  /usr/bin/nimf >"$test_root/nimf.log" 2>&1
for _attempt in $(seq 1 100); do
  if [[ -S $test_nimf_runtime/socket && \
        -r $test_nimf_runtime/lock.pid ]]; then
    nimf_pid=$(tr -d '\0' <"$test_nimf_runtime/lock.pid")
    break
  fi
  sleep 0.1
done
if [[ ! $nimf_pid =~ ^[0-9]+$ ]] || \
   ! ps -p "$nimf_pid" -o comm= | rg -qx 'nimf'; then
  printf 'Private Nimf daemon did not start. Logs: %s\n' "$test_root" >&2
  sed -n '1,120p' "$test_root/nimf.log" >&2
  exit 1
fi
printf 'Private Nimf daemon: pid=%s runtime=%s\n' \
  "$nimf_pid" "$test_runtime"

env NIMF_E2E=1 \
  LD_PRELOAD="$runtime_override" \
  NIMF_TEST_RUNTIME_DIR="$test_nimf_runtime" \
  "$project_dir/build/nimf-shell-bridge" \
  >"$test_root/bridge.log" 2>&1 &
bridge_pid=$!

gnome-shell --wayland --nested \
  --no-x11 --sm-disable --mode=ubuntu \
  --wayland-display="$test_wayland_display" \
  >"$test_root/gnome-shell.log" 2>&1 &
shell_pid=$!

driver_call() {
  gdbus call --session \
    --dest org.nimf.E2EDriver \
    --object-path /org/nimf/E2EDriver \
    --method "org.nimf.E2EDriver1.$1" "${@:2}"
}

wait_for_driver() {
  local attempt

  for attempt in $(seq 1 100); do
    if driver_call ListWindows >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

window_list() {
  driver_call ListWindows
}

wait_for_window() {
  local match=$1
  local attempt
  local windows

  for attempt in $(seq 1 200); do
    windows=$(window_list 2>/dev/null || true)
    if [[ $windows == *"$match"* ]]; then
      printf '%s\n' "$windows"
      return 0
    fi
    sleep 0.1
  done
  return 1
}

keyval() {
  driver_call Keyval "$1" >/dev/null
  sleep 0.04
}

keyval_nowait() {
  driver_call Keyval "$1" >/dev/null
}

clear_focused_text() {
  driver_call KeyState 65507 true >/dev/null
  keyval 97
  driver_call KeyState 65507 false >/dev/null
  keyval 65288
}

type_dtd() {
  keyval 100
  keyval 116
  keyval 100
  sleep 0.25
}

establish_chrome_korean_preedit() {
  local attempt
  local probe

  for attempt in $(seq 1 8); do
    refresh_host_offset
    focus_field html 130
    clear_focused_text
    type_dtd
    probe=$(window_list)
    if [[ $probe == *'NIMF-E2E|ㅇㅅㅇ|||html|'* ]]; then
      return 0
    fi
    if [[ $probe == *'NIMF-E2E|dtd|||html|'* ]]; then
      clear_focused_text
      keyval 65329
    fi
    sleep 0.35
  done

  printf '%s\n' "$probe"
  return 1
}

click_window() {
  driver_call Click "$1" "$2" "$3" >/dev/null
  sleep 0.35
}

focus_field() {
  local field=$1
  local x=$2
  local probe

  for _attempt in 1 2 3; do
    click_window 'NIMF-E2E' "$x" 300
    probe=$(window_list)
    if [[ $probe == *"|$field|"* ]]; then
      return 0
    fi
    refresh_host_offset
  done

  printf 'Could not focus Chrome %s field: %s\n' "$field" "$probe" >&2
  return 1
}

if ! wait_for_driver; then
  printf 'Nested GNOME Shell E2E driver did not start. Logs: %s\n' \
    "$test_root" >&2
  tail -100 "$test_root/gnome-shell.log" >&2
  exit 1
fi

host_position=''
for _attempt in $(seq 1 100); do
  for window_id in $(xwininfo -root -tree 2>/dev/null | \
      sed -n 's/^[[:space:]]*\(0x[0-9a-fA-F]*\).*/\1/p'); do
    window_pid=$(xprop -id "$window_id" _NET_WM_PID 2>/dev/null | \
      sed -n 's/.*= //p')
    if [[ $window_pid == "$shell_pid" ]]; then
      window_geometry=$(xwininfo -id "$window_id" 2>/dev/null | \
        awk '/Absolute upper-left X:/{x=$NF} \
             /Absolute upper-left Y:/{y=$NF} \
             /Width:/{w=$NF} /Height:/{h=$NF} \
             END{if (x != "" && y != "") print x, y, w, h}')
      read -r window_x window_y window_width window_height \
        <<<"$window_geometry"
      if ((window_width >= 700 && window_height >= 500)); then
        host_position="$window_x $window_y"
        host_window_id=$window_id
        break
      fi
    fi
  done
  if [[ -n $host_position ]]; then
    break
  fi
  sleep 0.1
done
if [[ -z $host_position ]]; then
  printf 'Could not locate the nested GNOME Shell host window. Logs: %s\n' \
    "$test_root" >&2
  exit 1
fi
read -r host_x host_y <<<"$host_position"
driver_call SetHostOffset "$host_x" "$host_y" >/dev/null
printf 'Nested GNOME Shell host: %s offset %s,%s\n' \
  "$host_window_id" "$host_x" "$host_y"

refresh_host_offset() {
  local geometry

  geometry=$(xwininfo -id "$host_window_id" 2>/dev/null | \
    awk '/Absolute upper-left X:/{x=$NF} \
         /Absolute upper-left Y:/{y=$NF} \
         END{if (x != "" && y != "") print x, y}')
  read -r host_x host_y <<<"$geometry"
  driver_call SetHostOffset "$host_x" "$host_y" >/dev/null
  "$test_root/focus-x11-window" "$host_window_id"
}

chrome_log="$test_root/chrome.log"
chrome_args=(
  --user-data-dir="$test_root/chrome-data" \
  --no-first-run \
  --disable-default-apps \
  --disable-extensions \
  --disable-sync \
  --disable-gpu \
  --password-store=basic \
  --ozone-platform=wayland \
  --enable-wayland-ime \
  --wayland-text-input-version=3 \
  --remote-debugging-port=0 \
  --window-size=1024,768
)
if [[ $page_url == file://* ]]; then
  chrome_args+=(--app="$page_url")
else
  chrome_args+=("$page_url")
fi
env WAYLAND_DISPLAY="$test_wayland_display" \
  /opt/google/chrome/chrome "${chrome_args[@]}" \
  >"$chrome_log" 2>&1 &
chrome_pid=$!

if ! wait_for_window "$page_match"; then
  printf 'Chrome test page did not appear. Logs: %s\n' "$test_root" >&2
  tail -100 "$chrome_log" >&2
  exit 1
fi
driver_call ActivateMaximize "$page_match" >/dev/null
sleep 0.5
refresh_host_offset
if [[ ${NIMF_E2E_HOLD:-0} == 1 ]]; then
  screenshot_path="$test_root/screenshot.png"
  driver_call Screenshot "$screenshot_path" >/dev/null
  printf 'Interactive E2E ready: root=%s screenshot=%s\n' \
    "$test_root" "$screenshot_path"
  while kill -0 "$chrome_pid" 2>/dev/null; do
    sleep 5
  done
  exit 0
fi
if ! chrome_mode_probe=$(establish_chrome_korean_preedit); then
  printf 'Could not establish Korean preedit in Chrome: %s\n' \
    "$chrome_mode_probe" >&2
  exit 1
fi

clear_focused_text
keyval_nowait 97
keyval_nowait 97
keyval_nowait 97
sleep 0.25
driver_call KeyState 65288 true >/dev/null
sleep 0.1
driver_call KeyState 65288 false >/dev/null
sleep 0.25
chrome_backspace_tap=$(window_list)
printf 'Chrome Backspace tap on preedit: %s\n' "$chrome_backspace_tap"
if [[ $chrome_backspace_tap != *'NIMF-E2E|ㅁㅁ|||html|'* ]]; then
  printf 'Chrome Backspace tap test failed. Logs: %s\n' \
    "$test_root" >&2
  exit 1
fi

clear_focused_text
keyval_nowait 97
keyval_nowait 97
keyval_nowait 97
sleep 0.25
driver_call KeyState 65288 true >/dev/null
sleep 1.2
driver_call KeyState 65288 false >/dev/null
sleep 0.25
chrome_backspace_repeat=$(window_list)
printf 'Chrome Backspace repeat after preedit deletion: %s\n' \
  "$chrome_backspace_repeat"
if [[ $chrome_backspace_repeat != *'NIMF-E2E||||html|'* ]]; then
  printf 'Chrome Backspace repeat test failed. Logs: %s\n' \
    "$test_root" >&2
  exit 1
fi

for _repeat_key in 1 2 3 4; do
  keyval_nowait 97
done
sleep 0.25
chrome_repeated_consonant=$(window_list)
printf 'Chrome rapid repeated consonant: %s\n' \
  "$chrome_repeated_consonant"
if [[ $chrome_repeated_consonant != *'NIMF-E2E|ㅁㅁㅁㅁ|||html|'* ]]; then
  printf 'Chrome rapid repeated consonant test failed. Logs: %s\n' \
    "$test_root" >&2
  exit 1
fi
clear_focused_text

for punctuation_key in 97 106 100 105; do
  keyval_nowait "$punctuation_key"
done
driver_call KeyState 65505 true >/dev/null
keyval_nowait 33
driver_call KeyState 65505 false >/dev/null
for punctuation_key in 100 108 114 106 115; do
  keyval_nowait "$punctuation_key"
done
driver_call KeyState 65505 true >/dev/null
keyval_nowait 63
driver_call KeyState 65505 false >/dev/null
sleep 0.25
chrome_punctuation_commit=$(window_list)
printf 'Chrome Hangul + punctuation ordering: %s\n' \
  "$chrome_punctuation_commit"
if [[ $chrome_punctuation_commit != *'NIMF-E2E|머야!이건?|||html|'* ]]; then
  printf 'Chrome punctuation commit ordering test failed. Logs: %s\n' \
    "$test_root" >&2
  exit 1
fi
clear_focused_text

for space_key in 97 110 106 100 105 32 100 108 114 106 115; do
  keyval_nowait "$space_key"
done
sleep 0.25
chrome_hangul_space=$(window_list)
printf 'Chrome Hangul + Space ordering: %s\n' "$chrome_hangul_space"
if [[ $chrome_hangul_space != *'NIMF-E2E|뭐야 이건|||html|'* ]]; then
  printf 'Chrome Hangul/Space ordering test failed. Logs: %s\n' \
    "$test_root" >&2
  exit 1
fi
keyval_nowait 32
sleep 0.25
clear_focused_text

keyval_nowait 122
keyval_nowait 122
keyval_nowait 122
keyval_nowait 122
keyval_nowait 32
sleep 0.25
chrome_space_commit=$(window_list)
printf 'Chrome consonant preedit + Space: %s\n' "$chrome_space_commit"
if [[ $chrome_space_commit != *'NIMF-E2E|ㅋㅋㅋㅋ |||html|'* ]]; then
  printf 'Chrome Space commit ordering test failed. Logs: %s\n' \
    "$test_root" >&2
  exit 1
fi

keyval_nowait 100
sleep 0.25
chrome_space_next_preedit=$(window_list)
printf 'Chrome consonant preedit + Space + next preedit: %s\n' \
  "$chrome_space_next_preedit"
if [[ $chrome_space_next_preedit != *'NIMF-E2E|ㅋㅋㅋㅋ ㅇ|||html|'* ]]; then
  printf 'Chrome Space/next-preedit ordering test failed. Logs: %s\n' \
    "$test_root" >&2
  exit 1
fi
keyval_nowait 32
sleep 0.25
clear_focused_text
type_dtd

for pass in 1 2 3; do
  focus_field css 365
  chrome_forward_one=$(window_list)
  printf 'Chrome HTML -> CSS focus change %s: %s\n' \
    "$pass" "$chrome_forward_one"
  if [[ $chrome_forward_one != *'NIMF-E2E|ㅇㅅㅇ|||css|'* ]]; then
    printf 'Chrome HTML -> CSS preedit commit test failed. Logs: %s\n' \
      "$test_root" >&2
    exit 1
  fi

  type_dtd
  focus_field js 600
  chrome_forward_two=$(window_list)
  printf 'Chrome CSS -> JS focus change %s: %s\n' \
    "$pass" "$chrome_forward_two"
  if [[ $chrome_forward_two != *'NIMF-E2E|ㅇㅅㅇ|ㅇㅅㅇ||js|'* ]]; then
    printf 'Chrome CSS -> JS preedit commit test failed. Logs: %s\n' \
      "$test_root" >&2
    exit 1
  fi

  clear_focused_text
  focus_field css 365
  clear_focused_text
  focus_field html 130
  clear_focused_text
  focus_field js 600
  type_dtd
  focus_field css 365
  chrome_reverse_one=$(window_list)
  printf 'Chrome JS -> CSS focus change %s: %s\n' \
    "$pass" "$chrome_reverse_one"
  if [[ $chrome_reverse_one != *'NIMF-E2E|||ㅇㅅㅇ|css|'* ]]; then
    printf 'Chrome JS -> CSS preedit commit test failed. Logs: %s\n' \
      "$test_root" >&2
    exit 1
  fi

  type_dtd
  focus_field html 130
  chrome_reverse_two=$(window_list)
  printf 'Chrome CSS -> HTML focus change %s: %s\n' \
    "$pass" "$chrome_reverse_two"
  if [[ $chrome_reverse_two != *'NIMF-E2E||ㅇㅅㅇ|ㅇㅅㅇ|html|'* ]]; then
    printf 'Chrome CSS -> HTML preedit commit test failed. Logs: %s\n' \
      "$test_root" >&2
    exit 1
  fi

  if [[ $pass -lt 3 ]]; then
    clear_focused_text
    focus_field css 365
    clear_focused_text
    focus_field js 600
    clear_focused_text
    focus_field html 130
    type_dtd
  fi
done

pkill -TERM -f -- "--user-data-dir=$test_root/chrome-data" \
  2>/dev/null || true
wait "$chrome_pid" 2>/dev/null || true
chrome_pid=''

printf 'E2E logs: %s\n' "$test_root"
printf '%s\n' \
  'Isolated Nimf + nested GNOME Shell + Wayland Chrome bidirectional commit: OK'
