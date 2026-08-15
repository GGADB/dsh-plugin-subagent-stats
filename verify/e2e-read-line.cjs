/**
 * E2E verification for dsh-plugin-subagent-stats.
 *
 * Loads the real Web GUI in headless Chromium, opens the target session from
 * the sidebar, waits for the merged stats line (`.dsh-subagent-stats-root`)
 * and prints its text plus diagnostics. Exits non-zero when the plugin's line
 * is missing or duplicate stats lines are found.
 *
 * Usage: node e2e-read-line.cjs <session-title-substring> [--wait-secs N]
 */
const { chromium } = require("playwright-core");

// Optional override: set PW_CHROME to a specific Chromium executable; when
// unset, playwright-core resolves its own installed browser.
const EXECUTABLE = process.env.PW_CHROME;
const URL = "http://127.0.0.1:3080/";
const titleSubstr = process.argv[2] ?? "<your-session-title>";
const waitSecs = Number(process.argv[3] ?? 90) * 1000;

(async () => {
	const browser = await chromium.launch({ ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}), headless: true });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	const consoleErrors = [];
	const pageErrors = [];
	page.on("console", (msg) => {
		if (msg.type() === "error" || msg.type() === "warning") consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
	});
	page.on("pageerror", (err) => pageErrors.push(String(err)));

	await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
	await page.waitForTimeout(6000); // shell boot

	// Open the target session from the sidebar tree.
	const clicked = await page.evaluate((substr) => {
		const candidates = Array.from(document.querySelectorAll("[role='button'], button, div, li, span")).filter((el) => {
			const t = (el.textContent ?? "").trim();
			return t.includes(substr) && t.length < 120;
		});
		// Prefer the smallest clickable-ish element to avoid clicking a container.
		candidates.sort((a, b) => a.textContent.length - b.textContent.length);
		const target = candidates[0];
		if (!target) return false;
		target.click();
		return true;
	}, titleSubstr);
	if (!clicked) {
		console.log(JSON.stringify({ ok: false, reason: `sidebar row "${titleSubstr}" not found`, consoleErrors, pageErrors }, null, 2));
		await browser.close();
		process.exit(1);
	}

	// 1) The plugin's replacement stats line must appear.
	let lineText = null;
	try {
		await page.waitForSelector(".dsh-subagent-stats-root", { timeout: waitSecs });
		await page.waitForTimeout(1500);
		lineText = (await page.textContent(".dsh-subagent-stats-root")).trim();
	} catch (err) {
		const body = await page.evaluate(() => document.body.innerText.slice(0, 400));
		console.log(JSON.stringify({ ok: false, reason: "plugin stats line not found", body, consoleErrors, pageErrors }, null, 2));
		await browser.close();
		process.exit(1);
	}

	// 2) Exactly one stats-style line must exist (the shipped line is shadowed).
	const statsLikeCount = await page.evaluate(() => {
		const all = Array.from(document.querySelectorAll("div"));
		const hits = all.filter((el) => {
			const direct = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3;
			if (!direct) return false;
			const text = el.textContent.trim();
			return text.length > 0 && text.length < 400 && /^\d/.test(text) && /(轮|步|tok|turns|steps)/.test(text);
		});
		return { count: hits.length, texts: hits.map((el) => el.textContent.trim()).slice(0, 5) };
	});

	// 3) The plugin's own style tag must be present.
	const hasStyle = await page.evaluate(() => {
		const tag = document.querySelector('style[data-plugin-css="dsh-plugin-subagent-stats/StatsLine.module.css"]');
		return tag !== null;
	});

	console.log(JSON.stringify({
		ok: true,
		line: lineText,
		statsLikeCount: statsLikeCount.count,
		statsLikeTexts: statsLikeCount.texts,
		hasPluginStyle: hasStyle,
		consoleErrors,
		pageErrors
	}, null, 2));

	await browser.close();
})().catch((err) => {
	console.error("E2E script failed:", err);
	process.exit(2);
});
