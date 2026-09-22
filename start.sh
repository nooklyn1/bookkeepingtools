#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

cleanup() {
    echo ""
    echo "Shutting down..."
    kill $SERVER_PID 2>/dev/null
    kill $TUNNEL_PID 2>/dev/null
    wait $SERVER_PID 2>/dev/null
    wait $TUNNEL_PID 2>/dev/null
    echo "Done."
}
trap cleanup EXIT INT TERM

# Kill any existing instances
kill $(pgrep -f 'node.*server.js') 2>/dev/null || true
kill $(pgrep -f 'cloudflared.*tunnel run') 2>/dev/null || true
sleep 1

# Start the dev server
node src/server.js &
SERVER_PID=$!

# Start the Cloudflare tunnel
cloudflared tunnel run bookkeeping &
TUNNEL_PID=$!

echo "Server PID: $SERVER_PID"
echo "Tunnel PID: $TUNNEL_PID"
echo "Press Ctrl+C to stop both."

wait
