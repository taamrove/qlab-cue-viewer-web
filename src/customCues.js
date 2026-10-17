// Custom cues — pure logic (no DOM, no network) so it can be unit-tested
// with `node --test` and reused by the renderer and the editor.
//
// A custom cue is a relay "item" whose data looks like:
//   {
//     kind: "cue",
//     anchor: { groupPath: ["SHOW 1", "SANG 3"] },  // the song it belongs to
//     at: 42.5,          // seconds after that song group started
//     duration: 0,       // 0 = instant (flag), >0 = span (bar)
//     warn: 10,          // seconds of highlighted countdown before `at`
//     label: "Pyro ready",
//     dept: "SFX",       // optional, used for filtering
//     note: "",          // optional free text
//   }
//
// Anchoring: `anchor.groupId` is the song group's QLab uniqueID (bridges that
// send `groupIds` alongside `groupPath`), `anchor.groupPath` its names. The ID
// wins when both sides have one, so renaming a song in QLab doesn't detach its
// cues; the path is the fallback for older bridges and older cues.

export const NOW_HOLD_S = 2;
// The bridge publishes only when something changed (it dedupes identical
// snapshots), so a paused QLab goes silent. Never project further than this
// past the last snapshot: ~3 poll intervals at 4 Hz.
export const MAX_EXTRAPOLATE_S = 0.75;        // how long an instant cue shows "NOW"
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
export function normalizeCue(item) {
  const d = item?.data;
  if (!d || d.kind !== 'cue') return null;
  const path = d.anchor?.groupPath;
  if (!Array.isArray(path) || path.length === 0 || !path.every((p) => typeof p === 'string')) return null;
  const at = num(d.at, null);
  if (at === null) return null;
  return {
    id: item.id,
    visibility: item.visibility === 'private' ? 'private' : 'shared',
    mine: !!item.mine,
    groupPath: path,
    groupId: typeof d.anchor?.groupId === 'string' && d.anchor.groupId ? d.anchor.groupId : null,
    at,
    duration: num(d.duration, 0),
    warn: num(d.warn, DEFAULT_WARN_S),
    label: typeof d.label === 'string' && d.label.trim() ? d.label.trim() : 'Cue',
    dept: typeof d.dept === 'string' ? d.dept.trim() : NO_DEPT,
    note: typeof d.note === 'string' ? d.note : '',
    updatedAt: item.updatedAt ?? 0,
  };
}

export function buildCueData({ groupPath, groupId = null, at, duration = 0, warn = DEFAULT_WARN_S, label, dept = '', note = '' }) {
  return {
    kind: 'cue',
    anchor: groupId ? { groupPath: [...groupPath], groupId } : { groupPath: [...groupPath] },
    at: Math.round(at * 100) / 100,
    duration: Math.round(Math.max(0, duration) * 100) / 100,
    warn: Math.max(0, warn),
    label: String(label ?? '').trim() || 'Cue',
    dept: String(dept ?? '').trim(),
    note: String(note ?? ''),
  };
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
