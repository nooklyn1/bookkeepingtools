const express = require('express');
const router = express.Router();
const db = require('../db/database');
const gmailService = require('../services/gmail');

router.use((req, res, next) => { res.locals.activePage = 'invoices'; next(); });
const path = require('path');
const pdfParser = require('../services/pdf-parser');
const excelParser = require('../services/excel-parser');
const invoiceParser = require('../services/invoice-parser');
const exactService = require('../services/exactonline');
const duplicateCheck = require('../services/duplicate-check');

const { PDFS_DIR, resolvePdfPath, isExcelFile } = pdfParser;

async function extractTextFromFile(filePath) {
  if (isExcelFile(filePath)) {
    return excelParser.extractText(filePath);
  }
  return pdfParser.extractText(filePath);
}

function sanitizeFlash(msg) {
  return encodeURIComponent(String(msg).slice(0, 200));
}

const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'icloud.com', 'me.com', 'mac.com', 'msn.com', 'aol.com',
  'protonmail.com', 'proton.me', 'zoho.com', 'mail.com', 'gmx.com', 'gmx.net',
]);

async function autoParseInvoices() {
  const unparsed = db.prepare("SELECT * FROM invoices WHERE status = 'pending' AND raw_text IS NULL").all();
  for (const inv of unparsed) {
    try {
      const text = await extractTextFromFile(resolvePdfPath(inv.pdf_path));
      const parsed = invoiceParser.parseInvoice(text, inv.email_from);

      db.prepare(`
        UPDATE invoices SET
          raw_text = ?,
          supplier_name = COALESCE(?, supplier_name),
          supplier_id = COALESCE(?, supplier_id),
          invoice_number = COALESCE(?, invoice_number),
          invoice_date = COALESCE(?, invoice_date),
          due_date = COALESCE(?, due_date),
          subtotal = COALESCE(?, subtotal),
          vat_amount = COALESCE(?, vat_amount),
          total_amount = COALESCE(?, total_amount),
          line_items = ?,
          currency = COALESCE(?, currency),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        text, parsed.supplier_name, parsed.supplier_id, parsed.invoice_number,
        parsed.invoice_date, parsed.due_date, parsed.subtotal, parsed.vat_amount,
        parsed.total_amount, JSON.stringify(parsed.line_items), parsed.currency, inv.id
      );
    } catch (parseErr) {
      console.error(`Parse error for invoice ${inv.id}:`, parseErr);
    }
  }
}

// List invoices
router.get('/', (req, res) => {
  const status = req.query.status || '';
  const search = req.query.q || '';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 50;
  const offset = (page - 1) * perPage;

  const conditions = [];
  const params = [];
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (search) {
    conditions.push('(supplier_name LIKE ? OR invoice_number LIKE ? OR email_subject LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  let invoices = db.prepare(`SELECT * FROM invoices ${where} ORDER BY email_date DESC LIMIT ? OFFSET ?`).all(...params, perPage + 1, offset);

  const hasNext = invoices.length > perPage;
  if (hasNext) invoices.pop();

  // Get counts per status for filter tabs
  const statusCounts = { pending: 0, booked: 0, error: 0, total: 0 };
  for (const row of db.prepare('SELECT status, COUNT(*) as count FROM invoices GROUP BY status').all()) {
    statusCounts[row.status] = row.count;
    statusCounts.total += row.count;
  }

  // Flag pending rows on this page that look like duplicates of another invoice
  let duplicateIds = new Set();
  try {
    duplicateIds = duplicateCheck.flaggedPendingIds(invoices.map(i => i.id));
  } catch (e) { /* ignore */ }

  res.render('invoices/list', {
    title: 'Invoices',
    invoices,
    currentStatus: status,
    search,
    page,
    hasNext,
    statusCounts,
    duplicateIds,
    flash: req.query.flash,
  });
});

// Scan Gmail for invoice emails and auto-label them
router.post('/scan', async (req, res) => {
  try {
    const result = await gmailService.scanForInvoices();
    res.redirect(`/invoices?flash=${sanitizeFlash(`Scanned ${result.scanned} emails from ${result.domains} suppliers, labeled ${result.labeled} new invoices (${result.alreadyLabeled} already labeled)`)}`);
  } catch (err) {
    console.error('Scan error:', err);
    res.redirect(`/invoices?flash=${sanitizeFlash('Scan failed: ' + err.message)}`);
  }
});

// Fetch from Gmail
router.post('/fetch', async (req, res) => {
  try {
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'gmail_search_query'").get();
    const query = setting?.value || 'has:attachment filename:pdf newer_than:30d';
    const result = await gmailService.fetchInvoices(query);

    // Auto-parse newly fetched invoices
    await autoParseInvoices();

    res.redirect(`/invoices?flash=${sanitizeFlash(`Fetched ${result.imported} new, ${result.skipped} existing, ${result.filtered || 0} filtered`)}`);
  } catch (err) {
    console.error('Fetch error:', err);
    res.redirect(`/invoices?flash=${sanitizeFlash('Fetch failed: ' + err.message)}`);
  }
});

// Get supplier defaults (GL account, VAT code)
router.get('/api/supplier-defaults/:supplierId', (req, res) => {
  const supplier = db.prepare('SELECT purchase_account, vat_code FROM suppliers WHERE id = ?').get(req.params.supplierId);
  if (!supplier) return res.json({});

  const result = {};
  if (supplier.purchase_account) {
    const gl = db.prepare('SELECT id, code, description FROM gl_accounts WHERE id = ?').get(supplier.purchase_account);
    if (gl) result.gl_account = gl.id;
  }
  if (supplier.vat_code) {
    const vat = db.prepare('SELECT id, code, description, percentage FROM vat_codes WHERE id = ? OR code = ?').get(supplier.vat_code, supplier.vat_code);
    if (vat) {
      result.vat_code = vat.id;
      result.vat_percentage = vat.percentage;
    }
  }
  res.json(result);
});

// === Booking Workflow Routes ===

// Start workflow: fetch from Gmail, auto-parse, then collect queue
router.post('/workflow/start', async (req, res) => {
  // Fetch new invoices from Gmail
  try {
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'gmail_search_query'").get();
    const query = setting?.value || 'has:attachment filename:pdf newer_than:30d';
    await gmailService.fetchInvoices(query);

    // Auto-parse unparsed invoices
    await autoParseInvoices();
  } catch (fetchErr) {
    console.error('Fetch during workflow start:', fetchErr);
  }

  const pending = db.prepare("SELECT id FROM invoices WHERE status = 'pending' ORDER BY id").all();
  if (pending.length === 0) {
    return res.redirect('/?flash=No invoices to process');
  }

  req.session.bookingWorkflow = {
    queue: pending.map(r => r.id),
    currentIndex: 0,
    results: [],
  };

  res.redirect(`/invoices/${pending[0].id}?workflow=1`);
});

// Advance to next invoice in the workflow
router.get('/workflow/next', (req, res) => {
  const wf = req.session.bookingWorkflow;
  if (!wf) return res.redirect('/invoices');

  wf.currentIndex++;
  if (wf.currentIndex >= wf.queue.length) {
    return res.redirect('/invoices/workflow/done');
  }

  res.redirect(`/invoices/${wf.queue[wf.currentIndex]}?workflow=1`);
});

// Done page: show summary and clear session
router.get('/workflow/done', (req, res) => {
  const wf = req.session.bookingWorkflow;
  if (!wf) return res.redirect('/invoices');

  const results = wf.results || [];
  const summary = {
    total: wf.queue.length,
    booked: results.filter(r => r.action === 'booked').length,
    skipped: results.filter(r => r.action === 'skipped').length,
    errors: results.filter(r => r.action === 'error').length,
  };

  // Clear the workflow from session
  const renderResults = [...results];
  delete req.session.bookingWorkflow;

  res.render('invoices/workflow-done', {
    title: 'Booking Complete',
    summary,
    results: renderResults,
    flash: null,
  });
});

// Exit workflow early: redirect to done (shows partial results)
router.get('/workflow/exit', (req, res) => {
  res.redirect('/invoices/workflow/done');
});

// Skip current invoice in workflow
router.post('/workflow/skip', (req, res) => {
  const wf = req.session.bookingWorkflow;
  if (!wf) return res.redirect('/invoices');

  const currentId = wf.queue[wf.currentIndex];
  const invoice = db.prepare('SELECT status, error_message FROM invoices WHERE id = ?').get(currentId);
  const action = invoice?.status === 'error' ? 'error' : 'skipped';
  wf.results.push({ id: currentId, action, error: invoice?.error_message || null });

  res.redirect('/invoices/workflow/next');
});

// Create new supplier in Exact Online from invoice review page
router.post('/create-supplier', async (req, res) => {
  const { supplier_name, supplier_gl_account, supplier_vat_code, supplier_vat_number, supplier_kvk, supplier_address, supplier_postcode, supplier_city, supplier_country, supplier_payment_condition, invoice_id } = req.body;
  if (!supplier_name) {
    return res.redirect(`/invoices/${invoice_id}?flash=Supplier name is required`);
  }

  try {
    const result = await exactService.createSupplier({
      name: supplier_name,
      glAccountPurchase: supplier_gl_account || undefined,
      purchaseVATCode: supplier_vat_code || undefined,
      vatNumber: supplier_vat_number || undefined,
      chamberOfCommerce: supplier_kvk || undefined,
      addressLine1: supplier_address || undefined,
      postcode: supplier_postcode || undefined,
      city: supplier_city || undefined,
      country: supplier_country || undefined,
      paymentConditionPurchase: supplier_payment_condition || undefined,
    });

    // Save to local suppliers table
    db.prepare(`
      INSERT OR REPLACE INTO suppliers (id, name, code, search_code, purchase_account, vat_code)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(result.ID, result.Name, result.Code, result.SearchCode, result.GLAccountPurchase, result.PurchaseVATCode);

    // Update the invoice with the new supplier
    db.prepare('UPDATE invoices SET supplier_id = ?, supplier_name = ? WHERE id = ?')
      .run(result.ID, result.Name, invoice_id);

    // Auto-create supplier rule from email domain
    const inv = db.prepare('SELECT email_from FROM invoices WHERE id = ?').get(invoice_id);
    if (inv && inv.email_from) {
      const addrMatch = inv.email_from.match(/<([^>]+)>/);
      const emailAddr = addrMatch ? addrMatch[1] : inv.email_from;
      const domain = emailAddr.split('@')[1];
      if (domain && !GENERIC_EMAIL_DOMAINS.has(domain.toLowerCase())) {
        const emailPattern = domain.replace(/\./g, '\\.');
        const existing = db.prepare('SELECT id FROM supplier_rules WHERE email_pattern = ?').get(emailPattern);
        if (!existing) {
          db.prepare('INSERT INTO supplier_rules (name, email_pattern, supplier_id) VALUES (?, ?, ?)')
            .run(result.Name, emailPattern, result.ID);
        }
      }
    }

    res.redirect(`/invoices/${invoice_id}?flash=Supplier "${result.Name}" created in Exact Online (${result.Code || 'no code'})`);
  } catch (err) {
    console.error('Create supplier error:', err);
    res.redirect(`/invoices/${invoice_id}?flash=${sanitizeFlash('Failed to create supplier: ' + err.message)}`);
  }
});

// Bulk delete
router.post('/bulk/delete', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids].filter(Boolean);
  if (ids.length === 0) return res.redirect('/invoices?flash=No invoices selected');
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM invoices WHERE id IN (${placeholders})`).run(...ids);
  res.redirect(`/invoices?flash=Deleted ${ids.length} invoice(s)`);
});

// Bulk reset to pending
router.post('/bulk/reset', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids].filter(Boolean);
  if (ids.length === 0) return res.redirect('/invoices?flash=No invoices selected');
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE invoices SET status = 'pending', error_message = NULL WHERE id IN (${placeholders})`).run(...ids);
  res.redirect(`/invoices?flash=Reset ${ids.length} invoice(s) to pending`);
});

