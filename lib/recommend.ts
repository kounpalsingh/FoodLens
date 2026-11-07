// "Best milk at Lidl": find a store's own-brand products of one type in Open Food Facts,
// check each one with the same rules as a barcode check, and rank them by quality.
// Prices are left out for now: Open Food Facts' price data covers too few German products.
import storesData from "../data/stores.json";
import typesData from "../data/product-types.json";
import { runCheck, type CheckResult } from "./check";
import { lookupMany } from "./openfoodfacts";
import type { Category } from "./rules";

export type Diet = "any" | "egg" | "veg" | "vegan";
export type Store = { id: string; label: string; names: string[]; brands: string[] };
export type ProductType = {
  label: string;
  category: string;
  /** Sub-categories to leave out, e.g. quark and skyr when someone asks for cheese. */
  exclude?: string[];
  /** Words in a product name that mean it isn't this type, for products filed in the wrong category. */
  excludeNames?: string[];
  /** For a vegan, "milk" means plant milk: the type to search instead. */
  veganSwap?: string;
  words: string[];
};

export const STORES = storesData.stores as Store[];
export const PRODUCT_TYPES = typesData.types as ProductType[];

/** Which categories each diet accepts. "egg" = eats egg but no meat or fish. */
const ALLOWED: Record<Diet, Category[]> = {
  any: ["vegan", "veg", "egg", "non_veg", "unclear"],
  egg: ["vegan", "veg", "egg"],
  veg: ["vegan", "veg"],
  vegan: ["vegan"],
};

const DIET_WORDS: [Diet, RegExp][] = [
  ["egg", /\b(eggetarian|egg ok|eggs? ok|with eggs? allowed)\b/],
  ["vegan", /\bvegan(e|er|es)?\b/],
  ["veg", /\b(vegetarian|vegetarisch(e|er|es)?|veggie|veg)\b/],
];

// Words that say nothing about the product: left out before matching and before a free-text search.
const FILLER = new Set(
  "best beste bester bestes good gute guter gutes top healthy healthiest gesund gesunde gesündeste quality qualität at in bei im am from von vom the a an der die das den dem ein eine einen for für and und or oder with mit show me find finde zeig zeige suggest recommend empfehle which welche what was please bitte buy kaufen get i want ich möchte suche looking ok".split(" "),
);

/** Edit distance with swapped neighbours counted as one edit ("choclate" → "chocolate" is 1). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Typos allowed for a word of this length: none for short words, where a typo is usually another word. */
const allowedTypos = (len: number) => (len >= 10 ? 2 : len >= 6 ? 1 : 0);

/**
 * How well a known phrase (e.g. "dark chocolate") matches somewhere in the typed words.
 * Exact or word-start matches ("milks" for "milk") beat matches with a typo. Returns the matched word positions.
 */
function findPhrase(tokens: string[], phrase: string): { at: number[]; typos: number } | null {
  const whole = phrase.startsWith("=");
  const parts = phrase.replace(/^=/, "").split(" ");
  let best: { at: number[]; typos: number } | null = null;
  for (let i = 0; i + parts.length <= tokens.length; i++) {
    let typos = 0;
    let ok = true;
    for (let k = 0; k < parts.length && ok; k++) {
      const t = tokens[i + k];
      const p = parts[k];
      if (t === p) continue;
      // Word start: "milks", "Schokoladen"; and compound words ending in the phrase are not taken ("kakaobutter" ≠ "butter").
      if (!whole && t.startsWith(p) && p.length >= 3 && t.length - p.length <= 3) continue;
      const dist = editDistance(t, p);
      if (dist <= allowedTypos(p.length)) typos += dist;
      else ok = false;
    }
    if (ok && (!best || typos < best.typos)) best = { at: parts.map((_, k) => i + k), typos };
  }
  return best;
}

