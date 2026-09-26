// server.js
// 브롤스타즈 스타일 2D 탑다운 매칭 슈팅 게임 - 서버 (1:1 / 2:2 지원)

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// pingInterval/pingTimeout을 기본값(각각 25초/20초)보다 짧게 줘서, 매칭 대기 중 누군가의
// 연결이 끊겼을 때(와이파이 끊김, 앱 전환 등 '정상 종료'가 아닌 경우) 서버가 이를 훨씬 빨리
// 감지하도록 함. 기본값 그대로면 최대 45초 가까이 disconnect 이벤트가 늦게 발생해서,
// 대기 중이던 다른 사람 화면의 인원수가 한참 동안 줄어들지 않는 것처럼 보였음.
const io = new Server(server, {
  pingInterval: 8000,
  pingTimeout: 5000,
});

// Render 배포 환경에서는 PORT 환경변수를 사용해야 함
const PORT = process.env.PORT || 3000;

// index.html 등 정적 파일을 같은 폴더에서 서빙
app.use(express.static(path.join(__dirname)));

// ===== 게임 설정값 =====
const ARENA_WIDTH = 1100;   // 맵 크기 축소 (한 화면에 맵 전체가 보이도록)
const ARENA_HEIGHT = 1000;
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

// ===== 맵 장애물(벽) / 지형(덤불) 배치 =====
// 맵이 넓어졌으므로(5000x4000), 좌상단 사분면 기준으로만 배치를 정의한 뒤
// 상하/좌우/180도로 대칭 복제해서 4개 사분면 모두에 공평하게 배치한다 (2:2 밸런스를 위함)
function mirrorAcrossCenter(rects) {
  const out = [];
  for (const r of rects) {
    out.push({ x: r.x, y: r.y, width: r.width, height: r.height });                                                   // 원본 (좌상단)
    out.push({ x: ARENA_WIDTH - r.x - r.width, y: r.y, width: r.width, height: r.height });                           // 좌우 반전 (우상단)
    out.push({ x: r.x, y: ARENA_HEIGHT - r.y - r.height, width: r.width, height: r.height });                         // 상하 반전 (좌하단)
    out.push({ x: ARENA_WIDTH - r.x - r.width, y: ARENA_HEIGHT - r.y - r.height, width: r.width, height: r.height }); // 180도 반전 (우하단)
  }
  return out;
}

// x, y는 좌상단 좌표. 이동/총알 모두 벽에 막힘
// 맵 크기(1100x1000)에 맞춰 배치 좌표/크기를 비율대로 스케일링해서 기존과 동일한 상대적 레이아웃(균형)을 유지한다.
const WALLS = [
  ...mirrorAcrossCenter([
    { x: 132, y: 88, width: 92, height: 15 },   // 사분면 상단 가로 벽
    { x: 231, y: 163, width: 13, height: 85 },  // 사분면 세로 벽
    { x: 70, y: 313, width: 53, height: 15 },   // 사분면 안쪽 가로 벽
    { x: 330, y: 70, width: 20, height: 23 },   // 작은 엄폐 블록
  ]),
  // 맵 중앙 구조물 (좌우 대칭)
  { x: ARENA_WIDTH / 2 - 7, y: ARENA_HEIGHT / 2 - 40, width: 13, height: 80 },    // 중앙 세로 기둥
  { x: ARENA_WIDTH / 2 - 101, y: ARENA_HEIGHT / 2 - 10, width: 20, height: 23 },  // 중앙 좌측 엄폐물
  { x: ARENA_WIDTH / 2 + 81, y: ARENA_HEIGHT / 2 - 10, width: 20, height: 23 },   // 중앙 우측 엄폐물
];

