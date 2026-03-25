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

app.use(express.static(path.join(__dirname, 'public')));

const queue = [];
const rooms = {};

// ── Физика (константы совпадают с клиентом) ──────────────────────────
const BW=800, BH=480;
const RINK={x:68,y:43,w:664,h:394};
const GH = Math.round(RINK.h * 0.24);
const GY  = RINK.y + RINK.h/2 - GH/2;
const PR=36, PKTR=18;
const SPMAX=7;
const FRIC=0.87;
const CENTER_X = BW / 2;
const TICK = 1000/60; // 60 fps

function resetPos(){
  return {
    red:  {x:RINK.x+RINK.w*0.22, y:BH/2, vx:0, vy:0, r:PR},
    blue: {x:RINK.x+RINK.w*0.78, y:BH/2, vx:0, vy:0, r:PR},
    puck: {x:BW/2, y:BH/2, vx:(Math.random()-0.5)*2.5, vy:(Math.random()-0.5)*2.5, r:PKTR},
    sRed:0, sBlue:0
  };
}

function clampPlayer(pl, isRed){
  // Зажать в свою половину
  if(isRed){
    if(pl.x+pl.r > CENTER_X){ pl.x=CENTER_X-pl.r; pl.vx=0; }
    if(pl.x-pl.r < RINK.x)  { pl.x=RINK.x+pl.r;  pl.vx*=-0.3; }
  } else {
    if(pl.x-pl.r < CENTER_X){ pl.x=CENTER_X+pl.r; pl.vx=0; }
    if(pl.x+pl.r > RINK.x+RINK.w){ pl.x=RINK.x+RINK.w-pl.r; pl.vx*=-0.3; }
  }
  if(pl.y-pl.r < RINK.y)      { pl.y=RINK.y+pl.r;       pl.vy*=-0.3; }
  if(pl.y+pl.r > RINK.y+RINK.h){ pl.y=RINK.y+RINK.h-pl.r; pl.vy*=-0.3; }
  const s=Math.hypot(pl.vx,pl.vy);
  if(s>SPMAX){pl.vx=pl.vx/s*SPMAX;pl.vy=pl.vy/s*SPMAX;}
}

function movePlayer(pl){
  pl.x+=pl.vx; pl.y+=pl.vy;
  pl.vx*=FRIC; pl.vy*=FRIC;
}

function collidePP(red, blue){
  const dx=blue.x-red.x,dy=blue.y-red.y;
  const d=Math.hypot(dx,dy),mn=red.r+blue.r;
  if(d<mn&&d>0){
    const nx=dx/d,ny=dy/d,ov=(mn-d)/2;
    red.x-=nx*ov;red.y-=ny*ov;
    blue.x+=nx*ov;blue.y+=ny*ov;
    const rel=(red.vx-blue.vx)*nx+(red.vy-blue.vy)*ny;
    if(rel>0){
      red.vx-=rel*nx*0.65;red.vy-=rel*ny*0.65;
      blue.vx+=rel*nx*0.65;blue.vy+=rel*ny*0.65;
    }
  }
}

function movePuck(state){
  const {red,blue,puck} = state;
  let hitSound = false;
  for(const pl of [red,blue]){
    const dx=puck.x-pl.x,dy=puck.y-pl.y;
    const d=Math.hypot(dx,dy),mn=pl.r+puck.r;
    if(d<mn&&d>0){
      const nx=dx/d,ny=dy/d;
      puck.x=pl.x+nx*mn; puck.y=pl.y+ny*mn;
      const relVx=pl.vx-puck.vx, relVy=pl.vy-puck.vy;
      const impulse=(relVx*nx+relVy*ny)*2.6;
      if(impulse>0){
        puck.vx+=nx*impulse;
        puck.vy+=ny*impulse;
        hitSound = true;
      }
      const ps=Math.hypot(puck.vx,puck.vy);
      if(ps<3.5){puck.vx=nx*3.5;puck.vy=ny*3.5;}
      if(ps>18){puck.vx=puck.vx/ps*18;puck.vy=puck.vy/ps*18;}
    }
  }
  puck.x+=puck.vx; puck.y+=puck.vy;
  puck.vx*=0.991; puck.vy*=0.991;

  if(puck.y-puck.r<RINK.y){puck.y=RINK.y+puck.r;puck.vy=Math.abs(puck.vy)*0.82;}
  if(puck.y+puck.r>RINK.y+RINK.h){puck.y=RINK.y+RINK.h-puck.r;puck.vy=-Math.abs(puck.vy)*0.82;}

  if(puck.x-puck.r < RINK.x){
    if(puck.y+puck.r > GY && puck.y-puck.r < GY+GH){ return 'blue'; }
    puck.x=RINK.x+puck.r;
    puck.vx=Math.abs(puck.vx)*0.82;
  }
  if(puck.x+puck.r > RINK.x+RINK.w){
    if(puck.y+puck.r > GY && puck.y-puck.r < GY+GH){ return 'red'; }
    puck.x=RINK.x+RINK.w-puck.r;
    puck.vx=-Math.abs(puck.vx)*0.82;
  }
  return hitSound ? 'hit' : null;
}

