#!/usr/bin/env node
// catalogue 派生：material/urls.txt → 拉仓库元数据 → site/catalogue.json
//
// 主通路 ag-cli（AtomGit / GitCode 官方 CLI，已融合后同一套 v5 API）：
//   ag-cli repo view <owner>/<repo> --json   → name / owner / license
//   ag-cli commit list <owner>/<repo> --limit 1 --json → date（最后 commit 时间）
// 兜底通路：非 AtomGit/GitCode 的平台（GitHub / Gitee / CNB / GitLab / Bitbucket）
// 走 @xindiwo/git-sdk。
//
// 令牌：CI 里用 AGCLI_TOKEN 灌一个临时 XDG 目录（见 scripts/ag.sh），
// 命令结束即删；不读 ~/.config、不跑 setup-git、不落盘到用户主目录。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGitSdk } from '@xindiwo/git-sdk';
import { enrich } from './enrich.mjs';
import { contributors } from './contributors.mjs';

const run = promisify(execFile);
const OUT = new URL('../site/catalogue.json', import.meta.url).pathname;
const AG_SH = new URL('./ag.sh', import.meta.url).pathname;

// atomgit.com 与 gitcode.com 是同一套 v5 API，都交给 ag-cli。
const AG_PLATFORMS = new Set(['gitcode', 'atomgit']);

/** @type {Record<string, string[]>} */
const SDK_TOKEN_ENV = {
  github: ['MJ_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'],
  gitee: ['MJ_GITEE_TOKEN', 'GITEE_TOKEN', 'GITEE_ACCESS_TOKEN'],
  cnb: ['MJ_CNB_TOKEN', 'CNB_TOKEN', 'CNB_ACCESS_TOKEN'],
  gitlab: ['MJ_GITLAB_TOKEN', 'GITLAB_TOKEN', 'GL_TOKEN'],
  bitbucket: ['MJ_BITBUCKET_TOKEN', 'BITBUCKET_TOKEN', 'BB_TOKEN'],
};

/** @type {[string, string][]} */
const HOST_PLATFORM = [
  ['gitcode.com', 'gitcode'],
  ['atomgit.com', 'atomgit'],
  ['github.com', 'github'],
  ['gitee.com', 'gitee'],
  ['cnb.cool', 'cnb'],
  ['gitlab.com', 'gitlab'],
  ['bitbucket.org', 'bitbucket'],
];

/**
 * @param {string} line
 * @returns {{platform:string|null, owner:string, repo:string, url:string}|null}
 */
function parseUrl(line) {
  try {
    const u = new URL(line.trim());
    const parts = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const host = u.hostname.toLowerCase();
    const platform = HOST_PLATFORM.find(([h]) => host === h || host.endsWith('.' + h))?.[1] ?? null;
    const owner = /** @type {string} */ (parts.at(-2));
    const repo = /** @type {string} */ (parts.at(-1));
    return { platform, owner, repo, url: line.trim() };
  } catch { return null; }
}

/** @param {string[]} args @returns {Promise<any>} */
async function agJson(args) {
  // 有 AGCLI_TOKEN 就走隔离封装（临时 XDG，用完即删）；否则用本机已有登录态。
  const cmd = process.env.AGCLI_TOKEN ? AG_SH : 'ag-cli';
  const { stdout } = await run(cmd, args, { maxBuffer: 8 << 20 });
  return JSON.parse(stdout);
}

/**
 * @param {{platform:string, owner:string, repo:string, url:string}} ref
 * @returns {Promise<Record<string,any>>}
 */
async function viaAgCli(ref) {
  const target = `${ref.owner}/${ref.repo}`;
  // 用 api 拿完整 raw：repo view 的 --json 会丢掉 owner.avatar_url
  const repo = await agJson(['api', `/repos/${target}`, '--raw-output']);
  const owner = repo.owner ?? {};
  let lastCommit = null;
  try {
    const commits = await agJson(['commit', 'list', target, '--limit', '1', '--json', '--raw-output']);
    lastCommit = commits?.[0]?.date ?? null;
  } catch {
    // 空仓库没有 commit：不是错误，字段留空。
  }
  return {
    name: repo.name,
    maintainer: owner.name || owner.username || ref.owner,
    lastCommit,
    license: typeof repo.license === 'object' ? (repo.license?.name ?? null) : (repo.license ?? null),
    description: repo.description || null,
    avatar: owner.avatar_url || null,
    profile: owner.html_url || null,
    url: ref.url,
  };
}

