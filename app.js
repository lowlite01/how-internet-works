'use strict';
/* =====================================================================
   app.js — логика интерактивного учебника «Как устроен интернет».
   Все тексты и данные лежат в data.js, здесь только поведение.

   Устройство:
   1. Помощники (создание элементов, подсветка кода, подсказки).
   2. Clock — «часы» экрана: пауза, скорость, ожидания, твины.
   3. Stage — SVG-сцена с узлами, линиями и летающими пакетами.
   4. Экраны: у каждого init() (вызывается один раз при первом показе)
      и clocks[] — часы, которые тикают, только пока экран открыт.
   5. Навигация и главный цикл анимации (requestAnimationFrame).
   ===================================================================== */

/* ---------- 1. Помощники ---------- */
const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Этим значением отклоняются ожидания, когда анимацию перезапускают
const CANCELLED = Symbol('cancelled');

const App = { speed: 1, current: null, inited: new Set(), stages: [] };

// Заполняет элемент атрибутами и детьми. text/html/on* обрабатываются особо.
function fillNode(node, attrs, kids) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : String(kid));
  }
  return node;
}
const h = (tag, attrs, ...kids) => fillNode(document.createElement(tag), attrs, kids);
const sv = (tag, attrs, ...kids) => fillNode(document.createElementNS(SVG_NS, tag), attrs, kids);
const icon = (id, cls = 'icon') => sv('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('use', { href: '#ic-' + id }));

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tpl = (str, vars) => String(str).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const pick = list => list[Math.floor(Math.random() * list.length)];
const ignoreCancel = e => { if (e !== CANCELLED) console.error(e); };
// Заменить содержимое элемента: массивы разворачиваются, null/false пропускаются
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
const paragraphs = text => [].concat(text).map(t => h('p', { text: t }));

function pickWeighted(list) {
  const total = list.reduce((s, x) => s + (x.weight || 1), 0);
  let r = Math.random() * total;
  for (const x of list) { r -= x.weight || 1; if (r <= 0) return x; }
  return list[list.length - 1];
}

// Цветной чип слоя (tip — своя подсказка вместо описания слоя)
function chip(key, text, tip) {
  const L = LAYERS[key] || LAYERS.hw;
  return h('span', { class: 'chip', style: `--c: var(--l-${key})`, 'data-layer': key, 'data-tip': tip || L.desc }, text || L.short);
}

function panel(title, ...content) {
  return h('div', { class: 'panel' }, h('div', { class: 'small-title', text: title }), content);
}

function makeTable(head, rows, bodyRef) {
  const tbody = h('tbody', {}, rows);
  if (bodyRef) bodyRef.tbody = tbody;
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'table' }, h('thead', {}, h('tr', {}, head.map(t => h('th', { text: t })))), tbody));
}

// Простая подсветка синтаксиса: json, http (заголовки + JSON-тело), shell, python
function highlight(code, lang) {
  const json = s => esc(s).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|(-?\b\d+(?:\.\d+)?\b)/g,
    (m, str, colon, num) => str
      ? (colon ? `<span class="tk-key">${str}</span>${colon}` : `<span class="tk-str">${str}</span>`)
      : `<span class="tk-num">${num}</span>`);
  if (lang === 'json') return json(code);
  if (lang === 'http') {
    const [head, ...rest] = code.split('\n\n');
    const headHtml = head.split('\n').map((line, i) => i === 0
      ? esc(line).replace(/^(\S+)/, '<span class="tk-method">$1</span>')
      : esc(line).replace(/^([\w-]+)(:)/, '<span class="tk-hdr">$1</span>$2')).join('\n');
    if (!rest.length) return headHtml;
    const body = rest.join('\n\n');
    // Тело-HTML показываем одним цветом, тело-JSON подсвечиваем
    return headHtml + '\n\n' + (body.trimStart().startsWith('<') ? `<span class="tk-str">${esc(body)}</span>` : json(body));
  }
  if (lang === 'shell' || lang === 'python') {
    return code.split('\n').map(line => {
      const hash = line.indexOf('#');
      const body = hash >= 0 ? line.slice(0, hash) : line;
      const comment = hash >= 0 ? `<span class="tk-dim">${esc(line.slice(hash))}</span>` : '';
      return esc(body).replace(/(&quot;[^&]*?&quot;)/g, '<span class="tk-str">$1</span>') + comment;
    }).join('\n');
  }
  return esc(code);
}

// Псевдо-«шифротекст» для наглядности (детерминированный, не настоящее шифрование)
function fakeCipher(str, bytes = 22) {
  let x = 7;
  for (const c of str) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  const out = [];
  for (let i = 0; i < bytes; i++) { x = (x * 1103515245 + 12345) >>> 0; out.push(((x >>> 16) & 255).toString(16).padStart(2, '0')); }
  return out.join(' ');
}

// Ползунок скорости: все ползунки на всех экранах синхронизированы
function speedControl() {
  const out = h('output', { text: fmtSpeed(App.speed) });
  const inp = h('input', { type: 'range', min: '0.25', max: '3', step: '0.25', value: String(App.speed), 'aria-label': 'Скорость анимации' });
  inp.addEventListener('input', () => setSpeed(+inp.value));
  return h('label', { class: 'speed', 'data-tip': 'Скорость анимации: от 0,25× до 3×' }, h('span', { text: 'Скорость' }), inp, out);
}
function fmtSpeed(v) { return String(v).replace('.', ',') + '×'; }
function setSpeed(v) {
  App.speed = v;
  $$('.speed input').forEach(i => { i.value = v; });
  $$('.speed output').forEach(o => { o.textContent = fmtSpeed(v); });
}

// Панель управления анимацией: ↺, Назад, Играть/Пауза, Далее, скорость
function makeControls(o) {
  const el = h('div', { class: 'controls' });
  const btn = (ic, text, tip, fn, cls = '', iconAfter = false) => {
    const parts = [icon(ic), text ? h('span', { text }) : null];
    if (iconAfter) parts.reverse();
    return h('button', { class: 'btn ' + cls, type: 'button', 'data-tip': tip, 'aria-label': tip, onclick: fn }, parts);
  };
  const r = { el };
  const labels = o.playLabels || ['Играть', 'Пауза'];
  if (o.onRestart) el.append(r.restart = btn('restart', '', o.restartTip || 'Начать сначала', o.onRestart));
  if (o.onPrev) el.append(r.prev = btn('prev', 'Назад', 'Предыдущий шаг (←)', o.onPrev));
  if (o.onToggle) el.append(r.play = btn('play', labels[0], o.playTip || 'Воспроизведение / пауза', o.onToggle, 'primary'));
  if (o.onNext) el.append(r.next = btn('next', 'Далее', 'Следующий шаг (→)', o.onNext, '', true));
  el.append(speedControl());
  r.setPlaying = on => {
    if (!r.play) return;
    put(r.play, icon(on ? 'pause' : 'play'), h('span', { text: on ? labels[1] : labels[0] }));
    r.play.classList.toggle('on', on);
  };
  return r;
}

/* ---------- 2. Clock: время экрана ----------
   Главный цикл вызывает step(dt) только у часов открытого экрана.
   Поэтому всё, что ждёт через clock.wait(), автоматически замирает
   на паузе и на скрытых экранах, а скорость влияет на всё сразу. */
class Clock {
  constructor() {
    this.time = 0;
    this.paused = false;
    this.waiters = [];        // { at, resolve, reject }
    this.tweens = new Set();  // плавные изменения значения 0 → 1
    this.tickers = new Set(); // постоянные обработчики (сцены)
  }
  step(realDt) {
    if (this.paused) return;
    const dt = realDt * App.speed;
    this.time += dt;
    this.tickers.forEach(fn => fn(dt));
    this.tweens.forEach(tw => tw.tick(dt));
    if (this.waiters.length) {
      const due = this.waiters.filter(w => w.at <= this.time);
      if (due.length) {
        this.waiters = this.waiters.filter(w => w.at > this.time);
        due.forEach(w => w.resolve());
      }
    }
  }
  // Подождать sec секунд «времени экрана»
  wait(sec) {
    return new Promise((resolve, reject) => this.waiters.push({ at: this.time + sec, resolve, reject }));
  }
  // Плавно прогнать k от 0 до 1 за sec секунд, вызывая fn(k) каждый кадр
  tween(sec, fn) {
    return new Promise((resolve, reject) => {
      let t = 0;
      const tw = {
        reject,
        tick: dt => {
          t += dt;
          const k = Math.min(1, t / sec);
          fn(k);
          if (k >= 1) { this.tweens.delete(tw); resolve(); }
        },
      };
      this.tweens.add(tw);
      fn(0);
    });
  }
  // Отменить все ожидания: async-сценарии, которые их ждут, прерываются
  cancel() {
    const ws = this.waiters; this.waiters = [];
    ws.forEach(w => w.reject(CANCELLED));
    const tws = [...this.tweens]; this.tweens.clear();
    tws.forEach(tw => tw.reject(CANCELLED));
  }
}

/* ---------- 3. Stage: SVG-сцена ----------
   cfg: { nodes, links, zones, size: { wide: [w,h], tall: [w,h] },
          breakpoint, onNodeClick, onNodeHover, onRender }
   Если контейнер уже breakpoint и есть раскладка tall — схема
   перерисовывается вертикально (для телефона). */
class Stage {
  constructor(svgEl, clock, cfg) {
    this.svg = svgEl;
    this.clock = clock;
    this.cfg = cfg;
    this.nodes = JSON.parse(JSON.stringify(cfg.nodes)); // своя копия: подписи можно менять
    this.flights = new Set();
    this.marks = {};       // { 'active': Set(id), 'bad': Set(id), ... }
    this.nodeEls = {};
    this.linkEls = {};
    this.layout = null;
    svgEl.classList.add('stage');
    // Реестр сцен: «Показать на схеме» и подсветка слоя ищут сцены текущего экрана
    this.screen = svgEl.closest('.screen')?.dataset.screen;
    App.stages.push(this);
    this.gZones = sv('g'); this.gLinks = sv('g'); this.gExtra = sv('g'); this.gNodes = sv('g'); this.gDots = sv('g');
    svgEl.append(this.gZones, this.gLinks, this.gExtra, this.gNodes, this.gDots);
    clock.tickers.add(dt => this.tick(dt));
    this.relayout();
    if ('ResizeObserver' in window) new ResizeObserver(() => this.relayout()).observe(svgEl.parentElement);
    else window.addEventListener('resize', () => this.relayout());
  }

  pickLayout() {
    const w = this.svg.parentElement.clientWidth;
    return this.cfg.size.tall && w > 0 && w < (this.cfg.breakpoint || 600) ? 'tall' : 'wide';
  }
  relayout() {
    // Скрытый экран или вкладка (ширина 0) — раскладку не трогаем, перерисуем при показе
    if (this.layout && this.svg.parentElement.clientWidth === 0) return;
    const L = this.pickLayout();
    if (L === this.layout) return;
    this.layout = L;
    this.render();
  }

  // Координаты: id узла → {x, y}; объект {x, y} возвращается как есть
  xy(p) {
    if (typeof p !== 'string') return p;
    const n = this.nodes[p];
    const c = n[this.layout] || n.wide;
    return { x: c[0], y: c[1] };
  }

  render() {
    const [w, hgt] = this.cfg.size[this.layout];
    this.svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
    [this.gZones, this.gLinks, this.gExtra, this.gNodes].forEach(g => put(g));
    this.nodeEls = {}; this.linkEls = {};

    for (const z of this.cfg.zones || []) {
      const r = z[this.layout];
      if (!r) continue;
      this.gZones.append(
        sv('rect', { class: 'zone', x: r[0], y: r[1], width: r[2], height: r[3], rx: 18 }),
        sv('text', { class: 'zone-label', x: r[0] + 14, y: r[1] + 22, text: z.label }));
    }

    for (const l of this.cfg.links || []) {
      const a = this.xy(l.from), b = this.xy(l.to);
      // Слой линии: задан явно или по типу (кабель и Wi-Fi — канальный уровень, туннель — SSH)
      const lineLayer = l.layer || { eth: 'link', wifi: 'link', tunnel: 'ssh' }[l.type];
      const line = sv('line', { class: `link ${l.type || ''}`, x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'data-layer': lineLayer });
      this.gLinks.append(line);
      if (l.id) this.linkEls[l.id] = line;
      if (l.label) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const vertical = Math.abs(b.x - a.x) < Math.abs(b.y - a.y);
        this.gLinks.append(sv('text', vertical
          ? { class: 'link-label', x: mx + 9, y: my + 4, 'text-anchor': 'start', text: l.label }
          : { class: 'link-label', x: mx, y: my - 8, text: l.label }));
      }
      // У линий с описанием есть невидимая широкая «зона нажатия»
      if (l.title && this.cfg.onNodeClick) {
        const hit = sv('line', { class: 'link-hit', x1: a.x, y1: a.y, x2: b.x, y2: b.y, tabindex: 0, role: 'button', 'aria-label': l.title });
        hit.addEventListener('click', () => this.cfg.onNodeClick(l.id));
        hit.addEventListener('keydown', e => { if (e.key === 'Enter') this.cfg.onNodeClick(l.id); });
        if (this.cfg.onNodeHover) {
          hit.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') this.cfg.onNodeHover(l.id); });
          hit.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') this.cfg.onNodeHover(null); });
        }
        this.gLinks.append(hit);
      }
    }

    for (const id of Object.keys(this.nodes)) this.gNodes.append(this.renderNode(id));
    this.cfg.onRender?.(this);
    this.applyMarks();
  }

  renderNode(id) {
    const n = this.nodes[id];
    const p = this.xy(id);
    const R = n.r || 26;
    const lp = (n.lp && typeof n.lp === 'object') ? (n.lp[this.layout] || 'below') : (n.lp || 'below');
    const clickable = !!this.cfg.onNodeClick;
    const g = sv('g', {
      class: 'node' + (clickable ? ' clickable' : ''), 'data-id': id,
      transform: `translate(${p.x} ${p.y})`, style: `--c: var(--l-${n.layer || 'hw'})`, 'data-layer': n.layer || 'hw',
      'data-tip': (!this.cfg.onNodeHover && n.tip) ? n.tip : null,
    });
    g.append(
      sv('circle', { class: 'halo', r: R }),
      sv('circle', { class: 'ring', r: R }),
      sv('use', { href: '#ic-' + n.icon, class: 'ic', x: -R * 0.52, y: -R * 0.52, width: R * 1.04, height: R * 1.04 }));
    let lx = 0, ly = R + 17, anchor = 'middle';
    if (lp === 'right') { lx = R + 10; ly = -2; anchor = 'start'; }
    if (lp === 'left') { lx = -R - 10; ly = -2; anchor = 'end'; }
    g.append(sv('text', { class: 'lbl', x: lx, y: ly, 'text-anchor': anchor, text: n.label }));
    if (n.sub) g.append(sv('text', { class: 'sub', x: lx, y: ly + 15, 'text-anchor': anchor, text: n.sub }));

    if (clickable) {
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', n.title || n.label);
      g.addEventListener('click', () => this.cfg.onNodeClick(id));
      g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.cfg.onNodeClick(id); } });
    }
    if (this.cfg.onNodeHover) {
      // Только мышь: касание на телефоне не должно считаться «наведением»
      g.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') this.cfg.onNodeHover(id); });
      g.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') this.cfg.onNodeHover(null); });
    }
    this.nodeEls[id] = g;
    return g;
  }

  // Поменять подпись узла на лету (например, «Сервер зоны .net»)
  setLabel(id, patch) {
    Object.assign(this.nodes[id], patch);
    const old = this.nodeEls[id];
    const fresh = this.renderNode(id);
    old.replaceWith(fresh);
    this.applyMarks();
  }

  // Пометить узлы/линии классом: active, bad, good …
  setMark(cls, ids) {
    this.marks[cls] = new Set(ids);
    this.applyMarks();
  }
  applyMarks() {
    const all = { ...this.nodeEls, ...this.linkEls };
    for (const [id, el] of Object.entries(all)) {
      for (const [cls, set] of Object.entries(this.marks)) el.classList.toggle(cls, set.has(id));
    }
  }

  // Короткая «волна» вокруг узла (Web Animations API — без перерисовки страницы)
  pulse(id) {
    if (REDUCED_MOTION) return;
    const halo = this.nodeEls[id]?.querySelector('.halo');
    if (!halo || !halo.animate) return;
    halo.animate([{ opacity: 0.9, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.8)' }],
      { duration: 700, easing: 'ease-out' });
  }

  // Красный крестик в точке (для заблокированных пакетов)
  cross(p) {
    const t = sv('text', { class: 'blocked-x', x: p.x, y: p.y, text: '✕' });
    this.gDots.append(t);
    t.animate?.([{ opacity: 1, transform: 'scale(.5)' }, { opacity: 1, transform: 'scale(1.25)', offset: 0.3 }, { opacity: 0, transform: 'scale(1)' }],
      { duration: 800, easing: 'ease-out' });
    setTimeout(() => t.remove(), 820);
  }

  makeDot(label, color, layer) {
    const g = sv('g', { class: 'dot', style: `--c: ${color}`, 'data-layer': layer });
    const txt = label == null ? '' : String(label);
    if (txt.length <= 2) g.append(sv('circle', { r: txt ? 10.5 : 6 }));
    else {
      const w = txt.length * 6.6 + 14;
      g.append(sv('rect', { x: -w / 2, y: -10.5, width: w, height: 21, rx: 10.5 }));
    }
    if (txt) g.append(sv('text', { y: 0.5, text: txt }));
    this.gDots.append(g);
    return g;
  }
  place(dot, p) {
    dot.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
  }

  /* АНИМАЦИЯ ПАКЕТА.
     route — массив id узлов и/или точек {x,y}. Точка движется с постоянной
     скоростью (o.speed единиц viewBox в секунду × скорость экрана) по
     ломаной. Каждый кадр Clock вызывает tick(dt). Возвращает Promise,
     который выполняется, когда пакет долетел. */
  fly(route, o = {}) {
    const color = o.color || `var(--l-${o.layer || 'ip'})`;
    return new Promise((resolve, reject) => {
      const dot = this.makeDot(o.label, color, o.color ? null : (o.layer || 'ip'));
      const f = { route, i: 0, d: 0, dot, resolve, reject, speed: o.speed || 230, o };
      this.place(dot, this.xy(route[0]));
      // Без анимаций (prefers-reduced-motion): пакет сразу стоит в конце пути, пауза — и дальше
      if (REDUCED_MOTION && route.length > 1) {
        this.place(dot, this.xy(route[route.length - 1]));
        f.still = true;
        f.wait = 0.7;
      }
      if (typeof route[0] === 'string') this.pulse(route[0]);
      if (route.length < 2) { this.finish(f); return; }
      this.flights.add(f);
    });
  }
  tick(dt) {
    for (const f of this.flights) {
      if (f.still) { f.wait -= dt; if (f.wait <= 0) this.finish(f); continue; }
      f.d += f.speed * dt;  // сколько единиц пройдено по текущему отрезку
      let a = this.xy(f.route[f.i]);
      let b = this.xy(f.route[f.i + 1]);
      let len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      // Если за кадр перелетели конец отрезка — переходим на следующий
      while (f.d >= len) {
        f.d -= len;
        f.i++;
        const hop = f.route[f.i];
        if (typeof hop === 'string') this.pulse(hop); // узел «моргает», когда пакет проходит через него
        if (f.i >= f.route.length - 1) { this.place(f.dot, b); this.finish(f); break; }
        a = b;
        b = this.xy(f.route[f.i + 1]);
        len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      }
      if (this.flights.has(f)) {
        const k = f.d / len; // линейная интерполяция внутри отрезка
        this.place(f.dot, { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
      }
    }
  }
  finish(f) {
    this.flights.delete(f);
    if (!f.o.keep) {
      f.dot.classList.add('gone');
      setTimeout(() => f.dot.remove(), 320);
    }
    f.resolve(f.dot);
  }
  // Убрать все пакеты и прервать их обещания
  reset() {
    for (const f of this.flights) f.reject(CANCELLED);
    this.flights.clear();
    put(this.gDots);
  }
}

/* ---------- Подсказки при наведении (атрибут data-tip) ---------- */
function initTooltips() {
  const tip = $('#tooltip');
  let current = null, hideTimer = 0;
  const move = (x, y) => {
    const r = tip.getBoundingClientRect();
    let left = x + 14, top = y + 18;
    if (left + r.width > innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > innerHeight - 8) top = y - r.height - 14;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, top) + 'px';
  };
  const show = (el, x, y) => {
    tip.textContent = el.getAttribute('data-tip');
    tip.classList.add('show');
    move(x, y);
  };
  const hide = () => { tip.classList.remove('show'); current = null; };
  document.addEventListener('pointerover', e => {
    if (e.pointerType === 'touch') return;
    const el = e.target.closest?.('[data-tip]');
    if (el === current) return;
    current = el;
    if (el && el.getAttribute('data-tip')) show(el, e.clientX, e.clientY); else tip.classList.remove('show');
  });
  document.addEventListener('pointermove', e => { if (current && e.pointerType !== 'touch') move(e.clientX, e.clientY); });
  // На телефоне подсказка показывается по касанию и сама прячется
  document.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    const el = e.target.closest?.('[data-tip]');
    if (!el || !el.getAttribute('data-tip')) return hide();
    show(el, e.clientX, e.clientY);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 2400);
  });
  window.addEventListener('scroll', hide, { passive: true });
}

/* =====================================================================
   4. ЭКРАНЫ
   ===================================================================== */

/* ---------- 1. Общая карта ---------- */
const MapScreen = {
  init(root) {
    this.clock = new Clock();
    this.clocks = [this.clock];
    this.card = $('#map-card', root);
    this.pinned = null;
    this.stage = new Stage($('#map-svg', root), this.clock, {
      nodes: MAP.nodes, links: MAP.links, zones: MAP.zones, size: MAP.size, breakpoint: 560,
      onNodeClick: id => this.pin(id),
      onNodeHover: id => this.show(id || this.pinned),
    });
    this.show(null);
    $('#map-legend', root).append(
      h('div', { class: 'small-title', text: 'Цвета слоёв — одинаковые на всех экранах (наведи, чтобы прочитать)' }),
      h('div', { class: 'legend' }, [...LAYER_STACK, 'dns', 'sec', 'ssh', 'cicd', 'api'].map(k => chip(k, LAYERS[k].name))));
    if (!REDUCED_MOTION) this.ambient();
  },
  find(id) { return MAP.nodes[id] || MAP.links.find(l => l.id === id); },
  pin(id) {
    this.pinned = this.pinned === id ? null : id;
    this.stage.setMark('active', this.pinned ? [this.pinned] : []);
    this.show(this.pinned);
    if (this.pinned && innerWidth < 960) this.card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },
  show(id) {
    const it = id && this.find(id);
    const key = it ? id : null;
    if (this.shown === key && this.card.childElementCount) return;
    this.shown = key;
    if (!it) {
      this.card.style.removeProperty('--c');
      put(this.card, h('div', { class: 'card-empty' },
        h('h3', { text: 'Нажми на любой элемент схемы' }),
        h('p', { text: 'Каждый узел и линии с подписями кликабельны: нажатие открывает и закрепляет карточку (на компьютере можно просто навести курсор). Как читать карту:' }),
        h('ul', {}, MAP.intro.map(t => h('li', { text: t })))));
      return;
    }
    const sec = (title, text, cls = '') => text ? h('div', { class: 'card-sec ' + cls }, h('b', { text: title }), h('span', { text })) : null;
    this.card.style.setProperty('--c', `var(--l-${it.layer})`);
    put(this.card, 
      h('div', { class: 'card-top' }, icon(it.icon || 'globe', 'icon big'),
        h('div', {}, h('h3', { text: it.title || it.label }), chip(it.layer, LAYERS[it.layer].name))),
      sec('Что это', it.what), sec('Зачем нужно', it.why), sec('Аналогия', it.analogy, 'analogy'));
  },
  // Фоновые пакеты: бесконечный цикл, замирает вместе с часами экрана
  async ambient() {
    try {
      for (;;) {
        const r = pick(MAP.ambient);
        this.stage.fly(r.route, { layer: r.layer, speed: 120 }).catch(() => {});
        await this.clock.wait(1.3 + Math.random() * 0.8);
      }
    } catch (e) { ignoreCancel(e); }
  },
};

