/**
 * XGrowth Content Engine — Cloudflare Worker proxy to Google Gemini.
 *
 * Endpoints:
 *   POST /generate  Body shape depends on `kind`:
 *
 *     kind: "post" (default — Content Engine)
 *       { topic, articleTitle, articleAngle?, platform, mode?,
 *         voiceNiche?, voiceStyle?, inputMode? }
 *
 *     kind: "campaign"  (Campaign Builder)
 *       { campaignType, hook, days, budget, channels[], niche?, voiceNiche?, voiceStyle? }
 *
 *     kind: "copy"      (Website Copy)
 *       { name, what, bio, cta, niche?, voiceNiche?, voiceStyle? }
 *
 *     kind: "audit"     (Content Auditor)
 *       { handle, posts: string[], niche? }
 *
 *     kind: "report"    (Weekly narrative)
 *       { niche, metrics: { followersWoW, impressions7, engagement7, visits7, topPost? } }
 *
 *   POST /preview      { url }  — fetch a URL server-side, return { title, description }
 *   GET  /health       health check (no auth)
 *
 * Auth: every non-health request requires `Authorization: Bearer <firebase-id-token>`.
 * The token is verified against Firebase's JWKS — only signed-in XGrowth users can call.
 *
 * GEMINI_API_KEY lives ONLY as a Wrangler secret. Never sent to the browser.
 * CORS locked to known XGrowth origins.
 */

const ALLOWED_ORIGINS = [
  'https://www.xgrowth.uno',
  'https://xgrowth.uno',
  'https://sndp-design.github.io',
  'http://localhost:8000',
  'http://localhost:3000',
  'http://127.0.0.1:8000',
  'http://127.0.0.1:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

const FIREBASE_PROJECT_ID = 'xgrowth-351de';
const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
const FIREBASE_JWKS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

// Try models in order; first one that responds wins.
const GEMINI_MODELS = [
  'gemini-2.0-flash',          // stable, fast, widely available
  'gemini-2.0-flash-lite',     // lighter fallback
  'gemini-1.5-flash',          // last resort — always available
];
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, allowed) });
    }

    // Lock to known origins
    if (!allowed) {
      return json({ error: 'Origin not allowed' }, 403, origin, allowed);
    }

    const url = new URL(request.url);

    // Health check (no auth)
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'xgrowth-api', endpoints: ['/generate', '/preview'] }, 200, origin, allowed);
    }

    if (request.method !== 'POST') {
      return json({ error: 'Use POST' }, 405, origin, allowed);
    }

    const VALID_PATHS = ['/generate', '/generate-image', '/preview', '/news', '/x-profile'];
    if (!VALID_PATHS.includes(url.pathname)) {
      return json({ error: 'Not found' }, 404, origin, allowed);
    }

    // Auth — verify Firebase ID token
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      return json({ error: 'Missing Authorization bearer token' }, 401, origin, allowed);
    }
    try {
      await verifyFirebaseIdToken(token, ctx);
    } catch (e) {
      return json({ error: 'Auth failed: ' + (e.message || 'invalid token') }, 401, origin, allowed);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, origin, allowed);
    }

    // ── /generate-image ───────────────────────────────────────────────────────
    if (url.pathname === '/generate-image') {
      const { prompt, provider = 'gemini' } = body;
      if (!prompt || typeof prompt !== 'string') {
        return json({ error: 'Missing prompt' }, 400, origin, allowed);
      }

      // Pollinations: stream image binary directly — zero base64/CPU overhead,
      // and the request is server-to-server so browser ad-blockers can't interfere.
      if (provider === 'pollinations') {
        const { model: pollinationsModel = 'flux', seed } = body;
        try {
          const imgResp = await callPollinationsProxy(prompt, pollinationsModel, seed);
          const ct = imgResp.headers.get('content-type') || 'image/jpeg';
          return new Response(imgResp.body, {
            status: 200,
            headers: {
              'Content-Type': ct.split(';')[0].trim(),
              'Cache-Control': 'no-store',
              ...corsHeaders(origin, allowed),
            },
          });
        } catch (err) {
          return json({ error: 'Image generation failed: ' + (err.message || 'unknown') }, 502, origin, allowed);
        }
      }

      // HF / Gemini — return base64 JSON as before
      try {
        let result;
        if (provider.startsWith('hf-')) {
          if (!env.HF_TOKEN) return json({ error: 'HF_TOKEN secret not configured — run: npx wrangler secret put HF_TOKEN' }, 500, origin, allowed);
          result = await callHuggingFaceImage(env.HF_TOKEN, prompt, provider);
        } else {
          if (!env.GEMINI_API_KEY) return json({ error: 'Server missing GEMINI_API_KEY secret' }, 500, origin, allowed);
          result = await callGeminiImage(env.GEMINI_API_KEY, prompt);
        }
        return json({ ok: true, ...result }, 200, origin, allowed);
      } catch (err) {
        return json({ error: 'Image generation failed: ' + (err.message || 'unknown') }, 502, origin, allowed);
      }
    }

    // ── /preview ──────────────────────────────────────────────────────────────
    if (url.pathname === '/preview') {
      return handlePreview(body, origin, allowed);
    }

    // ── /x-profile — fetch recent posts from an X/Twitter profile via Nitter ──
    if (url.pathname === '/x-profile') {
      return handleXProfile(body, origin, allowed);
    }

    // ── /news — multi-source RSS aggregator ───────────────────────────────────
    if (url.pathname === '/news') {
      return handleNews(body, origin, allowed);
    }

    // ── /generate ─────────────────────────────────────────────────────────────
    const kind = body.kind || 'post';
    if (!env.GEMINI_API_KEY) {
      return json({ error: 'Server missing GEMINI_API_KEY secret' }, 500, origin, allowed);
    }

    let prompt, postProcess = (t) => t;
    try {
      if (kind === 'post') {
        const { topic, articleTitle, articleAngle, platform, voiceNiche, voiceStyle, inputMode, refineInstruction } = body;
        const mode = body.mode || 'hot-take';
        if (!articleTitle || typeof articleTitle !== 'string') {
          return json({ error: 'Missing articleTitle' }, 400, origin, allowed);
        }
        if (!['linkedin', 'x', 'threads', 'instagram', 'reddit'].includes(platform)) {
          return json({ error: 'platform must be linkedin | x | threads | instagram | reddit' }, 400, origin, allowed);
        }
        prompt = buildPostPrompt({ topic, articleTitle, articleAngle, platform, mode, voiceNiche, voiceStyle, inputMode, refineInstruction });
        if (platform === 'x' && mode !== 'thread') postProcess = trimForX;
        else if (platform === 'threads') postProcess = (t) => trimAtSentence(t, 500);
        const { text, model } = await callGemini(env.GEMINI_API_KEY, prompt);
        return json({ ok: true, text: postProcess(text), platform, mode, model }, 200, origin, allowed);
      }

      if (kind === 'campaign') {
        prompt = buildCampaignPrompt(body);
      } else if (kind === 'copy') {
        prompt = buildCopyPrompt(body);
      } else if (kind === 'audit') {
        if (!Array.isArray(body.posts) || !body.posts.length) {
          return json({ error: 'audit requires non-empty posts[]' }, 400, origin, allowed);
        }
        prompt = buildAuditPrompt(body);
      } else if (kind === 'report') {
        prompt = buildReportPrompt(body);
      } else if (kind === 'brand-kit') {
        prompt = buildBrandKitPrompt(body);
      } else if (kind === 'image-prompt') {
        prompt = buildImagePromptPrompt(body);
      } else if (kind === 'email-sequence') {
        prompt = buildEmailSequencePrompt(body);
      } else if (kind === 'growth-experiments') {
        prompt = buildGrowthExperimentsPrompt(body);
      } else if (kind === 'pulse') {
        prompt = buildPulsePrompt(body);
      } else if (kind === 'icp') {
        prompt = buildIcpPrompt(body);
      } else if (kind === 'ph-launch') {
        prompt = buildPhLaunchPrompt(body);
      } else {
        return json({ error: 'Unknown kind: ' + kind }, 400, origin, allowed);
      }

      const { text, model } = await callGemini(env.GEMINI_API_KEY, prompt);
      return json({ ok: true, text, kind, model }, 200, origin, allowed);
    } catch (err) {
      return json({ error: 'Generation failed: ' + (err.message || 'unknown') }, 502, origin, allowed);
    }
  },
};

