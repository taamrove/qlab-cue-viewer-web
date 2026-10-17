// Client for the relay's item protocol (see relay-server README, "Items").
// Rides on the viewer's existing subscriber socket: QLab snapshots and item
// messages share it, told apart by the `relay: "items"` tag.

const OWNER_KEY = 'qlab-viewer.ownerKey';

function randomKey() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// One key per device/browser. Private cues follow the key, not the channel,
// so copying it to another device shows the same private cues there.
export function getOwnerKey() {
  try {
    let k = localStorage.getItem(OWNER_KEY);
    if (!k || k.length < 16) {
      k = randomKey();
      localStorage.setItem(OWNER_KEY, k);
    }
    return k;
  } catch {
    // Storage blocked (private mode etc.) — key lives for this page only.
    getOwnerKey.volatile ??= randomKey();
    return getOwnerKey.volatile;
  }
}

export function setOwnerKey(k) {
  const key = String(k ?? '').trim();
  if (key.length < 16 || key.length > 128) throw new Error('Key must be 16–128 characters');
  try { localStorage.setItem(OWNER_KEY, key); } catch { getOwnerKey.volatile = key; }
  return key;
}

export class ItemsClient {
  constructor({ onChange } = {}) {
    this.onChange = onChange ?? (() => {});
    this.items = new Map();       // id → item view from relay
    this.canEditShared = false;
    this.synced = false;
    this.ws = null;
    this.editKey = '';
    this.pending = new Map();     // req → { resolve, timer }
    this.seq = 0;
  }

  // Call after creating each new socket; hello goes out once it's open.
  attach(ws, { editKey = '' } = {}) {
    this.ws = ws;
    this.editKey = editKey;
    this.synced = false;
    const hello = () => this.hello();
    if (ws.readyState === WebSocket.OPEN) hello();
    else ws.addEventListener('open', hello, { once: true });
    ws.addEventListener('close', () => {
      for (const { resolve, timer } of this.pending.values()) {
        clearTimeout(timer);
        resolve({ ok: false, error: 'connection lost' });
      }
      this.pending.clear();
    });
  }

  hello() {
    this.send({ op: 'hello', owner: getOwnerKey(), edit: this.editKey || undefined });
  }

  // Re-authenticate on the same socket (new editor password or owner key).
  // Resolves with whether shared editing is now allowed.
  relogin(editKey = this.editKey) {
    this.editKey = editKey;
    return new Promise((resolve) => {
      this._onSync = resolve;
      this.hello();
    });
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ relay: 'items', ...obj }));
      return true;
    }
    return false;
  }

  request(op, payload) {
    const req = `r${++this.seq}`;
    return new Promise((resolve) => {
      if (!this.send({ op, req, ...payload })) {
        resolve({ ok: false, error: 'not connected' });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(req);
        resolve({ ok: false, error: 'no response from relay' });
      }, 5000);
      this.pending.set(req, { resolve, timer });
    });
  }

  upsert(item) { return this.request('upsert', { item }); }
  remove(id)   { return this.request('delete', { id }); }

  // Returns true if the message belonged to the item protocol.
  handle(msg) {
    if (msg?.relay !== 'items') return false;
    switch (msg.op) {
      case 'sync':
        this.items = new Map((msg.items ?? []).map((i) => [i.id, i]));
        this.canEditShared = !!msg.canEditShared;
        this.synced = true;
        this._onSync?.(this.canEditShared);
        this._onSync = null;
        this.onChange();
        break;
      case 'put':
        this.items.set(msg.item.id, msg.item);
        this.onChange();
        break;
      case 'remove':
        if (this.items.delete(msg.id)) this.onChange();
        break;
      case 'ack': {
        const p = this.pending.get(msg.req);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.req);
          p.resolve(msg);
        }
        break;
      }
    }
    return true;
  }
}
