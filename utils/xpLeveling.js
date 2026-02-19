const { query } = require('../db/db');
const { getRedisClient } = require('../redis');

const XP_REWARDS = {
  SEND_MESSAGE: 1,
  DAILY_CHAT: 5,
  JOIN_ROOM: 5,
  PLAY_GAME: 3,
  TRANSFER_CREDIT: 2,
  WIN_GAME: 10,
  DAILY_LOGIN: 15,
  SEND_GIFT: 2,
  JOIN_GAME: 1
};

const LEVEL_THRESHOLDS = [
  0,      // Level 1
  10,     // Level 2
  25,     // Level 3
  45,     // Level 4
  70,     // Level 5
  100,    // Level 6
  140,    // Level 7
  190,    // Level 8
  250,    // Level 9
  320,    // Level 10
  400,    // Level 11
  500,    // Level 12
  620,    // Level 13
  760,    // Level 14
  920,    // Level 15
  2000,   // Level 16 - Start getting harder
  4000,   // Level 17
  7000,   // Level 18
  11000,  // Level 19
  16000,  // Level 20
  22000,  // Level 21
  29500,  // Level 22
  38000,  // Level 23
  48000,  // Level 24
  60000,  // Level 25
  75000,  // Level 26
  92000,  // Level 27
  112000, // Level 28
  135000, // Level 29
  160000  // Level 30
];

const getXpThreshold = (level) => {
  if (level <= 0) return 0;
  if (level <= LEVEL_THRESHOLDS.length) {
    return LEVEL_THRESHOLDS[level - 1];
  }
  const lastThreshold = LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1];
  const extraLevels = level - LEVEL_THRESHOLDS.length;
  return lastThreshold + (extraLevels * 4000) + (extraLevels * extraLevels * 500);
};

const calculateLevel = (xp) => {
  let level = 1;
  while (getXpThreshold(level + 1) <= xp) {
    level++;
  }
  return level;
};

const getXpForNextLevel = (currentLevel) => {
  return getXpThreshold(currentLevel + 1);
};

const getLevelProgress = (xp, level) => {
  const currentLevelXp = getXpThreshold(level);
  const nextLevelXp = getXpThreshold(level + 1);
  const progress = ((xp - currentLevelXp) / (nextLevelXp - currentLevelXp)) * 100;
  return Math.min(Math.max(progress, 0), 100);
};

const addDailyChatXp = async (userId, io = null) => {
  try {
    const client = getRedisClient();
    const dailyKey = `xp:daily_chat:${userId}`;
    const alreadyClaimed = await client.get(dailyKey);
    if (alreadyClaimed) return null;

    const now = new Date();
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    const ttlSeconds = Math.ceil((endOfDay.getTime() - now.getTime()) / 1000);

    await client.set(dailyKey, '1', { EX: ttlSeconds });
    return await addXp(userId, XP_REWARDS.DAILY_CHAT, 'daily_chat', io);
  } catch (error) {
    console.error('Error adding daily chat XP:', error);
    return null;
  }
};

const addXp = async (userId, amount, action, io = null) => {
  try {
    const client = getRedisClient();
    const result = await query(
      `INSERT INTO user_levels (user_id, xp, level)
       VALUES ($1, $2, 1)
       ON CONFLICT (user_id) 
       DO UPDATE SET xp = user_levels.xp + EXCLUDED.xp, updated_at = CURRENT_TIMESTAMP
       RETURNING xp, level`,
      [userId, amount]
    );
    
    const { xp, level: oldLevel } = result.rows[0];
    const newLevel = calculateLevel(xp);
    
    if (newLevel > oldLevel) {
      await query(
        'UPDATE user_levels SET level = $1 WHERE user_id = $2',
        [newLevel, userId]
      );
      
      const userResult = await query('SELECT username FROM users WHERE id = $1', [userId]);
      const username = userResult.rows[0]?.username || 'User';
      
      if (io) {
        const socketId = await client.get(`user:${userId}:socket`);
        if (socketId) {
          io.to(socketId).emit('user:levelUp', {
            userId,
            username,
            oldLevel,
            newLevel,
            xp,
            nextLevelXp: getXpForNextLevel(newLevel)
          });
        }
      }
      
      return { xp, level: newLevel, leveledUp: true, oldLevel };
    }
    
    return { xp, level: newLevel, leveledUp: false };
  } catch (error) {
    console.error('Error adding XP:', error);
    return null;
  }
};

const getUserLevel = async (userId) => {
  try {
    const result = await query(
      'SELECT xp, level FROM user_levels WHERE user_id = $1',
      [userId]
    );
    
    if (result.rows.length === 0) {
      await query(
        'INSERT INTO user_levels (user_id, xp, level) VALUES ($1, 0, 1)',
        [userId]
      );
      return { xp: 0, level: 1, progress: 0, nextLevelXp: getXpThreshold(2) };
    }
    
    const { xp, level } = result.rows[0];
    return {
      xp,
      level,
      progress: getLevelProgress(xp, level),
      nextLevelXp: getXpForNextLevel(level)
    };
  } catch (error) {
    console.error('Error getting user level:', error);
    return { xp: 0, level: 1, progress: 0, nextLevelXp: getXpThreshold(2) };
  }
};

const getLeaderboard = async (limit = 10) => {
  try {
    const result = await query(
      `SELECT ul.user_id, ul.xp, ul.level, u.username, u.avatar
       FROM user_levels ul
       JOIN users u ON ul.user_id = u.id
       ORDER BY ul.xp DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  } catch (error) {
    console.error('Error getting leaderboard:', error);
    return [];
  }
};

module.exports = {
  XP_REWARDS,
  calculateLevel,
  getXpForNextLevel,
  getLevelProgress,
  addXp,
  addDailyChatXp,
  getUserLevel,
  getLeaderboard
};
