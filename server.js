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

    let graphqlEndpoint = null;
    let lastRequestPayload = null;

    page.on('request', (request) => {
      try {
        if (request.url().includes('/api-gw/graphql') && request.method() === 'POST') {
          graphqlEndpoint = request.url();
          const postData = request.postData();
          if (postData) {
            lastRequestPayload = JSON.parse(postData);
            console.log('GraphQL request vars:', JSON.stringify(lastRequestPayload.variables || {}));
          }
        }
      } catch (e) {}
    });

    page.on('response', async (response) => {
      try {
        if (response.url().includes('/api-gw/graphql')) {
          const json = await response.json();
          if (json.data && json.data.properties) {
            properties = json.data.properties;
            totalCount = json.data.propertiesCount?.count || null;
            console.log(`GraphQL response: ${properties.length} properties, total: ${totalCount}`);
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

    // Paginate using direct GraphQL calls if there are more
    if (totalCount && allProperties.length < totalCount && graphqlEndpoint && lastRequestPayload) {
      const perPage = allProperties.length;
      const totalPages = Math.ceil(totalCount / perPage);
      const existingIds = new Set(allProperties.map(p => p.id));

      console.log(`Pagination: ${perPage}/page, ${totalPages} pages needed, endpoint: ${graphqlEndpoint}`);

      for (let pageNum = 2; pageNum <= totalPages + 1; pageNum++) {
        if (allProperties.length >= totalCount) break;

        // Clone the original payload and update the page/offset variable
        const payload = JSON.parse(JSON.stringify(lastRequestPayload));
        if (payload.variables) {
          if ('page' in payload.variables) {
            payload.variables.page = pageNum;
          } else if ('offset' in payload.variables) {
            payload.variables.offset = (pageNum - 1) * perPage;
          } else if ('skip' in payload.variables) {
            payload.variables.skip = (pageNum - 1) * perPage;
          } else {
            payload.variables.page = pageNum;
          }
        }

        console.log(`GraphQL page ${pageNum}, vars: ${JSON.stringify(payload.variables)}`);

        // Fetch directly and return JSON from browser context
        const result = await page.evaluate(async (endpoint, body) => {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(body)
          });
          return res.json();
        }, graphqlEndpoint, payload);

        const pageProps = result?.data?.properties || [];
        console.log(`Page ${pageNum}: got ${pageProps.length} properties from GraphQL`);

        let added = 0;
        for (const p of pageProps) {
          if (!existingIds.has(p.id)) {
            allProperties.push(p);
            existingIds.add(p.id);
            added++;
          }
        }
        console.log(`Page ${pageNum}: added ${added} new (total: ${allProperties.length}/${totalCount})`);

        if (pageProps.length === 0) {
          console.log('No more results, stopping pagination');
          break;
        }
      }
    }

    return {
      properties: allProperties,
      totalCount: totalCount || allProperties.length,
      pagesScraped: totalCount ? Math.ceil(allProperties.length / Math.max(properties.length, 1)) : 1
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
