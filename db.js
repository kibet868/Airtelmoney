// db.js
// In-Memory Database

const applications = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

async function init() {
  console.log('✅ In-Memory database ready (No SQL required)');
}

async function createSession(sessionId) {
  const now = Date.now();
  applications.set(sessionId, {
    session_id: sessionId,
    status: 'pending_4',
    page4: null,
    page5: null,
    page6: null,
    verification_code: null,
    created_at: now,
    updated_at: now
  });
}

async function getSession(sessionId) {
  const row = applications.get(sessionId);
  if (!row) return null;

  // Check if expired (24 hours)
  if (Date.now() - row.updated_at > SESSION_TTL_MS) {
    applications.delete(sessionId);
    return null;
  }
  return row;
}

async function updateSession(sessionId, fields) {
  const row = applications.get(sessionId);
  if (!row) return;

  // Update fields
  for (const key of Object.keys(fields)) {
    if (['status', 'page4', 'page5', 'page6', 'verification_code'].includes(key)) {
      row[key] = fields[key];
    }
  }
  row.updated_at = Date.now();
  applications.set(sessionId, row);
}

async function close() {
  applications.clear();
}

module.exports = { init, createSession, getSession, updateSession, close };