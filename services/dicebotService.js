const { query } = require('../db/db');
const { getRedisClient } = require('../redis');
const logger = require('../utils/logger');
const merchantTagService = require('./merchantTagService');
const gameStateManager = require('./gameStateManager');
const { 
  getDiceEmoji, 
  getDiceCode, 
  formatDiceRoll, 
  formatDiceRollEmoji, 
  isBalakSix 
} = require('../utils/diceMapping');

const JOIN_TIMEOUT = 30000;
const ROLL_TIMEOUT = 20000;
const COUNTDOWN_DELAY = 3000;
const MIN_ENTRY = 1;
const MAX_ENTRY = 999999999; // No limit
const HOUSE_FEE_PERCENT = 10;

// Redis key helpers for timer (new system)
const TIMER_KEY = (roomId) => `room:${roomId}:dice:timer`;

const rollDice = () => {
  const die1 = Math.floor(Math.random() * 6) + 1;
  const die2 = Math.floor(Math.random() * 6) + 1;
  return { die1, die2, total: die1 + die2 };
};

const formatDiceTags = (die1, die2) => {
  return `[DICE:${die1}] [DICE:${die2}]`;
};

const isDoubleSix = (die1, die2) => {
  return die1 === 6 && die2 === 6;
};

const formatCoins = (amount) => {
  return amount.toLocaleString('id-ID');
};

const getUserCredits = async (userId) => {
  try {
    const redis = getRedisClient();
    const cached = await redis.get(`credits:${userId}`);
    if (cached !== null) {
      return parseInt(cached);
    }
    const result = await query('SELECT credits FROM users WHERE id = $1', [userId]);
    const balance = result.rows[0]?.credits || 0;
    await redis.set(`credits:${userId}`, balance, 'EX', 300);
    return parseInt(balance);
  } catch (error) {
    logger.error('DICEBOT_GET_CREDITS_ERROR', error);
    return 0;
  }
};

