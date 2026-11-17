#!/usr/bin/env node
// 对**已经落盘的** catalogue.json 复跑完整性裁决（不联网、不重新派生）。
//
// 为什么要这个：`deploy.yml` 不再自己派生（那会和 catalogue.yml 双写同一个
// 文件、互相顶掉），但它必须在部署前确认「仓库里这份数据是可部署的」。
// 判据只有一份（completeness.mjs），这里只是把它套到一个已存在的文件上。
//
// 用法：node scripts/check-catalogue.mjs site/catalogue.json
import { readFile } from 'node:fs/promises';
import { assessCompleteness, summarize } from './completeness.mjs';

const path = process.argv[2];
if (!path) {
  console.error('用法：node scripts/check-catalogue.mjs <catalogue.json>');
  process.exit(2);
}

/** @type {any} */
let catalogue;
try {
  catalogue = JSON.parse(await readFile(path, 'utf8'));
} catch (/** @type {any} */ e) {
  console.error(`${path} 读不了（${e?.message ?? e}）——没有可部署的数据`);
  process.exit(1);
}

const entries = Array.isArray(catalogue?.entries) ? catalogue.entries : [];
const rejected = Array.isArray(catalogue?.rejected) ? catalogue.rejected : [];

// 落盘文件不保留 urls.txt 原文，所以「URL 被悄悄丢掉」在纯文件层面无法自证。
// 用清单行数补这一刀：清单有几行，就必须有几条下落（entry 或 rejected）。
// 这是唯一能发现「整条 URL 消失」的检查点，缺了它判据在这一层就是自证。
/** @type {string[]} */
let urls = [];
try {
  const raw = await readFile(new URL('../material/urls.txt', import.meta.url), 'utf8');
  urls = raw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
} catch {
  console.error('读不到 material/urls.txt —— 无法核对清单与产物的对应关系，拒绝部署');
  process.exit(1);
}

const accounted = entries.length + rejected.length;
if (accounted !== urls.length) {
  console.error(
    `清单 ${urls.length} 条 URL，产物里只有 ${accounted} 条下落`
    + `（${entries.length} 条目 + ${rejected.length} 拒绝）—— 有 URL 凭空消失了。`,
  );
  process.exit(1);
}

// refs 从 entries + rejected 反推：落盘文件不保留 urls.txt 原文，
// 而判据的一级检查「每条 URL 都有下落」在文件层面等价于
// 「每个 entry 自洽 + 每条 rejected 可接受」。
/** @type {{url:string, platform:string|null, owner:string, repo:string}[]} */
const refs = [
  ...entries.map((/** @type {any} */ e) => ({
    url: String(e?.url ?? ''),
    platform: null,
    owner: '',
    repo: '',
  })),
  ...rejected.map((/** @type {any} */ r) => ({
    url: String(r?.url ?? ''),
    platform: null,
    owner: '',
    repo: '',
  })),
];

// 平台凭据无关：这是对落盘数据的静态复核，不该因为「当前环境没 token」而红。
const configuredPlatforms = new Set([
  'github', 'gitee', 'gitlab', 'bitbucket', 'gitcode', 'atomgit', 'cnb',
]);

const verdict = assessCompleteness({ refs, entries, rejected, configuredPlatforms });
console.error(summarize(verdict));

if (verdict.status === 'broken') {
  console.error(`\n仓库里的 catalogue 不合格：${verdict.failures.length} 项阻塞，拒绝部署。`);
  process.exit(1);
}
console.log(`\n可部署：${entries.length} 条目，${rejected.length} 条拒绝记录，裁决 ${verdict.status}。`);
