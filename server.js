// server.js
// 브롤스타즈 스타일 2D 탑다운 매칭 슈팅 게임 - 서버 (1:1 / 2:2 지원)

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const util = require('util');

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
  // coinReward: 승리한 팀의 각 플레이어가 받는 코인 / trophyReward: 승리할 때 그 매치에서 쓴 캐릭터가 얻는 트로피 (상대가 중도 이탈해서 이긴 경우는 코인/트로피 모두 절반)
  // trophyLoss: 패배할 때 그 매치에서 쓴 캐릭터가 잃는 트로피 (0 아래로는 내려가지 않음)
  '1v1': { size: 2, teamSize: 1, winScore: 5, coinReward: 45, trophyReward: 15, trophyLoss: 5 },
  '2v2': { size: 4, teamSize: 2, winScore: 8, coinReward: 60, trophyReward: 12, trophyLoss: 4 },
};
const MATCH_COUNTDOWN_MS = 4000; // 매칭 직후 상대 정보(캐릭터/트로피)를 보여주는 대결 화면 시간. 이 동안은 이동/공격/스킬 입력이 막힘
const MATCH_CLEANUP_DELAY_MS = 600; // 승리 판정 후 마지막 상태를 한 번 더 보낸 뒤 방을 정리하기까지의 지연

// ===== 개발자(관리자) 모드 =====
// 이 아이디(대소문자 구분 없음)로 로그인한 계정만 개발자 모드를 쓸 수 있다. 판단은 항상 서버가 로그인된 계정 키로 한다 (클라이언트가 보낸 값은 믿지 않음).
// 다른 아이디를 쓰고 싶으면 Render 환경변수 ADMIN_USERNAME 에 넣으면 된다. 반드시 이 아이디로 먼저 가입해서 선점해둘 것! (가입 전에는 누구나 이 아이디를 만들 수 있다)
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'IQ1972').trim();
const ADMIN_KEY = ADMIN_USERNAME.toLowerCase();
const BAN_PERMANENT = 253402300799000; // 영구 정지 = 9999년까지 정지
const BAN_MAX_MINUTES = 60 * 24 * 365;  // 기간 정지의 최대 길이: 1년
function isActiveBan(u) { return !!(u && u.bannedUntil && u.bannedUntil > Date.now() && u.key !== ADMIN_KEY); }
function banMessage(u) {
  const reason = u.banReason ? ` / 사유: ${u.banReason}` : '';
  if (u.bannedUntil >= BAN_PERMANENT) return `정지된 계정입니다. (영구 정지${reason})`;
  const until = new Date(u.bannedUntil).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
  return `정지된 계정입니다. (해제: ${until}${reason})`;
}
const FRIENDLY_FIRE = false; // 같은 팀끼리는 서로 피해를 주지 않음 (총알은 아군을 그대로 통과)

// ===== 연승 보너스 (캐릭터별) =====
// 같은 캐릭터로 연속 승리할수록 승리 때 받는 트로피가 늘어난다. 연승은 캐릭터마다 따로 센다.
// 보너스 = 모드의 기본 승리 트로피 × STREAK_BONUS_RATE × min(직전까지의 연승 수, STREAK_BONUS_MAX_STEPS)
// 예) 1:1(기본 15): 2연승째 +3, 3연승째 +6 ... 6연승째부터 최대 +15 (기본 보상이 최대 2배)
// 패배(점수로 진 경우/매치 도중 나간 경우)하면 그 캐릭터의 연승은 0으로 초기화된다.
const STREAK_BONUS_RATE = 0.2;
const STREAK_BONUS_MAX_STEPS = 5;
function streakBonusTrophies(baseReward, previousStreak) {
  const steps = Math.min(Math.max(0, previousStreak || 0), STREAK_BONUS_MAX_STEPS);
  return Math.round(baseReward * STREAK_BONUS_RATE * steps);
}

// ===== 탄창 / 연사 방지 =====
const MAX_AMMO = 3;              // 모든 캐릭터 공통 탄창 크기
const FIRE_COOLDOWN_MS = 350;    // 한 발 쏜 뒤 다음 발사까지 최소 대기시간 (연사 방지)
const AMMO_REGEN_SECONDS = 1.8;  // 탄약 1발이 다시 채워지는 데 걸리는 시간 (캐릭터별로 spec.ammoRegenSeconds로 덮어쓸 수 있음)

// ===== 무피격 체력 회복 =====
const HP_REGEN_DELAY_MS = 4000;      // 마지막으로 피격당한 후 이 시간이 지나야 회복 시작
const HP_REGEN_PERCENT_PER_SEC = 0.04; // 초당 최대 체력의 4%씩 회복
const GADGET_COOLDOWN_SEC = 15; // 가젯 재사용 대기시간(초)

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
//
// ===== 맵 목록 =====
// 매치가 시작될 때마다 이 중 하나를 무작위로 골라서 사용한다 (2:2 밸런스를 위해 모든 맵은 4방향 대칭).
// 새 맵을 추가할 때는 캐릭터 반지름(PLAYER_RADIUS=20)보다 넓은 빈 통로를 항상 남겨서,
// 스폰 지점이 벽 사이에 끼어버리는 일이 없도록 주의할 것 (randomSpawnPoint가 안전장치를 갖고 있긴 하지만,
// 애초에 맵 자체에 사람이 낄 만큼 좁은 틈을 만들지 않는 것이 가장 안전함).
const MAP_LAYOUTS = [
  {
    id: 'temple',
    name: '고전 사원',
    walls: [
      ...mirrorAcrossCenter([
        { x: 112, y: 98, width: 112, height: 18 }, // 사분면 상단 가로 벽
        // (사분면 세로 벽 { x: 238, y: 133, width: 18, height: 91 } 은 벽 수를 줄이기 위해 제거)
      ]),
      // 맵 중앙 구조물
      { x: ARENA_WIDTH / 2 - 11, y: ARENA_HEIGHT / 2 - 49, width: 21, height: 98 },  // 중앙 세로 기둥
    ],
    bushes: [
      ...mirrorAcrossCenter([
        { x: 13, y: 16, width: 74, height: 69 },  // 코너 덤불
        { x: 142, y: 250, width: 57, height: 57 }, // 사분면 안쪽 덤불
      ]),
      // 맵 중앙 좌우의 덤불 (근접 교전용)
      { x: ARENA_WIDTH / 2 - 120, y: ARENA_HEIGHT / 2 - 32, width: 50, height: 64 },
      { x: ARENA_WIDTH / 2 + 71, y: ARENA_HEIGHT / 2 - 32, width: 50, height: 64 },
    ],
  },
  {
    id: 'crossroads',
    name: '사거리',
    walls: [
      ...mirrorAcrossCenter([
        { x: 60, y: 250, width: 130, height: 20 }, // 좌/상단 쪽 가로 벽 (중앙 통로를 감싸는 형태)
        // (세로 벽 { x: 330, y: 60, width: 20, height: 130 } 은 벽 수를 줄이기 위해 제거)
      ]),
      // 중앙의 작은 엄폐 기둥 2개 (좌우 대칭 유지. 위/아래 기둥은 벽 수를 줄이기 위해 제거)
      { x: ARENA_WIDTH / 2 - 60, y: ARENA_HEIGHT / 2 - 10, width: 20, height: 20 },
      { x: ARENA_WIDTH / 2 + 40, y: ARENA_HEIGHT / 2 - 10, width: 20, height: 20 },
    ],
    bushes: [
      ...mirrorAcrossCenter([
        { x: 40, y: 40, width: 60, height: 60 }, // 네 귀퉁이 덤불
      ]),
      // 중앙 기둥 위아래의 덤불 (근접 교전용)
      { x: ARENA_WIDTH / 2 - 30, y: ARENA_HEIGHT / 2 - 130, width: 60, height: 40 },
      { x: ARENA_WIDTH / 2 - 30, y: ARENA_HEIGHT / 2 + 90, width: 60, height: 40 },
    ],
  },
];

// 매치 시작 시 이 중 하나를 무작위로 고르기 위한 함수
function pickRandomMapLayout() {
  return MAP_LAYOUTS[Math.floor(Math.random() * MAP_LAYOUTS.length)];
}

function circleIntersectsRect(cx, cy, radius, rect) {
  const closestX = Math.max(rect.x, Math.min(cx, rect.x + rect.width));
  const closestY = Math.max(rect.y, Math.min(cy, rect.y + rect.height));
  const dx = cx - closestX;
  const dy = cy - closestY;
  return (dx * dx + dy * dy) < (radius * radius);
}

function collidesWithWalls(walls, x, y, radius) {
  return walls.some((w) => circleIntersectsRect(x, y, radius, w));
}

function pointInRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function isInBush(bushes, x, y) {
  return bushes.some((b) => pointInRect(x, y, b));
}

// target과 viewer가 같은 덤불 하나에 동시에 들어가 있는지 (같은 덤불 안이면 서로 보임)
function sharedBush(bushes, target, viewer) {
  return bushes.some((b) => pointInRect(target.x, target.y, b) && pointInRect(viewer.x, viewer.y, b));
}

