# OMP Slim：编译原理与差分实验

目标：回答「修改哪里需要等待多久」「时间花在哪个编译阶段」「哪种加速真正生效」，并保存可复查的原始数据。

## 结果与必须先纠正的实验条件

三组矩阵已完成：[Actions 44029960333](https://github.com/NexusKMT/omp-slim/actions/runs/44029960333)，源码 `3f755707f70a842c5cc188f4b45c23e27fb89a6f`。27 次真实修改、27 次新行为验证和 worker smoke 全部通过，三个修改点全部恢复，最后的原始行为与导出检查通过。每组完整作业耗时 46–50 分钟，包含预热、9 次编辑、3 次恢复和缓存传输；这不是一次编辑需要的时间。

**这批数据实际没有启用 rustc incremental。** 原始 `unit-graph.json` 的三个目标 crate 都是 `incremental: false`；矩阵保存的实际 rustc 命令也没有 `-C incremental=...`。固定工具链 `nightly-2026-11-08` 在 `CI` 存在时默认关闭 incremental，即使 profile 写了 `incremental=true`。同一工具链的无依赖微型工程复现了三个状态：无 CI → true；CI=true → false；CI=true 加 CARGO_INCREMENTAL=1 → true。[Cargo build.incremental](https://doc.rust-lang.org/cargo/reference/config.html#buildincremental)。

因此，本文所有已完成的远程数据应解释为 **保留依赖产物的真实编辑重编译**，不能解释为已开启 rustc 查询/代码生成复用的最终开发性能。早期进度中称它们为「增量开发实测」不准确。配置文件、缓存命中与真正传给编译器的选项必须分别检查。

已修正实验设施：两个开发测量 job 显式设置 `CARGO_INCREMENTAL=1`；正式构建前生成并检查 effective unit graph，任一目标 crate 未启用 incremental 就立即终止；新结果使用 `v2-inc1` 缓存键，同时允许复用旧依赖目录。这个检查已在无依赖三 crate 工程中验证了拒绝与通过两个分支，没有进行本地完整编译。**截至本报告 11 月 17 日写作时，修正后的 OMP 完整计时尚未重跑。**

11 月 20 日审核补记：11 月 18 日的 [44300999380](https://github.com/NexusKMT/omp-slim/actions/runs/44300999380) 已成功完成启用 incremental 的一次 native 编辑：构建安装 26.125s，行为验证及 worker smoke 完成 29.530s，原始行为恢复和最终测试通过。它使用旧的 `dev lto=false`；当前已改为 `"off"`。这条数据此前未写入本报告，不能再称“修正后从未实测”，也不能从一个样本推导当前 profile 的稳定加速倍数。证据和新一轮实测见 [2026-11-20 审核](slim-build-audit-2026-11-20.md)。

实验入口现在默认 `benchmark_scope=quick`：开发 profile 默认仅 dev，单个 native 改动；编译矩阵默认仅前端 1 线程、单个 native 改动。只有显式选择 `full` 才执行三次采样和全部矩阵。首次预热仍有成本。

## 编译链与需要分别测量的时间

```mermaid
flowchart LR
    A[源码改动] --> B[Cargo 判断哪些单元失效]
    B --> C[解析与宏展开]
    C --> D[类型检查、借用检查、MIR]
    D --> E[泛型单态化与生成 LLVM IR]
    E --> F[LLVM 优化与机器码]
    F --> G[链接 Mach-O 动态库]
    G --> H[N-API 复制、版本标记、声明生成、加载]
    H --> I[新进程验证行为与 worker]
```

三个不同的缓存层不能混为一谈：

1. Actions 缓存保存和传输目录。下载成功只说明文件存在。
2. Cargo fingerprint 决定某个编译单元是否仍然有效；失效原因包括源码、配置、环境变量和 build script 输入变化。
3. rustc incremental 在确实需要编译一个 crate 时，尝试复用内部查询和代码生成结果。

因此，`incremental=true` 不保证插件重编译只需数秒；恢复了 Actions 缓存也不保证 Cargo 显示 `Fresh`。日志中的 `Compiling` 同样不是「这个 crate 完整重做了一切」的证明。[Cargo profiles](https://doc.rust-lang.org/cargo/reference/profiles.html)、[Cargo fingerprint 调试](https://doc.crates.io/contrib/implementation/debugging.html)。

Cargo `--timings` 用于找慢 crate、并发和依赖阻塞。其 `codegen` 区域不等于纯系统链接时间。多个 crate 可以重叠执行，不能把耗时相加解释总墙钟时间；最值得改善的是关键路径上阻塞后续任务的单元。[Cargo timings](https://doc.rust-lang.org/cargo/reference/timings.html)。

进一步使用固定 nightly 的 `-Ztime-passes -Ztime-passes-format=json`：记录宏展开、类型检查、MIR、单态化、LLVM 和 `run_linker`。阶段存在嵌套和并行重叠，例如 `run_linker` 包含在 `link_binary` / `link` 内，不能相加。记录的 RSS 起止值也不是精确峰值内存。该参数是 rustc 内部诊断接口，脚本绑定本项目固定工具链。[time-passes](https://doc.rust-lang.org/nightly/unstable-book/compiler-flags/time-passes.html)。

## 已有数据指出的调查对象

以下是此前 O3、LTO off 实验的单次 Cargo timing；各行存在并发，不是优化后的预计节省量。

| crate | 单元总时间 | 前端区间 | codegen 区间 | 下一步假设 |
| --- | ---: | ---: | ---: | --- |
| pi-builtins | 621.35s | 73.30s | 548.05s | 优化和代码生成重；先测降低开发优化级别与改动传播 |
| pi-shell | 532.32s | 274.59s | 257.73s | 前端同样重；测前端线程数与模块边界 |
| jj-lib | 386.72s | 124.53s | 262.19s | 外部大依赖；优先保留已编译状态 |
| pdf-inspector | 335.69s | 56.16s | 279.53s | 外部代码生成重；普通源码编辑应避免使其失效 |
| pi-natives | 165.50s | 未分开记录 | 未分开记录 | 用 rustc 阶段数据确定前端、LLVM、链接各自占比 |

O2、O3 的冷构建和不同缓存不能直接作为单变量因果比较。旧实验中 O3 ThinLTO 与 O3 LTO off 的插件重编译约为 603s 与 166s；旧实验修改时间戳，本轮修改真实行为。两者实际都关闭了 rustc incremental，配置和探针也不同，必须分别标注。

## 第一轮：实际开发配置

远程运行 `44020319623` 比较既有 `local` / `dev`。固定 macOS Intel、Xcode 16.4、nightly-2026-11-08、Bun 1.4.4、Cargo 4 jobs、目标 triple 和 RUSTFLAGS。

每组首次编译后，再不改源码构建一次，然后依次改变同一个文本函数的 tab 宽度上限，验证新进程返回 17、18、19。每次都运行源码 worker smoke；结束后恢复为 16，并重新构建原始插件。

已定位并修复的阻碍：`@napi-rs/cli` 3.7.2 对显式 `--profile dev` 使用字面目录 `dev/`，而 Cargo 将内置 dev 产物放在 `debug/`。Rust 编译成功后，N-API 的复制步骤失败。`build-bindings.ts` 在选择 dev 时使用 N-API 的默认 debug 模式；自定义 profile 继续显式传参。无第三方依赖的小型动态库已复现失败，并验证修改后的路径可以复制、加载。修复后的 dev 补测运行 `44025049631`。

第一次失败还暴露了实验设施缺陷：只有加载成功才保存缓存，会丢失已经成功编译的目录。工作流已改为在安装或验证失败时也尽量保存构建状态，并始终上传 Cargo timing。

完整数据来自 [local 运行](https://github.com/NexusKMT/omp-slim/actions/runs/44020319623) 和 [修复后 dev 运行](https://github.com/NexusKMT/omp-slim/actions/runs/44025049631)：

| 配置 | 三次编辑到验证通过 | 中位数 | 仅构建安装中位数 |
| --- | --- | ---: | ---: |
| local | 546.854 / 634.900 / 578.695s | 578.695s | 575.643s |
| dev | 49.666 / 82.761 / 60.547s | 60.547s | 56.752s |

在这两台相同规格 runner 的测试中，dev 中位数耗时约为 local 的 1/9.56，减少 89.54%。两组实际均关闭 incremental；profile 同时改变优化级别、LTO、codegen units、调试与检查选项，不能把全部收益归给一个选项。所有编辑都只编译 pi-natives 一个 Cargo 单元，排除了每次重编全部依赖的解释。未测量两种插件的完整运行性能代价。

local / dev 首次构建安装分别为 1854.519s / 2207.276s。第一次未改源码构建仍各编译两个单元，分别耗时 709.402s / 46.981s，不能用作稳定 no-op 基准。第二轮先稳定后测量的 no-op 是 1.805–3.835s、零编译单元。

两组恢复构建、原始 tab=16 行为、worker smoke、导出、6 项 PTY/shell 测试、15 项语法测试均通过；随后均在同一个 shell 会话并发测试失败，整个第一轮 workflow 仍标记失败，未上传「验证通过」的 addon。local 失败是把位于输出末尾的忙碌提示硬性要求放在开头；dev 失败是 100ms 自动后台化发生在 shell 选择之前，起始返回尚无提示。测试已改成以 owner 的真实输出确认占用，用显式释放文件维持重叠，并强制延迟另一个任务的准备，验证其完成结果披露 fork、读取原状态且不污染原会话。当前已安装的原 O3 插件上 24/24 重复测试通过，包类型检查 3220 文件通过；这项修正未在新 dev/local 产物上重跑，不把原失败改报为成功。

## 第二轮：三个改动点 × 三种前端线程数

工作流输入 `compiler_matrix=true`，脚本为 `scripts/slim/benchmark-compiler.py`。

| 固定项 | 设置 |
| --- | --- |
| Profile | 现有 dev；pi-natives / pi-builtins O0，pi-shell O1；保留 unwind |
| 外部依赖与后端并发 | 依赖配置固定，Cargo jobs=4 |
| 自变量 | 对三个目标 crate 使用前端线程 1、2、4 |
| 采样 | 每个改动点 3 次不同的真实函数体变化 |
| 行为探针 | native tab 宽度；空路径 dirname；深层算术表达式错误 |
| 记录 | Cargo 失效原因、重编译单元、rustc pass JSON、完整插件构建安装、运行验证 |
| 完成条件 | 观察到新行为、源码 worker 通过、每组源码恢复、最终 export 校验 |

三种线程设置在三个独立 runner 上并行比较。各组先形成自己的编译状态，再连续编辑。所有组使用相同的计时工具；带诊断的绝对时间与不带诊断的第一轮分开分析。一次 runner、每种改动三次只能提供探索性证据，不能替代跨机器重复实验。Cargo 的四个 job 不等于所有 rustc 前端线程总数严格不超过四个；这也是测试线程增加是否导致资源争抢的原因。

实际主机均报告 i7-8700B、4 个逻辑 CPU、14 GiB 内存、Xcode 16.4。端到端中位数如下，包含插件安装、新行为探针与源码 worker smoke：

| 修改位置 | 前端 1 线程 | 前端 2 线程 | 前端 4 线程 | 实际重编译单元 |
| --- | ---: | ---: | ---: | --- |
| pi-natives 文本函数 | 33.369s | 30.328s | 42.949s | pi-natives |
| pi-builtins dirname | 294.418s | 287.984s | 328.807s | pi-builtins → pi-shell → pi-natives |
| pi-shell 算术错误 | 212.364s | 234.473s | 199.504s | pi-shell → pi-natives |

线程数没有一致赢家。native 的 2 线程约快 9%，4 线程约慢 29%；shell 的三次样本范围分别为 211.716–298.838s、173.267–306.150s、161.339–237.252s，波动大且组间交叠。这些数据不支持把 4 线程设为通用优化，也不应把跨轮 native 从 60s 降到 30s 全归功于线程数。

Cargo 指纹日志确认：builtins 的函数体变化使它自身因 ChangedFile 失效，shell 和 native 因 StaleDepFingerprint 失效。第一线程组的一个样本中，builtins 从 0.75s 编译到 51.33s，shell 从 28.86s 到 242.89s，native 从 243.06s 到 289.38s。前两者有流水线重叠，真正拖住最后插件的是 shell；不能将三个 crate 时间简单相加。

## 谁最难编译：阶段证据

下表取前端 1 线程组的三次样本中位数。各阶段嵌套或并行，**不能横向相加**；每一列的中位数也可能来自不同样本。

| 工作负载中的 crate | rustc 总耗时 | 类型检查 | MIR checking | codegen_crate | LLVM_thinlto | run_linker | rustc 峰值 RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native 编辑 → pi-natives | 29.012s | 3.679s | 3.836s | 16.710s | 无 | 1.941s | 1353 MiB |
| builtins 编辑 → pi-builtins | 71.833s | 11.116s | 11.014s | 31.891s | 无 | 不适用，生成 rlib | 1822 MiB |
| builtins 编辑 → pi-shell | 213.704s | 32.212s | 27.217s | 47.911s | 102.421s | 不适用，生成 rlib | 2829 MiB |
| shell 编辑 → pi-shell | 177.300s | 16.957s | 21.710s | 43.685s | 71.531s | 不适用，生成 rlib | 2835 MiB |

当前的重负担是 pi-shell 的后端优化，builtins 的改动还会触发这部分。pi-shell 的 O1 是为避免未优化递归栈过大而保留的例外，不能直接降为 O0。dev 的 `lto=false` 允许 crate 内部跨 codegen unit 的 ThinLTO；`lto="off"` 才完全关闭。固定工具链的 O1 微型工程在 incremental=false/true 两种情况下都实际执行了 LLVM_thinlto，因此启用增量并不等于自动消除这个阶段。[Cargo lto](https://doc.rust-lang.org/cargo/reference/profiles.html#lto)。

pi-natives 的最终系统链接器通常只有 2–4s。以 1 线程 native 样本为例，即使把 1.941s 系统链接耗时全部消掉，也只能减少约 6% 的 33.369s 端到端中位数；换链接器不是当前高收益方向。降低或避免重复 LLVM 工作才值得先验证。

CPU user+system 与墙钟之比显示 rustc 确实使用多个核心，例如 shell 编辑的 1 线程前端组约 489.5 CPU 秒 / 177.3 墙钟秒。这里「前端 1 线程」不表示后端也只能用一个 CPU。RSS 来自 wrapper 子进程 resource 统计，各 crate 峰值发生时间不同，不能相加当成整台机器峰值。

Rust wrapper 只对三个目标 crate 添加参数，避免为了诊断一个 crate 改变整张依赖图的 RUSTFLAGS。它必须保留 Cargo jobserver 文件描述符；否则 rustc 无法与 Cargo 协调代码生成并发，实验会改变资源调度。已用微型项目验证：添加 wrapper 后未改源码仍为 Fresh；真实改动输出更新；分阶段日志生成；jobserver 正常传递。

## 断点与恢复

这里的断点指「已经完成并校验的编译状态」，包括工具链、profile、flags、target、源码内容摘要和时间戳。首次生成 N-API 声明可能改变 force-build 环境变量，因此先额外稳定一次，再测第三次完全未改源码的构建。

每个前端配置独立保存 cache。恢复时间戳前比较每个被跟踪文件的 SHA-256，只恢复内容完全一致的文件；内容变化保留新时间戳。新的 wrapper 或线程设置必须先重编译目标 crate，不能借用旧配置的 Fresh 状态。该实现并不承诺目录型 build script 输入、删除文件、外部路径或所有工具状态都能跨 runner 保持 Fresh；fingerprint 日志负责揭示剩余失效。

## 下一步只做最小差分

1. 显式开启 incremental 后，只做一个 native 编辑的 smoke，先验证实际 rustc 命令和行为，再决定是否值得扩大采样。其完整项目加速量尚未知。
2. 在相同保留状态下只改一个变量：针对 shell 比较现有 local ThinLTO 与关闭 LTO，保留 O1 与 unwind；继续验证深层递归及错误后会话可用，并测运行性能。不要同时更换线程数、优化等级和 linker。
3. 若 shell 仍主导，再分析重泛型、宏展开与 crate 边界。单个 builtins 行为检查可先使用包级 test/check；完整 addon 是后续集成门槛。

本轮没有再启动长编译，没有修改 dev 的 LTO 设置，也没有宣称一个未经测量的秒数。开发时 TypeScript 继续复用已验证 addon，使用 `bun run dev`；在允许完整编译的远程保留环境，Rust 开发命令可显式使用 `CARGO_INCREMENTAL=1 OMP_NATIVE_CARGO_PROFILE=dev bun run build:native`。profile 改变后的首次构建仍需建立状态；本机完整编译限制不变。

已提交的 [测量数据](slim-compiler-measurements-2026-11-17.json) 保存全部 27 个样本、分阶段中位数和 profile 对比。本地原始证据位于 `dist/validation/development-benchmark-2026-11-17/` 与 `dist/validation/compiler-diagnostics-2026-11-17/`。后者的 `matrix-analysis.json` 保存三组聚合，`remote-matrix/` 保存全部 Cargo HTML、实际 rustc 参数和 pass JSON，`ci-incremental-probe.json` / `effective-profile-guard.json` / `tiny-thinlto-incremental.json` 保存机制复现。线上证据 artifact 保留 7 天，本地副本已回收。
