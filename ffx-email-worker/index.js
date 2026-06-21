// =============================================================================
// FFX Email Sequence Worker
// =============================================================================
// Runs daily at 7am Dubai time via Cloudflare Cron Trigger.
// For each contact in Brevo List 4:
//   - Calculates which day they are on based on FFX_JOINED_DATE
//   - Days 1-7: sends path-specific onboarding email
//   - Days 8+:  sends weekly framework email (01-20 cycling)
//   - Checks KV log before sending - never sends duplicates
//   - Logs every send to KV for dashboard visibility
//
// TEST MODE: GET /email-worker/preview?contact=email@example.com
//   - Sends preview to salmankhanfx@fortitudefx.com with [TEST] prefix
//   - Never writes to KV log
//   - Safe to call anytime
// =============================================================================

'use strict';

var BREVO_LIST_ID    = 4;
var SENDER_EMAIL     = 'salmankhanfx@fortitudefx.com';
var SENDER_NAME      = 'Salman | FortitudeFX';
var PREVIEW_EMAIL    = 'salmankhanfx@fortitudefx.com';
var APPROVAL_EMAIL   = 'salmankhanfx@fortitudefx.com';

// =============================================================================
// EMAIL TEMPLATE
// =============================================================================

function ffxEmail(opts) {
  var kickerText       = opts.kickerText       || '';
  var heroTitle        = opts.heroTitle         || '';
  var heroSubtitle     = opts.heroSubtitle      || '';
  var bodyHtml         = opts.bodyHtml          || '';
  var footerNote       = opts.footerNote        || 'You are receiving this as part of the FortitudeFX\u2122 community.';
  var ctaUrl           = opts.ctaUrl            || null;
  var ctaLabel         = opts.ctaLabel          || null;

  var ctaBlock = ctaUrl ? (
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;">' +
    '<tr><td style="border-radius:999px;background-color:#e06b1a;">' +
    '<a href="' + ctaUrl + '" target="_blank" style="display:inline-block;padding:12px 28px;font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:0.02em;">' + ctaLabel + ' &#8594;</a>' +
    '</td></tr></table>'
  ) : '';

  return '<!DOCTYPE html><html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head>' +
    '<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>' +
    '<meta http-equiv="X-UA-Compatible" content="IE=edge"/>' +
    '<meta name="color-scheme" content="light"/><title>FortitudeFX</title></head>' +
    '<body style="margin:0;padding:0;background-color:#f0f0f4;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f0f0f4;">' +
    '<tr><td align="center" style="padding:40px 16px;">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;border-radius:14px;overflow:hidden;border:1px solid rgba(201,168,76,0.30);">' +

    // Gradient strip
    '<tr><td style="height:7px;background:linear-gradient(90deg,#C9A84C 0%,#e06b1a 100%);font-size:0;line-height:0;">&nbsp;</td></tr>' +

    // Dark hero header
    '<tr><td style="background-color:#0a0a12;padding:28px 40px 24px;border-bottom:1px solid rgba(201,168,76,0.20);">' +

    // Logo row
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;"><tr><td>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="vertical-align:middle;padding-right:10px;">' +
    '<a href="https://fortitudefx.com" target="_blank" style="text-decoration:none;display:block;">' +
    '<img src="https://fortitudefx.com/favicon-192x192.png" alt="FFX" width="48" height="48" style="display:block;border-radius:9px;border:1px solid rgba(201,168,76,0.50);"/></a></td>' +
    '<td style="vertical-align:middle;">' +
    '<a href="https://fortitudefx.com" target="_blank" style="text-decoration:none;"><p style="margin:0;font-family:Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.14em;color:#ffffff;">FORTITUDEFX&#8482;</p></a>' +
    '<a href="https://fortitudefx.com" target="_blank" style="text-decoration:none;"><p style="margin:3px 0 0;font-family:Arial,sans-serif;font-size:10px;color:rgba(255,255,255,0.40);letter-spacing:0.07em;">CATCH THE WICK&#8482;</p></a>' +
    '</td></tr></table></td></tr></table>' +

    // Hero content row
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:22px;"><tr>' +
    '<td style="vertical-align:middle;padding-right:20px;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;"><tr>' +
    '<td style="background:rgba(201,168,76,0.12);border:1px solid rgba(201,168,76,0.32);border-radius:999px;padding:4px 14px;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="vertical-align:middle;padding-right:7px;"><div style="width:6px;height:6px;border-radius:50%;background:#C9A84C;"></div></td>' +
    '<td style="vertical-align:middle;"><p style="margin:0;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.10em;color:rgba(255,255,255,0.70);">' + kickerText + '</p></td>' +
    '</tr></table></td></tr></table>' +
    '<p style="margin:0 0 4px;font-family:Georgia,serif;font-size:26px;font-weight:700;color:#ffffff;line-height:1.15;">' + heroTitle + '</p>' +
    '<p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:rgba(255,255,255,0.45);line-height:1.6;">' + heroSubtitle + '</p>' +
    '</td>' +
    '<td style="vertical-align:middle;text-align:right;white-space:nowrap;">' +
    '<a href="https://fortitudefx.com" target="_blank" style="text-decoration:none;">' +
    '<p style="margin:0;font-family:Georgia,serif;font-size:32px;font-weight:900;color:#ffffff;line-height:1.05;letter-spacing:-0.01em;">2 Candles.</p>' +
    '<p style="margin:0;font-family:Georgia,serif;font-size:32px;font-weight:900;color:#e06b1a;line-height:1.05;letter-spacing:-0.01em;">1 Story.<span style="font-size:16px;vertical-align:super;line-height:0;">&#8482;</span></p>' +
    '</a></td></tr></table>' +

    // Social icons
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="padding-right:10px;"><a href="https://www.youtube.com/@FortitudeFX" target="_blank" style="display:block;width:38px;height:38px;background:rgba(255,255,255,0.09);border:1px solid rgba(255,255,255,0.18);border-radius:9px;text-decoration:none;text-align:center;line-height:38px;"><img src="https://fortitudefx.com/email-icon-youtube.png" width="20" height="20" alt="YouTube" style="display:inline-block;vertical-align:middle;"/></a></td>' +
    '<td style="padding-right:10px;"><a href="https://instagram.com/fortitudefx_official" target="_blank" style="display:block;width:38px;height:38px;background:rgba(255,255,255,0.09);border:1px solid rgba(255,255,255,0.18);border-radius:9px;text-decoration:none;text-align:center;line-height:38px;"><img src="https://fortitudefx.com/email-icon-instagram.png" width="20" height="20" alt="Instagram" style="display:inline-block;vertical-align:middle;"/></a></td>' +
    '<td style="padding-right:10px;"><a href="https://tiktok.com/@fortitudefx_official" target="_blank" style="display:block;width:38px;height:38px;background:rgba(255,255,255,0.09);border:1px solid rgba(255,255,255,0.18);border-radius:9px;text-decoration:none;text-align:center;line-height:38px;"><img src="https://fortitudefx.com/email-icon-tiktok.png" width="20" height="20" alt="TikTok" style="display:inline-block;vertical-align:middle;"/></a></td>' +
    '<td><a href="https://x.com/_fortitudefx" target="_blank" style="display:block;width:38px;height:38px;background:rgba(255,255,255,0.09);border:1px solid rgba(255,255,255,0.18);border-radius:9px;text-decoration:none;text-align:center;line-height:38px;"><img src="https://fortitudefx.com/email-icon-x.png" width="18" height="18" alt="X" style="display:inline-block;vertical-align:middle;"/></a></td>' +
    '</tr></table>' +
    '</td></tr>' +

    // White body
    '<tr><td style="background-color:#ffffff;padding:32px 40px 8px;">' +
    bodyHtml +
    ctaBlock +
    '</td></tr>' +

    // Sign off
    '<tr><td style="background-color:#ffffff;padding:0 40px 32px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;"><tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr></table>' +
    '<p style="margin:0 0 2px;font-family:Arial,sans-serif;font-size:15px;color:#1a1a2e;font-weight:600;">&#8212; Salman</p>' +
    '<p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#9999aa;">FortitudeFX&#8482;</p>' +
    '</td></tr>' +

    // Footer
    '<tr><td style="background-color:#f8f8fb;padding:18px 40px;border-top:1px solid #f0f0f4;">' +
    '<p style="margin:0 0 5px;font-family:Arial,sans-serif;font-size:11px;color:#aaaabc;line-height:1.6;">' + footerNote + '</p>' +
    '<p style="margin:0;font-family:Arial,sans-serif;font-size:11px;color:#aaaabc;">&copy; 2026 FortitudeFX&#8482;. Dubai, UAE. &nbsp;&middot;&nbsp; <a href="https://fortitudefx.com/privacy" style="color:#C9A84C;text-decoration:none;">Privacy Policy</a></p>' +
    '</td></tr>' +

    '</table></td></tr></table></body></html>';
}

