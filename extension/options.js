// Options page: family profiles and per-search constraints.
// chrome.storage.local only. No network. Stores { profiles, who, category,
// brands, colours, hideMode, tier3, query, department } - the shape content.js
// reads. A person holds sizes for SEVERAL categories at once, because a top, a
// pair of jeans and a shoe are measured in different systems.
import { CATEGORY_SIZES, CATEGORIES, COLOUR_FAMILIES, BRAND_ALIASES } from "../core/normalize.js";

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

function sizesOf(person, cat) {
  const p = state.profiles[person] || (state.profiles[person] = {});
  return p[cat] || (p[cat] = []);
}
function setSizesOf(person, cat, list) {
  const p = state.profiles[person] || (state.profiles[person] = {});
  p[cat] = list;
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
      if (state.who === name) state.who = next;
      renderAll();
    });
    const rm = document.createElement("button");
    rm.type = "button"; rm.className = "btn ghost small remove"; rm.textContent = "Remove";
    rm.addEventListener("click", () => {
      collectSizeText();
      delete state.profiles[name];
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

// events
$("addPerson").addEventListener("click", () => {
  collectSizeText();
  let n = "person"; let i = 2;
  while (state.profiles[n]) n = "person " + i++;
  state.profiles[n] = {};
  renderAll();
});
$("who").addEventListener("change", () => { state.who = $("who").value; });
$("category").addEventListener("change", () => { state.category = $("category").value; });
$("hideMode").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-val]");
  if (!b) return;
  state.hideMode = b.dataset.val; renderHideMode();
});

$("save").addEventListener("click", async () => {
  collectSizeText();
  const stored = (await chrome.storage.local.get("refine")).refine || {};
  const next = Object.assign({}, DEFAULTS, stored, {
    profiles: state.profiles,
    who: state.who,
    category: state.category,
    brands: splitList($("brands").value),
    colours: state.colours.map((c) => c.toLowerCase()),
    hideMode: state.hideMode,
    tier3: $("tier3").checked,
  });
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
