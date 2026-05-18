#!/usr/bin/env bash
# add-to-dock.sh — one-shot setup that installs buildover as a macOS app and
# pins it to the Dock.  Run once after cloning the repo:
#
#   bash add-to-dock.sh
#
# The app shell points back into THIS repo's compiled output, so any changes
# you make are picked up immediately on the next launch.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "▶ buildover — dock setup"
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

# Remove any previous installation
rm -rf "$APP_PATH"

mkdir -p "$CONTENTS/MacOS"
mkdir -p "$CONTENTS/Resources/app"

# Info.plist ─────────────────────────────────────────────────────────────────
cat > "$CONTENTS/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>        <string>buildover</string>
    <key>CFBundleIdentifier</key>        <string>com.buildover.app</string>
    <key>CFBundleName</key>              <string>buildover</string>
    <key>CFBundleDisplayName</key>       <string>buildover</string>
    <key>CFBundleIconFile</key>          <string>electron.icns</string>
    <key>CFBundleVersion</key>           <string>1.0</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>CFBundlePackageType</key>       <string>APPL</string>
    <key>NSHighResolutionCapable</key>   <true/>
    <key>LSMinimumSystemVersion</key>    <string>12.0</string>
</dict>
</plist>
PLIST

# Electron binary — copy the real binary so macOS accepts it as a native executable
cp "$ELECTRON_REAL" "$CONTENTS/MacOS/buildover"
chmod +x "$CONTENTS/MacOS/buildover"

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

# Register the new bundle with Launch Services
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP_PATH" 2>/dev/null || true

echo "  ✔ $APP_PATH created"
echo ""

# ── 5. Pin to the Dock ────────────────────────────────────────────────────────
echo "▶ Adding to Dock…"

# Check if buildover is already pinned (avoid duplicates)
ALREADY_IN_DOCK=$(defaults read com.apple.dock persistent-apps 2>/dev/null \
  | grep "com.buildover.app" || true)

if [ -n "$ALREADY_IN_DOCK" ]; then
  echo "  (already in Dock — skipping duplicate)"
else
  if command -v dockutil &>/dev/null; then
    # dockutil gives finer control if the user has it installed
    dockutil --add "$APP_PATH" --no-restart
    killall Dock
  else
    # Plain defaults manipulation — works on all Macs without extra tools
    defaults write com.apple.dock persistent-apps -array-add \
      "<dict>
        <key>tile-data</key>
        <dict>
          <key>file-data</key>
          <dict>
            <key>_CFURLString</key>     <string>file://${APP_PATH}/</string>
            <key>_CFURLStringType</key> <integer>15</integer>
          </dict>
          <key>file-label</key>        <string>buildover</string>
          <key>bundle-identifier</key> <string>com.buildover.app</string>
        </dict>
        <key>tile-type</key> <string>file-tile</string>
      </dict>"
    killall Dock
  fi
  echo "  ✔ Dock updated"
fi

echo ""
echo "✔  All done!  buildover is ready in your Dock."
echo ""
echo "   • Click the Dock icon to launch the app."
echo "   • The app loads code directly from:"
echo "       $REPO_DIR/dist-electron/"
echo "   • Re-run this script any time you want to refresh the installation."
