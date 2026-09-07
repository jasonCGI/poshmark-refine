// Popup: the quick controls - who, category, that person's sizes, colours,
// brands - plus live status of the page under the popup. Reads/writes the same
// chrome.storage.local `refine` record the content script and the full settings
// page use; saving merges, so anything set on the full page survives.

const DEFAULTS = {
  profiles: { me: { tops: [] } },
  who: "me",
  category: "tops",
  brands: [],
  colours: [],
  hideMode: "fade",
  tier3: true,
  query: "",
  department: "Women",
  colourTerms: [],
  maxPrice: null,
  conditions: [],
  presets: [],
  useAi: false,
};
// Single source of truth for sizes, colours and brands lives in core/ - import
// it so the popup can never drift from what the verdict engine actually knows.
import { CATEGORY_SIZES, CATEGORIES, COLOUR_FAMILIES, BRAND_ALIASES } from "../core/normalize.js";
import { isNewer, shouldCheck, fetchLatestVersion } from "../core/update.js";
import { capturePreset, applyPreset, upsertPreset, removePreset, describePreset } from "../core/presets.js";
// The search URL is built in core/search.js, shared with the brand-site bridge,
// so the two can never disagree about what a search means.
import { poshmarkSearchUrl, DEPARTMENTS } from "../core/search.js";
const COLOUR_SWATCH = {
  black: "#1e1e1e", white: "#f2ede4", grey: "#9aa0a6", beige: "#d8c3a0",
  brown: "#6f4a2f", red: "#b23b3b", orange: "#e0863a", yellow: "#e6c43f",
  green: "#6f9e59", blue: "#4f79b0", purple: "#8a63b0", pink: "#e39ac2",
  multi: "conic-gradient(from 0deg,#e35d5d,#e6c43f,#6f9e59,#4f79b0,#8a63b0,#e35d5d)",
};
const KNOWN_BRANDS = Object.keys(BRAND_ALIASES);
const POSH_PAGE = /^https:\/\/poshmark\.com\/(search|category|brand)/;

const $ = (id) => document.getElementById(id);
const splitList = (t) => String(t || "").split(",").map((s) => s.trim()).filter(Boolean);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
let state = structuredClone(DEFAULTS);

// Track what THIS surface actually edited. Saving then applies only those
// changes onto a fresh read, so a field another surface changed meanwhile is
// not clobbered by our stale copy of it.
const touchedSizes = new Set();          // "person::category"
const touchedFields = new Set();         // scalar field names
const mark = (f) => touchedFields.add(f);
const isClean = () => !touchedSizes.size && !touchedFields.size;

const isAnyone = () => state.who === "anyone";

/** Whose size rows to show: everyone when shopping for "anyone", else one person.
 *  "Anyone" still shows every person's row EDITABLE - it must not lock them. */
function peopleInScope() {
  const names = Object.keys(state.profiles);
  if (!names.length) { state.profiles.me = {}; return ["me"]; }
  return isAnyone() ? names : [state.who].filter((n) => names.includes(n));
}

function sizesOf(person) {
  const p = state.profiles[person] || (state.profiles[person] = {});
  return p[state.category] || (p[state.category] = []);
}

function setSizesOf(person, list) {
  const p = state.profiles[person] || (state.profiles[person] = {});
  const cat = state.category;
  const before = (p[cat] || []).join(" ");
  p[cat] = list;
  if (before !== list.join(" ")) touchedSizes.add(person + "::" + cat);
}

/** Pull any typed-but-not-committed size text out of the DOM into state. */
function collectSizeText() {
  for (const box of document.querySelectorAll(".pblock")) {
    const who = box.dataset.person;
    const inp = box.querySelector("input");
    if (who && inp) setSizesOf(who, splitList(inp.value));
  }
}

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
}

function renderCategory() {
  const sel = $("category");
  const known = [...new Set([...CATEGORIES, ...Object.values(state.profiles).flatMap((p) => Object.keys(p))])];
  sel.innerHTML = "";
  for (const c of known) {
    const o = document.createElement("option");
    o.value = c; o.textContent = cap(c);
    if (c === state.category) o.selected = true;
    sel.appendChild(o);
  }
}