const logGameTransaction = async (userId, username, amount, transactionType, description) => {
  try {
    await query(
      `INSERT INTO credit_logs (from_user_id, from_username, amount, transaction_type, description, created_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      [userId, username, amount, transactionType, description]
    );
  } catch (error) {
    logger.error('DICEBOT_LOG_TRANSACTION_ERROR', error);
  }
};

const deductCredits = async (userId, amount, username = null, reason = null, gameSessionId = null) => {
  try {
    const redis = getRedisClient();
    
    const taggedBalance = await merchantTagService.getTaggedBalance(userId);
    let usedTaggedCredits = 0;
    let remainingAmount = amount;
    
    if (taggedBalance > 0) {
      const consumeResult = await merchantTagService.consumeForGame(userId, 'dicebot', amount, gameSessionId);
      if (consumeResult.success) {
        usedTaggedCredits = consumeResult.usedTaggedCredits || 0;
        remainingAmount = consumeResult.remainingAmount;
        if (usedTaggedCredits > 0) {
          logger.info('DICEBOT_TAGGED_CREDITS_USED', { userId, usedTaggedCredits, remainingAmount });
        }
      }
    }
    
    if (remainingAmount <= 0) {
      const current = await getUserCredits(userId);
      if (username && reason) {
        await logGameTransaction(userId, username, -amount, 'game_bet', `${reason} (Tagged Credits)`);
      }
      return { success: true, balance: current, usedTaggedCredits };
    }
    
    const current = await getUserCredits(userId);
    if (current < remainingAmount) {
      return { success: false, balance: current };
    }
    
    const result = await query(
      'UPDATE users SET credits = credits - $1 WHERE id = $2 AND credits >= $1 RETURNING credits',
      [remainingAmount, userId]
    );
    
    if (result.rows.length === 0) {
      return { success: false, balance: current };
    }
    
    const newBalance = parseInt(result.rows[0].credits);
    await redis.set(`credits:${userId}`, newBalance, 'EX', 300);
    
    if (username && reason) {
      const desc = usedTaggedCredits > 0 ? `${reason} (${usedTaggedCredits} tagged + ${remainingAmount} regular)` : reason;
      await logGameTransaction(userId, username, -amount, 'game_bet', desc);
    }
    
    return { success: true, balance: newBalance, usedTaggedCredits };
  } catch (error) {
    logger.error('DICEBOT_DEDUCT_CREDITS_ERROR', error);
    return { success: false, balance: 0 };
  }
};

const addCredits = async (userId, amount, username = null, reason = null) => {
  try {
    const redis = getRedisClient();
    const result = await query(
      'UPDATE users SET credits = credits + $1 WHERE id = $2 RETURNING credits',
      [amount, userId]
    );
    
    if (result.rows.length > 0) {
      const newBalance = parseInt(result.rows[0].credits);
      await redis.set(`credits:${userId}`, newBalance, 'EX', 300);
      
      if (username && reason) {
        await logGameTransaction(userId, username, amount, reason.includes('Refund') ? 'game_refund' : 'game_win', reason);
      }
      
      return { success: true, balance: newBalance };
    }
    return { success: false, balance: 0 };
  } catch (error) {
    logger.error('DICEBOT_ADD_CREDITS_ERROR', error);
    return { success: false, balance: 0 };
  }
};

const isRoomManaged = async (roomId) => {
  try {
    const result = await query('SELECT owner_id FROM rooms WHERE id = $1', [roomId]);
    return result.rows.length > 0 && result.rows[0].owner_id !== null;
  } catch (error) {
    logger.error('DICEBOT_CHECK_ROOM_ERROR', error);
    return false;
  }
};

const isRoomAdmin = async (roomId, userId) => {
  try {
    const result = await query(
      `SELECT 1 FROM rooms WHERE id = $1 AND owner_id = $2
       UNION
       SELECT 1 FROM room_admins WHERE room_id = $1 AND user_id = $2`,
      [roomId, userId]
    );
    return result.rows.length > 0;
  } catch (error) {
    logger.error('DICEBOT_CHECK_ADMIN_ERROR', error);
    return false;
  }
};

const isSystemAdmin = async (userId) => {
  try {
    const result = await query(
      "SELECT 1 FROM users WHERE id = $1 AND role IN ('admin', 'super_admin')",
      [userId]
    );
    return result.rows.length > 0;
  } catch (error) {
    logger.error('DICEBOT_CHECK_SYSADMIN_ERROR', error);
    return false;
  }
};

const isCustomerService = async (userId) => {
  try {
    const result = await query(
      "SELECT 1 FROM users WHERE id = $1 AND role IN ('admin', 'super_admin', 'customer_service')",
      [userId]
    );
    return result.rows.length > 0;
  } catch (error) {
    logger.error('DICEBOT_CHECK_CS_ERROR', error);
    return false;
  }
};

// Redis-based timer management
const setTimer = async (roomId, phase, durationMs) => {
  const redis = getRedisClient();
  const timerKey = TIMER_KEY(roomId);
  const expiresAt = Date.now() + durationMs;
  
  await redis.set(timerKey, JSON.stringify({
    phase, // 'join' or 'roll'
    expiresAt,
    roomId
  }), 'EX', Math.ceil(durationMs / 1000) + 10);
  
  logger.info('DICEBOT_TIMER_SET', { roomId, phase, durationMs, expiresAt, timerKey });
  
  return expiresAt;
};

const getTimer = async (roomId) => {
  const redis = getRedisClient();
  const timerKey = TIMER_KEY(roomId);
  const data = await redis.get(timerKey);
  return data ? JSON.parse(data) : null;
};

const clearTimer = async (roomId) => {
  const redis = getRedisClient();
  const timerKey = TIMER_KEY(roomId);
  await redis.del(timerKey);
};

const isTimerExpired = async (roomId) => {
  const timer = await getTimer(roomId);
  if (!timer) return true;
  return Date.now() >= timer.expiresAt;
};

// Cancel join - refund player who wants to leave before game starts
const cancelJoin = async (roomId, userId, username) => {
  const redis = getRedisClient();
  const gameKey = `dicebot:game:${roomId}`;
  
  const gameData = await redis.get(gameKey);
  if (!gameData) {
    return { success: false, silent: true };
  }
  
  const game = JSON.parse(gameData);
  
  // Can only cancel during waiting phase
  if (game.status !== 'waiting') {
    return { success: false, message: 'Game already started. Cannot cancel.' };
  }
  
  const playerIndex = game.players.findIndex(p => p.userId == userId);
  if (playerIndex === -1) {
    return { success: false, silent: true };
  }
  
  // If this is the starter and there are other players, don't allow cancel
  if (game.startedBy == userId && game.players.length > 1) {
    return { success: false, message: 'You started the game. Use !stop to cancel.' };
  }
  
  // Refund and remove player
  await addCredits(userId, game.entryAmount, username, 'DiceBot Refund - Cancel join');
  game.players.splice(playerIndex, 1);
  game.pot -= game.entryAmount;
  
  // If no players left, cancel the game
  if (game.players.length === 0) {
    await redis.del(gameKey);
    await clearTimer(roomId);
    return { success: true, message: `${username} left. Game cancelled.`, gameCancelled: true };
  }
  
  await redis.set(gameKey, JSON.stringify(game), 'EX', 3600);
  
  return { 
    success: true, 
    message: `${username} left the game. Coins refunded.`,
    newBalance: await getUserCredits(userId)
  };
};

// Stop game (admin/cs/room admin only) - replaces !cancel
const stopGame = async (roomId, userId, username) => {
  const isAdmin = await isSystemAdmin(userId);
  const isCS = await isCustomerService(userId);
  const isRoomAdminUser = await isRoomAdmin(roomId, userId);
  
  if (!isAdmin && !isCS && !isRoomAdminUser) {
    return { success: false, message: 'Only admin, CS, or room admin can stop the game.' };
  }
  
  return await cancelGame(roomId, `Stopped by ${username}`);
};

// Reset game (admin/cs only) - force reset stuck games
const resetGame = async (roomId, userId, username) => {
  const isAdmin = await isSystemAdmin(userId);
  const isCS = await isCustomerService(userId);
  
  if (!isAdmin && !isCS) {
    return { success: false, message: 'Only admin or CS can reset the game.' };
  }
  
  const redis = getRedisClient();
  const gameKey = `dicebot:game:${roomId}`;
  
  const gameData = await redis.get(gameKey);
  if (gameData) {
    const game = JSON.parse(gameData);
    // Refund all non-eliminated players
    for (const player of game.players) {
      if (!player.isEliminated) {
        await addCredits(player.userId, game.entryAmount, player.username, 'DiceBot Refund - Game reset');
      }
    }
  }
  
  // Clear all game state
  await redis.del(gameKey);
  await clearTimer(roomId);
  
  return { success: true, message: `Game reset by ${username}. All players refunded.` };
};

const addBotToRoom = async (roomId) => {
  const redis = getRedisClient();
  const botKey = `dicebot:bot:${roomId}`;
  
  const exists = await redis.exists(botKey);
  if (exists) {
    return { success: false, message: 'DiceBot is already active in this room.' };
  }
  
  const lowcardActive = await redis.exists(`lowcard:bot:${roomId}`);
  if (lowcardActive) {
    return { success: false, message: 'LowCardBot is active. Remove it first with /bot lowcard off' };
  }
  
  const legendActive = await redis.exists(`legend:bot:${roomId}`);
  if (legendActive) {
    return { success: false, message: 'FlagBot is active. Remove it first.' };
  }
  
  await redis.set(botKey, JSON.stringify({
    active: true,
    defaultAmount: 1000,
    createdAt: new Date().toISOString()
  }), 'EX', 86400 * 7);
  
  await gameStateManager.setActiveGameType(roomId, gameStateManager.GAME_TYPES.DICE);
  
  return { success: true, message: '[PVT] You started the game. Please wait 3s.' };
};

const removeBotFromRoom = async (roomId) => {
  const redis = getRedisClient();
  const botKey = `dicebot:bot:${roomId}`;
  const gameKey = `dicebot:game:${roomId}`;
  
  const exists = await redis.exists(botKey);
  if (!exists) {
    return { success: false, message: 'No DiceBot in this room.' };
  }
  
  const gameData = await redis.get(gameKey);
  if (gameData) {
    const game = JSON.parse(gameData);
    if (game.status === 'waiting') {
      for (const player of game.players) {
        await addCredits(player.userId, game.entryAmount, player.username, 'DiceBot Refund - Bot removed');
      }
    }
  }
  
  await redis.del(botKey);
  await redis.del(gameKey);
  
  await gameStateManager.clearActiveGameType(roomId);
  
  return { success: true, message: 'DiceBot has left the room.' };
};

const isBotActive = async (roomId) => {
  const redis = getRedisClient();
  const botKey = `dicebot:bot:${roomId}`;
  return await redis.exists(botKey);
};

const getBotStatus = async (roomId) => {
  const redis = getRedisClient();
  const botKey = `dicebot:bot:${roomId}`;
  const data = await redis.get(botKey);
  return data ? JSON.parse(data) : null;
};

const getActiveGame = async (roomId) => {
  const redis = getRedisClient();
  const gameKey = `dicebot:game:${roomId}`;
  const data = await redis.get(gameKey);
  return data ? JSON.parse(data) : null;
};

const startGame = async (roomId, userId, username, amount) => {
  const redis = getRedisClient();
  const gameKey = `dicebot:game:${roomId}`;
  const lockKey = `dicebot:lock:${roomId}`;
  
  const lockAcquired = await redis.set(lockKey, '1', 'EX', 5, 'NX');
  if (!lockAcquired) {
    return { success: false, message: 'Please wait, another action is in progress.' };
  }
  
  try {
    const existingGame = await redis.get(gameKey);
    if (existingGame) {
      const game = JSON.parse(existingGame);
      if (game.status === 'waiting' || game.status === 'playing') {
        return { 
          success: false, 
          message: `game in progress`,
          alreadyStarted: true,
          startedByUsername: game.startedByUsername
        };
      }
      // If game is 'finished' but key still exists, allow overwrite
      await redis.del(gameKey);
    }
    
    const requestedAmount = parseInt(amount) || MIN_ENTRY;
    
    if (requestedAmount < MIN_ENTRY) {
      return { success: false, message: `Minimal ${formatCoins(MIN_ENTRY)} COINS to start game.`, isPvt: true };
    }
    
    const entryAmount = Math.min(MAX_ENTRY, requestedAmount);
    
    const deductResult = await deductCredits(userId, entryAmount, username, `DiceBot Bet - Start game`);
    if (!deductResult.success) {
      return { success: false, message: `You not enough credite`, isPvt: true };
    }
    
    await query(
      `INSERT INTO game_history (user_id, username, game_type, bet_amount, result, reward_amount, merchant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, username, 'dice', entryAmount, 'lose', 0, null]
    );
    
    const gameId = Date.now();
    
    // 🏷️ TRACK FOR REFUND: Save detailed bet data in Redis immediately
    // This ensures that even if server restarts during 'waiting' phase, we can refund
    await getRedisClient().set(`dicebot:game:${roomId}`, JSON.stringify({
      id: gameId,
      roomId,
      status: 'waiting',
      entryAmount,
      players: [{ userId, username }]
    }), { EX: 300 }); // 5 min expiry just in case

    const game = {
      id: gameId,
      roomId,
      status: 'waiting',
      entryAmount,
      pot: entryAmount,
      currentRound: 0,
      botTarget: null,
      players: [{
        userId: userId,
        username,
        isEliminated: false,
        hasRolled: false,
        die1: null,
        die2: null,
        total: null,
        isIn: null,
        hasImmunity: false,
        earnedImmunity: false
      }],
      startedBy: userId,
      startedByUsername: username,
      createdAt: new Date().toISOString(),
      joinDeadline: Date.now() + JOIN_TIMEOUT
    };
    
    await redis.set(gameKey, JSON.stringify(game), 'EX', 3600);
    
    return {
      success: true,
      gameId,
      newBalance: deductResult.balance,
      message: `Game started by ${username}. Enter !j to join the game. Cost: ${formatCoins(entryAmount)} COINS [30s]`
    };
  } finally {
    await redis.del(lockKey);
  }
};

