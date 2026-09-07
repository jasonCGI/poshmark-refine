// Popup: the quick controls (who, colours, brands) plus live status of the page
// under the popup. Reads/writes the same chrome.storage.local `refine` record the
// content script and the full settings page use - saving here merges into it, so
// family profiles and behaviour set on the full page are never clobbered.

const DEFAULTS = {
  profiles: { me: { tops: [] } },
  who: "me",
  category: "tops",
  brands: [],
  colours: [],
  hideMode: "fade",
  tier3: true,
};
const COLOUR_SWATCH = {
  black: "#1e1e1e", white: "#f2ede4", grey: "#9aa0a6", beige: "#d8c3a0",
  brown: "#6f4a2f", red: "#b23b3b", orange: "#e0863a", yellow: "#e6c43f",
  green: "#6f9e59", blue: "#4f79b0", purple: "#8a63b0", pink: "#e39ac2",
  multi: "conic-gradient(from 0deg,#e35d5d,#e6c43f,#6f9e59,#4f79b0,#8a63b0,#e35d5d)",
};
const KNOWN_BRANDS = [
  "Vuori", "Rails", "Madewell", "Free People", "Anthropologie", "Aritzia",
  "Lululemon", "Faherty", "Zara", "J.Crew", "Levi's", "Abercrombie & Fitch",
  "ASTR the Label", "L'AGENCE", "Prana", "Joie", "Doen", "Vince Camuto",
];
const POSH_PAGE = /^https:\/\/poshmark\.com\/(search|category|brand)/;

const $ = (id) => document.getElementById(id);
const splitList = (t) => String(t || "").split(",").map((s) => s.trim()).filter(Boolean);
let state = structuredClone(DEFAULTS);

function renderWho() {
  const sel = $("who");
  sel.innerHTML = "";
  for (const name of [...Object.keys(state.profiles), "anyone"]) {
    const o = document.createElement("option");
    o.value = name;
    o.textContent = name === "anyone" ? "Anyone in the family" : name;
    if (name === state.who) o.selected = true;
    sel.appendChild(o);
  }
  const sizes = state.who === "anyone"
    ? [...new Set(Object.values(state.profiles).flatMap((p) => p[state.category] || []))]
    : ((state.profiles[state.who] || {})[state.category] || []);
  $("whoLabel").textContent = sizes.length ? state.category + " " + sizes.join("/") : "no sizes set";
}

function renderColours() {
  const host = $("colours");
  host.innerHTML = "";
  for (const [fam, sw] of Object.entries(COLOUR_SWATCH)) {
    const on = state.colours.includes(fam);
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.setAttribute("aria-pressed", String(on));
    b.innerHTML = '<span class="sw" style="background:' + sw + '"></span>' + fam.charAt(0).toUpperCase() + fam.slice(1);
    b.addEventListener("click", () => {
      const i = state.colours.indexOf(fam);
      if (i >= 0) state.colours.splice(i, 1); else state.colours.push(fam);
      renderColours();
    });
    host.appendChild(b);
  }
}

function renderBrandsList() {
  const dl = $("known-brands");
  dl.innerHTML = "";
  for (const b of KNOWN_BRANDS) { const o = document.createElement("option"); o.value = b; dl.appendChild(o); }
}

function renderAll() {
  renderWho();
  renderColours();
  $("brands").value = state.brands.join(", ");
}

// ---- live status of the page under the popup -------------------------------
function setStatus(html, on, withRefresh, tabId) {
  const box = $("pagestatus");
  box.classList.toggle("on", !!on);
  $("pstext").innerHTML = html;
  const old = box.querySelector(".mini"); if (old) old.remove();
  if (withRefresh) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "mini"; b.textContent = "Refresh";
    b.addEventListener("click", () => { chrome.tabs.reload(tabId); window.close(); });
    box.appendChild(b);
  }
}

async function refreshStatus() {
  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch (e) {}
  if (!tab || !POSH_PAGE.test(tab.url || "")) {
    setStatus("Open a Poshmark search to apply your filters.", false);
    return;
  }
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: "pmr:status" });
    if (r && r.active) {
      setStatus("Filtering this page: <b>" + r.show + "</b> matched &middot; <b>" + r.dim + "</b> to check &middot; <b>" + r.hide + "</b> hidden", true);
    } else {
      setStatus("On this page, but nothing to filter by yet. Set a size, brand or colour and Save.", false);
    }
  } catch (e) {
    // No content script in this tab - it was open before the extension loaded.
    setStatus("Refresh this page once to start filtering.", false, true, tab.id);
  }
}

// ---- events ------------------------------------------------------------------
$("who").addEventListener("change", () => { state.who = $("who").value; renderWho(); });

$("save").addEventListener("click", async () => {
  // merge into the stored record so profiles/behaviour from the full page survive
  const stored = (await chrome.storage.local.get("refine")).refine || {};
  const next = Object.assign({}, DEFAULTS, stored, {
    who: state.who,
    colours: state.colours.map((c) => c.toLowerCase()),
    brands: splitList($("brands").value),
  });
  await chrome.storage.local.set({ refine: next });
  state = next;
  const s = $("status"); s.hidden = false;
  setTimeout(() => { s.hidden = true; }, 1400);
  setTimeout(refreshStatus, 350);   // the page re-applies on the storage change
});

$("more").addEventListener("click", () => { chrome.runtime.openOptionsPage(); window.close(); });

(async () => {
  renderBrandsList();
  const stored = await chrome.storage.local.get("refine");
  state = Object.assign(structuredClone(DEFAULTS), stored.refine || {});
  if (!Array.isArray(state.colours)) state.colours = [];
  renderAll();
  refreshStatus();
})();
