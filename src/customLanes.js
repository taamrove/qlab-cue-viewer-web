// DOM lane for a custom cue, built to the same anatomy as the QLab Lane in
// main.js so both read as one timeline:
//
//   head:  icon + MM:SS countdown            (what the operator scans)
//   track: flag or bar at the cue point, the label anchored AT that point
//          (via --cue-left), and the inline countdown on the opposite side
//
// It reuses the QLab lane's positioning classes (right-anchored,
// cue-near-head, cue-near-end) so labels flip and tuck exactly like QLab
// cues. Unlike a QLab lane it has no QLab-side counters: its state is a pure
// function of the shared song clock (see cueState in customCues.js).

import { cueState } from './customCues.js';

export const CUSTOM_COLOR = '#4fd1c5';     // teal: distinct from every QLab type colour
export const PRIVATE_COLOR = '#c084fc';    // violet for private cues

function mmss(seconds) {
  const s = Math.max(0, Math.ceil(seconds - 1e-6));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export class CustomLane {
  constructor(cue, maxTime, { onClick } = {}) {
    this.cue = cue;
    this.maxTime = maxTime;
    this.onClick = onClick;
    this.phase = null;
    this.build();
    this.applyPositioning();
  }

  get isInstant() { return !(this.cue.duration > 0); }
  get color() { return this.cue.visibility === 'private' ? PRIVATE_COLOR : CUSTOM_COLOR; }

  build() {
    const lane = document.createElement('div');
    lane.className = `lane custom ${this.isInstant ? 'instant' : 'timed'}`;
    lane.style.setProperty('--custom-color', this.color);
    lane.tabIndex = 0;
    lane.setAttribute('role', 'button');
    lane.addEventListener('click', () => this.onClick?.(this.cue.id));
    lane.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.onClick?.(this.cue.id); });

    const head = document.createElement('div');
    head.className = 'lane-head';
    const icon = document.createElement('span');
    icon.className = 'lane-icon';
    const countdown = document.createElement('span');
    countdown.className = 'lane-countdown';
    countdown.textContent = '--:--';
    head.append(icon, countdown);

    const track = document.createElement('div');
    track.className = 'lane-track';
    if (this.isInstant) {
      const flag = document.createElement('div');
      flag.className = 'flag';
      flag.style.setProperty('--color', this.color);
      flag.style.setProperty('--countdown', '0');
      track.appendChild(flag);
      this.flagEl = flag;
    } else {
      const bar = document.createElement('div');
      bar.className = 'bar custom-bar';
      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      bar.appendChild(fill);
      track.appendChild(bar);
      this.barEl = bar;
      this.fillEl = fill;
    }

    // Same structure as the QLab lane's name-at-point, but with its own name
    // class: phones hide `.lane-name` for QLab cues, and a custom cue
    // without its label is meaningless, so this one always shows.
    const nameWrap = document.createElement('div');
    nameWrap.className = 'lane-name-at-point';
    const timeEdge = document.createElement('span');
    timeEdge.className = 'lane-time-edge';
    const name = document.createElement('span');
    name.className = 'custom-name';
    const dept = document.createElement('span');
    dept.className = 'custom-dept';
    nameWrap.append(timeEdge, name, dept);
    track.appendChild(nameWrap);

    const timeInline = document.createElement('div');
    timeInline.className = 'lane-time-inline';
    track.appendChild(timeInline);

    lane.append(head, track);
    Object.assign(this, {
      el: lane, iconEl: icon, countdownEl: countdown, trackEl: track,
      nameEl: name, deptEl: dept, timeEdgeEl: timeEdge, timeInlineEl: timeInline,
    });
    this.applyText();
  }

  applyText() {
    const c = this.cue;
    const priv = c.visibility === 'private';
    this.iconEl.textContent = priv ? '◆' : '★';
    this.iconEl.style.color = this.color;
    this.iconEl.title = priv ? 'Private cue (only you)' : 'Shared custom cue';
    this.nameEl.textContent = c.label;
    this.deptEl.textContent = c.dept;
    this.el.title = [c.label, c.dept && `[${c.dept}]`, c.note].filter(Boolean).join('  ');
  }

  applyPositioning() {
    const left = this.maxTime > 0 ? (this.cue.at / this.maxTime) * 100 : 0;
    this.trackEl.style.setProperty('--cue-left', `${left}%`);
    this.el.classList.toggle('right-anchored', left > 55);
    this.el.classList.toggle('cue-near-head', left < 4);
    this.el.classList.toggle('cue-near-end', left > 92);
    if (this.isInstant) {
      this.flagEl.style.left = `${left}%`;
    } else {
      this.barEl.style.left = `${left}%`;
      this.barEl.style.width = this.maxTime > 0 ? `${(this.cue.duration / this.maxTime) * 100}%` : '0%';
    }
  }

  // Returns true if the caller must rebuild (instant↔timed or visibility
  // changed: the track DOM / colour differ).
  setCue(cue) {
    const rebuild = (cue.duration > 0) !== (this.cue.duration > 0) || cue.visibility !== this.cue.visibility;
    const moved = cue.at !== this.cue.at || cue.duration !== this.cue.duration;
    this.cue = cue;
    if (rebuild) return true;
    this.applyText();
    if (moved) this.applyPositioning();
    return false;
  }

  setMaxTime(maxTime) {
    if (maxTime === this.maxTime) return;
    this.maxTime = maxTime;
    this.applyPositioning();
  }

  setText(t) {
    if (t === this._text) return;
    this._text = t;
    this.countdownEl.textContent = t;
    this.timeInlineEl.textContent = t;
    this.timeEdgeEl.textContent = t;
  }

  // Called by the shared 10 Hz ticker with this cue's song time.
  update(t) {
    const s = cueState(this.cue, t);
    if (s.phase !== this.phase) {
      this.phase = s.phase;
      for (const p of ['upcoming', 'warning', 'now', 'active', 'passed']) {
        this.el.classList.toggle(`is-${p}`, p === s.phase);
      }
      // Map onto the QLab lane's state classes so shared styling applies.
      this.el.classList.toggle('waiting', s.phase === 'upcoming' || s.phase === 'warning');
      this.el.classList.toggle('playing', s.phase === 'active');
      this.el.classList.toggle('fired', s.phase === 'passed');
    }
    switch (s.phase) {
      case 'upcoming':
      case 'warning': this.setText(mmss(s.remaining)); break;
      case 'now':     this.setText('NOW'); break;
      case 'active':  this.setText(mmss(this.cue.duration - s.elapsed)); break;
      default:        this.setText('--:--');
    }
    if (this.flagEl) {
      const w = this.cue.warn > 0 ? this.cue.warn : 5;
      const k = s.phase === 'warning' ? 1 - s.remaining / w : s.phase === 'upcoming' ? 0 : 1;
      this.flagEl.style.setProperty('--countdown', Math.max(0, Math.min(1, k)).toFixed(3));
    }
    if (this.fillEl) this.fillEl.style.width = `${(s.progress * 100).toFixed(2)}%`;
    return s.phase;
  }

  fadeOut(ms) {
    this.el.style.setProperty('--fade-ms', `${ms}ms`);
    this.el.parentElement?.appendChild(this.el);     // collapse at the bottom, like QLab lanes
    this.el.classList.add('removing');
    setTimeout(() => this.el.remove(), ms);
  }
}
