---
name: ast-grep
description: 结构化代码搜索与改写。当需要按语法结构（而非文本）查找/批量修改代码时使用：如"找所有调用某函数的地方""把所有 var 改成 let""找出所有包含 await 的 async 函数"。比 grep/glob 精度高一个量级。
whenToUse: 需要语法级代码搜索、批量 API 迁移、查找特定代码模式（函数定义、调用点、import 来源）时；文本 grep 产生大量误报时。
---

# ast-grep：结构化代码搜索

环境中已安装 `ast-grep`（CLI 命令 `ast-grep` 或 `sg`）。它按 AST 语法结构匹配代码，而非文本。

## 核心用法

### 1. 模式搜索（最常用）

```bash
# 找所有 console.log 调用（$A 是元变量，匹配任意 AST 节点）
ast-grep run --pattern 'console.log($A)' --lang ts <目录>

# 找所有 await 某函数的调用
ast-grep run --pattern 'await $FOO($$$ARGS)' --lang ts src/

# 找 Python 中所有 requests.get 调用
ast-grep run --pattern 'requests.get($URL)' --lang python .
```

元变量规则：`$VAR` 匹配单个节点，`$$$ARGS` 匹配多个节点（如参数列表）。

### 2. 输出 JSON（喂给自己做进一步处理）

```bash
ast-grep run --pattern 'fetch($URL)' --lang ts --json=pretty src/
```

### 3. 结构化改写（谨慎使用，先不带 -U 预览）

```bash
# 预览匹配
ast-grep run --pattern 'var $X = $Y' --rewrite 'let $X = $Y' --lang ts src/
# 确认无误后加 -U 实际改写（改写前文件会被 file-undo 自动快照）
ast-grep run --pattern 'var $X = $Y' --rewrite 'let $X = $Y' --lang ts -U src/
```

### 4. YAML 规则（复杂条件，如"找到所有没有错误处理的 await"）

```bash
ast-grep scan --rule rule.yml src/
```

规则文件示例：

```yaml
id: find-async-fn
language: TypeScript
rule:
  kind: function_declaration
  has:
    kind: await_expression
```

## 常用语言标识

`ts` `tsx` `js` `jsx` `python` `go` `rust` `java` `c` `cpp` `html` `css` `json` `yaml`

## 何时不用

- 简单文本查找（函数名出现位置）→ 直接用 grep 工具更快
- 需要跨文件引用关系图（谁 import 了谁）→ ast-grep 是单文件粒度，改用 serena 的 `find_referencing_symbols`（mcp__serena__*）
