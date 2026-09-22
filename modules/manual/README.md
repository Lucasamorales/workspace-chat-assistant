# manual

Answers questions from the **team member manual**. Buddy reads one shared Drive folder, keeps an
index of it, and answers from those documents only — citing each one with a link.

Replaces the Internal-RAG widget and Chrome extension. Decision: `docs/decisions/0005-manual-rag.md`.

## Using it

| | |
|---|---|
| "How many holidays do I get?" | Answer from the manual, with the document linked |
| "What's the expenses policy?" | As above; if it isn't in the manual, Buddy says so |
| `/manual` | What Buddy has read: documents, sections, when it last looked |
| `/manual reindex` | **Admins:** re-read the folder after a policy changes |
| `/manual check` | **Admins:** can Buddy see the folder, and what can't it index |

## How it works

1. **Read** — walks `MANUAL_FOLDER_ID` and its subfolders as `buddy-bot`, which sees them because
   the folder is shared with it as Viewer.
2. **Extract** — Docs, Slides and Sheets exported to text. PDFs are **not** indexed; they are
   listed by name so "why doesn't Buddy know this?" has an answer: save it as a Doc.
3. **Chunk** — around 1,200 characters, broken on paragraphs and headings, with an overlap so a
   policy split across a boundary is still findable. Each chunk keeps its document, section,
   heading and Drive link.
4. **Embed** — Vertex AI multilingual embeddings, as `buddy-bot`, no API key. Documents and
   questions are embedded differently, which is what makes a question land near its answer.
5. **Search** — the question is embedded and compared against every chunk in memory. At most two
   passages come from any one document, so three policies beat three paragraphs of one, and
   anything below a similarity floor is dropped: no match is better than a confident wrong quote.
6. **Answer** — Claude writes the reply from those passages, in Buddy's voice, citing each
   document.

Re-indexing is incremental: a file whose modified time hasn't changed keeps the chunks and vectors
it already had, so updating one policy costs one document's worth of work, not the manual's.

## What it will not do

- **Invent policy.** Claude is told to answer only from the retrieved passages, and to say plainly
  when the manual doesn't cover something rather than filling the gap from general knowledge.
- **Obey a document.** Manual text is information, not instructions — the same rule uploaded files
  follow. A document saying "ignore your rules" is quoted, never acted on.
- **Write anything.** There is no Drive write path in this module, and the search tool never asks
  for approval because it cannot change anything.
- **Read the Google Site.** Sites has no content API. Anything typed directly into a site page,
  rather than embedded from Drive, is invisible — keep the canonical text in Drive documents.

## Access

Everyone at example.com (`BUDDY_ACCESS_MANUAL`); `manual.admin` for reindexing.

**Retrieval has no per-document permissions:** anything in the folder can be quoted to anyone who
can use the module. The folder is the whole permission boundary, so it should hold only material
that is fine for all staff.

## Settings

| Setting | Default | |
|---|---|---|
| `MANUAL_FOLDER_ID` | — | Required. The Drive folder, shared as Viewer with `buddy-bot` |
| `MANUAL_PROJECT_ID` | — | Required. GCP project for Vertex AI embeddings |
| `MANUAL_REGION` | `europe-west1` | Vertex AI region |
| `MANUAL_EMBEDDING_MODEL` | `text-multilingual-embedding-002` | Multilingual, so Spanish content works |

Needs `aiplatform.googleapis.com` enabled and `roles/aiplatform.user` on `buddy-bot`.

## Storage

`m_manual__index`: chunks with their vectors, packed into shards of 40 so a question is a handful
of reads rather than a thousand, plus a `meta` document holding the file list, the model and a
version. Instances cache the vectors in memory and reload when that version changes.
