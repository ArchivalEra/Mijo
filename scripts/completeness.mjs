// catalogue 完整性判据（纯函数，无网络、无文件系统）。
//
// 这是「这份 catalogue 能不能部署」的唯一裁决点。此前这个判断不存在：
// 派生的每一个阶段都能静默丢掉一条 URL 或留空一个字段，而写文件的代码
// 从不比较「几条 URL 进、几条 entry 出」，于是坏数据照样部署。
//
// 判据分两级，缺一不可：
//
//   一级 —— 每条 URL 都必须在 entries 里出现。
//           要么产出一个 entry，要么产出一条「已知不可用」的记录并带原因。
//           悄悄消失 = broken。
//
//   二级 —— 每个 entry 的必需字段必须齐（url + name），
//           其余字段缺失时必须带一个白名单内的 reason。
//           裸 null 与「抓取失败」不可区分 = broken。
//
// 「为什么不判所有字段都必填」：平台事实与抓取失败必须分开。
// Bitbucket 的仓库对象本来就没有 license 字段，任何人在任何机器上跑都是 null；
// CNB 没配 token 也只是这台机器上是 null。前者是 degraded（可接受，带 reason），
// 后者是 broken（必须配好再来）。判据因此问的是：
//
//   在「凭据齐全的理想环境」下，这个字段拿得到吗？
//
// 拿得到而现在没拿到 → broken。平台本就不提供 → degraded。

/** 平台接口不提供该数据的已知情形。只有这些原因能进白名单。 */
export const PLATFORM_LIMITS = Object.freeze({
  /** 仓库对象里没有 license 字段，只能读 LICENSE 文件猜。 */
  licenseAbsent: 'platform-omits-license',
  /** 没有 commits 端点，或端点不返回最后提交时间。 */
  lastCommitAbsent: 'platform-omits-commits',
  /** 贡献者端点只给活跃排行，条目不等于人数。 */
  contributorTotalAbsent: 'platform-omits-contributor-total',
  /** 仓库没有写描述。这是仓库内容的事实，不是抓取失败。 */
  descriptionAbsent: 'repository-has-no-description',
  /** 仓库确实没有贡献者（空仓或单人）。 */
  noContributors: 'repository-has-no-contributors',
  /** 平台仓库对象里没有 owner 头像字段（各平台结构不同）。 */
  ownerAvatarAbsent: 'platform-omits-owner-avatar',
  /** 平台仓库对象里没有 owner 主页字段。 */
  ownerProfileAbsent: 'platform-omits-owner-profile',
  /** 平台仓库对象里没有 owner 名字，只能落到 URL 里的账号名。 */
  ownerNameAbsent: 'platform-omits-owner-name',
});

/** 需要凭据才能读的平台 —— 判定「缺 token 是 broken 还是无关」用得到。 */
const NEEDS_TOKEN = new Set(['gitcode', 'atomgit', 'cnb']);

/** 必需字段：缺了页面就渲染不出可用的东西。其余字段见 PLATFORM_LIMITS。 */
const REQUIRED_FIELDS = Object.freeze(['url', 'name']);

/** 允许「缺失但带原因」的字段。 */
const DEGRADABLE_FIELDS = Object.freeze([
  'maintainer',
  'avatar',
  'profile',
  'description',
  'lastCommit',
  'license',
  'contributors',
]);

/**
 * @typedef {Object} Ref
 * @property {string} url
 * @property {string|null} platform
 * @property {string} owner
 * @property {string} repo
 */

/**
 * @typedef {Object} Verdict
 * @property {'complete'|'degraded'|'broken'} status
 * @property {string[]} failures   broken 的原因，人可读，逐条一行
 * @property {string[]} notes      degraded 的原因，人可读
 */

/**
 * 判断一条 rejected 记录是否是「可接受的不可用」。
 *
 * 只有两类可接受：
 *   1. 仓库本身不可得（私有/已删/404）—— 这不是数据管道的失败，是仓库的事实；
 *   2. 平台接口不提供该数据（PLATFORM_LIMITS 里的白名单原因）。
 *
 * 其余一律 broken：缺凭据、网络失败、限流、权限不足。这些换个环境就能拿到，
 * 属于「配置没做好」，不能拿它当「这条 URL 就是没有」。
 *
 * @param {string} reason
 * @returns {boolean}
 */
function isAcceptableRejection(reason) {
  if (!reason) return false;
  // 临时状态优先排除：限流、超时、连接失败换一次跑就能拿到，不能当「仓库事实」。
  if (/rate.?limit|too many requests|429|超时|timeout|fetch failed|ECONNRESET|ETIMEDOUT/i.test(reason)) {
    return false;
  }
  // 平台能力白名单
  const whitelisted = Object.values(PLATFORM_LIMITS);
  if (whitelisted.some((code) => reason.includes(code))) return true;
  // 仓库事实：私有 / 已删除 / 无权限读取。这些是 404/403，换谁跑都一样。
  if (/\b(404|403)\b/.test(reason)) return true;
  if (/已删除|不存在|无权限|forbidden|not found/i.test(reason)) return true;
  return false;
}

