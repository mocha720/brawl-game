// server.js
// 브롤스타즈 스타일 2D 탑다운 매칭 슈팅 게임 - 서버 (1:1 / 2:2 지원)

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

// ===== 매칭 모드 설정 =====
// size: 매치를 시작하는 데 필요한 총 인원, teamSize: 한 팀의 인원 수
// winScore: 팀 누적 킬 수가 이 값에 도달하면 그 팀이 승리 (1:1은 사실상 개인 킬 수와 동일)
const MODES = {
  '1v1': { size: 2, teamSize: 1, winScore: 5 },
  '2v2': { size: 4, teamSize: 2, winScore: 8 },
};
const MATCH_CLEANUP_DELAY_MS = 600; // 승리 판정 후 마지막 상태를 한 번 더 보낸 뒤 방을 정리하기까지의 지연
const FRIENDLY_FIRE = false; // 같은 팀끼리는 서로 피해를 주지 않음 (총알은 아군을 그대로 통과)

// ===== 탄창 / 연사 방지 =====
const MAX_AMMO = 3;              // 모든 캐릭터 공통 탄창 크기
const FIRE_COOLDOWN_MS = 350;    // 한 발 쏜 뒤 다음 발사까지 최소 대기시간 (연사 방지)
const AMMO_REGEN_SECONDS = 1.8;  // 탄약 1발이 다시 채워지는 데 걸리는 시간

// ===== 무피격 체력 회복 =====
const HP_REGEN_DELAY_MS = 4000;      // 마지막으로 피격당한 후 이 시간이 지나야 회복 시작
const HP_REGEN_PERCENT_PER_SEC = 0.04; // 초당 최대 체력의 4%씩 회복

// ===== 채팅 =====
const CHAT_MAX_LENGTH = 120;      // 메시지 최대 글자 수
const CHAT_COOLDOWN_MS = 700;     // 도배 방지용 최소 발화 간격

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
      damage: 1540,    // 기존 2200에서 공격력 30% 감소
      speed: 650,      // px/초
      radius: 6,
      lifetime: 1.5,   // 초
      visual: 'bullet',
    },
    ultimate: {
      name: '피에로 발사',
      type: 'projectile', // 조준한 방향으로 날아가는 궁극기
      damage: 3500,    // 기존 5000에서 공격력 30% 감소
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
      damage: 2100,    // 기존 3000에서 공격력 30% 감소
      speed: 350,      // 총알보다 느린 구체
      radius: 12,
      lifetime: 2.2,
      visual: 'orb',
    },
    ultimate: {
      name: '벼락지기',
      type: 'lightning',   // 조준 없이 자신 주변에 번개를 떨어뜨리는 궁극기
      damage: 2100,    // 기존 3000에서 공격력 30% 감소 (번개 한 대당 대미지)
      strikeCount: 5,        // 떨어지는 번개 개수
      strikeRadius: 60,      // 번개 한 발의 피격 반경
      areaRadius: 220,       // 번개가 떨어질 수 있는 시전자 주변 범위
    },
  },
  syu: {
    id: 'syu',
    name: '슈',
    maxHp: 6000, // 체력이 별도로 지정되지 않아 다른 캐릭터와 비슷한 수준으로 설정 (조정 가능)
    basic: {
      name: '샷건 발사',
      damage: 300,        // 펠릿(총알) 1개당 대미지
      speed: 700,
      radius: 4,
      lifetime: 0.4,       // 사거리 ≈ 280px (샷건이라 사거리가 짧음)
      visual: 'bullet',
      pelletCount: 10,     // 한 번에 나가는 총알 개수
      spreadDegrees: 30,   // 전체 탄퍼짐 각도
    },
    ultimate: {
      name: '메가 샷건',
      type: 'projectile',  // 조준한 방향으로 발사되는 궁극기
      damage: 600,         // 큰 총알 1개당 대미지
      speed: 550,
      radius: 12,
      lifetime: 0.35,       // 사거리 ≈ 193px (기본 공격보다도 더 짧음)
      visual: 'slug',
      pelletCount: 10,      // 큰 총알 10발
      spreadDegrees: 30,
    },
  },
};
const DEFAULT_CHARACTER_ID = 'minam';

