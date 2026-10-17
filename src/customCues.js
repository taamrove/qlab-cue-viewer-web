// Custom cues — pure logic (no DOM, no network) so it can be unit-tested
// with `node --test` and reused by the renderer and the editor.
//
// Two kinds of relay "item" live here.
//
// A timed custom cue:
//   {
//     kind: "cue",
//     anchor: { cueId: "<QLab uniqueID>", cueName: "SDV_Fever_INST_XOA.mp4" },
//     at: 42.5,          // seconds into that QLab cue's action (the file's own time)
//     duration: 0,       // 0 = instant (flag), >0 = span (bar)
//     warn: 10,          // seconds of highlighted countdown before `at`
//     label: "Pyro ready",
//     dept: "SFX",       // optional, used for filtering
//     note: "",          // optional free text
//   }
//
// A pre-cue (to-do for before an item starts):
//   { kind: "precue", anchor: { cueId, cueName }, text: "Swap HH mic", done: false, dept: "" }
//
// Anchoring. Cues are tied to the ITEM — the QLab cue that is the song, usually
// an audio/video file — by its uniqueID, and timed on that cue's own elapsed
// time. Songs that play one after another inside one group therefore don't
// share a clock. Older cues anchored to a song GROUP (`anchor.groupPath`, plus
// `anchor.groupId` from newer bridges) keep working on the group's clock.

export const NOW_HOLD_S = 2;        // how long an instant cue shows "NOW"
// The bridge publishes only when something changed (it dedupes identical
// snapshots), so a paused QLab goes silent. Never project further than this
// past the last snapshot: ~3 poll intervals at 4 Hz.
export const MAX_EXTRAPOLATE_S = 0.75;
export const DEFAULT_WARN_S = 10;
export const NO_DEPT = '';          // filter key for cues without a department

export function parseTime(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? input : null;
  const s = String(input ?? '').trim();
  if (!s) return null;
  // Accept "83.5", "1:23.5", "1:02:03".
  if (!/^\d+(?::\d{1,2})*(?:[.,]\d+)?$/.test(s)) return null;
  const parts = s.replace(',', '.').split(':');
  let total = 0;
  for (const p of parts) total = total * 60 + Number(p);
  return Number.isFinite(total) ? total : null;
}

export function fmtPrecise(seconds) {
  if (!Number.isFinite(seconds)) return '–:––';
  const neg = seconds < 0;
  const tenths = Math.round(Math.abs(seconds) * 10);
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  const t = tenths % 10;
  return `${neg ? '-' : ''}${m}:${String(s).padStart(2, '0')}.${t}`;
}