// =============================================================================
// BODY HTML HELPER
// =============================================================================

function bodyP(text) {
  return '<p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">' + text + '</p>';
}
function bodyStrong(text) {
  return '<strong style="color:#1a1a2e;">' + text + '</strong>';
}
function bodyQuote(quote, attr) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;"><tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr></table>' +
    '<p style="margin:0 0 4px;font-family:Georgia,serif;font-size:15px;font-style:italic;color:#1a1a2e;line-height:1.65;">&ldquo;' + quote + '&rdquo;</p>' +
    '<p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:12px;color:#9999aa;letter-spacing:0.04em;">&mdash; ' + attr + '</p>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:8px;"><tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr></table>';
}
function bodyHi(name) {
  return '<p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:16px;font-weight:700;color:#1a1a2e;">Hi ' + name + ',</p>';
}
function bodyDivider() {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;"><tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr></table>';
}

// =============================================================================
// EMAIL CONTENT — FREE SEQUENCE (Days 1-7)
// =============================================================================

function getFreeEmail(day, firstName) {
  var emails = {
    1: {
      subject:     'Day 1/7 \u2014 One question before anything else.',
      kickerText:  'SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'Let\u2019s start here.',
      heroSubtitle:'Seven Days Inside the Framework\u2122',
      body: bodyHi(firstName) +
        bodyP('Over the next 7 days I\u2019m going to walk you through the Catch The Wick\u2122 framework \u2014 not as a course, not as a lecture, but as a conversation. One idea per day. Under 3 minutes to read.') +
        bodyP('Today\u2019s question is the most important one I ask every trader who joins this community:') +
        bodyP(bodyStrong('When you enter a trade, what are you actually waiting for?')) +
        bodyP('Most traders can\u2019t answer that cleanly. They say things like \u201ca good setup\u201d or \u201cwhen it looks right.\u201d That\u2019s not an answer. That\u2019s a feeling \u2014 and feelings get destroyed the moment the market puts pressure on your position.') +
        bodyP('The Catch The Wick\u2122 framework answers that question with precision. You are waiting for two things: a liquidity sweep, and a candle that confirms intent. That\u2019s it. When both are present \u2014 you act. When they\u2019re not \u2014 you don\u2019t.') +
        bodyP('Everything we do for the next 7 days builds on that answer.') +
        bodyP('Tomorrow: what a liquidity sweep actually is and why it matters more than any indicator you\u2019ve ever used.') +
        bodyQuote('Clarity before the trade is the trade.', 'Salman, FortitudeFX\u2122')
    },
    2: {
      subject:     'Day 2/7 \u2014 The market runs a script. Here it is.',
      kickerText:  'SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'The script never changes.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 Day 2 of 7',
      body: bodyHi(firstName) +
        bodyP('Every session. Every pair. Every timeframe.') +
        bodyP('Institutions need to fill large orders. To do that they need liquidity \u2014 which means they need retail traders to have their stop losses sitting at obvious levels. They push price into those stops, trigger them, and fill their own orders in the process. Then price reverses.') +
        bodyP('That push into the stops \u2014 that\u2019s the wick. The reversal after \u2014 that\u2019s the candle you\u2019re trading.') +
        bodyP('The market runs this script constantly. It ran it this morning in London. It\u2019ll run it again in New York. And tomorrow.') +
        bodyP('The only question is whether you recognise it when it happens \u2014 or whether you\u2019re the retail trader whose stop just got taken.') +
        bodyP('Tomorrow: how to read the two candles that tell the whole story.') +
        bodyQuote('Stop losses don\u2019t protect retail traders. They feed institutional orders. Know who\u2019s on the other side.', 'Salman, FortitudeFX\u2122')
    },
    3: {
      subject:     'Day 3/7 \u2014 Two candles. One story.',
      kickerText:  'SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'Two candles. One story.\u2122',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 Day 3 of 7',
      body: bodyHi(firstName) +
        bodyP('This is the core of everything.') +
        bodyP(bodyStrong('Candle 1') + ' sets the narrative. It\u2019s the candle that sweeps the liquidity \u2014 the wick that goes beyond the obvious level and comes back. It\u2019s telling you where institutions were active.') +
        bodyP(bodyStrong('Candle 2') + ' confirms intent. It\u2019s the candle that closes in the direction institutions are now pushing. It has orderflow confirmation \u2014 body closes, momentum locked in, direction clear.') +
        bodyP('You enter on Candle 2. Not before. Not after.') +
        bodyP('No indicators. No divergence. No RSI. Just two candles and the story they tell together.') +
        bodyP('Most traders watch hundreds of candles and see nothing. Once you see this pattern, you can\u2019t unsee it.') +
        bodyP('Tomorrow: why you only need two hours per day to trade this framework.') +
        bodyQuote('The candle before the move is always more important than the move itself.', 'Salman, FortitudeFX\u2122')
    },
    4: {
      subject:     'Day 4/7 \u2014 The two-hour rule.',
      kickerText:  'SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'Two hours. Then you\u2019re done.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 Day 4 of 7',
      body: bodyHi(firstName) +
        bodyP('Trading should not be a full-time job unless you want it to be.') +
        bodyP('The London session opens. The most significant institutional activity of the day happens in the first two hours after the open. That\u2019s your window. You apply the Catch The Wick\u2122 framework during that window. Either the setup appears and you execute, or it doesn\u2019t and you close the platform.') +
        bodyP('Two hours. Then you\u2019re done.') +
        bodyP('More screen time equals more emotional decisions. You get bored and enter setups that aren\u2019t there. You overtrade because you\u2019re sitting in front of a chart looking for something to do.') +
        bodyP('Two focused hours beats eight distracted hours. The setup doesn\u2019t care how long you\u2019ve been watching. It either appears or it doesn\u2019t.') +
        bodyP('Tomorrow: why your previous strategy probably wasn\u2019t wrong, just incomplete.') +
        bodyQuote('Screen time is not edge. Focus is. Two hours of the right attention beats eight hours of the wrong kind.', 'Salman, FortitudeFX\u2122')
    },
    5: {
      subject:     'Day 5/7 \u2014 It wasn\u2019t the strategy. It was the trigger.',
      kickerText:  'SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'The gap between knowing and executing.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 Day 5 of 7',
      body: bodyHi(firstName) +
        bodyP('Most traders who join FortitudeFX\u2122 already understand liquidity. They\u2019ve heard of order flow. They know what supply and demand zones are.') +
        bodyP('The problem was never knowledge.') +
        bodyP('The problem was the trigger \u2014 the exact moment to act. Without a mechanical trigger, knowledge stays theory. You see a setup, it \u201clooks good,\u201d you enter \u2014 and the moment price moves against you you start to doubt.') +
        bodyP('The Catch The Wick\u2122 framework gives you the trigger. The wick sweep is the event. The Candle 2 close is the confirmation. The entry is the rule.') +
        bodyP('Either the rule is met or it isn\u2019t. There is no grey area. That\u2019s what removes the hesitation.') +
        bodyP('Tomorrow: one honest question to ask yourself.') +
        bodyQuote('Knowledge without a trigger is just expensive theory. The framework is the trigger.', 'Salman, FortitudeFX\u2122')
    },
    6: {
      subject:     'Day 6/7 \u2014 Are you a trader or a gambler?',
      kickerText:  'SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'One honest question.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 Day 6 of 7',
      body: bodyHi(firstName) +
        bodyP('Look at your last 5 trades.') +
        bodyP('For each one, write down in one sentence why you entered. Not what you were thinking \u2014 exactly what rule was met that justified the entry.') +
        bodyP('If you can write a clean mechanical reason for each \u2014 a sweep happened, Candle 2 confirmed, I entered \u2014 you\u2019re trading. If the reason is \u201cit looked like it was going up\u201d \u2014 you\u2019re gambling.') +
        bodyP('The difference between the two is not the outcome. You can gamble your way to a winning trade. The difference is the process. A consistent process, applied over hundreds of trades, is what produces consistent results.') +
        bodyP('Tomorrow is Day 7 \u2014 and I want to tell you what comes next.') +
        bodyQuote('A losing trade with the right process is a tuition fee. A winning trade with no process is a trap.', 'Salman, FortitudeFX\u2122')
    },
    7: {
      subject:     'Day 7/7 \u2014 The framework doesn\u2019t expire.',
      kickerText:  'SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'Seven days in.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 Day 7 of 7',
      body: bodyHi(firstName) +
        bodyP('You\u2019ve made it through 7 days. Most people who join a free community read the welcome email and disappear. You didn\u2019t.') +
        bodyP('The Catch The Wick\u2122 framework works on any pair, any session, any timeframe. It\u2019s not a signal. It\u2019s a reading of institutional behaviour \u2014 and institutions never stop sweeping liquidity. Which means the framework applies today, next year, and 20 years from now.') +
        bodyP('What you do with that is up to you.') +
        bodyP('The free community is always here. If you want to go deeper, the VIP Discord is where that happens. Smaller, more focused, with direct access and a monthly live call. The Bootcamp is where I teach it personally, live, from the ground up.') +
        bodyP('No pressure. The door stays open.') +
        bodyP('Whatever you do \u2014 trade the rule, not the feeling.') +
        bodyQuote('The framework is yours now. The only variable left is your commitment to it.', 'Salman, FortitudeFX\u2122'),
      ctaUrl:   'https://fortitudefx.com/vipdiscord',
      ctaLabel: 'Explore VIP Discord'
    }
  };
  return emails[day] || null;
}

