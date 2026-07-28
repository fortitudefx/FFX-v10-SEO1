// ═══════════════════════════════════════════════════════════════════════════
// RELATED ARTICLES — internal-link scorer
// ───────────────────────────────────────────────────────────────────────────
// Shared so the RENDERER (functions/article.js, which emits the links) and the
// PORTFOLIO AUDIT (functions/api/portfolio-audit.js, which reports how many
// articles are orphaned) score identically. If the audit reimplemented this, it
// would eventually drift and start reporting on links the site does not emit.
//
// Deterministic — no LLM, no network. Scored off articles:index alone:
// tag overlap dominates (3), then title-token overlap (1), then same category
// (0.5). Self, noindex regionals, drafts and consolidated duplicates are all
// excluded, so a related link never points at a URL Google shouldn't index.
// ═══════════════════════════════════════════════════════════════════════════

const REL_STOP = {
  'the':1,'and':1,'for':1,'that':1,'this':1,'with':1,'your':1,'you':1,'are':1,
  'how':1,'why':1,'what':1,'when':1,'not':1,'but':1,'from':1,'has':1,'have':1,
  'will':1,'can':1,'into':1,'its':1,'forex':1,'trading':1,'trade':1,
};

export function relTokens(s) {
  const out = [];
  const w = String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
  for (let i = 0; i < w.length; i++) if (w[i].length >= 3 && !REL_STOP[w[i]]) out.push(w[i]);
  return out;
}

// isMerged(slug) -> truthy when the slug canonicalises elsewhere. Injected rather
// than imported so this module stays free of Pages-specific imports and is
// trivially testable.
export function pickRelated(index, current, n, isMerged) {
  if (!Array.isArray(index) || !current) return [];
  const merged = typeof isMerged === 'function' ? isMerged : () => false;

  const curTags = {};
  const t = Array.isArray(current.tags) ? current.tags : [];
  for (let i = 0; i < t.length; i++) curTags[String(t[i]).toLowerCase().trim()] = 1;
  const curTitle = {};
  const ct = relTokens(current.title);
  for (let j = 0; j < ct.length; j++) curTitle[ct[j]] = 1;

  const scored = [];
  for (let k = 0; k < index.length; k++) {
    const e = index[k];
    if (!e || !e.slug || !e.title) continue;
    if (e.slug === current.slug) continue;              // never self-link
    if (e.region && e.region !== 'Global') continue;    // never link a noindex regional
    if (e.draft) continue;
    if (merged(e.slug)) continue;                       // never link a merged duplicate

    let score = 0;
    const et = Array.isArray(e.tags) ? e.tags : [];
    for (let m = 0; m < et.length; m++) if (curTags[String(et[m]).toLowerCase().trim()]) score += 3;
    const etok = relTokens(e.title);
    const seen = {};
    for (let p = 0; p < etok.length; p++) {
      if (curTitle[etok[p]] && !seen[etok[p]]) { score += 1; seen[etok[p]] = 1; }
    }
    if (e.category && current.category && e.category === current.category) score += 0.5;
    if (score > 0) scored.push({ e, score, date: e.date || '' });
  }
  // Highest relevance first; newer wins ties so the module stays fresh.
  scored.sort((x, y) => (y.score - x.score) || (x.date < y.date ? 1 : -1));
  return scored.slice(0, n || 4).map(s => s.e);
}
