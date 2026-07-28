// ═══════════════════════════════════════════════════════════════════════════
// ENRICHMENT — generate additional sections for an EXISTING article
// ───────────────────────────────────────────────────────────────────────────
// Adds sections that answer measured long-tail queries the page does not yet
// cover, in Salman's voice, grounded in his own nuggets, then hands the merged
// body back for the SAME gate suite that governs new articles.
//
// Deliberately conservative about the existing body: it is already published,
// already indexed, and (for the consolidation survivors) already absorbing the
// signal of several merged pages. So the existing HTML is passed through
// BYTE-FOR-BYTE and new sections are appended. Nothing rewrites what ranks.
// ═══════════════════════════════════════════════════════════════════════════

const API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5';

// Where the article's own CTA/disclaimer begins, if the body carries one — new
// sections must land BEFORE it, never after the call to action.
function splitAtCta(html) {
  const markers = ['discord.gg/fortitudefx', 'Ready to trade with an edge', '<h2>Final', '<h2>Conclusion'];
  let idx = -1;
  for (const m of markers) {
    const i = html.indexOf(m);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx === -1) return [html, ''];
  const pStart = html.lastIndexOf('<', idx);
  const cut = pStart === -1 ? idx : pStart;
  return [html.slice(0, cut), html.slice(cut)];
}

export function buildEnrichPrompt(article, targets, nuggets) {
  const L = [];
  L.push('You are adding sections to an EXISTING published FortitudeFX article.');
  L.push('');
  L.push('ARTICLE TITLE: ' + (article.title || ''));
  L.push('');
  L.push('THE EXISTING ARTICLE (already live — you are NOT rewriting any of this):');
  L.push('"""');
  L.push(String(article.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000));
  L.push('"""');
  L.push('');
  L.push('YOUR JOB: write NEW sections answering these real searches the page does not');
  L.push('yet cover. One <h2> section per item, in this order:');
  L.push('');
  targets.forEach((t, i) => {
    L.push(`${i + 1}. "${t.keyword}"  (${t.volume}/mo)` +
      (t.aiAnswered ? '  — Google answers this inline; keep it SHORT and direct, 2-3 sentences.' : ''));
  });
  L.push('');
  if (nuggets && nuggets.length) {
    L.push("SALMAN'S OWN WORDS — his positions, from his videos. Teach what these say,");
    L.push('in his first-person voice, in your own sentences.');
    L.push('');
    nuggets.forEach((n, i) => { L.push('[NUGGET ' + (i + 1) + ']'); L.push(n.text); L.push(''); });
  } else {
    L.push('No source clips matched this topic. Write from the FortitudeFX method in');
    L.push("Salman's first-person voice.");
    L.push('');
  }
  // NO BLOCKQUOTES, deliberately. The first full run failed 6 of 10 pages on
  // [quotes] — the model was quoting nuggets but paraphrasing INSIDE the quote
  // marks, i.e. putting words in Salman's mouth he never said. Loosening quote
  // verification was never an option on a YMYL site. The articles being enriched
  // already carry his verbatim quotes; added sections do not need more, so the
  // failure mode is removed rather than tolerated.
  L.push('NEVER use <blockquote> tags. Do not quote Salman directly, even from the');
  L.push('nuggets above — reproducing them imperfectly would attribute words to him');
  L.push('that he did not say. Teach the idea in your own sentences instead.');
  L.push('');
  L.push('HARD RULES');
  L.push('- Do NOT repeat anything the existing article already says. Add, never restate.');
  L.push('- First person, direct, plain. Same voice as the article above.');
  L.push('- Invent NO statistics, win rates, backtest figures or results of any kind.');
  L.push('- No hype. Never "guaranteed", "risk-free", "secret", "easy money".');
  L.push('- Every section must genuinely answer its search query, not pad around it.');
  L.push('- Use the exact search phrasing naturally in the <h2> where it reads well.');
  L.push('- FortitudeFX™ and Catch The Wick™ keep their trademark symbols on first use.');
  L.push('');
  L.push('OUTPUT: raw HTML fragment only — <h2>/<p>/<ul>/<blockquote> only.');
  L.push('No markdown, no <html>, no commentary, no code fences. Sections only.');
  return L.join('\n');
}

export async function generateSections(article, targets, nuggets, apiKey, fetchImpl = fetch) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await fetchImpl(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: buildEnrichPrompt(article, targets, nuggets) }],
    }),
  });
  if (!res.ok) throw new Error('Claude ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  let html = ((data.content || []).find(c => c.type === 'text') || {}).text || '';
  html = html.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!html || html.indexOf('<h2') === -1) throw new Error('Model returned no usable sections');
  return html;
}

// ── SELF-REPETITION: shared 6-word phrases, not shared vocabulary ───────────
// TF-IDF cosine cannot judge this. New sections about liquidity sweeps share
// heavy vocabulary with an article about liquidity sweeps by definition — the
// first live run scored 0.62 purely for being on-topic, which is the entire
// point of enrichment.
//
// Literal restatement instead shows up as shared long PHRASES. Measured on the
// real corpus: the two 96%-identical articles shared 96% of their 6-grams, while
// genuinely distinct same-topic pages sat at 10-14%. That is a clean separation,
// so 0.30 sits safely between "covers the same subject" and "says the same thing".
export function phraseOverlap(a, b, n = 6) {
  const grams = t => {
    const w = String(t || '').replace(/<[^>]+>/g, ' ').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    const s = new Set();
    for (let i = 0; i + n <= w.length; i++) s.add(w.slice(i, i + n).join(' '));
    return s;
  };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / A.size;   // what share of the NEW text already exists in the old
}

// Existing body byte-for-byte + new sections, inserted before the CTA.
export function mergeSections(existingBody, newSections) {
  const [before, cta] = splitAtCta(String(existingBody || ''));
  return before + '\n' + newSections + '\n' + cta;
}
