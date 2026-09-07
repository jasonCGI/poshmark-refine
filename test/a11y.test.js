// Accessibility regression guards.
//
// The badge shipped with `color: #fff` hardcoded while its background tokens
// flipped to light pastels under prefers-color-scheme: dark. White on #7fce97
// measures 1.88:1 where 11px bold text needs 4.5. It passed in light mode, on
// the machine it was written on, which is exactly how contrast bugs survive.
//
// So the stylesheet is parsed and the ratios are computed here, in both modes.
// A future token change that breaks contrast fails the build instead of
// shipping.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../extension/content.css", import.meta.url), "utf8");

const expand = (h) => {
  const x = h.replace("#", "").trim();
  return x.length === 3 ? x.split("").map((c) => c + c).join("") : x;
};
const luminance = (hex) => {
  const c = expand(hex).match(/../g).map((v) => parseInt(v, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

/**
 * Read the custom properties as they resolve in one mode. Light is whatever
 * :root declares; dark is that, overridden by the dark media block - the same
 * order the cascade applies.
 */
function tokens(mode) {
  const out = {};
  const take = (css) => {
    for (const [, name, value] of css.matchAll(/(--pmr-[\w-]+)\s*:\s*([^;]+);/g)) {
      const v = value.trim();
      if (v.startsWith("#")) out[name] = v;
    }
  };
  take(CSS.split("@media")[0]);
  if (mode === "dark") {
    const m = CSS.match(/@media \(prefers-color-scheme: dark\)\s*\{([\s\S]*?)\n\}/);
    if (m) take(m[1]);
  }
  return out;
}

test("the stylesheet really does define both themes", () => {
  const light = tokens("light"), dark = tokens("dark");
  for (const t of ["--pmr-match", "--pmr-check", "--pmr-off", "--pmr-on-badge"]) {
    assert.ok(light[t], t + " missing from :root");
    assert.ok(dark[t], t + " is never redefined for dark mode");
    assert.notEqual(light[t], dark[t], t + " is identical in both themes, which is suspicious");
  }
});

test("badge text clears WCAG AA in BOTH themes", () => {
  // 11px bold is not "large text" (that needs 18.66px bold), so the bar is 4.5.
  for (const mode of ["light", "dark"]) {
    const t = tokens(mode);
    for (const state of ["--pmr-match", "--pmr-check", "--pmr-off"]) {
      const r = ratio(t["--pmr-on-badge"], t[state]);
      assert.ok(r >= 4.5,
        `${mode} badge ${state}: ${t["--pmr-on-badge"]} on ${t[state]} = ${r.toFixed(2)}:1, needs 4.5`);
    }
  }
});

test("reason-strip text clears AA in both themes", () => {
  const pairs = [["--pmr-ink", "--pmr-match-bg"], ["--pmr-muted", "--pmr-check-bg"], ["--pmr-off", "--pmr-off-bg"]];
  for (const mode of ["light", "dark"]) {
    const t = tokens(mode);
    for (const [fg, bg] of pairs) {
      const r = ratio(t[fg], t[bg]);
      assert.ok(r >= 4.5, `${mode} strip ${fg} on ${bg} = ${r.toFixed(2)}:1, needs 4.5`);
    }
  }
});

test("the badge is reachable and announced, not just clickable", () => {
  const js = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
  assert.match(js, /setAttribute\("role", "button"\)/, "a span with a click handler is not a button");
  assert.match(js, /setAttribute\("tabindex", "0"\)/, "keyboard users could not reach the correction popover");
  assert.match(js, /"Enter" \|\| e\.key === " "/, "Enter and Space must both activate it");
  assert.match(js, /aria-label/, "the badge needs a name");
});

test("the correction popover can be escaped, and gives focus back", () => {
  const js = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
  assert.match(js, /role", "dialog/, "an unnamed dialog is announced as nothing");
  assert.match(js, /e\.key !== "Escape"/, "Escape must close it");
  // every exit path, not only the one that remembered
  assert.equal((js.match(/closeCorrect\(true\)/g) || []).length, 3,
    "Escape, Cancel and Save must all restore focus");
});

test("animation is behind prefers-reduced-motion", () => {
  assert.match(CSS, /@media \(prefers-reduced-motion: no-preference\)/,
    "transitions must be opt-in, not opt-out");
});

test("injected controls have a visible focus ring", () => {
  assert.match(CSS, /\.pmr-badge:focus-visible/, "a focus you cannot see is not keyboard support");
  assert.match(CSS, /#pmr-correct button:focus-visible/);
});

test("the update bar offers an action, not just a way to hide it", () => {
  const html = readFileSync(new URL("../extension/popup.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../extension/popup.js", import.meta.url), "utf8");
  assert.match(html, /id="upreload"/, "a notice you can only dismiss is a notice that wastes a click");
  assert.match(js, /chrome\.runtime\.reload\(\)/, "the reload button must actually reload");
  // "x" is not a name
  assert.match(html, /id="updismiss"[^>]*aria-label=/, "the dismiss control needs an accessible name");
  assert.match(html, /id="upbar" role="status"/, "the bar appears after load, so it has to announce itself");
});

// --- Codex review 2026-09-08, accessibility findings ----------------------

test("F8: the focus ring is not painted in the colour behind it", () => {
  // The dark override set outline-color to --pmr-paper, which is also the
  // correction popover's background: a 3px ring at 1:1 contrast.
  const dark = CSS.match(/@media \(prefers-color-scheme: dark\)[\s\S]*?\n\}/g) || [];
  for (const block of dark) {
    assert.ok(!/outline-color:\s*var\(--pmr-paper\)/.test(block),
      "the focus ring must not be the popover's own background colour");
  }
  const t = tokens("dark");
  assert.ok(ratio(t["--pmr-ink"], t["--pmr-paper"]) >= 4.5, "ink on paper is a visible ring in dark mode");
  assert.match(CSS, /\.pmr-badge:focus-visible \{ box-shadow/,
    "over an arbitrary photo one tone is not enough - the badge needs a second");
});

test("the dim/hide fade never composites our own annotations", () => {
  // A single opacity on the tile faded the badge with the card: the Check
  // badge measured 2.41:1, and the badge is what a dimmed card asks you to read.
  assert.ok(!/\.tile-grid-redesign\.pmr-dim \{ opacity/.test(CSS),
    "the fade must not be applied to the whole tile");
  assert.match(CSS, /\.pmr-anchor > \*:not\(\.pmr-badge\)/,
    "the badge has to sit outside the faded subtree, since a child cannot undo a parent's opacity");
});

test("F9: re-sorting puts focus and selection back", () => {
  const grid = readFileSync(new URL("../core/grid.js", import.meta.url), "utf8");
  assert.match(grid, /activeElement/, "re-appending a node blurs what is inside it");
  assert.match(grid, /setSelectionRange/, "a half-typed correction should survive a reorder");
  assert.match(grid, /preventScroll: true/, "restoring focus must not yank the page");
});

test("F10: the bridge modules are served at a rotating URL", () => {
  const m = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const war = m.web_accessible_resources.find((w) => w.resources.includes("core/brand.js"));
  assert.equal(war.matches[0], "https://*/*", "a shopper's host cannot be known at build time");
  assert.equal(war.use_dynamic_url, true,
    "without this, any HTTPS page can probe a predictable extension-ID URL and detect the install");
});
