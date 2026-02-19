const { createClient } = require('redis');

let redisUrl;
let redisMode = 'unknown';

if (process.env.REDIS_URL) {
  // Full URL provided (e.g., redis://user:pass@host:port)
  redisUrl = process.env.REDIS_URL;
  redisMode = 'custom URL';
} else if (process.env.REDIS_HOST && process.env.REDIS_PORT) {
  const host = process.env.REDIS_HOST;
  const port = process.env.REDIS_PORT;
  const password = process.env.REDIS_PASSWORD;
  
  // Check if localhost (no password needed typically)
  const isLocalhost = host === 'localhost' || host === '127.0.0.1';
  
  if (password) {
    // Cloud Redis with password
    redisUrl = `redis://default:${password}@${host}:${port}`;
    redisMode = 'cloud';
  } else {
    // Localhost Redis without password
    redisUrl = `redis://${host}:${port}`;
    redisMode = 'localhost';
  }
} else {
  // Default to localhost:6379 (standard Redis)
  redisUrl = 'redis://localhost:6379';
  redisMode = 'localhost (default)';
  console.log('⚠️ No Redis config found, using default localhost:6379');
}

console.log(`🔌 Redis mode: ${redisMode}`);

const client = createClient({
  url: redisUrl,
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 20) {
        console.error('Redis unreachable after 20 retries');
        return new Error('Redis unreachable');
      }
      return Math.min(retries * 50, 500);
    }
  }
});

client.on('error', (err) => {
  console.error('Redis Error:', err.message);
});

client.on('connect', () => {
  console.log(`Connecting to Redis (${redisMode})...`);
});

client.on('ready', () => {
  console.log(`Redis (${redisMode}) connected and ready`);
});

client.on('reconnecting', () => {
  console.log('Redis reconnecting...');
});

const connectRedis = async () => {
  try {
    await client.connect();
    
    // Verify connection with PING/PONG
    const pong = await client.ping();
    console.log(`✅ Redis connected - PING response: ${pong}`);
    
    // Log Redis server info
    const info = await client.info('server');
    const versionMatch = info.match(/redis_version:([^\r\n]+)/);
    if (versionMatch) {
      console.log(`✅ Redis server version: ${versionMatch[1]}`);
    }
    
    return client;
  } catch (error) {
    console.error('Failed to connect to Redis:', error.message);
    throw error;
  }
};

const getRedisClient = () => {
  return client;
};

module.exports = { connectRedis, getRedisClient };