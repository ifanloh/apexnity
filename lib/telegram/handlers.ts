import { sendMessage, editMessage } from "./bot";
import { mainMenu, activityTypes, rpeKeyboard } from "./keyboards";
import { setState, clearState } from "./state";

export async function handleText(chatId: number, text: string) {
  switch (text) {
    case "/start":
      return sendMessage(chatId, "👋 Selamat datang di *Apexnity*", mainMenu());

    case "🏃 Log Aktivitas":
      return sendMessage(chatId, "Pilih aktivitas 👇", activityTypes());

    case "📊 Status":
      return sendMessage(chatId, "📊 Status hari ini...", mainMenu());

    default:
      return sendMessage(chatId, "Gunakan tombol ya 👇", mainMenu());
  }
}

export async function handleCallback(chatId: number, messageId: number, action: string) {
  if (action.startsWith("log:")) {
    const type = action.split(":")[1];
    await setState(chatId, "WAITING_RPE", { type });

    return editMessage(
      chatId,
      messageId,
      `Pilih RPE untuk *${type.toUpperCase()}*`,
      rpeKeyboard(type)
    );
  }

  if (action.startsWith("rpe:")) {
    const parts = action.split(":");
    const type = parts[1];
    const rpe = parts[2];

    // TODO: save to activities table

    await clearState(chatId);

    return editMessage(
      chatId,
      messageId,
      `✅ *${type.toUpperCase()}* tersimpan\nRPE: *${rpe}*`
    );
  }
}
