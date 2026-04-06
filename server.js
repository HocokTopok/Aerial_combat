const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 3000;

// ─── Константы ────────────────────────────────────────────────────────────────

const COLORS = [
  'Красный', 'Оранжевый', 'Жёлтый', 'Зелёный', 'Бирюзовый',
  'Голубой', 'Синий', 'Фиолетовый', 'Белый', 'Серый'
];

// ─── Формы самолётов ───────────────────────────────────────────────────────────
// Смещения [dx, dy, dz] от носа. Для игрока 0 нос смотрит в +X (к сопернику).
// Для игрока 1 X-смещения зеркалятся автоматически.

const PLANE_SHAPES = {
  // Малый: 2 ячейки в линию
  small: [
    [0, 0, 0],   // нос
    [-1, 0, 0],  // хвост
  ],

  // Средний: 4 в линию + 2 крыла на 2-й позиции от носа
  //      [W]
  // [T][-2][-1][N]→
  //      [W]
  medium: [
    [0, 0, 0],   // нос
    [-1, 0, 0],  // тело 1 (крылья здесь)
    [-1, -1, 0], // крыло вверх
    [-1, 1, 0],  // крыло вниз
    [-2, 0, 0],  // тело 2
    [-3, 0, 0],  // хвост
  ],

  // Большой: 10 ячеек
  //   _ ▢ _ _
  //   _ ▢ _ ▢
  //   ▢ ▢ ▢ ▢ →нос
  //   _ ▢ _ ▢
  //   _ ▢ _ _
  // Средняя колонка (dx=−2) длиной 5, носовые крылья (dx=0) ±1
  large: [
    [ 0,  0, 0],   // нос
    [-1,  0, 0],   // позвоночник 1
    [-2,  0, 0],   // позвоночник 2 / центр средней колонки
    [-3,  0, 0],   // хвост
    [-2, -1, 0],   // средняя колонка −1
    [-2, -2, 0],   // средняя колонка −2
    [-2,  1, 0],   // средняя колонка +1
    [-2,  2, 0],   // средняя колонка +2
    [ 0, -1, 0],   // носовое крыло −1
    [ 0,  1, 0],   // носовое крыло +1
  ],
};

// Состав флота каждого игрока
const FLEET_COMPOSITION = [
  { type: 'large',  count: 1 },
  { type: 'medium', count: 2 },
  { type: 'small',  count: 3 },
];

// ─── Вспомогательные функции ───────────────────────────────────────────────────

function cellKey(cell) {
  return `${cell.x},${cell.y},${cell.z}`;
}

function inBounds(cell) {
  return cell.x >= 1 && cell.x <= 10 &&
         cell.y >= 1 && cell.y <= 10 &&
         cell.z >= 1 && cell.z <= 10;
}

// Применить форму самолёта к позиции носа с применением матрицы вращения
function applyShape(nose, type, rotMat) {
  const m = rotMat || [[1,0,0],[0,1,0],[0,0,1]];
  return PLANE_SHAPES[type].map(([dx, dy, dz]) => ({
    x: nose.x + Math.round(m[0][0]*dx + m[0][1]*dy + m[0][2]*dz),
    y: nose.y + Math.round(m[1][0]*dx + m[1][1]*dy + m[1][2]*dz),
    z: nose.z + Math.round(m[2][0]*dx + m[2][1]*dy + m[2][2]*dz),
  }));
}

// Все соседние ячейки (по граням И диагоналям — весь куб 3×3×3 вокруг)
// Возвращает Set строк-ключей, не включая сами ячейки самолёта
function getExclusionZone(cells) {
  const occupied = new Set(cells.map(cellKey));
  const zone = new Set();
  for (const cell of cells) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const n = { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz };
          if (inBounds(n) && !occupied.has(cellKey(n))) {
            zone.add(cellKey(n));
          }
        }
      }
    }
  }
  return zone;
}

// Паттерн удара: центральная ячейка + 6 соседей по граням
function getShotPattern(center) {
  const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  const cells = [center];
  for (const [dx, dy, dz] of dirs) {
    const n = { x: center.x + dx, y: center.y + dy, z: center.z + dz };
    if (inBounds(n)) cells.push(n);
  }
  return cells;
}

// ─── Валидация расстановки ────────────────────────────────────────────────────

