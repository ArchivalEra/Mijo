import { createFaceGrid } from './face-grid.js';

/** HTML escape for any catalogue field. @param {unknown} v */
const ESC_MAP = /** @type {Record<string,string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });
const esc = /** @param {unknown} v */ (v) => String(v ?? '').replace(/[&<>"']/g, (/** @type {string} */ c) => ESC_MAP[c] ?? c);

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

async function main() {
  const res = await fetch('catalogue.json');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = /** @type {{entries?: Entry[], generatedAt?: string}} */ (await res.json());
  const entries = d.entries ?? [];
  const rows = /** @type {HTMLElement} */ (document.getElementById('rows'));

  if (!entries.length) {
    rows.innerHTML =
      '<tr><td colspan="6" class="empty">暂无条目 —— 往 material/urls.txt 里粘一个 URL。</td></tr>';
  } else {
    rows.innerHTML = '';
    for (const e of entries) {
      const tr = document.createElement('tr');
      const date = e.lastCommit ? new Date(e.lastCommit).toISOString().slice(0, 10) : '—';

      tr.innerHTML =
        `<td><a class="repo" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.name)}</a></td>` +
        `<td></td>` +
        `<td></td>` +
        `<td class="desc">${esc(e.description ?? '—')}</td>` +
        `<td class="num">${esc(date)}</td>` +
        `<td class="lic">${esc(e.license ?? '—')}</td>`;

      // 维护者：单个头像 + 该平台的人物主页链接（统一建 <a>，无 profile 不设 href）
      const owner = document.createElement('a');
      owner.className = 'face owner-face';
      owner.title = e.maintainer ?? '';
      if (e.profile) {
        owner.href = e.profile;
        owner.target = '_blank';
        owner.rel = 'noopener';
      }
      const initial = (e.maintainer || '?').trim().charAt(0).toUpperCase();
      if (e.avatar) {
        const img = new Image();
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.loading = 'lazy';
        img.onerror = () => { img.remove(); owner.textContent = initial; };
        img.src = e.avatar;
        owner.appendChild(img);
      } else {
        owner.textContent = initial;
      }
      tr.children[1]?.appendChild(owner);

      // Contributors：整个交互藏在 FaceGrid 模块里，这里只有一行
      const cs = e.contributors ?? [];
      if (cs.length) {
        tr.children[2]?.appendChild(createFaceGrid({
          people: cs,
          total: typeof e.contributorTotal === 'number' ? e.contributorTotal : null,
        }));
      }

      rows.appendChild(tr);
    }
  }

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
