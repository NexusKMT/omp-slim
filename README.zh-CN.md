# OMP Slim

[English](README.md) · [构建与验证流程](SLIM.md)

OMP Slim 是基于 [OMP](https://github.com/can1357/oh-my-pi) v18.18.3 的独立裁剪项目，
面向 **macOS Intel 和 Linux x64**。模型调用统一使用显式配置的 Chat Completions 端点，
规划、子任务和辅助请求均使用当前主模型。

保留会话历史与恢复、文件编辑和搜索、Shell 与 PTY、LSP 与调试工具、子任务、上下文压缩、
HTTP 搜索、MCP、手动管理的技能、本地统计面板和 RPC SDK。

已移除内置浏览器自动化、桌面控制、语音、自动长期记忆、提供商订阅与其他传输协议、
自动换模、共享与录屏、SSH 主机管理、Apple Foundation Models 和上游自更新。
仅用于基准实验的 metaharness 与 Snapcompact research 目录也已移除；保留 Snapcompact 运行时。

## 安装与更新

源码与产物均来自 **[NexusKMT/omp-slim](https://github.com/NexusKMT/omp-slim)**。
上游 npm 包、安装脚本、Homebrew tap 和 mise 包分发的是原版 OMP，不是本项目。

Intel Mac 预编译产物可从成功的[下游构建工作流](https://github.com/NexusKMT/omp-slim/actions/workflows/slim-macos-intel.yml)下载。
先核对源码提交与验证日志，校验 `ARCHIVE-SHA256SUMS`，解压后执行
`shasum -a 256 -c SHA256SUMS`，再运行产物中的 `omp --version`。
确认后将二进制安装到 PATH。构建使用 ad-hoc 签名，具体产物记录与操作步骤见 [SLIM.md](SLIM.md)。

在支持的平台上准备 Bun 与仓库固定的 Rust 工具链后，可从源码构建：

```sh
git clone https://github.com/NexusKMT/omp-slim.git
cd omp-slim
bun install --frozen-lockfile
bash scripts/slim/build.sh slim
```

构建包、校验文件、源码信息和日志位于 `dist/builds/`。本项目开发时的完整原生编译与
独立 CLI 构建使用 [SLIM.md](SLIM.md) 中的远程工作流。

更新方式是安装已验证的新下游产物，或重新构建选定提交。`omp update`、后台自更新 worker
和启动版本检查已移除。插件市场的更新功能独立保留。

## 配置模型

在 `~/.omp/agent/models.yml` 中声明端点和模型 ID，参见[模型配置](docs/models.md)。
随后选择主模型：

```sh
omp --model my-endpoint/my-model
```

交互模式中可通过 `/model` 手动切换。仅接受 `openai-completions` 协议，其他协议名称会报错。
模型继承与重试行为见[单主模型说明](docs/slim-single-model.md)。

## 开发验证

```sh
bun run check:ts           # lint、格式、根目录脚本和各包类型检查
bun run test:scripts       # 构建与发布辅助脚本测试
bun run test:go            # Go RPC SDK，需要 Go
bun run test:py            # Python RPC SDK，需要 uv
```

日常按改动范围运行针对性测试。完整原生构建、Rust 测试、独立 CLI worker 冒烟测试和完整
TypeScript 测试通过公开仓库的手动 Actions 工作流执行。
[SDK 验证工作流](https://github.com/NexusKMT/omp-slim/actions/workflows/slim-sdk-checks.yml)
覆盖 Go 和 Python RPC 契约，不需要提供商凭据。

| 组件 | 位置 |
| --- | --- |
| CLI、会话、工具与 MCP | [coding-agent](packages/coding-agent) |
| Chat Completions 传输 | [ai](packages/ai) |
| 显式模型元数据与计价 | [catalog](packages/catalog) |
| 智能体运行时 | [agent](packages/agent) |
| 终端界面 | [tui](packages/tui) |
| 原生绑定、Shell 与文件操作 | [natives](packages/natives)、[Rust crates](crates) |
| 本地统计面板 | [stats](packages/stats) |
| 上下文图像渲染 | [snapcompact](packages/snapcompact) |
| RPC 客户端 | [sdk](sdk) |

## 许可证与来源

使用 MIT 许可证，保留 [LICENSE](LICENSE) 与[第三方声明](THIRD-PARTY-NOTICES.txt)。
原版 OMP 由 Stencil Labs 开发，派生自 Mario Zechner 的 [Pi](https://github.com/badlogic/pi-mono)。
仓库保留原始署名与历史 changelog；各阶段裁剪和构建报告见 [SLIM.md](SLIM.md)。
