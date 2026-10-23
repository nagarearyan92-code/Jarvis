// GitHub helpers for phone mode: cloud coding tasks run by Claude Code in GitHub Actions.
// A task = an issue labelled "jarvis" whose body mentions @claude. Claude works on a branch and
// comments when done; shipping = open a PR from that branch and merge it.

const GH = 'https://api.github.com';
const encPath = b => String(b).split('/').map(encodeURIComponent).join('/');
export const LABEL = 'jarvis';

export function client(token) {
  return async function api(path, opts = {}) {
    const r = await fetch(GH + path, {
      ...opts,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (r.status === 204) return null;
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const e = new Error(j?.message ? `GitHub: ${j.message}` : `GitHub error ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return j;
  };
}

export async function whoami(api) { return api('/user'); }

export async function myRepos(api) {
  const list = await api('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator');
  return list.map(r => ({ full: r.full_name, private: r.private, pushed: r.pushed_at, description: r.description || '' }));
}

export async function hasCloudCoder(api, repo) {
  try { await api(`/repos/${repo}/contents/.github/workflows/claude.yml`); return true; } catch (e) { if (e.status === 404) return false; throw e; }
}

export async function startTask(api, repo, title, instructions) {
  try { await api(`/repos/${repo}/labels`, { method: 'POST', body: JSON.stringify({ name: LABEL, color: '5EE7DF', description: 'Started from Jarvis' }) }); } catch { /* exists */ }
  const issue = await api(`/repos/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title: title.slice(0, 120), labels: [LABEL], body: `@claude ${instructions}\n\n---\n_Started from Jarvis on my phone. Work on a branch; don't merge._` }),
  });
  return { repo, number: issue.number, url: issue.html_url, title: issue.title };
}

const isClaude = c => /^claude(\[bot\])?$/i.test(c.user?.login || '') || (c.user?.type === 'Bot' && /claude/i.test(c.user?.login || ''));

// Pulls the working branch out of Claude's comment ("compare/main...claude/issue-12-…" or a tree link).
export function branchFrom(text) {
  const m = String(text || '').match(/compare\/[^\s)]*?\.\.\.([^\s)?#"']+)/) || String(text || '').match(/\/tree\/(claude[^\s)?#"']+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function summarise(body) {
  const lines = String(body || '').split('\n')
    .filter(l => !/Claude (finished|is working|encountered)|View job|Create PR|^\s*-\s*\[[ x]\]|^\s*#{1,6}\s*(todo|tasks?)\b/i.test(l));
  return lines.join('\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/-{3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

export function taskStatus(issue, claudeComments) {
  if (issue.state === 'closed') return issue.state_reason === 'not_planned' ? 'discarded' : 'shipped';
  const last = claudeComments[claudeComments.length - 1];
  if (!last) return 'queued';
  const body = last.body || '';
  if (/encountered an error|error occurred|failed/i.test(body) && !/finished/i.test(body)) return 'failed';
  if (/finished/i.test(body)) return branchFrom(body) ? 'ready' : 'answered';
  return 'working';
}

export async function listTasks(api, repos) {
  const out = [];
  for (const repo of repos) {
    let issues = [];
    try { issues = await api(`/repos/${repo}/issues?labels=${LABEL}&state=all&per_page=10&sort=created&direction=desc`); } catch { continue; }
    for (const is of issues.filter(i => !i.pull_request)) {
      let comments = [];
      try { comments = await api(`/repos/${repo}/issues/${is.number}/comments?per_page=50`); } catch { /* ignore */ }
      const cl = comments.filter(isClaude);
      const last = cl[cl.length - 1];
      out.push({
        repo, number: is.number, title: is.title, url: is.html_url, created: is.created_at,
        status: taskStatus(is, cl),
        branch: last ? branchFrom(last.body) : null,
        summary: last ? summarise(last.body) : '',
      });
    }
  }
  return out.sort((a, b) => (a.created < b.created ? 1 : -1));
}

export async function defaultBranch(api, repo) { return (await api(`/repos/${repo}`)).default_branch || 'main'; }

export async function diffSummary(api, repo, branch) {
  const base = await defaultBranch(api, repo);
  const c = await api(`/repos/${repo}/compare/${encPath(base)}...${encPath(branch)}`);
  return {
    base, ahead: c.ahead_by, behind: c.behind_by,
    files: (c.files || []).map(f => ({ name: f.filename, add: f.additions, del: f.deletions, status: f.status })),
  };
}

// Opens (or reuses) a PR from the task branch and merges it. Merging into main = it ships.
export async function shipTask(api, repo, number, branch, title) {
  const base = await defaultBranch(api, repo);
  const owner = repo.split('/')[0];
  const open = await api(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(owner + ':' + branch)}`);
  const pr = open[0] || await api(`/repos/${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title: title || `Task #${number}`, head: branch, base, body: `Closes #${number}\n\nShipped from Jarvis.` }),
  });
  await api(`/repos/${repo}/pulls/${pr.number}/merge`, { method: 'PUT', body: JSON.stringify({ merge_method: 'squash' }) });
  try { await api(`/repos/${repo}/issues/${number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) }); } catch { /* closed by the PR */ }
  try { await api(`/repos/${repo}/git/refs/heads/${encPath(branch)}`, { method: 'DELETE' }); } catch { /* keep branch */ }
  return { pr: pr.number, url: pr.html_url };
}

export async function discardTask(api, repo, number) {
  await api(`/repos/${repo}/issues/${number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }) });
}