const joinGame = async (roomId, userId, username) => {
  const redis = getRedisClient();
  const gameKey = `dicebot:game:${roomId}`;
  
  const gameData = await redis.get(gameKey);
  if (!gameData) {
    // If no active game in Redis, check if bot is even active
    const botActive = await isBotActive(roomId);
    if (!botActive) {
      return { success: false, message: 'DiceBot is not active in this room.' };
    }
    return { success: false, message: 'No active game. Use !start [amount] to start one.' };
  }
  
  const game = JSON.parse(gameData);
  
  if (game.status !== 'waiting') {
    return { success: false, message: 'Game already in progress. Wait for the next round.', isPvt: true };
  }
  
  if (Date.now() > game.joinDeadline) {
    return { success: false, message: 'Join period has ended.', isPvt: true };
  }
  
  const alreadyJoined = game.players.find(p => p.userId == userId);
  if (alreadyJoined) {
    return { success: false, message: 'You have already joined this game.', isPvt: true };
  }
  
  const deductResult = await deductCredits(userId, game.entryAmount, username, `DiceBot Bet - Join game`);
  if (!deductResult.success) {
    return { success: false, message: `You not enough credite`, isPvt: true };
  }
  
  // Track spending for merchant tag commission
  await merchantTagService.trackTaggedUserSpending(userId, 'dicebot', game.entryAmount);
  
  game.players.push({
    userId,
    username,
    isEliminated: false,
    hasRolled: false,
    die1: null,
    die2: null,
    total: null,
    isIn: null,
    hasImmunity: false,
    earnedImmunity: false
  });
  game.pot += game.entryAmount;
  
  await redis.set(gameKey, JSON.stringify(game), 'EX', 3600);
  
  return {
    success: true,
    message: `${username} joined the game.`,
    playerCount: game.players.length,
    pot: game.pot,
    newBalance: deductResult.balance
  };
};

