// Demo mode: a self-contained show for trying the viewer without QLab, the
// bridge or the relay. `DemoSocket` stands in for the relay WebSocket and
// speaks the same two protocols the real one does:
//
//   • QLab snapshots, shaped and timed like the macOS bridge sends them:
//     4 Hz polls, unchanged snapshots suppressed but re-sent on a 1 s
//     heartbeat (so a paused show repeats frozen values), finished child
//     cues reported as 0/0 while their group runs, plus the workspace
//     cue-list message the bridge publishes on its own slower cycle
//   • the relay "items" protocol for custom cues, with the same permission
//     rules (shared needs the editor password, private is per owner key),
//     persisted in this browser's localStorage.
//
// Enabled with ?demo or a VITE_DEMO=1 build (the hosted demo page).

export const DEMO_CHANNEL = 'demo';
export const DEMO_EDITOR_PASSWORD = 'demo';
const SHOW = 'DEMO SHOW';
const GAP_S = 4;                     // silence between songs, like a stage changeover
const ITEMS_KEY = 'qlab-demo.items.v2';   // v2: cues tied to items, plus to-dos

// Realistic three-song set: timeline groups mixing audio/video beds, LX
// state cues, fades and memos. [name, type, number, preWait, duration]
const SONGS = [
  {
    name: 'SANG 1 · Opening', length: 48, cues: [
      ['Intro track', 'Audio', '1.1', 0, 48],
      ['LX 10 house out', 'Light', '1.2', 0, 0],
      ['Opening titles', 'Video', '1.3', 2, 12],
      ['Band on stage', 'Memo', '1.4', 14, 0],
      ['LX 11 full stage', 'Light', '1.5', 16, 0],
      ['Fade titles', 'Fade', '1.6', 24, 4],
      ['LX 12 chorus', 'Light', '1.7', 32, 0],
      ['Chorus loop', 'Video', '1.8', 32, 14],
    ],
  },
  {
    name: 'SANG 2 · Ballad', length: 55, cues: [
      ['Ballad track', 'Audio', '2.1', 0, 55],
      ['LX 20 blue wash', 'Light', '2.2', 0, 0],
      ['Starfield', 'Video', '2.3', 3, 40],
      ['LX 21 spot only', 'Light', '2.4', 18, 0],
      ['Haze check', 'Memo', '2.5', 25, 0],
      ['Fade starfield', 'Fade', '2.6', 43, 5],
      ['LX 22 warm', 'Light', '2.7', 46, 0],
    ],
  },
  {
    name: 'SANG 3 · Finale', length: 42, cues: [
      ['Finale track', 'Audio', '3.1', 0, 42],
      ['LX 30 strobe', 'Light', '3.2', 0, 0],
      ['Finale visuals', 'Video', '3.3', 1, 38],
      ['Pyro arm', 'MIDI', '3.4', 20, 0],
      ['LX 31 blinders', 'Light', '3.5', 30, 0],
      ['LX 32 blackout', 'Light', '3.6', 41, 0],
    ],
  },
];

const LIST_ID = 'demo-list';

// The slimmed cue-list tree the bridge publishes for the workspace panel.
function workspaceTree() {
  return [{
    id: LIST_ID, name: SHOW, cues: SONGS.map((song, si) => ({
      id: `demo-g-${si}`, number: String(si + 1), name: song.name, type: 'Group',
      cues: song.cues.map(([name, type, number, , duration], i) => ({
        id: `demo-${si}-${i}`, number, name, type, duration: duration || null,
      })),
    })),
  }];
}

