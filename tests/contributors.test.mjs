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

test('a noreply address used as a display name is reduced to the username', async (t) => {
  // 实测 Gitee 的 contributors 会把 name 填成
  // `7347157+joylvliang@user.noreply.gitee.com`。原样显示是一串噪声，
  // 而且这种形态不该出现在页面上。GitHub 的 contributors 用同款格式。
  stubFetch(t, async (url) => {
    if (String(url).includes('/users/')) return jsonResponse({ message: 'Not Found' });
    return jsonResponse([
      { name: '7347157+joylvliang@user.noreply.gitee.com', email: 'x@y' },
      { name: '12345+octocat@users.noreply.github.com', email: 'x@y' },
      { name: 'chenfei', email: 'x@y' },
    ]);
  });

  const r = await contributors('gitee', { owner: 'a', repo: 'b' }, { maxPeople: 5 });
  assert.deepEqual(r.people.map((p) => p.login), ['joylvliang', 'octocat', 'chenfei']);
  // 改写后不得残留 @
  for (const p of r.people) assert.ok(!String(p.login).includes('@'));
});

test('mapLimited keeps results in input order despite concurrency', async (t) => {
  // 并发写回按索引，所以顺序必须与接口给的顺序一致（按贡献排序）。
  // 故意让靠前的请求更慢：若按完成顺序 push，顺序就会乱。
  const names = ['slow', 'fast', 'mid', 'last'];
  const delays = [30, 1, 10, 1];
  stubFetch(t, async (url) => {
    const s = String(url);
    const idx = names.findIndex((n) => s.includes(`/${n}`));
    await new Promise((res) => setTimeout(res, delays[idx] ?? 0));
    if (s.includes('/users/')) return jsonResponse({ message: 'Not Found' });
    return jsonResponse(names.map((name) => ({ name, email: 'x@y' })));
  });

  const r = await contributors('gitee', { owner: 'a', repo: 'b' }, { maxPeople: 10 });
  assert.deepEqual(r.people.map((p) => p.login), names);
});

test('gitlab keeps names but does not guess usernames from real emails', async (t) => {
  // GitLab 的 contributors 端点只给 name + email，没有任何 username；
  // 实测 email 是真实邮箱，本地部分（twatson / rsarangadharan）不是账号名，
  // 拿它去 /users?username= 查，100 个贡献者 0 命中 —— 全是空转请求。
  // 所以适配器不该发那些请求，也别把邮箱本地部分当成账号名展示。
  let userLookups = 0;
  stubFetch(t, async (url) => {
    const s = String(url);
    if (s.includes('/users')) { userLookups += 1; return jsonResponse([]); }
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) },
      json: async () => [
        { name: 'Tiger Watson', email: 'twatson@gitlab.com' },
        { name: 'Aftab Shaik', email: 'aftabshaik07@aol.com' },
      ],
    };
  });

  const r = await contributors('gitlab', { owner: 'a', repo: 'b' }, { maxPeople: 10, token: 'glpat-x' });

  assert.equal(userLookups, 0, '没有可靠的 username 可查，就不该发这些请求');
  assert.deepEqual(r.people.map((p) => p.login), ['Tiger Watson', 'Aftab Shaik']);
  assert.ok(r.people.every((p) => p.avatar === null), '头像是平台事实的缺失，不是抓取失败');
  // 真实邮箱的本地部分不得出现在输出里
  assert.ok(!JSON.stringify(r).includes('twatson'));
  assert.ok(!JSON.stringify(r).includes('aftabshaik07'));
});

/** 一个 429 响应，带指定的 retry-after。 */
function rateLimited(retryAfter) {
  return {
    ok: false,
    status: 429,
    headers: { get: (k) => (k === 'retry-after' ? String(retryAfter) : null) },
    json: async () => null,
  };
}

test('a long retry-after fails fast instead of retrying blindly', async (t) => {
  // 实测 GitLab 匿名配额耗尽会回 retry-after: 3006（等 50 分钟）。
  // 旧代码写死等 1.5 秒就重试 —— 必然再次 429，于是每个贡献者撞一次墙。
  // 现在必须立刻放弃，把「限流」这个事实抛出去（调用方记 reason、判据阻塞），
  // 而不是耗光 job 时间。
  let calls = 0;
  stubFetch(t, async () => { calls += 1; return rateLimited(3006); });

  const started = Date.now();
  await assert.rejects(
    () => contributors('gitee', { owner: 'a', repo: 'b' }, { maxPeople: 5 }),
    /HTTP 429/,
  );
  const elapsed = Date.now() - started;

  assert.equal(calls, 1, 'retry-after 太长时不该重试');
  assert.ok(elapsed < 2000, `不该等 3006 秒（实际 ${elapsed}ms）`);
});

test('a short retry-after is honoured, and the retry happens once', async (t) => {
  // 短等待值得重试：这是正常的退避，不是撞墙。
  // 请求序列：contributors(429) → contributors(重试成功) → 每人一次 users 查询。
  let calls = 0;
  stubFetch(t, async (url) => {
    calls += 1;
    if (calls === 1) return rateLimited(1);
    if (String(url).includes('/users/')) return jsonResponse({ message: 'Not Found' });
    return jsonResponse([{ name: 'alice', email: 'a@x' }]);
  });

  const r = await contributors('gitee', { owner: 'a', repo: 'b' }, { maxPeople: 5 });
  assert.equal(calls, 3, '一次重试 + 一次账号查询');
  assert.equal(r.people.length, 1);
});

test('a 429 with no retry-after does not spin', async (t) => {
  // 读不到 retry-after 时不能无限重试：一次就够。
  let calls = 0;
  stubFetch(t, async () => {
    calls += 1;
    return { ok: false, status: 429, headers: { get: () => null }, json: async () => null };
  });

  await assert.rejects(() => contributors('gitee', { owner: 'a', repo: 'b' }, { maxPeople: 5 }));
  assert.equal(calls, 1, '缺 retry-after 时应立即放弃，不重试');
});

test('gitlab sends its token when one is configured', async (t) => {
  // 即使现在不再逐人查账号，contributors 与 total 两个请求仍应带 token：
  // 匿名配额按 IP 算且很小，这个仓一次派生要发多次。
  /** @type {Record<string,string>[]} */
  const seenHeaders = [];
  stubFetch(t, async (url, init) => {
    seenHeaders.push(init?.headers ?? {});
    if (String(url).includes('/contributors')) {
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) },
        json: async () => [{ name: 'alice', email: 'a@x' }],
      };
    }
    return jsonResponse([]);
  });

  await contributors('gitlab', { owner: 'a', repo: 'b' }, { maxPeople: 5, token: 'glpat-test' });
  const used = seenHeaders.some((h) => h['PRIVATE-TOKEN'] === 'glpat-test');
  assert.ok(used, 'GitLab 请求必须带上 PRIVATE-TOKEN —— 匿名配额撑不住逐人查询');
});
