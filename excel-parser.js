const XLSX = require('xlsx');
const fs = require('fs');

function extractText(filePath) {
  const workbook = XLSX.readFile(filePath);
  const lines = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    // Convert to CSV-like text for invoice parsing
    const text = XLSX.utils.sheet_to_csv(sheet);
    lines.push(text);
  }

  return lines.join('\n');
}

module.exports = { extractText };
