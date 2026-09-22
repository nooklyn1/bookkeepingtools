#!/usr/bin/env node
/**
 * One-off script to:
 * 1. Merge duplicate supplier rules (Drukzo, ETT Eindhoven)
 * 2. Improve partial/minimal rules by matching sample invoice texts against common regex patterns
 */

const path = require('path');
const fs = require('fs');
const db = require('../src/db/database.js');

const SAMPLES_DIR = path.join(__dirname, '..', 'data', 'samples');

// Standard number capture (requires at least one digit, prevents matching lone dots/commas)
const NUM = '(\\d[\\d.,]*\\d|\\d+)';
// Strict monetary number (requires decimal separator + 2 digits) — for reversed patterns
const MONEY = '(\\d[\\d.]*,\\d{2}|\\d[\\d,]*\\.\\d{2})';
// Non-newline whitespace (for reversed patterns — prevent matching across lines)
const SP = '[ \\t]*';
// Optional separator between label and value
const SEP = '[:\\s]*(?:€|\\$|EUR|Eur)?\\s*';

// ─── Pattern Libraries ───────────────────────────────────────────────────────

const DATE_PATTERNS = [
  { regex: `Factuurdatum${SEP}(\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4})`, format: 'DD-MM-YYYY', label: 'Factuurdatum DD-MM-YYYY' },
  { regex: `Factuurdatum${SEP}(\\d{4}-\\d{2}-\\d{2})`, format: 'YYYY-MM-DD', label: 'Factuurdatum YYYY-MM-DD' },
  { regex: `Factuur-?\\s*/\\s*afleverdatum${SEP}(\\d{2}\\.\\d{2}\\.\\d{4})`, format: 'DD.MM.YYYY', label: 'Factuur/afleverdatum DD.MM.YYYY' },
  { regex: `Datum${SEP}(\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4})`, format: 'DD-MM-YYYY', label: 'Datum DD-MM-YYYY' },
  { regex: `Datum${SEP}(\\d{4}-\\d{2}-\\d{2})`, format: 'YYYY-MM-DD', label: 'Datum YYYY-MM-DD' },
  { regex: `DATUM${SEP}(\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4})`, format: 'DD-MM-YYYY', label: 'DATUM DD-MM-YYYY' },
  { regex: `(?:Invoice\\s*[Dd]ate|Invoice Date)${SEP}(\\d{1,2}[/-]\\d{1,2}[/-]\\d{4})`, format: 'DD-MM-YYYY', label: 'Invoice date DD-MM-YYYY' },
  { regex: `(?:Invoice\\s*[Dd]ate|Invoice Date)${SEP}(\\d{4}-\\d{2}-\\d{2})`, format: 'YYYY-MM-DD', label: 'Invoice date YYYY-MM-DD' },
  { regex: `(?:Invoice\\s*[Dd]ate|Invoice Date)${SEP}(\\d{1,2}\\s+\\w+\\s+\\d{4})`, format: 'DD-MMM-YYYY', label: 'Invoice date DD Month YYYY' },
  { regex: `Date${SEP}(\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4})`, format: 'DD-MM-YYYY', label: 'Date DD-MM-YYYY' },
  { regex: `Date${SEP}(\\d{4}-\\d{2}-\\d{2})`, format: 'YYYY-MM-DD', label: 'Date YYYY-MM-DD' },
  { regex: `Date${SEP}(\\d{1,2}\\s+\\w+\\s+\\d{4})`, format: 'DD-MMM-YYYY', label: 'Date DD Month YYYY' },
  { regex: `Rechnungsdatum${SEP}(\\d{1,2}\\.\\d{1,2}\\.\\d{4})`, format: 'DD.MM.YYYY', label: 'Rechnungsdatum DD.MM.YYYY' },
  { regex: `Rechnungsdatum${SEP}(\\d{2}\\.\\d{2}\\.\\d{2})(?!\\d)`, format: 'DD.MM.YY', label: 'Rechnungsdatum DD.MM.YY' },
  { regex: `Besteldatum${SEP}(\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4})`, format: 'DD-MM-YYYY', label: 'Besteldatum DD-MM-YYYY' },
  { regex: `Orderdatum${SEP}(\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4})`, format: 'DD-MM-YYYY', label: 'Orderdatum DD-MM-YYYY' },
  { regex: `Fakturadatum${SEP}(\\d{4}-\\d{2}-\\d{2})`, format: 'YYYY-MM-DD', label: 'Fakturadatum YYYY-MM-DD' },
  // Fallback
  { regex: `\\bdate${SEP}(\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4})`, format: 'DD-MM-YYYY', flags: 'i', label: 'date fallback DD-MM-YYYY' },
  { regex: `\\bdate${SEP}(\\d{4}-\\d{2}-\\d{2})`, format: 'YYYY-MM-DD', flags: 'i', label: 'date fallback YYYY-MM-DD' },
];

