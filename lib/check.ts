// Orchestrates one check: get the ingredient text (barcode -> Open Food Facts,
// or photo -> AI transcription, or pasted text), then run the rules and score confidence.
import rulesData from "../data/ingredient-rules.json";
import autoTerms from "../data/off-animal-terms.json";
import { analyzeIngredients, type Category, type Hit, type RulesData } from "./rules";
import { lookupBarcode, type OffProduct } from "./openfoodfacts";
import { ingredientRows, translateItem, translateTrace, type IngredientRow } from "./translate";

const RULES = { ...(rulesData as RulesData), autoTerms: autoTerms as RulesData["autoTerms"] };
import { llmConfigured, readLabelFromImage } from "./llm";

export type CheckInput = { barcode?: string; image?: string; text?: string };

export type CheckResult = {
  category: Category;
  confidence: number; // 0-100, heuristic: how complete and certain the evidence is
  source: "openfoodfacts" | "photo" | "text";
  barcode?: string;
  product: { name: string | null; nameEn: string | null; imageUrl: string | null };
  hits: (Hit & { matchedEn: string | null })[];
  reasons: string[];
  traces: { de: string | null; en: string }[];
  ingredients: { original: string; english?: string; rows: IngredientRow[] };
};

export class CheckError extends Error {}

const clamp = (n: number) => Math.max(5, Math.min(97, Math.round(n)));

