// QLab Cue Viewer — timeline edition.
//
// Snapshot shape (from relay):
//   { ts, activeName, playheadName, playheadNumber,
//     running: [{ id, name, number, type, duration, elapsed, percent }, ...] }

const params = new URLSearchParams(location.search);
const RELAY_URL = params.get('relay') ?? import.meta.env.VITE_RELAY_URL ?? 'wss://relay.trv.as';
const TOKEN     = params.get('token')   ?? import.meta.env.VITE_RELAY_TOKEN   ?? '';
const CHANNEL   = params.get('channel') ?? import.meta.env.VITE_RELAY_CHANNEL ?? 'qlab-show-1';

const $ = (id) => document.getElementById(id);
const els = {
  status:       $('status'),
  ts:           $('ts'),
  playheadName: $('playhead-name'),
  playheadNum:  $('playhead-number'),
  ruler:        $('ruler'),
  lanes:        $('lanes'),
  empty:        $('empty'),
};

const TYPE_ICON = {
  Video: '▶', Audio: '🔊', Memo: '✎', Group: '⛓', Wait: '⏱',
  Fade:  '⤴', Light: '💡', MIDI:  '𝅘𝅥', Script: '⚙', Network: '⇆',
  Camera:'📷', Title: 'T',  Start: '▷', Stop:  '◻',
};
const TYPE_COLOR = {
  Video: '#5e9eff', Audio: '#54d39a', Memo: '#bdbdbd', Group: '#888',
  Fade:  '#ffb84d', Light: '#ffe066', Wait: '#9b8aff',
};

// Update local cache so we can keep ticking the time display between
// snapshots — the bridge only sends new snapshots when state changes, so
// without local interpolation the elapsed numbers freeze when nothing's
// being played mid-cue.
let lastSnapshot = null;
let lastSnapshotReceived = 0;


function setStatus(text, cls) {
  els.status.textContent = text;
  els.status.className = `status ${cls}`;
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
  if (!snap) return;

  els.playheadNum.textContent  = snap.playheadNumber ? `Q${snap.playheadNumber}` : '';
  // Only the playhead (selected cue) — falling back to activeName makes the
  // title strobe between sibling cues inside a running group.
  els.playheadName.textContent = snap.playheadName ?? '—';
  els.ts.textContent = snap.ts ? new Date(snap.ts).toLocaleTimeString() : '';

  const running = (snap.running ?? []);
  els.empty.hidden = running.length > 0;

  // Time-axis end = the furthest right anything reaches. For a timed cue
  // that's preWait + duration; for an instant memo it's just preWait.
  const endTime = (c) => (c.preWait ?? 0) + (c.duration ?? 0);
  const maxTime = Math.max(0, ...running.map(endTime));

  drawRuler(maxTime);
  drawLanes(running, maxTime, snap);
}

function drawRuler(maxDuration) {
  els.ruler.innerHTML = '';
  if (maxDuration <= 0) return;

  // Pick a tick interval that gives ~5–8 labels at the current width.
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const target = maxDuration / 6;
  const step = candidates.find(c => c >= target) ?? candidates.at(-1);

  for (let t = 0; t <= maxDuration + 0.001; t += step) {
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.style.left = `${(t / maxDuration) * 100}%`;
    tick.textContent = fmtTime(t);
    els.ruler.appendChild(tick);
  }
}

function drawLanes(running, maxTime, snap) {
  els.lanes.innerHTML = '';
  for (const cue of running) {
    els.lanes.appendChild(buildLane(cue, maxTime, snap));
  }
}

// Interpolate elapsed forward from when the snapshot landed, so progress
// bars move smoothly between server updates instead of jumping every 250ms.
function liveElapsed(cue) {
  const e = cue.elapsed ?? 0;
  if (!Number.isFinite(e) || !cue.duration) return e;
  const delta = (Date.now() - lastSnapshotReceived) / 1000;
  return Math.min(cue.duration, e + delta);
}

function buildLane(cue, maxTime, snap) {
  const lane = document.createElement('div');
  lane.className = 'lane';
  // No .active class — QLab's "active cue" flickers across siblings every
  // poll inside a group, so highlighting it makes the whole timeline strobe.
  // The bar's own fill progress is the real "this is playing now" indicator.

  // — left rail: icon, name, number
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

  // — right rail: time display
  const time = document.createElement('div');
  time.className = 'lane-time';

  // — track + bar/flag, positioned along the shared time axis
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
    // Zero-duration cue (Memo, Text, Wait 0). One flag at the preWait
    // offset that quietly glows brighter and grows as the pre-wait counts
    // down. At 100% the cue is firing.
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
        // Keep a single, stable text format — switching wording on the fire
        // boundary causes a visible flicker as local interpolation crosses
        // back and forth around preWait.
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

// Clear all active per-lane intervals before re-render so they don't pile up.
// (Both video-bar tickers and memo-lead-in tickers carry a `data-tick`.)
function clearTickers() {
  for (const el of document.querySelectorAll('[data-tick]')) {
    clearInterval(Number(el.dataset.tick));
  }
}

let ws;
let retry = 1000;
function connect() {
  const u = new URL(RELAY_URL);
  u.searchParams.set('token', TOKEN);
  u.searchParams.set('channel', CHANNEL);
  u.searchParams.set('role', 'subscriber');

  setStatus('connecting…', 'disconnected');
  ws = new WebSocket(u.toString());

  ws.addEventListener('open', () => { setStatus('live', 'connected'); retry = 1000; });
  ws.addEventListener('message', (e) => {
    try {
      const snap = JSON.parse(e.data);
      clearTickers();
      lastSnapshot = snap;
      lastSnapshotReceived = Date.now();
      render();
    } catch (err) { console.warn('bad payload', err); }
  });
  ws.addEventListener('close', () => {
    setStatus('reconnecting…', 'disconnected');
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 10000);
  });
  ws.addEventListener('error', () => ws.close());
}

connect();

// Re-render on window resize so the ruler tick density adapts.
window.addEventListener('resize', () => render());
