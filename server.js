const http = require('http');
const puppeteer = require('puppeteer-core');

const TOKEN = process.env.TOKEN || 'aria-secret-token-2024';
const PORT = process.env.PORT || 3000;

async function getAllFeatured() {
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1440, height: 900 });

    // Capture GraphQL responses from network
    let properties = [];
    let totalCount = null;

    page.on('response', async (response) => {
      try {
        if (response.url().includes('/api-gw/graphql')) {
          const json = await response.json();
          if (json.data && json.data.properties) {
            properties = json.data.properties;
            totalCount = json.data.propertiesCount?.count || null;
          }
        }
      } catch (e) {}
    });

    // Load first page (retry once on timeout)
    console.log('Loading page 1...');
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto('https://soldbyaria.com/properties/sale', {
          waitUntil: 'networkidle2',
          timeout: 90000
        });
        break;
      } catch (e) {
        if (attempt === 2) throw e;
        console.log('Retry navigation...');
      }
    }
    await new Promise(r => setTimeout(r, 3000));

    const allProperties = [...properties];
    console.log(`Page 1: ${allProperties.length} properties (total: ${totalCount})`);

    // Paginate if there are more
    if (totalCount && allProperties.length < totalCount) {
      // Find pagination links from the page
      const pageLinks = await page.evaluate(() => {
        const links = [];
        document.querySelectorAll('a[href*="properties/sale"]').forEach(a => {
          const href = a.getAttribute('href');
          if (href && href.includes('=') && !links.includes(href)) {
            links.push(href);
          }
        });
        return links;
      });

      // Visit each pagination page
      for (const link of pageLinks) {
        if (allProperties.length >= totalCount) break;

        properties = []; // Reset for next page capture
        const pageUrl = link.startsWith('http') ? link : `https://soldbyaria.com${link}`;
        const pageNum = link.match(/=(\d+)/)?.[1] || '?';
        console.log(`Loading page ${pageNum}...`);

        await page.goto(pageUrl, {
          waitUntil: 'networkidle2',
          timeout: 90000
        });
        await new Promise(r => setTimeout(r, 2000));

        // Add new properties (deduplicate by id)
        const existingIds = new Set(allProperties.map(p => p.id));
        for (const p of properties) {
          if (!existingIds.has(p.id)) {
            allProperties.push(p);
            existingIds.add(p.id);
          }
        }
        console.log(`Page ${pageNum}: +${properties.length} properties (total collected: ${allProperties.length})`);
      }
    }

    return {
      properties: allProperties,
      totalCount: totalCount || allProperties.length,
      pagesScraped: 1 + (totalCount && allProperties.length > properties.length ? Math.ceil((allProperties.length - properties.length) / 12) : 0)
    };
  } finally {
    await browser.close();
  }
}

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Featured listings
  if (req.method === 'GET' && req.url.includes('token=')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.searchParams.get('token') !== TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    try {
      console.log('Starting featured listings scrape...');
      const start = Date.now();
      const data = await getAllFeatured();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`Complete: ${data.properties.length}/${data.totalCount} properties in ${elapsed}s`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Aria featured scraper running on port ${PORT}`);
});