/* ---------- 2. Путь одного запроса (главная анимация) ---------- */
const RequestScreen = {
  init(root) {
    this.clock = new Clock();
    this.clocks = [this.clock];
    this.idx = 0;
    this.auto = false;   // автоплей: после шага сам переходит к следующему
    this.done = false;   // анимация текущего шага закончилась
    this.arrived = [];   // порядок прихода пакетов на сервер
    this.stage = new Stage($('#req-svg', root), this.clock, { nodes: REQ_NODES, links: REQ_LINKS, size: { wide: [1000, 350], tall: [360, 715] } });

    this.ctrl = makeControls({
      onRestart: () => { this.setAuto(false); this.playStep(0); },
      onPrev: () => this.go(-1),
      onNext: () => this.go(1),
      onToggle: () => this.toggle(),
      playLabels: ['Автоплей', 'Пауза'],
      playTip: 'Автоплей / пауза (пробел)',
    });
    this.ctrl.play.classList.add('pulse-hint');
    $('#req-controls', root).append(this.ctrl.el);

    this.progress = REQUEST_STEPS.map((st, i) => h('button', {
      type: 'button', text: i + 1, 'data-tip': st.title, 'aria-label': `Шаг ${i + 1}: ${st.title}`, onclick: () => this.playStep(i),
    }));
    $('#req-progress', root).append(...this.progress);

    this.cells = {};
    $('#req-layers', root).append(...[...LAYER_STACK, 'dns'].map(k => {
      this.cells[k] = h('div', { class: 'layer-cell', style: `--c: var(--l-${k})`, 'data-layer': k, 'data-tip': LAYERS[k].desc },
        h('b', { text: LAYERS[k].short }), h('span', { text: LAYERS[k].role }));
      return this.cells[k];
    }));

    document.addEventListener('keydown', e => this.onKey(e));
    this.playStep(0);
  },

  setAuto(on) {
    this.auto = on;
    this.ctrl.setPlaying(on);
  },
  toggle() {
    this.ctrl.play.classList.remove('pulse-hint');
    if (this.auto) {           // пауза: замораживаем время экрана
      this.setAuto(false);
      this.clock.paused = true;
    } else {                   // автоплей: продолжаем и идём дальше сами
      this.setAuto(true);
      this.clock.paused = false;
      if (this.done) this.playStep(this.idx >= REQUEST_STEPS.length - 1 ? 0 : this.idx + 1);
    }
  },
  go(delta) {
    const i = this.idx + delta;
    if (i >= 0 && i < REQUEST_STEPS.length) this.playStep(i);
  },
  onKey(e) {
    if (App.current !== 'request' || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest?.('input, textarea, select')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); this.go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(-1); }
    else if (e.key === ' ' && !e.target.closest?.('button, a')) { e.preventDefault(); this.toggle(); }
  },

  /* Проиграть шаг i: прерываем всё старое, рисуем тексты,
     затем по очереди запускаем группы полётов из REQUEST_STEPS[i].anim */
  async playStep(i) {
    this.clock.cancel();
    this.stage.reset();
    this.clock.paused = false;
    this.idx = i;
    this.done = false;
    this.arrived = [];
    const st = REQUEST_STEPS[i];
    this.render(st);
    try {
      await this.clock.wait(0.4);
      for (const group of st.anim || []) {
        // Полёты внутри группы идут параллельно, каждый со своей задержкой
        await Promise.all(group.map(async f => {
          if (f.delay) await this.clock.wait(f.delay);
          await this.stage.fly(f.route, f);
          if (f.num) this.onArrive(f.num);
        }));
        await this.clock.wait(0.25);
      }
      for (const id of st.pulse || []) { this.stage.pulse(id); await this.clock.wait(0.6); }
      // Время на чтение текста перед автопереходом
      const chars = [].concat(st.text).join(' ').length;
      await this.clock.wait(Math.max(2.5, chars / 45));
      this.done = true;
      if (this.auto) {
        if (i < REQUEST_STEPS.length - 1) this.playStep(i + 1);
        else this.setAuto(false);
      }
    } catch (e) { ignoreCancel(e); }
  },

  render(st) {
    const i = this.idx, n = REQUEST_STEPS.length;
    put($('#req-step'), 
      h('div', { class: 'step-num', text: `Шаг ${i + 1} из ${n}` }),
      h('h3', { text: st.title }),
      paragraphs(st.text),
      st.note ? h('div', { class: 'note', text: st.note }) : null);
    put($('#req-payload'), 
      h('div', { class: 'payload-title', text: `Что сейчас «в посылке» · ${st.payload.title}` }),
      h('pre', { class: 'code', html: highlight(st.payload.code, st.payload.lang) }));
    this.renderAssembly();
    this.progress.forEach((b, k) => { b.className = k === i ? 'current' : k < i ? 'done' : ''; });
    for (const [k, c] of Object.entries(this.cells)) c.classList.toggle('on', st.layers.includes(k));
    this.stage.setMark('active', st.focus || []);
    this.ctrl.prev.disabled = i === 0;
    this.ctrl.next.disabled = i === n - 1;
  },

  // Блок «сборка пакетов на сервере» (шаги 7 и 8)
  renderAssembly() {
    const st = REQUEST_STEPS[this.idx];
    const box = $('#req-assembly');
    if (!st.assembly) { put(box); return; }
    const done = st.assembly === 'done';
    const filled = done ? [1, 2, 3, 4] : this.arrived;
    const order = done ? (this.lastOrder || [1, 3, 2, 4]) : this.arrived;
    let note = 'Ждём пакеты…';
    if (order.length) note = `Пришли в порядке: ${order.join(', ')}` + (order.length === 4 ? ' → TCP разложил по номерам: 1, 2, 3, 4 ✓' : '…');
    put(box, h('div', { class: 'assembly' },
      h('div', { class: 'small-title', text: 'Сборка на сервере (TCP)' }),
      h('div', { class: 'slots' }, [1, 2, 3, 4].map(k => h('div', { class: 'slot' + (filled.includes(k) ? ' filled' : ''), text: k }))),
      h('div', { class: 'hint', text: note })));
  },
  onArrive(num) {
    this.arrived.push(num);
    if (this.arrived.length === 4) this.lastOrder = [...this.arrived];
    this.renderAssembly();
  },
};

/* ---------- 3. Слои-матрёшка ---------- */
const LayersScreen = {
  init(root) {
    this.boxes = {};
    // Рекурсивно строим вложенные коробки: каждая следующая — внутри предыдущей
    const build = i => {
      const L = LAYER_INFO[i];
      const box = h('div', { class: 'layer-box', style: `--c: var(--l-${L.key})` });
      const head = h('button', { class: 'layer-head', type: 'button', 'aria-expanded': 'false', onclick: () => this.toggle(L.key) },
        icon('next', 'icon chev'),
        h('span', { class: 'lname', text: L.title }),
        h('span', { class: 'llevel', text: L.level }),
        h('span', { class: 'ladds', text: '+ ' + L.adds }));
      const fields = h('dl', { class: 'fields' }, L.fields.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));
      box.append(head, h('div', { class: 'layer-detail' }, fields,
        h('div', { class: 'layer-who', text: L.who }),
        h('div', { class: 'analogy', text: 'Аналогия: ' + L.analogy })));
      box.append(i + 1 < LAYER_INFO.length ? build(i + 1) : h('div', { class: 'layer-core', text: LAYER_CORE }));
      this.boxes[L.key] = { box, head };
      return box;
    };
    const m = $('#matryoshka', root);
    m.append(build(0), h('p', { class: 'hint', text: 'Отправка: обёртки надеваются изнутри наружу (JSON → HTTP → TLS → TCP → IP → кадр). Получение: снимаются в обратном порядке. Каждое устройство снимает ровно столько обёрток, сколько ему нужно.' }));
    this.toggle('link', true);

    $('#layers-open', root).addEventListener('click', () => Object.keys(this.boxes).forEach(k => this.toggle(k, true)));
    $('#layers-close', root).addEventListener('click', () => Object.keys(this.boxes).forEach(k => this.toggle(k, false)));

    $('#wire', root).append(...WIRE.map(([k, label, w]) => h('button', {
      type: 'button', style: `--c: var(--l-${k}); flex: ${w} 1 0px`, 'data-layer': k, text: label,
      'data-tip': `${LAYERS[k].name}: ${LAYERS[k].desc}`,
      onclick: () => { this.toggle(k, true); this.flash(k); },
    })));

    $('#readers', root).append(h('div', { class: 'readers' }, LAYER_READERS.map(r =>
      h('div', { class: 'reader' }, icon(r.icon), h('span', { class: 'who', text: r.who }), r.layers.map(k => chip(k))))));
  },
  toggle(key, force) {
    const { box, head } = this.boxes[key];
    const open = box.classList.toggle('open', force);
    head.setAttribute('aria-expanded', String(open));
  },
  onHighlight(key) {
    if (key && this.boxes[key]) { this.toggle(key, true); this.flash(key); }
  },
  flash(key) {
    const { box } = this.boxes[key];
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    box.classList.add('flash');
    setTimeout(() => box.classList.remove('flash'), 900);
  },
};

/* ---------- 4. DNS ---------- */
const DnsScreen = {
  init(root) {
    this.clock = new Clock();     // основная анимация поиска
    this.cmpClock = new Clock();  // сравнение «работает / не работает»
    this.clocks = [this.clock, this.cmpClock];
    this.cache = {};
    this.stage = new Stage($('#dns-svg', root), this.clock, { nodes: DNS.nodes, links: DNS.links, size: DNS.size });

    this.pickBtns = Object.keys(DNS.domains).map(d => h('button', { class: 'btn sm', type: 'button', text: d, onclick: () => this.lookup(d) }));
    $('#dns-picker', root).append(...this.pickBtns);
    $('#dns-clear', root).addEventListener('click', () => { this.cache = {}; this.renderCache(); });

    this.ctrl = makeControls({
      onRestart: () => this.current && this.lookup(this.current), restartTip: 'Повторить поиск',
      onToggle: () => this.toggle(), playLabels: ['Продолжить', 'Пауза'],
    });
    this.ctrl.setPlaying(true);
    $('#dns-controls', root).append(this.ctrl.el);
    $('#dns-analogy', root).textContent = DNS.analogy;
    this.renderCache();

    // Сравнение
    const t = DNS.trouble;
    $('#dns-trouble-lead', root).textContent = t.lead;
    const cfg = { nodes: t.nodes, links: t.links, size: { wide: t.size } };
    this.okStage = new Stage($('#dns-ok', root), this.cmpClock, cfg);
    this.badStage = new Stage($('#dns-bad', root), this.cmpClock, cfg);
    this.okStage.setLabel('dns', { label: 'DNS-сервер', sub: 'отвечает' });
    $('#dns-compare-run', root).addEventListener('click', () => this.runCompare());
    $('#dns-fix', root).addEventListener('change', () => this.runCompare());
    const ul = items => h('ul', { class: 'list' }, items.map(x => h('li', { text: x })));
    $('#dns-symptoms', root).append(
      h('div', { class: 'small-title', text: 'Признаки, что виноват DNS' }), ul(t.symptoms),
      h('div', { class: 'small-title', style: 'margin-top:16px', text: 'Что делать' }), ul(t.fixes));
    $('#dns-commands', root).append(
      h('div', { class: 'small-title', text: 'Полезные команды (Windows, cmd или PowerShell)' }),
      h('pre', { class: 'code', html: highlight(t.commands, 'shell') }));

    this.lookup('api.anthropic.com');
    this.runCompare();
  },

  toggle() {
    const paused = !this.clock.paused;
    this.clock.paused = paused;
    this.cmpClock.paused = paused;
    this.ctrl.setPlaying(!paused);
  },

  // Полный путь поиска IP по сценарию из DNS.script (или cachedScript)
  async lookup(domain) {
    this.clock.cancel();
    this.stage.reset();
    this.clock.paused = false;
    this.cmpClock.paused = false;
    this.ctrl.setPlaying(true);
    this.current = domain;
    this.pickBtns.forEach(b => b.classList.toggle('selected', b.textContent === domain));
    const parts = domain.split('.');
    const vars = { domain, ip: DNS.domains[domain], tld: parts[parts.length - 1], zone: parts.slice(-2).join('.') };
    this.stage.setLabel('tld', { label: `Сервер зоны .${vars.tld}` });
    this.stage.setLabel('auth', { label: `NS ${vars.zone}` });
    const script = this.cache[domain] ? DNS.cachedScript : DNS.script;
    const log = $('#dns-log');
    put(log);
    try {
      for (const st of script) {
        $$('li', log).forEach(li => li.classList.remove('now'));
        log.append(h('li', { class: 'now', text: tpl(st.text, vars) }));
        log.scrollTop = log.scrollHeight;
        this.stage.setMark('active', [st.from, st.to]);
        await this.stage.fly([st.from, st.to], { layer: 'dns', label: tpl(st.label, vars), speed: 260 });
        if (st.done) { this.cache[domain] = vars.ip; this.renderCache(); }
        await this.clock.wait(1.1);
      }
      this.stage.setMark('active', ['you']);
    } catch (e) { ignoreCancel(e); }
  },

  renderCache() {
    const box = $('#dns-cache');
    const entries = Object.entries(this.cache);
    put(box, ...(entries.length
      ? entries.map(([d, ip]) => h('div', { class: 'cache-row' }, h('span', { text: d }), h('span', { class: 'ip', text: ip }), h('span', { class: 'tk-dim', text: 'TTL 300 с' })))
      : [h('div', { class: 'cache-empty', text: 'Пусто. Найди домен — ответ сохранится здесь, и повторный поиск будет мгновенным.' })]));
  },

  async runCompare() {
    this.cmpClock.cancel();
    this.okStage.reset();
    this.badStage.reset();
    this.cmpClock.paused = this.clock.paused;
    const fixed = $('#dns-fix').checked;
    this.badStage.setLabel('dns', fixed ? DNS.trouble.fixedDns : { label: 'DNS провайдера', sub: 'завис' });
    const title = $('#dns-bad-title');
    title.textContent = fixed ? 'DNS заменён на 1.1.1.1' : 'DNS не работает';
    title.className = 'compare-title ' + (fixed ? 'ok' : 'bad');
    try {
      await Promise.all([
        this.scenario(this.okStage, $('#dns-ok-status'), true),
        this.scenario(this.badStage, $('#dns-bad-status'), fixed),
      ]);
    } catch (e) { ignoreCancel(e); }
  },
  async scenario(stage, statusEl, works) {
    const set = (cls, text) => { statusEl.className = 'status ' + cls; statusEl.textContent = text; };
    stage.setMark('bad', []);
    stage.setMark('good', []);
    set('wait', 'Игра: «Где сервер game.example.net?» — спрашиваю DNS…');
    await stage.fly(['game', 'dns'], { layer: 'dns', label: '?', speed: 150 });
    if (!works) {
      stage.setMark('bad', ['dns']);
      set('wait', 'DNS молчит… Игра ждёт ответа (таймаут)…');
      await this.cmpClock.wait(2.6);
      stage.setMark('good', ['server']);
      set('bad', '✕ «Не удаётся подключиться к серверу». А сервер-то работает (он зелёный): игра просто не узнала его адрес.');
      return;
    }
    await stage.fly(['dns', 'game'], { layer: 'dns', label: 'IP', speed: 150 });
    set('wait', 'Адрес 203.0.113.42 получен. Подключаюсь к серверу…');
    await stage.fly(['game', 'server'], { layer: 'tcp', label: 'SYN', speed: 160 });
    await stage.fly(['server', 'game'], { layer: 'tcp', label: 'OK', speed: 160 });
    stage.setMark('good', ['server']);
    set('ok', '✓ Подключено, пинг 35 мс. Можно играть!');
  },
};

/* ---------- 5. Железо ---------- */
const HardwareScreen = {
  init(root) {
    this.clock = new Clock();
    this.clocks = [this.clock];
    this.nat = [];
    this.stage = new Stage($('#hw-svg', root), this.clock, { nodes: HW.nodes, links: HW.links, zones: HW.zones, size: HW.size });

    this.actBtns = HW.actions.map(a => h('button', { class: 'btn sm', type: 'button', onclick: () => this.run(a) },
      h('b', { text: a.title }), h('span', { class: 'tk-dim', text: '· ' + a.hint })));
    $('#hw-actions', root).append(...this.actBtns);
    this.caption('Выбери сценарий выше. Следи за таблицами: подсвеченная строка — та, которой устройство пользуется прямо сейчас.');

    this.ctrl = makeControls({
      onRestart: () => this.last && this.run(this.last), restartTip: 'Повторить сценарий',
      onToggle: () => { this.clock.paused = !this.clock.paused; this.ctrl.setPlaying(!this.clock.paused); },
      playLabels: ['Продолжить', 'Пауза'],
    });
    this.ctrl.setPlaying(true);
    $('#hw-controls', root).append(this.ctrl.el);

    // Таблицы устройств
    this.macRows = {}; this.rtRows = {};
    const row = (cells, monoCols, key, store) => {
      const tr = h('tr', {}, cells.map((c, i) => h('td', { class: monoCols.includes(i) ? 'mono' : '', text: c })));
      store[key] = tr;
      return tr;
    };
    this.natRef = {};
    $('#hw-tables', root).append(
      panel('Коммутатор: таблица MAC-адресов', makeTable(['Порт', 'MAC', 'Кто'], HW.macTable.map(r => row([r.port, r.mac, r.who], [0, 1], r.key, this.macRows)))),
      panel('Роутер: таблица маршрутизации', makeTable(['Сеть', 'Куда'], HW.routeTable.map(r => row([r.net, r.via], [0], r.key, this.rtRows)))),
      panel('Роутер: таблица NAT', makeTable(['Внутри', 'Снаружи', 'Куда'], [], this.natRef)));
    this.renderNat(null);

    $('#hw-compare', root).append(
      h('thead', {}, h('tr', {}, HW.compare.head.map(t => h('th', { text: t })))),
      h('tbody', {}, HW.compare.rows.map(r => h('tr', {}, h('th', { text: r[0] }), h('td', { text: r[1] }), h('td', { text: r[2] })))));
    $('#hw-cards', root).append(...HW.cards.map(c => h('div', { class: 'panel card', style: `--c: var(--l-${c.layer})`, 'data-layer': c.layer },
      h('h4', {}, icon(c.icon), c.title), h('p', { text: c.text }), h('ul', {}, c.points.map(p => h('li', { text: p }))))));
  },

  caption(text, final) {
    const el = $('#hw-caption');
    el.textContent = text;
    el.style.borderLeftColor = final ? 'var(--ok)' : '';
  },

  async run(a) {
    this.last = a;
    this.clock.cancel();
    this.stage.reset();
    this.clock.paused = false;
    this.ctrl.setPlaying(true);
    this.actBtns.forEach((b, i) => b.classList.toggle('selected', HW.actions[i] === a));
    try {
      for (const st of a.steps) {
        this.highlightTables(st);
        this.caption(st.caption);
        this.stage.setMark('active', [st.route[0], st.route[st.route.length - 1]]);
        await this.stage.fly(st.route, { layer: st.layer, label: st.label, speed: 150 });
        await this.clock.wait(Math.max(1.8, st.caption.length / 55));
      }
      this.caption(a.summary, true);
      this.stage.setMark('active', []);
      this.highlightTables({});
    } catch (e) { ignoreCancel(e); }
  },

  highlightTables(st) {
    Object.entries(this.macRows).forEach(([k, tr]) => tr.classList.toggle('hl', k === st.mac));
    Object.entries(this.rtRows).forEach(([k, tr]) => tr.classList.toggle('hl', k === st.rt));
    let fresh = null;
    if (st.nat && st.nat.inside && !this.nat.some(n => n.id === st.nat.id)) { this.nat.push(st.nat); fresh = st.nat.id; }
    this.renderNat(st.nat ? st.nat.id : null, fresh);
  },
  renderNat(hlId, freshId) {
    const tbody = this.natRef.tbody;
    if (!this.nat.length) {
      put(tbody, h('tr', {}, h('td', { colspan: 3, class: 'table-empty', text: 'Пока пусто. Запусти сценарий с выходом в интернет.' })));
      return;
    }
    put(tbody, ...this.nat.map(n => h('tr', { class: (n.id === hlId ? 'hl' : '') + (n.id === freshId ? ' new' : '') },
      h('td', { class: 'mono', text: n.inside }), h('td', { class: 'mono', text: n.outside }), h('td', { class: 'mono', text: n.to }))));
  },
};

