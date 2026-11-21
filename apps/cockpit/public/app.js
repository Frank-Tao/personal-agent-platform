let GROUPS = []; // portfolios, set from the server's rollup (r.ui.groups) on every render
const gName = (id) => GROUPS.find((g) => g.id === id)?.name ?? id;
const gOf = (p) => p.group ?? GROUPS[1]?.id ?? 'micropace';
const RANK = { alert: 3, warn: 2, ok: 1, unknown: 0 };
const STATE_WORD = { ok: 'Healthy', warn: 'Needs attention', alert: 'Problem', unknown: 'Unknown' };
const STATE_MARK = { ok: '●', warn: '▲', alert: '✕', unknown: '○' }; // shape + word, never colour alone
const SOURCE_LABEL = { telegram: 'Telegram', cron: 'Scheduled job', oneshot: 'One-shot', cli: 'CLI', api_server: 'Dashboard / API', whatsapp: 'WhatsApp', discord: 'Discord', webhook: 'Webhook' };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => '$' + (c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
const usd = (v) => '$' + v.toFixed(2);
const compact = (n) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
const full = (n) => n.toLocaleString('en-US');
const arrow = { up: '▲', down: '▼', flat: '▬' };
const ago = (iso) => { if (!iso) return '—'; const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
const short = (iso) => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const dayLabel = (d) => new Date(d + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
const worst = (xs) => xs.reduce((w, s) => RANK[s] > RANK[w] ? s : w, 'unknown');
const chanState = (s) => ({ connected: 'ok', running: 'ok', connecting: 'warn', retrying: 'warn' }[s] || 'alert');
const chanName = (n) => n === 'telegram' ? 'Atlas' : n.replace(/:telegram$/, '');
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window: preferences just don't persist */ } },
};

const state = { needTab: 'all', sliceTab: 'portfolio', sliceTable: false, fbOpen: false, r: null, q: '', table: false, chatOpen: store.get('chatOpen', '') === '1', cw: 640, split: store.get('split', 'type') };

/* ---------- small components ---------- */
function bar(spent, budget) {
  const pct = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
  const cls = pct >= 90 ? 'hot' : pct >= 75 ? 'warm' : '';
  return `<div class="bar ${cls}"><i style="width:${pct}%"></i></div>
          <div class="row"><span>${money(spent)} of ${money(budget)}</span><span>${pct}%</span></div>`;
}
function pctBar(pct) {
  const cls = pct >= 100 ? 'hot' : pct >= 85 ? 'warm' : '';
  return `<div class="bar ${cls}" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.min(100, pct)}%"></i></div>`;
}
function spark(runs) {
  if (!runs || runs.length < 2) return '';
  const max = Math.max(1, ...runs.map((r) => r.total));
  const w = 200, h = 36, step = w / (runs.length - 1);
  const pts = runs.map((r, i) => `${(i * step).toFixed(1)},${(h - 2 - (r.total / max) * (h - 6)).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:36px;display:block;margin-top:8px" role="img" aria-label="run activity">
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}
function card(p) {
  const metrics = p.metrics.map((m) =>
    `<div class="metric"><b>${esc(m.value)} ${m.trend ? `<small class="${m.trend}">${arrow[m.trend]}</small>` : ''}</b><span>${esc(m.label)}</span></div>`).join('');
  const earn = p.earnings ? `<div class="metric"><b>${money(p.earnings.monthCents)}</b><span>Earned this month</span></div>` : '';
  const agents = p.agents ? `<div class="row"><span>Agents</span><span>${p.agents.active} active · ${p.agents.running} running${p.agents.error ? ` · <b class="sev-alert">${p.agents.error} error</b>` : ''}</span></div>` : '';
  const tasks = p.tasks ? `<div class="row"><span>Tasks</span><span>${p.tasks.inProgress} doing · ${p.tasks.open} open${p.tasks.blocked ? ` · <b class="sev-warn">${p.tasks.blocked} blocked</b>` : ''}</span></div>` : '';
  const spend = p.spend && p.spend.budgetCents ? bar(p.spend.spentCents, p.spend.budgetCents) : '';
  return `<article class="card ${p.status}">
    <h3><span>${esc(p.name)}</span><span class="tag">${esc(p.source)}</span></h3>
    <div class="headline"><span class="dot ${p.status}"></span> ${esc(p.headline)}</div>
    <div class="metrics">${earn}${metrics}</div>${agents}${tasks}${spend}${spark(p.runs)}</article>`;
}
const NEED_CATS = [['all', 'All'], ['charter', 'Charters'], ['review', 'Reviews'], ['feedback', 'Feedback'], ['blocked', 'Blocked'], ['failing', 'Failing'], ['owner', 'Needs an owner'], ['other', 'Other']];
function needCat(n) {
  if (/^Feedback proposal/.test(n.title)) return 'feedback';
  if (/^Approve project charter/.test(n.title)) return 'charter';
  return { approval: 'review', blocker: 'blocked', alert: 'failing', staffing: 'owner' }[n.kind] ?? 'other';
}
/** Where to go to resolve an item: its project, the charter to approve, the feedback page, or its portfolio. */
function needsHref(r, n) {
  const t = n.title;
  if (n.act?.project) return '#/project/' + n.act.project + (n.act.kind === 'approve-charter' ? '/approve' : '');
  if (n.act?.kind === 'decisions') return '#/decisions';
  if (/^Feedback proposal/.test(t)) return '#/feedback';
  let m = t.match(/charter: ([a-z0-9-]+)/); if (m) return '#/project/' + m[1] + '/approve';
  m = t.match(/(?:paused by the watchdog: |finished project: )([a-z0-9-]+)/); if (m) return '#/project/' + m[1];
  m = t.match(/\[([a-z0-9-]+)\]/); if (m && (state.projects ?? []).some((p) => p.id === m[1])) return '#/project/' + m[1];
  const g = n.task?.portfolio ?? r.portfolios.find((c) => c.id === n.portfolioId)?.group;
  return GROUPS.some((x) => x.id === g) ? '#/g/' + g : n.portfolioId === 'atlas' ? '#/jobs' : null;
}
function needsList(r, items) {
  const names = Object.fromEntries(r.portfolios.map((p) => [p.id, p.name])); names.atlas = 'Atlas';
  if (!items.length) return '<span class="muted">Nothing needs you in this view.</span>';
  const acts = (n) => {
    if (n.mail) return mailActs(n.mail, snoozeBtn(n));
    if (n.act) return actButtons(n, snoozeBtn(n));
    if (!n.task) return snoozeBtn(n) ? `<span class="nact">${snoozeBtn(n)}</span>` : '';
    const ask = `Task ${n.task.id} on ${gName(n.task.portfolio)} has no owner. ${n.title} Evaluate whether our current agents cover it; if not, propose a new agent from the agency-agents catalog and which model it should run on, and ask me to confirm before creating anything.`;
    return `<span class="nact"><button type="button" data-ask="${esc(ask)}">Ask Atlas</button><select data-assign-for="${esc(n.task.id)}" aria-label="Assign to">${agentOptions(r, n.task.portfolio)}</select><button type="button" data-assign="${esc(n.task.id)}" data-portfolio="${esc(n.task.portfolio)}">Assign</button>${snoozeBtn(n)}</span>`;
  };
  return '<ul class="plain needs">' + items.map((n) => { const href = needsHref(r, n), mark = n.severity === 'alert' ? '✕ ' : n.severity === 'warn' ? '▲ ' : '';
    return `<li><span class="tag">${esc(names[n.portfolioId] ?? n.portfolioId)}</span>
    <span class="sev-${n.severity}" style="flex:1;min-width:0">${mark}${href ? `<a class="nlink" href="${esc(href)}" title="Open to resolve">${esc(needTitle(n))}</a>` : esc(needTitle(n))}</span>${n.dueAt ? ` <span class="muted">due ${esc(n.dueAt)}</span>` : ''}${acts(n)}</li>`; }).join('') + '</ul>';
}
/* Answers in one tap. The words match the daily digest (packages/needs/needs.ts ANSWERS); "Not now" hides the item for a day. Owner only. */
const ANSWERS = { 'approve-charter': ['Approve', 'Not now'], 'auto-start': ['Start now', 'Stop: make it semi'], 'close-project': ['Mark done', 'Not now'], 'resume-project': ['Resume', 'Not now'], outbox: ['Release', 'Deny'], mail: ['Send', 'Deny'], decisions: ['Confirm all', 'Not now'] };
/** Terminal hints like "(work project approve x --apply)" are noise where there is a button for it. */
const needTitle = (n) => (n.act || n.mail) ? n.title.replace(/\s*\((?:work|npm|hermes) [^)]*\)/g, '') : n.title;
function actButtons(n, extra = '') {
  if (!decOwner() || !ANSWERS[n.act.kind]) return '';
  const [yes, no] = ANSWERS[n.act.kind], a = esc(JSON.stringify(n.act));
  return `<span class="nact"><button type="button" class="primary" data-need-act="yes" data-a="${a}">${yes}</button><button type="button" data-need-act="no" data-a="${a}">${no}</button>${extra}</span>`;
}
function snoozeBtn(n) {
  if (!decOwner() || !n.key) return '';
  return `<select data-snooze="${esc(n.key)}" aria-label="Snooze" title="Hide it for a while; it comes back by itself"><option value="">Snooze…</option><option value="1">1 day</option><option value="3">3 days</option><option value="7">1 week</option></select>`;
}
async function answerNeed(act, answer, quiet) {
  const res = await postJson('/api/needs/act', { act, answer }).catch((err) => ({ ok: false, status: 0, json: async () => ({ error: err.message }) }));
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { flash(j.error || 'Not done (HTTP ' + res.status + ')', 'err', false, 9000); return false; }
  if (!quiet) flash(((j.output || '').split('\n').find((l) => l.includes('✓ done')) || 'Done.').replace(/^\s*✓\s*/, ''), 'ok', false, 5000);
  return true;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest?.('[data-need-act]'); if (!b) return;
  const act = JSON.parse(b.dataset.a), answer = b.dataset.needAct;
  if (answer === 'no' && ['outbox', 'mail'].includes(act.kind) && !confirm('Deny it? It will not go out.')) return;
  b.disabled = true; b.closest('.nact')?.querySelectorAll('button').forEach((x) => { x.disabled = true; });
  if (await answerNeed(act, answer)) { state.projects = null; void load(true); } else b.closest('.nact')?.querySelectorAll('button').forEach((x) => { x.disabled = false; });
});
document.addEventListener('change', async (e) => {
  const s = e.target.closest?.('[data-snooze]'); if (!s || !s.value) return;
  const days = Number(s.value); s.disabled = true;
  const res = await postJson('/api/needs/snooze', { key: s.dataset.snooze, days }).catch(() => ({ ok: false, status: 0 }));
  if (!res.ok) { flash('Could not snooze it (HTTP ' + res.status + ')', 'err', false, 6000); s.disabled = false; s.value = ''; return; }
  flash(`Snoozed for ${days === 7 ? 'a week' : days + ' day' + (days === 1 ? '' : 's')}. It comes back by itself.`, 'ok', false, 4000); void load(true);
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest?.('[data-approve-all]'); if (!b) return;
  const items = (state.r?.needsYou ?? []).filter((n) => n.act?.kind === 'approve-charter');
  if (!items.length || !confirm(`Approve these ${items.length} projects? pm plans each one and agents start.\n\n` + items.map((n) => '• ' + n.act.project).join('\n'))) return;
  b.disabled = true; let ok = 0;
  for (const n of items) { b.textContent = `Approving ${ok + 1} of ${items.length}…`; if (await answerNeed(n.act, 'yes', true)) ok++; }
  flash(`Approved ${ok} of ${items.length} projects.`, ok === items.length ? 'ok' : 'err', false, 7000); state.projects = null; void load(true);
});
/** An email an agent was not allowed to send by itself: read it, then Send or Deny (owner only; others only see that it waits). */
function mailActs(m, extra = '') {
  const read = `<details class="mailbody"><summary>Read</summary><div class="muted">From ${esc(m.by)} to ${esc(m.to.join(', '))}</div><pre>${esc(m.body)}</pre></details>`;
  if (!decOwner()) return `<span class="nact">${read}</span>`;
  return `<span class="nact">${read}<button type="button" class="primary" data-mail-act="release" data-id="${esc(m.id)}">Send</button><button type="button" data-mail-act="deny" data-id="${esc(m.id)}">Deny</button>${extra}</span>`;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest?.('[data-mail-act]'); if (!b) return;
  const action = b.dataset.mailAct;
  const reason = action === 'deny' ? window.prompt('Why not send it? (optional, the agent sees this)') : '';
  if (reason === null) return;
  b.disabled = true;
  const res = await postJson('/api/mail/act', { action, id: b.dataset.id, reason }).catch((err) => ({ ok: false, status: 0, json: async () => ({ error: err.message }) }));
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { flash(j.error || 'Not done (HTTP ' + res.status + ')', 'err', false, 9000); b.disabled = false; return; }
  flash(action === 'release' ? 'Sent.' : 'Denied: it will not be sent.', 'ok', false, 4000); void load(true);
});
/** The Needs-you list with a tab per category. `limit` caps the rows (overview); the full page passes none. */
const decideNow = (n) => !!n.act || !!n.mail || !!n.task || n.kind === 'approval' || n.severity === 'alert';
function needsPanel(r, limit) {
  const view = state.needView ?? 'decide';
  const nDecide = r.needsYou.filter(decideNow).length, nFyi = r.needsYou.length - nDecide;
  const all = r.needsYou.filter((n) => view === 'decide' ? decideNow(n) : !decideNow(n)), count = (k) => k === 'all' ? all.length : all.filter((n) => needCat(n) === k).length;
  const tab = NEED_CATS.some(([k]) => k === state.needTab && count(k)) ? state.needTab : 'all';
  const shown = all.filter((n) => tab === 'all' || needCat(n) === tab);
  const tabs = NEED_CATS.filter(([k]) => k === 'all' || count(k)).map(([k, n]) => `<button type="button" data-needtab="${k}" aria-pressed="${tab === k}">${n}<span class="n">${count(k)}</span></button>`).join('');
  const charters = r.needsYou.filter((n) => n.act?.kind === 'approve-charter').length;
  const top = `<div class="toolbar"><span class="seg" role="group" aria-label="Show"><button type="button" data-needview="decide" aria-pressed="${view === 'decide'}">Decide now <span class="n">${nDecide}</span></button><button type="button" data-needview="fyi" aria-pressed="${view === 'fyi'}">For your information <span class="n">${nFyi}</span></button></span>${view === 'decide' && charters > 1 && decOwner() ? `<button type="button" data-approve-all="1">Approve all ${charters} projects…</button>` : ''}${r.snoozed ? `<span class="muted">${r.snoozed} snoozed</span>` : ''}</div>`;
  return `${top}<div class="tabs" role="group" aria-label="Category">${tabs}</div>${needsList(r, limit ? shown.slice(0, limit) : shown)}${limit && shown.length > limit ? `<div style="margin-top:8px"><a href="#/needs">${shown.length - limit} more →</a></div>` : ''}`;
}
function hbars(rows, cls = '') {
  const max = Math.max(1, ...rows.map((x) => x.value));
  return rows.length ? `<div class="hbars ${cls}">${rows.map((x) => `<span>${esc(x.label)}</span><div><div class="bar" style="width:${Math.max(2, Math.round(100 * x.value / max))}%${x.color ? ';background:' + x.color : ''}"></div></div><span class="v">${x.text ?? x.value}</span>`).join('')}</div>` : '<div class="muted">Nothing to show.</div>';
}
const hrs = (h) => h === null || h === undefined ? '—' : h < 1 ? Math.round(h * 60) + ' min' : h < 48 ? h.toFixed(h < 10 ? 1 : 0) + ' h' : Math.round(h / 24) + ' d';
const KIND_WORD = { approval: 'Approvals & reviews', blocker: 'Blocked', alert: 'Failing', staffing: 'Needs an owner', deadline: 'Deadlines' };
/** Metrics for the Needs-you page: open now by portfolio and by category, and how long items took to be resolved. */
function needsMetrics(r) {
  const byP = {}, byC = {};
  for (const n of r.needsYou) { const g = r.portfolios.find((c) => c.id === n.portfolioId)?.group ?? n.task?.portfolio ?? n.portfolioId; byP[g] = (byP[g] ?? 0) + 1; byC[needCat(n)] = (byC[needCat(n)] ?? 0) + 1; }
  const st = r.needsStats;
  const prow = Object.entries(byP).sort((a, b) => b[1] - a[1]).map(([g, v]) => ({ label: g === 'atlas' ? 'Atlas & feedback' : gName(g), value: v }));
  const crow = NEED_CATS.filter(([k]) => byC[k]).map(([k, n]) => ({ label: n, value: byC[k], color: k === 'failing' || k === 'blocked' ? 'var(--warn)' : undefined }));
  const hrow = st ? Object.entries(st.resolveHours).filter(([, v]) => v.count).sort((a, b) => (b[1].medianHours ?? 0) - (a[1].medianHours ?? 0)).map(([k, v]) => ({ label: KIND_WORD[k] ?? k, value: v.medianHours ?? 0, text: hrs(v.medianHours) + ' · ' + v.count })) : [];
  return `<section class="panel" style="margin-top:0"><h2>Open now, by portfolio</h2>${hbars(prow)}</section>
    <section class="panel"><h2>Open now, by category</h2>${hbars(crow)}</section>
    <section class="panel"><h2>Time to resolve<span class="right muted">median · items</span></h2>${hbars(hrow)}
      <div class="muted" style="margin-top:8px">${st ? `${st.resolved} resolved since ${esc(String(st.since ?? '').slice(0, 10))}${st.oldestOpenHours !== null ? ` · oldest open item has waited ${hrs(st.oldestOpenHours)}` : ''}` : 'Not tracked yet.'}</div></section>`;
}
/** A cron expression or Hermes interval in plain English. Anything it does not understand is shown as written. */
function cronText(sch) {
  if (!sch) return '—';
  const iv = sch.match(/^every (\d+)m$/);
  if (iv) { const n = +iv[1]; return n % 1440 === 0 ? (n === 1440 ? 'Every day' : `Every ${n / 1440} days`) : n % 60 === 0 ? `Every ${n / 60} hours` : `Every ${n} minutes`; }
  const f = sch.trim().split(/\s+/); if (f.length !== 5) return sch;
  const [mi, h, dom, mon, dow] = f, two = (x) => String(x).padStart(2, '0');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  if (!/^\d+$/.test(mi) || !/^\d+$/.test(h)) return /^\*\/\d+$/.test(mi) && h === '*' ? `Every ${mi.slice(2)} minutes` : sch;
  const at = `${two(h)}:${two(mi)}`;
  if (mon !== '*') return sch;
  if (dom !== '*') { if (!/^\d+$/.test(dom)) return sch; const n = +dom, suf = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10 < 4 ? n % 10 : 0]; return `${n}${suf} of every month at ${at}`; }
  if (dow === '*') return `Every day at ${at}`;
  if (dow === '1-5') return `Weekdays at ${at}`;
  if (dow === '0,6' || dow === '6,0') return `Weekends at ${at}`;
  return `Every ${dow.split(',').map((x) => /^\d$/.test(x) ? days[+x] : x).join(' and ')} at ${at}`;
}
/** One square per run in the last 7 days: green ran and was handled, amber ran with a problem or never finished, red failed. Hover for date, time and what happened. */
function histBar(h) {
  if (!h || !h.length) return '<span class="muted">no runs</span>';
  const shown = h.slice(-48), bad = h.filter((x) => x.status === 'alert').length, warn = h.filter((x) => x.status === 'warn').length;
  return `<span class="hist">${shown.map((x) => `<i class="${x.status === 'ok' ? '' : x.status}" title="${esc(new Date(x.at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}: ${esc(x.note)}" aria-label="${esc(x.status)}"></i>`).join('')}</span> <span class="muted" style="font-size:11px">${h.length} runs${bad ? ` · <b class="sev-alert">${bad} failed</b>` : ''}${warn ? ` · <b class="sev-warn">${warn} amber</b>` : ''}</span>`;
}
function jobsTable(jobs) {
  if (!jobs.length) return '<div class="empty">No scheduled jobs found.</div>';
  const rows = [...jobs].sort((x, y) => (y.enabled - x.enabled) || (Date.parse(x.nextRunAt || '') || Infinity) - (Date.parse(y.nextRunAt || '') || Infinity) || x.name.localeCompare(y.name));
  return `<div class="tablewrap"><table><thead><tr><th>Status</th><th>Job</th><th>Profile</th><th>Section</th><th>Schedule</th><th>Last 7 days</th><th>Last run</th><th>Next run</th></tr></thead><tbody>` +
    rows.map((j) => {
      const st = !j.enabled ? ['unknown', 'Paused'] : j.lastStatus === 'error' ? ['alert', 'Failed'] : j.lastStatus === 'ok' ? ['ok', 'OK'] : ['unknown', 'Not run yet'];
      return `<tr><td><span class="dot ${st[0]}"></span> ${st[1]}</td><td>${esc(j.name)}</td><td>${esc(j.profile)}</td><td>${esc(j.group ?? '—')}</td>
        <td>${esc(cronText(j.schedule))}<span class="cronx">${esc(j.schedule || '')}</span></td><td>${histBar(j.history)}</td><td>${esc(short(j.lastRunAt))}</td><td>${j.enabled ? esc(short(j.nextRunAt)) : '—'}</td></tr>`;
    }).join('') + '</tbody></table></div>';
}
function trafficTable(u) {
  if (!u.recent.length) return '<div class="empty">No conversations yet.</div>';
  return `<div class="tablewrap"><table><thead><tr><th>When</th><th>Channel</th><th>Profile</th><th>Model</th><th class="num">Tokens</th></tr></thead><tbody>` +
    u.recent.map((s) => `<tr><td>${esc(ago(s.at))}</td><td>${esc(SOURCE_LABEL[s.source] ?? s.source)}</td><td>${esc(s.profile)}</td><td>${esc(s.model)}</td><td class="num">${full(s.tokens)}</td></tr>`).join('') + '</tbody></table></div>';
}

/* ---------- token chart: stacked bars, split by type / channel / agent ---------- */
function niceMax(v) { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const f = v / p; return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((x) => f <= x)) * p; }
function topRound(x, y, w, h, r) { r = Math.min(r, h, w / 2); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; }
const projLabel = (id) => id === '_none' ? 'No project (chat, jobs)' : id.includes(':(no project)') ? gName(id.split(':')[0]) + ' (no project)' : id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const agentName = (p) => p === 'default' ? 'Atlas' : p;
const CHANNEL_SLOTS = ['telegram', 'cron', 'api_server', 'oneshot', 'cli', 'whatsapp']; // fixed: a channel keeps its colour
/** Series for a split mode: [{ key, label, color, value(day) }], bottom of the stack first. Colour follows the entity, never its rank. */
function seriesFor(days, mode) {
  const total = (get) => days.reduce((n, d) => n + get(d), 0);
  const mk = (key, label, color, get) => ({ key, label, color, value: get });
  if (mode === 'channel') {
    const sources = [...new Set(days.flatMap((d) => Object.keys(d.bySource)))];
    const named = CHANNEL_SLOTS.filter((k) => sources.includes(k));
    const rest = sources.filter((k) => !CHANNEL_SLOTS.includes(k));
    const out = named.filter((k) => total((d) => d.bySource[k] ?? 0) > 0).map((k) => mk(k, SOURCE_LABEL[k] ?? k, `var(--s${CHANNEL_SLOTS.indexOf(k) + 1})`, (d) => d.bySource[k] ?? 0));
    if (rest.length && total((d) => rest.reduce((n, k) => n + (d.bySource[k] ?? 0), 0)) > 0) out.push(mk('other', 'Other channels', 'var(--sx)', (d) => rest.reduce((n, k) => n + (d.bySource[k] ?? 0), 0)));
    return out;
  }
  if (mode === 'portfolio') {
    const ids = [...GROUPS.map((g) => g.id), '_none'];
    return ids.filter((k) => total((d) => d.byPortfolio?.[k] ?? 0) > 0).map((k, i) => mk(k, k === '_none' ? 'No project (chat, jobs)' : gName(k), k === '_none' ? 'var(--unknown)' : `var(--s${i + 1})`, (d) => d.byPortfolio?.[k] ?? 0));
  }
  if (mode === 'project') {
    const ids = [...new Set(days.flatMap((d) => Object.keys(d.byProject ?? {})))].filter((k) => k !== '_none').sort((a, b) => total((d) => d.byProject[b] ?? 0) - total((d) => d.byProject[a] ?? 0));
    const named = ids.slice(0, 6), rest = ids.slice(6);
    const out = named.map((k, i) => mk(k, projLabel(k), `var(--s${i + 1})`, (d) => d.byProject[k] ?? 0));
    if (rest.length) out.push(mk('other', 'Other projects', 'var(--sx)', (d) => rest.reduce((n, k) => n + (d.byProject[k] ?? 0), 0)));
    if (total((d) => d.byProject._none ?? 0) > 0) out.push(mk('_none', 'No project (chat, jobs)', 'var(--unknown)', (d) => d.byProject._none ?? 0));
    return out.filter((x) => total(x.value) > 0);
  }
  if (mode === 'agent') {
    const profiles = [...new Set(days.flatMap((d) => Object.keys(d.byProfile)))].sort((a, b) => a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b));
    const named = profiles.slice(0, 6), rest = profiles.slice(6);
    const out = named.filter((k) => total((d) => d.byProfile[k] ?? 0) > 0).map((k, i) => mk(k, agentName(k), `var(--s${i + 1})`, (d) => d.byProfile[k] ?? 0));
    if (rest.length) out.push(mk('other', 'Other agents', 'var(--sx)', (d) => rest.reduce((n, k) => n + (d.byProfile[k] ?? 0), 0)));
    return out;
  }
  return [mk('chat', 'Chat (Telegram, dashboard)', 'var(--s1)', (d) => d.chat), mk('jobs', 'Scheduled jobs', 'var(--s2)', (d) => d.jobs), mk('other', 'Other (CLI, one-shot)', 'var(--s3)', (d) => d.other)];
}
function chart(days, W, series, fmt = full, what = 'tokens', H = 210) {
  const  L = 42, R = 8, T = 10, B = 26;
  const iw = W - L - R, ih = H - T - B, slot = iw / days.length, bw = Math.max(8, slot * 0.62);
  const totals = days.map((d) => series.reduce((n, x) => n + x.value(d), 0));
  const max = niceMax(Math.max(...totals));
  const y = (v) => T + ih - (v / max) * ih;
  let g = [0, max / 2, max].map((v) => `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${what === 'cost' ? usd(v) : compact(v)}</text>`).join('');
  const every = Math.max(1, Math.ceil(52 / slot));
  days.forEach((d, i) => {
    const x = L + i * slot + (slot - bw) / 2;
    let acc = 0;
    const present = series.filter((x) => x.value(d) > 0);
    const segs = present.map((sr, idx) => {
      const v = sr.value(d), y0 = y(acc + v), h = y(acc) - y0; acc += v;
      const hh = Math.max(1, h - (idx === 0 ? 0 : 2)); // 2px surface gap between stacked fills
      return idx === present.length - 1 ? `<path d="${topRound(x, y0, bw, hh, 4)}" fill="${sr.color}"/>` : `<rect x="${x}" y="${y0}" width="${bw}" height="${hh}" fill="${sr.color}"/>`;
    }).join('');
    const label = ((days.length - 1 - i) % every === 0) ? `<text x="${x + bw / 2}" y="${H - 7}" text-anchor="middle">${dayLabel(d.date)}</text>` : '';
    g += `<g class="col" tabindex="0" data-i="${i}" role="img" aria-label="${esc(dayLabel(d.date))}: ${fmt(totals[i])} ${what}">
      <rect class="hit" x="${L + i * slot}" y="${T}" width="${slot}" height="${ih}"/>${segs}${label}</g>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="group" aria-label="${what} per day, last ${days.length} days">${g}</svg>`;
}
function chartTable(days, series) {
  return `<div class="tablewrap"><table><thead><tr><th>Day</th>${series.map((x) => `<th class="num">${esc(x.label)}</th>`).join('')}<th class="num">Total</th><th class="num">Sessions</th></tr></thead><tbody>` +
    [...days].reverse().map((d) => `<tr><td>${esc(dayLabel(d.date))}</td>${series.map((x) => `<td class="num">${full(x.value(d))}</td>`).join('')}<td class="num">${full(series.reduce((n, x) => n + x.value(d), 0))}</td><td class="num">${d.sessions}</td></tr>`).join('') + '</tbody></table></div>';
}
function usagePanel(u, title, tall) {
  const series = seriesFor(u.days, state.split);
  const legend = series.map((x) => `<span><i style="background:${x.color}"></i>${esc(x.label)}</span>`).join('');
  const split = [['type', 'Type'], ['channel', 'Channel'], ['agent', 'Agent'], ['portfolio', 'Portfolio'], ['project', 'Project']].map(([k, n]) => `<button type="button" data-split="${k}" aria-pressed="${state.split === k}">${n}</button>`).join('');
  return `<section class="panel" id="usagepanel"><h2>${title}</h2>
    <div class="toolbar"><span class="muted">Split by <span class="seg" role="group" aria-label="Split tokens by">${split}</span></span>
      <button type="button" id="tgl" style="padding:3px 9px;font-size:12px">${state.table ? 'Show chart' : 'Show table'}</button></div>
    ${state.table ? chartTable(u.days, series) : `<div class="chartbox" id="cbox">${chart(u.days, state.cw, series, full, 'tokens', tall ? 315 : 210)}<div class="tip" id="tip" hidden></div></div><div class="legend">${legend}</div>`}
    <div class="muted" style="margin-top:8px">Tokens = input + output across <b>all agents' ledgers</b> (Atlas, diane, coding, …). Subscription usage isn't billed per token.</div></section>`;
}
function wireChart(days, boxId = 'cbox', tipId = 'tip', fixedSeries = null, fmt = full) {
  if (!fixedSeries) document.querySelectorAll('[data-split]').forEach((b) => b.onclick = () => { state.split = b.dataset.split; store.set('split', state.split); renderView(state.r); });
  const box = $(boxId); if (!box) return;
  const tip = $(tipId), series = fixedSeries ?? seriesFor(days, state.split);
  const show = (el) => {
    const d = days[+el.dataset.i], total = series.reduce((n, x) => n + x.value(d), 0);
    tip.innerHTML = `<b>${esc(dayLabel(d.date))}</b>` + [...series].reverse().filter((x) => x.value(d) > 0).map((x) => `<div class="r"><span><i style="display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;background:${x.color}"></i>${esc(x.label)}</span><span>${fmt(x.value(d))}</span></div>`).join('')
      + `<div class="r" style="border-top:1px solid var(--line);margin-top:4px;padding-top:4px"><span>Total · ${d.sessions} sessions</span><b style="display:inline">${fmt(total)}</b></div>`;
    tip.hidden = false;
    const b = box.getBoundingClientRect(), c = el.getBoundingClientRect();
    let left = c.left - b.left + c.width / 2 - tip.offsetWidth / 2;
    left = Math.max(0, Math.min(left, b.width - tip.offsetWidth));
    tip.style.left = left + 'px'; tip.style.top = Math.max(0, c.top - b.top + 8) + 'px';
  };
  box.querySelectorAll('.col').forEach((el) => {
    el.addEventListener('mouseenter', () => show(el)); el.addEventListener('focus', () => show(el));
    el.addEventListener('mouseleave', () => tip.hidden = true); el.addEventListener('blur', () => tip.hidden = true);
  });
}

/* ---------- lane + channel chips with hover cards ---------- */
const pops = {};
const STATUS_WORD = { ok: 'Healthy', warn: 'Degraded', alert: 'Problem', unknown: 'Unchecked' };
function laneBrief(l) {
  if (!l.installed) return 'missing';
  if (l.login === 'none') return 'not set up';
  if (l.login === 'no') return l.kind === 'local' ? 'not reachable' : 'not logged in';
  const hot = [...l.limits].sort((a, b) => b.usedPercent - a.usedPercent)[0];
  if (hot && hot.usedPercent >= 85) return `${Math.round(hot.usedPercent)}% ${hot.label.toLowerCase().replace(/ \(.*\)/, '')}`;
  if (l.runs.lastStatus === 'failed') return 'last run failed';
  if (l.kind === 'local') return l.modelsNow[0] ?? 'idle'; // which model Ollama has loaded right now
  if (l.status === 'unknown') return 'unchecked';
  return '';
}
function limitRows(limits) {
  return limits.map((x) => `<div class="rowp"><span>${esc(x.label)}</span><span>${Math.round(x.usedPercent)}% used${x.resets ? ' · resets ' + esc(/^\d{4}-/.test(x.resets) ? short(x.resets) : x.resets) : ''}</span></div>${pctBar(x.usedPercent)}`).join('');
}
const LOGIN_WORD = (l) => l.login === 'ok' ? (l.kind === 'api' ? (l.plan === 'free models' ? 'free models, no key needed' : 'API key present') : l.kind === 'local' ? 'reachable' : 'logged in') : l.login === 'none' ? 'not set up' : l.login === 'no' ? (l.kind === 'local' ? 'not reachable' : 'not logged in') : 'cannot be checked';
function lanePop(l) {
  const r = l.runs, row = (k, v) => `<div class="rowp"><span>${k}</span><span style="text-align:right">${v}</span></div>`;
  const kindWord = { cli: 'subscription CLI', api: 'API via the opencode CLI', local: 'local model' }[l.kind];
  const models = l.kind === 'local'
    ? row('In memory now', l.modelsNow.length ? esc(l.modelsNow.join(', ')) : 'nothing (loads on demand)') + (l.model ? row('Default model', esc(l.model)) : '') + (l.lastModel ? row('Last lane run used', esc(l.lastModel)) : '')
    : (l.model ? row('Default model', esc(l.model)) : '') + (l.lastModel && l.lastModel !== l.model ? row('Last used', esc(l.lastModel)) : '');
  const limits = l.limits.length ? `<div class="lim"><div class="muted" style="margin:6px 0 2px">Usage limits</div>${limitRows(l.limits)}<div class="muted">${esc(l.limitsSource ?? '')}</div></div>`
    : row('Usage limits', l.kind === 'local' ? 'none (local)' : l.kind === 'api' ? 'none — pay per token (cap it in the provider dashboard)' : 'not available from this CLI');
  const spend = l.spend ? row('Recorded spend, 30 days', `${usd(l.spend.costUsd)} · ${l.spend.messages} message${l.spend.messages === 1 ? '' : 's'}`) : '';
  return `<h5><span class="dot ${l.status}"></span>${esc(l.name)} lane · ${l.login === 'none' ? 'Not set up' : STATUS_WORD[l.status]}</h5>
    <div class="muted" style="margin:-2px 0 4px">${kindWord}</div>
    ${row('Installed', l.installed ? 'yes' : 'no')}
    ${row(l.kind === 'api' ? 'Credential' : l.kind === 'local' ? 'Server' : 'Login', esc(LOGIN_WORD(l)) + (l.plan && l.plan !== 'free models' && l.plan !== 'API key' ? ' · plan ' + esc(l.plan) : ''))}
    ${l.detail && (l.login === 'none' || l.login === 'no' || l.kind !== 'cli') ? row('', esc(l.detail)) : ''}
    ${models}${limits}${spend}
    ${row('Runs, 7 days', r.total ? `${r.total} · ${r.failed} failed · last ${esc(ago(r.lastAt))} (${r.lastStatus === 'ok' ? 'ok' : 'failed'})` : 'none logged')}
    ${r.lastStatus === 'failed' && r.lastNote ? `<div class="note">Last failure: ${esc(r.lastNote)}</div>` : ''}`;
}
function chanTraffic(r, name) {
  const [profile, source] = name.includes(':') ? name.split(':') : ['default', name];
  return r.usage?.channels.find((c) => c.profile === profile && c.source === source);
}
function agentTotal(r, name) {
  const profile = name.includes(':') ? name.split(':')[0] : 'default';
  const rows = (r.usage?.channels ?? []).filter((c) => c.profile === profile);
  return { sessions: rows.reduce((n, c) => n + c.sessions, 0), tokens: rows.reduce((n, c) => n + c.tokens, 0), lastAt: rows.map((c) => c.lastAt).filter(Boolean).sort().at(-1) ?? null, profile };
}
function chanPop(r, p) {
  const t = chanTraffic(r, p.name), st = chanState(p.state), all = agentTotal(r, p.name);
  return `<h5><span class="dot ${st}"></span>${esc(chanName(p.name))} · ${esc(p.state)}</h5>
    <div class="rowp"><span>Channel</span><span>${esc(p.name)}</span></div>
    <div class="rowp"><span>${p.state === 'connected' ? 'Connected since' : 'State since'}</span><span>${p.since ? esc(short(p.since)) : '—'}</span></div>
    <div class="rowp"><span>Chats here, 7 days</span><span>${t && t.sessions ? `${t.sessions} · ${compact(t.tokens)} tokens · last ${esc(ago(t.lastAt))}` : 'none'}</span></div>
    <div class="rowp"><span>${esc(agentName(all.profile))} overall, 7 days</span><span>${all.sessions ? `${all.sessions} sessions · ${compact(all.tokens)} tokens · last ${esc(ago(all.lastAt))}` : 'no activity'}</span></div>
    <div class="muted" style="margin-top:4px">“Overall” includes scheduled jobs and the dashboard, not just this chat.</div>
    ${p.error ? `<div class="note">Gateway says: ${esc(p.error)}</div>` : ''}`;
}
function laneChip(l) {
  pops['lane:' + l.name] = lanePop(l);
  const b = laneBrief(l);
  return `<button type="button" class="pill" data-pop="lane:${esc(l.name)}" aria-label="${esc(l.name)} lane: ${STATUS_WORD[l.status]}${b ? ', ' + esc(b) : ''}"><span class="dot ${l.status}"></span>${esc(l.name)}${b ? ' · ' + esc(b) : ''}</button>`;
}
function chanChip(r, p, long) {
  pops['chan:' + p.name] = chanPop(r, p);
  return `<button type="button" class="pill" data-pop="chan:${esc(p.name)}" aria-label="${esc(chanName(p.name))} channel: ${esc(p.state)}"><span class="dot ${chanState(p.state)}"></span>${esc(chanName(p.name))}${long || p.state !== 'connected' ? ' · ' + esc(p.state) : ''}</button>`;
}
const popEl = () => $('pop');
function showPop(el) {
  const html = pops[el.dataset.pop]; if (!html) return;
  const p = popEl(); p.innerHTML = html; p.hidden = false;
  const r = el.getBoundingClientRect();
  p.style.left = Math.max(8, Math.min(r.left, innerWidth - p.offsetWidth - 8)) + 'px';
  const below = r.bottom + 8, fits = below + p.offsetHeight < innerHeight - 8;
  p.style.top = (fits ? below : Math.max(8, r.top - p.offsetHeight - 8)) + 'px';
}
const hidePop = () => { popEl().hidden = true; };
document.addEventListener('mouseover', (e) => { const el = e.target.closest?.('[data-pop]'); if (el) showPop(el); });
document.addEventListener('mouseout', (e) => { if (e.target.closest?.('[data-pop]')) hidePop(); });
document.addEventListener('focusin', (e) => { const el = e.target.closest?.('[data-pop]'); if (el) showPop(el); });
document.addEventListener('focusout', hidePop);
document.addEventListener('click', (e) => { const el = e.target.closest?.('[data-pop]'); if (el) { popEl().hidden ? showPop(el) : hidePop(); } else hidePop(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePop(); });

/* ---------- agents ---------- */
const AGENT_STATE = { active: 'Active', proposed: 'Proposed', unlisted: 'Not in roster' };
const taskText = (t) => [t.running && `${t.running} running`, t.ready && `${t.ready} queued`, t.review && `${t.review} in review`, t.blocked && `<b class="sev-warn">${t.blocked} blocked</b>`].filter(Boolean).join(' · ') || '<span class="muted">no open tasks</span>';
const hasOpen = (t) => t.running + t.ready + t.review + t.blocked > 0;
/** Active agents first, busiest first (7-day tokens, then sessions); proposed agents after them; profiles outside the roster last. */
const AGENT_ORDER = { active: 0, proposed: 1, unlisted: 2 };
const byTraffic = (a, b) => AGENT_ORDER[a.state] - AGENT_ORDER[b.state] || b.tokens7d - a.tokens7d || b.sessions7d - a.sessions7d || a.name.localeCompare(b.name);
function portfolioTags(a) {
  if (a.allPortfolios) return '<span class="tag">all portfolios</span>';
  return a.portfolios.map((id) => `<a class="tag" href="#/g/${esc(id)}">${esc(gName(id))}</a>`).join(' ') || '<span class="muted">not linked to a portfolio</span>';
}
const tkTotal = (a) => a.traffic?.tokens ?? a.tokens7d ?? 0;
/** Token spread for one agent over 7 days: portfolio rows with a share bar, each with its projects; the rest is chat, cron and work outside a task. */
function trafficPanel(a) {
  const t = a.traffic, total = tkTotal(a);
  if (!t || !total) return `<section class="panel"><h2>Traffic, last 7 days</h2><div class="muted">No token use in the last 7 days.</div></section>`;
  const pct = (n) => Math.max(1, Math.round(100 * n / total));
  const rows = Object.entries(t.byPortfolio).sort((x, y) => y[1].tokens - x[1].tokens).map(([g, v]) =>
    `<tr><td><a href="#/g/${esc(g)}">${esc(gName(g))}</a></td><td class="num">${full(v.tokens)}</td><td class="num">${pct(v.tokens)}%</td><td style="width:30%"><div style="height:8px;border-radius:4px;background:var(--accent);width:${pct(v.tokens)}%"></div></td><td>${Object.entries(v.projects).sort((x, y) => y[1] - x[1]).map(([p, n]) => `<a href="#/project/${esc(p)}">${esc(humanize(p))}</a> <span class="muted">${compact(n)}</span>`).join(' · ')}</td></tr>`).join('');
  const other = t.other ? `<tr><td>Chat, cron &amp; unassigned</td><td class="num">${full(t.other)}</td><td class="num">${pct(t.other)}%</td><td><div style="height:8px;border-radius:4px;background:var(--unknown);width:${pct(t.other)}%"></div></td><td class="muted">not tied to a task</td></tr>` : '';
  return `<section class="panel"><h2>Traffic, last 7 days<span class="right muted">${full(total)} tokens · ${t.sessions} sessions</span></h2><div class="tablewrap"><table><thead><tr><th>Portfolio</th><th class="num">Tokens</th><th class="num">Share</th><th></th><th>Projects</th></tr></thead><tbody>${rows}${other}</tbody></table></div></section>`;
}
function agentCard(a) {
  const mdl = a.model ? `${esc(a.model)}${a.provider ? ' <span class="muted">· ' + esc(a.provider) + '</span>' : ''}` : '<span class="muted">not created yet</span>';
  return `<article class="card ${a.status}">
    <h3><span>${a.emoji ? esc(a.emoji) + ' ' : ''}${esc(a.name)}</span><span class="tag">${esc(AGENT_STATE[a.state])}</span></h3>
    <div class="headline">${esc(a.role)}</div>
    <div class="row" style="margin-bottom:6px"><span>Serves</span><span style="text-align:right">${portfolioTags(a)}</span></div>
    <div class="row"><span>Model</span><span style="text-align:right">${mdl} <button type="button" class="linkbtn" data-act="model" data-agent="${esc(a.id)}">change</button></span></div>
    ${thenText(a) ? `<div class="row"><span>If it fails</span><span class="muted" style="text-align:right" title="Tried in this order when the model before it fails">${esc(thenText(a))}</span></div>` : ''}
    ${a.lanes.length ? `<div class="row"><span>Lanes</span><span>${a.lanes.map((l) => `<span class="tag">${esc(l)}</span>`).join(' ')}</span></div>` : ''}
    <div class="row"><span>Tasks</span><span style="text-align:right">${taskText(a.tasks)}</span></div>
    <div class="row"><span>Last 7 days</span><span>${a.sessions7d ? `${a.sessions7d} sessions · ${compact(a.tokens7d)} tokens · ${esc(ago(a.lastAt))}` : 'no activity'}</span></div>
    ${a.personaSlug ? `<div class="row"><span>Persona</span><span title="${esc(a.personaSlug)}">${esc(a.division ?? '')} · agency-agents</span></div>` : ''}
    <div class="row" style="margin-top:8px"><a href="#/agent/${esc(a.id)}">Prompt, skills &amp; memory →</a></div>
  </article>`;
}
/** The team on a portfolio page: one compact row. Hover a name for the full card; click it for the agent's page. */
function teamStrip(r, id) {
  const team = r.agents.filter((a) => a.state !== 'unlisted' && (a.allPortfolios || a.portfolios.includes(id))).sort(byTraffic);
  if (!team.length) return `<div class="teamstrip"><span class="lbl">Team</span><span class="muted">No agents linked to ${esc(gName(id))} yet: <code>npm run agents -- link &lt;agent&gt; ${esc(id)} --apply</code></span></div>`;
  const chips = team.map((a) => {
    pops['agent:' + a.id] = agentPop(a);
    const t = a.byPortfolio[id] ?? { running: 0, ready: 0, review: 0, blocked: 0, done: 0 };
    const act = [t.running && t.running + '▶', t.ready && t.ready + '⏳', t.review && t.review + '👁', t.blocked && `<b class="sev-warn">${t.blocked}⛔</b>`].filter(Boolean).join(' ');
    return `<a class="agentchip ${a.state === 'proposed' ? 'dim' : ''}" href="#/agent/${esc(a.id)}" data-pop="agent:${esc(a.id)}"><span class="dot ${a.status}"></span>${esc(a.name)}${act ? ` <span class="act">${act}</span>` : ''}</a>`;
  }).join('');
  return `<div class="teamstrip" style="flex-wrap:wrap"><span class="lbl" style="flex-basis:100%">Team · ${team.length} <a class="all" href="#/agents" style="margin-left:8px;text-transform:none;letter-spacing:0;font-weight:400">All agents →</a></span><div class="chips2">${chips}</div></div>`;
}
const shortModel = (a) => (a.model ? a.model : null);
function modelCell(a) {
  const m = shortModel(a);
  const then = thenText(a);
  return `${m ? `<span title="${esc(a.provider ?? '')}">${esc(m)}</span>` : '<span class="muted">not created</span>'} <button type="button" class="linkbtn" data-act="model" data-agent="${esc(a.id)}" aria-label="Change the models of ${esc(a.name)}">change</button>${then ? `<div class="muted then" title="If the model above fails, these are tried in this order">then ${esc(then)}</div>` : ''}`;
}
/** The hover card for an agent: everything on the card, without leaving the page. */
function agentPop(a) {
  const t = a.tasks, open = t ? [t.running && t.running + ' running', t.ready && t.ready + ' queued', t.review && t.review + ' in review', t.blocked && t.blocked + ' blocked'].filter(Boolean).join(' · ') : '';
  const row = (k, v) => `<div class="r"><span class="k">${k}</span><span>${v}</span></div>`;
  return `<div class="poph"><b>${a.emoji ? esc(a.emoji) + ' ' : ''}${esc(a.name)}</b> <span class="tag">${esc(AGENT_STATE[a.state])}</span></div><div class="popbody">
    <div class="muted" style="margin-bottom:6px">${esc(a.role)}</div>
    ${row('Model', a.model ? `${esc(a.model)}${a.provider ? ' <span class="muted">· ' + esc(a.provider) + '</span>' : ''}` : '<span class="muted">not created yet</span>')}
    ${row('Lanes', a.lanes.length ? a.lanes.map((l) => `<span class="tag">${esc(l)}</span>`).join(' ') : '—')}
    ${row('Serves', a.allPortfolios ? 'all portfolios' : a.portfolios.map((x) => esc(gName(x))).join(', ') || 'nothing yet')}
    ${row('Open tasks', open || 'none')}
    ${a.traffic && tkTotal(a) ? row('Tokens, 7 days', compact(tkTotal(a)) + ' · ' + (Object.entries(a.traffic.byPortfolio).sort((x, y) => y[1].tokens - x[1].tokens).map(([g, v]) => esc(gName(g)) + ' ' + compact(v.tokens)).join(', ') + (a.traffic.other ? ', other ' + compact(a.traffic.other) : ''))) : ''}
    ${row('Last 7 days', a.sessions7d ? `${a.sessions7d} sessions · ${compact(a.tokens7d)} tokens · ${esc(ago(a.lastAt))}` : 'no activity')}
    ${a.personaSlug ? row('Persona', esc((a.division ?? '') + ' · agency-agents')) : ''}
    <div class="muted" style="margin-top:6px">Click the name for prompt, skills and memory.</div></div>`;
}
/** The Agents page window (7, 14 or 28 days): one switch for tokens and the track record. Remembered per browser. */
const WINDOWS = [7, 14, 28];
function agentWindow() { if (!state.win) { let v = 14; try { const x = Number(localStorage.getItem('agentsWindow')); if (WINDOWS.includes(x)) v = x; } catch { /* no storage */ } state.win = v; } return state.win; }
const tkIn = (a, w) => w === 7 ? tkTotal(a) : (a.trafficByDays?.[w]?.tokens ?? 0);
const tkPortIn = (a, w, g) => (w === 7 ? a.traffic : a.trafficByDays?.[w])?.byPortfolio?.[g]?.tokens;
function matrix(r) {
  const w = agentWindow(), score = state.score?.[w], rec = new Map((score?.agents ?? []).map((x) => [x.agent, x]));
  const agents = [...r.agents].sort((a, b) => AGENT_ORDER[a.state] - AGENT_ORDER[b.state] || tkIn(b, w) - tkIn(a, w) || byTraffic(a, b));
  if (!agents.length) return '<div class="empty">No agents in config/agents.json yet.</div>';
  const head = GROUPS.map((g) => `<th><a href="#/g/${esc(g.id)}">${esc(g.name)}</a></th>`).join('');
  const rows = agents.map((a) => { pops['agent:' + a.id] = agentPop(a); return `<tr class="${a.state === 'proposed' ? 'dim' : ''}"><td><a href="#/agent/${esc(a.id)}" class="agentlink" data-pop="agent:${esc(a.id)}">${a.emoji ? esc(a.emoji) + ' ' : ''}<b>${esc(a.name)}</b></a> ${a.state !== 'active' ? `<span class="tag">${esc(AGENT_STATE[a.state].toLowerCase())}</span>` : ''}</td>${recCells(rec.get(a.profile), !!score)}<td class="mdlcell sep">${modelCell(a)}</td><td class="num sep" title="last ${w} days">${tkIn(a, w) ? compact(tkIn(a, w)) : '<span class="muted">—</span>'}</td>` +
    GROUPS.map((g) => {
      const linked = a.allPortfolios || a.portfolios.includes(g.id), t = a.byPortfolio[g.id], tk = tkPortIn(a, w, g.id);
      const tkTxt = tk ? ` <span class="muted" title="tokens in the last ${w} days">${compact(tk)}</span>` : '';
      return `<td class="cell">${linked || tk ? tkTxt + ' ' : ''}${linked ? (t && hasOpen(t) ? `<span title="${esc(a.name)} in ${esc(g.name)}">● ${t.running ? t.running + '▶ ' : ''}${t.ready ? t.ready + '⏳ ' : ''}${t.review ? t.review + '👁 ' : ''}${t.blocked ? `<b class="sev-warn">${t.blocked}⛔</b>` : ''}</span>` : '<span title="linked, no open tasks">●</span>') : '<span class="muted">·</span>'}</td>`;
    }).join('') + '</tr>'; }).join('');
  const recHead = '<th class="num sep" title="Tasks finished in the window">Done</th><th class="num" title="Passed without rework or you">First time</th><th class="num">Needed you</th><th class="num" title="Crashes and give-ups">Crashes</th><th>Trust</th>';
  const switcher = `<span class="seg" role="group" aria-label="Window">${WINDOWS.map((d) => `<button type="button" data-win="${d}" aria-pressed="${d === w}">${d} days</button>`).join('')}</span>`;
  const who = (by) => by === 'unrecorded' ? 'no reason recorded' : by === 'rule' ? 'automatic (rule)' : by;
  const picks = (score?.deciders ?? []).filter((d) => d.picks).map((d) => `<span title="${esc((d.recent ?? []).map((p) => `${p.agent}: ${p.outcome}${p.why ? ' — ' + p.why : ''}`).join('\n'))}">${esc(who(d.by))} <b>${d.good}/${d.picks}</b></span>`).join(' · ');
  return `<div class="toolbar">${switcher}<span class="muted">Tokens and track record over the last ${w} days. First time = passed without rework or you.</span></div>
    <div class="tablewrap"><table class="matrix"><thead><tr class="grp"><th></th><th colspan="5" class="sep">Track record</th><th class="sep"></th><th colspan="${1 + GROUPS.length}" class="sep">Who serves which portfolio</th></tr><tr><th>Agent</th>${recHead}<th class="sep">Model</th><th class="num sep">Tokens</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
    <div class="muted" style="margin-top:6px">● serves this portfolio · ▶ running · ⏳ queued · 👁 in review · ⛔ blocked · · not linked${picks ? ` &nbsp;|&nbsp; Owner choices that worked the first time: ${picks} (hover for the latest and their reasons)` : ''}</div>`;
}
function recCells(c, loaded) {
  if (!loaded) return '<td class="num sep muted" colspan="5">…</td>';
  if (!c) return '<td class="num sep muted">—</td><td class="num muted">—</td><td class="num muted">—</td><td class="num muted">—</td><td></td>';
  const pct = (x, y) => (y ? Math.round((100 * x) / y) + '%' : '—');
  const d = c.now.done && c.before.done ? Math.round(100 * c.now.firstPass / c.now.done) - Math.round(100 * c.before.firstPass / c.before.done) : 0;
  const arrow = d >= 5 ? ' <span style="color:var(--ok)" title="better than the window before">↑</span>' : d <= -5 ? ' <span style="color:var(--warn)" title="worse than the window before">↓</span>' : '';
  return `<td class="num sep">${c.now.done}</td><td class="num">${pct(c.now.firstPass, c.now.done)}${arrow}</td><td class="num">${c.now.neededYou}</td><td class="num">${c.now.failures || '<span class="muted">0</span>'}</td><td><span class="tag trust-${c.trust}" title="${esc(TRUST_TIP[c.trust] + ' — ' + c.why)}">${c.trust}</span></td>`;
}
/** Each agent's record over 4 weeks, and how choices of owner turned out. Trust is earned from these numbers (packages/work/scorecard.ts). */
const TRUST_TIP = { new: 'Fewer than 5 finished tasks: too early to judge', trusted: 'At least 80% passed the first time and it needed you on 10% or less', steady: 'A decent record, not yet trusted', watch: 'Under 60% passed the first time, or 3+ crashes / give-ups' };
function loadScore() {
  const w = agentWindow(); state.score ??= {};
  if (state.score[w] || state.scoreLoading?.[w]) return '';
  (state.scoreLoading ??= {})[w] = true;
  fetch('/api/scorecard?days=' + w).then((r) => r.ok ? r.json() : null).then((j) => { state.score[w] = j ?? { agents: [], deciders: [] }; })
    .catch(() => { state.score[w] = { agents: [], deciders: [] }; }).finally(() => { state.scoreLoading[w] = false; if (route() === 'agents') renderView(state.r); });
  return '';
}
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-win]'); if (!b) return;
  state.win = Number(b.dataset.win); try { localStorage.setItem('agentsWindow', String(state.win)); } catch { /* no storage */ }
  renderView(state.r);
});
function viewAgents(r) {
  const by = { active: 0, proposed: 0, unlisted: 0 }; r.agents.forEach((a) => by[a.state]++);
  return `<h1>Agents</h1><p class="muted sub">${by.active} active · ${by.proposed} proposed · ${by.unlisted} not in the roster. An agent is a Hermes profile; several can serve one portfolio, and one can serve several. Hover a name for its card; click it for prompt, skills, memory, what it knows about you, and how it is growing.</p>
    <section class="panel"><h2>Who serves which portfolio · Track record</h2>${loadScore(), matrix(r)}</section>
    <section class="panel"><h2>Set up or link agents</h2>
      <p class="muted" style="margin-top:0">Models are changed here (the <b>change</b> link). Everything else is done with the setup tool (dry run by default, add <code>--apply</code>) or by asking Atlas in Telegram.</p>
      <ul class="plain"><li><code>npm run agents -- catalog search "app store"</code><span class="muted">find a specialist in the agency-agents catalog</span></li>
        <li><code>npm run agents -- add marketing/marketing-seo-specialist --id seo --portfolios ai-thrival --apply</code><span class="muted">create the agent</span></li>
        <li><code>npm run agents -- link coding family --apply</code><span class="muted">let an agent serve another portfolio</span></li>
        <li><code>npm run agents -- sync --apply</code><span class="muted">create Hermes profiles for proposed agents</span></li></ul>
      <p class="muted" style="margin-bottom:0">Telegram: “Atlas, add the SEO specialist to AI Thrival” — Atlas shows the plan and waits for your OK before applying.</p></section>`;
}
function agentsPanel(r) {
  const top = [...r.agents].filter((a) => a.state !== 'unlisted' || a.tokens7d > 0).sort(byTraffic).slice(0, 7);
  if (!top.length) return '';
  return `<section class="panel"><h2>Agents<span class="right"><a href="#/agents">All ${r.agents.length} →</a></span></h2><div class="tablewrap"><table><thead><tr><th>Agent</th><th>Serves</th><th>Tasks</th><th class="num">Tokens, 7 days</th><th>Last active</th></tr></thead><tbody>` +
    top.map((a) => `<tr class="${a.state === 'proposed' ? 'dim' : ''}"><td><span class="dot ${a.status}"></span> ${a.emoji ? esc(a.emoji) + ' ' : ''}${esc(a.name)} ${a.state !== 'active' ? `<span class="tag">${esc(AGENT_STATE[a.state].toLowerCase())}</span>` : ''}</td><td>${portfolioTags(a)}</td><td>${taskText(a.tasks)}</td><td class="num">${a.tokens7d ? full(a.tokens7d) : '—'}</td><td>${a.lastAt ? esc(ago(a.lastAt)) : '—'}</td></tr>`).join('') + '</tbody></table></div></section>';
}


/* ---------- an agent's models: first choice, second choice, fallback ---------- */
const MODEL_SLOTS = [['1st choice', 'used first'], ['2nd choice', 'used if the 1st fails'], ['Fallback', 'used if the 2nd fails too']];
const chainOf = (a) => (a.chain?.length ? a.chain : a.model ? [{ model: a.model, provider: a.provider }] : []);
const thenText = (a) => chainOf(a).slice(1).map((m) => m.model).join(' › ');
async function openModelDialog(agentId) {
  const a = state.r.agents.find((x) => x.id === agentId); if (!a) return;
  const d = $('modeldlg'), cur = chainOf(a);
  $('m-title').textContent = 'Models · ' + a.name;
  $('m-cur').textContent = cur.length ? 'Now: ' + cur.map((m) => m.model).join(' › ') + (a.lanes.length ? ' · lanes: ' + a.lanes.join(', ') : '') : 'No model yet (applies when the agent is created)';
  $('m-list').innerHTML = '<div class="muted">Loading models…</div>'; $('m-result').innerHTML = '';
  d.dataset.agent = agentId; d.showModal();
  let cat = null;
  try { cat = await (await fetch('/api/models')).json(); } catch { /* shown below */ }
  if (!cat?.models?.length) { $('m-list').innerHTML = '<div class="err">Could not load the model list.</div>'; $('m-save').disabled = true; return; }
  const privacyOnly = agentId === 'personal';                         // the Privacy agent: local models only, as a fallback too
  const models = cat.models.filter((m) => !privacyOnly || m.private);
  const indexOf = (c) => models.findIndex((x) => x.provider === c.provider && x.model === c.model);
  d._models = models;
  d._slots = [0, 1, 2].map((i) => { const ix = cur[i] ? indexOf(cur[i]) : -1; return ix >= 0 ? ix : null; });
  d._dropped = cur.filter((c) => indexOf(c) < 0).map((c) => c.model);
  d._lanes = cat.lanes; d._privacyOnly = privacyOnly;
  renderModelSlots();
}
/** What is wrong with the choices as they stand, or null. */
function modelProblem(d) {
  const picked = d._slots.filter((x) => x !== null);
  if (d._slots[0] === null) return 'Choose a 1st model: it is the one used first.';
  const dup = picked.find((x, i) => picked.indexOf(x) !== i);
  return dup === undefined ? null : `${d._models[dup].label} is chosen twice. Each choice must be a different model.`;
}
function renderModelSlots() {
  const d = $('modeldlg'), models = d._models, slots = d._slots;
  const groups = d._lanes.map((l) => ({ l, ms: models.map((m, i) => [m, i]).filter(([m]) => m.lane === l.id) })).filter((g) => g.ms.length);
  const dupes = new Set(slots.filter((x, i) => x !== null && slots.indexOf(x) !== i));
  const opt = (m, i, sel) => `<option value="${i}"${sel ? ' selected' : ''}>${esc(m.label)}${m.status === 'rate-limited' ? ' — rate-limited' : ''}</option>`;
  $('m-list').innerHTML = slots.map((ix, i) => {
    const m = ix === null ? null : models[ix];
    const info = m ? `${esc(m.model)} · ${esc(m.provider)} · ${esc(m.billing)}${m.private ? ' · runs on this Mac only' : ''}${m.status === 'rate-limited' ? `<br><span style="color:var(--warn)">${esc(m.note || 'rate-limited right now: the next choice is used while it is')}</span>` : ''}` : (i === 0 ? '' : 'Not used.');
    return `<div class="mrow${ix !== null && dupes.has(ix) ? ' bad' : ''}" data-i="${i}">
      <div class="mlabel"><b>${MODEL_SLOTS[i][0]}</b><span class="muted">${MODEL_SLOTS[i][1]}</span></div>
      <select class="msel" aria-label="${MODEL_SLOTS[i][0]}">${i === 0 ? '' : `<option value="">— none —</option>`}${groups.map((g) => `<optgroup label="${esc(g.l.label)}">${g.ms.map(([x, j]) => opt(x, j, ix === j)).join('')}</optgroup>`).join('')}</select>
      <div class="mbtns"><button type="button" data-mv="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move the ${MODEL_SLOTS[i][0]} up" title="Move up">↑</button><button type="button" data-mv="1" ${i === 2 ? 'disabled' : ''} aria-label="Move the ${MODEL_SLOTS[i][0]} down" title="Move down">↓</button>${i === 0 ? '' : `<button type="button" data-clear="1" aria-label="Clear the ${MODEL_SLOTS[i][0]}" title="Clear" ${ix === null ? 'disabled' : ''}>✕</button>`}</div>
      <div class="minfo muted">${info}</div></div>`;
  }).join('');
  const order = slots.filter((x) => x !== null).map((x) => models[x].label);
  const problem = modelProblem(d);
  $('m-result').innerHTML = (problem ? `<div class="err" role="alert">${esc(problem)}</div>` : `<div class="morder"><b>Order:</b> ${order.map(esc).join(' → ')}</div>`)
    + (d._dropped?.length ? `<div class="muted" style="font-size:12px;margin-top:4px">Not shown: ${esc(d._dropped.join(', '))} (${d._privacyOnly ? 'not a local model' : 'not in the model list'}); saving replaces it.</div>` : '')
    + (d._privacyOnly ? '<div class="muted" style="font-size:12px;margin-top:4px">This agent handles private data, so every choice, fallbacks included, must run on this Mac.</div>' : '');
  $('m-save').disabled = !!problem;
  d.querySelectorAll('.mrow').forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelector('select').onchange = (e) => { slots[i] = e.target.value === '' ? null : Number(e.target.value); renderModelSlots(); };
    row.querySelectorAll('[data-mv]').forEach((b) => { b.onclick = () => { const j = i + Number(b.dataset.mv); [slots[i], slots[j]] = [slots[j], slots[i]]; renderModelSlots(); d.querySelector(`.mrow[data-i="${j}"] [data-mv="${b.dataset.mv}"]`)?.focus(); }; });
    const clr = row.querySelector('[data-clear]'); if (clr) clr.onclick = () => { slots[i] = null; renderModelSlots(); };
  });
}
async function saveModel(e) {
  e.preventDefault();
  const d = $('modeldlg'); if (!d._slots || modelProblem(d)) return;
  const picks = d._slots.filter((x) => x !== null).map((x) => d._models[x]);   // an empty slot in the middle closes up: the order is what counts
  const id = d.dataset.agent;
  $('m-save').disabled = true; $('m-save').textContent = 'Saving…'; $('m-result').innerHTML = '<div class="muted">Updating the roster and the Hermes profile…</div>';
  try {
    const res = await postJson('/api/agents/model', { agent: id, models: picks.map((m) => ({ provider: m.provider, model: m.model })) });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
    d.close(); flash(`${state.r.agents.find((x) => x.id === id)?.name ?? id}: ${picks.map((m) => m.label).join(' → ')}`, 'ok', false, 7000); void load(true);
  } catch (err) { $('m-result').innerHTML = `<div class="err">${esc(err.message)}</div>`; $('m-save').disabled = false; }
  $('m-save').textContent = 'Save models';
}
document.addEventListener('click', (e) => { const t = e.target.closest?.('[data-act="model"]'); if (t) { e.preventDefault(); void openModelDialog(t.dataset.agent); } });

/* ---------- writes: one helper (same-origin JSON, optional access token) ---------- */
async function postJson(path, body) {
  const headers = { 'content-type': 'application/json' };
  if (state.r?.ui.writeToken) {
    let t = store.get('token', '');
    if (!t) { t = prompt('Cockpit access token (COCKPIT_TOKEN):') || ''; store.set('token', t); }
    headers['x-cockpit-token'] = t;
  }
  return fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
}
/* ---------- feedback: one button, one store (data/feedback.jsonl) ---------- */
{
  const dlg = document.getElementById('fbdlg'), ta = document.getElementById('fbtext');
  document.getElementById('feedback').addEventListener('click', () => { ta.value = ''; document.getElementById('fbpage').textContent = 'Page: ' + (location.hash || '#/'); dlg.showModal(); ta.focus(); });
  document.getElementById('fbcancel').addEventListener('click', () => dlg.close());
  document.getElementById('fbform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = ta.value.trim(); if (text.length < 3) { flash('Write a few words first.', 'err', false, 4000); return; }
    try {
      const res = await postJson('/api/feedback', { text, page: location.hash || '#/' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { flash(j.error || 'Not saved (HTTP ' + res.status + ')', 'err', false, 9000); return; }
      dlg.close(); flash(j.duplicate ? 'Already recorded, thanks.' : 'Thanks, feedback recorded.', 'ok', false, 4000);
    } catch (err) { flash('Could not reach Cockpit: ' + err.message, 'err', false, 9000); }
  });
}
const dashboardUrl = (r) => (['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:9119' : (r.ui.dashboardUrl || 'https://{host}:9443').replace('{host}', location.hostname));
const activeAgents = (r) => r.agents.filter((a) => a.state === 'active');
const agentOptions = (r, portfolio, selected = '') => {
  const mine = activeAgents(r).filter((a) => a.allPortfolios || a.portfolios.includes(portfolio)), others = activeAgents(r).filter((a) => !mine.includes(a));
  const opt = (a) => `<option value="${esc(a.profile)}" ${a.profile === selected ? 'selected' : ''}>${esc(a.name)}</option>`;
  return `<optgroup label="Serves this portfolio">${mine.map(opt).join('')}</optgroup>${others.length ? `<optgroup label="Other active agents">${others.map(opt).join('')}</optgroup>` : ''}`;
};

/* ---------- chat with Atlas: a plain conversation, streamed through Cockpit ---------- */
const chat = (() => {
  let saved = {};
  try { saved = JSON.parse(store.get('chat', '{}')); } catch { /* start fresh */ }
  return { sessionId: saved.sessionId || 'cockpit-' + (crypto.randomUUID?.() ?? String(Date.now())).replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 36), msgs: saved.msgs || [], busy: false, ctl: null, prefill: '' };
})();
const saveChat = () => store.set('chat', JSON.stringify({ sessionId: chat.sessionId, msgs: chat.msgs.slice(-40) }));
function askAtlas(text) { chat.prefill = text; setChat(true, true); }

/** Escape first, then allow a little formatting: code blocks, `code`, **bold**, bullet lines. */
// Markdown to HTML. Everything is escaped first; only the tags built here are emitted, links only http(s)/mailto.
function mdInline(t) {
  let h = esc(t);
  const codes = [];
  h = h.replace(/`([^`\n]+)`/g, (_m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>').replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>').replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  h = h.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  h = h.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  return h.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[+i]}</code>`);
}
function mdRender(src) {
  let text = String(src).replace(/\r\n/g, '\n');
  let front = '';
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) { front = `<div class="mdfront">${esc(fm[1]).replace(/\n/g, '<br>')}</div>`; text = text.slice(fm[0].length); }
  text = text.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*$/gm, '');   // HTML comments (e.g. roster markers) are not content
  const lines = text.split('\n'), out = [];
  let i = 0;
  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l), isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre>${esc(buf.join('\n'))}</pre>`); continue; }
    const hd = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (hd) { out.push(`<h${hd[1].length + 1}>${mdInline(hd[2])}</h${hd[1].length + 1}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l) || /^\s*§\s*$/.test(l)) { out.push('<hr>'); i++; continue; }  // § separates Hermes memory entries
    if (isTableRow(l) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="tablewrap"><table><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_h, k) => `<td>${mdInline(r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
    }
    if (/^\s*>/.test(l)) { const buf = []; while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, '')); out.push(`<blockquote>${mdRender(buf.join('\n'))}</blockquote>`); continue; }
    const li = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[2]); const items = [];
      while (i < lines.length) { const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/); if (!m) { if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1].t += ' ' + lines[i].trim(); i++; continue; } break; } items.push({ d: Math.floor(m[1].length / 2), t: m[3] }); i++; }
      // one level of nesting: deeper items go inside the previous item
      let h = ordered ? '<ol>' : '<ul>', k = 0;
      while (k < items.length) { const it = items[k]; let inner = mdInline(it.t); k++; const kids = []; while (k < items.length && items[k].d > it.d) kids.push(items[k++]); if (kids.length) inner += '<ul>' + kids.map((x) => `<li>${mdInline(x.t)}</li>`).join('') + '</ul>'; h += `<li>${inner}</li>`; }
      out.push(h + (ordered ? '</ol>' : '</ul>')); continue;
    }
    if (!l.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i]) && !(isTableRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1]))) buf.push(lines[i++]);
    out.push(`<p>${buf.map(mdInline).join('<br>')}</p>`);
  }
  return front + out.join('');
}
const mdLite = mdRender;

