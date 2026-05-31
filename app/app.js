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

function ceIsYouTubeUrl(url){
  try {
    const u = new URL(url);
    return u.hostname === 'youtu.be' || /youtube\.com$/.test(u.hostname);
  } catch(e){ return false; }
}

async function ceGenerateFromUrl(){
  const url = $('ceUrlInput')?.value?.trim();
  if(!url || !url.startsWith('http')){ toast('Paste a valid URL first'); $('ceUrlInput')?.focus(); return; }
  const btn = $('ceUrlBtn');
  if(btn){ btn.disabled=true; btn.innerHTML='<span class="ce-spinner"></span>Generating…'; }

  const isYT = ceIsYouTubeUrl(url);
  let title = url, angle = '';
  try {
    const data = await xgFetch('/preview', { url });
    if(data.title) title = data.title;
    if(data.description) angle = data.description;
  } catch(e){ /* fall back to URL as title */ }

  _ce.topic = title;
  _ce.article = { title, angle, url, inputMode: isYT ? 'youtube' : 'url' };
  const pickedAt = Date.now(); _ce._pickedAt = pickedAt;
  ['linkedin','x','instagram','reddit'].forEach(p => { _ce.posts[p] = {text:'',loading:true,generated:false}; });
  const badge = isYT ? `<span class="ce-yt-badge">▶ YouTube</span>` : '';
  $('ceTrendContext').innerHTML = `${badge}<h4>${ceEsc(title)}</h4>${angle?`<p>${ceEsc(angle)}</p>`:''}`;
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
    {key:'hot-take',label:'Hot Take'},{key:'story',label:'Story'},
    {key:'data',label:'Data-Led'},{key:'question',label:'Question'},
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
    </div>`;
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
      reddit:(()=>{ const m=p.text.match(/SUBREDDIT:\s*(.+)/i); const sub=(m?.[1]||'startups').replace(/^r\//i,'').trim(); const tm=p.text.match(/TITLE:\s*(.+)/i); const t=(tm?.[1]||'').trim(); const bm=p.text.match(/BODY:\s*([\s\S]+?)$/i); return `https://www.reddit.com/r/${encodeURIComponent(sub)}/submit?title=${encodeURIComponent(t)}&text=${encodeURIComponent((bm?.[1]||'').trim())}`; })(),
    };
    const postBtn = platform === 'instagram'
      ? `<button class="btn publish" onclick="cePostToInstagram()">Post ↗</button>`
      : `<a class="btn publish" href="${platUrls[platform]||'#'}" target="_blank" rel="noopener noreferrer">Post ↗</a>`;
    footer = `<div class="ce-section-foot">
      <span class="ce-count${limit&&len>limit?' over':''}">${len}${limit?'/'+limit:''} chars</span>
      <div class="ce-section-actions">
        <button class="btn ghost" style="height:32px;font-size:13px" data-ce-copy="${ceEsc(p.text)}" onclick="ceCopyAttr(this)">Copy</button>
        <button class="ce-regen-btn" onclick="ceRegeneratePlatform('${platform}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
          Regenerate
        </button>
        ${postBtn}
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
    <div class="ce-post-foot"><span class="ce-count">${text.length} chars</span><div class="ce-post-actions"><button class="btn ghost" data-ce-copy="${ceEsc(text)}" onclick="ceCopyAttr(this)">Copy all</button><button class="btn publish" onclick="cePostToInstagram()">Post ↗</button></div></div>
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

function ceInit(){ ceLoadHistory(); queueRender(); planRenderSaved(); }

/* ── Instagram post helper ────────────────────────────────────────────── */
// Instagram has no web compose URL — copy caption+hashtags then open the app.
function cePostToInstagram(){
  const raw = _ce.posts['instagram']?.text || '';
  const { caption, hashtags } = ceParseInstagram(raw);
  const full = hashtags ? `${caption}\n\n${hashtags}` : caption;
  navigator.clipboard.writeText(full).then(() => {
    toast('Caption copied — click + in Instagram to post');
    window.open('https://www.instagram.com/', '_blank', 'noopener,noreferrer');
  }).catch(() => {
    window.open('https://www.instagram.com/', '_blank', 'noopener,noreferrer');
  });
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
  else if(id==='roastUrlInput'){ e.preventDefault(); ceRoastAnalyze(); }
  else if(id==='hookTopicInput' && (e.metaKey||e.ctrlKey)){ e.preventDefault(); hookGenerate(); }
});

// Delegated click handler — toggles .portal-chip.active for channel pickers in plan + calendar
['planChannelChips','calChannelChips'].forEach(id=>{
  const el = document.getElementById(id);
  if(!el) return;
  el.addEventListener('click', e=>{
    const chip = e.target.closest('.portal-chip[data-ch]');
    if(!chip) return;
    chip.classList.toggle('active');
  });
});

/* =========================================================
   LANDING PAGE ROAST
   URL or pasted copy → scored section-by-section analysis
   with exact rewrites — hero, value prop, social proof, CTA
   ========================================================= */

const _roast = {
  tab: 'url',
  loading: false,
  result: null,
};

function roastSwitchTab(tab) {
  _roast.tab = tab;
  ['url', 'copy'].forEach(t => {
    const btn = $('rtab-' + t);
    if (btn) {
      btn.classList.toggle('active', t === tab);
      btn.setAttribute('aria-selected', t === tab ? 'true' : 'false');
    }
  });
  ['roastModeUrl', 'roastModeCopy'].forEach(id => $(id)?.classList.remove('active'));
  const panelMap = { url: 'roastModeUrl', copy: 'roastModeCopy' };
  $(panelMap[tab])?.classList.add('active');
}

async function ceRoastAnalyze() {
  if (_roast.loading) return;
  const tab = _roast.tab;
  let url = '', copy = '';
  if (tab === 'url') {
    url = ($('roastUrlInput')?.value || '').trim();
    if (!url) { toast('Paste a URL first'); return; }
    if (!/^https?:\/\//i.test(url)) { toast('URL must start with https://'); return; }
  } else {
    copy = ($('roastCopyInput')?.value || '').trim();
    if (copy.length < 80) { toast('Paste more copy — at least a few sentences'); return; }
  }

  _roast.loading = true;
  const urlBtn  = $('roastUrlBtn');
  const copyBtn = $('roastCopyBtn');
  [urlBtn, copyBtn].forEach(b => { if (b) { b.disabled = true; b.textContent = 'Roasting…'; } });

  $('roastEmpty').style.display = 'none';
  $('roastResult').innerHTML = `
    <div class="roast-loading" role="status" aria-live="polite">
      <div class="ce-spinner" aria-hidden="true"></div>
      <span>${tab === 'url' ? 'Fetching your page and running the roast…' : 'Running the roast…'}</span>
    </div>`;

  try {
    const data = await xgFetch('/generate', { kind: 'roast', url, copy });
    _roast.result = data.text;
    ceRoastRenderResult(data.text);
  } catch (err) {
    $('roastResult').innerHTML =
      `<div class="ce-skeleton" style="color:#f87171;min-height:80px;border-color:rgba(248,113,113,.3)">${ceEsc(err.message || 'Roast failed — try again')}</div>`;
  } finally {
    _roast.loading = false;
    if (urlBtn)  { urlBtn.disabled  = false; urlBtn.textContent  = 'Roast it →'; }
    if (copyBtn) { copyBtn.disabled = false; copyBtn.textContent = 'Roast it →'; }
  }
}

function ceRoastRenderResult(text) {
  const sections = ceParseRoastSections(text);
  const overall  = sections.find(s => s.key === 'OVERALL');
  const scored   = ['HERO', 'VALUE PROPOSITION', 'SOCIAL PROOF', 'CALL TO ACTION']
    .map(k => sections.find(s => s.key === k)).filter(Boolean);
  const fixes    = sections.find(s => s.key === 'TOP 3 FIXES');

  let html = '';

  // ── Overall banner ─────────────────────────────────────────────────────
  if (overall) {
    const sc  = overall.score ?? 0;
    const cls = sc <= 4 ? 'red' : sc <= 6 ? 'orange' : sc <= 8 ? 'yellow' : 'green';
    html += `<div class="roast-overall">
      <div class="roast-overall-top">
        <div>
          <div class="roast-overall-label">Overall Score</div>
          ${overall.verdict  ? `<p class="roast-verdict">${ceEsc(overall.verdict)}</p>` : ''}
          ${overall.priority ? `<div class="roast-priority"><span class="roast-priority-lbl">Priority fix →</span> ${ceEsc(overall.priority)}</div>` : ''}
        </div>
        <div class="roast-big-score roast-color-${cls}">${sc}<span class="roast-denom">/10</span></div>
      </div>
    </div>`;
  }

  // ── Section cards ───────────────────────────────────────────────────────
  if (scored.length) {
    html += `<div class="roast-cards">`;
    for (const sec of scored) html += ceRoastCard(sec);
    html += `</div>`;
  }

  // ── Top 3 Fixes ─────────────────────────────────────────────────────────
  if (fixes?.fixes?.length) {
    html += `<div class="roast-fixes">
      <div class="roast-fixes-title">Top 3 Fixes</div>
      <ol class="roast-fixes-list">
        ${fixes.fixes.map(f => `<li>${ceEsc(f)}</li>`).join('')}
      </ol>
    </div>`;
  }

  // ── Reset ────────────────────────────────────────────────────────────────
  html += `<div style="margin-top:18px;display:flex;justify-content:flex-end">
    <button class="btn secondary" style="height:38px;padding:0 16px;font-size:13px" onclick="ceRoastReset()">Roast another page</button>
  </div>`;

  $('roastResult').innerHTML = html;
}

function ceRoastCard(sec) {
  const sc  = sec.score ?? 0;
  const cls = sc <= 4 ? 'red' : sc <= 6 ? 'orange' : sc <= 8 ? 'yellow' : 'green';
  return `<div class="roast-card">
    <div class="roast-card-head">
      <span class="roast-card-title">${ceEsc(sec.key)}</span>
      <span class="roast-chip roast-color-${cls}">${sc}/10</span>
    </div>
    <div class="roast-bar-track"><div class="roast-bar-fill roast-fill-${cls}" style="width:${sc * 10}%"></div></div>
    ${sec.issue   ? `<p class="roast-issue">${ceEsc(sec.issue)}</p>` : ''}
    ${sec.current ? `<div class="roast-field"><span class="roast-field-lbl">Current</span><p class="roast-current">"${ceEsc(sec.current)}"</p></div>` : ''}
    ${sec.rewrite ? `<div class="roast-field"><span class="roast-field-lbl">Rewrite</span><p class="roast-rewrite">${ceEsc(sec.rewrite)}</p></div>` : ''}
    ${sec.rewrite ? `<button class="btn ghost" style="height:28px;padding:0 10px;font-size:12px;margin-top:4px;align-self:flex-start" data-ce-copy="${ceEsc(sec.rewrite)}" onclick="ceCopyAttr(this)">Copy rewrite</button>` : ''}
  </div>`;
}

function ceParseRoastSections(text) {
  const sections = [];
  // Split on ## headings (handles both with and without leading newline)
  const parts = text.split(/^## /m).filter(s => s.trim());
  for (const part of parts) {
    const lines = part.trim().split('\n');
    const key   = (lines[0] || '').trim().toUpperCase();
    const body  = lines.slice(1).join('\n');

    if (key === 'TOP 3 FIXES') {
      const fixes = body.split('\n')
        .map(l => l.replace(/^\d+\.\s*/, '').trim())
        .filter(Boolean);
      sections.push({ key, fixes });
      continue;
    }

    const get = field => {
      const m = new RegExp(`^${field}:\\s*(.+)`, 'mi').exec(body);
      return m ? m[1].trim() : '';
    };
    const scoreRaw = get('SCORE');
    const scoreNum = scoreRaw.match(/(\d+)/);

    sections.push({
      key,
      score:    scoreNum ? parseInt(scoreNum[1], 10) : null,
      verdict:  get('VERDICT'),
      priority: get('PRIORITY'),
      issue:    get('ISSUE'),
      current:  get('CURRENT'),
      rewrite:  get('REWRITE'),
    });
  }
  return sections;
}

/* =========================================================
   90-DAY MARKETING PLAN
   Niche + stage + goal + channels + budget →
   3-month week-by-week plan, experiments, stop-doing, metrics
   ========================================================= */

const _plan = {
  loading: false,
};

function planGetChannels() {
  return [...document.querySelectorAll('#planChannelChips .portal-chip.active')]
    .map(b => b.dataset.ch);
}

async function planGenerate() {
  if (_plan.loading) return;
  const niche = ($('planNiche')?.value || '').trim();
  if (!niche || niche.length < 5) { toast('Describe your product first'); $('planNiche')?.focus(); return; }
  const stage    = $('planStage')?.value || 'early-traction';
  const channels = planGetChannels();
  if (!channels.length) { toast('Pick at least one channel'); return; }

  _plan.loading = true;
  const btn = $('planGenBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="ce-spinner"></span>Building your week…'; }
  $('planEmpty').style.display = 'none';
  $('planResult').innerHTML = `
    <div class="roast-loading" role="status" aria-live="polite">
      <div class="ce-spinner" aria-hidden="true"></div>
      <span>Mapping your 7-day marketing sprint…</span>
    </div>`;

  try {
    const data = await xgFetch('/generate', { kind: 'plan-week', niche, stage, channels });
    const parsed = planParse(data.text || '');
    if (!parsed.days.length) throw new Error("Couldn't build the week — try again");
    state.weekPlan = {
      rawText:   data.text || '',
      niche, stage,
      focus:     parsed.focus,
      days:      parsed.days,
      keepGoing: parsed.keepGoing,
      createdAt: Date.now(),
    };
    _plan.activeDay = 0;
    save();
    planRender(state.weekPlan);
  } catch (err) {
    $('planResult').innerHTML =
      `<div class="ce-skeleton" style="color:#f87171;min-height:80px;border-color:rgba(248,113,113,.3)">${ceEsc(err.message || 'Generation failed — try again')}</div>`;
  } finally {
    _plan.loading = false;
    if (btn) { btn.disabled = false; btn.innerHTML = 'Build my week →'; }
  }
}

function planParse(text) {
  const focusM = /## WEEK FOCUS\s*\n([\s\S]*?)(?=## DAY 1|$)/i.exec(text);
  const focus = focusM ? focusM[1].trim() : '';

  const days = [];
  for (let i = 1; i <= 7; i++) {
    const re = new RegExp(`## DAY ${i}:\\s*(.+)\\n([\\s\\S]*?)(?=## DAY ${i + 1}:|## KEEP GOING|$)`, 'i');
    const m = re.exec(text);
    if (!m) continue;
    const theme = m[1].trim();
    const block = m[2];
    const tasks = [];
    // Accept "TASK: ..." lines or plain "- ..." bullets
    const taskRe = /^\s*(?:TASK:|[-•*])\s*(.+)$/gim;
    let tm;
    while ((tm = taskRe.exec(block)) !== null) {
      const raw = tm[1].trim();
      if (!raw) continue;
      const pipe = raw.indexOf('|');
      const action = (pipe > -1 ? raw.slice(0, pipe) : raw).replace(/\*\*/g, '').trim();
      const detail = pipe > -1 ? raw.slice(pipe + 1).trim() : '';
      if (action) tasks.push({ action, detail, done: false });
    }
    if (tasks.length) days.push({ theme, tasks });
  }

  const keepM = /## KEEP GOING\s*\n([\s\S]*?)$/i.exec(text);
  const keepGoing = keepM ? keepM[1].trim() : '';

  return { focus, days, keepGoing };
}

