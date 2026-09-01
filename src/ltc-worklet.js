// Generates SMPTE LTC on the audio thread.
//
// Biphase-mark: flip the level at every bit boundary, and once more mid-bit for
// a '1'. So one frame is 160 half-slots, and generating audio is just reading
// out a precomputed level per slot — no per-sample branching, no allocation.
//
// The parity bit is deliberately left at 0. The show's own masters leave every
// candidate parity bit clear, so whatever consumes this timecode downstream
// already accepts frames without it, and matching what the gear is used to
// beats being pedantically correct against the spec.
//
// This file is loaded with addModule() and must stay import-free — hence the
// small amount of timecode arithmetic duplicated from timecode.js.

const SYNC = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];
const AMPLITUDE = 0.5;          // −6 dBFS, plenty for a line input
const JAM_THRESHOLD_FRAMES = 2; // beyond this we jump rather than crawl

class LtcGenerator extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Initial state comes through processorOptions rather than a message, so
    // the processor is usable the instant it exists. A postMessage is not
    // guaranteed to be delivered before rendering starts — in an
    // OfflineAudioContext the whole render can finish first, and the node
    // produces silence.
    const init = options?.processorOptions ?? {};
    this.fps = init.fps > 0 ? Math.round(init.fps) : 25;
    this.drop = !!init.drop;
    this.running = !!init.running;
    this.tc = { ...{ h: 0, m: 0, s: 0, f: 0 }, ...(init.tc ?? {}) };

    this.bits = new Uint8Array(80);
    this.half = new Int8Array(160);
    this.level = 1;
    this.pos = 0;               // samples into the current frame
    this.built = false;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    if (!msg) return;

    if (msg.type === 'run') {
      this.running = !!msg.running;
      return;
    }

    if (msg.type !== 'sync' || !msg.tc) return;

    this.fps = msg.fps > 0 ? Math.round(msg.fps) : 25;
    this.drop = !!msg.drop;

    // Free-run on the audio clock, which is steady, and only jump when the
    // incoming timecode says we're properly out. Chasing every message would
    // inherit the jitter of a 4 Hz feed that has crossed the internet.
    if (!this.running || this.driftFrames(msg.tc) > JAM_THRESHOLD_FRAMES) {
      this.tc = { ...msg.tc };
      this.pos = 0;
      this.built = false;
    }
    this.running = msg.running !== false;
  }

  driftFrames(other) {
    const flat = (t) => ((t.h * 60 + t.m) * 60 + t.s) * this.fps + t.f;
    return Math.abs(flat(other) - flat(this.tc));
  }

  advance() {
    const tc = this.tc;
    if (++tc.f < this.fps) return;
    tc.f = 0;
    if (++tc.s < 60) {
      // Drop-frame: skip frames :00 and :01 at the top of every minute except
      // every tenth. Only reachable when a 29.97 DF show is playing.
      if (this.drop && this.fps === 30 && tc.s === 0 && tc.m % 10 !== 0) tc.f = 2;
      return;
    }
    tc.s = 0;
    if (++tc.m < 60) {
      if (this.drop && this.fps === 30 && tc.m % 10 !== 0) tc.f = 2;
      return;
    }
    tc.m = 0;
    tc.h = (tc.h + 1) % 24;
  }

  buildFrame() {
    const b = this.bits;
    b.fill(0);
    const put = (lo, n, value) => { for (let k = 0; k < n; k++) b[lo + k] = (value >> k) & 1; };

    put(0,  4, this.tc.f % 10);   put(8,  2, (this.tc.f / 10) | 0);
    put(16, 4, this.tc.s % 10);   put(24, 3, (this.tc.s / 10) | 0);
    put(32, 4, this.tc.m % 10);   put(40, 3, (this.tc.m / 10) | 0);
    put(48, 4, this.tc.h % 10);   put(56, 2, (this.tc.h / 10) | 0);
    b[10] = this.drop ? 1 : 0;
    for (let i = 0; i < 16; i++) b[64 + i] = SYNC[i];

    let lv = this.level;
    for (let i = 0; i < 80; i++) {
      lv = -lv;                       // boundary transition
      this.half[2 * i] = lv;
      if (b[i]) lv = -lv;             // mid-bit transition marks a 1
      this.half[2 * i + 1] = lv;
    }
    this.level = lv;                  // carry polarity into the next frame
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const ch = out[0];

    if (!this.running) {
      for (const c of out) c.fill(0);
      return true;
    }

    if (!this.built) { this.buildFrame(); this.built = true; }

    const samplesPerFrame = sampleRate / this.fps;
    const samplesPerHalf  = samplesPerFrame / 160;

    for (let i = 0; i < ch.length; i++) {
      if (this.pos >= samplesPerFrame) {
        this.pos -= samplesPerFrame;
        this.advance();
        this.buildFrame();
      }
      const slot = (this.pos / samplesPerHalf) | 0;
      ch[i] = this.half[slot < 160 ? slot : 159] * AMPLITUDE;
      this.pos++;
    }

    for (let c = 1; c < out.length; c++) out[c].set(ch);
    return true;
  }
}

registerProcessor('ltc-generator', LtcGenerator);
