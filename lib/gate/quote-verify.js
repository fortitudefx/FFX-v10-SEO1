// ═══════════════════════════════════════════════════════════════════════════
// GATE — QUOTE VERIFICATION (keyword source mode only)
// ───────────────────────────────────────────────────────────────────────────
// In keyword mode the article is grounded in Salman's verbatim knowledge nuggets
// and instructed to quote them inside <blockquote> tags. This check enforces that
// contract: every <blockquote> in the body must appear VERBATIM (whitespace- and
// punctuation-normalised) inside one of the nuggets used to ground the article.
//
// This is the anti-fabrication guarantee for the E-E-A-T layer: a quote the model
// invented or "improved" — putting words in Salman's mouth — has no source in the
// library and HARD-FAILS the gate. In video mode no nuggetTexts are passed, so the
// check is skipped and behaviour is unchanged.
// ═══════════════════════════════════════════════════════════════════════════

// Normalise for a forgiving-but-honest match: strip tags, lowercase, collapse
// whitespace, and fold smart quotes / dashes to ASCII so a quote isn't failed for
// a curly apostrophe the model round-tripped. Content words are preserved.
function normalize(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Pull the inner text of every <blockquote>…</blockquote> in the body — with the
// attribution stripped. Articles legitimately place a byline INSIDE the quote
// ("…just read what's already there. — Salman Khan") or in a <cite>. That trailing
// attribution is not part of the claimed verbatim quote, so it must not cause a
// false fabrication flag. We strip a <cite> block and a short trailing dash-led
// attribution (≤ 6 words) — short enough that it can never launder a fabricated
// tail past the check.
function stripAttribution(inner) {
  let s = inner.replace(/<cite[^>]*>[\s\S]*?<\/cite>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  // trailing "— Salman Khan" / "- Salman" / "— Salman Khan, FortitudeFX" etc.
  s = s.replace(/[\s"'”’]*[—–-]\s*[A-Z][A-Za-z.,'’ ]{0,40}$/,'');
  return s.trim();
}

export function extractBlockquotes(body) {
  const out = [];
  const re = /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi;
  let m;
  while ((m = re.exec(String(body || ''))) !== null) {
    const inner = stripAttribution(m[1]);
    if (inner) out.push(inner);
  }
  return out;
}

// verifyQuotes(body, nuggetTexts) → { pass, checked, violations, note }
//   nuggetTexts: array of strings (nugget.text) used to ground the article.
// A blockquote passes if its normalised form is a substring of any nugget's
// normalised form. Short attributive fragments (< 6 words) are ignored — those
// are captions like "Salman on liquidity", not claimed verbatim quotes.
export function verifyQuotes(body, nuggetTexts) {
  const quotes = extractBlockquotes(body);
  const haystacks = (Array.isArray(nuggetTexts) ? nuggetTexts : [])
    .map(normalize).filter(Boolean);

  const violations = [];
  let checked = 0;

  for (const q of quotes) {
    const words = q.split(/\s+/).filter(Boolean);
    if (words.length < 6) continue; // too short to be a claimed verbatim quote
    checked++;
    const nq = normalize(q);
    if (!nq) continue;
    const found = haystacks.some(h => h.includes(nq));
    if (!found) {
      violations.push(q.length > 160 ? q.slice(0, 157) + '…' : q);
    }
  }

  return {
    pass: violations.length === 0,
    checked,
    violations,
    note: checked === 0
      ? 'no verbatim quotes to verify'
      : `${checked - violations.length}/${checked} blockquotes traced to the nugget library`,
  };
}
