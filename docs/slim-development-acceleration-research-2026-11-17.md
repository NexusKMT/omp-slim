# OMP Slim：开发反馈加速调研（2026-11-17）

目标是缩短“改动源码 → 得到有用反馈 → 运行新行为”的时间。研究结合当前实现、已有 macOS 构建记录、官方文档、维护者博客和开源项目的实际改动。

**优先验证现有 `dev` 配置与持久工作区；随后解决跨 runner 的缓存失效；最后按测量结果决定拆 crate、拆 addon 或更换链接器。** 目前没有证据证明完整 native 插件能在数秒内重编译。上一轮测得的 2 分 46 秒来自关闭 rustc 增量编译的 `ci` 配置。

## 1. 当前实现与测量说明了什么

| 当前路径 | 实际设置或行为 | 对开发反馈的影响 |
| --- | --- | --- |
| TypeScript 源码运行 | `bun run dev`，复用已验证 addon | 已验证临时源码修改能在下一次启动显示，0.28 秒；无需编译 native |
| 默认 native 构建 | `build-bindings.ts` 默认 `local`：O3、ThinLTO、incremental=true | 开启增量，但仍承担较重的优化成本 |
| 远程完整构建 | `scripts/slim/build.sh` 强制 `ci`：O3、LTO off、incremental=false | 适合验证分发产物；此前插件重编译数据不能代表 dev 增量体验 |
| 已有 `dev` 配置 | 自有代码 O0、incremental=true；`pi-shell` 单独 O1；外部依赖 O2 | 已经具备候选开发配置，首先测试它，不必先增加更多 profile |
| GitHub Actions | 恢复 target 后在新 checkout 构建 | 恢复缓存、Cargo 判定产物可复用、rustc 复用增量状态是三件不同的事 |

本次只生成了 Cargo unit graph，没有执行完整 native 构建。解析结果确认：`pi-natives`、`pi-builtins` 在 `dev` 下为 O0/incremental=true，`pi-shell` 为 O1/incremental=true；三者在之前的 `ci` graph 中均为 O3/incremental=false。

