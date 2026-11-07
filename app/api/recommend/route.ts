import { NextResponse } from "next/server";
import { z } from "zod";
import { recommend, RecommendError } from "@/lib/recommend";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  query: z.string().trim().max(120).optional(),
  store: z.string().trim().max(30).optional(),
  diet: z.enum(["any", "egg", "veg", "vegan"]).optional(),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success && parsed.error.issues.some((i) => i.path[0] === "diet")) {
    return NextResponse.json({ error: "Diet must be any, egg, veg or vegan." }, { status: 400 });
  }
  if (!parsed.success || !parsed.data.query) {
    return NextResponse.json({ error: 'Type what you\'re looking for, e.g. "best milk at Lidl".' }, { status: 400 });
  }
  try {
    return NextResponse.json(await recommend(parsed.data));
  } catch (e) {
    if (e instanceof RecommendError) return NextResponse.json({ error: e.message }, { status: 422 });
    console.error(e);
    return NextResponse.json({ error: "Couldn't reach Open Food Facts. Try again in a minute." }, { status: 502 });
  }
}