/* ---------- 6. Firewall ---------- */
const FirewallScreen = {
  init(root) {
    this.clock = new Clock();
    this.clocks = [this.clock];
    this.rules = FW.rules.map(r => ({ ...r, hits: 0 }));
    this.defaultDeny = FW.defaultDeny;
    this.defaultHits = 0;
    this.stats = { allow: 0, deny: 0 };

    const nodes = {};
    for (const [id, s] of Object.entries(FW.services)) nodes[id] = { ...s, lp: { wide: 'right' } };
    this.stage = new Stage($('#fw-svg', root), this.clock, { nodes, links: [], size: FW.size, breakpoint: 480, onRender: st => this.drawWall(st) });

    this.ctrl = makeControls({
      onRestart: () => this.resetStats(), restartTip: 'Сбросить счётчики',
      onToggle: () => { this.clock.paused = !this.clock.paused; this.ctrl.setPlaying(!this.clock.paused); },
      playLabels: ['Продолжить', 'Пауза'],
    });
    this.ctrl.setPlaying(true);
    $('#fw-controls', root).append(this.ctrl.el);

    this.renderRules();
    this.renderCounters();
    $('#fw-tips', root).append(h('div', { class: 'small-title', text: 'Попробуй' }), h('ul', { class: 'list' }, FW.tips.map(t => h('li', { text: t }))));
    this.loop();
  },

  // Стена firewall'а и подписи областей рисуются поверх линий, под узлами
  drawWall(st) {
    const [w, hh] = FW.size[st.layout];
    if (st.layout === 'wide') {
      const x = FW.gate.wide;
      st.gExtra.append(
        sv('rect', { class: 'fw-wall', x: x - 9, y: 26, width: 18, height: hh - 46, rx: 6 }),
        sv('use', { href: '#ic-shield', class: 'ic', x: x - 14, y: hh - 32, width: 28, height: 28, style: 'color: var(--l-sec)' }),
        sv('text', { class: 'fw-wall-label', x, y: 16, text: 'FIREWALL' }),
        sv('text', { class: 'fw-area-label', x: 16, y: 16, text: 'Интернет →' }),
        sv('text', { class: 'fw-area-label', x: x + 80, y: 16, text: 'Твой сервер' }));
    } else {
      const y = FW.gate.tall;
      st.gExtra.append(
        sv('rect', { class: 'fw-wall', x: 12, y: y - 9, width: w - 24, height: 18, rx: 6 }),
        sv('text', { class: 'fw-wall-label', x: w / 2, y: y - 18, text: 'FIREWALL' }),
        sv('text', { class: 'fw-area-label', x: 12, y: 18, text: 'Интернет ↓' }),
        sv('text', { class: 'fw-area-label', x: 12, y: y + 36, text: 'Твой сервер' }));
    }
  },

  // Бесконечный генератор входящего трафика
  async loop() {
    try {
      for (;;) {
        await this.clock.wait(0.4 + Math.random() * 0.5);
        if (this.stage.flights.size < 26) this.spawn();
      }
    } catch (e) { ignoreCancel(e); }
  },

  /* Один пакет: летит к стене → решение по правилам В МОМЕНТ прибытия
     (поэтому переключение правил видно сразу) → проходит к сервису
     или отскакивает с красным крестиком. */
  spawn() {
    const t = pickWeighted(FW.traffic);
    const L = this.stage.layout;
    const [w, hh] = FW.size[L];
    const svc = this.stage.xy(t.svc);
    const start = L === 'wide' ? { x: 20, y: 44 + Math.random() * (hh - 88) } : { x: 24 + Math.random() * (w - 48), y: 40 };
    const gate = L === 'wide' ? { x: FW.gate.wide - 14, y: svc.y } : { x: svc.x, y: FW.gate.tall - 14 };
    const label = String(t.port);
    this.stage.fly([start, gate], { layer: 'ip', label, speed: 150 })
      .then(() => {
        const v = this.decide(t);
        this.record(t, v);
        if (v.allow) return this.stage.fly([gate, t.svc], { color: 'var(--ok)', label, speed: 170 });
        this.stage.cross(gate);
        const back = L === 'wide'
          ? { x: gate.x - 45, y: gate.y + (Math.random() * 40 - 20) }
          : { x: gate.x + (Math.random() * 40 - 20), y: gate.y - 45 };
        return this.stage.fly([gate, back], { color: 'var(--bad)', label, speed: 110 });
      })
      .catch(ignoreCancel);
  },

  decide(t) {
    for (const r of this.rules) {
      if (!r.on) continue;
      const m = r.match;
      if ((m.port == null || m.port === t.port) && (m.src == null || m.src === t.src) && (m.proto == null || m.proto === t.proto)) {
        return { allow: r.action === 'allow', rule: r };
      }
    }
    return { allow: !this.defaultDeny, rule: null };
  },

  record(t, v) {
    if (v.rule) v.rule.hits++; else this.defaultHits++;
    this.stats[v.allow ? 'allow' : 'deny']++;
    const idx = v.rule ? this.rules.indexOf(v.rule) : -1;
    const ruleEl = idx >= 0 ? this.ruleEls[idx] : this.defaultEl;
    ruleEl.hits.textContent = v.rule ? v.rule.hits : this.defaultHits;
    ruleEl.el.classList.add('hit');
    clearTimeout(ruleEl.timer);
    ruleEl.timer = setTimeout(() => ruleEl.el.classList.remove('hit'), 300);

    const text = `${v.allow ? '✓' : '✕'} ${t.proto} ${t.port} от ${t.src} (${t.who}) — ${idx >= 0 ? 'правило ' + (idx + 1) : 'по умолчанию'}`;
    const log = $('#fw-log');
    log.prepend(h('li', { class: v.allow ? 'ok' : 'bad', text, title: text }));
    while (log.children.length > 12) log.lastChild.remove();
    this.renderCounters();
  },

  renderCounters() {
    put($('#fw-counters'), 
      h('div', { class: 'counter ok' }, h('b', { text: this.stats.allow }), 'пропущено'),
      h('div', { class: 'counter bad' }, h('b', { text: this.stats.deny }), 'заблокировано'));
  },
  resetStats() {
    this.stats = { allow: 0, deny: 0 };
    this.rules.forEach(r => { r.hits = 0; });
    this.defaultHits = 0;
    put($('#fw-log'));
    this.renderRules();
    this.renderCounters();
  },

  renderRules() {
    const box = $('#fw-rules');
    const makeRule = (text, action, on, hits, onChange, extraCls = '') => {
      const input = h('input', { type: 'checkbox', class: 'toggle', 'aria-label': text });
      input.checked = on;
      const tag = h('span', { class: 'tag ' + action, text: action === 'allow' ? 'пустить' : 'блок' });
      const hitsEl = h('span', { class: 'hits', text: hits, 'data-tip': 'Сколько раз правило сработало' });
      const el = h('label', { class: `rule ${extraCls}` + (on ? '' : ' off') }, input, tag, h('span', { text }), hitsEl);
      input.addEventListener('change', () => { el.classList.toggle('off', !input.checked); onChange(input.checked, tag); });
      return { el, hits: hitsEl };
    };
    this.ruleEls = this.rules.map((r, i) => makeRule(`${i + 1}. ${r.text}`, r.action, r.on, r.hits, on => { r.on = on; }));
    // Политика по умолчанию: выключили → «пустить всё остальное»
    this.defaultEl = makeRule(FW.defaultText, 'deny', this.defaultDeny, this.defaultHits, (on, tag) => {
      this.defaultDeny = on;
      tag.className = 'tag ' + (on ? 'deny' : 'allow');
      tag.textContent = on ? 'блок' : 'пустить';
    }, 'default');
    this.defaultEl.el.classList.remove('off');
    put(box, ...this.ruleEls.map(r => r.el), this.defaultEl.el);
  },
};

/* ---------- 7. API vs HTTP vs JSON ---------- */
const ApiScreen = {
  init(root) {
    $('#api-cards', root).append(...API.cards.map(c => h('div', { class: 'panel card', style: `--c: var(--l-${c.layer})`, 'data-layer': c.layer },
      h('h4', {}, icon(c.icon), c.title), h('p', { text: c.text }))));

    $('#api-flow', root).append(
      h('div', { class: 'small-title', text: 'Как проходит заказ' }),
      h('div', { class: 'flow' }, API.flow.map((f, i) => [
        i ? h('span', { class: 'flow-arrow', 'aria-hidden': 'true', text: '→' }) : null,
        h('div', { class: 'flow-step' }, h('div', { class: 'bubble', style: `--c: var(--l-${f.layer})` }, icon(f.icon)), h('b', { text: f.title }), h('span', { text: f.text })),
      ])),
      REDUCED_MOTION ? null : h('div', { class: 'flow-track', 'aria-hidden': 'true' }));

    // Фильтры подсветки: API / HTTP / JSON
    const filters = $('#api-filters', root);
    const setFilter = part => {
      $$('#api-filters .btn').forEach(b => b.classList.toggle('selected', b.dataset.part === part));
      $$('.annotated').forEach(pre => pre.classList.toggle('filtered', part !== 'all'));
      $$('.ann').forEach(s => s.classList.toggle('match', s.dataset.part === part));
    };
    filters.append(h('button', { class: 'btn sm selected', type: 'button', 'data-part': 'all', text: 'Показать всё', onclick: () => setFilter('all') }),
      ...Object.entries(API.parts).map(([part, label]) => h('button', { class: 'btn sm', type: 'button', 'data-part': part, onclick: () => setFilter(part) }, chip(part, label))));

    this.buildAnnotated($('#api-req', root), API.request);
    this.buildAnnotated($('#api-res', root), API.response);
    $('#api-explain', root).append(h('div', { class: 'small-title', text: 'Объяснение' }), h('p', { class: 'ex-empty', text: 'Наведи или нажми на подсвеченный кусок запроса или ответа — здесь появится объяснение. Цвет подсветки показывает, к чему относится кусок:' }),
      h('div', { class: 'btn-row' }, Object.entries(API.parts).map(([p, l]) => chip(p, l))));

    $('#api-sdk', root).innerHTML = highlight(API.sdk, 'python');
    const cls = code => code.startsWith('2') ? 'var(--ok)' : code.startsWith('4') ? 'var(--warn)' : 'var(--bad)';
    $('#api-status', root).append(
      h('thead', {}, h('tr', {}, ['Код', 'Название', 'Что значит'].map(t => h('th', { text: t })))),
      h('tbody', {}, API.statuses.map(([c, name, what]) => h('tr', {},
        h('td', { class: 'mono', style: `color:${cls(c)};font-weight:700`, text: c }), h('td', { class: 'mono', text: name }), h('td', { text: what })))));
  },

  // Строит «размеченный» код: каждый важный кусок — кнопка со своим объяснением
  buildAnnotated(pre, lines) {
    put(pre, ...lines.map(item => {
      const isObj = !Array.isArray(item);
      const parts = isObj ? item.line : item;
      const ln = h('span', { class: 'ln' + (isObj && item.json ? ' zone-json' : '') });
      for (const p of parts) {
        if (typeof p === 'string') { ln.append(p); continue; }
        const [text, id] = p;
        const note = API.notes[id];
        const span = h('span', { class: 'ann', style: `--c: var(--l-${note.part})`, 'data-part': note.part, tabindex: 0, role: 'button', text });
        const showIt = () => this.explain(id, span);
        span.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') showIt(); });
        span.addEventListener('click', showIt);
        span.addEventListener('focus', showIt);
        ln.append(span);
      }
      return ln;
    }));
  },
  explain(id, span) {
    const n = API.notes[id];
    $$('.ann.sel').forEach(s => s.classList.remove('sel'));
    span.classList.add('sel');
    put($('#api-explain'), chip(n.part, API.parts[n.part]), h('h4', { text: n.title }), h('p', { text: n.text }));
    if (innerWidth < 1100 && !span.matches(':hover')) $('#api-explain').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },
};

/* ---------- 8. SSH и CI/CD ---------- */
const SshScreen = {
  init(root) {
    this.sshClock = new Clock();
    this.ciClock = new Clock();
    this.clocks = [this.sshClock, this.ciClock];
    this.initSsh(root);
    this.initCicd(root);
  },

  /* --- SSH --- */
  initSsh(root) {
    this.connected = false;
    this.busy = false;
    this.stage = new Stage($('#ssh-svg', root), this.sshClock, {
      nodes: SSH.nodes, links: SSH.links, size: { wide: SSH.size },
      onRender: st => {
        // Замочки на туннеле
        for (const [a, b] of [['laptop', 'isp'], ['isp', 'server']]) {
          const p = st.xy(a), q = st.xy(b);
          st.gExtra.append(sv('use', { href: '#ic-lock', class: 'ic', x: (p.x + q.x) / 2 - 9, y: p.y - 30, width: 18, height: 18, style: 'color: var(--l-ssh)' }));
        }
      },
    });
    this.term = $('#ssh-term', root);
    this.vis = {};
    $('#ssh-vis', root).append(...[['you', 'Ты набрал'], ['net', 'Видит провайдер / Wi-Fi'], ['srv', 'Получил сервер']].map(([k, label]) => {
      this.vis[k] = h('code', { text: '—' });
      return h('div', { class: 'vis-row' + (k === 'net' ? ' enc' : '') }, h('span', { text: label }), this.vis[k]);
    }));
    const cmdBtn = (c, kind) => h('button', { class: 'btn sm', type: 'button', text: c.cmd, onclick: () => this.exec(kind, c) });
    this.btnConnect = cmdBtn(SSH.connect, 'connect');
    this.btnCmds = SSH.commands.map(c => cmdBtn(c, 'cmd'));
    this.btnExit = cmdBtn(SSH.exit, 'exit');
    $('#ssh-cmds', root).append(this.btnConnect, ...this.btnCmds, this.btnExit);
    $('#ssh-note', root).textContent = SSH.note;
    this.out('Нажми кнопку с командой ssh, чтобы подключиться к серверу.', 'sys');
    this.newPrompt();
    this.updateBtns();
  },
  scrollTerm() { this.term.scrollTop = this.term.scrollHeight; },
  out(text, cls = '') { this.term.append(h('div', { class: cls, text })); this.scrollTerm(); },
  newPrompt() {
    this.typed = h('span');
    this.cursor = h('span', { class: 'cursor' });
    this.term.append(h('div', {}, h('span', { class: this.connected ? 'p-remote' : 'p-local', text: this.connected ? SSH.remotePrompt : SSH.localPrompt }), this.typed, this.cursor));
    this.scrollTerm();
  },
  async typeCmd(cmd) {
    for (const ch of cmd) { this.typed.textContent += ch; await this.sshClock.wait(0.035); }
    await this.sshClock.wait(0.2);
    this.cursor.remove();
  },
  setVis(you, net, srv) { this.vis.you.textContent = you; this.vis.net.textContent = net; this.vis.srv.textContent = srv; },
  updateBtns() {
    this.btnConnect.disabled = this.busy || this.connected;
    [...this.btnCmds, this.btnExit].forEach(b => { b.disabled = this.busy || !this.connected; });
  },
  async exec(kind, c) {
    if (this.busy) return;
    this.busy = true;
    this.updateBtns();
    const toServer = ['laptop', 'isp', 'server'], toYou = ['server', 'isp', 'laptop'];
    try {
      await this.typeCmd(c.cmd);
      if (kind === 'connect') {
        this.setVis(c.cmd, 'обмен ключами: дальше всё будет зашифровано', '…');
        for (const st of SSH.connect.steps) {
          await this.stage.fly(st.dir === 'out' ? toServer : toYou, { layer: 'ssh', label: st.label, speed: 200 });
          this.out(st.line, 'sys');
        }
        this.connected = true;
        this.stage.setMark('active', ['server']);
        this.setVis('—', '—', '—');
      } else {
        const cipher = fakeCipher(c.cmd);
        this.setVis(c.cmd, cipher, '…');
        await this.stage.fly(toServer, { layer: 'ssh', label: '🔒', speed: 220 });
        this.setVis(c.cmd, cipher, c.cmd);
        await this.stage.fly(toYou, { layer: 'ssh', label: '🔒', speed: 220 });
        c.out.forEach(line => this.out(line));
        if (kind === 'exit') { this.connected = false; this.stage.setMark('active', []); }
      }
    } catch (e) { ignoreCancel(e); }
    this.busy = false;
    this.newPrompt();
    this.updateBtns();
  },

  /* --- CI/CD --- */
  initCicd(root) {
    this.version = CICD.startVersion;
    const pipe = $('#cicd-pipe', root);
    this.stageEls = [];
    this.conns = [];
    CICD.stages.forEach((s, i) => {
      if (i) {
        const c = h('div', { class: 'conn' }, h('div', { class: 'fill' }));
        this.conns.push(c);
        pipe.append(c);
      }
      const status = h('div', { class: 'pipe-status' });
      const el = h('div', { class: 'pipe-stage' }, h('div', { class: 'ph' }, icon(s.icon), s.title), h('p', { text: s.desc }), status);
      this.stageEls.push({ el, status });
      pipe.append(el);
    });
    this.resetPipe();
    $('#cicd-run', root).addEventListener('click', () => this.runPipeline());
    this.ciCtrl = makeControls({
      onToggle: () => { this.ciClock.paused = !this.ciClock.paused; this.ciCtrl.setPlaying(!this.ciClock.paused); },
      playLabels: ['Продолжить', 'Пауза'],
    });
    this.ciCtrl.setPlaying(true);
    $('#cicd-controls', root).append(this.ciCtrl.el);
    $('#cicd-note', root).textContent = CICD.note;
    this.setResult('', `Сейчас на сервере работает v1.${this.version}. Нажми «git push», чтобы выкатить новую версию. Включи «Сломать тест», чтобы посмотреть, как конвейер защищает прод.`);
  },
  setStage(i, state) {
    const { el, status } = this.stageEls[i];
    el.className = 'pipe-stage ' + state;
    const isProd = i === CICD.stages.length - 1;
    const text = { '': isProd ? `работает v1.${this.version}` : 'ждёт', run: 'идёт…', ok: isProd ? '✓ новая версия' : '✓ готово', fail: '✕ упало', skip: '— пропущено' }[state];
    put(status, state === 'run' ? h('span', { class: 'spinner' }) : '', text);
  },
  resetPipe() {
    this.stageEls.forEach((_, i) => this.setStage(i, ''));
    this.conns.forEach(c => c.style.setProperty('--p', 0));
  },
  setResult(cls, text) {
    const el = $('#cicd-result');
    el.className = 'status ' + cls;
    el.textContent = text;
  },
  logLine(text) {
    const log = $('#cicd-log');
    const cls = text.startsWith('✓') ? 'ok' : (text.startsWith('✕') || text.startsWith('FAIL')) ? 'bad' : text.startsWith('$') ? 'cmd' : '';
    log.append(h('div', { class: cls, text }));
    log.scrollTop = log.scrollHeight;
  },
  async runPipeline() {
    this.ciClock.cancel();
    this.ciClock.paused = false;
    this.ciCtrl.setPlaying(true);
    this.resetPipe();
    put($('#cicd-log'));
    const fail = $('#cicd-fail').checked;
    const vars = { sha: Math.random().toString(16).slice(2, 9), ver: `v1.${this.version + 1}` };
    this.setResult('wait', 'Конвейер запущен…');
    const n = CICD.stages.length;
    try {
      for (let i = 0; i < n; i++) {
        const s = CICD.stages[i];
        this.setStage(i, 'run');
        const lines = (fail && s.failLog) || s.log;
        for (const line of lines) { await this.ciClock.wait(0.5); this.logLine(tpl(line, vars)); }
        await this.ciClock.wait(0.35);
        if (fail && s.failLog) {
          this.setStage(i, 'fail');
          for (let j = i + 1; j < n - 1; j++) this.setStage(j, 'skip');
          this.setResult('bad', `✕ Тест упал — деплой не запускался. На сервере по-прежнему рабочая v1.${this.version}, пользователи ничего не заметили. Чиним тест и делаем новый push.`);
          return;
        }
        this.setStage(i, 'ok');
        // Анимация «ленты конвейера» между этапами
        if (i < n - 1) await this.ciClock.tween(0.6, k => this.conns[i].style.setProperty('--p', k));
      }
      this.version++;
      this.setResult('ok', `✓ Всё зелёное: ${vars.ver} в продакшене примерно через минуту после push — без ручной работы.`);
    } catch (e) { ignoreCancel(e); }
  },
};

/* ---------- 9. Глоссарий ---------- */
const GlossaryScreen = {
  init(root) {
    this.filter = 'all';
    this.items = glossaryItems();
    const used = [...new Set(this.items.map(g => g.layer))];
    const filters = $('#gloss-filters', root);
    const mk = (key, content) => h('button', { class: 'btn sm' + (key === 'all' ? ' selected' : ''), type: 'button', 'data-key': key, onclick: () => {
      this.filter = key;
      $$('#gloss-filters .btn').forEach(b => b.classList.toggle('selected', b.dataset.key === key));
      this.render();
    } }, content);
    filters.append(mk('all', 'Все'), ...used.map(k => mk(k, chip(k))));
    $('#gloss-q', root).addEventListener('input', () => this.render());
    this.render();
  },
  render() {
    const q = $('#gloss-q').value.trim();
    const ql = q.toLowerCase();
    const items = this.items.filter(g => (this.filter === 'all' || g.layer === this.filter)
      && (!ql || (g.term + ' ' + g.def).toLowerCase().includes(ql)));
    const markText = text => {
      if (!q) return [text];
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const out = [];
      let last = 0;
      text.replace(re, (m, idx) => { out.push(text.slice(last, idx), h('mark', { text: m })); last = idx + m.length; return m; });
      out.push(text.slice(last));
      return out;
    };
    const list = $('#gloss-list');
    put(list, ...(items.length ? items.map(g => {
      const si = SCREENS.findIndex(s => s.id === g.screen);
      return h('article', { class: 'term-card', style: `--c: var(--l-${g.layer})` },
        h('h4', {}, markText(g.term)),
        h('p', {}, markText(g.def)),
        g.key ? h('div', { class: 'term-more' }, termPill(g.key, 'Подробное объяснение: ' + TERMS[g.key].abbr)) : null,
        h('div', { class: 'term-meta' }, chip(g.layer, LAYERS[g.layer].name),
          h('a', { href: '#' + g.screen, text: `→ Экран ${si}: ${SCREENS[si].short}` })));
    }) : [h('div', { class: 'gloss-empty', text: 'Ничего не нашлось. Попробуй другое слово или фильтр «Все».' })]));
    $('#gloss-count').textContent = `Показано терминов: ${items.length} из ${this.items.length}`;
  },
};

/* Глоссарий = ручные записи GLOSSARY + все термины словаря TERMS, которых в нём нет.
   Так новый термин в TERMS сам попадает в глоссарий. */
function glossaryItems() {
  const items = GLOSSARY.map(g => ({ ...g, key: TermLinker.keyIn(g.term) || GLOSSARY_TERM[g.term] || null }));
  const covered = new Set(items.map(g => g.key).filter(Boolean));
  for (const [key, t] of Object.entries(TERMS)) {
    if (covered.has(key)) continue;
    items.push({
      term: hasExpansion(key) ? `${t.abbr} (${t.full})` : `${t.abbr} — ${t.ru}`,
      layer: t.layer || 'hw', screen: TERM_HOME[key] || 'protocols', def: t.what, key,
    });
  }
  return items.sort((a, b) => a.term.localeCompare(b.term, 'ru'));
}

/* =====================================================================
   ЭКРАНЫ ВТОРОЙ ВЕРСИИ: «С чего начать», OSI, адреса, TCP/UDP,
   HTTP/TLS/VPN, ввод адреса, терминал, диагностика
   ===================================================================== */

const range = n => Array.from({ length: n }, (_, i) => i + 1);
const screenNum = id => SCREENS.findIndex(s => s.id === id);

// Ссылка-«таблетка» на другой экран: номер + название
function screenLink(id) {
  const i = screenNum(id);
  const sc = SCREENS[i];
  return h('a', { class: 'screen-link', href: '#' + id, 'data-tip': sc.about }, h('span', { class: 'num', text: i }), sc.title);
}

// Проиграть группы полётов (как на экране «Путь запроса»): группы — по очереди, полёты в группе — параллельно
async function playFlights(stage, clock, groups) {
  for (const group of groups || []) {
    await Promise.all(group.map(async f => {
      if (f.delay) await clock.wait(f.delay);
      await stage.fly(f.route, f);
    }));
    await clock.wait(0.2);
  }
}

/* ---------- Пошаговый проигрыватель ----------
   Общая логика «Назад / Далее / Автоплей» для экранов «Адреса» и «Ввод адреса».
   o: { id — экран (для клавиш), clock, steps, stages, progressEl, controlsEl,
        render(step, i) — нарисовать тексты, play(step, i) — async-анимация шага } */