/** Turn "best vegan yoghurt at Aldi" into store, product type and diet. No AI: word matching that tolerates typos. */
export function parseRequest(query: string): { store: Store | null; type: ProductType | null; diet: Diet | null; rest: string } {
  const tokens = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\- ]+/gu, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^-+|-+$/g, "").slice(0, 40))
    .filter(Boolean);
  const used = new Set<number>();

  // Store: the longest name that matches ("aldi süd" before "aldi").
  let store: Store | null = null;
  const storeNames = STORES.flatMap((s) => s.names.map((n) => ({ s, n }))).sort((a, b) => b.n.length - a.n.length);
  let storeHit: { s: Store; at: number[]; typos: number } | null = null;
  for (const { s, n } of storeNames) {
    const m = findPhrase(tokens, `=${n}`);
    if (m && (!storeHit || m.typos < storeHit.typos)) storeHit = { s, ...m };
    if (storeHit?.typos === 0) break;
  }
  if (storeHit) {
    store = storeHit.s;
    storeHit.at.forEach((i) => used.add(i));
  }

  const free = tokens.map((t, i) => (used.has(i) ? "" : t));

  // Product: the longest known phrase wins ("dark chocolate" over "chocolate"); with equal length, fewer typos.
  let type: ProductType | null = null;
  let typeHit: { at: number[]; typos: number; len: number } | null = null;
  for (const t of PRODUCT_TYPES) {
    for (const w of t.words) {
      const m = findPhrase(free, w);
      if (!m) continue;
      const len = w.replace(/^=/, "").length;
      if (!typeHit || len > typeHit.len || (len === typeHit.len && m.typos < typeHit.typos)) {
        type = t;
        typeHit = { ...m, len };
      }
    }
  }
  typeHit?.at.forEach((i) => used.add(i));

  const text = ` ${tokens.join(" ")} `;
  let diet: Diet | null = null;
  for (const [d, re] of DIET_WORDS) if (re.test(text)) { diet = d; break; }
  // "vegan cheese" etc. already means vegan.
  if (!diet && type && /^vegan /.test(type.label)) diet = "vegan";

  // What's left, for a free-text search when no product type matched ("Erdnüsse bei Kaufland").
  const rest = tokens
    .filter((t, i) => !used.has(i) && !FILLER.has(t) && !DIET_WORDS.some(([, re]) => re.test(` ${t} `)))
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter((t) => t.length >= 2)
    .slice(0, 6)
    .join(" ");
  return { store, type, diet, rest };
}

export type Recommendation = {
  code: string;
  name: string;
  brand: string | null;
  quantity: string | null;
  imageUrl: string | null;
  category: Category;
  confidence: number;
  score: number;
  nutriScore: string | null;
  /** Short positive points, e.g. "Nutri-Score A", "Organic (Bio)". */
  good: string[];
  /** Short drawbacks, e.g. "Ultra-processed (NOVA 4)". */
  bad: string[];
};

export type RecommendResult = {
  interpreted: { product: string | null; store: string | null; diet: Diet };
  items: Recommendation[];
  checked: number;
  note: string;
};

export class RecommendError extends Error {}

type Hit = {
  code?: string;
  product_name?: string;
  product_name_de?: string;
  brands?: string | string[];
  brands_tags?: string[];
  quantity?: string;
  image_front_small_url?: string;
  nutriscore_grade?: string;
  states_tags?: string[];
  unique_scans_n?: number;
};

const FIELDS = "code,product_name,product_name_de,brands,brands_tags,quantity,image_front_small_url,nutriscore_grade,states_tags,unique_scans_n";
const NS_POINTS: Record<string, number> = { a: 5, b: 4, c: 3, d: 2, e: 1 };

// The same request within an hour reuses the search result (fewer calls to Open Food Facts).
const searchCache = new Map<string, { at: number; hits: Hit[] }>();

async function candidates(type: ProductType, store: Store | null): Promise<Hit[]> {
  // A known type searches by category; anything else by the words typed (all of them must appear).
  const what = type.category ? [`categories_tags:"${type.category}"`] : type.label
        .split(" ")
        // Letters and digits only: quotes, brackets or a leading "-" would change the search's meaning.
        .map((w) => w.replace(/[^\p{L}\p{N}]+/gu, ""))
        .filter(Boolean);
  const parts = [...what, `countries_tags:"en:germany"`, ...(type.exclude ?? []).map((c) => `-categories_tags:"${c}"`)];
  if (store) parts.push(`(${store.brands.map((b) => `brands_tags:"${b}"`).join(" OR ")})`);
  const url = `https://search.openfoodfacts.org/search?q=${encodeURIComponent(parts.join(" "))}&page_size=60&langs=de,en&fields=${FIELDS}`;
  const hit = searchCache.get(url);
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.hits;
  const res = await fetch(url, {
    headers: { "User-Agent": "FoodLens/0.1 (prototype web app)" },
    cache: "no-store",
    signal: AbortSignal.timeout(9000),
  });
  if (res.status === 429) throw new RecommendError("Open Food Facts is getting too many requests from Food Lens. Try again in a minute.");
  if (!res.ok) throw new RecommendError("Couldn't reach Open Food Facts to search. Try again in a minute.");
  const hits = ((await res.json()) as { hits?: Hit[] }).hits ?? [];
  if (searchCache.size > 300) searchCache.delete(searchCache.keys().next().value!);
  searchCache.set(url, { at: Date.now(), hits });
  return hits;
}

