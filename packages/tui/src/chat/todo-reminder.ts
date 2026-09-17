import { Box } from "../components/box";
import { Container } from "../tui";
import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import { theme } from "../theme";
import type { TodoItem } from "../tools/todo";

/**
 * Component that renders a todo completion reminder notification, committed into
 * the transcript like a TTSR notification so it stays anchored in history rather
 * than floating above the editor.
 * Shows when the agent stops with incomplete todos.
 */
export class TodoReminderComponent extends Container {
	#box: Box;
	#toolActivityVisible = true;

	readonly #todos: TodoItem[];
	readonly #attempt: number;
	readonly #maxAttempts: number;

	constructor(todos: TodoItem[], attempt: number, maxAttempts: number) {
		super();
		this.#todos = todos;
		this.#attempt = attempt;
		this.#maxAttempts = maxAttempts;

		this.addChild(new Spacer(1));

		this.#box = new Box(1, 1, t => theme.inverse(theme.fg("warning", t)));
		this.#box.setIgnoreTight(true);
		this.addChild(this.#box);

		this.#rebuild();
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		this.invalidate();
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible) return [];
		return super.render(width);
	}

	#rebuild(): void {
		this.#box.clear();

		const count = this.#todos.length;
		const label = count === 1 ? "todo" : "todos";
		const header = `${theme.icon.warning} ${count} incomplete ${label} - reminder ${this.#attempt}/${this.#maxAttempts}`;

		this.#box.addChild(new Text(header, 0, 0));
		this.#box.addChild(new Spacer(1));

		const todoList = this.#todos.map(todo => `  ${theme.checkbox.unchecked} ${todo.content}`).join("\n");
		this.#box.addChild(new Text(theme.italic(todoList), 0, 0));
	}
}
