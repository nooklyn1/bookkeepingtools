const express = require('express');
const router = express.Router();
const gmailAuth = require('../auth/gmail-auth');
const exactAuth = require('../auth/exactonline-auth');
const db = require('../db/database');
const recurringDetector = require('../services/recurring-detector');
const duplicateCheck = require('../services/duplicate-check');

router.get('/', (req, res) => {
  const invoiceCounts = db.prepare(`
    SELECT status, COUNT(*) as count FROM invoices GROUP BY status
  `).all();

  const counts = { pending: 0, booked: 0, error: 0, total: 0 };
  for (const row of invoiceCounts) {
    counts[row.status] = row.count;
    counts.total += row.count;
  }

  const recentBookings = db.prepare(`
    SELECT id, supplier_name, invoice_number, total_amount, currency, booked_at, booked_by
    FROM invoices WHERE status = 'booked'
    ORDER BY COALESCE(booked_at, updated_at) DESC LIMIT 5
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

  let overdueRecurring = [];
  try { overdueRecurring = recurringDetector.detectOverdue(); } catch (e) { /* ignore */ }

  let duplicatePending = [];
  try { duplicatePending = duplicateCheck.pendingDuplicatesOfBooked(); } catch (e) { /* ignore */ }

  res.render('index', {
    title: 'Dashboard',
    activePage: 'dashboard',
    gmailConnected: gmailAuth.isConnected(),
    exactConnected: exactAuth.isConnected(),
    exactDivision: exactAuth.getDivision(),
    counts,
    recentBookings,
    periodTotals,
    topSuppliers,
    overdueRecurring,
    duplicatePending,
    flash: req.query.flash,
  });
});

module.exports = router;