// =============================================================================
// EMAIL CONTENT — VIP SEQUENCE (Days 1-7)
// =============================================================================

function getVIPEmail(day, firstName) {
  var emails = {
    1: {
      subject:     'Day 1/7 \u2014 You\u2019re on the list. Here\u2019s what that means.',
      kickerText:  'FOUNDING 100 \u00b7 SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'You made the right call.',
      heroSubtitle:'VIP Discord \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('Your spot is reserved. No payment taken. No pressure. Just your name on a list that closes at 100.') +
        bodyP('The VIP Discord is not a signal group. There are no \u201cbuy here, sell here\u201d alerts. What there is \u2014 is a direct line to the Catch The Wick\u2122 framework in real time. Live calls. Monthly coffee chats. Post-session markups. 1-on-1 sessions when you need them.') +
        bodyP('You\u2019re not joining a service. You\u2019re joining a framework \u2014 and the community that applies it daily.') +
        bodyP('Tomorrow: the one question every serious trader needs to be able to answer before they enter any trade.') +
        bodyQuote('Joining a community is easy. Becoming part of one takes intention. You\u2019ve shown the intention \u2014 now let\u2019s build the rest.', 'Salman, FortitudeFX\u2122')
    },
    2: {
      subject:     'Day 2/7 \u2014 What the market is actually doing every session.',
      kickerText:  'FOUNDING 100 \u00b7 SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'The script never changes.',
      heroSubtitle:'VIP Discord \u00b7 Day 2 of 7',
      body: bodyHi(firstName) +
        bodyP('Every session. Every pair. Every timeframe.') +
        bodyP('Institutions need to fill large orders. They push price into obvious stop loss levels, trigger retail traders out, fill their own orders at those prices. Then price reverses.') +
        bodyP('That push into stops \u2014 that\u2019s the wick. The reversal \u2014 that\u2019s the candle you\u2019re trading.') +
        bodyP('Inside the VIP Discord you\u2019ll see this script called out in real time \u2014 before it happens, as it happens, and with a full markup after the session closes. That\u2019s the difference between understanding a concept and watching it execute live.') +
        bodyP('Tomorrow: two candles that tell the whole story.') +
        bodyQuote('Stop losses don\u2019t protect retail traders. They feed institutional orders. Know who\u2019s on the other side.', 'Salman, FortitudeFX\u2122')
    },
    3: {
      subject:     'Day 3/7 \u2014 The two candles you\u2019ve been missing.',
      kickerText:  'FOUNDING 100 \u00b7 SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'Two candles. One story.\u2122',
      heroSubtitle:'VIP Discord \u00b7 Day 3 of 7',
      body: bodyHi(firstName) +
        bodyP(bodyStrong('Candle 1') + ' sweeps the liquidity. The wick goes beyond the obvious level and comes back \u2014 telling you where institutions were active.') +
        bodyP(bodyStrong('Candle 2') + ' confirms intent. Body closes, momentum locked, direction clear.') +
        bodyP('You enter on Candle 2. Not before. Not after.') +
        bodyP('Inside the VIP Discord you watch this applied to real markets in real time \u2014 not hypothetically, not in backtests, but in the session that just ran. That\u2019s the value of being inside a room with someone who reads this daily.') +
        bodyP('Tomorrow: how the VIP Discord fits into your trading day without consuming it.') +
        bodyQuote('The candle before the move is always more important than the move itself.', 'Salman, FortitudeFX\u2122')
    },
    4: {
      subject:     'Day 4/7 \u2014 What your trading day looks like inside the VIP.',
      kickerText:  'FOUNDING 100 \u00b7 SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'Two hours. Then you\u2019re done.',
      heroSubtitle:'VIP Discord \u00b7 Day 4 of 7',
      body: bodyHi(firstName) +
        bodyP('Here\u2019s what a typical day looks like inside the VIP Discord:') +
        bodyP(bodyStrong('Pre-session') + ' \u2014 I post the key levels and what I\u2019m watching before London opens.') +
        bodyP(bodyStrong('During session') + ' \u2014 Live presence, real-time commentary if a setup appears.') +
        bodyP(bodyStrong('Post-session') + ' \u2014 A full markup of what happened, why, and what the framework said at each moment.') +
        bodyP(bodyStrong('Weekly') + ' \u2014 A live community call. Price action, trade journals, Q&A, recorded.') +
        bodyP(bodyStrong('Monthly') + ' \u2014 A coffee chat. No agenda. Just a conversation.') +
        bodyP('Two hours of your morning. The rest of your day is yours.') +
        bodyQuote('Screen time is not edge. Focus is. Two hours of clarity beats eight hours of noise every time.', 'Salman, FortitudeFX\u2122')
    },
    5: {
      subject:     'Day 5/7 \u2014 The one thing separating you from consistent execution.',
      kickerText:  'FOUNDING 100 \u00b7 SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'The trigger changes everything.',
      heroSubtitle:'VIP Discord \u00b7 Day 5 of 7',
      body: bodyHi(firstName) +
        bodyP('You already know about liquidity. Order flow. Supply and demand. The problem was never knowledge. It was the trigger.') +
        bodyP('Without a mechanical trigger, knowledge stays theory. You see a setup, it \u201clooks good,\u201d you enter. The moment price moves against you, the doubt starts.') +
        bodyP('The Catch The Wick\u2122 framework gives you the trigger. Inside the VIP Discord you watch that trigger play out on live charts, with live commentary, in real time. There\u2019s a difference between reading about it and watching someone apply it with money on the line.') +
        bodyP('That\u2019s what you\u2019re joining.') +
        bodyQuote('Knowledge without a trigger is just expensive theory. The framework is the trigger.', 'Salman, FortitudeFX\u2122')
    },
    6: {
      subject:     'Day 6/7 \u2014 Before launch day, answer this.',
      kickerText:  'FOUNDING 100 \u00b7 SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'One question before you\u2019re inside.',
      heroSubtitle:'VIP Discord \u00b7 Day 6 of 7',
      body: bodyHi(firstName) +
        bodyP('Before the doors open, sit with one question:') +
        bodyP(bodyStrong('What does success inside the VIP Discord look like for you in 90 days?')) +
        bodyP('Not in terms of profit. In terms of process. Can you enter a trade and explain in one sentence, mechanically, why you entered? Can you sit on your hands when the setup isn\u2019t there?') +
        bodyP('Write that answer down. We\u2019ll come back to it.') +
        bodyP('The founding 100 members are not joining a Discord server. They\u2019re committing to a process. When the doors open, your spot is ready.') +
        bodyQuote('Success in trading is not a destination. It\u2019s a daily decision to follow the process even when it\u2019s uncomfortable.', 'Salman, FortitudeFX\u2122')
    },
    7: {
      subject:     'Day 7/7 \u2014 Almost time.',
      kickerText:  'FOUNDING 100 \u00b7 SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'You\u2019re ready.',
      heroSubtitle:'VIP Discord \u00b7 Day 7 of 7',
      body: bodyHi(firstName) +
        bodyP('Seven days. You\u2019ve been with this framework for a week before the doors even opened.') +
        bodyP('When launch day comes you\u2019ll receive a direct email with everything you need to activate your membership. Your price is locked at $75/month for as long as you stay. That rate doesn\u2019t change regardless of what we charge in the future.') +
        bodyP('The founding 100 closes when it\u2019s full. Not when a deadline passes \u2014 when the last spot goes.') +
        bodyP('In the meantime \u2014 the free Discord is open. Get familiar with the framework before you\u2019re inside the VIP.') +
        bodyQuote('The traders who win consistently are not the ones who find the best strategy. They\u2019re the ones who commit to one strategy long enough to master it.', 'Salman, FortitudeFX\u2122'),
      ctaUrl:   'https://discord.com/invite/fWAPJdR8TR',
      ctaLabel: 'Join the Free Discord'
    }
  };
  return emails[day] || null;
}

