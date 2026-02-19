const logger = require('../utils/logger');
const express = require('express');
const router = express.Router();
const { getRedisClient } = require('../redis');
const roomService = require('../services/roomService');
const messageService = require('../services/messageService');
const userService = require('../services/userService');
const authMiddleware = require('../middleware/auth');
const { getPool } = require('../db/db');

// REDIS-ONLY chatlist - NO DATABASE QUERIES for real-time performance
router.get('/list/:username', async (req, res) => {
  try {
    const { username } = req.params;

    if (!username) {
      return res.status(400).json({
        success: false,
        error: 'Username is required'
      });
    }

    const redis = getRedisClient();
    
    // ONLY use Redis for active rooms - NO DATABASE QUERY
    const redisRoomsRaw = await redis.sMembers(`user:rooms:${username}`);
    
    // Parse Redis room data (even if empty, we still need to fetch DMs)
    const activeRooms = [];
    const seenIds = new Set();
    
    for (const r of redisRoomsRaw) {
      try {
        const parsed = JSON.parse(r);
        const id = parsed.id || parsed.roomId;
        if (id && !seenIds.has(id.toString())) {
          activeRooms.push({
            id: id.toString(),
            name: parsed.name || parsed.roomName,
            lastJoinedAt: parsed.joinedAt || Date.now()
          });
          seenIds.add(id.toString());
        }
      } catch (e) {
        // If not JSON, treat as room ID string
        if (r && !seenIds.has(r.toString())) {
          activeRooms.push({
            id: r.toString(),
            name: null,
            lastJoinedAt: Date.now()
          });
          seenIds.add(r.toString());
        }
      }
    }

    // Enrich with Redis data (viewer count, last message) + room name from cache
    // Enrichment logic...
    const enrichedRooms = await Promise.all(
      activeRooms.map(async (room) => {
        try {
          // Get viewer count from Redis
          let viewerCount = 0;
          try {
            const count = await redis.sCard(`room:${room.id}:participants`);
            viewerCount = count || 0;
          } catch (err) {}

          // Get room name from cache or DB only if missing
          let roomName = room.name;
          if (!roomName) {
            try {
              const roomInfo = await roomService.getRoomById(room.id);
              roomName = roomInfo?.name || `Room ${room.id}`;
            } catch (err) {
              roomName = `Room ${room.id}`;
            }
          }

          // Get last message from Redis
          let lastMessage = 'Active now';
          let lastUsername = roomName;
          let timestamp = room.lastJoinedAt;
          
          try {
            const msgData = await redis.get(`room:lastmsg:${room.id}`);
            if (msgData) {
              const parsed = JSON.parse(msgData);
              lastMessage = parsed.message || lastMessage;
              lastUsername = parsed.username || roomName;
              timestamp = parsed.timestamp || room.lastJoinedAt;
            }
          } catch (err) {}

          return {
            id: room.id,
            name: roomName,
            lastMessage,
            lastUsername,
            timestamp,
            viewerCount,
            lastJoinedAt: room.lastJoinedAt,
            isActive: true,
            type: 'room'
          };
        } catch (err) {
          return null;
        }
      })
    );

    const validRooms = enrichedRooms.filter(r => r !== null);

    // FETCH DM CONVERSATIONS FROM DATABASE (persistent, survives Redis restart)
    let dms = [];
    try {
      const user = await userService.getUserByUsername(username);
      if (user) {
        const conversations = await messageService.getRecentConversations(user.id);
        const { getPresence } = require('../utils/redisUtils');
        dms = await Promise.all(conversations.map(async (conv) => {
          let avatarUrl = conv.avatar || null;
          if (avatarUrl && !avatarUrl.startsWith('http')) {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            avatarUrl = `${baseUrl}${avatarUrl}`;
          }
          let isOnline = false;
          try {
            const presence = await getPresence(conv.partner_username);
            isOnline = presence !== 'offline';
          } catch (e) {}
          return {
            userId: conv.partner_id?.toString(),
            username: conv.partner_username,
            avatar: avatarUrl,
            role: conv.role || 'user',
            lastMessage: {
              message: conv.message,
              timestamp: conv.created_at,
              fromUsername: conv.from_username,
              toUsername: conv.to_username
            },
            unreadCount: conv.unread_count || 0,
            isOnline,
            type: 'dm'
          };
        }));
      }
    } catch (err) {
      console.error('Error fetching DM conversations from DB:', err);
    }

    res.json({
      success: true,
      rooms: validRooms,
      dms: dms,
      pms: dms
    });

  } catch (error) {
    console.error('Error getting chat list:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get chat list'
    });
  }
});

router.get('/joined/:username', async (req, res) => {
  try {
    const { username } = req.params;

    if (!username) {
      return res.status(400).json({
        success: false,
        error: 'Username required'
      });
    }

    const redis = getRedisClient();
    const roomIds = await redis.sMembers(`user:rooms:${username}`);

    const roomsWithInfo = await Promise.all(
      roomIds.map(async (roomId) => {
        const roomInfo = await roomService.getRoomById(roomId);
        if (!roomInfo) return null;

        return {
          id: roomId,
          name: roomInfo.name,
          type: 'room'
        };
      })
    );

    const validRooms = roomsWithInfo.filter(r => r !== null);

    res.json({
      success: true,
      rooms: validRooms
    });

  } catch (error) {
    console.error('Get joined rooms error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get joined rooms'
    });
  }
});

router.get('/dm/:userId/:otherUserId', authMiddleware, async (req, res) => {
  try {
    const { userId, otherUserId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    if (!userId || !otherUserId) {
      return res.status(400).json({ success: false, error: 'Both user IDs required' });
    }

    if (req.user && req.user.id?.toString() !== userId.toString()) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const messages = await messageService.getPrivateMessages(userId, otherUserId, limit, offset);
    await messageService.markMessagesAsRead(userId, otherUserId);

    res.json({
      success: true,
      messages,
      hasMore: messages.length === limit
    });
  } catch (error) {
    console.error('Error getting DM history:', error);
    res.status(500).json({ success: false, error: 'Failed to get DM history' });
  }
});

module.exports = router;