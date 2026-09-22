const db = require('../db/database');

/**
 * Detect recurring invoices (same supplier, regular intervals, 3+ occurrences)
 * and flag suppliers whose expected invoice is overdue.
 */
function detectOverdue() {
  const recurring = db.prepare(`
    SELECT supplier_name, supplier_id, currency,
      COUNT(*) as count,
      ROUND(AVG(total_amount), 2) as avg_amount,
      MAX(invoice_date) as last_date,
      ROUND(
        (julianday(MAX(invoice_date)) - julianday(MIN(invoice_date))) / (COUNT(*) - 1)
      ) as avg_interval_days
    FROM invoices
    WHERE status = 'booked' AND supplier_name IS NOT NULL AND invoice_date IS NOT NULL
    AND invoice_date >= date('now', '-365 days')
    GROUP BY supplier_name
    HAVING count >= 3
    AND avg_interval_days BETWEEN 20 AND 100
    ORDER BY last_date
  `).all();

  return recurring.filter(r => {
    const daysSinceLast = (Date.now() - new Date(r.last_date).getTime()) / 86400000;
    return daysSinceLast > r.avg_interval_days * 1.5;
  }).map(r => ({
    ...r,
    days_overdue: Math.round(
      (Date.now() - new Date(r.last_date).getTime()) / 86400000 - r.avg_interval_days
    ),
  }));
}

module.exports = { detectOverdue };