class Stepper {
  constructor(o) {
    this.o = o;
    this.idx = 0;
    this.auto = false;  // автоплей: после шага сам переходит к следующему
    this.done = false;  // анимация текущего шага закончилась
    this.ctrl = makeControls({
      onRestart: () => { this.setAuto(false); this.show(0); },
      onPrev: () => this.go(-1),
      onNext: () => this.go(1),
      onToggle: () => this.toggle(),
      playLabels: ['Автоплей', 'Пауза'],
      playTip: 'Автоплей / пауза (пробел)',
    });
    o.controlsEl.append(this.ctrl.el);
    this.dots = o.steps.map((st, i) => h('button', {
      type: 'button', text: i + 1, 'data-tip': st.title, 'aria-label': `Шаг ${i + 1}: ${st.title}`, onclick: () => this.show(i),
    }));
    o.progressEl.append(...this.dots);
    document.addEventListener('keydown', e => this.onKey(e));
  }
  setAuto(on) { this.auto = on; this.ctrl.setPlaying(on); }
  toggle() {
    if (this.auto) { this.setAuto(false); this.o.clock.paused = true; return; }
    this.setAuto(true);
    this.o.clock.paused = false;
    if (this.done) this.show(this.idx >= this.o.steps.length - 1 ? 0 : this.idx + 1);
  }
  go(delta) {
    const i = this.idx + delta;
    if (i >= 0 && i < this.o.steps.length) this.show(i);
  }
  onKey(e) {
    if (App.current !== this.o.id || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest?.('input, textarea, select')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); this.go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(-1); }
    else if (e.key === ' ' && !e.target.closest?.('button, a')) { e.preventDefault(); this.toggle(); }
  }
  async show(i) {
    const { clock, steps } = this.o;
    clock.cancel();
    (this.o.stages || []).forEach(s => s.reset());
    clock.paused = false;
    this.idx = i;
    this.done = false;
    const st = steps[i];
    this.dots.forEach((b, k) => { b.className = k === i ? 'current' : k < i ? 'done' : ''; });
    this.ctrl.prev.disabled = i === 0;
    this.ctrl.next.disabled = i === steps.length - 1;
    this.o.render(st, i);
    try {
      await clock.wait(0.35);
      await this.o.play(st, i);
      // Время на чтение текста перед автопереходом
      const chars = [].concat(st.text).join(' ').length;
      await clock.wait(Math.max(2.5, chars / 45));
      this.done = true;
      if (this.auto) {
        if (i < steps.length - 1) this.show(i + 1);
        else this.setAuto(false);
      }
    } catch (e) { ignoreCancel(e); }
  }
}

/* ---------- 0. С чего начать ---------- */
const StartScreen = {
  init(root) {
    const item = sc => h('li', {}, h('a', { class: 'route-item', href: '#' + sc.id },
      h('span', { class: 'num', text: screenNum(sc.id) }),
      h('span', { class: 'ri-text' }, h('b', { text: sc.title }), h('span', { text: sc.about })),
      sc.min ? h('span', { class: 'ri-min', text: `~${sc.min} мин` }) : null));
    const total = SCREENS.reduce((s, sc) => s + (sc.id === 'start' ? 0 : sc.min || 0), 0);
    const quick = START.quick.ids.map((id, k) => [k ? h('span', { class: 'flow-arrow', 'aria-hidden': 'true', text: '→' }) : null, screenLink(id)]);
    put($('#start-root', root),
      h('div', { class: 'panel start-hero' },
        h('p', { text: `${START.intro} Весь путь — около ${Math.round(total / 5) * 5} минут.` }),
        h('div', { class: 'btn-row' },
          h('a', { class: 'btn primary', href: '#' + SCREENS[1].id }, 'Начать с экрана 1', icon('next')),
          h('a', { class: 'btn ghost', href: '#glossary' }, icon('book'), 'Открыть глоссарий'))),
      h('div', { class: 'route' }, NAV_GROUPS.map((g, gi) => h('div', { class: 'panel route-group' },
        h('div', { class: 'eyebrow', text: `Раздел ${gi + 1}` }),
        h('h3', { text: g.title }),
        h('p', { class: 'hint', text: g.about }),
        h('ol', { class: 'route-list' }, SCREENS.filter(s => s.group === g.id && s.id !== 'start').map(item))))),
      h('div', { class: 'grid-2' },
        panel(START.quick.title, h('div', { class: 'quick' }, quick), h('p', { class: 'hint', text: START.quick.text })),
        panel('Как пользоваться', h('ul', { class: 'howto' }, START.howto.map(([ic, t]) => h('li', {}, icon(ic), h('span', { text: t })))))),
      h('div', { class: 'panel' },
        h('div', { class: 'small-title', text: 'Цвета слоёв — одинаковые на всех экранах' }),
        h('div', { class: 'legend' }, [...LAYER_STACK, 'dns', 'sec', 'ssh', 'cicd', 'api'].map(k => chip(k, LAYERS[k].name)))));
  },
};

/* ---------- 10. Модели OSI и TCP/IP ---------- */
const OsiScreen = {
  init(root) {
    this.clock = new Clock();
    this.clocks = [this.clock];
    this.osiEls = {};
    this.tcpEls = {};
    this.brackets = {};
    const grid = $('#osi-grid', root);
    this.grid = grid;
    // Левая колонка: 7 уровней OSI (строка сетки 1 = уровень 7)
    OSI.osi.forEach((L, i) => {
      const el = h('button', {
        type: 'button', class: 'osi-cell', style: `--c: var(--l-${L.key}); grid-row: ${i + 1}`, 'data-layer': L.key,
        'aria-label': `Уровень ${L.n} OSI: ${L.name}`, onclick: () => this.select('osi', L.n),
      },
        h('span', { class: 'lnum', text: 'L' + L.n }),
        h('span', { class: 'oname' }, h('b', { text: L.name }), h('small', { text: L.en })),
        h('span', { class: 'ounit', text: L.unit }));
      this.osiEls[L.n] = el;
      grid.append(el);
    });
    // Правая колонка: 4 уровня TCP/IP растянуты на «свои» строки OSI, между ними — скобка того же цвета
    OSI.tcpip.forEach(T => {
      const pos = `grid-row: ${8 - Math.max(...T.osi)} / span ${T.osi.length}`;
      this.brackets[T.id] = h('div', { class: 'osi-bracket', style: `--c: var(--l-${T.key}); ${pos}`, 'aria-hidden': 'true' });
      this.tcpEls[T.id] = h('button', {
        type: 'button', class: 'tcp-cell', style: `--c: var(--l-${T.key}); ${pos}`, 'data-layer': T.key,
        'aria-label': `Уровень TCP/IP: ${T.name}`, onclick: () => this.select('tcp', T.id),
      }, h('b', { text: T.name }), h('small', { text: T.en }), h('span', { class: 'osi-map', text: 'OSI ' + T.osi.join(' + ') }));
      grid.append(this.brackets[T.id], this.tcpEls[T.id]);
    });

    this.ctrl = makeControls({
      onToggle: () => { this.clock.paused = !this.clock.paused; this.ctrl.setPlaying(!this.clock.paused); },
      playLabels: ['Продолжить', 'Пауза'],
    });
    this.ctrl.setPlaying(true);
    $('#osi-controls', root).append(this.ctrl.el);
    $('#osi-run', root).append(
      h('button', { class: 'btn primary sm', type: 'button', onclick: () => this.run('down') }, '↓ Отправка: с 7 до 1'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => this.run('up') }, '↑ Получение: с 1 до 7'));
    this.renderPdu(null, 'Нажми «Отправка», чтобы увидеть, как сообщение обрастает заголовками по пути вниз.');

    $('#osi-lnums', root).append(
      h('div', { class: 'lnums-head' }, icon('layers'), h('b', { text: 'Когда говорят L2, L3, L4, имеются в виду эти уровни' })),
      h('div', { class: 'lnums' }, OSI.lnums.map(([l, name, text]) => {
        const n = +l.slice(1);
        const L = OSI.osi.find(x => x.n === n);
        return h('button', { type: 'button', class: 'lnum-card', style: `--c: var(--l-${L.key})`, onclick: () => {
          this.select('osi', n);
          this.grid.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } }, h('b', { text: l }), h('span', { class: 'ln-name', text: name }), h('span', { text }));
      })));
    $('#osi-facts', root).append(h('div', { class: 'small-title', text: 'Полезно знать' }), h('ul', { class: 'list' }, OSI.facts.map(t => h('li', { text: t }))));
    this.select('osi', 4);
  },

  // Выбрать уровень: kind = 'osi' (n = 1..7) или 'tcp' (id уровня TCP/IP)
  select(kind, id, fromRun = false) {
    if (!fromRun) { this.clock.cancel(); this.ctrl.setPlaying(true); this.clock.paused = false; }
    const all = [...Object.values(this.osiEls), ...Object.values(this.tcpEls), ...Object.values(this.brackets)];
    all.forEach(el => el.classList.remove('sel', 'rel'));
    this.grid.classList.add('has-sel');
    let item, rel;
    if (kind === 'osi') {
      item = OSI.osi.find(L => L.n === id);
      rel = OSI.tcpip.find(T => T.id === item.tcpip);
      this.osiEls[id].classList.add('sel');
      this.tcpEls[rel.id].classList.add('rel');
      this.brackets[rel.id].classList.add('rel');
    } else {
      item = OSI.tcpip.find(T => T.id === id);
      this.tcpEls[id].classList.add('sel');
      this.brackets[id].classList.add('rel');
      item.osi.forEach(n => this.osiEls[n].classList.add('rel'));
    }
    this.renderCard(kind, item, rel);
  },

  renderCard(kind, item, rel) {
    const card = $('#osi-card');
    card.style.setProperty('--c', `var(--l-${item.key})`);
    const isOsi = kind === 'osi';
    const names = isOsi ? '' : item.osi.map(n => OSI.osi.find(L => L.n === n).name.toLowerCase()).join(', ');
    const relation = isOsi
      ? `В модели TCP/IP это часть уровня «${rel.name}».`
      : `В модели OSI это ${item.osi.length > 1 ? 'уровни' : 'уровень'} ${item.osi.join(', ')}: ${names}.`;
    put(card,
      h('div', { class: 'card-top' }, icon(item.devices[0][0], 'icon big'),
        h('div', {},
          h('h3', { text: isOsi ? `L${item.n} · ${item.name}` : `${item.name} (TCP/IP)` }),
          h('div', { class: 'hint', text: isOsi ? `${item.en} · единица данных: ${item.unit}` : item.en }))),
      h('p', { text: item.does }),
      h('div', { class: 'card-sec' }, h('b', { text: 'Протоколы' }), h('div', { class: 'proto-list' }, item.protos.map(p => h('span', { class: 'proto', text: p })))),
      h('div', { class: 'card-sec' }, h('b', { text: 'Устройства и программы' }),
        h('ul', { class: 'dev-list' }, item.devices.map(([ic, t]) => h('li', {}, icon(ic), h('span', { text: t }))))),
      item.example ? h('div', { class: 'card-sec' }, h('b', { text: 'Пример' }), h('code', { class: 'block', text: item.example })) : null,
      item.note ? h('div', { class: 'note', text: item.note }) : null,
      h('div', { class: 'note relation', text: relation }));
  },

  renderPdu(step, text) {
    put($('#osi-pdu'),
      step ? h('div', { class: 'pdu-row' }, step.pdu.map(([k, t]) => h('span', { class: 'pdu-part' + (k === 'http' || k === 'hw' ? ' grow' : ''), style: `--c: var(--l-${k})`, 'data-layer': k, text: t }))) : null,
      h('div', { class: 'hint', text }));
  },

  /* АНИМАЦИЯ ИНКАПСУЛЯЦИИ: уровни подсвечиваются по очереди,
     полоска показывает, как выглядит сообщение после уровня */
  async run(dir) {
    this.clock.cancel();
    this.clock.paused = false;
    this.ctrl.setPlaying(true);
    const seq = dir === 'down' ? OSI.send : [...OSI.send].reverse();
    try {
      for (const s of seq) {
        this.select('osi', s.n, true);
        const L = OSI.osi.find(x => x.n === s.n);
        this.renderPdu(s, `L${s.n} · ${L.name}: ${dir === 'down' ? s.text : s.up}`);
        await this.clock.wait(2.2);
      }
      this.renderPdu(dir === 'down' ? OSI.send[6] : OSI.send[0], dir === 'down'
        ? 'Готово: каждый уровень добавил свой заголовок. У получателя всё пойдёт в обратную сторону.'
        : 'Готово: каждый уровень снял свою обёртку, программа получила данные.');
    } catch (e) { ignoreCancel(e); }
  },
};

/* ---------- 11. Адреса: MAC, IP, порты ---------- */
const AddrScreen = {
  init(root) {
    this.clock = new Clock();      // основной путь пакета
    this.dhcpClock = new Clock();  // мини-блок DHCP
    this.natClock = new Clock();   // мини-блок NAT
    this.clocks = [this.clock, this.dhcpClock, this.natClock];
    this.stage = new Stage($('#addr-svg', root), this.clock, { nodes: ADDR.nodes, links: ADDR.links, zones: ADDR.zones, size: ADDR.size });

    // В данных «same» значит «как на прошлом шаге» — разворачиваем заранее
    let prev = null;
    this.steps = ADDR.steps.map(st => {
      let hdr = st.hdr === 'same' ? prev : { ...st.hdr };
      for (const k of Object.keys(hdr)) if (hdr[k] === 'same') hdr[k] = prev[k];
      prev = hdr;
      return { ...st, hdr };
    });

    // «Конверт»: три строки (MAC, IP, порт) × два столбца (от, кому)
    this.env = {};
    $('#addr-env', root).append(h('div', { class: 'env' },
      h('div'), h('div', { class: 'env-h', text: 'от' }), h('div', { class: 'env-h', text: 'кому' }),
      ADDR.rows.map(([k, label, layer]) => {
        this.env[k + '0'] = h('div', { class: 'env-v' });
        this.env[k + '1'] = h('div', { class: 'env-v' });
        return [h('div', { class: 'env-k' }, chip(layer, label)), this.env[k + '0'], this.env[k + '1']];
      })));
    this.portEls = ADDR.serverPorts.map(([p, prog, what]) => h('div', { class: 'port-row' },
      h('span', { class: 'port', text: p }), h('b', { text: prog }), h('span', { text: what })));
    $('#addr-ports', root).append(...this.portEls);

    $('#addr-cards', root).append(...ADDR.cards.map(c => h('div', { class: 'panel card', style: `--c: var(--l-${c.layer})`, 'data-layer': c.layer },
      h('h4', {}, icon(c.icon), c.title), h('p', { text: c.text }),
      h('ul', {}, c.points.map(p => h('li', { text: p }))),
      h('div', { class: 'analogy', text: 'Аналогия: ' + c.analogy }))));

    this.stepper = new Stepper({
      id: 'addr', clock: this.clock, steps: this.steps, stages: [this.stage],
      progressEl: $('#addr-progress', root), controlsEl: $('#addr-controls', root),
      render: (st, i) => this.render(st, i),
      play: async st => {
        await playFlights(this.stage, this.clock, st.anim);
        for (const id of st.pulse || []) { this.stage.pulse(id); await this.clock.wait(0.5); }
      },
    });
    this.initDhcp(root);
    this.initNat(root);
    this.stepper.show(0);
  },

  render(st, i) {
    put($('#addr-step'),
      h('div', { class: 'step-num', text: `Шаг ${i + 1} из ${this.steps.length}` }),
      h('h3', { text: st.title }),
      paragraphs(st.text));
    for (const [k] of ADDR.rows) {
      for (const side of [0, 1]) {
        const el = this.env[k + side];
        const [value, who] = st.hdr[k][side];
        put(el, h('code', { text: value }), h('small', { text: who }));
        // Подсветка изменившейся клетки: перезапуск CSS-анимации
        el.classList.remove('chg');
        if (st.changed.includes(k + side)) { void el.offsetWidth; el.classList.add('chg'); }
      }
    }
    this.portEls.forEach((el, k) => el.classList.toggle('hl', !!st.port443 && ADDR.serverPorts[k][0] === 443));
    this.stage.setMark('active', st.focus || []);
  },

  /* --- DHCP: четыре сообщения DORA + пример «до и после» --- */
  initDhcp(root) {
    const d = ADDR.dhcp;
    const svg = sv('svg', { role: 'img', 'aria-label': 'Телефон получает IP-адрес по DHCP' });
    this.dhcpLog = h('ol', { class: 'log-list' });
    $('#addr-dhcp', root).append(
      h('p', { class: 'small-text', text: d.lead }),
      h('div', { class: 'split-2' },
        h('div', {},
          h('div', { class: 'stage-wrap mini' }, svg),
          h('div', { class: 'btn-row' }, h('button', { class: 'btn primary sm', type: 'button', onclick: () => this.runDhcp() }, icon('wifi'), 'Подключить телефон к Wi-Fi')),
          this.dhcpLog),
        beforeAfter(BEFORE_AFTER.dhcp)),
      h('p', { class: 'hint', text: d.note }));
    this.dhcpStage = new Stage(svg, this.dhcpClock, { nodes: d.nodes, links: d.links, size: d.size, breakpoint: 400 });
  },
  async runDhcp() {
    const d = ADDR.dhcp, st = this.dhcpStage, c = this.dhcpClock;
    c.cancel();
    st.reset();
    c.paused = false;
    st.setLabel('phone', { sub: 'IP: нет' });
    st.setMark('good', []);
    put(this.dhcpLog);
    try {
      for (const s of d.steps) {
        $$('li', this.dhcpLog).forEach(li => li.classList.remove('now'));
        this.dhcpLog.append(h('li', { class: 'now', text: s.text }));
        await st.fly(s.dir === 'out' ? ['phone', 'router'] : ['router', 'phone'], { layer: 'ip', label: s.label, speed: 170 });
        await c.wait(1);
      }
      st.setLabel('phone', { sub: d.gotIp });
      st.setMark('good', ['phone']);
    } catch (e) { ignoreCancel(e); }
  },

  /* --- NAT подробно: роутер ведёт таблицу «внешний порт → устройство» ---
     Анимация идёт по шагам: каждый запрос по очереди уходит наружу,
     роутер подменяет обратный адрес и добавляет строку в таблицу;
     потом ответы возвращаются и находят своё устройство по этой таблице. */
  initNat(root) {
    const n = ADDR.nat, D = NAT_DETAIL;
    const svg = sv('svg', { role: 'img', 'aria-label': 'NAT: три устройства выходят в интернет через один адрес' });
    this.natRef = {};
    this.natSay = h('div', { class: 'caption', 'aria-live': 'polite' });
    this.natSwap = h('div', { class: 'nat-swap' });
    this.natCtrl = makeControls({
      onRestart: () => this.runNat(), restartTip: 'Запустить заново',
      onToggle: () => { this.natClock.paused = !this.natClock.paused; this.natCtrl.setPlaying(!this.natClock.paused); },
      playLabels: ['Продолжить', 'Пауза'],
    });
    this.natCtrl.setPlaying(true);
    $('#addr-nat', root).append(
      h('p', { class: 'small-text', text: D.lead }),
      h('div', { class: 'nat-layout' },
        h('div', {},
          h('div', { class: 'stage-wrap mini free' }, svg),
          h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => this.runNat() }, icon('play'), 'Все трое идут в интернет')),
          this.natCtrl.el,
          this.natSay),
        h('div', {},
          h('div', { class: 'small-title', text: 'Таблица NAT в роутере' }),
          makeTable(['Внешний порт', 'Устройство', 'Внутренний адрес:порт'], [], this.natRef),
          h('div', { class: 'small-title', style: 'margin-top:14px', text: 'Обратный адрес на пакете' }),
          this.natSwap,
          h('div', { class: 'analogy', text: 'Аналогия: ' + D.analogy }))),
      h('p', { class: 'hint', text: n.note }));
    this.natStage = new Stage(svg, this.natClock, { nodes: n.nodes, links: n.links, size: n.size, breakpoint: 480 });
    this.renderNat([]);
    this.setSwap(null);
    this.natSay.textContent = 'Нажми «Все трое идут в интернет» — роутер начнёт заполнять таблицу.';
  },
  natVars(f) {
    const name = NAT_DETAIL.names[f.dev];
    return { name, Name: name[0].toUpperCase() + name.slice(1), inside: f.inside, outside: f.outside, port: f.outside.split(':')[1] };
  },
  renderNat(rows, hl, fresh) {
    put(this.natRef.tbody, rows.length
      ? rows.map(f => {
        const v = this.natVars(f);
        return h('tr', { class: (f === hl ? 'hl' : '') + (f === fresh ? ' new' : '') },
          h('td', { class: 'mono', text: v.port }), h('td', { text: v.Name }), h('td', { class: 'mono', text: f.inside }));
      })
      : h('tr', {}, h('td', { colspan: 3, class: 'table-empty', text: 'Пока пусто: никто ещё не выходил в интернет.' })));
  },
  // Блок «до / после роутера» для текущего пакета
  setSwap(dir, f, stage) {
    if (!dir) { put(this.natSwap, h('div', { class: 'hint', text: 'Здесь будет видно, как роутер меняет адрес.' })); return; }
    const v = this.natVars(f);
    const row = (label, value, cls) => h('div', { class: 'swap-row ' + cls }, h('span', { text: label }), h('code', { text: value }));
    put(this.natSwap, dir === 'out'
      ? [row('До роутера (от кого):', v.inside, ''), row('После роутера (от кого):', stage === 'after' ? v.outside : '…', stage === 'after' ? 'chg' : '')]
      : [row('Пришёл из интернета (кому):', v.outside, ''), row('Роутер отдал (кому):', stage === 'after' ? v.inside : '…', stage === 'after' ? 'chg' : '')]);
  },
  async runNat() {
    const n = ADDR.nat, T = NAT_DETAIL.text, st = this.natStage, c = this.natClock;
    c.cancel();
    st.reset();
    c.paused = false;
    this.natCtrl.setPlaying(true);
    const rows = [];
    const say = (text, cls = '') => { this.natSay.textContent = text; this.natSay.className = 'caption ' + cls; };
    this.renderNat(rows);
    this.setSwap(null);
    st.setMark('active', []);
    try {
      say(T.intro);
      await c.wait(2);
      // Туда: по одному устройству, чтобы было видно каждую подмену
      for (const f of n.flows) {
        const v = this.natVars(f);
        st.setMark('active', [f.dev]);
        say(tpl(T.out, v));
        this.setSwap('out', f, 'before');
        await st.fly([f.dev, 'router'], { layer: 'app', label: f.short, speed: 150 });
        st.setMark('active', ['router']);
        rows.push(f);
        this.renderNat(rows, f, f);
        this.setSwap('out', f, 'after');
        say(tpl(T.swap, v));
        await c.wait(2.4);
        await st.fly(['router', 'server'], { layer: 'ip', label: f.pub, speed: 170 });
      }
      await c.wait(0.8);
      // Обратно: роутер по порту находит устройство в таблице
      for (const f of n.flows) {
        const v = this.natVars(f);
        st.setMark('active', ['server']);
        await st.fly(['server', 'router'], { layer: 'http', label: f.pub, speed: 170 });
        st.setMark('active', ['router']);
        this.renderNat(rows, f);
        this.setSwap('back', f, 'before');
        say(tpl(T.back, v));
        await c.wait(1.4);
        this.setSwap('back', f, 'after');
        await c.wait(1.2);
        await st.fly(['router', f.dev], { layer: 'http', label: f.short, speed: 150 });
        st.setMark('good', n.flows.slice(0, n.flows.indexOf(f) + 1).map(x => x.dev));
      }
      st.setMark('active', []);
      this.renderNat(rows);
      say(T.done, 'ok');
    } catch (e) { ignoreCancel(e); }
  },
};


