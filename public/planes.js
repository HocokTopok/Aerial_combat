/**
 * planes.js — клиентская логика самолётов
 * Глобальный объект window.Planes используется cube.js и game.js
 */

window.Planes = (function () {

  // ─── Константы ────────────────────────────────────────────────────────────

  const COLORS = [
    { name: 'Красный',    hex: '#ff3333', z: 1  },
    { name: 'Оранжевый',  hex: '#ff8833', z: 2  },
    { name: 'Жёлтый',     hex: '#ffee22', z: 3  },
    { name: 'Зелёный',    hex: '#33cc44', z: 4  },
    { name: 'Бирюзовый',  hex: '#22cccc', z: 5  },
    { name: 'Голубой',    hex: '#44aaff', z: 6  },
    { name: 'Синий',      hex: '#2244ff', z: 7  },
    { name: 'Фиолетовый', hex: '#9933ff', z: 8  },
    { name: 'Белый',      hex: '#ffffff', z: 9  },
    { name: 'Серый',      hex: '#888888', z: 10 },
  ];

  const Y_LETTERS = ['A','B','C','D','E','F','G','H','I','J'];

  // ─── Матрицы вращения ─────────────────────────────────────────────────────
  // 90° вращения вокруг каждой оси (правило правой руки)
  // Применяются к смещениям [dx, dy, dz] от носа самолёта

  const IDENTITY_MAT = [[1,0,0],[0,1,0],[0,0,1]];

  // Rx +90°: (x,y,z) → (x, -z, y)
  const ROT_X_POS = [[1,0,0],[0,0,-1],[0,1,0]];
  // Rx -90°: (x,y,z) → (x, z, -y)
  const ROT_X_NEG = [[1,0,0],[0,0,1],[0,-1,0]];

  // Ry +90°: (x,y,z) → (z, y, -x)
  const ROT_Y_POS = [[0,0,1],[0,1,0],[-1,0,0]];
  // Ry -90°: (x,y,z) → (-z, y, x)
  const ROT_Y_NEG = [[0,0,-1],[0,1,0],[1,0,0]];

  // Rz +90°: (x,y,z) → (-y, x, z)
  const ROT_Z_POS = [[0,-1,0],[1,0,0],[0,0,1]];
  // Rz -90°: (x,y,z) → (y, -x, z)
  const ROT_Z_NEG = [[0,1,0],[-1,0,0],[0,0,1]];

  /** Перемножить две матрицы 3×3 */
  function mulMat3(a, b) {
    const r = [[0,0,0],[0,0,0],[0,0,0]];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        for (let k = 0; k < 3; k++)
          r[i][j] += a[i][k] * b[k][j];
    return r;
  }

  /** Применить матрицу 3×3 к вектору [x,y,z], результат округляется */
  function applyMat3(m, x, y, z) {
    return [
      Math.round(m[0][0]*x + m[0][1]*y + m[0][2]*z),
      Math.round(m[1][0]*x + m[1][1]*y + m[1][2]*z),
      Math.round(m[2][0]*x + m[2][1]*y + m[2][2]*z),
    ];
  }

  // ─── Формы самолётов ──────────────────────────────────────────────────────
  // Смещения [dx, dy, dz] от носа в базовой ориентации (нос → +X).

  const SHAPES = {
    // ── Истребитель (2 ячейки) ────────────────────────────────
    //  [хвост][нос]→
    small: [
      [ 0,  0, 0],
      [-1,  0, 0],
    ],

    // ── Перехватчик (6 ячеек) ─────────────────────────────────
    //        [W]
    //  [T][-2][−1][N]→
    //        [W]
    medium: [
      [ 0,  0, 0],
      [-1,  0, 0],
      [-1, -1, 0],
      [-1,  1, 0],
      [-2,  0, 0],
      [-3,  0, 0],
    ],

    // ── Бомбардировщик (10 ячеек) ─────────────────────────────
    //   _ ▢ _ _
    //   _ ▢ _ ▢
    //   ▢ ▢ ▢ ▢ →нос
    //   _ ▢ _ ▢
    //   _ ▢ _ _
    // Средняя колонка (dx=−2) длиной 5, носовые крылья (dx=0) ±1
    large: [
      [ 0,  0, 0],  // нос
      [-1,  0, 0],  // позвоночник-1
      [-2,  0, 0],  // позвоночник-2 / центр средней колонки
      [-3,  0, 0],  // хвост
      [-2, -1, 0],  // средняя колонка −1
      [-2, -2, 0],  // средняя колонка −2
      [-2,  1, 0],  // средняя колонка +1
      [-2,  2, 0],  // средняя колонка +2
      [ 0, -1, 0],  // носовое крыло −1
      [ 0,  1, 0],  // носовое крыло +1
    ],
  };

  const FLEET = [
    { type: 'large',  count: 1 },
    { type: 'medium', count: 2 },
    { type: 'small',  count: 3 },
  ];

  // ─── Вспомогательные функции ──────────────────────────────────────────────

  function cellKey(cell) {
    return `${cell.x},${cell.y},${cell.z}`;
  }

  function inBounds(cell) {
    return cell.x >= 1 && cell.x <= 10 &&
           cell.y >= 1 && cell.y <= 10 &&
           cell.z >= 1 && cell.z <= 10;
  }

  /**
   * Получить ячейки самолёта с применением вращения.
   * @param {{x,y,z}} nose    — позиция носа
   * @param {string}  type    — 'small'|'medium'|'large'
   * @param {number[][]} rotMat — матрица вращения 3×3 (опц., по умолч. IDENTITY)
   */
  function getCells(nose, type, rotMat) {
    const mat = rotMat || IDENTITY_MAT;
    return SHAPES[type].map(([dx, dy, dz]) => {
      const [rdx, rdy, rdz] = applyMat3(mat, dx, dy, dz);
      return { x: nose.x + rdx, y: nose.y + rdy, z: nose.z + rdz };
    });
  }

  /**
   * Зона отчуждения (куб 3×3×3 вокруг каждой ячейки, кроме самих ячеек).
   */
  function getExclusionZone(cells) {
    const occupied = new Set(cells.map(cellKey));
    const zone = new Map();
    for (const c of cells) {
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            if (!dx && !dy && !dz) continue;
            const n = { x: c.x+dx, y: c.y+dy, z: c.z+dz };
            const k = cellKey(n);
            if (inBounds(n) && !occupied.has(k) && !zone.has(k)) zone.set(k, n);
          }
    }
    return Array.from(zone.values());
  }

  /**
   * Паттерн удара: центр + до 6 соседей по граням.
   */
  function getShotPattern(center) {
    const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    const cells = [center];
    for (const [dx, dy, dz] of dirs) {
      const n = { x: center.x+dx, y: center.y+dy, z: center.z+dz };
      if (inBounds(n)) cells.push(n);
    }
    return cells;
  }

  // ─── Валидация расстановки ────────────────────────────────────────────────

  /**
   * Проверить позицию одного самолёта относительно уже размещённых.
   * @param {Array<{cells}>} placed — уже размещённые самолёты
   * @param {{x,y,z}}        nose
   * @param {string}         type
   * @param {number[][]}     rotMat
   */
  function validateOne(placed, nose, type, rotMat) {
    const cells = getCells(nose, type, rotMat);

    for (const c of cells) {
      if (!inBounds(c)) return { ok: false, cells, error: 'Самолёт выходит за границы поля' };
    }

    const occupiedKeys  = new Set();
    const exclusionKeys = new Set();
    for (const p of placed) {
      for (const c of p.cells) occupiedKeys.add(cellKey(c));
      for (const c of getExclusionZone(p.cells)) exclusionKeys.add(cellKey(c));
    }

    for (const c of cells) {
      const k = cellKey(c);
      if (occupiedKeys.has(k))  return { ok: false, cells, error: 'Ячейка занята другим самолётом' };
      if (exclusionKeys.has(k)) return { ok: false, cells, error: 'Слишком близко к другому самолёту' };
    }

    return { ok: true, cells };
  }

  /**
   * Полная проверка всего флота.
   */
  function validateAll(planesData) {
    const expected = { large: 1, medium: 2, small: 3 };
    const actual   = { large: 0, medium: 0, small: 0 };
    for (const p of planesData) {
      if (!(p.type in actual)) return { valid: false, error: `Неизвестный тип: ${p.type}` };
      actual[p.type]++;
    }
    for (const t of Object.keys(expected)) {
      if (actual[t] !== expected[t])
        return { valid: false, error: `Неверное количество самолётов типа «${t}»` };
    }

    const occupiedKeys  = new Set();
    const exclusionKeys = new Set();
    for (const pd of planesData) {
      const cells = getCells(pd.nose, pd.type, pd.rot);
      for (const c of cells) {
        if (!inBounds(c)) return { valid: false, error: 'Самолёт выходит за границы поля' };
      }
      for (const c of cells) {
        const k = cellKey(c);
        if (occupiedKeys.has(k))  return { valid: false, error: 'Самолёты перекрываются' };
        if (exclusionKeys.has(k)) return { valid: false, error: 'Самолёты слишком близко' };
      }
      for (const c of cells)                   occupiedKeys.add(cellKey(c));
      for (const c of getExclusionZone(cells))  exclusionKeys.add(cellKey(c));
    }
    return { valid: true };
  }

  // ─── Конвертеры координат ─────────────────────────────────────────────────

  function yLetterToNum(letter) {
    const i = Y_LETTERS.indexOf((letter || '').toUpperCase());
    return i >= 0 ? i + 1 : null;
  }

  function yNumToLetter(num) {
    return Y_LETTERS[num - 1] || '?';
  }

  function colorByZ(z) {
    return COLORS[z - 1] || COLORS[0];
  }

  function coordLabel(x, y, z) {
    const yL = typeof y === 'number' ? yNumToLetter(y) : y;
    return `X${x} / Y${yL} / Z ${colorByZ(z).name}`;
  }

  // ─── Публичный API ────────────────────────────────────────────────────────

  return {
    COLORS, Y_LETTERS, FLEET, SHAPES,
    IDENTITY_MAT,
    ROT_X_POS, ROT_X_NEG,
    ROT_Y_POS, ROT_Y_NEG,
    ROT_Z_POS, ROT_Z_NEG,
    mulMat3, applyMat3,
    getCells, getExclusionZone, getShotPattern,
    validateOne, validateAll,
    cellKey, inBounds,
    yLetterToNum, yNumToLetter, colorByZ, coordLabel,
  };

})();
