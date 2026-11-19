// Socket.IO hub. Every authenticated socket joins `user:<id>` and a role room
// (`drivers` / `admins`), so services can push events without tracking sockets.
import { Server } from 'socket.io';
import { verifyToken } from './auth.js';

let io = null;

export function initRealtime(httpServer, handlers) {
  io = new Server(httpServer, { cors: { origin: true, credentials: true } });

  io.use((socket, next) => {
    try {
      const user = verifyToken(socket.handshake.auth?.token);
      if (!user) return next(new Error('unauthorized'));
      socket.data.user = user;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join(`user:${user.id}`);
    if (user.role === 'driver') socket.join('drivers');
    if (user.role === 'admin') socket.join('admins');

    socket.on('driver:location', (p) => {
      if (user.role !== 'driver' || !p) return;
      handlers.onDriverLocation?.(user.id, p);
    });
    socket.on('chat:typing', (p) => handlers.onChatTyping?.(user, p));
    socket.on('passenger:location', (p) => {
      if (!p) return;
      handlers.onPassengerLocation?.(user.id, p);
    });
  });
  return io;
}

export const emit = {
  user(id, event, data) {
    io?.to(`user:${id}`).emit(event, data);
  },
  drivers(event, data) {
    io?.to('drivers').emit(event, data);
  },
  admins(event, data) {
    io?.to('admins').emit(event, data);
  },
};
