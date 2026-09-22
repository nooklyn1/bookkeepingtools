const express = require('express');
const router = express.Router();
const db = require('../db/database');
const exactService = require('../services/exactonline');
const exactAuth = require('../auth/exactonline-auth');
const invoiceParser = require('../services/invoice-parser');

router.use((req, res, next) => { res.locals.activePage = 'settings'; next(); });

router.get('/', (req, res) => {
  const settings = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    settings[row.key] = row.value;
  }

  const supplierCount = db.prepare('SELECT COUNT(*) as c FROM suppliers').get().c;
  const glAccountCount = db.prepare('SELECT COUNT(*) as c FROM gl_accounts').get().c;
  const vatCodeCount = db.prepare('SELECT COUNT(*) as c FROM vat_codes').get().c;
  const journalCount = db.prepare('SELECT COUNT(*) as c FROM journals').get().c;
  const ruleCount = db.prepare('SELECT COUNT(*) as c FROM supplier_rules').get().c;
  const journals = db.prepare('SELECT id, code, description FROM journals ORDER BY code').all();

  res.render('settings', {
    title: 'Settings',
    settings,
    lookupCounts: { suppliers: supplierCount, glAccounts: glAccountCount, vatCodes: vatCodeCount, journals: journalCount },
    journals,
    ruleCount,
    exactConnected: exactAuth.isConnected(),
    flash: req.query.flash,
  });
});

router.post('/', (req, res) => {
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  if (req.body.gmail_search_query !== undefined) {
    upsert.run('gmail_search_query', req.body.gmail_search_query);
  }
  if (req.body.default_journal !== undefined) {
    upsert.run('default_journal', req.body.default_journal);
  }
  if (req.body.gmail_label_queue !== undefined) {
    upsert.run('gmail_label_queue', req.body.gmail_label_queue.trim());
  }
  if (req.body.gmail_label_processed !== undefined) {
    upsert.run('gmail_label_processed', req.body.gmail_label_processed.trim());
  }
  if (req.body.webhook_url !== undefined) {
    upsert.run('webhook_url', req.body.webhook_url.trim());
  }

  res.redirect('/settings?flash=Settings saved');
});

router.post('/sync', async (req, res) => {
  try {
    // Check if we synced recently (within 24h) unless force=1
    const lastSync = db.prepare("SELECT value FROM settings WHERE key = 'last_sync'").get();
    const hoursSince = lastSync ? (Date.now() - new Date(lastSync.value).getTime()) / 3600000 : Infinity;
    const force = req.query.force === '1';

    if (hoursSince < 24 && !force) {
      return res.redirect(`/settings?flash=Already synced ${Math.round(hoursSince)}h ago. Use force sync to refresh.`);
    }

    const suppliers = await exactService.getSuppliers();
    const upsertSupplier = db.prepare('INSERT INTO suppliers (id, name, code, search_code, purchase_account, vat_code, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\')) ON CONFLICT(id) DO UPDATE SET name=excluded.name, code=excluded.code, search_code=excluded.search_code, purchase_account=excluded.purchase_account, vat_code=excluded.vat_code, updated_at=datetime(\'now\')');
    for (const s of suppliers) {
      upsertSupplier.run(s.ID, s.Name, s.Code, s.SearchCode, s.GLAccountPurchase, s.PurchaseVATCode);
    }

    const glAccounts = await exactService.getGLAccounts();
    const upsertGL = db.prepare('INSERT INTO gl_accounts (id, code, description, type, updated_at) VALUES (?, ?, ?, ?, datetime(\'now\')) ON CONFLICT(id) DO UPDATE SET code=excluded.code, description=excluded.description, type=excluded.type, updated_at=datetime(\'now\')');
    for (const gl of glAccounts) {
      upsertGL.run(gl.ID, gl.Code, gl.Description, gl.Type);
    }

    const vatCodes = await exactService.getVATCodes();
    const upsertVAT = db.prepare('INSERT INTO vat_codes (id, code, description, percentage, updated_at) VALUES (?, ?, ?, ?, datetime(\'now\')) ON CONFLICT(id) DO UPDATE SET code=excluded.code, description=excluded.description, percentage=excluded.percentage, updated_at=datetime(\'now\')');
    for (const v of vatCodes) {
      upsertVAT.run(v.ID, v.Code, v.Description, v.Percentage);
    }

    const journals = await exactService.getJournals();
    const upsertJournal = db.prepare('INSERT INTO journals (id, code, description, type, updated_at) VALUES (?, ?, ?, ?, datetime(\'now\')) ON CONFLICT(id) DO UPDATE SET code=excluded.code, description=excluded.description, type=excluded.type, updated_at=datetime(\'now\')');
    for (const j of journals) {
      upsertJournal.run(j.ID, j.Code, j.Description, j.Type);
    }

    // Record sync timestamp
    db.prepare("INSERT INTO settings (key, value) VALUES ('last_sync', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = datetime('now')").run();

    res.redirect(`/settings?flash=Synced: ${suppliers.length} suppliers, ${glAccounts.length} GL accounts, ${vatCodes.length} VAT codes, ${journals.length} journals`);
  } catch (err) {
    console.error('Sync error:', err);
    res.redirect(`/settings?flash=${encodeURIComponent('Sync failed: ' + String(err.message).slice(0, 200))}`);
  }
});

// --- Supplier Rules CRUD ---