export async function runCheck(input: CheckInput): Promise<CheckResult> {
  const startedAt = Date.now();
  const reasons: string[] = [];
  let source: CheckResult["source"];
  let product: CheckResult["product"] = { name: null, nameEn: null, imageUrl: null };
  let off: OffProduct | null = null;
  let rows: IngredientRow[] | null = null;
  let original = "";
  let english: string | undefined;
  let legibility: "clear" | "partial" | "unreadable" = "clear";
  let offTags: string[] = [];

  // 1. Barcode found in the photo -> try Open Food Facts first (no AI needed).
  let offMiss = false;
  let offDown = false;
  if (input.barcode) {
    const found = await lookupBarcode(input.barcode).catch(() => {
      offDown = true;
      return null;
    });
    if (found && found.ingredientsText.trim().length >= 3) {
      off = found;
      source = "openfoodfacts";
      product = { name: found.name, nameEn: found.nameEn, imageUrl: found.imageUrl };
      original = found.ingredientsText;
      english = found.ingredientsTextEn && found.ingredientsTextEn !== original ? found.ingredientsTextEn : undefined;
      offTags = found.analysisTags;
    } else {
      offMiss = true;
      if (found?.name) product.name = found.name;
    }
  }

  // 2. Otherwise read the label from the photo with the AI model.
  if (!original && input.image) {
    if (!llmConfigured()) {
      throw new CheckError(
        (offDown
          ? "Couldn't reach Open Food Facts to look up this barcode. "
          : offMiss
            ? `This product (barcode ${input.barcode}) isn't in Open Food Facts yet, or has no ingredient list there. `
            : "No barcode could be read in this photo. Retake it closer and sharper, with the barcode filling more of the frame. ") +
          "Reading ingredient-list photos needs an AI model, which isn't set up yet (the LLM_API_KEY setting is missing). " +
          "Meanwhile you can paste the ingredient text.",
      );
    }
    // Whatever the barcode lookup used up comes off the AI's time, so the total stays under ~27 s.
    const budget = Math.max(8000, 26_000 - (Date.now() - startedAt));
    const reading = await readLabelFromImage(input.image, budget).catch((e: Error) => {
      throw new CheckError(e.message);
    });
    if (!reading.is_food_label) {
      throw new CheckError(
        `This doesn't look like food${reading.what_it_is ? ` (it looks like ${reading.what_it_is})` : ""}. Food Lens only checks food and drink.`,
      );
    }
    source = "photo";
    if (reading.product_name && !product.name) product.name = reading.product_name;
    original = reading.ingredients_original;
    english = reading.ingredients_english || undefined;
    if (reading.ingredients_list?.length) rows = reading.ingredients_list.map((i) => ({ de: i.de, en: i.en || translateItem(i.de), depth: 0 }));
    legibility = reading.legibility;

  } else if (!original && input.text) {
    source = "text";
    original = input.text;
  } else if (!original) {
    throw new CheckError(
      offDown
        ? "Couldn't reach Open Food Facts to look up this barcode. Try again, or upload a photo of the ingredient list."
        : offMiss
        ? `This product (barcode ${input.barcode}) isn't in Open Food Facts yet, or has no ingredient list there. Upload a photo of the ingredient list instead.`
        : "Upload a photo or paste the ingredient text.",
    );
  }

  // 3. Rules decide. Run on original + English translation so both languages are matched.
  const textForRules = [original, english].filter(Boolean).join(" ; ");
  const r = analyzeIngredients(textForRules, RULES);
  const labels = (cls: Hit["cls"]) => r.hits.filter((h) => h.cls === cls).map((h) => h.label.toLowerCase());
  const maybes = r.hits.filter((h) => h.cls === "maybe_non_veg" || h.cls === "maybe_egg");

  let category = r.category;
  let confidence: number;
  const listConfidence = source! === "photo" ? 80 : 90;

  switch (category) {
    case "non_veg":
      confidence = 95;
      reasons.push(`Contains ${labels("non_veg").join(", ")}, which is non-veg.`);
      break;
    case "egg":
      confidence = maybes.length ? 60 : 95;
      reasons.push("Contains egg. No meat, fish or gelatine found.");
      if (maybes.length) reasons.push(`Also can't confirm: ${maybes.map((h) => h.label).join("; ")}. It could be animal-derived.`);
      break;
    case "unclear":
      if (!r.hasIngredients) {
        confidence = 25;
        reasons.push("No ingredient list could be found, so nothing can be checked.");
      } else {
        confidence = 55 - 5 * (maybes.length - 1);
        reasons.push(
          `Can't confirm: ${maybes.map((h) => h.label).join("; ")}. The label doesn't say whether ${
            maybes.length > 1 ? "these come" : "this comes"
          } from plants or animals.`,
        );
      }
      break;
    case "veg": {
      confidence = listConfidence;
      reasons.push("No meat, fish, gelatine or egg found.");
      const animal = labels("animal_veg");
      if (animal.length) reasons.push(`Not vegan: contains ${animal.join(", ")}.`);
      const maybeVegan = labels("maybe_animal_veg");
      if (maybeVegan.length) reasons.push(`May not be vegan: ${maybeVegan.join(", ")}.`);
      break;
    }
    default:
      confidence = listConfidence;
      reasons.push("No animal ingredients found.");
  }

  // Photo only partly readable: never call it veg/vegan on half a list.
  if (source! === "photo" && legibility !== "clear" && r.hasIngredients) {
    if (category === "veg" || category === "vegan") category = "unclear";
    confidence = Math.min(confidence, category === "non_veg" || category === "egg" ? 90 : 45);
    reasons.push("Part of the ingredient list was cut off or hard to read. Retake the photo to be sure.");
  }

  // Open Food Facts' own per-ingredient flags: a safety net for anything our lists missed.
  if (off && r.hasIngredients) {
    const { nonVeg, egg, notVegan } = off.flagged;
    if (nonVeg.length && category !== "non_veg") {
      category = "non_veg";
      confidence = 90;
      r.hits.push({ ruleId: "off_flag", label: "Animal ingredient (Open Food Facts)", matched: nonVeg[0], cls: "non_veg" });
      reasons.push(`Open Food Facts identifies ${nonVeg.join(", ")} as non-vegetarian.`);
    } else if (egg.length && (category === "veg" || category === "vegan")) {
      category = "egg";
      confidence = 90;
      r.hits.push({ ruleId: "off_flag", label: "Egg (Open Food Facts)", matched: egg[0], cls: "egg" });
      reasons.push(`Open Food Facts identifies ${egg.join(", ")} as egg.`);
    } else if (notVegan.length && category === "vegan") {
      category = "veg";
      r.hits.push({ ruleId: "off_flag", label: "Dairy / honey (Open Food Facts)", matched: notVegan[0], cls: "animal_veg" });
      reasons.push(`Not vegan: Open Food Facts identifies ${notVegan.join(", ")}.`);
    }
  }

  // Cross-check with Open Food Facts' own analysis when we have it.
  if (source! === "openfoodfacts" && r.hasIngredients) {
    if ((category === "veg" || category === "vegan") && offTags.includes("en:non-vegetarian")) {
      category = "unclear";
      confidence = 50;
      reasons.push("Open Food Facts marks this product as non-vegetarian, but the ingredient list doesn't show why. Check the pack.");
    } else if (category === "vegan" && offTags.includes("en:non-vegan")) {
      category = "veg";
      confidence = 70;
      reasons.push("Open Food Facts marks this as not vegan, though the ingredient list doesn't show why.");
    } else if (
      (category === "vegan" && offTags.includes("en:vegan")) ||
      (category === "veg" && offTags.includes("en:vegetarian"))
    ) {
      confidence += 5;
      reasons.push("Open Food Facts' own analysis agrees.");
    }
  }

  return {
    category,
    confidence: clamp(confidence),
    source: source!,
    barcode: input.barcode,
    product,
    hits: r.hits.map((h) => ({ ...h, matchedEn: h.ruleId === "off_flag" ? h.matched : translateItem(h.matched) })),
    reasons,
    traces: r.traces.length
      ? r.traces
          .map((t) => ({ de: /^may contain/.test(t) ? null : t, en: translateTrace(t) }))
          .filter((t, i, all) => all.findIndex((o) => o.en.toLowerCase() === t.en.toLowerCase()) === i)
      : off?.tracesEn.length
        ? [{ de: null, en: `May contain traces of ${off.tracesEn.join(", ")}` }]
        : [],
    ingredients: { original, english, rows: rows ?? ingredientRows(original) },
  };
}
