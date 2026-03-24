# Add to Terminal

VS Code 插件：快速将 `file:line` 引用发送到终端，方便与 Claude Code CLI 配合使用。

## 功能

选中代码后，将 `file:line-end` 格式的引用发送到终端（不自动执行），省去手动复制路径和行号的时间。

**输出示例**：
- 单行：`src/extension.ts:10`
- 多行：`src/extension.ts:10-25`

## 使用方式

1. 在编辑器中选中代码（或光标停在某行）
2. 按 `Ctrl+Alt+T` 或右键选择 "Add to Terminal: File Reference"
3. 终端显示引用（未执行）
4. 继续输入问题，按 Enter 执行

## 快捷键

| 命令 | Windows/Linux | macOS |
|------|---------------|-------|
| Add to Terminal | `Ctrl+Alt+T` | `Cmd+Alt+T` |

## 配置

| 设置 | 说明 | 默认值 |
|------|------|--------|
| `addToTerminal.pathFormat` | 路径格式 (absolute/relative/basename) | `relative` |

## 安装

```bash
npm install
npm run compile
```

按 F5 启动调试。

## License

MIT