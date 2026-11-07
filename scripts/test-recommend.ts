// Checks how shopping requests are understood (no network needed): npm run test:recommend
import { parseRequest } from "../lib/recommend";
import { qualityFromLabels } from "../lib/openfoodfacts";

const cases: [string, string | null, string | null, string | null][] = [
  // query, store id, product label, diet
  ["best milk at Lidl", "lidl", "milk", null],
  ["beste Milch bei Lidl", "lidl", "milk", null],
  ["best oat milk in aldi süd", "aldi", "oat drink", null],
  ["Hafermilch Rewe", "rewe", "oat drink", null],
  ["Sojadrink Rewe", "rewe", "plant milk", null],
  ["vegan yoghurt at Aldi", "aldi", "vegan yoghurt", "vegan"],
  ["veganer Joghurt Kaufland", "kaufland", "vegan yoghurt", "vegan"],
  ["joghurt edeka", "edeka", "yoghurt", null],
  ["vegetarian gummies at penny", "penny", "gummies", "veg"],
  ["chocolate rewe", "rewe", "chocolate", null],
  ["vegan cheese", null, "vegan cheese", "vegan"],
  ["eis netto", "netto", "ice cream", null],
  ["reis bei dm", "dm", "rice", null],
  ["eggetarian cake at lidl", "lidl", "cake", "egg"],
  ["something at lidl", "lidl", null, null],
  ["tee rossmann", "rossmann", "tea", null],
  // typos and more specific types
  ["best dark choclate at kaufland", "kaufland", "dark chocolate", null],
  ["Zartbitterschokolade bei Kaufand", "kaufland", "dark chocolate", null],
  ["vollmilchschokolade lidl", "lidl", "milk chocolate", null],
  ["chocolate rewe", "rewe", "chocolate", null],
  ["vollmilch aldi", "aldi", "whole milk", null],
  ["best yoghrt at lidl", "lidl", "yoghurt", null],
  ["peanut butter penny", "penny", "peanut butter", null],
  ["Erdnussbutter bei Rewe", "rewe", "peanut butter", null],
  ["butter at edeka", "edeka", "butter", null],
  ["Kakaobutter bei Edeka", "edeka", null, null],
  ["griechischer joghurt aldi", "aldi", "greek yoghurt", null],
  ["Erdnüsse bei Kaufland", "kaufland", null, null],
];

let failed = 0;
// Leftover words become a free-text search when no product type matches.
for (const [q, rest] of [["Erdnüsse bei Kaufland", "erdnüsse"], ["best Kakaobutter at Edeka", "kakaobutter"], ["best milk at Lidl", ""]] as const) {
  const got = parseRequest(q).rest;
  const ok = got === rest;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  rest of "${q}" -> "${got}"${ok ? "" : `  expected "${rest}"`}`);
}
for (const [q, store, type, diet] of cases) {
  const p = parseRequest(q);
  const got = [p.store?.id ?? null, p.type?.label ?? null, p.diet];
  const ok = got[0] === store && got[1] === type && got[2] === diet;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  "${q}" -> ${JSON.stringify(got)}${ok ? "" : `  expected ${JSON.stringify([store, type, diet])}`}`);
}

const q = qualityFromLabels(["en:organic", "en:eu-organic", "de:Haltungsform-4-premium", "en:nutriscore"], 1);
const q2 = qualityFromLabels(["De:ohnegentechnik", "de:haltungsform-3-frischluftklima"], "4");
const q3 = qualityFromLabels(["en:nutriscore", "en:fsc"], undefined);
for (const [name, ok] of [
  ["organic + welfare 4 + nova 1", q.organic && q.gmoFree && q.welfare === 4 && q.nova === 1],
  ["ohne Gentechnik + welfare 3 + nova 4", !q2.organic && q2.gmoFree && q2.welfare === 3 && q2.nova === 4],
  ["no quality labels", !q3.organic && !q3.gmoFree && q3.welfare === null && q3.nova === null],
] as const) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  labels: ${name}`);
}

const total = cases.length + 6;
console.log(failed ? `\n${failed} of ${total} failed` : `\nAll ${total} passed`);
process.exit(failed ? 1 : 0);
