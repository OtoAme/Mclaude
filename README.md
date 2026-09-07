# mclaude

面向 macOS 的 Claude Code 启动器：在任意 IDE 的终端中，使用 Mirasim Desktop 的模型配置启动 Claude Code。无第三方依赖。

## 使用条件

- macOS；以下安装步骤使用 macOS 默认的 zsh。
- Node.js 20 或更高版本。
- 已安装 Claude Code，终端可以执行 `claude`。
- 已安装并启动 Mirasim Desktop，本机服务端口为 `4970`。
- 使用 Mirasim 云额度时，需在 Desktop 中完成登录并选择云路由。

## 安装

在项目目录中创建命令入口：

```bash
chmod +x mclaude.cjs
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/mclaude.cjs" "$HOME/.local/bin/mclaude"
```

将下面这行加入 `~/.zshrc`，然后打开新终端：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

命令入口指向项目文件，移动项目后需要更新链接。也可以直接执行 `node /项目路径/mclaude.cjs`。

## 使用

```bash
# 使用 Desktop 的默认模型和推理强度
mclaude

# 查看版本、模型映射和回退情况，不调用模型
mclaude --dry-run

# 为本次启动指定模型和推理强度
mclaude --model sonnet --effort low

# 继续最近的会话
mclaude --continue
```

`--model` 支持 `opus`、`sonnet`、`haiku`、`fable` 别名或 Desktop 目录中的完整模型 ID。`--effort` 支持 `low`、`medium`、`high`、`xhigh`、`max`；`ultra` 会转换为 `max`。其余参数透传给 Claude Code。

## 配置行为

- 每次启动读取 Desktop 已确认可用的版本和当前模型目录，普通更新后无需手改版本号。
- 模型、推理强度、角色映射和子代理默认模型通过本次启动参数覆盖，不写回 CC Switch 管理的配置文件。
- 继续加载现有的技能、MCP、Hooks 和权限设置；登录与请求路由由 Mirasim 处理。
- 同系列优先沿用所选主模型，否则选取目录中该系列的最新模型；缺少某个系列时回退到主模型，并打印提示。
- Desktop 未运行或返回无效配置时会报错。Mirasim 内部入口或接口格式变化时，可能需要更新启动器。

## 验证

```bash
npm test
mclaude --dry-run
```

测试覆盖版本自动跟随、模型映射、角色回退和参数传递。
