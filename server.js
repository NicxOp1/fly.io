const http = require('http');
const puppeteer = require('puppeteer-core');

const TOKEN = process.env.TOKEN || 'aria-secret-token-2024';
const RAGIE_API_KEY = process.env.RAGIE_API_KEY || '';
const PORT = process.env.PORT || 3000;
const RAGIE_SOURCE = 'aria-listings';

async function ragieRequest(method, path, body) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${RAGIE_API_KEY}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.ragie.ai${path}`, opts);
  if (method === 'DELETE') return { status: 'ok' };
  return res.json();
}

async function deleteAriaDocsFromRagie() {
  let deleted = 0;
  let cursor = null;

  // Paginate through all docs, delete ones with source=aria-listings
  while (true) {
    const url = cursor ? `/documents?cursor=${cursor}&page_size=100` : '/documents?page_size=100';
    const data = await ragieRequest('GET', url);
    const docs = data.documents || [];

    for (const doc of docs) {
      if (doc.metadata?.source === RAGIE_SOURCE) {
        await ragieRequest('DELETE', `/documents/${doc.id}`);
        deleted++;
        console.log(`Deleted Ragie doc: ${doc.name} (${doc.id})`);
      }
    }

    cursor = data.pagination?.next_cursor;
    if (!cursor || docs.length === 0) break;
  }

  return deleted;
}

async function createAriaDocsInRagie(properties) {
  let created = 0;

  for (const p of properties) {
    const slug = p.slug || '';
    const url = slug ? `https://soldbyaria.com/properties/${slug}` : '';
    const address = p.fullAddress || `${p.addressLine1 || ''}, ${p.addressCity || ''}, ${p.addressState || ''} ${p.postalCode || ''}`;

    const content = [
      `Property: ${address}`,
      `Price: $${(p.salesPrice || 0).toLocaleString()}`,
      p.reducedPrice ? `Reduced Price: $${p.reducedPrice.toLocaleString()}` : '',
      `Bedrooms: ${p.bedroomCount || 'N/A'}`,
      `Bathrooms: ${p.bathCount || 'N/A'} (Full: ${p.fullBathCount || 0}, Half: ${p.halfBathCount || 0})`,
      p.livingSpaceSize ? `Living Space: ${p.livingSpaceSize} ${p.livingSpaceUnits || 'sqft'}` : '',
      p.lotAreaSize ? `Lot: ${p.lotAreaSize} ${p.lotAreaUnits || 'sqft'}` : '',
      p.neighborhood ? `Neighborhood: ${p.neighborhood}` : '',
      p.status ? `Status: ${p.status}` : '',
      p.officeName ? `Office: ${p.officeName}` : '',
      p.mlsId ? `MLS ID: ${p.mlsId}` : '',
      url ? `URL: ${url}` : '',
      '',
      p.description || ''
    ].filter(Boolean).join('\n');

    const metadata = {
      source: RAGIE_SOURCE,
      property_id: p.id,
      address,
      city: p.addressCity || '',
      state: p.addressState || '',
      zip: p.postalCode || '',
      price: p.salesPrice || 0,
      bedrooms: p.bedroomCount || 0,
      bathrooms: p.bathCount || 0,
      url
    };

    await ragieRequest('POST', '/documents/raw', {
      name: address,
      data: content,
      external_id: `aria-${p.id}`,
      metadata
    });

    created++;
    console.log(`Created Ragie doc ${created}/${properties.length}: ${address}`);
  }

  return created;
}

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

  // Sync to Ragie: scrape + delete old + create new
  if (req.method === 'GET' && req.url.includes('/sync') && req.url.includes('token=')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.searchParams.get('token') !== TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (!RAGIE_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'RAGIE_API_KEY not configured' }));
      return;
    }

    try {
      console.log('=== Starting Ragie sync ===');
      const start = Date.now();

      // 1. Scrape
      console.log('Step 1: Scraping...');
      const data = await getAllFeatured();
      console.log(`Scraped ${data.properties.length}/${data.totalCount} properties`);

      // 2. Delete old docs
      console.log('Step 2: Deleting old Ragie docs...');
      const deleted = await deleteAriaDocsFromRagie();
      console.log(`Deleted ${deleted} old docs`);

      // 3. Create new docs
      console.log('Step 3: Creating new Ragie docs...');
      const created = await createAriaDocsInRagie(data.properties);
      console.log(`Created ${created} new docs`);

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`=== Sync complete in ${elapsed}s ===`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        scraped: data.properties.length,
        deleted,
        created,
        elapsed: `${elapsed}s`
      }));
    } catch (err) {
      console.error('Sync error:', err.message);
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
