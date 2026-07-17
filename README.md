# STL Viewer

A single-page STL viewer: orbit/pan/zoom around an uploaded model, scale each
axis independently, and export a screenshot. No build step, no npm install —
just three files: `index.html`, `style.css`, `app.js`. three.js is loaded
from a CDN at runtime.

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

- Everything runs client-side — uploaded STL files never leave the browser.
- Works with both binary and ASCII STL files.
- Touch support covers single-finger drag (orbit) and pinch isn't wired up yet — desktop mouse use is the primary target.