// ===== 맵 지형(덤불) =====
// 벽과 달리 이동/총알을 막지 않으며, 그 안에 들어간 플레이어는 적 팀에게 보이지 않게 됨
// (같은 덤불 안에 함께 있는 적끼리는 서로 보임 - 은신 궁극기와 달리 예외 있음)
const BUSHES = [
  ...mirrorAcrossCenter([
    { x: 19, y: 23, width: 106, height: 98 },   // 코너 덤불 (기존보다 약간 확대)
    { x: 203, y: 357, width: 81, height: 81 },  // 사분면 안쪽 덤불 (기존보다 약간 확대)
  ]),
  // 맵 중앙 좌우의 덤불 (근접 교전용, 기존보다 약간 확대)
  { x: ARENA_WIDTH / 2 - 172, y: ARENA_HEIGHT / 2 - 46, width: 71, height: 92 },
  { x: ARENA_WIDTH / 2 + 101, y: ARENA_HEIGHT / 2 - 46, width: 71, height: 92 },
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

function pointInRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function isInBush(x, y) {
  return BUSHES.some((b) => pointInRect(x, y, b));
}

// target과 viewer가 같은 덤불 하나에 동시에 들어가 있는지 (같은 덤불 안이면 서로 보임)
function sharedBush(target, viewer) {
  return BUSHES.some((b) => pointInRect(target.x, target.y, b) && pointInRect(viewer.x, viewer.y, b));
}

// 적(viewer 기준)에게 target이 보이지 않는 상태인지 판정
// - 은신 궁극기(invisible)는 예외 없이 항상 안 보임
// - 덤불(inBush)은 같은 덤불 안에 viewer도 함께 있으면 보임
function isHiddenFromEnemy(target, viewer) {
  if (!target.alive) return false;
  if (target.invisible) return true;
  if (target.inBush) return !sharedBush(target, viewer);
  return false;
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
    // 샷건은 한 번에 펠릿이 10개나 나가기 때문에, 다른 캐릭터와 같은 충전량을 쓰면
    // 근거리에서 한 번만 쏴도 펠릿 여러 개가 동시에 맞아 궁극기가 거의 바로 차버림.
    // 그래서 슈는 펠릿 1개 적중당 충전량을 다른 캐릭터보다 훨씬 낮게 별도로 설정함.
    ultimateChargePerHit: 8, // 기본값(34)의 약 1/4 수준
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
  wonhyo: {
    id: 'wonhyo',
    name: '원효대사',
    maxHp: 10000,
    basic: {
      name: '해골물 뿌리기',
      type: 'skullwater',
      damage: 0,          // 해골 자체는 직접 대미지를 주지 않음 (벽/적에게 닿으면 물웅덩이 생성)
      speed: 480,
      radius: 14,
      lifetime: 1.8,       // 초 (사거리 ≈ 864px)
      visual: 'skull',
      poolOnImpact: true,  // 벽 또는 적과 충돌 시 물웅덩이를 생성
      poolRadius: 90,       // 물웅덩이 반경
      poolLifetime: 2,      // 물웅덩이가 유지되는 시간(초)
      poolTickInterval: 0.5, // 대미지/회복이 적용되는 주기(초)
      poolDamage: 500,      // 적이 물에 닿았을 때 주기당 대미지
      poolHeal: 500,        // 자신/아군이 물에 닿았을 때 주기당 회복량
    },
    ultimate: {
      name: '은신',
      type: 'stealth',    // 조준 없이 즉시 발동, 일정 시간 동안 적에게 보이지 않음
      duration: 5,          // 초
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
let waterPoolIdCounter = 0;

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
    invisible: false, // 은신 궁극기 사용 중이면 true (적에게는 보이지 않음)
    inBush: false,     // 덤불 안에 있으면 true (같은 덤불에 있는 적을 제외하고는 보이지 않음)
    stealthId: 0,      // 은신 발동 회차 (타이머가 중첩될 때 오래된 타이머가 새 은신을 끄지 않도록 함)
    score: 0,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    characterId: character.id,
    characterName: character.name,
    basic: character.basic,
    ultimate: character.ultimate,
    ultimateChargePerHit: character.ultimateChargePerHit || ULTIMATE_CHARGE_PER_HIT, // 캐릭터별로 다르게 설정 가능 (예: 슈는 펠릿이 많아 더 낮게)
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
    shooter.ultimateCharge = Math.min(100, shooter.ultimateCharge + shooter.ultimateChargePerHit);
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
      respawned.invisible = false;
      respawned.stealthId = (respawned.stealthId || 0) + 1; // 진행 중이던 은신 타이머를 무효화
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
      team: p.team,
      life: spec.lifetime,
      damage: spec.damage,
      radius: spec.radius,
      isUltimate,
      visual: spec.visual,
      // 원효대사의 해골물 뿌리기처럼 벽/적에 닿으면 물웅덩이를 생성하는 발사체를 위한 부가 정보
      poolOnImpact: !!spec.poolOnImpact,
      poolRadius: spec.poolRadius,
      poolLifetime: spec.poolLifetime,
      poolTickInterval: spec.poolTickInterval,
      poolDamage: spec.poolDamage,
      poolHeal: spec.poolHeal,
    });
  }
}

