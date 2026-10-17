// DOM lane for a custom cue. Same 3-column grid as the QLab Lane in main.js
// (head | track | time) so both kinds line up on one ruler, but driven by a
// shared song clock instead of per-cue QLab elapsed values: a custom cue has
// no QLab-side state at all, its position is purely `at` on the song clock.

import { cueState, fmtCountdown, fmtPrecise } from './customCues.js';

export const CUSTOM_COLOR = '#4fd1c5';     // teal: distinct from every QLab type colour
export const PRIVATE_COLOR = '#c084fc';    // violet for private cues

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

  build() {
    const color = this.cue.visibility === 'private' ? PRIVATE_COLOR : CUSTOM_COLOR;
    const lane = document.createElement('div');
    lane.className = `lane custom ${this.isInstant ? 'instant' : 'timed'}`;
    lane.style.setProperty('--custom-color', color);
    lane.tabIndex = 0;
    lane.setAttribute('role', 'button');
    lane.addEventListener('click', () => this.onClick?.(this.cue.id));
    lane.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.onClick?.(this.cue.id);
    });

    const head = document.createElement('div');
    head.className = 'lane-head';
    const icon = document.createElement('span');
    icon.className = 'lane-icon';
    const name = document.createElement('span');
    name.className = 'lane-name';
    const tag = document.createElement('span');
    tag.className = 'lane-num lane-dept';
    head.append(icon, name, tag);

    const track = document.createElement('div');
    track.className = 'lane-track';
    // On phones the head column collapses to the icon, so the label is
    // repeated next to the marker — a custom cue without its text is useless.
    const inline = document.createElement('span');
    inline.className = 'custom-inline-label';

    if (this.isInstant) {
      const flag = document.createElement('div');
      flag.className = 'flag';
      flag.style.setProperty('--color', color);
      track.append(flag, inline);
      this.flagEl = flag;
    } else {
      const bar = document.createElement('div');
      bar.className = 'bar custom-bar';
      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      bar.appendChild(fill);
      track.append(bar, inline);
      this.barEl = bar;
      this.fillEl = fill;
    }

    const time = document.createElement('div');
    time.className = 'lane-time';
    lane.append(head, track, time);

    Object.assign(this, { el: lane, iconEl: icon, nameEl: name, tagEl: tag, inlineEl: inline, timeEl: time });
    this.applyText();
  }

  applyText() {
    const c = this.cue;
    this.iconEl.textContent = c.visibility === 'private' ? '◆' : '★';
    this.iconEl.style.color = c.visibility === 'private' ? PRIVATE_COLOR : CUSTOM_COLOR;
    this.iconEl.title = c.visibility === 'private' ? 'Private cue (only you)' : 'Shared custom cue';
    this.nameEl.textContent = c.label;
    this.inlineEl.textContent = c.label;
    this.tagEl.textContent = c.dept;
    this.el.title = [c.label, c.dept && `[${c.dept}]`, `@ ${fmtPrecise(c.at)}`, c.note].filter(Boolean).join('  ');
  }

  applyPositioning() {
    const left = this.maxTime > 0 ? (this.cue.at / this.maxTime) * 100 : 0;
    if (this.isInstant) {
      this.flagEl.style.left = `${left}%`;
    } else {
      this.barEl.style.left = `${left}%`;
      this.barEl.style.width = this.maxTime > 0 ? `${(this.cue.duration / this.maxTime) * 100}%` : '0%';
    }
    // Keep the inline label inside the track: after the marker (or after the
    // bar's end for timed cues), or before it when that's too far right.
    const end = this.isInstant || !(this.maxTime > 0)
      ? left
      : ((this.cue.at + this.cue.duration) / this.maxTime) * 100;
    const leftSide = end > 60;
    this.inlineEl.style.left = leftSide ? '' : `calc(${end}% + ${this.isInstant ? 14 : 8}px)`;
    this.inlineEl.style.right = leftSide ? `calc(${100 - left}% + 14px)` : '';
  }

  // Returns true if instant/duration type changed, meaning the caller must
  // rebuild the lane (the track DOM differs).
  setCue(cue) {
    const typeChanged = (cue.duration > 0) !== (this.cue.duration > 0) || cue.visibility !== this.cue.visibility;
    const moved = cue.at !== this.cue.at || cue.duration !== this.cue.duration;
    this.cue = cue;
    if (typeChanged) return true;
    this.applyText();
    if (moved) this.applyPositioning();
    return false;
  }

  setMaxTime(maxTime) {
    if (maxTime === this.maxTime) return;
    this.maxTime = maxTime;
    this.applyPositioning();
  }

  // Called by the shared 10 Hz ticker with the current song time.
  update(t) {
    const s = cueState(this.cue, t);
    if (s.phase !== this.phase) {
      this.phase = s.phase;
      for (const p of ['upcoming', 'warning', 'now', 'active', 'passed']) {
        this.el.classList.toggle(`is-${p}`, p === s.phase);
      }
      this.el.classList.toggle('fired', s.phase === 'passed');
    }
    let text;
    switch (s.phase) {
      case 'upcoming':
      case 'warning': text = `in ${fmtCountdown(s.remaining)}`; break;
      case 'now':     text = 'NOW'; break;
      case 'active':  text = `${fmtCountdown(s.elapsed)} / ${fmtCountdown(this.cue.duration)}`; break;
      default:        text = 'done';
    }
    if (text !== this._text) { this._text = text; this.timeEl.textContent = text; }

    if (this.flagEl) {
      // Same visual language as QLab instant cues: the head grows as the
      // countdown runs out, but only inside the warning window.
      const w = this.cue.warn > 0 ? this.cue.warn : 5;
      const k = s.phase === 'warning' ? 1 - s.remaining / w : s.phase === 'upcoming' ? 0 : 1;
      this.flagEl.style.setProperty('--countdown', Math.max(0, Math.min(1, k)).toFixed(3));
    }
    if (this.fillEl) this.fillEl.style.width = `${(s.progress * 100).toFixed(2)}%`;
    return s.phase;
  }

  fadeOut(ms) {
    this.el.style.setProperty('--fade-ms', `${ms}ms`);
    this.el.classList.add('removing');
    setTimeout(() => this.el.remove(), ms);
  }
}
