/**
 * E2E verification: plugin stats line + hover tooltip (full merged data and
 * main-vs-sub-agents breakdown).
 *
 * Usage: node e2e-tooltip.cjs <session-title-substring>
 */
const { chromium } = require("playwright-core");

// Optional override: set PW_CHROME to a specific Chromium executable; when
// unset, playwright-core resolves its own installed browser.
const EXECUTABLE = process.env.PW_CHROME;
const URL = "http://127.0.0.1:3080/";
const TITLE = process.argv[2] ?? "<your-session-title>";

(async () => {
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
	const line = (await page.textContent(".dsh-subagent-stats-root")).trim();
	const isTruncated = await page.evaluate(() => {
		const el = document.querySelector(".dsh-subagent-stats-root");
		return el.scrollWidth > el.clientWidth;
	});
	// "No data swallowed" checks: the strip must show its full tail (the last
	// group: "输出 … tok") and must not clip horizontally.
	const stripMetrics = await page.evaluate(() => {
		const el = document.querySelector(".dsh-subagent-stats-root");
		return {
			scrollWidth: el.scrollWidth,
			clientWidth: el.clientWidth,
			clientHeight: el.clientHeight
		};
	});
	const tailVisible = /输出 [\d.]+[KM]? tok/.test(line);

	// Hover and wait for the 500ms tooltip delay.
	await page.hover(".dsh-subagent-stats-root");
	await page.waitForTimeout(1200);
	const tooltip = await page.evaluate(() => {
		const el = document.querySelector('div[role="tooltip"]');
		if (!el) return null;
		const rows = Array.from(el.firstElementChild ? el.firstElementChild.children : []);
		const rowHeights = rows.map((r) => r.getBoundingClientRect().height);
		const wrapped = rowHeights.filter((h) => h > 20).length; // line-height 18px → wrapped rows exceed 20px
		// Title colors: first span of each content row (skip the divider).
		const contentRows = rows.filter((r) => r.getBoundingClientRect().height > 8);
		const labelColors = contentRows.map((r) => {
			const label = r.firstElementChild;
			return label ? getComputedStyle(label).color : null;
		});
		// Emphasized key values: spans with font-weight 600.
		const strongs = Array.from(el.querySelectorAll("span")).filter((s) => getComputedStyle(s).fontWeight === "600");
		// Strip-level emphasis (bottom stats line).
		const stripStrongs = Array.from(document.querySelectorAll(".dsh-subagent-stats-strong"));
		return {
			innerText: el.innerText,
			bubbleWidth: el.getBoundingClientRect().width,
			viewportWidth: window.innerWidth,
			rowCount: rows.length,
			rowHeights,
			wrappedRowCount: wrapped,
			labelColors,
			strongCount: strongs.length,
			strongTexts: strongs.map((s) => s.textContent),
			stripStrongCount: stripStrongs.length,
			stripStrongTexts: stripStrongs.map((s) => s.textContent)
		};
	});

	console.log(JSON.stringify({
		line,
		isTruncated,
		tailVisible,
		stripMetrics,
		tooltip,
		consoleErrors,
		pageErrors
	}, null, 2));
	await browser.close();
})().catch((err) => {
	console.error("E2E script failed:", err);
	process.exit(2);
});
