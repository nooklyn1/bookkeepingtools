# Bookkeeping Tools Improvements Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 15 improvements across UX, performance, and new features for the bookkeeping automation tool.

**Architecture:** Express + EJS + SQLite app. All changes are server-side JS + EJS templates + one CSS file. No test framework exists — verify with `node -e "require('./src/routes/...')"` syntax checks and manual testing.

**Tech Stack:** Node.js, Express 4, EJS, better-sqlite3, googleapis

---

## Chunk 1: Backend Quick Fixes

### Task 1: Gmail fetch pagination (currently limited to 50)

**Files:**
- Modify: `src/services/gmail.js` — `fetchInvoices()` function (line ~80-85)

- [ ] **Step 1: Add pagination loop to fetchInvoices**

Replace the single `messages.list` call with a pagination loop like `scanForInvoices` already uses. Cap at 200 messages.

```js
// Replace lines 80-86 in fetchInvoices:
const messages = [];
let pageToken = undefined;
while (messages.length < 200) {
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: searchQuery,
    maxResults: 100,
    pageToken,
  });
  const batch = listRes.data.messages || [];
  messages.push(...batch);
  pageToken = listRes.data.nextPageToken;
  if (!pageToken || batch.length === 0) break;
}
```

- [ ] **Step 2: Syntax check**
Run: `node -e "require('./src/services/gmail')"`

- [ ] **Step 3: Commit**

---

### Task 2: Cache supplier rules and suppliers for parsing performance

**Files:**
- Modify: `src/services/invoice-parser.js` — `findRule()` and `matchSupplier()`/`matchSupplierId()`

- [ ] **Step 1: Add simple in-memory cache with TTL**

Add at top of invoice-parser.js:
```js
let ruleCache = { data: null, ts: 0 };
let supplierCache = { data: null, ts: 0 };
const CACHE_TTL = 60000; // 1 minute

function getCachedRules() {
  if (ruleCache.data && Date.now() - ruleCache.ts < CACHE_TTL) return ruleCache.data;
  ruleCache.data = db.prepare('SELECT * FROM supplier_rules').all();
  ruleCache.ts = Date.now();
  return ruleCache.data;
}

function getCachedSuppliers() {
  if (supplierCache.data && Date.now() - supplierCache.ts < CACHE_TTL) return supplierCache.data;
  supplierCache.data = db.prepare('SELECT id, name, code, search_code FROM suppliers').all();
  supplierCache.ts = Date.now();
  return supplierCache.data;
}
```

- [ ] **Step 2: Replace direct DB queries in findRule, matchSupplier, matchSupplierId**

Change `db.prepare('SELECT * FROM supplier_rules').all()` → `getCachedRules()`
Change `db.prepare('SELECT id, name, code, search_code FROM suppliers').all()` → `getCachedSuppliers()`

- [ ] **Step 3: Syntax check and commit**

---

## Chunk 2: Invoice List Improvements

### Task 3: Pagination on invoice list

**Files:**
- Modify: `src/routes/invoices.js` — GET `/` handler
- Modify: `src/views/invoices/list.ejs` — add pagination controls

- [ ] **Step 1: Add LIMIT/OFFSET to invoice queries**

In the GET `/` handler, read `page` from query params:
```js
const page = Math.max(1, parseInt(req.query.page) || 1);
const perPage = 50;
const offset = (page - 1) * perPage;
```

