#!/bin/sh
# Installs the keeper as a systemd user timer.
#   scripts/install-keeper.sh ~/.config/mirrorlease/mirror.key
# Then: systemctl --user list-timers mirrorlease-keeper.timer ; journalctl --user -u mirrorlease-keeper
set -eu
KEY_FILE=$(realpath "${1:?usage: install-keeper.sh /path/to/mirror.key}")
DIR=$(cd "$(dirname "$0")/.." && pwd)
NODE_BIN_DIR=$(dirname "$(command -v node)")
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
sed -e "s#{{MIRRORLEASE_DIR}}#$DIR#g" -e "s#{{NODE_BIN_DIR}}#$NODE_BIN_DIR#g" -e "s#{{KEY_FILE}}#$KEY_FILE#g" \
  "$DIR/scripts/keeper.service" > "$UNIT_DIR/mirrorlease-keeper.service"
cp "$DIR/scripts/keeper.timer" "$UNIT_DIR/mirrorlease-keeper.timer"
systemctl --user daemon-reload
systemctl --user enable --now mirrorlease-keeper.timer
echo "installed; next runs:"
systemctl --user list-timers mirrorlease-keeper.timer --no-pager
