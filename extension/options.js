// Options page: family profiles and per-search constraints.
// chrome.storage.local only. No network. Stores { profiles, who, category,
// brands, colours, hideMode, tier3, query, department } - the shape content.js
// reads. A person holds sizes for SEVERAL categories at once, because a top, a
// pair of jeans and a shoe are measured in different systems.
import { CATEGORY_SIZES, CATEGORIES, COLOUR_FAMILIES, BRAND_ALIASES } from "../core/normalize.js";
import { hostKey, BRAND_SITES } from "../core/brand.js";
import { recordFit, learnedSize, forgetFit, explainFit, MIN_EVIDENCE } from "../core/fit.js";

const DEFAULTS = {
  profiles: { me: {} },
  who: "me",
  category: "tops",
  brands: [],
  colours: [],
  hideMode: "fade",
  tier3: true,
  query: "",
  department: "Women",
};

// Presentation only: a representative swatch per family the engine knows.
const SWATCH = {
  black: "#1e1e1e", white: "#f2ede4", grey: "#9aa0a6", beige: "#d8c3a0",
  brown: "#6f4a2f", red: "#b23b3b", orange: "#e0863a", yellow: "#e6c43f",
  green: "#6f9e59", blue: "#4f79b0", purple: "#8a63b0", pink: "#e39ac2",
  multi: "conic-gradient(from 0deg,#e35d5d,#e6c43f,#6f9e59,#4f79b0,#8a63b0,#e35d5d)",
};
const KNOWN_BRANDS = Object.keys(BRAND_ALIASES);

const $ = (id) => document.getElementById(id);
const splitList = (t) => String(t || "").split(",").map((s) => s.trim()).filter(Boolean);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let state = structuredClone(DEFAULTS);

// Track what THIS surface actually edited, so saving applies only those changes
// onto a fresh read instead of overwriting fields the popup may have changed
// meanwhile. A structural profile edit (add / remove / rename) cannot be merged
// key-by-key coherently, so it takes our whole profiles object.
const touchedSizes = new Set();          // "person::category"
const touchedFields = new Set();         // scalar field names
let structural = false;
const mark = (f) => touchedFields.add(f);
const isClean = () => !touchedSizes.size && !touchedFields.size && !structural;

function sizesOf(person, cat) {
  const p = state.profiles[person] || (state.profiles[person] = {});
  return p[cat] || (p[cat] = []);
}
function setSizesOf(person, cat, list) {
  const p = state.profiles[person] || (state.profiles[person] = {});
  const before = (p[cat] || []).join(" ");
  p[cat] = list;
  if (before !== list.join(" ")) touchedSizes.add(person + "::" + cat);
}

/** Pull typed-but-not-committed size text out of the DOM. */
function collectSizeText() {
  for (const row of document.querySelectorAll(".catrow")) {
    const person = row.closest(".person").dataset.person;
    const cat = row.dataset.cat;
    const inp = row.querySelector("input");
    if (person && cat && inp) setSizesOf(person, cat, splitList(inp.value));
  }
}

