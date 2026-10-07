// Phone app for the laptop assistant. Talks to the laptop over Tailscale using the pairing token.
(() => {
  const $ = id => document.getElementById(id);
  const feed = $('feed'), input = $('input'), sendBtn = $('send');
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  // ---- pairing: the setup QR code opens this page with #t=<token> ----
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('t');
  if (fromHash) { store.set('token', fromHash); history.replaceState(null, '', location.pathname); }
  let token = store.get('token', '');
  window.addEventListener('hashchange', () => { if (/[#&]t=/.test(location.hash)) location.reload(); });

  let status = null, busy = false, es = null, lastEvent = 0, live = null, speak = store.get('speak', false);
  let project = store.get('project', '');
  const cards = {};        // approvalId -> element
  const lastSay = {};      // jobId -> last text shown

  const api = (path, opts = {}) => fetch(path, { ...opts, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(opts.headers || {}) } });

  // ---------- rendering ----------
  const atBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
  function add(el) { const stick = atBottom(); feed.querySelector('.empty')?.remove(); feed.appendChild(el); if (stick) feed.scrollTop = feed.scrollHeight; return el; }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function bubble(who, text, meta, fail) {
    const b = el('div', `msg ${who}${fail ? ' fail' : ''}`, text);
    if (meta) b.appendChild(el('div', 'meta', meta));
    return add(b);
  }
  function step(label) {
    if (live) live.classList.remove('live');
    live = add(el('div', 'step live', label));
  }
  function endSteps() { if (live) live.classList.remove('live'); live = null; }

  function emptyState() {
    if (feed.children.length) return;
    const box = el('div', 'empty');
    box.append(el('div', 'orb'), el('h2', null, `Hi ${status?.owner || ''}`.trim()), el('div', null, `What should ${status?.name || 'I'} do on ${status?.host || 'your laptop'}?`));
    const ideas = el('div', 'ideas');
    ['Add the book diary to Gia Mia', 'Fix the period tracker so it asks before marking a day', 'Open Spotify and set the volume to 40%', 'Send me my CV from Documents'].forEach(t => {
      const b = el('button', 'idea', t); b.onclick = () => { input.value = t; input.focus(); grow(); }; ideas.appendChild(b);
    });
    box.appendChild(ideas);
    feed.appendChild(box);
  }

  function approvalCard(ev) {
    const c = el('div', 'card' + (ev.risk === 'high' ? ' high' : ''));
    c.appendChild(el('h4', null, (ev.risk === 'high' ? '⚠️ ' : '') + ev.title + '?'));
    if (ev.detail) c.appendChild(el('pre', null, ev.detail));
    const row = el('div', 'row');
    const yes = el('button', 'btn yes', 'Approve'), no = el('button', 'btn no', 'Deny');
    const answer = async allow => {
      row.replaceWith(el('div', 'done', allow ? 'Approving…' : 'Denying…'));
      try { await api('/api/approve', { method: 'POST', body: JSON.stringify({ id: ev.approvalId, allow }) }); } catch { /* event will tell */ }
    };
    yes.onclick = () => answer(true); no.onclick = () => answer(false);
    row.append(no, yes); c.appendChild(row);
    cards[ev.approvalId] = c;
    if (navigator.vibrate) navigator.vibrate(80);
    return add(c);
  }

  function fileCard(ev) {
    const url = `/api/files/${ev.fileId}?t=${encodeURIComponent(token)}`;
    const c = el('div', 'card');
    const a = el('a', 'file'); a.href = url; a.target = '_blank'; a.rel = 'noopener';
    a.appendChild(el('div', null, `📎 ${ev.name} · ${Math.max(1, Math.round(ev.size / 1024))} KB`));
    if (/\.(png|jpe?g|gif|webp)$/i.test(ev.name)) { const img = el('img'); img.src = url; img.alt = ev.name; a.appendChild(img); }
    c.appendChild(a);
    return add(c);
  }

  function setBusy(b) {
    busy = b;
    $('orb').classList.toggle('busy', b);
    sendBtn.textContent = b ? 'Stop' : '↑';
    sendBtn.classList.toggle('stop', b);
    sendBtn.setAttribute('aria-label', b ? 'Stop' : 'Send');
    updateSub();
  }
  function updateSub() {
    if (!status) return;
    const money = `$${(status.spent || 0).toFixed(2)} of $${status.budget.monthlyUsd} this month`;
    $('sub').textContent = (busy ? 'Working… · ' : `${status.host} · `) + money + (status.mock ? ' · practice mode' : '');
  }
  function say(text) {
    if (!speak || !('speechSynthesis' in window) || !text) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[`*_#>]/g, '').slice(0, 700));
    u.lang = 'en-GB'; speechSynthesis.speak(u);
  }

  // ---------- events from the laptop ----------
  function onEvent(ev) {
    lastEvent = Math.max(lastEvent, ev.id);
    switch (ev.type) {
      case 'start':
        if (pendingMine === ev.text) pendingMine = null; else bubble('me', ev.text, ev.project !== project ? ev.project : null);
        setBusy(true); break;
      case 'step': step(ev.label); break;
      case 'say': endSteps(); lastSay[ev.jobId] = ev.text; bubble('ai', ev.text); break;
      case 'approval': endSteps(); approvalCard(ev); break;
      case 'approval-done': {
        const c = cards[ev.approvalId];
        if (c) { c.querySelector('.row')?.remove(); const d = c.querySelector('.done') || c.appendChild(el('div', 'done')); d.textContent = ev.allow ? '✓ Approved' : `✗ Denied${ev.note && ev.note !== 'Aryan said no.' ? ' · ' + ev.note : ''}`; }
        break;
      }
      case 'file': fileCard(ev); break;
      case 'stopping': step('Stopping…'); break;
      case 'result': {
        endSteps();
        const meta = ev.cost ? `$${ev.cost.toFixed(2)}` : null;
        if (status && ev.spentThisMonth != null) status.spent = ev.spentThisMonth;
        if (ev.text && ev.text !== lastSay[ev.jobId]) bubble('ai', ev.text, meta, !ev.ok);
        else if (meta) feed.lastElementChild?.appendChild(el('div', 'meta', meta));
        setBusy(false); say(ev.text); break;
      }
      case 'reset': add(el('div', 'step', `New conversation${ev.project ? ' · ' + ev.project : ''}`)); break;
    }
  }

  function connect() {
    if (es) es.close();
    es = new EventSource(`/api/events?t=${encodeURIComponent(token)}&since=${lastEvent}`);
    es.onmessage = m => { try { onEvent(JSON.parse(m.data)); } catch { /* ignore */ } };
    es.onopen = () => { $('offline').classList.add('hidden'); $('orb').classList.remove('off'); };
    es.onerror = () => { setTimeout(() => { if (es.readyState !== 1) { $('offline').classList.remove('hidden'); $('orb').classList.add('off'); } }, 3000); };
  }

  // ---------- actions ----------
  let pendingMine = null;
  async function send(text) {
    text = (text || '').trim();
    if (!text) return;
    if (busy) return;
    bubble('me', text); pendingMine = text; input.value = ''; grow();
    try {
      const r = await api('/api/command', { method: 'POST', body: JSON.stringify({ text, project }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); pendingMine = null; bubble('ai', j.error || 'The laptop said no.', null, true); }
    } catch { pendingMine = null; bubble('ai', "Couldn't reach the laptop. Check it's on and Tailscale is connected.", null, true); }
  }
  sendBtn.onclick = () => (busy ? api('/api/stop', { method: 'POST' }) : send(input.value));
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); } });
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px'; };
  input.addEventListener('input', grow);
  document.querySelectorAll('[data-cmd]').forEach(b => { b.onclick = () => send(b.dataset.cmd); });
  $('project').onchange = e => { project = e.target.value; store.set('project', project); };
  $('newchat').onclick = async () => {
    if (busy) return;
    if (!confirm(`Start a fresh conversation for ${project}? ${status?.name || 'It'} will forget what you were just talking about.`)) return;
    await api('/api/reset', { method: 'POST', body: JSON.stringify({ project }) });
  };
  const voiceBtn = $('voice');
  const paintVoice = () => { voiceBtn.classList.toggle('on', speak); voiceBtn.textContent = speak ? '🔊' : '🔈'; };
  voiceBtn.onclick = () => { speak = !speak; store.set('speak', speak); paintVoice(); if (speak) say('Okay, I\'ll read my replies out loud.'); };
  paintVoice();

  // Hold-to-talk where the browser supports it (needs https); otherwise the keyboard mic works everywhere.
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
  function pairScreen(msg) {
    $('footer').classList.add('hidden'); $('bar').classList.add('hidden');
    $('sub').textContent = 'Not paired yet';
    feed.innerHTML = '';
    const box = el('div', 'pair');
    box.append(el('div', 'orb'), el('h2', null, 'Pair your phone'),
      el('div', null, msg || 'On the laptop, run "npm run setup" and scan the QR code with your iPhone camera. Or paste the pairing code here:'));
    const inp = el('input'); inp.placeholder = 'Pairing code'; inp.autocapitalize = 'off'; inp.autocomplete = 'off';
    const go = el('button', 'btn yes', 'Pair');
    go.onclick = () => { token = inp.value.trim(); store.set('token', token); location.reload(); };
    box.append(inp, go); box.querySelector('.orb').style.margin = '0 auto 16px'; box.querySelector('.orb').style.width = box.querySelector('.orb').style.height = '64px';
    feed.appendChild(box);
  }

  async function boot() {
    if (!token) return pairScreen();
    let r;
    try { r = await api('/api/status'); } catch { $('offline').classList.remove('hidden'); $('sub').textContent = 'Offline'; setTimeout(boot, 5000); return; }
    if (r.status === 401) return pairScreen('That pairing code didn\'t work. Scan the QR code from "npm run setup" again.');
    status = await r.json();
    document.title = status.name; $('name').textContent = status.name;
    input.placeholder = `Tell ${status.name} what to do…`;
    const sel = $('project'); sel.innerHTML = '';
    status.projects.forEach(p => { const o = el('option', null, p === 'General' ? '💻 General' : '📁 ' + p); o.value = p; sel.appendChild(o); });
    if (!status.projects.includes(project)) project = status.defaultProject;
    sel.value = project;
    lastEvent = status.lastEvent;
    try {
      const h = await (await api('/api/history')).json();
      h.slice(-30).forEach(m => bubble(m.role === 'user' ? 'me' : 'ai', m.text, null, m.ok === false));
    } catch { /* no history */ }
    emptyState();
    setBusy(status.job.busy);
    if (status.job.busy) step(`Working on: ${status.job.text}`);
    $('orb').classList.remove('off');
    feed.scrollTop = feed.scrollHeight;
    connect();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && token && es && es.readyState === 2) connect(); });
  boot();
})();
