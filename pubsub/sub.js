const { createClient } = require('redis');
const logger = require('../utils/logger');
const { CHANNELS } = require('./pub');
const { generateMessageId } = require('../utils/idGenerator');

let subClient = null;
let io = null;

const BOT_CONFIGS = {
  lowcard: {
    username: 'LowCardBot',
    usernameColor: '#719c35',
    messageColor: '#347499'
  },
  dice: {
    username: 'DiceBot',
    usernameColor: '#e74c3c',
    messageColor: '#c0392b'
  },
  flagbot: {
    username: 'FlagBot',
    usernameColor: '#f39c12',
    messageColor: '#d68910'
  }
};

let gameIo = null;

const setGameNamespace = (gameNamespace) => {
  gameIo = gameNamespace;
};

const initSubscriber = async (socketIo) => {
  io = socketIo;
  
  // Build Redis URL - support both cloud and localhost
  let redisUrl;
  if (process.env.REDIS_URL) {
    redisUrl = process.env.REDIS_URL;
  } else if (process.env.REDIS_HOST && process.env.REDIS_PORT) {
    const host = process.env.REDIS_HOST;
    const port = process.env.REDIS_PORT;
    const password = process.env.REDIS_PASSWORD;
    redisUrl = password 
      ? `redis://default:${password}@${host}:${port}`
      : `redis://${host}:${port}`;
  } else {
    redisUrl = 'redis://localhost:6379';
  }
  
  subClient = createClient({ url: redisUrl });
  
  subClient.on('error', (err) => {
    logger.error('PUBSUB_SUBSCRIBER_ERROR', err);
  });
  
  await subClient.connect();
  
  await subClient.subscribe(CHANNELS.GAME_RESULT, handleGameResult);
  await subClient.subscribe(CHANNELS.CHAT_MESSAGE, handleChatMessage);
  await subClient.subscribe(CHANNELS.GAME_COMMAND, handleGameCommand);
  await subClient.subscribe(CHANNELS.GAME_CHAT_MESSAGE, handleGameChatMessage);
  await subClient.subscribe(CHANNELS.GAME_CREDITS_UPDATE, handleGameCreditsUpdate);
  await subClient.subscribe(CHANNELS.GAME_PRIVATE_MESSAGE, handleGamePrivateMessage);
  
  logger.info('PUBSUB_SUBSCRIBER_READY', { 
    channels: [CHANNELS.GAME_RESULT, CHANNELS.CHAT_MESSAGE, CHANNELS.GAME_COMMAND, CHANNELS.GAME_CHAT_MESSAGE, CHANNELS.GAME_CREDITS_UPDATE, CHANNELS.GAME_PRIVATE_MESSAGE] 
  });
  
  return subClient;
};

const handleGameResult = (message) => {
  try {
    const data = JSON.parse(message);
    
    switch (data.type) {
      case 'bot_message':
        emitBotMessage(data.roomId, data.botType, data.message);
        break;
        
      case 'batch_messages':
        for (const msg of data.messages) {
          emitBotMessage(data.roomId, data.botType, msg);
        }
        break;
        
      case 'game_result':
        if (data.roomId && data.message) {
          emitBotMessage(data.roomId, data.botType || 'lowcard', data.message);
        }
        break;
        
      default:
        logger.warn('PUBSUB_UNKNOWN_TYPE', { type: data.type });
    }
  } catch (err) {
    logger.error('PUBSUB_GAME_RESULT_ERROR', err);
  }
};

const handleChatMessage = (message) => {
  try {
    const data = JSON.parse(message);
    
    if (data.roomId && data.message) {
      io.to(`room:${data.roomId}`).emit('chat:message', {
        id: generateMessageId(),
        roomId: data.roomId,
        username: data.username || 'System',
        message: data.message,
        messageType: data.messageType || 'chat',
        type: data.type || 'system',
        timestamp: new Date().toISOString()
      });
    }
  } catch (err) {
    logger.error('PUBSUB_CHAT_MESSAGE_ERROR', err);
  }
};

