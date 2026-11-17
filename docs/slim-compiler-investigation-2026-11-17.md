# OMP Slim：编译原理与差分实验

目标：回答「修改哪里需要等待多久」「时间花在哪个编译阶段」「哪种加速真正生效」，并保存可复查的原始数据。

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

O2、O3 的冷构建和不同缓存不能直接作为单变量因果比较。旧实验中 O3 ThinLTO 与 O3 LTO off 的插件重编译约为 603s 与 166s，但旧实验是修改时间戳、关闭 incremental 的 `ci` 路径；新实验是修改真实行为的增量开发路径，两者必须分别标注。

## 第一轮：实际开发配置

远程运行 `44020319623` 比较既有 `local` / `dev`。固定 macOS Intel、Xcode 16.4、nightly-2026-11-08、Bun 1.4.4、Cargo 4 jobs、目标 triple 和 RUSTFLAGS。

每组首次编译后，再不改源码构建一次，然后依次改变同一个文本函数的 tab 宽度上限，验证新进程返回 17、18、19。每次都运行源码 worker smoke；结束后恢复为 16，并重新构建原始插件。

已定位并修复的阻碍：`@napi-rs/cli` 3.7.2 对显式 `--profile dev` 使用字面目录 `dev/`，而 Cargo 将内置 dev 产物放在 `debug/`。Rust 编译成功后，N-API 的复制步骤失败。`build-bindings.ts` 在选择 dev 时使用 N-API 的默认 debug 模式；自定义 profile 继续显式传参。无第三方依赖的小型动态库已复现失败，并验证修改后的路径可以复制、加载。修复后的 dev 补测运行 `44025049631`。

第一次失败还暴露了实验设施缺陷：只有加载成功才保存缓存，会丢失已经成功编译的目录。工作流已改为在安装或验证失败时也尽量保存构建状态，并始终上传 Cargo timing。

初步观测：local 的首次插件构建安装为 1854.519s；未改源码重建为 709.402s。真实编辑前两次端到端为 546.854s、634.900s，均只编译 pi-natives 一个 Cargo 单元。这足以排除「每次都在编译全部依赖」的解释。具体阶段和最终三次统计等待完整证据。

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

Rust wrapper 只对三个目标 crate 添加参数，避免为了诊断一个 crate 改变整张依赖图的 RUSTFLAGS。它必须保留 Cargo jobserver 文件描述符；否则 rustc 无法与 Cargo 协调代码生成并发，实验会改变资源调度。已用微型项目验证：添加 wrapper 后未改源码仍为 Fresh；真实改动输出更新；分阶段日志生成；jobserver 正常传递。

## 断点与恢复

这里的断点指「已经完成并校验的编译状态」，包括工具链、profile、flags、target、源码内容摘要和时间戳。首次生成 N-API 声明可能改变 force-build 环境变量，因此先额外稳定一次，再测第三次完全未改源码的构建。

每个前端配置独立保存 cache。恢复时间戳前比较每个被跟踪文件的 SHA-256，只恢复内容完全一致的文件；内容变化保留新时间戳。新的 wrapper 或线程设置必须先重编译目标 crate，不能借用旧配置的 Fresh 状态。该实现并不承诺目录型 build script 输入、删除文件、外部路径或所有工具状态都能跨 runner 保持 Fresh；fingerprint 日志负责揭示剩余失效。

## 根据结果选择后续实验

- 若 `run_linker` 占主导：用同一目标文件与同一输入对比 Apple linker / LLD，再验证 addon 加载和符号。
- 若 LLVM 优化占主导：逐项比较 crate 级优化、LTO、codegen units；观察运行速度的代价。
- 若类型检查、宏展开占主导：比较前端线程，检查泛型/宏体量，按真实依赖边界拆 crate。
- 若未改源码仍重编译：先解决 fingerprint / build script / N-API 环境变量漂移。
- 若改动 pi-builtins 会连带 pi-shell 与 pi-natives：按实际传播链评估拆分或动态库边界；减少源码行数本身不是目标。

本地原始证据位于 `dist/validation/development-benchmark-2026-11-17/` 与 `dist/validation/compiler-diagnostics-2026-11-17/`。本报告会随已完成的远程实验更新。
