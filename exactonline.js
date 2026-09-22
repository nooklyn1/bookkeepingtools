const fs = require('fs');
const path = require('path');
const config = require('../config');
const exactAuth = require('../auth/exactonline-auth');
const { resolvePdfPath, isExcelFile, convertToPdf } = require('./pdf-parser');

async function apiGet(endpoint, params = {}) {
  const token = await exactAuth.getAccessToken();
  const division = exactAuth.getDivision();
  if (!division) throw new Error('No Exact Online division configured');

  const url = new URL(`${config.exact.baseUrl}/api/v1/${division}/${endpoint}`);
  for (const [key, val] of Object.entries(params)) {
    url.searchParams.set(key, val);
  }

  let allResults = [];
  let nextUrl = url.toString();

  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Exact API GET ${endpoint}: ${res.status} ${text}`);
    }

    const data = await res.json();
    const results = data.d.results || (Array.isArray(data.d) ? data.d : [data.d]);
    allResults = allResults.concat(results);

    // Follow pagination link if present
    nextUrl = data.d.__next || null;
  }

  return allResults;
}

async function apiPost(endpoint, body) {
  const token = await exactAuth.getAccessToken();
  const division = exactAuth.getDivision();
  if (!division) throw new Error('No Exact Online division configured');

  const url = `${config.exact.baseUrl}/api/v1/${division}/${endpoint}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Exact API POST ${endpoint}: ${res.status} ${text}`);
  }

  return res.json();
}

async function getSuppliers() {
  return apiGet('crm/Accounts', {
    $filter: 'IsSupplier eq true',
    $select: 'ID,Name,Code,SearchCode,GLAccountPurchase,PurchaseVATCode',
    $top: '1000',
  });
}

async function getGLAccounts() {
  return apiGet('financial/GLAccounts', {
    $select: 'ID,Code,Description,Type',
    $top: '1000',
  });
}

async function getVATCodes() {
  return apiGet('vat/VATCodes', {
    $select: 'ID,Code,Description,Percentage',
    $top: '500',
  });
}

async function getJournals() {
  return apiGet('financial/Journals', {
    $filter: 'Type eq 22',
    $select: 'ID,Code,Description,Type',
  });
}

async function createSupplier({ name, code, glAccountPurchase, purchaseVATCode, vatNumber, chamberOfCommerce, addressLine1, postcode, city, country, paymentConditionPurchase }) {
  const body = {
    Name: name,
    IsSupplier: true,
    Status: 'C', // Active customer/supplier
  };
  if (code) body.Code = code;
  if (glAccountPurchase) body.GLAccountPurchase = glAccountPurchase;
  if (purchaseVATCode) body.PurchaseVATCode = purchaseVATCode;
  if (vatNumber) body.VATNumber = vatNumber;
  if (chamberOfCommerce) body.ChamberOfCommerce = chamberOfCommerce;
  if (addressLine1) body.AddressLine1 = addressLine1;
  if (postcode) body.Postcode = postcode;
  if (city) body.City = city;
  if (country) body.Country = country;
  if (paymentConditionPurchase) body.PaymentConditionPurchase = paymentConditionPurchase;

  const result = await apiPost('crm/Accounts', body);
  return result.d;
}

async function uploadDocument(filePath, filename) {
  const displayName = filename || path.basename(filePath);

  // Step 1: Create a Document record
  const docResult = await apiPost('documents/Documents', {
    Subject: displayName,
    Type: 183, // Purchase invoice
    DocumentDate: new Date().toISOString().slice(0, 10),
  });
  const documentId = docResult.d.ID;

  // Step 2: Upload the file as a DocumentAttachment
  const fileBuffer = fs.readFileSync(filePath);
  const base64Content = fileBuffer.toString('base64');

  await apiPost('documents/DocumentAttachments', {
    Attachment: base64Content,
    Document: documentId,
    FileName: displayName,
  });

  return documentId;
}

async function createPurchaseEntry(invoice) {
  const db = require('../db/database');

  // Look up supplier defaults for GL account and VAT code
  let defaultGL, defaultVAT;
  if (invoice.supplier_id) {
    const supplier = db.prepare('SELECT purchase_account, vat_code FROM suppliers WHERE id = ?').get(invoice.supplier_id);
    if (supplier) {
      defaultGL = supplier.purchase_account || undefined;
      if (supplier.vat_code) {
        const vat = db.prepare('SELECT code FROM vat_codes WHERE id = ? OR code = ?').get(supplier.vat_code, supplier.vat_code);
        if (vat) defaultVAT = vat.code.trim();
      }
    }
  }

  let lines = (invoice.line_items || [])
    .filter(line => line.amount)
    .map(line => {
      // VATCode expects a code string, not UUID - look up if needed
      let vatCode = line.vat_code || defaultVAT;
      if (vatCode && vatCode.includes('-')) {
        const vat = db.prepare('SELECT code FROM vat_codes WHERE id = ?').get(vatCode);
        if (vat) vatCode = vat.code.trim();
      }
      return {
        AmountFC: line.amount,
        Description: line.description,
        GLAccount: line.gl_account || defaultGL,
        VATCode: vatCode || undefined,
      };
    });

  // If no line items, create one from the subtotal/total
  if (lines.length === 0 && (invoice.subtotal || invoice.total_amount)) {
    // Check if the VAT code is inclusive or exclusive to determine the right amount
    const vatInfo = defaultVAT ? db.prepare('SELECT description FROM vat_codes WHERE trim(code) = ?').get(defaultVAT) : null;
    const isInclusive = vatInfo && /inclusief/i.test(vatInfo.description);

    lines = [{
      AmountFC: isInclusive ? (invoice.total_amount || invoice.subtotal) : (invoice.subtotal || invoice.total_amount),
      Description: invoice.description || invoice.invoice_number || '',
      GLAccount: defaultGL,
      VATCode: defaultVAT,
    }];
  }

  // Use per-invoice journal, then configured default, then fall back to 60 (Inkoopboek)
  const journalSetting = db.prepare("SELECT value FROM settings WHERE key = 'default_journal'").get();
  let journalCode = invoice.journal || journalSetting?.value || '60';
  // Resolve UUID to code if needed (Exact API expects code, not GUID)
  if (journalCode && journalCode.includes('-')) {
    const j = db.prepare('SELECT code FROM journals WHERE id = ?').get(journalCode);
    if (j) journalCode = j.code;
  }

  // Upload source document first so we can link it to the entry
  let documentId;
  let pdfFile = invoice.pdf_path ? resolvePdfPath(invoice.pdf_path) : null;
  if (pdfFile && isExcelFile(pdfFile)) {
    try { pdfFile = await convertToPdf(pdfFile); } catch (err) {
      console.error('Excel to PDF conversion for upload failed:', err.message);
    }
  }
  if (pdfFile && fs.existsSync(pdfFile)) {
    try {
      const uploadName = isExcelFile(invoice.pdf_filename || '') ? path.basename(pdfFile) : invoice.pdf_filename;
      documentId = await uploadDocument(pdfFile, uploadName);
    } catch (err) {
      console.error('Document upload failed (will create entry without document):', err.message);
    }
  }

  const body = {
    Supplier: invoice.supplier_id,
    Journal: journalCode,
    YourRef: invoice.your_ref || invoice.invoice_number || undefined,
    EntryDate: invoice.invoice_date || undefined,
    DueDate: invoice.due_date || undefined,
    Currency: invoice.currency || 'EUR',
    Description: invoice.invoice_number || '',
    Document: documentId || undefined,
    PurchaseEntryLines: lines,
  };

  const result = await apiPost('purchaseentry/PurchaseEntries', body);
  return result.d;
}

async function checkDuplicateEntry(supplierID, invoiceNumber) {
  if (!invoiceNumber) return null;

  const safeInvoiceNumber = invoiceNumber.replace(/'/g, "''");
  const filters = [`YourRef eq '${safeInvoiceNumber}'`];
  if (supplierID) {
    const safeSupplierID = supplierID.replace(/'/g, "''");
    filters.push(`Supplier eq guid'${safeSupplierID}'`);
  }

  const results = await apiGet('purchaseentry/PurchaseEntries', {
    $filter: filters.join(' and '),
    $select: 'EntryNumber,EntryDate,YourRef,Description',
    $top: '5',
  });

  return results.length > 0 ? results : null;
}

module.exports = { getSuppliers, getGLAccounts, getVATCodes, getJournals, createSupplier, createPurchaseEntry, checkDuplicateEntry };
