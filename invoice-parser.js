/**
 * Extract structured invoice data from raw PDF text.
 * Uses per-supplier regex rules when available, falls back to generic patterns.
 */

const db = require('../db/database');

let ruleCache = { data: null, ts: 0 };
let supplierCache = { data: null, ts: 0 };
const CACHE_TTL = 60000; // 1 minute
const COMMON_INVOICE_WORDS = new Set(['total', 'invoice', 'amount', 'number', 'credit', 'debit', 'payment', 'subtotal', 'discount', 'delivery', 'service', 'product', 'products', 'account', 'balance', 'charge', 'supply', 'order', 'orders', 'shipping', 'address', 'description', 'quantity', 'price', 'period', 'company', 'netherlands', 'germany', 'belgium', 'france', 'united']);

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

const DUTCH_MONTHS = {
  januari: '01', februari: '02', maart: '03', april: '04', mei: '05', juni: '06',
  juli: '07', augustus: '08', september: '09', oktober: '10', november: '11', december: '12',
  jan: '01', feb: '02', mrt: '03', apr: '04', jun: '06',
  jul: '07', aug: '08', sep: '09', okt: '10', nov: '11', dec: '12',
};

const ENGLISH_MONTHS = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// Combined months for DD-MMM-YY format (e.g. 16-Dec-25)
const ALL_MONTHS = { ...DUTCH_MONTHS, ...ENGLISH_MONTHS };

/**
 * Check if a regex pattern is safe from catastrophic backtracking.
 * Rejects patterns with nested quantifiers like (a+)+, (a*)*b, etc.
 */
function isRegexSafe(pattern) {
  if (!pattern) return true;
  if (pattern.length > 500) return false;
  try {
    new RegExp(pattern);
  } catch (e) {
    return false;
  }
  // Detect nested quantifiers: a group with a quantifier inside, followed by a quantifier outside
  // e.g. (a+)+, (a+)*, (.*)+, ([^"]*)*
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) return false;
  return true;
}

/**
 * Find a matching supplier rule by email_from.
 */
function findRule(emailFrom) {
  if (!emailFrom) return null;
  const rules = getCachedRules();
  for (const rule of rules) {
    try {
      if (!isRegexSafe(rule.email_pattern)) continue;
      const re = new RegExp(rule.email_pattern, 'i');
      if (re.test(emailFrom)) return rule;
    } catch (e) {
      // Skip invalid regex
    }
  }
  return null;
}

/**
 * Parse a number string according to format ('dutch' or 'english').
 */
function parseNumber(str, format) {
  if (!str) return null;
  str = str.replace(/[\s€$£]/g, '');
  let val;
  if (format === 'english') {
    val = parseFloat(str.replace(/,/g, ''));
  } else if (/,\d{1,2}$/.test(str)) {
    // Dutch: 1.234,56
    val = parseFloat(str.replace(/\./g, '').replace(',', '.'));
  } else {
    val = parseFloat(str.replace(/,/g, ''));
  }
  return isNaN(val) ? null : val;
}

/**
 * Parse a captured date string using the given date_format into ISO YYYY-MM-DD.
 */
