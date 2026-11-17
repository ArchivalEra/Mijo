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
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGitSdk } from '@xindiwo/git-sdk';
import { enrich } from './enrich.mjs';
import { contributors } from './contributors.mjs';
import {
  assessCompleteness,
  summarize,
  PLATFORM_LIMITS,
} from './completeness.mjs';

// 本地凭据：仓根的 .env（不入库，模板见 .env.example）。
// 用 Node 内置的 loadEnvFile，零依赖；文件不存在时静默跳过——CI 里
// 变量由 Secrets 注入，本来就没有这个文件。已存在的环境变量优先，
// loadEnvFile 不会覆盖它们，所以 CI 的行为不受影响。
const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (/** @type {any} */ e) {
    console.error(`警告：读不了 ${ENV_FILE}（${e?.message ?? e}）——按环境变量继续`);
  }
}

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
    // 空仓库没有 commit，或该端点读不到：留给 enrich 再试一次，
    // 仍拿到 null 就由 completeness 判据按 reason 处理。
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
  /** @type {{url:string, reason:string}[]} */
  const rejected = [];
  /** 解析阶段就被丢掉的行（不支持的 host、写坏的行）——它们也必须有下落。 */
  const unparsed = raw.split('\n').map(s => s.trim())
    .filter(s => s && !s.startsWith('#'))
    .map(line => ({ line, ref: parseUrl(line) }))
    .filter(({ ref }) => ref === null || ref.platform === null);

  console.log('ag-cli auth:', process.env.AGCLI_TOKEN ? 'AGCLI_TOKEN (isolated XDG)' : 'local login');
  console.log('sdk token source:', JSON.stringify(status));

  for (const { line, ref } of unparsed) {
    // 解析失败不进 entries，但必须留下拒绝记录，否则这条 URL 就凭空消失了。
    rejected.push({
      url: line,
      reason: ref === null ? '不是可解析的仓库地址' : `不支持的平台：${line}`,
    });
  }

  for (const ref of refs) {
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
          // 不再用 pushedAt/updatedAt 顶替：那不是最后提交时间，页面上的
          // 日期无法分辨真假。拿不到就留空 + 由 enrich 补真值，补不到
          // 就带 reason（见下方 reasons 装配）。
          lastCommit: null,
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
      // 贡献者抓取失败不能静默变成「这个仓没有贡献者」——把失败原因记下来，
      // 由 completeness 判据决定它是阻塞还是可接受。
      /** @type {string|null} */
      let contribFailure = null;
      const contrib = await contributors(/** @type {any} */ (ref.platform), ref, {
        maxPeople: 100,
        token: tokens[ref.platform],
      }).catch((/** @type {any} */ e) => {
        contribFailure = String(e?.message ?? e).trim();
        return null;
      });
      const merged = contrib
        ? { ...withBase, contributors: contrib.people, contributorTotal: contrib.total }
        : withBase;

      // 字段缺失必须带原因，否则判据无法区分「平台不提供」与「抓取失败」。
      // 原因的来源只有两处：平台能力（PLATFORM_LIMITS）与仓库内容事实。
      /** @type {Record<string,string>} */
      const reasons = {};
      if (!merged.lastCommit) {
        reasons.lastCommit = PLATFORM_LIMITS.lastCommitAbsent;
      }
      if (!merged.license) {
        reasons.license = PLATFORM_LIMITS.licenseAbsent;
      }
      if (!merged.description) {
        reasons.description = PLATFORM_LIMITS.descriptionAbsent;
      }
      // 维护者的头像/主页来自各平台仓库对象里的 owner 结构，字段名各不相同；
      // 平台没给就是没给（不是抓取失败），页面退首字母/无链接即可。
      if (!merged.avatar) {
        reasons.avatar = PLATFORM_LIMITS.ownerAvatarAbsent;
      }
      if (!merged.profile) {
        reasons.profile = PLATFORM_LIMITS.ownerProfileAbsent;
      }
      if (!merged.maintainer) {
        reasons.maintainer = PLATFORM_LIMITS.ownerNameAbsent;
      }
      if (!contrib) {
        // 抓取失败（网络/限流/缺令牌）与「仓库确实没有贡献者」是两件事：
        // 前者带 HTTP 状态等细节，会被判据当成阻塞；后者是仓库事实。
        reasons.contributors = contribFailure
          ? `contributor-fetch-failed: ${contribFailure}`
          : PLATFORM_LIMITS.noContributors;
      } else if (merged.contributorTotal === null) {
        reasons.contributorTotal = PLATFORM_LIMITS.contributorTotalAbsent;
      }
      entries[entries.length - 1] = { ...merged, reasons };
    } catch (/** @type {any} */ e) {
      // 读不到 ≠ 坏了：私有 / 无权限 / 已删除都记原因后拒绝，不产空壳条目。
      const msg = String(e?.stderr || e?.message || '').trim().split('\n').pop();
      rejected.push({ url: ref.url, reason: msg || '读取失败' });
    }
  }

  const catalogue = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    entries,
    // 拒绝记录随 catalogue 一起落盘：这是「为什么某条 URL 没进目录」的
    // 持久凭据。此前这些原因只打在 CI 日志里，日志一过期就再也查不到
    // （open-design、git-sdk-v1 两条就是这么消失得无影无踪的）。
    rejected,
  };
  await mkdir(new URL('../site/', import.meta.url), { recursive: true });
  await writeFile(OUT, JSON.stringify(catalogue, null, 1) + '\n');

  console.log(`catalogue: ${entries.length} entries, ${rejected.length} rejected`);
  for (const r of rejected) console.log('  rejected:', r.url, '—', r.reason);

  // ── 裁决：能不能部署 ────────────────────────────────────────────────
  // 先写文件再判：坏数据不进线上（CI 红、dispatch 不触发），但工作区里
  // 有完整产物供人排查。反过来（先 exit 再写）会让人只剩一行日志可看。
  const verdict = assessCompleteness({
    refs: [...refs, ...unparsed.map(({ line }) => ({ url: line, platform: null, owner: '', repo: '' }))],
    entries,
    rejected,
    configuredPlatforms: new Set(Object.keys(tokens)),
  });
  console.error(summarize(verdict));

  if (verdict.status === 'broken') {
    console.error(`\n派生产出不合格：${verdict.failures.length} 项阻塞。catalogue 已写入供排查，但不部署。`);
    process.exitCode = 1;
  }
}

main().catch(e => { console.error(e); process.exit(1); });
