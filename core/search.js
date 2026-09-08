// Building a Poshmark search URL. Shared by the popup and the brand-site
// bridge so the two can never disagree about what a search means.

// Poshmark's own category facet names, READ OFF ITS OWN LINKS rather than
// guessed - a wrong facet lands the shopper on an empty result page, which looks
// exactly like the extension being broken. Note the underscore-and-ampersand
// convention ("Jackets_&_Coats"), which is not something to invent.
/**
 * Our category -> Poshmark's category facet, PER DEPARTMENT.
 *
 * This used to be one flat table, and the names in it were read off Women's
 * category links and then sent for every department. Poshmark does not use the
 * same names: Men has "Pants" and "Shirts", not "Pants_&_Jumpsuits" and "Tops",
 * and has no Dresses at all. So a Men's search sent a facet that does not exist
 * and Poshmark ignored it - a "purple men's pants" search came back with caps
 * and a sweatshirt, entirely unfiltered, and had been doing so since 0.15.0.
 *
 * Harvested 2026-09-08 from Poshmark's own /category/<Department>-<Category>
 * links on Women-Tops, Men-Pants and Kids-Girls_Tops. A department we have not
 * read sends no facet at all rather than a plausible guess.
 */
export const POSH_CATEGORY = {
  Women: {
    tops: "Tops",
    dresses: "Dresses",
    outerwear: "Jackets_&_Coats",
    bottoms: "Pants_&_Jumpsuits",
    shoes: "Shoes",
  },
  Men: {
    tops: "Shirts",
    outerwear: "Jackets_&_Coats",
    bottoms: "Pants",
    shoes: "Shoes",
    // no dresses category exists in Men's - deliberately absent, not forgotten
  },
  Kids: {
    tops: "Shirts_&_Tops",
    dresses: "Dresses",
    outerwear: "Jackets_&_Coats",
    bottoms: "Bottoms",
    shoes: "Shoes",
  },
};

/** The facet for one department, or null when we have not verified one. */
export function facetFor(department, category) {
  const table = POSH_CATEGORY[department];
  return (table && table[category]) || null;
}

/** Other verified facets, for when the category list grows. */
export const POSH_FACETS_VERIFIED = [
  // Women (harvested from /category/Women-Tops)
  "Tops", "Dresses", "Jackets_&_Coats", "Pants_&_Jumpsuits", "Shoes", "Jeans",
  "Shorts", "Skirts", "Sweaters", "Swim", "Bags", "Accessories", "Jewelry",
  "Intimates_&_Sleepwear", "Handbags", "Makeup", "Hair", "Bath_&_Body", "Skincare",
  // Men (harvested from /category/Men-Pants, 2026-09-08)
  "Shirts", "Pants", "Suits_&_Blazers", "Underwear_&_Socks", "Grooming",
  // Kids (harvested from /category/Kids-Girls_Tops, 2026-09-08)
  "Shirts_&_Tops", "Bottoms", "Matching_Sets", "One_Pieces", "Pajamas", "Costumes",
];
export const DEPARTMENTS = ["Women", "Men", "Kids", "All"];

/** https://poshmark.com/search?query=...&department=...&category=... */
export function poshmarkSearchUrl({ query = "", department = "Women", category = "tops" } = {}) {
  const p = new URLSearchParams();
  p.set("query", String(query || "").trim());
  if (department && department !== "All") p.set("department", department);
  // "All" spans departments whose category names differ, so there is no single
  // correct facet to send. Sending one anyway is how the Men's bug happened.
  const cat = department && department !== "All" ? facetFor(department, category) : null;
  if (cat) p.set("category", cat);
  return "https://poshmark.com/search?" + p.toString();
}
