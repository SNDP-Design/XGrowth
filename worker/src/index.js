/**
 * XGrowth Content Engine — Cloudflare Worker proxy to Google Gemini.
 *
 * Endpoint:  POST /generate
 * Body:      { topic, articleTitle, articleAngle?, articleUrl?, platform, mode? }
 *            platform: "linkedin" | "x"
 *            mode (optional): "default" | "shorter" | "contrarian" | "founder" | "data"
 * Returns:   { ok: true, text: "<the post>" }  on success
 *            { error: "<message>" }            on failure
 *
 * The Gemini API key lives ONLY as a Wrangler secret (env.GEMINI_API_KEY).
 * It is never sent to the browser. CORS is locked to known XGrowth origins.
 */

const ALLOWED_ORIGINS = [
  'https://www.xgrowth.uno',
  'https://xgrowth.uno',
  'https://sndp-design.github.io',
  // Local development origins:
  'http://localhost:8000',
  'http://localhost:3000',
  'http://127.0.0.1:8000',
  'http://127.0.0.1:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

// Try models in order; first one that responds wins. Lets the worker survive
// Google deprecating / gating individual models, and lets us prefer the newest
// model whose free-tier quota hasn't been exhausted on a given day.
const GEMINI_MODELS = [
  'gemini-3-flash-preview',
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

    // Health check accepts any method (useful for browser smoke tests too)
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'xgrowth-api', endpoints: ['/generate'] }, 200, origin, allowed);
    }

    if (request.method !== 'POST') {
      return json({ error: 'Use POST' }, 405, origin, allowed);
    }

    if (url.pathname !== '/generate') {
      return json({ error: 'Not found' }, 404, origin, allowed);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, origin, allowed);
    }

    const { topic, articleTitle, articleAngle, articleUrl, platform } = body;
    const mode = body.mode || 'default';

    if (!articleTitle || typeof articleTitle !== 'string') {
      return json({ error: 'Missing articleTitle' }, 400, origin, allowed);
    }
    if (!['linkedin', 'x'].includes(platform)) {
      return json({ error: 'platform must be "linkedin" or "x"' }, 400, origin, allowed);
    }

    if (!env.GEMINI_API_KEY) {
      return json({ error: 'Server missing GEMINI_API_KEY secret' }, 500, origin, allowed);
    }

    const prompt = buildPrompt({ topic, articleTitle, articleAngle, articleUrl, platform, mode });

    try {
      const { text, model } = await callGemini(env.GEMINI_API_KEY, prompt);
      const final = platform === 'x' ? trimForX(text) : text;
      return json({ ok: true, text: final, platform, mode, model }, 200, origin, allowed);
    } catch (err) {
      return json({ error: 'Generation failed: ' + (err.message || 'unknown') }, 502, origin, allowed);
    }
  },
};

/* ----------------------- helpers ----------------------- */

// Safety net: if Gemini overshoots 280 for an X post, trim from the end
// while preserving the URL (if any) on its own line.
function trimForX(text){
  if(!text) return text;
  const TWEET_LIMIT = 280;
  if(text.length <= TWEET_LIMIT) return text;

  // Find the URL — typically the last non-empty line, or any line starting with http
  const lines = text.split('\n');
  let urlIdx = -1;
  for(let i = lines.length - 1; i >= 0; i--){
    if(/^https?:\/\//.test(lines[i].trim())){ urlIdx = i; break; }
  }

  let url = '';
  let before = text;
  if(urlIdx >= 0){
    url = lines[urlIdx].trim();
    before = lines.slice(0, urlIdx).join('\n').trim();
  }

  // Budget for the prose: full 280 minus URL minus the two newlines that separate them
  const separator = url ? '\n\n' : '';
  const budget = TWEET_LIMIT - url.length - separator.length;
  if(budget <= 0){
    // URL alone is over budget — return URL only
    return url || text.slice(0, 277) + '…';
  }

  // First try: cut from the end at sentence boundaries (., ?, !)
  let trimmed = before;
  while(trimmed.length > budget){
    // Find last sentence boundary that leaves us under budget
    const boundaries = [];
    const re = /[.!?](\s|$)/g;
    let m;
    while((m = re.exec(trimmed)) !== null){
      boundaries.push(m.index + 1);
    }
    // Take the largest boundary that fits
    let cut = boundaries.reverse().find(b => b <= budget);
    if(cut == null){
      // No sentence boundary fits — hard cut at word boundary
      const slice = trimmed.slice(0, budget - 1);
      const lastSpace = slice.lastIndexOf(' ');
      trimmed = (lastSpace > 30 ? slice.slice(0, lastSpace) : slice).trim() + '…';
      break;
    }
    trimmed = trimmed.slice(0, cut).trim();
  }

  return url ? `${trimmed}${separator}${url}` : trimmed;
}


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
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin, allowed),
    },
  });
}

