import * as fs from "node:fs";
import * as path from "node:path";
import type { EditorTheme, MarkdownTheme, SelectListTheme, SymbolTheme } from "@oh-my-pi/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";
import { getCustomThemesDir } from "../../../config";
import { logger } from "../../../core/logger";
// Embed theme JSON files at build time
import darkThemeJson from "./dark.json" with { type: "json" };
import { defaultThemes } from "./defaults";
import lightThemeJson from "./light.json" with { type: "json" };

// ============================================================================
// Symbol Presets
// ============================================================================

export type SymbolPreset = "unicode" | "nerd" | "ascii";

/**
 * All available symbol keys organized by category.
 */
export type SymbolKey =
	// Status Indicators
	| "status.success"
	| "status.error"
	| "status.warning"
	| "status.info"
	| "status.pending"
	| "status.disabled"
	| "status.enabled"
	| "status.running"
	| "status.shadowed"
	| "status.aborted"
	// Navigation
	| "nav.cursor"
	| "nav.selected"
	| "nav.expand"
	| "nav.collapse"
	| "nav.back"
	// Tree Connectors
	| "tree.branch"
	| "tree.last"
	| "tree.vertical"
	| "tree.horizontal"
	| "tree.hook"
	// Box Drawing - Rounded
	| "boxRound.topLeft"
	| "boxRound.topRight"
	| "boxRound.bottomLeft"
	| "boxRound.bottomRight"
	| "boxRound.horizontal"
	| "boxRound.vertical"
	// Box Drawing - Sharp
	| "boxSharp.topLeft"
	| "boxSharp.topRight"
	| "boxSharp.bottomLeft"
	| "boxSharp.bottomRight"
	| "boxSharp.horizontal"
	| "boxSharp.vertical"
	| "boxSharp.cross"
	| "boxSharp.teeDown"
	| "boxSharp.teeUp"
	| "boxSharp.teeRight"
	| "boxSharp.teeLeft"
	// Separators
	| "sep.powerline"
	| "sep.powerlineThin"
	| "sep.powerlineLeft"
	| "sep.powerlineRight"
	| "sep.powerlineThinLeft"
	| "sep.powerlineThinRight"
	| "sep.block"
	| "sep.space"
	| "sep.asciiLeft"
	| "sep.asciiRight"
	| "sep.dot"
	| "sep.slash"
	| "sep.pipe"
	// Icons
	| "icon.model"
	| "icon.folder"
	| "icon.file"
	| "icon.git"
	| "icon.branch"
	| "icon.tokens"
	| "icon.context"
	| "icon.cost"
	| "icon.time"
	| "icon.pi"
	| "icon.agents"
	| "icon.cache"
	| "icon.input"
	| "icon.output"
	| "icon.host"
	| "icon.session"
	| "icon.package"
	| "icon.warning"
	| "icon.rewind"
	| "icon.auto"
	| "icon.extensionSkill"
	| "icon.extensionTool"
	| "icon.extensionSlashCommand"
	| "icon.extensionMcp"
	| "icon.extensionRule"
	| "icon.extensionHook"
	| "icon.extensionPrompt"
	| "icon.extensionContextFile"
	| "icon.extensionInstruction"
	// Thinking Levels
	| "thinking.minimal"
	| "thinking.low"
	| "thinking.medium"
	| "thinking.high"
	| "thinking.xhigh"
	// Checkboxes
	| "checkbox.checked"
	| "checkbox.unchecked"
	// Text Formatting
	| "format.ellipsis"
	| "format.bullet"
	| "format.dash"
	| "format.bracketLeft"
	| "format.bracketRight"
	// Markdown-specific
	| "md.quoteBorder"
	| "md.hrChar"
	| "md.bullet"
	// Spinner frames (array stored as comma-separated string)
	| "spinner.frames"
	// Language/file type icons
	| "lang.default"
	| "lang.typescript"
	| "lang.javascript"
	| "lang.python"
	| "lang.rust"
	| "lang.go"
	| "lang.java"
	| "lang.c"
	| "lang.cpp"
	| "lang.csharp"
	| "lang.ruby"
	| "lang.php"
	| "lang.swift"
	| "lang.kotlin"
	| "lang.shell"
	| "lang.html"
	| "lang.css"
	| "lang.json"
	| "lang.yaml"
	| "lang.markdown"
	| "lang.sql"
	| "lang.docker"
	| "lang.lua"
	| "lang.text"
	| "lang.env"
	| "lang.toml"
	| "lang.xml"
	| "lang.ini"
	| "lang.conf"
	| "lang.log"
	| "lang.csv"
	| "lang.tsv"
	| "lang.image"
	| "lang.pdf"
	| "lang.archive"
	| "lang.binary";

type SymbolMap = Record<SymbolKey, string>;

