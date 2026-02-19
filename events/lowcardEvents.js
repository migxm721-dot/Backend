const lowcardService = require('../services/lowcardService');
const { generateMessageId } = require('../utils/idGenerator');
const logger = require('../utils/logger');
const { getRedisClient } = require('../redis');

const drawBatches = new Map();
const BATCH_INTERVAL = 80;

const sendBotMessage = async (io, roomId, message, type = 'lowcard', isPvt = false, socket = null) => {
  const messageData = {
    id: generateMessageId(),
    roomId,
    username: 'LowCardBot',
    message: message,
    messageType: type,
    type: isPvt ? 'private' : 'bot',
    botType: 'lowcard',
    userType: 'bot',
    usernameColor: '#719c35',
    messageColor: '#347499',
    timestamp: new Date().toISOString()
  };
  
  if (isPvt && socket) {
    socket.emit('chat:message', messageData);
    return;
  }
  
  io.to(`room:${roomId}`).emit('chat:message', messageData);
  
  // Save bot message to Redis for reconnect sync
  try {
    const redis = getRedisClient();
    if (redis && redis.isOpen) {
      const msgKey = `room:messages:${roomId}`;
      await redis.lPush(msgKey, JSON.stringify(messageData));
      await redis.lTrim(msgKey, 0, 199);
      await redis.expire(msgKey, 86400);
    }
  } catch (err) {
    logger.error('[LowCard] Error saving bot message to Redis:', err);
  }
};

const flushDrawBatch = (io, roomId) => {
  const batchKey = `draw:${roomId}`;
  const batch = drawBatches.get(batchKey);
  if (!batch || batch.draws.length === 0) return;
  
  for (const d of batch.draws) {
    sendBotMessage(io, roomId, `${d.username}: ${d.cardDisplay}`);
  }
  
  batch.draws = [];
  batch.timer = null;
  drawBatches.delete(batchKey);
};

const addToDrawBatch = (io, roomId, drawResult) => {
  const batchKey = `draw:${roomId}`;
  
  if (!drawBatches.has(batchKey)) {
    drawBatches.set(batchKey, { draws: [], timer: null });
  }
  
  const batch = drawBatches.get(batchKey);
  batch.draws.push(drawResult);
  
  if (!batch.timer) {
    batch.timer = setTimeout(() => {
      flushDrawBatch(io, roomId);
    }, BATCH_INTERVAL);
  }
};

// Redis-based timer functions
const startJoinTimer = async (io, roomId) => {
  const expiresAt = Date.now() + lowcardService.JOIN_TIMEOUT;
  await lowcardService.setTimer(roomId, 'join', expiresAt);
  logger.info(`[LowCard] Join timer started for room ${roomId}, expires in 30s`);
};

const startDrawTimer = async (io, roomId) => {
  const expiresAt = Date.now() + lowcardService.DRAW_TIMEOUT;
  await lowcardService.setTimer(roomId, 'draw', expiresAt);
  logger.info(`[LowCard] Draw timer started for room ${roomId}, expires in 20s`);
};

const clearGameTimers = async (roomId) => {
  await lowcardService.clearTimer(roomId);
};

const processRoundEnd = async (io, roomId, isTimedOut = true) => {
  flushDrawBatch(io, roomId);
  
  if (isTimedOut) {
    sendBotMessage(io, roomId, "TIME'S UP! Tallying cards...");
    
    const autoDrawn = await lowcardService.autoDrawForTimeout(roomId);
    
    for (const d of autoDrawn) {
      sendBotMessage(io, roomId, `Bot draws - ${d.username}: ${d.cardDisplay}`);
    }
  } else {
    sendBotMessage(io, roomId, "Looks like everyone has drawn. Let's tally!");
  }
  
  await new Promise(resolve => setTimeout(resolve, 500));
  
  const result = await lowcardService.tallyRound(roomId, isTimedOut);
  
  if (!result) return;
  
  if (result.error) {
    sendBotMessage(io, roomId, result.message);
    return;
  }
  
  if (result.tie) {
    sendBotMessage(io, roomId, result.message);
    sendBotMessage(io, roomId, result.followUp);
    
    setTimeout(async () => {
      const game = await lowcardService.getActiveGame(roomId);
      if (game && game.status === 'playing' && game.isTieBreaker) {
        // Only tied players draw in tiebreaker - get their names
        const tiedPlayers = game.players.filter(p => !p.isEliminated && p.inTieBreaker);
        const tiedNames = tiedPlayers.map(p => p.username).join(', ');
        sendBotMessage(io, roomId, `ROUND #${game.currentRound}: Players, !d to DRAW. 20 seconds.`);
        startDrawTimer(io, roomId);
      }
    }, lowcardService.COUNTDOWN_DELAY);
    return;
  }
  
  if (result.gameOver) {
    sendBotMessage(io, roomId, result.message);
    sendBotMessage(io, roomId, result.followUp);
    clearGameTimers(roomId);
    
    if (result.winnerId) {
      io.to(`room:${roomId}`).emit('credits:updated', { 
        userId: result.winnerId,
        balance: result.newBalance 
      });
    }
    return;
  }
  
  if (result.eliminated) {
    // Send the elimination message (matches Kotlin format)
    sendBotMessage(io, roomId, result.message);
    
    if (result.playerList) {
      sendBotMessage(io, roomId, result.playerList);
    }
    
    if (result.followUp) {
      sendBotMessage(io, roomId, result.followUp);
    }
    
    setTimeout(async () => {
      const game = await lowcardService.getActiveGame(roomId);
      if (game && game.status === 'playing') {
        const activePlayers = game.players.filter(p => !p.isEliminated);
        const playerNames = activePlayers.map(p => p.username).join(', ');
        sendBotMessage(io, roomId, `ROUND #${result.nextRound}: Players, !d to DRAW. 20 seconds.`);
        startDrawTimer(io, roomId);
      }
    }, lowcardService.COUNTDOWN_DELAY);
  }
};