const handleGameChatMessage = (message) => {
  try {
    const data = JSON.parse(message);
    const { roomId, messageData } = data;
    
    if (roomId && messageData) {
      if (io) {
        io.to(`room:${roomId}`).emit('chat:message', messageData);
      }
      if (gameIo) {
        gameIo.to(`game:room:${roomId}`).emit('game:bot:message', messageData);
      }
    }
  } catch (err) {
    logger.error('PUBSUB_GAME_CHAT_MESSAGE_ERROR', err);
  }
};

const handleGameCreditsUpdate = (message) => {
  try {
    const data = JSON.parse(message);
    const { roomId, userId, balance } = data;
    
    if (roomId && userId) {
      if (io) {
        io.to(`room:${roomId}`).emit('credits:updated', { userId, balance });
      }
    }
  } catch (err) {
    logger.error('PUBSUB_GAME_CREDITS_UPDATE_ERROR', err);
  }
};

const handleGamePrivateMessage = async (message) => {
  try {
    const data = JSON.parse(message);
    const { roomId, userId, messageData } = data;
    
    if (roomId && userId && messageData && io) {
      let sent = false;
      try {
        const sockets = await io.fetchSockets();
        for (const socket of sockets) {
          if (String(socket.userId) === String(userId)) {
            socket.emit('chat:message', messageData);
            sent = true;
            break;
          }
        }
      } catch (fetchErr) {
        logger.error('PUBSUB_FETCH_SOCKETS_ERROR', fetchErr);
      }
      if (!sent) {
        logger.warn('PUBSUB_PRIVATE_MSG_NO_SOCKET', { userId, roomId });
      }
    }
  } catch (err) {
    logger.error('PUBSUB_GAME_PRIVATE_MESSAGE_ERROR', err);
  }
};

const handleGameCommand = (message) => {
  try {
    const data = JSON.parse(message);
    
    if (data.roomId && data.command) {
      if (gameIo) {
        gameIo.to(`game:room:${data.roomId}`).emit('game:command:received', {
          roomId: data.roomId,
          userId: data.userId,
          username: data.username,
          command: data.command,
          timestamp: data.timestamp
        });
      }
      
      logger.info('PUBSUB_GAME_COMMAND_ROUTED', { 
        roomId: data.roomId, 
        command: data.command,
        hasGameNamespace: !!gameIo 
      });
    }
  } catch (err) {
    logger.error('PUBSUB_GAME_COMMAND_ERROR', err);
  }
};

const emitBotMessage = async (roomId, botType, message) => {
  const config = BOT_CONFIGS[botType] || BOT_CONFIGS.lowcard;
  
  const payload = {
    id: generateMessageId(),
    roomId,
    username: config.username,
    message: message,
    messageType: botType,
    type: 'bot',
    botType: botType,
    userType: 'bot',
    usernameColor: config.usernameColor,
    messageColor: config.messageColor,
    timestamp: new Date().toISOString()
  };
  
  if (io) {
    io.to(`room:${roomId}`).emit('chat:message', payload);
  }
  
  if (gameIo) {
    gameIo.to(`game:room:${roomId}`).emit('game:bot:message', payload);
  }
  
  // Save bot message to Redis backlog for reconnect sync
  try {
    const { getRedisClient } = require('../redis');
    const redis = getRedisClient();
    if (redis && redis.isOpen) {
      const msgKey = `room:messages:${roomId}`;
      await redis.lPush(msgKey, JSON.stringify(payload));
      await redis.lTrim(msgKey, 0, 199);
      await redis.expire(msgKey, 86400);
    }
  } catch (err) {
    logger.error('PUBSUB_SAVE_BACKLOG_ERROR', err);
  }
};

const getSubscriber = () => subClient;

const closeSubscriber = async () => {
  if (subClient) {
    await subClient.unsubscribe();
    await subClient.quit();
    subClient = null;
  }
};

module.exports = {
  initSubscriber,
  getSubscriber,
  closeSubscriber,
  emitBotMessage,
  setGameNamespace
};