// Shared custom cues and pre-cue to-dos seeded on first visit, tied to the
// songs' audio items, so both features are visible at once.
function seedItems() {
  const now = Date.now();
  const song = (si) => ({ cueId: `demo-${si}-0`, cueName: SONGS[si].cues[0][0] });
  const base = (id, data) => ({ id, visibility: 'shared', owner: null, createdAt: now, updatedAt: now, data });
  const cue = (id, si, at, label, dept, extra = {}) =>
    base(id, { kind: 'cue', anchor: song(si), at, duration: 0, warn: 8, label, dept, note: '', ...extra });
  const todo = (id, si, text, dept, n) =>
    ({ ...base(id, { kind: 'precue', anchor: song(si), text, done: false, dept }), createdAt: now + n });
  return [
    cue('seed-1', 0, 9, 'Spot 1 pick up singer', 'LX'),
    cue('seed-2', 0, 28, 'Confetti cannons', 'SFX', { duration: 6, note: 'Both cannons, SL and SR' }),
    cue('seed-3', 1, 6, 'Haze on low', 'SFX'),
    cue('seed-4', 1, 21, 'Lyric slide: verse 2', 'VID', { duration: 10 }),
    cue('seed-5', 2, 18, 'Pyro standby call', 'SM', { warn: 15 }),
    todo('todo-1', 1, 'Swap HH mic to the acoustic stand', 'A1', 1),
    todo('todo-2', 1, 'Haze machine warmed up', 'SFX', 2),
    todo('todo-3', 2, 'Pyro safety check with the stage manager', 'SM', 1),
    todo('todo-4', 2, 'Confetti cannons reloaded', 'SFX', 2),
  ];
}

// ─── Show simulator ─────────────────────────────────────────────────────────

class ShowSim {
  constructor() {
    this.listeners = new Set();
    this.song = 0;
    this.state = 'playing';     // playing | paused | gap | stopped
    this.offset = 0;            // song seconds accumulated before the current run segment
    this.startedAt = performance.now();
    this.gapUntil = 0;
    this.lastSent = '';
    this.lastSentAt = 0;
    this.lastWorkspaceAt = 0;
    this.timer = setInterval(() => this.poll(), 250);
  }

  songTime() {
    if (this.state === 'playing') return this.offset + (performance.now() - this.startedAt) / 1000;
    return this.offset;
  }

  // ── controls ──
  go(songIndex = this.song) {
    this.song = (songIndex + SONGS.length) % SONGS.length;
    this.offset = 0;
    this.startedAt = performance.now();
    this.state = 'playing';
    this.poll(true);
  }
  pause() {
    if (this.state !== 'playing') return;
    this.offset = this.songTime();
    this.state = 'paused';
    this.emitStatus();
  }
  resume() {
    if (this.state !== 'paused') return;
    this.startedAt = performance.now();
    this.state = 'playing';
    this.poll(true);
  }
  restart() { this.go(this.song); }
  next() { this.go(this.song + 1); }
  stop() {
    this.state = 'stopped';
    this.offset = 0;
    this.poll(true);
  }

  // ── one bridge poll ──
  poll(force = false) {
    if (this.state === 'gap' && performance.now() >= this.gapUntil) this.go(this.song + 1);
    if (this.state === 'playing' && this.songTime() >= SONGS[this.song].length) {
      // Group finished: QLab drops it from the running list.
      this.state = 'gap';
      this.offset = 0;
      this.gapUntil = performance.now() + GAP_S * 1000;
    }
    // The cue list goes out on its own slow cycle, and — like the bridge —
    // is immediately followed by state so a joiner never sees structure only.
    const now = performance.now();
    if (force || now - this.lastWorkspaceAt > 8000) {
      this.lastWorkspaceAt = now;
      const ws = JSON.stringify({ workspace: workspaceTree(), currentListId: LIST_ID });
      for (const fn of this.listeners) fn(ws);
      force = true;
    }
    const snap = this.snapshot();
    // Like the bridge: unchanged state (ts excluded) is only re-sent on a
    // 1 s heartbeat, so a paused show repeats its frozen values.
    const key = JSON.stringify({ ...snap, ts: 0 });
    if (key !== this.lastSent || force || now - this.lastSentAt > 1000) {
      this.lastSent = key;
      this.lastSentAt = now;
      const text = JSON.stringify(snap);
      for (const fn of this.listeners) fn(text);
    }
    this.emitStatus();
  }

