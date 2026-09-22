/**
 * Local (SQLite) invoice-number duplicate detection.
 *
 * Payment reminders from suppliers often re-attach the original invoice PDF —
 * sometimes in a new thread, sometimes with a slightly different filename — which
 * the filename+size thread dedupe in gmail.js can't catch. This module matches on
 * supplier + invoice number instead, so the same invoice is caught even when it
 * arrives as a fresh attachment.
 *
 * Two invoices are considered the same invoice when their invoice_number matches
 * (case-insensitive, trimmed) AND they share a supplier — either the same
 * supplier_id, or (when ids are absent) the same supplier_name.
 */

const db = require('../db/database');

// Statuses that represent a "live" invoice (not deleted). There is no rejected
// status in this app, so any surviving row counts.
const LIVE_STATUSES = ['booked', 'pending', 'error'];

// Shared SQL fragment: does candidate row `o` refer to the same invoice as `p`?
// Both sides must have a non-empty invoice number — two invoices that both failed
// extraction (NULL/empty number) must never match each other.
const SAME_INVOICE = `
  o.id != p.id
  AND o.invoice_number IS NOT NULL AND TRIM(o.invoice_number) != ''
  AND LOWER(TRIM(o.invoice_number)) = LOWER(TRIM(p.invoice_number))
  AND (
    (p.supplier_id IS NOT NULL AND TRIM(p.supplier_id) != '' AND o.supplier_id = p.supplier_id)
    OR (o.supplier_name IS NOT NULL AND p.supplier_name IS NOT NULL
        AND LOWER(TRIM(o.supplier_name)) = LOWER(TRIM(p.supplier_name)))
  )
`;

/**
 * For the booking flow: find an existing invoice that duplicates the given one.
 * Prefers an already-booked match (the definitive double-booking case), then a
 * pending/error sibling. Returns the row or null.
 *
 * @param {{id?: number, invoice_number: string, supplier_id?: string, supplier_name?: string}} invoice
 */
function findDuplicate(invoice) {
  const invoiceNumber = invoice.invoice_number;
  // Never block when this invoice has no usable number (e.g. failed extraction).
  if (!invoiceNumber || !String(invoiceNumber).trim()) return null;

  return db.prepare(`
    SELECT o.id, o.status, o.supplier_name, o.invoice_number, o.total_amount, o.currency,
           o.invoice_date, o.exactonline_entry_id, o.booked_at
    FROM invoices o, (SELECT @id AS id, @invoice_number AS invoice_number,
                             @supplier_id AS supplier_id, @supplier_name AS supplier_name) p
    WHERE ${SAME_INVOICE}
      AND o.status IN ('booked', 'pending', 'error')
    ORDER BY CASE o.status WHEN 'booked' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, o.id
    LIMIT 1
  `).get({
    id: invoice.id != null ? invoice.id : -1,
    invoice_number: String(invoiceNumber),
    supplier_id: invoice.supplier_id || null,
    supplier_name: invoice.supplier_name || null,
  });
}

/**
 * For the dashboard: pending invoices that duplicate an already-booked invoice.
 * These are the high-confidence "about to be booked twice" cases, surfaced before
 * anyone opens them for review.
 */
function pendingDuplicatesOfBooked() {
  return db.prepare(`
    SELECT p.id, p.supplier_name, p.invoice_number,
           MIN(o.id) AS existing_id,
           MAX(o.exactonline_entry_id) AS existing_entry
    FROM invoices p
    JOIN invoices o ON ${SAME_INVOICE} AND o.status = 'booked'
    WHERE p.status = 'pending'
      AND p.invoice_number IS NOT NULL AND TRIM(p.invoice_number) != ''
    GROUP BY p.id
    ORDER BY p.email_date DESC
  `).all();
}

/**
 * For the invoice list: set of pending invoice ids that have any live duplicate
 * sibling (booked, pending, or error), so rows can be badged.
 * @param {number[]} [ids] Optional restriction to the currently displayed ids.
 * @returns {Set<number>}
 */
function flaggedPendingIds(ids) {
  let restrict = '';
  let params = [];
  if (Array.isArray(ids) && ids.length > 0) {
    restrict = ` AND p.id IN (${ids.map(() => '?').join(',')})`;
    params = ids;
  }
  const rows = db.prepare(`
    SELECT DISTINCT p.id
    FROM invoices p
    JOIN invoices o ON ${SAME_INVOICE} AND o.status IN ('booked', 'pending', 'error')
    WHERE p.status = 'pending'
      AND p.invoice_number IS NOT NULL AND TRIM(p.invoice_number) != ''${restrict}
  `).all(...params);
  return new Set(rows.map(r => r.id));
}

module.exports = { findDuplicate, pendingDuplicatesOfBooked, flaggedPendingIds, LIVE_STATUSES };
