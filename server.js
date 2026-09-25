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
const EFFECT_LIFETIME = 0.4; // 번개 등 시각 이펙트가 화면에 남아있는 시간(초)

// ===== 맵 장애물(벽) =====
// x, y는 좌상단 좌표. 이동/총알 모두 벽에 막힘
const WALLS = [
  { x: 150, y: 120, width: 200, height: 30 },  // 좌상단 가로 벽
  { x: 650, y: 120, width: 200, height: 30 },  // 우상단 가로 벽
  { x: 150, y: 550, width: 200, height: 30 },  // 좌하단 가로 벽
  { x: 650, y: 550, width: 200, height: 30 },  // 우하단 가로 벽
  { x: 485, y: 300, width: 30, height: 100 },  // 중앙 세로 기둥
];

function circleIntersectsRect(cx, cy, radius, rect) {
  const closestX = Math.max(rect.x, Math.min(cx, rect.x + rect.width));
  const closestY = Math.max(rect.y, Math.min(cy, rect.y + rect.height));
  const dx = cx - closestX;
  const dy = cy - closestY;
  return (dx * dx + dy * dy) < (radius * radius);
}

function collidesWithWalls(x, y, radius) {
  return WALLS.some((w) => circleIntersectsRect(x, y, radius, w));
}

// ===== 캐릭터 정의 (나중에 여기에 캐릭터를 추가하면 됩니다) =====
const CHARACTERS = {
  minam: {
    id: 'minam',
    name: '미남',
    maxHp: 7000,
    basic: {
      name: '총 쏘기',
      damage: 2200,
      speed: 650,      // px/초
      radius: 6,
      lifetime: 1.5,   // 초
      visual: 'bullet',
    },
    ultimate: {
      name: '피에로 발사',
      type: 'projectile', // 조준한 방향으로 날아가는 궁극기
      damage: 5000,
      speed: 500,
      radius: 16,
      lifetime: 2.0,
      visual: 'clown',
    },
  },
  jigi: {
    id: 'jigi',
    name: '지기',
    maxHp: 6000,
    basic: {
      name: '던지기',
      damage: 3000,
      speed: 350,      // 총알보다 느린 구체
      radius: 12,
      lifetime: 2.2,
      visual: 'orb',
    },
    ultimate: {
      name: '벼락지기',
      type: 'lightning',   // 조준 없이 자신 주변에 번개를 떨어뜨리는 궁극기
      damage: 3000,         // 번개 한 대에 맞을 때마다 들어가는 대미지
      strikeCount: 5,        // 떨어지는 번개 개수
      strikeRadius: 60,      // 번개 한 발의 피격 반경
      areaRadius: 220,       // 번개가 떨어질 수 있는 시전자 주변 범위
    },
  },
};
const DEFAULT_CHARACTER_ID = 'minam';

// 플레이어 색상 팔레트 (랜덤 배정)
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#fd79a8'];

// ===== 게임 상태 =====
// players: { [socketId]: { id, name, x, y, angle, hp, maxHp, alive, score, color,
//                           characterId, characterName, basic, ultimate, ultimateCharge } }
const players = {};
// bullets: [{ id, x, y, vx, vy, ownerId, life, damage, radius, isUltimate, visual }]
let bullets = [];
let bulletIdCounter = 0;
// effects: [{ id, type:'lightning', x, y, radius, life }] - 순수 시각 효과(충돌 없음)
let effects = [];
let effectIdCounter = 0;