// 플레이어 색상 팔레트 (랜덤 배정)
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#fd79a8'];

// ===== 매칭 대기열 / 매치 상태 =====
// queues: { '1v1': [...], '2v2': [...] } - 모드별 대기열. 각 항목은 { socket, name, characterId }
const queues = {};
for (const mode in MODES) queues[mode] = [];

// matches: { [matchId]: matchState } - 진행 중인 매치들. 매치끼리는 서로 상태를 절대 공유하지 않음
const matches = {};
let matchIdCounter = 0;
// socketToMatch: { [socketId]: matchId } - 이 소켓이 현재 어느 매치에 속해 있는지
const socketToMatch = {};

let bulletIdCounter = 0;
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

function buildPlayer(socketId, name, characterId, team, spawn) {
  const character = CHARACTERS[characterId] || CHARACTERS[DEFAULT_CHARACTER_ID];
  return {
    id: socketId,
    name,
    team, // 'A' 또는 'B'
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
    ammo: MAX_AMMO,
    maxAmmo: MAX_AMMO,
    ammoRegenElapsed: 0,
    lastShotAt: 0,
    lastDamageAt: Date.now(),
  };
}

// 대미지 적용 + 사망/리스폰/점수/승리 판정을 한 곳에서 관리 (총알 피격, 번개 피격이 공용으로 사용)
// match: 이 대미지가 발생한 매치. 다른 매치의 상태에는 절대 영향을 주지 않는다.
// 아군 피해 여부는 호출하는 쪽(총알 충돌 / 번개 판정)에서 이미 걸러서 넘겨준다.
function applyDamage(match, target, damage, shooterId, { chargeShooter } = {}) {
  if (!target.alive || match.over) return;
  target.hp -= damage;
  target.lastDamageAt = Date.now(); // 무피격 회복 타이머 초기화

  const shooter = match.players[shooterId];
  if (shooter && chargeShooter) {
    shooter.ultimateCharge = Math.min(100, shooter.ultimateCharge + ULTIMATE_CHARGE_PER_HIT);
  }

  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;

    if (shooter) {
      shooter.score += 1;
      match.teamScore[shooter.team] += 1;
    }

    // 먼저 팀 누적 킬 수가 승리 점수에 도달하면 즉시 매치 종료 (1:1은 곧 개인 킬 수와 동일)
    if (shooter && match.teamScore[shooter.team] >= match.winScore) {
      match.over = true;
      io.to(match.id).emit('matchOver', {
        reason: 'scoreLimit',
        winnerTeam: shooter.team,
        teamScore: match.teamScore,
      });
      setTimeout(() => endMatch(match.id), MATCH_CLEANUP_DELAY_MS);
      return;
    }

    const deadId = target.id;
    setTimeout(() => {
      const m = matches[match.id];
      if (!m || m.over) return; // 이미 매치가 끝났거나 정리된 경우
      const respawned = m.players[deadId];
      if (!respawned) return; // 이미 접속 해제한 경우
      const spawn = randomSpawnPoint();
      respawned.x = spawn.x;
      respawned.y = spawn.y;
      respawned.hp = respawned.maxHp;
      respawned.alive = true;
      respawned.ultimateCharge = 0;
      respawned.ammo = MAX_AMMO;
      respawned.ammoRegenElapsed = 0;
      respawned.lastDamageAt = Date.now();
    }, RESPAWN_DELAY);
  }
}

