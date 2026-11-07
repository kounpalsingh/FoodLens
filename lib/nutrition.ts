// Nutrition level: Nutri-Score and low / moderate / high for fat, saturated fat, sugars and salt.
// Never affects the veg category. Levels use the UK front-of-pack "traffic light" thresholds per
// 100 g (food) or 100 ml (drinks), the same ones Open Food Facts uses for its nutrient levels.

export type Level = "low" | "moderate" | "high";
export type NutrientKey = "fat" | "saturatedFat" | "sugars" | "salt";

export type Nutrition = {
  source: "openfoodfacts" | "photo";
  basis: "100 g" | "100 ml";
  nutriScore: "a" | "b" | "c" | "d" | "e" | null;
  energyKcal: number | null;
  per100: Record<NutrientKey, number | null>;
  levels: Record<NutrientKey, Level | null>;
};

// [low at or below, high above], per 100 g / 100 ml
const FOOD: Record<NutrientKey, [number, number]> = {
  fat: [3, 17.5],
  saturatedFat: [1.5, 5],
  sugars: [5, 22.5],
  salt: [0.3, 1.5],
};
const DRINK: Record<NutrientKey, [number, number]> = {
  fat: [1.5, 8.75],
  saturatedFat: [0.75, 2.5],
  sugars: [2.5, 11.25],
  salt: [0.3, 0.75],
};

const KEYS: NutrientKey[] = ["fat", "saturatedFat", "sugars", "salt"];

export function levelOf(key: NutrientKey, value: number | null, drink: boolean): Level | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  const [low, high] = (drink ? DRINK : FOOD)[key];
  return value <= low ? "low" : value > high ? "high" : "moderate";
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 && n < 1000 ? n : null;
};

const grade = (g: unknown): Nutrition["nutriScore"] =>
  typeof g === "string" && /^[a-e]$/.test(g.toLowerCase()) ? (g.toLowerCase() as Nutrition["nutriScore"]) : null;

/** From the Open Food Facts product fields. Null when it has no usable nutrition data. */
export function fromOpenFoodFacts(p: {
  nutriscore_grade?: string;
  nutriments?: Record<string, unknown>;
  nutrient_levels?: Record<string, string>;
  categories_tags?: string[];
}): Nutrition | null {
  const n = p.nutriments ?? {};
  const per100 = {
    fat: num(n["fat_100g"]),
    saturatedFat: num(n["saturated-fat_100g"]),
    sugars: num(n["sugars_100g"]),
    salt: num(n["salt_100g"]),
  };
  const drink = (p.categories_tags ?? []).includes("en:beverages");
  const offLevel = (k: string): Level | null => {
    const v = p.nutrient_levels?.[k];
    return v === "low" || v === "moderate" || v === "high" ? v : null;
  };
  const levels = {
    fat: offLevel("fat") ?? levelOf("fat", per100.fat, drink),
    saturatedFat: offLevel("saturated-fat") ?? levelOf("saturatedFat", per100.saturatedFat, drink),
    sugars: offLevel("sugars") ?? levelOf("sugars", per100.sugars, drink),
    salt: offLevel("salt") ?? levelOf("salt", per100.salt, drink),
  };
  const nutriScore = grade(p.nutriscore_grade);
  const energyKcal = num(n["energy-kcal_100g"]);
  if (!nutriScore && KEYS.every((k) => per100[k] == null && levels[k] == null)) return null;
  return { source: "openfoodfacts", basis: drink ? "100 ml" : "100 g", nutriScore, energyKcal, per100, levels };
}

/** From the values the AI copied off the "Nährwerte" table. Null when the photo shows none. */
export function fromPhoto(t: {
  per?: string | null;
  energy_kcal?: unknown;
  fat?: unknown;
  saturated_fat?: unknown;
  sugars?: unknown;
  salt?: unknown;
  nutri_score?: unknown;
} | null | undefined): Nutrition | null {
  if (!t) return null;
  const drink = /ml/i.test(t.per ?? "");
  const per100 = { fat: num(t.fat), saturatedFat: num(t.saturated_fat), sugars: num(t.sugars), salt: num(t.salt) };
  const nutriScore = grade(t.nutri_score);
  if (!nutriScore && KEYS.every((k) => per100[k] == null)) return null;
  const levels = Object.fromEntries(KEYS.map((k) => [k, levelOf(k, per100[k], drink)])) as Nutrition["levels"];
  return { source: "photo", basis: drink ? "100 ml" : "100 g", nutriScore, energyKcal: num(t.energy_kcal), per100, levels };
}
