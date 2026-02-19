/**
 * Step 3️⃣: Server-side presence cleanup job
 * Runs every 60 seconds to detect expired TTL keys
 * Notifies clients when their presence has expired
 */

const { getRedisClient } = require('../redis');
const { getRoomUsersFromTTL, getActiveRooms } = require('../utils/roomPresenceTTL');

let cleanupInterval = null;

/**
 * Start the cleanup job
 */
const syncRoomParticipants = async (chatNs) => {
  try {
    const client = getRedisClient();
    const adapter = chatNs.adapter;
    if (!adapter || !adapter.rooms) return;

    const syncedRooms = new Set();

    for (const [roomKey, socketIds] of adapter.rooms) {
      const roomMatch = roomKey.match(/^room:(\d+)$/);
      if (!roomMatch) continue;
      const roomId = roomMatch[1];
      syncedRooms.add(roomId);
      
      const connectedUsernames = new Set();
      for (const sid of socketIds) {
        const socket = chatNs.sockets?.get(sid);
        if (socket && socket.username) {
          connectedUsernames.add(socket.username);
        }
      }

      const participantKey = `room:${roomId}:participants`;
      const redisParticipants = await client.sMembers(participantKey);
      
      const staleUsers = redisParticipants.filter(u => !connectedUsernames.has(u));
      if (staleUsers.length > 0) {
        for (const staleUser of staleUsers) {
          await client.sRem(participantKey, staleUser);
        }
        console.log(`🧹 [ParticipantSync] Room ${roomId}: removed ${staleUsers.length} stale: ${staleUsers.join(', ')}`);
      }
      
      const missingUsers = [...connectedUsernames].filter(u => !redisParticipants.includes(u));
      if (missingUsers.length > 0) {
        for (const missingUser of missingUsers) {
          await client.sAdd(participantKey, missingUser);
        }
        console.log(`🔧 [ParticipantSync] Room ${roomId}: added ${missingUsers.length} missing: ${missingUsers.join(', ')}`);
      }

      const socketCount = socketIds.size;
      chatNs.emit('room:count:update', { roomId: parseInt(roomId), userCount: socketCount });
      chatNs.emit('rooms:updateCount', { roomId: parseInt(roomId), userCount: socketCount });
    }

    const activeRoomIds = await getActiveRooms();
    for (const roomId of activeRoomIds) {
      if (syncedRooms.has(String(roomId))) continue;
      const participantKey = `room:${roomId}:participants`;
      const count = await client.sCard(participantKey);
      if (count > 0) {
        await client.del(participantKey);
        console.log(`🧹 [ParticipantSync] Room ${roomId}: cleared ${count} orphaned participants (no socket room)`);
        chatNs.emit('room:count:update', { roomId: parseInt(roomId), userCount: 0 });
        chatNs.emit('rooms:updateCount', { roomId: parseInt(roomId), userCount: 0 });
      }
    }
  } catch (error) {
    console.error('❌ Error in participant sync:', error.message);
  }
};

const startPresenceCleanup = (io) => {
  if (cleanupInterval) {
    console.log('⚠️  Presence cleanup already running');
    return;
  }

  const chatNs = io.of ? io.of('/chat') : io;

  cleanupInterval = setInterval(async () => {
    try {
      const client = getRedisClient();
      const activeRooms = await getActiveRooms();

      for (const roomId of activeRooms) {
        const pattern = `room:${roomId}:user:*`;
        const keys = await client.keys(pattern);

        for (const key of keys) {
          const exists = await client.exists(key);
          
          if (exists === 0) {
            const match = key.match(/room:(\d+):user:(\d+)/);
            if (match) {
              const expiredRoomId = match[1];
              const expiredUserId = match[2];
              
              console.log(`⏱️  Detected expired presence: room ${expiredRoomId}, userId ${expiredUserId}`);
              
              const socketsInRoom = await chatNs.in(`room:${expiredRoomId}`).fetchSockets();
              for (const socket of socketsInRoom) {
                if (socket.userId === parseInt(expiredUserId)) {
                  socket.emit('room:force-leave', {
                    message: 'You have been logged out due to inactivity (6+ hours without activity)',
                    reason: 'inactivity_timeout',
                    timestamp: Date.now()
                  });
                  
                  console.log(`📤 Sent force-leave to socket ${socket.id} (userId: ${expiredUserId})`);
                  
                  setTimeout(() => {
                    socket.disconnect(true);
                  }, 1000);
                }
              }
            }
          }
        }
      }

      await syncRoomParticipants(chatNs);

    } catch (error) {
      console.error('❌ Error in presence cleanup job:', error.message);
    }
  }, 60000); // Run every 60 seconds

  console.log('✅ Started presence cleanup job (interval: 60s)');
};

/**
 * Stop the cleanup job
 */
const stopPresenceCleanup = () => {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log('🛑 Stopped presence cleanup job');
  }
};

module.exports = {
  startPresenceCleanup,
  stopPresenceCleanup
};