const TOTAL_PATTERNS = [
  // Label → value (standard order)
  { regex: `Totaal\\s*te\\s*(?:betalen|voldoen)${SEP}${NUM}`, label: 'Totaal te betalen/voldoen' },
  { regex: `Totaal\\s*(?:incl\\.?\\s*(?:BTW|btw))${SEP}${NUM}`, label: 'Totaal incl BTW' },
  { regex: `Totaal\\s*te\\s*betalen\\s*incl\\.?\\s*BTW${SEP}${NUM}`, label: 'Totaal te betalen incl BTW' },
  { regex: `Totaalbedrag${SEP}${NUM}`, label: 'Totaalbedrag' },
  { regex: `Totaal\\s*bedrag${SEP}${NUM}`, label: 'Totaal bedrag' },
  { regex: `TOTAAL\\s*(?:TE\\s*VOLDOEN)?${SEP}${NUM}`, label: 'TOTAAL (TE VOLDOEN)' },
  { regex: `Totaal${SEP}${NUM}`, label: 'Totaal' },
  { regex: `Te\\s*betalen${SEP}${NUM}`, label: 'Te betalen' },
  { regex: `Eindtotaal${SEP}${NUM}`, label: 'Eindtotaal' },
  { regex: `Totale\\s*brutowaarde${SEP}${NUM}`, label: 'Totale brutowaarde' },
  { regex: `Bruto\\s*totaalbedrag${SEP}${NUM}`, label: 'Bruto totaalbedrag' },
  // English label → value
  { regex: `Total\\s*\\(?(?:incl(?:uding|\\.?)\\s*)?(?:VAT|Tax|GST)?\\)?${SEP}${NUM}`, label: 'Total (incl VAT)' },
  { regex: `Total\\s*\\((?:EUR|USD|GBP)\\)${SEP}${NUM}`, label: 'Total (currency)' },
  { regex: `TOTAL\\s*AMOUNT${SEP}${NUM}`, label: 'TOTAL AMOUNT' },
  { regex: `Total\\s*amount\\s*(?:due)?${SEP}${NUM}`, label: 'Total amount due' },
  { regex: `Payment\\s*amount${SEP}${NUM}`, label: 'Payment amount' },
  { regex: `Amount\\s*[Dd]ue${SEP}${NUM}`, label: 'Amount Due' },
  // German
  { regex: `Gesamtbetrag${SEP}${NUM}`, label: 'Gesamtbetrag' },
  { regex: `Rechnungsbetrag${SEP}${NUM}`, label: 'Rechnungsbetrag' },
  { regex: `Brutto${SEP}${NUM}`, label: 'Brutto' },
  { regex: `Grand\\s*Total${SEP}${NUM}`, label: 'Grand Total' },
  { regex: `Invoice\\s*Total${SEP}${NUM}`, label: 'Invoice Total' },
  // Reversed: amount before label — require MONEY + no newline gap (SP)
  { regex: `€${SP}${MONEY}${SP}Te\\s*betalen`, label: '€amount Te betalen (rev)' },
  { regex: `€${SP}${MONEY}${SP}Totaalbedrag`, label: '€amount Totaalbedrag (rev)' },
  { regex: `${MONEY}${SP}€?${SP}Totaal\\s*te\\s*(?:betalen|voldoen)`, label: 'amount Totaal te betalen (rev)' },
  { regex: `${MONEY}${SP}(?:€|EUR|Eur)${SP}Totaal(?!\\s*(?:excl|BTW|btw|netto))`, label: 'amount€ Totaal (rev)' },
  { regex: `${MONEY}${SP}(?:€|EUR|Eur)${SP}Total(?!\\s*(?:excl|VAT|net))`, label: 'amount€ Total (rev)' },
];

