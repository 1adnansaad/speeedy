import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	applyBionicReading,
	buildPdfPageSearchIndexFromItems,
	createDocFromText,
	findMatchRanges,
	type PdfOutlineNode,
	type PdfTextItemLike,
	parseFile,
	rangesToRects,
	resolvePdfOutline,
} from "./text-parser.js";

describe("applyBionicReading", () => {
	it("wraps the first ~40% of each word in bold tags", () => {
		const result = applyBionicReading("hello");
		// "hello" has 5 chars, 40% = 2 → bold first 2 chars
		expect(result).toBe("<b>he</b>llo");
	});

	it("handles single character word", () => {
		const result = applyBionicReading("a");
		// 1 char, ceil(0.4) = 1 → entire word bolded
		expect(result).toBe("<b>a</b>");
	});

	it("handles two character word", () => {
		const result = applyBionicReading("hi");
		// 2 chars, ceil(0.8) = 1 → bold first 1 char
		expect(result).toBe("<b>h</b>i");
	});

	it("processes multiple words", () => {
		const result = applyBionicReading("hello world");
		expect(result).toContain("<b>");
		expect(result).toContain("</b>");
		// Should have two bold segments
		const boldCount = (result.match(/<b>/g) ?? []).length;
		expect(boldCount).toBe(2);
	});

	it("escapes HTML special characters in word content", () => {
		const result = applyBionicReading("a&b");
		expect(result).toContain("&amp;");
	});

	it("handles words with punctuation", () => {
		const result = applyBionicReading("hello,");
		// "hello," has 6 chars, clean = "hello" (5 chars), boldLen = ceil(5*0.4) = 2
		// bold first 2 chars of "hello,"
		expect(result).toContain("<b>he</b>");
	});

	it("handles empty string", () => {
		const result = applyBionicReading("");
		expect(result).toBe("");
	});

	it("handles punctuation-only word", () => {
		const result = applyBionicReading("...");
		// clean = "" (no letters/numbers), returns escaped word
		expect(result).toBe("...");
	});

	it("escapes angle brackets", () => {
		const result = applyBionicReading("a<b");
		expect(result).toContain("&lt;");
	});

	it("escapes quotes", () => {
		const result = applyBionicReading('say"hi"');
		expect(result).toContain("&quot;");
	});
});

describe("parseFile (EPUB)", () => {
	it("extracts text and title from a valid EPUB", async () => {
		const buffer = readFileSync(
			join(import.meta.dirname, "../../test-fixtures/sample.epub"),
		);
		const file = new File([buffer], "sample.epub", {
			type: "application/epub+zip",
		});

		const doc = await parseFile(file);

		expect(doc.title).toBe("Test Book");
		expect(doc.text).toContain("Hello EPUB world");
		expect(doc.wordCount).toBeGreaterThan(0);
	});
});

describe("createDocFromText", () => {
	it("creates a document with the given text", () => {
		const doc = createDocFromText("Hello world");
		expect(doc.text).toBe("Hello world");
	});

	it("uses default title 'Untitled' when not provided", () => {
		const doc = createDocFromText("Some text");
		expect(doc.title).toBe("Untitled");
	});

	it("uses provided title", () => {
		const doc = createDocFromText("Some text", "My Book");
		expect(doc.title).toBe("My Book");
	});

	it("counts words correctly", () => {
		const doc = createDocFromText("one two three four five");
		expect(doc.wordCount).toBe(5);
	});

	it("cleans up excessive whitespace", () => {
		const doc = createDocFromText("hello   world");
		expect(doc.text).toBe("hello world");
	});

	it("normalizes Windows line endings", () => {
		const doc = createDocFromText("line one\r\nline two");
		expect(doc.text).not.toContain("\r");
		expect(doc.text).toContain("\n");
	});

	it("collapses more than 2 consecutive newlines to 2", () => {
		const doc = createDocFromText("para one\n\n\n\npara two");
		expect(doc.text).toBe("para one\n\npara two");
	});

	it("trims leading and trailing whitespace", () => {
		const doc = createDocFromText("   hello world   ");
		expect(doc.text).toBe("hello world");
	});

	it("returns wordCount of 0 for empty text", () => {
		const doc = createDocFromText("");
		expect(doc.wordCount).toBe(0);
	});

	it("handles text with only whitespace", () => {
		const doc = createDocFromText("   \n\n   ");
		expect(doc.text).toBe("");
		expect(doc.wordCount).toBe(0);
	});
});

