const dicebotService = require('../services/dicebotService');
const { generateMessageId } = require('../utils/idGenerator');
const logger = require('../utils/logger');
const { getRedisClient } = require('../redis');

// In-memory timers for join and roll phases
const diceJoinTimers = new Map();
const diceRollTimers = new Map();

const sendBotMessage = async (io, roomId, message, type = 'dicebot', isPvt = false, socket = null) => {
  const messageData = {
    id: generateMessageId(),
    roomId,
    username: 'DiceBot',
    message: message,
    messageType: type,
    type: isPvt ? 'private' : 'bot',
    botType: 'dicebot',
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
    logger.error('[DiceBot] Error saving bot message to Redis:', err);
  }
};

// Start join phase timer (30 seconds)
const startJoinTimer = (io, roomId) => {
  // Clear existing timer if any
  if (diceJoinTimers.has(roomId)) {
    clearTimeout(diceJoinTimers.get(roomId));
  }
  
  logger.info('DICEBOT_JOIN_TIMER_STARTED', { roomId, timeout: dicebotService.JOIN_TIMEOUT });
  
  const timer = setTimeout(async () => {
    try {
      const redis = getRedisClient();
      const gameData = await redis.get(`dicebot:game:${roomId}`);
      
      if (!gameData) {
        diceJoinTimers.delete(roomId);
        return;
      }
      
      const game = JSON.parse(gameData);
      
      // Not enough players - cancel game
      if (!game.players || game.players.length < 2) {
        logger.info('DICEBOT_NOT_ENOUGH_PLAYERS', { roomId, playerCount: game.players?.length || 0 });
        
        // Refund all players
        for (const player of game.players || []) {
          await dicebotService.addCredits(player.userId, game.entryAmount, player.username, 'DiceBot Refund - Not enough players');
        }
        
        // Delete game
        await redis.del(`dicebot:game:${roomId}`);
        
        // Send messages
        await sendBotMessage(io, roomId, 'Not enough player join. Coins refunded.');
        
        setTimeout(async () => {
          await sendBotMessage(io, roomId, `Play now: !start to enter. Cost: ${dicebotService.formatCoins(dicebotService.MIN_ENTRY)} COINS. For custom entry, !start [amount]`);
        }, 500);
        
        diceJoinTimers.delete(roomId);
        return;
      }
      
      // Enough players - start game
      logger.info('DICEBOT_JOIN_TIMER_EXPIRED_START_GAME', { roomId, playerCount: game.players.length });
      
      const result = await dicebotService.beginGame(roomId);
      
      if (result && result.started) {
        await sendBotMessage(io, roomId, result.message);
        
        setTimeout(async () => {
          await startNextRoundFlow(io, roomId);
        }, dicebotService.COUNTDOWN_DELAY);
      }
      
      diceJoinTimers.delete(roomId);
    } catch (err) {
      logger.error('[DiceBot] Timer poller error:', err);
    } finally {
      isPolling = false;
    }
  }, dicebotService.JOIN_TIMEOUT);
  
  diceJoinTimers.set(roomId, timer);
};

// Start roll phase timer (20 seconds)
const startRollTimer = (io, roomId) => {
  // Clear existing timer if any
  if (diceRollTimers.has(roomId)) {
    clearTimeout(diceRollTimers.get(roomId));
  }
  
  logger.info('DICEBOT_ROLL_TIMER_STARTED', { roomId, timeout: dicebotService.ROLL_TIMEOUT });
  
  const timer = setTimeout(async () => {
    try {
      await processRoundEnd(io, roomId);
      diceRollTimers.delete(roomId);
    } catch (err) {
      logger.error('DICEBOT_ROLL_TIMER_ERROR', { roomId, error: err.message });
      diceRollTimers.delete(roomId);
    }
  }, dicebotService.ROLL_TIMEOUT);
  
  diceRollTimers.set(roomId, timer);
};

// Clear all timers for a room
const clearRoomTimers = (roomId) => {
  if (diceJoinTimers.has(roomId)) {
    clearTimeout(diceJoinTimers.get(roomId));
    diceJoinTimers.delete(roomId);
  }
  if (diceRollTimers.has(roomId)) {
    clearTimeout(diceRollTimers.get(roomId));
    diceRollTimers.delete(roomId);
  }
};

const startNextRoundFlow = async (io, roomId) => {
  const roundResult = await dicebotService.startNextRound(roomId);
  
  if (!roundResult) {
    logger.warn('DICEBOT_START_NEXT_ROUND_FAILED', { roomId });
    return;
  }
  
  await sendBotMessage(io, roomId, roundResult.message);
  await sendBotMessage(io, roomId, roundResult.targetMessage);
  
  startRollTimer(io, roomId);
};

