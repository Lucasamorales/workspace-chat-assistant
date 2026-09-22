/**
 * Documents → chunks worth retrieving.
 *
 * Chunks break on blank lines and headings rather than mid-sentence, because a policy split
 * across two chunks answers questions badly, and an overlap carries a sentence's context into
 * the next chunk. Every chunk keeps where it came from, so an answer can cite it.
 */

const MAX_CHARS = 1200;
const OVERLAP_CHARS = 200;
const MIN_CHARS = 40;

/** Google's text export is full of blank runs and stray carriage returns. */
function tidy(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A line that reads like a heading: short, no full stop, often numbered or capitalised. */
const looksLikeHeading = line => line.length > 0 && line.length <= 80 && !/[.:;,]$/.test(line.trim());

function splitParagraphs(text) {
  return tidy(text).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
}

/**
 * @returns {{text: string, heading: string, position: number}[]}
 */
function chunk(text, { maxChars = MAX_CHARS, overlap = OVERLAP_CHARS } = {}) {
  const paragraphs = splitParagraphs(text);
  const chunks = [];
  let current = '';
  let heading = '';

  const flush = () => {
    const body = current.trim();
    if (body.length >= MIN_CHARS) chunks.push({ text: body, heading, position: chunks.length });
    // Carry the tail over, so a sentence spanning the boundary is retrievable from both sides.
    current = overlap > 0 && body.length > overlap ? `${body.slice(-overlap)}\n\n` : '';
  };

  for (const paragraph of paragraphs) {
    const firstLine = paragraph.split('\n')[0].trim();
    if (paragraph.length <= 80 && looksLikeHeading(firstLine)) heading = firstLine;

    if (current.length + paragraph.length > maxChars) flush();

    // A single paragraph longer than a chunk is cut on sentence ends, not mid-word.
    if (paragraph.length > maxChars) {
      for (const piece of paragraph.match(new RegExp(`[\\s\\S]{1,${maxChars}}(?=\\s|$)`, 'g')) || [paragraph]) {
        current += `${piece.trim()}\n\n`;
        if (current.length >= maxChars) flush();
      }
    } else {
      current += `${paragraph}\n\n`;
    }
  }
  flush();
  return chunks.filter(c => c.text.length >= MIN_CHARS);
}

/** What a chunk looks like once it knows which document it came from. */
const chunksOf = (file, text) => chunk(text).map(c => ({
  ...c,
  fileId: file.id,
  title: file.name,
  section: file.section || '',
  link: file.webViewLink || '',
}));

/** What Claude sees: the text, with its source, so every claim can be attributed. */
const asContext = hits => hits.map((hit, i) => [
  `[${i + 1}] ${hit.title}${hit.section ? ` (${hit.section})` : ''}${hit.heading ? ` — ${hit.heading}` : ''}`,
  hit.link ? `Link: ${hit.link}` : '',
  hit.text,
].filter(Boolean).join('\n')).join('\n\n---\n\n');

module.exports = { chunk, chunksOf, tidy, asContext, MAX_CHARS };
