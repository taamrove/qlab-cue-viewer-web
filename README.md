# qlab-cue-viewer-web

Static web viewer. Subscribes to `relay-server` and renders the current QLab cue full-screen — designed to be opened on a phone, monitor, or projector anywhere with internet.

## Dev

```sh
npm install
cp .env.example .env.local   # point at your relay
npm run dev
```

## Configure at runtime

You can override relay settings via URL params so a single deploy can serve multiple shows:

```
https://viewer.example.com/?relay=wss://relay.your-domain.tld&token=…&channel=qlab-show-1
```

## Build & deploy

```sh
npm run build   # → dist/
```

Static output — drop into Cloudflare Pages / Netlify / Vercel / any static host.

## Timecode

When the bridge is receiving decoded timecode from the [LTC Tap](../qlab-ltc-au)
plug-in, the topbar shows it. Between snapshots the readout is advanced from the
local clock — timecode is a pure function of elapsed time, so it resyncs cleanly
on every snapshot instead of stepping at the bridge's 4 Hz poll rate. It goes
dim and freezes when playback stops, and when snapshots dry up entirely.

**LTC out** plays timecode from this device's own audio output, chasing the
show — headphone jack into whatever needs it. Generation runs in an
AudioWorklet, on the audio thread, so it keeps running at the right rate even
when the tab is backgrounded and normal timers get throttled. It free-runs on
the audio clock and only jumps when it drifts more than two frames from the
show, rather than inheriting the jitter of a feed that has crossed the internet.

It is **not a sync reference.** The timecode reaching the browser has been
through a 4 Hz poll and a WebSocket round trip, so it lands in the region of the
show, not frame-locked to it. Chase things with it; don't lock to it.
