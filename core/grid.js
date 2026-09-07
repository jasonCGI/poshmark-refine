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

/**
 * Every tile on the page, whatever grid it does or does not belong to.
 *
 * This is deliberately NOT derived from findGrids(). A lone card whose nearest
 * multi-tile ancestor is dropped by the innermost-container filter belongs to no
 * returned grid, and judging only grid members left it permanently unseen - which
 * made the document-wide convergence check schedule a pass every frame, forever.
 * Judge from here; sort from findGrids().
 */
export function allTiles(root, SEL) {
  return [...root.querySelectorAll(SEL.tile)];
}

/** Tiles present on the page but inside no detected grid. Should be judged too. */
export function orphanTiles(root, SEL) {
  const covered = new Set();
  for (const g of findGrids(root, SEL)) for (const t of g.querySelectorAll(SEL.tile)) covered.add(t);
  return allTiles(root, SEL).filter((t) => !covered.has(t));
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
    // price and condition are filterable, so a change to either can flip a
    // verdict. Leaving them out let a re-priced card, or one that lost its NWT
    // badge, keep a verdict that is no longer true.
    SEL.price ? text(tile, SEL.price) : "",
    SEL.condition ? text(tile, SEL.condition) : "",
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

/**
 * Why cards were hidden, tallied by the constraint that did it.
 *
 * A zero-match search is the moment the shopper most needs an explanation, and
 * "0 matched" alone gives them nothing to act on. judge() records the cause on
 * each hidden tile; this counts them so the HUD can say which constraint did
 * the damage.
 */
export function countCauses(grids, SEL) {
  const causes = {};
  for (const grid of grids) {
    for (const t of grid.querySelectorAll(SEL.tile)) {
      const c = t.dataset.pmrCause;
      if (c) causes[c] = (causes[c] || 0) + 1;
    }
  }
  return causes;
}

/** The biggest culprits first, as [cause, n] pairs. */
export function topCauses(grids, SEL, limit = 2) {
  return Object.entries(countCauses(grids, SEL)).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

/** Total tiles across all grids - zero on a results page means selector drift. */
export function countTiles(grids, SEL) {
  let n = 0;
  for (const grid of grids) n += grid.querySelectorAll(SEL.tile).length;
  return n;
}

// ---------------------------------------------------------------------------
// Lazy-load repair.
//
// Poshmark ships each cover as a <picture> whose <source>s carry `data-srcset`
// and whose <img> carries `data-src`, and promotes them to the real attributes
// with an IntersectionObserver when the tile scrolls into view. Re-sorting
// detaches and re-appends tiles, and that handoff never completes for the ones
// we moved: measured on a live search, 35 of 48 covers stayed blank, including
// every card that MATCHED. A filter that surfaces the right listings without
// their pictures has not helped anyone buy clothes.
//
// So we finish the promotion the page had already set up. We do NOT promote on
// sight: the caller only calls this for a tile that is actually in view, which
// is the same condition Poshmark's own observer applies. No image is fetched
// that the shopper's own scroll would not have fetched.

/** Does this tile still hold a cover the page prepared but never loaded? */
export function hasPendingLazy(tile) {
  if (!tile) return false;
  return !!tile.querySelector("img[data-src]:not([src]), source[data-srcset]:not([srcset])");
}

/**
 * Promote data-srcset/data-src to srcset/src inside one tile.
 *
 * Sources go first: <picture> picks a candidate when the img gets its src, so
 * setting the img first would load the fallback JPEG and keep it even once the
 * webp sources appeared. Returns true when something was promoted.
 */
export function promoteLazy(tile) {
  if (!tile) return false;
  let did = false;
  for (const s of tile.querySelectorAll("source[data-srcset]:not([srcset])")) {
    s.setAttribute("srcset", s.getAttribute("data-srcset"));
    did = true;
  }
  for (const img of tile.querySelectorAll("img[data-src]:not([src])")) {
    img.setAttribute("src", img.getAttribute("data-src"));
    did = true;
  }
  return did;
}

/**
 * Keep a floating box inside the viewport, with a margin.
 *
 * Pure maths so it can be tested without a window. This lived inline in the
 * drag handler and NOWHERE else, which is how a HUD position saved on a taller
 * window came to be restored verbatim: measured live at top:864 in an 839px
 * viewport, i.e. below the bottom edge, and unrecoverable because the drag
 * handle is the box itself. Every path that positions the HUD now goes
 * through this.
 *
 * The inner Math.max guards a viewport SMALLER than the box, where
 * `viewH - elH - margin` goes negative and would otherwise pin it off the top.
 */
export function clampToViewport(left, top, elW, elH, viewW, viewH, margin = 6) {
  return {
    left: Math.max(margin, Math.min(Math.max(margin, viewW - elW - margin), left)),
    top: Math.max(margin, Math.min(Math.max(margin, viewH - elH - margin), top)),
  };
}
