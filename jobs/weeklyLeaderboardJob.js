const { query } = require('../db/db');
const { getRedisClient } = require('../redis');

const WEEKLY_JOB_LOCK_KEY = 'leaderboard:weekly:lock';
const WEEKLY_WINNERS_CACHE_KEY = 'leaderboard:weekly:winners';
const LOCK_TTL = 60;
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

function toWIB(date) {
  return new Date(date.getTime() + WIB_OFFSET_MS + date.getTimezoneOffset() * 60 * 1000);
}

function fromWIB(wibDate) {
  return new Date(wibDate.getTime() - WIB_OFFSET_MS);
}

function getLastMondayAndSunday() {
  const now = new Date();
  const wibNow = toWIB(now);
  
  const dayOfWeek = wibNow.getUTCDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  
  const lastMonday = new Date(wibNow);
  lastMonday.setUTCDate(wibNow.getUTCDate() - daysSinceMonday - 7);
  lastMonday.setUTCHours(0, 0, 0, 0);
  
  const lastSunday = new Date(lastMonday);
  lastSunday.setUTCDate(lastMonday.getUTCDate() + 6);
  lastSunday.setUTCHours(23, 59, 59, 999);
  
  return { weekStart: fromWIB(lastMonday), weekEnd: fromWIB(lastSunday) };
}

function getCurrentWeekBoundaries() {
  const now = new Date();
  const wibNow = toWIB(now);
  
  const dayOfWeek = wibNow.getUTCDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  
  const monday = new Date(wibNow);
  monday.setUTCDate(wibNow.getUTCDate() - daysSinceMonday);
  monday.setUTCHours(0, 0, 0, 0);
  
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);
  
  return { weekStart: fromWIB(monday), weekEnd: fromWIB(sunday) };
}

async function calculateWeeklyWinners(weekStart, weekEnd) {
  const topGamer = await query(
    `SELECT u.id, u.username, COALESCE(SUM(gh.bet_amount), 0) as total_value
     FROM users u
     LEFT JOIN game_history gh ON u.id = gh.user_id
       AND gh.created_at >= $1 AND gh.created_at <= $2
     WHERE u.is_active = true AND u.role = 'user'
     GROUP BY u.id, u.username
     HAVING COALESCE(SUM(gh.bet_amount), 0) > 0
     ORDER BY total_value DESC
     LIMIT 1`,
    [weekStart, weekEnd]
  );

  const topGet = await query(
    `SELECT u.id, u.username, COALESCE(SUM(gh.reward_amount), 0) as total_value
     FROM users u
     LEFT JOIN game_history gh ON u.id = gh.user_id
       AND gh.created_at >= $1 AND gh.created_at <= $2
       AND gh.result = 'win'
     WHERE u.is_active = true AND u.role = 'user'
     GROUP BY u.id, u.username
     HAVING COALESCE(SUM(gh.reward_amount), 0) > 0
     ORDER BY total_value DESC
     LIMIT 1`,
    [weekStart, weekEnd]
  );

  return {
    top_gamer: topGamer.rows[0] || null,
    top_get: topGet.rows[0] || null
  };
}

async function saveWeeklyWinners(weekStart, weekEnd, winners) {
  const weekStartStr = weekStart.toISOString().split('T')[0];
  const weekEndStr = weekEnd.toISOString().split('T')[0];
  
  for (const [category, winner] of Object.entries(winners)) {
    if (!winner) continue;
    
    await query(
      `INSERT INTO weekly_leaderboard_winners 
       (week_start, week_end, category, winner_user_id, winner_username, total_value, reward_granted, reward_granted_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW())
       ON CONFLICT (week_start, category) 
       DO UPDATE SET winner_user_id = $4, winner_username = $5, total_value = $6, reward_granted = TRUE, reward_granted_at = NOW()`,
      [weekStartStr, weekEndStr, category, winner.id, winner.username, winner.total_value]
    );
    
    console.log(`[WeeklyLeaderboard] ${category} winner: ${winner.username} with ${winner.total_value} COINS`);
  }
}

async function getActiveWeeklyWinners() {
  const { weekStart: lastWeekStart } = getLastMondayAndSunday();
  const lastWeekStartStr = lastWeekStart.toISOString().split('T')[0];
  
  const result = await query(
    `SELECT category, winner_user_id, winner_username, total_value, week_start, week_end
     FROM weekly_leaderboard_winners
     WHERE reward_granted = TRUE
       AND week_start = $1
     ORDER BY category`,
    [lastWeekStartStr]
  );
  
  const winners = {};
  for (const row of result.rows) {
    if (!winners[row.category]) {
      winners[row.category] = {
        user_id: row.winner_user_id,
        username: row.winner_username,
        total_value: parseInt(row.total_value),
        week_start: row.week_start,
        week_end: row.week_end
      };
    }
  }
  
  return winners;
}

