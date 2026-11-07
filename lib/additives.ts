// Additives that can come from plants or animals (E471 and friends): find them, explain them,
// and say whether the source is known, with the evidence. Never guesses: no evidence = "unknown".
import data from "../data/additives.json";
import { itemAfter, itemBefore, normalize, splitTraces, termRegex } from "./rules";

export type AdditiveStatus = "plant" | "animal" | "unknown" | "insect";

export type AdditiveFinding = {
  code: string;
  name: string;
  about: string;
  group: string;
  matched: string; // the words found on the label
  status: AdditiveStatus;
  evidence: string; // plain-English reason for the status
};

/** What else we know about the product as a whole. */
export type ProductClaims = {
  veganLabel: boolean; // Open Food Facts label tag, or "vegan" stated on the pack
  vegetarianLabel: boolean;
  source?: string; // where the claim came from, for the evidence line
};

type Additive = (typeof data.additives)[number];

const has = (text: string, words: string[]) => words.find((w) => text.includes(w));

/** "Dieses Produkt ist vegan", "vegan" on its own: a pack-level claim inside the ingredient text. */
export function claimsInText(rawText: string): ProductClaims {
  const t = normalize(rawText);
  const vegan = /(produkt ist vegan|100\s?% vegan|(?<![a-zäöüß])vegan(?![a-zäöüß])\s*(\.|$|produkt))/.test(t);
  const vegetarian = /(produkt ist vegetarisch|(?<![a-zäöüß])vegetarisch(?![a-zäöüß])\s*(\.|$))/.test(t);
  return { veganLabel: vegan, vegetarianLabel: vegetarian || vegan, source: vegan || vegetarian ? "the pack" : undefined };
}

export function findAdditives(rawText: string, claims: ProductClaims): AdditiveFinding[] {
  const { main } = splitTraces(normalize(rawText || ""));
  const wide = has(main, data.productWidePlantStatements);
  const out: AdditiveFinding[] = [];

  for (const a of data.additives as Additive[]) {
    let found: { matched: string; status: AdditiveStatus; evidence: string } | null = null;

    for (const term of a.terms) {
      const re = termRegex(term);
      let m: RegExpExecArray | null;
      while ((m = re.exec(main))) {
        const around = itemBefore(main, m.index) + " " + itemAfter(main, m.index + m[0].length);
        // The whole ingredient as printed ("mono- und diglyceride von speisefettsäuren"), not just the matched fragment.
        const whole = (itemBefore(main, m.index) + m[0] + itemAfter(main, m.index + m[0].length))
          .replace(/^[\s:]*(emulgatoren?|emulsifiers?|stabilisatoren?|geschmacksverstärker|überzugsmittel|mehlbehandlungsmittel|trennmittel)\s*:?\s*/i, "")
          .replace(/\s+/g, " ")
          .trim();
        const matched = (whole.length > 3 && whole.length <= 70 ? whole : m[0]).replace(/^./, (c) => c.toUpperCase());
        let result: { status: AdditiveStatus; evidence: string };

        const animal = has(around, data.animalWords);
        const plant = has(around, data.plantWords);
        if (a.group === "shellac") {
          result = { status: "insect", evidence: "Always made by insects; there is no plant version." };
        } else if (animal) {
          result = { status: "animal", evidence: `The label says “${animal}” next to it.` };
        } else if (plant) {
          result = { status: "plant", evidence: `The label says “${plant}” next to it.` };
        } else if (wide && a.group === "emulsifier_maybe_animal") {
          result = { status: "plant", evidence: `The label says “${wide}”.` };
        } else if (claims.veganLabel && a.veganClaimSettles) {
          result = { status: "plant", evidence: `The product is labelled vegan (${claims.source ?? "product label"}).` };
        } else {
          result = { status: "unknown", evidence: "The label doesn't say whether it comes from plants or animals." };
        }

        // Keep the most informative finding for this additive: animal > unknown > plant.
        const rank = { animal: 3, insect: 3, unknown: 2, plant: 1 } as const;
        if (!found || rank[result.status] > rank[found.status]) found = { matched, ...result };
      }
    }

    if (found) {
      out.push({ code: a.code, name: a.name, about: a.about, group: a.group, ...found });
    }
  }
  return out;
}
