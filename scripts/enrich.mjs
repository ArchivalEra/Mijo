#!/usr/bin/env node
// 各平台补齐：仓库对象里没有的字段（lastCommit / license），用专用端点补。
//
// 为什么需要：仓库对象里的 pushedAt / updatedAt 都不是「最后 commit 时间」
// （实测 Gitee 该仓 updatedAt=2026-11-12，真最后 commit 是 2025-09-13；
// Bitbucket 干脆没有 pushedAt）。license 同理，GitLab/Bitbucket 的仓库对象
// 没有这个字段，只能读 LICENSE 文件判定。
//
// 全部匿名可读（GitHub/Gitee/GitLab/Bitbucket 公开仓），不发写请求。

const UA = { 'User-Agent': 'mijo-catalogue/1' };

/**
 * 用 ag-cli 读 GitCode/AtomGit 的最后 commit 时间（走隔离 XDG，token 不落盘）。
 * 与 generate-catalogue.mjs 的 viaAgCli 同一条通路，这里作为 enrich 的
 * 兜底：平台对象没给时间时再问一次 commits 端点。
 *
 * @param {{owner:string,repo:string}} ref
 * @returns {Promise<string|null>}
 */
async function commitDateViaAgCli(ref) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const binary = process.env.AGCLI_TOKEN
    ? new URL('./ag.sh', import.meta.url).pathname
    : 'ag-cli';
  const { stdout } = await run(
    binary,
    ['commit', 'list', `${ref.owner}/${ref.repo}`, '--limit', '1', '--json', '--raw-output'],
    { maxBuffer: 8 << 20 },
  );
  const commits = JSON.parse(stdout);
  const first = Array.isArray(commits) ? commits[0] : null;
  return first?.date ?? first?.committedDate ?? null;
}

/** 单个补齐请求的超时。与 contributors.mjs 的 TIMEOUT_MS 同口径。 */
const TIMEOUT_MS = 12000;

/**
 * GET + JSON。带超时——没有它，一个挂住的 TCP 连接会把 CI 拖到
 * job 超时（15 分钟），而不是让 enrich 快速失败、保留原值继续。
 * @param {string} url
 * @param {Record<string,string>} [headers]
 * @returns {Promise<any>}
 */