// 적(viewer 기준)에게 target이 보이지 않는 상태인지 판정
// - 은신 궁극기(invisible)는 예외 없이 항상 안 보임
// - 덤불(inBush)은 같은 덤불 안에 viewer도 함께 있으면 보임
function isHiddenFromEnemy(bushes, target, viewer) {
  if (!target.alive) return false;
  if (target.invisible) return true;
  if (target.inBush) return !sharedBush(bushes, target, viewer);
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
      visual: 'rifleBullet', // 실제 총알 모양 (탄두 + 황동 탄피 + 궤적)
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
    gadget: {
      name: '연발 사격',
      type: 'burst',       // 조준한 한 방향으로 총알을 빠르게 연달아 발사
      bulletCount: 3,
      interval: 0.07,      // 총알 사이 간격(초)
      damage: 1500,
      speed: 845,
      radius: 6,
      lifetime: 1.5,
      visual: 'rifleBullet', // 기본공격과 같은 실제 총알 모양
    },
  },
  jigi: {
    id: 'jigi',
    name: '지기',
    maxHp: 6000,
    basic: {
      name: '던지기',
      damage: 2000,    // 1레벨 기준 (기존 2500에서 너프)
      speed: 360,      // 탄속 감소 (기존 420에서 조금 느리게)
      radius: 12,
      lifetime: 2.57,  // 탄속이 느려진 만큼 늘려서 사거리는 기존과 동일하게 유지 (360 x 2.57 ≈ 925)
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
    gadget: {
      name: '탄창 충전',
      type: 'reloadAmmo',   // 조준 불필요, 즉시 탄창을 가득 채움
      instant: true,        // true면 누르는 즉시 발동 (조준 후 발사가 필요 없음)
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
    gadget: {
      name: '보호막',
      type: 'shield',      // 조준 불필요, 즉시 발동해서 shieldHp만큼의 피해를 대신 흡수하는 보호막을 두름
      instant: true,        // true면 누르는 즉시 발동
      shieldHp: 1000,       // 보호막이 막아주는 피해량. 다 소모되면 보호막이 사라지고, 다시 쓰면 1000으로 새로 채워짐
    },
  },
  wonhyo: {
    id: 'wonhyo',
    name: '원효대사',
    maxHp: 6500, // 기존 7500에서 너프
    basic: {
      name: '해골물 뿌리기',
      type: 'skullwater',
      damage: 0,          // 해골 자체는 직접 대미지를 주지 않음 (벽/적에게 닿으면 물웅덩이 생성)
      speed: 480,
      radius: 14,
      lifetime: 2,         // 초 (기존 1.8초에서 증가, 사거리 ≈ 960px)
      visual: 'skull',
      poolOnImpact: true,  // 벽 또는 적과 충돌 시 물웅덩이를 생성
      poolRadius: 90,       // 물웅덩이 반경
      poolLifetime: 2.5,    // 물웅덩이가 유지되는 시간(초) - 기존 2초에서 증가
      poolTickInterval: 0.5, // 대미지/회복이 적용되는 주기(초)
      poolDamage: 700,      // 적이 물에 닿았을 때 주기당 대미지 (기존 1000에서 변경)
      poolHeal: 300,        // 자신/아군이 물에 닿았을 때 주기당 회복량 (기존 500에서 너프)
      directDamage: 1200,   // 해골이 물이 퍼지기 전에 적(플레이어/터렛)에게 직접 적중했을 때 주는 대미지 (기존 700에서 변경)
      ammoRegenSeconds: AMMO_REGEN_SECONDS * 1.3, // 기본공격 재장전 시간이 다른 캐릭터보다 30% 느림
    },
    ultimate: {
      name: '은신',
      type: 'stealth',    // 조준 없이 즉시 발동, 일정 시간 동안 적에게 보이지 않음
      duration: 5,          // 초
    },
    gadget: {
      name: '초인적인 힘',
      type: 'speedBoost',   // 조준 불필요, 즉시 발동해서 일정 시간 동안 이동속도가 빨라짐
      instant: true,
      duration: 2,          // 지속 시간(초)
      speedMultiplier: 1.3, // 이동속도 배율 (1.3 = 30% 증가)
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
      type: 'dash',         // 조준 방향으로 매우 빠르게 돌진하며 적을 관통해 지나간 모든 적에게 대미지+기절
      damage: 2500,
      speed: 1400,          // px/초 (돌진 속도)
      duration: 0.4,        // 돌진 지속 시간(초). 적을 관통하므로 벽에 막히지 않는 한 이 시간 동안 끝까지 돌진함
      stunDuration: 1.5,    // 지나가며 맞힌 적을 기절시키는 시간(초)
    },
    gadget: {
      name: '질주',
      type: 'sprint',       // 조준한 방향으로 짧은 거리를 순식간에 돌진 (적에게 피해/기절을 주지 않는 도주용, 적과 부딪혀도 그대로 통과)
      instant: true,        // true면 누르는 즉시 발동
      speed: 970,           // 돌진 속도(px/초)
      duration: 0.165,      // 돌진 지속 시간(초). 이동 거리 ≈ speed × duration = 160px (서버 틱이 1/30초라 5틱 = 약 162px 이동). 벽에 막히면 그 앞에서 멈춤
    },
  },
  seongseureopda: {
    id: 'seongseureopda',
    name: '성스럽다',
    maxHp: 6000,
    basic: {
      name: '칼 던지기',
      damage: 1750,
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
      lifetime: 1.12,      // 초 (사거리 ≈ 470px, 기존 672px에서 30% 감소)
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
      damage: 1400,   // 기존 2000에서 공격력 30% 감소
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
      radius: 150,           // 잔소리/폭발 판정 반경 (기존 100에서 50% 증가)
      explodeDamage: 3500,   // 폭발 시 대미지
      slowMultiplier: 0.7,   // 범위 안에 있는 적의 이동속도 배율 (0.7 = 30% 감소)
      visual: 'bobaeBomb',
    },
    gadget: {
      name: '보조배터리 충전',
      type: 'powerCharge',    // 조준 불필요, 즉시 발동. 충전 동안은 이동/공격 불가(무방비) -> 충전이 끝나면 공격력 강화
      instant: true,
      chargeTime: 2,          // 충전(무방비) 시간(초)
      boostDuration: 5,       // 충전 완료 후 공격력이 강화되는 시간(초)
      damageMultiplier: 1.5,  // 공격력 배율 (1.5 = 50% 증가)
    },
  },
  ekhe: {
    id: 'ekhe',
    name: '엑헤',
    maxHp: 6500,
    basic: {
      name: '계란 던지기',
      type: 'eggthrow',   // 계란이 깨지면(적 적중 / 벽 / 최대 사거리 도달) 흰자가 퍼져 광역 피해
      damage: 0,          // 직접 대미지는 directDamage로 처리
      speed: 420,
      radius: 13,
      lifetime: 1.3,       // 초 (사거리 ≈ 546px). 수명이 끝나면 그 자리에서 깨짐
      visual: 'egg',
      poolOnImpact: true,   // 벽 또는 적과 충돌 시 흰자 웅덩이 생성
      poolOnExpire: true,   // 아무것도 안 맞고 최대 사거리에 도달해도 깨져서 흰자가 퍼짐
      poolVisual: 'eggWhite',
      poolRadius: 85,       // 흰자가 퍼지는 반경
      poolLifetime: 1,       // 퍼진 계란이 유지되는 시간(초)
      poolTickInterval: 0.2, // 0.2초마다 대미지 적용
      poolDamage: 300,      // 흰자에 닿은 적이 주기(0.2초)마다 입는 대미지
      poolHeal: 0,          // 아군/자신에게는 아무 효과 없음
      directDamage: 1200,   // 계란에 직접 맞았을 때의 대미지
    },
    ultimate: {
      name: '닭 소환',
      type: 'summonChicken', // 조준 불필요, 자신의 위치에 닭을 소환. 닭은 적을 자동으로 추격해서 공격
      hp: 8000,              // 닭의 체력 (적이 공격하면 죽을 수 있음)
      damage: 1500,          // 닭이 적에게 돌격해서 부딪힐 때의 대미지
      attackInterval: 1.5,   // 돌격 재사용 대기시간(초) - 한 번 돌격한 뒤 다음 돌격까지 걸리는 시간 (밸런스 조절용)
      attackRange: 14,       // 닭 몸 가장자리에서 적 몸 가장자리까지의 충돌(공격) 판정 거리(px)
      moveSpeed: 220,        // 닭 평상시 이동속도(px/초)
      chargeRange: 300,      // 이 거리 안에 적이 들어오고 돌격이 준비되면 돌격 시작
      chargeSpeed: 950,      // 돌격 중 이동속도(px/초)
      chargeMaxTime: 0.6,    // 한 번의 돌격이 최대로 지속되는 시간(초). 이 안에 못 맞추면 돌격 종료
      retreatTime: 0.4,      // 돌격으로 부딪힌 뒤 뒤로 물러나는 시간(초)
      retreatSpeed: 450,     // 물러나는 속도(px/초) - 다음 돌격이 매번 실제 돌진이 되도록 거리를 벌림
      chaseRange: 700,       // 이 거리 안의 적을 추격
      radius: 16,
      duration: 8,           // 닭이 남아있는 시간(초)
    },
  },
  gwari: {
    id: 'gwari',
    name: '꽈리',
    maxHp: 5500,
    basic: {
      name: '돌진 박치기',
      type: 'dash',          // 발사체 없이 바라보는 방향으로 짧게 돌진, 적을 관통하며 지나간 모든 적에게 피해
      damage: 2000,
      speed: 860,            // 돌진 속도(px/초)
      duration: 0.15,        // 돌진 시간(초) -> 이동 거리 ≈ speed * duration ≈ 129px (서버 틱이 0.05초라 3틱 = 129px 이동). 기존 약 198px에서 35% 감소
      lifetime: 0.15,        // (클라이언트 사거리 표시용: speed * lifetime = 돌진 거리)
      ammoRegenSeconds: AMMO_REGEN_SECONDS * 1.3, // 원효대사처럼 재장전 시간이 다른 캐릭터보다 30% 느림
    },
    ultimate: {
      name: '고추 발사',
      type: 'burst',         // 조준한 방향으로 고추를 연달아 발사
      bulletCount: 3,
      interval: 0.1,         // 고추 사이 발사 간격(초)
      damage: 1500,          // 고추 한 개당 피해
      speed: 800,
      radius: 9,
      lifetime: 1.2,         // 사거리 ≈ 960px
      visual: 'chili',
    },
    gadget: {
      name: '재장전 가속',
      type: 'reloadBoost',   // 조준 불필요, 즉시 발동
      instant: true,
      duration: 3,           // 지속 시간(초)
      speedMultiplier: 1.25, // 재장전 속도 배율 (1.25 = 25% 빨라짐)
    },
  },
  mocha: {
    id: 'mocha',
    name: '모카',
    maxHp: 4500, // 기존 5500에서 너프
    // 찌르기 4번이 한 번에 나가므로, 다른 캐릭터와 같은 충전량을 쓰면 궁극기가 너무 빨리 참.
    // 그래서 슈처럼 '찌르기 1번 적중당' 충전량을 낮게 따로 설정함 (콤보 4번 전부 적중 = 약 20%)
    ultimateChargePerHit: 5,
    basic: {
      name: '양손 찌르기',
      type: 'multiStab',     // 양손으로 짧은 간격으로 연달아 찌르는 근접 공격 (한 번 누르면 stabCount번 판정)
      damage: 450,           // 찌르기 1번당 대미지 (기존 500에서 너프)
      stabCount: 4,          // 한 번 공격할 때 찌르는 횟수
      stabInterval: 0.08,    // 찌르기 사이 간격(초)
      angleDegrees: 70,      // 찌르기 부채꼴 각도 (좁게)
      range: 90,             // 사거리 - 기존 75에서 20% 증가
      hitAssist: true,       // 판정 보정: 상대 몸통 크기만큼 부채꼴 각도를 너그럽게 판정 (중심점이 아니라 몸이 걸치면 적중)
      hitPadding: 10,        // 서버/클라이언트 위치 오차를 감안한 추가 판정 거리(px) - 화면에 보이는 범위는 그대로
      effectLife: 0.2,       // 찌르기 이펙트(손이 뻗었다가 회수되는 동작)가 화면에 남는 시간(초). 찌르기 간격(0.08)보다 길어서 동작이 자연스럽게 겹침
      ammoRegenSeconds: AMMO_REGEN_SECONDS / 1.5, // 재장전 속도가 다른 캐릭터보다 50% 빠름 (1.8초 -> 1.2초)
      visual: 'stab',
    },
    ultimate: {
      name: '도약 강습',
      type: 'leap',          // 벽을 무시하고 바라보는 방향으로 멀리 점프, 착지 지점 근처의 적에게 피해
      damage: 1000,
      distance: 304,         // 최대 점프 거리(px) - 기존 380에서 20% 감소. 착지 지점이 벽 안이면 가장 가까운 빈 곳까지 되돌아옴
      minDistance: 100,      // 최소 점프 거리(px). 조준(PC 마우스 위치 / 모바일 스틱 당김)에 따라 minDistance ~ distance 사이로 조절됨
      duration: 0.55,        // 공중에 떠 있는 시간(초). 이 동안은 조작 불가 + 피격/총알 무시 (길수록 점프가 느리게 보임)
      landRadius: 90,        // 착지 지점 주변 피해 반경
    },
    gadget: {
      name: '기합 충전',
      type: 'ultCharge',     // 조준 불필요, 즉시 발동. duration초에 걸쳐 궁극기 게이지를 amount%만큼 천천히 채움
      instant: true,
      amount: 50,            // 채워지는 궁극기 게이지(%)
      duration: 4,           // 다 채워지는 데 걸리는 시간(초)
    },
  },
  uphal: {
    id: 'uphal',
    name: '업할',
    maxHp: 10000,          // 1레벨 기준 (기존 9000에서 버프)
    basic: {
      name: '망치 지진',
      type: 'quake',         // 망치를 내려쳐서 조준 방향으로 즉시 판정되는 지진 (부채꼴 범위 + 기절)
      damage: 2000,
      stunDuration: 0.3,     // 맞은 적을 기절시키는 시간(초) - 기존 0.5초에서 감소
      angleDegrees: 28,      // 지진이 퍼지는 부채꼴 전체 각도 (조준 방향 기준) - 기존 40도에서 30% 감소
      range: 196,            // 사거리 - 기존 280에서 30% 감소
      windup: 1,             // 공격 버튼을 누른 뒤 이 시간(초)이 지나야 지진이 실제로 나감. 그동안 이동 불가 (조준 방향만 돌릴 수 있음)
      effectLife: 0.5,
      visual: 'quake',
    },
    ultimate: {
      name: '대지 강타',
      type: 'quake',         // 기본공격과 같은 방식이지만 범위/사거리가 훨씬 크고 기절 시간이 김
      damage: 3000,
      stunDuration: 2,
      angleDegrees: 100,     // 기본공격보다 훨씬 넓은 범위
      range: 430,            // 기본공격보다 훨씬 먼 사거리
      effectLife: 0.7,
      visual: 'quake',
    },
    gadget: {
      name: '방어막',
      type: 'shield',        // 조준 불필요, 즉시 발동해서 shieldHp만큼의 피해를 대신 흡수하는 보호막
      instant: true,
      shieldHp: 3000,
    },
  },
  jinwoopark: {
    id: 'jinwoopark',
    name: '진우Park',
    maxHp: 6500,
    basic: {
      name: '하트 발사하기',
      // 맞은 대상의 '현재 체력'의 일정 비율만큼 피해를 주는 하트 (보호막이 있으면 보호막 + 체력을 합친 값의 비율).
      // 고정 피해(damage)가 없으므로 레벨 강화의 공격력 배율은 이 비율에는 적용되지 않는다 (체력 강화만 적용).
      currentHpRatio: 0.3,   // 기존 0.25(25%)에서 버프
      executeBelowHp: 750,  // 맞은 적의 현재 체력이 이 값 이하이면 보호막과 상관없이 즉사 (무적/점프 중인 대상은 기존처럼 피해를 받지 않음)
      speed: 500,           // 중거리: 속도 x 수명 = 사거리 약 500px
      radius: 11,
      lifetime: 1.0,
      visual: 'heart',
    },
    ultimate: {
      name: '소다Bang',
      type: 'leap',          // 벽을 무시하고 바라보는 방향으로 중거리 점프, 착지 지점 주변 적에게 피해 + 밀쳐냄
      damage: 2000,          // 1레벨 기준 (기존 3000에서 너프)
      distance: 180,         // 최대 점프 거리(px) - 기존 300에서 40% 감소
      minDistance: 100,      // 최소 점프 거리(px). 조준에 따라 minDistance ~ distance 사이로 조절됨
      duration: 0.55,        // 공중에 떠 있는 시간(초). 이 동안은 조작 불가 + 피격/총알 무시
      landRadius: 110,       // 착지 지점 주변 피해 반경
      knockback: 220,        // 맞은 적을 착지 지점 바깥쪽으로 밀어내는 거리(px)
    },
    gadget: {
      name: '소다 마시기',
      type: 'heal',          // 조준 불필요, 즉시 발동해서 healAmount만큼 체력을 회복 (최대 체력을 넘지 않음)
      instant: true,
      healAmount: 2000,
    },
  },
  system: {
    id: 'system',
    name: '시스템',
    maxHp: 6000, // 1레벨 기준 (기존 6500에서 너프)
    basic: {
      name: '시스템 콤보',
      type: 'combo',         // 탄창 3개가 각각 다른 공격: 1번 원거리 구슬 -> 2번 던지는 구슬 -> 3번 소용돌이 3개
      reloadAllAtOnce: true, // 탄창 3개를 모두 쓴 뒤에야 재장전이 시작되고, ammoRegenSeconds 뒤에 한꺼번에 가득 참
      ammoRegenSeconds: 3,   // 3개를 모두 사용한 뒤 탄창이 리셋되기까지의 시간(초)
      dash: { speed: 800, duration: 0.12, delay: 0.2 }, // 총알을 쏜 0.2초 뒤에, 쏘던 순간 이동 중이던 방향으로 이만큼 돌진 (약 96px). 가만히 서 있으면 돌진하지 않음
      combo: [
        { name: '원거리 구슬', damage: 1000, speed: 800, radius: 9, lifetime: 1.0, visual: 'sysOrb' },   // 사거리 약 800 (원거리)
        { name: '던지는 구슬', damage: 1500, speed: 480, radius: 14, lifetime: 1.0, visual: 'sysThrow' }, // 사거리 약 480 (중거리)
        { name: '소용돌이', damage: 3000, pelletCount: 3, spreadDegrees: 90, speed: 300, radius: 18, lifetime: 0.5, visual: 'vortex' }, // 중심각 90도 범위로 3개, 개당 3000, 사거리 약 150
      ],
    },
    ultimate: {
      name: '거대 소용돌이',
      type: 'projectile',    // 조준한 방향으로 날아가는 거대한 소용돌이: 맞은 적(여러 명 관통)을 하늘로 띄웠다가 땅에 떨어질 때 landDamage 피해
      damage: 0,             // 적중 즉시 주는 피해는 없음 (착지 피해만 있음)
      landDamage: 1500,      // 땅에 떨어졌을 때 입는 피해
      launchDuration: 1.2,   // 하늘에 떠 있는 시간(초). 이 동안은 조작 불가 + 피격/총알 무시
      pierceTargets: true,   // 적을 맞혀도 사라지지 않고 계속 날아가 여러 명을 띄울 수 있음
      pierceWalls: true,     // 벽(장애물)에 닿아도 사라지지 않고 그대로 통과함 (맵 가장자리에서는 사라짐)
      speed: 380,
      radius: 60,
      lifetime: 1.4,         // 사거리 약 530
      visual: 'bigVortex',
    },
    gadget: {
      name: '긴급 재장전',
      type: 'reloadAmmo',    // 조준 불필요, 즉시 탄창을 가득 채움 (3개를 다 쓰기 전에도 바로 처음 구슬부터 다시 시작)
      instant: true,
    },
  },
  ddongpari: {
    id: 'ddongpari',
    name: '똥파리',
    maxHp: 5500,
    basic: {
      name: '똥 날리기',
      type: 'charge',          // 탄창 없음. 공격 버튼을 누르는 동안 충전하고, 떼는 순간 충전 시간에 비례한 똥을 발사
      minDamage: 800,          // 충전 없이 바로 쐈을 때 피해 (1레벨 기준)
      maxDamage: 3000,         // 완전히 충전했을 때 피해 (1레벨 기준)
      chargeTime: 3,           // 완전 충전까지 걸리는 시간(초)
      chargeSpeedMultiplier: 0.7, // 충전하는 동안 이동속도 배율 (0.7 = 30% 감소)
      fireCooldown: 1.5,       // 똥을 발사한 뒤 다음 똥을 발사할 수 있기까지 걸리는 시간(초)
      speed: 560,
      radius: 10,              // 충전 없이 쐈을 때 똥 크기
      lifetime: 1.2,           // 사거리 ≈ 672px
      visual: 'poopShot',
    },
    ultimate: {
      name: '가시 발사',
      type: 'projectile',      // 조준한 방향으로 날아가는 궁극기
      damage: 2500,            // 1레벨 기준
      speed: 760,
      radius: 9,
      lifetime: 1.3,           // 사거리 ≈ 988px
      pierceWalls: true,       // 벽(장애물)을 그대로 통과
      visual: 'thorn',
    },
    gadget: {
      name: '폭탄 똥',
      type: 'poopBomb',        // 조준한 방향으로 똥을 발사: 적/터렛/닭이나 벽에 닿으면(또는 사거리 끝에서) 폭발해서 범위 안의 적에게 피해
      explodeDamage: 1500,     // 폭발 피해 (1레벨 기준)
      explodeRadius: 130,      // 폭발 범위(px)
      speed: 520,
      radius: 14,
      lifetime: 1.1,           // 사거리 ≈ 572px
      visual: 'poopBomb',
    },
  },
};

// ===== 캐릭터 설명(캐릭터 선택 화면용) 자동 생성 =====
// 위 CHARACTERS 의 실제 수치에서 설명 문구를 만들어 클라이언트에 내려준다.
// 그래서 대미지/체력/시간 등을 바꾸면 캐릭터 선택 화면의 스펙도 자동으로 같이 바뀐다 (설명을 따로 고칠 필요 없음).
const fmtNum = (n) => Number(n).toLocaleString('en-US');
const fmtMult = (n) => String(Math.round(n * 100) / 100);
const rangeOf = (spec) => (spec.speed && spec.lifetime ? Math.round(spec.speed * spec.lifetime) : 0);

function describeBasic(b) {
  const parts = [];
  let damage = null;
  const poolLabel = b.type === 'skullwater' ? '물웅덩이' : b.type === 'poopgas' ? '똥가루 구름' : b.type === 'eggthrow' ? '흰자' : '웅덩이';

  if (b.type === 'combo') {
    // 시스템: 탄창 3개가 각각 다른 공격 + 공격마다 이동 방향으로 돌진
    b.combo.forEach((c, i) => {
      const r = rangeOf(c);
      if (c.pelletCount > 1) parts.push(`${i + 1}번째 탄창: ${c.name} ${c.pelletCount}개를 중심각 ${c.spreadDegrees}도 범위로 발사 (개당 ${fmtNum(c.damage)} 피해, 사거리 약 ${r})`);
      else parts.push(`${i + 1}번째 탄창: ${c.name} (${fmtNum(c.damage)} 피해, 사거리 약 ${r})`);
    });
    if (b.dash) parts.push(`공격할 때마다${b.dash.delay ? ` ${b.dash.delay}초 뒤에` : ''} 이동 중인 방향으로 약 ${fmtNum(Math.round(b.dash.speed * b.dash.duration))}px 돌진`);
    if (b.reloadAllAtOnce) parts.push(`탄창 ${MAX_AMMO}개를 모두 사용하면 ${b.ammoRegenSeconds}초 뒤에 한꺼번에 재장전`);
  } else if (b.type === 'charge') {
    // 똥파리: 탄창 없이 누르고 있는 동안 충전하는 공격
    parts.push(`탄창 없는 충전 공격: 누르고 있는 동안 최대 ${b.chargeTime}초까지 충전, 충전할수록 ${fmtNum(b.minDamage)}~${fmtNum(b.maxDamage)} 피해`);
    parts.push(`충전 중 이동속도 ${Math.round((1 - b.chargeSpeedMultiplier) * 100)}% 감소`);
    if (b.fireCooldown > 0) parts.push(`발사 후 ${b.fireCooldown}초 동안 다음 발사 불가`);
    const r = rangeOf(b);
    if (r) parts.push(`사거리 약 ${r}`);
  } else if (b.type === 'dash') {
    damage = b.damage;
    parts.push(`바라보는 방향으로 약 ${fmtNum(Math.round(b.speed * b.duration))}px를 돌진, 적을 관통하며 지나간 모든 적에게 ${fmtNum(b.damage)} 피해`);
  } else if (b.type === 'multiStab') {
    damage = b.damage;
    parts.push(`양손으로 ${b.stabCount}번 빠르게 찌름 (한 번당 ${fmtNum(b.damage)} 피해, 전방 ${b.angleDegrees}도, 사거리 ${b.range}로 짧음)`);
  } else if (b.type === 'quake') {
    damage = b.damage;
    parts.push(`망치를 내려쳐 조준 방향 전방 ${b.angleDegrees}도 부채꼴(사거리 ${b.range})에 지진을 일으켜 ${fmtNum(b.damage)} 피해 + ${b.stunDuration}초 기절${b.windup ? ` (공격 후 ${b.windup}초 뒤에 발동, 그동안 이동 불가)` : ''}`);
  } else if (b.type === 'melee') {
    damage = b.damage;
    parts.push(`전방 ${b.angleDegrees}도 부채꼴 범위(사거리 ${b.range})를 휘둘러 ${fmtNum(b.damage)} 피해를 주고 ${b.knockback}만큼 뒤로 밀쳐냄`);
  } else if (b.currentHpRatio > 0) {
    // 진우Park의 하트: 고정 피해가 아니라 대상의 현재 체력 비율로 피해를 줌
    parts.push(`하트를 발사해 적의 현재 체력의 ${Math.round(b.currentHpRatio * 100)}% 피해 (보호막이 있으면 보호막까지 합친 체력 기준)${b.executeBelowHp > 0 ? `, 맞은 적의 체력이 ${fmtNum(b.executeBelowHp)} 이하면 즉사` : ''}`);
    const r = rangeOf(b);
    if (r) parts.push(`사거리 약 ${r}`);
  } else if (b.poolOnImpact) {
    // 해골물 / 똥가루 / 계란처럼 맞은 자리에 웅덩이를 남기는 공격
    if (b.pelletCount > 1) parts.push(`${b.pelletCount}발 동시 발사`);
    if (b.directDamage > 0) parts.push(`적 직접 적중 시 ${fmtNum(b.directDamage)} 피해`);
    const pool = [`닿은 적에게 ${b.poolTickInterval}초마다 ${fmtNum(b.poolDamage)} 피해`];
    if (b.poolHeal > 0) pool.push(`아군 ${b.poolTickInterval}초마다 ${fmtNum(b.poolHeal)} 회복`);
    pool.push(`${b.poolLifetime}초 후 소멸`);
    pool.push('적 터렛·닭도 피해');
    parts.push(`${poolLabel} 생성 (${pool.join(', ')})`);
    if (b.poolOnExpire) parts.push('최대 사거리에서도 깨짐');
    const r = rangeOf(b);
    if (r) parts.push(`사거리 약 ${r}`);
  } else if (b.pelletCount > 1) {
    parts.push(`펠릿 ${b.pelletCount}발 동시 발사 (발당 ${fmtNum(b.damage)} 피해, 탄퍼짐 ${b.spreadDegrees}도)`);
    const r = rangeOf(b);
    if (r) parts.push(`사거리 약 ${r}`);
  } else {
    damage = b.damage;
    const r = rangeOf(b);
    if (r) parts.push(`사거리 약 ${r}`);
  }
  if (b.pierceWalls) parts.push('벽(장애물)을 그대로 통과');
  if (b.ammoRegenSeconds && b.ammoRegenSeconds > AMMO_REGEN_SECONDS) {
    parts.push(`재장전 시간 ${Math.round((b.ammoRegenSeconds / AMMO_REGEN_SECONDS - 1) * 100)}% 증가`);
  } else if (b.ammoRegenSeconds && b.ammoRegenSeconds < AMMO_REGEN_SECONDS) {
    parts.push(`재장전 속도 ${Math.round((AMMO_REGEN_SECONDS / b.ammoRegenSeconds - 1) * 100)}% 빠름`);
  }
  return { name: b.name, damage, desc: parts.join(', ') };
}

function describeUltimate(u) {
  let damage = null;
  let desc = '';
  switch (u.type) {
    case 'projectile': {
      const r = rangeOf(u);
      if (u.launchDuration > 0) {
        desc = `조준한 방향으로 거대한 소용돌이를 발사${r ? ` (사거리 약 ${r})` : ''}${u.pierceWalls ? ', 벽을 통과함' : ''}. 맞은 적들(관통)은 ${u.launchDuration}초 동안 하늘로 떠올라 조작 불가가 되고, 땅에 떨어질 때 ${fmtNum(u.landDamage)} 피해`;
      } else if (u.pelletCount > 1) {
        desc = `조준한 방향으로 큰 총알 ${u.pelletCount}발 발사 (발당 ${fmtNum(u.damage)} 피해${r ? `, 사거리 약 ${r}` : ''})`;
      } else {
        damage = u.damage;
        desc = `조준한 방향으로 발사${r ? ` (사거리 약 ${r})` : ''}${u.pierceWalls ? ', 벽을 통과함' : ''}`;
      }
      break;
    }
    case 'lightning':
      damage = u.damage;
      desc = `주변 고정된 위치에 번개 ${u.strikeCount}회 낙하 (조준 불필요)`;
      break;
    case 'stealth':
      desc = `${u.duration}초 동안 적에게 보이지 않음`;
      break;
    case 'dash':
      desc = `바라보는 방향으로 매우 빠르게 돌진, 적을 관통하며 지나간 모든 적에게 ${fmtNum(u.damage)} 피해 + ${u.stunDuration}초 기절`;
      break;
    case 'turret':
      desc = `조준 불필요, 체력 ${fmtNum(u.hp)}의 자동 사격 터렛을 설치 (사거리 ${u.range}, ${u.fireInterval}초마다 ${fmtNum(u.damage)} 피해 저격탄 발사)`;
      break;
    case 'heal':
      desc = '조준 불필요, 즉시 체력을 가득 채움';
      break;
    case 'timedBomb':
      desc = `조준 불필요, 자신의 위치에 설치. 반경 ${u.radius} 안의 적에게 ${u.tickInterval}초마다 ${fmtNum(u.tickDamage)} 피해 + 이동속도 ${Math.round((1 - u.slowMultiplier) * 100)}% 감소, ${u.fuseTime}초 뒤 ${fmtNum(u.explodeDamage)} 피해로 폭발`;
      break;
    case 'burst': {
      const r = rangeOf(u);
      desc = `조준한 방향으로 고추 ${u.bulletCount}개를 연달아 발사 (개당 ${fmtNum(u.damage)} 피해${r ? `, 사거리 약 ${r}` : ''})`;
      break;
    }
    case 'leap':
      damage = u.damage;
      desc = `조준한 방향으로 벽을 무시하고 점프, 거리는 조준으로 ${fmtNum(u.minDistance || 0)}~${fmtNum(u.distance)}px 조절 (공중에서는 피격 불가), 착지 지점 반경 ${u.landRadius} 안의 적에게 ${fmtNum(u.damage)} 피해${u.knockback ? ` + ${fmtNum(u.knockback)}만큼 밀쳐냄` : ''}`;
      break;
    case 'quake':
      damage = u.damage;
      desc = `망치를 매우 강하게 내리쳐 조준 방향 전방 ${u.angleDegrees}도 부채꼴(사거리 ${u.range})의 적에게 ${fmtNum(u.damage)} 피해 + ${u.stunDuration}초 기절`;
      break;
    case 'summonChicken':
      desc = `조준 불필요, 체력 ${fmtNum(u.hp)}의 닭을 소환. ${u.duration}초 동안 적을 자동으로 추격하다가 사거리 안에 들어오면 적에게 돌격해서 ${fmtNum(u.damage)} 피해 (${u.attackInterval}초마다 돌격 가능)`;
      break;
    default:
      if (u.damage) damage = u.damage;
  }
  return { name: u.name, damage, desc };
}

function describeGadget(g) {
  let desc = '';
  switch (g.type) {
    case 'burst':
      desc = `조준한 방향으로 총알 ${g.bulletCount}발을 빠르게 연달아 발사, 발당 ${fmtNum(g.damage)} 피해`;
      break;
    case 'reloadAmmo':
      desc = '즉시 탄창을 가득 채움';
      break;
    case 'shield':
      desc = `${fmtNum(g.shieldHp)} 피해를 막아주는 보호막을 두름 (다 막으면 사라짐)`;
      break;
    case 'invincible':
      desc = `${g.duration}초 동안 모든 피해를 받지 않음`;
      break;
    case 'speedBoost':
      desc = `${g.duration}초 동안 이동속도 ${fmtMult(g.speedMultiplier)}배`;
      break;
    case 'sprint':
      desc = `조준한 방향으로 ${fmtNum(Math.round(g.speed * g.duration))}px를 순식간에 돌진, 피해나 기절을 주지 않는 도주용 (적을 통과함)`;
      break;
    case 'reloadBoost':
      desc = `${g.duration}초 동안 재장전 속도 ${Math.round((g.speedMultiplier - 1) * 100)}% 빨라짐`;
      break;
    case 'heal':
      desc = `체력을 즉시 ${fmtNum(g.healAmount)} 회복 (최대 체력까지)`;
      break;
    case 'ultCharge':
      desc = `${g.duration}초에 걸쳐 궁극기 게이지를 ${g.amount}%만큼 천천히 채움`;
      break;
    case 'powerCharge':
      desc = `${g.chargeTime}초 동안 이동/공격 불가 상태가 되지만, 이후 ${g.boostDuration}초 동안 공격력 ${fmtMult(g.damageMultiplier)}배`;
      break;
    case 'poopBomb': {
      const r = rangeOf(g);
      desc = `조준한 방향으로 폭발하는 똥을 발사${r ? ` (사거리 약 ${r})` : ''}. 적이나 벽에 닿으면 폭발해서 반경 ${g.explodeRadius} 안의 적에게 ${fmtNum(g.explodeDamage)} 피해`;
      break;
    }
    default:
      break;
  }
  return { name: g.name, desc: desc ? `${desc} (${GADGET_COOLDOWN_SEC}초마다 사용 가능)` : '' };
}

// ===== 캐릭터 강화(레벨) 시스템 =====
// 코인으로 캐릭터마다 1레벨 -> 11레벨까지 강화한다. 레벨은 캐릭터별로 따로 저장된다. (1레벨 = 기존 스펙 그대로)
// hp: 체력 배율 / atk: 공격력 배율 (기본공격·궁극기·가젯·물웅덩이·폭탄 등 모든 대미지에 적용) / cost: 이 레벨로 올리는 데 드는 코인
// 밸런스 기준: 11레벨 = 체력 +35%, 공격력 +30%. (1레벨 상대로 맞붙으면 약 1.75배 유리 -> 실력으로 뒤집을 수 있는 수준)
// 레벨 1->11 강화 총비용은 2,720코인 (1:1 승리 보상 45코인 기준 약 60승). 수치를 바꾸고 싶으면 이 표만 고치면 된다.
const MAX_CHARACTER_LEVEL = 11;
const LEVEL_TABLE = [
  null, // 0번 칸은 사용하지 않음 (레벨은 1부터)
  { hp: 1.000, atk: 1.00, cost: 0 },
  { hp: 1.035, atk: 1.03, cost: 40 },
  { hp: 1.070, atk: 1.06, cost: 60 },
  { hp: 1.105, atk: 1.09, cost: 90 },
  { hp: 1.140, atk: 1.12, cost: 130 },
  { hp: 1.175, atk: 1.15, cost: 180 },
  { hp: 1.210, atk: 1.18, cost: 240 },
  { hp: 1.245, atk: 1.21, cost: 320 },
  { hp: 1.280, atk: 1.24, cost: 420 },
  { hp: 1.315, atk: 1.27, cost: 540 },
  { hp: 1.350, atk: 1.30, cost: 700 },
];
const LEVEL_TABLE_PUBLIC = LEVEL_TABLE.slice(1).map((t, i) => ({ level: i + 1, hp: t.hp, atk: t.atk, cost: t.cost }));
const DAMAGE_KEYS = new Set(['damage', 'minDamage', 'maxDamage', 'directDamage', 'poolDamage', 'tickDamage', 'explodeDamage', 'landDamage']); // 공격력 배율을 적용할 수치 이름
function clampLevel(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_CHARACTER_LEVEL);
}
function levelOf(u, charId) { return clampLevel(u && u.levels && u.levels[charId]); }
function roundTo(v, unit) { return Math.round(v / unit) * unit; }
function scaleDamageDeep(value, mult) {
  if (Array.isArray(value)) return value.map((v) => scaleDamageDeep(v, mult));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      const v = value[k];
      out[k] = DAMAGE_KEYS.has(k) && typeof v === 'number' ? roundTo(v * mult, 5) : scaleDamageDeep(v, mult);
    }
    return out;
  }
  return value;
}
// 레벨이 적용된 캐릭터 스펙: 체력과 모든 대미지 수치를 배율만큼 키운 복사본 (1레벨은 원본 그대로). 서버가 직접 계산하므로 클라이언트는 조작할 수 없다.
// 소환물(터렛/닭)의 체력과 보호막 수치는 그대로 두고, 소환물이 주는 대미지만 공격력 배율을 받는다.
const leveledCharacterCache = new Map();
function getLeveledCharacter(id, level) {
  const base = CHARACTERS[id] || CHARACTERS[DEFAULT_CHARACTER_ID];
  const lv = clampLevel(level);
  if (lv === 1) return base;
  const cacheKey = `${base.id}:${lv}`;
  let c = leveledCharacterCache.get(cacheKey);
  if (!c) {
    const t = LEVEL_TABLE[lv];
    c = {
      ...base,
      maxHp: roundTo(base.maxHp * t.hp, 10),
      basic: scaleDamageDeep(base.basic, t.atk),
      ultimate: scaleDamageDeep(base.ultimate, t.atk),
      gadget: base.gadget ? scaleDamageDeep(base.gadget, t.atk) : base.gadget,
    };
    leveledCharacterCache.set(cacheKey, c);
  }
  return c;
}

const characterInfoCache = new Map();
function buildCharacterInfo(levels) {
  const out = {};
  for (const id in CHARACTERS) {
    const lv = clampLevel(levels && levels[id]);
    const cacheKey = `${id}:${lv}`;
    let info = characterInfoCache.get(cacheKey);
    if (!info) {
      const c = getLeveledCharacter(id, lv);
      info = {
        id,
        name: c.name,
        level: lv,
        maxHp: c.maxHp,
        basic: describeBasic(c.basic),
        ultimate: describeUltimate(c.ultimate),
        gadget: c.gadget ? describeGadget(c.gadget) : null,
      };
      characterInfoCache.set(cacheKey, info);
    }
    out[id] = info;
  }
  return out;
}
const DEFAULT_CHARACTER_ID = 'minam';

// ===== 쿠폰(코드) 설정 =====
// 코드 입력창에 이 코드를 입력하면 코인을 받는다. 코드는 대문자로 적고(입력은 대소문자/공백 상관없음),
// 계정당 같은 코드는 한 번만 사용할 수 있다. 코드를 추가/변경하려면 여기만 고치면 된다.
const REDEEM_CODES = {
  'FREE1972': { coins: 200 },
  'SIU1972': { coins: 500 },
};
function normalizeCode(raw) {
  return String(raw || '').replace(/\s+/g, '').toUpperCase();
}

// ===== 이벤트 설정 =====
// 진행 중인 이벤트는 메인화면에 카드로 뜨고, 계정마다 한 번씩 코인을 받을 수 있다. (신규 가입자도 가입 후 받을 수 있음)
// 이벤트를 끝내려면: enabled 를 false 로 바꾸거나, endsAt 에 종료 시각(예: new Date('2026-10-31T23:59:59+09:00').getTime())을 넣고 재배포.
// 새 이벤트를 추가하려면 id 가 겹치지 않게 항목을 하나 더 적으면 된다. (이미 받은 기록은 id 기준으로 저장되어, id 를 바꾸면 모두 다시 받을 수 있게 됨)
const EVENTS = [
  { id: 'anggimochi', enabled: true, name: '앙기모찌', coins: 2000, desc: '모든 유저에게 2,000코인을 무료로 드려요!', endsAt: null },
];
function eventClaimCode(ev) { return `EVENT:${ev.id}`; } // 받은 기록은 쿠폰 사용 기록(redeemed)에 함께 저장 (유저가 코드창에 직접 입력해서 받을 수는 없음)
function activeEvents() {
  const now = Date.now();
  return EVENTS.filter((e) => e.enabled && (!e.endsAt || now < e.endsAt));
}

// ===== 계정 / 코인 / 캐릭터 잠금해제 시스템 =====
// 가격이 0인 캐릭터는 모든 계정이 처음부터 사용할 수 있고, 나머지는 코인으로 잠금해제해야 함 (가격은 여기서 자유롭게 수정)
const CHARACTER_PRICES = {
  minam: 0,
  jigi: 0,
  syu: 100,
  wonhyo: 150,
  byeongitong: 150,
  seongseureopda: 200,
  yeoddongi: 200,
  bobae: 250,
  ekhe: 300,
  gwari: 300,
  mocha: 300,
  uphal: 300,
  jinwoopark: 300,
  system: 300,
  ddongpari: 300,
};
CHARACTER_PRICES[DEFAULT_CHARACTER_ID] = 0; // 기본 캐릭터는 항상 무료 (사용 가능한 캐릭터가 하나도 없는 상황 방지)
function priceOf(id) {
  return Object.prototype.hasOwnProperty.call(CHARACTER_PRICES, id) ? CHARACTER_PRICES[id] : 200; // 가격표에 없는 새 캐릭터의 기본 가격
}
const FREE_CHARACTER_IDS = Object.keys(CHARACTERS).filter((id) => priceOf(id) === 0);
function allPrices() {
  const out = {};
  for (const id in CHARACTERS) out[id] = priceOf(id);
  return out;
}
function effectiveUnlocked(u) {
  return Array.from(new Set([...FREE_CHARACTER_IDS, ...(u.unlocked || [])])).filter((id) => CHARACTERS[id]);
}
// 캐릭터별 트로피 등급 (min: 해당 등급이 되기 위한 최소 트로피). 패배하면 트로피가 깎이므로 등급도 내려갈 수 있음
// step이 있는 등급은 끝없이 이어지는 단계 등급이다: min부터 step마다 1단계씩 올라간다.
// 마스터: 1000이상 마스터1, 2000이상 마스터2, 3000이상 마스터3 ... (단계 계산은 클라이언트 rankInfo에서 함)
const TROPHY_RANKS = [
  { name: '브론즈', icon: '🥉', min: 0 },
  { name: '실버', icon: '🥈', min: 100 },
  { name: '골드', icon: '🥇', min: 300 },
  { name: '다이아', icon: '💎', min: 600 },
  { name: '마스터', icon: '👑', min: 1000, step: 1000 },
];
// ===== 랭킹 =====
// 순위 기준: 모든 캐릭터의 트로피 총합(많을수록 위). 총합이 같으면 승수 > 이름 순으로 정렬하고, 총합이 같은 사람은 같은 순위를 쓴다.
// 트로피가 0인 계정은 랭킹 목록에 올리지 않는다 (내 순위는 0이어도 계산해서 보여줌).
const RANKING_LIMIT = 50;          // 랭킹 화면에 보여줄 최대 인원
const RANKING_CACHE_MS = 10 * 1000; // 상위 목록 캐시 시간 (요청이 몰려도 DB 조회를 줄이기 위함)
function trophyTotal(u) {
  let sum = 0;
  for (const id in CHARACTERS) sum += (u.trophies && u.trophies[id]) || 0; // 삭제된 캐릭터의 옛 트로피는 합산하지 않음
  return sum;
}
// 이미 정렬된 목록에 순위를 붙인다 (총합이 같으면 같은 순위)
function withRanks(rows) {
  let rank = 0;
  let prevTotal = null;
  return rows.map((r, i) => {
    if (r.total !== prevTotal) { rank = i + 1; prevTotal = r.total; }
    return { ...r, rank };
  });
}
let rankingCache = { at: 0, top: null };

