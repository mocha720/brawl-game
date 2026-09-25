// server.js
// 브롤스타즈 스타일 2D 탑다운 멀티플레이 슈팅 게임 - 서버

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Render 배포 환경에서는 PORT 환경변수를 사용해야 함
const PORT = process.env.PORT || 3000;

// index.html 등 정적 파일을 같은 폴더에서 서빙
app.use(express.static(path.join(__dirname)));

// ===== 게임 설정값 =====
const ARENA_WIDTH = 1000;
const ARENA_HEIGHT = 700;
const PLAYER_RADIUS = 20;
const BULLET_RADIUS = 6;
const PLAYER_MAX_HP = 100;
const BULLET_DAMAGE = 20;
const BULLET_SPEED = 650;       // px/초
const BULLET_LIFETIME = 1.5;    // 초
const RESPAWN_DELAY = 3000;     // ms
const TICK_RATE = 20;           // 초당 서버 틱 수
const TICK_MS = 1000 / TICK_RATE;

// 플레이어 색상 팔레트 (랜덤 배정)
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#fd79a8'];

// ===== 게임 상태 =====
// players: { [socketId]: { id, name, x, y, angle, hp, alive, score, color } }
const players = {};
// bullets: [{ id, x, y, vx, vy, ownerId, life }]
let bullets = [];
let bulletIdCounter = 0;

function randomSpawnPoint() {
  return {
    x: PLAYER_RADIUS + Math.random() * (ARENA_WIDTH - PLAYER_RADIUS * 2),
    y: PLAYER_RADIUS + Math.random() * (ARENA_HEIGHT - PLAYER_RADIUS * 2),
  };
}

io.on('connection', (socket) => {
  console.log(`플레이어 접속: ${socket.id}`);

  // 클라이언트가 닉네임을 정한 뒤 'join' 이벤트를 보내면 플레이어 생성
  socket.on('join', (data) => {
    const spawn = randomSpawnPoint();
    const name = (data && data.name ? String(data.name) : 'Player').slice(0, 12);

    players[socket.id] = {
      id: socket.id,
      name,
      x: spawn.x,
      y: spawn.y,
      angle: 0,
      hp: PLAYER_MAX_HP,
      alive: true,
      score: 0,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    };

    // 새로 들어온 플레이어에게 초기 설정값 전달
    socket.emit('init', {
      id: socket.id,
      arena: { width: ARENA_WIDTH, height: ARENA_HEIGHT },
      maxHp: PLAYER_MAX_HP,
      playerRadius: PLAYER_RADIUS,
      bulletRadius: BULLET_RADIUS,
      bulletRange: BULLET_SPEED * BULLET_LIFETIME, // 클라이언트가 사거리 표시선을 그릴 때 사용
    });
  });

  // 클라이언트가 매 프레임 자신의 위치/각도를 전송
  socket.on('playerUpdate', (data) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    if (typeof data.x !== 'number' || typeof data.y !== 'number') return;

    // 값 보정 (치트 방지용 최소한의 범위 제한)
    p.x = Math.max(PLAYER_RADIUS, Math.min(ARENA_WIDTH - PLAYER_RADIUS, data.x));
    p.y = Math.max(PLAYER_RADIUS, Math.min(ARENA_HEIGHT - PLAYER_RADIUS, data.y));
    if (typeof data.angle === 'number') p.angle = data.angle;
  });

  // 발사 요청
  socket.on('shoot', () => {
    const p = players[socket.id];
    if (!p || !p.alive) return;

    bulletIdCounter += 1;
    bullets.push({
      id: bulletIdCounter,
      x: p.x + Math.cos(p.angle) * (PLAYER_RADIUS + 5),
      y: p.y + Math.sin(p.angle) * (PLAYER_RADIUS + 5),
      vx: Math.cos(p.angle) * BULLET_SPEED,
      vy: Math.sin(p.angle) * BULLET_SPEED,
      ownerId: socket.id,
      life: BULLET_LIFETIME,
    });
  });

  socket.on('disconnect', () => {
    console.log(`플레이어 접속 해제: ${socket.id}`);
    delete players[socket.id];
    bullets = bullets.filter((b) => b.ownerId !== socket.id);
  });
});

// ===== 서버 게임 루프 =====
function gameLoop() {
  const dt = TICK_MS / 1000;

  // 총알 이동
  for (const b of bullets) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
  }

  // 화면 밖으로 나갔거나 수명이 다한 총알 제거
  bullets = bullets.filter(
    (b) => b.life > 0 && b.x >= 0 && b.x <= ARENA_WIDTH && b.y >= 0 && b.y <= ARENA_HEIGHT
  );

  // 총알-플레이어 충돌 판정
  const hitBulletIds = new Set();
  for (const b of bullets) {
    if (hitBulletIds.has(b.id)) continue;

    for (const pid in players) {
      const p = players[pid];
      if (!p.alive) continue;
      if (pid === b.ownerId) continue; // 자기 자신 총알은 무시

      const dx = p.x - b.x;
      const dy = p.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < PLAYER_RADIUS + BULLET_RADIUS) {
        hitBulletIds.add(b.id);
        p.hp -= BULLET_DAMAGE;

        if (p.hp <= 0) {
          p.hp = 0;
          p.alive = false;

          // 처치한 플레이어 점수 증가
          const shooter = players[b.ownerId];
          if (shooter) shooter.score += 1;

          // 3초 뒤 무작위 위치에서 리스폰
          const deadId = pid;
          setTimeout(() => {
            const respawned = players[deadId];
            if (!respawned) return; // 이미 접속 해제한 경우
            const spawn = randomSpawnPoint();
            respawned.x = spawn.x;
            respawned.y = spawn.y;
            respawned.hp = PLAYER_MAX_HP;
            respawned.alive = true;
          }, RESPAWN_DELAY);
        }
        break; // 이 총알은 이미 소모됨
      }
    }
  }

  bullets = bullets.filter((b) => !hitBulletIds.has(b.id));

  // 전체 상태를 모든 클라이언트에 브로드캐스트
  io.emit('state', { players, bullets });
}

setInterval(gameLoop, TICK_MS);

server.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});
