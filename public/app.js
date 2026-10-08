// Jarvis phone app. Two modes:
//  📱 Phone mode: talks to Claude directly (web search, memory, cloud coding on GitHub). Works anywhere.
//  💻 Laptop mode: sends commands to Jarvis on your laptop (over Tailscale), which can control the laptop.
// Keys live only in this phone's storage. Nothing secret is in this code.
import * as Phone from './phone.js';
import * as GH from './github.js';

const $ = id => document.getElementById(id);
const feed = $('feed'), input = $('input'), sendBtn = $('send'), tasksEl = $('tasks'), settingsEl = $('settings');
const ls = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or private mode */ } },
};

// ---------- settings ----------
const DEFAULTS = { name: 'Jarvis', owner: 'Aryan', anthropicKey: '', githubToken: '', repos: ['nagarearyan92-code/gia-foodtracker'], model: Phone.MODELS[0][0], memory: '', laptopUrl: '', laptopToken: '', speak: false, mode: 'auto', project: '' };
let S = { ...DEFAULTS, ...ls.get('jarvis_settings', {}) };
const save = () => ls.set('jarvis_settings', S);

// Pairing links: "#laptop=<https url>&t=<code>" (from setup), or "#t=<code>" when this page is served by the laptop.
(function pairFromLink() {
  const p = parsePairing(location.hash + ' ' + location.search);
  const t = p.t;
  if (!t || !/[#?&]t=/.test(location.hash + location.search)) return;
  S.laptopToken = t;
  // "lh" = the laptop's Tailscale name (plain text, so phone cameras can't mangle it).
  let laptopUrl = p.url;
  if (!laptopUrl && /^https?:$/.test(location.protocol) && !/github\.io$/.test(location.hostname)) laptopUrl = location.origin;
  S.laptopUrl = laptopUrl.replace(/\/$/, '');
  S.mode = 'auto';
  save();
  history.replaceState(null, '', location.pathname);
})();
// Accepts anything that contains the pairing details: the full link, just the "#lh=…&t=…" part,
// a link with them after "?" instead of "#", percent-encoded text, or "address code" on two lines.
function hostToUrl(h) {
  h = String(h || '').trim().replace(/^[^a-z0-9]+/i, '').replace(/[/#?].*$/, '');
  if (!h) return '';
  return /:\d+$/.test(h) && !/\.ts\.net/.test(h) ? 'http://' + h : 'https://' + h;
}
function parsePairing(text) {
  let s = String(text || '').trim();
  try { if (/%[0-9a-f]{2}/i.test(s)) s = decodeURIComponent(s); } catch { /* keep as is */ }
  const grab = k => (s.match(new RegExp(`(?:^|[#?&\\s])${k}=([^&#\\s]+)`)) || [])[1] || '';
  const t = grab('t');
  let url = grab('lh') ? hostToUrl(grab('lh')) : grab('laptop');
  if (url && !/^https?:\/\//.test(url)) url = hostToUrl(url);
  if (!url) { const m = s.match(/https?:\/\/[^/#?\s]+:\d+/); if (m) url = m[0]; }
  if (!url) { const m = s.match(/\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/i); if (m) url = 'https://' + m[0]; }
  let tok = t;
  if (!tok && url) { // "address" then "code" on separate lines
    const rest = s.split(/\s+/).filter(w => !w.includes('.') && /^[A-Za-z0-9_-]{20,}$/.test(w));
    if (rest.length) tok = rest[0];
  }
  return { url: url ? url.replace(/\/$/, '') : '', t: tok };
}
// Old laptop-only app stored just a token.
if (!S.laptopToken && ls.get('token', '')) { S.laptopToken = ls.get('token', ''); S.laptopUrl = location.origin; save(); }
window.addEventListener('hashchange', () => { if (/[#&]t=/.test(location.hash)) location.reload(); });

let mode = 'phone';          // resolved mode
let laptop = null;           // laptop status when reachable
let busy = false, es = null, lastEvent = 0, live = null;
let pendingMine = null;
const cards = {}, lastSay = {};

// ---------- rendering helpers ----------
const atBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 140;
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function add(node) { const stick = atBottom(); feed.querySelector('.empty')?.remove(); feed.appendChild(node); if (stick) feed.scrollTop = feed.scrollHeight; return node; }
function bubble(who, text, meta, fail, sources) {
  const b = el('div', `msg ${who}${fail ? ' fail' : ''}`, text);
  if (sources?.length) {
    const src = el('div', 'sources');
    sources.slice(0, 5).forEach(s => { const a = el('a', null, '↗ ' + (s.title || s.url).slice(0, 70)); a.href = s.url; a.target = '_blank'; a.rel = 'noopener'; src.appendChild(a); });
    b.appendChild(src);
  }
  if (meta) b.appendChild(el('div', 'meta', meta));
  return add(b);
}
function step(label) { if (live) live.classList.remove('live'); live = add(el('div', 'step live', label)); }
function endSteps() { if (live) live.classList.remove('live'); live = null; }
function say(text) {
  if (!S.speak || !('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/[`*_#>]/g, '').replace(/https?:\/\/\S+/g, '').slice(0, 800));
  u.lang = 'en-GB'; speechSynthesis.speak(u);
}

function approvalCard({ title, detail, risk, yes = 'Approve', no = 'Deny' }, onAnswer) {
  const c = el('div', 'card' + (risk === 'high' ? ' high' : ''));
  c.appendChild(el('h4', null, (risk === 'high' ? '⚠️ ' : '') + title + '?'));
  if (detail) c.appendChild(el('pre', null, detail));
  const row = el('div', 'row');
  const y = el('button', 'btn yes', yes), n = el('button', 'btn no', no);
  const answer = allow => { row.replaceWith(el('div', 'done', allow ? '✓ ' + yes : '✗ ' + no)); onAnswer(allow); };
  y.onclick = () => answer(true); n.onclick = () => answer(false);
  row.append(n, y); c.appendChild(row);
  if (navigator.vibrate) navigator.vibrate(80);
  return add(c);
}

function setBusy(b) {
  busy = b;
  $('orb').classList.toggle('busy', b);
  sendBtn.textContent = b ? 'Stop' : '↑';
  sendBtn.classList.toggle('stop', b);
  updateHeader();
}

function updateHeader() {
  $('name').textContent = S.name; document.title = S.name;
  input.placeholder = `Tell ${S.name} what to do…`;
  let sub;
  if (mode === 'laptop' && laptop) sub = `💻 ${laptop.host} · $${(laptop.spent || 0).toFixed(2)} of $${laptop.budget.monthlyUsd} this month`;
  else sub = `📱 Phone mode · ${S.model.includes('opus') ? 'Opus' : 'Sonnet'}`;
  $('sub').textContent = (busy ? 'Working… · ' : '') + sub;
  $('modeChip').textContent = mode === 'laptop' ? '💻 Laptop' : '📱 Phone';
  $('project').classList.toggle('hidden', mode !== 'laptop');
  const q = $('quick'); q.innerHTML = '';
  const chips = mode === 'laptop'
    ? [['📸 Screen', 'Take a screenshot and send it to me'], ['🔋 Status', "How's the laptop doing? Battery, storage and memory."], ['🔒 Lock', 'Lock the laptop']]
    : [['📰 News', "What's the most important news today in the UK? Keep it short."], ['🌦 Weather', "What's the weather like in my area today and tomorrow?"]];
  chips.forEach(([l, cmd]) => { const b = el('button', 'chip', l); b.onclick = () => send(cmd); q.appendChild(b); });
}

function emptyState() {
  if (feed.children.length) return;
  const box = el('div', 'empty');
  box.append(el('div', 'orb'), el('h2', null, `Hi ${S.owner}`), el('div', null, mode === 'laptop' ? `What should I do on ${laptop?.host || 'your laptop'}?` : 'Ask me anything. I can search the web, read links, remember things and work on your GitHub projects.'));
  const ideas = el('div', 'ideas');
  const list = mode === 'laptop'
    ? ['Add the book diary to Gia Mia', 'Open Spotify and set the volume to 40%', 'Find my CV in Documents and send it to me']
    : ['Plan a cosy date night in London this weekend', 'Add the book diary to Gia Mia', 'Summarise this article: (paste a link)', 'Remember that I like short answers'];
  list.forEach(t => { const b = el('button', 'idea', t); b.onclick = () => { input.value = t; input.focus(); grow(); }; ideas.appendChild(b); });
  box.appendChild(ideas);
  feed.appendChild(box);
}

// ---------- laptop mode ----------
const lapi = (path, opts = {}) => fetch(S.laptopUrl + path, { ...opts, headers: { Authorization: 'Bearer ' + S.laptopToken, 'Content-Type': 'application/json', ...(opts.headers || {}) } });

async function probeLaptop() {
  if (!S.laptopUrl || !S.laptopToken) return null;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3500);
  try {
    const r = await fetch(S.laptopUrl + '/api/status', { headers: { Authorization: 'Bearer ' + S.laptopToken }, signal: ctl.signal });
    if (!r.ok) return r.status === 401 ? { unauthorized: true } : null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

function onLaptopEvent(ev) {
  lastEvent = Math.max(lastEvent, ev.id);
  switch (ev.type) {
    case 'start': if (pendingMine === ev.text) pendingMine = null; else bubble('me', ev.text); setBusy(true); break;
    case 'step': step(ev.label); break;
    case 'say': endSteps(); lastSay[ev.jobId] = ev.text; bubble('ai', ev.text); break;
    case 'approval': endSteps(); cards[ev.approvalId] = approvalCard(ev, allow => lapi('/api/approve', { method: 'POST', body: JSON.stringify({ id: ev.approvalId, allow }) }).catch(() => {})); break;
    case 'approval-done': { const c = cards[ev.approvalId]; if (c) { c.querySelector('.row')?.remove(); const d = c.querySelector('.done') || c.appendChild(el('div', 'done')); d.textContent = ev.allow ? '✓ Approved' : '✗ Denied'; } break; }
    case 'file': {
      const url = `${S.laptopUrl}/api/files/${ev.fileId}?t=${encodeURIComponent(S.laptopToken)}`;
      const c = el('div', 'card'); const a = el('a', 'file'); a.href = url; a.target = '_blank'; a.rel = 'noopener';
      a.appendChild(el('div', null, `📎 ${ev.name} · ${Math.max(1, Math.round(ev.size / 1024))} KB`));
      if (/\.(png|jpe?g|gif|webp)$/i.test(ev.name)) { const img = el('img'); img.src = url; a.appendChild(img); }
      c.appendChild(a); add(c); break;
    }
    case 'stopping': step('Stopping…'); break;
    case 'result': {
      endSteps();
      if (laptop && ev.spentThisMonth != null) laptop.spent = ev.spentThisMonth;
      const meta = ev.cost ? `$${ev.cost.toFixed(2)}` : null;
      if (ev.text && ev.text !== lastSay[ev.jobId]) bubble('ai', ev.text, meta, !ev.ok);
      setBusy(false); say(ev.text); break;
    }
    case 'reset': add(el('div', 'step', 'New conversation')); break;
  }
}

function connectLaptop() {
  if (es) es.close();
  es = new EventSource(`${S.laptopUrl}/api/events?t=${encodeURIComponent(S.laptopToken)}&since=${lastEvent}`);
  es.onmessage = m => { try { onLaptopEvent(JSON.parse(m.data)); } catch { /* ignore */ } };
  es.onopen = () => { $('offline').classList.add('hidden'); $('orb').classList.remove('off'); };
  es.onerror = () => setTimeout(() => { if (es && es.readyState !== 1 && mode === 'laptop') { $('offline').classList.remove('hidden'); $('orb').classList.add('off'); } }, 3000);
}

async function sendLaptop(text) {
  bubble('me', text); pendingMine = text;
  try {
    const r = await lapi('/api/command', { method: 'POST', body: JSON.stringify({ text, project: S.project || laptop?.defaultProject }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); pendingMine = null; bubble('ai', j.error || 'The laptop said no.', null, true); }
  } catch { pendingMine = null; bubble('ai', "Couldn't reach the laptop. Switch to 📱 Phone mode, or check it's on.", null, true); }
}

// ---------- phone mode ----------
let phoneChat = ls.get('jarvis_phone_chat', []);
let stopRequested = false;

async function sendPhone(text) {
  if (!S.anthropicKey) { bubble('ai', 'Add your Anthropic API key in ⚙︎ Settings to use phone mode.', null, true); return openSettings(); }
  bubble('me', text);
  setBusy(true); stopRequested = false;
  let shown = '';
  try {
    const msgs = await Phone.runTurn(phoneChat, text, {
      settings: S,
      onStep: l => { if (!stopRequested) step(l); },
      onText: t => { shown = t; },
      saveMemory: fact => { S.memory = (S.memory ? S.memory.trim() + '\n' : '') + '• ' + fact; save(); },
      approve: req => new Promise(res => { endSteps(); approvalCard(req, res); }),
      onTask: () => { if (!tasksEl.classList.contains('hidden')) renderTasks(); },
    });
    if (stopRequested) throw new Error('Stopped.');
    phoneChat = msgs;
    ls.set('jarvis_phone_chat', Phone.trimHistory(phoneChat, 30));
    endSteps();
    const start = msgs.map(m => m.role === 'user' && typeof m.content === 'string').lastIndexOf(true);
    const replies = Phone.renderable(msgs.slice(start + 1)).filter(x => x.who === 'ai');
    const last = replies.pop();
    if (last) { bubble('ai', last.text, null, false, last.sources); say(last.text); }
    else bubble('ai', 'Done.');
  } catch (e) {
    endSteps();
    bubble('ai', e.message || 'Something went wrong.', null, true);
  }
  setBusy(false);
}

function showPhoneHistory() {
  feed.innerHTML = '';
  for (const r of Phone.renderable(phoneChat).slice(-40)) {
    if (r.who === 'step') add(el('div', 'step', r.text)); else bubble(r.who, r.text, null, false, r.sources);
  }
  emptyState();
  feed.scrollTop = feed.scrollHeight;
}

// ---------- tasks (cloud coding) ----------
async function renderTasks() {
  tasksEl.innerHTML = '';
  const head = el('div', 'row'); head.style.alignItems = 'center';
  const back = el('button', 'chip', '‹ Chat'); back.onclick = () => showView('chat');
  const h = el('h3', null, '🛠 Cloud coding tasks'); h.style.flex = '1'; h.style.margin = '0';
  const refresh = el('button', 'chip', '↻'); refresh.onclick = renderTasks;
  head.append(back, h, refresh); tasksEl.appendChild(head);
  if (!S.githubToken) {
    tasksEl.appendChild(el('p', 'note', 'Add a GitHub token in ⚙︎ Settings to start and track coding tasks from your phone.'));
    return;
  }
  const loading = el('p', 'note', 'Loading…'); tasksEl.appendChild(loading);
  const api = GH.client(S.githubToken);
  let list;
  try { list = await GH.listTasks(api, S.repos); } catch (e) { loading.textContent = e.message; return; }
  loading.remove();
  if (!list.length) tasksEl.appendChild(el('p', 'note', `No tasks yet. Ask ${S.name} something like "add a dark mode to Gia Mia" and approve it.`));
  const NAMES = { queued: 'Starting', working: 'Working…', ready: 'Ready to ship', answered: 'Answered', failed: 'Problem', shipped: 'Shipped', discarded: 'Discarded' };
  for (const t of list) {
    const c = el('div', 'task');
    const top = el('div', 'top'); top.append(el('b', null, t.title), el('span', 'pill ' + t.status, NAMES[t.status] || t.status));
    c.append(top, el('div', 'note', `${t.repo.split('/')[1]} · #${t.number} · ${new Date(t.created).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`));
    if (t.summary) c.appendChild(el('div', null, t.summary.slice(0, 280) + (t.summary.length > 280 ? '…' : '')));
    const row = el('div', 'row');
    const open = el('button', 'btn', 'Open'); open.onclick = () => window.open(t.url, '_blank');
    row.appendChild(open);
    if (t.status === 'ready') {
      const ship = el('button', 'btn yes', 'Ship it');
      ship.onclick = async () => {
        ship.disabled = true; ship.textContent = 'Checking…';
        try {
          const d = await GH.diffSummary(api, t.repo, t.branch);
          const files = d.files.map(f => `${f.name} (+${f.add} −${f.del})`).join('\n');
          showView('chat');
          approvalCard({ title: `Ship "${t.title}"`, detail: `${d.files.length} file(s) changed:\n${files}${/gia-foodtracker/.test(t.repo) ? '\n\nGia will get this as an app update.' : ''}`, risk: 'high', yes: 'Ship it' }, async ok => {
            if (!ok) return;
            step('Shipping…');
            try { const r = await GH.shipTask(api, t.repo, t.number, t.branch, t.title); endSteps(); bubble('ai', `Shipped "${t.title}" (PR #${r.pr}).${/gia-foodtracker/.test(t.repo) ? ' The new Gia Mia version is building and will reach her in about 15 minutes.' : ''}`); }
            catch (e) { endSteps(); bubble('ai', e.message, null, true); }
          });
        } catch (e) { ship.disabled = false; ship.textContent = 'Ship it'; alert(e.message); }
      };
      row.appendChild(ship);
    }
    if (['ready', 'answered', 'failed', 'working', 'queued'].includes(t.status)) {
      const drop = el('button', 'btn no', 'Discard');
      drop.onclick = async () => { if (confirm(`Discard "${t.title}"? Nothing will ship.`)) { await GH.discardTask(api, t.repo, t.number).catch(e => alert(e.message)); renderTasks(); } };
      row.appendChild(drop);
    }
    c.appendChild(row);
    tasksEl.appendChild(c);
  }
}
let tasksTimer = null;
function showView(v) {
  const tasks = v === 'tasks';
  tasksEl.classList.toggle('hidden', !tasks);
  feed.classList.toggle('hidden', tasks);
  $('footer').classList.toggle('hidden', tasks);
  clearInterval(tasksTimer);
  if (tasks) { renderTasks(); tasksTimer = setInterval(renderTasks, 30000); }
}

// ---------- settings ----------
function openSettings() {
  settingsEl.innerHTML = '';
  settingsEl.classList.remove('hidden');
  const h = el('h2'); h.append(el('span', 'grow', '⚙︎ Settings'));
  const close = el('button', 'chip', 'Done'); close.onclick = () => { settingsEl.classList.add('hidden'); boot(); };
  h.appendChild(close); settingsEl.appendChild(h);
  const field = (label, key, type = 'text', placeholder = '') => {
    const f = el('label', 'field'); f.appendChild(el('span', null, label));
    const i = type === 'textarea' ? el('textarea') : el('input'); if (type !== 'textarea') i.type = type;
    i.value = Array.isArray(S[key]) ? S[key].join('\n') : (S[key] || ''); i.placeholder = placeholder; i.autocapitalize = 'off'; i.autocomplete = 'off'; i.spellcheck = false;
    i.onchange = () => { S[key] = Array.isArray(DEFAULTS[key]) ? i.value.split(/[\n,]/).map(x => x.trim()).filter(Boolean) : i.value.trim(); save(); };
    f.appendChild(i); return f;
  };
  const section = (title, note) => { const s = el('div', 'section'); s.appendChild(el('h3', null, title)); if (note) s.appendChild(el('p', 'note', note)); settingsEl.appendChild(s); return s; };

  const you = section('You and your assistant');
  you.append(field('Your name', 'owner'), field("Assistant's name", 'name'));

  const ph = section('📱 Phone mode', 'Talks to Claude straight from this phone. Your key is stored only on this phone.');
  ph.appendChild(field('Anthropic API key', 'anthropicKey', 'password', 'sk-ant-…'));
  const kt = el('div', 'row'); const kb = el('button', 'btn', 'Test key'); const kr = el('span', 'note'); kr.style.alignSelf = 'center';
  kb.onclick = async () => { kr.textContent = 'Checking…'; kr.className = 'note'; const r = await Phone.testKey(S.anthropicKey); kr.textContent = r.ok ? '✓ Works' : '✗ ' + r.error; kr.className = r.ok ? 'ok' : 'err'; };
  kt.append(kb, kr); ph.appendChild(kt);
  const mf = el('label', 'field'); mf.appendChild(el('span', null, 'Model')); const ms = el('select');
  Phone.MODELS.forEach(([v, l]) => { const o = el('option', null, l); o.value = v; ms.appendChild(o); }); ms.value = S.model;
  ms.onchange = () => { S.model = ms.value; save(); }; mf.appendChild(ms); mf.style.marginTop = '14px'; ph.appendChild(mf);

  const gh = section('🛠 GitHub (cloud coding)', 'A fine-grained token lets Jarvis start coding tasks on your repos and ship them when you approve. Repos also need the cloud coder set up (see README).');
  gh.append(field('GitHub token', 'githubToken', 'password', 'github_pat_…'), field('Project repos (one per line)', 'repos', 'textarea', 'owner/repo'));
  const gt = el('div', 'row'); const gb = el('button', 'btn', 'Test GitHub'); const gr = el('span', 'note'); gr.style.alignSelf = 'center';
  gb.onclick = async () => {
    gr.textContent = 'Checking…'; gr.className = 'note';
    try {
      const api = GH.client(S.githubToken); const me = await GH.whoami(api);
      const ready = await Promise.all(S.repos.map(async r => `${r.split('/')[1]}: ${await GH.hasCloudCoder(api, r) ? 'ready' : 'not set up'}`));
      gr.textContent = `✓ ${me.login} · ${ready.join(', ')}`; gr.className = 'ok';
    } catch (e) { gr.textContent = '✗ ' + e.message; gr.className = 'err'; }
  };
  gt.append(gb, gr); gh.appendChild(gt);

  const lp = section('💻 Laptop mode', S.laptopUrl ? `Paired with ${S.laptopUrl.replace(/^https?:\/\//, '')}` : 'Not paired yet.');
  // iPhone home-screen apps don't share storage with Safari, so pairing can be pasted here.
  if (S.laptopUrl && S.laptopToken) {
    // Safari and the home-screen app share the clipboard, so a paired Safari tab can hand pairing over.
    const cb = el('button', 'btn', '📋 Copy pairing for the home-screen app');
    cb.onclick = async () => {
      const link = `${location.origin}${location.pathname}#lh=${S.laptopUrl.replace(/^https?:\/\//, '')}&t=${S.laptopToken}`;
      try { await navigator.clipboard.writeText(link); cb.textContent = '✓ Copied. Now open the home-screen app, ⚙︎ Settings, paste and Pair'; }
      catch { cb.textContent = "Couldn't copy here"; }
    };
    lp.appendChild(cb);
  }
  const pfield = (label, hint) => {
    const f = el('label', 'field'); f.appendChild(el('span', null, label));
    const i = el('input'); i.placeholder = hint; i.autocapitalize = 'off'; i.autocomplete = 'off'; i.spellcheck = false; i.setAttribute('autocorrect', 'off');
    f.appendChild(i); lp.appendChild(f); return i;
  };
  const pi = pfield('Pairing link', 'Paste the link here');
  lp.appendChild(el('p', 'note', 'Or type the two lines that "npm run pair" shows on the laptop:'));
  const pAddr = pfield('Laptop address', 'e.g. yourlaptop.tailnet.ts.net');
  const pCode = pfield('Pairing code', 'The long code');
  const prow = el('div', 'row'); const pb = el('button', 'btn yes', 'Pair'); const pr = el('span', 'note'); pr.style.alignSelf = 'center';
  pb.onclick = async () => {
    let { url, t } = parsePairing(pi.value);
    if (!url && pAddr.value.trim()) url = parsePairing(pAddr.value).url || hostToUrl(pAddr.value.trim());
    if (!t && pCode.value.trim()) t = pCode.value.trim().replace(/^t=/, '').replace(/\s+/g, '');
    if (!url || !t) {
      pr.textContent = !t && url ? '✗ Found the laptop but not the code. Type the pairing code below.' : !t ? "✗ That doesn't look like the pairing link. Try typing the address and code instead." : '✗ Type the laptop address too.';
      pr.className = 'err'; return;
    }
    pr.textContent = 'Checking…'; pr.className = 'note';
    const old = { u: S.laptopUrl, t: S.laptopToken };
    S.laptopUrl = url.replace(/\/$/, ''); S.laptopToken = t;
    const st = await probeLaptop();
    if (st && !st.unauthorized) { S.mode = 'auto'; save(); pr.textContent = `✓ Paired with ${st.host}`; pr.className = 'ok'; pi.value = ''; pCode.value = ''; }
    else {
      S.laptopUrl = old.u; S.laptopToken = old.t;
      pr.textContent = st?.unauthorized ? '✗ The laptop rejected that code. Run setup again for a fresh QR.' : "✗ Can't reach the laptop. Is it on, with Tailscale on here too?";
      pr.className = 'err';
    }
  };
  prow.append(pb, pr); lp.appendChild(prow);
  const mf2 = el('label', 'field'); mf2.appendChild(el('span', null, 'Which mode to use')); const md = el('select');
  [['auto', 'Automatic (laptop when it\'s reachable)'], ['phone', 'Always phone mode'], ['laptop', 'Always laptop mode']].forEach(([v, l]) => { const o = el('option', null, l); o.value = v; md.appendChild(o); });
  md.value = S.mode; md.onchange = () => { S.mode = md.value; save(); }; mf2.appendChild(md); lp.appendChild(mf2);
  if (S.laptopUrl) { const un = el('button', 'btn no', 'Forget laptop'); un.onclick = () => { if (confirm('Forget the paired laptop?')) { S.laptopUrl = ''; S.laptopToken = ''; save(); openSettings(); } }; lp.appendChild(un); }

  const mem = section('🧠 What Jarvis knows about you', 'Used in phone mode. Edit freely; Jarvis adds to it when you say "remember…".');
  mem.appendChild(field('Memory', 'memory', 'textarea', 'e.g. I live in London. My partner is Gia. I like short answers.'));

  const danger = section('Chat history');
  const clr = el('button', 'btn no', 'Clear phone-mode chat'); clr.onclick = () => { if (confirm('Clear the phone-mode conversation?')) { phoneChat = []; ls.set('jarvis_phone_chat', []); feed.innerHTML = ''; } };
  danger.appendChild(clr);
}

// ---------- shared actions ----------
async function send(text) {
  text = (text || '').trim();
  if (!text || busy) return;
  input.value = ''; grow();
  if (mode === 'laptop') return sendLaptop(text);
  return sendPhone(text);
}
sendBtn.onclick = () => {
  if (!busy) return send(input.value);
  if (mode === 'laptop') lapi('/api/stop', { method: 'POST' }).catch(() => {});
  else { stopRequested = true; endSteps(); bubble('ai', 'Okay, stopped.'); setBusy(false); }
};
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); } });
const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px'; };
input.addEventListener('input', grow);
$('settingsBtn').onclick = openSettings;
$('tasksChip').onclick = () => showView(tasksEl.classList.contains('hidden') ? 'tasks' : 'chat');
$('project').onchange = e => { S.project = e.target.value; save(); };
$('modeChip').onclick = async () => {
  if (mode === 'laptop') { S.mode = 'phone'; save(); return boot(); }
  if (!S.laptopUrl) { alert('Laptop mode needs Jarvis running on your laptop. Run "npm run setup" there and scan its QR code.'); return; }
  S.mode = 'laptop'; save(); boot();
};
$('newchat').onclick = async () => {
  if (busy || !confirm(`Start a fresh conversation? ${S.name} forgets what you were just talking about (memory is kept).`)) return;
  if (mode === 'laptop') await lapi('/api/reset', { method: 'POST', body: JSON.stringify({ project: S.project || laptop?.defaultProject }) }).catch(() => {});
  else { phoneChat = []; ls.set('jarvis_phone_chat', []); }
  feed.innerHTML = ''; emptyState();
};
const voiceBtn = $('voice');
const paintVoice = () => { voiceBtn.classList.toggle('on', S.speak); voiceBtn.textContent = S.speak ? '🔊' : '🔈'; };
voiceBtn.onclick = () => { S.speak = !S.speak; save(); paintVoice(); if (S.speak) say("Okay, I'll read my replies out loud."); };
paintVoice();

// Hold-to-talk where supported (needs https, e.g. the GitHub Pages address); the keyboard mic works everywhere.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR && window.isSecureContext) {
  const mic = $('mic'); mic.classList.remove('hidden'); $('hint').textContent = 'Tap 🎤 and speak. It sends when you stop.';
  let rec = null;
  mic.onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = 'en-GB'; rec.interimResults = true;
    rec.onresult = e => { input.value = [...e.results].map(r => r[0].transcript).join(''); grow(); };
    rec.onend = () => { mic.classList.remove('rec'); rec = null; if (input.value.trim()) send(input.value); };
    rec.onerror = () => { mic.classList.remove('rec'); rec = null; };
    mic.classList.add('rec'); rec.start();
  };
}

// ---------- start ----------
async function boot() {
  feed.innerHTML = ''; $('offline').classList.add('hidden');
  if (es) { es.close(); es = null; }
  laptop = null; mode = 'phone';
  if (S.mode !== 'phone' && S.laptopUrl) {
    $('sub').textContent = 'Looking for your laptop…';
    const st = await probeLaptop();
    if (st?.unauthorized) bubble('ai', 'The laptop pairing code has changed. Scan the new QR code from "npm run setup".', null, true);
    else if (st) { laptop = st; mode = 'laptop'; }
    else if (S.mode === 'laptop') { $('offline').classList.remove('hidden'); $('orb').classList.add('off'); mode = 'laptop'; }
  }
  if (mode === 'laptop' && laptop) {
    const sel = $('project'); sel.innerHTML = '';
    laptop.projects.forEach(p => { const o = el('option', null, p === 'General' ? '💻 General' : '📁 ' + p); o.value = p; sel.appendChild(o); });
    if (!laptop.projects.includes(S.project)) S.project = laptop.defaultProject;
    sel.value = S.project;
    lastEvent = laptop.lastEvent;
    try { const h = await (await lapi('/api/history')).json(); h.slice(-30).forEach(m => bubble(m.role === 'user' ? 'me' : 'ai', m.text, null, m.ok === false)); } catch { /* none */ }
    setBusy(laptop.job.busy);
    if (laptop.job.busy) step(`Working on: ${laptop.job.text}`);
    connectLaptop();
    $('orb').classList.remove('off');
  } else if (mode === 'phone') {
    showPhoneHistory();
    $('orb').classList.toggle('off', !S.anthropicKey);
    setBusy(false);
    if (!S.anthropicKey && !S.laptopUrl) {
      bubble('ai', `Hi ${S.owner}! To get started, open ⚙︎ Settings and add your Anthropic API key. That switches on phone mode, so I work anywhere. Pair your laptop later for laptop mode.`);
    }
  }
  updateHeader();
  emptyState();
  feed.scrollTop = feed.scrollHeight;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && mode === 'laptop' && es && es.readyState === 2) connectLaptop(); });
boot();
