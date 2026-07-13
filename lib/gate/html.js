// ═══════════════════════════════════════════════════════════════════════════
// HTML → structural-text adapter for the FFX gate.
// ───────────────────────────────────────────────────────────────────────────
// FFX article bodies are HTML ("<h2>…</h2><p>…</p>"), but structure.js (lifted
// verbatim from Scout) parses Markdown heading lines ("## …"). This is the seam:
// convert the HTML body into the line format structure.js expects — h2→"## ",
// h3→"### ", block elements → paragraph breaks, all other tags stripped — so the
// structural fingerprint stays a single shared implementation across both codebases.
// Also provides plain-text extraction + word counting used by the deterministic
// gate checks (word floor, unique-word ratio, similarity).
// Pure + dependency-free.
// ═══════════════════════════════════════════════════════════════════════════

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
  '&trade;': '™', '&reg;': '®', '&copy;': '©',
};
function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ' '; } })
    .replace(/&[a-z]+;/gi, m => ENTITIES[m.toLowerCase()] ?? ' ');
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

// Convert an HTML body to the "## heading" + paragraph line stream structure.js reads.
export function htmlToStructuralText(html) {
  let s = String(html || '');
  // Drop non-content elements outright.
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  // Headings → markdown, on their own lines with blank-line separation.
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n\n## ${stripTags(t)}\n\n`);
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `\n\n### ${stripTags(t)}\n\n`);
  // Other headings collapse to h3-level (rare in FFX bodies but be safe).
  s = s.replace(/<h[1456][^>]*>([\s\S]*?)<\/h[1456]>/gi, (_, t) => `\n\n### ${stripTags(t)}\n\n`);
  // Block boundaries → paragraph breaks (so opener shingles are per-paragraph).
  s = s.replace(/<\/(p|div|li|ul|ol|blockquote|table|tr|section)>/gi, '\n\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // Everything else → gone; decode entities; normalise blank lines.
  s = decodeEntities(s.replace(/<[^>]+>/g, ' '));
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').replace(/[ \t]*\n[ \t]*/g, '\n').trim();
  return s;
}

// Plain visible text of an HTML body (tags stripped, entities decoded, ws collapsed).
export function htmlToPlainText(html) {
  return stripTags(String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' '));
}

// Word list from an HTML body (lowercased alnum tokens, apostrophes kept inside words).
export function wordsOf(html) {
  return htmlToPlainText(html)
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function countWords(html) {
  return wordsOf(html).length;
}

// Term-frequency map for cosine similarity (content-level dupe detection).
export function termFreq(html) {
  const tf = Object.create(null);
  for (const w of wordsOf(html)) tf[w] = (tf[w] || 0) + 1;
  return tf;
}

// Cosine similarity between two term-frequency maps. 1.0 = identical wording.
export function cosineSim(tfA, tfB) {
  let dot = 0, magA = 0, magB = 0;
  for (const k in tfA) { magA += tfA[k] * tfA[k]; if (tfB[k]) dot += tfA[k] * tfB[k]; }
  for (const k in tfB) { magB += tfB[k] * tfB[k]; }
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