const SUBTOTAL_PATTERNS = [
  // Label → value (standard order)
  { regex: `Subtotaal\\s*\\(?excl\\.?\\s*btw\\)?${SEP}${NUM}`, label: 'Subtotaal (excl. btw)', flags: 'i' },
  { regex: `Subtotaal${SEP}${NUM}`, label: 'Subtotaal' },
  { regex: `(?:Totaal|Bedrag)\\s*excl(?:usief|\\.?)\\s*(?:BTW|btw|VAT)${SEP}${NUM}`, label: 'Totaal excl BTW' },
  { regex: `Totale\\s*nettowaarde${SEP}${NUM}`, label: 'Totale nettowaarde' },
  { regex: `Netto\\s*totaalbedrag${SEP}${NUM}`, label: 'Netto totaalbedrag' },
  { regex: `Nettowaarde\\s*(?:artikelen)?${SEP}${NUM}`, label: 'Nettowaarde (artikelen)' },
  { regex: `Netto\\s*(?:bedrag)?${SEP}${MONEY}`, label: 'Netto bedrag' },
  { regex: `Excl\\.?\\s*(?:BTW|btw)${SEP}${NUM}`, label: 'Excl. BTW' },
  { regex: `Sub\\s*total${SEP}${NUM}`, label: 'Sub total' },
  { regex: `Subtotal${SEP}${NUM}`, label: 'Subtotal' },
  { regex: `Nettobetrag${SEP}${NUM}`, label: 'Nettobetrag' },
  { regex: `Total\\s*excl(?:uding|\\.?)\\s*(?:VAT|Tax|GST)${SEP}${NUM}`, label: 'Total excl VAT' },
  { regex: `Amount\\s*excl(?:uding|\\.?)\\s*(?:VAT|Tax)${SEP}${NUM}`, label: 'Amount excl VAT' },
  // Reversed: amount before label — require MONEY + no newline gap (SP)
  { regex: `${MONEY}${SP}(?:€|EUR|Eur)?${SP}(?:Totaal|Bedrag)\\s*excl`, label: 'amount Totaal excl (rev)' },
  { regex: `${MONEY}${SP}(?:€|EUR|Eur)?${SP}Subtotaal`, label: 'amount Subtotaal (rev)' },
  { regex: `${MONEY}${SP}Excl\\.?\\s*BTW`, label: 'amount Excl. BTW (rev)' },
  { regex: `${MONEY}${SP}€${SP}Netto`, label: 'amount€ Netto (rev)' },
];

