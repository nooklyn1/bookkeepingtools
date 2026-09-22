const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/bookkeeping.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run schema
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Migrations — add columns that don't exist yet
const cols = db.prepare("PRAGMA table_info(invoices)").all().map(c => c.name);
if (!cols.includes('attachment_size')) {
  db.exec('ALTER TABLE invoices ADD COLUMN attachment_size INTEGER DEFAULT 0');
}
if (!cols.includes('booked_at')) {
  db.exec('ALTER TABLE invoices ADD COLUMN booked_at TEXT');
}
if (!cols.includes('booked_by')) {
  db.exec('ALTER TABLE invoices ADD COLUMN booked_by TEXT');
}
if (!cols.includes('journal')) {
  db.exec('ALTER TABLE invoices ADD COLUMN journal TEXT');
}

// Supplier rules migrations
const ruleCols = db.prepare("PRAGMA table_info(supplier_rules)").all().map(c => c.name);
if (!ruleCols.includes('supplier_override_regex')) {
  db.exec('ALTER TABLE supplier_rules ADD COLUMN supplier_override_regex TEXT');
}

// Settings migration — introduce canonical Gmail label keys.
// gmail_label_queue     : label group holding invoices waiting to be booked
//                         (scanForInvoices targets this + all its sublabels via startsWith)
// gmail_label_processed : label applied after a successful booking ("Gedownload naar Exact")
// Seed from the pre-existing booked_gmail_* keys when they were configured in production,
// otherwise fall back to the current hard-coded defaults. Done here (not in schema.sql)
// so we can honour any value the user already saved.
const DEFAULT_LABEL_QUEUE = '4.Inkopen/4.1 Inkoopfacturen';
const DEFAULT_LABEL_PROCESSED = '4.Inkopen/4.1 Inkoopfacturen/4.1 Gedownload naar Exact';
const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
const seedSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
if (getSetting('gmail_label_queue') === undefined) {
  const legacyRemove = getSetting('booked_gmail_remove_label');
  seedSetting.run('gmail_label_queue', (legacyRemove && legacyRemove.trim()) || DEFAULT_LABEL_QUEUE);
}
if (getSetting('gmail_label_processed') === undefined) {
  const legacyAdd = getSetting('booked_gmail_add_label');
  seedSetting.run('gmail_label_processed', (legacyAdd && legacyAdd.trim()) || DEFAULT_LABEL_PROCESSED);
}

module.exports = db;
