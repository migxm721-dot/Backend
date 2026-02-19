const logger = require('../utils/logger');
const userService = require('../services/userService');
const { getUserLevel, getLeaderboard } = require('../utils/xpLeveling');
const { setUserStatus, getUserRooms, removeUserFromRoom } = require('../utils/presence');
const roomService = require('../services/roomService');
const { removeAllUserPresence, getRoomUsersFromTTL } = require('../utils/roomPresenceTTL');

// Import Redis-related functions (assuming they exist in utils/redisUtils)
const {
  setPresence,
  getPresence,
  removePresence,
  setSession,
  getSession,
  removeSession,
  getRoomMembers,
  clearUserRooms,
  removeRoomParticipant,
  getUserActiveRooms,
  clearUserActiveRooms,
  getRoomParticipantsWithNames
} = require('../utils/redisUtils');

const DISCONNECT_GRACE_PERIOD = 30 * 60 * 1000; // 30 minutes
const disconnectGraceTimers = new Map();

const cancelDisconnectTimer = (userId) => {
  const timerKey = `${userId}`;
  if (disconnectGraceTimers.has(timerKey)) {
    clearTimeout(disconnectGraceTimers.get(timerKey));
    disconnectGraceTimers.delete(timerKey);
    return true;
  }
  return false;
};