const UNICODE_SYMBOLS: SymbolMap = {
	// Status Indicators
	// pick: ✓ | alt: ✔ ✅ ☑ ✚
	"status.success": "✓",
	// pick: ✗ | alt: ✘ ✖ ❌ ⨯
	"status.error": "✗",
	// pick: ⚠ | alt: ‼ ⁉ ▲ △
	"status.warning": "⚠",
	// pick: ℹ | alt: ⓘ 🛈 ⅈ
	"status.info": "ℹ",
	// pick: ◔ | alt: ● ◐ ◑ ◒ ◓ ⏳ …
	"status.pending": "◔",
	// pick: ○ | alt: ◌ ◯ ⃠
	"status.disabled": "○",
	// pick: ● | alt: ◉ ◎ ⬤
	"status.enabled": "●",
	// pick: ↻ | alt: ↺ ⟳ ⟲ ◐ ▶
	"status.running": "↻",
	// pick: ◐ | alt: ◑ ◒ ◓ ◔
	"status.shadowed": "◐",
	// pick: ⊗ | alt: ⊘ ⛔ ⏹ ⨂
	"status.aborted": "⊗",
	// Navigation
	// pick: ❯ | alt: › ▸ ▹
	"nav.cursor": "❯",
	// pick: ➜ | alt: → ➤ ➔ ⇒
	"nav.selected": "➜",
	// pick: ▸ | alt: ▶ ▹ ⯈
	"nav.expand": "▸",
	// pick: ▾ | alt: ▼ ▽ ⯆
	"nav.collapse": "▾",
	// pick: ← | alt: ↩ ↫ ⇦
	"nav.back": "←",
	// Tree Connectors
	// pick: ├─ | alt: ├╴ ├╌ ├┄ ╠═
	"tree.branch": "├─",
	// pick: └─ | alt: └╴ └╌ └┄ ╚═
	"tree.last": "└─",
	// pick: │ | alt: ┃ ║ ▏ ▕
	"tree.vertical": "│",
	// pick: ─ | alt: ━ ═ ╌ ┄
	"tree.horizontal": "─",
	// pick: ⎿ | alt: └ ╰ ↳
	"tree.hook": "⎿",
	// Box Drawing - Rounded
	// pick: ╭ | alt: ┌ ┏ ╔
	"boxRound.topLeft": "╭",
	// pick: ╮ | alt: ┐ ┓ ╗
	"boxRound.topRight": "╮",
	// pick: ╰ | alt: └ ┗ ╚
	"boxRound.bottomLeft": "╰",
	// pick: ╯ | alt: ┘ ┛ ╝
	"boxRound.bottomRight": "╯",
	// pick: ─ | alt: ━ ═ ╌
	"boxRound.horizontal": "─",
	// pick: │ | alt: ┃ ║ ▏
	"boxRound.vertical": "│",
	// Box Drawing - Sharp
	// pick: ┌ | alt: ┏ ╭ ╔
	"boxSharp.topLeft": "┌",
	// pick: ┐ | alt: ┓ ╮ ╗
	"boxSharp.topRight": "┐",
	// pick: └ | alt: ┗ ╰ ╚
	"boxSharp.bottomLeft": "└",
	// pick: ┘ | alt: ┛ ╯ ╝
	"boxSharp.bottomRight": "┘",
	// pick: ─ | alt: ━ ═ ╌
	"boxSharp.horizontal": "─",
	// pick: │ | alt: ┃ ║ ▏
	"boxSharp.vertical": "│",
	// pick: ┼ | alt: ╋ ╬ ┿
	"boxSharp.cross": "┼",
	// pick: ┬ | alt: ╦ ┯ ┳
	"boxSharp.teeDown": "┬",
	// pick: ┴ | alt: ╩ ┷ ┻
	"boxSharp.teeUp": "┴",
	// pick: ├ | alt: ╠ ┝ ┣
	"boxSharp.teeRight": "├",
	// pick: ┤ | alt: ╣ ┥ ┫
	"boxSharp.teeLeft": "┤",
	// Separators
	// pick: │ | alt: ┃ ║ ▏
	"sep.powerline": "│",
	// pick: │ | alt: ┆ ┊
	"sep.powerlineThin": "│",
	// pick: > | alt: › ▸ »
	"sep.powerlineLeft": ">",
	// pick: < | alt: ‹ ◂ «
	"sep.powerlineRight": "<",
	// pick: > | alt: › ▸
	"sep.powerlineThinLeft": ">",
	// pick: < | alt: ‹ ◂
	"sep.powerlineThinRight": "<",
	// pick: █ | alt: ▓ ▒ ░ ▉ ▌
	"sep.block": "█",
	// pick: space | alt: ␠ ·
	"sep.space": " ",
	// pick: > | alt: › » ▸
	"sep.asciiLeft": ">",
	// pick: < | alt: ‹ « ◂
	"sep.asciiRight": "<",
	// pick: · | alt: • ⋅
	"sep.dot": " · ",
	// pick: / | alt: ／ ∕ ⁄
	"sep.slash": " / ",
	// pick: | | alt: │ ┃ ║
	"sep.pipe": " | ",
	// Icons
	// pick: ◈ | alt: ◆ ⬢ ◇
	"icon.model": "◈",
	// pick: 📁 | alt: 📂 🗂 🗃
	"icon.folder": "📁",
	// pick: 📄 | alt: 📃 📝
	"icon.file": "📄",
	// pick: ⎇ | alt: 🔀 ⑂
	"icon.git": "⎇",
	// pick: ⎇ | alt: 🌿 ⑂
	"icon.branch": "⎇",
	// pick: ⊛ | alt: ◎ ◍ ⊙
	"icon.tokens": "⊛",
	// pick: ◫ | alt: ◧ ▣ ▦
	"icon.context": "◫",
	// pick: $ | alt: 💲 💰
	"icon.cost": "$",
	// pick: ◷ | alt: ⏱ ⏲ ⌛
	"icon.time": "◷",
	// pick: π | alt: ∏ ∑
	"icon.pi": "π",
	// pick: AG | alt: 👥 👤
	"icon.agents": "AG",
	// pick: cache | alt: 💾 🗄
	"icon.cache": "cache",
	// pick: in: | alt: ⤵ ↲
	"icon.input": "in:",
	// pick: out: | alt: ⤴ ↱
	"icon.output": "out:",
	// pick: host | alt: 🖥 💻
	"icon.host": "host",
	// pick: id | alt: 🧭 🧩
	"icon.session": "id",
	// pick: 📦 | alt: 🧰
	"icon.package": "📦",
	// pick: ⚠ | alt: ❗
	"icon.warning": "⚠",
	// pick: ↩ | alt: ↺ ⟲
	"icon.rewind": "↩",
	// pick: ⚡ | alt: ✨ ✦
	"icon.auto": "⚡",
	// pick: SK | alt: 🧠 🎓
	"icon.extensionSkill": "SK",
	// pick: TL | alt: 🛠 ⚙
	"icon.extensionTool": "TL",
	// pick: / | alt: ⌘ ⌥
	"icon.extensionSlashCommand": "/",
	// pick: MCP | alt: 🔌 🧩
	"icon.extensionMcp": "MCP",
	// pick: RL | alt: ⚖ 📏
	"icon.extensionRule": "RL",
	// pick: HK | alt: 🪝 ⚓
	"icon.extensionHook": "HK",
	// pick: PR | alt: 💬 ✎
	"icon.extensionPrompt": "PR",
	// pick: CF | alt: 📄 📎
	"icon.extensionContextFile": "CF",
	// pick: IN | alt: 📘 ℹ
	"icon.extensionInstruction": "IN",
	// Thinking Levels
	// pick: [min] | alt: · ◔ min
	"thinking.minimal": "[min]",
	// pick: [low] | alt: ◑ low ▪ low
	"thinking.low": "[low]",
	// pick: [med] | alt: ◒ med ▪ med
	"thinking.medium": "[med]",
	// pick: [high] | alt: ◕ high ▪ high
	"thinking.high": "[high]",
	// pick: [xhi] | alt: ◉ xhi ▪ xhi
	"thinking.xhigh": "[xhi]",
	// Checkboxes
	// pick: ☑ | alt: ✓ ✔ ✅
	"checkbox.checked": "☑",
	// pick: ☐ | alt: □ ▢
	"checkbox.unchecked": "☐",
	// Text Formatting
	// pick: … | alt: ⋯ ...
	"format.ellipsis": "…",
	// pick: • | alt: · ▪ ◦
	"format.bullet": "•",
	// pick: – | alt: — ― -
	"format.dash": "–",
	// pick: [ | alt: ⟦ ⟨
	"format.bracketLeft": "[",
	// pick: ] | alt: ⟧ ⟩
	"format.bracketRight": "]",
	// Markdown-specific
	// pick: │ | alt: ┃ ║
	"md.quoteBorder": "│",
	// pick: ─ | alt: ━ ═
	"md.hrChar": "─",
	// pick: • | alt: · ▪ ◦
	"md.bullet": "•",
	// Spinner frames (pulsing dot)
	"spinner.frames": "·,•,●,•",
	// Language icons (unicode uses code symbol prefix)
	"lang.default": "❖",
	"lang.typescript": "❖ ts",
	"lang.javascript": "❖ js",
	"lang.python": "❖ py",
	"lang.rust": "❖ rs",
	"lang.go": "❖ go",
	"lang.java": "❖ java",
	"lang.c": "❖ c",
	"lang.cpp": "❖ c++",
	"lang.csharp": "❖ c#",
	"lang.ruby": "❖ rb",
	"lang.php": "❖ php",
	"lang.swift": "❖ swift",
	"lang.kotlin": "❖ kt",
	"lang.shell": "❖ sh",
	"lang.html": "❖ html",
	"lang.css": "❖ css",
	"lang.json": "❖ json",
	"lang.yaml": "❖ yaml",
	"lang.markdown": "❖ md",
	"lang.sql": "❖ sql",
	"lang.docker": "❖ docker",
	"lang.lua": "❖ lua",
	"lang.text": "❖ txt",
	"lang.env": "❖ env",
	"lang.toml": "❖ toml",
	"lang.xml": "❖ xml",
	"lang.ini": "❖ ini",
	"lang.conf": "❖ conf",
	"lang.log": "❖ log",
	"lang.csv": "❖ csv",
	"lang.tsv": "❖ tsv",
	"lang.image": "❖ img",
	"lang.pdf": "❖ pdf",
	"lang.archive": "❖ zip",
	"lang.binary": "❖ bin",
};

