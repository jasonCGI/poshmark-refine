// MV3 service worker. The toolbar icon opens the popup (manifest default_popup),
// so there is no click handler here. No network, no storage of its own.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

// The brand-site bridge asks for a Poshmark search tab. A content script cannot
// call chrome.tabs, so it goes through here. The URL is built by core/search.js
// on the content side; this only opens what it is handed, and only for Poshmark.
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.type !== "pmr:open-search") return;
  const url = String(msg.url || "");
  if (!/^https:\/\/poshmark\.com\//.test(url)) { respond({ ok: false }); return; }
  chrome.tabs.create({ url }).then(() => respond({ ok: true }), () => respond({ ok: false }));
  return true;    // respond asynchronously
});

// ---------------------------------------------------------------------------
// Brand sites the shopper added themselves.
//
// The bridge is generic - it reads a JSON-LD Product, which most brand sites
// publish - so the limit was never the code, it was the manifest's static match
// list. Shipping a long hardcoded list would mean shipping brands nobody
// checked against a real page. Instead the shopper adds the sites they shop,
// Chrome asks THEM for that one host, and we register the script at runtime.
//
// Consequence worth keeping in mind: a host here was granted by the user in
// Chrome's own dialog. We never request one on our own initiative, and a host
// whose permission has been revoked is dropped rather than silently retried.

const DYNAMIC_PREFIX = "pmr-brand-";

// Hosts the manifest already covers with a static content script. Registering a
// dynamic script for one of these runs brand.js twice on the same page: the
// button has a fixed id so only one is visible, but the second copy keeps its
// own polling interval and listeners running forever.
const STATIC_HOSTS = new Set(["vuoriclothing.com"]);

async function syncBrandScripts() {
  let sites = {};
  try { sites = (await chrome.storage.local.get("brandSites")).brandSites || {}; } catch (e) { return; }

  const wanted = new Map();
  for (const host of Object.keys(sites)) {
    if (STATIC_HOSTS.has(host)) continue;   // already in the manifest
    const origins = ["https://" + host + "/*", "https://*." + host + "/*"];
    // Only register where the user actually granted us the host.
    let granted = false;
    try { granted = await chrome.permissions.contains({ origins }); } catch (e) {}
    if (granted) wanted.set(DYNAMIC_PREFIX + host, origins);
  }

  let existing = [];
  try { existing = await chrome.scripting.getRegisteredContentScripts(); } catch (e) {}
  const mine = existing.filter((s) => s.id.startsWith(DYNAMIC_PREFIX));

  const stale = mine.filter((s) => !wanted.has(s.id)).map((s) => s.id);
  if (stale.length) { try { await chrome.scripting.unregisterContentScripts({ ids: stale }); } catch (e) {} }

  const have = new Set(mine.map((s) => s.id));
  const add = [...wanted.entries()].filter(([id]) => !have.has(id)).map(([id, origins]) => ({
    id,
    matches: origins,
    js: ["extension/brand.js"],
    css: ["extension/brand.css"],
    runAt: "document_idle",
  }));
  if (add.length) { try { await chrome.scripting.registerContentScripts(add); } catch (e) {} }
}

chrome.runtime.onStartup.addListener(syncBrandScripts);
chrome.runtime.onInstalled.addListener(syncBrandScripts);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.brandSites) syncBrandScripts();
});
// A revoked permission must take the script down with it.
// BOTH transitions. Only onRemoved was handled, so revoking a site unregistered
// its script and re-granting never registered it again - the site sat in the
// list looking healthy and did nothing until an unrelated change happened to
// resynchronise it.
if (chrome.permissions) {
  chrome.permissions.onRemoved?.addListener(syncBrandScripts);
  chrome.permissions.onAdded?.addListener(syncBrandScripts);
}
