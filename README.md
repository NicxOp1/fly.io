# Aria Browserless

Browserless Chrome instance for scraping Aria Properties featured listings.

## Deploy to Fly.io

```bash
fly launch --copy-config --yes
```

## Usage

Once deployed, the Cloudflare Worker uses this to get fresh browser cookies that bypass Cloudflare challenges.

Endpoint: `https://aria-browserless.fly.dev`
Token: `aria-secret-token-2024`

## Cost

With `auto_stop_machines = true`, the machine only runs when called. For a daily scrape job, cost is near zero.