router.get('/rules', (req, res) => {
  const rules = db.prepare('SELECT sr.*, s.name as supplier_name_exact FROM supplier_rules sr LEFT JOIN suppliers s ON sr.supplier_id = s.id ORDER BY sr.name').all();
  const suppliers = db.prepare('SELECT id, name, code FROM suppliers ORDER BY name').all();

  res.render('settings/rules', {
    title: 'Supplier Rules',
    rules,
    suppliers,
    flash: req.query.flash,
  });
});

router.get('/rules/new', (req, res) => {
  const suppliers = db.prepare('SELECT id, name, code FROM suppliers ORDER BY name').all();

  // Pre-fill from query params (used by "Create rule" link and auto-learn suggestions)
  const rule = {
    id: null,
    name: req.query.name || '',
    email_pattern: req.query.email_pattern || '',
    invoice_number_regex: req.query.invoice_number_regex || '',
    date_regex: req.query.date_regex || '',
    date_format: req.query.date_format || 'DD-MM-YYYY',
    due_date_regex: req.query.due_date_regex || '',
    due_date_format: req.query.due_date_format || '',
    total_regex: req.query.total_regex || '',
    subtotal_regex: req.query.subtotal_regex || '',
    vat_regex: req.query.vat_regex || '',
    number_format: 'dutch',
    currency: 'EUR',
    notes: '',
    supplier_id: req.query.supplier_id || '',
  };

  const sampleText = req.query.sample_text || '';

  res.render('settings/rule-edit', {
    title: 'New Supplier Rule',
    rule,
    suppliers,
    sampleText,
    flash: req.query.flash,
  });
});

router.get('/rules/:id/edit', (req, res) => {
  const rule = db.prepare('SELECT * FROM supplier_rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.redirect('/settings/rules?flash=Rule not found');

  const suppliers = db.prepare('SELECT id, name, code FROM suppliers ORDER BY name').all();

  res.render('settings/rule-edit', {
    title: 'Edit Supplier Rule',
    rule,
    suppliers,
    sampleText: '',
    flash: req.query.flash,
  });
});

function validateRuleRegexes(fields) {
  const regexFields = ['email_pattern', 'invoice_number_regex', 'date_regex', 'total_regex', 'subtotal_regex', 'vat_regex', 'supplier_override_regex'];
  for (const field of regexFields) {
    if (fields[field] && !invoiceParser.isRegexSafe(fields[field])) {
      return `Invalid or unsafe regex in ${field.replace(/_/g, ' ')}`;
    }
  }
  return null;
}

router.post('/rules', (req, res) => {
  const { name, email_pattern, invoice_number_regex, date_regex, date_format, total_regex, subtotal_regex, vat_regex, number_format, currency, notes, supplier_id, supplier_override_regex } = req.body;

  if (!name || !email_pattern) {
    return res.redirect('/settings/rules/new?flash=Name and email pattern are required');
  }

  const regexError = validateRuleRegexes(req.body);
  if (regexError) {
    return res.redirect(`/settings/rules/new?flash=${encodeURIComponent(regexError)}`);
  }

  db.prepare(`
    INSERT INTO supplier_rules (name, email_pattern, invoice_number_regex, date_regex, date_format, total_regex, subtotal_regex, vat_regex, number_format, currency, notes, supplier_id, supplier_override_regex)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, email_pattern, invoice_number_regex || null, date_regex || null, date_format || 'DD-MM-YYYY', total_regex || null, subtotal_regex || null, vat_regex || null, number_format || 'dutch', currency || 'EUR', notes || null, supplier_id || null, supplier_override_regex || null);

  res.redirect('/settings/rules?flash=Rule created');
});

router.post('/rules/:id', (req, res) => {
  const { name, email_pattern, invoice_number_regex, date_regex, date_format, total_regex, subtotal_regex, vat_regex, number_format, currency, notes, supplier_id, supplier_override_regex } = req.body;

  if (!name || !email_pattern) {
    return res.redirect(`/settings/rules/${req.params.id}/edit?flash=Name and email pattern are required`);
  }

  const regexError = validateRuleRegexes(req.body);
  if (regexError) {
    return res.redirect(`/settings/rules/${req.params.id}/edit?flash=${encodeURIComponent(regexError)}`);
  }

  db.prepare(`
    UPDATE supplier_rules SET
      name = ?, email_pattern = ?, invoice_number_regex = ?, date_regex = ?, date_format = ?,
      total_regex = ?, subtotal_regex = ?, vat_regex = ?, number_format = ?, currency = ?,
      notes = ?, supplier_id = ?, supplier_override_regex = ?
    WHERE id = ?
  `).run(name, email_pattern, invoice_number_regex || null, date_regex || null, date_format || 'DD-MM-YYYY', total_regex || null, subtotal_regex || null, vat_regex || null, number_format || 'dutch', currency || 'EUR', notes || null, supplier_id || null, supplier_override_regex || null, req.params.id);

  res.redirect('/settings/rules?flash=Rule updated');
});

router.post('/rules/:id/delete', (req, res) => {
  db.prepare('DELETE FROM supplier_rules WHERE id = ?').run(req.params.id);
  res.redirect('/settings/rules?flash=Rule deleted');
});

// Test endpoint: apply rule regexes to text and return extracted fields
router.post('/rules/test', (req, res) => {
  const { text, rule } = req.body;
  if (!text || !rule) {
    return res.json({ error: 'text and rule are required' });
  }

  // Limit text size to prevent ReDoS on large inputs
  const limitedText = typeof text === 'string' ? text.slice(0, 50000) : '';

  const regexError = validateRuleRegexes(rule);
  if (regexError) {
    return res.json({ error: regexError });
  }

  const result = invoiceParser.testRule(limitedText, rule);
  res.json(result);
});

module.exports = router;