// =============================================================================
// EMAIL CONTENT — BOOTCAMP SEQUENCE (Days 1-7)
// =============================================================================

function getBootcampEmail(day, firstName) {
  var emails = {
    1: {
      subject:     'Day 1/7 \u2014 Your Bootcamp spot is reserved. Here\u2019s what to expect.',
      kickerText:  'CATCH THE WICK\u2122 BOOTCAMP \u00b7 SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'Four weeks. Starting soon.',
      heroSubtitle:'Catch The Wick\u2122 Bootcamp \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('Your spot is secured. No payment taken yet. When the Bootcamp opens, you\u2019ll receive everything you need to begin.') +
        bodyP('Four weeks. Three live sessions per week. One and a half to two hours each. I teach every session personally \u2014 no pre-recorded content, no assistant instructors. If I\u2019m in the session, I\u2019m present.') +
        bodyP('The goal is to take you from wherever you are now to a point where you can look at any chart, on any pair, in any session, and know \u2014 based on rules, not feelings \u2014 whether a Catch The Wick\u2122 setup is present or not.') +
        bodyP('That\u2019s a learnable skill. And four weeks is enough time to build it, if you show up.') +
        bodyP('Tomorrow: the foundation everything else is built on.') +
        bodyQuote('Learning a framework is not about memorising rules. It\u2019s about building a new way of seeing the market.', 'Salman, FortitudeFX\u2122')
    },
    2: {
      subject:     'Day 2/7 \u2014 The one thing you need to understand before Week 1.',
      kickerText:  'CATCH THE WICK\u2122 BOOTCAMP \u00b7 SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'What the market is doing every session.',
      heroSubtitle:'Bootcamp Prep \u00b7 Day 2 of 7',
      body: bodyHi(firstName) +
        bodyP('Before Week 1 begins, there is one concept I want embedded in your mind.') +
        bodyP('Institutions need to fill large orders. They manipulate price to create the liquidity they need. They push into obvious stop loss levels, trigger retail traders out, fill their own orders, then price reverses.') +
        bodyP('That push into stops \u2014 that\u2019s the wick. The candle after \u2014 that\u2019s the move.') +
        bodyP('This happens every single session, on every liquid pair, at every significant level. It\u2019s been happening for decades and it will keep happening because it\u2019s built into how large order execution works.') +
        bodyP('This week \u2014 watch the London session. Watch the wicks. Start asking: who benefited from that move?') +
        bodyQuote('Before you can trade the market, you need to understand what the market actually is. It\u2019s not a voting machine. It\u2019s an order filling mechanism.', 'Salman, FortitudeFX\u2122')
    },
    3: {
      subject:     'Day 3/7 \u2014 The framework in one paragraph.',
      kickerText:  'CATCH THE WICK\u2122 BOOTCAMP \u00b7 SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'Two candles. One story.\u2122',
      heroSubtitle:'Bootcamp Prep \u00b7 Day 3 of 7',
      body: bodyHi(firstName) +
        bodyP('Here is the Catch The Wick\u2122 framework in one paragraph:') +
        bodyP('<em>Price sweeps a significant liquidity level \u2014 the wick of the first candle takes out obvious stops. The second candle closes in the direction of the reversal with orderflow confirmation. You enter on the second candle. You know your invalidation before you enter. You take your profit at the next significant level.</em>') +
        bodyP('That\u2019s it. Everything in the Bootcamp \u2014 all five entry models, all the session analysis, all the live trading \u2014 is built on that paragraph.') +
        bodyP('Read it again tomorrow morning before you check the charts.') +
        bodyQuote('Simplicity is the hardest thing to achieve in trading. Most traders complicate because they don\u2019t trust the simple answer. The simple answer is usually right.', 'Salman, FortitudeFX\u2122')
    },
    4: {
      subject:     'Day 4/7 \u2014 What Week 1 looks like.',
      kickerText:  'CATCH THE WICK\u2122 BOOTCAMP \u00b7 SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'Here\u2019s what to expect in Week 1.',
      heroSubtitle:'Bootcamp Prep \u00b7 Day 4 of 7',
      body: bodyHi(firstName) +
        bodyP('Week 1 is foundation week. We build the mental model from scratch.') +
        bodyP(bodyStrong('Session 1') + ' \u2014 The institutional model. Why the market moves the way it does. No indicators. Just price and intent.') +
        bodyP(bodyStrong('Session 2') + ' \u2014 Liquidity and structure. What levels matter, why they matter, and how institutions use them.') +
        bodyP(bodyStrong('Session 3') + ' \u2014 The first entry model. Live chart walk-throughs. Real examples. Q&A.') +
        bodyP('Every session is recorded. But show up live \u2014 the Q&A at the end of each session is where the real learning happens.') +
        bodyP('Come with questions. This isn\u2019t a lecture \u2014 it\u2019s a workshop.') +
        bodyQuote('The best traders I\u2019ve seen are not the most talented. They\u2019re the most consistent in showing up and doing the work.', 'Salman, FortitudeFX\u2122')
    },
    5: {
      subject:     'Day 5/7 \u2014 What to do before Week 1 begins.',
      kickerText:  'CATCH THE WICK\u2122 BOOTCAMP \u00b7 SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'Your pre-Bootcamp checklist.',
      heroSubtitle:'Bootcamp Prep \u00b7 Day 5 of 7',
      body: bodyHi(firstName) +
        bodyP('Before Week 1 begins, three things that will make the Bootcamp significantly more valuable:') +
        bodyP(bodyStrong('1. Join the free Discord and read the Road Map.') + ' It\u2019s the foundation document for the framework. Read it once so the terminology isn\u2019t new when we hit Week 1.') +
        bodyP(bodyStrong('2. Watch one London session this week \u2014 without trading it.') + ' Just observe. Watch the wicks form. Watch what happens after significant levels are swept. You don\u2019t need to understand it fully yet \u2014 just start building the visual pattern.') +
        bodyP(bodyStrong('3. Write down your biggest trading problem right now.') + ' One sentence. Bring it to Session 1. That\u2019s where we start.') +
        bodyQuote('Preparation is not about knowing everything before you start. It\u2019s about knowing enough to ask the right questions when it matters.', 'Salman, FortitudeFX\u2122'),
      ctaUrl:   'https://discord.com/invite/fWAPJdR8TR',
      ctaLabel: 'Join the Free Discord'
    },
    6: {
      subject:     'Day 6/7 \u2014 The one thing that separates Bootcamp graduates who execute from those who don\u2019t.',
      kickerText:  'CATCH THE WICK\u2122 BOOTCAMP \u00b7 SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'The difference is not talent.',
      heroSubtitle:'Bootcamp Prep \u00b7 Day 6 of 7',
      body: bodyHi(firstName) +
        bodyP('I\u2019ve taught this framework to a lot of traders. The ones who come out executing consistently have one thing in common \u2014 they trusted the process even when it felt uncomfortable.') +
        bodyP('The traders who struggle: they learn the framework, understand it, can explain it \u2014 and then in live market conditions, with money on the line, they revert to what felt right before the Bootcamp.') +
        bodyP('The framework will feel mechanical and sometimes counterintuitive. That\u2019s the point. Mechanical means the emotion doesn\u2019t get a vote.') +
        bodyP('Your job over four weeks is not just to learn the rules. It\u2019s to build enough trust in the rules that you follow them when the market is moving and your instinct is telling you something different.') +
        bodyQuote('Trust the process before the process trusts you with results.', 'Salman, FortitudeFX\u2122')
    },
    7: {
      subject:     'Day 7/7 \u2014 Week 1 is coming. You\u2019re ready.',
      kickerText:  'CATCH THE WICK\u2122 BOOTCAMP \u00b7 SEVEN DAYS INSIDE THE FRAMEWORK\u2122',
      heroTitle:   'See you in Week 1.',
      heroSubtitle:'Catch The Wick\u2122 Bootcamp \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('Seven days of preparation. You\u2019ve been thinking about this framework for a week before the first session even starts. That matters.') +
        bodyP('When launch day comes you\u2019ll receive a direct email with the session schedule and everything you need for Week 1. Your price is locked at $75/month as a founding member \u2014 that rate stays with you as long as your membership continues.') +
        bodyP('Four weeks. Three sessions per week. I\u2019ll be in every single one.') +
        bodyP('Come ready to work, come ready to ask questions, and come ready to trust a process that removes hesitation from your trading completely.') +
        bodyQuote('The traders who change are the ones who decide before they start that they will finish. Decide that now.', 'Salman, FortitudeFX\u2122'),
      ctaUrl:   'https://discord.com/invite/fWAPJdR8TR',
      ctaLabel: 'Join the Free Discord'
    }
  };
  return emails[day] || null;
}