Add `LIMIT ? OFFSET ?` to both queries (with status filter and without), passing `perPage + 1` as limit (to detect if there's a next page). Then slice results to `perPage`.

- [ ] **Step 2: Pass pagination info to template**

```js
const hasNext = invoices.length > perPage;
if (hasNext) invoices.pop();
// Pass to render: page, hasNext, perPage
```

- [ ] **Step 3: Add pagination controls to list.ejs**

After the `</table>`, add prev/next links:
```ejs
<div class="pagination">
  <% if (page > 1) { %>
    <a href="/invoices?status=<%= currentStatus %>&page=<%= page - 1 %>" class="btn btn-sm btn-outline">&larr; Previous</a>
  <% } %>
  <span class="pagination-info">Page <%= page %></span>
  <% if (hasNext) { %>
    <a href="/invoices?status=<%= currentStatus %>&page=<%= page + 1 %>" class="btn btn-sm btn-outline">Next &rarr;</a>
  <% } %>
</div>
```

- [ ] **Step 4: Add `.pagination` CSS**
- [ ] **Step 5: Syntax check and commit**

---

### Task 4: Search on invoice list

**Files:**
- Modify: `src/routes/invoices.js` — GET `/` handler
- Modify: `src/views/invoices/list.ejs` — add search input

- [ ] **Step 1: Add search query parameter handling**

Read `q` from query params. If present, add WHERE clause:
```js
const search = req.query.q || '';
// Build WHERE conditions array, add LIKE clauses for supplier_name, invoice_number, email_subject
```

- [ ] **Step 2: Add search bar to list.ejs**

Above the filter tabs, add:
```ejs
<form method="GET" action="/invoices" class="search-bar">
  <input type="search" name="q" value="<%= typeof search !== 'undefined' ? search : '' %>" placeholder="Search supplier, invoice #, subject...">
  <input type="hidden" name="status" value="<%= currentStatus %>">
  <button type="submit" class="btn btn-sm btn-outline">Search</button>
</form>
```

- [ ] **Step 3: Syntax check and commit**

---

### Task 5: Bulk operations (delete, rebook)

**Files:**
- Modify: `src/routes/invoices.js` — add POST `/bulk` route
- Modify: `src/views/invoices/list.ejs` — add checkboxes and bulk action bar

- [ ] **Step 1: Add checkboxes to invoice table rows**

Add a checkbox column to the table. Each row gets `<input type="checkbox" name="ids" value="<%= inv.id %>">`.
Wrap the table in a form with bulk action buttons.

- [ ] **Step 2: Add bulk delete route**

```js
router.post('/bulk/delete', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids].filter(Boolean);
  if (ids.length === 0) return res.redirect('/invoices?flash=No invoices selected');
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM invoices WHERE id IN (${placeholders})`).run(...ids);
  res.redirect(`/invoices?flash=Deleted ${ids.length} invoice(s)`);
});
```

- [ ] **Step 3: Add bulk rebook route**

Reset selected invoices to pending status so they can be rebooked:
```js
router.post('/bulk/reset', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids].filter(Boolean);
  if (ids.length === 0) return res.redirect('/invoices?flash=No invoices selected');
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE invoices SET status = 'pending', error_message = NULL WHERE id IN (${placeholders})`).run(...ids);
  res.redirect(`/invoices?flash=Reset ${ids.length} invoice(s) to pending`);
});
```

- [ ] **Step 4: Add JS for select-all checkbox and bulk action bar visibility**
- [ ] **Step 5: Syntax check and commit**

---

## Chunk 3: Dashboard & Workflow

### Task 6: Dashboard stats improvements

**Files:**
- Modify: `src/routes/index.js` — add queries for recent activity and period totals
- Modify: `src/views/index.ejs` — show recent bookings and totals

- [ ] **Step 1: Add queries to index route**

```js
const recentBookings = db.prepare(`
  SELECT id, supplier_name, invoice_number, total_amount, currency, updated_at
  FROM invoices WHERE status = 'booked'
  ORDER BY updated_at DESC LIMIT 5
`).all();

const periodTotals = db.prepare(`
  SELECT currency, SUM(total_amount) as total, COUNT(*) as count
  FROM invoices WHERE status = 'booked'
  AND invoice_date >= date('now', '-30 days')
  GROUP BY currency
