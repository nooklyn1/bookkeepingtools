#!/usr/bin/env bash
# VPS Setup Script for Bookkeeping Tools
# Run as root on a fresh Ubuntu 24.04 VPS (e.g. Hetzner CX22)
#
# Usage:
#   1. SSH into your VPS as root
#   2. Copy this script over: scp deploy/setup-vps.sh root@YOUR_VPS_IP:~
#   3. Run: bash setup-vps.sh
#
# What it does:
#   - Creates a 'bookkeeping' user
#   - Installs Node.js 20, mkcert, cloudflared
#   - Clones the repo, installs dependencies
#   - Generates local HTTPS certs
#   - Sets up systemd services for the app and Cloudflare Tunnel
#   - Configures daily SQLite backups
#   - Sets up UFW firewall (SSH only — Cloudflare Tunnel needs no open ports)

set -euo pipefail

# --- Configuration ---
GITHUB_REPO="https://github.com/ChargertechBV/bookkeepingtools.git"
APP_USER="bookkeeping"
APP_DIR="/home/${APP_USER}/bookkeepingtools"
BACKUP_DIR="/home/${APP_USER}/backups"
NODE_VERSION="20"

echo "=== Bookkeeping Tools VPS Setup ==="
echo ""

# Check we're running as root
if [ "$EUID" -ne 0 ]; then
  echo "ERROR: Run this script as root"
  exit 1
fi

# --- 1. System updates ---
echo "[1/8] Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl git ufw libnss3-tools

# --- 2. Create app user ---
echo "[2/8] Creating application user..."
if id "$APP_USER" &>/dev/null; then
  echo "  User '$APP_USER' already exists, skipping"
else
  adduser --disabled-password --gecos "" "$APP_USER"
  # Allow SSH with key-based auth (copy your key after setup)
  mkdir -p /home/${APP_USER}/.ssh
  chmod 700 /home/${APP_USER}/.ssh
  # Copy root's authorized_keys so you can SSH as the app user
  if [ -f /root/.ssh/authorized_keys ]; then
    cp /root/.ssh/authorized_keys /home/${APP_USER}/.ssh/
    chmod 600 /home/${APP_USER}/.ssh/authorized_keys
  fi
  chown -R ${APP_USER}:${APP_USER} /home/${APP_USER}/.ssh
fi

# --- 3. Install Node.js ---
echo "[3/8] Installing Node.js ${NODE_VERSION}..."
if command -v node &>/dev/null && node -v | grep -q "v${NODE_VERSION}"; then
  echo "  Node.js $(node -v) already installed"
else
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y -qq nodejs
  echo "  Installed Node.js $(node -v)"
fi

# --- 4. Install mkcert ---
echo "[4/8] Installing mkcert..."
if command -v mkcert &>/dev/null; then
  echo "  mkcert already installed"
else
  MKCERT_VERSION="v1.4.4"
  curl -fsSL "https://dl.filippo.io/mkcert/latest?for=linux/amd64" -o /usr/local/bin/mkcert
  chmod +x /usr/local/bin/mkcert
  echo "  mkcert installed"
fi

# --- 5. Install cloudflared ---
echo "[5/8] Installing cloudflared..."
if command -v cloudflared &>/dev/null; then
  echo "  cloudflared already installed"
else
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | tee /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq
  apt-get install -y -qq cloudflared
  echo "  cloudflared installed"
fi

# --- 6. Clone repo and set up app ---
echo "[6/8] Setting up application..."
if [ -d "$APP_DIR" ]; then
  echo "  App directory exists, pulling latest..."
  sudo -u "$APP_USER" git -C "$APP_DIR" pull
else
  sudo -u "$APP_USER" git clone "$GITHUB_REPO" "$APP_DIR"
fi

cd "$APP_DIR"
sudo -u "$APP_USER" npm install --omit=dev

# Create data directories
sudo -u "$APP_USER" mkdir -p data/pdfs certs

# Generate HTTPS certs
echo "  Generating local HTTPS certificates..."
sudo -u "$APP_USER" bash -c "cd $APP_DIR && mkcert -install 2>/dev/null; mkcert -cert-file certs/localhost.pem -key-file certs/localhost-key.pem localhost 2>/dev/null"
echo "  Certs generated in $APP_DIR/certs/"

# Create .env if it doesn't exist
if [ ! -f "$APP_DIR/.env" ]; then
  SESSION_SECRET=$(openssl rand -hex 32)
  cat > "$APP_DIR/.env" << ENVEOF
PORT=3000

# Session
SESSION_SECRET=${SESSION_SECRET}

# Login - comma-separated list of allowed Google email addresses
ALLOWED_EMAILS=your-email@gmail.com
LOGIN_REDIRECT_URI=https://bookkeeping.yourdomain.com/login/callback

# Gmail OAuth2
GMAIL_CLIENT_ID=your-gmail-client-id
GMAIL_CLIENT_SECRET=your-gmail-client-secret
GMAIL_REDIRECT_URI=https://bookkeeping.yourdomain.com/auth/gmail/callback

# Exact Online OAuth2
EXACT_CLIENT_ID=your-exact-client-id
EXACT_CLIENT_SECRET=your-exact-client-secret
EXACT_REDIRECT_URI=https://bookkeeping.yourdomain.com/auth/exact/callback
ENVEOF
  chown ${APP_USER}:${APP_USER} "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "  Created .env template — EDIT THIS before starting the app!"
else
  echo "  .env already exists, skipping"
fi

# --- 7. Set up systemd services ---
echo "[7/8] Creating systemd services..."

cat > /etc/systemd/system/bookkeeping.service << 'SERVICEEOF'
[Unit]
Description=Bookkeeping Tools
After=network.target

[Service]
Type=simple
User=bookkeeping
WorkingDirectory=/home/bookkeeping/bookkeepingtools
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/home/bookkeeping/bookkeepingtools/.env

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/bookkeeping/bookkeepingtools/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
SERVICEEOF

systemctl daemon-reload
echo "  bookkeeping.service created"
echo "  NOTE: Don't start yet — edit .env first!"

# --- 8. Set up backups ---
echo "[8/8] Setting up daily SQLite backups..."
sudo -u "$APP_USER" mkdir -p "$BACKUP_DIR"

cat > /etc/cron.d/bookkeeping-backup << CRONEOF
# Daily backup of bookkeeping SQLite database at 3:00 AM
0 3 * * * ${APP_USER} /home/${APP_USER}/bookkeepingtools/deploy/backup.sh
CRONEOF
chmod 644 /etc/cron.d/bookkeeping-backup

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo ""
echo "  1. Edit the .env file:"
echo "     sudo -u $APP_USER nano $APP_DIR/.env"
echo ""
echo "  2. Set up Cloudflare Tunnel (as the $APP_USER user):"
echo "     sudo -u $APP_USER -i"
echo "     cloudflared tunnel login"
echo "     cloudflared tunnel create bookkeeping"
echo "     # Create ~/.cloudflared/config.yml (see README)"
echo "     exit"
echo ""
echo "  3. Install cloudflared as a systemd service:"
echo "     cloudflared service install"
echo "     systemctl enable --now cloudflared"
echo ""
echo "  4. Start the app:"
echo "     systemctl enable --now bookkeeping"
echo ""
echo "  5. Check logs:"
echo "     journalctl -u bookkeeping -f"
echo "     journalctl -u cloudflared -f"
echo ""
echo "  6. Firewall (optional, Cloudflare Tunnel needs no open ports):"
echo "     ufw allow OpenSSH"
echo "     ufw enable"
echo ""