// =============================================================================
// EMAIL CONTENT — FRAMEWORK SERIES (Days 8+ cycling 1-20)
// =============================================================================

function getFrameworkEmail(emailNum, firstName) {
  var emails = {
    1: {
      subject:     'Not all wicks are sweeps.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 01/20',
      heroTitle:   'What a liquidity sweep actually looks like.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('Most traders look at a wick and think: volatility. Noise. Someone got stopped out.') +
        bodyP('That\u2019s partly right. Someone did get stopped out. That\u2019s the point.') +
        bodyP('A liquidity sweep is a specific event. Price extends beyond a significant level \u2014 a previous high, a previous low, a round number \u2014 takes out the stops sitting there, and then comes back. The wick is the evidence. The return is the tell.') +
        bodyP('Not every wick is a sweep. A wick into open space with no obvious stops is just price moving. A wick that precisely tags a significant level and reverses is institutional order filling.') +
        bodyP('This week \u2014 pull up any chart. Mark the significant highs and lows from the previous session. Watch what happens when price approaches them. You\u2019ll start seeing it everywhere.') +
        bodyQuote('The wick is not a mistake. It\u2019s the most intentional moment on the chart.', 'Salman, FortitudeFX\u2122')
    },
    2: {
      subject:     'Candle 1 tells you what happened. Candle 2 tells you what to do.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 02/20',
      heroTitle:   'Why Candle 2 is the only candle that matters.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('Most traders try to enter on Candle 1 \u2014 they see the sweep happening and jump in during the wick itself. That\u2019s gambling. You don\u2019t know if the sweep is complete. You don\u2019t know if price will reverse or continue.') +
        bodyP('Candle 2 gives you confirmation. It tells you the sweep is done, the reversal has started, and institutions are now pushing in the other direction. The body closes. Momentum is locked. You enter.') +
        bodyP('Yes \u2014 you miss some of the move. That\u2019s the cost of certainty. A smaller move taken with confidence and a clear stop beats a larger move taken with fear every time.') +
        bodyP('Wait for Candle 2. Always.') +
        bodyQuote('Confirmation costs you pips. Hesitation costs you accounts. Pay the pips.', 'Salman, FortitudeFX\u2122')
    },
    3: {
      subject:     'You\u2019re probably drawing levels wrong.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 03/20',
      heroTitle:   'The difference between a zone and a level.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('A level is a line. A zone is an area.') +
        bodyP('Most traders draw levels as precise lines \u2014 and then get frustrated when price misses by a few pips or overshoots slightly. They move the line. They redraw. They conclude \u201clevels don\u2019t work.\u201d') +
        bodyP('The problem is the expectation, not the level. Institutional orders don\u2019t fill at one precise price. They fill across a range. That range is the zone.') +
        bodyP('When you mark a zone instead of a line, you stop getting frustrated when price doesn\u2019t hit your exact number. And you start seeing how often price reacts within the zone even when it doesn\u2019t touch the line.') +
        bodyQuote('The market is not precise. Your framework should be. Your levels should be honest.', 'Salman, FortitudeFX\u2122')
    },
    4: {
      subject:     'Higher timeframe is the boss.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 04/20',
      heroTitle:   'Why timeframe alignment changes everything.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('You can have a perfect Catch The Wick\u2122 setup on the 15-minute chart and still lose the trade.') +
        bodyP('If the higher timeframe is pushing in the opposite direction, you\u2019re fighting a current. You might win occasionally, but the probability is against you.') +
        bodyP('Timeframe alignment means your entry direction matches the bias of the higher timeframe. The daily says up. The 4-hour confirms up. Your 15-minute CTW setup triggers long. Now you have alignment \u2014 and alignment multiplies the probability of the setup working.') +
        bodyP('Before you enter any trade, answer one question: what is the higher timeframe telling me about direction? If the answer contradicts your entry \u2014 skip it. There will be another candle.') +
        bodyQuote('Never fight the higher timeframe. It has more information than you do.', 'Salman, FortitudeFX\u2122')
    },
    5: {
      subject:     'Uncertainty is not a reason to skip the trade.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 05/20',
      heroTitle:   'How to size a position when you\u2019re uncertain.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('Every trader has setups they\u2019re more confident in than others. That\u2019s normal.') +
        bodyP('Here\u2019s how to handle it: when the setup is clear, trade your standard size. When the setup is present but something feels slightly off \u2014 maybe the zone is less defined, maybe the sweep was shallower \u2014 trade half size.') +
        bodyP('Half size keeps you in the game. It keeps you practising execution. Full size when everything aligns. Half size when most things align. No size when the setup isn\u2019t there.') +
        bodyP('Simple. Mechanical. No emotion.') +
        bodyQuote('Position sizing is risk management in practice. Not in theory \u2014 in every single trade.', 'Salman, FortitudeFX\u2122')
    },
    6: {
      subject:     'Less screen time. Better results.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 06/20',
      heroTitle:   'The two-hour rule. Why it works.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('The London session opens. The most significant institutional activity of the day happens in the first two hours after the open.') +
        bodyP('That\u2019s your window. You apply the CTW framework during that window. Either the setup appears and you execute, or it doesn\u2019t and you close the platform.') +
        bodyP('Two hours. Then you\u2019re done.') +
        bodyP('More screen time equals more emotional decisions. You get bored and enter setups that aren\u2019t there. Two focused hours beats eight distracted hours. The setup doesn\u2019t care how long you\u2019ve been watching. It either appears or it doesn\u2019t.') +
        bodyP('Watch the session. Apply the framework. Close the platform. Live your day.') +
        bodyQuote('The market rewards focus, not presence. Two hours of the right attention beats eight hours of the wrong kind.', 'Salman, FortitudeFX\u2122')
    },
    7: {
      subject:     'OFC is not an opinion. It\u2019s a rule.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 07/20',
      heroTitle:   'What orderflow confirmation actually means.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('Orderflow confirmation \u2014 OFC \u2014 is the moment Candle 2 closes in the direction you want to trade with a body that clearly shows directional momentum.') +
        bodyP('Not a doji. Not a spinning top. A candle with a clear body that closes away from the sweep zone.') +
        bodyP('OFC means the buyers \u2014 or sellers \u2014 have taken control of that candle. A candle that wicks hard in both directions and closes in the middle has no OFC. A candle that opens, moves cleanly in one direction, and closes near the high or low has clear OFC.') +
        bodyP('You\u2019re looking for commitment in the close. When you\u2019re asking yourself \u201cdoes this count?\u201d \u2014 it doesn\u2019t.') +
        bodyQuote('OFC is the market showing its hand. Wait for it to show clearly.', 'Salman, FortitudeFX\u2122')
    },
    8: {
      subject:     'The stop is part of the trade, not an afterthought.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 08/20',
      heroTitle:   'Why your stop placement is probably wrong.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('Most traders place their stop where they don\u2019t want to lose. That\u2019s emotional stop placement.') +
        bodyP('Your stop should be placed at the point where the trade is proven wrong \u2014 where the setup that gave you the entry no longer exists.') +
        bodyP('In the CTW framework: if you entered on a sweep of a low with Candle 2 confirming bullish momentum, your stop goes below the wick that swept the low. If price goes back below that wick, the sweep failed. The trade is wrong. You exit.') +
        bodyP('Not a fixed stop. Not \u201cwhat I can afford to lose.\u201d The level where the reason for the trade no longer exists. The stop comes first. The size follows.') +
        bodyQuote('Place your stop where the trade is wrong, not where the loss feels acceptable.', 'Salman, FortitudeFX\u2122')
    },
    9: {
      subject:     'The journal is the edge.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 09/20',
      heroTitle:   'How to journal a trade properly.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('Most traders either don\u2019t journal or journal the wrong things.') +
        bodyP(bodyStrong('Wrong:') + ' \u201cEntered long. Hit target. Good trade.\u201d') +
        bodyP(bodyStrong('Right:') + ' \u201cLondon session. Previous session low swept with a clear wick. Candle 2 closed bullish with clear OFC. Entered at the open of the next candle. Stop below the sweep wick. Target at previous session high. Trade ran to target. No emotional decisions during the trade.\u201d') +
        bodyP('Over 50 trades, the second type of journal shows you your patterns \u2014 when you deviate from the rules, what conditions you struggle in, which sessions produce your best results. That data is your actual edge.') +
        bodyP('Journal the process. The outcome follows.') +
        bodyQuote('Your journal is proof that you either followed the rules or you didn\u2019t. It doesn\u2019t lie.', 'Salman, FortitudeFX\u2122')
    },
    10: {
      subject:     'Setups are yours. Signals belong to someone else.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 10/20',
      heroTitle:   'The difference between a setup and a signal.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('A signal is someone else telling you to buy or sell. A setup is a condition you\u2019ve identified yourself using your own framework.') +
        bodyP('When you take a signal and it loses, you blame the signal provider. You didn\u2019t understand the trade. You weren\u2019t prepared for the drawdown. You exit early, or hold too long.') +
        bodyP('When you take a setup \u2014 a condition you identified yourself using the CTW framework \u2014 you understand every element of it. You know why you entered. You know exactly where you\u2019re wrong. You can handle the drawdown because you know the logic behind the trade.') +
        bodyP('FortitudeFX\u2122 has never been a signal service. It never will be.') +
        bodyQuote('A signal makes you money once. A setup makes you money for life.', 'Salman, FortitudeFX\u2122')
    },
    11: {
      subject:     'You\u2019re not impatient. You just don\u2019t have a rule.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 11/20',
      heroTitle:   'Patience is a mechanical skill, not a personality trait.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('Every trader who has ever blown an account has said: \u201cI just need to be more patient.\u201d') +
        bodyP('Patience is not a mindset problem. It\u2019s a rules problem.') +
        bodyP('When you have no clear rule for entry, there\u2019s nothing to wait for. You sit in front of the chart and stare at price moving and eventually you enter because you feel like you should be doing something.') +
        bodyP('When you have the CTW framework, you\u2019re not waiting for something vague. You\u2019re waiting for three specific conditions. Either they\u2019re all present or they\u2019re not. Waiting becomes easy when you know exactly what you\u2019re waiting for.') +
        bodyQuote('You don\u2019t need more patience. You need a clearer trigger.', 'Salman, FortitudeFX\u2122')
    },
    12: {
      subject:     'Losing streaks are not a signal to change.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 12/20',
      heroTitle:   'How to handle a losing streak without changing your strategy.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('Every strategy has losing streaks. The CTW framework included. Three losses in a row is not evidence that the framework is broken \u2014 it\u2019s evidence that you\u2019ve had three losing trades.') +
        bodyP('Here\u2019s the question to ask: did I follow the rules on all three trades?') +
        bodyP('If yes \u2014 the framework lost three trades. That happens. Over 100 trades, a framework with a 60% win rate will produce runs of 4\u20135 consecutive losses by pure probability.') +
        bodyP('If no \u2014 you deviated from the rules on at least one trade. That\u2019s where you focus. Not on changing the strategy.') +
        bodyP('Changing your strategy during a losing streak is the most expensive mistake in trading.') +
        bodyQuote('A losing streak tests your discipline, not your strategy. Don\u2019t confuse the two.', 'Salman, FortitudeFX\u2122')
    },
    13: {
      subject:     'London sets the story. New York continues it.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 13/20',
      heroTitle:   'What the London session tells you about New York.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('The London session and the New York session are not independent events. They\u2019re chapters in the same daily story.') +
        bodyP('London typically establishes the day\u2019s range and often sweeps the Asia session highs or lows to grab liquidity before the real move begins. By the time London closes, you usually have a clear directional bias for the day.') +
        bodyP('New York either continues that move or creates a secondary sweep before continuing. That pullback is a CTW opportunity for traders in the Americas timezone who missed London.') +
        bodyP('The two sessions speak to each other. London tells you the daily narrative. New York gives you a second chance to trade it.') +
        bodyQuote('The market tells one story per day. London opens the chapter. New York closes it.', 'Salman, FortitudeFX\u2122')
    },
    14: {
      subject:     'Let the trade work.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 14/20',
      heroTitle:   'Why most traders exit too early.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('You enter a trade. It moves in your direction. You\u2019re up. Your target is further out. You close it.') +
        bodyP('Why? Usually: fear. Fear that price will come back. Fear that you\u2019ll give back the profit.') +
        bodyP('That fear is costing you money every single session.') +
        bodyP('When you enter a CTW trade with a defined stop and a defined target \u2014 both placed at mechanical levels \u2014 your job after entry is to manage the trade according to the plan, not according to how you feel.') +
        bodyP('Early exits feel safe. Over 100 trades they destroy your risk/reward ratio. A strategy that targets 2:1 but consistently exits at 0.8:1 is not a 2:1 strategy. It\u2019s a losing one. Set the target. Let price reach it.') +
        bodyQuote('The entry is your decision. After that, the market\u2019s job is to reach your target. Let it do its job.', 'Salman, FortitudeFX\u2122')
    },
    15: {
      subject:     'Trade with the current, not against it.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 15/20',
      heroTitle:   'Higher timeframe bias \u2014 what it is and why it matters.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('Before you look at a 15-minute chart, look at the daily.') +
        bodyP('What is the daily chart doing? Is it in an uptrend? A downtrend? Consolidating?') +
        bodyP('That answer is your higher timeframe bias. It\u2019s the current the market is flowing in right now.') +
        bodyP('On the 15-minute chart, you look for CTW setups that align with that current. If the daily is bullish \u2014 you look for sweeps of lows that create long entries. This is not complicated. It\u2019s one question answered on the daily chart before you open the 15-minute. It takes 30 seconds and filters out a significant percentage of losing trades.') +
        bodyQuote('Bias is not a prediction. It\u2019s a filter. Use it before every session.', 'Salman, FortitudeFX\u2122')
    },
    16: {
      subject:     'The script has been running since before you started trading.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 16/20',
      heroTitle:   'What \u201cthe market runs a script\u201d actually means.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('Institutions need liquidity to fill orders. Retail traders provide that liquidity by placing predictable stop losses at predictable levels. Institutions push price into those levels, trigger the stops, fill their orders, and reverse.') +
        bodyP('That\u2019s the script. It doesn\u2019t change. It ran this morning. It will run tomorrow. It ran 20 years ago.') +
        bodyP('The reason most traders lose is not that they don\u2019t understand this \u2014 many do. It\u2019s that they position themselves as the retail trader in the script.') +
        bodyP('The CTW framework repositions you. You\u2019re not the trader getting swept. You\u2019re the trader watching the sweep happen and entering after it.') +
        bodyQuote('The market runs the same script every session. Your only job is to know which page you\u2019re on.', 'Salman, FortitudeFX\u2122')
    },
    17: {
      subject:     'The best trade is sometimes no trade.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 17/20',
      heroTitle:   'How to know when NOT to trade.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('The CTW framework tells you when to trade. It also tells you when not to.') +
        bodyP(bodyStrong('No trade when:')) +
        bodyP('\u2014 There is no clear sweep. Price meandered through a level without a sharp wick.') +
        bodyP('\u2014 Candle 2 has no clear OFC. The close is indecisive.') +
        bodyP('\u2014 Higher timeframe bias contradicts the entry direction.') +
        bodyP('\u2014 You are in a major news event window. Price during these events is reaction, not institutional flow.') +
        bodyP('\u2014 You\u2019ve already had two losses today. The third trade after two losses is almost always emotional.') +
        bodyP('No trade is a position. It protects your capital for the setup that actually qualifies.') +
        bodyQuote('Sitting on your hands is a skill. Most traders never learn it because it feels like doing nothing. It\u2019s not. It\u2019s discipline in its purest form.', 'Salman, FortitudeFX\u2122')
    },
    18: {
      subject:     'Consistency first. Profitability follows.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 18/20',
      heroTitle:   'Why consistency beats profitability in the early stages.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('Most new traders focus on profit. How much did I make this week?') +
        bodyP('That\u2019s the wrong question in the first 6 months. The right question: did I follow the rules on every trade this week?') +
        bodyP('Profitability without consistency is luck. You can make money trading randomly if the market goes your way. But you can\u2019t replicate luck. You can\u2019t scale luck.') +
        bodyP('Consistency means: same entry criteria, same stop methodology, same position sizing, same exit rules \u2014 on every trade. When you\u2019re consistent for 50 trades, you have a sample size. When you have a sample size, you know if the framework works. Then you can increase size with confidence.') +
        bodyQuote('Consistent execution of a good process produces consistent results. There is no shortcut to that sequence.', 'Salman, FortitudeFX\u2122')
    },
    19: {
      subject:     'You can\u2019t have one without the other.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 19/20',
      heroTitle:   'Risk management and strategy confidence are the same thing.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('When you risk 1% per trade, a losing streak of 5 trades costs you approximately 5% of your account. That\u2019s survivable. Your confidence in the strategy stays intact.') +
        bodyP('When you risk 5% per trade, the same losing streak costs you 25% of your account. That kind of loss changes how you trade. You start second-guessing every entry. You reduce size at the wrong time. You miss the winning trades that follow.') +
        bodyP('Risk management is not about protection. It\u2019s about keeping your psychology intact long enough for the strategy to prove itself over a large sample size.') +
        bodyP('Risk 1%. Trust the process. Let the sample size build.') +
        bodyQuote('Risk management is the foundation that lets your strategy breathe. Without it, even the best framework collapses.', 'Salman, FortitudeFX\u2122')
    },
    20: {
      subject:     'The ones who stay win.',
      kickerText:  'THE FRAMEWORK SERIES \u00b7 20/20',
      heroTitle:   'What separates traders who last from traders who quit.',
      heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
      body: bodyHi(firstName) +
        bodyP('Most traders quit within 12 months. Not because they couldn\u2019t learn the framework. Because they ran out of capital, or patience, or both \u2014 usually at exactly the wrong time.') +
        bodyP('The traders who last share one characteristic: they treated the first year as education, not income generation. They kept risk small. They journaled everything. They stayed with one framework instead of jumping between strategies every time they had a losing week.') +
        bodyP('That consistency is what eventually produces results. Not because the market rewards perseverance philosophically \u2014 but because 200 trades with a 60% win rate and 2:1 risk/reward is mathematically profitable, and you only accumulate 200 trades by staying long enough to take them.') +
        bodyP('Stay in the game. That\u2019s the whole strategy.') +
        bodyQuote('The market has unlimited capital and unlimited patience. Match its patience and you\u2019ve already won half the battle.', 'Salman, FortitudeFX\u2122')
    }
  };
  return emails[emailNum] || null;
}

