# Poshmark search refiner - spec

Written 2026-09-05 as a draft to react to; agreed the same day and built out
since. Last reconciled with the code **2026-09-07 at v0.15.0**.

Jason's framing: *"Their current search is not very good. It ignores things
like size and brand and colors."*

The problem statement, the Terms-of-Service constraint and the tier model below
are unchanged from the original draft and still describe the product. What has
been built against them is recorded in *Built* near the end.

## The problem, stated precisely

Poshmark search returns listings that do not satisfy the filters the shopper
set. Search for a brand in a size and a colour and the grid comes back padded
with other brands, other sizes, and items whose colour is anyone's guess. The
shopper then does the filtering by eye, card by card, across pages.

The cause is structural, not a bug that will be fixed: every attribute on
Poshmark is **seller-entered free text or a seller-picked tag**. Sizes are typed
a dozen ways (`M`, `Medium`, `8`, `US 8`, `EU 38`, `W26 L30`). Brands are
misspelled or put in the title but not the brand field. Colour is a tag the
seller may skip. Poshmark's search matches loosely across all of it, so the
filter narrows the field; it does not identify what fits.

That sentence is the same rule this library's other tooling lives by, and the
product is the same move: **take the seller's noisy signals, normalise them,
and enforce the shopper's constraints as hard filters on what is actually in
each listing** - then say *why* something was hidden.

## The constraint that decides the architecture

Poshmark has **no public API**, no developer programme, and its Terms of
Service (v4.6, effective 2025-06-03) prohibit in §4(b) any use of *"technology,
software or automated systems to collect any information or data for the
Service"*, and in §7 creating *"derivative works"* of Service Content.

So a hosted front end that fetches Poshmark on the shopper's behalf, or a
server that indexes listings, is out. It would be scraping by any reading, and
Poshmark actively blocks it.

What is left - and what every surviving tool in this space actually is - is a
**browser extension that operates on the page the shopper already loaded, in
the shopper's own session, and sends nothing anywhere**. The closest precedent
is *Poshmark Mega Filter* (Chrome Web Store, last updated 2022-08-11, 104
users, 1.0 rating): hide by keyword / brand / seller / likes / comments /
title-length / sold status. It re-renders the results grid; it collects
nothing. That is the compliant shape. It is also weak - nothing in it
understands size, colour, or what the shopper asked for - which is the gap.

## What a result card gives us to work with

Measured on a live search (`levis 501`, Women):

| on the card | example |
|---|---|
| title | `Levis 501 Original Fit High Rise Straight Leg Blue Denim Jeans W26 L30 Cut Hem` |
| price / original | `$38 $110` |
| size | `Size: 26` |
| brand | `Levi's` / `Levis` |
| seller, likes, image | yes |
| condition | sometimes (`NWT`) |
| **colour** | **not on the card** |

So size and brand can be enforced from the card alone. Colour can only be
read from the **title text** on the card; the seller's colour tag lives on the
listing page. That split drives the tiers below.

## Design

### Principles

1. **Client-side only.** The extension reads the DOM of the page the shopper
   opened, filters and re-orders it, and stores only the shopper's own
   preferences in the browser. No fetch to Poshmark that the shopper's click
   would not have made. No data leaves the machine. This is the line the ToS
   draws and the line that keeps the tool alive.
2. **Hard filters, not scores.** The shopper set size 8. A listing that is not
   size 8 is hidden, not ranked lower. Ranking is for ties among matches.
