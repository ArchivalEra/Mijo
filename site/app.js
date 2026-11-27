import { createFaceGrid } from './face-grid.js';
import { esc, fallbackRowHtml, rowCellsHtml } from './format.js';

/**
 * One row of catalogue.json.
 * @typedef {Object} Entry
 * @property {string} url
 * @property {string} name
 * @property {string} [description]
 * @property {string} [lastCommit]
 * @property {string} [license]
 * @property {string} [maintainer]
 * @property {string} [avatar]
 * @property {string} [profile]
 * @property {{login?:string|null, avatar?:string|null, url?:string|null}[]} [contributors]
 * @property {number} [contributorTotal]
 */

/**
 * 维护者单元格：单个头像 + 该平台的人物主页链接。
 * 统一建 <a>，无 profile 不设 href；头像加载失败退首字母。
 * @param {Entry} e
 * @returns {HTMLAnchorElement}
 */
function ownerCell(e) {
  const owner = document.createElement('a');
  owner.className = 'face owner-face';
  owner.title = e.maintainer ?? '';
  if (e.profile) {
    owner.href = e.profile;
    owner.target = '_blank';
    owner.rel = 'noopener';
  }
  const initial = (e.maintainer || '?').trim().charAt(0).toUpperCase();
  if (!e.avatar) {
    owner.textContent = initial;
    return owner;
  }
  const img = new Image();
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.loading = 'lazy';
  img.onerror = () => { img.remove(); owner.textContent = initial; };
  img.src = e.avatar;
  owner.appendChild(img);
  return owner;
}

/**
 * 建一整行。单个条目出错只影响这一行——外层的 try/catch 是最后一道
 * 保险，正常路径不该靠它。
 * @param {Entry} e
 * @returns {HTMLTableRowElement}
 */
function buildRow(e) {
  const tr = document.createElement('tr');
  tr.innerHTML = rowCellsHtml(e);

  tr.children[1]?.appendChild(ownerCell(e));

  // Contributors：整个交互藏在 FaceGrid 模块里，这里只有一行
  const cs = e.contributors ?? [];
  if (cs.length) {
    tr.children[2]?.appendChild(createFaceGrid({
      people: cs,
      total: typeof e.contributorTotal === 'number' ? e.contributorTotal : null,
    }));
  }
  return tr;
}

/**
 * 一行坏数据不该让整张表消失：渲染失败时退化成一条只有链接的窄行，
 * 并在控制台留下原因。
 * @param {Entry} e @returns {HTMLTableRowElement}
 */
function fallbackRow(e) {
  const tr = document.createElement('tr');
  tr.innerHTML = fallbackRowHtml(e);
  return tr;
}

/** @param {HTMLElement} rows @param {Entry[]} entries */
function renderRows(rows, entries) {
  if (!entries.length) {
    rows.innerHTML =
      '<tr><td colspan="6" class="empty">暂无条目 —— 往 material/urls.txt 里粘一个 URL。</td></tr>';
    return;
  }
  rows.innerHTML = '';
  for (const e of entries) {
    try {
      rows.appendChild(buildRow(e));
    } catch (err) {
      console.error('catalogue row failed:', e?.url, err);
      rows.appendChild(fallbackRow(e));
    }
  }
}

async function main() {
  const res = await fetch('catalogue.json');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = /** @type {{entries?: Entry[], generatedAt?: string}} */ (await res.json());
  const rows = /** @type {HTMLElement} */ (document.getElementById('rows'));

  renderRows(rows, d.entries ?? []);

  const stamp = document.getElementById('stamp');
  if (stamp && d.generatedAt) {
    stamp.textContent =
      'derived ' + new Date(d.generatedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
}

main().catch(err => {
  const rows = document.getElementById('rows');
  if (rows) {
    rows.innerHTML =
      `<tr><td colspan="6" class="empty">读取 catalogue.json 失败：${esc(err.message)}</td></tr>`;
  }
});
