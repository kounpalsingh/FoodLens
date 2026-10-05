// Deterministic product classification. The category is decided here, never by the LLM.
// Same ingredient text => same answer, every time.

/** What a kind of ingredient means (set per category in data/ingredient-rules.json). */
export type IngredientClass =
  | "non_veg" // meat, fish, gelatine, carmine
  | "egg"
  | "animal_veg" // milk, honey: animal but vegetarian
  | "maybe_non_veg" // E471, Lab: could be animal
  | "maybe_egg" // "Eiweiß" without a source
  | "maybe_animal_veg"; // vitamin D3: could be animal, still vegetarian

/** The product's category, shown to the user. */
export type Category = "vegan" | "veg" | "egg" | "non_veg" | "unclear";

export type RulesData = {
  categories: Record<string, IngredientClass>;
  /** Extra whole-word terms with their class, generated from the Open Food Facts taxonomy. */
  autoTerms?: Record<string, IngredientClass>;
  rules: {
    id: string;
    label: string;
    category: string;
    terms: string[];
    exclude?: string[];
    okIfFollowedBy?: string[];
  }[];
};

export type Hit = {
  ruleId: string;
  label: string;
  matched: string; // the term as it appeared
  cls: IngredientClass;
};

export type RuleResult = {
  category: Category;
  hits: Hit[];
  traces: string[]; // "may contain traces of ..." statements, reported separately
  hasIngredients: boolean;
};

const LETTER = "a-zäöüßéèàç";

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    // "E 471", "E-471" -> "e471"
    .replace(/(^|[^a-zäöüß])e[\s-]?(\d{3,4}[a-f]?)/g, "$1e$2");
}

// Pull out "kann Spuren von ... enthalten" / "may contain ..." so trace warnings
// don't decide the category (they matter for allergies, not diet).
export function splitTraces(text: string): { main: string; traces: string[] } {
  const traces: string[] = [];
  const patterns = [
    /(kann|könnte)?\s*spuren (von|an) [^.;]*?(enthalten)?(?=[.;]|$)/g,
    /(kann|könnte) [^.;]{0,80}? enthalten/g, // "Kann Milch enthalten."
    /may contain( traces of)? [^.;]*/g,
  ];
  let main = text;
  for (const p of patterns) {
    main = main.replace(p, (m) => {
      traces.push(m.trim());
      return " ";
    });
  }
  return { main, traces };
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termRegex(term: string): RegExp {
  // "=word" whole word, "^word" start of a word, plain = anywhere (German compounds).
  const mode = term[0] === "=" || term[0] === "^" ? term[0] : "";
  const t = escapeRe(mode ? term.slice(1) : term);
  if (mode === "=") return new RegExp(`(?<![${LETTER}])${t}(?![${LETTER}])`, "g");
  if (mode === "^") return new RegExp(`(?<![${LETTER}])${t}`, "g");
  return new RegExp(t, "g");
}

export const has = (hits: Hit[], cls: IngredientClass) => hits.some((h) => h.cls === cls);

export function classify(hits: Hit[], hasIngredients: boolean): Category {
  if (!hasIngredients) return "unclear";
  if (has(hits, "non_veg")) return "non_veg";
  if (has(hits, "egg")) return "egg";
  if (has(hits, "maybe_non_veg") || has(hits, "maybe_egg")) return "unclear";
  if (has(hits, "animal_veg") || has(hits, "maybe_animal_veg")) return "veg";
  return "vegan";
}

export function analyzeIngredients(rawText: string, data: RulesData): RuleResult {
  const normalized = normalize(rawText || "");
  const { main, traces } = splitTraces(normalized);
  const hasIngredients = main.replace(/[^a-zäöüß]/g, "").length >= 4; // "Milch", "Reis" are valid single-ingredient lists

  const hits: Hit[] = [];
  for (const rule of data.rules) {
    const cls = data.categories[rule.category] ?? "maybe_non_veg";

    let text = main;
    for (const ex of rule.exclude ?? []) text = text.split(ex).join(" ");

    for (const term of rule.terms) {
      const re = termRegex(term);
      let m: RegExpExecArray | null;
      let found = false;
      while ((m = re.exec(text))) {
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + 45);
        if (rule.okIfFollowedBy?.some((w) => after.includes(w))) continue;
        found = true;
        break;
      }
      if (found) {
        hits.push({ ruleId: rule.id, label: rule.label, matched: term.replace(/^[=^]/, ""), cls });
        break; // one hit per rule is enough
      }
    }
  }

  // Second pass: the Open Food Facts animal-ingredient list (whole words only),
  // after removing every curated exclusion so "Kokosmilch", "peanut butter" etc. stay safe.
  if (data.autoTerms) {
    let text = main;
    for (const rule of data.rules) for (const ex of rule.exclude ?? []) text = text.split(ex).join(" ");
    for (const [cls, re] of autoRegexes(data.autoTerms)) {
      if (hits.some((h) => h.cls === cls)) continue; // already explained by a curated rule
      const m = re.exec(text);
      if (m) hits.push({ ruleId: "off_taxonomy", label: AUTO_LABEL[cls], matched: m[1], cls });
    }
  }

  return { category: classify(hits, hasIngredients), hits, traces, hasIngredients };
}

const AUTO_LABEL: Record<IngredientClass, string> = {
  non_veg: "Animal ingredient",
  egg: "Egg",
  animal_veg: "Dairy / honey",
  maybe_non_veg: "May be animal-derived",
  maybe_egg: "May contain egg",
  maybe_animal_veg: "May not be vegan",
};

let autoCache: { src: object; list: [IngredientClass, RegExp][] } | null = null;
function autoRegexes(terms: Record<string, IngredientClass>): [IngredientClass, RegExp][] {
  if (autoCache?.src === terms) return autoCache.list;
  const byClass = new Map<IngredientClass, string[]>();
  for (const [t, c] of Object.entries(terms)) byClass.set(c, [...(byClass.get(c) ?? []), t]);
  const list: [IngredientClass, RegExp][] = [...byClass].map(([c, ts]) => [
    c,
    new RegExp(`(?<![${LETTER}])(${ts.sort((a, b) => b.length - a.length).map(escapeRe).join("|")})(?![${LETTER}])`),
  ]);
  autoCache = { src: terms, list };
  return list;
}
