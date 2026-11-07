import { NextResponse } from "next/server";
import { z } from "zod";
import { searchProducts } from "@/lib/search";

export const runtime = "nodejs";

const Body = z.object({ query: z.string().trim().min(2).max(100) });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Type at least two letters of the product name." }, { status: 400 });
  try {
    return NextResponse.json({ matches: await searchProducts(parsed.data.query) });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Couldn't reach Open Food Facts to search. Try again in a minute." }, { status: 502 });
  }
}
