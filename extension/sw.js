// Poshmark Refine has no popup - a left-click on the toolbar icon opens the
// settings (options) page. MV3 service worker; it makes no network request and
// stores nothing (the options page owns chrome.storage.local).
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// First install: open settings so the shopper can set a profile before using it.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});
