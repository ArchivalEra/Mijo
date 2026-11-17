# Mijo

> a git catalogue for every human and machine

一个跨平台仓库目录：从一个 URL 列表派生仓库的名称、维护者、描述、最后提交时间与许可证，
发布为 [isui.ren/Mijo](https://isui.ren/Mijo)。

## 怎么加一个仓库

1. 把仓库 URL 粘进 [`material/urls.txt`](material/urls.txt)，一行一个，`#` 开头是注释
2. 推送 —— CI 自动派生 `site/catalogue.json` 并部署

拉不到的条目分两类，判据不同：

- **可接受**（仓库事实）：私有、已删除、无权限读取，或平台接口本就不提供该字段。
  这些记进 `catalogue.json` 的 `rejected[]` / entry 的 `reasons`，页面照常渲染。
- **阻塞**（配置或网络问题）：缺访问令牌、限流、网络失败、字段为空又没给原因。
  这些让派生**退出非零**，CI 变红、**不部署**——线上继续跑上一版，而不是发一版缺数据的目录。

`node scripts/generate-catalogue.mjs` 的最后会打印一份完整性裁决，逐条列出阻塞项与降级项。

## 数据来源

| 平台 | 读取方式 |
|---|---|
| GitCode / AtomGit | 经 `ag-cli`（需平台令牌） |
| CNB | 经 `@xindiwo/git-sdk`（需平台令牌） |
| GitHub / Gitee / GitLab / Bitbucket | 公开仓匿名可读 |

`lastCommit` 取各平台 commits 端点（不是 `pushedAt`/`updatedAt`——后者会差出几个月）；
GitLab / Bitbucket 的仓库对象没有 license 字段，回退到读 LICENSE 文件识别 SPDX 标识。

## 部署

`main` 推送 → 派生 catalogue → dispatch [`isui.ren-heart`](https://github.com/ArchivalEra/isui.ren-heart)
的 deploy workflow → heart 主动拉本仓 `site/` 放进 `Mijo/` slot。

本仓**不写** heart 的 deploy 分支：那条分支是多个 slot 仓共用的平面，单点写入才不会互相覆盖。

## 开发

```bash
npm ci
node scripts/generate-catalogue.mjs   # 本地派生（有 ag-cli 登录态或相应 token）
python3 -m http.server -d site 8000   # 预览
```

## License

AGPL-3.0-or-later，与 isui.ren-heart 一致。
