/**
 * Model-picked charts for multi-series assistant tables (`tui.autoGraph:
 * smart`). {@link judgeRequest} asks the judge role what only meaning can
 * decide — the chart kind, which columns to plot and which name the rows, how
 * rows group, order and compare (shading, reference row, ranking), which way
 * each measure is better, what competes, the focus row, and which computed
 * takeaway titles the chart — and {@link planFromAnswers} turns the answers
 * into a {@link ChartPlan}, each answer only above its confidence gate and the
 * TUI's local guess everywhere else. An on-device judge only picks the kind
 * (keyword answers), keeping the rest of the guess.
 */
import type { Answer, ChoiceQuestion, JudgmentState, Questions } from "@oh-my-pi/pi-ai";
import {
	type ChartKind,
	type ChartPlan,
	dotsFit,
	guessMeaning,
	guessNaming,
	guessShading,
	isConditionPair,
	leadingMeasures,
	namingColumns,
	outcomeColumns,
	type Polarity,
	proseLed,
	type Rivals,
	type RowOrder,
	rangeColumns,
	rowsAreMetrics,
	type Shading,
	tableTakeaways,
} from "@oh-my-pi/pi-tui/charts/chart-plan";
import { isMonotonic, isNumber, type TableAnalysis, type TableColumn } from "@oh-my-pi/pi-tui/charts/table-data";
import type { TableChartRequest } from "@oh-my-pi/pi-tui/chat/table-chart";
import { prompt } from "@oh-my-pi/pi-utils";
import type { ChainJudge } from "../judgment";
import columnQuestionTemplate from "../prompts/system/auto-graph-column-question.md" with { type: "text" };
import focusQuestionInstructions from "../prompts/system/auto-graph-focus-question.md" with { type: "text" };
import groupQuestionTemplate from "../prompts/system/auto-graph-group-question.md" with { type: "text" };
import kindQuestionInstructions from "../prompts/system/auto-graph-kind-question.md" with { type: "text" };
import labelQuestionInstructions from "../prompts/system/auto-graph-label-question.md" with { type: "text" };
import nameQuestionTemplate from "../prompts/system/auto-graph-name-question.md" with { type: "text" };
import orderQuestionTemplate from "../prompts/system/auto-graph-order-question.md" with { type: "text" };
import pairQuestionTemplate from "../prompts/system/auto-graph-pair-question.md" with { type: "text" };
import polarityQuestionTemplate from "../prompts/system/auto-graph-polarity-question.md" with { type: "text" };
import referenceQuestionTemplate from "../prompts/system/auto-graph-reference-question.md" with { type: "text" };
import rivalsQuestionInstructions from "../prompts/system/auto-graph-rivals-question.md" with { type: "text" };
import rowPolarityQuestionTemplate from "../prompts/system/auto-graph-row-polarity-question.md" with { type: "text" };
import shadingQuestionInstructions from "../prompts/system/auto-graph-shading-question.md" with { type: "text" };
import titleQuestionInstructions from "../prompts/system/auto-graph-title-question.md" with { type: "text" };
import transposeQuestionInstructions from "../prompts/system/auto-graph-transpose-question.md" with { type: "text" };

/** A pick slower than this gives way to the local guess, so the answer's chart never waits on a stuck judge. */
const PICK_TIMEOUT_MS = 15_000;

/**
 * The judge's chart for `request`, or `null` when it sees none.
 * @throws when no judge candidate answers (the caller falls back to the guess).
 */
export async function pickTableChart(request: TableChartRequest, judge: ChainJudge): Promise<ChartPlan | null> {
	const options = { signal: AbortSignal.timeout(PICK_TIMEOUT_MS) };
	return judge.withCandidate(async (candidate, kind) => {
		const { state, questions } = judgeRequest(request);
		if (kind === "local") {
			// Keyword answers only carry the kind; the rest of the guess stands.
			const { answers } = await candidate.judge({ state, questions: { kind: kindQuestion(request) } }, options);
			const choice = answers.kind.choice;
			if (!isOption(KIND_CRITERIA, choice)) return request.guess;
			return choice === "none" ? null : { ...request.guess, kind: choice };
		}
		const { answers } = await candidate.judge({ state, questions }, options);
		return planFromAnswers(request, answers);
	}, options);
}

/** The kind question for `request`: every kind its data can draw ({@link kindCriteria}), and `none`. */
function kindQuestion({ table, guess }: TableChartRequest): ChoiceQuestion {
	const candidates = table.measures.filter(column => column.index !== guess.label);
	return {
		type: "choice",
		instructions: prompt.render(kindQuestionInstructions),
		criteria: kindCriteria(table, guess, candidates),
	};
}

