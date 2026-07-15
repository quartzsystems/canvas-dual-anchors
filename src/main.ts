import { Plugin, WorkspaceLeaf, Menu, Notice, PluginSettingTab, Setting, App } from "obsidian";
import { around } from "monkey-around";

/**
 * Canvas Dual Labels & Anchors
 *
 * Two independent features, each implemented as a monkey-around patch on the
 * core (closed-source) Canvas view:
 *
 * 1. DUAL EDGE LABELS
 *    Every edge gets two extra, independently-editable label chips rendered
 *    near its start and end (in addition to / instead of the native center
 *    label). Stored as custom fields on the edge's own data object:
 *      edgeData.labelStart / edgeData.labelEnd
 *    Unknown fields on node/edge data round-trip through Canvas's own
 *    getData()/setData() untouched, so this survives save/reload and syncs
 *    like any other canvas property.
 *
 * 2. SLIDABLE CONNECTION ANCHORS
 *    Normally a connection always attaches to the center of whichever side
 *    it's dragged to. This patch lets you drag small handles along that side
 *    after the fact, moving the attachment point anywhere from one corner to
 *    the other rather than only dead-center. Stored as:
 *      edgeData.fromOffset / edgeData.toOffset   (0..1 fraction along the side)
 *
 * Both features degrade gracefully: if a future Obsidian Canvas rewrite
 * changes the internal shape this patch relies on, failures are caught so
 * they don't break normal canvas use -- you just temporarily lose the extra
 * chips/handles until the plugin is updated.
 */

const DEFAULT_OFFSET = 0.5;

interface CdaSettings {
  /** Show the "+" placeholder chips on edges that have no start/end label yet. */
  showEmptyChips: boolean;
  /** Show the draggable anchor dots at connection endpoints. */
  showHandles: boolean;
}

const DEFAULT_SETTINGS: CdaSettings = {
  showEmptyChips: true,
  showHandles: true,
};

// ---- geometry helpers -------------------------------------------------

type Side = "top" | "right" | "bottom" | "left";
interface Pos { x: number; y: number }
interface BBox { minX: number; maxX: number; minY: number; maxY: number }

function sidePoint(bbox: BBox, side: Side, fraction: number): Pos {
  const f = Math.min(1, Math.max(0, fraction));
  switch (side) {
    case "top":
      return { x: bbox.minX + (bbox.maxX - bbox.minX) * f, y: bbox.minY };
    case "bottom":
      return { x: bbox.minX + (bbox.maxX - bbox.minX) * f, y: bbox.maxY };
    case "left":
      return { x: bbox.minX, y: bbox.minY + (bbox.maxY - bbox.minY) * f };
    case "right":
      return { x: bbox.maxX, y: bbox.minY + (bbox.maxY - bbox.minY) * f };
  }
}

// Project an arbitrary canvas-space point onto a bbox side, returning the
// 0..1 fraction along that side (used while dragging a handle).
function fractionAlongSide(bbox: BBox, side: Side, point: Pos): number {
  if (side === "top" || side === "bottom") {
    const w = bbox.maxX - bbox.minX;
    return w === 0 ? 0.5 : (point.x - bbox.minX) / w;
  } else {
    const h = bbox.maxY - bbox.minY;
    return h === 0 ? 0.5 : (point.y - bbox.minY) / h;
  }
}

