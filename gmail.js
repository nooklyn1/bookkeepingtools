const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const gmailAuth = require('../auth/gmail-auth');
const db = require('../db/database');
const { convertToPdf, isExcelFile } = require('./pdf-parser');

const ATTACHMENTS_DIR = path.join(__dirname, '../../data/pdfs');

const SUPPORTED_EXTENSIONS = ['.pdf', '.xls', '.xlsx'];

// Filename patterns that indicate non-invoice documents
const SKIP_FILENAME_PATTERNS = [
  /bestelbevestiging/i,
  /orderbevestiging/i,
  /order.?confirmation/i,
  /afleverbewijs/i,
  /verzendbevestiging/i,
  /bewijs.van.betaling/i,
  /algemene.voorwaarden/i,
  /verwerkersovereenkomst/i,
  /aanmaning/i,
  /herinnering/i,
  /wichtige.hinweise/i,
  /^receipt[_-]/i,
  /SalesOrd/i,
  /Sales.Order/i,
  /^POA[_.\s-]/i,
  /power.of.attorney/i,
  /^KVK\s/i,
];

// Subject patterns that indicate non-invoice emails
// NOTE: Keep this list minimal - real invoices can be attached to emails
// with surprising subjects (e.g. invoices attached to reminder emails).
// Prefer filename-based filtering which is more reliable.
const SKIP_SUBJECT_PATTERNS = [
  /^power of attorney$/i,
];

function shouldSkipAttachment(filename, subject, emailFrom) {
  // Skip non-invoice filenames
  for (const pattern of SKIP_FILENAME_PATTERNS) {
    if (pattern.test(filename)) {
      return 'filename:' + pattern.source;
    }
  }

  // Skip non-invoice subjects (only if ALL attachments from this email match)
  for (const pattern of SKIP_SUBJECT_PATTERNS) {
    if (subject && pattern.test(subject)) {
      return 'subject:' + pattern.source;
    }
  }

  // Skip attachments from own domain if it's a thread reply (Re:/Fwd:)
  // Standalone emails from own domain are kept (could be forwarded invoices)
  const ownDomain = db.prepare("SELECT value FROM settings WHERE key = 'own_email_domain'").get()?.value;
  if (ownDomain && emailFrom) {
    const senderAddr = (emailFrom.match(/<([^>]+)>/) || [])[1] || emailFrom;
    if (senderAddr.toLowerCase().endsWith('@' + ownDomain.toLowerCase())) {
      const isThread = /^(Re|Fwd|FW|AW|回复|转发)\s*:/i.test((subject || '').trim());
      if (isThread) {
        return 'own-domain-thread-reply';
      }
    }
  }

  return null;
}

async function fetchInvoices(searchQuery) {
  const auth = gmailAuth.getClient();
  if (!auth) throw new Error('Gmail not connected');

  const gmail = google.gmail({ version: 'v1', auth });
  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

  // Search for messages (paginate up to 200)
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
  let imported = 0;
  let skipped = 0;
  let filtered = 0;

  for (const msg of messages) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full',
    });

    const headers = full.data.payload.headers;
    const from = headers.find(h => h.name === 'From')?.value || '';
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const rawDate = headers.find(h => h.name === 'Date')?.value || '';
    const date = rawDate ? new Date(rawDate).toISOString() : '';

    // Find invoice attachments (PDF, XLS, XLSX)
    const pdfParts = findAttachmentParts(full.data.payload);

    for (const part of pdfParts) {
      const filename = part.filename || `${msg.id}.pdf`;

      // Skip if this specific attachment was already imported
      const existing = db.prepare('SELECT id FROM invoices WHERE gmail_message_id = ? AND pdf_filename = ?').get(msg.id, filename);
      if (existing) {
        skipped++;
        continue;
      }

      // Skip if the same filename+size already exists from another message in the same thread
      // (email threads carry the same attachment on every reply)
      const attachmentSize = part.body.size || 0;
      const threadDupe = db.prepare(
        'SELECT id FROM invoices WHERE pdf_filename = ? AND attachment_size = ? AND gmail_message_id != ?'
      ).get(filename, attachmentSize, msg.id);
      if (threadDupe) {
        skipped++;
        continue;
      }

      // Skip non-invoice attachments
      const skipReason = shouldSkipAttachment(filename, subject, from);
      if (skipReason) {
        filtered++;
        continue;
      }

      const attachment = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: msg.id,
        id: part.body.attachmentId,
      });

      const buffer = Buffer.from(attachment.data.data, 'base64');
      const safeFilename = filename.replace(/[/\\]/g, '_');
      const filepath = path.join(ATTACHMENTS_DIR, `${msg.id}_${safeFilename}`);
      fs.writeFileSync(filepath, buffer);

      // Convert Excel files to PDF for viewing
      if (isExcelFile(filename)) {
        try { await convertToPdf(filepath); } catch (err) {
          console.error('Excel to PDF conversion failed:', err.message);
        }
      }

      db.prepare(`
        INSERT INTO invoices (gmail_message_id, email_from, email_subject, email_date, pdf_filename, pdf_path, attachment_size, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
      `).run(msg.id, from, subject, date, filename, filepath, attachmentSize);

      imported++;
    }
  }

  return { imported, skipped, filtered, total: messages.length };
}