const NERD_SYMBOLS: SymbolMap = {
	// Status Indicators
	// pick:  | alt:   
	"status.success": "\uf00c",
	// pick:  | alt:   
	"status.error": "\uf00d",
	// pick:  | alt:  
	"status.warning": "\uf12a",
	// pick:  | alt: 
	"status.info": "\uf129",
	// pick:  | alt:   
	"status.pending": "\uf254",
	// pick:  | alt:  
	"status.disabled": "\uf05e",
	// pick:  | alt:  
	"status.enabled": "\uf111",
	// pick:  | alt:   
	"status.running": "\uf110",
	// pick: ◐ | alt: ◑ ◒ ◓ ◔
	"status.shadowed": "◐",
	// pick:  | alt:  
	"status.aborted": "\uf04d",
	// Navigation
	// pick:  | alt:  
	"nav.cursor": "\uf054",
	// pick:  | alt:  
	"nav.selected": "\uf178",
	// pick:  | alt:  
	"nav.expand": "\uf0da",
	// pick:  | alt:  
	"nav.collapse": "\uf0d7",
	// pick:  | alt:  
	"nav.back": "\uf060",
	// Tree Connectors (same as unicode)
	// pick: ├─ | alt: ├╴ ├╌ ╠═ ┣━
	"tree.branch": "\u251c\u2500",
	// pick: └─ | alt: └╴ └╌ ╚═ ┗━
	"tree.last": "\u2514\u2500",
	// pick: │ | alt: ┃ ║ ▏ ▕
	"tree.vertical": "\u2502",
	// pick: ─ | alt: ━ ═ ╌ ┄
	"tree.horizontal": "\u2500",
	// pick: └ | alt: ╰ ⎿ ↳
	"tree.hook": "\u2514",
	// Box Drawing - Rounded (same as unicode)
	// pick: ╭ | alt: ┌ ┏ ╔
	"boxRound.topLeft": "\u256d",
	// pick: ╮ | alt: ┐ ┓ ╗
	"boxRound.topRight": "\u256e",
	// pick: ╰ | alt: └ ┗ ╚
	"boxRound.bottomLeft": "\u2570",
	// pick: ╯ | alt: ┘ ┛ ╝
	"boxRound.bottomRight": "\u256f",
	// pick: ─ | alt: ━ ═ ╌
	"boxRound.horizontal": "\u2500",
	// pick: │ | alt: ┃ ║ ▏
	"boxRound.vertical": "\u2502",
	// Box Drawing - Sharp (same as unicode)
	// pick: ┌ | alt: ┏ ╭ ╔
	"boxSharp.topLeft": "\u250c",
	// pick: ┐ | alt: ┓ ╮ ╗
	"boxSharp.topRight": "\u2510",
	// pick: └ | alt: ┗ ╰ ╚
	"boxSharp.bottomLeft": "\u2514",
	// pick: ┘ | alt: ┛ ╯ ╝
	"boxSharp.bottomRight": "\u2518",
	// pick: ─ | alt: ━ ═ ╌
	"boxSharp.horizontal": "\u2500",
	// pick: │ | alt: ┃ ║ ▏
	"boxSharp.vertical": "\u2502",
	// pick: ┼ | alt: ╋ ╬ ┿
	"boxSharp.cross": "\u253c",
	// pick: ┬ | alt: ╦ ┯ ┳
	"boxSharp.teeDown": "\u252c",
	// pick: ┴ | alt: ╩ ┷ ┻
	"boxSharp.teeUp": "\u2534",
	// pick: ├ | alt: ╠ ┝ ┣
	"boxSharp.teeRight": "\u251c",
	// pick: ┤ | alt: ╣ ┥ ┫
	"boxSharp.teeLeft": "\u2524",
	// Separators - Nerd Font specific
	// pick:  | alt:   
	"sep.powerline": "\ue0b0",
	// pick:  | alt:  
	"sep.powerlineThin": "\ue0b1",
	// pick:  | alt:  
	"sep.powerlineLeft": "\ue0b0",
	// pick:  | alt:  
	"sep.powerlineRight": "\ue0b2",
	// pick:  | alt: 
	"sep.powerlineThinLeft": "\ue0b1",
	// pick:  | alt: 
	"sep.powerlineThinRight": "\ue0b3",
	// pick: █ | alt: ▓ ▒ ░ ▉ ▌
	"sep.block": "\u2588",
	// pick: space | alt: ␠ ·
	"sep.space": " ",
	// pick: > | alt: › » ▸
	"sep.asciiLeft": ">",
	// pick: < | alt: ‹ « ◂
	"sep.asciiRight": "<",
	// pick: · | alt: • ⋅
	"sep.dot": " \u00b7 ",
	// pick:  | alt: / ∕ ⁄
	"sep.slash": "\ue0bb",
	// pick:  | alt: │ ┃ |
	"sep.pipe": "\ue0b3",
	// Icons - Nerd Font specific
	// pick:  | alt:   ◆
	"icon.model": "\uec19",
	// pick:  | alt:  
	"icon.folder": "\uf115",
	// pick:  | alt:  
	"icon.file": "\uf15b",
	// pick:  | alt:  ⎇
	"icon.git": "\uf1d3",
	// pick:  | alt:  ⎇
	"icon.branch": "\uf126",
	// pick:  | alt: ⊛ ◍ 
	"icon.tokens": "\ue26b",
	// pick:  | alt: ◫ ▦
	"icon.context": "\ue70f",
	// pick:  | alt: $ ¢
	"icon.cost": "\uf155",
	// pick:  | alt: ◷ ◴
	"icon.time": "\uf017",
	// pick:  | alt: π ∏ ∑
	"icon.pi": "\ue22c",
	// pick:  | alt: 
	"icon.agents": "\uf0c0",
	// pick:  | alt:  
	"icon.cache": "\uf1c0",
	// pick:  | alt:  →
	"icon.input": "\uf090",
	// pick:  | alt:  →
	"icon.output": "\uf08b",
	// pick:  | alt:  
	"icon.host": "\uf109",
	// pick:  | alt:  
	"icon.session": "\uf550",
	// pick:  | alt: 
	"icon.package": "\uf487",
	// pick:  | alt:  
	"icon.warning": "\uf071",
	// pick:  | alt:  ↺
	"icon.rewind": "\uf0e2",
	// pick: 󰁨 | alt:   
	"icon.auto": "\u{f0068}",
	// pick:  | alt:  
	"icon.extensionSkill": "\uf0eb",
	// pick:  | alt:  
	"icon.extensionTool": "\uf0ad",
	// pick:  | alt: 
	"icon.extensionSlashCommand": "\uf120",
	// pick:  | alt:  
	"icon.extensionMcp": "\uf1e6",
	// pick:  | alt:  
	"icon.extensionRule": "\uf0e3",
	// pick:  | alt: 
	"icon.extensionHook": "\uf0c1",
	// pick:  | alt:  
	"icon.extensionPrompt": "\uf075",
	// pick:  | alt:  
	"icon.extensionContextFile": "\uf0f6",
	// pick:  | alt:  
	"icon.extensionInstruction": "\uf02d",
	// Thinking Levels - emoji labels
	// pick: 🤨 min | alt:  min  min
	"thinking.minimal": "🤨 min",
	// pick: 🤔 low | alt:  low  low
	"thinking.low": "🤔 low",
	// pick: 🤓 med | alt:  med  med
	"thinking.medium": "🤓 med",
	// pick: 🤯 high | alt:  high  high
	"thinking.high": "🤯 high",
	// pick: 🧠 xhi | alt:  xhi  xhi
	"thinking.xhigh": "🧠 xhi",
	// Checkboxes
	// pick:  | alt:  
	"checkbox.checked": "\uf14a",
	// pick:  | alt: 
	"checkbox.unchecked": "\uf096",
	// Text Formatting
	// pick: … | alt: ⋯ ...
	"format.ellipsis": "\u2026",
	// pick:  | alt:   •
	"format.bullet": "\uf111",
	// pick: – | alt: — ― -
	"format.dash": "\u2013",
	// pick: [ | alt: ⟦ ⟨
	"format.bracketLeft": "[",
	// pick: ] | alt: ⟧ ⟩
	"format.bracketRight": "]",
	// Markdown-specific
	// pick: │ | alt: ┃ ║
	"md.quoteBorder": "\u2502",
	// pick: ─ | alt: ━ ═
	"md.hrChar": "\u2500",
	// pick:  | alt:  •
	"md.bullet": "\uf111",
	// Spinner frames (nerd font circles)
	"spinner.frames": "󰪥,󰪤,󰪣,󰪢,󰪡,󰪠,󰪟,󰪞,󰪝,󰪜,󰪛,󰪥",
	// Language icons (nerd font devicons)
	"lang.default": "",
	"lang.typescript": "",
	"lang.javascript": "",
	"lang.python": "",
	"lang.rust": "",
	"lang.go": "",
	"lang.java": "",
	"lang.c": "",
	"lang.cpp": "",
	"lang.csharp": "",
	"lang.ruby": "",
	"lang.php": "",
	"lang.swift": "",
	"lang.kotlin": "",
	"lang.shell": "",
	"lang.html": "",
	"lang.css": "",
	"lang.json": "",
	"lang.yaml": "",
	"lang.markdown": "",
	"lang.sql": "",
	"lang.docker": "",
	"lang.lua": "",
	"lang.text": "",
	"lang.env": "",
	"lang.toml": "",
	"lang.xml": "󰗀",
	"lang.ini": "",
	"lang.conf": "",
	"lang.log": "󰌱",
	"lang.csv": "󰈛",
	"lang.tsv": "󰈛",
	"lang.image": "󰈟",
	"lang.pdf": "󰈦",
	"lang.archive": "",
	"lang.binary": "󰆚",
};