3. **Normalise before comparing.** Size, brand and colour each get an alias
   table (`M` = `Medium` = `8` in women's US tops; `Levis` = `Levi's` =
   `LEVI STRAUSS`; `navy` ⊂ `blue`). Tables start small and grow from the
   shopper's own corrections.
4. **Say why.** Every hidden card gets a one-line reason on hover or in a
   collapsed strip: *"hidden: size W30, you asked for W26"*. Silent removal is
   how a tool loses trust; the reason is also how the alias tables learn.
5. **Never hide on absence.** A card with no size shown is *unknown*, not a
   mismatch. Unknowns are dimmed and moved down, never removed - a missing tag
   is the seller's omission, not evidence against the item.

### Tiers

| tier | what it does | data used | risk |
|---|---|---|---|
| **1 - card enforcer** | hard-filter size and brand; colour from title words; hide with reason; dim unknowns; re-sort matches first | result-card DOM only | none - same class as Mega Filter |
| **2 - sticky intent** | remember the shopper's size profile per category (tops 8, jeans W26 L30, shoes 7.5) and apply it automatically to every search without re-setting sidebar filters | browser storage | none |
| **3 - listing-backed colour** | on hover or on demand, read the listing page the shopper is about to open anyway and use its colour tag / description | one listing fetch per user action | **grey** - this is a request the shopper would have made, but it is the tool making it; opt-in, per-card, never in bulk |
| **4 - fit memory** | mark listings "fits / doesn't" after purchase; learn the shopper's real size per brand (Levi's runs small etc.) | browser storage | none |

**Tier 3 is the one that needs a decision.** It is the only way to get real
colour for most listings, and it is also the only place the tool makes a
request on its own. Bulk prefetch is off the table; per-card on hover is
defensible; I would still want Jason's call before building it.

### Not in scope

- Anything that runs when the shopper is not on the page (no background
  indexing, no alerts, no saved-search polling). That is the scraping line.
- Sharing, offers, relisting, closet automation - the bot space Poshmark bans
  and the space every existing tool already fights over.
- A hosted site. There is nothing a server could legitimately hold.

### Shape of the code

Chrome/Edge extension (Manifest V3), content script on `poshmark.com/search*`
and `/brand/*` / `/category/*` result pages, `MutationObserver` for the
infinite-scroll grid, a small options page for size profile and alias tables,
`chrome.storage.local` only. Pure-function core (`parseCard`, `normaliseSize`,
`matches(card, intent)`) with unit tests against captured card HTML, so the
filter logic is tested without a browser.

## Decisions (Jason, 2026-09-05)

1. **Tier 3 is in.** Colour comes from the listing page, read on hover, one
   card at a time, only for a card the shopper is pointing at. Guardrails that
   keep it on the right side of §4(b): no prefetch on scroll, no bulk, one
   in-flight request at a time, result cached for the tab session only, and
   the request is the same GET the shopper's click would have made.
2. **Family profiles.** Settings hold named people (e.g. Jason, wife, kids)
   each with a size profile per category; the toolbar picks who you are
   shopping for. Filters apply to the selected person; "anyone in the family"
   is a valid selection that unions the sizes.
3. **Tops first.** Alias tables are built against women's and men's tops
   (`XS S M L XL` ⇄ numeric US ⇄ EU/UK ⇄ bust inches), the category with the
   most spelling variance per listing. Jeans (W/L) and shoes follow once the
   pattern holds.
4. **Portfolio piece.** Public repo under jasonCGI, whitepaper on
   cardonalab.dev in the house whitepaper format, and the "narrows vs
   identifies" thesis is the story. That means tests, captured fixtures, and
   a written contract from day one rather than a fast household hack.

## Phase 1 build slice (built)

Repo `jasonCGI/poshmark-refine` (public), Manifest V3, **no build step and no
bundler at all**, no telemetry of any kind. All six items below shipped; item 6
is drafted but not yet published.

1. **Fixtures first.** Save ~40 real result cards (HTML) from `tops` searches
   as test fixtures, covering the spelling variance: `M`, `Medium`, `8`,
   `US 8`, `EU 38`, `Sz M`, `size medium`, brand in title but not in field,
   colour only in title, no size at all.
2. **Pure core** (`core/`), unit-tested against the fixtures, zero browser
   dependency: `parseCard(html) -> {title, price, size, brand, seller,
   condition}`, `normaliseSize(text, category) -> canonical | unknown`,
   `normaliseBrand(text) -> canonical | unknown`, `colourFromTitle(title) ->
   set`, `verdict(card, intent) -> {show|hide|dim, reason}`. The verdict
   function is where the rule lives: absence = dim, mismatch = hide with a
   reason, match = show.
3. **Content script** on `poshmark.com/search*` and category/brand result
   pages: `MutationObserver` over the infinite-scroll grid, applies the
   verdict per card, injects the reason strip, re-sorts matches first.
4. **Options page**: family members, each with a per-category size profile;
   alias tables editable; "hide vs fade" preference. `chrome.storage.local`
   only.
5. **Tier 3 hover read**: on `mouseenter` of a card that is *dim* for colour,
   fetch the listing URL the card already links to, read the colour tag and
   description, re-run the verdict. Cached per tab session.
6. **Whitepaper draft** alongside the code, in the cardonalab format, with the
   before/after grid as the hero.

Definition of done for phase 1: on a tops search with a chosen family
member, every visible card matches their size and brand, every hidden card
shows why, unknowns are dimmed and grouped at the end, and the core has >90%
of its verdict logic covered by fixture tests.

The function names in item 2 are the draft's sketch, not the shipped API; the
modules landed with different names and a wider surface. Read `core/` for the
real one.

## Built

Phase 1 landed at v0.7.0. Everything after it followed the same rule and is
listed here so the spec does not read as though the tool stopped there.

| version | what it added |
|---|---|
| 0.8.0 | jsdom DOM tests; `core/grid.js` extracted so tests exercise shipped code; captured grid fragment as a selector-drift canary |
| 0.9.0 | exact brand colourways, learned from listings as you browse |
| 0.10.0 | brand-page bridge: read a product off the brand's own site (JSON-LD) and find it on Poshmark |
| 0.11.0 | saved searches |
| 0.12.0 | correct a card's badge, and the alias tables actually learn the word |
| 0.13.0 | colour precedence: the title and the listing's coarse colour field are not equal evidence |
| 0.14.0 | optional on-device AI tier, behind everything deterministic, fills-only |
| 0.15.0 | every category sends a facet read off Poshmark's own category links |
| 0.15.1 | two bugs found by looking at a real page: a HUD restored outside the viewport, and 35 of 48 covers left blank by the lazy-load handoff re-sorting interrupts |
| 0.15.2 | the update bar states the two steps instead of linking to a page that does not answer the question |
| 0.16.0 | a self-check that runs those live assertions on every popup open; brand sites the shopper adds, with a per-site permission |
| 0.17.0 | a match names WHO it fits; an accessibility pass (dark-mode badge contrast failed AA at 1.88:1, and the correction popover was mouse-only); Tier 4 fit memory |

Also built and not in the original slice: per-category size profiles (a person
is not one size), a search box in the popup, and an opt-in daily update check.

**Tier 4 (fit memory) shipped in 0.17.0.** `core/fit.js` records outcomes per
person, brand and category, and adds the size that has consistently fitted. Two
rules keep it honest: it takes two agreeing outcomes before acting (one is an
anecdote), and it only ever WIDENS the search - a learned size is evidence about
one garment, never grounds for discarding a listing. The ledger is a flat,
visible list in settings, because a size profile that changed itself for reasons
nobody could inspect would be worse than no learning at all.

## Open questions

0. **`core/brand.js` and `core/search.js` are now web-accessible to `https://*/*`,**
   because a site the shopper adds cannot be known at build time. Any page can
   therefore fetch those two files and learn the extension is installed. The
   fix is `use_dynamic_url: true` on that resource entry, which serves them at
   a rotating URL; it was not taken yet because it would also change the
   working Vuori path and wants live verification before it ships.
1. **Chrome only, or Chrome + Edge + Firefox?** MV3 differences are small for
   this shape, but Firefox needs a separate store listing.
2. **Distribution.** Loaded unpacked today, which cannot auto-update - the
   extension can only *tell* you an update exists. Closing that loop means a
   Chrome Web Store listing, with the store review and the permission
   justifications that come with it.
3. **Multi-size sweep.** Running one search per size and merging the results
   would be genuinely useful and is the first feature that would make the tool
   *generate* traffic rather than annotate a page the shopper opened. Held
   deliberately: it crosses the line every other feature has stayed behind.

## Resolved

- **Tier 3** - in, with guardrails (hover only, one at a time, no prefetch,
  tab-session cache). Off by default.
- **Whose sizes** - multiple people from the start, each with a profile per
  category. "Anyone in the family" unions the sizes and does not lock them.
- **First category** - tops, then the rest; shoes are their own scale and are
  never inferred from a letter size.
- **Portfolio or personal** - portfolio. Public repo, whitepaper drafted for
  cardonalab.dev, and the "narrows vs identifies" thesis is the story.
- **Repo visibility** - public from day one.

## Sources

- Poshmark Terms of Service v4.6 (2025-06-03), §4(b) and §7 - https://poshmark.com/terms
- Poshmark Mega Filter, Chrome Web Store - https://chromewebstore.google.com/detail/poshmark-mega-filter-decl/mkejbbfppmancdadihjnbmffgmeefdgo
- Live result-card inspection, `levis 501` / Women, 2026-09-05