function buildPrompt({ topic, articleTitle, articleAngle, articleUrl, platform, mode }) {
  const platformGuide =
    platform === 'linkedin'
      ? `Write a LinkedIn post. 1000-1600 characters total. Structure:
- 1 sharp opener sentence (not "I" or "As a founder")
- 2-4 sentences of specific reaction that references the article's actual content
- Optional: 2-3 bullet points if it sharpens the message (use → as the bullet marker, not "1.")
- 1 short question that invites a real reply (not "thoughts?")
- Article URL on its own line at the end
- 2 hashtags max, on the final line`
      : `Write a single tweet. HARD CONSTRAINT: 280 characters TOTAL — count every character including spaces, line breaks, AND the URL. The URL counts as 23 characters even if longer (Twitter shortens to t.co). Aim for at most 240 characters of plain text PLUS the 23-char URL. If you can't fit it, cut the take, not the URL. Structure:
- 1-2 punchy lines with a specific take on the article (≤240 chars)
- Blank line
- Article URL at the end on its own line
- NO hashtags, NO "thoughts?", NO threads.
- BEFORE returning, COUNT your characters. If over 280, rewrite shorter.`;

  const toneGuide =
    {
      shorter: 'Make it noticeably shorter and tighter than a default-length post. Cut every word that does not earn its place.',
      contrarian: 'Take a sharp contrarian angle. Push back on the conventional read of this news. Be specific about what others are missing.',
      founder: 'Write like a build-in-public founder sharing a real moment of insight. Personal, conversational, slightly vulnerable.',
      data: 'Lean into a specific number, stat, or comparison. If a stat isn\'t in the article, extrapolate plausibly. Be concrete.',
      default: 'Default voice: smart, specific, human. Like an experienced operator with a real point of view.',
    }[mode] || 'Default voice: smart, specific, human.';

  return `You are writing a social media post for a startup founder named Sandeep who runs XGrowth, a marketing OS for digital products. Founders, indie hackers, and SaaS operators are his audience.

TOPIC HE FOLLOWS: "${topic || 'startup growth'}"

ARTICLE HE JUST READ:
Title: ${articleTitle}
${articleAngle ? 'Context: ' + articleAngle + '\n' : ''}${articleUrl ? 'URL: ' + articleUrl : ''}

${platformGuide}

VOICE: ${toneGuide}

HARD RULES — break ANY of these and the post is unusable:
- Be SPECIFIC to this article. Reference its actual content, not generic advice.
- NO clichés: "in today's fast-paced world", "game-changer", "moving the needle", "synergy", "leveraging", "let's dive in", "thoughts?", "what are your takes", "the future of X is Y".
- NO meta-commentary about the post itself ("Here's a post about...").
- NO emojis unless the topic genuinely calls for one (e.g., 🚀 is banned).
- NO bold/italics markdown — LinkedIn and X don't render it.
- NO closing platitudes ("hope this helps!", "keep building").
- Write in first person, present tense.
- Sound like a smart human, not a content marketer.

Return ONLY the post text. No preamble. No explanation. No quote marks around it. Just the text the user will copy and paste.`;
}

async function callGemini(apiKey, prompt) {
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.85,
      topP: 0.95,
      maxOutputTokens: 2048,
      // Disable Gemini 2.5's "thinking" tokens — they're meant for reasoning tasks
      // and eat the output budget. Writing a social post doesn't need chain-of-thought.
      thinkingConfig: { thinkingBudget: 0 },
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
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
        // Retry next model on quota/auth/not-found errors; abort on bad-request (our payload)
        if (resp.status === 400) {
          throw new Error(`Gemini 400 (bad request): ${t.slice(0, 200)}`);
        }
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