已有 O3/no-LTO 报告中，`pi-builtins` 为 621.35 秒，其中 codegen 段约 548.05 秒；`pi-shell` 为 532.32 秒，其中前端段约 274.59 秒。前者值得先降低开发时的优化成本；后者还需要关注类型检查、宏展开和模块边界。各 crate 的时间会重叠，不能相加当成总构建耗时。`pi-natives` 的 164.58 秒没有前端、LLVM 与系统链接器的细分，不能全部称为链接时间。[Cargo timings 官方说明](https://doc.rust-lang.org/cargo/reference/timings.html)

本地证据：

- `Cargo.toml` 的 `profile.dev` / `profile.local` / `profile.ci`。
- `packages/natives/scripts/build-bindings.ts` 的 profile 选择，以及 `scripts/slim/build.sh` 的强制覆盖。
- `dist/validation/build-perf-2026-11-17/*timing-summary.json`、`default-ci-unit-graph.json`。
- `dist/validation/dev-acceleration-research-2026-11-17/dev-unit-graph.json`。

## 2. 推荐顺序

| 优先级 | 方法 | 本项目适配性 | 需要验证的边界 |
| --- | --- | --- | --- |
| 1 | 用现有 `dev` 构建 native，保持编译状态 | 高；已有实现支持选 profile | 完整 addon 加载、panic 恢复、shell 栈限制、运行速度 |
| 1 | 保留 checkout、target、工具链、SDK、flags | 高；直接针对连续编辑 | 需要可保留磁盘状态的远程开发环境；Linux 产物不能用于本地 macOS |
| 1 | 受影响 crate 的检查/测试，随后才构建 addon | 已在 `pi-pty` 验证 | 单元测试通过不等于新 native 行为已进入 CLI |
| 2 | workspace 缓存 + checksum freshness | 有官方支持和 uv 实践；小型机制验证通过 | `build.rs` 输入仍用 mtime，完整项目收益尚未测量 |
| 2 | 对前端重的 crate 比较 1 / 2 / 4 个前端线程 | 固定工具链支持；`pi-shell` 有较长前端阶段 | 与 Cargo 并发、内存一起测量，不能保证线程越多越快 |
| 2 | 拆分大 crate，缩小改动影响范围 | `pi-pty` 已验证有效；大 crate 需设计 | 避免形成更长的串行依赖链，保留真实实现和功能 |
| 3 | 对最终 crate 做 self-profile，再优化链接或泛型 | 有明确诊断工具 | 当前没有足够数据认定链接是剩余主因 |
| 3 | 独立 addon / 开发期动态库 | Bevy、cargo-add-dynamic 有先例 | 需要处理加载、共享类型、生命周期、ABI 与打包；工程成本高 |
| 暂缓 | sccache、Cranelift、Wild 直接替换现有方案 | 各有适用场景，但不能直接解决当前 macOS native 路径 | 详见后文限制 |

## 3. 首选：真正使用开发配置，并保留编译状态

Cargo 官方文档区分了优化级别、增量编译和 package override。增量数据保存在 target；注册表依赖本身不使用 rustc 增量编译，自有代码与 path dependency 才是重点。把不会频繁改变的依赖保持适当优化、让频繁修改的代码低优化，是可行的开发配置。[Cargo profiles](https://doc.rust-lang.org/cargo/reference/profiles.html)

Zed 是可参考的实际大型项目：其 `dev` 开启 incremental，分别配置 proc-macro 和少数运行热点；同时对齐 build dependency 的配置，注释明确指出不对齐会导致大量重复编译。它还针对小 crate 单独调整 codegen units，说明该参数不应一概追求越大越好。[Zed Cargo.toml，核对时提交 482e7652](https://github.com/zed-industries/zed/blob/482e76524bd33d8cbdfc352f1fef3eefbf2fad92/Cargo.toml)

本项目的第一项候选实验是在远程构建环境执行：

```sh
# 在准备好的远程 checkout 中执行；此处是候选方案，未执行完整构建。
# CARGO_TARGET_DIR 应指向该开发环境长期保留的目录。
OMP_NATIVE_CARGO_PROFILE=dev bun run build:native
```

先使用现有 `dev`，保留 `pi-shell` 的 O1 例外。该例外是为了避免未优化递归栈帧触发测试线程栈溢出，不能为了编译快一律改 O0。保留 `panic=unwind` 与 `split-debuginfo=unpacked`，后者用于 macOS 文件/行号回溯。若之后测试 `lto="off"`、不同 codegen units 或外部依赖 O1，应一次只改一个变量，避免把配置迁移的首次成本混入连续编辑数据。

固定 Rust toolchain、目标 triple、SDK、features、RUSTFLAGS 和 target 路径。完整 addon 与其相关测试还应对齐显式 target，避免分别使用 `target/debug` 和 `target/<triple>/debug`。首次采用 `dev` 会建立一套不同于 O3 的依赖产物，不能承诺首次构建同样快。

持久远程 checkout 可以避免每次清空源码时间戳、恢复大体积 target 和重新安装工具链。Linux 开发环境可承担跨平台 Rust 逻辑测试与 Linux CLI 验证；在本地 Intel Mac 观察新 native 行为，仍需要 macOS 构建产物。现有规则要求完整 native 构建远程执行，本次没有启动本地完整构建或创建新的远程机器。

## 4. 免费托管 Actions 路径：内容校验值得试，但有真实边界

Cargo nightly 的 checksum freshness 用输入内容决定是否需要重编译，适合源码时间戳不稳定的 CI。当前文档明确指出，`build.rs` 的 `rerun-if-changed` 输入仍按时间戳处理。[Cargo unstable：checksum-freshness](https://doc.rust-lang.org/nightly/cargo/reference/unstable.html#checksum-freshness)

在我们固定的 `nightly-2026-11-08` 上，以下组合已用于独立小例子：

```sh
CARGO_BUILD_FINGERPRINT=content cargo build -Zchecksum-freshness
```

相应候选配置为：

```toml
[unstable]
checksum-freshness = true

[build]
fingerprint = "content"
```

本次创建了无第三方依赖的双 crate 程序，比较默认 mtime 与内容模式。执行程序输出值用于确认真正的代码修改被编译，而不只看 Cargo 的退出码。

| 情景 | 默认 mtime | 内容校验 |
| --- | --- | --- |
| 不改文件再次构建 | 两个 crate 均 Fresh | 两个 crate 均 Fresh |
| 原样重写源码和 manifests，模拟新 checkout 时间戳 | 两个 crate 均重编译 | 两个 crate 均 Fresh |
| 修改依赖源码，且在内容模式故意保留旧 mtime 和文件长度 | 正常修改后输出更新 | 正确检测到内容变化，两个 crate 重编译，输出 41 → 42 |
| 加入读取输入文件并生成代码的 `build.rs`，原样重写全部输入 | 重编译 | 脚本可执行文件 Fresh，但依赖库和应用仍重编译 |
| 同上，但生成文件只在内容变化时写入 | 重编译 | 依赖库和应用仍重编译 |

无 build script 的“原样重写”样例为 0.871 秒与 0.092 秒。这只证明机制，不能外推为 OMP 提速倍数。三组实验共 24 次构建；日志、脚本和结果保存在 `dist/validation/dev-acceleration-research-2026-11-17/`。

该限制确实与本项目有关：`pi-shell/build.rs` 监视 minimizer 定义目录并生成 `builtin_filters.toml`；`pi-natives/build.rs` 监视语法资源，还构建 OAuth callback helper。仅增加 checksum 开关，或只把生成文件改成 write-if-changed，都不足以保证 fresh checkout 下这些 crate 不重编译。应记录 Cargo dirty 原因，必要时拆出独立的生成步骤或生成资产 crate。只有“输入内容确认相同”的时间戳恢复才可研究，不能简单将所有源文件日期改旧来追求命中。

uv 有已合并的相近实践，而非只有建议：

- [PR #20448，Linux workspace 缓存](https://github.com/astral-sh/uv/pull/20448)：2026-07-15 合并。保留 workspace 产物并加入 checksum freshness，5 组样本的恢复后编译从 68.7 秒到 54.6 秒；缓存变大，恢复也有额外成本。
- [PR #20451，macOS tests](https://github.com/astral-sh/uv/pull/20451)：同日合并；5 组样本的恢复后编译从 159.0 秒到 84.4 秒。但同时采用 nightly 与 aborting tests，不能把全部收益归因于缓存。
- [PR #20458，development builds](https://github.com/astral-sh/uv/pull/20458)：2026-07-16 合并。macOS x86_64 的暖编译均值 97.6 → 77.8 秒，置信区间跨过无改善；作者明确认为该平台结论尚不确定。不能据此承诺我们 Intel Mac 同样提速。

我们的缓存已经包含整个 target；重点是让其中 workspace 产物保持可用，而不是机械换一个 cache action。`Swatinem/rust-cache` 默认不保留 workspace crates，并默认关闭 incremental，虽然现在提供 `cache-workspace-crates` 选项。直接套默认配置可能背离开发反馈目标。[rust-cache README](https://github.com/Swatinem/rust-cache)

GitHub cache 内容不可原地更新。因此缓存方案应使用兼容性前缀（工具链、平台/SDK、profile、features、关键 flags）与可更新的快照 key；不能只固定一个 Cargo.lock key 后期望它自动吸收最新 workspace 产物。依赖下载缓存与编译缓存也可以分别管理。是否值得保留更大的 target，必须比较恢复、保存、编译、下载 addon 的总耗时。[GitHub dependency caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)

## 5. 结构优化：减少一次修改会触发的工作

rust-analyzer 维护者 matklad 的经验是把依赖图做宽：公共类型处于底层，功能模块相互独立，顶层只组合它们。仅把一个 crate 切成串行链条，不一定改善编译。[Fast Rust Builds](https://matklad.github.io/2021/09/04/fast-rust-builds.html)

`pi-pty` 已证明这一方法在本项目可行：共享同一份实际实现，同时避免测试牵引整个 native 图。后续候选是把 `pi-shell` 的解析/最小化等纯逻辑、`pi-builtins` 的独立命令组、native 中可独立验证的算法提取为边界清晰的 crate。共享 host 类型或协议应放在共同底层，避免让每个小 crate 再依赖完整 shell。

拆成 rlib 可以缩小编译和测试范围，但最后的单一 `.node` 仍需要链接。若开发配置下最终链接仍占主要时间，再研究独立 addon 或开发期动态库：

- Bevy 的 `dynamic_linking` 让稳定引擎依赖在开发期以动态库复用；其文档同时要求发布时考虑取消该设置和附加动态库的分发问题。[Bevy fast compiles](https://github.com/bevyengine/bevy-website/blob/main/content/learn/book/development-practices/fast-compiles.md)
- `cargo-add-dynamic` 作者的 Polars 实例中，一次编辑后的编译约 2.896 → 0.485 秒；其计时进一步显示节省主要来自链接。文章也解释了多个动态库共享依赖时的 diamond dependency 限制。[作者的实际实验](https://robert.kra.hn/posts/2022-09-09-speeding-up-incremental-rust-compilation-with-dylibs/)

OMP 的单个 `.node` 虽然已经是 cdylib，其 Rust 依赖仍通常静态并入该产物，不能据文件后缀认为已获得上述收益。较稳妥的架构候选是按可独立加载的能力拆 N-API addon，并保持 TypeScript API 门面；Rust dylib 包装则必须验证 toolchain/ABI、共享类型、错误恢复和加载路径。两者都属于较大工程，优先级低于现有 dev 配置与缓存问题。

## 6. 编译器与链接器：测量后选择

对最终 crate 使用 rustc self-profile / measureme，区分宏展开、类型检查、单态化、LLVM、系统链接。Cargo timings 用于依赖关键路径；`cargo llvm-lines` 可用于找重复生成大量 IR 的泛型。Rust Performance Book 提供了把大型泛型函数的非泛型主体移出的实例，适合在发现真实热点后采用。[rustc profiling](https://rustc-dev-guide.rust-lang.org/profiling.html)、[Rust Performance Book](https://nnethercote.github.io/perf-book/compile-times.html)

还有一个值得独立比较的编译器选项：**前端并行**。固定 rustc 提交的 `parse_jobs_all` 默认选择单线程；可使用 `--jobs-frontend=2`（配合 `-Zunstable-options`），兼容的 `-Zthreads=2` 也能启用。已用本机固定工具链的 `--print cfg` 验证两种参数被接受，尚未测量 OMP 加速幅度。对于约 275 秒前端阶段的 `pi-shell`，在远程 4 vCPU 环境比较 1 / 2 / 4 个前端线程比盲目提高全局 `-j` 更有针对性；需要同时观察峰值内存和整个依赖图的总时间。该机制不能消除所有前端串行工作，也不应把最新 nightly 的默认值套到固定版本上。[固定版本 rustc 并发参数实现](https://github.com/rust-lang/rust/blob/f5cedb83a788ea9581097abc36a2a8503a7f541c/compiler/rustc_session/src/config.rs#L1790)

| 方法 | 研究结论 |
| --- | --- |
| macOS 的 LLD-MachO | 是有效候选；LLVM 官方支持，但不能把对旧 ld64 的宣传倍数套在 Xcode 16.4 上。只有确认链接占比高后，才与当前 Apple linker 比较。 |
| sccache | 可研究远程重复依赖编译；官方明确不缓存调用系统链接器的 cdylib/bin/proc-macro，也不缓存 incremental 编译。本项目最关心的最终 addon 和频繁修改的自有 crate 不能因此直接加速。 |
| Cranelift | 固定工具链对应 README 支持 macOS x64，但 panic unwinding 在 macOS 不支持，默认 abort。OMP 的 shell 和 native task 依赖 catch_unwind，故不能直接作为 macOS addon 的替代后端。 |
| Wild | 当前 README 将 Mach-O 和真正的 incremental linking 列为未来工作；不能解决当前 macOS 链接。Linux 可另行评估。 |
| zld | 旧博客仍推荐，但仓库已经归档，不作为新投入方向。 |
| 更大并发、更多 codegen units | 当前瓶颈包含单 crate 的前端工作和依赖关键路径，不是增加 `-j` 就能消除；先用 CPU/内存和 timings 判断。 |

来源：[LLD-MachO](https://lld.llvm.org/MachO/index.html)、[sccache Rust 支持](https://github.com/mozilla/sccache/blob/main/docs/Rust.md)、[固定 rustc 提交的 Cranelift README](https://github.com/rust-lang/rust/blob/f5cedb83a788ea9581097abc36a2a8503a7f541c/compiler/rustc_codegen_cranelift/Readme.md)、[Wild](https://github.com/wild-linker/wild)、[zld](https://github.com/michaeleisel/zld)。

## 7. 下一轮实验应怎样做

1. **选一个远程环境、一个固定 checkout 和 target。** 首先比较现有 `local` 与现有 `dev`；把每种配置的首次预热成本单独记录。免费托管 Actions 的同一 job 可以先验证连续编辑收益，但不能据此宣称跨 job 同样快。
2. **每个配置分别测量三类改动。** `pi-natives` 一个函数体、`pi-shell` 一个真实逻辑改动、共享 crate 的接口改动。记录检查反馈、addon 构建、安装及 source smoke 的分段与总时间；每类至少重复三次，不只 touch 文件。
3. **记录真正的重编译集合。** 同时保存 Cargo timings、JSON Fresh 状态、必要的 fingerprint dirty 日志。最终 crate 另取一次 self-profile，避免先入为主认定链接慢。
4. **再验证新的 checkout。** 复用上一轮产物，比较 mtime / content freshness；专门检查 `pi-shell`、语法资源和 OAuth helper 的 build-script 行为。更改生成输入时必须能更新最终行为。
5. **通过完整 addon 验证后才固定默认。** 验证加载、保留 API、PTY 回压/取消、worker smoke、shell panic 恢复。运行变慢或栈限制退化不能被编译加速抵消。

建议的验收目标是：普通 TypeScript 修改维持秒级反馈；独立 Rust 逻辑继续以定向测试提供秒级反馈；native 函数体修改首先争取明显低于当前 2 分 46 秒，再讨论是否有条件达到几十秒。这是实验目标，尚不是测得的结果。

本次没有更改构建配置、启动完整 native 构建或创建远程资源。报告之外只保存了来源快照、只读 unit graph，以及隔离的微型验证程序。资料快照与来源索引在 `dist/validation/dev-acceleration-research-2026-11-17/`。