// =============================================================================
// SEND EMAIL VIA BREVO
// =============================================================================

async function sendEmail(env, to, toName, subject, htmlContent) {
  var res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': env.BREVO_API_KEY },
    body: JSON.stringify({
      sender:      { name: SENDER_NAME, email: SENDER_EMAIL },
      to:          [{ email: to, name: toName }],
      replyTo:     { email: 'support@fortitudefx.com' },
      subject:     subject,
      htmlContent: htmlContent
    })
  });
  return res.ok;
}

// =============================================================================
// KV LOG HELPERS
// =============================================================================

async function isAlreadySent(env, email, dayNum) {
  var key = 'email:log:' + email + ':' + dayNum;
  var val = await env.FFX_KV.get(key).catch(function() { return null; });
  return val !== null;
}

async function markSent(env, email, dayNum, subject) {
  var key = 'email:log:' + email + ':' + dayNum;
  await env.FFX_KV.put(key, JSON.stringify({
    sentAt:  new Date().toISOString(),
    subject: subject,
    day:     dayNum
  }));
}

async function logError(env, email, dayNum, error) {
  var key = 'email:error:' + email + ':' + dayNum + ':' + Date.now();
  await env.FFX_KV.put(key, JSON.stringify({
    email:  email,
    day:    dayNum,
    error:  error,
    time:   new Date().toISOString()
  }), { expirationTtl: 60 * 60 * 24 * 30 }); // 30 days
}

