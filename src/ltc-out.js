// Plays LTC out of this device's audio output, chasing the show's timecode.
//
// Useful for feeding a local device from a laptop or phone — headphone jack
// into whatever needs timecode. What it is NOT is a sync reference: the
// timecode reaching this browser has been through a 4 Hz poll and a WebSocket
// round trip, so it lands somewhere in the region of the show rather than
// frame-locked to it. Good enough to chase, not good enough to lock.

import { framesToTc } from './timecode.js';

// Choosing an output device needs a secure context — over plain http the whole
// mediaDevices API is simply absent. LTC still plays to the default output
// there; only the choice of device is unavailable.
export function canChooseOutput() {
  return window.isSecureContext
      && !!navigator.mediaDevices?.enumerateDevices
      && typeof (window.AudioContext || window.webkitAudioContext)?.prototype?.setSinkId === 'function';
}

export async function listOutputDevices() {
  if (!canChooseOutput()) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audiooutput');
}

// Device labels are hidden until the page has been granted audio permission —
// without this the list is a row of anonymous ids nobody can pick from. The
// stream is stopped immediately; it exists only to unlock the labels.
export async function revealDeviceLabels() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
}

const WORKLET_URL = new URL('./ltc-worklet.js', import.meta.url);

export class LtcOutput {
  constructor(deviceId = '') {
    this.ctx = null;
    this.node = null;
    this.active = false;
    this.deviceId = deviceId;
  }

  // Must be called from a user gesture — browsers won't start audio otherwise.
  // `initial` seeds the generator so it starts from the right frame instead of
  // from zero while it waits for the first sync message.
  async start(initial = null) {
    if (this.active) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio not supported on this device');

    this.ctx = new Ctx();
    // Route before anything is generated, so the first frame already goes to
    // the right interface rather than briefly out of the laptop speakers.
    await this.applyDevice();
    await this.ctx.audioWorklet.addModule(WORKLET_URL);
    this.node = new AudioWorkletNode(this.ctx, 'ltc-generator', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: initial
        ? { tc: framesToTc(initial.frames, initial.fps, initial.drop),
            fps: initial.fps, drop: initial.drop, running: initial.running }
        : {},
    });
    this.node.connect(this.ctx.destination);
    await this.ctx.resume();
    this.active = true;
  }

  // Can be called while running — switching interfaces mid-show is allowed.
  async setDevice(deviceId) {
    this.deviceId = deviceId ?? '';
    await this.applyDevice();
  }

  async applyDevice() {
    if (!this.ctx || typeof this.ctx.setSinkId !== 'function') return;
    try {
      await this.ctx.setSinkId(this.deviceId);   // '' means the system default
    } catch (err) {
      // The device can vanish between listing and use — an interface being
      // unplugged mid-show is exactly when this matters. Fall back audibly to
      // the default rather than dying silently.
      this.deviceId = '';
      await this.ctx.setSinkId('');
      throw err;
    }
  }

  async stop() {
    this.active = false;
    try { this.node?.disconnect(); } catch {}
    try { await this.ctx?.close(); } catch {}
    this.node = null;
    this.ctx = null;
  }

  // `now` is the extrapolated readout state, or null when there's no timecode.
  sync(now) {
    if (!this.active || !this.node) return;
    if (!now) {
      this.node.port.postMessage({ type: 'run', running: false });
      return;
    }
    this.node.port.postMessage({
      type: 'sync',
      tc: framesToTc(now.frames, now.fps, now.drop),
      fps: now.fps,
      drop: now.drop,
      running: now.running,
    });
  }
}
