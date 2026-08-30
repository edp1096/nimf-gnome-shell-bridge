#!/usr/bin/env bash
set -euo pipefail

extension_uuid='nimf-tiv3@dock-memo.local'
service_name='nimf-shell-bridge.service'
arcmenu_schema_dir="$HOME/.local/share/gnome-shell/extensions/arcmenu@arcmenu.com/schemas"
wayland_command='google-chrome --ozone-platform=wayland --enable-wayland-ime --wayland-text-input-version=3'
x11_command='google-chrome --ozone-platform=x11'
arcmenu_message='ArcMenu was not found; no Chrome command was changed.'

gnome-extensions disable "$extension_uuid" 2>/dev/null || true
systemctl --user disable --now "$service_name" 2>/dev/null || true

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
extensions = [item for item in extensions if item != uuid]
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

if [[ -d "$arcmenu_schema_dir" ]]; then
  current_pins=$(GSETTINGS_SCHEMA_DIR="$arcmenu_schema_dir" \
    gsettings get org.gnome.shell.extensions.arcmenu pinned-app-list)
  if [[ $current_pins == *"$wayland_command"* ]]; then
    restored_pins=${current_pins//"$wayland_command"/"$x11_command"}
    GSETTINGS_SCHEMA_DIR="$arcmenu_schema_dir" \
      gsettings set org.gnome.shell.extensions.arcmenu pinned-app-list \
      "$restored_pins"
    arcmenu_message='The ArcMenu Google Chrome command was restored to X11.'
  else
    arcmenu_message='ArcMenu had no matching Wayland Chrome command to restore.'
  fi
fi

printf '%s\n' \
  'Nimf text-input-v3 bridge disabled.' \
  "$arcmenu_message" \
  'Close any running Wayland Chrome windows before launching it again.'
