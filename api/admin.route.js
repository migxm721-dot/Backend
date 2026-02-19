const logger = require('../utils/logger');
const express = require('express');
const { adminLimiter } = require('../middleware/rateLimiter');
const { logAudit } = require('../utils/auditLogger');
const router = express.Router();

router.use(adminLimiter);
const { superAdminMiddleware } = require('../middleware/auth');
const db = require('../db/db');

// Get dashboard stats
router.get('/stats', superAdminMiddleware, async (req, res) => {
  try {
    const totalUsers = await db.query('SELECT COUNT(*) as count FROM users');
    const activeRooms = await db.query('SELECT COUNT(*) as count FROM rooms');
    const pendingReports = await db.query('SELECT COUNT(*) as count FROM abuse_reports WHERE status = $1', ['pending']);

    res.json({
      totalUsers: totalUsers.rows[0]?.count || 0,
      activeRooms: activeRooms.rows[0]?.count || 0,
      pendingReports: pendingReports.rows[0]?.count || 0,
      onlineUsers: 0
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ message: 'Error fetching stats' });
  }
});

// Get all reports with pagination
router.get('/reports', superAdminMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    const reports = await db.query(
      `SELECT r.*, r.reporter as reporter_username, r.target as target_username
       FROM abuse_reports r
       ORDER BY r.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({ reports: reports.rows });
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({ message: 'Error fetching reports' });
  }
});

// Get rooms with pagination and search
router.get('/rooms', superAdminMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const search = req.query.search || '';
    const limit = 20;
    const offset = (page - 1) * limit;

    let query = 'SELECT * FROM rooms';
    let countQuery = 'SELECT COUNT(*) FROM rooms';
    const params = [];
    const countParams = [];

    if (search) {
      query += ' WHERE name ILIKE $1';
      countQuery += ' WHERE name ILIKE $1';
      params.push(`%${search}%`);
      countParams.push(`%${search}%`);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit);
    params.push(offset);

    const rooms = await db.query(query, params);
    const totalCountResult = await db.query(countQuery, countParams);
    const totalRooms = parseInt(totalCountResult.rows[0].count);

    res.json({ 
      rooms: rooms.rows,
      pagination: {
        total: totalRooms,
        page,
        limit,
        totalPages: Math.ceil(totalRooms / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching rooms:', error);
    res.status(500).json({ message: 'Error fetching rooms' });
  }
});

// Create user account (admin)
router.post('/create-account', superAdminMiddleware, async (req, res) => {
  try {
    const { username, email, password, role } = req.body;
    
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email and password are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check if user exists
    const existingUser = await db.query(
      'SELECT id FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)',
      [username, email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Username or email already in use' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO users (username, email, password, password_hash, role, is_active, activated_at, created_at, updated_at) 
       VALUES ($1, $2, $3, $3, $4, true, NOW(), NOW(), NOW()) RETURNING id, username, email, role`,
      [username, email, hashedPassword, role || 'user']
    );

    await logAudit(req.user.id, req.user.username, 'CREATE_ACCOUNT', {
      newUserId: result.rows[0].id,
      newUsername: username,
      role: role || 'user'
    });

    res.status(201).json({ 
      success: true, 
      message: 'Account created and activated successfully', 
      user: result.rows[0] 
    });
  } catch (error) {
    console.error('Error creating user account:', error);
    res.status(500).json({ error: 'Failed to create user account' });
  }
});

// Add coins/credits to user (admin)
const creditService = require('../services/creditService');
router.post('/add-coin', superAdminMiddleware, async (req, res) => {
  try {
    const { userId, username, amount } = req.body;
    
    if ((!userId && !username) || !amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Valid User ID or username and positive amount are required' });
    }

    let targetUserId = userId;
    let targetUsername = username;
    
    if (!targetUserId && targetUsername) {
      const userResult = await db.query(
        'SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)',
        [targetUsername.trim()]
      );
      
      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: `User "${targetUsername}" not found` });
      }
      
      targetUserId = userResult.rows[0].id;
      targetUsername = userResult.rows[0].username;
    }

    const result = await creditService.addCredits(
      targetUserId, 
      parseInt(amount), 
      'topup', 
      'Admin manual top-up'
    );

    if (result.success) {
      await logAudit(req.user.id, req.user.username, 'ADD_CREDITS', { 
        targetUserId, 
        targetUsername, 
        amount 
      });
    }

    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Failed to add credits' });
    }

    res.json({ 
      success: true, 
      message: `${amount} credits added to ${targetUsername || targetUserId}`,
      newBalance: result.newBalance
    });
  } catch (error) {
    console.error('Error adding coins:', error);
    res.status(500).json({ error: 'Internal server error while adding coins' });
  }
});

