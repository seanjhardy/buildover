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
    <key>LSMinimumSystemVersion</key>    <string>11.0</string>
</dict>
</plist>
PLIST

# Launcher shell script — delegates to the Electron binary from node_modules.
# Using a shell script instead of copying the binary means:
#   • the correct architecture binary (arm64 or x64) is always used for this machine
#   • no "app is damaged" / "not supported on this version" Gatekeeper complaints
#     caused by copying a binary built for a different architecture
#
# We must pass the app directory explicitly. When a copied Electron binary sits
# inside a .app bundle it knows to look in Contents/Resources/app automatically.
# But when we exec the Electron binary from node_modules, it looks for resources
# relative to *its own* bundle (node_modules/electron/dist/Electron.app) and
# finds nothing — showing the default "no app loaded" screen. Passing the path
# as the first argument overrides that lookup.
cat > "$CONTENTS/MacOS/buildover" << LAUNCHER
#!/usr/bin/env bash
SCRIPT_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
APP_DIR="\$(dirname "\$SCRIPT_DIR")/Resources/app"
exec "${ELECTRON_REAL}" "\$APP_DIR" "\$@"
LAUNCHER
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

# ── 5. Launch the app ────────────────────────────────────────────────────────
echo "▶ Launching buildover…"
open "$APP_PATH"

echo ""
echo "✔  All done!  buildover is launching."
echo ""
echo "   • The app loads code directly from:"
echo "       $REPO_DIR/dist-electron/"
echo "   • Re-run this script any time you want to refresh the installation."
