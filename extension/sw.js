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
