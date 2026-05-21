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

    // Health check (no auth)
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'xgrowth-api', endpoints: ['/generate', '/preview'] }, 200, origin, allowed);
    }

    if (request.method !== 'POST') {
      return json({ error: 'Use POST' }, 405, origin, allowed);
    }

    const VALID_PATHS = ['/generate', '/generate-image', '/preview'];
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
      try {
        let result;
        if (provider === 'hf-flux') {
          if (!env.HF_TOKEN) return json({ error: 'HF_TOKEN secret not set — run: npx wrangler secret put HF_TOKEN' }, 500, origin, allowed);
          result = await callHuggingFaceImage(env.HF_TOKEN, prompt);
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

    const decode = s => s
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
      .replace(/&nbsp;/g, ' ').trim();

    return json({ ok: true, title: decode(rawTitle), description: decode(rawDesc) }, 200, origin, allowed);
  } catch (e) {
    return json({ error: 'Preview failed: ' + (e.message || 'unknown') }, 502, origin, allowed);
  }
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
    'hot-take':   'Take the sharpest, most contrarian angle. Challenge what everyone thinks they know. Be specific about what others are missing or getting wrong.',
    'story':      'Frame this as a narrative: setup → tension → resolution with a lesson. First person. Human and specific.',
    'teach':      'Explain what this means and why it matters. Break it down clearly. Teach one thing well. No jargon.',
    'data':       'Lead with the most concrete number or stat (from the content, or a plausible extrapolation). Build the entire post around that anchor.',
    'question':   'Pose one sharp, thought-provoking question this content raises. Briefly explain why it matters. Make readers stop and think.',
    'founder':    "Write like a founder sharing a real insight while building in public. Personal, slightly vulnerable, honest about what you're learning.",
    'default':    'Smart, specific, human. Like an experienced operator with a real point of view.',
    'shorter':    'Make it noticeably shorter and tighter. Cut every word that does not earn its place.',
    'contrarian': 'Take a sharp contrarian angle. Push back on the conventional read. Be specific about what others are missing.',
  };

  const guide  = platformGuides[platform] || platformGuides.linkedin;
  const tone   = typeGuides[mode] || typeGuides['hot-take'];
  const voice  = voiceTail({ voiceNiche, voiceStyle });

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

Return ONLY the post content. No preamble. No explanation. No quote marks. Just the content.${refineInstruction ? `\n\nREFINEMENT INSTRUCTION (apply this to your output): ${refineInstruction}` : ''}`;
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
  const { caption = '', niche = '' } = body;
  return `You are a visual creative director generating a Pollinations.ai image prompt for an Instagram post.

INSTAGRAM CAPTION:
${caption.slice(0, 800)}
${niche ? `\nNICHE / PRODUCT: ${niche}` : ''}

Generate ONE image prompt for a 1080×1080 Instagram visual that matches this post's theme.

Rules:
- Describe the VISUAL SCENE concretely: subject, composition, lighting, background, color palette
- Start with the photographic style: "dark minimal product photography", "clean flatlay", "cinematic close-up", etc.
- Include lighting quality, background mood, camera angle, depth of field
- NO text, NO logos, NO faces, NO UI screenshots
- Avoid abstract words: "success", "growth", "innovation"
- 15–40 words total, specific and vivid

Good prompt examples:
- "dark minimal flatlay, MacBook on matte black surface, soft rim lighting, deep shadows, professional product photography, 4K detail"
- "cinematic smartphone glowing in darkness, blue-purple gradient halo, neon reflections, shallow depth of field, editorial feel"
- "clean white desk workspace, coffee, notebook, natural window light, flat-lay, high contrast, commercial photography"

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

/* ─── Hugging Face image client ───────────────────────────────────────────── */

const HF_MODELS = {
  'hf-flux': 'black-forest-labs/FLUX.1-schnell',
};

async function callHuggingFaceImage(token, prompt) {
  const modelId = HF_MODELS['hf-flux'];
  const resp = await fetch(`https://api-inference.huggingface.co/models/${modelId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'image/png,image/jpeg,image/*',
    },
    body: JSON.stringify({ inputs: prompt, parameters: { width: 1024, height: 1024 } }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    // Model still loading — common on cold start
    if (resp.status === 503) throw new Error('Model loading, retry in ~20s');
    throw new Error(`HF API ${resp.status}: ${t.slice(0, 150)}`);
  }

  const mimeType = resp.headers.get('Content-Type') || 'image/jpeg';
  const buffer = await resp.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Convert binary to base64 in chunks to avoid call-stack overflow
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const imageData = btoa(binary);
  return { imageData, mimeType };
}

/* ─── Gemini image client ─────────────────────────────────────────────────── */

// Models to try in order for image generation (free tier)
const GEMINI_IMAGE_MODELS = [
  'gemini-2.0-flash-preview-image-generation',
  'gemini-2.0-flash-exp-image-generation',
  'gemini-2.0-flash-exp',
];

async function callGeminiImage(apiKey, prompt) {
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: `Generate a high-quality image: ${prompt}` }] }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 1,
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

  throw new Error(`All image models failed. ${errors.join(' | ')}`);
}

/* ─── Gemini client ────────────────────────────────────────────────────────── */

async function callGemini(apiKey, prompt) {
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.85,
      topP: 0.95,
      maxOutputTokens: 2048,
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
