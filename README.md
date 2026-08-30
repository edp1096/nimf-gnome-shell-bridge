# Nimf GNOME Shell bridge

A bridge adapter for Nimf and GNOME Shell 42 or 46 Wayland.

The bridge also works around Chromium/Electron's native Wayland
end-of-preedit focus bug. Live preedit is registered with Mutter's `COMMIT`
reset mode, so Mutter commits it to the original text focus before a pointer
press reaches the client. The bridge forwards commits produced by key events
immediately, while briefly deferring an out-of-key commit until the following
preedit or reset event identifies whether it is genuine or Nimf's duplicate
focus-reset commit.

## Prequisite
* https://nimfsoft.art/nimf
  - [nimf_2022.03.05-bullseye_arm64.deb](https://nimfsoft.art/downloads/nimf/debian/dists/bullseye/main/binary-arm64/nimf_2022.03.05-bullseye_arm64.deb)

## Install
```sh
sudo apt update
sudo apt install -y build-essential pkg-config libglib2.0-dev

./scripts/install-user.sh
```

## Uninstall
```sh
./scripts/uninstall-user.sh
```