/* ---------- 12. TCP против UDP ---------- */
const TcpUdpScreen = {
  init(root) {
    this.clock = new Clock();
    this.clocks = [this.clock];
    this.lose = new Set([3]);             // какие пакеты потерять заранее
    this.kill = { tcp: false, udp: false }; // «потерять следующий» по кнопке
    this.running = false;
    this.lanes = {};
    for (const kind of ['tcp', 'udp']) this.lanes[kind] = this.buildLane(kind, $('#tu-' + kind, root));

    this.loseBtns = range(TU.count).map(n => h('button', { class: 'btn sm num-btn', type: 'button', text: n, onclick: () => this.toggleLose(n) }));
    this.killBtn = h('button', { class: 'btn danger', type: 'button', 'data-tip': 'Следующий пакет в каждом канале пропадёт на полпути', onclick: () => this.killNext() }, '✕ Потерять пакет сейчас');
    this.ctrl = makeControls({
      onRestart: () => this.run(), restartTip: 'Отправить заново',
      onToggle: () => { this.clock.paused = !this.clock.paused; this.ctrl.setPlaying(!this.clock.paused); },
      playLabels: ['Продолжить', 'Пауза'],
    });
    this.ctrl.setPlaying(true);
    $('#tu-toolbar', root).append(
      h('div', { class: 'tu-tools' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => this.run() }, icon('play'), `Отправить ${TU.count} пакетов`),
        this.killBtn,
        h('div', { class: 'btn-row' },
          h('span', { class: 'hint-inline', text: 'Заранее потерять №' }), this.loseBtns,
          h('button', { class: 'btn sm', type: 'button', 'data-tip': 'Выбрать один случайный пакет и сразу отправить', onclick: () => this.randomLose() }, '🎲 Случайный'),
          h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { this.lose.clear(); this.renderLose(); } }, 'Без потерь'))),
      this.ctrl.el);
    this.renderLose();

    const uses = kind => h('div', { class: 'use-col', style: `--c: var(--l-tcp)` },
      h('h4', {}, chip('tcp', TU[kind].title, kind === 'udp' ? 'UDP — транспортный уровень без гарантий доставки' : null)),
      h('ul', { class: 'list' }, TU[kind].uses.map(u => h('li', { text: u }))),
      h('p', { class: 'hint', text: TU[kind].why }));
    $('#tu-uses', root).append(h('div', { class: 'small-title', text: 'Где что применяется' }), h('div', { class: 'uses' }, uses('tcp'), uses('udp')));
    $('#tu-compare', root).append(makeTable(['', 'TCP', 'UDP'], TU.compare.map(([k, a, b]) => h('tr', {}, h('th', { text: k }), h('td', { text: a }), h('td', { text: b })))));
    $('#tu-note', root).textContent = TU.note;
    this.run();
  },

  buildLane(kind, box) {
    const T = TU[kind];
    const svg = sv('svg', { role: 'img', 'aria-label': `Канал ${T.title}` });
    const L = { kind, box, got: new Set(), lost: new Set(), sent: 0, losses: 0 };
    L.slots = range(TU.count).map(n => h('div', { class: 'slot', text: n }));
    L.cnt = { sent: h('b', { text: 0 }), got: h('b', { text: 0 }), lost: h('b', { text: 0 }) };
    L.delivered = h('div', { class: 'lane-delivered' });
    L.caption = h('div', { class: 'lane-caption' });
    box.append(
      h('div', { class: 'lane-head' }, chip('tcp', T.title, kind === 'udp' ? 'UDP — транспортный уровень без гарантий доставки' : null), h('span', { class: 'hint-inline', text: T.sub })),
      h('div', { class: 'stage-wrap' }, svg),
      h('div', { class: 'small-title', text: 'Получатель собрал' }),
      h('div', { class: 'slots' }, L.slots),
      L.delivered,
      h('div', { class: 'fw-counters' },
        h('div', { class: 'counter' }, L.cnt.sent, 'отправлено'),
        h('div', { class: 'counter ok' }, L.cnt.got, 'доставлено'),
        h('div', { class: 'counter bad' }, L.cnt.lost, 'потеряно в сети')),
      L.caption);
    L.stage = new Stage(svg, this.clock, { nodes: TU.nodes, links: [], size: TU.size, breakpoint: 480, onRender: st => this.drawPaths(st, kind) });
    return L;
  },

  // Пунктирные «дорожки»: данные — по верхней дуге, подтверждения — по нижней
  drawPaths(st, kind) {
    const m = TU.mid[st.layout], a = st.xy('snd'), b = st.xy('rcv');
    const path = (p, cls) => sv('polyline', { class: 'lane-path ' + cls, points: `${a.x},${a.y} ${p.x},${p.y} ${b.x},${b.y}` });
    st.gExtra.append(path(m.data, 'data'), sv('text', { class: 'lane-label', x: m.data.x, y: m.data.y - 14, text: 'данные →' }));
    if (kind === 'tcp') st.gExtra.append(path(m.ack, 'ack'), sv('text', { class: 'lane-label', x: m.ack.x, y: m.ack.y + 22, text: '← подтверждения (ACK)' }));
  },

  toggleLose(n) {
    if (this.lose.has(n)) this.lose.delete(n); else this.lose.add(n);
    this.renderLose();
  },
  randomLose() {
    this.lose = new Set([1 + Math.floor(Math.random() * TU.count)]);
    this.renderLose();
    this.run();
  },
  renderLose() {
    this.loseBtns.forEach((b, i) => {
      const on = this.lose.has(i + 1);
      b.classList.toggle('selected', on);
      b.setAttribute('aria-pressed', String(on));
    });
  },
  killNext() {
    if (!this.running) return;
    this.kill = { tcp: true, udp: true };
    this.updateKill();
  },
  updateKill() {
    this.killBtn.disabled = !this.running;
    this.killBtn.classList.toggle('on', this.kill.tcp || this.kill.udp);
  },

  say(L, text, cls = '') { L.caption.textContent = text; L.caption.className = 'lane-caption ' + cls; },
  renderLane(L) {
    L.slots.forEach((s, i) => {
      const n = i + 1;
      const state = L.got.has(n) ? 'filled' : L.lost.has(n) ? (L.kind === 'tcp' ? 'wait' : 'lost') : '';
      s.className = 'slot ' + state;
      s.textContent = state === 'lost' ? '✕' : state === 'wait' ? '?' : n;
    });
    L.cnt.sent.textContent = L.sent;
    L.cnt.got.textContent = L.got.size;
    L.cnt.lost.textContent = L.losses;
    if (L.kind === 'tcp') {
      // TCP отдаёт программе только непрерывное начало: 1, 2, 3… без дыр
      let k = 0;
      while (L.got.has(k + 1)) k++;
      L.delivered.textContent = k === 0 ? 'Программе пока ничего не отдано.'
        : `Программе отдано по порядку: 1–${k}` + (k < TU.count && L.got.size > k ? ` (пакеты после ${k + 1} ждут в буфере, пока не придёт ${k + 1})` : '');
    } else {
      const got = range(TU.count).filter(n => L.got.has(n));
      L.delivered.textContent = got.length ? `Программе отдано сразу, как пришли: ${got.join(', ')}` : 'Программе пока ничего не отдано.';
    }
  },

  // Полёт по дорожке канала: 'data' — к получателю, 'ack' — обратно
  flyLane(L, path, label) {
    const m = TU.mid[L.stage.layout];
    const route = path === 'data' ? ['snd', m.data, 'rcv'] : ['rcv', m.ack, 'snd'];
    return L.stage.fly(route, { layer: 'tcp', label, speed: 260 });
  },

  /* Один пакет: летит до середины → там решается, потерян ли он →
     либо красный крестик, либо долетает до получателя. Возвращает true, если дошёл. */
  async hop(L, n, retry) {
    const m = TU.mid[L.stage.layout];
    const label = retry ? n + '↻' : String(n);
    const dot = await L.stage.fly(['snd', m.data], { layer: 'tcp', label, keep: true, speed: 210 });
    const byKill = this.kill[L.kind];
    if (byKill) { this.kill[L.kind] = false; this.updateKill(); }
    const lost = byKill || (!retry && this.lose.has(n));
    dot.remove();
    if (lost) {
      L.losses++;
      L.lost.add(n);
      L.stage.cross(TU.mid[L.stage.layout].data);
      this.renderLane(L);
      return false;
    }
    await L.stage.fly([m.data, 'rcv'], { layer: 'tcp', label, speed: 210 });
    return true;
  },

  async run() {
    this.clock.cancel();
    this.clock.paused = false;
    this.ctrl.setPlaying(true);
    const token = this.token = {};
    for (const L of Object.values(this.lanes)) {
      L.stage.reset();
      L.got = new Set(); L.lost = new Set(); L.sent = 0; L.losses = 0;
      L.t0 = this.clock.time;
      this.renderLane(L);
    }
    this.kill = { tcp: false, udp: false };
    this.running = true;
    this.updateKill();
    try {
      await Promise.all([this.runTcp(), this.runUdp()]);
    } catch (e) { ignoreCancel(e); }
    if (this.token === token) { this.running = false; this.updateKill(); }
  },

  async runTcp() {
    const L = this.lanes.tcp, c = this.clock;
    this.say(L, 'Рукопожатие: SYN → SYN-ACK → ACK. Данных ещё нет.');
    await this.flyLane(L, 'data', 'SYN');
    await this.flyLane(L, 'ack', 'SYN-ACK');
    await this.flyLane(L, 'data', 'ACK');
    this.say(L, 'Соединение открыто. Шлю пакеты и жду подтверждение на каждый.');
    await Promise.all(range(TU.count).map(async (n, i) => {
      await c.wait(i * 0.55);
      for (let attempt = 0; ; attempt++) {
        L.sent++;
        this.renderLane(L);
        if (await this.hop(L, n, attempt > 0)) break;
        this.say(L, `Пакет ${n} потерялся. Подтверждения нет — жду таймер…`, 'bad');
        await c.wait(1.6);
        this.say(L, `Таймер истёк: отправляю пакет ${n} ещё раз.`);
      }
      L.got.add(n);
      this.renderLane(L);
      await this.flyLane(L, 'ack', 'ACK ' + n);
    }));
    const t = (c.time - L.t0).toFixed(1).replace('.', ',');
    this.say(L, `Готово за ${t} с: доставлено ${L.got.size} из ${TU.count}, всё по порядку. Ушло пакетов: ${L.sent}${L.losses ? `, из них повторов: ${L.losses}` : ''}.`, 'ok');
  },

  async runUdp() {
    const L = this.lanes.udp, c = this.clock;
    this.say(L, 'Без рукопожатия: пакеты летят сразу, один за другим.');
    await Promise.all(range(TU.count).map(async (n, i) => {
      await c.wait(i * 0.4);
      L.sent++;
      this.renderLane(L);
      if (await this.hop(L, n, false)) { L.got.add(n); this.renderLane(L); }
    }));
    const t = (c.time - L.t0).toFixed(1).replace('.', ',');
    const lost = range(TU.count).filter(n => L.lost.has(n));
    if (lost.length) this.say(L, `Готово за ${t} с. Потеряно: ${lost.join(', ')}. UDP об этом даже не узнал: программа получила данные с дырой.`, 'bad');
    else this.say(L, `Готово за ${t} с. В этот раз ничего не потерялось, но гарантий не было.`, 'ok');
  },
};

/* ---------- 13. HTTP, TLS и VPN ---------- */
const WebScreen = {
  init(root) {
    this.tlsClock = new Clock();
    this.vpnClock = new Clock();
    this.clocks = [this.tlsClock, this.vpnClock];
    this.tabBtns = WEB.tabs.map(([id, label, key]) => h('button', {
      class: 'tab', type: 'button', role: 'tab', id: 'tab-' + id, 'aria-controls': 'web-' + id, 'aria-selected': 'false',
      style: `--c: var(--l-${key})`, onclick: () => this.tab(id),
    }, label));
    $('#web-tabs', root).append(...this.tabBtns);
    this.initHttp($('#web-http', root));
    this.initTls($('#web-tls', root));
    this.initVpn($('#web-vpn', root));
    this.tab('http');
  },
  tab(id) {
    WEB.tabs.forEach(([t], i) => {
      const on = t === id;
      this.tabBtns[i].classList.toggle('selected', on);
      this.tabBtns[i].setAttribute('aria-selected', String(on));
      $('#web-' + t).hidden = !on;
    });
    // Анимации вкладок запускаются при первом показе
    if (id === 'tls' && !this.tlsStarted) { this.tlsStarted = true; this.runTls(); }
    if (id === 'vpn' && !this.vpnStarted) { this.vpnStarted = true; this.runVpn(); }
  },

  /* --- HTTP --- */
  initHttp(box) {
    const H = WEB.http;
    const codeColor = code => code.startsWith('2') ? 'var(--ok)' : code.startsWith('3') ? 'var(--accent)' : code.startsWith('4') ? 'var(--warn)' : 'var(--bad)';
    const req = h('pre', { class: 'code' }), res = h('pre', { class: 'code' }), note = h('div', { class: 'status' });
    const pgBtns = H.playground.map(p => h('button', { class: 'btn sm mono-btn', type: 'button', text: p.btn, onclick: () => show(p) }));
    const show = p => {
      pgBtns.forEach((b, i) => b.classList.toggle('selected', H.playground[i] === p));
      req.innerHTML = highlight(p.req, 'http');
      res.innerHTML = highlight(p.res, 'http');
      const code = p.res.split(' ')[1];
      note.className = 'status ' + (code.startsWith('2') || code.startsWith('3') ? 'ok' : 'bad');
      note.textContent = `${code}: ${p.note}`;
    };
    box.append(
      h('div', { class: 'grid-2 first' }, H.methods.map(m => h('div', { class: 'panel card', style: '--c: var(--l-http)' },
        h('h4', {}, h('span', { class: 'method-badge', text: m.m }), m.title.split(' — ')[1]),
        h('p', { text: m.text }),
        h('p', { class: 'hint', text: 'Например: ' + m.use }),
        h('pre', { class: 'code', html: highlight(m.code, 'http') })))),
      h('div', { class: 'grid-2' },
        h('div', { class: 'panel' },
          h('div', { class: 'small-title', text: 'Популярные коды ответа' }),
          makeTable(['Код', 'Что значит', 'Пример'], H.statuses.map(([c, name, what, ex]) => h('tr', {},
            h('td', { class: 'mono', style: `color:${codeColor(c)};font-weight:700;white-space:nowrap`, text: `${c} ${name}` }), h('td', { text: what }), h('td', { text: ex })))),
          h('p', { class: 'hint', text: H.more })),
        h('div', { class: 'panel' },
          h('div', { class: 'small-title', text: 'Попробуй: отправь запрос' }),
          h('div', { class: 'btn-row' }, pgBtns),
          h('div', { class: 'pg-codes' }, h('div', {}, h('div', { class: 'payload-title', text: 'Запрос' }), req), h('div', {}, h('div', { class: 'payload-title', text: 'Ответ' }), res)),
          note)),
      h('div', { class: 'panel' },
        h('div', { class: 'small-title', text: 'Заголовки: служебные строки «ключ: значение»' }),
        h('div', { class: 'grid-2 tight' },
          h('div', {}, h('div', { class: 'payload-title', text: 'Заголовки запроса' }), h('pre', { class: 'code', html: highlight(H.headersReq, 'http') })),
          h('div', {}, h('div', { class: 'payload-title', text: 'Заголовки ответа' }), h('pre', { class: 'code', html: highlight(H.headersRes, 'http') }))),
        h('dl', { class: 'hdr-notes' }, H.headerNotes.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]))));
    show(H.playground[0]);
  },

  /* --- TLS --- */
  initTls(box) {
    const T = WEB.tls;
    const svg = sv('svg', { role: 'img', 'aria-label': 'TLS-рукопожатие между браузером и сервером' });
    this.tlsBar = h('div', { class: 'mini-bar' });
    this.tlsLog = h('ol', { class: 'log-list' });
    this.mitm = h('input', { type: 'checkbox', class: 'toggle' });
    this.mitm.addEventListener('change', () => this.runTls());
    this.tlsCtrl = makeControls({
      onRestart: () => this.runTls(), restartTip: 'Повторить рукопожатие',
      onToggle: () => { this.tlsClock.paused = !this.tlsClock.paused; this.tlsCtrl.setPlaying(!this.tlsClock.paused); },
      playLabels: ['Продолжить', 'Пауза'],
    });
    this.certRows = {};
    this.cert = h('dl', { class: 'fields cert' }, T.cert.map(([k, v]) => {
      this.certRows[k] = h('dd', { text: v });
      return [h('dt', { text: k }), this.certRows[k]];
    }));
    this.chainEls = T.chain.map(([name, what]) => h('li', {}, icon('lock'), h('b', { text: name }), h('span', { text: what })));
    box.append(h('div', { class: 'tls-layout' },
      h('div', { class: 'panel' },
        this.tlsBar,
        h('div', { class: 'stage-wrap' }, svg),
        h('div', { class: 'btn-row' }, h('label', { class: 'toggle-label' }, this.mitm, h('span', { text: T.mitm.label }))),
        this.tlsCtrl.el,
        h('div', { class: 'small-title', style: 'margin-top:14px', text: 'Что происходит' }),
        this.tlsLog),
      h('div', { class: 'side-col' },
        h('div', { class: 'panel', style: '--c: var(--l-tls)' }, h('div', { class: 'small-title', text: 'Сертификат сервера' }), this.cert),
        panel('Цепочка доверия: от сайта до корня', h('ol', { class: 'chain' }, [...this.chainEls].reverse())),
        h('div', { class: 'panel' },
          h('div', { class: 'small-title', text: 'Что значит замочек 🔒' }),
          h('ul', { class: 'list yes' }, T.lockYes.map(t => h('li', { text: t }))),
          h('div', { class: 'small-title', style: 'margin-top:12px', text: 'Чего замочек НЕ значит' }),
          h('ul', { class: 'list no' }, T.lockNo.map(t => h('li', { text: t })))))));
    this.tlsStage = new Stage(svg, this.tlsClock, { nodes: T.nodes, links: T.links, size: T.size, breakpoint: 440 });
    this.setTlsBar('idle');
  },
  setTlsBar(state) {
    const m = WEB.tls.mitm;
    const map = {
      idle: [icon('globe'), 'https://example.com', ''],
      wait: [icon('globe'), 'https://example.com — устанавливаю защищённое соединение…', ''],
      ok:   [icon('lock'), 'https://example.com — соединение защищено', 'ok'],
      bad:  [h('b', { text: '⚠' }), `Подключение не защищено · ${m.err}`, 'bad'],
    }[state];
    put(this.tlsBar, map[0], h('span', { text: map[1] }));
    this.tlsBar.className = 'mini-bar ' + map[2];
  },
  async runTls() {
    const T = WEB.tls, c = this.tlsClock, st = this.tlsStage;
    c.cancel();
    st.reset();
    c.paused = false;
    this.tlsCtrl.setPlaying(true);
    const fake = this.mitm.checked;
    put(this.tlsLog);
    this.setTlsBar('wait');
    this.cert.classList.add('empty');
    this.cert.classList.remove('fake');
    this.certRows['Кем выдан'].textContent = T.cert.find(r => r[0] === 'Кем выдан')[1];
    this.chainEls.forEach(li => li.classList.remove('ok', 'bad'));
    st.setMark('bad', []);
    st.setMark('good', []);
    st.setLabel('server', { sub: fake ? 'на самом деле — подмена' : '' });
    const log = (text, cls = '') => {
      $$('li', this.tlsLog).forEach(li => li.classList.remove('now'));
      this.tlsLog.append(h('li', { class: 'now ' + cls, text }));
    };
    try {
      for (const s of T.steps) {
        if (s.check) {
          // Проверка сертификата: цепочка подсвечивается снизу вверх
          log(fake ? T.mitm.text : s.text, fake ? 'bad' : '');
          for (const li of this.chainEls.slice().reverse()) {
            await c.wait(0.5);
            li.classList.add(fake ? 'bad' : 'ok');
            if (fake) break;
          }
          await c.wait(0.8);
          if (fake) { st.setMark('bad', ['server']); this.setTlsBar('bad'); return; }
          continue;
        }
        log(s.text);
        await st.fly(s.dir === 'out' ? ['browser', 'server'] : ['server', 'browser'], { layer: 'tls', label: s.label, speed: 230 });
        if (s.cert) {
          this.cert.classList.remove('empty');
          if (fake) { this.cert.classList.add('fake'); this.certRows['Кем выдан'].textContent = '«Free Wi-Fi CA» — нет в списке доверенных'; }
        }
        if (s.lock) { this.setTlsBar('ok'); st.setMark('good', ['server']); }
        await c.wait(0.9);
      }
      log('Зашифрованный разговор: снаружи видны только байты-шум.');
      await st.fly(['browser', 'server'], { layer: 'http', label: 'GET 🔒', speed: 190 });
      await st.fly(['server', 'browser'], { layer: 'http', label: '200 🔒', speed: 190 });
    } catch (e) { ignoreCancel(e); }
  },

  /* --- VPN --- */
  initVpn(box) {
    const V = WEB.vpn;
    const svg = sv('svg', { role: 'img', 'aria-label': 'Путь пакета без VPN и с VPN' });
    this.vpnOn = h('input', { type: 'checkbox', class: 'toggle' });
    this.leakOn = h('input', { type: 'checkbox', class: 'toggle', disabled: true });
    this.vpnOn.addEventListener('change', () => { this.leakOn.disabled = !this.vpnOn.checked; if (!this.vpnOn.checked) this.leakOn.checked = false; this.runVpn(); });
    this.leakOn.addEventListener('change', () => this.runVpn());
    this.vpnCtrl = makeControls({
      onToggle: () => { this.vpnClock.paused = !this.vpnClock.paused; this.vpnCtrl.setPlaying(!this.vpnClock.paused); },
      playLabels: ['Продолжить', 'Пауза'],
    });
    this.vpnCtrl.setPlaying(true);
    this.vpnCaption = h('div', { class: 'caption' });
    this.whoRef = {};
    box.append(
      h('div', { class: 'panel stage-wrap' },
        h('div', { class: 'btn-row' },
          h('label', { class: 'toggle-label' }, this.vpnOn, h('span', { text: 'VPN включён' })),
          h('label', { class: 'toggle-label' }, this.leakOn, h('span', { text: 'Утечка DNS (запросы мимо туннеля)' }))),
        svg, this.vpnCaption, this.vpnCtrl.el),
      h('div', { class: 'grid-2' },
        h('div', { class: 'panel' }, h('div', { class: 'small-title', text: 'Кто что видит' }), makeTable(['Кто', 'Что видит'], [], this.whoRef)),
        panel('Важно про VPN', h('ul', { class: 'list' }, V.points.map(t => h('li', { text: t }))))));
    this.vpnStage = new Stage(svg, this.vpnClock, { nodes: V.nodes, links: V.links, size: V.size, breakpoint: 560 });
  },
  async runVpn() {
    const V = WEB.vpn, c = this.vpnClock, st = this.vpnStage;
    c.cancel();
    st.reset();
    c.paused = false;
    this.vpnCtrl.setPlaying(true);
    const on = this.vpnOn.checked, leak = on && this.leakOn.checked;
    const mode = !on ? 'off' : leak ? 'leak' : 'on';
    // Туннель рисуется толстой фиолетовой линией, неиспользуемые узлы и линии приглушаются
    st.setMark('tun', on ? ['v-lap', 'v-tun'] : []);
    st.setMark('dim', !on ? ['vpn', 'v-tun', 'v-out'] : leak ? ['v-direct'] : ['v-direct', 'ispdns', 'v-dns']);
    put(this.whoRef.tbody, V.who.map(w => h('tr', { class: mode === 'leak' && w.leak !== w.on ? 'bad-row' : '' }, h('th', { text: w.who }), h('td', { text: w[mode] }))));
    this.vpnCaption.textContent = {
      off: 'Без VPN: DNS-запрос идёт к DNS провайдера, сам запрос — прямо к сайту. Провайдер видит, куда ты ходишь.',
      on: 'С VPN: всё — и DNS, и запросы — уходит в зашифрованный туннель до VPN-сервера, а уже он идёт к сайту.',
      leak: 'Утечка DNS: запросы к сайту идут через туннель, но DNS-запрос ушёл к провайдеру напрямую. Имя сайта он видит.',
    }[mode];
    const sp = 190;
    try {
      for (;;) {
        // 1) DNS
        if (on && !leak) {
          await st.fly(['laptop', 'isp', 'vpn'], { layer: 'tls', label: '🔒 DNS?', speed: sp });
          await st.fly(['vpn', 'isp', 'laptop'], { layer: 'tls', label: '🔒 IP', speed: sp });
        } else {
          await st.fly(['laptop', 'isp', 'ispdns'], { layer: 'dns', label: 'example.com?', speed: sp });
          await st.fly(['ispdns', 'isp', 'laptop'], { layer: 'dns', label: 'IP', speed: sp });
        }
        // 2) Запрос и ответ
        if (on) {
          await st.fly(['laptop', 'isp', 'vpn'], { layer: 'tls', label: '🔒 туннель', speed: sp });
          await st.fly(['vpn', 'site'], { layer: 'http', label: 'HTTPS', speed: sp });
          await st.fly(['site', 'vpn'], { layer: 'http', label: 'HTTPS', speed: sp });
          await st.fly(['vpn', 'isp', 'laptop'], { layer: 'tls', label: '🔒 туннель', speed: sp });
        } else {
          await st.fly(['laptop', 'isp', 'site'], { layer: 'http', label: 'HTTPS', speed: sp });
          await st.fly(['site', 'isp', 'laptop'], { layer: 'http', label: 'HTTPS', speed: sp });
        }
        await c.wait(1.5);
      }
    } catch (e) { ignoreCancel(e); }
  },
};

