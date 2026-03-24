const http = require('http');
const puppeteer = require('puppeteer-core');

const TOKEN = process.env.TOKEN || 'aria-secret-token-2024';
const PORT = process.env.PORT || 3000;

async function getCookies() {
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36');
    await page.goto('https://soldbyaria.com/properties/sale', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    const cookies = await page.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    return cookieStr;
  } finally {
    await browser.close();
  }
}

async function proxyGraphQL(cookies, body) {
  const res = await fetch('https://soldbyaria.com/api-gw/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://soldbyaria.com',
      'Referer': 'https://soldbyaria.com/properties/sale',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Cookie': cookies
    },
    body: body
  });
  return await res.text();
}

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Auth check
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token') || req.headers['x-token'];
  if (token !== TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  // POST /graphql — get cookies + proxy request
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        console.log('Getting fresh cookies...');
        const cookies = await getCookies();
        console.log('Cookies obtained, proxying GraphQL...');
        const data = await proxyGraphQL(cookies, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(data);
      } catch (err) {
        console.error('Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Cookie proxy running on port ${PORT}`);
});
