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
};

// ── license（仓库对象缺字段时的兜底：读 LICENSE 文件首行判定） ───────────────
/** @type {Record<string, (ref: RepoRef) => Promise<string|null>>} */
const LICENSE_PROBE = {
  /** @param {{owner:string,repo:string}} ref */
  async gitlab(ref) { return probeGitlabLicense(ref.owner, ref.repo); },
  /** @param {{owner:string,repo:string}} ref */
  async bitbucket(ref) { return probeBitbucketLicense(ref.owner, ref.repo); },
};

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

  const lc = /** @type {(ref: RepoRef, token?: string) => Promise<string|null>} */ (
    /** @type {Record<string, any>} */ (LAST_COMMIT)[platform]);
  if (lc && ref.owner && ref.repo) {
    try {
      out.lastCommit = await lc({ owner: ref.owner, repo: ref.repo }, tokens[platform]) ?? out.lastCommit;
    } catch { /* 保留原值 */ }
  }

  if (!out.license) {
    /** @type {(ref: RepoRef) => Promise<string|null>} */
    const probe = /** @type {(ref: RepoRef) => Promise<string|null>} */ (
      /** @type {Record<string, any>} */ (LICENSE_PROBE)[platform]);
    if (probe) {
      try {
        out.license = await probe({ owner: ref.owner, repo: ref.repo }) ?? null;
      } catch { /* 留空 */ }
    }
  }
  return out;
}