// Update report status
router.patch('/reports/:id/status', superAdminMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    await db.query(
      'UPDATE abuse_reports SET status = $1 WHERE id = $2',
      [status, req.params.id]
    );
    await logAudit(req.user.id, req.user.username, 'UPDATE_REPORT_STATUS', { reportId: req.params.id, status });
    res.json({ message: 'Report updated' });
  } catch (error) {
    console.error('Error updating report:', error);
    res.status(500).json({ message: 'Error updating report' });
  }
});

// Delete report
router.delete('/reports/:id', superAdminMiddleware, async (req, res) => {
  try {
    await db.query('DELETE FROM abuse_reports WHERE id = $1', [req.params.id]);
    await logAudit(req.user.id, req.user.username, 'DELETE_REPORT', { reportId: req.params.id });
    res.json({ message: 'Report deleted' });
  } catch (error) {
    console.error('Error deleting report:', error);
    res.status(500).json({ message: 'Error deleting report' });
  }
});

// Get users with pagination
router.get('/users', superAdminMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const role = req.query.role;
    const limit = 50;
    const offset = (page - 1) * limit;

    let query = 'SELECT id, username, email, credits, role, status, avatar, gender, country, is_active, is_invisible, username_color, status_message, created_at, updated_at, suspended_at, suspended_by FROM users';
    let countQuery = 'SELECT COUNT(*) FROM users';
    const params = [];
    const countParams = [];

    if (role) {
      query += ' WHERE role = $1';
      countQuery += ' WHERE role = $1';
      params.push(role);
      countParams.push(role);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit);
    params.push(offset);

    const users = await db.query(query, params);
    const totalCountResult = await db.query(countQuery, countParams);
    const totalUsers = parseInt(totalCountResult.rows[0].count);

    res.json({ 
      users: users.rows,
      pagination: {
        total: totalUsers,
        page,
        limit,
        totalPages: Math.ceil(totalUsers / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ message: 'Error fetching users' });
  }
});