// 벽 또는 적과 충돌한 poolOnImpact 발사체가 남기는 물웅덩이를 생성한다
function spawnWaterPool(match, b) {
  waterPoolIdCounter += 1;
  match.waterPools.push({
    id: waterPoolIdCounter,
    x: b.x,
    y: b.y,
    radius: b.poolRadius,
    ownerId: b.ownerId,
    team: b.team,
    life: b.poolLifetime,       // 남은 지속 시간(초)
    tickTimer: 0,                 // 다음 대미지/회복 틱까지 누적된 시간
    tickInterval: b.poolTickInterval,
    damage: b.poolDamage,
    heal: b.poolHeal,
  });
}

// ===== 매칭 로직 =====
// 특정 모드의 대기열에 필요한 인원이 모이면 앞에서부터 묶어 매치를 시작한다
function tryMatchmaking(mode) {
  const cfg = MODES[mode];
  const beforeLength = queues[mode].length;
  queues[mode] = queues[mode].filter((q) => q.socket.connected);

  let matched = false;
  while (queues[mode].length >= cfg.size) {
    const entries = queues[mode].splice(0, cfg.size);
    startMatch(mode, entries);
    matched = true;
  }

  // 연결이 끊긴 사람이 필터링되었거나 매치가 성사되어 대기열 인원이 줄어든 경우,
  // 남아서 계속 기다리고 있는 사람들에게도 줄어든 인원수를 알려준다.
  if (matched || queues[mode].length !== beforeLength) {
    broadcastQueueStatus(mode);
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
    waterPools: [],
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
      bushes: BUSHES,
      winScore: cfg.winScore,
      teammateNames,
      opponentNames,
    });
  });
}

// 특정 모드의 대기열에 있는 '모든' 사람에게 현재 대기 인원을 알림
// (기존에는 새로 들어온 사람에게만 보내서, 먼저 기다리던 사람 화면에는 인원수가 갱신되지 않는 버그가 있었음)
function broadcastQueueStatus(mode) {
  const list = queues[mode];
  const needed = MODES[mode].size;
  list.forEach((q) => {
    if (q.socket.connected) {
      q.socket.emit('queueUpdate', { mode, waiting: list.length, needed });
    }
  });
}

