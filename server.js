const http = require('http');
const puppeteer = require('puppeteer-core');

const TOKEN = process.env.TOKEN || 'aria-secret-token-2024';
const PORT = process.env.PORT || 3000;

async function scrapeFeatured() {
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1440, height: 900 });

    // Capture ALL GraphQL responses (the page's own SSR data)
    const capturedData = [];
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (url.includes('graphql') || url.includes('api-gw')) {
          const text = await response.text();
          if (text.includes('properties') || text.includes('salesPrice')) {
            capturedData.push({ url, data: text.substring(0, 5000) });
          }
        }
      } catch(e) {}
    });

    console.log('Navigating to properties page...');
    await page.goto('https://soldbyaria.com/properties/sale', {
      waitUntil: 'networkidle0',
      timeout: 60000
    });

    // Wait for property cards to render
    await page.waitForSelector('a[href*="/properties/"], a[href*="/listing/"], [class*="property"], [class*="listing"], [class*="card"]', { timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    // Extract property data from the rendered DOM
    const properties = await page.evaluate(() => {
      const results = [];

      // Try multiple selector strategies
      const cards = document.querySelectorAll(
        'a[href*="/properties/"], a[href*="/listing/"], [data-property-id], [class*="PropertyCard"], [class*="propertyCard"], [class*="listing-card"], [class*="ListingCard"]'
      );

      cards.forEach(card => {
        try {
          const link = card.closest('a') || card.querySelector('a');
          const href = link ? link.getAttribute('href') : null;
          const slug = href ? href.split('/').pop() : null;

          // Price
          const priceEl = card.querySelector('[class*="rice"], [class*="amount"], [data-price]');
          const priceText = priceEl ? priceEl.textContent.trim() : '';
          const price = priceText ? parseInt(priceText.replace(/[^0-9]/g, '')) || null : null;

          // Address
          const addressEl = card.querySelector('[class*="ddress"], [class*="location"]');
          const address = addressEl ? addressEl.textContent.trim() : '';

          // Beds/baths
          const statsText = card.textContent;
          const bedsMatch = statsText.match(/(\d+)\s*(?:bed|bd|br)/i);
          const bathsMatch = statsText.match(/(\d+(?:\.\d+)?)\s*(?:bath|ba)/i);
          const sqftMatch = statsText.match(/([\d,]+)\s*(?:sq\s*ft|sqft|sf)/i);

          // Image
          const img = card.querySelector('img');
          const image = img ? (img.src || img.getAttribute('data-src') || img.getAttribute('srcset')?.split(' ')[0]) : null;

          if (href || price || address) {
            results.push({
              slug,
              href,
              price,
              priceText,
              address,
              beds: bedsMatch ? parseInt(bedsMatch[1]) : null,
              baths: bathsMatch ? parseFloat(bathsMatch[1]) : null,
              sqft: sqftMatch ? parseInt(sqftMatch[1].replace(/,/g, '')) : null,
              image
            });
          }
        } catch(e) {}
      });

      return results;
    });

    // Also get the raw page HTML structure for debugging
    const pageInfo = await page.evaluate(() => {
      return {
        title: document.title,
        url: window.location.href,
        bodyClasses: document.body.className,
        propertyCardCount: document.querySelectorAll('a[href*="/properties/"]').length,
        allLinksWithProperties: Array.from(document.querySelectorAll('a[href*="/properties/"]')).slice(0, 5).map(a => ({
          href: a.getAttribute('href'),
          text: a.textContent.substring(0, 100).trim()
        }))
      };
    });

    return {
      properties,
      count: properties.length,
      pageInfo,
      capturedNetworkData: capturedData.length,
      networkSamples: capturedData.slice(0, 2)
    };
  } finally {
    await browser.close();
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method === 'GET' && req.url.includes('token=')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.searchParams.get('token') !== TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    try {
      console.log('Starting scrape...');
      const start = Date.now();
      const data = await scrapeFeatured();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`Done: ${data.count} properties scraped in ${elapsed}s`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, stack: err.stack }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Aria scraper running on port ${PORT}`);
});
