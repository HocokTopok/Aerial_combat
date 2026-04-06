'use strict';
/**
 * game.js — главный контроллер игры
 * Зависимости: planes.js, cube.js
 */

(function () {

  // ─── Состояние ────────────────────────────────────────────────────────────

  let ws          = null;
  let playerIdx   = -1;          // 0 или 1
  let phase       = 'loading';   // loading | placement | battle | finished

  // Расстановка
  const placedPlanes  = {};      // planeId → { type, nose, cells, rot }
  const planeRotations = {};     // planeId → матрица вращения 3×3
  let placementCube  = null;

  // Бой
  let myCube    = null;
  let enemyCube = null;
  let myTurn    = false;
  let notifTimer = null;

  // ─── DOM-утилиты ──────────────────────────────────────────────────────────

  const $    = id  => document.getElementById(id);
  const qAll = sel => Array.from(document.querySelectorAll(sel));
  const q    = sel => document.querySelector(sel);

  // ─── Старт ────────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    populatePlacementDropdowns();
    addArrowButtons();
    addRotationButtons();
    setupPlacementHandlers();
    setupBattleHandlers();
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

      // ── Подключение ─────────────────────────────────────────────────────
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

      // ── Расстановка ─────────────────────────────────────────────────────
      case 'placement_start':
        phase = 'placement';
        startPlacement();
        break;

      case 'placement_ok':
        // Сервер принял расстановку, ждём соперника
        $('btn-ready').disabled    = true;
        $('btn-ready').textContent = 'ОЖИДАЕМ СОПЕРНИКА...';
        $('placement-waiting').classList.remove('hidden');
        $('placement-waiting').textContent = 'Расстановка принята. Ожидаем соперника...';
        break;

      case 'placement_error':
        // Сервер отклонил (на случай расхождения валидации)
        showPlacementError(msg.message || 'Ошибка расстановки');
        $('btn-ready').disabled    = false;
        $('btn-ready').textContent = 'ГОТОВ';
        $('placement-waiting').classList.add('hidden');
        break;

      // ── Бой ─────────────────────────────────────────────────────────────
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
        // Результат моего выстрела → рисуем на кубе противника
        if (enemyCube) {
          enemyCube.clearShotTarget();
          enemyCube.markShot(
            msg.pattern, msg.hits, msg.killed, msg.killedAdjacent
          );
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
        // Выстрел противника → рисуем на моём кубе
        if (myCube) {
          myCube.markIncoming(
            msg.pattern, msg.hits, msg.killed, msg.killedAdjacent
          );
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

      // ── Финал ───────────────────────────────────────────────────────────
      case 'game_over':
        phase = 'finished';
        setTimeout(() => showEndScreen(msg.result === 'win'), 600);
        break;

      case 'error':
        console.warn('[server error]', msg.message);
        break;
    }
  }

  // ─── РАССТАНОВКА ─────────────────────────────────────────────────────────

  // ─── ВРАЩЕНИЕ САМОЛЁТОВ ───────────────────────────────────────────────────

  /** Текущая матрица вращения самолёта (Identity если ещё не вращали) */
  function getRotMat(planeId) {
    return planeRotations[planeId] || Planes.IDENTITY_MAT;
  }

  /** Добавить кнопки стрелок перемещения в каждый fleet-item */
  function addArrowButtons() {
    qAll('.fleet-item').forEach(item => {
      const id  = item.dataset.planeId;
      const div = document.createElement('div');
      div.className = 'fleet-item-arrows';
      div.innerHTML =
        `<span class="arrows-label">Движение:</span>` +
        ['x','y','z'].map(ax =>
          `<button class="btn-arrow" data-plane-id="${id}" data-axis="${ax}" data-dir="-1">${ax.toUpperCase()}−</button>` +
          `<button class="btn-arrow" data-plane-id="${id}" data-axis="${ax}" data-dir="1">${ax.toUpperCase()}+</button>`
        ).join('');
      // Вставляем перед блоком вращения (или перед actions если rot ещё нет)
      const ref = item.querySelector('.fleet-item-rot') || item.querySelector('.fleet-item-actions');
      item.insertBefore(div, ref);
    });
  }

  /** Переместить нос самолёта на 1 шаг по оси */
  function handleArrow(planeId, axis, dir) {
    const sel = q(`.sel-${axis}[data-plane-id="${planeId}"]`);
    if (!sel) return;

    const curr = sel.selectedIndex;
    // Если пусто и двигаем назад — ничего не делаем
    if (curr < 1 && dir < 0) return;
    const base = curr < 1 ? 0 : curr;
    const next = base + dir;
    if (next < 1 || next >= sel.options.length) return;

    sel.selectedIndex = next;

    // Если самолёт уже был размещён — сбросить его
    if (placedPlanes[planeId]) {
      if (placementCube) placementCube._clearTag('own-' + planeId);
      delete placedPlanes[planeId];
      resetFleetItemStatus(planeId);
      checkAllPlaced();
    }
    updatePreview(planeId);
  }

  /** Добавить кнопки вращения в каждый fleet-item (вызывается один раз) */
  function addRotationButtons() {
    qAll('.fleet-item').forEach(item => {
      const id = item.dataset.planeId;
      const div = document.createElement('div');
      div.className = 'fleet-item-rot';
      div.innerHTML =
        `<span class="rot-label">Поворот:</span>` +
        ['x','y','z'].map(ax =>
          `<button class="btn-rot" data-plane-id="${id}" data-axis="${ax}" data-dir="-1">${ax.toUpperCase()}↺</button>` +
          `<button class="btn-rot" data-plane-id="${id}" data-axis="${ax}" data-dir="1">${ax.toUpperCase()}↻</button>`
        ).join('');
      const actions = item.querySelector('.fleet-item-actions');
      item.insertBefore(div, actions);
    });
  }

  /** Применить поворот на 90° вокруг оси к самолёту */
  function handleRotation(planeId, axis, dir) {
    const KEY = {
      'x-1': Planes.ROT_X_NEG, 'x1': Planes.ROT_X_POS,
      'y-1': Planes.ROT_Y_NEG, 'y1': Planes.ROT_Y_POS,
      'z-1': Planes.ROT_Z_NEG, 'z1': Planes.ROT_Z_POS,
    };
    const step = KEY[axis + dir];
    if (!step) return;
    planeRotations[planeId] = Planes.mulMat3(step, getRotMat(planeId));

    // Если самолёт уже был размещён — сбросить (вращение делает расстановку невалидной)
    if (placedPlanes[planeId]) {
      if (placementCube) placementCube._clearTag('own-' + planeId);
      delete placedPlanes[planeId];
      resetFleetItemStatus(planeId);
      checkAllPlaced();
    }
    updatePreview(planeId);
  }

  /** Сбросить визуальный статус элемента флота */
  function resetFleetItemStatus(planeId) {
    const item   = q(`.fleet-item[data-plane-id="${planeId}"]`);
    const status = q(`.placement-status[data-plane-id="${planeId}"]`);
    if (item)   { item.classList.remove('placed', 'invalid'); }
    if (status) { status.textContent = '○'; status.className = 'placement-status'; }
  }

  /** Заполнить дропдауны на экране расстановки */
  function populatePlacementDropdowns() {
    qAll('.sel-x').forEach(sel => {
      sel.innerHTML = '<option value="">—</option>';
      for (let i = 1; i <= 10; i++) {
        sel.innerHTML += `<option value="${i}">${i}</option>`;
      }
    });

    qAll('.sel-y').forEach(sel => {
      sel.innerHTML = '<option value="">—</option>';
      Planes.Y_LETTERS.forEach(l => {
        sel.innerHTML += `<option value="${l}">${l}</option>`;
      });
    });

    qAll('.sel-z').forEach(sel => {
      sel.innerHTML = '<option value="">—</option>';
      Planes.COLORS.forEach((c, i) => {
        sel.innerHTML += `<option value="${i + 1}">${c.name}</option>`;
      });
    });
  }

  /** Инициализировать экран расстановки */
  function startPlacement() {
    // Сброс состояния расстановки (на случай повторной игры без обновления страницы)
    for (const key of Object.keys(placedPlanes))  delete placedPlanes[key];
    for (const key of Object.keys(planeRotations)) delete planeRotations[key];

    $('placement-player-label').textContent =
      playerIdx === 0 ? 'Игрок 1' : 'Игрок 2';
    showScreen('screen-placement');

    // Дать layout-у осесться, потом создать куб
    setTimeout(() => {
      const container = $('placement-cube');
      const section   = container.parentElement;
      const sz = Math.max(
        Math.min(section.clientWidth - 32, section.clientHeight - 60, 520),
        300
      );
      container.style.width  = sz + 'px';
      container.style.height = sz + 'px';

      if (placementCube) { placementCube.dispose(); placementCube = null; }
      placementCube = new CubeRenderer(container, { axes: true });
      placementCube.onZoomChange = pct => { const el = $('pz-pct'); if (el) el.textContent = pct + '%'; };
    }, 60);
  }

  /** Навесить обработчики на элементы расстановки */
  function setupPlacementHandlers() {
    // Изменение любого дропдауна → обновить превью
    document.addEventListener('change', e => {
      const sel = e.target;
      if (sel.classList.contains('coord-sel')) {
        updatePreview(sel.dataset.planeId);
      }
    });

    // Кнопки «Разместить», стрелки, вращение
    document.addEventListener('click', e => {
      const arr = e.target.closest('.btn-arrow');
      if (arr) { handleArrow(arr.dataset.planeId, arr.dataset.axis, parseInt(arr.dataset.dir)); return; }
      const rot = e.target.closest('.btn-rot');
      if (rot) { handleRotation(rot.dataset.planeId, rot.dataset.axis, rot.dataset.dir); return; }
      const btn = e.target.closest('.btn-place');
      if (btn) placePlane(btn.dataset.planeId);
    });

    // Кнопка «Готов»
    $('btn-ready').addEventListener('click', sendPlacement);

    // Zoom для куба расстановки
    bindZoom('pz-in', 'pz-out', 'pz-pct', () => placementCube);
  }

  /** Получить нос самолёта из дропдаунов (числа) или null */
  function getNose(planeId) {
    const xv = parseInt(q(`.sel-x[data-plane-id="${planeId}"]`)?.value);
    const yv = Planes.yLetterToNum(q(`.sel-y[data-plane-id="${planeId}"]`)?.value || '');
    const zv = parseInt(q(`.sel-z[data-plane-id="${planeId}"]`)?.value);
    if (!xv || !yv || !zv) return null;
    return { x: xv, y: yv, z: zv };
  }

  /** Тип самолёта из data-атрибута */
  function getType(planeId) {
    return q(`.fleet-item[data-plane-id="${planeId}"]`)?.dataset.type || null;
  }

  /** Обновить превью самолёта в кубе */
  function updatePreview(planeId) {
    if (!placementCube) return;

    const nose = getNose(planeId);
    if (!nose) {
      placementCube.clearPreview();
      resetHint();
      return;
    }

    const type        = getType(planeId);
    const otherPlaced = otherPlacedList(planeId);
    const result      = Planes.validateOne(otherPlaced, nose, type, getRotMat(planeId));

    placementCube.showPreview(result.cells, result.ok);

    const hint = $('placement-cube-hint');
    hint.style.color = result.ok ? '#22cc66' : '#ff3a3a';
    hint.innerHTML   = result.ok
      ? `<b>${Planes.coordLabel(nose.x, nose.y, nose.z)}</b> — нажмите Разместить`
      : result.error;
  }

  function resetHint() {
    const hint = $('placement-cube-hint');
    hint.style.color = '';
    hint.innerHTML = 'Введите координаты носа самолёта и нажмите <b>Разместить</b>';
  }

  /** Попытаться разместить самолёт planeId */
  function placePlane(planeId) {
    if (!placementCube) return;

    const nose = getNose(planeId);
    if (!nose) {
      showPlacementError('Выберите координаты носа самолёта (X, Y и Z).');
      return;
    }

    const type   = getType(planeId);
    const result = Planes.validateOne(otherPlacedList(planeId), nose, type, getRotMat(planeId));

    if (!result.ok) {
      placementCube.showPreview(result.cells, false);
      showPlacementError(result.error);
      markFleetItemInvalid(planeId);
      return;
    }

    hidePlacementError();

    // Удалить предыдущее размещение этого самолёта (если было)
    if (placedPlanes[planeId]) {
      placementCube._clearTag('own-' + planeId);
    }

    // Сохранить и отобразить
    placedPlanes[planeId] = { type, nose, cells: result.cells, rot: getRotMat(planeId) };
    placementCube.clearPreview();
    placementCube.showOwnPlane(result.cells, 'own-' + planeId);

    markFleetItemPlaced(planeId);
    checkAllPlaced();
  }

  /** Список уже размещённых самолётов, кроме planeId */
  function otherPlacedList(excludeId) {
    return Object.entries(placedPlanes)
      .filter(([id]) => id !== excludeId)
      .map(([, p]) => p);
  }

  function markFleetItemPlaced(planeId) {
    const item   = q(`.fleet-item[data-plane-id="${planeId}"]`);
    const status = q(`.placement-status[data-plane-id="${planeId}"]`);
    if (item)   { item.classList.add('placed'); item.classList.remove('invalid'); }
    if (status) { status.textContent = '✓'; status.className = 'placement-status ok'; }
  }

  function markFleetItemInvalid(planeId) {
    const item   = q(`.fleet-item[data-plane-id="${planeId}"]`);
    const status = q(`.placement-status[data-plane-id="${planeId}"]`);
    if (item)   { item.classList.add('invalid'); item.classList.remove('placed'); }
    if (status) { status.textContent = '✗'; status.className = 'placement-status error'; }
  }

  function checkAllPlaced() {
    const all = ['large-0','medium-0','medium-1','small-0','small-1','small-2'];
    $('btn-ready').disabled = !all.every(id => placedPlanes[id]);
  }

  /** Отправить расстановку на сервер */
  function sendPlacement() {
    const all = ['large-0','medium-0','medium-1','small-0','small-1','small-2'];
    if (!all.every(id => placedPlanes[id])) return;

    const planesData = all.map(id => ({
      type: placedPlanes[id].type,
      nose: placedPlanes[id].nose,
      rot:  placedPlanes[id].rot,
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

  // ─── БОЙ ─────────────────────────────────────────────────────────────────

  /** Инициализировать экран боя */
  function startBattle(firstTurn) {
    showScreen('screen-battle');

    setTimeout(() => {
      const layout = q('.battle-layout');
      const avW    = Math.floor((layout.clientWidth  - 48) / 2);
      const avH    = layout.clientHeight - 16;
      const sz     = Math.max(Math.min(avW, avH, 460), 260);

      const myC    = $('my-cube');
      const enemyC = $('enemy-cube');
      [myC, enemyC].forEach(el => {
        el.style.width  = sz + 'px';
        el.style.height = sz + 'px';
      });

      if (myCube)    { myCube.dispose();    myCube    = null; }
      if (enemyCube) { enemyCube.dispose(); enemyCube = null; }

      myCube    = new CubeRenderer(myC);
      enemyCube = new CubeRenderer(enemyC);
      myCube.onZoomChange    = pct => { const el = $('mz-pct'); if (el) el.textContent = pct + '%'; };
      enemyCube.onZoomChange = pct => { const el = $('ez-pct'); if (el) el.textContent = pct + '%'; };

      // Нарисовать собственные самолёты на моём кубе
      const all = ['large-0','medium-0','medium-1','small-0','small-1','small-2'];
      for (const id of all) {
        const p = placedPlanes[id];
        if (p) myCube.showOwnPlane(p.cells, 'own-' + id);
      }

      // Ход устанавливается сервером через your_turn / opponent_turn,
      // которые приходят сразу после battle_start.
      // Если к этому моменту myTurn уже установлен — синхронизируем UI.
      setTurnUI(myTurn);
    }, 60);
  }

  /** Обработчики панели выстрела */
  function setupBattleHandlers() {
    // Zoom для боевых кубов
    bindZoom('mz-in', 'mz-out', 'mz-pct', () => myCube);
    bindZoom('ez-in', 'ez-out', 'ez-pct', () => enemyCube);
    ['shot-x', 'shot-y', 'shot-z'].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener('change', updateShotPreview);
    });
    $('btn-fire').addEventListener('click', fireShot);
  }

  /** Обновить подсветку паттерна выстрела в кубе противника */
  function updateShotPreview() {
    if (!enemyCube || !myTurn) return;

    const xv = parseInt($('shot-x').value);
    const yv = Planes.yLetterToNum($('shot-y').value || '');
    const zv = parseInt($('shot-z').value);

    if (!xv || !yv || !zv) {
      enemyCube.clearShotTarget();
      $('shot-preview-label').textContent = '';
      $('btn-fire').disabled = true;
      return;
    }

    const pattern = Planes.getShotPattern({ x: xv, y: yv, z: zv });
    enemyCube.setShotTarget(pattern);

    $('shot-preview-label').textContent =
      `Удар: ${Planes.coordLabel(xv, yv, zv)} + до 6 соседей`;
    $('btn-fire').disabled = false;
  }

  /** Произвести выстрел */
  function fireShot() {
    if (!myTurn) return;

    const xv = parseInt($('shot-x').value);
    const yv = Planes.yLetterToNum($('shot-y').value || '');
    const zv = parseInt($('shot-z').value);
    if (!xv || !yv || !zv) return;

    myTurn = false;
    $('btn-fire').disabled = true;
    $('shot-preview-label').textContent = 'Выстрел произведён...';

    send({ type: 'shot', x: xv, y: yv, z: zv });
  }

  /** Обновить UI в зависимости от того, чей ход */
  function setTurnUI(isMyTurn, bonus = false) {
    const badge   = $('battle-status');
    const overlay = $('opponent-turn-overlay');
    const fireBtn = $('btn-fire');
    const sels    = ['shot-x','shot-y','shot-z'];

    if (isMyTurn) {
      badge.textContent = bonus ? 'ВАШ ХОД  ✦  бонусный' : 'ВАШ ХОД';
      badge.className   = 'top-bar-badge status-badge your-turn';
      overlay.classList.add('hidden');
      sels.forEach(id => $(id).disabled = false);
      updateShotPreview();   // покажем прицел по текущим значениям дропдаунов
    } else {
      badge.textContent = 'ХОД ПРОТИВНИКА';
      badge.className   = 'top-bar-badge status-badge opponent-turn';
      overlay.classList.remove('hidden');
      fireBtn.disabled  = true;
      sels.forEach(id => $(id).disabled = true);
      if (enemyCube) enemyCube.clearShotTarget();
      $('shot-preview-label').textContent = '';
    }
  }

  // ─── ФИНАЛ ───────────────────────────────────────────────────────────────

  function showEndScreen(win) {
    const sc = $('screen-end');
    sc.classList.remove('win', 'lose');
    sc.classList.add(win ? 'win' : 'lose');

    $('end-icon').textContent    = win ? '✈' : '💥';
    $('end-result').textContent  = win ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ';
    $('end-subtitle').textContent = win
      ? 'Весь флот противника уничтожен!'
      : 'Ваш флот полностью уничтожен.';

    showScreen('screen-end');
  }

  // ─── УВЕДОМЛЕНИЯ ─────────────────────────────────────────────────────────

  /**
   * Показать всплывающее уведомление.
   * @param {string} text
   * @param {'hit'|'miss'|'kill'} type
   * @param {number} duration   мс
   */
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