/* ---------- 14. Что происходит, когда вводишь адрес сайта ---------- */
const UrlScreen = {
  init(root) {
    this.clock = new Clock();
    this.clocks = [this.clock];
    this.stage = new Stage($('#url-svg', root), this.clock, { nodes: URL_SCENE.nodes, links: URL_SCENE.links, size: URL_SCENE.size, breakpoint: 560 });
    this.buildBrowser($('#url-browser', root));
    this.cells = {};
    $('#url-layers', root).append(...URL_SCENE.cells.map(([k, name, lvl, tip]) => {
      this.cells[k] = h('div', { class: 'layer-cell', style: `--c: var(--l-${k})`, 'data-layer': k, 'data-tip': tip || LAYERS[k].desc }, h('b', { text: name }), h('span', { text: lvl }));
      return this.cells[k];
    }));
    this.stepper = new Stepper({
      id: 'url', clock: this.clock, steps: URL_STEPS, stages: [this.stage],
      progressEl: $('#url-progress', root), controlsEl: $('#url-controls', root),
      render: (st, i) => this.render(st, i),
      play: (st, i) => this.play(st, i),
    });
    this.stepper.ctrl.play.classList.add('pulse-hint');
    this.stepper.ctrl.play.addEventListener('click', () => this.stepper.ctrl.play.classList.remove('pulse-hint'));
    this.stepper.show(0);
  },

  // Макет браузера: адресная строка, полоса загрузки, страница, строка состояния
  buildBrowser(box) {
    const b = this.br = {};
    b.root = h('div', { class: 'browser p-blank' },
      h('div', { class: 'br-bar' },
        h('span', { class: 'br-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
        h('div', { class: 'br-url' }, icon('lock', 'icon br-lock'), b.url = h('span', { class: 'br-text' }), b.caret = h('span', { class: 'cursor' }))),
      b.progress = h('div', { class: 'br-progress' }, h('div')),
      h('div', { class: 'br-page' },
        h('div', { class: 'br-spinner', 'aria-hidden': 'true' }),
        h('div', { class: 'br-doc' },
          h('h1', { text: 'Example Domain' }),
          h('p', { text: 'Этот домен зарезервирован для примеров в документации. Им можно пользоваться без разрешения.' }),
          h('p', {}, h('span', { class: 'br-link', text: 'Подробнее…' })))),
      b.status = h('div', { class: 'br-status' }));
    box.append(b.root);
  },
  setPage(page) {
    this.br.root.classList.remove('p-blank', 'p-loading', 'p-html', 'p-done');
    this.br.root.classList.add('p-' + page);
  },
  setLock(on) { this.br.root.classList.toggle('secure', on); },
  setProgress(k) { this.br.progress.firstChild.style.width = Math.round(k * 100) + '%'; },

  render(st, i) {
    // Состояние браузера к началу шага = как он выглядел после предыдущего
    const before = i ? URL_STEPS[i - 1].browser.page : 'blank';
    this.br.url.textContent = st.type ? '' : URL_SCENE.url;
    this.br.caret.hidden = !st.type;
    this.setLock(URL_STEPS.slice(0, i).some(s => s.lock));
    this.setPage(before === 'done' ? 'loading' : before);
    this.br.status.textContent = st.browser.status;
    this.setProgress(i / URL_STEPS.length);

    this.cacheItems = st.cache ? st.cache.map(([what]) => h('li', {}, h('span', { text: what }), h('b', { class: 'pending', text: 'проверяю…' }))) : null;
    put($('#url-step'),
      h('div', { class: 'step-num', text: `Шаг ${i + 1} из ${URL_STEPS.length}` }),
      h('h3', { text: st.title }),
      paragraphs(st.text),
      this.cacheItems ? h('ul', { class: 'cache-check' }, this.cacheItems) : null,
      h('div', { class: 'see-also' }, h('span', { text: 'Подробнее:' }), st.links.map(screenLink)));
    put($('#url-payload'),
      h('div', { class: 'payload-title', text: `Что сейчас идёт по сети · ${st.payload.title}` }),
      h('pre', { class: 'code', html: highlight(st.payload.code, st.payload.lang) }));
    for (const [k, c] of Object.entries(this.cells)) c.classList.toggle('on', st.layers.includes(k));
    this.stage.setMark('active', st.focus || []);
  },

  async play(st, i) {
    const c = this.clock;
    if (st.type) {
      // Набор адреса по буквам
      for (const ch of 'example.com') { this.br.url.textContent += ch; await c.wait(0.09); }
      await c.wait(0.4);
      this.br.url.textContent = URL_SCENE.url;
      this.br.caret.hidden = true;
    }
    if (st.cache) {
      for (const [k, li] of this.cacheItems.entries()) {
        await c.wait(0.55);
        const b = $('b', li);
        b.textContent = '✕ ' + st.cache[k][1];
        b.className = 'miss';
      }
      await c.wait(0.3);
    }
    // Путь здесь длинный, поэтому пакеты летят быстрее обычного (если в шаге не задано иное)
    await playFlights(this.stage, c, (st.anim || []).map(g => g.map(f => ({ speed: 380, ...f }))));
    if (st.lock) this.setLock(true);
    if (st.render) {
      // Отрисовка: сначала «голый» HTML, потом со стилями
      this.setPage('html');
      this.br.status.textContent = 'Получен HTML, загружаю стили и скрипты…';
      await c.wait(1.2);
      this.setPage('done');
      this.br.status.textContent = st.browser.status;
    } else {
      this.setPage(st.browser.page);
    }
    this.setProgress((i + 1) / URL_STEPS.length);
  },
};

/* ---------- 15. Потрогай сам: ping, traceroute, nslookup ---------- */
const TerminalScreen = {
  init(root) {
    this.clock = new Clock();
    this.clocks = [this.clock];
    this.busy = false;
    this.stage = new Stage($('#term-svg', root), this.clock, { nodes: TERM.nodes, links: TERM.links, size: TERM.size, breakpoint: 560 });
    this.body = $('#term-body', root);
    this.explain = $('#term-explain', root);
    this.input = $('#term-in', root);
    this.osBtns = TERM.os.map(([id, label]) => {
      const b = h('button', { class: 'btn sm', type: 'button', 'aria-pressed': 'false', onclick: () => this.setOs(id) }, label);
      b.dataset.os = id;
      return b;
    });
    $('#term-os', root).append(...this.osBtns);
    this.cmdBtns = Object.keys(TERM.commands).map(k => h('button', { class: 'btn sm cmd-btn', type: 'button', onclick: () => this.exec(k) }));
    $('#term-cmds', root).append(...this.cmdBtns);
    $('#term-form', root).addEventListener('submit', e => {
      e.preventDefault();
      const v = this.input.value;
      this.input.value = '';
      this.typed(v);
    });
    this.ctrl = makeControls({
      onToggle: () => { this.clock.paused = !this.clock.paused; this.ctrl.setPlaying(!this.clock.paused); },
      playLabels: ['Продолжить', 'Пауза'],
    });
    this.ctrl.setPlaying(true);
    $('#term-controls', root).append(this.ctrl.el);
    $('#term-howto', root).append(h('div', { class: 'small-title', text: 'Как запустить на настоящем компьютере' }),
      h('div', { class: 'howto-os' }, TERM.howto.map(o => h('div', {},
        h('b', { text: o.os }),
        h('p', { class: 'small-text', text: o.open }),
        h('ul', { class: 'list' }, o.cmds.map(([cmd, note]) => h('li', {}, h('code', { text: cmd }), note ? ` — ${note}` : null)))))));
    $('#term-warn', root).append(h('div', { class: 'small-title', text: 'Важно знать' }), h('ul', { class: 'list' }, TERM.warn.map(t => h('li', { text: t }))));
    this.setOs('win');
  },

  setOs(os) {
    this.clock.cancel();
    this.stage.reset();
    this.busy = false;
    this.os = os;
    this.osBtns.forEach(b => { const on = b.dataset.os === os; b.classList.toggle('selected', on); b.setAttribute('aria-pressed', String(on)); });
    Object.keys(TERM.commands).forEach((k, i) => { this.cmdBtns[i].textContent = TERM.commands[k].cmd[os]; });
    $('#term-prompt').textContent = TERM.prompt[os];
    $('#term-title').textContent = os === 'win' ? 'Командная строка (cmd)' : 'Терминал';
    put(this.body, h('div', { class: 'sys', text: os === 'win'
      ? 'Microsoft Windows · имитация командной строки. Нажми кнопку с командой или набери её ниже. help — список команд.'
      : 'Имитация терминала macOS / Linux. Нажми кнопку с командой или набери её ниже. help — список команд.' }));
    put(this.explain, h('p', { class: 'ex-what', text: 'Здесь появится разбор каждой строки вывода. Нажми на строку в терминале, чтобы найти её разбор.' }));
    this.caption('Схема пути: ты → роутер → провайдер → магистраль → сервер. Справа сверху — DNS-сервер.');
    this.updateBtns();
  },
  caption(text) { $('#term-caption').textContent = text; },
  updateBtns() { this.cmdBtns.forEach(b => { b.disabled = this.busy; }); },
  scroll() { this.body.scrollTop = this.body.scrollHeight; },
  print(text, cls = '') {
    const el = h('div', { class: 'out-line ' + cls, text });
    this.body.append(el);
    this.scroll();
    return el;
  },

  // Разбор ввода с клавиатуры: команда + имя узла (ключи вроде -c 4 пропускаем)
  typed(raw) {
    const v = raw.trim();
    if (!v || this.busy) return;
    const [cmd, ...args] = v.split(/\s+/);
    const c = cmd.toLowerCase();
    const echo = () => this.body.append(h('div', {}, h('span', { class: 'p-local', text: TERM.prompt[this.os] + ' ' }), v));
    if (c === 'cls' || c === 'clear') { put(this.body); return; }
    if (c === 'help') {
      echo();
      Object.values(TERM.commands).forEach(C => this.print(`${C.cmd[this.os].padEnd(26)} ${C.what.split('.')[0]}`, 'sys'));
      this.print(this.os === 'win' ? 'cls                        очистить экран' : 'clear                      очистить экран', 'sys');
      return;
    }
    const key = { ping: 'ping', nslookup: 'nslookup', tracert: 'trace', traceroute: 'trace' }[c];
    if (!key) {
      echo();
      this.print(this.os === 'win' ? `'${cmd}' is not recognized as an internal or external command,\noperable program or batch file.` : `${cmd}: command not found`, 'err');
      this.print('В этом учебном терминале есть: ping, ' + (this.os === 'win' ? 'tracert' : 'traceroute') + ', nslookup, help, ' + (this.os === 'win' ? 'cls' : 'clear') + '.', 'sys');
      return;
    }
    if (c === 'traceroute' && this.os === 'win') {
      echo();
      this.print("'traceroute' is not recognized as an internal or external command,\noperable program or batch file.", 'err');
      this.print('На Windows эта команда называется tracert.', 'sys');
      return;
    }
    if (c === 'tracert' && this.os === 'nix') {
      echo();
      this.print('tracert: command not found', 'err');
      this.print('В macOS и Linux она называется traceroute.', 'sys');
      return;
    }
    const host = args.filter(a => !a.startsWith('-') && !/^\d+$/.test(a)).pop();
    if (!host || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host)) {
      echo();
      this.print(`Укажи имя сайта, например: ${c} example.com`, 'sys');
      return;
    }
    this.exec(key, host.toLowerCase(), v);
  },

  /* Выполнить команду: набрать её, затем печатать вывод построчно.
     Перед строкой с полем a проигрывается анимация в сети. */
  async exec(key, host = 'example.com', typedText = null) {
    if (this.busy) return;
    this.busy = true;
    this.updateBtns();
    const C = TERM.commands[key];
    const sub = s => s.split('example.com').join(host);
    put(this.explain, h('p', { class: 'ex-what', text: C.what }));
    this.stage.reset();
    ['active', 'bad', 'good'].forEach(m => this.stage.setMark(m, []));
    this.exItems = [];
    try {
      const line = h('div', {}, h('span', { class: 'p-local', text: TERM.prompt[this.os] + ' ' }));
      this.body.append(line);
      if (typedText) line.append(typedText);
      else {
        const typedEl = h('span');
        line.append(typedEl);
        for (const ch of sub(C.cmd[this.os])) { typedEl.textContent += ch; await this.clock.wait(0.04); }
      }
      this.scroll();
      for (const L of C.out[this.os]) {
        if (L.a) await this.anim(L.a);
        else await this.clock.wait(0.15);
        const el = this.print(sub(L.t), L.ex ? 'has-ex' : '');
        if (L.ex) this.addExplain(el, sub(L.t), sub(L.ex));
      }
      this.caption('Готово. Нажми на любую строку вывода — справа подсветится её разбор.');
    } catch (e) { ignoreCancel(e); }
    this.busy = false;
    this.updateBtns();
  },

  addExplain(lineEl, text, ex) {
    const item = h('div', { class: 'ex-item' }, h('code', { text: text.trim() }), h('p', { text: ex }));
    this.explain.append(item);
    this.explain.scrollTop = this.explain.scrollHeight;
    const select = () => {
      $$('.ex-item.sel, .out-line.sel').forEach(x => x.classList.remove('sel'));
      item.classList.add('sel');
      lineEl.classList.add('sel');
      item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    lineEl.addEventListener('click', select);
    item.addEventListener('click', select);
  },

  // Анимации в сети для строк вывода
  async anim(a) {
    const st = this.stage, path = TERM.path, sp = 560;
    if (a === 'dns' || a === 'nsq') {
      this.caption(a === 'dns' ? 'Сначала имя → IP: запрос к DNS-серверу (UDP, порт 53).' : 'nslookup спрашивает DNS-сервер напрямую.');
      st.setMark('active', ['dns']);
      await st.fly(TERM.toDns, { layer: 'dns', label: 'DNS?', speed: sp });
      await st.fly([...TERM.toDns].reverse(), { layer: 'dns', label: 'IP', speed: sp });
      return;
    }
    if (a === 'echo') {
      this.caption('ICMP Echo Request летит до сервера, Echo Reply — обратно. Время туда-обратно и есть пинг.');
      st.setMark('active', ['server']);
      await st.fly(path, { layer: 'ip', label: 'echo', speed: sp + 200 });
      await st.fly([...path].reverse(), { layer: 'ip', label: 'reply', speed: sp + 200 });
      return;
    }
    // hop1…hop5: пробный пакет с TTL = n умирает на n-м узле
    const n = +a.slice(3);
    const target = path[n];
    const route = path.slice(0, n + 1);
    st.setMark('active', [target]);
    this.caption(`Пакет с TTL=${n}: каждый роутер уменьшает TTL на 1, на ${n}-м узле он доходит до нуля.`);
    await st.fly(route, { layer: 'ip', label: 'TTL=' + n, speed: sp });
    if (target === 'bb1') {
      st.cross(st.xy(target));
      st.setMark('bad', ['bb1']);
      this.caption('Этот роутер молча выбросил пакет и ничего не ответил — в выводе будут звёздочки.');
      await this.clock.wait(1.2);
      return;
    }
    const last = target === 'server';
    this.caption(last ? 'Пакет дошёл до самого сервера — он отвечает. Трассировка закончена.' : `Узел ${n} сообщает: «время жизни истекло» — так мы узнаём его адрес.`);
    await st.fly([...route].reverse(), { layer: 'ip', label: last ? 'reply' : '⏱', speed: sp });
  },
};

/* ---------- 16. Диагностика: «не открывается сайт» ---------- */
const DiagScreen = {
  init(root) {
    this.clock = new Clock();
    this.clocks = [this.clock];
    this.stage = new Stage($('#diag-svg', root), this.clock, { nodes: DIAG.nodes, links: DIAG.links, size: DIAG.size, breakpoint: 560 });
    this.items = DIAG.steps.map((s, i) => {
      const res = h('small', { class: 'diag-res' });
      const li = h('li', { class: 'diag-item' }, h('span', { class: 'diag-dot', text: i + 1 }), h('span', { class: 'diag-txt' }, h('b', { text: s.title }), res));
      li.res = res;
      return li;
    });
    $('#diag-tree', root).append(...this.items);
    $('#diag-reset', root).addEventListener('click', () => this.reset());
    this.reset();
  },
  reset() {
    this.res = [];       // 'ok' | 'fail' | 'fixed' по шагам
    this.idx = 0;        // текущий шаг
    this.failed = null;  // шаг, на котором нашли проблему
    this.render();
  },
  answer(ok) {
    this.res[this.idx] = ok ? 'ok' : 'fail';
    if (ok) this.idx++; else this.failed = this.idx;
    this.render(true);
  },
  fixed() {
    this.res[this.failed] = 'fixed';
    this.idx = this.failed + 1;
    this.failed = null;
    this.render(true);
  },
  render(scroll) {
    const n = DIAG.steps.length;
    this.items.forEach((li, i) => {
      const r = this.res[i];
      li.className = 'diag-item ' + (r === 'ok' || r === 'fixed' ? 'ok' : r === 'fail' ? 'fail' : i === this.idx && this.failed == null ? 'current' : 'pending');
      li.res.textContent = { ok: '✓ работает', fixed: '✓ починили', fail: '✕ не работает' }[r] || (i === this.idx && this.failed == null ? '← проверяем сейчас' : '');
      $('.diag-dot', li).textContent = r === 'ok' || r === 'fixed' ? '✓' : r === 'fail' ? '✕' : i + 1;
    });
    const nodeOf = i => DIAG.steps[i].node;
    this.stage.setMark('good', this.res.map((r, i) => (r === 'ok' || r === 'fixed') ? nodeOf(i) : null).filter(Boolean));
    this.stage.setMark('bad', this.failed != null ? [nodeOf(this.failed)] : []);
    this.stage.setMark('active', this.failed == null && this.idx < n ? [nodeOf(this.idx)] : []);
    if (this.failed == null && this.idx < n) this.stage.pulse(nodeOf(this.idx));

    const card = $('#diag-card');
    const sec = (title, ...kids) => h('div', { class: 'card-sec' }, h('b', { text: title }), kids);
    const links = ids => h('div', { class: 'see-also' }, h('span', { text: 'Подробнее:' }), ids.map(screenLink));
    if (this.failed != null) {
      const s = DIAG.steps[this.failed];
      card.className = 'panel diag-card bad';
      put(card,
        h('div', { class: 'step-num', text: `Нашли: шаг ${this.failed + 1} · ${s.title}` }),
        h('h3', { text: 'Вероятная причина' }),
        h('p', { text: s.fail.cause }),
        sec('Что делать', h('ol', { class: 'list' }, s.fail.fix.map(t => h('li', { text: t })))),
        links(s.fail.links),
        h('div', { class: 'btn-row diag-answer' },
          h('button', { class: 'btn ok-btn', type: 'button', onclick: () => this.fixed() }, '✓ Починил — проверяем дальше'),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => this.reset() }, icon('restart'), 'Начать заново')));
    } else if (this.idx >= n) {
      const a = DIAG.allOk;
      card.className = 'panel diag-card ok';
      put(card,
        h('div', { class: 'step-num', text: 'Все проверки пройдены' }),
        h('h3', { text: a.title }),
        h('p', { text: a.cause }),
        sec('Что проверить ещё', h('ol', { class: 'list' }, a.fix.map(t => h('li', { text: t })))),
        links(a.links),
        h('div', { class: 'btn-row diag-answer' }, h('button', { class: 'btn', type: 'button', onclick: () => this.reset() }, icon('restart'), 'Начать заново')));
    } else {
      const s = DIAG.steps[this.idx];
      card.className = 'panel diag-card';
      put(card,
        h('div', { class: 'step-num', text: `Шаг ${this.idx + 1} из ${n}` }),
        h('h3', { text: s.title }),
        h('p', { class: 'diag-q', text: s.q }),
        sec('Как проверить', h('p', { text: s.how }), h('pre', { class: 'code', html: highlight(s.cmd, 'shell') })),
        h('div', { class: 'btn-row diag-answer' },
          h('button', { class: 'btn ok-btn', type: 'button', onclick: () => this.answer(true) }, '✓ Работает'),
          h('button', { class: 'btn bad-btn', type: 'button', onclick: () => this.answer(false) }, '✕ Не работает')));
    }
    if (scroll && innerWidth < 960) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },
};

