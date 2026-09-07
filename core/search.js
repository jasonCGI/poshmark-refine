// Building a Poshmark search URL. Shared by the popup and the brand-site
// bridge so the two can never disagree about what a search means.

// Poshmark's own category facet names, READ OFF ITS OWN LINKS rather than
// guessed - a wrong facet lands the shopper on an empty result page, which looks
// exactly like the extension being broken. Note the underscore-and-ampersand
// convention ("Jackets_&_Coats"), which is not something to invent.
export const POSH_CATEGORY = {
  tops: "Tops",
  dresses: "Dresses",
  outerwear: "Jackets_&_Coats",
  bottoms: "Pants_&_Jumpsuits",
  shoes: "Shoes",
};

/** Other verified facets, for when the category list grows. */
export const POSH_FACETS_VERIFIED = [
  "Tops", "Dresses", "Jackets_&_Coats", "Pants_&_Jumpsuits", "Shoes", "Jeans",
  "Shorts", "Skirts", "Sweaters", "Swim", "Bags", "Accessories", "Jewelry",
  "Intimates_&_Sleepwear",
];
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
