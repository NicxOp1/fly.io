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
    let listingsPayload = null; // The main listings query (has offset)

    page.on('request', (request) => {
      try {
        if (request.url().includes('/api-gw/graphql') && request.method() === 'POST') {
          graphqlEndpoint = request.url();
          const postData = request.postData();
          if (postData) {
            const parsed = JSON.parse(postData);
            const vars = parsed.variables || {};
            console.log('GraphQL request vars:', JSON.stringify(vars));
            // Identify the main listings query by presence of 'offset' variable
            if ('offset' in vars && 'limit' in vars) {
              listingsPayload = parsed;
              console.log('>>> Captured listings query payload');
            }
          }
        }
      } catch (e) {}
    });

    page.on('response', async (response) => {
      try {
        if (response.url().includes('/api-gw/graphql')) {
          const json = await response.json();
          if (json.data && json.data.properties) {
            const vars = json.data;
            const count = json.data.propertiesCount?.count || null;
            console.log(`GraphQL response: ${json.data.properties.length} properties, total: ${count}`);
            // Only use the response from the main listings query (largest set)
            if (json.data.properties.length > properties.length) {
              properties = json.data.properties;
              totalCount = count;
            }
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

    // Paginate using direct GraphQL calls with offset
    if (totalCount && allProperties.length < totalCount && graphqlEndpoint && listingsPayload) {
      const perPage = listingsPayload.variables.limit || allProperties.length;
      const existingIds = new Set(allProperties.map(p => p.id));

      console.log(`Pagination: ${perPage}/page, total: ${totalCount}, endpoint: ${graphqlEndpoint}`);

      for (let offset = perPage; offset < totalCount; offset += perPage) {
        if (allProperties.length >= totalCount) break;

        const payload = JSON.parse(JSON.stringify(listingsPayload));
        payload.variables.offset = offset;

        console.log(`GraphQL offset ${offset}, limit ${perPage}`);

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
        console.log(`Offset ${offset}: got ${pageProps.length} properties from GraphQL`);

        let added = 0;
        for (const p of pageProps) {
          if (!existingIds.has(p.id)) {
            allProperties.push(p);
            existingIds.add(p.id);
            added++;
          }
        }
        console.log(`Offset ${offset}: added ${added} new (total: ${allProperties.length}/${totalCount})`);

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