// Review invoice
router.get('/:id', (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).send('Invoice not found');

  // Parse line_items JSON
  invoice.line_items = invoice.line_items ? JSON.parse(invoice.line_items) : [];

  const suppliers = db.prepare('SELECT * FROM suppliers ORDER BY name').all();
  const glAccounts = db.prepare('SELECT * FROM gl_accounts ORDER BY code').all();
  const vatCodes = db.prepare('SELECT * FROM vat_codes ORDER BY code').all();
  const journals = db.prepare('SELECT id, code, description FROM journals ORDER BY code').all();

  // Check if a supplier rule matches this invoice's email
  const matchedRule = invoiceParser.findRule(invoice.email_from);

  // Build workflow info if in workflow mode
  let workflowInfo = null;
  const wf = req.session.bookingWorkflow;
  if (req.query.workflow && wf) {
    workflowInfo = {
      current: wf.currentIndex + 1,
      total: wf.queue.length,
      results: wf.results || [],
    };
  }

  // Check for auto-learn suggestions from session (shown once after save)
  let learnSuggestions = null;
  if (req.session.learnSuggestions && req.session.learnSuggestions.invoiceId === invoice.id) {
    learnSuggestions = req.session.learnSuggestions;
    delete req.session.learnSuggestions;
  }

  // Duplicate warning from a blocked booking attempt (shown once)
  let duplicateWarning = null;
  if (req.session.duplicateWarning && req.session.duplicateWarning.invoiceId === invoice.id) {
    duplicateWarning = req.session.duplicateWarning;
    delete req.session.duplicateWarning;
  } else if (req.session.duplicateWarning) {
    // Warning was for a different invoice — drop it so it can't leak onto this page
    delete req.session.duplicateWarning;
  }

  res.render('invoices/review', {
    title: `Review Invoice #${invoice.id}`,
    invoice,
    suppliers,
    glAccounts,
    vatCodes,
    journals,
    matchedRule,
    workflowInfo,
    learnSuggestions,
    duplicateWarning,
    flash: req.query.flash,
  });
});