`).all();

const topSuppliers = db.prepare(`
  SELECT supplier_name, COUNT(*) as count, SUM(total_amount) as total
  FROM invoices WHERE status = 'booked'
  AND invoice_date >= date('now', '-90 days')
  GROUP BY supplier_name ORDER BY total DESC LIMIT 5
`).all();
```

- [ ] **Step 2: Add sections to index.ejs**

Recent bookings table, period totals cards, top suppliers list.

- [ ] **Step 3: Syntax check and commit**

---

### Task 7: Smarter supplier rule auto-creation

**Files:**
- Modify: `src/routes/invoices.js` — POST `/:id` save handler (around line 348-385)

- [ ] **Step 1: When creating a new rule from first invoice, also run generateSuggestions and apply immediately**

In the block where a new rule is created (domain-based), after the INSERT, immediately run generateSuggestions and UPDATE the rule with the results:

```js
if (domain) {
  const emailPattern = domain.replace(/\./g, '\\.');
  const result = db.prepare(`
    INSERT INTO supplier_rules (name, email_pattern, supplier_id)
    VALUES (?, ?, ?)
  `).run(supplier_name || domain, emailPattern, supplier_id);

  // Auto-apply learned patterns to the new rule
  if (inv.raw_text && result.lastInsertRowid) {
    const newRule = db.prepare('SELECT * FROM supplier_rules WHERE id = ?').get(result.lastInsertRowid);
    const suggestions = invoiceParser.generateSuggestions(inv.raw_text, savedValues, newRule);
    if (suggestions) {
      const allowedFields = ['invoice_number_regex', 'date_regex', 'date_format', 'due_date_regex', 'due_date_format', 'total_regex', 'subtotal_regex', 'vat_regex'];
      const updates = {};
      for (const [field, s] of Object.entries(suggestions)) {
        if (allowedFields.includes(field)) {
          updates[field] = s.regex;
          if (s.date_format && s.format_field) updates[s.format_field] = s.date_format;
        }
      }
      if (Object.keys(updates).length > 0) {
        const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
        db.prepare(`UPDATE supplier_rules SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), result.lastInsertRowid);
      }
    }
  }
}
```

- [ ] **Step 2: Syntax check and commit**

---

### Task 8: Persist booking workflow in DB instead of session

**Files:**
- Modify: `src/db/schema.sql` — add `booking_workflows` table
- Modify: `src/db/database.js` — add migration for new table
- Modify: `src/routes/invoices.js` — replace `req.session.bookingWorkflow` with DB reads/writes

- [ ] **Step 1: Add schema and migration**

```sql
CREATE TABLE IF NOT EXISTS booking_workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT,
  queue TEXT,  -- JSON array of invoice IDs
  current_index INTEGER DEFAULT 0,
  results TEXT DEFAULT '[]',  -- JSON array of results
  created_at TEXT DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Replace session-based workflow with DB-based**

POST `/workflow/start`: INSERT into booking_workflows, redirect with `wf_id` param.
GET `/workflow/next`: UPDATE current_index in DB.
GET `/workflow/done`: SELECT from DB, DELETE workflow.
POST `/workflow/skip`: UPDATE results in DB.
POST `/:id/book`: UPDATE results in DB.

Pass `wf_id` as query param instead of relying on session.

- [ ] **Step 3: Syntax check and commit**

---

### Task 9: Scheduled Gmail fetch

**Files:**
- Modify: `src/server.js` — add setInterval for auto-fetch
- Modify: `src/services/gmail.js` — extract a `autoFetch()` function

- [ ] **Step 1: Add autoFetch function to gmail.js**

```js
async function autoFetch() {
  const gmailAuth = require('../auth/gmail-auth');
  if (!gmailAuth.isConnected()) return;

  const setting = db.prepare("SELECT value FROM settings WHERE key = 'gmail_search_query'").get();
  const query = setting?.value || 'has:attachment filename:pdf newer_than:30d';

  try {
    const result = await fetchInvoices(query);
    if (result.imported > 0) {
      console.log(`Auto-fetch: imported ${result.imported} new invoices`);
    }
  } catch (err) {
    console.error('Auto-fetch error:', err.message);
  }
}
```