function findAttachmentParts(payload) {
  const parts = [];

  function walk(node) {
    if (node.filename && node.body?.attachmentId) {
      const ext = path.extname(node.filename).toLowerCase();
      if (SUPPORTED_EXTENSIONS.includes(ext)) {
        parts.push(node);
      }
    }
    if (node.parts) {
      node.parts.forEach(walk);
    }
  }

  walk(payload);
  return parts;
}

async function relabelMessage(messageId, addLabelName, removeLabelName) {
  const auth = gmailAuth.getClient();
  if (!auth) throw new Error('Gmail not connected');

  const gmail = google.gmail({ version: 'v1', auth });

  // Gmail API uses label IDs, not names - look up IDs
  const labelsRes = await gmail.users.labels.list({ userId: 'me' });
  const labels = labelsRes.data.labels || [];

  const addLabelIds = [];
  const removeLabelIds = [];

  if (addLabelName) {
    const label = labels.find(l => l.name === addLabelName);
    if (label) addLabelIds.push(label.id);
    else console.warn(`Gmail label not found: "${addLabelName}"`);
  }

  if (removeLabelName) {
    const label = labels.find(l => l.name === removeLabelName);
    if (label) removeLabelIds.push(label.id);
    else console.warn(`Gmail label not found: "${removeLabelName}"`);
  }

  if (addLabelIds.length === 0 && removeLabelIds.length === 0) return;

  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      addLabelIds,
      removeLabelIds,
    },
  });
}

// Canonical defaults, mirrored by the migration in db/database.js. Used as a
// fallback if the setting row is somehow missing so the tool still functions.
const DEFAULT_LABEL_QUEUE = '4.Inkopen/4.1 Inkoopfacturen';

function getQueueLabelName() {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'gmail_label_queue'").get();
  const name = setting?.value && setting.value.trim();
  return name || DEFAULT_LABEL_QUEUE;
}

const INVOICE_SUBJECT_KEYWORDS = [
  'factuur', 'invoice', 'creditnota', 'credit note', 'creditfactuur',
  'rekening', 'rechnung', 'factura', 'billing statement',
];

const SKIP_SUBJECT_KEYWORDS_SCAN = [
  'herinnering', 'reminder', 'aanmaning', 'betaalverzoek', 'payment reminder',
  'betalingsherinnering', 'mahnung', 'incasso',
];