const VAT_PATTERNS = [
  // Specific Dutch patterns (most reliable first)
  { regex: `BTW-[Bb]edrag${SEP}${NUM}`, label: 'BTW-Bedrag' },
  { regex: `BTW\\s*\\d+\\s*%\\s*(?:over|x)\\s*€?\\s*[\\d.,]+${SEP}${NUM}`, label: 'BTW N% over/x €base' },
  { regex: `BTW\\s*\\d+\\s*%\\s*(?:exclusief|excl\\.?)${SEP}${NUM}`, label: 'BTW N% exclusief' },
  { regex: `Totaal\\s*BTW\\s*\\((?:EUR|USD)\\)${SEP}${NUM}`, label: 'Totaal BTW (EUR)' },
  { regex: `Totaal\\s*BTW${SEP}${MONEY}`, label: 'Totaal BTW' },
  { regex: `BTW\\s*'[HL]'\\s*\\([\\d.]+%\\)\\s*${NUM}`, label: "BTW 'H/L' (N%)" },
  { regex: `BTW(?:Eur|\\s*€)\\s*${NUM}`, label: 'BTW€/Eur amount' },
  // N% BTW: "21% BTW €10.88" — percent before BTW, then amount
  { regex: `\\d+%\\s*BTW${SEP}${NUM}`, label: 'N% BTW' },
  // "btw hoog tarief" / "btw laag tarief" — require hoog/laag keyword
  { regex: `(?:BTW|btw)\\s+(?:hoog|laag)\\s*(?:tarief)?\\s*(?:,\\s*exclusief)?${SEP}${NUM}`, label: 'BTW hoog/laag tarief' },
  // Belasting (German/Dutch)
  { regex: `Belasting\\s*\\d+[.,]\\d*\\s*%\\s+${NUM}`, label: 'Belasting N%' },
  // English VAT — specific patterns first
  { regex: `VAT\\s*(?:[A-Z]{2}\\s*)?\\d+%${SEP}${NUM}`, label: 'VAT CC N%' },
  { regex: `VAT\\s+amount${SEP}${NUM}`, label: 'VAT amount' },
  // German
  { regex: `MwSt\\.?\\s*(?:\\d+[%,]?\\d*\\s*%?)?${SEP}${NUM}`, label: 'MwSt' },
  // Reversed: amount before BTW label — require MONEY + same line (SP)
  { regex: `${MONEY}${SP}(?:€|EUR|Eur)?${SP}(?:BTW|btw)\\s+(?:bedrag|hoog|laag)`, label: 'amount BTW tarief (rev)' },
  { regex: `${MONEY}${SP}(?:€|EUR|Eur)?${SP}Totaal\\s*BTW`, label: 'amount Totaal BTW (rev)' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tryPattern(text, pattern, flags) {
  try {
    const re = new RegExp(pattern, flags || '');
    const m = text.match(re);
    if (!m || !m[1]) return null;
    const val = m[1].trim();
    if (!/\d/.test(val)) return null;
    // Reject overly long digit sequences (phone/account numbers)
    if (val.replace(/[.,\s]/g, '').length > 8) return null;
    return val;
  } catch {
    return null;
  }
}

function detectNumberFormat(text) {
  const dutchPattern = /€\s*\d{1,3}(?:\.\d{3})*,\d{2}/;
  const englishPattern = /€\s*\d{1,3}(?:,\d{3})*\.\d{2}/;
  const hasDutch = dutchPattern.test(text);
  const hasEnglish = englishPattern.test(text);
  if (hasDutch && !hasEnglish) return 'dutch';
  if (hasEnglish && !hasDutch) return 'english';
  const dutchNoSign = /\d{1,3}\.\d{3},\d{2}/;
  const englishNoSign = /\d{1,3},\d{3}\.\d{2}/;
  if (dutchNoSign.test(text) && !englishNoSign.test(text)) return 'dutch';
  if (englishNoSign.test(text) && !dutchNoSign.test(text)) return 'english';
  return null;
}

function findSampleDir(emailPattern) {
  try {
    const dirs = fs.readdirSync(SAMPLES_DIR);
    const re = new RegExp(emailPattern, 'i');
    return dirs.find(d => re.test(d));
  } catch {
    return null;
  }
}

function readSampleText(dir) {
  const textPath = path.join(SAMPLES_DIR, dir, 'text.txt');
  try {
    return fs.readFileSync(textPath, 'utf8');
  } catch {
    return null;
  }
}

// ─── Step 1: Merge Duplicates ────────────────────────────────────────────────

function mergeDuplicates() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  STEP 1: Merging Duplicate Rules');
  console.log('═══════════════════════════════════════════════════════════\n');

  // --- Drukzo ---
  const drukzo = db.prepare('SELECT id FROM supplier_rules WHERE id = 147').get();
  if (drukzo) {
    console.log('--- Drukzo (IDs 64 & 147) ---');
    const drukzoText1 = readSampleText('drukzo.nl');
    const drukzoText2 = readSampleText('service-mail.drukzo.nl');
    const drukzoUpdate = {
      email_pattern: '(?:service-mail\\.)?drukzo\\.nl',
      date_regex: 'Factuurdatum[:\\s]+(\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4}|\\d{4}-\\d{2}-\\d{2})',
      date_format: 'auto',
      total_regex: 'Totaal[:\\s]*€?\\s*([\\d.,]+)',
      subtotal_regex: 'Subtotaal\\s*\\(excl\\.?\\s*btw\\)[:\\s]*€?\\s*([\\d.,]+)',
      vat_regex: 'BTW-tarief\\s*\\d+\\s*%\\s*over\\s*€?\\s*[\\d.,]+\\s+€?\\s*([\\d.,]+)',
      number_format: 'dutch',
    };
    for (const [label, text] of [['drukzo.nl', drukzoText1], ['service-mail.drukzo.nl', drukzoText2]]) {
      if (!text) { console.log(`  Warning: No sample for ${label}`); continue; }
      console.log(`  Testing on ${label}:`);
      console.log(`    date:     ${tryPattern(text, drukzoUpdate.date_regex) || 'NO MATCH'}`);
      console.log(`    total:    ${tryPattern(text, drukzoUpdate.total_regex) || 'NO MATCH'}`);
      console.log(`    subtotal: ${tryPattern(text, drukzoUpdate.subtotal_regex) || 'NO MATCH'}`);
      console.log(`    vat:      ${tryPattern(text, drukzoUpdate.vat_regex) || 'NO MATCH'}`);
    }
    db.prepare(`UPDATE supplier_rules SET
      email_pattern = ?, date_regex = ?, date_format = ?,
      total_regex = ?, subtotal_regex = ?, vat_regex = ?, number_format = ?
      WHERE id = 64`).run(
      drukzoUpdate.email_pattern, drukzoUpdate.date_regex, drukzoUpdate.date_format,
      drukzoUpdate.total_regex, drukzoUpdate.subtotal_regex, drukzoUpdate.vat_regex,
      drukzoUpdate.number_format
    );
    db.prepare('DELETE FROM supplier_rules WHERE id = 147').run();
    console.log('  Done: Updated ID 64, deleted ID 147\n');
  } else {
    console.log('--- Drukzo: Already merged ---\n');
  }

  // --- Engine and Turbo Technology ---
  const ett = db.prepare('SELECT id FROM supplier_rules WHERE id = 110').get();
  if (ett) {
    console.log('--- Engine and Turbo Technology (IDs 71 & 110) ---');
    const ettText = readSampleText('etteindhoven.nl');
    const ettUpdate = {
      email_pattern: '(?:etteindhoven|mailer\\.mijnwefact)\\.nl',
      subtotal_regex: 'Totaal\\s*excl\\.?\\s*BTW[:\\s]*€?\\s*([\\d.,]+)',
      vat_regex: '\\d+%\\s*BTW[:\\s]*€?\\s*([\\d.,]+)',
    };
    if (ettText) {
      console.log('  Testing on etteindhoven.nl:');
      const rule71 = db.prepare('SELECT date_regex, total_regex FROM supplier_rules WHERE id = 71').get();
      console.log(`    date:     ${tryPattern(ettText, rule71.date_regex) || 'NO MATCH'}`);
      console.log(`    total:    ${tryPattern(ettText, rule71.total_regex) || 'NO MATCH'}`);
      console.log(`    subtotal: ${tryPattern(ettText, ettUpdate.subtotal_regex) || 'NO MATCH'}`);
      console.log(`    vat:      ${tryPattern(ettText, ettUpdate.vat_regex) || 'NO MATCH'}`);
    }
    db.prepare(`UPDATE supplier_rules SET
      email_pattern = ?, subtotal_regex = ?, vat_regex = ?
      WHERE id = 71`).run(ettUpdate.email_pattern, ettUpdate.subtotal_regex, ettUpdate.vat_regex);
    db.prepare('DELETE FROM supplier_rules WHERE id = 110').run();
    console.log('  Done: Updated ID 71, deleted ID 110\n');
  } else {
    console.log('--- ETT Eindhoven: Already merged ---\n');
  }
}

// ─── Step 2: Reset bad patterns from previous runs ──────────────────────────

function resetBadPatterns() {
  // Identify and reset patterns generated by previous script runs.
  // Script-generated patterns contain distinctive template fragments:
  // - SEP: (?:€|\$|EUR|Eur)?  (with the pipe and dollar sign)
  // - NUM: (\d[\d.,]*\d|\d+)   (alternation with pipe)
  // - MONEY: \d[\d.]*,\d{2}    (with escaped braces)
  // Manually-created patterns use simpler constructs like €?\s* or €\s*
  const rules = db.prepare(`SELECT id, total_regex, subtotal_regex, vat_regex FROM supplier_rules`).all();
  let total = 0;

  const isScriptGenerated = (pattern) => {
    if (!pattern) return false;
    // SEP template: (?:€|\$|EUR|Eur)? — distinctive multi-currency alternation
    if (/\(\?:€\|\\\$\|EUR\|Eur\)/.test(pattern)) return true;
    // NUM template: (\d[\d.,]*\d|\d+) — alternation with \d+
    if (/\(\\d\[\\d\.,\]\*\\d\|\\d\+\)/.test(pattern)) return true;
    // MONEY template: (\d[\d.]*,\d{2}|...)
    if (/\\d\[\\d\.\]\*,\\d\{2\}/.test(pattern)) return true;
    // BTW hoog|laag template
    if (/hoog\|laag/.test(pattern)) return true;
    // GST false positive
    if (/GST/.test(pattern)) return true;
    return false;
  };

  for (const r of rules) {
    const resets = [];
    if (isScriptGenerated(r.vat_regex)) resets.push('vat_regex = NULL');
    if (isScriptGenerated(r.subtotal_regex)) resets.push('subtotal_regex = NULL');
    if (isScriptGenerated(r.total_regex)) resets.push('total_regex = NULL');
    if (resets.length > 0) {
      db.prepare(`UPDATE supplier_rules SET ${resets.join(', ')} WHERE id = ?`).run(r.id);
      total += resets.length;
    }
  }

  if (total > 0) console.log(`  Reset ${total} script-generated patterns from previous runs\n`);
}

// ─── Step 3: Improve Rules via Sample Analysis ──────────────────────────────

function improveRules() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  STEP 2: Improving Rules via Sample Analysis');
  console.log('═══════════════════════════════════════════════════════════\n');

  resetBadPatterns();

  const rules = db.prepare(`SELECT id, name, email_pattern, date_regex, date_format,
    total_regex, subtotal_regex, vat_regex, number_format
    FROM supplier_rules ORDER BY id`).all();

  const stats = { checked: 0, noSample: 0, improved: 0, alreadyGood: 0, noMatch: 0, noMatchList: [] };

  const updateStmt = db.prepare(`UPDATE supplier_rules SET
    date_regex = ?, date_format = ?, total_regex = ?, subtotal_regex = ?,
    vat_regex = ?, number_format = ? WHERE id = ?`);

  for (const rule of rules) {
    stats.checked++;

    const sampleDir = findSampleDir(rule.email_pattern);
    if (!sampleDir) { stats.noSample++; continue; }

    const text = readSampleText(sampleDir);
    if (!text || text.trim().length < 50) { stats.noSample++; continue; }

    const missing = [];
    if (!rule.date_regex) missing.push('date');
    if (!rule.total_regex) missing.push('total');
    if (!rule.subtotal_regex) missing.push('subtotal');
    if (!rule.vat_regex) missing.push('vat');
    if (missing.length === 0) { stats.alreadyGood++; continue; }

    const updates = {
      date_regex: rule.date_regex,
      date_format: rule.date_format || 'DD-MM-YYYY',
      total_regex: rule.total_regex,
      subtotal_regex: rule.subtotal_regex,
      vat_regex: rule.vat_regex,
      number_format: rule.number_format || 'dutch',
    };

    const fieldsImproved = [];

    const tryImprove = (field, patterns, formatField) => {
      if (rule[field]) return;
      for (const p of patterns) {
        const match = tryPattern(text, p.regex, p.flags);
        if (match) {
          updates[field] = p.regex;
          if (formatField && p.format) updates[formatField] = p.format;
          fieldsImproved.push(`${field.replace('_regex', '')} (${p.label}: "${match}")`);
          return;
        }
      }
    };

    tryImprove('date_regex', DATE_PATTERNS, 'date_format');
    tryImprove('total_regex', TOTAL_PATTERNS);
    tryImprove('subtotal_regex', SUBTOTAL_PATTERNS);
    tryImprove('vat_regex', VAT_PATTERNS);

    // Detect number format
    if (rule.number_format === 'dutch' || !rule.number_format) {
      const detected = detectNumberFormat(text);
      if (detected && detected !== (rule.number_format || 'dutch')) {
        updates.number_format = detected;
        fieldsImproved.push(`number_format -> ${detected}`);
      }
    }

    if (fieldsImproved.length > 0) {
      updateStmt.run(
        updates.date_regex, updates.date_format, updates.total_regex,
        updates.subtotal_regex, updates.vat_regex, updates.number_format,
        rule.id
      );
      stats.improved++;
      console.log(`  + #${rule.id} ${rule.name} (${sampleDir}):`);
      for (const f of fieldsImproved) console.log(`      ${f}`);
    } else {
      stats.noMatch++;
      stats.noMatchList.push({ id: rule.id, name: rule.name, sample: sampleDir, missing });
    }
  }

  // Report
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  IMPROVEMENT REPORT');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Rules checked:     ${stats.checked}`);
  console.log(`  Already complete:  ${stats.alreadyGood}`);
  console.log(`  No sample found:   ${stats.noSample}`);
  console.log(`  Improved:          ${stats.improved}`);
  console.log(`  No patterns match: ${stats.noMatch}`);

  const finalRules = db.prepare(`SELECT id, date_regex, total_regex, subtotal_regex, vat_regex FROM supplier_rules`).all();
  const fields = ['date_regex', 'total_regex', 'subtotal_regex', 'vat_regex'];
  let good = 0, partial = 0, minimal = 0;
  for (const r of finalRules) {
    const count = fields.filter(f => r[f]).length;
    if (count >= 4) good++;
    else if (count >= 2) partial++;
    else minimal++;
  }
  console.log(`\n  Final distribution (${finalRules.length} rules):`);
  console.log(`    Good (4 fields):    ${good}`);
  console.log(`    Partial (2-3):      ${partial}`);
  console.log(`    Minimal (0-1):      ${minimal}`);

  if (stats.noMatchList.length > 0) {
    console.log(`\n  Rules with samples but no new matches:`);
    for (const r of stats.noMatchList) {
      console.log(`    #${r.id} ${r.name} (${r.sample}): missing=[${r.missing.join(',')}]`);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

try {
  mergeDuplicates();
  improveRules();
  console.log('\nDone!');
} catch (err) {
  console.error('Error:', err);
  process.exit(1);
}
