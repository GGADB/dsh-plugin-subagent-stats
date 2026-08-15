/**
 * Final verification: browser-merged stats line vs. authoritative host
 * projections (root + descendant) from the projection cache.
 *
 * The root session is live (this conversation is still running), so the
 * projection cache (batched writes) and the browser (live push frames) can
 * straddle a snapshot. We read the cache before and after the browser read:
 * PASS requires the rendered line to match the expected root+child line of
 * EITHER snapshot byte-for-byte.
 */
const fs = require("fs");
const { chromium } = require("playwright-core");

// Machine-specific values are injected via environment variables; the
// defaults are placeholders. Set them before running:
//   DSH_ROOT_SESSION, DSH_CHILD_SESSION, DSH_PROJ_CACHE, PW_CHROME
const ROOT = process.env.DSH_ROOT_SESSION ?? "session-<your-root-session>";
const CHILD = process.env.DSH_CHILD_SESSION ?? "<your-subagent-session>";
const CACHE = process.env.DSH_PROJ_CACHE ?? "<dsh-home>/storages/session_projcache.json";
const EXECUTABLE = process.env.PW_CHROME;
const URL = "http://127.0.0.1:3080/";
const TITLE = "<your-session-title>";

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
function formatTps(tps) {
	const c = Math.max(0, tps);
	return c >= 10 ? String(Math.round(c)) : String(Math.round(c * 10) / 10);
}

function readCache() {
	const cache = JSON.parse(fs.readFileSync(CACHE, "utf8"));
	const tables = cache.tables.sessions;
	const get = (sid, key) => tables[sid]?.rows?.[key]?.val;
	return { rs: get(ROOT, "sessionStats"), ru: get(ROOT, "tokenUsage")?.totals, cs: get(CHILD, "sessionStats"), cu: get(CHILD, "tokenUsage")?.totals };
}

function expectedLine(rs, ru, cs, cu) {
	const m = {
		turns: rs.turns + cs.turns,
		steps: rs.steps + cs.steps,
		llmMs: rs.llmMs + cs.llmMs,
		toolMs: rs.toolMs + cs.toolMs,
		ttftMs: rs.ttftMs + cs.ttftMs,
		ttftSteps: rs.ttftSteps + cs.ttftSteps,
		decodeMs: rs.decodeMs + cs.decodeMs,
		decodeTokens: rs.decodeTokens + cs.decodeTokens,
		uncached: ru.uncachedInputTokens + cu.uncachedInputTokens,
		cacheRead: ru.cacheReadTokens + cu.cacheReadTokens,
		cacheWrite: ru.cacheWriteTokens + cu.cacheWriteTokens,
		output: ru.outputTokens + cu.outputTokens
	};
	const billed = m.uncached + m.cacheRead + m.cacheWrite;
	return [
		`${m.turns} 轮 · ${m.steps} 步`,
		`LLM ${formatDuration(m.llmMs)} · 工具调用 ${formatDuration(m.toolMs)}`,
		`首 token 平均 ${formatDuration(m.ttftMs / m.ttftSteps)} · ${formatTps(m.decodeTokens / (m.decodeMs / 1e3))} tok/s`,
		`缓存命中 ${(m.cacheRead / billed * 100).toFixed(2)}%`,
		`输入 ${formatTokens(billed)} tok · 输出 ${formatTokens(m.output)} tok`
	].join("| ");
}

(async () => {
	const before = readCache();
	if (!before.rs || !before.ru || !before.cs || !before.cu) {
		console.log(JSON.stringify({ ok: false, reason: "cache rows missing" }, null, 2));
		process.exit(1);
	}
	const expectedBefore = expectedLine(before.rs, before.ru, before.cs, before.cu);

	const browser = await chromium.launch({ ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}), headless: true });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	const consoleErrors = [];
	const pageErrors = [];
	page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
	page.on("pageerror", (err) => pageErrors.push(String(err)));
	await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
	await page.waitForTimeout(6000);
	await page.evaluate((substr) => {
		const candidates = Array.from(document.querySelectorAll("[role='button'], button, div, li, span")).filter((el) => {
			const t = (el.textContent ?? "").trim();
			return t.includes(substr) && t.length < 120;
		});
		candidates.sort((a, b) => a.textContent.length - b.textContent.length);
		candidates[0]?.click();
	}, TITLE);
	await page.waitForSelector(".dsh-subagent-stats-root", { timeout: 90000 });
	await page.waitForTimeout(1500);
	const actual = (await page.textContent(".dsh-subagent-stats-root")).trim();
	await browser.close();

	const after = readCache();
	const expectedAfter = expectedLine(after.rs, after.ru, after.cs, after.cu);

	const matchedBefore = actual === expectedBefore;
	const matchedAfter = actual === expectedAfter;
	const pass = (matchedBefore || matchedAfter) && consoleErrors.length === 0 && pageErrors.length === 0;

	console.log(JSON.stringify({
		ok: pass,
		actualLine: actual,
		expectedBefore,
		expectedAfter,
		matchedBefore,
		matchedAfter,
		rootBefore: before.rs,
		rootUsageBefore: before.ru,
		rootAfter: after.rs,
		rootUsageAfter: after.ru,
		child: before.cs,
		childUsage: before.cu,
		consoleErrors,
		pageErrors
	}, null, 2));
	process.exit(pass ? 0 : 1);
})().catch((err) => {
	console.error("verification failed:", err);
	process.exit(2);
});
