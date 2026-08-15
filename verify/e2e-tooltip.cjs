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
	// "No data swallowed, one line" checks: the strip must show its full tail,
	// stay on a single line (height ≈ 20px line + 4px padding), and not clip
	// horizontally (font shrinks to fit instead).
	const stripMetrics = await page.evaluate(() => {
		const el = document.querySelector(".dsh-subagent-stats-root");
		return {
			scrollWidth: el.scrollWidth,
			clientWidth: el.clientWidth,
			clientHeight: el.clientHeight,
			fontSize: getComputedStyle(el).fontSize
		};
	});
	const tailVisible = /输出 [\d.]+[KM]? tok/.test(line);
	const oneLine = stripMetrics.clientHeight <= 30;
	const noClip = stripMetrics.scrollWidth <= stripMetrics.clientWidth + 2;

	// Centering under the chat dialog: strip center must align with the
	// composer seat (chat column) center.
	const geometry = await page.evaluate(() => {
		const strip = document.querySelector(".dsh-subagent-stats-root");
		const seat = document.querySelector("[data-composer-seat]");
		const sr = strip.getBoundingClientRect();
		const seatR = seat ? seat.getBoundingClientRect() : null;
		return {
			stripCenterX: sr.left + sr.width / 2,
			seatCenterX: seatR ? seatR.left + seatR.width / 2 : null,
			stripLeft: sr.left,
			stripRight: sr.right,
			seatLeft: seatR ? seatR.left : null,
			seatRight: seatR ? seatR.right : null,
			seatTop: seatR ? seatR.top : null,
			stripTop: sr.top,
			stripBottom: sr.bottom
		};
	});
	const centered = geometry.seatCenterX !== null && Math.abs(geometry.stripCenterX - geometry.seatCenterX) < 3;
	const belowDialog = geometry.seatTop !== null && geometry.stripTop >= geometry.seatTop;

	// Hover and wait for the 500ms tooltip delay.
	await page.hover(".dsh-subagent-stats-root");
	await page.waitForTimeout(1200);
	const tooltip = await page.evaluate(() => {
		const el = document.querySelector('div[role="tooltip"]');
		if (!el) return null;
		const body = el.firstElementChild;
		const cells = body ? Array.from(body.children) : [];
		// Grid layout: each row = label + 5 data-group cells (6 cells).
		const PER_ROW = 6;
		const rowsArr = [];
		for (let i = 0; i + PER_ROW <= cells.length; i += PER_ROW) rowsArr.push(cells.slice(i, i + PER_ROW));
		const rowHeights = rowsArr.map((row) => Math.max(...row.map((c) => c.getBoundingClientRect().height)));
		const wrapped = rowHeights.filter((h) => h > 20).length; // line-height 16px → wrapped rows exceed 20px
		// Per-column alignment: every row's cell for the same column must start
		// at the same x (label, counts, LLM, TTFT, cache, tokens).
		const colLefts = [0, 1, 2, 3, 4, 5].map((ci) => rowsArr.map((row) => Math.round(row[ci].getBoundingClientRect().left)));
		const alignedCols = colLefts.map((xs) => xs.length > 0 && xs.every((x) => x === xs[0]));
		const aligned = alignedCols.every(Boolean);
		const labelColors = rowsArr.map((row) => getComputedStyle(row[0]).color);
		// Emphasized key values: spans with font-weight 700 (amber chip).
		const strongs = Array.from(el.querySelectorAll("span")).filter((s) => getComputedStyle(s).fontWeight === "700");
		// The bubble must CONTAIN every figure: no horizontal overflow beyond
		// its own box (font shrinks to fit instead).
		const contained = el.scrollWidth <= el.clientWidth + 2;
		// Strip-level emphasis (bottom stats line).
		const stripStrongs = Array.from(document.querySelectorAll(".dsh-subagent-stats-strong"));
		return {
			innerText: el.innerText,
			mergedRowAbsent: !el.innerText.includes("合计") && !el.innerText.includes("Total"),
			bubbleWidth: el.getBoundingClientRect().width,
			viewportWidth: window.innerWidth,
			bubbleFontSize: getComputedStyle(el).fontSize,
			contained,
			rowCount: rowsArr.length,
			rowHeights,
			wrappedRowCount: wrapped,
			labelColors,
			colLefts,
			alignedCols,
			aligned,
			strongCount: strongs.length,
			strongTexts: strongs.map((s) => s.textContent),
			strongColors: strongs.slice(0, 3).map((s) => getComputedStyle(s).color),
			stripStrongCount: stripStrongs.length,
			stripStrongTexts: stripStrongs.map((s) => s.textContent)
		};
	});

	console.log(JSON.stringify({
		line,
		isTruncated,
		tailVisible,
		oneLine,
		noClip,
		centered,
		belowDialog,
		stripMetrics,
		geometry,
		tooltip,
		consoleErrors,
		pageErrors
	}, null, 2));
	await browser.close();
})().catch((err) => {
	console.error("E2E script failed:", err);
	process.exit(2);
});
