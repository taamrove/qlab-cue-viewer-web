import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTime, fmtPrecise, fmtCountdown, normalizeCue, buildCueData, matchesPath,
  passesFilter, normalizeFilters, deptsOf, cueState, SongClock, NOW_HOLD_S,
  normalizePrecue, buildPrecueData, itemTime, flattenWorkspace,
  nameTokens, nameSimilarity, rankRelinkCandidates, parseShift,
} from '../src/customCues.js';

const item = (data, extra = {}) => ({ id: 'c1', visibility: 'shared', mine: false, data, ...extra });
const cueData = (o = {}) => buildCueData({ target: { groupPath: ['SHOW 1', 'SANG 3'] }, at: 42, label: 'Pyro', ...o });

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
  assert.equal(clk.now(5000), 11.0);                  // capped at +0.75 s (paused = silent bridge)
  clk.update(k, 10.3, 600);                           // pause: tiny advance then freeze
  clk.update(k, 10.3, 850);
  assert.equal(clk.now(2000), 11.0, 'clamped, does not jump backwards');
  assert.equal(clk.update(k, 0.2, 900), true, 'restart detected');
  assert.equal(clk.now(900), 0.2);
  assert.equal(clk.update('SHOW 1 › SANG 4', 0, 1000), true, 'song change detected');
});

test('anchor.groupId round-trips and is optional', () => {
  const withId = buildCueData({ target: { groupPath: ['S', 'SANG 3'], groupId: 'ABC-123' }, at: 5, label: 'x' });
  assert.deepEqual(withId.anchor, { groupPath: ['S', 'SANG 3'], groupId: 'ABC-123' });
  assert.equal(normalizeCue({ id: 'a', data: withId }).groupId, 'ABC-123');
  const noId = buildCueData({ target: { groupPath: ['S', 'SANG 3'] }, at: 5, label: 'x' });
  assert.deepEqual(noId.anchor, { groupPath: ['S', 'SANG 3'] });
  assert.equal(normalizeCue({ id: 'b', data: noId }).groupId, null);
  assert.equal(normalizeCue({ id: 'c', data: { ...noId, anchor: { groupPath: ['S'], groupId: 7 } } }).groupId, null);
});

test('item anchors: tied to a QLab cue id, keyed separately from groups', () => {
  const d = buildCueData({ target: { cueId: 'Q-FEVER', cueName: 'SDV_Fever.mp4' }, at: 12.5, label: 'Confetti' });
  assert.deepEqual(d.anchor, { cueId: 'Q-FEVER', cueName: 'SDV_Fever.mp4' });
  const c = normalizeCue({ id: 'i', data: d });
  assert.equal(c.cueId, 'Q-FEVER');
  assert.equal(c.target, 'cue:Q-FEVER');
  assert.equal(c.groupPath, null);
  assert.equal(normalizeCue({ id: 'g', data: cueData() }).target, 'grp:SHOW 1 › SANG 3');
  assert.equal(normalizeCue({ id: 'x', data: { ...d, anchor: {} } }), null);
});

test('pre-cues: validated to-dos tied to an item', () => {
  const d = buildPrecueData({ target: { cueId: 'Q1', cueName: 'Fever' }, text: '  Swap HH mic  ' });
  assert.deepEqual(d, { kind: 'precue', anchor: { cueId: 'Q1', cueName: 'Fever' }, text: 'Swap HH mic', done: false, dept: '' });
  const p = normalizePrecue({ id: 'p', visibility: 'private', mine: true, data: { ...d, done: true } });
  assert.equal(p.done, true); assert.equal(p.target, 'cue:Q1'); assert.equal(p.mine, true);
  assert.equal(normalizePrecue({ id: 'e', data: { ...d, text: '   ' } }), null);
  assert.equal(normalizePrecue({ id: 'k', data: cueData() }), null, 'a cue is not a pre-cue');
  assert.equal(normalizeCue({ id: 'k', data: d }), null, 'a pre-cue is not a cue');
  assert.equal(buildPrecueData({ target: { cueId: 'Q' }, text: 'x'.repeat(400) }).text.length, 300);
});

test('itemTime: action elapsed, negative through pre-wait, null when not ticking', () => {
  assert.equal(itemTime({ preWait: 5, preWaitElapsed: 2, elapsed: 0 }), -3);
  assert.equal(itemTime({ preWait: 5, preWaitElapsed: 5, elapsed: 4.5 }), 4.5);
  assert.equal(itemTime({ preWait: 0, elapsed: 30 }), 30);
  assert.equal(itemTime({ preWait: 5, preWaitElapsed: 0, elapsed: 0 }), null);
  assert.equal(itemTime({}), null);
});

test('flattenWorkspace keeps order and ancestor names', () => {
  const tree = [
    { id: 'g1', name: 'SHOW 2', cues: [{ id: 'a', name: 'LaVie.mp4', type: 'Video', duration: 185 }, { id: 'b', name: 'Fever.mp4', type: 'Video', duration: 157 }] },
    { id: 'g2', name: 'SHOW 5', cues: [{ id: 'm', name: 'Medusa', cues: [{ id: 'w', name: 'Medusa.wav', type: 'Audio' }] }] },
  ];
  const flat = flattenWorkspace(tree);
  assert.deepEqual(flat.map((x) => x.id), ['a', 'b', 'w']);
  assert.deepEqual(flat[1].path, ['SHOW 2']);
  assert.deepEqual(flat[2].path, ['SHOW 5', 'Medusa']);
  assert.deepEqual(flat[2].groupIds, ['g2', 'm']);
});

test('relink: names compare on meaningful words, not production boilerplate', () => {
  assert.deepEqual(nameTokens('SDV_Fever_INST_XOA.mp4'), ['fever']);
  assert.deepEqual(nameTokens('SDV_DuskTillDawn_INST(Kim Rune & Kaja)_Semming.mp4'), ['dusktilldawn', 'kim', 'rune', 'kaja', 'semming']);
  assert.equal(nameSimilarity('SDV_Fever_INST_XOA.mp4', 'SDV_Fever_INST_v2_XOA.mov'), 1);
  assert.equal(nameSimilarity('SDV_Fever_INST_XOA.mp4', 'SDV_LaVieEnRose_INST_XOA.mp4'), 0);
  const { ranked, suggested } = rankRelinkCandidates('SDV_Natural_NST(Lang intro)(Kim Rune)_Semming.mp4', [
    { key: 'a', label: 'SDV_Unstoppable_XOA.mp4' },
    { key: 'b', label: 'SDV_Natural_NST(Kort intro)(Kim Rune)_Semming_v3.mp4' },
    { key: 'c', label: 'SDV_Boom_Med_WalkOff_XOA.mp4' },
  ]);
  assert.equal(suggested, 'b');
  assert.equal(ranked[0].key, 'b');
  assert.equal(rankRelinkCandidates('SDV_Fever.mp4', [{ key: 'x', label: 'SDV_Boom.mp4' }]).suggested, null, 'no weak suggestions');
});

test('parseShift: signed seconds or m:ss', () => {
  assert.equal(parseShift(''), 0);
  assert.equal(parseShift('+2.5'), 2.5);
  assert.equal(parseShift('-1'), -1);
  assert.equal(parseShift('-0:03.5'), -3.5);
  assert.equal(parseShift('abc'), null);
});
