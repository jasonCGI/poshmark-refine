# Codex review brief - v0.15.1 through v0.17.1

You are Codex, the independent reviewer. **Review, do not re-implement, do not merge.**
Report findings by severity with `file:line`. Leave merging to Jason.

## Why this brief is unusual

Everything below **has never run in a browser.** Five versions were written, tested and
pushed without the extension being reloaded once. The suite is 126 green, and that is
precisely the problem: the two worst bugs in the previous release were also invisible to a
green suite, because a jsdom fixture has no viewport, no scroll position and no real image.

So the highest-value thing you can do is **load it and use it**, and treat the tests as a
statement of intent rather than as evidence.

## Setup

- Repo `github.com/jasonCGI/poshmark-refine`, branch `main`, at `4862b8a` plus one
  uncommitted fix (see "Found while writing this brief").
- Working copy: `G:\Job_Applications\poshmark-refine`. **Note the drive.** `Z:` holds a
  second clone of the same remote; both are at the same commit today, but `G:` is the
  working folder now. Run `git log --oneline -1` before trusting either.
- `npm install`, then `npm test`. Expect **126 pass, 0 fail**. jsdom is the only dependency.
- Load unpacked from the repo ROOT - the manifest is at the top level, not in `extension/`.

Range under review: `46d8d88..4862b8a`, five commits.

| version | what landed |
|---|---|
| 0.15.1 | HUD viewport clamp; lazy-load repair for covers blanked by re-sorting |
| 0.15.2 | update bar states the two steps instead of linking to the repo |
| 0.16.0 | self-check surfaced in the popup; brand sites the shopper adds at runtime |
| 0.17.0 | badge names who it fits; accessibility pass; Tier 4 fit memory |
| 0.17.1 | update bar gained a Reload that actually reloads |

---

## 1. Lazy-load repair - the riskiest change (0.15.1)

`core/grid.js` `hasPendingLazy()` / `promoteLazy()`, driven by an IntersectionObserver in
`extension/content.js` (`lazyIo`, `watchLazy`), called from `apply()` after `resort()`.

**The bug it fixes:** Poshmark ships covers as `<picture>` with `data-srcset` on the sources
and `data-src` on the `img`, promoted by its own observer when a tile scrolls in. `resort()`
detaches and re-appends tiles, and that handoff never completes for the ones we moved.
Measured live: 35 of 48 covers blank, including every card that matched.

**Please attack:**

- `watchLazy(document)` runs on every `apply()`. `observe()` on an already-observed element
  is a documented no-op, so this should be idempotent - confirm, and confirm the observer
  is not accumulating entries across a long infinite scroll.
- A tile that is observed and then **re-appended** by a later `resort()`. Does our observer
  still fire for it? Detaching and re-attaching an observed element is the exact operation
  that broke Poshmark's own observer. If ours has the same weakness, the fix is circular
  and I have not proven otherwise.
- `lazyIo` is never `disconnect()`ed. On a page scrolled for an hour, is that a leak?
- `rootMargin: "150px"` loads a cover slightly BEFORE it is on screen. Is that still
  honestly "no request the shopper's own scroll would not have made"? Argue it either way.
  `0px` was the alternative and costs a blank flash on arrival.
- `promoteLazy` sets the sources before the `img`, so `<picture>` cannot lock in the
  fallback JPEG. There is a mutation-order test. Is that ordering guarantee real in a
  browser, or only in jsdom?
- The writes are `src`/`srcset` attributes, and `observeOpts` filters attributes down to
  `href`. That is what keeps this out of the `apply -> resort -> observe` loop that froze
  the tab in 0.4.1. **Verify that filter still holds** - a regression here relocks the tab.

## 2. Runtime-registered brand sites (0.16.0) - the largest new surface

`extension/sw.js` `syncBrandScripts()`, `extension/options.js` `addSite`/`removeSite`,
`core/brand.js` `hostKey`/`sitesWith`/`brandForHost`/`brandFromJsonLd`.
`manifest.json` gained `"scripting"` and `optional_host_permissions: ["https://*/*"]`.

**Please attack:**

- `chrome.permissions.request()` must run inside a user gesture. In `addSite` it is
  deliberately the first `await`. Confirm nothing before it yields, and that it survives a
  real click rather than merely looking correct.
- `syncBrandScripts` runs on `onStartup`, `onInstalled`, `storage.onChanged` and
  `permissions.onRemoved`. Registered scripts persist across service-worker restarts. Is
  there a path where storage lists a site, the permission is granted, and no script is
  registered - a site that silently does nothing?
- Registration failures are swallowed in `try/catch`. Should a failure surface in the
  options page rather than leaving a chip that looks healthy?
- Each chip reports live `permissions.contains()` rather than what we stored, because a
  permission can be revoked in Chrome's settings without telling us. Is that render path
  racy when several chips resolve at once?
- **`web_accessible_resources` for `core/brand.js` and `core/search.js` was broadened from
  the two Vuori hosts to `https://*/*`**, because a shopper's host cannot be known at build
  time. Any page can now fetch those files and detect the extension. `use_dynamic_url: true`
  is the documented mitigation and was NOT taken, because it also changes the working Vuori
  path and wanted verification first. **Is that the right call, and does `use_dynamic_url`
  actually keep `chrome.runtime.getURL()` working inside a content script?** This is the
  decision here I am least sure of.

## 3. Tier 4 fit memory (0.17.0)