async function scanForInvoices() {
  const auth = gmailAuth.getClient();
  if (!auth) throw new Error('Gmail not connected');

  const gmail = google.gmail({ version: 'v1', auth });

  // Get supplier email patterns active in the last 90 days
  const recentSuppliers = db.prepare(`
    SELECT DISTINCT sr.email_pattern FROM supplier_rules sr
    WHERE EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.email_date > datetime('now', '-90 days')
      AND i.email_from LIKE '%' || REPLACE(sr.email_pattern, '\\.', '.') || '%'
    )
  `).all();

  // Convert regex patterns to domains and full-email addresses
  const domains = [];
  const fullEmails = [];
  for (const row of recentSuppliers) {
    const cleaned = row.email_pattern.replace(/\\\./g, '.');
    if (cleaned.includes('@')) {
      // Full email address like awabongers@msn.com
      fullEmails.push(cleaned);
    } else if (/^[\w.-]+$/.test(cleaned)) {
      // Skip generic domains that would match too broadly
      if (['gmail.com', 'outlook.com', 'hotmail.com', 'live.nl', 'msn.com'].includes(cleaned)) continue;
      domains.push(cleaned);
    }
  }

  if (domains.length === 0 && fullEmails.length === 0) {
    return { labeled: 0, scanned: 0, domains: 0 };
  }

  // Look up the configured queue label and all its sublabels
  const queueLabelName = getQueueLabelName();
  const labelsRes = await gmail.users.labels.list({ userId: 'me' });
  const labels = labelsRes.data.labels || [];
  const targetLabel = labels.find(l => l.name === queueLabelName);
  if (!targetLabel) {
    throw new Error(`Gmail label "${queueLabelName}" not found. Check the "Gmail queue label" value on the Settings page.`);
  }

  // Collect IDs of the target label and all its sublabels (Gedownload, Reminder, etc.)
  const inkoopLabelIds = new Set(
    labels
      .filter(l => l.name.startsWith(queueLabelName))
      .map(l => l.id)
  );

  // Build from clause: domains as @domain, full emails as-is
  const fromParts = [
    ...domains.map(d => '@' + d),
    ...fullEmails,
  ];
  const fromClause = fromParts.join(' OR ');

  // Search: from known suppliers, has attachment, recent
  const query = `from:(${fromClause}) has:attachment newer_than:14d`;

  // Paginate through all results (up to 200 messages)
  const messages = [];
  let pageToken = undefined;
  while (messages.length < 200) {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 100,
      pageToken,
    });
    const batch = listRes.data.messages || [];
    messages.push(...batch);
    pageToken = listRes.data.nextPageToken;
    if (!pageToken || batch.length === 0) break;
  }
  let labeled = 0;
  let alreadyLabeled = 0;

  // Build set of gmail message IDs already imported into the tool
  const importedMessageIds = new Set(
    db.prepare('SELECT DISTINCT gmail_message_id FROM invoices').all().map(r => r.gmail_message_id)
  );

  for (const msg of messages) {
    // Skip messages already imported into the bookkeeping tool
    if (importedMessageIds.has(msg.id)) {
      alreadyLabeled++;
      continue;
    }

    const full = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From'],
    });

    // Skip messages that already have any 4.1 Inkoopfacturen label (or sublabel)
    const msgLabelIds = full.data.labelIds || [];
    if (msgLabelIds.some(id => inkoopLabelIds.has(id))) {
      alreadyLabeled++;
      continue;
    }

    const headers = full.data.payload.headers;
    const subject = (headers.find(h => h.name === 'Subject')?.value || '').toLowerCase();

    // Skip payment reminders
    const isReminder = SKIP_SUBJECT_KEYWORDS_SCAN.some(kw => subject.includes(kw));
    if (isReminder) continue;

    // Check if subject contains invoice keywords
    const isInvoice = INVOICE_SUBJECT_KEYWORDS.some(kw => subject.includes(kw));
    if (!isInvoice) continue;

    // Apply the label
    await gmail.users.messages.modify({
      userId: 'me',
      id: msg.id,
      requestBody: {
        addLabelIds: [targetLabel.id],
      },
    });
    labeled++;
  }

  return { labeled, scanned: messages.length, alreadyLabeled, domains: domains.length + fullEmails.length };
}

async function autoFetch() {
  const auth = gmailAuth.getClient();
  if (!auth) return;

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

module.exports = { fetchInvoices, shouldSkipAttachment, relabelMessage, scanForInvoices, autoFetch };