const beginGame = async (roomId) => {
  const redis = getRedisClient();
  const gameKey = `dicebot:game:${roomId}`;
  
  const gameData = await redis.get(gameKey);
  if (!gameData) return null;
  
  const game = JSON.parse(gameData);
  
  if (game.status !== 'waiting') {
    return null;
  }
  
  if (game.players.length < 2) {
    for (const player of game.players) {
      await addCredits(player.userId, game.entryAmount, player.username, 'DiceBot Refund - Not enough players');
    }
    await redis.del(gameKey);
    return { 
      cancelled: true, 
      message: 'Not enough player join. Coins refunded.',
      playAgain: `Play now: !start to enter. Cost: ${formatCoins(MIN_ENTRY)} COINS. For custom entry, !start [amount]`
    };
  }
  
  game.status = 'playing';
  game.currentRound = 0;
  
  await redis.set(gameKey, JSON.stringify(game), 'EX', 3600);
  
  const playerNames = game.players.map(p => p.username).join(', ');
  
  return {
    started: true,
    message: `Game begins! Bot rolls first, match or beat total to stay IN!, ready to roll in 3 seconds.`,
    playerNames,
    playerCount: game.players.length,
    pot: game.pot
  };
};

const startNextRound = async (roomId) => {
  const redis = getRedisClient();
  const gameKey = `dicebot:game:${roomId}`;
  
  const gameData = await redis.get(gameKey);
  if (!gameData) return null;
  
  const game = JSON.parse(gameData);
  
  if (game.status !== 'playing') return null;
  
  game.currentRound++;
  
  const { die1, die2, total } = rollDice();
  game.botTarget = { die1, die2, total };
  
  for (const player of game.players) {
    if (!player.isEliminated) {
      if (player.earnedImmunity) {
        player.hasImmunity = true;
        player.earnedImmunity = false;
      }
      player.hasRolled = false;
      player.die1 = null;
      player.die2 = null;
      player.total = null;
      player.isIn = null;
    }
  }
  
  await redis.set(gameKey, JSON.stringify(game), 'EX', 3600);
  
  const diceDisplay = formatDiceTags(die1, die2);
  
  return {
    round: game.currentRound,
    botDice: diceDisplay,
    botTarget: total,
    message: `ROUND #${game.currentRound}: Players. !r to ROLL. 20 seconds.`,
    targetMessage: `Bot rolled: ${diceDisplay} Your target is ${total}!`
  };
};