/**
 * 一条 URL 既不在 entries 也不在 rejected 里时，说清楚为什么。
 * 分开写是为了让「缺凭据」与「纯粹丢了」各自有独立出口，
 * 而不是挤在一条 else-if 链上。
 * @param {Ref} ref @param {ReadonlySet<string>} configuredPlatforms
 * @returns {string}
 */
function explainMissingFate(ref, configuredPlatforms) {
  if (ref.platform === null) {
    return `${ref.url}: 无法识别的仓库地址（既没进条目也没被拒绝）`;
  }
  if (NEEDS_TOKEN.has(ref.platform) && !configuredPlatforms.has(ref.platform)) {
    return `${ref.url}: 需要 ${ref.platform} 的访问令牌，当前未配置（见 .env.example）`;
  }
  return `${ref.url}: 丢失 —— 既没产出条目，也没有拒绝原因`;
}

/**
 * 一条 URL 的下落判定：无阻塞返回 null，否则返回原因。
 * @param {Ref} ref @param {ReadonlySet<string>} entryUrls
 * @param {ReadonlyMap<string,string>} rejectedUrls
 * @param {ReadonlySet<string>} configuredPlatforms
 * @returns {string|null}
 */
function judgeFate(ref, entryUrls, rejectedUrls, configuredPlatforms) {
  if (entryUrls.has(ref.url)) return null;

  const reason = rejectedUrls.get(ref.url);
  if (reason === undefined) return explainMissingFate(ref, configuredPlatforms);
  // 有下落，但下落本身可能是不可接受的（缺凭据、网络失败）。
  if (isAcceptableRejection(reason)) return null;
  return `${ref.url}: 被拒绝且不可接受 —— ${reason}`;
}

/**
 * 一级：每条 URL 都必须有下落。
 *
 * 要么在 entries 里，要么在 rejected 里带原因。两种情况之外的一切都是丢失。
 * 被拒绝的还要分「可接受」与「不可接受」——见 isAcceptableRejection。
 *
 * @param {readonly Ref[]} refs
 * @param {readonly any[]} entries
 * @param {ReadonlyMap<string,string>} rejectedUrls
 * @param {ReadonlySet<string>} configuredPlatforms
 * @returns {string[]} 阻塞原因
 */
function checkEveryUrlHasFate(refs, entries, rejectedUrls, configuredPlatforms) {
  const entryUrls = new Set(entries.map((e) => e?.url).filter(Boolean));
  /** @type {string[]} */
  const failures = [];
  for (const ref of refs) {
    const failure = judgeFate(ref, entryUrls, rejectedUrls, configuredPlatforms);
    if (failure) failures.push(failure);
  }
  return failures;
}