/** Whether `value` is one of `criteria`'s option labels. */
function isOption<L extends string>(criteria: Record<L, unknown>, value: string): value is L {
	return Object.hasOwn(criteria, value);
}

type KindChoice = ChartKind | "none";
const KIND_CRITERIA: Record<KindChoice, string> = {
	bar: "One numeric measure compared across categories.",
	paired:
		"One quantity under two conditions per category, drawn as a dumbbell: before/after, baseline vs. variant, old vs. new.",
	grouped:
		"Two to four same-unit measures per category, side by side, that are different quantities, not one before/after.",
	stacked:
		"Columns that are parts of one whole per category (cached + uncached tokens, error/warn/info counts), as one segmented bar each.",
	line: "Values over an ordered axis: time, runs, versions, sizes, steps.",
	heatmap: "A matrix of same-unit values where the pattern across rows and columns matters.",
	multiples: "Measures in different units, or rows that are different metrics, each needing its own scale.",
	share: "Parts of one whole: shares summing to 100% or to a total.",
	diverging: "Signed changes or deltas around zero.",
	scatter: "Two continuous measures per item, looking for a relationship.",
	change:
		"Before/after (or baseline vs. variants) values of metrics in different units, compared as factors: 48× less time, +27% icons.",
	progress: "Scores out of a total (12/12, 154/160) or completion rates, as bars filling toward 100%.",
	timeline:
		"Rows laid end to end on one axis: durations of a run's consecutive steps, or parts at their offsets (a buffer layout).",
	waterfall: "Amounts of one unit building up row by row to their total or toward a cap: where a sum comes from.",
	dots: "Three to six same-unit series per category as colored dots on one shared axis (log when values span decades): prices per tier, timings per config.",
	range: "Values written as low–high ranges (5.7–9.6 ms, $4.4k–6.1k), as floating intervals; an estimate column inside them marks each.",
	none: "Identifiers, settings, or too few comparable values: a chart adds nothing.",
};
const SHADING_CRITERIA: Record<Shading, string> = {
	shared: "Every cell is the same measure on a similar scale; any two cells compare.",
	series: "The columns are different quantities; compare within each column.",
	row: "The columns are one measure under different conditions and the rows differ widely in size; compare each row.",
};
type OrderChoice = "table" | RowOrder["direction"];
const ORDER_CRITERIA: Record<OrderChoice, string> = {
	table: "Keep the table's row order: it is deliberate or already ranked.",
	descending: "Rank independent items largest first.",
	ascending: "Rank independent items smallest first: smaller is better.",
};
/**
 * Probability a shading pick needs to override the local guess: a hesitant
 * `series` would trade a heatmap of one measure for bars (t055 scores at 0.66).
 */
const SHADING_CONFIDENCE = 0.7;
/** Fewest same-unit columns that can draw as a heatmap, whose shading the judge then picks. */
const MIN_HEAT_COLUMNS = 4;
/** Fewest rows a ranking can reorder usefully. */
const MIN_RANKED_ROWS = 4;
/** Probability a ranking needs to override the table's order: a coin flip keeps the order the author chose. */
const RANK_CONFIDENCE = 0.6;
/** Probability the judge's reference pick (or `none`) needs to override the local guess. */
const REFERENCE_CONFIDENCE = 0.8;
/** Most distinct naming values offered as reference rows. */
const MAX_REFERENCE_CHOICES = 8;
/** Longest naming value offered as a reference row; longer cells describe rather than name. */
const MAX_REFERENCE_CHARS = 48;
/** Kinds that keep a row order of their own (an x axis, factors in table order, parts of a whole). */
const OWN_FRAME: ReadonlySet<KindChoice> = new Set(["line", "scatter", "change", "stacked", "timeline", "waterfall"]);
/**
 * Kinds that lay rows out as one run of steps, from one column: offered to the
 * judge only where the local guess found one ({@link KIND_GATES}).
 */
