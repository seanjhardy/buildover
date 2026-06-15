#!/usr/bin/env bash
#
# One-shot setup for accessing buildover from your phone over Tailscale.
#
#   ./setup-remote.sh
#
# It is idempotent — safe to re-run. It will:
#   1. Install the Tailscale CLI (Homebrew) if missing.
#   2. Start the Tailscale system daemon and log you in (opens a browser once).
#   3. Expose the buildover dev server (port 5173) over HTTPS on your tailnet.
#   4. Print the URL to open on your phone.
#
set -euo pipefail

PORT="${1:-5173}"
say()  { printf "\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m✓ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m! %s\033[0m\n" "$*"; }

if [[ "$(uname)" != "Darwin" ]]; then
  warn "This script targets macOS. On other platforms install Tailscale manually."
fi

# ── 1. Tailscale CLI ─────────────────────────────────────────────────────────
if ! command -v tailscale >/dev/null 2>&1; then
  say "Installing Tailscale CLI via Homebrew…"
  if ! command -v brew >/dev/null 2>&1; then
    warn "Homebrew not found. Install it from https://brew.sh then re-run."
    exit 1
  fi
  arch -arm64 brew install tailscale 2>/dev/null || brew install tailscale
fi
ok "Tailscale CLI present: $(command -v tailscale)"

# ── 2. Daemon + login ────────────────────────────────────────────────────────
if ! tailscale status >/dev/null 2>&1; then
  say "Starting the Tailscale system daemon (needs sudo)…"
  sudo tailscaled install-system-daemon 2>/dev/null || true
  sleep 2
fi

if tailscale status 2>&1 | grep -qi "logged out\|NeedsLogin" || ! tailscale status >/dev/null 2>&1; then
  say "Logging in to Tailscale (a browser window will open)…"
  sudo tailscale up
fi
ok "Tailscale is up."

# ── 3. Serve buildover over HTTPS on the tailnet ─────────────────────────────
say "Exposing buildover (port ${PORT}) over HTTPS…"
tailscale serve --bg "${PORT}" >/dev/null 2>&1 || sudo tailscale serve --bg "${PORT}"
ok "Serving."

# ── 4. Report the phone URL ──────────────────────────────────────────────────
URL="$(tailscale status --json 2>/dev/null \
  | python3 -c 'import sys,json; print("https://"+json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"

echo
ok "Remote access is set up!"
if [[ -n "${URL}" ]]; then
  printf "\n  Open this on your iPhone (with Tailscale on):\n\n    \033[1;32m%s\033[0m\n\n" "${URL}"
else
  echo "  Run 'tailscale serve status' to see your URL."
fi
cat <<'EOF'
  On the phone:
    1. Install the Tailscale app (App Store) and sign in to the SAME account.
    2. Open the URL above in Safari.
    3. Share → Add to Home Screen  → launches full-screen, branded.
    4. Open it from the Home Screen icon, tap "Notifications" to enable push.

  Keep the laptop awake while away:
    • Use the Caffeine button in buildover (keeps it awake lid-open).
    • For lid-CLOSED:  sudo pmset -a disablesleep 1   (revert: ... 0)

  buildover itself must be running (npm run dev / the desktop app) for the
  page to load.
EOF
