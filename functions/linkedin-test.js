export async function onRequestGet(context) {
  const token = context.env.LINKEDIN_ACCESS_TOKEN;
  
  const res = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  
  const data = await res.json();
  
  return new Response(JSON.stringify({ status: res.status, data }, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}