const FLOWS: ReadonlySet<KindChoice> = new Set(["timeline", "waterfall"]);
/** Guessed kinds whose chart draws reference rules: bars, and grids of bars (a series-shaded heatmap becomes one). */
const REFERENCED: ReadonlySet<ChartKind> = new Set(["bar", "multiples", "heatmap"]);
const MAX_TABLE_CHARS = 4000;
/** Most questions one table is asked; earlier groups' questions come first, semantics' fill the rest ({@link SEMANTIC_PRIORITY}). */
const MAX_QUESTIONS = 25;
type PolarityChoice = Polarity | "neutral";
const POLARITY_CRITERIA: Record<PolarityChoice, string> = {
	higher: "A larger value is better.",
	lower: "A smaller value is better.",
	neutral: "Neither: it describes, counts or identifies.",
};
type RivalsChoice = Rivals | "neither";
const RIVALS_CRITERIA: Record<RivalsChoice, string> = {
	rows: "The rows are alternatives: mark the best row of each column.",
	columns: "The numeric columns are alternatives: mark the best column of each row.",
	neither: "Parts, steps, files, categories, a before/after, or items described rather than ranked.",
};
/** The choice meaning no row is the focus, or no takeaway titles the chart. */
const NONE = "none";
/** Both readings of what competes: the title candidates include either's outcome, whatever the judge answers on rivals. */
const CONTESTS: readonly Rivals[] = ["rows", "columns"];
/** Most measures asked for their polarity (the guess's series first, then other candidates); later ones keep the header-keyword guess. */
const MAX_POLARITY_QUESTIONS = 6;
/** Most metric rows asked for their polarity; larger tables keep the local guess. */
const MAX_ROW_POLARITY = 8;
/** Most rows offered as the table's focus. */
const MAX_FOCUS_ROWS = 12;
/** Fewest rows for which a focus or a contest changes the chart. */
const MIN_CONTEST_ROWS = 3;
/** Judge confidence at which its polarity for a measure overrides the header-keyword guess. */
const SURE_POLARITY = 0.7;
/** Judge confidence at which its reading of what competes overrides the label-header guess. */
const SURE_RIVALS = 0.7;
/** Judge confidence at which its focus row stands on its own; below it the table must also single the row out. */
const SURE_FOCUS = 0.75;
/** Judge confidence at which its focus row counts when the table singles it out too (bold, `(current)`). */
const AGREED_FOCUS = 0.4;
/** Judge confidence at which its title pick (a striking fact, or none) overrides the local guess's. */
const SURE_TITLE = 0.4;
/** Judge confidence a plain fact (a top value, a share) needs to title a chart: it mostly restates the marks. */
const SURE_PLAIN_TITLE = 0.75;
/**
 * Order in which semantics' questions fill what {@link MAX_QUESTIONS} leaves:
 * the title (most visible), what competes (gates every best mark), the
 * plotted measures' polarity (best marks and tones), the focus row, and the
 * metric rows' polarity (factor tones the units mostly decide already).
 */
const SEMANTIC_PRIORITY = ["title", "rivals", "p", "focus", "q"] as const;
/** Kinds a table of parts summing to a whole draws better as stacked bars. */
const STACKABLE: ReadonlySet<KindChoice> = new Set([
	"bar",
	"grouped",
	"paired",
	"heatmap",
	"multiples",
	"share",
	"stacked",
]);
/** Dimensions whose columns may be parts of one whole: amounts, not rates, ratios or scores. */
const ADDITIVE: ReadonlySet<string> = new Set(["count", "percent", "duration", "bytes", "currency"]);
/** A column naming a whole or an average rather than a part (`Prose total`, `Mean`). */
const WHOLE_HEADER = /\b(?:total|all|sum|overall|avg|average|mean)\b/i;

/**
 * The picked columns a judge's `stacked` pick may stack without a composition
 * the values show: non-negative amounts in the first such column's unit,
 * totals and averages left out.
 */
function stackable(table: TableAnalysis, series: readonly number[]): TableColumn[] {
	const amounts = series
		.map(index => table.columns[index]!)
		.filter(
			column =>
				column.dim !== undefined &&
				ADDITIVE.has(column.dim) &&
				!column.scores &&
				!WHOLE_HEADER.test(column.header) &&
				table.rows.every(row => {
					const cell = column.cells[row];
					return cell?.kind !== "number" || cell.value >= 0;
				}),
		);
	const first = amounts[0];
	return first ? amounts.filter(column => column.dim === first.dim && column.unit === first.unit) : [];
}

/**
 * Kinds the judge is offered only where the table's data can draw one: an option the data cannot draw
 * only sways the pick among the rest, and leaving it out keeps every other table's kind question
 * byte-identical (and cached).
 * - `timeline`, `waterfall`: the local guess found that run of steps ({@link FLOWS}).
 * - `range`: candidates hold mostly `a–b` intervals ({@link rangeColumns}).
 * - `dots`: three or more same-unit candidates fit a dot plot ({@link dotsFit}).
 */
const KIND_GATES: Partial<
	Record<KindChoice, (table: TableAnalysis, guess: ChartPlan, candidates: readonly TableColumn[]) => boolean>
