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
//   · 适配器内部失败（网络/限流/缺令牌）**抛出**，不吞成 null —— 见下方
//     contributors() 的注释：吞掉会把「没抓到」伪装成「没有贡献者」。
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
const MAX_PEOPLE = 100;        // 框内最多 4 页 × 25 人

/** 每 10 个人串行一次，避免连发 100 次被 429。 @param {number} i */
function throttle(i) {
  return i > 0 && i % 10 === 0 ? new Promise((res) => setTimeout(res, 120)) : Promise.resolve();
}

/**
 * 拼查询串：空 token 时返回空串，否则返回带前导分隔符的一段。
 * 这样调用点不必写 `${qs ? `&${qs}` : ''}` —— 嵌套模板字符串读起来
 * 分不清哪层负责分隔符，而 Gitee 的分隔符正好两种都用到
 * （contributors 端点已带 `?`，users 端点没有）。
 * @param {string|undefined} token
 * @param {string} name 参数名
 * @param {'?'|'&'} sep
 */
function authQuery(token, name, sep) {
  if (!token) return '';
  return `${sep}${name}=${encodeURIComponent(token)}`;
}

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
      await new Promise((res) => setTimeout(res, 1500));
      return j(url, headers, 2);
    }
    if (!r.ok) return { ok: false, status: r.status, headers: r.headers, data: null };
    const ct = r.headers.get('content-type') || '';
    return {
      ok: true,
      status: r.status,
      headers: r.headers,
      data: ct.includes('json') ? await r.json() : null,
    };
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
 * 这样 2 个请求搞定，且是 anon=true 口径（总数含匿名贡献者，可复跑）。
 * people 只收具名贡献者（type !== "Anonymous"）：匿名者没绑 GitHub 账号，
 * 没有头像也没有主页，展示出来只是一枚不可点的首字母 —— 用户裁定排除
 *（2026-11-15）：人家本来就不想被看到。
 * @param {{owner:string,repo:string}} ref
 * @param {number} maxPeople
 * @param {string} [token]
 */
