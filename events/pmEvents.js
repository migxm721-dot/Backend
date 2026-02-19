const logger = require('../utils/logger');
const messageService = require('../services/messageService');
const userService = require('../services/userService');
const { getUserSocket, getPresence, getSession } = require('../utils/presence');
const { generateMessageId } = require('../utils/idGenerator');
const { checkGlobalRateLimit } = require('../utils/floodControl');
const { XP_REWARDS, addXp, addDailyChatXp } = require('../utils/xpLeveling');
const { MIG33_CMD } = require('../utils/cmdMapping');

module.exports = (io, socket) => {
  const sendDM = async (data) => {
    try {
      let { fromUserId, fromUsername, toUserId, toUsername, message, clientMsgId } = data;

      logger.info('📩 DM:SEND received:', { fromUserId, fromUsername, toUserId, toUsername, message: message?.substring(0, 50) });

      if (!toUserId && toUsername) {
        const recipient = await userService.getUserByUsername(toUsername);
        if (recipient) {
          toUserId = recipient.id;
        } else {
          socket.emit('dm:error', { message: 'User not found' });
          return;
        }
      }

      if (!fromUserId || !toUserId || !message) {
        socket.emit('dm:error', { message: 'Missing required fields' });
        return;
      }

      if (message.length > 2000) {
        socket.emit('dm:error', { message: 'Message too long (max 2000 characters)' });
        return;
      }

      const rateCheck = await checkGlobalRateLimit(fromUserId);
      if (!rateCheck.allowed) {
        socket.emit('system:message', {
          message: rateCheck.message,
          type: 'warning'
        });
        return;
      }

      // NO presence check before sending as per requirements
      
      const recipient = await userService.getUserById(toUserId);
      const recipientUsername = recipient?.username || toUsername;
      
      // Removed presence check to allow offline messaging
      /*
      const isOnline = await getPresence(recipientUsername);
      if (!isOnline && !recipient) {
         socket.emit('dm:error', { message: 'User is offline' });
         return;
      }
      */

      // Handle commands in DM
      if (message.startsWith('/')) {
        const parts = message.slice(1).split(' ');
        const cmdKey = parts[0].toLowerCase();
        const giftName = parts[1];
        const targetUsername = parts[2] || recipientUsername;
        const { MIG33_CMD } = require('../utils/cmdMapping');

        // Handle MIG33_CMD mapping
        if (MIG33_CMD[cmdKey]) {
          const cmdConfig = MIG33_CMD[cmdKey];
          const target = parts[1] || recipientUsername;
          const formatted = cmdConfig.message(fromUsername, target);
          
          const cmdMessage = {
            id: clientMsgId || generateMessageId(),
            fromUserId,
            toUserId,
            fromUsername,
            toUsername: recipientUsername,
            message: `**${formatted}**`,
            messageType: 'dm',
            timestamp: new Date().toISOString(),
            isRead: false,
            isCommand: true,
            color: '#A52A2A' // Brown color
          };

          io.to(`user:${toUserId}`).emit('dm:receive', cmdMessage);
          io.to(`user:${fromUserId}`).emit('dm:sent', cmdMessage);
          return;
        }

        if (cmdKey === 'me') {
          const actionText = parts.slice(1).join(' ');
          const formatted = actionText ? `** ${fromUsername} ${actionText} **` : `** ${fromUsername} **`;
          
          const cmdMessage = {
            id: clientMsgId || generateMessageId(),
            fromUserId,
            toUserId,
            fromUsername,
            toUsername: recipientUsername,
            message: formatted,
            messageType: 'dm',
            timestamp: new Date().toISOString(),
            isRead: false
          };

          io.to(`user:${toUserId}`).emit('dm:receive', cmdMessage);
          io.to(`user:${fromUserId}`).emit('dm:sent', cmdMessage);
          return;
        }

        if (cmdKey === 'gift') {
          const giftName = parts[1];
          const targetUser = parts[2] || recipientUsername;
          console.log(`🎁 [pmEvents] Gift command detected: /gift ${giftName} ${targetUser} from ${fromUsername}`);

          // Trigger the gift service logic
          const giftService = require('../services/giftQueueService');
          const result = await giftService.sendGift({
            fromUserId,
            fromUsername,
            targetUsername: targetUser,
            giftName,
            roomId: `dm:${fromUserId}:${toUserId}`,
            isPrivate: true
          }, io);

          if (!result.success) {
            console.log(`❌ [pmEvents] Gift failed: ${result.message}`);
            socket.emit('dm:error', { message: result.message || 'Failed to send gift' });
          } else {
            console.log(`✅ [pmEvents] Gift success: ${giftName} to ${targetUser}`);
            // The giftService already sends the gift message to both parties via dm:receive/dm:sent
            // because we updated giftQueueService.js earlier.
          }
          return;
        }
      }

      // Check if sender blocked by recipient
      const { getRedisClient } = require('../redis');
      const redis = getRedisClient();
      let isBlocked = false;
      
      try {
        const cachedBlocked = await redis.get(`user:blocks:${toUserId}`);
        if (cachedBlocked) {
          const blockedIds = JSON.parse(cachedBlocked);
          isBlocked = blockedIds.includes(fromUserId);
        } else {
          const profileService = require('../services/profileService');
          const blockedUsers = await profileService.getBlockedUsers(toUserId);
          const blockedIds = blockedUsers.map(u => u.id);
          isBlocked = blockedIds.includes(fromUserId);
          await redis.set(`user:blocks:${toUserId}`, JSON.stringify(blockedIds), { EX: 300 });
        }
      } catch (err) {
        isBlocked = false;
      }
      
      if (isBlocked) {
        socket.emit('dm:blocked', {
          message: 'You have been blocked',
          toUsername: recipientUsername
        });
        return;
      }

      // Save message to database
      const savedMessage = await messageService.savePrivateMessage(
        fromUserId, toUserId, fromUsername, recipientUsername, message
      );
      
      await addDailyChatXp(fromUserId, io);

      const senderUser = await userService.getUserById(fromUserId);
      const fromRole = senderUser?.role || 'user';
      const fromAvatar = senderUser?.avatar || null;

      const messageData = {
        id: savedMessage?.id || clientMsgId || generateMessageId(),
        fromUserId,
        toUserId,
        fromUsername,
        username: fromUsername, // Ensure username is present for frontend display
        toUsername: recipientUsername,
        message,
        messageType: 'dm',
        fromRole,
        fromAvatar,
        userType: fromRole,
        timestamp: savedMessage?.created_at || new Date().toISOString(),
        isRead: false
      };

      // DM logic: emit to target user room
      const { getUserSockets } = require('../utils/presence');
      const targetSockets = await getUserSockets(toUserId);
      
      logger.info(`📤 Delivering DM to user:${toUserId} (${targetSockets.length} sockets)`);
      
      io.to(`user:${toUserId}`).emit('dm:receive', messageData);
      io.to(`user:${fromUserId}`).emit('dm:sent', messageData);

      // Notify both for chatlist updates
      const chatlistPayload = {
        type: 'dm',
        username: fromUsername,
        userId: fromUserId,
        avatar: fromAvatar,
        lastMessage: {
          message: messageData.message,
          fromUsername: messageData.fromUsername,
          toUsername: messageData.toUsername,
          timestamp: messageData.timestamp
        }
      };
      io.to(`user:${toUserId}`).emit('chatlist:update', chatlistPayload);

      const senderChatlistPayload = {
        type: 'dm',
        username: recipientUsername,
        userId: toUserId,
        lastMessage: {
          message: messageData.message,
          fromUsername: messageData.fromUsername,
          toUsername: messageData.toUsername,
          timestamp: messageData.timestamp
        }
      };
      io.to(`user:${fromUserId}`).emit('chatlist:update', senderChatlistPayload);

    } catch (error) {
      console.error('Error sending DM:', error);
      socket.emit('dm:error', { message: 'Failed to send DM' });
    }
  };

  const getDMs = async (data) => {
    try {
      const { otherUserId, limit = 50, offset = 0 } = data;
      const authUserId = socket.userId || socket.handshake.auth?.userId;
      if (!authUserId || !otherUserId) {
        socket.emit('dm:error', { message: 'Missing required fields' });
        return;
      }
      const messages = await messageService.getPrivateMessages(authUserId, otherUserId, limit, offset);
      await messageService.markMessagesAsRead(authUserId, otherUserId);
      socket.emit('dm:messages', {
        otherUserId,
        messages,
        hasMore: messages.length === limit
      });
    } catch (error) {
      console.error('Error getting DMs:', error);
      socket.emit('dm:error', { message: 'Failed to get DMs' });
    }
  };

  socket.on('dm:send', sendDM);
  socket.on('dm:get', getDMs);
  socket.on('dm:messages:get', getDMs); // Unified getter
};