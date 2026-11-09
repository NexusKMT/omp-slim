# 首次构建与裁剪记录 · 2026-11-10

私有仓库：<https://github.com/NexusKMT/omp-slim>。GitHub 账号为 NexusKMT。
本地工作目录为 `~/Projects/omp-slim`，原始上游克隆单独保留在
`~/Projects/oh-my-pi`。上游发布 Actions 在本仓库中已禁用。

## 源码和范围

- 上游基线：`v18.18.3`，`21f1188cf88b2f534c092181968cd5a4d1a9c296`。
- 未裁剪构建：`526e4c2c719c6bdc700e0dcf24171fb0eab76452`；相对上游只有项目说明和构建环境改动。
- 第一批裁剪：`88a81dd819943f04949e3cc140a9e8ea533e7ccf`。
- 删除 Sharpshooter 的决策提取、定时合并、存储实现、设置入口、提示词和专用测试，并移除会话启动/退出关联代码。
- 旧配置的 Sharpshooter 选择迁移为 `off`，去掉失效设置，保留磁盘上已有的决策文件。
- 该提交涉及 32 个文件，新增 91 行、删除 2,065 行，净减少 1,974 行。
- 其他记忆后端、自动学习、语音、桌面和浏览器尚未删除。会话存储、恢复和上下文压缩继续保留。

## 环境和实际构建路径

GitHub Codespace 为 `standardLinux32gb`：4 个 CPU、16 GB 内存、32 GB 工作区。
使用 Ubuntu 24.04 基础开发镜像和官方 `sshd` feature，用户为 `vscode`。
本次基础镜像摘要为 `sha256:d94c97dd9cacf183d0a6fd12a8e87b526e9e928307674ae9c94139139c0c6eae`，
记录自实际创建日志；devcontainer 中的镜像标签和 apt 包仍会随上游更新。
Bun 为 `1.4.4`，Rust 为仓库锁定的 `nightly-2026-11-08`
（`rustc 1.102.0-nightly (f5cedb83a 2026-11-07)`）。

本次实测 `/tmp` 有约 108 GB 可用空间，Rust 中间文件放在
`/tmp/omp-slim-cargo-1000`，并行构建任务数为 2，使用 `ci` profile。
日志与产物存放在工作区 `dist/`，已经回收到本地。临时盘空间与持久性必须每次核实。

构建链从项目文档及实现确认：

1. `bash scripts/slim/bootstrap.sh`：安装系统工具、Bun、完整的锁定 Rust 工具链，运行 `bun install --frozen-lockfile`。
2. `bun run build:native`：经 `scripts/bazel-natives.ts host` 调用 Cargo/N-API，构建并加载探测原生扩展，生成绑定。
3. `bun --cwd=packages/coding-agent run build`：生成内嵌资源并用 Bun 编译 CLI。
4. 对实际生成的二进制运行 `--version`、`--help`、`--smoke-test`，打包并生成 SHA-256。

以上步骤已封装在 `scripts/slim/build.sh`。跨平台原生扩展使用 Bazel 的独立目标，不能把 Linux 构建当作 macOS 交付。
本次构建使用主机的 `linux-x64-modern` 原生扩展，需要 AVX2。

参考：`packages/coding-agent/DEVELOPMENT.md`、`docs/natives-build-release-debugging.md`、
`packages/natives/scripts/build-bindings.ts` 和 `packages/coding-agent/scripts/build-binary.ts`。

## 实测结果

| 项目 | 未裁剪基线 | 删除 Sharpshooter 后 |
| --- | ---: | ---: |
| Cargo 报告的原生编译耗时 | 24 分 35 秒 | 9 分 00 秒 |
| 完整原生构建步骤耗时 | 24 分 42 秒 | 9 分 04 秒 |
| CLI 编译步骤耗时 | 59 秒 | 58 秒 |
| 可执行文件大小 | 255,412,400 字节 | 255,269,040 字节 |
| gzip 产物大小 | 133,469,150 字节 | 133,398,488 字节 |
| 版本、帮助、worker smoke | 全部通过 | 全部通过 |
| `bun check` | 通过 | 通过 |

