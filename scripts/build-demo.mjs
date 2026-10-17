// Build the hosted demo: a VITE_DEMO=1 build inlined into ONE html file with
// no external assets, so it can be hosted anywhere as a single page (e.g. a
// Claude artifact, a gist, any static host).
//
//   npm run build:demo            → demo/qlab-demo.html
//   npm run build:demo -- --fragment   → body fragment without <html>/<head>
//                                        (for hosts that add their own skeleton)

import { build } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = path.join(root, 'demo', '.build');
const fragment = process.argv.includes('--fragment');

process.env.VITE_DEMO = '1';
await build({ root, logLevel: 'warn', build: { outDir, emptyOutDir: true, assetsInlineLimit: 1e9 } });

let html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
const read = (href) => fs.readFileSync(path.join(outDir, href.replace(/^\//, '')), 'utf8');

const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)];
const js = [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g)];
let styles = css.map((m) => read(m[1])).join('\n');
// `</script` inside the bundle would end the inline tag early.
let scripts = js.map((m) => read(m[1]).replaceAll('</script', '<\\/script')).join('\n');
for (const m of [...css, ...js]) html = html.replace(m[0], '');

html = html.replace(/<title>[^<]*<\/title>/, '<title>QLab Cue Viewer Demo</title>');
const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>')).trim();

const out = fragment
  ? `<title>QLab Cue Viewer Demo</title>\n<style>${styles}</style>\n${body}\n<script type="module">${scripts}</script>\n`
  : html.replace('</head>', `<style>${styles}</style>\n</head>`)
        .replace('</body>', `<script type="module">${scripts}</script>\n</body>`);

const file = path.join(root, 'demo', fragment ? 'qlab-demo.fragment.html' : 'qlab-demo.html');
fs.writeFileSync(file, out);
fs.rmSync(outDir, { recursive: true, force: true });
console.log(`✔ ${path.relative(root, file)} (${(out.length / 1024).toFixed(1)} KB)`);
