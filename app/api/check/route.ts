import { NextResponse } from "next/server";
import { z } from "zod";
import { CheckError, runCheck } from "@/lib/check";

export const runtime = "nodejs";

const Body = z.object({
  barcode: z.string().regex(/^\d{6,14}$/).optional(),
  image: z.string().startsWith("data:image/").max(6_000_000).optional(),
  text: z.string().max(5000).optional(),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    return NextResponse.json(await runCheck(parsed.data));
  } catch (e) {
    const message =
      e instanceof CheckError ? e.message : "Something went wrong while checking. Please try again.";
    if (!(e instanceof CheckError)) console.error(e);
    return NextResponse.json({ error: message }, { status: e instanceof CheckError ? 422 : 500 });
  }
}