function renderPeople() {
  const host = $("people");
  host.innerHTML = "";
  for (const name of Object.keys(state.profiles)) {
    const box = document.createElement("div");
    box.className = "person";
    box.dataset.person = name;

    const head = document.createElement("header");
    const nameInput = document.createElement("input");
    nameInput.type = "text"; nameInput.className = "pname"; nameInput.value = name;
    nameInput.setAttribute("aria-label", "Name");
    nameInput.addEventListener("change", () => {
      const next = nameInput.value.trim();
      if (!next || next === name || state.profiles[next]) { nameInput.value = name; return; }
      collectSizeText();
      const rebuilt = {};
      for (const [k, v] of Object.entries(state.profiles)) rebuilt[k === name ? next : k] = v;
      state.profiles = rebuilt;
      structural = true;
      if (state.who === name) state.who = next;
      renderAll();
    });
    const rm = document.createElement("button");
    rm.type = "button"; rm.className = "btn ghost small remove"; rm.textContent = "Remove";
    rm.addEventListener("click", () => {
      collectSizeText();
      delete state.profiles[name];
      structural = true;
      if (state.who === name) state.who = Object.keys(state.profiles)[0] || "anyone";
      renderAll();
    });
    head.appendChild(nameInput); head.appendChild(rm);
    box.appendChild(head);

    for (const cat of CATEGORIES) {
      const sizes = sizesOf(name, cat);
      const row = document.createElement("div");
      row.className = "catrow";
      row.dataset.cat = cat;

      const lab = document.createElement("div");
      lab.className = "catlabel";
      lab.textContent = cap(cat);
      row.appendChild(lab);

      const right = document.createElement("div");
      const chips = document.createElement("div");
      chips.className = "chips";
      for (const s of (CATEGORY_SIZES[cat] || [])) {
        const on = sizes.some((x) => x.toLowerCase() === s.toLowerCase());
        const b = document.createElement("button");
        b.type = "button"; b.className = "chip"; b.textContent = s;
        b.setAttribute("aria-pressed", String(on));
        b.addEventListener("click", () => {
          collectSizeText();
          const cur = sizesOf(name, cat).slice();
          const i = cur.findIndex((x) => x.toLowerCase() === s.toLowerCase());
          if (i >= 0) cur.splice(i, 1); else cur.push(s);
          setSizesOf(name, cat, cur);
          renderPeople();
        });
        chips.appendChild(b);
      }
      right.appendChild(chips);

      const text = document.createElement("input");
      text.type = "text"; text.value = sizes.join(", ");
      text.placeholder = cat === "shoes" ? "or type: 8.5" : "or type: US 8, 1X";
      text.setAttribute("aria-label", name + " " + cat + " sizes");
      text.addEventListener("change", () => { setSizesOf(name, cat, splitList(text.value)); renderPeople(); });
      right.appendChild(text);

      row.appendChild(right);
      box.appendChild(row);
    }
    host.appendChild(box);
  }
}

function renderWho() {
  const sel = $("who");
  sel.innerHTML = "";
  for (const n of [...Object.keys(state.profiles), "anyone"]) {
    const o = document.createElement("option");
    o.value = n;
    o.textContent = n === "anyone" ? "Anyone in the family" : n;
    if (n === state.who) o.selected = true;
    sel.appendChild(o);
  }
}

function renderCategory() {
  const sel = $("category");
  sel.innerHTML = "";
  for (const c of CATEGORIES) {
    const o = document.createElement("option");
    o.value = c; o.textContent = cap(c);
    if (c === state.category) o.selected = true;
    sel.appendChild(o);
  }
}

function renderColours() {
  const host = $("colours");
  host.innerHTML = "";
  for (const fam of Object.keys(COLOUR_FAMILIES)) {
    const on = state.colours.includes(fam);
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.setAttribute("aria-pressed", String(on));
    b.innerHTML = '<span class="sw" style="background:' + (SWATCH[fam] || "#999") + '"></span>' + cap(fam) +
      (on ? ' <span class="tick">&#10003;</span>' : "");
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

function renderHideMode() {
  for (const b of $("hideMode").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.val === state.hideMode));
  }
}

function renderAll() {
  renderWho();
  renderCategory();
  renderPeople();
  renderColours();
  renderHideMode();
  $("brands").value = state.brands.join(", ");
  $("tier3").checked = !!state.tier3;
}

/** Apply only the rows this page edited onto the stored profiles. A structural
 *  change (person added / removed / renamed) takes our whole object, since a
 *  key-by-key merge of a rename is not coherent. */
function mergeProfiles(storedProfiles) {
  if (structural || !storedProfiles || !Object.keys(storedProfiles).length) return state.profiles;
  const out = JSON.parse(JSON.stringify(storedProfiles));
  for (const key of touchedSizes) {
    const i = key.lastIndexOf("::");
    const person = key.slice(0, i), cat = key.slice(i + 2);
    out[person] = out[person] || {};
    out[person][cat] = ((state.profiles[person] || {})[cat] || []).slice();
  }
  return out;
}

// Another surface (the popup) changed the record: adopt it, unless this page has
// unsaved edits, which adopting would silently discard.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.refine || !isClean()) return;
  state = Object.assign(structuredClone(DEFAULTS), changes.refine.newValue || {});
  if (!Array.isArray(state.colours)) state.colours = [];
  if (!state.profiles || !Object.keys(state.profiles).length) state.profiles = structuredClone(DEFAULTS.profiles);
  renderAll();
});

