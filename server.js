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
const ARENA_WIDTH = 770;    // 맵 크기 30% 추가 축소 (1100 → 770)
const ARENA_HEIGHT = 700;   // 맵 크기 30% 추가 축소 (1000 → 700)
const PLAYER_RADIUS = 20;
const RESPAWN_DELAY = 3000;     // ms
const TICK_RATE = 20;           // 초당 서버 틱 수
const TICK_MS = 1000 / TICK_RATE;
const ULTIMATE_CHARGE_PER_HIT = 17; // 기본 공격이 적중할 때마다 충전되는 궁극기 게이지(%). 궁극기 충전 속도 50% 감소 적용 (기존 34에서 절반)
const EFFECT_LIFETIME = 0.4; // 번개 등 시각 이펙트가 화면에 남아있는 시간(초)
const KNOCKBACK_DURATION = 0.28; // 넉백(밀쳐냄)이 순간이동처럼 보이지 않도록, 이 시간(초) 동안 점점 감속하며 자연스럽게 날아가게 함

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
// 맵 크기를 70% 배율(1100x1000 → 770x700)로 줄인 데 맞춰, 벽 좌표/크기도 동일 비율로 축소해
// 기존 레이아웃 비율을 그대로 유지함
const WALLS = [
  ...mirrorAcrossCenter([
    { x: 112, y: 98, width: 112, height: 18 }, // 사분면 상단 가로 벽
    { x: 238, y: 133, width: 18, height: 91 }, // 사분면 세로 벽
  ]),
  // 맵 중앙 구조물
  { x: ARENA_WIDTH / 2 - 11, y: ARENA_HEIGHT / 2 - 49, width: 21, height: 98 },  // 중앙 세로 기둥
];

