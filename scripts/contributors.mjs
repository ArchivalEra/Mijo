#!/usr/bin/env node
// Contributors：给定平台与仓库，返回「真实总数 + 一批头像」。
//
// Interface（调用方只需知道这三件事）：
//   contributors(platform, ref, opts?) → Promise<{total:number|null, people:Person[]}|null>
//   · total 是 anon=true 口径的真实人数（含匿名贡献者）。GitHub 用
//     per_page=1 的 Link 头页码取数（每页一条 ⇒ 页码即条数，实测与
//     逐页累计逐字一致）；其余平台逐页累计。三个数要分清：
//     open-design anon=false 444 / anon=true 451 / 网页 ≈505；
//     node 4554。不再把「page1 的数」或其它口径当总数。
//   · people 最多 maxPeople 个，按贡献排序；字段白名单 login/avatar/url
//   · 拿不到就 null（页面静默忽略，不显示错误）
//
// 隐私边界（硬）：GitLab/Gitee 的 contributors 端点返回**明文 email**，
// 本模块只挑白名单字段，email 一律不读出、不返回、不落盘。
//
// 实现里各平台是独立 adapter，共享同一个外接口。新增平台不改调用点。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const UA = { 'User-Agent': 'mijo-catalogue' };
const TIMEOUT_MS = 12000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;          // 2000 人上限，防异常仓打爆速率
const MAX_PEOPLE = 100;        // 框内最多 4 页 × 25 人

/**
 * GET + JSON。429/403（限流）退避重试一次；仍失败就返回 ok:false，
 * 让上层 fail-closed（不产假数）。
 * @param {string} url @param {Record<string,string>} [headers] @param {number} [attempt]
 */
async function j(url, headers = {}, attempt = 1) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { ...UA, ...headers }, signal: ctrl.signal });
    if ((r.status === 429 || r.status === 403) && attempt === 1) {
      clearTimeout(t);
      await new Promise(res => setTimeout(res, 1500));
      return j(url, headers, 2);
    }
    if (!r.ok) return { ok: false, status: r.status, headers: r.headers, data: null };
    const ct = r.headers.get('content-type') || '';
    return { ok: true, status: r.status, headers: r.headers,
             data: ct.includes('json') ? await r.json() : null };
  } catch {
    return { ok: false, status: 0, headers: null, data: null };
  } finally {
    clearTimeout(t);
  }
}

/**
 * GitHub：总数取 `per_page=1&anon=true` 的 Link 头 rel="last" 页码。
 * 每页一条时「页码数 == 条数」，实测 open-design 逐页累计 451 ==
 * Link 页码 451；node 是 4554（逐页数 40 页都不够，会打爆速率）。
 * 这样 2 个请求搞定，且是 anon=true 口径（含匿名贡献者，可复跑）。
 * people 单独取前 maxPeople 个（贡献降序）。
 * @param {{owner:string,repo:string}} ref
 * @param {number} maxPeople
 * @param {string} [token]
 */
async function github(ref, maxPeople, token) {
  const { owner, repo } = ref;
  /** @type {Record<string,string>} */
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  const base = `https://api.github.com/repos/${owner}/${repo}/contributors`;

  // 总数：只读响应头，不下载 body
  const probe = await j(`${base}?per_page=1&anon=true&page=1`, auth);
  if (!probe.ok) return null;          // 速率限制/网络错误：不谎报半截数据
  const total = lastPage(probe.headers);

  // 头像：前 maxPeople 个（最多 100，一页搞定）
  const list = await j(`${base}?per_page=${Math.min(maxPeople, PAGE_SIZE)}&anon=true`, auth);
  if (!list.ok || !Array.isArray(list.data)) return total ? { total, people: [] } : null;
  /** @type {{login:string|null,avatar:string|null,url:string|null}[]} */
  const people = list.data.slice(0, maxPeople).map((/** @type {any} */ c) => ({
    login: c.login ?? null,
    avatar: c.avatar_url ?? null,
    url: c.html_url ?? null,
  }));
  return { total, people };
}

/** @param {any} headers @returns {number|null} */
function lastPage(headers) {
  const link = headers?.get?.('link');
  if (!link) return null;
  const m = /[?&]page=(\d+)>;\s*rel="last"/.exec(link);
  return m ? Number(m[1]) : null;
}

/**
 * GitLab：contributors 端点只给 name + email（email 是隐私，不外泄）。
 * 用 email 的本地部分猜 username，查公开的 /users?username=X 拿头像和主页
 * （实测 7 个贡献者命中 4 个；命不中就退首字母 + 不生成链接）。
 * 总数走 x-total（已验证与逐页数一致），头像只补前 5 个平铺位。
 * @param {{owner:string,repo:string}} ref @param {number} maxPeople
 */