function validatePlacement(planesData) {
  // Проверка состава флота
  const expected = { large: 1, medium: 2, small: 3 };
  const actual   = { large: 0, medium: 0, small: 0 };

  for (const p of planesData) {
    if (!(p.type in actual)) {
      return { valid: false, error: `Неизвестный тип самолёта: ${p.type}` };
    }
    actual[p.type]++;
  }

  for (const type of Object.keys(expected)) {
    if (actual[type] !== expected[type]) {
      return {
        valid: false,
        error: `Неверное количество самолётов типа «${type}»: ожидается ${expected[type]}, получено ${actual[type]}`
      };
    }
  }

  const occupiedKeys = new Set();
  const exclusionKeys = new Set();
  const placedPlanes = [];

  for (const planeData of planesData) {
    const cells = applyShape(planeData.nose, planeData.type, planeData.rot);

    // Проверка границ
    for (const cell of cells) {
      if (!inBounds(cell)) {
        return { valid: false, error: 'Самолёт выходит за границы поля' };
      }
    }

    // Проверка пересечений и близости
    for (const cell of cells) {
      const key = cellKey(cell);
      if (occupiedKeys.has(key)) {
        return { valid: false, error: 'Самолёты перекрываются' };
      }
      if (exclusionKeys.has(key)) {
        return { valid: false, error: 'Самолёты расположены слишком близко друг к другу' };
      }
    }

    // Зафиксировать ячейки и зону отчуждения
    const zone = getExclusionZone(cells);
    for (const cell of cells)  occupiedKeys.add(cellKey(cell));
    for (const key of zone)    exclusionKeys.add(key);

    placedPlanes.push({
      type:   planeData.type,
      nose:   planeData.nose,
      cells:  cells,
      hits:   [],      // ячейки, в которые уже попали
      killed: false,
    });
  }

  return { valid: true, planes: placedPlanes };
}

// ─── Обработка выстрела ───────────────────────────────────────────────────────

function processShot(center, targetPlanes, existingShots) {
  const alreadyShotKeys = new Set(existingShots.map(cellKey));
  const pattern = getShotPattern(center);

  const newShotCells = [];
  const hitCells     = [];
  const newlyKilled  = [];

  for (const cell of pattern) {
    const key = cellKey(cell);
    if (alreadyShotKeys.has(key)) continue; // уже стреляли
    newShotCells.push(cell);
    alreadyShotKeys.add(key);

    // Проверяем попадание в каждый живой самолёт
    for (const plane of targetPlanes) {
      if (plane.killed) continue;
      for (const planeCell of plane.cells) {
        if (cellKey(planeCell) === key && !plane.hits.some(h => cellKey(h) === key)) {
          plane.hits.push(cell);
          hitCells.push(cell);
          break;
        }
      }
    }
  }

  // Проверка уничтожения самолётов
  let killedAdjacentCells = [];
  for (const plane of targetPlanes) {
    if (!plane.killed && plane.hits.length === plane.cells.length) {
      plane.killed = true;
      newlyKilled.push(plane);

      // Зона отчуждения вокруг уничтоженного самолёта
      const zone = getExclusionZone(plane.cells);
      for (const key of zone) {
        if (!alreadyShotKeys.has(key)) {
          const [x, y, z] = key.split(',').map(Number);
          killedAdjacentCells.push({ x, y, z });
          alreadyShotKeys.add(key);
        }
      }
    }
  }

  return {
    newShotCells,
    hitCells,
    newlyKilled,
    killedAdjacentCells,
    isHit: hitCells.length > 0,
  };
}

// ─── HTTP-сервер (раздача статики из папки public/) ───────────────────────────

const httpServer = http.createServer((req, res) => {
  const safePath = req.url.split('?')[0].replace(/\.\./g, '');
  const filePath = path.join(__dirname, 'public', safePath === '/' ? 'index.html' : safePath);

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(data);
  });
});

// ─── Состояние игры ───────────────────────────────────────────────────────────

function createGameState() {
  return {
    phase: 'waiting',   // waiting | placement | battle | finished
    currentTurn: 0,     // индекс игрока, чей ход
    players: [null, null],
  };
}

let game = createGameState();

function resetGame() {
  console.log('Игра сброшена, ожидаем игроков...');
  game = createGameState();
}

function createPlayerState(ws, index) {
  return {
    ws,
    index,
    planes:        [],   // расставленные самолёты
    shots:         [],   // все ячейки, которые получили удар на этом поле
    placementDone: false,
  };
}

// ─── Отправка сообщений ───────────────────────────────────────────────────────

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function sendTo(playerIndex, data) {
  const p = game.players[playerIndex];
  if (p) send(p.ws, data);
}

function broadcast(data) {
  for (const p of game.players) {
    if (p) send(p.ws, data);
  }
}

function opponent(playerIndex) {
  return game.players[1 - playerIndex];
}