/* ─── /news — multi-source RSS aggregator ────────────────────────────────── */

// Full portal catalog — id → { name, url }.  All are free public RSS feeds.
const PORTAL_CATALOG = {
  // AI / ML
  'venturebeat-ai':   { name:'VentureBeat AI',      url:'https://venturebeat.com/category/ai/feed/' },
  'techcrunch-ai':    { name:'TechCrunch AI',        url:'https://techcrunch.com/category/artificial-intelligence/feed/' },
  'mit-tech-review':  { name:'MIT Tech Review',      url:'https://www.technologyreview.com/feed/' },
  'ai-news':          { name:'AI News',              url:'https://www.artificialintelligence-news.com/feed/' },
  'the-register-ai':  { name:'The Register',         url:'https://www.theregister.com/emergent_tech/ai-and-ml/headlines.atom' },
  // Climate Tech
  'cleantechnica':    { name:'CleanTechnica',        url:'https://cleantechnica.com/feed/' },
  'electrek':         { name:'Electrek',             url:'https://electrek.co/feed/' },
  'carbon-brief':     { name:'Carbon Brief',         url:'https://www.carbonbrief.org/feed' },
  'greenbiz':         { name:'GreenBiz',             url:'https://www.greenbiz.com/feeds/rss' },
  'canary-media':     { name:'Canary Media',         url:'https://www.canarymedia.com/articles.rss' },
  // Fintech
  'finextra':            { name:'Finextra',              url:'https://www.finextra.com/rss/pressrelease.xml' },
  'techcrunch-fintech':  { name:'TechCrunch Fintech',    url:'https://techcrunch.com/category/fintech/feed/' },
  'payments-dive':       { name:'Payments Dive',         url:'https://www.paymentsdive.com/feeds/news/' },
  'banking-dive':        { name:'Banking Dive',          url:'https://www.bankingdive.com/feeds/news/' },
  // Health Tech
  'stat-news':         { name:'STAT News',           url:'https://www.statnews.com/feed/' },
  'medcity-news':      { name:'MedCity News',        url:'https://medcitynews.com/feed/' },
  'healthcare-dive':   { name:'Healthcare Dive',     url:'https://www.healthcaredive.com/feeds/news/' },
  'fierce-healthcare': { name:'Fierce Healthcare',   url:'https://www.fiercehealthcare.com/rss/xml' },
  // SaaS / B2B
  'saastr':      { name:'SaaStr',       url:'https://www.saastr.com/feed/' },
  'techcrunch':  { name:'TechCrunch',   url:'https://techcrunch.com/feed/' },
  'venturebeat': { name:'VentureBeat',  url:'https://venturebeat.com/feed/' },
  'the-verge':   { name:'The Verge',    url:'https://www.theverge.com/rss/index.xml' },
  // E-commerce
  'modern-retail':        { name:'Modern Retail',         url:'https://www.modernretail.co/feed/' },
  'retail-dive':          { name:'Retail Dive',           url:'https://www.retaildive.com/feeds/news/' },
  'techcrunch-commerce':  { name:'TechCrunch Commerce',   url:'https://techcrunch.com/category/e-commerce/feed/' },
  // Crypto / Web3
  'coindesk':      { name:'CoinDesk',      url:'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  'cointelegraph': { name:'CoinTelegraph', url:'https://cointelegraph.com/rss' },
  'decrypt':       { name:'Decrypt',       url:'https://decrypt.co/feed' },
  'the-block':     { name:'The Block',     url:'https://www.theblock.co/rss/all' },
  // Dev Tools
  'the-new-stack': { name:'The New Stack', url:'https://thenewstack.io/blog/feed/' },
  'ars-technica':  { name:'Ars Technica',  url:'https://feeds.arstechnica.com/arstechnica/index' },
  'devto':         { name:'Dev.to',        url:'https://dev.to/feed' },
  'infoq':         { name:'InfoQ',         url:'https://www.infoq.com/feed/' },
  // Biotech
  'fierce-biotech':  { name:'Fierce Biotech',  url:'https://www.fiercebiotech.com/rss/xml' },
  'biopharma-dive':  { name:'BioPharma Dive',  url:'https://www.biopharmadive.com/feeds/news/' },
  'endpoints-news':  { name:'Endpoints News',  url:'https://endpts.com/feed/' },
  // EdTech
  'edsurge':           { name:'EdSurge',            url:'https://www.edsurge.com/news.rss' },
  'techcrunch-edtech': { name:'TechCrunch EdTech',  url:'https://techcrunch.com/category/edtech/feed/' },
  // Shared / General
  'wired':         { name:'Wired',         url:'https://www.wired.com/feed/rss' },
};

// Industry → default portals (used when user hasn't set custom portals)
const INDUSTRY_DEFAULT_PORTALS = {
  'ai-ml':        ['venturebeat-ai','techcrunch-ai','mit-tech-review','ai-news','the-register-ai'],
  'climate-tech': ['cleantechnica','electrek','carbon-brief','greenbiz','canary-media'],
  'fintech':      ['finextra','techcrunch-fintech','payments-dive','banking-dive'],
  'health-tech':  ['stat-news','medcity-news','healthcare-dive','fierce-healthcare'],
  'saas-b2b':     ['saastr','techcrunch','venturebeat','the-verge'],
  'ecommerce':    ['modern-retail','retail-dive','techcrunch-commerce'],
  'crypto-web3':  ['coindesk','cointelegraph','decrypt','the-block'],
  'dev-tools':    ['the-new-stack','ars-technica','devto','infoq'],
  'biotech':      ['stat-news','fierce-biotech','biopharma-dive','endpoints-news'],
  'edtech':       ['edsurge','techcrunch-edtech','the-verge'],
  'general':      ['techcrunch','the-verge','wired','venturebeat','ars-technica','mit-tech-review'],
};

async function handleNews(body, origin, allowed) {
  const topic = ((body && body.topic) || '').trim();
  if (!topic) return json({ error: 'topic required' }, 400, origin, allowed);

  const keywords = topic.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  // Determine which portals to use:
  //   1. User-selected portals from their profile (explicit list)
  //   2. Industry defaults (when user set industry but no explicit portal list)
  //   3. General defaults (fallback)
  let portalIds = Array.isArray(body.portals) && body.portals.length ? body.portals : null;
  if (!portalIds) {
    const ind = (body.industry || 'general').toLowerCase().trim().replace(/[^a-z-]/g, '');
    portalIds = INDUSTRY_DEFAULT_PORTALS[ind] || INDUSTRY_DEFAULT_PORTALS['general'];
  }

  // Resolve portal IDs → feed objects (skip unknown IDs gracefully)
  const feeds = portalIds
    .filter(id => PORTAL_CATALOG[id])
    .map(id => ({ name: PORTAL_CATALOG[id].name, url: PORTAL_CATALOG[id].url }));

  // Safety: always have at least the general defaults
  if (!feeds.length) {
    INDUSTRY_DEFAULT_PORTALS['general'].forEach(id => {
      if (PORTAL_CATALOG[id]) feeds.push({ name: PORTAL_CATALOG[id].name, url: PORTAL_CATALOG[id].url });
    });
  }

  const feedResults = await Promise.allSettled(
    feeds.map(feed => fetchAndFilterFeed(feed, keywords))
  );

  let articles = [];
  for (const r of feedResults) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) articles.push(...r.value);
  }

  articles.sort((a, b) => {
    const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const db2 = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return db2 - da;
  });
  articles = articles.slice(0, 20);

  return json({ ok: true, articles }, 200, origin, allowed);
}

