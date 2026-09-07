// Brand-site bridge: "Find on Poshmark" on a brand's own product page.
//
// Boundaries, same as the Poshmark side:
//   * reads the DOM of THIS page only - no network request of any kind;
//   * writes nothing anywhere except chrome.storage.local (the shopper's own
//     settings), and only the fields this button owns;
//   * opening the search tab goes through the service worker, because a content
//     script cannot call chrome.tabs.

(async () => {
  const { extractProduct, searchQueryFor } = await import(chrome.runtime.getURL("core/brand.js"));
  const { poshmarkSearchUrl } = await import(chrome.runtime.getURL("core/search.js"));

  const BTN_ID = "pmr-find-on-poshmark";
  let lastHref = "";

  /** Merge, never clobber: read fresh and set only the fields this button owns. */
  async function applyCriteria(product) {
    const stored = (await chrome.storage.local.get("refine")).refine || {};
    const next = Object.assign({}, stored, {
      brands: [product.brand],
      query: searchQueryFor(product),
      category: product.category,
      // a product with no stated colourway is UNKNOWN, not colourless - filter
      // on one only when the page actually named it
      colourTerms: product.colour ? [product.colour] : (stored.colourTerms || []),
    });
    // profiles, sizes, who, behaviour and department are the shopper's - untouched
    await chrome.storage.local.set({ refine: next });

    // The brand's own page is the authoritative source for a colourway name, so
    // bank it for the popup's autocomplete.
    if (product.colour) {
      const learned = (await chrome.storage.local.get("learnedColourways")).learnedColourways || [];
      if (!learned.some((t) => t.toLowerCase() === product.colour.toLowerCase())) {
        await chrome.storage.local.set({
          learnedColourways: [...new Set([...learned, product.colour])].sort().slice(0, 400),
        });
      }
    }
    return next;
  }

  async function go(product, btn) {
    btn.disabled = true;
    const label = btn.querySelector(".pmr-fop-label");
    const was = label.textContent;
    label.textContent = "Opening...";
    try {
      const next = await applyCriteria(product);
      const url = poshmarkSearchUrl({
        query: next.query,
        department: next.department || "Women",
        category: next.category,
      });
      await chrome.runtime.sendMessage({ type: "pmr:open-search", url });
    } catch (e) {
      label.textContent = "Could not open";
      setTimeout(() => { label.textContent = was; btn.disabled = false; }, 1800);
      return;
    }
    label.textContent = was;
    btn.disabled = false;
  }

  function render(product) {
    document.getElementById(BTN_ID)?.remove();
    const h1 = document.querySelector("h1");
    if (!h1) return;

    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.innerHTML =
      '<span class="pmr-fop-mark">P</span>' +
      '<span class="pmr-fop-label">Find on Poshmark</span>' +
      (product.colour ? '<span class="pmr-fop-sub"></span>' : "");
    const sub = btn.querySelector(".pmr-fop-sub");
    if (sub) sub.textContent = product.colour;
    btn.title = "Search Poshmark for " + searchQueryFor(product) +
      (product.colour ? " in " + product.colour : "") + ", filtered to your sizes";
    btn.addEventListener("click", () => go(product, btn));

    // after the title, so it reads as part of the product, not the site chrome
    (h1.parentElement || h1).insertBefore(btn, h1.nextSibling);
  }

  // The shopper's own brand sites sit alongside the built-in ones. Held in a
  // variable and refreshed on change rather than read inside sync(): sync runs
  // every 1.5s, and hitting storage 40 times a minute to learn something that
  // changes about twice a year is not a trade worth making.
  let lastKey = "";
  let userSites = {};
  try { userSites = (await chrome.storage.local.get("brandSites")).brandSites || {}; } catch (e) {}
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.brandSites) return;
    userSites = changes.brandSites.newValue || {};
    lastKey = "";      // re-evaluate this page under the new list
    sync();
  });

  function sync() {
    const product = extractProduct(document, location.hostname, userSites);
    if (!product) {
      // Nothing resolved YET. These pages hydrate after load, so do not record
      // this URL as handled - marking it done here meant a late-arriving product
      // was never picked up.
      if (lastHref !== location.href) { lastHref = location.href; lastKey = ""; }
      // But a button we ALREADY rendered must go, whatever the URL did. The
      // site being removed from the shopper's list makes extraction fail at the
      // same href, and the old button stayed clickable - still carrying the
      // captured product, still writing search preferences for a site they had
      // just revoked. Unregistering a content script does not tear down script
      // that is already running.
      if (lastKey) { document.getElementById(BTN_ID)?.remove(); lastKey = ""; }
      return;
    }
    // Re-render when the URL OR the resolved product changes: an SPA can swap
    // the product under the same href, which would otherwise keep stale data.
    const key = location.href + "|" + product.name + "|" + (product.colour || "");
    if (key === lastKey) return;
    lastHref = location.href;
    lastKey = key;
    render(product);
  }

  // These sites are SPAs: the product changes without a reload. Poll the href
  // rather than observing the DOM - a MutationObserver here would watch a page
  // we do not control, and our own button is a mutation, which is exactly the
  // feedback loop that once froze the Poshmark side.
  sync();
  addEventListener("popstate", sync);
  setInterval(sync, 1500);
})();
