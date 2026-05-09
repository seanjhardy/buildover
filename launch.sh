#!/bin/bash
# Buildover launcher — starts the dev server and opens the browser.
# Keep this terminal window open while using the app; close it to stop.

cd "$(dirname "$0")"

# Kill any leftover processes on our ports before starting
lsof -ti:5173 | xargs kill -9 2>/dev/null
lsof -ti:8787 | xargs kill -9 2>/dev/null

# Open the browser after a short delay to let the server start
(sleep 3 && open http://localhost:5173) &

# Start the dev server (this keeps running in the foreground)
npm run dev