async function fetchAndFilterFeed(feed, keywords) {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; XGrowthBot/1.0; +https://xgrowth.uno)' },
    });
    clearTimeout(tid);
    if (!res.ok) return [];
    const xml = await res.text();
    const articles = parseRssXml(xml, feed.name);
    // Filter to articles that contain at least one keyword in title or description
    return articles.filter(a => {
      const hay = (a.title + ' ' + a.description).toLowerCase();
      return keywords.some(kw => hay.includes(kw));
    }).slice(0, 5); // max 5 per source
  } catch {
    return [];
  }
}

/* Lightweight RSS/Atom parser — no DOM dependency, regex-based.
   Handles CDATA sections, both RSS <item> and Atom <entry> formats. */
function parseRssXml(xml, sourceName) {
  const articles = [];

  // Determine format: RSS uses <item>, Atom uses <entry>
  const isAtom = !/<item[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const blockTag = isAtom ? 'entry' : 'item';
  const blockRe = new RegExp(`<${blockTag}[^>]*>([\\s\\S]*?)<\\/${blockTag}>`, 'gi');

  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[1];
    const title   = rssField(block, 'title');
    const link    = rssField(block, 'link') || rssAttrHref(block, 'link');
    const desc    = rssField(block, 'description') || rssField(block, 'summary') || rssField(block, 'content\\:encoded') || rssField(block, 'content');
    const pubDate = rssField(block, 'pubDate') || rssField(block, 'published') || rssField(block, 'updated') || rssField(block, 'dc:date');
    if (title && link) {
      articles.push({
        title,
        url:         link,
        description: stripHtml(desc).slice(0, 250),
        pubDate,
        source:      sourceName,
      });
    }
  }

  return articles;
}

// Extract text content of an XML element (handles CDATA and plain text)
function rssField(block, tag) {
  const re = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  let m = re.exec(block);
  if (m) return m[1].trim();
  const re2 = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  m = re2.exec(block);
  if (m) return stripHtml(m[1]).trim();
  return '';
}

// Extract href attribute from a self-closing or opening tag (e.g. Atom <link href="..."/>)
function rssAttrHref(block, tag) {
  const m = new RegExp(`<${tag}[^>]*\\shref="([^"]+)"`, 'i').exec(block);
  return m ? m[1].trim() : '';
}

function stripHtml(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ').trim();
}

/* ─── /preview handler ────────────────────────────────────────────────────── */

async function handlePreview(body, origin, allowed) {
  const { url: articleUrl } = body;
  if (!articleUrl || typeof articleUrl !== 'string') {
    return json({ error: 'Missing url' }, 400, origin, allowed);
  }
  try {
    const resp = await fetch(articleUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; XGrowthBot/1.0; +https://xgrowth.uno)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!resp.ok) {
      return json({ error: 'Could not fetch URL', status: resp.status }, 502, origin, allowed);
    }
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('html')) {
      return json({ error: 'Not an HTML page' }, 400, origin, allowed);
    }
    const html = await resp.text();
    const slice = html.slice(0, 60000);

    const extractMeta = (patterns) => {
      for (const re of patterns) {
        const m = slice.match(re);
        if (m?.[1]) return m[1].trim();
      }
      return '';
    };

    const rawTitle = extractMeta([
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
      /<title[^>]*>([^<]+)<\/title>/i,
    ]);
    const rawDesc = extractMeta([
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{10,})["']/i,
      /<meta[^>]+content=["']([^"']{10,})["'][^>]+property=["']og:description["']/i,
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,})["']/i,
      /<meta[^>]+content=["']([^"']{10,})["'][^>]+name=["']description["']/i,
    ]);

    // Decode all HTML entities — handles &amp; &lt; &#39; &#039; &#x27; etc.
    const decode = s => s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').trim();

    return json({ ok: true, title: decode(rawTitle), description: decode(rawDesc) }, 200, origin, allowed);
  } catch (e) {
    return json({ error: 'Preview failed: ' + (e.message || 'unknown') }, 502, origin, allowed);
  }
}

/* ─── X / Twitter profile via Nitter RSS ─────────────────────────────────── */

async function handleXProfile(body, origin, allowed) {
  let username = (body.username || '').trim().replace(/^@/, '');
  // If a full URL was passed, extract just the handle
  username = username.replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, '').split('/')[0];
  username = username.replace(/[^A-Za-z0-9_]/g, '');
  if (!username) return json({ error: 'username is required' }, 400, origin, allowed);

  // Try multiple Nitter instances in order; return first successful one
  const instances = [
    'nitter.poast.org',
    'nitter.privacydev.net',
    'nitter.net',
    'nitter.cz',
    'nitter.1d4.us',
  ];

  for (const host of instances) {
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 7000);
      const res  = await fetch(`https://${host}/${username}/rss`, {
        signal:  ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; XGrowthBot/1.0; +https://xgrowth.uno)' },
      });
      clearTimeout(tid);
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('xml') && !ct.includes('rss') && !ct.includes('text')) continue;
      const xml = await res.text();
      if (!xml.includes('<item>')) continue;
      const posts = parseNitterRSS(xml, username);
      if (!posts.length) continue;
      return json({ posts, source: host }, 200, origin, allowed);
    } catch { continue; }
  }

  return json({
    posts: [],
    error: "Couldn't reach X right now — Nitter instances may be rate-limited. Try again in a few minutes.",
  }, 200, origin, allowed);
}

function parseNitterRSS(xml, username) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
  const posts = [];
  for (const item of items.slice(0, 15)) {
    // Extract tweet text — prefer CDATA title, fall back to plain title
    const titleCdata = (item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || [])[1];
    const titlePlain = (item.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    const rawText    = (titleCdata || titlePlain).trim();

    // Strip "R to @user:" reply prefix
    const text = rawText.replace(/^R to @\w+:\s*/i, '').trim();
    if (!text || text.length < 10) continue;

    // pubDate
    const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';

    // Link — strip nitter domain, rebuild as x.com URL
    const rawLink = (item.match(/<link>\s*(https?:\/\/[^<\s]+)\s*<\/link>/) ||
                     item.match(/<guid[^>]*>\s*(https?:\/\/[^<\s]+)\s*<\/guid>/) || [])[1] || '';
    const tweetId  = (rawLink.match(/\/status\/(\d+)/) || [])[1];
    const xUrl     = tweetId
      ? `https://x.com/${username}/status/${tweetId}`
      : rawLink.replace(/^https?:\/\/[^/]+/, 'https://x.com');

    posts.push({ text, date: pubDate, url: xUrl });
  }
  return posts;
}

/* ─── trim helpers ────────────────────────────────────────────────────────── */

function trimAtSentence(text, limit) {
  if (!text || text.length <= limit) return text;
  const re = /[.!?](\s|$)/g;
  const boundaries = [];
  let m;
  while ((m = re.exec(text)) !== null) boundaries.push(m.index + 1);
  const cut = boundaries.reverse().find(b => b <= limit);
  if (cut) return text.slice(0, cut).trim();
  const slice = text.slice(0, limit - 1);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 30 ? slice.slice(0, lastSpace) : slice).trim() + '…';
}

function trimForX(text) {
  if (!text || text.length <= 280) return text;
  const lines = text.split('\n');
  let urlIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^https?:\/\//.test(lines[i].trim())) { urlIdx = i; break; }
  }
  let url = '', before = text;
  if (urlIdx >= 0) {
    url = lines[urlIdx].trim();
    before = lines.slice(0, urlIdx).join('\n').trim();
  }
  const sep = url ? '\n\n' : '';
  const budget = 280 - url.length - sep.length;
  if (budget <= 0) return url || text.slice(0, 277) + '…';
  const trimmed = trimAtSentence(before, budget);
  return url ? `${trimmed}${sep}${url}` : trimmed;
}

/* ─── CORS helpers ────────────────────────────────────────────────────────── */

