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

## Custom cues

Cues that live in the viewer, not in the QLab workspace, timed relative to the song QLab is playing. Open them with **★ Cues** in the top bar.

- **Anchoring.** A custom cue belongs to a song group, identified by its group path (e.g. `SHOW 1 › SANG 3`), and fires at an offset in seconds from when that group started. Song groups are the stable unit: if you reorder the setlist, skip or re-fire a song, offsets still line up. An absolute show clock would drift as soon as the set changes.
  - The bridge snapshot only carries group *names*, so renaming a song group in QLab detaches its custom cues. Re-pick the song in the cue form to re-attach them. Adding QLab group uniqueIDs to the snapshot would remove this limitation (see `anchor` in `src/customCues.js`).
- **Stamp.** Press **Stamp** (or <kbd>Space</kbd> while the panel is open) during rehearsal to drop a cue at the current song time, then name it. This is much faster than typing times.
- **Phases.** Each cue goes upcoming → **warning** (amber countdown, default 10 s) → **NOW** (instant cues) or a progress bar (cues with a length) → fades out. State is computed purely from the song clock, so reloading mid-song lands in the right place and never resurrects past cues.
- **Song clock.** The song clock is derived from the snapshot like before (preWait + elapsed of running cues) and extrapolated between 4 Hz snapshots, so countdowns tick at 10 Hz. Snapshots carry no "paused" flag, so it only extrapolates while the clock is actually advancing, and a monotonic clamp stops it from flickering backwards.

### Who sees what

| | Visible to | Who can create/edit |
|---|---|---|
| **Everyone** (★ teal) | all viewers of the show | anyone with the **editor password** (relay `EDITOR_TOKEN`, defaults to the relay token) |
| **Only me** (◆ violet) | only you | anyone, since they only affect themselves |

Private cues are tied to a random **private key** stored in this browser. Copy it under *Access* and paste it on another device (*Use another…*) to see the same private cues there. The relay only stores a hash of the key.

### Filters

**⚲ Filter** changes only what *you* see on this device. You can toggle QLab cues, shared cues and your private cues, and hide whole departments. Filters are remembered per show code.

Cues are stored by `relay-server` (see its README, "Items"). Nothing is written to QLab.

## Tests

```sh
npm test      # unit tests for the cue timing / filter / clock logic (node:test)
```

## Build & deploy

```sh
npm run build   # → dist/
```

Static output — drop into Cloudflare Pages / Netlify / Vercel / any static host.
