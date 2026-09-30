/**
 * The evidence bundle as one self-contained HTML file.
 *
 * No external stylesheet, font or script. This is evidence: it has to render years
 * from now, from a filesystem, with no network — and a page that fetched anything
 * would also be a page that told someone it had been opened. The JSON is embedded
 * verbatim so the document and the machine-readable bundle cannot disagree.
 *
 * Every interpolated value goes through `escapeHtml`. Graph ids, denial reasons and
 * tool names are all agent-supplied text.
 */
import type { EvidenceBundle } from "./report.ts";
import type { SloResult } from "@substrate/observability";

export function escapeHtml(value: unknown): string {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function formatObserved(slo: SloResult): string {
	if (slo.observed === null) return "—";
	return slo.unit === "ms" ? `${slo.observed.toFixed(0)} ms` : `${(slo.observed * 100).toFixed(3)} %`;
}

function statusLabel(status: SloResult["status"]): string {
	switch (status) {
		case "ok":
			return "met";
		case "breached":
			return "breached";
		case "insufficient-data":
			return "not enough data";
		default:
			return "unmeasurable";
	}
}

function chainRow(label: string, chain: { ok: boolean | null; records: number; brokenAt?: string | number; reason?: string }): string {
	const state = chain.ok === null ? "unknown" : chain.ok ? "intact" : "broken";
	const detail =
		chain.ok === false
			? `broken at ${escapeHtml(chain.brokenAt ?? "?")} — ${escapeHtml(chain.reason ?? "no reason given")}`
			: chain.ok === null
				? escapeHtml(chain.reason ?? "could not be verified")
				: `${chain.records} record${chain.records === 1 ? "" : "s"} recomputed`;
	return `<tr>
			<th scope="row">${escapeHtml(label)}</th>
			<td><span class="pill pill--${state}">${state}</span></td>
			<td>${detail}</td>
		</tr>`;
}

export function renderEvidenceHtml(bundle: EvidenceBundle): string {
	const sloRows = bundle.slos
		.map(
			(slo) => `<tr>
			<th scope="row">${escapeHtml(slo.title)}<span class="muted"> · ${escapeHtml(slo.id)}</span></th>
			<td><span class="pill pill--${slo.status}">${statusLabel(slo.status)}</span></td>
			<td class="num">${escapeHtml(formatObserved(slo))}</td>
			<td class="num">${slo.samples}</td>
			<td class="detail">${escapeHtml(slo.statement)}<br><span class="muted">${escapeHtml(slo.detail)}</span></td>
		</tr>`,
		)
		.join("\n");

	const toolRows = bundle.audit.byTool
		.map(
			(row) => `<tr>
			<th scope="row"><code>${escapeHtml(row.tool)}</code></th>
			<td class="num">${row.allowed}</td>
			<td class="num${row.denied > 0 ? " num--flag" : ""}">${row.denied}</td>
		</tr>`,
		)
		.join("\n");

	const deniedRows = bundle.audit.records
		.filter((record) => record.decision === "denied")
		.slice(-25)
		.map(
			(record) => `<tr>
			<td class="num">${record.seq}</td>
			<td>${escapeHtml(record.ts)}</td>
			<td>${escapeHtml(record.surface)}</td>
			<td><code>${escapeHtml(record.tool)}</code></td>
			<td class="detail">${escapeHtml(record.reason ?? "no reason recorded")}</td>
		</tr>`,
		)
		.join("\n");

	const usage = bundle.usage
		? `<dl class="facts">
			<div><dt>Input tokens</dt><dd>${bundle.usage.inputTokens.toLocaleString("en-US")}</dd></div>
			<div><dt>Output tokens</dt><dd>${bundle.usage.outputTokens.toLocaleString("en-US")}</dd></div>
			<div><dt>Spend</dt><dd>$${bundle.usage.costUsd.toFixed(4)}</dd></div>
		</dl>`
		: `<p class="muted">No token or cost usage was attributed to this graph. Either no collector reported
			usage on its events, or this graph's series collapsed into <code>_overflow</code> under the
			cardinality cap — in which case its totals are not separable from other graphs' and are not
			guessed at here.</p>`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Substrate evidence · ${escapeHtml(bundle.graph_id)}</title>
<style>
	:root {
		color-scheme: light dark;
		--bg: #fbfbfa; --panel: #ffffff; --ink: #1a1a19; --muted: #6b6b66;
		--line: #e3e3df; --ok: #1f7a4d; --bad: #a8321f; --warn: #8a6a12; --accent: #2f4f8f;
		--mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
	}
	@media (prefers-color-scheme: dark) {
		:root {
			--bg: #16161a; --panel: #1e1e23; --ink: #e8e8e4; --muted: #9a9a93;
			--line: #32323a; --ok: #6ecf9a; --bad: #f0907c; --warn: #e0bf6a; --accent: #9ab6ef;
		}
	}
	* { box-sizing: border-box; }
	body {
		margin: 0; background: var(--bg); color: var(--ink);
		font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
	}
	main { max-width: 68rem; margin: 0 auto; padding: 2.5rem 1rem 4rem; }
	h1 { font-size: 1.5rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
	h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 2.5rem 0 .75rem; }
	code, .mono { font-family: var(--mono); font-size: .9em; }
	.muted { color: var(--muted); }
	.stub {
		border: 1px solid var(--warn); border-left-width: 4px; border-radius: 6px;
		padding: .75rem 1rem; margin: 1.5rem 0; background: var(--panel);
	}
	section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: .25rem 1rem 1rem; }
	table { width: 100%; border-collapse: collapse; font-size: .92rem; }
	th, td { text-align: left; padding: .55rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
	thead th { font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
	tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
	.num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); }
	.num--flag { color: var(--bad); font-weight: 600; }
	.detail { font-size: .86rem; }
	.pill { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .78rem;
		font-weight: 600; border: 1px solid currentColor; white-space: nowrap; }
	.pill--ok, .pill--intact { color: var(--ok); }
	.pill--breached, .pill--broken { color: var(--bad); }
	.pill--insufficient-data, .pill--unmeasurable, .pill--unknown { color: var(--warn); }
	.facts { display: flex; flex-wrap: wrap; gap: 1.5rem 2.5rem; margin: 1rem 0; }
	.facts dt { font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
	.facts dd { margin: .15rem 0 0; font-size: 1.15rem; font-family: var(--mono); }
	ul { margin: .5rem 0 0; padding-left: 1.25rem; }
	li { margin: .3rem 0; }
	details { margin-top: 2.5rem; }
	summary { cursor: pointer; color: var(--muted); font-size: .9rem; }
	pre { overflow-x: auto; background: var(--panel); border: 1px solid var(--line);
		border-radius: 8px; padding: 1rem; font-size: .8rem; }
	footer { margin-top: 3rem; color: var(--muted); font-size: .82rem; }
	@media print { body { background: #fff; } section, pre { border-color: #ccc; } details { display: none; } }
</style>
</head>
<body>
<main>
	<h1>Substrate evidence</h1>
	<p class="muted mono">${escapeHtml(bundle.graph_id)} · generated ${escapeHtml(bundle.generated)} ·
		${escapeHtml(bundle.service.name)} ${escapeHtml(bundle.service.version)} on ${escapeHtml(bundle.service.instance)}</p>

	<div class="stub">
		<strong>This bundle is a stub.</strong> It attests only to what is listed below. Still to come:
		<ul>${bundle.pending.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
	</div>

	<h2>Integrity</h2>
	<section>
		<table>
			<thead><tr><th>Chain</th><th>State</th><th>Detail</th></tr></thead>
			<tbody>
				${chainRow("Greptime app events", bundle.chains.app_events)}
				${chainRow("MCP audit", bundle.chains.mcp_audit)}
			</tbody>
		</table>
		<p class="muted detail">Two chains, two stores, on purpose: the audit has to survive an outage of the
			ledger it audits, and <code>agent_events</code> is writable by the agents being audited.
			Audit sink: <code>${escapeHtml(bundle.chains.mcp_audit.path ?? "memory only")}</code>${
				bundle.chains.mcp_audit.unparseable > 0
					? ` · ${bundle.chains.mcp_audit.unparseable} unparseable line(s) left in place rather than removed`
					: ""
			}.</p>
	</section>

	<h2>Service-level objectives</h2>
	<section>
		<table>
			<thead><tr><th>Objective</th><th>State</th><th class="num">Observed</th><th class="num">Samples</th><th>Statement</th></tr></thead>
			<tbody>${sloRows || '<tr><td colspan="5" class="muted">No objectives evaluated.</td></tr>'}</tbody>
		</table>
		<p class="muted detail">${bundle.slo_summary.ok} met · ${bundle.slo_summary.breached} breached ·
			${bundle.slo_summary.insufficient} not yet judged · ${bundle.slo_summary.unmeasurable} unmeasurable.
			An objective is never reported as met from fewer samples than its threshold requires.</p>
	</section>

	<h2>Tokens and cost</h2>
	<section>${usage}</section>

	<h2>MCP audit</h2>
	<section>
		<dl class="facts">
			<div><dt>Records</dt><dd>${bundle.audit.total}</dd></div>
			<div><dt>Allowed</dt><dd>${bundle.audit.allowed}</dd></div>
			<div><dt>Denied</dt><dd>${bundle.audit.denied}</dd></div>
		</dl>
		<table>
			<thead><tr><th>Tool</th><th class="num">Allowed</th><th class="num">Denied</th></tr></thead>
			<tbody>${toolRows || '<tr><td colspan="3" class="muted">No tool calls recorded for this graph.</td></tr>'}</tbody>
		</table>
	</section>

	${
		deniedRows
			? `<h2>Denials</h2>
	<section>
		<table>
			<thead><tr><th class="num">Seq</th><th>When</th><th>Surface</th><th>Tool</th><th>Reason</th></tr></thead>
			<tbody>${deniedRows}</tbody>
		</table>
	</section>`
			: ""
	}

	${
		bundle.notes.length > 0
			? `<h2>Notes</h2><section><ul>${bundle.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul></section>`
			: ""
	}

	<details>
		<summary>Machine-readable bundle</summary>
		<pre>${escapeHtml(JSON.stringify(bundle, null, 2))}</pre>
	</details>

	<footer>
		Arguments are never stored: the audit keeps each call's argument names and a sha256 over their
		canonical form, so a held request can be proved to be the one that was allowed without the trail
		becoming a second copy of everything every agent sent.
	</footer>
</main>
</body>
</html>
`;
}
