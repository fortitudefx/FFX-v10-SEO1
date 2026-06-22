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
// FRAMEWORK EMAIL SERIES — 52 STATIC EMAILS
// =============================================================================
// Pre-written in Salman's voice. Cycles weekly — email 1 through 52 then repeats.
// No Claude API call. No runtime generation. Zero dependency failures.

function getFrameworkEmail(emailNum, firstName) {
  var hi = '<p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:16px;font-weight:700;color:#1a1a2e;">Hi ' + firstName + ',</p>';
  function p(t) { return '<p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:15px;color:#444455;line-height:1.75;">' + t + '</p>'; }
  function b(t) { return '<strong style="color:#1a1a2e;">' + t + '</strong>'; }
  function q(quote) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;"><tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr></table>' +
      '<p style="margin:0 0 4px;font-family:Georgia,serif;font-size:15px;font-style:italic;color:#1a1a2e;line-height:1.65;">&ldquo;' + quote + '&rdquo;</p>' +
      '<p style="margin:0 0 24px;font-family:Arial,sans-serif;font-size:12px;color:#9999aa;letter-spacing:0.04em;">&mdash; Salman, FortitudeFX&trade;</p>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:8px;"><tr><td style="height:1px;background:#f0f0f4;font-size:0;line-height:0;">&nbsp;</td></tr></table>';
  }

  var emails = {
    1: { subject: 'The color of the candle is not decoration.',
      heroTitle: 'The candle is telling you something.',
      body: hi + p('The color of a candle is not aesthetic. It is directional information.') +
        p('A green candle closed higher than it opened. A red candle closed lower. That\u2019s it. That\u2019s the entire story the color is telling you.') +
        p('Where traders get this wrong is they stop reading at the color. They see green and assume bullish. They see red and assume bearish. But a green candle with a long upper wick is not bullish momentum \u2014 it\u2019s rejection. A red candle with a long lower wick is not bearish momentum \u2014 it\u2019s a sweep.') +
        p('In the CTW framework, I don\u2019t care about the color in isolation. I care about what the candle did, where it did it, and what the wick is telling me about where price went and where it came back from.') +
        p('The wick is where price was rejected. The body is where price committed. Read both together and the candle stops being a colored bar. It becomes a sentence.') +
        p('Your job before you place any trade is to read the sentence. The color just tells you which direction the sentence ended.') +
        q('Every candle is a decision. Read what the market decided before you make your own.') },

    2: { subject: 'The wick is more important than the body.',
      heroTitle: 'The body closes. The wick reveals.',
      body: hi + p('The body of a candle tells you where price ended up. The wick tells you where price went and got rejected.') +
        p('For the CTW framework, the wick is the signal. It shows me where liquidity was sitting \u2014 where stops were placed \u2014 and where price went to take those stops before reversing. That\u2019s institutional activity. That\u2019s the footprint of a large order being filled.') +
        p('When you see a wick extend beyond a significant level and then pull back, that\u2019s not random noise. Price went there, did something specific, and came back. The question I ask is: what did it do there?') +
        p('Answer: it filled orders. It swept liquidity. It set up the next move.') +
        p('The body of Candle 2 then tells me if the move is confirmed. If the body closes in the opposite direction of the wick \u2014 with momentum behind it \u2014 that\u2019s my setup. That\u2019s the entry.') +
        p('Stop looking at bodies and asking if price is going up or down. Start looking at wicks and asking where price was and where it came from.') +
        q('The wick is the most honest thing on the chart. It shows you exactly where price went and exactly what happened there.') },

    3: { subject: 'Price went there for a reason.',
      heroTitle: 'The sweep is not random.',
      body: hi + p('When price pushes beyond a significant level \u2014 a previous high, a previous low \u2014 and then pulls back sharply, that\u2019s a sweep.') +
        p('It\u2019s not random. Price went there to fill orders. Stops were sitting at that level. Price went and took them, and in doing so, provided the liquidity needed for a large position to be established in the opposite direction.') +
        p('That\u2019s the entire setup.') +
        p('In the CTW framework, I\u2019m not trying to predict where price is going. I\u2019m identifying where liquidity exists, watching price move toward it, and then positioning after the sweep happens \u2014 in the direction of the new move.') +
        p('The key is the word \u201cafter.\u201d I don\u2019t enter during the sweep. The wick is still forming. I don\u2019t know if the sweep is complete. I wait for Candle 2 to close. If it closes with momentum confirming the reversal, I enter.') +
        p('I\u2019m always one candle behind the sweep. That one candle costs me some of the move. But it gives me certainty. And certainty is worth more than catching the exact bottom.') +
        q('You don\u2019t need to be first. You need to be right. Wait for the candle to close.') },

    4: { subject: 'A zone is not a line.',
      heroTitle: 'Give price room to work.',
      body: hi + p('A level is a line. A zone is an area.') +
        p('If you\u2019re drawing a single horizontal line and expecting price to touch it exactly before reversing, you\u2019re setting yourself up for frustration. Institutional orders don\u2019t fill at one precise price. They fill across a range \u2014 because at the size they\u2019re trading, they need multiple price points to complete the fill.') +
        p('That range is the zone.') +
        p('When I mark a demand zone, I\u2019m marking an area where I expect institutional interest. The zone is valid as long as price hasn\u2019t aggressively broken through it and continued.') +
        p('When price enters the zone and I see a wick forming \u2014 a liquidity sweep within or below the zone \u2014 I start watching for Candle 2. If Candle 2 closes with clear momentum, I\u2019m entering.') +
        p('I\u2019m not waiting for price to touch my line. I\u2019m watching for the setup to appear within my area.') +
        q('The market is not precise. Your levels should reflect that. Zones, not lines.') },

    5: { subject: 'When momentum shows up, the next candle matters.',
      heroTitle: 'Momentum is the signal.',
      body: hi + p('A momentum candle is a candle with a clear, strong body in one direction. No long wicks. No indecision. Price moved and committed.') +
        p('When I see a momentum candle form after a liquidity sweep, I know something has shifted. The institutional order that was being filled has now pushed price with conviction. That\u2019s the story I\u2019m waiting to see.') +
        p('My entry comes on the next candle \u2014 the candle that confirms the momentum is continuing. If it opens, pushes in the same direction, and closes near its high or low with similar conviction, I\u2019m in.') +
        p('This is the two-candle story. Candle 1 shows me the sweep and the shift. Candle 2 confirms the direction. I enter after Candle 2 closes.') +
        p('The mistake is entering during the momentum candle while it\u2019s still forming. That\u2019s chasing. The candle hasn\u2019t finished its sentence yet. Wait for the close. Read the complete sentence before you act on it.') +
        q('Momentum without confirmation is just movement. Wait for the candle to confirm the story before you join it.') },

    6: { subject: 'The higher timeframe is always the boss.',
      heroTitle: 'Context before entry.',
      body: hi + p('Before I look at a 15-minute candle, I look at the daily.') +
        p('The daily chart tells me the overall structure. Is price in an uptrend, making higher highs and higher lows? Is it in a downtrend? Is it ranging between two obvious levels?') +
        p('That answer is my bias for the session. I take it into every trade I evaluate.') +
        p('If the daily is bullish, I\u2019m looking for CTW long entries on the 15-minute. A sweep of a low, a momentum candle closing upward, an OFC \u2014 I\u2019m in. If the daily is bearish, I\u2019m looking for short setups. Same framework, opposite direction.') +
        p('This is timeframe alignment. My entry timeframe and my context timeframe are pointing in the same direction. When that\u2019s the case, the probability of the trade working increases significantly.') +
        p('When they conflict, I skip it. There will be another setup. The move might work. But I don\u2019t want to trade against the current.') +
        q('Your 15-minute setup is a sentence in a paragraph. Read the paragraph first.') },

    7: { subject: 'It works on the 5-minute. It works on the daily.',
      heroTitle: 'The pattern doesn\u2019t care about the timeframe.',
      body: hi + p('The CTW framework is not a 15-minute strategy. It\u2019s a pattern of institutional behavior that repeats on every timeframe.') +
        p('Liquidity sweeps happen on the 1-minute. They happen on the daily. They happen everywhere in between. The candle closes at different speeds, but the story is the same \u2014 price swept a level, liquidity was taken, the next candle confirmed direction.') +
        p('I use the 15-minute as my primary entry timeframe because it filters noise better than the 1-minute and gives faster signals than the 4-hour. But the framework itself is timeframe agnostic.') +
        p('If you\u2019re a swing trader and you want to apply CTW on the 4-hour or daily, the setup is identical. Candle 1 sweeps a significant level. Candle 2 closes with OFC. You enter.') +
        p('Pick the timeframe that fits your lifestyle. The framework works on all of them.') +
        q('Price action is fractal. The same patterns appear at every scale. The framework just has to be applied consistently.') },

    8: { subject: 'Every 15-minute candle is a sentence.',
      heroTitle: 'Learn to read before you act.',
      body: hi + p('I want you to think about the 15-minute candle differently.') +
        p('It\u2019s not a data point. It\u2019s a sentence. It\u2019s telling you exactly what happened in 15 minutes of trading \u2014 where price opened, where it went, where it got rejected, and where it closed.') +
        p('The open is the starting word. The close is the ending word. The wick is a parenthetical \u2014 it tells you where price visited but didn\u2019t commit to.') +
        p('When you read several candles in sequence, you get a paragraph. A narrative. Higher highs and higher lows \u2014 bullish paragraph. Lower highs and lower lows \u2014 bearish paragraph. A sweep followed by a strong close in the opposite direction \u2014 that\u2019s the setup paragraph. That\u2019s the one I\u2019m waiting for.') +
        p('Slow down. Read one candle completely before moving to the next. Where did it open? What did the wick tell you? Where did it close relative to the open?') +
        q('A chart is a story. The trader who reads it best, not reacts to it fastest, wins.') },

    9: { subject: 'The strategy isn\u2019t the problem.',
      heroTitle: 'The trigger is missing.',
      body: hi + p('I\u2019ve spoken to traders who have been trading for years. They understand price action. They understand liquidity. They understand structure.') +
        p('And they\u2019re still not consistent.') +
        p('The strategy isn\u2019t the problem. The trigger is.') +
        p('A trigger is the exact, mechanical condition that tells you when to enter. Not \u201cwhen it looks ready.\u201d A specific, observable event that either happened or didn\u2019t.') +
        p('In CTW, the trigger is clear. The wick swept the level. The next candle closed with OFC. The HTF is aligned. I enter. Three conditions. All three have to be met. If one is missing, I don\u2019t trade.') +
        p('Without a trigger, you have knowledge without action. You can see the setup forming. You understand what\u2019s happening. But you don\u2019t know when to enter, so you either enter too early, too late, or not at all.') +
        q('Knowledge without a trigger is just expensive theory. The trigger is the trade.') },

    10: { subject: 'Two candles. That\u2019s the entire framework.',
      heroTitle: 'Two candles. One story.\u2122',
      body: hi + p('Strip everything back. Remove the indicators. Remove the complex confluence. Remove the multi-step decision trees.') +
        p('What I\u2019m looking for is two candles.') +
        p(b('Candle 1') + ' sweeps a level. It takes out the stops sitting at a significant high or low, extends beyond it with a wick, and then pulls back. That\u2019s the sweep.') +
        p(b('Candle 2') + ' confirms the direction. It closes with momentum in the opposite direction of the sweep. The body is clear. The close is committed. That\u2019s the OFC.') +
        p('I enter after Candle 2 closes. That\u2019s the entire framework. Two candles. One story.') +
        p('Everything else I teach \u2014 timeframe alignment, zone identification, session timing, position sizing \u2014 that\u2019s context. It makes the two-candle setup more reliable. But the core never changes.') +
        q('The simplest version of the truth is always the most powerful version. Two candles is the truth.') },

    11: { subject: 'If you\u2019re asking whether it counts, it doesn\u2019t.',
      heroTitle: 'OFC is not a feeling. It\u2019s a fact.',
      body: hi + p('Orderflow confirmation. OFC.') +
        p('It\u2019s the moment Candle 2 closes with clear directional momentum. The body of the candle shows commitment. Price moved, it didn\u2019t reverse within the candle, and it closed near the extreme.') +
        p('The test I use is simple: if I\u2019m asking myself \u201cdoes this count?\u201d, the answer is no.') +
        p('Clear OFC doesn\u2019t require analysis. It doesn\u2019t require second-guessing. When it\u2019s there, you see it immediately. The candle committed. The close is clean.') +
        p('A doji doesn\u2019t have OFC. A spinning top doesn\u2019t have OFC. A candle that wicks aggressively in both directions and closes in the middle \u2014 no OFC. You skip it.') +
        p('This is what separates the CTW framework from a feeling-based approach. I\u2019m not asking \u201cdoes this look ready?\u201d I\u2019m asking a specific, mechanical question: did Candle 2 close with OFC? Yes or no.') +
        q('OFC is binary. Either the candle committed or it didn\u2019t. There\u2019s no middle ground.') },

    12: { subject: 'Two hours. Then you close the platform.',
      heroTitle: 'Your edge lives in two hours.',
      body: hi + p('The London session opens. The first two hours after the open are where the most significant institutional activity happens. That\u2019s where I trade.') +
        p('After those two hours, I close the platform.') +
        p('This isn\u2019t a rule I follow reluctantly. It\u2019s a rule I follow because I\u2019ve seen what happens when I don\u2019t. The longer I sit in front of a chart looking for something to trade, the worse my decisions get. I start seeing setups that aren\u2019t there.') +
        p('Two hours of focused, rule-based execution produces better results than eight hours of watching and reacting.') +
        p('If the setup appears in those two hours and all conditions are met, I trade it. If the setup doesn\u2019t appear, I close the platform and I\u2019m done for the day. No frustration. No chasing.') +
        q('The edge is in the session. The mistakes are in the hours that follow.') },

    13: { subject: 'Your stop goes where the trade is wrong.',
      heroTitle: 'The stop is part of the trade.',
      body: hi + p('I place my stop where the trade is wrong. Not where the loss feels acceptable.') +
        p('In CTW, the trade is wrong when the setup that gave me the entry no longer exists. If I entered long after a sweep of a low \u2014 Candle 1 swept the low, Candle 2 confirmed upward momentum \u2014 my stop goes below the wick of Candle 1.') +
        p('Why? Because if price goes back below that wick, the sweep failed. The reversal didn\u2019t hold. The trade is wrong. I exit.') +
        p('A lot of traders place a fixed stop because that\u2019s what they can afford to lose on this trade. That has nothing to do with where the trade is wrong. You\u2019re placing your stop based on your account balance, not based on the structure of the setup.') +
        p('When I\u2019ve defined where the trade is wrong, I can calculate how many lots to take so that losing the trade costs me a defined percentage of my account. The stop location comes first. The position size follows.') +
        q('A stop placed where the trade is wrong is a risk management tool. A stop placed where the loss feels acceptable is a gamble.') },

    14: { subject: 'Size follows the stop. Not the other way around.',
      heroTitle: 'Mechanical sizing. Every trade.',
      body: hi + p('Once I know where my stop goes \u2014 below the sweep wick, at the level where the trade is wrong \u2014 I can calculate my position size.') +
        p('The process is simple. I decide in advance how much of my account I\u2019m willing to lose if this trade is wrong. I know the distance from my entry to my stop. I calculate the lot size that keeps my loss at exactly that amount.') +
        p('That\u2019s my position size. I don\u2019t size up because the setup \u201clooks really good.\u201d I don\u2019t size down because I\u2019m nervous. The calculation produces the same answer every time given the same inputs.') +
        p('This matters more than most traders realize. Consistent position sizing is what keeps you in the game during a losing streak. If you\u2019re risking a defined amount per trade and you have consecutive losses, the drawdown is survivable. You continue. You let the framework work.') +
        p('Calculate the lot size. Every time. Mechanical. Consistent.') +
        q('Position sizing is the discipline that lets your strategy breathe. Without it, even the best framework collapses under a losing streak.') },

    15: { subject: 'If you didn\u2019t write it down, it didn\u2019t happen.',
      heroTitle: 'The journal is your real edge.',
      body: hi + p('After every trade, I write down what happened. Not just the outcome \u2014 the process.') +
        p('Did the sweep happen at a significant level? Was the OFC clear on Candle 2? Did I enter at the right point? Was my stop placed correctly? Did I exit at my target or early?') +
        p('These questions matter more than whether the trade won or lost.') +
        p('Over time, a detailed journal shows me patterns I can\u2019t see in the moment. Maybe I consistently exit early on winning trades and eliminate my risk/reward. Maybe I\u2019m entering before OFC is confirmed.') +
        p('Write down the process, not just the result. \u201cEntered long. Hit target.\u201d tells me nothing. \u201cPrevious session low swept, Candle 2 closed with clear OFC, entered at next candle open, stop below wick, target at previous session high\u201d \u2014 that tells me everything.') +
        q('Your journal doesn\u2019t lie to you. It shows exactly where you followed the rules and exactly where you didn\u2019t.') },

    16: { subject: 'Patience is not a mindset. It\u2019s a rule.',
      heroTitle: 'You\u2019re not waiting. You\u2019re following a rule.',
      body: hi + p('Every trader who has struggled with consistency has said at some point: \u201cI just need to be more patient.\u201d') +
        p('Patience is not the solution. A clearer rule is.') +
        p('When you have a specific, mechanical trigger for entry \u2014 the sweep happened, Candle 2 printed OFC, the HTF bias aligns \u2014 you\u2019re not waiting for something vague. You\u2019re waiting for three specific, observable events. Either they all happened or they didn\u2019t.') +
        p('That\u2019s not patience. That\u2019s following a rule.') +
        p('When I\u2019m in front of the charts and the setup isn\u2019t printing, I\u2019m not exercising patience. I\u2019m watching a chart waiting for three specific things to happen. If they don\u2019t happen, I close the platform. There\u2019s nothing to be patient about.') +
        q('The clearer your rule, the easier the wait. Patience is a symptom of an unclear trigger.') },

    17: { subject: 'Three losses in a row is not a crisis.',
      heroTitle: 'Losing streaks test discipline, not strategy.',
      body: hi + p('Three losses in a row is not a sign the framework is broken. It\u2019s three trades.') +
        p('If you have a framework with consistent edge and you take many trades, you will have losing streaks. Statistics don\u2019t deliver losses in a neat, evenly spaced pattern. Sometimes they cluster.') +
        p('The question I ask after a losing streak is not \u201cis the framework broken?\u201d The question is \u201cdid I follow the rules on every trade?\u201d') +
        p('If yes \u2014 the framework lost those trades. That happens. Keep going. The edge plays out over a large sample size.') +
        p('If no \u2014 I deviated on at least one trade. That\u2019s the thing to fix. Not the framework. My execution.') +
        p('The most expensive thing you can do during a losing streak is change your strategy. You abandon something with edge right before it starts working again.') +
        q('A losing streak tests your discipline. If your discipline holds, the framework will take care of the rest.') },

    18: { subject: 'London tells you the story. New York continues it.',
      heroTitle: 'Two sessions. One narrative.',
      body: hi + p('London and New York are not two separate trading days. They\u2019re two chapters of the same story.') +
        p('London typically establishes the directional move for the day. In the first two hours after the London open, I often see the significant sweeps \u2014 the moves that take out the previous session highs or lows, grab the liquidity, and set up the real directional move.') +
        p('By the time London finishes, I usually have a clear read on what happened. Price swept a level, confirmed a direction, and is now pushing that way.') +
        p('New York continues that story. It either extends the London move, or it creates one more sweep before continuing in the London direction.') +
        p('For traders in the Americas timezone who missed London, New York is the second chance. The setup conditions are exactly the same. The difference is that now you have additional context from what London already told you.') +
        q('The market tells one story per day. London opens the chapter. New York closes it.') },

    19: { subject: 'Your job ends at entry.',
      heroTitle: 'Let the trade reach the target.',
      body: hi + p('After I enter a trade, my job is essentially done.') +
        p('I\u2019ve identified the sweep. I\u2019ve waited for OFC. I\u2019ve placed my entry, my stop, and my target. All three are based on structure.') +
        p('Now the market\u2019s job is to reach my target. My job during the trade is to not interfere.') +
        p('The reason I exit early is fear. Price has moved in my direction, my target is further away, and I\u2019m terrified it\u2019s going to reverse and I\u2019ll give back the profit. So I close it early.') +
        p('Over many trades, that fear destroys my risk/reward ratio. If I consistently exit before my target, I\u2019m not running the strategy I think I\u2019m running. I\u2019m running something much worse.') +
        p('Set the target at the mechanical level. Let price get there. If the trade gets stopped out, fine. But if price is moving toward my target and the setup hasn\u2019t been invalidated, I\u2019m staying in.') +
        q('Closing a trade early because it\u2019s in profit is not discipline. It\u2019s fear. Know the difference.') },

    20: { subject: 'Before you look at the 15-minute, look at the daily.',
      heroTitle: 'Bias before entry. Every session.',
      body: hi + p('Every session, before I look at a single 15-minute candle, I look at the daily chart.') +
        p('One question: what is the daily telling me about direction?') +
        p('Is price making higher highs and higher lows? I\u2019m biased long. My CTW setups for the session are long setups.') +
        p('Is price making lower highs and lower lows? I\u2019m biased short. Same framework, opposite direction.') +
        p('Is price ranging between two clear levels? I\u2019m more cautious. I\u2019ll let that guide my bias based on which level price is approaching.') +
        p('This check changes everything about how I interpret the 15-minute. A short setup on the 15-minute during a daily uptrend is not a trade I take. The higher timeframe has more information than I do.') +
        q('Your 15-minute entry is a sentence. Your daily bias is the paragraph it belongs to. Read the paragraph first.') },

    21: { subject: 'The market runs the same script every session.',
      heroTitle: 'Read the script. Don\u2019t react to it.',
      body: hi + p('Here\u2019s what happens in the market every session, without exception.') +
        p('Institutional players need to fill large orders. To fill a large buy order, they need sellers. To create sellers, they push price down into stop losses \u2014 turning existing buyers into sellers by forcing them out of their positions. The stops trigger. Price drops. They fill their buy orders at the lower price. Then they push price up.') +
        p('That\u2019s the script. The wick down is the stop hunt. The reversal is the institutional move.') +
        p('The market ran this script this morning. It\u2019ll run it tomorrow. It ran it years ago and it\u2019ll run it years from now. Because the mechanics of large order execution don\u2019t change.') +
        p('My job is to read the script and position after the stop hunt \u2014 in the same direction as the institution that just filled. The sweep told me what happened. Candle 2 tells me where they\u2019re going.') +
        q('The market doesn\u2019t run randomly. It runs a script. Once you can read the script, every session becomes readable.') },

    22: { subject: 'The best trade today might be no trade.',
      heroTitle: 'Not trading is a position.',
      body: hi + p('I don\u2019t trade every day. Some days, the setup doesn\u2019t print.') +
        p('No clear sweep of a significant level: I don\u2019t trade. Price drifting through a zone without a sharp wick is not a setup.') +
        p('No clear OFC on Candle 2: I don\u2019t trade. An indecisive close is the market telling me the story isn\u2019t finished yet.') +
        p('HTF bias contradicts the 15-minute setup: I don\u2019t trade. I might have a technically valid lower timeframe setup that\u2019s fighting the higher timeframe current.') +
        p('Major news event in the window: I don\u2019t trade. During significant releases, price movement is reaction, not institutional positioning. The script doesn\u2019t apply cleanly.') +
        p('These aren\u2019t optional filters. They\u2019re rules. Not trading on a day with no setup is a good day. Capital preserved. Rules followed. Ready for tomorrow.') +
        q('Discipline is knowing when to wait. Sitting on your hands when the setup isn\u2019t there is as important as entering when it is.') },

    23: { subject: 'The first question is not how much. It\u2019s how consistent.',
      heroTitle: 'Process first. Profit follows.',
      body: hi + p('In the early stages, the question I want you to ask after every trade is not \u201chow much did I make?\u201d It\u2019s \u201cdid I follow the rules?\u201d') +
        p('These are different questions with different answers and different implications.') +
        p('How much you made on any given trade is partly outside your control. Whether you followed the rules is entirely within it. You either waited for the sweep and OFC or you didn\u2019t. You either placed your stop at the correct level or you didn\u2019t.') +
        p('Over many trades, consistent rule-following produces a data set. You can look at your trades where you followed all your rules and see your actual win rate. You can see your actual risk/reward. You can see which sessions produce your best results.') +
        p('None of that data exists if you\u2019re breaking rules half the time.') +
        q('Consistent execution of a sound process is the only path to consistent results. There is no shortcut.') },

    24: { subject: 'Risk management is not protection. It\u2019s psychology.',
      heroTitle: 'Controlled risk keeps your mind clear.',
      body: hi + p('I risk a defined, consistent amount per trade. Not because it\u2019s a magic number, but because of what it does to my psychology when trades go against me.') +
        p('When I lose a trade with controlled risk, the loss stings but it doesn\u2019t destabilize me. I close the trade, write it in the journal, and prepare for the next one. My confidence in the framework is intact.') +
        p('When traders risk too much per trade and they have a losing streak, the emotional damage compounds. That level of loss changes how you trade. You start second-guessing the framework. You reduce your size at the worst time \u2014 right when the edge is about to reassert itself.') +
        p('Risk management isn\u2019t about limiting how much you can lose in the worst case. It\u2019s about keeping your psychology functional enough to continue executing over hundreds of trades.') +
        p('Keep risk consistent. Stay in the game long enough for the edge to prove itself.') +
        q('Risk management is what lets the framework breathe. Without it, even the best strategy collapses under a losing streak.') },

    25: { subject: 'The traders who last don\u2019t have better strategies.',
      heroTitle: 'Stay long enough to compound.',
      body: hi + p('The traders who become consistently profitable are not the ones with the most sophisticated strategies. They\u2019re the ones who stayed long enough to accumulate a meaningful sample size.') +
        p('A framework with genuine edge is mathematically profitable over enough trades. You only accumulate enough trades by staying in the game. Most traders never get there. They take a loss, start over with a new strategy, repeat the cycle.') +
        p('The CTW framework is designed to keep you in the game. Controlled risk keeps your account intact during losing streaks. The two-hour rule keeps your decision-making sharp. The mechanical trigger removes the emotional variability.') +
        p('None of these things are about finding the perfect entry. They\u2019re about building a sustainable practice that you can execute for years.') +
        p('Stay in the game. The results come to those who stay.') +
        q('The market rewards those who stay. Every trade is a data point. You need many of them. Stay long enough to collect them.') },

    26: { subject: 'Where the candle opened tells you everything.',
      heroTitle: 'The open is the starting point of the story.',
      body: hi + p('The open of a candle is not just a price level. It\u2019s the starting point of the story that candle is about to tell.') +
        p('Where price opens relative to the previous close tells me immediately whether there\u2019s a gap \u2014 a jump in sentiment between the last session and this one. How price behaves in the first candles after the open tells me whether institutions are active and directional.') +
        p('The opening candle of a session is particularly significant. In London, the first 15-minute candle after the session opens often sets the tone. If it\u2019s a strong momentum candle in one direction, I watch the next candle carefully.') +
        p('I mark the opening candle\u2019s high and low. These levels often act as reference points throughout the session. Price comes back to test them, sweep them, or break through them with momentum.') +
        p('Never ignore where the candle opened. The open is the first word of the sentence. Read it before you try to trade the rest.') +
        q('The open tells you where the session starts. Everything that follows is context around that starting point.') },

    27: { subject: 'The close is what the candle decided.',
      heroTitle: 'Wait for the decision.',
      body: hi + p('In 15 minutes of trading, price travels. It moves up and down within the candle. It sweeps levels, creates wicks, tests supply and demand. All of that movement happens while the candle is forming.') +
        p('The close is where the candle makes its final decision.') +
        p('This is why I never enter a trade while the candle is still forming. I\u2019m watching an unfinished sentence. The candle hasn\u2019t decided yet.') +
        p('I wait for the close. Then I read the complete sentence. Then I decide whether the sentence creates a setup.') +
        p('If Candle 1 sweeps the level and closes back into range \u2014 that\u2019s the sweep confirmed. I\u2019m now waiting for Candle 2. When Candle 2 closes with clear OFC \u2014 that\u2019s the confirmation. I enter at the open of Candle 3.') +
        p('I never enter a live candle. I always trade closed candles.') +
        q('A candle in progress is an incomplete sentence. Wait for the full stop before you act on it.') },

    28: { subject: 'Trade the structure, not the movement.',
      heroTitle: 'Structure tells you where. Movement tells you when.',
      body: hi + p('Price doesn\u2019t move randomly. It moves between structural levels \u2014 previous highs, previous lows, significant zones where buying or selling pressure has appeared before.') +
        p('In CTW, I identify the significant structural levels before the session starts. Previous day\u2019s high and low. Session opening levels. These are my points of interest.') +
        p('I\u2019m not watching the chart waiting for something to happen. I\u2019m watching price approach a pre-identified level and then observing what happens when it gets there.') +
        p('Does price sweep the level and immediately reverse? That\u2019s a strong signal. Does it approach the level and stall without a clear sweep or OFC? I wait.') +
        p('Structure is the context. Movement within that context is the story. I need both to have a trade.') +
        q('Structure is the map. Price action is the journey. You need the map before you can read the journey.') },

    29: { subject: 'You don\u2019t need to trade everything.',
      heroTitle: 'Depth beats breadth.',
      body: hi + p('I don\u2019t trade many pairs. I know one or two deeply.') +
        p('When you trade one pair consistently, you build a relationship with its behavior. You start to understand when it\u2019s likely to make significant moves. You understand which sessions it\u2019s most active in. You understand its typical behavior and how it reacts to liquidity sweeps.') +
        p('That knowledge accumulates over months of consistent observation. It makes the framework sharper because you\u2019re applying it to a market you know deeply.') +
        p('The framework is universal. Your application of it will become more precise when you apply it to a market you understand deeply.') +
        p('Pick one. Study it. Learn how it behaves specifically. The edge sharpens when you go deep rather than wide.') +
        q('You don\u2019t need to trade everything. You need to trade one thing exceptionally well.') },

    30: { subject: 'The trade is won before the session opens.',
      heroTitle: 'Preparation is the edge.',
      body: hi + p('Before the London session opens, I do the same thing every day. It takes about ten minutes.') +
        p('I look at the daily chart. I identify the current direction. I note my bias for the session.') +
        p('I look at the previous session\u2019s high and low. I mark them on my chart. These are the levels I expect price to interact with during the London open.') +
        p('I look at any significant structural levels that price is approaching.') +
        p('Then I wait.') +
        p('I\u2019m not looking for a trade when the session opens. I\u2019m watching price move toward the levels I\u2019ve already identified and waiting for the CTW setup to appear at one of them.') +
        q('The trader who prepared knows what they\u2019re looking for. The trader who didn\u2019t is just watching movement.') },

    31: { subject: 'The indicator is not the edge.',
      heroTitle: 'Price action tells the story. Indicators summarize it.',
      body: hi + p('Indicators are calculated from price. They\u2019re a mathematical summary of what price already did.') +
        p('When you add an indicator to your chart, you\u2019re not adding new information. You\u2019re adding a visual representation of information that\u2019s already visible in the price action.') +
        p('The problem with indicators is they create distance between you and the actual story. You start waiting for the indicator to confirm what you\u2019re already seeing in the candle.') +
        p('In CTW, I use a clean chart. Price. Levels. That\u2019s it.') +
        p('The wick tells me where the sweep happened. The candle body tells me where momentum committed. The close tells me if OFC is present. All of that information is in the raw price action.') +
        p('Remove the indicators. Learn to read the candle directly. The chart gets cleaner. The decision gets clearer.') +
        q('Price action is the source. Indicators are a summary of the source. Why read the summary when you have the source?') },

    32: { subject: 'The gap between sessions is information.',
      heroTitle: 'Read the gap before you read the candles.',
      body: hi + p('Between the close of one session and the open of the next, price doesn\u2019t trade in the same volume. And when the new session opens, there\u2019s often a repricing \u2014 a jump to where price should be based on sentiment that built up overnight.') +
        p('That gap is information.') +
        p('If London opens significantly higher than the previous close, there\u2019s bullish sentiment carry-over. The first candles of the London session often test whether that sentiment holds \u2014 or whether it gets swept as liquidity.') +
        p('I always note where the previous session closed before the new session opens. The gap between sessions, however small, is part of the story I\u2019m reading when the first candles print.') +
        p('The gap tells you where sentiment landed overnight. The opening candles tell you what institutions are going to do with that sentiment.') +
        q('The gap is the market\u2019s morning statement. Read it before you read the candles.') },

    33: { subject: 'Structure before setup.',
      heroTitle: 'Is price trending or ranging?',
      body: hi + p('Before I look for a CTW setup, I answer one question: is price trending or ranging?') +
        p('A trend is a sequence of higher highs and higher lows (bullish) or lower highs and lower lows (bearish). A range is price oscillating between two horizontal levels.') +
        p('The CTW framework applies in both environments, but the context is different.') +
        p('In a trend, I\u2019m looking for sweeps of the pullback lows in an uptrend \u2014 these are the moments where weak hands get shaken out before price continues higher.') +
        p('In a range, I\u2019m looking for sweeps of the range extremes \u2014 the moments where price breaks out, triggers stops, and then snaps back.') +
        p('Knowing whether price is trending or ranging changes which sweeps I pay attention to and where I place my targets. Structure first. Then look for the setup within that structure.') +
        q('You can\u2019t read a sentence without knowing what paragraph it belongs to. Identify the structure before you look for the setup.') },

    34: { subject: 'The pullback is where the trade lives.',
      heroTitle: 'Wait for price to come to you.',
      body: hi + p('When price makes a strong directional move, it doesn\u2019t continue in a straight line. It pulls back.') +
        p('The pullback is where I\u2019m looking for my entry.') +
        p('In an uptrend, after a strong move up, price pulls back to a demand zone. During that pullback, I watch for a sweep of a significant level within the zone. If price sweeps a low within the pullback and then closes back up with OFC, that\u2019s my entry.') +
        p('I\u2019m not chasing the initial move. I\u2019m patient. I mark the zone. I watch price pull back into it. I wait for the sweep and the confirmation. Then I enter.') +
        p('The pullback is the opportunity. The patient trader who waited for price to come back to the zone gets a better entry than the trader who chased the initial move.') +
        q('Chasing a move is the most expensive trade you can take. Wait for the pullback. The entry will be cleaner and the stop will be tighter.') },

    35: { subject: 'You missed the first entry. There\u2019s another one.',
      heroTitle: 'The second entry is just as valid.',
      body: hi + p('You watched the setup form. The sweep happened. Candle 2 closed with OFC. You hesitated. You missed the entry.') +
        p('That moment \u2014 the frustration of watching a trade move without you \u2014 is one of the most dangerous moments in trading. The instinct is to chase. To enter mid-move because you don\u2019t want to miss any more of it.') +
        p('Don\u2019t.') +
        p('Chasing is not the same as a valid second entry. A valid second entry is a new setup \u2014 price pulling back to a significant level after the initial move, forming a new sweep, giving you a new OFC signal. That is a trade.') +
        p('A chase is entering because price moved and you feel left behind. That is emotion, not a setup.') +
        p('When I miss an entry, I mark where the initial sweep happened and I watch whether price returns to that area. If it does and sets up again \u2014 new sweep, new OFC \u2014 I have a second entry.') +
        q('The trade you missed is not an emergency. The trade you chased out of frustration usually is.') },

    36: { subject: 'Where the candle closed tells you who won.',
      heroTitle: 'Body versus wick. Read the result.',
      body: hi + p('Every candle is a battle between buyers and sellers within that time period. The body and the wick tell you who won.') +
        p('A long body with a short wick means one side dominated the entire candle. Price moved strongly in one direction and closed near the extreme. Clear winner. Strong momentum.') +
        p('A short body with long wicks on both sides means neither side dominated. No winner. Indecision. I don\u2019t trade this candle as an OFC signal.') +
        p('A long body with a single long wick on one side \u2014 that\u2019s the sweep setup. The wick tells me price went to one extreme, got rejected, and came back. The body tells me the winners were on the other side by the close.') +
        p('For CTW, I\u2019m looking for Candle 2 to have a clean body with minimal wick on the closing side \u2014 confirming that the OFC direction held through the close.') +
        q('The wick is the journey. The body is the destination. Read both to understand what happened.') },

    37: { subject: 'Take the emotion out. Leave the rules in.',
      heroTitle: 'Mechanical means emotion doesn\u2019t vote.',
      body: hi + p('The word \u201cmechanical\u201d comes up a lot in how I describe CTW. I want to be clear about what that means.') +
        p('Mechanical means the entry decision is based on observable, binary conditions. Either the sweep happened or it didn\u2019t. Either OFC is present or it isn\u2019t. Either the HTF is aligned or it isn\u2019t. Each answer is yes or no.') +
        p('Emotion doesn\u2019t have a vote.') +
        p('When trading is mechanical, you remove the biggest source of inconsistency in your results \u2014 the variability of how you feel on any given day. Some days you\u2019re confident. Some days you\u2019re nervous. On a feeling-based approach, those emotional states change your decisions. On a mechanical approach, you check the conditions and get yes-yes-yes or you don\u2019t.') +
        p('The framework is the answer to the pull of emotion. Check the conditions. Follow the rule. Let the emotion watch.') +
        q('Mechanical trading doesn\u2019t mean you don\u2019t feel things. It means those feelings don\u2019t make decisions.') },

    38: { subject: 'Consistency is built in the daily practice.',
      heroTitle: 'Same routine. Every session.',
      body: hi + p('The traders I\u2019ve seen become consistently profitable have one thing in common: they show up the same way every day.') +
        p('Same pre-session routine. Same level identification. Same bias check. Same conditions for entry. Same journaling after the session.') +
        p('Consistency in the process produces consistency in the results. Not immediately. But over many trades, a consistent process produces data that tells you exactly what your framework produces when executed correctly.') +
        p('The inconsistent trader can\u2019t tell you what their framework produces because they execute it differently every day. The results are a mix of the framework and the deviation, and they can\u2019t separate them.') +
        p('Build a daily habit around the framework. The habit is the foundation. The results emerge from the habit.') +
        q('Consistency in the process is the only path to consistency in the results. Build the habit before you worry about the outcome.') },

    39: { subject: 'One clean trade is better than five messy ones.',
      heroTitle: 'Quality over quantity.',
      body: hi + p('Some sessions produce one clean CTW setup. Some produce two. Some produce none.') +
        p('On a day with one clean setup, I take that trade. If it wins, I\u2019m done. If it loses, I\u2019m done. One trade.') +
        p('The urge to take more trades after one loses is particularly dangerous. The instinct is to \u201cmake it back.\u201d That instinct produces a second trade that wasn\u2019t qualified, taken for emotional reasons, which often compounds the loss.') +
        p('The framework doesn\u2019t produce many qualified setups in two hours on most days. If you think you\u2019re seeing many setups, look again. Ask whether each one truly met the sweep, OFC, and HTF conditions. Rigorously. Not generously.') +
        p('Quality over quantity. One trade executed perfectly is worth more than five trades executed sloppily.') +
        q('One trade that checks every box is worth five trades that don\u2019t. The market doesn\u2019t reward effort. It rewards precision.') },

    40: { subject: 'The wick is a footprint.',
      heroTitle: 'Someone was there. Read who.',
      body: hi + p('When you see a wick on a candle \u2014 that extension beyond the body before the candle came back \u2014 something specific happened there.') +
        p('Price went to that level. Orders were sitting there. Stops were triggered. Liquidity was taken. And then the participants who were filling orders at that level had what they needed, so they pushed price in the opposite direction.') +
        p('The wick is a footprint. It shows you where the significant activity happened.') +
        p('In CTW, I\u2019m reading that footprint. The key question after I see the wick: what happened at the level the wick touched?') +
        p('Was there a previous significant high or low there? Was it the opening level of the previous session? Was there a clear zone of previous demand or supply? If the wick touched a significant, pre-identified level and then snapped back \u2014 that\u2019s meaningful.') +
        q('A wick at a random level is noise. A wick at a significant level is a signal. Know the difference before you trade it.') },

    41: { subject: 'The first period is the learning period.',
      heroTitle: 'Learn before you earn.',
      body: hi + p('I want to be honest with you about what the early stages of learning a framework look like.') +
        p('In the beginning, you\u2019re building pattern recognition. You\u2019re learning what a clean sweep looks like versus a noisy one. You\u2019re learning what clear OFC looks like versus ambiguous closes. You\u2019re building the judgment that separates high-probability setups from mediocre ones.') +
        p('That takes repetition. And during that repetition, you will take trades that don\u2019t meet the conditions as cleanly as you thought. You will misread HTF bias sometimes. These mistakes are part of the education. They\u2019re the data points that calibrate your judgment.') +
        p('The expectation for the early period should be: follow the framework as consistently as possible, journal every trade, review where you deviated, correct the deviations.') +
        p('Profitability follows execution consistency. Not the other way around.') +
        q('The early period is not for profit. It\u2019s for precision. Precision produces profit. Impatience produces losses.') },

    42: { subject: 'Fear and greed are the same problem wearing different clothes.',
      heroTitle: 'Emotion is the variable you control.',
      body: hi + p('Fear makes you exit trades early and miss targets. Greed makes you hold trades too long and give back profits. Both destroy your risk/reward.') +
        p('They feel like opposite problems. They\u2019re the same problem \u2014 you\u2019re letting emotion override your pre-set rules.') +
        p('Your rules exist to remove emotion from the decision. The target is set before you enter. The stop is set before you enter. The entry conditions are set before the session starts.') +
        p('Every deviation from those pre-set rules \u2014 exiting early because you\u2019re scared, holding longer because you\u2019re greedy \u2014 is emotion making a decision that the rules already made.') +
        p('Make more decisions before the session starts, so there are fewer decisions for the emotion to interfere with during the session. Plan the trade. Trust the plan.') +
        q('Emotion is loudest when the trade is live. Make your decisions when it\u2019s quiet. Honor them when it\u2019s loud.') },

    43: { subject: 'You will never be certain. Trade anyway.',
      heroTitle: 'Certainty is not the goal. Probability is.',
      body: hi + p('I never know for certain that a trade will work. Neither do you. Neither does anyone.') +
        p('What I have is a framework with edge \u2014 a setup that, executed consistently over a large sample size, produces more winning trades than losing ones with a favorable risk/reward. That\u2019s the edge. Not certainty. Not prediction. Probability over a large sample.') +
        p('The trap is waiting for certainty before entering. Certainty doesn\u2019t exist in trading. If you wait for a setup that you\u2019re completely sure will work, you\u2019ll never trade.') +
        p('When the sweep happens at a significant level, when OFC is clear, when the HTF is aligned \u2014 I\u2019m entering because the probability is in my favor. Not because I know it will work.') +
        p('Accept uncertainty. It\u2019s not a problem to be solved. It\u2019s the nature of markets.') +
        q('Certainty is an illusion in trading. Probability is the reality. Build an edge around probability and accept the uncertainty.') },

    44: { subject: 'The review session is as important as the trading session.',
      heroTitle: 'Learn from what already happened.',
      body: hi + p('After the session closes, I do a review. Not immediately \u2014 I give myself time away from the screen first. Then I come back and look at what happened.') +
        p('I look at every setup that appeared \u2014 including the ones I didn\u2019t take. Did I miss a clean CTW setup? Did I take a trade that didn\u2019t actually meet all the conditions when I look at it now with fresh eyes?') +
        p('I look at the trades I did take. Did the entry make sense? Was the stop placed correctly? Did I exit at the right point?') +
        p('This review is not about judgment. It\u2019s about data collection. Every session produces information that makes the next session better.') +
        p('Over time, patterns emerge. Maybe I consistently miss setups at the start of the session. Maybe I\u2019m consistently placing my stop slightly too tight. The review reveals what the session alone can\u2019t.') +
        q('The session produces the trade. The review produces the improvement. You need both.') },

    45: { subject: 'Doing nothing is a skill.',
      heroTitle: 'Not every session needs a trade.',
      body: hi + p('Some sessions I watch the market for two hours and I don\u2019t take a single trade.') +
        p('Not because nothing happened. Because nothing that happened met all three conditions simultaneously. The sweep happened but the OFC was ambiguous. Or everything aligned but I was in a major news window.') +
        p('So I close the platform.') +
        p('Doing nothing in a session where the setup doesn\u2019t appear is one of the most valuable skills a trader can develop. It\u2019s also one of the hardest, because the instinct is to do something. Two hours of watching price move and having nothing to show for it creates pressure to enter anything.') +
        p('Resist that pressure. An empty session is a good session when the conditions weren\u2019t there. The market will be there tomorrow. Your capital is still intact. You\u2019re ready for the next session.') +
        q('The session with no trades, when the setup genuinely wasn\u2019t there, is a success. Capital preserved is capital available for the right trade.') },

    46: { subject: 'The framework gets sharper over time.',
      heroTitle: 'Time in the market compounds judgment.',
      body: hi + p('The CTW framework is a skill. And like any skill, it compounds with practice.') +
        p('In the early months, you\u2019re seeing the setup and not always trusting what you see. The wick looked like a sweep but you weren\u2019t sure. The OFC looked clean but you hesitated.') +
        p('After several months, that hesitation reduces. You\u2019ve seen the pattern enough times that your recognition is faster and more reliable. You identify the sweep as it\u2019s setting up. You\u2019re ready for Candle 2 before it prints.') +
        p('After a year, the setup is automatic. Your eye goes straight to the significant levels. The sweep is obvious. The OFC is either there or it isn\u2019t. The decision is fast and confident.') +
        p('The traders who leave early never get to see what the compounded version of the skill looks like. They leave before the framework becomes instinctive.') +
        q('Skills compound just like returns do. The early investment feels slow. The later returns are remarkable.') },

    47: { subject: 'Don\u2019t trade the news. Trade the reaction.',
      heroTitle: 'News creates liquidity. Liquidity creates setups.',
      body: hi + p('I don\u2019t trade during major news releases. I close the platform before them and I don\u2019t re-open it until the initial volatility settles.') +
        p('Here\u2019s why: during the news release itself, the price movement is reaction, not institutional positioning. The CTW setup conditions don\u2019t apply cleanly during that window.') +
        p('But after the initial reaction settles, the market often sets up a clean CTW entry.') +
        p('Why? Because the news created a big move. That big move swept liquidity. Stops got triggered. And then institutions start positioning for the real post-news direction.') +
        p('That\u2019s when I re-open the platform. I look at what the news candle did. I look for the sweep it created. And I watch for the CTW setup to form as the volatility settles.') +
        q('The news creates the liquidity. The setup forms after. Let the chaos settle before you look for the trade.') },

    48: { subject: 'Set the target before you enter. Honor it after.',
      heroTitle: 'Your target is a commitment.',
      body: hi + p('Before I enter any trade, I know exactly where my target is.') +
        p('Not \u201csomewhere up there.\u201d A specific level. The previous session\u2019s high. The next significant structural level. Something observable on the chart.') +
        p('I enter. I place my stop. I set my target. Then I step back from the screen.') +
        p('When the trade is live and price is moving toward the target, the temptation to close it early is real. \u201cI\u2019m in profit, what if it reverses?\u201d') +
        p('That \u201cwhat if\u201d is the enemy of a profitable risk/reward ratio. The target was set at a structural level for a reason. Either price reaches it or it doesn\u2019t. But I give it the chance.') +
        q('A target is a commitment you make to the trade before you enter. Honoring it is what separates a disciplined trader from an emotional one.') },

    49: { subject: 'How I think about the week before it starts.',
      heroTitle: 'Weekly context. Daily execution.',
      body: hi + p('On Sunday evenings, before the week begins, I spend time looking at the weekly chart.') +
        p('What did last week\u2019s candle do? Was it a strong directional candle? Did it sweep a significant weekly level? Where did it close relative to its range?') +
        p('The weekly chart gives me the broadest context. I note the previous week\u2019s high and low. I look at any major weekly structural levels nearby. I look at the overall weekly bias.') +
        p('That context sits beneath everything I do during the week. My daily bias is informed by the weekly structure. My session analysis is informed by the daily. The 15-minute setup is the execution point within all of that context.') +
        p('A few minutes on Sunday changes how I see every session of the following week.') +
        q('The week tells you the territory. The day tells you the direction. The session shows you the trade.') },

    50: { subject: 'You\u2019ve made it complicated. Now make it simple.',
      heroTitle: 'Simplicity is the destination.',
      body: hi + p('Every trader who finds their edge goes through the same journey.') +
        p('They start simple. They add complexity because simple feels too easy. They spend months buried in indicators, systems, and conflicting frameworks. They emerge from that complexity exhausted and ready to strip everything back.') +
        p('That\u2019s where the real learning starts.') +
        p('The CTW framework is simple on the surface. Sweep, OFC, entry. Two candles. It sounds too easy because traders are conditioned to believe that complexity equals edge. It doesn\u2019t.') +
        p('Edge comes from consistent application of a sound principle over a large sample size. The simpler the system, the more consistently it can be applied. The more consistently it\u2019s applied, the more clearly you can see what it produces.') +
        q('Simplicity is what you earn after you\u2019ve survived the complexity. Don\u2019t skip the journey, but don\u2019t stay in the complexity longer than you have to.') },

    51: { subject: 'You\u2019re not building a trading account. You\u2019re building a skill.',
      heroTitle: 'The skill is the asset.',
      body: hi + p('The account balance is not the asset. The skill is.') +
        p('An account balance can go to zero. The skill can\u2019t. A skilled trader who loses an account builds it back. An unskilled trader who gets lucky and grows an account loses it back.') +
        p('In CTW, I\u2019m teaching you a reading skill. The ability to look at a 15-minute chart, identify the significant levels, wait for the sweep to appear, confirm OFC, and execute a mechanical entry with a defined stop and target.') +
        p('That skill doesn\u2019t expire. It doesn\u2019t become obsolete. Institutional behavior \u2014 sweeping liquidity, filling orders, pushing price \u2014 has been consistent for decades and will continue to be consistent because it\u2019s built into how markets function at scale.') +
        p('You\u2019re building something that compounds indefinitely. Not a particular account balance. A skill that serves you for life.') +
        q('The account is the scorecard. The skill is the game. Build the skill and the scorecard takes care of itself.') },

    52: { subject: 'The framework doesn\u2019t expire.',
      heroTitle: 'What comes next is up to you.',
      body: hi + p('You\u2019ve been through the framework. The core concepts are in front of you \u2014 the sweep, the OFC, the two-candle story, the HTF bias, the two-hour rule, the mechanical entry, the stop, the target.') +
        p('What you do with that is entirely up to you.') +
        p('The framework works on any pair, any session, any timeframe. It will work next year. It will work in ten years. Because it\u2019s built on institutional behavior that doesn\u2019t change \u2014 the need to fill large orders by creating and taking liquidity from predictable levels.') +
        p('What I ask is that you be honest with yourself about your execution. Are you following the three conditions? Are you placing your stop where the trade is wrong? Are you journaling what\u2019s actually happening?') +
        p('The framework produces edge. Your execution is what converts that edge into results.') +
        q('The framework is yours now. The only remaining variable is your commitment to applying it.') }
  };

  var e = emails[emailNum];
  if (!e) return null;
  return {
    subject:     e.subject,
    kickerText:  'CATCH THE WICK\u2122 \u00b7 THE FRAMEWORK',
    heroTitle:   e.heroTitle,
    heroSubtitle:'Catch The Wick\u2122 \u00b7 FortitudeFX\u2122',
    body:        e.body
  };
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