const ASCII_SYMBOLS: SymbolMap = {
	// Status Indicators
	"status.success": "[ok]",
	"status.error": "[!!]",
	"status.warning": "[!]",
	"status.info": "[i]",
	"status.pending": "[*]",
	"status.disabled": "[ ]",
	"status.enabled": "[x]",
	"status.running": "[~]",
	"status.shadowed": "[/]",
	"status.aborted": "[-]",
	// Navigation
	"nav.cursor": ">",
	"nav.selected": "->",
	"nav.expand": "+",
	"nav.collapse": "-",
	"nav.back": "<-",
	// Tree Connectors
	"tree.branch": "|--",
	"tree.last": "'--",
	"tree.vertical": "|",
	"tree.horizontal": "-",
	"tree.hook": "`-",
	// Box Drawing - Rounded (ASCII fallback)
	"boxRound.topLeft": "+",
	"boxRound.topRight": "+",
	"boxRound.bottomLeft": "+",
	"boxRound.bottomRight": "+",
	"boxRound.horizontal": "-",
	"boxRound.vertical": "|",
	// Box Drawing - Sharp (ASCII fallback)
	"boxSharp.topLeft": "+",
	"boxSharp.topRight": "+",
	"boxSharp.bottomLeft": "+",
	"boxSharp.bottomRight": "+",
	"boxSharp.horizontal": "-",
	"boxSharp.vertical": "|",
	"boxSharp.cross": "+",
	"boxSharp.teeDown": "+",
	"boxSharp.teeUp": "+",
	"boxSharp.teeRight": "+",
	"boxSharp.teeLeft": "+",
	// Separators
	"sep.powerline": ">",
	"sep.powerlineThin": ">",
	"sep.powerlineLeft": ">",
	"sep.powerlineRight": "<",
	"sep.powerlineThinLeft": ">",
	"sep.powerlineThinRight": "<",
	"sep.block": "#",
	"sep.space": " ",
	"sep.asciiLeft": ">",
	"sep.asciiRight": "<",
	"sep.dot": " - ",
	"sep.slash": " / ",
	"sep.pipe": " | ",
	// Icons
	"icon.model": "[M]",
	"icon.folder": "[D]",
	"icon.file": "[F]",
	"icon.git": "git:",
	"icon.branch": "@",
	"icon.tokens": "tok:",
	"icon.context": "ctx:",
	"icon.cost": "$",
	"icon.time": "t:",
	"icon.pi": "pi",
	"icon.agents": "AG",
	"icon.cache": "cache",
	"icon.input": "in:",
	"icon.output": "out:",
	"icon.host": "host",
	"icon.session": "id",
	"icon.package": "[P]",
	"icon.warning": "[!]",
	"icon.rewind": "<-",
	"icon.auto": "[A]",
	"icon.extensionSkill": "SK",
	"icon.extensionTool": "TL",
	"icon.extensionSlashCommand": "/",
	"icon.extensionMcp": "MCP",
	"icon.extensionRule": "RL",
	"icon.extensionHook": "HK",
	"icon.extensionPrompt": "PR",
	"icon.extensionContextFile": "CF",
	"icon.extensionInstruction": "IN",
	// Thinking Levels
	"thinking.minimal": "[min]",
	"thinking.low": "[low]",
	"thinking.medium": "[med]",
	"thinking.high": "[high]",
	"thinking.xhigh": "[xhi]",
	// Checkboxes
	"checkbox.checked": "[x]",
	"checkbox.unchecked": "[ ]",
	// Text Formatting
	"format.ellipsis": "...",
	"format.bullet": "*",
	"format.dash": "-",
	"format.bracketLeft": "[",
	"format.bracketRight": "]",
	// Markdown-specific
	"md.quoteBorder": "|",
	"md.hrChar": "-",
	"md.bullet": "*",
	// Spinner frames (ASCII)
	"spinner.frames": "|,/,-,\\",
	// Language icons (ASCII uses abbreviations)
	"lang.default": "code",
	"lang.typescript": "ts",
	"lang.javascript": "js",
	"lang.python": "py",
	"lang.rust": "rs",
	"lang.go": "go",
	"lang.java": "java",
	"lang.c": "c",
	"lang.cpp": "cpp",
	"lang.csharp": "cs",
	"lang.ruby": "rb",
	"lang.php": "php",
	"lang.swift": "swift",
	"lang.kotlin": "kt",
	"lang.shell": "sh",
	"lang.html": "html",
	"lang.css": "css",
	"lang.json": "json",
	"lang.yaml": "yaml",
	"lang.markdown": "md",
	"lang.sql": "sql",
	"lang.docker": "docker",
	"lang.lua": "lua",
	"lang.text": "txt",
	"lang.env": "env",
	"lang.toml": "toml",
	"lang.xml": "xml",
	"lang.ini": "ini",
	"lang.conf": "conf",
	"lang.log": "log",
	"lang.csv": "csv",
	"lang.tsv": "tsv",
	"lang.image": "img",
	"lang.pdf": "pdf",
	"lang.archive": "zip",
	"lang.binary": "bin",
};

const SYMBOL_PRESETS: Record<SymbolPreset, SymbolMap> = {
	unicode: UNICODE_SYMBOLS,
	nerd: NERD_SYMBOLS,
	ascii: ASCII_SYMBOLS,
};

// ============================================================================
// Types & Schema
// ============================================================================

const ColorValueSchema = Type.Union([
	Type.String(), // hex "#ff0000", var ref "primary", or empty ""
	Type.Integer({ minimum: 0, maximum: 255 }), // 256-color index
]);

type ColorValue = Static<typeof ColorValueSchema>;

const SymbolPresetSchema = Type.Union([Type.Literal("unicode"), Type.Literal("nerd"), Type.Literal("ascii")]);

const SymbolsSchema = Type.Optional(
	Type.Object({
		preset: Type.Optional(SymbolPresetSchema),
		overrides: Type.Optional(Type.Record(Type.String(), Type.String())),
	}),
);

const ThemeJsonSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	name: Type.String(),
	vars: Type.Optional(Type.Record(Type.String(), ColorValueSchema)),
	colors: Type.Object({
		// Core UI (10 colors)
		accent: ColorValueSchema,
		border: ColorValueSchema,
		borderAccent: ColorValueSchema,
		borderMuted: ColorValueSchema,
		success: ColorValueSchema,
		error: ColorValueSchema,
		warning: ColorValueSchema,
		muted: ColorValueSchema,
		dim: ColorValueSchema,
		text: ColorValueSchema,
		thinkingText: ColorValueSchema,
		// Backgrounds & Content Text (11 colors)
		selectedBg: ColorValueSchema,
		userMessageBg: ColorValueSchema,
		userMessageText: ColorValueSchema,
		customMessageBg: ColorValueSchema,
		customMessageText: ColorValueSchema,
		customMessageLabel: ColorValueSchema,
		toolPendingBg: ColorValueSchema,
		toolSuccessBg: ColorValueSchema,
		toolErrorBg: ColorValueSchema,
		toolTitle: ColorValueSchema,
		toolOutput: ColorValueSchema,
		// Markdown (10 colors)
		mdHeading: ColorValueSchema,
		mdLink: ColorValueSchema,
		mdLinkUrl: ColorValueSchema,
		mdCode: ColorValueSchema,
		mdCodeBlock: ColorValueSchema,
		mdCodeBlockBorder: ColorValueSchema,
		mdQuote: ColorValueSchema,
		mdQuoteBorder: ColorValueSchema,
		mdHr: ColorValueSchema,
		mdListBullet: ColorValueSchema,
		// Tool Diffs (3 colors)
		toolDiffAdded: ColorValueSchema,
		toolDiffRemoved: ColorValueSchema,
		toolDiffContext: ColorValueSchema,
		// Syntax Highlighting (9 colors)
		syntaxComment: ColorValueSchema,
		syntaxKeyword: ColorValueSchema,
		syntaxFunction: ColorValueSchema,
		syntaxVariable: ColorValueSchema,
		syntaxString: ColorValueSchema,
		syntaxNumber: ColorValueSchema,
		syntaxType: ColorValueSchema,
		syntaxOperator: ColorValueSchema,
		syntaxPunctuation: ColorValueSchema,
		// Thinking Level Borders (6 colors)
		thinkingOff: ColorValueSchema,
		thinkingMinimal: ColorValueSchema,
		thinkingLow: ColorValueSchema,
		thinkingMedium: ColorValueSchema,
		thinkingHigh: ColorValueSchema,
		thinkingXhigh: ColorValueSchema,
		// Bash Mode (1 color)
		bashMode: ColorValueSchema,
		// Footer Status Line
		statusLineBg: ColorValueSchema,
		statusLineSep: ColorValueSchema,
		statusLineModel: ColorValueSchema,
		statusLinePath: ColorValueSchema,
		statusLineGitClean: ColorValueSchema,
		statusLineGitDirty: ColorValueSchema,
		statusLineContext: ColorValueSchema,
		statusLineSpend: ColorValueSchema,
		statusLineStaged: ColorValueSchema,
		statusLineDirty: ColorValueSchema,
		statusLineUntracked: ColorValueSchema,
		statusLineOutput: ColorValueSchema,
		statusLineCost: ColorValueSchema,
		statusLineSubagents: ColorValueSchema,
	}),
	export: Type.Optional(
		Type.Object({
			pageBg: Type.Optional(ColorValueSchema),
			cardBg: Type.Optional(ColorValueSchema),
			infoBg: Type.Optional(ColorValueSchema),
		}),
	),
	symbols: SymbolsSchema,
});

