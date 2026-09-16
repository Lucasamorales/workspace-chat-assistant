const test = require('node:test');
const assert = require('node:assert/strict');
const { validateModule } = require('@buddy/core');
const writeExcelFile = require('write-excel-file/node').default;
const files = require('../src');
const { checkZipSafety } = require('../src/spreadsheet');

const ctx = { settings: {}, log: { info() {}, warn() {}, error() {} } };
const att = (name, contentType, buf, source = 'UPLOADED_CONTENT') => ({
  name, contentType, source,
  download: async max => { if (buf.length > max) throw Object.assign(new Error('too big'), { expose: true }); return buf; },
});

test('module satisfies the contract', () => validateModule(files));

test('reads xlsx into text', async () => {
  const buf = await writeExcelFile([[{ value: 'Name' }, { value: 'Hours' }], [{ value: 'Robin, L' }, { value: 7 }]]).toBuffer();
  const [block] = await files.readAttachment(ctx, att('hours.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf));
  assert.match(block.text, /Name,Hours/);
  assert.match(block.text, /"Robin, L",7/);
});

test('pdf and images become native blocks; csv becomes text', async () => {
  const [pdf] = await files.readAttachment(ctx, att('a.pdf', 'application/pdf', Buffer.from('%PDF')));
  assert.equal(pdf.type, 'document');
  const [img] = await files.readAttachment(ctx, att('a.png', 'image/png', Buffer.from([1, 2])));
  assert.equal(img.source.media_type, 'image/png');
  const [csv] = await files.readAttachment(ctx, att('a.csv', 'text/csv', Buffer.from('a,b\n1,2')));
  assert.match(csv.text, /a,b/);
});

test('drive files, old .xls and unknown types are handled explicitly', async () => {
  assert.match((await files.readAttachment(ctx, att('x.pdf', 'application/pdf', Buffer.alloc(0), 'DRIVE_FILE')))[0].text, /Drive/);
  assert.match((await files.readAttachment(ctx, att('old.xls', 'application/vnd.ms-excel', Buffer.alloc(0))))[0].text, /\.xlsx/);
  assert.equal(await files.readAttachment(ctx, att('x.exe', 'application/octet-stream', Buffer.alloc(0))), null);
});

test('size limit is enforced before reading', async () => {
  const small = { ...ctx, settings: { FILES_MAX_BYTES: '10' } };
  await assert.rejects(files.readAttachment(small, att('big.pdf', 'application/pdf', Buffer.alloc(11))), /too big/);
});

test('zip bombs are refused before parsing', async () => {
  const buf = await writeExcelFile([[{ value: 'x' }]]).toBuffer();
  assert.ok(checkZipSafety(buf) > 0);
  assert.throws(() => checkZipSafety(buf, 10), /expands to more data/);
  assert.throws(() => checkZipSafety(Buffer.from('not a zip at all, definitely not')), /damaged/);
});
