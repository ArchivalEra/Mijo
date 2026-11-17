// completeness 判据的测试。纯函数，无网络、无文件系统、无凭据。
//
// 跑法：node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessCompleteness,
  summarize,
  PLATFORM_LIMITS,
} from '../scripts/completeness.mjs';

/** 一个最小可用条目；测试按需覆盖字段。 */
function entry(overrides = {}) {
  return {
    url: 'https://github.com/a/b',
    name: 'b',
    maintainer: 'a',
    avatar: 'https://x/y.png',
    profile: 'https://github.com/a',
    description: 'desc',
    lastCommit: '2026-01-01T00:00:00Z',
    license: 'MIT',
    contributors: [{ login: 'a' }],
    contributorTotal: 1,
    reasons: {},
    ...overrides,
  };
}

function ref(url, platform = 'github') {
  return { url, platform, owner: 'a', repo: 'b' };
}

const NO_TOKENS = new Set();
const ALL_TOKENS = new Set(['github', 'gitee', 'gitlab', 'bitbucket', 'gitcode', 'atomgit', 'cnb']);

test('every URL producing a complete entry is complete', () => {
  const v = assessCompleteness({
    refs: [ref('https://github.com/a/b')],
    entries: [entry()],
    configuredPlatforms: ALL_TOKENS,
  });
  assert.equal(v.status, 'complete');
  assert.deepEqual(v.failures, []);
  assert.deepEqual(v.notes, []);
});

test('a URL that vanished with no reason is broken', () => {
  const v = assessCompleteness({
    refs: [ref('https://github.com/a/b'), ref('https://github.com/a/missing')],
    entries: [entry()],
    configuredPlatforms: ALL_TOKENS,
  });
  assert.equal(v.status, 'broken');
  assert.equal(v.failures.length, 1);
  assert.match(v.failures[0], /missing: 丢失/);
});

test('a token-only platform without its token is broken, and says which variable', () => {
  const v = assessCompleteness({
    refs: [ref('https://cnb.cool/a/b', 'cnb')],
    entries: [],
    configuredPlatforms: NO_TOKENS,
  });
  assert.equal(v.status, 'broken');
  assert.match(v.failures[0], /cnb/);
  assert.match(v.failures[0], /访问令牌/);
  assert.match(v.failures[0], /\.env\.example/);
});

test('a rejected URL is accounted for only when the rejection is acceptable', () => {
  // 仓库事实（404/私有）：可接受，不算阻塞。
  const deleted = assessCompleteness({
    refs: [ref('https://github.com/a/b')],
    entries: [],
    rejected: [{ url: 'https://github.com/a/b', reason: '仓库已删除（404）' }],
    configuredPlatforms: ALL_TOKENS,
  });
  assert.equal(deleted.status, 'complete');
  assert.deepEqual(deleted.failures, []);

  // 缺凭据：不可接受，必须阻塞。
  const noToken = assessCompleteness({
    refs: [ref('https://cnb.cool/a/b', 'cnb')],
    entries: [],
    rejected: [{ url: 'https://cnb.cool/a/b', reason: '缺少 CNB 访问令牌' }],
    configuredPlatforms: NO_TOKENS,
  });
  assert.equal(noToken.status, 'broken');
  assert.match(noToken.failures[0], /被拒绝且不可接受/);

  // 网络失败：不可接受，必须阻塞。
  const netFail = assessCompleteness({
    refs: [ref('https://gitlab.com/a/b', 'gitlab')],
    entries: [],
    rejected: [{ url: 'https://gitlab.com/a/b', reason: '网络请求失败：fetch failed' }],
    configuredPlatforms: ALL_TOKENS,
  });
  assert.equal(netFail.status, 'broken');

  // 限流：临时状态，同样必须阻塞（换一次跑就能拿到，不能当仓库事实）。
  const rateLimited = assessCompleteness({
    refs: [ref('https://gitee.com/a/b', 'gitee')],
    entries: [],
    rejected: [{ url: 'https://gitee.com/a/b', reason: '403 Forbidden (Rate Limit Exceeded)' }],
    configuredPlatforms: ALL_TOKENS,
  });
  assert.equal(rateLimited.status, 'broken');

  // 平台能力限制：可接受。
  const platformLimit = assessCompleteness({
    refs: [ref('https://cnb.cool/a/b', 'cnb')],
    entries: [],
    rejected: [
      { url: 'https://cnb.cool/a/b', reason: PLATFORM_LIMITS.contributorTotalAbsent },
    ],
    configuredPlatforms: ALL_TOKENS,
  });
  assert.equal(platformLimit.status, 'complete');
});

test('an empty required field is broken even when everything else is fine', () => {
  const v = assessCompleteness({
    refs: [ref('https://github.com/a/b')],
    entries: [entry({ name: '' })],
    configuredPlatforms: ALL_TOKENS,
  });
  assert.equal(v.status, 'broken');
  assert.match(v.failures[0], /必需字段 name 为空/);
});

test('a degradable field may be empty only when it carries a whitelisted reason', () => {
  const ok = assessCompleteness({
    refs: [ref('https://bitbucket.org/a/b', 'bitbucket')],
    entries: [
      entry({
        url: 'https://bitbucket.org/a/b',
        license: null,
        description: null,
        reasons: {
          license: PLATFORM_LIMITS.licenseAbsent,
          description: PLATFORM_LIMITS.descriptionAbsent,
        },
      }),
    ],
    configuredPlatforms: ALL_TOKENS,
  });
  assert.equal(ok.status, 'degraded');
  assert.equal(ok.failures.length, 0);
  assert.equal(ok.notes.length, 2);

  const bad = assessCompleteness({
    refs: [ref('https://bitbucket.org/a/b', 'bitbucket')],
    entries: [entry({ url: 'https://bitbucket.org/a/b', license: null })],
    configuredPlatforms: ALL_TOKENS,
  });
  assert.equal(bad.status, 'broken');
  assert.match(bad.failures[0], /license 为空且没有说明原因/);
});

test('lastCommit faked from pushed_at is broken', () => {
  const v = assessCompleteness({
    refs: [ref('https://github.com/a/b')],
    entries: [entry({ lastCommitProvenance: 'pushed-at' })],
    configuredPlatforms: ALL_TOKENS,
  });
  assert.equal(v.status, 'broken');
  assert.match(v.failures[0], /pushed_at 顶替/);
});

test('an empty urls.txt is broken: publishing an empty catalogue is not a success', () => {
  const v = assessCompleteness({ refs: [], entries: [], configuredPlatforms: ALL_TOKENS });
  // 零 URL 零条目本身不违反「每条 URL 都有下落」，所以这里显式要求调用方
  // 另查非空——本模块把这条也收进来，避免调用方漏掉。
  assert.equal(v.status, 'broken');
  assert.match(v.failures[0], /urls\.txt 为空/);
});

test('unrecognised host is reported, not silently dropped', () => {
  const v = assessCompleteness({
    refs: [ref('https://example.com/a/b', null)],
    entries: [],
    configuredPlatforms: ALL_TOKENS,
  });
  assert.equal(v.status, 'broken');
  assert.match(v.failures[0], /无法识别的仓库地址/);
});

test('summarize names the blocking count and the reason lines', () => {
  const text = summarize({
    status: 'broken',
    failures: ['x: 丢了'],
    notes: ['y: license 缺失（platform-omits-license）'],
  });
  assert.match(text, /完整性裁决：broken/);
  assert.match(text, /1 项阻塞/);
  assert.match(text, /1 项降级/);
  assert.match(text, /x: 丢了/);
});
