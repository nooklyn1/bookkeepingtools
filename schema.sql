CREATE TABLE IF NOT EXISTS oauth_tokens (
  service TEXT PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  token_expiry INTEGER,
  extra_data TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gmail_message_id TEXT,
  email_from TEXT,
  email_subject TEXT,
  email_date TEXT,
  pdf_filename TEXT,
  pdf_path TEXT,
  raw_text TEXT,
  supplier_name TEXT,
  supplier_id TEXT,
  invoice_number TEXT,
  invoice_date TEXT,
  due_date TEXT,
  description TEXT,
  your_ref TEXT,
  payment_condition TEXT,
  currency TEXT DEFAULT 'EUR',
  subtotal REAL,
  vat_amount REAL,
  total_amount REAL,
  line_items TEXT,
  journal TEXT,
  status TEXT DEFAULT 'pending',
  exactonline_entry_id TEXT,
  attachment_size INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(gmail_message_id, pdf_filename)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT,
  code TEXT,
  search_code TEXT,
  purchase_account TEXT,
  vat_code TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gl_accounts (
  id TEXT PRIMARY KEY,
  code TEXT,
  description TEXT,
  type INTEGER,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vat_codes (
  id TEXT PRIMARY KEY,
  code TEXT,
  description TEXT,
  percentage REAL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journals (
  id TEXT PRIMARY KEY,
  code TEXT,
  description TEXT,
  type INTEGER,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS supplier_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email_pattern TEXT NOT NULL,
  invoice_number_regex TEXT,
  date_regex TEXT,
  date_format TEXT DEFAULT 'DD-MM-YYYY',
  total_regex TEXT,
  subtotal_regex TEXT,
  vat_regex TEXT,
  due_date_regex TEXT,
  due_date_format TEXT,
  due_date_days INTEGER,
  number_format TEXT DEFAULT 'dutch',
  currency TEXT DEFAULT 'EUR',
  notes TEXT,
  supplier_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Partial index to speed up invoice-number duplicate lookups. Deliberately NOT
-- unique: the "book anyway" override must be able to create an intentional duplicate.
-- Excludes NULL/empty numbers so failed-extraction invoices are never indexed together.
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number ON invoices(invoice_number)
  WHERE invoice_number IS NOT NULL AND invoice_number != '';

-- Default settings
INSERT OR IGNORE INTO settings (key, value) VALUES ('gmail_search_query', 'has:attachment filename:pdf newer_than:30d');
INSERT OR IGNORE INTO settings (key, value) VALUES ('default_journal', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('own_email_domain', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('webhook_url', '');
