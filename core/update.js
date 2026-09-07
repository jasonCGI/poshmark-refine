// Update check.
//
// Chrome cannot auto-update an unpacked extension: auto-update needs the Web
// Store, or a CRX `update_url`, which Chrome blocks off-store on Windows without
// enterprise policy. So this does the useful half - it notices a newer version
// exists and tells the shopper the two steps - and never pretends to install
// anything itself.
//
// THIS IS THE ONLY PART OF THE EXTENSION THAT TALKS TO ANYTHING BUT POSHMARK, so
// it is OPT-IN and default OFF. It sends no user data: a plain GET for a version
// string, no query, no headers about you, no cookies (credentials omitted).

export const UPDATE_URL =
  "https://raw.githubusercontent.com/jasonCGI/poshmark-refine/main/manifest.json";
const DAY = 24 * 60 * 60 * 1000;

/**
 * Compare two dotted versions. Returns 1 if a > b, -1 if a < b, 0 if equal.
 * Missing parts count as 0, so "0.9" and "0.9.0" are the same version.
 */
export function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** Is `latest` newer than `current`? */
export const isNewer = (latest, current) => compareVersions(latest, current) > 0;

/**
 * Should we ask the network at all? Only when the shopper turned it on, and at
 * most once a day - a version string does not change often enough to justify
 * more, and a quiet extension is the point.
 */
export function shouldCheck({ enabled, lastCheck }, now = Date.now()) {
  if (!enabled) return false;
  return !lastCheck || now - lastCheck >= DAY;
}

/**
 * Fetch the published version. Returns null on any failure - an update check is
 * a convenience and must never surface an error at the shopper, let alone break
 * the popup.
 */
export async function fetchLatestVersion(fetchImpl = fetch, url = UPDATE_URL) {
  try {
    const res = await fetchImpl(url, { credentials: "omit", cache: "no-cache" });
    if (!res || !res.ok) return null;
    const text = await res.text();
    const m = text.match(/"version"\s*:\s*"([0-9.]+)"/);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}
