// FFX Delete Pending Worker
// POST /delete-pending → removes pending/{jobId}.json from GitHub after publish

const GITHUB_OWNER  = 'fortitudefx';
const GITHUB_REPO   = 'FFX-v10-SEO1';
const GITHUB_BRANCH = 'main';

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const { jobId } = body;
  if (!jobId) return new Response(JSON.stringify({ error: 'jobId required' }), { status: 400 });

  // Sanitise jobId — only allow alphanumeric, hyphens, underscores
  if (!/^[\w\-]+$/.test(jobId)) {
    return new Response(JSON.stringify({ error: 'Invalid jobId' }), { status: 400 });
  }

  try {
    const path = `pending/${jobId}.json`;
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`;

    // Get SHA first
    const getRes = await fetch(url, {
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'FFX-Worker' }
    });

    if (!getRes.ok) {
      // File already gone — that is fine
      return new Response(JSON.stringify({ success: true, note: 'File already removed' }), { status: 200 });
    }

    const { sha } = await getRes.json();

    // Delete
    const delRes = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'User-Agent': 'FFX-Worker',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `pipeline: cleanup pending job ${jobId}`,
        sha,
        branch: GITHUB_BRANCH,
      }),
    });

    if (!delRes.ok) {
      const err = await delRes.text();
      console.log('[FFX] Delete pending failed:', err);
      return new Response(JSON.stringify({ error: 'Delete failed' }), { status: 500 });
    }

    console.log('[FFX] Pending job deleted:', jobId);
    return new Response(JSON.stringify({ success: true }), { status: 200 });

  } catch (err) {
    console.log('[FFX] Delete pending error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