// ===== 일일 미션 =====
// 미션은 매일 0시(한국 시간)에 진행도와 보상 수령 기록이 초기화된다.
// 진행도는 '점수로 승패가 갈린 정상 종료 매치'에서만 올라간다 (상대가 나가서 끝난 매치는 제외 - 부계정으로 쉽게 올리는 것을 방지).
// metric: play(매치 1판) / win(승리 1회) / kills(그 매치에서 처치한 수) / win2v2(2:2 승리 1회)
// 새 미션을 추가하거나 보상(reward, 코인)/목표(goal)를 바꾸려면 여기만 고치면 된다.
const MISSIONS = [
  { id: 'play3', name: '매치 3판 플레이', metric: 'play', goal: 3, reward: 30 },
  { id: 'win2', name: '매치 2번 승리', metric: 'win', goal: 2, reward: 50 },
  { id: 'kill15', name: '적 15명 처치', metric: 'kills', goal: 15, reward: 40 },
  { id: 'win2v2', name: '2:2 매치 1번 승리', metric: 'win2v2', goal: 1, reward: 40 },
];
function missionDay() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // 한국 시간(UTC+9) 기준 날짜 YYYY-MM-DD
}
// 한 매치 결과(이긴 여부, 모드, 처치 수)를 미션별 증가량으로 변환
function missionIncrements(won, mode, kills) {
  const incs = {};
  for (const m of MISSIONS) {
    const v = m.metric === 'play' ? 1
      : m.metric === 'win' ? (won ? 1 : 0)
      : m.metric === 'kills' ? kills
      : m.metric === 'win2v2' ? (won && mode === '2v2' ? 1 : 0)
      : 0;
    if (v > 0) incs[m.id] = v;
  }
  return incs;
}
function missionsView(u) {
  const m = u.missions && u.missions.day === missionDay() ? u.missions : { progress: {}, claimed: [] };
  return MISSIONS.map((ms) => ({
    id: ms.id,
    name: ms.name,
    goal: ms.goal,
    reward: ms.reward,
    progress: Math.min(ms.goal, (m.progress && m.progress[ms.id]) || 0),
    claimed: (m.claimed || []).includes(ms.id),
  }));
}

// ===== 공지사항 =====
// 메인 화면의 '공지사항' 버튼을 누르면 보이는 목록이다 (위에 있을수록 최신). 새 공지를 올리려면 배열 맨 앞에 항목을 추가하면 된다.
// id 는 겹치지 않게 (클라이언트는 가장 최신 공지의 id 를 기억해서, 아직 안 읽은 공지가 있으면 버튼에 빨간 점을 띄운다)
// date: 표시용 날짜 문자열 / tag: 'new'(신규) | 'balance'(밸런스) | 'fix'(수정) | 'etc' / items: 항목별 한 줄 설명
const ANNOUNCEMENTS = [
  {
    id: '2026-10-07-ddongpari-gadget',
    date: '2026-10-07',
    tag: 'new',
    title: '똥파리 가젯 추가!',
    items: [
      '똥파리에게 가젯 [폭탄 똥]이 생겼어요.',
      '조준한 방향으로 똥을 발사해요. 적이나 벽에 닿으면 폭발해서 반경 130 안의 적에게 1,500 피해(1레벨 기준)를 줘요.',
      '아무것도 맞히지 못해도 사거리 끝에서 폭발해요. 사용 후 15초 뒤에 다시 쓸 수 있어요.',
    ],
  },
  {
    id: '2026-10-07-ddongpari',
    date: '2026-10-07',
    tag: 'new',
    title: '신규 캐릭터 「똥파리」 출시!',
    items: [
      '탄창 없이 충전해서 쏘는 캐릭터 똥파리가 추가되었어요. 🪙 300 코인으로 잠금해제할 수 있어요. (체력 5,500)',
      '기본공격 [똥 날리기]: 공격 버튼을 누르고 있는 동안 충전해요. 오래 충전할수록 피해가 800 ~ 3,000(1레벨 기준)까지 세져요. 최대 3초 충전, 손을 떼면 발사!',
      '똥을 발사하면 1.5초 동안은 다음 똥을 발사할 수 없어요.',
      '충전하는 동안에는 이동속도가 30% 느려져요. 기절하거나 쓰러지면 충전이 취소돼요.',
      '궁극기 [가시 발사]: 벽(장애물)을 통과하는 가시를 조준한 방향으로 발사해 2,500 피해(1레벨 기준)를 줘요.',
    ],
  },
  {
    id: '2026-10-07-system-ult-wall',
    date: '2026-10-07',
    tag: 'balance',
    title: '시스템 궁극기 변경',
    items: [
      '시스템 궁극기 [거대 소용돌이]가 이제 벽(장애물)에 닿아도 사라지지 않고 그대로 통과해요. (맵 가장자리에서는 사라져요)',
    ],
  },
  {
    id: '2026-10-07-system-nerf',
    date: '2026-10-07',
    tag: 'balance',
    title: '시스템 밸런스 조정',
    items: [
      '시스템 체력: 6,500 → 6,000 (1레벨 기준)',
    ],
  },
  {
    id: '2026-10-07-fewer-walls',
    date: '2026-10-07',
    tag: 'etc',
    title: '맵 벽 줄이기',
    items: [
      '모든 맵의 벽 수를 줄여서 시야와 이동이 더 시원해졌어요. (고전 사원: 벽 9개 → 5개, 사거리: 벽 12개 → 6개)',
    ],
  },
  {
    id: '2026-10-07-jinwoopark-buff',
    date: '2026-10-07',
    tag: 'balance',
    title: '진우Park 버프',
    items: [
      '진우Park 기본공격(하트 발사하기) 피해: 적 현재 체력의 25% → 30% (보호막이 있으면 보호막까지 합친 체력 기준)',
    ],
  },
  {
    id: '2026-10-07-dash-pierce',
    date: '2026-10-07',
    tag: 'balance',
    title: '돌진 공격 개선',
    items: [
      '피해를 주는 모든 돌진 공격(꽈리의 돌진 박치기, 변기통의 변기 돌진)이 이제 적을 관통해요. 닿는 순간 멈추지 않고 그대로 지나가며, 지나간 적마다 한 번씩 피해와 기절을 줘요.',
      '돌진이 더 자연스럽게 보이도록 움직임을 부드럽게 다듬었어요. 처음엔 빠르다가 점점 느려지며 멈춰요.',
      '돌진 중 벽에 닿으면 튕겨나가거나 벽을 따라 미끄러지지 않고, 닿은 자리에서 그대로 멈춰요.',
      '시스템의 돌진은 총알을 쏜 0.2초 뒤에 시작돼요.',
    ],
  },
  {
    id: '2026-10-06-system',
    date: '2026-10-06',
    tag: 'new',
    title: '신규 캐릭터 「시스템」 출시!',
    items: [
      '탄창이 특별한 캐릭터 시스템이 추가되었어요. 🪙 300 코인으로 잠금해제할 수 있어요. (체력 6,000)',
      '기본공격 [시스템 콤보]: 탄창 3개가 각각 다른 공격이에요. 1번 탄창은 원거리 구슬(1,000 피해), 2번 탄창은 중거리로 던지는 구슬(1,500 피해), 3번 탄창은 중심각 90도 범위로 소용돌이 3개를 날려요(개당 3,000 피해, 사거리 약 150).',
      '탄창 3개를 모두 사용해야 3초 뒤에 한꺼번에 재장전돼요.',
      '공격할 때마다 지금 이동 중인 방향으로 짧게 돌진해요. (가만히 서 있을 땐 돌진하지 않아요)',
      '궁극기 [거대 소용돌이]: 거대한 소용돌이를 날려 맞은 적들을 하늘로 띄워요. 벽에 닿아도 사라지지 않고 통과해요. 떠 있는 동안은 움직일 수 없고, 땅에 떨어질 때 1,500 피해를 입어요.',
      '가젯 [긴급 재장전]: 탄창을 즉시 가득 채워요.',
    ],
  },
  {
    id: '2026-10-05-jinwoopark-uphal-balance',
    date: '2026-10-05',
    tag: 'balance',
    title: '진우Park · 업할 밸런스 조정',
    items: [
      '진우Park 궁극기 [소다Bang] 피해: 3,000 → 2,000 (1레벨 기준)',
      '진우Park 궁극기 [소다Bang] 최대 점프 거리: 300 → 180 (40% 감소)',
      '업할 체력: 9,000 → 10,000 (1레벨 기준)',
    ],
  },
  {
    id: '2026-10-05-jinwoopark',
    date: '2026-10-05',
    tag: 'new',
    title: '신규 캐릭터 「진우Park」 출시!',
    items: [
      '하트를 쏘는 캐릭터 진우Park이 추가되었어요. 🪙 300 코인으로 잠금해제할 수 있어요. (체력 6,500)',
      '기본공격 [하트 발사하기]: 중거리로 하트를 발사해 맞은 적의 현재 체력의 30% 피해를 줘요. 보호막이 있으면 보호막까지 합친 체력의 30%예요.',
      '하트에 맞은 적의 체력이 750 이하라면 즉사해요!',
      '궁극기 [소다Bang]: 벽을 무시하고 조준한 방향으로 중거리(100~180)를 점프해, 착지 지점 주변 적에게 2,000 피해를 주고 바깥으로 밀쳐내요. 점프 중에는 공격을 받지 않아요.',
      '가젯 [소다 마시기]: 체력을 즉시 2,000 회복해요.',
    ],
  },
  {
    id: '2026-10-05-uphal-mocha-balance',
    date: '2026-10-05',
    tag: 'balance',
    title: '업할 · 모카 밸런스 조정',
    items: [
      '업할 기본공격(망치 지진) 공격 범위: 40도 → 28도 (30% 감소)',
      '업할 기본공격(망치 지진) 사거리: 280 → 196 (30% 감소)',
      '업할 기본공격(망치 지진) 기절 시간: 0.5초 → 0.3초',
      '업할 기본공격(망치 지진)은 이제 공격 버튼을 누른 뒤 1초 뒤에 발동해요. 그동안 이동할 수 없지만 조준 방향은 돌릴 수 있고, 발동 전에는 붉은 경고 범위가 표시돼요. 선딜 중 기절하면 공격이 취소돼요.',
      '모카 기본공격(양손 찌르기) 사거리: 75 → 90 (20% 증가)',
      '모카 궁극기(도약 강습) 최대 점프 거리: 380 → 304 (20% 감소)',
      '모카 기본공격 판정 개선: 상대 몸이 부채꼴 가장자리에 조금만 걸쳐도 맞고, 위치 오차를 감안한 추가 판정 거리도 생겼어요.',
    ],
  },
  {
    id: '2026-10-05-jigi-balance',
    date: '2026-10-05',
    tag: 'balance',
    title: '지기 밸런스 조정',
    items: [
      '지기 기본공격(던지기) 피해: 2,500 → 2,000 (1레벨 기준)',
      '지기 기본공격(던지기) 탄속: 420 → 360 (조금 느려졌어요. 사거리는 그대로예요)',
    ],
  },
  {
    id: '2026-10-05-halloween-teaser',
    date: '2026-10-05',
    tag: 'etc',
    title: '🎃 할로윈 이벤트 예고!',
    items: [
      '곧 할로윈 이벤트가 찾아와요! 🎃👻',
      '이벤트 내용과 기간은 준비되는 대로 공지사항으로 알려드릴게요. 조금만 기다려 주세요!',
    ],
  },
  {
    id: '2026-10-05-gwari-balance',
    date: '2026-10-05',
    tag: 'balance',
    title: '꽈리 밸런스 조정',
    items: [
      '꽈리 기본공격 [돌진 박치기] 돌진 거리: 약 198 → 약 129 (35% 감소)',
    ],
  },
  {
    id: '2026-10-05-uphal',
    date: '2026-10-05',
    tag: 'new',
    title: '신규 캐릭터 「업할」 출시!',
    items: [
      '망치를 휘두르는 탱커 캐릭터 업할이 추가되었어요. 🪙 300 코인으로 잠금해제할 수 있어요. (체력 9,000)',
      '기본공격 [망치 지진]: 조준 방향으로 중거리 지진을 일으켜 2,000 피해를 주고 0.5초 동안 기절시켜요.',
      '궁극기 [대지 강타]: 망치를 매우 강하게 내리쳐 더 넓고 먼 범위의 적에게 3,000 피해 + 2초 기절!',
      '가젯 [방어막]: 3,000 피해를 막아주는 방어막을 즉시 얻어요.',
    ],
  },
  {
    id: '2026-10-05-mocha',
    date: '2026-10-05',
    tag: 'new',
    title: '신규 캐릭터 「모카」 출시!',
    items: [
      '어쌔신 캐릭터 모카가 추가되었어요. 🪙 300 코인으로 잠금해제할 수 있어요.',
      '기본공격 [양손 찌르기]: 양손으로 4번 빠르게 찌릅니다. (한 번당 450 피해, 사거리 짧음, 재장전 속도 50% 빠름)',
      '궁극기 [도약 강습]: 벽을 무시하고 조준한 방향으로 점프해 착지 지점 주변 적에게 1,000 피해! 점프 중에는 공격을 받지 않아요.',
      '점프 거리는 조준으로 조절할 수 있어요. (PC: 마우스 위치 / 모바일: 오른쪽 스틱을 당긴 정도, 100~380)',
      '가젯 [기합 충전]: 4초에 걸쳐 궁극기 게이지를 50% 채웁니다.',
    ],
  },
  {
    id: '2026-10-05-mocha-balance',
    date: '2026-10-05',
    tag: 'balance',
    title: '모카 밸런스 조정',
    items: [
      '모카 체력: 5,500 → 4,500 (1레벨 기준)',
      '모카 기본공격 피해: 500 → 450 (1레벨 기준, 찌르기 한 번당)',
    ],
  },
  {
    id: '2026-10-05-dash-fix',
    date: '2026-10-05',
    tag: 'fix',
    title: '돌진 버그 수정',
    items: [
      '변기통의 궁극기와 꽈리의 기본공격으로 돌진한 직후 뒤로 밀려나던 문제를 수정했어요.',
      '돌진뿐 아니라 기절/넉백이 끝난 직후에도 위치가 튀던 현상이 함께 개선되었어요.',
    ],
  },
];

// 개발자 모드에서 올린 공지(저장소에 보관) + 코드에 적힌 공지(ANNOUNCEMENTS)를 합친 전체 목록. 개발자 공지가 항상 위(최신)에 온다.
let customAnnouncements = []; // 최신순
const MAX_CUSTOM_ANNOUNCEMENTS = 100;
const NOTICE_TAGS = ['new', 'balance', 'fix', 'etc'];
function allAnnouncements() {
  return [...customAnnouncements.map(({ createdAt, ...a }) => ({ ...a, custom: true })), ...ANNOUNCEMENTS];
}

function publicProfile(u) {
  const trophies = {};
  for (const id in CHARACTERS) trophies[id] = (u.trophies && u.trophies[id]) || 0;
  const streaks = {};
  for (const id in CHARACTERS) streaks[id] = (u.streaks && u.streaks[id]) || 0;
  const levels = {};
  for (const id in CHARACTERS) levels[id] = levelOf(u, id);
  return { username: u.name, coins: u.coins, wins: u.wins || 0, losses: u.losses || 0, unlocked: effectiveUnlocked(u), prices: allPrices(), trophies, streaks, missions: missionsView(u), ranks: TROPHY_RANKS, characters: buildCharacterInfo(levels), levels, levelTable: LEVEL_TABLE_PUBLIC, maxLevel: MAX_CHARACTER_LEVEL, isAdmin: u.key === ADMIN_KEY, announcements: allAnnouncements(),
    events: activeEvents().map((e) => ({ id: e.id, name: e.name, coins: e.coins, desc: e.desc, endsAt: e.endsAt || null, claimed: (u.redeemed || []).includes(eventClaimCode(e)) })) };
}

// ----- 저장소 -----
// MONGODB_URI 환경변수가 있으면 MongoDB(영구 저장)를, 없으면 JSON 파일을 사용한다.
// 주의: Render는 재시작/재배포 때 서버 파일이 초기화되므로, 실제 서비스에서는 반드시 MONGODB_URI를 설정할 것.
// (정적 파일 서빙 폴더 밖인 임시 폴더를 기본값으로 써서, 계정 파일이 브라우저로 내려받아지지 않게 함)
const USERS_FILE = process.env.USERS_FILE || path.join(os.tmpdir(), 'brawl-users.json');
const ANNOUNCE_FILE = process.env.ANNOUNCE_FILE || path.join(os.tmpdir(), 'brawl-announcements.json'); // 개발자 모드로 올린 공지 (MongoDB를 쓰면 DB에 저장됨)

function cloneUser(u) {
  return u ? { ...u, unlocked: [...(u.unlocked || [])], trophies: { ...(u.trophies || {}) }, streaks: { ...(u.streaks || {}) }, levels: { ...(u.levels || {}) }, redeemed: [...(u.redeemed || [])], missions: u.missions ? { day: u.missions.day, progress: { ...(u.missions.progress || {}) }, claimed: [...(u.missions.claimed || [])] } : undefined } : null;
}

function createFileDb() {
  let users = {};
  let announcements = [];
  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const tmp = USERS_FILE + '.tmp';
      fs.writeFile(tmp, JSON.stringify(users), (err) => {
        if (err) return console.error('계정 파일 저장 실패', err);
        fs.rename(tmp, USERS_FILE, (e) => e && console.error('계정 파일 저장 실패', e));
      });
    }, 300);
  }
  return {
    kind: 'file',
    async init() {
      try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { users = {}; }
      console.warn(`[계정] JSON 파일 저장소 사용 중 (${USERS_FILE}). Render에서는 재시작 시 데이터가 사라질 수 있으니 MONGODB_URI 설정을 권장합니다.`);
    },
    async findUser(key) { return cloneUser(users[key]); },
    async createUser(u) {
      if (users[u.key]) return false;
      users[u.key] = cloneUser(u);
      scheduleSave();
      return true;
    },
    // newStreak: 그 캐릭터의 새 연승 수 (null이면 연승 기록을 건드리지 않음)
    async addResult(key, coins, won, charId, trophies, newStreak) {
      const u = users[key];
      if (!u) return null;
      u.coins += coins;
      if (trophies && charId) {
        u.trophies = u.trophies || {};
        u.trophies[charId] = Math.max(0, (u.trophies[charId] || 0) + trophies);
      }
      if (newStreak != null && charId) {
        u.streaks = u.streaks || {};
        u.streaks[charId] = newStreak;
      }
      if (won) u.wins = (u.wins || 0) + 1; else u.losses = (u.losses || 0) + 1;
      scheduleSave();
      return cloneUser(u);
    },
    async buyCharacter(key, charId, price) {
      const u = users[key];
      if (!u) return { ok: false, reason: 'noUser' };
      if (u.unlocked.includes(charId)) return { ok: false, reason: 'already', user: cloneUser(u) };
      if (u.coins < price) return { ok: false, reason: 'coins', user: cloneUser(u) };
      u.coins -= price;
      u.unlocked.push(charId);
      scheduleSave();
      return { ok: true, user: cloneUser(u) };
    },
    async upgradeCharacter(key, charId, fromLevel, cost) {
      const u = users[key];
      if (!u) return { ok: false, reason: 'noUser' };
      if (levelOf(u, charId) !== fromLevel) return { ok: false, reason: 'level', user: cloneUser(u) };
      if (u.coins < cost) return { ok: false, reason: 'coins', user: cloneUser(u) };
      u.coins -= cost;
      u.levels = u.levels || {};
      u.levels[charId] = fromLevel + 1;
      scheduleSave();
      return { ok: true, user: cloneUser(u) };
    },
    async redeemCode(key, code, coins) {
      const u = users[key];
      if (!u) return { ok: false, reason: 'noUser' };
      u.redeemed = u.redeemed || [];
      if (u.redeemed.includes(code)) return { ok: false, reason: 'used', user: cloneUser(u) };
      u.redeemed.push(code);
      u.coins += coins;
      scheduleSave();
      return { ok: true, user: cloneUser(u) };
    },
    // 미션 진행도 누적 (날짜가 바뀌었으면 먼저 초기화). incs: { 미션id: 증가량 }
    async addMissionProgress(key, day, incs) {
      const u = users[key];
      if (!u) return;
      if (!u.missions || u.missions.day !== day) u.missions = { day, progress: {}, claimed: [] };
      for (const id in incs) if (incs[id] > 0) u.missions.progress[id] = (u.missions.progress[id] || 0) + incs[id];
      scheduleSave();
    },
    // 미션 보상 수령: 목표 달성 + 아직 안 받은 경우에만 코인 지급
    async claimMission(key, day, missionId, goal, coins) {
      const u = users[key];
      if (!u) return { ok: false, reason: 'noUser' };
      if (!u.missions || u.missions.day !== day) u.missions = { day, progress: {}, claimed: [] };
      const m = u.missions;
      if (m.claimed.includes(missionId)) return { ok: false, reason: 'claimed', user: cloneUser(u) };
      if ((m.progress[missionId] || 0) < goal) return { ok: false, reason: 'notDone', user: cloneUser(u) };
      m.claimed.push(missionId);
      u.coins += coins;
      scheduleSave();
      return { ok: true, user: cloneUser(u) };
    },
    // 계정 정보 변경 (아이디 표시명/키, 비밀번호 해시). changes: { newKey, newName, salt, hash } - 바꿀 항목만 들어옴
    async updateAccount(key, changes) {
      const u = users[key];
      if (!u) return { ok: false, reason: 'noUser' };
      const newKey = changes.newKey || key;
      if (newKey !== key && users[newKey]) return { ok: false, reason: 'taken' };
      if (changes.newName) u.name = changes.newName;
      if (changes.salt && changes.hash) { u.salt = changes.salt; u.hash = changes.hash; }
      if (newKey !== key) { u.key = newKey; users[newKey] = u; delete users[key]; }
      scheduleSave();
      return { ok: true, user: cloneUser(u) };
    },
    // 트로피 총합 상위 목록 (총합 0 제외)
    async getRankingTop(limit) {
      const rows = Object.values(users)
        .map((u) => ({ key: u.key, name: u.name, total: trophyTotal(u), wins: u.wins || 0 }))
        .filter((r) => r.total > 0)
        .sort((a, b) => b.total - a.total || b.wins - a.wins || String(a.name).localeCompare(String(b.name)));
      return withRanks(rows.slice(0, limit));
    },
    // 내 순위 = 나보다 총합이 높은 사람 수 + 1
    async getRankOf(key) {
      const u = users[key];
      if (!u) return null;
      const total = trophyTotal(u);
      const higher = Object.values(users).filter((o) => trophyTotal(o) > total).length;
      return { name: u.name, total, rank: higher + 1, players: Object.keys(users).length };
    },
    async deleteUser(key) {
      if (!users[key]) return false;
      delete users[key];
      scheduleSave();
      return true;
    },
    // 마지막 접속 시각 기록 (유저 현황의 '오프라인' 표시용)
    async touchLastSeen(key) {
      const u = users[key];
      if (!u) return;
      u.lastSeenAt = Date.now();
      scheduleSave();
    },
    // 최근에 접속했던 순서로 계정 목록 (접속 기록이 없는 옛 계정은 맨 뒤)
    async getRecentUsers(limit) {
      return Object.values(users)
        .map((u) => ({ key: u.key, name: u.name, lastSeenAt: u.lastSeenAt || 0 }))
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt || String(a.name).localeCompare(String(b.name)))
        .slice(0, limit);
    },
    // 개발자 모드로 올린 공지 저장/삭제
    async loadAnnouncements() {
      try { announcements = JSON.parse(fs.readFileSync(ANNOUNCE_FILE, 'utf8')); } catch (e) { announcements = []; }
      return announcements.map((a) => ({ ...a }));
    },
    async addAnnouncement(a) {
      announcements.unshift({ ...a });
      fs.writeFile(ANNOUNCE_FILE, JSON.stringify(announcements), (err) => err && console.error('공지 파일 저장 실패', err));
    },
    async deleteAnnouncement(id) {
      const before = announcements.length;
      announcements = announcements.filter((a) => a.id !== id);
      if (announcements.length === before) return false;
      fs.writeFile(ANNOUNCE_FILE, JSON.stringify(announcements), (err) => err && console.error('공지 파일 저장 실패', err));
      return true;
    },
    async countUsers() { return Object.keys(users).length; },
    // 정지 / 정지 해제 / 현재 정지 중인 계정 목록 (개발자 모드)
    async setBan(key, until, reason) {
      const u = users[key];
      if (!u) return null;
      u.bannedUntil = until; u.banReason = reason; u.bannedAt = Date.now();
      scheduleSave();
      return cloneUser(u);
    },
    async clearBan(key) {
      const u = users[key];
      if (!u) return null;
      delete u.bannedUntil; delete u.banReason; delete u.bannedAt;
      scheduleSave();
      return cloneUser(u);
    },
    async getBannedUsers() {
      const now = Date.now();
      return Object.values(users)
        .filter((u) => u.bannedUntil && u.bannedUntil > now)
        .map((u) => ({ key: u.key, name: u.name, bannedUntil: u.bannedUntil, reason: u.banReason || '' }))
        .sort((a, b) => b.bannedUntil - a.bannedUntil)
        .slice(0, 100);
    },
  };
}

