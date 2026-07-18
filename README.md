# STL / STEP Viewer

A single-page 3D model viewer: orbit/pan/zoom around an uploaded STL or STEP
file, scale each axis independently, and export a screenshot. No build step,
no npm install — just four files: `index.html`, `style.css`, `app.js`, and
this README. three.js is loaded from a CDN at runtime.

**Supported formats:** `.stl` (binary or ASCII) and `.stp`/`.step`.

STL is parsed with a small hand-written parser and needs nothing else. STEP
is a much more complex CAD format (parametric surfaces, not triangles), so
STEP files are handled by [occt-import-js](https://github.com/kovacsv/occt-import-js) —
a WebAssembly build of the OpenCascade CAD kernel that runs entirely in the
browser and converts STEP geometry into a triangle mesh three.js can render.
It's loaded lazily from a CDN the first time you open a STEP file, so
STL-only use never downloads it.

## Run it locally (terminal)

Browsers block ES module imports from `file://` paths, so you need a tiny
local server — no installation required, pick whichever you have:

**Python (usually already installed on Mac/Linux):**
```bash
cd stl-viewer
python3 -m http.server 8000
```
Then open http://localhost:8000 in your browser.

**Node (if you have Node installed):**
```bash
cd stl-viewer
npx serve .
```
It will print the local URL to open.

Either way, `Ctrl+C` in the terminal stops the server.

## Run it on a website

These are static files, so any static host works. A couple of easy options:

**GitHub Pages**
1. Push the `stl-viewer` folder to a GitHub repo.
2. In the repo settings, enable GitHub Pages for that branch/folder.
3. Your viewer will be live at `https://<username>.github.io/<repo>/`.

**Netlify / Vercel drag-and-drop**
1. Go to netlify.com (or vercel.com) and use their "drag and drop to deploy" option.
2. Drag the `stl-viewer` folder in.
3. You'll get a live URL immediately, no account configuration needed beyond signup.

## Notes

- Everything runs client-side — uploaded files never leave the browser.
- Works with both binary and ASCII STL files.
- Opening a STEP file the first time in a session downloads the OpenCascade
  WASM engine (a few MB) from a CDN, so an internet connection is required
  for STEP support specifically. STL parsing has no such dependency beyond
  the initial page load.
- Very large or highly complex STEP assemblies can take a few seconds to
  triangulate, since that work happens in-browser via WASM rather than on a server.
- Touch support covers single-finger drag (orbit) and pinch isn't wired up yet — desktop mouse use is the primary target.