# 上架准备 · 文件夹索引（天枢 TPI 2.0 插件）

发行包只包含 `plugin/` 目录；本文件整理提交插件库时要填写的材料和还差的步骤。

## 选哪个分区

提交到**免费官方授权 `official_reviewed`**。

- 插件声明了 `shell`，按规范只有官方审核分区可以申请。
- 付费未审核分区 `paid_unreviewed` 目前被宿主阻止执行，而且不允许 `shell`，所以不考虑。

## 打包

用官方 TPI 2.0 starter 里的 `scripts/pack.mjs`，在 starter 目录运行（Node ≥ 24）：

```powershell
node scripts/pack.mjs --plugin-dir <本仓库>/plugin --publisher-id <发布者ID> --lane official_reviewed --platforms win32-x64,darwin-arm64 --source-commit <源码提交>
```

生成的 ZIP 会自动重新校验。CI 和人工审核必须用同一份 ZIP，记下输出里的 `zipSha256`。

## 数据用途说明（提交表单可直接改用）

**本地读取**

- 用户在对话中让天枢调用 `folder_index_scan_agents`，并在确认框里批准后，插件才会通过天枢的命令工具运行包内的 `scanner.mjs`。每次扫描都需要单独确认。
- 扫描器只读不写，读取以下本机记录，用来找出用户做过事的项目文件夹：
  - Claude Code（`~/.claude/projects`、Claude 桌面版会话记录）
  - Codex（`~/.codex/sessions` 和 `config.toml` 里的信任目录）
  - WorkBuddy
  - VS Code、Cursor、Qoder、Trae、Windsurf、Kiro 的 `workspaceStorage`
  - Orca 的工作树记录
  - opencode 和 Antigravity 的 SQLite 记录（只读打开）
- 会话记录文件只读开头一段（最多 256 KiB），用来取出工作目录字段。对话内容不会被保存、输出，也不会发出去。
- 用户在扫描时给出 Folder Index 索引目录的话，扫描器会读取这个目录下的目录联接，用来保留抽屉分类。不给就不读。
- 扫描器跳过网络共享和设备路径，不会因为记录里的路径去访问其他主机。

**本地写入**

只写天枢分配给插件的数据目录（`host.storage.dataDir()`）：

| 文件 | 内容 |
| --- | --- |
| `projects.json` | 项目名、路径、抽屉、Agent 名、会话数、最近活跃时间 |
| `pinned/`、`overrides/` | 置顶和归类 |
| `drawers.json` | 虚拟抽屉 |
| `prefs.json` | 主题、排序、上次用的索引目录 |

插件不改动、不删除用户磁盘上的其他文件。

**网络与模型**

不联网（没有申请 `net`），不调用模型，不读取对话历史。

**保留与删除**

数据一直留在本机的插件数据目录里，卸载插件时随数据目录一起删除。重新扫描或导入会覆盖 `projects.json`。

## 权限说明（给审核员）

| 能力 | 用途 |
| --- | --- |
| `tools` | `folder_index_search`（只读查询已导入的项目）、`folder_index_scan_agents`（扫描） |
| `storage` | 保存项目快照、置顶、归类和偏好 |
| `ui` | 「文件夹索引」面板：卡片目录柜和 Agent 项目树 |
| `shell` + `permissions.shell.run` | 只用来运行包内的 `scanner.mjs`。命令由插件按固定格式拼出：天枢自带的 Node 运行时 + 扫描器路径 + Base64URL 编码的参数，用户输入不会原样进入命令行。命令同时兼容 Git Bash 和 PowerShell。 |

## 还差的步骤（需要发布者本人完成）

- [ ] 在插件库[上传插件](https://xiaosiai.cn/developers/upload)页面注册或登录，拿到发布者 ID，完成发布者核验。
- [ ] 登记插件 ID `folder-index`（如果被占用，同步修改 `tianshu.plugin.json` 和 `index.mjs` 里的 `id`）。
- [x] 许可证：MIT（见 `LICENSE`）。
- [x] 公开源码：本仓库，提交表单时填本仓库的 HTTPS 地址和打包用的提交号。
- [ ] 写更新说明（首个版本 0.1.0）。
- [ ] 审核通过、装进天枢以后做一次真机验证：扫描确认框能不能正常出现、扫描能不能跑通、面板能不能实时刷新。
