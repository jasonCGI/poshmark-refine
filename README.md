# poshmark-refine

A browser extension that makes Poshmark search respect the size, brand and
colour you asked for.

Poshmark's own search matches loosely across seller-typed text, so a search for
one brand in one size in one colour comes back padded with other brands, other
sizes, and items whose colour nobody stated. This extension re-filters the
result grid you already loaded: every visible card fits, every hidden card says
why it was hidden, and cards with missing information are dimmed rather than
thrown away.

## What it will not do

- Fetch Poshmark on your behalf, index listings, or run when you are not on
  the page. Poshmark has no public API and its Terms of Service forbid
  automated collection; this tool works only on the page in your own browser
  session and sends nothing anywhere.
- Share, follow, relist, or send offers. That is the bot space Poshmark bans.
- Guess. A size typed as `X8` is *unknown*, not `XS`. A title with no colour
  word is *unknown*, not colourless. Unknowns are dimmed, never hidden.

## The rule the code is built on

*A seller's text narrows what an item might be; it does not identify it.*

So every normaliser returns a **confidence** alongside its answer, and the
verdict enforces your constraints only on what is actually known. That single
rule is why the asymmetries below exist rather than being special cases:

| evidence | what happens |
|---|---|
| size stated on the card | hard filter - a mismatch is hidden with a reason |
| size only described in prose ("fits like a medium") | surfaced as a match, never used to discard |
| brand read by the on-device model | dims, never hides |
| colour contradicted by the **title** | hidden |
| colour absent, or only in the coarse listing field | dimmed |

## Using it

**Load it.** `chrome://extensions` -> Developer mode -> Load unpacked -> this
folder. Chrome or Edge; Manifest V3, no build step.

**The toolbar popup** is the whole control surface: who you are shopping for,
the category, the sizes for *that* category, colours and exact brand
colourways, max price, NWT-only, brands, and a search box that opens Poshmark
with the facets already applied. Saved searches sit at the top.

**On a results page** each card is judged in place. Matches sort first, hidden
cards carry a one-line reason, unknowns dim and sink. A count sits in the
corner. Clicking a card's badge lets you correct it, and the correction teaches
the *word* - so "Bay Blue" is understood on every future card, not just that
one.

**On a brand's product page** (Vuori today) the extension offers to find that
exact item on Poshmark, carrying the colourway and your size across.

**Two things are off by default** and stay off until you turn them on: reading
a listing you hover to resolve its colour, and Chrome's on-device AI for cards
nothing deterministic can parse. Neither sends anything off the machine. A
once-a-day GitHub update check is also opt-in, and is the only request the
extension makes that is not to Poshmark.

## Status

Shipping at **v0.15.1**, loaded and used in Chrome.

| piece | state |
|---|---|
| `core/normalize.js` | size / brand / colour / price / condition normalisers, each with a confidence |
| `core/verdict.js` | card -> show / hide / dim, with reasons and the evidence asymmetries above |
| `core/grid.js` | the DOM layer - grid discovery, tile signatures, idempotent re-sort |
| `core/search.js` | builds a Poshmark search URL from verified facets |
| `core/brand.js` | reads a product off a brand's own page (JSON-LD), maps it to a search |
| `core/presets.js` | saved searches |
| `core/ai.js` | optional on-device Prompt API tier, last and fills-only |
| `core/update.js` | opt-in update check |
| `extension/` | content script, brand-page script, popup, options, service worker |
| `fixtures/` | 48 captured result rows (text) + a real grid fragment (DOM) |
| `test/` | **95 tests** - `core.test.js` against fixture text, `dom.test.js` in jsdom against the shipped modules |

The DOM tests import `core/grid.js`, which is the same module the content
script imports, so the tests exercise shipped code rather than a copy of it.
The captured grid fragment doubles as a **selector-drift canary**: when
Poshmark changes its markup, those tests fail before you find out on the site.

```
npm install     # jsdom, for the DOM tests
npm test        # 95 passing
```

Node 20+ (uses `node:test`). jsdom is the only dependency, and it is dev-only -
nothing ships in the extension but the files in this repo.

## Design notes

`SPEC.md` carries the problem statement, the Terms-of-Service constraint that
decides the architecture, the tier model, and what has and has not been built.