export function fmtCountdown(seconds) {
  // Ceil so "in 0:01" is shown until the very moment it fires, never "in 0:00".
  const s = Math.max(0, Math.ceil(seconds - 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function num(v, fallback) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Relay item → normalized cue, or null if it isn't a usable cue. Defensive
// because items are user-authored JSON from other clients.
const str = (v) => (typeof v === 'string' && v ? v : null);

// Normalized anchor, or null if the item has none we can use.
//   { cueId, cueName }                → tied to a QLab cue (item)
//   { groupPath, groupId }            → tied to a song group (older cues)
function normalizeAnchor(a) {
  const cueId = str(a?.cueId);
  if (cueId) return { cueId, cueName: str(a.cueName) ?? cueId, groupPath: null, groupId: null };
  const path = a?.groupPath;
  if (!Array.isArray(path) || path.length === 0 || !path.every((p) => typeof p === 'string')) return null;
  return { cueId: null, cueName: null, groupPath: path, groupId: str(a.groupId) };
}

// Stable key of what a cue/pre-cue is tied to: 'cue:<id>' or 'grp:<path>'.
export function targetKeyOf(anchor) {
  return anchor.cueId ? `cue:${anchor.cueId}` : `grp:${pathKey(anchor.groupPath)}`;
}

export function normalizeCue(item) {
  const d = item?.data;
  if (!d || d.kind !== 'cue') return null;
  const anchor = normalizeAnchor(d.anchor);
  if (!anchor) return null;
  const at = num(d.at, null);
  if (at === null) return null;
  return {
    id: item.id,
    visibility: item.visibility === 'private' ? 'private' : 'shared',
    mine: !!item.mine,
    ...anchor,
    target: targetKeyOf(anchor),
    at,
    duration: num(d.duration, 0),
    warn: num(d.warn, DEFAULT_WARN_S),
    label: typeof d.label === 'string' && d.label.trim() ? d.label.trim() : 'Cue',
    dept: typeof d.dept === 'string' ? d.dept.trim() : NO_DEPT,
    note: typeof d.note === 'string' ? d.note : '',
    updatedAt: item.updatedAt ?? 0,
  };
}

// `target` is what the cue is tied to: { cueId, cueName } for an item, or
// { groupPath, groupId? } for a song group.
export function buildAnchor(target) {
  if (target.cueId) return { cueId: target.cueId, cueName: target.cueName ?? target.cueId };
  return target.groupId
    ? { groupPath: [...target.groupPath], groupId: target.groupId }
    : { groupPath: [...target.groupPath] };
}

export function buildCueData({ target, at, duration = 0, warn = DEFAULT_WARN_S, label, dept = '', note = '' }) {
  return {
    kind: 'cue',
    anchor: buildAnchor(target),
    at: Math.round(at * 100) / 100,
    duration: Math.round(Math.max(0, duration) * 100) / 100,
    warn: Math.max(0, warn),
    label: String(label ?? '').trim() || 'Cue',
    dept: String(dept ?? '').trim(),
    note: String(note ?? ''),
  };
}

export function normalizePrecue(item) {
  const d = item?.data;
  if (!d || d.kind !== 'precue') return null;
  const anchor = normalizeAnchor(d.anchor);
  if (!anchor) return null;
  const text = typeof d.text === 'string' ? d.text.trim() : '';
  if (!text) return null;
  return {
    id: item.id,
    visibility: item.visibility === 'private' ? 'private' : 'shared',
    mine: !!item.mine,
    ...anchor,
    target: targetKeyOf(anchor),
    text,
    done: d.done === true,
    dept: typeof d.dept === 'string' ? d.dept.trim() : NO_DEPT,
    createdAt: item.createdAt ?? 0,
  };
}

export function buildPrecueData({ target, text, done = false, dept = '' }) {
  return {
    kind: 'precue',
    anchor: buildAnchor(target),
    text: String(text ?? '').trim().slice(0, 300),
    done: !!done,
    dept: String(dept ?? '').trim(),
  };
}

// An item's own time from its QLab counters: seconds into its action, or
// negative while its pre-wait is still counting (so a countdown to `at`
// includes the pre-wait). null when the cue isn't ticking (queued, or
// finished — QLab reports finished children as 0/0).
export function itemTime(q) {
  const pw = q.preWait ?? 0;
  const e = q.elapsed ?? 0;
  if (e > 0) return e;
  const pwE = Math.min(pw, q.preWaitElapsed ?? 0);
  if (pwE > 0) return -(pw - pwE);
  return null;
}

// Media cues are what operators think of as "the song".
export const SONG_TYPES = new Set(['Audio', 'Video']);

// QLab 5 group modes (/cue/{id}/mode). A TIMELINE group starts all its
// children together, each offset by its own pre-wait — so its children are
// one piece of music on one clock. The others fire children one after
// another (or at random), so each child is its own song.
export const GROUP_MODE = { LIST: 0, START_AND_ENTER: 1, START_FIRST: 2, TIMELINE: 3, RANDOM: 4, CART: 5, PLAYLIST: 6 };
export const GROUP_MODE_LABEL = { 1: 'sequence', 2: 'sequence', 3: 'timeline', 4: 'random', 6: 'playlist' };
export const isTimelineGroup = (c) => Array.isArray(c?.cues) && c.mode === GROUP_MODE.TIMELINE;

// Flatten the bridge's workspace tree (one cue list) into ordered items with
// their group path. With `units`, a timeline group is kept as ONE entry
// (timeline: true, childIds) instead of being opened up: its children share
// the group's clock, so cues and to-dos belong to the group as a whole.
export function flattenWorkspace(cues, path = [], groupIds = [], { units = false } = {}) {
  const out = [];
  for (const c of cues ?? []) {
    if (Array.isArray(c.cues) && units && isTimelineGroup(c)) {
      out.push({
        id: c.id, name: c.name, number: c.number ?? '', type: 'Group', timeline: true,
        duration: timelineDuration(c), path, groupIds, childIds: new Set(allIds(c.cues)),
      });
    } else if (Array.isArray(c.cues)) {
      out.push(...flattenWorkspace(c.cues, [...path, c.name], [...groupIds, c.id], { units }));
    } else {
      out.push({ id: c.id, name: c.name, number: c.number ?? '', type: c.type ?? '', duration: c.duration ?? null, path, groupIds });
    }
  }
  return out;
}

// A song, for cue anchoring: a media item outside any timeline group, or a
// whole timeline group.
export const isSongUnit = (x) => !!x && (x.timeline || SONG_TYPES.has(x.type));

// Every id in a tree, groups included.
export function allIds(cues, out = []) {
  for (const c of cues ?? []) {
    out.push(c.id);
    if (Array.isArray(c.cues)) allIds(c.cues, out);
  }
  return out;
}

// Length of a timeline group: QLab's own figure for the group when the bridge
// has it (it includes the children's pre-waits); otherwise the longest child,
// which is a lower bound.
export function timelineDuration(g) {
  if (g.duration > 0) return g.duration;
  let longest = null;
  const walk = (cues) => {
    for (const c of cues ?? []) {
      if (Array.isArray(c.cues)) walk(c.cues);
      else if (c.duration > 0 && (longest == null || c.duration > longest)) longest = c.duration;
    }
  };
  walk(g.cues);
  return longest;
}

// Clock of a running timeline group from its children's own counters: each
// child starts `preWait` after the group, so preWait + its time is the
// group's time. Children of nested groups are only used if no direct child
// is ticking, since their pre-waits count from the nested group instead.
// QLab reports finished children as 0/0, so only ticking ones count.
export function timelineTime(children, groupId) {
  const ticking = children.filter((c) => itemTime(c) !== null);
  if (!ticking.length) return null;
  const direct = ticking.filter((c) => !Array.isArray(c.groupIds) || c.groupIds.at(-1) === groupId);
  let t = -Infinity;
  for (const c of direct.length ? direct : ticking) t = Math.max(t, (c.preWait ?? 0) + itemTime(c));
  return t;
}

// ─── Re-linking cues to a new version of a song ─────────────────────────────
//
// Swapping in a new version of a song in QLab gives it a new uniqueID, so
// cues tied to the old one lose their song. To suggest where they belong,
// file names are compared on their meaningful words: production boilerplate
// (INST, XOA, VOKAL, v2, FINAL, extensions…) is ignored, so
// "SDV_Fever_INST_XOA.mp4" matches "SDV_Fever_INST_v2_XOA.mov".
const NOISE = new Set([
  'mp4', 'mov', 'wav', 'aif', 'aiff', 'mp3', 'm4a', 'mxf', 'prores', 'hap',
  'inst', 'instrumental', 'vokal', 'vocal', 'vox', 'original', 'orig', 'final',
  'new', 'old', 'edit', 'mix', 'master', 'version', 'ver', 'copy', 'xoa', 'sdv',
]);
export function nameTokens(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, '')
    .split(/[^a-z0-9æøåäöü]+/)
    .filter((t) => t && !NOISE.has(t) && !/^v\d+$/.test(t) && !/^\d{1,2}$/.test(t));
}
// 0..1: share of meaningful words the two names have in common (Jaccard).
export function nameSimilarity(a, b) {
  const A = new Set(nameTokens(a));
  const B = new Set(nameTokens(b));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const t of A) if (B.has(t)) both++;
  return both / (A.size + B.size - both);
}
// Candidates ({ key, label }) best match first, each with its score; only
// the top one counts as a suggestion, and only if it's a clear match.
export function rankRelinkCandidates(oldName, candidates) {
  const ranked = candidates
    .map((c) => ({ ...c, score: nameSimilarity(oldName, c.label) }))
    .sort((x, y) => y.score - x.score);
  const suggested = ranked[0] && ranked[0].score >= 0.5 ? ranked[0].key : null;
  return { ranked, suggested };
}
// "+2.5", "-1", "-0:03.5", "" → seconds (signed), or null if unreadable.
export function parseShift(input) {
  const s = String(input ?? '').trim();
  if (!s) return 0;
  const sign = s.startsWith('-') ? -1 : 1;
  const t = parseTime(s.replace(/^[+-]/, ''));
  return t === null ? null : sign * t;
}

export function pathKey(path) {
  return (path ?? []).join(' › ');
}

export function matchesPath(cue, path) {
  if (!path || cue.groupPath.length !== path.length) return false;
  return cue.groupPath.every((p, i) => p === path[i]);
}

// ─── Filters ────────────────────────────────────────────────────────────────
// Every viewer filters locally (stored per channel in localStorage), so the
// FOH engineer and the stage manager can look at the same show differently.

export function defaultFilters() {
  return { qlab: true, shared: true, private: true, hiddenDepts: [] };
}

export function normalizeFilters(f) {
  const d = defaultFilters();
  if (!f || typeof f !== 'object') return d;
  return {
    qlab: f.qlab !== false,
    shared: f.shared !== false,
    private: f.private !== false,
    hiddenDepts: Array.isArray(f.hiddenDepts) ? f.hiddenDepts.filter((x) => typeof x === 'string') : [],
  };
}

export function passesFilter(cue, filters) {
  if (cue.visibility === 'shared' && !filters.shared) return false;
  if (cue.visibility === 'private' && !filters.private) return false;
  return !filters.hiddenDepts.includes(cue.dept);
}

export function deptsOf(cues) {
  const set = new Set();
  for (const c of cues) set.add(c.dept);
  return [...set].sort((a, b) => (a === NO_DEPT) - (b === NO_DEPT) || a.localeCompare(b));
}

// ─── Timing ─────────────────────────────────────────────────────────────────
//
// Phases relative to the song clock `t` (seconds since the song group started):
//   upcoming  t < at - warn
//   warning   at - warn <= t < at         (highlighted countdown)
//   now       instant cue, at <= t < at + NOW_HOLD_S
//   active    timed cue,   at <= t < at + duration
//   passed    after that — the lane fades out
// Pure function of `t`, so a page reload mid-song lands in the right state.

export function cueState(cue, t) {
  if (t < cue.at) {
    const remaining = cue.at - t;
    return { phase: remaining <= cue.warn ? 'warning' : 'upcoming', remaining, progress: 0 };
  }
  if (cue.duration > 0) {
    const elapsed = t - cue.at;
    if (elapsed < cue.duration) return { phase: 'active', remaining: 0, elapsed, progress: elapsed / cue.duration };
    return { phase: 'passed', remaining: 0, elapsed: cue.duration, progress: 1 };
  }
  if (t < cue.at + NOW_HOLD_S) return { phase: 'now', remaining: 0, progress: 1 };
  return { phase: 'passed', remaining: 0, progress: 1 };
}

export function cueEnd(cue) {
  return cue.at + Math.max(cue.duration, 0);
}

// ─── Song clock ─────────────────────────────────────────────────────────────
//
// Snapshots arrive ~4 Hz; between them we extrapolate so countdowns tick
// smoothly. QLab snapshots carry no "paused" flag, so we only extrapolate
// while the clock is actually advancing between snapshots — a paused song
// produces repeated identical show times and must freeze, not creep forward.

export class SongClock {
  constructor() { this.reset(); }

  reset() {
    this.base = 0;          // show time from the latest snapshot
    this.at = 0;            // when that snapshot arrived (ms)
    this.advancing = false;
    this.key = '';
    this.shown = 0;         // monotonic clamp: never display time going backwards
  }

  // Returns true when the song restarted (or changed), so callers can clear
  // their "already faded" memory.
  update(key, showTime, nowMs) {
    let restarted = false;
    if (key !== this.key) {
      restarted = true;
      this.key = key;
      this.advancing = false;
    } else if (showTime + 2 < this.base) {
      restarted = true;
      this.advancing = false;
    } else {
      this.advancing = showTime > this.base + 1e-3;
    }
    this.base = showTime;
    this.at = nowMs;
    if (restarted) this.shown = showTime;
    return restarted;
  }

  // Extrapolate at most MAX_EXTRAPOLATE_S past the last snapshot: silence
  // means paused or disconnected, and we'd rather freeze than invent time.
  now(nowMs) {
    const raw = this.advancing
      ? this.base + Math.min(MAX_EXTRAPOLATE_S, Math.max(0, (nowMs - this.at) / 1000))
      : this.base;
    this.shown = Math.max(this.shown, raw);
    return this.shown;
  }
}
