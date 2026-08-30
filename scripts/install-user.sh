#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
extension_uuid='nimf-tiv3@dock-memo.local'
extension_dir="$HOME/.local/share/gnome-shell/extensions/$extension_uuid"
legacy_library='/usr/lib/aarch64-linux-gnu/libnimf.so.2.0.0'
legacy_library_sha256='4accea3dd69f584346c7f940f198096ae45521b1f4dc3495b4a6cebbaf265fba'
shell_version=$(gnome-shell --version)
extension_was_loaded=false
extension_source_changed=true

case "$shell_version" in
  'GNOME Shell 42.'*)
    extension_source="$project_dir/extension/extension.js"
    metadata_source="$project_dir/extension/metadata.json"
    adapter_name='legacy-42'
    ;;
  'GNOME Shell 46.'*)
    extension_source="$project_dir/extension/extension-46.js"
    metadata_source="$project_dir/extension/metadata-46.json"
    adapter_name='modern-46'
    ;;
  *)
    printf 'Refusing to install: supported GNOME Shell versions are 42 and 46 (found: %s).\n' \
      "$shell_version" >&2
    exit 1
    ;;
esac

if gnome-extensions info "$extension_uuid" >/dev/null 2>&1; then
  extension_was_loaded=true
  if cmp -s "$extension_source" "$extension_dir/extension.js"; then
    extension_source_changed=false
  fi
fi

if [[ ! -f "$legacy_library" ]] || \
   [[ $(sha256sum "$legacy_library" | cut -d' ' -f1) != \
      "$legacy_library_sha256" ]]; then
  printf 'Refusing to install: the installed legacy Nimf ABI has changed.\n' >&2
  exit 1
fi

make -C "$project_dir" clean all check

install -d "$HOME/.local/libexec"
install -m 0755 "$project_dir/build/nimf-shell-bridge" \
  "$HOME/.local/libexec/nimf-shell-bridge"

install -d "$HOME/.config/systemd/user"
install -m 0644 "$project_dir/systemd/nimf-shell-bridge.service" \
  "$HOME/.config/systemd/user/nimf-shell-bridge.service"

install -d "$extension_dir"
install -m 0644 "$metadata_source" \
  "$extension_dir/metadata.json"
install -m 0644 "$extension_source" \
  "$extension_dir/extension.js"

install -d "$HOME/.local/bin"
install -m 0755 "$project_dir/scripts/disable-and-restore-x11.sh" \
  "$HOME/.local/bin/disable-nimf-tiv3-and-restore-chrome-x11"
install -m 0755 "$project_dir/scripts/uninstall-user.sh" \
  "$HOME/.local/bin/uninstall-nimf-tiv3-bridge"

install -d "$HOME/.local/share/applications"
install -m 0644 "$project_dir/recovery/nimf-tiv3-recovery.desktop" \
  "$HOME/.local/share/applications/nimf-tiv3-recovery.desktop"
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

systemctl --user daemon-reload
systemctl --user enable nimf-shell-bridge.service
systemctl --user restart nimf-shell-bridge.service

bridge_ready=false
for _attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if gdbus call --session \
      --dest org.nimf.ShellBridge \
      --object-path /org/nimf/ShellBridge \
      --method org.nimf.ShellBridge1.Ping; then
    bridge_ready=true
    break
  fi
  sleep 0.1
done

if [[ $bridge_ready != true ]]; then
  printf 'Bridge service did not become ready; the extension was not enabled.\n' >&2
  exit 1
fi

if gnome-extensions info "$extension_uuid" >/dev/null 2>&1; then
  gnome-extensions enable "$extension_uuid"
  if [[ $extension_was_loaded == true && \
        $extension_source_changed == true ]]; then
    activation_message='The updated extension will load at the next login.'
  else
    activation_message='The extension is enabled in the current session.'
  fi
else
  python3 - "$extension_uuid" <<'PY'
import ast
import subprocess
import sys

uuid = sys.argv[1]
result = subprocess.run(
    ["gsettings", "get", "org.gnome.shell", "enabled-extensions"],
    check=True,
    capture_output=True,
    text=True,
)
value = result.stdout.strip()
extensions = [] if value == "@as []" else ast.literal_eval(value)
if uuid not in extensions:
    extensions.append(uuid)
subprocess.run(
    [
        "gsettings",
        "set",
        "org.gnome.shell",
        "enabled-extensions",
        repr(extensions),
    ],
    check=True,
)
PY
  activation_message='The extension will load at the next login.'
fi

printf '%s\n' \
  "Nimf text-input-v3 bridge installed ($adapter_name)." \
  "$activation_message" \
  'Emergency rollback:' \
  '  ~/.local/bin/disable-nimf-tiv3-and-restore-chrome-x11'