两次构建前后 Git 工作区均干净。第一次是原生冷构建，第二次复用了依赖缓存，
但 N-API 构建入口仍触发 `pi-natives` 重编译，因此两列耗时不能作为裁剪提速比例。
这是单次环境下的测量。CLI 约一分钟，原生扩展是当前构建耗时的主要部分。

仅删除这个 TypeScript 记忆后端，二进制减少 140 KiB，约 0.056%。
后续减少体积和原生构建成本，需要继续处理语音、桌面及其 Rust 依赖；
本次没有改变原生依赖图。

裁剪后的 6 个相关测试文件共 **238 通过、0 失败、910 次断言**。范围包括旧配置迁移、
旧记忆文件保留、主代理和顾问提示词不再注入旧决策、其他记忆后端的生命周期、
会话签名持久化、恢复和压缩上下文。完整命令见根目录 `SLIM.md`。

本次没有 Rust 源码改动，完成的 `bun check` 按上游规则跳过 Rust lint。
没有运行整个仓库测试套件，也没有验证真实模型服务认证。原生扩展的实际编译和加载、
编译后 worker 的启动已经验证。后续修改 Rust 时应强制运行 Rust 检查与项目的 nextest 测试入口，
避免已同步的 `origin/main` 让改动检测跳过它们。

## 产物和校验

本地基线目录：`dist/builds/baseline-20261109T180711Z/`。
本地裁剪版目录：`dist/builds/sharpshooter-removed-20261109T184424Z/`。
目录时间戳使用 UTC，实际工作日期按上海时区为 2026-11-10。

两个目录都包含 `omp`、`omp-linux-x64.tar.gz`、校验文件、源码提交、
构建前后工作区状态、工具链版本、耗时、帮助输出、构建日志及退出状态。
压缩包与解压后可执行文件均已在本地通过 SHA-256 校验。

```text
基线 omp:
397b964c3765f83438b89ac329880c3fe60840d11c9d5ef3d514772c6b4fcf20

裁剪版 omp:
2a44485f48b85a24d431c818560e471b7684a8e13a1522e8adc4a1085f3ebaba

dist/validation/final-build-evidence.tar.gz:
c5f136f6809bcf9b28eca5cd7317f5bbbad203f27130ffd6d5d3a73106c8e8c1
```

详细检查日志位于 `dist/validation/baseline/` 和 `dist/validation/sharpshooter/`。
产物与原始日志按仓库规则留在忽略的 `dist/`，不放进 Git 历史。

## 从历史会话和本次运行得到的操作规则

已阅读本地 Codex 的 Codespaces 构建会话及退役 app-ops 的生命周期代码，
采用账号/仓库核对、实例清单核实、固定源码版本、日志与产物回收、校验和确认停机。
没有复制原始会话或凭据到仓库，也没有重新启动退役服务。

本次解决的环境问题已经落到 devcontainer 和 bootstrap：

- 通用 `universal:2` 镜像的 Yarn 源签名失败：改用 Ubuntu 24.04 基础镜像。
- 基础镜像缺 SSH server：显式加入官方 `sshd` feature。
- Rust 自动补装组件发生并发冲突：初始化先运行一次 `rustc --version`。
- SSH 中 Git HTTPS 认证不可用：通过 Git bundle 同步源码并核对提交。
- 本机 `gh codespace cp` 的远端路径引号问题：对受控路径使用 `--expand`。
- `Available` 不代表初始化成功：检查 creation log；刚启动时还要核实 Git 历史补全状态。

失败的首个实例已删除。成功实例 `omp-slim-build-vrxqgpxrj7gfp579` 在产物回收后停止，
API 已确认状态为 **Shutdown**，停止后的保留期为 72 小时。再次使用前重新查询实时状态。

## 接下来的裁剪边界

继续删除 local、Hindsight、Mnemopi 和自动学习；然后拆除语音、桌面与浏览器。
每步同步清理工具注册、命令/UI、设置、worker、依赖及构建清单，并保留可运行的验证结果。
浏览器清理要覆盖 PDF 截图、HTTP 搜索中的浏览器回退、Cookie 捕获登录与 eval 预置能力。
保留 PDF 文本解析、普通 HTTP 搜索、标准 OAuth/API key 认证以及手工维护的指令。
