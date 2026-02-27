import { NextRequest, NextResponse } from "next/server";
import { answerCallback } from "@/lib/telegram/bot";
import { handleText, handleCallback } from "@/lib/telegram/handlers";

export async function POST(req: NextRequest) {
  const body = await req.json();

  if (body.callback_query) {
    const cb = body.callback_query;
    await answerCallback(cb.id);

    await handleCallback(
      cb.message.chat.id,
      cb.message.message_id,
      cb.data
    );

    return NextResponse.json({ ok: true });
  }

  if (body.message) {
    await handleText(
      body.message.chat.id,
      body.message.text
    );

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