/** Quality score: higher is better. Every point added or taken away is shown to the user as a reason. */
export function scoreProduct(r: CheckResult): { score: number; good: string[]; bad: string[] } {
  const good: string[] = [];
  const bad: string[] = [];
  let score = 0;

  const ns = r.nutrition?.nutriScore?.toLowerCase() ?? null;
  if (ns && NS_POINTS[ns]) {
    score += NS_POINTS[ns] * 2;
    (NS_POINTS[ns] >= 4 ? good : NS_POINTS[ns] <= 2 ? bad : good).push(`Nutri-Score ${ns.toUpperCase()}`);
  } else {
    score += 5; // unknown: treat as middling (C)
  }

  const q = r.quality;
  if (q?.organic) { score += 2; good.push("Organic (Bio)"); }
  else if (q?.gmoFree) { score += 1; good.push("Ohne Gentechnik (GMO-free)"); }
  if (q?.welfare) {
    if (q.welfare >= 3) { score += q.welfare === 4 ? 1.5 : 1; good.push(`Animal welfare: Haltungsform ${q.welfare}`); }
    else bad.push(`Animal welfare: Haltungsform ${q.welfare}`);
  }
  if (q?.nova === 1) { score += 2; good.push("Unprocessed (NOVA 1)"); }
  else if (q?.nova === 2) score += 1;
  else if (q?.nova === 4) { score -= 2; bad.push("Ultra-processed (NOVA 4)"); }

  const high = Object.entries(r.nutrition?.levels ?? {}).filter(([, v]) => v === "high").map(([k]) => k);
  if (!ns && high.length) { score -= high.length; bad.push(`High in ${high.map((k) => (k === "saturatedFat" ? "saturated fat" : k)).join(", ")}`); }

  const unknownAdditives = r.additives.filter((a) => a.status === "unknown");
  if (unknownAdditives.length) {
    score -= Math.min(2, unknownAdditives.length);
    bad.push(`Source unknown: ${unknownAdditives.map((a) => a.code).join(", ")}`);
  }
  if (r.category === "unclear") { score -= 1; bad.push("Diet status unclear"); }

  return { score: Math.round(score * 10) / 10, good, bad };
}

