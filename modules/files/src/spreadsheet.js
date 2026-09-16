/**
 * .xlsx → CSV-like text.
 *
 * An .xlsx file is a ZIP archive. Before parsing, we read the ZIP's central directory and
 * refuse files whose declared uncompressed size is huge ("zip bombs": a few MB that expand
 * to gigabytes and exhaust memory).
 */

const readExcelFile = require('read-excel-file/node').default;

const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const EOCD_SIGNATURE = 0x06054b50;
const CDIR_SIGNATURE = 0x02014b50;

function unsafe(message) {
  return Object.assign(new Error(message), { expose: true });
}

function checkZipSafety(buf, maxUncompressed = MAX_UNCOMPRESSED_BYTES) {
  // End-of-central-directory record: last 22 bytes + up to 65535 bytes of comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
  }
  if (eocd < 0) throw unsafe('That spreadsheet file looks damaged.');

  const entries = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (entries > MAX_ENTRIES || entries === 0xffff || offset === 0xffffffff) {
    throw unsafe('That spreadsheet is too complex to read safely.');
  }

  let total = 0;
  for (let i = 0; i < entries; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CDIR_SIGNATURE) {
      throw unsafe('That spreadsheet file looks damaged.');
    }
    total += buf.readUInt32LE(offset + 24); // uncompressed size
    if (total > maxUncompressed) throw unsafe('That spreadsheet expands to more data than I can read safely.');
    offset += 46 + buf.readUInt16LE(offset + 28) + buf.readUInt16LE(offset + 30) + buf.readUInt16LE(offset + 32);
  }
  return total;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function readSpreadsheet(buf) {
  const sheets = await readExcelFile(buf);
  return sheets
    .map(({ sheet, data }) => `### Sheet: ${sheet}\n${data.map(row => row.map(csvCell).join(',')).join('\n')}`)
    .join('\n\n');
}

module.exports = { readSpreadsheet, checkZipSafety, csvCell };