// ===== 맵 지형(덤불) =====
// 벽과 달리 이동/총알을 막지 않으며, 그 안에 들어간 플레이어는 적 팀에게 보이지 않게 됨
// (같은 덤불 안에 함께 있는 적끼리는 서로 보임 - 은신 궁극기와 달리 예외 있음)
const BUSHES = [
  ...mirrorAcrossCenter([
    { x: 13, y: 16, width: 74, height: 69 },  // 코너 덤불
    { x: 142, y: 250, width: 57, height: 57 }, // 사분면 안쪽 덤불
  ]),
  // 맵 중앙 좌우의 덤불 (근접 교전용)
  { x: ARENA_WIDTH / 2 - 120, y: ARENA_HEIGHT / 2 - 32, width: 50, height: 64 },
  { x: ARENA_WIDTH / 2 + 71, y: ARENA_HEIGHT / 2 - 32, width: 50, height: 64 },
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
      speed: 845,      // px/초 (기존 650에서 30% 증가)
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
      damage: 2500,
      speed: 350,      // 총알보다 느린 구체
      radius: 12,
      lifetime: 2.2,
      visual: 'orb',
    },
    ultimate: {
      name: '벼락지기',
      type: 'lightning',   // 조준 없이 자신 주변 고정된 위치에 번개를 떨어뜨리는 궁극기
      damage: 3500,
      strikeCount: 5,        // 떨어지는 번개 개수
      strikeRadius: 60,      // 번개 한 발의 피격 반경
      areaRadius: 220,       // 시전자로부터 번개가 떨어지는 고정 거리 (원형으로 균등 배치)
    },
  },
  syu: {
    id: 'syu',
    name: '슈',
    maxHp: 6000, // 체력이 별도로 지정되지 않아 다른 캐릭터와 비슷한 수준으로 설정 (조정 가능)
    // 샷건은 한 번에 펠릿이 10개나 나가기 때문에, 다른 캐릭터와 같은 충전량을 쓰면
    // 근거리에서 한 번만 쏴도 펠릿 여러 개가 동시에 맞아 궁극기가 거의 바로 차버림.
    // 그래서 슈는 펠릿 1개 적중당 충전량을 다른 캐릭터보다 훨씬 낮게 별도로 설정함.
    ultimateChargePerHit: 4, // 기본값(17)의 약 1/4 수준 (궁극기 충전 속도 50% 감소 적용, 기존 8에서 절반)
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
    maxHp: 7500,
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
      poolLifetime: 2.5,    // 물웅덩이가 유지되는 시간(초) - 기존 2초에서 증가
      poolTickInterval: 0.5, // 대미지/회복이 적용되는 주기(초)
      poolDamage: 1000,     // 적이 물에 닿았을 때 주기당 대미지 (공격력 2배 적용, 기존 500에서 증가)
      poolHeal: 500,        // 자신/아군이 물에 닿았을 때 주기당 회복량
    },
    ultimate: {
      name: '은신',
      type: 'stealth',    // 조준 없이 즉시 발동, 일정 시간 동안 적에게 보이지 않음
      duration: 5,          // 초
    },
  },
  byeongitong: {
    id: 'byeongitong',
    name: '변기통',
    maxHp: 8000,
    basic: {
      name: '뚫어뻥 휘두르기',
      type: 'melee',        // 발사체가 아니라 즉시 판정되는 근접 공격
      damage: 2000,
      angleDegrees: 120,    // 바라보는 방향을 중심으로 한 부채꼴의 전체 각도
      range: 90,            // 부채꼴 반경(사거리) - 근접 공격답게 130에서 축소
      knockback: 85,       // 맞은 대상이 밀려나는 거리(px) - 기존 170에서 50% 감소
      visual: 'plunger',
    },
    ultimate: {
      name: '변기 돌진',
      type: 'dash',         // 조준 방향으로 매우 빠르게 돌진하다가 적과 충돌하면 대미지+기절
      damage: 2500,
      speed: 1400,          // px/초 (돌진 속도)
      duration: 0.4,        // 최대 돌진 지속 시간(초). 이 시간 동안 적과 충돌하지 않으면 그냥 종료됨
      stunDuration: 1.5,    // 충돌한 적을 기절시키는 시간(초)
    },
  },
  seongseureopda: {
    id: 'seongseureopda',
    name: '성스럽다',
    maxHp: 6000,
    basic: {
      name: '칼 던지기',
      damage: 2000,
      speed: 600,
      radius: 8,
      lifetime: 1.4,     // 초 (사거리 ≈ 840px)
      visual: 'knife',
      pierceWalls: true, // 벽(장애물)을 그대로 통과해서 날아감
    },
    ultimate: {
      name: '저격 터렛 설치',
      type: 'turret',       // 조준 없이 자신의 위치에 자동 사격 터렛을 설치하는 궁극기
      hp: 4000,              // 터렛 자체 체력 (총알에 맞으면 줄어들고 0이 되면 파괴됨)
      radius: 22,
      range: 294,             // 이 범위 안의 적만 자동으로 조준/사격 (기존 420에서 30% 감소)
      fireInterval: 0.5,      // 초마다 한 발씩 발사
      damage: 500,           // 터렛 총알 1발당 대미지
      bulletSpeed: 900,
      bulletRadius: 6,
      bulletLifetime: 1.2,
      visual: 'turret',
    },
  },
  yeoddongi: {
    id: 'yeoddongi',
    name: '여똥이',
    maxHp: 5000,
    basic: {
      name: '똥가루 뿌리기',
      type: 'poopgas',   // 브롤스타즈 엠즈처럼 독가스(똥가루) 구름을 남기는 발사체
      damage: 0,          // 직접 적중 대미지는 없음 (닿으면 물웅덩이처럼 똥가루 구름을 생성)
      speed: 420,
      radius: 14,
      lifetime: 1.6,       // 초 (사거리 ≈ 672px)
      visual: 'poop',
      pelletCount: 3,       // 한 번에 똥 3개를 동시에 발사
      spreadDegrees: 30,    // 3개가 퍼져나가는 전체 각도
      poolOnImpact: true,  // 벽 또는 적과 충돌 시 똥가루 구름을 생성
      poolRadius: 80,       // 똥가루 구름 반경
      poolLifetime: 1,       // 똥가루 구름이 유지되는 시간(초) - 1초로 변경
      poolTickInterval: 0.2, // 0.2초마다 대미지 적용
      poolDamage: 250,      // 똥가루 구름에 닿은 적이 주기(0.2초)마다 입는 대미지 (공격력 50% 감소 적용, 기존 500에서 감소)
      poolHeal: 0,          // 아군/자신에게는 아무 효과 없음 (독가스라 회복 없음)
    },
    ultimate: {
      name: '간식 처먹기',
      type: 'heal',       // 조준 불필요, 즉시 체력을 가득 채우는 궁극기
    },
  },
  bobae: {
    id: 'bobae',
    name: '보배',
    maxHp: 7000,
    basic: {
      name: '보배 던지기',
      damage: 2000,
      speed: 380,     // 총알보다 느린 투척형
      radius: 12,
      lifetime: 2.0,   // 초
      visual: 'bobae',
    },
    ultimate: {
      name: '보배 폭발',
      type: 'timedBomb', // 조준 불필요, 자신의 위치에 설치. 설치 즉시 '보배의 잔소리'로 지속 피해를 주다가 일정 시간 뒤 폭발
      fuseTime: 2,          // 설치 후 폭발까지 걸리는 시간(초)
      tickInterval: 1,       // 잔소리(지속 피해) 적용 주기(초)
      tickDamage: 500,       // 잔소리 주기당 대미지
      radius: 100,           // 잔소리/폭발 판정 반경
      explodeDamage: 3500,   // 폭발 시 대미지
      visual: 'bobaeBomb',
    },
    // 보배 전용 패시브 '보배의 복수': 체력이 30% 이하로 떨어지면 자동으로 발동하며(목숨당 1회),
    // 이동속도/공격속도가 증가하고 지속시간 동안 받는 피해의 일부를 공격자에게 반사한다
    passive: {
      type: 'revenge',
      name: '보배의 복수',
      hpThreshold: 0.3,           // 체력이 최대 체력의 이 비율 이하가 되면 발동
      duration: 5,                 // 지속 시간(초)
      moveSpeedMultiplier: 1.5,
      attackSpeedMultiplier: 1.5,
      reflectPercent: 0.2,          // 지속시간 동안 받는 피해의 이 비율만큼 공격자에게 반사
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
let turretIdCounter = 0;
let bombIdCounter = 0;

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
    dashing: false,     // 변기통의 돌진 궁극기를 사용 중이면 true (이동/공격 입력이 무시되고 서버가 위치를 직접 제어함)
    dashDirX: 0,
    dashDirY: 0,
    dashTimeLeft: 0,
    stunnedUntil: 0,    // 이 시각(ms, Date.now() 기준) 전까지는 기절 상태 (이동/공격 불가)
    knockbackDirX: 0,   // 넉백(밀쳐냄) 진행 방향
    knockbackDirY: 0,
    knockbackDistance: 0, // 넉백으로 이동해야 할 총 거리(px)
    knockbackTimeLeft: 0, // 넉백이 끝날 때까지 남은 시간(초). 0보다 크면 매 틱 점점 감속하며 이동
    knockbackTotalTime: 0, // 이번 넉백의 전체 지속 시간(초) - 감속 계산의 기준값
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
    passive: character.passive || null, // 캐릭터 전용 패시브 정의 (예: 보배의 복수)
    attackSpeedMultiplier: 1, // 패시브로 공격속도가 증가하면 1보다 커짐 (발사 쿨다운 계산에 사용)
    moveSpeedMultiplier: 1,   // 패시브로 이동속도가 증가하면 1보다 커짐 (클라이언트 이동 계산에 사용)
    revengeActive: false,     // '보배의 복수' 발동 중이면 true (이동/공격속도 증가 + 피해 반사)
    revengeUntil: 0,          // 이 시각(ms)까지 발동 상태 유지
    revengeUsed: false,       // 이번 목숨에서 이미 발동했는지 (사망/리스폰 시 초기화됨)
  };
}