  snapshot() {
    const live = this.state === 'playing' || this.state === 'paused';
    const song = SONGS[this.song];
    const path = [SHOW, song.name];
    const t = this.songTime();
    const r3 = (x) => Math.round(x * 1000) / 1000;
    const running = !live ? [] : song.cues.map(([name, type, number, preWait, duration], i) => {
      let pwE, e;
      if (t < preWait) { pwE = t; e = 0; }
      else if (t < preWait + duration) { pwE = preWait; e = t - preWait; }
      else { pwE = 0; e = 0; }               // finished child: QLab reports 0/0
      return {
        id: `demo-${this.song}-${i}`, name, type, number, groupPath: path,
        groupIds: [LIST_ID, `demo-g-${this.song}`],
        preWait, preWaitElapsed: r3(pwE), duration, elapsed: r3(e),
        percent: duration > 0 ? r3(e / duration) : 0,
      };
    });
    const nextIndex = live ? (this.song + 1) % SONGS.length : this.song;
    return {
      ts: Date.now(),
      mode: live ? 'running' : 'preview',
      currentListId: LIST_ID,
      activeName: live ? song.name : null,
      playheadName: SONGS[nextIndex].name,
      playheadNumber: String(nextIndex + 1),
      playheadId: `demo-g-${nextIndex}`,
      selectedIds: [],
      groupPath: live ? path : [],
      running,
    };
  }

  // ── status for the demo bar ──
  onStatus(fn) { this.statusFn = fn; this.emitStatus(); }
  emitStatus() {
    this.statusFn?.({
      state: this.state,
      song: SONGS[this.song].name,
      t: this.songTime(),
      length: SONGS[this.song].length,
      gapLeft: this.state === 'gap' ? Math.max(0, (this.gapUntil - performance.now()) / 1000) : 0,
      nextSong: SONGS[(this.song + 1) % SONGS.length].name,
    });
  }
}

let sim = null;
export function getSim() {
  sim ??= new ShowSim();
  return sim;
}

// ─── Item store (mirror of relay-server/src/items.js rules) ─────────────────

function loadItems() {
  try {
    const raw = localStorage.getItem(ITEMS_KEY);
    if (raw) return new Map(JSON.parse(raw).map((i) => [i.id, i]));
  } catch { /* fall through to seed */ }
  return new Map(seedItems().map((i) => [i.id, i]));
}
function saveItems(items) {
  try { localStorage.setItem(ITEMS_KEY, JSON.stringify([...items.values()])); } catch { /* ignore */ }
}
export function resetDemoItems() {
  try { localStorage.removeItem(ITEMS_KEY); } catch { /* ignore */ }
}

function viewOf(item, viewer) {
  return {
    id: item.id, visibility: item.visibility,
    mine: item.visibility === 'private' && item.owner === viewer.owner,
    data: item.data, createdAt: item.createdAt, updatedAt: item.updatedAt,
  };
}
const canSee = (item, v) => item.visibility === 'shared' || (!!v.owner && item.owner === v.owner);
function denied(prev, nextVis, v) {
  if (prev?.visibility === 'shared' && !v.editor) return 'shared items require the editor password';
  if (prev?.visibility === 'private' && prev.owner !== v.owner) return 'not your item';
  if (nextVis === 'shared' && !v.editor) return 'shared items require the editor password';
  if (nextVis === 'private' && !v.owner) return 'private items require an owner key';
  return null;
}

// ─── The fake socket ────────────────────────────────────────────────────────