async function cacheWeeklyWinners() {
  const redis = getRedisClient();
  const winners = await getActiveWeeklyWinners();
  await redis.set(WEEKLY_WINNERS_CACHE_KEY, JSON.stringify(winners), { EX: 3600 });
  return winners;
}

async function getCachedWeeklyWinners() {
  const redis = getRedisClient();
  try {
    const cached = await redis.get(WEEKLY_WINNERS_CACHE_KEY);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (error) {
    console.error('[WeeklyLeaderboard] Cache read error:', error);
  }
  return await cacheWeeklyWinners();
}

async function runWeeklyLeaderboardJob() {
  const redis = getRedisClient();
  
  try {
    const lockAcquired = await redis.set(WEEKLY_JOB_LOCK_KEY, '1', { NX: true, EX: LOCK_TTL });
    if (!lockAcquired) {
      console.log('[WeeklyLeaderboard] Job already running, skipping...');
      return;
    }
    
    console.log('[WeeklyLeaderboard] Starting weekly leaderboard job...');
    
    const { weekStart, weekEnd } = getLastMondayAndSunday();
    const weekStartStr = weekStart.toISOString().split('T')[0];
    
    const existing = await query(
      `SELECT id FROM weekly_leaderboard_winners WHERE week_start = $1 LIMIT 1`,
      [weekStartStr]
    );
    
    if (existing.rows.length > 0) {
      console.log('[WeeklyLeaderboard] Winners for last week already recorded, refreshing cache...');
      await cacheWeeklyWinners();
      await redis.del(WEEKLY_JOB_LOCK_KEY);
      return;
    }
    
    const winners = await calculateWeeklyWinners(weekStart, weekEnd);
    await saveWeeklyWinners(weekStart, weekEnd, winners);
    await cacheWeeklyWinners();
    
    console.log('[WeeklyLeaderboard] Weekly leaderboard job completed successfully');
    
    await redis.del(WEEKLY_JOB_LOCK_KEY);
  } catch (error) {
    console.error('[WeeklyLeaderboard] Job error:', error);
    try {
      await redis.del(WEEKLY_JOB_LOCK_KEY);
    } catch (e) {}
  }
}

function isMonday7AM() {
  const now = new Date();
  const wibNow = toWIB(now);
  return wibNow.getUTCDay() === 1 && wibNow.getUTCHours() === 7;
}

async function checkAndBackfillLastWeek() {
  try {
    const { weekStart } = getLastMondayAndSunday();
    const weekStartStr = weekStart.toISOString().split('T')[0];
    
    const existing = await query(
      `SELECT id FROM weekly_leaderboard_winners WHERE week_start = $1 LIMIT 1`,
      [weekStartStr]
    );
    
    if (existing.rows.length === 0) {
      console.log('[WeeklyLeaderboard] No winners for last week, running backfill...');
      await runWeeklyLeaderboardJob();
    }
  } catch (error) {
    console.error('[WeeklyLeaderboard] Backfill check error:', error);
  }
}

let jobStarted = false;
let lastJobRun = null;

function startWeeklyLeaderboardJob() {
  if (jobStarted) return;
  jobStarted = true;
  
  console.log('[WeeklyLeaderboard] Starting weekly leaderboard job scheduler (runs every Monday 7 AM WIB)');
  
  setTimeout(async () => {
    await cacheWeeklyWinners();
    console.log('[WeeklyLeaderboard] Initial cache populated');
    await checkAndBackfillLastWeek();
  }, 10000);
  
  setInterval(async () => {
    if (isMonday7AM()) {
      const now = new Date();
      const wibNow = toWIB(now);
      const today = wibNow.toISOString().split('T')[0];
      
      if (lastJobRun !== today) {
        lastJobRun = today;
        await runWeeklyLeaderboardJob();
      }
    }
  }, 60000);
}

module.exports = {
  startWeeklyLeaderboardJob,
  runWeeklyLeaderboardJob,
  getActiveWeeklyWinners,
  getCachedWeeklyWinners,
  getCurrentWeekBoundaries
};
