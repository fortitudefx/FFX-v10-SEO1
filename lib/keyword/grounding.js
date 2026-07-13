// ═══════════════════════════════════════════════════════════════════════════
// KEYWORD SOURCE — nugget grounding (shared by ffx-cron and ffx-consumer)
// ───────────────────────────────────────────────────────────────────────────
// In keyword mode the article is NOT built from a video transcript. It is built
// around a target keyword (the demand) and grounded in Salman's own verbatim
// knowledge nuggets (the E-E-A-T layer). The nuggets are the substance the model
// must quote and cite — they are the proof this is a real trader's method and
// not a generic forex explainer. Every quoted passage is later verified against
// the library by the gate's quote-verify check; anything not traceable to a real
// nugget fails the gate and cannot publish.
// ═══════════════════════════════════════════════════════════════════════════

// Load the full nugget objects for a set of ids (text + provenance for citation).
export async function loadNuggetTexts(env, nuggetIds) {
  const ids = Array.isArray(nuggetIds) ? nuggetIds : [];
  const nuggets = (await Promise.all(
    ids.map(id => env.FFX_KV.get('nugget:' + id, { type: 'json' }).catch(() => null))
  )).filter(Boolean);
  return nuggets.map(n => ({
    id: n.id,
    text: (n.text || '').trim(),
    sourceTitle: n.sourceTitle || null,
    youtubeUrl: n.youtubeUrl || null,
    sourceVideoId: n.sourceVideoId || null,
    tags: n.tags || [],
  })).filter(n => n.text.length > 0);
}

// Build the grounding block passed to the model in place of a transcript.
// Numbered so the prompt can instruct verbatim quoting + citation by number.
export function buildGrounding(target, nuggets) {
  const kw = target.keyword || target.canonical || '';
  const prop = target.proprietary_term ? ` (FortitudeFX term: "${target.proprietary_term}")` : '';
  const lines = [];
  lines.push('TARGET KEYWORD (the demand this article must answer): "' + kw + '"' + prop);
  if (target.cluster) lines.push('Topic cluster: ' + target.cluster);
  lines.push('');
  if (!nuggets || !nuggets.length) {
    lines.push('No source clip exists for this topic yet. Write it from the FortitudeFX method');
    lines.push('in Salman\'s first-person voice. Do NOT use <blockquote> tags and do NOT invent');
    lines.push('a quote — teach the concept and how Catch The Wick treats it.');
    return lines.join('\n');
  }
  lines.push('SALMAN\'S KNOWLEDGE NUGGETS — these are his own words from his videos.');
  lines.push('You MUST build the article around them. Quote at least two of them VERBATIM');
  lines.push('inside <blockquote> tags, exactly as written (no paraphrasing inside the quote),');
  lines.push('and attribute each quote to Salman. Everything factual must trace to a nugget or');
  lines.push('to widely-known, verifiable market mechanics — invent no statistics, no results,');
  lines.push('no backtest numbers.');
  lines.push('');
  nuggets.forEach((n, i) => {
    lines.push('[NUGGET ' + (i + 1) + ']' + (n.sourceTitle ? ' (from: ' + n.sourceTitle + ')' : ''));
    lines.push(n.text);
    lines.push('');
  });
  return lines.join('\n');
}

// The keyword-mode article instruction appended to the system prompt. Keeps the
// existing voice/trademark/JSON-shape rules from callClaudeArticle intact; adds
// the demand-targeting + verbatim-quote + no-fabrication contract on top.
//   hasNuggets=false → the no-nugget path (Salman's Option C): still write it, in
//   his first-person voice, but with NO blockquotes and NO invented quotes —
//   there is nothing to quote, so quoting would be fabrication.
export function keywordArticleInstruction(target, hasNuggets = true) {
  const kw = target.keyword || target.canonical || '';
  const base = '\n\nSOURCE MODE: KEYWORD (demand-driven).\n'
    + '- This article targets the search query "' + kw + '". Use that exact phrase in the '
    + 'title, the opening, and at least one H2 — naturally, not stuffed.\n'
    + '- Teach the searched concept clearly enough that a trader who has never heard of it '
    + 'understands it, then show how FortitudeFX / Catch The Wick treats it'
    + (target.proprietary_term ? ' (its "' + target.proprietary_term + '")' : '') + '.\n'
    + '- Do NOT invent statistics, win-rates, backtest results, or specific numbers. If a '
    + 'figure is not in a nugget or a widely-known market fact, do not state it.\n'
    + '- NEVER present a specific return, R-multiple, win-rate, or percentage as a typical, '
    + 'expected, or promised outcome. If a nugget mentions a specific result Salman achieved, '
    + 'reference it ONLY as a specific past instance attributed to him (e.g. "Salman has taken '
    + 'a trade that ran to 40R") — never as what the reader will get ("you ride it for 40R"). '
    + 'Implying returns fails the quality gate on a YMYL page.\n'
    + '- BANNED OPENINGS are absolute and apply to the first word of EVERY sentence and '
    + 'paragraph in the whole article, not just the first line: never begin a sentence with '
    + '"Most traders", "Many traders", "The reality is", "Here\'s the truth", "Trading is".\n'
    + '- LENGTH: write to the substance the keyword and nuggets genuinely support — no more, '
    + 'no less. Ignore any specific word-count target mentioned above. Never pad, never repeat '
    + 'a point to look longer. A complete 800-word answer beats a padded 2000-word one.';
  if (hasNuggets) {
    return base
      + '\n- GROUND every claim in the supplied nuggets. Quote at least two nuggets VERBATIM in '
      + '<blockquote> tags and attribute them to Salman. Do NOT alter a single word inside a '
      + 'quote — the quotes are verified against the source library and any invented or edited '
      + 'quote fails the quality gate.';
  }
  return base
    + '\n- There is NO source clip for this topic yet. Write it in Salman\'s own first-person '
    + 'voice from the method itself. Do NOT use <blockquote> tags and do NOT fabricate a quote '
    + 'or attribute invented words to Salman — an unsourced quote fails the quality gate.';
}
