#!/usr/bin/env bash
# Daily SQLite backup script
# Called by cron — see /etc/cron.d/bookkeeping-backup
set -euo pipefail

APP_DIR="/home/bookkeeping/bookkeepingtools"
BACKUP_DIR="/home/bookkeeping/backups"
DB_FILE="$APP_DIR/data/bookkeeping.db"
DATE=$(date +%Y-%m-%d)

# Skip if database doesn't exist yet
if [ ! -f "$DB_FILE" ]; then
  exit 0
fi

# Use SQLite's .backup command for a consistent snapshot
# (safe even while the app is running)
sqlite3 "$DB_FILE" ".backup '$BACKUP_DIR/bookkeeping-$DATE.db'"

# Keep only the last 14 daily backups
find "$BACKUP_DIR" -name "bookkeeping-*.db" -mtime +14 -delete

echo "Backup completed: bookkeeping-$DATE.db"
