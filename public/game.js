'use strict';
/**
 * game.js — главный контроллер игры
 * Зависимости: planes.js, cube.js
 */

(function () {

  // ─── Состояние ────────────────────────────────────────────────────────────

  let ws        = null;
  let playerIdx = -1;
  let phase     = 'loading';   // loading | placement | battle | finished

  // Расстановка
  const planeNoses     = {};   // planeId → {x,y,z}
  const planeRotations = {};   // planeId → матрица 3×3
  let activePlaneId    = null;
  let placementCube    = null;

  // Бой
  let myCube    = null;
  let enemyCube = null;
  let myTurn    = false;
  let shotNose  = { x: 5, y: 5, z: 5 };
  let notifTimer = null;

  // ─── DOM-утилиты ──────────────────────────────────────────────────────────

  const $    = id  => document.getElementById(id);
  const qAll = sel => Array.from(document.querySelectorAll(sel));
  const q    = sel => document.querySelector(sel);

  // ─── Старт ────────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    setupPlacementHandlers();
    setupBattleHandlers();
    setupKeyboard();
    connectWS();
  });

  // ─── Zoom-утилита ─────────────────────────────────────────────────────────

  function bindZoom(inId, outId, pctId, getCube) {
    const upd = () => {
      const c = getCube(); if (!c) return;
      const el = $(pctId); if (el) el.textContent = c.getZoomPct() + '%';
    };
    $(inId) ?.addEventListener('click', () => { getCube()?.zoomIn();    upd(); });
    $(outId)?.addEventListener('click', () => { getCube()?.zoomOut();   upd(); });
    $(pctId)?.addEventListener('click', () => { getCube()?.zoomReset(); upd(); });
  }

  // ─── Переключение экранов ─────────────────────────────────────────────────

  function showScreen(id) {
    qAll('.screen').forEach(s => s.classList.remove('active'));
    const el = $(id);
    if (el) el.classList.add('active');
  }

  // ─── WebSocket ────────────────────────────────────────────────────────────

  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      ws = new WebSocket(`${proto}//${location.host}`);
    } catch (e) {
      $('loading-text').textContent = 'Ошибка: невозможно создать WebSocket соединение.';
      return;
    }

    ws.onopen = () => {
      $('loading-text').textContent = 'Подключено. Ожидание соперника...';
    };

    ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleMessage(msg);
    };

    ws.onclose = () => {
      if (phase !== 'finished') {
        showScreen('screen-loading');
        $('loading-text').textContent = 'Соединение потеряно. Обновите страницу.';
      }
    };

    ws.onerror = () => {
      $('loading-text').textContent =
        'Ошибка подключения. Убедитесь, что сервер запущен (node server.js).';
    };
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  // ─── Обработка сообщений сервера ──────────────────────────────────────────

  function handleMessage(msg) {
    switch (msg.type) {

      case 'assigned':
        playerIdx = msg.playerIndex;
        $('loading-text').textContent =
          `Вы — Игрок ${playerIdx + 1}. Ожидание соперника...`;
        break;

      case 'waiting_for_opponent':
        if (phase === 'loading') {
          $('loading-text').textContent = 'Ожидание соперника...';
        } else if (phase === 'placement') {
          $('placement-waiting').classList.remove('hidden');
        }
        break;

      case 'opponent_disconnected':
        showScreen('screen-loading');
        $('loading-text').textContent = 'Соперник отключился. Обновите страницу.';
        break;

      case 'placement_start':
        phase = 'placement';
        startPlacement();
        break;

      case 'placement_ok':
        $('btn-ready').disabled    = true;
        $('btn-ready').textContent = 'ОЖИДАЕМ СОПЕРНИКА...';
        $('placement-waiting').classList.remove('hidden');
        $('placement-waiting').textContent = 'Расстановка принята. Ожидаем соперника...';
        break;

      case 'placement_error':
        showPlacementError(msg.message || 'Ошибка расстановки');
        $('btn-ready').disabled    = false;
        $('btn-ready').textContent = 'ГОТОВ';
        $('placement-waiting').classList.add('hidden');
        break;

      case 'battle_start':
        phase = 'battle';
        startBattle(msg.firstTurn);
        break;

      case 'your_turn':
        myTurn = true;
        setTurnUI(true, !!msg.bonusTurn);
        break;

      case 'opponent_turn':
        myTurn = false;
        setTurnUI(false);
        break;

      case 'shot_result':
        if (enemyCube) {
          enemyCube.clearShotTarget();
          enemyCube.markShot(msg.pattern, msg.hits, msg.killed, msg.killedAdjacent);
        }
        if (msg.killed.length > 0) {
          showNotification(
            `УНИЧТОЖЕН ${planeTypeName(msg.killed[0].type).toUpperCase()}!`,
            'kill', 2800
          );
        } else if (msg.hits.length > 0) {
          showNotification('ПОПАДАНИЕ!', 'hit', 2000);
        } else {
          showNotification('Промах...', 'miss', 1600);
        }
        break;

      case 'incoming_shot':
        if (myCube) {
          myCube.markIncoming(msg.pattern, msg.hits, msg.killed, msg.killedAdjacent);
        }
        if (msg.killed.length > 0) {
          showNotification(
            `Противник уничтожил ${planeTypeName(msg.killed[0].type)}!`,
            'kill', 2800
          );
        } else if (msg.hits.length > 0) {
          showNotification('Противник попал по вашему самолёту!', 'hit', 2000);
        }
        break;

      case 'game_over':
        phase = 'finished';
        setTimeout(() => showEndScreen(msg.result === 'win'), 600);
        break;

      case 'error':
        console.warn('[server error]', msg.message);
        break;
    }
  }

  // ─── КЛАВИАТУРА ──────────────────────────────────────────────────────────

  // W/S → X±, D/A → Y±, Space/Shift → Z±
  const MOVE_KEYS = {
    KeyW:       { axis: 'x', dir:  1 },
    KeyS:       { axis: 'x', dir: -1 },
    KeyD:       { axis: 'y', dir:  1 },
    KeyA:       { axis: 'y', dir: -1 },
    Space:      { axis: 'z', dir:  1 },
    ShiftLeft:  { axis: 'z', dir: -1 },
    ShiftRight: { axis: 'z', dir: -1 },
  };

  // Q → Rx, E → Ry, R → Rz
  const ROT_KEYS = {
    KeyQ: Planes.ROT_X_POS,
    KeyE: Planes.ROT_Y_POS,
    KeyR: Planes.ROT_Z_POS,
  };

  function setupKeyboard() {
    document.addEventListener('keydown', e => {
      // Не перехватываем клавиши когда фокус на кнопке/элементе ввода
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;

      if (phase === 'placement') handlePlacementKey(e);
      else if (phase === 'battle') handleBattleKey(e);
    });
  }

  function handlePlacementKey(e) {
    if (!activePlaneId || !placementCube) return;

    const move = MOVE_KEYS[e.code];
    const rot  = ROT_KEYS[e.code];
    if (!move && !rot) return;

    e.preventDefault();

    if (move) {
      const nose = planeNoses[activePlaneId] || { x: 5, y: 5, z: 5 };
      planeNoses[activePlaneId] = {
        ...nose,
        [move.axis]: Math.max(1, Math.min(10, nose[move.axis] + move.dir)),
      };
    }

    if (rot) {
      planeRotations[activePlaneId] = Planes.mulMat3(rot, getRotMat(activePlaneId));
    }

    updateActivePlaneDisplay();
  }

  function handleBattleKey(e) {
    if (!myTurn || !enemyCube) return;
    const move = MOVE_KEYS[e.code];
    if (!move) return;
    e.preventDefault();
    shotNose = {
      ...shotNose,
      [move.axis]: Math.max(1, Math.min(10, shotNose[move.axis] + move.dir)),
    };
    updateShotPreview();
  }

  // ─── РАССТАНОВКА ─────────────────────────────────────────────────────────

  function getRotMat(planeId) {
    return planeRotations[planeId] || Planes.IDENTITY_MAT;
  }

  function getType(planeId) {
    return q(`.fleet-item[data-plane-id="${planeId}"]`)?.dataset.type || null;
  }

  /** Список данных уже размещённых самолётов, кроме excludeId */
  function otherPlacedList(excludeId) {
    const all = ['large-0','medium-0','medium-1','small-0','small-1','small-2'];
    return all
      .filter(id => id !== excludeId && planeNoses[id])
      .map(id => {
        const type  = getType(id);
        const rot   = getRotMat(id);
        const cells = Planes.getCells(planeNoses[id], type, rot);
        return { type, nose: planeNoses[id], cells, rot };
      });
  }

  /** Выбрать самолёт как активный */
  function selectPlane(planeId) {
    if (activePlaneId && activePlaneId !== planeId) {
      // Убрать превью/стрелки предыдущего, показать синим если валиден
      if (placementCube) {
        placementCube.clearPreview();
        placementCube.clearAxisArrows();
      }
      showPlaneAsOwn(activePlaneId);
      updateFleetItemStatus(activePlaneId);
    }

    activePlaneId = planeId;

    // Инициализировать позицию если ещё нет
    if (!planeNoses[planeId]) {
      planeNoses[planeId] = { x: 5, y: 5, z: 5 };
    }

    // Убрать синий меш этого самолёта (заменим на превью)
    if (placementCube) placementCube._clearTag('own-' + planeId);

    // Подсветить активный в списке
    qAll('.fleet-item').forEach(el => el.classList.remove('active'));
    const item = q(`.fleet-item[data-plane-id="${planeId}"]`);
    if (item) item.classList.add('active');

    updateActivePlaneDisplay();
  }

  /** Показать самолёт синим (собственный), если его позиция валидна */
  function showPlaneAsOwn(planeId) {
    if (!placementCube || !planeNoses[planeId]) return;
    const type   = getType(planeId);
    const rot    = getRotMat(planeId);
    const result = Planes.validateOne(otherPlacedList(planeId), planeNoses[planeId], type, rot);
    if (result.ok) {
      placementCube.showOwnPlane(result.cells, 'own-' + planeId);
    } else {
      placementCube._clearTag('own-' + planeId);
    }
  }

  /** Обновить превью и стрелки активного самолёта */
  function updateActivePlaneDisplay() {
    if (!activePlaneId || !placementCube) return;

    const type   = getType(activePlaneId);
    const nose   = planeNoses[activePlaneId];
    const rot    = getRotMat(activePlaneId);
    const result = Planes.validateOne(otherPlacedList(activePlaneId), nose, type, rot);

    placementCube.showPreview(result.cells, result.ok);
    placementCube.showAxisArrows(result.cells);

    updateFleetItemStatus(activePlaneId);
    updateAllFleetStatuses();
    checkAllPlaced();
  }

  /** Обновить цвет фона элемента в списке флота */
  function updateFleetItemStatus(planeId) {
    const item = q(`.fleet-item[data-plane-id="${planeId}"]`);
    if (!item) return;

    if (!planeNoses[planeId]) {
      item.classList.remove('placed', 'invalid');
      return;
    }

    const type   = getType(planeId);
    const rot    = getRotMat(planeId);
    const result = Planes.validateOne(otherPlacedList(planeId), planeNoses[planeId], type, rot);
    item.classList.toggle('placed',  result.ok);
    item.classList.toggle('invalid', !result.ok);
  }

  /** Обновить статусы всех самолётов кроме активного */
  function updateAllFleetStatuses() {
    const all = ['large-0','medium-0','medium-1','small-0','small-1','small-2'];
    for (const id of all) {
      if (id !== activePlaneId) updateFleetItemStatus(id);
    }
  }

  /** Проверить, все ли самолёты расставлены корректно, и обновить кнопку ГОТОВ */
  function checkAllPlaced() {
    const all = ['large-0','medium-0','medium-1','small-0','small-1','small-2'];

    if (!all.every(id => planeNoses[id])) {
      $('btn-ready').disabled = true;
      return;
    }

    // Последовательная валидация как на сервере
    const placed = [];
    let allOk = true;
    for (const id of all) {
      const type   = getType(id);
      const rot    = getRotMat(id);
      const result = Planes.validateOne(placed, planeNoses[id], type, rot);
      if (!result.ok) { allOk = false; break; }
      placed.push({ type, nose: planeNoses[id], cells: result.cells, rot });
    }

    $('btn-ready').disabled = !allOk;
  }

  /** Инициализировать экран расстановки */
  function startPlacement() {
    for (const key of Object.keys(planeNoses))    delete planeNoses[key];
    for (const key of Object.keys(planeRotations)) delete planeRotations[key];
    activePlaneId = null;

    $('placement-player-label').textContent =
      playerIdx === 0 ? 'Игрок 1' : 'Игрок 2';
    showScreen('screen-placement');

    setTimeout(() => {
      const container = $('placement-cube');
      if (placementCube) { placementCube.dispose(); placementCube = null; }
      placementCube = new CubeRenderer(container, { axes: true });
      placementCube.onZoomChange = pct => {
        const el = $('pz-pct'); if (el) el.textContent = pct + '%';
      };

      // Автоматически выбрать первый самолёт
      selectPlane('large-0');
    }, 60);
  }

  /** Навесить обработчики расстановки */
  function setupPlacementHandlers() {
    // Клик по элементу флота → выбрать самолёт
    const fleetList = $('fleet-list');
    if (fleetList) {
      fleetList.addEventListener('click', e => {
        const item = e.target.closest('.fleet-item');
        if (item?.dataset.planeId) selectPlane(item.dataset.planeId);
      });
    }

    $('btn-ready')?.addEventListener('click', sendPlacement);
    $('btn-randomize')?.addEventListener('click', randomizePlacement);

    bindZoom('pz-in', 'pz-out', 'pz-pct', () => placementCube);
  }

  /** Отправить расстановку на сервер */
  function sendPlacement() {
    const all = ['large-0','medium-0','medium-1','small-0','small-1','small-2'];
    if (!all.every(id => planeNoses[id])) return;

    // Зафиксировать активный самолёт
    if (activePlaneId && placementCube) {
      placementCube.clearPreview();
      placementCube.clearAxisArrows();
      showPlaneAsOwn(activePlaneId);
      qAll('.fleet-item').forEach(el => el.classList.remove('active'));
      activePlaneId = null;
    }

    const planesData = all.map(id => ({
      type: getType(id),
      nose: planeNoses[id],
      rot:  getRotMat(id),
    }));

    send({ type: 'place_planes', planes: planesData });
    $('btn-ready').disabled    = true;
    $('btn-ready').textContent = 'ОТПРАВЛЕНО...';
  }

  function showPlacementError(msg) {
    const el = $('placement-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function hidePlacementError() {
    $('placement-error').classList.add('hidden');
  }

  // ─── РАНДОМНАЯ РАССТАНОВКА ────────────────────────────────────────────────

  const ALL_ROTS = [
    Planes.IDENTITY_MAT,
    Planes.ROT_X_POS, Planes.ROT_X_NEG,
    Planes.ROT_Y_POS, Planes.ROT_Y_NEG,
    Planes.ROT_Z_POS, Planes.ROT_Z_NEG,
  ];

  function randomizePlacement(depth) {
    depth = (depth || 0);
    if (depth > 15) return; // защита от бесконечной рекурсии

    const ORDER = ['large-0','medium-0','medium-1','small-0','small-1','small-2'];

    // Очистить текущее состояние
    for (const key of Object.keys(planeNoses))    delete planeNoses[key];
    for (const key of Object.keys(planeRotations)) delete planeRotations[key];

    if (placementCube) {
      placementCube.clearAll();
      // clearAll сбрасывает историю выстрелов — для куба расстановки это нормально
    }

    const placed = [];

    for (const id of ORDER) {
      const type = getType(id);
      let success = false;

      for (let attempt = 0; attempt < 300 && !success; attempt++) {
        const nose = {
          x: Math.floor(Math.random() * 10) + 1,
          y: Math.floor(Math.random() * 10) + 1,
          z: Math.floor(Math.random() * 10) + 1,
        };
        const rot    = ALL_ROTS[Math.floor(Math.random() * ALL_ROTS.length)];
        const result = Planes.validateOne(placed, nose, type, rot);

        if (result.ok) {
          planeNoses[id]     = nose;
          planeRotations[id] = rot;
          placed.push({ type, nose, cells: result.cells, rot });
          success = true;
        }
      }

      if (!success) {
        // Попробовать заново с нуля
        randomizePlacement(depth + 1);
        return;
      }
    }

    // Отрисовать все самолёты синим
    if (placementCube) {
      activePlaneId = null;
      qAll('.fleet-item').forEach(el => el.classList.remove('active'));
      for (const id of ORDER) {
        if (!planeNoses[id]) continue;
        const type  = getType(id);
        const cells = Planes.getCells(planeNoses[id], type, getRotMat(id));
        placementCube.showOwnPlane(cells, 'own-' + id);
      }
    }

    updateAllFleetStatuses();
    checkAllPlaced();
    hidePlacementError();
  }

  // ─── БОЙ ─────────────────────────────────────────────────────────────────

  function startBattle(firstTurn) {
    showScreen('screen-battle');
    shotNose = { x: 5, y: 5, z: 5 };

    setTimeout(() => {
      const myC    = $('my-cube');
      const enemyC = $('enemy-cube');

      if (myCube)    { myCube.dispose();    myCube    = null; }
      if (enemyCube) { enemyCube.dispose(); enemyCube = null; }

      myCube    = new CubeRenderer(myC,    { axes: true });
      enemyCube = new CubeRenderer(enemyC, { axes: true });
      myCube.onZoomChange    = pct => { const el = $('mz-pct'); if (el) el.textContent = pct + '%'; };
      enemyCube.onZoomChange = pct => { const el = $('ez-pct'); if (el) el.textContent = pct + '%'; };

      // Нарисовать собственные самолёты
      const all = ['large-0','medium-0','medium-1','small-0','small-1','small-2'];
      for (const id of all) {
        if (!planeNoses[id]) continue;
        const type  = getType(id);
        const cells = Planes.getCells(planeNoses[id], type, getRotMat(id));
        myCube.showOwnPlane(cells, 'own-' + id);
      }

      setTurnUI(myTurn);
    }, 60);
  }

  function setupBattleHandlers() {
    bindZoom('mz-in', 'mz-out', 'mz-pct', () => myCube);
    bindZoom('ez-in', 'ez-out', 'ez-pct', () => enemyCube);

    $('btn-fire')?.addEventListener('click', fireShot);

    // Переключение режима просмотра куба противника
    let viewMode = 1;
    const viewBtn = $('btn-view-mode');
    if (viewBtn) {
      viewBtn.addEventListener('click', () => {
        viewMode = viewMode === 1 ? 2 : 1;
        if (enemyCube) enemyCube.setViewMode(viewMode);
        viewBtn.textContent = viewMode === 1 ? 'Режим: выстрелы' : 'Режим: цели';
        viewBtn.classList.toggle('active', viewMode === 2);
      });
    }
  }

  /** Обновить подсветку прицела в кубе противника */
  function updateShotPreview() {
    if (!enemyCube || !myTurn) return;

    const { x, y, z } = shotNose;
    const pattern = Planes.getShotPattern({ x, y, z });
    enemyCube.setShotTarget(pattern);

    const yLetter   = Planes.yNumToLetter(y);
    const colorName = Planes.COLORS[z - 1].name;
    const el = $('shot-coords-text');
    if (el) el.textContent = `${x} / ${yLetter} / ${colorName}`;
    $('btn-fire').disabled = false;
  }

  /** Произвести выстрел */
  function fireShot() {
    if (!myTurn) return;
    myTurn = false;
    $('btn-fire').disabled = true;
    const el = $('shot-preview-label');
    if (el) el.textContent = 'Выстрел произведён...';
    send({ type: 'shot', x: shotNose.x, y: shotNose.y, z: shotNose.z });
  }

  /** Обновить UI в зависимости от хода */
  function setTurnUI(isMyTurn, bonus = false) {
    const badge   = $('battle-status');
    const overlay = $('opponent-turn-overlay');
    const fireBtn = $('btn-fire');

    if (isMyTurn) {
      badge.textContent = bonus ? 'ВАШ ХОД  ✦  бонусный' : 'ВАШ ХОД';
      badge.className   = 'top-bar-badge status-badge your-turn';
      overlay.classList.add('hidden');
      fireBtn.disabled  = false;
      updateShotPreview();
    } else {
      badge.textContent = 'ХОД ПРОТИВНИКА';
      badge.className   = 'top-bar-badge status-badge opponent-turn';
      overlay.classList.remove('hidden');
      fireBtn.disabled  = true;
      if (enemyCube) enemyCube.clearShotTarget();
      const ct = $('shot-coords-text');
      if (ct) ct.textContent = '—';
      const pl = $('shot-preview-label');
      if (pl) pl.textContent = '';
    }
  }

  // ─── ФИНАЛ ───────────────────────────────────────────────────────────────

  function showEndScreen(win) {
    const sc = $('screen-end');
    sc.classList.remove('win', 'lose');
    sc.classList.add(win ? 'win' : 'lose');
    $('end-icon').textContent     = win ? '✈' : '💥';
    $('end-result').textContent   = win ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ';
    $('end-subtitle').textContent = win
      ? 'Весь флот противника уничтожен!'
      : 'Ваш флот полностью уничтожен.';
    showScreen('screen-end');
  }

  // ─── УВЕДОМЛЕНИЯ ─────────────────────────────────────────────────────────

  function showNotification(text, type, duration) {
    const el = $('hit-notification');
    el.textContent = text;
    el.className   = `hit-notification ${type}`;
    el.classList.remove('hidden');
    if (notifTimer) clearTimeout(notifTimer);
    notifTimer = setTimeout(() => el.classList.add('hidden'), duration);
  }

  // ─── УТИЛИТЫ ─────────────────────────────────────────────────────────────

  function planeTypeName(type) {
    return { large: 'бомбардировщик', medium: 'перехватчик', small: 'истребитель' }[type]
      || 'самолёт';
  }

})();