// events
$("addPerson").addEventListener("click", () => {
  collectSizeText();
  let n = "person"; let i = 2;
  while (state.profiles[n]) n = "person " + i++;
  state.profiles[n] = {};
  structural = true;
  renderAll();
});
$("who").addEventListener("change", () => { state.who = $("who").value; mark("who"); });
$("brands").addEventListener("input", () => mark("brands"));
$("tier3").addEventListener("change", () => mark("tier3"));
$("category").addEventListener("change", () => { state.category = $("category").value; mark("category"); });
$("hideMode").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-val]");
  if (!b) return;
  state.hideMode = b.dataset.val; mark("hideMode"); renderHideMode();
});

$("save").addEventListener("click", async () => {
  collectSizeText();
  const stored = (await chrome.storage.local.get("refine")).refine || {};
  const mine = {
    who: state.who,
    category: state.category,
    brands: splitList($("brands").value),
    colours: state.colours.map((c) => c.toLowerCase()),
    hideMode: state.hideMode,
    tier3: $("tier3").checked,
  };
  const next = Object.assign({}, DEFAULTS, stored);
  for (const f of touchedFields) if (f in mine) next[f] = mine[f];
  next.profiles = mergeProfiles(stored.profiles);
  await chrome.storage.local.set({ refine: next });
  state = next;
  const s = $("status"); s.hidden = false;
  setTimeout(() => { s.hidden = true; }, 1600);
});

(async () => {
  renderBrandsList();
  const stored = await chrome.storage.local.get("refine");
  state = Object.assign(structuredClone(DEFAULTS), stored.refine || {});
  if (!Array.isArray(state.colours)) state.colours = [];
  if (!state.profiles || typeof state.profiles !== "object" || !Object.keys(state.profiles).length) {
    state.profiles = structuredClone(DEFAULTS.profiles);
  }
  renderAll();
})();

// ---- brand sites the shopper adds -------------------------------------------
// Stored apart from `refine` because this is not a search preference: it is a
// list of hosts Chrome has granted us. Keeping it separate means the merge
// logic that protects concurrent edits to `refine` never has to reason about
// permissions, and revoking a site cannot disturb a size profile.
const originsFor = (host) => ["https://" + host + "/*", "https://*." + host + "/*"];

async function getSites() {
  try { return (await chrome.storage.local.get("brandSites")).brandSites || {}; } catch (e) { return {}; }
}

function bsMsg(text, bad) {
  const el = $("bsMsg");
  el.textContent = text || "";
  el.style.color = bad ? "#c0392b" : "";
}

async function renderSites() {
  const sites = await getSites();
  const list = $("bsList");
  list.innerHTML = "";
  const hosts = Object.keys(sites).sort();
  if (!hosts.length) {
    list.innerHTML = '<span class="hint">No extra sites yet. Vuori is built in.</span>';
    return;
  }
  for (const host of hosts) {
    const granted = await chrome.permissions.contains({ origins: originsFor(host) }).catch(() => false);
    const chip = document.createElement("span");
    chip.className = "site";
    // Permission can be revoked in Chrome's own settings without telling us, so
    // report what is actually true rather than what we stored.
    chip.innerHTML = "<b>" + esc(sites[host].brand || host) + "</b>" +
      '<span class="host">' + esc(host) + (granted ? "" : " &middot; not allowed") + "</span>";
    const x = document.createElement("button");
    x.type = "button";
    x.title = "Remove " + host;
    x.textContent = "×";
    x.addEventListener("click", () => removeSite(host));
    chip.appendChild(x);
    list.appendChild(chip);
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function addSite() {
  const host = hostKey($("bsUrl").value);
  if (!host || !host.includes(".")) { bsMsg("That does not look like a website address.", true); return; }
  if (host === "poshmark.com") { bsMsg("Poshmark is the other side of the bridge, not a brand site.", true); return; }
  // A built-in site already has a content script in the manifest. Adding it
  // would register a SECOND one for the same pages and inject the button twice.
  if (BRAND_SITES[host]) { bsMsg((BRAND_SITES[host].brand || host) + " is already built in.", true); return; }

  // The permission request must be the FIRST thing the click does, or Chrome
  // rejects it as not being in response to a user gesture.
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: originsFor(host) }); } catch (e) {}
  if (!granted) { bsMsg("Chrome did not allow " + host + ", so nothing was added.", true); return; }

  const sites = await getSites();
  // No brand name here on purpose: the product page states its own, and the
  // page is a better authority than anything typed into this box.
  sites[host] = {};
  await chrome.storage.local.set({ brandSites: sites });
  $("bsUrl").value = "";
  bsMsg("Added " + host + ". Open one of its product pages to see the button.");
  renderSites();
}