async function gitlab(ref, maxPeople) {
  const pid = encodeURIComponent(`${ref.owner}/${ref.repo}`);
  const base = `https://gitlab.com/api/v4/projects/${pid}/repository/contributors`;
  const r = await j(`${base}?order_by=commits&sort=desc&per_page=${Math.min(maxPeople, PAGE_SIZE)}`);
  if (!r.ok || !Array.isArray(r.data)) return null;

  /** @type {{login:string|null,avatar:string|null,url:string|null}[]} */
  const people = [];
  // 全员查头像（不按位次跳过 —— 跳过的位在页面上会静默变成首字母）。
  // 逐人一次请求，串行 + 轻节流，避免 100 次连发被 429。
  for (const [i, c] of r.data.slice(0, maxPeople).entries()) {
    const name = c.name || null;
    if (i > 0 && i % 10 === 0) await new Promise(res => setTimeout(res, 120));
    // email 只在这里用于猜 username，绝不写进返回值或 catalogue
    const local = String(c.email || '').split('@')[0];
    let avatar = null, url = null;
    if (local) {
      const u = await j(`https://gitlab.com/api/v4/users?username=${encodeURIComponent(local)}`);
      const hit = Array.isArray(u.data) ? u.data[0] : null;
      if (hit) { avatar = hit.avatar_url || null; url = hit.web_url || null; }
    }
    people.push({ login: name, avatar, url });
  }

  // 总数：x-total 头（实测 gitlab-runner 247，与逐页数一致）
  const probe = await j(`${base}?order_by=commits&sort=desc&per_page=1`);
  const totalRaw = probe.headers?.get?.('x-total');
  return { total: totalRaw ? Number(totalRaw) : null, people };
}

/**
 * Gitee：忽略 page 参数（page=1/2/3 同一批），只取第一页，total 报 null。
 * 但 contributors 的 `name` 常常就是 Gitee username（sunfei、sunjiakun），
 * 查公开的 /users/{name} 可拿到真实头像 + 人物主页；查不到就退首字母。
 * email 只在这里读一次用于判空，绝不外泄。
 * @param {{owner:string,repo:string}} ref @param {number} maxPeople
 */
async function gitee(ref, maxPeople) {
  const url = `https://gitee.com/api/v5/repos/${ref.owner}/${ref.repo}/contributors?per_page=${Math.min(maxPeople, PAGE_SIZE)}`;
  const r = await j(url);
  if (!r.ok || !Array.isArray(r.data)) return null;

  /** @type {{login:string|null,avatar:string|null,url:string|null}[]} */
  const people = [];
  for (const [i, c] of r.data.slice(0, maxPeople).entries()) {
    const name = c.name || null;
    let avatar = null, profile = null;
    if (i > 0 && i % 10 === 0) await new Promise(res => setTimeout(res, 120));
    if (name && /^[A-Za-z0-9_.-]+$/.test(name)) {
      const u = await j(`https://gitee.com/api/v5/users/${encodeURIComponent(name)}`);
      const hit = u.data && !u.data.message ? u.data : null;
      if (hit) { avatar = hit.avatar_url || null; profile = hit.html_url || null; }
    }
    // 查得到账号才给链接；两个「字母哥」查不到就没有 url —— 符合预期
    people.push({ login: name, avatar, url: profile });
  }
  return { total: null, people };
}

/** Bitbucket：无 contributors 端点，聚合最近 commits 的作者（近似，不谎报总数）。
 *  @param {{owner:string,repo:string}} ref @param {number} maxPeople */
async function bitbucket(ref, maxPeople) {
  const base = `https://api.bitbucket.org/2.0/repositories/${ref.owner}/${ref.repo}`;
  const seen = new Map();
  for (let page = 1; page <= 3 && seen.size < maxPeople; page++) {
    const r = await j(`${base}/commits?pagelen=${PAGE_SIZE}&page=${page}`);
    if (!r.ok || !Array.isArray(r.data?.values)) break;
    for (const c of r.data.values) {
      const u = c?.author?.user || {};
      const name = u.display_name || String(c?.author?.raw || '').replace(/\s*<.*$/, '');
      if (!name || seen.has(name)) continue;
      seen.set(name, {
        login: name,
        avatar: u.links?.avatar?.href || null,
        url: u.links?.html?.href || null,
      });
      if (seen.size >= maxPeople) break;
    }
    if (r.data.values.length < PAGE_SIZE) break;
  }
  if (!seen.size) return null;
  return { total: null, people: [...seen.values()] };
}

/**
 * GitCode / AtomGit：contributors 走 ag-cli（API 需要令牌，ag-cli 自己带登录态）。
 * 返回 name + contributions + email；email 只用于判空，不外泄。
 * 头像与主页：contributors 的 name 就是 username，查 /users/{name} 拿
 * avatar_url + html_url（实测 mindspore/mindspore 142 人、arkui 158 人）。
 * @param {{owner:string,repo:string}} ref @param {number} maxPeople
 */
