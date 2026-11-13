/* FaceGrid — Contributors 视图模块。
 *
 * Interface（调用方只需知道这一行）：
 *   createFaceGrid({ people, total, label }) → HTMLElement
 *     · people: [{ login, avatar, url }]，已按贡献排序
 *     · total:  真实总人数或 null（null 时不显示数量泡泡）
 *     · 返回一个自包含的 DOM 元素，插进 td 即可
 *
 * 实现里藏起来的行为（调用方一概不需要知道）：
 *   · 平铺最多 5 个头像，固定间距，不足 5 个也不变；没有薯片叠、没有架子
 *   · 数量泡泡（total）：桌面悬停展开大框；触屏点击后长期展开
 *   · 大框：最多 25 人/页，网格在 1×1 到 5×5 之间按当页人数自动排
 *   · 换页：滚轮上下 / 触屏水平滑动；页面从右到左切换；无按钮，
 *     只有一个小小的双向箭头标记表示「可翻页」
 *   · 头像全部外链（不托管），失败退首字母
 *
 * 这个模块的 seam 就是 createFaceGrid 那一行：把整个交互换掉，
 * 不用碰 catalog 渲染逻辑，也不用碰数据模块。
 */

const TILE = 40;          // 平铺头像边长
const GAP = 6;            // 平铺间距（固定，不随数量变）
const PAGE_SIZE = 25;     // 大框每页最多 25 人
const MAX_COLS = 5;       // 网格最多 5 列（1×1 ~ 5×5）

/** HTML 转义。 */
const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * 一张脸：有头像用外链 img（懒加载交给 IntersectionObserver），
 * 没有就首字母。加载失败退首字母。
 * @param {{login?:string|null, avatar?:string|null, url?:string|null}} person
 * @returns {HTMLElement}
 */
function face(person) {
  const name = person.login || '';
  const ch = name.trim().charAt(0);
  const initial = ch ? ch.toUpperCase() : '·';
  const el = document.createElement(person.url ? 'a' : 'span');
  el.className = 'face';
  if (person.url) {
    el.href = person.url;
    el.target = '_blank';
    el.rel = 'noopener';
  }
  el.title = name;
  el.setAttribute('aria-label', name);
  el.textContent = initial;

  if (person.avatar) {
    const img = new Image();
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onerror = () => { el.textContent = initial; el.classList.add('initial'); };
    // 图片由 reveal 机制统一挂 src（避免隐藏的大框一次性拉 100 张）
    img.dataset.src = person.avatar;
    el.appendChild(img);
    el.dataset.hasImage = '1';
  }
  return el;
}

/** 只给「当前可见」的脸挂 src。大框换页后调用一次。 */
function reveal(root) {
  for (const img of root.querySelectorAll('img[data-src]')) {
    img.src = img.dataset.src;
    delete img.dataset.src;
  }
}

/**
 * 大框：把 people 切成页，按当页人数决定网格列数（1×1 ~ 5×5）。
 * @param {{login?:string|null, avatar?:string|null, url?:string|null}[]} people
 * @param {HTMLElement} host 泡泡元素（大框挂在它里面）
 */
