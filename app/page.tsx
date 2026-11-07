"use client";

import { useRef, useState } from "react";
import type { CheckResult } from "@/lib/check";
import type { ProductMatch } from "@/lib/search";
import type { Category } from "@/lib/rules";
import type { Diet, RecommendResult } from "@/lib/recommend";
import storesData from "@/data/stores.json";

const STORE_OPTIONS = storesData.stores.map((s) => ({ id: s.id, label: s.label }));
const DIET_OPTIONS: { id: Diet; label: string }[] = [
  { id: "any", label: "Any diet" },
  { id: "egg", label: "Veg + egg" },
  { id: "veg", label: "Vegetarian" },
  { id: "vegan", label: "Vegan" },
];

// Order matters: this is the scale shown on every result, from most to least restrictive.
const CATEGORIES: { id: Exclude<Category, "unclear">; label: string; de: string; hint: string }[] = [
  { id: "vegan", label: "Vegan", de: "Vegan", hint: "No animal products" },
  { id: "veg", label: "Veg", de: "Vegetarisch, ohne Ei", hint: "No meat, fish, gelatine or egg" },
  { id: "egg", label: "Contains egg", de: "Enthält Ei", hint: "Veg, but has egg" },
  { id: "non_veg", label: "Non-veg", de: "Nicht vegetarisch", hint: "Meat, fish, gelatine…" },
];

const TITLE: Record<Category, string> = {
  vegan: "Vegan",
  veg: "Veg",
  egg: "Contains egg",
  non_veg: "Non-veg",
  unclear: "Unclear",
};