// 현재 서버에 접속 중인 전체 인원 수를 모든 클라이언트에게 알림 (매칭 대기와 무관하게 항상 표시됨)
function broadcastOnlineCount() {
  io.emit('onlineCount', { count: io.engine.clientsCount });
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
  broadcastOnlineCount();

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
    // 이 모드에서 이미 기다리고 있던 사람들에게도 갱신된 인원수를 함께 알림
    broadcastQueueStatus(mode);

    tryMatchmaking(mode);
  });

  // 매칭 대기를 취소
  socket.on('cancelFindMatch', () => {
    const mode = Object.keys(queues).find((m) => queues[m].some((q) => q.socket.id === socket.id));
    leaveQueue(socket.id);
    if (mode) broadcastQueueStatus(mode); // 남아있는 대기자들에게 줄어든 인원수를 알림
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
    } else if (ult.type === 'stealth') {
      // 조준 불필요: 즉시 일정 시간 동안 적에게 보이지 않는 은신 상태가 됨
      p.invisible = true;
      p.stealthId = (p.stealthId || 0) + 1;
      const myStealthId = p.stealthId;
      const stealthTargetId = p.id;
      setTimeout(() => {
        const m = matches[match.id];
        if (!m) return;
        const player = m.players[stealthTargetId];
        if (!player) return;
        if (player.stealthId !== myStealthId) return; // 이미 새 은신/리스폰으로 대체된 타이머는 무시
        player.invisible = false;
      }, (ult.duration || 5) * 1000);
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
    const queuedMode = Object.keys(queues).find((m) => queues[m].some((q) => q.socket.id === socket.id));
    leaveQueue(socket.id);
    if (queuedMode) broadcastQueueStatus(queuedMode); // 남아있는 대기자들에게 줄어든 인원수를 알림
    broadcastOnlineCount();

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

  // 화면 밖, 수명 종료, 벽 충돌한 총알 제거 (poolOnImpact 발사체는 벽에 닿으면 물웅덩이를 남김)
  match.bullets = match.bullets.filter((b) => {
    if (b.life <= 0) return false;
    if (b.x < 0 || b.x > ARENA_WIDTH || b.y < 0 || b.y > ARENA_HEIGHT) return false;
    if (collidesWithWalls(b.x, b.y, b.radius)) {
      if (b.poolOnImpact) spawnWaterPool(match, b);
      return false; // 벽에 막힘
    }
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
        if (b.poolOnImpact) {
          // 해골물 뿌리기: 적중 시 직접 대미지 대신 물웅덩이를 생성 (궁극기 게이지는 적중으로 충전됨)
          spawnWaterPool(match, b);
          if (!b.isUltimate) {
            const shooter = match.players[b.ownerId];
            if (shooter) shooter.ultimateCharge = Math.min(100, shooter.ultimateCharge + shooter.ultimateChargePerHit);
          }
        } else {
          // 기본 공격만 궁극기 게이지를 충전시킴
          applyDamage(match, target, b.damage, b.ownerId, { chargeShooter: !b.isUltimate });
        }
        break; // 이 총알은 이미 소모됨
      }
    }
  }

  match.bullets = match.bullets.filter((b) => !hitBulletIds.has(b.id));

  // 시각 이펙트(번개 등) 수명 관리
  for (const e of match.effects) e.life -= dt;
  match.effects = match.effects.filter((e) => e.life > 0);

  // 물웅덩이(원효대사): 일정 주기마다 적에게는 대미지, 자신/아군에게는 회복을 적용
  for (const pool of match.waterPools) {
    if (match.over) break;
    pool.life -= dt;
    if (pool.life <= 0) continue;
    pool.tickTimer += dt;

    while (pool.tickTimer >= pool.tickInterval) {
      pool.tickTimer -= pool.tickInterval;

      for (const pid in match.players) {
        const target = match.players[pid];
        if (!target.alive) continue;

        const dx = target.x - pool.x;
        const dy = target.y - pool.y;
        if (Math.sqrt(dx * dx + dy * dy) >= PLAYER_RADIUS + pool.radius) continue;

        if (target.team === pool.team) {
          // 물을 만든 사람의 아군(자신 포함) -> 체력 회복
          target.hp = Math.min(target.maxHp, target.hp + pool.heal);
        } else {
          // 적 -> 대미지 (궁극기 게이지는 충전하지 않음)
          applyDamage(match, target, pool.damage, pool.ownerId, { chargeShooter: false });
          if (match.over) break;
        }
      }
      if (match.over) break;
    }
  }
  match.waterPools = match.waterPools.filter((pool) => pool.life > 0);

  // 덤불 진입 여부 갱신 (죽은 플레이어는 어차피 화면에 그려지지 않으므로 false로 둠)
  for (const pid in match.players) {
    const p = match.players[pid];
    p.inBush = p.alive && isInBush(p.x, p.y);
  }

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

// 특정 시청자(viewerId) 기준으로 실제로 보여줘도 되는 플레이어 정보만 추려서 반환한다.
// 자신과 아군은 항상 그대로 보내고, 적이 덤불/은신으로 숨어있는 상태면 좌표(x, y)를 빼고 보내서
// 클라이언트가 화면에는 그리지 못하지만 스코어보드(이름/점수)는 계속 정상적으로 보이게 한다.
function buildVisiblePlayers(match, viewerId) {
  const viewer = match.players[viewerId];
  const result = {};
  for (const pid in match.players) {
    const p = match.players[pid];
    if (!viewer || pid === viewerId || p.team === viewer.team) {
      result[pid] = p;
      continue;
    }
    if (isHiddenFromEnemy(p, viewer)) {
      const { x, y, ...rest } = p; // 위치 정보만 제거
      result[pid] = rest;
    } else {
      result[pid] = p;
    }
  }
  return result;
}

// ===== 서버 게임 루프 =====
// 진행 중인 모든 매치를 독립적으로 갱신하고, 각 매치의 상태는 그 매치에 속한 플레이어들에게만 전송한다
// (덤불/은신 은닉을 위해 방 전체 브로드캐스트 대신 플레이어별로 필터링해서 개별 전송한다.
// Socket.io는 각 소켓을 자신의 id와 같은 이름의 방에 기본으로 넣어주므로 io.to(pid)로 특정 플레이어에게만 보낼 수 있다.)
function gameLoop() {
  const dt = TICK_MS / 1000;
  const now = Date.now();

  for (const matchId in matches) {
    const match = matches[matchId];
    if (match.over) continue;

    updateMatch(match, dt, now);

    for (const pid in match.players) {
      io.to(pid).emit('state', {
        players: buildVisiblePlayers(match, pid),
        bullets: match.bullets,
        effects: match.effects,
        waterPools: match.waterPools,
      });
    }
  }
}

setInterval(gameLoop, TICK_MS);

server.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});