> = {
	timeline: (_, guess) => guess.kind === "timeline",
	waterfall: (_, guess) => guess.kind === "waterfall",
	range: (table, _, candidates) => rangeColumns(candidates, table.rows) !== undefined,
	dots: (table, _, candidates) =>
		[
			...Map.groupBy(candidates, column =>
				column.dim === "currency" || column.dim === "rate" ? `${column.dim}:${column.unit}` : `${column.dim}`,
			).values(),
		].some(columns => dotsFit(columns, table.rows)),
};

/** The kind options for a table: every kind {@link KIND_GATES} lets through, in {@link KIND_CRITERIA} order. */
function kindCriteria(
	table: TableAnalysis,
	guess: ChartPlan,
	candidates: readonly TableColumn[],
): Record<string, string> {
	const offered: Record<string, string> = {};
	for (const kind in KIND_CRITERIA) {
		if (isOption(KIND_CRITERIA, kind) && (KIND_GATES[kind]?.(table, guess, candidates) ?? true))
			offered[kind] = KIND_CRITERIA[kind];
	}
	return offered;
}

/**
 * The first two same-unit candidates, which a dumbbell would pair, when only the
 * judge can tell whether they are one quantity under two conditions: none when
 * the values show a composition, the headers already name a pair, or metric
 * pairs (`Baseline Turns | Iter1 Turns | …`) decide the chart.
 */
function pairCandidates(
	table: TableAnalysis,
	guess: ChartPlan,
	candidates: readonly TableColumn[],
): [TableColumn, TableColumn] | undefined {
	if (table.composition?.exact || guess.baselines) return undefined;
	for (const [at, first] of candidates.entries()) {
		const second = candidates.slice(at + 1).find(column => column.dim === first.dim && column.unit === first.unit);
		if (!second || first.arrowShare >= 0.6 || second.arrowShare >= 0.6) continue;
		return isConditionPair(first.header, second.header) ? undefined : [first, second];
	}
	return undefined;
}

/**
 * The columns the label question offers, keyed by option name (the header, or
 * `column N` when blank or repeated): text and date columns, and measures
 * before the guessed label. Empty when there is no choice to make.
 */
function labelOptions(table: TableAnalysis, guess: ChartPlan): Map<string, TableColumn> {
	const columns = [
		...leadingMeasures(table, guess),
		...table.columns.filter(column => column.role === "label" || column.role === "temporal"),
	].sort((a, b) => a.index - b.index);
	const options = new Map<string, TableColumn>();
	if (columns.length < 2) return options;
	for (const column of columns) {
		const name = column.header && !options.has(column.header) ? column.header : `column ${column.index + 1}`;
		options.set(name, column);
	}
	return options;
}

/**
 * The judge request for `request`: the table and its column types as state,
 * and at most {@link MAX_QUESTIONS} questions keyed by id — each asked only
 * where its answer can change the chart.
 */
export function judgeRequest(request: TableChartRequest): { state: JudgmentState; questions: Questions } {
	const { table, guess } = request;
	const candidates = table.measures.filter(column => column.index !== guess.label);
	const label = guess.label === undefined ? undefined : table.columns[guess.label];
	const namers = label ? namingColumns(table, label) : [];
	const questions: Questions = {
		kind: kindQuestion(request),
		transpose: { type: "noul", instructions: prompt.render(transposeQuestionInstructions) },
	};
	if (heatCapable(table, guess, candidates))
		questions.shading = {
			type: "choice",
			instructions: prompt.render(shadingQuestionInstructions),
			criteria: SHADING_CRITERIA,
		};
	const lead = rankable(table, guess);
	if (lead)
		questions.order = {
			type: "choice",
			instructions: prompt.render(orderQuestionTemplate, { column: lead.header }),
			criteria: ORDER_CRITERIA,
		};
	const reference = referenceCandidates(table, guess);
	if (reference)
		questions.reference = {
			type: "choice",
			instructions: prompt.render(referenceQuestionTemplate, {
				column: reference.column.header,
				repeats: reference.repeats,
			}),
			criteria: Object.fromEntries([...reference.values, "none"].map(value => [value, null])),
		};
	const options = labelOptions(table, guess);
	if (options.size)
		questions.label = {
			type: "choice",
			instructions: prompt.render(labelQuestionInstructions),
			criteria: Object.fromEntries([...options.keys()].map(name => [name, null])),
		};
	const pair = pairCandidates(table, guess, candidates);
	if (pair)
		questions.pair = {
			type: "noul",
			instructions: prompt.render(pairQuestionTemplate, { first: pair[0].header, second: pair[1].header }),
		};
	for (const column of candidates)
		questions[`c${column.index}`] = {
			type: "noul",
			instructions: prompt.render(columnQuestionTemplate, { column: column.header }),
		};
	const groupers = label && namers.length ? [label, ...namers] : [];
	for (const column of namers)
		questions[`n${column.index}`] = {
			type: "noul",
			instructions: prompt.render(nameQuestionTemplate, { column: column.header, label: label?.header }),
		};
	for (const column of groupers)
		questions[`g${column.index}`] = {
			type: "noul",
			instructions: prompt.render(groupQuestionTemplate, { column: column.header }),
		};
	for (const [id, question] of semanticQuestions(request)) {
		if (Object.keys(questions).length >= MAX_QUESTIONS) break;
		questions[id] = question;
	}
	const state = {
		table: request.markdown.slice(0, MAX_TABLE_CHARS),
		columns: table.columns.map(column => ({ name: column.header, type: columnType(column) })),
	};
	return { state, questions };
}

