# xgrowth-api

Cloudflare Worker that proxies the GrowOS Content Engine to Google Gemini.
The Gemini API key lives **only** as a Wrangler secret — never in code, never in git, never in the browser.

## One-time setup

From `worker/`:

```bash
npm install
npx wrangler login                       # opens browser; sign in with Cloudflare
npx wrangler secret put GEMINI_API_KEY   # paste your Gemini key when prompted
npx wrangler deploy                      # ships to xgrowth-api.xgrowth.workers.dev
```

## Day-to-day

```bash
npx wrangler deploy   # redeploy after editing src/index.js
npx wrangler tail     # live request logs
npx wrangler dev      # local dev at http://localhost:8787
```

## Endpoints

- `GET /health` — sanity check, returns `{ ok: true }`
- `POST /generate` — body: `{ topic, articleTitle, articleAngle?, articleUrl?, platform, mode? }`

CORS is locked to `xgrowth.uno`, `www.xgrowth.uno`, `sndp-design.github.io`, and `localhost` dev origins.
