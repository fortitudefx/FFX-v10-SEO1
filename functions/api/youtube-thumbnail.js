// functions/api/youtube-thumbnail.js
// POST /api/youtube-thumbnail — generate thumbnail via Leonardo Lucid Origin API
//
// Body: { videoId, leonardoPrompt, hookText }
// Returns: { success, imageUrl, generationId, videoId }
//
// Model: Lucid Origin — 7b592283-e8a7-4c5a-9ba6-d18c31f258b9
// Officially recommended by Leonardo for cinematic dark moody imagery
// Note: alchemy is NOT supported for Lucid Origin (only Phoenix)
// Style: Cinematic Close-Up — cc53f935-884c-40a0-b7eb-1f5c42821fb5
// Dimensions: 1472x832 (16:9 closest to YouTube 1280x720 spec)
// Contrast: 4 (High — essential for pure black backgrounds)

const LEONARDO_BASE        = 'https://cloud.leonardo.ai/api/rest/v1';
const LUCID_ORIGIN_MODEL   = '7b592283-e8a7-4c5a-9ba6-d18c31f258b9';
const STYLE_CINEMATIC_CU   = 'cc53f935-884c-40a0-b7eb-1f5c42821fb5'; // Cinematic Close-Up

// Permanent negative prompt — eliminates ALL generic finance/trading stock photo traits
// and the wax candle ambiguity
const FFX_NEGATIVE_PROMPT = [
  'candle', 'wax candle', 'flame', 'fire', 'candleholder', 'candlestick holder',
  'teal', 'cyan', 'blue color grading', 'neon glow', 'neon lines', 'glowing lines',
  'grid lines', 'chart grid', 'chart background', 'trading platform', 'computer screen',
  'monitor', 'screen', 'annotations', 'text overlay', 'watermark', 'price labels',
  'axis labels', 'chart annotations', 'indicators', 'arrows', 'multiple charts',
  'busy scene', 'stock photo style', 'generic finance', 'bright background',
  'white background', 'colorful', 'saturated colors', 'futuristic', 'holographic',
  'digital overlay', 'UI elements', 'interface', 'HUD', 'lens flare', 'bokeh circles',
  'person', 'human', 'face', 'hand', 'body', 'people',
  'multiple candles filling entire frame', 'full chart view', 'entire chart',
  'low quality', 'blurry', 'overexposed', 'flat lighting', 'amateur',
].join(', ');

const HEADERS_JSON = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: HEADERS_JSON });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.LEONARDO_API_KEY) {
    return json({ error: 'LEONARDO_API_KEY not set in Cloudflare Pages environment variables.' }, 500);
  }

  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { videoId, leonardoPrompt, hookText } = body;
  if (!videoId)        return json({ error: 'videoId required' }, 400);
  if (!leonardoPrompt) return json({ error: 'leonardoPrompt required' }, 400);

  const authHeader = { 'Authorization': 'Bearer ' + env.LEONARDO_API_KEY };

  // ── Step 1: Create generation ─────────────────────────────────────────
  let generationId;
  try {
    const createRes = await fetch(LEONARDO_BASE + '/generations', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json' }, authHeader),
      body: JSON.stringify({
        modelId:         LUCID_ORIGIN_MODEL,
        prompt:          leonardoPrompt,
        negative_prompt: FFX_NEGATIVE_PROMPT,
        styleUUID:       STYLE_CINEMATIC_CU,
        num_images:      1,
        width:           1472,
        height:          832,
        contrast:        4,          // High — pure black background requires max contrast
        alchemy:         false,      // NOT supported for Lucid Origin — Phoenix only
        enhancePrompt:   false,      // Never modify our precision-engineered prompt
        ultra:           false,
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      return json({
        error: 'Leonardo API error: ' + createRes.status + ' — ' + errText.slice(0, 300),
      }, 500);
    }

    const createData = await createRes.json();
    generationId = createData.sdGenerationJob && createData.sdGenerationJob.generationId;

    if (!generationId) {
      return json({
        error: 'Leonardo did not return a generationId. Response: ' + JSON.stringify(createData).slice(0, 200),
      }, 500);
    }

    console.log('[youtube-thumbnail] Lucid Origin generation started:', generationId, 'videoId:', videoId);

  } catch(err) {
    return json({ error: 'Leonardo API create error: ' + err.message }, 500);
  }

  // ── Step 2: Poll until COMPLETE ───────────────────────────────────────
  // Lucid Origin is typically faster than Phoenix for this type of image
  // Poll every 2s, max 60 attempts (120 seconds)
  let imageUrl = null;

  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise(function(r) { setTimeout(r, 2000); });

    try {
      const pollRes = await fetch(LEONARDO_BASE + '/generations/' + generationId, {
        headers: Object.assign({ 'Accept': 'application/json' }, authHeader),
      });

      if (!pollRes.ok) {
        console.error('[youtube-thumbnail] Poll', attempt + 1, 'HTTP error:', pollRes.status);
        continue;
      }

      const pollData = await pollRes.json();
      const gen      = pollData.generations_by_pk;

      if (!gen) { continue; }

      console.log('[youtube-thumbnail] Poll', attempt + 1, '— status:', gen.status);

      if (gen.status === 'COMPLETE') {
        const images = gen.generated_images;
        if (images && images.length > 0 && images[0].url) {
          imageUrl = images[0].url;
          break;
        }
        return json({ error: 'Generation completed but no image URL in response.' }, 500);
      }

      if (gen.status === 'FAILED') {
        return json({ error: 'Leonardo generation failed. Try regenerating the thumbnail prompt and try again.' }, 500);
      }

    } catch(pollErr) {
      console.error('[youtube-thumbnail] Poll error (non-fatal, retrying):', pollErr.message);
    }
  }

  if (!imageUrl) {
    return json({
      error: 'Thumbnail generation timed out after 120 seconds. Leonardo may be under load — try again in a few minutes.',
      generationId: generationId,
    }, 500);
  }

  // ── Step 3: Persist imageUrl to KV ───────────────────────────────────
  try {
    const meta = await env.FFX_KV.get('youtube:metadata:' + videoId, { type: 'json' }).catch(function() { return null; });
    if (meta) {
      if (!meta.thumbnailConcept) meta.thumbnailConcept = {};
      meta.thumbnailConcept.generatedImageUrl  = imageUrl;
      meta.thumbnailConcept.generationId       = generationId;
      meta.thumbnailConcept.generatedAt        = new Date().toISOString();
      meta.thumbnailConcept.leonardoModel      = 'Lucid Origin';
      meta.thumbnailConcept.leonardoPromptUsed = leonardoPrompt;
      await env.FFX_KV.put('youtube:metadata:' + videoId, JSON.stringify(meta));
      console.log('[youtube-thumbnail] imageUrl written to KV:', videoId);
    }
  } catch(kvErr) {
    console.error('[youtube-thumbnail] KV write failed (non-fatal):', kvErr.message);
  }

  return json({ success: true, imageUrl: imageUrl, generationId: generationId, videoId: videoId });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
