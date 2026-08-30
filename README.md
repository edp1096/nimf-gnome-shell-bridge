# Nimf GNOME Shell bridge

A bridge adapter for Nimf and GNOME Shell 42 or 46 Wayland.
For applications which are using text-input-v3 within GNOME Mutter.

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
