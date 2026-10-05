// Compare Food Lens categories with Open Food Facts on real German products.
// Run: node --experimental-strip-types scripts/validate-off.ts  (needs internet)
import { readFileSync, writeFileSync } from "node:fs";
import { analyzeIngredients } from "../lib/rules.ts";
import { ingredientRows } from "../lib/translate.ts";

const data = JSON.parse(readFileSync(new URL("../data/ingredient-rules.json", import.meta.url), "utf8"));
data.autoTerms = JSON.parse(readFileSync(new URL("../data/off-animal-terms.json", import.meta.url), "utf8"));
let rowsTotal = 0, rowsTranslated = 0;
const untranslated: Record<string, number> = {};
const CATS = process.argv[2] ? process.argv[2].split(",") : ["gummies", "yogurts", "cheeses", "sausages", "biscuits", "chocolates", "breads", "ice-creams", "pasta-sauces", "chips-and-fries", "breakfast-cereals", "frozen-pizzas", "instant-noodles", "cakes", "soups"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const rows: string[] = [];
const counts: Record<string, number> = {};
const unclearBy: Record<string, number> = {};
let disagree = 0, total = 0;
for (const cat of CATS) {
  const url = `https://world.openfoodfacts.org/api/v2/search?countries_tags_en=germany&categories_tags_en=${cat}&fields=code,product_name,brands,ingredients_text_de,ingredients_analysis_tags&page_size=40&sort_by=unique_scans_n`;
  let products: any[] = [];
  try {
    const res = await fetch(url, { headers: { "User-Agent": "FoodLens/0.1 (rules validation)" } });
    products = (await res.json()).products ?? [];
  } catch (e) { console.log(cat, "fetch failed", e); }
  for (const p of products) {
    const text = p.ingredients_text_de;
    if (!text) continue;
    const r = analyzeIngredients(text, data);
    for (const row of ingredientRows(text)) {
      rowsTotal++;
      if (row.en) rowsTranslated++;
      else untranslated[row.de.toLowerCase()] = (untranslated[row.de.toLowerCase()] ?? 0) + 1;
    }
    total++;
    counts[r.category] = (counts[r.category] ?? 0) + 1;
    if (r.category === "unclear") for (const h of r.hits) if (h.cls.startsWith("maybe")) unclearBy[h.label] = (unclearBy[h.label] ?? 0) + 1;
    const tags: string[] = p.ingredients_analysis_tags ?? [];
    const offNonVeg = tags.includes("en:non-vegetarian");
    const offVegan = tags.includes("en:vegan");
    const ours = r.category;
    const conflict =
      (offNonVeg && (ours === "veg" || ours === "vegan")) ||
      (!offNonVeg && tags.includes("en:vegetarian") && ours === "non_veg") ||
      (offVegan && ours !== "vegan" && ours !== "unclear");
    if (conflict) {
      disagree++;
      rows.push(`${cat}\t${p.code}\t${p.brands ?? ""} ${p.product_name ?? ""}\tours=${ours}\toff=${tags.filter((t) => /veg/.test(t)).join(",")}\thits=${r.hits.map((h) => h.matched).join("|")}\t${text.slice(0, 220).replace(/\s+/g, " ")}`);
    }
  }
  console.log(cat, products.length);
  await sleep(9000); // OFF asks for max 10 searches/minute
}
const summary = `checked ${total} products\ncategories: ${JSON.stringify(counts)}\ndisagreements with Open Food Facts: ${disagree}\nunclear caused by: ${JSON.stringify(unclearBy)}\ntranslated ingredient rows: ${rowsTranslated}/${rowsTotal} (${Math.round((100 * rowsTranslated) / Math.max(1, rowsTotal))}%)\nmost common untranslated: ${Object.entries(untranslated).sort((a, b) => b[1] - a[1]).slice(0, 60).map(([k, v]) => `${k} (${v})`).join(" | ")}\n`;
writeFileSync("validation-report.txt", summary + "\n" + rows.join("\n"));
console.log(summary);
