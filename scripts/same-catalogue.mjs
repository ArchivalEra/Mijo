#!/usr/bin/env node
// 比较两份 catalogue 的**数据内容**，忽略 generatedAt。
//
// 用途：deploy 流需要确认「仓库里的那份数据与本次派生的是同一份」，才能
// 放心 dispatch（heart 拉的是仓库里的 site/）。但 generatedAt 每次派生
// 都不同，直接比文件字节会永远判成不一致。
//
// 用法：node scripts/same-catalogue.mjs <a.json> <b.json>
// 退出码：0 = 数据一致；1 = 不一致；2 = 读不了
import { readFile } from 'node:fs/promises';

/** @param {string} path */
async function fingerprint(path) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  delete raw.generatedAt;
  // 递归排序对象键：派生结果本应稳定，但排序后比对不受键序变化影响，
  // 否则一次无害的字段顺序调整就会让部署流误判为「数据不一致」。
  /** @param {unknown} v @returns {unknown} */
  const sortDeep = (v) => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sortDeep(/** @type {Record<string, unknown>} */ (v)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sortDeep(raw));
}

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error('用法：node scripts/same-catalogue.mjs <a.json> <b.json>');
  process.exit(2);
}

try {
  const same = (await fingerprint(a)) === (await fingerprint(b));
  process.exit(same ? 0 : 1);
} catch (/** @type {any} */ e) {
  console.error(`比对失败（${e?.message ?? e}）`);
  process.exit(2);
}