async function getEmailForContact(contact, env) {
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
    if (path === 'VIP')           content = getVIPEmail(dayNum, firstName);
    else if (path === 'Bootcamp') content = getBootcampEmail(dayNum, firstName);
    else                          content = getFreeEmail(dayNum, firstName);
  } else if (dayNum > 7) {
    // Framework series — static 52 emails cycling weekly
    // Only send on days 8, 15, 22, 29... (every 7 days after Day 7)
    var daysSinceOnboarding = dayNum - 7;
    if (daysSinceOnboarding % 7 !== 1) return null;
    var weekNum   = Math.ceil(daysSinceOnboarding / 7);
    var emailNum  = ((weekNum - 1) % 52) + 1; // cycle 1-52
    content = getFrameworkEmail(emailNum, firstName);
    if (content) content._dayNum = 'fw:' + weekNum + ':' + emailNum;
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

    var emailData = await getEmailForContact(contact, env);
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
// APPROVE & SEND — sends last generated draft to all graduated members
// =============================================================================

async function handleApprove(request, env) {
  // Read the last generated draft from KV
  var draft = await env.FFX_KV.get('framework:draft', { type: 'json' }).catch(function() { return null; });
  if (!draft) {
    return new Response(JSON.stringify({ error: 'No draft found. Generate a draft first.' }), {
      status: 404, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Fetch all contacts who have completed onboarding (daysSince >= 7)
  var allContacts = await getAllContacts(env);
  var graduated = allContacts.filter(function(c) {
    var joinedDate = (c.attributes || {}).FFX_JOINED_DATE;
    if (!joinedDate) return false;
    var joined    = new Date(joinedDate + 'T00:00:00Z');
    var today     = new Date();
    var daysSince = Math.floor((today - joined) / (1000 * 60 * 60 * 24));
    return daysSince >= 7;
  });

  var sent = 0; var errors = 0;

  for (var i = 0; i < graduated.length; i++) {
    var contact   = graduated[i];
    var firstName = (contact.attributes || {}).FIRSTNAME || 'there';
    var html      = ffxEmail({
      kickerText:   draft.kickerText,
      heroTitle:    draft.heroTitle,
      heroSubtitle: draft.heroSubtitle,
      bodyHtml:     draft.body.replace(/Hi there,/, 'Hi ' + firstName + ','),
      footerNote:   'You are receiving this as part of the FortitudeFX™ community. Reply to this email anytime.'
    });
    var ok = await sendEmail(env, contact.email, firstName, draft.subject, html);
    if (ok) sent++; else errors++;
  }

  // Clear the draft after sending
  await env.FFX_KV.delete('framework:draft').catch(function() {});

  return new Response(JSON.stringify({
    success: true, sent: sent, errors: errors, total: graduated.length
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}


// =============================================================================
// WEEKLY DRAFT SEND — Sunday 8am Dubai
// =============================================================================
// Sends this week's framework email to Salman for review.
// He clicks Approve & Send to distribute to all graduated members.

async function sendWeeklyDraft(env) {
  // Read which email number we're on from KV
  var weekRaw  = await env.FFX_KV.get('framework:week').catch(function() { return null; });
  var weekNum  = weekRaw ? parseInt(weekRaw) + 1 : 1;
  var emailNum = ((weekNum - 1) % 52) + 1;

  var content  = getFrameworkEmail(emailNum, 'Salman');
  if (!content) {
    console.error('[FFX Email] Weekly draft: no content for email', emailNum);
    return;
  }

  // Store draft for approve endpoint
  await env.FFX_KV.put('framework:draft', JSON.stringify({
    subject:     content.subject,
    kickerText:  content.kickerText,
    heroTitle:   content.heroTitle,
    heroSubtitle:content.heroSubtitle,
    body:        content.body,
    emailNum:    emailNum,
    weekNum:     weekNum
  }), { expirationTtl: 60 * 60 * 24 * 7 });

  // Build approve button
  var approveButton =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px;">' +
    '<tr><td style="background:#f0f0f4;padding:20px;border-radius:8px;text-align:center;">' +
    '<p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:12px;color:rgba(26,26,46,0.5);letter-spacing:0.08em;text-transform:uppercase;">DRAFT — Email ' + emailNum + '/52 — Week ' + weekNum + '</p>' +
    '<p style="margin:0 0 14px;font-family:Arial,sans-serif;font-size:13px;color:rgba(26,26,46,0.6);">Review before sending to all graduated members</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">' +
    '<tr><td style="border-radius:999px;background-color:#C9A84C;">' +
    '<a href="https://ffx-email-worker.salmankhanfx.workers.dev/email-worker/approve" style="display:inline-block;padding:14px 36px;font-family:Arial,sans-serif;font-size:15px;font-weight:700;color:#0d0d14;text-decoration:none;letter-spacing:0.02em;">Approve &amp; Send to Members &#8594;</a>' +
    '</td></tr></table></td></tr></table>';

  var draftHtml = ffxEmail({
    kickerText:   content.kickerText,
    heroTitle:    content.heroTitle,
    heroSubtitle: content.heroSubtitle,
    bodyHtml:     content.body + approveButton,
    footerNote:   'This is your weekly draft email. Click Approve & Send to distribute to all members who have completed onboarding.'
  });

  var ok = await sendEmail(env, SENDER_EMAIL, 'Salman', '[DRAFT] ' + content.subject, draftHtml);

  if (ok) {
    // Advance week counter
    await env.FFX_KV.put('framework:week', String(weekNum));
    console.log('[FFX Email] Weekly draft sent: email', emailNum, '/ week', weekNum);
  } else {
    console.error('[FFX Email] Weekly draft failed to send');
  }
}

// =============================================================================
// HTTP HANDLER — TEST/PREVIEW MODE
// =============================================================================

async function handleRequest(request, env) {
  var url    = new URL(request.url);
  var path   = url.pathname;

  // Block all paths except known routes
  if (!path.startsWith('/email-worker') && !path.startsWith('/test')) {
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
    var emailData = await getEmailForContact(contact, env);

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

  // Test Claude API key directly
  if (path === '/email-worker/test-claude') {
    var keyVal = env.ANTHROPIC_API_KEY;
    var keyInfo = keyVal ? 'length=' + keyVal.length + ' starts=' + keyVal.substring(0,10) : 'UNDEFINED';
    try {
      var testRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': keyVal,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Say hi' }]
        })
      });
      var testBody = await testRes.text();
      return new Response(JSON.stringify({
        status: testRes.status,
        keyInfo: keyInfo,
        body: testBody.substring(0, 300)
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message, keyInfo: keyInfo }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Approve & Send — sends last generated draft to all graduated members
  if (path === '/email-worker/approve') {
    return handleApprove(request, env);
  }

  // Skip onboarding — jump state to Day 8 for framework testing
  if (path === '/email-worker/test/skip') {
    var skipEmail  = url.searchParams.get('contact');
    var skipPath   = url.searchParams.get('path') || 'Free';
    if (!skipEmail) return new Response(JSON.stringify({ error: 'contact required' }), { status: 400 });
    var skipKey    = 'test:state:' + skipEmail;
    var skipState  = { day: 7, path: skipPath, email: skipEmail };
    await env.FFX_KV.put(skipKey, JSON.stringify(skipState), { expirationTtl: 60 * 60 * 24 * 7 });
    return new Response(JSON.stringify({ success: true, message: 'Skipped to Day 7. Next call will generate Framework email (Day 8).' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Test mode — step through sequence one email at a time
  if (path === '/email-worker/test/next') {
    return handleTestRun(request, env);
  }

  // Serve test dashboard
  if (path === '/test' || path === '/test/' || path.startsWith('/test')) {
    return serveTestDashboard(request);
  }

  // Debug — show exact path received
  return new Response(JSON.stringify({ error: 'Unknown route', path: path, url: request.url }), { status: 404 });
}



// =============================================================================
// SERVE TEST DASHBOARD
// =============================================================================

function serveTestDashboard() {
  var html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8"/>\n<meta name="viewport" content="width=device-width,initial-scale=1.0"/>\n<title>FFX Email Worker Test Dashboard</title>\n<style>\n* { box-sizing:border-box;margin:0;padding:0; }\nbody { font-family:\'Inter\',-apple-system,sans-serif;background:#0d0d14;color:#e8e4de;padding:40px 24px; }\nh1 { font-size:22px;font-weight:700;color:#C9A84C;margin-bottom:6px; }\np.sub { font-size:13px;color:rgba(232,228,222,0.45);margin-bottom:32px; }\n.card { background:#111118;border:1px solid rgba(201,168,76,0.15);border-radius:14px;padding:28px;margin-bottom:20px; }\nlabel { display:block;font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:rgba(232,228,222,0.45);margin-bottom:8px; }\ninput,select { width:100%;padding:12px 16px;background:#0d0d14;border:1px solid rgba(232,228,222,0.12);border-radius:8px;color:#e8e4de;font-size:14px;margin-bottom:16px;outline:none; }\n.btn-row { display:flex;gap:12px;flex-wrap:wrap;margin-top:4px; }\nbutton { padding:12px 24px;border-radius:100px;border:none;font-size:14px;font-weight:600;cursor:pointer;transition:all 0.2s; }\n.btn-start { background:#C9A84C;color:#0d0d14; }\n.btn-next { background:rgba(201,168,76,0.12);color:#C9A84C;border:1px solid rgba(201,168,76,0.3); }\n.btn-stop { background:rgba(224,107,26,0.1);color:#E06B1A;border:1px solid rgba(224,107,26,0.25); }\n.btn-reset { background:rgba(239,68,68,0.1);color:#ef4444;border:1px solid rgba(239,68,68,0.25); }\n.btn-skip { background:rgba(99,102,241,0.1);color:#818cf8;border:1px solid rgba(99,102,241,0.25); }\n.status-bar { background:#0d0d14;border:1px solid rgba(232,228,222,0.08);border-radius:10px;padding:20px;margin-bottom:20px; }\n.status-row { display:flex;justify-content:space-between;align-items:center;margin-bottom:12px; }\n.badge { display:inline-block;padding:3px 12px;border-radius:100px;font-size:11px;font-weight:700;letter-spacing:0.1em; }\n.badge-running { background:rgba(46,203,113,0.12);color:#2ecb71;border:1px solid rgba(46,203,113,0.25); }\n.badge-stopped { background:rgba(232,228,222,0.06);color:rgba(232,228,222,0.4);border:1px solid rgba(232,228,222,0.1); }\n.progress-wrap { background:rgba(232,228,222,0.06);border-radius:100px;height:6px;margin-bottom:16px;overflow:hidden; }\n.progress-bar { height:6px;background:#C9A84C;border-radius:100px;transition:width 1s linear; }\n.countdown { font-size:28px;font-weight:700;color:#C9A84C;letter-spacing:-0.02em; }\n.log { background:#0d0d14;border:1px solid rgba(232,228,222,0.08);border-radius:10px;padding:20px;max-height:400px;overflow-y:auto; }\n.log-entry { padding:12px 0;border-bottom:1px solid rgba(232,228,222,0.06);font-size:13px;line-height:1.6; }\n.log-entry:last-child { border-bottom:none; }\n.log-day { font-weight:700;color:#C9A84C;margin-right:8px; }\n.log-subject { color:#e8e4de; }\n.log-meta { font-size:11px;color:rgba(232,228,222,0.35);margin-top:2px; }\n.log-ok { color:#2ecb71; }\n.log-err { color:#f87171; }\n.empty { font-size:13px;color:rgba(232,228,222,0.3);text-align:center;padding:24px 0; }\n.stats { display:flex;gap:32px; }\n.stat-label { font-size:11px;color:rgba(232,228,222,0.35);letter-spacing:0.1em;text-transform:uppercase; }\n.stat-value { font-size:22px;font-weight:700;color:#C9A84C; }\n</style>\n</head>\n<body>\n<h1>FFX Email Worker &mdash; Test Dashboard</h1>\n<p class="sub">Sends test emails to salmankhanfx@fortitudefx.com. State persists &mdash; hit Reset to start from Day 1.</p>\n<div class="card">\n  <label>Worker URL</label>\n  <input type="text" id="workerUrl" value="https://ffx-email-worker.salmankhanfx.workers.dev"/>\n  <label>Contact Email to Simulate</label>\n  <input type="email" id="contactEmail" value="salmankhanfx@fortitudefx.com"/>\n  <label>Path</label>\n  <select id="pathSelect">\n    <option value="Free">Free</option>\n    <option value="VIP">VIP</option>\n    <option value="Bootcamp">Bootcamp</option>\n  </select>\n  <div class="btn-row">\n    <button class="btn-start" onclick="startTest()">&#9654; Start Auto (30s)</button>\n    <button class="btn-next" onclick="sendNext()">&#8594; Send Next Now</button>\n    <button class="btn-stop" onclick="stopTest()">&#9632; Stop</button>\n    <button class="btn-reset" onclick="resetTest()">&#8634; Reset to Day 1</button>\n    <button class="btn-skip" onclick="skipOnboarding()">&#9197; Skip Onboarding</button>\n  </div>\n</div>\n<div class="status-bar">\n  <div class="status-row">\n    <div>\n      <span id="statusBadge" class="badge badge-stopped">STOPPED</span>\n      &nbsp;&nbsp;\n      <span id="stepLabel" style="font-size:14px;color:rgba(232,228,222,0.6);">Ready</span>\n    </div>\n    <div class="countdown" id="countdown">&mdash;</div>\n  </div>\n  <div class="progress-wrap"><div class="progress-bar" id="progressBar" style="width:0%"></div></div>\n  <div class="stats">\n    <div><div class="stat-label">Sent</div><div class="stat-value" id="sentCount">0</div></div>\n    <div><div class="stat-label">Current Day</div><div class="stat-value" id="currentDay">&mdash;</div></div>\n    <div><div class="stat-label">Path</div><div class="stat-value" id="currentPath">&mdash;</div></div>\n  </div>\n</div>\n<div class="log" id="log"><div class="empty">Emails will appear here as they are sent.</div></div>\n<script>\nvar timer=null,cdown=null,sentCount=0,running=false,INTERVAL=30,remaining=INTERVAL;\nfunction base(){return document.getElementById(\'workerUrl\').value.trim().replace(/\\/$/,\'\');}\nfunction contact(){return encodeURIComponent(document.getElementById(\'contactEmail\').value.trim());}\nfunction pth(){return document.getElementById(\'pathSelect\').value;}\nfunction nextUrl(){return base()+\'/email-worker/test/next?contact=\'+contact()+\'&path=\'+pth();}\nfunction resetUrl(){return base()+\'/email-worker/test/next?contact=\'+contact()+\'&path=\'+pth()+\'&reset=1\';}\nfunction skipUrl(){return base()+\'/email-worker/test/skip?contact=\'+contact()+\'&path=\'+pth();}\nfunction setBadge(s){var b=document.getElementById(\'statusBadge\');b.className=\'badge badge-\'+(s===\'running\'?\'running\':\'stopped\');b.textContent=s.toUpperCase();}\nasync function sendNext(){\n  document.getElementById(\'stepLabel\').textContent=\'Sending...\';\n  try{\n    var res=await fetch(nextUrl());\n    var data=await res.json();\n    sentCount++;\n    document.getElementById(\'sentCount\').textContent=sentCount;\n    document.getElementById(\'currentDay\').textContent=data.day||\'?\';\n    document.getElementById(\'currentPath\').textContent=data.path||pth();\n    document.getElementById(\'stepLabel\').textContent=data.label||\'Day \'+data.day;\n    appendLog({day:data.day,label:data.label,subject:data.subject,ok:data.success,sentTo:data.sentTo,error:data.error});\n  }catch(e){appendLog({error:e.message});document.getElementById(\'stepLabel\').textContent=\'Error: \'+e.message;}\n}\nfunction tick(){remaining--;document.getElementById(\'countdown\').textContent=remaining+\'s\';document.getElementById(\'progressBar\').style.width=((INTERVAL-remaining)/INTERVAL*100)+\'%\';if(remaining<=0){remaining=INTERVAL;sendNext();}}\nfunction startTest(){if(running)return;running=true;setBadge(\'running\');sendNext();remaining=INTERVAL;cdown=setInterval(tick,1000);}\nfunction stopTest(){running=false;clearInterval(cdown);cdown=null;document.getElementById(\'countdown\').textContent=\'&mdash;\';document.getElementById(\'progressBar\').style.width=\'0%\';setBadge(\'stopped\');document.getElementById(\'stepLabel\').textContent=\'Stopped\';}\nasync function resetTest(){\n  stopTest();sentCount=0;\n  document.getElementById(\'sentCount\').textContent=\'0\';\n  document.getElementById(\'currentDay\').textContent=\'&mdash;\';\n  document.getElementById(\'currentPath\').textContent=\'&mdash;\';\n  document.getElementById(\'stepLabel\').textContent=\'Resetting...\';\n  document.getElementById(\'log\').innerHTML=\'<div class="empty">Log cleared. Starting from Day 1.</div>\';\n  try{await fetch(resetUrl());document.getElementById(\'stepLabel\').textContent=\'Reset complete. Ready.\';}\n  catch(e){document.getElementById(\'stepLabel\').textContent=\'Reset failed: \'+e.message;}\n}\nasync function skipOnboarding(){\n  stopTest();\n  document.getElementById(\'stepLabel\').textContent=\'Skipping onboarding...\';\n  try{\n    await fetch(skipUrl());\n    document.getElementById(\'currentDay\').textContent=\'7\';\n    document.getElementById(\'stepLabel\').textContent=\'Skipped to Day 7. Next email will be Framework.\';\n  }catch(e){document.getElementById(\'stepLabel\').textContent=\'Skip failed: \'+e.message;}\n}\nfunction appendLog(e){\n  var log=document.getElementById(\'log\');\n  if(log.querySelector(\'.empty\'))log.innerHTML=\'\';\n  var d=document.createElement(\'div\');d.className=\'log-entry\';\n  if(e.error&&!e.success){d.innerHTML=\'<span class="log-err">&#10007; ERROR</span> \'+e.error;}\n  else{var s=e.ok?\'<span class="log-ok">&#10003; Sent</span>\':\'<span class="log-err">&#10007; Failed</span>\';d.innerHTML=\'<span class="log-day">Day \'+e.day+\'</span><span class="log-subject">\'+(e.subject||\'\')+\'</span><div class="log-meta">\'+s+\' &rarr; \'+(e.sentTo||\'\')+\' &middot; \'+new Date().toLocaleTimeString()+\'</div>\';}\n  log.insertBefore(d,log.firstChild);\n}\n</script>\n</body>\n</html>';
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
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
    // Framework series — static 52 emails cycling
    var fwNum = ((state.day - 8) % 52) + 1;
    content   = getFrameworkEmail(fwNum, 'Test');
    label     = 'FRAMEWORK ' + fwNum + '/52';
  }

  if (!content) {
    return new Response(JSON.stringify({ error: 'No content for day ' + state.day }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  // If generation failed — return error without sending or advancing state
  if (content._error) {
    // Roll back state — don't advance the day
    state.day = state.day - 1;
    await env.FFX_KV.put(stateKey, JSON.stringify(state), { expirationTtl: 60 * 60 * 24 * 7 });
    return new Response(JSON.stringify({ error: 'Framework generation failed: ' + content._error, day: state.day + 1 }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
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

  // Only save state if send succeeded or at least content was generated
  await env.FFX_KV.put(stateKey, JSON.stringify(state), { expirationTtl: 60 * 60 * 24 * 7 });

  return new Response(JSON.stringify({
    success:  ok,
    contact:  email,
    path:     state.path,
    day:      state.day,
    label:    label,
    subject:  testSubject,
    sentTo:   PREVIEW_EMAIL
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// =============================================================================
// EXPORT
// =============================================================================

export default {
  // Cron trigger — runs daily at 7am Dubai (03:00 UTC)
  async scheduled(event, env, ctx) {
    var now = new Date();
    // Sunday = 0 in UTC, but 7am Dubai = 3am UTC, so check day in Dubai (UTC+4)
    var dubaiHour = (now.getUTCHours() + 4) % 24;
    var dubaiDay  = new Date(now.getTime() + 4 * 60 * 60 * 1000).getUTCDay();
    if (dubaiDay === 0) {
      // Sunday 7am Dubai — send weekly draft to Salman for review
      ctx.waitUntil(sendWeeklyDraft(env));
    } else {
      // All other days — run daily onboarding sequence
      ctx.waitUntil(runDailyEmailSequence(env));
    }
  },

  // HTTP handler — for preview and manual trigger
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  }
};