describe("resolvePdfOutline", () => {
	// Minimal fake matching the pdf.js surface resolvePdfOutline actually calls.
	function fakePdfDoc(overrides: {
		outline: PdfOutlineNode[] | null;
		destinations?: Record<string, unknown[] | null>;
		pageIndexOf?: (ref: unknown) => number;
		failPageIndex?: boolean;
	}) {
		return {
			getOutline: async () => overrides.outline,
			getDestination: async (id: string) =>
				overrides.destinations?.[id] ?? null,
			getPageIndex: async (ref: unknown) => {
				if (overrides.failPageIndex) throw new Error("bad ref");
				return overrides.pageIndexOf ? overrides.pageIndexOf(ref) : 0;
			},
		};
	}

	it("returns an empty array when the PDF has no outline", async () => {
		const result = await resolvePdfOutline(fakePdfDoc({ outline: null }));
		expect(result).toEqual([]);
	});

	it("resolves an array dest directly via getPageIndex", async () => {
		const doc = fakePdfDoc({
			outline: [{ title: "Chapter 1", dest: ["ref-1"], url: null, items: [] }],
			pageIndexOf: () => 4,
		});
		const result = await resolvePdfOutline(doc);
		expect(result).toEqual([{ title: "Chapter 1", page: 5, children: [] }]);
	});

	it("resolves a string dest via getDestination first", async () => {
		const doc = fakePdfDoc({
			outline: [
				{ title: "Chapter 2", dest: "named-dest", url: null, items: [] },
			],
			destinations: { "named-dest": ["ref-2"] },
			pageIndexOf: () => 9,
		});
		const result = await resolvePdfOutline(doc);
		expect(result).toEqual([{ title: "Chapter 2", page: 10, children: [] }]);
	});

	it("resolves nested items and preserves order", async () => {
		const doc = fakePdfDoc({
			outline: [
				{
					title: "Part I",
					dest: ["ref-part1"],
					url: null,
					items: [
						{ title: "Ch 1", dest: ["ref-ch1"], url: null, items: [] },
						{ title: "Ch 2", dest: ["ref-ch2"], url: null, items: [] },
					],
				},
			],
			pageIndexOf: (ref) => {
				if (ref === "ref-part1") return 0;
				if (ref === "ref-ch1") return 1;
				return 5;
			},
		});
		const result = await resolvePdfOutline(doc);
		expect(result).toEqual([
			{
				title: "Part I",
				page: 1,
				children: [
					{ title: "Ch 1", page: 2, children: [] },
					{ title: "Ch 2", page: 6, children: [] },
				],
			},
		]);
	});

	it("leaves page null for an external-link entry with no dest", async () => {
		const doc = fakePdfDoc({
			outline: [
				{
					title: "External link",
					dest: null,
					url: "https://example.com",
					items: [],
				},
			],
		});
		const result = await resolvePdfOutline(doc);
		expect(result).toEqual([
			{ title: "External link", page: null, children: [] },
		]);
	});

	it("degrades a single unresolvable entry to page: null without throwing", async () => {
		const doc = fakePdfDoc({
			outline: [
				{ title: "Broken", dest: ["bad-ref"], url: null, items: [] },
				{ title: "Fine", dest: ["good-ref"], url: null, items: [] },
			],
			failPageIndex: true,
		});
		const result = await resolvePdfOutline(doc);
		expect(result).toEqual([
			{ title: "Broken", page: null, children: [] },
			{ title: "Fine", page: null, children: [] },
		]);
	});
});

