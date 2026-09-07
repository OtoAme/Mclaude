# mclaude

适用于 macOS 版 Mirasim Desktop 的 Claude Code 启动器，支持在任意 IDE 的内置终端中复用 Mirasim 的模型配置与请求路由。基于 Node.js 内置模块实现，无第三方 npm 依赖。

## 使用条件

- macOS。
- Node.js 20 或更高版本。
- 已安装 Claude Code，终端可以执行 `claude`（Mirasim 通过 PATH 查找该命令）。
- 已安装 Mirasim Desktop，并至少打开一次完成初始化；日常使用可以关闭 Desktop。
- 使用 Mirasim 云额度时，需在 Desktop 中完成登录并选择云路由。

## 安装

在项目目录选择一种方式安装。

使用 npm：

```bash
npm link
```

或使用 pnpm：

```bash
pnpm add -g "$PWD"
```

如果 pnpm 提示尚未配置全局命令目录，先执行 `pnpm setup`，重新打开终端，再执行安装命令。

安装后，在任意 IDE 的终端中运行：

```bash
mclaude --help
```

两种方式都会创建指向当前项目的命令入口，修改源码后立即生效，缓存也保存在此项目中。所选包管理器的全局命令目录需要在 PATH 中。

移动项目后需要在新目录重新执行所选安装命令。通过 npm 安装时，使用 nvm 切换 Node.js 版本后如果找不到命令，重新执行 `npm link`。也可以直接运行 `node /项目路径/mclaude.cjs`。

## 使用

```bash
# 使用 Desktop 的默认模型和推理强度
mclaude

# 查看版本、模型映射和回退情况，不启动 Claude Code
mclaude --dry-run

# 手动刷新模型目录，然后启动 Claude Code
mclaude --refresh

# 只刷新并查看配置，不启动 Claude Code
mclaude --refresh --dry-run

# 为本次启动指定模型和推理强度
mclaude --model sonnet --effort low

# 继续最近的会话
mclaude --continue
```

`--model` 支持 `opus`、`sonnet`、`haiku`、`fable` 别名、`default`，或 Desktop 目录中的模型 ID。优先精确匹配，再尝试忽略 `[1m]` 后缀匹配，最终使用目录中的完整 ID。例如目录仅提供 `claude-opus-5[1m]` 时，输入 `--model claude-opus-5` 也会采用该完整 ID；目录同时提供两种变体时，保留精确匹配的选择。主模型、子代理和回退角色都沿用匹配后的 ID。

`--effort` 支持 `low`、`medium`、`high`、`xhigh`、`max`；`ultra` 会转换为 `max`。`--help` 和 `-h` 需要作为唯一参数。其余参数透传给 Claude Code；`--` 之后的内容原样传递，其中的 `--model`、`--refresh` 等不再由 mclaude 解析。

## 配置行为

- 每次启动读取 `~/.mirasim/app/state.json` 中已确认可用的版本，忽略同目录下的其他版本，普通更新后无需手改版本号。
- 模型目录、默认模型和推理强度缓存 7 天，保存在 mclaude 项目的 `.cache/catalog.json`，已通过 `.gitignore` 排除，文件权限为 `0600`。无论从哪个工作目录启动，都复用这份缓存。Mirasim 版本、启动入口路径、Mirasim 配置文件内容，或 `CLAUDE_MODEL`、`CLAUDE_REASONING_EFFORT` 变化时缓存立即失效；重写内容相同的配置不会失效。`--model` 和 `--effort` 不进入缓存，每次指定仍独立生效。
- 缓存未命中时，优先连接运行中的 Desktop（本机端口 `4970`）；读取失败时，由 Mirasim CLI 临时启动一次性后台服务，读取同一份配置后自动关闭。无需手动启动后台服务。
- 缓存只保存模型信息和校验元数据，不保存登录凭据或后台端口。缓存损坏、时间戳异常或无法写入时仍会正常查询；查询期间配置发生变化时，本次结果不写入缓存。缓存过期后的下一次启动会重新获取目录；远端发布新模型后，可以使用 `--refresh` 提前刷新。刷新失败时本次启动报错，已有缓存文件保留。
- mclaude 不设置 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN`：Base URL 指向 Mirasim 的本机代理，登录与请求路由都由 Mirasim CLI 处理，不依赖 Desktop 的 `4970` 服务。
- 模型、推理强度、角色映射和子代理默认模型只通过本次启动的 `--settings` 覆盖和环境变量传入，不修改 `~/.claude/settings.json` 或 Mirasim 的配置文件。
- 继续加载现有的技能、MCP、Hooks 和权限设置。
- 角色映射（`opus`、`sonnet`、`haiku`、`fable`）：与主模型同系列时沿用主模型，否则按去除 `[1m]` 后的 ID 做数字感知排序，取该系列排序最高的模型；同一版本有两个变体时优先选择目录中的 `[1m]` 变体。别名需要从该系列自动选择模型时也使用此规则。目录缺少某个系列时回退到主模型，并打印提示。`ANTHROPIC_SMALL_FAST_MODEL` 使用 `haiku` 角色的结果。
- 配置读取失败或模型目录无效时会报错。Mirasim 内部入口或接口格式变化时，可能需要更新启动器。

## 验证

```bash
npm test
mclaude --dry-run
```

测试覆盖 Desktop 连接与一次性后台查询、失败时不泄露后台输出、缓存复用与失效、缓存损坏与不可写、手动刷新与刷新失败后的保留、版本自动跟随、模型映射、角色回退和参数传递。
