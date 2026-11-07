// Find a product by name in Open Food Facts (search.openfoodfacts.org, a fast full-text index).
// Results are ranked so products sold in Germany and products with an ingredient list come first.

export type ProductMatch = {
  code: string;
  name: string;
  brand: string | null;
  quantity: string | null;
  imageUrl: string | null;
  hasIngredients: boolean;
  inGermany: boolean;
};

type Hit = {
  code?: string;
  product_name?: string;
  product_name_de?: string;
  brands?: string | string[];
  quantity?: string;
  image_front_small_url?: string;
  countries_tags?: string[];
  states_tags?: string[];
  unique_scans_n?: number;
};

const FIELDS = "code,product_name,product_name_de,brands,quantity,image_front_small_url,countries_tags,states_tags,unique_scans_n";

export async function searchProducts(query: string, limit = 6): Promise<ProductMatch[]> {
  const url = `https://search.openfoodfacts.org/search?q=${encodeURIComponent(query)}&page_size=24&langs=de,en&fields=${FIELDS}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "FoodLens/0.1 (prototype web app)" },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Open Food Facts search returned ${res.status}`);
  const body = (await res.json()) as { hits?: Hit[] };

  const seen = new Set<string>();
  const scored = (body.hits ?? [])
    .map((h, i) => {
      const name = (h.product_name_de || h.product_name || "").trim();
      const code = (h.code || "").trim();
      if (!name || !/^\d{6,14}$/.test(code) || seen.has(code)) return null;
      seen.add(code);
      const brand = (Array.isArray(h.brands) ? h.brands[0] : h.brands?.split(",")[0])?.trim() || null;
      const hasIngredients = (h.states_tags ?? []).includes("en:ingredients-completed");
      const inGermany = (h.countries_tags ?? []).includes("en:germany");
      // The search's own relevance order counts most; then an ingredient list, sold in Germany, popularity.
      const score = -i * 1 + (hasIngredients ? 2 : 0) + (inGermany ? 1.5 : 0) + Math.log10(1 + (h.unique_scans_n ?? 0)) * 0.3;
      const match: ProductMatch = {
        code,
        name,
        brand,
        quantity: h.quantity?.trim() || null,
        imageUrl: h.image_front_small_url || null,
        hasIngredients,
        inGermany,
      };
      return { match, score };
    })
    .filter((x): x is { match: ProductMatch; score: number } => x !== null)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((x) => x.match);
}