export class DemoSocket extends EventTarget {
  constructor() {
    super();
    this.readyState = 0;
    this.items = loadItems();
    this.viewer = { owner: null, editor: false, hello: false };
    this.onSnap = (text) => this.deliver(text);
    setTimeout(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
      const s = getSim();
      s.listeners.add(this.onSnap);
      s.poll(true);              // like the relay's cached last message for late joiners
    }, 50);
  }

  deliver(text) {
    if (this.readyState !== 1) return;
    this.dispatchEvent(new MessageEvent('message', { data: text }));
  }
  reply(obj) {
    const text = JSON.stringify({ relay: 'items', ...obj });
    setTimeout(() => this.deliver(text), 15);
  }

  send(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg?.relay !== 'items') return;
    const v = this.viewer;
    if (msg.op === 'hello') {
      v.owner = typeof msg.owner === 'string' && msg.owner.length >= 16 ? msg.owner : null;
      v.editor = msg.edit === DEMO_EDITOR_PASSWORD;
      v.hello = true;
      const list = [...this.items.values()].filter((i) => canSee(i, v)).map((i) => viewOf(i, v));
      this.reply({ op: 'sync', items: list, canEditShared: v.editor, hasOwner: !!v.owner });
      return;
    }
    const req = msg.req;
    if (!v.hello) return this.reply({ op: 'ack', req, ok: false, error: 'send hello first' });

    if (msg.op === 'upsert') {
      const it = msg.item ?? {};
      if (it.visibility !== 'shared' && it.visibility !== 'private') return this.reply({ op: 'ack', req, ok: false, error: 'bad visibility' });
      if (!it.data || typeof it.data !== 'object') return this.reply({ op: 'ack', req, ok: false, error: 'data must be an object' });
      const prev = it.id ? this.items.get(it.id) : undefined;
      const err = denied(prev, it.visibility, v);
      if (err) return this.reply({ op: 'ack', req, ok: false, error: err });
      const now = Date.now();
      const item = {
        id: it.id ?? (crypto.randomUUID?.() ?? `c${now}${Math.random().toString(36).slice(2)}`),
        visibility: it.visibility,
        owner: it.visibility === 'private' ? v.owner : null,
        data: it.data, createdAt: prev?.createdAt ?? now, updatedAt: now,
      };
      this.items.set(item.id, item);
      saveItems(this.items);
      this.reply({ op: 'ack', req, ok: true, id: item.id });
      this.reply({ op: 'put', item: viewOf(item, v) });
      return;
    }
    if (msg.op === 'delete') {
      const prev = this.items.get(msg.id);
      if (!prev) return this.reply({ op: 'ack', req, ok: false, error: 'no such item' });
      const err = denied(prev, prev.visibility, v);
      if (err) return this.reply({ op: 'ack', req, ok: false, error: err });
      this.items.delete(msg.id);
      saveItems(this.items);
      this.reply({ op: 'ack', req, ok: true, id: msg.id });
      this.reply({ op: 'remove', id: msg.id });
    }
  }

  close() {
    if (this.readyState === 3) return;
    getSim().listeners.delete(this.onSnap);
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent('close', { code: 1000 }));
  }
}

// ─── Demo control bar ───────────────────────────────────────────────────────

function fmt(s) {
  const x = Math.max(0, Math.floor(s));
  return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`;
}

export function initDemoBar() {
  const bar = document.getElementById('demo-bar');
  if (!bar) return;
  bar.hidden = false;
  document.body.classList.add('demo');
  const s = getSim();
  const el = (id) => document.getElementById(id);
  const status = el('demo-status');
  const pauseBtn = el('demo-pause');
  const goBtn = el('demo-go');

  el('demo-restart').onclick = () => s.restart();
  el('demo-next').onclick = () => s.next();
  pauseBtn.onclick = () => (s.state === 'paused' ? s.resume() : s.pause());
  goBtn.onclick = () => (s.state === 'stopped' || s.state === 'gap' ? s.go() : s.stop());
  el('demo-reset').onclick = () => {
    if (el('demo-reset').dataset.armed !== '1') {
      el('demo-reset').dataset.armed = '1';
      el('demo-reset').textContent = 'Tap again to reset';
      setTimeout(() => { el('demo-reset').dataset.armed = ''; el('demo-reset').textContent = 'Reset cues'; }, 3000);
      return;
    }
    resetDemoItems();
    location.reload();
  };

  s.onStatus((st) => {
    const text = st.state === 'gap'
      ? `Changeover · ${st.nextSong} in ${Math.ceil(st.gapLeft)} s`
      : st.state === 'stopped'
        ? `Stopped · GO starts ${st.song}`
        : `${st.state === 'paused' ? 'Paused' : 'Playing'} · ${fmt(st.t)} / ${fmt(st.length)}`;
    if (status.textContent !== text) status.textContent = text;
    const paused = st.state === 'paused';
    pauseBtn.disabled = !(st.state === 'playing' || paused);
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    pauseBtn.classList.toggle('on', paused);
    goBtn.textContent = st.state === 'stopped' || st.state === 'gap' ? 'GO' : 'Stop';
    goBtn.classList.toggle('go', st.state === 'stopped' || st.state === 'gap');
  });
}