/* =====================================================================
   ТЕРМИНЫ (версия 3): таблетки в тексте, панель объяснений,
   подсветка слоя по легенде, мобильная навигация
   ===================================================================== */
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isPhone = () => window.matchMedia('(max-width: 768px)').matches;
// Для инструментов и «русских» терминов расшифровка в скобках не нужна
const NO_EXPAND = new Set(['ping', 'traceroute', 'nslookup', 'ipv6', 'port', 'router', 'switch', 'packet']);
const hasExpansion = key => !NO_EXPAND.has(key) && /[A-Za-z]/.test(TERMS[key].abbr);
function expansion(t) {
  return t.full && t.full !== t.abbr ? `${t.full}, «${t.ru}»` : `«${t.ru}»`;
}

/* Таблетка термина — настоящая кнопка. Цвет берётся из слоя термина,
   у терминов без слоя — нейтральный. expand — добавить расшифровку в скобках. */
function termPill(key, text, expand = false) {
  const t = TERMS[key];
  const btn = h('button', {
    type: 'button', class: 'term-pill' + (t.layer ? '' : ' neutral'),
    style: t.layer ? `--c: var(--l-${t.layer})` : null,
    'data-term': key, 'data-layer': t.layer,
    'aria-haspopup': 'dialog', 'aria-controls': 'term-panel', 'aria-expanded': String(TermPanel.key === key),
    'aria-label': `${t.abbr} — ${t.ru}. Открыть объяснение`,
  }, text || t.abbr);
  return expand ? [btn, h('span', { class: 'term-exp', text: ` (${expansion(t)})` })] : btn;
}

/* АВТОМАТИЧЕСКИЕ ТАБЛЕТКИ.
   Проходит по текстовым узлам и заменяет известные термины (NAT, TCP…) таблетками.
   В одном абзаце таблеткой становится только первое упоминание термина,
   а при первом упоминании на экране рядом пишется расшифровка.
   Код, кнопки, ссылки, заголовки и SVG не трогаются. */
const TermLinker = {
  SKIP: 'pre, code, button, a, svg, input, textarea, select, label, h1, h2, h3, h4, .chip, .term-exp, .proto, .term-body, '
    + '.br-doc, .nav, .topbar, .tooltip, .layer-cell, .pdu, .env-v, .vis-row, .cache, .log-list.compact, .eyebrow, .small-title, '
    + '.payload-title, .step-num, .slot, .counter, .wire, .mini-bar, .legend-bar, .tp-title, .tp-layer, .no-terms, .port-badge, .proto-ru, .proto-full, .hash-out, .pdu-row',
  NO_EXP: 'td, th, .status, .lane-caption, .lane-delivered, .hint-inline, .caption, .hint, .tp-body, .proto-card, .sec-card, .log-list',
  init() {
    this.keyOf = new Map();
    for (const [key, t] of Object.entries(TERMS)) for (const m of (t.match || [t.abbr])) this.keyOf.set(m, key);
    // Длинные написания первыми: «TCP/IP» раньше «TCP», «HTTPS» раньше «HTTP»
    const alts = [...this.keyOf.keys()].sort((a, b) => b.length - a.length).map(escRe);
    this.re = new RegExp(`(?<![A-Za-zА-Яа-яЁё0-9_/\\-])(?:${alts.join('|')})(?![A-Za-zА-Яа-яЁё0-9_/])`, 'g');
    this.screenSeen = {};  // экран → термины, которые там уже расшифрованы
  },
  keyIn(text) {
    this.re.lastIndex = 0;
    const m = this.re.exec(text);
    return m ? this.keyOf.get(m[0]) : null;
  },
  // opts: { noExpand, exclude } — для панели: без расшифровок и без самого открытого термина
  run(root, opts = {}) {
    if (!root) return;
    if (root.nodeType === 3) { this.linkText(root, opts); return; }
    if (root.nodeType !== 1 || root.closest(this.SKIP)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = [];
    for (let n; (n = walker.nextNode());) texts.push(n);
    texts.forEach(n => this.linkText(n, opts));
  },
  linkText(node, opts = {}) {
    const parent = node.parentElement;
    const text = node.nodeValue;
    if (!parent || !text || !/[A-Za-z]/.test(text) || parent.closest(this.SKIP)) return;
    this.re.lastIndex = 0;
    if (!this.re.test(text)) return;
    // Какие термины в этом абзаце уже таблетки
    const block = parent.closest('p, li, td, th, dd, dt, div') || parent;
    const seen = new Set($$('.term-pill', block).map(p => p.dataset.term));
    const screen = parent.closest('.screen')?.dataset.screen || '';
    const shown = this.screenSeen[screen] || (this.screenSeen[screen] = new Set());
    const canExpand = !opts.noExpand && screen && !parent.closest(this.NO_EXP);
    const out = [];
    let last = 0;
    this.re.lastIndex = 0;
    for (const m of text.matchAll(this.re)) {
      const key = this.keyOf.get(m[0]);
      if (seen.has(key) || key === opts.exclude) continue;
      seen.add(key);
      const expand = canExpand && !shown.has(key) && hasExpansion(key);
      if (expand) shown.add(key);
      let end = m.index + m[0].length;
      out.push(text.slice(last, m.index), termPill(key, m[0]));
      if (expand) {
        // «IP-адресам»: расшифровку ставим после всего слова, а не посреди него
        const tail = text.slice(end).match(/^-[A-Za-zА-Яа-яЁё]+/)?.[0] || '';
        end += tail.length;
        out.push(tail, h('span', { class: 'term-exp', text: ` (${expansion(TERMS[key])})` }));
      }
      last = end;
    }
    if (!out.length) return;
    out.push(text.slice(last));
    node.replaceWith(...out.flat().filter(x => x !== ''));
  },
  // Следить за новым текстом (шаги анимаций, подписи) и размечать его тоже
  observe(root) {
    new MutationObserver(records => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType === 1 && (n.classList.contains('term-pill') || n.classList.contains('term-exp'))) continue;
          this.run(n);
        }
      }
    }).observe(root, { childList: true, subtree: true });
  },
};

/* ПАНЕЛЬ С ОБЪЯСНЕНИЕМ.
   Один <dialog>: на десктопе — боковая панель справа (не блокирует страницу),
   на телефоне (до 768px) — модальная панель снизу: закрывается свайпом вниз,
   тапом по фону, кнопкой «×» и клавишей Esc. */
const TermPanel = {
  key: null,
  init() {
    this.dlg = $('#term-panel');
    this.body = $('#tp-body');
    this.backBtn = $('#tp-back');
    this.history = [];
    try { this.mode = localStorage.getItem('tp-mode') || 'full'; } catch { this.mode = 'full'; }
    $$('#tp-mode button').forEach(b => b.addEventListener('click', () => this.setMode(b.dataset.mode)));
    $('#tp-close').addEventListener('click', () => this.close());
    this.backBtn.addEventListener('click', () => this.back());
    // Esc у модального окна приходит как событие cancel
    this.dlg.addEventListener('cancel', e => { e.preventDefault(); this.close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && this.dlg.open) { e.preventDefault(); this.close(); } });
    // Тап по затемнённому фону: событие приходит на сам <dialog>, а не на его содержимое
    this.dlg.addEventListener('click', e => { if (e.target === this.dlg) this.close(); });
    // Событие close приходит с задержкой. Если за это время панель уже открыли снова
    // (быстрое нажатие на другой термин), запоздавшее событие ничего не должно сбрасывать.
    this.dlg.addEventListener('close', () => { if (!this.dlg.open && this.key) this.cleanup(); });
    document.addEventListener('click', e => {
      const pill = e.target.closest('.term-pill');
      if (pill) { e.preventDefault(); this.open(pill.dataset.term, pill); }
    });
    initSwipeToClose(this.dlg, $('.tp-head', this.dlg), () => this.close());
  },
  setMode(mode) {
    this.mode = mode;
    try { localStorage.setItem('tp-mode', mode); } catch { /* приватный режим — не страшно */ }
    if (this.key) this.render();
  },
  open(key, opener) {
    if (!TERMS[key]) return;
    if (this.dlg.open) {
      if (this.key && this.key !== key) this.history.push(this.key);
    } else {
      this.history = [];
      this.opener = opener || document.activeElement;
    }
    this.key = key;
    this.render();
    if (!this.dlg.open) {
      const modal = isPhone();
      this.dlg.classList.toggle('sheet', modal);
      this.dlg.style.transform = '';
      if (modal) { this.dlg.showModal(); document.documentElement.classList.add('sheet-open'); }
      else this.dlg.show();
    }
    this.body.scrollTop = 0;
    $('#tp-title').focus({ preventScroll: true });
    this.syncPills();
  },
  back() {
    const prev = this.history.pop();
    if (!prev) return;
    this.key = prev;
    this.render();
    this.syncPills();
    $('#tp-title').focus({ preventScroll: true });
  },
  close() {
    if (!this.dlg.open) return;
    this.dlg.close();
    this.cleanup();  // сразу, не дожидаясь события close
  },
  cleanup() {
    document.documentElement.classList.remove('sheet-open');
    this.key = null;
    this.history = [];
    this.syncPills();
    if (this.opener && document.contains(this.opener)) this.opener.focus({ preventScroll: true });
  },
  // У таблеток открытого термина — aria-expanded="true" и сильное свечение
  syncPills() {
    $$('.term-pill[aria-expanded="true"]').forEach(p => p.setAttribute('aria-expanded', 'false'));
    if (this.key) $$(`.term-pill[data-term="${this.key}"]`).forEach(p => p.setAttribute('aria-expanded', 'true'));
  },
  nodesHere(t) {
    return App.stages.filter(s => s.screen === App.current).flatMap(s => (t.nodes || []).filter(n => s.nodeEls[n]));
  },
  render() {
    const key = this.key, t = TERMS[key], full = this.mode === 'full';
    this.dlg.style.setProperty('--c', t.layer ? `var(--l-${t.layer})` : 'var(--neutral)');
    this.backBtn.hidden = !this.history.length;
    if (this.history.length) $('span', this.backBtn).textContent = TERMS[this.history[this.history.length - 1]].abbr;
    $$('#tp-mode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === this.mode)));
    const sec = (title, ...kids) => h('section', { class: 'tp-sec' }, h('h3', { text: title }), kids);
    const attack = t.kind === 'attack';
    const hasStage = App.stages.some(s => s.screen === App.current);
    const canShow = hasStage && (t.layer || this.nodesHere(t).length);
    const home = TERM_HOME[key];
    put(this.body,
      h('h2', { id: 'tp-title', class: 'tp-title', tabindex: '-1' },
        h('span', { class: 'tp-dot', 'aria-hidden': 'true' }), t.abbr,
        hasExpansion(key) ? h('span', { class: 'tp-exp', text: ` (${expansion(t)})` }) : h('span', { class: 'tp-exp', text: ` — ${t.ru}` })),
      h('div', { class: 'tp-layer' },
        t.layer ? chip(t.layer, 'Слой: ' + LAYERS[t.layer].name) : h('span', { class: 'hint', text: 'Общий термин: относится ко всем слоям сразу' }),
        full && t.tcpip ? chip(TCPIP_LEVELS[t.tcpip].layer, 'Уровень TCP/IP: ' + TCPIP_LEVELS[t.tcpip].name, 'Уровень модели TCP/IP, на котором работает протокол') : null,
        full && t.port ? h('span', { class: 'port-badge', 'data-tip': 'Порт по умолчанию', text: 'Порт: ' + t.port }) : null),
      sec('Что это', h('p', { text: t.what })),
      full ? sec(attack ? 'Чем опасно' : 'Зачем нужно', h('p', { text: t.why })) : null,
      full ? sec(attack ? 'Как работает (идея, без инструкций)' : 'Как работает', h('ol', { class: 'tp-steps' }, t.how.map(x => h('li', { text: x })))) : null,
      h('div', { class: 'analogy tp-analogy' }, h('b', { text: 'Аналогия' }), h('p', { text: t.analogy })),
      full && attack ? sec('Как защищаются', h('ul', { class: 'tp-steps' }, t.defense.map(x => h('li', { text: x })))) : null,
      full && t.without ? sec('Что будет, если этого нет', h('p', { text: t.without })) : null,
      full && t.tech ? sec('Технические детали', h('p', { class: 'tp-tech', text: t.tech })) : null,
      full && t.related?.length ? sec('Связанные термины', h('div', { class: 'tp-related' }, t.related.map(k => termPill(k)))) : null,
      full ? h('div', { class: 'tp-actions' },
        canShow ? h('button', { class: 'btn primary', type: 'button', onclick: () => this.showOnScheme() }, icon('layers'), 'Показать на схеме') : null,
        home && home !== App.current ? h('a', { class: 'btn ghost', href: '#' + home }, `Экран ${screenNum(home)}: ${SCREENS[screenNum(home)].short}`, icon('next')) : null) : null,
      full ? null : h('p', { class: 'hint tp-more', text: 'Включи «Подробно», чтобы увидеть, зачем это нужно, как работает, связанные термины и технические детали.' }));
    // Термины внутри объяснения — тоже таблетки (кроме самого открытого)
    $$('.tp-sec p, .tp-sec li, .tp-analogy p', this.body).forEach(el => TermLinker.run(el, { noExpand: true, exclude: key }));
    $$('a', this.body).forEach(a => a.addEventListener('click', () => this.close()));
  },
  // Закрыть панель и подсветить на схеме слой термина и его узлы
  showOnScheme() {
    const t = TERMS[this.key];
    const nodes = this.nodesHere(t);
    this.close();
    Highlight.set(t.layer, nodes);
    const st = App.stages.find(s => s.screen === App.current && s.svg.getBoundingClientRect().height > 0);
    st?.svg.scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'center' });
  },
};

// Свайп вниз закрывает нижнюю панель (только в режиме телефона)
function initSwipeToClose(dlg, handle, onClose) {
  let startY = null, dy = 0;
  handle.addEventListener('pointerdown', e => {
    if (!dlg.classList.contains('sheet') || e.target.closest('button')) return;
    startY = e.clientY; dy = 0;
    handle.setPointerCapture(e.pointerId);
    dlg.style.transition = 'none';
  });
  handle.addEventListener('pointermove', e => {
    if (startY == null) return;
    dy = Math.max(0, e.clientY - startY);
    dlg.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (startY == null) return;
    startY = null;
    dlg.style.transition = '';
    if (dy > 90) onClose();
    dlg.style.transform = '';
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/* ПОДСВЕТКА СЛОЯ. Легенда и кнопка «Показать на схеме» подсвечивают на текущем
   экране всё, что относится к слою (узлы, линии, пакеты, ячейки, таблетки),
   и приглушают остальное. Правила пишутся в отдельный <style>, поэтому
   действуют и на пакеты, которые появятся позже. */
const Highlight = {
  key: null,
  set(key, nodes = []) {
    this.key = key || null;
    const id = App.current;
    if (!this.style) document.head.append(this.style = h('style', { id: 'hl-style' }));
    const sc = `#screen-${id}`;
    const html = ':is(.layer-cell, .osi-cell, .tcp-cell, .wire button, .pdu-part, .card, .proto-card, .term-pill, .chip:not(.legend-btn), .ba)';
    this.style.textContent = key ? `
      ${sc} .stage :is(.node, .dot, .link, .zone, .zone-label, .link-label):not([data-layer="${key}"]):not(.spot) { opacity: .14; }
      ${sc} .stage :is(.node, .dot)[data-layer="${key}"] { filter: drop-shadow(0 0 7px var(--l-${key})); }
      ${sc} .stage .link[data-layer="${key}"] { stroke: var(--l-${key}); }
      ${sc} ${html}[data-layer]:not([data-layer="${key}"]) { opacity: .32; }
      ${sc} ${html}[data-layer="${key}"] { box-shadow: 0 0 0 2px var(--l-${key}), 0 0 18px color-mix(in srgb, var(--l-${key}) 45%, transparent); }` : '';
    $$(`${sc} .legend-btn`).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.layer === key)));
    $$(`${sc} .legend-status`).forEach(s => { s.textContent = key ? `Подсвечен слой «${LAYERS[key].name}». Нажми ещё раз, чтобы снять.` : ''; });
    for (const st of App.stages.filter(s => s.screen === id)) {
      const here = nodes.filter(n => st.nodeEls[n]);
      st.setMark('spot', here);
      here.forEach(n => st.pulse(n));
    }
    SCREEN_IMPL[id]?.onHighlight?.(key);
  },
  toggle(key) { this.set(this.key === key ? null : key); },
  clear() { if (this.key || this.style?.textContent) this.set(null); },
};

const LEGEND_KEYS = ['app', 'http', 'tls', 'tcp', 'ip', 'link', 'dns', 'sec', 'ssh', 'cicd', 'api', 'hw'];
function legendBar() {
  return h('div', { class: 'legend-bar' },
    h('div', { class: 'legend-row', role: 'group', 'aria-label': 'Подсветить слой на схеме' },
      h('span', { class: 'legend-label', text: 'Подсветить слой:' }),
      h('div', { class: 'legend-scroll' }, LEGEND_KEYS.map(k => h('button', {
        type: 'button', class: 'chip legend-btn', style: `--c: var(--l-${k})`, 'data-layer': k, 'aria-pressed': 'false',
        'data-tip': LAYERS[k].desc, onclick: () => Highlight.toggle(k),
      }, LAYERS[k].short)))),
    h('div', { class: 'legend-status', 'aria-live': 'polite' }));
}

/* Пример «до и после»: две колонки с одинаковыми строками */
function beforeAfter(ba) {
  const col = (side, cls) => h('div', { class: 'ba-col ' + cls },
    h('div', { class: 'ba-label', text: side.label }),
    h('dl', {}, side.rows.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])));
  return h('div', { class: 'ba', 'data-layer': ba.layer, style: `--c: var(--l-${ba.layer})` },
    h('div', { class: 'small-title', text: ba.title }),
    h('div', { class: 'ba-grid' }, col(ba.before, 'before'), h('div', { class: 'ba-arrow', 'aria-hidden': 'true', text: '→' }), col(ba.after, 'after')),
    ba.note ? h('p', { class: 'hint', text: ba.note }) : null);
}

/* Дополнения к экранам первой версии (вызываются один раз после init) */
const EXTRAS = {
  dns: root => $('#dns-log', root).closest('.grid-2').after(h('div', { class: 'panel' }, beforeAfter(BEFORE_AFTER.dns))),
  firewall: root => $('.fw-layout', root).after(h('div', { class: 'panel' }, beforeAfter(BEFORE_AFTER.firewall))),
  hardware: root => $('#hw-compare', root).closest('.panel').after(h('div', { class: 'grid-2' },
    h('div', { class: 'panel' }, beforeAfter(BEFORE_AFTER.switch)), h('div', { class: 'panel' }, beforeAfter(BEFORE_AFTER.router)))),
};

/* МОБИЛЬНАЯ НАВИГАЦИЯ: нижняя панель «Назад · Экраны · Далее»
   и выдвижное меню со всеми экранами по разделам */
function buildMobileNav() {
  const bar = $('#bottom-nav');
  App.bn = {
    prev: h('a', { class: 'bn-btn', href: '#', 'aria-label': 'Предыдущий экран' }, icon('prev'), h('span', { text: 'Назад' })),
    menu: h('button', { class: 'bn-btn bn-menu', type: 'button', 'aria-haspopup': 'dialog', 'aria-controls': 'menu-sheet', onclick: () => openMenu() },
      icon('burger'), h('span', { class: 'bn-title' })),
    next: h('a', { class: 'bn-btn', href: '#', 'aria-label': 'Следующий экран' }, h('span', { text: 'Далее' }), icon('next')),
  };
  bar.append(App.bn.prev, App.bn.menu, App.bn.next);
  const dlg = $('#menu-sheet');
  $('#menu-list').append(...NAV_GROUPS.map(g => h('section', {},
    h('h3', { text: g.title }),
    h('ol', { class: 'menu-items' }, SCREENS.filter(s => s.group === g.id).map(s => h('li', {},
      h('a', { href: '#' + s.id, 'data-id': s.id, onclick: () => closeMenu() },
        h('span', { class: 'num' }, s.id === 'start' ? icon('play') : String(screenNum(s.id))), s.title)))))));
  $('#menu-close').addEventListener('click', () => closeMenu());
  dlg.addEventListener('click', e => { if (e.target === dlg) closeMenu(); });
  dlg.addEventListener('close', () => { if (!$('#term-panel').open) document.documentElement.classList.remove('sheet-open'); });
  initSwipeToClose(dlg, $('.tp-head', dlg), () => closeMenu());
}
function closeMenu() {
  document.documentElement.classList.remove('sheet-open');
  const dlg = $('#menu-sheet');
  if (dlg.open) dlg.close();
}
function openMenu() {
  const dlg = $('#menu-sheet');
  $$('#menu-list a').forEach(a => a.toggleAttribute('aria-current', a.dataset.id === App.current));
  dlg.classList.add('sheet');
  dlg.style.transform = '';
  dlg.showModal();
  document.documentElement.classList.add('sheet-open');
  $('#menu-list a[aria-current]')?.scrollIntoView({ block: 'center' });
}
function updateMobileNav(id) {
  const i = screenNum(id);
  const prev = SCREENS[i - 1], next = SCREENS[i + 1];
  const set = (a, sc) => {
    a.href = sc ? '#' + sc.id : '#' + id;
    a.classList.toggle('disabled', !sc);
    a.setAttribute('aria-disabled', String(!sc));
    if (sc) a.setAttribute('aria-label', (a === App.bn.prev ? 'Назад: ' : 'Далее: ') + sc.title);
  };
  set(App.bn.prev, prev);
  set(App.bn.next, next);
  $('.bn-title', App.bn.menu).textContent = (i ? i + '. ' : '') + SCREENS[i].short;
  App.bn.menu.setAttribute('aria-label', `Все экраны. Сейчас: ${SCREENS[i].title}`);
  $('#topbar-title').textContent = SCREENS[i].short;
}

/* =====================================================================
   РАЗДЕЛ «РАСШИРЕННЫЙ УРОВЕНЬ»: карта протоколов и безопасность
   ===================================================================== */

