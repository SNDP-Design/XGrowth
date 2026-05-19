/**
 * XGrowth Content Engine — Cloudflare Worker proxy to Google Gemini.
 *
 * Endpoints:
 *   POST /generate  { topic, articleTitle, articleAngle?, platform, mode?,
 *                     voiceNiche?, voiceStyle?, inputMode? }
 *                   platform: "linkedin" | "x" | "threads" | "instagram" | "reddit"
 *                   mode:     "hot-take" | "story" | "teach" | "data" | "question" | "founder"
 *                   inputMode: "search" | "url" | "freewrite"
 *   POST /preview   { url }  — fetch a URL server-side, return { title, description }
 *   GET  /health    health check
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

// Try models in order; first one that responds wins.
const GEMINI_MODELS = [
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
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

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'xgrowth-api', endpoints: ['/generate', '/preview'] }, 200, origin, allowed);
    }

    if (request.method !== 'POST') {
      return json({ error: 'Use POST' }, 405, origin, allowed);
    }

    if (url.pathname !== '/generate' && url.pathname !== '/preview') {
      return json({ error: 'Not found' }, 404, origin, allowed);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, origin, allowed);
    }

    // ── /preview ──────────────────────────────────────────────────────────────
    if (url.pathname === '/preview') {
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
        const slice = html.slice(0, 60000); // parse first 60KB only

        function extractMeta(patterns) {
          for (const re of patterns) {
            const m = slice.match(re);
            if (m?.[1]) return m[1].trim();
          }
          return '';
        }

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

        const decode = s => s
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
          .replace(/&nbsp;/g, ' ').trim();

        return json({ ok: true, title: decode(rawTitle), description: decode(rawDesc) }, 200, origin, allowed);
      } catch (e) {
        return json({ error: 'Preview failed: ' + (e.message || 'unknown') }, 502, origin, allowed);
      }
    }

    // ── /generate ─────────────────────────────────────────────────────────────
    const { topic, articleTitle, articleAngle, platform, voiceNiche, voiceStyle, inputMode } = body;
    const mode = body.mode || 'hot-take';

    if (!articleTitle || typeof articleTitle !== 'string') {
      return json({ error: 'Missing articleTitle' }, 400, origin, allowed);
    }
    if (!['linkedin', 'x', 'threads', 'instagram', 'reddit'].includes(platform)) {
      return json({ error: 'platform must be linkedin | x | threads | instagram | reddit' }, 400, origin, allowed);
    }
    if (!env.GEMINI_API_KEY) {
      return json({ error: 'Server missing GEMINI_API_KEY secret' }, 500, origin, allowed);
    }

    const prompt = buildPrompt({ topic, articleTitle, articleAngle, platform, mode, voiceNiche, voiceStyle, inputMode });

    try {
      const { text, model } = await callGemini(env.GEMINI_API_KEY, prompt);
      let final = text;
      if (platform === 'x') final = trimForX(text);
      else if (platform === 'threads') final = trimAtSentence(text, 500);
      return json({ ok: true, text: final, platform, mode, model }, 200, origin, allowed);
    } catch (err) {
      return json({ error: 'Generation failed: ' + (err.message || 'unknown') }, 502, origin, allowed);
    }
  },
};

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
  // Preserve URL if it sits on its own line at the end
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
    'Access-Control-Allow-Headers': 'Content-Type',
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

/* ─── prompt builder ──────────────────────────────────────────────────────── */

function buildPrompt({ topic, articleTitle, articleAngle, platform, mode, voiceNiche, voiceStyle, inputMode }) {
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

    x: `Write a single tweet. HARD CONSTRAINT: 280 characters TOTAL — every character counts.
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
    'hot-take':   'Take the sharpest, most contrarian angle. Challenge what everyone thinks they know. Be specific about what others are missing or getting wrong.',
    'story':      'Frame this as a narrative: setup → tension → resolution with a lesson. First person. Human and specific.',
    'teach':      'Explain what this means and why it matters. Break it down clearly. Teach one thing well. No jargon.',
    'data':       'Lead with the most concrete number or stat (from the content, or a plausible extrapolation). Build the entire post around that anchor.',
    'question':   'Pose one sharp, thought-provoking question this content raises. Briefly explain why it matters. Make readers stop and think.',
    'founder':    "Write like a founder sharing a real insight while building in public. Personal, slightly vulnerable, honest about what you're learning.",
    // backward-compat with old mode names
    'default':    'Smart, specific, human. Like an experienced operator with a real point of view.',
    'shorter':    'Make it noticeably shorter and tighter. Cut every word that does not earn its place.',
    'contrarian': 'Take a sharp contrarian angle. Push back on the conventional read. Be specific about what others are missing.',
  };

  const guide  = platformGuides[platform] || platformGuides.linkedin;
  const tone   = typeGuides[mode] || typeGuides['hot-take'];
  const voice  = voiceNiche
    ? `\nFOUNDER CONTEXT: ${voiceNiche}${voiceStyle ? ` — preferred tone: ${voiceStyle}` : ''}`
    : '';

  const content = isWrite
    ? `FOUNDER'S ROUGH NOTES / THOUGHTS:\n${articleTitle}`
    : `ARTICLE TITLE: ${articleTitle}\n${articleAngle ? `ARTICLE CONTEXT: ${articleAngle}` : ''}`;

  return `You are writing a social media post for a startup founder who runs XGrowth, a marketing OS for digital products. Audience: founders, indie hackers, SaaS operators.${voice}

TOPIC: "${topic || 'startup growth'}"

${content}

PLATFORM INSTRUCTIONS:
${guide}

POST ANGLE: ${tone}

HARD RULES — break ANY of these and the post is unusable:
- Be SPECIFIC to the actual content above. No generic advice.
- NO clichés: "in today's fast-paced world", "game-changer", "moving the needle", "synergy", "leveraging", "let's dive in", "thoughts?", "the future of X is Y".
- NO meta-commentary ("Here's a post about…", "I wanted to share…").
- NO emojis.
- NO bold/italics markdown.
- NO closing platitudes ("hope this helps!", "keep building", "drop a comment").
- NO URLs in the output text. None.
- First person, present tense.
- Sound like a smart human, not a content marketer.

Return ONLY the post content. No preamble. No explanation. No quote marks. Just the content.`;
}

/* ─── Gemini client ────────────────────────────────────────────────────────── */

async function callGemini(apiKey, prompt) {
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.85,
      topP: 0.95,
      maxOutputTokens: 2048,
      // Disable thinking tokens — they eat the output budget for writing tasks
      thinkingConfig: { thinkingBudget: 0 },
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
        if (resp.status === 400) throw new Error(`Gemini 400 (bad request): ${t.slice(0, 200)}`);
        continue;
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
