// QLab Cue Viewer — single-page app, landing + timeline.

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

// ─── entry: pick a mode ──────────────────────────────────────────────────────

function init() {
  const params = new URLSearchParams(location.search);
  const channel = params.get('channel');

  const legacyToken = params.get('token');
  if (channel && legacyToken) {
    rememberSession(channel, legacyToken);
    params.delete('token');
    const clean = params.toString();
    history.replaceState(null, '', clean ? `?${clean}` : location.pathname);
  }

  if (channel) startTimelineMode(channel);
  else         startLandingMode();
}

// ─── landing mode ────────────────────────────────────────────────────────────

function startLandingMode(prefill = {}) {
  document.getElementById('landing').hidden = false;
  document.getElementById('topbar').hidden = true;
  document.getElementById('timeline').hidden = true;

  const codeEl  = document.getElementById('code-input');
  const passEl  = document.getElementById('pass-input');
  const passRow = document.getElementById('pass-row');
  const errEl   = document.getElementById('connect-error');
  const form    = document.getElementById('connect-form');

  if (prefill.channel) codeEl.value = prefill.channel;

  const needsPassword = !!prefill.needsPassword;
  passRow.hidden = !needsPassword;
  if (!needsPassword) passEl.value = '';
  if (needsPassword) setTimeout(() => passEl.focus(), 0);

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
  if (s < 60)     return 'just now';
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── timeline mode ───────────────────────────────────────────────────────────

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
const lanesById = new Map();       // cue.id → Lane (persistent across snapshots)
let currentMaxTime = 0;

function startTimelineMode(channel) {
  document.getElementById('landing').hidden = true;
  document.getElementById('topbar').hidden = false;
  document.getElementById('timeline').hidden = false;

  timelineEls = {
    status:        document.getElementById('status'),
    ts:            document.getElementById('ts'),
    playheadName:  document.getElementById('playhead-name'),
    playheadNum:   document.getElementById('playhead-number'),
    groupContext:  document.getElementById('group-context'),
    groupCurrent:  document.getElementById('group-current'),
    ruler:         document.getElementById('ruler'),
    lanes:         document.getElementById('lanes'),
    empty:         document.getElementById('empty'),
  };

  document.getElementById('back-btn').onclick = () => { location.href = '/'; };

  const session = findSession(channel);
  const password = session?.password || '';
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

// ─── Lane: one persistent DOM element per running cue ───────────────────────
//
// We deliberately do NOT rebuild lanes on every snapshot. Instead each Lane
// owns its DOM, runs a 10 Hz local ticker, and gets its `cue` data swapped
// when new snapshots arrive. That kills the strobe effect that came from
// destroying-and-recreating elements on every 4 Hz update.

class Lane {
  constructor(cue, maxTime) {
    this.cue = cue;
    this.maxTime = maxTime;
    this.isInstant = !((cue.duration ?? 0) > 0);
    this.build();
    this.applyPositioning();
    this.update();           // synchronous first paint
    this.tickerId = setInterval(() => this.update(), 100);
  }

  build() {
    const lane = document.createElement('div');
    lane.className = 'lane' + (this.isInstant ? ' instant' : ' timed');

    // Head: icon + name + number
    const head = document.createElement('div');
    head.className = 'lane-head';
    const icon = document.createElement('span');
    icon.className = 'lane-icon';
    icon.textContent = TYPE_ICON[this.cue.type] ?? '•';
    icon.style.color = TYPE_COLOR[this.cue.type] ?? '#fff';
    const name = document.createElement('span');
    name.className = 'lane-name';
    name.textContent = this.cue.name;
    const numEl = document.createElement('span');
    numEl.className = 'lane-num';
    numEl.textContent = this.cue.number ? `Q${this.cue.number}` : '';
    head.append(icon, name, numEl);

    // Track: either a bar (with fill) or a flag, depending on type
    const track = document.createElement('div');
    track.className = 'lane-track';

    if (this.isInstant) {
      const flag = document.createElement('div');
      flag.className = 'flag';
      flag.style.setProperty('--color', TYPE_COLOR[this.cue.type] ?? '#888');
      flag.style.setProperty('--countdown', '0');
      track.appendChild(flag);
      this.flagEl = flag;
    } else {
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      bar.appendChild(fill);
      track.appendChild(bar);
      this.barEl = bar;
      this.fillEl = fill;
    }

    // Right rail: time / status text
    const time = document.createElement('div');
    time.className = 'lane-time';

    lane.append(head, track, time);

    this.el = lane;
    this.headEl = head;
    this.trackEl = track;
    this.timeEl = time;
  }

  // Apply the time-axis position (bar/flag left%, bar width%). Called on
  // create and whenever the global maxTime changes.
  applyPositioning() {
    const preWait = this.cue.preWait ?? 0;
    const leftPct = this.maxTime > 0 ? (preWait / this.maxTime) * 100 : 0;
    if (this.isInstant) {
      this.flagEl.style.left = `${leftPct}%`;
    } else {
      this.barEl.style.left  = `${leftPct}%`;
      this.barEl.style.width = this.maxTime > 0
        ? `${(this.cue.duration / this.maxTime) * 100}%`
        : '0%';
    }
  }

  setCue(cue) {
    // Cheap text refresh — DOM stays. Position changes only happen when
    // the cue itself genuinely moved (rare), or maxTime changed.
    const positionChanged =
      (cue.preWait ?? 0) !== (this.cue.preWait ?? 0)
      || (cue.duration ?? 0) !== (this.cue.duration ?? 0);
    this.cue = cue;
    if (positionChanged) this.applyPositioning();
  }

  setMaxTime(maxTime) {
    if (maxTime === this.maxTime) return;
    this.maxTime = maxTime;
    this.applyPositioning();
  }

  // 10 Hz: refresh text/fill/glow based on live interpolation. Numbers stay
  // on the same DOM nodes so they don't flicker across snapshots.
  update() {
    const cue = this.cue;
    const preWait = cue.preWait ?? 0;
    const duration = cue.duration ?? 0;
    const delta = (Date.now() - lastSnapshotReceived) / 1000;

    // Pre-wait state — applies to BOTH instant and timed cues that have a
    // pre-wait. While in pre-wait, show a countdown instead of the play state.
    if (preWait > 0) {
      const preE = Math.min(preWait, (cue.preWaitElapsed ?? 0) + delta);
      const remaining = preWait - preE;
      if (remaining > 0) {
        // Still waiting
        if (this.isInstant) {
          this.flagEl.style.setProperty('--countdown', (preE / preWait).toFixed(3));
        }
        this.setStatus('waiting');
        this.setText(this.isInstant
          ? `GO in ${fmtTime(remaining)}`
          : `starts in ${fmtTime(remaining)}`);
        return;
      }
      // Pre-wait just elapsed — fall through to fired/playing state below.
      if (this.isInstant) {
        this.flagEl.style.setProperty('--countdown', '1');
      }
    }

    // Post-preWait state
    if (this.isInstant) {
      this.setStatus('fired');
      this.setText('fired');
      return;
    }

    // Timed cue, action is playing or done
    const e = Math.min(duration, (cue.elapsed ?? 0) + delta);
    const done = duration > 0 && e >= duration;
    if (this.fillEl) {
      const pct = duration > 0 ? (e / duration) * 100 : 0;
      this.fillEl.style.width = `${Math.min(100, pct)}%`;
    }
    this.setStatus(done ? 'fired' : 'playing');
    this.setText(done ? 'done' : `${fmtTime(e)} / ${fmtTime(duration)}`);
  }

  // Only touch class names / text when they actually change — keeps the
  // DOM mutation observer / CSS transitions calm.
  setStatus(s) {
    if (this._status === s) return;
    this._status = s;
    this.el.classList.toggle('waiting', s === 'waiting');
    this.el.classList.toggle('fired',   s === 'fired');
  }
  setText(t) {
    if (this._lastText === t) return;
    this._lastText = t;
    this.timeEl.textContent = t;
  }

  fadeOut(durationMs) {
    clearInterval(this.tickerId);
    this.tickerId = null;
    this.el.style.setProperty('--fade-ms', `${durationMs}ms`);
    this.el.classList.add('removing');
    setTimeout(() => this.el.remove(), durationMs);
  }
}

// Fade duration scales with cue density: lots of upcoming changes → faster
// fade so the timeline stays in sync; sparse → leisurely fade. Bounded.
function computeFadeMs(running) {
  if (running.length <= 1) return 1200;
  const endTime = (c) => (c.preWait ?? 0) + (c.duration ?? 0);
  const span = Math.max(...running.map(endTime));
  const avgGap = span / running.length;
  return Math.max(300, Math.min(4000, avgGap * 500));
}

function render() {
  const snap = lastSnapshot;
  if (!snap || !timelineEls) return;

  // ── Top bar ──────────────────────────────────────────────────────────────
  timelineEls.playheadNum.textContent  = snap.playheadNumber ? `Q${snap.playheadNumber}` : '';
  timelineEls.playheadName.textContent = snap.playheadName ?? '—';
  timelineEls.ts.textContent = snap.ts ? new Date(snap.ts).toLocaleTimeString() : '';

  // Innermost group is the "song" (current focus); everything above it is
  // context ("show > scene > ..."). Hide either when there's nothing.
  const path = snap.groupPath ?? [];
  const current = path.at(-1) || '';
  const context = path.slice(0, -1).join(' › ');
  timelineEls.groupContext.textContent = context;
  timelineEls.groupCurrent.textContent = current;
  timelineEls.groupContext.hidden = !context;
  timelineEls.groupCurrent.hidden = !current;

  // ── Lanes (incremental) ─────────────────────────────────────────────────
  const running = (snap.running ?? []);
  timelineEls.empty.hidden = running.length > 0;

  const endTime = (c) => (c.preWait ?? 0) + (c.duration ?? 0);
  const maxTime = Math.max(0, ...running.map(endTime));

  // Maxtime / ruler — only redraw when it actually changes.
  if (maxTime !== currentMaxTime) {
    currentMaxTime = maxTime;
    drawRuler(maxTime);
    for (const lane of lanesById.values()) lane.setMaxTime(maxTime);
  }

  const newIds = new Set(running.map((c) => c.id));
  const fadeMs = computeFadeMs(running);

  // Remove lanes for cues that left running — animated.
  for (const [id, lane] of lanesById) {
    if (!newIds.has(id)) {
      lane.fadeOut(fadeMs);
      lanesById.delete(id);
    }
  }

  // Add new lanes / update existing ones in place.
  for (const cue of running) {
    let lane = lanesById.get(cue.id);
    if (!lane) {
      lane = new Lane(cue, maxTime);
      lanesById.set(cue.id, lane);
      timelineEls.lanes.appendChild(lane.el);
    } else {
      lane.setCue(cue);
    }
  }

  // Keep DOM order matching QLab's source order — appendChild moves existing
  // elements without rebuilding them. Skip lanes currently fading away so
  // their animation doesn't get jostled.
  for (const cue of running) {
    const lane = lanesById.get(cue.id);
    if (!lane.el.classList.contains('removing')) {
      timelineEls.lanes.appendChild(lane.el);
    }
  }
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

// ─── WebSocket connection (timeline mode only) ───────────────────────────────

let ws;
let retry = 1000;
let currentChannel = '';
let currentPassword = '';
let firstMessageReceived = false;

function connect(channel, password) {
  currentChannel = channel;
  currentPassword = password;
  firstMessageReceived = false;

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
    firstMessageReceived = true;
    try {
      const snap = JSON.parse(e.data);
      lastSnapshot = snap;
      lastSnapshotReceived = Date.now();
      render();
    } catch (err) { console.warn('bad payload', err); }
  });
  ws.addEventListener('close', (ev) => {
    if (ev.code === 1006 && !firstMessageReceived && retry === 1000) {
      // Closed before any message arrived on a fresh connection — likely auth
      // rejection. Send the user back to landing with the code prefilled and
      // the password field revealed.
      const ch = currentChannel;
      const pw = currentPassword;
      location.href = `/?prefill=${encodeURIComponent(ch)}&pwfail=${pw ? 1 : 0}`;
      return;
    }
    setStatus('reconnecting…', 'disconnected');
    setTimeout(() => connect(currentChannel, currentPassword), retry);
    retry = Math.min(retry * 2, 10000);
  });
  ws.addEventListener('error', () => ws.close());
}

window.addEventListener('resize', () => render());

// Auth-failure bounce-back into landing mode.
(function handleAuthBounce() {
  const p = new URLSearchParams(location.search);
  const prefill = p.get('prefill');
  if (prefill && !p.get('channel')) {
    const pwfail = p.get('pwfail') === '1';
    history.replaceState(null, '', location.pathname);
    startLandingMode({
      channel: prefill,
      needsPassword: true,
      error: pwfail
        ? 'Wrong password — try again.'
        : `"${prefill}" requires a password.`,
    });
    return;
  }
  init();
})();
