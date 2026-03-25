const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

// Serve game files from /public
app.use(express.static(path.join(__dirname, 'public')));

const queue = [];   // matchmaking queue  [ socket, ... ]
const rooms = {};   // active rooms       { roomId: { p1, p2 } }

io.on('connection', (socket) => {
  console.log('[+]', socket.id);

  // ── Matchmaking ──────────────────────────────────────────────
  socket.on('joinQueue', (data) => {
    socket.playerData = data || { nick: 'Unknown', elo: 1500 };
    if (!queue.find(s => s.id === socket.id)) queue.push(socket);
    socket.emit('queueStatus', { waiting: queue.length });

    if (queue.length >= 2) {
      const p1 = queue.shift(); // host → red
      const p2 = queue.shift(); // guest → blue
      const roomId = 'room_' + Date.now();

      p1.join(roomId);
      p2.join(roomId);
      rooms[roomId] = { p1: p1.id, p2: p2.id };

      p1.emit('matchFound', { role: 'red',  roomId, opponent: p2.playerData });
      p2.emit('matchFound', { role: 'blue', roomId, opponent: p1.playerData });
      console.log(`Match ${roomId}: red=${p1.id.slice(0,6)} blue=${p2.id.slice(0,6)}`);
    }
  });

  socket.on('leaveQueue', () => {
    const i = queue.findIndex(s => s.id === socket.id);
    if (i !== -1) queue.splice(i, 1);
  });

  // ── In-game relay ────────────────────────────────────────────
  // Guest → Host: guest drag position
  socket.on('playerMove', (d) => socket.to(d.roomId).emit('opponentMove', { x: d.x, y: d.y }));

  // Host → Guest: full game snapshot
  socket.on('gameState', (d) => socket.to(d.roomId).emit('gameState', d));

  // Host → Guest: game over
  socket.on('matchEnd', (d) => {
    socket.to(d.roomId).emit('matchEnd', d);
    delete rooms[d.roomId];
  });

  // ── Disconnect ───────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('[-]', socket.id);
    const i = queue.findIndex(s => s.id === socket.id);
    if (i !== -1) queue.splice(i, 1);
    for (const [rid, rm] of Object.entries(rooms)) {
      if (rm.p1 === socket.id || rm.p2 === socket.id) {
        io.to(rid).emit('opponentLeft');
        delete rooms[rid];
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🏒  Hockey server → port ${PORT}`));