// Search user by username (exact match or partial)
router.get('/users/search/:username', superAdminMiddleware, async (req, res) => {
  try {
    const searchUsername = req.params.username?.trim();
    
    console.log(`[Admin] User search request: "${searchUsername}"`);
    
    if (!searchUsername) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const safeColumns = 'id, username, email, credits, role, status, avatar, gender, country, is_active, is_invisible, username_color, status_message, created_at, updated_at, suspended_at, suspended_by';
    
    // First try exact match (case insensitive)
    let result = await db.query(
      `SELECT ${safeColumns} FROM users WHERE LOWER(username) = LOWER($1)`,
      [searchUsername]
    );
    
    console.log(`[Admin] Exact match found: ${result.rows.length} users`);

    // If no exact match, try partial match
    if (result.rows.length === 0) {
      result = await db.query(
        `SELECT ${safeColumns} FROM users WHERE LOWER(username) LIKE LOWER($1) LIMIT 10`,
        [`%${searchUsername}%`]
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Return single user for exact match, array for partial matches
    if (result.rows.length === 1) {
      res.json({ user: result.rows[0] });
    } else {
      res.json({ users: result.rows });
    }
  } catch (error) {
    console.error('Error searching user:', error);
    res.status(500).json({ error: 'Failed to search user' });
  }
});

// Ban user
router.patch('/users/:id/ban', superAdminMiddleware, async (req, res) => {
  try {
    await db.query(
      'UPDATE users SET is_suspended = true WHERE id = $1',
      [req.params.id]
    );
    await logAudit(req.user.id, req.user.username, 'BAN_USER', { targetUserId: req.params.id });
    res.json({ message: 'User banned' });
  } catch (error) {
    console.error('Error banning user:', error);
    res.status(500).json({ message: 'Error banning user' });
  }
});

// Unban user
router.patch('/users/:id/unban', superAdminMiddleware, async (req, res) => {
  try {
    await db.query(
      'UPDATE users SET is_suspended = false WHERE id = $1',
      [req.params.id]
    );
    await logAudit(req.user.id, req.user.username, 'UNBAN_USER', { targetUserId: req.params.id });
    res.json({ message: 'User unbanned' });
  } catch (error) {
    console.error('Error unbanning user:', error);
    res.status(500).json({ message: 'Error unbanning user' });
  }
});

// Update user role handler
const updateUserRoleHandler = async (req, res) => {
  try {
    const { role } = req.body;
    const validRoles = ['user', 'mentor', 'merchant', 'admin', 'customer_service', 'super_admin'];
    
    if (!role || !validRoles.includes(role)) {
      return res.status(400).json({ message: 'Invalid role' });
    }

    await db.query(
      'UPDATE users SET role = $1 WHERE id = $2',
      [role, req.params.id]
    );
    await logAudit(req.user.id, req.user.username, 'CHANGE_ROLE', { targetUserId: req.params.id, newRole: role });
    res.json({ message: 'User role updated', role });
  } catch (error) {
    console.error('Error updating user role:', error);
    res.status(500).json({ message: 'Error updating user role' });
  }
};

// Update user role (support both PATCH and PUT)
router.patch('/users/:id/role', superAdminMiddleware, updateUserRoleHandler);
router.put('/users/:id/role', superAdminMiddleware, updateUserRoleHandler);

// Change user password (admin)
const bcrypt = require('bcryptjs');
const changePasswordHandler = async (req, res) => {
  try {
    const password = req.body.password || req.body.newPassword;
    
    if (!password || password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    
    await db.query(
      'UPDATE users SET password = $1, password_hash = $1 WHERE id = $2',
      [hashedPassword, req.params.id]
    );
    await logAudit(req.user.id, req.user.username, 'CHANGE_PASSWORD', { targetUserId: req.params.id });
    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Error changing user password:', error);
    res.status(500).json({ message: 'Error changing password' });
  }
};

router.patch('/users/:id/password', superAdminMiddleware, changePasswordHandler);
router.put('/users/:id/password', superAdminMiddleware, changePasswordHandler);

// Change user email (admin)
const changeEmailHandler = async (req, res) => {
  try {
    const email = req.body.email || req.body.newEmail;
    
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: 'Valid email is required' });
    }

    // Check if email already exists
    const existingUser = await db.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id != $2',
      [email, req.params.id]
    );
    
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ message: 'Email already in use' });
    }

    await db.query(
      'UPDATE users SET email = $1 WHERE id = $2',
      [email, req.params.id]
    );
    await logAudit(req.user.id, req.user.username, 'CHANGE_EMAIL', { targetUserId: req.params.id, newEmail: email });
    res.json({ message: 'Email updated successfully' });
  } catch (error) {
    console.error('Error changing user email:', error);
    res.status(500).json({ message: 'Error changing email' });
  }
};

router.patch('/users/:id/email', superAdminMiddleware, changeEmailHandler);
router.put('/users/:id/email', superAdminMiddleware, changeEmailHandler);

// Reset user PIN (admin)
const resetPinHandler = async (req, res) => {
  try {
    const pin = req.body.pin || req.body.newPin;
    const userId = req.params.id;
    
    console.log(`[Admin] Reset PIN request for user ID: ${userId}`);
    
    if (!pin || pin.length < 2 || pin.length > 12 || !/^\d+$/.test(pin)) {
      return res.status(400).json({ message: 'PIN must be 2-12 digits' });
    }

    const userCheck = await db.query('SELECT id, username FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      console.log(`[Admin] User not found: ${userId}`);
      return res.status(404).json({ message: 'User not found' });
    }

    const hashedPin = await bcrypt.hash(pin, 10);
    
    await db.query(
      'UPDATE users SET pin = $1 WHERE id = $2',
      [hashedPin, userId]
    );
    
    console.log(`[Admin] PIN reset successful for user: ${userCheck.rows[0].username}`);
    await logAudit(req.user.id, req.user.username, 'RESET_PIN', { targetUserId: userId, targetUsername: userCheck.rows[0].username });
    res.json({ message: 'PIN reset successfully' });
  } catch (error) {
    console.error('Error resetting user PIN:', error);
    res.status(500).json({ message: 'Error resetting PIN' });
  }
};