// Apply auto-learned regex suggestions to a supplier rule
router.post('/:id/apply-suggestions', (req, res) => {
  const ruleId = req.body.rule_id;
  const suggestionsJson = req.body.suggestions;
  if (!ruleId || !suggestionsJson) {
    return res.redirect(`/invoices/${req.params.id}?flash=Missing suggestion data`);
  }

  const rule = db.prepare('SELECT * FROM supplier_rules WHERE id = ?').get(ruleId);
  if (!rule) {
    return res.redirect(`/invoices/${req.params.id}?flash=Rule not found`);
  }

  let suggestions;
  try {
    suggestions = JSON.parse(suggestionsJson);
  } catch (e) {
    return res.redirect(`/invoices/${req.params.id}?flash=Invalid suggestion data`);
  }

  const allowedFields = ['invoice_number_regex', 'date_regex', 'date_format', 'due_date_regex', 'due_date_format', 'total_regex', 'subtotal_regex', 'vat_regex'];
  const updates = {};

  for (const [field, suggestion] of Object.entries(suggestions)) {
    if (allowedFields.includes(field) && suggestion.regex) {
      updates[field] = suggestion.regex;
      if (suggestion.date_format && suggestion.format_field && allowedFields.includes(suggestion.format_field)) {
        updates[suggestion.format_field] = suggestion.date_format;
      }
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.redirect(`/invoices/${req.params.id}?flash=No valid suggestions to apply`);
  }

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);
  values.push(ruleId);
  db.prepare(`UPDATE supplier_rules SET ${setClauses} WHERE id = ?`).run(...values);

  res.redirect(`/invoices/${req.params.id}?flash=Rule updated with ${Object.keys(updates).length} learned pattern(s)`);
});

