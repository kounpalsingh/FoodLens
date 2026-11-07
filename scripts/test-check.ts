// End-to-end checks on pasted text (no network, no AI): npm run test:check
import { runCheck } from "../lib/check";

type Expect = { category: string; additives?: string[] };
const cases: [string, Expect, string][] = [
  ["Zucker, Emulgator: E471 (pflanzlich), Aroma", { category: "vegan", additives: ["E471:plant"] }, "stated plant E471"],
  ["Zucker, Emulgator: E 471, Rapsöl", { category: "unclear", additives: ["E471:unknown"] }, "E471 source not stated"],
  ["Weizenmehl, Mono- und Diglyceride von Speisefettsäuren tierischen Ursprungs, Salz", { category: "non_veg", additives: ["E471:animal"] }, "animal E471"],
  ["Weizenmehl, Natriumstearoyl-2-lactylat, Salz. Alle Emulgatoren pflanzlichen Ursprungs.", { category: "vegan", additives: ["E481:plant"] }, "product-wide plant statement"],
  ["Wasser, Glycerin, Zucker. Dieses Produkt ist vegan.", { category: "vegan", additives: ["E422:plant"] }, "vegan claim settles glycerin"],
  ["Orangensaft, Vitamin D3. Dieses Produkt ist vegan.", { category: "vegan", additives: ["Vitamin D3:plant"] }, "vegan claim settles vitamin D3"],
  ["Zucker, Überzugsmittel: Schellack", { category: "unclear", additives: ["E904:insect"] }, "shellac stays insect"],
  ["Kartoffeln, Rapsöl, Salz, Geschmacksverstärker: Dinatriumguanylat, Dinatriuminosinat", { category: "unclear", additives: ["E627:unknown", "E631:unknown"] }, "flavour enhancers"],
  ["Weizenmehl, Vollei, Zucker, Butter", { category: "egg", additives: [] }, "no additives"],
];

async function main() {
let fail = 0;
for (const [text, want, name] of cases) {
  const r = await runCheck({ text });
  const got = r.additives.map((a) => `${a.code}:${a.status}`);
  const ok = r.category === want.category && (!want.additives || JSON.stringify(got) === JSON.stringify(want.additives));
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(34)} -> ${r.category} ${JSON.stringify(got)}${ok ? "" : `  (expected ${want.category} ${JSON.stringify(want.additives)})`}`);
}
console.log(fail ? `\n${fail} failed` : `\nAll ${cases.length} passed`);
process.exit(fail ? 1 : 0);
}
main();
