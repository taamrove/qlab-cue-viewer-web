// Side drawer: custom cue editor (list / stamp / form / access) and the
// per-viewer filter panel. All state that matters lives elsewhere (relay for
// cues, localStorage for filters); this module is view + intent only, wired up
// through the `ctx` callbacks main.js provides.

import {
  buildCueData, deptsOf, fmtPrecise, NO_DEPT, parseTime, pathKey,
} from './customCues.js';
import { getOwnerKey, setOwnerKey } from './itemsClient.js';

const $ = (id) => document.getElementById(id);
const LAST_DEPT_KEY = 'qlab-viewer.lastDept';

function lsGet(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

export function initDrawer(ctx) {
  const el = {
    drawer: $('drawer'), close: $('drawer-close'),
    tabCues: $('tab-cues'), tabFilter: $('tab-filter'),
    panelCues: $('panel-cues'), panelFilter: $('panel-filter'),
    songSelect: $('song-select'), stamp: $('stamp-btn'), stampTime: $('stamp-time'), stampHint: $('stamp-hint'),
    newBtn: $('new-btn'), list: $('cue-list'), listEmpty: $('cue-list-empty'),
    form: $('cue-form'), formTitle: $('form-title'), formRo: $('form-ro'), formError: $('form-error'),
    fLabel: $('f-label'), fAt: $('f-at'), fDur: $('f-dur'), fWarn: $('f-warn'), fDept: $('f-dept'),
    fVis: $('f-vis'), fSong: $('f-song'), fNote: $('f-note'),
    fDelete: $('f-delete'), fCancel: $('f-cancel'), fSave: $('f-save'),
    deptList: $('dept-list'),
    accessSummary: $('access-summary'), unlockForm: $('unlock-form'), editKey: $('edit-key'), unlockMsg: $('unlock-msg'),
    keyView: $('owner-key-view'), copyKey: $('copy-key'), useKey: $('use-key'),
    keyForm: $('key-form'), keyInput: $('key-input'),
    fltQlab: $('flt-qlab'), fltShared: $('flt-shared'), fltPrivate: $('flt-private'),
    deptChecks: $('dept-checks'), deptAll: $('dept-all'), deptNone: $('dept-none'),
  };

  // `null` = follow whatever song QLab is playing.
  let selectedSong = null;
  // { id: string|null, visibility, readOnly } of the cue in the form.
  let editing = null;
  let deleteArmedUntil = 0;
  let busy = false;

  // ─── open / close / tabs ──────────────────────────────────────────────────

  function open(tab) {
    el.drawer.hidden = false;
    document.body.classList.add('drawer-open');
    showTab(tab);
    refresh();
  }
  function close() {
    el.drawer.hidden = true;
    document.body.classList.remove('drawer-open');
    document.getElementById('cues-btn')?.setAttribute('aria-pressed', 'false');
    closeForm();
  }
  function showTab(tab) {
    const cues = tab === 'cues';
    document.getElementById('cues-btn')?.setAttribute('aria-pressed', String(cues));
    el.panelCues.hidden = !cues;
    el.panelFilter.hidden = cues;
    el.tabCues.classList.toggle('active', cues);
    el.tabFilter.classList.toggle('active', !cues);
    el.tabCues.setAttribute('aria-selected', String(cues));
    el.tabFilter.setAttribute('aria-selected', String(!cues));
  }
  const isOpen = () => !el.drawer.hidden;
  const onCuesTab = () => isOpen() && !el.panelCues.hidden;

  el.close.onclick = close;
  el.tabCues.onclick = () => { showTab('cues'); refresh(); };
  el.tabFilter.onclick = () => { showTab('filter'); refresh(); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) {
      if (!el.form.hidden) closeForm(); else close();
      return;
    }
    // Space stamps while the cue panel is open — fast rehearsal programming
    // without hunting for the button. Ignored while typing.
    const tag = e.target?.tagName;
    if (e.code === 'Space' && onCuesTab() && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tag)) {
      e.preventDefault();
      stamp();
    }
  });

  // ─── helpers ──────────────────────────────────────────────────────────────

  function allPaths() {
    const map = new Map();
    for (const p of ctx.getKnownPaths()) map.set(pathKey(p), p);
    for (const c of ctx.getAllCues()) map.set(pathKey(c.groupPath), c.groupPath);
    const cur = ctx.getCurrentPath();
    if (cur.length) map.set(pathKey(cur), cur);
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }

  function selectedPath() {
    const key = selectedSong ?? pathKey(ctx.getCurrentPath());
    return allPaths().find(([k]) => k === key)?.[1] ?? null;
  }

  function canEdit(cue) {
    if (!cue) return true;
    return cue.visibility === 'shared' ? ctx.items.canEditShared : cue.mine;
  }

  function fillSongOptions(select, value, { follow = false } = {}) {
    const cur = pathKey(ctx.getCurrentPath());
    const opts = [];
    if (follow) opts.push(['', `Follow QLab${cur ? ` (${cur})` : ''}`]);
    for (const [k] of allPaths()) opts.push([k, `${k === cur ? '● ' : ''}${k}`]);
    // Rebuild only when the option set changed, so an open <select> on
    // mobile isn't yanked closed by the 4 Hz refresh.
    const sig = JSON.stringify(opts);
    if (select.dataset.sig !== sig) {
      select.dataset.sig = sig;
      select.replaceChildren(...opts.map(([v, label]) => new Option(label, v)));
    }
    select.value = value;
  }

  // ─── refresh (called on item changes and snapshots) ───────────────────────

  function refresh() {
    if (!isOpen()) return;
    const all = ctx.getAllCues();

    if (!el.panelCues.hidden) {
      fillSongOptions(el.songSelect, selectedSong ?? '', { follow: true });
      const path = selectedPath();
      const cues = path ? all.filter((c) => pathKey(c.groupPath) === pathKey(path)).sort((a, b) => a.at - b.at) : [];
      renderList(cues);
      el.deptList.replaceChildren(...deptsOf(all).filter(Boolean).map((d) => new Option(d)));
      renderAccess();
      tick();
    }
    if (!el.panelFilter.hidden) renderFilters(all);
  }

  function renderList(cues) {
    const sig = JSON.stringify(cues.map((c) => [c.id, c.at, c.label, c.dept, c.visibility, c.mine, c.duration, editing?.id === c.id]));
    if (el.list.dataset.sig === sig) return;
    el.list.dataset.sig = sig;
    el.listEmpty.hidden = cues.length > 0;
    el.list.replaceChildren(...cues.map((c) => {
      const li = document.createElement('li');
      li.className = `cue-row ${c.visibility}${editing?.id === c.id ? ' selected' : ''}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.onclick = () => editCue(c.id);
      const t = document.createElement('span');
      t.className = 'cue-row-time';
      t.textContent = fmtPrecise(c.at) + (c.duration > 0 ? ` +${c.duration}s` : '');
      const icon = document.createElement('span');
      icon.className = 'cue-row-icon';
      icon.textContent = c.visibility === 'private' ? '◆' : '★';
      const label = document.createElement('span');
      label.className = 'cue-row-label';
      label.textContent = c.label;
      const dept = document.createElement('span');
      dept.className = 'cue-row-dept';
      dept.textContent = c.dept;
      btn.append(t, icon, label, dept);
      if (!canEdit(c)) btn.title = 'Read only';
      li.appendChild(btn);
      return li;
    }));
  }

  function renderAccess() {
    el.accessSummary.textContent = ctx.items.canEditShared ? '· can edit shared cues' : '· private cues only';
    const k = getOwnerKey();
    el.keyView.textContent = `••••••••${k.slice(-6)}`;
  }

  // 10 Hz: stamp button clock. Cheap: two text/attr writes.
  function tick() {
    if (!onCuesTab()) return;
    const t = ctx.getSongTime();
    const cur = ctx.getCurrentPath();
    const path = selectedPath();
    const sameSong = path && cur.length && pathKey(path) === pathKey(cur);
    const ok = t !== null && sameSong && !busy;
    el.stamp.disabled = !ok;
    el.stampTime.textContent = t !== null && sameSong ? fmtPrecise(t) : '–:––.–';
    const hint = t === null
      ? 'Stamp works while a song is playing in QLab.'
      : !sameSong ? 'Stamp only works on the song that is playing — switch the song selector back.'
      : `Stamps as ${ctx.items.canEditShared ? '"Everyone"' : '"Only me"'} · Space = stamp`;
    if (el.stampHint.textContent !== hint) el.stampHint.textContent = hint;
  }

  // ─── actions ──────────────────────────────────────────────────────────────

  async function stamp() {
    const t = ctx.getSongTime();
    const path = ctx.getCurrentPath();
    if (t === null || !path.length || busy) return;
    busy = true;
    const visibility = ctx.items.canEditShared ? 'shared' : 'private';
    const data = buildCueData({ groupPath: path, groupId: ctx.groupIdFor?.(path) ?? null, at: t, label: `Cue ${fmtPrecise(t)}`, dept: lsGet(LAST_DEPT_KEY) });
    const res = await ctx.items.upsert({ visibility, data });
    busy = false;
    if (!res.ok) { el.stampHint.textContent = `Couldn't stamp: ${res.error}`; return; }
    // Open the new cue straight away so it can be named while the moment is fresh.
    openForm({ id: res.id, visibility, mine: visibility === 'private', groupPath: path, ...data }, { isNew: true });
  }

  function newCue() {
    const path = selectedPath() ?? ctx.getCurrentPath();
    if (!path?.length) { el.stampHint.textContent = 'No song known yet — play a song in QLab first.'; return; }
    const t = ctx.getSongTime();
    openForm({
      id: null,
      visibility: ctx.items.canEditShared ? 'shared' : 'private',
      mine: true,
      groupPath: path,
      at: t !== null && pathKey(path) === pathKey(ctx.getCurrentPath()) ? Math.round(t * 10) / 10 : 0,
      duration: 0, warn: 10, label: '', dept: lsGet(LAST_DEPT_KEY), note: '',
    }, { isNew: true });
  }

  function editCue(id) {
    const cue = ctx.getAllCues().find((c) => c.id === id);
    if (!cue) return;
    if (!isOpen()) open('cues'); else showTab('cues');
    // Jump the song selector to the cue's song so it shows in context.
    if (pathKey(cue.groupPath) !== pathKey(ctx.getCurrentPath())) selectedSong = pathKey(cue.groupPath);
    openForm(cue);
    refresh();
  }

  function openForm(cue, { isNew = false } = {}) {
    const readOnly = !isNew && !canEdit(cue);
    editing = { id: cue.id, visibility: cue.visibility, readOnly };
    deleteArmedUntil = 0;
    el.form.hidden = false;
    el.formTitle.textContent = cue.id ? 'Edit cue' : 'New cue';
    el.formRo.hidden = !readOnly;
    el.formError.hidden = true;
    el.fLabel.value = cue.label;
    el.fAt.value = fmtPrecise(cue.at);
    el.fDur.value = String(cue.duration ?? 0);
    el.fWarn.value = String(cue.warn ?? 10);
    el.fDept.value = cue.dept ?? '';
    el.fNote.value = cue.note ?? '';
    fillSongOptions(el.fSong, pathKey(cue.groupPath));
    // "Everyone" needs the editor password; keep it selectable only then.
    el.fVis.options[0].disabled = !ctx.items.canEditShared;
    el.fVis.options[0].textContent = ctx.items.canEditShared ? 'Everyone' : 'Everyone (needs editor password)';
    el.fVis.value = cue.visibility;
    for (const f of [el.fLabel, el.fAt, el.fDur, el.fWarn, el.fDept, el.fVis, el.fSong, el.fNote]) f.disabled = readOnly;
    el.fSave.hidden = readOnly;
    el.fDelete.hidden = readOnly || !cue.id;
    el.fDelete.textContent = 'Delete';
    el.fCancel.textContent = readOnly ? 'Close' : 'Cancel';
    el.list.dataset.sig = '';        // re-render to highlight the row
    if (!readOnly) setTimeout(() => { el.fLabel.focus(); el.fLabel.select(); }, 0);
    el.form.scrollIntoView({ block: 'nearest' });
  }

  function closeForm() {
    editing = null;
    el.form.hidden = true;
    el.list.dataset.sig = '';
  }

  function formError(msg) {
    el.formError.textContent = msg;
    el.formError.hidden = false;
  }

  el.form.onsubmit = async (e) => {
    e.preventDefault();
    if (!editing || editing.readOnly || busy) return;
    const at = parseTime(el.fAt.value);
    const duration = el.fDur.value.trim() === '' ? 0 : parseTime(el.fDur.value);
    const warn = el.fWarn.value.trim() === '' ? 0 : parseTime(el.fWarn.value);
    if (at === null) return formError('"At" must be a time like 1:23.5 or 83.5');
    if (duration === null) return formError('Length must be seconds, e.g. 8 or 0:08');
    if (warn === null) return formError('Warn must be seconds, e.g. 10');
    const path = allPaths().find(([k]) => k === el.fSong.value)?.[1];
    if (!path) return formError('Pick a song');
    const visibility = el.fVis.value;
    const dept = el.fDept.value.trim();
    const data = buildCueData({ groupPath: path, groupId: ctx.groupIdFor?.(path) ?? null, at, duration, warn, label: el.fLabel.value, dept, note: el.fNote.value });
    busy = true;
    el.fSave.disabled = true;
    const res = await ctx.items.upsert({ id: editing.id ?? undefined, visibility, data });
    busy = false;
    el.fSave.disabled = false;
    if (!res.ok) return formError(res.error);
    if (dept) lsSet(LAST_DEPT_KEY, dept);
    closeForm();
    refresh();
  };

  el.fCancel.onclick = closeForm;

  // Two-step delete instead of confirm(): a blocking dialog in the middle of
  // a show is worse than an extra tap.
  el.fDelete.onclick = async () => {
    if (!editing?.id) return;
    if (Date.now() > deleteArmedUntil) {
      deleteArmedUntil = Date.now() + 3000;
      el.fDelete.textContent = 'Tap again to delete';
      setTimeout(() => { if (Date.now() > deleteArmedUntil) el.fDelete.textContent = 'Delete'; }, 3100);
      return;
    }
    const res = await ctx.items.remove(editing.id);
    if (!res.ok) return formError(res.error);
    closeForm();
    refresh();
  };

  el.stamp.onclick = stamp;
  el.newBtn.onclick = newCue;
  el.songSelect.onchange = () => {
    selectedSong = el.songSelect.value || null;
    closeForm();
    refresh();
  };

  // ─── access ───────────────────────────────────────────────────────────────

  el.editKey.value = ctx.getEditKey();
  el.unlockForm.onsubmit = async (e) => {
    e.preventDefault();
    const key = el.editKey.value;
    el.unlockMsg.textContent = 'Checking…';
    const ok = await ctx.items.relogin(key);
    ctx.setEditKey(ok ? key : '');
    el.unlockMsg.textContent = ok
      ? 'Unlocked: you can edit cues everyone sees.'
      : key ? 'Wrong editor password.' : 'Locked: private cues only.';
    if (!ok) el.editKey.value = '';
    refresh();
  };

  // Copy / switch the private key inline: browser prompt() dialogs are
  // blocked in sandboxed hosts (and are clumsy on phones anyway).
  el.copyKey.onclick = async () => {
    try {
      await navigator.clipboard.writeText(getOwnerKey());
      el.unlockMsg.textContent = 'Private key copied. Paste it under "Use another…" on your other device.';
    } catch {
      el.keyForm.hidden = false;
      el.keyInput.value = getOwnerKey();
      el.keyInput.select();
      el.unlockMsg.textContent = 'Select and copy the key above.';
    }
  };
  el.useKey.onclick = () => {
    el.keyForm.hidden = !el.keyForm.hidden;
    el.keyInput.value = '';
    if (!el.keyForm.hidden) el.keyInput.focus();
  };
  el.keyForm.onsubmit = async (e) => {
    e.preventDefault();
    const k = el.keyInput.value.trim();
    if (!k || k === getOwnerKey()) { el.keyForm.hidden = true; return; }
    try { setOwnerKey(k); } catch (err) { el.unlockMsg.textContent = err.message; return; }
    el.keyForm.hidden = true;
    await ctx.items.relogin();
    el.unlockMsg.textContent = 'Private key switched. Your "Only me" cues from that device are shown now.';
    refresh();
  };

  // ─── filters ──────────────────────────────────────────────────────────────

  function renderFilters(all) {
    const f = ctx.getFilters();
    el.fltQlab.checked = f.qlab;
    el.fltShared.checked = f.shared;
    el.fltPrivate.checked = f.private;
    const depts = deptsOf(all);
    const sig = JSON.stringify([depts, f.hiddenDepts]);
    if (el.deptChecks.dataset.sig === sig) return;
    el.deptChecks.dataset.sig = sig;
    if (depts.length === 0) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Departments appear here once custom cues have one.';
      el.deptChecks.replaceChildren(p);
      return;
    }
    el.deptChecks.replaceChildren(...depts.map((d) => {
      const label = document.createElement('label');
      label.className = 'check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !f.hiddenDepts.includes(d);
      cb.onchange = () => {
        const cur = ctx.getFilters();
        const hidden = new Set(cur.hiddenDepts);
        if (cb.checked) hidden.delete(d); else hidden.add(d);
        ctx.setFilters({ ...cur, hiddenDepts: [...hidden] });
      };
      const name = document.createElement('span');
      name.textContent = d === NO_DEPT ? '(no department)' : d;
      if (d === NO_DEPT) name.className = 'dim';
      label.append(cb, ' ', name);
      return label;
    }));
  }

  const setFlag = (k) => (e) => ctx.setFilters({ ...ctx.getFilters(), [k]: e.target.checked });
  el.fltQlab.onchange = setFlag('qlab');
  el.fltShared.onchange = setFlag('shared');
  el.fltPrivate.onchange = setFlag('private');
  el.deptAll.onclick = () => ctx.setFilters({ ...ctx.getFilters(), hiddenDepts: [] });
  el.deptNone.onclick = () => ctx.setFilters({ ...ctx.getFilters(), hiddenDepts: deptsOf(ctx.getAllCues()) });

  return { open, close, refresh, tick, editCue, isOpen };
}