function randomSpawnPoint() {
  // 벽과 겹치지 않는 위치를 찾을 때까지 몇 번 시도
  for (let i = 0; i < 20; i++) {
    const x = PLAYER_RADIUS + Math.random() * (ARENA_WIDTH - PLAYER_RADIUS * 2);
    const y = PLAYER_RADIUS + Math.random() * (ARENA_HEIGHT - PLAYER_RADIUS * 2);
    if (!collidesWithWalls(x, y, PLAYER_RADIUS + 10)) return { x, y };
  }
  return { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
}

// 대미지 적용 + 사망/리스폰/점수 처리를 한 곳에서 관리 (총알 피격, 번개 피격이 공용으로 사용)
function applyDamage(target, damage, shooterId, { chargeShooter } = {}) {
  if (!target.alive) return;
  target.hp -= damage;

  const shooter = players[shooterId];
  if (shooter && chargeShooter) {
    shooter.ultimateCharge = Math.min(100, shooter.ultimateCharge + ULTIMATE_CHARGE_PER_HIT);
  }

  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;

    if (shooter) shooter.score += 1;

    const deadId = target.id;
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
      basic: character.basic,
      ultimate: character.ultimate,
      ultimateCharge: 0, // 0~100
    };

    // 새로 들어온 플레이어에게 초기 설정값 전달
    socket.emit('init', {
      id: socket.id,
      arena: { width: ARENA_WIDTH, height: ARENA_HEIGHT },
      playerRadius: PLAYER_RADIUS,
      walls: WALLS,
    });
  });

  // 클라이언트가 매 프레임 자신의 위치/각도를 전송
  socket.on('playerUpdate', (data) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    if (typeof data.x !== 'number' || typeof data.y !== 'number') return;

    const newX = Math.max(PLAYER_RADIUS, Math.min(ARENA_WIDTH - PLAYER_RADIUS, data.x));
    const newY = Math.max(PLAYER_RADIUS, Math.min(ARENA_HEIGHT - PLAYER_RADIUS, data.y));

    // 벽 충돌: 축별로 따로 검사해서 벽에 닿아도 옆으로는 미끄러지듯 이동 가능
    if (!collidesWithWalls(newX, p.y, PLAYER_RADIUS)) {
      p.x = newX;
    }
    if (!collidesWithWalls(p.x, newY, PLAYER_RADIUS)) {
      p.y = newY;
    }

    if (typeof data.angle === 'number') p.angle = data.angle;
  });

  // 기본 공격 발사 요청
  socket.on('shoot', () => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    const basic = p.basic;

    bulletIdCounter += 1;
    bullets.push({
      id: bulletIdCounter,
      x: p.x + Math.cos(p.angle) * (PLAYER_RADIUS + 5),
      y: p.y + Math.sin(p.angle) * (PLAYER_RADIUS + 5),
      vx: Math.cos(p.angle) * basic.speed,
      vy: Math.sin(p.angle) * basic.speed,
      ownerId: socket.id,
      life: basic.lifetime,
      damage: basic.damage,
      radius: basic.radius,
      isUltimate: false,
      visual: basic.visual,
    });
  });

  // 궁극기 발사 요청 (게이지가 100%일 때만 발동)
  socket.on('ultimate', () => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    if (p.ultimateCharge < 100) return;

    const ult = p.ultimate;

    if (ult.type === 'lightning') {
      // 자신 주변 랜덤한 위치에 번개를 여러 발 떨어뜨림 (조준 불필요)
      for (let i = 0; i < ult.strikeCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * ult.areaRadius;
        const sx = Math.max(0, Math.min(ARENA_WIDTH, p.x + Math.cos(angle) * dist));
        const sy = Math.max(0, Math.min(ARENA_HEIGHT, p.y + Math.sin(angle) * dist));

        effectIdCounter += 1;
        effects.push({ id: effectIdCounter, type: 'lightning', x: sx, y: sy, radius: ult.strikeRadius, life: EFFECT_LIFETIME });

        for (const pid in players) {
          if (pid === socket.id) continue; // 자기 자신은 맞지 않음
          const target = players[pid];
          if (!target.alive) continue;

          const ddx = target.x - sx;
          const ddy = target.y - sy;
          if (Math.sqrt(ddx * ddx + ddy * ddy) < PLAYER_RADIUS + ult.strikeRadius) {
            applyDamage(target, ult.damage, socket.id, { chargeShooter: false });
          }
        }
      }
    } else {
      // 조준한 방향으로 날아가는 궁극기 (예: 피에로 발사)
      bulletIdCounter += 1;
      bullets.push({
        id: bulletIdCounter,
        x: p.x + Math.cos(p.angle) * (PLAYER_RADIUS + 5),
        y: p.y + Math.sin(p.angle) * (PLAYER_RADIUS + 5),
        vx: Math.cos(p.angle) * ult.speed,
        vy: Math.sin(p.angle) * ult.speed,
        ownerId: socket.id,
        life: ult.lifetime,
        damage: ult.damage,
        radius: ult.radius,
        isUltimate: true,
        visual: ult.visual,
      });
    }

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

  // 화면 밖, 수명 종료, 벽 충돌한 총알 제거
  bullets = bullets.filter((b) => {
    if (b.life <= 0) return false;
    if (b.x < 0 || b.x > ARENA_WIDTH || b.y < 0 || b.y > ARENA_HEIGHT) return false;
    if (collidesWithWalls(b.x, b.y, b.radius)) return false; // 벽에 막힘
    return true;
  });

  // 총알-플레이어 충돌 판정
  const hitBulletIds = new Set();
  for (const b of bullets) {
    if (hitBulletIds.has(b.id)) continue;

    for (const pid in players) {
      const target = players[pid];
      if (!target.alive) continue;
      if (pid === b.ownerId) continue; // 자기 자신 총알은 무시

      const dx = target.x - b.x;
      const dy = target.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < PLAYER_RADIUS + b.radius) {
        hitBulletIds.add(b.id);
        // 기본 공격만 궁극기 게이지를 충전시킴
        applyDamage(target, b.damage, b.ownerId, { chargeShooter: !b.isUltimate });
        break; // 이 총알은 이미 소모됨
      }
    }
  }

  bullets = bullets.filter((b) => !hitBulletIds.has(b.id));

  // 시각 이펙트(번개 등) 수명 관리
  for (const e of effects) e.life -= dt;
  effects = effects.filter((e) => e.life > 0);

  // 전체 상태를 모든 클라이언트에 브로드캐스트
  io.emit('state', { players, bullets, effects });
}

setInterval(gameLoop, TICK_MS);

server.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});
