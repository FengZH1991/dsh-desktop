---
name: repo-map
description: 生成仓库符号地图。面对陌生或大型代码库时，先运行它快速了解项目结构——列出按被引用次数排序的关键符号（函数/类/接口），比逐个读文件高效。
whenToUse: 接手陌生代码库、需要全局结构认知、定位核心模块时；用户问"这个项目结构是怎样的"时。
---

# Repo Map：仓库符号地图

借鉴 aider 的 repo map 思路：用 ast-grep 提取顶层符号定义，按被引用次数排序输出。

## 用法

```bash
node "$DSH_HOME/skills/repo-map/repo-map.mjs" <目录> [--budget 200] [--lang ts,python]
```

- `--budget`：最多输出多少行符号（默认 200，约 1-2k token）
- `--lang`：逗号分隔，支持 `ts,tsx,js,jsx,python`（默认全部）

## 输出格式

```
# Repo Map: <目录>（符号数 N，按引用数排序，预算 200 行）

src/service.ts:
  OrderService  (L12, 14 refs)
  createOrder   (L45, 8 refs)
```

引用数越高越是核心符号——优先读这些文件。

## 建议工作流

1. 先跑 repo-map 拿到全局符号排序
2. 对高引用符号用 ast-grep（`ast-grep` skill）精确定义位/调用点
3. 需要跨文件引用关系时用 serena 的 `find_referencing_symbols`（mcp__serena__*，standard-plus 预设）

## 限制

- 只覆盖 ts/tsx/js/jsx/python，其他语言请先扩展脚本中的 RULES
- 引用计数基于文本匹配（同名符号会高估），适合排序参考而非精确分析