const rollPlayerDice = async (roomId, userId, username) => {
  const redis = getRedisClient();
  const gameKey = `dicebot:game:${roomId}`;
  const rollLockKey = `dicebot:rolllock:${roomId}:${userId}`;
  
  // Prevent double-roll race condition with per-user lock
  const lockAcquired = await redis.set(rollLockKey, '1', 'EX', 3, 'NX');
  if (!lockAcquired) {
    return { success: false, message: 'Please wait, processing your roll...' };
  }
  
  try {
    const gameData = await redis.get(gameKey);
    if (!gameData) {
      return { success: false, message: 'No active game.' };
    }
    
    let game;
    try {
      game = JSON.parse(gameData);
    } catch (parseErr) {
      logger.error('DICEBOT_PARSE_ERROR', { roomId, error: parseErr.message });
      return { success: false, message: 'Game data error. Please wait or restart game.' };
    }
    
    if (game.status !== 'playing') {
      return { success: false, message: 'Game not in rolling phase.' };
    }
    
    if (!game.botTarget || !game.botTarget.total) {
      // Auto-recover: if game is playing but no target, wait for next round
      return { success: false, message: 'Waiting for next round to start...' };
    }
    
    const player = game.players.find(p => p.userId == userId && !p.isEliminated);
    if (!player) {
      return { success: false, message: 'You are not in this game or have been eliminated.', isPvt: true };
    }
    
    if (player.hasRolled) {
      return { success: false, message: 'You have already rolled this round.', isPvt: true };
    }
    
    const { die1, die2, total } = rollDice();
    
    player.hasRolled = true;
    player.die1 = die1;
    player.die2 = die2;
    player.total = total;
    
    const meetsTarget = total >= game.botTarget.total;
    const gotDoubleSix = isDoubleSix(die1, die2);
    
    if (gotDoubleSix) {
      player.earnedImmunity = true;
    }
    
    if (meetsTarget || player.hasImmunity) {
      player.isIn = true;
    } else {
      player.isIn = false;
    }
    
    await redis.set(gameKey, JSON.stringify(game), 'EX', 3600);
    
    const diceDisplay = formatDiceTags(die1, die2);
    
    let status;
    let immunityMessage = '';
    
    if (gotDoubleSix) {
      status = 'IN!';
      immunityMessage = ' IMMUNITY for next round!';
    } else if (player.hasImmunity && !meetsTarget) {
      status = 'IMMUNE - stays IN!';
    } else {
      status = player.isIn ? 'IN!' : 'OUT!';
    }
    
    const activePlayers = game.players.filter(p => !p.isEliminated);
    const allRolled = activePlayers.every(p => p.hasRolled);
    
    return {
      success: true,
      username,
      die1,
      die2,
      total,
      diceDisplay,
      isIn: player.isIn,
      gotDoubleSix,
      usedImmunity: player.hasImmunity && !meetsTarget,
      allRolled,
      message: `${username}: ${diceDisplay} ${status}${immunityMessage}`
    };
  } finally {
    // Always release the lock
    await redis.del(rollLockKey);
  }
};

