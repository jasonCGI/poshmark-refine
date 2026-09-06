// Content script: re-filter the result grid the shopper already loaded.
//
// Boundaries, in code and not just in the README:
//   * reads the DOM of THIS page only;
//   * the only network request it ever makes is the Tier-3 hover read - the
//     listing page under the card the shopper is pointing at, one at a time,
//     never on scroll, cached for this tab; the same GET their click would make;
//   * writes nothing anywhere except chrome.storage.local (their settings).

(async () => {
  const core = await import(chrome.runtime.getURL("core/verdict.js"));
  const { parseCard, intentFor, verdict, STATE_ORDER } = core;
  const { coloursFromTitle } = await import(chrome.runtime.getURL("core/normalize.js"));

  const SEL = {
    tile: "div.tile-grid-redesign",
    title: ".tile-grid-redesign__title",
    size: ".tile-grid-redesign__size",
    condition: ".tile-grid-redesign__condition-wrap",
    link: "a.tile-grid-redesign__meta-link, a.tile__covershot",
  };

  const DEFAULTS = {
    profiles: { me: { tops: [] } },
    who: "me",
    category: "tops",
    brands: [],
    colours: [],
    hideMode: "fade",        // 'fade' | 'hide'
    tier3: true,             // hover read of the listing page for colour
  };

  let settings = DEFAULTS;
  const colourCache = new Map();   // listing path -> Set of colour families (this tab only)
  let inflight = null;             // one Tier-3 request at a time

  async function loadSettings() {
    const stored = await chrome.storage.local.get("refine");
    settings = Object.assign({}, DEFAULTS, stored.refine || {});
  }

  function text(el, sel) {
    const n = el.querySelector(sel);
    return n ? n.textContent.replace(/\s+/g, " ").trim() : "";
  }

  function currentIntent() {
    return intentFor(settings.profiles, settings.who, settings.category, {
      brands: settings.brands,
      colours: settings.colours,
    });
  }

  function decorate(tile, v) {
    tile.classList.remove("pmr-show", "pmr-dim", "pmr-hide", "pmr-fade");
    tile.classList.add("pmr-" + v.state);
    if (v.state === "hide" && settings.hideMode === "fade") tile.classList.add("pmr-fade");
    let strip = tile.querySelector(".pmr-strip");
    if (!strip) {
      strip = document.createElement("div");
      strip.className = "pmr-strip";
      tile.appendChild(strip);
    }
    const lines = [...v.reasons, ...v.notes];
    strip.textContent = lines.length ? lines.join(" · ") : "";
    strip.hidden = lines.length === 0;
    tile.dataset.pmrOrder = String(STATE_ORDER[v.state]);
  }

  function judge(tile) {
    const fields = { title: text(tile, SEL.title), size: text(tile, SEL.size), condition: text(tile, SEL.condition) };
    if (!fields.title) return;
    const card = parseCard(fields);
    const link = tile.querySelector(SEL.link);
    const path = link ? (link.getAttribute("href") || "").split("?")[0] : "";
    if (path && colourCache.has(path)) {
      for (const c of colourCache.get(path)) card.colours.add(c);
    }
    const v = verdict(card, currentIntent());
    decorate(tile, v);
    tile.dataset.pmrPath = path;
    tile.dataset.pmrColourUnknown = String(card.colours.size === 0 && !!settings.colours.length);
  }

  // Reorder by moving each tile's WRAPPER (the direct child of the grid that
  // contains it), not the tile itself - the tile lives inside a layout column
  // and detaching it from that column would break Poshmark's grid.
  function wrapperOf(tile, grid) {
    let w = tile;
    while (w.parentElement && w.parentElement !== grid) w = w.parentElement;
    return w;
  }

  function resort(grid) {
    const tiles = [...grid.querySelectorAll(SEL.tile)];
    const keyed = tiles.map((t, i) => [Number(t.dataset.pmrOrder || 0), i, wrapperOf(t, grid)]);
    keyed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [, , w] of keyed) grid.appendChild(w);
  }

  // Tier 3: on hover, read the listing page under the pointer for its colour.
  // One request in flight at a time; cached per tab; never triggered by scroll.
  async function hoverRead(tile) {
    if (!settings.tier3 || tile.dataset.pmrColourUnknown !== "true") return;
    const path = tile.dataset.pmrPath;
    if (!path || colourCache.has(path) || inflight) return;
    inflight = path;
    try {
      const res = await fetch(location.origin + path, { credentials: "same-origin" });
      const html = await res.text();
      // Poshmark embeds the listing as JSON with a structured colour field; read
      // that first - it is authoritative when the seller filled it in (an empty
      // "color":"" contributes nothing). Then fall back to the visible labelled
      // detail and the description text.
      const jsonColour = (html.match(/"colou?rs?"\s*:\s*"([^"]+)"/i) || [])[1] || "";
      const doc = new DOMParser().parseFromString(html, "text/html");
      const detail = [...doc.querySelectorAll("[class*='listing__'], [class*='detail'], [class*='color']")]
        .map((n) => n.textContent).join(" ");
      const desc = (doc.querySelector("[class*='description']") || {}).textContent || "";
      const found = coloursFromTitle(jsonColour + " " + detail + " " + desc);
      colourCache.set(path, found);
    } catch {
      colourCache.set(path, new Set());     // do not retry a failed read this tab
    } finally {
      inflight = null;
    }
    judge(tile);
  }

  // The grid is the nearest ancestor of a result tile that holds more than one
  // tile. Poshmark wraps each tile in its own layout column (col-x12 col-l6 ...),
  // so a tile's immediate parent is NOT the grid - walk up until we find the real
  // container (currently .tiles_container). Falls back to the immediate parent.
  function findGrid() {
    const first = document.querySelector(SEL.tile);
    if (!first) return null;
    let g = first.parentElement;
    while (g && g.querySelectorAll(SEL.tile).length < 2) g = g.parentElement;
    return g || first.parentElement;
  }

  function apply() {
    const grid = findGrid();
    if (!grid) return;
    for (const tile of grid.querySelectorAll(SEL.tile)) judge(tile);
    resort(grid);
    grid.dataset.pmrCount = String(grid.querySelectorAll(SEL.tile).length);
  }

  await loadSettings();
  apply();

  // Infinite scroll appends tiles; judge each as it arrives.
  const mo = new MutationObserver((muts) => {
    let touched = false;
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1 && (n.matches?.(SEL.tile) || n.querySelector?.(SEL.tile))) touched = true;
    }
    if (touched) apply();
  });
  mo.observe(document.body, { childList: true, subtree: true });

  document.addEventListener("mouseover", (e) => {
    const tile = e.target.closest?.(SEL.tile);
    if (tile) hoverRead(tile);
  }, { passive: true });

  chrome.storage.onChanged.addListener(async (changes) => {
    if (changes.refine) { await loadSettings(); apply(); }
  });
})();