function createPanel(people, host) {
  const pages = [];
  for (let i = 0; i < people.length; i += PAGE_SIZE) {
    pages.push(people.slice(i, i + PAGE_SIZE));
  }
  if (!pages.length) return null;

  const panel = document.createElement('div');
  panel.className = 'fg-panel';

  const stage = document.createElement('div');
  stage.className = 'fg-stage';

  // 双向箭头：只是指示标记，不是按钮
  const hint = document.createElement('span');
  hint.className = 'fg-hint';
  hint.textContent = pages.length > 1 ? '↔' : '';
  hint.setAttribute('aria-hidden', 'true');

  let page = 0;
  let animating = false;

  function renderPage(direction) {
    const list = pages[page];
    const cols = Math.max(1, Math.min(MAX_COLS, Math.ceil(Math.sqrt(list.length))));
    const rows = Math.ceil(list.length / cols);

    const grid = document.createElement('div');
    grid.className = 'fg-grid';
    grid.style.gridTemplateColumns = `repeat(${cols}, ${TILE}px)`;
    grid.style.gridTemplateRows = `repeat(${rows}, ${TILE}px)`;
    for (const p of list) grid.appendChild(face(p));

    // 从右到左换页：新页从右侧进，旧页往左出
    if (direction !== 0 && stage.firstChild) {
      const old = stage.firstChild;
      old.classList.add(direction > 0 ? 'fg-leave-left' : 'fg-leave-right');
      old.addEventListener('animationend', () => old.remove(), { once: true });
    }
    if (direction > 0) grid.classList.add('fg-enter-right');
    else if (direction < 0) grid.classList.add('fg-enter-left');
    stage.appendChild(grid);
    reveal(grid);

    hint.textContent = pages.length > 1 ? '↔' : '';
    hint.dataset.page = `${page + 1}/${pages.length}`;
  }

  function go(delta) {
    if (pages.length < 2 || animating) return;
    const next = page + delta;
    if (next < 0 || next >= pages.length) return;
    animating = true;
    page = next;
    renderPage(delta);
    setTimeout(() => { animating = false; }, 220);
  }

  // 滚轮：上下都映射为换页（上一页/下一页）
  panel.addEventListener('wheel', ev => {
    if (pages.length < 2) return;
    ev.preventDefault();
    go(ev.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  // 触屏滑动：水平方向换页
  let touchX = null;
  panel.addEventListener('touchstart', ev => { touchX = ev.touches[0].clientX; }, { passive: true });
  panel.addEventListener('touchend', ev => {
    if (touchX === null) return;
    const dx = ev.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 30) go(dx < 0 ? 1 : -1);
  }, { passive: true });

  renderPage(0);
  panel.appendChild(stage);
  panel.appendChild(hint);
  return panel;
}

/**
 * 唯一外部接口。
 * @param {{people:{login?:string|null,avatar?:string|null,url?:string|null}[], total:number|null, label?:string}} opts
 * @returns {HTMLElement}
 */
export function createFaceGrid({ people, total, label = 'contributors' }) {
  const root = document.createElement('span');
  root.className = 'fg-root';

  // 1) 平铺：最多 5 个，固定间距，不叠、不摊开、不放大挤开
  const row = document.createElement('span');
  row.className = 'fg-row';
  for (const p of people.slice(0, 5)) row.appendChild(face(p));
  root.appendChild(row);
  reveal(row);

  // 2) 数量泡泡：唯一的大框触发器
  if (total !== null && total !== undefined) {
    const bubble = document.createElement('button');
    bubble.className = 'fg-bubble';
    bubble.type = 'button';
    // 数量文字独立成节点：panel 挂在 bubble 内（absolute 定位），
    // 否则 textContent 会把框里的首字母也算进「数量」。
    const num = document.createElement('span');
    num.className = 'fg-num';
    num.textContent = String(total);
    bubble.appendChild(num);
    bubble.title = `${total} ${label}`;
    bubble.setAttribute('aria-label', `${total} ${label}`);

    const panel = createPanel(people, bubble);
    if (panel) {
      bubble.appendChild(panel);

      // 桌面：悬停展开（0.4s 开关延迟消除缝隙抖动，但「正在看」不自动关）
      const OPEN_DELAY = 400;
      const CLOSE_DELAY = 400;
      let openTimer = null;
      let closeTimer = null;
      const show = () => {
        clearTimeout(closeTimer); closeTimer = null;
        if (bubble.classList.contains('is-shown')) return;
        clearTimeout(openTimer);
        openTimer = setTimeout(() => bubble.classList.add('is-shown'), OPEN_DELAY);
      };
      const hide = () => {
        clearTimeout(openTimer); openTimer = null;
        if (!bubble.classList.contains('is-shown')) return;
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => bubble.classList.remove('is-shown'), CLOSE_DELAY);
      };
      bubble.addEventListener('mouseenter', show);
      bubble.addEventListener('mouseleave', hide);
      panel.addEventListener('mouseenter', () => { clearTimeout(closeTimer); closeTimer = null; });
      panel.addEventListener('mouseleave', hide);

      // 触屏：点击长期展示；再点收起
      bubble.addEventListener('click', ev => {
        if (window.matchMedia('(hover: none)').matches) {
          ev.preventDefault();
          clearTimeout(openTimer); clearTimeout(closeTimer);
          bubble.classList.toggle('is-shown');
        }
      });
    }
    root.appendChild(bubble);
  }

  return root;
}
