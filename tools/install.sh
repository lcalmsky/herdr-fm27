#!/bin/sh
# Copies the fm27 layout, theme and mods into the Herdr home and merges the layout's keys.
set -eu
REPO=$(cd "$(dirname "$0")/.." && pwd)
HOME_DIR=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
MODS="fm-chrome fm-squad fm-staff fm-club fm-live fm-editor"
for mod in $MODS; do
  mkdir -p "$HOME_DIR/mods/$mod"
  cp -R "$REPO/mods/$mod/." "$HOME_DIR/mods/$mod/"
  cp "$REPO/shared/tokens.js" "$HOME_DIR/mods/$mod/tokens.js"
done
for f in fm-staff/cca fm-staff/usage-tap.sh fm-editor/hv fm-editor/hv-open fm-squad/scan.sh; do
  [ -f "$HOME_DIR/mods/$f" ] && chmod +x "$HOME_DIR/mods/$f"
done
mkdir -p "$HOME_DIR/layouts" "$HOME_DIR/themes"
cp "$REPO/layouts/fm27.json" "$HOME_DIR/layouts/"
cp "$REPO/themes/fm27.json" "$HOME_DIR/themes/"
python3 -I "$REPO/tools/merge-keys.py" "$HOME_DIR/keys.json" "$REPO/keys/fm27.json"
for mod in $MODS; do herdr-app check "$HOME_DIR/mods/$mod"; done