/**
 * What the table means, as questions in {@link SEMANTIC_PRIORITY} order, each
 * asked only where its answer can change the chart: the title among the
 * table's {@link tableTakeaways}; what competes and the focus row with
 * {@link MIN_CONTEST_ROWS} rows or more; the polarity of the plotted
 * measures; the polarity of each metric row ({@link rowsAreMetrics}).
 */
function semanticQuestions({ table, guess }: TableChartRequest): [string, Questions[string]][] {
	const asked: [string, Questions[string]][] = [];
	const label = guess.label === undefined ? undefined : table.columns[guess.label];
	for (const kind of SEMANTIC_PRIORITY) {
		if (kind === "title") {
			const facts = tableTakeaways(table, guess, CONTESTS);
			if (facts.length === 0) continue;
			const criteria: Record<string, string | null> = {};
			for (const fact of facts) criteria[fact.key] = fact.text;
			criteria[NONE] = "No title: none of these is the table's point.";
			asked.push(["title", { type: "choice", instructions: prompt.render(titleQuestionInstructions), criteria }]);
		} else if (kind === "rivals") {
			if (table.rows.length < MIN_CONTEST_ROWS) continue;
			asked.push([
				"rivals",
				{ type: "choice", instructions: prompt.render(rivalsQuestionInstructions), criteria: RIVALS_CRITERIA },
			]);
		} else if (kind === "p") {
			// The columns the chart may plot: the guess's series first, then the other candidates the judge may pick.
			const plotted = [
				...guess.series.map(index => table.columns[index]!),
				...table.measures.filter(column => column.index !== guess.label && !guess.series.includes(column.index)),
			].filter(column => column.role === "measure");
			for (const column of plotted.slice(0, MAX_POLARITY_QUESTIONS))
				asked.push([
					`p${column.index}`,
					{
						type: "choice",
						instructions: prompt.render(polarityQuestionTemplate, { column: column.header }),
						criteria: POLARITY_CRITERIA,
					},
				]);
		} else if (kind === "focus") {
			const names = rowNames(table, guess);
			if (names.size < MIN_CONTEST_ROWS || names.size > MAX_FOCUS_ROWS) continue;
			const criteria: Record<string, string | null> = {};
			for (const name of names.keys()) criteria[name] = null;
			criteria[NONE] = "No single row stands out.";
			asked.push(["focus", { type: "choice", instructions: prompt.render(focusQuestionInstructions), criteria }]);
		} else if (label && rowsAreMetrics(table, guess) && table.rows.length <= MAX_ROW_POLARITY) {
			for (const row of table.rows)
				asked.push([
					`q${row}`,
					{
						type: "choice",
						instructions: prompt.render(rowPolarityQuestionTemplate, { row: label.cells[row]!.text }),
						criteria: POLARITY_CRITERIA,
					},
				]);
		}
	}
	return asked;
}

/** Each data row's name as the chart writes it (label and qualifiers), made unique; none without a label. */
function rowNames(table: TableAnalysis, plan: ChartPlan): Map<string, number> {
	const names = new Map<string, number>();
	if (plan.label === undefined) return names;
	const namers = [plan.label, ...(plan.qualifiers ?? [])].map(index => table.columns[index]!);
	for (const row of table.rows) {
		const base =
			namers
				.map(column => column.cells[row]!.text)
				.filter(Boolean)
				.join(" · ") || `row ${row + 1}`;
		let name = base;
		for (let n = 2; names.has(name) || name === NONE; n++) name = `${base} (${n})`;
		names.set(name, row);
	}
	return names;
}

/**
 * `plan` with what the judge says the table means, each answer only at its
 * confidence gate, else the local guess for `plan` ({@link guessMeaning}):
 * polarity per measure and metric row, what competes, the focus row, and the
 * title — the judge's pick among the takeaways it was offered, reworded under
 * the judged polarities, or the local striking fact.
 */