/** 字段值是否算「空」。数组按元素数算，字符串按去空白后算。 */
function isEmptyField(/** @type {any} */ value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

/** 字符串是否「有内容」。 @param {any} value */
function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 一个可降级字段缺失时，它是阻塞还是降级？
 *
 * 有白名单原因 → 降级（平台本就不提供）。
 * 原因是 `*-fetch-failed:` → 阻塞（换环境就能拿到，属于配置/网络问题）。
 * 没有原因 → 阻塞（裸 null 与抓取失败无法区分）。
 *
 * @param {any} entry @param {string} field
 * @returns {{blocking:boolean, text:string}}
 */
function judgeEmptyField(entry, field) {
  const label = entry?.url ?? '(无 url 的条目)';
  const reason = entry?.reasons?.[field];

  if (!hasText(reason)) {
    return {
      blocking: true,
      text: `${label}: ${field} 为空且没有说明原因（裸 null 与抓取失败无法区分）`,
    };
  }
  if (/fetch-failed:/i.test(reason)) {
    return { blocking: true, text: `${label}: ${field} 抓取失败（${reason}）` };
  }
  return { blocking: false, text: `${label}: ${field} 缺失（${reason}）` };
}

/**
 * 二级：单个 entry 的字段。
 *
 * 必需字段缺了直接阻塞；可降级字段缺了必须带白名单内的原因。带
 * `fetch-failed:` 原因说明「不是没有，是没抓到」，同样阻塞。
 *
 * @param {any} entry
 * @returns {{failures:string[], notes:string[]}}
 */
/** 必需字段缺失的原因，逐条。 @param {any} entry @param {string} label */
function requiredFieldFailures(entry, label) {
  /** @type {string[]} */
  const failures = [];
  for (const field of REQUIRED_FIELDS) {
    if (!hasText(entry?.[field])) failures.push(`${label}: 必需字段 ${field} 为空`);
  }
  return failures;
}

/**
 * 可降级字段的裁决：返回阻塞项与降级项。
 * @param {any} entry
 * @returns {{failures:string[], notes:string[]}}
 */
function degradableFieldVerdicts(entry) {
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const notes = [];
  for (const field of DEGRADABLE_FIELDS) {
    if (!isEmptyField(entry?.[field])) continue;
    const verdict = judgeEmptyField(entry, field);
    (verdict.blocking ? failures : notes).push(verdict.text);
  }
  return { failures, notes };
}

/**
 * 二级：单个 entry 的字段。
 *
 * 必需字段缺了直接阻塞；可降级字段缺了必须带白名单内的原因。带
 * `fetch-failed:` 原因说明「不是没有，是没抓到」，同样阻塞。
 *
 * @param {any} entry
 * @returns {{failures:string[], notes:string[]}}
 */
function checkOneEntry(entry) {
  const label = entry?.url ?? '(无 url 的条目)';
  const fields = degradableFieldVerdicts(entry);
  const failures = requiredFieldFailures(entry, label);

  // 最后提交时间不能用 pushed_at 顶替：页面上的日期无法分辨真假。
  if (entry?.lastCommitProvenance === 'pushed-at') {
    failures.push(`${label}: lastCommit 用了 pushed_at 顶替，不是真实提交时间`);
  }
  return { failures: [...failures, ...fields.failures], notes: fields.notes };
}

/**
 * 二级：所有 entry 的字段。
 * @param {readonly any[]} entries
 * @returns {{failures:string[], notes:string[]}}
 */
function checkEntryFields(entries) {
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const notes = [];
  for (const entry of entries) {
    const one = checkOneEntry(entry);
    failures.push(...one.failures);
    notes.push(...one.notes);
  }
  return { failures, notes };
}

/**
 * 判断一份 catalogue 能不能部署。
 *
 * @param {Object} input
 * @param {readonly Ref[]} input.refs            从 urls.txt 解析出的 URL（含解析失败的行）
 * @param {readonly any[]} input.entries         实际产出的条目
 * @param {readonly {url:string, reason:string}[]} [input.rejected]  派生阶段明确拒绝的 URL 及原因
 * @param {ReadonlySet<string>} input.configuredPlatforms  当前环境有凭据的平台
 * @returns {Verdict}
 */
export function assessCompleteness({ refs, entries, rejected = [], configuredPlatforms }) {
  /** @type {string[]} */
  const failures = [];

  // ── 零级：空清单不是成功 ──────────────────────────────────────────
  // 「每条 URL 都有下落」在零 URL 时自动成立，但那意味着要部署一个空目录。
  // 空目录不是「完整」，是清单被误删或路径写错——同样禁止部署。
  if (refs.length === 0) {
    failures.push('urls.txt 为空：没有任何仓库地址，拒绝部署空目录');
  }

  // ── 一级：每条 URL 都必须有下落 ────────────────────────────────────
  const rejectedUrls = new Map(rejected.map((r) => [r.url, r.reason]));
  failures.push(...checkEveryUrlHasFate(refs, entries, rejectedUrls, configuredPlatforms));

  // ── 二级：每个 entry 的字段 ────────────────────────────────────────
  const fields = checkEntryFields(entries);
  failures.push(...fields.failures);

  const status = computeStatus(failures, fields.notes);
  return { status, failures, notes: fields.notes };
}

/**
 * 裁决结论：有阻塞就是 broken，只有降级就是 degraded，都没有才 complete。
 * @param {readonly string[]} failures @param {readonly string[]} notes
 * @returns {Verdict['status']}
 */
function computeStatus(failures, notes) {
  if (failures.length > 0) return 'broken';
  if (notes.length > 0) return 'degraded';
  return 'complete';
}

/**
 * 人类可读的裁决摘要，供 CI 日志与 `console.error` 使用。
 * @param {Verdict} verdict
 * @returns {string}
 */
export function summarize(verdict) {
  const lines = [`完整性裁决：${verdict.status}`];
  if (verdict.failures.length > 0) {
    lines.push(`  ${verdict.failures.length} 项阻塞（数据不全，禁止部署）：`);
    for (const f of verdict.failures) lines.push(`    - ${f}`);
  }
  if (verdict.notes.length > 0) {
    lines.push(`  ${verdict.notes.length} 项降级（可接受，平台不提供）：`);
    for (const n of verdict.notes) lines.push(`    - ${n}`);
  }
  return lines.join('\n');
}

/** 供派生脚本判断某平台是否需要凭据。 @param {string} platform */
export function platformNeedsToken(platform) {
  return NEEDS_TOKEN.has(platform);
}
