"use client";

import { useRef, useState } from "react";
import type { CheckResult } from "@/lib/check";
import type { Category } from "@/lib/rules";

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
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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

  async function check() {
    setError(null);
    setResult(null);
    let slow: ReturnType<typeof setTimeout> | undefined;
    try {
      const body: Record<string, string> = {};
      if (file && preview) {
        setStatus("Looking for a barcode…");
        const barcode = await findBarcode(file);
        if (barcode) body.barcode = barcode;
        body.image = await toResizedDataUrl(file);
        setStatus(barcode ? `Barcode ${barcode} found — looking it up…` : "Reading the ingredient list…");
      } else if (text.trim()) {
        body.text = text.trim();
        setStatus("Checking ingredients…");
      } else {
        setError("Upload a photo of the label, or paste the ingredient list.");
        return;
      }

      // Free AI models can be slow: tell the user it is still working.
      slow = setTimeout(() => setStatus("Still reading… the free AI model can take up to 30 seconds"), 8000);
      const res = await fetch("/api/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const raw = await res.text();
      let data: (CheckResult & { error?: string }) | null = null;
      try {
        data = JSON.parse(raw);
      } catch {
        // The server sent something that isn't our answer (a timeout or gateway error page).
        throw new Error("The check took too long and was cut off. Please try again in a minute.");
      }
      if (!res.ok || !data || data.error) throw new Error(data?.error || "Check failed.");
      setResult(data);
      void fillTranslations(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check failed.");
    } finally {
      clearTimeout(slow);
      setStatus(null);
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
        <span>Upload a photo of the label. Get an answer in seconds.</span>
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
            <small>Ingredient list (Zutaten) or barcode, JPG or PNG</small>
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

        <button className="primary" onClick={check} disabled={busy}>
          {busy ? status : "Check"}
        </button>

        {error && <p className="error">{error}</p>}
      </section>

      {result && <ResultCard r={result} />}

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
