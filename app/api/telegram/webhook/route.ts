import { NextRequest, NextResponse } from "next/server";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function sendMessage(chatId: number, text: string, extra?: any) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      ...extra,
    }),
  });
}

async function editMessage(chatId: number, messageId: number, text: string, extra?: any) {
  await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "Markdown",
      ...extra,
    }),
  });
}

async function answerCallback(id: string) {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id }),
  });
}

function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ["📊 Status", "🏃 Log Aktivitas"],
        ["🧠 Coach Hari Ini", "📈 Progress"],
        ["⚙️ Settings"],
      ],
      resize_keyboard: true,
      persistent: true,
    },
  };
}

function statusInline() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔄 Sync Strava", callback_data: "sync" }],
        [
          { text: "📅 Mingguan", callback_data: "weekly" },
          { text: "📆 Bulanan", callback_data: "monthly" },
        ],
      ],
    },
  };
}

function logActivityInline() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🏃 Run", callback_data: "log_run" },
          { text: "🚴 Ride", callback_data: "log_ride" },
        ],
        [
          { text: "🏔 Trail", callback_data: "log_trail" },
          { text: "🏋️ Strength", callback_data: "log_strength" },
        ],
        [{ text: "❌ Batal", callback_data: "cancel" }],
      ],
    },
  };
}

function rpeInline(type: string) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "RPE 5", callback_data: `rpe_${type}_5` },
          { text: "RPE 6", callback_data: `rpe_${type}_6` },
          { text: "RPE 7", callback_data: `rpe_${type}_7` },
        ],
        [
          { text: "RPE 8", callback_data: `rpe_${type}_8` },
          { text: "RPE 9", callback_data: `rpe_${type}_9` },
        ],
      ],
    },
  };
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  // ======================
  // HANDLE CALLBACK BUTTON
  // ======================
  if (body.callback_query) {
    const callback = body.callback_query;
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;
    const action = callback.data;

    await answerCallback(callback.id);

    switch (action) {
      case "sync":
        await editMessage(chatId, messageId, "⏳ Syncing Strava...");
        // TODO: call your sync function
        await sendMessage(chatId, "✅ Sync selesai.");
        break;

      case "weekly":
        await editMessage(chatId, messageId, "📅 *Progress Mingguan*\n\n(isi data disini)");
        break;

      case "monthly":
        await editMessage(chatId, messageId, "📆 *Progress Bulanan*\n\n(isi data disini)");
        break;

      case "log_run":
      case "log_ride":
      case "log_trail":
      case "log_strength":
        const type = action.replace("log_", "");
        await editMessage(
          chatId,
          messageId,
          `Pilih RPE untuk *${type.toUpperCase()}*`,
          rpeInline(type)
        );
        break;

      case "cancel":
        await editMessage(chatId, messageId, "❌ Dibatalkan.");
        break;

      default:
        if (action.startsWith("rpe_")) {
          const parts = action.split("_");
          const type = parts[1];
          const rpe = parts[2];

          await editMessage(
            chatId,
            messageId,
            `✅ Aktivitas *${type.toUpperCase()}* tersimpan\nRPE: *${rpe}*`
          );

          // TODO: save to database
        }
        break;
    }

    return NextResponse.json({ ok: true });
  }

  // ======================
  // HANDLE TEXT MESSAGE
  // ======================
  if (body.message) {
    const chatId = body.message.chat.id;
    const text = body.message.text;

    switch (text) {
      case "/start":
        await sendMessage(
          chatId,
          "👋 Selamat datang di *Apexnity*\n\nPilih menu di bawah 👇",
          mainMenuKeyboard()
        );
        break;

      case "📊 Status":
        await sendMessage(
          chatId,
          "📊 *Status Hari Ini*\n\n(isi summary kamu disini)",
          statusInline()
        );
        break;

      case "🏃 Log Aktivitas":
        await sendMessage(
          chatId,
          "Pilih jenis aktivitas 👇",
          logActivityInline()
        );
        break;

      case "🧠 Coach Hari Ini":
        await sendMessage(
          chatId,
          "🧠 *Rekomendasi Coach Hari Ini*\n\n(isi rekomendasi disini)"
        );
        break;

      case "📈 Progress":
        await sendMessage(
          chatId,
          "📈 Progress kamu minggu ini...",
          statusInline()
        );
        break;

      case "⚙️ Settings":
        await sendMessage(chatId, "⚙️ Settings (coming soon)");
        break;

      default:
        await sendMessage(chatId, "Gunakan menu tombol ya 👇", mainMenuKeyboard());
        break;
    }

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