/** @returns {{tokens:Record<string,string>, status:Record<string,string>}} */
/** @returns {{tokens:Record<string,string>, status:Record<string,string>}} */
function sdkTokens() {
  /** @type {Record<string,string>} */
  const tokens = {};
  /** @type {Record<string,string>} */
  const status = /** @type {Record<string,string>} */ ({});
  for (const [platform, keys] of Object.entries(SDK_TOKEN_ENV)) {
    const key = keys.find(k => process.env[k]?.trim());
    const val = key ? process.env[key]?.trim() : undefined;
    if (!val) continue;
    tokens[platform] = val;
    status[platform] = /** @type {string} */ (key);
  }
  return { tokens, status };
}

/** @returns {Promise<void>} */
async function main() {
  const raw = await readFile(new URL('../material/urls.txt', import.meta.url), 'utf8');
  const refs = raw.split('\n').map(s => s.trim())
    .filter(s => s && !s.startsWith('#'))
    .map(parseUrl)
    .filter(/** @returns {ref is {platform:string, owner:string, repo:string, url:string}} */ (ref) => ref !== null && ref.platform !== null);

  const { tokens, status } = sdkTokens();
  const sdk = createGitSdk(tokens);
  const entries = [];
  const skipped = [];

  console.log('ag-cli auth:', process.env.AGCLI_TOKEN ? 'AGCLI_TOKEN (isolated XDG)' : 'local login');
  console.log('sdk token source:', JSON.stringify(status));

  for (const ref of refs) {
    if (!ref.platform) { skipped.push(`${ref.url}: unsupported host`); continue; }
    try {
      if (AG_PLATFORMS.has(ref.platform)) {
        entries.push(await viaAgCli(ref));
      } else {
        const r = await sdk.platform(/** @type {any} */ (ref.platform)).repositories.get({ owner: ref.owner, repo: ref.repo });
        /** @type {{username?:string, login?:string, avatarUrl?:string, htmlUrl?:string}|null|undefined} */
        const sdkOwner = r.owner;
        const ow = sdkOwner ?? {};
        let avatar = ow.avatarUrl ?? null;
        // GitLab 返回的是相对路径（/uploads/...），补 host
        if (avatar && avatar.startsWith('/')) {
          avatar = (ref.platform === 'gitlab' ? 'https://gitlab.com' : '') + avatar;
        }
        entries.push({
          name: r.name,
          maintainer: ow.username ?? ow.login ?? ref.owner,
          lastCommit: r.pushedAt ?? r.updatedAt ?? null,
          license: r.license ?? null,
          description: r.description || null,
          avatar,
          profile: ow.htmlUrl ?? null,
          url: ref.url,
        });
      }
      const withBase = await enrich(entries[entries.length - 1], ref, { tokens });
      // contributors 只取前 5 + 总数；拿不到就留空（页面不渲那一堆）
      // 数据模块自己管分页/限流/隐私；这里只要结果。
      // 平铺 5 个 + 框内换页，共取 100 个头像（4 页 × 25）。
      const contrib = await contributors(/** @type {any} */ (ref.platform), ref, {
        maxPeople: 100,
        token: tokens[ref.platform],
      }).catch(() => null);
      entries[entries.length - 1] = contrib
        ? { ...withBase, contributors: contrib.people, contributorTotal: contrib.total }
        : withBase;
    } catch (/** @type {any} */ e) {
      // 读不到 ≠ 坏了：私有 / 无权限 / 已删除都记原因后跳过，不产空壳条目。
      const msg = String(e?.stderr || e?.message || '').trim().split('\n').pop();
      skipped.push(`${ref.url}: ${msg}`);
    }
  }

  // 取不到的条目静默忽略：原因只打在 CI 日志里，不进 catalogue。
  // 对外页面不展示任何错误状态 —— 目录只呈现可用条目。
  const catalogue = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    entries,
  };
  await mkdir(new URL('../site/', import.meta.url), { recursive: true });
  await writeFile(OUT, JSON.stringify(catalogue, null, 1) + '\n');

  console.log(`catalogue: ${entries.length} entries, ${skipped.length} skipped`);
  for (const s of skipped) console.log('  skip:', s);
}

main().catch(e => { console.error(e); process.exit(1); });
