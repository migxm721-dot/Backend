const logger = require('../utils/logger');
const roomService = require('../services/roomService');
const userService = require('../services/userService');
const banService = require('../services/banService');
const { addXp, XP_REWARDS, getUserLevel } = require('../utils/xpLeveling');
const { getPresence } = require('../utils/presence');
const { generateMessageId } = require('../utils/idGenerator');
const {
  addUserRoom,
  removeUserRoom,
  addRecentRoom,
  incrementRoomActive,
  decrementRoomActive,
  getRoomParticipants,
  getRoomParticipantsWithNames,
  addRoomParticipant,
  removeRoomParticipant,
  addUserActiveRoom,
  removeUserActiveRoom
} = require('../utils/redisUtils');
const {
  addUserToRoom,
  removeUserFromRoom,
  getRoomUsers: getRoomPresenceUsers,
  getRoomUserCount,
  isUserInRoom,
  addSystemMessage
} = require('../utils/redisPresence');
const { adminKick: executeAdminKick, isGloballyBanned, isAdminGloballyBanned } = require('../utils/adminKick');
const { startVoteKick, addVote, hasActiveVote } = require('../utils/voteKick');
const { checkJoinAllowed } = require('../utils/roomCooldown');
const { storeUserPresence, updatePresenceActivity, removeUserPresence } = require('../utils/roomPresenceTTL');
const { getRedisClient } = require('../redis');

/**
 * Get REAL room count from Socket.IO adapter (source of truth)
 * Uses actual connected sockets, not Redis cache
 * @param {Object} io - Socket.IO server instance
 * @param {number|string} roomId - Room ID
 * @returns {number} - Actual number of connected sockets in room
 */
const getRealRoomCount = (io, roomId) => {
  try {
    const adapter = io?.adapter || io?.sockets?.adapter;
    if (!adapter || !adapter.rooms) {
      return 0;
    }
    const roomName = `room:${roomId}`;
    const room = adapter.rooms.get(roomName);
    return room ? room.size : 0;
  } catch (error) {
    console.error('Error getting real room count:', error);
    return 0;
  }
};

/**
 * Emit room count update to all clients
 * Uses Socket.IO adapter as source of truth
 */
const emitRoomCountUpdate = (io, roomId) => {
  if (!io) return 0;
  const count = getRealRoomCount(io, roomId);
  // Use userCount for backward compatibility with frontend
  io.emit('room:count:update', { roomId: parseInt(roomId), userCount: count });
  return count;
};

// Helper function to create system messages
const createSystemMessage = (roomId, message) => ({
  roomId,
  message,
  timestamp: new Date().toISOString(),
  type: 'system'
});

// Helper function to format "has left" message with level
// Note: Badge images are rendered by frontend based on userType field
const formatLeftMessage = (username, level) => {
  return `${username} [${level}] has left`;
};

const disconnectTimers = new Map();
const leaveGraceTimers = new Map();
const LEAVE_GRACE_PERIOD = 15 * 1000; // 15 seconds grace before showing "has left"

