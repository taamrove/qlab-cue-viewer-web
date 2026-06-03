// QLab Cue Viewer — single-page app with two modes:
//   - landing  → /  (no ?channel=)         → enter code/password, pick recent
//   - timeline → /?channel=<code>          → live cue timeline
//
// Passwords (= relay tokens) live in localStorage only, never in the URL, so a
// shared `viewer.trv.as/?channel=foo` link is safe to forward.

const RELAY_URL = import.meta.env.VITE_RELAY_URL ?? 'wss://relay.trv.as';
const SESSIONS_KEY = 'qlab-viewer.sessions';
const MAX_SESSIONS = 8;

// ─── localStorage-backed sessions ────────────────────────────────────────────

function getSessions() {
  try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]'); }
  catch { return []; }
}
function saveSessions(list) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(list.slice(0, MAX_SESSIONS)));
}
function rememberSession(channel, password) {
  const sessions = getSessions().filter((s) => s.channel !== channel);
  sessions.unshift({ channel, password: password || '', lastUsed: Date.now() });
  saveSessions(sessions);
}
function findSession(channel) {
  return getSessions().find((s) => s.channel === channel);
}
function forgetSession(channel) {
  saveSessions(getSessions().filter((s) => s.channel !== channel));
}

// ─── entry: pick a mode based on the URL ─────────────────────────────────────

function init() {
  const params = new URLSearchParams(location.search);
  const channel = params.get('channel');

  // Migrate legacy `?token=…` URLs into localStorage, then strip the secret
  // from the address bar so it doesn't leak via browser history / sharing.
  const legacyToken = params.get('token');
  if (channel && legacyToken) {
    rememberSession(channel, legacyToken);
    params.delete('token');
    const clean = params.toString();
    history.replaceState(null, '', clean ? `?${clean}` : location.pathname);
  }

  if (channel) {
    startTimelineMode(channel);
  } else {
    startLandingMode();
  }
}

// ─── landing mode ────────────────────────────────────────────────────────────

function startLandingMode(prefill = {}) {
  document.getElementById('landing').hidden = false;
  document.getElementById('topbar').hidden = true;
  document.getElementById('timeline').hidden = true;

  const codeEl = document.getElementById('code-input');
  const passEl = document.getElementById('pass-input');
  const errEl  = document.getElementById('connect-error');
  const form   = document.getElementById('connect-form');

  if (prefill.channel) codeEl.value = prefill.channel;
  if (prefill.password) passEl.value = prefill.password;
  if (prefill.error) {
    errEl.textContent = prefill.error;
    errEl.hidden = false;
  } else {
    errEl.hidden = true;
  }

  form.onsubmit = (e) => {
    e.preventDefault();
    const channel = codeEl.value.trim();
    if (!channel) return;
    rememberSession(channel, passEl.value);
    // Navigate to ?channel=… — triggers a fresh page load and timeline mode.
    location.href = `?channel=${encodeURIComponent(channel)}`;
  };

  renderRecent();
}

function renderRecent() {
  const section = document.getElementById('recent-section');
  const list = document.getElementById('recent-list');
  const sessions = getSessions();

  list.innerHTML = '';
  if (sessions.length === 0) { section.hidden = true; return; }
  section.hidden = false;

  for (const s of sessions) {
    const li = document.createElement('li');
    li.className = 'recent-item';

    const link = document.createElement('a');
    link.className = 'recent-link';
    link.href = `?channel=${encodeURIComponent(s.channel)}`;
    link.innerHTML = `
      <span class="recent-name">${escapeHTML(s.channel)}</span>
      <span class="recent-meta">
        ${s.password ? '<span class="recent-lock" title="Password saved">🔒</span>' : ''}
        <span class="recent-when">${timeAgo(s.lastUsed)}</span>
      </span>`;

    const del = document.createElement('button');
    del.className = 'recent-del';
    del.type = 'button';
    del.title = 'Forget this show';
    del.textContent = '×';
    del.onclick = (e) => { e.preventDefault(); forgetSession(s.channel); renderRecent(); };

    li.append(link, del);
    list.appendChild(li);
  }
}

function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60)      return 'just now';
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── timeline mode (the existing viewer) ─────────────────────────────────────

