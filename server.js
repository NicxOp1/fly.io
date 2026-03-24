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

    // Intercept requests to inject featuredListing: true
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().includes('/api-gw/graphql') && req.method() === 'POST') {
        try {
          const postData = JSON.parse(req.postData());
          if (postData.query && postData.query.includes('properties(')) {
            // Inject featuredListing filter
            postData.variables = postData.variables || {};
            postData.variables.featuredListing = true;
            // Also increase limit to get more per page
            postData.variables.limit = 100;
            req.continue({ postData: JSON.stringify(postData) });
            return;
          }
        } catch (e) {}
      }
      req.continue();
    });

    // Capture GraphQL responses
    const allProperties = [];
    let totalCount = null;

    page.on('response', async (response) => {
      if (response.url().includes('/api-gw/graphql')) {
        try {
          const json = await response.json();
          if (json.data && json.data.properties) {
            allProperties.push(...json.data.properties);
            if (json.data.propertiesCount) {
              totalCount = json.data.propertiesCount.count;
            }
          }
        } catch (e) {}
      }
    });

    // Navigate to the properties page — this triggers the GraphQL request
    await page.goto('https://soldbyaria.com/properties/sale', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Wait for responses to be captured
    await new Promise(r => setTimeout(r, 3000));

    // If we got data but need more pages, scroll/paginate
    if (totalCount && allProperties.length < totalCount) {
      // Try clicking "load more" or pagination buttons
      let attempts = 0;
      while (allProperties.length < totalCount && attempts < 20) {
        const prevCount = allProperties.length;

        // Try common pagination patterns
        await page.evaluate(() => {
          // Scroll to bottom to trigger infinite scroll
          window.scrollTo(0, document.body.scrollHeight);
          // Try clicking next/load more buttons
          const btns = document.querySelectorAll('button, a');
          for (const btn of btns) {
            const text = btn.textContent.toLowerCase();
            if (text.includes('next') || text.includes('load more') || text.includes('show more')) {
              btn.click();
              break;
            }
          }
        });

        await new Promise(r => setTimeout(r, 3000));
        attempts++;

        // If no new properties were added, stop
        if (allProperties.length === prevCount) break;
      }
    }

    return {
      properties: allProperties,
      totalCount: totalCount || allProperties.length
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
    const token = url.searchParams.get('token');
    if (token !== TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    try {
      console.log('Fetching featured listings...');
      const start = Date.now();
      const data = await getAllFeatured();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`Done: ${data.properties.length} of ${data.totalCount} properties in ${elapsed}s`);
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
  console.log(`Aria featured proxy running on port ${PORT}`);
});
