// contributors 的失败语义测试。全部用假 fetch，不联网。
//
// 跑法：node --test tests/
//
// 这里守的是一条硬规则：三种「没有贡献者」必须分得开 ——
//   平台不支持 / 仓库确实没有 / 抓取失败
// 前两种是仓库或平台的事实，第三种必须抛出，让调用方记成阻塞原因。
// 2026-11-18 的 CNB top-10 事故就是第三种被吞成了第二种。
import test from 'node:test';
import assert from 'node:assert/strict';

import { contributors } from '../scripts/contributors.mjs';

/** 装一个只回固定 JSON 的假 fetch，并在测试结束时还原。 */
function stubFetch(t, handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = orig; });
}

/** 构造一个成功响应。 */
function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  };
}

test('bitbucket does not infer a headcount from commit authors', async (t) => {
  // 提交作者数不是贡献者人数：同一个人换邮箱算两行，没提交过的贡献者不出现。
  // adapter 声明了 noInfer，外层就不该把列表长度当 total。
  const authors = [
    { author: { user: { display_name: 'alice' } } },
    { author: { user: { display_name: 'bob' } } },
    { author: { raw: 'carol <c@example.com>' } },
  ];
  stubFetch(t, async () => jsonResponse({ values: authors }));

  const r = await contributors('bitbucket', { owner: 'a', repo: 'b' }, { maxPeople: 100 });
  assert.equal(r.total, null, '提交作者数不能当作贡献者总数');
  assert.equal(r.people.length, 3);
});

test('a platform that reports its own total keeps it', async (t) => {
  // 反向对照：有真 total 的适配器不能被 noInfer 逻辑影响。
  stubFetch(t, async () => jsonResponse([
    { name: 'alice', email: 'a@x' },
    { name: 'bob', email: 'b@x' },
  ]));

  const r = await contributors('gitee', { owner: 'a', repo: 'b' }, { maxPeople: 100 });
  assert.equal(r.total, 2, 'gitee 的 contributors 端点不分页，长度即精确总数');
});

test('a fetch failure propagates instead of becoming "no contributors"', async (t) => {
  // Gitee 适配器在 HTTP 失败时明确抛出。这个错误必须抵达调用方，
  // 否则 catalogue 会把它记成「仓库没有贡献者」——一个可接受的降级，
  // 于是真实故障被藏起来。
  stubFetch(t, async () => ({ ok: false, status: 403, headers: { get: () => null }, json: async () => null }));

  await assert.rejects(
    () => contributors('gitee', { owner: 'a', repo: 'b' }, { maxPeople: 5 }),
    /gitee contributors HTTP 403/,
  );
});

test('a missing token propagates instead of becoming "no contributors"', async () => {
  // CNB 没有令牌就无法读；这不是「这个仓没有贡献者」。
  const saved = { a: process.env.MJ_CNB_TOKEN, b: process.env.CNB_TOKEN };
  delete process.env.MJ_CNB_TOKEN;
  delete process.env.CNB_TOKEN;
  try {
    await assert.rejects(
      () => contributors('cnb', { owner: 'a', repo: 'b' }, { maxPeople: 5 }),
      /MJ_CNB_TOKEN/,
    );
  } finally {
    if (saved.a !== undefined) process.env.MJ_CNB_TOKEN = saved.a;
    if (saved.b !== undefined) process.env.CNB_TOKEN = saved.b;
  }
});

test('a repository with genuinely nobody returns null, not an error', async (t) => {
  // 空数组是仓库事实：没有贡献者就是没有。这不是失败，不该阻塞。
  stubFetch(t, async () => jsonResponse([]));
  const r = await contributors('gitee', { owner: 'a', repo: 'b' }, { maxPeople: 5 });
  assert.equal(r, null);
});

test('an unknown platform is simply unsupported', async () => {
  const r = await contributors(/** @type {any} */ ('sourcehut'), { owner: 'a', repo: 'b' });
  assert.equal(r, null);
});

test('the privacy whitelist never carries email through', async (t) => {
  // Gitee/GitLab 的端点返回明文 email。返回对象只能有 login/avatar/url。
  stubFetch(t, async (url) => {
    if (String(url).includes('/users/')) return jsonResponse({ message: 'Not Found' });
    return jsonResponse([{ name: 'alice', email: 'alice@secret.example' }]);
  });

  const r = await contributors('gitee', { owner: 'a', repo: 'b' }, { maxPeople: 5 });
  assert.deepEqual(Object.keys(r.people[0]).sort(), ['avatar', 'login', 'url']);
  assert.ok(!JSON.stringify(r).includes('secret.example'), 'email 不得出现在返回值里');
});