// 대미지 적용 + 사망/리스폰/점수/승리 판정을 한 곳에서 관리 (총알 피격, 번개 피격이 공용으로 사용)
// match: 이 대미지가 발생한 매치. 다른 매치의 상태에는 절대 영향을 주지 않는다.
// 아군 피해 여부는 호출하는 쪽(총알 충돌 / 번개 판정)에서 이미 걸러서 넘겨준다.
function applyDamage(match, target, damage, shooterId, { chargeShooter, isReflected } = {}) {
  if (!target.alive || match.over) return;

  const shooter = match.players[shooterId];

  // 보배의 복수: 발동 중일 때 받는 피해의 일부를 공격자에게 그대로 반사한다
  // (반사로 인해 발생한 피해는 다시 반사되지 않도록 isReflected로 막아 무한루프를 방지)
  if (!isReflected && target.revengeActive && target.passive && target.passive.reflectPercent
      && shooter && shooter.alive && shooter.id !== target.id) {
    applyDamage(match, shooter, damage * target.passive.reflectPercent, target.id, { chargeShooter: false, isReflected: true });
    if (match.over) return; // 반사 피해로 매치가 끝났으면 이후 처리는 하지 않음
  }

  target.hp -= damage;
  target.lastDamageAt = Date.now(); // 무피격 회복 타이머 초기화

  if (shooter && chargeShooter) {
    shooter.ultimateCharge = Math.min(100, shooter.ultimateCharge + shooter.ultimateChargePerHit);
  }

  // 보배의 복수 발동 체크: 체력이 임계치 이하로 떨어지고 이번 목숨에 아직 발동하지 않았다면 발동
  if (target.hp > 0 && target.passive && target.passive.type === 'revenge' && !target.revengeUsed
      && target.hp <= target.maxHp * target.passive.hpThreshold) {
    target.revengeUsed = true;
    target.revengeActive = true;
    target.revengeUntil = Date.now() + target.passive.duration * 1000;
    target.attackSpeedMultiplier = target.passive.attackSpeedMultiplier;
    target.moveSpeedMultiplier = target.passive.moveSpeedMultiplier;
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
      respawned.dashing = false;
      respawned.dashTimeLeft = 0;
      respawned.stunnedUntil = 0;
      respawned.knockbackTimeLeft = 0;
      // 보배의 복수: 리스폰(새로운 목숨)하면 발동 여부/상태를 모두 초기화해서 다시 발동할 수 있게 함
      respawned.revengeActive = false;
      respawned.revengeUntil = 0;
      respawned.revengeUsed = false;
      respawned.attackSpeedMultiplier = 1;
      respawned.moveSpeedMultiplier = 1;
      // 궁극기 게이지는 사망/리스폰 시에도 초기화하지 않고 그대로 유지함
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
      pierceWalls: !!spec.pierceWalls, // 성스럽다의 칼 던지기처럼 벽(장애물)을 무시하고 통과하는 발사체
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

// 근접 공격(변기통의 뚫어뻥 휘두르기 등): 발사체 없이 즉시 판정되는 부채꼴 범위 공격
// spec.angleDegrees: 바라보는 방향을 중심으로 한 부채꼴의 전체 각도, spec.range: 부채꼴 반경
// spec.knockback이 있으면 맞은 대상을 공격자 반대 방향(바깥쪽)으로 밀어낸다
function performMeleeAttack(match, p, spec, isUltimate) {
  const halfAngle = ((spec.angleDegrees || 90) * Math.PI) / 180 / 2;
  const range = spec.range || 120;

  // 클라이언트가 부채꼴 스윙을 그릴 수 있도록 시각 이펙트로 전달
  effectIdCounter += 1;
  match.effects.push({
    id: effectIdCounter,
    type: 'melee',
    x: p.x,
    y: p.y,
    angle: p.angle,
    arcDegrees: spec.angleDegrees || 90,
    radius: range,
    life: EFFECT_LIFETIME,
  });

  for (const pid in match.players) {
    if (match.over) break;
    if (pid === p.id) continue;
    const target = match.players[pid];
    if (!target.alive) continue;
    if (!FRIENDLY_FIRE && target.team === p.team) continue;

    const dx = target.x - p.x;
    const dy = target.y - p.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > range + PLAYER_RADIUS) continue;

    // 목표가 공격자가 바라보는 방향 기준 부채꼴 각도 안에 있는지 확인
    let diff = Math.atan2(dy, dx) - p.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) > halfAngle) continue;

    applyDamage(match, target, spec.damage, p.id, { chargeShooter: !isUltimate });
    if (match.over) break;

    // 넉백: 즉시 순간이동시키지 않고, 방향/거리만 기록해서 이후 updateMatch 틱마다
    // 점점 감속하며 자연스럽게 날아가도록 처리한다 (실제 이동은 아래 넉백 처리 루프에서 수행)
    if (spec.knockback && dist > 0.001) {
      target.knockbackDirX = dx / dist;
      target.knockbackDirY = dy / dist;
      target.knockbackDistance = spec.knockback;
      target.knockbackTimeLeft = KNOCKBACK_DURATION;
      target.knockbackTotalTime = KNOCKBACK_DURATION;
    }
  }

  // 적 터렛(성스럽다의 저격 터렛)도 근접 공격 범위/각도 판정에 함께 포함시켜 파괴할 수 있게 함
  for (const turret of match.turrets) {
    if (match.over) break;
    if (!FRIENDLY_FIRE && turret.team === p.team) continue;

    const tdx = turret.x - p.x;
    const tdy = turret.y - p.y;
    const tdist = Math.sqrt(tdx * tdx + tdy * tdy);
    if (tdist > range + turret.radius) continue;

    let tdiff = Math.atan2(tdy, tdx) - p.angle;
    while (tdiff > Math.PI) tdiff -= Math.PI * 2;
    while (tdiff < -Math.PI) tdiff += Math.PI * 2;
    if (Math.abs(tdiff) > halfAngle) continue;

    turret.hp -= spec.damage;
  }
  match.turrets = match.turrets.filter((t) => t.hp > 0);
}

