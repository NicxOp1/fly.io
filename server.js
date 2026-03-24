const http = require('http');
const puppeteer = require('puppeteer-core');

const TOKEN = process.env.TOKEN || 'aria-secret-token-2024';
const PORT = process.env.PORT || 3000;

// Intercept the GraphQL response directly from the browser
async function getFeaturedListings(offset = 0, limit = 12) {
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36');

    let graphqlData = null;

    // Intercept the Properties GraphQL response
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/api-gw/graphql')) {
        try {
          const json = await response.json();
          if (json.data && json.data.properties) {
            graphqlData = json;
          }
        } catch (e) {}
      }
    });

    // Navigate to the featured/sale page
    await page.goto('https://soldbyaria.com/properties/sale', {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    // Wait for the GraphQL response to be captured
    let attempts = 0;
    while (!graphqlData && attempts < 20) {
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }

    // If we need a different page/offset, make the request from within the browser
    if (graphqlData && (offset > 0 || limit !== 12)) {
      graphqlData = await page.evaluate(async (vars) => {
        const res = await fetch('/api-gw/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `query Properties($companyId: String, $featuredListing: Boolean, $leaseProperty: Boolean, $statusIds: [String!], $hostname: String, $websiteId: ID, $limit: Int, $offset: Int, $sort: String, $sortDir: SortDirection) {
              properties(companyId: $companyId featuredListing: $featuredListing leaseProperty: $leaseProperty statusIds: $statusIds hostname: $hostname websiteId: $websiteId limit: $limit offset: $offset sort: $sort sortDir: $sortDir) {
                id name status salesPrice reducedPrice bedroomCount bathCount fullAddress addressLine1 addressCity addressState postalCode description media { largeUrl } slug fromMLS mlsId livingSpaceSize lotAreaSize tags latitude longitude
              }
              propertiesCount(companyId: $companyId featuredListing: $featuredListing leaseProperty: $leaseProperty statusIds: $statusIds hostname: $hostname websiteId: $websiteId) { count }
            }`,
            variables: vars
          })
        });
        return await res.json();
      }, {
        sort: 'salesPrice',
        limit: limit,
        offset: offset,
        sortDir: 'DESC',
        companyId: 'caeac835-f013-4c92-a076-2b7ce0775c9a',
        featuredListing: true,
        leaseProperty: false,
        statusIds: [
          '5f528253-abb7-484e-95c3-330269ac1105',
          '959c11cf-8655-4f91-874c-292b0ab7ea6b',
          'a0012964-4f51-4430-abf8-6547c5ab6441',
          'df04ccbe-4621-4140-a504-ee1a17430bb7',
          '88b4ace6-f39b-4b25-a051-8f6dba976833',
          '96031d77-bbe5-4de3-90d8-1e4e70de8ca8'
        ],
        hostname: 'soldbyaria.com',
        websiteId: '0e050f8b-3c2a-4ddd-b3f6-b567291a8876'
      });
    }

    return graphqlData;
  } finally {
    await browser.close();
  }
}

// Get ALL pages of featured listings
async function getAllFeatured() {
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36');

    // First load the page to get session
    await page.goto('https://soldbyaria.com/properties/sale', {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    // Now paginate through all featured listings from inside the browser
    const allData = await page.evaluate(async () => {
      const allProperties = [];
      let offset = 0;
      const limit = 50;
      let totalCount = null;

      while (true) {
        const res = await fetch('/api-gw/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `query Properties($companyId: String, $featuredListing: Boolean, $leaseProperty: Boolean, $statusIds: [String!], $hostname: String, $websiteId: ID, $limit: Int, $offset: Int, $sort: String, $sortDir: SortDirection) {
              properties(companyId: $companyId featuredListing: $featuredListing leaseProperty: $leaseProperty statusIds: $statusIds hostname: $hostname websiteId: $websiteId limit: $limit offset: $offset sort: $sort sortDir: $sortDir) {
                id name status salesPrice reducedPrice bedroomCount bathCount fullBathCount halfBathCount fullAddress addressLine1 addressLine2 addressCity addressState postalCode description media { largeUrl mediumUrl } slug fromMLS mlsId livingSpaceSize livingSpaceUnits lotAreaSize lotAreaUnits tags latitude longitude leaseProperty leasePrice currency priceUponRequest
              }
              propertiesCount(companyId: $companyId featuredListing: $featuredListing leaseProperty: $leaseProperty statusIds: $statusIds hostname: $hostname websiteId: $websiteId) { count }
            }`,
            variables: {
              sort: 'salesPrice', limit, offset, sortDir: 'DESC',
              companyId: 'caeac835-f013-4c92-a076-2b7ce0775c9a',
              featuredListing: true, leaseProperty: false,
              statusIds: ['5f528253-abb7-484e-95c3-330269ac1105','959c11cf-8655-4f91-874c-292b0ab7ea6b','a0012964-4f51-4430-abf8-6547c5ab6441','df04ccbe-4621-4140-a504-ee1a17430bb7','88b4ace6-f39b-4b25-a051-8f6dba976833','96031d77-bbe5-4de3-90d8-1e4e70de8ca8'],
              hostname: 'soldbyaria.com',
              websiteId: '0e050f8b-3c2a-4ddd-b3f6-b567291a8876'
            }
          })
        });

        const json = await res.json();
        if (!json.data || !json.data.properties) break;

        if (totalCount === null) {
          totalCount = json.data.propertiesCount?.count || 0;
        }

        allProperties.push(...json.data.properties);
        offset += limit;

        if (allProperties.length >= totalCount || json.data.properties.length < limit) break;
      }

      return { properties: allProperties, totalCount };
    });

    return allData;
  } finally {
    await browser.close();
  }
}

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    // Without token = health check
    if (!token) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // With token = get all featured listings (GET for easy n8n use)
    if (token !== TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    try {
      console.log('Fetching all featured listings...');
      const data = await getAllFeatured();
      console.log(`Done: ${data.properties.length} of ${data.totalCount} properties`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST = custom query with pagination params
  if (req.method === 'POST') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token') || req.headers['x-token'];
    if (token !== TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { offset = 0, limit = 12 } = JSON.parse(body || '{}');
        console.log(`Fetching featured: offset=${offset} limit=${limit}`);
        const data = await getFeaturedListings(offset, limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
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
  console.log(`Aria cookie proxy running on port ${PORT}`);
});
