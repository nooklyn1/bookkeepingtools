# Bookkeeping Tools

Purchase invoice automation: Gmail → PDF/Excel extraction → regex-based parsing → Exact Online booking.

## Stack
Express + EJS + SQLite (better-sqlite3), session-based auth (Google OAuth2 + express-session), CSRF protection (csrf-sync)

## Project Structure
- `src/server.js` — app entry point, EJS layout wrapper, auth wall, CSRF middleware, route mounting
- `src/config.js` — environment variable loading (dotenv)
- `src/routes/` — Express routers:
  - `index.js` — dashboard with invoice counts, connection status, workflow start
  - `invoices.js` — list, review, save, book, reparse, delete, booking workflow, Gmail fetch/scan
  - `auth.js` — Gmail + Exact Online OAuth callbacks
  - `settings.js` — app settings, Exact Online sync, supplier rules CRUD + test endpoint
  - `login.js` — Google OAuth login, email allowlist
- `src/views/` — EJS templates, layout.ejs wraps all pages via custom render override
- `src/public/` — static assets (style.css, app.js with searchable selects, line item management, keyboard nav)
- `src/services/`:
  - `gmail.js` — fetch invoices (PDF/XLS attachments), scan & auto-label, relabel after booking, skip filters
  - `exactonline.js` — API wrapper (GET with auto-pagination, POST), suppliers/GL/VAT sync, purchase entry creation, document upload, duplicate detection
  - `invoice-parser.js` — per-supplier regex rules, generic fallback, date/number parsing (Dutch/English), auto-learn suggestion engine
  - `pdf-parser.js` — pdf-parse text extraction, Excel→PDF conversion via LibreOffice headless, path resolution
  - `excel-parser.js` — xlsx text extraction via sheet_to_csv
- `src/db/database.js` — SQLite init with WAL mode, schema exec, migrations
- `src/db/schema.sql` — tables: oauth_tokens, invoices, settings, suppliers, gl_accounts, vat_codes, journals, supplier_rules
- `src/auth/exactonline-auth.js` — Exact Online token management with in-memory cache + single-promise lock
- `src/auth/gmail-auth.js` — Gmail OAuth2 with auto-refresh token persistence
- `data/` — SQLite databases (bookkeeping.db + sessions.db) and downloaded PDFs in data/pdfs/
- `certs/` — HTTPS certificates (not committed)
- `scripts/improve-rules.js` — one-off script used during setup for bulk-improving supplier rules from sample texts
- `deploy/` — VPS setup (setup-vps.sh), update (update.sh), daily SQLite backup (backup.sh)
- `start.sh` — local dev: starts node server + cloudflared tunnel together

## Deployment
- Production: VPS running bare metal with systemd (`bookkeeping.service`), NOT Docker
- Cloudflare Tunnel exposes the app at the production domain (no open ports needed)
- HTTPS via mkcert local certs (Exact Online OAuth requires HTTPS, even behind tunnel)
- Daily SQLite backups via cron at 3 AM, 14-day retention
- Update: `sudo -u bookkeeping bash deploy/update.sh` (git pull + npm install + systemctl restart)
- Docker/docker-compose.yml exists but is unused in production

## Dev Workflow
- Server: `node src/server.js` (no nodemon — manual restart required after changes)
- Local dev also uses Cloudflare Tunnel (`start.sh` runs both)
- HTTPS with certs in `certs/` dir (needed for Exact Online OAuth)
- Restart: `kill $(pgrep -f 'node.*server.js'); sleep 1; node src/server.js &`
- Syntax check before restart: `node -e "require('./src/routes/invoices')"`

## Key Patterns
- Route ordering matters: literal routes (e.g. `/workflow/start`, `/:id/apply-suggestions`) MUST be defined before parameterized routes (`/:id`) in Express routers
- EJS layout: custom `res.render` override in server.js wraps views in `layout.ejs` — pass `title`, `flash`, `activePage`
- CSRF: token generated per-render via `generateToken(req)`, passed as `csrfToken` to all templates. Forms include `<input type="hidden" name="_csrf" value="<%= csrfToken %>">`
- CSS uses design tokens in `:root` with `--bk-` prefix (e.g. `--bk-accent`, `--bk-border`)
- Invoice statuses: `pending` (amber), `booked` (green), `error` (red)
- Journal defaults to `60` (Inkoopboek) but configurable via Settings → Default Journal dropdown (synced from Exact Online)
- Supplier rules: per-supplier regex patterns for extracting invoice fields, matched by email_from
- Auto-learn: `generateSuggestions()` in invoice-parser.js reverse-engineers regex patterns from user corrections. Suggestions are validated against the full raw text before being offered.
- Booking workflow: session-based queue that walks through all pending invoices one-by-one (save/book/skip/exit)
- Gmail scan: searches known supplier domains for invoice-keyword subjects, applies the configurable queue label (setting `gmail_label_queue`, default `4.Inkopen/4.1 Inkoopfacturen`) and matches its sublabels via `startsWith`. Hard-errors (pointing to Settings) if the label doesn't exist in Gmail.
- Gmail label names are stored in the settings table (`gmail_label_queue`, `gmail_label_processed`) and editable on the Settings page — no code change/deploy needed to rename them. Seeded via migration in `db/database.js` (preferring any legacy `booked_gmail_*` values).
- Gmail fetch: downloads PDF/XLS attachments, deduplicates by message_id+filename and filename+size (thread replies), filters non-invoice filenames
- After booking: relabels the Gmail message — adds `gmail_label_processed`, removes `gmail_label_queue` (either can be blank to skip)
- Local duplicate guard (`services/duplicate-check.js`): before booking, blocks if another invoice with the same supplier + invoice number is already booked/pending/error (overridable via "Book anyway"/force). Likely duplicates are also flagged on the dashboard and invoice list.
- Exact Online booking: uploads PDF as Document, creates PurchaseEntry with line items, GL account + VAT code from supplier defaults
- Duplicate detection: local supplier+invoice-number check (`duplicate-check.js`) runs first, then Exact Online PurchaseEntry YourRef check; both bypassed by force-override

## Gotchas
- HTML nested forms are ignored by browsers — use `formaction` attribute on buttons to override parent form action. The CSRF `getTokenFromRequest` handler accounts for duplicate `_csrf` fields (arrays) caused by nested forms.
- Exact API rate limit: 10 errors/hour per endpoint. Token refresh race conditions count as errors (400 "access_token not expired")
- Token management uses in-memory cache + single-promise lock in `exactonline-auth.js` to prevent concurrent refreshes
- Exact API `$top` doesn't prevent pagination — apiGet follows all `__next` links automatically
- `express.urlencoded({ extended: true })` parses duplicate form field names as arrays — check for this when reading `req.body` fields that might appear in nested forms
- LibreOffice headless required for Excel→PDF conversion (installed on VPS and local dev)
- `resolvePdfPath()` strips directory and resolves to `data/pdfs/` — handles path mismatches between local dev and VPS