// 총알(들)을 생성한다. spec.pelletCount가 있으면 spec.spreadDegrees 각도 안에 고르게 퍼뜨려서 여러 발을 동시에 발사한다.
// (예: 슈의 샷건 - 탄창/쿨다운은 소비 1회로 취급되고, 여기서는 실제 총알 개체만 만든다)
function spawnProjectiles(match, p, spec, isUltimate) {
  const pelletCount = spec.pelletCount || 1;
  const spreadRad = ((spec.spreadDegrees || 0) * Math.PI) / 180;
  const halfSpread = spreadRad / 2;

  for (let i = 0; i < pelletCount; i++) {
    const angleOffset = pelletCount > 1 ? -halfSpread + (spreadRad * i) / (pelletCount - 1) : 0;
    const angle = p.angle + angleOffset;

    bulletIdCounter += 1;
    match.bullets.push({
      id: bulletIdCounter,
      x: p.x + Math.cos(angle) * (PLAYER_RADIUS + 5),
      y: p.y + Math.sin(angle) * (PLAYER_RADIUS + 5),
      vx: Math.cos(angle) * spec.speed,
      vy: Math.sin(angle) * spec.speed,
      ownerId: p.id,
      life: spec.lifetime,
      damage: spec.damage,
      radius: spec.radius,
      isUltimate,
      visual: spec.visual,
    });
  }
}

// ===== 매칭 로직 =====
// 특정 모드의 대기열에 필요한 인원이 모이면 앞에서부터 묶어 매치를 시작한다
function tryMatchmaking(mode) {
  const cfg = MODES[mode];
  queues[mode] = queues[mode].filter((q) => q.socket.connected);

  while (queues[mode].length >= cfg.size) {
    const entries = queues[mode].splice(0, cfg.size);
    startMatch(mode, entries);
  }
}

function startMatch(mode, entries) {
  const cfg = MODES[mode];
  matchIdCounter += 1;
  const matchId = `match_${matchIdCounter}`;

  entries.forEach((e) => {
    e.socket.join(matchId);
    socketToMatch[e.socket.id] = matchId;
  });

  const match = {
    id: matchId,
    mode,
    players: {},
    bullets: [],
    effects: [],
    teamScore: { A: 0, B: 0 },
    winScore: cfg.winScore,
    over: false,
  };
  matches[matchId] = match;

  // 대기열에 들어온 순서대로 앞쪽 teamSize명은 A팀, 나머지는 B팀으로 배정
  entries.forEach((e, idx) => {
    const team = idx < cfg.teamSize ? 'A' : 'B';
    match.players[e.socket.id] = buildPlayer(e.socket.id, e.name, e.characterId, team, randomSpawnPoint());
  });

  entries.forEach((e) => {
    const self = match.players[e.socket.id];
    const teammateNames = Object.values(match.players)
      .filter((p) => p.team === self.team && p.id !== self.id)
      .map((p) => p.name);
    const opponentNames = Object.values(match.players)
      .filter((p) => p.team !== self.team)
      .map((p) => p.name);

    e.socket.emit('matchFound', {
      id: e.socket.id,
      mode,
      team: self.team,
      arena: { width: ARENA_WIDTH, height: ARENA_HEIGHT },
      playerRadius: PLAYER_RADIUS,
      walls: WALLS,
      winScore: cfg.winScore,
      teammateNames,
      opponentNames,
    });
  });
}

// 모든 모드의 대기열에서 해당 소켓을 제거
function leaveQueue(socketId) {
  for (const mode in queues) {
    queues[mode] = queues[mode].filter((q) => q.socket.id !== socketId);
  }
}

function isQueued(socketId) {
  return Object.keys(queues).some((mode) => queues[mode].some((q) => q.socket.id === socketId));
}

// 매치를 정리한다 (승리로 종료되었을 때 / 누군가 나갔을 때 공용으로 사용)
function endMatch(matchId) {
  const match = matches[matchId];
  if (!match) return;
  for (const pid in match.players) {
    delete socketToMatch[pid];
    const s = io.sockets.sockets.get(pid);
    if (s) s.leave(matchId);
  }
  delete matches[matchId];
}