const TYPE_ICON = {
  Video: '▶', Audio: '🔊', Memo: '✎', Group: '⛓', Wait: '⏱',
  Fade:  '⤴', Light: '💡', MIDI:  '𝅘𝅥', Script: '⚙', Network: '⇆',
  Camera:'📷', Title: 'T',  Start: '▷', Stop:  '◻',
};
const TYPE_COLOR = {
  Video: '#5e9eff', Audio: '#54d39a', Memo: '#bdbdbd', Group: '#888',
  Fade:  '#ffb84d', Light: '#ffe066', Wait: '#9b8aff',
};

let lastSnapshot = null;
let lastSnapshotReceived = 0;
let timelineEls = null;

function startTimelineMode(channel) {
  document.getElementById('landing').hidden = true;
  document.getElementById('topbar').hidden = false;
  document.getElementById('timeline').hidden = false;

  timelineEls = {
    status:       document.getElementById('status'),
    ts:           document.getElementById('ts'),
    playheadName: document.getElementById('playhead-name'),
    playheadNum:  document.getElementById('playhead-number'),
    ruler:        document.getElementById('ruler'),
    lanes:        document.getElementById('lanes'),
    empty:        document.getElementById('empty'),
  };

  document.getElementById('back-btn').onclick = () => {
    // Reload to / — landing mode picks up from there.
    location.href = '/';
  };

  const session = findSession(channel);
  const password = session?.password || '';
  // Touch the session so it bubbles to the top of the recent list.
  rememberSession(channel, password);

  connect(channel, password);
}

function setStatus(text, cls) {
  timelineEls.status.textContent = text;
  timelineEls.status.className = `status ${cls}`;
}

function fmtTime(seconds) {
  if (!Number.isFinite(seconds)) return '–:––';
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

function render() {
  const snap = lastSnapshot;
  if (!snap || !timelineEls) return;

  timelineEls.playheadNum.textContent  = snap.playheadNumber ? `Q${snap.playheadNumber}` : '';
  timelineEls.playheadName.textContent = snap.playheadName ?? '—';
  timelineEls.ts.textContent = snap.ts ? new Date(snap.ts).toLocaleTimeString() : '';

  const running = (snap.running ?? []);
  timelineEls.empty.hidden = running.length > 0;

  // Time axis = furthest right anything reaches.
  const endTime = (c) => (c.preWait ?? 0) + (c.duration ?? 0);
  const maxTime = Math.max(0, ...running.map(endTime));

  drawRuler(maxTime);
  drawLanes(running, maxTime, snap);
}

function drawRuler(maxTime) {
  timelineEls.ruler.innerHTML = '';
  if (maxTime <= 0) return;

  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const target = maxTime / 6;
  const step = candidates.find((c) => c >= target) ?? candidates.at(-1);

  for (let t = 0; t <= maxTime + 0.001; t += step) {
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.style.left = `${(t / maxTime) * 100}%`;
    tick.textContent = fmtTime(t);
    timelineEls.ruler.appendChild(tick);
  }
}

function drawLanes(running, maxTime, snap) {
  timelineEls.lanes.innerHTML = '';
  for (const cue of running) {
    timelineEls.lanes.appendChild(buildLane(cue, maxTime, snap));
  }
}

function liveElapsed(cue) {
  const e = cue.elapsed ?? 0;
  if (!Number.isFinite(e) || !cue.duration) return e;
  const delta = (Date.now() - lastSnapshotReceived) / 1000;
  return Math.min(cue.duration, e + delta);
}

function buildLane(cue, maxTime, snap) {
  const lane = document.createElement('div');
  lane.className = 'lane';

  const head = document.createElement('div');
  head.className = 'lane-head';
  const icon = document.createElement('span');
  icon.className = 'lane-icon';
  icon.textContent = TYPE_ICON[cue.type] ?? '•';
  icon.style.color = TYPE_COLOR[cue.type] ?? '#fff';
  const name = document.createElement('span');
  name.className = 'lane-name';
  name.textContent = cue.name;
  const numEl = document.createElement('span');
  numEl.className = 'lane-num';
  numEl.textContent = cue.number ? `Q${cue.number}` : '';
  head.append(icon, name, numEl);

  const time = document.createElement('div');
  time.className = 'lane-time';

  const track = document.createElement('div');
  track.className = 'lane-track';
  const preWait = cue.preWait ?? 0;
  const leftPct = maxTime > 0 ? (preWait / maxTime) * 100 : 0;

  if ((cue.duration ?? 0) > 0 && maxTime > 0) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.left  = `${leftPct}%`;
    bar.style.width = `${(cue.duration / maxTime) * 100}%`;
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    bar.appendChild(fill);
    track.appendChild(bar);

    const updateFill = () => {
      const e = liveElapsed(cue);
      fill.style.width = `${Math.min(100, (e / cue.duration) * 100)}%`;
      time.textContent = `${fmtTime(e)} / ${fmtTime(cue.duration)}`;
    };
    updateFill();
    bar.dataset.tick = setInterval(updateFill, 100);
  } else {
    const color = TYPE_COLOR[cue.type] ?? '#888';
    const flag = document.createElement('div');
    flag.className = 'flag';
    flag.style.left = `${leftPct}%`;
    flag.style.setProperty('--color', color);
    flag.style.setProperty('--countdown', '0');
    track.appendChild(flag);

    if (preWait > 0) {
      const updateGlow = () => {
        const baseElapsed = cue.preWaitElapsed ?? 0;
        const delta = (Date.now() - lastSnapshotReceived) / 1000;
        const e = Math.min(preWait, baseElapsed + delta);
        flag.style.setProperty('--countdown', (e / preWait).toFixed(3));
        const remaining = Math.max(0, preWait - e);
        time.textContent = `GO in ${fmtTime(remaining)}`;
      };
      updateGlow();
      flag.dataset.tick = setInterval(updateGlow, 100);
    } else {
      time.textContent = 'instant';
    }
  }

  lane.append(head, track, time);
  return lane;
}