function corsHeaders(origin, allowed) {
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status, origin, allowed) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin, allowed) },
  });
}

/* ─── Firebase ID-token verification ─────────────────────────────────────── */

// Cache the x509 cert map in module scope for the life of the isolate.
let _certCache = { keys: null, expiresAt: 0 };

async function loadFirebaseCerts() {
  const now = Date.now();
  if (_certCache.keys && now < _certCache.expiresAt) return _certCache.keys;

  const resp = await fetch(FIREBASE_JWKS_URL);
  if (!resp.ok) throw new Error('Could not fetch Firebase certs');
  const data = await resp.json();

  // Cache-Control: public, max-age=N — honour it (default 1h)
  const cc = resp.headers.get('Cache-Control') || '';
  const m = cc.match(/max-age=(\d+)/);
  const ttl = m ? parseInt(m[1], 10) * 1000 : 3600_000;
  _certCache = { keys: data, expiresAt: now + ttl };
  return data;
}

async function verifyFirebaseIdToken(token, ctx) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');

  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(atobUrl(headerB64));
  const payload = JSON.parse(atobUrl(payloadB64));

  // Claim checks first (cheap, before crypto)
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error('token expired');
  if (payload.iat && payload.iat > now + 60) throw new Error('token issued in future');
  if (payload.aud !== FIREBASE_PROJECT_ID) throw new Error('wrong audience');
  if (payload.iss !== FIREBASE_ISSUER) throw new Error('wrong issuer');
  if (!payload.sub) throw new Error('missing sub');
  if (header.alg !== 'RS256') throw new Error('unsupported alg: ' + header.alg);

  // Signature verification
  const certs = await loadFirebaseCerts();
  const pem = certs[header.kid];
  if (!pem) throw new Error('unknown kid');

  const key = await importX509Pem(pem);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = b64UrlToBytes(sigB64);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  if (!ok) throw new Error('bad signature');

  return payload; // uid in payload.sub, email in payload.email
}

function atobUrl(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}

