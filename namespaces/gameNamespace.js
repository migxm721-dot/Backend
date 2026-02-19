const { setSession } = require('../utils/redisUtils');
const { publishGameCommand } = require('../pubsub/pub');
const logger = require('../utils/logger');

const setupGameNamespace = (io) => {
  const gameNamespace = io.of('/game');

  gameNamespace.on('connection', (socket) => {
    const username = socket.handshake.auth?.username || 'Anonymous';
    const userId = socket.handshake.auth?.userId || 'Unknown';
    
    if (username === 'Anonymous' || userId === 'Unknown') {
      console.warn(`[Game] Rejected anonymous connection: ${socket.id}`);
      socket.emit('error', { 
        message: 'Authentication required',
        code: 'AUTH_REQUIRED'
      });
      socket.disconnect(true);
      return;
    }
    
    logger.info('GAME_CLIENT_CONNECTED', { socketId: socket.id, username, userId });

    socket.join(`user:${userId}`);

    setSession(`game:${username}`, socket.id).catch(err => {
      console.warn(`[Game] Could not set session for ${username}:`, err.message);
    });

    socket.on('game:room:join', async (data) => {
      const { roomId } = data;
      if (roomId) {
        socket.join(`game:room:${roomId}`);
        logger.info('GAME_USER_JOINED_ROOM', { username, roomId });
      }
    });

    socket.on('game:room:leave', async (data) => {
      const { roomId } = data;
      if (roomId) {
        socket.leave(`game:room:${roomId}`);
        logger.info('GAME_USER_LEFT_ROOM', { username, roomId });
      }
    });

    const forwardGameCommand = async (data) => {
      const { roomId, userId, username, message, command } = data;
      const cmd = message || command;
      
      if (!roomId || !cmd) {
        socket.emit('error', { message: 'Missing roomId or command' });
        return;
      }

      try {
        await publishGameCommand({
          roomId,
          userId,
          username,
          command: cmd,
          message: cmd,
          socketId: socket.id,
          timestamp: Date.now()
        });
      } catch (err) {
        logger.error('GAME_COMMAND_FORWARD_ERROR', err);
      }
    };

    socket.on('game:command', forwardGameCommand);
    socket.on('game:command:received', forwardGameCommand);

    socket.on('ping', () => {
      socket.emit('pong', { timestamp: Date.now() });
    });

    socket.on('error', (error) => {
      logger.error('GAME_SOCKET_ERROR', { socketId: socket.id, error: error.message });
    });
    
    socket.on('disconnect', (reason) => {
      logger.info('GAME_CLIENT_DISCONNECTED', { socketId: socket.id, username, reason });
    });
  });

  return gameNamespace;
};

module.exports = { setupGameNamespace };
