#!/usr/bin/env bash
set -euo pipefail

if [[ ${NIMF_NESTED_PRIVATE_BUS:-0} != 1 ]]; then
  exec env NIMF_NESTED_PRIVATE_BUS=1 dbus-run-session -- "$0" "$@"
fi

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
test_root=$(mktemp -d /tmp/nimf-shell-nested.XXXXXX)
test_data="$test_root/data"
test_config="$test_root/config"
extension_uuid='nimf-tiv3@dock-memo.local'
test_wayland_display="nimf-test-$$"
shell_version=$(gnome-shell --version)

case "$shell_version" in
  'GNOME Shell 42.'*)
    extension_source="$project_dir/extension/extension.js"
    metadata_source="$project_dir/extension/metadata.json"
    ;;
  'GNOME Shell 46.'*)
    extension_source="$project_dir/extension/extension-46.js"
    metadata_source="$project_dir/extension/metadata-46.json"
    ;;
  *)
    printf 'Nested test supports GNOME Shell 42 and 46 (found: %s).\n' \
      "$shell_version" >&2
    exit 1
    ;;
esac

install -d -m 0700 "$test_data/gnome-shell/extensions/$extension_uuid"
install -d -m 0700 "$test_config"
install -m 0644 "$metadata_source" \
  "$test_data/gnome-shell/extensions/$extension_uuid/metadata.json"
install -m 0644 "$extension_source" \
  "$test_data/gnome-shell/extensions/$extension_uuid/extension.js"

export XDG_DATA_HOME="$test_data"
export XDG_CONFIG_HOME="$test_config"
export GSETTINGS_BACKEND=keyfile

gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['$extension_uuid']"

"$project_dir/build/nimf-shell-bridge" >"$test_root/bridge.log" 2>&1 &
bridge_pid=$!
trap 'kill "$bridge_pid" 2>/dev/null || true' EXIT

for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  if gdbus call --session \
      --dest org.nimf.ShellBridge \
      --object-path /org/nimf/ShellBridge \
      --method org.nimf.ShellBridge1.Ping >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

set +e
timeout --signal=TERM 15s \
  gnome-shell --wayland --nested --no-x11 --sm-disable --mode=ubuntu \
  --wayland-display="$test_wayland_display" \
  >"$test_root/gnome-shell.log" 2>&1
shell_status=$?
set -e

kill "$bridge_pid" 2>/dev/null || true
wait "$bridge_pid" 2>/dev/null || true
trap - EXIT

printf 'Nested test logs: %s\n' "$test_root"
rg -n 'Nimf text-input-v3|nimf-tiv3|JS ERROR|Extension.*error' \
  "$test_root/gnome-shell.log" "$test_root/bridge.log" || true

if rg -q 'Nimf text-input-v3 input method enabled' \
    "$test_root/gnome-shell.log"; then
  printf '%s\n' 'Nested GNOME Shell extension load: OK'
  exit 0
fi

printf 'Nested GNOME Shell did not confirm extension load (status %s).\n' \
  "$shell_status" >&2
tail -80 "$test_root/gnome-shell.log" >&2
exit 1
