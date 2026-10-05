// One LLM client for Groq or OpenRouter. Both speak the OpenAI API format,
// so switching provider is only an env change (see .env.example).
import OpenAI from "openai";
import { z } from "zod";

const PROVIDERS = {
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    defaultModel: "meta-llama/llama-4-scout-17b-16e-instruct",
    freeFallbacks: [] as string[],
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    defaultModel: "qwen/qwen3.8-27b:free",
    // Tried in order when a free model is overloaded (all are $0)
    freeFallbacks: [
      "qwen/qwen3.8-27b:free",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
      "google/gemma-4-31b-it:free",
      "dots-studio/dots-3-note-preview:free",
      "google/gemma-4-26b-a4b-it:free",
    ],
  },
} as const;

type ProviderName = keyof typeof PROVIDERS;

export function llmConfigured(): boolean {
  return Boolean(process.env.LLM_API_KEY);
}

function client() {
  const name = (process.env.LLM_PROVIDER || "groq").toLowerCase() as ProviderName;
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown LLM_PROVIDER "${name}". Use "groq" or "openrouter".`);
  // LLM_MODEL can be one model or a comma-separated list; free fallbacks are added after it.
  const chosen = (process.env.LLM_MODEL || provider.defaultModel).split(",").map((m) => m.trim()).filter(Boolean);
  const models = [...new Set([...chosen, ...provider.freeFallbacks])];
  // Cost lock: on OpenRouter only ":free" models (price $0) are allowed,
  // unless you deliberately set LLM_ALLOW_PAID=true.
  const paid = models.find((m) => !m.endsWith(":free"));
  if (name === "openrouter" && paid && process.env.LLM_ALLOW_PAID !== "true") {
    throw new Error(
      `Blocked: "${paid}" is not a free OpenRouter model. Use models ending in ":free", or set LLM_ALLOW_PAID=true to allow paid models.`,
    );
  }
  return {
    models,
    api: new OpenAI({
      apiKey: process.env.LLM_API_KEY,
      baseURL: provider.baseURL,
      // OpenRouter uses these to show your app name in its dashboard (optional)
      defaultHeaders: name === "openrouter" ? { "HTTP-Referer": "https://food-lens-kounpal.netlify.app", "X-Title": "Food Lens" } : undefined,
    }),
  };
}

const LabelSchema = z.object({
  is_food_label: z.boolean().default(true),
  what_it_is: z.string().nullable().optional(),
  legibility: z.enum(["clear", "partial", "unreadable"]).catch("partial"),
  product_name: z.string().nullable().optional(),
  ingredients_original: z.string().default(""),
  ingredients_english: z.string().default(""),
  ingredients_list: z.array(z.object({ de: z.string(), en: z.string().nullable().optional() })).optional(),
});
export type LabelReading = z.infer<typeof LabelSchema>;

const PROMPT = `You read photos of product packaging sold in Germany.
Find the ingredient list (usually starts with "Zutaten:") and return ONLY this JSON object, no other text:
{
  "is_food_label": true/false,
  "what_it_is": "2-4 words saying what the product is, e.g. 'chocolate biscuits', 'dishwashing liquid'",
  "legibility": "clear" | "partial" | "unreadable",
  "product_name": string or null,
  "ingredients_original": "the ingredient list copied exactly as printed, including E-numbers and any 'Kann Spuren von...' line"
}
Rules:
- Copy only text you can actually see. Never guess or add ingredients that are not visible.
- Do not translate. Keep the answer short: only the fields above.
- If part of the list is cut off, blurred or covered, set legibility to "partial".
- If there is no ingredient list in the photo, set ingredients_original to "" and legibility to "unreadable".
- is_food_label is false for anything that is not food or drink (cleaning products, cosmetics, medicine, pet food) or not a product label at all.
- Do not judge whether the food is vegetarian. Only transcribe.`;

function friendly(status: number | undefined, model: string): string | null {
  if (status === 429) return "The free AI models are busy, or today's free limit is used up. Try again in a minute, or tomorrow.";
  if (status === 401) return "The AI key was rejected. Check LLM_API_KEY.";
  if (status === 402) return "OpenRouter asked for payment, so the request was stopped. Use a model ending in \":free\".";
  if (status === 404) return `The AI model "${model}" wasn't found. Pick another free model.`;
  return null;
}