const autoRollForTimeout = async (roomId) => {
  const redis = getRedisClient();
  const gameKey = `dicebot:game:${roomId}`;
  const gameData = await redis.get(gameKey);
  if (!gameData) return [];

  const game = JSON.parse(gameData);
  const rolls = [];
  
  const target = game.botTarget?.total || 0;
  
  for (const player of game.players) {
    if (!player.isEliminated && !player.hasRolled) {
      const { die1, die2, total } = rollDice();
      player.hasRolled = true;
      player.die1 = die1;
      player.die2 = die2;
      player.total = total;
      
      const meetsTarget = total >= target;
      player.isIn = meetsTarget || player.hasImmunity;
      
      if (isDoubleSix(die1, die2)) {
        player.earnedImmunity = true;
      }
      
      rolls.push({ 
        username: player.username, 
        message: `${player.username}: ${formatDiceTags(die1, die2)} = ${total} ${player.isIn ? 'IN!' : 'OUT!'}` 
      });
    }
  }
  
  await redis.set(gameKey, JSON.stringify(game), 'EX', 3600);
  return rolls;
};

const tallyRound = async (roomId) => {
  const redis = getRedisClient();
  const gameKey = `dicebot:game:${roomId}`;
  
  const gameData = await redis.get(gameKey);
  if (!gameData) return null;
  
  const game = JSON.parse(gameData);
  if (game.status !== 'playing') return null;

  const target = game.botTarget?.total || 0;
  let hasWinner = false;
  const activePlayers = game.players.filter(p => !p.isEliminated);
  
  // 1. Tally winners and losers based on target
  activePlayers.forEach(p => {
    // A player wins this round if they match/beat bot OR have immunity
    if (p.total >= target || p.hasImmunity) {
      p.isIn = true;
      hasWinner = true; 
    } else {
      p.isIn = false;
    }
  });

  // 2. Elimination logic
  if (hasWinner) {
    // If at least one person beat the bot, everyone else is out
    game.players.forEach(p => {
      if (!p.isEliminated && !p.isIn) {
        p.isEliminated = true;
      }
      // Reset immunity for survivors
      p.hasImmunity = false;
    });
  } else {
    // Nobody beat the bot, everyone stays in for another try (Kotlin logic)
    game.players.forEach(p => {
      if (!p.isEliminated) {
        p.isIn = true;
        p.hasRolled = false; // Reset for retry
      }
      p.hasImmunity = false;
    });
    // Important: Reset bot target so next round starts fresh
    game.botTarget = null;
  }

  const remainingPlayers = game.players.filter(p => !p.isEliminated);
  const eliminatedPlayers = game.players.filter(p => p.isEliminated && !p.hasBeenNotifiedOfLoss);
  
  if (remainingPlayers.length === 0) {
     await redis.del(gameKey);
     return { gameOver: true, message: 'Game Over! Nobody won.' };
  }

  // Mark eliminated players so they don't get duplicate messages
  eliminatedPlayers.forEach(p => p.hasBeenNotifiedOfLoss = true);

  if (remainingPlayers.length === 1 && hasWinner) {
    await redis.set(gameKey, JSON.stringify(game), 'EX', 3600);
    return await finalizeGame(roomId);
  }

  // Next round
  game.botTarget = null; // Clear target for next round setup
  await redis.set(gameKey, JSON.stringify(game), 'EX', 3600);
  
  const playerNames = remainingPlayers.map(p => p.username).join(', ');
  const eliminatedPlayersData = eliminatedPlayers.map(p => ({ userId: p.userId, username: p.username }));
  
  return {
    roundComplete: true,
    allFailed: !hasWinner,
    eliminatedPlayers: eliminatedPlayersData,
    message: hasWinner ? `Round over! Losers eliminated. Remaining: ${playerNames}` : "Nobody won, so we'll try again!",
    followUp: `Next round starting in 3 seconds...`,
    nextRound: game.currentRound + 1
  };
};

