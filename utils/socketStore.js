let ioInstance = null;
let chatNamespace = null;
let isReady = false;

const setIo = (io) => {
  ioInstance = io;
  chatNamespace = io.of('/chat');
  isReady = true;
};

const getIo = () => ioInstance;

const getChatNamespace = () => chatNamespace;

const isSocketReady = () => isReady && chatNamespace !== null;

const getSocketRoomCount = (roomId) => {
  if (!isReady || !chatNamespace) return null;
  const roomKey = `room:${roomId}`;
  return chatNamespace.adapter.rooms.get(roomKey)?.size || 0;
};

const getSocketRoomUsers = (roomId) => {
  if (!isReady || !chatNamespace) return null;
  const roomKey = `room:${roomId}`;
  const socketIds = chatNamespace.adapter.rooms.get(roomKey);
  if (!socketIds) return [];
  
  const users = [];
  for (const sid of socketIds) {
    const socket = chatNamespace.sockets.get(sid);
    if (socket && socket.username) {
      users.push({
        id: socket.userId,
        username: socket.username,
        socketId: sid
      });
    }
  }
  return users;
};

module.exports = {
  setIo,
  getIo,
  getChatNamespace,
  isSocketReady,
  getSocketRoomCount,
  getSocketRoomUsers
};