type Content = OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"];

/**
 * Ask the free models for a JSON answer inside a fixed time budget.
 * The hosting platform stops a request after 30 seconds, so this never waits longer than budgetMs:
 * - a model that fails (busy, refused, empty or unreadable answer) is replaced by the next one at once;
 * - if a model is still silent after hedgeMs, the next one is started alongside it and the first good answer wins;
 * - when the budget runs out, everything is cancelled and a clear message is returned.
 */
function askJson<T>(content: Content, schema: z.ZodType<T>, maxTokens: number, budgetMs: number, hedgeMs = 8000): Promise<T> {
  const { api, models } = client();
  const abort = new AbortController();

  const attempt = async (model: string): Promise<T> => {
    const res = await api.chat.completions.create(
      { model, temperature: 0, max_tokens: maxTokens, messages: [{ role: "user", content }] },
      { timeout: budgetMs, maxRetries: 0, signal: abort.signal },
    );
    // OpenRouter can answer "200 OK" with an error object and no choices.
    const raw = res?.choices?.[0]?.message?.content;
    if (typeof raw !== "string" || !raw.trim()) {
      const code = (res as unknown as { error?: { code?: number } })?.error?.code;
      throw Object.assign(new Error("empty answer"), { status: code });
    }
    // Free models don't always support JSON mode, so pull the {...} block out of the reply.
    const parsed = schema.safeParse(JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)));
    if (!parsed.success) throw new Error("unexpected format");
    return parsed.data;
  };

  // Free models are a shared pool and are often "busy" for a few seconds at a time, so the list is
  // tried more than once: after each full pass there is a short pause, then it starts again.
  // MAX_ATTEMPTS protects the daily free allowance.
  const MAX_ATTEMPTS = 10;
  const PAUSE_BETWEEN_PASSES_MS = 2500;

  return new Promise<T>((resolve, reject) => {
    let attempts = 0;
    let active = 0;
    let done = false;
    let lastError = "The AI models didn't give a readable answer. Try again in a minute.";

    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearInterval(hedge);
      clearTimeout(kill);
      abort.abort();
      fn();
    };

    const launch = () => {
      if (done || attempts >= MAX_ATTEMPTS) return;
      const model = models[attempts % models.length];
      attempts++;
      active++;
      attempt(model).then(
        (value) => finish(() => resolve(value)),
        (e) => {
          active--;
          if (done) return;
          const status = (e as { status?: number }).status;
          if (status === 401 || status === 402) return finish(() => reject(new Error(friendly(status, model)!)));
          lastError = friendly(status, model) ?? lastError;
          if (attempts < MAX_ATTEMPTS) setTimeout(launch, attempts % models.length === 0 ? PAUSE_BETWEEN_PASSES_MS : 0);
          else if (active === 0) finish(() => reject(new Error(lastError)));
        },
      );
    };

    const hedge = setInterval(launch, hedgeMs);
    const kill = setTimeout(
      () =>
        finish(() =>
          reject(new Error("The free AI models are busy or too slow right now. Try again in a minute, or take a photo of the barcode instead.")),
        ),
      budgetMs,
    );
    launch();
  });
}

/** Read the ingredient list off a label photo. budgetMs keeps the whole check under the hosting time limit. */
export function readLabelFromImage(imageDataUrl: string, budgetMs = 21_000): Promise<LabelReading> {
  return askJson(
    [
      { type: "text", text: PROMPT },
      { type: "image_url", image_url: { url: imageDataUrl } },
    ],
    LabelSchema,
    1200,
    budgetMs,
  );
}

const TranslationSchema = z.object({ translations: z.array(z.string().nullable()) });

/** Translate German ingredient names the dictionary doesn't know. Returns one English string (or null) per input. */
export async function translateIngredients(items: string[], budgetMs = 20_000): Promise<(string | null)[]> {
  if (!items.length) return [];
  const prompt = `Translate these German food-label ingredient names into English.
Return ONLY this JSON object: {"translations": ["...", "..."]} with exactly ${items.length} entries, in the same order.
Use null for an entry that is not an ingredient or that you cannot translate. Keep each translation short.
${JSON.stringify(items)}`;
  const out = await askJson(prompt, TranslationSchema, 900, budgetMs, 6000);
  return items.map((_, i) => out.translations[i] ?? null);
}