function parseDate(str, format) {
  if (!str) return null;
  str = str.trim();

  switch (format) {
    case 'DD-MM-YYYY': {
      const m = str.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
      return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
    }
    case 'DD/MM/YYYY': {
      const m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
    }
    case 'DD.MM.YYYY': {
      const m = str.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
    }
    case 'YYYY-MM-DD': {
      const m = str.match(/(\d{4})-(\d{2})-(\d{2})/);
      return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
    }
    case 'YYYY/MM/DD': {
      const m = str.match(/(\d{4})\/(\d{2})\/(\d{2})/);
      return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
    }
    case 'MM/DD/YYYY': {
      const m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
    }
    case 'D-M-YYYY': {
      const m = str.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
      return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
    }
    case 'DD-MM-YY': {
      const m = str.match(/(\d{1,2})-(\d{1,2})-(\d{2})/);
      if (!m) return null;
      const year = parseInt(m[3]) < 70 ? '20' + m[3] : '19' + m[3];
      return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    case 'DD/MM/YY': {
      const m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{2})/);
      if (!m) return null;
      const year = parseInt(m[3]) < 70 ? '20' + m[3] : '19' + m[3];
      return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    case 'DD.MM.YY': {
      const m = str.match(/(\d{1,2})\.(\d{1,2})\.(\d{2})/);
      if (!m) return null;
      const year = parseInt(m[3]) < 70 ? '20' + m[3] : '19' + m[3];
      return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    case 'DD-MMM-YY': {
      // e.g. 16-Dec-25, 08-JAN-26
      const m = str.match(/(\d{1,2})-([A-Za-z]{3})-(\d{2})/);
      if (!m) return null;
      const month = ALL_MONTHS[m[2].toLowerCase()];
      if (!month) return null;
      const year = parseInt(m[3]) < 70 ? '20' + m[3] : '19' + m[3];
      return `${year}-${month}-${m[1].padStart(2, '0')}`;
    }
    case 'auto': {
      // Try YYYY-MM-DD first (unambiguous), then DD-MM-YYYY, DD/MM/YYYY, DD.MM.YYYY
      const isoM = str.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (isoM) return `${isoM[1]}-${isoM[2]}-${isoM[3]}`;
      const dashM = str.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
      if (dashM) return `${dashM[3]}-${dashM[2].padStart(2, '0')}-${dashM[1].padStart(2, '0')}`;
      const slashM = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (slashM) return `${slashM[3]}-${slashM[2].padStart(2, '0')}-${slashM[1].padStart(2, '0')}`;
      const dotM = str.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      if (dotM) return `${dotM[3]}-${dotM[2].padStart(2, '0')}-${dotM[1].padStart(2, '0')}`;
      return null;
    }
    case 'YYYY.M.D': {
      // e.g. 2026.1.29
      const m = str.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/);
      return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
    }
    case 'text-dutch': {
      const m = str.match(/(\d{1,2})\s+(\w+),?\s+(\d{4})/);
      if (!m) return null;
      const month = DUTCH_MONTHS[m[2].toLowerCase()] || ENGLISH_MONTHS[m[2].toLowerCase()];
      return month ? `${m[3]}-${month}-${m[1].padStart(2, '0')}` : null;
    }
    case 'text-english': {
      const m = str.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
      if (!m) return null;
      const month = ENGLISH_MONTHS[m[1].toLowerCase()];
      return month ? `${m[3]}-${month}-${m[2].padStart(2, '0')}` : null;
    }
    default:
      return null;
  }
}

/**
 * Apply a single regex to text and return the first capture group.
 */
function applyRegex(text, pattern) {
  if (!pattern || !isRegexSafe(pattern)) return null;
  try {
    const re = new RegExp(pattern, 'i');
    const m = text.match(re);
    return m ? (m[1] || m[0]).trim() : null;
  } catch (e) {
    return null;
  }
}

function applyRegexAll(text, pattern) {
  if (!pattern || !isRegexSafe(pattern)) return [];
  try {
    const re = new RegExp(pattern, 'gi');
    const results = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      results.push((m[1] || m[0]).trim());
    }
    return results;
  } catch (e) {
    return [];
  }
}

/**
 * Parse invoice using a supplier rule.
 */
