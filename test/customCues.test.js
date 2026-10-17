import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTime, fmtPrecise, fmtCountdown, normalizeCue, buildCueData, matchesPath,
  passesFilter, normalizeFilters, deptsOf, cueState, SongClock, NOW_HOLD_S,
} from '../src/customCues.js';

const item = (data, extra = {}) => ({ id: 'c1', visibility: 'shared', mine: false, data, ...extra });
const cueData = (o = {}) => buildCueData({ groupPath: ['SHOW 1', 'SANG 3'], at: 42, label: 'Pyro', ...o });

test('parseTime accepts seconds, m:ss and h:mm:ss; rejects junk', () => {
  assert.equal(parseTime('83.5'), 83.5);
  assert.equal(parseTime('1:23.5'), 83.5);
  assert.equal(parseTime('1:23,5'), 83.5);
  assert.equal(parseTime('1:02:03'), 3723);
  assert.equal(parseTime(12), 12);
  for (const bad of ['', 'abc', '1:2:3x', '-5', '1::2', null]) assert.equal(parseTime(bad), null, String(bad));
});

test('formatting', () => {
  assert.equal(fmtPrecise(83.54), '1:23.5');
  assert.equal(fmtPrecise(0), '0:00.0');
  assert.equal(fmtCountdown(0.2), '0:01');
  assert.equal(fmtCountdown(61), '1:01');
  assert.equal(fmtCountdown(-3), '0:00');
});

test('normalizeCue validates untrusted items', () => {
  const c = normalizeCue(item(cueData({ dept: ' SFX ', warn: 5 })));
  assert.equal(c.at, 42); assert.equal(c.dept, 'SFX'); assert.equal(c.warn, 5); assert.equal(c.duration, 0);
  assert.equal(normalizeCue(item({ kind: 'note' })), null);
  assert.equal(normalizeCue(item({ ...cueData(), at: -1 })), null);
  assert.equal(normalizeCue(item({ ...cueData(), anchor: { groupPath: [] } })), null);
  assert.equal(normalizeCue(item({ ...cueData(), anchor: { groupPath: [1] } })), null);
  assert.equal(normalizeCue(item({ ...cueData(), label: '  ' })).label, 'Cue');
  assert.equal(normalizeCue(item(cueData(), { visibility: 'private', mine: true })).mine, true);
});

test('matchesPath requires exact group path', () => {
  const c = normalizeCue(item(cueData()));
  assert.ok(matchesPath(c, ['SHOW 1', 'SANG 3']));
  assert.ok(!matchesPath(c, ['SHOW 1', 'SANG 4']));
  assert.ok(!matchesPath(c, ['SANG 3']));
  assert.ok(!matchesPath(c, []));
});

test('filters: visibility toggles and departments', () => {
  const shared = normalizeCue(item(cueData({ dept: 'SFX' })));
  const priv = normalizeCue(item(cueData(), { visibility: 'private', mine: true }));
  const f = normalizeFilters({});
  assert.ok(passesFilter(shared, f) && passesFilter(priv, f));
  assert.ok(!passesFilter(shared, { ...f, shared: false }));
  assert.ok(!passesFilter(priv, { ...f, private: false }));
  assert.ok(!passesFilter(shared, { ...f, hiddenDepts: ['SFX'] }));
  assert.ok(!passesFilter(priv, { ...f, hiddenDepts: [''] }));
  assert.deepEqual(deptsOf([shared, priv]), ['SFX', '']);
  assert.deepEqual(normalizeFilters({ qlab: false, hiddenDepts: ['x', 3] }), { qlab: false, shared: true, private: true, hiddenDepts: ['x'] });
});

test('cueState phases for instant cues', () => {
  const c = normalizeCue(item(cueData({ at: 30, warn: 10 })));
  assert.equal(cueState(c, 0).phase, 'upcoming');
  assert.equal(cueState(c, 20).phase, 'warning');
  assert.equal(cueState(c, 25).remaining, 5);
  assert.equal(cueState(c, 30).phase, 'now');
  assert.equal(cueState(c, 30 + NOW_HOLD_S - 0.01).phase, 'now');
  assert.equal(cueState(c, 30 + NOW_HOLD_S).phase, 'passed');
});

test('cueState phases for timed cues', () => {
  const c = normalizeCue(item(cueData({ at: 10, duration: 8, warn: 0 })));
  assert.equal(cueState(c, 9.9).phase, 'upcoming');
  const s = cueState(c, 14);
  assert.equal(s.phase, 'active'); assert.equal(s.progress, 0.5);
  assert.equal(cueState(c, 18).phase, 'passed');
});

test('SongClock extrapolates only while advancing, never goes backwards, detects restart', () => {
  const k = 'SHOW 1 › SANG 3';
  const clk = new SongClock();
  assert.equal(clk.update(k, 10, 0), true);          // first sight counts as a change
  assert.equal(clk.now(500), 10);                     // not yet known to be advancing
  clk.update(k, 10.25, 250);
  assert.equal(clk.now(500), 10.5);                   // extrapolates
  assert.equal(clk.now(5000), 11.25);                 // capped at +1 s
  clk.update(k, 10.3, 600);                           // pause: tiny advance then freeze
  clk.update(k, 10.3, 850);
  assert.equal(clk.now(2000), 11.25, 'clamped, does not jump backwards');
  assert.equal(clk.update(k, 0.2, 900), true, 'restart detected');
  assert.equal(clk.now(900), 0.2);
  assert.equal(clk.update('SHOW 1 › SANG 4', 0, 1000), true, 'song change detected');
});
