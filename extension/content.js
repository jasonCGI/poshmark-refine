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
  const N = await import(chrome.runtime.getURL("core/normalize.js"));
  const { coloursFromTitle, sizeFromText, colourwayCandidates } = N;
  const COLOUR_FAMILY_NAMES = Object.keys(N.COLOUR_FAMILIES);
  const G = await import(chrome.runtime.getURL("core/grid.js"));
  const AI = await import(chrome.runtime.getURL("core/ai.js"));

  const SEL = {
    tile: "div.tile-grid-redesign",
    title: ".tile-grid-redesign__title",
    size: ".tile-grid-redesign__size",
    condition: ".tile-grid-redesign__condition-wrap",
    media: ".tile-grid-redesign__media--wrapper",
    price: ".tile-grid-redesign__price-current",
    link: "a.tile-grid-redesign__meta-link, a.tile__covershot",
  };

  const DEFAULTS = {
    profiles: { me: { tops: [] } },
    who: "me",
    category: "tops",
    brands: [],
    colours: [],
    colourTerms: [],
    corrections: { brands: {}, colours: {} },
    useAi: false,            // on-device Prompt API tier, opt-in
    maxPrice: null,
    conditions: [],
    hideMode: "fade",        // 'fade' | 'hide'
    tier3: true,             // hover read of the listing page for colour
  };

  let settings = DEFAULTS;
  const colourCache = new Map();   // listing path -> Set of colour families (this tab only)
  const sizeCache = new Map();     // listing path -> size described in the body
  const bodyCache = new Map();     // listing path -> body text, for colourway terms
  const aiCache = new Map();       // listing path -> on-device reading (this tab)
  let aiReady = null;              // null = not yet checked

  // Colourway vocabulary, LEARNED from the listings the shopper is already
  // looking at. There is no published list of a brand's current and former
  // colourways, so the alternative to learning would be inventing one. Harvested
  // in memory and flushed to storage when the page goes quiet, where the popup
  // and settings page offer them as autocomplete.
  const learned = new Set();
  let learnTimer = null;
  const LEARN_CAP = 400;
  function learn(fromText) {
    for (const c of colourwayCandidates(fromText)) learned.add(c);
    if (learnTimer) return;
    learnTimer = setTimeout(flushLearned, 2500);
  }
  async function flushLearned() {
    learnTimer = null;
    if (!learned.size) return;
    try {
      const stored = (await chrome.storage.local.get("learnedColourways")).learnedColourways || [];
      const merged = [...new Set([...stored, ...learned])].sort().slice(0, LEARN_CAP);
      if (merged.length !== stored.length) await chrome.storage.local.set({ learnedColourways: merged });
    } catch (e) { /* settings are a convenience, never break the page for them */ }
  }
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


  async function loadSettings() {
    // The fit ledger is a top-level key, not part of `refine`: it is a record of
    // what happened, not a search preference, and keeping it separate means the
    // merge logic that protects concurrent edits to `refine` never has to
    // reason about it.
    const stored = await chrome.storage.local.get(["refine", "fitLedger"]);
    settings = Object.assign({}, DEFAULTS, stored.refine || {});
    settings.fitLedger = Array.isArray(stored.fitLedger) ? stored.fitLedger : null;
  }

  // The DOM layer lives in core/grid.js so jsdom can drive it in test/dom.test.js.
  // Bind the selector map once; these ARE the tested functions, not copies.
  const text = (el, sel) => G.text(el, sel);
  const findGrids = () => G.findGrids(document, SEL);
  const resort = (grid) => G.resort(grid, SEL);
  const signatureOf = (tile) => G.signatureOf(tile, SEL);
  const countStates = (grids) => G.countStates(grids, SEL);
  const countTiles = (grids) => G.countTiles(grids, SEL);
  const shouldReapply = (muts) => G.shouldReapply(muts, SEL);

  // Re-sorting re-appends tiles, which strands Poshmark's own lazy-load: the
  // <picture> keeps its data-srcset/data-src and never gets the real ones, so
  // the cover stays blank. We finish that promotion, but only for a tile the
  // shopper can actually see - the same trigger the page uses - so this loads
  // no image their scroll would not have loaded. A small margin means the
  // cover is there as the row arrives rather than flashing in after it.
  //
  // Safe against the observer loop that froze the tab once: srcset/src are
  // ATTRIBUTE writes, and observeOpts filters attributes down to href, so
  // nothing here feeds back into apply().
  const lazyIo = "IntersectionObserver" in window
    ? new IntersectionObserver((entries, io) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          G.promoteLazy(e.target);
          io.unobserve(e.target);
        }
      }, { rootMargin: "150px" })
    : null;

  function watchLazy(root) {
    if (!lazyIo) return;
    for (const tile of (root || document).querySelectorAll(SEL.tile)) {
      if (G.hasPendingLazy(tile)) lazyIo.observe(tile);
    }
  }
  const allTiles = () => G.allTiles(document, SEL);
  const topCauses = (grids) => G.topCauses(grids, SEL);


  function currentIntent() {
    return intentFor(settings.profiles, settings.who, settings.category, {
      brands: settings.brands,
      colours: settings.colours,
      colourTerms: settings.colourTerms,
      maxPrice: Number(settings.maxPrice) || null,
      conditions: settings.conditions,
      fitLedger: settings.fitLedger,
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
    // Shopping for the whole family, a bare "Match" makes you work out who it
    // fits by eye. Name them. One or two fit on the badge; beyond that the
    // count goes on the badge and the names go in its title.
    let label = { show: "Match", dim: "Check", hide: "Off" }[v.state] || "";
    let who = "";
    const fits = (v.fits || []).filter(Boolean);
    if (v.state !== "hide" && currentIntent().who === "anyone" && fits.length) {
      label = fits.length <= 2 ? "Fits " + fits.join(" or ") : "Fits " + fits.length;
      who = "Fits " + fits.join(", ") + ". ";
    }
    badge.textContent = label;
    // One title. Setting it twice meant the names never survived to the tooltip.
    badge.title = who + "Click to teach Refine about this listing";
    badge.setAttribute("aria-label", "Poshmark Refine: " + (who || label + ". ") + "Correct this listing");
    if (!badge.dataset.pmrWired) {
      badge.dataset.pmrWired = "1";
      // A span with a click handler is a button nobody can reach. The whole
      // correction feature was mouse-only until this.
      badge.setAttribute("role", "button");
      badge.setAttribute("tabindex", "0");
      const open = (e) => { e.preventDefault(); e.stopPropagation(); openCorrect(tile); };
      badge.addEventListener("click", open);
      badge.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") open(e);
      });
    }
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

  // ---- correction affordance -----------------------------------------------
  // The tables have always said they "grow from the shopper's corrections".
  // This is where a correction is made: click a badge, tell it the brand or the
  // colour it could not read, and it remembers - for every listing, not just
  // this one, because the correction teaches the WORD, not the card.
  // Whichever badge opened the popover, so every way out returns focus there -
  // Escape, Cancel and Save alike, not just the one path that remembered to.
  let correctOpener = null;
  function closeCorrect(restoreFocus) {
    document.getElementById("pmr-correct")?.remove();
    if (restoreFocus && correctOpener && document.contains(correctOpener)) correctOpener.focus();
    correctOpener = null;
  }

  async function saveCorrection(kind, key, value) {
    const stored = (await chrome.storage.local.get("refine")).refine || {};
    const corr = Object.assign({ brands: {}, colours: {} }, stored.corrections);
    corr[kind] = Object.assign({}, corr[kind], { [String(key).toLowerCase()]: value });
    await chrome.storage.local.set({ refine: Object.assign({}, stored, { corrections: corr }) });
    // storage.onChanged re-runs apply(), so every card re-judges with the new word
  }

  function openCorrect(tile) {
    closeCorrect();
    const title = text(tile, SEL.title);
    const box = document.createElement("div");
    box.id = "pmr-correct";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Teach Refine about this listing");
    box.innerHTML =
      '<div class="pmr-correct-hd">Teach Refine</div>' +
      '<div class="pmr-correct-t"></div>' +
      '<label>This brand is</label><input class="pmr-c-brand" type="text" placeholder="e.g. Vuori">' +
      '<label>This colour is</label><div class="pmr-c-colours"></div>' +
      '<div class="pmr-correct-ft"><button class="pmr-c-save">Save</button>' +
      '<button class="pmr-c-cancel">Cancel</button></div>';
    box.querySelector(".pmr-correct-t").textContent = title;

    // which WORD are we teaching? the longest word not already understood
    const card = parseCard({ title }, settings.category, settings.corrections);
    const words = title.split(/[^\p{L}\p{N}'’-]+/u).filter((w) => w.length > 2);
    const unknownWord = words.find((w) => w.length > 3) || words[0] || "";

    let chosen = null;
    const cols = box.querySelector(".pmr-c-colours");
    for (const fam of COLOUR_FAMILY_NAMES) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "pmr-c-chip"; b.textContent = fam;
      b.addEventListener("click", () => {
        chosen = chosen === fam ? null : fam;
        for (const o of cols.children) o.classList.toggle("on", o.textContent === chosen);
      });
      cols.appendChild(b);
    }
    box.querySelector(".pmr-c-brand").value = card.brand.canonical || "";
    box.querySelector(".pmr-c-cancel").addEventListener("click", () => closeCorrect(true));
    box.querySelector(".pmr-c-save").addEventListener("click", async () => {
      const brand = box.querySelector(".pmr-c-brand").value.trim();
      if (brand && card.brand.canonical !== brand) {
        // teach the brand word that appears in this title, not the whole title
        const key = words.find((w) => brand.toLowerCase().includes(w.toLowerCase())) || words[0];
        if (key) await saveCorrection("brands", key, brand);
      }
      if (chosen && unknownWord) await saveCorrection("colours", unknownWord, chosen);
      closeCorrect(true);
    });
    // Escape closes, and focus goes back where it came from. Without this a
    // keyboard user who opens the popover is dropped into the page behind it
    // with no way back to the card they were on.
    correctOpener = tile.querySelector(".pmr-badge");
    box.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeCorrect(true);
    });
    (tile.querySelector(SEL.media) || tile).appendChild(box);
    box.querySelector(".pmr-c-brand").focus();
  }

  function judge(tile) {
    // Mark every tile we look at, titled or not (ad tiles have no title). The
    // observer and the convergence check below both key off this, so a tile we
    // deliberately skip cannot spin them forever.
    tile.dataset.pmrSeen = "1";
    tile.dataset.pmrSig = signatureOf(tile);
    const fields = {
      title: text(tile, SEL.title),
      size: text(tile, SEL.size),
      price: text(tile, SEL.price),
      condition: text(tile, SEL.condition),
      // an ABSENT condition element is unknown; an empty one means "not new"
      conditionKnown: !!tile.querySelector(SEL.condition),
    };
    if (!fields.title) return;
    learn(fields.title);
    const card = parseCard(fields, settings.category, settings.corrections);
    const link = tile.querySelector(SEL.link);
    const path = link ? (link.getAttribute("href") || "").split("?")[0] : "";
    // Keep the listing's colours SEPARATE from the title's. Merging them let a
    // coarse structured field hide an item the title never contradicted.
    if (path && colourCache.has(path)) card.bodyColours = colourCache.get(path);
    if (path && sizeCache.get(path)) card.describedSize = sizeCache.get(path);
    if (path && bodyCache.has(path)) card.bodyText = bodyCache.get(path);
    // The on-device reading is applied LAST and can only fill what is still
    // unknown; mergeAiIntoCard refuses to overwrite anything already known.
    if (path && aiCache.has(path)) {
      Object.assign(card, AI.mergeAiIntoCard(card, aiCache.get(path), { normalizeSize: N.normalizeSize, coloursFromTitle }));
    }
    const v = verdict(card, currentIntent());
    decorate(tile, v);
    tile.dataset.pmrPath = path;
    if (v.cause) tile.dataset.pmrCause = v.cause; else delete tile.dataset.pmrCause;
    tile.dataset.pmrColourUnknown = String(
      card.colours.size === 0 && !(card.bodyColours && card.bodyColours.size) && !!settings.colours.length);
    tile.dataset.pmrSizeUnknown = String(card.size.confidence === "unknown" && !!currentIntent().sizes);
    tile.dataset.pmrTermUnknown = String(!!(settings.colourTerms || []).length && !card.bodyText);
  }



  // Tier 3: on hover, read the listing page under the pointer for its colour.
  // One request in flight at a time; cached per tab; never triggered by scroll.
  async function hoverRead(tile) {
    if (!settings.tier3) return;
    if (tile.dataset.pmrColourUnknown !== "true"
      && tile.dataset.pmrSizeUnknown !== "true"
      && tile.dataset.pmrTermUnknown !== "true") return;
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
      // The listing's structured size is the same value the card already shows,
      // so when the card is blank the only new information is the prose.
      sizeCache.set(path, sizeFromText(desc + " " + detail, settings.category));
      // keep a slice of the body so a colourway phrase can be matched against it
      bodyCache.set(path, (jsonColour + " " + desc).slice(0, 2000));
      learn(jsonColour + " " + desc.slice(0, 600));
    } catch {
      colourCache.set(path, new Set());     // do not retry a failed read this tab
      sizeCache.set(path, null);
      bodyCache.set(path, "");
    } finally {
      inflight = null;
    }
    // Still unknown after reading the listing? Ask the on-device model, if the
    // shopper turned it on and Chrome actually has it. One listing at a time,
    // cached per tab, and nothing leaves the device.
    if (settings.useAi && !aiCache.has(path)) {
      if (aiReady === null) {
        const api = AI.resolveApi(globalThis);
        aiReady = api && AI.isReady(await AI.availability(api)) ? api : false;
      }
      if (aiReady) {
        aiCache.set(path, await AI.readAttributes(aiReady, {
          title: text(tile, SEL.title),
          body: bodyCache.get(path) || "",
        }));
      }
    }

    // A Tier-3 colour can move this card between show/dim/hide, so the grid has
    // to be reconciled - re-sorted and re-counted - not just this tile repainted.
    // apply() is re-entrancy guarded and resort() no-ops when the order is
    // already right, so this is cheap when the verdict did not actually change.
    apply();
  }


  // A quiet fixed summary: how many matched, need a colour check, or were hidden,
  // plus a toggle to reveal the hidden cards without leaving the search.
  // It floats (fixed to the viewport, so it stays put through infinite scroll),
  // but the shopper can drag it anywhere by the "Refine" handle and it remembers
  // the spot; a collapse control shrinks it to just the handle. Best of pinned
  // and floating without making them choose.
  const HUD_POS_KEY = "pmr-hud-pos";
  const HUD_MIN_KEY = "pmr-hud-min";

  // The last position the shopper actually CHOSE, before clamping. Kept apart
  // from the applied position so that shrinking the window and growing it back
  // returns the HUD to where they put it rather than to where it was squeezed.
  let hudDesired = null;

  // One clamp, used by the drag, the restore and the resize. It used to exist
  // only inside the drag handler, so a position saved on a taller window was
  // restored verbatim - which put the HUD below the bottom edge, where it
  // cannot be dragged back because the drag handle is the HUD itself.
  function clampHud(hud, left, top) {
    return G.clampToViewport(left, top, hud.offsetWidth, hud.offsetHeight,
                             window.innerWidth, window.innerHeight);
  }

  function placeHud(hud) {
    if (!hudDesired) return;                       // never moved: leave the CSS corner
    const { left, top } = clampHud(hud, hudDesired.left, hudDesired.top);
    hud.style.left = left + "px";
    hud.style.top = top + "px";
    hud.style.bottom = "auto";
  }

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
      const { left: nl, top: nt } = clampHud(hud, ox + (e.clientX - sx), oy + (e.clientY - sy));
      hud.style.left = nl + "px"; hud.style.top = nt + "px";
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false; hud.classList.remove("pmr-dragging");
      // Always let the pointer go - a stuck capture swallows the page's clicks.
      try { if (e && e.pointerId != null) handle.releasePointerCapture(e.pointerId); } catch (err) {}
      hudDesired = { left: parseInt(hud.style.left, 10), top: parseInt(hud.style.top, 10) };
      try { localStorage.setItem(HUD_POS_KEY, JSON.stringify(hudDesired)); } catch (e) {}
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
      if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
        hudDesired = { left: pos.left, top: pos.top };
        placeHud(hud);
      }
      if (localStorage.getItem(HUD_MIN_KEY) === "1") { hud.classList.add("pmr-collapsed"); min.textContent = "+"; }
    } catch (e) {}
    // A window that gets shorter must not strand the HUD outside it.
    window.addEventListener("resize", () => placeHud(hud));
    return hud;
  }


  function updateHud(grids) {
    const intent = currentIntent();
    const active = !!(intent.sizes || intent.brands || intent.colours || intent.colourTerms || intent.maxPrice || intent.conditions);
    const hud = ensureHud();
    hud.hidden = !active;
    if (!active) return;
    const counts = countStates(grids);
    for (const k of ["show", "dim", "hide"]) {
      hud.querySelector('[data-pmr="' + k + '"]').textContent = String(counts[k]);
    }
    hud.querySelector(".pmr-hud-reveal").hidden = counts.hide === 0;
    // A zero-match search needs a next action, not just a zero. Name the
    // constraint that removed the most cards.
    let why = hud.querySelector(".pmr-hud-why");
    if (!why) {
      why = document.createElement("span");
      why.className = "pmr-hud-why";
      hud.querySelector(".pmr-hud-body").appendChild(why);
    }
    if (counts.show === 0 && counts.hide > 0) {
      const label = { size: "size", brand: "brand", colour: "colour", price: "price", condition: "condition" };
      why.textContent = "- " + topCauses(grids).map(([c, n]) => (label[c] || c) + " removed " + n).join(", ");
      why.hidden = false;
    } else {
      why.hidden = true;
    }
  }

  function apply() {
    if (applying) return;
    const grids = findGrids();
    if (!grids.length) return;
    applying = true;
    if (mo) mo.disconnect();          // our writes below must not feed back
    try {
      // Judge EVERY tile in the document, not only those inside a detected
      // grid. A lone card whose nearest multi-tile ancestor gets dropped by the
      // innermost-container filter would otherwise never be judged, never get
      // data-pmr-seen, and the convergence check below would then schedule a
      // pass every single frame forever. Grids are for SORTING only.
      for (const tile of allTiles()) judge(tile);
      for (const grid of grids) {
        resort(grid);
        grid.dataset.pmrCount = String(grid.querySelectorAll(SEL.tile).length);
      }
      // After the move, not before: a tile that was re-appended is exactly the
      // one whose lazy-load was interrupted.
      watchLazy(document);
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
  mo = new MutationObserver((muts) => {
    if (applying) return;
    // shouldReapply() ignores our own writes and distinguishes a genuinely new
    // tile from one we merely re-ordered; it also clears the marker on a card
    // reused in place so the next pass re-judges it. Treating our own writes as
    // news is the loop that froze the tab, so this predicate is tested directly.
    if (!shouldReapply(muts) || queued) return;
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
    const grids = findGrids();
    const counts = countStates(grids);
    // tiles === 0 on a results page means our selectors no longer match, i.e.
    // Poshmark reskinned. Report it so the popup can say so instead of the
    // extension silently doing nothing.
    // Run the same assertions a human at a browser would, every time the popup
    // opens. Both bugs shipped in 0.15.0 were of this shape: visible on the
    // page in seconds, invisible to every fixture test.
    let problems = [];
    try {
      problems = G.selfCheck(document, SEL, {
        view: { width: window.innerWidth, height: window.innerHeight },
        hud: document.getElementById("pmr-hud"),
      });
    } catch (e) { /* a broken check must never break the status reply */ }
    respond({
      active: !!(intent.sizes || intent.brands || intent.colours || intent.colourTerms || intent.maxPrice || intent.conditions),
      tiles: countTiles(grids),
      problems,
      ...counts,
    });
  });

  chrome.storage.onChanged.addListener(async (changes) => {
    if (changes.refine || changes.fitLedger) { await loadSettings(); apply(); }
  });
})();