function createMongoDb(uri) {
  let col = null;
  let annCol = null;
  const projection = { _id: 0 };
  return {
    kind: 'mongo',
    async init() {
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(uri);
      await client.connect();
      col = client.db(process.env.MONGODB_DB || 'brawl').collection('users');
      annCol = client.db(process.env.MONGODB_DB || 'brawl').collection('announcements');
      await annCol.createIndex({ id: 1 }, { unique: true });
      await col.createIndex({ key: 1 }, { unique: true });
      await col.createIndex({ lastSeenAt: -1 }); // 유저 현황(최근 접속 순) 조회용
      console.log('[계정] MongoDB 연결 완료');
    },
    async findUser(key) { return col.findOne({ key }, { projection }); },
    async createUser(u) {
      try { await col.insertOne({ ...u }); return true; } catch (e) { if (e && e.code === 11000) return false; throw e; }
    },
    async addResult(key, coins, won, charId, trophies, newStreak) {
      const inc = { coins, wins: won ? 1 : 0, losses: won ? 0 : 1 };
      const path = `trophies.${charId}`; // charId는 서버가 검증한 캐릭터 id만 들어옴
      if (trophies && CHARACTERS[charId]) inc[path] = trophies;
      const update = { $inc: inc };
      if (newStreak != null && CHARACTERS[charId]) update.$set = { [`streaks.${charId}`]: newStreak };
      let user = await col.findOneAndUpdate({ key }, update, { returnDocument: 'after', projection });
      // 패배로 트로피가 0 미만이 되었다면 0으로 보정
      if (user && trophies < 0 && user.trophies && user.trophies[charId] < 0) {
        user = await col.findOneAndUpdate({ key }, { $set: { [path]: 0 } }, { returnDocument: 'after', projection });
      }
      return user;
    },
    async buyCharacter(key, charId, price) {
      // 코인 차감과 잠금해제를 한 번의 원자적 연산으로 처리 (중복 클릭/동시 요청으로 코인이 이중 차감되지 않음)
      const updated = await col.findOneAndUpdate(
        { key, coins: { $gte: price }, unlocked: { $ne: charId } },
        { $inc: { coins: -price }, $push: { unlocked: charId } },
        { returnDocument: 'after', projection }
      );
      if (updated) return { ok: true, user: updated };
      const user = await col.findOne({ key }, { projection });
      if (!user) return { ok: false, reason: 'noUser' };
      if ((user.unlocked || []).includes(charId)) return { ok: false, reason: 'already', user };
      return { ok: false, reason: 'coins', user };
    },
    async upgradeCharacter(key, charId, fromLevel, cost) {
      // 코인 차감과 레벨 상승을 한 번의 원자적 연산으로 처리 (중복 클릭/동시 요청으로 코인이 이중 차감되거나 레벨이 두 번 오르지 않음)
      const levelPath = `levels.${charId}`;
      const levelFilter = fromLevel === 1
        ? { $or: [{ [levelPath]: { $exists: false } }, { [levelPath]: 1 }] }
        : { [levelPath]: fromLevel };
      const updated = await col.findOneAndUpdate(
        { key, coins: { $gte: cost }, ...levelFilter },
        { $inc: { coins: -cost }, $set: { [levelPath]: fromLevel + 1 } },
        { returnDocument: 'after', projection }
      );
      if (updated) return { ok: true, user: updated };
      const user = await col.findOne({ key }, { projection });
      if (!user) return { ok: false, reason: 'noUser' };
      if (levelOf(user, charId) !== fromLevel) return { ok: false, reason: 'level', user };
      return { ok: false, reason: 'coins', user };
    },
    async redeemCode(key, code, coins) {
      // 사용 기록 확인과 코인 지급을 한 번의 원자적 연산으로 처리 (동시에 여러 번 눌러도 한 번만 지급됨)
      const updated = await col.findOneAndUpdate(
        { key, redeemed: { $ne: code } },
        { $inc: { coins }, $push: { redeemed: code } },
        { returnDocument: 'after', projection }
      );
      if (updated) return { ok: true, user: updated };
      const user = await col.findOne({ key }, { projection });
      if (!user) return { ok: false, reason: 'noUser' };
      return { ok: false, reason: 'used', user };
    },
    // 날짜가 바뀐 계정의 미션 기록을 오늘 것으로 초기화 (이미 오늘 날짜면 아무 일도 하지 않음)
    async resetMissionsIfNewDay(key, day) {
      await col.updateOne({ key, 'missions.day': { $ne: day } }, { $set: { missions: { day, progress: {}, claimed: [] } } });
    },
    async addMissionProgress(key, day, incs) {
      const inc = {};
      for (const id in incs) if (incs[id] > 0) inc[`missions.progress.${id}`] = incs[id]; // id는 서버가 정의한 미션 id만 들어옴
      if (!Object.keys(inc).length) return;
      await this.resetMissionsIfNewDay(key, day);
      await col.updateOne({ key }, { $inc: inc });
    },
    async claimMission(key, day, missionId, goal, coins) {
      await this.resetMissionsIfNewDay(key, day);
      // 달성 여부 확인 + 중복 수령 방지 + 코인 지급을 한 번의 원자적 연산으로 처리
      const updated = await col.findOneAndUpdate(
        { key, 'missions.day': day, [`missions.progress.${missionId}`]: { $gte: goal }, 'missions.claimed': { $ne: missionId } },
        { $inc: { coins }, $push: { 'missions.claimed': missionId } },
        { returnDocument: 'after', projection }
      );
      if (updated) return { ok: true, user: updated };
      const user = await col.findOne({ key }, { projection });
      if (!user) return { ok: false, reason: 'noUser' };
      if (user.missions && (user.missions.claimed || []).includes(missionId)) return { ok: false, reason: 'claimed', user };
      return { ok: false, reason: 'notDone', user };
    },
    async updateAccount(key, changes) {
      const set = {};
      if (changes.newName) set.name = changes.newName;
      if (changes.newKey && changes.newKey !== key) set.key = changes.newKey;
      if (changes.salt && changes.hash) { set.salt = changes.salt; set.hash = changes.hash; }
      try {
        // key에는 unique 인덱스가 있어서, 이미 있는 아이디로 바꾸려 하면 중복 오류(11000)로 거절된다
        const user = await col.findOneAndUpdate({ key }, { $set: set }, { returnDocument: 'after', projection });
        return user ? { ok: true, user } : { ok: false, reason: 'noUser' };
      } catch (e) {
        if (e && e.code === 11000) return { ok: false, reason: 'taken' };
        throw e;
      }
    },
    // 트로피 총합 계산식 (현재 존재하는 캐릭터의 트로피만 합산)
    _totalExpr() {
      const ids = Object.keys(CHARACTERS);
      return {
        $sum: {
          $map: {
            input: { $filter: { input: { $objectToArray: { $ifNull: ['$trophies', {}] } }, as: 't', cond: { $in: ['$$t.k', ids] } } },
            as: 't',
            in: '$$t.v',
          },
        },
      };
    },
    async getRankingTop(limit) {
      const rows = await col.aggregate([
        { $project: { _id: 0, key: 1, name: 1, wins: { $ifNull: ['$wins', 0] }, total: this._totalExpr() } },
        { $match: { total: { $gt: 0 } } },
        { $sort: { total: -1, wins: -1, name: 1 } },
        { $limit: limit },
      ]).toArray();
      return withRanks(rows);
    },
    async getRankOf(key) {
      const mine = await col.aggregate([
        { $match: { key } },
        { $project: { _id: 0, name: 1, total: this._totalExpr() } },
      ]).toArray();
      if (!mine.length) return null;
      const higher = await col.aggregate([
        { $project: { total: this._totalExpr() } },
        { $match: { total: { $gt: mine[0].total } } },
        { $count: 'n' },
      ]).toArray();
      const players = await col.estimatedDocumentCount();
      return { name: mine[0].name, total: mine[0].total, rank: (higher[0] ? higher[0].n : 0) + 1, players };
    },
    async deleteUser(key) {
      const r = await col.deleteOne({ key });
      return r.deletedCount > 0;
    },
    async touchLastSeen(key) {
      await col.updateOne({ key }, { $set: { lastSeenAt: Date.now() } });
    },
    async getRecentUsers(limit) {
      const rows = await col.find({}, { projection: { _id: 0, key: 1, name: 1, lastSeenAt: 1 } })
        .sort({ lastSeenAt: -1, name: 1 }).limit(limit).toArray();
      return rows.map((r) => ({ key: r.key, name: r.name, lastSeenAt: r.lastSeenAt || 0 }));
    },
    async loadAnnouncements() {
      return annCol.find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(200).toArray();
    },
    async addAnnouncement(a) { await annCol.insertOne({ ...a }); },
    async deleteAnnouncement(id) {
      const r = await annCol.deleteOne({ id });
      return r.deletedCount > 0;
    },
    async countUsers() { return col.estimatedDocumentCount(); },
    async setBan(key, until, reason) {
      return col.findOneAndUpdate({ key }, { $set: { bannedUntil: until, banReason: reason, bannedAt: Date.now() } }, { returnDocument: 'after', projection });
    },
    async clearBan(key) {
      return col.findOneAndUpdate({ key }, { $unset: { bannedUntil: '', banReason: '', bannedAt: '' } }, { returnDocument: 'after', projection });
    },
    async getBannedUsers() {
      const rows = await col.find({ bannedUntil: { $gt: Date.now() } }, { projection: { _id: 0, key: 1, name: 1, bannedUntil: 1, banReason: 1 } })
        .sort({ bannedUntil: -1 }).limit(100).toArray();
      return rows.map((r) => ({ key: r.key, name: r.name, bannedUntil: r.bannedUntil, reason: r.banReason || '' }));
    },
  };
}

const db = process.env.MONGODB_URI ? createMongoDb(process.env.MONGODB_URI) : createFileDb();

// ----- 비밀번호 해시 (Node 내장 scrypt, 별도 패키지 불필요) -----
const scryptAsync = util.promisify(crypto.scrypt);
async function hashPassword(password, saltHex) {
  const buf = await scryptAsync(password, Buffer.from(saltHex, 'hex'), 64);
  return buf.toString('hex');
}
function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
const DUMMY_SALT = crypto.randomBytes(16).toString('hex'); // 없는 아이디도 같은 시간이 걸리게 해서 아이디 존재 여부가 드러나지 않게 함

// ----- 무차별 대입 / 대량 가입 방지 (메모리 기반 간단한 제한) -----
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMITS = { loginFail: 8, register: 5, redeemFail: 10 }; // 10분 동안 허용되는 횟수
const rateBuckets = new Map();
function clientIp(socket) {
  const xff = String(socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || socket.handshake.address || 'unknown';
}
function isRateLimited(kind, id) {
  const b = rateBuckets.get(`${kind}:${id}`);
  return !!b && b.resetAt > Date.now() && b.count >= RATE_LIMITS[kind];
}
function hitRate(kind, id) {
  const k = `${kind}:${id}`;
  const now = Date.now();
  let b = rateBuckets.get(k);
  if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + RATE_WINDOW_MS }; rateBuckets.set(k, b); }
  b.count += 1;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) if (b.resetAt <= now) rateBuckets.delete(k);
}, 60 * 1000);

const USERNAME_RE = /^[A-Za-z0-9_가-힣]{2,12}$/;
function validateRegisterInput(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return '잘못된 요청입니다.';
  if (!USERNAME_RE.test(username)) return '아이디는 2~12자의 한글/영문/숫자/밑줄(_)만 사용할 수 있습니다.';
  if (password.length < 4 || password.length > 64) return '비밀번호는 4~64자여야 합니다.';
  return null;
}

// onlineUsers: 현재 로그인 중인 계정 -> 소켓 id (한 계정이 동시에 두 곳에서 접속하지 못하게 함)
const onlineUsers = new Map();

// ===== 접속 상태 / 접속 기기 =====
// 유저 현황(메인화면)에 보여줄 상태: 'battle'(전투 중) / 'online'(접속 중) / 'offline'(오프라인)
// 접속 기기는 클라이언트가 알려주는 값('mobile' | 'desktop')을 쓰되, 값이 없거나 이상하면 User-Agent로 추측한다.
// (표시용 정보일 뿐이라 클라이언트가 속여도 게임에는 영향이 없다)
const PRESENCE_LIST_LIMIT = 40;   // 유저 현황 목록에 보여줄 최대 인원
const PRESENCE_CACHE_MS = 3000;   // 오프라인 목록(DB 조회) 캐시 시간
let presenceCache = { at: 0, rows: null, total: 0 };
function normalizeDevice(raw, userAgent) {
  if (raw === 'mobile' || raw === 'desktop') return raw;
  return /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(String(userAgent || '')) ? 'mobile' : 'desktop';
}
function statusOfSocket(socketId) {
  const m = matches[socketToMatch[socketId]];
  return m && !m.over ? 'battle' : 'online';
}
async function buildPresence(viewerKey) {
  const now = Date.now();
  const onlineRows = [];
  let battleCount = 0;
  for (const [key, sid] of onlineUsers) {
    const s = io.sockets.sockets.get(sid);
    if (!s) continue;
    const status = statusOfSocket(sid);
    if (status === 'battle') battleCount += 1;
    onlineRows.push({ name: s.data.displayName, status, device: s.data.device || 'desktop', isMe: key === viewerKey });
  }
  // 전투 중 -> 접속 중 순서, 같은 상태끼리는 이름순
  onlineRows.sort((a, b) => (a.status === b.status ? String(a.name).localeCompare(String(b.name)) : a.status === 'battle' ? -1 : 1));

  // 오프라인 목록: 최근 접속 순. DB 조회는 잠깐 캐시한다 (유저 현황을 여러 명이 동시에 보고 있어도 DB 부하가 늘지 않게)
  if (!presenceCache.rows || now - presenceCache.at > PRESENCE_CACHE_MS) {
    const [rows, total] = await Promise.all([db.getRecentUsers(PRESENCE_LIST_LIMIT + onlineUsers.size), db.countUsers()]);
    presenceCache = { at: now, rows, total };
  }
  const shownOnline = onlineRows.slice(0, PRESENCE_LIST_LIMIT);
  const offlineRows = presenceCache.rows
    .filter((r) => !onlineUsers.has(r.key))
    .slice(0, Math.max(0, PRESENCE_LIST_LIMIT - shownOnline.length))
    .map((r) => ({ name: r.name, status: 'offline', agoMs: r.lastSeenAt ? Math.max(0, now - r.lastSeenAt) : null }));

  return {
    users: [...shownOnline, ...offlineRows],
    counts: {
      battle: battleCount,
      online: onlineRows.length - battleCount,
      offline: Math.max(0, presenceCache.total - onlineRows.length),
    },
  };
}

function releaseAccount(socket) {
  const key = socket.data.userKey;
  if (key && onlineUsers.get(key) === socket.id) {
    onlineUsers.delete(key);
    db.touchLastSeen(key).catch((e) => console.error('마지막 접속 시각 저장 실패', e)); // 로그아웃/연결 종료 시각 = 마지막 접속
  }
  socket.data.userKey = null;
  socket.data.displayName = null;
  socket.data.unlocked = new Set();
}

