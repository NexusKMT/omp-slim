# Intel macOS Actions 构建记录 · 2026-11-10

仓库：<https://github.com/NexusKMT/omp-slim>，账号为 NexusKMT。
按用户要求将现有仓库从 private 改为 public，保留地址和全部提交历史。
私有运行 `42750509166` 已取消。第一次公开运行 `42752760440` 也已取消，
改用四个 Cargo 并行任务以利用 Intel runner 的四核 CPU。
这两次取消不是源码编译失败。

## 本次构建

- 源码提交：`4cf083db60ff87624b79d960fdedfd6713fea329`。
- [Actions 运行 42763829793](https://github.com/NexusKMT/omp-slim/actions/runs/42763829793)。
- 工作流：`.github/workflows/slim-macos-intel.yml`，仅手动触发。
- 状态：Actions 全部成功；正式归档已下载，SHA-256 校验和本机验证全部通过。
- 本次仍只删除了 Sharpshooter 记忆后端。其他记忆、语音、桌面和浏览器组件尚未删除。

## 平台和费用选择

截至本次核查，标准 GitHub-hosted runner 仍提供 `macos-15-intel` 和
`macos-26-intel`。`macos-latest` 是 arm64，不能用它代替本次 Intel 构建。
macOS 14 runner 已退役。参考 [GitHub runner images](https://github.com/actions/runner-images)。

根据 [GitHub runner 规格与费用说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)，
公开仓库的标准 runner 免费。Intel macOS 在公开和私有仓库上均为 4 CPU、
14 GB RAM；Linux/Windows 的标准规格则从私有仓库的 2 CPU / 8 GB 增至
公开仓库的 4 CPU / 16 GB。本次切换 public 的直接收益是避免私有 Actions
构建分钟费用，Intel Mac runner 的硬件规格没有随之提高。

工作流要求 `github.event.repository.private == false`，仓库重新变为私有时
会跳过构建。上游发布、Nix 和缓存预热工作流已移入
`.github/upstream-workflows/`；本仓库仅启用这条手动 Mac 工作流。

## 构建配置

- `macos-15-intel`，Xcode 16.4，SDK 15.5，`MACOSX_DEPLOYMENT_TARGET=15.0`。
- Bun 1.4.4，仓库锁定的 `nightly-2026-11-08` Rust 工具链。
- Cargo/N-API 构建主机原生扩展，使用 `ci` profile 和四个并行任务。
- 主机自动选择 `darwin-x64-modern` 原生扩展，Rust 使用 `x86-64-v3`
  指令集基线；这是面向当前支持 AVX2 的 Intel Mac 的产物。
- Bun 将 CLI 与原生扩展打包为独立可执行文件。
- 缓存 Bun 下载、Cargo registry/git 和编译中间文件；首次运行是冷构建。
- 缓存恢复和保存使用独立步骤，后续验证失败也保存编译缓存；缓存保存故障
  不阻断测试。失败时另外回收尚未验证的二进制和原生扩展，保留 2 天。
- 超时 120 分钟，产物和日志保留 7 天。
- 使用 ad-hoc 签名，未做 Apple notarization。
- checkout/cache/upload-artifact 均锁定到具体 action 提交。

脚本在 macOS 上检查 Mach-O 架构、签名及动态库路径，拒绝依赖 Homebrew
或 runner 用户目录的动态库。编译后执行版本、帮助、worker smoke，再运行
`bun run check:ts` 和 `SLIM.md` 中列出的六个回归测试文件。
本次没有 Rust 源码改动；原生编译不等于已经执行完整 Rust 测试套件。

Mach-O 实测中，原生扩展标记最低 macOS 15.0 / SDK 15.5；Bun 自带运行时
的 CLI 外壳标记最低 macOS 13.0 / SDK 26.5。选择 Xcode 16.4 约束的是
本项目编译的原生扩展，不会重新编译 Bun 本身。组合产物按 macOS 15+
验证，本机 15.7.5 的运行测试用于确认真实兼容性。

## 本机验证

目标机器为 Intel Core m3-8100Y、x86_64、macOS 15.7.5（24G624），支持 AVX2。
本机 Command Line Tools 的 SDK 为 15.5。

下载后依次核对归档和二进制的 SHA-256、源码提交和构建前后工作区状态，
再检查架构、签名、动态库及 Mach-O 最低系统版本。运行时使用指向临时目录的
`PI_CONFIG_DIR` 和 `PI_CODING_AGENT_DIR`，从临时工作目录启动，并将 PATH 限制到系统目录，
验证独立产物的版本、帮助、worker smoke、内置 shell 的管道、文件往返和
非零退出码。测试不需要模型服务凭据，不代表真实模型服务认证已经验证。

正式归档的本机验证已全部通过：归档与二进制 SHA-256、源码提交、构建前后
干净工作区、x86_64 架构、严格签名检查、版本 `omp/18.18.3`、帮助及
`smoke-test: ok`。内置 Bash 的管道将 `alpha/beta` 转为 `ALPHA/BETA`，
文件往返内容一致；`exit 17` 返回 17。本机验证脚本退出码为 0。

本地原始证据目录为 `dist/actions/42763829793/`，不提交到 Git。
本机结果在 `local-validation/verify.log`、`smoke.log`、`shell.log` 和
`shell-exit-code`。没有替换全局安装的 `omp`。

## CI 实测结果

最终运行的 runner 镜像版本为 `20260824.0482.1`，操作系统 macOS 15.7.9
（24G830），Xcode 16.4（16F6）。实际环境记录随产物保存；GitHub 的 runner
标签会随镜像更新，不代表操作系统镜像已经完全固定。

| 项目 | 最终成功运行 |
| --- | --- |
| 整个 job | 32 分 11 秒 |
| 恢复约 1 GB 缓存 | 2 分 43 秒 |
| Cargo 原生编译 | 22 分 27 秒 |
| 完整原生构建步骤 | 22 分 33 秒（1,353 秒） |
| CLI 打包 | 1 分 22 秒（82 秒） |
| 编译、打包和 smoke 步骤合计 | 24 分 18 秒 |
| 保存更新后的缓存 | 1 分 43 秒 |
| TypeScript / lint / formatting | 58 秒，通过；15 个 lint warning，0 个 error |
| 六个测试文件 | 238 通过、0 失败、910 次断言；Bun 报告 14.29 秒 |
| 架构 / 签名 / 外部依赖检查 | 通过 |
| 编译后二进制 worker smoke | `smoke-test: ok` |

复用第三方依赖缓存后，工作区内路径依赖及原生扩展仍触发了重编译，因此
缓存运行并非零编译。本次是单次运行测量，不把不同 runner 上的耗时差异
当作源码裁剪提速比例。两个冷构建的 Cargo 时间为 34 分 06 秒、45 分 24 秒。
本次只改构建脚本和工作流，未修改产生 lint warning 的 TypeScript 文件。

成功产物的 GitHub artifact ID 为 `13740820327`，名称为
`omp-slim-darwin-x64-4cf083db60ff87624b79d960fdedfd6713fea329`，
GitHub 上保留至 2026-11-17 06:14:52 UTC。

## 正式产物和校验

本地目录：
`dist/actions/42763829793/artifact/builds/macos-intel-20261110T054738Z/`。

| 文件 | 大小 |
| --- | ---: |
| `omp-darwin-x64.tar.gz` | 123,766,511 字节（约 118.03 MiB） |
| `extracted/omp` | 243,045,232 字节（约 231.79 MiB） |

```text
omp-darwin-x64.tar.gz:
7398f2ba3bca673b8c51c62946d30f30087f4061226e58ca47ec072baefebbed

omp:
819333572ce6a8bab278390824e23effe9e3e70979e31458405c2701912fdb2d
```

归档包含二进制、校验文件、源码提交、构建前后状态、工具链版本、构建耗时、
版本/帮助及 Mach-O 信息。Actions artifact 另外包含构建、初始化、检查和测试
日志；完整 Actions 日志及 API 运行元数据也已回收本地。

本次结束前再次确认：仓库为 PUBLIC，仅手动 Intel Mac 工作流启用，
`omp-slim-build-vrxqgpxrj7gfp579` Codespace 为 **Shutdown**。

## 首次公开构建发现的验证脚本问题

[运行 42753254196](https://github.com/NexusKMT/omp-slim/actions/runs/42753254196)
使用 `77bfe7131b2d56640750f5bfe6350b805b0f96a3`，Rust `ci` 编译成功，耗时
34 分 06 秒；完整原生构建步骤为 2,083 秒，CLI 打包为 61 秒。
失败发生在新增的 `lipo` 架构检查，原因是输入文件放在了接受多个架构参数的
`-verify_arch` 后面，被当作架构名称解析。

已改为 `lipo INPUT_FILE -verify_arch x86_64`，并用本机的系统 Bash 和 Bun
可执行文件实际验证。该次失败也暴露出组合缓存 action 只在任务成功时保存缓存，
导致编译结果没有保留下来。修复后使用独立 restore/save，并在失败时回收
未验证产物。首次失败的原始日志保留在 `dist/actions/42753254196/`。

[运行 42757859508](https://github.com/NexusKMT/omp-slim/actions/runs/42757859508)
的 Rust 冷编译为 45 分 24 秒，架构和签名检查通过，但动态库路径检查
误将 `otool -L` 中原生扩展的自身 `LC_ID_DYLIB` 标识当作外部依赖。
实际依赖均为系统库。修复后从 `otool -l` 中只提取加载依赖命令，忽略
库身份标识。本机编译了带 runner 路径标识的测试库及引用它的程序，分别
验证忽略标识、拒绝实际依赖两个情况。

该次失败后，1,085,757,331 字节的编译缓存成功保存，未验证产物也已回收。
从失败产物取出的 CLI 在本机通过版本、帮助、worker smoke、shell 管道
和文件读写检查；原始证据在 `dist/actions/42757859508/`。
该结果用于定位验证脚本误判，最终交付仍以完整工作流成功的归档为准。