const handleLowcardCommand = async (io, socket, data) => {
  const { roomId, userId, username, message } = data;
  
  if (message.startsWith('/bot ')) {
    const parts = message.slice(5).split(' ');
    const subCmd = parts[0]?.toLowerCase();
    const action = parts[1]?.toLowerCase();
    
    if (subCmd === 'lowcard') {
      const userService = require('../services/userService');
      const user = await userService.getUserById(userId);
      if (!user || (user.role !== 'super_admin' && user.role !== 'admin')) {
        socket.emit('chat:message', {
          id: generateMessageId(),
          roomId,
          message: 'Error: Only admin can perform this action.',
          messageType: 'error',
          type: 'error',
          timestamp: new Date().toISOString()
        });
        return true;
      }
      
      if (action === 'add') {
        // Check if FlagBot is active - only one game per room
        const legendService = require('../services/legendService');
        const flagBotActive = await legendService.isBotActive(roomId);
        if (flagBotActive) {
          sendBotMessage(io, roomId, 'FlagBot is active in this room. Remove it first with /bot flagh off');
          return true;
        }
        
        const result = await lowcardService.addBotToRoom(roomId);
        sendBotMessage(io, roomId, result.message);
        return true;
      }
      
      if (action === 'off') {
        const result = await lowcardService.removeBotFromRoom(roomId);
        if (result.success) {
          clearGameTimers(roomId);
        }
        sendBotMessage(io, roomId, result.message);
        return true;
      }
      
      sendBotMessage(io, roomId, 'Usage: /bot lowcard add OR /bot lowcard off');
      return true;
    }
    
    if (subCmd === 'stop') {
      const isBotActive = await lowcardService.isBotActive(roomId);
      if (!isBotActive) {
        return false;
      }
      
      const userService = require('../services/userService');
      const user = await userService.getUserById(userId);
      const isAdminRole = user && (user.role === 'admin' || user.role === 'super_admin');
      
      if (!isAdminRole) {
        sendBotMessage(io, roomId, 'Only admin can stop the game.');
        return true;
      }
      
      const result = await lowcardService.stopGame(roomId);
      if (result.success) {
        clearGameTimers(roomId);
      }
      sendBotMessage(io, roomId, result.message);
      return true;
    }
    
    if (subCmd === 'off') {
      const isRoomAdmin = await lowcardService.isRoomAdmin(roomId, userId);
      if (!isRoomAdmin) {
        sendBotMessage(io, roomId, 'Only room owner/admin can manage bots.');
        return true;
      }
      
      const result = await lowcardService.removeBotFromRoom(roomId);
      if (result.success) {
        clearGameTimers(roomId);
      }
      sendBotMessage(io, roomId, result.message);
      return true;
    }
    
    return false;
  }
  
  const isBotActive = await lowcardService.isBotActive(roomId);
  if (!isBotActive) {
    return false;
  }
  
  // Block !start when FlagBot is active in room
  const legendService = require('../services/legendService');
  const flagBotActive = await legendService.isBotActive(roomId);
  if (flagBotActive && message.startsWith('!start')) {
    return true;
  }
  
  // !reset command - admin/CS only
  if (message === '!reset') {
    const userService = require('../services/userService');
    const user = await userService.getUserById(userId);
    const isAdminOrCS = user && (user.role === 'admin' || user.role === 'super_admin' || user.role === 'cs');
    
    if (!isAdminOrCS) {
      sendBotMessage(io, roomId, 'Only admin/CS can reset stuck games.');
      return true;
    }
    
    const result = await lowcardService.resetGame(roomId, username);
    await clearGameTimers(roomId);
    sendBotMessage(io, roomId, result.message);
    
    // Show play now message after reset
    if (result.success) {
      sendBotMessage(io, roomId, '[PVT] Play now: !start to enter. Cost: 1 COINS. For custom entry, !start [amount]');
    }
    return true;
  }
  
  if (message.startsWith('!start')) {
    const parts = message.split(' ');
    const amount = parts[1] ? parseInt(parts[1]) : 50;
    
    const result = await lowcardService.startGame(roomId, userId, username, amount);
    
    if (result.success) {
      sendBotMessage(io, roomId, result.message);
      startJoinTimer(io, roomId);
      
      if (result.newBalance !== undefined) {
        socket.emit('credits:updated', { balance: result.newBalance });
      }
    } else {
      // Send as bot message instead of system error for consistency
      sendBotMessage(io, roomId, result.message, 'lowcard', result.isPvt, socket);
    }
    return true;
  }
  
  if (message === '!j') {
    const result = await lowcardService.joinGame(roomId, userId, username);
    
    if (result.success) {
      sendBotMessage(io, roomId, result.message);
      
      if (result.newBalance !== undefined) {
        socket.emit('credits:updated', { balance: result.newBalance });
      }
    } else {
      // Send as bot message instead of system error for consistency
      sendBotMessage(io, roomId, result.message, 'lowcard', result.isPvt, socket);
    }
    return true;
  }
  
  if (message === '!d') {
    const result = await lowcardService.drawCardForPlayer(roomId, userId, username);
    
    if (result.success) {
      addToDrawBatch(io, roomId, { username, cardDisplay: result.cardDisplay });
      
      const allDrawn = await lowcardService.allPlayersDrawn(roomId);
      if (allDrawn) {
        flushDrawBatch(io, roomId);
        
        // Immediate round end when all players have drawn
        await processRoundEnd(io, roomId, false);
      }
    } else if (!result.silent) {
      sendBotMessage(io, roomId, result.message, 'lowcard', result.isPvt === true, socket);
    }
    return true;
  }
  
  return false;
};

