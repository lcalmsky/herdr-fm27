#!/bin/sh
# build.sh --mod <editor-mod-id> [--restore] — make Herdr Open the default app for code files,
# or put the recorded apps back.
set -eu

EXTENSIONS="md sql py ts js json yaml yml sh"
APP_NAME="Herdr Open"
BUNDLE_ID="dev.herdr.open"
MOD=
RESTORE=
while [ $# -gt 0 ]; do
  case $1 in
    --mod) MOD=${2:-}; shift 2 ;;
    --restore) RESTORE=1; shift ;;
    *) printf 'build.sh: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done
case $MOD in
  '') [ -n "$RESTORE" ] || { printf 'build.sh: usage: build.sh --mod <editor-mod-id> [--restore]\n' >&2; exit 2; } ;;
  *[!A-Za-z0-9_-]*) printf 'build.sh: %s is not a mod id\n' "$MOD" >&2; exit 2 ;;
esac

APP="$HOME/Applications/$APP_NAME.app"
APP_HOME=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-tower"
PREVIOUS="$STATE/open-previous.tsv"
HERE=$(cd "$(dirname "$0")" && pwd)
LAUNCHER="$APP_HOME/mods/$MOD/hv-open"
# Both are absolute paths outside PATH, but the tests need to keep off the real system.
LSREGISTER=${HERDR_LSREGISTER:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}
BIN="${TMPDIR:-/tmp}/herdr-open-set-default"
PB=${HERDR_PLISTBUDDY:-/usr/libexec/PlistBuddy}

mkdir -p "$HOME/Applications" "$STATE"
touch "$PREVIOUS"
swiftc -O "$HERE/set-default.swift" -o "$BIN"

if [ -n "$RESTORE" ]; then
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

SCRIPT=$(mktemp "${TMPDIR:-/tmp}/herdr-open.XXXXXX")
trap 'rm -f "$SCRIPT"' EXIT
sed "s/@MOD@/$MOD/" "$HERE/open.applescript" > "$SCRIPT"

rm -rf "$APP"
osacompile -o "$APP" "$SCRIPT"
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
