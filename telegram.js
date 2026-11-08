const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Escape Markdown special chars to prevent injection
function esc(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function safeSend(chatId, text, options) {
  return bot.sendMessage(chatId, text, options);
}

module.exports = { bot, esc, safeSend };