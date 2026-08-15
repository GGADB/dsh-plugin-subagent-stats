/**
 * dsh-plugin-subagent-stats — browser half.
 *
 * Shadows the shipped StatsLine (slot `conversation.composer.dock`, id "stats")
 * with a component that merges every descendant subagent session's
 * `sessionStats` and `tokenUsage` projections into the viewed session's own
 * figures, so the bottom stats strip covers delegated work too.
 *
 * Shadowing: the dock is a list slot; the shipped entry registers id "stats"
 * at priority 0, this entry re-registers the same id at priority -1, and the
 * slot renderer keeps only the first (lowest-priority) entry per cell.
 *
 * Reactivity: `useSessions` re-renders on every `session/projection` frame of
 * ANY session (the runtime marks the session list dirty on each frame), so
 * descendant projection changes flow into the merge without per-session
 * subscriptions.
 *
 * Tooltip: when the line overflows its box (or when sub-sessions exist), a
 * hover bubble shows the full merged line plus a breakdown of the main
 * session's own usage vs. the sub-agents' aggregate usage (and each child
 * individually when there are few of them).
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-subagent-stats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");

		// ── styles (mirror of the shipped StatsLine look) ───────────────────────
		const CSS = ".dsh-subagent-stats-root{text-align:center;max-width:var(--dsh-chat-content-width);box-sizing:border-box;width:100%;padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 0px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;margin:0 auto;font-size:12px;line-height:20px;display:block}.dsh-subagent-stats-sep{color:var(--dsw-alias-separator-primary);margin:0 10px}.dsh-subagent-stats-strong{color:var(--dsw-alias-label-primary);font-weight:600}";
		const CSS_TAG = "dsh-plugin-subagent-stats/StatsLine.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-subagent-stats";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ── locale: same templates as the shipped stats strip ───────────────────
		const NS = "subagentStats";
		const zh = {
			"stats.counts": "{turns} 轮 · {steps} 步",
			"stats.llm": "LLM {duration}",
			"stats.toolCall": "工具调用 {duration}",
			"stats.ttftAverage": "首 token 平均 {duration}",
			"stats.tokensPerSecond": "{throughput} tok/s",
			"stats.cacheHitLabel": "缓存命中 ",
			"stats.tokensInputLabel": "输入 ",
			"stats.tokensBetweenLabel": " · 输出 ",
			"stats.tooltip.root": "主对话（当前会话）",
			"stats.tooltip.children": "子 agent（{count} 个）",
			"stats.tooltip.empty": "（无数据）"
		};
		const en = {
			"stats.counts": "{turns} turns · {steps} steps",
			"stats.llm": "LLM {duration}",
			"stats.toolCall": "Tool call {duration}",
			"stats.ttftAverage": "TTFT avg {duration}",
			"stats.tokensPerSecond": "{throughput} tok/s",
			"stats.cacheHitLabel": "Cache hit ",
			"stats.tokensInputLabel": "Input ",
			"stats.tokensBetweenLabel": " · Output ",
			"stats.tooltip.root": "Main session",
			"stats.tooltip.children": "Sub-agents ({count})",
			"stats.tooltip.empty": "(no data)"
		};

		// ── formatting helpers (faithful copies of the shipped ones) ────────────
		function formatTokens(n) {
			const scaled = (v) => v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
			if (n < 1e3) return String(n);
			if (n < 1e6) return `${scaled(n / 1e3)}K`;
			return `${scaled(n / 1e6)}M`;
		}
		function formatDuration(ms) {
			const s = ms / 1e3;
			if (s < 60) return `${Math.round(s * 10) / 10}s`;
			const whole = Math.round(s);
			return `${Math.floor(whole / 60)}m${whole % 60}s`;
		}
		function formatTokensPerSecond(tps) {
			const clamped = Math.max(0, tps);
			return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
		}
		function billedInputTokens(usage) {
			return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
		}
		function cacheHitPercent(usage) {
			const denominator = billedInputTokens(usage);
			return denominator === 0 ? null : (usage.cacheReadTokens / denominator * 100).toFixed(2);
		}

		// ── merge machinery ─────────────────────────────────────────────────────
		const ZERO_STATS = Object.freeze({
			turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0
		});
		const ZERO_USAGE = Object.freeze({
			uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0
		});
		const STAT_KEYS = Object.keys(ZERO_STATS);
		const USAGE_KEYS = Object.keys(ZERO_USAGE);

		/** Fallback whole-log counts when the sessionStats projection is absent (counts only). */
		function deriveFallbackStats(nodes) {
			let steps = 0;
			const turns = new Set();
			for (const node of nodes) {
				if (node.kind !== "assistant") continue;
				steps += 1;
				turns.add(node.turn);
			}
			return { ...ZERO_STATS, turns: turns.size, steps };
		}

		/** All descendant session ids of `rootId`, depth-first, cycle-guarded. */
		function collectDescendants(byId, rootId) {
			const out = [];
			const stack = [];
			for (const id of Object.keys(byId)) {
				const entry = byId[id];
				if (entry !== void 0 && entry.parentId === rootId) stack.push(id);
			}
			const seen = new Set();
			while (stack.length > 0) {
				const id = stack.pop();
				if (seen.has(id)) continue;
				seen.add(id);
				out.push(id);
				for (const cid of Object.keys(byId)) {
					const entry = byId[cid];
					if (entry !== void 0 && entry.parentId === id) stack.push(cid);
				}
			}
			return out;
		}

		/**
		* Merge the viewed session's own figures with every descendant's
		* projections. Descendant values come from their per-session projection
		* stores (the runtime creates one per session id on frame arrival).
		* Besides the merged totals it returns the root-only and children-only
		* splits (plus per-child figures) for the hover breakdown.
		*/
		function mergeTree(sessions, list, rootId, rootStats, rootUsage) {
			const stats = { ...ZERO_STATS };
			const childStats = { ...ZERO_STATS };
			for (const key of STAT_KEYS) stats[key] = (rootStats?.[key] ?? 0);
			let usage = rootUsage === void 0 ? void 0 : { ...ZERO_USAGE };
			if (usage !== void 0) for (const key of USAGE_KEYS) usage[key] = rootUsage[key] ?? 0;
			let childUsage;
			const children = [];

			const byId = list?.byId ?? {};
			let descendantCount = 0;
			for (const childId of collectDescendants(byId, rootId)) {
				descendantCount += 1;
				const binding = sessions.binding(childId);
				const projections = binding?.session?.projections;
				const child = { id: childId, stats: void 0, usage: void 0 };
				if (projections !== void 0) {
					const s = projections.get("sessionStats");
					if (s !== void 0) {
						child.stats = s;
						for (const key of STAT_KEYS) {
							stats[key] += s[key] ?? 0;
							childStats[key] += s[key] ?? 0;
						}
					}
					const u = projections.get("tokenUsage");
					if (u !== void 0) {
						child.usage = u;
						if (usage === void 0) usage = { ...ZERO_USAGE };
						if (childUsage === void 0) childUsage = { ...ZERO_USAGE };
						for (const key of USAGE_KEYS) {
							usage[key] += u[key] ?? 0;
							childUsage[key] += u[key] ?? 0;
						}
					}
				}
				children.push(child);
			}
			return { stats, usage, childStats, childUsage, children, descendantCount };
		}

		/**
		* Build display groups as part arrays ({text, strong?}). The DOM strip and
		* the tooltip render the same groups; cache-hit / input / output values
		* are flagged (`strong`) for emphasis.
		*/
		function buildGroups(t, stats, usage) {
			const groups = [];
			if (stats.steps > 0) {
				groups.push([{ text: t("stats.counts", { turns: stats.turns, steps: stats.steps }) }]);
				const durations = [];
				if (stats.llmMs > 0) durations.push(t("stats.llm", { duration: formatDuration(stats.llmMs) }));
				if (stats.toolMs > 0) durations.push(t("stats.toolCall", { duration: formatDuration(stats.toolMs) }));
				if (durations.length > 0) groups.push([{ text: durations.join(" · ") }]);
				const speeds = [];
				if (stats.ttftSteps > 0) speeds.push(t("stats.ttftAverage", { duration: formatDuration(stats.ttftMs / stats.ttftSteps) }));
				if (stats.decodeMs > 0) speeds.push(t("stats.tokensPerSecond", { throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3)) }));
				if (speeds.length > 0) groups.push([{ text: speeds.join(" · ") }]);
			}
			if (usage !== void 0 && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
				const cacheHit = cacheHitPercent(usage);
				if (cacheHit !== null) groups.push([
					{ text: t("stats.cacheHitLabel") },
					{ text: `${cacheHit}%`, strong: true }
				]);
				groups.push([
					{ text: t("stats.tokensInputLabel") },
					{ text: `${formatTokens(billedInputTokens(usage))} tok`, strong: true },
					{ text: t("stats.tokensBetweenLabel") },
					{ text: `${formatTokens(usage.outputTokens)} tok`, strong: true }
				]);
			}
			return groups;
		}
		function groupToText(group) {
			return group.map((part) => part.text).join("");
		}
		function groupsToLine(groups) {
			return groups.map(groupToText).join(" | ");
		}

		// ── tooltip breakdown styles ────────────────────────────────────────────
		// Self-drawn bubble: the framework Tooltip caps at 50vw and wraps, which
		// makes long merged lines wrap. Here every row stays on ONE line
		// (white-space:nowrap), and the bubble itself only caps at the viewport.
		const BUBBLE = {
			position: "fixed",
			zIndex: 1200,
			maxWidth: "calc(100vw - 24px)",
			padding: "8px 12px",
			borderRadius: "8px",
			background: "var(--dsw-alias-tooltip-bg)",
			color: "var(--dsw-static-neutral-bluish-00)",
			fontSize: "11px",
			lineHeight: "16px",
			boxShadow: "var(--dsw-shadow-lv3)",
			pointerEvents: "none",
			whiteSpace: "nowrap"
		};
		const TT_BODY = {
			display: "grid",
			gridTemplateColumns: "auto 1fr",
			columnGap: "14px",
			rowGap: "8px",
			alignItems: "baseline",
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap"
		};
		// Wide breathing room between the value groups ("|" gets its own
		// margins instead of bare text spaces).
		const TT_SEP = {
			color: "rgba(255,255,255,0.35)",
			margin: "0 6px"
		};
		const TT_LABEL = {
			color: "rgba(255,255,255,0.88)"
		};
		const TT_VALUE = {
			minWidth: "0",
			whiteSpace: "nowrap"
		};
		const TT_SUB = {
			...TT_VALUE,
			color: "#ffffff"
		};
		// Emphasized key values (cache hit %, input/output tokens): amber on a
		// brighter chip so they pop against the bubble.
		const TT_STRONG = {
			color: "#ffd166",
			fontWeight: 700,
			backgroundColor: "rgba(255,255,255,0.18)",
			borderRadius: "4px",
			padding: "0 5px",
			margin: "0 1px"
		};
		// Distinct title colors: main session / sub-agents.
		const TT_TITLE_ROOT = "#6cb2ff";
		const TT_TITLE_CHILDREN = "#a78bfa";

		// ── the component ───────────────────────────────────────────────────────
		/**
		* @param props - session-scope standard kit: useSession / useProjection
		*   bound to the viewed session, useSessions over the global list,
		*   sessionId, and the locale seat `t` bound to this entry's NS.
		* @param sessions - the injected sessions service (binding resolution).
		*/
		function createMergedStatsLine(sessions) {
			return function MergedStatsLine({ useSession, useProjection, useSessions, sessionId, t }) {
				// Re-renders on every projection frame of any session and on list
				// changes (new/removed children).
				const list = useSessions((s) => s);
				const usage = useProjection("tokenUsage");
				const projected = useProjection("sessionStats");
				const settledNodes = useSession((s) => s.chat.legacy.nodes);
				const rootStats = projected ?? deriveFallbackStats(settledNodes);
				const merged = react.useMemo(
					() => mergeTree(sessions, list, sessionId, rootStats, usage),
					[sessions, list, sessionId, rootStats, usage]
				);

				const groups = buildGroups(t, merged.stats, merged.usage);
				// Full label for the hover tooltip, mirroring the shipped line
				// (the DOM renders "| " separators; the label uses " | ").
				const line = groupsToLine(groups);

				// Single-line fit: the strip never wraps or ellipsizes — when the
				// text is wider than its box, the font shrinks proportionally so
				// every figure stays visible on one line. The natural width is
				// measured by temporarily forcing 12px on the real element inside
				// the layout effect (reverted before paint), so the fit decision
				// is exact and deterministic (no oscillation). Hooks stay
				// unconditional (the early return below comes after them).
				const rootRef = react.useRef(null);
				const [fitFont, setFitFont] = react.useState(12);
				react.useLayoutEffect(() => {
					const el = rootRef.current;
					if (el === null) return;
					const measure = () => {
						if (el.clientWidth <= 0) return;
						// Measure the natural (12px) width by temporarily forcing
						// 12px, then RESTORE the previous inline value — clearing
						// would desync React's style diffing (an unchanged
						// fitFont state would never rewrite the DOM).
						const prev = el.style.fontSize;
						el.style.fontSize = "12px";
						const natural = el.scrollWidth;
						el.style.fontSize = prev;
						if (natural > el.clientWidth) {
							// 0.98 safety factor covers rounding; floor keeps the
							// chosen size always able to fit.
							setFitFont(Math.max(6, Math.floor(12 * (el.clientWidth / natural) * 0.98 * 10) / 10));
						} else {
							setFitFont(12);
						}
					};
					measure();
					if (typeof ResizeObserver === "undefined") return;
					const observer = new ResizeObserver(measure);
					observer.observe(el);
					return () => {
						observer.disconnect();
					};
				}, [line]);

				const [bubble, setBubble] = react.useState(null);
				const bubbleTimer = react.useRef(null);
				react.useEffect(() => () => {
					if (bubbleTimer.current !== null) clearTimeout(bubbleTimer.current);
				}, []);

				if (groups.length === 0) return null;

				// Tooltip: the main-vs-sub-agents breakdown. The merged total is
				// already fully visible in the strip itself, so no "合计" row.
				const showTooltip = merged.descendantCount > 0;
				const showBubble = () => {
					if (!showTooltip) return;
					const el = rootRef.current;
					if (el === null) return;
					const r = el.getBoundingClientRect();
					setBubble({ x: r.left + r.width / 2, top: r.top });
				};
				const onEnter = () => {
					if (bubbleTimer.current !== null) clearTimeout(bubbleTimer.current);
					bubbleTimer.current = setTimeout(showBubble, 500);
				};
				const onLeave = () => {
					if (bubbleTimer.current !== null) {
						clearTimeout(bubbleTimer.current);
						bubbleTimer.current = null;
					}
					setBubble(null);
				};

				const rows = [];
				const renderGroupParts = (group) => group.map((part, pi) => part.strong
					? react.createElement("span", { key: pi, style: TT_STRONG }, part.text)
					: react.createElement("span", { key: pi }, part.text)
				);
				const pushRow = (label, labelColor, groups) => {
					const textGroups = groups.filter((g) => g.length > 0);
					// Two grid cells per row: label (col 1) + value (col 2), so
					// every row's data starts at the same column (first-char
					// alignment across rows).
					rows.push(react.createElement(react.Fragment, { key: rows.length },
						react.createElement("span", {
							style: { ...TT_LABEL, ...(labelColor === void 0 ? {} : { color: labelColor }) }
						}, label),
						react.createElement("span", { style: TT_SUB },
							textGroups.length === 0 ? t("stats.tooltip.empty")
								: textGroups.map((group, gi) => react.createElement(react.Fragment, { key: gi },
									gi > 0 ? react.createElement("span", { style: TT_SEP }, "|") : null,
									renderGroupParts(group)
								))
						)
					));
				};
				if (merged.descendantCount > 0) {
					pushRow(t("stats.tooltip.root"), TT_TITLE_ROOT, buildGroups(t, rootStats, usage));
					pushRow(
						t("stats.tooltip.children", { count: merged.descendantCount }),
						TT_TITLE_CHILDREN,
						buildGroups(t, merged.childStats, merged.childUsage)
					);
					// Per-child rows when the tree is small enough to be useful.
					if (merged.children.length <= 5) {
						for (const child of merged.children) {
							const title = list.byId?.[child.id]?.displayTitle ?? child.id;
							const short = title.length > 22 ? `${title.slice(0, 22)}…` : title;
							pushRow(
								`· ${short}`,
								void 0,
								buildGroups(t, child.stats ?? ZERO_STATS, child.usage)
							);
						}
					}
				}

				const bubbleEl = bubble !== null && showTooltip ? react.createElement("div", {
					role: "tooltip",
					style: {
						...BUBBLE,
						left: bubble.x,
						top: bubble.top - 8,
						transform: "translate(-50%, -100%)"
					},
					children: react.createElement("div", { style: TT_BODY }, rows)
				}) : null;

				const stripContent = () => groups.map((group, i) => react.createElement(
					react.Fragment,
					{ key: i },
					i > 0 ? react.createElement(react.Fragment, null,
						react.createElement("span", { className: "dsh-subagent-stats-sep", "aria-hidden": true }, "|"),
						" "
					) : null,
					group.map((part, pi) => part.strong
						? react.createElement("span", { key: pi, className: "dsh-subagent-stats-strong" }, part.text)
						: react.createElement("span", { key: pi }, part.text)
					)
				));

				return react.createElement(react.Fragment, null,
					react.createElement("div", {
						ref: rootRef,
						className: "dsh-subagent-stats-root",
						style: { fontSize: `${fitFont}px` },
						onMouseEnter: onEnter,
						onMouseLeave: onLeave,
						onFocus: showBubble,
						onBlur: onLeave
					}, stripContent()),
					bubbleEl
				);
			};
		}

		// ── plugin body ─────────────────────────────────────────────────────────
		const inject = ["slots", "sessions", "locale"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-plugin-subagent-stats: dictionaries");
			const MergedStatsLine = createMergedStatsLine(ctx.sessions);
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "stats",
				// Lower priority than the shipped entry (0) shadows it for this
				// cell — the dock keeps exactly one "stats" line.
				priority: -1,
				order: 0,
				locale: NS
			}, MergedStatsLine));
		}

		module.exports = { inject, apply };
		return module.exports;
	}
});