function planRender(plan) {
  if (!plan || !plan.days?.length) {
    $('planResult').innerHTML = `<p style="color:var(--muted);font-size:14px">No plan yet — fill the form and build your week.</p>`;
    return;
  }
  $('planEmpty').style.display = 'none';

  let total = 0, done = 0;
  plan.days.forEach(d => d.tasks.forEach(t => { total++; if (t.done) done++; }));
  const pct = total ? Math.round(done / total * 100) : 0;

  let html = '';

  // Progress bar
  html += `
    <div class="week-progress">
      <div class="week-prog-top">
        <span class="week-prog-title">Your week</span>
        <span class="week-prog-label" id="planProgLabel">${done} / ${total} done</span>
      </div>
      <div class="week-prog-track"><div class="week-prog-bar" id="planProgBar" style="width:${pct}%"></div></div>
    </div>`;

  // Week focus
  if (plan.focus) {
    html += `
      <div class="week-focus-card">
        <div class="week-focus-lbl">This week is about</div>
        <p class="week-focus-text">${ceEsc(plan.focus)}</p>
      </div>`;
  }

  // Active day — default to the first day that still has unchecked tasks
  if (typeof _plan.activeDay !== 'number' || _plan.activeDay < 0 || _plan.activeDay >= plan.days.length) {
    const firstIncomplete = plan.days.findIndex(d => d.tasks.some(t => !t.done));
    _plan.activeDay = firstIncomplete > -1 ? firstIncomplete : 0;
  }

  // Day tabs
  html += `<div class="week-tabs" role="tablist" aria-label="Days of the week">`;
  plan.days.forEach((day, di) => {
    const dDone = day.tasks.filter(t => t.done).length;
    const allDone = day.tasks.length > 0 && dDone === day.tasks.length;
    html += `
      <button class="week-tab${di === _plan.activeDay ? ' active' : ''}${allDone ? ' done' : ''}" role="tab"
        id="weekTab-${di}" aria-selected="${di === _plan.activeDay ? 'true' : 'false'}"
        onclick="planSelectDay(${di})">
        <span class="week-tab-day">Day ${di + 1}</span>
        <span class="week-tab-status">${allDone ? '✓' : `${dDone}/${day.tasks.length}`}</span>
      </button>`;
  });
  html += `</div>`;

  // Active day panel
  html += `<div class="week-day-panel" id="weekDayPanel" role="tabpanel">${planRenderDay(plan, _plan.activeDay)}</div>`;

  // Keep going
  if (plan.keepGoing) {
    html += `
      <div class="week-keep">
        <div class="week-keep-lbl">Keep going after Day 7</div>
        <p class="week-keep-text">${ceEsc(plan.keepGoing)}</p>
      </div>`;
  }

  // Footer actions
  html += `
    <div style="margin-top:20px;display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap">
      <button class="btn ghost" style="height:38px;padding:0 16px;font-size:13px" onclick="planDownload()">↓ Download .md</button>
      <button class="btn secondary" style="height:38px;padding:0 16px;font-size:13px" onclick="planReset()">New week plan</button>
    </div>`;

  $('planResult').innerHTML = html;
}

