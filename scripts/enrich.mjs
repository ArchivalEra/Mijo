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

/**
 * @param {string} url
 * @param {Record<string,string>} [headers]
 * @returns {Promise<any>}
 */
/**
 * @param {string} url
 * @param {Record<string,string>} [headers]
 * @returns {Promise<any>}
 */
async function j(url, headers = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
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

/** 从 LICENSE 正文首段识别 SPDX 标识。只认确定无疑的几种，认不出就返回 null。 */
/**
 * @param {string} text LICENSE 文件正文
 * @returns {string|null} SPDX 标识，认不出返回 null
 */
/** @param {string} text @returns {string|null} */
export function identifyLicense(text) {
  const head = text.slice(0, 1200);
  /** @param {RegExp} re */
  const has = (re) => re.test(head);
  if (has(/Apache License\s*,?\s*Version 2\.0/i)) return 'Apache-2.0';
  if (has(/MIT License/i) || (has(/Permission is hereby granted, free of charge/i) && has(/MIT/))) return 'MIT';
  if (has(/GNU AFFERO GENERAL PUBLIC LICENSE/i)) return 'AGPL-3.0';
  if (has(/GNU LESSER GENERAL PUBLIC LICENSE/i)) return has(/Version 3/i) ? 'LGPL-3.0' : 'LGPL-2.1';
  if (has(/GNU GENERAL PUBLIC LICENSE/i)) {
    if (has(/Version 3/i)) return 'GPL-3.0';
    if (has(/Version 2/i)) return 'GPL-2.0';
  }
  if (has(/BSD 3-Clause/i) || has(/Redistribution and use in source and binary forms/i) && has(/Neither the name/i)) return 'BSD-3-Clause';
  if (has(/BSD 2-Clause/i)) return 'BSD-2-Clause';
  if (has(/Mozilla Public License\s*Version 2\.0/i)) return 'MPL-2.0';
  if (has(/The Unlicense/i) || has(/This is free and unencumbered software/i)) return 'Unlicense';
  if (has(/ISC License/i)) return 'ISC';
  if (/^\s*MIT\s*$/im.test(head)) return 'MIT';
  return null;
}

/**
 * 补齐单个条目的 lastCommit 与 license。
 * 失败不抛：补不上就保留原值，不因为补充失败而丢掉条目本身。
 */
/**
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
