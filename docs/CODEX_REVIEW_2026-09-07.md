# Codex Review Brief - Poshmark Refine v0.2.0 to v0.6.0 (2026-09-07)

You are Codex, the independent reviewer. Verify, do NOT re-implement, do NOT merge.
Scoped to the 8 commits `6708ab5..HEAD` on `main`.

## Setup
- Repo `github.com/jasonCGI/poshmark-refine` (public). Working copy
  `Z:\Job_Applications\poshmark-refine`. `git pull --ff-only` on `main`.
- Plain JS, no build step, no dependencies, Node's own test runner. Do not add deps.
- Boundaries that are load-bearing and must not regress: the extension reads only the
  page the shopper loaded; its ONLY network request is the Tier-3 hover read of the
  listing under the pointer; it writes nothing anywhere except `chrome.storage.local`.
- `node --test` from the repo root. Expect **29 pass, 0 fail**.

## What changed
An extension that re-ranks and annotates the Poshmark search grid against a shopper
profile. Three verdicts per card - SHOW / HIDE / DIM - where a KNOWN contradicting
attribute hides, an UNKNOWN attribute dims and sorts down but never hides, and every
verdict carries a reason. Since v0.1.0:

- **`6708ab5` UI/UX.** Per-tile badge (Match/Check/Off) on the cover image, per-state
  reason strips, dark mode, and a floating summary HUD that is draggable by its handle,
  remembers its position in `localStorage`, and collapses.
- **`c1e208b` popup.** The toolbar icon opens a compact popup instead of forcing a
  settings tab. The popup shows LIVE status of the page beneath it by messaging the
  content script (`pmr:status`), and offers a Refresh when a tab predates the extension.
- **`367bd78` / `ba875f2` / `82e8b44`.** Category + sizes editable in the popup; the
  freeze fix (below); and a search box that builds the Poshmark URL and navigates.
- **`0.6.0` per-category sizes.** A person holds sizes for tops / dresses / outerwear /
  bottoms / shoes at once. Shoes are their own scale. The UI is a person x category
  matrix, and "Anyone in the family" no longer locks size editing.

## The part I most want challenged: the freeze fix (`ba875f2`)

`resort()` re-appends every tile wrapper. That is a DOM mutation, so the
MutationObserver on `document.body` fired -> `apply()` -> `resort()` -> unbounded loop.
It pegged the CPU ("Page Unresponsive") and re-ordered nodes many times a second, which
destroyed text selection as fast as it was made. An earlier grid-detection bug masked it
by making `apply()` touch a single tile; fixing that made it churn all 48 and the tab died.

Three guards, in `extension/content.js`:
1. `apply()` takes a re-entrancy flag and **disconnects** the observer while it writes,
   reconnecting in `finally`.
2. The observer reacts only to tiles with no `data-pmr-seen` - genuinely new ones from
   infinite scroll - and coalesces bursts into one pass per animation frame.
3. `resort()` is idempotent: if the grid is already in the wanted order it touches nothing.

Plus a convergence pass: `disconnect()` empties the pending record queue, so tiles
appended WHILE `apply()` ran are dropped. `judge()` marks every tile it looks at with
`data-pmr-seen` (titled or not, since ad tiles have no title), and `apply()` schedules one
more pass if any unseen tile remains.

**Verify, adversarially:**
- Is there ANY remaining path where a write of ours re-enters `apply()`? Consider
  `hoverRead()` -> `judge()` -> `decorate()` writing `strip.textContent` and appending a
  badge while the observer IS connected; `updateHud()` -> `ensureHud()` appending the HUD
  to `document.body`; `chrome.storage.onChanged` -> `apply()`. I believe text-node and
  attribute mutations cannot trigger it because the callback skips `nodeType !== 1`, and
  the HUD append happens inside `apply()` while disconnected. Confirm or break that.
- Can the convergence `requestAnimationFrame(apply)` ever fail to converge? My claim: each
  pass sets `data-pmr-seen` on every tile it enumerates, so the `:not([data-pmr-seen])`
  selector strictly shrinks. Is there a tile that can be enumerated but not marked, or a
  Poshmark re-render that strips `data-*` attributes and resurrects the loop?
