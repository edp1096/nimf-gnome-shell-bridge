#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
extension_uuid='nimf-tiv3@dock-memo.local'
extension_dir="$HOME/.local/share/gnome-shell/extensions/$extension_uuid"
service_file="$HOME/.config/systemd/user/nimf-shell-bridge.service"
bridge_file="$HOME/.local/libexec/nimf-shell-bridge"
rollback_file="$HOME/.local/bin/disable-nimf-tiv3-and-restore-chrome-x11"
uninstall_file="$HOME/.local/bin/uninstall-nimf-tiv3-bridge"
recovery_file="$HOME/.local/share/applications/nimf-tiv3-recovery.desktop"

"$project_dir/scripts/disable-and-restore-x11.sh"

rm -f -- "$bridge_file"
rm -f -- "$service_file"
rm -f -- "$rollback_file"
rm -f -- "$uninstall_file"
rm -f -- "$recovery_file"
rm -rf -- "$extension_dir"

systemctl --user daemon-reload
systemctl --user reset-failed nimf-shell-bridge.service 2>/dev/null || true
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
make -C "$project_dir" clean

printf '%s\n' \
  'Nimf text-input-v3 bridge uninstalled.' \
  'The installed Nimf package was not changed.'