function parseWithRule(text, rule) {
  const numberFormat = rule.number_format || 'dutch';

  const rawDate = applyRegex(text, rule.date_regex);
  const rawDueDate = applyRegex(text, rule.due_date_regex);
  const invoiceDate = parseDate(rawDate, rule.date_format || 'DD-MM-YYYY');

  let dueDate = parseDate(rawDueDate, rule.due_date_format || rule.date_format || 'DD-MM-YYYY');
  if (!dueDate && invoiceDate && rule.due_date_days) {
    const d = new Date(invoiceDate);
    d.setDate(d.getDate() + rule.due_date_days);
    dueDate = d.toISOString().slice(0, 10);
  }

  const subtotal = parseNumber(applyRegex(text, rule.subtotal_regex), numberFormat);
  const vat_amount = parseNumber(applyRegex(text, rule.vat_regex), numberFormat);
  let total_amount = parseNumber(applyRegex(text, rule.total_regex), numberFormat);

  // Guard: if total_regex matched inside the subtotal match (e.g. "Totaal" inside "Subtotaal"),
  // try finding the last match instead
  if (total_amount !== null && subtotal !== null && total_amount === subtotal && rule.subtotal_regex && rule.total_regex) {
    const allMatches = applyRegexAll(text, rule.total_regex);
    if (allMatches.length > 1) {
      const lastVal = parseNumber(allMatches[allMatches.length - 1], numberFormat);
      if (lastVal !== null && lastVal !== subtotal) {
        total_amount = lastVal;
      }
    }
  }

  // For credit invoices (negative total), ensure subtotal and VAT are also negative
  const isCredit = total_amount < 0;

  return {
    invoice_number: applyRegex(text, rule.invoice_number_regex),
    invoice_date: invoiceDate,
    due_date: dueDate,
    subtotal: (isCredit && subtotal > 0) ? -subtotal : subtotal,
    vat_amount: (isCredit && vat_amount > 0) ? -vat_amount : vat_amount,
    total_amount,
    currency: rule.currency || 'EUR',
  };
}

/**
 * Test a rule object (not yet saved) against text. Used by the test endpoint.
 */
function testRule(text, rule) {
  return parseWithRule(text, rule);
}

/**
 * Main entry: parse invoice text, using supplier rule if one matches.
 */
function parseInvoice(text, emailFrom) {
  const rule = findRule(emailFrom);

  let result;
  if (rule) {
    result = parseWithRule(text, rule);
    // Auto-set supplier from rule
    result.supplier_name = rule.name;
    result.supplier_id = rule.supplier_id || matchSupplierId(emailFrom);
    result.rule_id = rule.id;

    // Content-based supplier override: if the rule has a supplier_override_regex,
    // extract the actual supplier name from invoice text and look it up
    if (rule.supplier_override_regex) {
      const overrideName = applyRegex(text, rule.supplier_override_regex);
      if (overrideName) {
        const suppliers = getCachedSuppliers();
        const nameLower = overrideName.toLowerCase();
        const match = suppliers.find(s =>
          s.name && nameLower.includes(s.name.toLowerCase())
        ) || suppliers.find(s =>
          s.name && s.name.toLowerCase().includes(nameLower)
        );
        if (match) {
          result.supplier_name = match.name;
          result.supplier_id = match.id;
        }
      }
    }
  } else {
    // Generic fallback (original behavior)
    result = {
      invoice_number: extractInvoiceNumber(text),
      invoice_date: extractDate(text),
      subtotal: extractAmount(text, /(?:Subtotaal|Subtotal|Netto)[:\s]*[€$]?\s*([\d.,]+)/i),
      vat_amount: extractAmount(text, /(?:BTW|VAT|Tax|B\.T\.W)[:\s]*[€$]?\s*([\d.,]+)/i),
      total_amount: extractTotalAmount(text),
      rule_id: null,
    };
    result.supplier_name = matchSupplier(emailFrom, text);
    result.supplier_id = matchSupplierId(emailFrom, text);
  }

  // Detect loodbijdrage (lead surcharge) — common on Dutch auto parts invoices, VAT-free
  result.line_items = [];
  const loodMatch = text.match(/[Tt]otaal\s+loodbijdrage[\s\d]*?\n([\d.,]+)\s*EUR/);
  if (loodMatch && result.subtotal) {
    const numberFormat = rule ? (rule.number_format || 'dutch') : 'dutch';
    const loodAmount = parseNumber(loodMatch[1], numberFormat);
    if (loodAmount && loodAmount > 0) {
      result.line_items = [
        { description: 'Goederen', amount: result.subtotal, gl_account: '', vat_code: '' },
        { description: 'Loodbijdrage', amount: loodAmount, gl_account: '', vat_code: '' },
      ];
    }
  }

  return result;
}

