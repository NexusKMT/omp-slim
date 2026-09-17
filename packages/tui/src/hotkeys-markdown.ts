import {
	type AppKeybinding,
	formatKeyHints,
	type KeybindingsManager,
	keyHintPlatform,
	modifierLabel,
} from "./app-keybindings";
import { canonicalKeyId } from "./keybindings";

/** Effective keybinding operations used to render the hotkey reference. */
export interface HotkeysMarkdownBindings {
	keybindings: Pick<KeybindingsManager, "getDisplayString" | "getKeys" | "matchesCanonical">;
}

function appKeyHint(bindings: HotkeysMarkdownBindings, action: AppKeybinding): string {
	return bindings.keybindings.getDisplayString(action) || "Disabled";
}

/** Build the platform-aware Markdown reference for effective application hotkeys. */
export function buildHotkeysMarkdown(bindings: HotkeysMarkdownBindings): string {
	const platform = keyHintPlatform();
	const isMac = platform === "darwin";
	const alt = modifierLabel("alt", platform);
	const cmd = modifierLabel("super", platform);
	// CustomEditor tests the chord that was actually pressed, so exit keys split by role: a key
	// that also carries tui.editor.deleteCharForward (the readline `^D` overlap) forward-deletes
	// while the prompt holds a draft, any other exit key quits immediately. Mixed bindings such as
	// `["ctrl+d", "ctrl+q"]` therefore get one row per behavior instead of a single row claiming
	// both keys delete.
	const exitKeys = bindings.keybindings.getKeys("app.exit");
	const deletingExitKeys = exitKeys.filter(key =>
		bindings.keybindings.matchesCanonical(canonicalKeyId(key), "tui.editor.deleteCharForward"),
	);
	const quittingExitKeys = exitKeys.filter(
		key => !bindings.keybindings.matchesCanonical(canonicalKeyId(key), "tui.editor.deleteCharForward"),
	);
	const exitRows: string[] = [];
	if (deletingExitKeys.length > 0) {
		exitRows.push(
			`| \`${formatKeyHints(deletingExitKeys)}\` | Delete char forward (with draft) / exit (empty prompt) |`,
		);
	}
	// An unbound exit action still gets its row, mirroring the `Disabled` hint every other row uses.
	if (quittingExitKeys.length > 0 || deletingExitKeys.length === 0) {
		exitRows.push(`| \`${formatKeyHints(quittingExitKeys) || "Disabled"}\` | Exit |`);
	}
	return [
		"**Navigation**",
		"| Key | Action |",
		"|-----|--------|",
		"| `Arrow keys` | Move cursor / browse history (Up when empty) |",
		`| \`${alt}+Left/Right\` | Move by word |`,
		isMac ? `| \`Ctrl+A\` / \`Home\` / \`${cmd}+Left\` | Start of line |` : "| `Ctrl+A` / `Home` | Start of line |",
		isMac ? `| \`Ctrl+E\` / \`End\` / \`${cmd}+Right\` | End of line |` : "| `Ctrl+E` / `End` | End of line |",
		"",
		"**Editing**",
		"| Key | Action |",
		"|-----|--------|",
		"| `Enter` | Send message |",
		`| \`Shift+Enter\` / \`${alt}+Enter\` | New line |`,
		`| \`Ctrl+W\` / \`${alt}+Backspace\` | Delete word backwards |`,
		"| `Ctrl+U` | Delete to start of line |",
		"| `Ctrl+K` | Delete to end of line |",
		`| \`${appKeyHint(bindings, "app.clipboard.copyLine")}\` | Copy current line |`,
		`| \`${appKeyHint(bindings, "app.clipboard.copyPrompt")}\` | Copy whole prompt |`,
		"",
		"**Other**",
		"| Key | Action |",
		"|-----|--------|",
		"| `Tab` | Path completion / accept autocomplete |",
		`| \`${appKeyHint(bindings, "app.interrupt")}\` | Cancel autocomplete / interrupt active work |`,
		`| \`${appKeyHint(bindings, "app.clear")}\` | Clear editor (first) / exit (second) |`,
		...exitRows,
		`| \`${appKeyHint(bindings, "app.suspend")}\` | Suspend to background |`,
		`| \`${appKeyHint(bindings, "app.display.reset")}\` | Reset terminal display |`,
		`| \`${appKeyHint(bindings, "app.thinking.cycle")}\` | Cycle thinking level |`,
		`| \`${appKeyHint(bindings, "app.model.cycleForward")}\` | Cycle role models (slow/default/smol) |`,
		`| \`${appKeyHint(bindings, "app.model.cycleBackward")}\` | Cycle role models (backward) |`,
		`| \`${appKeyHint(bindings, "app.model.selectTemporary")}\` | Select model (temporary) |`,
		`| \`${appKeyHint(bindings, "app.model.select")}\` | Select model (set roles) |`,
		`| \`${appKeyHint(bindings, "app.plan.toggle")}\` | Toggle plan mode |`,
		`| \`${appKeyHint(bindings, "app.history.search")}\` | Search prompt history |`,
		`| \`${appKeyHint(bindings, "app.tools.expand")}\` | Toggle tool output expansion |`,
		`| \`${appKeyHint(bindings, "app.tools.toggleVisibility")}\` | Toggle tool activity visibility |`,
		`| \`${appKeyHint(bindings, "app.thinking.toggle")}\` | Toggle thinking block visibility |`,
		`| \`${appKeyHint(bindings, "app.editor.external")}\` | Edit message in external editor |`,
		`| \`${appKeyHint(bindings, "app.retry")}\` | Retry last failed assistant turn |`,
		`| \`${appKeyHint(bindings, "app.clipboard.pasteImage")}\` | Paste image or text from clipboard |`,
		"| Hold `Space` | Speech-to-text (push-to-talk): hold to record, release to transcribe |",
		`| \`${appKeyHint(bindings, "app.live.toggle")}\` | Start/stop live voice mode (/live) |`,
		`| \`${appKeyHint(bindings, "app.agents.hub")}\` / \`${appKeyHint(bindings, "app.session.observe")}\` / double-tap \`←\` (empty editor) | Open the agent hub |`,
		"| `#<number>` | GitHub issue/PR reference (e.g. `#3164` → `pr://`/`issue://`) |",
		"| `#` / `#<text>` | Prompt actions (copy / undo / move cursor) |",
		"| `/` | Slash commands |",
		"| `!` | Run bash command |",
		"| `!!` | Run bash command (excluded from context) |",
		"| `$` | Run Python in shared kernel |",
		"| `$$` | Run Python (excluded from context) |",
	].join("\n");
}
