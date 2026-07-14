// ═══════════════════════════════════════════════════════════════════════════
// KEYWORD-MODE SOCIAL GENERATOR — one call, grounded in the finished article.
// X is the priority channel (optimized 6-tweet CONTRARIAN thread; tweet 5 carries
// the homepage CTA, tweet 6 the article deep-link). LinkedIn + Discord are lean
// hook-plus-link-back-to-blog traffic drivers, not article pastes. Shared by the
// consumer (at generation) and the keyword-run endpoint (social-only regen — fixes
// social WITHOUT regenerating the article, so the gate verdict is untouched).
// Returns { linkedin, discord, tweets:[6] }.
// ═══════════════════════════════════════════════════════════════════════════

export async function callKeywordPlatforms(article, targetQuery, blogUrl, apiKey, env) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  // Reuse the live voice-calibration corrections so social matches Salman's voice.
  let corrections = [];
  try {
    const cal = env && env.FFX_KV ? await env.FFX_KV.get('intelligence:voice_calibration', { type: 'json' }).catch(function(){ return null; }) : null;
    if (cal && Array.isArray(cal.corrections)) corrections = cal.corrections.slice(0, 6);
  } catch {}
  const voiceLine = corrections.length ? '\nVoice corrections (apply): ' + corrections.join(' · ') : '';

  const systemPrompt =
    'You are the social engine for FortitudeFX (fortitudefx.com), a forex trading education brand built on the Catch The Wick mechanical entry system. Write in Salman\'s voice: direct, calm, experienced, institutional, lightly contrarian. Never hype.' + voiceLine +
    '\n\nTRADEMARK: ONLY FortitudeFX, Catch The Wick, and 2 Candle. 1 Story. take the ™ symbol (first use). NEVER ™ generic terms — fair value gap, FVG, imbalance, order block, liquidity sweep — they are not trademarks.' +
    '\n\nABSOLUTELY BANNED — never start any tweet, line, or post with: "Most traders", "Many traders", "The reality is", "Here\'s the truth", "Trading is", "One thing I\'ve learned", "The market doesn\'t care".' +
    '\n\nHARD RULES: Do not invent statistics, win-rates, or returns. Ground everything in the article below. This is YMYL — never imply guaranteed profit.' +
    '\n\nTARGET KEYWORD: "' + targetQuery + '"    BLOG URL: ' + blogUrl +
    '\n\nReturn ONE valid JSON object, no preamble, exactly these keys:\n' +
    '{\n' +
    '  "x_thread": ["t1","t2","t3","t4","t5","t6"],\n' +
    '  "linkedin": "…",\n' +
    '  "discord": "…"\n' +
    '}\n\n' +
    'X THREAD — THE PRIORITY. Exactly 6 tweets, each ≤ 275 characters, each on its own idea, flowing as a thread:\n' +
    '- Tweet 1 = HOOK, CONTRARIAN + tension-driven. Open by challenging the common belief about "' + targetQuery + '" or naming how it is usually taught/traded wrong, then imply the fix — create a gap the reader NEEDS closed so they expand the thread. It must be specific and true to the article (never hype, never a fabricated stat). SHAPE examples (do not copy verbatim, adapt to the article): "Everyone trades ' + targetQuery + ' backwards." / "You were taught ' + targetQuery + ' wrong." / "' + targetQuery + ' isn\'t what your indicator says it is." / "Stop entering ' + targetQuery + ' the way you were shown." A trailing 🧵 is fine. No link, no hashtag. (Still obey the banned-openings list — do not start with "Most traders"/"Many traders".)\n' +
    '- Tweets 2–4 = one concrete teaching point each, building the method step by step (setup → trigger → entry → risk). Short lines, a line break where it helps. Self-contained but sequential. No links.\n' +
    '- Tweet 5 = one more concrete teaching point, THEN tie it to the FortitudeFX system and put the homepage on its own final line: https://fortitudefx.com — woven in naturally (the full framework/community lives there), never a bare ad. Still a genuine value tweet, not a promo.\n' +
    '- Tweet 6 = PAYOFF in one line, then on new lines "Full breakdown 👇" and the BLOG URL. At most ONE hashtag, here only.\n' +
    'Weave "' + targetQuery + '" in naturally (tweet 1 + at least one more). Plain text tweets.\n\n' +
    'LINKEDIN — lean traffic driver (150–230 words): a strong first-line hook, then 3–5 short insight lines teaching "' + targetQuery + '" the FFX way (NOT a paste of the article, NO HTML), then a final line "Full breakdown: ' + blogUrl + '". 2–3 relevant hashtags at the very end only.\n\n' +
    'DISCORD — casual community drop (50–100 words): share the single sharpest insight like you\'re dropping value in the server, then the blog link on its own line. Conversational, no hashtags.';

  const plainArticle = (article.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Article title: ' + (article.title || '') + '\n\nArticle:\n' + plainArticle }],
    }),
  });
  if (!res.ok) throw new Error('Anthropic platforms ' + res.status + ': ' + await res.text());
  const data = await res.json();
  const raw = (data.content && data.content[0] && data.content[0].text || '').trim();
  const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('No JSON in keyword platforms response');
  const parsed = JSON.parse(raw.slice(first, last + 1));
  const tweets = Array.isArray(parsed.x_thread) ? parsed.x_thread.filter(Boolean) : [];
  return { linkedin: parsed.linkedin || '', discord: parsed.discord || '', tweets };
}