function registerAuthHandlers(socket) {
  socket.data.userKey = null;
  socket.data.displayName = null;
  socket.data.unlocked = new Set();
  let authBusy = false;

  function attachAccount(user) {
    socket.data.userKey = user.key;
    socket.data.displayName = user.name;
    socket.data.unlocked = new Set(effectiveUnlocked(user));
    onlineUsers.set(user.key, socket.id);
    db.touchLastSeen(user.key).catch((e) => console.error('마지막 접속 시각 저장 실패', e));
  }

  socket.on('register', async (data, ack) => {
    if (typeof ack !== 'function') return;
    if (authBusy) return ack({ ok: false, message: '처리 중입니다. 잠시만 기다려주세요.' });
    authBusy = true;
    try {
      if (socket.data.userKey) return ack({ ok: false, message: '이미 로그인되어 있습니다.' });
      const username = data && data.username;
      const password = data && data.password;
      const err = validateRegisterInput(username, password);
      if (err) return ack({ ok: false, message: err });

      const ip = clientIp(socket);
      if (isRateLimited('register', ip)) return ack({ ok: false, message: '가입 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.' });
      hitRate('register', ip);

      const salt = crypto.randomBytes(16).toString('hex');
      const hash = await hashPassword(password, salt);
      const user = {
        key: username.toLowerCase(), // 대소문자만 다른 아이디는 같은 아이디로 취급
        name: username,
        salt,
        hash,
        coins: 0,
        unlocked: [...FREE_CHARACTER_IDS],
        wins: 0,
        losses: 0,
        createdAt: Date.now(),
      };
      const created = await db.createUser(user);
      if (!created) return ack({ ok: false, message: '이미 사용 중인 아이디입니다.' });

      attachAccount(user);
      ack({ ok: true, profile: publicProfile(user) });
    } catch (e) {
      console.error('register 오류', e);
      ack({ ok: false, message: '서버 오류가 발생했습니다.' });
    } finally {
      authBusy = false;
    }
  });

  socket.on('login', async (data, ack) => {
    if (typeof ack !== 'function') return;
    if (authBusy) return ack({ ok: false, message: '처리 중입니다. 잠시만 기다려주세요.' });
    authBusy = true;
    try {
      if (socket.data.userKey) return ack({ ok: false, message: '이미 로그인되어 있습니다.' });
      const username = data && data.username;
      const password = data && data.password;
      if (typeof username !== 'string' || typeof password !== 'string' || username.length > 12 || password.length > 64) {
        return ack({ ok: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
      }
      const key = username.toLowerCase();
      if (isRateLimited('loginFail', key)) return ack({ ok: false, message: '로그인 실패가 너무 많습니다. 잠시 후 다시 시도해주세요.' });

      const user = await db.findUser(key);
      const computed = await hashPassword(password, user ? user.salt : DUMMY_SALT);
      if (!user || !safeEqualHex(computed, user.hash)) {
        hitRate('loginFail', key);
        return ack({ ok: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
      }

      if (isActiveBan(user)) return ack({ ok: false, message: banMessage(user) }); // 비밀번호가 맞은 경우에만 정지 사실을 알려줌

      const existing = onlineUsers.get(key);
      if (existing && existing !== socket.id && io.sockets.sockets.has(existing)) {
        return ack({ ok: false, message: '이미 다른 곳에서 접속 중인 계정입니다.' });
      }

      rateBuckets.delete(`loginFail:${key}`);
      attachAccount(user);
      ack({ ok: true, profile: publicProfile(user) });
    } catch (e) {
      console.error('login 오류', e);
      ack({ ok: false, message: '서버 오류가 발생했습니다.' });
    } finally {
      authBusy = false;
    }
  });

  socket.on('logout', (ack) => {
    if (typeof ack !== 'function') ack = () => {};
    if (socketToMatch[socket.id] || isQueued(socket.id)) return ack({ ok: false });
    releaseAccount(socket);
    ack({ ok: true });
  });

  // 계정 설정: 아이디 및/또는 비밀번호 변경. 항상 현재 비밀번호를 다시 확인한다.
  // 매치 중이거나 대기열에 있는 동안은 계정 키가 바뀌면 정산이 꼬일 수 있어서 변경할 수 없다.
  socket.on('updateAccount', async (data, ack) => {
    if (typeof ack !== 'function') return;
    if (authBusy) return ack({ ok: false, message: '처리 중입니다. 잠시만 기다려주세요.' });
    authBusy = true;
    try {
      const key = socket.data.userKey;
      if (!key) return ack({ ok: false, message: '로그인이 필요합니다.' });
      if (socketToMatch[socket.id] || isQueued(socket.id)) return ack({ ok: false, message: '매치 중이거나 대기 중에는 변경할 수 없습니다.' });

      const currentPassword = data && data.currentPassword;
      const newUsername = data && typeof data.newUsername === 'string' ? data.newUsername.trim() : '';
      const newPassword = data && typeof data.newPassword === 'string' ? data.newPassword : '';
      if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 64) return ack({ ok: false, message: '현재 비밀번호를 입력하세요.' });
      if (!newUsername && !newPassword) return ack({ ok: false, message: '변경할 아이디나 새 비밀번호를 입력하세요.' });
      if (newUsername && !USERNAME_RE.test(newUsername)) return ack({ ok: false, message: '아이디는 2~12자의 한글/영문/숫자/밑줄(_)만 사용할 수 있습니다.' });
      if (newPassword && (newPassword.length < 4 || newPassword.length > 64)) return ack({ ok: false, message: '비밀번호는 4~64자여야 합니다.' });
      // 개발자 아이디는 다른 사람이 빼앗지 못하게 보호: 남이 이 아이디로 바꿀 수 없고, 개발자 계정도 다른 이름으로 바꿀 수 없다
      if (newUsername && newUsername.toLowerCase() === ADMIN_KEY && key !== ADMIN_KEY) return ack({ ok: false, message: '사용할 수 없는 아이디입니다.' });
      if (newUsername && key === ADMIN_KEY && newUsername.toLowerCase() !== ADMIN_KEY) return ack({ ok: false, message: '개발자 계정의 아이디는 변경할 수 없습니다.' });

      if (isRateLimited('loginFail', key)) return ack({ ok: false, message: '비밀번호 오류가 너무 많습니다. 잠시 후 다시 시도해주세요.' });
      const user = await db.findUser(key);
      if (!user) return ack({ ok: false, message: '계정을 찾을 수 없습니다.' });
      const computed = await hashPassword(currentPassword, user.salt);
      if (!safeEqualHex(computed, user.hash)) {
        hitRate('loginFail', key);
        return ack({ ok: false, message: '현재 비밀번호가 올바르지 않습니다.' });
      }

      const changes = {};
      if (newUsername && newUsername !== user.name) {
        changes.newName = newUsername;
        const newKey = newUsername.toLowerCase(); // 대소문자만 다른 아이디는 같은 아이디로 취급 (대소문자만 바꾸는 경우는 표시명만 바뀜)
        if (newKey !== key) changes.newKey = newKey;
      }
      if (newPassword) {
        const salt = crypto.randomBytes(16).toString('hex');
        changes.salt = salt;
        changes.hash = await hashPassword(newPassword, salt);
      }
      if (!changes.newName && !changes.hash) return ack({ ok: false, message: '변경된 내용이 없습니다.' });

      const r = await db.updateAccount(key, changes);
      if (!r.ok) {
        return ack({ ok: false, message: r.reason === 'taken' ? '이미 사용 중인 아이디입니다.' : '계정 정보를 바꾸지 못했습니다.' });
      }

      rateBuckets.delete(`loginFail:${key}`);
      rankingCache = { at: 0, top: null }; // 랭킹에 바뀐 아이디가 바로 반영되도록 캐시 비우기
      presenceCache = { at: 0, rows: null, total: 0 }; // 유저 현황에도 바뀐 아이디가 바로 보이도록
      // 아이디(키)가 바뀌었으면 이 소켓의 로그인 정보와 접속 중 목록도 새 키로 옮긴다
      if (changes.newKey) {
        if (onlineUsers.get(key) === socket.id) onlineUsers.delete(key);
        onlineUsers.set(changes.newKey, socket.id);
        socket.data.userKey = changes.newKey;
      }
      socket.data.displayName = r.user.name;
      const parts = [];
      if (changes.newName) parts.push('아이디');
      if (changes.hash) parts.push('비밀번호');
      ack({ ok: true, message: `✅ ${parts.join('와 ')}가 변경되었습니다.`, profile: publicProfile(r.user) });
    } catch (e) {
      console.error('updateAccount 오류', e);
      ack({ ok: false, message: '서버 오류가 발생했습니다.' });
    } finally {
      authBusy = false;
    }
  });

  // 계정 삭제: 현재 비밀번호를 다시 확인한 뒤 계정과 모든 기록(코인/트로피/캐릭터/미션)을 완전히 지운다. 되돌릴 수 없다.
  socket.on('deleteAccount', async (data, ack) => {
    if (typeof ack !== 'function') return;
    if (authBusy) return ack({ ok: false, message: '처리 중입니다. 잠시만 기다려주세요.' });
    authBusy = true;
    try {
      const key = socket.data.userKey;
      if (!key) return ack({ ok: false, message: '로그인이 필요합니다.' });
      if (socketToMatch[socket.id] || isQueued(socket.id)) return ack({ ok: false, message: '매치 중이거나 대기 중에는 계정을 삭제할 수 없습니다.' });
      if (key === ADMIN_KEY) return ack({ ok: false, message: '개발자 계정은 삭제할 수 없습니다.' }); // 삭제되면 아이디를 다른 사람이 선점할 수 있음

      const currentPassword = data && data.currentPassword;
      if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 64) return ack({ ok: false, message: '현재 비밀번호를 입력하세요.' });
      if (isRateLimited('loginFail', key)) return ack({ ok: false, message: '비밀번호 오류가 너무 많습니다. 잠시 후 다시 시도해주세요.' });

      const user = await db.findUser(key);
      if (!user) return ack({ ok: false, message: '계정을 찾을 수 없습니다.' });
      const computed = await hashPassword(currentPassword, user.salt);
      if (!safeEqualHex(computed, user.hash)) {
        hitRate('loginFail', key);
        return ack({ ok: false, message: '현재 비밀번호가 올바르지 않습니다.' });
      }

      const deleted = await db.deleteUser(key);
      if (!deleted) return ack({ ok: false, message: '계정을 삭제하지 못했습니다.' });

      rateBuckets.delete(`loginFail:${key}`);
      rankingCache = { at: 0, top: null }; // 삭제된 계정이 랭킹에 남지 않도록 캐시 비우기
      presenceCache = { at: 0, rows: null, total: 0 }; // 삭제된 계정이 유저 현황에 남지 않도록
      releaseAccount(socket); // 로그인 상태 해제 (이 뒤로는 모든 요청이 '로그인 필요'로 거절됨)
      console.log(`[계정] 삭제됨: ${key}`);
      ack({ ok: true, message: '계정이 삭제되었습니다.' });
    } catch (e) {
      console.error('deleteAccount 오류', e);
      ack({ ok: false, message: '서버 오류가 발생했습니다.' });
    } finally {
      authBusy = false;
    }
  });

  // 유저 현황 조회: 접속 중/전투 중인 유저 + 최근 접속했던 오프라인 유저. 로그인한 사람만 볼 수 있고, 너무 자주 요청하지 못하게 한다.
  let lastPresenceAt = 0;
  socket.on('getPresence', async (data, ack) => {
    if (typeof ack !== 'function') return;
    try {
      const key = socket.data.userKey;
      if (!key) return ack({ ok: false, message: '로그인이 필요합니다.' });
      const now = Date.now();
      if (now - lastPresenceAt < 1000) return ack({ ok: false, message: '잠시 후 다시 시도해주세요.' });
      lastPresenceAt = now;
      ack({ ok: true, ...(await buildPresence(key)) });
    } catch (e) {
      console.error('getPresence 오류', e);
      ack({ ok: false, message: '유저 현황을 불러오지 못했습니다.' });
    }
  });

  // 랭킹 조회: 트로피 총합 상위 목록 + 내 순위. 상위 목록은 잠깐 캐시하고, 한 소켓이 너무 자주 요청하지 못하게 한다.
  let lastRankingAt = 0;
  socket.on('getRanking', async (data, ack) => {
    if (typeof ack !== 'function') return;
    try {
      const key = socket.data.userKey;
      if (!key) return ack({ ok: false, message: '로그인이 필요합니다.' });
      const now = Date.now();
      if (now - lastRankingAt < 1500) return ack({ ok: false, message: '잠시 후 다시 시도해주세요.' });
      lastRankingAt = now;

      if (!rankingCache.top || now - rankingCache.at > RANKING_CACHE_MS) {
        rankingCache = { at: now, top: await db.getRankingTop(RANKING_LIMIT) };
      }
      const me = await db.getRankOf(key);
      ack({
        ok: true,
        // 다른 사람의 계정 키는 내보내지 않고, 내 항목만 isMe로 표시한다
        top: rankingCache.top.map((r) => ({ rank: r.rank, name: r.name, total: r.total, wins: r.wins, isMe: r.key === key })),
        me: me ? { rank: me.rank, total: me.total, name: me.name } : null,
        players: me ? me.players : 0,
      });
    } catch (e) {
      console.error('getRanking 오류', e);
      ack({ ok: false, message: '랭킹을 불러오지 못했습니다.' });
    }
  });

  // 코인으로 캐릭터 잠금해제. 가격/보유 여부는 항상 서버가 판단한다 (클라이언트가 보낸 값은 신뢰하지 않음)
  // 코드 입력: 정해진 코드를 입력하면 코인을 지급 (계정당 코드별 1회)
  socket.on('redeemCode', async (data, ack) => {
    if (typeof ack !== 'function') return;
    try {
      const key = socket.data.userKey;
      if (!key) return ack({ ok: false, message: '로그인이 필요합니다.' });
      if (isRateLimited('redeemFail', key)) return ack({ ok: false, message: '시도 횟수가 너무 많습니다. 잠시 후 다시 시도해주세요.' });

      const code = normalizeCode(data && data.code);
      if (!code || code.length > 40) { hitRate('redeemFail', key); return ack({ ok: false, message: '올바르지 않은 코드입니다.' }); }
      const reward = Object.prototype.hasOwnProperty.call(REDEEM_CODES, code) ? REDEEM_CODES[code] : null;
      if (!reward) { hitRate('redeemFail', key); return ack({ ok: false, message: '올바르지 않은 코드입니다.' }); }

      const r = await db.redeemCode(key, code, reward.coins);
      if (r.ok) return ack({ ok: true, message: `🎉 ${reward.coins.toLocaleString()} 코인을 받았습니다!`, profile: publicProfile(r.user) });
      const message = r.reason === 'used' ? '이미 사용한 코드입니다.' : '코드 사용에 실패했습니다.';
      ack({ ok: false, message, profile: r.user ? publicProfile(r.user) : undefined });
    } catch (e) {
      console.error('redeemCode 오류', e);
      ack({ ok: false, message: '서버 오류가 발생했습니다.' });
    }
  });

  // 이벤트 보상 받기: 진행 중인 이벤트인지, 이미 받았는지는 항상 서버가 판단한다 (클라이언트가 보낸 값은 이벤트 id만 사용). 계정당 1회, 중복 클릭에도 한 번만 지급.
  socket.on('claimEvent', async (data, ack) => {
    if (typeof ack !== 'function') return;
    try {
      const key = socket.data.userKey;
      if (!key) return ack({ ok: false, message: '로그인이 필요합니다.' });
      if (isRateLimited('redeemFail', key)) return ack({ ok: false, message: '시도 횟수가 너무 많습니다. 잠시 후 다시 시도해주세요.' });
      const ev = activeEvents().find((e) => e.id === (data && data.eventId));
      if (!ev) { hitRate('redeemFail', key); return ack({ ok: false, message: '진행 중인 이벤트가 아닙니다.' }); }

      const r = await db.redeemCode(key, eventClaimCode(ev), ev.coins);
      if (r.ok) {
        console.log(`[이벤트] ${ev.name}: ${socket.data.displayName} 님이 ${ev.coins}코인 수령`);
        return ack({ ok: true, message: `🎉 ${ev.name} 이벤트! ${ev.coins.toLocaleString()}코인을 받았습니다!`, profile: publicProfile(r.user) });
      }
      const message = r.reason === 'used' ? '이미 이 이벤트의 보상을 받았습니다.' : '보상을 받지 못했습니다.';
      ack({ ok: false, message, profile: r.user ? publicProfile(r.user) : undefined });
    } catch (e) {
      console.error('claimEvent 오류', e);
      ack({ ok: false, message: '서버 오류가 발생했습니다.' });
    }
  });

  socket.on('unlockCharacter', async (data, ack) => {
    if (typeof ack !== 'function') return;
    try {
      const key = socket.data.userKey;
      if (!key) return ack({ ok: false, message: '로그인이 필요합니다.' });
      if (socketToMatch[socket.id]) return ack({ ok: false, message: '매치 중에는 잠금해제할 수 없습니다.' });
      const charId = data && data.characterId;
      if (typeof charId !== 'string' || !CHARACTERS[charId]) return ack({ ok: false, message: '존재하지 않는 캐릭터입니다.' });
      if (socket.data.unlocked.has(charId)) return ack({ ok: false, message: '이미 잠금해제된 캐릭터입니다.' });

      const r = await db.buyCharacter(key, charId, priceOf(charId));
      if (r.user) socket.data.unlocked = new Set(effectiveUnlocked(r.user));
      if (r.ok) return ack({ ok: true, profile: publicProfile(r.user) });

      const message = r.reason === 'coins' ? '코인이 부족합니다.'
        : r.reason === 'already' ? '이미 잠금해제된 캐릭터입니다.'
        : '잠금해제에 실패했습니다.';
      ack({ ok: false, message, profile: r.user ? publicProfile(r.user) : undefined });
    } catch (e) {
      console.error('unlockCharacter 오류', e);
      ack({ ok: false, message: '서버 오류가 발생했습니다.' });
    }
  });

  // 캐릭터 강화: 코인으로 해당 캐릭터의 레벨을 1 올린다. 현재 레벨/비용/코인은 항상 서버 기준으로 판단한다.
  socket.on('upgradeCharacter', async (data, ack) => {
    if (typeof ack !== 'function') return;
    try {
      const key = socket.data.userKey;
      if (!key) return ack({ ok: false, message: '로그인이 필요합니다.' });
      if (socketToMatch[socket.id] || isQueued(socket.id)) return ack({ ok: false, message: '매치 중이거나 대기 중에는 강화할 수 없습니다.' });
      const charId = data && data.characterId;
      if (typeof charId !== 'string' || !CHARACTERS[charId]) return ack({ ok: false, message: '존재하지 않는 캐릭터입니다.' });
      if (!socket.data.unlocked.has(charId)) return ack({ ok: false, message: '잠금해제된 캐릭터만 강화할 수 있습니다.' });

      const before = await db.findUser(key);
      if (!before) return ack({ ok: false, message: '계정을 찾을 수 없습니다.' });
      const current = levelOf(before, charId);
      if (current >= MAX_CHARACTER_LEVEL) return ack({ ok: false, message: '이미 최고 레벨입니다.', profile: publicProfile(before) });

      const r = await db.upgradeCharacter(key, charId, current, LEVEL_TABLE[current + 1].cost);
      if (r.ok) return ack({ ok: true, message: `${CHARACTERS[charId].name} Lv.${current + 1} 강화 완료!`, profile: publicProfile(r.user) });

      const message = r.reason === 'coins' ? '코인이 부족합니다.'
        : r.reason === 'level' ? '이미 강화가 진행되었습니다. 화면을 갱신했어요.'
        : '강화에 실패했습니다.';
      ack({ ok: false, message, profile: r.user ? publicProfile(r.user) : undefined });
    } catch (e) {
      console.error('upgradeCharacter 오류', e);
      ack({ ok: false, message: '서버 오류가 발생했습니다.' });
    }
  });

  // 미션 보상 받기: 달성 여부/중복 수령은 항상 서버가 판단한다 (클라이언트가 보낸 값은 미션 id만 사용)
  socket.on('claimMission', async (data, ack) => {
    if (typeof ack !== 'function') return;
    try {
      const key = socket.data.userKey;
      if (!key) return ack({ ok: false, message: '로그인이 필요합니다.' });
      const missionId = data && data.missionId;
      const mission = MISSIONS.find((m) => m.id === missionId);
      if (!mission) return ack({ ok: false, message: '존재하지 않는 미션입니다.' });

      const r = await db.claimMission(key, missionDay(), mission.id, mission.goal, mission.reward);
      if (r.ok) return ack({ ok: true, message: `🎉 ${mission.reward.toLocaleString()} 코인을 받았습니다!`, profile: publicProfile(r.user) });
      const message = r.reason === 'claimed' ? '이미 보상을 받은 미션입니다.'
        : r.reason === 'notDone' ? '아직 목표를 달성하지 못했습니다.'
        : '보상 받기에 실패했습니다.';
      ack({ ok: false, message, profile: r.user ? publicProfile(r.user) : undefined });
    } catch (e) {
      console.error('claimMission 오류', e);
      ack({ ok: false, message: '서버 오류가 발생했습니다.' });
    }
  });
}

// 매치 결과 정산: 승리 팀에는 코인 + 승수, 패배 팀에는 패수를 기록한다 (매치당 한 번만 실행)
async function settleMatch(match, winnerTeam, reason, leaverId) {
  if (match.settled) return;
  match.settled = true;
  const cfg = MODES[match.mode];
  const half = reason === 'opponentLeft'; // 상대가 나가서 얻은 승리는 보상을 절반만 지급
  const coinReward = half ? Math.floor((cfg.coinReward || 0) / 2) : (cfg.coinReward || 0);
  const trophyReward = half ? Math.floor((cfg.trophyReward || 0) / 2) : (cfg.trophyReward || 0);
  const trophyLoss = cfg.trophyLoss || 0;
  for (const pid in match.players) {
    const key = match.accounts[pid];
    if (!key) continue;
    const p = match.players[pid];
    const won = p.team === winnerTeam;
    // 패배 페널티: 점수로 져서 끝난 매치는 패배한 팀 전원, 중도 이탈로 끝난 매치는 나간 사람만 (남은 팀원은 깎이지 않음)
    const penalized = !won && (reason === 'scoreLimit' || pid === leaverId);
    try {
      // 연승 계산: 이 매치에서 쓴 캐릭터의 직전 연승 수를 서버 저장소에서 읽는다
      let previousStreak = 0;
      if (won) {
        const before = await db.findUser(key);
        previousStreak = (before && before.streaks && before.streaks[p.characterId]) || 0;
      }
      // 연승 보너스는 기본 보상과 같은 비율로 계산 (상대 이탈 승리는 기본 보상이 절반이라 보너스도 절반)
      const streakBonus = won ? streakBonusTrophies(trophyReward, previousStreak) : 0;
      const trophyDelta = won ? trophyReward + streakBonus : (penalized ? -trophyLoss : 0);
      // 승리: 연승 +1 / 페널티 받는 패배: 연승 0 / 페널티 없는 패배(팀원 이탈 등): 연승 유지
      const newStreak = won ? previousStreak + 1 : (penalized ? 0 : null);
      // 미션 진행도 누적 (정상 종료된 매치만). addResult보다 먼저 해서 아래 profileUpdate에 최신 진행도가 담기게 함
      if (reason === 'scoreLimit') {
        await db.addMissionProgress(key, missionDay(), missionIncrements(won, match.mode, p.score || 0));
      }
      const user = await db.addResult(key, won ? coinReward : 0, won, p.characterId, trophyDelta, newStreak);
      const s = io.sockets.sockets.get(pid);
      if (s && user) {
        s.data.unlocked = new Set(effectiveUnlocked(user));
        s.emit('profileUpdate', {
          ...publicProfile(user),
          lastResult: { characterId: p.characterId, won, streak: newStreak != null ? newStreak : ((user.streaks && user.streaks[p.characterId]) || 0), streakBonus },
        });
      }
    } catch (e) {
      console.error('매치 결과 저장 실패', key, e);
    }
  }
}

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
let chickenIdCounter = 0;

function randomSpawnPoint(walls) {
  // 벽과 겹치지 않는 위치를 찾을 때까지 여러 번 무작위로 시도 (여유 반지름을 둬서 벽에 바짝 붙어 끼는 것도 방지)
  for (let i = 0; i < 40; i++) {
    const x = PLAYER_RADIUS + 10 + Math.random() * (ARENA_WIDTH - (PLAYER_RADIUS + 10) * 2);
    const y = PLAYER_RADIUS + 10 + Math.random() * (ARENA_HEIGHT - (PLAYER_RADIUS + 10) * 2);
    if (!collidesWithWalls(walls, x, y, PLAYER_RADIUS + 10)) return { x, y };
  }
  // 40번을 시도해도 못 찾은 극히 드문 경우를 대비해, 모든 맵에서 벽이 없도록 설계된
  // 네 귀퉁이 및 중앙을 순서대로 확인해서 실제로 비어있는 지점을 반환 (벽에 끼는 버그 방지용 안전장치)
  const fallbackCandidates = [
    { x: 60, y: 60 },
    { x: ARENA_WIDTH - 60, y: 60 },
    { x: 60, y: ARENA_HEIGHT - 60 },
    { x: ARENA_WIDTH - 60, y: ARENA_HEIGHT - 60 },
    { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 },
  ];
  for (const c of fallbackCandidates) {
    if (!collidesWithWalls(walls, c.x, c.y, PLAYER_RADIUS)) return c;
  }
  return fallbackCandidates[0];
}

function buildPlayer(socketId, name, characterId, team, spawn, level) {
  const character = getLeveledCharacter(characterId, level); // 레벨에 맞게 체력/대미지가 강화된 스펙 (1레벨은 기본 스펙)
  return {
    level: clampLevel(level),
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
    dashSpeed: 0,        // 이번 돌진의 속도(px/초) - 궁극기 돌진과 가젯 돌진이 서로 다른 속도를 쓰기 때문에 돌진을 시작할 때 기록함
    dashHarmless: false, // true면 피해/기절 없이 이동만 하는 돌진 (변기통의 가젯 '질주'). 적과 부딪혀도 멈추지 않고 통과함
    dashDamage: 0,       // 이번 돌진이 적에게 주는 피해 (궁극기 돌진 / 꽈리의 기본공격 돌진이 서로 다름)
    dashStun: 0,         // 이번 돌진이 주는 기절 시간(초)
    dashHitIds: [],      // 이번 돌진(관통)에서 이미 피해를 준 대상 id 목록
    dashCharge: false,   // true면 이 돌진의 적중이 궁극기 게이지를 채움 (기본공격 돌진)
    reloadBoostUntil: 0,       // 이 시각(ms) 전까지 재장전 속도 증가 (꽈리의 가젯 '재장전 가속')
    reloadBoostMultiplier: 1,
    stunnedUntil: 0,   // 이 시각(ms, Date.now() 기준) 전까지는 기절 상태 (이동/공격 불가)
    windupUntil: 0,    // 이 시각(ms) 전까지는 공격 선딜 중 (업할의 망치 지진) - 이동 불가, 조준 방향만 변경 가능
    windupTotal: 0,    // 이번 선딜의 전체 길이(ms) - 클라이언트가 경고 범위 진행도를 그릴 때 사용
    windupId: 0,       // 선딜 취소/무효화용 번호 (타이머 핸들은 상태에 넣지 않음 - 클라이언트로 전송되는 객체이므로)
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
    gadget: character.gadget || null, // 캐릭터 전용 가젯 (없으면 null)
    gadgetCooldownLeft: 0, // 가젯 재사용까지 남은 시간(초). 0이면 사용 가능
    leaping: false,        // 모카의 궁극기 점프 중이면 true (공중: 조작 불가, 피격/총알 무시)
    leapTimeLeft: 0,
    leapTotal: 0,
    leapStartX: 0, leapStartY: 0, leapTargetX: 0, leapTargetY: 0,
    leapEndsAt: 0,         // 점프 중 입력을 막기 위해 걸어둔 기절 시각(착지 때 같은 값이면 해제)
    leapDamage: 0, leapRadius: 0,
    leapKnockback: 0,      // 점프 착지 때 적을 밀쳐내는 거리(px) (진우Park의 소다Bang). 0이면 밀치지 않음
    ultGadgetLeft: 0,      // 모카의 가젯: 궁극기 게이지가 천천히 채워지는 남은 시간(초)
    ultGadgetRate: 0,      // 초당 채워지는 게이지(%)
    invincibleUntil: 0,    // 이 시각(ms, Date.now() 기준) 전까지는 무적 상태 (현재 사용하는 캐릭터는 없지만 'invincible' 가젯용으로 남겨둠)
    shieldHp: 0,           // 남은 보호막 수치 (슈의 가젯). 0이면 보호막 없음
    shieldMax: 0,          // 이번에 발동한 보호막의 최대치 (화면 표시용)
    speedMultiplier: 1,     // 이동속도 배율. 매 틱 1로 초기화된 뒤 보배 폭탄 범위 등에 의해 낮아질 수 있음
    speedBoostUntil: 0,      // 이 시각(ms) 전까지 이동속도 증가 (원효대사의 가젯 '초인적인 힘')
    speedBoostMultiplier: 1,
    chargingUntil: 0,        // 이 시각(ms) 전까지 충전 중 (보배의 가젯 '보조배터리 충전') - 이동/공격 불가
    damageBoostFrom: 0,      // damageBoostFrom ~ damageBoostUntil (ms) 동안 공격력 증가
    damageBoostUntil: 0,
    damageBoostMultiplier: 1,
    reloadAllAtOnce: !!character.basic.reloadAllAtOnce, // true면 탄창을 모두 쓴 뒤에야 재장전이 시작되고 한꺼번에 가득 참 (시스템)
    moveDirX: 0,           // 마지막으로 실제로 이동한 방향(단위벡터) - 시스템의 공격 돌진 방향
    moveDirY: 0,
    lastMoveAt: 0,         // 마지막으로 실제로 이동한 시각(ms)
    airborneTimeLeft: 0,   // 시스템의 궁극기에 맞아 하늘에 떠 있는 남은 시간(초). 0보다 크면 조작 불가 + 피격/총알 무시
    airborneTotal: 0,
    airborneLandDamage: 0,
    airborneBy: null,
    airborneStunUntil: 0,
    ammo: MAX_AMMO,
    maxAmmo: MAX_AMMO,
    chargeStartAt: 0,      // 똥파리: 공격 버튼을 누르기 시작한 시각(ms). 0이면 충전 중이 아님 (충전 시간은 서버가 직접 잼)
    chargeRatio: 0,        // 똥파리: 현재 충전 진행도(0~1) - 클라이언트가 충전 게이지를 그릴 때 사용
    ammoRegenSeconds: character.basic.ammoRegenSeconds || AMMO_REGEN_SECONDS, // 캐릭터별 기본공격 재장전 시간
    ammoRegenElapsed: 0,
    lastShotAt: 0,
    lastDamageAt: Date.now(),
  };
}

// 대미지 적용 + 사망/리스폰/점수/승리 판정을 한 곳에서 관리 (총알 피격, 번개 피격이 공용으로 사용)
// match: 이 대미지가 발생한 매치. 다른 매치의 상태에는 절대 영향을 주지 않는다.
// 아군 피해 여부는 호출하는 쪽(총알 충돌 / 번개 판정)에서 이미 걸러서 넘겨준다.
// 공격자의 현재 공격력 배율 (보배의 가젯 '보조배터리 충전' 등)
function getDamageMultiplier(p) {
  if (!p) return 1;
  const now = Date.now();
  if (p.damageBoostUntil && now >= p.damageBoostFrom && now < p.damageBoostUntil) return p.damageBoostMultiplier || 1;
  return 1;
}

// 총알이 대상에게 줄 기본 피해: 비율형 총알(하트)은 대상의 현재 체력 + 보호막의 비율, 그 외는 고정 피해
function bulletDamageFor(b, target) {
  // 처형: 현재 체력이 기준 이하면 보호막까지 뚫고 확실히 죽을 만큼의 피해를 줌
  if (b.executeBelowHp > 0 && (target.hp || 0) <= b.executeBelowHp) return (target.hp || 0) + (target.shieldHp || 0) + 1;
  if (b.currentHpRatio > 0) return Math.max(1, Math.round(((target.hp || 0) + (target.shieldHp || 0)) * b.currentHpRatio));
  return b.damage;
}

// 시스템의 궁극기: 대상을 duration초 동안 하늘로 띄운다. 이 동안은 기절과 같이 조작 불가 + 모든 피해/총알 무시이고,
// 시간이 끝나(땅에 떨어지)면 updateMatch가 landDamage 피해를 준다.
function launchTarget(match, target, b) {
  if (!target.alive || target.leaping || target.airborneTimeLeft > 0) return;
  if (target.invincibleUntil && Date.now() < target.invincibleUntil) return; // 무적이면 띄워지지 않음
  const total = b.launchDuration;
  target.airborneTotal = total;
  target.airborneTimeLeft = total;
  target.airborneLandDamage = b.landDamage;
  target.airborneBy = b.ownerId;
  target.airborneStunUntil = Date.now() + total * 1000;
  target.stunnedUntil = target.airborneStunUntil;
  target.dashing = false; // 돌진/선딜 중이었다면 끊김
  target.windupUntil = 0;
  target.windupId = (target.windupId || 0) + 1;
}

function applyDamage(match, target, damage, shooterId, { chargeShooter } = {}) {
  if (!target.alive || match.over) return;
  if (target.leaping) return; // 점프 중(모카 궁극기)에는 모든 피해 무시
  if (target.airborneTimeLeft > 0) return; // 하늘에 떠 있는 동안(시스템 궁극기)에도 모든 피해 무시 (착지 피해는 airborneTimeLeft를 0으로 만든 뒤 적용)
  if (target.invincibleUntil && Date.now() < target.invincibleUntil) return; // 무적 상태(슈의 가젯)면 피해/궁극기 충전 모두 무시

  const shooter = match.players[shooterId];
  damage = Math.round(damage * getDamageMultiplier(shooter)); // 공격력 증가 효과 적용

  // 보호막(슈의 가젯): 남은 보호막 수치만큼 피해를 대신 흡수하고, 넘치는 피해만 체력에 적용
  if (target.shieldHp > 0) {
    const absorbed = Math.min(target.shieldHp, damage);
    target.shieldHp -= absorbed;
    damage -= absorbed;
  }

  if (damage > 0) {
    target.hp -= damage;
    target.lastDamageAt = Date.now(); // 무피격 회복 타이머 초기화 (보호막이 전부 막은 피해는 체력 회복을 끊지 않음)
  }

  // 공격이 적중했으면(보호막이 막았더라도) 궁극기 게이지는 충전됨
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
        coinReward: MODES[match.mode].coinReward || 0,
      });
      settleMatch(match, shooter.team, 'scoreLimit');
      setTimeout(() => endMatch(match.id), MATCH_CLEANUP_DELAY_MS);
      return;
    }

    const deadId = target.id;
    setTimeout(() => {
      const m = matches[match.id];
      if (!m || m.over) return; // 이미 매치가 끝났거나 정리된 경우
      const respawned = m.players[deadId];
      if (!respawned) return; // 이미 접속 해제한 경우
      const spawn = randomSpawnPoint(m.walls);
      respawned.x = spawn.x;
      respawned.y = spawn.y;
      respawned.hp = respawned.maxHp;
      respawned.alive = true;
      respawned.invisible = false;
      respawned.stealthId = (respawned.stealthId || 0) + 1; // 진행 중이던 은신 타이머를 무효화
      respawned.dashing = false;
      respawned.dashTimeLeft = 0;
      respawned.dashHitIds = [];
      respawned.stunnedUntil = 0;
      respawned.airborneTimeLeft = 0; // 하늘에 떠 있던 상태도 초기화
      respawned.comboDashId = (respawned.comboDashId || 0) + 1; // 예약돼 있던 시스템의 돌진도 취소
      respawned.windupUntil = 0; // 진행 중이던 공격 선딜도 취소
      respawned.windupId = (respawned.windupId || 0) + 1;
      respawned.invincibleUntil = 0; // 리스폰 시 이전 무적 상태는 초기화
      respawned.shieldHp = 0;        // 리스폰 시 보호막도 초기화
      respawned.shieldMax = 0;
      respawned.reloadBoostUntil = 0;
      respawned.speedBoostUntil = 0; // 리스폰 시 가젯 효과(이동속도 증가/충전/공격력 증가)도 초기화
      respawned.chargingUntil = 0;
      respawned.damageBoostFrom = 0;
      respawned.damageBoostUntil = 0;
      respawned.knockbackTimeLeft = 0;
      respawned.chargeStartAt = 0; // 충전 중이던 공격도 초기화
      respawned.chargeRatio = 0;
      // 궁극기 게이지는 사망/리스폰 시에도 초기화하지 않고 그대로 유지함
      respawned.ammo = MAX_AMMO;
      respawned.ammoRegenElapsed = 0;
      respawned.lastDamageAt = Date.now();
    }, RESPAWN_DELAY);
  }
}

