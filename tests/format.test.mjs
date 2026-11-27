// 站点纯函数的测试：日期格式化与域名提取。
//
// 跑法：node --test tests/
//
// formatDay 守的是一个真实事故：`new Date(坏值).toISOString()` 抛
// RangeError，而它位于整表 innerHTML 拼接里，于是 main() 的 catch
// 把整张表换成一行错误 —— 一条坏日期让全部条目消失。
import test from 'node:test';
import assert from 'node:assert/strict';

import { DASH, esc, formatDay, hostOf, rowCellsHtml, fallbackRowHtml } from '../site/format.js';

test('a valid timestamp becomes YYYY-MM-DD', () => {
  assert.equal(formatDay('2026-11-23T14:41:41+08:00'), '2026-11-23');
  assert.equal(formatDay('2026-01-01T00:00:00Z'), '2026-01-01');
});

test('a broken timestamp degrades to a dash instead of throwing', () => {
  // 这就是那个会让整张表消失的输入。
  assert.equal(formatDay('not-a-date'), DASH);
  assert.equal(formatDay(''), DASH);
  assert.equal(formatDay(undefined), DASH);
  assert.equal(formatDay(null), DASH);
});

test('formatDay never throws for arbitrary junk', () => {
  for (const junk of ['2026-13-45', 'NaN', '   ', '0', {}, []]) {
    assert.doesNotThrow(() => formatDay(junk));
    assert.equal(typeof formatDay(junk), 'string');
  }
});

test('hostOf strips www and handles two platforms with the same repo name', () => {
  assert.equal(hostOf('https://gitcode.com/mindspore/mindspore'), 'gitcode.com');
  assert.equal(hostOf('https://gitee.com/mindspore/mindspore'), 'gitee.com');
  assert.equal(hostOf('https://www.github.com/a/b'), 'github.com');
});

test('hostOf returns an empty string rather than throwing on junk', () => {
  assert.equal(hostOf('not a url'), '');
  assert.equal(hostOf(''), '');
});

test('esc neutralises every HTML metacharacter', () => {
  // catalogue 的字段来自第三方平台。未转义就是一条 XSS 通路。
  assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(esc('a & b'), 'a &amp; b');
  assert.equal(esc('"quoted"'), '&quot;quoted&quot;');
  assert.equal(esc("it's"), 'it&#39;s');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});

test('a hostile repository name cannot break out of its cell', () => {
  const html = rowCellsHtml({
    url: 'https://github.com/a/b',
    name: '<img src=x onerror=alert(1)>',
  });
  assert.ok(!html.includes('<img src=x'), '名称里的标签必须被转义');
  assert.ok(html.includes('&lt;img src=x'));
});

test('missing description and license fall back to a dash, not to "undefined"', () => {
  const html = rowCellsHtml({ url: 'https://github.com/a/b', name: 'b' });
  assert.ok(!html.includes('undefined'), '缺失字段不能渲染成 undefined');
  assert.ok(html.includes(`<td class="desc">${DASH}</td>`));
  assert.ok(html.includes(`<td class="lic">${DASH}</td>`));
});

test('a broken lastCommit renders as a dash but the row still builds', () => {
  const html = rowCellsHtml({
    url: 'https://github.com/a/b',
    name: 'b',
    lastCommit: 'not-a-date',
  });
  assert.ok(html.includes(`<td class="num">${DASH}</td>`));
  assert.ok(html.includes('>b<'), '同一行的其余单元格照常渲染');
});

test('the fallback row keeps a usable link for the broken entry', () => {
  const html = fallbackRowHtml({ url: 'https://github.com/a/b', name: 'b' });
  assert.ok(html.includes('href="https://github.com/a/b"'));
  assert.ok(html.includes('这一行渲染失败'));
});