function b64UrlToBytes(s) {
  const bin = atobUrl(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importX509Pem(pem) {
  // pem is an X.509 cert in PEM form — extract the SPKI public key.
  const b64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
  const der = b64ToBytes(b64);
  const spki = extractSpkiFromX509(der);
  return crypto.subtle.importKey(
    'spki',
    spki,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Minimal ASN.1 walk: find the SubjectPublicKeyInfo inside an X.509 cert.
// X.509 = SEQUENCE { tbsCertificate SEQUENCE { version, serial, sigAlg, issuer, validity, subject, SPKI, ... }, sigAlg, sig }
// We just need to skip into tbsCertificate and grab the 7th element (SPKI).
function extractSpkiFromX509(der) {
  const r = new DerReader(der);
  r.openSequence();                  // outer cert
  const tbsStart = r.pos;
  r.openSequence();                  // tbsCertificate
  // version [0] EXPLICIT (optional)
  if (r.peekTag() === 0xa0) r.skipElement();
  r.skipElement(); // serial
  r.skipElement(); // signature alg
  r.skipElement(); // issuer
  r.skipElement(); // validity
  r.skipElement(); // subject
  const spkiStart = r.pos;
  r.skipElement(); // SubjectPublicKeyInfo
  return der.slice(spkiStart, r.pos);
}

class DerReader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  peekTag() { return this.buf[this.pos]; }
  readLength() {
    let len = this.buf[this.pos++];
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | this.buf[this.pos++];
    }
    return len;
  }
  openSequence() {
    if (this.buf[this.pos++] !== 0x30) throw new Error('expected SEQUENCE');
    this.readLength();
  }
  skipElement() {
    this.pos++;                      // tag
    const len = this.readLength();
    this.pos += len;
  }
}

/* ─── prompt builders ─────────────────────────────────────────────────────── */

function voiceTail({ voiceNiche, voiceStyle }) {
  return voiceNiche
    ? `\nFOUNDER CONTEXT: ${voiceNiche}${voiceStyle ? ` — preferred tone: ${voiceStyle}` : ''}`
    : '';
}

const HARD_RULES = `HARD RULES — break ANY of these and the output is unusable:
- Be SPECIFIC to the actual inputs above. No generic advice.
- NO clichés: "in today's fast-paced world", "game-changer", "moving the needle", "synergy", "leveraging", "let's dive in", "thoughts?", "the future of X is Y".
- NO meta-commentary ("Here's a campaign about…", "I wanted to share…").
- NO emojis.
- NO bold/italics markdown for emphasis on prose lines (headers with ## are fine).
- Sound like a smart human operator, not a content marketer.`;

function buildPostPrompt({ topic, articleTitle, articleAngle, platform, mode, voiceNiche, voiceStyle, inputMode, refineInstruction }) {
  const isWrite = inputMode === 'freewrite';

  const platformGuides = {
    linkedin: `Write a LinkedIn post. 1000–1600 characters total.
Structure:
- 1 sharp opener sentence (not "I" or "As a founder")
- 2–4 sentences of specific reaction that references the actual content
- Optional: 2–3 bullet points using → as bullet marker (not numbers)
- 1 short question that invites a real reply (NOT "thoughts?" or "what do you think?")
- 2 hashtags max on the final line
- NO URLs anywhere in the post.`,

    x: mode === 'thread'
      ? `Write an X (Twitter) thread of exactly 6–8 tweets. HARD CONSTRAINTS:
- Format EXACTLY like this — one blank line between tweets, nothing else:
  1/ [tweet text]

  2/ [tweet text]

  3/ [tweet text]
  (continue…)
- Tweet 1: a hook that makes someone stop scrolling. A sharp claim, stat, or question. Max 220 chars.
- Tweets 2–N: each one builds on the last, delivers one specific idea, stands alone.
- Final tweet: the key takeaway or a soft CTA. No "follow me for more".
- EVERY tweet MUST be under 280 characters. COUNT before returning.
- NO hashtags. NO "thread 🧵". NO introductory tweet ("I want to share…").
- Return ONLY the numbered tweets. No preamble, no label, no "Here is your thread:".`
      : `Write a single tweet. HARD CONSTRAINT: 280 characters TOTAL — every character counts.
- 1–2 punchy lines with a specific take
- NO hashtags, NO "thoughts?", NO threads, NO URLs
- BEFORE returning, COUNT your characters. If over 280, rewrite shorter.`,

    threads: `Write a Threads post. HARD CONSTRAINT: max 500 characters total.
- 2–4 short punchy sentences, like texting a smart friend
- 1–2 hashtags max (optional)
- NO URLs
- BEFORE returning, COUNT your characters. If over 500, rewrite shorter.`,

    instagram: `Write an Instagram caption. Return exactly two labeled sections:

CAPTION:
[Hook + 2–3 short lines of substance. Max 250 characters. NO URLs. NO hashtags here.]

HASHTAGS:
[20 relevant hashtags — mix of broad (#marketing), mid (#saasfounder), niche (#b2bgrowth). Space-separated on one line.]`,

    reddit: `Write a Reddit post. Return exactly three labeled sections:

SUBREDDIT: r/[single best subreddit — e.g. r/startups, r/SaaS, r/Entrepreneur, r/technology]

TITLE: [post title — max 200 chars, compelling and specific, not clickbait]

BODY:
[2–4 paragraphs. Reddit tone: direct, a bit opinionated, conversational. Share a real perspective. Ask a question at the end to spark discussion. NO self-promotion. NO URLs.]`,
  };

  const typeGuides = {
    'hot-take':   'Take the most contrarian angle. Say what others are afraid to say. Be specific about what people get wrong. Use plain words.',
    'story':      'Tell a short story: what happened → what went wrong → what you learned. First person. Keep it real and simple. Short sentences.',
    'teach':      'Explain one idea clearly. Use simple words and short sentences. Teach it like you are explaining to a smart friend who is new to the topic.',
    'data':       'Lead with the strongest number or fact from the content. Build the whole post around that one number. Explain what it means in plain words.',
    'question':   'Ask one clear question that makes people stop and think. Explain in 2–3 simple sentences why it matters. Short words, short sentences.',
    'founder':    'Write like a founder sharing something real from building their product. Personal, honest, and easy to understand. No big words.',
    'default':    'Clear, specific, and easy to read. Short sentences. Simple words. Like a smart person talking to a friend.',
    'shorter':    'Make it shorter. Cut every word that is not needed. Keep only the most important idea.',
    'contrarian': 'Disagree with the common view. Say clearly what you think people are getting wrong. Use plain, simple language.',
  };

  const guide  = platformGuides[platform] || platformGuides.linkedin;
  const tone   = typeGuides[mode] || typeGuides['hot-take'];
  const voice  = voiceTail({ voiceNiche, voiceStyle });

  const isXPost = inputMode === 'xpost';

  const content = isXPost
    ? `ORIGINAL TWEET:\n"${articleTitle}"\n\nYour task: repurpose the core idea for ${platform}. Do NOT copy the tweet verbatim. Rewrite in the founder's own voice — expand the idea, add context or a contrarian angle, and make it feel native to ${platform}. If the tweet is short, build on it significantly.`
    : isWrite
      ? `FOUNDER'S ROUGH NOTES / THOUGHTS:\n${articleTitle}`
      : `ARTICLE TITLE: ${articleTitle}\n${articleAngle ? `ARTICLE CONTEXT: ${articleAngle}` : ''}`;

  return `You are writing a social media post for a startup founder. The audience is global — many readers are non-native English speakers. Write in plain, simple, everyday English that anyone can understand.${voice}

TOPIC: "${topic || 'startup growth'}"

${content}

PLATFORM INSTRUCTIONS:
${guide}

POST ANGLE: ${tone}

PLAIN ENGLISH — these rules are non-negotiable:
- Short sentences. Aim for 8–14 words each. If a sentence is long, break it in two.
- Use the simplest word that works:
    say "use" not "utilize" · "start" not "initiate" · "help" not "facilitate"
    say "buy" not "purchase" · "need" not "require" · "show" not "demonstrate"
    say "problems" not "pain points" · "get better" not "iterate" · "launch" not "go-to-market"
- NO jargon: no "leverage", "scalable", "robust", "frictionless", "seamless", "ecosystem", "stakeholders", "value proposition", "empower", "innovative", "cutting-edge", "best-in-class", "agile", "pivot", "synergy", "paradigm".
- NO startup slang: no "move the needle", "deep dive", "level up", "circle back", "low-hanging fruit", "at the end of the day", "game-changer", "10x this", "ship fast", "in today's fast-paced world", "let's dive in", "the future of X is Y".
- NO meta-commentary ("Here's a post about…", "I wanted to share…").
- NO emojis. NO bold/italics markdown. NO closing phrases ("hope this helps!", "keep building!").
- NO URLs in the post. None.
- Be SPECIFIC to the actual content above. No generic filler.
- First person, present tense. Sound like a real person talking, not a marketer writing.

Return ONLY the post content. No preamble. No explanation. No quote marks. Just the content.${refineInstruction ? `\n\nREFINEMENT INSTRUCTION (apply this on top): ${refineInstruction}` : ''}`;
}

function buildCampaignPrompt(body) {
  const {
    campaignType = 'Launch',
    hook = 'Free 14-day trial',
    days = 14,
    budget = 0,
    channels = ['X'],
    niche = 'SaaS',
    voiceNiche, voiceStyle,
  } = body;

  return `You are a senior growth marketer writing a real, runnable campaign brief for a founder using XGrowth. Audience: SaaS founders, indie hackers, digital-product makers.${voiceTail({ voiceNiche, voiceStyle })}

CAMPAIGN INPUTS:
- Type: ${campaignType}
- Hook: ${hook}
- Duration: ${days} days
- Budget: $${budget}
- Channels: ${channels.join(', ') || 'X'}
- Niche / product: ${niche}

Produce a complete campaign brief in markdown with these exact sections in this order:

## Campaign: ${campaignType}
One-line summary, then Hook / Channels / Duration / Budget as plain lines.

## Audience Segments
3 segments: Cold, Warm, Hot. One specific sentence each — say WHO they are and how to reach them.

## Timeline
Week-by-week plan (${days <= 14 ? '2 weeks' : Math.ceil(days / 7) + ' weeks'}). For each week list 3–5 concrete actions across the chosen channels.

## KPIs
5 numeric targets: Impressions, Replies/Comments, Profile visits, Leads (email/demo), CPL. Use the duration and budget to make realistic estimates.

## Email Sequence
5 numbered emails. For each: Subject line + 1-sentence body summary. Make them sequential (teaser → launch → demo → case → last call).

## Ad Copy
3 ad variants (A/B/C). Each: 1-line hook + CTA. Each must take a different angle.

## Landing Page Outline
Hero (H1 + subhead + CTA), Proof (3 bullets), FAQ (3 Qs with 1-line answers). NOT raw HTML — just the copy.

## Next Steps
3 concrete actions the founder should do today to start the campaign.

${HARD_RULES}
- NO HTML code blocks. Plain markdown only.
- NO placeholder text like "[insert]" or "[your X here]" — write real specific copy.

Return ONLY the markdown brief. No preamble.`;
}

function buildCopyPrompt(body) {
  const {
    name = 'YourStartup',
    what = 'a digital product',
    bio = 'Founder and builder.',
    cta = 'Get started',
    niche = '',
    voiceNiche, voiceStyle,
  } = body;

  return `You are a senior conversion copywriter writing landing-page copy for a startup. Output should be markdown, scannable, ready to drop into Framer or a static site.${voiceTail({ voiceNiche, voiceStyle })}

PRODUCT INPUTS:
- Name: ${name}
- What it does: ${what}
- Founder bio: ${bio}
- Primary CTA text: ${cta}
${niche ? `- Niche: ${niche}` : ''}

Produce these sections in this exact order:

## Hero
# [H1 — one concrete promise, max 8 words]
[Subhead — 1 sentence, explains the value to a skeptical operator. Max 20 words.]
[${cta}]

## About
2–3 sentences. First-person founder voice. Mention bio + why this product exists. No platitudes.

## How it works
3 numbered steps. Each: bold one-line action, then one supporting sentence.

## Features
3 bullets. Each: bold feature name (max 4 words), then one specific benefit sentence with a number or concrete outcome.

## Social Proof
2 short fake-but-plausible testimonials. Format: "[Quote]" — Name, Role.

## FAQ
4 Qs with short specific answers (1–2 sentences each). Pick the 4 real objections a buyer would have.

## CTA
A second CTA line + trust microcopy ("No card. Cancel anytime." or similar).

${HARD_RULES}
- NO HTML or code blocks.
- NO "[insert ___]" placeholders — write real copy.
- Headlines must promise outcomes, not describe features.

Return ONLY the markdown. No preamble.`;
}

function buildAuditPrompt(body) {
  const { handle = '@you', posts = [], niche = '' } = body;
  const trimmed = posts.slice(0, 5).map((p, i) => `Post ${i + 1} (${p.length} chars): ${p}`).join('\n\n');

  return `You are a senior social media editor doing a posting audit for a founder. You give blunt, useful feedback — no flattery, no platitudes.${niche ? `\nNICHE: ${niche}` : ''}

HANDLE: ${handle}

POSTS TO REVIEW:
${trimmed}

Produce a markdown audit with these exact sections:

## Scorecard
For each post: "Post N: SCORE/100 (LENGTH chars) — one-line verdict".
After the list: "Avg: X/100".

## Hook Diagnosis
For each post: "Post N: " then one sentence diagnosing the hook (what works, what doesn't, what to change).

## A/B Rewrites
For each post, write 2 stronger rewrites labeled A and B. Each rewrite must be a complete post under the same length as the original. A should be a sharper hook variant; B should be a contrarian or specific-number variant. Quote them.

## Patterns
3 bullet points spotting patterns across the posts (e.g. "all start with 'I' — vary openers", "no specific numbers anywhere", "weak closers").

## 7-Day Action Plan
Mon–Sun, one concrete posting action per day, tailored to the patterns you spotted.

${HARD_RULES}
- Scores must reflect real differences — don't give everything 70/100.
- Diagnoses must reference the actual words/structure of the post, not generic advice.

Return ONLY the markdown audit. No preamble.`;
}

function buildBrandKitPrompt(body) {
  const {
    what = 'a digital product',
    who = 'founders and indie makers',
    bio = '',
    platform = 'X / Twitter',
    tone = 'direct and casual',
  } = body;

  return `You are a brand strategist building a personal brand kit for a founder. Everything you write must be specific, usable, and ready to publish — no placeholders, no "you could try..." hedging.

FOUNDER INPUTS:
- What they build: ${what}
- Who they serve: ${who}
- Background: ${bio || '(not provided)'}
- Primary platform: ${platform}
- Brand tone: ${tone}

Produce a complete Brand Kit in this exact markdown structure:

## Positioning Statement
One sentence: "I help [specific who] [achieve specific outcome] [without specific pain / in specific way]."
Make it concrete enough that the founder could use it as their first line in any bio.

## X Bio (160 chars max)
Write a ready-to-paste X bio. COUNT the characters before returning — must be 160 or under.
Format: what you do, who for, and one proof point or personality hook. NO "helping", NO "passionate about".

## LinkedIn Headline (220 chars max)
Write a ready-to-paste LinkedIn headline. Format: role | specific value prop | one credibility anchor.

## Content Pillars
List exactly 4 content pillars — the topics this founder should own and post about consistently.
For each: bold pillar name (3–5 words) + one sentence on what angle to take.

## Ideal Customer Profile
Describe the ONE person who will get the most value, in plain language. Cover: who they are, what they struggle with day-to-day, what success looks like for them, and why this founder's product/perspective is the right fit.

## Brand Voice
Line 1: "We are: [3 adjectives that define the tone]"
Line 2: "We are not: [3 adjectives that would kill the brand]"
Line 3: One sentence rule for what makes this voice distinct (e.g. "Always lead with receipts, never with advice.")

${HARD_RULES}
- Every bio/headline must be READY TO PASTE — no brackets, no "your name here".
- Content pillars must be specific to the niche, not generic ("Marketing", "Growth").
- Positioning statement must name a specific outcome, not a vague benefit.

Return ONLY the markdown. No preamble.`;
}

function buildImagePromptPrompt(body) {
  const { caption = '', topic = '', articleTitle = '', niche = '' } = body;

  // Build layered context — caption is primary, topic + article give extra signal
  const contextLines = [];
  if (caption)       contextLines.push(`INSTAGRAM CAPTION (primary context):\n${caption.slice(0, 600)}`);
  if (articleTitle)  contextLines.push(`ARTICLE / SOURCE TITLE: ${articleTitle}`);
  if (topic)         contextLines.push(`TOPIC: ${topic}`);
  if (niche)         contextLines.push(`PRODUCT / NICHE: ${niche}`);
  const context = contextLines.join('\n\n');

  return `You are a visual creative director. Your job is to turn an Instagram caption into a vivid, specific image generation prompt.

${context}

Read the caption carefully. Identify the CORE IDEA or KEY VISUAL METAPHOR the post is communicating. Then write ONE image prompt that directly illustrates that idea for a 1080×1080 Instagram post.

RULES:
1. The image MUST directly match the post's specific message — not just the general niche
   - Post about "saving 9 hours/week with AI ops" → show a calm, organised desk with a glowing dashboard, NOT just a generic tech scene
   - Post about "founder burnout" → show a dim laptop at midnight, scattered coffee cups, warm bedside glow
   - Post about "product launch day" → show a clean product reveal shot, spotlight, dramatic shadows
2. Describe the scene concretely: subject, composition, lighting, background, color palette
3. Lead with photographic style: "dark minimal product photography", "editorial flatlay", "cinematic close-up", etc.
4. Include: lighting quality, background mood, camera angle, depth of field
5. NO text overlays, NO logos, NO human faces, NO UI screenshots in frame
6. Skip abstract nouns: "success", "innovation", "growth" — describe the VISUAL, not the concept
7. 15–40 words total. Dense, specific, vivid.

Good examples (notice how each matches a specific concept):
- "dark minimal flatlay, MacBook on matte black surface, soft rim lighting, deep shadows, glowing dashboard reflection, professional product photography, 4K"
- "cinematic close-up of a timer stopping at zero, blue-purple gradient background, shallow depth of field, editorial feel, dramatic side lighting"
- "clean white desk with colour-coded sticky notes and open planner, natural window light, flat-lay, high contrast, commercial photography"
- "lone founder at a glass-wall office, city lights at dusk below, warm interior glow vs cool exterior, editorial, wide-angle, moody"

Return ONLY the image prompt. No quotes, no explanation, no preamble.`;
}

function buildReportPrompt(body) {
  const { niche = 'your product', metrics = {} } = body;
  const {
    followersWoW = 0,
    impressions7 = 0,
    engagement7 = 0,
    visits7 = 0,
    topPost = null,
  } = metrics;

  return `You are a sharp growth analyst writing the narrative summary for a founder's weekly report. Audience: a busy founder skimming on a Sunday night.

NICHE: ${niche}

THIS WEEK'S NUMBERS:
- Followers WoW: ${followersWoW.toFixed(1)}%
- Impressions (7d): ${impressions7}
- Engagement rate (7d): ${engagement7.toFixed(2)}%
- Profile visits (7d): ${visits7}
${topPost ? `- Top post: "${topPost.text}" — ${topPost.impr} impressions, ${topPost.likes} likes` : '- No top post logged this week'}

Write a 2-paragraph "What happened this week" narrative (around 100–140 words total):

Paragraph 1: What the numbers actually mean. Don't restate them — interpret them. Was this a good week or not, and why? If the top post outperformed, name the likely reason.

Paragraph 2: The one thing the founder should focus on next week, with a concrete tactic (not "post more"). Specific enough that they could act on it tomorrow.

${HARD_RULES}
- Do NOT add headers or bullets — pure prose, two paragraphs separated by a blank line.
- Do NOT restate the raw numbers (they're shown separately).
- If a metric is 0 or missing, treat it as "no signal yet" not "great success".

Return ONLY the two paragraphs. No preamble, no headers.`;
}

function buildIcpPrompt(body) {
  const {
    name = 'your product',
    what = 'a SaaS tool',
    problem = 'a painful workflow problem',
    customers = '',
    price = '',
    niche = '',
  } = body;

  return `You are a senior customer research strategist who has run 500+ discovery interviews for B2B SaaS products. You build ICPs that founders can act on immediately — not slide-deck archetypes but real humans with specific behaviors, exact objection language, and clear acquisition paths.

Build 3 Ideal Customer Profiles for:
PRODUCT: ${name}
WHAT IT DOES: ${what}
PROBLEM SOLVED: ${problem}
${price ? `PRICE POINT: ${price}` : ''}
${customers ? `CURRENT CUSTOMERS (use as signal): ${customers}` : 'CURRENT CUSTOMERS: None yet — extrapolate from the product and problem.'}
${niche ? `NICHE: ${niche}` : ''}

Format EACH ICP EXACTLY like this:

---
## ICP [N]: [First name + job title — e.g. "Alex — Solo SaaS Founder"]

**Role:** [Specific title + company type and stage]
**Company size:** [Headcount + revenue range]
**Background:** [2–3 sentences — career path and how they arrived at this role]

**The one thing they're measured on:** [Single most important outcome]

**Biggest pains (in their own words):**
- "[Most urgent pain — quoted in their voice, not product category language]"
- "[Second pain]"
- "[Third pain]"

**Job to be done:**
When [triggering situation], I want to [motivation] so I can [outcome].

**Buying behavior:**
[2–3 sentences: how they evaluate tools — trial first? committee approval? how long? deal-breakers?]

**Objections they'll say out loud:**
- "[Exact objection in their words]"
- "[Another objection]"
- "[Another objection]"

**Where to find them:**
- [Platform / community + what they're doing there]
- [Second channel + behavior]

**The one message that unlocks them:** [One sentence — the framing that makes this persona immediately say "that's me"]
---

${HARD_RULES}
- Each ICP must be genuinely distinct — different motivations, buying behaviors, and objection language, not just different titles.
- Use customers as signal; if blank, extrapolate from product + problem.
- Do NOT add any text before ICP 1 or after ICP 3.`;
}

function buildPhLaunchPrompt(body) {
  const {
    name = 'your product',
    oneliner = 'a great product',
    what = 'it solves a painful problem',
    audience = 'founders and makers',
    features = '',
    goal = 'top-5 product of the day',
    niche = '',
  } = body;

  return `You are a Product Hunt launch strategist who has helped 30+ products hit Top 5 on launch day. You know the PH meta cold: clarity and personality beat hype. Voters upvote things that feel human and useful, not things that feel like press releases.

Create a complete Product Hunt launch kit for:
PRODUCT: ${name}
ONE-LINER: ${oneliner}
WHAT IT DOES: ${what}
TARGET USER: ${audience}
${features ? `TOP FEATURES / DIFFERENTIATORS: ${features}` : ''}
LAUNCH GOAL: ${goal}
${niche ? `NICHE CONTEXT: ${niche}` : ''}

Generate EXACTLY these sections in order, no extra commentary:

## Tagline
[One tagline only. Under 60 characters — count every character. Benefit-first, specific, no buzzwords, no "the X for Y" template unless it's genuinely the clearest option.]

## Description (260 chars)
[Body text for the PH listing. 260 characters or fewer — count carefully. Jargon-free, punchy. Read it aloud: if it sounds like ad copy, rewrite it.]

## First Maker Comment
[250–320 words. The "why I built this" story that gets people to care. Open with the specific frustration that started this. Who it's for. What makes it different from alternatives. End with a direct ask: "Would love your feedback on [specific thing] in the comments." Personal, direct, zero hype.]

## Top 5 Questions Voters Will Ask + Answers
The 5 most likely comment questions, with sharp honest answers.

Q: [Question]
A: [1–3 sentence answer, conversational]

[Repeat for all 5]

## Day-of Checklist
- [ ] [Specific action with a time e.g. "12:01 AM PT — submit the listing"]
[8–10 items, covering: submission timing, assets, supporter outreach, comment monitoring, social amplification]

## Supporter Outreach Message
[Under 80 words. To send to early supporters / email list. Feels personal, not blast. Specific ask: what to do and why it matters. No "I'd really appreciate it if you could…" energy.]

## 48h Follow-up Tweet (if top 5)
[Under 280 characters. Post if you rank well. Gratitude + one forward-looking hook. No brag — just momentum. Include number of upvotes as placeholder: {votes}]

${HARD_RULES}
- Tagline: count every character — must be under 60.
- Description: 260 chars or fewer — count carefully before outputting.
- Do NOT add any text before the Tagline section or after the Follow-up Tweet.`;
}

function buildGrowthExperimentsPrompt(body) {
  const {
    stage = 'mvp',
    goal = 'trials',
    channels = [],
    budget = '$0 (bootstrapped)',
    niche = 'your SaaS product',
    count = 6,
  } = body;

  const stageGuide = {
    idea:    'pre-launch idea stage — no product yet, building in public',
    mvp:     'MVP with early users but no clear PMF yet',
    pmf:     'post-PMF with traction and some paying customers',
    scaling: 'scaling with proven growth loops and significant revenue',
  };

  const goalGuide = {
    awareness:  'increase brand awareness and become known in the niche',
    waitlist:   'grow the email waitlist / subscriber list as fast as possible',
    trials:     'drive free trial signups or demo requests',
    activation: 'improve activation (get users to the aha moment faster)',
    retention:  'reduce churn and improve long-term retention',
    revenue:    'grow revenue through upsells, upgrades, or expansion',
    referrals:  'generate referrals and organic word-of-mouth growth',
  };

  const chList = channels.length ? channels.join(', ') : 'not specified — recommend the best 2–3 for this stage';

  return `You are a Y Combinator-level growth advisor who has helped 50+ SaaS products reach their first $1M ARR. You think in systems, not one-off tactics, and you are allergic to generic advice.

PRODUCT CONTEXT:
- Product / niche: ${niche}
- Stage: ${stageGuide[stage] || stage}
- Primary growth goal: ${goalGuide[goal] || goal}
- Active channels: ${chList}
- Monthly budget: ${budget}

Generate exactly ${count} growth experiments tailored to this context. Rank them from highest ICE total to lowest.

Format EACH experiment EXACTLY like this — no exceptions:

---
## Experiment [N]: [Punchy name, 4–7 words]
**Hypothesis:** If we [specific action], then [expected outcome] because [one-sentence reason].
**ICE Score:** Impact [1–10] · Confidence [1–10] · Ease [1–10] · **Total: [average to 1 decimal]**
**Channel:** [Which channel(s)]
**Time to run:** [e.g. "2 days", "1 week"]
**Budget needed:** [exact $ or "Free"]

**Run it tomorrow:**
1. [Specific, executable step — not "create content" but the exact thing to write, post, or build]
2. [Next step]
3. [Next step]
[4–5 steps max]

**Success metric:** [What to measure, with a concrete "good" threshold — e.g. "≥12 trial signups from this within 72h"]
**Double down if:** [The leading indicator that tells you to scale this immediately]
---

${HARD_RULES}
- ICE scores must be realistic. Confidence = how proven the mechanism is. Do NOT score everything 7+.
- Every step must be executable by a solo founder with no team today.
- At least one experiment must be Free and completable in under 48h.
- If channels are not specified, pick the best 2 for the stage and explain why.
- Experiments must be specific to the actual niche — not generic SaaS advice.
- Do NOT add any text before Experiment 1 or after the last experiment.`;
}

function buildPulsePrompt(body) {
  const {
    niche = 'your SaaS product',
    stage = 'mvp',
    metrics: {
      followersWoW = 0,
      impressions7 = 0,
      engagement7 = 0,
      visits7 = 0,
      topPost = null,
    } = {},
  } = body;

  const hasData = impressions7 > 0 || visits7 > 0 || followersWoW !== 0;

  return `You are a blunt, data-driven growth advisor. The founder has 60 seconds. Give them only what matters.

PRODUCT: ${niche} (${stage} stage)

LAST 7 DAYS:
- Follower growth WoW: ${followersWoW.toFixed(1)}%
- Impressions: ${impressions7}
- Avg engagement rate: ${engagement7.toFixed(2)}%
- Profile visits: ${visits7}
${topPost ? `- Top post: "${topPost.text?.slice(0, 120)}" — ${topPost.impr} impressions` : '- No top post logged'}
${!hasData ? '\nNote: Most metrics are zero — the founder has not logged data yet.' : ''}

Return EXACTLY 3 insights in this format:

**[3–5 word title]**
[2 sentences: what this metric signals + one specific action to take this week.]

**[3–5 word title]**
[2 sentences.]

**[3–5 word title]**
[2 sentences.]

Rules:
- If a number is bad, say so directly. No softening.
- Each action must be specific enough to complete in under 1 hour.
- If data is sparse or all zeros, focus on exactly what to start tracking and why.
- Do NOT number the insights. Do NOT add preamble or sign-off. Return only the 3 insights.`;
}

function buildEmailSequencePrompt(body) {
  const {
    name = 'your product',
    what = 'a SaaS tool',
    audience = 'founders and indie makers',
    goal = 'onboarding',
    count = 5,
    tone = 'direct and conversational',
    voiceNiche = '',
    voiceStyle = '',
  } = body;

  const goalGuide = {
    onboarding: `Welcome & onboarding — get new users to their first "aha moment": using the core feature, seeing real value, and feeling confident to continue.`,
    launch: `Product launch — build anticipation before launch day, convert warm leads on launch day, and capture stragglers with urgency-driven follow-up.`,
    nurture: `Cold nurture / drip — educate cold subscribers about the problem ${name} solves, build trust over time, and warm them toward a trial or purchase.`,
    reEngage: `Re-engagement / win-back — reactivate subscribers who went cold. Acknowledge the gap, deliver new value, and invite them back with a low-friction CTA.`,
    waitlist: `Waitlist warm-up — keep waitlisters excited and sharing while they wait. Tease what's coming, deliver early value, and prime them for conversion at launch.`,
  };

  return `You are a world-class email copywriter who has written sequences for some of the fastest-growing SaaS products. You write like a sharp, direct founder — not a corporate marketer.

Write a ${count}-email sequence for the following product:

PRODUCT: ${name}
WHAT IT DOES: ${what}
AUDIENCE: ${audience}
TONE: ${tone}
${voiceNiche ? `NICHE CONTEXT: ${voiceNiche}` : ''}
${voiceStyle ? `VOICE STYLE: ${voiceStyle}` : ''}

SEQUENCE GOAL: ${goalGuide[goal] || goalGuide.onboarding}

Format EXACTLY like this for EVERY email — no exceptions:

---
## Email [N]: [Short descriptive title, 3–6 words]
**Send:** [When to send, e.g. "Day 0 — immediately on sign-up" or "Day 3"]
**Subject:** [Subject line, under 50 characters — specific, curiosity-driven, no "Introducing" or "Welcome to"]
**Preview text:** [Preview snippet, 60–90 characters — continues the subject's curiosity loop]

[Email body — 150–220 words. Short paragraphs (1–3 sentences each). One clear, specific CTA at the end. Written in first person as the founder. Start with a hook — a surprising stat, a bold claim, or a relatable problem — never with "Hey, it's [name] from [product]".]

**P.S.** [A P.S. that adds a nugget of value, social proof, or urgency — 1 sentence.]
---

${HARD_RULES}
- Every email has exactly ONE goal and ONE CTA
- Subject lines: no ALL CAPS, no emojis, no vague teasers — earn the open with specificity or curiosity
- Never use "journey", "excited", "thrilled", "leverage", "game-changer", or "at the end of the day"
- Do NOT add any text before Email 1 or after the final email`;
}

/* ─── Pollinations image proxy (server-to-server, binary stream) ──────────── */

// Fetch the image from Pollinations server-side and return the raw Response for
// streaming.  No base64 encoding = zero CPU overhead (avoids the Worker's CPU
// time limit which kills base64 loops on large images).  The browser receives
// raw image bytes via CORS-annotated headers; the client converts to a blob URL.
async function callPollinationsProxy(prompt, model, seed) {
  const s = seed || Math.floor(Math.random() * 1e9);
  const imageUrl =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=1080&height=1080&model=${encodeURIComponent(model)}&nologo=true&seed=${s}`;

  const controller = new AbortController();
  // Abort after 25s — leaves 5s headroom before the Worker's 30s wall-clock limit.
  const timer = setTimeout(() => controller.abort(), 25000);

  let resp;
  try {
    resp = await fetch(imageUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; XGrowthBot/1.0; +https://xgrowth.uno)',
        'Referer':    'https://xgrowth.uno/',
      },
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('Pollinations timed out after 25 s');
    throw e;
  }
  clearTimeout(timer);

  if (!resp.ok) throw new Error(`Pollinations returned ${resp.status}`);
  return resp; // caller streams resp.body directly to the browser
}

/* ─── Hugging Face image client ───────────────────────────────────────────── */

// HF Inference API model IDs — all free with a HF token (FLUX.1-dev needs gated approval)
const HF_IMAGE_MODELS = {
  'hf-flux':      'black-forest-labs/FLUX.1-schnell',   // fastest, free
  'hf-flux-dev':  'black-forest-labs/FLUX.1-dev',        // best quality (accept terms on HF first)
  'hf-sdxl':      'stabilityai/stable-diffusion-xl-base-1.0', // classic SDXL
  'hf-sd3':       'stabilityai/stable-diffusion-3-medium-diffusers', // SD3 Medium
};

async function callHuggingFaceImage(token, prompt, modelKey = 'hf-flux') {
  const modelId = HF_IMAGE_MODELS[modelKey] || HF_IMAGE_MODELS['hf-flux'];

  // Use the HF router inference endpoint — more reliable than the raw model endpoint
  const resp = await fetch(`https://router.huggingface.co/hf-inference/models/${modelId}/v1/images/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      n: 1,
      size: '1024x1024',
      response_format: 'b64_json',
    }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    if (resp.status === 503) throw new Error('Model loading — wait 20s then retry');
    if (resp.status === 422) throw new Error('Invalid request — try a different model');
    if (resp.status === 429) throw new Error('Rate limited — wait a moment then retry');
    if (resp.status === 403) throw new Error('Access denied — accept model terms on huggingface.co first');
    throw new Error(`HF ${resp.status}: ${t.slice(0, 150)}`);
  }

  const data = await resp.json();
  const imageData = data.data?.[0]?.b64_json;
  if (!imageData) throw new Error('No image returned from HF — try again');
  return { imageData, mimeType: 'image/jpeg' };
}