export async function reviseTask(api, repo, number, feedback) {
  await api(`/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body: `@claude ${feedback}` }) });
}

// ---- Gifts and notes for Gia ----
// Jarvis writes gifts to gifts.json in a private repo; Gia Mia reads it with a read-only key.
export const GIFT_TYPES = [
  ['flowers', '🌹', 'Flowers'], ['kisses', '💋', 'Kisses'], ['cuddles', '🤗', 'Cuddles'], ['chocolate', '🍫', 'Chocolate'],
  ['treat', '🍰', 'A treat'], ['thinking', '💭', 'Thinking of you'], ['note', '💌', 'Just a note'],
];
const b64e = s => { const b = new TextEncoder().encode(s); let bin = ''; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(bin); };
const b64d = s => new TextDecoder().decode(Uint8Array.from(atob(String(s).replace(/\s/g, '')), c => c.charCodeAt(0)));

export async function readGifts(api, repo) {
  try {
    const f = await api(`/repos/${repo}/contents/gifts.json`);
    return { sha: f.sha, gifts: JSON.parse(b64d(f.content)).gifts || [] };
  } catch (e) {
    if (e.status === 404) return { sha: null, gifts: [] };
    throw e;
  }
}

export async function sendGift(api, repo, { type, note }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { sha, gifts } = await readGifts(api, repo);
    const g = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type, note: (note || '').trim().slice(0, 300), sentAt: new Date().toISOString() };
    try {
      await api(`/repos/${repo}/contents/gifts.json`, {
        method: 'PUT',
        body: JSON.stringify({ message: `💌 ${type}`, content: b64e(JSON.stringify({ gifts: [...gifts, g].slice(-100) }, null, 1)), ...(sha ? { sha } : {}) }),
      });
      return g;
    } catch (e) {
      if (e.status === 409 && attempt === 0) continue; // changed at the same moment: try once more
      if (e.status === 404) throw new Error(`Can't reach ${repo}. Check the repo exists and your GitHub token in Settings includes it (Contents: read and write).`);
      throw e;
    }
  }
}

// The code Gia pastes into Gia Mia (Me → From Aryan): which repo, and a READ-ONLY key for it.
export const connectionCode = (repo, readOnlyToken) => 'gm1:' + btoa(JSON.stringify({ r: repo, t: readOnlyToken.trim() }));
