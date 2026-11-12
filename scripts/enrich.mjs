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

async function j(url, headers = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── 最后 commit 时间 ────────────────────────────────────────────────────────
const LAST_COMMIT = {
  async github({ owner, repo }, token) {
    const h = token ? { Authorization: `Bearer ${token}` } : {};
    const d = await j(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`, h);
    return d?.[0]?.commit?.committer?.date ?? null;
  },
  async gitee({ owner, repo }, token) {
    const q = token ? `&access_token=${encodeURIComponent(token)}` : '';
    const d = await j(`https://gitee.com/api/v5/repos/${owner}/${repo}/commits?per_page=1${q}`);
    return d?.[0]?.commit?.committer?.date ?? null;
  },
  async gitlab({ owner, repo }) {
    const pid = encodeURIComponent(`${owner}/${repo}`);
    const d = await j(`https://gitlab.com/api/v4/projects/${pid}/repository/commits?per_page=1`);
    return d?.[0]?.committed_date ?? null;
  },
  async bitbucket({ owner, repo }) {
    const d = await j(`https://api.bitbucket.org/2.0/repositories/${owner}/${repo}/commits?pagelen=1`);
    return d?.values?.[0]?.date ?? null;
  },
};

// ── license（仓库对象缺字段时的兜底：读 LICENSE 文件首行判定） ───────────────
const LICENSE_PROBE = {
  async gitlab({ owner, repo }) {
    return probeGitlabLicense(owner, repo);
  },
  async bitbucket({ owner, repo }) {
    return probeBitbucketLicense(owner, repo);
  },
};

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
export function identifyLicense(text) {
  const head = text.slice(0, 1200);
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
export async function enrich(entry, ref, { tokens = {} } = {}) {
  const platform = ref.platform;
  const out = { ...entry };

  const lc = LAST_COMMIT[platform];
  if (lc && ref.owner && ref.repo) {
    try {
      out.lastCommit = await lc({ owner: ref.owner, repo: ref.repo }, tokens[platform]) ?? out.lastCommit;
    } catch { /* 保留原值 */ }
  }

  if (!out.license) {
    const probe = LICENSE_PROBE[platform];
    if (probe) {
      try {
        out.license = await probe({ owner: ref.owner, repo: ref.repo }) ?? null;
      } catch { /* 留空 */ }
    }
  }
  return out;
}