function judgedMeaning(
	request: TableChartRequest,
	answers: Readonly<Record<string, Answer>>,
	plan: ChartPlan,
): ChartPlan {
	const { table, guess } = request;
	const local = guessMeaning(table, plan);
	const polarity: Record<number, Polarity> = { ...local.polarity };
	for (const index of plan.series) {
		const answer = sureChoice(answers[`p${index}`], SURE_POLARITY, POLARITY_CRITERIA);
		if (answer === "neutral") delete polarity[index];
		else if (answer) polarity[index] = answer;
	}
	const rowPolarity: Record<number, Polarity> = { ...local.rowPolarity };
	for (const row of table.rows) {
		const answer = sureChoice(answers[`q${row}`], SURE_POLARITY, POLARITY_CRITERIA);
		if (answer === "neutral") delete rowPolarity[row];
		else if (answer) rowPolarity[row] = answer;
	}
	// Best marks claim a contest: only one the judge is sure of overrides the label-header guess.
	const contest = sureChoice(answers.rivals, SURE_RIVALS, RIVALS_CRITERIA);
	const rivals = contest === undefined ? local.rivals : contest === "neither" ? undefined : contest;
	// A focus row the judge is sure of, or one the table singles out too.
	const said = answers.focus;
	let focus = local.focus;
	if (said?.type === "choice") {
		const row = said.choice === NONE ? undefined : rowNames(table, guess).get(said.choice);
		const odds = said.probabilities[said.choice] ?? 0;
		const agreed = row !== undefined && (local.focus ?? []).includes(row);
		focus = row !== undefined && (odds >= SURE_FOCUS || (agreed && odds >= AGREED_FOCUS)) ? [row] : [];
	}
	const meant: ChartPlan = { ...plan, ...local, polarity, rowPolarity, rivals, focus };
	// The title: a takeaway the judge is sure of (a plain one needs more), else the local striking fact.
	const facts = tableTakeaways(table, meant);
	let key = facts.find(fact => fact.striking)?.key;
	const pick = answers.title;
	const offered = pick?.type === "choice" ? tableTakeaways(table, guess, CONTESTS) : [];
	if (pick?.type === "choice") {
		const fact = offered.find(fact => fact.key === pick.choice);
		const odds = pick.probabilities[pick.choice] ?? 0;
		if (odds >= (fact?.striking === false ? SURE_PLAIN_TITLE : SURE_TITLE)) key = fact?.key;
	}
	// Worded with the judged polarities (`improved`, not `fell`) where the fact still holds under them, else as offered.
	const restated = (fact: { key: string }) => fact.key === key;
	const title =
		key === undefined
			? undefined
			: (facts.find(restated) ?? tableTakeaways(table, meant, CONTESTS).find(restated) ?? offered.find(restated))
					?.text;
	return { ...meant, title };
}

/** `answer`'s choice when it is one of `criteria`'s options and the judge gave it `gate` or more; else `undefined`. */
function sureChoice<L extends string>(
	answer: Answer | undefined,
	gate: number,
	criteria: Record<L, unknown>,
): L | undefined {
	if (answer?.type !== "choice" || (answer.probabilities[answer.choice] ?? 0) < gate) return undefined;
	return isOption(criteria, answer.choice) ? answer.choice : undefined;
}

/**
 * The plan the judge's `answers` make for `request`, or `null` for no chart.
 * A missing or unsure answer keeps the local guess's part of the plan.
 */
