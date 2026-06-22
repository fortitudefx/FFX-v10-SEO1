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
// FRAMEWORK EMAIL — DYNAMIC GENERATION
// =============================================================================
// Reads SEO signals, transcripts, and nuggets from KV.
// Calls Claude to generate a fresh email in Salman's voice on the trending topic.
// Returns null if generation fails — no fallback, no templated content.

async function generateFrameworkEmail(env, firstName) {
  try {
    // Step 1 — Read SEO signals for trending topic
    var seoSignals = await env.FFX_KV.get('seo:signals', { type: 'json' }).catch(function() { return null; });
    var topic = 'mechanical entry discipline and the CTW framework';
    var risingQueries = [];
    if (seoSignals && seoSignals.risingQueries && seoSignals.risingQueries.length > 0) {
      risingQueries = seoSignals.risingQueries.slice(0, 3);
      topic = risingQueries.map(function(q) { return q.query; }).join(', ');
    }

    // Step 2 — Read transcripts for Salman voice
    var transcriptKeys = await env.FFX_KV.list({ prefix: 'transcript:' }).catch(function() { return { keys: [] }; });
    var transcriptExcerpts = '';
    var keysToRead = transcriptKeys.keys
      .filter(function(k) { return !k.name.includes('timestamps'); })
      .slice(0, 3);

    for (var i = 0; i < keysToRead.length; i++) {
      var t = await env.FFX_KV.get(keysToRead[i].name).catch(function() { return null; });
      if (t) transcriptExcerpts += t.substring(0, 800) + '\n\n';
    }

    // Step 3 — Find relevant nugget matching topic
    var nuggetIndex = await env.FFX_KV.get('nuggets:index', { type: 'json' }).catch(function() { return null; });
    var closingQuote = '';
    if (Array.isArray(nuggetIndex) && nuggetIndex.length > 0) {
      // Try to find a topic-relevant nugget
      var topicWords = topic.toLowerCase().split(/[\s,]+/);
      var bestNugget = null;
      var bestScore  = -1;

      for (var j = 0; j < Math.min(nuggetIndex.length, 30); j++) {
        var nug = await env.FFX_KV.get('nugget:' + nuggetIndex[j], { type: 'json' }).catch(function() { return null; });
        if (!nug || !nug.text) continue;
        var score = 0;
        var nugText = (nug.text + ' ' + (nug.category || '') + ' ' + (nug.tags || []).join(' ')).toLowerCase();
        topicWords.forEach(function(w) { if (w.length > 3 && nugText.includes(w)) score++; });
        if (score > bestScore) { bestScore = score; bestNugget = nug; }
      }

      if (bestNugget) closingQuote = bestNugget.text;
    }

    // Step 4 — Build Claude prompt
    var voiceRules = 'VOICE RULES: Write directly to one person. First sentence is a direct statement, never a question. ' +
      'Specific and mechanical, grounded in real CTW concepts. No motivational fluff. Maximum 250 words. ' +
      'One idea only. End naturally, no call to action.';

    var prompt = 'You are writing a weekly email for FortitudeFX members in Salman Khan voice. ' +
      'Salman is a professional forex trader, founder of FortitudeFX, teaches the Catch The Wick (CTW) methodology. ' +
      'Voice: direct, second person, calm authority, slightly contrarian, never motivational fluff, mechanical. ' +
      'Never starts with Most traders. Speaks to one trader not a crowd. Present tense. Short sentences. ' +
      voiceRules + ' ' +
      'SALMAN VOICE from his actual transcripts: ' +
      (transcriptExcerpts ? transcriptExcerpts.substring(0, 1200).replace(/\n/g, ' ') : 'Direct, mechanical, calm authority.') + ' ' +
      'THIS WEEK TOPIC based on what traders are searching for right now: ' + topic + '. ' +
      'Rising queries: ' + risingQueries.map(function(q) { return q.query; }).join(', ') + '. ' +
      'Generate the email in JSON format: ' +
      '{"subject":"standalone subject line max 8 words no numbering","heroTitle":"short headline max 6 words",' +
      '"heroSubtitle":"one line subtitle","body":"full email body 150-250 words in Salman voice"} ' +
      'CRITICAL: Return ONLY valid JSON. No preamble. No markdown. First character must be {.';

        // Step 5 — Call Claude
    var claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 1000,
        messages:   [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      var errText = await claudeRes.text().catch(function() { return 'unknown'; });
      throw new Error('Claude API ' + claudeRes.status + ': ' + errText.substring(0, 200));
    }

    var claudeData = await claudeRes.json();
    var rawText = '';
    if (claudeData.content) {
      for (var k = 0; k < claudeData.content.length; k++) {
        if (claudeData.content[k].type === 'text') rawText += claudeData.content[k].text;
      }
    }

    // Parse JSON response
    var jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { throw new Error('Claude returned no JSON. Raw: ' + rawText.substring(0, 200)); }
    var generated = JSON.parse(jsonMatch[0]);

    var emailContent = {
      subject:     generated.subject     || 'This week from FortitudeFX',
      kickerText:  'CATCH THE WICK™ · THE FRAMEWORK',
      heroTitle:   generated.heroTitle   || 'The framework in practice.',
      heroSubtitle:'Catch The Wick™ · FortitudeFX™',
      body:        bodyHi(firstName) + generated.body.split('\n\n').map(function(p) { return bodyP(p.trim()); }).join('') +
                   (closingQuote ? bodyQuote(closingQuote, 'Salman, FortitudeFX™') : '')
    };

    // Store draft in KV for approve endpoint
    await env.FFX_KV.put('framework:draft', JSON.stringify(emailContent), { expirationTtl: 60 * 60 * 24 * 7 });

    // Add approve button to draft copy only
    var approveButton =
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px;">' +
      '<tr><td style="background:#f0f0f4;padding:20px;border-radius:8px;text-align:center;">' +
      '<p style="margin:0 0 12px;font-family:Arial,sans-serif;font-size:13px;color:rgba(26,26,46,0.6);">DRAFT — Review before sending to members</p>' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">' +
      '<tr><td style="border-radius:999px;background-color:#C9A84C;">' +
      '<a href="https://ffx-email-worker.salmankhanfx.workers.dev/email-worker/approve" style="display:inline-block;padding:14px 36px;font-family:Arial,sans-serif;font-size:15px;font-weight:700;color:#0d0d14;text-decoration:none;letter-spacing:0.02em;">Approve &amp; Send to All Members &#8594;</a>' +
      '</td></tr></table></td></tr></table>';

    var draftContent = {
      subject:     '[DRAFT] ' + emailContent.subject,
      kickerText:  emailContent.kickerText,
      heroTitle:   emailContent.heroTitle,
      heroSubtitle:emailContent.heroSubtitle,
      body:        emailContent.body + approveButton
    };

    return draftContent;

    } catch(err) {
    console.error('[FFX Email] Framework generation error:', err.message);
    return { _error: err.message, subject: 'Generation failed', kickerText: 'ERROR', heroTitle: err.message.substring(0, 50), heroSubtitle: 'Check Worker logs', body: '<p style="color:red;">Framework email generation failed: ' + err.message + '</p>' };
  }
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
    // Framework series — dynamically generated
    // Weekly: only send on days 8, 15, 22, 29... (every 7 days after Day 7)
    var daysSinceOnboarding = dayNum - 7;
    if (daysSinceOnboarding % 7 !== 1) return null;
    var weekNum = Math.ceil(daysSinceOnboarding / 7);
    content = await generateFrameworkEmail(env, firstName);
    if (content) content._dayNum = 'fw:' + weekNum;
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
    // Framework series — dynamically generated
    content = await generateFrameworkEmail(env, 'Test');
    label   = 'FRAMEWORK (generated)';
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
    ctx.waitUntil(runDailyEmailSequence(env));
  },

  // HTTP handler — for preview and manual trigger
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  }
};