/* ---------- Карта всех протоколов ---------- */
const ProtocolsScreen = {
  init(root) {
    this.level = 'all';
    const filters = $('#proto-filters', root);
    const mk = (id, content) => h('button', {
      class: 'btn sm' + (id === 'all' ? ' selected' : ''), type: 'button', 'data-level': id, 'aria-pressed': String(id === 'all'),
      onclick: () => {
        this.level = id;
        $$('#proto-filters .btn').forEach(b => { const on = b.dataset.level === id; b.classList.toggle('selected', on); b.setAttribute('aria-pressed', String(on)); });
        this.render();
      },
    }, content);
    filters.append(mk('all', 'Все уровни'), ...Object.entries(TCPIP_LEVELS).map(([id, lv]) => mk(id, chip(lv.layer, lv.name, 'Уровень модели TCP/IP'))));
    $('#proto-q', root).addEventListener('input', () => this.render());
    this.render();
  },
  card(key) {
    const t = TERMS[key], lv = TCPIP_LEVELS[t.tcpip];
    return h('article', { class: 'proto-card', style: t.layer ? `--c: var(--l-${t.layer})` : null, 'data-layer': t.layer },
      h('div', { class: 'proto-head' }, termPill(key), h('span', { class: 'proto-full', text: t.full !== t.abbr ? t.full : '' })),
      h('div', { class: 'proto-ru', text: t.ru }),
      h('div', { class: 'proto-meta' },
        chip(lv.layer, 'Уровень: ' + lv.name, 'Уровень модели TCP/IP, на котором работает протокол'),
        h('span', { class: 'port-badge', 'data-tip': 'Порт по умолчанию', text: 'Порт: ' + t.port })),
      h('p', { text: t.what }),
      h('p', { class: 'proto-ex' }, h('b', { text: 'Пример из жизни. ' }), t.why),
      h('div', { class: 'analogy', text: 'Аналогия: ' + t.analogy }));
  },
  render() {
    const q = $('#proto-q').value.trim().toLowerCase();
    const fits = key => {
      const t = TERMS[key];
      if (this.level !== 'all' && t.tcpip !== this.level) return false;
      return !q || [t.abbr, t.full, t.ru, t.what, t.why, t.port].join(' ').toLowerCase().includes(q);
    };
    let shown = 0, total = 0;
    const groups = PROTO_GROUPS.map(g => {
      total += g.keys.length;
      const keys = g.keys.filter(fits);
      shown += keys.length;
      return keys.length ? h('section', { class: 'proto-group' },
        h('h3', { class: 'section-title', text: g.title }),
        h('p', { class: 'hint', text: g.about }),
        h('div', { class: 'proto-grid' }, keys.map(k => this.card(k)))) : null;
    });
    put($('#proto-groups'), shown ? groups : h('div', { class: 'gloss-empty', text: 'Ничего не нашлось. Попробуй другое слово или «Все уровни».' }));
    $('#proto-count').textContent = `Показано протоколов: ${shown} из ${total}`;
  },
};

/* ---------- Защита и безопасность ---------- */
const SecurityScreen = {
  init(root) {
    this.clock = new Clock();       // туннель VPN
    this.guardClock = new Clock();  // «сторожа»
    this.clocks = [this.clock, this.guardClock];
    this.started = new Set();
    this.tabBtns = SECURITY.tabs.map(tab => h('button', {
      class: 'tab', type: 'button', role: 'tab', id: 'sectab-' + tab.id, 'aria-controls': 'secpanel-' + tab.id, 'aria-selected': 'false',
      style: `--c: var(--l-${tab.layer})`, onclick: () => this.tab(tab.id),
    }, tab.title));
    $('#sec-tabs', root).append(...this.tabBtns);
    $('#sec-panels', root).append(...SECURITY.tabs.map(tab => {
      const panelEl = h('div', { class: 'tab-panel', id: 'secpanel-' + tab.id, role: 'tabpanel', 'aria-labelledby': 'sectab-' + tab.id, hidden: true },
        h('p', { class: 'lead small sec-intro', text: tab.intro }),
        tab.extra ? this.extra(tab.extra) : null,
        h('div', { class: 'sec-grid' }, tab.keys.map(k => this.card(k))));
      return panelEl;
    }));
    this.tab('crypto');
  },
  tab(id) {
    SECURITY.tabs.forEach((t, i) => {
      const on = t.id === id;
      this.tabBtns[i].classList.toggle('selected', on);
      this.tabBtns[i].setAttribute('aria-selected', String(on));
      $('#secpanel-' + t.id).hidden = !on;
    });
    // Анимации вкладок запускаются при первом показе
    if (!this.started.has(id)) {
      this.started.add(id);
      if (id === 'crypto') this.runTunnel();
      if (id === 'guards') this.pickGuard('firewall');
    }
  },
  card(key) {
    const t = TERMS[key];
    const attack = t.kind === 'attack';
    return h('article', { class: 'panel card sec-card', style: `--c: var(--l-${t.layer || 'sec'})`, 'data-layer': t.layer },
      h('div', { class: 'sec-head' }, termPill(key), h('span', { class: 'proto-full', text: hasExpansion(key) ? t.full : t.ru })),
      h('p', { text: t.what }),
      h('div', { class: 'card-sec' }, h('b', { text: attack ? 'Как работает (идея)' : 'Как работает' }),
        h('ol', { class: 'mini-steps' }, t.how.map(x => h('li', { text: x })))),
      attack ? h('div', { class: 'card-sec defense' }, h('b', { text: 'Как защищаются' }), h('ul', { class: 'mini-steps' }, t.defense.map(x => h('li', { text: x })))) : null,
      h('div', { class: 'analogy', text: 'Аналогия: ' + t.analogy }));
  },
  extra(kind) {
    if (kind === 'wifi') return h('div', { class: 'panel' }, beforeAfter(SECURITY.wifi));
    if (kind === 'dns') return h('div', { class: 'panel' }, beforeAfter(SECURITY.dns));
    if (kind === 'tunnel') return this.buildTunnel();
    if (kind === 'guards') return this.buildGuards();
    if (kind === 'hash') return this.buildHash();
    return null;
  },

  /* --- VPN-туннель: исходный пакет заворачивается в зашифрованный --- */
  buildTunnel() {
    const svg = sv('svg', { role: 'img', 'aria-label': 'Пакет внутри VPN-туннеля' });
    this.tunCaption = h('div', { class: 'caption', 'aria-live': 'polite' });
    const ctrl = makeControls({
      onRestart: () => this.runTunnel(), restartTip: 'Сначала',
      onToggle: () => { this.clock.paused = !this.clock.paused; ctrl.setPlaying(!this.clock.paused); },
      playLabels: ['Продолжить', 'Пауза'],
    });
    ctrl.setPlaying(true);
    const box = h('div', { class: 'panel' },
      h('div', { class: 'small-title', text: 'Как пакет едет через VPN-туннель' }),
      h('div', { class: 'stage-wrap' }, svg),
      this.tunCaption, ctrl.el,
      h('div', { class: 'small-title', style: 'margin-top:14px', text: 'Что видно снаружи туннеля' }),
      h('div', { class: 'pdu-row tun-pdu' },
        h('span', { class: 'pdu-part', style: '--c: var(--l-ip)', 'data-layer': 'ip', text: 'IP: ты → VPN-сервер' }),
        h('span', { class: 'pdu-part', style: '--c: var(--l-tls)', 'data-layer': 'tls', text: 'WireGuard / IPsec' }),
        h('span', { class: 'pdu-part grow', style: '--c: var(--l-http)', 'data-layer': 'http', text: '🔒 исходный пакет: ты → сайт, GET /' })),
      h('p', { class: 'hint', text: 'Провайдер видит только внешний конверт: «к VPN-серверу». Что внутри и куда идёт дальше — нет.' }));
    this.tunStage = new Stage(svg, this.clock, {
      size: { wide: [760, 190], tall: [360, 470] }, breakpoint: 560,
      nodes: {
        you:  { label: 'Ты', icon: 'laptop', layer: 'app', wide: [70, 95], tall: [180, 40] },
        isp:  { label: 'Провайдер / Wi-Fi', icon: 'building', layer: 'ip', wide: [270, 95], tall: [180, 160] },
        vpn:  { label: 'VPN-сервер', icon: 'lock', layer: 'tls', wide: [480, 95], tall: [180, 285] },
        site: { label: 'Сайт', icon: 'server', layer: 'http', wide: [690, 95], tall: [180, 410] },
      },
      links: [{ id: 't1', from: 'you', to: 'isp', layer: 'tls' }, { id: 't2', from: 'isp', to: 'vpn', layer: 'tls' }, { from: 'vpn', to: 'site', type: 'fiber' }],
    });
    this.tunStage.setMark('tun', ['t1', 't2']);
    return box;
  },
  async runTunnel() {
    const st = this.tunStage, c = this.clock;
    c.cancel(); st.reset(); c.paused = false;
    const say = t => { this.tunCaption.textContent = t; };
    try {
      for (;;) {
        say('Ты открываешь сайт. Пакет «ты → сайт» заворачивается в зашифрованный конверт «ты → VPN-сервер».');
        await st.fly(['you', 'isp', 'vpn'], { layer: 'tls', label: '🔒', speed: 200 });
        say('VPN-сервер снимает конверт, видит исходный пакет и отправляет его сайту уже от своего адреса.');
        await c.wait(0.8);
        await st.fly(['vpn', 'site'], { layer: 'http', label: 'GET', speed: 200 });
        say('Сайт отвечает VPN-серверу — он думает, что разговаривает с ним.');
        await st.fly(['site', 'vpn'], { layer: 'http', label: 'HTML', speed: 200 });
        say('VPN-сервер заворачивает ответ в туннель и отправляет тебе. Провайдер снова видит только шифр.');
        await st.fly(['vpn', 'isp', 'you'], { layer: 'tls', label: '🔒', speed: 200 });
        await c.wait(2);
      }
    } catch (e) { ignoreCancel(e); }
  },

  /* --- «Сторожа»: кого пропускают, кого блокируют --- */
  buildGuards() {
    const keys = Object.keys(SECURITY.guards);
    this.guardBtns = keys.map(k => h('button', { class: 'btn sm', type: 'button', 'data-guard': k, 'aria-pressed': 'false', onclick: () => this.pickGuard(k) }, TERMS[k].abbr));
    const svg1 = sv('svg', { role: 'img', 'aria-label': 'Сторож трафика' });
    const svg2 = sv('svg', { role: 'img', 'aria-label': 'Балансировщик нагрузки' });
    this.guardWrap1 = h('div', { class: 'stage-wrap' }, svg1);
    this.guardWrap2 = h('div', { class: 'stage-wrap', hidden: true }, svg2);
    this.guardLog = h('ol', { class: 'log-list guard-log' });
    this.guardCnt = h('div', { class: 'fw-counters' });
    this.guardWhat = h('div', { class: 'caption' });
    const ctrl = makeControls({
      onRestart: () => this.pickGuard(this.guard), restartTip: 'Сначала',
      onToggle: () => { this.guardClock.paused = !this.guardClock.paused; ctrl.setPlaying(!this.guardClock.paused); },
      playLabels: ['Продолжить', 'Пауза'],
    });
    ctrl.setPlaying(true);
    const box = h('div', { class: 'panel' },
      h('div', { class: 'small-title', text: 'Выбери сторожа' }),
      h('div', { class: 'btn-row' }, this.guardBtns),
      this.guardWhat, this.guardCnt, this.guardWrap1, this.guardWrap2, ctrl.el,
      h('div', { class: 'small-title', style: 'margin-top:12px', text: 'Журнал решений' }), this.guardLog);
    const base = { size: { wide: [720, 190], tall: [360, 380] }, breakpoint: 520 };
    this.guardStage = new Stage(svg1, this.guardClock, { ...base, nodes: {
      src: { label: 'Интернет', icon: 'cloud', layer: 'ip', wide: [80, 95], tall: [180, 40] },
      guard: { label: 'Сторож', icon: 'shield', layer: 'sec', wide: [360, 95], tall: [180, 185] },
      dst: { label: 'Сервер', icon: 'server', layer: 'http', wide: [640, 95], tall: [180, 330] },
    }, links: [{ from: 'src', to: 'guard' }, { from: 'guard', to: 'dst' }] });
    this.lbStage = new Stage(svg2, this.guardClock, { size: { wide: [720, 260], tall: [360, 380] }, breakpoint: 520, nodes: {
      src: { label: 'Пользователи', icon: 'user', layer: 'app', wide: [80, 130], tall: [180, 40] },
      guard: { label: 'Балансировщик', icon: 'shield', layer: 'sec', wide: [330, 130], tall: [180, 170] },
      s0: { label: 'Сервер 1', icon: 'server', layer: 'http', wide: [620, 40], tall: [60, 310] },
      s1: { label: 'Сервер 2', icon: 'server', layer: 'http', wide: [620, 130], tall: [180, 310] },
      s2: { label: 'Сервер 3', icon: 'server', layer: 'http', wide: [620, 220], tall: [300, 310] },
    }, links: [{ from: 'src', to: 'guard' }, { from: 'guard', to: 's0' }, { from: 'guard', to: 's1' }, { from: 'guard', to: 's2' }] });
    return box;
  },
  pickGuard(key) {
    this.guard = key;
    const g = SECURITY.guards[key], t = TERMS[key];
    this.guardBtns.forEach(b => { const on = b.dataset.guard === key; b.classList.toggle('selected', on); b.setAttribute('aria-pressed', String(on)); });
    this.guardWrap1.hidden = !!g.route;
    this.guardWrap2.hidden = !g.route;
    const st = g.route ? this.lbStage : this.guardStage;
    if (!g.route) {
      st.setLabel('src', { label: g.left });
      st.setLabel('guard', { label: { statefulfw: 'Stateful firewall' }[key] || t.abbr });
      st.setLabel('dst', { label: g.right });
    }
    put(this.guardWhat, termPill(key), ' ', t.what);
    put(this.guardLog);
    this.runGuard(st, g);
  },
  async runGuard(st, g) {
    const c = this.guardClock;
    c.cancel();
    this.guardStage.reset(); this.lbStage.reset();
    st.setMark('bad', []);
    c.paused = false;
    const stats = { pass: 0, block: 0, alert: 0 };
    const counters = () => put(this.guardCnt,
      h('div', { class: 'counter ok' }, h('b', { text: stats.pass }), 'пропущено'),
      h('div', { class: 'counter bad' }, h('b', { text: stats.block }), 'заблокировано'),
      g.items.some(i => i.verdict === 'alert') ? h('div', { class: 'counter warn' }, h('b', { text: stats.alert }), 'тревог') : null);
    counters();
    const log = (sym, cls, it) => {
      this.guardLog.prepend(h('li', { class: cls, text: `${sym} ${it.label} — ${it.why}` }));
      while (this.guardLog.children.length > 8) this.guardLog.lastChild.remove();
    };
    try {
      for (let round = 0; ; round++) {
        for (const it of g.items) {
          await st.fly(['src', 'guard'], { layer: 'ip', label: it.label, speed: 220 });
          const at = st.xy('guard');
          if (it.verdict === 'block') {
            st.cross(at); stats.block++; log('✕', 'bad', it);
          } else if (it.verdict === 'route') {
            if (it.to === 0 && g.items.indexOf(it) === 3) st.setMark('bad', ['s1']);
            stats.pass++; log('→', 'ok', it);
            await st.fly(['guard', 's' + it.to], { color: 'var(--ok)', label: it.label, speed: 220 });
          } else {
            if (it.verdict === 'alert') { stats.alert++; this.flag(st, at); log('⚠', 'warn', it); } else log('✓', 'ok', it);
            stats.pass++;
            await st.fly(['guard', 'dst'], { color: it.verdict === 'alert' ? 'var(--warn)' : 'var(--ok)', label: it.label, speed: 220 });
          }
          counters();
          await c.wait(0.7);
        }
        st.setMark('bad', []);
        await c.wait(1.5);
      }
    } catch (e) { ignoreCancel(e); }
  },
  // Значок тревоги над сторожем (IDS пропускает, но сигналит)
  flag(st, p) {
    const t = sv('text', { class: 'blocked-x alert-x', x: p.x, y: p.y - 36, text: '⚠' });
    st.gDots.append(t);
    t.animate?.([{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: 1200 });
    setTimeout(() => t.remove(), 1250);
  },

  /* --- Хеширование: живой пример --- */
  buildHash() {
    const row = (label, value) => {
      const inp = h('input', { type: 'text', class: 'hash-in', value, 'aria-label': label, autocomplete: 'off', spellcheck: 'false' });
      const out = h('code', { class: 'hash-out' });
      return { el: h('label', { class: 'hash-row' }, h('span', { text: label }), inp, out), inp, out };
    };
    const a = row('Пароль', 'kotik123'), b = row('Почти такой же', 'kotik124');
    const verdict = h('div', { class: 'status' });
    const update = async () => {
      const [ha, hb] = await Promise.all([hashText(a.inp.value), hashText(b.inp.value)]);
      a.out.textContent = ha;
      b.out.textContent = hb;
      const same = ha === hb;
      verdict.className = 'status ' + (same ? 'ok' : 'wait');
      verdict.textContent = same ? '✓ Отпечатки совпали — значит, пароли одинаковые. Так сайт и проверяет пароль при входе.'
        : '✕ Отпечатки совсем разные, хотя пароли отличаются одним символом. По отпечатку нельзя угадать даже «похожий» пароль.';
    };
    [a, b].forEach(r => r.inp.addEventListener('input', update));
    update();
    return h('div', { class: 'panel' },
      h('div', { class: 'small-title', text: 'Попробуй: пароль → отпечаток (хеш)' }),
      a.el, b.el, verdict,
      h('p', { class: 'hint', text: SECURITY.hashNote }));
  },
};

// SHA-256 через встроенную криптографию браузера; если её нет (например, файл открыт без сервера) — учебная замена
async function hashText(text) {
  try {
    if (window.crypto?.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
    }
  } catch { /* упадём на запасной вариант */ }
  return fakeCipher(text, 32).replace(/ /g, '');
}

/* =====================================================================
   5. НАВИГАЦИЯ И ГЛАВНЫЙ ЦИКЛ
   ===================================================================== */
const SCREEN_IMPL = {
  start: StartScreen, map: MapScreen, request: RequestScreen, layers: LayersScreen, api: ApiScreen,
  osi: OsiScreen, addr: AddrScreen, hardware: HardwareScreen, tcpudp: TcpUdpScreen, dns: DnsScreen,
  firewall: FirewallScreen, web: WebScreen,
  url: UrlScreen, ssh: SshScreen, terminal: TerminalScreen, diag: DiagScreen,
  protocols: ProtocolsScreen, security: SecurityScreen, glossary: GlossaryScreen,
};

/* Навигация в две строки: сверху разделы (NAV_GROUPS), снизу экраны выбранного раздела.
   Нажатие на раздел только показывает его экраны, переход — по нажатию на экран.
   Номер экрана = его индекс в SCREENS («С чего начать» — нулевой, со значком). */
function buildNav() {
  $('#nav-groups').append(...NAV_GROUPS.map(g => h('button', {
    class: 'group-btn', type: 'button', 'data-group': g.id, 'data-tip': g.about, onclick: () => showGroup(g.id),
  }, g.title)));
  $('#nav').append(...SCREENS.map((sc, i) => h('a', { class: 'nav-item', href: '#' + sc.id, 'data-id': sc.id, 'data-group': sc.group, 'data-tip': sc.title },
    h('span', { class: 'num' }, i === 0 ? icon('play') : String(i)), h('span', { class: 'lbl', text: sc.short }))));
}
function showGroup(gid) {
  const cur = SCREENS.find(s => s.id === App.current);
  $$('.group-btn').forEach(b => {
    b.classList.toggle('open', b.dataset.group === gid);
    b.classList.toggle('has-current', !!cur && b.dataset.group === cur.group);
    b.setAttribute('aria-expanded', String(b.dataset.group === gid));
  });
  $$('.nav-item').forEach(a => { a.hidden = a.dataset.group !== gid; });
}

// Заголовок экрана и кнопки «предыдущий / следующий» внизу
function buildHeadAndFoot(id) {
  const i = SCREENS.findIndex(s => s.id === id);
  const sc = SCREENS[i];
  const sec = $('#screen-' + id);
  const group = NAV_GROUPS.find(g => g.id === sc.group);
  sec.prepend(h('header', { class: 'screen-head' },
    h('div', { class: 'eyebrow', text: i === 0 ? 'Начало' : `${group.title} · экран ${i} из ${SCREENS.length - 1}` }),
    h('h2', { text: sc.title }),
    h('p', { class: 'lead', text: sc.lead }),
    LEGEND_SCREENS.has(id) ? legendBar() : null));
  const prev = SCREENS[i - 1], next = SCREENS[i + 1];
  sec.append(h('footer', { class: 'screen-foot' },
    prev ? h('a', { class: 'btn ghost', href: '#' + prev.id }, icon('prev'), prev.title) : h('span'),
    next ? h('a', { class: 'btn primary', href: '#' + next.id }, next.title, icon('next')) : h('a', { class: 'btn ghost', href: '#' + SCREENS[0].id }, 'В начало', icon('restart'))));
}

function go(id) {
  if (!SCREEN_IMPL[id]) { id = SCREENS[0].id; history.replaceState(null, '', '#' + id); }
  if (App.current === id) return;
  $$('.screen').forEach(s => s.classList.toggle('active', s.dataset.screen === id));
  $$('.nav-item').forEach(a => {
    const on = a.dataset.id === id;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  Highlight.clear();
  if (TermPanel.dlg?.open) TermPanel.close();
  App.current = id;
  updateMobileNav(id);
  showGroup(SCREENS.find(s => s.id === id).group);
  $('.nav-item.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  // Экран инициализируется при первом показе, когда уже известны его размеры
  if (!App.inited.has(id)) {
    App.inited.add(id);
    buildHeadAndFoot(id);
    const sec = $('#screen-' + id);
    SCREEN_IMPL[id].init(sec);
    EXTRAS[id]?.(sec);
    TermLinker.run(sec);  // таблетки в статичном и только что созданном тексте, в порядке чтения
  }
  const i = SCREENS.findIndex(s => s.id === id);
  document.title = `${SCREENS[i].title} — Как устроен интернет`;
  window.scrollTo(0, 0);
}
// Экраны, где есть схема или цветные слои — у них вверху кликабельная легенда
const LEGEND_SCREENS = new Set(['map', 'request', 'layers', 'osi', 'addr', 'hardware', 'tcpudp', 'dns', 'firewall', 'web', 'url', 'ssh', 'terminal', 'diag', 'protocols', 'security']);

function boot() {
  // Цвета слоёв из data.js → CSS-переменные --l-*
  for (const [k, l] of Object.entries(LAYERS)) document.documentElement.style.setProperty('--l-' + k, l.color);
  buildNav();
  buildMobileNav();
  initTooltips();
  TermLinker.init();
  TermPanel.init();
  TermLinker.observe($('#main'));
  // Высота шапки → CSS-переменная (для «липких» панелей и прокрутки к якорям)
  const topbar = $('.topbar');
  const setTopbarH = () => document.documentElement.style.setProperty('--topbar-h', topbar.offsetHeight + 'px');
  setTopbarH();
  if ('ResizeObserver' in window) new ResizeObserver(setTopbarH).observe(topbar);
  window.addEventListener('hashchange', () => go(location.hash.slice(1)));
  go(location.hash.slice(1) || SCREENS[0].id);

  /* ГЛАВНЫЙ ЦИКЛ АНИМАЦИИ: один requestAnimationFrame на всё приложение.
     Тикают только часы открытого экрана; dt ограничен 50 мс, чтобы после
     переключения вкладки браузера пакеты не «телепортировались». */
  let last = performance.now();
  const frame = now => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!document.hidden) SCREEN_IMPL[App.current]?.clocks?.forEach(c => c.step(dt));
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // Работа без сети (только по http/https: при открытии файла двойным кликом не нужно)
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* не страшно: просто не будет офлайн-режима */ });
  }
}

boot();
