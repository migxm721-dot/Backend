const db = require('../db/db');
const logger = require('./logger');

const logAudit = async (adminId, adminUsername, action, details) => {
  try {
    await db.query(
      'INSERT INTO audit_logs (admin_id, admin_username, action, details, created_at) VALUES ($1, $2, $3, $4, NOW())',
      [adminId, adminUsername, action, JSON.stringify(details)]
    );
  } catch (error) {
    logger.error('AUDIT_LOG_ERROR', { error: error.message, action, adminUsername });
  }
};

module.exports = { logAudit };