io.on('connection', (socket) => {
  console.log(`플레이어 접속: ${socket.id}`);

  // 클라이언트가 닉네임 + 모드 + 캐릭터를 정한 뒤 'findMatch' 이벤트를 보내면 대기열에 등록하고 매칭을 시도
  socket.on('findMatch', (data) => {
    if (socketToMatch[socket.id]) return; // 이미 매치 중이면 무시
    if (isQueued(socket.id)) return; // 이미 어딘가 대기 중이면 무시

    const mode = data && MODES[data.mode] ? data.mode : '1v1';
    const name = (data && data.name ? String(data.name) : 'Player').slice(0, 12);
    const requestedId = data && data.characterId;
    // 서버가 직접 캐릭터 ID를 검증 (클라이언트가 보낸 능력치는 절대 신뢰하지 않음)
    const characterId = CHARACTERS[requestedId] ? requestedId : DEFAULT_CHARACTER_ID;

    queues[mode].push({ socket, name, characterId });
    socket.emit('queueUpdate', { mode, waiting: queues[mode].length, needed: MODES[mode].size });

    tryMatchmaking(mode);
  });

  // 매칭 대기를 취소
  socket.on('cancelFindMatch', () => {
    leaveQueue(socket.id);
  });

  // 클라이언트가 매 프레임 자신의 위치/각도를 전송
  socket.on('playerUpdate', (data) => {
    const match = matches[socketToMatch[socket.id]];
    if (!match || match.over) return;
    const p = match.players[socket.id];
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
    const match = matches[socketToMatch[socket.id]];
    if (!match || match.over) return;
    const p = match.players[socket.id];
    if (!p || !p.alive) return;

    const now = Date.now();
    if (now - p.lastShotAt < FIRE_COOLDOWN_MS) return; // 연사 방지 (최소 발사 간격)
    if (p.ammo <= 0) return; // 탄창이 비어있으면 발사 불가

    p.ammo -= 1;
    p.lastShotAt = now;

    spawnProjectiles(match, p, p.basic, false);
  });

  // 궁극기 발사 요청 (게이지가 100%일 때만 발동)
  socket.on('ultimate', () => {
    const match = matches[socketToMatch[socket.id]];
    if (!match || match.over) return;
    const p = match.players[socket.id];
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
        match.effects.push({ id: effectIdCounter, type: 'lightning', x: sx, y: sy, radius: ult.strikeRadius, life: EFFECT_LIFETIME });

        for (const pid in match.players) {
          if (pid === socket.id) continue; // 자기 자신은 맞지 않음
          const target = match.players[pid];
          if (!target.alive) continue;
          if (!FRIENDLY_FIRE && target.team === p.team) continue; // 아군은 맞지 않음

          const ddx = target.x - sx;
          const ddy = target.y - sy;
          if (Math.sqrt(ddx * ddx + ddy * ddy) < PLAYER_RADIUS + ult.strikeRadius) {
            applyDamage(match, target, ult.damage, socket.id, { chargeShooter: false });
            if (match.over) break;
          }
        }
        if (match.over) break;
      }
    } else {
      // 조준한 방향으로 날아가는 궁극기 (예: 피에로 발사, 메가 샷건)
      spawnProjectiles(match, p, ult, true);
    }

    if (!match.over) p.ultimateCharge = 0;
  });

  // 채팅 메시지 수신 -> 검증 후 같은 매치(같은 방)에만 브로드캐스트
  socket.on('chatMessage', (data) => {
    const matchId = socketToMatch[socket.id];
    const match = matches[matchId];
    if (!match) return; // 매치 중이 아니면 무시
    const p = match.players[socket.id];
    if (!p) return;

    const now = Date.now();
    if (p.lastChatAt && now - p.lastChatAt < CHAT_COOLDOWN_MS) return; // 도배 방지

    let text = data && data.text ? String(data.text) : '';
    text = text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, CHAT_MAX_LENGTH);
    if (!text) return;

    p.lastChatAt = now;

    io.to(matchId).emit('chatMessage', {
      id: socket.id,
      name: p.name,
      color: p.color,
      text,
      ts: now,
    });
  });

  socket.on('disconnect', () => {
    console.log(`플레이어 접속 해제: ${socket.id}`);
    leaveQueue(socket.id);

    const matchId = socketToMatch[socket.id];
    if (!matchId) return;
    const match = matches[matchId];
    if (!match) {
      delete socketToMatch[socket.id];
      return;
    }

    if (!match.over) {
      const leaver = match.players[socket.id];
      const winnerTeam = leaver && leaver.team === 'A' ? 'B' : 'A';
      match.over = true;
      io.to(matchId).emit('matchOver', { reason: 'opponentLeft', winnerTeam, teamScore: match.teamScore });
    }
    endMatch(matchId);
  });
});