// 총알(들)을 생성한다. spec.pelletCount가 있으면 spec.spreadDegrees 각도 안에 고르게 퍼뜨려서 여러 발을 동시에 발사한다.
// (예: 슈의 샷건 - 탄창/쿨다운은 소비 1회로 취급되고, 여기서는 실제 총알 개체만 만든다)
const POOP_BOMB_EXPLOSION_LIFE = 0.75; // 폭탄 똥 폭발 이펙트가 화면에 남는 시간(초) - 피해 판정은 폭발 즉시 끝나고, 이 시간은 연출용
// 폭발하는 똥(똥파리의 가젯 '폭탄 똥'): 총알 위치에서 폭발해 범위 안의 적(플레이어/터렛/닭)에게 explodeDamage 피해를 준다.
// 아군에게는 피해가 없고, 폭발 이펙트는 클라이언트가 그리도록 effects 에 넣는다.
function explodePoopBomb(match, b) {
  effectIdCounter += 1;
  match.effects.push({ id: effectIdCounter, type: 'explosion', visual: 'poopBomb', x: b.x, y: b.y, radius: b.explodeRadius, life: POOP_BOMB_EXPLOSION_LIFE, maxLife: POOP_BOMB_EXPLOSION_LIFE });

  for (const pid in match.players) {
    if (match.over) return;
    const target = match.players[pid];
    if (!target.alive) continue;
    if (!FRIENDLY_FIRE && target.team === b.team) continue;
    const dx = target.x - b.x;
    const dy = target.y - b.y;
    if (Math.sqrt(dx * dx + dy * dy) >= PLAYER_RADIUS + b.explodeRadius) continue;
    applyDamage(match, target, b.explodeDamage, b.ownerId, { chargeShooter: false }); // 궁극기 게이지는 충전하지 않음 (가젯이므로)
  }
  if (match.over) return;

  const mult = getDamageMultiplier(match.players[b.ownerId]);
  for (const turret of match.turrets) {
    if (!FRIENDLY_FIRE && turret.team === b.team) continue;
    const dx = turret.x - b.x;
    const dy = turret.y - b.y;
    if (Math.sqrt(dx * dx + dy * dy) < turret.radius + b.explodeRadius) turret.hp -= b.explodeDamage * mult;
  }
  match.turrets = match.turrets.filter((t) => t.hp > 0);
  for (const chicken of match.chickens) {
    if (chicken.hp <= 0) continue;
    if (!FRIENDLY_FIRE && chicken.team === b.team) continue;
    const dx = chicken.x - b.x;
    const dy = chicken.y - b.y;
    if (Math.sqrt(dx * dx + dy * dy) < chicken.radius + b.explodeRadius) chicken.hp -= b.explodeDamage * mult;
  }
  match.chickens = match.chickens.filter((c) => c.hp > 0);
}

function spawnProjectiles(match, p, spec, isUltimate, baseAngle = p.angle) {
  const pelletCount = spec.pelletCount || 1;
  const spreadRad = ((spec.spreadDegrees || 0) * Math.PI) / 180;
  const halfSpread = spreadRad / 2;

  for (let i = 0; i < pelletCount; i++) {
    const angleOffset = pelletCount > 1 ? -halfSpread + (spreadRad * i) / (pelletCount - 1) : 0;
    const angle = baseAngle + angleOffset;

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
      maxLife: spec.lifetime, // 처음 수명 (폭탄 똥이 터지기 직전에 더 빠르게 깜빡이는 연출용)
      damage: spec.damage,
      executeBelowHp: spec.executeBelowHp || 0, // 0보다 크면 맞은 대상의 현재 체력이 이 값 이하일 때 즉사 (진우Park의 하트)
      currentHpRatio: spec.currentHpRatio || 0, // 0보다 크면 고정 피해 대신 대상 현재 체력(+보호막)의 비율만큼 피해 (진우Park의 하트)
      radius: spec.radius,
      isUltimate,
      visual: spec.visual,
      launchDuration: spec.launchDuration || 0, // 0보다 크면 맞은 적을 이 시간(초) 동안 하늘로 띄움 (시스템의 궁극기)
      landDamage: spec.landDamage || 0,         // 띄워진 적이 땅에 떨어질 때 받는 피해
      pierceTargets: !!spec.pierceTargets,      // true면 적을 맞혀도 사라지지 않고 계속 날아가 여러 명을 맞힘
      hitIds: spec.pierceTargets ? [] : null,   // 관통 발사체가 이미 맞힌 대상 (같은 대상을 두 번 띄우지 않기 위함. 배열이어야 클라이언트로 전송 가능)
      pierceWalls: !!spec.pierceWalls, // 성스럽다의 칼 던지기처럼 벽(장애물)을 무시하고 통과하는 발사체
      // 원효대사의 해골물 뿌리기처럼 벽/적에 닿으면 물웅덩이를 생성하는 발사체를 위한 부가 정보
      poolOnImpact: !!spec.poolOnImpact,
      poolRadius: spec.poolRadius,
      poolLifetime: spec.poolLifetime,
      poolTickInterval: spec.poolTickInterval,
      poolDamage: spec.poolDamage,
      poolHeal: spec.poolHeal,
      poolVisual: spec.poolVisual,       // 웅덩이 모양(예: 계란 흰자)
      poolOnExpire: !!spec.poolOnExpire, // 사거리 끝에서도 깨져서 웅덩이를 남기는 발사체(계란)
      directDamage: spec.directDamage || 0, // 물웅덩이 생성 전 적에게 직접 적중 시 주는 대미지
      explodeDamage: spec.explodeDamage || 0, // 0보다 크면 적/벽에 닿거나 사거리 끝에서 폭발 (똥파리의 가젯 '폭탄 똥')
      explodeRadius: spec.explodeRadius || 0, // 폭발 범위(px)
    });
  }
}

