// Building a Poshmark search URL. Shared by the popup and the brand-site
// bridge so the two can never disagree about what a search means.

// Only categories whose Poshmark facet name we have actually verified are sent.
// For the rest the query does the work, because a wrong facet lands the shopper
// on an empty result page, which looks like the extension is broken.
export const POSH_CATEGORY = { tops: "Tops", dresses: "Dresses" };
export const DEPARTMENTS = ["Women", "Men", "Kids", "All"];

/** https://poshmark.com/search?query=...&department=...&category=... */
export function poshmarkSearchUrl({ query = "", department = "Women", category = "tops" } = {}) {
  const p = new URLSearchParams();
  p.set("query", String(query || "").trim());
  if (department && department !== "All") p.set("department", department);
  const cat = POSH_CATEGORY[category];
  if (cat) p.set("category", cat);
  return "https://poshmark.com/search?" + p.toString();
}