// ===== 매치별 물리 처리 (한 틱 분량) =====
function updateMatch(match, dt, now) {
  // 총알 이동
  for (const b of match.bullets) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
  }

  // 화면 밖, 수명 종료, 벽 충돌한 총알 제거
  match.bullets = match.bullets.filter((b) => {
    if (b.life <= 0) return false;
    if (b.x < 0 || b.x > ARENA_WIDTH || b.y < 0 || b.y > ARENA_HEIGHT) return false;
    if (collidesWithWalls(b.x, b.y, b.radius)) return false; // 벽에 막힘
    return true;
  });

  // 총알-플레이어 충돌 판정
  const hitBulletIds = new Set();
  for (const b of match.bullets) {
    if (match.over) break;
    if (hitBulletIds.has(b.id)) continue;

    const owner = match.players[b.ownerId];

    for (const pid in match.players) {
      const target = match.players[pid];
      if (!target.alive) continue;
      if (pid === b.ownerId) continue; // 자기 자신 총알은 무시
      if (!FRIENDLY_FIRE && owner && target.team === owner.team) continue; // 아군 총알은 그대로 통과

      const dx = target.x - b.x;
      const dy = target.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < PLAYER_RADIUS + b.radius) {
        hitBulletIds.add(b.id);
        // 기본 공격만 궁극기 게이지를 충전시킴
        applyDamage(match, target, b.damage, b.ownerId, { chargeShooter: !b.isUltimate });
        break; // 이 총알은 이미 소모됨
      }
    }
  }

  match.bullets = match.bullets.filter((b) => !hitBulletIds.has(b.id));

  // 시각 이펙트(번개 등) 수명 관리
  for (const e of match.effects) e.life -= dt;
  match.effects = match.effects.filter((e) => e.life > 0);

  // 탄약 재충전 + 무피격 체력 회복
  for (const pid in match.players) {
    const p = match.players[pid];
    if (!p.alive) continue;

    // 탄창이 가득 차지 않았으면 시간이 지날 때마다 한 발씩 채워짐
    if (p.ammo < p.maxAmmo) {
      p.ammoRegenElapsed += dt;
      if (p.ammoRegenElapsed >= AMMO_REGEN_SECONDS) {
        p.ammo = Math.min(p.maxAmmo, p.ammo + 1);
        p.ammoRegenElapsed = 0;
      }
    } else {
      p.ammoRegenElapsed = 0;
    }

    // 일정 시간 피격당하지 않으면 체력이 서서히 회복
    if (p.hp < p.maxHp && now - p.lastDamageAt >= HP_REGEN_DELAY_MS) {
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp * HP_REGEN_PERCENT_PER_SEC * dt);
    }
  }
}

// ===== 서버 게임 루프 =====
// 진행 중인 모든 매치를 독립적으로 갱신하고, 각 매치의 상태는 그 매치에 속한 플레이어들에게만 전송한다
function gameLoop() {
  const dt = TICK_MS / 1000;
  const now = Date.now();

  for (const matchId in matches) {
    const match = matches[matchId];
    if (match.over) continue;

    updateMatch(match, dt, now);

    io.to(matchId).emit('state', { players: match.players, bullets: match.bullets, effects: match.effects });
  }
}

setInterval(gameLoop, TICK_MS);

server.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});
