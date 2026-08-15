# 更好的统计条（dsh-plugin-better-stats-line）

> 原名 dsh-plugin-subagent-stats —— GitHub 仓库名仅支持 ASCII，故仓库名使用英文，
> 项目显示名与插件设置入口均为「更好的统计条」。

把当前会话及其所有子孙 subagent 会话的统计合并到 DeepSeek Harness Web 底部统计条，
补全子 agent 的输入/输出 token、缓存命中、LLM/工具耗时等计算缺口。

## 功能特性

- **全树统计合并**：底部统计条不再只显示当前会话，而是「当前会话 + 所有子孙 subagent 会话」的合计（轮/步、LLM/工具耗时、首 token 平均、tok/s、缓存命中率、输入/输出 token）。
- **实时更新**：子 agent 运行中产生的统计会实时汇入（依赖 DSH 的 `session/projection` 推送帧）。
- **悬停明细**：统计条过长被截断时（或存在子会话时），悬停显示黑框气泡：
  - **合计**：完整合并数据，单行显示不换行；
  - **主对话（当前会话）**：当前会话自己的用量；
  - **子 agent（N 个）**：所有子会话的合计用量（子会话 ≤5 个时逐个子会话列出）。
- **缓存命中率精确到小数点后 2 位**（如 `99.22%`）。
- **可自定义（设置 → 常规 → 「统计条」下拉栏）**：
  - 底部数据栏与悬停气泡的每一组数据（轮次·步数 / LLM·工具耗时 / 首 token·速率 / 缓存命中 / 输入·输出）都可以**单独开关**；
  - 气泡**背景色、高亮数值色、每一列的颜色**都可自由调配，每个颜色同时提供**取色器**与 **RGB 数字输入**，并支持一键重置；
  - 所有设置持久化保存（localStorage），刷新后依然生效。
- **纯浏览器端插件**：host 半是 no-op，无任何服务端改动；安装后无需重启 DSH。

## 原理

DSH Web 底部统计条（`StatsLine`）只读取**当前会话**自己的两个 projection：

| projection | 内容 | 提供方 |
|---|---|---|
| `sessionStats` | 轮/步、LLM/工具/首 token/解码耗时 | `@deepseek-ai/dsh-session-stats` |
| `tokenUsage` | uncached / cacheRead / cacheWrite / output tokens | `@deepseek-ai/dsh-token-meter` |

子 agent 是独立会话，它们的数字从不进入父会话的统计，造成计算缺口。

本插件通过 **slot 影子机制**替换原 `StatsLine`：

1. 以 `priority: -1` 重新注册 slot `conversation.composer.dock` 中 id 为 `stats` 的条目（list slot 每个 id 只保留最低优先级的一个），从而替换原统计条组件而不产生重复行；
2. 新组件从会话列表快照（`useSessions`）按 `parentId` 递归收集所有子孙会话；
3. 通过 `sessions.binding(childId).session.projections` 读取每个子孙会话的 `sessionStats` / `tokenUsage`，与当前会话自身逐字段相加；
4. 重新计算派生指标：首 token 平均（总 ttft / 总 ttftSteps）、tok/s（总输出 / 总解码时长）、缓存命中率（总 cacheRead / 总计费输入，保留 2 位小数）；
5. `useSessions` 在任何会话的 `session/projection` 帧到达时都会触发重渲染，因此子 agent 的统计实时汇入。

## 安装

> 需要本机已安装 pnpm（DSH profile 使用 pnpm 管理依赖）。

```bash
# 1. 把包安装为 web profile 的依赖（会写入 profile/package.json 与 node_modules）
cd ~/.dsh/profiles/web
pnpm add "file:C:/path/to/dsh-plugin-subagent-stats"

# 2. 在 profile 的 cordis.patch.yml 追加（web profile 的 hmr watcher 会实时重载 loader）：
#
# - insert:
#     - id: subagent-stats
#       name: 'dsh-plugin-subagent-stats'

# 3. 刷新浏览器页面即可生效（无需重启 DSH）
```

### 说明

- pnpm 对 `file:` 依赖默认做**拷贝**而非符号链接：修改插件源码后需把 `lib/` 下的文件重新拷贝到 `profiles/web/node_modules/dsh-plugin-subagent-stats/lib/`，HMR 轮询器检测到变化后会自动更新 bundle rev。
- 已打开的浏览器页面：新增插件行需要刷新页面；仅 bundle 内容变化时 HMR 会自动热更新。

## 验证

项目附带真实浏览器 E2E 验证脚本（`verify/`，环境相关，仅开发用）：

```bash
# 读取统计条 + 悬停气泡（含单行/溢出断言）
node verify/e2e-tooltip.cjs "<会话标题>"

# 以 host 投影缓存为真值，校验合并算术逐字节一致
node verify/verify-merge.cjs
```

> 脚本中的会话 ID、缓存路径、playwright 可执行文件路径等为编写时的本机环境值，使用前请按需修改。

## 卸载

```bash
cd ~/.dsh/profiles/web
pnpm remove dsh-plugin-subagent-stats
# 并从 cordis.patch.yml 删除对应 insert 段
```

## 兼容性

- 面向 DeepSeek Harness Web 装配（`dsh --profile web`），依赖 `sessionStats` / `tokenUsage` 投影与 slot 系统；
- 打开子 agent 会话时，统计条显示该子会话自身的子树合计；
- 若 `sessionStats` projection 缺失（非常规装配），回退为仅统计当前窗口的轮/步计数。

## License

[MIT](LICENSE)
