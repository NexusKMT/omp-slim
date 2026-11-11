import { useMemo, useState } from "react";
import { getProviderDashboardStats } from "../api";
import { Chart, type ChartSeries, Legend, ShareBar, TimeChart, useHiddenSeries } from "../charts";
import { buildColorLookup, OTHER_COLOR } from "../data/colors";
import {
	formatCompact,
	formatCost,
	formatErrorRate,
	formatEstimatedCost,
	formatInteger,
	formatPercent,
	formatTokensPerSecond,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { bucketAxis, rangeMeta } from "../data/range";
import { densify, pivotSeries } from "../data/series";
import type { ProviderAggregate, ProviderHourlyPoint, TimeRange } from "../types";
import {
	Badge,
	Card,
	ChartSkeleton,
	type Column,
	EmptyState,
	errorRateTone,
	MeterCell,
	PageHeader,
	QueryView,
	Segmented,
	Stat,
	StatGrid,
	Swatch,
	Table,
	TableSkeleton,
} from "../ui";
import "./providers.css";

export interface ProvidersRouteProps {
	active: boolean;
	range: TimeRange;
}

type BurnMetric = "tokens" | "cost" | "requests";

const BURN_OPTIONS = [
	{ value: "tokens" as const, label: "Tokens" },
	{ value: "cost" as const, label: "Cost", title: "Recorded cost" },
	{ value: "requests" as const, label: "Requests" },
];

/** Providers stacked individually in the burn chart; the rest fold into "Other". */
const TOP_PROVIDERS = 6;

const TOKEN_MIX = [
	{ key: "input", label: "Uncached input", color: "#5b8cff" },
	{ key: "cacheRead", label: "Cache read", color: "var(--chart-primary)" },
	{ key: "cacheWrite", label: "Cache write", color: "#f5b54a" },
	{ key: "output", label: "Output", color: "var(--chart-secondary)" },
] as const;

export function ProvidersRoute({ active, range }: ProvidersRouteProps) {
	const stats = useQuery(["providers", range], ({ signal }) => getProviderDashboardStats(range, signal), {
		enabled: active,
	});
	const [metric, setMetric] = useState<BurnMetric>("tokens");
	const [hidden, toggleHidden] = useHiddenSeries();
	const meta = rangeMeta(range);

	const view = useMemo(() => {
		const providers = stats.data?.providers ?? [];
		const points = stats.data?.series ?? [];
		const colors = buildColorLookup(providers.map(p => ({ key: p.provider, weight: p.totalTokens })));
		const buckets = bucketAxis(
			range,
			points.map(p => p.timestamp),
		);
		const totals = { requests: 0, failed: 0, tokens: 0, cost: 0, unpriced: 0 };
		for (const p of providers) {
			totals.requests += p.totalRequests;
			totals.failed += p.failedRequests;
			totals.tokens += p.totalTokens;
			totals.cost += p.totalCost;
			totals.unpriced += p.unpricedRequests;
		}
		// Zero slots become gaps so the tooltip lists only providers active in that bucket.
		const pivot = (value: (p: (typeof points)[number]) => number) =>
			pivotSeries(points, { buckets, key: p => p.provider, value, limit: TOP_PROVIDERS, colors }).map(s => ({
				...s,
				values: s.values.map(v => v || null),
			}));
		return {
			colors,
			buckets,
			totals,
			burn: {
				tokens: pivot(p => p.totalTokens),
				cost: pivot(p => p.cost),
				requests: pivot(p => p.requests),
			} satisfies Record<BurnMetric, ChartSeries[]>,
			spark: {
				tokens: densify(points, buckets, p => p.totalTokens),
				cost: densify(points, buckets, p => p.cost),
				requests: densify(points, buckets, p => p.requests),
			},
			topProvider: providers.reduce<ProviderAggregate | null>(
				(top, p) => (top === null || p.totalTokens > top.totalTokens ? p : top),
				null,
			),
		};
	}, [stats.data, range]);

	const burnSeries = view.burn[metric];
	const burnFormat = metric === "cost" ? (v: number) => formatCost(v) : formatCompact;
	const t = view.totals;

	return (
		<div className="page">
			<PageHeader
				title="Providers"
				description={`Token usage and reliability per provider over ${meta.windowLabel}.`}
			/>

			<QueryView query={stats} skeleton={<ChartSkeleton height={112} />}>
				{({ providers }) => (
					<div data-stale={stats.stale}>
						<StatGrid min={190}>
							<Stat
								label="Providers"
								value={formatInteger(providers.length)}
								hint={view.topProvider ? `Most tokens: ${view.topProvider.provider}` : undefined}
							/>
							<Stat
								label="Requests"
								value={formatInteger(t.requests)}
								hint={`${formatInteger(t.failed)} failed`}
								spark={view.spark.requests}
							/>
							<Stat
								label="Tokens"
								title="Uncached input + cache reads + cache writes + output"
								value={formatCompact(t.tokens)}
								spark={view.spark.tokens}
							/>
							<Stat
								label="Recorded cost"
								title="Costs recorded with each request"
								value={formatEstimatedCost(t.cost, t.unpriced)}
								hint={t.unpriced > 0 ? `${formatInteger(t.unpriced)} unpriced` : undefined}
								spark={view.spark.cost}
								sparkColor="var(--chart-secondary)"
							/>
							<Stat
								label="Error rate"
								value={formatErrorRate(t.requests > 0 ? t.failed / t.requests : 0)}
								hint={`${formatInteger(t.requests - t.failed)} succeeded`}
							/>
						</StatGrid>
					</div>
				)}
			</QueryView>

			<Card
				index={1}
				title="Provider totals"
				description={
					t.unpriced > 0
						? `Recorded cost excludes ${formatInteger(t.unpriced)} unpriced request${t.unpriced === 1 ? "" : "s"}. Select a row for its token mix.`
						: "Select a row for its token mix."
				}
				flush
				stale={stats.stale}
			>
				<QueryView query={stats} skeleton={<TableSkeleton rows={6} />}>
					{({ providers }) => <ProviderTotalsTable providers={providers} colors={view.colors} />}
				</QueryView>
			</Card>

			<div className="grid grid-main-side">
				<Card
					index={2}
					title="Burn by provider"
					description={
						metric === "cost" && t.unpriced > 0
							? `Recorded cost per ${meta.bucketMs < 86_400_000 ? "hour" : "day"}; excludes unpriced requests`
							: `Per ${meta.bucketMs < 3_600_000 ? "5 minutes" : meta.bucketMs < 86_400_000 ? "hour" : "day"}, top ${TOP_PROVIDERS} providers stacked`
					}
					actions={<Segmented size="sm" options={BURN_OPTIONS} value={metric} onChange={setMetric} />}
					stale={stats.stale}
				>
					<QueryView query={stats} skeleton={<ChartSkeleton height={260} />}>
						{() => (
							<div className="stack" style={{ gap: 12 }}>
								<TimeChart
									buckets={view.buckets}
									bucketMs={meta.bucketMs}
									series={burnSeries}
									hidden={hidden}
									height={260}
									format={burnFormat}
									formatTooltip={metric === "cost" ? v => formatCost(v) : formatInteger}
									emptyLabel="No provider activity in this range"
								/>
								<Legend
									items={burnSeries.map(s => ({
										key: s.key,
										label: s.label,
										color: s.color,
										value: burnFormat(s.values.reduce<number>((sum, v) => sum + (v ?? 0), 0)),
									}))}
									hidden={hidden}
									onToggle={toggleHidden}
								/>
							</div>
						)}
					</QueryView>
				</Card>

				<QueryView query={stats} skeleton={<ChartSkeleton height={320} />}>
					{({ hourly, providers }) => <PeakHoursCard hourly={hourly} providers={providers} stale={stats.stale} />}
				</QueryView>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Provider totals
// ---------------------------------------------------------------------------

function ProviderTotalsTable({
	providers,
	colors,
}: {
	providers: ProviderAggregate[];
	colors: ReadonlyMap<string, string>;
}) {
	const [open, setOpen] = useState<string | null>(null);
	const columns = useMemo<Column<ProviderAggregate>[]>(() => {
		let maxRequests = 0;
		let maxTokens = 0;
		let grandTokens = 0;
		for (const p of providers) {
			maxRequests = Math.max(maxRequests, p.totalRequests);
			maxTokens = Math.max(maxTokens, p.totalTokens);
			grandTokens += p.totalTokens;
		}
		return [
			{
				key: "provider",
				header: "Provider",
				sort: p => p.provider,
				render: p => (
					<span className="row" style={{ gap: 8 }}>
						<Swatch color={colors.get(p.provider) ?? OTHER_COLOR} />
						<span className="mono cell-primary">{p.provider}</span>
					</span>
				),
			},
			{
				key: "requests",
				header: "Requests",
				align: "right",
				sort: p => p.totalRequests,
				render: p => (
					<MeterCell value={p.totalRequests} max={maxRequests} display={formatInteger(p.totalRequests)} />
				),
			},
			{
				key: "errors",
				header: "Error rate",
				align: "right",
				sort: p => (p.totalRequests > 0 ? p.failedRequests / p.totalRequests : 0),
				render: p => {
					const rate = p.totalRequests > 0 ? p.failedRequests / p.totalRequests : 0;
					return (
						<span className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
							<span className="num dim">{formatInteger(p.failedRequests)}</span>
							<Badge tone={p.failedRequests > 0 ? errorRateTone(rate) : "neutral"} mono>
								{formatErrorRate(rate)}
							</Badge>
						</span>
					);
				},
			},
			{
				key: "models",
				header: "Models",
				title: "Distinct models used through this provider",
				align: "right",
				sort: p => p.models,
				render: p => <span className="num">{formatInteger(p.models)}</span>,
			},
			{
				key: "tokens",
				header: "Tokens",
				title: "Uncached input + cache reads + cache writes + output",
				align: "right",
				sort: p => p.totalTokens,
				render: p => (
					<MeterCell
						value={p.totalTokens}
						max={maxTokens}
						display={formatCompact(p.totalTokens)}
						color={colors.get(p.provider)}
					/>
				),
			},
			{
				key: "share",
				header: "Share",
				title: "Fraction of all tokens in range",
				align: "right",
				sort: p => p.totalTokens,
				render: p => (
					<span className="num muted">{formatPercent(grandTokens > 0 ? p.totalTokens / grandTokens : 0)}</span>
				),
			},
			{
				key: "cost",
				header: "Cost",
				title: "Recorded cost",
				align: "right",
				sort: p => p.totalCost,
				render: p => (
					<span
						className="num"
						title={p.unpricedRequests > 0 ? `${formatInteger(p.unpricedRequests)} unpriced` : undefined}
					>
						{formatEstimatedCost(p.totalCost, p.unpricedRequests)}
					</span>
				),
			},
			{
				key: "tps",
				header: "Tokens/s",
				title: "Average output throughput",
				align: "right",
				sort: p => p.avgTokensPerSecond ?? -1,
				render: p => <span className="num">{formatTokensPerSecond(p.avgTokensPerSecond)}</span>,
			},
			{
				key: "premium",
				header: "Premium",
				title: "Recorded premium requests",
				align: "right",
				sort: p => p.totalPremiumRequests,
				render: p => (
					<span className={p.totalPremiumRequests > 0 ? "num" : "num dim"}>
						{formatInteger(Math.round(p.totalPremiumRequests * 100) / 100)}
					</span>
				),
			},
		];
	}, [providers, colors]);

	return (
		<Table
			rows={providers}
			rowKey={p => p.provider}
			columns={columns}
			initialSort={{ key: "tokens", dir: "desc" }}
			limit={12}
			selectedKey={open}
			onRowClick={p => setOpen(prev => (prev === p.provider ? null : p.provider))}
			expanded={p => (p.provider === open ? <TokenMix provider={p} /> : null)}
			empty={<EmptyState title="No requests in this range" />}
		/>
	);
}

function TokenMix({ provider }: { provider: ProviderAggregate }) {
	const mix = {
		input: provider.totalInputTokens,
		cacheRead: provider.totalCacheReadTokens,
		cacheWrite: provider.totalCacheWriteTokens,
		output: provider.totalOutputTokens,
	};
	return (
		<div className="providers-mix">
			<ShareBar segments={TOKEN_MIX.map(m => ({ key: m.key, label: m.label, value: mix[m.key], color: m.color }))} />
			<Legend
				items={TOKEN_MIX.map(m => ({
					key: m.key,
					label: m.label,
					color: m.color,
					value: `${formatCompact(mix[m.key])} · ${provider.totalTokens > 0 ? formatPercent(mix[m.key] / provider.totalTokens, 0) : "–"}`,
				}))}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Peak burn hours
// ---------------------------------------------------------------------------

const ALL_PROVIDERS = "";

function PeakHoursCard({
	hourly,
	providers,
	stale,
}: {
	hourly: ProviderHourlyPoint[];
	providers: ProviderAggregate[];
	stale: boolean;
}) {
	const [provider, setProvider] = useState(ALL_PROVIDERS);
	const current =
		provider === ALL_PROVIDERS || providers.some(p => p.provider === provider) ? provider : ALL_PROVIDERS;

	const hours = useMemo(() => {
		const tokens = Array.from({ length: 24 }, () => 0);
		const output = Array.from({ length: 24 }, () => 0);
		const requests = Array.from({ length: 24 }, () => 0);
		for (const point of hourly) {
			if (current !== ALL_PROVIDERS && point.provider !== current) continue;
			tokens[point.hour] += point.totalTokens;
			output[point.hour] += point.outputTokens;
			requests[point.hour] += point.requests;
		}
		let peak = 0;
		for (let hour = 1; hour < 24; hour++) if (tokens[hour] > tokens[peak]) peak = hour;
		const hasData = tokens[peak] > 0;
		const series: ChartSeries[] = [
			{
				key: "tokens",
				label: "Tokens",
				color: "var(--chart-primary)",
				values: tokens.map((v, hour) => (hasData && hour === peak ? null : v)),
			},
			{
				key: "peak",
				label: "Tokens (peak hour)",
				color: "var(--chart-secondary)",
				values: tokens.map((v, hour) => (hasData && hour === peak ? v : null)),
			},
		];
		return { series, output, requests, peak, hasData };
	}, [hourly, current]);

	const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

	return (
		<Card
			index={3}
			title="Peak burn hours"
			description={
				hours.hasData
					? `Tokens by local hour of day; peak at ${hourLabel(hours.peak)}`
					: "Tokens by local hour of day"
			}
			actions={
				<select
					className="input providers-select"
					value={current}
					onChange={e => setProvider(e.target.value)}
					aria-label="Provider"
				>
					<option value={ALL_PROVIDERS}>All providers</option>
					{providers.map(p => (
						<option key={p.provider} value={p.provider}>
							{p.provider}
						</option>
					))}
				</select>
			}
			stale={stale}
		>
			<Chart
				slots={24}
				tickLabel={hour => String(hour).padStart(2, "0")}
				tooltipTitle={hour => `${hourLabel(hour)}–${hourLabel((hour + 1) % 24)}`}
				series={hours.series}
				height={260}
				showTotal={false}
				formatTooltip={formatInteger}
				emptyLabel="No activity in this range"
				tooltipExtra={hour => (
					<>
						<div className="chart-tooltip-row">
							<span className="chart-tooltip-label">Output</span>
							<span className="chart-tooltip-value">{formatInteger(hours.output[hour])}</span>
						</div>
						<div className="chart-tooltip-row">
							<span className="chart-tooltip-label">Requests</span>
							<span className="chart-tooltip-value">{formatInteger(hours.requests[hour])}</span>
						</div>
					</>
				)}
			/>
		</Card>
	);
}
