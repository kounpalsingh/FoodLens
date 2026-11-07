// Open Food Facts: free, open product database with good German coverage.
// https://openfoodfacts.github.io/openfoodfacts-server/api/
import { fromOpenFoodFacts, type Nutrition } from "./nutrition";

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
  /** Certified or printed claims on the pack, from Open Food Facts' labels (e.g. V-Label vegan). */
  labels: { vegan: boolean; vegetarian: boolean };
  nutrition: Nutrition | null;
  imageUrl: string | null;
  /** Quality signals printed on the pack or computed by Open Food Facts; used to rank recommendations. */
  quality: Quality;
};

export type Quality = {
  organic: boolean; // Bio / EU organic / Bioland / Demeter / Naturland
  gmoFree: boolean; // "Ohne Gentechnik"
  /** German animal-welfare level for milk, meat and eggs (Haltungsform 1-4), when printed. */
  welfare: number | null;
  /** NOVA processing group: 1 unprocessed … 4 ultra-processed. */
  nova: number | null;
};

/** Read quality labels from Open Food Facts label tags (they mix en:/de: and spellings, so match loosely). */
export function qualityFromLabels(labels: string[], nova?: number | string | null): Quality {
  const tags = labels.map((t) => t.toLowerCase());
  const organic = tags.some((t) => /(^|:)(organic|eu-organic|bio|bio-siegel|de-bio-siegel|bioland|demeter|naturland|biokreis|de-oko-\d+)$/.test(t) || /eg-öko|eu-öko|bio-siegel/.test(t));
  const gmoFree = organic || tags.some((t) => /no-gmos|ohne-?gentechnik|ohnegentechnik|vlog/.test(t));
  let welfare: number | null = null;
  for (const t of tags) {
    const m = t.match(/haltungsform-?(\d)/) ?? t.match(/tierwohl[^0-9]*(\d)/);
    if (m) welfare = Math.max(welfare ?? 0, Math.min(4, Number(m[1])));
  }
  const n = Number(nova);
  return { organic, gmoFree, welfare, nova: n >= 1 && n <= 4 ? n : null };
}

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

const FIELDS = [
  "code",
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
  "labels_tags",
  "nutriscore_grade",
  "nutriments",
  "nutrient_levels",
  "categories_tags",
  "image_front_small_url",
  "nova_group",
].join(",");

const HEADERS = { "User-Agent": "FoodLens/0.1 (prototype web app)" };

// Open Food Facts limits how often one server may ask (it answers 429 when asked too often),
// so products already looked up are kept for 6 hours (labels and ingredients rarely change).
const CACHE_MS = 6 * 60 * 60_000;
const cache = new Map<string, { at: number; product: OffProduct | null }>();
function cached(code: string): OffProduct | null | undefined {
  const hit = cache.get(code);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_MS) {
    cache.delete(code);
    return undefined;
  }
  return hit.product;
}
function remember(code: string, product: OffProduct | null) {
  if (cache.size > 1000) cache.delete(cache.keys().next().value!);
  cache.set(code, { at: Date.now(), product });
}

export async function lookupBarcode(code: string): Promise<OffProduct | null> {
  const hit = cached(code);
  if (hit !== undefined) return hit;
  const get = () =>
    fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${FIELDS}`, {
      headers: HEADERS,
      cache: "no-store",
      signal: AbortSignal.timeout(5000), // short: the whole check must finish within the 30 s hosting limit
    });
  let res = await get();
  // Busy (rate limit): one short retry, since the limit is per minute.
  if (res.status === 429 || res.status === 503) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await get();
  }
  if (res.status === 404) {
    remember(code, null);
    return null; // product not in the database
  }
  if (res.status === 429 || res.status === 503) throw Object.assign(new Error("Open Food Facts is busy"), { busy: true });
  if (!res.ok) throw new Error(`Open Food Facts returned ${res.status}`);
  const body = await res.json();
  const product = body.status === 1 && body.product ? toOffProduct(body.product) : null;
  remember(code, product);
  return product;
}

/**
 * Look up many barcodes in one request (used by recommendations), instead of one request each,
 * which Open Food Facts would soon refuse. Codes it doesn't know are missing from the result.
 * complete is false when Open Food Facts was busy and only some of the codes could be looked up.
 */
export async function lookupMany(codes: string[]): Promise<{ products: Map<string, OffProduct>; complete: boolean }> {
  const out = new Map<string, OffProduct>();
  const missing: string[] = [];
  for (const c of codes) {
    const hit = cached(c);
    if (hit) out.set(c, hit);
    else if (hit === undefined) missing.push(c);
  }
  if (!missing.length) return { products: out, complete: true };
  const res = await fetch(
    `https://world.openfoodfacts.org/api/v2/search?code=${missing.map(encodeURIComponent).join(",")}&fields=${FIELDS}&page_size=${missing.length}`,
    { headers: HEADERS, cache: "no-store", signal: AbortSignal.timeout(10000) },
  ).catch(() => null);
  if (res?.ok) {
    const body = (await res.json()) as { products?: (Record<string, unknown> & { code?: string })[] };
    const found = new Set<string>();
    for (const p of body.products ?? []) {
      if (!p.code) continue;
      const product = toOffProduct(p);
      remember(p.code, product);
      out.set(p.code, product);
      found.add(p.code);
    }
    for (const c of missing) if (!found.has(c)) remember(c, null);
    return { products: out, complete: true };
  }

  // The bulk search has a tighter limit (about 10 a minute; it answers 429 or 503 when used up).
  // Fall back to single product lookups, a few at a time, for at most ~8 seconds.
  const until = Date.now() + 8000;
  let failed = 0;
  let tried = 0;
  for (let i = 0; i < missing.length && Date.now() < until; i += 4) {
    const batch = missing.slice(i, i + 4);
    tried += batch.length;
    let batchFailed = 0;
    await Promise.all(
      batch.map((c) =>
        lookupBarcode(c).then(
          (p) => p && out.set(c, p),
          () => batchFailed++,
        ),
      ),
    );
    failed += batchFailed;
    if (batchFailed === batch.length) break; // refused every time: stop asking
  }
  if (!out.size && failed > 0) throw new Error("Open Food Facts is busy or getting too many requests from Food Lens. Try again in a minute.");
  return { products: out, complete: failed === 0 && tried === missing.length };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toOffProduct(p: any): OffProduct {
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
    nutrition: fromOpenFoodFacts(p),
    labels: {
      vegan: (p.labels_tags ?? []).some((t: string) => /vegan/.test(t) && !/non-vegan|not-vegan/.test(t)),
      vegetarian: (p.labels_tags ?? []).some((t: string) => /vegan|vegetarian/.test(t) && !/non-veg|not-veg/.test(t)),
    },
    imageUrl: p.image_front_small_url ?? null,
    quality: qualityFromLabels(p.labels_tags ?? [], p.nova_group),
  };
}