// Save invoice
router.post('/:id', (req, res) => {
  const { supplier_name, supplier_id, invoice_number, invoice_date, due_date, currency, subtotal, vat_amount, total_amount, description, your_ref, payment_condition, journal } = req.body;

  // Build line items from form arrays
  const lineItems = [];
  if (req.body['line_description']) {
    const descriptions = Array.isArray(req.body['line_description']) ? req.body['line_description'] : [req.body['line_description']];
    const amounts = Array.isArray(req.body['line_amount']) ? req.body['line_amount'] : [req.body['line_amount']];
    const glAccounts = Array.isArray(req.body['line_gl_account']) ? req.body['line_gl_account'] : [req.body['line_gl_account']];
    const vatCodes = Array.isArray(req.body['line_vat_code']) ? req.body['line_vat_code'] : [req.body['line_vat_code']];

    for (let i = 0; i < descriptions.length; i++) {
      if (descriptions[i] || amounts[i]) {
        lineItems.push({
          description: descriptions[i] || '',
          amount: parseFloat(amounts[i]) || 0,
          gl_account: glAccounts[i] || '',
          vat_code: vatCodes[i] || '',
        });
      }
    }
  }

  db.prepare(`
    UPDATE invoices SET
      supplier_name = ?, supplier_id = ?, invoice_number = ?, invoice_date = ?,
      due_date = ?, currency = ?, subtotal = ?, vat_amount = ?,
      total_amount = ?, line_items = ?, description = ?, your_ref = ?,
      payment_condition = ?, journal = ?, status = 'pending', updated_at = datetime('now')
    WHERE id = ?
  `).run(
    supplier_name, supplier_id, invoice_number, invoice_date,
    due_date, currency, parseFloat(subtotal) || 0, parseFloat(vat_amount) || 0,
    parseFloat(total_amount) || 0, JSON.stringify(lineItems), description, your_ref,
    payment_condition, journal || null, req.params.id
  );

  // Auto-learn: create supplier rule if supplier was manually set and no rule exists
  const inv = db.prepare('SELECT raw_text, email_from FROM invoices WHERE id = ?').get(req.params.id);
  if (inv && supplier_id && inv.email_from) {
    const matchedRule = invoiceParser.findRule(inv.email_from);
    if (!matchedRule) {
      // Extract domain from email for the pattern
      const addrMatch = inv.email_from.match(/<([^>]+)>/);
      const emailAddr = addrMatch ? addrMatch[1] : inv.email_from;
      const domain = emailAddr.split('@')[1];
      if (domain && !GENERIC_EMAIL_DOMAINS.has(domain.toLowerCase())) {
        const emailPattern = domain.replace(/\./g, '\\.');
        const result = db.prepare(`
          INSERT INTO supplier_rules (name, email_pattern, supplier_id)
          VALUES (?, ?, ?)
        `).run(supplier_name || domain, emailPattern, supplier_id);

        // Auto-apply learned patterns to the new rule immediately
        const savedValues = { invoice_number, invoice_date, due_date, subtotal, vat_amount, total_amount };
        if (inv.raw_text && result.lastInsertRowid) {
          const newRule = db.prepare('SELECT * FROM supplier_rules WHERE id = ?').get(result.lastInsertRowid);
          const autoSuggestions = invoiceParser.generateSuggestions(inv.raw_text, savedValues, newRule);
          if (autoSuggestions) {
            const allowedFields = ['invoice_number_regex', 'date_regex', 'date_format', 'due_date_regex', 'due_date_format', 'total_regex', 'subtotal_regex', 'vat_regex'];
            const ruleUpdates = {};
            for (const [field, s] of Object.entries(autoSuggestions)) {
              if (allowedFields.includes(field)) {
                ruleUpdates[field] = s.regex;
                if (s.date_format && s.format_field) ruleUpdates[s.format_field] = s.date_format;
              }
            }
            if (Object.keys(ruleUpdates).length > 0) {
              const setClauses = Object.keys(ruleUpdates).map(k => `${k} = ?`).join(', ');
              db.prepare(`UPDATE supplier_rules SET ${setClauses} WHERE id = ?`).run(...Object.values(ruleUpdates), result.lastInsertRowid);
            }
          }
        }
      }
    } else if (matchedRule && !matchedRule.supplier_id && supplier_id) {
      // Rule exists but has no supplier_id — update it
      db.prepare('UPDATE supplier_rules SET supplier_id = ? WHERE id = ?').run(supplier_id, matchedRule.id);
    }
  }

  // Auto-learn: generate regex suggestions from corrected values
  if (inv && inv.raw_text) {
    const matchedRule = invoiceParser.findRule(inv.email_from);
    const savedValues = { invoice_number, invoice_date, due_date, subtotal, vat_amount, total_amount };
    const suggestions = invoiceParser.generateSuggestions(inv.raw_text, savedValues, matchedRule);
    if (suggestions) {
      req.session.learnSuggestions = {
        invoiceId: parseInt(req.params.id),
        ruleId: matchedRule ? matchedRule.id : null,
        emailFrom: inv.email_from,
        supplierName: supplier_name,
        supplierId: supplier_id,
        suggestions,
      };
    }
  }

  res.redirect(`/invoices/${req.params.id}?flash=Invoice saved`);
});