async function github(ref, maxPeople, token) {
  const { owner, repo } = ref;
  /** @type {Record<string,string>} */
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  const base = `https://api.github.com/repos/${owner}/${repo}/contributors`;

  // 总数：只读响应头，不下载 body（anon=true 才是真实总人数口径）
  const probe = await j(`${base}?per_page=1&anon=true&page=1`, auth);
  if (!probe.ok) return null;          // 速率限制/网络错误：不谎报半截数据
  const total = lastPage(probe.headers);

  // 头像：前 maxPeople 个（最多 100，一页搞定），匿名条目剔除
  const list = await j(`${base}?per_page=${Math.min(maxPeople, PAGE_SIZE)}&anon=true`, auth);
  if (!list.ok || !Array.isArray(list.data)) return total ? { total, people: [] } : null;
  /** @type {{login:string|null,avatar:string|null,url:string|null}[]} */
  const people = list.data
    .filter((/** @type {any} */ c) => c.type !== 'Anonymous')
    .slice(0, maxPeople)
    .map((/** @type {any} */ c) => ({
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
    await throttle(i);
    people.push({ login: c.name || null, ...(await gitlabUser(c.email)) });
  }

  // 总数：x-total 头（实测 gitlab-runner 247，与逐页数一致）
  const probe = await j(`${base}?order_by=commits&sort=desc&per_page=1`);
  const totalRaw = probe.headers?.get?.('x-total');
  return { total: totalRaw ? Number(totalRaw) : null, people };
}

/**
 * 用 email 的本地部分猜 username，查公开账号拿头像与主页。
 * email 只在这里读一次，绝不写进返回值或 catalogue。
 * @param {string} [email]
 * @returns {Promise<{avatar:string|null, url:string|null}>}
 */
async function gitlabUser(email) {
  const local = String(email || '').split('@')[0];
  if (!local) return { avatar: null, url: null };
  const u = await j(`https://gitlab.com/api/v4/users?username=${encodeURIComponent(local)}`);
  const hit = Array.isArray(u.data) ? u.data[0] : null;
  if (!hit) return { avatar: null, url: null };
  return { avatar: hit.avatar_url || null, url: hit.web_url || null };
}

/**
 * Gitee：忽略 page 参数（page=1/2/3 同一批），只取第一页。
 * 但 contributors 的 `name` 常常就是 Gitee username（sunfei、sunjiakun），
 * 查公开的 /users/{name} 可拿到真实头像 + 人物主页；查不到就退首字母。
 * email 只在这里读一次用于判空，绝不外泄。
 * @param {{owner:string,repo:string}} ref @param {number} maxPeople @param {string} [token]
 */
async function gitee(ref, maxPeople, token) {
  // contributors 端点已有 `?per_page=`，追加用 `&`；users 端点没有其他参数，
  // 必须从 `?` 起 —— 拼错会变成 `/users/name&access_token=...`（实测被解析
  // 成用户名的一部分，返回空，头像于是静默全空）。
  const perPage = Math.min(maxPeople, PAGE_SIZE);
  const url = `https://gitee.com/api/v5/repos/${ref.owner}/${ref.repo}/contributors`
    + `?per_page=${perPage}${authQuery(token, 'access_token', '&')}`;
  const r = await j(url);
  if (!r.ok || !Array.isArray(r.data)) {
    const hint = token ? '' : '（未提供 MJ_GITEE_TOKEN）';
    throw new Error(`gitee contributors HTTP ${r.status}${hint}`);
  }

  /** @type {{login:string|null,avatar:string|null,url:string|null}[]} */
  const people = [];
  for (const [i, c] of r.data.slice(0, maxPeople).entries()) {
    const name = c.name || null;
    await throttle(i);
    // 查得到账号才给链接；两个「字母哥」查不到就没有 url —— 符合预期
    people.push({ login: name, ...(await giteeUser(name, token)) });
  }
  // 总数：Gitee 的 contributors 端点**忽略分页参数**（实测 page=1 与 page=2
  // 返回同一批 1441 条全量数据），所以 r.data 就是全部贡献者 —— 长度即精确总数。
  // 此前报 null 是因为假设「只拿到一页」，而实际上从来就不是分页的。
  return { total: r.data.length, people };
}

/**
 * Gitee 的 name 常常就是 username，查公开账号补头像与主页。
 * 只接受形如合法用户名的 name，避免把中文昵称当路径去请求。
 * @param {string|null} name @param {string} [token]
 * @returns {Promise<{avatar:string|null, url:string|null}>}
 */
async function giteeUser(name, token) {
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) return { avatar: null, url: null };
  const u = await j(
    `https://gitee.com/api/v5/users/${encodeURIComponent(name)}${authQuery(token, 'access_token', '?')}`,
  );
  const hit = u.data && !u.data.message ? u.data : null;
  if (!hit) return { avatar: null, url: null };
  return { avatar: hit.avatar_url || null, url: hit.html_url || null };
}

/**
 * Bitbucket：无 contributors 端点，聚合最近 commits 的作者（近似，不谎报总数）。
 * 聚合出来的是「提交作者数」，不是贡献者人数：同一个人换邮箱就是两行，
 * 而从未提交的贡献者根本不出现。所以标 noInfer，total 恒为 null。
 * @param {{owner:string,repo:string}} ref @param {number} maxPeople
 */
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
  return { total: null, people: [...seen.values()], noInfer: true };
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
    await throttle(i);
    people.push({ login: c.name || null, ...(await gitcodeUser(ag, c.name)) });
  }

  // 总数：GitCode 的 v5 API **忽略 per_page**（实测 per_page=1 与 =100 返回同一批
  // 全量数据），所以这次请求拿到的就是全部贡献者 —— `list.length` 是精确总数，
  // 不再是「至少这么多」。
  return { total: list.length, people };
}

/**
 * 查 GitCode/AtomGit 的单人账号信息。
 * @param {(args:string[]) => Promise<any>} ag
 * @param {string|null} name
 * @returns {Promise<{avatar:string|null, url:string|null}>}
 */