describe("PDF in-page search", () => {
	// pdf.js text-item shape: transform is [fontSize, 0, 0, fontSize, x, y]
	// with y a baseline in PDF space (origin bottom-left).
	function item(
		str: string,
		x: number,
		y: number,
		width: number,
		fontSize = 12,
	): PdfTextItemLike {
		return {
			str,
			width,
			height: fontSize,
			transform: [fontSize, 0, 0, fontSize, x, y],
		};
	}

	// A scale-1, unrotated viewport for a 600x800 page, as pdf.js builds it.
	const viewport = {
		transform: [1, 0, 0, -1, 0, 800],
		width: 600,
		height: 800,
		scale: 1,
	};

	describe("findMatchRanges", () => {
		it("finds every occurrence of a substring by default", () => {
			const ranges = findMatchRanges("start art heart", "art", false);
			expect(ranges).toEqual([
				[2, 5],
				[6, 9],
				[12, 15],
			]);
		});

		it("keeps only standalone words when wholeWord is set", () => {
			const ranges = findMatchRanges("start art heart", "art", true);
			expect(ranges).toEqual([[6, 9]]);
		});

		it("treats punctuation as a word boundary", () => {
			expect(findMatchRanges("(art), art.", "art", true)).toEqual([
				[1, 4],
				[7, 10],
			]);
		});

		it("does not treat digits or underscores as boundaries", () => {
			expect(findMatchRanges("art1 _art", "art", true)).toEqual([]);
		});

		it("returns nothing for an empty or whitespace query", () => {
			expect(findMatchRanges("some text", "   ", false)).toEqual([]);
		});

		it("matches case-insensitively", () => {
			expect(findMatchRanges("the habit", "HABIT", false)).toEqual([[4, 9]]);
		});
	});

	describe("buildPdfPageSearchIndexFromItems", () => {
		it("case-folds text and maps each character back to its item", () => {
			const index = buildPdfPageSearchIndexFromItems([
				item("Habit", 100, 700, 30),
			]);
			expect(index.text).toBe("habit");
			expect(index.charMap[0]).toEqual({ itemIndex: 0, offset: 0 });
			expect(index.charMap[4]).toEqual({ itemIndex: 0, offset: 4 });
		});

		it("joins a line wrap with a space so a phrase matches across it", () => {
			// Second item sits a line lower, which the line builder would treat
			// as a newline — here it becomes a space instead.
			const index = buildPdfPageSearchIndexFromItems([
				item("highly", 100, 700, 36),
				item("effective", 100, 680, 54),
			]);
			expect(index.text).toBe("highly effective");
			expect(findMatchRanges(index.text, "highly effective", false)).toEqual([
				[0, 16],
			]);
			// The synthesized space maps to no glyph.
			expect(index.charMap[6]).toBeNull();
		});

		it("inserts a space for a wide horizontal gap on the same line", () => {
			const index = buildPdfPageSearchIndexFromItems([
				item("one", 100, 700, 18),
				item("two", 400, 700, 18),
			]);
			expect(index.text).toBe("one two");
		});

		it("skips empty items without disturbing the mapping", () => {
			const index = buildPdfPageSearchIndexFromItems([
				item("ab", 100, 700, 12),
				{ str: "", width: 0, transform: [12, 0, 0, 12, 130, 700] },
			]);
			expect(index.text).toBe("ab");
			expect(index.charMap).toHaveLength(2);
		});
	});

	describe("rangesToRects", () => {
		it("positions a whole-item match as page fractions", () => {
			const index = buildPdfPageSearchIndexFromItems([
				item("habit", 100, 700, 60),
			]);
			const rects = rangesToRects(index, [[0, 5]], viewport);

			expect(rects).toHaveLength(1);
			// x=100 of 600 wide; baseline 700 flips to y=100, glyph top 100-12=88.
			expect(rects[0].left).toBeCloseTo(100 / 600, 5);
			expect(rects[0].top).toBeCloseTo(88 / 800, 5);
			expect(rects[0].width).toBeCloseTo(60 / 600, 5);
			expect(rects[0].height).toBeCloseTo(12 / 800, 5);
		});

		it("covers only the matched slice of a longer item", () => {
			// "art" inside "start": chars 2..5 of 5, so 40% in, 60% wide.
			const index = buildPdfPageSearchIndexFromItems([
				item("start", 100, 700, 50),
			]);
			const rects = rangesToRects(
				index,
				findMatchRanges(index.text, "art", false),
				viewport,
			);

			expect(rects).toHaveLength(1);
			expect(rects[0].left).toBeCloseTo((100 + 0.4 * 50) / 600, 5);
			expect(rects[0].width).toBeCloseTo((0.6 * 50) / 600, 5);
		});

		it("emits one rect per line for a match spanning a wrap", () => {
			const index = buildPdfPageSearchIndexFromItems([
				item("highly", 100, 700, 36),
				item("effective", 100, 680, 54),
			]);
			const rects = rangesToRects(
				index,
				findMatchRanges(index.text, "highly effective", false),
				viewport,
			);

			expect(rects).toHaveLength(2);
			expect(rects[0].top).toBeCloseTo(88 / 800, 5);
			expect(rects[1].top).toBeCloseTo(108 / 800, 5);
		});

		it("keeps every rect within the page", () => {
			const index = buildPdfPageSearchIndexFromItems([
				item("edge", 580, 10, 400),
				item("over", -50, 900, 200),
			]);
			const rects = rangesToRects(index, [[0, index.text.length]], viewport);

			for (const rect of rects) {
				for (const value of [rect.left, rect.top, rect.width, rect.height]) {
					expect(value).toBeGreaterThanOrEqual(0);
					expect(value).toBeLessThanOrEqual(1);
				}
			}
		});

		it("drops items with no transform rather than throwing", () => {
			const index = buildPdfPageSearchIndexFromItems([
				{ str: "habit", width: 30 },
			]);
			expect(rangesToRects(index, [[0, 5]], viewport)).toEqual([]);
		});
	});
});
