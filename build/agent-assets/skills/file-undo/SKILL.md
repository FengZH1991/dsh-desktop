---
name: file-undo
description: 文件级撤销/回滚。每次 edit/write 工具修改文件前会自动快照到 .dsh-undo/，当用户要求"撤销刚才的修改"、"回滚某个文件"、"恢复到之前版本"时使用本技能。
whenToUse: 用户要求撤销、回滚、恢复文件到修改前状态时；或你自己意识到刚才的编辑有误需要回退时。
---

# 文件级 Undo

本环境已在 `edit` / `write` 等修改类工具执行前自动为文件创建快照，存放于工作区 `.dsh-undo/` 目录。

## 查看最近快照

```bash
node "$DSH_HOME/hooks/undo.mjs" list .
```

输出最近 20 条：`时间戳  工具名  文件路径`。

## 回滚指定文件

```bash
node "$DSH_HOME/hooks/undo.mjs" revert <文件路径> .
```

把文件恢复到该文件**最近一次修改前**的内容。

## 回滚最近一次修改

```bash
node "$DSH_HOME/hooks/undo.mjs" revert-last .
```

## 注意

- 快照在**修改前**创建，因此 revert 恢复的是修改前内容。
- 若文件是本次新建的（快照时不存在），revert 会删除该文件。
- 每个工作区最多保留 200 个快照，自动清理最旧的。
- 回滚前先用 `list` 确认目标快照的时间与文件，避免误回滚。