function tickRoom(roomId){
  const room = rooms[roomId];
  if(!room || !room.running) return;

  const s = room.state;

  // Применяем цель от красного
  if(room.redTarget){
    const dx = room.redTarget.x - s.red.x;
    const dy = room.redTarget.y - s.red.y;
    s.red.vx = dx;
    s.red.vy = dy;
    s.red.x = room.redTarget.x;
    s.red.y = room.redTarget.y;
  } else {
    movePlayer(s.red);
  }

  // Применяем цель от синего
  if(room.blueTarget){
    const dx = room.blueTarget.x - s.blue.x;
    const dy = room.blueTarget.y - s.blue.y;
    s.blue.vx = dx;
    s.blue.vy = dy;
    s.blue.x = room.blueTarget.x;
    s.blue.y = room.blueTarget.y;
  } else {
    movePlayer(s.blue);
  }

  clampPlayer(s.red, true);
  clampPlayer(s.blue, false);
  collidePP(s.red, s.blue);
  const result = movePuck(s);

  if(result === 'red'){
    s.sRed++;
    if(s.sRed >= room.scoreLimit){
      room.running = false;
      const delta = Math.floor(15+Math.random()*10);
      io.to(roomId).emit('matchEnd', { winner:'red', deltaRed: delta, deltaBlue: -delta });
      delete rooms[roomId];
      return;
    }
    Object.assign(s, { ...resetPos(), sRed: s.sRed, sBlue: s.sBlue });
    io.to(roomId).emit('goal', { scorer:'red', sRed:s.sRed, sBlue:s.sBlue });
  } else if(result === 'blue'){
    s.sBlue++;
    if(s.sBlue >= room.scoreLimit){
      room.running = false;
      const delta = Math.floor(15+Math.random()*10);
      io.to(roomId).emit('matchEnd', { winner:'blue', deltaRed: -delta, deltaBlue: delta });
      delete rooms[roomId];
      return;
    }
    Object.assign(s, { ...resetPos(), sRed: s.sRed, sBlue: s.sBlue });
    io.to(roomId).emit('goal', { scorer:'blue', sRed:s.sRed, sBlue:s.sBlue });
  } else if(result === 'hit'){
    io.to(roomId).emit('playHit');
  }

  // Рассылаем состояние всем
  io.to(roomId).emit('gameState', {
    puck: { x:s.puck.x, y:s.puck.y, vx:s.puck.vx, vy:s.puck.vy },
    red:  { x:s.red.x,  y:s.red.y  },
    blue: { x:s.blue.x, y:s.blue.y },
    sRed: s.sRed, sBlue: s.sBlue
  });
}

// ── ELO таблица ─────────────────────────────────────────────────────
const eloTable = {};
// k1ro — 3к эло
eloTable['k1ro'] = 3000;

io.on('connection', (socket) => {
  console.log('[+]', socket.id);

  socket.on('joinQueue', (data) => {
    socket.playerData = data || { nick: 'Unknown', elo: 1500 };
    // Если ник в eloTable — подменяем эло для отображения соперника
    if(eloTable[socket.playerData.nick]){
      socket.playerData.elo = eloTable[socket.playerData.nick];
    }
    if (!queue.find(s => s.id === socket.id)) queue.push(socket);
    socket.emit('queueStatus', { waiting: queue.length });

    if (queue.length >= 2) {
      const p1 = queue.shift();
      const p2 = queue.shift();
      const roomId = 'room_' + Date.now();

      p1.join(roomId);
      p2.join(roomId);

      const state = resetPos();
      rooms[roomId] = {
        p1: p1.id,
        p2: p2.id,
        state,
        running: true,
        redTarget: null,
        blueTarget: null,
        scoreLimit: 5,
        interval: setInterval(() => tickRoom(roomId), TICK)
      };

      p1.emit('matchFound', { role: 'red',  roomId, opponent: p2.playerData });
      p2.emit('matchFound', { role: 'blue', roomId, opponent: p1.playerData });
      console.log(`Match ${roomId}: red=${p1.id.slice(0,6)} blue=${p2.id.slice(0,6)}`);
    }
  });

  socket.on('leaveQueue', () => {
    const i = queue.findIndex(s => s.id === socket.id);
    if (i !== -1) queue.splice(i, 1);
  });

  // Оба игрока шлют свою позицию
  socket.on('playerMove', (d) => {
    const room = rooms[d.roomId];
    if(!room) return;
    if(socket.id === room.p1) room.redTarget  = { x: d.x, y: d.y };
    else if(socket.id === room.p2) room.blueTarget = { x: d.x, y: d.y };
  });

  socket.on('playerRelease', (d) => {
    const room = rooms[d.roomId];
    if(!room) return;
    if(socket.id === room.p1) room.redTarget = null;
    else if(socket.id === room.p2) room.blueTarget = null;
  });

  socket.on('setScoreLimit', (d) => {
    const room = rooms[d.roomId];
    if(room) room.scoreLimit = d.limit || 5;
  });

  socket.on('disconnect', () => {
    console.log('[-]', socket.id);
    const i = queue.findIndex(s => s.id === socket.id);
    if (i !== -1) queue.splice(i, 1);
    for (const [rid, rm] of Object.entries(rooms)) {
      if (rm.p1 === socket.id || rm.p2 === socket.id) {
        clearInterval(rm.interval);
        io.to(rid).emit('opponentLeft');
        delete rooms[rid];
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🏒  Hockey server → port ${PORT}`));