// ---- Documents: shown rendered by default; top right switches to Raw, and from Raw an editable file can be edited. ----
// docStore holds each document's text so a mode switch can redraw without a reload; docMode is per group (one switch can drive several docs).
const docStore = new Map(), docMode = {};
const docKind = (id) => docStore.get(id)?.kind ?? 'md';
function docInner(id) {
  const d = docStore.get(id); if (!d) return '';
  const mode = docMode[d.group] ?? 'rendered';
  if (!String(d.text).trim()) return d.empty ?? '<span class="muted">(empty)</span>';
  if (mode === 'raw') return `<pre class="doc">${esc(d.text)}</pre>`;
  if (mode === 'edit' && d.edit) return `<textarea class="docedit" data-doc="${esc(id)}" spellcheck="false" aria-label="Edit ${esc(d.edit.file)}">${esc(d.draft ?? d.text)}</textarea><div class="docsave"><span class="muted" data-count>${(d.draft ?? d.text).length}${d.edit.limit ? ' / ' + d.edit.limit : ''} characters</span><span class="grow"></span><button type="button" data-doccancel="${esc(id)}">Cancel</button><button type="button" class="primary" data-docsave="${esc(id)}">Save</button></div>`;
  if (d.kind === 'html') return `<iframe class="dochtml" sandbox="" srcdoc="${esc(d.text)}" title="Rendered HTML"></iframe>`;
  return `<div class="md">${mdRender(d.text)}</div>`;
}
/** A document body. `o.edit` ({agent, file, base, limit}) makes it editable from Raw; `o.kind` is 'md' (default) or 'html'. */
function docBody(group, id, text, o = {}) { docStore.set(id, { group, text, kind: o.kind ?? 'md', edit: o.edit ?? null, empty: o.empty }); return `<div class="docbody" data-doc="${esc(id)}">${docInner(id)}</div>`; }
function docTools(group, o = {}) {
  const mode = docMode[group] ?? 'rendered';
  const edit = o.edit ? (o.blocked ? `<span class="muted" title="${esc(o.blocked)}">edit unavailable</span>` : `<button type="button" class="docedit-btn" data-docedit="${esc(group)}" ${mode === 'edit' ? 'aria-pressed="true"' : ''} ${mode === 'rendered' ? 'hidden' : ''}>Edit</button>`) : '';
  return `<span class="doctools" data-g="${esc(group)}"><span class="seg" role="group" aria-label="View"><button type="button" data-docmode="rendered" aria-pressed="${mode === 'rendered'}">Rendered</button><button type="button" data-docmode="raw" aria-pressed="${mode === 'raw' || mode === 'edit'}">Raw</button></span>${edit}</span>`;
}
function docRedraw(group) {
  document.querySelectorAll('.docbody[data-doc]').forEach((el) => { if (docStore.get(el.dataset.doc)?.group === group) el.innerHTML = docInner(el.dataset.doc); });
  document.querySelectorAll(`.doctools[data-g="${CSS.escape(group)}"]`).forEach((el) => {
    const mode = docMode[group] ?? 'rendered';
    el.querySelectorAll('[data-docmode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.docmode === 'rendered' ? mode === 'rendered' : mode !== 'rendered')));
    const eb = el.querySelector('[data-docedit]'); if (eb) { eb.hidden = mode === 'rendered'; eb.setAttribute('aria-pressed', String(mode === 'edit')); }
  });
}
async function docSave(id) {
  const d = docStore.get(id), ta = document.querySelector(`textarea.docedit[data-doc="${CSS.escape(id)}"]`); if (!d?.edit || !ta) return;
  try {
    const res = await postJson('/api/agents/doc', { agent: d.edit.agent, file: d.edit.file, text: ta.value, base: d.edit.base });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { flash(j.error || 'Not saved (HTTP ' + res.status + ')', 'err', false, 9000); return; }
    agentView.data = j; docMode[d.group] = 'raw';
    const box = $('agentbody'); if (box) { box.innerHTML = agentBody(state.r.agents.find((x) => x.id === d.edit.agent)); wireAgent(); }
    flash('Saved. The previous version is kept next to the file (.bak-…).', 'ok', false, 5000);
  } catch (e) { flash('Could not reach Cockpit: ' + e.message, 'err', false, 9000); }
}
document.addEventListener('click', (e) => {
  const m = e.target.closest?.('[data-docmode]');
  if (m) { const g = m.closest('.doctools').dataset.g; docMode[g] = m.dataset.docmode; docRedraw(g); return; }
  const ed = e.target.closest?.('[data-docedit]'); if (ed) { docMode[ed.dataset.docedit] = 'edit'; docRedraw(ed.dataset.docedit); document.querySelector('.docbody textarea.docedit')?.focus(); return; }
  const cn = e.target.closest?.('[data-doccancel]'); if (cn) { const d = docStore.get(cn.dataset.doccancel); if (d) { delete d.draft; docMode[d.group] = 'raw'; docRedraw(d.group); } return; }
  const sv = e.target.closest?.('[data-docsave]'); if (sv) void docSave(sv.dataset.docsave);
});
document.addEventListener('input', (e) => { const ta = e.target.closest?.('textarea.docedit'); if (!ta) return; const d = docStore.get(ta.dataset.doc); if (d) d.draft = ta.value; const c = ta.parentElement.querySelector('[data-count]'); if (c && d?.edit) c.textContent = `${ta.value.length}${d.edit.limit ? ' / ' + d.edit.limit : ''} characters`; });
document.addEventListener('toggle', (e) => { const d = e.target; if (d.classList?.contains('steps') && chat.msgs[d.dataset.m]) chat.msgs[d.dataset.m].open = d.open; }, true);
function bubble(m) {
  if (m.role === 'user') return `<div class="msg user"><div class="bub">${mdLite(m.text)}</div></div>`;
  // Thinking and tool calls fold into one closed line ("5 steps"); open it for the detail. While Atlas works it shows the latest step.
  const tl = m.tools || [], working = !m.text && !m.error;
  const steps = m.think || tl.length ? `<details class="steps" data-m="${chat.msgs.indexOf(m)}" ${m.open ? 'open' : ''}><summary>${working ? 'Working' : 'Worked'} · ${tl.length} step${tl.length === 1 ? '' : 's'}${working && tl.length ? ' · ' + esc(tl[tl.length - 1].slice(0, 60)) : ''}</summary>${m.think ? `<div class="think">${esc(m.think)}</div>` : ''}${tl.map((t) => `<div class="tool" title="${esc(t)}">⚙ ${esc(t)}</div>`).join('')}</details>` : '';
  const body = m.error ? `<div class="err">${esc(m.error)}</div>` : m.text ? mdLite(m.text) : '<span class="dots" aria-label="Atlas is working"><i></i><i></i><i></i></span>';
  return `<div class="msg atlas"><div class="av" aria-hidden="true">A</div><div class="bub">${steps}${body}</div></div>`;
}
const SUGGEST = ['How is everything?', 'What needs me right now?', 'Which agents are busy?', 'Do we need a new agent for anything that is waiting?'];
function viewChat(r) {
  const sug = SUGGEST.map((s) => `<button type="button" class="chipbtn" data-sug="${esc(s)}">${esc(s)}</button>`).join('');
  return `<div class="chat">
    <div class="chat-head"><div><b>Atlas</b> <span class="muted">· chief of staff</span></div><button type="button" id="newchat" class="chipbtn">New conversation</button></div>
    <div class="chat-log" id="chatlog" aria-live="polite">${chat.msgs.length ? chat.msgs.map(bubble).join('') : `<div class="chat-empty"><b>Talk to Atlas</b><div class="muted">Ask for status, create tasks, or decide on a new agent. Atlas has the same memory and tools as on Telegram.</div><div class="sug">${sug}</div></div>`}</div>
    <form class="chat-form" id="chatform"><textarea id="chatin" rows="3" placeholder="Message Atlas…  (Enter to send, Shift+Enter for a new line)" aria-label="Message Atlas"></textarea>
      <button type="submit" id="chatsend" class="primary">${chat.busy ? 'Stop' : 'Send'}</button></form></div>`;
}
/* The chat lives in a dock on the right (opened by the floating button), not in a page of its own. */
function setChat(open, focus) {
  state.chatOpen = open; store.set('chatOpen', open ? '1' : '');
  document.body.classList.toggle('chat-open', open);
  if (open) { renderDock(true); if (focus) $('chatin')?.focus(); } else if (chat.busy) { /* keep streaming; the reply is saved when it ends */ }
  setHeaderHeight();
}
function renderDock(force) {
  if (!state.chatOpen || !state.r) return;
  const body = $('dockbody');
  if (!force && body.querySelector('.chat')) return;   // keep the conversation alive across refreshes
  body.innerHTML = viewChat(state.r); wireChat();
}
function wireChat() {
  const log = $('chatlog'), input = $('chatin'); if (!log) return;
  const scroll = () => { log.scrollTop = log.scrollHeight; };
  const fit = () => { input.style.height = 'auto'; input.style.height = Math.min(Math.max(input.scrollHeight, 82), 200) + 'px'; };
  scroll();
  if (chat.prefill) { input.value = chat.prefill; chat.prefill = ''; fit(); }
  input.oninput = fit;
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('chatform').requestSubmit(); } };
  document.querySelectorAll('[data-sug]').forEach((b) => b.onclick = () => { input.value = b.dataset.sug; $('chatform').requestSubmit(); });
  $('newchat').onclick = () => { if (chat.busy) chat.ctl?.abort(); chat.msgs = []; chat.sessionId = 'cockpit-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24); saveChat(); renderDock(true); };
  $('chatform').onsubmit = async (e) => {
    e.preventDefault();
    if (chat.busy) return chat.ctl?.abort();
    const text = input.value.trim(); if (!text) return;
    input.value = ''; fit();
    chat.msgs.push({ role: 'user', text }); const reply = { role: 'atlas', text: '', think: '', tools: [] }; chat.msgs.push(reply);
    chat.busy = true; chat.ctl = new AbortController();
    const paint = () => { log.innerHTML = chat.msgs.map(bubble).join(''); scroll(); $('chatsend').textContent = chat.busy ? 'Stop' : 'Send'; };
    paint();
    try {
      const res = await postJson('/api/chat', { message: text, sessionId: chat.sessionId });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'HTTP ' + res.status);
      const rd = res.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) !== -1) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!line.startsWith('data: ')) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.t === 'text') reply.text += ev.v; else if (ev.t === 'think') reply.think += ev.v;
          else if (ev.t === 'tool') { if (reply.tools.at(-1) !== ev.v) reply.tools.push(ev.v); } else if (ev.t === 'error') reply.error = ev.v;
          if (state.chatOpen) paint();
        }
      }
    } catch (err) { if (err.name !== 'AbortError') reply.error = err.message; else if (!reply.text) reply.error = 'Stopped.'; }
    chat.busy = false; chat.ctl = null; saveChat(); if (state.chatOpen) paint(); load(false); // a task Atlas made shows up on the next refresh
  };
  input.focus();
}