// --- Generic fallback functions (unchanged) ---

function matchSupplier(emailFrom, text) {
  if (!emailFrom) return null;

  const nameMatch = emailFrom.match(/^"?([^"<]+)"?\s*</);
  const addrMatch = emailFrom.match(/<([^>]+)>/);
  const displayName = nameMatch ? nameMatch[1].trim() : '';
  const emailAddr = addrMatch ? addrMatch[1].toLowerCase() : emailFrom.toLowerCase();
  const domain = emailAddr.split('@')[1] || '';
  const domainBase = domain.replace(/^(www|mail|smtp|noreply|no-reply|info|admin|billing|invoices?|factur\w*)\./, '').replace(/\.(com|nl|eu|de|co\.uk|org|net|be)$/, '');

  const suppliers = getCachedSuppliers();
  if (suppliers.length === 0) return displayName || null;

  for (const s of suppliers) {
    const nameLower = (s.name || '').toLowerCase();
    const searchLower = (s.search_code || '').toLowerCase();

    if (domainBase && nameLower.replace(/[\s-]/g, '').includes(domainBase.replace(/[\s-]/g, ''))) {
      return s.name;
    }
    if (domainBase && searchLower.replace(/[\s-]/g, '').includes(domainBase.replace(/[\s-]/g, ''))) {
      return s.name;
    }
  }

  if (displayName) {
    const displayLower = displayName.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const s of suppliers) {
      const nameLower = (s.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (displayLower.includes(nameLower) || nameLower.includes(displayLower)) {
        return s.name;
      }
    }
  }

  // Fallback: search PDF text for known supplier names (handles personal/generic email addresses)
  // Require minimum 6 chars and exclude common invoice words to avoid false positives
  if (text) {
    const textLower = text.toLowerCase();
    for (const s of suppliers) {
      if (s.name && s.name.length >= 6 && !COMMON_INVOICE_WORDS.has(s.name.toLowerCase()) && textLower.includes(s.name.toLowerCase())) {
        return s.name;
      }
    }
  }

  return displayName || emailAddr;
}

function matchSupplierId(emailFrom, text) {
  if (!emailFrom) return null;

  const nameMatch = emailFrom.match(/^"?([^"<]+)"?\s*</);
  const addrMatch = emailFrom.match(/<([^>]+)>/);
  const displayName = nameMatch ? nameMatch[1].trim() : '';
  const emailAddr = addrMatch ? addrMatch[1].toLowerCase() : emailFrom.toLowerCase();
  const domain = emailAddr.split('@')[1] || '';
  const domainBase = domain.replace(/^(www|mail|smtp|noreply|no-reply|info|admin|billing|invoices?|factur\w*)\./, '').replace(/\.(com|nl|eu|de|co\.uk|org|net|be)$/, '');

  const suppliers = getCachedSuppliers();
  if (suppliers.length === 0) return null;

  for (const s of suppliers) {
    const nameLower = (s.name || '').toLowerCase();
    const searchLower = (s.search_code || '').toLowerCase();

    if (domainBase && nameLower.replace(/[\s-]/g, '').includes(domainBase.replace(/[\s-]/g, ''))) {
      return s.id;
    }
    if (domainBase && searchLower.replace(/[\s-]/g, '').includes(domainBase.replace(/[\s-]/g, ''))) {
      return s.id;
    }
  }

  if (displayName) {
    const displayLower = displayName.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const s of suppliers) {
      const nameLower = (s.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (displayLower.includes(nameLower) || nameLower.includes(displayLower)) {
        return s.id;
      }
    }
  }

  // Fallback: search PDF text for known supplier names
  // Require minimum 6 chars and exclude common invoice words to avoid false positives
  if (text) {
    const textLower = text.toLowerCase();
    for (const s of suppliers) {
      if (s.name && s.name.length >= 6 && !COMMON_INVOICE_WORDS.has(s.name.toLowerCase()) && textLower.includes(s.name.toLowerCase())) {
        return s.id;
      }
    }
  }

  return null;
}

