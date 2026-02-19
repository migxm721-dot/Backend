const logger = require('../utils/logger');
const giftService = require('../services/giftQueueService');

module.exports = (io, socket) => {
  const sendGift = async (data) => {
    try {
      const { giftName, targetUsername, roomId, isPrivate } = data;
      const fromUserId = socket.userId;
      const fromUsername = socket.username;

      if (!fromUserId || !fromUsername) {
        return socket.emit('error', { message: 'Authentication required' });
      }

      logger.info('🎁 GIFT:SEND received:', { fromUsername, targetUsername, giftName, roomId, isPrivate });

      const result = await giftService.sendGift({
        fromUserId,
        fromUsername,
        targetUsername,
        giftName,
        roomId,
        isPrivate
      }, io);

      if (!result.success) {
        if (isPrivate) {
          socket.emit('dm:error', { message: result.message });
        } else {
          socket.emit('system:message', {
            roomId,
            message: result.message,
            type: 'error'
          });
        }
      }
    } catch (error) {
      logger.error('Error in gift:send handler:', error);
      socket.emit('error', { message: 'An internal error occurred while sending gift' });
    }
  };

  socket.on('gift:send', sendGift);
};