function renderSizes() {
  const host = $("sizes");
  host.innerHTML = "";
  const quick = CATEGORY_SIZES[state.category] || CATEGORY_SIZES.tops;
  const people = peopleInScope();

  for (const person of people) {
    const sizes = sizesOf(person);
    const box = document.createElement("div");
    box.className = "pblock";
    box.dataset.person = person;
    if (people.length > 1) {
      const lab = document.createElement("div");
      lab.className = "plabel";
      lab.textContent = person;
      box.appendChild(lab);
    }
    const chips = document.createElement("div");
    chips.className = "chips";
    for (const s of quick) {
      const on = sizes.some((x) => x.toLowerCase() === s.toLowerCase());
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.textContent = s;
      b.setAttribute("aria-pressed", String(on));
      b.addEventListener("click", () => {
        collectSizeText();
        const cur = sizesOf(person).slice();
        const i = cur.findIndex((x) => x.toLowerCase() === s.toLowerCase());
        if (i >= 0) cur.splice(i, 1); else cur.push(s);
        setSizesOf(person, cur);
        renderSizes();
      });
      chips.appendChild(b);
    }
    box.appendChild(chips);
    const text = document.createElement("input");
    text.type = "text";
    text.value = sizes.join(", ");
    text.placeholder = state.category === "shoes" ? "or type: 8.5" : "or type: US 8, 1X";
    text.setAttribute("aria-label", person + " " + state.category + " sizes");
    text.addEventListener("change", () => { setSizesOf(person, splitList(text.value)); renderSizes(); });
    box.appendChild(text);
    host.appendChild(box);
  }

  const union = [...new Set(people.flatMap((p) => sizesOf(p)))];
  $("sizeFor").textContent = people.length > 1 ? "(" + people.length + " people)" : "for " + people[0];
  $("whoLabel").textContent = union.length ? state.category + " " + union.join("/") : "no sizes set";
}

function renderPresets() {
  const host = $("presets");
  host.innerHTML = "";
  const list = state.presets || [];
  for (const p of list) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip";
    b.title = describePreset(p);
    // preset names are the shopper's own text, but build by node anyway
    b.appendChild(document.createTextNode(p.name));
    const del = document.createElement("span");
    del.className = "del"; del.textContent = "×"; del.title = "Delete this search";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      state.presets = removePreset(state.presets || [], p.name);
      mark("presets"); renderPresets();
    });
    b.appendChild(del);
    b.addEventListener("click", () => usePreset(p));
    host.appendChild(b);
  }
  $("prCount").textContent = list.length ? "" : "(none yet)";
}

/** Apply a preset to the live criteria, save, and run its search. */
async function usePreset(p) {
  state = applyPreset(state, p);
  for (const f of ["query", "department", "category", "who", "brands", "colours", "colourTerms", "maxPrice", "conditions"]) mark(f);
  renderAll();
  await runSearch();
}

function savePreset() {
  const name = $("prName").value.trim();
  if (!name) { $("prName").focus(); return; }
  collectSizeText();
  const current = Object.assign({}, state, {
    query: $("q").value.trim(),
    brands: splitList($("brands").value),
    maxPrice: Number($("maxPrice").value) || null,
    conditions: $("nwt").getAttribute("aria-pressed") === "true" ? ["nwt"] : [],
  });
  state.presets = upsertPreset(state.presets || [], capturePreset(name, current));
  $("prName").value = "";
  mark("presets"); renderPresets();
  save();
}

function renderColourways() {
  const host = $("cwChips");
  host.innerHTML = "";
  for (const term of state.colourTerms) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.setAttribute("aria-pressed", "true");
    // `term` can originate from a brand page's JSON-LD, so it is untrusted
    // input. Never let it reach innerHTML - build the node and set text.
    b.appendChild(document.createTextNode(term));
    const x = document.createElement("span");
    x.className = "tick";
    x.textContent = "×";
    b.appendChild(x);
    b.title = "Remove";
    b.addEventListener("click", () => {
      state.colourTerms = state.colourTerms.filter((t) => t !== term);
      mark("colourTerms"); renderColourways();
    });
    host.appendChild(b);
  }
  $("cwCount").textContent = state.colourTerms.length ? "" : "(none)";
}

function addColourway() {
  const v = $("cwInput").value.trim();
  if (!v) return;
  for (const term of splitList(v)) {
    if (!state.colourTerms.some((t) => t.toLowerCase() === term.toLowerCase())) state.colourTerms.push(term);
  }
  $("cwInput").value = "";
  mark("colourTerms"); renderColourways();
}

async function renderLearnedList() {
  const dl = $("known-colourways");
  dl.innerHTML = "";
  let learned = [];
  try { learned = (await chrome.storage.local.get("learnedColourways")).learnedColourways || []; } catch (e) {}
  for (const t of learned) { const o = document.createElement("option"); o.value = t; dl.appendChild(o); }
  $("cwCount").textContent = state.colourTerms.length ? "" : (learned.length ? "(" + learned.length + " learned)" : "(none yet)");
}

