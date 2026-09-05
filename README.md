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

## Status

Phase 1 core is built and tested; the extension shell is not yet wired.

| piece | state |
|---|---|
| `fixtures/` | 48 real result cards from a tops search, text only |
| `core/normalize.js` | size / brand / colour normalisers with confidence |
| `core/verdict.js` | card -> show / hide / dim, with reasons |
| `test/` | 24 tests, all against fixture text |
| `extension/content.js` | grid re-filter, reason strip, re-sort, Tier-3 hover read |
| `extension/options.*` | family profiles, constraints, fade/hide, Tier-3 toggle |
| loaded in a browser | **not yet** - `chrome://extensions` -> Developer mode -> Load unpacked -> this folder |

```
npm test
```

Node 20+ (uses `node:test`). No dependencies.

## Design notes

`SPEC.md` carries the full spec, the decisions taken, and the phase plan. The
one-line version: *a seller's text narrows what an item might be; it does not
identify it* - so the code returns a confidence with every answer and enforces
the shopper's constraints only on what is actually known.
