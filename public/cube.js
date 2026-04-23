'use strict';
/**
 * cube.js — Three.js визуализация 3D куба 10×10×10
 * Зависимости: Three.js (r134), planes.js (window.Planes)
 * Экспортирует: window.CubeRenderer
 *
 * Система координат:
 *   game (X=1..10, Y=1..10, Z=1..10) → Three.js (x=0..10, y=0..10, z=0..10)
 *   threeX = gameX - 0.5  (центр ячейки)
 *   threeY = gameZ - 0.5  (высота = цветовой слой)
 *   threeZ = gameY - 0.5  (глубина = буква)
 */

window.CubeRenderer = class CubeRenderer {

  // ─── Конструктор ──────────────────────────────────────────────────────────

  constructor(container, options) {
    this._container   = container;
    this._cells       = new Map();   // key → [{mesh, tag}]
    this._previews    = [];
    this._targets     = [];
    this._arrows      = [];          // ArrowHelper для осей активного самолёта
    this._time        = 0;
    this._raf         = null;
    this._viewMode    = 1;           // 1=обычный, 2=режим целей
    this._shotHistory = [];          // история выстрелов для перерисовки

    // Начальный угол камеры
    this._theta  = Math.PI * 0.22;   // горизонталь
    this._phi    = Math.PI * 0.30;   // вертикаль (0=сверху, π/2=сбоку)
    this._radius = 22;
    this._center = new THREE.Vector3(5, 5, 5);

    /** Вызывается при изменении масштаба: fn(pct: number) */
    this.onZoomChange = null;

    // Опции
    const opts       = options || {};
    this._showAxes   = !!opts.axes;
    this._labelsGroup = null;
    this._axesGroup   = null;

    this._init();
    this._animate();
  }

  // ─── Инициализация ────────────────────────────────────────────────────────

  _init() {
    const W = this._container.clientWidth  || 480;
    const H = this._container.clientHeight || 480;

    // WebGL-рендерер
    this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setSize(W, H);
    this._renderer.setClearColor(0x000000, 0);
    this._container.appendChild(this._renderer.domElement);

    // Сцена и камера
    this._scene  = new THREE.Scene();
    this._camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 300);
    this._positionCamera();

    // Элементы сцены
    this._buildGrid();
    this._buildLabels();
    if (this._showAxes) this._buildAxes();
    this._setupOrbit();

    // Слежение за изменением размера контейнера
    this._ro = new ResizeObserver(() => this._onResize());
    this._ro.observe(this._container);
  }

  _positionCamera() {
    const s = Math.sin(this._phi);
    const c = Math.cos(this._phi);
    this._camera.position.set(
      this._center.x + this._radius * s * Math.sin(this._theta),
      this._center.y + this._radius * c,
      this._center.z + this._radius * s * Math.cos(this._theta)
    );
    this._camera.lookAt(this._center);
  }

  _onResize() {
    const W = this._container.clientWidth;
    const H = this._container.clientHeight;
    if (!W || !H) return;
    this._camera.aspect = W / H;
    this._camera.updateProjectionMatrix();
    this._renderer.setSize(W, H);
  }

  // ─── Рендер-цикл ──────────────────────────────────────────────────────────

  _animate() {
    this._raf = requestAnimationFrame(() => this._animate());
    this._time += 0.016;

    // Пульсация прицельных ячеек
    const pulse = 0.4 + 0.55 * (0.5 + 0.5 * Math.sin(this._time * 4.5));
    for (const m of this._targets) {
      if (m.material) m.material.opacity = pulse;
    }

    this._renderer.render(this._scene, this._camera);
  }

  // ─── Сетка куба ──────────────────────────────────────────────────────────

  _buildGrid() {
    const pos  = [];
    const col  = [];

    // Внешние рёбра ярче, внутренние тусклее
    const bright = [0.20, 0.20, 0.48];
    const dim    = [0.09, 0.09, 0.22];

    const isEdge = (a, b) => (a === 0 || a === 10) && (b === 0 || b === 10);

    // Линии вдоль threeX (gameX): для каждой пары (threeZ=gameY, threeY=gameZ)
    for (let gy = 0; gy <= 10; gy++) {
      for (let gz = 0; gz <= 10; gz++) {
        const c = isEdge(gy, gz) ? bright : dim;
        pos.push(0, gz, gy,  10, gz, gy);
        col.push(...c, ...c);
      }
    }
    // Линии вдоль threeZ (gameY): для каждой пары (threeX=gameX, threeY=gameZ)
    for (let gx = 0; gx <= 10; gx++) {
      for (let gz = 0; gz <= 10; gz++) {
        const c = isEdge(gx, gz) ? bright : dim;
        pos.push(gx, gz, 0,  gx, gz, 10);
        col.push(...c, ...c);
      }
    }
    // Линии вдоль threeY (gameZ): для каждой пары (threeX=gameX, threeZ=gameY)
    for (let gx = 0; gx <= 10; gx++) {
      for (let gy = 0; gy <= 10; gy++) {
        const c = isEdge(gx, gy) ? bright : dim;
        pos.push(gx, 0, gy,  gx, 10, gy);
        col.push(...c, ...c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
    this._scene.add(new THREE.LineSegments(geo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 })
    ));
  }

  // ─── Метки осей ──────────────────────────────────────────────────────────
  // Спрайты всегда смотрят на камеру (THREE.Sprite).
  // Названия X/Y/Z рендерятся здесь же, чтобы они были на всех кубах.

  _buildLabels() {
    const g = new THREE.Group();

    // ── X: числа 1–10 вдоль нижнего переднего ребра куба ─────────────────
    for (let gx = 1; gx <= 10; gx++) {
      const sp = this._makeTextSprite(String(gx), '#ffffff', null, 46);
      sp.position.set(gx - 0.5, -0.65, -0.75);
      sp.scale.set(1.4, 0.70, 1);
      g.add(sp);
    }
    // Название оси X
    const xLbl = this._makeTextSprite('X', '#88bbff', null, 58);
    xLbl.position.set(11.2, -0.65, -0.75);
    xLbl.scale.set(1.3, 0.85, 1);
    g.add(xLbl);

    // ── Y: буквы A–J вдоль левого переднего ребра куба ───────────────────
    for (let gy = 1; gy <= 10; gy++) {
      const sp = this._makeTextSprite(Planes.Y_LETTERS[gy - 1], '#ffffff', null, 46);
      sp.position.set(-0.75, -0.65, gy - 0.5);
      sp.scale.set(1.4, 0.70, 1);
      g.add(sp);
    }
    // Название оси Y
    const yLbl = this._makeTextSprite('Y', '#88bbff', null, 58);
    yLbl.position.set(-0.75, -0.65, 11.2);
    yLbl.scale.set(1.3, 0.85, 1);
    g.add(yLbl);

    // ── Z: только цветные квадратики вдоль левого вертикального ребра ────
    for (let gz = 1; gz <= 10; gz++) {
      const col = Planes.COLORS[gz - 1];
      const sp  = this._makeColorDotSprite(col.hex);
      sp.position.set(-1.3, gz - 0.5, -0.5);
      sp.scale.set(0.72, 0.72, 1);
      g.add(sp);
    }
    // Название оси Z
    const zLbl = this._makeTextSprite('Z', '#88bbff', null, 58);
    zLbl.position.set(-1.3, 11.2, -0.5);
    zLbl.scale.set(1.3, 0.85, 1);
    g.add(zLbl);

    this._scene.add(g);
    this._labelsGroup = g;
  }

  /** Создаёт Sprite с цветным квадратиком (без текста). */
  _makeColorDotSprite(hexColor) {
    const SZ  = 64;
    const cv  = document.createElement('canvas');
    cv.width  = SZ;
    cv.height = SZ;
    const ctx = cv.getContext('2d');
    const pad = 6;
    ctx.fillStyle = hexColor;
    ctx.fillRect(pad, pad, SZ - pad * 2, SZ - pad * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.40)';
    ctx.lineWidth   = 2;
    ctx.strokeRect(pad, pad, SZ - pad * 2, SZ - pad * 2);
    const tex = new THREE.CanvasTexture(cv);
    tex.needsUpdate = true;
    return new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
    );
  }

  /** Создаёт Sprite с текстом (и необязательным цветным квадратиком).
   *  @param {string}  text
   *  @param {string}  textColor  — CSS-цвет текста
   *  @param {string|null} dotHex — цвет квадратика слева (null = нет)
   *  @param {number}  fontSize   — размер шрифта в px на канвасе (default 28)
   */
  _makeTextSprite(text, textColor, dotHex, fontSize = 28) {
    const CH = Math.round(fontSize * 2.1);
    const CW = 256;
    const cv  = document.createElement('canvas');
    cv.width  = CW;
    cv.height = CH;
    const ctx = cv.getContext('2d');

    let txtX = CW / 2;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    if (dotHex) {
      const sqSz = Math.round(fontSize * 1.1);
      const sqY  = (CH - sqSz) / 2;
      const sqX  = 8;
      ctx.fillStyle = dotHex;
      ctx.fillRect(sqX, sqY, sqSz, sqSz);
      ctx.strokeStyle = 'rgba(255,255,255,0.30)';
      ctx.lineWidth = 1;
      ctx.strokeRect(sqX, sqY, sqSz, sqSz);
      txtX = sqX + sqSz + 8;
      ctx.textAlign = 'left';
    }

    ctx.font      = `bold ${fontSize}px "Courier New", monospace`;
    ctx.fillStyle = textColor;
    ctx.fillText(text, txtX, CH / 2);

    const tex = new THREE.CanvasTexture(cv);
    tex.needsUpdate = true;
    return new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
    );
  }

  // ─── 3D Оси координат (только для куба расстановки) ─────────────────────

  _buildAxes() {
    if (this._axesGroup) {
      this._axesGroup.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) { if (obj.material.map) obj.material.map.dispose(); obj.material.dispose(); }
      });
      this._scene.remove(this._axesGroup);
    }

    const SHAFT_END  = 11.4;   // конец стержня
    const ARROW_TIP  = 12.2;   // вершина конуса
    const CONE_H     = 0.85;
    const CONE_R     = 0.22;
    const LABEL_DIST = 13.2;   // расстояние подписи X/Y/Z от начала
    const WHITE      = 0xffffff;
    const upVec      = new THREE.Vector3(0, 1, 0);

    // threeX = gameX, threeZ = gameY (буквы), threeY = gameZ (высота/цвета)
    const axes = [
      { dir: new THREE.Vector3(1, 0, 0), label: 'X' },
      { dir: new THREE.Vector3(0, 0, 1), label: 'Y' },
      { dir: new THREE.Vector3(0, 1, 0), label: 'Z' },
    ];

    const g = new THREE.Group();

    for (const ax of axes) {
      const mat = new THREE.LineBasicMaterial({ color: WHITE, transparent: true, opacity: 0.90 });

      // Стержень: от (0,0,0) до конца стержня
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        ax.dir.clone().multiplyScalar(SHAFT_END),
      ]);
      g.add(new THREE.Line(lineGeo, mat));

      // Конус-наконечник
      const coneGeo = new THREE.ConeGeometry(CONE_R, CONE_H, 10);
      const cone    = new THREE.Mesh(coneGeo,
        new THREE.MeshBasicMaterial({ color: WHITE, transparent: true, opacity: 0.95 })
      );
      // Центр конуса посередине между основанием и вершиной
      cone.position.copy(ax.dir.clone().multiplyScalar(ARROW_TIP - CONE_H * 0.5));
      if (!ax.dir.equals(upVec)) {
        cone.quaternion.setFromUnitVectors(upVec, ax.dir);
      }
      g.add(cone);

      // Подписи X/Y/Z добавляются в _buildLabels(), здесь не нужны
    }

    this._scene.add(g);
    this._axesGroup = g;
  }

  // ─── Мышь: вращение камеры ────────────────────────────────────────────────

  _setupOrbit() {
    const el = this._renderer.domElement;
    let drag = false, lx = 0, ly = 0;

    const start = (x, y) => { drag = true; lx = x; ly = y; };
    const move  = (x, y) => {
      if (!drag) return;
      this._theta -= (x - lx) * 0.010;
      // Нажатие вверх → передняя сторона куба поднимается (φ уменьшается)
      this._phi = Math.max(0.08, Math.min(Math.PI * 0.47, this._phi - (y - ly) * 0.010));
      lx = x; ly = y;
      this._positionCamera();
    };
    const end = () => { drag = false; };

    el.addEventListener('mousedown',  e => start(e.clientX, e.clientY));
    window.addEventListener('mousemove',  e => move(e.clientX, e.clientY));
    window.addEventListener('mouseup',    end);
    el.addEventListener('touchstart', e => { if (e.touches.length===1) start(e.touches[0].clientX, e.touches[0].clientY); }, { passive:true });
    window.addEventListener('touchmove',  e => { if (drag && e.touches.length===1) move(e.touches[0].clientX, e.touches[0].clientY); }, { passive:true });
    window.addEventListener('touchend',   end);

    // Приближение/отдаление колесом мыши
    el.addEventListener('wheel', e => {
      e.preventDefault();
      this._radius = Math.max(8, Math.min(44, this._radius * (e.deltaY > 0 ? 1.10 : 0.91)));
      this._positionCamera();
      if (this.onZoomChange) this.onZoomChange(this.getZoomPct());
    }, { passive: false });
  }

  // ─── Масштаб (публичный API) ──────────────────────────────────────────────

  zoomIn()     { this._radius = Math.max(8,  this._radius * 0.85); this._positionCamera(); if (this.onZoomChange) this.onZoomChange(this.getZoomPct()); }
  zoomOut()    { this._radius = Math.min(44, this._radius * 1.18); this._positionCamera(); if (this.onZoomChange) this.onZoomChange(this.getZoomPct()); }
  zoomReset()  { this._radius = 22; this._positionCamera(); if (this.onZoomChange) this.onZoomChange(this.getZoomPct()); }
  /** Возвращает текущий масштаб в % относительно исходного радиуса (22) */
  getZoomPct() { return Math.round(22 / this._radius * 100); }

  // ─── Вспомогательные ─────────────────────────────────────────────────────

  /** Центр ячейки в пространстве Three.js */
  _t(gx, gy, gz) {
    return new THREE.Vector3(gx - 0.5, gz - 0.5, gy - 0.5);
  }

  /** Общая геометрия ячейки (переиспользуется) */
  static get _BOX() {
    if (!this.__BOX) this.__BOX = new THREE.BoxGeometry(0.88, 0.88, 0.88);
    return this.__BOX;
  }
  static get _EDGES() {
    if (!this.__EDGES) this.__EDGES = new THREE.EdgesGeometry(CubeRenderer._BOX);
    return this.__EDGES;
  }

  _solid(hexColor, opacity, depthWrite = false) {
    return new THREE.Mesh(CubeRenderer._BOX,
      new THREE.MeshBasicMaterial({ color: hexColor, transparent: true, opacity, depthWrite })
    );
  }
  _wire(hexColor, opacity = 0.75) {
    return new THREE.LineSegments(CubeRenderer._EDGES,
      new THREE.LineBasicMaterial({ color: hexColor, transparent: true, opacity })
    );
  }

  /** Добавить меш в ячейку */
  _addCell(gx, gy, gz, mesh, tag) {
    const key = `${gx},${gy},${gz}`;
    if (!this._cells.has(key)) this._cells.set(key, []);
    this._cells.get(key).push({ mesh, tag });
    mesh.position.copy(this._t(gx, gy, gz));
    this._scene.add(mesh);
  }

  /** Рекурсивно освободить материалы меша и его дочерних объектов */
  static _disposeMesh(mesh) {
    mesh.traverse(obj => { if (obj.material) obj.material.dispose(); });
  }

  /** Удалить все меши с данным тегом */
  _clearTag(tag) {
    for (const [key, arr] of this._cells) {
      const keep = [], remove = [];
      for (const e of arr) (e.tag === tag ? remove : keep).push(e);
      for (const e of remove) { this._scene.remove(e.mesh); CubeRenderer._disposeMesh(e.mesh); }
      if (keep.length) this._cells.set(key, keep);
      else             this._cells.delete(key);
    }
  }

  /** Удалить все меши */
  _clearAllCells() {
    for (const [, arr] of this._cells)
      for (const e of arr) { this._scene.remove(e.mesh); CubeRenderer._disposeMesh(e.mesh); }
    this._cells.clear();
  }

  // ─── Публичный API ────────────────────────────────────────────────────────

  /**
   * Показать собственный самолёт (синий полупрозрачный).
   * @param {Array<{x,y,z}>} cells
   * @param {string}         tag  — например 'own-large', 'own-medium-0'
   */
  showOwnPlane(cells, tag) {
    this._clearTag(tag);
    for (const c of cells) {
      const m = this._solid(0x3d7fff, 0.32);
      m.add(this._wire(0x6699ff, 0.65));
      this._addCell(c.x, c.y, c.z, m, tag);
    }
  }

  /**
   * Показать превью расстановки (зелёный = ок, красный = ошибка).
   * @param {Array<{x,y,z}>} cells
   * @param {boolean}        valid
   */
  showPreview(cells, valid) {
    this.clearPreview();
    const fill  = valid ? 0x22cc66 : 0xff3a3a;
    const wire  = valid ? 0x44ff88 : 0xff6666;
    const alpha = valid ? 0.42     : 0.38;
    for (const c of cells) {
      const m = this._solid(fill, alpha);
      m.add(this._wire(wire, 0.85));
      m.position.copy(this._t(c.x, c.y, c.z));
      this._scene.add(m);
      this._previews.push(m);
    }
  }

  /** Убрать превью */
  clearPreview() {
    for (const m of this._previews) { this._scene.remove(m); CubeRenderer._disposeMesh(m); }
    this._previews = [];
  }

  /**
   * Подсветить паттерн предстоящего выстрела (7 ячеек, пульсация).
   * @param {Array<{x,y,z}>} cells
   */
  setShotTarget(cells) {
    this.clearShotTarget();
    for (const c of cells) {
      const m = this._solid(0xffffff, 0.7);
      m.add(this._wire(0xffffff, 0.95));
      m.position.copy(this._t(c.x, c.y, c.z));
      this._scene.add(m);
      this._targets.push(m);
    }
  }

  /**
   * Показать цветные стрелки осей из центра самолёта (или прицела).
   * @param {Array<{x,y,z}>} cells — ячейки самолёта
   * @param {boolean}        small — уменьшенные стрелки (для прицела)
   */
  showAxisArrows(cells, small = false) {
    this.clearAxisArrows();

    // Центр в игровых координатах
    const cx = cells.reduce((s, c) => s + c.x, 0) / cells.length;
    const cy = cells.reduce((s, c) => s + c.y, 0) / cells.length;
    const cz = cells.reduce((s, c) => s + c.z, 0) / cells.length;
    // Перевод в Three.js: threeX=gameX-0.5, threeY=gameZ-0.5, threeZ=gameY-0.5
    const origin = new THREE.Vector3(cx - 0.5, cz - 0.5, cy - 0.5);

    const len     = small ? 1.2 : 2.5;
    const headLen = small ? 0.25 : 0.55;
    const headW   = small ? 0.12 : 0.24;

    // X (red) — вдоль threeX
    const ax = new THREE.ArrowHelper(new THREE.Vector3(1,0,0), origin, len, 0xff3333, headLen, headW);
    // Y (green) — вдоль threeZ (=gameY)
    const ay = new THREE.ArrowHelper(new THREE.Vector3(0,0,1), origin, len, 0x33cc55, headLen, headW);
    // Z (blue) — вдоль threeY (=gameZ)
    const az = new THREE.ArrowHelper(new THREE.Vector3(0,1,0), origin, len, 0x4488ff, headLen, headW);

    this._arrows = [ax, ay, az];
    for (const a of this._arrows) this._scene.add(a);
  }

  /** Убрать стрелки осей */
  clearAxisArrows() {
    for (const a of this._arrows) {
      this._scene.remove(a);
      a.line.geometry.dispose();
      a.line.material.dispose();
      a.cone.geometry.dispose();
      a.cone.material.dispose();
    }
    this._arrows = [];
  }

  /** Убрать прицел */
  clearShotTarget() {
    for (const m of this._targets) { this._scene.remove(m); CubeRenderer._disposeMesh(m); }
    this._targets = [];
  }

  /**
   * Отметить результат моего выстрела — рисуется на кубе ПРОТИВНИКА.
   * Сохраняет историю для поддержки переключения режимов просмотра.
   */
  markShot(pattern, hits, killedPlanes, adjacent) {
    this._shotHistory.push({ pattern, hits, killedPlanes, adjacent });
    this._renderEnemyShots();
  }

  /** Переключить режим просмотра куба противника и перерисовать выстрелы. */
  setViewMode(mode) {
    this._viewMode = mode;
    this._renderEnemyShots();
  }

  /** Перерисовать все выстрелы по текущему _viewMode. */
  _renderEnemyShots() {
    this._clearTag('shot');
    this._clearTag('shot-adj');
    this._clearTag('mode2-bg');

    if (this._viewMode === 2) {
      // Собрать все уже поражённые/закрытые клетки
      const usedKeys = new Set();
      for (const h of this._shotHistory) {
        for (const c of h.pattern) usedKeys.add(`${c.x},${c.y},${c.z}`);
        for (const c of h.adjacent) usedKeys.add(`${c.x},${c.y},${c.z}`);
      }

      // Яркие клетки = ещё не стреляли
      for (let x = 1; x <= 10; x++) {
        for (let y = 1; y <= 10; y++) {
          for (let z = 1; z <= 10; z++) {
            if (!usedKeys.has(`${x},${y},${z}`)) {
              const m = this._solid(0x44aaff, 0.22);
              m.add(this._wire(0x88ccff, 0.50));
              this._addCell(x, y, z, m, 'mode2-bg');
            }
          }
        }
      }

      // Тёмные клетки = уже использованные
      for (const h of this._shotHistory) {
        for (const c of h.pattern) {
          const m = this._solid(0x1a2840, 0.30);
          m.add(this._wire(0x253444, 0.20));
          this._addCell(c.x, c.y, c.z, m, 'shot');
        }
        for (const c of h.adjacent) {
          const m = this._solid(0x141e2a, 0.22);
          this._addCell(c.x, c.y, c.z, m, 'shot-adj');
        }
      }
    } else {
      // Режим 1: обычный
      for (const h of this._shotHistory) {
        const hitKeys  = new Set(h.hits.map(c => `${c.x},${c.y},${c.z}`));
        const killKeys = new Set();
        for (const p of h.killedPlanes) for (const c of p.cells) killKeys.add(`${c.x},${c.y},${c.z}`);

        for (const c of h.pattern) {
          const k = `${c.x},${c.y},${c.z}`;
          let m;
          if (killKeys.has(k) || hitKeys.has(k)) {
            m = this._solid(0xff8800, 0.90, true);
            m.add(this._wire(0xffaa44, 1.0));
          } else {
            m = this._solid(0x2a3d55, 0.30);
            m.add(this._wire(0x3a4d66, 0.40));
          }
          this._addCell(c.x, c.y, c.z, m, 'shot');
        }

        for (const c of h.adjacent) {
          const m = this._solid(0x2a3d55, 0.22);
          m.add(this._wire(0x3a4d66, 0.28));
          this._addCell(c.x, c.y, c.z, m, 'shot-adj');
        }
      }
    }
  }

  /**
   * Отметить входящий удар — рисуется на МОЁМ кубе.
   * Вызывается когда соперник стреляет.
   */
  markIncoming(pattern, hits, killedPlanes, adjacent) {
    const hitKeys  = new Set(hits.map(c => Planes.cellKey(c)));
    const killKeys = new Set();
    for (const p of killedPlanes) for (const c of p.cells) killKeys.add(Planes.cellKey(c));

    for (const c of pattern) {
      const k = Planes.cellKey(c);
      let m;
      if (killKeys.has(k) || hitKeys.has(k)) {
        m = this._solid(0xff8800, 0.82, true);
        m.add(this._wire(0xffaa44, 0.95));
      } else {
        m = this._solid(0x1a2233, 0.25);
        m.add(this._wire(0x253344, 0.30));
      }
      this._addCell(c.x, c.y, c.z, m, 'incoming');
    }

    // Зона вокруг уничтоженного — цвет как у промаха
    for (const c of adjacent) {
      const m = this._solid(0x1a2233, 0.22);
      m.add(this._wire(0x253344, 0.25));
      this._addCell(c.x, c.y, c.z, m, 'incoming-adj');
    }
  }

  /**
   * Сброс всех ячеек (при старте новой фазы и т.п.)
   */
  clearAll() {
    this._clearAllCells();
    this.clearPreview();
    this.clearShotTarget();
    this.clearAxisArrows();
    this._shotHistory = [];
    this._viewMode    = 1;
  }

  /**
   * Освободить ресурсы Three.js (при уничтожении компонента).
   */
  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._ro.disconnect();
    this.clearAll();
    // Освободить метки
    if (this._labelsGroup) {
      this._labelsGroup.traverse(obj => {
        if (obj.material) { if (obj.material.map) obj.material.map.dispose(); obj.material.dispose(); }
      });
      this._scene.remove(this._labelsGroup);
    }
    // Освободить оси
    if (this._axesGroup) {
      this._axesGroup.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) { if (obj.material.map) obj.material.map.dispose(); obj.material.dispose(); }
      });
      this._scene.remove(this._axesGroup);
    }
    this._renderer.dispose();
    this._renderer.domElement.remove();
  }
};