- Is `resort()`'s "already in order" identity comparison correct (`sorted[i] !== keyed[i]`
  on the same element arrays), and does it hold when tile count changes mid-pass?
- `findGrid()` walks up from the first tile to the nearest ancestor holding >1 tile
  (Poshmark wraps each tile in a `col-*` column inside `.tiles_container`). Does that
  mis-select if the first tile is an ad, if a single result is returned, or if two grids
  exist on one page? `wrapperOf()` assumes the wrapper is a direct child of that grid.

## Also verify
- **Shoe scale (`core/normalize.js`).** `normalizeSize("8","shoes")` -> `US 8`, `"9 1/2"` ->
  `US 9.5`, and the garment US-numeric-to-letter inference must NEVER apply to shoes. A
  letter in the shoe scale returns `unknown` (dims) rather than `no` (hides) - is that the
  right call, or should an unreadable INTENT be surfaced differently from an unreadable CARD?
- **Backward compatibility.** `normalizeSize`/`sizeMatches`/`parseCard` gained an optional
  `category` defaulting to the garment behaviour. Confirm no existing call site changed
  meaning, and that `verdict()` prefers `intent.category` over `card.category` correctly.
- **Storage merge.** The popup and the options page both write the `refine` record and both
  merge over a fresh read. Is there a lost-update window if both are open (popup saves,
  options saves stale profiles over it)? Severity in practice?
- **Colour vocabulary.** It is deliberately richer than Poshmark's ~16 flat filter colours,
  because the structured `color` field is coarse and often blank. Ambiguous first-name-ish
  words are only matched in phrase form (`ruby red`, not `ruby`), and `fawn` was removed
  after it false-matched the brand "Gentle Fawn". Are there remaining single words in
  `COLOUR_FAMILIES` that are more likely a brand or a person than a colour? Candidates I am
  unsure about: `pearl`, `jade`, `clay`, `snow`, `raven`, `orchid`, `grape`.
- **Tier-3 read.** It now parses the listing's embedded `"color"` JSON field first, then
  falls back to detail + description text. One request in flight, cached per tab, hover
  only, never on scroll. Confirm it cannot be triggered in bulk, and that a failed read is
  cached so it is not retried.
- **ES modules in MV3.** `popup.html` and `options.html` now load their scripts as
  `type="module"` and import `../core/normalize.js` so the UI cannot drift from the engine.
  Confirm this is legitimate for extension pages (it is not a content script, so
  `web_accessible_resources` should not be needed) and that nothing else regressed.
- **Search URL builder (`popup.js searchUrl()`).** Sends `category` only for `tops` and
  `dresses`, where I verified Poshmark's facet name; the others rely on the query rather
  than risk an empty result page. Is the encoding right, and are the other facet names
  worth pinning down?

## Known gaps, not defects
- The verdict uses the UNION of title colours and Tier-3 colours, so a title match counts
  even when Poshmark's field is wrong; it does not yet OVERRIDE a confidently wrong field.
- Only `tops`/`dresses` map to a Poshmark category facet.
- No jsdom DOM-layer test: `findGrid`/`resort`/the observer are covered only by manual
  live testing, which is exactly where the two worst bugs were found. If you think a jsdom
  harness is worth the dependency, say so.

## Verification
```
node --test                     # expect 29 pass, 0 fail
node --check extension/content.js
node --check extension/popup.js
node --check extension/options.js
node --check extension/sw.js
node -e "const m=require('./manifest.json');const fs=require('fs');for(const p of [...m.content_scripts.flatMap(c=>[...c.js,...c.css]),...m.web_accessible_resources.flatMap(w=>w.resources),m.options_ui.page,m.background.service_worker,m.action.default_popup]) if(!fs.existsSync(p)) throw new Error('missing '+p); console.log('manifest ok', m.version)"
# live: load unpacked from the repo ROOT, open a Poshmark search, confirm the tab stays
# responsive, text stays selectable, and infinite scroll keeps judging new tiles.
```
Report findings by severity with file:line; leave merging to Jason.
