import { NextResponse } from "next/server";
import { z } from "zod";
import { llmConfigured, translateIngredients } from "@/lib/llm";

// Second, optional step after a check: English names for ingredients our dictionary doesn't know.
export const runtime = "nodejs";

const Body = z.object({ items: z.array(z.string().min(1).max(200)).min(1).max(40) });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  if (!llmConfigured()) return NextResponse.json({ translations: parsed.data.items.map(() => null) });
  try {
    return NextResponse.json({ translations: await translateIngredients(parsed.data.items) });
  } catch {
    // Translation is a nice-to-have: on any failure the page keeps showing "no translation yet".
    return NextResponse.json({ translations: parsed.data.items.map(() => null) });
  }
}
