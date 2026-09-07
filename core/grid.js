// The DOM layer of the content script, extracted so it can be tested.
//
// Every serious bug this extension has had lived here and NONE of them were
// visible to the pure-logic tests: the grid that resolved to a single tile, the
// resort/observer loop that froze the tab, the badge that escaped its card, the
// stale verdict on a reused tile. So this module takes a document/element and a
// selector map, touches no chrome API and no globals, and is driven by jsdom in
// test/dom.test.js.

/** Trimmed text of the first `sel` inside `el`, or "". */
export function text(el, sel) {
  const n = el.querySelector(sel);
  return n ? n.textContent.replace(/\s+/g, " ").trim() : "";
}

/**
 * Every results container on the page, not just the first.
 *
 * Poshmark wraps each tile in its own layout column, so a tile's parent is NOT
 * the grid. Walk up from EVERY tile to its nearest ancestor holding more than
 * one tile - doing it per tile finds a second results section too - then keep
 * only innermost containers, so a wrapper that happens to contain both sections
 * is not returned in their place.
 */
export function findGrids(root, SEL) {
  const found = new Set();
  for (const t of root.querySelectorAll(SEL.tile)) {
    let g = t.parentElement;
    while (g && g.querySelectorAll(SEL.tile).length < 2) g = g.parentElement;
    if (g) found.add(g);
    else if (t.parentElement) found.add(t.parentElement);
  }
  const all = [...found];
  return all.filter((g) => !all.some((o) => o !== g && g.contains(o)));
}

/** The reorderable unit: the direct child of `grid` that contains `tile`. */
export function wrapperOf(tile, grid) {
  let w = tile;
  while (w.parentElement && w.parentElement !== grid) w = w.parentElement;
  return w;
}

/**
 * Sort wrappers by verdict order, stable within a state.
 *
 * Returns { changed, wrappers }. `changed` is false when the grid is already in
 * this order - the caller must then touch nothing, because re-appending an
 * identical order still moves nodes, which destroys the shopper's text
 * selection and feeds the MutationObserver.
 */
export function plan(grid, SEL) {
  const tiles = [...grid.querySelectorAll(SEL.tile)];
  const keyed = tiles.map((t, i) => [Number(t.dataset.pmrOrder || 0), i, wrapperOf(t, grid)]);
  const sorted = keyed.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let changed = sorted.length !== keyed.length;
  for (let i = 0; !changed && i < sorted.length; i++) if (sorted[i] !== keyed[i]) changed = true;
  return { changed, wrappers: sorted.map((k) => k[2]) };
}

/** Apply `plan` to the DOM. No-op when the order already holds. */
export function resort(grid, SEL) {
  const { changed, wrappers } = plan(grid, SEL);
  if (!changed) return false;
  for (const w of wrappers) grid.appendChild(w);
  return true;
}

/** What makes this tile *this listing*. Changes when a card is reused in place. */
export function signatureOf(tile, SEL) {
  const link = tile.querySelector(SEL.link);
  return [
    text(tile, SEL.title),
    text(tile, SEL.size),
    link ? (link.getAttribute("href") || "").split("?")[0] : "",
  ].join("|");
}

/** Is this node one of ours? Our own writes must never feed the observer. */
export function isOurs(node) {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  return !!(el && el.closest && el.closest(".pmr-strip, .pmr-badge, #pmr-hud"));
}

/**
 * Does this batch of mutations warrant another pass?
 *
 * True for (a) a tile we have never judged - infinite scroll, and (b) a tile
 * reused in place, detected by its signature no longer matching what we
 * recorded; that tile's `pmr-seen` marker is cleared so the next pass re-judges
 * it. Our own writes are ignored, which is what keeps this out of the loop that
 * used to freeze the page.
 */
export function shouldReapply(muts, SEL) {
  for (const m of muts) {
    if (isOurs(m.target)) continue;
    for (const n of m.addedNodes || []) {
      if (n.nodeType !== 1) continue;
      const tiles = n.matches && n.matches(SEL.tile) ? [n] : (n.querySelectorAll ? n.querySelectorAll(SEL.tile) : []);
      for (const t of tiles) if (!t.dataset.pmrSeen) return true;
    }
    const host = m.target && (m.target.nodeType === 1 ? m.target : m.target.parentElement);
    const tile = host && host.closest ? host.closest(SEL.tile) : null;
    if (tile && tile.dataset.pmrSeen && signatureOf(tile, SEL) !== tile.dataset.pmrSig) {
      delete tile.dataset.pmrSeen;
      return true;
    }
  }
  return false;
}

/** Tally verdict states across every results container. */
export function countStates(grids, SEL) {
  const counts = { show: 0, dim: 0, hide: 0 };
  for (const grid of grids) {
    for (const t of grid.querySelectorAll(SEL.tile)) {
      const s = t.classList.contains("pmr-show") ? "show"
        : t.classList.contains("pmr-dim") ? "dim"
          : t.classList.contains("pmr-hide") ? "hide" : null;
      if (s) counts[s]++;
    }
  }
  return counts;
}

/** Total tiles across all grids - zero on a results page means selector drift. */
export function countTiles(grids, SEL) {
  let n = 0;
  for (const grid of grids) n += grid.querySelectorAll(SEL.tile).length;
  return n;
}
