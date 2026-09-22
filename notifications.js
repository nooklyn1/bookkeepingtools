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
