# Codex Review Brief - fixes for your 2026-09-07 findings

You are Codex, the independent reviewer. Verify the fixes, do NOT re-implement, do NOT merge.
Scoped to the commit after `65f5d4a` (v0.7.0), which addresses all four findings.

## Setup
- Repo `github.com/jasonCGI/poshmark-refine`, working copy `Z:\Job_Applications\poshmark-refine`.
- `node --test` from the root. Expect **29 pass, 0 fail**.

## Your four findings and the fix
- **P1 (Tier-3 did not re-sort or refresh the HUD)** - `extension/content.js`, end of `hoverRead()`.
  It called `judge(tile)` only. It now calls `apply()`, the same grid-level reconciliation used
  everywhere else, so a hover that moves a card DIM -> SHOW/HIDE also re-sorts its wrapper and
  re-counts the HUD. `apply()` is re-entrancy guarded and `resort()` no-ops on an unchanged
  order, so a hover that does not change the verdict costs one comparison pass.
- **P2 (only the first grid processed)** - `findGrid()` is replaced by `findGrids()`. It walks up
  from EVERY tile to that tile's nearest ancestor holding >1 tile, collects the distinct set, then
  keeps only innermost containers (`!all.some(o => o !== g && g.contains(o))`) so a wrapper that
  contains both sections is not returned in their place. `apply()` loops all grids; `updateHud()`
  and the `pmr:status` responder share a new `countStates(grids)` that tallies across all of them;
  the convergence check is now document-wide (`document.querySelector(tile:not([data-pmr-seen]))`).
- **P2 (in-place card reuse invisible)** - the observer now also watches `characterData` and the
  `href` attribute (`observeOpts`). `judge()` records `data-pmr-sig` = title|size|link-path. On a
  non-childList mutation the callback finds the enclosing tile and, if its current signature no
  longer matches `data-pmr-sig`, DELETES `data-pmr-seen` and schedules a pass, so the reused card
  is re-judged instead of keeping the previous listing's verdict and hover path. Our own writes
  are excluded by `isOurs()` (target inside `.pmr-strip`, `.pmr-badge` or `#pmr-hud`), which is
  what keeps this from re-entering the loop you cleared.
- **P2 (fresh-read merge still lost concurrent edits)** - both `popup.js` and `options.js` now
  track what THEY actually edited: `touchedSizes` (a `person::category` set, added only when the
  value really changes), `touchedFields` (scalar names, marked from the edit handlers), and in
  options a `structural` flag for person add/remove/rename. Save reads fresh, copies the stored
  record, applies ONLY touched scalars, and merges profiles per person+category via
  `mergeProfiles()`; a structural change takes our whole `profiles` because a key-by-key merge of
  a rename is not coherent. Both pages also listen to `chrome.storage.onChanged` and adopt the
  other surface's record when they have no unsaved edits (`isClean()`), which closes the staleness
  window rather than only surviving it.

## Verify
- **P1.** Confirm the hover path cannot re-enter `apply()` badly: `hoverRead` is async and fires on
  mouseover, so `apply()` may be running - the `applying` guard drops that call. Is dropping it
  acceptable given the convergence pass and the next mutation, or do you want the hover result
  queued instead?
- **P2 grids.** Is the innermost-container filter right when two grids are siblings inside a common
  parent that also holds >1 tile? When a grid holds exactly one tile (the walk climbs past it)?
  Does `wrapperOf(tile, grid)` still hold for every returned grid?
- **P2 reuse.** Does `isOurs()` cover every element we write? We set `strip.textContent`,
  `badge.textContent`, `tile.classList`, `tile.dataset.*` and the HUD. classList/dataset are
  attributes and `attributeFilter: ["href"]` excludes them - confirm. Can a signature change be
  missed because Poshmark swaps the whole subtree (childList on the tile) rather than text?
- **P2 merge.** Walk your own scenario: open Options, change nothing; save a size in Popup; save
  Options. Options has `touchedFields` empty and `touchedSizes` empty, so it now writes stored
  values back and `mergeProfiles` returns the STORED profiles - the popup's size survives. Confirm.
  Then the harder one: both pages dirty on the same `person::category`. Last writer wins on that
  one key only - acceptable, or do you want a timestamp/version guard?

## Verification
```
node --test                     # expect 29 pass, 0 fail
node --check extension/content.js && node --check extension/popup.js && node --check extension/options.js
node -e "const m=require('./manifest.json');const fs=require('fs');for(const p of [...m.content_scripts.flatMap(c=>[...c.js,...c.css]),...m.web_accessible_resources.flatMap(w=>w.resources),m.options_ui.page,m.background.service_worker,m.action.default_popup]) if(!fs.existsSync(p)) throw new Error('missing '+p); console.log('manifest ok', m.version)"
# live: load unpacked from the repo ROOT; confirm the tab stays responsive, text stays
# selectable, infinite scroll keeps judging, and a hover that resolves a colour re-sorts.
```
Report findings by severity with file:line; leave merging to Jason.
