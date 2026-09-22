const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const PDFS_DIR = path.resolve(path.join(__dirname, '../../data/pdfs'));

function isExcelFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.xls' || ext === '.xlsx';
}

// Resolve stored pdf_path to actual file location (handles absolute path mismatches between machines)
function resolvePdfPath(storedPath) {
  return path.join(PDFS_DIR, path.basename(storedPath));
}

async function extractText(pdfPath) {
  const buffer = fs.readFileSync(pdfPath);
  const data = await pdfParse(buffer);
  return data.text.replace(/\x00/g, '-').replace(/\u00a0/g, ' ');
}

// Convert xlsx/xls to PDF using LibreOffice headless. Returns path to the generated PDF.
async function convertToPdf(filePath) {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath, path.extname(filePath));
  const pdfPath = path.join(dir, basename + '.pdf');

  if (fs.existsSync(pdfPath)) return pdfPath;

  await execFileAsync('libreoffice', [
    '--headless', '--calc', '--convert-to', 'pdf', '--outdir', dir, filePath
  ], { timeout: 30000 });

  if (!fs.existsSync(pdfPath)) {
    throw new Error('LibreOffice conversion failed');
  }
  return pdfPath;
}

module.exports = { extractText, convertToPdf, isExcelFile, resolvePdfPath, PDFS_DIR };