async function removeSite(host) {
  const sites = await getSites();
  delete sites[host];
  await chrome.storage.local.set({ brandSites: sites });
  // Hand the permission back. Leaving it granted for a site we no longer read
  // would be holding access we have no use for.
  try { await chrome.permissions.remove({ origins: originsFor(host) }); } catch (e) {}
  bsMsg("Removed " + host + ".");
  renderSites();
}

$("bsAdd").addEventListener("click", addSite);
$("bsUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addSite(); } });
renderSites();

// ---- fit memory (Tier 4) -----------------------------------------------------
// Stored as a flat, visible ledger. A size profile that changed itself for
// reasons nobody could inspect would be worse than no learning at all, so every
// outcome is listed and individually removable, and the conclusion drawn from
// them is shown next to them.

const getLedger = async () => {
  try { return (await chrome.storage.local.get("fitLedger")).fitLedger || []; } catch (e) { return []; }
};

function fitMsg(text, bad) {
  const el = $("fitMsg");
  el.textContent = text || "";
  el.style.color = bad ? "#c0392b" : "";
}

function fillFitPickers() {
  const who = $("fitPerson"), cat = $("fitCategory");
  const keepWho = who.value, keepCat = cat.value;
  who.innerHTML = "";
  for (const name of Object.keys(state.profiles || {})) {
    const o = document.createElement("option");
    o.value = name; o.textContent = name;
    who.appendChild(o);
  }
  if (!cat.options.length) {
    for (const c of CATEGORIES) {
      const o = document.createElement("option");
      o.value = c; o.textContent = c;
      cat.appendChild(o);
    }
  }
  if (keepWho) who.value = keepWho;
  if (keepCat) cat.value = keepCat;
}

async function renderFit() {
  fillFitPickers();
  const ledger = await getLedger();

  // What has actually been concluded, per person/brand/category.
  const learned = $("fitLearned");
  learned.innerHTML = "";
  const combos = new Map();
  for (const e of ledger) combos.set([e.person, e.brand, e.category].join("|"), e);
  const lessons = [];
  for (const e of combos.values()) {
    const l = learnedSize(ledger, e.person, e.brand, e.category);
    if (l) lessons.push(`<li><b>${esc(e.person)}</b>, ${esc(e.category)}: ${esc(explainFit(l, e.brand))}</li>`);
  }
  learned.innerHTML = lessons.length
    ? "<p class='hint' style='margin:0 0 6px'>Refine is now also looking for:</p><ul style='margin:0 0 4px 18px;font-size:13px'>" + lessons.join("") + "</ul>"
    : "<p class='hint' style='margin:0'>Nothing concluded yet. It takes " + MIN_EVIDENCE +
      " agreeing outcomes for the same size before a size is added.</p>";

  const list = $("fitList");
  list.innerHTML = "";
  ledger.forEach((e, i) => {
    const chip = document.createElement("span");
    chip.className = "site";
    chip.innerHTML = "<b>" + esc(e.person) + "</b><span class='host'>" + esc(e.brand) + " " +
      esc(e.category) + " " + esc(e.size) + " &middot; " + (e.fits ? "fitted" : "did not fit") + "</span>";
    const x = document.createElement("button");
    x.type = "button";
    x.title = "Forget this outcome";
    x.textContent = "×";
    x.addEventListener("click", async () => {
      await chrome.storage.local.set({ fitLedger: forgetFit(await getLedger(), i) });
      fitMsg("Forgotten.");
      renderFit();
    });
    chip.appendChild(x);
    list.appendChild(chip);
  });
}

async function addFit(fits) {
  const person = $("fitPerson").value;
  const category = $("fitCategory").value;
  const brand = $("fitBrand").value.trim();
  const size = $("fitSize").value.trim();
  if (!person || !brand || !size) { fitMsg("A person, a brand and a size are all needed.", true); return; }
  const next = recordFit(await getLedger(), { person, brand, category, size, fits });
  await chrome.storage.local.set({ fitLedger: next });
  $("fitBrand").value = ""; $("fitSize").value = "";
  fitMsg(`Recorded: ${size} in ${brand} ${fits ? "fitted" : "did not fit"} ${person}.`);
  renderFit();
}

$("fitYes").addEventListener("click", () => addFit(true));
$("fitNo").addEventListener("click", () => addFit(false));
renderFit();
