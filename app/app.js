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
  // (signInWithRedirect itself navigates the page so we won't reach this in that case.)
  if(!fbAuth.currentUser){
    runAuthGateLogic();
  }
});
const state = load() || {
  profile: null,
  metrics: {
    followers: [],   // up to 30 days
    impressions: [], // up to 30 days
    engagement: [],  // up to 30 days (rate %)
    visits: []       // up to 30 days
  },
  posts: [],
  campaigns: [],
  goals: [],
  library: [],
  range: 7
};
// Always start at 7-day range on login. User can switch mid-session;
// next reload returns to 7d. (If you want range to persist, change to: if(state.range == null) state.range = 7;)
state.range = 7;

function save(){
  localStorage.setItem(KEY, JSON.stringify(state));
  // Mirror to Firestore (debounced) when signed in
  if(fbAuth.currentUser && cloudLoaded){
    setSync('syncing');
    clearTimeout(saveDebounce);
    saveDebounce = setTimeout(()=>{
      db.collection('users').doc(fbAuth.currentUser.uid).set(state, {merge:false})
        .then(()=> setSync('synced'))
        .catch(err=>{ console.error('Cloud save failed', err); setSync('error'); });
    }, 700);
  }
}
function load(){ try{return JSON.parse(localStorage.getItem(KEY))}catch{return null} }
function setSync(status){
  const el = $('syncStatus'); if(!el) return;
  el.className = 'sync ' + status;
  $('syncLabel').textContent = {synced:'Synced', syncing:'Syncing…', offline:'Offline', error:'Sync error'}[status] || status;
}
async function loadFromCloud(){
  if(!fbAuth.currentUser) return;
  setSync('syncing');
  try{
    const snap = await db.collection('users').doc(fbAuth.currentUser.uid).get();
    if(snap.exists){
      const cloud = snap.data() || {};
      // Cloud wins on initial load, EXCEPT range — always start at 7d on login.
      Object.assign(state, cloud);
      state.range = 7;
      localStorage.setItem(KEY, JSON.stringify(state));
      cloudLoaded = true;
      if(state.profile){ applyProfile(); }
      else { renderAll(); }
      setSync('synced');
    } else {
      // First sign-in on this account → push current local state up
      cloudLoaded = true;
      await db.collection('users').doc(fbAuth.currentUser.uid).set(state);
      setSync('synced');
    }
  }catch(err){
    console.error('Cloud load failed', err);
    setSync('error');
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
  document.querySelector(`section[data-view="${v}"]`).classList.remove('hide');
  if(v === 'brand') brandKitAutoFill();
  if(v === 'icp')   icpAutoFill();
  if(v === 'ph')    phAutoFill();
  if(v === 'email') emailAutoFill();
  if(v === 'growth') growthAutoFill();
  if(v === 'library') renderLibrary();
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
// Also close on Escape
document.addEventListener('keydown', (e)=>{
  if(e.key === 'Escape'){
    document.querySelectorAll('.modal.show').forEach(m=>{
      if(m.id === 'welcome') closeWelcome(true);
      else m.classList.remove('show');
    });
  }
});
function closeWelcome(skip){
  document.getElementById('welcome').classList.remove('show');
  if(skip && !state.profile){
    state.profile = {niche:'AI SaaS', stage:'Pre-seed', target:'Both', goal:'10k followers'};
    save();
  }
  applyProfile();
}
function saveProfile(){
  state.profile = {
    niche: val('pNiche') || 'AI SaaS',
    stage: val('pStage'),
    target: val('pTarget'),
    goal:  val('pGoal') || '10k followers'
  };
  // seed goals from typed goal
  state.goals = parseGoals(state.profile.goal);
  if(!state.metrics.followers.length) seedDemo(true);
  save(); closeWelcome(false);
  toast('Profile saved');
}
document.getElementById('editProfile').onclick = ()=>{
  if(state.profile){
    document.getElementById('pNiche').value = state.profile.niche;
    document.getElementById('pStage').value = state.profile.stage;
    document.getElementById('pTarget').value = state.profile.target;
    document.getElementById('pGoal').value  = state.profile.goal;
  }
  openWelcome();
};

function applyProfile(){
  const p = state.profile;
  if(!p) return;
  document.getElementById('nicheTag').textContent = p.niche;
  document.getElementById('stageTag').textContent = p.stage;
  document.getElementById('goalTag').textContent  = p.goal;
  const audEl = document.getElementById('audienceTag'); if(audEl) audEl.textContent = p.target || '—';
  const st = document.getElementById('sessionTag'); if(st) st.textContent = p.niche.split(' ')[0];
  renderAll();
}

function parseGoals(s){
  // Extract numbered targets like "10k followers", "5 investor DMs"
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

/* ========= Demo data ========= */
function seedDemo(quiet){
  const days=30;
  const f=[], imp=[], eng=[], vis=[];
  let base = 900 + Math.floor(Math.random()*800);
  for(let i=0;i<days;i++){
    base += Math.floor(Math.random()*70-12);
    f.push(base);
    imp.push(1800 + Math.floor(Math.random()*8500) + i*180);
    eng.push(+(2 + Math.random()*4).toFixed(2));
    vis.push(110 + Math.floor(Math.random()*420));
  }
  state.metrics = {followers:f, impressions:imp, engagement:eng, visits:vis};
  state.posts = [
    {text:'5 patterns I saw kill pre-seed SaaS at YC →', impr:18420, prevImpr:14210, likes:412, replies:38, rt:73},
    {text:'Most "growth" advice fails for solo founders. Here\'s why:', impr:9845, prevImpr:11200, likes:201, replies:22, rt:31},
    {text:'I shipped 3 features in 24h. The trick wasn\'t speed.', impr:7211, prevImpr:5800, likes:156, replies:18, rt:14},
    {text:'Investor DMs that worked for me (template inside)', impr:5432, prevImpr:5210, likes:122, replies:31, rt:9},
  ];
  state.campaigns = [
    {name:'Launch Storm v1', spend:0, leads:48, status:'Live'},
    {name:'Investor Outreach', spend:120, leads:11, status:'Live'},
    {name:'Webinar, AI for SMB', spend:380, leads:64, status:'Planned'},
  ];
  if(state.profile && state.goals.length){
    // Update progress for "followers" goal if present
    state.goals = state.goals.map(g=>{
      if(/follower/i.test(g.label)) g.current = f[f.length-1];
      else if(/dm/i.test(g.label)) g.current = 3;
      else g.current = Math.round(g.target*0.2);
      return g;
    });
  } else if(!state.goals.length){
    state.goals = [
      {label:'followers', target:10000, current:f[f.length-1]},
      {label:'investor DMs', target:5, current:3},
      {label:'newsletter signups', target:500, current:120}
    ];
  }
  save(); renderAll();
  if(!quiet) toast('Demo data loaded');
}

function resetData(){
  if(!confirm('Reset all local data?')) return;
  localStorage.removeItem(KEY); location.reload();
}

/* ========= Render: Dashboard ========= */
function renderAll(){
  syncRangeButton();
  renderKPIs();
  renderBars();
  renderVelocity();
  renderFunnel();
  renderGoals();
  renderPosts();
  renderCampaigns();
}

function rangeWindow(){
  const r = state.range || 7;
  return {r, label:`last ${r} days`, prevLabel:`prior ${r} days`};
}

/* ── Animated counter for KPI numbers ─────────────────────────────────── */
function animCount(el, to, format, dur=700){
  if(!el || isNaN(to)) return;
  const start = performance.now();
  function tick(now){
    const t = Math.min((now-start)/dur, 1);
    const ease = 1 - Math.pow(1-t, 4);
    el.textContent = format(to * ease);
    if(t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function renderKPIs(){
  const m = state.metrics;
  if(!m.followers.length){ return; }
  const r = state.range || 7;
  const cur = m.followers.at(-1);
  const prev = m.followers.at(-1-r) || m.followers[0];

  animCount($('kFollowers'), cur, v => fmt(Math.round(v)));
  setDelta('kFollowersDelta', pct(cur, prev));
  $('lFollowers').textContent = `vs ${r}d ago`;

  const impCur = sum(m.impressions.slice(-r));
  const impPrev = sum(m.impressions.slice(-r*2,-r)) || 1;
  animCount($('kImpr'), impCur, v => fmt(Math.round(v)));
  setDelta('kImprDelta', pct(impCur, impPrev));
  $('lImpr').textContent = `${r}-day total`;

  const engCur = avg(m.engagement.slice(-r));
  const engPrev = avg(m.engagement.slice(-r*2,-r));
  animCount($('kEng'), engCur, v => v.toFixed(1)+'%');
  $('kEngDelta').textContent = (engCur-engPrev>=0?'+':'') + (engCur-engPrev).toFixed(1)+'pp';
  $('kEngDelta').className = 'delta ' + (engCur>engPrev?'up':engCur<engPrev?'down':'flat');

  const visCur = sum(m.visits.slice(-r));
  const visPrev = sum(m.visits.slice(-r*2,-r)) || 1;
  animCount($('kVisits'), visCur, v => fmt(Math.round(v)));
  setDelta('kVisitsDelta', pct(visCur, visPrev));
  $('lVisits').textContent = `${r}-day total`;

  const totalImpr = state.posts.reduce((a,p)=>a+p.impr,0);
  const totalReplies = state.posts.reduce((a,p)=>a+p.replies,0);
  const reply = totalImpr? (totalReplies/totalImpr*100) : 0;
  animCount($('kReply'), reply, v => v.toFixed(2)+'%');
  const replyPrev = avg(m.engagement.slice(-r*2,-r))*0.18;
  $('kReplyDelta').textContent = (reply-replyPrev>=0?'+':'') + (reply-replyPrev).toFixed(2)+'pp';
  $('kReplyDelta').className = 'delta ' + (reply>replyPrev?'up':reply<replyPrev?'down':'flat');

  drawSpark('sparkFollowers', m.followers.slice(-r));
  drawSpark('sparkImpr', m.impressions.slice(-r));
  drawSpark('sparkEng', m.engagement.slice(-r));
  drawSpark('sparkVisits', m.visits.slice(-r));
  drawSpark('sparkReply', m.engagement.slice(-r).map(v=>+(v*0.18).toFixed(2)));

  const rn = $('rangeNote'); if(rn) rn.textContent = `vs prior ${r} days`;
  if($('funnelRange')) $('funnelRange').textContent = `last ${r}d`;
}

function renderVelocity(){
  const m = state.metrics; if(!m.followers.length){ return; }
  const r = state.range || 7;
  const f = m.followers.slice(-r-1);
  const deltas = []; for(let i=1;i<f.length;i++) deltas.push(f[i]-f[i-1]);
  const max = Math.max(...deltas.map(Math.abs),1);
  // Render at height 0 first, then animate
  $('velChart').innerHTML = deltas.map((v,i)=>{
    const color = v>=0 ? 'linear-gradient(180deg,#4ade80,#22c55e)' : 'linear-gradient(180deg,#f87171,#dc2626)';
    return `<div class="bar" data-target="${(Math.abs(v)/max*100).toFixed(1)}" style="height:0%;background:${color}" data-v="${v>=0?'+':''}${v}"></div>`;
  }).join('');
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    $('velChart').querySelectorAll('.bar').forEach((b,i)=>{
      setTimeout(()=>{ b.style.height = b.dataset.target+'%'; }, i*20);
    });
  }));
  const net = deltas.reduce((a,b)=>a+b,0);
  const avgD = deltas.length ? (net/deltas.length).toFixed(1) : '0';
  $('velSummary').textContent = `Net ${net>=0?'+':''}${net} · Avg ${avgD}/day`;
}

function renderFunnel(){
  const m = state.metrics; if(!m.impressions.length){ return; }
  const r = state.range || 7;
  const impr = sum(m.impressions.slice(-r));
  const visits = sum(m.visits.slice(-r));
  // Assume profile clicks ~ 32% of profile visits become CTA clicks; leads from campaigns
  const profileClicks = Math.round(visits * 0.34);
  const leads = state.campaigns.reduce((a,c)=>a+(c.leads||0),0);
  const stages = [
    {name:'Impressions', value:impr, cls:''},
    {name:'Profile Visits', value:visits, cls:'f2'},
    {name:'CTA Clicks (est.)', value:profileClicks, cls:'f3'},
    {name:'Leads / DMs', value:Math.max(leads,1), cls:'f4'}
  ];
  const max = stages[0].value || 1;
  let html = '';
  stages.forEach((s,i)=>{
    const w = Math.max(8, (s.value/max*100));
    const conv = i>0 ? ((s.value/stages[i-1].value)*100).toFixed(1)+'% from prev' : '100% top';
    html += `<div class="funnel-row"><span>${s.name}</span><span><b>${fmt(s.value)}</b><span class="conv">${conv}</span></span></div>
             <div class="funnel-bar ${s.cls}" style="width:${w}%">${fmt(s.value)}</div>`;
  });
  $('funnel').innerHTML = html;
}

function setDelta(id, p){
  const el = $(id);
  el.textContent = (p>=0?'+':'') + p.toFixed(1)+'%';
  el.className = 'delta ' + (p>0.05?'up':p<-0.05?'down':'flat');
}

function drawSpark(id, data){
  const el = $(id);
  if(!el || data.length < 2) return;
  const w = el.clientWidth || 280, h = 52, padX = 2, padY = 6;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const xs = i => padX + (i*(w-padX*2))/(data.length-1);
  const ys = v => h - padY - ((v-min)/range)*(h-padY*2);
  // Build smooth bezier path
  const pts = data.map((v,i) => [xs(i), ys(v)]);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for(let i=1; i<pts.length; i++){
    const cp1x = (pts[i-1][0]+pts[i][0])/2, cp1y = pts[i-1][1];
    const cp2x = (pts[i-1][0]+pts[i][0])/2, cp2y = pts[i][1];
    d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${pts[i][0]},${pts[i][1]}`;
  }
  const areaD = d + ` L${pts[pts.length-1][0]},${h} L${pts[0][0]},${h} Z`;
  const gid = 'sg'+id;
  el.innerHTML = `
    <defs>
      <linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="#fff" stop-opacity=".25"/>
        <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${areaD}" fill="url(#${gid})"/>
    <path d="${d}" fill="none" stroke="#e5e5e5" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${pts[pts.length-1][0]}" cy="${pts[pts.length-1][1]}" r="3" fill="#fff"/>
  `;
}

function renderBars(){
  const r = state.range || 7;
  const data = state.metrics.impressions.slice(-r);
  if(!data.length) return;
  const max = Math.max(...data, 1);
  // Render with height 0, animate to actual heights
  $('barChart').innerHTML = data.map(v=>
    `<div class="bar" data-target="${(v/max*100).toFixed(1)}" style="height:0%" data-v="${fmt(v)}"></div>`
  ).join('');
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    $('barChart').querySelectorAll('.bar').forEach((b,i)=>{
      setTimeout(()=>{ b.style.height = b.dataset.target+'%'; }, i*22);
    });
  }));
  $('impSummary').textContent = `Total ${fmt(sum(data))} · Avg ${fmt(Math.round(avg(data)))}/day · ${r}d`;
}

/* Range selector wiring */
function syncRangeButton(){
  document.querySelectorAll('#rangeSel button[data-r]').forEach(x=>{
    x.classList.toggle('active', +x.dataset.r === state.range);
  });
}
document.addEventListener('click', (e)=>{
  const b = e.target.closest('#rangeSel button[data-r]'); if(!b) return;
  state.range = +b.dataset.r;
  syncRangeButton();
  save(); renderAll();
});

function renderGoals(){
  const wrap = $('goalList'); wrap.innerHTML = '';
  if(!state.goals.length){ wrap.innerHTML = '<div class="muted small">No goals yet, set them in your profile.</div>'; return; }
  state.goals.forEach(g=>{
    const p = Math.min(100, (g.current/g.target)*100);
    wrap.insertAdjacentHTML('beforeend', `
      <div style="margin:10px 0">
        <div style="display:flex;justify-content:space-between;font-size:13px">
          <span>${g.label}</span>
          <span class="muted">${fmt(g.current)} / ${fmt(g.target)} · ${p.toFixed(0)}%</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${p}%"></div></div>
      </div>
    `);
  });
}

function renderPosts(){
  const tb = $('postsBody'); tb.innerHTML = '';
  state.posts.slice().sort((a,b)=>b.impr-a.impr).forEach(p=>{
    const er = ((p.likes+p.replies+p.rt)/Math.max(1,p.impr)*100).toFixed(2)+'%';
    const prev = p.prevImpr || 0;
    const wow = prev? pct(p.impr, prev) : 0;
    const cls = wow>0.5?'up':wow<-0.5?'down':'flat';
    const wowTxt = prev? `<span class="delta ${cls}">${wow>=0?'+':''}${wow.toFixed(0)}%</span>` : '<span class="muted small">—</span>';
    tb.insertAdjacentHTML('beforeend', `<tr>
      <td title="${escapeHtml(p.text)}">${truncate(p.text,46)}</td>
      <td>${fmt(p.impr)}</td><td>${wowTxt}</td><td>${p.likes}</td><td>${p.replies}</td><td>${p.rt}</td><td>${er}</td>
    </tr>`);
  });
  if(!state.posts.length) tb.innerHTML = '<tr><td colspan="7" class="muted">No posts logged. Click "+ Log post".</td></tr>';
}

function renderCampaigns(){
  const tb = $('campBody'); tb.innerHTML='';
  state.campaigns.forEach(c=>{
    const cpl = c.leads? '$'+(c.spend/c.leads).toFixed(2) : '—';
    tb.insertAdjacentHTML('beforeend', `<tr>
      <td>${escapeHtml(c.name)}</td><td>$${c.spend}</td><td>${c.leads}</td><td>${cpl}</td>
      <td><span class="tag">${c.status}</span></td>
    </tr>`);
  });
  if(!state.campaigns.length) tb.innerHTML='<tr><td colspan="5" class="muted">No campaigns yet.</td></tr>';
}

function escapeHtml(s){ return s.replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
function truncate(s,n){ return s.length>n? s.slice(0,n-1)+'…' : s; }

/* ========= Add post ========= */
$('addPost').onclick = ()=>{
  const text = prompt('Post text?'); if(!text) return;
  const impr = +prompt('Impressions?')||0;
  const likes = +prompt('Likes?')||0;
  const replies = +prompt('Replies?')||0;
  const rt = +prompt('Retweets?')||0;
  state.posts.push({text,impr,likes,replies,rt});
  save(); renderPosts();
};

/* ========= Generators (template-based, no external API) ========= */
function p(){ return state.profile || {niche:'AI SaaS', stage:'Pre-seed', target:'Both', goal:'10k followers'}; }

/* =========================================================
   CONTENT ENGINE — full rebuild
   3 input modes · 5 platforms · 6 post types · history · voice
   ========================================================= */
function ceEsc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/* ── CE state ───────────────────────────────────────────────────────────── */
const CE_API = 'https://xgrowth-api.xgrowth.workers.dev';

// Image generation state
const _imgGen = { selectedUrl: '', selectedIdx: -1, seeds: [] };

// The 6 Pollinations models shown in the auto-grid (free, no key, client-side)
// Only confirmed valid model IDs from image.pollinations.ai
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
  inputMode: 'search',
  topic: '',
  article: null,
  platform: 'linkedin',
  postType: 'hot-take',
  threadMode: false,
  refineInstruction: '',
  posts: {},
  voice: { style: 'casual', niche: '' },
  history: [],
  historyOpen: false,
  _pickedAt: null,
  _articles: [],
};
['linkedin','x','threads','instagram','reddit'].forEach(p => {
  _ce.posts[p] = { text: '', loading: false, generated: false };
});

/* ── Input mode switching ─────────────────────────────────────────────── */

function ceSwitchInputMode(mode) {
  _ce.inputMode = mode;
  document.querySelectorAll('.ce-mode-tab').forEach(b => b.classList.toggle('active', b.dataset.cmode === mode));
  document.querySelectorAll('.ce-mode-panel').forEach(p => p.classList.remove('active'));
  const panelMap = { search:'ceModeSearch', url:'ceModeUrl', write:'ceModeWrite' };
  $(panelMap[mode])?.classList.add('active');
  if (mode !== 'search') $('ceNewsPanel').style.display = 'none';
}

/* ── Search news mode ─────────────────────────────────────────────────── */

function ceRelDate(iso){
  if(!iso) return 'recent';
  const d = new Date(iso), diff = (Date.now() - d.getTime()) / 1000;
  if(diff < 3600){ const h = Math.floor(diff/3600); return h===1?'1h ago':`${h}h ago`; }
  if(diff < 86400){ const dd = Math.floor(diff/86400); return dd===1?'1 day ago':`${dd} days ago`; }
  if(diff < 604800){ const w = Math.floor(diff/604800); return w===1?'1 week ago':`${w} weeks ago`; }
  return d.toLocaleDateString();
}
function ceDomainFromUrl(u){
  if(!u) return '';
  try { return new URL(u).hostname.replace(/^www\./,''); } catch { return ''; }
}
function ceTagFromHit(h){
  const p=h.points||0, c=h.num_comments||0;
  if(p>200) return 'Hot'; if(c>50) return 'Discussion'; return 'News';
}
function ceAngleFromHit(h){
  const c=h.num_comments||0, p=h.points||0;
  if(p>100&&c>50) return `Trending on Hacker News — ${p.toLocaleString()} points, ${c.toLocaleString()} comments.`;
  if(c>30) return `Sparking ${c.toLocaleString()} comments on Hacker News.`;
  if(p>50) return `${p} points on Hacker News. Early signal worth a take.`;
  return `Posted to Hacker News (${p} points, ${c} comments).`;
}

async function ceFetchLiveNews(topic){
  try {
    const oneYearAgo = Math.floor(Date.now()/1000) - 365*24*3600;
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(topic)}&tags=story&hitsPerPage=24&numericFilters=created_at_i>${oneYearAgo}`;
    const ctrl = new AbortController();
    const tid = setTimeout(()=>ctrl.abort(), 6000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(tid);
    if(!res.ok) return null;
    const data = await res.json();
    let hits = (data.hits||[]).filter(h => h.title && h.url && ((h.points||0)>=3||(h.num_comments||0)>=2));
    if(!hits.length) hits = (data.hits||[]).filter(h => h.title && h.url);
    hits = hits.slice(0,10);
    if(!hits.length) return null;
    return hits.map(h => ({
      tag: ceTagFromHit(h), source: ceDomainFromUrl(h.url)||'news.ycombinator.com',
      date: ceRelDate(h.created_at), title: h.title, angle: ceAngleFromHit(h),
      url: h.url||`https://news.ycombinator.com/item?id=${h.objectID}`
    }));
  } catch { return null; }
}

const CE_FALLBACK_ARTICLES = [
  { tag:'AI',      source:'Hacker News', date:'this week', title:'AI agents are eating the SaaS UI layer', angle:'Customers are asking for chat-first interfaces. The configure-it-yourself era is fading.' },
  { tag:'Growth',  source:'Lenny\'s',    date:'this week', title:'The activation metrics that actually predict retention at scale', angle:'What you measure in week 1 shapes your year-1 curve.' },
  { tag:'Pricing', source:'SaaStr',      date:'this week', title:'Usage-based pricing is now table stakes — flat per-seat is losing deals', angle:'Hybrid models are winning RFPs that pure subscription would lose.' },
  { tag:'Product', source:'Reforge',     date:'this week', title:'Habit loops are dead — here\'s what actually drives daily active use', angle:'The engagement playbook has changed since 2020.' },
  { tag:'GTM',     source:'First Round', date:'this week', title:'Founder-led content is outperforming brand-led content 5–10x', angle:'Audiences trust people, not logos.' },
];

async function ceSearchNews(){
  const topic = $('ceTopicInput')?.value?.trim();
  if(!topic){ toast('Type a topic first'); $('ceTopicInput')?.focus(); return; }
  const btn = $('ceSearchBtn');
  if(btn){ btn.disabled=true; btn.innerHTML='<span class="ce-spinner"></span>Searching…'; }

  let hits = await ceFetchLiveNews(topic);
  if(!hits) hits = CE_FALLBACK_ARTICLES;

  _ce.topic = topic;
  _ce.article = null; _ce._pickedAt = null;
  ['linkedin','x','threads','instagram','reddit'].forEach(p => { _ce.posts[p] = {text:'',loading:false,generated:false}; });

  const cap = topic.charAt(0).toUpperCase() + topic.slice(1);
  $('ceNewsTitle').textContent = `Latest: ${cap}`;
  $('ceNewsHelper').textContent = `${hits.length} articles — pick one to generate posts.`;

  _ce._articles = hits;
  $('ceTrends').innerHTML = hits.map((t,i) => `
    <button type="button" class="ce-trend" onclick="cePickArticle(${i})">
      <div class="ce-trend-meta">
        <span class="ce-tag">${ceEsc(t.tag||'News')}</span>
        <span class="ce-trend-source">${ceEsc(t.source||'')} · ${ceEsc(t.date||'')}</span>
      </div>
      <h4>${ceEsc(t.title)}</h4>
      <p>${ceEsc(t.angle)}</p>
      <div class="ce-trend-foot"><span class="ce-pick">Generate post →</span></div>
    </button>`).join('');

  $('ceNewsPanel').style.display = 'block';
  ceResetOutput();
  if(btn){ btn.disabled=false; btn.innerHTML='Search news →'; }
  if(window.innerWidth<=1100) $('ceNewsPanel')?.scrollIntoView({behavior:'smooth',block:'start'});
}

async function cePickArticle(idx){
  const t = _ce._articles[idx];
  if(!t) return;
  const pickedAt = Date.now();
  _ce._pickedAt = pickedAt; _ce.article = t; _ce.topic = _ce.topic || t.title;
  ['linkedin','x','threads','instagram','reddit'].forEach(p => { _ce.posts[p] = {text:'',loading:false,generated:false}; });
  $('ceTrendContext').innerHTML = `<h4>${ceEsc(t.title)}</h4><p>${ceEsc(t.angle)}</p>`;
  $('ceTrendContext').style.display = '';
  ceShowControls();
  ceGenerateCurrent(pickedAt);
  if(window.innerWidth<=1100) $('ceStep3')?.scrollIntoView({behavior:'smooth',block:'start'});
}

/* ── URL mode ─────────────────────────────────────────────────────────── */

async function ceFetchUrlPreview(){
  const url = $('ceUrlInput')?.value?.trim();
  if(!url||!url.startsWith('http')){ toast('Paste a valid URL first'); return; }
  const btn = $('ceUrlBtn');
  if(btn){ btn.disabled=true; btn.innerHTML='<span class="ce-spinner"></span>Fetching…'; }
  try {
    const data = await xgFetch('/preview', { url });
    if(data.title){ $('ceUrlTitle').value=data.title; $('ceUrlContext').value=data.description||''; }
    else toast('Could not extract title — enter it manually');
  } catch(e){ toast(e.message?.includes('Sign in') ? 'Sign in first' : 'Could not fetch — enter details manually'); }
  $('ceUrlPreview').style.display='block';
  if(btn){ btn.disabled=false; btn.innerHTML='Get article →'; }
}

async function ceGenerateFromUrl(){
  const title = $('ceUrlTitle')?.value?.trim();
  const context = $('ceUrlContext')?.value?.trim();
  if(!title){ toast('Enter the article title first'); $('ceUrlTitle')?.focus(); return; }
  _ce.topic = title; _ce.article = { title, angle:context||'', url:$('ceUrlInput')?.value?.trim()||'' };
  const pickedAt = Date.now(); _ce._pickedAt = pickedAt;
  ['linkedin','x','threads','instagram','reddit'].forEach(p => { _ce.posts[p] = {text:'',loading:false,generated:false}; });
  $('ceTrendContext').innerHTML = `<h4>${ceEsc(title)}</h4>${context?`<p>${ceEsc(context)}</p>`:''}`;
  $('ceTrendContext').style.display = '';
  ceShowControls(); ceGenerateCurrent(pickedAt);
}

/* ── Write mode ───────────────────────────────────────────────────────── */

async function ceGenerateFromWrite(){
  const notes = $('ceWriteInput')?.value?.trim();
  const topic = $('ceWriteTopic')?.value?.trim();
  if(!notes){ toast('Write something first'); $('ceWriteInput')?.focus(); return; }
  _ce.topic = topic||'startup insight';
  _ce.article = { title:notes, angle:'', url:'', inputMode:'freewrite' };
  const pickedAt = Date.now(); _ce._pickedAt = pickedAt;
  ['linkedin','x','threads','instagram','reddit'].forEach(p => { _ce.posts[p] = {text:'',loading:false,generated:false}; });
  $('ceTrendContext').style.display='none';
  ceShowControls(); ceGenerateCurrent(pickedAt);
}

/* ── Output controls ──────────────────────────────────────────────────── */

function ceShowControls(){
  $('ceTypeRow').style.display=''; $('cePlatformTabs').style.display=''; $('ceEmpty').style.display='none';
  const xRow = $('ceXModeRow');
  if(xRow) xRow.style.display = _ce.platform === 'x' ? '' : 'none';
}
function ceResetOutput(){
  $('ceTypeRow').style.display='none'; $('cePlatformTabs').style.display='none';
  const xRow = $('ceXModeRow'); if(xRow) xRow.style.display='none';
  $('ceTrendContext').style.display='none'; $('ceEmpty').style.display=''; $('ceGenerated').innerHTML='';
  ['linkedin','x','threads','instagram','reddit'].forEach(p => { _ce.posts[p] = {text:'',loading:false,generated:false}; });
  _ce.threadMode = false;
  document.querySelectorAll('.ce-xmode-btn').forEach(b => b.classList.toggle('active', b.dataset.xmode==='single'));
}

/* ── Platform + type switching ────────────────────────────────────────── */

function ceSwitchPlatform(platform){
  _ce.platform = platform;
  document.querySelectorAll('.ce-plat-tab').forEach(b => b.classList.toggle('active', b.dataset.plat===platform));
  // Show Single/Thread toggle only on X
  const xRow = $('ceXModeRow');
  if(xRow) xRow.style.display = platform === 'x' ? '' : 'none';
  // Reset thread mode when leaving X
  if(platform !== 'x' && _ce.threadMode){
    _ce.threadMode = false;
    document.querySelectorAll('.ce-xmode-btn').forEach(b => b.classList.toggle('active', b.dataset.xmode === 'single'));
  }
  if(_ce.article && !_ce.posts[platform].generated && !_ce.posts[platform].loading){
    ceGenerateCurrent(_ce._pickedAt);
  } else { ceRenderCurrentPost(); }
}

function ceSetXMode(mode){
  const isThread = mode === 'thread';
  if(_ce.threadMode === isThread) return;
  _ce.threadMode = isThread;
  document.querySelectorAll('.ce-xmode-btn').forEach(b => b.classList.toggle('active', b.dataset.xmode === mode));
  // Clear cached post and regenerate
  if(_ce.article){
    _ce.posts['x'] = { text: '', loading: false, generated: false };
    ceGenerateCurrent(_ce._pickedAt);
  }
}

function ceSetType(type){
  _ce.postType = type;
  _ce.refineInstruction = ''; // clear any active refine nudge
  document.querySelectorAll('.ce-type-chip').forEach(b => b.classList.toggle('active', b.dataset.type===type));
  if(_ce.article){
    _ce.posts[_ce.platform] = {text:'',loading:false,generated:false};
    ceGenerateCurrent(_ce._pickedAt);
  }
}

/* ── Post generation ──────────────────────────────────────────────────── */

async function ceGenerateCurrent(pickedAt){
  const platform = _ce.platform, article = _ce.article;
  if(!article) return;
  _ce.posts[platform].loading=true; _ce.posts[platform].generated=false;
  ceRenderCurrentPost();

  const text = await ceCallAPI(platform, article, _ce.postType);
  if(_ce._pickedAt !== pickedAt) return; // race guard

  _ce.posts[platform].text=text; _ce.posts[platform].loading=false; _ce.posts[platform].generated=true;
  ceRenderCurrentPost();
  ceSaveToHistory(platform, text, _ce.postType, article);
}

async function ceCallAPI(platform, article, type){
  try {
    const mode = (platform === 'x' && _ce.threadMode) ? 'thread' : type;
    const payload = {
      kind: 'post',
      topic: _ce.topic, articleTitle: article.title, articleAngle: article.angle||'',
      platform, mode, voiceNiche: _ce.voice.niche||'', voiceStyle: _ce.voice.style||'casual',
      inputMode: article.inputMode||'search',
    };
    if(_ce.refineInstruction) payload.refineInstruction = _ce.refineInstruction;
    const data = await xgFetch('/generate', payload);
    return data.text || ceFallback(platform,article);
  } catch(e){ console.warn('CE API error',e); return ceFallback(platform,article); }
}

// Regenerate current platform's post (optionally with a refine instruction)
function ceRegenerate(instruction){
  _ce.refineInstruction = instruction || '';
  _ce.posts[_ce.platform] = { text:'', loading:false, generated:false };
  ceGenerateCurrent(_ce._pickedAt);
}

// Clear refine instruction and regenerate fresh
function ceRegenerateFresh(){
  ceRegenerate('');
}

function ceFallback(platform, article){
  const title = article?.title||'Worth a read.';
  if(platform==='x') return title.slice(0,277)+(title.length>277?'…':'');
  if(platform==='threads') return title.slice(0,497)+(title.length>497?'…':'');
  if(platform==='instagram') return `CAPTION:\n${title.slice(0,240)}\n\nHASHTAGS:\n#startup #saas #founder #buildinpublic #indiehacker #productlaunch #b2b #growthmarketing #startuplife #solofounder #makersgonnamake #sideproject #bootstrapped #indiemaker #techstartup`;
  if(platform==='reddit') return `SUBREDDIT: r/startups\n\nTITLE: ${title.slice(0,190)}\n\nBODY:\nSharing this because it sparked a real reaction. Curious what others are seeing in this space.`;
  return title;
}

/* ── Rendering ────────────────────────────────────────────────────────── */

const CE_PLAT_INFO = {
  linkedin:  { label:'LinkedIn',  limit:3000,  svg:`<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14zM8.5 17V10h-2v7h2zm-1-7.9a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2zM18 17v-3.9c0-2.1-1.1-3.1-2.6-3.1-1.2 0-1.7.7-2 1.2V10h-2v7h2v-4c0-1 .2-2 1.4-2s1.2 1.1 1.2 2v4H18z"/></svg>` },
  x:         { label:'X / Twitter',limit:280,  svg:`<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2H21.5l-7.36 8.41L23 22h-6.84l-5.21-6.81L4.91 22H1.65l7.86-8.98L1.5 2h6.99l4.71 6.23L18.244 2z"/></svg>` },
  threads:   { label:'Threads',    limit:500,  svg:`<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.473 12.01v-.017c.027-3.579.877-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-.505-1.865-1.406-3.348-2.67-4.29-1.283-.963-2.95-1.467-5.07-1.482-2.678.02-4.758.853-6.184 2.476-1.406 1.6-2.124 3.958-2.145 7.011.021 3.054.739 5.41 2.145 7.012 1.426 1.622 3.506 2.455 6.184 2.474 1.996-.015 3.491-.438 4.651-1.298.952-.708 1.673-1.72 2.145-3.003l2.03.618c-.627 1.626-1.564 2.914-2.8 3.832-1.454 1.052-3.289 1.6-5.588 1.617z"/></svg>` },
  instagram: { label:'Instagram',  limit:2200, svg:`<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"/></svg>` },
  reddit:    { label:'Reddit',     limit:null, svg:`<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z"/></svg>` },
};

function ceRenderCurrentPost(){
  const p = _ce.posts[_ce.platform];
  $('ceGenerated').innerHTML = cePostCard(_ce.platform, p.loading, p.text||'');
}

function cePostCard(platform, loading, text){
  const info = CE_PLAT_INFO[platform]||CE_PLAT_INFO.linkedin;
  if(loading) return `<div class="ce-post"><div class="ce-post-head"><span class="ce-post-platform">${info.svg} ${info.label}</span><span class="ce-ai-badge">AI</span></div><div class="ce-skeleton"><span class="ce-spinner"></span>Writing your ${info.label} post…</div></div>`;
  if(!text) return `<div class="ce-post"><div class="ce-post-head"><span class="ce-post-platform">${info.svg} ${info.label}</span><span class="ce-ai-badge">AI</span></div><div class="ce-skeleton" style="opacity:.5">Ready to generate</div></div>`;

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
    <div class="ce-post-foot"><span class="ce-count">${text.length} chars</span><div class="ce-post-actions"><button class="btn ghost" data-ce-copy="${ceEsc(text)}" onclick="ceCopyAttr(this)">Copy all</button><a class="btn publish" href="https://www.instagram.com/" target="_blank" rel="noopener noreferrer">Open Instagram ↗</a></div></div>
    ${ceRefineBar()}</div>`;
  }

  // X thread rendering — detect thread format (2+ numbered chunks)
  if(platform==='x' && _ce.threadMode){
    const tweets = ceParseThread(text);
    if(tweets.length >= 2) return ceThreadCard(tweets);
    // Fall through to single-tweet renderer if parsing failed
  }

  if(platform==='reddit'){
    const {subreddit, title, body} = ceParseReddit(text);
    return `<div class="ce-post" data-platform="reddit"><div class="ce-post-head"><span class="ce-post-platform">${info.svg} ${info.label}</span><span class="ce-ai-badge">AI</span></div>
    <div class="ce-reddit">
      ${subreddit?`<div class="ce-reddit-section"><label>Suggested subreddit</label><p>${ceEsc(subreddit)}</p><button class="btn ghost" style="height:28px;padding:0 10px;font-size:12px;margin-top:8px" data-ce-copy="${ceEsc(subreddit)}" onclick="ceCopyAttr(this)">Copy</button></div>`:''}
      ${title?`<div class="ce-reddit-section"><label>Post title</label><p>${ceEsc(title)}</p><button class="btn ghost" style="height:28px;padding:0 10px;font-size:12px;margin-top:8px" data-ce-copy="${ceEsc(title)}" onclick="ceCopyAttr(this)">Copy title</button></div>`:''}
      ${body?`<div class="ce-reddit-section"><label>Post body</label><p class="ce-post-text" style="font-size:14px">${ceEsc(body)}</p><button class="btn ghost" style="height:28px;padding:0 10px;font-size:12px;margin-top:8px" data-ce-copy="${ceEsc(body)}" onclick="ceCopyAttr(this)">Copy body</button></div>`:''}
    </div>
    <div class="ce-post-foot"><span class="ce-count">${text.length} chars</span><div class="ce-post-actions"><button class="btn ghost" data-ce-copy="${ceEsc(text)}" onclick="ceCopyAttr(this)">Copy all</button><a class="btn publish" href="https://www.reddit.com/submit" target="_blank" rel="noopener noreferrer">Post on Reddit ↗</a></div></div>
    ${ceRefineBar()}</div>`;
  }

  const limit = info.limit, len = text.length;
  const postUrl = {
    linkedin: `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text.slice(0,1300))}`,
    x:        `https://twitter.com/intent/tweet?text=${encodeURIComponent(text.slice(0,280))}`,
    threads:  `https://www.threads.net/intent/post?text=${encodeURIComponent(text.slice(0,500))}`,
  }[platform]||'#';

  return `<div class="ce-post" data-platform="${platform}"><div class="ce-post-head"><span class="ce-post-platform">${info.svg} ${info.label}</span><span class="ce-ai-badge">AI</span></div>
  <p class="ce-post-text">${ceEsc(text)}</p>
  <div class="ce-post-foot"><span class="ce-count ${limit&&len>limit?'over':''}">${len}${limit?'/'+limit:''} chars</span><div class="ce-post-actions"><button class="btn ghost" data-ce-copy="${ceEsc(text)}" onclick="ceCopyAttr(this)">Copy</button><a class="btn publish" href="${postUrl}" target="_blank" rel="noopener noreferrer">Post on ${info.label} ↗</a></div></div>
  ${ceRefineBar()}</div>`;
}

/* ── Parsers ──────────────────────────────────────────────────────────── */

const CE_REFINE_CHIPS = [
  { label:'Shorter',           instruction:'Make it noticeably shorter. Cut every word that doesn\'t earn its place.' },
  { label:'Punchier hook',     instruction:'Rewrite with a stronger, more arresting opening line. Hook within the first 6 words.' },
  { label:'Add a story',       instruction:'Reframe as a short personal narrative: setup, tension, resolution. First person.' },
  { label:'Lead with data',    instruction:'Open with the most concrete number or stat. Anchor the whole post around it.' },
  { label:'More casual',       instruction:'Make the tone conversational, like texting a smart friend. Loosen the register.' },
];

function ceRefineBar(){
  const chips = CE_REFINE_CHIPS.map(c =>
    `<button class="ce-refine-chip" onclick="ceRegenerate(${JSON.stringify(c.instruction)})">${c.label}</button>`
  ).join('');
  return `<div class="ce-refine-bar">
    <button class="ce-regen-btn" onclick="ceRegenerateFresh()" title="New variation">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
      Regenerate
    </button>
    <div class="ce-refine-chips">${chips}</div>
  </div>`;
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
  const cm = text.match(/CAPTION:\s*([\s\S]+?)(?:\n\n+HASHTAGS:|$)/i);
  const hm = text.match(/HASHTAGS:\s*([\s\S]+?)$/i);
  if(cm||hm) return { caption:(cm?.[1]||'').trim(), hashtags:(hm?.[1]||'').trim() };
  const lines = text.split('\n');
  const hi = lines.findIndex(l=>(l.match(/#\w+/g)||[]).length>=5);
  if(hi>0) return { caption:lines.slice(0,hi).join('\n').trim(), hashtags:lines.slice(hi).join('\n').trim() };
  return { caption:text, hashtags:'' };
}

function ceParseReddit(text){
  return {
    subreddit: (text.match(/SUBREDDIT:\s*(.+)/i)?.[1]||'').trim(),
    title:     (text.match(/TITLE:\s*(.+)/i)?.[1]||'').trim(),
    body:      (text.match(/BODY:\s*([\s\S]+?)$/i)?.[1]||'').trim(),
  };
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
  } catch(e){ console.warn('History save',e); }
}

async function ceLoadHistory(){
  if(!fbAuth.currentUser) return;
  try {
    const snap = await db.collection('users').doc(fbAuth.currentUser.uid)
      .collection('ceHistory').orderBy('createdAt','desc').limit(20).get();
    _ce.history = snap.docs.map(d=>({id:d.id,...d.data()}));
    ceRenderHistoryBadge();
    if(_ce.historyOpen) ceRenderHistoryList();
  } catch(e){ console.warn('History load',e); }
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
  if(_ce.historyOpen) ceRenderHistoryList();
}

function ceRenderHistoryList(){
  const list=$('ceHistoryList'); if(!list) return;
  const LABELS={linkedin:'LinkedIn',x:'X',threads:'Threads',instagram:'Instagram',reddit:'Reddit'};
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

/* ── Voice settings ───────────────────────────────────────────────────── */

function ceVoiceOpen(){
  $('ceVoiceOverlay').classList.add('show');
  $('ceVoiceNiche').value=_ce.voice.niche||'';
  document.querySelectorAll('.ce-voice-style-btn').forEach(b=>b.classList.toggle('active',b.dataset.vstyle===(_ce.voice.style||'casual')));
}
function ceVoiceClose(){ $('ceVoiceOverlay').classList.remove('show'); }
function ceVoiceSetStyle(style){
  _ce.voice.style=style;
  document.querySelectorAll('.ce-voice-style-btn').forEach(b=>b.classList.toggle('active',b.dataset.vstyle===style));
}
async function ceVoiceSave(){
  _ce.voice.niche=($('ceVoiceNiche')?.value||'').trim();
  if(fbAuth.currentUser){
    try{
      await db.collection('users').doc(fbAuth.currentUser.uid).collection('prefs').doc('ceVoice').set({style:_ce.voice.style,niche:_ce.voice.niche});
      toast('Voice saved');
    }catch{ toast('Saved locally'); }
  } else { toast('Voice saved (sign in to sync)'); }
  ceVoiceClose();
}
async function ceLoadVoice(){
  if(!fbAuth.currentUser) return;
  try{
    const doc=await db.collection('users').doc(fbAuth.currentUser.uid).collection('prefs').doc('ceVoice').get();
    if(doc.exists){ const d=doc.data(); _ce.voice.style=d.style||'casual'; _ce.voice.niche=d.niche||''; }
  }catch(e){ console.warn('Voice load',e); }
}

function ceInit(){ ceLoadHistory(); ceLoadVoice(); }

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

/* Fire all 6 in parallel with fresh seeds */
async function ceImgGenerate(){
  const prompt = ($('ceImgPromptInput')?.value || '').trim();
  if(!prompt){ toast('Enter a prompt first'); return; }

  _imgGen.seeds   = IMGGEN_GRID_MODELS.map(() => Math.floor(Math.random() * 1e9));
  _imgGen.selectedUrl = '';
  _imgGen.selectedIdx = -1;
  $('ceImgDownloadBtn').disabled = true;
  $('ceImgGenBtn').disabled = true;
  ceImgRenderGrid('loading');

  await Promise.allSettled(IMGGEN_GRID_MODELS.map((m, i) => ceImgLoadOne(prompt, m, i)));
  $('ceImgGenBtn').disabled = false;
}

/* Load one image via the Worker proxy and update its cell.
   Previously used new Image() pointing directly at image.pollinations.ai, but
   ad-blockers / privacy extensions block third-party image CDN domains in the
   browser, causing onerror on every cell.  Routing through the Worker makes the
   request server-to-server; the browser only sees a data: URL which is never
   intercepted by extensions. */
async function ceImgLoadOne(prompt, model, idx){
  const seed = _imgGen.seeds[idx] || Math.floor(Math.random() * 1e9);
  try {
    const data = await xgFetch('/generate-image', {
      prompt,
      provider: 'pollinations',
      model:    model.id,
      seed,
    });
    if(!data.imageData) throw new Error('No image data returned');
    const dataUrl = `data:${data.mimeType || 'image/jpeg'};base64,${data.imageData}`;

    const cell = $(`imgCell${idx}`);
    if(!cell || !cell.classList.contains('loading')) return dataUrl; // replaced by a retry
    cell.className   = 'imggen-cell done';
    cell.dataset.url = dataUrl;
    cell.innerHTML   = `
      <img src="${dataUrl}" alt="${model.label}">
      <div class="imggen-label"><strong>${model.label}</strong><span>${model.tag}</span></div>`;
    return dataUrl;
  } catch(e) {
    const cell = $(`imgCell${idx}`);
    if(!cell || !cell.classList.contains('loading')) return; // replaced by a retry
    cell.className = 'imggen-cell error';
    cell.innerHTML = `
      <div class="imggen-status">
        <span style="font-size:24px;opacity:.3">✕</span>
        <span class="imggen-status-lbl">${model.label}</span>
        <button class="btn ghost" style="height:26px;padding:0 10px;font-size:11px;margin-top:6px"
          onclick="event.stopPropagation();ceImgRetryOne(${idx})">Retry</button>
      </div>`;
    throw e;
  }
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
   Images now arrive as data: URLs (base64 from the Worker), so we convert the
   data URL directly to a Blob rather than fetching an external URL. */
async function ceImgDownload(){
  if(!_imgGen.selectedUrl){ toast('Tap an image to select it first'); return; }
  try {
    let blob;
    if(_imgGen.selectedUrl.startsWith('data:')){
      // data:<mime>;base64,<b64data>
      const [header, b64] = _imgGen.selectedUrl.split(',');
      const mime  = header.match(/:(.*?);/)?.[1] || 'image/jpeg';
      const bytes = atob(b64);
      const arr   = new Uint8Array(bytes.length);
      for(let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      blob = new Blob([arr], { type: mime });
    } else {
      const resp = await fetch(_imgGen.selectedUrl);
      blob = await resp.blob();
    }
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `xgrowth-insta-${Date.now()}.jpg`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch {
    toast('Download failed — right-click the image and Save As');
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

// Enter-to-trigger for search + URL inputs
document.addEventListener('keydown',(e)=>{
  if(e.key!=='Enter') return;
  const id=document.activeElement?.id;
  if(id==='ceTopicInput'){ e.preventDefault(); ceSearchNews(); }
  else if(id==='ceUrlInput'){ e.preventDefault(); ceFetchUrlPreview(); }
});

/* ── Old CE_TREND_BANK kept only as named const (no longer used for display) ── */
const CE_TREND_BANK = {
  ai: [
    { tag:'Models',     source:'The Information',    date:'2 days ago',  title:"Anthropic's Claude 4 ships with longer context — what changes for product teams", angle:"Longer context windows + better tool use are quietly making real agent products viable in production for the first time." },
    { tag:'Open source', source:'Latent Space',       date:'3 days ago',  title:"Open-source LLMs are closing the gap on Anthropic and OpenAI",           angle:"Llama 4 + Mistral results show parity on specific tasks. Teams are routing 30-40% of traffic to open models for cost." },
    { tag:'Dev tools',  source:'Pragmatic Engineer', date:'4 days ago',  title:"Cursor crosses $100M ARR in 12 months — AI-native dev tools have momentum", angle:"What the Cursor curve tells founders building AI-first products: distribution + DX is the moat." },
    { tag:'Tooling',    source:'TechCrunch',         date:'5 days ago',  title:"Eval infrastructure is the new dev-tools gold rush",                    angle:"Braintrust, Langfuse, Helicone — every serious AI team is either buying or building one in-house." },
    { tag:'Product',    source:'Stratechery',        date:'6 days ago',  title:"AI agents are eating the SaaS UI layer",                                angle:"Customers are asking for chat-first interfaces instead of dashboards. The 'configure-it-yourself' era is fading fast." },
    { tag:'Pricing',    source:'Ben\'s Bites',        date:'this week',   title:"Inference costs drop 80% YoY — what's possible at the new price point", angle:"Features that were uneconomic 12 months ago are now sub-cent-per-call. Re-run the business case on your AI features." },
    { tag:'Voice AI',   source:'The Information',    date:'this week',   title:"Voice AI is the sleeper category — Sesame, ElevenLabs, Bland.ai all raising", angle:"After 18 months of text being the story, voice is suddenly where the breakouts are happening." },
    { tag:'GTM',        source:'First Round Review', date:'last week',   title:"Enterprise AI procurement is collapsing to 30-day pilots",              angle:"Long sales cycles are dying. Show-it-now wins more deals than 6-week decks ever did." },
    { tag:'Hiring',     source:'Lenny\'s Newsletter', date:'last week',   title:"AI-native engineers expect 2-3x their last salary",                    angle:"Founders are choosing between fewer senior hires or building a leverage-heavy stack. Both work — picking one matters." },
    { tag:'Caution',    source:'Hugging Face Blog',  date:'last week',   title:"Fine-tuning is quietly back, post-RAG fatigue",                         angle:"RAG hit its limits on narrow domains. Specialized small models are winning where context retrieval was failing." }
  ],
  saas: [
    { tag:'AI agents',  source:'Lenny\'s Newsletter', date:'2 days ago',  title:"Notion, Linear, Airtable all add AI agents — what's the table-stakes feature now?", angle:"AI inside SaaS shifted from differentiator to baseline in 6 months. Founders need to redraw the moat." },
    { tag:'Pricing',    source:'SaaStr',             date:'3 days ago',  title:"Usage-based pricing is now table stakes — flat per-seat is losing deals", angle:"Hybrid models (base + usage) are winning RFPs that pure subscription would lose this year." },
    { tag:'Valuation',  source:'SaaStr',             date:'4 days ago',  title:"SaaS valuations finally rebound after 18-month flat line",              angle:"Multiples are climbing for real-growth companies. Bottoming-out chatter looks correct in hindsight." },
    { tag:'PLG',        source:'First Round Review', date:'5 days ago',  title:"PLG plateaus around $5M ARR — what's after self-serve?",                angle:"Teams that nailed product-led acquisition are now hiring their first outbound reps. The playbook is shifting." },
    { tag:'AI',         source:'The Information',    date:'5 days ago',  title:"Salesforce's $500M Agentforce pricing reset is a signal for everyone",  angle:"When the incumbent re-prices AI features, every vertical SaaS has to ask: how do we charge for ours?" },
    { tag:'Market',     source:'TechCrunch',         date:'this week',   title:"Vertical SaaS keeps minting unicorns quietly",                          angle:"Industry-specific tools are outpacing horizontal players in ACV and retention. The 'TAM has to be huge' thesis is fading." },
    { tag:'Open source', source:'TechCrunch',         date:'this week',   title:"Open-source SaaS alternatives are growing 2x faster than incumbents",   angle:"PostHog, Cal.com, Supabase pattern is now repeatable. Bottoms-up dev adoption is the new B2B funnel." },
    { tag:'Strategy',   source:'Pavilion',           date:'last week',   title:"Bundling is back — single SKU, multiple products",                      angle:"After unbundling fatigue, customers want one bill, one login, one vendor relationship. Watch for consolidation plays." },
    { tag:'AI',         source:'SaaStr',             date:'last week',   title:"AI features inside SaaS aren't moving renewals yet",                    angle:"Adoption is high. Retention impact is mixed. Early data suggests it's the wrong moat to bet on." },
    { tag:'CX',         source:'First Round Review', date:'last week',   title:"Onboarding is the new pricing page",                                    angle:"First 10 minutes decide LTV more than any landing-page tweak. Yet onboarding is still underinvested at most companies." }
  ],
  retail: [
    { tag:'Big box',    source:'Modern Retail',      date:'2 days ago',  title:"Costco hits $300B revenue — bulk + private label still winning",       angle:"In a discount-driven environment, Costco's playbook is the one independent brands should be studying." },
    { tag:'Channels',   source:'Retail Dive',        date:'3 days ago',  title:"Walmart+ surpasses Amazon Prime in same-day delivery satisfaction",    angle:"Logistics moats are flipping. Smaller brands need to pick a horse — or build last-mile themselves." },
    { tag:'Behavior',   source:'Glossy',             date:'4 days ago',  title:"Live-shopping is finally taking off in the US",                         angle:"What worked in China for 5 years is now hitting US conversion benchmarks. Early movers are getting outsized reach." },
    { tag:'Showrooms',  source:'Glossy',             date:'5 days ago',  title:"Brick-and-mortar showrooming is getting weird — Apple Store playbook for indie brands", angle:"Retail-as-marketing is back. The store doesn't have to sell — it has to be memorable." },
    { tag:'M&A',        source:'Modern Retail',      date:'6 days ago',  title:"DTC brand consolidation is accelerating",                               angle:"Tighter ad performance is forcing solo brands into PE roll-ups. Independent operators have a 12-month window." },
    { tag:'Pricing',    source:'AdAge',              date:'this week',   title:"Subscription fatigue is hitting CPG brands hardest",                    angle:"Churn on monthly box products is at 5-year highs. The 'subscribe & save' model needs a refresh." },
    { tag:'Forecast',   source:'eMarketer',          date:'this week',   title:"Holiday shopping forecast: discount-driven, but premium brands holding margin", angle:"The bifurcation is real — value brands compete on price, premium brands hold pricing through scarcity." },
    { tag:'Margins',    source:'Retail Dive',        date:'this week',   title:"Returns are eating 30% of e-comm margin — solving this is gold",        angle:"Try-before-you-buy, AI sizing, and packaging redesigns are showing measurable margin wins." },
    { tag:'Brand',      source:'Modern Retail',      date:'last week',   title:"In-person pop-ups out-converting paid social",                          angle:"DTC-first brands are renting physical space again. CAC is lower than Meta ads for many categories." },
    { tag:'Tech',       source:'AdAge',              date:'last week',   title:"AI-driven product photography is replacing studio shoots",              angle:"Brands are saving 60-80% on photo costs and shipping new SKUs to site in days, not weeks." }
  ],
  fintech: [
    { tag:'Payments',   source:'The Information',    date:'2 days ago',  title:"Stripe quietly grew to $1T processed — what's next after payments?",    angle:"Stripe's expansion into financial infrastructure (Issuing, Tax, Capital) is the playbook for every vertical fintech." },
    { tag:'Credit',     source:'Fintech Business Weekly', date:'3 days ago', title:"Mercury, Brex pull back on credit lines as default rates climb",   angle:"The SMB credit market is repricing. Founders relying on revenue-based financing need to re-plan." },
    { tag:'IPOs',       source:'Bloomberg',          date:'4 days ago',  title:"Plaid IPO chatter resurfaces — what it means for the open banking stack", angle:"A Plaid public listing would set the comp for every embedded-finance company. Watch the data-access narrative." },
    { tag:'Regulation', source:'Banking Dive',       date:'5 days ago',  title:"BaaS shake-up: banking partners are getting selective",                 angle:"Synapse-era fallout means smaller fintechs need to prove compliance maturity before partnering. Sponsor banks are slow-rolling new accounts." },
    { tag:'Product',    source:'The Block',          date:'6 days ago',  title:"Robinhood adds private investing — wealth management is the new product wedge", angle:"The brokerage-to-wealth-platform transition is the obvious play for every consumer fintech with users." },
    { tag:'Embedded',   source:'Fintech Today',      date:'this week',   title:"Embedded finance is moving from feature to category",                   angle:"Vertical SaaS players are launching their own cards, accounts, and credit lines. The build-vs-buy moment is now." },
    { tag:'AI',         source:'TechCrunch',         date:'this week',   title:"Underwriting on bank-statement data is eating FICO for SMB",            angle:"For SMB lending especially, alternative data is outperforming traditional credit bureau scoring on default rates." },
    { tag:'B2B',        source:'Fintech Today',      date:'this week',   title:"Treasury management is the next obvious SaaS wedge",                    angle:"Mid-market CFOs are stitching together 5+ tools for cash management. One unified play could win this fast." },
    { tag:'UX',         source:'Banking Dive',       date:'last week',   title:"Consumer banking apps are removing features, not adding",               angle:"After years of feature creep, the new wave is 'three buttons and a balance.' Simplicity is winning." },
    { tag:'Compliance', source:'Fintech Business Weekly', date:'last week', title:"KYC/KYB automation is the unsexy moat that's actually working",     angle:"Onboarding flows that take 2 minutes instead of 2 days are converting 3x better." }
  ],
  healthcare: [
    { tag:'Pharma',     source:'STAT News',          date:'2 days ago',  title:"Mark Cuban's Cost Plus Drug crosses 1M prescriptions/month — generic distribution disrupted", angle:"Direct-to-consumer pharma is now a real channel, not a stunt. Incumbents are scrambling." },
    { tag:'Operations', source:'Becker\'s',          date:'3 days ago',  title:"Hospital staffing crisis sparks 30% YoY growth in AI scheduling tools", angle:"The operational layer is where AI is paying off in healthcare — not clinical decision support." },
    { tag:'AI',         source:'STAT News',          date:'4 days ago',  title:"AI scribes are now baseline expectation, not differentiator",           angle:"Clinicians who used to be skeptical are now asking why one isn't running by default. Adoption is steeper than EHRs ever were." },
    { tag:'Pharma',     source:'Rock Health',        date:'5 days ago',  title:"GLP-1s expanding beyond weight loss — cardiovascular trials reshape pharma", angle:"The downstream effects of GLP-1 success will reshape pharma-adjacent businesses for years." },
    { tag:'Consolidation', source:'Becker\'s',       date:'6 days ago',  title:"Independent practices are consolidating faster than ever",              angle:"Solo and small-group practices are joining MSOs or selling to PE. Tech needs to serve the buyer, not the legacy seller." },
    { tag:'Payment',    source:'Fierce Healthcare',  date:'this week',   title:"Direct-pay and cash-only practices are growing 25% YoY",                angle:"Patients fed up with insurance friction are paying out-of-pocket for primary care and specialty. New billing models needed." },
    { tag:'Membership', source:'Fierce Healthcare',  date:'this week',   title:"Direct primary care membership models hit 2.5M patients — insurance-light is sustainable", angle:"The subscription-medicine thesis just got real numbers. Watch this category." },
    { tag:'B2B',        source:'Rock Health',        date:'this week',   title:"Payers are buying tech, not licensing it anymore",                       angle:"UnitedHealth, Cigna, and the Blues are acquiring point solutions instead of subscribing. Exit math has changed." },
    { tag:'Patient',    source:'STAT News',          date:'last week',   title:"Patient-facing tools are losing to clinician-facing tools",              angle:"The ROI proof is faster when you save a clinician 30 minutes a day than when you save a patient a phone call." },
    { tag:'Cost',       source:'Becker\'s',          date:'last week',   title:"Telehealth-only companies are becoming hybrid by necessity",            angle:"Pure-virtual specialty care is losing reimbursement battles. The winners now run brick-and-mortar + virtual." }
  ],
  marketing: [
    { tag:'LinkedIn',   source:'Marketing Brew',     date:'2 days ago',  title:"LinkedIn engagement up 40% YoY — text posts beating video for B2B",     angle:"The platform is having a moment. Founders who haven't published in a year are getting outsized reach for showing up now." },
    { tag:'Channels',   source:'AdAge',              date:'3 days ago',  title:"Reddit ad inventory selling out — the platform's moment in the sun",    angle:"Brand safety + community trust + IPO momentum = Reddit ads suddenly working for categories that ignored it for years." },
    { tag:'Email',      source:'AdWeek',             date:'4 days ago',  title:"Email open rates rebound after Apple Mail privacy reset",                angle:"The data is finally credible again. Founders who paused email investment have a window to re-engage." },
    { tag:'AI',         source:'Stratechery',        date:'5 days ago',  title:"ChatGPT search referral traffic is showing up in analytics — get ready for AEO", angle:"Answer-engine optimization is the new SEO. Early adopters are seeing real signal in GA4." },
    { tag:'Cost',       source:'MarketingDive',      date:'6 days ago',  title:"Paid social CACs are up 40% YoY — organic is back in fashion",           angle:"Founders are rebuilding distribution muscles they outsourced to Meta. Newsletter and SEO budgets are climbing." },
    { tag:'AI',         source:'AdWeek',             date:'this week',   title:"Generative AI is flooding LinkedIn — original posts now stand out",     angle:"The bar for what counts as a 'thought leader' post has dropped, which means actual original takes get disproportionate reach." },
    { tag:'Format',     source:'Marketing Brew',     date:'this week',   title:"Long-form is winning again, even on short-form platforms",              angle:"X threads, 90-second TikToks, and 1500-word LinkedIn essays are outperforming punchy hot takes." },
    { tag:'Attribution', source:'AdAge',              date:'this week',   title:"Self-reported attribution is replacing pixel tracking",                  angle:"With iOS privacy + cookieless browsers, 'how did you hear about us?' is back as a primary signal." },
    { tag:'Agencies',   source:'AdWeek',             date:'last week',   title:"Agencies are switching from retainers to performance fees",              angle:"Clients want skin in the game. Hybrid models (base + win share) are out-converting traditional billing." },
    { tag:'Founders',   source:'Marketing Brew',     date:'last week',   title:"Founder-led content is outperforming brand-led content 5-10x",          angle:"Audiences trust people, not logos. Even bigger companies are putting CEOs and engineers on camera." }
  ],
  ecommerce: [
    { tag:'Channels',   source:'Modern Retail',      date:'2 days ago',  title:"Amazon Buy with Prime expands to Shopify — what it does to the off-Amazon brand strategy", angle:"Brands have to decide: lean in for trust + traffic, or stay independent and own the customer relationship." },
    { tag:'BNPL',       source:'Bloomberg',          date:'3 days ago',  title:"Klarna IPO refile — BNPL is mainstream but margins are tight",          angle:"Even the BNPL leader is going public into a tougher environment. What this signals for embedded checkout." },
    { tag:'Channels',   source:'Modern Retail',      date:'4 days ago',  title:"TikTok Shop is no longer experimental — it's a category leader",        angle:"Brands hitting $1M+/mo on TikTok Shop are running playbooks Amazon sellers ran in 2018. The window is closing." },
    { tag:'Cost',       source:'eMarketer',          date:'5 days ago',  title:"Shein and Temu ad spend slows — chase for new customers gets expensive", angle:"The cheap-import giants are pulling back on US ad spend. Could be a softening signal across the entire DTC ad market." },
    { tag:'M&A',        source:'Modern Retail',      date:'6 days ago',  title:"DTC brand exits are quietly active — strategic buyers paying again",     angle:"After 2 years of zero deal flow, the M&A market for $5-50M DTC brands is suddenly back open." },
    { tag:'Margin',     source:'eMarketer',          date:'this week',   title:"Free shipping thresholds are quietly dying",                              angle:"Customers expect free regardless. Brands are building it into product price instead of as a 'reward.'" },
    { tag:'Tech',       source:'RetailWire',         date:'this week',   title:"Shopify apps are eating Magento — and now Shopify Plus's lunch",         angle:"Apps that were 'nice to have' are now critical infrastructure. The mid-market is upgrading their stack quietly." },
    { tag:'AI',         source:'eMarketer',          date:'this week',   title:"Personalized product feeds are converting 2-3x the static grid",        angle:"Algorithmic merchandising is mainstream. If your category page is still chronological, you're leaving money on the table." },
    { tag:'Retention',  source:'Modern Retail',      date:'last week',   title:"Loyalty programs are losing to memberships",                              angle:"'Earn points' is yesterday. 'Pay $X/yr for member perks' is converting better and locking in repeat purchase." },
    { tag:'Returns',    source:'RetailWire',         date:'last week',   title:"Charging for returns is becoming acceptable — and margin-positive",      angle:"Customers are surprisingly tolerant when reasons are clear. Return abuse is down, margins are up." }
  ],
  realestate: [
    { tag:'Rates',      source:'Inman',              date:'2 days ago',  title:"Mortgage rate cuts spark biggest sales surge in 2 years",                angle:"The lock-in effect that froze the market for 18 months is finally cracking. Agents who stayed in the game have a window." },
    { tag:'Tech',       source:'Inman',              date:'3 days ago',  title:"Zillow rolls out instant tours feature — the iBuyer playbook's second act", angle:"After the iBuyer wind-down, Zillow is back to building agent-augmenting tools. Pay attention to the workflow." },
    { tag:'Settlement', source:'RisMedia',           date:'4 days ago',  title:"NAR settlement aftermath: buyer-agent commissions are negotiable",       angle:"The 6% standard is gone. Agents who can clearly articulate value are charging more, not less. Most can't." },
    { tag:'Tech',       source:'HousingWire',        date:'5 days ago',  title:"AI-generated listing photos and 3D tours are now baseline",              angle:"Listings without them are getting 40% fewer views. The cost of producing them dropped 10x this year." },
    { tag:'Rentals',    source:'HousingWire',        date:'6 days ago',  title:"Multi-family rents flat YoY — the era of 8% annual increases is over",   angle:"Operators that priced for 7% growth are revising plans. Watch concession packages climbing." },
    { tag:'Investors',  source:'The Real Deal',      date:'this week',   title:"Single-family rentals are quietly outperforming multi-family",            angle:"Institutional money that flooded multi-family in 2021-22 is rotating to SFR. Smaller operators have an opening." },
    { tag:'Behavior',   source:'Inman',              date:'this week',   title:"Showings are getting longer — buyers are commitment-shy",                 angle:"Average time-to-decision has stretched from 3 weeks to 8 weeks in many markets. Tools to nurture warm leads are critical." },
    { tag:'Conversions', source:'The Real Deal',      date:'this week',   title:"Commercial-to-residential conversions accelerate in 5 major cities",     angle:"NYC, Chicago, DC, SF, Boston: all running pilot programs. Developers and architects with experience here are getting calls." },
    { tag:'Pricing',    source:'RisMedia',           date:'last week',   title:"Iterative price reductions are losing to one big strategic cut",         angle:"Three small reductions over 60 days underperform a single big cut on week 3. Sellers are slow to update." },
    { tag:'Brokerage',  source:'Inman',              date:'last week',   title:"Indie brokerages are growing 3x faster than national franchises",        angle:"Top agents are leaving Compass, Coldwell, RE/MAX for boutique brands or going solo. Tech infra is closing the gap." }
  ]
};

const CE_TREND_GENERIC = [
  { tag:'Distribution', source:'Indie Hackers',      date:'2 days ago',  title:"Founder-led content is outperforming brand-led content 5-10x",        angle:"Audiences trust people, not logos. The case for a founder behind the keyboard, not behind the brand." },
  { tag:'Channels',     source:'On Deck',            date:'3 days ago',  title:"Newsletter-as-CRM is replacing top-of-funnel ads",                     angle:"Owned audience beats rented audience. The 12-month math is now obvious to most operators." },
  { tag:'Cadence',      source:'Pragmatic Engineer', date:'4 days ago',  title:"Weekly shipping beats quarterly planning",                              angle:"Teams running 2-week experiment cycles are out-learning teams running 6-month roadmaps. The compounding is real." },
  { tag:'AI',           source:'Stratechery',        date:'5 days ago',  title:"Generative AI is flooding feeds — original takes now stand out",       angle:"The signal-to-noise ratio is collapsing. Specific stories with receipts are getting disproportionate reach." },
  { tag:'Pricing',      source:'Lenny\'s Newsletter', date:'6 days ago',  title:"Bundling is back — single SKU, multiple products",                     angle:"After unbundling fatigue, customers want one bill, one login, one relationship. Watch for consolidation plays." },
  { tag:'Newsletters',  source:'Indie Hackers',      date:'this week',   title:"Indie hackers reporting record month for paid newsletters",            angle:"Owned-audience compounding is real. The 12-month math is finally obvious to everyone." },
  { tag:'CAC',          source:'First Round Review', date:'this week',   title:"Productivity software CACs are climbing 30% YoY — organic is the moat", angle:"The paid-acquisition playbook is breaking. Founders who built distribution muscles are winning quietly." },
  { tag:'Communities',  source:'TechCrunch',         date:'this week',   title:"Communities-as-product is back — Geneva, Heartbeat, Circle all raising", angle:"After a quiet 2024, community products are getting funded again. The thesis: relationships compound, features don't." },
  { tag:'Education',    source:'On Deck',            date:'last week',   title:"Cohort-based courses bouncing back after a quiet 2024",                 angle:"The CBC graveyard was overblown. Operators teaching what they actually do are seeing $200k+ launches again." },
  { tag:'Hiring',       source:'Lenny\'s Newsletter', date:'last week',   title:"Small teams are out-shipping bigger ones — and getting noticed",       angle:"4-person teams hitting $1M ARR are now common stories. Leverage > headcount as the founder skill of the year." }
];


async function genCampaign(){
  const t = val('cmType'); const hook = val('cmHook')||'Free 14-day trial'; const days = +val('cmDays')||14; const budget=+val('cmBudget')||0;
  const channels = [];
  if($('chX').checked) channels.push('X');
  if($('chLI').checked) channels.push('LinkedIn');
  if($('chEmail').checked) channels.push('Email');

  const outEl = $('campaignOut');
  outEl.innerHTML = '<span class="ce-spinner"></span> Building your campaign…';
  try {
    const data = await xgFetch('/generate', {
      kind: 'campaign',
      campaignType: t, hook, days, budget,
      channels: channels.length ? channels : ['X'],
      niche: state.profile?.niche || '',
      voiceNiche: _ce.voice?.niche || '', voiceStyle: _ce.voice?.style || '',
    });
    outEl.textContent = data.text;
    state.campaigns.unshift({name:`${t}, ${new Date().toLocaleDateString()}`, spend:budget, leads:0, status:'Planned'});
    save(); renderCampaigns();
    toast('Campaign built & logged');
    return;
  } catch(e){
    console.warn('Campaign API failed, falling back', e);
    toast('Using template fallback — ' + (e.message||'API error'));
  }

  // Template fallback (offline / quota / error)
  const week = (n)=>`Week ${n}`;
  const out = `## Campaign: ${t}
Hook: ${hook}
Channels: ${channels.join(', ')||'X'}
Duration: ${days} days · Budget: $${budget}

## Audience Segments
- Cold: ${state.profile?.niche||'niche'} founders following 3+ peers in your space
- Warm: profile visitors last 30 days, newsletter subs, free-trial drop-offs
- Hot: replied to last 5 posts; opened 3+ emails

## Timeline
${week(1)}: Pre-launch teasers (3 hooks/day on X), warm-list email (#1)
${week(2)}: Launch storm (10-tweet thread + reply sprint), email (#2 + #3), 1 LinkedIn long-form
${days>14? `${week(3)}: Case-study post + retargeting copy + email (#4)\n${week(4)}: Wrap thread + email (#5) with ROI receipts\n` : ''}

## KPIs
- Impressions: ${fmt(50000*(days/14))}
- Replies: ${Math.round(150*(days/14))}
- Profile visits: ${Math.round(2500*(days/14))}
- Leads (email/demo): ${Math.round(40*(days/14))}
- CPL target: $${budget? (budget/Math.max(40*(days/14),1)).toFixed(2):'0.00'}

## Email Sequence
1. Subject: "${hook}, for ${state.profile?.niche||'founders'}"
   Body: 1-line story → problem → offer → 1 CTA.
2. Subject: "Why we built this (and the metric that changed)"
3. Subject: "A 90-second demo (no signup)"
4. Subject: "Case study: how [persona] used it in week 1"
5. Subject: "Last call, closing the cohort Friday"

## Ad Copy (X promoted)
- A: "${hook}. No card. 14 days." → CTA: Start free
- B: "We rebuilt ${state.profile?.niche||'this'} for solo founders. Here's the 60s tour." → CTA: Watch
- C: "Replaced 4 tools with one. Numbers inside." → CTA: See receipts

## Landing Page Wireframe (HTML)
\`\`\`html
<section class="hero">
  <h1>${hook}</h1>
  <p>Built for ${state.profile?.niche||'founders'}. Ship results in week 1.</p>
  <a class="cta" href="#start">Start free</a>
</section>
<section class="proof">
  <ul><li>"Saved 8 hrs/week", Founder, SaaS</li><li>+34% reply rate</li><li>1-click setup</li></ul>
</section>
<section class="faq">
  <h2>FAQ</h2>
  <details><summary>Do I need a credit card?</summary>No.</details>
  <details><summary>How long is setup?</summary>≤ 5 minutes.</details>
</section>
\`\`\`

## Next Steps
- Approve Email #1 + 3 ad variants today. Schedule launch storm for Tue 9am ET.

## Upgrade?
- Done-for-you launch ($199): we write all assets + schedule.`;
  $('campaignOut').textContent = out;
  // Track in dashboard
  state.campaigns.unshift({name:`${t}, ${new Date().toLocaleDateString()}`, spend:budget, leads:0, status:'Planned'});
  save(); renderCampaigns();
  toast('Campaign built & logged');
}

/* ========= Brand Kit ========= */
async function genBrandKit(){
  // Auto-fill from profile if fields are empty
  const prof = state.profile || {};
  if(!val('bkWhat') && prof.niche) $('bkWhat').value = prof.niche;

  const what = val('bkWhat') || prof.niche || '';
  const who  = val('bkWho')  || prof.target || '';
  const bio  = val('bkBio')  || '';
  const platform = val('bkPlatform') || 'X / Twitter';
  const tone     = val('bkTone')     || 'direct and casual';

  if(!what){ toast('Tell me what you build first'); $('bkWhat')?.focus(); return; }

  const outEl = $('brandKitOut');
  outEl.innerHTML = '<span class="ce-spinner"></span> Building your Brand Kit…';

  try {
    const data = await xgFetch('/generate', {
      kind: 'brand-kit', what, who, bio, platform, tone,
    });
    outEl.textContent = data.text;
    toast('Brand Kit ready');
  } catch(e) {
    outEl.textContent = 'Generation failed — ' + (e.message || 'try again');
    toast('Brand Kit failed: ' + (e.message || 'API error'));
  }
}

// Pre-fill Brand Kit inputs whenever the user navigates to the brand view
function brandKitAutoFill(){
  const prof = state.profile || {};
  if(prof.niche  && !val('bkWhat')) $('bkWhat').value = prof.niche;
  if(prof.target && !val('bkWho'))  $('bkWho').value  = prof.target;
}

/* ========= ICP Builder ========= */
function icpAutoFill(){
  const p = state.profile || {};
  if(p.niche   && !val('icpName')) $('icpName').value  = p.niche;
  if(p.niche   && !val('icpWhat')) $('icpWhat').value  = p.niche;
  if(p.target  && !val('icpCustomers')) $('icpCustomers').value = p.target;
}

async function genIcp(){
  const name      = val('icpName')      || state.profile?.niche || 'your product';
  const what      = val('icpWhat')      || '';
  const problem   = val('icpProblem')   || '';
  const price     = val('icpPrice')     || '';
  const customers = val('icpCustomers') || '';

  const outEl = $('icpOut');
  outEl.innerHTML = '<span class="ce-spinner"></span> Building your customer profiles…';
  try {
    const data = await xgFetch('/generate', {
      kind: 'icp',
      name, what, problem, price, customers,
      niche: state.profile?.niche || '',
    });
    outEl.textContent = data.text;
    toast('ICP profiles ready');
  } catch(e) {
    console.warn('ICP API failed', e);
    toast('AI unavailable — check connection');
    outEl.textContent = `Could not reach AI: ${e.message}`;
  }
}

/* ========= Product Hunt Launch Kit ========= */
function phAutoFill(){
  const p = state.profile || {};
  if(p.niche && !val('phName'))     $('phName').value     = p.niche;
  if(p.niche && !val('phOneliner')) $('phOneliner').value = p.niche;
  if(p.target && !val('phAudience')) $('phAudience').value = p.target;
}

async function genPhLaunch(){
  const name     = val('phName')     || state.profile?.niche || 'your product';
  const oneliner = val('phOneliner') || '';
  const what     = val('phWhat')     || '';
  const audience = val('phAudience') || '';
  const features = val('phFeatures') || '';
  const goal     = val('phGoal')     || 'top-5 product of the day';

  const outEl = $('phOut');
  outEl.innerHTML = '<span class="ce-spinner"></span> Assembling your launch kit…';
  try {
    const data = await xgFetch('/generate', {
      kind: 'ph-launch',
      name, oneliner, what, audience, features, goal,
      niche: state.profile?.niche || '',
    });
    outEl.textContent = data.text;
    toast('Launch kit ready');
  } catch(e) {
    console.warn('PH Launch API failed', e);
    toast('AI unavailable — check connection');
    outEl.textContent = `Could not reach AI: ${e.message}`;
  }
}

/* ========= Growth Lab ========= */
function growthAutoFill(){
  const p = state.profile || {};
  if(p.stage){
    const stageMap = {'Pre-seed':'idea','Seed':'mvp','Series A':'pmf','Bootstrapped':'mvp'};
    const mapped = stageMap[p.stage];
    if(mapped && $('glStage')) $('glStage').value = mapped;
  }
}

async function genGrowthExperiments(){
  const stage = val('glStage') || 'mvp';
  const goal  = val('glGoal')  || 'trials';
  const count = parseInt(val('glCount') || '6');
  const budget = val('glBudget') || '$0 (bootstrapped)';
  const channels = [
    $('glChX')?.checked    && 'X / Twitter',
    $('glChLI')?.checked   && 'LinkedIn',
    $('glChEmail')?.checked&& 'Email',
    $('glChSEO')?.checked  && 'SEO / Blog',
    $('glChPH')?.checked   && 'Product Hunt',
    $('glChComm')?.checked && 'Communities',
  ].filter(Boolean);

  const outEl = $('growthOut');
  outEl.innerHTML = '<span class="ce-spinner"></span> Designing your growth experiments…';
  try {
    const data = await xgFetch('/generate', {
      kind: 'growth-experiments',
      stage, goal, channels, budget, count,
      niche: state.profile?.niche || 'your SaaS product',
    });
    outEl.textContent = data.text;
    toast('Growth experiments ready');
  } catch(e) {
    console.warn('Growth experiments API failed', e);
    toast('AI unavailable — check connection');
    outEl.textContent = `Could not reach AI: ${e.message}\n\nTry again once you're signed in.`;
  }
}

/* ========= AI Growth Pulse (Dashboard) ========= */
function mdSimple(text){
  // Minimal safe markdown renderer: bold + newlines only
  return escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>');
}

async function runGrowthPulse(){
  const btn = $('pulseBtn');
  const out = $('pulseOut');
  if(!fbAuth?.currentUser){ toast('Sign in to use AI Pulse'); return; }
  const m = state.metrics;
  const cur  = m.followers.at(-1)||0;
  const prev = m.followers.at(-8)||cur;
  const top  = state.posts.slice().sort((a,b)=>b.impr-a.impr)[0];

  if(btn){ btn.disabled = true; btn.textContent = 'Analysing…'; }
  out.innerHTML = '<span class="ce-spinner"></span> Reading your metrics…';
  try {
    const data = await xgFetch('/generate', {
      kind: 'pulse',
      niche:  state.profile?.niche  || 'your product',
      stage:  state.profile?.stage  || 'mvp',
      metrics: {
        followersWoW: pct(cur, prev),
        impressions7: sum(m.impressions.slice(-7)),
        engagement7:  avg(m.engagement.slice(-7)),
        visits7:      sum(m.visits.slice(-7)),
        topPost: top ? { text: top.text, impr: top.impr } : null,
      },
    });
    out.innerHTML = `<div class="pulse-insights">${mdSimple(data.text)}</div>`;
    toast('Pulse ready');
  } catch(e) {
    out.innerHTML = '<span class="muted small">AI Pulse unavailable — add some metrics first, then try again.</span>';
    console.warn('Pulse error', e);
  } finally {
    if(btn){ btn.disabled = false; btn.textContent = 'Refresh'; }
  }
}

/* ========= Email Sequences ========= */
function emailAutoFill(){
  const p = state.profile || {};
  if(p.niche && !val('esName')) $('esName').value = p.niche;
  if(p.niche && !val('esWhat')) $('esWhat').value = p.niche;
  if(p.target && !val('esAudience')) $('esAudience').value = p.target;
}

async function genEmailSequence(){
  const name     = val('esName') || state.profile?.niche || 'your product';
  const what     = val('esWhat') || '';
  const audience = val('esAudience') || '';
  const goal     = val('esGoal') || 'onboarding';
  const count    = parseInt(val('esCount') || '5');
  const tone     = val('esTone') || 'direct and conversational';

  const outEl = $('emailSeqOut');
  outEl.innerHTML = '<span class="ce-spinner"></span> Writing your email sequence…';
  try {
    const data = await xgFetch('/generate', {
      kind: 'email-sequence',
      name, what, audience, goal, count, tone,
      voiceNiche: state.profile?.niche || '',
      voiceStyle: _ce?.voice?.style || '',
    });
    outEl.textContent = data.text;
    toast('Email sequence ready');
  } catch(e) {
    console.warn('Email sequence API failed', e);
    toast('AI unavailable — showing template');
    outEl.textContent = emailSeqFallback(name, goal, count);
  }
}

function emailSeqFallback(name, goal, count){
  const goalLabel = {onboarding:'Onboarding',launch:'Launch',nurture:'Nurture',reEngage:'Re-Engagement',waitlist:'Waitlist'}[goal] || goal;
  const emails = [];
  for(let i=1;i<=count;i++){
    emails.push(`---\n## Email ${i}: ${goalLabel} Email ${i}\n**Send:** Day ${(i-1)*2}\n**Subject:** ${i===1?`Welcome to ${name}`:`Your ${goalLabel} update #${i}`}\n**Preview text:** Here's what you need to know right now.\n\nHi,\n\nThis is where your email body goes. Keep it under 200 words, one CTA.\n\n[CTA: ${i===1?'Get started →':'Continue →'}]\n\n**P.S.** More value drops in the next email.`);
  }
  return emails.join('\n\n');
}

/* ========= Saved Library ========= */
let _libFilter = 'all';

function saveToLibrary(type, label, content){
  if(!content || content.length < 20){ toast('Nothing to save yet — generate content first'); return; }
  if(!state.library) state.library = [];
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    type,
    label: label || type,
    content,
    date: new Date().toISOString().slice(0,10)
  };
  state.library.unshift(item);
  save();
  toast('Saved to Library ✓');
}

function deleteFromLibrary(id){
  if(!confirm('Delete this saved item?')) return;
  state.library = (state.library||[]).filter(x=>x.id!==id);
  save();
  renderLibrary();
  toast('Deleted');
}

function setLibFilter(f){
  _libFilter = f;
  document.querySelectorAll('[data-lib-filter]').forEach(b=>{
    b.classList.toggle('active', b.dataset.libFilter === f);
  });
  renderLibrary();
}

const LIB_TYPE_LABELS = { email:'Email', campaign:'Campaign', copy:'Website Copy', brand:'Brand Kit', growth:'Growth Lab', icp:'ICP', ph:'PH Launch' };

function renderLibrary(){
  const el = $('libItems'); if(!el) return;
  if(!state.library) state.library = [];
  const items = state.library.filter(x => _libFilter === 'all' || x.type === _libFilter);
  if(!items.length){
    el.innerHTML = `<div class="lib-empty"><div class="lib-empty-icon">📚</div><p><b>No saved items${_libFilter !== 'all' ? ' in this category' : ''}</b></p><p class="muted small">Generate content in any module and click Save to keep it here, synced to your account.</p></div>`;
    return;
  }
  el.innerHTML = items.map(item=>{
    const badge = LIB_TYPE_LABELS[item.type] || item.type;
    const preview = escapeHtml((item.content||'').slice(0,280)) + (item.content.length>280?'…':'');
    const contentJson = JSON.stringify(item.content);
    return `<div class="lib-card">
      <div class="lib-card-head">
        <span class="lib-badge lib-badge-${item.type}">${badge} · ${escapeHtml(item.label)}</span>
        <span class="muted small">${item.date}</span>
      </div>
      <pre class="lib-preview">${preview}</pre>
      <div class="lib-actions">
        <button class="btn ghost small" onclick="navigator.clipboard.writeText(${contentJson}).then(()=>toast('Copied'))">Copy all</button>
        <button class="btn ghost small lib-del" onclick="deleteFromLibrary('${item.id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

async function genCopy(){
  const n=val('wName')||'YourStartup';
  const w=val('wWhat')||'AI bookkeeping copilot for SMBs';
  const bio=val('wBio')||'Founder. Builder. Shipper.';
  const cta=val('wCTA')||'Book a 15-min demo';

  const outEl = $('copyOut');
  outEl.innerHTML = '<span class="ce-spinner"></span> Writing your landing-page copy…';
  try {
    const data = await xgFetch('/generate', {
      kind: 'copy',
      name: n, what: w, bio, cta,
      niche: state.profile?.niche || '',
      voiceNiche: _ce.voice?.niche || '', voiceStyle: _ce.voice?.style || '',
    });
    outEl.textContent = data.text;
    toast('Copy generated');
    return;
  } catch(e){
    console.warn('Copy API failed, falling back', e);
    toast('Using template fallback — ' + (e.message||'API error'));
  }

  const out = `## Hero
# ${w}.
${n} helps you cut marketing busywork by 80%, without an agency.
[${cta}]

## About
${bio} I built ${n} after watching teams lose weeks to manual ops. Now ${n} runs the boring parts so you can ship.

## Services
- Setup in <5 minutes (no integrations to babysit)
- Daily summaries: what changed, what's at risk, what to do
- Investor-ready exports in 1 click

## Testimonials
- "Replaced 3 tools and an analyst.", Founder, SaaS (seed)
- "First week saved me 9 hours.", Solo founder, e-com

## CTA
[${cta}]  ·  No card. Cancel anytime.

## Framer/HTML Snippet
\`\`\`html
<section style="padding:80px 24px;text-align:center">
  <h1 style="font-size:56px;margin:0 0 12px">${w}.</h1>
  <p style="font-size:18px;color:#475569;max-width:640px;margin:0 auto 24px">
    ${n} helps you cut marketing busywork by 80%, without an agency.
  </p>
  <a href="#cta" style="background:#111;color:#fff;padding:14px 22px;border-radius:10px;text-decoration:none">${cta}</a>
</section>
\`\`\`

## Next Steps
- Drop into Framer. Replace placeholders. Ship today.

## Upgrade?
- Conversion audit ($79): we rewrite the hero + 3 sections for your funnel.`;
  $('copyOut').textContent = out;
  toast('Copy generated');
}

async function genAudit(){
  const handle = val('aHandle')||'@yourhandle';
  const tweets = (val('aTweets')||'').split('\n').map(s=>s.trim()).filter(Boolean).slice(0,5);
  if(!tweets.length){ $('auditOut').textContent='Paste at least one tweet on the left.'; return; }

  const outEl = $('auditOut');
  outEl.innerHTML = '<span class="ce-spinner"></span> Auditing your posts…';
  try {
    const data = await xgFetch('/generate', {
      kind: 'audit',
      handle, posts: tweets,
      niche: state.profile?.niche || '',
    });
    outEl.textContent = data.text;
    toast('Audit ready');
    return;
  } catch(e){
    console.warn('Audit API failed, falling back', e);
    toast('Using template fallback — ' + (e.message||'API error'));
  }

  const score = (t)=>{
    let s=50;
    if(/^[A-Z]/.test(t)) s+=2;
    if(t.length<280) s+=5;
    if(/\?/.test(t)) s+=8;        // questions drive replies
    if(/\d/.test(t)) s+=6;        // numbers add specificity
    if(/^(I|We|Most|Stop|Here|If)/i.test(t)) s+=10; // strong hooks
    if(t.split(' ').length<14) s+=6; // brevity
    if(/!{2,}/.test(t)) s-=5;
    return Math.min(99, Math.max(20,s));
  };
  const ab = (t)=>[
    `A: "Most founders get this wrong: " + ${shortify(t)}`,
    `B: "I tested ${Math.floor(Math.random()*5+3)} versions. Only one worked: " + ${shortify(t)}`
  ].join('\n   ');
  const out = `## Audit Report, ${handle}

## Scorecard
${tweets.map((t,i)=>`Tweet ${i+1}: ${score(t)}/100, ${t.length} chars`).join('\n')}
Avg: ${(tweets.map(score).reduce((a,b)=>a+b,0)/tweets.length).toFixed(0)}/100

## Hook Diagnosis
${tweets.map((t,i)=>`- T${i+1}: ${diagnose(t)}`).join('\n')}

## A/B Variants
${tweets.map((t,i)=>`T${i+1}\n   ${ab(t)}`).join('\n\n')}

## Growth Hacks (next 7 days)
- Reply within 30 min on 10 in-niche posts daily (compounds reach 3-5x)
- Pin your highest-engagement thread; rotate weekly
- Quote-tweet 1 contrarian take/day with a specific receipt
- Convert your top tweet into a 5-tweet thread by Friday
- DM 5 warm followers with a 1-line ask (no pitch)

## Weekly Action Plan
Mon: Ship 3 hooks · Reply sprint
Tue: Long thread (8–10) · Poll
Wed: Contrarian take · Founder story
Thu: Listicle · Reply sprint
Fri: Recap thread · CTA push
Sat: Evergreen + meme
Sun: Reflection + tease

## Upgrade?
- Premium Audit ($49): manual review of last 30 posts + new hooks for top 5.`;
  $('auditOut').textContent = out;
  toast('Audit ready');
}

function diagnose(t){
  const issues=[];
  if(t.length>240) issues.push('too long for hook, trim to <140');
  if(!/\?/.test(t) && !/^[A-Z]/.test(t)) issues.push('weak opener, start with I/We/Most/Stop/Here/If');
  if(!/\d/.test(t)) issues.push('add a number to add specificity');
  if(/!{2,}/.test(t)) issues.push('drop the hype punctuation');
  if(!issues.length) return 'Solid. Try an A/B with a stronger hook variant.';
  return issues.join('; ');
}
function shortify(t){ return JSON.stringify(t.length>120? t.slice(0,117)+'…' : t); }

/* ========= Reports / Exports ========= */
async function buildReport(){
  const m = state.metrics;
  const cur = m.followers.at(-1)||0, prev = m.followers.at(-8)||cur;
  const impr7 = sum(m.impressions.slice(-7));
  const eng7 = avg(m.engagement.slice(-7));
  const visits7 = sum(m.visits.slice(-7));
  const top = state.posts.slice().sort((a,b)=>b.impr-a.impr)[0];

  $('reportOut').innerHTML = '<span class="ce-spinner"></span> Building your weekly snapshot…';

  // Fetch AI narrative (best-effort; report still works without it)
  let narrative = '';
  try {
    const data = await xgFetch('/generate', {
      kind: 'report',
      niche: state.profile?.niche || 'your product',
      metrics: {
        followersWoW: pct(cur, prev),
        impressions7: impr7,
        engagement7: eng7,
        visits7,
        topPost: top ? { text: top.text, impr: top.impr, likes: top.likes } : null,
      },
    });
    narrative = (data.text||'').trim();
  } catch(e){
    console.warn('Report narrative skipped', e);
  }

  const md = `# Weekly Snapshot, ${state.profile?.niche||'Your Startup'}
Date: ${new Date().toISOString().slice(0,10)}
${narrative ? `\n## What Happened This Week\n${narrative}\n` : ''}
## Headlines
- Followers: ${fmt(cur)} (${(pct(cur,prev)).toFixed(1)}% WoW)
- Impressions (7d): ${fmt(impr7)}
- Engagement rate (7d): ${eng7.toFixed(2)}%
- Profile visits (7d): ${fmt(sum(m.visits.slice(-7)))}

## Top Post
${top? `"${top.text}", ${fmt(top.impr)} impressions, ${top.likes} likes` : 'No posts logged.'}

## Goals
${state.goals.map(g=>`- ${g.label}: ${fmt(g.current)} / ${fmt(g.target)} (${((g.current/g.target)*100).toFixed(0)}%)`).join('\n')||'- (none set)'}

## Campaigns
${state.campaigns.map(c=>`- ${c.name}: $${c.spend} spend · ${c.leads} leads · ${c.status}`).join('\n')||'- (none)'}

## Next Week's Plan
- Ship 3 threads (Tue/Thu/Sat 9am ET)
- Daily reply sprint (10 in-niche replies, 30 min after their post)
- Email #2 to warm list with 1 receipt screenshot
`;
  $('reportOut').textContent = md;
  // Populate side cards
  const r = state.range || 7;
  const totalImpr = sum(m.impressions.slice(-r));
  const totalVisits = sum(m.visits.slice(-r));
  const totalLeads = state.campaigns.reduce((a,c)=>a+(c.leads||0),0);
  const spend = state.campaigns.reduce((a,c)=>a+(c.spend||0),0);
  const cpl = totalLeads? '$'+(spend/totalLeads).toFixed(2) : '—';
  $('invKPIs').innerHTML = `
    <div class="row" style="flex-direction:column;gap:6px">
      <div><b>${fmt(cur)}</b> followers <span class="muted">· ${pct(cur,prev).toFixed(1)}% WoW</span></div>
      <div><b>${fmt(totalImpr)}</b> impressions / ${r}d</div>
      <div><b>${eng7.toFixed(2)}%</b> engagement rate</div>
      <div><b>${fmt(totalVisits)}</b> profile visits</div>
      <div><b>${totalLeads}</b> leads · CPL ${cpl}</div>
    </div>`;
  // Channel mix from campaigns (best-effort guess by name)
  const mix = {X:0, LinkedIn:0, Email:0};
  state.campaigns.forEach(c=>{
    const k = /linkedin/i.test(c.name)?'LinkedIn':/email|webinar/i.test(c.name)?'Email':'X';
    mix[k] += (c.leads||0)+1;
  });
  const tot = Math.max(1, mix.X+mix.LinkedIn+mix.Email);
  $('channelMix').innerHTML = ['X','LinkedIn','Email'].map(k=>{
    const p = (mix[k]/tot*100).toFixed(0);
    return `<div style="margin:6px 0"><div class="row" style="justify-content:space-between"><span>${k}</span><span class="muted">${p}%</span></div><div class="bar-track"><div class="bar-fill" style="width:${p}%"></div></div></div>`;
  }).join('');
  toast('Report ready');
}

function downloadReport(){
  const md = $('reportOut').innerText;
  if(!md || md.startsWith('Click ')){ toast('Build a report first'); return; }
  download(new Blob([md],{type:'text/markdown'}), `xgrowth-snapshot-${new Date().toISOString().slice(0,10)}.md`);
}

function mockSend(){
  const to = val('repEmail');
  if(!to || !/.+@.+\..+/.test(to)){ toast('Enter a valid email'); return; }
  toast(`Snapshot queued for ${to} (demo)`);
}

function exportJSON(){
  const blob = new Blob([JSON.stringify(state,null,2)], {type:'application/json'});
  download(blob, 'xgrowth-data.json');
}
function exportCSV(){
  const rows = [['day','followers','impressions','engagement_rate','profile_visits']];
  for(let i=0;i<state.metrics.followers.length;i++){
    rows.push([i+1, state.metrics.followers[i], state.metrics.impressions[i], state.metrics.engagement[i], state.metrics.visits[i]]);
  }
  const csv = rows.map(r=>r.join(',')).join('\n');
  download(new Blob([csv],{type:'text/csv'}), 'xgrowth-metrics.csv');
}
function download(blob, name){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  URL.revokeObjectURL(a.href);
}

/* ========= Mobile drawer ========= */
function toggleSide(force){
  const s = document.querySelector('.side');
  const sc = $('scrim');
  const open = force === undefined ? !s.classList.contains('show') : !!force;
  s.classList.toggle('show', open);
  sc.classList.toggle('show', open);
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
  setSync('syncing');
  const cred = firebase.auth.GoogleAuthProvider.credential(resp.credential);
  fbAuth.signInWithCredential(cred).catch(err=>{
    console.error('Firebase sign-in failed', err);
    setSync('error');
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
    setSync('syncing');
    if(useRedirect){
      await fbAuth.signInWithRedirect(provider);
      return;
    }
    await fbAuth.signInWithPopup(provider);
  }catch(err){
    if(err && err.code === 'auth/popup-blocked'){
      // Popup blocked, fall back to redirect
      try{
        await fbAuth.signInWithRedirect(provider);
      }catch(e2){
        console.error(e2); toast('Sign-in failed: '+(e2.message||e2.code));
      }
    } else if(err && err.code === 'auth/popup-closed-by-user'){
      setSync('offline');
    } else {
      console.error('Sign-in error', err);
      toast('Sign-in failed: '+(err.message||err.code));
      setSync('error');
    }
  }
}
// Expose for inline onclick / wrapping the "Sign in" pill
window.startGoogleSignIn = startGoogleSignIn;
function applyUser(){
  if(currentUser){
    $('loginBox').style.display = 'none';
    $('userBox').style.display = 'block';
    $('uName').textContent = currentUser.name;
    $('uEmail').textContent = currentUser.email;
    $('uAvatar').src = currentUser.picture || '';
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
    // Redirect to landing page after signout
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
    // Signed in, reveal the app
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
      // After cloud load, show welcome only if no profile exists anywhere
      if(!state.profile){ openWelcome(); }
    });
    ceInit(); // load CE history + voice prefs
  } else {
    document.body.classList.remove('authed');
    cloudLoaded = false;
    setSync('offline');
    // Only act on a confirmed signed-out state (after any pending redirect result has resolved).
    if(redirectResultDone){
      runAuthGateLogic();
    } else {
      // Show the loading spinner while Firebase is still processing the redirect.
      setAuthState('loading');
    }
  }
});

function runAuthGateLogic(){
  if(fbAuth.currentUser) return; // signed in: nothing to do
  if(wantsSignin && !signinTriggered){
    // Came from a marketing CTA: trigger Google redirect while showing "Redirecting"
    signinTriggered = true;
    setAuthState('redirecting');
    startGoogleSignIn(true).catch(err=>{
      authGateError('Could not start sign-in: ' + (err.message||err.code));
    });
  } else {
    // User landed on /app/ without an active sign-in attempt and isn't authenticated.
    // Most likely: pressed back from Google's sign-in page, or visited /app/ directly.
    // Bounce to the landing page for a clean back-button history.
    window.location.replace('/');
  }
}

/* ========= Init ========= */
window.addEventListener('resize', ()=>{ renderKPIs(); renderBars(); renderVelocity(); });
initGoogle();
// Show loading state until Firebase auth determines whether the user is signed in
setAuthState('loading');
