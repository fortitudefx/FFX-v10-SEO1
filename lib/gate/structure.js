// ═══════════════════════════════════════════════════════════════════════════
// STRUCTURAL FINGERPRINT — the skeleton of a page, independent of its vocabulary.
// ───────────────────────────────────────────────────────────────────────────
// LIFTED VERBATIM from Scout Network (src/utils/structure.js). Pure + dependency-
// free, so it transfers unchanged. FFX feeds it markdown-ised heading lines via
// lib/gate/html.js (FFX article bodies are HTML, Scout's were Markdown) — the
// adapter is at the boundary; this module stays identical to Scout's.
//
// The content-similarity check compares WORDS. Two pages built from one template
// with the topic term swapped share almost no words → it passes them. This module
// compares STRUCTURE: the (optionally role-canonicalized) heading sequence with
// topic terms stripped, section count/order, table presence+position, and
// sentence-opener shingles. Templated pages then score ~1.0 against each other —
// which is exactly how FFX's ~8 near-duplicate "opening candle" articles read.
// ═══════════════════════════════════════════════════════════════════════════

// Normalize one heading to bare word tokens with the topic terms stripped to `_`.
// Collapse punctuation to spaces BEFORE stripping topic tokens so multi-word terms
// still match (otherwise the term leaks into the signature and understates sameness).
function normalizeHeading(h, topicTokens) {
  let s = ' ' + String(h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  for (const t of topicTokens) {
    const tok = String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (tok.length >= 2) s = s.split(' ' + tok + ' ').join(' _ ');
  }
  return s.replace(/\s+/g, ' ').trim();
}

// First `n` words of a text, topic-stripped — a "sentence-opener shingle". Templated
// generation reuses opening patterns ("Most retail traders treat X as noise…") even
// when the headings differ, so these catch phrasing-level templating headings miss.
function openerShingle(text, topicTokens, n = 4) {
  const norm = normalizeHeading(text, topicTokens);       // reuse: lowercases, strips terms, bares words
  const words = norm.split(' ').filter(w => w && w !== '_');
  return words.slice(0, n).join(' ');
}

// Fingerprint of a page. `topicTokens` = topic/keyword terms to strip (e.g. the
// article's primary keyword + tags). `canonicalize` (optional) maps a normalized
// heading to a canonical ROLE token, so synonym-swapped headings for the same role
// collapse together — this is what stops cosmetic heading-renaming from fooling the
// structural gate. Without it, raw normalized headings are used.
export function structuralFingerprint(content, topicTokens = [], canonicalize = null) {
  const headings = [];
  const openers = new Set();
  let tableIndex = -1;
  if (content) {
    const lines = String(content).split('\n');
    let curBody = [];
    const flushOpeners = () => {
      // one opener shingle per paragraph in the section body
      const para = curBody.join('\n').split(/\n\s*\n/);
      for (const p of para) { const sh = openerShingle(p, topicTokens); if (sh) openers.add(sh); }
      curBody = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^\s{0,3}#{2,3}\s+(.+?)\s*#*\s*$/);
      if (m) {
        flushOpeners();
        const norm = normalizeHeading(m[1], topicTokens);
        headings.push(canonicalize ? (canonicalize(norm) || norm) : norm);
      } else {
        curBody.push(line);
        if (tableIndex < 0 && /\|\s*:?-{2,}/.test(line)) tableIndex = headings.length;
      }
    }
    flushOpeners();
  }
  const sectionCount = headings.length;
  return {
    headings,
    signature: headings.join(' > '),
    bigrams: headings.slice(1).map((h, i) => headings[i] + '»' + h),   // ordered role pairs
    openers: [...openers],
    sectionCount,
    hasTable: tableIndex >= 0,
    tablePos: tableIndex >= 0 && sectionCount ? Math.round((tableIndex / sectionCount) * 4) / 4 : null,
  };
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 1;
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// Structural similarity over the heading SET only.
export function structuralSimilarity(fpA, fpB) {
  return jaccard(fpA.headings, fpB.headings);
}

// COMPOSITE structural similarity (the gate metric): blends ordered role sequence,
// opener shingles, and coarse shape (section count + table presence/pos).
// Identical templated pages → ~1.0; genuinely restructured pages → low.
export function compositeStructuralSimilarity(fpA, fpB) {
  const seq = jaccard(fpA.bigrams, fpB.bigrams);                 // roles + order
  const setSim = jaccard(fpA.headings, fpB.headings);            // roles (order-free)
  const roleSim = fpA.bigrams.length && fpB.bigrams.length ? seq : setSim;
  const openerSim = jaccard(fpA.openers, fpB.openers);           // templated phrasing
  const countSim = 1 - Math.min(1, Math.abs(fpA.sectionCount - fpB.sectionCount) / Math.max(3, fpA.sectionCount, fpB.sectionCount));
  const tableSim = (fpA.hasTable === fpB.hasTable)
    ? (fpA.hasTable && fpA.tablePos != null && fpB.tablePos != null ? 1 - Math.abs(fpA.tablePos - fpB.tablePos) : 1)
    : 0;
  const shapeSim = 0.5 * countSim + 0.5 * tableSim;
  return round2(0.55 * roleSim + 0.30 * openerSim + 0.15 * shapeSim);
}

// Distribution over a set of fingerprints (default: composite). Reports mean/median
// pairwise sim + identical-skeleton clusters — used by the Step-3 corpus audit.
export function structuralDistribution(fingerprints, simFn = compositeStructuralSimilarity) {
  const n = fingerprints.length;
  const sims = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      sims.push(simFn(fingerprints[i], fingerprints[j]));
  sims.sort((a, b) => a - b);
  const stat = (arr) => {
    if (!arr.length) return { min: null, median: null, mean: null, max: null };
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return { min: round2(arr[0]), median: round2(arr[Math.floor(arr.length / 2)]), mean: round2(mean), max: round2(arr[arr.length - 1]) };
  };
  const groups = {};
  for (const fp of fingerprints) groups[fp.signature] = (groups[fp.signature] || 0) + 1;
  const clusters = Object.entries(groups).map(([signature, count]) => ({ signature, count })).sort((a, b) => b.count - a.count);
  return {
    pages: n,
    pairs: sims.length,
    similarity: stat(sims),
    pctPairsNearIdentical: sims.length ? round2(sims.filter(s => s >= 0.9).length / sims.length) : null,
    distinctSkeletons: clusters.length,
    largestSkeletonCluster: clusters[0]?.count || 0,
    largestSkeletonSharePct: n ? round2((clusters[0]?.count || 0) / n) : null,
    topClusters: clusters.slice(0, 3),
  };
}

function round2(x) { return x == null ? null : Math.round(x * 100) / 100; }
