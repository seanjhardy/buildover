# Remote access — run buildover from your phone

This lets you open buildover on your iPhone from anywhere (any internet
connection) as long as your laptop is on. Chats and live agent output appear on
both your laptop and phone simultaneously, because both devices are just clients
of the same server on your laptop — there is no separate sync layer.

It uses **Tailscale** (a private mesh VPN between your own devices) for
reachability + HTTPS, and a **PWA** ("Add to Home Screen") for a branded,
full-screen app icon with no App Store.

---

## One-time setup

### 1. Install Tailscale on both devices

- **Laptop:** `brew install --cask tailscale` (or the Mac App Store app), launch
  it, and sign in.
- **iPhone:** install **Tailscale** from the App Store and sign in with the
  **same account**.

Both devices are now on your private tailnet and can reach each other from
anywhere.

### 2. Enable HTTPS certificates for your tailnet (one toggle)

In the Tailscale admin console → **DNS**: make sure **MagicDNS** is on, and
enable **HTTPS Certificates**. This lets `tailscale serve` get a real TLS cert
for your `*.ts.net` name — which the PWA requires (service workers / installable
apps only work over HTTPS).

### 3. Build the phone UI

The server serves the built frontend from `dist/`. Build it once:

```bash
npm run build:web
```

Re-run this whenever you want the phone to pick up UI changes. The running
server detects a fresh `dist/` without needing a restart.

### 4. Expose the server over HTTPS

With buildover running (the server listens on `127.0.0.1:8787`), run:

```bash
tailscale serve --bg 8787
```

This publishes `https://<your-laptop>.<your-tailnet>.ts.net` → the local server,
with a valid cert. Find the exact URL with:

```bash
tailscale serve status
```

It only needs to be run once; `--bg` keeps it running in the background across
reboots.

### 5. Install the app on your iPhone

1. Open the `https://<your-laptop>.<your-tailnet>.ts.net` URL in **Safari**.
2. Tap the **Share** button → **Add to Home Screen**.
3. You'll get a **buildover** icon. Launching it opens full-screen with no
   browser chrome — it behaves like a native app.

That's it. Open chats on either device; they stay in sync live.

---

## Day-to-day

- **Laptop on, internet connected** is all that's required. The phone reaches it
  over Tailscale from anywhere.
- **Keep the laptop awake** while you're out: `caffeinate -s` in a terminal, or
  System Settings → Lock Screen / Battery → prevent sleep. (Closing the lid on a
  MacBook still sleeps it unless on external power + display settings allow it.)
- **After UI changes:** `npm run build:web` again.

## Security model

Access is gated by your **tailnet** — only devices signed into your Tailscale
account can reach the server. The server binds to `127.0.0.1` only, so it is
**not** exposed on coffee-shop wifi or your LAN; `tailscale serve` is the only
path in, and it only accepts connections from your own tailnet. No password or
token is configured (by design, for a single-user setup).

If you ever want to reach the raw Tailscale IP directly (without `tailscale
serve`), start the server with `HOST=0.0.0.0` — but the `tailscale serve` path
above is preferred and more secure.

## Notes / limitations

- **Mobile layout** is not yet optimized — the desktop multi-panel UI works on a
  phone but is cramped (that's a planned follow-up, "Phase 5").
- iOS suspends background WebSockets; the app reconnects automatically when you
  return to it.
- Alternative (dev) path: instead of building `dist/`, you can point
  `tailscale serve 5173` at the Vite dev server for live reload — `vite.config.ts`
  already allows `.ts.net` hosts and proxies the API + WS endpoints.
