#!/usr/bin/env bash
# Pull latest code and restart the app
# Usage: bash deploy/update.sh
set -euo pipefail

APP_DIR="/home/teamchargertech/bookkeepingtools"

cd "$APP_DIR"

echo "Pulling latest code..."
git pull

echo "Installing dependencies..."
npm install --omit=dev

echo "Restarting app..."
sudo systemctl restart bookkeeping

echo "Done. Check status:"
echo "  sudo systemctl status bookkeeping"
echo "  sudo journalctl -u bookkeeping -f"