function extractInvoiceNumber(text) {
  const patterns = [
    /(?:Factuurnummer|Factuurnr|Invoice\s*(?:number|no\.?|#)|Factuur\s*nr\.?|Rechnungsnummer)[.:\s]+([A-Z0-9][\w\-/.]{2,})/i,
    /(?:Factuur|Invoice)[:\s]+#?\s*([A-Z0-9][\w\-/.]{2,})/i,
    /Factuurnummer\s*\n\s*([A-Z0-9][\w\-/.]{2,})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const num = match[1].trim();
      if (num.length <= 30 && !/^(en|de|het|van|voor|the|and|is|factuur|invoice|factuurnummer|factuurnr|datum|date)$/i.test(num)) {
        return num;
      }
    }
  }
  return null;
}

function extractDate(text) {
  const patterns = [
    /(?:Factuurdatum|Invoice\s*date|Datum|Date)[.:\s]*([\d]{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/i,
    /(?:Factuurdatum|Invoice\s*date|Datum|Date)[.:\s]*(\d{1,2}\s+(?:januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|jan|feb|mrt|apr|mei|jun|jul|aug|sep|okt|nov|dec)\s+\d{4})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function extractAmount(text, pattern) {
  const match = text.match(pattern);
  if (!match) return null;
  return parseNumber(match[1], 'dutch');
}

function extractTotalAmount(text) {
  const patterns = [
    /(?:Totaal\s*(?:incl\.?\s*BTW)?|Total\s*(?:incl\.?\s*VAT)?|Amount\s*due|Te\s*betalen)[:\s]*[€$]?\s*([\d.,]+)/i,
    /(?:Totaalbedrag|Total\s*amount|Totaal\s*bedrag)[:\s]*[€$]?\s*([\d.,]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return parseNumber(match[1], 'dutch');
  }
  return null;
}

// --- Auto-learn: generate regex suggestions from corrected values ---

const AMOUNT_KEYWORDS = {
  total_amount: ['Totaal te betalen', 'Totaal incl', 'Te betalen', 'Totaalbedrag', 'Total amount', 'Amount due', 'TOTAAL', 'Totaal', 'Total'],
  subtotal: ['Subtotaal', 'Totaal excl', 'Bedrag excl', 'Netto', 'Excl. BTW', 'Subtotal', 'Total excl'],
  vat_amount: ['BTW-bedrag', 'Totaal BTW', 'BTW', 'VAT', 'B.T.W'],
};

const DATE_KEYWORDS = {
  invoice_date: ['Factuurdatum', 'Datum factuur', 'Invoice date', 'Datum', 'Date'],
  due_date: ['Vervaldatum', 'Uiterste betaaldatum', 'Due date', 'Betaal voor', 'Pay before'],
};

const INVOICE_NUMBER_KEYWORDS = ['Factuurnummer', 'Factuurnr', 'Invoice number', 'Invoice no', 'Factuur', 'Invoice #', 'Kenmerk'];

/**
 * Convert a float to an array of text representations to search for in raw text.
 */
function formatNumberForSearch(value) {
  if (value == null || isNaN(value)) return [];
  const abs = Math.abs(value);
  const fixed2 = abs.toFixed(2);
  const [intPart, decPart] = fixed2.split('.');
  const results = [];

  // Dutch format with thousands separator: 1.234,56
  if (intPart.length > 3) {
    const withThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    results.push(`${withThousands},${decPart}`);
  }
  // Dutch format without thousands: 1234,56
  results.push(`${intPart},${decPart}`);
  // English format with thousands: 1,234.56
  if (intPart.length > 3) {
    const withThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    results.push(`${withThousands}.${decPart}`);
  }
  // English format without thousands: 1234.56
  results.push(`${intPart}.${decPart}`);
  // Without decimals if .00
  if (decPart === '00') {
    results.push(intPart);
  }
  return results;
}

/**
 * Find a keyword+amount regex pattern for an amount field.
 */
function findAmountPattern(rawText, value, keywords) {
  const candidates = formatNumberForSearch(value);
  if (candidates.length === 0) return null;

  let bestMatch = null;
  let bestKeywordRank = Infinity;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const numRe = new RegExp(escaped, 'g');
    let m;
    while ((m = numRe.exec(rawText)) !== null) {
      const pos = m.index;
      const lookback = rawText.substring(Math.max(0, pos - 60), pos);
      for (let ki = 0; ki < keywords.length; ki++) {
        const kw = keywords[ki];
        const kwIdx = lookback.lastIndexOf(kw);
        if (kwIdx === -1) continue;
        const distance = lookback.length - kwIdx - kw.length;
        if (ki < bestKeywordRank || (ki === bestKeywordRank && distance < bestDistance)) {
          bestKeywordRank = ki;
          bestDistance = distance;
          const kwEscaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          bestMatch = { regex: `${kwEscaped}[:\\s]*€?\\s*([\\d.,]+)`, keyword: kw };
        }
      }
    }
  }
  return bestMatch;
}

/**
 * Find a keyword+date regex pattern for a date field.
 */
function findDatePattern(rawText, isoDate, keywords) {
  if (!isoDate) return null;
  const [year, month, day] = isoDate.split('-');
  const d = parseInt(day), mo = parseInt(month);

  const formats = [
    { text: `${day}-${month}-${year}`, format: 'DD-MM-YYYY', pattern: '(\\d{2}-\\d{2}-\\d{4})' },
    { text: `${day}/${month}/${year}`, format: 'DD/MM/YYYY', pattern: '(\\d{2}/\\d{2}/\\d{4})' },
    { text: `${day}.${month}.${year}`, format: 'DD.MM.YYYY', pattern: '(\\d{2}\\.\\d{2}\\.\\d{4})' },
    { text: `${d}-${mo}-${year}`, format: 'D-M-YYYY', pattern: '(\\d{1,2}-\\d{1,2}-\\d{4})' },
    { text: `${isoDate}`, format: 'YYYY-MM-DD', pattern: '(\\d{4}-\\d{2}-\\d{2})' },
  ];

  let bestMatch = null;
  let bestKeywordRank = Infinity;
  let bestDistance = Infinity;

  for (const fmt of formats) {
    let searchIdx = 0;
    while (true) {
      const pos = rawText.indexOf(fmt.text, searchIdx);
      if (pos === -1) break;
      searchIdx = pos + 1;

      const lookback = rawText.substring(Math.max(0, pos - 60), pos);
      for (let ki = 0; ki < keywords.length; ki++) {
        const kw = keywords[ki];
        const kwIdx = lookback.toLowerCase().lastIndexOf(kw.toLowerCase());
        if (kwIdx === -1) continue;
        const distance = lookback.length - kwIdx - kw.length;
        if (ki < bestKeywordRank || (ki === bestKeywordRank && distance < bestDistance)) {
          bestKeywordRank = ki;
          bestDistance = distance;
          const kwEscaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          bestMatch = { regex: `${kwEscaped}[:\\s]*${fmt.pattern}`, date_format: fmt.format, keyword: kw };
        }
      }
    }
  }
  return bestMatch;
}

/**
 * Find a keyword+text regex pattern for invoice number.
 */
function findTextPattern(rawText, value, keywords) {
  if (!value || !value.trim()) return null;
  const val = value.trim();

  let bestMatch = null;
  let bestKeywordRank = Infinity;
  let bestDistance = Infinity;

  let searchIdx = 0;
  while (true) {
    const pos = rawText.indexOf(val, searchIdx);
    if (pos === -1) break;
    searchIdx = pos + 1;

    const lookback = rawText.substring(Math.max(0, pos - 60), pos);
    for (let ki = 0; ki < keywords.length; ki++) {
      const kw = keywords[ki];
      const kwIdx = lookback.toLowerCase().lastIndexOf(kw.toLowerCase());
      if (kwIdx === -1) continue;
      const distance = lookback.length - kwIdx - kw.length;
      if (ki < bestKeywordRank || (ki === bestKeywordRank && distance < bestDistance)) {
        bestKeywordRank = ki;
        bestDistance = distance;
        const kwEscaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        bestMatch = { regex: `${kwEscaped}[.:\\s]+(\\S+)`, keyword: kw };
      }
    }
  }
  return bestMatch;
}

/**
 * Generate regex pattern suggestions by reverse-engineering corrected invoice values.
 * Returns an object keyed by field name with { regex, date_format?, old_regex? } values.
 */
function generateSuggestions(rawText, savedValues, rule) {
  if (!rawText) return null;
  const suggestions = {};

  // Amount fields
  for (const [field, keywords] of Object.entries(AMOUNT_KEYWORDS)) {
    const savedVal = parseFloat(savedValues[field]);
    if (!savedVal || savedVal === 0) continue;

    const regexField = field === 'total_amount' ? 'total_regex' : field === 'vat_amount' ? 'vat_regex' : 'subtotal_regex';
    if (rule && rule[regexField]) {
      const extracted = applyRegex(rawText, rule[regexField]);
      const parsed = parseNumber(extracted, rule.number_format || 'dutch');
      if (parsed === savedVal) continue;
    }

    const match = findAmountPattern(rawText, savedVal, keywords);
    if (match) {
      // Verify the regex actually extracts the correct value
      const extracted = applyRegex(rawText, match.regex);
      const parsed = parseNumber(extracted, rule?.number_format || 'dutch');
      if (parsed !== savedVal) continue;

      suggestions[regexField] = {
        regex: match.regex,
        old_regex: rule ? rule[regexField] || null : null,
        label: field === 'total_amount' ? 'Total' : field === 'vat_amount' ? 'VAT' : 'Subtotal',
      };
    }
  }

  // Date fields
  for (const [field, keywords] of Object.entries(DATE_KEYWORDS)) {
    const savedVal = savedValues[field];
    if (!savedVal) continue;

    const regexField = field === 'invoice_date' ? 'date_regex' : 'due_date_regex';
    const formatField = field === 'invoice_date' ? 'date_format' : 'due_date_format';
    if (rule && rule[regexField]) {
      const extracted = applyRegex(rawText, rule[regexField]);
      const parsed = parseDate(extracted, rule[formatField] || 'DD-MM-YYYY');
      if (parsed === savedVal) continue;
    }

    const match = findDatePattern(rawText, savedVal, keywords);
    if (match) {
      // Verify the regex actually extracts the correct date
      const extracted = applyRegex(rawText, match.regex);
      const parsed = parseDate(extracted, match.date_format);
      if (parsed !== savedVal) continue;

      suggestions[regexField] = {
        regex: match.regex,
        date_format: match.date_format,
        format_field: formatField,
        old_regex: rule ? rule[regexField] || null : null,
        label: field === 'invoice_date' ? 'Invoice Date' : 'Due Date',
      };
    }
  }

  // Invoice number
  if (savedValues.invoice_number) {
    const alreadyCorrect = rule && rule.invoice_number_regex && applyRegex(rawText, rule.invoice_number_regex) === savedValues.invoice_number;
    if (!alreadyCorrect) {
      const match = findTextPattern(rawText, savedValues.invoice_number, INVOICE_NUMBER_KEYWORDS);
      if (match) {
        // Verify the regex actually extracts the correct value
        const extracted = applyRegex(rawText, match.regex);
        if (extracted === savedValues.invoice_number) {
          suggestions.invoice_number_regex = {
            regex: match.regex,
            old_regex: rule ? rule.invoice_number_regex || null : null,
            label: 'Invoice Number',
          };
        }
      }
    }
  }

  return Object.keys(suggestions).length > 0 ? suggestions : null;
}

module.exports = { parseInvoice, findRule, testRule, generateSuggestions, isRegexSafe };
