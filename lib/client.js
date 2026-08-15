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
		const runtime = require("@deepseek-ai/dsh-client-runtime/client");

		// ── user settings (persisted to localStorage) ───────────────────────────
		// Group slots: [0]=counts(轮/步), [1]=durations(LLM/工具), [2]=speeds
		// (首token/tok每秒), [3]=cache(缓存命中), [4]=tokens(输入/输出).
		const GROUP_KEYS = ["counts", "durations", "speeds", "cache", "tokens"];
		const DEFAULT_SETTINGS = Object.freeze({
			strip: [true, true, true, true, true],
			tooltip: [true, true, true, true, true],
			colors: Object.freeze({
				bubble: "#6a6e78",
				strong: "#679eff",
				c0: "#ffffff",
				c1: "#ffffff",
				c2: "#ffffff",
				c3: "#ffffff",
				c4: "#ffffff"
			})
		});
		const settingsStore = runtime.createSnapshotStore(DEFAULT_SETTINGS, { persist: { name: "dsh.subagentStats.settings" } });
		const useSettings = () => react.useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot);

		/** Zero out disabled group slots so hidden groups render nothing. */
		function applyVisibility(slots, mask) {
			return slots.map((slot, si) => (mask[si] === false ? [] : slot));
		}
		/** Merge a partial persisted value over the defaults (schema drift safe). */
		function normalizeSettings(raw) {
			const out = {
				strip: [true, true, true, true, true],
				tooltip: [true, true, true, true, true],
				colors: { ...DEFAULT_SETTINGS.colors }
			};
			if (raw !== null && typeof raw === "object") {
				if (Array.isArray(raw.strip)) GROUP_KEYS.forEach((_, i) => { if (typeof raw.strip[i] === "boolean") out.strip[i] = raw.strip[i]; });
				if (Array.isArray(raw.tooltip)) GROUP_KEYS.forEach((_, i) => { if (typeof raw.tooltip[i] === "boolean") out.tooltip[i] = raw.tooltip[i]; });
				if (raw.colors !== null && typeof raw.colors === "object") {
					for (const key of Object.keys(out.colors)) if (typeof raw.colors[key] === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.colors[key])) out.colors[key] = raw.colors[key];
				}
			}
			return out;
		}
		function normalizeHex(value, fallback) {
			return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
		}
		function hexToRgb(hex) {
			const n = parseInt(hex.slice(1), 16);
			return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
		}
		function rgbToHex(r, g, b) {
			const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
			return `#${c(r)}${c(g)}${c(b)}`;
		}

		// ── styles (mirror of the shipped StatsLine look) ───────────────────────
		const CSS = ".dsh-subagent-stats-root{text-align:center;max-width:var(--dsh-chat-content-width);box-sizing:border-box;width:100%;padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 0px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;margin:0 auto;font-size:12px;line-height:20px;display:block}.dsh-subagent-stats-sep{color:var(--dsw-alias-separator-primary);margin:0 10px}.dsh-subagent-stats-strong{color:var(--dsw-alias-label-secondary);font-weight:600}";
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
			// Compact variants for the bottom strip (full detail lives in the
			// hover bubble), so the strip stays readable at 12px.
			"stats.toolShort": "工具 {duration}",
			"stats.ttftShort": "首token {duration}",
			"stats.cacheShortLabel": "缓存 ",
			"stats.tokensShortInput": "输入 ",
			"stats.tokensShortBetween": " · 输出 ",
			"stats.tooltip.root": "主对话（当前会话）",
			"stats.tooltip.children": "子 agent（{count} 个）",
			"stats.tooltip.empty": "（无数据）",
			// Settings card copy.
			"settings.title": "更好的统计条",
			"settings.desc": "自定义底部数据栏与悬停气泡显示的内容和颜色",
			"settings.strip": "底部数据栏显示",
			"settings.tooltip": "悬停气泡显示",
			"settings.colors": "气泡颜色",
			"settings.g.counts": "轮次 · 步数",
			"settings.g.durations": "LLM · 工具耗时",
			"settings.g.speeds": "首 token · 速率",
			"settings.g.cache": "缓存命中",
			"settings.g.tokens": "输入 · 输出",
			"settings.col.bubble": "气泡背景",
			"settings.col.strong": "高亮数值",
			"settings.col.c0": "轮次 · 步数列",
			"settings.col.c1": "LLM · 工具耗时列",
			"settings.col.c2": "首 token · 速率列",
			"settings.col.c3": "缓存命中列",
			"settings.col.c4": "输入 · 输出列",
			"settings.rgb": "RGB",
			"settings.reset": "重置"
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
			// Compact variants for the bottom strip (full detail lives in the
			// hover bubble), so the strip stays readable at 12px.
			"stats.toolShort": "Tool {duration}",
			"stats.ttftShort": "TTFT {duration}",
			"stats.cacheShortLabel": "Cache ",
			"stats.tokensShortInput": "In ",
			"stats.tokensShortBetween": " · Out ",
			"stats.tooltip.root": "Main session",
			"stats.tooltip.children": "Sub-agents ({count})",
			"stats.tooltip.empty": "(no data)",
			// Settings card copy.
			"settings.title": "Better Stats Line",
			"settings.desc": "Customize what the bottom stats strip and hover bubble show and their colors",
			"settings.strip": "Bottom stats strip",
			"settings.tooltip": "Hover bubble",
			"settings.colors": "Bubble colors",
			"settings.g.counts": "Turns · steps",
			"settings.g.durations": "LLM · tool time",
			"settings.g.speeds": "TTFT · throughput",
			"settings.g.cache": "Cache hit",
			"settings.g.tokens": "Input · output",
			"settings.col.bubble": "Bubble background",
			"settings.col.strong": "Highlighted values",
			"settings.col.c0": "Turns · steps column",
			"settings.col.c1": "LLM · tool column",
			"settings.col.c2": "TTFT · throughput column",
			"settings.col.c3": "Cache hit column",
			"settings.col.c4": "Input · output column",
			"settings.rgb": "RGB",
			"settings.reset": "Reset"
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
		* Build display groups as FIXED 5-slot part arrays ({text, strong?}):
		* [counts, durations, speeds, cache-hit, tokens]. Missing slots are empty
		* arrays so rows keep the same column structure (per-group vertical
		* alignment). `compact` shortens labels and drops the "tok" suffix for
		* the bottom strip (the hover bubble keeps the full wording). Cache-hit /
		* input / output values are flagged (`strong`).
		*/
		function buildGroups(t, stats, usage, compact = false) {
			const slots = [[], [], [], [], []];
			if (stats.steps > 0) {
				slots[0].push({ text: t("stats.counts", { turns: stats.turns, steps: stats.steps }) });
				const durations = [];
				if (stats.llmMs > 0) durations.push(t("stats.llm", { duration: formatDuration(stats.llmMs) }));
				if (stats.toolMs > 0) durations.push(t(compact ? "stats.toolShort" : "stats.toolCall", { duration: formatDuration(stats.toolMs) }));
				if (durations.length > 0) slots[1].push({ text: durations.join(" · ") });
				const speeds = [];
				if (stats.ttftSteps > 0) speeds.push(t(compact ? "stats.ttftShort" : "stats.ttftAverage", { duration: formatDuration(stats.ttftMs / stats.ttftSteps) }));
				if (stats.decodeMs > 0) speeds.push(t("stats.tokensPerSecond", { throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3)) }));
				if (speeds.length > 0) slots[2].push({ text: speeds.join(" · ") });
			}
			if (usage !== void 0 && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
				const cacheHit = cacheHitPercent(usage);
				if (cacheHit !== null) slots[3].push(
					{ text: t(compact ? "stats.cacheShortLabel" : "stats.cacheHitLabel") },
					{ text: `${cacheHit}%`, strong: true }
				);
				const tokSuffix = compact ? "" : " tok";
				slots[4].push(
					{ text: t(compact ? "stats.tokensShortInput" : "stats.tokensInputLabel") },
					{ text: `${formatTokens(billedInputTokens(usage))}${tokSuffix}`, strong: true },
					{ text: t(compact ? "stats.tokensShortBetween" : "stats.tokensBetweenLabel") },
					{ text: `${formatTokens(usage.outputTokens)}${tokSuffix}`, strong: true }
				);
			}
			return slots;
		}
		function groupsToLine(slots) {
			return slots.filter((slot) => slot.length > 0).map((slot) => slot.map((part) => part.text).join("")).join(" | ");
		}

		// ── tooltip breakdown styles ────────────────────────────────────────────
		// Self-drawn bubble: the framework Tooltip caps at 50vw and wraps, which
		// makes long merged lines wrap. Here every row stays on ONE line
		// (white-space:nowrap), and the bubble itself only caps at the viewport.
		const BUBBLE = {
			position: "fixed",
			zIndex: 1200,
			width: "max-content",
			maxWidth: "calc(100vw - 24px)",
			padding: "8px 12px",
			borderRadius: "22px",
			background: "rgb(106, 110, 120)",
			// The tooltip bubble is dark in BOTH themes (page design), so its
			// text must be light unconditionally — label-primary resolves black
			// in the light theme and would be unreadable on the dark bubble.
			// The fill is a softened dark gray, and the corners match the
			// composer input card's 22px rounding.
			color: "var(--dsw-static-neutral-bluish-00)",
			border: "1px solid var(--dsw-alias-border-l2)",
			fontSize: "11px",
			lineHeight: "16px",
			boxShadow: "var(--dsw-shadow-lv3)",
			pointerEvents: "none",
			whiteSpace: "nowrap"
		};
		const TT_BODY = {
			display: "grid",
			// label + 5 fixed data-group columns: every row's groups align
			// vertically (counts / durations / speeds / cache / tokens).
			gridTemplateColumns: "auto auto auto auto auto auto",
			columnGap: "10px",
			rowGap: "8px",
			alignItems: "baseline",
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap"
		};
		const TT_CELL = {
			minWidth: "0",
			whiteSpace: "nowrap"
		};
		// Breathing room between the value groups ("|" gets its own margins),
		// in the page's muted border tone.
		const TT_SEP = {
			color: "var(--dsw-alias-border-l3)",
			margin: "0 4px"
		};
		// Readable on the dark bubble: labels use the page's light bluish-100
		// (label-secondary resolves too dark on tooltip-bg), values the primary
		// label token (near-white, theme-aware).
		const TT_LABEL = {
			color: "var(--dsw-static-neutral-bluish-100)"
		};
		// Emphasized key values (cache hit %, input/output tokens): the DeepSeek
		// brand blue on a soft chip — the page's own highlight language, bright
		// enough for the dark bubble.
		const TT_STRONG = {
			color: "var(--dsw-static-deepseek-400)",
			fontWeight: 700,
			backgroundColor: "rgba(255,255,255,0.12)",
			borderRadius: "4px",
			padding: "0 5px",
			margin: "0 1px"
		};
		// Distinct title colors: a very bright brand blue for the main session
		// and a very bright violet for sub-agents — readable on the softened
		// bubble.
		const TT_TITLE_ROOT = "#aed2ff";
		const TT_TITLE_CHILDREN = "#dcc8ff";

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
				const settings = useSettings();

				// The strip renders the COMPACT variant (readable at 12px); the
				// hover bubble keeps the full wording. User toggles zero out the
				// hidden group slots.
				const stripSlots = applyVisibility(buildGroups(t, merged.stats, merged.usage, true), settings.strip);
				// Full label for the hover tooltip, mirroring the shipped line
				// (the DOM renders "| " separators; the label uses " | ").
				const line = groupsToLine(stripSlots);

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
							// chosen size always able to fit. Minimum 10px keeps
							// the strip readable (compaction covers the rest).
							setFitFont(Math.max(10, Math.floor(12 * (el.clientWidth / natural) * 0.98 * 10) / 10));
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

				// Bubble fit: the black box must CONTAIN every figure — when the
				// grid is wider than the viewport cap, the bubble font shrinks
				// proportionally (natural width measured at the 11px base,
				// previous values restored, so no React style-desync).
				const bubbleRef = react.useRef(null);
				const [bubbleFont, setBubbleFont] = react.useState(11);
				react.useLayoutEffect(() => {
					const el = bubbleRef.current;
					if (el === null) {
						setBubbleFont(11);
						return;
					}
					const prevFont = el.style.fontSize;
					const prevMax = el.style.maxWidth;
					el.style.fontSize = "11px";
					el.style.maxWidth = "none";
					const natural = el.scrollWidth;
					el.style.fontSize = prevFont;
					el.style.maxWidth = prevMax;
					const avail = el.clientWidth;
					if (avail > 0 && natural > avail) {
						setBubbleFont(Math.max(6, Math.floor(11 * (avail / natural) * 0.98 * 10) / 10));
					} else {
						setBubbleFont(11);
					}
				}, [bubble !== null, line]);

				if (stripSlots.every((slot) => slot.length === 0)) return null;

				// Tooltip: the main-vs-sub-agents breakdown. The merged total is
				// already fully visible in the strip itself, so no "合计" row.
				// Hidden via the tooltip toggles when every group is off.
				const tooltipMask = settings.tooltip;
				const showTooltip = merged.descendantCount > 0 && tooltipMask.some(Boolean);
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
				const strongColor = normalizeHex(settings.colors.strong, "#679eff");
				const strongStyle = { ...TT_STRONG, color: strongColor };
				const renderGroupParts = (group) => group.map((part, pi) => part.strong
					? react.createElement("span", { key: pi, style: strongStyle }, part.text)
					: react.createElement("span", { key: pi }, part.text)
				);
				const pushRow = (label, labelColor, rowSlots) => {
					// Six grid cells per row: label + the five fixed group
					// columns, so every row's groups align vertically
					// (counts / LLM / TTFT / cache / tokens). Each column takes
					// its user-configured color.
					rows.push(react.createElement(react.Fragment, { key: rows.length },
						react.createElement("span", {
							style: { ...TT_LABEL, ...(labelColor === void 0 ? {} : { color: labelColor }) }
						}, label),
						rowSlots.map((slot, si) => react.createElement("span", {
							key: `g${si}`,
							style: { ...TT_CELL, color: normalizeHex(settings.colors[`c${si}`], "#ffffff") }
						},
							slot.length === 0 ? null : react.createElement(react.Fragment, null,
								si > 0 ? react.createElement("span", { style: TT_SEP }, "|") : null,
								renderGroupParts(slot)
							)
						))
					));
				};
				if (merged.descendantCount > 0) {
					pushRow(t("stats.tooltip.root"), TT_TITLE_ROOT, applyVisibility(buildGroups(t, rootStats, usage), tooltipMask));
					pushRow(
						t("stats.tooltip.children", { count: merged.descendantCount }),
						TT_TITLE_CHILDREN,
						applyVisibility(buildGroups(t, merged.childStats, merged.childUsage), tooltipMask)
					);
					// Per-child rows when the tree is small enough to be useful
					// (labels kept short so the label column stays narrow).
					if (merged.children.length <= 5) {
						for (const child of merged.children) {
							const title = list.byId?.[child.id]?.displayTitle ?? child.id;
							const short = title.length > 8 ? `${title.slice(0, 8)}…` : title;
							pushRow(
								`· ${short}`,
								void 0,
								applyVisibility(buildGroups(t, child.stats ?? ZERO_STATS, child.usage), tooltipMask)
							);
						}
					}
				}

				const bubbleEl = bubble !== null && showTooltip ? react.createElement("div", {
					ref: bubbleRef,
					role: "tooltip",
					style: {
						...BUBBLE,
						background: normalizeHex(settings.colors.bubble, "#6a6e78"),
						fontSize: `${bubbleFont}px`,
						left: bubble.x,
						top: bubble.top - 8,
						transform: "translate(-50%, -100%)"
					},
					children: react.createElement("div", { style: TT_BODY }, rows)
				}) : null;

				const visibleSlots = [];
				for (let si = 0; si < stripSlots.length; si++) if (stripSlots[si].length > 0) visibleSlots.push({ si, parts: stripSlots[si] });
				const stripContent = () => visibleSlots.map(({ si, parts }, i) => react.createElement(
					react.Fragment,
					{ key: si },
					i > 0 ? react.createElement(react.Fragment, null,
						react.createElement("span", { className: "dsh-subagent-stats-sep", "aria-hidden": true }, "|"),
						" "
					) : null,
					parts.map((part, pi) => part.strong
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

		// ── settings card (Settings → General) ──────────────────────────────────
		const CARD_STYLE = {
			padding: "14px 2px",
			display: "flex",
			flexDirection: "column",
			gap: "10px",
			borderBottom: "1px solid var(--dsw-alias-border-l2)"
		};
		const CARD_TITLE = { color: "var(--dsw-alias-label-primary)", fontSize: "14px", lineHeight: "22px" };
		const CARD_DESC = { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: "18px" };
		const CARD_HEADER = {
			display: "flex",
			alignItems: "center",
			gap: "12px",
			width: "100%",
			border: "none",
			background: "transparent",
			padding: "2px 0",
			cursor: "pointer",
			font: "inherit",
			textAlign: "left"
		};
		const CHEVRON = {
			color: "var(--dsw-alias-label-tertiary)",
			fontSize: "12px",
			flex: "none"
		};
		const SECTION_TITLE = { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: "18px", margin: "6px 0 2px" };
		const TOGGLE_ROW = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "2px 0" };
		const TOGGLE_LABEL = { color: "var(--dsw-alias-label-primary)", fontSize: "13px", lineHeight: "20px" };
		const COLOR_ROW = { display: "flex", alignItems: "center", gap: "8px", padding: "2px 0" };
		const COLOR_LABEL = { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: "18px", flex: "1" };
		const COLOR_PICKER = {
			width: "30px",
			height: "24px",
			padding: "1px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "6px",
			background: "transparent",
			cursor: "pointer"
		};
		const RGB_INPUT = {
			width: "46px",
			height: "24px",
			padding: "0 4px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "6px",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: "12px",
			textAlign: "center"
		};
		const RESET_BUTTON = {
			alignSelf: "flex-start",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "8px",
			background: "var(--dsw-alias-interactive-bg-hover)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: "12px",
			lineHeight: "18px",
			padding: "4px 12px",
			cursor: "pointer"
		};

		function ColorRow({ t, label, value, colorKey, onChange }) {
			const rgb = hexToRgb(normalizeHex(value, "#ffffff"));
			const setRgb = (i, v) => {
				const next = [...rgb];
				next[i] = v;
				onChange(rgbToHex(next[0], next[1], next[2]));
			};
			return react.createElement("div", { style: COLOR_ROW },
				react.createElement("span", { style: COLOR_LABEL }, label),
				react.createElement("input", {
					type: "color",
					value: normalizeHex(value, "#ffffff"),
					"data-stats-color": colorKey,
					style: COLOR_PICKER,
					onChange: (e) => onChange(e.target.value)
				}),
				react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px" } }, t("settings.rgb")),
				rgb.map((channel, i) => react.createElement("input", {
					key: i,
					type: "number",
					min: 0,
					max: 255,
					value: channel,
					"data-stats-color-rgb": `${colorKey}.${i}`,
					style: RGB_INPUT,
					onChange: (e) => setRgb(i, Number(e.target.value))
				}))
			);
		}

		function SettingsCard({ t }) {
			const [open, setOpen] = react.useState(false);
			const raw = useSettings();
			const settings = normalizeSettings(raw);
			const ensure = (draft) => {
				if (!Array.isArray(draft.strip)) draft.strip = [...DEFAULT_SETTINGS.strip];
				if (!Array.isArray(draft.tooltip)) draft.tooltip = [...DEFAULT_SETTINGS.tooltip];
				if (draft.colors === null || typeof draft.colors !== "object") draft.colors = { ...DEFAULT_SETTINGS.colors };
			};
			const setGroup = (section, index, value) => {
				settingsStore.update((draft) => {
					ensure(draft);
					draft[section][index] = value;
				});
			};
			const setColor = (key, hex) => {
				if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
				settingsStore.update((draft) => {
					ensure(draft);
					draft.colors[key] = hex.toLowerCase();
				});
			};
			const reset = () => {
				settingsStore.update((draft) => {
					draft.strip = [...DEFAULT_SETTINGS.strip];
					draft.tooltip = [...DEFAULT_SETTINGS.tooltip];
					draft.colors = { ...DEFAULT_SETTINGS.colors };
				});
			};
			const toggleRow = (section, index, value) => react.createElement("label", {
				key: `${section}.${index}`,
				style: TOGGLE_ROW
			},
				react.createElement("span", { style: TOGGLE_LABEL }, t(`settings.g.${GROUP_KEYS[index]}`)),
				react.createElement("input", {
					type: "checkbox",
					checked: value,
					"data-stats-toggle": `${section}.${GROUP_KEYS[index]}`,
					onChange: (e) => setGroup(section, index, e.target.checked)
				})
			);

			return react.createElement("div", { style: CARD_STYLE },
				react.createElement("button", {
					type: "button",
					style: CARD_HEADER,
					"data-stats-settings-toggle": "",
					"aria-expanded": open,
					onClick: () => setOpen((value) => !value)
				},
					react.createElement("span", { style: { display: "flex", flexDirection: "column", gap: "2px", flex: "1", textAlign: "left" } },
						react.createElement("span", { style: CARD_TITLE }, t("settings.title")),
						react.createElement("span", { style: CARD_DESC }, t("settings.desc"))
					),
					react.createElement("span", { style: CHEVRON, "aria-hidden": true }, open ? "▾" : "▸")
				),
				open ? react.createElement(react.Fragment, null,
					react.createElement("div", { style: SECTION_TITLE }, t("settings.strip")),
					settings.strip.map((value, i) => toggleRow("strip", i, value)),
					react.createElement("div", { style: SECTION_TITLE }, t("settings.tooltip")),
					settings.tooltip.map((value, i) => toggleRow("tooltip", i, value)),
					react.createElement("div", { style: SECTION_TITLE }, t("settings.colors")),
					react.createElement(ColorRow, {
						t, label: t("settings.col.bubble"), value: settings.colors.bubble, colorKey: "bubble",
						onChange: (hex) => setColor("bubble", hex)
					}),
					react.createElement(ColorRow, {
						t, label: t("settings.col.strong"), value: settings.colors.strong, colorKey: "strong",
						onChange: (hex) => setColor("strong", hex)
					}),
					GROUP_KEYS.map((key, i) => react.createElement(ColorRow, {
						key: key,
						t, label: t(`settings.col.c${i}`), value: settings.colors[`c${i}`], colorKey: `c${i}`,
						onChange: (hex) => setColor(`c${i}`, hex)
					})),
					react.createElement("button", {
						type: "button",
						style: RESET_BUTTON,
						"data-stats-reset": "",
						onClick: reset
					}, t("settings.reset"))
				) : null
			);
		}

		// ── plugin body ─────────────────────────────────────────────────────────
		const inject = ["slots", "sessions", "locale"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-plugin-subagent-stats: dictionaries");
			const t = ctx.locale.bind(NS);
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
			// Settings card inside the General section, as a collapsible
			// dropdown (collapsed by default so the section stays compact).
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "subagent-stats-settings",
				order: 30,
				locale: NS
			}, SettingsCard));
		}

		module.exports = { inject, apply };
		return module.exports;
	}
});
