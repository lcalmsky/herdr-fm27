#!/bin/sh
# build.sh [--restore] — make Herdr FM27 Open the default app for code files, or put the recorded apps back.
set -eu

EXTENSIONS="md sql py ts js json yaml yml sh"
APP_NAME="Herdr FM27 Open"
BUNDLE_ID="dev.herdr.fm27-open"
APP="$HOME/Applications/$APP_NAME.app"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-tower"
PREVIOUS="$STATE/open-previous.tsv"
HERE=$(cd "$(dirname "$0")" && pwd)
LAUNCHER="$HOME/.config/herdr-app/mods/fm-editor/hv-open"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
BIN="${TMPDIR:-/tmp}/herdr-open-set-default"
PB=/usr/libexec/PlistBuddy

mkdir -p "$HOME/Applications" "$STATE"
touch "$PREVIOUS"
swiftc -O "$HERE/set-default.swift" -o "$BIN"

if [ "${1:-}" = "--restore" ]; then
  for ext in $EXTENSIONS; do
    app=$(awk -F '\t' -v ext="$ext" '$1 == ext && $2 != "" { app = $2 } END { print app }' "$PREVIOUS")
    if [ -n "$app" ]; then
      "$BIN" "$app" "$ext" >/dev/null || printf 'build.sh: could not give %s back to %s\n' "$ext" "$app" >&2
    else
      printf 'build.sh: no recorded app for %s; left as it is\n' "$ext" >&2
    fi
  done
  exit 0
fi

if [ ! -x "$LAUNCHER" ]; then
  printf 'build.sh: %s is missing; run tools/install.sh first\n' "$LAUNCHER" >&2
  exit 1
fi

rm -rf "$APP"
osacompile -o "$APP" "$HERE/open.applescript"
PLIST="$APP/Contents/Info.plist"
"$PB" -c "Add :CFBundleIdentifier string $BUNDLE_ID" "$PLIST" 2>/dev/null || "$PB" -c "Set :CFBundleIdentifier $BUNDLE_ID" "$PLIST"
"$PB" -c "Add :LSUIElement bool true" "$PLIST" 2>/dev/null || "$PB" -c "Set :LSUIElement true" "$PLIST"
"$PB" -c "Delete :CFBundleDocumentTypes" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :CFBundleDocumentTypes array" "$PLIST"
"$PB" -c "Add :CFBundleDocumentTypes:0 dict" "$PLIST"
"$PB" -c "Add :CFBundleDocumentTypes:0:CFBundleTypeName string Code file" "$PLIST"
"$PB" -c "Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Editor" "$PLIST"
"$PB" -c "Add :CFBundleDocumentTypes:0:LSHandlerRank string Alternate" "$PLIST"
"$PB" -c "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions array" "$PLIST"
for ext in $EXTENSIONS; do
  "$PB" -c "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions: string $ext" "$PLIST"
done
# Editing Info.plist breaks osacompile's ad-hoc seal, and arm64 refuses an app whose seal is broken.
codesign --force --sign - "$APP"
"$LSREGISTER" -f "$APP"

before=$("$BIN" --print "$APP" $EXTENSIONS)
TMP="$STATE/open-previous.tsv.new"
cp "$PREVIOUS" "$TMP"
printf '%s\n' "$before" | while IFS="$(printf '\t')" read -r ext app; do
  [ -n "$ext" ] || continue
  [ -n "$app" ] || continue
  case $app in
    "$APP"|*"$APP_NAME.app") continue ;;
  esac
  if ! cut -f1 "$TMP" | grep -qxF "$ext"; then
    printf '%s\t%s\n' "$ext" "$app" >>"$TMP"
  fi
done
mv "$TMP" "$PREVIOUS"

for ext in $EXTENSIONS; do
  "$BIN" "$APP" "$ext" >/dev/null
done