// Book to Exact Online
router.post('/:id/book', async (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).send('Invoice not found');

  try {
    // Check for duplicate in Exact Online (skip if user confirmed with force)
    if (!req.body.force) {
      const invoiceNum = req.body.invoice_number || invoice.invoice_number;
      const supplierId = req.body.supplier_id || invoice.supplier_id;
      const supplierName = req.body.supplier_name || invoice.supplier_name;

      // Local check first (no API call): same supplier + invoice number already
      // known to this tool. Catches reminders that re-attach an already-booked invoice.
      if (invoiceNum) {
        const localDup = duplicateCheck.findDuplicate({
          id: invoice.id, invoice_number: invoiceNum, supplier_id: supplierId, supplier_name: supplierName,
        });
        if (localDup) {
          req.session.duplicateWarning = {
            invoiceId: invoice.id,
            existingId: localDup.id,
            existingStatus: localDup.status,
            existingEntry: localDup.exactonline_entry_id || null,
            existingAmount: localDup.total_amount != null ? localDup.total_amount : null,
            existingCurrency: localDup.currency || 'EUR',
            existingDate: localDup.invoice_date || null,
            invoiceNumber: invoiceNum,
            supplierName: localDup.supplier_name || supplierName || '',
          };
          const wf = req.session.bookingWorkflow;
          const wfParam = wf && wf.queue.includes(invoice.id) ? '?workflow=1' : '';
          return res.redirect(`/invoices/${invoice.id}${wfParam}`);
        }
      }

      if (invoiceNum) {
        const duplicates = await exactService.checkDuplicateEntry(supplierId, invoiceNum);
        if (duplicates) {
          const entries = duplicates.map(d => d.EntryNumber).join(', ');
          const wf = req.session.bookingWorkflow;
          const wfParam = wf && wf.queue.includes(invoice.id) ? '&workflow=1' : '';
          return res.redirect(`/invoices/${invoice.id}?flash=${sanitizeFlash(`Duplicate found: invoice "${invoiceNum}" already exists in Exact as entry ${entries}. Save and use Book (Force) to book anyway.`)}${wfParam}`);
        }
      }
    }

    invoice.line_items = invoice.line_items ? JSON.parse(invoice.line_items) : [];
    const result = await exactService.createPurchaseEntry(invoice);

    const entryNumber = result.EntryNumber || result.EntryID;
    db.prepare(`
      UPDATE invoices SET status = 'booked', exactonline_entry_id = ?, error_message = NULL,
        booked_at = datetime('now'), booked_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(String(entryNumber), req.session.user?.email || 'unknown', invoice.id);

    // Re-label the Gmail message: move it out of the queue label into the processed label
    if (invoice.gmail_message_id) {
      const addLabel = db.prepare("SELECT value FROM settings WHERE key = 'gmail_label_processed'").get();
      const removeLabel = db.prepare("SELECT value FROM settings WHERE key = 'gmail_label_queue'").get();
      const addName = addLabel?.value && addLabel.value.trim();
      const removeName = removeLabel?.value && removeLabel.value.trim();
      if (addName || removeName) {
        try {
          await gmailService.relabelMessage(invoice.gmail_message_id, addName || null, removeName || null);
        } catch (labelErr) {
          console.error('Gmail relabel failed:', labelErr.message);
        }
      }
    }

    // If in workflow, record result and advance
    const wf = req.session.bookingWorkflow;
    if (wf && wf.queue.includes(invoice.id)) {
      wf.results.push({ id: invoice.id, action: 'booked', entryId: entryNumber });
      return res.redirect('/invoices/workflow/next');
    }

    res.redirect(`/invoices/${invoice.id}?flash=Booked successfully (${entryNumber})`);
  } catch (err) {
    const notifications = require('../services/notifications');
    await notifications.notifyError(invoice, err.message);

    console.error('Booking error:', err);
    db.prepare(`
      UPDATE invoices SET status = 'error', error_message = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(err.message, invoice.id);

    // If in workflow, stay on the invoice so user can see the error and skip
    const wf = req.session.bookingWorkflow;
    if (wf && wf.queue.includes(invoice.id)) {
      return res.redirect(`/invoices/${invoice.id}?workflow=1&flash=${sanitizeFlash('Booking failed: ' + err.message)}`);
    }

    res.redirect(`/invoices/${invoice.id}?flash=${sanitizeFlash('Booking failed: ' + err.message)}`);
  }
});

