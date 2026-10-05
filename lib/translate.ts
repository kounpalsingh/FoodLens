// German -> English for ingredient lists, without an AI model.
// Sources: our hand-made glossary (data/glossary-de-en.json, wins on conflicts)
// and ~4,500 names from the Open Food Facts ingredient taxonomy (data/off-glossary-de-en.json).
import curated from "../data/glossary-de-en.json" with { type: "json" };
import offGlossary from "../data/off-glossary-de-en.json" with { type: "json" };

const G: Record<string, string> = { ...(offGlossary as Record<string, string>), ...(curated as Record<string, string>) };

export type IngredientRow = { de: string; en: string | null; depth: number };

const clean = (s: string) =>
  s
    .replace(/\*+/g, "")
    .replace(/\(?\s*\d+[.,]?\d*\s*%\s*\)?/g, " ") // 21 %, (60%)
    .replace(/_/g, "")
    .replace(/\s+-\s+/g, "- ") // "Mono - und Diglyceride" -> "Mono- und Diglyceride"
    .replace(/[¹²³⁴*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,;:.\s]+|[,;:.\s]+$/g, "");

const LINKERS = ["", "s", "n", "en", "e", "es", "er"];

function lookup(word: string): string | null {
  const w = word.toLowerCase();
  if (G[w]) return G[w];
  // Dative plural, e.g. "Haselnüssen", "Schalenfrüchten", "Krebstieren"
  if (w.endsWith("n") && G[w.slice(0, -1)]) return G[w.slice(0, -1)];
  // German compound: "Karottenkonzentrat" = "Karotten" + "konzentrat"
  for (let i = w.length - 3; i >= 3; i--) {
    const head = w.slice(0, i);
    const tail = w.slice(i);
    if (!G[tail]) continue;
    for (const l of LINKERS) {
      if (l && !head.endsWith(l)) continue;
      const h = l ? head.slice(0, -l.length) : head;
      const hEn = G[h] ?? G[head];
      if (hEn) return `${hEn} ${G[tail]}`;
    }
    // "Erdbeer" + "stücke": the glossary has "erdbeeren"
    for (const add of ["en", "n", "e"]) {
      if (G[head + add]) return `${G[head + add]} ${G[tail]}`;
    }
  }
  return null;
}

/** Translate one ingredient as printed ("Säuerungsmittel: Citronensäure", "21% Kokosnussöl"). */
export function translateItem(text: string): string | null {
  const t = clean(text);
  if (!t) return null;
  if (/^e\s?-?\d{3,4}[a-f]?$/i.test(t)) return t.toUpperCase().replace(/\s|-/g, "");
  // "Function: substance"
  const colon = t.indexOf(":");
  if (colon > 0) {
    const a = translateItem(t.slice(0, colon));
    const b = translateItem(t.slice(colon + 1));
    return a && b ? `${a}: ${b}` : null;
  }
  const whole = lookup(t);
  if (whole) return whole;
  // Word by word, e.g. "fettarmes Kakaopulver", "pasteurisierte Milch", "E 330"
  const words = t.split(/\s+/);
  const out: string[] = [];
  for (const w of words) {
    if (/^e\d{3,4}[a-f]?$/i.test(w) || /^\d/.test(w)) {
      out.push(w.toUpperCase());
      continue;
    }
    const en = lookup(w.replace(/[^a-zäöüßéèàç-]/gi, ""));
    if (!en) return null;
    out.push(en);
  }
  return out.join(" ");
}

/** Split an ingredient list into rows, keeping sub-ingredients in brackets as indented rows. */
export function splitIngredients(text: string): string[][] {
  // returns [item, depth] pairs encoded as [text, depthString]
  const rows: string[][] = [];
  let depth = 0;
  let buf = "";
  const flush = () => {
    const t = clean(buf);
    if (t) rows.push([t, String(depth)]);
    buf = "";
  };
  for (const ch of text) {
    if (ch === "(" || ch === "[") {
      flush();
      depth++;
    } else if (ch === ")" || ch === "]") {
      flush();
      depth = Math.max(0, depth - 1);
    } else if ((ch === "," || ch === ";") ) {
      flush();
    } else if (ch === "." && depth === 0) {
      flush();
    } else {
      buf += ch;
    }
  }
  flush();
  return rows;
}

export function ingredientRows(text: string): IngredientRow[] {
  const body = text.replace(/^\s*(zutaten|ingredients)\s*:\s*/i, "");
  return splitIngredients(body)
    .filter(([t]) => !/^(kann|könnte|enthält|dieses produkt|may contain)/i.test(t))
    // Storage notes, certifications and nutrition claims that end up in the ingredient text
    .filter(([t]) => !/lagern|haltbar|verzehr|zertifiziert|rainforest|fairtrade|%\s*ri\b|endprodukt|end-produkt|proteingehalt|weizenfrei|glutenfrei|laktosefrei$|siehe deckel|siehe boden|mindestens|im becher|enthalten in einem/i.test(t))
    .map(([de, d]) => ({ de, en: translateItem(de), depth: Number(d) }));
}

/** "kann Spuren von Milch und Schalenfrüchten enthalten" -> "may contain traces of milk, tree nuts" */
export function translateTrace(trace: string): string {
  const inner = trace
    .toLowerCase()
    .replace(/\b(kann|könnte|spuren|von|an|enthalten|may|contain|traces|of)\b/g, " ")
    .split(/,|\bund\b|\boder\b|\band\b/)
    .map((s) => clean(s))
    .filter(Boolean);
  const en = inner.map((s) => translateItem(s) ?? s);
  return `May contain traces of ${en.join(", ")}`;
}
