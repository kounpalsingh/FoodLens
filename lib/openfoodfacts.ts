// Open Food Facts: free, open product database with good German coverage.
// https://openfoodfacts.github.io/openfoodfacts-server/api/

type OffIngredient = { id?: string; text?: string; vegan?: string; vegetarian?: string; ingredients?: OffIngredient[] };

export type OffProduct = {
  name: string | null;
  nameEn: string | null;
  ingredientsText: string; // German if available
  ingredientsTextEn: string | null;
  analysisTags: string[]; // e.g. "en:vegetarian", "en:non-vegan", "en:vegetarian-status-unknown"
  tracesEn: string[]; // e.g. ["milk", "nuts"]
  /** Ingredients OFF's own parser flagged, by English name. */
  flagged: { nonVeg: string[]; egg: string[]; notVegan: string[] };
  imageUrl: string | null;
};

const enName = (id?: string) => (id?.startsWith("en:") ? id.slice(3).replace(/-/g, " ") : null);

function walk(list: OffIngredient[] | undefined, out: OffProduct["flagged"]) {
  for (const i of list ?? []) {
    const name = enName(i.id);
    if (name) {
      if (i.vegetarian === "no") out.nonVeg.push(name);
      else if (i.vegan === "no" && /\begg/.test(name)) out.egg.push(name);
      else if (i.vegan === "no") out.notVegan.push(name);
    }
    walk(i.ingredients, out);
  }
}

export async function lookupBarcode(code: string): Promise<OffProduct | null> {
  const fields = [
    "product_name",
    "product_name_de",
    "product_name_en",
    "brands",
    "ingredients_text",
    "ingredients_text_de",
    "ingredients_text_en",
    "ingredients_analysis_tags",
    "ingredients",
    "traces_tags",
    "image_front_small_url",
  ].join(",");

  const res = await fetch(
    `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${fields}`,
    {
      headers: { "User-Agent": "FoodLens/0.1 (prototype web app)" },
      cache: "no-store",
      signal: AbortSignal.timeout(5000) // short: the whole check must finish within the 30 s hosting limit,
    },
  );
  if (res.status === 404) return null; // product not in the database
  if (!res.ok) throw new Error(`Open Food Facts returned ${res.status}`);
  const body = await res.json();
  if (body.status !== 1 || !body.product) return null;

  const p = body.product;
  const brand = p.brands?.split(",")[0]?.trim();
  const join = (n?: string) => (n ? [brand, n].filter(Boolean).join(" – ") : null);
  const flagged: OffProduct["flagged"] = { nonVeg: [], egg: [], notVegan: [] };
  walk(p.ingredients, flagged);

  return {
    name: join(p.product_name_de || p.product_name),
    // Not shown: OFF's English product name is free-text anyone can edit, and it has contained
    // vandalism (e.g. barcode 40349558). The German name matches what's printed on the pack.
    nameEn: null,
    ingredientsText: p.ingredients_text_de || p.ingredients_text || p.ingredients_text_en || "",
    ingredientsTextEn: p.ingredients_text_en || null,
    analysisTags: p.ingredients_analysis_tags ?? [],
    tracesEn: (p.traces_tags ?? []).map((t: string) => t.replace(/^[a-z]{2}:/, "").replace(/-/g, " ")),
    flagged,
    imageUrl: p.image_front_small_url ?? null,
  };
}
