#!/bin/sh
# Installs the keeper as a systemd user timer.
#   scripts/install-keeper.sh ~/.config/lifeboat/mirror.key
# Then: systemctl --user list-timers lifeboat-keeper.timer ; journalctl --user -u lifeboat-keeper
set -eu
KEY_FILE=$(realpath "${1:?usage: install-keeper.sh /path/to/mirror.key}")
DIR=$(cd "$(dirname "$0")/.." && pwd)
NODE_BIN_DIR=$(dirname "$(command -v node)")
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
sed -e "s#{{LIFEBOAT_DIR}}#$DIR#g" -e "s#{{NODE_BIN_DIR}}#$NODE_BIN_DIR#g" -e "s#{{KEY_FILE}}#$KEY_FILE#g" \
  "$DIR/scripts/keeper.service" > "$UNIT_DIR/lifeboat-keeper.service"
cp "$DIR/scripts/keeper.timer" "$UNIT_DIR/lifeboat-keeper.timer"
systemctl --user daemon-reload
systemctl --user enable --now lifeboat-keeper.timer
echo "installed; next runs:"
systemctl --user list-timers lifeboat-keeper.timer --no-pager
