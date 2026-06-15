// functions/api/youtube-thumbnail.js
// POST /api/youtube-thumbnail — generate thumbnail via Leonardo Phoenix 1.0 API
//
// Body: { videoId, leonardoPrompt, hookText }
// Returns: { success, imageUrl, generationId, videoId }
//
// Flow:
//   1. POST to Leonardo /generations with Phoenix 1.0 model
//   2. Poll GET /generations/{id} every 2s until status === COMPLETE
//   3. Return image URL to dashboard for preview and download
//   4. Write imageUrl back to youtube:metadata:{videoId} thumbnail section
//
// Requires: LEONARDO_API_KEY in Cloudflare Pages environment variables
//
// Model: Phoenix 1.0 — de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3
// Dimensions: 1472x832 (16:9, closest to 1280x720 YouTube spec)
// Alchemy: true (Quality mode — higher detail, worth the extra credits for thumbnails)
// Contrast: 4 (High — cinematic dark thumbnails need strong contrast)

const LEONARDO_BASE   = 'https://cloud.leonardo.ai/api/rest/v1';
const PHOENIX_1_MODEL = 'de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3';
const HEADERS_JSON    = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: HEADERS_JSON });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.LEONARDO_API_KEY) {
    return json({
      error: 'LEONARDO_API_KEY not set. Add it to Cloudflare Pages environment variables.',
    }, 500);
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
        modelId:        PHOENIX_1_MODEL,
        prompt:         leonardoPrompt,
        negative_prompt: 'teal, cyan, blue color grading, neon glow, neon lines, glowing lines, grid lines, chart grid, chart annotations, text overlay, watermark, labels, arrows, indicators, price labels, axis labels, white background, bright background, colorful, busy background, multiple elements, stock photo style, generic finance photo, amateurish, low contrast, flat lighting, overexposed, cluttered, complex scene, multiple charts, trading platform UI, computer screen, person, human, face, hand, multiple candles filling entire frame, full chart view',
        num_images:     1,
        width:          1472,
        height:         832,
        contrast:       4,     // High — essential for dark cinematic thumbnails
        alchemy:        true,  // Quality mode — better shadow detail and lighting
        enhancePrompt:  false, // Never modify our locked template prompt
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      return json({
        error: 'Leonardo API create failed: ' + createRes.status + ' — ' + errText.slice(0, 200),
      }, 500);
    }

    const createData = await createRes.json();
    generationId = createData.sdGenerationJob && createData.sdGenerationJob.generationId;

    if (!generationId) {
      return json({
        error: 'Leonardo did not return a generationId. Response: ' + JSON.stringify(createData).slice(0, 200),
      }, 500);
    }

    console.log('[youtube-thumbnail] Generation started:', generationId, 'videoId:', videoId);

  } catch(err) {
    return json({ error: 'Leonardo API create error: ' + err.message }, 500);
  }

  // ── Step 2: Poll until complete ───────────────────────────────────────
  // Leonardo generates asynchronously — poll every 2 seconds, max 60 seconds
  let imageUrl = null;
  const MAX_POLLS = 30; // 30 × 2s = 60 seconds max

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    await new Promise(function(r) { setTimeout(r, 2000); });

    try {
      const pollRes = await fetch(LEONARDO_BASE + '/generations/' + generationId, {
        headers: Object.assign({ 'Accept': 'application/json' }, authHeader),
      });

      if (!pollRes.ok) {
        console.error('[youtube-thumbnail] Poll failed:', pollRes.status);
        continue; // Keep trying
      }

      const pollData = await pollRes.json();
      const gen      = pollData.generations_by_pk;

      if (!gen) {
        console.error('[youtube-thumbnail] No generations_by_pk in poll response');
        continue;
      }

      console.log('[youtube-thumbnail] Poll', attempt + 1, '— status:', gen.status);

      if (gen.status === 'COMPLETE') {
        const images = gen.generated_images;
        if (images && images.length > 0 && images[0].url) {
          imageUrl = images[0].url;
          break;
        }
        return json({ error: 'Generation completed but no image URL returned' }, 500);
      }

      if (gen.status === 'FAILED') {
        return json({ error: 'Leonardo generation failed. Try regenerating.' }, 500);
      }

      // PENDING or IN_PROGRESS — keep polling

    } catch(pollErr) {
      console.error('[youtube-thumbnail] Poll error (non-fatal, retrying):', pollErr.message);
    }
  }

  if (!imageUrl) {
    return json({
      error: 'Thumbnail generation timed out after 60 seconds. Leonardo may be under load — try again.',
      generationId: generationId,
    }, 500);
  }

  // ── Step 3: Write imageUrl back to youtube:metadata:{videoId} ─────────
  // Non-fatal — dashboard already has the URL, this is just for persistence
  try {
    const meta = await env.FFX_KV.get('youtube:metadata:' + videoId, { type: 'json' }).catch(function() { return null; });
    if (meta) {
      if (!meta.thumbnailConcept) meta.thumbnailConcept = {};
      meta.thumbnailConcept.generatedImageUrl  = imageUrl;
      meta.thumbnailConcept.generationId       = generationId;
      meta.thumbnailConcept.generatedAt        = new Date().toISOString();
      meta.thumbnailConcept.leonardoPromptUsed = leonardoPrompt;
      await env.FFX_KV.put('youtube:metadata:' + videoId, JSON.stringify(meta));
      console.log('[youtube-thumbnail] imageUrl written to youtube:metadata:', videoId);
    }
  } catch(kvErr) {
    console.error('[youtube-thumbnail] KV write failed (non-fatal):', kvErr.message);
  }

  return json({
    success:      true,
    imageUrl:     imageUrl,
    generationId: generationId,
    videoId:      videoId,
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