Export it and add to module.exports.

- [ ] **Step 2: Add interval in server.js**

After the server starts listening:
```js
// Auto-fetch invoices from Gmail every hour
const gmailService = require('./services/gmail');
setInterval(() => gmailService.autoFetch(), 60 * 60 * 1000);
```

- [ ] **Step 3: Syntax check and commit**

---

## Chunk 4: New Features

### Task 10: Credit note UI handling

**Files:**
- Modify: `src/views/invoices/list.ejs` — show credit note indicator
- Modify: `src/views/invoices/review.ejs` — show credit note banner
- Modify: `src/public/style.css` — credit note styling

- [ ] **Step 1: Add credit note detection in list view**

In list.ejs, check if `inv.total_amount < 0` and show a "Credit" badge next to the status badge.

- [ ] **Step 2: Add credit note banner in review view**

In review.ejs, above the form, if `invoice.total_amount < 0`:
```ejs
<div class="credit-note-banner">Credit Note — amounts are negative</div>
```

- [ ] **Step 3: Add CSS for `.credit-note-banner` and credit badge**
- [ ] **Step 4: Commit**

---

### Task 11: Recurring invoice detection

**Files:**
- Create: `src/services/recurring-detector.js`
- Modify: `src/routes/index.js` — show missing recurring invoices on dashboard
- Modify: `src/views/index.ejs` — display alerts

- [ ] **Step 1: Create recurring-detector.js**

Analyze booked invoices to find patterns: same supplier, regular intervals (monthly/quarterly), similar amounts.

```js
function detectRecurring() {
  const recurring = db.prepare(`
    SELECT supplier_name, supplier_id, currency,
      COUNT(*) as count,
      ROUND(AVG(total_amount), 2) as avg_amount,
      MAX(invoice_date) as last_date,
      ROUND(julianday(MAX(invoice_date)) - julianday(MIN(invoice_date))) / (COUNT(*) - 1) as avg_interval_days
    FROM invoices
    WHERE status = 'booked' AND supplier_name IS NOT NULL
    AND invoice_date >= date('now', '-365 days')
    GROUP BY supplier_name
    HAVING count >= 3
    AND avg_interval_days BETWEEN 20 AND 100
    ORDER BY last_date
  `).all();

  // Flag suppliers whose last invoice is overdue by > 1.5x their interval
  return recurring.filter(r => {
    const daysSinceLast = (Date.now() - new Date(r.last_date).getTime()) / 86400000;
    return daysSinceLast > r.avg_interval_days * 1.5;
  }).map(r => ({
    ...r,
    days_overdue: Math.round((Date.now() - new Date(r.last_date).getTime()) / 86400000 - r.avg_interval_days),
  }));
}
```

- [ ] **Step 2: Add to dashboard route and template**

Show "Expected invoices" alert section on dashboard when there are overdue recurring suppliers.

- [ ] **Step 3: Syntax check and commit**

---

### Task 12: Audit trail (booked_at, booked_by)

**Files:**
- Modify: `src/db/database.js` — migration to add columns
- Modify: `src/routes/invoices.js` — record who booked and when
- Modify: `src/views/invoices/review.ejs` — show audit info
- Modify: `src/views/invoices/list.ejs` — show booked_by in table

- [ ] **Step 1: Add migration**

```js
if (!cols.includes('booked_at')) {
  db.exec('ALTER TABLE invoices ADD COLUMN booked_at TEXT');
}
if (!cols.includes('booked_by')) {
  db.exec('ALTER TABLE invoices ADD COLUMN booked_by TEXT');
}
```

- [ ] **Step 2: Set booked_at and booked_by on successful booking**

In POST `/:id/book`, after successful booking:
```js
db.prepare(`
  UPDATE invoices SET status = 'booked', exactonline_entry_id = ?, error_message = NULL,
    booked_at = datetime('now'), booked_by = ?, updated_at = datetime('now')
  WHERE id = ?
