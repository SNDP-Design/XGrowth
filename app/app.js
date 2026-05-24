/* ========= State ========= */
const KEY = 'foundergrowth_v1';
const USER_KEY = 'foundergrowth_user_v1';
const GOOGLE_CLIENT_ID = '595634587931-0m14acb1o9tiqbqt6qcnsafma4c03tm6.apps.googleusercontent.com';
let currentUser = JSON.parse(localStorage.getItem(USER_KEY) || 'null');

/* ========= Firebase init ========= */
const firebaseConfig = {
  apiKey: "AIzaSyBdf9wvcLM2k4xHD2rZQ_bQlvqYIoyrFHU",
  authDomain: "auth.xgrowth.uno",
  projectId: "xgrowth-351de",
  storageBucket: "xgrowth-351de.firebasestorage.app",
  messagingSenderId: "595634587931",
  appId: "1:595634587931:web:d6123a514e45a41c286bbe",
  measurementId: "G-WEXX5KT98Z"
};
firebase.initializeApp(firebaseConfig);
const fbAuth = firebase.auth();
const db = firebase.firestore();
let saveDebounce = null;
let cloudLoaded = false;
// Detect whether we arrived from a marketing CTA (?signin=1) and must auto-trigger Google login
const wantsSignin = (new URLSearchParams(window.location.search)).get('signin') === '1';
// Strip the param immediately so refreshes don't loop
if(wantsSignin){
  const u = new URL(window.location.href);
  u.searchParams.delete('signin');
  history.replaceState({}, '', u.toString());
}
// Process any pending redirect result from a Google sign-in flow.
// IMPORTANT: track when this finishes so we don't redirect-to-landing too early.
let redirectResultDone = false;
fbAuth.getRedirectResult().then(res=>{
  if(res && res.user){
    toast(`Welcome, ${(res.user.displayName||'there').split(' ')[0]}`);
  }
}).catch(err=>{
  if(err && err.code && err.code !== 'auth/null-credential'){
    console.error('Redirect sign-in error', err);
    toast('Sign-in failed: ' + (err.message||err.code));
  }
}).finally(()=>{
  redirectResultDone = true;
  // If still not signed in after redirect result is in, run the gate decision now.
  if(!fbAuth.currentUser){
    runAuthGateLogic();
  }
});
const state = load() || {
  profile: null,
  metrics: {
    followers: [],
    impressions: [],
    engagement: [],
    visits: []
  },
  range: 7
};
// Always start at 7-day range on login.
state.range = 7;

function save(){
  localStorage.setItem(KEY, JSON.stringify(state));
  // Mirror to Firestore (debounced) when signed in
  if(fbAuth.currentUser && cloudLoaded){
    clearTimeout(saveDebounce);
    saveDebounce = setTimeout(()=>{
      db.collection('users').doc(fbAuth.currentUser.uid).set(state, {merge:false})
        .catch(err=>{ console.error('Cloud save failed', err); });
    }, 700);
  }
}
function load(){ try{return JSON.parse(localStorage.getItem(KEY))}catch{return null} }
async function loadFromCloud(){
  if(!fbAuth.currentUser) return;
  try{
    const snap = await db.collection('users').doc(fbAuth.currentUser.uid).get();
    if(snap.exists){
      const cloud = snap.data() || {};
      Object.assign(state, cloud);
      state.range = 7;
      localStorage.setItem(KEY, JSON.stringify(state));
      cloudLoaded = true;
      if(state.profile){ applyProfile(); }
    } else {
      cloudLoaded = true;
      await db.collection('users').doc(fbAuth.currentUser.uid).set(state);
    }
  }catch(err){
    console.error('Cloud load failed', err);
    cloudLoaded = false;
  }
}

/* ========= Navigation ========= */
const nav = document.getElementById('nav');
nav.addEventListener('click', e=>{
  const b = e.target.closest('button[data-view]'); if(!b) return;
  document.querySelectorAll('#nav button').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  const v = b.dataset.view;
  document.querySelectorAll('main > section').forEach(s=>s.classList.add('hide'));
  const sec = document.querySelector(`section[data-view="${v}"]`);
  if(sec) sec.classList.remove('hide');
});

/* ========= Welcome / Profile ========= */
function openWelcome(){ document.getElementById('welcome').classList.add('show'); }
// Close any open modal when the user taps the dark overlay outside the box.
document.querySelectorAll('.modal').forEach(m=>{
  m.addEventListener('click', (e)=>{
    if(e.target === m){
      if(m.id === 'welcome') closeWelcome(true);
      else m.classList.remove('show');
    }
  });
});
// Close modals + mobile sidebar on Escape (2.1.2 No Keyboard Trap)
document.addEventListener('keydown', (e)=>{
  if(e.key === 'Escape'){
    document.querySelectorAll('.modal.show').forEach(m=>{
      if(m.id === 'welcome') closeWelcome(true);
      else m.classList.remove('show');
    });
    // Image generation modal
    if($('ceImgGenOverlay')?.classList.contains('show')) ceImgClose();
    // Mobile sidebar drawer
    if(document.querySelector('.side.show')) toggleSide(false);
  }
});
function closeWelcome(skip){
  document.getElementById('welcome').classList.remove('show');
  if(skip && !state.profile){
    state.profile = {niche:'AI SaaS', stage:'Pre-seed', target:'Both', goal:'10k followers', industry:'', newsPortals:[]};
    save();
  }
  applyProfile();
}
function saveProfile(){
  const industry = $('pIndustry')?.value || '';
  // Collect which portal chips are active (all on by default, users can deselect)
  const selected = [...document.querySelectorAll('.portal-chip.active')].map(b => b.dataset.pid);
  const allForIndustry = (CE_INDUSTRY_PORTALS[industry] || []).map(p => p.id);
  state.profile = {
    niche: val('pNiche') || 'AI SaaS',
    stage: val('pStage'),
    target: val('pTarget'),
    goal:  val('pGoal') || '10k followers',
    industry,
    newsPortals: selected.length ? selected : allForIndustry,
  };
  state.goals = parseGoals(state.profile.goal);
  save(); closeWelcome(false);
  toast('Profile saved');
}

function applyProfile(){
  const p = state.profile;
  if(!p) return;
  const nicheEl = document.getElementById('nicheTag'); if(nicheEl) nicheEl.textContent = p.niche;
  const stageEl = document.getElementById('stageTag'); if(stageEl) stageEl.textContent = p.stage;
  const goalEl  = document.getElementById('goalTag');  if(goalEl)  goalEl.textContent  = p.goal;
  const audEl   = document.getElementById('audienceTag'); if(audEl) audEl.textContent = p.target || '—';
  const st = document.getElementById('sessionTag'); if(st) st.textContent = p.niche?.split(' ')[0] || '';
}

function parseGoals(s){
  const out = [];
  const re = /(\d+\.?\d*)\s*(k|m)?\s*([a-zA-Z ]+)/g; let m;
  while((m = re.exec(s))){
    let n = parseFloat(m[1]);
    if(m[2]==='k') n*=1000; else if(m[2]==='m') n*=1e6;
    const label = m[3].trim().replace(/[,.]$/,'');
    out.push({label, target:n, current:0});
  }
  return out.slice(0,4);
}