const finalizeGame = async (roomId) => {
  const redis = getRedisClient();
  const gameKey = `dicebot:game:${roomId}`;
  
  const gameData = await redis.get(gameKey);
  if (!gameData) return null;
  
  const game = JSON.parse(gameData);
  
  const winner = game.players.find(p => !p.isEliminated);
  if (!winner) {
    await redis.del(gameKey);
    return { error: true, message: 'Game ended with no winner.' };
  }
  
  const houseFee = Math.floor(game.pot * HOUSE_FEE_PERCENT / 100);
  const winnings = game.pot - houseFee;

  // Track commission for merchant tag
  try {
    const { getPool } = require('../db/db');
    const pool = getPool();
    const starterId = game.startedBy;
    const tagResult = await pool.query('SELECT merchant_id FROM merchant_tags WHERE merchant_user_id = $1 LIMIT 1', [starterId]);
    if (tagResult.rows.length > 0 && houseFee > 0) {
      const merchantId = tagResult.rows[0].merchant_id;
      const commission = Math.floor(houseFee * 0.1); // 10% of house fee
      if (commission > 0) {
        const { addMerchantIncome } = require('../utils/merchantTags');
        await addMerchantIncome(merchantId, commission);
        logger.info(`[DiceBot] Commission paid to merchant ${merchantId}: ${commission} (10% of ${houseFee})`);
      }
    }
  } catch (err) {
    logger.error('DICEBOT_COMMISSION_ERROR', err);
  }

  const addResult = await addCredits(winner.userId, winnings, winner.username, `DiceBot Win - ${winnings} COINS (Pot: ${game.pot}, Fee: ${houseFee})`);
  
  // Record game history for leaderboards
  try {
    await query(
      `INSERT INTO game_history (user_id, username, game_type, bet_amount, result, reward_amount)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [winner.userId, winner.username, 'dice', game.entryAmount, 'win', winnings]
    );
  } catch (err) {
    logger.error('DICEBOT_HISTORY_ERROR', err);
  }

  game.status = 'finished';
  game.winnerId = winner.userId;
  game.winnerUsername = winner.username;
  game.winnings = winnings;
  game.houseFee = houseFee;
  game.finishedAt = new Date().toISOString();
  
  // Explicitly clear bot target and other state flags to prevent stuck game 2
  game.botTarget = null;
  game.players.forEach(p => {
    p.hasRolled = false;
    p.isIn = null;
    p.die1 = null;
    p.die2 = null;
    p.total = null;
  });
  
  await redis.set(gameKey, JSON.stringify(game), 'EX', 60);
  
  // Clear the main game key quickly to allow new !start
  setTimeout(async () => {
    await redis.del(gameKey);
  }, 2000); // 2 seconds instead of 5s
  
  return {
    gameOver: true,
    winnerId: winner.userId,
    winnerUsername: winner.username,
    pot: game.pot,
    winnings,
    houseFee,
    newBalance: addResult.balance,
    message: `Dice game over! ${winner.username} WINS ${formatCoins(winnings)} COINS!\nCONGRATS!`,
    playAgain: `Play now: !start to enter. Cost: ${formatCoins(MIN_ENTRY)} COINS.\nFor custom entry, !start [amount]`
  };
};

const cancelGame = async (roomId, reason = 'Game cancelled') => {
  const redis = getRedisClient();
  const gameKey = `dicebot:game:${roomId}`;
  
  const gameData = await redis.get(gameKey);
  if (!gameData) {
    return { success: false, message: 'No active game to cancel.' };
  }
  
  const game = JSON.parse(gameData);
  
  if (game.status === 'finished') {
    return { success: false, message: 'Game already finished.' };
  }
  
  for (const player of game.players) {
    if (!player.isEliminated) {
      await addCredits(player.userId, game.entryAmount, player.username, `DiceBot Refund - ${reason}`);
    }
  }
  
  await redis.del(gameKey);
  
  return { success: true, message: `Game cancelled. All active players refunded.` };
};

module.exports = {
  JOIN_TIMEOUT,
  ROLL_TIMEOUT,
  COUNTDOWN_DELAY,
  MIN_ENTRY,
  MAX_ENTRY,
  HOUSE_FEE_PERCENT,
  rollDice,
  formatDiceTags,
  isDoubleSix,
  formatCoins,
  getDiceEmoji,
  getDiceCode,
  formatDiceRoll,
  formatDiceRollEmoji,
  isBalakSix,
  getUserCredits,
  deductCredits,
  addCredits,
  isRoomManaged,
  isRoomAdmin,
  isSystemAdmin,
  isCustomerService,
  setTimer,
  getTimer,
  clearTimer,
  isTimerExpired,
  cancelJoin,
  stopGame,
  resetGame,
  addBotToRoom,
  removeBotFromRoom,
  isBotActive,
  getBotStatus,
  getActiveGame,
  startGame,
  joinGame,
  beginGame,
  startNextRound,
  rollPlayerDice,
  autoRollForTimeout,
  tallyRound,
  finalizeGame,
  cancelGame
};