/* ---------- New task ---------- */
function staffingHTML(r, s, task, portfolio) {
  if (!s) return '';
  const verdict = { covered: ['ok', 'An agent on the team fits'], gap: ['warn', 'No agent on the team fits'], 'no-team': ['warn', 'Nobody serves this portfolio yet'] }[s.verdict];
  const best = s.best[0], cand = s.candidates.map((c) => `<li>${esc(c.emoji)} <b>${esc(c.name)}</b> <span class="muted">· ${esc(c.division)} · ${Math.round(c.bytes / 1000)} KB prompt</span><div class="muted">${esc(c.description.slice(0, 150))}</div></li>`).join('');
  const ask = `Task ${task.id} on ${gName(portfolio)}: "${task.title}". Evaluate whether our current agents cover it. ${s.candidates[0] ? `If not, consider creating a ${s.candidates[0].name} (${s.candidates[0].slug}) from the agency-agents catalog. ` : ''}Propose which model it should run on, and ask me to confirm before creating anything.`;
  return `<div class="staff ${verdict[0]}"><b>${verdict[1]}.</b> ${esc(s.note)} <span class="muted">(keyword check — Atlas can judge better)</span>
    ${cand ? `<ul class="plain">${cand}</ul>` : ''}
    <div class="acts">${best && best.state === 'active' && s.verdict === 'covered' ? `<button type="button" class="primary" data-assign="${esc(task.id)}" data-portfolio="${esc(portfolio)}" data-agent="${esc(r.agents.find((a) => a.id === best.id)?.profile ?? best.id)}">Assign to ${esc(best.name)}</button>` : ''}
      <button type="button" data-ask="${esc(ask)}">Ask Atlas to decide</button></div></div>`;
}
const newMode = { v: 'project' };
function setNewMode(m) {
  newMode.v = m;
  $('m-project').setAttribute('aria-pressed', m === 'project'); $('m-task').setAttribute('aria-pressed', m === 'task');
  $('proj-fields').hidden = m !== 'project'; $('n-projhint').hidden = m !== 'project'; $('task-fields').hidden = m !== 'task';
  $('n-heading').textContent = m === 'project' ? 'New project' : 'New task';
  $('t-submit').textContent = m === 'project' ? 'Create charter' : 'Create task';
  $('t-title').required = m === 'task';   // a required field inside the hidden half would silently block the other form
  $('t-result').innerHTML = ''; document.querySelectorAll('#taskdlg .fld.bad').forEach((x) => x.classList.remove('bad'));
}
let repoSeq = 0;
async function fillRepos(select) {
  const seq = ++repoSeq;
  let repos = []; try { repos = await (await fetch('/api/repos')).json(); } catch { /* none */ }
  if (seq !== repoSeq) return; // a newer call (e.g. Start a project) wins
  const g = $('t-portfolio').value;
  $('p-repo').innerHTML = '<option value="">No repo yet — I will describe it</option><option value="__new__">＋ Create a new repo from this description</option>' + repos.filter((x) => x.portfolio === g && x.path).map((x) => `<option value="${esc(x.id)}">${esc(x.id)} — ${esc(x.path)}${x.exists ? '' : ' (folder missing)'}</option>`).join('');
  if (select) $('p-repo').value = select;
  syncRepoUi();
}
function syncRepoUi() {
  const v = $('p-repo').value;
  $('p-newrepo-row').hidden = v !== '__new__';
  if (v === '__new__' && !$('p-newrepo').value && $('p-outcome').value) $('p-newrepo').value = $('p-outcome').value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => !['a', 'an', 'the', 'of', 'to', 'for', 'and', 'in', 'on', 'with'].includes(w)).slice(0, 3).join('-');
}
async function submitProject() {
  const portfolio = $('t-portfolio').value, outcome = $('p-outcome').value.trim();
  const done_when = $('p-done').value.split('\n').map((x) => x.trim()).filter(Boolean);
  const repoSel = $('p-repo').value, newName = $('p-newrepo').value.trim();
  const problems = [];   // [field id, message]: shown together, so nothing is guessed at
  if (!portfolio) problems.push(['t-portfolio', 'Portfolio: pick one.']);
  if (!outcome) problems.push(['p-outcome', 'Outcome: say in one sentence what the project should achieve.']);
  else if (outcome.length > 300) problems.push(['p-outcome', `Outcome: ${outcome.length} characters; the limit is 300.`]);
  if (!done_when.length) problems.push(['p-done', 'Done when: add at least one check that shows the project is finished (one per line).']);
  else if (done_when.length > 8 || done_when.some((x) => x.length > 200)) problems.push(['p-done', 'Done when: at most 8 checks, each under 200 characters.']);
  if (repoSel === '__new__' && !/^[a-z][a-z0-9-]{1,47}$/.test(newName)) problems.push(['p-newrepo', 'New repo name: lowercase letters, digits and dashes only, starting with a letter (for example auto-research-agent).']);
  if (/[^A-Za-z0-9.-]/.test($('p-deploy').value.replace(/[,\s]/g, ''))) problems.push(['p-deploy', 'Deploy to: hostnames only, separated by commas.']);
  if (/[\n\r]/.test($('p-test').value)) problems.push(['p-test', 'Test command: one line only.']);
  document.querySelectorAll('#taskdlg .fld.bad').forEach((x) => x.classList.remove('bad'));
  if (problems.length) {
    problems.forEach(([id]) => $(id).closest('.fld')?.classList.add('bad'));
    showResult(`<div class="problems"><b class="err">The charter was not created. Fix ${problems.length === 1 ? 'this' : 'these'}:</b><ul>${problems.map(([, m]) => `<li>${esc(m)}</li>`).join('')}</ul></div>`);
    $(problems[0][0]).focus(); return;
  }
  $('t-submit').disabled = true;
  try {
    const res = await postJson('/api/projects/propose', { portfolio, outcome, done_when, repo: $('p-repo').value === '__new__' ? '' : $('p-repo').value, new_repo: $('p-repo').value === '__new__' ? { id: $('p-newrepo').value.trim() } : null, priority: Number($('p-prio').value), deploy_targets: $('p-deploy').value, test_cmd: $('p-test').value });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
    mergeProject(j.project);
    $('t-result').innerHTML = `<div class="okmsg">Charter <code>${esc(j.id)}</code> drafted. Review it under <a href="#/g/${esc(portfolio)}" id="gotoproj">${esc(gName(portfolio))} → Projects</a> and press <b>Approve charter</b>; pm then plans the tasks by itself.</div>`;
    $('gotoproj').onclick = () => $('taskdlg').close();
    $('p-outcome').value = ''; $('p-done').value = ''; load(true);
  } catch (err) { showResult(`<div class="problems"><b class="err">The charter was not created.</b><ul><li>${esc(err instanceof TypeError ? 'Could not reach Cockpit (' + err.message + '). Is it running? Reload the page and try again.' : err.message)}</li></ul></div>`); }
  $('t-submit').disabled = false;
}
/** Show a result inside the dialog and scroll it into view: a message below the fold looks like nothing happened. */
function showResult(html) { const el = $('t-result'); el.innerHTML = html; el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
function openTaskDialog(prefill = {}) {
  const r = state.r, d = $('taskdlg');
  setNewMode(prefill.title ? 'task' : 'project');
  const portfolio = prefill.portfolio || (route().startsWith('g/') ? route().slice(2) : GROUPS[0].id);
  $('t-portfolio').disabled = !!prefill.lock;
  $('t-portfolio').innerHTML = GROUPS.map((g) => `<option value="${esc(g.id)}" ${g.id === portfolio ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
  const fillAssignees = () => { $('t-assignee').innerHTML = `<option value="">Not assigned yet — check staffing first (recommended)</option>${agentOptions(r, $('t-portfolio').value)}`; };
  fillAssignees(); void fillRepos(); $('t-portfolio').onchange = () => { fillAssignees(); void fillRepos(); };
  $('t-title').value = prefill.title || ''; $('t-body').value = ''; $('t-result').innerHTML = ''; $('t-submit').disabled = false;
  for (const k of ['p-outcome', 'p-done', 'p-test', 'p-deploy', 'p-newrepo']) { $(k).value = ''; delete $(k).dataset.touched; }
  $('t-hint').textContent = '';
  $('t-assignee').onchange = () => { $('t-hint').textContent = $('t-assignee').value ? 'The agent starts on it within about a minute and may spend tokens.' : 'Parked until an owner is chosen: nothing starts yet.'; };
  $('t-assignee').onchange();
  d.showModal(); (newMode.v === 'project' ? $('p-outcome') : $('t-title')).focus();
}
async function submitTask(e) {
  e.preventDefault();
  try { await submitTaskInner(); } catch (err) { showResult(`<div class="problems"><b class="err">Something went wrong.</b><ul><li>${esc(err.message)}</li></ul></div>`); $('t-submit').disabled = false; }
}
async function submitTaskInner() {
  if (newMode.v === 'project') return submitProject();
  const portfolio = $('t-portfolio').value, title = $('t-title').value.trim(), assignee = $('t-assignee').value;
  if (!title) { showResult('<div class="problems"><b class="err">Say what needs doing.</b></div>'); $('t-title').focus(); return; }
  if (assignee && !confirm(`Assign this to ${$('t-assignee').selectedOptions[0].textContent} now? It will start working on it.`)) return;
  $('t-submit').disabled = true;
  try {
    const res = await postJson('/api/tasks', { portfolio, title, body: $('t-body').value, assignee });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
    $('t-result').innerHTML = `<div class="okmsg">Created <code>${esc(j.task.id)}</code> on ${esc(gName(portfolio))} — ${j.task.assignee ? 'assigned to ' + esc(j.task.assignee) : 'waiting for an owner'}.</div>${staffingHTML(state.r, j.staffing, j.task, portfolio)}`;
    $('t-title').value = ''; $('t-body').value = ''; load(true);
  } catch (err) { $('t-result').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
  $('t-submit').disabled = false;
}
async function assignTo(taskId, portfolio, agent) {
  if (!agent) return;
  const why = prompt(`Assign ${taskId} to ${agent}? It will start working on it.\n\nWhy this agent? (one line; it is shown later next to how the task went)`, '');
  if (why === null) return;
  const res = await postJson('/api/tasks/assign', { id: taskId, portfolio, assignee: agent, why });
  const j = await res.json();
  if (!res.ok) return alert(j.error || 'Could not assign');
  $('taskdlg').close(); load(true);
}
document.addEventListener('click', (e) => {
  const ask = e.target.closest?.('[data-ask]'); if (ask) { $('taskdlg').close(); askAtlas(ask.dataset.ask); return; }
  const nt = e.target.closest?.('[data-needtab]'); if (nt) { state.needTab = nt.dataset.needtab; renderView(state.r); return; }
  const nv = e.target.closest?.('[data-needview]'); if (nv) { state.needView = nv.dataset.needview; state.needTab = 'all'; renderView(state.r); return; }
  const as = e.target.closest?.('[data-assign]'); if (as) { const sel = as.dataset.agent ? as.dataset.agent : document.querySelector(`select[data-assign-for="${as.dataset.assign}"]`)?.value; assignTo(as.dataset.assign, as.dataset.portfolio, sel); }
});

/* ---------- agent detail: prompt, skills, memory ---------- */
const agentView = { id: null, tab: 'about', data: null, filter: '', loading: false, error: '' };
function viewAgent(r, id, tab) {
  const a = r.agents.find((x) => x.id === id);
  if (!a) return '<h1>Agent</h1><div class="empty">No such agent.</div>';
  if (agentView.id !== id) { Object.assign(agentView, { id, data: null, growth: null, growthError: '', tab: 'about', filter: '', error: '', loading: true }); loadAgent(id); }
  if (['prompt', 'skills', 'memory', 'about', 'growth'].includes(tab)) agentView.tab = tab; // deep link: #/agent/pm/about
  const tabs = [['about', 'About you'], ['prompt', 'Prompts'], ['skills', 'Skills'], ['memory', 'Memory'], ['growth', 'Growth']].map(([k, n]) => `<button type="button" data-tab="${k}" aria-pressed="${agentView.tab === k}">${n}</button>`).join('');
  return `<div class="split">${agentRail(r, id)}<div class="splitmain">
    <h1><span class="dot ${a.status}"></span> ${a.emoji ? esc(a.emoji) + ' ' : ''}${esc(a.name)} <span class="tag">${esc(AGENT_STATE[a.state])}</span></h1>
    <p class="muted sub">${esc(a.role)}<br>Profile <code>${esc(a.profile)}</code> · ${a.model ? esc(a.model) + (a.provider ? ' · ' + esc(a.provider) : '') : 'no model yet'}${thenText(a) ? ` <span class="muted" title="If it fails, these are tried in this order">then ${esc(thenText(a))}</span>` : ''} <button type="button" class="linkbtn" data-act="model" data-agent="${esc(a.id)}">change models</button> · serves ${a.allPortfolios ? 'all portfolios' : a.portfolios.map((p) => esc(gName(p))).join(', ') || 'nothing yet'}</p>
    ${trafficPanel(a)}
    <div class="toolbar"><span class="seg" role="group" aria-label="Section">${tabs}</span><span class="muted">Sensitive text is masked. Files open rendered; use Raw, then Edit.</span></div>
    <div id="agentbody">${agentBody(a)}</div></div></div>`;
}
/** Left-hand list on an agent's page: jump straight to another agent. */
function agentRail(r, cur) {
  const list = [...r.agents].sort(byTraffic);
  return `<nav class="rail" aria-label="Agents"><a class="all" href="#/agents">All agents</a>` + list.map((a) =>
    `<a href="#/agent/${esc(a.id)}" class="${a.state === 'active' ? '' : 'dim'}"${a.id === cur ? ' aria-current="page"' : ''}><span class="dot ${a.status}"></span>${a.emoji ? esc(a.emoji) + ' ' : ''}${esc(a.name)}</a>`).join('') + '</nav>';
}
async function loadGrowth(id) {
  try { const res = await fetch('/api/agents/' + encodeURIComponent(id) + '/growth'); agentView.growth = res.ok ? await res.json() : null; agentView.growthError = res.ok ? '' : 'No growth records yet.'; }
  catch (e) { agentView.growth = null; agentView.growthError = e.message; }
}
async function loadAgent(id) {
  void loadGrowth(id).then(() => { const box = $('agentbody'); if (box && agentView.id === id && ['memory', 'about', 'growth'].includes(agentView.tab)) { box.innerHTML = agentBody(state.r.agents.find((x) => x.id === id)); wireAgent(); } });
  try { const res = await fetch('/api/agents/' + encodeURIComponent(id)); agentView.data = res.ok ? await res.json() : null; agentView.error = res.ok ? '' : (res.status === 404 ? 'No Hermes profile folder for this agent yet.' : 'HTTP ' + res.status); }
  catch (e) { agentView.error = e.message; }
  agentView.loading = false; const box = $('agentbody'); if (box && agentView.id === id) { box.innerHTML = agentBody(state.r.agents.find((x) => x.id === id)); wireAgent(); }
}
function memBlock(title, m, group = 'agent-memory', file = 'memory') {
  const pct = m.limit ? Math.min(100, Math.round((m.chars / m.limit) * 100)) : 0, id = `${agentView.id}:${file}`;
  const blocked = /\[MASKED/.test(m.text) ? 'This file contains values Cockpit hides (emails, numbers, keys). Saving here would overwrite them with a placeholder; edit the file directly.' : '';
  const edit = m.exists ? { agent: agentView.id, file, base: m.sha, limit: m.limit } : null;
  return `<section class="panel"><h2>${esc(title)} <span class="right">${m.chars} / ${m.limit} characters (${pct}%) ${m.exists ? docTools(group, { edit, blocked }) : ''}</span></h2>${pctBar(pct)}${m.exists ? docBody(group, id, m.text, { edit: blocked ? null : edit, empty: '<span class="muted">(empty)</span>' }) : '<div class="empty">No file yet — it is created the first time the agent saves a memory.</div>'}</section>`;
}
function agentBody(a) {
  if (agentView.tab === 'growth') return growthTab(a);
  if (agentView.tab === 'about' && !agentView.loading && !agentView.data) return aboutTab(a, null);
  if (agentView.loading) return '<div class="muted">Loading…</div>';
  if (agentView.error || !agentView.data) return `<div class="empty">${esc(agentView.error || 'No data.')} ${a?.state === 'proposed' ? 'Create it with <code>npm run agents -- sync --apply</code>.' : ''}</div>`;
  const d = agentView.data;
  if (agentView.tab === 'prompt') {
    const ro = d.prompt.roster, drift = { current: 'matches the catalog version you added', changed: '⚠ the catalog persona changed upstream since you added it', 'catalog-missing': 'catalog not available to compare', null: '' }[ro.drift] ?? '';
    const blocked = /\[MASKED/.test(d.prompt.text) ? 'This prompt contains values Cockpit hides. Saving here would overwrite them with a placeholder; edit the file directly.' : '';
    const edit = d.prompt.exists ? { agent: agentView.id, file: 'soul', base: d.prompt.sha, limit: 0 } : null;
    return `<section class="panel"><h2>Identity prompt (SOUL.md) <span class="right">${d.prompt.chars} characters · <code>${esc(d.dir)}/SOUL.md</code> ${d.prompt.exists ? docTools('agent-prompt', { edit, blocked }) : ''}</span></h2>
      ${ro.personaSlug ? `<div class="muted" style="margin-bottom:8px">Persona from agency-agents: <code>${esc(ro.personaSlug)}</code> — ${esc(drift)}.${ro.personaSlug && ro.installed ? ' Edits inside the persona block count as drift from the catalog; put your own rules outside it.' : ''}</div>` : '<div class="muted" style="margin-bottom:8px">No catalog persona: this prompt was written by hand or by Hermes.</div>'}
      ${d.prompt.exists ? docBody('agent-prompt', agentView.id + ':soul', d.prompt.text, { edit: blocked ? null : edit }) : '<div class="empty">No SOUL.md.</div>'}
      <div class="muted" style="margin-top:6px">This is added to every turn. Skills and memory below are added on top of it when relevant.</div></section>`;
  }
  if (agentView.tab === 'skills') {
    const k = d.skills, f = agentView.filter.toLowerCase();
    const rows = k.items.filter((s) => !f || `${s.name} ${s.category} ${s.description}`.toLowerCase().includes(f));
    return `<div class="tiles"><div class="tile"><span class="k">Skills</span><span class="v">${k.total}</span><span class="s">${k.archived} archived</span></div>
      <div class="tile ${k.agent ? 'ok' : ''}"><span class="k">Written by the agent</span><span class="v">${k.agent}</span><span class="s">what it has learned by itself</span></div>
      <div class="tile"><span class="k">Bundled with Hermes</span><span class="v">${k.bundled}</span><span class="s">${k.platform} from this platform</span></div>
      <div class="tile"><span class="k">Hub or added by hand</span><span class="v">${k.hub + k.added}</span><span class="s">${k.hub} from a skill hub · ${k.added} other</span></div></div>
      <section class="panel"><h2>Skills <span class="right"><input id="skillq" type="search" placeholder="Filter…" value="${esc(agentView.filter)}" style="padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg)"></span></h2>
      <div class="tablewrap"><table><thead><tr><th>Skill</th><th>Source</th><th>Category</th><th class="num">Uses</th><th>Last used</th><th>What it does</th></tr></thead><tbody>${rows.slice(0, 200).map((s) => `<tr><td><b>${esc(s.name)}</b>${s.pinned ? ' 📌' : ''}${s.stale ? ' <span class="tag" title="unused for a long time">stale</span>' : ''}</td><td><span class="tag">${esc(s.source)}</span></td><td>${esc(s.category)}</td><td class="num">${s.uses}${s.patches ? ` <span class="muted" title="times it was improved">✎${s.patches}</span>` : ''}</td><td>${s.lastUsedAt ? esc(ago(s.lastUsedAt)) : '—'}</td><td class="muted">${esc(s.description)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No match.</td></tr>'}</tbody></table></div>
      <div class="muted" style="margin-top:6px">By category: ${k.byCategory.slice(0, 12).map((c) => `${esc(c.category)} ${c.count}`).join(' · ')}</div></section>`;
  }
  if (agentView.tab === 'about') return aboutTab(a, d);
  return memBlock('Memory (MEMORY.md) — what it has noted for itself', d.memory.memory) + lessonsPanel(a) + '<div class="muted">Hermes caps its own memory file. Lessons are the durable, sourced part: they are kept as plain files you can read and correct (~/AgentGrowth), and only the relevant ones are given to the agent before a task.</div>';
}

/* ---------- growth: what an agent has learned, what it knows about you, and whether it is improving ---------- */
const STATE_TAG = { active: 'in use', tentative: 'tentative', retracted: 'retracted', superseded: 'replaced' };
const LSTATUS = { tentative: 'unverified', local: 'worked once', reused: 'reused', retired: 'retired' };
const gAct = (act, attrs = '') => `data-gact="${act}" ${attrs}`;
function lessonsPanel(a) {
  const g = agentView.growth;
  if (!g) return `<section class="panel"><h2>Lessons learned</h2><div class="muted">${agentView.growthError ? esc(agentView.growthError) : 'Loading…'}</div></section>`;
  const rows = g.lessons.map((l) => `<tr class="${l.status === 'retired' ? 'dim' : ''}"><td><b>${esc(l.title)}</b><div class="muted" style="font-size:12px">${esc(l.lesson)}</div><div class="muted" style="font-size:12px">When: ${esc(l.when)}${l.not_when ? ` · Not when: ${esc(l.not_when)}` : ''}</div></td><td><span class="tag">${esc(LSTATUS[l.status])}</span>${l.retired_reason ? `<div class="muted" style="font-size:12px">${esc(l.retired_reason)}</div>` : ''}</td><td class="num">${l.wins}/${l.losses}</td><td>${l.status !== 'retired' ? `<button type="button" class="linkbtn" ${gAct('lesson-retire', `data-id="${esc(l.id)}"`)}>retire</button>` : ''}</td></tr>`).join('');
  return `<section class="panel"><h2>Lessons learned<span class="right muted">${g.lessons.filter((l) => l.status !== 'retired').length} in use · a lesson is promoted only by outcomes</span></h2>${g.lessons.length ? `<div class="tablewrap"><table><thead><tr><th>Lesson</th><th>Status</th><th class="num">Wins/losses</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">None yet. After a task that went differently than expected, the agent writes what it learned, with when it applies and when it does not.</div>'}</section>`;
}
function aboutTab(a, d) {
  const g = agentView.growth;
  const rows = g ? g.about.filter((e) => e.state !== 'retracted').map((e) => `<tr class="${e.state === 'superseded' ? 'dim' : ''}"><td><span class="tag">${esc(e.kind)}</span> ${esc(e.text)}<div class="muted" style="font-size:12px">${e.source === 'user-said' ? 'you said so' : e.source === 'correction' ? 'your correction' : `seen ${e.support + 1}× ${e.oppose ? `, contradicted ${e.oppose}×` : ''}`} · ${esc(e.observed)}${e.scope === '*' ? ' · every agent' : ''}</div>${e.always ? '<div class="alwaysbadge" title="Written into the prompt of every agent it covers, so it applies on every turn">★ always applied</div>' : ''}</td><td><span class="tag">${esc(STATE_TAG[e.state])}</span><div class="muted" style="font-size:12px">confidence ${e.confidence}</div></td><td style="white-space:nowrap">${e.state === 'superseded' ? '' : `<button type="button" class="linkbtn" ${gAct('about-correct', `data-id="${esc(e.id)}" data-text="${esc(e.text)}"`)}>correct</button> · <button type="button" class="linkbtn" ${gAct('about-retract', `data-id="${esc(e.id)}"`)}>forget</button>${e.source === 'user-said' ? ` · <button type="button" class="linkbtn" ${gAct('about-always', `data-id="${esc(e.id)}" data-always="${e.always ? '0' : '1'}"`)}>${e.always ? 'stop always applying' : 'always apply'}</button>` : ''}${e.state === 'tentative' ? ` · <button type="button" class="linkbtn" ${gAct('about-confirm', `data-id="${esc(e.id)}"`)}>that's right</button>` : ''}`}</td></tr>`).join('') : '';
  const add = `<div class="aboutadd"><input id="g-text" maxlength="240" placeholder="e.g. Wants a one-line summary before any detail" aria-label="Something ${esc(a.name)} should know"><select id="g-kind"><option value="preference">preference</option><option value="constraint">rule (never cut)</option><option value="workflow">how I work</option><option value="decision-rule">how I decide</option></select><label class="muted"><input type="checkbox" id="g-all"> every agent</label><label class="muted" title="Written into the system prompt, so it applies on every turn (also for the Personal Privacy agent). Without it, an entry is handed over with the task's context packet."><input type="checkbox" id="g-always"> always apply</label><button type="button" class="primary" ${gAct('about-add')}>Tell ${esc(a.name)}</button></div>`;
  return `<section class="panel"><h2>Rules and preferences: what ${esc(a.name)} knows about how you work<span class="right muted">your statements and corrections win; confidence is computed from evidence</span></h2>
    <div class="muted" style="margin-bottom:8px">★ <b>Always apply</b> rules are written into the prompt at the top (see Prompts), so they hold on every turn, for the Personal Privacy agent too. Other entries reach the agent with its task context, ranked by relevance. Use <i>rule (never cut)</i> for must and never, <i>how I decide</i> for choices, <i>preference</i> for tendencies.</div>
    ${g ? (rows ? `<div class="tablewrap"><table><thead><tr><th>Evidence</th><th>State</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">Nothing recorded yet. Tell it below, or it will note what it observes: only task-related signals, with their source, never personal or financial details (those are refused).</div>') : `<div class="muted">${agentView.growthError ? esc(agentView.growthError) : 'Loading…'}</div>`}
    ${add}</section>` + (d ? memBlock('About you (USER.md) — Hermes\' own notes about you', d.memory.user, 'agent-user', 'user') : '');
}
const miniBar = (pct) => `<span class="sbar"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></span>`;
function growthTab(a) {
  const g = agentView.growth;
  if (!g) return `<section class="panel"><h2>Growth</h2><div class="muted">${agentView.growthError ? esc(agentView.growthError) : 'Loading…'}</div></section>`;
  const W = g.metrics.weeks, f = (n, d = 1) => (n === null ? '—' : String(Math.round(n * 10 ** d) / 10 ** d));
  const rows = [...W].reverse().map((w) => { const per = (x) => (w.done ? x / w.done : null); return `<tr><td>${esc(w.key)}</td><td class="num">${w.done}</td><td class="num">${w.done ? Math.round(100 * w.untouched / w.done) + '%' : '—'} ${w.done ? miniBar(100 * w.untouched / w.done) : ''}</td><td class="num">${f(per(w.retries))}</td><td class="num">${f(per(w.minutes))}</td><td class="num">${w.done ? full(Math.round(w.tokens / w.done)) : '—'}</td></tr>`; }).join('');
  const total = W.reduce((n, w) => n + w.done, 0), live = g.lessons.filter((l) => l.status !== 'retired');
  const tiles = `<div class="tiles"><div class="tile"><span class="k">Finished tasks (8 weeks)</span><span class="v">${total}</span><span class="s">${total < 5 ? 'too few to call a trend' : 'from the boards'}</span></div>
    <div class="tile"><span class="k">Lessons in use</span><span class="v">${live.length}</span><span class="s">${live.filter((l) => l.status === 'reused').length} reused · ${live.filter((l) => l.status === 'local').length} worked once · ${live.filter((l) => l.status === 'tentative').length} unverified</span></div>
    <div class="tile"><span class="k">Known about you</span><span class="v">${g.about.filter((e) => e.state === 'active').length}</span><span class="s">${g.about.filter((e) => e.state === 'tentative').length} tentative</span></div>
    <div class="tile"><span class="k">Context packets given</span><span class="v">${g.packets}</span><span class="s">before tasks, so far</span></div></div>`;
  return tiles + `<section class="panel"><h2>Is ${esc(a.name)} getting better?<span class="right muted">measured from finished tasks, newest week first</span></h2><div class="tablewrap"><table><thead><tr><th>Week</th><th class="num">Finished</th><th class="num">Ran without you</th><th class="num">Extra attempts / task</th><th class="num">Minutes / task</th><th class="num">Tokens / task</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="muted" style="margin-top:6px">Better = more tasks that need nobody, fewer retries, less time and fewer tokens per task. A bigger prompt or a longer notes file is not improvement; this table is the evidence.</div></section>` +
    `<section class="panel"><h2>Latest weekly report${g.reports.weekly[0] ? ` · ${esc(g.reports.weekly[0].replace('.md', ''))}` : ''}<span class="right">${g.latestWeekly ? docTools('growth-weekly') : ''}</span></h2>${g.latestWeekly ? docBody('growth-weekly', agentView.id + ':weekly', g.latestWeekly) : '<div class="empty">The first one is written on Sunday night by the growth job (or run <code>npm run growth -- weekly --apply</code>).</div>'}</section>`;
}
document.addEventListener('click', async (e) => {
  const t = e.target.closest?.('[data-gact]'); if (!t) return;
  const a = state.r.agents.find((x) => x.id === agentView.id); if (!a) return;
  const act = t.dataset.gact, body = { agent: a.id, action: act, id: t.dataset.id };
  if (act === 'about-add') {
    body.text = $('g-text').value.trim(); body.kind = $('g-kind').value; if ($('g-all').checked) body.agent = '*'; if ($('g-always')?.checked) body.always = true;
    if (!body.text) { flash('Write what it should know first.', 'err', false, 4000); return; }
  } else if (act === 'about-always') { body.always = t.dataset.always === '1';
  } else if (act === 'about-correct') {
    const v = prompt('Corrected statement', t.dataset.text); if (!v || v === t.dataset.text) return; body.text = v;
  } else if (act === 'about-retract') { if (!confirm('Forget this? It stays in the file marked retracted and is no longer used.')) return; }
  else if (act === 'lesson-retire') { const why = prompt('Why retire this lesson?', 'no longer true'); if (why === null) return; body.reason = why; }
  document.body.classList.add('working'); flash('Saving…', '', true);
  try {
    const res = await postJson('/api/growth/act', body), j = await res.json().catch(() => ({}));
    if (!res.ok) { flash(j.error || 'Refused (HTTP ' + res.status + ')', 'err', false, 9000); return; }
    agentView.growth = j.growth; flash('Saved.', 'ok', false, 4000);
    const box = $('agentbody'); if (box) { box.innerHTML = agentBody(a); wireAgent(); }
  } catch (err) { flash('Could not reach Cockpit: ' + err.message, 'err', false, 9000); }
  finally { document.body.classList.remove('working'); }
});
function wireAgent() {
  document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { agentView.tab = b.dataset.tab; document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-pressed', x === b)); $('agentbody').innerHTML = agentBody(state.r.agents.find((x) => x.id === agentView.id)); wireAgent(); });
  const q = $('skillq'); if (q) q.oninput = () => { agentView.filter = q.value; const pos = q.selectionStart; $('agentbody').innerHTML = agentBody(state.r.agents.find((x) => x.id === agentView.id)); wireAgent(); const n = $('skillq'); n.focus(); n.setSelectionRange(pos, pos); };
}

/* ---------- views ---------- */
function atlasTone(a) { return a ? a.status : 'unknown'; }
function reasonsHTML(a) {
  if (!a || !a.reasons.length) return '<span class="muted">All checks passing.</span>';
  return '<ul class="reasons">' + a.reasons.map((x) => `<li class="sev-${x.severity}">${x.severity === 'alert' ? '✕' : '▲'} ${esc(x.text)}</li>`).join('') + '</ul>';
}
function viewOverview(r) {
  const a = r.atlas, u = r.usage;
  const lim = u?.limits.flatMap((l) => l.windows.map((w) => ({ ...w, provider: l.provider, plan: l.plan }))).sort((x, y) => y.usedPercent - x.usedPercent)[0];
  const limTone = !lim ? 'unknown' : lim.usedPercent >= 100 ? 'alert' : lim.usedPercent >= 85 ? 'warn' : 'ok';
  const apiCost = u ? u.month.costUsd : 0;
  const sub = u ? u.byModel.filter((m) => m.billing === 'subscription_included').reduce((n, m) => n + m.tokens, 0) : 0;
  const modelTotal = u ? u.byModel.reduce((n, m) => n + m.tokens, 0) : 0;
  const subPct = modelTotal ? Math.round((sub / modelTotal) * 100) : 0;
  const tiles = `<div class="tiles one">
    <div class="tile ${atlasTone(a)}"><span class="k">Atlas</span><span class="v">${STATE_MARK[atlasTone(a)]} ${STATE_WORD[atlasTone(a)]}</span>
      <span class="s">${a ? esc(a.reasons[0]?.text ?? `gateway ${a.gateway.state}, heartbeat ${a.gateway.ageSeconds ?? '—'}s`) : 'no status'}${a && a.reasons.length > 1 ? ` · +${a.reasons.length - 1} more` : ''}${a ? ` · ${a.workersRunning} workers · ${a.gateway.activeAgents} chats` : ''}</span></div>
    <div class="tile ${limTone}"><span class="k">${lim ? esc((lim.provider === 'openai-codex' ? 'Codex' : lim.provider) + ' ' + lim.label.toLowerCase() + ' limit') : 'Subscription limit'}</span>
      <span class="v">${lim ? Math.round(lim.usedPercent) + '% used' : 'n/a'}</span>${lim ? pctBar(lim.usedPercent) : ''}
      <span class="s">${lim ? (lim.resetsAt ? 'resets ' + esc(short(lim.resetsAt)) : '') + (lim.plan ? ' · ' + esc(lim.plan) + ' plan' : '') : 'no provider limits reported'}</span></div>
    <div class="tile"><span class="k">Tokens today</span><span class="v">${u ? compact(u.today.tokens) : '—'}</span>
      <span class="s">${u ? `7 days ${compact(u.week.tokens)} · 30 days ${compact(u.month.tokens)}` : ''}</span></div>
    <div class="tile"><span class="k">Traffic today</span><span class="v">${u ? u.today.sessions : '—'} <small class="muted" style="font-size:13px;font-weight:400">sessions</small></span>
      <span class="s">${u ? 'last activity ' + esc(ago(u.lastActivityAt)) : ''}</span></div>
    <div class="tile"><span class="k">API spend (30 days)</span><span class="v">${usd(apiCost)}</span>
      <span class="s">${u ? `${subPct}% of tokens via subscription (not billed per token)` : ''}</span></div>
    <div class="tile"><span class="k">Earned this month</span><span class="v">${r.earned.sources ? money(r.earned.monthCents) : 'Not connected'}</span>
      <span class="s">${r.earned.sources ? `from ${r.earned.sources} source${r.earned.sources > 1 ? 's' : ''}` : 'add <code>earnings</code> to a data/portfolio file'}</span></div>
  </div>`;
  const atlasNote = a && a.reasons.length ? `<section class="panel"><h2>Atlas status: ${STATE_MARK[a.status]} ${STATE_WORD[a.status]}</h2>${reasonsHTML(a)}</section>` : '';
  return `<h1>Overview</h1><p class="muted sub">How Atlas is doing: health, usage, traffic and money.</p>
    <div class="ovgrid"><div>
      ${tiles}
      ${u ? usagePanel(u, 'Tokens per day · last 14 days') : ''}
      ${agentsPanel(r)}
    </div><div>
      <section class="panel" style="margin-top:0"><h2>Needs you <span class="right"><a href="#/needs">${r.needsYou.length} →</a></span></h2>${needsPanel(r, 8)}</section>
      ${atlasNote}
      <section class="panel"><h2>Latest traffic<span class="right"><a href="#/usage">All usage →</a></span></h2>${u ? trafficTable({ recent: u.recent.slice(0, 8) }) : '<span class="muted">No usage data.</span>'}</section>
    </div></div>
    ${errorsPanel(r)}`;
}
const SLICE_TABS = [['portfolio', 'By portfolio'], ['project', 'By project'], ['model', 'By model']];
/** Last 30 days as bars: one tab each for portfolio, project and model. The table has the exact numbers. */
function slicePanel(u) {
  const tab = state.sliceTab;
  const rows = tab === 'portfolio' ? (u.byPortfolio ?? []).map((x) => ({ id: x.id, label: x.id === '_none' ? 'No project (chat, jobs)' : gName(x.id), tokens: x.tokens, sessions: x.sessions, cost: x.costUsd, sub: '' }))
    : tab === 'project' ? (u.byProject ?? []).map((x) => ({ id: x.id, label: projLabel(x.id), tokens: x.tokens, sessions: x.sessions, cost: x.costUsd, sub: x.portfolio ? gName(x.portfolio) : '', link: x.id.startsWith('_') || x.id.includes(':(no project)') ? null : '#/project/' + x.id }))
    : u.byModel.map((m) => ({ id: m.model, label: m.model, tokens: m.tokens, sessions: m.sessions, cost: m.costUsd, sub: m.billing ? m.billing.replace(/_/g, ' ') : '' }));
  rows.sort((a, b) => b.tokens - a.tokens);
  const total = rows.reduce((n, x) => n + x.tokens, 0) || 1;
  const tabs = SLICE_TABS.map(([k, n]) => `<button type="button" data-slice="${k}" aria-pressed="${tab === k}">${n}</button>`).join('');
  const body = state.sliceTable
    ? `<div class="tablewrap"><table><thead><tr><th>${tab === 'model' ? 'Model' : tab === 'project' ? 'Project' : 'Portfolio'}</th>${tab === 'portfolio' ? '' : `<th>${tab === 'model' ? 'Billing' : 'Portfolio'}</th>`}<th class="num">Tokens</th><th class="num">Share</th><th class="num">Sessions</th><th class="num">API cost</th></tr></thead><tbody>` +
      rows.map((x) => `<tr><td>${x.link ? `<a href="${esc(x.link)}">${esc(x.label)}</a>` : esc(x.label)}</td>${tab === 'portfolio' ? '' : `<td>${esc(x.sub || '—')}</td>`}<td class="num">${full(x.tokens)}</td><td class="num">${Math.round(100 * x.tokens / total)}%</td><td class="num">${x.sessions}</td><td class="num">${usd(x.cost)}</td></tr>`).join('') + '</tbody></table></div>'
    : hbars(rows.slice(0, 14).map((x) => ({ label: x.label, value: x.tokens, text: compact(x.tokens) + ' · ' + Math.round(100 * x.tokens / total) + '%' })), 'wide');
  return `<section class="panel" style="margin-top:0"><h2>Last 30 days<span class="right"><button type="button" id="stgl" style="padding:3px 9px;font-size:12px">${state.sliceTable ? 'Show chart' : 'Show table'}</button></span></h2>
    <div class="toolbar"><span class="seg" role="group" aria-label="Split">${tabs}</span></div>${body}
    <div class="muted" style="margin-top:8px">${tab === 'model' ? 'Subscription usage is not billed per token.' : 'Sessions are matched to the project whose task the agent was running.'}${rows.length > 14 && !state.sliceTable ? ` Top 14 of ${rows.length}; the table has all.` : ''}</div></section>`;
}
function viewUsage(r) {
  const u = r.usage; if (!u) return '<h1>Usage</h1><div class="empty">No usage data. See Data issues.</div>' + errorsPanel(r);
  return `<h1>Usage</h1><p class="muted sub">Tokens from Hermes' session ledgers, all agents. Conversation titles and text are never read. Every chart can be shown as a table.</p>
    <div class="ovgrid"><div>${usagePanel(u, 'Tokens per day · last 14 days', true)}</div><div>${slicePanel(u)}</div></div>${errorsPanel(r)}`;
}
function wireSlices() {
  document.querySelectorAll('[data-slice]').forEach((b) => b.onclick = () => { state.sliceTab = b.dataset.slice; renderView(state.r); });
  const t = $('stgl'); if (t) t.onclick = () => { state.sliceTable = !state.sliceTable; renderView(state.r); };
}

/* ---------- projects (the work model): cards per portfolio, one detail page per project ---------- */
const PSTATUS = { proposed: 'waiting for your approval', active: 'running', paused: 'paused', review: 'ready for your review', done: 'done', cancelled: 'cancelled' };
// One colour per kind of state, used by the task tree and the group list: green done, red blocked, amber your step, blue running, grey waiting.
const stKind = (t) => t.status === 'done' ? 'done' : t.status === 'blocked' ? (t.human ? 'you' : 'blocked') : t.status === 'running' ? 'running' : t.status === 'review' ? 'review' : t.task ? 'queued' : 'new';
const TSTATUS = { done: '✓ done', running: '● running', ready: 'ready', todo: 'waiting for earlier tasks', blocked: '▲ blocked', review: 'in review', 'not created': 'not started' };
const pname = (p) => (p && p.name) || humanize(p && p.id);
const humanize = (id) => id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
/** Top-level tasks that still count against the project's limit: not finished, and not a subtask. */
const activeTop = (p) => p.plan.filter((t) => !t.parent && !['done', 'archived'].includes(t.status)).length;
const capLeft = (p) => (p.max_tasks ?? 20) - activeTop(p);
const btnP = (act, p, label, extra = '') => `<button type="button" data-act="${act}" data-p="${esc(p.id)}" ${extra}>${label}</button>`;
const askText = (p) => `Project ${p.id} (${gName(p.portfolio)}): "${p.outcome}". Status: ${PSTATUS[p.status] ?? p.status}, ${p.auto.done} of ${p.plan.length} tasks done. Tell me what to do next, and what (if anything) needs a human decision.`;

const fmtWhen = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : (d.toDateString() === new Date().toDateString() ? 'at ' : 'on ' + d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) + ' at ') + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
/** The project's automation level as a small label (Full auto / Semi), with what it means on hover. */
const autoTag = (p) => p.autonomy === 'full' ? `<span class="tag auto-full" title="${esc((p.auto_blockers ?? []).length ? 'Full automation, but needs you because ' + p.auto_blockers.join('; ') : 'Starts, closes and confirms agents\' decisions without you; outward actions, spending and new agents still need you')}">Full auto</span>` : '<span class="tag" title="You approve the charter, review the result and confirm agents\' decisions">Semi</span>';
/** What a person should do with this project right now, in plain words. */
function nextStep(p) {
  const n = p.plan.length, a = p.auto;
  const full = p.autonomy === 'full', freeToRun = full && !(p.auto_blockers ?? []).length;
  if (p.status === 'proposed' && freeToRun && p.auto_start_after) return { tone: 'ok', text: `Full automation: starts by itself ${fmtWhen(p.auto_start_after)} unless you stop it. pm then plans, agents work, QA verifies and it closes by itself. Stop it to review the charter first.`, act: 'auto-semi', label: 'Stop: make it semi' };
  if (p.status === 'proposed' && full) return { tone: 'warn', text: `Full automation, but this charter needs your approval because ${(p.auto_blockers ?? []).join('; ')}. Check it, then approve.`, act: 'approve', label: 'Approve charter' };
  if (p.status === 'proposed') return { tone: 'warn', text: 'Check the outcome and “done when”, then approve. pm plans the tasks and agents start; you are not asked about tasks.', act: 'approve', label: 'Approve charter' };
  if (p.status === 'paused') return { tone: 'warn', text: `Paused${p.paused_reason ? ': ' + p.paused_reason : ''}. Fix the cause (cut scope, extend the time box, or decide it is fine), then resume.`, act: 'resume', label: 'Resume' };
  if (p.status === 'review' && freeToRun) return { tone: 'ok', text: 'Every task is done, but the plan had no QA step, so full automation did not close it. Check the result, or ask Atlas to have QA verify it, then mark it done.', act: 'close', label: 'Mark done' };
  if (p.status === 'review') return { tone: 'ok', text: 'Every task is done. Check the result (the repo, the live URL, the write-up), then mark the project done. Ask Atlas if you want it verified first.', act: 'close', label: 'Mark done' };
  if (p.status === 'done') return { tone: 'ok', text: 'Finished. Nothing to do.' };
  if (p.status === 'cancelled') return { tone: 'muted', text: 'Cancelled.' };
  if (p.advance?.do === 'stalled') return { tone: 'warn', text: `The automation is stuck: ${p.advance.why}. Ask Atlas to look, or fix it and it continues by itself.`, act: 'ask', label: 'Ask Atlas' };
  const mine = p.plan.find((t) => t.human && t.task && t.status !== 'done');
  if (mine) return { tone: 'warn', text: `Your step: “${mine.title}”. ${mine.accept} Tasks that depend on it are waiting and start as soon as you mark it done.`, act: 'step-done', label: 'I did this', key: mine.key };
  if (!n && !a.running) return { tone: 'info', text: 'pm is planning this project (it was asked when the charter was approved). Tasks appear here within a few minutes. If nothing shows after ten minutes, ask Atlas.', act: 'ask', label: 'Ask Atlas' };
  if (a.waiting_on_you) return { tone: 'warn', text: `${a.waiting_on_you} task${a.waiting_on_you === 1 ? ' is' : 's are'} blocked or waiting for review. Open the tasks to see why, or ask Atlas to unblock them.`, act: 'open', label: 'See the tasks' };
  if (n && a.done === n) return { tone: 'ok', text: 'Every task is done. Check the result in the repo, then ask Atlas to verify and close the project.', act: 'ask', label: 'Ask Atlas to close it' };
  if (p.hours_left !== null && p.hours_left < 0) return { tone: 'warn', text: `Over the ${p.timebox} time box. The watchdog pauses it soon; decide whether to extend or cut scope.`, act: 'ask', label: 'Ask Atlas' };
  return { tone: 'ok', text: `Nothing needed from you. ${a.done} of ${n} tasks done${a.running ? `, ${a.running} running now` : ''}.` };
}
const autoLine = (p) => {
  const a = p.auto, bits = [];
  if (a.done) bits.push(`<span title="Finished with no one stepping in">✓ ${a.untouched} done without you</span>`);
  if (a.touched) bits.push(`<span title="Blocked, unblocked, reassigned or reopened at some point">✋ ${a.touched} needed you</span>`);
  if (a.running) bits.push(`<span>● ${a.running} running</span>`);
  if (a.waiting_on_you) bits.push(`<span style="color:var(--warn)">▲ ${a.waiting_on_you} waiting on you</span>`);
  return bits.length ? bits.join(' · ') : '<span class="muted">no tasks run yet</span>';
};
const gitLine = (p) => (p.git ? (p.git.missing ? `repo ${esc(p.git.path)} ✗ missing` : p.git.branch ? `⎇ ${esc(p.git.branch)}${p.git.dirty ? ` · ${p.git.dirty} uncommitted` : ' · clean'}` : `${esc(p.git.path)} · not a git repo yet`) : 'no repo linked');

function projectsPanel(id) { return `<section class="panel" id="projects" data-g="${esc(id)}"><h2>Projects<span class="right muted">priority 1 = first</span></h2><div class="muted">Loading…</div></section>`; }

function automationStrip(mine) {
  const t = mine.reduce((s, p) => ({ done: s.done + p.auto.done, untouched: s.untouched + p.auto.untouched, touched: s.touched + p.auto.touched, running: s.running + p.auto.running, wait: s.wait + p.auto.waiting_on_you }), { done: 0, untouched: 0, touched: 0, running: 0, wait: 0 });
  const pct = t.done ? Math.round(100 * t.untouched / t.done) : null;
  return `<div class="autostrip"><div><b>${pct === null ? '—' : pct + '%'}</b><span>of finished tasks ran without you</span></div><div><b>${t.untouched}</b><span>done automatically</span></div><div><b>${t.touched}</b><span>needed you</span></div><div><b>${t.running}</b><span>running now</span></div><div><b>${t.wait}</b><span>waiting on you</span></div></div>`;
}

// ---- Task hierarchy: two levels. Metrics are computed from the plan (top-level tasks and their subtasks), not from raw task counts. ----
const kidsOf = (p, k) => p.plan.filter((x) => x.parent === k);
function hier(p) {
  const tops = p.plan.filter((t) => !t.parent), subs = p.plan.filter((t) => t.parent);
  const cnt = (a, f) => a.filter(f).length;
  const waiting = (t) => !!t.task && (t.status === 'blocked' || t.status === 'review');
  const leaves = p.plan.filter((t) => !kidsOf(p, t.key).length || t.parent);   // work that does the actual job: every subtask, plus top-level tasks with no subtasks
  return {
    tops, subs,
    groupsDone: cnt(tops, (t) => t.status === 'done'),
    subsDone: cnt(subs, (t) => t.status === 'done'),
    running: cnt(p.plan, (t) => t.status === 'running'),
    waiting: cnt(p.plan, waiting),
    notStarted: cnt(leaves, (t) => !t.task),
    queued: cnt(leaves, (t) => !!t.task && ['ready', 'todo', 'scheduled', 'triage'].includes(t.status)),
  };
}
// The state of one top-level task, as a group: done when its wrap-up task is done; running/blocked/etc. from what is inside it.
function groupState(p, t) {
  const kids = kidsOf(p, t.key), all = [t, ...kids];
  if (t.status === 'done') return 'done';
  if (all.some((x) => x.task && x.status === 'blocked' && x.human) || all.some((x) => x.status === 'blocked')) return 'stuck';
  if (all.some((x) => x.status === 'running')) return 'now';
  if (all.some((x) => x.task && x.status === 'done')) return 'now';
  return 'wait';
}
// The colour kind of a top-level task shown as a group: blocked beats your step beats running.
function groupKind(p, t) {
  const all = [t, ...kidsOf(p, t.key)];
  if (t.status === 'done') return 'done';
  if (all.some((x) => stKind(x) === 'blocked')) return 'blocked';
  if (all.some((x) => stKind(x) === 'you')) return 'you';
  if (all.some((x) => x.status === 'running')) return 'running';
  if (all.some((x) => x.task && x.status === 'done')) return 'queued';
  return 'new';
}
function projectStrip(p) {
  if (!p.plan.some((t) => t.parent)) return automationStrip([p]);
  const h = hier(p), a = p.auto, pct = a.done ? Math.round(100 * a.untouched / a.done) : null;
  const open = !!state.showGroups;
  const tile = (b, label) => `<div><b>${b}</b><span>${label}</span></div>`;
  const rows = h.tops.map((t) => {
    const kids = kidsOf(p, t.key), kd = kids.filter((x) => x.status === 'done').length, kind = groupKind(p, t);
    const w = kids.length ? Math.round(100 * kd / kids.length) : (t.status === 'done' ? 100 : 0);
    return `<li class="k-${kind}" data-act="goto-group" data-k="${esc(t.key)}" title="Show this task's subtasks"><span class="gi">●</span><span class="gt">${esc(t.title)}</span><span class="gb"><i style="width:${w}%"></i></span><span class="gn">${kids.length ? `${kd}/${kids.length}` : (t.status === 'done' ? 'done' : '—')}</span></li>`;
  }).join('');
  return `<div class="autostrip"><div class="expandable${open ? ' on' : ''}" data-act="toggle-groups" role="button" tabindex="0" title="Show or hide the top-level tasks"><b>${h.groupsDone}/${h.tops.length}</b><span>top-level tasks done <em class="chevm">${open ? '▾' : '▸'}</em></span></div>${tile(`${h.subsDone}/${h.subs.length}`, 'subtasks done')}${tile(h.running, 'running now')}${tile(h.waiting, 'blocked or waiting on you')}${tile(h.queued + h.notStarted, 'not started yet')}${tile(pct === null ? '—' : pct + '%', 'of finished ran without you')}</div>
    ${open ? `<ul class="gprog">${rows}</ul>` : ''}`;
}
// Folder links for tracking: the project's repo folder and its sub-folders. "Open" shows the folder in Finder on the Mac running Cockpit.
function foldersLine(p) {
  const f = p.folders ?? [];
  if (!f.length) return '';
  const chip = (x) => `<span class="fchip"><a href="#" data-act="open-folder" data-p="${esc(p.id)}" data-f="${esc(x.name)}" title="${esc(x.path)}">📁 ${esc(x.root ? x.name + '/' : x.name)}</a>${x.modified ? `<span class="muted"> ${esc(fmtAt(x.modified))}</span>` : ''} <a href="#" class="muted" data-act="copy-path" data-path="${esc(x.path)}" title="Copy ${esc(x.path)}">copy</a></span>`;
  return `<div class="folders"><span class="muted">Folders</span>${f.map(chip).join('')}</div>`;
}

function projCard(p) {
  const n = p.plan.length, pct = n ? Math.round(100 * p.auto.done / n) : 0, ns = nextStep(p);
  const act = ns.act === 'ask' ? `<button type="button" class="primary" data-act="ask" data-p="${esc(p.id)}">${ns.label}</button>` : ns.act === 'open' ? `<a class="btnlink primary" href="#/project/${esc(p.id)}">${ns.label}</a>` : ns.act ? btnP(ns.act, p, ns.label, 'class="primary"') : '';
  return `<article class="pcard"><div class="ph"><h3><a href="#/project/${esc(p.id)}">${esc(pname(p))}</a></h3><span class="tag">${esc(PSTATUS[p.status] ?? p.status)}</span><span class="tag" title="Priority (1 = first)">P${p.priority}</span>${p.autonomy === 'full' ? autoTag(p) : ''}</div>
    <div class="out">${esc(p.outcome)}</div>
    <div class="meta"><span class="bar" title="${p.auto.done}/${n} tasks done"><i style="width:${pct}%"></i></span><span>${p.auto.done}/${n || '—'} tasks</span>${p.hours_left !== null ? `<span>${p.hours_left >= 0 ? p.hours_left + ' h left' : 'over time box'}</span>` : ''}</div>
    <div class="auto">${autoLine(p)}</div>
    <div class="next ${ns.tone}"><b>What to do</b> ${esc(ns.text)}${act ? `<div class="acts">${act}</div>` : ''}</div>
    <div class="foot"><span class="muted">${gitLine(p)}</span><span class="grow"></span>${btnP('edit', p, 'Edit')}<a class="btnlink" href="#/project/${esc(p.id)}">Tasks &amp; history →</a></div></article>`;
}

function reposPanel(g) {
  const linked = new Set((state.projects ?? []).map((p) => p.git?.path).filter(Boolean));
  const free = (state.repos ?? []).filter((x) => x.portfolio === g && x.path && !linked.has(x.path));
  if (!free.length) return '';
  const rows = free.map((x) => `<tr><td><b>${esc(x.id)}</b><div class="muted" style="font-size:12px">${esc(x.path)}</div></td><td>${x.git && !x.git.missing && x.git.branch ? `⎇ ${esc(x.git.branch)}${x.git.dirty ? ` · ${x.git.dirty} uncommitted` : ' · clean'}` : '<span class="muted">not a git repo yet (or folder missing)</span>'}</td><td><button type="button" data-act="startrepo" data-repo="${esc(x.id)}" data-g="${esc(g)}">Start a project</button></td></tr>`).join('');
  return `<h3 style="margin:14px 0 6px;font-size:13px" class="muted">Repos with no project yet</h3><div class="tablewrap"><table><tbody>${rows}</tbody></table></div>`;
}

const HELP = `<details class="help"><summary>How projects work</summary><ol>
<li><b>You</b> describe a project once: outcome and “done when”. Press <b>＋ New project</b> above.</li>
<li><b>You approve the charter</b>. That is the only gate: it fixes the team, the limits and what may go outside (deploy, publish, spend).</li>
<li><b>pm</b> plans the tasks (up to 20 active at a time; finished ones do not count) and the agents run them, a few at a time. You are not asked about tasks.</li>
<li>A <b>watchdog</b> pauses a project that goes over its tasks, time or budget. Anything outward waits in the outbox for your release.</li>
<li>Open <b>Tasks &amp; history</b> only when you want to see how it ran. This page shows how many tasks ran without you.</li></ol></details>`;

async function loadProjects(g) {
  try { const rr = await fetch('/api/repos'); if (rr.ok) state.repos = await rr.json(); } catch { /* repos are optional */ }
  state.projectsError = '';
  try {
    const res = await fetch('/api/projects');
    if (res.ok) state.projects = await res.json();
    else state.projectsError = res.status === 404 ? 'This Cockpit is an older version: restart it (npm run cockpit) to get Projects.' : 'Could not load projects (HTTP ' + res.status + ').';
  } catch (e) { state.projectsError = 'Could not load projects: ' + e.message; }
  refillProjects();
  if (state.r) renderSide(state.r);
}
/* ---------- family portfolio panel: read-only, from the tracker's snapshot (GET /api/portfolio) ---------- */
function portfolioPanel() { return `<section class="panel" id="portfolio"><h2>Family portfolio<span class="right muted">AUD · read-only</span></h2><div class="muted">Loading…</div></section>`; }
const aud = (n) => 'A$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (x) => (x * 100).toFixed(1) + '%';
function portfolioHtml(p) {
  if (p.state === 'unavailable') return `<div class="err">Portfolio unavailable: ${esc(p.message || 'no data')}</div>`;
  const warn = p.state === 'stale' ? `<div class="err" style="margin-bottom:8px">Stale data — do not treat as current.${p.warnings.length ? ' ' + p.warnings.map(esc).join(' · ') : ''}</div>` : '';
  return `${warn}<div style="font-size:26px;font-weight:600;font-variant-numeric:tabular-nums">${aud(p.totalAud)}</div><div class="muted">Total · as of ${esc(fmtAt(p.asOf))}</div>
    <h3 class="muted" style="margin:14px 0 4px">By market</h3>
    ${p.byMarket.map((m) => `<div style="display:flex;justify-content:space-between"><span>${esc(m.market)}</span><span class="num">${aud(m.valueAud)} · ${pct(m.share)}</span></div><div class="bar"><i style="width:${(m.share * 100).toFixed(1)}%"></i></div>`).join('')}
    <h3 class="muted" style="margin:14px 0 4px">Top positions</h3>
    <table><thead><tr><th>Symbol</th><th>Name</th><th>Market</th><th class="num">Value (AUD)</th><th class="num">Share</th></tr></thead><tbody>${p.topPositions.map((x) => `<tr><td>${esc(x.symbol)}</td><td>${esc(x.name)}</td><td>${esc(x.market)}</td><td class="num">${aud(x.valueAud)}</td><td class="num">${pct(x.share)}</td></tr>`).join('')}</tbody></table>`;
}
async function fillPortfolio() {
  const el = $('portfolio'); if (!el) return;
  let body;
  try { const res = await fetch('/api/portfolio'); body = res.ok ? portfolioHtml(await res.json()) : `<div class="err">${res.status === 403 ? 'Not available for you.' : 'Could not load the portfolio (HTTP ' + res.status + ').'}</div>`; }
  catch (e) { body = `<div class="err">Could not load the portfolio: ${esc(e.message)}</div>`; }
  const cur = $('portfolio'); if (cur) cur.innerHTML = `<h2>Family portfolio<span class="right muted">AUD · read-only</span></h2>${body}`;
}
function refillProjects() {
  if (route() === 'g/family') void fillPortfolio();
  const rt = route();
  if (rt.startsWith('g/')) fillProjects(rt.slice(2)); else if (rt.startsWith('project/')) { const pid = rt.slice(8).split('/')[0]; fillProjectRail(pid); fillProjectDetail(pid); }
}
function fillProjects(g) {
  const el = $('projects'); if (!el || el.dataset.g !== g) return;
  const mine = (state.projects ?? []).filter((p) => p.portfolio === g);
  let body;
  if (state.projectsError && !state.projects) body = `<div class="err">${esc(state.projectsError)}</div>`;
  else if (!state.projects) body = '<div class="muted">Loading…</div>';
  else {
    const SLOTS = 6; // three rows of two; the rest wait in the backlog list, lowest priority last
    const top = mine.slice(0, SLOTS), backlog = mine.slice(SLOTS);
    const back = backlog.length ? `<h3 style="margin:14px 0 6px;font-size:13px" class="muted">Backlog · ${backlog.length} more (raise a project's priority to move it into the top ${SLOTS})</h3><div class="tablewrap"><table><tbody>${backlog.map((p) => `<tr><td><a href="#/project/${esc(p.id)}"><b>${esc(pname(p))}</b></a><div class="muted" style="font-size:12px">${esc(p.outcome)}</div></td><td>${esc(PSTATUS[p.status] ?? p.status)}</td><td>P${p.priority}</td><td>${btnP('edit', p, 'Edit')}</td></tr>`).join('')}</tbody></table></div>` : '';
    body = HELP + `<div class="pgrid">${top.map(projCard).join('')}</div>` + back + reposPanel(g);
    const strip = $('autostrip'); if (strip && strip.dataset.g === g) strip.innerHTML = mine.length ? automationStrip(mine) : '';
  }
  el.innerHTML = `<h2>Projects<span class="right"><button type="button" class="primary" data-act="newproj" data-g="${esc(g)}">＋ New project</button></span></h2>` + body;
}

/* ---- one project: summary, tasks (the plan), log ---- */
function viewProject(r, id) {
  return `<div class="split"><nav class="rail" id="projrail" aria-label="Projects" data-id="${esc(id)}"></nav><div class="splitmain"><p class="muted sub"><a id="backlink" href="#/g/">← Portfolio</a></p><div id="projdetail" data-id="${esc(id)}"><div class="muted">Loading…</div></div></div></div>`;
}
/** Left-hand list on a project's page: all projects grouped by portfolio, so you can switch without going back. */
function fillProjectRail(cur) {
  const el = $('projrail'); if (!el) return;
  const ps = state.projects;
  if (!ps) { el.innerHTML = '<div class="muted" style="padding:6px">Loading…</div>'; return; }
  const closed = (p) => p.status === 'done' || p.status === 'cancelled';
  const curP = ps.find((x) => x.id === cur), order = [...new Set(ps.map((p) => p.portfolio))].sort((a, b) => (a === curP?.portfolio ? -1 : b === curP?.portfolio ? 1 : gName(a).localeCompare(gName(b))));
  el.innerHTML = '<a class="all" href="#/g/' + esc(curP?.portfolio ?? '') + '">All projects</a>' + order.map((g) =>
    `<h4>${esc(gName(g))}</h4>` + ps.filter((p) => p.portfolio === g).sort((a, b) => closed(a) - closed(b)).map((p) =>
      `<a href="#/project/${esc(p.id)}" class="${closed(p) ? 'dim' : ''}" title="${esc(PSTATUS[p.status] ?? p.status)}"${p.id === cur ? ' aria-current="page"' : ''}>${esc(pname(p))}</a>`).join('')).join('');
}
const money0 = (n) => '$' + Number(n || 0).toLocaleString('en-US');
function approvalSheet(p) {
  const c = p.charter, ag = (state.r?.agents ?? []);
  const team = c.team.map((id) => { const a = ag.find((x) => x.id === id || x.profile === id); return `<tr><td>${esc(id)}${a?.state === 'proposed' ? ' <span class="tag">not created yet</span>' : ''}</td><td>${esc(a?.role ?? '')}${a?.model ? ` <span class="muted">· ${esc(a.model)}</span>` : ''}</td></tr>`; }).join('');
  const newA = c.new_agents.length ? `<tr><td>New agents created on approval</td><td>${c.new_agents.map((n) => esc(n.id + ' (' + n.slug + ')')).join(', ')}</td></tr>` : '';
  const o = c.outward;
  const outward = `<tr><td>Deploy</td><td>${o.deploy.allowed ? 'only to ' + esc(o.deploy.targets.join(', ')) + ' · rollback ' + esc(o.deploy.rollback) : 'not allowed'}</td></tr>
    <tr><td>Publish</td><td>${esc({ no: 'not allowed', 'draft-only': 'drafts only: you release each one', auto: 'automatic to ' + o.publish.channels.join(', ') }[o.publish.allowed])}${o.publish.channels.length && o.publish.allowed !== 'auto' ? ' · channels ' + esc(o.publish.channels.join(', ')) : ''}</td></tr>
    <tr><td>Spend</td><td>${o.spend.allowed ? 'up to ' + money0(o.spend.max_usd) + ', each payment waits for your release' : 'not allowed'}</td></tr>`;
  const warns = [...p.findings.errors.map((e) => '✗ ' + e), ...p.findings.warnings.map((w) => '▲ ' + w)];
  return `<section class="panel sheet" id="approval"><h2>Approve this charter</h2>
    <p class="muted" style="margin:0 0 10px">This is the only approval this project needs. After it, pm plans the tasks and agents run them inside these limits; you are asked again only if a limit is hit or something goes outside.</p>
    ${warns.length ? `<div class="warnbox"><b>Check before approving</b><ul class="plain">${warns.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    <div class="tablewrap"><table><tbody>
      <tr><td>Outcome</td><td><b>${esc(c.outcome)}</b></td></tr>
      <tr><td>Done when</td><td><ul class="plain">${c.done_when.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></td></tr>
      <tr><td>Priority</td><td>P${p.priority} (1 = first)</td></tr>
      <tr><td>Repo</td><td>${esc(p.repo_path || 'none linked')}${p.git && !p.git.missing && p.git.branch ? ` · ⎇ ${esc(p.git.branch)}${p.git.dirty ? ` · ${p.git.dirty} uncommitted` : ' · clean'}` : ''}${p.test_cmd ? `<div>Verified with <code>${esc(p.test_cmd)}</code></div>` : '<div class="muted">No test command recorded: agents will say how they verified instead.</div>'}</td></tr>
      <tr><td>Team</td><td><table><tbody>${team}</tbody></table></td></tr>${newA}
      <tr><td>Limits</td><td>up to ${c.max_tasks} active tasks at a time · ${esc(p.timebox)} time box · ${c.budget.lane_minutes} agent-minutes · ${money0(c.budget.usd)} budget. Over any limit the project pauses and you are asked.</td></tr>
      ${outward}
      <tr><td>Never, whatever anyone asks</td><td>${esc(c.never.join(', '))}</td></tr>
      <tr><td>You are asked again when</td><td>${esc(c.escalate_when.join(', '))}</td></tr>
    </tbody></table></div>
    <h3 style="font-size:13px;margin:14px 0 4px" class="muted">What happens next</h3>
    <ol style="margin:0 0 12px 18px;padding:0;font-size:13px"><li>The charter becomes active${c.new_agents.length ? ' and the new agents are created' : ''}.</li><li>pm gets a task to plan up to ${c.max_tasks} tasks (gate → build → verify → write-up) and applies it.</li><li>Agents run tasks, a few at a time. Progress and “ran without you” counts appear on this page.</li></ol>
    <label class="fld"><span>Your comment <small class="muted">(optional) — becomes part of the project's context and is given to the agents</small></span><textarea id="ap-comment" rows="3" maxlength="1000" placeholder="e.g. Keep it to one page. Ask me before touching the database schema."></textarea></label>
    <label class="fld"><span>Who acts on the comment</span><select id="ap-to"><option value="pm">pm — included in its planning task (recommended)</option><option value="atlas">Atlas — also opens a chat with the note, to act on it</option></select></label>
    <div class="acts" style="display:flex;gap:8px;margin-top:8px"><button type="button" class="primary" data-act="approve-go" data-p="${esc(p.id)}">Approve${p.findings.errors.length ? '' : ''}</button><button type="button" data-act="approve-cancel" data-p="${esc(p.id)}">Not yet</button></div></section>`;
}
async function submitApproval(project) {
  const comment = $('ap-comment').value.trim(), to = $('ap-to').value;
  const p = (state.projects ?? []).find((x) => x.id === project);
  const j = await projectAct({ project, action: 'approve', comment }, 'Approving and asking pm to plan…');
  if (!j) return;
  location.hash = '#/project/' + project;
  if (comment && to === 'atlas' && p) askAtlas(`I approved project ${project} (${gName(p.portfolio)}): "${p.outcome}". My note on it: ${comment}\nPlease act on the note and tell me if anything else is needed.`);
}
/** The automation after approval, as a visible chain: who triggers what, and where it is now. */
const fmtAt = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
const agentLabel = (id) => { const a = (state.r?.agents ?? []).find((x) => x.id === id || x.profile === id); return a ? `${a.name || id}${a.model ? ' · ' + a.model : ''}` : id; };
const taskLink = (p, id, text) => id ? `<a href="#" data-task="${esc(p.board || '')}:${esc(id)}" title="Open the task: what it was asked and what it returned">${esc(text ?? id)}</a>` : '';
const fmtDur = (sec) => { sec = Math.round(sec || 0); if (sec < 60) return sec + 's'; const m = Math.round(sec / 60); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
const fmtTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n || 0);
/** The Outcome column: which task it is (opens the viewer), when it started, how long it took, what it consumed. */
function outcomeCell(p, t) {
  if (!t.task) return '<span class="muted">not started</span>';
  const u = t.usage, running = t.status === 'running';
  const short = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
  const dur = u ? fmtDur(running && t.started ? (Date.now() - Date.parse(t.started)) / 1000 : u.seconds) : '';
  const line1 = t.started ? `${short(t.started)} → ${t.completed ? short(t.completed) : running ? 'now' : '…'}${dur ? ' · ' + dur : ''}` : 'waiting';
  const line2 = u ? [u.tokens ? `${fmtTok(u.tokens)} tokens` : '', u.cost ? '$' + u.cost.toFixed(2) : '', u.runs > 1 ? `${u.runs} runs` : ''].filter(Boolean).join(' · ') : '';
  const line3 = u && u.models.length ? u.models.join(', ') : '';
  return `<div>${taskLink(p, t.task, t.task)}</div><div class="muted oc">${esc(line1)}</div>${line2 ? `<div class="muted oc">${esc(line2)}</div>` : ''}${line3 ? `<div class="muted oc">${esc(line3)}</div>` : ''}`;
}
const QUEUED = ['ready', 'todo', 'scheduled', 'triage'];
function tally(p) { const c = { created: 0, finished: 0, running: 0, queued: 0, blocked: 0, review: 0, notCreated: 0 }; for (const t of p.plan) { if (!t.task) { c.notCreated++; continue; } c.created++; if (t.status === 'done') c.finished++; else if (t.status === 'running') c.running++; else if (t.status === 'blocked') c.blocked++; else if (t.status === 'review') c.review++; else if (QUEUED.includes(t.status)) c.queued++; } return c; }
function tallyLine(p) {
  const c = tally(p), subs = p.plan.filter((t) => t.parent), tops = p.plan.length - subs.length;
  const made = (a) => a.filter((t) => t.task).length;
  const shape = subs.length ? ` (${made(p.plan.filter((t) => !t.parent))}/${tops} top-level, ${made(subs)}/${subs.length} subtasks)` : '';
  return [`${c.created} of ${p.plan.length} created${shape}`, `${c.finished} finished`, `${c.running} running`, `${c.queued} queued`, c.blocked ? `${c.blocked} blocked` : '', c.review ? `${c.review} in review` : ''].filter(Boolean).join(' · ');
}
function pipelineSteps(p) {
  const n = p.plan.length, a = p.auto, pl = p.planning, created = p.plan.filter((t) => t.task).length;
  const approved = !['proposed', 'cancelled'].includes(p.status) && !!p.approved;
  const adv = p.advance?.do === 'stalled' ? p.advance.why : '';
  const step = (label, state, detail, who, at, html) => ({ label, state, detail, who, at, html });
  const times = p.plan.map((t) => t.created).filter(Boolean).sort();
  const last = (k) => p.plan.map((t) => t[k]).filter(Boolean).sort().at(-1);
  const out = [];
  out.push(step('Charter approved', approved ? 'done' : 'now', approved ? '' : 'waiting for you', 'You', approved ? p.approved : ''));
  const planningState = !approved ? 'wait' : n > 0 ? 'done' : pl ? (pl.status === 'done' ? 'done' : ['blocked', 'crashed', 'failed', 'timed_out'].includes(pl.status) ? 'stuck' : 'now') : 'now';
  const pmNote = p.pm && (!p.pm.profile || !p.pm.skill) ? ` ▲ ${!p.pm.profile ? 'pm has no Hermes profile' : 'pm lacks the project-planning skill (run hermes/install.sh --apply)'}` : '';
  out.push(step('pm is asked to plan', planningState, (pl ? `${pl.status}${pl.tries > 1 ? ` · attempt ${pl.tries}` : ''}` : approved ? 'created within a minute of approval' : 'created when you approve') + pmNote, pl ? agentLabel(pl.assignee || 'pm') : 'Cockpit → pm', pl ? fmtAt(pl.started || pl.created) : '', pl ? taskLink(p, pl.id, 'planning task ' + pl.id) : ''));
  out.push(step('Plan written', !approved ? 'wait' : n > 0 ? 'done' : planningState === 'stuck' ? 'stuck' : 'wait', n > 0 ? `${p.plan.filter((t) => !t.parent).length} top-level task${p.plan.filter((t) => !t.parent).length === 1 ? '' : 's'}${p.plan.some((t) => t.parent) ? `, ${p.plan.filter((t) => t.parent).length} subtasks` : ''}${p.plan_errors?.length ? ' ▲ ' + p.plan_errors[0] : ''}` : adv || 'pm writes up to ' + p.max_tasks + ' tasks', 'pm', pl && pl.completed && n > 0 ? fmtAt(pl.completed) : ''));
  out.push(step('Tasks created in Hermes', n === 0 ? 'wait' : created === n ? 'done' : 'now', n ? tallyLine(p) : '', 'Cockpit automation', times.length ? fmtAt(times[0]) : ''));
  const finished = n > 0 && a.done === n;
  const hasSubs = p.plan.some((t) => t.parent), H = hasSubs ? hier(p) : null;
  const detail = !created ? '' : H ? `${H.groupsDone}/${H.tops.length} top-level tasks done · ${H.subsDone}/${H.subs.length} subtasks done · ${H.running} running${H.waiting ? ` · ▲ ${H.waiting} waiting on you` : ''}` : `${a.done} done · ${a.running} running${a.waiting_on_you ? ` · ▲ ${a.waiting_on_you} waiting on you` : ''}`;
  const groupsHtml = H && created ? `<ul class="gmini">${H.tops.map((t) => { const st = groupState(p, t), kids = kidsOf(p, t.key); return `<li><span class="gi ${st}">${PIPE_ICON[st]}</span>${esc(t.title)}<span class="muted"> ${kids.length ? kids.filter((x) => x.status === 'done').length + '/' + kids.length : ''}</span></li>`; }).join('')}</ul>` : '';
  out.push(step('Agents working', finished ? 'done' : a.running ? 'now' : created > 0 ? 'now' : 'wait', detail, 'Hermes → agents, 2 at a time', last('completed') ? 'latest ' + fmtAt(last('completed')) : last('started') ? 'started ' + fmtAt(last('started')) : '', groupsHtml));
  out.push(step('Ready for your review', ['review', 'done'].includes(p.status) ? 'done' : 'wait', p.status === 'review' ? 'every task is done' : '', 'Cockpit automation', p.status === 'review' ? fmtAt(last('completed')) : ''));
  out.push(step('Done', p.status === 'done' ? 'done' : 'wait', '', 'You', ''));
  // the first unfinished step is the current one; a stalled automation marks it stuck
  const cur = out.findIndex((x) => x.state !== 'done');
  out.forEach((x, i) => { if (i > cur && x.state === 'now') x.state = 'wait'; if (i === cur && adv && x.state !== 'stuck' && p.status === 'active') x.state = 'stuck'; });
  return out;
}
const PIPE_ICON = { done: '✓', now: '●', wait: '○', stuck: '▲' };
function pipelinePanel(p) {
  const tab = p.status === 'cancelled' ? 'decisions' : (state.pTab ?? 'pipeline');
  const tabs = `<div class="tabs ptabs" role="group" aria-label="Automation area">${p.status === 'cancelled' ? '' : `<button type="button" data-ptab="pipeline" aria-pressed="${tab === 'pipeline'}">Pipeline</button>`}<button type="button" data-ptab="decisions" aria-pressed="${tab === 'decisions'}">Decisions</button></div>`;
  if (tab === 'decisions') return `<aside class="panel hist" data-p="${esc(p.id)}"><h2>Automation</h2>${tabs}<div id="projdec" data-p="${esc(p.id)}"><div class="decmore"><a href="#/decisions" data-dec-open="${esc(p.id)}">All decisions →</a></div><div class="muted">Loading…</div></div></aside>`;
  const rows = pipelineSteps(p).map((x) => `<li class="pstep ${x.state}"><span class="ico">${PIPE_ICON[x.state]}</span><div><b>${esc(x.label)}</b>${x.at ? `<span class="at">${esc(x.at.includes('T') ? fmtAt(x.at) : x.at)}</span>` : ''}${x.detail ? `<div class="muted">${esc(x.detail)}</div>` : ''}${x.html ? `<div class="muted">${x.html}</div>` : ''}<div class="who">${esc(x.who)}</div></div></li>`).join('');
  return `<aside class="panel hist" data-p="${esc(p.id)}"><h2>Automation</h2>${tabs}<ol class="pipe">${rows}</ol></aside>`;
}
function fillProjectDetail(id) {
  const el = $('projdetail'); if (!el || el.dataset.id !== id) return;
  if (route().endsWith('/approve') && $('approval')) return; // never wipe a comment being typed when the page refreshes
  const p = (state.projects ?? []).find((x) => x.id === id);
  if (!p) { el.innerHTML = state.projects ? '<div class="empty">No such project.</div>' : (state.projectsError ? `<div class="err">${esc(state.projectsError)}</div>` : '<div class="muted">Loading…</div>'); return; }
  $('backlink').href = '#/g/' + p.portfolio; $('backlink').textContent = '← ' + gName(p.portfolio);
  const n = p.plan.length, ns = nextStep(p);
  const primary = ns.act === 'ask' ? `<button type="button" class="primary" data-act="ask" data-p="${esc(p.id)}">${ns.label}</button>` : ns.act === 'step-done' ? `<button type="button" class="primary" data-act="step-done" data-p="${esc(p.id)}" data-k="${esc(ns.key)}">${ns.label}</button>` : ns.act && ns.act !== 'open' ? btnP(ns.act, p, ns.label, 'class="primary"') : '';
  // Two levels, rendered as a collapsible tree: only top-level tasks show; open one to see its subtasks. A top-level task that has
  // subtasks wraps them up, so it runs last. Open/closed state is kept across refreshes.
  const subsOf = (k) => p.plan.filter((x) => x.parent === k);
  const openSet = (state.openGroups ??= new Set());
  let topNo = 0, subNo = 0;
  const numOf = new Map(p.plan.map((x) => { if (!x.parent) { topNo++; subNo = 0; return [x.key, String(topNo)]; } subNo++; return [x.key, topNo + '.' + subNo]; }));
  const cells = (t, i, summary) => {
    const kids = subsOf(t.key), isSub = !!t.parent;
    const done = t.status === 'done', running = t.status === 'running', open = !!t.task && !done;
    const status = t.human && t.task && !done ? `<button type="button" class="primary" data-act="step-done" data-p="${esc(p.id)}" data-k="${esc(t.key)}">I did this</button>` : `<span class="spill st-${stKind(t)}">${esc(t.human && t.status === 'blocked' ? 'your step' : TSTATUS[t.status] ?? t.status)}</span>${done ? (t.touched ? ' <span class="tag" title="Someone had to step in">needed you</span>' : ' <span class="tag" title="No one stepped in">automatic</span>') : ''}`;
    let roll = '';
    if (kids.length) {
      const kd = kids.filter((x) => x.status === 'done').length, kr = kids.filter((x) => x.status === 'running').length;
      const mine = kids.filter((x) => x.human && x.task && x.status !== 'done').length, kb = kids.filter((x) => x.status === 'blocked' && !x.human).length;
      roll = `<div class="roll"><span class="pbar" title="${kd} of ${kids.length} subtasks done"><i style="width:${Math.round(100 * kd / kids.length)}%"></i></span><span>${kd}/${kids.length} subtasks</span>${kr ? `<span class="tag">${kr} running</span>` : ''}${mine ? `<span class="tag sev-warn">${mine} for you</span>` : ''}${kb ? `<span class="tag sev-warn">${kb} blocked</span>` : ''}</div>`;
    }
    // a finished task is history: no moving, no removing, just its outcome. A running one can be stopped. Only work not yet started can be reordered or removed.
    const grouped = isSub || kids.length;
    const retry = t.status === 'blocked' && t.task && !t.human ? `<button type="button" class="primary" data-act="retry-task" data-p="${esc(p.id)}" data-k="${esc(t.key)}" data-v="${esc(t.title)}" title="Add a note and unblock this task so the agent runs it again">↻ Retry</button>` : '';
    const acts = done ? ''
      : running ? `<button type="button" data-act="stop-task" data-p="${esc(p.id)}" data-k="${esc(t.key)}" title="Stop this run and block the task">■ Stop</button>`
      : `${retry}${i > 0 && !grouped ? `<button type="button" data-act="up" data-p="${esc(p.id)}" data-k="${esc(t.key)}" data-i="${i}" aria-label="Move up">↑</button>` : ''}${i < n - 1 && !grouped ? `<button type="button" data-act="down" data-p="${esc(p.id)}" data-k="${esc(t.key)}" data-i="${i + 2}" aria-label="Move down">↓</button>` : ''}${kids.length ? '' : `<button type="button" data-act="remove" data-p="${esc(p.id)}" data-k="${esc(t.key)}" aria-label="Remove">✕</button>`}${open && !t.human && t.status !== 'blocked' ? ` <button type="button" data-act="stop-task" data-p="${esc(p.id)}" data-k="${esc(t.key)}" title="Hold this task so it does not start">■</button>` : ''}`;
    const title = `<b ${done || summary ? '' : `data-act="rename" data-p="${esc(p.id)}" data-k="${esc(t.key)}" data-v="${esc(t.title)}" style="cursor:pointer" title="Click to rename"`}>${esc(t.title)}</b>`;
    return `<span class="tnum">${numOf.get(t.key)}</span><div class="ttitle">${title}<div class="muted clamp3" title="${esc(t.accept)}">${esc(t.accept)}</div>${roll}</div><div class="town">${t.human ? '<span class="tag">you</span>' : esc(t.owner)}${t.lane ? ` <span class="tag">${esc(t.lane)}</span>` : ''}${t.outward ? ` <span class="tag">${esc(t.outward)}</span>` : ''}</div><div class="tstat">${status}</div><div class="tout">${outcomeCell(p, t)}</div><div class="tact">${acts}</div>`;
  };
  /** What Hermes did inside a plan task: the steps its auto-decomposer split it into (the task waits for all of them). */
  const autoBlock = (t) => {
    const a = t.auto ?? []; if (!a.length) return '';
    const dn = a.filter((x) => x.status === 'done').length, word = { done: '✓ done', running: '● running', ready: 'ready', todo: 'waiting', blocked: '▲ blocked', review: 'in review', triage: 'new' };
    return `<div class="autosub"><div class="h">Hermes split this task into ${a.length} step${a.length === 1 ? '' : 's'} (${dn} done). It finishes when all of them are done, and tasks after it wait for that.</div>${a.map((x, i) => `<div class="r"><span class="st ${esc(x.status)}">${esc(word[x.status] ?? x.status)}</span><span>${i + 1}. ${esc(x.title)} <span class="muted">· ${esc(x.assignee ?? 'no owner')}</span></span><span class="autoact">${x.status === 'blocked' ? `<button type="button" class="primary" data-act="retry-task" data-p="${esc(p.id)}" data-t="${esc(x.id)}" data-v="${esc(x.title)}" title="Add a note and unblock this step so the agent runs it again">↻ Retry</button> ` : ''}<code>${esc(x.id)}</code></span>${x.why ? `<div class="why"><b>Why:</b> ${esc(x.why)}</div>` : ''}</div>`).join('')}</div>`;
  };
  /** Why a task is stuck, from what its last run said (or that its worker keeps crashing). */
  const whyBlock = (t) => t.why ? `<div class="whybox"><b>Why it is stuck:</b> ${esc(t.why)}${t.status === 'blocked' && t.task ? ' <span class="muted">Fix the cause, then press ↻ Retry.</span>' : ''}</div>` : '';
  const rows = p.plan.map((t, i) => {
    if (t.parent) return '';
    const kids = subsOf(t.key);
    if (!kids.length) return `<div class="trow k-${stKind(t)}"><span class="chev"></span>${cells(t, i, false)}</div>${whyBlock(t)}${autoBlock(t)}`;
    return `<details class="tgroup" data-k="${esc(t.key)}" ${openSet.has(t.key) ? 'open' : ''}><summary class="trow k-${groupKind(p, t)}"><span class="chev" aria-hidden="true">▸</span>${cells(t, i, true)}</summary><div class="tkids">${whyBlock(t)}${autoBlock(t)}${kids.map((k) => `<div class="trow tsub k-${stKind(k)}"><span class="chev"></span>${cells(k, p.plan.indexOf(k), false)}</div>${whyBlock(k)}${autoBlock(k)}`).join('')}</div></details>`;
  }).join('');
  const editable = !['done', 'cancelled'].includes(p.status);
  const hasGroups = p.plan.some((x) => x.parent);
  const tasks = n ? `<div class="ttree"><div class="trow thead"><span class="chev"></span><span class="tnum">#</span><div>Task</div><div>Owner</div><div>Status</div><div>Outcome</div><div></div></div>${rows}</div>` : '<div class="muted">No tasks yet: pm creates them after the charter is approved.</div>';
  const acts = [p.status === 'active' && btnP('pause', p, 'Pause'), p.status === 'paused' && btnP('resume', p, 'Resume'), p.status === 'active' && btnP('nudge', p, 'Nudge now'), p.status === 'active' && capLeft(p) <= 3 && btnP('regroup', p, `Group tasks (${activeTop(p)}/${p.max_tasks} active)`, `title="Over or close to the limit of active tasks: tasks that only one other task needs become its subtasks, and only the parent counts"`), p.status === 'active' && n > 0 && btnP('apply-plan', p, p.applied ? 'Sync plan to Hermes' : 'Start: create tasks'), editable && btnP('add', p, '＋ Add task'), hasGroups && `<button type="button" data-act="expand-all">Expand all</button><button type="button" data-act="collapse-all">Collapse all</button>`, btnP('edit', p, 'Edit project')].filter(Boolean).join('');
  const sheet = route().endsWith('/approve') && p.status === 'proposed' ? approvalSheet(p) : '';
  /** Everything stuck in this project in one place: what it is, why, what it holds up, and the retry button. */
  const blockedPanel = (() => {
    const stuck = [];
    for (const t of p.plan) {
      if (t.task && t.status === 'blocked' && !t.human) stuck.push({ id: t.task, title: t.title, owner: t.owner, why: t.why, key: t.key });
      for (const a of t.auto ?? []) if (a.status === 'blocked') stuck.push({ id: a.id, title: a.title, owner: a.assignee ?? 'no owner', why: a.why, key: t.key, step: true });
    }
    if (!stuck.length) return '';
    const after = (key) => { const seen = new Set(), q = [key]; while (q.length) { const k = q.shift(); for (const x of p.plan) if ((x.needs ?? []).includes(k) && !seen.has(x.key)) { seen.add(x.key); q.push(x.key); } } return p.plan.filter((x) => seen.has(x.key) && x.status !== 'done'); };
    return `<section class="panel blockpanel"><h2>What is blocking this project<span class="right muted">${stuck.length} stuck</span></h2><ul>${stuck.map((x) => { const held = after(x.key).filter((y) => y.key !== x.key); return `<li><b>${esc(x.title)}</b> <span class="muted">· ${esc(x.owner)} · <code>${esc(x.id)}</code>${x.step ? ' · a step Hermes split off' : ''}</span>
      <div class="why">${x.why ? esc(x.why) : 'The agent stopped without a written reason. Open the task in the Hermes dashboard for its log.'}</div>
      ${held.length ? `<div class="holds">Holding up: ${held.map((y) => esc(y.title)).join(' · ')}</div>` : ''}
      <div class="acts"><button type="button" class="primary" data-act="retry-task" data-p="${esc(p.id)}" data-t="${esc(x.id)}" data-v="${esc(x.title)}">↻ Retry with a note</button></div></li>`; }).join('')}</ul></section>`;
  })();
  const top = `<div class="ptop"><h1>${esc(pname(p))} <span class="tag">${esc(PSTATUS[p.status] ?? p.status)}</span> <span class="tag">P${p.priority}</span> ${autoTag(p)} ${btnP('edit', p, 'Edit')}</h1><p class="sub">${esc(p.outcome)}</p></div>`;
  el.innerHTML = `${top}<div class="pdetail"><div class="pmain">
    ${sheet}
    ${blockedPanel}
    ${sheet ? '' : `<div class="next ${ns.tone}"><b>${ns.tone === 'warn' ? 'Needs you' : 'What to do'}</b> ${esc(ns.text)}${primary ? `<div class="acts">${primary}</div>` : ''}</div>`}
    <section class="panel"><h2>Overview</h2>${projectStrip(p)}
      <div class="meta"><span>${gitLine(p)}</span>${p.test_cmd ? `<span>test: <code>${esc(p.test_cmd)}</code></span>` : ''}<span title="Top-level tasks that are not finished; subtasks and finished tasks do not count">${activeTop(p)}/${p.max_tasks} active tasks</span><span>team ${esc(p.team.join(', '))}</span>${p.hours_left !== null ? `<span>${p.hours_left >= 0 ? p.hours_left + ' h left of ' + esc(p.timebox) : 'over the ' + esc(p.timebox) + ' time box'}</span>` : ''}${p.stray ? `<span>▲ ${p.stray} task(s) not from the plan</span>` : ''}</div>${foldersLine(p)}
      <h3 style="font-size:13px;margin:10px 0 4px" class="muted">Done when</h3><ul class="plain">${p.done_when.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></section>
    <section class="panel"><h2>Tasks<span class="right muted">pm manages these; edit only if you need to</span></h2><div class="acts" style="margin-bottom:8px">${acts}</div>${tasks}</section>
    <details class="panel histd" id="histd" data-p="${esc(p.id)}"><summary>History (${p.log.length})</summary><div id="histbody"></div></details>
    </div>${sheet ? '' : pipelinePanel(p)}</div>`;
  refillDecisionPanels();
}

// Open/closed state of task groups survives the page's periodic re-render; buttons inside a group header must not toggle it.
document.addEventListener('toggle', (e) => { const d = e.target; if (d?.classList?.contains('tgroup')) { const set = (state.openGroups ??= new Set()); d.open ? set.add(d.dataset.k) : set.delete(d.dataset.k); } }, true);
document.addEventListener('click', (e) => { if (e.target.closest?.('summary.trow [data-act], summary.trow a')) e.preventDefault(); }, true);

let flashTimer;
function flash(msg, kind = '', spin = false, ms = 0) {
  const el = $('flash'); clearTimeout(flashTimer);
  el.className = kind; el.innerHTML = (spin ? '<span class="spin"></span>' : '') + esc(msg); el.hidden = false;
  if (ms) flashTimer = setTimeout(() => { el.hidden = true; }, ms);
}
function mergeProject(p) {
  if (!p) return;
  state.projects = state.projects ?? [];
  const i = state.projects.findIndex((x) => x.id === p.id);
  if (i >= 0) state.projects[i] = p; else state.projects.push(p);
  state.projects.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}
/** One place for every write: shows progress, blocks double clicks, merges the one changed project, reports the outcome. */
async function openFolder(project, folder) {
  try {
    const res = await postJson('/api/projects/open', { project, folder });
    const j = await res.json().catch(() => ({}));
    flash(res.ok ? 'Opened ' + j.opened + ' in Finder on the Mac running Cockpit' : (j.error || 'Could not open (HTTP ' + res.status + ')'), res.ok ? '' : 'err', false, res.ok ? 3500 : 7000);
  } catch (e) { flash('Could not reach Cockpit: ' + e.message, 'err', false, 7000); }
}
// Which Cockpit this is: prod is a quiet label; dev and demo are loud, so a change is never tested on the wrong endpoint by mistake.
async function showVersion() {
  try {
    const r = await fetch('/api/version'); if (!r.ok) return; const v = await r.json(); const el = $('envbadge'); if (!el) return;
    const sha = v.headSha || v.loadedSha || '';
    const parts = [v.env === 'prod' ? 'prod' : v.env.toUpperCase(), v.env === 'demo' ? '' : (v.branch || 'detached'), sha, v.dirty ? 'edited' : '', v.restartPending ? 'restart pending' : ''].filter(Boolean);
    el.textContent = parts.join(' · '); el.className = `envbadge ${v.env}${v.restartPending ? ' stale' : ''}`; el.hidden = false;
    el.title = `${v.env}: ${v.branch || 'no branch'} @ ${sha}${v.restartPending ? `; running ${v.loadedSha}, files are at ${v.headSha}` : ''}`;
    if (v.env !== 'prod') document.title = `[${v.env.toUpperCase()}] ${document.title.replace(/^\[[A-Z]+\] /, '')}`;
  } catch { /* the page works without it */ }
}
// Who is signed in: the server works it out from the device (HP X360 = Diane, everything else = Frank) and shows only what that person may see.
async function showWho() {
  try {
    const r = await fetch('/api/me'); if (!r.ok) return; const me = await r.json(); state.me = me;
    const el = $('who'); if (!el) return;
    el.hidden = false;
    if ($('dash')) $('dash').hidden = !!me.restricted;
    el.title = me.admin ? 'Admin view: you can see everything' : (me.device ? `Signed in from ${me.device}` : 'Signed in');
    el.innerHTML = `<i aria-hidden="true">${esc(me.name.slice(0, 1).toUpperCase())}</i>${esc(me.name)}${me.admin ? ' <a href="/?admin=off" class="muted" title="Leave the Admin view">exit</a>' : ''}`;
  } catch { /* the page works without it */ }
}
void showWho();
void showVersion();
let retryCtx = null;
function openRetry(project, key, title, task) {
  retryCtx = { project, key, task };
  $('retry-what').textContent = `${title} · ${project}`;
  $('retry-note').value = ''; $('retry-warn').textContent = '';
  $('retrydlg').showModal(); $('retry-note').focus();
}
$('retry-cancel').onclick = () => $('retrydlg').close();
$('retryform').onsubmit = (e) => {
  e.preventDefault();
  const note = $('retry-note').value.trim();
  if (!note && !$('retry-warn').dataset.ok) { $('retry-warn').innerHTML = '<span class="err">No note: the agent will hit the same block again unless something changed. Press the button again to retry anyway.</span>'; $('retry-warn').dataset.ok = '1'; return; }
  $('retry-warn').dataset.ok = '';
  $('retrydlg').close();
  void projectAct({ project: retryCtx.project, action: 'retry-task', key: retryCtx.key, task: retryCtx.task, note }, 'Retrying…');
};
async function projectAct(body, label = 'Saving…') {
  document.body.classList.add('working'); flash(label, '', true);
  try {
    const res = await postJson('/api/projects/act', body);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { flash(j.error || 'Refused (HTTP ' + res.status + ')', 'err', false, 9000); return null; }
    mergeProject(j.project); refillProjects();
    if (body.action === 'regroup') { const L = (j.output || '').split('\n').map((l) => l.trim()).filter((l) => /^(\d+ active|[^ ]+ +←|→|✓|▲|nothing|no safe)/i.test(l) || l.includes('←')); flash(L.length ? L.slice(0, 5).join(' · ') : 'Nothing to group.', L.some((l) => l.startsWith('▲') || /^no safe/i.test(l)) ? 'err' : 'ok', false, 12000); return j; }
    if (body.action === 'nudge') { const L = (j.output || '').split('\n').map((l) => l.trim()).filter((l) => /^[→▲]/.test(l)); flash(L.length ? L.slice(0, 4).join(' · ') : 'Nothing is stuck.', L.some((l) => l.startsWith('▲')) ? 'err' : 'ok', false, 9000); return j; }
    flash(body.action === 'approve' ? (j.planning?.id ? `Approved. pm was asked to plan it (task ${j.planning.id}); tasks appear within a few minutes.` : j.project?.plan?.length ? `Approved. The plan already has ${j.project.plan.filter((t) => !t.parent).length} top-level tasks and ${j.project.plan.filter((t) => t.parent).length} subtasks; they are created in Hermes automatically within a minute.` : `Approved, but pm was not asked to plan: ${j.planning?.skipped ?? 'unknown reason'}. Ask Atlas to plan it.`) : 'Saved.', 'ok', false, 6000);
    return j;
  } catch (e) { flash('Could not reach Cockpit: ' + e.message, 'err', false, 9000); return null; }
  finally { document.body.classList.remove('working'); }
}

/* ---- history (lazy) and the task viewer ---- */
document.addEventListener('toggle', (e) => {
  const d = e.target; if (!d || d.id !== 'histd' || !d.open) return;
  const p = (state.projects ?? []).find((x) => x.id === d.dataset.p); if (!p) return;
  $('histbody').innerHTML = p.log.length ? `<ul class="plain">${p.log.slice().reverse().map((l) => { const m = l.match(/^(\d{4}-\d{2}-\d{2}) — (.*)$/); return `<li>${m ? `<span class="muted">${esc(m[1])}</span> ${esc(m[2])}` : esc(l)}</li>`; }).join('')}</ul>` : '<div class="muted">Nothing yet.</div>';
}, true);
const tview = {};
document.addEventListener('click', (e) => { const a = e.target.closest?.('[data-task]'); if (!a) return; e.preventDefault(); const [board, id] = a.dataset.task.split(':'); void openTask(board, id); });
async function openTask(board, id) {
  const dlg = $('taskview'), body = $('tv-body'); $('tv-title').textContent = id; body.innerHTML = '<div class="muted">Loading…</div>'; if (!dlg.open) dlg.showModal();
  try {
    const res = await fetch(`/api/task?board=${encodeURIComponent(board)}&id=${encodeURIComponent(id)}`); const t = await res.json();
    if (!res.ok) { body.innerHTML = `<div class="err">${esc(t.error || 'HTTP ' + res.status)}</div>`; return; }
    let n = 0; const pre = (x) => x ? docBody('task', `task:${id}:${n++}`, x) : '<div class="muted">nothing recorded</div>';
    docMode.task ??= 'rendered';
    const runs = (t.runs || []).map((r) => `<tr><td>${esc(r.outcome || '')}</td><td>${esc(r.profile || '')}</td><td>${esc(fmtAt(r.started))} → ${esc(fmtAt(r.ended))}</td><td>${esc(r.error || '')}</td></tr>`).join('');
    body.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:start;gap:10px"><h3 style="margin:0 0 4px">${esc(t.title)}</h3>${docTools('task')}</div>
      <div class="muted" style="margin-bottom:10px">${esc(t.status)} · ${esc(t.assignee ? agentLabel(t.assignee) : 'nobody assigned')} · created ${esc(fmtAt(t.created))}${t.started ? ' · started ' + esc(fmtAt(t.started)) : ''}${t.completed ? ' · finished ' + esc(fmtAt(t.completed)) : ''}</div>
      ${t.failure ? `<div class="err">${esc(t.failure)}</div>` : ''}
      <h4>What it handed back</h4>${pre(t.summary || t.result)}
      ${runs ? `<h4>Runs</h4><div class="tablewrap"><table><thead><tr><th>Outcome</th><th>Agent</th><th>When</th><th>Error</th></tr></thead><tbody>${runs}</tbody></table></div>` : ''}
      ${(t.comments || []).length ? `<h4>Comments</h4>${t.comments.map((c) => `<div class="muted">${esc(c.by || '')} ${esc(fmtAt(c.at))}</div>${pre(c.text)}`).join('')}` : ''}
      <details><summary class="muted">What it was asked</summary>${pre(t.body)}</details>
      ${t.workspace ? `<div class="muted" style="margin-top:8px">Workspace: <code>${esc(t.workspace)}</code></div>` : ''}
      <div class="muted" style="margin-top:8px">Hermes: <code>hermes kanban --board ${esc(board)} show ${esc(id)}</code></div>`;
    $('tv-title').textContent = id;
  } catch (err) { body.innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* ---- edit dialog ---- */
function openEditProject(id) {
  const p = (state.projects ?? []).find((x) => x.id === id); if (!p) return;
  const mine = (state.repos ?? []).filter((r) => r.portfolio === p.portfolio && r.path);
  const locked = p.status !== 'proposed';
  $('e-id').value = p.id; $('e-title').textContent = 'Edit ' + pname(p); $('e-name').value = p.name || ''; $('e-name').placeholder = humanize(p.id);
  $('e-outcome').value = p.outcome; $('e-done').value = p.done_when.join('\n');
  $('e-outcome').disabled = locked; $('e-done').disabled = locked;
  $('e-lock').hidden = !locked;
  $('e-prio').value = String(p.priority);
  $('e-repo').innerHTML = `<option value="">${p.repo || (p.git && p.git.path) ? 'Keep the current repo (' + esc((p.git && p.git.path) || p.repo) + ')' : 'No repo linked'}</option>` + mine.map((r) => `<option value="${esc(r.id)}">${esc(r.id)} — ${esc(r.path)}</option>`).join('');
  $('e-test').value = p.test_cmd || ''; $('e-result').innerHTML = '';
  $('e-auto').value = p.autonomy || 'semi'; $('e-auto').querySelector('option[value="full"]').disabled = !decOwner() && p.autonomy !== 'full';
  $('e-auto-note').textContent = (p.auto_blockers ?? []).length ? 'This charter ' + p.auto_blockers.join('; ') + ', so it needs you for that even on full.' : '';
  const cand = ((state.r && state.r.agents) || []).filter((a) => a.state !== 'unlisted' && a.id !== 'atlas' && (a.allPortfolios || a.portfolios.includes(p.portfolio)));
  const ids = [...new Set(['pm', ...cand.map((a) => a.id), ...p.team])];
  $('e-team').innerHTML = ids.map((id) => {
    const a = cand.find((x) => x.id === id), on = p.team.includes(id), fixed = id === 'pm' || (locked && !on);
    return `<label class="${fixed && !on ? 'off' : ''}" title="${esc(a ? a.role : '')}"><input type="checkbox" value="${esc(id)}" ${on ? 'checked' : ''} ${fixed ? 'disabled' : ''}>${esc(id)}${a && a.state === 'proposed' ? ' <small class="muted">(not created)</small>' : ''}</label>`;
  }).join('');
  $('projdlg').showModal();
}
async function saveEditProject(e) {
  e.preventDefault();
  const id = $('e-id').value, p = (state.projects ?? []).find((x) => x.id === id); if (!p) return;
  const body = { project: id, action: 'edit', name: $('e-name').value.trim(), priority: Number($('e-prio').value), repo: $('e-repo').value, test_cmd: $('e-test').value.trim() === (p.test_cmd || '') ? '' : $('e-test').value.trim() };
  body.team = [...document.querySelectorAll('#e-team input:checked')].map((x) => x.value);
  if ($('e-auto').value !== (p.autonomy || 'semi')) body.autonomy = $('e-auto').value;
  if (p.status === 'proposed') { body.outcome = $('e-outcome').value.trim(); body.done_when = $('e-done').value.split('\n').map((x) => x.trim()).filter(Boolean); }
  $('e-save').disabled = true; $('e-save').textContent = 'Saving…'; $('e-result').innerHTML = '<div class="muted"><span class="spin" style="display:inline-block;width:12px;height:12px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:sp .8s linear infinite;vertical-align:-2px;margin-right:8px"></span>Saving the change…</div>';
  const ok = await projectAct(body);
  $('e-save').disabled = false; $('e-save').textContent = 'Save';
  if (ok) $('projdlg').close(); else $('e-result').innerHTML = '<div class="err">The change was refused; the reason is shown at the top of the page.</div>';
}

/** "Start a project" on a repo row: the repo is linked automatically and the stored draft is prefilled for editing. */
async function startFromRepo(g, id) {
  const x = (state.repos ?? []).find((r) => r.portfolio === g && r.id === id);
  openTaskDialog({ portfolio: g, lock: true }); setNewMode('project');
  await fillRepos(id);
  const d = x?.draft;
  $('p-outcome').value = d?.outcome ?? ''; $('p-done').value = (d?.done_when ?? []).join('\n'); $('p-test').value = d?.test_cmd ?? '';
  if (d?.priority) $('p-prio').value = String(d.priority);
  $('t-result').innerHTML = d ? `<div class="muted">Prefilled from the repo's README and docs${d.confidence === 'low' ? ' — <b>low confidence, please rewrite</b>' : ''}. Edit anything, then create the charter.</div>` : '';
  $('p-outcome').focus();
}

document.addEventListener('click', (e) => {
  const t = e.target.closest?.('[data-act]'); if (!t || !$('view').contains(t)) return;
  const project = t.dataset.p, key = t.dataset.k, a = t.dataset.act;
  const proj = (state.projects ?? []).find((x) => x.id === project);
  if (a === 'toggle-groups') { state.showGroups = !state.showGroups; fillProjectDetail(route().split('/')[1] ?? project); return; }
  if (a === 'open-folder') { e.preventDefault(); void openFolder(project ?? t.dataset.p, t.dataset.f); return; }
  if (a === 'copy-path') { e.preventDefault(); navigator.clipboard?.writeText(t.dataset.path).then(() => flash('Copied ' + t.dataset.path, '', false, 2500), () => flash(t.dataset.path, '', false, 6000)); return; }
  if (a === 'goto-group') { const set = (state.openGroups ??= new Set()); set.add(t.dataset.k); const d = document.querySelector(`#projdetail details.tgroup[data-k="${CSS.escape(t.dataset.k)}"]`); if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'center' }); } return; }
  if (a === 'expand-all' || a === 'collapse-all') { const open = a === 'expand-all'; const set = (state.openGroups ??= new Set()); document.querySelectorAll('#projdetail details.tgroup').forEach((d) => { d.open = open; open ? set.add(d.dataset.k) : set.delete(d.dataset.k); }); return; }
  if (a === 'newproj') { openTaskDialog({ portfolio: t.dataset.g, lock: true }); setNewMode('project'); }
  else if (a === 'startrepo') void startFromRepo(t.dataset.g, t.dataset.repo);
  else if (a === 'edit') openEditProject(project);
  else if (a === 'ask') { if (proj) askAtlas(askText(proj)); }
  else if (a === 'approve') { location.hash = '#/project/' + project + '/approve'; }
  else if (a === 'approve-go') void submitApproval(project);
  else if (a === 'approve-cancel') { location.hash = '#/project/' + project; }
  else if (a === 'retry-task') { openRetry(project, key, t.dataset.v, t.dataset.t); }
  else if (a === 'stop-task') { if (confirm('Stop this task? A running agent is interrupted and the task is blocked until you unblock it.')) void projectAct({ project, action: 'stop-task', key }, 'Stopping…'); }
  else if (a === 'step-done') { const note = prompt('Done. Anything agents should know? (optional: e.g. the build number, the live URL)', '') ; if (note !== null) void projectAct({ project, action: 'step-done', key, note }); }
  else if (a === 'pause' || a === 'resume' || a === 'apply-plan' || a === 'nudge' || a === 'regroup') void projectAct({ project, action: a });
  else if (a === 'auto-semi') void projectAct({ project, action: 'autonomy', level: 'semi' });
  else if (a === 'close') { if (confirm('Mark this project done? Remember to update the objective key results afterwards.')) void projectAct({ project, action: 'close' }, 'Closing…'); }
  else if (a === 'up' || a === 'down') void projectAct({ project, action: 'plan', op: 'move', key, to: Number(t.dataset.i) });
  else if (a === 'remove') { if (confirm('Remove this task from the plan?')) void projectAct({ project, action: 'plan', op: 'remove', key }); }
  else if (a === 'rename') { const v = prompt('Task title', t.dataset.v); if (v && v !== t.dataset.v) void projectAct({ project, action: 'plan', op: 'set', key, fields: { title: v } }); }
  else if (a === 'add') {
    const title = prompt('New task title'); if (!title) return;
    const owner = prompt('Owner (agent profile, e.g. coding, qa, content)', 'coding'); if (!owner) return;
    const accept = prompt('How will we know it is done? (one verifiable sentence)'); if (!accept) return;
    const k = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, 't-').slice(0, 40) || 'task';
    void projectAct({ project, action: 'plan', op: 'add', key: k, task: { title, owner, accept } });
  }
});
/** Cards below the projects: only what is NOT inside a project (a portfolio with no projects, or board tasks that belong to none). */
function loose(cs, id) {
  const hasProjects = (state.projects ?? []).some((p) => p.portfolio === id);
  if (state.projects === undefined) return '';
  if (!hasProjects) return cs.length ? `<div class="grid">${cs.map(card).join('')}</div>` : `<div class="empty">Nothing here yet. ${esc((GROUPS.find((x) => x.id === id) || {}).hint || '')}</div>`;
  const jobs = cs.filter((c) => c.source !== 'hermes'), strays = cs.flatMap((c) => (c.strayTasks ?? []).map((t) => ({ ...t, board: c.id })));
  const aopts = (t) => agentOptions(state.r, id);
  const strayTbl = strays.length ? `<section class="panel"><h2>Tasks outside any project<span class="right muted">created by hand on the board; give each an owner, or ask Atlas to fold it into a project</span></h2><div class="tablewrap"><table><thead><tr><th>Task</th><th>Status</th><th>Owner</th></tr></thead><tbody>${strays.map((t) => `<tr><td>${esc(t.title)}</td><td>${esc(t.status)}</td><td>${t.assignee ? esc(t.assignee) : `<select data-assign-for="${esc(t.id)}" aria-label="Assign to">${aopts(t)}</select> <button type="button" data-assign="${esc(t.id)}" data-portfolio="${esc(id)}">Assign</button>`}</td></tr>`).join('')}</tbody></table></div></section>` : '';
  const jobsBlock = jobs.length ? `<h3 class="muted" style="font-size:13px;margin:6px 0">Scheduled jobs</h3><div class="grid">${jobs.map(card).join('')}</div>` : '';
  return strayTbl + jobsBlock;
}
function viewGroup(r, id) {
  const g = GROUPS.find((x) => x.id === id), cs = r.portfolios.filter((p) => gOf(p) === id);
  return `<div class="grouphead"><div class="gh-title"><h1 style="margin:0 0 4px"><span class="dot ${cs.length ? worst(cs.map((c) => c.status)) : ''}"></span> ${esc(g.name)}</h1><p class="muted sub" style="margin:0">${esc(g.blurb)}</p><div id="autostrip" data-g="${esc(id)}"></div></div>
    ${teamStrip(r, id)}${autoDefault(id)}</div>
    ${id === 'family' ? portfolioPanel() : ''}
    ${projectsPanel(id)}
    ${loose(cs, id)}`;
}
/** The automation level new projects in this portfolio start with. The owner changes it; others see it. */
function autoDefault(g) {
  if (!state.autoDefaults) { if (!state.autoLoading) { state.autoLoading = true; fetch('/api/automation').then((r) => r.ok ? r.json() : { defaults: {} }).then((j) => { state.autoDefaults = j.defaults ?? {}; }).catch(() => { state.autoDefaults = {}; }).finally(() => { state.autoLoading = false; if (route() === 'g/' + g) renderView(state.r); }); } return ''; }
  const v = state.autoDefaults[g] ?? 'semi';
  const tip = 'Semi: you approve each charter, review the result and confirm agents\' decisions. Full: a charter starts 4 h after it is proposed unless you stop it, closes once QA verified it, and decisions are confirmed the next day. Deploys, publishing, spending and new agents always need you.';
  if (!decOwner()) return `<div class="autodef muted" title="${esc(tip)}">New projects: ${v === 'full' ? 'full automation' : 'semi-automated'}</div>`;
  return `<label class="autodef muted" title="${esc(tip)}">New projects start as <select data-autodef="${esc(g)}"><option value="semi" ${v === 'semi' ? 'selected' : ''}>Semi-automated</option><option value="full" ${v === 'full' ? 'selected' : ''}>Full automation</option></select></label>`;
}
document.addEventListener('change', async (e) => {
  const s = e.target.closest?.('[data-autodef]'); if (!s) return;
  const g = s.dataset.autodef, level = s.value;
  if (level === 'full' && !confirm(`New ${gName(g)} projects will start by themselves 4 hours after they are proposed, close themselves once QA verified them, and confirm agents' decisions the next day. Deploys, publishing, spending and new agents still need you. Continue?`)) { s.value = 'semi'; return; }
  s.disabled = true;
  const res = await postJson('/api/automation/default', { portfolio: g, level }).catch(() => ({ ok: false, status: 0, json: async () => ({}) }));
  const j = await res.json().catch(() => ({}));
  s.disabled = false;
  if (!res.ok) { flash(j.error || 'Not changed (HTTP ' + res.status + ')', 'err', false, 7000); s.value = level === 'full' ? 'semi' : 'full'; return; }
  state.autoDefaults = { ...state.autoDefaults, [g]: level };
  flash(`New ${gName(g)} projects start as ${level === 'full' ? 'full automation' : 'semi-automated'}. Existing projects keep their level.`, 'ok', false, 5000);
});
function viewJobs(r) { return `<h1>Scheduled jobs</h1><p class="muted sub">Everything Hermes runs on a schedule, across all profiles.</p><section class="panel">${jobsTable(r.atlas?.jobs ?? [])}</section>`; }
function viewNeeds(r) { return `<h1>Needs you</h1><p class="muted sub">Approvals, blockers, failed jobs and deadlines, worst first. Click an item to open what resolves it.</p>
  <div class="ovgrid" style="grid-template-columns:minmax(0,1fr) 480px"><div><section class="panel" style="margin-top:0">${needsPanel(r)}</section></div><div>${needsMetrics(r)}</div></div>`; }
/* ---------- Feedback: proposals to approve, defer or reject ---------- */
const FB_STATUS = { pending: 'Pending', approved: 'Approved', converted: 'Converted to tasks', done: 'Done', deferred: 'Deferred', rejected: 'Rejected', superseded: 'Superseded' };
function fbCard(p) {
  const ev = (p.evidence ?? []).map((e) => `<li><q>${esc(e.quote)}</q> <span class="muted">${esc(e.source)} · ${esc(String(e.time).slice(0, 10))}</span></li>`).join('');
  const d = p.decision;
  const decided = d ? `<div class="muted" style="margin-top:8px">${esc(FB_STATUS[p.status] ?? p.status)} by ${esc(d.by)} on ${esc(String(d.time).slice(0, 10))}${d.until ? ` (back on ${esc(d.until)})` : ''}${d.reason ? `: ${esc(d.reason)}` : ''}</div>` : '';
  const acts = p.status === 'pending'
    ? `<div class="nact" style="margin:10px 0 0;flex-wrap:wrap"><input type="text" data-fb-reason="${esc(p.id)}" maxlength="500" placeholder="Reason (needed to defer or reject)" aria-label="Reason" style="flex:1;min-width:200px"><button type="button" data-fb="approve" data-id="${esc(p.id)}">Approve</button><button type="button" data-fb="defer" data-id="${esc(p.id)}">Defer</button><button type="button" data-fb="reject" data-id="${esc(p.id)}">Reject</button></div>` : '';
  return `<section class="panel"><h2>${esc(p.title)} <span class="right">${esc(FB_STATUS[p.status] ?? p.status)}</span></h2>
    <div class="meta"><span>${p.count} ${p.count === 1 ? 'note' : 'notes'} on ${p.days} ${p.days === 1 ? 'day' : 'days'}</span><span>from ${esc((p.sources ?? []).join(', '))}</span><span>score ${Number(p.score).toFixed(1)}</span>${p.pages?.length ? `<span>pages ${esc(p.pages.join(', '))}</span>` : ''}</div>
    <ul class="plain">${ev}</ul>${acts}${decided}</section>`;
}
function fbAddForm() {
  if (!state.fbOpen) return '<div style="margin:0 0 14px"><button type="button" data-fb-open="1">＋ Add feedback</button></div>';
  return `<section class="panel"><h2>Add feedback<span class="right"><button type="button" data-fb-open="0" style="padding:2px 9px;font-size:12px">Close</button></span></h2>
    <p class="muted sub" style="margin-top:0">One thought is enough. Don't include private details.</p>
    <textarea id="fb-new" rows="3" maxlength="2000" style="width:100%" aria-label="New feedback"></textarea>
    <div class="nact" style="margin:10px 0 0;flex-wrap:wrap"><label class="muted" style="flex:1;min-width:200px"><input type="checkbox" id="fb-now" checked> Make it a proposal at the next digest (otherwise it waits for a second note like it, or 7 days)</label><button type="button" id="fb-add">Add</button></div></section>`;
}
/** Counts and decision times for the feedback page: by status, by where it came from, and how long a decision took. */
function fbStats(ps) {
  const by = {}, src = {}; let notes = state.fbNotes?.length ?? 0;
  for (const p of ps) { const k = ['approved', 'converted', 'done'].includes(p.status) ? 'approved' : p.status; by[k] = (by[k] ?? 0) + 1; for (const x of p.sources ?? []) src[x] = (src[x] ?? 0) + 1; }
  const wait = (list) => list.map((p) => (Date.parse(p.decision.time) - Date.parse(p.created)) / 3_600_000).filter((h) => h >= 0).sort((a, b) => a - b);
  const med = (a) => a.length ? a[Math.floor(a.length / 2)] : null;
  const dec = (k) => wait(ps.filter((p) => p.decision && (k === 'approved' ? ['approved', 'converted', 'done'].includes(p.status) : p.status === k)));
  const rows = [['Pending', by.pending ?? 0], ['Approved', by.approved ?? 0], ['Deferred', by.deferred ?? 0], ['Rejected', by.rejected ?? 0]].map(([label, value]) => ({ label, value }));
  const times = ['approved', 'rejected', 'deferred'].map((k) => ({ k, h: dec(k) })).filter((x) => x.h.length).map((x) => ({ label: x.k[0].toUpperCase() + x.k.slice(1), value: med(x.h), text: hrs(med(x.h)) + ' · ' + x.h.length }));
  return `<section class="panel" style="margin-top:0"><h2>Proposals<span class="right muted">${ps.length} · ${notes} notes</span></h2>${hbars(rows)}</section>
    <section class="panel"><h2>Where it came from</h2>${hbars(Object.entries(src).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label: SOURCE_LABEL[label] ?? label, value })))}</section>
    <section class="panel"><h2>Time to decision<span class="right muted">median · proposals</span></h2>${hbars(times)}</section>`;
}
function fbNotes(ns) {
  if (!ns || !ns.length) return '';
  return `<h2 class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:.06em">Notes waiting for a digest</h2><section class="panel"><ul class="plain">${ns.map((n) => `<li><q>${esc(n.text)}</q> <span class="muted">${esc(n.by)} · ${esc(n.source)} · ${esc(String(n.time).slice(0, 10))}${n.repeats ? ` · sent again ${n.repeats}×` : ''}${n.promote || n.repeats ? ' · next digest' : ''}</span></li>`).join('')}</ul></section>`;
}
/* ---------- conversations: a read-only window onto Hermes' history (owner only; the Privacy agent's and Diane's chats are never opened) ---------- */
state.conv = state.conv ?? { q: '', profile: '', source: '', data: null, loading: false };
async function loadConversations() {
  const c = state.conv; c.loading = true;
  try {
    const res = await fetch('/api/sessions?' + new URLSearchParams({ q: c.q, profile: c.profile, source: c.source, limit: 60 }));
    if (!res.ok) throw new Error(res.status === 403 ? 'only the owner can read conversations' : 'HTTP ' + res.status);
    c.data = await res.json();
  } catch (e) { c.data = c.data ?? { sessions: [], total: 0, profiles: [], sources: [] }; flash('Could not load conversations: ' + e.message, 'err', false, 6000); }
  c.loading = false; if (route() === 'conversations' && !state.q) { const keep = $('conv-q')?.value; renderView(state.r); const q = $('conv-q'); if (q && keep !== undefined && document.activeElement !== q) q.value = keep; }
}
const snip = (t) => esc(t).replace(/\[([^\]]+)\]/g, '<mark>$1</mark>');
function viewConversations() {
  const c = state.conv, d = c.data;
  const head = '<h1>Conversations</h1><p class="muted sub">What was said in Hermes sessions: chats with Atlas, agents\' task sessions and scheduled jobs. Read-only; sensitive values are masked and the Privacy agent\'s and Diane\'s conversations are never opened.</p>';
  if (!d) return head + '<div class="empty">Loading…</div>';
  const opts = (list, cur, all) => `<option value="">${all}</option>` + list.map((x) => `<option value="${esc(x)}"${cur === x ? ' selected' : ''}>${esc(x)}</option>`).join('');
  return head + `<div class="dec-bar"><select id="conv-pf" aria-label="Agent">${opts(d.profiles, c.profile, 'All agents')}</select><select id="conv-src" aria-label="Source">${opts(d.sources, c.source, 'All sources')}</select><input id="conv-q" type="search" placeholder="Search what was said" value="${esc(c.q)}"></div>`
    + (d.sessions.length ? d.sessions.map((s) => `<a href="#" class="srow" data-sess="${esc(s.id)}"><div class="dec-h"><b>${esc(s.title || '(untitled conversation)')}</b></div>`
      + `<div class="muted dec-m">${esc((s.startedAt || '').replace('T', ' ').slice(0, 16))} · ${esc(s.profile)} · ${esc(s.source)}${s.model ? ' · ' + esc(s.model) : ''} · ${s.messages} messages · ${compact(s.tokens)} tokens</div>${s.snippet ? `<div class="dec-why">${snip(s.snippet)}</div>` : ''}</a>`).join('')
      : '<div class="empty">No conversations match.</div>')
    + (d.total > d.sessions.length ? `<div class="muted">Showing ${d.sessions.length} of ${d.total}. Narrow it with the filters or search.</div>` : '');
}
function wireConversations() {
  const c = state.conv;
  const pf = $('conv-pf'); if (pf) pf.onchange = () => { c.profile = pf.value; void loadConversations(); };
  const sr = $('conv-src'); if (sr) sr.onchange = () => { c.source = sr.value; void loadConversations(); };
  const q = $('conv-q'); if (q) { let t; q.oninput = () => { clearTimeout(t); t = setTimeout(() => { c.q = q.value.trim(); void loadConversations(); }, 350); }; }
}
function transcriptHtml(m) {
  const who = { user: 'You', assistant: 'Agent', tool: 'Tool', system: 'System' }[m.role] ?? m.role;
  const at = m.at ? m.at.replace('T', ' ').slice(11, 16) : '';
  if (m.role === 'tool') return `<details class="msg r-tool"><summary>${esc(m.tool ? 'tool: ' + m.tool : 'tool result')} <span class="muted">${esc(at)}</span></summary><pre>${esc(m.text)}</pre></details>`;
  return `<div class="msg r-${esc(m.role)}"><div class="msg-h">${esc(who)} <span class="muted">${esc(at)}</span></div><div class="msg-b">${esc(m.text)}</div>${m.calls ? `<div class="muted msg-c">used: ${esc(m.calls.join(', '))}</div>` : ''}</div>`;
}
async function openSession(id, offset = 0) {
  const dlg = $('taskview'), body = $('tv-body');
  if (!offset) { $('tv-title').textContent = 'Conversation'; body.innerHTML = '<div class="muted">Loading…</div>'; if (!dlg.open) dlg.showModal(); }
  try {
    const res = await fetch('/api/session?' + new URLSearchParams({ id, offset, limit: 80 }));
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { body.innerHTML = `<div class="err">${esc(j.error || 'HTTP ' + res.status)}</div>`; return; }
    const s = j.session, more = offset + j.messages.length < j.total;
    if (!offset) { $('tv-title').textContent = s.title || 'Conversation'; body.innerHTML = `<div class="muted dec-m">${esc((s.startedAt || '').replace('T', ' ').slice(0, 16))} · ${esc(s.profile)} · ${esc(s.source)}${s.model ? ' · ' + esc(s.model) : ''} · ${j.total} messages · ${compact(s.tokens)} tokens</div><div id="tv-msgs"></div><div id="tv-more"></div>`; }
    $('tv-msgs').insertAdjacentHTML('beforeend', j.messages.map(transcriptHtml).join(''));
    $('tv-more').innerHTML = more ? `<button type="button" id="tv-more-btn">Show the next ${Math.min(80, j.total - offset - j.messages.length)} messages</button>` : '';
    const mb = $('tv-more-btn'); if (mb) mb.onclick = () => { mb.disabled = true; void openSession(id, offset + j.messages.length); };
  } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
document.addEventListener('click', (e) => { const a = e.target.closest?.('[data-sess]'); if (!a) return; e.preventDefault(); void openSession(a.dataset.sess); });
/* ---------- decisions: what was decided, why and by whom (the ledger in the knowledge base, read through /api/decisions) ---------- */
const DEC_LABEL = { active: 'In force', proposed: 'Proposed', question: 'Open question', superseded: 'Replaced', rejected: 'Rejected', reverted: 'Reverted', all: 'All' };
const decBucket = (d) => (d.kind === 'question' && d.status === 'active' ? 'question' : d.status);
state.dec = state.dec ?? { status: 'active', q: '', portfolio: '', project: '', data: null, byProject: {}, recent: {} };
const decOwner = () => !state.me?.restricted && !state.me?.guest;   // Diane reads decisions; only the owner changes them
/** Where a decision came from, as a link when the owner can open it: a task (its summary and comments) or a conversation. */
function decSource(d) {
  const src = d.source || ''; if (!src || src === 'manual') return '';
  const t = src.match(/^(?:task|harvest) (t_[0-9a-f]{4,16})$/), c = src.match(/^session (\S+)$/);
  if (t && d.board) return ` · from <a href="#" data-task="${esc(d.board)}:${esc(t[1])}">task ${esc(t[1])}</a>`;
  if (c && decOwner()) return ` · from <a href="#" data-sess="${esc(c[1])}">a conversation</a>`;
  return ' · from ' + esc(src);
}
function decisionRow(d, compact) {
  const b = decBucket(d), proj = d.scope === '_portfolio' ? gName(d.portfolio) : d.scope;
  const link = d.scope === '_portfolio' ? `#/g/${esc(d.portfolio)}` : `#/project/${esc(d.scope)}`;
  const acts = !decOwner() || d.legacy ? '' : d.status === 'proposed'
    ? `<button type="button" class="primary" data-dec-act="confirm" data-ref="${esc(d.ref)}">Confirm</button><button type="button" data-dec-act="reject" data-ref="${esc(d.ref)}">Reject</button>`
    : d.status === 'active' ? `<button type="button" data-dec-act="revert" data-ref="${esc(d.ref)}" title="Mark this as no longer in force">Revert</button>` : '';
  return `<div class="dec s-${b}"><div class="dec-h"><span class="dpill s-${b}">${esc(DEC_LABEL[b] ?? b)}</span><b>${esc(d.title)}</b></div>`
    + (d.why ? `<div class="dec-why">${esc(d.why)}</div>` : '')
    + `<div class="muted dec-m">${esc(d.date)}${d.by ? ' · ' + esc(d.by) : ''}${compact ? '' : ` · <a href="${link}">${esc(proj)}</a>`}${decSource(d)}${d.supersedes ? ' · replaces ' + esc(d.supersedes) : ''}${d.legacy ? ' · older note' : ''}</div>`
    + (acts ? `<div class="acts">${acts}</div>` : '') + '</div>';
}
async function fetchDecisions(params) {
  const res = await fetch('/api/decisions?' + new URLSearchParams(params)); if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
async function loadDecisions() {
  const d = state.dec; d.loading = true;
  try { d.data = await fetchDecisions({ status: d.status, q: d.q, portfolio: d.portfolio, project: d.project, limit: 300 }); }
  catch (e) { d.data = d.data ?? { decisions: [], total: 0, counts: {} }; flash('Could not load decisions: ' + e.message, 'err', false, 6000); }
  d.loading = false; if (route() === 'decisions' && !state.q) { const keep = $('dec-q')?.value; renderView(state.r); const q = $('dec-q'); if (q && keep !== undefined && document.activeElement !== q) { q.value = keep; } }
}
function viewDecisions() {
  const d = state.dec, data = d.data;
  const head = '<h1>Decisions</h1><p class="muted sub">What was decided, why, and by whom. Proposed ones are drafts an agent wrote down: they only count once you confirm them. Each project\'s file is in the knowledge base.</p>';
  if (!data) return head + '<div class="empty">Loading…</div>';
  const c = data.counts ?? {};
  const chips = ['active', 'proposed', 'question', 'superseded', 'rejected', 'reverted', 'all'].map((k) => `<button type="button" class="chip${d.status === k ? ' on' : ''}" data-dec-status="${k}">${DEC_LABEL[k]}${k === 'all' ? '' : ` <span class="muted">${c[k] ?? 0}</span>`}</button>`).join('');
  const portfolios = `<select id="dec-pf" aria-label="Portfolio"><option value="">All portfolios</option>${GROUPS.map((g) => `<option value="${esc(g.id)}"${d.portfolio === g.id ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select>`;
  const form = !decOwner() ? '' : `<details class="panel" id="dec-add"><summary>Record a decision</summary><div class="dec-form">
    <select id="dec-proj" aria-label="Project">${(state.projects ?? []).filter((p) => !['cancelled'].includes(p.status)).map((p) => `<option value="${esc(p.id)}">${esc(gName(p.portfolio))} · ${esc(p.name || p.id)}</option>`).join('')}</select>
    <input id="dec-title" type="text" maxlength="200" placeholder="What was decided (a sentence)">
    <input id="dec-why" type="text" maxlength="1000" placeholder="Why (optional)">
    <label class="muted"><input id="dec-q-flag" type="checkbox"> this is an open question, not a decision yet</label>
    <button type="button" class="primary" id="dec-save">Record</button></div></details>`;
  return head + `<div class="dec-bar">${chips}</div><div class="dec-bar">${portfolios}<input id="dec-q" type="search" placeholder="Search decisions" value="${esc(d.q)}">${d.project ? `<button type="button" class="chip on" data-dec-clear="1">project: ${esc(d.project)} ✕</button>` : ''}</div>${form}`
    + (data.decisions.length ? data.decisions.map((x) => decisionRow(x, false)).join('') : '<div class="empty">Nothing here yet. Decisions appear when a charter is approved, settings change, feedback is accepted, or an agent records one.</div>')
    + (data.total > data.decisions.length ? `<div class="muted">Showing ${data.decisions.length} of ${data.total}. Narrow it with the filters.</div>` : '');
}
function wireDecisions() {
  const v = $('view'), d = state.dec;
  v.querySelectorAll('[data-dec-status]').forEach((b) => { b.onclick = () => { d.status = b.dataset.decStatus; void loadDecisions(); }; });
  const pf = $('dec-pf'); if (pf) pf.onchange = () => { d.portfolio = pf.value; void loadDecisions(); };
  const q = $('dec-q'); if (q) { let t; q.oninput = () => { clearTimeout(t); t = setTimeout(() => { d.q = q.value.trim(); void loadDecisions(); }, 300); }; }
  const clr = v.querySelector('[data-dec-clear]'); if (clr) clr.onclick = () => { d.project = ''; void loadDecisions(); };
  const save = $('dec-save'); if (save) save.onclick = async () => {
    const title = $('dec-title').value.trim(); if (title.length < 6) { flash('Say what was decided (a few words).', 'err', false, 4000); $('dec-title').focus(); return; }
    save.disabled = true;
    const res = await postJson('/api/decisions/act', { action: 'add', project: $('dec-proj').value, title, why: $('dec-why').value.trim(), question: $('dec-q-flag').checked }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: e.message }) }));
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { flash(j.error || 'Not saved (HTTP ' + res.status + ')', 'err', false, 9000); save.disabled = false; return; }
    flash('Recorded.', 'ok', false, 3000); void loadDecisions(); void load(true);
  };
}
// Confirm / reject / revert, from the Decisions view and from the project and portfolio panels.
document.addEventListener('click', async (e) => {
  const b = e.target.closest?.('[data-dec-act]'); if (!b) return;
  const action = b.dataset.decAct, ref = b.dataset.ref;
  const reason = action === 'confirm' ? '' : (window.prompt(action === 'reject' ? 'Why reject this? (optional)' : 'Why is this no longer in force? (optional)') ?? null);
  if (reason === null) return;
  b.disabled = true;
  const res = await postJson('/api/decisions/act', { action, ref, reason }).catch((err) => ({ ok: false, status: 0, json: async () => ({ error: err.message }) }));
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { flash(j.error || 'Not changed (HTTP ' + res.status + ')', 'err', false, 9000); b.disabled = false; return; }
  flash(action === 'confirm' ? 'Confirmed: it is now in force.' : action === 'reject' ? 'Rejected.' : 'Marked as no longer in force.', 'ok', false, 4000);
  state.dec.byProject = {}; state.dec.recent = {};
  void loadDecisions(); refillDecisionPanels(); void load(true);
});
async function fillDecisionPanels() {
  const pp = $('projdec');
  if (pp) {
    const id = pp.dataset.p;
    try {
      const hit = state.dec.byProject[id], j = hit && Date.now() - hit.at < 20000 ? hit.j : (state.dec.byProject[id] = { at: Date.now(), j: await fetchDecisions({ project: id, status: 'all', limit: 40 }) }).j;
      if ($('projdec')?.dataset.p !== id) return;
      const inForce = j.decisions.filter((x) => decBucket(x) === 'active'), open = j.decisions.filter((x) => ['proposed', 'question'].includes(decBucket(x)));
      const shown = [...open, ...inForce].slice(0, 8);
      pp.querySelector('div.muted, .empty')?.remove();
      pp.querySelectorAll('.dec,.empty,.muted.more').forEach((n) => n.remove());
      pp.insertAdjacentHTML('beforeend', shown.length ? shown.map((x) => decisionRow(x, true)).join('') + (j.total > shown.length ? `<div class="muted more">${j.total - shown.length} more (replaced, rejected or older). <a href="#/decisions" data-dec-open="${esc(id)}">See all</a></div>` : '') : '<div class="empty">No decisions recorded yet. They appear when the charter is approved, settings change, or an agent records one.</div>');
    } catch (e) { pp.insertAdjacentHTML('beforeend', `<div class="err">Could not load decisions: ${esc(e.message)}</div>`); }
  }
}
function refillDecisionPanels() { if ($('projdec')) void fillDecisionPanels(); }
// Automation area of a project: Pipeline | Decisions
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-ptab]'); if (!b) return;
  const aside = b.closest('aside.hist'), p = (state.projects ?? []).find((x) => x.id === aside?.dataset.p); if (!p) return;
  state.pTab = b.dataset.ptab; aside.outerHTML = pipelinePanel(p); refillDecisionPanels();
});
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('[data-dec-open],[data-dec-open-g]'); if (!a) return;
  const d = state.dec; d.status = 'active'; d.q = ''; d.project = a.dataset.decOpen ?? ''; d.portfolio = a.dataset.decOpenG ?? ''; d.data = null;
});
function viewFeedback() {
  const ps = state.fb;
  const head = '<h1>Feedback</h1><p class="muted sub">Proposals made from the feedback people left. Approve says it belongs in the work; defer or reject needs a reason.</p>';
  if (!ps) return head + fbAddForm() + '<div class="empty">Loading…</div>';
  const pending = ps.filter((p) => p.status === 'pending'), rest = ps.filter((p) => p.status !== 'pending');
  return head + `<div class="ovgrid" style="grid-template-columns:minmax(0,1fr) 480px"><div>${fbAddForm()}`
    + (pending.length ? pending.map(fbCard).join('') : '<div class="empty">No proposals waiting for a decision.</div>') + fbNotes(state.fbNotes)
    + (rest.length ? `<h2 class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:.06em">Decided</h2>${rest.map(fbCard).join('')}` : '') + `</div><div>${fbStats(ps)}</div></div>`;
}
async function loadFeedback() {
  try { const res = await fetch('/api/feedback'); if (!res.ok) throw new Error('HTTP ' + res.status); const j = await res.json(); state.fb = j.proposals; state.fbNotes = j.notes ?? []; }
  catch (e) { state.fb = state.fb ?? []; flash('Could not load feedback: ' + e.message, 'err', false, 6000); }
  if (route() === 'feedback' && !state.q) renderView(state.r);
}
function wireFeedback() {
  $('view').querySelectorAll('[data-fb-open]').forEach((b) => b.onclick = () => { state.fbOpen = b.dataset.fbOpen === '1'; renderView(state.r); if (state.fbOpen) $('fb-new')?.focus(); });
  const add = $('fb-add');
  if (add) add.onclick = async () => {
    const ta = $('fb-new'), text = ta.value.trim();
    if (text.length < 3) { flash('Write a few words first.', 'err', false, 4000); ta.focus(); return; }
    add.disabled = true;
    try {
      const res = await postJson('/api/feedback', { text, page: location.hash || '#/', promote: $('fb-now').checked });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { flash(j.error || 'Not saved (HTTP ' + res.status + ')', 'err', false, 9000); add.disabled = false; return; }
      flash(j.duplicate ? 'Already recorded; counted as a repeat.' : 'Feedback added.', 'ok', false, 4000);
      ta.value = ''; await loadFeedback();
    } catch (err) { flash('Could not reach Cockpit: ' + err.message, 'err', false, 9000); }
    add.disabled = false;
  };
  $('view').querySelectorAll('[data-fb]').forEach((b) => { b.onclick = async () => {
    const id = b.dataset.id, action = b.dataset.fb, inp = $('view').querySelector(`[data-fb-reason="${id}"]`), reason = inp ? inp.value.trim() : '';
    if (action !== 'approve' && !reason) { flash('Write a reason to ' + action + ' this.', 'err', false, 4000); if (inp) inp.focus(); return; }
    b.disabled = true;
    try {
      const res = await postJson('/api/feedback/decide', { id, action, reason });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { flash(j.error || 'Not saved (HTTP ' + res.status + ')', 'err', false, 9000); b.disabled = false; return; }
      flash('Proposal ' + { approve: 'approved', defer: 'deferred', reject: 'rejected' }[action] + '.', 'ok', false, 4000);
      await loadFeedback(); void load(true);
    } catch (err) { flash('Could not reach Cockpit: ' + err.message, 'err', false, 9000); b.disabled = false; }
  }; });
}
function errorsPanel(r) { return r.errors.length ? `<section class="panel" style="border-color:var(--warn)"><h2>Data issues</h2><ul class="plain">${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></section>` : ''; }
function viewSearch(r, q) {
  const t = q.toLowerCase(), has = (...xs) => xs.some((x) => String(x ?? '').toLowerCase().includes(t));
  const cards = r.portfolios.filter((p) => has(p.name, p.headline, p.group, p.id));
  const jobs = (r.atlas?.jobs ?? []).filter((j) => has(j.name, j.profile, j.group));
  const needs = r.needsYou.filter((n) => has(n.title, n.portfolioId));
  const people = r.agents.filter((a) => has(a.name, a.role, a.profile, a.personaSlug, a.portfolios.join(' ')));
  const none = !cards.length && !jobs.length && !needs.length && !people.length;
  return `<h1>Search: “${esc(q)}”</h1><p class="muted sub">${cards.length} cards · ${people.length} agents · ${jobs.length} jobs · ${needs.length} needs-you items</p>
    ${none ? '<div class="empty">No matches.</div>' : ''}
    ${cards.length ? `<div class="group"><h2 class="muted">Cards</h2><div class="grid">${cards.map(card).join('')}</div></div>` : ''}
    ${people.length ? `<div class="group"><h2 class="muted">Agents</h2><div class="grid">${people.map(agentCard).join('')}</div></div>` : ''}
    ${jobs.length ? `<section class="panel"><h2>Scheduled jobs</h2>${jobsTable(jobs)}</section>` : ''}
    ${needs.length ? `<section class="panel"><h2>Needs you</h2>${needsList(r, needs)}</section>` : ''}`;
}

/* ---------- shell: sidebar, header pills, routing ---------- */
function route() { const h = location.hash.replace(/^#\/?/, '') || store.get('start', 'overview'); return h; }
const ICONS = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  atlas: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  agents: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17.5" cy="9" r="2.4"/><path d="M17 14.2c2.4.3 4 2.2 4 4.8"/>',
  usage: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  jobs: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  needs: '<path d="M6 17V11a6 6 0 1 1 12 0v6l1.5 2h-15z"/><path d="M10 21a2 2 0 0 0 4 0"/>',
  feedback: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  decisions: '<path d="M5 4h14v16H5z"/><path d="M8.5 12l2.5 2.5 5-5.5"/>',
  conversations: '<path d="M4 5h12v8H9l-3 3v-3H4z"/><path d="M18 9h2v8h-2v3l-3-3h-5v-2"/>',
  tool: '<path d="M14.5 6.5a4 4 0 0 0-5 5L4 17l3 3 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z"/>',
};
const ico = (name, dot) => `<span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS[name] ?? ICONS.tool}</svg>${dot !== undefined && dot !== '' ? `<span class="dot ${dot}"></span>` : ''}</span>`;
function renderSide(r) {
  const cur = state.q ? '' : route();
  const link = (id, label, n, hot, dot, icon) => `<a href="#/${id}" ${cur === id ? 'aria-current="page"' : ''}>${icon ? ico(icon, dot) : dot !== undefined ? `<span class="dot ${dot}"></span>` : ''}${label}${n !== undefined ? `<span class="n ${hot ? 'hot' : ''}">${n}</span>` : ''}</a>`;
  const failing = (r.atlas?.jobs ?? []).filter((j) => j.enabled && j.lastStatus === 'error').length;
  // Tool links from config/cockpit.json: one group per `group` name, between Portfolios and Operations; each opens in a new tab.
  const byGroup = new Map(); for (const l of r.ui.links ?? []) { const g = l.group || 'Tools'; byGroup.set(g, [...(byGroup.get(g) ?? []), l]); }
  const toolGroups = [...byGroup].map(([g, ls]) => `<h4>${esc(g)}</h4>` + ls.map((l) => `<a href="${esc(l.url.replace('{host}', location.hostname))}" target="_blank" rel="noopener" ${l.note ? `title="${esc(l.note)}"` : ''}>${ico('tool')}<span>${esc(l.name)}${l.note ? `<span class="note">${esc(l.note)}</span>` : ''}</span><span class="n">↗</span></a>`).join('')).join('');
  $('side').innerHTML =
    `<h4>Agent</h4>` + link('overview', 'Overview', undefined, false, undefined, 'overview') + link('agents', 'Agents', r.agents.filter((a) => a.state === 'active').length, false, undefined, 'agents') + link('usage', 'Usage', undefined, false, undefined, 'usage') +
    `<h4>Portfolios</h4>` + GROUPS.map((g) => { const cs = r.portfolios.filter((p) => gOf(p) === g.id), ps = (state.projects ?? []).filter((p) => p.portfolio === g.id && !['done', 'cancelled'].includes(p.status)), run = ps.filter((p) => p.status === 'active').length; return link('g/' + g.id, g.name, state.projects ? (run ? `<span title="running projects" style="color:var(--ok)">▶ ${run}</span> · ` : '') + `<span title="projects">${ps.length}</span>` : '', false, cs.length ? worst(cs.map((c) => c.status)) : ''); }).join('') +
    toolGroups +
    `<h4>Operations</h4>` + link('jobs', 'Scheduled jobs', (r.atlas?.jobs ?? []).filter((j) => j.enabled).length, failing > 0, failing ? 'alert' : (r.atlas?.jobs.length ? 'ok' : ''), 'jobs') +
    link('needs', 'Needs you', r.needsYou.length, r.needsYou.some((n) => n.severity === 'alert'), undefined, 'needs') +
    link('decisions', 'Decisions', r.needsYou.filter((n) => /^Confirm \d+ proposed decision/.test(n.title)).length || undefined, false, undefined, 'decisions') +
    (decOwner() ? link('conversations', 'Conversations', undefined, false, undefined, 'conversations') : '') +
    link('feedback', 'Feedback', state.fb ? state.fb.filter((p) => p.status === 'pending').length : r.needsYou.filter((n) => /^Feedback proposal/.test(n.title)).length, false, undefined, 'feedback')
;
}
function renderPills(r) {
  const a = r.atlas; if (!a) { $('pills').innerHTML = ''; return; }
  $('pills').innerHTML = `<span class="group-label">Lanes</span>${r.lanes.map(laneChip).join('')}<span class="group-label">Channels</span>${a.platforms.map((p) => chanChip(r, p, false)).join('')}`;
}
function renderView(r) {
  const view = $('view'), rt = route();
  if (!state.q && rt === 'feedback' && [...view.querySelectorAll('[data-fb-reason], #fb-new')].some((i) => i.value)) return; // keep a reason being typed
  state.cw = Math.max(300, view.clientWidth - 40 - 34); // chart width = panel inner width, so text stays 11px
  let html;
  if (state.q) html = viewSearch(r, state.q);
  else if (rt === 'atlas') { location.hash = '#/overview'; return; }
  else if (rt === 'agents') html = viewAgents(r);
  else if (rt === 'usage') html = viewUsage(r);
  else if (rt === 'needs') html = viewNeeds(r);
  else if (rt === 'feedback') { html = viewFeedback(); if (!state.fb && !state.fbLoading) { state.fbLoading = true; void loadFeedback().finally(() => { state.fbLoading = false; }); } }
  else if (rt === 'conversations' && decOwner()) { html = viewConversations(); if (!state.conv.data && !state.conv.loading) void loadConversations(); }
  else if (rt === 'decisions') { html = viewDecisions(); if (!state.dec.data && !state.dec.loading) void loadDecisions(); }
  else if (rt === 'jobs') html = viewJobs(r);
  else if (rt.startsWith('agent/')) { const [aid, atab] = rt.slice(6).split('/'); html = viewAgent(r, aid, atab); }
  else if (rt.startsWith('project/')) html = viewProject(r, rt.slice(8).split('/')[0]);
  else if (rt.startsWith('g/') && GROUPS.some((g) => 'g/' + g.id === rt)) html = viewGroup(r, rt.slice(2));
  else html = viewOverview(r);
  view.classList.toggle('wide', !state.q && (rt.startsWith('g/') || rt.startsWith('project/') || rt === 'agents' || rt.startsWith('agent/') || rt === 'usage' || rt === 'overview' || rt === 'needs' || rt === 'feedback' || rt === 'jobs'));
  view.innerHTML = html;
  const tgl = $('tgl'); if (tgl) tgl.onclick = () => { state.table = !state.table; renderView(state.r); };
  if (r.usage && $('cbox')) wireChart(r.usage.days);
  if (!state.q && rt === 'usage' && r.usage) wireSlices();
  if (!state.q && rt === 'feedback') wireFeedback();
  if (!state.q && rt === 'decisions') wireDecisions();
  if (!state.q && rt === 'conversations') wireConversations();
  if (!state.q && rt.startsWith('project/')) refillDecisionPanels();
  if (!state.q && rt.startsWith('agent/')) wireAgent();
  if (!state.q && (rt.startsWith('g/') || rt.startsWith('project/'))) { refillProjects(); void loadProjects(); }
}
function setHeaderHeight() { document.documentElement.style.setProperty('--hh', document.querySelector('header.top').offsetHeight + 'px'); }
function render() {
  const r = state.r; if (!r) return;
  GROUPS = r.ui.groups;
  $('stamp').textContent = 'Updated ' + new Date(r.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('dash').href = dashboardUrl(r); $('dash').hidden = !!state.me?.restricted;   // the Hermes dashboard shows every board: not for a limited view
  if (state.projects === undefined && !state.projectsLoading) { state.projectsLoading = true; void loadProjects().finally(() => { state.projectsLoading = false; }); }
  renderSide(r); renderPills(r); setHeaderHeight(); renderView(r); renderDock(false);
  $('cfg').innerHTML = `Server settings (edit <code>config/cockpit.json</code>): channels <b>${esc(r.ui.channels.join(', ') || 'all')}</b> · lanes <b>${esc(r.ui.lanes.join(', '))}</b> · Hermes dashboard <code>${esc(dashboardUrl(r))}</code>${r.ui.writeToken ? ' · writes need the access token' : ''}`;
}

/* ---------- data, theme, settings ---------- */
let busy = false;
async function load(fresh) {
  if (busy) return; busy = true; $('refresh').disabled = true;
  try {
    const res = await fetch('/api/rollup' + (fresh ? '?fresh=1' : ''));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    state.r = await res.json();
    // The server's copy of this page changed since it was loaded: reload so new buttons and fixes appear (not while a dialog is open or something is being typed).
    if (state.r.uiVersion) {
      if (state.uiVersion && state.r.uiVersion !== state.uiVersion && !document.querySelector('dialog[open]') && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) { location.reload(); return; }
      state.uiVersion ??= state.r.uiVersion;
    }
    render();
  } catch (e) { $('stamp').textContent = 'Failed to load: ' + e.message; }
  finally { busy = false; $('refresh').disabled = false; }
}
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  $('theme').textContent = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' }[t] ?? '◐ Auto';
  $('s-theme').value = t;
}
let timer;
function applyRefresh(sec) {
  clearInterval(timer); $('s-refresh').value = String(sec);
  if (+sec > 0) timer = setInterval(() => load(false), +sec * 1000);
}
$('refresh').onclick = () => load(true);
$('theme').onclick = () => { const next = { auto: 'light', light: 'dark', dark: 'auto' }[store.get('theme', 'auto')] ?? 'auto'; store.set('theme', next); applyTheme(next); };
$('settings').onclick = () => $('dlg').showModal();
$('t-close').onclick = () => $('taskdlg').close();
$('projform').onsubmit = saveEditProject;
$('modelform').onsubmit = saveModel;
$('m-close').onclick = () => $('modeldlg').close();
$('e-close').onclick = () => $('projdlg').close();
$('m-project').onclick = () => setNewMode('project');
$('p-repo').onchange = () => { syncRepoUi(); const x = (state.repos ?? []).find((r) => r.portfolio === $('t-portfolio').value && r.id === $('p-repo').value); if (x?.draft && !$('p-outcome').value.trim()) { $('p-outcome').value = x.draft.outcome; $('p-done').value = x.draft.done_when.join('\n'); $('p-test').value = x.draft.test_cmd || ''; if (x.draft.priority) $('p-prio').value = String(x.draft.priority); } };
$('p-outcome').oninput = () => { if ($('p-repo').value === '__new__' && !$('p-newrepo').dataset.touched) { $('p-newrepo').value = ''; syncRepoUi(); } };
$('p-newrepo').oninput = () => { $('p-newrepo').dataset.touched = '1'; };
$('m-task').onclick = () => setNewMode('task');
$('taskform').onsubmit = submitTask;
$('s-close').onclick = () => $('dlg').close();
$('s-theme').onchange = (e) => { store.set('theme', e.target.value); applyTheme(e.target.value); };
$('s-refresh').onchange = (e) => { store.set('refresh', e.target.value); applyRefresh(e.target.value); };
$('s-start').value = store.get('start', 'overview');
$('s-start').onchange = (e) => store.set('start', e.target.value);
let qt;
$('q').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { state.q = e.target.value.trim(); render(); }, 150); };
$('q').onkeydown = (e) => { if (e.key === 'Escape') { e.target.value = ''; state.q = ''; render(); } };
let rt0;
window.addEventListener('resize', () => { clearTimeout(rt0); rt0 = setTimeout(() => { setHeaderHeight(); if (state.r) renderView(state.r); }, 200); });
const setDockW = (w) => { const v = Math.round(Math.min(Math.max(w, 320), Math.max(320, innerWidth * 0.8))); document.documentElement.style.setProperty('--dockw', v + 'px'); return v; };
setDockW(Number(store.get('dockW2', '378')) || 378);
$('dockgrip').onpointerdown = (e) => {
  e.preventDefault(); document.body.classList.add('dock-resizing'); $('dockgrip').setPointerCapture(e.pointerId);
  const move = (ev) => setDockW(innerWidth - ev.clientX);
  const up = (ev) => { $('dockgrip').removeEventListener('pointermove', move); $('dockgrip').removeEventListener('pointerup', up); document.body.classList.remove('dock-resizing'); store.set('dockW2', String(setDockW(innerWidth - ev.clientX))); setHeaderHeight(); };
  $('dockgrip').addEventListener('pointermove', move); $('dockgrip').addEventListener('pointerup', up);
};
$('chatfab').onclick = () => setChat(true, true);
$('dockclose').onclick = () => setChat(false);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.chatOpen && !chat.busy) setChat(false); });
if (state.chatOpen) document.body.classList.add('chat-open');
if (location.hash === '#/chat') { location.hash = '#/overview'; state.chatOpen = true; document.body.classList.add('chat-open'); }
window.addEventListener('hashchange', () => { if (location.hash === '#/chat') { location.hash = '#/overview'; setChat(true, true); return; } state.fb = undefined; if (state.q) { state.q = ''; $('q').value = ''; } render(); window.scrollTo(0, 0); });
// ?theme=light|dark overrides (and is remembered), handy for screenshots and shared links.
const urlTheme = new URLSearchParams(location.search).get('theme');
if (urlTheme === 'light' || urlTheme === 'dark' || urlTheme === 'auto') store.set('theme', urlTheme);
applyTheme(store.get('theme', 'auto'));
applyRefresh(+store.get('refresh', '60'));
load(false);
$('tv-close').onclick = () => $('taskview').close();