const systemEventsHandler = (io, socket) => {
  const authenticate = async (data) => {
    try {
      const { userId, username } = data;

      if (!userId || !username) {
        socket.emit('error', { message: 'Authentication required' });
        return;
      }

      const timerKey = `${userId}`;
      if (disconnectGraceTimers.has(timerKey)) {
        clearTimeout(disconnectGraceTimers.get(timerKey));
        disconnectGraceTimers.delete(timerKey);
        logger.info(`✅ Disconnect grace timer cancelled for ${username} - re-authenticated`);
      }

      let user = await userService.getUserByUsername(username);

      if (!user) {
        user = await userService.createUser(username);
        if (!user || user.error) {
          socket.emit('error', { message: user?.error || 'Failed to create user' });
          return;
        }
      }

      await userService.connectUser(user.id, socket.id);

      socket.userId = user.id;
      socket.username = user.username;

      // Check and establish session
      await checkSession({ username: user.username });

      const levelData = await getUserLevel(user.id);

      socket.emit('authenticated', {
        user: {
          id: user.id,
          username: user.username,
          credits: user.credits,
          role: user.role,
          status: await getPresence(user.username), // Get current presence status
          level: levelData.level,
          xp: levelData.xp,
          nextLevelXp: levelData.nextLevelXp,
          progress: levelData.progress
        }
      });

    } catch (error) {
      console.error('Error authenticating:', error);
      socket.emit('error', { message: 'Authentication failed' });
    }
  };

  // MIG33-style presence update
  const updatePresence = async (data) => {
    try {
      const { username, status } = data;
      // status: online | away | busy | offline
      await setPresence(username, status);

      // Broadcast to all rooms where user is a member
      const rooms = await getUserRooms(username); // Assuming getUserRooms can now take username
      for (const roomId of rooms) {
        const members = await getRoomMembers(roomId); // Get members from Redis
        io.to(`room:${roomId}`).emit('user:presence', {
          username,
          status,
          timestamp: new Date().toISOString()
        });
      }

      // Broadcast globally so contact lists can update in real-time
      io.emit('presence:changed', {
        username,
        status,
        timestamp: new Date().toISOString()
      });

      // logger.info(`📡 Presence broadcast: ${username} → ${status}`);
      socket.emit('presence:updated', { username, status });
    } catch (error) {
      console.error('Error updating presence:', error);
      socket.emit('error', { message: 'Failed to update presence' });
    }
  };

  // Get presence status
  const getPresenceStatus = async (data) => {
    try {
      const { username } = data;
      const status = await getPresence(username);
      socket.emit('presence:status', { username, status });
    } catch (error) {
      console.error('Error getting presence:', error);
      socket.emit('error', { message: 'Failed to get presence' });
    }
  };

  // Check session (prevent double login)
  const checkSession = async (data) => {
    try {
      const { username } = data;
      const existingSession = await getSession(username);

      if (existingSession && existingSession !== socket.id) {
        // Kick the old session
        const oldSocket = io.sockets.sockets.get(existingSession);
        if (oldSocket) {
          oldSocket.emit('session:kicked', {
            reason: 'New login from another device'
          });
          oldSocket.disconnect(true);
        }
      }

      // Set new session
      await setSession(username, socket.id);
      // Don't force 'online' - let client control presence via presence:update event
      // This preserves user's manual status selection (busy, away, etc.)

      socket.emit('session:established', { username });
    } catch (error) {
      console.error('Error checking session:', error);
      socket.emit('error', { message: 'Failed to establish session' });
    }
  };

  const updateStatus = async (data) => { // This might be redundant with updatePresence
    try {
      const { userId, status } = data;
      await userService.updateUserStatus(userId, status); // Using userService for DB update

      const user = await userService.getUserById(userId); // Get username from DB
      const rooms = await getUserRooms(userId); // Assuming getUserRooms can take userId
      for (const roomId of rooms) {
        io.to(`room:${roomId}`).emit('user:status:changed', { userId, username: user.username, status }); // Use a more descriptive event name
      }

    } catch (error) {
      console.error('Error updating status:', error);
      socket.emit('error', { message: 'Failed to update status' });
    }
  };

  const getUserInfo = async (data) => {
    try {
      const { userId } = data;

      if (!userId) {
        socket.emit('error', { message: 'User ID required' });
        return;
      }

      const user = await userService.getUserById(userId);
      if (!user) {
        socket.emit('error', { message: 'User not found' });
        return;
      }

      const levelData = await getUserLevel(userId);

      socket.emit('user:info', {
        user: {
          id: user.id,
          username: user.username,
          avatar: user.avatar,
          role: user.role,
          status: await getPresence(user.username), // Get presence status
          credits: user.credits,
          level: levelData.level,
          xp: levelData.xp,
          createdAt: user.created_at
        }
      });

    } catch (error) {
      console.error('Error getting user info:', error);
      socket.emit('error', { message: 'Failed to get user info' });
    }
  };

  const getLeaderboardData = async (data) => {
    try {
      const { limit = 10 } = data || {};

      const leaderboard = await getLeaderboard(limit);

      socket.emit('leaderboard', {
        users: leaderboard
      });

    } catch (error) {
      console.error('Error getting leaderboard:', error);
      socket.emit('error', { message: 'Failed to get leaderboard' });
    }
  };

  const searchUsers = async (data) => {
    try {
      const { query, limit = 20 } = data;

      if (!query || query.length < 2) {
        socket.emit('error', { message: 'Search query too short' });
        return;
      }

      const users = await userService.searchUsers(query, limit);

      socket.emit('users:search:result', {
        users,
        query
      });

    } catch (error) {
      console.error('Error searching users:', error);
      socket.emit('error', { message: 'Failed to search users' });
    }
  };

  const getOnlineUsers = async (data) => {
    try {
      const { limit = 50 } = data || {};

      const users = await userService.getOnlineUsers(limit); // This might need to use Redis for efficiency

      socket.emit('users:online', {
        users,
        count: users.length
      });

    } catch (error) {
      console.error('Error getting online users:', error);
      socket.emit('error', { message: 'Failed to get online users' });
    }
  };

  const handleLogout = async (data) => {
    try {
      const { userId, username } = data || {};
      const actualUserId = userId || socket.userId;
      const actualUsername = username || socket.username;

      if (actualUserId && actualUsername) {
        // Idempotency guard - prevent duplicate logout processing
        if (socket._logoutProcessed) {
          logger.info(`⏩ Skipping duplicate logout for ${actualUsername} - already processed`);
          return;
        }
        socket._logoutProcessed = true;
        
        logger.info(`🚪 User Logout: ${actualUsername} (ID: ${actualUserId})`);
        
        // Broadcast presence change to offline
        io.emit('presence:changed', {
          username: actualUsername,
          status: 'offline',
          timestamp: new Date().toISOString()
        });

        // Force leave from all rooms
        const redis = require('../redis').getRedisClient();
        const { generateMessageId } = require('../utils/idGenerator');
        const activeRooms = await redis.sMembers(`user:${actualUserId}:rooms`);
        
        // Also check activeRooms set
        const activeRooms2 = await redis.sMembers(`user:${actualUserId}:activeRooms`);
        const allRoomIds = [...new Set([...activeRooms, ...activeRooms2])];
        
        if (allRoomIds.length > 0) {
          // Get user level for "has left" message
          const userLevelData = await getUserLevel(actualUserId);
          const userLevel = userLevelData?.level || 1;
          const user = await userService.getUserById(actualUserId);
          const userType = user?.role || 'normal';
          
          for (const roomId of allRoomIds) {
            logger.info(`🚪 Force leaving room ${roomId} for user ${actualUsername}`);
            
            // Use common leave logic
            await removeUserFromRoom(roomId, actualUsername);
            await removeRoomParticipant(roomId, actualUsername);
            await redis.sRem(`user:${actualUserId}:rooms`, roomId);
            await redis.sRem(`user:${actualUserId}:activeRooms`, roomId);
            
            // Remove presence TTL key
            await redis.del(`room:${roomId}:user:${actualUserId}`);
            
            // Send "has left" chat message to room (consistent with roomEvents.js format)
            const room = await roomService.getRoomById(roomId);
            const leftMsg = `${actualUsername} [${userLevel}] has left`;
            
            io.to(`room:${roomId}`).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: room?.name || 'Room',
              message: leftMsg,
              timestamp: new Date().toISOString(),
              type: 'presence',
              messageType: 'presence',
              userType: userType
            });
            
            // Notify room members
            const updatedUsers = await getRoomUsersFromTTL(roomId);
            io.to(`room:${roomId}`).emit('room:user:left', {
              roomId,
              username: actualUsername,
              userId: actualUserId,
              users: updatedUsers
            });
            
            // Updated participants list
            const updatedParticipants = await redis.sMembers(`room:participants:${roomId}`);
            io.to(`room:${roomId}`).emit('room:participants:update', {
              roomId,
              participants: updatedParticipants
            });
            
            // Live currently update
            io.to(`room:${roomId}`).emit('room:currently:update', {
              roomId,
              participants: updatedParticipants.join(', ')
            });
          }
        }
        
        // Clear all session/presence from Redis
        await removePresence(actualUsername);
        await removeSession(actualUsername);
        await redis.del(`user:${actualUserId}:rooms`);
        await redis.del(`user:${actualUserId}:activeRooms`);
        await redis.del(`user:${actualUserId}:ip`);
        
        socket.emit('logout:success');
        logger.info(`✅ Logout processing complete for ${actualUsername}`);
      }
    } catch (error) {
      console.error('Error handling logout:', error);
      socket.emit('error', { message: 'Logout failed' });
    }
  };

  const handleDisconnect = async (reason) => {
    try {
      if (!socket.username) return;

      const actualUsername = socket.username;
      const actualUserId = socket.userId;

      logger.info(`🔌 User Disconnected: ${actualUsername} | Reason: ${reason}`);

      if (socket._replaced) {
        logger.info(`⏩ Skipping disconnect cleanup for ${actualUsername} - socket replaced by new connection`);
        return;
      }

      if (reason === 'client namespace disconnect') {
        logger.info(`🚪 Explicit client disconnect for ${actualUsername} - immediate cleanup`);
        await handleLogout({ userId: actualUserId, username: actualUsername });
        return;
      }

      const timerKey = `${actualUserId}`;
      if (disconnectGraceTimers.has(timerKey)) {
        clearTimeout(disconnectGraceTimers.get(timerKey));
      }

      logger.info(`⏳ Starting ${DISCONNECT_GRACE_PERIOD/1000}s grace period for ${actualUsername} before room cleanup`);

      const graceTimer = setTimeout(async () => {
        disconnectGraceTimers.delete(timerKey);

        let reconnected = false;
        try {
          const allSockets = await io.fetchSockets();
          for (const s of allSockets) {
            if (String(s.userId) === String(actualUserId)) {
              reconnected = true;
              logger.info(`✅ ${actualUsername} reconnected (socket: ${s.id}) - skipping cleanup`);
              break;
            }
          }
        } catch (checkErr) {
          logger.info(`⚠️ Could not check reconnection for ${actualUsername}: ${checkErr.message}`);
        }

        if (reconnected) {
          return;
        }

        logger.info(`⏰ Grace period expired for ${actualUsername} - performing cleanup`);

        io.emit('presence:changed', {
          username: actualUsername,
          status: 'offline',
          timestamp: new Date().toISOString()
        });

        await handleLogout({ userId: actualUserId, username: actualUsername });
      }, DISCONNECT_GRACE_PERIOD);

      disconnectGraceTimers.set(timerKey, graceTimer);
    } catch (error) {
      console.error('Error handling disconnect:', error);
    }
  };

  // Event handlers
  socket.on('authenticate', authenticate);
  socket.on('presence:update', updatePresence);
  socket.on('presence:get', getPresenceStatus);
  socket.on('session:check', checkSession);
  socket.on('user:info:get', getUserInfo);
  socket.on('leaderboard:get', getLeaderboardData);
  socket.on('users:search', searchUsers);
  socket.on('users:online:get', getOnlineUsers);
  // This might be redundant if updatePresence is used for all status changes
  // socket.on('user:status:update', updateStatus);
  // socket.on('user:level:get', getUserLevelData); // This event was not defined in original code
  socket.on('disconnect', handleDisconnect);
  socket.on('logout', handleLogout);
};

module.exports = systemEventsHandler;
module.exports.cancelDisconnectTimer = cancelDisconnectTimer;