export function planFromAnswers(
	request: TableChartRequest,
	answers: Readonly<Record<string, Answer>>,
): ChartPlan | null {
	const { table, guess } = request;
	const noul = (id: string) => {
		const answer = answers[id];
		return answer?.type === "noul" ? answer.noul : 0;
	};
	const kind = answers.kind;
	let choice: KindChoice = kind?.type === "choice" && isOption(KIND_CRITERIA, kind.choice) ? kind.choice : guess.kind;
	if (choice === "none") return null;
	const picks = answers.label;
	const named = picks?.type === "choice" ? labelOptions(table, guess).get(picks.choice) : undefined;
	const label = named ?? (guess.label === undefined ? undefined : table.columns[guess.label]);
	// A number picked as the label names its rows and leaves the plot.
	const candidates = table.measures.filter(column => column !== label);
	const picked = candidates.filter(column => noul(`c${column.index}`) >= 0.5);
	let series: readonly number[] = picked.length
		? picked.map(column => column.index)
		: guess.series.filter(index => index !== label?.index);
	// A scatter of `a–b` cells would plot only each interval's low end: they draw as intervals.
	if (
		choice === "scatter" &&
		rangeColumns(
			series.map(index => table.columns[index]!),
			table.rows,
		)
	)
		choice = "range";
	// Intervals are the chart: a `range` pick plots every interval column, whatever the column answers dropped.
	const spans = choice === "range" ? rangeColumns(candidates, table.rows) : undefined;
	if (spans) series = [...new Set([...spans.map(column => column.index), ...series])].sort((a, b) => a - b);
	if (
		series.length === 0 ||
		proseLed(
			table,
			series.map(index => table.columns[index]!),
		)
	)
		return null;
	let whole: number | undefined;
	// Parts of a whole: an exact sum the values show stacks whatever per-row kind the judge picks;
	// parts within a total, or columns only the judge reads as parts, stack when it picks `stacked`.
	const composition = table.composition;
	if (
		composition &&
		STACKABLE.has(choice) &&
		(composition.exact || choice === "stacked") &&
		!composition.parts.includes(label?.index ?? -1)
	) {
		choice = "stacked";
		series = composition.parts;
		whole = composition.whole;
	} else if (choice === "stacked") {
		const stack = stackable(table, series);
		if (stack.length >= 2) series = stack.map(column => column.index);
		else choice = guess.kind;
	}
	// Outcome counts (`ok | fail`) are each row's mix, whatever per-row comparison the judge picks.
	const outcomes = STACKABLE.has(choice) ? outcomeColumns(series.map(index => table.columns[index]!)) : undefined;
	if (outcomes) {
		choice = "stacked";
		series = outcomes.map(column => column.index);
	}
	// Metric pairs (`Baseline Turns | Iter1 Turns | Baseline Tokens In | …`): the headers decide;
	// any per-row comparison the judge picks draws as each pair's factor.
	let baselines: readonly number[] | undefined;
	if (guess.baselines && (STACKABLE.has(choice) || choice === "change")) {
		choice = "change";
		series = guess.series;
		baselines = guess.baselines;
	}
	// A dumbbell only for one quantity under two conditions (the headers say so, or the judge
	// confirms); otherwise two series stand side by side.
	const [first, second] = series.map(index => table.columns[index]!);
	const asked = pairCandidates(table, guess, candidates);
	const pairs =
		first !== undefined &&
		second !== undefined &&
		(isConditionPair(first.header, second.header) ||
			(asked?.[0] === first && asked[1] === second && noul("pair") >= 0.5));
	if (choice === "paired" && series.length === 2 && !pairs) choice = "grouped";
	// Factors of change need a baseline column (or `a → b` cells); two unrelated metrics stay values.
	const arrows = series.filter(index => table.columns[index]!.arrowShare >= 0.6).length;
	if (choice === "change" && !baselines && series.length >= 2 && arrows < 2 && !pairs)
		choice = guess.kind === "change" ? "grouped" : guess.kind;
	// A run of steps (offered only where the guess is one) draws the guess's column, offsets and cap.
	let offsets: number | undefined;
	let limit: number | undefined;
	if (FLOWS.has(choice)) {
		if (choice === guess.kind) {
			series = guess.series;
			({ offsets, limit } = guess);
		} else choice = guess.kind;
	}
	// Qualifiers the judge accepts, kept only as far as they tell rows apart; the group
	// is one of the naming columns. Another label than the guess's is named locally.
	let naming: { qualifiers: readonly number[]; group: number | undefined } = { qualifiers: [], group: undefined };
	if (label && label.index !== guess.label) naming = guessNaming(table, label);
	else if (label) {
		const accepted = namingColumns(table, label).filter(column => noul(`n${column.index}`) >= 0.5);
		const { qualifiers } = guessNaming(table, label, accepted);
		let group: number | undefined;
		let odds = 0;
		for (const index of qualifiers.length ? [label.index, ...qualifiers] : []) {
			const yes = noul(`g${index}`);
			if (yes >= 0.5 && yes > odds) {
				group = index;
				odds = yes;
			}
		}
		naming = { qualifiers, group };
	}
	return judgedMeaning(request, answers, {
		kind: choice,
		label: label?.index,
		qualifiers: naming.qualifiers,
		group: naming.group,
		series: choice === "scatter" ? series.slice(0, 2) : series,
		transpose:
			choice !== "change" &&
			choice !== "stacked" &&
			!FLOWS.has(choice) &&
			noul("transpose") >= 0.5 &&
			candidates.some(column => column.mixed),
		shading:
			sureChoice(answers.shading, SHADING_CONFIDENCE, SHADING_CRITERIA) ??
			(guess.kind === "heatmap"
				? guess.shading
				: guessShading(
						series.map(index => table.columns[index]!),
						table.rows,
					)),
		reference: judgedReference(request, answers.reference),
		order: judgedOrder(request, answers.order, choice, series),
		whole,
		baselines,
		offsets,
		limit,
	});
}