`core/fit.js`, wired through `core/verdict.js` `intentFor`/`verdict`, UI in
`extension/options.js`, ledger under its own `fitLedger` storage key.

Two rules define it: **two agreeing outcomes before acting** (one is an anecdote), and it
**only ever widens** the search, never hides. A size with outcomes on both sides is noise
and teaches nothing.

**Please attack:**

- `verdict()` builds a per-card copy of `owners`, because mutating the shared intent leaked
  one card's learned size onto every card judged afterwards. There is a test. **Is the copy
  deep enough?** `Object.assign({}, intent.owners)` is shallow and the values are arrays; I
  `.slice()` before pushing. Confirm every path does.
- Shopping for "anyone", each person is widened separately so one person's history cannot
  widen another's search. Try three people with overlapping sizes.
- `learnedSize` requires `failed === 0`. Is "never failed" too strict on a long ledger -
  does one bad outcome from two years ago permanently silence a real lesson? There is no
  recency weighting. Deliberate simplicity, or wrong?
- Ties sort by `b.fitted - a.fitted || localeCompare`. Is a `localeCompare` tiebreak on
  sizes defensible, given "10" sorts before "9"?
- The ledger is a flat array in `chrome.storage.local`. What happens at a thousand entries?
- Product concern, not a bug: the only way to record an outcome is to type the person,
  brand, category and size into the options page from memory. There is no content script on
  `poshmark.com/listing/*`. Is this feature reachable enough to ever be fed?

## 4. Accessibility (0.17.0) - please re-audit rather than trust me

`test/a11y.test.js` parses `content.css` and computes contrast in both themes. Dark-mode
badge text failed AA outright before this - 1.88 / 1.97 / 2.34 against a required 4.5,
because `color: #fff` was hardcoded while the backgrounds flip to pastels. Now themed via
`--pmr-on-badge`: 9.17 / 8.75 / 7.35.

**Please attack:**

- My token parser reads `:root`, then overrides from the dark media block, with a regex.
  Does that actually model the cascade, or would it miss a token defined elsewhere?
- The badge is now `role="button"`, `tabindex="0"`, Enter and Space. Inside someone else's
  grid, is a `<span>` with a role right, or should it be a real `<button>`?
- The correction popover has `role="dialog"`, Escape closes, and Escape/Cancel/Save all
  return focus to the badge. **It is not a focus trap** - Tab still walks out into the page
  behind. For a non-modal popover is that correct, or does it need `aria-modal` and a trap?
- Badges sit on arbitrary photographs. Token contrast is now proven; contrast against the
  *image* is not, and cannot be. Is the pill background opaque enough in all cases?
- The HUD is `role="status"` and its counts change on every scroll batch. I suspect that
  makes a screen reader unusable during infinite scroll. I have not addressed it. Confirm
  and tell me how bad it is.

## 5. Self-check (0.16.0)

`core/grid.js` `selfCheck()`, called from the `pmr:status` responder, rendered by
`showProblems()` in `extension/popup.js`.

- Geometry is injected (`rectOf`, `view`) so jsdom can drive it. Does the default
  `getBoundingClientRect` path behave when the HUD is `hidden` and returns an all-zero
  rect? I believe zero reports healthy; confirm it cannot false-positive.
- It reports only problems, never a clean bill of health, on the theory that a panel which
  always says "all good" stops being read. Agree, or push back.
- An empty tile set short-circuits to "selectors matched nothing". Confirm no other check
  can run across zero cards and report healthy.

## 6. Update bar (0.15.2, 0.17.1)

`chrome.runtime.reload()` on a button. For an unpacked extension this re-reads the folder,
which is the second of the two steps the bar names. **I cannot test it** - it destroys the
popup that calls it. Please confirm it does what I claim, and that the version comparison
then clears the bar rather than leaving it stuck.

## Found while writing this brief - uncommitted

Adding a **built-in** host (that is, `vuoriclothing.com`) through the options page would
have registered a dynamic content script for pages the static manifest entry already
covers, injecting the Find-on-Poshmark button twice. `addSite` now refuses any host present
in `BRAND_SITES`. Please check the reverse case: a host the shopper added that LATER ships
as built-in. Nothing cleans that up.

## Verification

```
npm install
npm test          # 126 pass, 0 fail
node --check extension/content.js
node --check extension/popup.js
node --check extension/options.js
node --check extension/sw.js
node --check extension/brand.js
```

Live, which is the part that matters:

1. Load unpacked from the repo root. Open a Poshmark search with a size and colour set.
2. **Covers must load.** The previous release blanked 35 of 48. Scroll and watch.
3. The tab must stay responsive and text must stay selectable - the 0.4.1 freeze.
4. Shrink the window until it is shorter than the HUD's saved position. The HUD must stay
   reachable; it used to strand itself below the bottom edge with no way to drag it back.
5. Open the popup. The self-check panel should be **absent**. If it is red, that is the
   feature working - report what it said.
6. Tab to a badge, press Enter, then Escape. Focus must return to the badge.
7. Settings: add a brand site. Confirm Chrome prompts, open one of its product pages, and
   confirm exactly ONE button appears. Remove it and confirm the permission is handed back.
8. Settings: record the same person/brand/size as fitting twice, then find a listing in
   that size and confirm it is surfaced with a note explaining why.
9. Dark mode: badge text must be dark on the coloured pill, not white.

Report by severity with `file:line`.
