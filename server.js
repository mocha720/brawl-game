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
const RESPAWN_DELAY = 3000;     // ms
const TICK_RATE = 20;           // 초당 서버 틱 수
const TICK_MS = 1000 / TICK_RATE;
const ULTIMATE_CHARGE_PER_HIT = 34; // 기본 공격이 적중할 때마다 충전되는 궁극기 게이지(%). 3회 적중 시 100% 도달

// 기본 공격(총알) 스펙
const BASIC_BULLET_RADIUS = 6;
const BASIC_BULLET_SPEED = 650;   // px/초
const BASIC_BULLET_LIFETIME = 1.5; // 초

// 궁극기(피에로) 스펙 - 기본 공격보다 크고 느리지만 대미지가 훨씬 높음
const ULTIMATE_BULLET_RADIUS = 16;
const ULTIMATE_BULLET_SPEED = 500;
const ULTIMATE_BULLET_LIFETIME = 2.0;

// ===== 캐릭터 정의 (나중에 여기에 캐릭터를 추가하면 됩니다) =====
const CHARACTERS = {
  minam: {
    id: 'minam',
    name: '미남',
    maxHp: 7000,
    basicDamage: 2200,
    ultimateDamage: 5000,
    basicName: '총 쏘기',
    ultimateName: '피에로 발사',
  },
};
const DEFAULT_CHARACTER_ID = 'minam';

// 플레이어 색상 팔레트 (랜덤 배정)
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#fd79a8'];

// ===== 게임 상태 =====
// players: { [socketId]: { id, name, x, y, angle, hp, maxHp, alive, score, color,
//                           characterId, characterName, basicDamage, ultimateDamage, ultimateCharge } }
const players = {};
// bullets: [{ id, x, y, vx, vy, ownerId, life, type, damage, radius }]
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

  // 클라이언트가 닉네임 + 캐릭터를 정한 뒤 'join' 이벤트를 보내면 플레이어 생성
  socket.on('join', (data) => {
    const spawn = randomSpawnPoint();
    const name = (data && data.name ? String(data.name) : 'Player').slice(0, 12);

    // 서버가 직접 캐릭터 스펙을 검증/적용 (클라이언트가 보낸 능력치는 절대 신뢰하지 않음)
    const requestedId = data && data.characterId;
    const character = CHARACTERS[requestedId] || CHARACTERS[DEFAULT_CHARACTER_ID];

    players[socket.id] = {
      id: socket.id,
      name,
      x: spawn.x,
      y: spawn.y,
      angle: 0,
      hp: character.maxHp,
      maxHp: character.maxHp,
      alive: true,
      score: 0,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      characterId: character.id,
      characterName: character.name,
      basicDamage: character.basicDamage,
      ultimateDamage: character.ultimateDamage,
      ultimateCharge: 0, // 0~100
    };

    // 새로 들어온 플레이어에게 초기 설정값 전달
    socket.emit('init', {
      id: socket.id,
      arena: { width: ARENA_WIDTH, height: ARENA_HEIGHT },
      playerRadius: PLAYER_RADIUS,
      bulletRadius: BASIC_BULLET_RADIUS,
      bulletRange: BASIC_BULLET_SPEED * BASIC_BULLET_LIFETIME, // 기본 공격 사거리 표시선용
      ultimateBulletRadius: ULTIMATE_BULLET_RADIUS,
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

  // 기본 공격 발사 요청
  socket.on('shoot', () => {
    const p = players[socket.id];
    if (!p || !p.alive) return;

    bulletIdCounter += 1;
    bullets.push({
      id: bulletIdCounter,
      x: p.x + Math.cos(p.angle) * (PLAYER_RADIUS + 5),
      y: p.y + Math.sin(p.angle) * (PLAYER_RADIUS + 5),
      vx: Math.cos(p.angle) * BASIC_BULLET_SPEED,
      vy: Math.sin(p.angle) * BASIC_BULLET_SPEED,
      ownerId: socket.id,
      life: BASIC_BULLET_LIFETIME,
      type: 'basic',
      damage: p.basicDamage,
      radius: BASIC_BULLET_RADIUS,
    });
  });

  // 궁극기 발사 요청 (게이지가 100%일 때만 발동)
  socket.on('ultimate', () => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    if (p.ultimateCharge < 100) return;

    bulletIdCounter += 1;
    bullets.push({
      id: bulletIdCounter,
      x: p.x + Math.cos(p.angle) * (PLAYER_RADIUS + 5),
      y: p.y + Math.sin(p.angle) * (PLAYER_RADIUS + 5),
      vx: Math.cos(p.angle) * ULTIMATE_BULLET_SPEED,
      vy: Math.sin(p.angle) * ULTIMATE_BULLET_SPEED,
      ownerId: socket.id,
      life: ULTIMATE_BULLET_LIFETIME,
      type: 'ultimate',
      damage: p.ultimateDamage,
      radius: ULTIMATE_BULLET_RADIUS,
    });

    p.ultimateCharge = 0;
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

      if (dist < PLAYER_RADIUS + b.radius) {
        hitBulletIds.add(b.id);
        p.hp -= b.damage;

        // 기본 공격이 적중하면 쏜 사람의 궁극기 게이지가 충전됨 (궁극기 자체는 충전 안 됨)
        const shooter = players[b.ownerId];
        if (shooter && b.type === 'basic') {
          shooter.ultimateCharge = Math.min(100, shooter.ultimateCharge + ULTIMATE_CHARGE_PER_HIT);
        }

        if (p.hp <= 0) {
          p.hp = 0;
          p.alive = false;

          // 처치한 플레이어 점수 증가
          if (shooter) shooter.score += 1;

          // 3초 뒤 무작위 위치에서 리스폰
          const deadId = pid;
          setTimeout(() => {
            const respawned = players[deadId];
            if (!respawned) return; // 이미 접속 해제한 경우
            const spawn = randomSpawnPoint();
            respawned.x = spawn.x;
            respawned.y = spawn.y;
            respawned.hp = respawned.maxHp;
            respawned.alive = true;
            respawned.ultimateCharge = 0;
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