// 저격 터렛(성스럽다 궁극기): 자신의 위치에 설치되어, 사거리 안의 적 중 가장 가까운 대상을
// 자동으로 조준해 일정 주기마다 총알을 발사한다 (실제 조준/발사는 updateMatch의 터렛 AI 루프에서 처리)
function spawnTurret(match, p, spec) {
  // 같은 사람이 이미 설치한 터렛이 남아있으면 먼저 제거하고 새로 설치 (터렛이 무한히 쌓이지 않도록)
  match.turrets = match.turrets.filter((t) => t.ownerId !== p.id);

  turretIdCounter += 1;
  match.turrets.push({
    id: turretIdCounter,
    ownerId: p.id,
    team: p.team,
    x: p.x,
    y: p.y,
    hp: spec.hp,
    maxHp: spec.hp,
    radius: spec.radius || 22,
    range: spec.range || 400,
    fireInterval: spec.fireInterval || 2,
    fireCooldown: 0,
    damage: spec.damage,
    bulletSpeed: spec.bulletSpeed || 800,
    bulletRadius: spec.bulletRadius || 6,
    bulletLifetime: spec.bulletLifetime || 1.2,
    visual: spec.visual || 'turret',
  });
}

// 물웅덩이(원효대사): 벽 또는 적과 충돌한 poolOnImpact 발사체가 남기는 물웅덩이를 생성한다
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