export async function recommend(input: { query?: string; store?: string; product?: string; diet?: Diet }): Promise<RecommendResult> {
  const parsed = parseRequest([input.query, input.product].filter(Boolean).join(" "));
  // The store menu wins over the text; an unknown store id is ignored.
  const store = (input.store && STORES.find((s) => s.id === input.store)) || parsed.store;
  const diet: Diet = input.diet && input.diet !== "any" ? input.diet : parsed.diet ?? "any";
  const type = diet === "vegan" && parsed.type?.veganSwap ? PRODUCT_TYPES.find((t) => t.label === parsed.type!.veganSwap) ?? parsed.type : parsed.type;

  // Not a known product type: search the remaining words as free text instead.
  const searchFor: ProductType | null = type ?? (parsed.rest.length >= 3 ? { label: parsed.rest, category: "", words: [] } : null);
  if (!searchFor) {
    throw new RecommendError(`Tell me what product you're looking for, e.g. "best milk at Lidl" or "vegan yoghurt at Aldi".`);
  }

  const hits = await candidates(searchFor, store);
  // Pre-rank before the (slower) full checks: ingredient list present, good Nutri-Score, popular.
  // Open Food Facts entries sometimes list two stores' brands (e.g. Lidl's Milbona and "Aldi"): skip those.
  const otherBrands = new Set(
    store ? STORES.filter((s) => s.id !== store.id).flatMap((s) => s.brands).filter((b) => !store.brands.includes(b)) : [],
  );
  const seenCode = new Set<string>();
  const pre = hits
    .filter((h) => !(h.brands_tags ?? []).some((b) => otherBrands.has(b)))
    .filter((h) => !(searchFor.excludeNames ?? []).some((w) => (h.product_name_de || h.product_name || "").toLowerCase().includes(w)))
    .filter((h) => /^\d{6,14}$/.test(h.code ?? "") && (h.product_name_de || h.product_name) && !seenCode.has(h.code!) && seenCode.add(h.code!))
    .map((h) => ({
      h,
      pre:
        ((h.states_tags ?? []).includes("en:ingredients-completed") ? 4 : 0) +
        (NS_POINTS[h.nutriscore_grade ?? ""] ?? 2.5) +
        Math.log10(1 + (h.unique_scans_n ?? 0)),
    }))
    .sort((a, b) => b.pre - a.pre)
    .slice(0, 16)
    .map((x) => x.h);

  // One request for all candidates; then the same rules as a barcode check, with no further lookups.
  const { products, complete } = await lookupMany(pre.map((h) => h.code!)).catch((e: Error) => {
    throw new RecommendError(e.message.startsWith("Open Food Facts is") ? e.message : "Couldn't reach Open Food Facts. Try again in a minute.");
  });
  const checked = await Promise.all(
    pre.map(async (h) => {
      try {
        return { h, r: await runCheck({ barcode: h.code!, preloaded: products.get(h.code!) ?? null }) };
      } catch {
        return null; // no ingredient list: can't vouch for it
      }
    }),
  );

  const allowed = ALLOWED[diet];
  const seenName = new Set<string>();
  const ranked = checked
    .filter((x): x is { h: Hit; r: CheckResult } => x !== null)
    .filter((x) => allowed.includes(x.r.category))
    .map(({ h, r }) => {
      const s = scoreProduct(r);
      const brand = (Array.isArray(h.brands) ? h.brands[0] : h.brands?.split(",")[0])?.trim() || null;
      const item: Recommendation = {
        code: h.code!,
        name: (h.product_name_de || h.product_name || "").trim(),
        brand,
        quantity: h.quantity?.trim() || null,
        imageUrl: h.image_front_small_url || r.product.imageUrl,
        category: r.category,
        confidence: r.confidence,
        score: s.score + Math.log10(1 + (h.unique_scans_n ?? 0)) * 0.2,
        nutriScore: r.nutrition?.nutriScore?.toUpperCase() ?? null,
        good: s.good,
        bad: s.bad,
      };
      return item;
    })
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence)
    .filter((it) => {
      // Same name and size = same product listed twice (often once under the store, once under its brand).
      const key = `${it.name}|${it.quantity ?? ""}`.toLowerCase().replace(/[^a-z0-9äöüß|]/g, "");
      if (seenName.has(key)) return false;
      seenName.add(key);
      return true;
    })
    .slice(0, 5)
    .map((it) => ({ ...it, score: Math.round(it.score * 10) / 10 }));

  const where = store ? `${store.label}'s own brands` : "products sold in Germany";
  const dietText = diet === "any" ? "" : ` that are ${diet === "egg" ? "vegetarian or contain only egg" : diet === "veg" ? "vegetarian" : "vegan"}`;
  const note = ranked.length
    ? `Ranked by quality (Nutri-Score, organic, GMO-free, animal welfare, processing, unclear additives), from ${where} in Open Food Facts. Prices aren't included yet.${
        complete ? "" : " Open Food Facts was busy, so not every product could be checked: try again in a minute for the full list."
      }`
    : hits.length
      ? complete
        ? `Found ${hits.length} ${searchFor.label} products from ${where}, but none${dietText} with a full ingredient list I could check.`
        : `Found ${hits.length} ${searchFor.label} products from ${where}, but Open Food Facts was too busy to check them. Try again in a minute.`
      : type
        ? `Open Food Facts has no ${type.label} listed for ${where} yet.`
        : `Couldn't find "${searchFor.label}" from ${where} in Open Food Facts. Check the spelling, or try a general word like "chocolate" or "milk".`;

  return {
    interpreted: { product: searchFor.label, store: store?.label ?? null, diet },
    items: ranked,
    checked: checked.filter(Boolean).length,
    note,
  };
}