function clearTickers() {
  for (const el of document.querySelectorAll('[data-tick]')) {
    clearInterval(Number(el.dataset.tick));
  }
}

// ─── WebSocket connection (timeline mode only) ───────────────────────────────

let ws;
let retry = 1000;
let currentChannel = '';
let currentPassword = '';

function connect(channel, password) {
  currentChannel = channel;
  currentPassword = password;

  const u = new URL(RELAY_URL);
  u.searchParams.set('channel', channel);
  u.searchParams.set('role', 'subscriber');
  if (password) u.searchParams.set('token', password);

  setStatus('connecting…', 'disconnected');
  ws = new WebSocket(u.toString());

  ws.addEventListener('open', () => {
    setStatus('live', 'connected');
    retry = 1000;
  });
  ws.addEventListener('message', (e) => {
    try {
      const snap = JSON.parse(e.data);
      clearTickers();
      lastSnapshot = snap;
      lastSnapshotReceived = Date.now();
      render();
    } catch (err) { console.warn('bad payload', err); }
  });
  ws.addEventListener('close', (ev) => {
    // 1008 / 4001 / 4003 → policy/auth violation on most servers. Our relay
    // uses generic close on auth failure, so we use 1006 (abnormal close
    // before HTTP 101 — typical when the server rejects with 401) as a hint
    // we should bounce to landing with an error.
    if (ev.code === 1006 && retry === 1000) {
      // First-time close-before-open: probably an auth or channel issue.
      // Send the user back to landing with the code pre-filled so they can
      // try a different password.
      const channel = currentChannel;
      const pw = currentPassword;
      location.href = `/?prefill=${encodeURIComponent(channel)}&pwfail=${pw ? 1 : 0}`;
      return;
    }
    setStatus('reconnecting…', 'disconnected');
    setTimeout(() => connect(currentChannel, currentPassword), retry);
    retry = Math.min(retry * 2, 10000);
  });
  ws.addEventListener('error', () => ws.close());
}

window.addEventListener('resize', () => render());

// Catch a redirect back from a failed timeline connection (auth refused) and
// re-show the landing form with a hint.
(function handleAuthBounce() {
  const p = new URLSearchParams(location.search);
  const prefill = p.get('prefill');
  if (prefill && !p.get('channel')) {
    const pwfail = p.get('pwfail') === '1';
    history.replaceState(null, '', location.pathname);
    startLandingMode({
      channel: prefill,
      error: pwfail
        ? 'Connection refused — wrong password?'
        : `Couldn't connect to "${prefill}". This channel may require a password.`,
    });
    return; // skip the normal init path below
  }
  init();
})();