// HTML for one day's panel (theme header + checkable tasks)
function planRenderDay(plan, di) {
  const day = plan.days[di];
  if (!day) return '';
  return `
    <div class="week-day-head">
      <span class="week-day-num">Day ${di + 1}</span>
      <span class="week-day-theme">${ceEsc(day.theme)}</span>
    </div>
    <div class="week-tasks">
      ${day.tasks.map((t, ti) => `
        <div class="week-task${t.done ? ' done' : ''}" id="wtask-${di}-${ti}">
          <button class="week-check" onclick="planToggleTask(${di},${ti})" aria-label="${t.done ? 'Mark not done' : 'Mark done'}">${t.done ? '✓' : ''}</button>
          <div class="week-task-main">
            <span class="week-task-action">${ceEsc(t.action)}</span>
            ${t.detail ? `<span class="week-task-detail">${ceEsc(t.detail)}</span>` : ''}
          </div>
        </div>`).join('')}
    </div>`;
}

function planSelectDay(di) {
  if (!state.weekPlan?.days?.[di]) return;
  _plan.activeDay = di;
  document.querySelectorAll('.week-tab').forEach((el, i) => {
    const sel = i === di;
    el.classList.toggle('active', sel);
    el.setAttribute('aria-selected', sel ? 'true' : 'false');
  });
  const panel = document.getElementById('weekDayPanel');
  if (panel) panel.innerHTML = planRenderDay(state.weekPlan, di);
}

function planToggleTask(di, ti) {
  const plan = state.weekPlan;
  const task = plan?.days?.[di]?.tasks?.[ti];
  if (!task) return;
  task.done = !task.done;
  save();

  const row = document.getElementById(`wtask-${di}-${ti}`);
  if (row) {
    row.classList.toggle('done', task.done);
    const cb = row.querySelector('.week-check');
    if (cb) { cb.textContent = task.done ? '✓' : ''; cb.setAttribute('aria-label', task.done ? 'Mark not done' : 'Mark done'); }
  }
  // Update this day's tab indicator
  const day = plan.days[di];
  const dDone = day.tasks.filter(t => t.done).length;
  const allDone = day.tasks.length > 0 && dDone === day.tasks.length;
  const tab = document.getElementById(`weekTab-${di}`);
  if (tab) {
    tab.classList.toggle('done', allDone);
    const st = tab.querySelector('.week-tab-status');
    if (st) st.textContent = allDone ? '✓' : `${dDone}/${day.tasks.length}`;
  }
  planUpdateProgress();
}

