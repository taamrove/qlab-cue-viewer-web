// QLab Cue Viewer — single-page app, landing + timeline.

import { parseTimecode, formatTimecode, tcToFrames, framesToTc } from './timecode.js';
import { LtcOutput, canChooseOutput, listOutputDevices, revealDeviceLabels } from './ltc-out.js';
import {
  SongClock, normalizeCue, normalizePrecue, passesFilter, cueState, cueEnd, normalizeFilters,
  pathKey, itemTime, flattenWorkspace, SONG_TYPES, MAX_EXTRAPOLATE_S,
} from './customCues.js';
import { ItemsClient } from './itemsClient.js';
import { CustomLane } from './customLanes.js';
import { initDrawer } from './drawer.js';
import { DemoSocket, DEMO_CHANNEL, initDemoBar } from './demo.js';

// Demo mode: simulated show + in-browser cue store, no relay needed.
// `?demo` on any deploy, or a VITE_DEMO=1 build for the hosted demo page.
const DEMO = import.meta.env.VITE_DEMO === '1' || new URLSearchParams(location.search).has('demo');

const RELAY_URL = import.meta.env.VITE_RELAY_URL ?? 'wss://relay.trv.as';
const SESSIONS_KEY = 'qlab-viewer.sessions';
const MAX_SESSIONS = 8;

// ─── localStorage-backed sessions ────────────────────────────────────────────

function getSessions() {
  try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]'); }
  catch { return []; }
}
function saveSessions(list) {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(list.slice(0, MAX_SESSIONS))); }
  catch { /* storage blocked — sessions just won't be remembered */ }
}
function rememberSession(channel, password) {
  const prev = findSession(channel);
  const sessions = getSessions().filter((s) => s.channel !== channel);
  // Keep the editor password across reconnects; it's set from the cue drawer.
  sessions.unshift({ channel, password: password || '', editKey: prev?.editKey || '', lastUsed: Date.now() });
  saveSessions(sessions);
}
function setSessionEditKey(channel, editKey) {
  saveSessions(getSessions().map((s) => (s.channel === channel ? { ...s, editKey } : s)));
}
function findSession(channel) {
  return getSessions().find((s) => s.channel === channel);
}
function forgetSession(channel) {
  saveSessions(getSessions().filter((s) => s.channel !== channel));
}

// ─── entry: pick a mode ──────────────────────────────────────────────────────