router.patch('/users/:id/pin', superAdminMiddleware, resetPinHandler);
router.put('/users/:id/pin', superAdminMiddleware, resetPinHandler);

// Update room
router.put('/rooms/:id', superAdminMiddleware, async (req, res) => {
  try {
    const { name, description, max_users } = req.body;
    const roomId = req.params.id;

    if (!name) {
      return res.status(400).json({ error: 'Room name is required' });
    }

    await db.query(
      'UPDATE rooms SET name = $1, description = $2, max_users = $3, updated_at = NOW() WHERE id = $4',
      [name, description, max_users, roomId]
    );
    await logAudit(req.user.id, req.user.username, 'UPDATE_ROOM', { roomId, name, max_users });
    res.json({ message: 'Room updated successfully' });
  } catch (error) {
    console.error('Error updating room:', error);
    res.status(500).json({ error: 'Failed to update room' });
  }
});

// Delete room
router.delete('/rooms/:id', superAdminMiddleware, async (req, res) => {
  try {
    const roomId = req.params.id;
    const room = await db.query('SELECT name FROM rooms WHERE id = $1', [roomId]);
    await db.query('DELETE FROM rooms WHERE id = $1', [roomId]);
    await logAudit(req.user.id, req.user.username, 'DELETE_ROOM', {
      roomId,
      roomName: room.rows[0]?.name || 'unknown'
    });
    res.json({ message: 'Room deleted successfully' });
  } catch (error) {
    console.error('Error deleting room:', error);
    res.status(500).json({ error: 'Failed to delete room' });
  }
});