function planUpdateProgress() {
  const plan = state.weekPlan; if (!plan) return;
  let total = 0, done = 0;
  plan.days.forEach(d => d.tasks.forEach(t => { total++; if (t.done) done++; }));
  const pct = total ? Math.round(done / total * 100) : 0;
  const bar = $('planProgBar'), lbl = $('planProgLabel');
  if (bar) bar.style.width = pct + '%';
  if (lbl) lbl.textContent = `${done} / ${total} done`;
}

// Render the saved week plan on load so checkboxes persist across reloads
function planRenderSaved() {
  if (state.weekPlan && state.weekPlan.days?.length) {
    $('planEmpty').style.display = 'none';
    planRender(state.weekPlan);
  }
}

function planDownload() {
  const plan = state.weekPlan;
  if (!plan) return;
  let md = `# 1-Week Marketing Plan\n\n`;
  if (plan.niche) md += `**Product:** ${plan.niche}\n\n`;
  if (plan.focus) md += `**This week is about:** ${plan.focus}\n\n`;
  plan.days.forEach((d, i) => {
    md += `## Day ${i + 1} — ${d.theme}\n\n`;
    d.tasks.forEach(t => { md += `- [${t.done ? 'x' : ' '}] ${t.action}${t.detail ? ` — ${t.detail}` : ''}\n`; });
    md += `\n`;
  });
  if (plan.keepGoing) md += `## Keep going\n\n${plan.keepGoing}\n`;
  const blob = new Blob([md], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '1-week-marketing-plan.md';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Downloading plan');
}

function planReset() {
  state.weekPlan = null;
  _plan.activeDay = 0;
  save();
  _plan.loading = false;
  $('planResult').innerHTML = '';
  $('planEmpty').style.display = '';
  $('planNiche')?.focus();
}

/* =========================================================
   COMPETITOR POSITIONING MAP
   2–4 competitor URLs → per-competitor breakdown, overlap,
   the gap they all miss, positioning statement, vs one-liners
   ========================================================= */

const _pos = {
  loading: false,
  count: 2,      // visible competitor slots (2–4)
  result: null,
};

function posAddCompetitor() {
  if (_pos.count >= 4) return;
  _pos.count++;
  const slot = $(`posComp${_pos.count}`);
  if (slot) slot.style.display = '';
  if (_pos.count >= 4) { const b = $('posAddBtn'); if (b) b.style.display = 'none'; }
}

function posRemoveCompetitor(n) {
  const slot = $(`posComp${n}`);
  if (slot) slot.style.display = 'none';
  const inp = $(`posUrl${n}`); if (inp) inp.value = '';
  if (_pos.count === n) _pos.count--;
  const b = $('posAddBtn'); if (b) b.style.display = '';
}

function posGetUrls() {
  const urls = [];
  for (let i = 1; i <= 4; i++) {
    const slot = $(`posComp${i}`);
    if (!slot || slot.style.display === 'none') continue;
    const val = ($(`posUrl${i}`)?.value || '').trim();
    if (val) urls.push(val);
  }
  return urls;
}

async function posAnalyze() {
  if (_pos.loading) return;
  const urls = posGetUrls();
  if (urls.length < 2) { toast('Enter at least 2 competitor URLs'); return; }
  const badUrl = urls.find(u => !u.startsWith('http'));
  if (badUrl) { toast('URLs must start with https://'); return; }

  const product = {
    name: ($('posProductName')?.value || '').trim(),
    what: ($('posProductWhat')?.value || '').trim(),
  };

  _pos.loading = true;
  const btn = $('posAnalyzeBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="ce-spinner"></span>Fetching & analyzing…'; }
  $('posEmpty').style.display = 'none';
  $('posResult').innerHTML = `
    <div class="roast-loading" role="status" aria-live="polite">
      <div class="ce-spinner" aria-hidden="true"></div>
      <span>Fetching ${urls.length} competitor pages and mapping their positions…</span>
    </div>`;

  try {
    const data = await xgFetch('/generate', {
      kind: 'positioning',
      competitors: urls,
      product: (product.name || product.what) ? product : null,
    });
    const parsed = posParseResult(data.text || '', urls.length);
    _pos.result = parsed;
    posRenderResult(parsed, urls);
  } catch (err) {
    $('posResult').innerHTML =
      `<div class="ce-skeleton" style="color:#f87171;min-height:80px;border-color:rgba(248,113,113,.3)">${ceEsc(err.message || 'Analysis failed — make sure the URLs are public landing pages')}</div>`;
  } finally {
    _pos.loading = false;
    if (btn) { btn.disabled = false; btn.innerHTML = 'Analyze →'; }
  }
}

function posParseResult(text, n) {
  const get = (block, field) => {
    const m = new RegExp(`^${field}:\\s*(.+)`, 'mi').exec(block);
    return m ? m[1].trim() : '';
  };
  const section = (label, nextLabel) => {
    const re = new RegExp(`## ${label}\\s*\\n([\\s\\S]*?)(?=## |$)`, 'i');
    const m = re.exec(text.replace(/## VS EACH COMPETITOR/, '## VS_EACH_COMPETITOR'));
    return m ? m[1].trim() : '';
  };

  const competitors = [];
  for (let i = 1; i <= n; i++) {
    // Grab block from ## COMPETITOR N up to the next ## heading
    const re = new RegExp(`## COMPETITOR ${i}\\s*\\n([\\s\\S]*?)(?=## COMPETITOR ${i+1}|## OVERLAP|## THE GAP|## POSITIONING|## VS|$)`, 'i');
    const m = re.exec(text);
    const block = m ? m[1] : '';
    competitors.push({
      name:     get(block, 'NAME'),
      domain:   get(block, 'DOMAIN'),
      claim:    get(block, 'CLAIM'),
      target:   get(block, 'TARGET'),
      strongest:get(block, 'STRONGEST'),
      weakness: get(block, 'WEAKNESS'),
    });
  }

  const overlap = (() => {
    const m = /## OVERLAP\s*\n([\s\S]*?)(?=## THE GAP|## POSITIONING|## VS|$)/i.exec(text);
    return m ? m[1].trim() : '';
  })();
  const gap = (() => {
    const m = /## THE GAP\s*\n([\s\S]*?)(?=## POSITIONING|## VS|$)/i.exec(text);
    return m ? m[1].trim() : '';
  })();
  const positioning = (() => {
    const m = /## POSITIONING STATEMENT\s*\n([\s\S]*?)(?=## VS|$)/i.exec(text);
    return m ? m[1].trim() : '';
  })();
  const vsBlock = (() => {
    const m = /## VS EACH COMPETITOR\s*\n([\s\S]*?)$/i.exec(text);
    return m ? m[1] : '';
  })();
  const vsLines = [];
  for (let i = 1; i <= n; i++) {
    const m = new RegExp(`COMPETITOR ${i}:\\s*(.+)`, 'i').exec(vsBlock);
    vsLines.push(m ? m[1].trim() : '');
  }

  return { competitors, overlap, gap, positioning, vsLines };
}

function posRenderResult(parsed, urls) {
  const { competitors, overlap, gap, positioning, vsLines } = parsed;
  let html = '';

  // ── Competitor cards ───────────────────────────────────────────────────────
  html += `<div class="pos-comp-grid">`;
  competitors.forEach((c, i) => {
    const displayName = c.name || c.domain || `Competitor ${i+1}`;
    html += `
    <div class="pos-comp-card">
      <div class="pos-comp-head">
        <span class="pos-comp-name">${ceEsc(displayName)}</span>
        ${c.domain && c.name && c.domain !== c.name ? `<a href="${ceEsc(urls[i]||'#')}" target="_blank" rel="noopener" class="pos-comp-domain">${ceEsc(c.domain)} ↗</a>` : ''}
      </div>
      <p class="pos-comp-claim">${ceEsc(c.claim)}</p>
      ${c.target    ? `<div class="pos-field"><span class="pos-field-lbl">Targets</span><span class="pos-field-val">${ceEsc(c.target)}</span></div>` : ''}
      ${c.strongest ? `<div class="pos-field"><span class="pos-field-lbl">Strongest angle</span><span class="pos-field-val">${ceEsc(c.strongest)}</span></div>` : ''}
      ${c.weakness  ? `<div class="pos-field"><span class="pos-field-lbl">Weakness</span><span class="pos-field-val pos-weakness-val">${ceEsc(c.weakness)}</span></div>` : ''}
    </div>`;
  });
  html += `</div>`;

  // ── Overlap ────────────────────────────────────────────────────────────────
  if (overlap) {
    html += `
    <div class="pos-overlap-card">
      <div class="pos-section-lbl">Where they all fight</div>
      <p class="pos-body-text">${ceEsc(overlap)}</p>
    </div>`;
  }

  // ── The Gap ────────────────────────────────────────────────────────────────
  if (gap) {
    html += `
    <div class="pos-gap-card">
      <div class="pos-section-lbl pos-gap-lbl">The gap you own</div>
      <p class="pos-gap-text">${ceEsc(gap)}</p>
    </div>`;
  }

  // ── Positioning statement ──────────────────────────────────────────────────
  if (positioning) {
    html += `
    <div class="pos-statement-card">
      <div class="pos-section-lbl" style="margin-bottom:10px">Your positioning statement</div>
      <p class="pos-statement-text">${ceEsc(positioning)}</p>
      <button class="btn ghost" style="height:30px;font-size:12px;padding:0 12px;margin-top:12px;align-self:flex-start" data-ce-copy="${ceEsc(positioning)}" onclick="ceCopyAttr(this)">Copy</button>
    </div>`;
  }

  // ── VS each competitor ─────────────────────────────────────────────────────
  const validVs = vsLines.filter(v => v);
  if (validVs.length) {
    html += `
    <div class="pos-vs-section">
      <div class="pos-section-lbl" style="margin-bottom:10px">How you win against each</div>
      <div class="pos-vs-list">`;
    vsLines.forEach((line, i) => {
      if (!line) return;
      const c = competitors[i];
      const name = c?.name || c?.domain || `Competitor ${i+1}`;
      html += `
        <div class="pos-vs-item">
          <span class="pos-vs-name">${ceEsc(name)}</span>
          <span class="pos-vs-text">${ceEsc(line)}</span>
        </div>`;
    });
    html += `</div></div>`;
  }

  // ── Reset ──────────────────────────────────────────────────────────────────
  html += `
    <div style="margin-top:20px;display:flex;justify-content:flex-end">
      <button class="btn secondary" style="height:38px;padding:0 16px;font-size:13px" onclick="posReset()">Analyze different competitors</button>
    </div>`;

  $('posResult').innerHTML = html;
}

function posReset() {
  _pos.result = null;
  _pos.loading = false;
  $('posResult').innerHTML = '';
  $('posEmpty').style.display = '';
  for (let i = 1; i <= 4; i++) {
    const inp = $(`posUrl${i}`); if (inp) inp.value = '';
  }
  $('posProductName') && ($('posProductName').value = '');
  $('posProductWhat') && ($('posProductWhat').value = '');
  $('posUrl1')?.focus();
}

/* =========================================================
   HOOK GENERATOR
   Topic / idea → 10 labeled scroll-stopping openers
   ========================================================= */

const _hook = {
  platform: 'linkedin',
  loading: false,
  hooks: [],
};

function hookSetPlatform(platform) {
  _hook.platform = platform;
  ['linkedin', 'x'].forEach(p => {
    const btn = $('hplat-' + p);
    if (!btn) return;
    btn.classList.toggle('active', p === platform);
    btn.setAttribute('aria-selected', p === platform ? 'true' : 'false');
  });
}

async function hookGenerate() {
  if (_hook.loading) return;
  const topic = ($('hookTopicInput')?.value || '').trim();
  if (!topic || topic.length < 5) { toast('Enter a topic first'); $('hookTopicInput')?.focus(); return; }

  _hook.loading = true;
  const btn = $('hookGenBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="ce-spinner"></span>Generating…'; }
  $('hookEmpty').style.display = 'none';
  $('hookResult').innerHTML = `
    <div class="roast-loading" role="status" aria-live="polite">
      <div class="ce-spinner" aria-hidden="true"></div>
      <span>Writing 10 hooks…</span>
    </div>`;

  try {
    const data = await xgFetch('/generate', {
      kind: 'hooks',
      topic,
      platform: _hook.platform,
      voiceNiche: state.profile?.niche || '',
    });
    const hooks = hookParseHooks(data.text || '');
    _hook.hooks = hooks;
    hookRenderResults(hooks);
  } catch (err) {
    $('hookResult').innerHTML =
      `<div class="ce-skeleton" style="color:#f87171;min-height:80px;border-color:rgba(248,113,113,.3)">${ceEsc(err.message || 'Generation failed — try again')}</div>`;
  } finally {
    _hook.loading = false;
    if (btn) { btn.disabled = false; btn.innerHTML = 'Generate hooks →'; }
  }
}

const HOOK_TYPES = [
  'CURIOSITY','STAT','CONTRARIAN','STORY','QUESTION',
  'PAIN','BOLD CLAIM','OBSERVATION','BEFORE/AFTER','COUNTER-INTUITIVE',
];

function hookParseHooks(text) {
  const hooks = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    for (const type of HOOK_TYPES) {
      if (line.toUpperCase().startsWith(type + ':')) {
        const hookText = line.slice(type.length + 1).trim();
        if (hookText) hooks.push({ type, text: hookText });
        break;
      }
    }
  }
  return hooks;
}

function hookRenderResults(hooks) {
  if (!hooks.length) {
    $('hookResult').innerHTML = `<p style="color:var(--muted);font-size:14px">Couldn't parse the hooks — try again.</p>`;
    return;
  }
  const cardsHtml = hooks.map((h, i) => `
    <div class="hook-card">
      <div class="hook-card-head">
        <span class="hook-type-badge">${ceEsc(h.type)}</span>
        <span class="hook-char">${h.text.length} chars</span>
      </div>
      <p class="hook-text">${ceEsc(h.text)}</p>
      <div class="hook-foot">
        <button class="hook-use-btn" onclick="hookUseInCE(${i})">Use in CE →</button>
        <button class="btn ghost" style="height:30px;padding:0 12px;font-size:12px" data-ce-copy="${ceEsc(h.text)}" onclick="ceCopyAttr(this)">Copy</button>
      </div>
    </div>`).join('');

  $('hookResult').innerHTML = `
    <div class="hook-grid">${cardsHtml}</div>
    <div style="display:flex;justify-content:flex-end;margin-top:4px">
      <button class="btn secondary" style="height:38px;padding:0 16px;font-size:13px" onclick="hookReset()">Generate more</button>
    </div>`;
}

function hookUseInCE(idx) {
  const h = _hook.hooks[idx];
  if (!h) return;
  // Switch nav to Content Engine
  const ceBtn = document.querySelector('#nav button[data-view="content"]');
  if (ceBtn) ceBtn.click();
  // Switch CE to Write mode and prefill
  ceSwitchInputMode('write');
  const writeInput = $('ceWriteInput');
  if (writeInput) { writeInput.value = h.text; writeInput.focus(); }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toast('Hook loaded — add context or hit Generate');
}

function hookReset() {
  _hook.hooks = [];
  _hook.loading = false;
  $('hookResult').innerHTML = '';
  $('hookEmpty').style.display = '';
  const input = $('hookTopicInput');
  if (input) { input.value = ''; input.focus(); }
}

function ceRoastReset() {
  _roast.result  = null;
  _roast.loading = false;
  $('roastResult').innerHTML  = '';
  $('roastEmpty').style.display = '';
  const urlInput  = $('roastUrlInput');  if (urlInput)  urlInput.value  = '';
  const copyInput = $('roastCopyInput'); if (copyInput) copyInput.value = '';
}

/* =========================================================
   CONTENT CALENDAR BUILDER
   Niche + goal + channels → N days of post ideas with
   hook, angle, CTA — grouped by week, downloadable as MD
   ========================================================= */

const _cal = {
  loading: false,
  days: [],
  weeks: [],          // days grouped into weeks of 7
  generating: {},     // weekIndex → bool (batch generation in flight)
};

function calGetChannels() {
  return Array.from(document.querySelectorAll('#calChannelChips .portal-chip.active'))
    .map(b => b.dataset.ch).filter(Boolean);
}

async function calGenerate() {
  if (_cal.loading) return;
  const niche = ($('calNiche')?.value || '').trim();
  if (!niche || niche.length < 5) { toast('Add your product & niche first'); $('calNiche')?.focus(); return; }
  const channels = calGetChannels();
  if (!channels.length) { toast('Select at least one channel'); return; }
  const dayCount = parseInt($('calDays')?.value || '30', 10);

  _cal.loading = true;
  const btn = $('calGenBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="ce-spinner"></span>Building calendar…'; }
  $('calEmpty').style.display = 'none';
  $('calResult').innerHTML = `
    <div class="roast-loading" role="status" aria-live="polite">
      <div class="ce-spinner" aria-hidden="true"></div>
      <span>Planning ${dayCount} days of content…</span>
    </div>`;

  try {
    const data = await xgFetch('/generate', {
      kind: 'calendar',
      niche,
      goal: ($('calGoal')?.value || '').trim(),
      days: dayCount,
      channels,
      voiceNiche: state.profile?.niche || '',
    });
    const days = calParse(data.text || '');
    _cal.days = days;
    calRender(days, dayCount);
  } catch (err) {
    $('calResult').innerHTML =
      `<div class="ce-skeleton" style="color:#f87171;min-height:80px;border-color:rgba(248,113,113,.3)">${ceEsc(err.message || 'Generation failed — try again')}</div>`;
  } finally {
    _cal.loading = false;
    if (btn) { btn.disabled = false; btn.innerHTML = 'Build my calendar →'; }
  }
}

function calParse(text) {
  const days = [];
  // Split on ## DAY N headings, keep each block with its header
  const blocks = text.split(/(?=## DAY \d+)/i);
  for (const block of blocks) {
    const dayMatch = /## DAY (\d+)/i.exec(block);
    if (!dayMatch) continue;
    const n = parseInt(dayMatch[1], 10);
    const get = field => {
      const m = new RegExp(`^${field}:\\s*(.+)`, 'mi').exec(block);
      return m ? m[1].trim() : '';
    };
    const entry = {
      n,
      platform: get('PLATFORM'),
      type:     get('TYPE'),
      hook:     get('HOOK'),
      angle:    get('ANGLE'),
      cta:      get('CTA'),
    };
    if (entry.hook || entry.angle) days.push(entry);
  }
  // Sort by day number in case AI reordered
  days.sort((a, b) => a.n - b.n);
  return days;
}

const CAL_PLATFORM_COLORS = {
  'linkedin':   { bg: 'rgba(10,102,194,.18)',  color: '#60a5fa' },
  'x':          { bg: 'rgba(255,255,255,.08)', color: '#e2e8f0' },
  'twitter':    { bg: 'rgba(255,255,255,.08)', color: '#e2e8f0' },
  'email':      { bg: 'rgba(251,146,60,.15)',  color: '#fb923c' },
  'content':    { bg: 'rgba(74,222,128,.12)',  color: '#4ade80' },
  'seo':        { bg: 'rgba(74,222,128,.12)',  color: '#4ade80' },
  'reddit':     { bg: 'rgba(255,86,0,.15)',    color: '#f97316' },
  'instagram':  { bg: 'rgba(214,57,163,.15)',  color: '#e879f9' },
  'communities':{ bg: 'rgba(255,86,0,.15)',    color: '#f97316' },
};

function calPlatformStyle(platform) {
  if (!platform) return { bg: 'rgba(255,255,255,.06)', color: 'var(--muted)' };
  const key = platform.toLowerCase().split(/[\s/,–-]/)[0].trim();
  return CAL_PLATFORM_COLORS[key] || { bg: 'rgba(255,255,255,.06)', color: 'var(--muted)' };
}

function calRender(days, totalDays) {
  if (!days.length) {
    $('calResult').innerHTML = `<p style="color:var(--muted);font-size:14px">Couldn't parse the calendar — try again.</p>`;
    return;
  }

  // Group into weeks
  const weeks = [];
  let week = [];
  days.forEach((d, i) => {
    week.push(d);
    if (week.length === 7 || i === days.length - 1) {
      weeks.push([...week]);
      week = [];
    }
  });
  _cal.weeks = weeks;

  let html = `<div class="cal-calendar">`;

  weeks.forEach((wk, wi) => {
    // Count how many of this week's ideas map to a writable social platform
    const writable = wk.filter(d => calMapPlatform(d.platform)).length;
    html += `
    <div class="cal-week">
      <div class="cal-week-bar">
        <div class="cal-week-label">Week ${wi + 1}</div>
        ${writable ? `<button class="cal-week-gen" id="calWeekGen-${wi}" onclick="calGenerateWeekPosts(${wi})">⚡ Write all ${writable} posts →</button>` : ''}
      </div>
      <div class="cal-grid">`;
    wk.forEach(d => {
      const ps = calPlatformStyle(d.platform);
      const idx = days.indexOf(d);
      html += `
      <div class="cal-card">
        <div class="cal-card-top">
          <span class="cal-day-num">Day ${d.n}</span>
          <span class="cal-platform-badge" style="background:${ps.bg};color:${ps.color}">${ceEsc(d.platform || '—')}</span>
        </div>
        ${d.type ? `<span class="cal-type-chip">${ceEsc(d.type)}</span>` : ''}
        <p class="cal-hook">${ceEsc(d.hook)}</p>
        ${d.angle ? `<p class="cal-angle">${ceEsc(d.angle)}</p>` : ''}
        ${d.cta ? `<div class="cal-cta"><span class="cal-cta-lbl">CTA</span>${ceEsc(d.cta)}</div>` : ''}
        <div class="cal-card-foot">
          <button class="hook-use-btn" onclick="calUseHook(${idx})" style="font-size:11px;height:26px;padding:0 10px">Use in CE →</button>
          <button class="btn ghost" style="height:26px;padding:0 10px;font-size:11px" data-ce-copy="${ceEsc(d.hook)}" onclick="ceCopyAttr(this)">Copy hook</button>
        </div>
      </div>`;
    });
    html += `</div>
      <div class="cal-week-posts" id="calWeekPosts-${wi}"></div>
    </div>`;
  });

  html += `</div>`;

  // Download + reset row
  html += `
  <div style="display:flex;gap:10px;margin-top:20px;flex-wrap:wrap">
    <button class="btn secondary" style="height:38px;padding:0 16px;font-size:13px" onclick="calDownload()">↓ Download Markdown</button>
    <button class="btn secondary" style="height:38px;padding:0 16px;font-size:13px" onclick="calReset()">Build another</button>
  </div>`;

  $('calResult').innerHTML = html;
}

function calUseHook(idx) {
  const d = _cal.days[idx];
  if (!d || !d.hook) return;
  const ceBtn = document.querySelector('#nav button[data-view="content"]');
  if (ceBtn) ceBtn.click();
  ceSwitchInputMode('write');
  const writeInput = $('ceWriteInput');
  if (writeInput) { writeInput.value = d.hook; writeInput.focus(); }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toast('Hook loaded in Content Engine');
}

function calDownload() {
  if (!_cal.days.length) return;
  const niche = ($('calNiche')?.value || 'content').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 30);
  let md = `# Content Calendar\n\nGenerated by XGrowth — https://www.xgrowth.uno\n`;
  let curWeek = 0;
  _cal.days.forEach((d, i) => {
    const wk = Math.floor(i / 7) + 1;
    if (wk > curWeek) { curWeek = wk; md += `\n## Week ${wk}\n\n`; }
    md += `### Day ${d.n} — ${d.platform}\n`;
    if (d.type)  md += `**Type:** ${d.type}\n\n`;
    if (d.hook)  md += `**Hook:** ${d.hook}\n\n`;
    if (d.angle) md += `**Angle:** ${d.angle}\n\n`;
    if (d.cta)   md += `**CTA:** ${d.cta}\n\n`;
    md += `---\n\n`;
  });
  const blob = new Blob([md], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `content-calendar-${niche}.md`;
  a.click();
}

function calReset() {
  _cal.days = [];
  _cal.weeks = [];
  _cal.loading = false;
  $('calResult').innerHTML = '';
  $('calEmpty').style.display = '';
  $('calNiche')?.focus();
}

/* =========================================================
   BATCH "GENERATE THE WEEK"
   Turn a week of calendar ideas into finished, platform-ready
   posts in one run → drops them into a persistent queue.
   ========================================================= */

// Map a calendar platform display string → Content Engine post platform enum.
// Returns null for non-social channels (Email, SEO/blog) which aren't quick social posts.
function calMapPlatform(display) {
  const s = (display || '').toLowerCase();
  if (s.includes('linkedin')) return 'linkedin';
  if (s.includes('twitter') || /\bx\b/.test(s) || s.startsWith('x ')) return 'x';
  if (s.includes('reddit') || s.includes('communit')) return 'reddit';
  if (s.includes('instagram') || s.includes('insta')) return 'instagram';
  return null; // email, content/seo, etc.
}

// Build the freewrite brief + payload for one calendar idea, then generate a finished post.
async function batchPostFromIdea(idea) {
  const platform = calMapPlatform(idea.platform);
  if (!platform) return null;
  const isThread = platform === 'x' && /thread/i.test(idea.type || '');

  const notes = [
    `Write a ${idea.type || 'social post'} for ${idea.platform}.`,
    idea.hook  ? `Open with this hook (or a very close variant): "${idea.hook}"` : '',
    idea.angle ? `What the post is about: ${idea.angle}` : '',
    idea.cta   ? `End with this call to action: ${idea.cta}` : '',
  ].filter(Boolean).join('\n');

  const data = await xgFetch('/generate', {
    kind: 'post',
    inputMode: 'freewrite',
    articleTitle: notes,
    topic: idea.angle || idea.hook || '',
    platform,
    mode: isThread ? 'thread' : 'hot-take',
    voiceNiche: state.profile?.niche || '',
    voiceStyle: 'casual',
  });

  return {
    id: `${Date.now()}-${idea.n}-${platform}`,
    day: idea.n,
    platformLabel: idea.platform,
    platform,
    type: idea.type || '',
    hook: idea.hook || '',
    isThread,
    text: (data.text || '').trim(),
    createdAt: Date.now(),
    posted: false,
  };
}

async function calGenerateWeekPosts(wi) {
  if (_cal.generating[wi]) return;
  const wk = _cal.weeks[wi] || [];
  const ideas = wk.filter(d => calMapPlatform(d.platform));
  if (!ideas.length) { toast('No social posts in this week to write'); return; }

  _cal.generating[wi] = true;
  const btn = $(`calWeekGen-${wi}`);
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="ce-spinner"></span>Writing…'; }
  const panel = $(`calWeekPosts-${wi}`);
  if (panel) {
    panel.innerHTML = `
      <div class="roast-loading" role="status" aria-live="polite" style="margin-top:12px">
        <div class="ce-spinner" aria-hidden="true"></div>
        <span>Writing ${ideas.length} posts for Week ${wi + 1}…</span>
      </div>`;
  }

  // Generate all in parallel; tolerate individual failures.
  const settled = await Promise.allSettled(ideas.map(batchPostFromIdea));
  const results = settled
    .filter(r => r.status === 'fulfilled' && r.value && r.value.text)
    .map(r => r.value);
  const failed = ideas.length - results.length;

  // Persist to the queue (newest week additions first within their day order)
  queueAdd(results);

  // Render the finished posts inline under the week
  if (panel) {
    if (!results.length) {
      panel.innerHTML = `<div class="ce-skeleton" style="color:#f87171;margin-top:12px;min-height:60px;border-color:rgba(248,113,113,.3)">Couldn't generate posts — try again.</div>`;
    } else {
      panel.innerHTML = `
        <div class="cal-week-posts-head">${results.length} post${results.length > 1 ? 's' : ''} written${failed ? ` · ${failed} failed` : ''} — saved to your queue below</div>
        <div class="batch-posts">${results.map(batchPostCardHTML).join('')}</div>`;
    }
  }

  _cal.generating[wi] = false;
  if (btn) { btn.disabled = false; btn.innerHTML = '⚡ Re-write this week →'; }
  if (results.length) toast(`${results.length} posts added to your queue`);
}

// Renders one finished post (handles thread / reddit / instagram / plain text).
function batchPostCardHTML(post) {
  const ps = calPlatformStyle(post.platformLabel);
  const badge = `<span class="cal-platform-badge" style="background:${ps.bg};color:${ps.color}">${ceEsc(post.platformLabel)}</span>`;
  const head = `
    <div class="batch-post-head">
      <span class="batch-post-day">Day ${post.day}</span>
      ${badge}
      ${post.type ? `<span class="cal-type-chip">${ceEsc(post.type)}</span>` : ''}
    </div>`;

  let body = '';
  let copyText = post.text;

  if (post.isThread) {
    const tweets = ceParseThread(post.text);
    copyText = tweets.join('\n\n');
    body = `<div class="batch-thread">` + tweets.map((t, i) => `
      <div class="batch-tweet">
        <span class="batch-tweet-num">${i + 1}/${tweets.length}</span>
        <p class="batch-tweet-text">${ceEsc(t)}</p>
      </div>`).join('') + `</div>`;
  } else if (post.platform === 'reddit') {
    const r = ceParseReddit(post.text);
    copyText = `${r.title}\n\n${r.body}`;
    body = `
      ${r.subreddit ? `<div class="batch-reddit-sub">r/${ceEsc(r.subreddit)}</div>` : ''}
      ${r.title ? `<p class="batch-reddit-title">${ceEsc(r.title)}</p>` : ''}
      <p class="batch-post-text">${ceEsc(r.body)}</p>`;
  } else if (post.platform === 'instagram') {
    const ig = ceParseInstagram(post.text);
    copyText = ig.hashtags ? `${ig.caption}\n\n${ig.hashtags}` : ig.caption;
    body = `
      <p class="batch-post-text">${ceEsc(ig.caption)}</p>
      ${ig.hashtags ? `<p class="batch-ig-tags">${ceEsc(ig.hashtags)}</p>` : ''}`;
  } else {
    body = `<p class="batch-post-text">${ceEsc(post.text)}</p>`;
  }

  return `
    <div class="batch-post">
      ${head}
      ${body}
      <div class="batch-post-foot">
        <button class="btn ghost" style="height:30px;padding:0 12px;font-size:12px" data-ce-copy="${ceEsc(copyText)}" onclick="ceCopyAttr(this)">Copy</button>
      </div>
    </div>`;
}

/* ── Post Queue — persisted in state, synced to Firestore ─────────────────── */

function queueAdd(posts) {
  if (!posts || !posts.length) return;
  if (!Array.isArray(state.postQueue)) state.postQueue = [];
  // De-dupe: replace any existing queue item for the same day+platform
  posts.forEach(p => {
    const i = state.postQueue.findIndex(q => q.day === p.day && q.platform === p.platform);
    if (i > -1) state.postQueue[i] = p;
    else state.postQueue.push(p);
  });
  // Keep the queue sane (cap at 60 most recent)
  state.postQueue.sort((a, b) => a.day - b.day);
  if (state.postQueue.length > 60) state.postQueue = state.postQueue.slice(-60);
  save();
  queueRender();
}

function queueRemove(id) {
  if (!Array.isArray(state.postQueue)) return;
  state.postQueue = state.postQueue.filter(q => q.id !== id);
  save();
  queueRender();
}

function queueTogglePosted(id) {
  const q = (state.postQueue || []).find(x => x.id === id);
  if (!q) return;
  q.posted = !q.posted;
  save();
  queueRender();
}

function queueClearPosted() {
  if (!Array.isArray(state.postQueue)) return;
  state.postQueue = state.postQueue.filter(q => !q.posted);
  save();
  queueRender();
  toast('Cleared posted items');
}

function queueRender() {
  const el = $('calQueue');
  if (!el) return;
  const q = Array.isArray(state.postQueue) ? state.postQueue : [];
  if (!q.length) { el.innerHTML = ''; return; }

  const pending = q.filter(x => !x.posted).length;
  const done = q.length - pending;

  const items = q.map(post => {
    const ps = calPlatformStyle(post.platformLabel);
    // Build a copy-ready text per platform shape
    let copyText = post.text;
    if (post.isThread) copyText = ceParseThread(post.text).join('\n\n');
    else if (post.platform === 'reddit') { const r = ceParseReddit(post.text); copyText = `${r.title}\n\n${r.body}`; }
    else if (post.platform === 'instagram') { const ig = ceParseInstagram(post.text); copyText = ig.hashtags ? `${ig.caption}\n\n${ig.hashtags}` : ig.caption; }
    const preview = (post.hook || post.text || '').slice(0, 120);
    return `
      <div class="queue-item${post.posted ? ' queue-item-done' : ''}">
        <button class="queue-check" onclick="queueTogglePosted('${post.id}')" aria-label="${post.posted ? 'Mark as not posted' : 'Mark as posted'}" title="${post.posted ? 'Posted' : 'Mark as posted'}">${post.posted ? '✓' : ''}</button>
        <div class="queue-item-main">
          <div class="queue-item-meta">
            <span class="cal-platform-badge" style="background:${ps.bg};color:${ps.color}">${ceEsc(post.platformLabel)}</span>
            <span class="queue-item-day">Day ${post.day}</span>
            ${post.type ? `<span class="queue-item-type">${ceEsc(post.type)}</span>` : ''}
          </div>
          <p class="queue-item-preview">${ceEsc(preview)}${preview.length >= 120 ? '…' : ''}</p>
        </div>
        <div class="queue-item-actions">
          <button class="btn ghost" style="height:28px;padding:0 10px;font-size:11px" data-ce-copy="${ceEsc(copyText)}" onclick="ceCopyAttr(this)">Copy</button>
          <button class="queue-del" onclick="queueRemove('${post.id}')" aria-label="Remove from queue" title="Remove">×</button>
        </div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="queue-panel">
      <div class="queue-head">
        <div>
          <div class="queue-title">Post queue</div>
          <div class="queue-sub">${pending} ready to post${done ? ` · ${done} posted` : ''}</div>
        </div>
        ${done ? `<button class="btn secondary" style="height:32px;padding:0 12px;font-size:12px" onclick="queueClearPosted()">Clear posted</button>` : ''}
      </div>
      <div class="queue-list">${items}</div>
    </div>`;
}

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