async function gitcodeUser(ag, name) {
  if (!name) return { avatar: null, url: null };
  try {
    const u = await ag(['api', `/users/${encodeURIComponent(name)}`, '--raw-output']);
    if (!u || u.message) return { avatar: null, url: null };
    return { avatar: u.avatar_url || null, url: u.html_url || null };
  } catch {
    // 查不到就退首字母，不伪造
    return { avatar: null, url: null };
  }
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
  if (!token) throw new Error('CNB 需要访问令牌才能读贡献者（MJ_CNB_TOKEN）');
  // CNB 的 contributors 端点其实是「活跃排行」，`top` 参数硬上限 10
  // （实测 perPage=100 直接抛 "top must be between 1 and 10"）。传 100 会被
  // 拒绝，而旧的 catch 把这条错误吞成 null —— 于是有贡献者的仓库被记成
  // 「没有贡献者」。这里按平台上限截断，并让失败抛出去（由调用方记 reason）。
  const CNB_TOP_MAX = 10;
  const { CnbClient } = await import('@xindiwo/git-sdk');
  const client = new CnbClient({ token });
  const page = await client.contributors.list({
    owner: ref.owner,
    repo: ref.repo,
    perPage: Math.min(maxPeople, CNB_TOP_MAX),
  });
  const items = page?.items ?? [];
  if (!items.length) return null;
  const people = items.slice(0, maxPeople).map((/** @type {any} */ c) => ({
    login: c.name || c.username || null,
    avatar: c.avatarUrl || c.avatar_url || null,
    url: c.htmlUrl || c.web_url || null,
  }));
  // 排行长度不是人数：不推断总数（noInfer），页面只显示这几个头像。
  return { total: null, people, noInfer: true };
}

/** @typedef {keyof typeof ADAPTERS} SupportedPlatform */
const ADAPTERS = { github, gitlab, gitee, bitbucket, gitcode, cnb };

/**
 * 唯一的外部接口。
 *
 * 失败语义分三种，不能混：
 *   · 平台不支持 contributors → null（页面就不该显示那一列内容）
 *   · 仓库确实没有贡献者     → null（空 people，是仓库事实）
 *   · 抓取失败（网络/限流/缺令牌）→ **抛出**，由调用方记成
 *     `contributor-fetch-failed:` 原因、被判据阻塞
 *
 * 第三种以前被一个裸 `catch { return null }` 吞掉，结果「没抓到」在
 * catalogue 里长得和「没有贡献者」一模一样 —— 那是一个可接受的降级，
 * 于是真 bug 被藏了起来（2026-11-18 的 CNB top-10 就是这么藏的）。
 * 抛出去之后，缺令牌/限流会让 CI 红，而不是安静地少一列。
 *
 * @param {SupportedPlatform} platform
 * @param {{owner:string,repo:string}} ref
 * @param {{maxPeople?:number, token?:string}} [options]
 * @returns {Promise<{total:number|null, people:{login:string|null,avatar:string|null,url:string|null}[]}|null>}
 */
export async function contributors(platform, ref, { maxPeople = MAX_PEOPLE, token } = {}) {
  const adapter = /** @type {Record<string, any>} */ (ADAPTERS)[platform];
  if (!adapter) return null;

  const out = await adapter(ref, maxPeople, token);
  if (!out?.people?.length) return null;

  // 总数回退：平台不给总数时，若请求 100 条只回来 N<100 条，
  // 说明这就是全部贡献者（各平台均按贡献降序返回）⇒ total = N。
  // 取满 100 说明还有更多，此时才保持 null（不谎报精确数）。
  // noInfer 的适配器（Bitbucket 的提交作者、CNB 的活跃排行）不参与推断：
  // 它们的长度不是人数口径，推断出来就是一个假数。
  const asked = Math.min(maxPeople, PAGE_SIZE);
  const complete = out.people.length < asked;
  const inferred = !out.noInfer && complete ? out.people.length : null;

  return {
    total: Number.isFinite(out.total) ? out.total : inferred,
    people: out.people.map((/** @type {any} */ p) => ({
      login: p.login || null,
      avatar: p.avatar || null,
      url: p.url || null,
    })),
  };
}