// Create room
router.post('/rooms/create', superAdminMiddleware, async (req, res) => {
  try {
    const { name, description, max_users, category, ownerId, creatorName, owner_id, creator_name } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Room name is required' });
    }

    if (name.trim().length < 3) {
      return res.status(400).json({ error: 'Room name must be at least 3 characters' });
    }

    if (name.trim().length > 50) {
      return res.status(400).json({ error: 'Room name must not exceed 50 characters' });
    }

    const existingRoom = await db.query('SELECT id FROM rooms WHERE LOWER(name) = LOWER($1)', [name.trim()]);
    if (existingRoom.rows.length > 0) {
      return res.status(400).json({ error: 'Room name already exists' });
    }
    
    const validCategory = category || 'global';
    const finalMaxUsers = max_users || 25;
    const finalOwnerId = ownerId || owner_id || null;
    const finalCreatorName = creatorName || creator_name || null;

    const result = await db.query(
      `INSERT INTO rooms (name, description, max_users, category, owner_id, creator_name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       RETURNING *`,
      [name.trim(), description || '', finalMaxUsers, validCategory, finalOwnerId, finalCreatorName]
    );

    await logAudit(req.user.id, req.user.username, 'CREATE_ROOM', { roomId: result.rows[0].id, roomName: name.trim() });
    res.status(201).json({ message: 'Room created successfully', room: result.rows[0] });
  } catch (error) {
    console.error('Error creating room:', error);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// Get all transactions for a user (admin) - uses credit_logs directly
router.get('/transactions/all', superAdminMiddleware, async (req, res) => {
  try {
    const { username } = req.query;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    // Find user by username
    const userResult = await db.query(
      'SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Get all transactions from credit_logs
    const logsResult = await db.query(`
      SELECT 
        id,
        amount,
        transaction_type,
        description,
        from_username,
        to_username,
        created_at
      FROM credit_logs
      WHERE LOWER(from_username) = LOWER($1) OR LOWER(to_username) = LOWER($1)
      ORDER BY created_at DESC
      LIMIT 500
    `, [username]);

    const transactions = logsResult.rows.map(row => {
      const isOutgoing = row.from_username && row.from_username.toLowerCase() === username.toLowerCase();
      const otherUser = isOutgoing ? row.to_username : row.from_username;
      
      let description = row.description || row.transaction_type;
      if (row.transaction_type === 'transfer') {
        if (isOutgoing) {
          description = `Transfer to ${row.to_username || 'unknown'}`;
        } else {
          description = `Received credit from ${row.from_username || 'unknown'}`;
        }
      } else if (row.transaction_type === 'gift') {
        if (isOutgoing) {
          description = `Gift sent to ${row.to_username || 'unknown'}`;
        } else {
          description = `Gift received from ${row.from_username || 'unknown'}`;
        }
        if (row.description) {
          const giftMatch = row.description.match(/Gift:\s*\w+\s+to\s+(\w+)/);
          if (giftMatch) {
            description = isOutgoing 
              ? `Gift sent to ${giftMatch[1]}` 
              : `Gift received from ${row.from_username || 'unknown'}`;
          }
        }
      } else if (row.transaction_type === 'topup') {
        description = `Top up credit${otherUser ? ' by ' + otherUser : ''}`;
      }
      
      return {
        id: row.id,
        amount: isOutgoing && row.amount > 0 ? -row.amount : row.amount,
        transaction_type: row.transaction_type,
        description,
        from_username: row.from_username,
        to_username: row.to_username,
        created_at: row.created_at,
        is_outgoing: isOutgoing
      };
    });

    res.json({ 
      transactions,
      username: user.username 
    });
  } catch (error) {
    console.error('Error fetching all transactions:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// Clean stale room participants - sync Redis with actual connected sockets
router.post('/cleanup-room-participants', superAdminMiddleware, async (req, res) => {
  try {
    const { getRedisClient } = require('../redis');
    const redis = getRedisClient();
    
    // Get all room participant keys
    const keys = await redis.keys('room:*:participants');
    let totalCleaned = 0;
    const cleanedRooms = [];
    
    for (const key of keys) {
      const match = key.match(/room:(\d+):participants/);
      if (!match) continue;
      
      const roomId = match[1];
      const beforeCount = await redis.sCard(key);
      
      // Delete the entire set - it will be rebuilt as users rejoin
      await redis.del(key);
      
      if (beforeCount > 0) {
        cleanedRooms.push({ roomId, previousCount: beforeCount });
        totalCleaned += beforeCount;
      }
    }
    
    // Also clean related legacy keys
    const legacyPatterns = [
      'room:users:*',
      'room:*:user:*',
      'presence:*',
      'user:*:rooms'
    ];
    
    let legacyCleaned = 0;
    for (const pattern of legacyPatterns) {
      const legacyKeys = await redis.keys(pattern);
      for (const k of legacyKeys) {
        await redis.del(k);
        legacyCleaned++;
      }
    }
    
    console.log(`🧹 Admin cleanup: Cleared ${totalCleaned} participants from ${cleanedRooms.length} rooms, ${legacyCleaned} legacy keys`);
    
    res.json({ 
      success: true, 
      message: `Cleaned ${totalCleaned} stale participants from ${cleanedRooms.length} rooms`,
      cleanedRooms,
      legacyKeysCleaned: legacyCleaned
    });
  } catch (error) {
    console.error('Error cleaning room participants:', error);
    res.status(500).json({ error: 'Failed to cleanup room participants' });
  }
});

// Get room participant stats (for debugging)
router.get('/room-stats', superAdminMiddleware, async (req, res) => {
  try {
    const { getRedisClient } = require('../redis');
    const redis = getRedisClient();
    
    const keys = await redis.keys('room:*:participants');
    const stats = [];
    
    for (const key of keys) {
      const match = key.match(/room:(\d+):participants/);
      if (!match) continue;
      
      const roomId = match[1];
      const members = await redis.sMembers(key);
      const count = members.length;
      
      if (count > 0) {
        stats.push({ 
          roomId: parseInt(roomId), 
          count, 
          participants: members.slice(0, 10) // Show first 10 only
        });
      }
    }
    
    // Sort by count descending
    stats.sort((a, b) => b.count - a.count);
    
    res.json({ 
      success: true, 
      totalRooms: stats.length,
      stats 
    });
  } catch (error) {
    console.error('Error getting room stats:', error);
    res.status(500).json({ error: 'Failed to get room stats' });
  }
});

// Get pending (unverified) accounts
router.get('/pending-accounts', superAdminMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    const result = await db.query(
      `SELECT id, username, email, created_at, last_login_date 
       FROM users 
       WHERE is_active = false 
       ORDER BY created_at DESC 
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countResult = await db.query(
      `SELECT COUNT(*) as count FROM users WHERE is_active = false`
    );

    res.json({ 
      success: true,
      users: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
    });
  } catch (error) {
    console.error('Error fetching pending accounts:', error);
    res.status(500).json({ error: 'Failed to fetch pending accounts' });
  }
});

// Activate a user account
router.patch('/users/:id/activate', superAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await db.query(
      `UPDATE users SET is_active = true, activated_at = NOW(), updated_at = NOW() 
       WHERE id = $1 
       RETURNING id, username, email`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await logAudit(req.user.id, req.user.username, 'ACTIVATE_ACCOUNT', {
      targetUserId: id,
      targetUsername: result.rows[0].username
    });

    res.json({ 
      success: true, 
      message: `Account ${result.rows[0].username} activated successfully`,
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Error activating account:', error);
    res.status(500).json({ error: 'Failed to activate account' });
  }
});

// Bulk activate multiple accounts
router.post('/users/activate-bulk', superAdminMiddleware, async (req, res) => {
  try {
    const { userIds } = req.body;
    
    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'userIds array required' });
    }

    const result = await db.query(
      `UPDATE users SET is_active = true, activated_at = NOW(), updated_at = NOW() 
       WHERE id = ANY($1::int[]) AND is_active = false
       RETURNING id, username`,
      [userIds]
    );

    await logAudit(req.user.id, req.user.username, 'BULK_ACTIVATE_ACCOUNTS', {
      count: result.rows.length,
      userIds
    });

    res.json({ 
      success: true, 
      message: `${result.rows.length} accounts activated successfully`,
      activatedUsers: result.rows
    });
  } catch (error) {
    console.error('Error bulk activating accounts:', error);
    res.status(500).json({ error: 'Failed to bulk activate accounts' });
  }
});

// ==========================================
// App Config Management
// ==========================================

// Get all app config (public - no auth needed for version check)
router.get('/app-config/version', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT config_value FROM app_config WHERE config_key = 'min_app_version'`
    );
    const messageResult = await db.query(
      `SELECT config_value FROM app_config WHERE config_key = 'force_update_message'`
    );
    const maintenanceResult = await db.query(
      `SELECT config_value FROM app_config WHERE config_key = 'maintenance_mode'`
    );

    res.json({
      minVersion: result.rows[0]?.config_value || '1.0.0',
      updateMessage: messageResult.rows[0]?.config_value || 'Please update your app.',
      maintenanceMode: maintenanceResult.rows[0]?.config_value === 'true'
    });
  } catch (error) {
    console.error('Error fetching app config:', error);
    res.status(500).json({ error: 'Failed to fetch app config' });
  }
});

// Get all app config entries (admin only)
router.get('/app-config', superAdminMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM app_config ORDER BY config_key ASC`
    );
    res.json({ success: true, configs: result.rows });
  } catch (error) {
    console.error('Error fetching app config:', error);
    res.status(500).json({ error: 'Failed to fetch app config' });
  }
});

// Update app config entry (admin only)
router.put('/app-config/:key', superAdminMiddleware, async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined || value === null) {
      return res.status(400).json({ error: 'Value is required' });
    }

    const result = await db.query(
      `UPDATE app_config SET config_value = $1, updated_by = $2, updated_at = NOW() 
       WHERE config_key = $3 RETURNING *`,
      [String(value), req.user?.username || 'admin', key]
    );

    if (result.rows.length === 0) {
      const insertResult = await db.query(
        `INSERT INTO app_config (config_key, config_value, updated_by) 
         VALUES ($1, $2, $3) RETURNING *`,
        [key, String(value), req.user?.username || 'admin']
      );
      await logAudit(req.user.id, req.user.username, 'UPDATE_APP_CONFIG', { key, value: String(value), action: 'created' });
      return res.json({ success: true, config: insertResult.rows[0], message: 'Config created' });
    }

    await logAudit(req.user.id, req.user.username, 'UPDATE_APP_CONFIG', { key, value: String(value), action: 'updated' });
    res.json({ success: true, config: result.rows[0], message: 'Config updated' });
  } catch (error) {
    console.error('Error updating app config:', error);
    res.status(500).json({ error: 'Failed to update app config' });
  }
});

module.exports = router;