const processRoundEnd = async (io, roomId, allRolled = false) => {
  const redis = getRedisClient();
  const processKey = `dicebot:processing:${roomId}`;
  
  const alreadyProcessing = await redis.get(processKey);
  if (alreadyProcessing) {
    logger.info('DICEBOT_SKIP_DUPLICATE_PROCESSING', { roomId });
    return;
  }
  
  await redis.set(processKey, '1', 'EX', 10);
  
  try {
    // Only show "Times Up" if we didn't get all rolls
    if (!allRolled) {
      await sendBotMessage(io, roomId, 'Times Up! Tallying roll.');
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const autoRolled = await dicebotService.autoRollForTimeout(roomId);
      for (const roll of autoRolled) {
        await sendBotMessage(io, roomId, `Bot rolls - ${roll.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    } else {
      await sendBotMessage(io, roomId, 'All rolls in! Tallying...');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    const result = await dicebotService.tallyRound(roomId);
    
    if (!result) {
      logger.warn('DICEBOT_TALLY_NO_RESULT', { roomId });
      await redis.del(processKey);
      return;
    }
    
    logger.info('DICEBOT_TALLY_RESULT', { 
      roomId, 
      gameOver: result.gameOver || false,
      roundComplete: result.roundComplete || false,
      allFailed: result.allFailed || false,
      error: result.error || false
    });
    
    if (result.error) {
      await sendBotMessage(io, roomId, result.message);
      await redis.del(processKey);
      return;
    }
    
    if (result.allFailed) {
      await sendBotMessage(io, roomId, result.message);
      
      setTimeout(async () => {
        await startNextRoundFlow(io, roomId);
        await redis.del(processKey);
      }, dicebotService.COUNTDOWN_DELAY);
      return;
    }
    
    if (result.gameOver) {
      logger.info('DICEBOT_GAME_OVER', { 
        roomId, 
        winnerId: result.winnerId, 
        winnerUsername: result.winnerUsername,
        winnings: result.winnings 
      });
      
      await sendBotMessage(io, roomId, result.message);
      
      if (result.playAgain) {
        await sendBotMessage(io, roomId, result.playAgain);
      }
      
      // CRITICAL: Clear all timers and game state immediately
      clearRoomTimers(roomId);
      await dicebotService.clearTimer(roomId);
      
      const redisClient = getRedisClient();
      await redisClient.del(`dicebot:processing:${roomId}`); 
      
      if (result.winnerId) {
        io.to(`room:${roomId}`).emit('credits:updated', { 
          userId: result.winnerId,
          balance: result.newBalance 
        });
      }
      await redis.del(processKey);
      return;
    }
    
    if (result.roundComplete) {
      if (result.eliminatedPlayers) {
        for (const player of result.eliminatedPlayers) {
          const socketId = await redis.get(`user:${player.userId}:socket`);
          if (socketId) {
            io.to(socketId).emit('chat:message', {
              id: generateMessageId(),
              roomId,
              username: 'DiceBot',
              message: `sory your LOST!`,
              messageType: 'dicebot',
              type: 'private',
              botType: 'dicebot',
              userType: 'bot',
              usernameColor: '#719c35',
              messageColor: '#347499',
              timestamp: new Date().toISOString()
            });
          }
        }
      }
      await sendBotMessage(io, roomId, result.message);
      await sendBotMessage(io, roomId, result.followUp);
      
      setTimeout(async () => {
        await startNextRoundFlow(io, roomId);
        await redis.del(processKey);
      }, dicebotService.COUNTDOWN_DELAY);
    }
  } catch (err) {
    logger.error('DICEBOT_PROCESS_ROUND_ERROR', { roomId, error: err.message, stack: err.stack });
    await redis.del(processKey);
  }
};

const handleDicebotCommand = async (io, socket, data) => {
  const { roomId, userId, username, message } = data;
  
  if (message.startsWith('/bot ')) {
    const parts = message.slice(5).trim().split(' ');
    const subCmd = parts[0]?.toLowerCase();
    const action = parts[1]?.toLowerCase();
    
    if (subCmd === 'dice' || subCmd === 'dicebot') {
      const userService = require('../services/userService');
      const user = await userService.getUserById(userId);
      if (!user || (user.role !== 'super_admin' && user.role !== 'admin')) {
        return true;
      }
      
      if (!action || action === 'add' || action === 'on') {
        const result = await dicebotService.addBotToRoom(roomId);
        await sendBotMessage(io, roomId, result.message);
        return true;
      }
      
      if (action === 'off' || action === 'remove') {
        clearRoomTimers(roomId);
        await dicebotService.clearTimer(roomId);
        const result = await dicebotService.removeBotFromRoom(roomId);
        await sendBotMessage(io, roomId, result.message);
        return true;
      }
      
      return true;
    }
    
    return false;
  }
  
  const isBotActive = await dicebotService.isBotActive(roomId);
  if (!isBotActive) return false;
  
  const lowerMessage = message.toLowerCase().trim();
  
  const DICEBOT_COMMANDS = ['!start', '!j', '!r', '!n', '!stop', '!reset'];
  const isDicebotCommand = DICEBOT_COMMANDS.some(cmd => lowerMessage.startsWith(cmd));
  
  if (!isDicebotCommand) return false;

  if (lowerMessage.startsWith('!start')) {
    const parts = message.split(' ');
    const amount = parts[1] || dicebotService.MIN_ENTRY;
    
    const result = await dicebotService.startGame(roomId, userId, username, amount);
    
    if (result.success) {
      await sendBotMessage(io, roomId, result.message);
      startJoinTimer(io, roomId);
      
      socket.emit('credits:updated', {
        userId,
        balance: result.newBalance
      });
    } else if (result.alreadyStarted && result.startedByUsername) {
      await sendBotMessage(io, roomId, `Game in progress by ${result.startedByUsername}. !j to join.`, 'dicebot', true, socket);
    } else if (result.message) {
      await sendBotMessage(io, roomId, result.message, 'dicebot', result.isPvt === true, socket);
    }
    
    return true;
  }
  
  if (lowerMessage === '!j') {
    const result = await dicebotService.joinGame(roomId, userId, username);
    
    if (result.success) {
      await sendBotMessage(io, roomId, result.message);
      
      socket.emit('credits:updated', {
        userId,
        balance: result.newBalance
      });
    } else if (result.message) {
      await sendBotMessage(io, roomId, result.message, 'dicebot', result.isPvt === true, socket);
    }
    
    return true;
  }
  
  if (lowerMessage === '!n') {
    const result = await dicebotService.cancelJoin(roomId, userId, username);
    
    if (result.success) {
      await sendBotMessage(io, roomId, result.message);
      
      if (result.newBalance !== undefined) {
        socket.emit('credits:updated', {
          userId,
          balance: result.newBalance
        });
      }
    } else if (result.message) {
      await sendBotMessage(io, roomId, result.message);
    }
    
    return true;
  }
  
  if (lowerMessage === '!r') {
    try {
      const result = await dicebotService.rollPlayerDice(roomId, userId, username);
      
      if (result.success) {
        await sendBotMessage(io, roomId, result.message);
        
        if (result.allRolled) {
          clearRoomTimers(roomId);
          await dicebotService.clearTimer(roomId);
          
          // Small delay before ending to ensure last roll is visible
          setTimeout(async () => {
            const redis = getRedisClient();
            const gameData = await redis.get(`dicebot:game:${roomId}`);
            if (gameData) {
              const game = JSON.parse(gameData);
              const stillNeedRoll = game.players.some(p => !p.isEliminated && !p.hasRolled);
              if (!stillNeedRoll) {
                await processRoundEnd(io, roomId, true); // Pass flag indicating all rolled
              }
            }
          }, 500);
        }
      } else if (result.message) {
        await sendBotMessage(io, roomId, result.message, 'dicebot', result.isPvt === true, socket);
      }
    } catch (err) {
      logger.error('DICEBOT_ROLL_ERROR', { roomId, userId, error: err.message });
    }
    
    return true;
  }
  
  if (lowerMessage === '!stop') {
    const result = await dicebotService.stopGame(roomId, userId, username);
    
    if (result.success) {
      await sendBotMessage(io, roomId, result.message);
      clearRoomTimers(roomId);
      await dicebotService.clearTimer(roomId);
    } else if (result.message) {
      await sendBotMessage(io, roomId, result.message);
    }
    
    return true;
  }
  
  if (lowerMessage === '!reset') {
    const result = await dicebotService.resetGame(roomId, userId, username);
    
    if (result.success) {
      clearRoomTimers(roomId);
      await sendBotMessage(io, roomId, result.message);
    } else if (result.message) {
      await sendBotMessage(io, roomId, result.message);
    }
    
    return true;
  }
  
  return false;
};

// No-op functions for backward compatibility (timers are now in-memory)
const startTimerPoller = (io) => {
  logger.info('DiceBot in-memory timers ready (no poller needed)');
};

const stopTimerPoller = () => {
  // Clear all timers
  for (const [roomId, timer] of diceJoinTimers) {
    clearTimeout(timer);
  }
  for (const [roomId, timer] of diceRollTimers) {
    clearTimeout(timer);
  }
  diceJoinTimers.clear();
  diceRollTimers.clear();
  logger.info('DiceBot timers stopped');
};

module.exports = {
  handleDicebotCommand,
  sendBotMessage,
  startTimerPoller,
  stopTimerPoller,
  processRoundEnd,
  clearRoomTimers
};
