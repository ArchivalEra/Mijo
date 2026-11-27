/* 站点纯函数：格式化与 HTML 片段生成，无 DOM、无网络，可单独测试。
 *
 * 抽出来的理由不只是「好测」：这几处各自对应过一次真实的 bug ——
 * 坏日期抛 RangeError 毁掉整张表（formatDay），以及未转义的字段
 * 直接拼进 innerHTML（esc / rowCellsHtml）。
 */

/** 缺口占位。日期、描述、license 缺失时都显示这个。 */
export const DASH = '—';

/** HTML 特殊字符到实体的映射。 */
const ESC_MAP = /** @type {Record<string,string>} */ ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/**
 * 把 HTML 特殊字符转义。catalogue 的字段来自第三方平台，必须转义后再拼 HTML。
 * @param {unknown} v
 * @returns {string}
 */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, /** @param {string} c */ (c) => ESC_MAP[c] ?? c);
}

/**
 * 把 ISO 时间格式化成 `YYYY-MM-DD`。
 *
 * 以前直接 `new Date(x).toISOString()`：一个坏值会抛 RangeError，
 * 而它发生在整表的 innerHTML 拼接里，于是 main() 的 catch 把整张表
 * 换成一行「读取失败」——一条坏数据毁掉全部条目。
 * 现在坏值只让该格显示 `—`。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formatDay(value) {
  if (!value) return DASH;
  const d = new Date(/** @type {string|number} */ (value));
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toISOString().slice(0, 10);
}

/**
 * 仓库链接后面跟来源域名：同名仓库在不同平台上（两个 mindspore：GitCode
 * 与 Gitee）仅看名字无法区分，而链接文字是仓名不是域名。域名是唯一能一眼
 * 分辨的平台事实，且不额外请求数据。
 *
 * @param {string} url
 * @returns {string} 空串表示取不到域名
 */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * 一个条目的四个静态单元格（仓库名+域名 / 描述 / 日期 / license）。
 * 纯字符串，不碰 DOM —— 转义与缺口占位都在这里，所以这里最该被测。
 * 维护者与 contributors 是活的 DOM 节点，由 app.js 插入。
 *
 * @param {import('./app.js').Entry} e
 * @returns {string}
 */
export function rowCellsHtml(e) {
  const host = hostOf(e.url);
  const hostTag = host ? `<span class="repo-host">${esc(host)}</span>` : '';
  return `<td><a class="repo" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.name)}</a>${hostTag}</td>`
    + '<td></td>'
    + '<td></td>'
    + `<td class="desc">${esc(e.description ?? DASH)}</td>`
    + `<td class="num">${esc(formatDay(e.lastCommit))}</td>`
    + `<td class="lic">${esc(e.license ?? DASH)}</td>`;
}

/**
 * 一行渲染失败时的退化行：只保留仓库链接，不因为一个坏条目毁掉整张表。
 * @param {import('./app.js').Entry} e
 * @returns {string}
 */
export function fallbackRowHtml(e) {
  const name = esc(e?.name ?? e?.url);
  return `<td><a class="repo" href="${esc(e?.url)}" target="_blank" rel="noopener">${name}</a></td>`
    + '<td colspan="5" class="desc">这一行渲染失败</td>';
}
