export function mainMenu() {
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

export function activityTypes() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🏃 Run", callback_data: "log:run" },
          { text: "🚴 Ride", callback_data: "log:ride" },
        ],
        [
          { text: "🏔 Trail", callback_data: "log:trail" },
          { text: "🏋️ Strength", callback_data: "log:strength" },
        ],
      ],
    },
  };
}

export function rpeKeyboard(type: string) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "RPE 5", callback_data: `rpe:${type}:5` },
          { text: "RPE 6", callback_data: `rpe:${type}:6` },
          { text: "RPE 7", callback_data: `rpe:${type}:7` },
        ],
        [
          { text: "RPE 8", callback_data: `rpe:${type}:8` },
          { text: "RPE 9", callback_data: `rpe:${type}:9` },
        ],
      ],
    },
  };
}
