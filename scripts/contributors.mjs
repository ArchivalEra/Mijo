#!/usr/bin/env node
// contributors：每仓取前 N 个贡献者（默认 5）+ 总数，供页面渲成薯片堆。
//
// 隐私边界（硬）：
//   · 各平台 contributors 端点会返回 **明文 email**（GitLab/Gitee 实测如此）。
//     本模块只挑 login / avatar / url，email 一律不读出、不返回、不落盘。
//   · 落进 catalogue 的字段白名单：login、avatar、url、total。
//
// 各平台能力不同（实测 2026-11-12）：
//   GitHub     有 avatar_url；总数从 per_page=1 的 Link 头 page=N 取
//              （per_page=1 的 page=444 是页码不是人数，真数要翻页核对）
//   GitLab     无 avatar；x-total 给总数；email 一律不读
//   Gitee      无 avatar；无总数（返回前 N 即止）；email 一律不读
//   Bitbucket  无 /contributors 端点，聚合最近 commits 的作者（近似值）
//   其它       暂不支持，返回 null（页面就不渲那堆）

const UA = { 'User-Agent': 'mijo-catalogue' };
const TIMEOUT_MS = 12000;

/**
 * @param {string} url
 * @param {Record<string,string>} [headers]
 * @returns {Promise<{ok:boolean,status:number,headers:any,data:any}>}
 */
async function j(url, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { ...UA, ...headers }, signal: ctrl.signal });
    if (!r.ok) return { ok: false, status: r.status, headers: r.headers, data: null };
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : null;
    return { ok: true, status: r.status, headers: r.headers, data };
  } catch {
    return { ok: false, status: 0, headers: null, data: null };
  } finally {
    clearTimeout(t);
  }
}

/** Link 头里的 rel="last" 页码（配合 per_page=1 即总数）。取不到返回 null。 */
/**
 * @param {any} headers
 * @returns {number|null}
 */
function lastPage(headers) {
  const link = headers?.get?.('link');
  if (!link) return null;
  const m = /[?&]page=(\d+)>;\s*rel="last"/.exec(link);
  return m ? Number(m[1]) : null;
}

// ── GitHub ────────────────────────────────────────────────────────────────────
/**
 * @param {{owner:string,repo:string}} ref
 * @param {number} limit
 * @param {string} [token]
 */
async function github(ref, limit, token) {
  const { owner, repo } = ref;
  /** @type {Record<string,string>} */
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  const base = `https://api.github.com/repos/${owner}/${repo}/contributors`;
  const list = await j(`${base}?per_page=${limit}&anon=false`, auth);
  if (!list.ok || !Array.isArray(list.data)) return null;

  const people = list.data.slice(0, limit).map(c => ({
    login: c.login,
    avatar: c.avatar_url || null,
    url: c.html_url || null,
  }));

  // 总数：per_page=1 只读 Link 头，不翻页（444 页会打爆速率）
  const probe = await j(`${base}?per_page=1&anon=false`, auth);
  const total = lastPage(probe.headers);

  return { people, total };
}

// ── GitLab ────────────────────────────────────────────────────────────────────
/** @param {{owner:string,repo:string}} ref @param {number} limit */
async function gitlab(ref, limit) {
  const { owner, repo } = ref;
  // contributors 用完整路径；只取 name（无 avatar、无 login），email 一律不读
  const pid = encodeURIComponent(`${owner}/${repo}`);
  const url = `https://gitlab.com/api/v4/projects/${pid}/repository/contributors`
    + `?order_by=commits&sort=desc&per_page=${limit}`;
  const r = await j(url);
  if (!r.ok || !Array.isArray(r.data)) return null;

  const people = r.data.slice(0, limit).map(c => ({
    login: c.name || null,
    avatar: null,          // contributors 端点不提供头像
    url: null,
  }));

  // 总数：x-total 头（实测 247）
  const probe = await j(url.replace(/per_page=\d+/, 'per_page=1'));
  const totalRaw = probe.headers?.get?.('x-total');
  const total = totalRaw ? Number(totalRaw) : null;

  return { people, total };
}

// ── Gitee ─────────────────────────────────────────────────────────────────────
/** @param {{owner:string,repo:string}} ref @param {number} limit */
async function gitee(ref, limit) {
  const { owner, repo } = ref;
  const r = await j(`https://gitee.com/api/v5/repos/${owner}/${repo}/contributors?per_page=${limit}`);
  if (!r.ok || !Array.isArray(r.data)) return null;
  const people = r.data.slice(0, limit).map(c => ({
    login: c.name || null,   // 无 login 字段；email 有意不读
    avatar: null,
    url: null,
  }));
  return { people, total: null };   // Gitee 不提供总数
}

// ── Bitbucket（无 contributors 端点，聚合最近 commits 的作者）────────────────
/** @param {{owner:string,repo:string}} ref @param {number} limit */
async function bitbucket(ref, limit) {
  const { owner, repo } = ref;
  const r = await j(`https://api.bitbucket.org/2.0/repositories/${owner}/${repo}/commits?pagelen=50`);
  if (!r.ok || !Array.isArray(r.data?.values)) return null;

  const seen = new Map();
  for (const c of r.data.values) {
    const u = c?.author?.user || {};
    const name = u.display_name || String(c?.author?.raw || '').replace(/\s*<.*$/, '');
    if (!name || seen.has(name)) continue;
    seen.set(name, {
      login: name,
      avatar: u.links?.avatar?.href || null,
      url: u.links?.html?.href || null,
    });
    if (seen.size >= limit) break;
  }
  if (!seen.size) return null;
  // total 只是「最近 50 个提交里出现的不同作者数」，不是真 contributor 总数 —— 不谎报
  return { people: [...seen.values()], total: null };
}

const PLATFORMS = {
  github, gitlab, gitee, bitbucket,
};
/** @typedef {keyof typeof PLATFORMS} SupportedPlatform */

/**
 * 取某仓的 contributors（前 limit 个 + 总数）。
 * 不支持的平台 / 请求失败 ⇒ null（页面就不渲那堆，不显示错误）。
 */
/**
 * @param {SupportedPlatform} platform
 * @param {{owner:string,repo:string}} ref
 * @param {{limit?:number, token?:string}} [options]
 * @returns {Promise<{total:number|null, people:{login:string|null,avatar:string|null,url:string|null}[]}|null>}
 */
export async function contributors(platform, ref, { limit = 5, token } = {}) {
  /** @type {(typeof PLATFORMS)[SupportedPlatform]|undefined} */
  const fn = PLATFORMS[platform];
  if (!fn) return null;
  try {
    const out = await fn(ref, limit, token);
    if (!out || !out.people?.length) return null;
    // 出口再兜一层：只放行白名单字段，email 等一律不外泄
    return {
      total: Number.isFinite(out.total) ? out.total : null,
      people: out.people.map((/** @type {{login:string|null,avatar:string|null,url:string|null}} */ p) => ({
        login: p.login || null,
        avatar: p.avatar || null,
        url: p.url || null,
      })),
    };
  } catch {
    return null;
  }
}
