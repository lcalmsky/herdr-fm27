#!/bin/sh
# Copies the fm27 layout, theme and mods into the Herdr home and merges the layout's keys.
set -eu
REPO=$(cd "$(dirname "$0")/.." && pwd)
HOME_DIR=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
MODS="fm-chrome fm-squad fm-staff fm-club fm-live fm-editor"
SHARED_LINK=${HERDR_SHARED:-$REPO/vendor/herdr-shared}/tools/link-installed.sh
SHARED_HOME=${HERDR_SHARED_HOME:-$HOME/.local/share/herdr-shared}
for mod in $MODS; do
  mkdir -p "$HOME_DIR/mods/$mod"
  # The copy below must write real files: a link into the shared home from the last install
  # would be written through. The link step at the end puts the links back.
  find "$HOME_DIR/mods/$mod" -maxdepth 1 -type l -lname "$SHARED_HOME/*" -exec rm -f {} +
  cp -R "$REPO/mods/$mod/." "$HOME_DIR/mods/$mod/"
  cp "$REPO/shared/tokens.js" "$HOME_DIR/mods/$mod/tokens.js"
done
for f in fm-staff/cca fm-staff/usage-tap.sh fm-editor/hv fm-editor/hv-open fm-squad/scan.sh; do
  [ -f "$HOME_DIR/mods/$f" ] && chmod +x "$HOME_DIR/mods/$f"
done
if [ -f "$SHARED_LINK" ] && [ -d "$SHARED_HOME" ]; then
  REPO_REAL=$(cd "$REPO" && pwd -P)
  for mod in fm-staff fm-squad fm-editor; do
    dir="$HOME_DIR/mods/$mod"
    [ -d "$dir" ] || continue
    real=$(cd "$dir" && pwd -P)
    case $real in
      "$REPO_REAL"|"$REPO_REAL"/*) continue ;;
    esac
    sh "$SHARED_LINK" "$real"
  done
fi
mkdir -p "$HOME_DIR/layouts" "$HOME_DIR/themes"
cp "$REPO/layouts/fm27.json" "$REPO/layouts/fm27.png" "$HOME_DIR/layouts/"
cp "$REPO/themes/fm27.json" "$HOME_DIR/themes/"
python3 -I "$REPO/tools/merge-keys.py" "$HOME_DIR/keys.json" "$REPO/keys/fm27.json" --backup-tag fm27
for mod in $MODS; do herdr-app check "$HOME_DIR/mods/$mod"; done