/**
 * Whether the table can draw as a heatmap — the guess is one, or it holds
 * {@link MIN_HEAT_COLUMNS} same-unit candidates — so the shading answer can
 * change the chart; an exact composition always stacks instead.
 */
function heatCapable(table: TableAnalysis, guess: ChartPlan, candidates: readonly TableColumn[]): boolean {
	if (table.composition?.exact) return false;
	if (guess.kind === "heatmap") return true;
	const sizes = new Map<string, number>();
	for (const column of candidates) {
		const key = `${column.dim}:${column.unit}`;
		sizes.set(key, (sizes.get(key) ?? 0) + 1);
	}
	return Math.max(0, ...sizes.values()) >= MIN_HEAT_COLUMNS;
}

/**
 * The column the order question ranks by — the guess's lead series — when a
 * ranking can change the chart: rows named by text, at least
 * {@link MIN_RANKED_ROWS} of them, a kind that lists rows down a label column,
 * and values not already sorted (an already ranked table keeps its order).
 */
function rankable(table: TableAnalysis, guess: ChartPlan): TableColumn | undefined {
	const label = guess.label === undefined ? undefined : table.columns[guess.label];
	const lead = table.columns[guess.series[0] ?? -1];
	if (!lead || label?.role !== "label" || OWN_FRAME.has(guess.kind) || guess.transpose || guess.baselines)
		return undefined;
	if (table.rows.length < MIN_RANKED_ROWS) return undefined;
	const values = table.rows.flatMap(row => {
		const cell = lead.cells[row];
		return isNumber(cell) ? [cell.value] : [];
	});
	return isMonotonic(values) ? undefined : lead;
}

/** The judge's ranking at {@link RANK_CONFIDENCE} or more, by the column it named while that is plotted; else none. */
function judgedOrder(
	request: TableChartRequest,
	answer: Answer | undefined,
	choice: KindChoice,
	series: readonly number[],
): RowOrder | undefined {
	const direction = sureChoice(answer, RANK_CONFIDENCE, ORDER_CRITERIA);
	if (direction === undefined || direction === "table" || OWN_FRAME.has(choice)) return undefined;
	const lead = request.guess.series[0];
	const column = lead !== undefined && series.includes(lead) ? lead : series[0];
	return column === undefined ? undefined : { column, direction };
}

/**
 * The naming column whose values the reference question offers: the one the
 * local guess found a reference in, else the innermost qualifier, else the
 * label; `undefined` when the chart could draw no reference rule or the
 * column holds too many or too long distinct values.
 */
function referenceCandidates(
	table: TableAnalysis,
	guess: ChartPlan,
): { column: TableColumn; values: string[]; repeats: boolean } | undefined {
	if (!REFERENCED.has(guess.kind) || guess.baselines || table.composition?.exact) return undefined;
	const index = guess.reference?.column ?? guess.qualifiers?.at(-1) ?? guess.label;
	const column = index === undefined ? undefined : table.columns[index];
	if (!column || column.role !== "label") return undefined;
	const cells = table.rows.map(row => column.cells[row]!).filter(cell => cell.kind !== "missing");
	const values = [...new Set(cells.map(cell => cell.text))];
	if (values.length < 2 || values.length > MAX_REFERENCE_CHOICES) return undefined;
	if (values.some(value => value.length > MAX_REFERENCE_CHARS || value === "none")) return undefined;
	return { column, values, repeats: values.length < cells.length };
}

/** The judge's reference row at {@link REFERENCE_CONFIDENCE} or more (`none` clears the guess); else the guess's. */
function judgedReference(request: TableChartRequest, answer: Answer | undefined): ChartPlan["reference"] {
	const { guess } = request;
	if (answer?.type !== "choice" || (answer.probabilities[answer.choice] ?? 0) < REFERENCE_CONFIDENCE)
		return guess.reference;
	if (answer.choice === "none") return undefined;
	const index = referenceCandidates(request.table, guess)?.column.index;
	return index === undefined ? guess.reference : { column: index, value: answer.choice };
}

/** A column's inferred type as the judge reads it: `number (duration)`, `text`, `row index`, … */
function columnType(column: TableColumn): string {
	switch (column.role) {
		case "measure":
			if (column.mixed) return "number (mixed units)";
			return column.scores ? "number (score out of a total)" : `number (${column.dim ?? "count"})`;
		case "sequence":
			return "ordered step";
		case "index":
			return "row index";
		case "temporal":
			return "date/time";
		default:
			return "text";
	}
}
