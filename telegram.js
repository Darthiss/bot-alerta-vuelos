// Archivo: telegram.js
const axios = require("axios");

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown"
    });
  } catch (err) {
    console.error("❌ Error enviando mensaje a Telegram:", err.message);
  }
}

module.exports = { sendTelegram };