function renderColours() {
  const host = $("colours");
  host.innerHTML = "";
  for (const [fam, sw] of Object.entries(COLOUR_SWATCH)) {
    const on = state.colours.includes(fam);
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.setAttribute("aria-pressed", String(on));
    b.innerHTML = '<span class="sw" style="background:' + sw + '"></span>' + cap(fam);
    b.addEventListener("click", () => {
      const i = state.colours.indexOf(fam);
      if (i >= 0) state.colours.splice(i, 1); else state.colours.push(fam);
      mark("colours");
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

function renderDepartment() {
  const sel = $("department");
  sel.innerHTML = "";
  for (const d of DEPARTMENTS) {
    const o = document.createElement("option");
    o.value = d;
    o.textContent = d === "All" ? "All departments" : d + "'s";
    if (d === state.department) o.selected = true;
    sel.appendChild(o);
  }
}

function renderAll() {
  renderDepartment();
  renderWho();
  renderCategory();
  renderSizes();
  renderColours();
  $("q").value = state.query || "";
  $("brands").value = state.brands.join(", ");
  $("maxPrice").value = state.maxPrice ? String(state.maxPrice) : "";
  $("useai").checked = !!state.useAi;
  $("nwt").setAttribute("aria-pressed", String((state.conditions || []).includes("nwt")));
  renderColourways();
  renderPresets();
}

/** Save first (so the page refines the moment it loads), then go. Reuse the
 *  current tab when it is already Poshmark, otherwise open a new one. */
async function runSearch() {
  mark("query"); mark("department");      // the search we are about to run IS the edit
  await save({ silent: true });
  const url = poshmarkSearchUrl({
    query: $("q").value.trim(),
    department: state.department,
    category: state.category,
  });
  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch (e) {}
  if (tab && /^https:\/\/poshmark\.com\//.test(tab.url || "")) {
    await chrome.tabs.update(tab.id, { url });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
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
    setStatus("Not on a Poshmark search. Hit <b>Search</b> above and I will open one.", false);
    return;
  }
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: "pmr:status" });
    showProblems(r && r.problems);
    if (r && r.tiles === 0) {
      // We are on a results page but matched nothing at all: Poshmark changed
      // its markup. Say so - silence would look like the extension working.
      setStatus("Poshmark changed its layout, so Refine is paused here. The filters are safe; the page reader needs updating.", false);
    } else if (r && r.active) {
      setStatus("Filtering this page: <b>" + r.show + "</b> matched &middot; <b>" + r.dim + "</b> to check &middot; <b>" + r.hide + "</b> hidden", true);
    } else {
      setStatus("On this page, but nothing to filter by yet. Set a size, brand or colour and Save.", false);
    }
  } catch (e) {
    showProblems(null);
    setStatus("Refresh this page once to start filtering.", false, true, tab.id);
  }
}

// The self-check speaks only when something is wrong. A health panel that says
// "all good" on every open is one you stop reading, and then it is worth
// nothing on the day it has something to say.
function showProblems(problems) {
  const box = $("selfcheck");
  if (!problems || !problems.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.innerHTML = "<b>Not working right on this page</b><ul>" +
    problems.map((p) => "<li>" + escapeHtml(p.detail) + "</li>").join("") +
    "</ul>";
  box.hidden = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- events ------------------------------------------------------------------
$("who").addEventListener("change", () => { state.who = $("who").value; mark("who"); renderSizes(); });
$("category").addEventListener("change", () => { state.category = $("category").value; mark("category"); renderSizes(); });
$("brands").addEventListener("input", () => mark("brands"));
$("cwAdd").addEventListener("click", addColourway);
$("prSave").addEventListener("click", savePreset);
$("prName").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); savePreset(); } });
$("cwInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addColourway(); } });
$("maxPrice").addEventListener("input", () => mark("maxPrice"));
$("useai").addEventListener("change", () => mark("useAi"));
$("nwt").addEventListener("click", () => {
  const on = $("nwt").getAttribute("aria-pressed") === "true";
  $("nwt").setAttribute("aria-pressed", String(!on));
  mark("conditions");
});
$("q").addEventListener("input", () => mark("query"));

// Another surface (the full settings page) changed the record: adopt it, unless
// this popup has unsaved edits of its own - those would be silently discarded.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.refine || !isClean()) return;
  state = Object.assign(structuredClone(DEFAULTS), changes.refine.newValue || {});
  if (!Array.isArray(state.colours)) state.colours = [];
  renderAll();
});
/** Apply only the size rows this popup edited onto the stored profiles. */
function mergeProfiles(storedProfiles) {
  const out = JSON.parse(JSON.stringify(storedProfiles && Object.keys(storedProfiles).length
    ? storedProfiles : state.profiles));
  for (const key of touchedSizes) {
    const i = key.lastIndexOf("::");
    const person = key.slice(0, i), cat = key.slice(i + 2);
    out[person] = out[person] || {};
    out[person][cat] = ((state.profiles[person] || {})[cat] || []).slice();
  }
  return out;
}