// Re-parse invoice
router.post('/:id/reparse', async (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).send('Invoice not found');

  try {
    const text = await extractTextFromFile(resolvePdfPath(invoice.pdf_path));
    const parsed = invoiceParser.parseInvoice(text, invoice.email_from);

    db.prepare(`
      UPDATE invoices SET
        raw_text = ?,
        supplier_name = COALESCE(?, supplier_name),
        supplier_id = COALESCE(?, supplier_id),
        invoice_number = COALESCE(?, invoice_number),
        invoice_date = COALESCE(?, invoice_date),
        due_date = COALESCE(?, due_date),
        subtotal = COALESCE(?, subtotal),
        vat_amount = COALESCE(?, vat_amount),
        total_amount = COALESCE(?, total_amount),
        line_items = ?,
        currency = COALESCE(?, currency),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      text, parsed.supplier_name, parsed.supplier_id, parsed.invoice_number, parsed.invoice_date,
      parsed.due_date, parsed.subtotal, parsed.vat_amount, parsed.total_amount,
      JSON.stringify(parsed.line_items), parsed.currency, invoice.id
    );

    res.redirect(`/invoices/${invoice.id}?flash=Re-parsed successfully`);
  } catch (err) {
    res.redirect(`/invoices/${invoice.id}?flash=${sanitizeFlash('Parse failed: ' + err.message)}`);
  }
});

// Delete invoice
router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);
  res.redirect('/invoices?flash=Invoice deleted');
});

// Serve PDF files (converts Excel to PDF on the fly if needed)
router.get('/:id/pdf', async (req, res) => {
  const invoice = db.prepare('SELECT pdf_path FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice || !invoice.pdf_path) return res.status(404).send('PDF not found');

  let resolved = resolvePdfPath(invoice.pdf_path);
  if (!resolved.startsWith(PDFS_DIR + path.sep)) {
    return res.status(403).send('Access denied');
  }

  // For Excel files, serve the converted PDF version
  if (isExcelFile(resolved)) {
    try {
      resolved = await pdfParser.convertToPdf(resolved);
    } catch (err) {
      return res.status(500).send('PDF conversion failed');
    }
  }

  res.sendFile(resolved);
});

module.exports = router;
