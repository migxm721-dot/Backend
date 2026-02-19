const logger = require('../utils/logger');
const messageService = require('../services/messageService');
const { checkFlood, checkGlobalRateLimit } = require('../utils/floodControl');
const { generateMessageId } = require('../utils/idGenerator');
const { addXp, addDailyChatXp, XP_REWARDS } = require('../utils/xpLeveling');
const { MIG33_CMD } = require('../utils/cmdMapping');
const claimService = require('../services/claimService');
const voucherService = require('../services/voucherService');
// Game commands are now forwarded to Game Service via Redis Pub/Sub (game:command channel)

module.exports = (io, socket) => {
  const sendMessage = async (data) => {
    try {
      const { roomId, userId, username, message, clientMsgId } = data;

      if (!roomId || !userId || !username || !message) {
        socket.emit('error', { message: 'Missing required fields' });
        return;
      }

      if (message.length > 1000) {
        socket.emit('error', { message: 'Message too long (max 1000 characters)' });
        return;
      }

      // Check if user is actually in the room
      const presence = require('../utils/presence');
      const isInRoom = await presence.isUserInRoom(roomId, userId, username);
      const isInSocketRoom = socket.rooms.has(`room:${roomId}`);
      
      if (!isInRoom || !isInSocketRoom) {
        const { getRedisClient } = require('../redis');
        const redisCheck = getRedisClient();
        const wasKicked = await redisCheck.exists(`kick:${roomId}:${userId}`);
        
        if (wasKicked) {
          const ttl = await redisCheck.ttl(`kick:${roomId}:${userId}`);
          const minutes = Math.ceil(ttl / 60);
          socket.emit('system:message', {
            roomId,
            message: `You have been kicked from this room. Please wait ${minutes} minute(s) before you can chat again.`,
            timestamp: new Date().toISOString(),
            type: 'error'
          });
          socket.leave(`room:${roomId}`);
          return;
        }
        
        // Check if user is banned
        try {
          const roomService = require('../services/roomService');
          const isBannedFromRoom = await roomService.isUserBanned(roomId, userId, username);
          if (isBannedFromRoom) {
            socket.emit('system:message', {
              roomId,
              message: `You are banned from this room.`,
              timestamp: new Date().toISOString(),
              type: 'error'
            });
            return;
          }
        } catch (e) {}
        
        // Auto-rejoin: user reconnected after background/disconnect, silently fix state
        if (!isInSocketRoom) {
          socket.join(`room:${roomId}`);
        }
        if (!isInRoom) {
          await presence.addUserToRoomDetailed(roomId, userId, username);
        }
        // Also fix participants
        const { addRoomParticipant } = require('../utils/redisUtils');
        await addRoomParticipant(roomId, username);
      }

      const floodCheck = await checkFlood(username);
      if (!floodCheck.allowed) {
        const roomService = require('../services/roomService');
        const roomInfo = await roomService.getRoomById(roomId);
        const roomName = roomInfo?.name || roomId;
        socket.emit('system:message', {
          roomId,
          message: `${roomName} : Slow down! Wait a moment before sending another message.`,
          timestamp: new Date().toISOString(),
          type: 'warning'
        });
        return;
      }

      const rateCheck = await checkGlobalRateLimit(userId);
      if (!rateCheck.allowed) {
        socket.emit('system:message', {
          roomId,
          message: rateCheck.message,
          timestamp: new Date().toISOString(),
          type: 'warning'
        });
        return;
      }

      // Check if user or room is silenced
      const { getRedisClient } = require('../redis');
      const redis = getRedisClient();
      
      // Check room-wide silence (affects regular users, not admins/CS/moderators/room owners)
      const isRoomSilenced = await redis.exists(`room:silence:${roomId}`);
      if (isRoomSilenced) {
        const userService = require('../services/userService');
        const user = await userService.getUserById(userId);
        const userRole = user?.role || 'user';
        
        if (userRole === 'user') {
          const roomService = require('../services/roomService');
          const roomInfo = await roomService.getRoomById(roomId);
          const isRoomOwner = roomInfo && roomInfo.owner_id == userId;
          const isRoomAdmin = await roomService.isRoomAdmin(roomId, userId);
          
          if (!isRoomOwner && !isRoomAdmin) {
            socket.emit('system:message', {
              roomId,
              message: `Chat room is currently silenced. Please wait.`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }
        }
      }
      
      // Check if room is locked - only owner/admin/mod can send messages
      {
        const roomService = require('../services/roomService');
        const roomInfo = await roomService.getRoomById(roomId);
        if (roomInfo && roomInfo.is_locked) {
          const userService = require('../services/userService');
          const isRoomOwner = roomInfo.owner_id == userId;
          const isGlobalAdmin = await userService.isAdmin(userId);
          const isModerator = await roomService.isRoomAdmin(roomId, userId);
          
          if (!isRoomOwner && !isGlobalAdmin && !isModerator) {
            socket.emit('system:message', {
              roomId,
              message: `🔒 Room is locked. Only moderators can send messages.`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }
        }
      }
      
      // Check individual user silence (affects role 'user', but room admins/owners bypass)
      const isUserSilenced = await redis.exists(`user:silence:${roomId}:${userId}`);
      if (isUserSilenced) {
        const userService = require('../services/userService');
        const user = await userService.getUserById(userId);
        const userRole = user?.role || 'user';
        
        if (userRole === 'user') {
          const roomService = require('../services/roomService');
          const roomInfo = await roomService.getRoomById(roomId);
          const isRoomOwner = roomInfo && roomInfo.owner_id == userId;
          const isRoomAdminUser = await roomService.isRoomAdmin(roomId, userId);
          
          if (!isRoomOwner && !isRoomAdminUser) {
            socket.emit('system:message', {
              roomId,
              message: `You are silenced and cannot send messages.`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }
        }
      }
      
      // Check if user is kicked from this room
      const kickKey = `kick:${roomId}:${userId}`;
      const isKicked = await redis.exists(kickKey);
      if (isKicked) {
        const ttl = await redis.ttl(kickKey);
        const minutes = Math.ceil(ttl / 60);
        socket.emit('system:message', {
          roomId,
          message: `You have been kicked from this room. Please wait ${minutes} minute(s) before you can chat again.`,
          timestamp: new Date().toISOString(),
          type: 'error'
        });
        // Force leave the room
        socket.leave(`room:${roomId}`);
        socket.emit('room:kicked', {
          roomId,
          message: `You were kicked from this room. Wait ${minutes} minute(s) to rejoin.`
        });
        return;
      }
      
      // Legacy silence check (room admins/owners bypass)
      const isSilenced = await redis.exists(`silence:${roomId}:${userId}`);
      if (isSilenced) {
        const userService = require('../services/userService');
        const user = await userService.getUserById(userId);
        const userRole = user?.role || 'user';
        
        if (userRole === 'user') {
          const roomService = require('../services/roomService');
          const roomInfo = await roomService.getRoomById(roomId);
          const isRoomOwner = roomInfo && roomInfo.owner_id == userId;
          const isRoomAdminUser = await roomService.isRoomAdmin(roomId, userId);
          
          if (!isRoomOwner && !isRoomAdminUser) {
            socket.emit('system:message', {
              roomId,
              message: `${username}: You are silenced and cannot send messages.`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }
        }
      }
      
      // Check if user is banned from this room
      try {
        const roomService = require('../services/roomService');
        const isBanned = await roomService.isUserBanned(roomId, userId, username);
        if (isBanned) {
          socket.emit('system:message', {
            roomId,
            message: `You are banned from this room and cannot send messages.`,
            timestamp: new Date().toISOString(),
            type: 'error'
          });
          // Force leave the room
          socket.leave(`room:${roomId}`);
          socket.emit('room:banned', {
            roomId,
            message: `You are banned from this room.`
          });
          return;
        }
      } catch (banError) {
        console.error('Error checking ban status:', banError.message);
      }

      // Check for bot commands (!start, !j, !d, !r, /bot) - Forward to Game Service via Redis Pub/Sub
      if (message.startsWith('!') || message.startsWith('/bot ') || message.startsWith('/add bot ')) {
        const { publishGameCommand } = require('../pubsub/pub');
        try {
          await publishGameCommand({
            roomId,
            userId,
            username,
            command: message,
            message: message,
            socketId: socket.id,
            timestamp: Date.now()
          });
        } catch (pubErr) {
          console.error('Failed to publish game command:', pubErr.message);
        }
        return;
      }

      // Check if message is a CMD command
      if (message.startsWith('/')) {
        const parts = message.slice(1).split(' ');
        const cmdKey = parts[0].toLowerCase();
        console.log(`[CMD] Received command: "${message}" | parts:`, parts, `| cmdKey: ${cmdKey}`);

        // Handle /dm command from room chat
        if (cmdKey === 'dm') {
          const toUsername = parts[1];
          const dmMessage = parts.slice(2).join(' ');
          
          if (!toUsername || !dmMessage) {
            socket.emit('system:message', {
              roomId,
              message: 'Usage: /dm <username> <message>',
              type: 'warning'
            });
            return;
          }

          const userService = require('../services/userService');
          const recipient = await userService.getUserByUsername(toUsername);
          
          if (!recipient) {
            socket.emit('system:message', {
              roomId,
              message: `User ${toUsername} not found`,
              type: 'error'
            });
            return;
          }

          // Trigger dm:send logic
          socket.emit('dm:send', {
            fromUserId: userId,
            fromUsername: username,
            toUserId: recipient.id,
            toUsername: recipient.username,
            message: dmMessage
          });
          return;
        }

        // Handle /c (claim voucher) command
        if (cmdKey === 'c') {
          const voucherService = require('../services/voucherService');
          const code = parts[1];
          
          if (!code) {
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              message: 'Usage: /c <code>',
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString()
            });
            return;
          }
          
          const roomService = require('../services/roomService');
          const roomInfo = await roomService.getRoomById(roomId);
          const roomName = roomInfo?.name || 'Unknown';
          
          const result = await voucherService.claimVoucher(userId, code, { roomName });
          
          if (result.success) {
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              message: `CONGRATULATIONS You have earned ${result.amount} COINS`,
              messageType: 'cmd',
              type: 'cmd',
              messageColor: '#00FF00',
              timestamp: new Date().toISOString()
            });
          } else {
            let errorMessage = 'Failed to claim voucher';
            if (result.type === 'expired') {
              errorMessage = 'Code has expired';
            } else if (result.type === 'already_claimed') {
              errorMessage = 'You have already claimed this voucher';
            } else if (result.type === 'invalid') {
              errorMessage = 'Invalid voucher code';
            } else if (result.type === 'cooldown') {
              errorMessage = `Please wait ${result.remainingMinutes} minute(s) before claiming again`;
            } else if (result.type === 'busy') {
              errorMessage = 'Please try again';
            } else if (result.type === 'empty') {
              errorMessage = 'Voucher pool is empty';
            }
            
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              message: errorMessage,
              messageType: 'cmd',
              type: 'cmd',
              messageColor: '#FF6B6B',
              timestamp: new Date().toISOString()
            });
          }
          return;
        }

        // Handle /me command
        if (cmdKey === 'me') {
          const actionText = parts.slice(1).join(' ');
          let formatted = actionText ? `** ${username} ${actionText} **` : username;
          
          io.to(`room:${roomId}`).emit('chat:message', {
            id: generateMessageId(),
            roomId,
            message: formatted,
            messageType: 'cmdMe',
            type: 'cmdMe',
            timestamp: new Date().toISOString()
          });
          return;
        }

        // Handle /lvl command - Show user's current level
        if (cmdKey === 'lvl') {
          const { getUserLevel } = require('../utils/xpLeveling');
          const userLevelData = await getUserLevel(userId);
          const userLevel = userLevelData?.level || 1;
          
          io.to(`room:${roomId}`).emit('chat:message', {
            id: generateMessageId(),
            roomId,
            message: `${username} [${userLevel}]`,
            messageType: 'cmd',
            type: 'cmd',
            timestamp: new Date().toISOString()
          });
          return;
        }

        // Handle /spy command - Show users in a specific room
        if (cmdKey === 'spy') {
          const roomNameParam = parts.slice(1).join(' ');
          if (!roomNameParam) {
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              message: 'Usage: /spy {nama room}',
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
            return;
          }

          const roomService = require('../services/roomService');
          const { getRoomParticipants } = require('../utils/redisUtils');
          
          try {
            const targetRoom = await roomService.getRoomByName(roomNameParam);
            if (!targetRoom) {
              socket.emit('chat:message', {
                id: generateMessageId(),
                roomId,
                message: `Room "${roomNameParam}" not found`,
                messageType: 'cmd',
                type: 'cmd',
                timestamp: new Date().toISOString(),
                isPrivate: true
              });
              return;
            }

            const participants = await getRoomParticipants(targetRoom.id);
            const participantsStr = participants.length > 0 ? participants.join(',') : 'No users';
            
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              message: `${targetRoom.name} ${participantsStr}`,
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
          } catch (spyErr) {
            console.error('Spy command error:', spyErr);
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              message: 'Error executing spy command',
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
          }
          return;
        }

        // Handle /bal command - Show user's balance (private - only sender sees it)
        if (cmdKey === 'bal') {
          const creditService = require('../services/creditService');
          const balance = await creditService.getBalance(userId);
          
          socket.emit('chat:message', {
            id: generateMessageId(),
            roomId,
            message: `${username}[${balance}] Coins`,
            messageType: 'cmd',
            type: 'cmd',
            timestamp: new Date().toISOString(),
            isPrivate: true
          });
          return;
        }

          // Handle /set command - Alias for /roll target
          if (cmdKey === 'set') {
            const userService = require('../services/userService');
            const roomService = require('../services/roomService');
            const user = await userService.getUserById(userId);
            const roomInfo = await roomService.getRoomById(roomId);
            const roomName = roomInfo?.name || `Room ${roomId}`;
            
            const isAdminRole = user && (user.role === 'admin' || user.role === 'super_admin' || user.role === 'customer_service' || user.role === 'cs');
            
            const allParts = message.trim().slice(1).split(/\s+/);
            const targetParam = allParts[1];
            
            if (!isAdminRole) {
              socket.emit('chat:message', {
                id: generateMessageId(),
                roomId,
                username: 'System',
                message: `Only admin or customer service can set roll target`,
                messageType: 'cmd',
                type: 'cmd',
                timestamp: new Date().toISOString(),
                isPrivate: true
              });
              return;
            }

            if (targetParam && /^\d+$/.test(targetParam)) {
              const target = parseInt(targetParam);
              if (target >= 1 && target <= 100) {
                await redis.set(`roll:target:${roomId}`, target, 'EX', 3600);
                
                io.to(`room:${roomId}`).emit('chat:message', {
                  id: generateMessageId(),
                  roomId,
                  username: roomName, // Send with room name as username
                  message: `${roomName}: Roll's target has been set to ${target} by ${username}`,
                  messageType: 'rollTarget',
                  type: 'rollTarget',
                  timestamp: new Date().toISOString()
                });
                return;
              }
            }
            
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: `Usage: /set <1-100>`,
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
            return;
          }

          // Handle /roll command
          // /roll <target> - admin/super_admin/customer_service/cs only
          // /roll (without target) - all roles, NO DB query needed
          if (cmdKey === 'roll') {
            const allParts = message.trim().slice(1).split(/\s+/);
            const targetParam = allParts[1];
            
            // If target parameter provided, only then check admin permission (DB query)
            if (targetParam && /^\d+$/.test(targetParam)) {
              const userService = require('../services/userService');
              const user = await userService.getUserById(userId);
              const isAdminRole = user && (user.role === 'admin' || user.role === 'super_admin' || user.role === 'customer_service' || user.role === 'cs');
              
              if (!isAdminRole) {
                socket.emit('chat:message', {
                  id: generateMessageId(),
                  roomId,
                  username: 'System',
                  message: `Only admin or customer service can set roll target`,
                  messageType: 'cmd',
                  type: 'cmd',
                  timestamp: new Date().toISOString(),
                  isPrivate: true
                });
                return;
              }
              
              const target = parseInt(targetParam);
              if (target >= 1 && target <= 100) {
                await redis.set(`roll:target:${roomId}`, target, 'EX', 3600);
                
                io.to(`room:${roomId}`).emit('chat:message', {
                  id: generateMessageId(),
                  roomId,
                  username: username,
                  message: `${username}: Roll's target has been set to ${target} by ${username}`,
                  messageType: 'rollTarget',
                  type: 'rollTarget',
                  timestamp: new Date().toISOString()
                });
                return;
              } else {
                socket.emit('chat:message', {
                  id: generateMessageId(),
                  roomId,
                  username: 'System',
                  message: `Roll target must be between 1 and 100`,
                  messageType: 'cmd',
                  type: 'cmd',
                  timestamp: new Date().toISOString(),
                  isPrivate: true
                });
                return;
              }
            }
            
            // Simple roll - NO database query, only Redis + math
            const rollResult = Math.floor(Math.random() * 100) + 1;
            
            const currentTarget = await redis.get(`roll:target:${roomId}`);
            if (currentTarget && parseInt(currentTarget) === rollResult) {
              await redis.set(`room:silence:${roomId}`, '1', 'EX', 6);
              await redis.del(`roll:target:${roomId}`);
              
              io.to(`room:${roomId}`).emit('chat:message', {
                id: generateMessageId(),
                roomId,
                message: `** ${username} has won roll ${rollResult} **`,
                messageType: 'rollWin',
                type: 'rollWin',
                timestamp: new Date().toISOString()
              });
              
              io.to(`room:${roomId}`).emit('chat:message', {
                id: generateMessageId(),
                roomId,
                message: `Room silenced for 6 seconds - Winner celebration!`,
                messageType: 'system',
                type: 'system',
                timestamp: new Date().toISOString(),
                isSystem: true
              });
              
              setTimeout(() => {
                io.to(`room:${roomId}`).emit('room:unsilenced', { roomId });
                io.to(`room:${roomId}`).emit('chat:message', {
                  id: generateMessageId(),
                  roomId,
                  message: `Room is now open for chat again!`,
                  messageType: 'system',
                  type: 'system',
                  timestamp: new Date().toISOString(),
                  isSystem: true
                });
              }, 6000);
              
              return;
            }
            
            io.to(`room:${roomId}`).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              message: `** ${username} rolls ${rollResult} **`,
              messageType: 'cmdRoll',
              type: 'cmdRoll',
              timestamp: new Date().toISOString()
            });
            return;
          }

        // Handle /unsus command
        if (cmdKey === 'unsus') {
          const userService = require('../services/userService');
          const user = await userService.getUserById(userId);
          const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin' || user.role === 'customer_service' || user.role === 'cs');
          
          if (!isAdmin) {
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: `Only admin or customer service can unsuspend users`,
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
            return;
          }

          const targetUsername = parts[1];
          if (!targetUsername) {
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: `Usage: /unsus <username>`,
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
            return;
          }

          const targetUser = await userService.getUserByUsername(targetUsername);
          if (!targetUser) {
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: `User "${targetUsername}" not found.`,
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
            return;
          }

          const result = await userService.unsuspendUser(targetUser.id);
          if (result) {
            io.to(`room:${roomId}`).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: `${username} has unsuspended ${targetUser.username}`,
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString()
            });
          } else {
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: `Failed to unsuspend ${targetUser.username}`,
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
          }
          return;
        }

        // Handle /announce command
        if (cmdKey === 'announce') {
          const roomService = require('../services/roomService');
          const userService = require('../services/userService');
          const roomInfo = await roomService.getRoomById(roomId);
          const roomName = roomInfo?.name || roomId;
          
          // Check permission - only admin, moderator, or room owner
          const isRoomOwner = roomInfo && roomInfo.owner_id == userId;
          const isGlobalAdmin = await userService.isAdmin(userId);
          const isModerator = await roomService.isRoomAdmin(roomId, userId);
          
          if (!isRoomOwner && !isGlobalAdmin && !isModerator) {
            socket.emit('system:message', {
              roomId,
              message: `Only room owner, admin, or moderator can use /announce`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          if (parts[1]?.toLowerCase() === 'off') {
            await redis.del(`announce:${roomId}`);
            io.to(`room:${roomId}`).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: roomName,
              message: `${username} has turned off the announcement.`,
              messageType: 'presence',
              type: 'presence',
              timestamp: new Date().toISOString()
            });
            return;
          }

          const announcementText = parts.slice(1).join(' ');
          if (!announcementText) {
            socket.emit('system:message', {
              roomId,
              message: `Usage: /announce <text> or /announce off`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          const formattedAnnouncement = `📢 ${announcementText}`;
          await redis.set(`announce:${roomId}`, formattedAnnouncement, 'EX', 86400); // 24h
          
          io.to(`room:${roomId}`).emit('chat:message', {
            id: generateMessageId(),
            roomId,
            message: formattedAnnouncement,
            messageType: 'announce',
            type: 'announce',
            timestamp: new Date().toISOString()
          });
          return;
        }

        // Handle /sus command
        if (cmdKey === 'sus') {
          const userService = require('../services/userService');
          const roomService = require('../services/roomService');
          const user = await userService.getUserById(userId);
          const isAuthorized = user && (user.role === 'super_admin' || user.role === 'admin');

          if (!isAuthorized) {
            socket.emit('system:message', {
              roomId,
              message: 'Only super_admin and admin can use /sus',
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          const targetUsername = parts[1];
          if (!targetUsername) {
            socket.emit('system:message', {
              roomId,
              message: 'Usage: /sus {username}',
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          const targetUser = await userService.getUserByUsername(targetUsername);
          if (!targetUser) {
            socket.emit('system:message', {
              roomId,
              message: `User ${targetUsername} not found.`,
              timestamp: new Date().toISOString(),
              type: 'error'
            });
            return;
          }

          await userService.suspendUser(targetUser.id, userId);
          const roomInfo = await roomService.getRoomById(roomId);
          const roomName = roomInfo?.name || roomId;

          io.to(`room:${roomId}`).emit('chat:message', {
            id: generateMessageId(),
            roomId,
            message: `${roomName}: ${targetUser.username} Has Been suspend by administrator ${username}`,
            messageType: 'system',
            type: 'system',
            timestamp: new Date().toISOString(),
            isSystem: true
          });
          return;
        }

        // Handle /unsu command
        if (cmdKey === 'unsu') {
          const userService = require('../services/userService');
          const roomService = require('../services/roomService');
          const user = await userService.getUserById(userId);
          const isAuthorized = user && (user.role === 'super_admin' || user.role === 'admin');

          if (!isAuthorized) {
            socket.emit('system:message', {
              roomId,
              message: 'Only super_admin and admin can use /unsu',
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          const targetUsername = parts[1];
          if (!targetUsername) {
            socket.emit('system:message', {
              roomId,
              message: 'Usage: /unsu {username}',
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          const targetUser = await userService.getUserByUsername(targetUsername);
          if (!targetUser) {
            socket.emit('system:message', {
              roomId,
              message: `User ${targetUsername} not found.`,
              timestamp: new Date().toISOString(),
              type: 'error'
            });
            return;
          }

          await userService.unsuspendUser(targetUser.id);
          const roomInfo = await roomService.getRoomById(roomId);
          const roomName = roomInfo?.name || roomId;

          io.to(`room:${roomId}`).emit('chat:message', {
            id: generateMessageId(),
            roomId,
            message: `${roomName}: ${targetUser.username} suspension has been lifted by administrator ${username}`,
            messageType: 'system',
            type: 'system',
            timestamp: new Date().toISOString(),
            isSystem: true
          });
          return;
        }

        // Handle /silence command
        if (cmdKey === 'silence') {
          const roomService = require('../services/roomService');
          const userService = require('../services/userService');
          const roomInfo = await roomService.getRoomById(roomId);
          const roomName = roomInfo?.name || roomId;
          
          // Check permission - only admin, moderator, or room owner
          const isRoomOwner = roomInfo && roomInfo.owner_id == userId;
          const isGlobalAdmin = await userService.isAdmin(userId);
          const isModerator = await roomService.isRoomAdmin(roomId, userId);
          
          if (!isRoomOwner && !isGlobalAdmin && !isModerator) {
            socket.emit('system:message', {
              roomId,
              message: `Only room owner, admin, or moderator can use /silence`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          const arg1 = parts[1];
          const arg2 = parts[2];
          
          if (!arg1) {
            socket.emit('system:message', {
              roomId,
              message: `Usage: /silence <time> or /silence <username> <time>`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          // Parse time from string like "20s", "5m", "1h"
          const parseTime = (timeStr) => {
            if (!timeStr) return null;
            const match = timeStr.match(/^(\d+)(s|m|h)?$/i);
            if (!match) return null;
            const value = parseInt(match[1]);
            const unit = (match[2] || 's').toLowerCase();
            switch (unit) {
              case 's': return value;
              case 'm': return value * 60;
              case 'h': return value * 3600;
              default: return value;
            }
          };

          // Check if arg1 is a time (like "20s") or username
          const isTimeFormat = /^\d+(s|m|h)?$/i.test(arg1);
          
          if (isTimeFormat) {
            // Silence entire room: /silence 20s
            const seconds = parseTime(arg1);
            if (!seconds || seconds < 1 || seconds > 3600) {
              socket.emit('system:message', {
                roomId,
                message: `Invalid time. Use 1s-3600s (1 hour max)`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            await redis.set(`room:silence:${roomId}`, '1', 'EX', seconds);
            
            io.to(`room:${roomId}`).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: roomName,
              message: `Chat room has been silenced by ${username} for ${arg1}`,
              messageType: 'system',
              type: 'system',
              timestamp: new Date().toISOString(),
              isSystem: true
            });
          } else {
            // Silence specific user: /silence username 20s
            const targetUsername = arg1;
            const timeStr = arg2;
            
            if (!timeStr) {
              socket.emit('system:message', {
                roomId,
                message: `Usage: /silence <username> <time> (e.g. /silence john 20s)`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            const seconds = parseTime(timeStr);
            if (!seconds || seconds < 1 || seconds > 3600) {
              socket.emit('system:message', {
                roomId,
                message: `Invalid time. Use 1s-3600s (1 hour max)`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            const targetUser = await userService.getUserByUsername(targetUsername);
            if (!targetUser) {
              socket.emit('system:message', {
                roomId,
                message: `User "${targetUsername}" not found`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Can't silence room owner
            if (roomInfo && roomInfo.owner_id == targetUser.id) {
              socket.emit('system:message', {
                roomId,
                message: `Cannot silence the room owner`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Can't silence admin, super_admin, or customer_service
            const protectedRoles = ['admin', 'super_admin', 'customer_service'];
            if (protectedRoles.includes(targetUser.role)) {
              socket.emit('system:message', {
                roomId,
                message: `Cannot silence ${targetUsername}. Admins and staff cannot be silenced.`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            await redis.set(`user:silence:${roomId}:${targetUser.id}`, '1', 'EX', seconds);
            
            io.to(`room:${roomId}`).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: roomName,
              message: `${targetUsername} has been silenced for ${timeStr}`,
              messageType: 'system',
              type: 'system',
              timestamp: new Date().toISOString(),
              isSystem: true
            });
          }
          return;
        }

        // Handle /unsilence command
        if (cmdKey === 'unsilence') {
          const roomService = require('../services/roomService');
          const userService = require('../services/userService');
          const roomInfo = await roomService.getRoomById(roomId);
          const roomName = roomInfo?.name || roomId;
          
          // Check permission - only admin, moderator, or room owner
          const isRoomOwner = roomInfo && roomInfo.owner_id == userId;
          const isGlobalAdmin = await userService.isAdmin(userId);
          const isModerator = await roomService.isRoomAdmin(roomId, userId);
          
          if (!isRoomOwner && !isGlobalAdmin && !isModerator) {
            socket.emit('system:message', {
              roomId,
              message: `Only room owner, admin, or moderator can use /unsilence`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          const targetUsername = parts[1];
          
          if (targetUsername) {
            // Unsilence specific user: /unsilence username
            const targetUser = await userService.getUserByUsername(targetUsername);
            if (!targetUser) {
              socket.emit('system:message', {
                roomId,
                message: `User "${targetUsername}" not found`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            const wassilenced = await redis.exists(`user:silence:${roomId}:${targetUser.id}`);
            const wasLegacySilenced = await redis.exists(`silence:${roomId}:${targetUser.id}`);
            
            // Delete both new and legacy silence keys
            await redis.del(`user:silence:${roomId}:${targetUser.id}`);
            await redis.del(`silence:${roomId}:${targetUser.id}`);
            
            if (wassilenced || wasLegacySilenced) {
              io.to(`room:${roomId}`).emit('chat:message', {
                id: generateMessageId(),
                roomId,
                username: roomName,
                message: `${targetUsername} has been unsilenced by ${username}`,
                messageType: 'system',
                type: 'system',
                timestamp: new Date().toISOString(),
                isSystem: true
              });
              
              // Emit real-time unsilence event directly to the user
              io.to(`user:${targetUser.id}`).emit('user:unsilenced', {
                roomId,
                userId: targetUser.id,
                username: targetUsername
              });
            } else {
              socket.emit('system:message', {
                roomId,
                message: `${targetUsername} is not silenced`,
                timestamp: new Date().toISOString(),
                type: 'info'
              });
            }
          } else {
            // Unsilence entire room: /unsilence
            const wasSilenced = await redis.exists(`room:silence:${roomId}`);
            await redis.del(`room:silence:${roomId}`);
            
            if (wasSilenced) {
              io.to(`room:${roomId}`).emit('chat:message', {
                id: generateMessageId(),
                roomId,
                username: roomName,
                message: `Chat room has been unsilenced by ${username}`,
                messageType: 'system',
                type: 'system',
                timestamp: new Date().toISOString(),
                isSystem: true
              });
              
              // Emit real-time room unsilence event to all users in room
              io.to(`room:${roomId}`).emit('room:unsilenced', { roomId });
            } else {
              socket.emit('system:message', {
                roomId,
                message: `Chat room is not silenced`,
                timestamp: new Date().toISOString(),
                type: 'info'
              });
            }
          }
          return;
        }

        // Handle /ip command - check user IP and linked accounts (admin only)
        if (cmdKey === 'ip') {
          const userService = require('../services/userService');
          const db = require('../db/db');
          
          // Check permission - only admin, super_admin, customer_service
          const allowedRoles = ['admin', 'super_admin', 'customer_service'];
          const currentUser = await userService.getUserById(userId);
          
          if (!currentUser || !allowedRoles.includes(currentUser.role)) {
            socket.emit('system:message', {
              roomId,
              message: `Only admin and staff can use /ip command`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }
          
          const targetUsername = parts[1];
          if (!targetUsername) {
            socket.emit('system:message', {
              roomId,
              message: `Usage: /ip <username>`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }
          
          const targetUser = await userService.getUserByUsername(targetUsername);
          if (!targetUser) {
            socket.emit('system:message', {
              roomId,
              message: `User "${targetUsername}" not found`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }
          
          const userIP = targetUser.last_ip || 'Unknown';
          
          // Find all accounts with same IP (including target user)
          let allUsersWithIP = [targetUsername];
          if (userIP && userIP !== 'Unknown') {
            const result = await db.query(
              'SELECT username FROM users WHERE last_ip = $1 AND username != $2 ORDER BY username',
              [userIP, targetUsername]
            );
            allUsersWithIP = allUsersWithIP.concat(result.rows.map(r => r.username));
          }
          
          const usersList = allUsersWithIP.join(', ');
          
          // Send private response only to requester
          socket.emit('chat:message', {
            id: generateMessageId(),
            roomId,
            username: 'System',
            message: `📍 IP ${userIP}: ${usersList}`,
            messageType: 'cmd',
            type: 'cmd',
            timestamp: new Date().toISOString(),
            isPrivate: true
          });
          return;
        }

        // Handle /suspend command - suspend user account (admin/cs only)
        if (cmdKey === 'suspend') {
          try {
            const userService = require('../services/userService');
            const roomService = require('../services/roomService');
            const db = require('../db/db');
            
            // Check permission - admin, super_admin, customer_service, or cs
            const allowedRoles = ['admin', 'super_admin', 'customer_service', 'cs'];
            const currentUser = await userService.getUserById(userId);
            
            if (!currentUser || !allowedRoles.includes(currentUser.role)) {
              socket.emit('chat:message', {
                id: generateMessageId(),
                roomId,
                username: 'System',
                message: `Only admin or customer service can use /suspend command`,
                messageType: 'cmd',
                type: 'cmd',
                timestamp: new Date().toISOString(),
                isPrivate: true
              });
              return;
            }
            
            // Get room info for response
            const room = await roomService.getRoomById(roomId);
            
            const targetUsername = parts[1];
            if (!targetUsername) {
              socket.emit('chat:message', {
                id: generateMessageId(),
                roomId,
                username: 'System',
                message: `Usage: /suspend <username>`,
                messageType: 'cmd',
                type: 'cmd',
                timestamp: new Date().toISOString(),
                isPrivate: true
              });
              return;
            }
            
            const targetUser = await userService.getUserByUsername(targetUsername);
            if (!targetUser) {
              socket.emit('chat:message', {
                id: generateMessageId(),
                roomId,
                username: 'System',
                message: `User "${targetUsername}" not found`,
                messageType: 'cmd',
                type: 'cmd',
                timestamp: new Date().toISOString(),
                isPrivate: true
              });
              return;
            }
            
            // Can't suspend admin or super_admin
            if (allowedRoles.includes(targetUser.role)) {
              socket.emit('chat:message', {
                id: generateMessageId(),
                roomId,
                username: 'System',
                message: `Cannot suspend admin accounts`,
                messageType: 'cmd',
                type: 'cmd',
                timestamp: new Date().toISOString(),
                isPrivate: true
              });
              return;
            }
            
            // Update user status to suspended with timestamp and admin info
            await db.query(
              'UPDATE users SET status = $1, suspended_at = NOW(), suspended_by = $2 WHERE id = $3', 
              ['suspended', username, targetUser.id]
            );
            
            logger.info(`[SUSPEND] User ${targetUsername} suspended by ${username}`);
            
            // Broadcast to room with room name
            io.to(`room:${roomId}`).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: room?.name || 'System',
              message: `${targetUsername} Has Been suspend by administrator ${username}`,
              messageType: 'system',
              type: 'system',
              timestamp: new Date().toISOString(),
              isSystem: true
            });
            
            // Also send confirmation to admin
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: `✅ Successfully suspended user: ${targetUsername}`,
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
            
            // Kick user from all rooms by emitting disconnect event
            io.to(`user:${targetUser.id}`).emit('user:suspended', {
              message: 'Your account has been suspended. Please contact support.'
            });
          } catch (error) {
            console.error('[SUSPEND] Error:', error);
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: `Failed to suspend user: ${error.message}`,
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
          }
          
          return;
        }

        // Handle /unsuspend command - unsuspend user account (admin only)
        if (cmdKey === 'unsuspend') {
          try {
            const userService = require('../services/userService');
            const db = require('../db/db');
            
            // Check permission - only admin or super_admin
            const allowedRoles = ['admin', 'super_admin'];
            const currentUser = await userService.getUserById(userId);
            
            if (!currentUser || !allowedRoles.includes(currentUser.role)) {
              socket.emit('chat:message', {
                id: generateMessageId(),
                roomId,
                username: 'System',
                message: `Only admin can use /unsuspend command`,
                messageType: 'cmd',
                type: 'cmd',
                timestamp: new Date().toISOString(),
                isPrivate: true
              });
              return;
            }
            
            const targetUsername = parts[1];
            if (!targetUsername) {
              socket.emit('chat:message', {
                id: generateMessageId(),
                roomId,
                username: 'System',
                message: `Usage: /unsuspend <username>`,
                messageType: 'cmd',
                type: 'cmd',
                timestamp: new Date().toISOString(),
                isPrivate: true
              });
              return;
            }
            
            const targetUser = await userService.getUserByUsername(targetUsername);
            if (!targetUser) {
              socket.emit('chat:message', {
                id: generateMessageId(),
                roomId,
                username: 'System',
                message: `User "${targetUsername}" not found`,
                messageType: 'cmd',
                type: 'cmd',
                timestamp: new Date().toISOString(),
                isPrivate: true
              });
              return;
            }
            
            // Check if user is actually suspended
            if (targetUser.status !== 'suspended') {
              socket.emit('chat:message', {
                id: generateMessageId(),
                roomId,
                username: 'System',
                message: `${targetUsername} is not suspended`,
                messageType: 'cmd',
                type: 'cmd',
                timestamp: new Date().toISOString(),
                isPrivate: true
              });
              return;
            }
            
            // Update user status to offline and clear suspension fields
            await db.query(
              'UPDATE users SET status = $1, suspended_at = NULL, suspended_by = NULL WHERE id = $2', 
              ['offline', targetUser.id]
            );
            
            logger.info(`[UNSUSPEND] User ${targetUsername} unsuspended by ${username}`);
            
            // Broadcast to room
            io.to(`room:${roomId}`).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: `${targetUsername} Has Been unsuspend by administrator ${username}`,
              messageType: 'system',
              type: 'system',
              timestamp: new Date().toISOString(),
              isSystem: true
            });
            
            // Also send confirmation to admin
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: `✅ Successfully unsuspended user: ${targetUsername}`,
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
          } catch (error) {
            console.error('[UNSUSPEND] Error:', error);
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: `Failed to unsuspend user: ${error.message}`,
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
          }
          
          return;
        }

        // Handle /block command - block a user (all users can use)
        if (cmdKey === 'block') {
          const profileService = require('../services/profileService');
          const userService = require('../services/userService');
          
          const targetUsername = parts[1];
          if (!targetUsername) {
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: 'Usage: /block <username>',
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
            return;
          }
          
          // Can't block yourself
          if (targetUsername.toLowerCase() === username.toLowerCase()) {
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: 'You cannot block yourself',
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
            return;
          }
          
          // Check if target user exists
          const targetUser = await userService.getUserByUsername(targetUsername);
          if (!targetUser) {
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: `User "${targetUsername}" not found`,
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
            return;
          }
          
          // Block the user
          const result = await profileService.blockUser(userId, targetUsername);
          
          if (result.success) {
            // Invalidate Redis cache
            await redis.del(`user:blocks:${userId}`);
            
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: `You have blocked ${targetUsername}. You will no longer see their messages.`,
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
            
            // Emit event to update client's blocked list
            socket.emit('user:blocked', {
              blockedUsername: targetUsername,
              blockedUserId: targetUser.id
            });
          } else {
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: result.message || 'Failed to block user',
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
          }
          return;
        }

        // Handle /unblock command - unblock a user (all users can use)
        if (cmdKey === 'unblock') {
          const profileService = require('../services/profileService');
          const userService = require('../services/userService');
          
          const targetUsername = parts[1];
          if (!targetUsername) {
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: 'Usage: /unblock <username>',
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
            return;
          }
          
          // Check if target user exists
          const targetUser = await userService.getUserByUsername(targetUsername);
          if (!targetUser) {
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: `User "${targetUsername}" not found`,
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
            return;
          }
          
          // Unblock the user
          const result = await profileService.unblockUser(userId, targetUsername);
          
          if (result.success) {
            // Invalidate Redis cache
            await redis.del(`user:blocks:${userId}`);
            
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: `You have unblocked ${targetUsername}. You will now see their messages.`,
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
            
            // Emit event to update client's blocked list
            socket.emit('user:unblocked', {
              unblockedUsername: targetUsername,
              unblockedUserId: targetUser.id
            });
          } else {
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'System',
              message: result.message || 'Failed to unblock user',
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString(),
              isPrivate: true
            });
          }
          return;
        }

        // Handle /lock command - lock room (only mods can enter)
        if (cmdKey === 'lock') {
          const roomService = require('../services/roomService');
          const userService = require('../services/userService');
          const roomInfo = await roomService.getRoomById(roomId);
          const roomName = roomInfo?.name || roomId;
          
          // Check permission - only admin, moderator, or room owner
          const isRoomOwner = roomInfo && roomInfo.owner_id == userId;
          const isGlobalAdmin = await userService.isAdmin(userId);
          const isModerator = await roomService.isRoomAdmin(roomId, userId);
          
          if (!isRoomOwner && !isGlobalAdmin && !isModerator) {
            socket.emit('system:message', {
              roomId,
              message: `Only room owner, admin, or moderator can use /lock`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          // Check if already locked
          if (roomInfo.is_locked) {
            socket.emit('system:message', {
              roomId,
              message: `Room is already locked`,
              timestamp: new Date().toISOString(),
              type: 'info'
            });
            return;
          }

          // Lock the room
          await roomService.setRoomLocked(roomId, true);
          
          io.to(`room:${roomId}`).emit('chat:message', {
            id: generateMessageId(),
            roomId,
            username: roomName,
            message: `🔒 Room has been locked by ${username}. Only moderators can enter.`,
            messageType: 'system',
            type: 'system',
            timestamp: new Date().toISOString(),
            isSystem: true
          });

          // Emit room:locked event for real-time UI update
          io.to(`room:${roomId}`).emit('room:locked', { roomId, isLocked: true });
          return;
        }

        // Handle /unlock command - unlock room
        if (cmdKey === 'unlock') {
          const roomService = require('../services/roomService');
          const userService = require('../services/userService');
          const roomInfo = await roomService.getRoomById(roomId);
          const roomName = roomInfo?.name || roomId;
          
          // Check permission - only admin, moderator, or room owner
          const isRoomOwner = roomInfo && roomInfo.owner_id == userId;
          const isGlobalAdmin = await userService.isAdmin(userId);
          const isModerator = await roomService.isRoomAdmin(roomId, userId);
          
          if (!isRoomOwner && !isGlobalAdmin && !isModerator) {
            socket.emit('system:message', {
              roomId,
              message: `Only room owner, admin, or moderator can use /unlock`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          // Check if already unlocked
          if (!roomInfo.is_locked) {
            socket.emit('system:message', {
              roomId,
              message: `Room is already unlocked`,
              timestamp: new Date().toISOString(),
              type: 'info'
            });
            return;
          }

          // Unlock the room
          await roomService.setRoomLocked(roomId, false);
          
          io.to(`room:${roomId}`).emit('chat:message', {
            id: generateMessageId(),
            roomId,
            username: roomName,
            message: `🔓 Room has been unlocked by ${username}. Everyone can enter now.`,
            messageType: 'system',
            type: 'system',
            timestamp: new Date().toISOString(),
            isSystem: true
          });

          // Emit room:unlocked event for real-time UI update
          io.to(`room:${roomId}`).emit('room:unlocked', { roomId, isLocked: false });
          return;
        }

        // Handle /gift command (Redis-first with async DB persistence)
        // Format: /gift <giftname> <username> [- <message>]
        // Supports gift names with spaces (e.g., "/gift blue diamond username")
        if (cmdKey === 'gift') {
          // Remove "/gift " prefix
          const afterCmd = message.substring(6).trim();
          
          // Check for optional message after " - "
          let giftMessage = '';
          let mainPart = afterCmd;
          const dashIndex = afterCmd.indexOf(' - ');
          if (dashIndex !== -1) {
            giftMessage = afterCmd.substring(dashIndex + 3).trim();
            mainPart = afterCmd.substring(0, dashIndex).trim();
          }
          
          // Split remaining part - last word is username, everything else is gift name
          const mainParts = mainPart.split(/\s+/);
          if (mainParts.length < 2) {
            socket.emit('system:message', {
              roomId,
              message: `Usage: /gift <giftname> <username> [- <message>]`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }
          
          const targetUser = mainParts.pop(); // Last word is username
          const giftName = mainParts.join(' '); // Everything else is gift name

          if (!giftName || !targetUser) {
            socket.emit('system:message', {
              roomId,
              message: `Usage: /gift <giftname> <username> [- <message>]`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          try {
            const userService = require('../services/userService');
            const giftQueue = require('../services/giftQueueService');
            
            // Check gift cache in Redis first, fallback to DB
            let gift = null;
            const cachedGift = await redis.get(`gift:${giftName.toLowerCase().trim()}`);
            
            if (cachedGift) {
              gift = JSON.parse(cachedGift);
            } else {
              const pool = require('../db/db');
              const giftResult = await pool.query(
                'SELECT * FROM gifts WHERE LOWER(name) = LOWER($1)',
                [giftName.trim()]
              );
              
              if (giftResult.rows.length > 0) {
                gift = giftResult.rows[0];
                await redis.set(`gift:${giftName.toLowerCase().trim()}`, JSON.stringify(gift), { EX: 3600 });
              }
            }
            
            if (!gift) {
              socket.emit('system:message', {
                roomId,
                message: `Gift "${giftName}" not found.`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Check if target user exists
            const targetUserData = await userService.getUserByUsername(targetUser);
            if (!targetUserData) {
              socket.emit('system:message', {
                roomId,
                message: `User "${targetUser}" not found.`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Atomic balance check and deduct in Redis
            const newBalance = await giftQueue.deductCreditsAtomic(userId, gift.price);
            
            if (newBalance === null) {
              socket.emit('system:message', {
                roomId,
                message: `Not enough credits. Gift costs ${gift.price} COINS.`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Get sender and receiver levels
            const senderData = await userService.getUserById(userId);
            const senderLevel = senderData?.level || 1;
            const receiverLevel = targetUserData?.level || 1;
            
            // Format gift message string
            let broadcastMessage = `<< ${username} [${senderLevel}] gives a ${gift.name} [GIFT_IMAGE:${gift.image_url || '🎁'}] to ${targetUser} [${receiverLevel}]`;
            if (giftMessage) {
              broadcastMessage += ` - ${giftMessage}`;
            }
            broadcastMessage += ` >>`;

            // Immediately broadcast gift message (real-time)
            io.to(`room:${roomId}`).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              message: broadcastMessage,
              messageType: 'cmdGift',
              type: 'cmdGift',
              giftData: {
                name: gift.name,
                image_url: gift.image_url,
                price: gift.price,
                sender: username,
                senderLevel: senderLevel,
                receiver: targetUser,
                receiverLevel: receiverLevel,
                comment: giftMessage
              },
              timestamp: new Date().toISOString()
            });
            
            // Emit balance update to sender immediately
            socket.emit('credits:updated', { balance: newBalance });
            
            // Save gift notification to Redis for persistence + emit for real-time
            const notificationService = require('../services/notificationService');
            const crypto = require('crypto');
            const giftNotification = {
              id: crypto.randomBytes(8).toString('hex'),
              type: 'gift',
              from: username,
              fromUserId: userId,
              message: `${username} sent you a gift [${gift.name}]`,
              giftName: gift.name,
              giftImage: gift.image_url
            };
            
            // Save to Redis for persistence (so it appears in notification modal)
            await notificationService.addNotification(targetUser, giftNotification);
            
            // Emit real-time notification for sound
            const receiverSocketId = await redis.get(`socket:${targetUser}`);
            if (receiverSocketId) {
              io.to(receiverSocketId).emit('notif:gift', {
                ...giftNotification,
                timestamp: Date.now()
              });
            }
            
            // Queue async persistence to PostgreSQL (non-blocking)
            giftQueue.queueGiftForPersistence({
              senderId: userId,
              receiverId: targetUserData.id,
              senderUsername: username,
              receiverUsername: targetUser,
              giftName: gift.name,
              giftIcon: gift.image_url,
              giftCost: gift.price
            });
            
            // Async sync balance to DB (non-blocking)
            giftQueue.queueBalanceSyncToDb(userId, newBalance);
            
          } catch (error) {
            console.error('Error processing /gift command:', error);
            socket.emit('system:message', {
              roomId,
              message: `Failed to send gift.`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
          }
          return;
        }

        // Handle /shower command - send gift to all users in room
        if (cmdKey === 'shower') {
          const giftName = parts[1];
          if (!giftName) {
            socket.emit('system:message', {
              roomId,
              message: `Usage: /shower <giftname>`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          try {
            const userService = require('../services/userService');
            const giftQueue = require('../services/giftQueueService');
            const roomService = require('../services/roomService');
            
            // Check gift cache in Redis first, fallback to DB
            let gift = null;
            const cachedGift = await redis.get(`gift:${giftName.toLowerCase().trim()}`);
            
            if (cachedGift) {
              gift = JSON.parse(cachedGift);
            } else {
              const pool = require('../db/db');
              const giftResult = await pool.query(
                'SELECT * FROM gifts WHERE LOWER(name) = LOWER($1)',
                [giftName.trim()]
              );
              
              if (giftResult.rows.length > 0) {
                gift = giftResult.rows[0];
                await redis.set(`gift:${giftName.toLowerCase().trim()}`, JSON.stringify(gift), { EX: 3600 });
              }
            }
            
            if (!gift) {
              socket.emit('system:message', {
                roomId,
                message: `Gift "${giftName}" not found.`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Get all users in room from Redis (correct key: participants)
            const roomParticipants = await redis.sMembers(`room:${roomId}:participants`);
            
            // Filter out sender
            const recipients = roomParticipants.filter(u => u.toLowerCase() !== username.toLowerCase());
            
            if (recipients.length === 0) {
              socket.emit('system:message', {
                roomId,
                message: `No other users in the room to shower gifts.`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Calculate total cost
            const totalCost = recipients.length * gift.price;
            
            // Atomic balance check and deduct in Redis
            const newBalance = await giftQueue.deductCreditsAtomic(userId, totalCost);
            
            if (newBalance === null) {
              socket.emit('system:message', {
                roomId,
                message: `Not enough credits. Shower costs ${totalCost} COINS (${recipients.length} users × ${gift.price} COINS).`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Get sender's level
            const senderData = await userService.getUserById(userId);
            const senderLevel = senderData?.level || 1;
            
            // Format recipients list (show 50% of usernames)
            const maxDisplay = Math.ceil(recipients.length / 2);
            const displayedRecipients = recipients.slice(0, maxDisplay);
            const remainingCount = recipients.length - maxDisplay;
            
            let recipientsList = displayedRecipients.join(', ');
            if (remainingCount > 0) {
              recipientsList += ` and ${remainingCount} others`;
            }
            
            // Broadcast shower message
            io.to(`room:${roomId}`).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              message: `🎁 GIFT SHOWER ${username} [${senderLevel}] gives a ${gift.name} [GIFT_IMAGE:${gift.image_url || '🎁'}] to ${recipientsList}! Hurray! 🎉`,
              messageType: 'cmdShower',
              type: 'cmdShower',
              giftData: {
                name: gift.name,
                image_url: gift.image_url,
                price: gift.price,
                sender: username,
                recipients: recipients,
                totalCost: totalCost
              },
              timestamp: new Date().toISOString()
            });
            
            // Emit balance update to sender immediately
            socket.emit('credits:updated', { balance: newBalance });
            
            // Queue async persistence for each recipient
            for (const recipientUsername of recipients) {
              const recipientData = await userService.getUserByUsername(recipientUsername);
              if (recipientData) {
                giftQueue.queueGiftForPersistence({
                  senderId: userId,
                  receiverId: recipientData.id,
                  senderUsername: username,
                  receiverUsername: recipientUsername,
                  giftName: gift.name,
                  giftIcon: gift.image_url,
                  giftCost: gift.price
                });
              }
            }
            
            // Async sync balance to DB (non-blocking)
            giftQueue.queueBalanceSyncToDb(userId, newBalance);
            
          } catch (error) {
            console.error('Error processing /shower command:', error);
            socket.emit('system:message', {
              roomId,
              message: `Failed to shower gifts.`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
          }
          return;
        }

        // Handle /whois command
        if (cmdKey === 'whois') {
          const targetUsername = parts[1];
          if (!targetUsername) {
            socket.emit('system:message', {
              roomId,
              message: `Usage: /whois <username>`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          try {
            const userService = require('../services/userService');
            const targetUser = await userService.getUserByUsername(targetUsername);

            if (!targetUser) {
              socket.emit('chat:message', {
                id: generateMessageId(),
                roomId,
                message: `** User ${targetUsername} not found **`,
                messageType: 'cmd',
                type: 'cmd',
                timestamp: new Date().toISOString()
              });
              return;
            }

            const levelData = await addXp(targetUser.id, 0, 'none', null); // Get current level without adding XP
            const gender = targetUser.gender ? targetUser.gender.charAt(0).toUpperCase() + targetUser.gender.slice(1) : 'Unknown';
            const country = targetUser.country || 'Unknown';
            
            // Check if user is online and in a room
            const { getRedisClient } = require('../redis');
            const redis = getRedisClient();
            
            // Get all rooms the user is currently in (using the set we maintain)
            const userRooms = await redis.sMembers(`user:${targetUser.id}:rooms`);
            
            let chatStatus = '*';
            if (userRooms && userRooms.length > 0) {
              const roomService = require('../services/roomService');
              // Sort to get the most relevant or just the first one for the status
              const roomPromises = userRooms.map(id => roomService.getRoomById(id));
              const rooms = await Promise.all(roomPromises);
              const validRooms = rooms.filter(r => r).map(r => r.name);
              if (validRooms.length > 0) {
                chatStatus = validRooms.join(', ');
              }
            }

            const response = `** Username: ${targetUser.username}, Level ${levelData.level}, Gender: ${gender}, Country: ${country}, Chatting in, ${chatStatus} **`;

            // Private message - only visible to the user who sent the command
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              message: response,
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString()
            });
          } catch (error) {
            console.error('Error processing /whois:', error);
          }
          return;
        }

        // Handle /f command - Follow user
        if (cmdKey === 'f') {
          const targetUsername = parts[1];
          if (!targetUsername) {
            socket.emit('system:message', {
              roomId,
              message: `Usage: /f <username>`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          try {
            const userService = require('../services/userService');
            const profileService = require('../services/profileService');
            
            const targetUser = await userService.getUserByUsername(targetUsername);
            if (!targetUser) {
              socket.emit('system:message', {
                roomId,
                message: `User "${targetUsername}" not found`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }

            if (targetUser.id == userId) {
              socket.emit('system:message', {
                roomId,
                message: `You cannot follow yourself`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }

            const result = await profileService.followUser(userId, targetUser.id);
            
            // Check if there was an error (already following, already pending, etc)
            if (result.error) {
              socket.emit('system:message', {
                roomId,
                message: result.error,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Follow creates a pending request, not immediate follow (PRIVATE - only sender sees)
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              message: `You Are Now Following ${targetUsername}`,
              messageType: 'cmd',
              type: 'private',
              usernameColor: '#8B4513',
              messageColor: '#8B4513',
              timestamp: new Date().toISOString()
            });

            // Send notification to target user about follow REQUEST (not follow)
            const notificationService = require('../services/notificationService');
            const followNotification = {
              type: 'follow',
              fromUserId: userId,
              fromUsername: username,
              message: `${username} wants to follow you`,
              isPending: true
            };
            await notificationService.addNotification(targetUser.username, followNotification);

            // Emit real-time notification to target user if online
            io.to(`user:${targetUser.id}`).emit('notif:follow', {
              fromUserId: userId,
              fromUsername: username,
              message: `${username} wants to follow you`,
              isPending: true,
              timestamp: new Date().toISOString()
            });
          } catch (error) {
            console.error('Error processing /f:', error);
            socket.emit('system:message', {
              roomId,
              message: error.message || 'Failed to follow user',
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
          }
          return;
        }

        // Handle /uf command - Unfollow user
        if (cmdKey === 'uf') {
          const targetUsername = parts[1];
          if (!targetUsername) {
            socket.emit('system:message', {
              roomId,
              message: `Usage: /uf <username>`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          try {
            const userService = require('../services/userService');
            const profileService = require('../services/profileService');
            
            const targetUser = await userService.getUserByUsername(targetUsername);
            if (!targetUser) {
              socket.emit('system:message', {
                roomId,
                message: `User "${targetUsername}" not found`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }

            const result = await profileService.unfollowUser(userId, targetUser.id);
            
            // PRIVATE - only sender sees the unfollow confirmation
            socket.emit('chat:message', {
              id: generateMessageId(),
              roomId,
              message: `** You unfollowed ${targetUsername} **`,
              messageType: 'cmd',
              type: 'cmd',
              timestamp: new Date().toISOString()
            });
          } catch (error) {
            console.error('Error processing /uf:', error);
            socket.emit('system:message', {
              roomId,
              message: error.message || 'Failed to unfollow user',
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
          }
          return;
        }

        // Handle /kick command
        if (cmdKey === 'kick') {
          const targetUsername = parts[1];
          if (!targetUsername) {
            socket.emit('system:message', {
              roomId,
              message: `Usage: /kick <username>`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          try {
            const userService = require('../services/userService');
            const roomService = require('../services/roomService');
            
            const room = await roomService.getRoomById(roomId);
            const isRoomOwner = room && room.owner_id == userId;
            const isGlobalAdmin = await userService.isAdmin(userId);
            const isModerator = await roomService.isRoomAdmin(roomId, userId);
            
            if (!isRoomOwner && !isGlobalAdmin && !isModerator) {
              socket.emit('system:message', {
                roomId,
                message: `Only room owner, admin, or moderator can kick users`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }

            const targetUser = await userService.getUserByUsername(targetUsername);
            if (!targetUser) {
              socket.emit('system:message', {
                roomId,
                message: `User "${targetUsername}" not found`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }

            // Can't kick yourself
            if (targetUser.id == userId) {
              socket.emit('system:message', {
                roomId,
                message: `You cannot kick yourself`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }

            // Can't kick room owner or admins (unless you're an admin)
            const targetIsAdmin = await userService.isAdmin(targetUser.id);
            const targetIsOwner = room && room.owner_id == targetUser.id;
            
            if (targetIsOwner) {
              socket.emit('system:message', {
                roomId,
                message: `Cannot kick the room owner`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }

            if (targetIsAdmin && !isGlobalAdmin) {
              socket.emit('system:message', {
                roomId,
                message: `Only admins can kick other admins`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Protected roles: super_admin, admin, customer_service cannot kick each other
            const protectedRoles = ['super_admin', 'admin', 'customer_service', 'cs'];
            const kickerUser = await userService.getUserById(userId);
            const kickerRole = kickerUser?.role?.toLowerCase();
            const targetRole = targetUser?.role?.toLowerCase();
            
            if (protectedRoles.includes(kickerRole) && protectedRoles.includes(targetRole)) {
              socket.emit('system:message', {
                roomId,
                message: `Cannot kick staff members (admin/CS)`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Creator (room owner) cannot kick moderators
            const targetIsModerator = await roomService.isRoomAdmin(roomId, targetUser.id);

            if (targetIsModerator && isRoomOwner && !isGlobalAdmin) {
              socket.emit('system:message', {
                roomId,
                message: `Room creator cannot kick moderators`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Moderator cannot kick room creator (already handled above by targetIsOwner check)
            // Moderator cannot kick other moderators
            if (targetIsModerator && isModerator && !isGlobalAdmin) {
              socket.emit('system:message', {
                roomId,
                message: `Moderators cannot kick other moderators`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }

            // Find target user's socket and force them to leave
            const roomSockets = await io.in(`room:${roomId}`).fetchSockets();
            const targetSocket = roomSockets.find(s => s.username === targetUsername || s.userId == targetUser.id);
            
            if (targetSocket) {
              // Force leave the socket room
              targetSocket.leave(`room:${roomId}`);
              
              // Clear their room state
              targetSocket.currentRoomId = null;
              
              // Emit kicked event directly to the target user
              targetSocket.emit('user:kicked', {
                roomId,
                kickedUserId: targetUser.id,
                kickedUsername: targetUsername,
                kickedBy: username,
                message: `You were kicked from the room by ${username}`
              });
            }
            
            // Remove from presence and participants
            const { removeUserPresence, getRoomUsersFromTTL } = require('../utils/roomPresenceTTL');
            const { removeRoomParticipant } = require('../utils/redisUtils');
            await removeUserPresence(roomId, targetUser.id);
            await removeRoomParticipant(roomId, targetUsername);
            
            // Set temporary kick ban (5 minutes)
            const { getRedisClient } = require('../redis');
            const redis = getRedisClient();
            const kickKey = `kick:${roomId}:${targetUser.id}`;
            await redis.setEx(kickKey, 300, 'kicked'); // 5 minutes
            
            // Broadcast kicked message to remaining users (same format as other system messages)
            io.to(`room:${roomId}`).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: room.name,
              message: `${targetUsername} has been kicked by administrator ${username}`,
              isSystem: true,
              timestamp: new Date().toISOString()
            });
            
            // Update participants list - get from Redis participant set (single source of truth)
            const { getRoomParticipants } = require('../utils/redisUtils');
            const updatedParticipants = await getRoomParticipants(roomId);
            const participantListString = updatedParticipants.join(', ') || 'No users';
            
            // Broadcast participants update for menu
            io.to(`room:${roomId}`).emit('room:participants:update', {
              roomId: String(roomId),
              participants: updatedParticipants
            });
            
            // Broadcast "Currently users" update (frontend updates existing message in-place)
            io.to(`room:${roomId}`).emit('room:currently:update', {
              roomId: String(roomId),
              roomName: room.name,
              participants: participantListString
            });
            
            // Broadcast "has left" message
            io.to(`room:${roomId}`).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: room.name,
              message: `${targetUsername} [${targetUser.level || 1}] has left`,
              isSystem: true,
              timestamp: new Date().toISOString()
            });
            
            logger.info(`👢 User ${targetUsername} kicked from room ${roomId} by ${username}`);
          } catch (error) {
            console.error('Error processing /kick:', error);
            socket.emit('system:message', {
              roomId,
              message: 'Failed to kick user',
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
          }
          return;
        }

        // Handle /bump command - Admin/CS only - disconnect user from room (can rejoin immediately)
        if (cmdKey === 'bump') {
          const targetUsername = parts[1];
          if (!targetUsername) {
            socket.emit('system:message', {
              roomId,
              message: `Usage: /bump <username>`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          try {
            const userService = require('../services/userService');
            const roomService = require('../services/roomService');
            
            // Get bumper's role - only admin and customer_service can use /bump
            const bumperUser = await userService.getUserById(userId);
            const bumperRole = bumperUser?.role?.toLowerCase();
            const allowedRoles = ['super_admin', 'admin', 'customer_service', 'cs'];
            
            if (!allowedRoles.includes(bumperRole)) {
              socket.emit('system:message', {
                roomId,
                message: `Only admin and customer service can use /bump command`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }

            const room = await roomService.getRoomById(roomId);

            const targetUser = await userService.getUserByUsername(targetUsername);
            if (!targetUser) {
              socket.emit('system:message', {
                roomId,
                message: `User "${targetUsername}" not found`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }

            // Can't bump yourself
            if (targetUser.id == userId) {
              socket.emit('system:message', {
                roomId,
                message: `You cannot bump yourself`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }

            // Can't bump other admin/CS staff
            const targetRole = targetUser?.role?.toLowerCase();
            if (allowedRoles.includes(targetRole)) {
              socket.emit('system:message', {
                roomId,
                message: `Cannot bump other admin/CS staff members`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }

            // Determine display role for bumper
            let displayRole = 'CS';
            if (bumperRole === 'super_admin' || bumperRole === 'admin') {
              displayRole = 'administrator';
            }

            // Remove from presence first
            try {
              await removeUserFromRoom(roomId, targetUsername);
              await removeUserRoom(targetUsername, roomId);
            } catch (presenceError) {
              console.error('Error removing user from presence:', presenceError);
            }

            // Send bump event to target user and force disconnect from room
            const roomSockets = await io.in(`room:${roomId}`).fetchSockets();
            for (const targetSocket of roomSockets) {
              if (targetSocket.username === targetUsername || targetSocket.handshake?.auth?.username === targetUsername) {
                // Send bump notification to target
                targetSocket.emit('room:bumped', {
                  roomId,
                  roomName: room.name,
                  bumpedBy: username
                });
                
                // Force leave room immediately
                targetSocket.leave(`room:${roomId}`);
                
                // Also emit forced leave event to client
                targetSocket.emit('room:force_leave', {
                  roomId,
                  reason: 'bumped'
                });
              }
            }

            // Public bump message
            io.to(`room:${roomId}`).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: room.name,
              message: `${targetUsername} Has Been bumped by ${displayRole} ${username}`,
              messageType: 'bump',
              type: 'system',
              timestamp: new Date().toISOString(),
              isSystem: true
            });

            // Broadcast "has left" message
            io.to(`room:${roomId}`).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: room.name,
              message: `${targetUsername} [${targetUser.level || 1}] has left`,
              isSystem: true,
              timestamp: new Date().toISOString()
            });

            // Update user list for everyone in the room
            const updatedUsers = await getRoomPresenceUsers(roomId);
            io.to(`room:${roomId}`).emit('room:user:left', {
              roomId,
              username: targetUsername,
              users: updatedUsers
            });
            
          } catch (error) {
            console.error('Error processing /bump:', error);
          }
          return;
        }

        // Handle /mod command - Add moderator to room
        if (cmdKey === 'mod') {
          const targetUsername = parts[1];
          if (!targetUsername) {
            socket.emit('system:message', {
              roomId,
              message: `Usage: /mod <username>`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          try {
            const roomService = require('../services/roomService');
            const userService = require('../services/userService');
            
            // Check if user is room owner or admin
            const room = await roomService.getRoomById(roomId);
            const isRoomOwner = room && room.owner_id == userId;
            const isGlobalAdmin = await userService.isAdmin(userId);
            
            if (!isRoomOwner && !isGlobalAdmin) {
              socket.emit('system:message', {
                roomId,
                message: `Only room owner can add moderators`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Find target user
            const targetUser = await userService.getUserByUsername(targetUsername);
            if (!targetUser) {
              socket.emit('system:message', {
                roomId,
                message: `User "${targetUsername}" not found`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Add to room_admins table
            await roomService.addRoomAdmin(roomId, targetUser.id);
            
            // Update Redis cache for quick lookup
            const { getRedisClient } = require('../redis');
            const redis = getRedisClient();
            await redis.sAdd(`room:mods:${roomId}`, targetUser.id.toString());
            
            // Get updated moderators list
            const db = require('../db/db');
            const moderatorsResult = await db.query(
              `SELECT u.username FROM room_admins ra
               JOIN users u ON ra.user_id = u.id
               WHERE ra.room_id = $1 AND ra.user_id != $2
               ORDER BY ra.created_at ASC`,
              [roomId, room.owner_id]
            );
            const moderators = moderatorsResult.rows.map(m => m.username);
            
            // Broadcast moderators update
            io.to(`room:${roomId}`).emit('room:moderators:update', {
              roomId: String(roomId),
              moderators
            });
            
            // Broadcast success message with room name in orange
            io.to(`room:${roomId}`).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: '',
              message: `${targetUsername} now is moderator in room ${room.name}`,
              messageType: 'modPromotion',
              type: 'action',
              messageColor: '#FF8C00',
              timestamp: new Date().toISOString()
            });
          } catch (error) {
            console.error('Error processing /mod command:', error);
            socket.emit('system:message', {
              roomId,
              message: `Failed to add moderator`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
          }
          return;
        }

        // Handle /unmod command - Remove moderator from room
        if (cmdKey === 'unmod') {
          const targetUsername = parts[1];
          if (!targetUsername) {
            socket.emit('system:message', {
              roomId,
              message: `Usage: /unmod <username>`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          try {
            const roomService = require('../services/roomService');
            const userService = require('../services/userService');
            
            // Check if user is room owner or admin
            const room = await roomService.getRoomById(roomId);
            const isRoomOwner = room && room.owner_id == userId;
            const isGlobalAdmin = await userService.isAdmin(userId);
            
            if (!isRoomOwner && !isGlobalAdmin) {
              socket.emit('system:message', {
                roomId,
                message: `Only room owner can remove moderators`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Find target user
            const targetUser = await userService.getUserByUsername(targetUsername);
            if (!targetUser) {
              socket.emit('system:message', {
                roomId,
                message: `User "${targetUsername}" not found`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Remove from room_admins table
            await roomService.removeRoomAdmin(roomId, targetUser.id);
            
            // Get updated moderators list
            const db = require('../db/db');
            const moderatorsResult = await db.query(
              `SELECT u.username FROM room_admins ra
               JOIN users u ON ra.user_id = u.id
               WHERE ra.room_id = $1 AND ra.user_id != $2
               ORDER BY ra.created_at ASC`,
              [roomId, room.owner_id]
            );
            const moderators = moderatorsResult.rows.map(m => m.username);
            
            // Broadcast moderators update
            io.to(`room:${roomId}`).emit('room:moderators:update', {
              roomId: String(roomId),
              moderators
            });
            
            // Broadcast success message with room name in orange
            io.to(`room:${roomId}`).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: room.name,
              message: `${targetUsername} is no longer moderator`,
              messageType: 'modRemoval',
              type: 'system',
              isSystem: true,
              timestamp: new Date().toISOString()
            });
          } catch (error) {
            console.error('Error processing /unmod command:', error);
            socket.emit('system:message', {
              roomId,
              message: `Failed to remove moderator`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
          }
          return;
        }

        // Handle /ban command - Ban user from room
        if (cmdKey === 'ban') {
          const targetUsername = parts[1];
          if (!targetUsername) {
            socket.emit('system:message', {
              roomId,
              message: `Usage: /ban <username>`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          try {
            const roomService = require('../services/roomService');
            const userService = require('../services/userService');
            const { removeUserFromRoom, removeUserRoom } = require('../utils/presence');
            
            const room = await roomService.getRoomById(roomId);
            const isRoomOwner = room && room.owner_id == userId;
            const isGlobalAdmin = await userService.isAdmin(userId);
            const isModerator = await roomService.isRoomAdmin(roomId, userId);
            
            if (!isRoomOwner && !isGlobalAdmin && !isModerator) {
              socket.emit('system:message', {
                roomId,
                message: `Only room owner, admin, or moderator can ban users`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            const targetUser = await userService.getUserByUsername(targetUsername);
            if (!targetUser) {
              socket.emit('system:message', {
                roomId,
                message: `User "${targetUsername}" not found`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Can't ban yourself
            if (targetUser.id === userId) {
              socket.emit('system:message', {
                roomId,
                message: `You cannot ban yourself`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Can't ban room owner
            if (room && room.owner_id == targetUser.id) {
              socket.emit('system:message', {
                roomId,
                message: `Cannot ban the room owner`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Protected roles: super_admin, admin, customer_service cannot ban each other
            const protectedRoles = ['super_admin', 'admin', 'customer_service', 'cs'];
            const bannerUser = await userService.getUserById(userId);
            const bannerUserRole = bannerUser?.role?.toLowerCase();
            const targetRole = targetUser?.role?.toLowerCase();
            
            if (protectedRoles.includes(bannerUserRole) && protectedRoles.includes(targetRole)) {
              socket.emit('system:message', {
                roomId,
                message: `Cannot ban staff members (admin/CS)`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Moderator cannot ban other moderators (only owner can ban mod)
            const targetIsMod = await roomService.isRoomAdmin(roomId, targetUser.id);

            // PROTECTION: Room creator cannot ban moderators
            if (targetIsMod && isRoomOwner && !isGlobalAdmin) {
              socket.emit('system:message', {
                roomId,
                message: `Room creator cannot ban moderators`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }

            if (targetIsMod && (isModerator || isRoomAdmin) && !isRoomOwner && !isGlobalAdmin) {
              socket.emit('system:message', {
                roomId,
                message: `Moderators cannot ban other moderators`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Determine banner role
            let bannerRole = 'moderator';
            if (isRoomOwner) bannerRole = 'owner';
            else if (isGlobalAdmin || isRoomAdmin) bannerRole = 'administrator';
            
            // Ban user
            await roomService.banUser(roomId, targetUser.id, targetUsername, userId, null);
            
            // Send private message to banned user
            const roomSockets = await io.in(`room:${roomId}`).fetchSockets();
            for (const targetSocket of roomSockets) {
              if (targetSocket.username === targetUsername || targetSocket.handshake?.auth?.username === targetUsername) {
                targetSocket.emit('chat:message', {
                  id: generateMessageId(),
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
            
            // Public message (same format as other system messages)
            io.to(`room:${roomId}`).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: room.name,
              message: `${targetUsername} has been banned by ${bannerRole} ${username}`,
              isSystem: true,
              timestamp: new Date().toISOString()
            });
            
            // Remove from presence AND participant set (non-blocking)
            try {
              await removeUserFromRoom(roomId, targetUsername);
              await removeUserRoom(targetUsername, roomId);
              
              // Remove from participant set (single source of truth)
              const { removeRoomParticipant, getRoomParticipants } = require('../utils/redisUtils');
              const { removeUserPresence } = require('../utils/roomPresenceTTL');
              await removeUserPresence(roomId, targetUser.id);
              await removeRoomParticipant(roomId, targetUsername);
              
              // Get updated participants for broadcast
              const updatedParticipants = await getRoomParticipants(roomId);
              const participantListString = updatedParticipants.join(', ') || 'No users';
              
              // Broadcast participants update for menu
              io.to(`room:${roomId}`).emit('room:participants:update', {
                roomId: String(roomId),
                participants: updatedParticipants
              });
              
              // Broadcast "Currently users" update (frontend updates existing message in-place)
              io.to(`room:${roomId}`).emit('room:currently:update', {
                roomId: String(roomId),
                roomName: room.name,
                participants: participantListString
              });
              
              // Broadcast "has left" message
              io.to(`room:${roomId}`).emit('chat:message', {
                id: generateMessageId(),
                roomId,
                username: room.name,
                message: `${targetUsername} [${targetUser.level || 1}] has left`,
                isSystem: true,
                timestamp: new Date().toISOString()
              });
            } catch (presenceError) {
              console.error('Error removing user from presence:', presenceError);
            }
            
          } catch (error) {
            console.error('Error processing /ban command:', error);
            // Only show error if ban actually failed (before public message)
          }
          return;
        }

        // Handle /unban command - Unban user from room
        if (cmdKey === 'unban') {
          const targetUsername = parts[1];
          if (!targetUsername) {
            socket.emit('system:message', {
              roomId,
              message: `Usage: /unban <username>`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          try {
            const roomService = require('../services/roomService');
            const userService = require('../services/userService');
            
            const room = await roomService.getRoomById(roomId);
            const isRoomOwner = room && room.owner_id == userId;
            const isGlobalAdmin = await userService.isAdmin(userId);
            const isModerator = await roomService.isRoomAdmin(roomId, userId);
            
            if (!isRoomOwner && !isGlobalAdmin && !isModerator) {
              socket.emit('system:message', {
                roomId,
                message: `Only room owner, admin, or moderator can unban users`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            const targetUser = await userService.getUserByUsername(targetUsername);
            if (!targetUser) {
              socket.emit('system:message', {
                roomId,
                message: `User "${targetUsername}" not found`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Determine unbanner role
            let unbannerRole = 'moderator';
            if (isRoomOwner) unbannerRole = 'owner';
            else if (isGlobalAdmin || isRoomAdmin) unbannerRole = 'administrator';
            
            // Unban user
            await roomService.unbanUser(roomId, targetUser.id, targetUsername);
            
            // Public message
            io.to(`room:${roomId}`).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: room.name,
              message: `${targetUsername} Has unbanned by ${unbannerRole} ${username}`,
              messageType: 'unban',
              type: 'system',
              timestamp: new Date().toISOString(),
              isSystem: true
            });
            
          } catch (error) {
            console.error('Error processing /unban command:', error);
            socket.emit('system:message', {
              roomId,
              message: `Failed to unban user`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
          }
          return;
        }

        // Handle /block command - Block a user (personal block list)
        if (cmdKey === 'block') {
          const targetUsername = parts[1];
          if (!targetUsername) {
            socket.emit('system:message', {
              roomId,
              message: `Usage: /block <username>`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }
          
          try {
            const profileService = require('../services/profileService');
            const result = await profileService.blockUser(userId, targetUsername);
            
            if (result.success) {
              // Invalidate Redis cache
              const { getRedisClient } = require('../redis');
              const redis = getRedisClient();
              await redis.del(`user:blocks:${userId}`);
              
              socket.emit('system:message', {
                roomId,
                message: `You have blocked ${targetUsername}`,
                timestamp: new Date().toISOString(),
                type: 'success'
              });
            } else {
              socket.emit('system:message', {
                roomId,
                message: result.message || 'Failed to block user',
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
            }
          } catch (error) {
            console.error('Error processing /block command:', error);
            socket.emit('system:message', {
              roomId,
              message: 'Failed to block user',
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
          }
          return;
        }

        // Handle /setlvl command - Set minimum level for room (admin/super_admin only)
        if (cmdKey === 'setlvl') {
          const levelStr = parts[1];
          if (!levelStr) {
            socket.emit('system:message', {
              roomId,
              message: `Usage: /setlvl <number>`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          const level = parseInt(levelStr, 10);
          if (isNaN(level) || level < 1 || level > 100) {
            socket.emit('system:message', {
              roomId,
              message: `Invalid level. Please enter a number between 1 and 100`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          try {
            const roomService = require('../services/roomService');
            const userService = require('../services/userService');
            
            const user = await userService.getUserById(userId);
            const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin' || user.role === 'customer_service' || user.role === 'cs');
            
            if (!isAdmin) {
              socket.emit('system:message', {
                roomId,
                message: `Only admin or customer service can set room level`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            const room = await roomService.getRoomById(roomId);
            if (!room) {
              socket.emit('system:message', {
                roomId,
                message: `Room not found`,
                timestamp: new Date().toISOString(),
                type: 'warning'
              });
              return;
            }
            
            // Update room min_level
            await roomService.setRoomMinLevel(roomId, level);
            
            // Broadcast message
            io.to(`room:${roomId}`).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: room.name,
              message: `${room.name} Has set level ${level} by administrator ${username}`,
              messageType: 'system',
              type: 'system',
              timestamp: new Date().toISOString(),
              isSystem: true
            });
            
          } catch (error) {
            console.error('Error processing /setlvl command:', error);
            socket.emit('system:message', {
              roomId,
              message: `Failed to set room level`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
          }
          return;
        }

        // Handle other MIG33 commands
        const cmd = MIG33_CMD[cmdKey];
        if (cmd) {
          // Skip mod/unmod as they're handled above
          if (cmdKey === 'mod' || cmdKey === 'unmod') return;
          
          const target = parts[1];
          if (cmd.requiresTarget && !target) {
            socket.emit('system:message', {
              roomId,
              message: `Command /${cmdKey} requires a target. Usage: /${cmdKey} <username>`,
              timestamp: new Date().toISOString(),
              type: 'warning'
            });
            return;
          }

          const text = cmd.requiresTarget ? cmd.message(username, target) : cmd.message(username);
          io.to(`room:${roomId}`).emit('chat:message', {
            id: generateMessageId(),
            roomId,
            message: `** ${text} **`,
            messageType: 'cmd',
            type: 'cmd',
            timestamp: new Date().toISOString()
          });
          return;
        }
      }

      const userService = require('../services/userService');
      const sender = await userService.getUserById(userId);
      let usernameColor = (sender && sender.username_color_expiry && new Date(sender.username_color_expiry) > new Date()) 
        ? sender.username_color 
        : null;

      // Check if user is Top 1 in any leaderboard category (cached for performance)
      let isTop1UserFlag = false;
      // Merchant top 1 badge is only shown in "has entered" messages, not in chat messages
      let hasTopMerchantBadge = false; // Always false in chat messages per requirement
      try {
        const { isTop1User, isTopMerchant } = require('../utils/top1Cache');
        const now = new Date();
        
        const isMerchant = sender?.role?.toLowerCase() === 'merchant';
        
        // Check if Top 1 in any category (from cache - fast Redis lookup)
        // Note: merchants are not included in top1 user cache (only role user)
        isTop1UserFlag = await isTop1User(userId);
        
        // Check stored top like reward (from weekly leaderboard reset)
        const hasStoredReward = sender?.has_top_like_reward && sender?.top_like_reward_expiry && new Date(sender.top_like_reward_expiry) > now;
        
        // Top 1 users get pink color (either from cache OR stored reward that hasn't expired)
        // Merchants do NOT get pink color even if top 1
        if ((isTop1UserFlag || hasStoredReward) && !isMerchant) {
          usernameColor = '#FF69B4';
          isTop1UserFlag = true; // Mark as top1 for badge display
        } else if (isMerchant) {
          // Merchant: no pink color, no top1 badge in messages
          isTop1UserFlag = false;
        }
      } catch (error) {
        console.error('Error checking top1 status for chat message:', error);
      }

      // Determine userType based on role
      let userType = 'normal';
      const senderRole = sender?.role?.toLowerCase();
      if (senderRole === 'admin') userType = 'admin';
      else if (senderRole === 'creator') userType = 'creator';
      else if (senderRole === 'mentor') userType = 'mentor';
      else if (senderRole === 'merchant') userType = 'merchant';
      else if (senderRole === 'moderator') userType = 'moderator';
      else if (senderRole === 'customer_service' || senderRole === 'cs') userType = 'customer_service';

      const messageData = {
        id: clientMsgId || generateMessageId(), // Use client ID for deduplication
        roomId,
        userId,
        username,
        usernameColor,
        message,
        messageType: 'chat',
        timestamp: new Date().toISOString(),
        userType,
        isTop1User: isTop1UserFlag,
        hasTopMerchantBadge,
      };

      // Check for moderator/owner status in this room
      // Special roles (mentor, merchant, admin, cs) are NEVER overridden - they keep their role color
      const roomService = require('../services/roomService');
      const isMod = await roomService.isRoomAdmin(roomId, userId);
      const room = await roomService.getRoomById(roomId);
      
      // Only override to creator/moderator if user is a normal user (no special role)
      if (userType === 'normal') {
        if (userId == room?.owner_id) {
          messageData.userType = 'creator';
        } else if (isMod) {
          messageData.userType = 'moderator';
        }
      }

      logger.info('📤 Sending message with color:', { username, usernameColor });
      io.to(`room:${roomId}`).emit('chat:message', messageData);
      
      // Send ACK to sender for message confirmation
      socket.emit('chat:ack', { 
        clientMsgId: clientMsgId || messageData.id,
        serverId: messageData.id,
        status: 'sent'
      });
      
      // Save to Redis for quick backlog retrieval (TTL 24 hours)
      try {
        const msgKey = `room:messages:${roomId}`;
        await redis.lPush(msgKey, JSON.stringify(messageData));
        await redis.lTrim(msgKey, 0, 199); // Keep last 200 messages
        await redis.expire(msgKey, 86400); // 24 hour TTL
      } catch (redisErr) {
        console.error('Error saving message to Redis:', redisErr);
      }
      
      // Database storage disabled for lighter performance
      // Messages only stored in Redis (100 messages per room)
      
      await addDailyChatXp(userId, io);

    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  };

  const getMessages = async (data) => {
    try {
      const { roomId, limit = 50, offset = 0 } = data;
      const messages = await messageService.getMessages(roomId, limit, offset);
      socket.emit('chat:messages', { roomId, messages, hasMore: messages.length === limit });
    } catch (error) {
      console.error('Error getting messages:', error);
      socket.emit('error', { message: 'Failed to get messages' });
    }
  };

  const deleteMessage = async (data) => {
    try {
      const { messageId, roomId } = data;
      await messageService.deleteMessage(messageId);
      io.to(`room:${roomId}`).emit('chat:message:deleted', { messageId, roomId });
    } catch (error) {
      console.error('Error deleting message:', error);
      socket.emit('error', { message: 'Failed to delete message' });
    }
  };

  // Sync backlog messages from Redis (for reconnects)
  const syncBacklog = async (data) => {
    try {
      const { roomId, lastMessageId } = data;
      if (!roomId) return;
      
      // REQUIRE lastMessageId - never send full backlog
      // Full backlog on first join is not wanted (room should be clean)
      if (!lastMessageId) {
        logger.info(`⏭️ [Room ${roomId}] chat:sync without lastMessageId - skipping (first join should be clean)`);
        return;
      }
      
      const { getRedisClient } = require('../redis');
      const redis = getRedisClient();
      const msgKey = `room:messages:${roomId}`;
      const messages = await redis.lRange(msgKey, 0, 199);
      
      if (messages && messages.length > 0) {
        let backlog = messages
          .map(m => { 
            try { 
              return JSON.parse(m);
            } catch { return null; } 
          })
          .filter(Boolean)
          .reverse();
        
        // Filter to only messages after lastMessageId
        const idx = backlog.findIndex(m => m.id === lastMessageId);
        if (idx !== -1) {
          backlog = backlog.slice(idx + 1);
        } else {
          // lastMessageId not found in backlog - don't send anything
          // This prevents flooding with old messages
          logger.info(`⏭️ [Room ${roomId}] lastMessageId not found in backlog - skipping`);
          return;
        }
        
        if (backlog.length > 0) {
          socket.emit('chat:backlog', { 
            roomId, 
            messages: backlog,
            isBacklog: true
          });
          logger.info(`📨 Synced ${backlog.length} messages for room ${roomId}`);
        }
      }
    } catch (error) {
      console.error('Error syncing backlog:', error);
    }
  };

  // Sync all messages (user + bot) from Redis by timestamp (for app resume from background)
  const syncMessagesByTimestamp = async (data) => {
    try {
      const { roomId, since, limit = 200 } = data;
      if (!roomId || !since) return;
      
      const sinceMs = typeof since === 'number' ? since : new Date(since).getTime();
      
      const { getRedisClient } = require('../redis');
      const redis = getRedisClient();
      const msgKey = `room:messages:${roomId}`;
      const raw = await redis.lRange(msgKey, 0, 199);
      
      if (!raw || raw.length === 0) return;
      
      const allMessages = raw
        .map(m => { try { return JSON.parse(m); } catch { return null; } })
        .filter(Boolean)
        .filter(m => {
          const msgTime = new Date(m.timestamp).getTime();
          return msgTime > sinceMs;
        })
        .reverse()
        .slice(0, limit);
      
      if (allMessages.length > 0) {
        socket.emit('chat:backlog', { 
          roomId, 
          messages: allMessages,
          isBacklog: true,
          syncType: 'background-resume'
        });
        logger.info(`📨 [Room ${roomId}] Synced ${allMessages.length} messages since ${new Date(sinceMs).toISOString()} from Redis backlog`);
      }
    } catch (error) {
      console.error('Error syncing messages by timestamp:', error);
    }
  };

  socket.on('chat:message', sendMessage);
  socket.on('chat:messages:get', getMessages);
  socket.on('chat:message:delete', deleteMessage);
  socket.on('chat:sync', syncBacklog);
  socket.on('room:messages:sync', syncMessagesByTimestamp);
};