const TITLE_DE: Record<Category, string> = {
  vegan: "Vegan",
  veg: "Vegetarisch, ohne Ei",
  egg: "Enthält Ei",
  non_veg: "Nicht vegetarisch",
  unclear: "Unklar, bitte Packung prüfen",
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const STATUS_TEXT: Record<CheckResult["additives"][number]["status"], string> = {
  plant: "Plant-based",
  animal: "Animal-based",
  insect: "From insects",
  unknown: "Source not stated",
};

const SOURCE_TEXT: Record<CheckResult["source"], string> = {
  openfoodfacts: "Ingredients from Open Food Facts (barcode)",
  photo: "Ingredients read from your photo by AI",
  text: "Ingredients from pasted text",
};

// Shrink big phone photos before upload: faster, and stays under model size limits.
async function toResizedDataUrl(file: File, maxSide = 1600): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const isProductCode = (t: string | undefined | null) => !!t && /^\d{6,14}$/.test(t);

// Phone photos are big, rotated and the barcode is often small, so try several ways:
// 1) the browser's built-in barcode reader (Chrome/Edge on Mac, Android),
// 2) zxing at several sizes and rotations, with "try harder" on.
async function findBarcode(file: File): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null;
  }

  // 1. Built-in BarcodeDetector, where the browser has one.
  const Detector = (window as unknown as { BarcodeDetector?: new (o: object) => { detect(s: ImageBitmap): Promise<{ rawValue: string }[]> } }).BarcodeDetector;
  if (Detector) {
    try {
      const found = await new Detector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] }).detect(bitmap);
      const hit = found.find((f) => isProductCode(f.rawValue));
      if (hit) return hit.rawValue;
    } catch {
      /* fall through to zxing */
    }
  }

  // 2. zxing, trying different scales and rotations.
  try {
    const { BrowserMultiFormatReader } = await import("@zxing/browser");
    const { DecodeHintType, BarcodeFormat } = await import("@zxing/library");
    const hints = new Map<number, unknown>([
      [DecodeHintType.TRY_HARDER, true],
      [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E]],
    ]);
    const reader = new BrowserMultiFormatReader(hints as Map<never, unknown>);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const longSide = Math.max(bitmap.width, bitmap.height);

    for (const target of [1200, 1800, 800, 2600]) {
      const scale = Math.min(1, target / longSide);
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      for (const rotate of [0, 90]) {
        canvas.width = rotate ? h : w;
        canvas.height = rotate ? w : h;
        ctx.save();
        if (rotate) {
          ctx.translate(h, 0);
          ctx.rotate(Math.PI / 2);
        }
        ctx.drawImage(bitmap, 0, 0, w, h);
        ctx.restore();
        try {
          const text = reader.decodeFromCanvas(canvas).getText();
          if (isProductCode(text)) return text;
        } catch {
          /* not found at this size/rotation */
        }
      }
    }
  } catch {
    /* library failed to load */
  }
  return null;
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ProductMatch[] | null>(null);
  const [matchNote, setMatchNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const [recQuery, setRecQuery] = useState("");
  const [recStore, setRecStore] = useState("any");
  const [recDiet, setRecDiet] = useState<Diet>("any");
  const [recBusy, setRecBusy] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const [rec, setRec] = useState<RecommendResult | null>(null);

  function pick(f: File | undefined | null) {
    if (!f || !f.type.startsWith("image/")) return;
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(URL.createObjectURL(f));
    setResult(null);
    setError(null);
  }

  function clearImage() {
    if (preview) URL.revokeObjectURL(preview);
    setFile(null);
    setPreview(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  // After the result is shown, ask the AI for English names the dictionary didn't have.
  async function fillTranslations(shown: CheckResult) {
    const missing = [...new Set(shown.ingredients.rows.filter((r) => !r.en).map((r) => r.de))].slice(0, 40);
    if (!missing.length) return;
    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: missing }),
      });
      const { translations } = (await res.json()) as { translations?: (string | null)[] };
      if (!translations) return;
      const map = new Map(missing.map((de, i) => [de, translations[i]]));
      // Only update if this result is still the one on screen.
      setResult((current) =>
        current !== shown
          ? current
          : {
              ...shown,
              ingredients: {
                ...shown.ingredients,
                rows: shown.ingredients.rows.map((r) => (r.en ? r : { ...r, en: map.get(r.de) ?? null })),
              },
            },
      );
    } catch {
      /* keep "no translation yet" */
    }
  }

  // Sends one check to the server and shows the result (or hands over to a name search).
  async function postCheck(body: Record<string, string>) {
    // Free AI models can be slow: tell the user it is still working.
    const slow = setTimeout(() => setStatus("Still reading… the free AI model can take up to 30 seconds"), 8000);
    try {
      const res = await fetch("/api/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const raw = await res.text();
      let data: (CheckResult & { error?: string; search?: { query: string } }) | null = null;
      try {
        data = JSON.parse(raw);
      } catch {
        // The server sent something that isn't our answer (a timeout or gateway error page).
        throw new Error("The check took too long and was cut off. Please try again in a minute.");
      }
      if (data?.search) {
        clearTimeout(slow);
        await searchByName(data.search.query, `No ingredient list in this photo, but it looks like “${data.search.query}”. Is it one of these?`);
        return;
      }
      if (!res.ok || !data || data.error) throw new Error(data?.error || "Check failed.");
      setResult(data);
      void fillTranslations(data);
    } finally {
      clearTimeout(slow);
    }
  }

  async function searchByName(q: string, note?: string) {
    setStatus(`Searching for “${q}”…`);
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    const data = (await res.json().catch(() => ({}))) as { matches?: ProductMatch[]; error?: string };
    if (!res.ok || !data.matches) throw new Error(data.error || "Search failed.");
    if (!data.matches.length) {
      throw new Error(`Couldn’t find “${q}” in Open Food Facts. Try a shorter name, or take a photo of the ingredient list.`);
    }
    setMatches(data.matches);
    setMatchNote(note ?? "Pick your product:");
  }

  async function run(task: () => Promise<void>) {
    setError(null);
    setResult(null);
    setMatches(null);
    setMatchNote(null);
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check failed.");
    } finally {
      setStatus(null);
    }
  }

  function check() {
    return run(async () => {
      if (file && preview) {
        setStatus("Looking for a barcode…");
        const barcode = await findBarcode(file);
        const body: Record<string, string> = { image: await toResizedDataUrl(file) };
        if (barcode) body.barcode = barcode;
        setStatus(barcode ? `Barcode ${barcode} found — looking it up…` : "Reading the label…");
        await postCheck(body);
      } else if (text.trim()) {
        setStatus("Checking ingredients…");
        await postCheck({ text: text.trim() });
      } else if (query.trim().length >= 2) {
        await searchByName(query.trim());
      } else {
        setError("Upload a photo of the label, paste the ingredient list, or type the product name.");
      }
    });
  }

  function checkMatch(m: { code: string; name: string }) {
    return run(async () => {
      setStatus(`Checking ${m.name}…`);
      await postCheck({ barcode: m.code });
      resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function findBest() {
    if (recQuery.trim().length < 2) {
      setRecError('Type what you\u2019re looking for, e.g. \u201cbest milk at Lidl\u201d.');
      return;
    }
    setRecBusy(true);
    setRecError(null);
    setRec(null);
    try {
      const res = await fetch("/api/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: recQuery.trim(), store: recStore, diet: recDiet }),
      });
      const data = (await res.json().catch(() => null)) as (RecommendResult & { error?: string }) | null;
      if (!res.ok || !data || data.error) throw new Error(data?.error || "Couldn\u2019t get recommendations. Try again in a minute.");
      setRec(data);
    } catch (e) {
      setRecError(e instanceof Error ? e.message : "Couldn\u2019t get recommendations.");
    } finally {
      setRecBusy(false);
    }
  }

  const busy = status !== null;

  return (
    <main className="wrap">
      <header className="brand">
        <span className="wordmark">food lens</span>
        <span className="divider" />
        <span className="tag">AI grocery<br />decision assistant</span>
      </header>

      <h1>
        Can I eat this?
        <span>Photograph the label, paste the ingredients or type the product name.</span>
      </h1>

      <section className="card">
        <div className="field-label">Label photo</div>
        {preview ? (
          <div className="preview">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview} alt="Uploaded label" />
            <button className="link" onClick={clearImage}>Remove photo</button>
          </div>
        ) : (
          <label
            className={`drop ${dragging ? "over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files[0]); }}
          >
            <input ref={inputRef} type="file" accept="image/*" onChange={(e) => pick(e.target.files?.[0])} hidden />
            <span className="drop-icon" aria-hidden>⬆</span>
            <strong>Drop a photo here or click to upload</strong>
            <small>Ingredient list (Zutaten), barcode or front of pack</small>
          </label>
        )}

        {!preview && (
          <details className="paste">
            <summary>Or paste the ingredient list</summary>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Zutaten: Zucker, Glukosesirup, Gelatine, …"
              rows={4}
            />
          </details>
        )}

        {!preview && (
          <details className="paste">
            <summary>Or search by product name</summary>
            <form
              className="name-search"
              onSubmit={(e) => {
                e.preventDefault();
                void check();
              }}
            >
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. Haribo Goldbären"
                aria-label="Product name"
              />
            </form>
          </details>
        )}

        <button className="primary" onClick={check} disabled={busy}>
          {busy ? status : "Check"}
        </button>

        {error && <p className="error">{error}</p>}

        {matches && (
          <div className="matches" aria-live="polite">
            {matchNote && <p className="match-note">{matchNote}</p>}
            {matches.map((m) => (
              <button key={m.code} className="match" onClick={() => void checkMatch(m)} disabled={busy}>
                {m.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.imageUrl} alt="" loading="lazy" />
                ) : (
                  <span className="match-noimg" aria-hidden />
                )}
                <span className="match-text">
                  <strong>{m.name}</strong>
                  <small>{[m.brand, m.quantity].filter(Boolean).join(" · ")}</small>
                  {!m.hasIngredients && <small className="match-warn">Ingredient list may be missing</small>}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <div ref={resultRef}>{result && <ResultCard r={result} />}</div>

      <section className="card best">
        <h2>
          Find the best option
          <span lang="de">Das Beste im Regal finden</span>
        </h2>
        <p className="best-intro">Ask for a product at a store, e.g. “best milk at Lidl” or “vegan yoghurt at Aldi”. Ranked by quality, not price.</p>
        <form
          className="best-form"
          onSubmit={(e) => {
            e.preventDefault();
            void findBest();
          }}
        >
          <input
            type="search"
            value={recQuery}
            onChange={(e) => setRecQuery(e.target.value)}
            placeholder="best milk at Lidl"
            aria-label="What are you looking for?"
          />
          <div className="best-selects">
            <select value={recStore} onChange={(e) => setRecStore(e.target.value)} aria-label="Store">
              <option value="any">Store from my text / any</option>
              {STORE_OPTIONS.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
            <select value={recDiet} onChange={(e) => setRecDiet(e.target.value as Diet)} aria-label="Diet">
              {DIET_OPTIONS.map((d) => (
                <option key={d.id} value={d.id}>{d.label}</option>
              ))}
            </select>
          </div>
          <button className="primary" type="submit" disabled={recBusy}>
            {recBusy ? "Checking products… (up to 15 s)" : "Find the best"}
          </button>
        </form>

        {recError && <p className="error">{recError}</p>}

        {rec && (
          <div className="recs" aria-live="polite">
            <p className="match-note">
              Best <strong>{rec.interpreted.product}</strong>
              {rec.interpreted.store ? <> at <strong>{rec.interpreted.store}</strong></> : " in Germany"}
              {rec.interpreted.diet !== "any" && <> · {DIET_OPTIONS.find((d) => d.id === rec.interpreted.diet)?.label}</>}
            </p>
            {rec.items.map((it, i) => (
              <button key={it.code} className="rec" onClick={() => void checkMatch(it)} disabled={busy}>
                <span className="rec-rank">{i + 1}</span>
                {it.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={it.imageUrl} alt="" loading="lazy" />
                ) : (
                  <span className="match-noimg" aria-hidden />
                )}
                <span className="rec-text">
                  <strong lang="de">{it.name}</strong>
                  <small>{[it.brand, it.quantity].filter(Boolean).join(" · ")}</small>
                  <span className="rec-tags">
                    <span className={`chip ${it.category}`}>{TITLE[it.category]}</span>
                    {it.nutriScore && <span className={`nschip ns-${it.nutriScore.toLowerCase()}`}>Nutri-Score {it.nutriScore}</span>}
                  </span>
                  {it.good.filter((g) => !g.startsWith("Nutri-Score")).length > 0 && (
                    <small className="rec-good">✓ {it.good.filter((g) => !g.startsWith("Nutri-Score")).join(" · ")}</small>
                  )}
                  {it.bad.filter((b) => !b.startsWith("Nutri-Score")).length > 0 && (
                    <small className="rec-bad">! {it.bad.filter((b) => !b.startsWith("Nutri-Score")).join(" · ")}</small>
                  )}
                </span>
              </button>
            ))}
            <p className="best-note">{rec.note}{rec.items.length > 0 && " Tap a product for the full check."}</p>
          </div>
        )}
      </section>

      <footer>
        Prototype. Food Lens can be wrong — for allergies, always read the pack yourself.
      </footer>
    </main>
  );
}

function ResultCard({ r }: { r: CheckResult }) {
  return (
    <section className={`card result ${r.category}`} aria-live="polite">
      <div className="verdict-row">
        <div className="verdict-main">
          <span className={`mark ${r.category}`} aria-hidden />
          <div>
            <div className="verdict">{TITLE[r.category]}</div>
            <div className="verdict-de" lang="de">{TITLE_DE[r.category]}</div>
            {r.product.name && <div className="product" lang="de">{r.product.name}</div>}
            {r.product.nameEn && <div className="product">{r.product.nameEn}</div>}
          </div>
        </div>
        <div className="confidence" title="How complete and certain the ingredient evidence is">
          <span>{r.confidence}%</span>
          <small>confidence</small>
        </div>
      </div>
      <div className="meter"><div style={{ width: `${r.confidence}%` }} /></div>

      <ol className="scale" aria-label="Category scale">
        {CATEGORIES.map((c) => (
          <li key={c.id} className={`${c.id} ${r.category === c.id ? "on" : ""}`} aria-current={r.category === c.id}>
            <span className={`mark small ${c.id}`} aria-hidden />
            <strong>{c.label}</strong>
            <small className="de" lang="de">{c.de}</small>
            <small>{c.hint}</small>
          </li>
        ))}
      </ol>

      <ul className="reasons">
        {r.reasons.map((x) => <li key={x}>{x}</li>)}
      </ul>

      {r.hits.length > 0 && (
        <div className="chips">
          {r.hits.map((h) => (
            <span key={h.ruleId + h.matched} className={`chip ${h.cls}`}>
              {h.label} <em lang="de">“{h.matched}”</em>
              {h.matchedEn && h.matchedEn.toLowerCase() !== h.matched.toLowerCase() && <em> = {h.matchedEn}</em>}
            </span>
          ))}
        </div>
      )}

      {r.additives.length > 0 && (
        <div className="additives">
          <div className="field-label">Plant or animal? · Pflanzlich oder tierisch?</div>
          {r.additives.map((a) => (
            <div key={a.code} className={`additive ${a.status}`}>
              <div className="additive-head">
                <strong>{a.code}</strong>
                <span className="additive-name">{a.name} <em lang="de">“{a.matched}”</em></span>
                <span className={`status ${a.status}`}>{STATUS_TEXT[a.status]}</span>
              </div>
              <p className="additive-about">{a.about}</p>
              <p className="additive-evidence">{a.evidence}</p>
            </div>
          ))}
        </div>
      )}

      {r.nutrition && <NutritionPanel n={r.nutrition} />}

      {r.traces.length > 0 && (
        <div className="traces">
          <strong>Trace warning · Spurenhinweis</strong> (matters for allergies, not counted for the category)
          {r.traces.map((t, i) => (
            <div key={i} className="pair">
              {t.de && <span lang="de">{cap(t.de)}</span>}
              <span>{t.en}</span>
            </div>
          ))}
        </div>
      )}

      <details className="ingredients" open>
        <summary>Ingredients · Zutaten</summary>
        <div className="table-wrap">
          <table className="ing">
            <thead>
              <tr><th lang="de">Deutsch</th><th>English</th></tr>
            </thead>
            <tbody>
              {r.ingredients.rows.map((row, i) => {
                const rowText = row.de.toLowerCase().replace(/(^|[^a-zäöüß])e[\s-]?(\d{3,4})/g, "$1e$2");
                const hit = r.hits.find((h) => rowText.includes(h.matched.toLowerCase()));
                return (
                  <tr key={i} className={hit ? `flag ${hit.cls}` : ""}>
                    <td lang="de" style={{ paddingLeft: `${8 + row.depth * 16}px` }}>{row.de}</td>
                    <td style={{ paddingLeft: `${8 + row.depth * 16}px` }}>{row.en ?? <span className="na">no translation yet</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <details className="fulltext">
          <summary>Full label text</summary>
          <div className="field-label" lang="de">Deutsch</div>
          <p lang="de">{r.ingredients.original}</p>
          {r.ingredients.english && (
            <>
              <div className="field-label">English{r.source === "openfoodfacts" ? " (from Open Food Facts)" : ""}</div>
              <p>{r.ingredients.english}</p>
            </>
          )}
        </details>
      </details>

      <div className="source">
        {SOURCE_TEXT[r.source]}
        {r.barcode && ` · ${r.barcode}`}
      </div>
    </section>
  );
}

const NUTRIENTS: { key: "fat" | "saturatedFat" | "sugars" | "salt"; en: string; de: string }[] = [
  { key: "fat", en: "Fat", de: "Fett" },
  { key: "saturatedFat", en: "Saturated fat", de: "gesättigte Fettsäuren" },
  { key: "sugars", en: "Sugars", de: "Zucker" },
  { key: "salt", en: "Salt", de: "Salz" },
];

const LEVEL_TEXT = { low: "Low", moderate: "Medium", high: "High" } as const;

function NutritionPanel({ n }: { n: NonNullable<CheckResult["nutrition"]> }) {
  return (
    <div className="nutrition">
      <div className="field-label">
        Nutrition · Nährwerte <span className="per">per {n.basis}</span>
      </div>
      <div className="nutri-top">
        {n.nutriScore && (
          <span className={`nutriscore ns-${n.nutriScore}`}>
            Nutri-Score <b>{n.nutriScore.toUpperCase()}</b>
          </span>
        )}
        {n.energyKcal != null && <span className="kcal">{Math.round(n.energyKcal)} kcal</span>}
      </div>
      <ul className="levels">
        {NUTRIENTS.map(({ key, en, de }) => {
          const level = n.levels[key];
          const value = n.per100[key];
          if (level == null && value == null) return null;
          return (
            <li key={key} className={`lvl ${level ?? "none"}`}>
              <span className="lvl-name">
                {en} <em lang="de">{de}</em>
              </span>
              <span className="lvl-val">{value != null ? `${value.toLocaleString("en", { maximumFractionDigits: 2 })} g` : ""}</span>
              <span className="lvl-tag">{level ? LEVEL_TEXT[level] : "No level"}</span>
            </li>
          );
        })}
      </ul>
      <p className="nutri-note">
        {n.source === "photo" ? "Read from your photo." : "From Open Food Facts."} Nutrition doesn&apos;t change the veg category.
      </p>
    </div>
  );
}