const silentRejoinWindow = 10 * 60 * 1000; // 10 minutes
const DISCONNECT_GRACE_PERIOD = 30 * 60 * 1000; // 30 minutes
module.exports = (io, socket) => {
  const joinRoom = async (data) => {
    try {
      const { roomId, userId, username, silent = false, invisible = false, role = 'user' } = data;

      // Auto-join user to their own private room for DM delivery
      if (userId && userId !== 'unknown') {
        socket.join(`user:${userId}`);
        logger.info(`🔑 Socket ${socket.id} joined private channel: user:${userId}`);
      }

      logger.info(`👤 User joining room:`, { roomId, userId, username, silent });

      // ✅ FIX: Check if this is FIRST JOIN or SILENT REJOIN
      const redisClient = getRedisClient();
      const disconnectTimeStr = await redisClient.get(`user:${userId}:disconnect_time`);
      const isFirstJoin = !disconnectTimeStr; // true = first join, false = reconnect
      const timeSinceDisconnect = disconnectTimeStr ? Date.now() - parseInt(disconnectTimeStr) : Infinity;
      const isSilentRejoin = !isFirstJoin && timeSinceDisconnect < silentRejoinWindow;

      logger.info(`✅ Join type - First:${isFirstJoin} | SilentRejoin:${isSilentRejoin} | Time since disconnect: ${Math.round(timeSinceDisconnect / 1000)}s`);
      logger.info(`   disconnectTimeStr: ${disconnectTimeStr}, silentRejoinWindow: ${silentRejoinWindow}`);

      const timerKey = `${userId}-${roomId}`;
      if (disconnectTimers.has(timerKey)) {
        clearTimeout(disconnectTimers.get(timerKey));
        disconnectTimers.delete(timerKey);
        logger.info(`✅ Reconnected within grace period - keeping user in room: ${username}`);
      }
      if (leaveGraceTimers.has(timerKey)) {
        clearTimeout(leaveGraceTimers.get(timerKey));
        leaveGraceTimers.delete(timerKey);
        logger.info(`✅ Leave grace timer cancelled - user ${username} rejoined room ${roomId}`);
      }

      if (!roomId || !userId || !username) {
        socket.emit('error', { message: 'Missing required fields' });
        return;
      }

      // Check kick cooldowns and global ban
      const joinCheck = await checkJoinAllowed(username, roomId, userId);
      if (!joinCheck.allowed) {
        socket.emit('system:message', {
          roomId,
          message: joinCheck.reason,
          timestamp: new Date().toISOString(),
          type: 'error'
        });
        socket.emit('room:join:rejected', {
          roomId,
          reason: joinCheck.reason,
          type: joinCheck.type,
          remainingSeconds: joinCheck.remainingSeconds
        });
        return;
      }

      // Check if user is temporarily bumped from this room
      const bumpKey = `room:bump:${roomId}:${userId}`;
      const isBumped = await redisClient.exists(bumpKey);

      if (isBumped) {
        socket.emit('room:join:error', {
          roomId,
          message: 'You were recently removed by admin. Please wait a moment before rejoining.',
          type: 'bumped'
        });
        return;
      }
      
      // Check if user is temporarily kicked from this room (5 minutes)
      const kickKey = `kick:${roomId}:${userId}`;
      const isKicked = await redisClient.exists(kickKey);
      if (isKicked) {
        const ttl = await redisClient.ttl(kickKey);
        const minutes = Math.ceil(ttl / 60);
        socket.emit('room:join:error', {
          roomId,
          message: `You were kicked from this room. Please wait ${minutes} minute(s) before rejoining.`,
          type: 'kicked'
        });
        socket.emit('room:join:rejected', {
          roomId,
          reason: `Kicked from room. Wait ${minutes} minute(s).`,
          type: 'kicked',
          remainingSeconds: ttl
        });
        return;
      }

      // Check if user is banned (skip ban check for now as banService needs to be fixed)
      try {
        const roomService = require('../services/roomService');
        const banned = await roomService.isUserBanned(roomId, userId, username);
        if (banned) {
          socket.emit('system:message', {
            roomId,
            message: 'You are banned from this room',
            timestamp: new Date().toISOString(),
            type: 'error'
          });
          return;
        }
      } catch (err) {
        logger.info('Ban check skipped:', err.message);
      }

      const room = await roomService.getRoomById(roomId);
      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }
      
      // Check minimum level requirement (skip for owner and moderators)
      if (room.min_level && room.min_level > 1) {
        const { getUserLevel } = require('../utils/xpLeveling');
        const userLevelData = await getUserLevel(userId);
        const userLevel = userLevelData?.level || 1;
        
        // Check if user is owner
        const isOwner = room.owner_id == userId || room.created_by == userId;
        
        // Check if user is moderator
        let isModerator = false;
        try {
          const db = require('../db/db');
          const modCheck = await db.query(
            'SELECT 1 FROM room_moderators WHERE room_id = $1 AND user_id = $2',
            [roomId, userId]
          );
          isModerator = modCheck.rows.length > 0;
        } catch (modErr) {
          logger.info('Moderator check error:', modErr.message);
        }
        
        // Check if user has special role that bypasses level requirement
        const hasSpecialRole = role === 'admin' || role === 'super_admin' || role === 'cs';
        
        // Block entry if below minimum level and not owner/moderator/special role
        if (!isOwner && !isModerator && !hasSpecialRole && userLevel < room.min_level) {
          socket.emit('system:message', {
            roomId,
            message: `Unable to join chat room. Minimum level is ${room.min_level}. Your level: ${userLevel}`,
            timestamp: new Date().toISOString(),
            type: 'error'
          });
          socket.emit('room:join:rejected', {
            roomId,
            reason: `Minimum level required: ${room.min_level}`,
            type: 'level_required',
            minLevel: room.min_level,
            userLevel: userLevel
          });
          return;
        }
      }

      // Check if room is locked (only mods/owner/admin can enter)
      if (room.is_locked) {
        const isOwner = room.owner_id == userId || room.created_by == userId;
        const isGlobalAdmin = role === 'admin' || role === 'super_admin' || role === 'customer_service';
        
        let isModerator = false;
        try {
          const db = require('../db/db');
          const modCheck = await db.query(
            'SELECT 1 FROM room_moderators WHERE room_id = $1 AND user_id = $2',
            [roomId, userId]
          );
          isModerator = modCheck.rows.length > 0;
        } catch (modErr) {
          logger.info('Moderator check error:', modErr.message);
        }
        
        if (!isOwner && !isModerator && !isGlobalAdmin) {
          socket.emit('system:message', {
            roomId,
            message: '🔒 This room is locked. Only moderators can enter.',
            timestamp: new Date().toISOString(),
            type: 'error'
          });
          socket.emit('room:join:rejected', {
            roomId,
            reason: 'Room is locked',
            type: 'room_locked'
          });
          return;
        }
      }

      // Check room capacity using Socket.IO adapter (source of truth - admin can bypass)
      const currentUserCount = getRealRoomCount(io, roomId);
      const isAdmin = role === 'admin' || role === 'super_admin';
      if (currentUserCount >= room.max_users && !isAdmin) {
        socket.emit('system:message', {
          roomId,
          message: 'Room is full',
          timestamp: new Date().toISOString(),
          type: 'error'
        });
        return;
      }
      
      // Store invisible status on socket for later use (leave message)
      socket.invisible = invisible && isAdmin;

      socket.join(`room:${roomId}`);
      socket.join(`user:${username}`);

      // Store username on socket for disconnect handler
      socket.username = username;
      socket.userId = userId;
      socket.currentRoomId = roomId;

      // 🔐 Track user's active rooms in Redis (for /whois command)
      try {
        const redisForRooms = getRedisClient();
        await redisForRooms.sAdd(`user:${userId}:rooms`, String(roomId)); // Ensure room ID is string
        await redisForRooms.expire(`user:${userId}:rooms`, 21600); // 6 hour expiry
        // logger.info(`✅ Added room ${roomId} to user ${userId} active rooms`);

        // Update real-time count for room list (using Socket.IO adapter)
        emitRoomCountUpdate(io, roomId);
      } catch (roomsErr) {
        console.warn('⚠️ Could not track user rooms:', roomsErr.message);
      }

      // Update real-time count for room list (using Socket.IO adapter as source of truth)
      emitRoomCountUpdate(io, roomId);

      // Store presence in Redis with 6-hour TTL
      await storeUserPresence(roomId, userId, socket.id, username);

      // Store IP mapping in Redis
      try {
        const userIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
        const redisForIp = getRedisClient();
        await redisForIp.set(`user:${userId}:ip`, userIp);
        await redisForIp.sAdd(`ip:${userIp}:users`, userId.toString());
        await redisForIp.expire(`user:${userId}:ip`, 21600); // 6 hours
        await redisForIp.expire(`ip:${userIp}:users`, 21600); // 6 hours
      } catch (ipErr) {
        console.warn('⚠️ Could not store user IP:', ipErr.message);
      }

      // Check if user is already in room (prevents duplicate join messages)
      const alreadyInRoom = await isUserInRoom(roomId, username);

      await addUserRoom(username, roomId, room.name);

      // Add user to Redis presence (skip for invisible admin)
      if (!socket.invisible) {
        await addUserToRoom(roomId, username);
      }

      // Save room history to DATABASE (for Chat menu)
      await roomService.saveRoomHistory(userId, roomId);

      // Add to participants (MIG33 style - Redis Set) - skip for invisible admin
      if (!socket.invisible) {
        await addRoomParticipant(roomId, username);
        
        // Broadcast updated participants to all users in room (for participant menu + live update)
        const updatedParticipants = await getRoomParticipants(roomId);
        const participantListString = updatedParticipants.join(', ');
        
        io.to(`room:${roomId}`).emit('room:participants:update', {
          roomId,
          participants: updatedParticipants
        });
        
        // Broadcast live "Currently users" update (frontend will update existing message in-place)
        io.to(`room:${roomId}`).emit('room:currently:update', {
          roomId,
          roomName: room.name,
          participants: participantListString
        });
      }
      
      // Get current users AFTER adding new user (so list includes the joiner)
      const currentUsersList = await getRoomPresenceUsers(roomId);

      // Get updated count after adding user
      const newUserCount = await getRoomUserCount(roomId);

      const user = await userService.getUserById(userId);
      const userWithPresence = {
        ...user,
        presence: await getPresence(username)
      };

      // Get all users from database
      const updatedUsers = await roomService.getRoomUsers(roomId);
      const usersWithPresence = await Promise.all(
        updatedUsers.map(async (u) => ({
          ...u,
          presence: await getPresence(u.username)
        }))
      );

      // ALWAYS send room info messages (Welcome, managed by, users) curently in the room,has entered- MIG33 style
      // Show welcome ONLY on first join (not on silent rejoin)
      if (!silent) {
        // Create user list string for welcome message
        const userListString = currentUsersList.length > 0
          ? currentUsersList.join(', ')
          : username;

        // MIG33-style welcome messages - send to the joining user only
        // Use description as welcome message if available, otherwise default message
        const welcomeMsg1 = room.description && room.description.trim() 
          ? room.description.trim() 
          : `Welcome to ${room.name}...`;

        // Send welcome messages in correct order
        socket.emit('chat:message', {
          id: Date.now().toString() + '-1',
          roomId,
          username: room.name,
          message: welcomeMsg1,
          timestamp: new Date().toISOString(),
          type: 'system',
          messageType: 'system'
        });

        // Only send "managed by" message for user-created rooms (has owner_id)
        // Admin-created rooms (no owner_id) don't show this message
        if (room.owner_id && (room.owner_name || room.creator_name)) {
          const managedByName = room.owner_name || room.creator_name;
          const welcomeMsg2 = `This room is managed by ${managedByName}`;
          setTimeout(() => {
            socket.emit('chat:message', {
              id: Date.now().toString() + '-2',
              roomId,
              username: room.name,
              message: welcomeMsg2,
              timestamp: new Date().toISOString(),
              type: 'system',
              messageType: 'system'
            });
          }, 100);
        }

        setTimeout(async () => {
          // Fetch from participants set (same source as participant menu)
          const updatedParticipants = await getRoomParticipants(roomId);
          const freshUserListString = updatedParticipants.length > 0
            ? updatedParticipants.join(', ')
            : username;

          socket.emit('chat:message', {
            id: Date.now().toString() + '-3',
            roomId,
            username: room.name,
            message: `Currently users in the room: ${freshUserListString}`,
            timestamp: new Date().toISOString(),
            type: 'system',
            messageType: 'system'
          });

          // Update real-time count for room list (using Socket.IO adapter)
          emitRoomCountUpdate(io, roomId);

          // Broadcast "has entered" message to everyone (including self)
          const userLevelData = await getUserLevel(userId);
          const userLevel = userLevelData?.level || 1;
          const user = await userService.getUserById(userId);
          const userType = user?.role || 'normal';

          const enterMsg = `${username} [${userLevel}] has entered`;
          const enterMessage = {
            id: `presence-enter-${Date.now()}-${Math.random()}`,
            roomId,
            username: room.name,
            message: enterMsg,
            timestamp: new Date().toISOString(),
            type: 'presence',
            messageType: 'presence',
            userType: userType
          };

          // Broadcast to ALL users in the room (including sender)
          io.to(`room:${roomId}`).emit('chat:message', enterMessage);

          // Send room announcement if exists
          const redis = getRedisClient();
          const announcement = await redis.get(`announce:${roomId}`);
          if (announcement) {
            setTimeout(() => {
              socket.emit('chat:message', {
                id: Date.now().toString() + '-4',
                roomId,
                username: '',
                message: announcement,
                timestamp: new Date().toISOString(),
                type: 'announcement',
                messageType: 'announcement'
              });
            }, 300);
          }
          
          // Send bot welcome message for game rooms
          const roomNameLower = room.name.toLowerCase();
          if (roomNameLower.includes('lowcard')) {
            setTimeout(() => {
              socket.emit('chat:message', {
                id: Date.now().toString() + '-bot',
                roomId,
                username: 'LowCardBot',
                message: 'LowCardBot: [PVT] Play now: !start to enter. Cost: 1 COINS. For custom entry, !start [amount]',
                timestamp: new Date().toISOString(),
                type: 'bot',
                messageType: 'lowcard',
                botType: 'lowcard',
                userType: 'bot',
                usernameColor: '#719c35',
                messageColor: '#347499'
              });
            }, 400);
          } else if (roomNameLower.includes('flag')) {
            setTimeout(() => {
              socket.emit('chat:message', {
                id: Date.now().toString() + '-bot-flag',
                roomId,
                username: 'FlagBot',
                message: 'FlagBot: FlagBot ready for the next round. Type !fg to start.',
                timestamp: new Date().toISOString(),
                type: 'bot',
                messageType: 'flagbot',
                botType: 'flagbot',
                userType: 'bot',
                usernameColor: '#719c35',
                messageColor: '#347499'
              });
            }, 400);
          } else if (roomNameLower.includes('dice')) {
            setTimeout(() => {
              socket.emit('chat:message', {
                id: Date.now().toString() + '-bot-dice',
                roomId,
                username: 'DiceBot',
                message: 'DiceBot: Play now: !start to enter. Cost: 1 COINS. For custom entry, !start [amount]',
                timestamp: new Date().toISOString(),
                type: 'bot',
                messageType: 'dicebot',
                botType: 'dicebot',
                userType: 'bot',
                usernameColor: '#719c35',
                messageColor: '#347499'
              });
            }, 400);
          }
        }, 200);
      } else if (isSilentRejoin) {
        logger.info(`🔇 [Room ${roomId}] Silent reconnect - skipping welcome messages for ${username}`);
      }

            // MIG33-style enter message to all users in room (presence event - not saved to Redis)
      // ✅ CHANGE: ONLY broadcast "has entered" if FIRST JOIN (not silent rejoin, not already in room)
      const isInvisibleAdmin = invisible && isAdmin;
      if (!isSilentRejoin && !alreadyInRoom && !isInvisibleAdmin) {
        // (Removing the duplicate broadcast here to avoid double messages)
        io.to(`room:${roomId}`).emit('room:user:joined', {
          roomId,
          user: userWithPresence,
          users: usersWithPresence
         });
      } else if (alreadyInRoom) {
        logger.info(`✅ User ${username} already in room ${roomId}, showing room info but skipping enter message`);
      } else if (isSilentRejoin) {
        logger.info(`🔇 [Room ${roomId}] Silent rejoin for ${username} - NO "has entered" broadcast`);
      }

      logger.info('📤 Sending room:joined event:', {
        roomId,
        roomName: room.name,
        description: room.description,
        userCount: newUserCount,
        username
      });

      socket.emit('room:joined', {
        roomId,
        room,
        users: usersWithPresence,
        currentUsers: await getRoomPresenceUsers(roomId),
        userCount: newUserCount
      });

      // Check if any bot is active and notify user (only once per session)
      try {
        const legendService = require('../services/legendService');
        const dicebotService = require('../services/dicebotService');
        const lowcardService = require('../services/lowcardService');
        const { generateMessageId } = require('../utils/idGenerator');
        const redisClient = getRedisClient();
        
        const flagBotActive = await legendService.isBotActive(roomId);
        const diceBotActive = await dicebotService.isBotActive(roomId);
        const lowCardActive = await lowcardService.isBotActive(roomId);
        
        // Check if user already saw bot welcome message (30 min TTL)
        const welcomeKey = `bot:welcome:${roomId}:${username}`;
        const alreadySeen = await redisClient.get(welcomeKey);
        
        if (!alreadySeen) {
          // Mark as seen (expires in 30 minutes)
          await redisClient.set(welcomeKey, '1', 'EX', 1800);
          
          if (flagBotActive) {
            setTimeout(() => {
              socket.emit('chat:message', {
                id: generateMessageId(),
                roomId,
                username: 'FlagBot',
                message: 'Flag is running in room. Type !fg to start a game.',
                messageType: 'flagbot',
                type: 'bot',
                botType: 'flagbot',
                userType: 'bot',
                usernameColor: '#347499',
                messageColor: '#719c35',
                isPrivate: true,
                timestamp: new Date().toISOString()
              });
            }, 500);
          } else if (diceBotActive) {
            setTimeout(() => {
              socket.emit('chat:message', {
                id: generateMessageId(),
                roomId,
                username: 'DiceBot',
                message: 'DiceBot is running in room. Type !start [amount] to start a game.',
                messageType: 'dicebot',
                type: 'bot',
                botType: 'dicebot',
                userType: 'bot',
                usernameColor: '#FFD700',
                isPrivate: true,
                timestamp: new Date().toISOString()
              });
            }, 500);
          } else if (lowCardActive) {
            setTimeout(() => {
              socket.emit('chat:message', {
                id: generateMessageId(),
                roomId,
                username: 'LowCardBot',
                message: 'LowCard is running in room. Type !start [amount] to start a game.',
                messageType: 'lowcard',
                type: 'bot',
                botType: 'lowcard',
                userType: 'bot',
                usernameColor: '#4CAF50',
                isPrivate: true,
                timestamp: new Date().toISOString()
              });
            }, 500);
          }
        }
      } catch (err) {
        console.error('Error checking bot status:', err);
      }

      // Room is already added to user:rooms via addUserRoom() called earlier (line 165)
      // No need to add again - just set the last message
      const redisInstance = getRedisClient();

      // Set initial last message as JSON string (consistent format)
      await redisInstance.set(`room:lastmsg:${roomId}`, JSON.stringify({
        message: `${username} joined`,
        username: room.name,
        timestamp: new Date().toISOString()
      }));
      await redisInstance.expire(`room:lastmsg:${roomId}`, 86400); // 24 hours

      logger.info('📤 Emitting chatlist events to user:', { username });

      // Emit to socket directly - single emit to prevent duplicates
      socket.emit('chatlist:roomJoined', {
        roomId,
        roomName: room.name
      });

      socket.emit('chatlist:update', { 
        roomId,
        roomName: room.name,
        action: 'joined'
      });

      await addXp(userId, XP_REWARDS.JOIN_ROOM, 'join_room', io);

      // Track this room in user's active rooms for proper disconnect cleanup
      await addUserActiveRoom(userId, roomId);

      await addRecentRoom(username, roomId, room.name);
      await incrementRoomActive(roomId);

      io.emit('rooms:updateCount', {
        roomId,
        userCount: newUserCount,
        maxUsers: room.max_users
      });

      // Broadcast participants update (MIG33 style) - exclude current user
      const allParticipants = await getRoomParticipantsWithNames(roomId);
      io.to(`room:${roomId}`).emit('room:participants:update', {
        roomId,
        participants: allParticipants
      });

      if (isSilentRejoin) {
        logger.info(`🔇 [joinRoom] Silent rejoin for ${username} - no backlog (client uses chat:sync for delta)`);
      } else {
        logger.info(`🆕 [joinRoom] Fresh enter for ${username} - no backlog sent`);
      }

    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  };

  const leaveRoom = async (data) => {
    try {
      const { roomId, userId: presenceUserId, username } = data;
      logger.info(`👤 User explicitly leaving room (menu click):`, { roomId, userId: presenceUserId, username });

      if (!roomId || !presenceUserId || !username) {
        socket.emit('error', { message: 'Missing required fields' });
        return;
      }

      socket.leave(`room:${roomId}`);

      const redisClient = getRedisClient();

      // Cancel any pending disconnect timer for this user+room
      const disconnectTimerKey = `${presenceUserId}-${roomId}`;
      if (disconnectTimers.has(disconnectTimerKey)) {
        clearTimeout(disconnectTimers.get(disconnectTimerKey));
        disconnectTimers.delete(disconnectTimerKey);
        logger.info(`🛑 Cancelled disconnect timer for ${username} in room ${roomId} (explicit leave)`);
      }

      // Cancel any pending leave grace timer
      const leaveTimerKey = `${presenceUserId}-${roomId}`;
      if (leaveGraceTimers.has(leaveTimerKey)) {
        clearTimeout(leaveGraceTimers.get(leaveTimerKey));
        leaveGraceTimers.delete(leaveTimerKey);
      }

      // Immediately cleanup all Redis data
      await removeUserFromRoom(roomId, username);

      try {
        const userIp = await redisClient.get(`user:${presenceUserId}:ip`);
        if (userIp) {
          await redisClient.sRem(`ip:${userIp}:users`, presenceUserId.toString());
        }
      } catch (cleanupErr) {
        console.warn('⚠️ Could not cleanup user IP:', cleanupErr.message);
      }

      if (presenceUserId) {
        await removeUserPresence(roomId, presenceUserId);
      }

      if (username) {
        await removeRoomParticipant(roomId, username);
      }

      await removeUserRoom(username, roomId);

      try {
        const roomUsersKey = `room:users:${roomId}`;
        await redisClient.sRem(roomUsersKey, username);
        await redisClient.sRem(`user:${presenceUserId}:rooms`, String(roomId));
      } catch (cleanupErr) {
        console.warn('⚠️ Could not cleanup user rooms:', cleanupErr.message);
      }

      // Broadcast "has left" message - ONLY from explicit Leave Room click
      const updatedParticipants = await getRoomParticipants(roomId);
      const room = await roomService.getRoomById(roomId);
      const participantListString = updatedParticipants.join(', ') || 'No users';

      const isInvisibleAdmin = socket.invisible === true;
      if (!isInvisibleAdmin) {
        socket.leftMessageSent = true;
        socket.leftRoomId = roomId;

        const userLevelData = await getUserLevel(presenceUserId);
        const userLevel = userLevelData?.level || 1;
        const user = await userService.getUserById(presenceUserId);
        const userType = user?.role || 'normal';

        const leftMsg = `${username} [${userLevel}] has left`;
        const leftMessage = {
          id: `presence-leave-${Date.now()}-${Math.random()}`,
          roomId,
          username: room?.name || 'Room',
          message: leftMsg,
          timestamp: new Date().toISOString(),
          type: 'presence',
          messageType: 'presence',
          userType: userType
        };

        io.to(`room:${roomId}`).emit('chat:message', leftMessage);
        logger.info(`✅ Broadcast "has left" for ${username} in room ${roomId} (explicit leave)`);

        const updatedUsers = await roomService.getRoomUsers(roomId);
        io.to(`room:${roomId}`).emit('room:user:left', {
          roomId,
          username,
          userId: presenceUserId,
          users: updatedUsers
        });
      }

      io.to(`room:${roomId}`).emit('room:participants:update', {
        roomId,
        participants: updatedParticipants
      });

      io.to(`room:${roomId}`).emit('room:currently:update', {
        roomId,
        roomName: room?.name || 'Room',
        participants: participantListString
      });

      emitRoomCountUpdate(io, roomId);
      await decrementRoomActive(roomId);

      logger.info(`✅ User ${username} fully removed from room ${roomId} (explicit leave - immediate)`);
    } catch (error) {
      logger.error('Error leaving room:', error);
      socket.emit('error', { message: 'Failed to leave room' });
    }
  };

  const getRoomUsers = async (data) => {
    try {
      const { roomId } = data;
      const users = await roomService.getRoomUsers(roomId);

      logger.info('📤 Sending room users to client:', {
        roomId,
        userCount: users.length,
        users: users.map(u => u.username || u)
      });

      socket.emit('room:users', {
        roomId,
        users,
        count: users.length
      });
    } catch (error) {
      console.error('Error getting room users:', error);
      socket.emit('error', { message: 'Failed to get room users' });
    }
  };

  const adminKick = async (data) => {
    try {
      const { roomId, targetUserId, targetUsername, adminId } = data;

      const isAdmin = await roomService.isRoomAdmin(roomId, adminId);
      if (!isAdmin) {
        socket.emit('error', { message: 'You are not an admin' });
        return;
      }

      await roomService.kickUser(roomId, targetUserId, targetUsername);

      io.to(`room:${roomId}`).emit('system:message', {
        roomId,
        message: `${targetUsername} has been kicked from the room`,
        timestamp: new Date().toISOString(),
        type: 'error'
      });

      io.to(`room:${roomId}`).emit('room:user:kicked', {
        roomId,
        userId: targetUserId,
        username: targetUsername
      });

      const users = await roomService.getRoomUsers(roomId);
      io.to(`room:${roomId}`).emit('room:users', {
        roomId,
        users,
        count: users.length
      });

    } catch (error) {
      console.error('Error kicking user:', error);
      socket.emit('error', { message: 'Failed to kick user' });
    }
  };

  const adminBan = async (data) => {
    try {
      const { roomId, targetUserId, targetUsername, adminId, adminUsername, reason, duration } = data;

      const room = await roomService.getRoomById(roomId);
      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      const isAdmin = await roomService.isRoomAdmin(roomId, adminId);
      const isModerator = await roomService.isRoomModerator(roomId, adminId);
      const isOwner = room.owner_id == adminId;
      
      if (!isAdmin && !isModerator) {
        socket.emit('error', { message: 'You are not authorized to ban users' });
        return;
      }

      const targetUser = await userService.getUserByUsername(targetUsername);
      if (targetUser) {
        // PROTECTION: Cannot ban the room creator/owner
        const isGlobalAdmin = await userService.isAdmin(adminId);
        if (targetUser.id == room.owner_id && !isGlobalAdmin) {
          socket.emit('system:message', {
            roomId,
            message: `You cannot ban the room creator`,
            timestamp: new Date().toISOString(),
            type: 'warning'
          });
          return;
        }

        // PROTECTION: Cannot ban other moderators/admins if you are just a moderator
        const targetIsRoomMod = await roomService.isRoomModerator(roomId, targetUser.id);
        const targetIsRoomAdmin = await roomService.isRoomAdmin(roomId, targetUser.id);
        const targetIsModerator = targetIsRoomMod || targetIsRoomAdmin;
        
        if (targetIsModerator && !isOwner && !isGlobalAdmin) {
          socket.emit('system:message', {
            roomId,
            message: `Moderators cannot ban other moderators`,
            timestamp: new Date().toISOString(),
            type: 'warning'
          });
          return;
        }
      }
      
      let bannerRole = 'moderator';
      if (isOwner) {
        bannerRole = 'owner';
      } else if (isAdmin && !isModerator) {
        bannerRole = 'administrator';
      }
      
      const bannerName = adminUsername || socket.username || 'Unknown';

      await roomService.banUser(roomId, targetUserId, targetUsername, adminId, reason);

      // Send private message to banned user
      const roomSockets = await io.in(`room:${roomId}`).fetchSockets();
      for (const targetSocket of roomSockets) {
        if (targetSocket.username === targetUsername || targetSocket.handshake?.auth?.username === targetUsername) {
          targetSocket.emit('chat:message', {
            id: `ban-private-${Date.now()}`,
            roomId,
            username: room.name,
            message: `You has been banned in the Chatroom ${room.name}`,
            timestamp: new Date().toISOString(),
            type: 'system',
            messageType: 'ban',
            isPrivate: true
          });
          
          setTimeout(() => {
            targetSocket.leave(`room:${roomId}`);
            targetSocket.emit('room:banned', {
              roomId,
              roomName: room.name,
              reason: `You has been banned in the Chatroom ${room.name}`
            });
          }, 500);
        }
      }

      // Public message
      io.to(`room:${roomId}`).emit('chat:message', {
        id: `ban-system-${Date.now()}`,
        roomId,
        username: room.name,
        message: `${targetUsername} Has Been banned by ${bannerRole} ${bannerName}`,
        timestamp: new Date().toISOString(),
        type: 'system',
        messageType: 'ban',
        isSystem: true
      });

      io.to(`room:${roomId}`).emit('room:user:banned', {
        roomId,
        userId: targetUserId,
        username: targetUsername,
        reason
      });

      // Remove from presence
      await removeUserFromRoom(roomId, targetUsername);
      await removeUserRoom(targetUsername, roomId);

      const users = await roomService.getRoomUsers(roomId);
      io.to(`room:${roomId}`).emit('room:users', {
        roomId,
        users,
        count: users.length
      });

    } catch (error) {
      console.error('Error banning user:', error);
      socket.emit('error', { message: 'Failed to ban user' });
    }
  };

  const adminUnban = async (data) => {
    try {
      const { roomId, targetUserId, targetUsername, adminId, adminUsername } = data;

      const room = await roomService.getRoomById(roomId);
      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      const isAdmin = await roomService.isRoomAdmin(roomId, adminId);
      const isModerator = await roomService.isRoomModerator(roomId, adminId);
      const isOwner = room.owner_id == adminId;
      
      if (!isAdmin && !isModerator) {
        socket.emit('error', { message: 'You are not authorized to unban users' });
        return;
      }
      
      let unbannerRole = 'moderator';
      if (isOwner) {
        unbannerRole = 'owner';
      } else if (isAdmin && !isModerator) {
        unbannerRole = 'administrator';
      }
      
      const unbannerName = adminUsername || socket.username || 'Unknown';

      await roomService.unbanUser(roomId, targetUserId, targetUsername);

      // Public message
      io.to(`room:${roomId}`).emit('chat:message', {
        id: `unban-system-${Date.now()}`,
        roomId,
        username: room.name,
        message: `${targetUsername} Has unbanned by ${unbannerRole} ${unbannerName}`,
        timestamp: new Date().toISOString(),
        type: 'system',
        messageType: 'unban',
        isSystem: true
      });

      socket.emit('room:user:unbanned', {
        roomId,
        userId: targetUserId,
        username: targetUsername
      });

    } catch (error) {
      console.error('Error unbanning user:', error);
      socket.emit('error', { message: 'Failed to unban user' });
    }
  };

  const getRoomInfo = async (data) => {
    try {
      const { roomId } = data;
      const room = await roomService.getRoomById(roomId);
      const users = await roomService.getRoomUsers(roomId);
      const admins = await roomService.getRoomAdmins(roomId);

      socket.emit('room:info', {
        room,
        users,
        admins,
        userCount: users.length
      });
    } catch (error) {
      console.error('Error getting room info:', error);
      socket.emit('error', { message: 'Failed to get room info' });
    }
  };

  const createRoom = async (data) => {
    try {
      const { name, ownerId, description, maxUsers, isPrivate, password } = data;

      if (!name || !ownerId) {
        socket.emit('error', { message: 'Name and owner ID are required' });
        return;
      }

      const existingRoom = await roomService.getRoomByName(name);
      if (existingRoom) {
        socket.emit('room:create:error', { message: 'Room name already exists' });
        return;
      }

      const room = await roomService.createRoom(name, ownerId, description, maxUsers, isPrivate, password);

      if (!room) {
        socket.emit('room:create:error', { message: 'Failed to create room' });
        return;
      }

      socket.emit('room:created', { room });
      io.emit('rooms:update', { room, action: 'created' });

    } catch (error) {
      console.error('Error creating room:', error);
      socket.emit('error', { message: 'Failed to create room' });
    }
  };

  const kickUser = async (data) => {
    try {
      const { roomId, targetUsername, kickerUserId, kickerUsername, isAdmin } = data;

      if (!roomId || !targetUsername) {
        socket.emit('error', { message: 'Missing required fields' });
        return;
      }

      const room = await roomService.getRoomById(roomId);
      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      // Check if kicker is admin or owner
      const kickerIsAdmin = isAdmin || await roomService.isRoomAdmin(roomId, kickerUserId);
      const kickerIsModerator = await roomService.isRoomModerator(roomId, kickerUserId);
      const isRoomOwner = room.owner_id == kickerUserId;
      
      // Determine kicker role for messages
      let kickerRole = 'moderator';
      if (isRoomOwner) {
        kickerRole = 'owner';
      } else if (kickerIsAdmin) {
        kickerRole = 'administrator';
      }

      if (kickerIsAdmin || kickerIsModerator) {
        // Admin kick - immediate, no vote needed
        const targetUser = await userService.getUserByUsername(targetUsername);
        
        // Check if target is a moderator - moderators cannot be kicked by room owner or other moderators
        if (targetUser) {
          const targetIsRoomMod = await roomService.isRoomModerator(roomId, targetUser.id);
          const targetIsRoomAdmin = await roomService.isRoomAdmin(roomId, targetUser.id);
          const targetIsModerator = targetIsRoomMod || targetIsRoomAdmin;
          const kickerIsGlobalAdmin = await userService.isAdmin(kickerUserId);
          
          // Room owner cannot kick moderators (only global admin can)
          if (targetIsModerator && isRoomOwner && !kickerIsGlobalAdmin) {
            // Room owner/creator SHOULD be able to kick moderators THEY appointed
            // The restriction was previously too tight. Removing it to allow creators to manage their mods.
            logger.info(`👑 Room owner ${kickerUsername} is kicking moderator ${targetUsername}`);
          }
          
          // CRITICAL PROTECTION: Moderator cannot kick the room owner/creator
          if (targetUser.id == room.owner_id && (kickerIsModerator || kickerIsAdmin) && !kickerIsGlobalAdmin) {
            socket.emit('system:message', {
              roomId,
              message: `Moderators cannot kick the room creator`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }
          
          // Moderator cannot kick other moderators (except if kicker is owner or global admin)
          if (targetIsModerator && (kickerIsModerator || kickerIsAdmin) && !isRoomOwner && !kickerIsGlobalAdmin) {
            socket.emit('system:message', {
              roomId,
              message: `Moderators cannot kick other moderators`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }
        }
        
        const result = await executeAdminKick(io, roomId, kickerUsername, targetUsername, kickerUserId, targetUser?.id);

        // Send PRIVATE message to kicked user
        const roomSockets = await io.in(`room:${roomId}`).fetchSockets();
        for (const targetSocket of roomSockets) {
          if (targetSocket.username === targetUsername || targetSocket.handshake?.auth?.username === targetUsername) {
            // Private message to kicked user
            targetSocket.emit('chat:message', {
              id: `kick-private-${Date.now()}`,
              roomId,
              username: room.name,
              message: `You has been kicked by ${kickerRole} ${kickerUsername}`,
              timestamp: new Date().toISOString(),
              type: 'system',
              messageType: 'kick',
              isPrivate: true
            });

            // Force leave after showing message
            setTimeout(() => {
              targetSocket.leave(`room:${roomId}`);
              targetSocket.emit('room:kicked', {
                roomId,
                reason: `You has been kicked by ${kickerRole} ${kickerUsername}`,
                type: 'adminKick',
                isGlobalBanned: result.isGlobalBanned
              });
            }, 500);
          }
        }

        // Send SYSTEM message to other users in room
        const systemMsg = result.userGlobalBanned 
          ? `${targetUsername} Has Been kicked by ${kickerRole} ${kickerUsername} (User banned from all rooms - exceeded 3 kicks)`
          : `${targetUsername} Has Been kicked by ${kickerRole} ${kickerUsername}`;

        io.to(`room:${roomId}`).emit('chat:message', {
          id: `kick-system-${Date.now()}`,
          roomId,
          username: room.name,
          message: systemMsg,
          timestamp: new Date().toISOString(),
          type: 'system',
          messageType: 'kick',
          isSystem: true
        });

        // If user was globally banned, send message to user
        if (result.userGlobalBanned) {
          const userSockets = await io.in(`user:${targetUsername}`).fetchSockets();
          for (const userSocket of userSockets) {
            userSocket.emit('chat:message', {
              id: `ban-user-${Date.now()}`,
              roomId,
              username: 'System',
              message: `You are banned from all rooms due to excessive kicks (${result.userKickCount} kicks).`,
              timestamp: new Date().toISOString(),
              type: 'system',
              messageType: 'ban',
              isSystem: true
            });
          }
        }

        // Remove from presence
        await removeUserFromRoom(roomId, targetUsername);
        await removeUserRoom(targetUsername, roomId);

        // Update user count
        const userCount = await getRoomUserCount(roomId);
        io.to(`room:${roomId}`).emit('room:user:left', {
          roomId,
          username: targetUsername,
          users: await getRoomPresenceUsers(roomId)
        });

        io.emit('rooms:updateCount', {
          roomId,
          userCount,
          maxUsers: room.max_users || 25
        });

      } else {
        // Non-admin - start vote kick
        const activeVote = await hasActiveVote(roomId, targetUsername);
        if (activeVote) {
          // Add vote to existing
          await addVote(io, roomId, kickerUsername, targetUsername);
        } else {
          // Start new vote with payment
          const roomUserCount = await getRoomUserCount(roomId);
          const result = await startVoteKick(io, roomId, kickerUsername, targetUsername, roomUserCount, userId);

          if (!result.success) {
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: room.name,
              message: result.error,
              timestamp: new Date().toISOString(),
              type: 'notice',
              messageType: 'cmdKick',
              isPrivate: true
            });
            return;
          }

          // Send confirmation message to the kicker
          socket.emit('chat:message', {
            id: generateMessageId(),
            roomId,
            username: room.name,
            message: `✅ You started a vote to kick ${targetUsername}. Paid 500 COINS. ${result.votesNeeded - 1} votes needed to kick.`,
            timestamp: new Date().toISOString(),
            type: 'notice',
            messageType: 'cmdKick',
            isPrivate: true
          });
        }
      }

    } catch (error) {
      console.error('Error in kick handler:', error);
      socket.emit('error', { message: 'Failed to process kick' });
    }
  };

  const voteKickUser = async (data) => {
    try {
      const { roomId, targetUsername, voterUsername } = data;

      if (!roomId || !targetUsername || !voterUsername) {
        socket.emit('error', { message: 'Missing required fields' });
        return;
      }

      const activeVote = await hasActiveVote(roomId, targetUsername);
      if (!activeVote) {
        socket.emit('system:message', {
          roomId,
          message: `No active vote to kick ${targetUsername}.`,
          timestamp: new Date().toISOString(),
          type: 'warning'
        });
        return;
      }

      const result = await addVote(io, roomId, voterUsername, targetUsername);

      if (result.kicked) {
        // User was kicked - find and remove from room
        const roomSockets = await io.in(`room:${roomId}`).fetchSockets();
        for (const targetSocket of roomSockets) {
          if (targetSocket.username === targetUsername || targetSocket.handshake?.auth?.username === targetUsername) {
            targetSocket.leave(`room:${roomId}`);
            targetSocket.emit('room:kicked', {
              roomId,
              reason: 'You have been vote-kicked.',
              type: 'voteKick'
            });
          }
        }

        // Remove from presence
        await removeUserFromRoom(roomId, targetUsername);
        await removeUserRoom(targetUsername, roomId);

        const userCount = await getRoomUserCount(roomId);
        const room = await roomService.getRoomById(roomId);

        io.to(`room:${roomId}`).emit('room:user:left', {
          roomId,
          username: targetUsername,
          users: await getRoomPresenceUsers(roomId)
        });

        io.emit('rooms:updateCount', {
          roomId,
          userCount,
          maxUsers: room?.max_users || 25
        });
      }

    } catch (error) {
      console.error('Error in vote kick handler:', error);
      socket.emit('error', { message: 'Failed to process vote' });
    }
  };

  const rejoinRoom = async (data) => {
    try {
      const { roomId, userId, username } = data;

      logger.info(`🔄 User rejoining room (silent):`, { roomId, userId, username });

      if (!roomId || !userId || !username) {
        socket.emit('error', { message: 'Missing required fields' });
        return;
      }

      // Deduplication: prevent processing duplicate rejoin events within 2 seconds
      const redis = getRedisClient();
      const rejoinKey = `rejoin:lock:${userId}:${roomId}`;
      const isLocked = await redis.get(rejoinKey);
      if (isLocked) {
        logger.info(`⏭️ Skipping duplicate rejoin for ${username} in room ${roomId}`);
        return; // Skip duplicate rejoin
      }
      // Set lock with 2 second TTL
      await redis.set(rejoinKey, '1', 'EX', 2);

      const timerKey = `${userId}-${roomId}`;
      if (disconnectTimers.has(timerKey)) {
        clearTimeout(disconnectTimers.get(timerKey));
        disconnectTimers.delete(timerKey);
        logger.info(`✅ Rejoin - cleared disconnect timer for:`, username);
      }

      const room = await roomService.getRoomById(roomId);
      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      socket.join(`room:${roomId}`);
      socket.join(`user:${username}`);
      socket.username = username;

      await addUserToRoom(roomId, username);

      const { addRoomParticipant } = require('../utils/redisUtils');
      await addRoomParticipant(roomId, username);
      
      // Broadcast updated participants to all users in room
      const rejoinParticipants = await getRoomParticipants(roomId);
      io.to(`room:${roomId}`).emit('room:participants:update', {
        roomId,
        participants: rejoinParticipants
      });

      // Broadcast live "Currently users" update on rejoin
      const rejoinParticipantListString = rejoinParticipants.join(', ');
      io.to(`room:${roomId}`).emit('room:currently:update', {
        roomId,
        roomName: room.name,
        participants: rejoinParticipantListString
      });

      const updatedUsers = await roomService.getRoomUsers(roomId);
      const usersWithPresence = await Promise.all(
        updatedUsers.map(async (u) => ({
          ...u,
          presence: await getPresence(u.username)
        }))
      );

      socket.emit('room:joined', {
        roomId,
        room,
        users: usersWithPresence,
        currentUsers: await getRoomPresenceUsers(roomId),
        userCount: await getRoomUserCount(roomId),
        isRejoin: true
      });

      logger.info(`✅ User ${username} silently rejoined room ${roomId} (no backlog - client uses chat:sync for delta)`);

    } catch (error) {
      console.error('Error rejoining room:', error);
      socket.emit('error', { message: 'Failed to rejoin room' });
    }
  };

  // Step 2️⃣: Heartbeat handler - refresh presence TTL every 25-30 seconds
  const heartbeat = async (data) => {
    try {
      const { roomId, userId } = data;
      if (!roomId || !userId) return;

      // Refresh TTL - update presence activity
      const success = await updatePresenceActivity(roomId, userId);

      if (success) {
        // Confirm heartbeat to client (keep-alive confirmation)
        socket.emit('room:heartbeat:ack', {
          roomId,
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.error('Heartbeat error:', error);
    }
  };

  // Logout handler - immediately remove user from room and cleanup Redis
  const logout = async (data) => {
    try {
      const username = socket.username;
      const userId = socket.userId;
      const currentRoomId = socket.currentRoomId;

      if (username && currentRoomId && userId) {
        logger.info(`🚪 User ${username} logging out from room ${currentRoomId}`);

        // Cancel any pending disconnect timer
        const timerKey = `${userId}-${currentRoomId}`;
        if (disconnectTimers.has(timerKey)) {
          clearTimeout(disconnectTimers.get(timerKey));
          disconnectTimers.delete(timerKey);
        }

        // Immediately remove from TTL system
        await removeUserPresence(currentRoomId, userId);

        // Remove from participants
        const { removeRoomParticipant } = require('../utils/redisUtils');
        await removeRoomParticipant(currentRoomId, username);
        
        // Broadcast updated participants to all users in room
        const updatedParticipants = await getRoomParticipants(currentRoomId);
        io.to(`room:${currentRoomId}`).emit('room:participants:update', {
          roomId: currentRoomId,
          participants: updatedParticipants
        });

        // Remove from legacy set
        await removeUserFromRoom(currentRoomId, username);
        const { removeUserRoom } = require('../utils/redisUtils');
        await removeUserRoom(username, currentRoomId);

        // ✅ REMOVE dari participants DULU sebelum broadcast "has left"
        await removeRoomParticipant(currentRoomId, username);

        // Get updated participants SEBELUM broadcast
        const freshUpdatedParticipants = await getRoomParticipants(currentRoomId);
        const freshUpdatedUsers = await getRoomPresenceUsers(currentRoomId);

        // ✅ SEKARANG broadcast "has left" message
        const isInvisibleAdmin = socket.invisible === true;
        const redisClient = getRedisClient();
        const leftGuardKey = `left:${userId}:${currentRoomId}`;
        const canSendLeft = await redisClient.set(leftGuardKey, '1', { NX: true, EX: 30 });
        
        if (!isInvisibleAdmin && canSendLeft) {
          // Mark that we sent the left message (prevents duplicate from disconnect timer)
          socket.leftMessageSent = true;
          socket.leftRoomId = currentRoomId;
          
          const room = await roomService.getRoomById(currentRoomId);
          const userLevelData = await getUserLevel(userId);
          const userLevel = userLevelData?.level || 1;
          const user = await userService.getUserById(userId);
          const userType = user?.role || 'normal';
          
          const leftMsg = `${username} [${userLevel}] has left`;
          io.to(`room:${currentRoomId}`).emit('chat:message', {
            id: `presence-left-${Date.now()}-${Math.random()}`,
            roomId: currentRoomId,
            username: room?.name || 'Room',
            message: leftMsg,
            timestamp: new Date().toISOString(),
            type: 'presence',
            messageType: 'presence',
            userType: userType
          });
          
          io.to(`room:${currentRoomId}`).emit('room:user:left', {
            roomId: currentRoomId,
            username,
            users: freshUpdatedUsers
          });
        }

        // ✅ SEKARANG update participant list (user sudah di-remove)
        io.to(`room:${currentRoomId}`).emit('room:participants:update', {
          roomId: currentRoomId,
          participants: freshUpdatedParticipants
        });

        logger.info(`✅ User ${username} successfully logged out from room ${currentRoomId}`);
      }
    } catch (error) {
      console.error('Error during logout:', error);
    }
  };

  // New command handler for /bump
  const bumpUser = async (data) => {
    try {
      const { roomId, targetUsername } = data;
      const adminId = socket.userId; // Assuming socket has userId

      if (!roomId || !targetUsername) {
        socket.emit('error', { message: 'Missing required fields' });
        return;
      }

      // Check if the user invoking the command is an admin
      const isAdmin = await roomService.isRoomAdmin(roomId, adminId);
      if (!isAdmin) {
        socket.emit('error', { message: 'You are not an administrator.' });
        return;
      }

      const room = await roomService.getRoomById(roomId);
      if (!room) {
        socket.emit('error', { message: 'Room not found.' });
        return;
      }

      // Find the target user's socket ID
      const roomSockets = await io.in(`room:${roomId}`).fetchSockets();
      const targetSocket = roomSockets.find(s => s.username === targetUsername);

      if (!targetSocket) {
        socket.emit('system:message', {
          roomId,
          message: `${targetUsername} is not in this room.`,
          timestamp: new Date().toISOString(),
          type: 'warning'
        });
        return;
      }

      const targetUserId = targetSocket.userId; // Assuming target socket has userId

      // Remove user from room (socket.leave)
      targetSocket.leave(`room:${roomId}`);

      // Send popup to user
      targetSocket.emit('chat:message', {
        id: `bump-popup-${Date.now()}`,
        roomId,
        username: room.name,
        message: 'You have been removed by the administrator.',
        timestamp: new Date().toISOString(),
        type: 'system',
        messageType: 'bump',
        isPrivate: true
      });

      // Send system message to others in room
      io.to(`room:${roomId}`).emit('chat:message', {
        id: `bump-system-${Date.now()}`,
        roomId,
        username: room.name,
        message: `${targetUsername} has been removed by the administrator.`,
        timestamp: new Date().toISOString(),
        type: 'system',
        messageType: 'bump'
      });

      // Update presence and room state
      await removeUserFromRoom(roomId, targetUsername);
      await removeUserRoom(targetUsername, roomId);
      await removeUserPresence(roomId, targetUserId); // Remove from TTL system

      const userCount = await getRoomUserCount(roomId);
      const updatedUsers = await getRoomPresenceUsers(roomId);
      io.to(`room:${roomId}`).emit('room:user:left', {
        roomId,
        username: targetUsername,
        users: updatedUsers
      });

      io.emit('rooms:updateCount', {
        roomId,
        userCount,
        maxUsers: room.max_users || 25
      });

      // Save Redis key: room:bump:<roomId>:<userId> with TTL 10 seconds
      const redis = getRedisClient();
      const bumpKey = `room:bump:${roomId}:${targetUserId}`;
      await redis.set(bumpKey, 'true', 'EX', 10); // 'true' as value, 10 seconds TTL

      logger.info(`✅ User ${targetUsername} (ID: ${targetUserId}) bumped from room ${roomId}. Cooldown set for 10s.`);

    } catch (error) {
      console.error('Error in bump handler:', error);
      socket.emit('error', { message: 'Failed to bump user.' });
    }
  };


  const getParticipants = async (data) => {
    try {
      const { roomId } = data;
      const { getRoomParticipantsWithNames } = require('../utils/redisUtils');
      const participants = await getRoomParticipantsWithNames(roomId);
      
      logger.info('📋 Sending participants list:', { roomId, count: participants.length, participants });
      
      socket.emit('room:participants:update', {
        roomId,
        participants
      });
    } catch (error) {
      console.error('Error getting participants:', error);
      socket.emit('error', { message: 'Failed to get participants' });
    }
  };

  socket.on('join_room', joinRoom);
  socket.on('rejoin_room', rejoinRoom);
  socket.on('room:silent_rejoin', rejoinRoom); // Alias for silent reconnect
  socket.on('leave_room', leaveRoom);
  socket.on('room:leave', leaveRoom);
  socket.on('user:logout', logout);
  socket.on('room:users:get', getRoomUsers);
  socket.on('room:get-participants', getParticipants);
  socket.on('room:kick', kickUser);
  socket.on('room:voteKick', voteKickUser);
  socket.on('room:admin:kick', adminKick);
  socket.on('room:admin:ban', adminBan);
  socket.on('room:admin:unban', adminUnban);
  socket.on('room:info:get', getRoomInfo);
  socket.on('room:create', createRoom);
  socket.on('room:heartbeat', heartbeat);
  // Add handler for the new bump command
  socket.on('room:bump', bumpUser);


  socket.on('disconnect', async () => {
    try {
      logger.info(`⚠️ Socket disconnected: ${socket.id}`);

      if (socket._replaced) {
        logger.info(`⏩ Skipping room disconnect for ${socket.username} - socket replaced by new connection`);
        return;
      }

      const username = socket.username;
      const userId = socket.userId || 'unknown';

      if (username) {
        const { getUserCurrentRoom, removeRoomParticipant, getRoomParticipants } = require('../utils/redisUtils');
        const currentRoomId = await getUserCurrentRoom(username);

        if (currentRoomId) {
          const timerKey = `${userId}-${currentRoomId}`;

          if (disconnectTimers.has(timerKey)) {
            logger.info(`⏳ Timer already exists for ${username} in room ${currentRoomId}. Skipping duplicate.`);
            return;
          }

          const gracePeriodMinutes = DISCONNECT_GRACE_PERIOD / 1000 / 60;
          logger.info(`⏳ Starting ${gracePeriodMinutes}m (${DISCONNECT_GRACE_PERIOD / 1000}s) disconnect grace period for ${username} in room ${currentRoomId}`);

          const timer = setTimeout(async () => {
            try {
              logger.info(`🚪 Disconnect timer expired - removing ${username} from room ${currentRoomId}`);

              disconnectTimers.delete(timerKey);

              let reconnected = false;
              try {
                const roomSockets = await io.in(`room:${currentRoomId}`).fetchSockets();
                for (const s of roomSockets) {
                  if (String(s.userId) === String(userId)) {
                    reconnected = true;
                    break;
                  }
                }
              } catch (checkErr) {
                logger.info(`⚠️ Could not check reconnection for ${username}: ${checkErr.message}`);
              }

              if (reconnected) {
                logger.info(`✅ ${username} reconnected to room ${currentRoomId} - skipping leave broadcast`);
                return;
              }

              const currentParticipants = await getRoomParticipants(currentRoomId);
              const wasInRoom = currentParticipants.includes(username);
              
              if (!wasInRoom) {
                logger.info(`👢 User ${username} already removed from room ${currentRoomId} (likely kicked) - skipping leave broadcast`);
                return;
              }

              // Step 4️⃣: Remove presence on timeout
              if (userId && userId !== 'unknown') {
                await removeUserPresence(currentRoomId, userId);
              }

              await removeRoomParticipant(currentRoomId, username);
              
              // Broadcast updated participants
              const timeoutParticipants = await getRoomParticipants(currentRoomId);
              io.to(`room:${currentRoomId}`).emit('room:participants:update', {
                roomId: currentRoomId,
                participants: timeoutParticipants
              });
              
              // Broadcast "Currently users in the room" update
              const roomForUpdate = await roomService.getRoomById(currentRoomId);
              const participantListStr = timeoutParticipants.join(', ') || 'No users';
              io.to(`room:${currentRoomId}`).emit('room:currently:update', {
                roomId: currentRoomId,
                roomName: roomForUpdate?.name || 'Room',
                participants: participantListStr
              });
              
              await removeUserFromRoom(currentRoomId, username);
              await removeUserRoom(username, currentRoomId);

              // Also clear from legacy room:users:{roomId} set to avoid stale data
              const { getRedisClient } = require('../redis');
              const redis = getRedisClient();
              const roomUsersKey = `room:users:${currentRoomId}`;
              await redis.sRem(roomUsersKey, username);

              // 🔐 Clean up user's active rooms from Redis set on disconnect timeout
              if (userId && userId !== 'unknown') {
                try {
                  await redis.sRem(`user:${userId}:rooms`, String(currentRoomId));
                  logger.info(`✅ Removed room ${currentRoomId} from user ${userId} on disconnect timeout`);
                } catch (cleanupErr) {
                  console.warn('⚠️ Could not cleanup user rooms on timeout:', cleanupErr.message);
                }
              }

              // Note: User already removed from participants set above (line 1563)
              logger.info(`✅ Removed ${username} from legacy Redis set: ${roomUsersKey}`);

              const room = await roomService.getRoomById(currentRoomId);
              
              // Update real-time count for room list (using Socket.IO adapter)
              const userCount = emitRoomCountUpdate(io, currentRoomId);
              
              // Disconnect timer: only cleanup data, NO "has left" broadcast
              // "has left" is ONLY sent when user explicitly clicks Leave Room
              logger.info(`🧹 Disconnect cleanup only (no "has left" broadcast) for ${username} in room ${currentRoomId}`);

              const updatedUsers = await getRoomPresenceUsers(currentRoomId);
              io.to(`room:${currentRoomId}`).emit('room:user:left', {
                roomId: currentRoomId,
                username,
                users: updatedUsers
              });

              const allParticipants = await getRoomParticipantsWithNames(currentRoomId);
              io.to(`room:${currentRoomId}`).emit('room:participants:update', {
                roomId: currentRoomId,
                participants: allParticipants
              });

              await decrementRoomActive(currentRoomId);

              io.emit('rooms:updateCount', {
                roomId: currentRoomId,
                userCount,
                maxUsers: room?.max_users || 25
              });
            } catch (timerError) {
              console.error('Error in disconnect timer:', timerError);
            }
          }, DISCONNECT_GRACE_PERIOD);

          disconnectTimers.set(timerKey, timer);
        }
      }

    } catch (error) {
      console.error('Error handling disconnect:', error);
    }
  });
};