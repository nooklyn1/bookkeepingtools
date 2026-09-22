# Bookkeeping Tools

A self-hosted web application for automating purchase invoice processing. Fetches invoices from Gmail, extracts data using per-supplier regex rules, and books them to Exact Online.

## What it does

1. **Fetch** — Pulls PDF/Excel invoice attachments from Gmail via the Gmail API
2. **Extract** — Parses invoice data (number, dates, amounts) using configurable per-supplier regex rules
3. **Review** — Presents each invoice side-by-side with its PDF for verification and correction
4. **Book** — Creates purchase entries in Exact Online with one click
5. **Learn** — Auto-suggests regex patterns when you correct extracted values, improving rules over time

## Stack

- **Backend**: Node.js + Express
- **Database**: SQLite (better-sqlite3) — zero config, single file
- **Templates**: EJS with layout wrapper
- **Auth**: Google OAuth2 (restrict access by email allowlist)
- **Integrations**: Gmail API, Exact Online REST API

## Quick start

### Prerequisites

- Node.js 20+
- Gmail OAuth2 credentials (Google Cloud Console)
- Exact Online OAuth2 app registration
- Local HTTPS certificates (for secure cookies)
- Cloudflare Tunnel (Exact Online requires a public callback URL — it does not accept `localhost`)

### Setup

```bash
git clone https://github.com/ChargertechBV/bookkeepingtools.git
cd bookkeepingtools
npm install
cp .env.example .env
# Edit .env with your OAuth credentials and session secret
```

Generate local HTTPS certs (required for Exact Online OAuth callbacks):

```bash
mkcert -install
mkdir -p certs
mkcert -cert-file certs/localhost.pem -key-file certs/localhost-key.pem localhost
```

### Cloudflare Tunnel

Exact Online and Google OAuth both require a public HTTPS callback URL — they do not accept `localhost`. A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) exposes your local server under a real domain without opening firewall ports.

Install `cloudflared` and create a named tunnel:

```bash
# Install (Debian/Ubuntu)
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install cloudflared

# Authenticate and create tunnel
cloudflared tunnel login
cloudflared tunnel create bookkeeping
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /home/<user>/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: bookkeeping.yourdomain.com
    service: https://localhost:3000
    originRequest:
      noTLSVerify: true   # localhost uses self-signed certs
  - service: http_status:404
```

Add a DNS CNAME record pointing `bookkeeping.yourdomain.com` to `<TUNNEL_ID>.cfargotunnel.com`, then run:

```bash
cloudflared tunnel run bookkeeping
```

Update the `*_REDIRECT_URI` variables in `.env` to use your public domain (e.g. `https://bookkeeping.yourdomain.com/auth/exact/callback`), and register these same URLs in the Google Cloud Console and Exact Online app center.

### Run

```bash
node src/server.js
```

Open https://localhost:3000 (or your tunnel domain) and sign in with an allowed Google account.

### Running as a systemd service

Create `/etc/systemd/system/bookkeeping.service`:

```ini
[Unit]
Description=Bookkeeping Tools
After=network.target

[Service]
Type=simple
User=niek
WorkingDirectory=/home/niek/bookkeepingtools
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/home/niek/bookkeepingtools/.env

[Install]
WantedBy=multi-user.target
```

Then enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bookkeeping
```

You can also install the Cloudflare tunnel as a systemd service:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

### Docker

```bash
docker compose up -d
```

Mounts `./data` (database + PDFs) and `./certs` (read-only). Configure via `.env` file.

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3000) |
| `SESSION_SECRET` | Express session secret |
| `ALLOWED_EMAILS` | Comma-separated Google emails allowed to log in |
| `GMAIL_CLIENT_ID` | Google OAuth2 client ID |
| `GMAIL_CLIENT_SECRET` | Google OAuth2 client secret |
| `EXACT_CLIENT_ID` | Exact Online OAuth2 client ID |
| `EXACT_CLIENT_SECRET` | Exact Online OAuth2 client secret |

## How it works

### Invoice processing workflow

The dashboard offers a **Start Booking** workflow that processes all pending invoices in sequence:

1. Fetches new emails from Gmail matching your search query
2. Extracts text from PDF/Excel attachments
3. Matches each invoice to a supplier rule by sender email
4. Applies regex patterns to extract invoice number, dates, and amounts
5. Presents each invoice for review with the PDF alongside an editable form
6. Books approved invoices to Exact Online as purchase entries

### Supplier rules

Each supplier gets a rule that maps an email pattern to a set of regex patterns:

- **Email pattern** — Regex matched against the sender address (e.g. `invoices@supplier\.com`)
- **Extraction regexes** — Patterns for invoice number, dates, subtotal, VAT, and total
- **Number format** — Dutch (`1.234,56`) or English (`1,234.56`)
- **Date format** — `DD-MM-YYYY`, `DD/MM/YYYY`, `YYYY-MM-DD`, etc.

Rules include a live test panel: paste invoice text and see what each regex extracts in real time.

### Auto-learn

When you manually correct an extracted value, the system searches the raw PDF text for the corrected value near known keywords (e.g. "Totaal", "BTW", "Factuurdatum"). If it finds a pattern that reliably extracts the correct value, it offers to update the supplier rule with one click.

## Project structure

```
src/
  server.js              # App entry point, middleware, layout wrapper
  config.js              # Environment variable loading
  db/
    database.js          # SQLite init
    schema.sql           # Table definitions
  routes/
    index.js             # Dashboard
    invoices.js          # Invoice CRUD, workflow, booking
    settings.js          # Settings, supplier rules CRUD
    auth.js              # Gmail + Exact Online OAuth flows
    login.js             # Google sign-in
  services/
    gmail.js             # Gmail API integration
    exactonline.js       # Exact Online API integration
    invoice-parser.js    # Per-supplier regex extraction + auto-learn
    pdf-parser.js        # PDF text extraction
    excel-parser.js      # Excel text extraction
  views/                 # EJS templates
  public/                # Static assets (CSS, JS)
data/                    # SQLite database + downloaded PDFs
certs/                   # HTTPS certificates (not committed)
```

## License

Private / proprietary.
