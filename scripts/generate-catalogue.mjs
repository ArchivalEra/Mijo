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

const run = promisify(execFile);
const OUT = new URL('../site/catalogue.json', import.meta.url).pathname;
const AG_SH = new URL('./ag.sh', import.meta.url).pathname;

// atomgit.com 与 gitcode.com 是同一套 v5 API，都交给 ag-cli。
const AG_PLATFORMS = new Set(['gitcode', 'atomgit']);

const SDK_TOKEN_ENV = {
  github: ['MJ_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'],
  gitee: ['MJ_GITEE_TOKEN', 'GITEE_TOKEN', 'GITEE_ACCESS_TOKEN'],
  cnb: ['MJ_CNB_TOKEN', 'CNB_TOKEN', 'CNB_ACCESS_TOKEN'],
  gitlab: ['MJ_GITLAB_TOKEN', 'GITLAB_TOKEN', 'GL_TOKEN'],
  bitbucket: ['MJ_BITBUCKET_TOKEN', 'BITBUCKET_TOKEN', 'BB_TOKEN'],
};

const HOST_PLATFORM = [
  ['gitcode.com', 'gitcode'],
  ['atomgit.com', 'atomgit'],
  ['github.com', 'github'],
  ['gitee.com', 'gitee'],
  ['cnb.cool', 'cnb'],
  ['gitlab.com', 'gitlab'],
  ['bitbucket.org', 'bitbucket'],
];

function parseUrl(line) {
  try {
    const u = new URL(line.trim());
    const parts = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const host = u.hostname.toLowerCase();
    const platform = HOST_PLATFORM.find(([h]) => host === h || host.endsWith('.' + h))?.[1] ?? null;
    return { platform, owner: parts.at(-2), repo: parts.at(-1), url: line.trim() };
  } catch { return null; }
}

async function agJson(args) {
  // 有 AGCLI_TOKEN 就走隔离封装（临时 XDG，用完即删）；否则用本机已有登录态。
  const cmd = process.env.AGCLI_TOKEN ? AG_SH : 'ag-cli';
  const { stdout } = await run(cmd, args, { maxBuffer: 8 << 20 });
  return JSON.parse(stdout);
}

async function viaAgCli(ref) {
  const target = `${ref.owner}/${ref.repo}`;
  const repo = await agJson(['repo', 'view', target, '--json', '--raw-output']);
  let lastCommit = null;
  try {
    const commits = await agJson(['commit', 'list', target, '--limit', '1', '--json', '--raw-output']);
    lastCommit = commits?.[0]?.date ?? null;
  } catch {
    // 空仓库没有 commit：不是错误，字段留空。
  }
  return {
    name: repo.name,
    maintainer: repo.owner ?? ref.owner,
    lastCommit,
    license: repo.license ?? null,
    description: repo.description || null,
    url: ref.url,
  };
}

function sdkTokens() {
  const tokens = {};
  const status = {};
  for (const [platform, keys] of Object.entries(SDK_TOKEN_ENV)) {
    const key = keys.find(k => process.env[k]?.trim());
    if (key) tokens[platform] = process.env[key].trim();
    status[platform] = key ?? 'absent';
  }
  return { tokens, status };
}

async function main() {
  const raw = await readFile(new URL('../material/urls.txt', import.meta.url), 'utf8');
  const refs = raw.split('\n').map(s => s.trim())
    .filter(s => s && !s.startsWith('#'))
    .map(parseUrl).filter(Boolean);

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
        const r = await sdk.platform(ref.platform).repositories.get({ owner: ref.owner, repo: ref.repo });
        entries.push({
          name: r.name,
          maintainer: r.owner?.username ?? r.owner?.login ?? ref.owner,
          lastCommit: r.pushedAt ?? r.updatedAt ?? null,
          license: r.license ?? null,
          description: r.description || null,
          url: ref.url,
        });
      }
    } catch (e) {
      // 读不到 ≠ 坏了：私有 / 无权限 / 已删除都记原因后跳过，不产空壳条目。
      const msg = (e.stderr || e.message || '').trim().split('\n').pop();
      skipped.push(`${ref.url}: ${msg}`);
    }
  }

  const catalogue = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    note: skipped.length
      ? `${skipped.length} URL(s) unavailable (private / not found / no read token) — skipped, no empty shell entries.`
      : null,
    entries,
  };
  await mkdir(new URL('../site/', import.meta.url), { recursive: true });
  await writeFile(OUT, JSON.stringify(catalogue, null, 1) + '\n');

  console.log(`catalogue: ${entries.length} entries, ${skipped.length} skipped`);
  for (const s of skipped) console.log('  skip:', s);
}

main().catch(e => { console.error(e); process.exit(1); });
