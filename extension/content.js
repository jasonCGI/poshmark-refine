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
    media: ".tile-grid-redesign__media--wrapper",
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
  // Our own DOM writes (badges, strips, re-ordering) must never retrigger the
  // MutationObserver - that is an infinite loop that freezes the tab. We pause
  // the observer while applying and ignore mutations we caused.
  let mo = null;
  let applying = false;
  // Watch structure AND the text/href that identify a listing, so a card reused
  // in place (virtualised grid) is re-judged instead of keeping a stale verdict.
  const observeOpts = {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ["href"],
  };

  /** What makes this tile *this listing*. Changes when a card is reused. */
  function signatureOf(tile) {
    const link = tile.querySelector(SEL.link);
    return [
      text(tile, SEL.title),
      text(tile, SEL.size),
      link ? (link.getAttribute("href") || "").split("?")[0] : "",
    ].join("|");
  }

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
    // A badge on the cover image. State is carried by the badge word + colour,
    // not by opacity alone, so it survives for anyone not seeing the fade.
    const media = tile.querySelector(SEL.media) || tile;
    // The wrapper is NOT positioned by Poshmark, so an absolutely positioned
    // badge would escape to whatever distant ancestor happens to be positioned
    // and render over unrelated page furniture. Establish the containing block
    // ourselves. position:relative keeps the element in flow, so their layout
    // is unchanged.
    media.classList.add("pmr-anchor");
    let badge = media.querySelector(":scope > .pmr-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "pmr-badge";
      media.appendChild(badge);
    }
    const label = { show: "Match", dim: "Check", hide: "Off" }[v.state] || "";
    badge.textContent = label;
    badge.setAttribute("aria-label", "Poshmark Refine: " + label);
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
    // Mark every tile we look at, titled or not (ad tiles have no title). The
    // observer and the convergence check below both key off this, so a tile we
    // deliberately skip cannot spin them forever.
    tile.dataset.pmrSeen = "1";
    tile.dataset.pmrSig = signatureOf(tile);
    const fields = { title: text(tile, SEL.title), size: text(tile, SEL.size), condition: text(tile, SEL.condition) };
    if (!fields.title) return;
    const card = parseCard(fields, settings.category);
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
    const sorted = keyed.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    // If the grid is already in this order, touch nothing. Re-appending an
    // identical order still moves nodes, which destroys any text selection the
    // shopper has made and generates pointless mutations.
    let same = sorted.length === keyed.length;
    for (let i = 0; same && i < sorted.length; i++) if (sorted[i] !== keyed[i]) same = false;
    if (same) return;
    for (const [, , w] of sorted) grid.appendChild(w);
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
    // A Tier-3 colour can move this card between show/dim/hide, so the grid has
    // to be reconciled - re-sorted and re-counted - not just this tile repainted.
    // apply() is re-entrancy guarded and resort() no-ops when the order is
    // already right, so this is cheap when the verdict did not actually change.
    apply();
  }

  // The grid is the nearest ancestor of a result tile that holds more than one
  // tile. Poshmark wraps each tile in its own layout column (col-x12 col-l6 ...),
  // so a tile's immediate parent is NOT the grid - walk up until we find the real
  // container (currently .tiles_container). Falls back to the immediate parent.
  // Every result container on the page, not just the first. Poshmark wraps each
  // tile in its own layout column, so a tile's parent is NOT the grid; walk up to
  // the nearest ancestor holding more than one tile. Doing this per tile finds a
  // second results section too. Keep only innermost containers, so a wrapper that
  // happens to contain both sections is not returned instead of them.
  function findGrids() {
    const found = new Set();
    for (const t of document.querySelectorAll(SEL.tile)) {
      let g = t.parentElement;
      while (g && g.querySelectorAll(SEL.tile).length < 2) g = g.parentElement;
      if (g) found.add(g); else if (t.parentElement) found.add(t.parentElement);
    }
    const all = [...found];
    return all.filter((g) => !all.some((o) => o !== g && g.contains(o)));
  }

  // A quiet fixed summary: how many matched, need a colour check, or were hidden,
  // plus a toggle to reveal the hidden cards without leaving the search.
  // It floats (fixed to the viewport, so it stays put through infinite scroll),
  // but the shopper can drag it anywhere by the "Refine" handle and it remembers
  // the spot; a collapse control shrinks it to just the handle. Best of pinned
  // and floating without making them choose.
  const HUD_POS_KEY = "pmr-hud-pos";
  const HUD_MIN_KEY = "pmr-hud-min";

  function makeDraggable(hud, handle) {
    let ox, oy, sx, sy, dragging = false;
    handle.addEventListener("pointerdown", (e) => {
      dragging = true; handle.setPointerCapture(e.pointerId);
      const r = hud.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      hud.style.left = ox + "px"; hud.style.top = oy + "px"; hud.style.bottom = "auto";
      hud.classList.add("pmr-dragging"); e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const nl = Math.max(6, Math.min(window.innerWidth - hud.offsetWidth - 6, ox + (e.clientX - sx)));
      const nt = Math.max(6, Math.min(window.innerHeight - hud.offsetHeight - 6, oy + (e.clientY - sy)));
      hud.style.left = nl + "px"; hud.style.top = nt + "px";
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false; hud.classList.remove("pmr-dragging");
      // Always let the pointer go - a stuck capture swallows the page's clicks.
      try { if (e && e.pointerId != null) handle.releasePointerCapture(e.pointerId); } catch (err) {}
      try { localStorage.setItem(HUD_POS_KEY, JSON.stringify({ left: parseInt(hud.style.left, 10), top: parseInt(hud.style.top, 10) })); } catch (e) {}
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  function ensureHud() {
    let hud = document.getElementById("pmr-hud");
    if (hud) return hud;
    hud = document.createElement("div");
    hud.id = "pmr-hud";
    hud.setAttribute("role", "status");
    hud.innerHTML =
      '<span class="pmr-hud-brand" title="Drag to move">Refine</span>' +
      '<span class="pmr-hud-body">' +
        '<span class="pmr-hud-sep"></span>' +
        '<span class="pmr-hud-stat pmr-c-show"><span class="pmr-hud-dot"></span><b data-pmr="show">0</b> matched</span>' +
        '<span class="pmr-hud-stat pmr-c-dim"><span class="pmr-hud-dot"></span><b data-pmr="dim">0</b> to check</span>' +
        '<span class="pmr-hud-stat pmr-c-hide"><span class="pmr-hud-dot"></span><b data-pmr="hide">0</b> hidden</span>' +
        '<span class="pmr-hud-sep"></span>' +
        '<button type="button" class="pmr-hud-reveal">Show hidden</button>' +
      '</span>' +
      '<button type="button" class="pmr-hud-min" aria-label="Collapse Refine summary">–</button>';
    document.body.appendChild(hud);
    hud.querySelector(".pmr-hud-reveal").addEventListener("click", () => {
      const on = document.body.classList.toggle("pmr-reveal");
      hud.querySelector(".pmr-hud-reveal").textContent = on ? "Hide hidden" : "Show hidden";
    });
    const min = hud.querySelector(".pmr-hud-min");
    min.addEventListener("click", () => {
      const on = hud.classList.toggle("pmr-collapsed");
      min.textContent = on ? "+" : "–";
      min.setAttribute("aria-label", on ? "Expand Refine summary" : "Collapse Refine summary");
      try { localStorage.setItem(HUD_MIN_KEY, on ? "1" : "0"); } catch (e) {}
    });
    makeDraggable(hud, hud.querySelector(".pmr-hud-brand"));
    try {
      const pos = JSON.parse(localStorage.getItem(HUD_POS_KEY) || "null");
      if (pos && Number.isFinite(pos.left)) { hud.style.left = pos.left + "px"; hud.style.top = pos.top + "px"; hud.style.bottom = "auto"; }
      if (localStorage.getItem(HUD_MIN_KEY) === "1") { hud.classList.add("pmr-collapsed"); min.textContent = "+"; }
    } catch (e) {}
    return hud;
  }

  /** Tally verdict states across every results container on the page. */
  function countStates(grids) {
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

  function updateHud(grids) {
    const intent = currentIntent();
    const active = !!(intent.sizes || intent.brands || intent.colours);
    const hud = ensureHud();
    hud.hidden = !active;
    if (!active) return;
    const counts = countStates(grids);
    for (const k of ["show", "dim", "hide"]) {
      hud.querySelector('[data-pmr="' + k + '"]').textContent = String(counts[k]);
    }
    hud.querySelector(".pmr-hud-reveal").hidden = counts.hide === 0;
  }

  function apply() {
    if (applying) return;
    const grids = findGrids();
    if (!grids.length) return;
    applying = true;
    if (mo) mo.disconnect();          // our writes below must not feed back
    try {
      for (const grid of grids) {
        for (const tile of grid.querySelectorAll(SEL.tile)) judge(tile);
        resort(grid);
        grid.dataset.pmrCount = String(grid.querySelectorAll(SEL.tile).length);
      }
      updateHud(grids);
    } finally {
      if (mo) mo.observe(document.body, observeOpts);
      applying = false;
      // Tiles appended WHILE we were writing went out with the observer's record
      // queue on disconnect. judge() marks every tile it looks at, so one more
      // pass picks up any stragglers and then finds none - this converges.
      // A tile whose content was swapped in place is cleared of the marker by
      // the observer, so it is picked up here too.
      if (document.querySelector(SEL.tile + ":not([data-pmr-seen])")) {
        requestAnimationFrame(apply);
      }
    }
  }

  await loadSettings();
  apply();

  // Infinite scroll appends tiles; judge each as it arrives. React ONLY to tiles
  // we have not judged yet (no data-pmr-order): a tile we merely re-ordered is
  // not news, and treating it as news is an infinite apply -> resort -> observe
  // loop that freezes the tab. Coalesce bursts into one pass per frame.
  let queued = false;
  /** Is this mutation one of ours? Our badge/strip/HUD writes must never feed back. */
  function isOurs(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest && el.closest(".pmr-strip, .pmr-badge, #pmr-hud"));
  }
  mo = new MutationObserver((muts) => {
    if (applying) return;
    let stale = false;
    for (const m of muts) {
      if (isOurs(m.target)) continue;
      // (a) genuinely new tiles from infinite scroll
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const tiles = n.matches?.(SEL.tile) ? [n] : (n.querySelectorAll ? n.querySelectorAll(SEL.tile) : []);
        for (const t of tiles) if (!t.dataset.pmrSeen) { stale = true; break; }
        if (stale) break;
      }
      if (stale) break;
      // (b) a tile reused in place - Poshmark swapping the title text or the link
      // on an existing card. Its marker and verdict describe the OLD listing, so
      // clear the marker and let apply() re-judge it.
      const host = m.target && (m.target.nodeType === 1 ? m.target : m.target.parentElement);
      const tile = host && host.closest ? host.closest(SEL.tile) : null;
      if (tile && tile.dataset.pmrSeen && signatureOf(tile) !== tile.dataset.pmrSig) {
        delete tile.dataset.pmrSeen;
        stale = true;
        break;
      }
    }
    if (!stale || queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; apply(); });
  });
  mo.observe(document.body, observeOpts);

  document.addEventListener("mouseover", (e) => {
    const tile = e.target.closest?.(SEL.tile);
    if (tile) hoverRead(tile);
  }, { passive: true });

  // The popup asks this page how it is doing so it can show live counts (or
  // tell the shopper to refresh a tab that predates the extension load).
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg || msg.type !== "pmr:status") return;
    const intent = currentIntent();
    const counts = countStates(findGrids());
    respond({ active: !!(intent.sizes || intent.brands || intent.colours), ...counts });
  });

  chrome.storage.onChanged.addListener(async (changes) => {
    if (changes.refine) { await loadSettings(); apply(); }
  });
})();