async function j(url, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { ...UA, ...headers }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ── 最后 commit 时间 ────────────────────────────────────────────────────────
/** @typedef {{owner:string,repo:string}} RepoRef */
const LAST_COMMIT = {
  /** @type {Record<string, (ref: RepoRef, token?: string) => Promise<string|null>>} */
  /** @param {{owner:string,repo:string}} ref @param {string} [token] */
  async github(ref, token) {
    const { owner, repo } = ref;
    /** @type {Record<string,string>} */
    const h = token ? { Authorization: `Bearer ${token}` } : {};
    const d = await j(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`, h);
    return d?.[0]?.commit?.committer?.date ?? null;
  },
  /** @param {{owner:string,repo:string}} ref @param {string} [token] */
  async gitee(ref, token) {
    const { owner, repo } = ref;
    const q = token ? `&access_token=${encodeURIComponent(token)}` : '';
    const d = await j(`https://gitee.com/api/v5/repos/${owner}/${repo}/commits?per_page=1${q}`);
    return d?.[0]?.commit?.committer?.date ?? null;
  },
  /** @param {{owner:string,repo:string}} ref */
  async gitlab(ref) {
    const { owner, repo } = ref;
    const pid = encodeURIComponent(`${owner}/${repo}`);
    const d = await j(`https://gitlab.com/api/v4/projects/${pid}/repository/commits?per_page=1`);
    return d?.[0]?.committed_date ?? null;
  },
  /** @param {{owner:string,repo:string}} ref */
  async bitbucket(ref) {
    const { owner, repo } = ref;
    const d = await j(`https://api.bitbucket.org/2.0/repositories/${owner}/${repo}/commits?pagelen=1`);
    return d?.values?.[0]?.date ?? null;
  },
  /**
   * GitCode / AtomGit：走 ag-cli 的 commit list（与 viaAgCli 同一条通路，
   * 但这里作为 enrich 的兜底，用于平台对象没给时间的情形）。
   * @param {{owner:string,repo:string}} ref
   */
  async gitcode(ref) {
    return commitDateViaAgCli(ref);
  },
  /** @param {{owner:string,repo:string}} ref */
  async atomgit(ref) {
    return commitDateViaAgCli(ref);
  },
  /**
   * CNB：SDK 的 commits.list（需要令牌；无令牌时抛错，由调用方记 reason）。
   * @param {{owner:string,repo:string}} ref
   * @param {string} [token]
   */
  async cnb(ref, token) {
    if (!token) throw new Error('CNB 需要访问令牌才能读 commits');
    const { CnbClient } = await import('@xindiwo/git-sdk');
    const client = new CnbClient({ token });
    const page = await client.commits.list({
      owner: ref.owner,
      repo: ref.repo,
      perPage: 1,
    });
    /** SDK 的类型声明在 items 上；运行期若直接给数组也兼容。 */
    const items = /** @type {{items?: {committedAt?: string}[]}} */ (page)?.items
      ?? /** @type {{committedAt?: string}[]} */ (/** @type {unknown} */ (page));
    const first = Array.isArray(items) ? items[0] : null;
    return first?.committedAt ?? null;
  },
};

// ── license（仓库对象缺字段时的兜底：读 LICENSE 文件首行判定） ───────────────
/** @type {Record<string, (ref: RepoRef) => Promise<string|null>>} */
const LICENSE_PROBE = {
  /** @param {{owner:string,repo:string}} ref @param {string} [token] */
  async github(ref, token) { return probeGithubLicense(ref.owner, ref.repo, token); },
  /** @param {{owner:string,repo:string}} ref */
  async gitlab(ref) { return probeGitlabLicense(ref.owner, ref.repo); },
  /** @param {{owner:string,repo:string}} ref */
  async bitbucket(ref) { return probeBitbucketLicense(ref.owner, ref.repo); },
};

/**
 * GitHub：仓库对象报 NOASSERTION 时，读 LICENSE 正文识别 SPDX。
 * 用 Contents API（raw media type），避免 HTML 页面里夹带渲染内容。
 * @param {string} owner @param {string} repo @param {string} [token]
 */
async function probeGithubLicense(owner, repo, token) {
  /** @type {Record<string,string>} */
  const h = { Accept: 'application/vnd.github.raw' };
  if (token) h.Authorization = `Bearer ${token}`;
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'COPYING.md']) {
    try {
      const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${file}`, {
        headers: { ...UA, ...h },
      });
      if (!r.ok) continue;
      return identifyLicense(await r.text());
    } catch { /* 继续 */ }
  }
  return null;
}

/** @param {string} owner @param {string} repo */
async function probeGitlabLicense(owner, repo) {
  const pid = encodeURIComponent(`${owner}/${repo}`);
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']) {
    try {
      const r = await fetch(
        `https://gitlab.com/api/v4/projects/${pid}/repository/files/${file}/raw?ref=HEAD`,
        { headers: UA });
      if (!r.ok) continue;
      return identifyLicense(await r.text());
    } catch { /* 继续试下一个文件名 */ }
  }
  return null;
}

/** @param {string} owner @param {string} repo */
async function probeBitbucketLicense(owner, repo) {
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']) {
    try {
      const r = await fetch(
        `https://api.bitbucket.org/2.0/repositories/${owner}/${repo}/src/HEAD/${file}`,
        { headers: UA });
      if (!r.ok) continue;
      return identifyLicense(await r.text());
    } catch { /* 继续 */ }
  }
  return null;
}

/**
 * LICENSE 正文的识别规则表。顺序即优先级——见 identifyLicense 的注释。
 * 第三项是可选的「同时必须出现」的第二个正则，用于区分共用同一段
 * 措辞的变体（GPL v2/v3、BSD 二/三条款）。
 * @type {[RegExp, string, RegExp?][]}
 */
