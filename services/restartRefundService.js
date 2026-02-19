const { getRedisClient } = require('../redis');
const { query } = require('../db/db');
const logger = require('../utils/logger');

/**
 * Handles automatic refunds for games that were interrupted by a server restart.
 * Scans Redis for active game sessions and refunds the bets to the users.
 */
async function handleRestartRefunds(io) {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) {
    logger.warn('[Refund] Redis not ready, skipping restart refunds');
    return;
  }

  logger.info('[Refund] Starting game restart refund check...');

  try {
    // 1. DiceBot Refunds
    const diceKeys = await redis.keys('dicebot:game:*');
    for (const key of diceKeys) {
      try {
        const gameData = await redis.get(key);
        if (gameData) {
          const game = JSON.parse(gameData);
          if (game.status === 'waiting' || game.status === 'playing') {
            const roomId = key.split(':').pop();
            logger.info(`[Refund] Refunding DiceBot game in room ${roomId}`);
            
            for (const player of game.players) {
              await refundPlayer(player.userId, game.entryAmount, player.username, 'DiceBot', roomId);
            }
          }
        }
        await redis.del(key);
      } catch (err) {
        logger.error(`[Refund] Error processing DiceBot key ${key}:`, err.message);
      }
    }

    // 2. LowCard Refunds
    const lowcardKeys = await redis.keys('lowcard:game:*');
    for (const key of lowcardKeys) {
      try {
        const gameData = await redis.get(key);
        if (gameData) {
          const game = JSON.parse(gameData);
          if (game.status === 'waiting' || game.status === 'playing') {
            const roomId = key.split(':').pop();
            logger.info(`[Refund] Refunding LowCard game in room ${roomId}`);
            
            for (const player of game.players) {
              await refundPlayer(player.userId, game.entryAmount, player.username, 'LowCard', roomId);
            }
          }
        }
        await redis.del(key);
        await redis.del(`lowcard:deck:${key.split(':').pop()}`);
      } catch (err) {
        logger.error(`[Refund] Error processing LowCard key ${key}:`, err.message);
      }
    }

    // 3. FlagBot Refunds
    const flagbotKeys = await redis.keys('flagbot:room:*:bets');
    for (const key of flagbotKeys) {
      try {
        const roomId = key.split(':').slice(-2, -1)[0];
        const allBets = await redis.hGetAll(key);
        
        logger.info(`[Refund] Refunding FlagBot bets in room ${roomId}`);
        
        for (const [betKey, betStr] of Object.entries(allBets)) {
          const bet = JSON.parse(betStr);
          await refundPlayer(bet.userId, bet.amount, bet.username, 'FlagBot', roomId);
        }
        
        await redis.del(key);
        await redis.del(`flagbot:room:${roomId}`);
      } catch (err) {
        logger.error(`[Refund] Error processing FlagBot key ${key}:`, err.message);
      }
    }

    logger.info('[Refund] Game restart refund check completed.');
  } catch (error) {
    logger.error('[Refund] Critical error in restart refund handler:', error.message);
  }
}

async function refundPlayer(userId, amount, username, gameType, roomId) {
  try {
    const description = `${gameType} Refund - Server Restart (Room ${roomId})`;
    
    // Update balance in DB
    await query(
      'UPDATE users SET credits = credits + $1 WHERE id = $2',
      [amount, userId]
    );
    
    // Log transaction
    await query(
      `INSERT INTO credit_logs (from_user_id, from_username, amount, transaction_type, description, created_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      [userId, username, amount, 'game_refund', description]
    );
    
    // Clear balance cache
    const redis = getRedisClient();
    await redis.del(`credits:${userId}`);
    
    logger.info(`[Refund] Success: ${amount} refunded to ${username} (${userId}) for ${gameType}`);
  } catch (err) {
    logger.error(`[Refund] Failed to refund ${username} (${userId}):`, err.message);
  }
}

module.exports = { handleRestartRefunds };
