// Reading a product off a brand's own site, so the shopper can jump straight to
// the same item on Poshmark.
//
// This is deliberately GENERIC. Most brand sites are Shopify and publish a
// JSON-LD `Product` with the same shape, so adding a brand is one line in
// BRAND_SITES rather than a new scraper. Pure DOM in, no chrome API, no globals,
// driven by jsdom in test/dom.test.js - the same discipline as core/grid.js.
//
// The colourway comes FROM THE PAGE. A brand's own product page is the only
// authoritative source for a name like "Velvet Violet Heather"; there is no
// published list of a brand's current and former colourways, and inventing one
// would be confidently wrong.

/**
 * Hostname -> the brand it sells.
 *
 * Deliberately short. Shipping a long list would mean shipping brands nobody
 * verified against a real product page, which is the guessing this whole
 * library refuses to do. Instead the shopper adds the sites they actually
 * shop: see `sitesWith()` below, and the per-site permission the extension
 * asks for at the moment they add one.
 *
 * An entry may name its brand or not. When it does not, the brand is read from
 * the page's own JSON-LD, which is more authoritative than anything we could
 * hardcode anyway.
 */
export const BRAND_SITES = {
  "vuoriclothing.com": { brand: "Vuori" },
};

/** Strip a scheme, a path and a www. to leave a bare, comparable hostname. */
export function hostKey(input) {
  let h = String(input || "").trim().toLowerCase();
  if (!h) return "";
  if (h.includes("://")) { try { h = new URL(h).hostname; } catch (e) { return ""; } }
  else h = h.split("/")[0];
  return h.replace(/^www\./, "");
}

/** The built-in sites plus the shopper's own, theirs winning on a clash. */
export function sitesWith(extra) {
  const out = Object.assign({}, BRAND_SITES);
  for (const [host, v] of Object.entries(extra || {})) {
    const k = hostKey(host);
    if (k) out[k] = v || {};
  }
  return out;
}

/** Look up a host, tolerating a www. prefix. Unknown host -> null, never a guess. */
export function brandForHost(hostname, extra) {
  const k = hostKey(hostname);
  return (extra ? sitesWith(extra) : BRAND_SITES)[k] || null;
}

/**
 * The brand as the PAGE states it. Schema.org allows a bare string or a
 * Brand/Organization object, so both are read; anything else is not a brand
 * name we are willing to invent.
 */
export function brandFromJsonLd(product) {
  const b = product && product.brand;
  if (!b) return null;
  if (typeof b === "string") return b.trim() || null;
  if (typeof b === "object" && typeof b.name === "string") return b.name.trim() || null;
  return null;
}

const SIZE_TOKEN = /^(XXS|XS|S|M|L|XL|XXL|XXXL|[1-5]X|\d{1,2}(?:\.5)?)$/i;

/**
 * Which of our size categories this product belongs to, from its name.
 *
 * Order matters: a "Dress Shirt" is a top, so tops are only reached after the
 * more specific families have had their say. Defaults to tops rather than
 * refusing, because the category only selects WHICH size list applies - getting
 * it wrong costs a filter, not an item.
 */
export function guessCategory(name) {
  const n = " " + String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
  const has = (...words) => words.some((w) => n.includes(" " + w + " ") || n.includes(" " + w + "s "));
  if (has("shoe", "sneaker", "boot", "sandal", "slipper", "trainer")) return "shoes";
  if (has("jacket", "coat", "vest", "parka", "anorak", "windbreaker")) return "outerwear";
  if (has("dress", "gown")) return "dresses";
  if (has("pant", "jogger", "short", "legging", "trouser", "jean", "skirt", "chino")) return "bottoms";
  return "tops";
}

/** Every JSON-LD object on the page, flattened (they nest and arrive in arrays). */
function jsonLdObjects(doc) {
  const out = [];
  const walk = (o) => {
    if (!o) return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (typeof o === "object") { out.push(o); Object.values(o).forEach(walk); }
  };
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try { walk(JSON.parse(s.textContent)); } catch (e) { /* a malformed block is not fatal */ }
  }
  return out;
}

const typeOf = (o) => [].concat(o["@type"] || []).map(String);

/**
 * Trim a JSON-LD product name down to the product.
 *
 * Shopify appends the variant: "Elevation Square Neck Cami - Velvet Violet
 * Heather - XXS". Drop trailing segments that are the known colour or a size,
 * and stop at the first segment that is neither - so a product legitimately
 * containing " - " keeps it.
 */
export function stripVariantSuffix(name, colour) {
  const parts = String(name || "").split(/\s+-\s+/);
  while (parts.length > 1) {
    const last = parts[parts.length - 1].trim();
    const isColour = colour && last.toLowerCase() === String(colour).toLowerCase();
    if (isColour || SIZE_TOKEN.test(last)) parts.pop();
    else break;
  }
  return parts.join(" - ").trim();
}

/** Sizes offered, from JSON-LD offers when present, else the page's own controls. */
function readSizes(doc, product) {
  const out = [];
  const push = (v) => {
    const s = String(v || "").trim();
    if (SIZE_TOKEN.test(s) && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  };
  for (const offer of [].concat((product && product.offers) || [])) {
    if (!offer || typeof offer !== "object") continue;
    push(offer.size);
    // a variant offer often carries the size only as the tail of its name
    if (offer.name) push(String(offer.name).split(/\s+-\s+/).pop());
  }
  if (!out.length) {
    for (const el of doc.querySelectorAll("button, label, li, option")) {
      if (el.children.length === 0) push(el.textContent);
    }
  }
  return out;
}

/**
 * The product on this page, or null.
 *
 * Returns null rather than guessing: an unknown host, or a page with no product
 * name, is not a product page. `colour` may be null - a product without a stated
 * colourway is unknown, not colourless, and the caller simply does not filter on
 * one.
 */
export function extractProduct(doc, hostname, extra) {
  const site = brandForHost(hostname, extra);
  if (!site || !doc) return null;

  const product = jsonLdObjects(doc).find((o) => typeOf(o).includes("Product"));
  const colour = (product && product.color && String(product.color).trim()) || null;

  // The h1 is the clean product name; the JSON-LD name carries the variant.
  const h1 = (doc.querySelector("h1") || {}).textContent;
  let name = (h1 || "").replace(/\s+/g, " ").trim();
  if (!name && product && product.name) name = stripVariantSuffix(product.name, colour);
  if (!name) return null;

  // A site the shopper added names no brand, so the page speaks for itself.
  // A built-in entry still wins, because it is the checked spelling.
  const brand = site.brand || brandFromJsonLd(product);
  if (!brand) return null;   // without a brand there is no useful Poshmark search

  return {
    brand,
    name,
    colour,
    sizes: readSizes(doc, product),
    category: guessCategory(name),
    sku: (product && product.sku) || null,
  };
}

/** What to type into Poshmark for this product. */
export const searchQueryFor = (p) => [p.brand, p.name].filter(Boolean).join(" ").trim();
