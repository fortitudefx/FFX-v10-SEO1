// ═══════════════════════════════════════════════════════════════════════════
// STRUCTURAL ROLES (FFX) — heading-role vocabulary for the structural fingerprint.
// ───────────────────────────────────────────────────────────────────────────
// The structural-diversity check canonicalises headings to ROLE tokens before
// comparing skeletons, so cosmetic heading-renaming ("Common Mistakes" vs "Where
// People Go Wrong") can't hide that two articles share the same skeleton — which is
// exactly how the ~8 "opening candle" near-duplicates read. Variants are tuned to
// the FFX corpus's actual heading patterns.
//
// This is intentionally the ONLY thing left here: the generation-side blueprint
// scaffolding (archetypes, TRUST_DIRECTIVE, prompt rendering) belongs to the forward-
// looking generation tracks, NOT to this gate, and FFX already enforces voice/
// structure preventively at generation. Kept minimal on purpose.
// ═══════════════════════════════════════════════════════════════════════════

// role token → substrings that identify that role in a (normalized) heading.
const ROLE_VARIANTS = {
  problem:      ['most traders', 'get it wrong', 'the mistake', 'breaks down', 'why you fail', 'why your', 'ignore', 'fails'],
  question:     ['what it actually is', 'the real question', 'what is', 'answering'],
  scene:        ['the trade that', 'a session', 'played out live', 'will not forget'],
  mechanics:    ['how it works', 'how to read', 'the mechanics', 'what is happening', 'the logic', 'the structure', 'the framework', 'the core concept', 'the foundation'],
  'real-trade': ['a real trade', 'real trade', 'i took', 'live example', 'walking through', 'what it looked like', 'the trade i', 'example', 'real scenario', 'practical application'],
  'why-it-works': ['why this works', 'why it works', 'holds up', 'institutions', 'institutional', 'the reason', 'why this approach'],
  mistakes:     ['go wrong', 'common mistake', 'blows this up', 'what to avoid', 'trap', 'mistakes to avoid'],
  risk:         ['managing the risk', 'risk management', 'where i get out', 'stop order', 'stop loss', 'protecting the account', 'invalidation', 'the risk', 'stop orders'],
  practice:     ['how to practise', 'how to practice', 'making it yours', 'putting it into', 'reps', 'backtest', 'how to practice this'],
  takeaway:     ['bottom line', 'what to remember', 'my honest take', 'final thought', 'the takeaway', 'final thoughts', 'the complete picture', 'join the', 'community'],
  timeframe:    ['timeframe', 'multi-timeframe', 'multiple timeframes', 'fractal', 'lower timeframe'],
  session:      ['london', 'new york', 'asian', 'session', 'killzone', 'before the session'],
};

// Map a normalized heading (topic terms already stripped to `_`) → canonical role
// token, or null if it matches no known role (then its own text is used, unchanged).
export function canonicalRole(normalizedHeading) {
  const s = ' ' + String(normalizedHeading) + ' ';
  for (const [role, variants] of Object.entries(ROLE_VARIANTS)) {
    for (const v of variants) {
      const vv = v.replace(/[^a-z0-9]+/g, ' ').trim();
      if (vv && s.includes(' ' + vv)) return role;
    }
  }
  return null;
}