/* ========= Helpers ========= */
const $ = id => document.getElementById(id);
const val = id => ($(id)?.value || '').trim();
function toast(msg){ const t = $('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),1400); }
function copyOut(id){ navigator.clipboard.writeText($(id).innerText).then(()=>toast('Copied')); }
function clearOut(id){ $(id).textContent='Cleared. Re-run when ready.'; }
function fmt(n){ if(n>=1e6) return (n/1e6).toFixed(1)+'M'; if(n>=1e3) return (n/1e3).toFixed(1)+'k'; return Math.round(n).toString(); }
function pct(a,b){ if(!b) return 0; return ((a-b)/b)*100; }
function sum(arr){ return arr.reduce((a,b)=>a+b,0); }
function avg(arr){ return arr.length? sum(arr)/arr.length : 0; }
function escapeHtml(s){ return s.replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
function truncate(s,n){ return s.length>n? s.slice(0,n-1)+'…' : s; }

/* ========= Generator context helper ========= */
function p(){ return state.profile || {niche:'AI SaaS', stage:'Pre-seed', target:'Both', goal:'10k followers'}; }

/* =========================================================
   CONTENT ENGINE — full rebuild
   3 input modes · 5 platforms · 6 post types · history
   Industry-aware news portal routing
   ========================================================= */

/* ── Industry → portal catalog ────────────────────────────────────────── */
// Portal definitions shown in the onboarding picker and used to label sources.
// IDs must match PORTAL_CATALOG keys in the Worker.
const CE_INDUSTRY_PORTALS = {
  'ai-ml': [
    { id:'venturebeat-ai',  name:'VentureBeat AI' },
    { id:'techcrunch-ai',   name:'TechCrunch AI' },
    { id:'mit-tech-review', name:'MIT Tech Review' },
    { id:'ai-news',         name:'AI News' },
    { id:'the-register-ai', name:'The Register' },
  ],
  'climate-tech': [
    { id:'cleantechnica',   name:'CleanTechnica' },
    { id:'electrek',        name:'Electrek' },
    { id:'carbon-brief',    name:'Carbon Brief' },
    { id:'greenbiz',        name:'GreenBiz' },
    { id:'canary-media',    name:'Canary Media' },
  ],
  'fintech': [
    { id:'finextra',           name:'Finextra' },
    { id:'techcrunch-fintech', name:'TechCrunch Fintech' },
    { id:'payments-dive',      name:'Payments Dive' },
    { id:'banking-dive',       name:'Banking Dive' },
  ],
  'health-tech': [
    { id:'stat-news',        name:'STAT News' },
    { id:'medcity-news',     name:'MedCity News' },
    { id:'healthcare-dive',  name:'Healthcare Dive' },
    { id:'fierce-healthcare',name:'Fierce Healthcare' },
  ],
  'saas-b2b': [
    { id:'saastr',     name:'SaaStr' },
    { id:'techcrunch', name:'TechCrunch' },
    { id:'venturebeat',name:'VentureBeat' },
    { id:'the-verge',  name:'The Verge' },
  ],
  'ecommerce': [
    { id:'modern-retail',       name:'Modern Retail' },
    { id:'retail-dive',         name:'Retail Dive' },
    { id:'techcrunch-commerce', name:'TechCrunch Commerce' },
  ],
  'crypto-web3': [
    { id:'coindesk',      name:'CoinDesk' },
    { id:'cointelegraph', name:'CoinTelegraph' },
    { id:'decrypt',       name:'Decrypt' },
    { id:'the-block',     name:'The Block' },
  ],
  'dev-tools': [
    { id:'the-new-stack', name:'The New Stack' },
    { id:'ars-technica',  name:'Ars Technica' },
    { id:'devto',         name:'Dev.to' },
    { id:'infoq',         name:'InfoQ' },
  ],
  'biotech': [
    { id:'stat-news',      name:'STAT News' },
    { id:'fierce-biotech', name:'Fierce Biotech' },
    { id:'biopharma-dive', name:'BioPharma Dive' },
    { id:'endpoints-news', name:'Endpoints News' },
  ],
  'edtech': [
    { id:'edsurge',          name:'EdSurge' },
    { id:'techcrunch-edtech',name:'TechCrunch EdTech' },
    { id:'the-verge',        name:'The Verge' },
  ],
  'general': [
    { id:'techcrunch',    name:'TechCrunch' },
    { id:'the-verge',     name:'The Verge' },
    { id:'wired',         name:'Wired' },
    { id:'venturebeat',   name:'VentureBeat' },
    { id:'ars-technica',  name:'Ars Technica' },
    { id:'mit-tech-review',name:'MIT Tech Review' },
  ],
};

/* Industry → search keywords for HN Algolia (US startup/tech angle) */

/* Show/hide portal chips when industry is picked in the welcome modal */
function ceOnboardingIndustryChange(industry){
  const portals = CE_INDUSTRY_PORTALS[industry] || [];
  const row    = $('pPortalsRow');
  const chips  = $('pPortalChips');
  if(!portals.length){ if(row) row.style.display='none'; return; }
  if(chips){
    chips.innerHTML = portals.map(p =>
      `<button type="button" class="portal-chip active" data-pid="${p.id}" onclick="this.classList.toggle('active')">${p.name}</button>`
    ).join('');
  }
  if(row) row.style.display='';
}
function ceEsc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/* ── CE state ───────────────────────────────────────────────────────────── */
const CE_API = 'https://xgrowth-api.xgrowth.workers.dev';

// Image generation state
const _imgGen = { selectedUrl: '', selectedIdx: -1, seeds: [], _failCount: 0, _failTimer: null };

// 6 Pollinations models for the parallel grid.
// Loaded browser-direct (free, no API key). Cloudflare Worker IPs get 402 from Pollinations
// (CDN IP blocking) so these must be fetched by the browser, not proxied.
const IMGGEN_GRID_MODELS = [
  { id: 'flux-pro',     label: 'FLUX Pro',     tag: 'Best overall'   },
  { id: 'flux-realism', label: 'Realism',      tag: 'Photorealistic' },
  { id: 'flux',         label: 'FLUX Schnell', tag: 'Fast & clean'   },
  { id: 'flux-anime',   label: 'Anime',        tag: 'Illustrated'    },
  { id: 'flux-3d',      label: 'FLUX 3D',      tag: '3D / Product'   },
  { id: 'any-dark',     label: 'Any Dark',     tag: 'Dark aesthetic' },
];

// Authed POST to the Worker. Attaches the user's Firebase ID token.
async function xgFetch(path, payload){
  const user = fbAuth?.currentUser;
  if(!user) throw new Error('Sign in required');
  const token = await user.getIdToken();
  const resp = await fetch(CE_API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify(payload || {}),
  });
  let data = null;
  try { data = await resp.json(); } catch {}
  if(!resp.ok || !data?.ok){
    const err = data?.error || ('HTTP ' + resp.status);
    throw new Error(err);
  }
  return data;
}

const _ce = {
  inputMode: 'url',
  topic: '',
  article: null,
  platform: 'linkedin',        // legacy compat — primary state is now per-card
  postType: 'hot-take',        // legacy compat
  postTypes: { linkedin:'hot-take', x:'hot-take', instagram:'hot-take', reddit:'hot-take' },
  threadMode: false,
  refineInstruction: '',
  posts: {},
  voice: { style: 'casual', niche: '' },
  history: [],
  historyOpen: false,
  _pickedAt: null,
  _platGen: {},                // per-platform generation counter for race-guard
  _articles: [],
  _xPosts: [],
  _modeState: {},   // saved output state keyed by input mode
};
['linkedin','x','instagram','reddit'].forEach(p => {
  _ce.posts[p] = { text: '', loading: false, generated: false };
  _ce._platGen[p] = 0;
});

/* ── Input mode switching ─────────────────────────────────────────────── */

function ceSwitchInputMode(mode) {
  const prev = _ce.inputMode;
  _ce.inputMode = mode;
  if(prev !== mode){
    // Snapshot the leaving tab's output so it can be restored on return
    _ce._modeState[prev] = {
      posts: JSON.parse(JSON.stringify(_ce.posts)),
      article: _ce.article,
      pickedAt: _ce._pickedAt,
      threadMode: _ce.threadMode,
      html: $('ceGenerated').innerHTML,
      emptyDisplay: $('ceEmpty').style.display,
      trendDisplay: $('ceTrendContext').style.display,
    };
    // Restore the arriving tab's saved state, or start fresh
    const saved = _ce._modeState[mode];
    if(saved){
      ['linkedin','x','instagram','reddit'].forEach(p => { _ce.posts[p] = saved.posts[p]; });
      _ce.article = saved.article;
      _ce._pickedAt = saved.pickedAt;
      _ce.threadMode = saved.threadMode;
      $('ceGenerated').innerHTML = saved.html;
      $('ceEmpty').style.display = saved.emptyDisplay;
      $('ceTrendContext').style.display = saved.trendDisplay;
    } else {
      ceResetOutput();
      _ce.article = null;
      _ce._pickedAt = null;
    }
  }
  // aria-selected keeps screen readers in sync with the active tab (4.1.2)
  document.querySelectorAll('.ce-mode-tab').forEach(b => {
    const isActive = b.dataset.cmode === mode;
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  document.querySelectorAll('.ce-mode-panel').forEach(p => p.classList.remove('active'));
  const panelMap = { url:'ceModeUrl', write:'ceModeWrite' };
  $(panelMap[mode])?.classList.add('active');
}

function ceRelDate(iso){
  if(!iso) return 'recent';
  const d = new Date(iso), diff = (Date.now() - d.getTime()) / 1000;
  if(diff < 3600){ const h = Math.floor(diff/3600); return h===1?'1h ago':`${h}h ago`; }
  if(diff < 86400){ const dd = Math.floor(diff/86400); return dd===1?'1 day ago':`${dd} days ago`; }
  if(diff < 604800){ const w = Math.floor(diff/604800); return w===1?'1 week ago':`${w} weeks ago`; }
  return d.toLocaleDateString();
}

/* ── URL mode ─────────────────────────────────────────────────────────── */

async function ceGenerateFromUrl(){
  const url = $('ceUrlInput')?.value?.trim();
  if(!url || !url.startsWith('http')){ toast('Paste a valid URL first'); $('ceUrlInput')?.focus(); return; }
  const btn = $('ceUrlBtn');
  if(btn){ btn.disabled=true; btn.innerHTML='<span class="ce-spinner"></span>Generating…'; }

  let title = url, angle = '';
  try {
    const data = await xgFetch('/preview', { url });
    if(data.title) title = data.title;
    if(data.description) angle = data.description;
  } catch(e){ /* fall back to URL as title */ }

  _ce.topic = title;
  _ce.article = { title, angle, url };
  const pickedAt = Date.now(); _ce._pickedAt = pickedAt;
  ['linkedin','x','instagram','reddit'].forEach(p => { _ce.posts[p] = {text:'',loading:true,generated:false}; });
  $('ceTrendContext').innerHTML = `<h4>${ceEsc(title)}</h4>${angle?`<p>${ceEsc(angle)}</p>`:''}`;
  $('ceTrendContext').style.display = '';
  ceShowControls();
  ceRenderAllPosts();
  ['linkedin','x','instagram','reddit'].forEach(p => ceGeneratePlatform(p, pickedAt));

  if(btn){ btn.disabled=false; btn.innerHTML='Generate →'; }
  if(window.innerWidth<=1100) $('ceStep3')?.scrollIntoView({behavior:'smooth',block:'start'});
}

/* ── Write mode ───────────────────────────────────────────────────────── */

async function ceGenerateFromWrite(){
  const notes = $('ceWriteInput')?.value?.trim();
  const topic = $('ceWriteTopic')?.value?.trim();
  if(!notes){ toast('Write something first'); $('ceWriteInput')?.focus(); return; }
  _ce.topic = topic||'startup insight';
  _ce.article = { title:notes, angle:'', url:'', inputMode:'freewrite' };
  const pickedAt = Date.now(); _ce._pickedAt = pickedAt;
  ['linkedin','x','instagram','reddit'].forEach(p => { _ce.posts[p] = {text:'',loading:true,generated:false}; });
  $('ceTrendContext').style.display='none';
  ceShowControls();
  ceRenderAllPosts();
  ['linkedin','x','instagram','reddit'].forEach(p => ceGeneratePlatform(p, pickedAt));
}

/* ── X Profile mode ───────────────────────────────────────────────────── */

async function ceFetchXProfile(){
  const raw = $('ceXProfileInput')?.value?.trim();
  if(!raw){ toast('Enter a username or profile URL'); $('ceXProfileInput')?.focus(); return; }

  // Extract handle from full URL or bare @handle
  let username = raw.replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i,'').split(/[/?#]/)[0].replace(/^@/,'').trim();
  if(!username){ toast('Could not parse username from that URL'); return; }

  const btn = $('ceXProfileBtn');
  const results = $('ceXProfileResults');
  if(btn){ btn.disabled=true; btn.innerHTML='<span class="ce-spinner"></span>Fetching…'; }
  if(results) results.style.display='none';

  try {
    const data = await xgFetch('/x-profile', { username });
    const posts = data.posts || [];

    if(!posts.length){
      toast(data.error || 'No posts found for @'+username+'. The account may be private or Nitter may be down.');
      if(btn){ btn.disabled=false; btn.innerHTML='Fetch posts →'; }
      return;
    }

    _ce._xPosts = posts;

    if(results){
      results.innerHTML = `
        <div class="ce-sources-lbl" style="margin-bottom:8px">@${ceEsc(username)} · ${posts.length} recent posts</div>
        <div class="ce-trends">
          ${posts.map((p,i) => `
            <button type="button" class="ce-trend" onclick="ceUseXPost(${i})">
              <div class="ce-trend-meta">
                <span class="ce-tag">X Post</span>
                <span class="ce-trend-source">${ceEsc(ceRelDate(p.date))}</span>
              </div>
              <h4>${ceEsc(p.text.slice(0,160))}${p.text.length>160?'…':''}</h4>
              <div class="ce-trend-foot">
                <a class="ce-trend-source" href="${ceEsc(p.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="text-decoration:underline">View on X ↗</a>
                <span class="ce-pick">Repurpose →</span>
              </div>
            </button>`).join('')}
        </div>`;
      results.style.display = 'block';
    }
  } catch(e){
    toast('Failed to fetch — try again');
  }

  if(btn){ btn.disabled=false; btn.innerHTML='Fetch posts →'; }
}

function ceUseXPost(idx){
  const p = _ce._xPosts?.[idx];
  if(!p) return;
  const pickedAt = Date.now();
  _ce._pickedAt = pickedAt;
  _ce.topic = 'Repurpose X post';
  _ce.article = { title: p.text, angle: 'Repurpose this tweet into a native post.', url: p.url, inputMode: 'xpost' };
  ['linkedin','x','instagram','reddit'].forEach(pl => { _ce.posts[pl] = {text:'',loading:false,generated:false}; });
  $('ceTrendContext').innerHTML = `<h4>${ceEsc(p.text.slice(0,140))}${p.text.length>140?'…':''}</h4>
    <p style="font-size:12px;color:var(--muted);margin:4px 0 0">Repurposing from X &nbsp;·&nbsp; <a href="${ceEsc(p.url)}" target="_blank" rel="noopener" style="color:var(--muted);text-decoration:underline">View original ↗</a></p>`;
  $('ceTrendContext').style.display='';
  ceShowControls();
  ceRenderAllPosts();
  ['linkedin','x','instagram','reddit'].forEach(pl => ceGeneratePlatform(pl, pickedAt));
  if(window.innerWidth<=1100) $('ceStep3')?.scrollIntoView({behavior:'smooth',block:'start'});
}

/* ── Output controls ──────────────────────────────────────────────────── */

function ceShowControls(){
  $('ceEmpty').style.display='none';
}
function ceResetOutput(){
  const _unused = null; // previously cleared global tabs — now removed
  $('ceTrendContext').style.display='none'; $('ceEmpty').style.display=''; $('ceGenerated').innerHTML='';
  ['linkedin','x','instagram','reddit'].forEach(p => { _ce.posts[p] = {text:'',loading:false,generated:false}; });
  _ce.threadMode = false;
}

/* ── Platform type switching (per-card) ───────────────────────────────── */

function ceSetPlatformType(platform, type){
  _ce.postTypes[platform] = type;
  _ce.refineInstruction = '';
  if(_ce.article){
    _ce.posts[platform] = {text:'',loading:true,generated:false};
    _ce._platGen[platform] = (_ce._platGen[platform]||0) + 1;
    ceRenderPlatformCard(platform);
    ceGeneratePlatform(platform, _ce._pickedAt);
  }
}

function ceSetXMode(mode){
  const isThread = mode === 'thread';
  if(_ce.threadMode === isThread) return;
  _ce.threadMode = isThread;
  if(_ce.article){
    _ce.posts['x'] = { text:'', loading:true, generated:false };
    _ce._platGen['x'] = (_ce._platGen['x']||0) + 1;
    ceRenderPlatformCard('x');
    ceGeneratePlatform('x', _ce._pickedAt);
  } else {
    ceRenderPlatformCard('x'); // just refresh toggle button states
  }
}

/* ── Post generation ──────────────────────────────────────────────────── */

// Generate a single platform's post (async, updates its card when done)
async function ceGeneratePlatform(platform, articlePickedAt){
  const article = _ce.article;
  if(!article) return;
  const myGen = _ce._platGen[platform];
  const type = _ce.postTypes[platform] || 'hot-take';
  const text = await ceCallAPI(platform, article, type);
  // Stale-check: abort if article changed OR a newer gen for this platform started
  if(_ce._pickedAt !== articlePickedAt) return;
  if(_ce._platGen[platform] !== myGen) return;
  _ce.posts[platform].text = text;
  _ce.posts[platform].loading = false;
  _ce.posts[platform].generated = true;
  ceRenderPlatformCard(platform);
  ceSaveToHistory(platform, text, type, article);
}

// Legacy shim — kept for any remaining call sites
async function ceGenerateCurrent(pickedAt){
  const platform = _ce.platform, article = _ce.article;
  if(!article) return;
  _ce.posts[platform].loading=true; _ce.posts[platform].generated=false;
  _ce._platGen[platform] = (_ce._platGen[platform]||0) + 1;
  ceRenderPlatformCard(platform);

  const text = await ceCallAPI(platform, article, _ce.postTypes[platform]||_ce.postType);
  if(_ce._pickedAt !== pickedAt) return;

  _ce.posts[platform].text=text; _ce.posts[platform].loading=false; _ce.posts[platform].generated=true;
  ceRenderPlatformCard(platform);
  ceSaveToHistory(platform, text, _ce.postTypes[platform]||_ce.postType, article);
}

async function ceCallAPI(platform, article, type){
  try {
    // For X threads, send mode='thread'. For all other cases, send the post type as mode.
    const mode = (platform === 'x' && _ce.threadMode) ? 'thread' : type;
    const payload = {
      kind: 'post',
      topic: _ce.topic,
      articleTitle: article.title,
      articleAngle: article.angle || '',
      platform,
      mode,
      voiceNiche: _ce.voice.niche || '',
      voiceStyle: _ce.voice.style || 'casual',
      inputMode: article.inputMode || 'search',
    };
    if(_ce.refineInstruction) payload.refineInstruction = _ce.refineInstruction;
    const data = await xgFetch('/generate', payload);
    return data.text || ceFallback(platform, article);
  } catch(e){ console.warn('CE API error', e); toast('Generation failed — ' + (e.message || 'please try again')); return ceFallback(platform, article); }
}

// Regenerate a specific platform's post
function ceRegeneratePlatform(platform, instruction){
  _ce.refineInstruction = instruction || '';
  _ce.posts[platform] = { text:'', loading:true, generated:false };
  _ce._platGen[platform] = (_ce._platGen[platform]||0) + 1;
  ceRenderPlatformCard(platform);
  ceGeneratePlatform(platform, _ce._pickedAt);
}

// Legacy shims
function ceRegenerate(instruction){ ceRegeneratePlatform(_ce.platform, instruction); }
function ceRegenerateFresh(){ ceRegeneratePlatform(_ce.platform, ''); }

function ceFallback(platform, article){
  const title = article?.title||'Worth a read.';
  if(platform==='x') return title.slice(0,277)+(title.length>277?'…':'');
  if(platform==='instagram') return `CAPTION:\n${title.slice(0,240)}\n\nHASHTAGS:\n#startup #saas #founder #buildinpublic #indiehacker #productlaunch #b2b #growthmarketing #startuplife #solofounder #makersgonnamake #sideproject #bootstrapped #indiemaker #techstartup`;
  if(platform==='reddit') return `SUBREDDIT: startups\n\nTITLE: ${title.slice(0,300)}\n\nBODY:\n${article?.angle||title}`;

  return title;
}

/* ── Rendering ────────────────────────────────────────────────────────── */

const CE_PLAT_INFO = {
  linkedin:  { label:'LinkedIn',  limit:3000,  svg:`<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14zM8.5 17V10h-2v7h2zm-1-7.9a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2zM18 17v-3.9c0-2.1-1.1-3.1-2.6-3.1-1.2 0-1.7.7-2 1.2V10h-2v7h2v-4c0-1 .2-2 1.4-2s1.2 1.1 1.2 2v4H18z"/></svg>` },
  x:         { label:'X / Twitter',limit:280,  svg:`<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2H21.5l-7.36 8.41L23 22h-6.84l-5.21-6.81L4.91 22H1.65l7.86-8.98L1.5 2h6.99l4.71 6.23L18.244 2z"/></svg>` },
  instagram: { label:'Instagram',  limit:2200, svg:`<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"/></svg>` },
  reddit:    { label:'Reddit',     limit:40000, svg:`<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z"/></svg>` },

};

// ── Rendering ─────────────────────────────────────────────────────────────

// Render all 5 platform sections into #ceGenerated
function ceRenderAllPosts(){
  const gen = $('ceGenerated');
  if(!gen) return;
  const platforms = ['linkedin','x','instagram','reddit'];
  const anyActive = platforms.some(p => _ce.posts[p].loading || _ce.posts[p].generated);
  if(!anyActive){ gen.innerHTML=''; return; }
  $('ceEmpty').style.display='none';
  gen.innerHTML = platforms.map(p => cePlatformSectionHTML(p)).join('');
}

// Re-render a single platform card in place
function ceRenderPlatformCard(platform){
  const existing = document.getElementById(`cePlatSec-${platform}`);
  if(!existing){ ceRenderAllPosts(); return; }
  const tmp = document.createElement('div');
  tmp.innerHTML = cePlatformSectionHTML(platform);
  existing.replaceWith(tmp.firstElementChild);
}

// Legacy shim — kept for any remaining call sites
function ceRenderCurrentPost(){ ceRenderAllPosts(); }

// Full platform section card HTML (header + type chips + content + footer)
function cePlatformSectionHTML(platform){
  const info = CE_PLAT_INFO[platform]||CE_PLAT_INFO.linkedin;
  const p = _ce.posts[platform];
  const currentType = _ce.postTypes[platform]||'hot-take';

  const TYPES = [
    {key:'hot-take',label:'Hot Take'},{key:'story',label:'Story'},{key:'teach',label:'Teach'},
    {key:'data',label:'Data-Led'},{key:'question',label:'Question'},{key:'founder',label:'Founder'},
  ];
  // aria-pressed="true/false" exposes toggle state to screen readers (4.1.2)
  const typeChips = TYPES.map(t =>
    `<button class="ce-type-chip${t.key===currentType?' active':''}" onclick="ceSetPlatformType('${platform}','${t.key}')" aria-pressed="${t.key===currentType?'true':'false'}">${t.label}</button>`
  ).join('');

  const xModeRow = platform==='x' ? `<div class="ce-xmode-row" style="margin:0 0 14px">
    <span class="ce-style-label">Format:</span>
    <button class="ce-xmode-btn${!_ce.threadMode?' active':''}" onclick="ceSetXMode('single')">Single post</button>
    <button class="ce-xmode-btn${_ce.threadMode?' active':''}" onclick="ceSetXMode('thread')">Thread</button>
  </div>` : '';

  // Post body
  let body = '';
  if(p.loading){
    // role="status" announces loading state to screen readers; spinner is decorative (4.1.3)
    body = `<div class="ce-skeleton" role="status"><span class="ce-spinner" aria-hidden="true"></span>Writing your ${info.label} post…</div>`;
  } else if(!p.text){
    body = `<div class="ce-skeleton" style="opacity:.3;font-size:13px">Click Generate → to create this post</div>`;
  } else if(platform==='reddit'){
    const {subreddit,title:rt,body:rb} = ceParseReddit(p.text);
    const sub = subreddit||'startups';
    body = `<div class="ce-insta">
      <div><div class="ce-style-label" style="margin-bottom:5px">Subreddit</div><p class="ce-insta-caption" style="font-size:14px">r/${ceEsc(sub)}</p></div>
      <div><div class="ce-style-label" style="margin-bottom:5px">Title</div><p class="ce-insta-caption">${ceEsc(rt)}</p>
        <button class="btn ghost" style="height:28px;padding:0 10px;font-size:12px;margin-top:6px" data-ce-copy="${ceEsc(rt)}" onclick="ceCopyAttr(this)">Copy title</button></div>
      ${rb?`<div><div class="ce-style-label" style="margin-bottom:5px">Body</div><p class="ce-insta-caption">${ceEsc(rb)}</p>
        <button class="btn ghost" style="height:28px;padding:0 10px;font-size:12px;margin-top:6px" data-ce-copy="${ceEsc(rb)}" onclick="ceCopyAttr(this)">Copy body</button></div>`:''}
    </div>`;
  } else if(platform==='instagram'){
    const {caption,hashtags} = ceParseInstagram(p.text);
    body = `<div class="ce-insta">
      <div><div class="ce-style-label" style="margin-bottom:5px">Caption</div><p class="ce-insta-caption">${ceEsc(caption)}</p>
        <button class="btn ghost" style="height:28px;padding:0 10px;font-size:12px;margin-top:6px" data-ce-copy="${ceEsc(caption)}" onclick="ceCopyAttr(this)">Copy caption</button></div>
      ${hashtags?`<div><div class="ce-style-label" style="margin-bottom:5px">Hashtags</div><p class="ce-insta-hashtags">${ceEsc(hashtags)}</p>
        <button class="btn ghost" style="height:28px;padding:0 10px;font-size:12px;margin-top:6px" data-ce-copy="${ceEsc(hashtags)}" onclick="ceCopyAttr(this)">Copy hashtags</button></div>`:''}
    </div>
    <button class="ce-imggen-generate-btn" onclick="ceOpenImageModal()" style="margin:12px 0 0">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
      Generate image
    </button>`;
  } else if(platform==='x' && _ce.threadMode){
    const tweets = ceParseThread(p.text);
    if(tweets.length>=2){
      const tweetHtml = tweets.map((t,i)=>{
        const len=t.length,over=len>280;
        return `<div class="ce-thread-tweet">
          <div class="ce-thread-tweet-head"><span class="ce-thread-num">${i+1} / ${tweets.length}</span>
            <button class="btn ghost ce-thread-copy" data-ce-copy="${ceEsc(t)}" onclick="ceCopyAttr(this)">Copy</button></div>
          <p class="ce-thread-tweet-text">${ceEsc(t)}</p>
          <div class="ce-thread-tweet-foot"><span class="ce-thread-char${over?' over':''}">${len}/280${over?' — over':''}</span></div>
        </div>`;
      }).join('<div class="ce-thread-connector"></div>');
      body = `<div class="ce-thread">${tweetHtml}</div>`;
    } else { body=`<p class="ce-post-text">${ceEsc(p.text)}</p>`; }
  } else {
    body = `<p class="ce-post-text">${ceEsc(p.text)}</p>`;
  }

  // Footer — only shown when there's generated text
  let footer = '';
  if(p.text && !p.loading){
    const limit=info.limit, len=p.text.length;
    const platUrls = {
      linkedin:`https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(p.text.slice(0,1300))}`,
      x:`https://twitter.com/intent/tweet?text=${encodeURIComponent(p.text.slice(0,280))}`,
      instagram:`https://www.instagram.com/`,
      reddit:(()=>{ const m=p.text.match(/SUBREDDIT:\s*(.+)/i); const sub=(m?.[1]||'startups').replace(/^r\//i,'').trim(); const tm=p.text.match(/TITLE:\s*(.+)/i); const t=(tm?.[1]||'').trim(); const bm=p.text.match(/BODY:\s*([\s\S]+?)$/i); return `https://www.reddit.com/r/${encodeURIComponent(sub)}/submit?title=${encodeURIComponent(t)}&text=${encodeURIComponent((bm?.[1]||'').trim())}`; })(),
    };
    footer = `<div class="ce-section-foot">
      <span class="ce-count${limit&&len>limit?' over':''}">${len}${limit?'/'+limit:''} chars</span>
      <div class="ce-section-actions">
        <button class="btn ghost" style="height:32px;font-size:13px" data-ce-copy="${ceEsc(p.text)}" onclick="ceCopyAttr(this)">Copy</button>
        <button class="ce-regen-btn" onclick="ceRegeneratePlatform('${platform}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
          Regenerate
        </button>
        <a class="btn publish" href="${platUrls[platform]||'#'}" target="_blank" rel="noopener noreferrer">Post ↗</a>
      </div>
    </div>`;
  }

  return `<div id="cePlatSec-${platform}" class="ce-platform-section">
    <div class="ce-section-head">
      <span class="ce-post-platform">${info.svg} ${info.label}</span>
      <span class="ce-ai-badge">AI</span>
    </div>
    <div class="ce-section-types">${typeChips}</div>
    ${xModeRow}
    <div class="ce-section-content">${body}</div>
    ${footer}
  </div>`;
}

function cePostCard(platform, loading, text){
  const info = CE_PLAT_INFO[platform]||CE_PLAT_INFO.linkedin;
  if(loading) return `<div class="ce-post"><div class="ce-post-head"><span class="ce-post-platform">${info.svg} ${info.label}</span><span class="ce-ai-badge">AI</span></div><div class="ce-skeleton"><span class="ce-spinner"></span>Writing your ${info.label} post…</div></div>`;
  if(!text) return `<div class="ce-post"><div class="ce-post-head"><span class="ce-post-platform">${info.svg} ${info.label}</span><span class="ce-ai-badge">AI</span></div><div class="ce-skeleton" style="opacity:.5">Ready to generate</div></div>`;

  if(platform==='reddit'){
    const {subreddit, title, body} = ceParseReddit(text);
    const sub = subreddit || 'startups';
    const redditUrl = `https://www.reddit.com/r/${encodeURIComponent(sub)}/submit?title=${encodeURIComponent(title||text.slice(0,300))}&text=${encodeURIComponent(body||'')}`;
    return `<div class="ce-post" data-platform="reddit"><div class="ce-post-head"><span class="ce-post-platform">${info.svg} ${info.label}</span><span class="ce-ai-badge">AI</span></div>
    <div class="ce-insta">
      <div><div class="ce-style-label" style="margin-bottom:6px">Subreddit</div><p class="ce-insta-caption" style="font-size:14px">r/${ceEsc(sub)}</p></div>
      <div><div class="ce-style-label" style="margin-bottom:6px">Title</div><p class="ce-insta-caption">${ceEsc(title)}</p><button class="btn ghost" style="height:30px;padding:0 12px;font-size:12px;margin-top:8px" data-ce-copy="${ceEsc(title)}" onclick="ceCopyAttr(this)">Copy title</button></div>
      ${body?`<div><div class="ce-style-label" style="margin-bottom:6px">Body</div><p class="ce-insta-caption">${ceEsc(body)}</p><button class="btn ghost" style="height:30px;padding:0 12px;font-size:12px;margin-top:8px" data-ce-copy="${ceEsc(body)}" onclick="ceCopyAttr(this)">Copy body</button></div>`:''}
    </div>
    <div class="ce-post-foot"><span class="ce-count">${text.length} chars</span><div class="ce-post-actions"><button class="btn ghost" data-ce-copy="${ceEsc(text)}" onclick="ceCopyAttr(this)">Copy all</button><a class="btn publish" href="${redditUrl}" target="_blank" rel="noopener noreferrer">Post ↗</a></div></div>
    ${ceRefineBar()}</div>`;
  }

  if(platform==='instagram'){
    const {caption, hashtags} = ceParseInstagram(text);
    return `<div class="ce-post" data-platform="instagram"><div class="ce-post-head"><span class="ce-post-platform">${info.svg} ${info.label}</span><span class="ce-ai-badge">AI</span></div>
    <div class="ce-insta">
      <div><div class="ce-style-label" style="margin-bottom:6px">Caption</div><p class="ce-insta-caption">${ceEsc(caption)}</p><button class="btn ghost" style="height:30px;padding:0 12px;font-size:12px;margin-top:8px" data-ce-copy="${ceEsc(caption)}" onclick="ceCopyAttr(this)">Copy caption</button></div>
      ${hashtags?`<div><div class="ce-style-label" style="margin-bottom:6px">Hashtags</div><p class="ce-insta-hashtags">${ceEsc(hashtags)}</p><button class="btn ghost" style="height:30px;padding:0 12px;font-size:12px;margin-top:8px" data-ce-copy="${ceEsc(hashtags)}" onclick="ceCopyAttr(this)">Copy hashtags</button></div>`:''}
    </div>
    <button class="ce-imggen-generate-btn" onclick="ceOpenImageModal()" style="margin:4px 0 0">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
      Generate image
    </button>
    <div class="ce-post-foot"><span class="ce-count">${text.length} chars</span><div class="ce-post-actions"><button class="btn ghost" data-ce-copy="${ceEsc(text)}" onclick="ceCopyAttr(this)">Copy all</button><a class="btn publish" href="https://www.instagram.com/" target="_blank" rel="noopener noreferrer">Post ↗</a></div></div>
    ${ceRefineBar()}</div>`;
  }

  // X thread rendering — detect thread format (2+ numbered chunks)
  if(platform==='x' && _ce.threadMode){
    const tweets = ceParseThread(text);
    if(tweets.length >= 2) return ceThreadCard(tweets);
    // Fall through to single-tweet renderer if parsing failed
  }


  const limit = info.limit, len = text.length;
  const postUrl = {
    linkedin: `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text.slice(0,1300))}`,
    x:        `https://twitter.com/intent/tweet?text=${encodeURIComponent(text.slice(0,280))}`,
  }[platform]||'#';

  return `<div class="ce-post" data-platform="${platform}"><div class="ce-post-head"><span class="ce-post-platform">${info.svg} ${info.label}</span><span class="ce-ai-badge">AI</span></div>
  <p class="ce-post-text">${ceEsc(text)}</p>
  <div class="ce-post-foot"><span class="ce-count ${limit&&len>limit?'over':''}">${len}${limit?'/'+limit:''} chars</span><div class="ce-post-actions"><button class="btn ghost" data-ce-copy="${ceEsc(text)}" onclick="ceCopyAttr(this)">Copy</button><a class="btn publish" href="${postUrl}" target="_blank" rel="noopener noreferrer">Post ↗</a></div></div>
  ${ceRefineBar()}</div>`;
}

/* ── Parsers ──────────────────────────────────────────────────────────── */

function ceRefineBar(){
  return `<div class="ce-refine-bar">
    <button class="ce-regen-btn" onclick="ceRegenerateFresh()" title="New variation">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
      Regenerate
    </button>
  </div>`;
}

function ceParseReddit(text){
  const subMatch   = text.match(/SUBREDDIT:\s*(.+)/i);
  const sub        = (subMatch?.[1]||'').replace(/^r\//i,'').trim();
  const titleMatch = text.match(/TITLE:\s*(.+)/i);
  const title      = (titleMatch?.[1]||'').trim();
  const bodyMatch  = text.match(/BODY:\s*([\s\S]+?)$/i);
  const body       = (bodyMatch?.[1]||'').trim();
  return { subreddit: sub, title, body };
}

function ceParseThread(text){
  // Split on "N/" markers at line start or after blank line
  const tweets = [];
  const parts = text.split(/\n\s*\n/);
  for(const part of parts){
    const cleaned = part.replace(/^\d+\/\s*/,'').trim();
    if(cleaned) tweets.push(cleaned);
  }
  // Fallback: if parsing gave only 1 chunk, try inline split
  if(tweets.length <= 1){
    const inline = text.split(/(?=\n\d+\/)/).map(s => s.replace(/^\n?\d+\/\s*/,'').trim()).filter(Boolean);
    if(inline.length > 1) return inline;
  }
  return tweets;
}

function ceThreadCard(tweets){
  const xInfo = CE_PLAT_INFO.x;
  const allText = tweets.join('\n\n');
  const tweetHtml = tweets.map((t, i) => {
    const len = t.length;
    const over = len > 280;
    return `<div class="ce-thread-tweet">
      <div class="ce-thread-tweet-head">
        <span class="ce-thread-num">${i+1} / ${tweets.length}</span>
        <button class="btn ghost ce-thread-copy" data-ce-copy="${ceEsc(t)}" onclick="ceCopyAttr(this)">Copy</button>
      </div>
      <p class="ce-thread-tweet-text">${ceEsc(t)}</p>
      <div class="ce-thread-tweet-foot">
        <span class="ce-thread-char${over?' over':''}">
          ${len} / 280${over?' — over limit':''}
        </span>
      </div>
    </div>`;
  }).join('<div class="ce-thread-connector"></div>');

  return `<div class="ce-post" data-platform="x">
    <div class="ce-post-head">
      <span class="ce-post-platform">${xInfo.svg} ${xInfo.label} thread</span>
      <span class="ce-ai-badge">AI</span>
    </div>
    <div class="ce-thread">${tweetHtml}</div>
    <div class="ce-thread-actions">
      <button class="btn ghost" style="font-size:13px;height:36px" data-ce-copy="${ceEsc(allText)}" onclick="ceCopyAttr(this)">Copy all tweets</button>
      <span style="flex:1"></span>
      <span style="font-size:12px;color:var(--muted);align-self:center">${tweets.length} tweets · ${allText.length} chars total</span>
    </div>
    ${ceRefineBar()}
  </div>`;
}

function ceParseInstagram(text){
  // Match CAPTION: section up to double-newline + HASHTAGS: OR end of string
  const cm = text.match(/CAPTION:\s*([\s\S]+?)(?:\n\n+HASHTAGS:|$)/i);
  const hm = text.match(/HASHTAGS:\s*([\s\S]+?)$/i);
  if(cm || hm) return { caption:(cm?.[1]||'').trim(), hashtags:(hm?.[1]||'').trim() };
  // Fallback: split on a line that has 5+ hashtags
  const lines = text.split('\n');
  const hi = lines.findIndex(l => (l.match(/#\w+/g)||[]).length >= 5);
  if(hi > 0) return { caption:lines.slice(0,hi).join('\n').trim(), hashtags:lines.slice(hi).join('\n').trim() };
  return { caption:text, hashtags:'' };
}


/* ── History ──────────────────────────────────────────────────────────── */

async function ceSaveToHistory(platform, text, type, article){
  if(!fbAuth.currentUser||!text) return;
  try {
    await db.collection('users').doc(fbAuth.currentUser.uid).collection('ceHistory').add({
      platform, text, type, topic:_ce.topic||'', articleTitle:article?.title||'',
      inputMode:article?.inputMode||'search',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    ceLoadHistory();
  } catch(e){ console.warn('History save', e); }
}

async function ceLoadHistory(){
  if(!fbAuth.currentUser) return;
  try {
    const snap = await db.collection('users').doc(fbAuth.currentUser.uid)
      .collection('ceHistory').orderBy('createdAt','desc').limit(20).get();
    _ce.history = snap.docs.map(d=>({id:d.id,...d.data()}));
    ceRenderHistoryBadge();
    if(_ce.historyOpen) ceRenderHistoryList();
  } catch(e){ console.warn('History load', e); }
}

function ceRenderHistoryBadge(){
  const n = _ce.history.length, el = $('ceHistorySection');
  if(!el) return;
  el.style.display = n>0?'block':'none';
  const b=$('ceHistoryCount'); if(b) b.textContent=n;
}

function ceToggleHistory(){
  _ce.historyOpen=!_ce.historyOpen;
  const list=$('ceHistoryList'), arrow=$('ceHistoryArrow');
  if(!list) return;
  list.style.display=_ce.historyOpen?'flex':'none';
  if(arrow) arrow.textContent=_ce.historyOpen?'▴':'▾';
  // Keep aria-expanded in sync (4.1.2)
  const toggleBtn=document.querySelector('.ce-history-toggle');
  if(toggleBtn) toggleBtn.setAttribute('aria-expanded', _ce.historyOpen?'true':'false');
  if(_ce.historyOpen) ceRenderHistoryList();
}

function ceRenderHistoryList(){
  const list=$('ceHistoryList'); if(!list) return;
  const LABELS={linkedin:'LinkedIn',x:'X',instagram:'Instagram',reddit:'Reddit'};
  if(!_ce.history.length){ list.innerHTML='<div style="color:var(--muted);font-size:13px;padding:8px 0">No posts generated yet.</div>'; return; }
  list.innerHTML=_ce.history.map(h=>`
    <div class="ce-history-item">
      <div class="ce-history-item-head">
        <span class="ce-history-item-meta">
          <span class="ce-tag">${ceEsc(LABELS[h.platform]||h.platform)}</span>
          <span>${ceEsc(h.type||'')}</span>
          ${h.topic?`<span>${ceEsc(h.topic)}</span>`:''}
        </span>
        <button class="btn ghost" style="height:26px;padding:0 10px;font-size:11px" data-ce-copy="${ceEsc(h.text||'')}" onclick="ceCopyAttr(this)">Copy</button>
      </div>
      <p class="ce-history-item-text">${ceEsc(h.text||'')}</p>
    </div>`).join('');
}

function ceInit(){ ceLoadHistory(); }

/* ── Image generation — 6-model parallel grid ────────────────────────────── */

async function ceOpenImageModal(){
  // Parse the clean caption (strip "CAPTION:" prefix and hashtags)
  const rawText = _ce.posts['instagram']?.text || '';
  const { caption: parsedCaption } = ceParseInstagram(rawText);
  const caption = parsedCaption || rawText;

  // Reset state
  _imgGen.selectedUrl = '';
  _imgGen.selectedIdx = -1;

  // Open modal
  $('ceImgGenOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';
  $('ceImgPromptInput').value = '';
  $('ceImgDownloadBtn').disabled = true;
  $('ceImgGenBtn').disabled = true;

  // Show grid in "writing prompt" loading state
  ceImgRenderGrid('prompt');

  try {
    const data = await xgFetch('/generate', {
      kind:         'image-prompt',
      caption,
      topic:        _ce.topic || '',
      articleTitle: _ce.article?.title || '',
      niche:        state.profile?.niche || '',
    });
    $('ceImgPromptInput').value = data.text || '';
    $('ceImgGenBtn').disabled = false;
    ceImgGenerate(); // auto-kick all 6
  } catch(e) {
    ceImgRenderGrid('error');
    $('ceImgGenBtn').disabled = false;
    toast('Could not auto-generate prompt — type one above and click Regenerate all');
  }
}

/* Render 6 shimmer cells (phase: 'prompt' | 'loading' | 'error') */
function ceImgRenderGrid(phase){
  const grid = $('ceImgGrid');
  if(!grid) return;
  const label = phase === 'prompt' ? 'Writing prompt…' : phase === 'error' ? 'Enter prompt above' : '';
  grid.innerHTML = IMGGEN_GRID_MODELS.map((m, i) => `
    <div class="imggen-cell loading" id="imgCell${i}" onclick="ceImgSelectCell(${i})" title="${m.label} · ${m.tag}">
      <div class="imggen-shimmer"></div>
      <div class="imggen-status">
        <span class="ce-spinner"></span>
        <span class="imggen-status-lbl">${label || m.label}</span>
      </div>
    </div>`).join('');
}

/* Load all 6 SEQUENTIALLY — Pollinations allows only 1 concurrent request per IP.
   Parallel requests beyond the first all return 402. Each cell reveals as it finishes. */
async function ceImgGenerate(){
  const prompt = ($('ceImgPromptInput')?.value || '').trim();
  if(!prompt){ toast('Enter a prompt first'); return; }

  _imgGen.seeds       = IMGGEN_GRID_MODELS.map(() => Math.floor(Math.random() * 1e9));
  _imgGen.selectedUrl = '';
  _imgGen.selectedIdx = -1;
  _imgGen._failCount  = 0;
  clearTimeout(_imgGen._failTimer);
  $('ceImgDownloadBtn').disabled = true;
  $('ceImgGenBtn').disabled = true;
  ceImgRenderGrid('loading');

  for(let i = 0; i < IMGGEN_GRID_MODELS.length; i++){
    // Mark the active cell so the user can see which one is generating
    const cell = $(`imgCell${i}`);
    if(cell){
      const lbl = cell.querySelector('.imggen-status-lbl');
      if(lbl) lbl.textContent = IMGGEN_GRID_MODELS[i].label + '…';
    }
    await ceImgLoadOne(prompt, IMGGEN_GRID_MODELS[i], i).catch(() => {});
  }
  $('ceImgGenBtn').disabled = false;
}

/* Load one Pollinations image (browser-direct) and update its cell.
   Pollinations is free and returns 200 from real browsers.
   Their servers 402 Cloudflare Worker IPs (CDN blocking), so we load directly.
   If an ad-blocker or privacy extension is intercepting requests we detect it
   by counting fast failures and show a one-time whitelist suggestion. */
function ceImgLoadOne(prompt, model, idx){
  return new Promise((resolve, reject) => {
    const seed = _imgGen.seeds[idx] || Math.floor(Math.random() * 1e9);
    const url  = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
                 `?width=1080&height=1080&model=${model.id}&nologo=true&seed=${seed}`;
    const img  = new Image();
    // ⚠️ Do NOT set crossOrigin — Pollinations CDN omits CORS headers on cached
    // responses, which causes the browser to fire onerror even when the image
    // is perfectly valid. Download uses a separate fetch() with CORS handling.
    const startedAt = Date.now();

    const timer = setTimeout(() => {
      img.src = '';
      const cell = $(`imgCell${idx}`);
      if(cell && cell.classList.contains('loading')){
        cell.className = 'imggen-cell error';
        cell.innerHTML = `
          <div class="imggen-status">
            <span style="font-size:24px;opacity:.3">⏱</span>
            <span class="imggen-status-lbl">${model.label} timed out</span>
            <button class="btn ghost" style="height:26px;padding:0 10px;font-size:11px;margin-top:6px"
              onclick="event.stopPropagation();ceImgRetryOne(${idx})">Retry</button>
          </div>`;
      }
      reject(new Error('timeout'));
    }, 45000);

    img.onload = () => {
      clearTimeout(timer);
      const cell = $(`imgCell${idx}`);
      if(!cell) return resolve(url);
      cell.className   = 'imggen-cell done';
      cell.dataset.url = url;
      cell.innerHTML   = `
        <img src="${url}" alt="${model.label}">
        <div class="imggen-label"><strong>${model.label}</strong><span>${model.tag}</span></div>`;
      resolve(url);
    };

    img.onerror = () => {
      clearTimeout(timer);
      const cell = $(`imgCell${idx}`);
      if(!cell) return reject();
      cell.className = 'imggen-cell error';
      cell.innerHTML = `
        <div class="imggen-status">
          <span style="font-size:24px;opacity:.3">✕</span>
          <span class="imggen-status-lbl">${model.label}</span>
          <button class="btn ghost" style="height:26px;padding:0 10px;font-size:11px;margin-top:6px"
            onclick="event.stopPropagation();ceImgRetryOne(${idx})">Retry</button>
        </div>`;

      // Ad-blocker detection: if onerror fires within 3 s it wasn't a real image failure.
      if(Date.now() - startedAt < 3000){
        _imgGen._failCount++;
        if(_imgGen._failCount === 3){
          toast('Images blocked — your ad-blocker is intercepting requests. Whitelist xgrowth.uno to fix this.');
        }
      }
      reject();
    };

    img.src = url;
  });
}

/* Retry a single failed or timed-out cell with a fresh seed */
function ceImgRetryOne(idx){
  const model  = IMGGEN_GRID_MODELS[idx];
  const prompt = ($('ceImgPromptInput')?.value || '').trim();
  if(!prompt) return;

  const cell = $(`imgCell${idx}`);
  if(!cell) return;
  cell.className = 'imggen-cell loading';
  cell.innerHTML = `
    <div class="imggen-shimmer"></div>
    <div class="imggen-status">
      <span class="ce-spinner"></span>
      <span class="imggen-status-lbl">${model.label}</span>
    </div>`;

  // Ensure seeds array exists even if page was freshly loaded
  if(!_imgGen.seeds.length) _imgGen.seeds = IMGGEN_GRID_MODELS.map(() => Math.floor(Math.random() * 1e9));
  _imgGen.seeds[idx] = Math.floor(Math.random() * 1e9);
  ceImgLoadOne(prompt, model, idx);
}

/* Tap a loaded cell to select it */
function ceImgSelectCell(idx){
  const cell = $(`imgCell${idx}`);
  if(!cell || !cell.dataset.url) return; // still loading or errored
  $('ceImgGrid')?.querySelectorAll('.imggen-cell').forEach(c => c.classList.remove('selected'));
  cell.classList.add('selected');
  _imgGen.selectedUrl = cell.dataset.url;
  _imgGen.selectedIdx = idx;
  $('ceImgDownloadBtn').disabled = false;
}

/* Download the selected image.
   The URL is a Pollinations https:// URL, not a data: URL, so we must fetch it as a blob.
   If the fetch fails (CORS, ad-blocker, etc.) fall back to opening the URL in a new tab. */
async function ceImgDownload(){
  if(!_imgGen.selectedUrl){ toast('Tap an image to select it first'); return; }
  const url = _imgGen.selectedUrl;

  // Try fetch-as-blob first so the browser saves the file rather than navigating
  try {
    const resp = await fetch(url, { mode: 'cors' });
    if(!resp.ok) throw new Error('fetch failed');
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `xgrowth-insta-${Date.now()}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  } catch {
    // CORS or ad-blocker blocked the fetch — open in new tab so user can save manually
    window.open(url, '_blank', 'noopener,noreferrer');
    toast('Opening in new tab — right-click to Save As');
  }
}

function ceImgClose(){
  $('ceImgGenOverlay').classList.remove('show');
  document.body.style.overflow = '';
}

/* ── Copy util ────────────────────────────────────────────────────────── */

function ceCopyAttr(btn){
  const text=btn?.dataset?.ceCopy||'';
  if(!text) return;
  navigator.clipboard.writeText(text).then(()=>toast('Copied'));
}

// Enter-to-trigger for URL and X profile inputs
document.addEventListener('keydown',(e)=>{
  if(e.key!=='Enter') return;
  const id=document.activeElement?.id;
  if(id==='ceUrlInput'){ e.preventDefault(); ceGenerateFromUrl(); }
  else if(id==='ceXProfileInput'){ e.preventDefault(); ceFetchXProfile(); }
});

/* ========= Mobile drawer ========= */
function toggleSide(force){
  const s = document.querySelector('.side');
  const sc = $('scrim');
  const open = force === undefined ? !s.classList.contains('show') : !!force;
  s.classList.toggle('show', open);
  sc.classList.toggle('show', open);
  // Keep aria-expanded in sync with drawer state (4.1.2 Name, Role, Value)
  const menuBtn = $('menuBtn');
  if(menuBtn) menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
// Close drawer when nav button tapped (mobile)
document.getElementById('nav').addEventListener('click', e=>{
  if(e.target.closest('button[data-view]') && window.innerWidth <= 980) toggleSide(false);
});

/* ========= Google Sign-In ========= */
function decodeJwt(token){
  try{
    const payload = token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
    const json = decodeURIComponent(atob(payload).split('').map(c =>
      '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
    ).join(''));
    return JSON.parse(json);
  }catch(e){ return null; }
}
function handleGoogleCredential(resp){
  const data = decodeJwt(resp.credential);
  if(!data){ toast('Sign-in failed'); return; }
  currentUser = {
    name: data.name || 'Founder',
    email: data.email || '',
    picture: data.picture || '',
    sub: data.sub
  };
  localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
  applyUser();
  toast(`Welcome, ${currentUser.name.split(' ')[0]}`);
  // Also sign into Firebase using the same Google credential
  const cred = firebase.auth.GoogleAuthProvider.credential(resp.credential);
  fbAuth.signInWithCredential(cred).catch(err=>{
    console.error('Firebase sign-in failed', err);
    toast('Cloud sync unavailable');
  });
  // loadFromCloud is triggered by onAuthStateChanged below
}
function initGoogle(){
  const box = $('googleBtn'); box.innerHTML = '';
  if(!window.google || !google.accounts || !google.accounts.id){
    setTimeout(initGoogle, 500);
    return;
  }
  try{
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleCredential,
      auto_select: false,
      ux_mode: 'popup'
    });
    google.accounts.id.renderButton(box, {
      theme:'filled_black', size:'large', shape:'pill', text:'signin_with', width: 220
    });
  }catch(e){
    box.innerHTML = `<div class="small muted">Google init error: ${e.message}</div>`;
  }
}
// Trigger Google sign-in. useRedirect=true for auto-triggered flows (no user gesture, popups would be blocked).
async function startGoogleSignIn(useRedirect){
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({prompt:'select_account'});
  try{
    if(useRedirect){
      await fbAuth.signInWithRedirect(provider);
      return;
    }
    await fbAuth.signInWithPopup(provider);
  }catch(err){
    if(err && err.code === 'auth/popup-blocked'){
      try{
        await fbAuth.signInWithRedirect(provider);
      }catch(e2){
        console.error(e2); toast('Sign-in failed: '+(e2.message||e2.code));
      }
    } else if(err && err.code === 'auth/popup-closed-by-user'){
      // user dismissed — no-op
    } else {
      console.error('Sign-in error', err);
      toast('Sign-in failed: '+(err.message||err.code));
    }
  }
}
// Expose for inline onclick
window.startGoogleSignIn = startGoogleSignIn;
function applyUser(){
  if(currentUser){
    $('loginBox').style.display = 'none';
    $('userBox').style.display = 'block';
    $('uName').textContent = currentUser.name;
    $('uEmail').textContent = currentUser.email;
    $('uAvatar').src = currentUser.picture || '';
    $('uAvatar').alt = currentUser.name || ''; // 1.1.1 Non-text Content
    const st2 = $('sessionTag'); if(st2) st2.textContent = currentUser.name.split(' ')[0];
  }else{
    $('loginBox').style.display = 'block';
    $('userBox').style.display = 'none';
  }
}
function signOut(){
  if(window.google && google.accounts && google.accounts.id){
    try{ google.accounts.id.disableAutoSelect(); }catch(e){}
  }
  currentUser = null;
  cloudLoaded = false;
  localStorage.removeItem(USER_KEY);
  fbAuth.signOut().catch(()=>{}).finally(()=>{
    window.location.href = '/';
  });
}

/* Auth gate state machine */
function setAuthState(name){
  ['loading','redirecting','signin','error'].forEach(n=>{
    const el = document.getElementById('state'+n.charAt(0).toUpperCase()+n.slice(1));
    if(el) el.classList.toggle('show', n === name);
  });
}
function authGateError(msg){
  const m = document.getElementById('authErrorMsg');
  if(m) m.textContent = msg || 'Sign-in failed. Please try again.';
  setAuthState('error');
}

/* React to Firebase auth state changes (page reloads, token refresh, etc.) */
let signinTriggered = false;
fbAuth.onAuthStateChanged(user=>{
  if(user){
    document.body.classList.add('authed');
    if(!currentUser){
      currentUser = {
        name: user.displayName || 'Founder',
        email: user.email || '',
        picture: user.photoURL || '',
        sub: user.uid
      };
      localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
    }
    applyUser();
    loadFromCloud().then(()=>{
      if(!state.profile){ openWelcome(); }
    });
    ceInit();
  } else {
    document.body.classList.remove('authed');
    cloudLoaded = false;
    if(redirectResultDone){
      runAuthGateLogic();
    } else {
      setAuthState('loading');
    }
  }
});

function runAuthGateLogic(){
  if(fbAuth.currentUser) return;
  if(wantsSignin && !signinTriggered){
    signinTriggered = true;
    setAuthState('redirecting');
    startGoogleSignIn(true).catch(err=>{
      authGateError('Could not start sign-in: ' + (err.message||err.code));
    });
  } else {
    window.location.replace('/');
  }
}

/* ========= Init ========= */
initGoogle();
// Show loading state until Firebase auth determines whether the user is signed in
setAuthState('loading');
