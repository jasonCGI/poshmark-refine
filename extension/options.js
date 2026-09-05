// Options page: the shopper's family profiles and per-search constraints.
// chrome.storage.local only. No network.

const DEFAULTS = {
  profiles: { me: { tops: [] } },
  who: "me",
  category: "tops",
  brands: [],
  colours: [],
  hideMode: "fade",
  tier3: true,
};

const $ = (id) => document.getElementById(id);
let state = structuredClone(DEFAULTS);

function splitList(text) {
  return String(text || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function renderPeople() {
  const host = $("people");
  host.innerHTML = "";
  for (const [name, cats] of Object.entries(state.profiles)) {
    const box = document.createElement("div");
    box.className = "person";
    const sizes = (cats[state.category] || []).join(", ");
    box.innerHTML = `
      <header>
        <input type="text" class="pname" value="${escapeAttr(name)}" aria-label="Name">
        <button class="ghost remove" type="button">Remove</button>
      </header>
      <div class="row">
        <label>${escapeHtml(state.category)} sizes</label>
        <input type="text" class="psizes" value="${escapeAttr(sizes)}" placeholder="S, M">
      </div>`;
    box.querySelector(".remove").addEventListener("click", () => {
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

function renderAll() {
  renderWho();
  renderPeople();
  $("category").value = state.category;
  $("brands").value = state.brands.join(", ");
  $("colours").value = state.colours.join(", ");
  $("hideMode").value = state.hideMode;
  $("tier3").checked = !!state.tier3;
}

function collect() {
  const profiles = {};
  for (const box of document.querySelectorAll(".person")) {
    const name = box.querySelector(".pname").value.trim();
    if (!name) continue;
    const prev = Object.values(state.profiles)[[...document.querySelectorAll(".person")].indexOf(box)] || {};
    profiles[name] = Object.assign({}, prev, { [state.category]: splitList(box.querySelector(".psizes").value) });
  }
  state.profiles = Object.keys(profiles).length ? profiles : structuredClone(DEFAULTS.profiles);
  state.who = $("who").value;
  state.category = $("category").value;
  state.brands = splitList($("brands").value);
  state.colours = splitList($("colours").value).map((c) => c.toLowerCase());
  state.hideMode = $("hideMode").value;
  state.tier3 = $("tier3").checked;
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function escapeAttr(s) { return escapeHtml(s); }

$("addPerson").addEventListener("click", () => {
  collect();
  let n = "person"; let i = 2;
  while (state.profiles[n]) n = "person " + i++;
  state.profiles[n] = { [state.category]: [] };
  renderAll();
});

$("category").addEventListener("change", () => { collect(); renderAll(); });

$("save").addEventListener("click", async () => {
  collect();
  await chrome.storage.local.set({ refine: state });
  $("status").hidden = false;
  setTimeout(() => { $("status").hidden = true; }, 1500);
});

(async () => {
  const stored = await chrome.storage.local.get("refine");
  state = Object.assign(structuredClone(DEFAULTS), stored.refine || {});
  renderAll();
})();