async function save({ silent = false } = {}) {
  collectSizeText();                                    // catch un-blurred edits
  const stored = (await chrome.storage.local.get("refine")).refine || {};
  const mine = {
    presets: state.presets || [],
    colourTerms: state.colourTerms,
    maxPrice: Number($("maxPrice").value) || null,
    conditions: $("nwt").getAttribute("aria-pressed") === "true" ? ["nwt"] : [],
    useAi: $("useai").checked,
    who: state.who,
    category: state.category,
    colours: state.colours.map((c) => c.toLowerCase()),
    brands: splitList($("brands").value),
    query: $("q").value.trim(),
    department: state.department,
  };
  const next = Object.assign({}, DEFAULTS, stored);
  for (const f of touchedFields) if (f in mine) next[f] = mine[f];
  next.profiles = mergeProfiles(stored.profiles);
  await chrome.storage.local.set({ refine: next });
  state = next;
  if (silent) return;
  const s = $("status"); s.hidden = false;
  setTimeout(() => { s.hidden = true; }, 1400);
  setTimeout(refreshStatus, 350);
}

$("save").addEventListener("click", () => save());
$("go").addEventListener("click", runSearch);
$("q").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
$("department").addEventListener("change", () => { state.department = $("department").value; mark("department"); });

$("more").addEventListener("click", () => { chrome.runtime.openOptionsPage(); window.close(); });

// ---- update check ----------------------------------------------------------
// Chrome cannot auto-update an unpacked extension, so this only NOTICES a newer
// version and tells the shopper the two steps. It is the one request that is not
// to Poshmark, so it is opt-in and default OFF, and it sends no user data.
async function runUpdateCheck() {
  const cur = chrome.runtime.getManifest().version;
  let st = {};
  try { st = (await chrome.storage.local.get("updateCheck")).updateCheck || {}; } catch (e) {}
  $("updates").checked = !!st.enabled;

  const show = (latest) => {
    if (!latest || !isNewer(latest, cur)) return;
    $("uptext").textContent = "v" + latest + " available (you have " + cur + ")";
    $("upbar").hidden = st.dismissed === latest;
  };
  show(st.latest);
  if (!shouldCheck(st)) return;
  const latest = await fetchLatestVersion();
  if (!latest) return;
  st = Object.assign({}, st, { latest, lastCheck: Date.now() });
  try { await chrome.storage.local.set({ updateCheck: st }); } catch (e) {}
  show(latest);
}

$("updates").addEventListener("change", async () => {
  const enabled = $("updates").checked;
  const st = (await chrome.storage.local.get("updateCheck")).updateCheck || {};
  await chrome.storage.local.set({ updateCheck: Object.assign({}, st, { enabled, lastCheck: 0 }) });
  if (enabled) runUpdateCheck(); else $("upbar").hidden = true;
});

// The only button here that changes anything. Chrome cannot fetch the update,
// but for an unpacked extension it CAN re-read the folder, which is the second
// of the two steps and the one that otherwise means a trip to
// chrome://extensions. The popup dies with the reload, which is expected.
$("upreload").addEventListener("click", () => {
  $("upsteps").textContent = "Reloading. If the notice returns, pull the repo first.";
  chrome.runtime.reload();
});

$("updismiss").addEventListener("click", async () => {
  $("upbar").hidden = true;
  const st = (await chrome.storage.local.get("updateCheck")).updateCheck || {};
  await chrome.storage.local.set({ updateCheck: Object.assign({}, st, { dismissed: st.latest }) });
});

(async () => {
  renderBrandsList();
  renderLearnedList();
  const stored = await chrome.storage.local.get("refine");
  state = Object.assign(structuredClone(DEFAULTS), stored.refine || {});
  if (!Array.isArray(state.colours)) state.colours = [];
  if (!Array.isArray(state.colourTerms)) state.colourTerms = [];
  if (!Array.isArray(state.presets)) state.presets = [];
  if (!Array.isArray(state.conditions)) state.conditions = [];
  if (!state.profiles || typeof state.profiles !== "object") state.profiles = structuredClone(DEFAULTS.profiles);
  renderAll();
  renderLearnedList();
  refreshStatus();
  runUpdateCheck();
})();