/* ─── Gemini image client ─────────────────────────────────────────────────── */

// Gemini native image generation models — tries each in order until one works
const GEMINI_IMAGE_MODELS = [
  'gemini-2.0-flash-exp-image-generation',   // primary (free tier)
  'gemini-2.0-flash-preview-image-generation', // alias used in some regions
];

async function callGeminiImage(apiKey, prompt) {
  // NOTE: image gen models don't accept temperature / topP / thinkingConfig.
  // responseModalities must be ['TEXT', 'IMAGE'] — TEXT first is required.
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  });

  const errors = [];
  for (const model of GEMINI_IMAGE_MODELS) {
    try {
      const url = `${GEMINI_BASE}${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (!resp.ok) {
        const t = await resp.text();
        errors.push(`${model}: ${resp.status} ${t.slice(0, 120)}`);
        continue;
      }

      const data = await resp.json();
      const parts = data.candidates?.[0]?.content?.parts || [];

      // Find the image part
      const imgPart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
      if (!imgPart) {
        const blockReason = data.promptFeedback?.blockReason;
        if (blockReason) throw new Error(`Blocked by safety: ${blockReason}`);
        errors.push(`${model}: no image in response`);
        continue;
      }

      return { imageData: imgPart.inlineData.data, mimeType: imgPart.inlineData.mimeType };
    } catch (e) {
      errors.push(`${model}: ${e.message || e}`);
    }
  }

  throw new Error(`Gemini image gen failed. ${errors.join(' | ')}`);
}

/* ─── Gemini client ────────────────────────────────────────────────────────── */

async function callGemini(apiKey, prompt) {
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.85,
      topP: 0.95,
      maxOutputTokens: 2048,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',  threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT',  threshold: 'BLOCK_ONLY_HIGH' },
    ],
  });

  const errors = [];
  for (const model of GEMINI_MODELS) {
    try {
      const url = `${GEMINI_BASE}${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (!resp.ok) {
        const t = await resp.text();
        errors.push(`${model}: ${resp.status} ${t.slice(0, 100)}`);
        continue; // try next model regardless of status code
      }

      const data = await resp.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        const blockReason = data.promptFeedback?.blockReason;
        if (blockReason) throw new Error(`Blocked by safety: ${blockReason}`);
        errors.push(`${model}: empty response`);
        continue;
      }
      return { text: text.trim(), model };
    } catch (e) {
      if (String(e.message || '').startsWith('Gemini 400')) throw e;
      errors.push(`${model}: ${e.message || e}`);
    }
  }

  throw new Error(`All models failed. ${errors.join(' | ')}`);
}
