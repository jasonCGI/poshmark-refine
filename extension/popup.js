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
};
// Single source of truth for sizes, colours and brands lives in core/ - import
// it so the popup can never drift from what the verdict engine actually knows.
import { CATEGORY_SIZES, CATEGORIES, COLOUR_FAMILIES, BRAND_ALIASES } from "../core/normalize.js";

const DEPARTMENTS = ["Women", "Men", "Kids", "All"];
// Only categories whose Poshmark name we are sure of are sent as a facet; for
// the rest we let the query do the work rather than risk an empty result page.
const POSH_CATEGORY = { tops: "Tops", dresses: "Dresses" };
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
  p[state.category] = list;
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
}

/** Build the Poshmark search URL from the current criteria. */
function searchUrl() {
  const p = new URLSearchParams();
  p.set("query", $("q").value.trim());
  if (state.department && state.department !== "All") p.set("department", state.department);
  const cat = POSH_CATEGORY[state.category];
  if (cat) p.set("category", cat);
  return "https://poshmark.com/search?" + p.toString();
}

/** Save first (so the page refines the moment it loads), then go. Reuse the
 *  current tab when it is already Poshmark, otherwise open a new one. */
async function runSearch() {
  await save({ silent: true });
  const url = searchUrl();
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
    if (r && r.active) {
      setStatus("Filtering this page: <b>" + r.show + "</b> matched &middot; <b>" + r.dim + "</b> to check &middot; <b>" + r.hide + "</b> hidden", true);
    } else {
      setStatus("On this page, but nothing to filter by yet. Set a size, brand or colour and Save.", false);
    }
  } catch (e) {
    setStatus("Refresh this page once to start filtering.", false, true, tab.id);
  }
}

// ---- events ------------------------------------------------------------------
$("who").addEventListener("change", () => { state.who = $("who").value; renderSizes(); });
$("category").addEventListener("change", () => { state.category = $("category").value; renderSizes(); });
async function save({ silent = false } = {}) {
  collectSizeText();                                    // catch un-blurred edits
  const stored = (await chrome.storage.local.get("refine")).refine || {};
  const next = Object.assign({}, DEFAULTS, stored, {
    profiles: state.profiles,
    who: state.who,
    category: state.category,
    colours: state.colours.map((c) => c.toLowerCase()),
    brands: splitList($("brands").value),
    query: $("q").value.trim(),
    department: state.department,
  });
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
$("department").addEventListener("change", () => { state.department = $("department").value; });

$("more").addEventListener("click", () => { chrome.runtime.openOptionsPage(); window.close(); });

(async () => {
  renderBrandsList();
  const stored = await chrome.storage.local.get("refine");
  state = Object.assign(structuredClone(DEFAULTS), stored.refine || {});
  if (!Array.isArray(state.colours)) state.colours = [];
  if (!state.profiles || typeof state.profiles !== "object") state.profiles = structuredClone(DEFAULTS.profiles);
  renderAll();
  refreshStatus();
})();