// Timer poller - scans Redis for expired LowCard timers
let isPolling = false; // Concurrency guard to prevent overlapping scans

const startTimerPoller = (io) => {
  setInterval(async () => {
    // Skip if previous poll is still running
    if (isPolling) return;
    isPolling = true;
    
    try {
      const redis = getRedisClient();
      if (!redis) {
        isPolling = false;
        return;
      }
      
      // Use scanIterator for node-redis v4+
      const pattern = 'room:*:lowcard:timer';
      
      for await (const key of redis.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        const data = await redis.get(key);
        if (!data) continue;
        
        const timer = JSON.parse(data);
        const now = Date.now();
        
        if (now >= timer.expiresAt) {
          logger.info(`[LowCard] Timer expired for room ${timer.roomId}, phase: ${timer.phase}`);
          
          // Clear the timer first to prevent duplicate processing
          await redis.del(key);
          
          if (timer.phase === 'join') {
            // Join phase ended - begin game or cancel
            const result = await lowcardService.beginGame(timer.roomId);
            
            if (!result) continue;
            
            if (result.cancelled) {
              sendBotMessage(io, timer.roomId, result.message);
              sendBotMessage(io, timer.roomId, '[PVT] Play now: !start to enter. Cost: 1 COINS. For custom entry, !start [amount]');
              continue;
            }
            
            if (result.started) {
              sendBotMessage(io, timer.roomId, result.message);
              sendBotMessage(io, timer.roomId, `Players are (${result.playerCount}): ${result.playerNames}`);
              
              setTimeout(async () => {
                const game = await lowcardService.getActiveGame(timer.roomId);
                if (game && game.status === 'playing') {
                  const activePlayers = game.players.filter(p => !p.isEliminated);
                  const playerNames = activePlayers.map(p => p.username).join(', ');
                  sendBotMessage(io, timer.roomId, `ROUND #1: Players, !d to DRAW. 20 seconds.`);
                  await startDrawTimer(io, timer.roomId);
                }
              }, lowcardService.COUNTDOWN_DELAY);
            }
          } else if (timer.phase === 'draw') {
            // Draw phase ended - process round
            await processRoundEnd(io, timer.roomId, true);
          }
        }
      }
    } catch (error) {
      logger.error('[LowCard] Timer poller error:', error && error.message ? error.message : String(error));
    } finally {
      isPolling = false; // Reset guard after poll completes
    }
  }, 1000); // Check every 1 second
  
  logger.info('[LowCard] Timer poller started (interval: 1s)');
};

module.exports = {
  handleLowcardCommand,
  sendBotMessage,
  clearGameTimers,
  startTimerPoller
};