`).run(String(entryNumber), req.session.user?.email || 'unknown', invoice.id);
```

- [ ] **Step 3: Show in review.ejs**

In the status banner for booked invoices, add:
```ejs
<% if (invoice.booked_at) { %>
  <small>by <%= invoice.booked_by %> on <%= invoice.booked_at %></small>
<% } %>
```

- [ ] **Step 4: Syntax check and commit**

---

### Task 13: Per-invoice journal override

**Files:**
- Modify: `src/views/invoices/review.ejs` — add journal dropdown
- Modify: `src/routes/invoices.js` — pass journals to review, save journal field, pass to booking
- Modify: `src/services/exactonline.js` — accept journal override in createPurchaseEntry

- [ ] **Step 1: Load journals in review route and save handler**

In GET `/:id`, load journals and pass to template:
```js
const journals = db.prepare('SELECT id, code, description FROM journals ORDER BY code').all();
```

In POST `/:id`, save the journal field:
```js
// Add journal to UPDATE SET clause
```

- [ ] **Step 2: Add journal dropdown to review.ejs**

In the Invoice Details section:
```ejs
<label>Journal
  <select name="journal">
    <option value="">-- Default --</option>
    <% for (const j of journals) { %>
      <option value="<%= j.code %>" <%= invoice.journal === j.code ? 'selected' : '' %>><%= j.code %> - <%= j.description %></option>
    <% } %>
  </select>
</label>
```

- [ ] **Step 3: Use per-invoice journal in createPurchaseEntry**

Change createPurchaseEntry to accept a journal override:
```js
const journalCode = invoice.journal || journalSetting?.value || '60';
```

- [ ] **Step 4: Syntax check and commit**

---

### Task 14: Multi-currency display

**Files:**
- Modify: `src/views/invoices/review.ejs` — show exchange rate note for non-EUR
- Modify: `src/views/invoices/list.ejs` — already handles currency display, just verify

- [ ] **Step 1: Add non-EUR info banner**

In review.ejs, in the totals section, if currency !== 'EUR':
```ejs
<% if ((invoice.currency || 'EUR') !== 'EUR') { %>
  <small class="text-muted">Non-EUR invoice — Exact Online will apply the exchange rate at booking date</small>
<% } %>
```

- [ ] **Step 2: Commit**

---

### Task 15: Notification on booking errors (console + optional webhook)

**Files:**
- Create: `src/services/notifications.js`
- Modify: `src/routes/invoices.js` — call notify on booking error
- Modify: `src/db/schema.sql` — add webhook_url setting

- [ ] **Step 1: Create notifications.js**

```js
const db = require('../db/database');

async function notifyError(invoice, error) {
  console.error(`[BOOKING ERROR] Invoice #${invoice.id} (${invoice.supplier_name}): ${error}`);

  const webhookUrl = db.prepare("SELECT value FROM settings WHERE key = 'webhook_url'").get()?.value;
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `Booking failed for invoice #${invoice.id} (${invoice.supplier_name || 'unknown'}): ${error}`,
        invoice_id: invoice.id,
        supplier: invoice.supplier_name,
        error: String(error),
      }),
    });
  } catch (err) {
    console.error('Webhook notification failed:', err.message);
  }
}

module.exports = { notifyError };
```

- [ ] **Step 2: Call from booking error handler**

In POST `/:id/book` catch block:
```js
const notifications = require('../services/notifications');
await notifications.notifyError(invoice, err.message);
```

- [ ] **Step 3: Add webhook_url to settings UI**

Add a text input for webhook URL in settings.ejs and handle it in the POST handler.

- [ ] **Step 4: Add default setting**

In schema.sql: `INSERT OR IGNORE INTO settings (key, value) VALUES ('webhook_url', '');`

- [ ] **Step 5: Syntax check and commit**

---

