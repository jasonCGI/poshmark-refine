// MV3 service worker. The toolbar icon opens the popup (manifest default_popup),
// so there is no click handler here. On first install, open the full settings
// page so the shopper can set a profile before first use. No network, no storage.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});
