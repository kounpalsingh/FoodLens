# Food Lens

Upload a photo of a food label sold in Germany and find out whether the product is **Vegan, Veg, Contains egg, Non-veg or Unclear**. Every ingredient is shown in German and English, and the one that decided the answer is highlighted.

**Live demo:** https://food-lens-kounpal.netlify.app
**Background:** [Food Lens product teardown on Medium](https://medium.com/@kounpalsingh/food-lens-product-teardown-using-ai-to-make-grocery-decisions-simpler-a0bb47daad18)

This is a prototype. It can be wrong. For allergies, always read the pack yourself.

## Categories

| Category | Meaning |
|---|---|
| Vegan | No animal products at all |
| Veg | No meat, fish, gelatine or egg (milk and honey are fine) |
| Contains egg | Veg, but has egg |
| Non-veg | Meat, fish, seafood, gelatine/collagen, carmine (E120), insects, animal fat or enzymes |
| Unclear | Something that can be animal or plant and the label doesn't say (E471, "Lab", Parmesan, glycerin…) |

## How a check works

```
Photo ──► the browser looks for a barcode
            ├─ found ──► Open Food Facts ──► ingredient list
            └─ not found / not in the database ──► AI vision model copies the Zutaten off the photo
                                                    │
                        data/ingredient-rules.json ◄┘
                        rules decide the category (not the AI)
                                                    ▼
              category + confidence + reasons + German/English ingredient table
```

**The AI only reads the label. The rules decide.** The same label gets the same answer every time, and every result names the ingredient that caused it.

- "Kann Spuren von …" (may contain) lines are shown separately and don't change the category.
- Non-food products (cleaning products, cosmetics) are rejected with a clear message.
- For barcode products, Open Food Facts' own per-ingredient analysis is used as a second opinion.
- English names come from a German–English dictionary of about 4,800 ingredient names. Anything it doesn't know is translated by the AI in a second step.
- **Plant or animal?** Additives that can come from either (E471, E481, glycerin, L-cysteine, vitamin D3…) are listed with what they are and whether the source is known. A source counts only with evidence: words next to it on the label ("pflanzlich", "tierisch"), a product-wide statement ("alle Emulgatoren pflanzlichen Ursprungs"), or a vegan label on the product. Otherwise it says "Source not stated".
- **Nutrition level:** Nutri-Score and low / medium / high for fat, saturated fat, sugars and salt per 100 g (UK traffic-light thresholds), from Open Food Facts or read from the photo's nutrition table. It never changes the veg category.
- **Three ways in:** a label photo (barcode, ingredient list, or the front of the pack), pasted ingredients, or a product name. A front-of-pack photo or a typed name searches Open Food Facts and lets you pick the product.

### Confidence (a heuristic, not a probability)

| Situation | Confidence |
|---|---|
| A clearly non-veg or egg ingredient found (e.g. Gelatine) | 95% |
| Nothing found, list from Open Food Facts or pasted text | 90% (95% if Open Food Facts' own analysis agrees) |
| Nothing found, list read from a photo | 80% |
| Ambiguous ingredient (E471, "Lab", "Eiweiß") | about 55% → **Unclear** |
| Photo partly unreadable | at most 45% → **Unclear** |
| No ingredient list found | 25% → **Unclear** |

## Find the best option

Type a request like "best milk at Lidl", "vegan yoghurt at Aldi" or "Hafermilch bei Edeka" and get the top 5 products, ranked by quality. Prices are not included yet: Open Food Facts' price data covers too few German supermarket products.

1. **Understand the request** without AI: the store, the product type and the diet are matched from word lists (`data/stores.json`, `data/product-types.json`), in English or German. Small typos are fine ("choclate", "Kaufand"). If no product type matches, the remaining words are searched as free text ("Erdnüsse bei Kaufland").
2. **Find candidates** in Open Food Facts: products in that category, sold in Germany, from the store's own brands (Milbona and Vemondo for Lidl, ja! and REWE Bio for Rewe, and so on). Branded products a store also sells (e.g. Haribo at Lidl) aren't covered.
3. **Check each one** with the same rules as a barcode check, and drop those that don't fit the chosen diet or have no ingredient list.
4. **Rank** by Nutri-Score (counts most), organic, "Ohne Gentechnik", animal-welfare level (Haltungsform 3–4), processing (NOVA) and additives whose source is unknown. Every point is shown on the card as a reason.

All candidates are fetched in one request, searches are kept for an hour and product lookups for 6 hours, because Open Food Facts limits how often one server may ask. When it's busy anyway, fewer products are checked and the result says so.

## Run it locally

Needs Node.js 20 or newer.

```bash
npm install
cp .env.example .env.local   # optional: add an OpenRouter or Groq key
npm run dev                  # open http://localhost:3000
npm test                     # 65 sample labels with expected categories
npm run test:check           # 9 end-to-end checks of additive handling
npm run test:recommend       # 34 shopping requests (typos too) and quality labels
```

Without an AI key the app still works for photos that show a **barcode** and for **pasted ingredient text**. The key is only needed to read a photo of the ingredient list itself.

### AI settings (`.env.local`)

```
LLM_PROVIDER=openrouter      # or groq
LLM_API_KEY=                 # your key; never commit this file
LLM_MODEL=                   # optional; must be a model that accepts images
```

On OpenRouter the app only uses models ending in `:free` unless `LLM_ALLOW_PAID=true` is set. Free models are a shared pool, so they are slow at times and sometimes busy. A check gives up after about 26 seconds with a clear message, because the hosting platform stops requests at 30 seconds.

## Project layout

| Path | What it does |
|---|---|
| `app/page.tsx` | The page: upload, barcode reading, result card |
| `app/api/check/route.ts` | Runs one check |
| `app/api/translate/route.ts` | Translates ingredient names the dictionary doesn't know |
| `lib/check.ts` | Barcode → photo → text, then rules and confidence |
| `lib/rules.ts` | Rules engine (plain code, no AI) |
| `lib/translate.ts` | German → English dictionary lookup |
| `lib/llm.ts` | OpenRouter / Groq client with a time budget and free-model fallbacks |
| `lib/openfoodfacts.ts` | Barcode lookup |
| `lib/search.ts`, `app/api/search/route.ts` | Search by product name |
| `lib/additives.ts`, `data/additives.json` | Plant-or-animal additives and the evidence for each |
| `lib/nutrition.ts` | Nutri-Score and nutrient levels |
| `lib/recommend.ts`, `app/api/recommend/route.ts` | Find the best option at a store |
| `data/stores.json`, `data/product-types.json` | Stores and their own brands; product words mapped to Open Food Facts categories |
| `data/ingredient-rules.json` | **The ingredient rules. Edit this to change what is flagged.** |
| `data/glossary-de-en.json` | Hand-written German–English ingredient dictionary |
| `data/off-*.json` | Generated from the Open Food Facts ingredient taxonomy (`scripts/build-taxonomy.py`) |
| `scripts/test-rules.ts` | Sample labels with expected categories |
| `scripts/test-recommend.ts` | Shopping requests with the expected store, product and diet |
| `scripts/validate-off.ts` | Compares the rules with Open Food Facts on real German products |

## Not built yet

- Shelf-Safe Alternatives (the feature proposed in the teardown); "Find the best option" is a first step
- Prices ("best and cheap"), once there's a usable German price source
- Analytics events for the A/B test
- More diets (e.g. Jain)

## Data and credits

Product data and the ingredient taxonomy come from [Open Food Facts](https://world.openfoodfacts.org), available under the [Open Database License](https://opendatacommons.org/licenses/odbl/1-0/). Open Food Facts is edited by volunteers, so individual entries can be out of date or wrong.

Built by Kounpal Singh, with Claude writing most of the code.
