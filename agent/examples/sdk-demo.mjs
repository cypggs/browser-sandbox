// Example: Using the Browser Sandbox HTTP API from Node.js
// Usage: API_TOKEN=<token> SANDBOX_API_URL=http://127.0.0.1:3800 node agent/examples/sdk-demo.mjs

const baseUrl = process.env.SANDBOX_API_URL || 'http://127.0.0.1:3800';
const apiToken = process.env.API_TOKEN;

if (!apiToken) {
  console.error('Please set API_TOKEN environment variable.');
  process.exit(1);
}

async function callApi(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

const status = await callApi('GET', '/browser/status');
console.log('Status:', JSON.stringify(status, null, 2));

const nav = await callApi('POST', '/browser/navigate', { url: 'https://example.com' });
console.log('Navigated:', nav);

const page = await callApi('GET', '/browser/page?accessibility=true');
console.log('Title:', page.data?.title, 'URL:', page.data?.url);

const shot = await callApi('POST', '/browser/screenshot', { name: 'sdk-demo.png' });
console.log('Screenshot:', shot);