const LICENSE_SIGNATURES = [
  [/Apache License\s*,?\s*Version 2\.0/i, 'Apache-2.0'],
  [/GNU AFFERO GENERAL PUBLIC LICENSE/i, 'AGPL-3.0'],
  [/GNU LESSER GENERAL PUBLIC LICENSE/i, 'LGPL-3.0', /Version 3/i],
  [/GNU LESSER GENERAL PUBLIC LICENSE/i, 'LGPL-2.1'],
  [/GNU GENERAL PUBLIC LICENSE/i, 'GPL-3.0', /Version 3/i],
  [/GNU GENERAL PUBLIC LICENSE/i, 'GPL-2.0'],
  [/BSD 3-Clause/i, 'BSD-3-Clause'],
  [/Redistribution and use in source and binary forms/i, 'BSD-3-Clause', /Neither the name/i],
  [/BSD 2-Clause/i, 'BSD-2-Clause'],
  [/Mozilla Public License\s*Version 2\.0/i, 'MPL-2.0'],
  [/The Unlicense/i, 'Unlicense'],
  [/This is free and unencumbered software/i, 'Unlicense'],
  [/ISC License/i, 'ISC'],
  [/MIT License/i, 'MIT'],
  [/Permission is hereby granted, free of charge/i, 'MIT', /MIT/],
];

/**
 * 从 LICENSE 正文首段识别 SPDX 标识。只认确定无疑的几种，认不出就返回 null。
 *
 * 规则按「先特殊后一般」排列：AGPL/LGPL 必须先于 GPL 判断，否则
 * "GNU AFFERO GENERAL PUBLIC LICENSE" 会被更宽的 GPL 正则吃掉，
 * 报成 GPL-3.0。BSD-3 也要先于 BSD-2，因为 BSD-3 的正文同样含
 * "Redistribution and use in source and binary forms"。
 *
 * @param {string} text LICENSE 文件正文
 * @returns {string|null} SPDX 标识，认不出返回 null
 */
export function identifyLicense(text) {
  const head = text.slice(0, 1200);
  /** @type {(re:RegExp) => boolean} */
  const has = (re) => re.test(head);

  for (const [primary, id, required] of LICENSE_SIGNATURES) {
    if (has(primary) && (!required || has(required))) return id;
  }
  // 最后一条兜底：整个文件只有 "MIT" 一个词（某些仓的 LICENSE 就一行）。
  if (/^\s*MIT\s*$/im.test(head)) return 'MIT';
  return null;
}

/**
 * 补齐单个条目的 lastCommit 与 license。
 * 失败不抛：补不上就保留原值，不因为补充失败而丢掉条目本身。
 *
 * @param {Record<string,any>} entry catalogue 条目
 * @param {{platform:string, owner:string, repo:string, url:string}} ref
 * @param {{tokens?:Record<string,string>}} [options]
 * @returns {Promise<Record<string,any>>}
 */
export async function enrich(entry, ref, { tokens = {} } = {}) {
  const platform = ref.platform;
  const out = { ...entry };

  // lastCommit：只接受真提交时间。取不到就保持 null，由 completeness 判据
  // 配合 reasons 决定是 degraded 还是 broken——绝不拿 pushedAt 顶替。
  const lc = /** @type {(ref: RepoRef, token?: string) => Promise<string|null>} */ (
    /** @type {Record<string, any>} */ (LAST_COMMIT)[platform]);
  if (lc && ref.owner && ref.repo) {
    try {
      const real = await lc({ owner: ref.owner, repo: ref.repo }, tokens[platform]);
      if (real) out.lastCommit = real;
    } catch { /* 拿不到就留空；原因由调用方按 PLATFORM_LIMITS 装配 */ }
  }

  // GitHub 用 NOASSERTION 表示「有 LICENSE 文件但识别不出 SPDX」——它是
  // 一个「未知」标记而不是 license 名。直接展示对读者没有意义，按缺失处理：
  // 先当空，再走下面的 LICENSE 正文探测；探测也认不出就如实留空（带 reason）。
  if (typeof out.license === 'string' && /^NOASSERTION$/i.test(out.license.trim())) {
    out.license = null;
  }

  if (!out.license) {
    /** @type {(ref: RepoRef, token?: string) => Promise<string|null>} */
    const probe = /** @type {(ref: RepoRef, token?: string) => Promise<string|null>} */ (
      /** @type {Record<string, any>} */ (LICENSE_PROBE)[platform]);
    if (probe) {
      try {
        out.license = await probe({ owner: ref.owner, repo: ref.repo }, tokens[platform]) ?? null;
      } catch { /* 留空 */ }
    }
  }
  return out;
}