// =============================================================================
// GET EMAIL CONTENT FOR A CONTACT
// =============================================================================

function getEmailForContact(contact) {
  var attrs      = contact.attributes || {};
  var path       = attrs.FFX_PATH       || 'Free';
  var joinedDate = attrs.FFX_JOINED_DATE || null;
  var firstName  = attrs.FIRSTNAME       || 'there';

  if (!joinedDate) return null;

  var joined     = new Date(joinedDate + 'T00:00:00Z');
  var today      = new Date();
  var daysSince  = Math.floor((today - joined) / (1000 * 60 * 60 * 24));
  var dayNum     = daysSince + 1; // Day 1 = daysSince 0

  var content = null;

  if (dayNum >= 1 && dayNum <= 7) {
    // Onboarding sequence — path specific
    if (path === 'VIP')      content = getVIPEmail(dayNum, firstName);
    else if (path === 'Bootcamp') content = getBootcampEmail(dayNum, firstName);
    else                     content = getFreeEmail(dayNum, firstName);
  } else if (dayNum > 7) {
    // Framework series — same for all paths
    // Weekly: only send on days 8, 15, 22, 29... (every 7 days after Day 7)
    var daysSinceOnboarding = dayNum - 7; // 1 on Day 8, 2 on Day 9...
    if (daysSinceOnboarding % 7 !== 1) return null; // only send on day 1 of each week
    var weekNum    = Math.ceil(daysSinceOnboarding / 7); // week 1, 2, 3...
    var emailNum   = ((weekNum - 1) % 20) + 1; // cycle 1-20
    content = getFrameworkEmail(emailNum, firstName);
    if (content) {
      content._dayNum = 'fw:' + weekNum + ':' + emailNum; // unique log key per week
    }
  }

  if (!content) return null;

  return {
    email:     contact.email,
    firstName: firstName,
    dayNum:    content._dayNum || dayNum,
    subject:   content.subject,
    html:      ffxEmail({
      kickerText:   content.kickerText,
      heroTitle:    content.heroTitle,
      heroSubtitle: content.heroSubtitle,
      bodyHtml:     content.body,
      footerNote:   'You are receiving this as part of the FortitudeFX\u2122 community. Reply to this email anytime.',
      ctaUrl:       content.ctaUrl   || null,
      ctaLabel:     content.ctaLabel || null
    })
  };
}

