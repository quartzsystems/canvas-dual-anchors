# Canvas Dual Labels & Anchors

An unofficial Obsidian plugin that adds two things Canvas doesn't support natively:

1. **Two labels per connection** — a chip near the start of the line and a chip near the end, edited independently (e.g. `Gi1/0/1` on one end, `Gi0/24` on the other, like a real cable diagram).
2. **Slidable connection anchors** — after a connection is drawn, drag the small dot at either end along the card's side to move it off dead-center. Right-click a dot to snap it back to center.

## How it works (and its limits)

Canvas is a closed-source core plugin — there's no public API for this, so the
plugin uses `monkey-around` to patch a few methods on the live `Canvas`,
`CanvasEdge`, and `CanvasNode` objects at runtime (the same technique used by
plugins like Advanced Canvas). It does **not** modify the `.canvas` JSON
schema — the two extra labels and two offsets are stored as plain extra
fields on each edge's own data object (`labelStart`, `labelEnd`,
`fromOffset`, `toOffset`). Canvas already preserves unrecognized fields on
node/edge data through save/reload, so this data round-trips normally and
stays in your `.canvas` file (readable by anything that parses JSON, just
ignored by Canvas viewers that don't know about it).

Because this relies on the current internal shape of Canvas rather than a
documented API, every patched method is wrapped so a failure only skips that
one visual tweak instead of breaking the canvas — if a future Obsidian
update changes the internals, worst case the extra chips/handles just stop
appearing until the plugin is updated, your canvas itself keeps working.

**Design tradeoff on anchors:** rather than adding brand-new draggable dots
directly on node sides (which would mean reverse-engineering Canvas's
private drag-to-connect/hover code, i.e. how it decides you're initiating a
new connection at all), this plugin lets you draw a connection normally
(one point per side, like today) and then **slide that connection's anchor**
along the side afterward. You still end up with multiple distinct
attachment points along one side across different connections — it's just a
two-step motion (connect, then drag to reposition) rather than one.

## Install

1. Copy `main.js`, `manifest.json`, and `styles.css` into a folder named
   `canvas-dual-anchors` inside your vault's `.obsidian/plugins/` folder.
2. Reload Obsidian (or toggle the plugin off/on) and enable it under
   **Settings → Community plugins**.

## Use

- **Labels:** click the small `+` chip near either end of a connection line
  and type. Enter or click away to save, Escape to cancel.
- **Anchors:** hover a connection to see a small dot at each end; drag it
  along the card's side. Right-click the dot to reset to center.
- **Command palette:** "Reset connection anchors to center for selected
  edge(s)" resets offsets on whatever edges you have selected.

## Rebuilding from source

```bash
npm install
node esbuild.config.mjs production   # outputs main.js
```

`src/main.ts` is the only source file; `esbuild.config.mjs` bundles it
against Obsidian/Electron as externals, matching the standard Obsidian
sample-plugin build setup.
