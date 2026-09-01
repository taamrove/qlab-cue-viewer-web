// SMPTE timecode helpers, shared by the readout and the LTC generator.
//
// Everything works in absolute frame counts so extrapolation is just addition.
// Drop-frame only affects how a count maps back to HH:MM:SS:FF — it drops the
// first two frame numbers of every minute except every tenth, to keep 29.97 fps
// material honest against wall clock. The SDV masters are 25 fps non-drop, but
// the maths is here so a 29.97 show doesn't quietly display the wrong number.

export function parseTimecode(text) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec((text ?? '').trim());
  if (!m) return null;
  return { h: +m[1], m: +m[2], s: +m[3], f: +m[4] };
}

export function formatTimecode(tc) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(tc.h)}:${p(tc.m)}:${p(tc.s)}:${p(tc.f)}`;
}

export function tcToFrames(tc, fps, drop) {
  const nominal = Math.round(fps) || 25;
  const totalMinutes = tc.h * 60 + tc.m;
  const straight = ((totalMinutes * 60) + tc.s) * nominal + tc.f;
  if (!drop || nominal !== 30) return straight;
  return straight - 2 * (totalMinutes - Math.floor(totalMinutes / 10));
}

export function framesToTc(frames, fps, drop) {
  const nominal = Math.round(fps) || 25;
  let n = Math.max(0, Math.round(frames));

  if (drop && nominal === 30) {
    // 17982 frames = 10 minutes of 29.97; 1798 = one dropping minute.
    const tenMinBlocks = Math.floor(n / 17982);
    let rem = n % 17982;
    if (rem < 2) rem += 2;
    n = n + 18 * tenMinBlocks + 2 * Math.floor((rem - 2) / 1798);
    return {
      h: Math.floor(n / 108000) % 24,
      m: Math.floor(n / 1800) % 60,
      s: Math.floor(n / 30) % 60,
      f: n % 30,
    };
  }

  return {
    h: Math.floor(n / (3600 * nominal)) % 24,
    m: Math.floor(n / (60 * nominal)) % 60,
    s: Math.floor(n / nominal) % 60,
    f: n % nominal,
  };
}