async function gitcode(ref, maxPeople) {
  const target = `${ref.owner}/${ref.repo}`;
  /** @type {{login:string|null,avatar:string|null,url:string|null}[]} */
  const people = [];

  // ag-cli 有 AGCLI_TOKEN 时走隔离封装，否则用本机登录态
  const binary = process.env.AGCLI_TOKEN
    ? new URL('./ag.sh', import.meta.url).pathname
    : 'ag-cli';

  /** @param {string[]} args @returns {Promise<any>} */
  const ag = async (args) => {
    const { stdout } = await run(binary, args, { maxBuffer: 16 << 20 });
    return JSON.parse(stdout);
  };

  const listUrl = `/repos/${target}/contributors?per_page=${Math.min(maxPeople, PAGE_SIZE)}`;
  let list;
  try {
    list = await ag(['api', listUrl, '--raw-output']);
  } catch {
    return null;
  }
  if (!Array.isArray(list) || !list.length) return null;

  for (const [i, c] of list.slice(0, maxPeople).entries()) {
    const name = c.name || null;
    let avatar = null, url = null;
    if (i > 0 && i % 10 === 0) await new Promise(res => setTimeout(res, 120));
    if (name) {
      try {
        const u = await ag(['api', `/users/${encodeURIComponent(name)}`, '--raw-output']);
        if (u && !u.message) { avatar = u.avatar_url || null; url = u.html_url || null; }
      } catch { /* 查不到就退首字母，不伪造 */ }
    }
    people.push({ login: name, avatar, url });
  }

  // 总数：ag-cli 的分页头拿不到 x-total，用「第一页满 100 ⇒ 至少 100」的诚实口径：
  // 拿满一页就报 null（不谎报精确数），页面只显示「有这么多头像」。
  return { total: null, people };
}

/**
 * CNB：contributors 走 SDK 的 cnb.contributors.list()，而不是自己拼 REST ——
 * CNB 的响应是**包装对象**（SDK 用 toItems 解 items/data 等包装键），
 * 直接 Array.isArray 判定会误判成空。
 * 接口本体是「活跃用户排行」/-/top-activity-users：按活跃度排序、不带提交数，
 * 所以 total 不可推（标 noInfer，不谎报）。
 * @param {{owner:string,repo:string}} ref @param {number} maxPeople
 */
async function cnb(ref, maxPeople) {
  const token = process.env.MJ_CNB_TOKEN || process.env.CNB_TOKEN;
  if (!token) return null;
  try {
    const { CnbClient } = await import('@xindiwo/git-sdk');
    const client = new CnbClient({ token });
    const page = await client.contributors.list({
      owner: ref.owner, repo: ref.repo, perPage: Math.min(maxPeople, PAGE_SIZE),
    });
    const items = page?.items ?? [];
    if (!items.length) return null;
    const people = items.slice(0, maxPeople).map((/** @type {any} */ c) => ({
      login: c.name || c.username || null,
      avatar: c.avatarUrl || c.avatar_url || null,
      url: c.htmlUrl || c.web_url || null,
    }));
    return { total: null, people, noInfer: true };
  } catch {
    return null;
  }
}

/** @typedef {keyof typeof ADAPTERS} SupportedPlatform */
const ADAPTERS = { github, gitlab, gitee, bitbucket, gitcode, cnb };

/**
 * 唯一的外部接口。
 * @param {SupportedPlatform} platform
 * @param {{owner:string,repo:string}} ref
 * @param {{maxPeople?:number, token?:string}} [options]
 * @returns {Promise<{total:number|null, people:{login:string|null,avatar:string|null,url:string|null}[]}|null>}
 */
export async function contributors(platform, ref, { maxPeople = MAX_PEOPLE, token } = {}) {
  /** @type {((ref:{owner:string,repo:string}, max:number, token?:string)=>Promise<any>)|undefined} */
  const adapter = /** @type {Record<string, any>} */ (ADAPTERS)[platform];
  if (!adapter) return null;
  try {
    const out = await adapter(ref, maxPeople, token);
    if (!out?.people?.length) return null;
    // 总数回退：平台不给总数时，若请求 100 条只回来 N<100 条，
    // 说明这就是全部贡献者（各平台均按贡献降序返回）⇒ total = N。
    // 取满 100 说明还有更多，此时才保持 null（不谎报精确数）。
    const asked = Math.min(maxPeople, PAGE_SIZE);
    const inferred = !out.noInfer && out.people.length < asked ? out.people.length : null;
    return {
      total: Number.isFinite(out.total) ? out.total : inferred,
      people: out.people.map((/** @type {any} */ p) => ({
        login: p.login || null,
        avatar: p.avatar || null,
        url: p.url || null,
      })),
    };
  } catch {
    return null;
  }
}