type ThemeJson = Static<typeof ThemeJsonSchema>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TypeBox CJS/ESM type mismatch
const validateThemeJson = TypeCompiler.Compile(ThemeJsonSchema as any);

export type ThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "bashMode"
	| "statusLineSep"
	| "statusLineModel"
	| "statusLinePath"
	| "statusLineGitClean"
	| "statusLineGitDirty"
	| "statusLineContext"
	| "statusLineSpend"
	| "statusLineStaged"
	| "statusLineDirty"
	| "statusLineUntracked"
	| "statusLineOutput"
	| "statusLineCost"
	| "statusLineSubagents";

export type ThemeBg =
	| "selectedBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg"
	| "statusLineBg";

type ColorMode = "truecolor" | "256color";

// ============================================================================
// Color Utilities
// ============================================================================

function detectColorMode(): ColorMode {
	const colorterm = process.env.COLORTERM;
	if (colorterm === "truecolor" || colorterm === "24bit") {
		return "truecolor";
	}
	// Windows Terminal supports truecolor
	if (process.env.WT_SESSION) {
		return "truecolor";
	}
	const term = process.env.TERM || "";
	if (term.includes("256color")) {
		return "256color";
	}
	return "256color";
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const cleaned = hex.replace("#", "");
	if (cleaned.length !== 6) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	const r = parseInt(cleaned.substring(0, 2), 16);
	const g = parseInt(cleaned.substring(2, 4), 16);
	const b = parseInt(cleaned.substring(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	return { r, g, b };
}

// The 6x6x6 color cube channel values (indices 0-5)
const CUBE_VALUES = [0, 95, 135, 175, 215, 255];

// Grayscale ramp values (indices 232-255, 24 grays from 8 to 238)
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

function findClosestCubeIndex(value: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < CUBE_VALUES.length; i++) {
		const dist = Math.abs(value - CUBE_VALUES[i]);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

function findClosestGrayIndex(gray: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < GRAY_VALUES.length; i++) {
		const dist = Math.abs(gray - GRAY_VALUES[i]);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
	// Weighted Euclidean distance (human eye is more sensitive to green)
	const dr = r1 - r2;
	const dg = g1 - g2;
	const db = b1 - b2;
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

function rgbTo256(r: number, g: number, b: number): number {
	// Find closest color in the 6x6x6 cube
	const rIdx = findClosestCubeIndex(r);
	const gIdx = findClosestCubeIndex(g);
	const bIdx = findClosestCubeIndex(b);
	const cubeR = CUBE_VALUES[rIdx];
	const cubeG = CUBE_VALUES[gIdx];
	const cubeB = CUBE_VALUES[bIdx];
	const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
	const cubeDist = colorDistance(r, g, b, cubeR, cubeG, cubeB);

	// Find closest grayscale
	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
	const grayIdx = findClosestGrayIndex(gray);
	const grayValue = GRAY_VALUES[grayIdx];
	const grayIndex = 232 + grayIdx;
	const grayDist = colorDistance(r, g, b, grayValue, grayValue, grayValue);

	// Check if color has noticeable saturation (hue matters)
	// If max-min spread is significant, prefer cube to preserve tint
	const maxC = Math.max(r, g, b);
	const minC = Math.min(r, g, b);
	const spread = maxC - minC;

	// Only consider grayscale if color is nearly neutral (spread < 10)
	// AND grayscale is actually closer
	if (spread < 10 && grayDist < cubeDist) {
		return grayIndex;
	}

	return cubeIndex;
}

function hexTo256(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return rgbTo256(r, g, b);
}

function fgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[39m";
	if (typeof color === "number") return `\x1b[38;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[38;2;${r};${g};${b}m`;
		} else {
			const index = hexTo256(color);
			return `\x1b[38;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

function bgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[49m";
	if (typeof color === "number") return `\x1b[48;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[48;2;${r};${g};${b}m`;
		} else {
			const index = hexTo256(color);
			return `\x1b[48;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

function resolveVarRefs(
	value: ColorValue,
	vars: Record<string, ColorValue>,
	visited = new Set<string>(),
): string | number {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (visited.has(value)) {
		throw new Error(`Circular variable reference detected: ${value}`);
	}
	if (!(value in vars)) {
		throw new Error(`Variable reference not found: ${value}`);
	}
	visited.add(value);
	return resolveVarRefs(vars[value], vars, visited);
}

function resolveThemeColors<T extends Record<string, ColorValue>>(
	colors: T,
	vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved as Record<keyof T, string | number>;
}

// ============================================================================
// Theme Class
// ============================================================================

const langMap: Record<string, SymbolKey> = {
	typescript: "lang.typescript",
	ts: "lang.typescript",
	tsx: "lang.typescript",
	javascript: "lang.javascript",
	js: "lang.javascript",
	jsx: "lang.javascript",
	mjs: "lang.javascript",
	cjs: "lang.javascript",
	python: "lang.python",
	py: "lang.python",
	rust: "lang.rust",
	rs: "lang.rust",
	go: "lang.go",
	java: "lang.java",
	c: "lang.c",
	cpp: "lang.cpp",
	"c++": "lang.cpp",
	cc: "lang.cpp",
	cxx: "lang.cpp",
	csharp: "lang.csharp",
	cs: "lang.csharp",
	ruby: "lang.ruby",
	rb: "lang.ruby",
	php: "lang.php",
	swift: "lang.swift",
	kotlin: "lang.kotlin",
	kt: "lang.kotlin",
	bash: "lang.shell",
	sh: "lang.shell",
	zsh: "lang.shell",
	fish: "lang.shell",
	shell: "lang.shell",
	html: "lang.html",
	htm: "lang.html",
	css: "lang.css",
	scss: "lang.css",
	sass: "lang.css",
	less: "lang.css",
	json: "lang.json",
	yaml: "lang.yaml",
	yml: "lang.yaml",
	markdown: "lang.markdown",
	md: "lang.markdown",
	sql: "lang.sql",
	dockerfile: "lang.docker",
	docker: "lang.docker",
	lua: "lang.lua",
	text: "lang.text",
	txt: "lang.text",
	plain: "lang.text",
	log: "lang.log",
	env: "lang.env",
	dotenv: "lang.env",
	toml: "lang.toml",
	xml: "lang.xml",
	ini: "lang.ini",
	conf: "lang.conf",
	cfg: "lang.conf",
	config: "lang.conf",
	properties: "lang.conf",
	csv: "lang.csv",
	tsv: "lang.tsv",
	image: "lang.image",
	img: "lang.image",
	png: "lang.image",
	jpg: "lang.image",
	jpeg: "lang.image",
	gif: "lang.image",
	webp: "lang.image",
	svg: "lang.image",
	ico: "lang.image",
	bmp: "lang.image",
	tiff: "lang.image",
	pdf: "lang.pdf",
	zip: "lang.archive",
	tar: "lang.archive",
	gz: "lang.archive",
	tgz: "lang.archive",
	bz2: "lang.archive",
	xz: "lang.archive",
	"7z": "lang.archive",
	exe: "lang.binary",
	dll: "lang.binary",
	so: "lang.binary",
	dylib: "lang.binary",
	wasm: "lang.binary",
	bin: "lang.binary",
};
export class Theme {
	private fgColors: Map<ThemeColor, string>;
	private bgColors: Map<ThemeBg, string>;
	private mode: ColorMode;
	private symbols: SymbolMap;
	private symbolPreset: SymbolPreset;

	constructor(
		fgColors: Record<ThemeColor, string | number>,
		bgColors: Record<ThemeBg, string | number>,
		mode: ColorMode,
		symbolPreset: SymbolPreset = "unicode",
		symbolOverrides: Record<string, string> = {},
	) {
		this.mode = mode;
		this.symbolPreset = symbolPreset;
		this.fgColors = new Map();
		for (const [key, value] of Object.entries(fgColors) as [ThemeColor, string | number][]) {
			this.fgColors.set(key, fgAnsi(value, mode));
		}
		this.bgColors = new Map();
		for (const [key, value] of Object.entries(bgColors) as [ThemeBg, string | number][]) {
			this.bgColors.set(key, bgAnsi(value, mode));
		}
		// Build symbol map from preset + overrides
		const baseSymbols = SYMBOL_PRESETS[symbolPreset];
		this.symbols = { ...baseSymbols };
		for (const [key, value] of Object.entries(symbolOverrides)) {
			if (key in this.symbols) {
				this.symbols[key as SymbolKey] = value;
			} else {
				logger.debug("Invalid symbol key in override", { key, availableKeys: Object.keys(this.symbols) });
			}
		}
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`; // Reset only foreground color
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return `${ansi}${text}\x1b[49m`; // Reset only background color
	}

	bold(text: string): string {
		return chalk.bold(text);
	}

	italic(text: string): string {
		return chalk.italic(text);
	}

	underline(text: string): string {
		return chalk.underline(text);
	}

	inverse(text: string): string {
		return chalk.inverse(text);
	}

	getFgAnsi(color: ThemeColor): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	getBgAnsi(color: ThemeBg): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return ansi;
	}

	getColorMode(): ColorMode {
		return this.mode;
	}

	getThinkingBorderColor(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): (str: string) => string {
		// Map thinking levels to dedicated theme colors
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str);
			case "minimal":
				return (str: string) => this.fg("thinkingMinimal", str);
			case "low":
				return (str: string) => this.fg("thinkingLow", str);
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str);
			case "high":
				return (str: string) => this.fg("thinkingHigh", str);
			case "xhigh":
				return (str: string) => this.fg("thinkingXhigh", str);
			default:
				return (str: string) => this.fg("thinkingOff", str);
		}
	}

	getBashModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("bashMode", str);
	}

	// -------------------------------------------------------------------------
	// Symbol Methods
	// -------------------------------------------------------------------------

	/**
	 * Get a symbol by key.
	 */
	symbol(key: SymbolKey): string {
		return this.symbols[key];
	}

	/**
	 * Get a symbol styled with a color.
	 */
	styledSymbol(key: SymbolKey, color: ThemeColor): string {
		return this.fg(color, this.symbols[key]);
	}

	/**
	 * Get the current symbol preset.
	 */
	getSymbolPreset(): SymbolPreset {
		return this.symbolPreset;
	}

	// -------------------------------------------------------------------------
	// Symbol Category Accessors
	// -------------------------------------------------------------------------

	get status() {
		return {
			success: this.symbols["status.success"],
			error: this.symbols["status.error"],
			warning: this.symbols["status.warning"],
			info: this.symbols["status.info"],
			pending: this.symbols["status.pending"],
			disabled: this.symbols["status.disabled"],
			enabled: this.symbols["status.enabled"],
			running: this.symbols["status.running"],
			shadowed: this.symbols["status.shadowed"],
			aborted: this.symbols["status.aborted"],
		};
	}

	get nav() {
		return {
			cursor: this.symbols["nav.cursor"],
			selected: this.symbols["nav.selected"],
			expand: this.symbols["nav.expand"],
			collapse: this.symbols["nav.collapse"],
			back: this.symbols["nav.back"],
		};
	}

	get tree() {
		return {
			branch: this.symbols["tree.branch"],
			last: this.symbols["tree.last"],
			vertical: this.symbols["tree.vertical"],
			horizontal: this.symbols["tree.horizontal"],
			hook: this.symbols["tree.hook"],
		};
	}

	get boxRound() {
		return {
			topLeft: this.symbols["boxRound.topLeft"],
			topRight: this.symbols["boxRound.topRight"],
			bottomLeft: this.symbols["boxRound.bottomLeft"],
			bottomRight: this.symbols["boxRound.bottomRight"],
			horizontal: this.symbols["boxRound.horizontal"],
			vertical: this.symbols["boxRound.vertical"],
		};
	}

	get boxSharp() {
		return {
			topLeft: this.symbols["boxSharp.topLeft"],
			topRight: this.symbols["boxSharp.topRight"],
			bottomLeft: this.symbols["boxSharp.bottomLeft"],
			bottomRight: this.symbols["boxSharp.bottomRight"],
			horizontal: this.symbols["boxSharp.horizontal"],
			vertical: this.symbols["boxSharp.vertical"],
			cross: this.symbols["boxSharp.cross"],
			teeDown: this.symbols["boxSharp.teeDown"],
			teeUp: this.symbols["boxSharp.teeUp"],
			teeRight: this.symbols["boxSharp.teeRight"],
			teeLeft: this.symbols["boxSharp.teeLeft"],
		};
	}

	get sep() {
		return {
			powerline: this.symbols["sep.powerline"],
			powerlineThin: this.symbols["sep.powerlineThin"],
			powerlineLeft: this.symbols["sep.powerlineLeft"],
			powerlineRight: this.symbols["sep.powerlineRight"],
			powerlineThinLeft: this.symbols["sep.powerlineThinLeft"],
			powerlineThinRight: this.symbols["sep.powerlineThinRight"],
			block: this.symbols["sep.block"],
			space: this.symbols["sep.space"],
			asciiLeft: this.symbols["sep.asciiLeft"],
			asciiRight: this.symbols["sep.asciiRight"],
			dot: this.symbols["sep.dot"],
			slash: this.symbols["sep.slash"],
			pipe: this.symbols["sep.pipe"],
		};
	}

	get icon() {
		return {
			model: this.symbols["icon.model"],
			folder: this.symbols["icon.folder"],
			file: this.symbols["icon.file"],
			git: this.symbols["icon.git"],
			branch: this.symbols["icon.branch"],
			tokens: this.symbols["icon.tokens"],
			context: this.symbols["icon.context"],
			cost: this.symbols["icon.cost"],
			time: this.symbols["icon.time"],
			pi: this.symbols["icon.pi"],
			agents: this.symbols["icon.agents"],
			cache: this.symbols["icon.cache"],
			input: this.symbols["icon.input"],
			output: this.symbols["icon.output"],
			host: this.symbols["icon.host"],
			session: this.symbols["icon.session"],
			package: this.symbols["icon.package"],
			warning: this.symbols["icon.warning"],
			rewind: this.symbols["icon.rewind"],
			auto: this.symbols["icon.auto"],
			extensionSkill: this.symbols["icon.extensionSkill"],
			extensionTool: this.symbols["icon.extensionTool"],
			extensionSlashCommand: this.symbols["icon.extensionSlashCommand"],
			extensionMcp: this.symbols["icon.extensionMcp"],
			extensionRule: this.symbols["icon.extensionRule"],
			extensionHook: this.symbols["icon.extensionHook"],
			extensionPrompt: this.symbols["icon.extensionPrompt"],
			extensionContextFile: this.symbols["icon.extensionContextFile"],
			extensionInstruction: this.symbols["icon.extensionInstruction"],
		};
	}

	get thinking() {
		return {
			minimal: this.symbols["thinking.minimal"],
			low: this.symbols["thinking.low"],
			medium: this.symbols["thinking.medium"],
			high: this.symbols["thinking.high"],
			xhigh: this.symbols["thinking.xhigh"],
		};
	}

	get checkbox() {
		return {
			checked: this.symbols["checkbox.checked"],
			unchecked: this.symbols["checkbox.unchecked"],
		};
	}

	get format() {
		return {
			ellipsis: this.symbols["format.ellipsis"],
			bullet: this.symbols["format.bullet"],
			dash: this.symbols["format.dash"],
			bracketLeft: this.symbols["format.bracketLeft"],
			bracketRight: this.symbols["format.bracketRight"],
		};
	}

	get md() {
		return {
			quoteBorder: this.symbols["md.quoteBorder"],
			hrChar: this.symbols["md.hrChar"],
			bullet: this.symbols["md.bullet"],
		};
	}

	/**
	 * Get spinner frames as an array (stored as comma-separated string in symbols).
	 */
	get spinnerFrames(): string[] {
		return this.symbols["spinner.frames"].split(",");
	}

	/**
	 * Get language icon for a language name.
	 * Maps common language names to their corresponding symbol keys.
	 */
	getLangIcon(lang: string | undefined): string {
		if (!lang) return this.symbols["lang.default"];
		const normalized = lang.toLowerCase();
		const key = langMap[normalized];
		return key ? this.symbols[key] : this.symbols["lang.default"];
	}
}

// ============================================================================
// Theme Loading
// ============================================================================

const BUILTIN_THEMES: Record<string, ThemeJson> = {
	dark: darkThemeJson as ThemeJson,
	light: lightThemeJson as ThemeJson,
	...(defaultThemes as Record<string, ThemeJson>),
};

function getBuiltinThemes(): Record<string, ThemeJson> {
	return BUILTIN_THEMES;
}

export function getAvailableThemes(): string[] {
	const themes = new Set<string>(Object.keys(getBuiltinThemes()));
	const customThemesDir = getCustomThemesDir();
	if (fs.existsSync(customThemesDir)) {
		const files = fs.readdirSync(customThemesDir);
		for (const file of files) {
			if (file.endsWith(".json")) {
				themes.add(file.slice(0, -5));
			}
		}
	}
	return Array.from(themes).sort();
}

function loadThemeJson(name: string): ThemeJson {
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const customThemesDir = getCustomThemesDir();
	const themePath = path.join(customThemesDir, `${name}.json`);
	if (!fs.existsSync(themePath)) {
		throw new Error(`Theme not found: ${name}`);
	}
	const content = fs.readFileSync(themePath, "utf-8");
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse theme ${name}: ${error}`);
	}
	if (!validateThemeJson.Check(json)) {
		const errors = Array.from(validateThemeJson.Errors(json));
		const missingColors: string[] = [];
		const otherErrors: string[] = [];

		for (const e of errors) {
			// Check for missing required color properties
			const match = e.path.match(/^\/colors\/(\w+)$/);
			if (match && e.message.includes("Required")) {
				missingColors.push(match[1]);
			} else {
				otherErrors.push(`  - ${e.path}: ${e.message}`);
			}
		}

		let errorMessage = `Invalid theme "${name}":\n`;
		if (missingColors.length > 0) {
			errorMessage += `\nMissing required color tokens:\n`;
			errorMessage += missingColors.map((c) => `  - ${c}`).join("\n");
			errorMessage += `\n\nPlease add these colors to your theme's "colors" object.`;
			errorMessage += `\nSee the built-in themes (dark.json, light.json) for reference values.`;
		}
		if (otherErrors.length > 0) {
			errorMessage += `\n\nOther errors:\n${otherErrors.join("\n")}`;
		}

		throw new Error(errorMessage);
	}
	return json as ThemeJson;
}

function createTheme(themeJson: ThemeJson, mode?: ColorMode, symbolPresetOverride?: SymbolPreset): Theme {
	const colorMode = mode ?? detectColorMode();
	const resolvedColors = resolveThemeColors(themeJson.colors, themeJson.vars);
	const fgColors: Record<ThemeColor, string | number> = {} as Record<ThemeColor, string | number>;
	const bgColors: Record<ThemeBg, string | number> = {} as Record<ThemeBg, string | number>;
	const bgColorKeys: Set<string> = new Set([
		"selectedBg",
		"userMessageBg",
		"customMessageBg",
		"toolPendingBg",
		"toolSuccessBg",
		"toolErrorBg",
		"statusLineBg",
	]);
	for (const [key, value] of Object.entries(resolvedColors)) {
		if (bgColorKeys.has(key)) {
			bgColors[key as ThemeBg] = value;
		} else {
			fgColors[key as ThemeColor] = value;
		}
	}
	// Extract symbol configuration - settings override takes precedence over theme
	const symbolPreset: SymbolPreset = symbolPresetOverride ?? themeJson.symbols?.preset ?? "unicode";
	const symbolOverrides = themeJson.symbols?.overrides ?? {};
	return new Theme(fgColors, bgColors, colorMode, symbolPreset, symbolOverrides);
}

function loadTheme(name: string, mode?: ColorMode, symbolPresetOverride?: SymbolPreset): Theme {
	const themeJson = loadThemeJson(name);
	return createTheme(themeJson, mode, symbolPresetOverride);
}

function detectTerminalBackground(): "dark" | "light" {
	const colorfgbg = process.env.COLORFGBG || "";
	if (colorfgbg) {
		const parts = colorfgbg.split(";");
		if (parts.length >= 2) {
			const bg = parseInt(parts[1], 10);
			if (!Number.isNaN(bg)) {
				const result = bg < 8 ? "dark" : "light";
				return result;
			}
		}
	}
	return "dark";
}

function getDefaultTheme(): string {
	return detectTerminalBackground();
}

// ============================================================================
// Global Theme Instance
// ============================================================================

export let theme: Theme;
let currentThemeName: string | undefined;
let currentSymbolPresetOverride: SymbolPreset | undefined;
let themeWatcher: fs.FSWatcher | undefined;
let onThemeChangeCallback: (() => void) | undefined;

export function initTheme(themeName?: string, enableWatcher: boolean = false, symbolPreset?: SymbolPreset): void {
	const name = themeName ?? getDefaultTheme();
	currentThemeName = name;
	currentSymbolPresetOverride = symbolPreset;
	try {
		theme = loadTheme(name, undefined, symbolPreset);
		if (enableWatcher) {
			startThemeWatcher();
		}
	} catch (err) {
		logger.debug("Theme loading failed, falling back to dark theme", { error: String(err) });
		currentThemeName = "dark";
		theme = loadTheme("dark", undefined, symbolPreset);
		// Don't start watcher for fallback theme
	}
}

export function setTheme(name: string, enableWatcher: boolean = false): { success: boolean; error?: string } {
	currentThemeName = name;
	try {
		theme = loadTheme(name, undefined, currentSymbolPresetOverride);
		if (enableWatcher) {
			startThemeWatcher();
		}
		if (onThemeChangeCallback) {
			onThemeChangeCallback();
		}
		return { success: true };
	} catch (error) {
		// Theme is invalid - fall back to dark theme
		currentThemeName = "dark";
		theme = loadTheme("dark", undefined, currentSymbolPresetOverride);
		// Don't start watcher for fallback theme
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Set the symbol preset override, recreating the theme with the new preset.
 */
export function setSymbolPreset(preset: SymbolPreset): void {
	currentSymbolPresetOverride = preset;
	if (currentThemeName) {
		try {
			theme = loadTheme(currentThemeName, undefined, preset);
		} catch {
			// Fall back to dark theme with new preset
			theme = loadTheme("dark", undefined, preset);
		}
		if (onThemeChangeCallback) {
			onThemeChangeCallback();
		}
	}
}

/**
 * Get the current symbol preset override.
 */
export function getSymbolPresetOverride(): SymbolPreset | undefined {
	return currentSymbolPresetOverride;
}

export function onThemeChange(callback: () => void): void {
	onThemeChangeCallback = callback;
}

/**
 * Get available symbol presets.
 */
export function getAvailableSymbolPresets(): SymbolPreset[] {
	return ["unicode", "nerd", "ascii"];
}

/**
 * Check if a string is a valid symbol preset.
 */
export function isValidSymbolPreset(preset: string): preset is SymbolPreset {
	return preset === "unicode" || preset === "nerd" || preset === "ascii";
}

function startThemeWatcher(): void {
	// Stop existing watcher if any
	if (themeWatcher) {
		themeWatcher.close();
		themeWatcher = undefined;
	}

	// Only watch if it's a custom theme (not built-in)
	if (!currentThemeName || currentThemeName === "dark" || currentThemeName === "light") {
		return;
	}

	const customThemesDir = getCustomThemesDir();
	const themeFile = path.join(customThemesDir, `${currentThemeName}.json`);

	// Only watch if the file exists
	if (!fs.existsSync(themeFile)) {
		return;
	}

	try {
		themeWatcher = fs.watch(themeFile, (eventType) => {
			if (eventType === "change") {
				// Debounce rapid changes
				setTimeout(() => {
					try {
						// Reload the theme with current symbol preset override
						theme = loadTheme(currentThemeName!, undefined, currentSymbolPresetOverride);
						// Notify callback (to invalidate UI)
						if (onThemeChangeCallback) {
							onThemeChangeCallback();
						}
					} catch (err) {
						logger.debug("Theme reload error during file change", { error: String(err) });
					}
				}, 100);
			} else if (eventType === "rename") {
				// File was deleted or renamed - fall back to default theme
				setTimeout(() => {
					if (!fs.existsSync(themeFile)) {
						currentThemeName = "dark";
						theme = loadTheme("dark");
						if (themeWatcher) {
							themeWatcher.close();
							themeWatcher = undefined;
						}
						if (onThemeChangeCallback) {
							onThemeChangeCallback();
						}
					}
				}, 100);
			}
		});
	} catch (err) {
		logger.debug("Failed to start theme watcher", { error: String(err) });
	}
}

export function stopThemeWatcher(): void {
	if (themeWatcher) {
		themeWatcher.close();
		themeWatcher = undefined;
	}
}

// ============================================================================
// HTML Export Helpers
// ============================================================================

/**
 * Convert a 256-color index to hex string.
 * Indices 0-15: basic colors (approximate)
 * Indices 16-231: 6x6x6 color cube
 * Indices 232-255: grayscale ramp
 */
function ansi256ToHex(index: number): string {
	// Basic colors (0-15) - approximate common terminal values
	const basicColors = [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	];
	if (index < 16) {
		return basicColors[index];
	}

	// Color cube (16-231): 6x6x6 = 216 colors
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toHex = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// Grayscale (232-255): 24 shades
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * Get resolved theme colors as CSS-compatible hex strings.
 * Used by HTML export to generate CSS custom properties.
 */
export function getResolvedThemeColors(themeName?: string): Record<string, string> {
	const name = themeName ?? getDefaultTheme();
	const isLight = name === "light";
	const themeJson = loadThemeJson(name);
	const resolved = resolveThemeColors(themeJson.colors, themeJson.vars);

	// Default text color for empty values (terminal uses default fg color)
	const defaultText = isLight ? "#000000" : "#e5e5e7";

	const cssColors: Record<string, string> = {};
	for (const [key, value] of Object.entries(resolved)) {
		if (typeof value === "number") {
			cssColors[key] = ansi256ToHex(value);
		} else if (value === "") {
			// Empty means default terminal color - use sensible fallback for HTML
			cssColors[key] = defaultText;
		} else {
			cssColors[key] = value;
		}
	}
	return cssColors;
}

/**
 * Check if a theme is a "light" theme (for CSS that needs light/dark variants).
 */
export function isLightTheme(themeName?: string): boolean {
	// Currently just check the name - could be extended to analyze colors
	return themeName === "light";
}

/**
 * Get explicit export colors from theme JSON, if specified.
 * Returns undefined for each color that isn't explicitly set.
 */
export function getThemeExportColors(themeName?: string): {
	pageBg?: string;
	cardBg?: string;
	infoBg?: string;
} {
	const name = themeName ?? getDefaultTheme();
	try {
		const themeJson = loadThemeJson(name);
		const exportSection = themeJson.export;
		if (!exportSection) return {};

		const vars = themeJson.vars ?? {};
		const resolve = (value: string | number | undefined): string | undefined => {
			if (value === undefined) return undefined;
			if (typeof value === "number") return ansi256ToHex(value);
			if (value.startsWith("$")) {
				const resolved = vars[value];
				if (resolved === undefined) return undefined;
				if (typeof resolved === "number") return ansi256ToHex(resolved);
				return resolved;
			}
			return value;
		};

		return {
			pageBg: resolve(exportSection.pageBg),
			cardBg: resolve(exportSection.cardBg),
			infoBg: resolve(exportSection.infoBg),
		};
	} catch {
		return {};
	}
}

// ============================================================================
// TUI Helpers
// ============================================================================

type CliHighlightTheme = Record<string, (s: string) => string>;

let cachedHighlightThemeFor: Theme | undefined;
let cachedCliHighlightTheme: CliHighlightTheme | undefined;

function buildCliHighlightTheme(t: Theme): CliHighlightTheme {
	return {
		keyword: (s: string) => t.fg("syntaxKeyword", s),
		built_in: (s: string) => t.fg("syntaxType", s),
		literal: (s: string) => t.fg("syntaxNumber", s),
		number: (s: string) => t.fg("syntaxNumber", s),
		string: (s: string) => t.fg("syntaxString", s),
		comment: (s: string) => t.fg("syntaxComment", s),
		function: (s: string) => t.fg("syntaxFunction", s),
		title: (s: string) => t.fg("syntaxFunction", s),
		class: (s: string) => t.fg("syntaxType", s),
		type: (s: string) => t.fg("syntaxType", s),
		attr: (s: string) => t.fg("syntaxVariable", s),
		variable: (s: string) => t.fg("syntaxVariable", s),
		params: (s: string) => t.fg("syntaxVariable", s),
		operator: (s: string) => t.fg("syntaxOperator", s),
		punctuation: (s: string) => t.fg("syntaxPunctuation", s),
	};
}

function getCliHighlightTheme(t: Theme): CliHighlightTheme {
	if (cachedHighlightThemeFor !== t || !cachedCliHighlightTheme) {
		cachedHighlightThemeFor = t;
		cachedCliHighlightTheme = buildCliHighlightTheme(t);
	}
	return cachedCliHighlightTheme;
}

/**
 * Highlight code with syntax coloring based on file extension or language.
 * Returns array of highlighted lines.
 */
export function highlightCode(code: string, lang?: string): string[] {
	// Validate language before highlighting to avoid stderr spam from cli-highlight
	const validLang = lang && supportsLanguage(lang) ? lang : undefined;
	const opts = {
		language: validLang,
		ignoreIllegals: true,
		theme: getCliHighlightTheme(theme),
	};
	try {
		return highlight(code, opts).split("\n");
	} catch {
		return code.split("\n");
	}
}

/**
 * Get language identifier from file path extension.
 */
export function getLanguageFromPath(filePath: string): string | undefined {
	const baseName = path.basename(filePath).toLowerCase();
	if (baseName === ".env" || baseName.startsWith(".env.")) return "env";
	if (
		baseName === ".gitignore" ||
		baseName === ".gitattributes" ||
		baseName === ".gitmodules" ||
		baseName === ".editorconfig" ||
		baseName === ".npmrc" ||
		baseName === ".prettierrc" ||
		baseName === ".eslintrc"
	) {
		return "conf";
	}

	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;

	const extToLang: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		fish: "fish",
		ps1: "powershell",
		sql: "sql",
		html: "html",
		htm: "html",
		css: "css",
		scss: "scss",
		sass: "sass",
		less: "less",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		xml: "xml",
		md: "markdown",
		markdown: "markdown",
		dockerfile: "dockerfile",
		makefile: "makefile",
		cmake: "cmake",
		lua: "lua",
		perl: "perl",
		r: "r",
		scala: "scala",
		clj: "clojure",
		ex: "elixir",
		exs: "elixir",
		erl: "erlang",
		hs: "haskell",
		ml: "ocaml",
		vim: "vim",
		graphql: "graphql",
		proto: "protobuf",
		tf: "hcl",
		hcl: "hcl",
		txt: "text",
		text: "text",
		log: "log",
		csv: "csv",
		tsv: "tsv",
		ini: "ini",
		cfg: "conf",
		conf: "conf",
		config: "conf",
		properties: "conf",
		env: "env",
	};

	return extToLang[ext];
}

export function getSymbolTheme(): SymbolTheme {
	const preset = theme.getSymbolPreset();
	const spinnerFrames =
		preset === "ascii" ? ["-", "\\", "|", "/"] : ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

	return {
		cursor: theme.nav.cursor,
		inputCursor: preset === "ascii" ? "|" : "▏",
		ellipsis: theme.format.ellipsis,
		boxRound: theme.boxRound,
		boxSharp: theme.boxSharp,
		table: theme.boxSharp,
		quoteBorder: theme.md.quoteBorder,
		hrChar: theme.md.hrChar,
		spinnerFrames,
	};
}

export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => chalk.strikethrough(text),
		symbols: getSymbolTheme(),
		highlightCode: (code: string, lang?: string): string[] => {
			// Validate language before highlighting to avoid stderr spam from cli-highlight
			const validLang = lang && supportsLanguage(lang) ? lang : undefined;
			const opts = {
				language: validLang,
				ignoreIllegals: true,
				theme: getCliHighlightTheme(theme),
			};
			try {
				return highlight(code, opts).split("\n");
			} catch {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
		},
	};
}

export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
		symbols: getSymbolTheme(),
	};
}

export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
		symbols: getSymbolTheme(),
	};
}

export function getSettingsListTheme(): import("@oh-my-pi/pi-tui").SettingsListTheme {
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", `${theme.nav.cursor} `),
		hint: (text: string) => theme.fg("dim", text),
	};
}
