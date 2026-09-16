# Module: files

Turns uploaded attachments into content Claude can read: PDF and images natively, `.xlsx`
as CSV text, text files as text. Nothing is stored.

- Settings (optional): `FILES_MAX_BYTES` (default 10 MB), `FILES_MAX_TEXT_CHARS` (default 150k)
- Not supported: Google Drive attachments, legacy `.xls`

Tests: `npm test --workspace @buddy/module-files`