// 보배 폭발(보배 궁극기): 자신의 위치에 설치되어, 설치 즉시 '보배의 잔소리'로 주변 적에게
// 주기적인 지속 피해를 주다가(updateMatch의 폭발물 루프에서 처리) 일정 시간 뒤 크게 폭발한다
function spawnBomb(match, p, spec) {
  bombIdCounter += 1;
  match.bombs.push({
    id: bombIdCounter,
    ownerId: p.id,
    team: p.team,
    x: p.x,
    y: p.y,
    radius: spec.radius,
    fuseLeft: spec.fuseTime,      // 폭발까지 남은 시간(초)
    tickInterval: spec.tickInterval,
    tickTimer: 0,
    tickDamage: spec.tickDamage,
    explodeDamage: spec.explodeDamage,
    exploded: false,
    visual: spec.visual || 'bobaeBomb',
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
    turrets: [],
    bombs: [],
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
    if (p.dashing || p.knockbackTimeLeft > 0 || (p.stunnedUntil && Date.now() < p.stunnedUntil)) return; // 돌진/기절 중에는 서버가 위치를 제어하므로 클라이언트 입력을 무시
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
    if (p.dashing || p.knockbackTimeLeft > 0 || (p.stunnedUntil && Date.now() < p.stunnedUntil)) return; // 돌진/기절 중에는 공격 불가

    const now = Date.now();
    // 보배의 복수 등으로 공격속도가 증가했으면 그만큼 쿨다운을 짧게 계산 (연사 방지는 그대로 유지)
    if (now - p.lastShotAt < FIRE_COOLDOWN_MS / (p.attackSpeedMultiplier || 1)) return;
    if (p.ammo <= 0) return; // 탄창이 비어있으면 발사 불가

    p.ammo -= 1;
    p.lastShotAt = now;

    if (p.basic.type === 'melee') {
      performMeleeAttack(match, p, p.basic, false);
    } else {
      spawnProjectiles(match, p, p.basic, false);
    }
  });

  // 궁극기 발사 요청 (게이지가 100%일 때만 발동)
  socket.on('ultimate', () => {
    const match = matches[socketToMatch[socket.id]];
    if (!match || match.over) return;
    const p = match.players[socket.id];
    if (!p || !p.alive) return;
    if (p.dashing || p.knockbackTimeLeft > 0 || (p.stunnedUntil && Date.now() < p.stunnedUntil)) return; // 이미 돌진 중이거나 기절 상태면 재발동 불가
    if (p.ultimateCharge < 100) return;

    const ult = p.ultimate;

    if (ult.type === 'lightning') {
      // 자신 주변에 고정된 간격으로 원형 배치된 위치에 번개를 여러 발 떨어뜨림 (조준 불필요)
      const angleOffset = Math.random() * Math.PI * 2; // 매번 같은 모양이 반복되지 않도록 전체 패턴만 회전
      for (let i = 0; i < ult.strikeCount; i++) {
        const angle = angleOffset + (Math.PI * 2 * i) / ult.strikeCount;
        const dist = ult.areaRadius;
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
    } else if (ult.type === 'dash') {
      // 변기통의 돌진: 바라보는 방향으로 매우 빠르게 이동하며, 이후 updateMatch 틱에서
      // 실제 이동/벽 충돌/적 충돌(대미지+기절) 판정을 수행한다
      p.dashing = true;
      p.dashDirX = Math.cos(p.angle);
      p.dashDirY = Math.sin(p.angle);
      p.dashTimeLeft = ult.duration || 0.4;
    } else if (ult.type === 'turret') {
      // 성스럽다의 저격 터렛: 조준 불필요, 즉시 자신의 위치에 자동 사격 터렛을 설치
      spawnTurret(match, p, ult);
    } else if (ult.type === 'heal') {
      // 여똥이의 간식 처먹기: 조준 불필요, 즉시 체력을 가득 채움
      p.hp = p.maxHp;
    } else if (ult.type === 'timedBomb') {
      // 보배 폭발: 조준 불필요, 자신의 위치에 설치
      spawnBomb(match, p, ult);
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
  // 변기통의 돌진 궁극기 처리: 서버가 매 틱마다 위치를 직접 이동시키고, 벽/적과의 충돌을 판정한다
  for (const pid in match.players) {
    if (match.over) break;
    const p = match.players[pid];
    if (!p.dashing) continue;
    if (!p.alive) { p.dashing = false; continue; }

    const ult = p.ultimate;
    const step = (ult.speed || 0) * dt;
    const nx = Math.max(PLAYER_RADIUS, Math.min(ARENA_WIDTH - PLAYER_RADIUS, p.x + p.dashDirX * step));
    const ny = Math.max(PLAYER_RADIUS, Math.min(ARENA_HEIGHT - PLAYER_RADIUS, p.y + p.dashDirY * step));

    let blockedByWall = false;
    if (!collidesWithWalls(nx, p.y, PLAYER_RADIUS)) p.x = nx; else blockedByWall = true;
    if (!collidesWithWalls(p.x, ny, PLAYER_RADIUS)) p.y = ny; else blockedByWall = true;

    p.dashTimeLeft -= dt;

    // 돌진 중 적과 충돌하면 대미지 + 기절을 주고 돌진을 즉시 종료 (벽에 막혀도 종료)
    let hitSomeone = false;
    for (const tid in match.players) {
      const target = match.players[tid];
      if (tid === pid || !target.alive) continue;
      if (!FRIENDLY_FIRE && target.team === p.team) continue;

      const ddx = target.x - p.x;
      const ddy = target.y - p.y;
      if (Math.sqrt(ddx * ddx + ddy * ddy) < PLAYER_RADIUS * 2) {
        applyDamage(match, target, ult.damage, pid, { chargeShooter: false });
        hitSomeone = true;
        if (!match.over) target.stunnedUntil = now + (ult.stunDuration || 0) * 1000;
        break;
      }
    }

    if (hitSomeone || blockedByWall || p.dashTimeLeft <= 0) p.dashing = false;
  }

  // 넉백(밀쳐냄) 처리: 등감속 운동으로 처음엔 빠르게 날아가다가 점점 느려지며 목표 거리만큼 이동 후 멈춘다
  // (한 틱에 순간이동시키면 부자연스러워 보이므로, KNOCKBACK_DURATION 동안 여러 틱에 걸쳐 나눠서 이동시킴)
  for (const pid in match.players) {
    const p = match.players[pid];
    if (!p.knockbackTimeLeft || p.knockbackTimeLeft <= 0) continue;
    if (!p.alive) { p.knockbackTimeLeft = 0; continue; }

    // 등감속 공식: 평균 속도 = 거리/시간 이므로, 초기 속도(v0)는 그 2배. 남은 시간 비율만큼 현재 속도를 계산
    const v0 = (2 * p.knockbackDistance) / p.knockbackTotalTime;
    const speed = v0 * (p.knockbackTimeLeft / p.knockbackTotalTime);
    const step = speed * dt;

    const nx = Math.max(PLAYER_RADIUS, Math.min(ARENA_WIDTH - PLAYER_RADIUS, p.x + p.knockbackDirX * step));
    const ny = Math.max(PLAYER_RADIUS, Math.min(ARENA_HEIGHT - PLAYER_RADIUS, p.y + p.knockbackDirY * step));

    let blockedByWall2 = false;
    if (!collidesWithWalls(nx, p.y, PLAYER_RADIUS)) p.x = nx; else blockedByWall2 = true;
    if (!collidesWithWalls(p.x, ny, PLAYER_RADIUS)) p.y = ny; else blockedByWall2 = true;

    p.knockbackTimeLeft -= dt;
    if (blockedByWall2) p.knockbackTimeLeft = 0; // 벽에 부딪히면 그 자리에서 멈춤
  }

  // 터렛(성스럽다 궁극기) AI: 사거리 안에서 가장 가까운 적을 자동으로 조준해 주기적으로 총알을 발사
  for (const turret of match.turrets) {
    if (match.over) break;
    turret.fireCooldown -= dt;
    if (turret.fireCooldown > 0) continue;

    let nearest = null;
    let nearestDist = Infinity;
    for (const pid in match.players) {
      const target = match.players[pid];
      if (!target.alive) continue;
      if (!FRIENDLY_FIRE && target.team === turret.team) continue;
      if (isHiddenFromEnemy(target, turret)) continue; // 덤불/은신으로 숨은 적은 터렛도 조준하지 못함

      const ddx = target.x - turret.x;
      const ddy = target.y - turret.y;
      const ddist = Math.sqrt(ddx * ddx + ddy * ddy);
      if (ddist <= turret.range && ddist < nearestDist) {
        nearestDist = ddist;
        nearest = target;
      }
    }
    if (!nearest) continue;

    const ndx = nearest.x - turret.x;
    const ndy = nearest.y - turret.y;
    const ndist = Math.sqrt(ndx * ndx + ndy * ndy) || 1;

    bulletIdCounter += 1;
    match.bullets.push({
      id: bulletIdCounter,
      x: turret.x + (ndx / ndist) * (turret.radius + 5),
      y: turret.y + (ndy / ndist) * (turret.radius + 5),
      vx: (ndx / ndist) * turret.bulletSpeed,
      vy: (ndy / ndist) * turret.bulletSpeed,
      ownerId: turret.ownerId,
      team: turret.team,
      life: turret.bulletLifetime,
      damage: turret.damage,
      radius: turret.bulletRadius,
      isUltimate: true,
      visual: 'sniperBullet',
      pierceWalls: false,
    });
    turret.fireCooldown = turret.fireInterval;
  }

  // 총알 이동
  for (const b of match.bullets) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
  }

  // 화면 밖, 수명 종료, 벽 충돌한 총알 제거 (poolOnImpact 발사체는 벽/맵 경계에 닿으면 물웅덩이를 남김)
  match.bullets = match.bullets.filter((b) => {
    if (b.life <= 0) return false;
    if (b.x < 0 || b.x > ARENA_WIDTH || b.y < 0 || b.y > ARENA_HEIGHT) {
      if (b.poolOnImpact) {
        // 맵 끝 벽에 닿은 지점(경계선 위)으로 좌표를 고정해서 물웅덩이를 생성
        const clampedX = Math.max(0, Math.min(ARENA_WIDTH, b.x));
        const clampedY = Math.max(0, Math.min(ARENA_HEIGHT, b.y));
        spawnWaterPool(match, { ...b, x: clampedX, y: clampedY });
      }
      return false;
    }
    if (!b.pierceWalls && collidesWithWalls(b.x, b.y, b.radius)) {
      if (b.poolOnImpact) spawnWaterPool(match, b);
      return false; // 벽에 막힘 (pierceWalls 발사체는 벽을 그대로 통과함)
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

  // 총알-터렛 충돌 판정: 적의 총알에 맞으면 터렛 체력이 줄고, 0이 되면 파괴됨
  for (const b of match.bullets) {
    if (match.over) break;
    if (hitBulletIds.has(b.id)) continue;

    for (const turret of match.turrets) {
      if (!FRIENDLY_FIRE && turret.team === b.team) continue; // 아군 총알은 자신의 터렛을 통과함

      const dx = turret.x - b.x;
      const dy = turret.y - b.y;
      if (Math.sqrt(dx * dx + dy * dy) < turret.radius + b.radius) {
        hitBulletIds.add(b.id);
        if (b.poolOnImpact) {
          // 해골물/똥가루 뿌리기: 터렛에 적중하면 직접 대미지 대신 물웅덩이/똥가루 구름을 남겨
          // 이후 지속 대미지 판정(아래 물웅덩이 루프)으로 터렛에 피해를 준다
          spawnWaterPool(match, b);
        } else {
          turret.hp -= b.damage;
        }
        break;
      }
    }
  }
  match.turrets = match.turrets.filter((t) => t.hp > 0);

  match.bullets = match.bullets.filter((b) => !hitBulletIds.has(b.id));

  // 시각 이펙트(번개 등) 수명 관리
  for (const e of match.effects) e.life -= dt;
  match.effects = match.effects.filter((e) => e.life > 0);

  // 물웅덩이(원효대사) / 똥가루 구름(여똥이): 일정 주기마다 적(플레이어+적 터렛)에게는 대미지, 자신/아군에게는 회복을 적용
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

      // 적 터렛(성스럽다의 저격 터렛)도 물웅덩이/똥가루 구름 범위 안에 있으면 함께 대미지를 입어 파괴될 수 있음
      for (const turret of match.turrets) {
        if (turret.team === pool.team) continue; // 아군 터렛은 영향 없음
        const tdx = turret.x - pool.x;
        const tdy = turret.y - pool.y;
        if (Math.sqrt(tdx * tdx + tdy * tdy) >= turret.radius + pool.radius) continue;
        turret.hp -= pool.damage;
      }
      match.turrets = match.turrets.filter((t) => t.hp > 0);
    }
  }
  match.waterPools = match.waterPools.filter((pool) => pool.life > 0);

  // 보배 폭발(보배 궁극기): 설치 직후에는 '보배의 잔소리'로 주기적인 지속 피해를 주다가,
  // 퓨즈(fuseLeft)가 다 되면 한 번 크게 폭발하고 사라진다
  for (const bomb of match.bombs) {
    if (match.over) break;
    if (bomb.exploded) continue;

    bomb.fuseLeft -= dt;
    bomb.tickTimer += dt;

    while (bomb.tickTimer >= bomb.tickInterval && bomb.fuseLeft > 0) {
      bomb.tickTimer -= bomb.tickInterval;
      for (const pid in match.players) {
        const target = match.players[pid];
        if (!target.alive) continue;
        if (!FRIENDLY_FIRE && target.team === bomb.team) continue;
        const dx = target.x - bomb.x;
        const dy = target.y - bomb.y;
        if (Math.sqrt(dx * dx + dy * dy) >= PLAYER_RADIUS + bomb.radius) continue;
        applyDamage(match, target, bomb.tickDamage, bomb.ownerId, { chargeShooter: false });
        if (match.over) break;
      }
      if (match.over) break;
    }
    if (match.over) break;

    if (bomb.fuseLeft <= 0) {
      bomb.exploded = true;
      effectIdCounter += 1;
      match.effects.push({ id: effectIdCounter, type: 'explosion', x: bomb.x, y: bomb.y, radius: bomb.radius, life: EFFECT_LIFETIME });

      for (const pid in match.players) {
        const target = match.players[pid];
        if (!target.alive) continue;
        if (!FRIENDLY_FIRE && target.team === bomb.team) continue;
        const dx = target.x - bomb.x;
        const dy = target.y - bomb.y;
        if (Math.sqrt(dx * dx + dy * dy) >= PLAYER_RADIUS + bomb.radius) continue;
        applyDamage(match, target, bomb.explodeDamage, bomb.ownerId, { chargeShooter: false });
        if (match.over) break;
      }
    }
  }
  match.bombs = match.bombs.filter((b) => !b.exploded);

  // 보배의 복수: 지속 시간이 끝나면 이동/공격속도 증가와 피해 반사 효과를 해제
  for (const pid in match.players) {
    const p = match.players[pid];
    if (p.revengeActive && now >= p.revengeUntil) {
      p.revengeActive = false;
      p.attackSpeedMultiplier = 1;
      p.moveSpeedMultiplier = 1;
    }
  }

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
        turrets: match.turrets,
        bombs: match.bombs,
      });
    }
  }
}

setInterval(gameLoop, TICK_MS);

server.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});