// =============================================================================
// FETCH ALL CONTACTS FROM BREVO LIST 4
// =============================================================================

async function getAllContacts(env) {
  var contacts = [];
  var offset   = 0;
  var limit    = 500;
  var hasMore  = true;

  while (hasMore) {
    var url = 'https://api.brevo.com/v3/contacts?limit=' + limit + '&offset=' + offset + '&listId=' + BREVO_LIST_ID;
    var res = await fetch(url, {
      headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json' }
    });

    if (!res.ok) {
      console.error('[FFX Email] Failed to fetch contacts at offset', offset);
      break;
    }

    var data = await res.json();
    var batch = data.contacts || [];
    contacts = contacts.concat(batch);

    if (batch.length < limit) {
      hasMore = false;
    } else {
      offset += limit;
    }
  }

  return contacts;
}

// =============================================================================
// MAIN SCHEDULED HANDLER
// =============================================================================

async function runDailyEmailSequence(env) {
  console.log('[FFX Email] Starting daily sequence run:', new Date().toISOString());

  var contacts = await getAllContacts(env);
  console.log('[FFX Email] Total contacts:', contacts.length);

  var sent    = 0;
  var skipped = 0;
  var errors  = 0;

  for (var i = 0; i < contacts.length; i++) {
    var contact = contacts[i];
    if (!contact.email) continue;

    var emailData = getEmailForContact(contact);
    if (!emailData) { skipped++; continue; }

    // Idempotency check — never send the same email twice
    var alreadySent = await isAlreadySent(env, contact.email, emailData.dayNum);
    if (alreadySent) { skipped++; continue; }

    // Send
    var ok = await sendEmail(env, emailData.email, emailData.firstName, emailData.subject, emailData.html);

    if (ok) {
      await markSent(env, emailData.email, emailData.dayNum, emailData.subject);
      sent++;
      console.log('[FFX Email] Sent to', emailData.email, 'day', emailData.dayNum);
    } else {
      await logError(env, emailData.email, emailData.dayNum, 'Brevo send failed');
      errors++;
      console.error('[FFX Email] Failed for', emailData.email);
    }
  }

  console.log('[FFX Email] Done. Sent:', sent, 'Skipped:', skipped, 'Errors:', errors);
  return { sent, skipped, errors };
}

// =============================================================================
// HTTP HANDLER — TEST/PREVIEW MODE
// =============================================================================

async function handleRequest(request, env) {
  var url    = new URL(request.url);
  var path   = url.pathname;

  // Only handle /email-worker routes
  if (!path.startsWith('/email-worker')) {
    return new Response('Not found', { status: 404 });
  }

  // Preview mode — sends one test email to PREVIEW_EMAIL
  if (path === '/email-worker/preview') {
    var contactEmail = url.searchParams.get('contact');
    var mode         = url.searchParams.get('mode') || 'preview';

    if (!contactEmail) {
      return new Response(JSON.stringify({ error: 'contact param required' }), { status: 400 });
    }

    // Fetch contact from Brevo
    var res = await fetch('https://api.brevo.com/v3/contacts/' + encodeURIComponent(contactEmail), {
      headers: { 'api-key': env.BREVO_API_KEY }
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ error: 'Contact not found in Brevo' }), { status: 404 });
    }

    var contact  = await res.json();
    var emailData = getEmailForContact(contact);

    if (!emailData) {
      return new Response(JSON.stringify({ error: 'No email due for this contact today', attributes: contact.attributes }), { status: 200 });
    }

    // In preview mode — send to Salman not the real contact
    var testSubject = '[TEST] ' + emailData.subject;
    var ok = await sendEmail(env, PREVIEW_EMAIL, 'Salman (Test)', testSubject, emailData.html);

    return new Response(JSON.stringify({
      success:    ok,
      preview:    true,
      contact:    contactEmail,
      day:        emailData.dayNum,
      subject:    emailData.subject,
      sentTo:     PREVIEW_EMAIL
    }), { status: 200 });
  }

  // Manual trigger — runs the full sequence immediately
  if (path === '/email-worker/run' && request.method === 'POST') {
    var result = await runDailyEmailSequence(env);
    return new Response(JSON.stringify(result), { status: 200 });
  }

  // Test mode — step through sequence one email at a time
  if (path === '/email-worker/test/next') {
    return handleTestRun(request, env);
  }

  return new Response(JSON.stringify({ error: 'Unknown route' }), { status: 404 });
}


// =============================================================================
// TEST MODE HANDLER
// =============================================================================
// Simulates the full sequence at accelerated pace.
// Each call to /email-worker/test/next advances the test contact by one step.
// KV stores test state separately from real send logs.
// Sends all test emails to salmankhanfx@fortitudefx.com with [TEST DAY X] prefix.

async function handleTestRun(request, env) {
  var url    = new URL(request.url);
  var email  = url.searchParams.get('contact'); // real contact email to simulate
  var path   = url.searchParams.get('path')    || 'Free'; // Free | VIP | Bootcamp
  var reset  = url.searchParams.get('reset')   === '1';

  if (!email) {
    return new Response(JSON.stringify({ error: 'contact param required. Example: ?contact=test@example.com&path=Free' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  var stateKey = 'test:state:' + email;

  // Reset test — start from Day 1
  if (reset) {
    await env.FFX_KV.delete(stateKey);
    return new Response(JSON.stringify({ reset: true, contact: email, path: path, message: 'Test reset. Call /next to start from Day 1.' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Get current test day
  var stateRaw = await env.FFX_KV.get(stateKey).catch(function() { return null; });
  var state    = stateRaw ? JSON.parse(stateRaw) : { day: 0, path: path, email: email };

  // Advance to next step
  state.day  = state.day + 1;
  state.path = path; // allow path to be changed mid-test

  // Determine which email to send
  var content = null;
  var label   = '';

  if (state.day >= 1 && state.day <= 7) {
    // Onboarding
    if (state.path === 'VIP')          content = getVIPEmail(state.day, 'Test');
    else if (state.path === 'Bootcamp') content = getBootcampEmail(state.day, 'Test');
    else                                content = getFreeEmail(state.day, 'Test');
    label = 'ONBOARDING Day ' + state.day + '/7 (' + state.path + ')';
  } else {
    // Framework series — day 8 = email 1, day 9 = email 2 etc
    var fwNum = ((state.day - 8) % 20) + 1;
    content   = getFrameworkEmail(fwNum, 'Test');
    label     = 'FRAMEWORK ' + fwNum + '/20';
  }

  // Cap at day 10 (7 onboarding + 3 framework) then stop
  if (state.day > 10) {
    return new Response(JSON.stringify({
      done:    true,
      contact: email,
      message: 'Test sequence complete (7 onboarding + 3 framework). Call ?reset=1 to restart.'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (!content) {
    return new Response(JSON.stringify({ error: 'No content for day ' + state.day }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  // Build and send email
  var testSubject = '[TEST ' + label + '] ' + content.subject;
  var html        = ffxEmail({
    kickerText:   content.kickerText,
    heroTitle:    content.heroTitle,
    heroSubtitle: content.heroSubtitle,
    bodyHtml:     content.body,
    footerNote:   'TEST EMAIL - Day ' + state.day + ' of sequence. Not a real send.',
    ctaUrl:       content.ctaUrl   || null,
    ctaLabel:     content.ctaLabel || null
  });

  var ok = await sendEmail(env, PREVIEW_EMAIL, 'Salman (Test)', testSubject, html);

  // Save state
  await env.FFX_KV.put(stateKey, JSON.stringify(state), { expirationTtl: 60 * 60 * 24 }); // expires in 24hrs

  return new Response(JSON.stringify({
    success:  ok,
    contact:  email,
    path:     state.path,
    day:      state.day,
    label:    label,
    subject:  testSubject,
    sentTo:   PREVIEW_EMAIL,
    next:     state.day < 10 ? 'Call /email-worker/test/next?contact=' + email + '&path=' + state.path + ' for Day ' + (state.day + 1) : 'Complete - add ?reset=1 to restart'
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// =============================================================================
// EXPORT
// =============================================================================

export default {
  // Cron trigger — runs daily at 7am Dubai (03:00 UTC)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyEmailSequence(env));
  },

  // HTTP handler — for preview and manual trigger
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  }
};