function cubicBezierPoint(p0: Pos, p1: Pos, p2: Pos, p3: Pos, t: number): Pos {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

// ---- plugin -------------------------------------------------------------

interface EdgeDecor {
  edge: any;
  startChip: HTMLElement;
  endChip: HTMLElement;
  fromHandle: HTMLElement;
  toHandle: HTMLElement;
}

export default class CanvasDualAnchorsPlugin extends Plugin {
  private patchedCanvasProtos = new WeakSet<any>();
  private patchedEdgeProtos = new WeakSet<any>();
  private patchedNodeProtos = new WeakSet<any>();
  private overlays = new WeakMap<any, HTMLElement>();
  private liveOverlays: HTMLElement[] = [];
  private tickerId: number | null = null;
  settings: CdaSettings = { ...DEFAULT_SETTINGS };
  /** Per-canvas registry of decorations, keyed by edge id, so we can sweep stale ones. */
  private decor = new WeakMap<any, Map<string, EdgeDecor>>();

  /**
   * Positioning is driven by an animation frame ticker rather than by hooking
   * Canvas's internal update methods. Canvas does not route every geometry
   * change through updatePath()/render() -- dragging a node in particular
   * repaints the SVG path by another route -- so hook-driven positioning left
   * the chips and handles stranded at stale coordinates. Reading the live
   * bezier each frame is immune to whichever internal path Obsidian takes.
   *
   * A per-edge signature check means we only touch the DOM for edges whose
   * geometry actually changed, so an idle canvas costs a handful of property
   * reads per frame and zero layout work.
   */
  private startTicker() {
    const tick = () => {
      this.tickerId = requestAnimationFrame(tick);
      try {
        this.syncAllDecor();
      } catch (e) {
        /* never let a bad frame kill the loop */
      }
    };
    this.tickerId = requestAnimationFrame(tick);
    this.register(() => {
      if (this.tickerId !== null) cancelAnimationFrame(this.tickerId);
      this.tickerId = null;
    });
  }

  private bezierSignature(edge: any): string {
    const b = edge.bezier;
    // Include the rendered d: Advanced Canvas's square/A* re-routes change the
    // drawn path without necessarily changing bezier endpoints.
    const d = edge.path?.display?.getAttribute?.("d") ?? "";
    return `${b.from.x},${b.from.y},${b.cp1.x},${b.cp1.y},${b.cp2.x},${b.cp2.y},${b.to.x},${b.to.y}|${d.length}:${d.slice(0, 40)}:${d.slice(-40)}`;
  }

  private syncAllDecor() {
    for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
      const canvas: any = (leaf.view as any)?.canvas;
      if (!canvas) continue;

      const map = this.decor.get(canvas);
      if (!map || map.size === 0) continue;

      let anyChanged = false;
      for (const [id, d] of map) {
        const edge = canvas.edges?.get?.(id);
        // Edge replaced or removed -> let the normal sweep handle it.
        if (!edge || edge !== d.edge || !edge.bezier) continue;

        const sig = this.bezierSignature(edge);
        if (sig === edge.__daSig) continue; // geometry unchanged, nothing to do

        // Canvas recomputed this path: re-apply our anchor offsets (idempotent),
        // then glue the chips and handles to the resulting curve.
        this.applyCustomOffsets(edge);
        this.repositionChips(edge);
        edge.__daSig = this.bezierSignature(edge);
        anyChanged = true;
      }

      if (anyChanged) this.resolveChipOverlaps(map);
    }
  }

  /**
   * Auto de-overlap: chips whose boxes collide get fanned out vertically in a
   * deterministic order (sorted by natural position), so labels sharing a
   * crowded node side stack neatly instead of sitting on top of each other.
   * A chip the user dragged is left where they put it and only OTHER chips
   * move around it. Deterministic input -> deterministic output, so there is
   * no frame-to-frame jitter.
   */
  private resolveChipOverlaps(map: Map<string, EdgeDecor>) {
    interface Item { el: HTMLElement; base: Pos; w: number; h: number; nudge: number; pinned: boolean }
    const items: Item[] = [];

    for (const d of map.values()) {
      for (const el of [d.startChip, d.endChip]) {
        const base: Pos | undefined = (el as any).__basePos;
        if (!base) continue;
        items.push({
          el, base,
          w: el.offsetWidth || 30,
          h: el.offsetHeight || 18,
          nudge: 0,
          // User-placed chips (dragged to a stored position) stay exactly
          // where the user put them; only automatic chips flow around them.
          pinned: !!(el as any).__pinned || el.hasClass("is-dragging"),
        });
      }
    }
    if (items.length < 2) return;

    // Stable order: left-to-right, then top-to-bottom.
    items.sort((a, b) => a.base.x - b.base.x || a.base.y - b.base.y);

    const GAP = 2;
    const overlaps = (a: Item, b: Item) => {
      const ax = a.base.x, ay = a.base.y + a.nudge;
      const bx = b.base.x, by = b.base.y + b.nudge;
      return Math.abs(ax - bx) * 2 < a.w + b.w + GAP &&
             Math.abs(ay - by) * 2 < a.h + b.h + GAP;
    };

    // Push each colliding chip downward below the one it hits. n is small
    // (chips on screen), so the quadratic pass is negligible.
    for (let i = 1; i < items.length; i++) {
      if (items[i].pinned) continue;
      for (let j = 0; j < i; j++) {
        if (overlaps(items[i], items[j])) {
          const other = items[j].base.y + items[j].nudge;
          items[i].nudge = other + (items[j].h + items[i].h) / 2 + GAP - items[i].base.y;
        }
      }
    }

    for (const item of items) {
      const prev = (item.el as any).__stackNudge ?? 0;
      if (prev !== item.nudge) {
        (item.el as any).__stackNudge = item.nudge;
        item.el.style.transform =
          `translate(${item.base.x}px, ${item.base.y + item.nudge}px) translate(-50%, -50%)`;
      }
    }
  }

  private getDecor(canvas: any): Map<string, EdgeDecor> {
    let map = this.decor.get(canvas);
    if (!map) {
      map = new Map();
      this.decor.set(canvas, map);
    }
    return map;
  }

  private destroyDecor(d: EdgeDecor) {
    d.startChip.remove();
    d.endChip.remove();
    d.fromHandle.remove();
    d.toHandle.remove();
    if (d.edge) {
      delete d.edge.__dualAnchorsChips;
      delete d.edge.__dualAnchorsHandles;
    }
  }

  /** Remove decorations whose edge is gone, or whose edge object was replaced by a fresh one. */
  private sweepStaleDecor(canvas: any) {
    const map = this.decor.get(canvas);
    if (!map) return;
    for (const [id, d] of [...map.entries()]) {
      const live = canvas.edges?.get?.(id);
      if (live !== d.edge) {
        this.destroyDecor(d);
        map.delete(id);
      }
    }
  }

  /**
   * After undo/redo the canvas may either rebuild edge objects (handled by the
   * stale sweep) or keep the same objects with restored data. Cover both:
   * sweep + re-enhance, refresh label text from data, and invalidate the
   * geometry signature so the ticker repositions everything next frame.
   */
  private resyncAfterHistory(canvas: any) {
    this.sweepStaleDecor(canvas);
    this.enhanceExisting(canvas);
    for (const edge of canvas.edges?.values?.() ?? []) {
      this.refreshChipText(edge);
      delete edge.__daSig;
    }
  }

  private refreshChipText(edge: any) {
    const chips = edge.__dualAnchorsChips;
    if (!chips) return;
    // Don't clobber a label the user is mid-typing.
    if (chips.startChip.getAttribute("contenteditable") === "true") return;
    if (chips.endChip.getAttribute("contenteditable") === "true") return;
    const data = edge.getData ? edge.getData() : {};
    chips.startChip.setText(data.labelStart ?? "");
    chips.startChip.toggleClass("is-empty", !data.labelStart);
    chips.endChip.setText(data.labelEnd ?? "");
    chips.endChip.toggleClass("is-empty", !data.labelEnd);
  }

  private destroyCanvasDecor(canvas: any) {
    const map = this.decor.get(canvas);
    if (map) {
      for (const d of map.values()) this.destroyDecor(d);
      map.clear();
    }
  }

  /**
   * Mutate an edge's data and (optionally) record an undo step.
   *
   * IMPORTANT: the `addHistory` second parameter on edge.setData() is NOT a
   * core Canvas feature -- it's added by Advanced Canvas's own patch. Relying
   * on it meant undo never worked without AC installed. So instead:
   *   - call setData with addHistory=false (harmless everywhere: core ignores
   *     the arg, AC skips its own push, so no double-push with AC installed)
   *   - push the undo step ourselves via canvas.pushHistory(canvas.getData())
   */
  private setEdgeData(edge: any, patch: Record<string, any>, addHistory: boolean) {
    const canvas = edge.canvas;
    const data = { ...edge.getData(), ...patch };

    // Keep the .canvas file clean: an offset at dead-center IS the native
    // default, so store nothing rather than 0.5. (Also what makes a snapped
    // anchor genuinely "back to normal" -- the edge carries no custom fields.)
    if (data.fromOffset === DEFAULT_OFFSET) delete data.fromOffset;
    if (data.toOffset === DEFAULT_OFFSET) delete data.toOffset;
    if (data.labelStart === "") delete data.labelStart;
    if (data.labelEnd === "") delete data.labelEnd;

    edge.setData(data, false);
    if (addHistory) {
      try {
        canvas?.pushHistory?.(canvas.getData());
      } catch (e) {
        /* history push is best-effort */
      }
    }
    canvas?.requestSave?.();
  }

  private getOverlay(canvas: any): HTMLElement | null {
    const host: HTMLElement | undefined = canvas.canvasEl ?? canvas.wrapperEl;
    if (!host) return null;

    let overlay = this.overlays.get(canvas);
    if (overlay && overlay.isConnected) return overlay;

    overlay = document.createElement("div");
    overlay.addClass("dual-anchor-overlay");
    overlay.style.position = "absolute";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.width = "0";
    overlay.style.height = "0";
    overlay.style.pointerEvents = "none";
    // Canvas nodes get ever-incrementing z-indexes (each selection bumps a
    // counter), so a small fixed value ends up UNDER nodes and the anchor
    // dots at node borders become unclickable. Park the overlay well above.
    overlay.style.zIndex = "9999";
    host.appendChild(overlay);
    this.overlays.set(canvas, overlay);
    this.liveOverlays.push(overlay);
    return overlay;
  }

  onunload() {
    // Remove every overlay we created (and with it all chips/handles inside).
    for (const overlay of this.liveOverlays) overlay.remove();
    this.liveOverlays = [];
    // Belt and braces: nuke any stragglers from a previous plugin instance.
    document.querySelectorAll(".dual-anchor-overlay").forEach((el) => el.remove());
    document.body.removeClass("cda-hide-empty-chips");
    document.body.removeClass("cda-hide-handles");
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyVisibilityClasses();
  }

  /**
   * Visibility is applied with two body classes + CSS rather than by touching
   * each chip/handle element: one class flip instantly affects every canvas,
   * nothing needs re-rendering, and newly created elements are automatically
   * correct without extra bookkeeping.
   */
  applyVisibilityClasses() {
    document.body.toggleClass("cda-hide-empty-chips", !this.settings.showEmptyChips);
    document.body.toggleClass("cda-hide-handles", !this.settings.showHandles);
  }

  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) ?? {}) };
    this.addSettingTab(new CdaSettingTab(this.app, this));
    this.applyVisibilityClasses();

    this.addCommand({
      id: "toggle-empty-label-chips",
      name: "Toggle empty label placeholders (+)",
      callback: async () => {
        this.settings.showEmptyChips = !this.settings.showEmptyChips;
        await this.saveSettings();
        new Notice(`Empty label placeholders ${this.settings.showEmptyChips ? "shown" : "hidden"}`);
      },
    });

    this.addCommand({
      id: "toggle-anchor-dots",
      name: "Toggle connection anchor dots",
      callback: async () => {
        this.settings.showHandles = !this.settings.showHandles;
        await this.saveSettings();
        new Notice(`Anchor dots ${this.settings.showHandles ? "shown" : "hidden"}`);
      },
    });

    this.app.workspace.onLayoutReady(() => {
      this.patchAllOpenCanvases();
      this.startTicker();

      // ---- Advanced Canvas interop ------------------------------------
      // AC fires its own workspace events for canvas lifecycle changes that
      // don't all pass through the methods we patch (its undo/redo wrappers
      // force a full data re-import, its extensions mutate edges directly,
      // etc). If AC is installed we piggyback on those events to resync; if
      // it isn't, these listeners simply never fire.
      const w: any = this.app.workspace;
      this.registerEvent(w.on("advanced-canvas:canvas-changed", (canvas: any) => {
        try { this.sweepStaleDecor(canvas); this.enhanceExisting(canvas); } catch (e) { /* noop */ }
      }));
      this.registerEvent(w.on("advanced-canvas:data-loaded:after", (canvas: any) => {
        try { this.resyncAfterHistory(canvas); } catch (e) { /* noop */ }
      }));
      this.registerEvent(w.on("advanced-canvas:undo", (canvas: any) => {
        try { this.resyncAfterHistory(canvas); } catch (e) { /* noop */ }
      }));
      this.registerEvent(w.on("advanced-canvas:redo", (canvas: any) => {
        try { this.resyncAfterHistory(canvas); } catch (e) { /* noop */ }
      }));
      this.registerEvent(w.on("advanced-canvas:edge-changed", (_canvas: any, edge: any) => {
        try { this.refreshChipText(edge); delete edge.__daSig; } catch (e) { /* noop */ }
      }));
      this.registerEvent(
        this.app.workspace.on("active-leaf-change", (leaf) => {
          if (leaf) this.tryPatchLeaf(leaf);
        })
      );
      this.registerEvent(
        this.app.workspace.on("layout-change", () => {
          this.patchAllOpenCanvases();
        })
      );
    });

    this.addCommand({
      id: "reset-selected-edge-anchors",
      name: "Reset connection anchors to center for selected edge(s)",
      checkCallback: (checking) => {
        const canvas = this.getActiveCanvas();
        if (!canvas) return false;
        const selectedEdges = [...(canvas.selection ?? [])].filter((el: any) => el?.from && el?.to);
        if (selectedEdges.length === 0) return false;
        if (!checking) {
          for (const edge of selectedEdges) {
            this.setEdgeData(edge, { fromOffset: DEFAULT_OFFSET, toOffset: DEFAULT_OFFSET }, true);
            edge.updatePath?.();
          }
          new Notice(`Reset ${selectedEdges.length} connection anchor(s)`);
        }
        return true;
      },
    });

    this.addCommand({
      id: "debug-dual-anchors",
      name: "Log debug info to developer console",
      checkCallback: (checking) => {
        const canvas = this.getActiveCanvas();
        if (!canvas) return false;
        if (!checking) {
          const edge = [...(canvas.edges?.values?.() ?? [])][0];
          console.log("[canvas-dual-anchors] canvas.canvasEl:", canvas.canvasEl);
          console.log("[canvas-dual-anchors] canvas.wrapperEl:", canvas.wrapperEl);
          console.log("[canvas-dual-anchors] overlay in DOM:", this.overlays.get(canvas), this.overlays.get(canvas)?.isConnected);
          if (edge) {
            console.log("[canvas-dual-anchors] sample edge:", edge);
            console.log("[canvas-dual-anchors] edge.bezier:", edge.bezier);
            console.log("[canvas-dual-anchors] edge.lineGroupEl:", edge.lineGroupEl, edge.lineGroupEl?.constructor?.name);
            console.log("[canvas-dual-anchors] edge.__dualAnchorsChips:", edge.__dualAnchorsChips);
          } else {
            console.log("[canvas-dual-anchors] no edges found on active canvas");
          }
          new Notice("Dual Anchors debug info logged to console (Ctrl+Shift+I)");
        }
        return true;
      },
    });
  }

  private getActiveCanvas(): any {
    const leaf = this.app.workspace.getMostRecentLeaf();
    const view: any = leaf?.view;
    if (view?.getViewType?.() === "canvas") return view.canvas;
    return null;
  }

  private patchAllOpenCanvases() {
    for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
      this.tryPatchLeaf(leaf);
    }
  }

  private tryPatchLeaf(leaf: WorkspaceLeaf) {
    const view: any = leaf.view;
    if (!view || view.getViewType?.() !== "canvas") return;
    if (!view.canvas) return;
    this.patchCanvasView(view);
  }

  private patchCanvasView(view: any) {
    const canvas = view.canvas;
    const proto = Object.getPrototypeOf(canvas);

    // The prototype is SHARED across every canvas view. Patch it exactly once,
    // or each newly-opened canvas stacks another wrapper layer and hooks fire
    // N times (this was the source of duplicated chips).
    if (this.patchedCanvasProtos.has(proto)) {
      this.sweepStaleDecor(canvas);
      this.enhanceExisting(canvas);
      return;
    }
    this.patchedCanvasProtos.add(proto);

    const self = this;

    // Patch addEdge so every edge (existing or newly drawn) gets enhanced.
    const uninstallCanvas = around(proto, {
      addEdge(next: any) {
        return function (this: any, edge: any) {
          const result = next.call(this, edge);
          try {
            self.patchEdgePrototype(edge);
            self.enhanceEdge(edge);
          } catch (e) {
            console.error("[canvas-dual-anchors] addEdge hook failed", e);
          }
          return result;
        };
      },
      removeEdge(next: any) {
        return function (this: any, edge: any) {
          const result = next.call(this, edge);
          try {
            const map = self.decor.get(this);
            const id = edge?.id;
            const d = id ? map?.get(id) : undefined;
            if (d && map) {
              self.destroyDecor(d);
              map.delete(id);
            }
          } catch (e) {
            /* noop */
          }
          return result;
        };
      },
      clear(next: any) {
        return function (this: any, ...args: any[]) {
          const result = next.call(this, ...args);
          // Canvas wipes all nodes/edges here (happens on sheet switch / re-import).
          // Drop every decoration so we don't leave orphans behind.
          try {
            self.destroyCanvasDecor(this);
          } catch (e) {
            /* noop */
          }
          return result;
        };
      },
      importData(next: any) {
        return function (this: any, ...args: any[]) {
          const result = next.call(this, ...args);
          try {
            self.sweepStaleDecor(this);
            self.enhanceExisting(this);
          } catch (e) {
            /* noop */
          }
          return result;
        };
      },
      undo(next: any) {
        return function (this: any, ...args: any[]) {
          const result = next.call(this, ...args);
          try {
            self.resyncAfterHistory(this);
          } catch (e) {
            /* noop */
          }
          return result;
        };
      },
      redo(next: any) {
        return function (this: any, ...args: any[]) {
          const result = next.call(this, ...args);
          try {
            self.resyncAfterHistory(this);
          } catch (e) {
            /* noop */
          }
          return result;
        };
      },
      addNode(next: any) {
        return function (this: any, node: any) {
          const result = next.call(this, node);
          try {
            self.patchNodePrototype(node);
          } catch (e) {
            console.error("[canvas-dual-anchors] addNode hook failed", e);
          }
          return result;
        };
      },
    });
    this.register(uninstallCanvas);

    this.enhanceExisting(canvas);
  }

  private enhanceExisting(canvas: any) {
    this.sweepStaleDecor(canvas);
    for (const edge of canvas.edges?.values?.() ?? []) {
      try {
        this.patchEdgePrototype(edge);
        this.enhanceEdge(edge);
      } catch (e) {
        console.error("[canvas-dual-anchors] enhance existing edge failed", e);
      }
    }
    for (const node of canvas.nodes?.values?.() ?? []) {
      try {
        this.patchNodePrototype(node);
      } catch (e) {
        console.error("[canvas-dual-anchors] enhance existing node failed", e);
      }
    }
  }

  // ---- edge prototype patch: reposition math + offset-aware path --------

  private patchEdgePrototype(edge: any) {
    const proto = Object.getPrototypeOf(edge);
    if (this.patchedEdgeProtos.has(proto)) return;
    this.patchedEdgeProtos.add(proto);

    const self = this;

    const uninstall = around(proto, {
      updatePath(next: any) {
        return function (this: any, ...args: any[]) {
          const result = next.call(this, ...args);
          try {
            self.applyCustomOffsets(this);
            self.repositionChips(this);
          } catch (e) {
            // Fail silently per-edge so one bad edge doesn't break the canvas.
          }
          return result;
        };
      },
      render(next: any) {
        return function (this: any, ...args: any[]) {
          const result = next.call(this, ...args);
          try {
            self.repositionChips(this);
          } catch (e) {
            /* noop */
          }
          return result;
        };
      },
    });
    this.register(uninstall);
  }

  private patchNodePrototype(node: any) {
    const proto = Object.getPrototypeOf(node);
    if (this.patchedNodeProtos.has(proto)) return;
    this.patchedNodeProtos.add(proto);
    // Reserved for future node-side extensions (not currently needed --
    // anchor offsets are stored and applied on the edge, not the node).
  }

  // ---- feature 1: dual labels --------------------------------------------

  private enhanceEdge(edge: any) {
    const canvas = edge.canvas;
    const map = this.getDecor(canvas);
    const id: string | undefined = edge.id;

    // Already decorated by THIS edge object -> nothing to do but reposition.
    if (edge.__dualAnchorsChips && id && map.get(id)?.edge === edge) {
      this.repositionChips(edge);
      return;
    }

    // A decoration exists for this edge id but belongs to a stale edge object
    // (canvas re-imported the sheet and rebuilt its edges). Destroy it first --
    // otherwise the old chips linger in the overlay as ghosts.
    if (id && map.has(id)) {
      this.destroyDecor(map.get(id)!);
      map.delete(id);
    }

    const data = edge.getData ? edge.getData() : {};

    const container = this.getOverlay(canvas);
    if (!container) return;

    const makeChip = (which: "labelStart" | "labelEnd") => {
      const chip = document.createElement("div");
      chip.addClass("dual-anchor-label-chip");
      chip.setAttribute("data-which", which);
      chip.setText(data[which] ?? "");
      chip.toggleClass("is-empty", !data[which]);
      chip.setAttribute("contenteditable", "false");

      // Pointerdown starts a maybe-drag: if the pointer moves more than a few
      // pixels the chip slides along the line (position saved per label); if
      // it never does, the release counts as a click and opens the editor.
      chip.addEventListener("pointerdown", (evt) => {
        evt.stopPropagation();
        if (chip.getAttribute("contenteditable") === "true") return; // typing
        this.beginChipInteraction(edge, chip, which, evt);
      });

      container.appendChild(chip);
      return chip;
    };

    const startChip = makeChip("labelStart");
    const endChip = makeChip("labelEnd");

    edge.__dualAnchorsChips = { startChip, endChip };

    // Anchor drag handles for feature 2.
    const makeHandle = (which: "from" | "to") => {
      const handle = document.createElement("div");
      handle.addClass("dual-anchor-drag-handle");
      handle.setAttribute("data-which", which);
      handle.addEventListener("pointerdown", (evt) => {
        evt.stopPropagation();
        evt.preventDefault();
        this.beginDraggingAnchor(edge, which, evt);
      });
      handle.addEventListener("contextmenu", (evt) => {
        evt.stopPropagation();
        evt.preventDefault();
        const key = which === "from" ? "fromOffset" : "toOffset";
        this.setEdgeData(edge, { [key]: DEFAULT_OFFSET }, true);
        edge.updatePath?.();
        new Notice("Connection anchor reset to center");
      });
      container.appendChild(handle);
      return handle;
    };

    const fromHandle = makeHandle("from");
    const toHandle = makeHandle("to");
    edge.__dualAnchorsHandles = { fromHandle, toHandle };

    if (id) {
      map.set(id, { edge, startChip, endChip, fromHandle, toHandle });
    }

    this.repositionChips(edge);
  }

  /**
   * Find the fraction (0..1) along the rendered path closest to a canvas-space
   * point, by coarse sampling. 64 samples is plenty for hand-placing a label.
   */
  private nearestFractionOnPath(edge: any, point: Pos): number | null {
    const pathEl: any = edge.path?.display;
    if (!pathEl || typeof pathEl.getTotalLength !== "function") return null;
    try {
      const len = pathEl.getTotalLength();
      if (!(len > 0)) return null;
      const SAMPLES = 64;
      let best = 0, bestDist = Infinity;
      for (let i = 0; i <= SAMPLES; i++) {
        const t = i / SAMPLES;
        const p = pathEl.getPointAtLength(len * t);
        const dist = (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          best = t;
        }
      }
      // Keep labels off the extreme tips so they don't sit under the dots.
      return Math.min(0.95, Math.max(0.05, best));
    } catch (e) {
      return null;
    }
  }

  /** Pointer went down on a chip: drag slides it along the line, a still click edits it. */
  private beginChipInteraction(edge: any, chip: HTMLElement, which: "labelStart" | "labelEnd", startEvt: PointerEvent) {
    const canvas = edge.canvas;
    const DRAG_THRESHOLD_PX = 4;
    let dragging = false;

    try {
      chip.setPointerCapture?.(startEvt.pointerId);
    } catch (e) {
      /* optional */
    }

    const posKey = which === "labelStart" ? "labelStartT" : "labelEndT";

    const onMove = (evt: PointerEvent) => {
      if (!dragging) {
        const moved = Math.hypot(evt.clientX - startEvt.clientX, evt.clientY - startEvt.clientY);
        if (moved < DRAG_THRESHOLD_PX) return;
        dragging = true;
        chip.addClass("is-dragging");
      }
      try {
        const canvasPos: Pos = canvas.posFromEvt(evt);
        const t = this.nearestFractionOnPath(edge, canvasPos);
        if (t !== null) {
          this.setEdgeData(edge, { [posKey]: t }, false);
          this.repositionChips(edge);
        }
      } catch (e) {
        /* noop */
      }
    };

    const onUp = (evt: PointerEvent) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      try {
        chip.releasePointerCapture?.(evt.pointerId);
      } catch (e) {
        /* noop */
      }
      if (dragging) {
        chip.removeClass("is-dragging");
        // One undo step for the whole slide.
        this.setEdgeData(edge, {}, true);
      } else {
        // Never moved -> it was a click: open the editor.
        this.beginEditingChip(edge, chip, which);
      }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }

  private beginEditingChip(edge: any, chip: HTMLElement, which: "labelStart" | "labelEnd") {
    chip.setAttribute("contenteditable", "true");
    chip.removeClass("is-empty");
    chip.focus();

    // Select all existing text for quick overwrite.
    const range = document.createRange();
    range.selectNodeContents(chip);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const finish = (save: boolean) => {
      chip.removeEventListener("keydown", onKeydown);
      chip.removeEventListener("blur", onBlur);
      chip.setAttribute("contenteditable", "false");

      if (save) {
        const value = chip.textContent?.trim() ?? "";
        this.setEdgeData(edge, { [which]: value }, true);
        chip.toggleClass("is-empty", !value);
      }
      window.getSelection()?.removeAllRanges();
    };

    const onKeydown = (evt: KeyboardEvent) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        finish(true);
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        chip.setText((edge.getData()[which] ?? ""));
        finish(false);
      }
    };
    const onBlur = () => finish(true);

    chip.addEventListener("keydown", onKeydown);
    chip.addEventListener("blur", onBlur);
  }

  private repositionChips(edge: any) {
    const chips = edge.__dualAnchorsChips;
    const handles = edge.__dualAnchorsHandles;
    if (!chips && !handles) return;

    const data = edge.getData ? edge.getData() : {};
    const startT = typeof data.labelStartT === "number" ? data.labelStartT : 0.12;
    const endT = typeof data.labelEndT === "number" ? data.labelEndT : 0.88;

    // Preferred: sample the RENDERED SVG path. This is style-agnostic -- it is
    // correct whether the line is core's bezier or Advanced Canvas's direct/
    // square/A* pathfinding, because we measure what's actually on screen.
    const pathEl: any = edge.path?.display;
    if (pathEl && typeof pathEl.getTotalLength === "function") {
      try {
        const len = pathEl.getTotalLength();
        if (len > 0) {
          if (chips) {
            const s = pathEl.getPointAtLength(len * startT);
            const e = pathEl.getPointAtLength(len * endT);
            (chips.startChip as any).__pinned = typeof data.labelStartT === "number";
            (chips.endChip as any).__pinned = typeof data.labelEndT === "number";
            this.placeAt(chips.startChip, { x: s.x, y: s.y });
            this.placeAt(chips.endChip, { x: e.x, y: e.y });
          }
          if (handles) {
            const p0 = pathEl.getPointAtLength(0);
            const p3 = pathEl.getPointAtLength(len);
            this.placeAt(handles.fromHandle, { x: p0.x, y: p0.y }, true);
            this.placeAt(handles.toHandle, { x: p3.x, y: p3.y }, true);
          }
          return;
        }
      } catch (e) {
        /* fall through to bezier math */
      }
    }

    // Fallback: cubic bezier sampling from edge.bezier.
    const bezier = edge.bezier;
    if (!bezier) return;

    const p0: Pos = bezier.from, p1: Pos = bezier.cp1, p2: Pos = bezier.cp2, p3: Pos = bezier.to;

    if (chips) {
      const startPt = cubicBezierPoint(p0, p1, p2, p3, startT);
      const endPt = cubicBezierPoint(p0, p1, p2, p3, endT);
      this.placeAt(chips.startChip, startPt);
      this.placeAt(chips.endChip, endPt);
    }

    if (handles) {
      this.placeAt(handles.fromHandle, p0, true);
      this.placeAt(handles.toHandle, p3, true);
    }
  }

  private placeAt(el: HTMLElement, pos: Pos, small = false) {
    if (!el) return;
    // Remember the "natural" position; the overlap resolver applies its stack
    // offset on top of this rather than fighting with it.
    (el as any).__basePos = pos;
    const nudge = (el as any).__stackNudge ?? 0;
    el.style.transform = `translate(${pos.x}px, ${pos.y + nudge}px) translate(-50%, -50%)`;
  }

  // ---- feature 2: slidable anchors --------------------------------------

  private applyCustomOffsets(edge: any) {
    const data = edge.getData ? edge.getData() : {};
    const fromOffset = typeof data.fromOffset === "number" ? data.fromOffset : DEFAULT_OFFSET;
    const toOffset = typeof data.toOffset === "number" ? data.toOffset : DEFAULT_OFFSET;

    if (fromOffset === DEFAULT_OFFSET && toOffset === DEFAULT_OFFSET) return; // native behavior is fine
    if (!edge.bezier || !edge.from?.node || !edge.to?.node) return;

    const fromBBox: BBox = edge.from.node.getBBox();
    const toBBox: BBox = edge.to.node.getBBox();
    const fromSide: Side = edge.from.side;
    const toSide: Side = edge.to.side;

    const oldFrom = { ...edge.bezier.from };
    const oldTo = { ...edge.bezier.to };

    const newFrom = sidePoint(fromBBox, fromSide, fromOffset);
    const newTo = sidePoint(toBBox, toSide, toOffset);

    const dFromX = newFrom.x - oldFrom.x, dFromY = newFrom.y - oldFrom.y;
    const dToX = newTo.x - oldTo.x, dToY = newTo.y - oldTo.y;

    // Mutating edge.bezier.from/to matters even for Advanced Canvas styles:
    // AC's pathfinding methods (direct/square/A*) read their start/end points
    // from edge.bezier, so offset endpoints flow into AC's paths for free.
    edge.bezier.from = newFrom;
    edge.bezier.to = newTo;
    edge.bezier.cp1 = { x: edge.bezier.cp1.x + dFromX, y: edge.bezier.cp1.y + dFromY };
    edge.bezier.cp2 = { x: edge.bezier.cp2.x + dToX, y: edge.bezier.cp2.y + dToY };

    // Who owns the drawn path?
    const pathStyle: string | undefined = data.styleAttributes?.pathfindingMethod;

    let d: string;
    if (pathStyle === "square" || pathStyle === "a-star") {
      // AC computes these routes itself (from our mutated bezier endpoints).
      // Overwriting d here would stomp its right-angle/A* geometry, so leave
      // the drawn path alone and only fix up the arrowheads.
      this.repositionLineEnd(edge.fromLineEnd?.el, edge.bezier.from, edge.bezier.cp1);
      this.repositionLineEnd(edge.toLineEnd?.el, edge.bezier.to, edge.bezier.cp2);
      return;
    } else if (pathStyle === "direct") {
      // AC's straight line: same output AC would produce, with our endpoints.
      d = `M ${edge.bezier.from.x} ${edge.bezier.from.y} L ${edge.bezier.to.x} ${edge.bezier.to.y}`;
    } else {
      d = `M ${edge.bezier.from.x} ${edge.bezier.from.y} C ${edge.bezier.cp1.x} ${edge.bezier.cp1.y}, ${edge.bezier.cp2.x} ${edge.bezier.cp2.y}, ${edge.bezier.to.x} ${edge.bezier.to.y}`;
    }
    edge.bezier.path = d;

    this.setPathD(edge.path?.display, d);
    this.setPathD(edge.path?.interaction, d);

    if (pathStyle === "direct") {
      // Arrow angle along the straight segment, not the (now meaningless) cps.
      this.repositionLineEnd(edge.fromLineEnd?.el, edge.bezier.from, edge.bezier.to);
      this.repositionLineEnd(edge.toLineEnd?.el, edge.bezier.to, edge.bezier.from);
    } else {
      this.repositionLineEnd(edge.fromLineEnd?.el, edge.bezier.from, edge.bezier.cp1);
      this.repositionLineEnd(edge.toLineEnd?.el, edge.bezier.to, edge.bezier.cp2);
    }
  }

  private setPathD(el: HTMLElement | undefined, d: string) {
    if (!el) return;
    if (typeof (el as any).setAttribute === "function" && (el.tagName === "path" || el.tagName === "PATH")) {
      el.setAttribute("d", d);
    }
  }

  private repositionLineEnd(el: HTMLElement | undefined, tip: Pos, controlPt: Pos) {
    if (!el) return;
    const angle = Math.atan2(tip.y - controlPt.y, tip.x - controlPt.x) * (180 / Math.PI);
    el.style.transform = `translate(${tip.x}px, ${tip.y}px) rotate(${angle}deg)`;
  }

  private beginDraggingAnchor(edge: any, which: "from" | "to", startEvt: PointerEvent) {
    const canvas = edge.canvas;
    const node = which === "from" ? edge.from.node : edge.to.node;
    const side: Side = which === "from" ? edge.from.side : edge.to.side;

    // Capture the pointer on the handle: without this, moving the mouse
    // faster than the ticker repositions the dot makes the cursor leave the
    // element and the drag dies (one of the "can't grab" symptoms).
    const handleEl = startEvt.target as HTMLElement;
    try {
      handleEl?.setPointerCapture?.(startEvt.pointerId);
    } catch (e) {
      /* capture is an optimization, not a requirement */
    }

    const onMove = (evt: PointerEvent) => {
      try {
        const canvasPos: Pos = canvas.posFromEvt(evt);
        const bbox: BBox = node.getBBox();
        let fraction = fractionAlongSide(bbox, side, canvasPos);

        // Snap back to dead-center when close to it (hold Alt to bypass and
        // place freely). Center is where native Canvas puts anchors, so a
        // gentle magnet makes "undo my offset" a one-second drag.
        const SNAP_THRESHOLD = 0.05;
        if (!evt.altKey && Math.abs(fraction - DEFAULT_OFFSET) < SNAP_THRESHOLD) {
          fraction = DEFAULT_OFFSET;
        }

        const key = which === "from" ? "fromOffset" : "toOffset";
        this.setEdgeData(edge, { [key]: fraction }, false);
        edge.updatePath?.();
      } catch (e) {
        /* noop */
      }
    };

    const onUp = (evt: PointerEvent) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      try {
        handleEl?.releasePointerCapture?.(evt.pointerId);
      } catch (e) {
        /* noop */
      }
      // Single undo step for the whole drag gesture.
      this.setEdgeData(edge, {}, true);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }
}

class CdaSettingTab extends PluginSettingTab {
  plugin: CanvasDualAnchorsPlugin;

  constructor(app: App, plugin: CanvasDualAnchorsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Show empty label placeholders")
      .setDesc(
        "Show the small \"+\" chips on connections that don't have a start/end " +
        "label yet. Turn off for clean screenshots -- labels you've already " +
        "typed stay visible, only the empty placeholders are hidden. " +
        "(Also toggleable from the command palette.)"
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showEmptyChips).onChange(async (value) => {
          this.plugin.settings.showEmptyChips = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show connection anchor dots")
      .setDesc(
        "Show the draggable dots at each end of a connection. Turn off for " +
        "screenshots. Note: with dots hidden you can't drag anchors, but " +
        "existing offsets still apply and everything else keeps working. " +
        "(Also toggleable from the command palette.)"
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showHandles).onChange(async (value) => {
          this.plugin.settings.showHandles = value;
          await this.plugin.saveSettings();
        })
      );
  }
}