// 근접 공격(변기통의 뚫어뻥 휘두르기 등): 발사체 없이 즉시 판정되는 부채꼴 범위 공격
// spec.angleDegrees: 바라보는 방향을 중심으로 한 부채꼴의 전체 각도, spec.range: 부채꼴 반경
// spec.knockback이 있으면 맞은 대상을 공격자 반대 방향(바깥쪽)으로 밀어낸다
function performMeleeAttack(match, p, spec, isUltimate, angle = p.angle, stabIndex = 0) {
  const halfAngle = ((spec.angleDegrees || 90) * Math.PI) / 180 / 2;
  const range = spec.range || 120;
  // 판정 보정(모카): 상대 몸통 크기만큼 각도를 너그럽게 보고, 위치 오차를 감안해 판정 거리를 조금 더 준다
  const reachPad = spec.hitAssist ? (spec.hitPadding || 0) : 0;
  const angleSlack = (distance, bodyRadius) => {
    if (!spec.hitAssist) return 0;
    if (distance <= bodyRadius) return Math.PI; // 몸이 겹칠 만큼 가까우면 방향과 상관없이 적중
    return Math.asin(Math.min(1, bodyRadius / distance));
  };

  // 클라이언트가 부채꼴 스윙을 그릴 수 있도록 시각 이펙트로 전달
  effectIdCounter += 1;
  match.effects.push({
    id: effectIdCounter,
    type: 'melee',
    x: p.x,
    y: p.y,
    angle,
    arcDegrees: spec.angleDegrees || 90,
    radius: range,
    visual: spec.visual || null,
    side: stabIndex % 2 === 0 ? -1 : 1, // 양손 찌르기: 왼손/오른손 번갈아 표시
    life: spec.effectLife || EFFECT_LIFETIME,
    maxLife: spec.effectLife || EFFECT_LIFETIME, // 클라이언트가 동작 진행도(0~1)를 계산하는 기준
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
    if (dist > range + PLAYER_RADIUS + reachPad) continue;

    // 목표가 공격자가 바라보는 방향 기준 부채꼴 각도 안에 있는지 확인
    let diff = Math.atan2(dy, dx) - angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) > halfAngle + angleSlack(dist, PLAYER_RADIUS)) continue;

    applyDamage(match, target, spec.damage, p.id, { chargeShooter: !isUltimate });
    if (match.over) break;

    // 기절(업할의 지진): 점프 중이거나 무적인 대상은 피해와 마찬가지로 기절도 받지 않는다. 죽은 대상은 리스폰 시 기절이 초기화됨
    if (spec.stunDuration > 0 && target.alive && !target.leaping && !(target.invincibleUntil && Date.now() < target.invincibleUntil)) {
      target.stunnedUntil = Math.max(target.stunnedUntil || 0, Date.now() + spec.stunDuration * 1000);
    }

    // 넉백: 즉시 순간이동시키지 않고, 방향/거리만 기록해서 이후 updateMatch 틱마다
    // 점점 감속하며 자연스럽게 날아가도록 처리한다 (실제 이동은 아래 넉백 처리 루프에서 수행)
    if (spec.knockback && dist > 0.001 && !(target.invincibleUntil && Date.now() < target.invincibleUntil)) {
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
    if (tdist > range + turret.radius + reachPad) continue;

    let tdiff = Math.atan2(tdy, tdx) - angle;
    while (tdiff > Math.PI) tdiff -= Math.PI * 2;
    while (tdiff < -Math.PI) tdiff += Math.PI * 2;
    if (Math.abs(tdiff) > halfAngle + angleSlack(tdist, turret.radius)) continue;

    turret.hp -= spec.damage;
  }
  match.turrets = match.turrets.filter((t) => t.hp > 0);

  // 적 닭도 근접 공격 범위/각도 판정에 포함
  for (const chicken of match.chickens) {
    if (match.over) break;
    if (!FRIENDLY_FIRE && chicken.team === p.team) continue;
    const cdx = chicken.x - p.x;
    const cdy = chicken.y - p.y;
    const cdist = Math.sqrt(cdx * cdx + cdy * cdy);
    if (cdist > range + chicken.radius + reachPad) continue;
    let cdiff = Math.atan2(cdy, cdx) - angle;
    while (cdiff > Math.PI) cdiff -= Math.PI * 2;
    while (cdiff < -Math.PI) cdiff += Math.PI * 2;
    if (Math.abs(cdiff) > halfAngle + angleSlack(cdist, chicken.radius)) continue;
    chicken.hp -= spec.damage * getDamageMultiplier(p);
  }
  match.chickens = match.chickens.filter((c) => c.hp > 0);
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

// 닭 소환(엑헤 궁극기): 자신의 위치 옆에 닭을 소환한다. 실제 추격/공격은 updateMatch의 닭 AI 루프에서 처리
function spawnChicken(match, p, spec) {
  // 같은 사람의 닭이 남아있으면 먼저 제거하고 새로 소환 (닭이 무한히 쌓이지 않도록)
  match.chickens = match.chickens.filter((c) => c.ownerId !== p.id);

  chickenIdCounter += 1;
  match.chickens.push({
    id: chickenIdCounter,
    ownerId: p.id,
    team: p.team,
    x: p.x + Math.cos(p.angle) * (PLAYER_RADIUS + spec.radius + 6),
    y: p.y + Math.sin(p.angle) * (PLAYER_RADIUS + spec.radius + 6),
    hp: spec.hp,
    maxHp: spec.hp,
    radius: spec.radius || 16,
    damage: spec.damage,
    attackInterval: spec.attackInterval || 0.8,
    attackRange: spec.attackRange || 14,
    attackCooldown: 0.3,
    moveSpeed: spec.moveSpeed || 220,
    chaseRange: spec.chaseRange || 700,
    chargeRange: spec.chargeRange || 300,
    chargeSpeed: spec.chargeSpeed || 950,
    chargeMaxTime: spec.chargeMaxTime || 0.6,
    retreatTime: spec.retreatTime != null ? spec.retreatTime : 0.4,
    retreatSpeed: spec.retreatSpeed || 450,
    retreatTimeLeft: 0,       // 돌격 후 물러나는 동작이 끝날 때까지 남은 시간(초)
    charging: false,          // 적에게 돌격 중이면 true
    chargeTimeLeft: 0,        // 현재 돌격이 끝날 때까지 남은 시간(초)
    life: spec.duration || 8, // 남은 지속 시간(초)
    peckTimer: 0,             // 부딪히는 순간 연출용 (클라이언트에서 사용)
  });

  // 소환 위치가 벽 안이면 소환자 위치로 대체
  const c = match.chickens[match.chickens.length - 1];
  if (collidesWithWalls(match.walls, c.x, c.y, c.radius)) { c.x = p.x; c.y = p.y; }
}

// 닭 이동: 벽에 닿아도 옆으로 미끄러지도록 축별로 검사
function moveChicken(match, c, dirX, dirY, step) {
  const nx = Math.max(c.radius, Math.min(ARENA_WIDTH - c.radius, c.x + dirX * step));
  const ny = Math.max(c.radius, Math.min(ARENA_HEIGHT - c.radius, c.y + dirY * step));
  if (!collidesWithWalls(match.walls, nx, c.y, c.radius)) c.x = nx;
  if (!collidesWithWalls(match.walls, c.x, ny, c.radius)) c.y = ny;
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
    visual: b.poolVisual || null,
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
    slowMultiplier: spec.slowMultiplier != null ? spec.slowMultiplier : 1,
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

  const map = pickRandomMapLayout();

  const match = {
    id: matchId,
    mode,
    mapId: map.id,
    walls: map.walls,
    bushes: map.bushes,
    players: {},
    bullets: [],
    effects: [],
    waterPools: [],
    turrets: [],
    bombs: [],
    chickens: [],
    teamScore: { A: 0, B: 0 },
    winScore: cfg.winScore,
    over: false,
    startsAt: Date.now() + MATCH_COUNTDOWN_MS, // 이 시각 전까지는 대결 화면 (이동/공격/스킬 불가)
    accounts: {},   // socketId -> 계정 키 (코인 정산용, 클라이언트에는 전송하지 않음)
    settled: false,
  };
  matches[matchId] = match;

  // 대기열에 들어온 순서대로 앞쪽 teamSize명은 A팀, 나머지는 B팀으로 배정
  entries.forEach((e, idx) => {
    const team = idx < cfg.teamSize ? 'A' : 'B';
    match.players[e.socket.id] = buildPlayer(e.socket.id, e.name, e.characterId, team, randomSpawnPoint(match.walls), e.level);
    match.accounts[e.socket.id] = e.userKey;
  });

  // 대결 화면용 참가자 목록: 닉네임, 팀, 캐릭터, 그 캐릭터의 트로피
  const roster = entries.map((e) => {
    const pl = match.players[e.socket.id];
    return { id: pl.id, name: pl.name, team: pl.team, characterId: pl.characterId, characterName: pl.characterName, trophies: e.trophies || 0, level: pl.level, device: e.socket.data.device || 'desktop' };
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
      mapId: map.id,
      mapName: map.name,
      walls: map.walls,
      bushes: map.bushes,
      winScore: cfg.winScore,
      teammateNames,
      opponentNames,
      roster,
      startsInMs: MATCH_COUNTDOWN_MS,
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

// ===== 서버 일시정지(점검) =====
// 켜면: 새 매칭을 막고, 대기 중인 사람을 모두 내보내고, 모든 접속자에게 안내 배너를 띄운다. (원하면 진행 중인 매치도 즉시 취소)
// 서버 프로세스를 끄는 게 아니라서(Render가 자동으로 다시 켜버림) 개발자 모드에서 언제든 다시 켤 수 있고, 서버가 재시작되면 자동으로 해제된다.
const serverPause = { on: false, message: '', since: 0, resumeAt: 0, timer: null };
function pauseInfo() {
  return serverPause.on ? { on: true, message: serverPause.message, since: serverPause.since, resumeAt: serverPause.resumeAt } : { on: false };
}
function setServerPause(on, { message, minutes, endMatches } = {}) {
  if (serverPause.timer) { clearTimeout(serverPause.timer); serverPause.timer = null; }
  if (!on) {
    serverPause.on = false;
    io.emit('serverPause', { on: false });
    console.log('[관리자] 서버 일시정지 해제');
    return;
  }
  serverPause.on = true;
  serverPause.message = message || '서버 점검 중입니다. 잠시 후 다시 시도해주세요.';
  serverPause.since = Date.now();
  serverPause.resumeAt = minutes > 0 ? Date.now() + minutes * 60000 : 0;
  if (minutes > 0) serverPause.timer = setTimeout(() => setServerPause(false), minutes * 60000);

  // 대기열 비우기: 기다리던 사람들에게는 매칭 취소 안내가 간다
  for (const mode in queues) {
    queues[mode].forEach((q) => { if (q.socket.connected) q.socket.emit('findMatchError', { message: serverPause.message }); });
    queues[mode] = [];
  }
  // 진행 중인 매치 취소 (코인/트로피/전적은 기록하지 않음)
  let cancelled = 0;
  if (endMatches) {
    for (const matchId of Object.keys(matches)) {
      const m = matches[matchId];
      if (!m || m.over) continue;
      m.over = true;
      m.settled = true; // 정산 없이 종료
      io.to(matchId).emit('matchOver', { reason: 'serverPaused', winnerTeam: null, teamScore: m.teamScore, coinReward: 0 });
      setTimeout(() => endMatch(matchId), MATCH_CLEANUP_DELAY_MS);
      cancelled += 1;
    }
  }
  io.emit('serverPause', pauseInfo());
  console.log(`[관리자] 서버 일시정지: "${serverPause.message}" ${minutes > 0 ? `${minutes}분 뒤 자동 해제` : '수동 해제'}${endMatches ? `, 진행 중 매치 ${cancelled}개 취소` : ''}`);
}

// ===== 개발자 모드 (관리자 전용 이벤트) =====
async function buildAdminStatus() {
  let activeMatches = 0;
  for (const id in matches) if (matches[id] && !matches[id].over) activeMatches += 1;
  let queued = 0;
  for (const mode in queues) queued += queues[mode].length;
  const banned = await db.getBannedUsers();
  return {
    pause: pauseInfo(),
    connected: io.engine.clientsCount,
    loggedIn: onlineUsers.size,
    activeMatches,
    queued,
    banned: banned.map((b) => ({ name: b.name, permanent: b.bannedUntil >= BAN_PERMANENT, bannedUntil: b.bannedUntil, reason: b.reason })),
  };
}

function registerAdminHandlers(socket) {
  let lastAt = 0;
  // 관리자가 아니면 어떤 정보도 알려주지 않고 거절. 너무 빠른 연타도 막는다.
  function guard(ack) {
    if (typeof ack !== 'function') return false;
    if (!socket.data.userKey || socket.data.userKey !== ADMIN_KEY) { ack({ ok: false, message: '권한이 없습니다.' }); return false; }
    const now = Date.now();
    if (now - lastAt < 300) { ack({ ok: false, message: '잠시 후 다시 시도해주세요.' }); return false; }
    lastAt = now;
    return true;
  }
  async function reply(ack, message) {
    ack({ ok: true, message, status: await buildAdminStatus(), announcements: allAnnouncements() });
  }

  socket.on('adminStatus', async (data, ack) => {
    if (!guard(ack)) return;
    try { await reply(ack); } catch (e) { console.error('adminStatus 오류', e); ack({ ok: false, message: '서버 오류가 발생했습니다.' }); }
  });

  socket.on('adminBan', async (data, ack) => {
    if (!guard(ack)) return;
    try {
      const username = data && typeof data.username === 'string' ? data.username.trim() : '';
      if (!username || username.length > 12) return ack({ ok: false, message: '정지할 아이디를 입력하세요.' });
      const key = username.toLowerCase();
      if (key === ADMIN_KEY) return ack({ ok: false, message: '개발자 계정은 정지할 수 없습니다.' });

      let until;
      if (data.minutes === 'permanent') until = BAN_PERMANENT;
      else {
        const minutes = Math.floor(Number(data.minutes));
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > BAN_MAX_MINUTES) return ack({ ok: false, message: '정지 기간이 올바르지 않습니다.' });
        until = Date.now() + minutes * 60000;
      }
      const reason = (typeof data.reason === 'string' ? data.reason : '').replace(/\s+/g, ' ').trim().slice(0, 60);

      const user = await db.findUser(key);
      if (!user) return ack({ ok: false, message: '존재하지 않는 아이디입니다.' });
      const updated = await db.setBan(key, until, reason);
      if (!updated) return ack({ ok: false, message: '정지에 실패했습니다.' });

      // 지금 접속 중이면 바로 내보낸다 (매치 중이었다면 상대방이 이긴 것으로 처리됨)
      const sid = onlineUsers.get(key);
      const target = sid && io.sockets.sockets.get(sid);
      if (target) {
        target.emit('banned', { message: banMessage(updated) });
        setTimeout(() => target.disconnect(true), 300);
      }
      presenceCache = { at: 0, rows: null, total: 0 };
      console.log(`[관리자] 정지: ${updated.name} (${until >= BAN_PERMANENT ? '영구' : new Date(until).toISOString()}) 사유: ${reason || '없음'}`);
      await reply(ack, `${updated.name} 님을 정지했습니다.${target ? ' (접속 중이어서 바로 내보냈어요)' : ''}`);
    } catch (e) {
      console.error('adminBan 오류', e);
      ack({ ok: false, message: '서버 오류가 발생했습니다.' });
    }
  });

  socket.on('adminUnban', async (data, ack) => {
    if (!guard(ack)) return;
    try {
      const username = data && typeof data.username === 'string' ? data.username.trim() : '';
      if (!username || username.length > 12) return ack({ ok: false, message: '아이디가 올바르지 않습니다.' });
      const updated = await db.clearBan(username.toLowerCase());
      if (!updated) return ack({ ok: false, message: '존재하지 않는 아이디입니다.' });
      console.log(`[관리자] 정지 해제: ${updated.name}`);
      await reply(ack, `${updated.name} 님의 정지를 해제했습니다.`);
    } catch (e) {
      console.error('adminUnban 오류', e);
      ack({ ok: false, message: '서버 오류가 발생했습니다.' });
    }
  });

  // 공지사항 올리기: 서버가 모든 값을 다시 검증하고, 저장한 뒤 접속 중인 모두에게 바로 알린다
  socket.on('adminPostNotice', async (data, ack) => {
    if (!guard(ack)) return;
    try {
      const d = data || {};
      const tag = NOTICE_TAGS.includes(d.tag) ? d.tag : 'etc';
      const title = (typeof d.title === 'string' ? d.title : '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!title) return ack({ ok: false, message: '제목을 입력하세요.' });
      const items = (typeof d.text === 'string' ? d.text : '').split(/\r?\n/)
        .map((l) => l.replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).slice(0, 10);
      if (!items.length) return ack({ ok: false, message: '내용을 입력하세요. (한 줄이 항목 하나가 됩니다)' });
      if (customAnnouncements.length >= MAX_CUSTOM_ANNOUNCEMENTS) return ack({ ok: false, message: '공지가 너무 많습니다. 오래된 공지를 삭제해주세요.' });

      const notice = { id: `custom-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, date: missionDay(), tag, title, items, createdAt: Date.now() };
      await db.addAnnouncement(notice);
      customAnnouncements.unshift(notice);
      io.emit('announcementsUpdate', { announcements: allAnnouncements() });
      console.log(`[관리자] 공지 등록: ${title}`);
      await reply(ack, '📢 공지사항을 올렸습니다.');
    } catch (e) {
      console.error('adminPostNotice 오류', e);
      ack({ ok: false, message: '서버 오류가 발생했습니다.' });
    }
  });

  // 개발자 모드로 올린 공지 삭제 (코드에 적힌 기본 공지는 삭제할 수 없음)
  socket.on('adminDeleteNotice', async (data, ack) => {
    if (!guard(ack)) return;
    try {
      const id = data && typeof data.id === 'string' ? data.id : '';
      if (!id.startsWith('custom-') || !customAnnouncements.some((a) => a.id === id)) return ack({ ok: false, message: '삭제할 수 없는 공지입니다.' });
      await db.deleteAnnouncement(id);
      customAnnouncements = customAnnouncements.filter((a) => a.id !== id);
      io.emit('announcementsUpdate', { announcements: allAnnouncements() });
      console.log(`[관리자] 공지 삭제: ${id}`);
      await reply(ack, '공지사항을 삭제했습니다.');
    } catch (e) {
      console.error('adminDeleteNotice 오류', e);
      ack({ ok: false, message: '서버 오류가 발생했습니다.' });
    }
  });

  socket.on('adminSetPause', async (data, ack) => {
    if (!guard(ack)) return;
    try {
      const on = !!(data && data.on);
      if (!on) {
        setServerPause(false);
        return await reply(ack, '서버를 다시 시작했습니다. 이제 매칭할 수 있어요.');
      }
      const minutes = Math.floor(Number(data.minutes) || 0);
      if (minutes < 0 || minutes > 1440) return ack({ ok: false, message: '자동 해제 시간은 0~1440분이어야 합니다.' });
      const message = (typeof data.message === 'string' ? data.message : '').replace(/\s+/g, ' ').trim().slice(0, 60);
      setServerPause(true, { message, minutes, endMatches: !!data.endMatches });
      await reply(ack, '서버를 일시정지했습니다.');
    } catch (e) {
      console.error('adminSetPause 오류', e);
      ack({ ok: false, message: '서버 오류가 발생했습니다.' });
    }
  });
}

io.on('connection', (socket) => {
  console.log(`플레이어 접속: ${socket.id}`);
  socket.data.device = normalizeDevice(socket.handshake.auth && socket.handshake.auth.device, socket.handshake.headers['user-agent']);
  broadcastOnlineCount();
  registerAdminHandlers(socket); // 개발자 모드 (정지 / 서버 일시정지) - 개발자 계정만 사용 가능
  if (serverPause.on) socket.emit('serverPause', pauseInfo()); // 점검 중에 들어온 사람에게도 안내 배너를 보여줌
  registerAuthHandlers(socket); // 회원가입 / 로그인 / 로그아웃 / 캐릭터 잠금해제

  // 클라이언트가 닉네임 + 모드 + 캐릭터를 정한 뒤 'findMatch' 이벤트를 보내면 대기열에 등록하고 매칭을 시도
  socket.on('findMatch', async (data) => {
    if (socketToMatch[socket.id]) return; // 이미 매치 중이면 무시
    if (isQueued(socket.id)) return; // 이미 어딘가 대기 중이면 무시
    if (!socket.data.userKey) { socket.emit('findMatchError', { message: '로그인이 필요합니다.' }); return; }
    if (serverPause.on) { socket.emit('findMatchError', { message: serverPause.message }); return; } // 서버 일시정지 중에는 새 매칭 불가

    const mode = data && MODES[data.mode] ? data.mode : '1v1';
    const name = socket.data.displayName; // 닉네임은 로그인한 아이디로 고정
    const requestedId = data && data.characterId;
    // 서버가 직접 캐릭터 ID를 검증 (클라이언트가 보낸 능력치는 절대 신뢰하지 않음)
    if (!CHARACTERS[requestedId] || !socket.data.unlocked.has(requestedId)) {
      socket.emit('findMatchError', { message: '잠금해제되지 않은 캐릭터입니다.' });
      return;
    }
    const characterId = requestedId;
    const userKey = socket.data.userKey;

    // 대결 화면에 보여줄 트로피는 클라이언트가 보낸 값이 아니라 서버 저장소의 값을 사용
    // 캐릭터 레벨(체력/공격력 강화)도 서버 저장소의 값만 사용한다
    let trophies = 0;
    let level = 1;
    try {
      const u = await db.findUser(userKey);
      trophies = (u && u.trophies && u.trophies[characterId]) || 0;
      level = levelOf(u, characterId);
    } catch (e) {
      console.error('트로피 조회 실패', userKey, e);
    }

    // 조회하는 동안 연결이 끊기거나 로그아웃/중복 요청이 있었는지 다시 확인
    if (!socket.connected || socket.data.userKey !== userKey) return;
    if (socketToMatch[socket.id] || isQueued(socket.id)) return;
    if (serverPause.on) { socket.emit('findMatchError', { message: serverPause.message }); return; } // 조회하는 사이에 일시정지가 켜진 경우

    queues[mode].push({ socket, name, characterId, userKey, trophies, level });
    // 이 모드에서 이미 기다리고 있던 사람들에게도 갱신된 인원수를 함께 알림
    broadcastQueueStatus(mode);

    tryMatchmaking(mode);
  });

  socket.on('cancelFindMatch', () => {
    const mode = Object.keys(queues).find((m) => queues[m].some((q) => q.socket.id === socket.id));
    leaveQueue(socket.id);
    if (mode) broadcastQueueStatus(mode); // 남아있는 대기자들에게 줄어든 인원수를 알림
  });

  // 클라이언트가 매 프레임 자신의 위치/각도를 전송
  socket.on('playerUpdate', (data) => {
    const match = matches[socketToMatch[socket.id]];
    if (!match || match.over || Date.now() < match.startsAt) return; // 대결 화면(카운트다운) 중에는 입력 무시
    const p = match.players[socket.id];
    if (!p || !p.alive) return;
    if (p.dashing || p.knockbackTimeLeft > 0 || (p.stunnedUntil && Date.now() < p.stunnedUntil)) {
      p.lastServerControlAt = Date.now(); // 서버가 위치를 제어한 마지막 시각 (아래 '낡은 위치' 거르기에 사용)
      return; // 돌진/기절 중에는 서버가 위치를 제어하므로 클라이언트 입력을 무시
    }
    if (typeof data.x !== 'number' || typeof data.y !== 'number') return;

    // 공격 선딜 중(업할)에는 위치를 바꿀 수 없고 조준 방향만 돌릴 수 있다
    if (p.windupUntil && Date.now() < p.windupUntil) {
      if (typeof data.angle === 'number') p.angle = data.angle;
      return;
    }

    const newX = Math.max(PLAYER_RADIUS, Math.min(ARENA_WIDTH - PLAYER_RADIUS, data.x));
    const newY = Math.max(PLAYER_RADIUS, Math.min(ARENA_HEIGHT - PLAYER_RADIUS, data.y));
    const prevX = p.x;
    const prevY = p.y;

    // 돌진/넉백/기절이 막 끝난 직후에는, 서버가 위치를 제어하던 동안 클라이언트가 보내 둔 '낡은(뒤쪽) 위치'가
    // 네트워크 지연 때문에 뒤늦게 도착한다. 이걸 그대로 받으면 벽 앞에서 멈춘 캐릭터가 뒤로 튕겨나가 보이므로,
    // 끝난 직후 0.5초 동안은 서버 위치에서 크게 벗어난 좌표는 무시한다 (클라이언트가 최신 위치로 맞추면 곧바로 정상 처리)
    if (p.lastServerControlAt && Date.now() - p.lastServerControlAt < 500 && Math.hypot(newX - prevX, newY - prevY) > 40) {
      if (typeof data.angle === 'number') p.angle = data.angle;
      return;
    }

    // 벽 충돌: 축별로 따로 검사해서 벽에 닿아도 옆으로는 미끄러지듯 이동 가능
    if (!collidesWithWalls(match.walls, newX, p.y, PLAYER_RADIUS)) {
      p.x = newX;
    }
    if (!collidesWithWalls(match.walls, p.x, newY, PLAYER_RADIUS)) {
      p.y = newY;
    }

    // 실제로 움직인 방향 기록 (시스템의 공격 돌진이 '현재 이동 중인 방향'을 알기 위해 사용)
    const mvx = p.x - prevX;
    const mvy = p.y - prevY;
    const mvLen = Math.hypot(mvx, mvy);
    if (mvLen > 0.3) {
      p.moveDirX = mvx / mvLen;
      p.moveDirY = mvy / mvLen;
      p.lastMoveAt = Date.now();
    }

    if (typeof data.angle === 'number') p.angle = data.angle;
  });

  // 기본 공격 발사 요청
  socket.on('shoot', () => {
    const match = matches[socketToMatch[socket.id]];
    if (!match || match.over || Date.now() < match.startsAt) return; // 대결 화면(카운트다운) 중에는 입력 무시
    const p = match.players[socket.id];
    if (!p || !p.alive) return;
    if (p.dashing || p.knockbackTimeLeft > 0 || (p.stunnedUntil && Date.now() < p.stunnedUntil)) return; // 돌진/기절 중에는 공격 불가

    const now = Date.now();
    if (p.basic.type === 'charge') return; // 똥파리는 shoot이 아니라 chargeStart/chargeRelease로 공격함
    if (p.windupUntil && now < p.windupUntil) return; // 공격 선딜 중에는 다시 공격할 수 없음
    if (now - p.lastShotAt < FIRE_COOLDOWN_MS) return; // 연사 방지 (최소 발사 간격)
    if (p.ammo <= 0) return; // 탄창이 비어있으면 발사 불가

    const ammoBeforeShot = p.ammo;
    p.ammo -= 1;
    p.lastShotAt = now;

    if (p.basic.type === 'combo') {
      // 시스템: 남은 탄창에 따라 1번(원거리 구슬) -> 2번(던지는 구슬) -> 3번(소용돌이 3개) 순서로 공격.
      // 가젯으로 탄창을 다시 채우면 다시 1번부터 시작한다.
      const phase = Math.max(0, Math.min(p.basic.combo.length - 1, p.maxAmmo - ammoBeforeShot));
      spawnProjectiles(match, p, p.basic.combo[phase], false);
      // 공격할 때마다 '발사하는 순간 이동 중이던 방향'으로 돌진하되, 총알을 쏜 뒤 dash.delay초 뒤에 시작한다.
      // (최근 0.15초 안에 실제로 움직였을 때만. 서 있으면 돌진 없이 제자리에서 공격)
      if (p.basic.dash && p.lastMoveAt && now - p.lastMoveAt <= 150) {
        const dashSpec = p.basic.dash;
        const dirX = p.moveDirX;
        const dirY = p.moveDirY;
        const dasherId = p.id;
        p.comboDashId = (p.comboDashId || 0) + 1;
        const myComboDashId = p.comboDashId;
        const matchId2 = match.id;
        setTimeout(() => {
          const m = matches[matchId2];
          if (!m || m.over) return;
          const s2 = m.players[dasherId];
          if (!s2 || !s2.alive || s2.comboDashId !== myComboDashId) return; // 죽었거나 새 공격으로 대체됨
          if (s2.leaping || s2.dashing || s2.airborneTimeLeft > 0 || s2.knockbackTimeLeft > 0 || (s2.stunnedUntil && Date.now() < s2.stunnedUntil)) return; // 그 사이 기절/넉백/띄워짐이면 돌진 취소
          s2.dashing = true;
          s2.dashHarmless = true; // 피해/기절 없이 이동만 하는 돌진
          s2.dashSpeed = dashSpec.speed;
          s2.dashDirX = dirX;
          s2.dashDirY = dirY;
          s2.dashTimeLeft = dashSpec.duration;
          s2.dashTotal = dashSpec.duration;
        }, (dashSpec.delay || 0) * 1000);
      }
    } else if ((p.basic.type === 'melee' || p.basic.type === 'quake') && p.basic.windup > 0) {
      // 업할의 망치 지진: 버튼을 누르면 windup초 동안 이동 불가 상태로 망치를 치켜들고, 시간이 지나면 그때의 조준 방향으로 지진 발동
      const windupMs = p.basic.windup * 1000;
      p.windupId = (p.windupId || 0) + 1;
      const myWindupId = p.windupId;
      p.windupUntil = now + windupMs;
      p.windupTotal = windupMs;
      const attackerId = p.id;
      const atkSpec = p.basic;
      const matchId = match.id;
      setTimeout(() => {
        const m = matches[matchId];
        if (!m || m.over) return;
        const s = m.players[attackerId];
        if (!s || !s.alive || s.windupId !== myWindupId) return; // 죽었거나 리스폰/취소된 경우
        s.windupUntil = 0;
        if (s.leaping || (s.stunnedUntil && Date.now() < s.stunnedUntil)) return; // 선딜 중 기절당하면 공격이 취소됨
        performMeleeAttack(m, s, atkSpec, false);
      }, windupMs);
    } else if (p.basic.type === 'melee' || p.basic.type === 'quake') {
      performMeleeAttack(match, p, p.basic, false);
    } else if (p.basic.type === 'multiStab') {
      // 모카의 양손 찌르기: 발사 순간의 조준 방향으로 짧은 간격으로 stabCount번 연달아 찌른다 (첫 번째는 즉시)
      const stabAngle = p.angle;
      const stabberId = p.id;
      const stabSpec = p.basic;
      for (let i = 0; i < stabSpec.stabCount; i++) {
        const stab = () => {
          const m = matches[match.id];
          if (!m || m.over) return;
          const s = m.players[stabberId];
          if (!s || !s.alive || s.leaping) return;
          if (s.stunnedUntil && Date.now() < s.stunnedUntil) return; // 기절당하면 남은 찌르기는 끊김
          performMeleeAttack(m, s, stabSpec, false, stabAngle, i);
        };
        if (i === 0) stab();
        else setTimeout(stab, i * stabSpec.stabInterval * 1000);
      }
    } else if (p.basic.type === 'dash') {
      // 꽈리의 돌진 박치기: 실제 이동/충돌 판정은 updateMatch의 돌진 처리가 수행
      p.dashing = true;
      p.dashHarmless = false;
      p.dashSpeed = p.basic.speed;
      p.dashDamage = p.basic.damage;
      p.dashStun = 0;
      p.dashCharge = true;
      p.dashDirX = Math.cos(p.angle);
      p.dashDirY = Math.sin(p.angle);
      p.dashTimeLeft = p.basic.duration;
      p.dashTotal = p.dashTimeLeft; // 돌진 속도 곡선(처음 빠르고 점점 느려짐)을 계산하기 위한 전체 시간
      p.dashHitIds = []; // 이번 돌진에서 이미 맞힌 대상 (관통 돌진이 같은 적을 두 번 때리지 않도록)
    } else {
      spawnProjectiles(match, p, p.basic, false);
    }
  });

  // 똥파리의 충전 공격: 공격 버튼을 누르는 동안(chargeStart ~ chargeRelease) 충전하고, 떼는 순간 충전 시간에 비례한 피해/크기의 똥을 발사한다.
  // 충전 시간은 클라이언트가 보낸 값이 아니라 서버가 직접 잰다 (연사 방지 쿨다운은 다른 캐릭터와 동일하게 적용).
  function isChargeBlocked(p, now) {
    return !p.alive || p.dashing || p.leaping || p.airborneTimeLeft > 0 || p.knockbackTimeLeft > 0 || (p.stunnedUntil && now < p.stunnedUntil);
  }

  socket.on('chargeStart', () => {
    const match = matches[socketToMatch[socket.id]];
    if (!match || match.over || Date.now() < match.startsAt) return; // 대결 화면(카운트다운) 중에는 입력 무시
    const p = match.players[socket.id];
    if (!p || p.basic.type !== 'charge') return;
    if (p.chargeStartAt) return; // 이미 충전 중
    const now = Date.now();
    if (isChargeBlocked(p, now)) return;
    // 발사 후 fireCooldown초 동안은 다음 발사 불가: 쿨다운 중에 눌러도 충전은 쿨다운이 끝난 시점부터 시작됨
    const cdEnd = p.lastShotAt + (p.basic.fireCooldown || 0) * 1000;
    p.chargeStartAt = Math.max(now, cdEnd);
    p.chargeRatio = 0;
  });

  socket.on('chargeRelease', (data) => {
    const match = matches[socketToMatch[socket.id]];
    if (!match || match.over) return;
    const p = match.players[socket.id];
    if (!p || !p.chargeStartAt) return;
    const now = Date.now();
    const spec = p.basic;
    const heldSec = (now - p.chargeStartAt) / 1000;
    p.chargeStartAt = 0;
    p.chargeRatio = 0;
    if (isChargeBlocked(p, now)) return; // 충전 중 기절 등으로 조작 불가가 되면 발사되지 않음
    if (now - p.lastShotAt < (spec.fireCooldown || 0) * 1000) return; // 발사 후 쿨다운 중에는 발사 불가
    if (data && typeof data.angle === 'number' && Number.isFinite(data.angle)) p.angle = data.angle;

    const ratio = Math.max(0, Math.min(1, heldSec / (spec.chargeTime || 3)));
    const damage = roundTo(spec.minDamage + (spec.maxDamage - spec.minDamage) * ratio, 5);
    p.lastShotAt = now;
    spawnProjectiles(match, p, { ...spec, damage }, false);
  });

  // 충전 취소(창 포커스를 잃었을 때 등): 발사하지 않고 충전만 끝냄
  socket.on('chargeCancel', () => {
    const match = matches[socketToMatch[socket.id]];
    if (!match) return;
    const p = match.players[socket.id];
    if (!p) return;
    p.chargeStartAt = 0;
    p.chargeRatio = 0;
  });

  // 가젯 사용 요청 (재사용 대기시간이 끝났을 때만 발동, 탄약/궁극기 게이지는 소모하지 않음)
  socket.on('gadget', () => {
    const match = matches[socketToMatch[socket.id]];
    if (!match || match.over || Date.now() < match.startsAt) return; // 대결 화면(카운트다운) 중에는 입력 무시
    const p = match.players[socket.id];
    if (!p || !p.alive) return;
    if (p.dashing || p.knockbackTimeLeft > 0 || (p.stunnedUntil && Date.now() < p.stunnedUntil)) return;
    if (!p.gadget || p.gadgetCooldownLeft > 0) return;

    const gadget = p.gadget;

    if (gadget.type === 'burst') {
      // 발사 순간의 조준 방향으로 총알을 짧은 간격으로 연달아 발사 (첫 발은 즉시)
      const fireAngle = p.angle;
      const shooterId = p.id;
      for (let i = 0; i < gadget.bulletCount; i++) {
        const fire = () => {
          const m = matches[match.id];
          if (!m || m.over) return;
          const shooter = m.players[shooterId];
          if (!shooter || !shooter.alive) return;
          spawnProjectiles(m, shooter, gadget, false, fireAngle);
        };
        if (i === 0) fire();
        else setTimeout(fire, i * gadget.interval * 1000);
      }
    } else if (gadget.type === 'poopBomb') {
      // 똥파리의 가젯: 조준한 방향으로 폭발하는 똥을 발사 (폭발은 updateMatch 의 총알 처리에서 일어남)
      spawnProjectiles(match, p, gadget, false);
      effectIdCounter += 1;
      match.effects.push({ id: effectIdCounter, type: 'poopLaunch', x: p.x + Math.cos(p.angle) * (PLAYER_RADIUS + 5), y: p.y + Math.sin(p.angle) * (PLAYER_RADIUS + 5), angle: p.angle, life: 0.3, maxLife: 0.3 }); // 발사 연기 연출
    } else if (gadget.type === 'heal') {
      // 진우Park의 소다 마시기: 체력을 즉시 healAmount만큼 회복 (최대 체력 초과 불가)
      p.hp = Math.min(p.maxHp, p.hp + (gadget.healAmount || 0));
    } else if (gadget.type === 'reloadAmmo') {
      p.ammo = p.maxAmmo;
      p.ammoRegenElapsed = 0;
    } else if (gadget.type === 'shield') {
      // 슈의 가젯: shieldHp만큼 피해를 막는 보호막 (재사용 시 남은 양이 아니라 새로 shieldHp로 채워짐)
      p.shieldHp = gadget.shieldHp || 1000;
      p.shieldMax = p.shieldHp;
    } else if (gadget.type === 'invincible') {
      // 슈의 가젯: duration초 동안 무적 (재사용 시 남은 시간이 아니라 새로 duration초로 갱신)
      p.invincibleUntil = Date.now() + (gadget.duration || 1.5) * 1000;
    } else if (gadget.type === 'speedBoost') {
      // 원효대사의 가젯: duration초 동안 이동속도 증가 (재사용 시 새로 duration초로 갱신)
      p.speedBoostUntil = Date.now() + (gadget.duration || 2) * 1000;
      p.speedBoostMultiplier = gadget.speedMultiplier || 1.3;
    } else if (gadget.type === 'reloadBoost') {
      // 꽈리의 가젯: duration초 동안 재장전 속도 증가 (재사용 시 새로 duration초로 갱신)
      p.reloadBoostUntil = Date.now() + (gadget.duration || 3) * 1000;
      p.reloadBoostMultiplier = gadget.speedMultiplier || 1.25;
    } else if (gadget.type === 'sprint') {
      // 변기통의 가젯: 바라보는(조준) 방향으로 짧게 돌진. 실제 이동/벽 충돌은 updateMatch의 돌진 처리가 수행하고,
      // dashHarmless라서 적에게 피해/기절을 주지 않고 적을 그대로 통과한다
      p.dashing = true;
      p.dashHarmless = true;
      p.dashSpeed = gadget.speed || 1000;
      p.dashDirX = Math.cos(p.angle);
      p.dashDirY = Math.sin(p.angle);
      p.dashTimeLeft = gadget.duration || 0.16;
      p.dashTotal = p.dashTimeLeft; // 돌진 속도 곡선(처음 빠르고 점점 느려짐)을 계산하기 위한 전체 시간
      p.dashHitIds = []; // 이번 돌진에서 이미 맞힌 대상 (관통 돌진이 같은 적을 두 번 때리지 않도록)
    } else if (gadget.type === 'ultCharge') {
      // 모카의 가젯: duration초에 걸쳐 궁극기 게이지를 amount%만큼 천천히 채움 (재사용 시 새로 갱신, 실제 충전은 updateMatch가 수행)
      p.ultGadgetLeft = gadget.duration || 4;
      p.ultGadgetRate = (gadget.amount || 50) / (gadget.duration || 4);
    } else if (gadget.type === 'powerCharge') {
      // 보배의 가젯: chargeTime초 동안 이동/공격 불가(기절과 같은 방식으로 막음) -> 이후 boostDuration초 동안 공격력 증가
      const now = Date.now();
      const chargeMs = (gadget.chargeTime || 2) * 1000;
      p.stunnedUntil = Math.max(p.stunnedUntil || 0, now + chargeMs);
      p.chargingUntil = now + chargeMs;
      p.damageBoostFrom = now + chargeMs;
      p.damageBoostUntil = now + chargeMs + (gadget.boostDuration || 5) * 1000;
      p.damageBoostMultiplier = gadget.damageMultiplier || 1.5;
    }

    p.gadgetCooldownLeft = GADGET_COOLDOWN_SEC;
  });

  // 궁극기 발사 요청 (게이지가 100%일 때만 발동)
  socket.on('ultimate', (data) => {
    const match = matches[socketToMatch[socket.id]];
    if (!match || match.over || Date.now() < match.startsAt) return; // 대결 화면(카운트다운) 중에는 입력 무시
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
      // 실제 이동/벽 충돌/적 관통(대미지+기절) 판정을 수행한다
      p.dashing = true;
      p.dashHarmless = false;
      p.dashSpeed = ult.speed || 0;
      p.dashDamage = ult.damage;
      p.dashStun = ult.stunDuration || 0;
      p.dashCharge = false;
      p.dashDirX = Math.cos(p.angle);
      p.dashDirY = Math.sin(p.angle);
      p.dashTimeLeft = ult.duration || 0.4;
      p.dashTotal = p.dashTimeLeft; // 돌진 속도 곡선(처음 빠르고 점점 느려짐)을 계산하기 위한 전체 시간
      p.dashHitIds = []; // 이번 돌진에서 이미 맞힌 대상 (관통 돌진이 같은 적을 두 번 때리지 않도록)
    } else if (ult.type === 'burst') {
      // 꽈리의 고추 발사: 발사 순간의 조준 방향으로 고추를 짧은 간격으로 연달아 발사 (첫 발은 즉시)
      const fireAngle = p.angle;
      const shooterId = p.id;
      for (let i = 0; i < ult.bulletCount; i++) {
        const fire = () => {
          const m = matches[match.id];
          if (!m || m.over) return;
          const shooter = m.players[shooterId];
          if (!shooter || !shooter.alive) return;
          spawnProjectiles(m, shooter, ult, true, fireAngle);
        };
        if (i === 0) fire();
        else setTimeout(fire, i * ult.interval * 1000);
      }
    } else if (ult.type === 'turret') {
      // 성스럽다의 저격 터렛: 조준 불필요, 즉시 자신의 위치에 자동 사격 터렛을 설치
      spawnTurret(match, p, ult);
    } else if (ult.type === 'heal') {
      // 여똥이의 간식 처먹기: 조준 불필요, 즉시 체력을 가득 채움
      p.hp = p.maxHp;
    } else if (ult.type === 'timedBomb') {
      // 보배 폭발: 조준 불필요, 자신의 위치에 설치
      spawnBomb(match, p, ult);
    } else if (ult.type === 'leap') {
      // 모카의 도약 강습: 바라보는 방향으로 벽을 무시하고 점프. 착지 지점은 즉시 정하고(벽 안이면 가까운 빈 곳으로 되돌림),
      // 실제 이동/착지 피해는 updateMatch가 처리한다. 점프 시간 동안은 stunnedUntil로 입력을 막는다.
      // 점프 거리는 클라이언트가 조준한 값(PC: 마우스까지의 거리 / 모바일: 스틱을 당긴 정도)을 보내오지만,
      // 서버가 항상 minDistance ~ distance 범위로 제한한다 (이상한 값이 와도 최대 거리를 넘지 못함). 값이 없으면 최대 거리.
      const maxDist = ult.distance;
      const minDist = Math.min(maxDist, ult.minDistance || 0);
      const sent = data && typeof data.distance === 'number' && Number.isFinite(data.distance) ? data.distance : maxDist;
      const leapDist = Math.max(minDist, Math.min(maxDist, sent));
      let tx = p.x;
      let ty = p.y;
      for (let d = leapDist; d >= 0; d -= 10) {
        const cx = Math.max(PLAYER_RADIUS, Math.min(ARENA_WIDTH - PLAYER_RADIUS, p.x + Math.cos(p.angle) * d));
        const cy = Math.max(PLAYER_RADIUS, Math.min(ARENA_HEIGHT - PLAYER_RADIUS, p.y + Math.sin(p.angle) * d));
        if (!collidesWithWalls(match.walls, cx, cy, PLAYER_RADIUS + 4)) { tx = cx; ty = cy; break; }
      }
      // 공중 시간은 거리에 비례시켜 짧게 뛰어도 점프 속도가 같게 하되, 너무 순식간이 되지 않도록 최소 0.3초
      const leapDuration = Math.max(0.3, (ult.duration || 0.4) * (leapDist / maxDist));
      const leapMs = leapDuration * 1000;
      p.leaping = true;
      p.leapTotal = leapDuration;
      p.leapTimeLeft = p.leapTotal;
      p.leapStartX = p.x;
      p.leapStartY = p.y;
      p.leapTargetX = tx;
      p.leapTargetY = ty;
      p.leapDamage = ult.damage;
      p.leapRadius = ult.landRadius || 90;
      p.leapKnockback = ult.knockback || 0;
      p.leapEndsAt = Date.now() + leapMs + 400; // 서버 틱 오차를 감안한 여유
      p.stunnedUntil = p.leapEndsAt;
    } else if (ult.type === 'summonChicken') {
      // 엑헤의 닭 소환: 조준 불필요, 즉시 닭을 소환
      spawnChicken(match, p, ult);
    } else if (ult.type === 'quake') {
      // 업할의 대지 강타: 조준한 방향으로 넓고 먼 부채꼴 지진 (피해 + 기절). 궁극기 게이지는 충전하지 않음
      performMeleeAttack(match, p, ult, true);
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
    releaseAccount(socket);
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
      io.to(matchId).emit('matchOver', { reason: 'opponentLeft', winnerTeam, teamScore: match.teamScore, coinReward: Math.floor((MODES[match.mode].coinReward || 0) / 2) });
      settleMatch(match, winnerTeam, 'opponentLeft', socket.id);
    }
    endMatch(matchId);
  });
});

// ===== 매치별 물리 처리 (한 틱 분량) =====
function updateMatch(match, dt, now) {
  // 모카의 도약 강습: 벽을 무시하고 시작점 -> 착지점으로 직선 이동하다가, 시간이 다 되면 착지하면서 주변 적에게 피해
  for (const pid in match.players) {
    if (match.over) break;
    const p = match.players[pid];
    if (!p.leaping) continue;
    if (!p.alive) { p.leaping = false; continue; }

    p.leapTimeLeft -= dt;
    const t = Math.min(1, 1 - Math.max(0, p.leapTimeLeft) / (p.leapTotal || 0.4));
    p.x = p.leapStartX + (p.leapTargetX - p.leapStartX) * t;
    p.y = p.leapStartY + (p.leapTargetY - p.leapStartY) * t;
    if (p.leapTimeLeft > 0) continue;

    // 착지
    p.x = p.leapTargetX;
    p.y = p.leapTargetY;
    p.leaping = false;
    if (p.stunnedUntil === p.leapEndsAt) p.stunnedUntil = 0; // 점프 때문에 걸어둔 입력 차단만 해제 (다른 기절은 유지)

    effectIdCounter += 1;
    match.effects.push({ id: effectIdCounter, type: 'leapLand', x: p.x, y: p.y, radius: p.leapRadius, life: EFFECT_LIFETIME });

    for (const tid in match.players) {
      if (tid === pid) continue;
      const target = match.players[tid];
      if (!target.alive) continue;
      if (!FRIENDLY_FIRE && target.team === p.team) continue;
      if (Math.hypot(target.x - p.x, target.y - p.y) < PLAYER_RADIUS + p.leapRadius) {
        applyDamage(match, target, p.leapDamage, pid, { chargeShooter: false });
        if (match.over) break;
        // 밀쳐내기(진우Park): 착지 지점 바깥쪽으로 날려보냄 (무적이면 밀리지 않음). 실제 이동은 넉백 처리 루프가 수행
        if (p.leapKnockback > 0 && target.alive && !(target.invincibleUntil && Date.now() < target.invincibleUntil)) {
          let kx = target.x - p.x;
          let ky = target.y - p.y;
          const kd = Math.hypot(kx, ky);
          if (kd > 0.001) { kx /= kd; ky /= kd; } else { kx = Math.cos(p.angle); ky = Math.sin(p.angle); }
          target.knockbackDirX = kx;
          target.knockbackDirY = ky;
          target.knockbackDistance = p.leapKnockback;
          target.knockbackTimeLeft = KNOCKBACK_DURATION;
          target.knockbackTotalTime = KNOCKBACK_DURATION;
        }
      }
    }
    if (match.over) break;

    // 적 터렛/닭도 착지 범위 안에 있으면 피해를 입는다
    const mult = getDamageMultiplier(p);
    for (const turret of match.turrets) {
      if (turret.team === p.team) continue;
      if (Math.hypot(turret.x - p.x, turret.y - p.y) < turret.radius + p.leapRadius) turret.hp -= p.leapDamage * mult;
    }
    match.turrets = match.turrets.filter((t2) => t2.hp > 0);
    for (const chicken of match.chickens) {
      if (chicken.team === p.team) continue;
      if (Math.hypot(chicken.x - p.x, chicken.y - p.y) < chicken.radius + p.leapRadius) chicken.hp -= p.leapDamage * mult;
    }
    match.chickens = match.chickens.filter((c2) => c2.hp > 0);
  }

  // 변기통의 돌진 궁극기 처리: 서버가 매 틱마다 위치를 직접 이동시키고, 벽/적과의 충돌을 판정한다
  for (const pid in match.players) {
    if (match.over) break;
    const p = match.players[pid];
    if (!p.dashing) continue;
    if (!p.alive) { p.dashing = false; continue; }

    const ult = p.ultimate;
    // 자연스러운 돌진: 일정한 속도로 갑자기 멈추지 않고, 처음엔 빠르다가 점점 느려지며 멈춘다(ease-out).
    // 속도 곡선 v(t)=v0*(1.636*남은비율+0.182)의 평균이 v0라서 총 이동 거리(속도x시간)는 기존과 같다.
    // 또 마지막 틱이 한 틱 분량 전체를 가버려 목표보다 더 가는 일이 없도록, 마지막 틱은 남은 시간만큼만 이동한다.
    const dashTotalTime = p.dashTotal > 0 ? p.dashTotal : Math.max(0.001, p.dashTimeLeft);
    const dashFrac = Math.max(0, Math.min(1, p.dashTimeLeft / dashTotalTime));
    const dashEase = 1.636 * dashFrac + 0.182;
    const stepDt = Math.min(dt, Math.max(0, p.dashTimeLeft));
    const step = (p.dashSpeed || ult.speed || 0) * dashEase * stepDt;
    // 한 틱 이동량이 크므로(빠른 돌진) 5px 이하의 작은 걸음으로 나눠서 이동한다.
    // 그래야 벽 앞에서 한 걸음 분량이 막혀도 벽에 닿기 직전까지는 가고, 벽을 통과하지도 않는다.
    const subSteps = Math.max(1, Math.ceil(step / 5));
    const subX = (p.dashDirX * step) / subSteps;
    const subY = (p.dashDirY * step) / subSteps;
    let blockedByWall = false;
    let moved = false;
    for (let i = 0; i < subSteps; i++) {
      const nx = Math.max(PLAYER_RADIUS, Math.min(ARENA_WIDTH - PLAYER_RADIUS, p.x + subX));
      const ny = Math.max(PLAYER_RADIUS, Math.min(ARENA_HEIGHT - PLAYER_RADIUS, p.y + subY));
      if (!collidesWithWalls(match.walls, nx, p.y, PLAYER_RADIUS)) { if (nx !== p.x) moved = true; p.x = nx; } else blockedByWall = true;
      if (!collidesWithWalls(match.walls, p.x, ny, PLAYER_RADIUS)) { if (ny !== p.y) moved = true; p.y = ny; } else blockedByWall = true;

      // 관통 돌진: 적과 닿아도 멈추지 않고 그대로 지나가며, 지나가는 길에 닿은 적마다 한 번씩 피해(+기절)를 준다.
      // 한 틱 동안 꽤 멀리 가기 때문에 틱 끝 위치만 보면 적을 건너뛸 수 있어서, 조금씩 이동할 때마다 판정한다.
      if (!p.dashHarmless) {
        if (!p.dashHitIds) p.dashHitIds = [];
        for (const tid in match.players) {
          if (match.over) break;
          const target = match.players[tid];
          if (tid === pid || !target.alive) continue;
          if (!FRIENDLY_FIRE && target.team === p.team) continue;
          if (target.leaping || target.airborneTimeLeft > 0) continue; // 공중에 있는 대상은 지나쳐도 맞지 않음
          if (p.dashHitIds.includes(tid)) continue; // 이번 돌진에서 이미 맞힌 대상
          const ddx = target.x - p.x;
          const ddy = target.y - p.y;
          if (Math.sqrt(ddx * ddx + ddy * ddy) < PLAYER_RADIUS * 2) {
            p.dashHitIds.push(tid);
            applyDamage(match, target, p.dashDamage, pid, { chargeShooter: !!p.dashCharge });
            if (!match.over && p.dashStun > 0 && !(target.invincibleUntil && now < target.invincibleUntil)) target.stunnedUntil = now + p.dashStun * 1000;
          }
        }
      }

      // 벽에 닿으면 벽을 따라 미끄러지거나 튕겨나가지 않고, 닿은 그 자리에서 그대로 멈춘다
      if (blockedByWall) break;
    }

    p.dashTimeLeft -= dt;

    // 가젯 돌진(질주) / 시스템 돌진: 피해/기절 없이 이동만 한다. 적과 부딪혀도 통과하고,
    // 벽에 막히거나 시간이 끝나면 종료
    if (p.dashHarmless) {
      if (blockedByWall || !moved || p.dashTimeLeft <= 0) p.dashing = false; // 벽에 닿으면 즉시 멈춤 (미끄러지지 않음)
      continue;
    }

    // 관통 돌진은 적에게 닿아도 멈추지 않는다. 벽에 막히거나 돌진 시간이 끝나면 종료
    if (blockedByWall || p.dashTimeLeft <= 0) p.dashing = false;
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
    if (!collidesWithWalls(match.walls, nx, p.y, PLAYER_RADIUS)) p.x = nx; else blockedByWall2 = true;
    if (!collidesWithWalls(match.walls, p.x, ny, PLAYER_RADIUS)) p.y = ny; else blockedByWall2 = true;

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
      if (isHiddenFromEnemy(match.bushes, target, turret)) continue; // 덤불/은신으로 숨은 적은 터렛도 조준하지 못함

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

  // 닭(엑헤 궁극기) AI: 가장 가까운 적(플레이어/터렛/적 닭)을 자동으로 추격하고, 닿으면 주기적으로 공격한다
  // 추격할 적이 없으면 주인 곁을 따라다닌다
  for (const chicken of match.chickens) {
    if (match.over) break;
    chicken.life -= dt;
    if (chicken.attackCooldown > 0) chicken.attackCooldown -= dt;
    if (chicken.peckTimer > 0) chicken.peckTimer -= dt;
    if (chicken.life <= 0 || chicken.hp <= 0) continue;

    const owner = match.players[chicken.ownerId];
    let target = null;
    let targetKind = null;
    let targetRadius = 0;
    let nearestDist = Infinity;

    for (const pid in match.players) {
      const t = match.players[pid];
      if (!t.alive) continue;
      if (t.team === chicken.team) continue;
      if (isHiddenFromEnemy(match.bushes, t, chicken)) continue; // 덤불/은신으로 숨은 적은 닭도 찾지 못함
      const d = Math.hypot(t.x - chicken.x, t.y - chicken.y);
      if (d <= chicken.chaseRange && d < nearestDist) { nearestDist = d; target = t; targetKind = 'player'; targetRadius = PLAYER_RADIUS; }
    }
    for (const t of match.turrets) {
      if (t.team === chicken.team) continue;
      const d = Math.hypot(t.x - chicken.x, t.y - chicken.y);
      if (d <= chicken.chaseRange && d < nearestDist) { nearestDist = d; target = t; targetKind = 'turret'; targetRadius = t.radius; }
    }
    for (const t of match.chickens) {
      if (t.team === chicken.team || t.hp <= 0 || t.life <= 0) continue;
      const d = Math.hypot(t.x - chicken.x, t.y - chicken.y);
      if (d <= chicken.chaseRange && d < nearestDist) { nearestDist = d; target = t; targetKind = 'chicken'; targetRadius = t.radius; }
    }

    if (target) {
      const reach = chicken.attackRange + chicken.radius + targetRadius;
      const dx = target.x - chicken.x;
      const dy = target.y - chicken.y;
      const dist = Math.hypot(dx, dy) || 1;

      if (chicken.retreatTimeLeft > 0) {
        // 돌격 직후: 적에게서 잠깐 물러나 거리를 벌린다 (그래야 다음 돌격이 매번 진짜 '돌진'이 됨)
        chicken.retreatTimeLeft -= dt;
        moveChicken(match, chicken, -dx / dist, -dy / dist, chicken.retreatSpeed * dt);
        continue;
      }

      // 돌격 준비가 되었고(쿨타임 종료) 적이 돌격 사거리 안에 있으면 돌격 시작
      if (!chicken.charging && chicken.attackCooldown <= 0 && dist <= chicken.chargeRange) {
        chicken.charging = true;
        chicken.chargeTimeLeft = chicken.chargeMaxTime;
      }

      if (chicken.charging) {
        // 돌격 중: 매우 빠른 속도로 목표를 향해 직진 (목표를 지나치지 않도록 남은 거리까지만 이동)
        chicken.chargeTimeLeft -= dt;
        let hit = dist <= reach;
        let blocked = false;
        if (!hit) {
          const step = Math.min(chicken.chargeSpeed * dt, dist - reach + 1);
          const bx = chicken.x, by = chicken.y;
          moveChicken(match, chicken, dx / dist, dy / dist, step);
          blocked = Math.hypot(chicken.x - bx, chicken.y - by) < step * 0.3; // 벽에 막힘
          hit = Math.hypot(target.x - chicken.x, target.y - chicken.y) <= reach;
        }

        if (hit) {
          // 적과 부딪히면 돌격 대미지를 주고 돌격 종료 (대미지는 공격력 증가 효과도 적용)
          chicken.charging = false;
          chicken.attackCooldown = chicken.attackInterval; // 이 시간이 지나야 다음 돌격 가능 (돌격 간격)
          chicken.retreatTimeLeft = chicken.retreatTime;   // 부딪힌 뒤 잠깐 뒤로 물러남
          chicken.peckTimer = 0.15;
          const dmg = chicken.damage;
          if (targetKind === 'player') {
            applyDamage(match, target, dmg, chicken.ownerId, { chargeShooter: false });
          } else {
            target.hp -= dmg * getDamageMultiplier(owner);
          }
        } else if (blocked || chicken.chargeTimeLeft <= 0) {
          // 돌격이 벽에 막히거나 시간 내에 못 맞췄으면 짧게 쉬었다가 다시 시도
          chicken.charging = false;
          chicken.attackCooldown = Math.max(chicken.attackCooldown, 0.4);
        }
      } else {
        // 돌격 대기 중에는 평상시 속도로 추격하되, 돌격 쿨타임 중에는 적에게 딱 붙지 않고
        // 돌진 거리를 확보할 수 있는 간격(chargeRange의 60%)에서 멈춰 기다린다
        const stopDist = chicken.attackCooldown > 0 ? Math.max(reach, chicken.chargeRange * 0.6) : reach;
        if (dist > stopDist) {
          const step = Math.min(chicken.moveSpeed * dt, dist - stopDist + 1);
          moveChicken(match, chicken, dx / dist, dy / dist, step);
        }
      }
    } else if (chicken.charging) {
      chicken.charging = false; // 돌격 중 목표가 사라짐(죽음/은신/덤불)
      chicken.attackCooldown = Math.max(chicken.attackCooldown, 0.4);
    } else if (owner && owner.alive) {
      const dx = owner.x - chicken.x;
      const dy = owner.y - chicken.y;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist > 90) moveChicken(match, chicken, dx / dist, dy / dist, Math.min(chicken.moveSpeed * dt, dist - 90));
    }
  }
  match.turrets = match.turrets.filter((t) => t.hp > 0);
  match.chickens = match.chickens.filter((c) => c.hp > 0 && c.life > 0);

  // 총알 이동
  for (const b of match.bullets) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
  }

  // 화면 밖, 수명 종료, 벽 충돌한 총알 제거 (poolOnImpact 발사체는 벽/맵 경계에 닿으면 물웅덩이를 남김)
  match.bullets = match.bullets.filter((b) => {
    if (b.life <= 0) {
      if (b.poolOnImpact && b.poolOnExpire) spawnWaterPool(match, b); // 계란: 사거리 끝에서 깨짐
      if (b.explodeDamage > 0) explodePoopBomb(match, b); // 폭탄 똥: 사거리 끝에서도 폭발
      return false;
    }
    if (b.x < 0 || b.x > ARENA_WIDTH || b.y < 0 || b.y > ARENA_HEIGHT) {
      if (b.explodeDamage > 0) {
        // 폭탄 똥: 맵 끝 벽에 닿은 지점(경계선 위)에서 폭발
        explodePoopBomb(match, { ...b, x: Math.max(0, Math.min(ARENA_WIDTH, b.x)), y: Math.max(0, Math.min(ARENA_HEIGHT, b.y)) });
      }
      if (b.poolOnImpact) {
        // 맵 끝 벽에 닿은 지점(경계선 위)으로 좌표를 고정해서 물웅덩이를 생성
        const clampedX = Math.max(0, Math.min(ARENA_WIDTH, b.x));
        const clampedY = Math.max(0, Math.min(ARENA_HEIGHT, b.y));
        spawnWaterPool(match, { ...b, x: clampedX, y: clampedY });
      }
      return false;
    }
    if (!b.pierceWalls && collidesWithWalls(match.walls, b.x, b.y, b.radius)) {
      if (b.poolOnImpact) spawnWaterPool(match, b);
      if (b.explodeDamage > 0) explodePoopBomb(match, b); // 폭탄 똥: 벽에 닿으면 폭발
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
      if (target.leaping) continue; // 점프 중(모카 궁극기)인 대상은 총알이 통과함
      if (target.airborneTimeLeft > 0) continue; // 하늘에 떠 있는 대상(시스템 궁극기)도 총알이 통과함
      if (!FRIENDLY_FIRE && owner && target.team === owner.team) continue; // 아군 총알은 그대로 통과
      if (b.hitIds && b.hitIds.includes(pid)) continue; // 관통 발사체가 이미 맞힌 대상은 다시 맞히지 않음

      const dx = target.x - b.x;
      const dy = target.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < PLAYER_RADIUS + b.radius) {
        if (b.launchDuration > 0) {
          // 시스템의 거대 소용돌이: 적중 즉시 피해는 없고 하늘로 띄움. 관통형이면 사라지지 않고 계속 날아감
          launchTarget(match, target, b);
          if (b.pierceTargets && b.hitIds) { b.hitIds.push(pid); continue; }
          hitBulletIds.add(b.id);
          break;
        }
        hitBulletIds.add(b.id);
        if (b.explodeDamage > 0) {
          // 폭탄 똥: 적에게 닿으면 그 자리에서 폭발 (직접 적중 피해는 따로 없고 폭발 피해만 줌)
          explodePoopBomb(match, b);
          break;
        }
        if (b.poolOnImpact) {
          // 해골물 뿌리기: 적중 시 직접 대미지 대신 물웅덩이를 생성 (궁극기 게이지는 적중으로 충전됨)
          spawnWaterPool(match, b);
          // 물이 퍼지기 전에 해골이 적에게 직접 적중하면 추가로 직접 대미지를 준다
          if (b.directDamage > 0) {
            applyDamage(match, target, b.directDamage, b.ownerId, { chargeShooter: false });
          }
          if (!b.isUltimate) {
            const shooter = match.players[b.ownerId];
            if (shooter) shooter.ultimateCharge = Math.min(100, shooter.ultimateCharge + shooter.ultimateChargePerHit);
          }
        } else {
          // 기본 공격만 궁극기 게이지를 충전시킴
          applyDamage(match, target, bulletDamageFor(b, target), b.ownerId, { chargeShooter: !b.isUltimate });
        }
        break; // 이 총알은 이미 소모됨
      }
    }
  }

  // 총알-터렛 충돌 판정: 적의 총알에 맞으면 터렛 체력이 줄고, 0이 되면 파괴됨
  for (const b of match.bullets) {
    if (match.over) break;
    if (hitBulletIds.has(b.id)) continue;
    if (b.launchDuration > 0) continue; // 띄우기 소용돌이는 터렛/닭에 영향 없이 통과

    for (const turret of match.turrets) {
      if (!FRIENDLY_FIRE && turret.team === b.team) continue; // 아군 총알은 자신의 터렛을 통과함

      const dx = turret.x - b.x;
      const dy = turret.y - b.y;
      if (Math.sqrt(dx * dx + dy * dy) < turret.radius + b.radius) {
        hitBulletIds.add(b.id);
        if (b.explodeDamage > 0) {
          explodePoopBomb(match, b); // 폭탄 똥: 터렛에 닿으면 폭발
          break;
        }
        if (b.poolOnImpact) {
          // 해골물/똥가루 뿌리기: 터렛에 적중하면 직접 대미지 대신 물웅덩이/똥가루 구름을 남겨
          // 이후 지속 대미지 판정(아래 물웅덩이 루프)으로 터렛에 피해를 준다
          spawnWaterPool(match, b);
          if (b.directDamage > 0) turret.hp -= b.directDamage; // 직접 적중 대미지
        } else {
          turret.hp -= bulletDamageFor(b, turret) * getDamageMultiplier(match.players[b.ownerId]);
        }
        break;
      }
    }
  }
  match.turrets = match.turrets.filter((t) => t.hp > 0);

  // 총알-닭 충돌 판정: 적의 닭도 총알에 맞아 죽을 수 있음
  for (const b of match.bullets) {
    if (match.over) break;
    if (hitBulletIds.has(b.id)) continue;
    if (b.launchDuration > 0) continue;
    for (const chicken of match.chickens) {
      if (chicken.hp <= 0) continue;
      if (!FRIENDLY_FIRE && chicken.team === b.team) continue;
      const cdx = chicken.x - b.x;
      const cdy = chicken.y - b.y;
      if (Math.sqrt(cdx * cdx + cdy * cdy) < chicken.radius + b.radius) {
        hitBulletIds.add(b.id);
        if (b.explodeDamage > 0) {
          explodePoopBomb(match, b); // 폭탄 똥: 닭에 닿으면 폭발
          break;
        }
        const mult = getDamageMultiplier(match.players[b.ownerId]);
        if (b.poolOnImpact) {
          spawnWaterPool(match, b);
          if (b.directDamage > 0) chicken.hp -= b.directDamage * mult;
        } else {
          chicken.hp -= bulletDamageFor(b, chicken) * mult;
        }
        break;
      }
    }
  }
  match.chickens = match.chickens.filter((c) => c.hp > 0);

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

      // 적 닭도 웅덩이 범위 안에 있으면 함께 대미지를 입음
      for (const chicken of match.chickens) {
        if (chicken.team === pool.team) continue;
        const cdx = chicken.x - pool.x;
        const cdy = chicken.y - pool.y;
        if (Math.sqrt(cdx * cdx + cdy * cdy) >= chicken.radius + pool.radius) continue;
        chicken.hp -= pool.damage * getDamageMultiplier(match.players[pool.ownerId]);
      }
      match.chickens = match.chickens.filter((c) => c.hp > 0);
    }
  }
  match.waterPools = match.waterPools.filter((pool) => pool.life > 0);

  // 매 틱마다 이동속도 배율을 먼저 1로 초기화한 뒤, 아래에서 보배 폭탄 범위 안에 있으면 다시 낮춘다
  for (const pid in match.players) {
    match.players[pid].speedMultiplier = 1;
  }

  // 보배 폭발(보배 궁극기): 설치 직후에는 '보배의 잔소리'로 주기적인 지속 피해를 주다가,
  // 퓨즈(fuseLeft)가 다 되면 한 번 크게 폭발하고 사라진다
  for (const bomb of match.bombs) {
    if (match.over) break;
    if (bomb.exploded) continue;

    // 폭발 전까지, 범위 안에 있는 적은 매 프레임(피해 주기와 무관하게) 이동속도가 감소한다
    for (const pid in match.players) {
      const target = match.players[pid];
      if (!target.alive) continue;
      if (!FRIENDLY_FIRE && target.team === bomb.team) continue;
      const sdx = target.x - bomb.x;
      const sdy = target.y - bomb.y;
      if (Math.sqrt(sdx * sdx + sdy * sdy) >= PLAYER_RADIUS + bomb.radius) continue;
      target.speedMultiplier = Math.min(target.speedMultiplier, bomb.slowMultiplier != null ? bomb.slowMultiplier : 1);
    }

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

  // 원효대사 가젯 '초인적인 힘': 감속 계산이 끝난 뒤 곱해서 적용
  for (const pid in match.players) {
    const p = match.players[pid];
    if (p.speedBoostUntil && now < p.speedBoostUntil) p.speedMultiplier *= p.speedBoostMultiplier || 1;

    // 똥파리 충전: 사망/기절/돌진 등으로 조작 불가가 되면 충전 취소. 충전 중에는 이동속도 감소 + 충전 진행도(0~1)를 갱신
    if (p.chargeStartAt) {
      const blocked = !p.alive || p.dashing || p.leaping || p.airborneTimeLeft > 0 || p.knockbackTimeLeft > 0 || (p.stunnedUntil && now < p.stunnedUntil);
      if (blocked) {
        p.chargeStartAt = 0;
        p.chargeRatio = 0;
      } else {
        p.chargeRatio = Math.max(0, Math.min(1, (now - p.chargeStartAt) / 1000 / (p.basic.chargeTime || 3)));
        p.speedMultiplier *= p.basic.chargeSpeedMultiplier || 1;
      }
    }
  }


  // 덤불 진입 여부 갱신 (죽은 플레이어는 어차피 화면에 그려지지 않으므로 false로 둠)
  for (const pid in match.players) {
    const p = match.players[pid];
    p.inBush = p.alive && isInBush(match.bushes, p.x, p.y);
  }

  // 모카의 가젯 '기합 충전': 남은 시간 동안 매 틱 궁극기 게이지를 조금씩 채움
  for (const pid in match.players) {
    const p = match.players[pid];
    if (!p.alive || !(p.ultGadgetLeft > 0)) continue;
    const used = Math.min(dt, p.ultGadgetLeft);
    p.ultGadgetLeft -= used;
    p.ultimateCharge = Math.min(100, p.ultimateCharge + p.ultGadgetRate * used);
  }

  // 가젯 재사용 대기시간 감소
  for (const pid in match.players) {
    const p = match.players[pid];
    if (p.gadgetCooldownLeft > 0) p.gadgetCooldownLeft = Math.max(0, p.gadgetCooldownLeft - dt);
  }

  // 탄약 재충전 + 무피격 체력 회복
  for (const pid in match.players) {
    const p = match.players[pid];
    if (!p.alive) continue;

    // 하늘에 떠 있던 대상(시스템 궁극기)이 땅에 떨어지는 순간: 기절을 풀고 착지 피해를 준다
    if (p.airborneTimeLeft > 0) {
      p.airborneTimeLeft -= dt;
      if (p.airborneTimeLeft <= 0) {
        p.airborneTimeLeft = 0; // 먼저 0으로 만들어야 아래 applyDamage가 피해를 무시하지 않음
        if (p.stunnedUntil === p.airborneStunUntil) p.stunnedUntil = 0;
        effectIdCounter += 1;
        match.effects.push({ id: effectIdCounter, type: 'airLanding', x: p.x, y: p.y, radius: PLAYER_RADIUS * 2.2, life: 0.4, maxLife: 0.4 });
        applyDamage(match, p, p.airborneLandDamage, p.airborneBy, { chargeShooter: false });
        if (match.over) break;
        if (!p.alive) continue;
      }
    }

    if (p.reloadAllAtOnce) {
      // 시스템: 탄창을 전부 쓴 뒤에야 재장전이 시작되고, 시간이 다 차면 한꺼번에 가득 참 (중간에는 한 발씩 차지 않음)
      if (p.ammo <= 0) {
        p.ammoRegenElapsed += dt * (p.reloadBoostUntil && now < p.reloadBoostUntil ? p.reloadBoostMultiplier || 1 : 1);
        if (p.ammoRegenElapsed >= (p.ammoRegenSeconds || AMMO_REGEN_SECONDS)) {
          p.ammo = p.maxAmmo;
          p.ammoRegenElapsed = 0;
        }
      } else {
        p.ammoRegenElapsed = 0;
      }
    } else if (p.ammo < p.maxAmmo) {
      // 탄창이 가득 차지 않았으면 시간이 지날 때마다 한 발씩 채워짐
      p.ammoRegenElapsed += dt * (p.reloadBoostUntil && now < p.reloadBoostUntil ? p.reloadBoostMultiplier || 1 : 1);
      if (p.ammoRegenElapsed >= (p.ammoRegenSeconds || AMMO_REGEN_SECONDS)) {
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
    if (isHiddenFromEnemy(match.bushes, p, viewer)) {
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
        chickens: match.chickens,
      });
    }
  }
}

setInterval(gameLoop, TICK_MS);

// 저장소(DB) 연결이 끝난 뒤에 서버를 시작한다
db.init()
  .then(async () => {
    try {
      customAnnouncements = (await db.loadAnnouncements()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch (e) {
      console.error('공지 불러오기 실패', e);
    }
    server.listen(PORT, () => {
      console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
    });
  })
  .catch((e) => {
    console.error('저장소 초기화 실패 - 서버를 시작하지 않습니다:', e);
    process.exit(1);
  });
