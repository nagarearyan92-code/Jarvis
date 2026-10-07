// A tiny event bus. Every update (progress, approvals, results) is numbered and kept for a while,
// so the phone can reconnect after losing signal and catch up on what it missed.
const listeners = new Set();
const recent = [];
let seq = 0;

export function emit(type, data = {}) {
  const ev = { id: ++seq, type, at: Date.now(), ...data };
  recent.push(ev);
  if (recent.length > 500) recent.shift();
  for (const fn of listeners) { try { fn(ev); } catch { /* ignore */ } }
  return ev;
}

export function since(id) { return recent.filter(e => e.id > id); }
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export const lastId = () => seq;

// ---- Approvals: the agent waits here until the phone says yes or no ----
const pending = new Map();
let nextApproval = 1;

export function requestApproval({ title, detail, risk = 'medium', timeoutMs = 10 * 60e3 }) {
  const id = String(nextApproval++);
  emit('approval', { approvalId: id, title, detail, risk });
  return new Promise(resolve => {
    const timer = setTimeout(() => settle(id, false, 'No answer within 10 minutes'), timeoutMs);
    pending.set(id, { resolve, timer });
  });
}

export function settle(id, allow, note = '') {
  const p = pending.get(String(id));
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(String(id));
  emit('approval-done', { approvalId: String(id), allow, note });
  p.resolve({ allow, note });
  return true;
}

export function denyAllPending(note) { for (const id of [...pending.keys()]) settle(id, false, note); }
export const pendingIds = () => [...pending.keys()];
