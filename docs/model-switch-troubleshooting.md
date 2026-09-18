# 模型切换排障（本地 fork 记录）

切换模型（例如 `deepseek-official/deepseek-v4-flash` ↔ `kimi-coding/kimi-for-coding`）后，
会话可能连续出现三类失败。本文记录成因与本 fork 的处理方式。

## 现象

| 界面提示 | 错误码 | 出现时机 |
|---|---|---|
| `Selected model is at capacity. Please try a different model.` | 供应商原文 | 目标模型并发/容量已满（pi-ai 路由返回） |
| `pi-ai detected context overflow for model "kimi-for-coding"` | `CONTEXT_WINDOW_EXCEEDED` | 会话上下文超过目标模型的目录窗口 |
| `DeepSeek request extension preparation failed` | `REQUEST_EXTENSION` | DeepSeek 请求扩展在 HTTP 分发前准备失败 |

表现为「本轮运行失败 + 空回复」，且切换模型后反复出现。

## 成因

1. **容量文本被当成不可重试错误。** `classifyPiAiError` 只识别 401/403/429/5xx/超时等；
   “at capacity / overloaded” 落到兜底 `PI_AI_ERROR`，而默认重试集合只含
   `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`，于是**不重试直接失败**。
2. **溢出恢复依赖同一个模型。** `dsh-compaction-basic` 在 `CONTEXT_WINDOW_EXCEEDED` 时会
   调用摘要压缩再重试；摘要默认使用“当前 routed 模型”。若该模型正限流或窗口更小，
   摘要本身失败 → 保留原始错误 → 本轮失败。
3. **单个扩展贡献者失败会拖垮整个请求。** DeepSeek 扩展注册表 `prepare()` 中任一贡献者抛错，
   `dsh-llm-deepseek` 即包装为 `REQUEST_EXTENSION` 并**拒绝分发**。已知两个抛错源：
   - `dsh-plugin-package-inventory-deepseek`：解析不到活动包时 `throw`；
   - `dsh-session-log-deepseek`：水位线扫描遇到被压缩裁剪的事件时 `throw`。

## 本 fork 的处理

补丁（`patches/`，`postinstall` 自动应用）：

- `dsh-llm-pi-ai` / `dsh-llm-deepseek`：把 `at|over capacity`、`overloaded`、`server is busy`
  等文本归类为可重试的 `RATE_LIMIT`，交由 `dsh-llm-retry` 退避重试。
- `dsh-deepseek-llm-api-extensions`：单个贡献者 `prepare()` 失败时**跳过该字段并告警**，
  不再拒绝整个请求（中止语义与字段冻结保持不变）。
- `dsh-plugin-package-inventory-deepseek`：解析不到包时降级为未知身份。
- `dsh-session-log-deepseek`：水位线扫描容忍被裁剪的事件与畸变记录。

运行配置（`~/Library/Application Support/dsh-desktop/harness/settings.yaml`）：

```yaml
compaction-basic:
  summarizationProvider: deepseek-official
  summarizationModel: deepseek-v4-flash
```

把溢出恢复的摘要模型固定为稳定模型，切换到小窗口模型时摘要仍能完成。
配置改动需重启应用生效（原文件已备份为 `settings.yaml.bak-*`）。

回归测试：`test/model-switch-resilience-patch.test.ts`（补丁契约）、
`test/provider-error-patch.test.ts`（既有错误分类契约）。
