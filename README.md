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

### Choosing the output device

The **LTC out** button has a device selector beside it, so the timecode can go
to a specific interface output instead of the laptop speakers. It calls
`AudioContext.setSinkId()`, and if the chosen device disappears — an interface
unplugged mid-show — it falls back to the default output rather than going
silently mute.

**This needs the page served over https.** On a plain-http origin the whole
`mediaDevices` API is absent, so the selector hides itself and LTC plays to the
system default. `http://10.10.20.201:8766` is therefore default-output only;
use the TLS hostname to pick a device. Safari doesn't implement `setSinkId` at
all, and hides the selector for the same reason.

Device *names* stay hidden until the page has been granted audio permission, so
the list offers "Show device names…" which asks for it once and then relabels.

### Offsetting the timecode

Two controls sit beside the readout, and both apply to the LTC output as well
as the display:

- **ms** — compensates for transport delay. The bridge's 4 Hz poll, the relay
  round trip and the network all sit between the show and this screen.
- **f** — a whole-frame shift, for when the timecode itself needs trimming
  against what the rest of the rig expects. It follows the show's frame rate,
  so two frames stays two frames at 25 or 30 fps.

Both persist per channel, and the boxes turn orange whenever either is
non-zero — a silent offset is a lie about where the show is, and the next
person to debug a timecode discrepancy should be able to see it immediately.

The offset only applies while timecode is running. Once playback stops, the
last frame that played is simply the truth, and running it forward would show
a frame the show never reached.

Hovering the controls reports the combined shift in both ms and frames, plus a
measured end-to-end delay taken from the bridge's own timestamp. That figure is
a hint, never applied automatically — it is only meaningful if both machines
have a sane clock.

## The workspace panel

`☰` in the top bar shows the cue list beside the timeline, so the shape of the
show stays visible instead of only whatever happens to be running.

It shows **only the cue list QLab currently has open**, named in the panel
heading. A show workspace usually carries a library and helper lists alongside
the one being performed, and listing all of them buries the one that matters.
The bridge reports `currentCueListID` on every snapshot, so the panel follows
the moment you switch lists in QLab.

Three states are distinguished, because when you're watching a show rather than
driving it all three matter:

| | |
| --- | --- |
| **running** | orange fill — playing now. The parent group lights up too, which is what makes the song heading show rather than only the audio cue inside it |
| **playhead** | `▸` and an orange bar — standing by, what GO fires next |
| **selected** | a quiet grey highlight — someone clicked it. Deliberately understated: it says "highlighted", not "about to happen" |

The panel scrolls to keep the most important of those centred: the playing cue,
else whatever is standing by.

**follow** can be turned off. Even with it on, the panel only scrolls when the
running cue actually changes: scroll away to look at something else and it
stays where you put it until the show moves on.

The structure arrives as its own message (`{ ts, workspace }`) rather than
riding along with every snapshot — it is far larger and changes only when the
workspace is edited. The bridge re-sends it on change and on a slow heartbeat,
because the relay caches only the most recent message per channel, so a viewer
joining mid-show would otherwise never receive a structure that happens not to
be changing.
