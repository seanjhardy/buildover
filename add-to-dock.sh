#!/usr/bin/env bash
# add-to-dock.sh — one-shot setup that installs buildover as a macOS app and
# launches it.  Run once after cloning the repo:
#
#   bash add-to-dock.sh
#
# The app shell points back into THIS repo's compiled output, so any changes
# you make are picked up immediately on the next launch.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "▶ buildover — setup"
echo "  Repo: $REPO_DIR"
echo ""

# ── 1. Dependencies ───────────────────────────────────────────────────────────
if [ ! -d "$REPO_DIR/node_modules" ]; then
  echo "▶ node_modules not found — running npm install…"
  npm --prefix "$REPO_DIR" install
  echo ""
fi

# ── 2. Compile Electron entry point ──────────────────────────────────────────
echo "▶ Compiling Electron files (electron:compile)…"
npm --prefix "$REPO_DIR" run electron:compile
echo ""

# ── 3. Locate the Electron binary ────────────────────────────────────────────
# node_modules/.bin/electron is a Node.js CLI shim, not the native binary.
# The real binary path is returned by require('electron') from the package root.
ELECTRON_REAL="$(node -e "process.stdout.write(require('$REPO_DIR/node_modules/electron'))")"

if [ ! -f "$ELECTRON_REAL" ]; then
  echo "✗  Electron binary not found at $ELECTRON_REAL"
  echo "   Make sure 'npm install' completed successfully."
  exit 1
fi

# ── 4. Build the .app bundle ──────────────────────────────────────────────────
APP_PATH="/Applications/buildover.app"
CONTENTS="$APP_PATH/Contents"

echo "▶ Building $APP_PATH …"

# The bundle is a full copy of node_modules' Electron.app with its own bundle
# ID. It used to be a shell script that exec'd the node_modules binary, but
# macOS attributes notifications to the *running* bundle, so every banner went
# to "com.github.Electron" (whose notification permission is separate, and was
# off) instead of buildover. Copying locally doesn't add quarantine and always
# matches this machine's architecture. Re-run this script after upgrading the
# electron package so the copy picks up the new binary.
ELECTRON_APP="$(dirname "$(dirname "$(dirname "$ELECTRON_REAL")")")"

# Remove any previous installation
rm -rf "$APP_PATH"
ditto "$ELECTRON_APP" "$APP_PATH"
rm -f "$CONTENTS/Resources/default_app.asar"
mkdir -p "$CONTENTS/Resources/app"

# Info.plist: own bundle ID and display name. CFBundleName and the executable
# stay "Electron" because Electron locates its helper apps from them.
PLIST="$CONTENTS/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.buildover.app" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName buildover" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string buildover" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile electron.icns" "$PLIST"

# package.json stub required by Electron to locate main.js ───────────────────
cat > "$CONTENTS/Resources/app/package.json" << 'JSON'
{ "name": "buildover", "version": "1.0.0", "main": "main.js" }
JSON

# main.js — delegate immediately to the repo's compiled Electron entry point
# (this is what makes live code changes work: the repo path is baked in here)
cat > "$CONTENTS/Resources/app/main.js" << JS
require('${REPO_DIR}/dist-electron/main.cjs');
JS

# App icon ────────────────────────────────────────────────────────────────────
if [ -f "$REPO_DIR/build/icon.icns" ]; then
  cp "$REPO_DIR/build/icon.icns" "$CONTENTS/Resources/electron.icns"
fi

# Editing Info.plist invalidates Electron's signature; re-sign ad hoc so macOS
# will launch it and keep notification permission tied to this bundle.
codesign --force --deep --sign - "$APP_PATH" >/dev/null 2>&1

# Register the new bundle with Launch Services
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP_PATH" 2>/dev/null || true

echo "  ✔ $APP_PATH created"
echo ""

# ── 5. Launch the app ────────────────────────────────────────────────────────
echo "▶ Launching buildover…"
open "$APP_PATH"

echo ""
echo "✔  All done!  buildover is launching."
echo ""
echo "   • The app loads code directly from:"
echo "       $REPO_DIR/dist-electron/"
echo "   • Re-run this script any time you want to refresh the installation."
