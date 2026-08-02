# Add to Terminal

> 一键将文件引用、选中代码行范围、编译报错信息发送到终端，专为 [Claude Code CLI](https://claude.com/claude-code) 工作流优化。

## 痛点分析

在使用 Claude Code 等终端 AI 编程工具时，最常见的操作是让 AI 帮你**定位问题、修改代码、修复报错**。但每次你都需要手动完成以下步骤：

1. 记住出问题的文件路径
2. 记住报错所在的行号
3. 复制报错信息
4. 回到终端，手打 `` `path/to/file.ts:42` `` 和错误描述
5. 再输入你的问题

这个流程**频繁打断编码思路**，每次至少要花 10-20 秒手动拼接路径和行号，一天下来浪费大量时间。文件路径一长，还容易打错。

## 解决方案

**Add to Terminal** 让这一切**一键完成**。无论你在编辑器中、在文件资源管理器中、还是看到编译报错的红色波浪线，只需要一次点击或快捷键，文件引用和诊断信息就直接出现在终端输入框中——未执行，你可以继续补充问题描述，然后回车。

## 核心功能

### 📄 文件 + 行号引用

在编辑器中 **右键** 或按 **`Ctrl+Alt+T`**（Mac: `Cmd+Alt+T`），自动将当前文件路径和选中行范围发送到终端：

```
`src/extension.ts:42-58`
```

- 单行光标：`` `src/extension.ts:42` ``
- 多行选中：`` `src/extension.ts:42-58` ``
- 路径格式可配置（相对路径 / 绝对路径 / 仅文件名）

### 📁 资源管理器文件引用

在文件资源管理器中**右键任意文件**，一键将文件路径发送到终端：

```
`src/extension.ts`
```

支持**多选文件**，用逗号分隔：

```
`src/extension.ts`, `src/utils.ts`, `package.json`
```

### 🔴 报错信息一键添加

光标放在**红色波浪线**（编译错误）或**黄色波浪线**（警告）上，点击出现的💡**灯泡图标**（或 `Ctrl+.`），在 Quick Fix 菜单中点击 **"Add to Terminal"**：

```
`src/app.ts:42` error: Cannot find name 'foo'
`src/utils.ts:15` warning: Unused variable 'x'
```

> 这意味着你看到报错 → 点灯泡 → 点 Add to Terminal → 终端里直接有了 `路径+行号+错误信息` → 输入你的问题 → 回车，Claude Code 立刻开始分析。

## 使用场景

| 场景 | 操作 | 终端输出 |
|---|---|---|
| 让 AI 分析某段代码 | 编辑器选中代码行 → `Ctrl+Alt+T` | `` `src/app.ts:30-45` `` |
| 让 AI 修复报错 | 光标放红色波浪线 → 灯泡 → Add to Terminal | `` `src/app.ts:42` error: Cannot find name 'foo' `` |
| 让 AI 了解项目结构 | 资源管理器选中多个文件 → 右键 → Add to Terminal | `` `src/index.ts`, `src/utils.ts`, `package.json` `` |
| 让 AI 审查代码 | 选中代码 → 右键 → Add to Terminal → 继续输入"review this" | `` `src/app.ts:30-45` review this `` |

## 快捷键

| 命令 | Windows / Linux | macOS |
|---|---|---|
| Add to Terminal | `Ctrl+Alt+T` | `Cmd+Alt+T` |

## 配置

| 设置项 | 说明 | 可选值 | 默认值 |
|---|---|---|---|
| `addToTerminal.pathFormat` | 路径格式 | `relative` / `absolute` / `basename` | `relative` |

## 安装

```bash
npm install
npm run compile
```

按 `F5` 启动调试，或执行 `npm run package` 打包为 `.vsix` 文件安装。

## 为什么用 Add to Terminal？

| | 手动操作 | 用 Add to Terminal |
|---|---|---|
| 输入文件引用 | 打路径 + 行号，容易出错 | 一键，零出错 |
| 添加报错信息 | 复制报错 → 切换窗口 → 粘贴 | 灯泡菜单一键 |
| 多文件引用 | 逐个手打，逗号分隔 | 多选文件一键 |
| 打断编码思路 | 频繁切换窗口 | 无缝衔接，思路不中断 |

## License

MIT