// ─── WebSocket-сервер ─────────────────────────────────────────────────────────

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws) => {
  // Определяем слот
  let idx = -1;
  if (!game.players[0]) {
    idx = 0;
  } else if (!game.players[1]) {
    idx = 1;
  } else {
    send(ws, { type: 'error', message: 'Игра уже началась, все места заняты' });
    ws.close();
    return;
  }

  game.players[idx] = createPlayerState(ws, idx);
  console.log(`Игрок ${idx + 1} подключился`);

  // Сообщаем игроку его индекс
  send(ws, { type: 'assigned', playerIndex: idx });

  if (game.players[0] && game.players[1]) {
    console.log('Оба игрока подключены → фаза расстановки');
    game.phase = 'placement';
    broadcast({ type: 'placement_start' });
  } else {
    send(ws, { type: 'waiting_for_opponent' });
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(idx, msg);
  });

  ws.on('close', () => {
    console.log(`Игрок ${idx + 1} отключился`);
    const opp = opponent(idx);
    game.players[idx] = null;
    if (opp && game.phase !== 'finished') {
      send(opp.ws, { type: 'opponent_disconnected' });
    }
    if (game.phase !== 'finished') resetGame();
  });
});

// ─── Обработка сообщений от клиентов ─────────────────────────────────────────

function handleMessage(playerIndex, msg) {
  const player = game.players[playerIndex];
  const opp    = opponent(playerIndex);
  if (!player) return;

  switch (msg.type) {

    // ── Расстановка самолётов ──────────────────────────────────────────────
    case 'place_planes': {
      if (game.phase !== 'placement') return;
      if (player.placementDone) return;

      const result = validatePlacement(msg.planes);

      if (!result.valid) {
        send(player.ws, { type: 'placement_error', message: result.error });
        return;
      }

      player.planes = result.planes;
      player.placementDone = true;
      send(player.ws, { type: 'placement_ok' });
      console.log(`Игрок ${playerIndex + 1} расставил самолёты`);

      if (opp && opp.placementDone) {
        // Оба готовы → начинаем бой
        game.phase = 'battle';
        game.currentTurn = 0;
        broadcast({ type: 'battle_start', firstTurn: 0 });
        sendTo(0, { type: 'your_turn' });
        sendTo(1, { type: 'opponent_turn' });
        console.log('Бой начат! Ходит Игрок 1');
      } else {
        send(player.ws, { type: 'waiting_for_opponent' });
      }
      break;
    }

    // ── Выстрел ───────────────────────────────────────────────────────────
    case 'shot': {
      if (game.phase !== 'battle') return;

      if (game.currentTurn !== playerIndex) {
        send(player.ws, { type: 'error', message: 'Сейчас не ваш ход' });
        return;
      }

      const { x, y, z } = msg;
      if (!inBounds({ x, y, z })) {
        send(player.ws, { type: 'error', message: 'Координаты вне поля (1–10 по каждой оси)' });
        return;
      }
      if (!opp) return;

      const result = processShot({ x, y, z }, opp.planes, opp.shots);

      // Сохраняем все новые выстрелы и зоны отчуждения в поле противника
      for (const cell of result.newShotCells)       opp.shots.push(cell);
      for (const cell of result.killedAdjacentCells) opp.shots.push({ ...cell, isAdjacent: true });

      const killedInfo = result.newlyKilled.map(p => ({
        type:  p.type,
        cells: p.cells,
      }));

      const shotPayload = {
        center:          { x, y, z },
        pattern:         result.newShotCells,
        hits:            result.hitCells,
        killed:          killedInfo,
        killedAdjacent:  result.killedAdjacentCells,
      };

      // Стрелявшему — результат его выстрела (рисуем на кубе противника)
      send(player.ws, { type: 'shot_result', ...shotPayload });

      // Противнику — куда прилетело (рисуем на его собственном кубе)
      send(opp.ws, { type: 'incoming_shot', ...shotPayload });

      // Проверка победы
      const allKilled = opp.planes.every(p => p.killed);
      if (allKilled) {
        game.phase = 'finished';
        send(player.ws, { type: 'game_over', result: 'win' });
        send(opp.ws,    { type: 'game_over', result: 'lose' });
        console.log(`Игра окончена. Победил Игрок ${playerIndex + 1}`);
        return;
      }

      // Попал → ещё ход; промах → смена хода
      if (result.isHit) {
        send(player.ws, { type: 'your_turn', bonusTurn: true });
        send(opp.ws,    { type: 'opponent_turn' });
        console.log(`Игрок ${playerIndex + 1} попал → снова его ход`);
      } else {
        game.currentTurn = 1 - playerIndex;
        send(player.ws, { type: 'opponent_turn' });
        send(opp.ws,    { type: 'your_turn' });
        console.log(`Игрок ${playerIndex + 1} промахнулся → ход Игрока ${game.currentTurn + 1}`);
      }
      break;
    }

    default:
      break;
  }
}

// ─── Запуск ───────────────────────────────────────────────────────────────────

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

httpServer.listen(PORT, () => {
  const ip = getLocalIP();
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       ВОЗДУШНЫЙ БОЙ — СЕРВЕР ЗАПУЩЕН    ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Игрок 1: http://localhost:${PORT}           ║`);
  console.log(`║  Игрок 2: http://${ip}:${PORT}     ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});