function init() {
  if (DEMO) { startTimelineMode(DEMO_CHANNEL); return; }
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
let lastSnapshotRxAt = 0;   // wall-clock ms when we received the most recent snapshot
let playheadTickerId = null;
let timelineEls = null;
// Timecode as of the last snapshot, plus when it landed, so the readout can be
// extrapolated locally instead of stepping at the 4 Hz snapshot rate.
let tcLatch = null;
let tcTickerId = null;
let ltcOut = null;
// Stop advancing if snapshots dry up — better a frozen readout than one that
// invents timecode the show isn't playing.
const TC_STALE_S = 1.5;
const LTC_DEVICE_KEY = 'qlab-viewer.ltcDevice';
const WS_SHOWN_KEY = 'qlab-viewer.workspaceShown';
// The whole cue list, published by the bridge on its own schedule rather than
// with every snapshot — it's much larger and changes only when the workspace
// is edited.
let workspaceTree = null;
// Which top-level cue list QLab currently has open. A show workspace usually
// holds a library and helper lists beside the one being performed, and showing
// all of them buries the one that matters.
let currentListId = null;
let workspaceFollow = true;
let lastFocusedCueId = null;
// Everything between the show and this screen adds delay: the bridge's 4 Hz
// poll, the relay round trip, the network. The offset compensates for it —
// positive runs the readout ahead of what arrived.
let tcOffsetMs = 0;
// A whole-frame shift, kept separate from the millisecond offset: one
// compensates for transport delay, the other corrects a timecode that is
// deliberately a couple of frames out from what the rest of the rig expects.
let tcOffsetFrames = 0;
let tcOffsetKey = null;
// Rough end-to-end delay, from the bridge's own timestamp. Only meaningful if
// both machines have a sane clock, so it's shown as a hint, never applied.
let measuredLatencyMs = null;
const lanesById = new Map();       // cue.id → Lane (persistent across snapshots)
// IDs of cues we've already faded out voluntarily after they fired. Persisted
// to localStorage per-channel so a page refresh mid-show doesn't resurrect
// memos that already fired (QLab keeps them in `running` with preWaitElapsed
// reset to 0, so we can't detect "passed" from per-cue counters alone).
let dismissedStorageKey = null;
const dismissedIds = new Set();
function saveDismissed() {
  if (!dismissedStorageKey) return;
  try { localStorage.setItem(dismissedStorageKey, JSON.stringify([...dismissedIds])); } catch {}
}
function loadDismissed(channel) {
  dismissedStorageKey = `qlab-viewer.dismissed.${channel}`;
  dismissedIds.clear();
  try {
    const saved = JSON.parse(localStorage.getItem(dismissedStorageKey) ?? '[]');
    for (const id of saved) dismissedIds.add(id);
  } catch {}
}
let currentMaxTime = 0;
// "Current show time" inferred from the snapshot — how many seconds since the
// running group started, measured by the longest-running cue. Used so that
// cues whose preWait+duration is already in the past get auto-hidden, even
// on a fresh page reload mid-show.
let currentShowTime = 0;
let prevShowTime = 0;
// Song-level clock from the bridge — the deepest running group's
// actionElapsed. Empirically QLab returns 0 for group actionElapsed
// (groups don't own an action, their children do), so we keep this hook
// for the day we find a property QLab actually populates, and fall back
// to currentShowTime in the meantime.
let currentGroupClock = null;
// Playhead smoothing. The bridge re-sends a paused show's frozen state every
// second, so "time since last snapshot" alone would make the line creep
// forward and snap back on every heartbeat. It only extrapolates while show
// time actually advanced between the last two snapshots, and never draws
// backwards except on a real restart.
let showTimeAdvancing = false;
let playheadShown = 0;
let lastRenderedSnap = null;

// ─── Custom cues state ───────────────────────────────────────────────────────
// Cues and pre-cue to-dos that live in the viewer (relay item store), not in
// QLab. Each is tied to a TARGET:
//   'cue:<uniqueID>'  an item — the QLab cue that is the song (usually the
//                     audio/video file). Clock = that cue's own time
//                     (itemTime), so songs played one after another inside
//                     one group never share a clock.
//   'grp:<path>'      a song group (cues made before item anchoring). Clock =
//                     the group's show time, as before.
// A target is "active" while its cue/group is actually ticking.
const targetClocks = new Map();          // target key → SongClock
const activeTargets = new Map();         // target key → { offset, laneId, groupKey }
const knownPaths = new Map();            // pathKey → groupPath, every group seen this session
const groupIdByPath = new Map();         // pathKey → QLab uniqueID of that group (newer bridges)
const activeKeyByGroupId = new Map();    // group uniqueID → 'grp:' key, for groups ticking now
const runningNames = new Map();          // QLab cue id → name, for items not in the workspace list
const customLanes = new Map();           // item id → CustomLane
const customDismissed = new Set();       // `${targetKey}|${id}@${at}` already faded out this run
let filters = normalizeFilters(null);
let drawer = null;
const items = new ItemsClient({
  onChange: () => {
    render();
    renderWorkspace();
    drawer?.refresh();
  },
});

function filtersKey() { return `qlab-viewer.filters.${currentChannel}`; }
function loadFilters() {
  try { filters = normalizeFilters(JSON.parse(localStorage.getItem(filtersKey()) || 'null')); }
  catch { filters = normalizeFilters(null); }
}
function saveFilters(f) {
  filters = normalizeFilters(f);
  try { localStorage.setItem(filtersKey(), JSON.stringify(filters)); } catch { /* ignore */ }
  render();
  drawer?.refresh();
  updateFilterBadge();
}
function updateFilterBadge() {
  const active = !filters.qlab || !filters.shared || !filters.private || filters.hiddenDepts.length > 0;
  document.getElementById('filter-btn').setAttribute('aria-pressed', String(active));
}

function allCues() {
  const out = [];
  for (const it of items.items.values()) {
    const c = normalizeCue(it);
    if (c) out.push(c);
  }
  return out;
}
function allPrecues() {
  const out = [];
  for (const it of items.items.values()) {
    const p = normalizePrecue(it);
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

// The active target a cue or pre-cue belongs to right now, or null.
function activeKeyFor(c) {
  if (c.cueId) return activeTargets.has(c.target) ? c.target : null;
  if (c.groupId && activeKeyByGroupId.has(c.groupId)) return activeKeyByGroupId.get(c.groupId);
  return activeTargets.has(c.target) ? c.target : null;
}
function targetTime(key) {
  return key && activeTargets.has(key) ? targetClocks.get(key).now(Date.now()) : null;
}

// Workspace items of the open cue list, in show order (from the bridge's
// workspace message; empty until it arrives).
function workspaceItems() {
  if (!workspaceTree) return [];
  const lists = workspaceTree.filter((l) => l.id === currentListId);
  const roots = lists.length === 1 ? (lists[0].cues ?? []) : workspaceTree;
  return flattenWorkspace(roots);
}

// The song playing "now", for stamping. Among media items whose action is
// running: the most recently started GROUP wins (at a crossfade that's the
// song just GO'd), and inside it the LONGEST item (the song's bed, not a
// video that starts a few seconds in). One file per song → that file.
// Falls back to any ticking item.
function currentTarget() {
  const playing = (lastSnapshot?.running ?? []).filter((c) => (itemTime(c) ?? 0) > 0);
  if (!playing.length) return null;
  const songs = playing.filter((c) => SONG_TYPES.has(c.type));
  const pool = songs.length ? songs : playing;
  const clockOf = new Map();
  for (const c of playing) {
    const g = pathKey(c.groupPath ?? []);
    clockOf.set(g, Math.max(clockOf.get(g) ?? 0, computeShowTime([c])));
  }
  let best = null;
  for (const c of pool) {
    const g = clockOf.get(pathKey(c.groupPath ?? [])) ?? 0;
    const d = c.duration ?? 0;
    if (!best || g < best.g - 0.5 || (Math.abs(g - best.g) <= 0.5 && d > best.d)) best = { c, g, d };
  }
  const c = best.c;
  return { key: `cue:${c.id}`, cueId: c.id, cueName: c.name, path: c.groupPath ?? [] };
}

// What's next up, for the Next up card: the first song after the last one
// playing, in workspace order — skipping items that are really part of the
// current song: ones whose pre-wait is already ticking (they fire on their
// own) and ones in a running group whose window is already behind that
// group's clock (finished; QLab reports those as 0/0, just like a song
// waiting for its GO). With nothing playing: the QLab playhead, or the
// first song inside the group the playhead sits on.
function standbyItem() {
  const flat = workspaceItems();
  if (!flat.length) return null;
  const running = new Map((lastSnapshot?.running ?? []).map((c) => [c.id, c]));
  const groupClock = new Map();
  for (const c of running.values()) {
    if (itemTime(c) === null) continue;
    const g = pathKey(c.groupPath ?? []);
    groupClock.set(g, Math.max(groupClock.get(g) ?? 0, computeShowTime([c])));
  }
  const isSong = (x) => SONG_TYPES.has(x.type);
  const partOfCurrent = (x) => {
    const c = running.get(x.id);
    if (!c) return false;
    if (itemTime(c) !== null) return true;                       // ticking: pre-wait or playing
    const clock = groupClock.get(pathKey(c.groupPath ?? []));
    return clock != null && (c.preWait ?? 0) + (c.duration ?? 0) + 0.25 < clock;   // already played
  };
  let last = -1;
  flat.forEach((x, i) => { if ((itemTime(running.get(x.id) ?? {}) ?? 0) > 0) last = i; });
  if (last >= 0) return flat.slice(last + 1).find((x) => isSong(x) && !partOfCurrent(x)) ?? null;
  const ph = lastSnapshot?.playheadId;
  if (!ph) return null;
  const at = flat.findIndex((x) => x.id === ph);
  if (at >= 0) return flat.slice(at).find(isSong) ?? null;
  return flat.find((x) => isSong(x) && x.groupIds?.includes(ph)) ?? null;
}

// Everything a cue or to-do can be tied to, for the drawer's song picker:
// the songs (audio/video items) of the open cue list in show order, then
// anything playing or already referenced by a cue that isn't in that list
// (other cue lists, groups from before item anchoring).
function getTargets() {
  const out = new Map();
  const add = (t) => { if (!out.has(t.key)) out.set(t.key, t); };
  for (const x of workspaceItems()) {
    if (!SONG_TYPES.has(x.type)) continue;
    add({ key: `cue:${x.id}`, kind: 'item', cueId: x.id, cueName: x.name, label: x.name, sub: x.path.join(' › '), duration: x.duration });
  }
  const cur = currentTarget();
  if (cur) add({ key: cur.key, kind: 'item', cueId: cur.cueId, cueName: cur.cueName, label: cur.cueName, sub: cur.path.join(' › ') });
  for (const c of [...allCues(), ...allPrecues()]) {
    if (c.cueId) {
      const name = runningNames.get(c.cueId) ?? c.cueName;
      add({ key: c.target, kind: 'item', cueId: c.cueId, cueName: name, label: name, sub: 'not in the open cue list' });
    } else {
      add({ key: c.target, kind: 'group', groupPath: c.groupPath, groupId: c.groupId, label: c.groupPath.at(-1), sub: `${c.groupPath.slice(0, -1).join(' › ')} · whole group (older cues)` });
    }
  }
  return [...out.values()];
}

// Clocks for everything ticking in this snapshot: one per item, plus one per
// song group (for group-anchored cues). Only cues actually ticking count —
// QLab reports finished and queued children as 0/0, and those must freeze a
// clock, not restart it.
function updateSongClocks(snap) {
  const byGroup = new Map();
  const now = Date.now();
  activeTargets.clear();
  activeKeyByGroupId.clear();
  for (const c of snap.running ?? []) {
    runningNames.set(c.id, c.name);
    const path = c.groupPath ?? [];
    const gkey = path.length ? pathKey(path) : null;
    if (gkey) {
      knownPaths.set(gkey, path);
      const gid = Array.isArray(c.groupIds) && c.groupIds.length === path.length ? c.groupIds.at(-1) : null;
      if (gid) groupIdByPath.set(gkey, gid);
    }
    const t = itemTime(c);
    if (t === null) continue;
    tickClock(`cue:${c.id}`, t, now, { offset: c.preWait ?? 0, laneId: c.id, groupKey: gkey });
    if (gkey) {
      const g = byGroup.get(gkey) ?? [];
      g.push(c);
      byGroup.set(gkey, g);
    }
  }
  for (const [gkey, cues] of byGroup) {
    const key = `grp:${gkey}`;
    tickClock(key, computeShowTime(cues), now, { offset: 0, laneId: null, groupKey: gkey });
    const gid = groupIdByPath.get(gkey);
    if (gid) activeKeyByGroupId.set(gid, key);
  }
}
function tickClock(key, t, now, info) {
  activeTargets.set(key, info);
  let clock = targetClocks.get(key);
  if (!clock) { clock = new SongClock(); targetClocks.set(key, clock); }
  if (clock.update(key, t, now)) {
    // Restarted (or first sight): forget which of its custom cues faded.
    for (const k of [...customDismissed]) if (k.startsWith(`${key}|`)) customDismissed.delete(k);
  }
}

function startTimelineMode(channel) {
  document.getElementById('landing').hidden = true;
  document.getElementById('topbar').hidden = false;
  document.getElementById('timeline').hidden = false;

  timelineEls = {
    status:        document.getElementById('status'),
    ts:            document.getElementById('ts'),
    groupContext:  document.getElementById('group-context'),
    groupCurrent:  document.getElementById('group-current'),
    ruler:         document.getElementById('ruler'),
    lanes:         document.getElementById('lanes'),
    empty:         document.getElementById('empty'),
    playhead:      document.getElementById('playhead'),
    tc:            document.getElementById('tc'),
    tcText:        document.getElementById('tc-text'),
    tcOut:         document.getElementById('tc-out'),
    tcDevice:      document.getElementById('tc-device'),
    tcOffset:      document.getElementById('tc-offset'),
    tcFrames:      document.getElementById('tc-frames'),
    tcOffsetWrap:  document.getElementById('tc-offset-wrap'),
    stage:         document.getElementById('stage'),
    workspace:     document.getElementById('workspace'),
    wsList:        document.getElementById('ws-list'),
    wsToggle:      document.getElementById('ws-toggle'),
    wsFollow:      document.getElementById('ws-follow'),
    wsHeading:     document.getElementById('ws-heading'),
  };
  timelineEls.stage.hidden = false;

  timelineEls.tcOut.onclick = () => toggleLtcOutput();
  setupWorkspacePanel();
  setupOutputPicker();
  setupTimecodeOffset(channel);

  document.getElementById('back-btn').onclick = () => { location.href = '/'; };
  if (DEMO) {
    document.getElementById('back-btn').hidden = true;
    initDemoBar();
  }

  currentChannel = channel;
  loadFilters();
  updateFilterBadge();
  drawer = initDrawer({
    items,
    getTargets,
    getCurrentTarget: () => currentTarget()?.key ?? null,
    getStandbyTarget: () => { const s = standbyItem(); return s ? `cue:${s.id}` : null; },
    getTargetTime: targetTime,
    getAllCues: allCues,
    getAllPrecues: allPrecues,
    getFilters: () => filters,
    setFilters: saveFilters,
    getEditKey: () => findSession(currentChannel)?.editKey || '',
    setEditKey: (k) => setSessionEditKey(currentChannel, k),
    // Keep the workspace list's "open in drawer" highlight in step.
    onSelectionChange: () => renderWorkspace(),
  });
  const toggleDrawer = (tab) => () => {
    const panel = document.getElementById(tab === 'cues' ? 'panel-cues' : 'panel-filter');
    if (drawer.isOpen() && !panel.hidden) drawer.close(); else drawer.open(tab);
  };
  document.getElementById('cues-btn').onclick = toggleDrawer('cues');
  document.getElementById('filter-btn').onclick = toggleDrawer('filter');
  // One shared 10 Hz ticker for every custom lane (QLab lanes keep their
  // own, since they interpolate per-cue QLab counters).
  setInterval(tickCustom, 100);

  // Playhead overlay toggle — off by default because the line can drift
  // when QLab's per-cue clocks behave oddly at section/walkoff boundaries.
  // The CSS hides .playhead unless body has the .playhead-on class.
  const playheadBtn = document.getElementById('playhead-toggle');
  const PLAYHEAD_KEY = 'qlab-viewer.playhead';
  const playheadEnabled = localStorage.getItem(PLAYHEAD_KEY) === '1';
  document.body.classList.toggle('playhead-on', playheadEnabled);
  playheadBtn.setAttribute('aria-pressed', playheadEnabled ? 'true' : 'false');
  playheadBtn.onclick = () => {
    const on = !document.body.classList.contains('playhead-on');
    document.body.classList.toggle('playhead-on', on);
    playheadBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    try { localStorage.setItem(PLAYHEAD_KEY, on ? '1' : '0'); } catch {}
  };

  const session = findSession(channel);
  const password = session?.password || '';
  rememberSession(channel, password);
  loadDismissed(channel);
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

// MM:SS with leading zero on minutes — used for the head countdown so the
// column is a stable visual width whether time is 00:09 or 04:53.
function fmtCountdown(seconds) {
  if (!Number.isFinite(seconds)) return '--:--';
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
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
    this.cueReceivedAt = Date.now();
    this.maxTime = maxTime;
    this.isInstant = !((cue.duration ?? 0) > 0);
    this._lastE = 0;          // monotonic clamp on action elapsed
    this._lastPre = 0;        // monotonic clamp on preWait elapsed
    // High-water marks for own counters — QLab will sometimes reset these
    // back to 0 after a cue finishes (especially fades & memos held in the
    // running list by their parent group). Latching the peak lets us still
    // recognize "this cue has fired" on subsequent snapshots.
    this._maxPre = cue.preWaitElapsed ?? 0;
    this._maxE = cue.elapsed ?? 0;
    this._scheduledFade = false;
    this.build();
    this.applyPositioning();
    this.update();           // synchronous first paint
    this.tickerId = setInterval(() => this.update(), 100);
  }

  build() {
    const lane = document.createElement('div');
    lane.className = 'lane' + (this.isInstant ? ' instant' : ' timed');

    // Head: icon + countdown (MM:SS). The cue NAME has moved to the track,
    // anchored at the cue point — the head just answers "how soon?" so the
    // operator can scan the left column for the next thing about to happen.
    const head = document.createElement('div');
    head.className = 'lane-head';
    const icon = document.createElement('span');
    icon.className = 'lane-icon';
    icon.textContent = TYPE_ICON[this.cue.type] ?? '•';
    icon.style.color = TYPE_COLOR[this.cue.type] ?? '#fff';
    const countdown = document.createElement('span');
    countdown.className = 'lane-countdown';
    countdown.textContent = '--:--';
    head.append(icon, countdown);
    this.countdownEl = countdown;

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

    // Cue name — anchored to the cue's own position on the timeline so the
    // operator's eye finds it AT the bullet/bar rather than off to one side.
    // Number (Qxx) tucked after it when QLab has one. A time span lives
    // inside this wrap too, hidden by default; it's only revealed when the
    // cue sits at an edge and the separate inline countdown wouldn't fit on
    // the opposite side of the bullet — CSS order flips its position so it
    // ends up between name and bullet.
    const nameWrap = document.createElement('div');
    nameWrap.className = 'lane-name-at-point';
    const timeEdge = document.createElement('span');
    timeEdge.className = 'lane-time-edge';
    const name = document.createElement('span');
    name.className = 'lane-name';
    name.textContent = this.cue.name;
    const numEl = document.createElement('span');
    numEl.className = 'lane-num';
    numEl.textContent = this.cue.number ? ` Q${this.cue.number}` : '';
    nameWrap.append(timeEdge, name, numEl);
    track.appendChild(nameWrap);
    this.timeEdgeEl = timeEdge;

    // Inline countdown — same MM:SS as the head, but anchored to the cue
    // point on the OPPOSITE side of the name. For a left-side cue that
    // reads "02:29 ○ Something Happens" the countdown is right of the head
    // and just left of the bullet; for a right-side cue it flips to the
    // other side. Saves the operator from having to scan back to the head
    // when their eye is already on the cue.
    const timeInline = document.createElement('div');
    timeInline.className = 'lane-time-inline';
    track.appendChild(timeInline);
    this.timeInlineEl = timeInline;

    lane.append(head, track);

    this.el = lane;
    this.headEl = head;
    this.trackEl = track;
    this.timeEl = countdown;  // setText writes the head countdown now
  }

  // Apply the time-axis position (bar/flag left%, bar width%). Called on
  // create and whenever the global maxTime changes.
  applyPositioning() {
    const preWait = this.cue.preWait ?? 0;
    const leftPct = this.maxTime > 0 ? (preWait / this.maxTime) * 100 : 0;
    // Shared anchor — bar, flag, AND the time label all read this var so the
    // countdown/elapsed text sticks to the cue point as the layout changes.
    this.trackEl.style.setProperty('--cue-left', `${leftPct}%`);
    // Flip the name label to anchor at the cue's RIGHT (i.e. extending left)
    // when the cue point is in the right half of the timeline. Otherwise the
    // long file names overflow past the viewport. We don't flip until the
    // cue is well into the right side so labels on the left stay un-flipped
    // even at narrow viewport widths.
    this.el.classList.toggle('right-anchored', leftPct > 55);
    // When the cue is anchored at (or very near) the left edge of the
    // timeline, the inline countdown sits right next to the head countdown
    // and just visually duplicates it. Hide it in that case — the head
    // countdown is already adjacent to the bar's start, so the operator
    // doesn't need a second number 30 pixels away.
    this.el.classList.toggle('cue-near-head', leftPct < 4);
    // Same problem at the OPPOSITE end: when the cue sits at the right edge
    // of the timeline, the inline countdown anchored to the right of the
    // bullet (the right-anchored placement) overflows past the viewport.
    // We mark the lane so CSS can fold the time into the name element on
    // the SAME side as the name (between name and bullet) instead.
    this.el.classList.toggle('cue-near-end', leftPct > 92);
    if (this.isInstant) {
      this.flagEl.style.left = `${leftPct}%`;
    } else {
      this.barEl.style.left  = `${leftPct}%`;
      this.barEl.style.width = this.maxTime > 0
        ? `${(this.cue.duration / this.maxTime) * 100}%`
        : '0%';
    }
  }

  // Returns true when the cue switched between instant and timed (its
  // duration arrived on a later poll): the track DOM differs, so the caller
  // rebuilds the lane.
  setCue(cue) {
    if (!((cue.duration ?? 0) > 0) !== this.isInstant) return true;
    // Cheap text refresh — DOM stays. Position changes only happen when
    // the cue itself genuinely moved (rare), or maxTime changed.
    const positionChanged =
      (cue.preWait ?? 0) !== (this.cue.preWait ?? 0)
      || (cue.duration ?? 0) !== (this.cue.duration ?? 0);
    // Reset monotonic-clamp baselines AND the high-water marks if the cue
    // genuinely restarted (elapsed dropped meaningfully). That's the only
    // legitimate reason for a regression — otherwise we trust the peak we
    // saw, since QLab may zero the counters after the cue finishes.
    const restarted = (cue.elapsed ?? 0) < this._lastE - 1 || (cue.preWaitElapsed ?? 0) < this._lastPre - 1;
    if ((cue.elapsed ?? 0) < this._lastE - 1)        { this._lastE = 0;   this._maxE = 0; }
    if ((cue.preWaitElapsed ?? 0) < this._lastPre - 1) { this._lastPre = 0; this._maxPre = 0; }
    // A restart cancels a pending post-fire fade — otherwise that timer hides
    // the freshly restarted cue 1.2 s later.
    if (restarted) { clearTimeout(this._fadeTimer); this._scheduledFade = false; }
    this._maxE = Math.max(this._maxE, cue.elapsed ?? 0);
    this._maxPre = Math.max(this._maxPre, cue.preWaitElapsed ?? 0);
    this.cue = cue;
    // Set timestamp AFTER assigning cue so the next tick reads matching pair.
    this.cueReceivedAt = Date.now();
    if (positionChanged) this.applyPositioning();
    return false;
  }

  setMaxTime(maxTime) {
    if (maxTime === this.maxTime) return;
    this.maxTime = maxTime;
    this.applyPositioning();
  }

  // 10 Hz: refresh text/fill/glow based on live interpolation. Numbers stay
  // on the same DOM nodes so they don't flicker across snapshots. We use a
  // per-lane snapshot timestamp + monotonic clamp so values never rewind
  // when a fresh snapshot arrives with a slightly-lagging elapsed value.
  update() {
    const cue = this.cue;
    const preWait = cue.preWait ?? 0;
    const duration = cue.duration ?? 0;
    // Never project more than a few polls past the last value received. The
    // bridge's 1 s heartbeat resends a paused show's frozen values, which
    // would otherwise let the projection run up to a second ahead of QLab
    // and saw-tooth; and with the relay down nothing arrives at all.
    const delta = Math.min(MAX_EXTRAPOLATE_S, (Date.now() - this.cueReceivedAt) / 1000);

    // Refresh-safe done-check: a cue is "passed" when its own counters say so,
    // OR when the high-water marks we've seen for this lane already crossed
    // the end. The latter catches QLab resetting preWaitElapsed/elapsed to 0
    // after a fade/memo finishes (it keeps the cue in the running list with
    // a fresh-looking clock, so per-snapshot evidence alone misses it).
    const peakPwE = Math.max(this._maxPre, cue.preWaitElapsed ?? 0);
    const peakE = Math.max(this._maxE, cue.elapsed ?? 0);
    const end = preWait + duration;
    const peakReachedEnd = end > 0 && peakPwE + peakE + 0.25 >= end;
    if (cueIsPassed(cue) || peakReachedEnd) {
      this.setStatus('fired');
      this.setText('--:--');
      this.scheduleFadeIfFired();
      return;
    }

    // Queued state — the cue is in the running list but no own counter has
    // started yet AND we've never seen one tick for it. This is the sibling
    // of an actively-playing cue in a "do not continue" group: visible for
    // context, dimmed so the eye lands on what's actually firing. As soon
    // as the cue's pwE or elapsed leaves zero we fall through to the
    // pre-wait / playing / instant-fired branches.
    const everActive = this._maxPre > 0 || this._maxE > 0;
    const pwENow = cue.preWaitElapsed ?? 0;
    const eNow = cue.elapsed ?? 0;
    if (!everActive && pwENow === 0 && eNow === 0) {
      if (this.isInstant) this.flagEl.style.setProperty('--countdown', '0');
      if (this.fillEl) this.fillEl.style.width = '0%';
      this.setStatus('queued');
      this.setText(fmtCountdown(preWait + duration));
      return;
    }

    // Pre-wait state — applies to BOTH instant and timed cues with a
    // pre-wait. Show a countdown instead of misleading "playing" UI.
    if (preWait > 0) {
      const raw = Math.min(preWait, (cue.preWaitElapsed ?? 0) + delta);
      const preE = Math.max(this._lastPre, raw);
      this._lastPre = preE;
      const remaining = preWait - preE;
      if (remaining > 0) {
        if (this.isInstant) {
          this.flagEl.style.setProperty('--countdown', (preE / preWait).toFixed(3));
        }
        this.setStatus('waiting');
        this.setText(fmtCountdown(remaining));
        return;
      }
      // Pre-wait just elapsed — fall through.
      if (this.isInstant) {
        this.flagEl.style.setProperty('--countdown', '1');
      }
    }

    // Post-preWait state for instant cues — already fired, schedule fadeout.
    if (this.isInstant) {
      this.setStatus('fired');
      this.setText('--:--');
      this.scheduleFadeIfFired();
      return;
    }

    // Timed cue, action is playing or done — monotonic clamp.
    const rawE = Math.min(duration, (cue.elapsed ?? 0) + delta);
    const e = Math.max(this._lastE, rawE);
    this._lastE = e;
    const done = duration > 0 && e >= duration;
    if (this.fillEl) {
      const pct = duration > 0 ? (e / duration) * 100 : 0;
      this.fillEl.style.width = `${Math.min(100, pct)}%`;
    }
    this.setStatus(done ? 'fired' : 'playing');
    // Head shows time-remaining (down-counter) so the operator sees "how much
    // longer is this cue running?" — most useful read while a long video plays.
    this.setText(done ? '--:--' : fmtCountdown(duration - e));
    if (done) this.scheduleFadeIfFired();
  }

  // Once a cue is fired we wait a short grace period (so the operator sees
  // it just happened) then fade the lane away. QLab often keeps fired cues
  // in /runningOrPausedCues for the rest of the parent group — without
  // this, they'd linger forever as dim grey rows.
  scheduleFadeIfFired() {
    if (this._scheduledFade) return;
    this._scheduledFade = true;
    this._fadeTimer = setTimeout(() => {
      // Superseded (stopped and re-GO'd: a new Lane owns this id now) or
      // already removed — must not touch the map.
      if (lanesById.get(this.cue.id) !== this) return;
      const fadeMs = computeFadeMs(lastSnapshot?.running ?? []);
      // Mark the id as dismissed so we don't recreate the lane next snapshot.
      dismissedIds.add(this.cue.id);
      saveDismissed();
      lanesById.delete(this.cue.id);
      this.fadeOut(fadeMs);
    }, 1200);
  }

  // Only touch class names / text when they actually change — keeps the
  // DOM mutation observer / CSS transitions calm.
  setStatus(s) {
    if (this._status === s) return;
    this._status = s;
    this.el.classList.toggle('queued',  s === 'queued');
    this.el.classList.toggle('waiting', s === 'waiting');
    this.el.classList.toggle('playing', s === 'playing');
    this.el.classList.toggle('fired',   s === 'fired');
  }
  setText(t) {
    if (this._lastText === t) return;
    this._lastText = t;
    if (this.timeInlineEl) this.timeInlineEl.textContent = t;
    if (this.timeEdgeEl) this.timeEdgeEl.textContent = t;
    this.timeEl.textContent = t;
  }

  fadeOut(durationMs) {
    clearTimeout(this._fadeTimer);
    clearInterval(this.tickerId);
    this.tickerId = null;
    this.el.style.setProperty('--fade-ms', `${durationMs}ms`);
    // Move to the bottom of the lanes container before collapsing — running
    // cues keep their positions and only the gap this lane leaves behind
    // closes (at the bottom of the list), rather than pulling later lanes up.
    this.el.parentElement?.appendChild(this.el);
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
  timelineEls.ts.textContent = snap.ts ? new Date(snap.ts).toLocaleTimeString() : '';
  // mode comes from the bridge: "running" = something is actually firing in
  // QLab; "preview" = nothing is firing and the cues we're showing are the
  // playhead's queued children. Reflect that in the topbar status pill and
  // on the root element so CSS can dim the active-state visuals further.
  const mode = snap.mode || 'running';
  setStatus(mode === 'preview' ? 'ready' : 'live', 'connected');
  document.body.classList.toggle('mode-preview', mode === 'preview');

  // Show every cue the bridge gives us — including queued siblings that
  // haven't fired yet. They render in a dimmed "queued" state so the
  // operator sees what's next in the section without it competing with
  // whatever's currently playing. The bridge already de-dupes by uniqueID,
  // so each cue appears once with its deepest groupPath.
  const rawRunning = snap.running ?? [];

  // Hide already-played cues, judged from two angles:
  //
  // 1. Same-group siblings: within ONE groupPath, the cue currently firing
  //    is the latest-indexed one with non-zero counters. Earlier siblings
  //    have already played and QLab reset their counters to 0, so drop them.
  // 2. Played-upstream groups: a group that has NO active cues AND whose
  //    own cues sit before the latest-active cue anywhere in the flat list
  //    already finished and was advanced past — drop the whole group. This
  //    is the PSYCHO-subgroup case: its files are at a different groupPath
  //    than the SHOW 4 single song that's now playing, so the same-group
  //    filter alone leaves them lingering. Two parallel groups that BOTH
  //    have active cues both stay visible (each filtered by its own
  //    same-group rule).
  let latestActiveIdx = -1;
  const lastActiveIdxByGroup = new Map();
  const groupHasActive = new Set();
  rawRunning.forEach((cue, idx) => {
    const active = (cue.preWaitElapsed ?? 0) > 0 || (cue.elapsed ?? 0) > 0;
    if (!active) return;
    if (idx > latestActiveIdx) latestActiveIdx = idx;
    const key = (cue.groupPath ?? []).join(' ');
    lastActiveIdxByGroup.set(key, idx);
    groupHasActive.add(key);
  });
  const running = rawRunning.filter((cue, idx) => {
    // Anything actively firing is always kept — multiple siblings can be
    // running simultaneously (HEART GOES DOWN + HEART TO ROOF mid-fire) and
    // dropping the earlier-indexed one just because a later sibling is also
    // active was the bug.
    const active = (cue.preWaitElapsed ?? 0) > 0 || (cue.elapsed ?? 0) > 0;
    if (active) return true;
    const key = (cue.groupPath ?? []).join(' ');
    if (groupHasActive.has(key)) {
      // Queued cue inside an active group: keep if it's after the latest
      // active sibling (still upcoming); drop if it's before (already played).
      return idx > lastActiveIdxByGroup.get(key);
    }
    // No active cues in this group at all. Hide it if its cues sit upstream
    // of where the show currently is; keep them visible if downstream
    // (queued sections that haven't been reached yet).
    return latestActiveIdx < 0 || idx > latestActiveIdx;
  });
  const shared = commonPathPrefix(running.map((c) => c.groupPath ?? []));
  const path = shared.length ? shared : (snap.groupPath ?? []);
  const current = path.at(-1) || '';
  const context = path.slice(0, -1).join(' › ');
  timelineEls.groupContext.textContent = context;
  timelineEls.groupCurrent.textContent = current;
  timelineEls.groupContext.hidden = !context;
  timelineEls.groupCurrent.hidden = !current;

  // ── Show-time tracking ──────────────────────────────────────────────────
  prevShowTime = currentShowTime;
  currentShowTime = computeShowTime(running);
  // render() also runs on resize / item edits; only a NEW snapshot says
  // anything about whether the show clock is moving.
  if (snap !== lastRenderedSnap) {
    lastRenderedSnap = snap;
    showTimeAdvancing = currentShowTime > prevShowTime + 1e-3;
    if (currentShowTime + 2 < prevShowTime) playheadShown = currentShowTime;
  }
  currentGroupClock = (typeof snap.groupClock === 'number') ? snap.groupClock : null;
  // QLab restarted the song — drop our dismissal memory so cues reappear.
  if (currentShowTime + 2 < prevShowTime) { dismissedIds.clear(); saveDismissed(); }


  // Per-mother-group show clock: max own-progress of cues that share a
  // groupPath. Used for the lane-creation refresh check — a fired memo's
  // siblings tell us "the group is past this cue" even when QLab reset the
  // memo's own preWaitElapsed to 0. Parallel songs at the SAME level
  // (e.g. PSYCHO playing while FiveMoreHours is queued at SHOW 4) don't
  // count against each other because they have different groupPaths.
  const groupClock = new Map();
  for (const cue of running) {
    const key = (cue.groupPath ?? []).join(' ');
    const own = Math.min(cue.preWait ?? 0, cue.preWaitElapsed ?? 0) + (cue.elapsed ?? 0);
    if (own > (groupClock.get(key) ?? 0)) groupClock.set(key, own);
  }

  // ── Custom cues for the songs that are running ─────────────────────────
  const customs = allCues().filter((c) => activeKeyFor(c) && passesFilter(c, filters));
  const offsetOf = (c) => activeTargets.get(activeKeyFor(c))?.offset ?? 0;
  // QLab lanes can be hidden by the viewer's own filter; show time and the
  // song clocks still come from the full list.
  const laneRunning = filters.qlab ? running : [];

  // ── Lanes (incremental) ─────────────────────────────────────────────────
  const endTime = (c) => (c.preWait ?? 0) + (c.duration ?? 0);
  const maxTime = Math.max(0, ...laneRunning.map(endTime), ...customs.map((c) => offsetOf(c) + cueEnd(c)));

  if (maxTime !== currentMaxTime) {
    currentMaxTime = maxTime;
    drawRuler(maxTime);
    for (const lane of lanesById.values()) lane.setMaxTime(maxTime);
  }

  // Playhead overlay — a vertical line at the song clock's current position
  // on the same time axis as the bars/flags. Hidden when nothing's actually
  // ticking (preview mode, idle, or before any cue has accumulated progress).
  const playheadActive = mode !== 'preview' && currentMaxTime > 0 &&
    ((currentGroupClock != null && currentGroupClock > 0)
      || currentShowTime > 0);
  timelineEls.playhead.hidden = !playheadActive;
  // Clip the playhead so it only spans the ACTIVE section of the lane list
  // and stops before the queued cues below. We measure where the first
  // queued lane begins and set the playhead's `bottom` to clip it there;
  // when there's no queue we span to the end of the active block.
  const firstQueued = timelineEls.lanes.querySelector('.lane.queued');
  let playheadBottom = 'auto';
  let playheadHeight = '0px';
  const timelineEl = document.getElementById('timeline');
  if (firstQueued && timelineEl) {
    const tRect = timelineEl.getBoundingClientRect();
    const qRect = firstQueued.getBoundingClientRect();
    playheadBottom = Math.max(0, tRect.bottom - qRect.top) + 'px';
  } else {
    // No queued lanes — let the playhead span to the bottom of the active
    // block (last lane's bottom edge). Falling back to the timeline bottom
    // looks fine here since lanes fill the area.
    const lastLane = timelineEls.lanes.querySelector('.lane:last-child');
    if (lastLane && timelineEl) {
      const tRect = timelineEl.getBoundingClientRect();
      const lRect = lastLane.getBoundingClientRect();
      playheadBottom = Math.max(0, tRect.bottom - lRect.bottom) + 'px';
    } else {
      playheadBottom = '0';
    }
  }
  timelineEls.playhead.style.bottom = playheadBottom;
  // Initial position now; the 10Hz interpolator below keeps it moving
  // between snapshots so it stays in sync with the bar-fill animations.
  if (playheadActive) updatePlayheadPosition();

  const newIds = new Set(laneRunning.map((c) => c.id));
  const fadeMs = computeFadeMs(running);

  // Clean dismissedIds for cues that left running (so re-fires work later).
  let dismissedChanged = false;
  for (const id of dismissedIds) {
    if (!newIds.has(id)) { dismissedIds.delete(id); dismissedChanged = true; }
  }
  if (dismissedChanged) saveDismissed();

  // Remove lanes for cues that left running — animated. Already-dismissed
  // lanes are not in lanesById anymore so this naturally skips them.
  for (const [id, lane] of lanesById) {
    if (!newIds.has(id)) {
      lane.fadeOut(fadeMs);
      lanesById.delete(id);
    }
  }

  // Add new lanes / update existing ones in place.
  for (const cue of laneRunning) {
    if (dismissedIds.has(cue.id)) continue;
    // Refresh-safe: skip cues whose own counters say they've already crossed
    // their end window, OR (only at lane *creation*) whose direct siblings
    // already advanced past it. The sibling fallback catches memos QLab
    // keeps in the running list with `preWaitElapsed` reset to 0 after they
    // fired. Scoped to mother group only — a parallel song at the same level
    // can't dismiss a queued sibling because they have different groupPaths.
    const existing = lanesById.get(cue.id);
    const end = (cue.preWait ?? 0) + (cue.duration ?? 0);
    const sibClock = groupClock.get((cue.groupPath ?? []).join(' ')) ?? 0;
    const siblingsPast = end > 0 && end + 0.25 < sibClock;
    // An existing lane whose cue now reports 0/0 while its siblings are past
    // its end has finished — typically during a relay outage, so the lane
    // never saw it fire. Applying 0/0 to it would read as a restart and
    // bring it back as "queued"; retire it instead.
    const zeroed = !((cue.preWaitElapsed ?? 0) > 0) && !((cue.elapsed ?? 0) > 0);
    if (cueIsPassed(cue) || ((!existing || zeroed) && siblingsPast)) {
      dismissedIds.add(cue.id);
      saveDismissed();
      if (existing) { lanesById.delete(cue.id); existing.fadeOut(fadeMs); }
      continue;
    }
    if (!existing) {
      const lane = new Lane(cue, maxTime);
      lanesById.set(cue.id, lane);
      timelineEls.lanes.appendChild(lane.el);
    } else if (existing.setCue(cue)) {
      // Instant ↔ timed: swap in a freshly built lane at the same spot.
      const fresh = new Lane(cue, maxTime);
      existing.el.replaceWith(fresh.el);
      clearInterval(existing.tickerId);
      clearTimeout(existing._fadeTimer);
      lanesById.set(cue.id, fresh);
    }
  }

  syncCustomLanes(customs, maxTime, fadeMs);

  // Keep DOM order matching QLab's source order, with custom cues slotted in
  // before the first QLab cue (of the same song) that starts after them.
  // appendChild moves existing elements without rebuilding them. Lanes
  // fading away are skipped.
  // Item-anchored cues go directly under their song's own lane, in time
  // order; group-anchored ones before the first QLab cue of their group that
  // starts after them.
  const pending = [...customLanes.values()]
    .filter((l) => !l.el.classList.contains('removing'))
    .sort((a, b) => a.cue.at - b.cue.at);
  const take = (pred) => {
    for (let i = 0; i < pending.length; i++) {
      if (pred(pending[i].cue)) { timelineEls.lanes.appendChild(pending[i].el); pending.splice(i--, 1); }
    }
  };
  for (const cue of laneRunning) {
    const lane = lanesById.get(cue.id);
    if (!lane || lane.el.classList.contains('removing')) continue;
    const gkey = `grp:${pathKey(cue.groupPath ?? [])}`;
    take((c) => !c.cueId && activeKeyFor(c) === gkey && c.at < (cue.preWait ?? 0));
    timelineEls.lanes.appendChild(lane.el);
    take((c) => c.cueId === cue.id);
  }
  for (const cl of pending) timelineEls.lanes.appendChild(cl.el);

  timelineEls.empty.hidden = lanesById.size + customLanes.size > 0;
  renderStandby();
}

function syncCustomLanes(customs, maxTime, fadeMs) {
  const keep = new Set();
  for (const cue of customs) {
    const key = activeKeyFor(cue);
    const t = targetTime(key);
    const offset = activeTargets.get(key)?.offset ?? 0;
    const dkey = `${key}|${cue.id}@${cue.at}`;
    if (t === null || customDismissed.has(dkey)) continue;
    let lane = customLanes.get(cue.id);
    // Refresh-safe like QLab lanes: never create a lane for a cue whose
    // window is already behind its song clock.
    if (!lane && cueState(cue, t).phase === 'passed') { customDismissed.add(dkey); continue; }
    if (lane && lane.setCue(cue)) {
      lane.el.remove();
      customLanes.delete(cue.id);
      lane = null;
    }
    if (!lane) {
      lane = new CustomLane(cue, maxTime, { onClick: (id) => drawer?.editCue(id), offset });
      customLanes.set(cue.id, lane);
      timelineEls.lanes.appendChild(lane.el);
    } else {
      lane.setLayout(maxTime, offset);
    }
    lane.update(t);
    keep.add(cue.id);
  }
  for (const [id, lane] of customLanes) {
    if (!keep.has(id)) { lane.fadeOut(fadeMs); customLanes.delete(id); }
  }
}

// 10 Hz: advance custom lanes on their song's clock; fade passed ones after
// the same 1.2 s grace QLab lanes get.
function tickCustom() {
  for (const [id, lane] of customLanes) {
    const key = activeKeyFor(lane.cue);
    const t = targetTime(key);
    if (t === null) continue;
    if (lane.update(t) === 'passed' && !lane._fadeScheduled) {
      lane._fadeScheduled = true;
      setTimeout(() => {
        if (customLanes.get(id) !== lane) return;
        customDismissed.add(`${key}|${id}@${lane.cue.at}`);
        customLanes.delete(id);
        lane.fadeOut(computeFadeMs(lastSnapshot?.running ?? []));
      }, 1200);
    }
  }
  drawer?.tick();
}

// ─── Standby card: to-dos for the song that's next up ────────────────────────
//
// Pre-cues are reminders for BEFORE a song (swap a mic, check the haze). They
// show while their song is next: the first song after the one playing, or
// the playhead's when nothing plays. Once the song starts, the card moves on.
// Ticking one off is saved for everyone (shared to-dos need the editor
// password, like any shared edit).
let standbyKey = '';
function renderStandby() {
  const el = document.getElementById('standby');
  if (!el) return;
  const next = standbyItem();
  const todos = next
    ? allPrecues().filter((p) => p.cueId === next.id && passesFilter(p, filters))
    : [];
  const sig = JSON.stringify([next?.id, next?.name, todos.map((t) => [t.id, t.text, t.done, t.dept, t.visibility]), items.canEditShared]);
  if (sig === standbyKey) return;
  standbyKey = sig;
  el.hidden = !next;
  if (!next) { syncStandbyOffset(); return; }

  const head = document.createElement('div');
  head.className = 'standby-head';
  const label = document.createElement('span');
  label.className = 'standby-label';
  label.textContent = 'Next up';
  const name = document.createElement('span');
  name.className = 'standby-name';
  name.textContent = next.name;
  const ctx = document.createElement('span');
  ctx.className = 'standby-ctx';
  ctx.textContent = next.path.join(' › ');
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'standby-add';
  add.textContent = todos.length ? `${todos.filter((t) => t.done).length}/${todos.length} done · edit` : '+ to-do';
  add.onclick = () => drawer?.openTarget(`cue:${next.id}`, { focusTodo: true });
  head.append(label, name, ctx, add);

  const list = document.createElement('ul');
  list.className = 'standby-todos';
  for (const t of todos) {
    const li = document.createElement('li');
    li.className = `standby-todo${t.done ? ' done' : ''} ${t.visibility}`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = `todo-${t.id}`;
    cb.checked = t.done;
    const canTick = t.visibility === 'private' ? t.mine : items.canEditShared;
    cb.disabled = !canTick;
    if (!canTick) cb.title = 'Shared to-do: unlock with the editor password to tick it off';
    cb.onchange = async () => {
      const raw = items.items.get(t.id);
      if (!raw) return;
      const res = await items.upsert({ id: t.id, visibility: raw.visibility, data: { ...raw.data, done: cb.checked } });
      if (!res.ok) cb.checked = !cb.checked;
    };
    const text = document.createElement('label');
    text.htmlFor = cb.id;
    text.textContent = t.text;
    li.append(cb, text);
    if (t.dept) {
      const d = document.createElement('span');
      d.className = 'custom-dept';
      d.textContent = t.dept;
      li.appendChild(d);
    }
    if (t.visibility === 'private') {
      const p = document.createElement('span');
      p.className = 'standby-private';
      p.textContent = '◆ only you';
      li.appendChild(p);
    }
    list.appendChild(li);
  }
  el.replaceChildren(head, ...(todos.length ? [list] : []));
  syncStandbyOffset();
}
// The playhead line is positioned inside the timeline; keep it below the card.
function syncStandbyOffset() {
  const el = document.getElementById('standby');
  const h = el && !el.hidden ? el.offsetHeight : 0;
  document.getElementById('timeline')?.style.setProperty('--standby-h', `${h}px`);
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Is `prefix` an initial segment of `path`? Used to include cues nested in
// subgroups under the current "song" — e.g. when SHORT BLACK has a WALKOFF
// subgroup, both SHORT BLACK's direct children AND the WALKOFF children
// should be on the timeline.
// Longest path prefix shared by every supplied path. With one group running,
// this is the group's path; with two parallel groups, it collapses up to
// their common ancestor (e.g. SHOW 1 - MEDUSA when SHORT BLACK and LONG
// BLACK both fire). Used purely as breadcrumb context — we don't filter
// cues by it, so subgroup nesting passes through unchanged.
function commonPathPrefix(paths) {
  if (!paths.length) return [];
  let min = paths[0];
  for (const p of paths) if (p.length < min.length) min = p;
  const out = [];
  for (let i = 0; i < min.length; i++) {
    const v = min[i];
    if (paths.every((p) => p[i] === v)) out.push(v); else break;
  }
  return out;
}


// Derive show time from any running cue. Each cue's position on the song
// timeline is the right edge of its bar-fill:
//   • Action hasn't started (elapsed === 0): use the cue's interpolated
//     pre-wait progress (preWaitElapsed, capped at preWait).
//   • Action has started (elapsed > 0): use preWait + elapsed. We DON'T use
//     preWaitElapsed once the action is firing — some QLab cues reset
//     preWaitElapsed back to 0 at the pre-wait/action boundary (the walkoff
//     videos are the canonical case), which would otherwise drop the song
//     time from `preWait` (e.g. 485) to `elapsed` (e.g. 2) right when the
//     cue fires, snapping the playhead backwards.
// The MAX across all cues approximates "how far along the song is".
function computeShowTime(running) {
  let t = 0;
  for (const c of running) {
    const pw = c.preWait ?? 0;
    const e = c.elapsed ?? 0;
    const pwE = Math.min(pw, c.preWaitElapsed ?? 0);
    const cueT = e > 0 ? pw + e : pwE + e;
    if (cueT > t) t = cueT;
  }
  return t;
}

// A cue has "passed" once ITS OWN counters report it past its end window.
// We deliberately don't compare against a cross-cue show clock here: when one
// long lane (say an 8-minute backing track) is running, that lane's elapsed
// dominates the global max — and any newly-added short cue would be marked
// "passed" before it ever ticks, fading out the moment it appears.
function cueIsPassed(cue) {
  const end = (cue.preWait ?? 0) + (cue.duration ?? 0);
  if (end <= 0) return false;
  const own = (cue.preWaitElapsed ?? 0) + (cue.elapsed ?? 0);
  return own + 0.25 >= end;
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
  let openFired = false;

  const u = new URL(RELAY_URL);
  u.searchParams.set('channel', channel);
  u.searchParams.set('role', 'subscriber');
  if (password) u.searchParams.set('token', password);

  setStatus('connecting…', 'disconnected');
  ws = DEMO ? new DemoSocket() : new WebSocket(u.toString());
  items.attach(ws, { editKey: findSession(channel)?.editKey || '' });

  ws.addEventListener('open', () => {
    openFired = true;
    setStatus('live', 'connected');
    retry = 1000;
  });
  ws.addEventListener('message', (e) => {
    firstMessageReceived = true;
    try {
      const msg = JSON.parse(e.data);
      if (items.handle(msg)) return;      // custom-cue protocol message

      // Two kinds of message share the channel. A structure message carries no
      // running state, so it must not be mistaken for a snapshot — doing so
      // would blank the timeline every time the workspace was re-sent.
      if (msg.workspace) {
        workspaceTree = msg.workspace;
        if (msg.currentListId) currentListId = msg.currentListId;
        renderWorkspace();
        renderStandby();
        drawer?.refresh();
        return;
      }

      const snap = msg;
      if (snap.currentListId) currentListId = snap.currentListId;
      lastSnapshot = snap;
      lastSnapshotRxAt = Date.now();
      updateSongClocks(snap);
      latchTimecode(snap.timecode);
      if (snap.ts) {
        const delta = Date.now() - snap.ts;
        // Clock skew between the two machines makes this nonsense often enough
        // that anything implausible is simply discarded rather than shown.
        if (delta >= 0 && delta < 5000) {
          measuredLatencyMs = measuredLatencyMs == null
            ? delta
            : measuredLatencyMs * 0.8 + delta * 0.2;
        }
      }
      render();   // render now does per-lane setCue, which stamps cueReceivedAt
      renderWorkspace();
      drawer?.refresh();
    } catch (err) { console.warn('bad payload', err); }
  });
  ws.addEventListener('close', (ev) => {
    // Auth bounce ONLY if the WS upgrade itself never completed — the relay
    // writes "HTTP/1.1 401" and closes the socket before sending the upgrade
    // response, so `open` never fires. If `open` did fire and we just
    // haven't received a snapshot yet (idle channel, bridge offline, blip),
    // treat it as a normal disconnect and let the retry loop handle it
    // instead of sending the user back to the password page.
    //
    // A relay that's down ALSO never fires `open` — so before sending anyone
    // to the password page, check the relay answers HTTP at all. no-cors: we
    // only care whether the host is reachable, and /health sends no CORS
    // headers.
    if (!openFired && ev.code === 1006) {
      const health = new URL('/health', RELAY_URL.replace(/^ws/, 'http'));
      fetch(health, { mode: 'no-cors', cache: 'no-store' }).then(
        () => {
          location.href = `/?prefill=${encodeURIComponent(currentChannel)}&pwfail=${currentPassword ? 1 : 0}`;
        },
        () => {
          setStatus('relay unreachable — retrying…', 'disconnected');
          setTimeout(() => connect(currentChannel, currentPassword), retry);
          retry = Math.min(retry * 2, 3000);
        },
      );
      return;
    }
    setStatus('reconnecting…', 'disconnected');
    setTimeout(() => connect(currentChannel, currentPassword), retry);
    retry = Math.min(retry * 2, 3000);   // live show: never more than 3 s blind
  });
  ws.addEventListener('error', () => ws.close());
}

window.addEventListener('resize', () => render());

// 10 Hz playhead interpolator — extrapolates `currentShowTime` based on
// wall-clock time since the last snapshot so the line glides smoothly
// instead of stepping at the 4 Hz snapshot rate (which made it visibly
// lag the bar-fill animations updating from the per-lane tickers).
function updatePlayheadPosition() {
  if (!timelineEls || !lastSnapshot) return;
  if (timelineEls.playhead.hidden) return;
  if (!(currentMaxTime > 0)) return;
  const delta = lastSnapshotRxAt && showTimeAdvancing
    ? Math.min(MAX_EXTRAPOLATE_S, (Date.now() - lastSnapshotRxAt) / 1000)
    : 0;
  // Prefer the bridge's group clock when QLab actually populates it
  // (currently 0 for groups). Otherwise use the per-snapshot showtime —
  // that already uses (preWait + elapsed) for any cue mid-action, which
  // handles the walkoff pre-wait/action boundary correctly without
  // needing a monotonic peak-tracker.
  const base = (currentGroupClock != null && currentGroupClock > 0)
    ? currentGroupClock
    : currentShowTime;
  const raw = Math.min(currentMaxTime, base + delta);
  // Monotonic, except a jump back of more than 2 s (restart / new song).
  playheadShown = raw < playheadShown - 2 ? raw : Math.max(playheadShown, raw);
  const t = Math.min(currentMaxTime, playheadShown);
  const pct = t / currentMaxTime;
  timelineEls.playhead.style.setProperty('--playhead', pct.toString());
}
playheadTickerId = setInterval(updatePlayheadPosition, 100);

// ─── timecode ────────────────────────────────────────────────────────────────
//
// The bridge sends the timecode decoded from the LTC on the show's audio, but
// only as often as it polls. Between snapshots we advance it from the local
// clock — timecode is a pure function of elapsed time, so this drifts by
// nothing more than the interval itself and resyncs on every snapshot.

function latchTimecode(tc) {
  if (!tc || !tc.text) { tcLatch = null; return; }
  const parsed = parseTimecode(tc.text);
  if (!parsed) { tcLatch = null; return; }
  const fps = tc.fps > 0 ? tc.fps : 25;
  tcLatch = {
    frames:  tcToFrames(parsed, fps, tc.dropFrame),
    fps,
    drop:    !!tc.dropFrame,
    running: !!tc.running,
    atMs:    Date.now(),
  };
}

function timecodeNow() {
  if (!tcLatch) return null;
  const age = (Date.now() - tcLatch.atMs) / 1000;
  const stale = age > TC_STALE_S;
  const running = tcLatch.running && !stale;
  // The offset only applies while timecode is moving. Once it stops, the last
  // frame that played is simply the truth — running it forward would show a
  // frame the show never reached.
  const ahead = running ? age + offsetSeconds(tcLatch.fps) : 0;
  return {
    frames: tcLatch.frames + Math.round(ahead * tcLatch.fps),
    fps:    tcLatch.fps,
    drop:   tcLatch.drop,
    running,
    stale,
  };
}

function updateTimecode() {
  if (!timelineEls) return;
  const now = timecodeNow();

  if (!now) {
    timelineEls.tc.hidden = true;
    timelineEls.tcOffsetWrap.hidden = true;
    ltcOut?.sync(null);
    return;
  }

  timelineEls.tc.hidden = false;
  timelineEls.tcOffsetWrap.hidden = false;
  reflectOffset();
  timelineEls.tc.classList.toggle('running', now.running);
  timelineEls.tc.classList.toggle('stale', now.stale);
  timelineEls.tcText.textContent = formatTimecode(framesToTc(now.frames, now.fps, now.drop));
  ltcOut?.sync(now);
}
tcTickerId = setInterval(updateTimecode, 40);

// ─── workspace panel ─────────────────────────────────────────────────────────

function setupWorkspacePanel() {
  // Shown by default — the whole point is having the shape of the show in view
  // without going looking for it. Hiding it is a deliberate choice, so only a
  // stored '0' turns it off.
  let shown = true;
  try {
    const saved = localStorage.getItem(WS_SHOWN_KEY);
    if (saved !== null) shown = saved === '1';
  } catch {}
  applyWorkspaceVisible(shown);

  timelineEls.wsToggle.onclick = () => {
    applyWorkspaceVisible(timelineEls.workspace.hidden);
    try { localStorage.setItem(WS_SHOWN_KEY, timelineEls.workspace.hidden ? '0' : '1'); } catch {}
  };

  // Rows are rebuilt on every snapshot, so one delegated listener handles
  // opening a song from the list instead of handlers on each row.
  const openRow = (row) => { if (row?.dataset.target) drawer?.openTarget(row.dataset.target); };
  timelineEls.wsList.addEventListener('click', (e) => openRow(e.target.closest('.ws-row')));
  timelineEls.wsList.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRow(e.target.closest('.ws-row')); }
  });

  timelineEls.wsFollow.onclick = () => {
    workspaceFollow = !workspaceFollow;
    timelineEls.wsFollow.setAttribute('aria-pressed', String(workspaceFollow));
    if (workspaceFollow) { lastFocusedCueId = null; renderWorkspace(); }
  };
}

function applyWorkspaceVisible(visible) {
  timelineEls.workspace.hidden = !visible;
  timelineEls.wsToggle.setAttribute('aria-pressed', String(visible));
  if (visible) { lastFocusedCueId = null; renderWorkspace(); window.requestAnimationFrame(() => render()); }
  else render();
}

// Ids of everything currently running, so a row can show it rather than the
// panel needing its own notion of playback.
function runningCueIds() {
  const ids = new Set();
  for (const cue of lastSnapshot?.running ?? []) ids.add(cue.id);
  return ids;
}

function renderWorkspace() {
  if (!timelineEls || timelineEls.workspace.hidden) return;

  const list = timelineEls.wsList;
  if (!workspaceTree) {
    if (!list.firstChild) {
      const p = document.createElement('div');
      p.className = 'ws-empty';
      p.textContent = 'waiting for the workspace…';
      list.replaceChildren(p);
    }
    return;
  }

  const running = runningCueIds();
  // Match on id where the bridge supplies one. Falling back to the name is
  // only for older bridges — two cues can share a name, so it can light the
  // wrong row.
  const playheadId = lastSnapshot?.playheadId ?? null;
  const selected = new Set(lastSnapshot?.selectedIds ?? []);
  const playheadName = lastSnapshot?.playheadName ?? null;
  const rows = [];

  // Show only the list QLab has open. Fall back to everything if it hasn't
  // told us which one that is — better a crowded panel than an empty one.
  const lists = workspaceTree.filter((l) => l.id === currentListId);
  const visible = lists.length ? lists : workspaceTree;

  // The list's own name is the panel heading, so it isn't repeated as a row
  // above every cue in it.
  const heading = lists.length === 1 ? lists[0].name : null;
  timelineEls.wsHeading.textContent = heading ?? 'Workspace';
  const roots = lists.length === 1 ? (visible[0].cues ?? []) : visible;

  // QLab lists every cue of a running group as "running" — including songs
  // still waiting for their GO — so "running" alone lit the whole group the
  // same. Split it by what each cue's own counters say:
  //   playing  — action running              prewait — pre-wait counting
  //   cued     — the Next up song            active group — contains a ticking cue
  const playing = new Set();
  const prewait = new Set();
  for (const c of lastSnapshot?.running ?? []) {
    const t = itemTime(c);
    if (t === null) continue;
    (t > 0 ? playing : prewait).add(c.id);
  }
  const ticking = new Set([...playing, ...prewait]);
  const cuedId = standbyItem()?.id ?? null;

  const walk = (cues, depth, inActive) => {
    for (const cue of cues) {
      const kids = cue.cues ?? null;
      const isGroup = !!kids;
      const isRunning = running.has(cue.id);
      // A group counts as running when any descendant is — that's what makes
      // the song heading light up rather than only the audio cue inside it.
      const subtreeRunning = isRunning || (kids ? containsRunning(kids, running) : false);
      const activeGroup = isGroup && containsRunning(kids, ticking);

      rows.push({
        cue, depth, isGroup,
        isRunning: isRunning || subtreeRunning,
        leafRunning: isRunning,
        activeGroup,
        inActive: !isGroup && inActive,
        playing: playing.has(cue.id),
        prewait: prewait.has(cue.id),
        cued: cue.id === cuedId,
        isPlayhead: playheadId ? cue.id === playheadId
                               : (playheadName != null && cue.name === playheadName),
        isSelected: selected.has(cue.id),
      });

      if (kids) walk(kids, depth + 1, inActive || activeGroup);
    }
  };
  walk(roots, 0, false);

  // Custom cues and to-dos attached to each item, for the row badges.
  const attached = new Map();
  const bump = (id, k, done) => {
    const a = attached.get(id) ?? { cues: 0, todos: 0, done: 0 };
    a[k]++;
    if (done) a.done++;
    attached.set(id, a);
  };
  for (const c of allCues()) if (c.cueId) bump(c.cueId, 'cues');
  for (const p of allPrecues()) if (p.cueId) bump(p.cueId, 'todos', p.done);
  const openKey = drawer?.selectedKey() ?? null;
  // A group row opens the first song inside it.
  const firstSong = (cue) => {
    for (const k of cue.cues ?? []) {
      if (k.cues) { const f = firstSong(k); if (f) return f; }
      else if (SONG_TYPES.has(k.type)) return k.id;
    }
    return null;
  };

  const frag = document.createDocumentFragment();
  let focusRow = null;

  for (const r of rows) {
    const el = document.createElement('div');
    el.className = 'ws-row'
      + (r.isGroup ? ' ws-group' : '')
      + (r.isGroup && !r.activeGroup ? ' ws-idle' : '')
      + (r.activeGroup ? ' ws-group-active' : '')
      + (r.inActive ? ' ws-in-active' : '')
      + (r.playing ? ' ws-playing' : '')
      + (r.prewait ? ' ws-prewait' : '')
      + (r.cued ? ' ws-cued' : '')
      + (r.isPlayhead ? ' ws-playhead' : '')
      + (r.isSelected ? ' ws-selected' : '');
    el.style.paddingLeft = `${0.75 + r.depth * 0.7}rem`;

    const num = document.createElement('span');
    num.className = 'ws-num';
    num.textContent = r.cue.number ?? '';

    const name = document.createElement('span');
    name.className = 'ws-name';
    name.textContent = r.cue.name;

    el.append(num, name);

    // A cue QLab won't fire is the single most useful thing to see from
    // somewhere other than the operator's seat, so it's called out in words
    // rather than left to a subtle style.
    if (r.cued) {
      const next = document.createElement('span');
      next.className = 'ws-tag ws-next';
      next.textContent = 'next';
      el.appendChild(next);
    }
    if (r.cue.armed === false) {
      const off = document.createElement('span');
      off.className = 'ws-tag ws-disarmed';
      off.textContent = 'disarmed';
      el.appendChild(off);
      el.classList.add('ws-off');
    }
    if (r.cue.flagged) {
      const flag = document.createElement('span');
      flag.className = 'ws-tag ws-flagged';
      flag.textContent = '⚑';
      el.appendChild(flag);
    }

    // Groups show the total of what's inside them; that's the number someone
    // watching actually wants — how long is this song, not how long is its
    // first audio cue.
    const seconds = r.isGroup ? subtreeDuration(r.cue) : r.cue.duration;
    if (seconds != null && seconds > 0) {
      const dur = document.createElement('span');
      dur.className = 'ws-dur';
      dur.textContent = formatDuration(seconds);
      el.appendChild(dur);
    }

    // Click (or Enter) opens this song — or a group's first song — in the
    // ★ drawer, with its custom cues and to-dos.
    const targetId = r.isGroup ? firstSong(r.cue) : (SONG_TYPES.has(r.cue.type) || attached.has(r.cue.id) ? r.cue.id : null);
    if (targetId) {
      el.dataset.target = `cue:${targetId}`;
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.classList.add('ws-clickable');
      if (!r.isGroup && openKey === el.dataset.target) el.classList.add('ws-open');
    }
    const a = !r.isGroup && attached.get(r.cue.id);
    if (a) {
      const badge = document.createElement('span');
      badge.className = 'ws-attach';
      const parts = [];
      if (a.cues) parts.push(`★${a.cues}`);
      if (a.todos) parts.push(`☐${a.done}/${a.todos}`);
      badge.textContent = parts.join(' ');
      badge.title = `${a.cues} custom cue${a.cues === 1 ? '' : 's'}, ${a.done} of ${a.todos} to-dos done`;
      if (a.todos && a.done === a.todos) badge.classList.add('all-done');
      el.appendChild(badge);
    }

    if (r.cue.colorName) el.dataset.color = r.cue.colorName;
    frag.appendChild(el);

    // Prefer the deepest running thing — the actual cue, not the list it's in.
    // What to keep centred, most important first: the cue actually playing,
    // then whatever is standing by, then the group containing a running cue.
    const rank = r.playing ? 3 : (r.cued || r.isPlayhead) ? 2 : r.activeGroup ? 1 : 0;
    if (rank > (focusRow?.rank ?? 0)) focusRow = { el, id: r.cue.id, rank };
  }

  list.replaceChildren(frag);

  // Only scroll when the focus actually moves, or the panel would fight the
  // operator every time they scrolled away to look at something else.
  if (workspaceFollow && focusRow && focusRow.id !== lastFocusedCueId) {
    lastFocusedCueId = focusRow.id;
    focusRow.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// QLab reports no duration for a Group cue, so it has to come from the
// children — as the LONGEST, not the sum. A song group holds an audio cue and
// a video cue that play together, so summing them reports a three-minute song
// as six. The only shape where summing would be right is a group fired one cue
// at a time by the operator, and there the timing isn't ours to predict anyway.
function subtreeDuration(cue) {
  if (!cue.cues) return cue.duration ?? null;
  let longest = null;
  for (const kid of cue.cues) {
    const d = subtreeDuration(kid);
    if (d != null && (longest == null || d > longest)) longest = d;
  }
  return longest;
}

function formatDuration(seconds) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function containsRunning(cues, running) {
  for (const cue of cues) {
    if (running.has(cue.id)) return true;
    if (cue.cues && containsRunning(cue.cues, running)) return true;
  }
  return false;
}

// ─── transport offset ────────────────────────────────────────────────────────

function setupTimecodeOffset(channel) {
  tcOffsetKey = `qlab-viewer.tcOffset.${channel}`;
  try {
    const saved = JSON.parse(localStorage.getItem(tcOffsetKey) ?? '{}');
    tcOffsetMs = Number(saved.ms) || 0;
    tcOffsetFrames = Number(saved.frames) || 0;
  } catch { tcOffsetMs = 0; tcOffsetFrames = 0; }

  const msEl = timelineEls.tcOffset;
  const frEl = timelineEls.tcFrames;
  msEl.value = String(tcOffsetMs);
  frEl.value = String(tcOffsetFrames);
  reflectOffset();

  const clamp = (v, lo, hi) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
  const save = () => {
    try { localStorage.setItem(tcOffsetKey, JSON.stringify({ ms: tcOffsetMs, frames: tcOffsetFrames })); } catch {}
    reflectOffset();
  };

  msEl.onchange = msEl.oninput = () => { tcOffsetMs = clamp(Number(msEl.value), -5000, 5000); save(); };
  frEl.onchange = frEl.oninput = () => { tcOffsetFrames = clamp(Math.round(Number(frEl.value)), -250, 250); save(); };
}

// Total shift in seconds. The frame part follows the show's own rate, so a
// two-frame nudge stays two frames whether the show runs at 25 or 30.
function offsetSeconds(fps) {
  return tcOffsetMs / 1000 + tcOffsetFrames / (fps || 25);
}

function reflectOffset() {
  const wrap = timelineEls.tcOffsetWrap;
  const applied = tcOffsetMs !== 0 || tcOffsetFrames !== 0;
  wrap.classList.toggle('applied', applied);

  const fps = tcLatch?.fps || 25;
  const totalMs = offsetSeconds(fps) * 1000;
  const totalFrames = (totalMs / 1000) * fps;
  const measured = measuredLatencyMs == null ? 'measuring…' : `~${Math.round(measuredLatencyMs)} ms`;
  const sign = (n) => (n > 0 ? '+' : '');

  wrap.title =
    `Run the timecode ahead to compensate for transport delay, and shift it by whole frames.\n` +
    `ms offset:    ${sign(tcOffsetMs)}${tcOffsetMs} ms\n` +
    `frame shift:  ${sign(tcOffsetFrames)}${tcOffsetFrames} f\n` +
    `total:        ${sign(totalMs)}${totalMs.toFixed(0)} ms = ${sign(totalFrames)}${totalFrames.toFixed(1)} frames at ${fps} fps\n` +
    `Measured delay from the bridge: ${measured}`;
}

// ─── output device picker ────────────────────────────────────────────────────
//
// Choosing where the LTC goes needs a secure context: over plain http the
// mediaDevices API doesn't exist at all, so the picker stays hidden and the
// timecode plays to whatever the system default is.

function savedLtcDevice() {
  try { return localStorage.getItem(LTC_DEVICE_KEY) ?? ''; } catch { return ''; }
}

async function setupOutputPicker() {
  const sel = timelineEls.tcDevice;
  if (!canChooseOutput()) {
    sel.hidden = true;
    timelineEls.tcOut.title = window.isSecureContext
      ? "Play LTC out of this device's audio output"
      : "Plays LTC out of the default output — serve this page over https to choose a device";
    return;
  }

  sel.hidden = false;
  await populateOutputDevices();

  sel.onchange = async () => {
    if (sel.value === '__reveal__') {
      // Labels only appear once the page has audio permission; without it the
      // list is anonymous ids nobody can choose between.
      try { await revealDeviceLabels(); } catch { /* declined — ids it is */ }
      await populateOutputDevices();
      return;
    }
    try { localStorage.setItem(LTC_DEVICE_KEY, sel.value); } catch {}
    try {
      await ltcOut?.setDevice(sel.value);
    } catch (err) {
      console.warn('output device unavailable', err);
      sel.value = '';
      await populateOutputDevices();
    }
  };

  navigator.mediaDevices.addEventListener?.('devicechange', () => populateOutputDevices());
}

async function populateOutputDevices() {
  const sel = timelineEls.tcDevice;
  const devices = await listOutputDevices();
  const saved = savedLtcDevice();
  const unlabelled = devices.length > 0 && devices.every((d) => !d.label);

  sel.replaceChildren();
  const add = (value, text) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = text;
    sel.appendChild(o);
  };

  add('', 'Default output');
  devices.forEach((d, i) => {
    if (d.deviceId && d.deviceId !== 'default') add(d.deviceId, d.label || `Output ${i + 1}`);
  });
  if (unlabelled) add('__reveal__', 'Show device names…');

  sel.value = [...sel.options].some((o) => o.value === saved) ? saved : '';
}

async function toggleLtcOutput() {
  const btn = timelineEls.tcOut;
  try {
    if (ltcOut) {
      await ltcOut.stop();
      ltcOut = null;
      btn.setAttribute('aria-pressed', 'false');
      btn.title = "Play LTC out of this device's audio output";
    } else {
      const out = new LtcOutput(savedLtcDevice());
      await out.start(timecodeNow());   // stays inside the click for autoplay policy
      ltcOut = out;
      btn.setAttribute('aria-pressed', 'true');
      btn.title = 'Chasing show timecode — not a frame-locked sync reference';
    }
  } catch (err) {
    console.warn('LTC output failed', err);
    btn.setAttribute('aria-pressed', 'false');
    btn.title = `LTC output unavailable: ${err.message}`;
    ltcOut = null;
  }
}

// Auth-failure bounce-back into landing mode.
(function handleAuthBounce() {
  const p = new URLSearchParams(location.search);
  const prefill = p.get('prefill');
  if (!DEMO && prefill && !p.get('channel')) {
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
