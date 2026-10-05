// Quick sanity checks for the rules engine: npm test
import { readFileSync } from "node:fs";
import { analyzeIngredients, type Category } from "../lib/rules.ts";

const data = JSON.parse(readFileSync(new URL("../data/ingredient-rules.json", import.meta.url), "utf8"));
data.autoTerms = JSON.parse(readFileSync(new URL("../data/off-animal-terms.json", import.meta.url), "utf8"));

const cases: [string, Category, string][] = [
  ["Zucker, Glukosesirup, Gelatine, Säuerungsmittel: Citronensäure, Farbstoff: E 120", "non_veg", "gummy bears"],
  ["Weizenmehl, Zucker, Palmfett, Kakaobutter, Salz. Kann Spuren von Ei und Milch enthalten.", "vegan", "trace warning ignored, cocoa butter ok"],
  ["Weizenmehl, Vollei, Zucker, Butter", "egg", "cake with egg"],
  ["Weizenmehl, Zucker, Butter, Backpulver", "veg", "eggless cake with butter"],
  ["Kuhmilch", "veg", "plain milk"],
  ["Mango-Fruchtfleisch (60%), Zucker, Wasser", "vegan", "fruit pulp is not meat"],
  ["Pasteurisierte Milch, Salz, Lab, Milchsäurekulturen", "unclear", "cheese with rennet"],
  ["Pasteurisierte Milch, Salz, mikrobielles Lab", "veg", "microbial rennet"],
  ["Zucker, Emulgator: E471 (pflanzlich), Aroma", "vegan", "plant E471"],
  ["Zucker, Emulgator: E-471, Aroma", "unclear", "unknown E471"],
  ["Kokosmilch (80%), Wasser, Guarkernmehl", "vegan", "coconut milk"],
  ["Schweinefleisch, Salz, Gewürze", "non_veg", "pork"],
  ["Hühnereiweiß, Zucker", "egg", "egg white"],
  ["Erbseneiweiß, Rapsöl, Salz, Gewürze", "vegan", "pea protein"],
  ["Eiweiß, Zucker", "unclear", "unspecified protein"],
  ["Zucker, Überzugsmittel: Schellack", "unclear", "shellac"],
  ["Sugar, wheat flour, palm oil, whey powder, salt", "veg", "English whey"],
  ["Zucker, Honig, Haferflocken", "veg", "honey"],
  ["Weizenmehl, Eier, Speck", "non_veg", "egg + bacon is non-veg"],
  ["Eis", "unclear", "too little text"],
  ["Reis, Wasser, Salz, Zwiebeln, Knoblauch", "vegan", "'Reis' must not match '=ei'"],
  // expanded database
  ["Weizenmehl, Zucker, Hirschhornsalz, Zimt", "vegan", "Hirschhornsalz is a leavening agent"],
  ["Haselnüsse, Zucker, Kakao", "vegan", "Haselnuss is not Hase"],
  ["Flammkuchenteig: Weizenmehl, Wasser, Rapsöl, Salz", "vegan", "Flammkuchen is not Lamm"],
  ["Muschelnudeln aus Hartweizengrieß", "vegan", "shell pasta"],
  ["Austernpilze, Rapsöl, Salz", "vegan", "oyster mushrooms"],
  ["Rote Nierenbohnen, Wasser, Salz", "vegan", "kidney beans"],
  ["Butterschmalz", "veg", "ghee-style clarified butter is not lard"],
  ["Schweineschmalz, Zwiebeln, Salz", "non_veg", "lard"],
  ["Lammkeule, Rosmarin", "non_veg", "lamb leg"],
  ["Thunfisch, Sonnenblumenöl, Salz", "non_veg", "tuna"],
  ["Tomaten, Sardellenfilets, Kapern", "non_veg", "anchovies"],
  ["Rindfleischbrühe, Gemüse", "non_veg", "beef stock"],
  ["Wasser, Zucker, Kollagenhydrolysat", "non_veg", "collagen"],
  ["Weizenmehl, Grillenmehl (10%), Salz", "non_veg", "cricket flour"],
  ["Zucker, Glukosesirup, Säuerungsmittel, Farbstoff: Echtes Karmin", "non_veg", "carmine by name"],
  ["Hartweizengrieß, Eier (25%), Wasser", "egg", "egg pasta"],
  ["Zucker, Eiklar, Mandeln", "egg", "macarons"],
  ["Spaghetti, Tomaten, Parmesan (Milch, Salz, Lab)", "unclear", "Parmesan"],
  ["Wasser, Kichererbsen, Glycerin, Salz", "unclear", "glycerin"],
  ["Orangensaft, Vitamin D3", "veg", "vitamin D3 not vegan"],
  ["Orangensaft, Vitamin D3 (aus Flechten)", "vegan", "lichen vitamin D3"],
  ["Hafer, Wasser, Rapsöl, Salz", "vegan", "oat drink"],
  ["Sojadrink, Sojajoghurt-Kulturen, Kokosmilch", "vegan", "vegan yoghurt"],
  ["Wasserkefir: Wasser, Zucker, Kefirkulturen", "vegan", "water kefir"],
  ["Milch", "veg", "single word milk"],
  ["Pfifferlinge (Eierschwammerl), Salz", "vegan", "chanterelles"],
  ["Weizenmehl, Wasser, Hefe, Salz, Emulgator: Mono- und Diglyceride von Speisefettsäuren (pflanzlich)", "vegan", "plant mono-diglycerides"],
  ["Paneer (Milch, Zitronensäure)", "veg", "paneer"],
  ["Rapsöl, Wasser, Eigelb, Senf, Essig", "egg", "mayonnaise"],
  ["Worcestersauce, Zucker", "non_veg", "Worcester sauce has anchovies"],
  ["Weizenmehl, Zucker, Palmöl, Kakaopulver, Salz, Aroma. Kann Milch enthalten.", "vegan", "Oreo: 'Kann Milch enthalten' is a trace warning"],
  ["Weizenmehl, Wasser, Emulgatoren: Mono - und Diglyceride Speisefettsäuren", "unclear", "spaced mono - und diglyceride"],
  ["Weizenmehl, Natriumstearoyl-2-lactylat, Salz", "unclear", "E481 by name"],
  // Open Food Facts taxonomy terms
  ["Kaffee, Obers, Zucker", "veg", "Austrian 'Obers' (cream)"],
  ["Weizenmehl, Tierfett, Salz", "non_veg", "Tierfett"],
  ["Wasser, Bluteiweiß, Salz", "non_veg", "blood protein"],
  ["Schweinebäckchen, Salz", "non_veg", "pork cheeks"],
  ["Peanut butter, salt, sugar", "vegan", "peanut butter stays vegan"],
  ["Nuss-Nougat-Creme: Zucker, Palmöl, Haselnüsse, Kakao", "vegan", "'Creme' alone is not dairy"],
  ["Eierteigwaren, Tomaten", "egg", "egg pasta"],
];

let fail = 0;
for (const [text, expected, name] of cases) {
  const r = analyzeIngredients(text, data);
  const ok = r.category === expected;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(38)} -> ${r.category}${ok ? "" : ` (expected ${expected})`}  ${r.hits.map((h) => h.matched).join(", ")}`);
}
console.log(fail ? `\n${fail} failed` : `\nAll ${cases.length} passed`);
process.exit(fail ? 1 : 0);
