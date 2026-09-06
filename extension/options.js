// Options page: the shopper's family profiles and per-search constraints.
// chrome.storage.local only. No network. Stores { profiles, who, category,
// brands, colours, hideMode, tier3 } - the exact shape content.js reads.

const DEFAULTS = {
  profiles: { me: { tops: [] } },
  who: "me",
  category: "tops",
  brands: [],
  colours: [],
  hideMode: "fade",
  tier3: true,
};

// The 13 colour families the verdict engine knows, each with a representative
// swatch. Order roughly by hue for a tidy palette.
const COLOUR_SWATCH = {
  black: "#1e1e1e", white: "#f2ede4", grey: "#9aa0a6", beige: "#d8c3a0",
  brown: "#6f4a2f", red: "#b23b3b", orange: "#e0863a", yellow: "#e6c43f",
  green: "#6f9e59", blue: "#4f79b0", purple: "#8a63b0", pink: "#e39ac2",
  multi: "conic-gradient(from 0deg,#e35d5d,#e6c43f,#6f9e59,#4f79b0,#8a63b0,#e35d5d)",
};
// Brands the alias table knows - offered as autocomplete, not a hard limit.
const KNOWN_BRANDS = [
  "Vuori", "Rails", "Madewell", "Free People", "Anthropologie", "Aritzia",
  "Lululemon", "Faherty", "Zara", "J.Crew", "Levi's", "Abercrombie & Fitch",
  "ASTR the Label", "L'AGENCE", "Prana", "Joie", "Doen", "Vince Camuto",
];
// Quick-add sizes for tops.
const QUICK_SIZES = ["XS", "S", "M", "L", "XL", "XXL", "1X", "2X", "3X"];

const $ = (id) => document.getElementById(id);
let state = structuredClone(DEFAULTS);

const splitList = (t) => String(t || "").split(",").map((s) => s.trim()).filter(Boolean);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function addSize(input, size) {
  const cur = splitList(input.value);
  if (!cur.some((s) => s.toLowerCase() === size.toLowerCase())) cur.push(size);
  input.value = cur.join(", ");
}

function renderPeople() {
  const host = $("people");
  host.innerHTML = "";
  for (const [name, cats] of Object.entries(state.profiles)) {
    const box = document.createElement("div");
    box.className = "person";
    const sizes = (cats[state.category] || []).join(", ");
    box.innerHTML =
      '<header>' +
        '<input type="text" class="pname" value="' + escapeHtml(name) + '" aria-label="Name">' +
        '<button class="btn ghost small remove" type="button">Remove</button>' +
      '</header>' +
      '<div class="sizes-row">' +
        '<input type="text" class="psizes" value="' + escapeHtml(sizes) + '" placeholder="S, M" aria-label="' + escapeHtml(name) + ' sizes">' +
      '</div>' +
      '<div class="chips quick" style="margin-top:8px"></div>';
    const psizes = box.querySelector(".psizes");
    const quick = box.querySelector(".quick");
    for (const s of QUICK_SIZES) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.textContent = s;
      b.addEventListener("click", () => { addSize(psizes, s); });
      quick.appendChild(b);
    }
    box.querySelector(".remove").addEventListener("click", () => {
      collect();
      delete state.profiles[name];
      if (state.who === name) state.who = Object.keys(state.profiles)[0] || "anyone";
      renderAll();
    });
    host.appendChild(box);
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

function renderColours() {
  const host = $("colours");
  host.innerHTML = "";
  for (const [fam, sw] of Object.entries(COLOUR_SWATCH)) {
    const on = state.colours.includes(fam);
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.setAttribute("aria-pressed", String(on));
    b.innerHTML = '<span class="sw" style="background:' + sw + '"></span>' +
      fam.charAt(0).toUpperCase() + fam.slice(1) + (on ? ' <span class="tick">&#10003;</span>' : "");
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
  for (const b of KNOWN_BRANDS) {
    const o = document.createElement("option");
    o.value = b; dl.appendChild(o);
  }
}

function renderHideMode() {
  for (const b of $("hideMode").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.val === state.hideMode));
  }
}

function renderAll() {
  renderWho();
  renderPeople();
  renderColours();
  renderHideMode();
  $("category").value = state.category;
  $("brands").value = state.brands.join(", ");
  $("tier3").checked = !!state.tier3;
}

function collect() {
  const profiles = {};
  const boxes = [...document.querySelectorAll(".person")];
  boxes.forEach((box, idx) => {
    const name = box.querySelector(".pname").value.trim();
    if (!name) return;
    const prev = Object.values(state.profiles)[idx] || {};
    profiles[name] = Object.assign({}, prev, { [state.category]: splitList(box.querySelector(".psizes").value) });
  });
  state.profiles = Object.keys(profiles).length ? profiles : structuredClone(DEFAULTS.profiles);
  if (!state.profiles[state.who] && state.who !== "anyone") state.who = Object.keys(state.profiles)[0] || "anyone";
  state.category = $("category").value;
  state.brands = splitList($("brands").value);
  // colours are held live in state via the chip toggles; keep them lowercased
  state.colours = state.colours.map((c) => c.toLowerCase());
  state.tier3 = $("tier3").checked;
  // who + hideMode are set by their own handlers
}

// events
$("addPerson").addEventListener("click", () => {
  collect();
  let n = "person"; let i = 2;
  while (state.profiles[n]) n = "person " + i++;
  state.profiles[n] = { [state.category]: [] };
  renderAll();
});
$("who").addEventListener("change", () => { state.who = $("who").value; });
$("category").addEventListener("change", () => { collect(); renderAll(); });
$("hideMode").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-val]");
  if (!b) return;
  state.hideMode = b.dataset.val; renderHideMode();
});

$("save").addEventListener("click", async () => {
  collect();
  await chrome.storage.local.set({ refine: state });
  const s = $("status"); s.hidden = false;
  setTimeout(() => { s.hidden = true; }, 1600);
});

(async () => {
  renderBrandsList();
  const stored = await chrome.storage.local.get("refine");
  state = Object.assign(structuredClone(DEFAULTS), stored.refine || {});
  if (!Array.isArray(state.colours)) state.colours = [];
  renderAll();
})();
