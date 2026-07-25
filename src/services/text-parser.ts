import type JSZip from "jszip";
import type { PDFPageProxy } from "pdfjs-dist";
import type { ChapterInfo, ParsedDocument } from "../models/types.js";
import { countWords, htmlToPlainText } from "../utils/text-utils.js";

type JSZipStatic = typeof JSZip;

async function loadJSZip(): Promise<JSZipStatic> {
	const mod = await import("jszip");
	const JSZip =
		mod.default ??
		(mod as { t?: JSZipStatic }).t ??
		(mod as unknown as JSZipStatic);

	if (typeof JSZip?.loadAsync !== "function") {
		throw new Error(
			"Could not load the file parser. Please refresh the page and try again.",
		);
	}

	return JSZip;
}

function getElementsByLocalName(doc: Document, name: string): Element[] {
	const nsMatches = doc.getElementsByTagNameNS("*", name);
	if (nsMatches.length > 0) return Array.from(nsMatches);
	return Array.from(doc.getElementsByTagName(name));
}

function normalizeEpubPath(path: string): string {
	const parts = path.split("/");
	const stack: string[] = [];
	for (const part of parts) {
		if (part === "." || !part) continue;
		if (part === "..") {
			stack.pop();
		} else {
			stack.push(part);
		}
	}
	return stack.join("/");
}

function stripHrefFragment(href: string): string {
	const hash = href.indexOf("#");
	return hash >= 0 ? href.slice(0, hash) : href;
}

function findZipEntry(zip: JSZip, path: string): JSZip.JSZipObject | null {
	const candidates = new Set<string>();
	const add = (value: string) => {
		if (!value) return;
		candidates.add(value);
		candidates.add(normalizeEpubPath(value));
	};

	add(path);
	try {
		add(decodeURIComponent(path));
	} catch {
		/* malformed % sequences */
	}

	for (const candidate of candidates) {
		const entry = zip.file(candidate);
		if (entry) return entry;
	}

	const target = normalizeEpubPath(path).toLowerCase();
	let match: JSZip.JSZipObject | null = null;
	zip.forEach((relativePath, file) => {
		if (match) return;
		if (normalizeEpubPath(relativePath).toLowerCase() === target) {
			match = file;
		}
	});
	return match;
}

export async function parseFile(file: File): Promise<ParsedDocument> {
	const doc = await parseFileToDocument(file);
	return {
		...doc,
		sourceFile: file,
		sourceFileName: file.name,
		sourceMimeType: file.type || undefined,
	};
}

async function parseFileToDocument(file: File): Promise<ParsedDocument> {
	const ext = file.name.split(".").pop()?.toLowerCase();

	if (ext === "pdf") return parsePdf(file);
	if (ext === "docx") return parseDocx(file);
	if (ext === "doc") return parseDocLegacy(file);
	if (ext === "txt" || ext === "md") return parsePlainText(file);
	if (ext === "rtf") return parseRtf(file);
	if (ext === "html" || ext === "htm") return parseHtml(file);
	if (ext === "csv") return parseCsv(file);
	if (ext === "odt") return parseOdt(file);

	if (ext === "epub" || ext === "zip") {
		try {
			return await parseEpub(file);
		} catch (e) {
			if (ext === "zip")
				throw new Error(
					"Unsupported ZIP content. Only EPUB books in ZIP format are supported.",
				);
			throw e;
		}
	}

	try {
		const text = await file.text();
		if (text.trim().length > 0) {
			return {
				title: file.name.replace(/\.[^.]+$/, ""),
				text: cleanText(text),
				wordCount: countWords(text),
			};
		}
	} catch {
		/* no-op */
	}

	throw new Error(
		`Unsupported file type: .${ext ?? "unknown"}. Supported formats: PDF, DOCX, DOC, TXT, MD, EPUB, RTF, HTML, ODT, CSV.`,
	);
}

async function parsePlainText(file: File): Promise<ParsedDocument> {
	const text = await file.text();
	return {
		title: file.name.replace(/\.[^.]+$/, ""),
		text: cleanText(text),
		wordCount: countWords(text),
	};
}

interface PdfLine {
	text: string;
	/** Largest font size among the items making up this line. */
	fontSize: number;
}

/**
 * Groups a page's raw text items into visual lines, the same way for every
 * caller: a big vertical jump starts a new line, and a horizontal gap on the
 * same line gets a space inserted (pdf.js text items don't preserve word
 * breaks on their own). Shared by `extractPdfText` and `extractPdfChapters`
 * so heading text detected for a chapter anchor is byte-for-byte the same
 * string that ends up in the final document text.
 */
function buildPdfPageLines(
	items: Array<{ str?: string; transform?: number[] }>,
): PdfLine[] {
	let prev: PdfItemCursor | null = null;
	let lineFontSize = 0;
	const lineBuffer: string[] = [];
	const lines: PdfLine[] = [];

	const flushLine = () => {
		if (lineBuffer.length > 0) {
			lines.push({ text: lineBuffer.join(""), fontSize: lineFontSize });
			lineBuffer.length = 0;
			lineFontSize = 0;
		}
	};

	for (const item of items) {
		const str = item.str;
		if (!str) continue;

		const metrics = readPdfItemMetrics(item);
		const boundary = classifyPdfItemBoundary(
			prev,
			metrics,
			lineBuffer.length > 0,
		);

		if (boundary === "line") {
			flushLine();
		} else if (boundary === "gap") {
			const last = lineBuffer[lineBuffer.length - 1];
			if (last && !last.endsWith(" ")) lineBuffer.push(" ");
		}

		lineBuffer.push(str);
		lineFontSize = Math.max(lineFontSize, metrics.fontSize);
		prev = advancePdfItemCursor(metrics, str);
	}

	flushLine();
	return lines;
}

// ── Shared PDF text-item layout heuristics ─────────────────────────────────
//
// pdf.js text items carry no word or line breaks of their own, so both the
// line builder above and the search index below have to infer them from
// geometry. Keeping that inference in one place is what guarantees the two
// agree about where one word ends and the next begins.

interface PdfItemMetrics {
	x: number;
	y: number;
	fontSize: number;
}

/** Previous item's baseline y and estimated right edge. */
interface PdfItemCursor {
	endX: number;
	y: number;
}

function readPdfItemMetrics(item: { transform?: number[] }): PdfItemMetrics {
	const transform = item.transform;
	return {
		x: transform?.[4] ?? 0,
		y: transform?.[5] ?? 0,
		fontSize: transform?.[0] ?? 12,
	};
}

function advancePdfItemCursor(
	metrics: PdfItemMetrics,
	str: string,
): PdfItemCursor {
	return {
		endX: metrics.x + str.length * metrics.fontSize * 0.5,
		y: metrics.y,
	};
}

/**
 * "line" = a big enough vertical jump to be a new line; "gap" = a horizontal
 * gap wide enough to be a word break on the same line.
 */
function classifyPdfItemBoundary(
	prev: PdfItemCursor | null,
	metrics: PdfItemMetrics,
	hasBuffered: boolean,
): "line" | "gap" | "none" {
	if (prev === null) return "none";
	if (Math.abs(metrics.y - prev.y) > metrics.fontSize * 0.5) return "line";
	if (metrics.x - prev.endX > metrics.fontSize * 0.3 && hasBuffered)
		return "gap";
	return "none";
}

function hasStr(item: unknown): item is {
	str: string;
	transform?: number[];
	width?: number;
	height?: number;
} {
	return typeof item === "object" && item !== null && "str" in item;
}

async function extractPdfText(pdf: PdfDocumentLike): Promise<string> {
	const pageParts: string[] = [];
	for (let i = 1; i <= pdf.numPages; i++) {
		const page = await pdf.getPage(i);
		const content = await page.getTextContent();
		const lines = buildPdfPageLines(content.items.filter(hasStr));
		pageParts.push(lines.map((l) => l.text).join("\n"));
	}
	return cleanText(pageParts.join("\n\n"));
}

/**
 * Extracts one page's plain text, using the exact same line-building and
 * cleanup pipeline as full-document extraction, so the result is guaranteed
 * to appear as a literal substring of a `ParsedDocument.text` built from the
 * same PDF (e.g. for a "find this page's text in the reader" jump feature).
 */
export async function extractPdfPageText(page: PDFPageProxy): Promise<string> {
	const content = await page.getTextContent();
	const lines = buildPdfPageLines((content.items as unknown[]).filter(hasStr));
	return cleanText(lines.map((l) => l.text).join("\n"));
}

// ── In-page search & highlighting ──────────────────────────────────────────

export interface PdfTextItemLike {
	str: string;
	transform?: number[];
	width?: number;
	height?: number;
}

/** Where one character of the search text came from; null for a synthesized space, which has no glyph to highlight. */
type PdfSearchCharSource = { itemIndex: number; offset: number } | null;

export interface PdfPageSearchIndex {
	/**
	 * Case-folded page text with line wraps and word gaps alike collapsed to
	 * single spaces, so a phrase still matches when it wraps mid-line.
	 */
	text: string;
	/** One entry per character of `text`, mapping it back to the glyph it came from. */
	charMap: PdfSearchCharSource[];
	items: PdfTextItemLike[];
}

/** A highlight box as fractions (0–1) of the page, so it survives any render scale or panel width unchanged. */
export interface PdfHighlightRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** The parts of a pdf.js viewport the rect math needs; kept structural so tests can supply a plain object. */
export interface PdfHighlightViewport {
	transform: number[];
	width: number;
	height: number;
	scale?: number;
}

/**
 * Lowercases per code unit rather than via a plain `toLowerCase()` on the
 * whole string: a handful of characters (e.g. "İ") fold to two characters,
 * which would shift every following index out of step with `charMap`.
 */
function foldCase(text: string): string {
	let out = "";
	for (const ch of text.split("")) {
		const lower = ch.toLowerCase();
		out += lower.length === 1 ? lower : ch;
	}
	return out;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
	return ch !== undefined && WORD_CHAR.test(ch);
}

export function buildPdfPageSearchIndexFromItems(
	items: PdfTextItemLike[],
): PdfPageSearchIndex {
	let text = "";
	const charMap: PdfSearchCharSource[] = [];
	let prev: PdfItemCursor | null = null;

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const item = items[itemIndex];
		const str = item.str;
		if (!str) continue;

		const metrics = readPdfItemMetrics(item);
		// A wrap and a word gap are both just a space here — that's what lets a
		// query match across a line break.
		if (
			classifyPdfItemBoundary(prev, metrics, text.length > 0) !== "none" &&
			text.length > 0 &&
			!text.endsWith(" ")
		) {
			text += " ";
			charMap.push(null);
		}

		const folded = foldCase(str);
		for (let offset = 0; offset < folded.length; offset++) {
			text += folded[offset];
			charMap.push({ itemIndex, offset });
		}
		prev = advancePdfItemCursor(metrics, str);
	}

	return { text, charMap, items };
}

export async function buildPdfPageSearchIndex(
	page: PDFPageProxy,
): Promise<PdfPageSearchIndex> {
	const content = await page.getTextContent();
	return buildPdfPageSearchIndexFromItems(
		(content.items as unknown[]).filter(hasStr),
	);
}

/**
 * Every occurrence of `query` in an already-case-folded index text, as
 * [start, end) ranges. With `wholeWord`, a hit only counts when neither
 * neighbouring character is a letter/digit/underscore — checked directly
 * rather than with `\b`, which is ASCII-only in JavaScript.
 */
export function findMatchRanges(
	text: string,
	query: string,
	wholeWord: boolean,
): Array<[number, number]> {
	const needle = foldCase(query.trim());
	if (!needle) return [];

	const ranges: Array<[number, number]> = [];
	let from = 0;
	while (from <= text.length - needle.length) {
		const start = text.indexOf(needle, from);
		if (start === -1) break;
		const end = start + needle.length;
		if (
			!wholeWord ||
			(!isWordChar(text[start - 1]) && !isWordChar(text[end]))
		) {
			ranges.push([start, end]);
		}
		from = start + 1;
	}
	return ranges;
}

/** Same maths as pdfjs `Util.transform`, inlined so the rect helpers stay pure and synchronously testable. */
function multiplyTransform(m1: number[], m2: number[]): number[] {
	return [
		m1[0] * m2[0] + m1[2] * m2[1],
		m1[1] * m2[0] + m1[3] * m2[1],
		m1[0] * m2[2] + m1[2] * m2[3],
		m1[1] * m2[2] + m1[3] * m2[3],
		m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
		m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
	];
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * Box for the `[startOffset, endOffset)` slice of one item's string. The
 * slice's extent is interpolated from the item's total width by character
 * count — exact glyph advances aren't exposed, and for a highlight band the
 * approximation is visually indistinguishable.
 *
 * Assumes an upright viewport (`transform` may scale/flip, as pdf.js's
 * always does, but not rotate); on a rotated page the box would keep its
 * origin but run the wrong way, so the result is clamped to the page.
 */
function itemSliceRect(
	item: PdfTextItemLike,
	startOffset: number,
	endOffset: number,
	viewport: PdfHighlightViewport,
): PdfHighlightRect | null {
	const transform = item.transform;
	if (!transform || !viewport.width || !viewport.height) return null;

	const m = multiplyTransform(viewport.transform, transform);
	const fontHeight = Math.hypot(m[2], m[3]);
	const totalWidth = (item.width ?? 0) * (viewport.scale ?? 1);
	const len = item.str.length || 1;

	const left = m[4] + (startOffset / len) * totalWidth;
	const width = ((endOffset - startOffset) / len) * totalWidth;
	// m[5] sits on the baseline; the glyph body rises from there.
	const top = m[5] - fontHeight;

	if (width <= 0 || fontHeight <= 0) return null;
	return {
		left: clamp01(left / viewport.width),
		top: clamp01(top / viewport.height),
		width: clamp01(width / viewport.width),
		height: clamp01(fontHeight / viewport.height),
	};
}

/**
 * Turns match ranges into highlight boxes. A range covering more than one
 * item — because it spans a word gap or a line wrap — yields one box per
 * item, so a wrapped phrase is highlighted on both lines.
 */
export function rangesToRects(
	index: PdfPageSearchIndex,
	ranges: Array<[number, number]>,
	viewport: PdfHighlightViewport,
): PdfHighlightRect[] {
	const rects: PdfHighlightRect[] = [];

	for (const [start, end] of ranges) {
		let runItem = -1;
		let runStart = 0;
		let runEnd = 0;

		const flush = () => {
			if (runItem < 0) return;
			const rect = itemSliceRect(
				index.items[runItem],
				runStart,
				runEnd,
				viewport,
			);
			if (rect) rects.push(rect);
			runItem = -1;
		};

		for (let i = start; i < end; i++) {
			const source = index.charMap[i];
			if (!source) continue; // synthesized space — nothing drawn for it
			if (source.itemIndex !== runItem) {
				flush();
				runItem = source.itemIndex;
				runStart = source.offset;
			}
			runEnd = source.offset + 1;
		}
		flush();
	}

	return rects;
}

const CHAPTER_HEADING_PATTERN =
	/^(chapter|part|book|section|prologue|epilogue|introduction|preface|appendix)\b/i;

/**
 * Detects chapter/section headings on each page — either a short line in a
 * noticeably larger font than the rest of the page (a typical heading
 * style), or a line starting with a chapter-like keyword. Deliberately
 * simple: no PDF outline/bookmark resolution, just font size + keyword
 * heuristics, since the anchor only needs to be a literal substring of the
 * final text, not a precise structural model of the document.
 */
async function extractPdfChapters(
	pdf: PdfDocumentLike,
): Promise<ChapterInfo[]> {
	const chapters: ChapterInfo[] = [];
	const seen = new Set<string>();

	for (let i = 1; i <= pdf.numPages; i++) {
		const page = await pdf.getPage(i);
		const content = await page.getTextContent();
		const lines = buildPdfPageLines(content.items.filter(hasStr));
		if (lines.length === 0) continue;

		const sizes = [...lines.map((l) => l.fontSize)].sort((a, b) => a - b);
		const bodyFontSize = sizes[Math.floor(sizes.length / 2)] || 12;

		for (const line of lines) {
			const text = line.text.replace(/[ \t]{2,}/g, " ").trim();
			if (!text || text.length > 80) continue;

			const isLargeHeading = line.fontSize >= bodyFontSize * 1.3;
			const matchesKeyword = CHAPTER_HEADING_PATTERN.test(text);
			if (!isLargeHeading && !matchesKeyword) continue;
			if (seen.has(text)) continue;

			seen.add(text);
			chapters.push({ title: text, anchorText: text });
		}
	}

	return chapters;
}

interface PdfDocumentLike {
	numPages: number;
	getPage(pageNumber: number): Promise<{
		getTextContent(): Promise<{ items: unknown[] }>;
	}>;
}

/**
 * Lazily loads pdfjs-dist and points it at its worker script, once per page
 * load. Shared by text extraction and by the PDF page viewer so the worker
 * is only ever configured a single time.
 */
export async function loadPdfJs() {
	const pdfjs = await import("pdfjs-dist");
	if (!pdfjs.GlobalWorkerOptions.workerSrc) {
		const workerUrl = await import(
			"pdfjs-dist/legacy/build/pdf.worker.mjs?url"
		);
		pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default;
	}
	return pdfjs;
}

export interface PdfOutlineEntry {
	title: string;
	/** 1-based page number; null if the entry's destination couldn't be resolved to a page (or it's an external-url-only entry). */
	page: number | null;
	children: PdfOutlineEntry[];
}

export interface PdfOutlineNode {
	title: string;
	dest: string | unknown[] | null;
	url: string | null;
	items: unknown[];
}

interface PdfOutlineSource {
	getOutline(): Promise<PdfOutlineNode[] | null>;
	getDestination(id: string): Promise<unknown[] | null>;
	getPageIndex(ref: unknown): Promise<number>;
}

/**
 * Resolves a PDF's real embedded outline/bookmarks (as opposed to the
 * heuristic ChapterInfo/extractPdfChapters text anchors above) into a page
 * number per entry, for jumping the PDF page viewer directly to a chapter.
 */
export async function resolvePdfOutline(
	pdfDoc: PdfOutlineSource,
): Promise<PdfOutlineEntry[]> {
	const raw = await pdfDoc.getOutline();
	if (!raw || raw.length === 0) return [];

	async function resolveNode(node: PdfOutlineNode): Promise<PdfOutlineEntry> {
		let page: number | null = null;
		try {
			if (node.dest) {
				const destArray =
					typeof node.dest === "string"
						? await pdfDoc.getDestination(node.dest)
						: node.dest;
				const ref = destArray?.[0];
				if (ref !== undefined && ref !== null) {
					page = (await pdfDoc.getPageIndex(ref)) + 1;
				}
			}
		} catch {
			page = null;
		}
		const children = await Promise.all(
			((node.items ?? []) as PdfOutlineNode[]).map(resolveNode),
		);
		return { title: node.title, page, children };
	}

	return Promise.all(raw.map(resolveNode));
}

async function parsePdf(file: File): Promise<ParsedDocument> {
	const { getDocument } = await loadPdfJs();
	const arrayBuffer = await file.arrayBuffer();
	const pdf = await getDocument({ data: arrayBuffer }).promise;

	// Text extraction and chapter detection are independent passes over the
	// same pages — run them concurrently rather than interleaving them into
	// one pass, so each stays simple on its own.
	const [text, chapters] = await Promise.all([
		extractPdfText(pdf),
		extractPdfChapters(pdf),
	]);

	return {
		title: file.name.replace(/\.pdf$/i, ""),
		text,
		wordCount: countWords(text),
		chapters: chapters.length > 0 ? chapters : undefined,
	};
}

async function parseDocx(file: File): Promise<ParsedDocument> {
	const mammoth = await import("mammoth");
	const arrayBuffer = await file.arrayBuffer();
	const result = await mammoth.extractRawText({ arrayBuffer });
	const text = cleanText(result.value);
	return {
		title: file.name.replace(/\.docx$/i, ""),
		text,
		wordCount: countWords(text),
	};
}

async function parseDocLegacy(file: File): Promise<ParsedDocument> {
	try {
		const mammoth = await import("mammoth");
		const arrayBuffer = await file.arrayBuffer();
		const result = await mammoth.extractRawText({ arrayBuffer });
		if (result.value.trim().length > 0) {
			const text = cleanText(result.value);
			return {
				title: file.name.replace(/\.doc$/i, ""),
				text,
				wordCount: countWords(text),
			};
		}
	} catch {
		/* mammoth failed */
	}
	const buffer = await file.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	const chars: string[] = [];
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i];
		if (b >= 0x20 && b < 0x7f) chars.push(String.fromCharCode(b));
		else if (b === 0x0a || b === 0x0d) chars.push("\n");
	}
	const raw = chars.join("").replace(/[^\x20-\x7e\n]{3,}/g, " ");
	const text = cleanText(raw);
	if (text.trim().length < 50) {
		throw new Error(
			"Could not extract text from this .doc file. Try saving it as .docx or .txt first.",
		);
	}
	return {
		title: file.name.replace(/\.doc$/i, ""),
		text,
		wordCount: countWords(text),
	};
}

async function parseRtf(file: File): Promise<ParsedDocument> {
	const raw = await file.text();
	let text = raw
		.replace(/\{[^{}]*\}/g, " ")
		.replace(/\\[a-z]+\d*\s?/gi, "")
		.replace(/\\\*/g, "")
		.replace(/[{}\\]/g, "")
		.replace(/\r\n|\r/g, "\n");
	text = cleanText(text);
	if (text.trim().length < 10) {
		throw new Error(
			"Could not extract text from this RTF file. Try saving it as .txt or .docx.",
		);
	}
	return {
		title: file.name.replace(/\.rtf$/i, ""),
		text,
		wordCount: countWords(text),
	};
}

async function parseHtml(file: File): Promise<ParsedDocument> {
	const raw = await file.text();
	const text = cleanText(htmlToPlainText(raw));
	const titleMatch = raw.match(/<title[^>]*>([^<]+)<\/title>/i);
	return {
		title: titleMatch?.[1]?.trim() ?? file.name.replace(/\.html?$/i, ""),
		text,
		wordCount: countWords(text),
	};
}

function parseCsvRow(row: string): string[] {
	const cells: string[] = [];
	let current = "";
	let inQuotes = false;
	for (let i = 0; i < row.length; i++) {
		const ch = row[i];
		if (ch === '"') {
			if (inQuotes && row[i + 1] === '"') {
				current += '"';
				i++;
			} else {
				inQuotes = !inQuotes;
			}
		} else if (ch === "," && !inQuotes) {
			cells.push(current.trim());
			current = "";
		} else {
			current += ch;
		}
	}
	cells.push(current.trim());
	return cells;
}

async function parseCsv(file: File): Promise<ParsedDocument> {
	const raw = await file.text();
	const text = cleanText(
		raw
			.split(/\r?\n/)
			.map((row) => parseCsvRow(row).filter(Boolean).join(" "))
			.filter(Boolean)
			.join("\n"),
	);
	return {
		title: file.name.replace(/\.csv$/i, ""),
		text,
		wordCount: countWords(text),
	};
}

async function parseOdt(file: File): Promise<ParsedDocument> {
	const JSZip = await loadJSZip();
	let zip: import("jszip");
	try {
		zip = await JSZip.loadAsync(await file.arrayBuffer());
	} catch {
		throw new Error("Could not open ODT file as a valid archive.");
	}
	const contentFile = zip.file("content.xml");
	if (!contentFile) {
		throw new Error("Invalid ODT: content.xml not found.");
	}
	const xmlStr = await contentFile.async("string");
	const text = cleanText(htmlToPlainText(xmlStr));
	return {
		title: file.name.replace(/\.odt$/i, ""),
		text,
		wordCount: countWords(text),
	};
}

async function parseEpub(file: File): Promise<ParsedDocument> {
	const JSZip = await loadJSZip();
	let zip: import("jszip");
	try {
		zip = await JSZip.loadAsync(await file.arrayBuffer());
	} catch {
		throw new Error("Could not open file as a valid archive.");
	}

	const opfFile = await findOpfFile(zip);
	if (!opfFile)
		throw new Error("Invalid EPUB: No content manifest (OPF) found.");

	const opfContent = await opfFile.async("string");
	const parser = new DOMParser();
	const opfDoc = parser.parseFromString(opfContent, "text/xml");

	const spineItems = extractSpineFromDoc(opfDoc);
	const manifestMap = extractManifestFromDoc(opfDoc);

	const basePath = opfFile.name.includes("/")
		? opfFile.name.substring(0, opfFile.name.lastIndexOf("/") + 1)
		: "";

	const parts: string[] = [];
	for (const idref of spineItems) {
		const href = stripHrefFragment(manifestMap[idref]);
		if (!href) continue;

		const fullPath = basePath + href;
		const entry = findZipEntry(zip, fullPath) ?? findZipEntry(zip, href);
		if (!entry) continue;

		const html = await entry.async("string");
		parts.push(htmlToPlainText(html));
	}

	if (parts.length === 0) {
		throw new Error("EPUB appears to be empty or encrypted (DRM protected).");
	}

	const text = cleanText(parts.join("\n\n"));
	const title =
		extractEpubTitleFromDoc(opfDoc) ?? file.name.replace(/\.(epub|zip)$/i, "");

	return { title, text, wordCount: countWords(text) };
}

async function findOpfFile(zip: JSZip) {
	const containerFile = findZipEntry(zip, "META-INF/container.xml");
	if (!containerFile) return null;

	const containerContent = await containerFile.async("string");
	const parser = new DOMParser();
	const containerDoc = parser.parseFromString(containerContent, "text/xml");
	const rootFile =
		containerDoc.querySelector("rootfile") ??
		getElementsByLocalName(containerDoc, "rootfile")[0] ??
		null;
	const fullPath = rootFile?.getAttribute("full-path");

	return fullPath ? findZipEntry(zip, fullPath) : null;
}

function extractManifestFromDoc(doc: Document): Record<string, string> {
	const manifestItems: Record<string, string> = {};
	for (const item of getElementsByLocalName(doc, "item")) {
		const id = item.getAttribute("id");
		const href = item.getAttribute("href");
		if (id && href) manifestItems[id] = href;
	}
	return manifestItems;
}

function extractSpineFromDoc(doc: Document): string[] {
	const spineItems: string[] = [];
	for (const itemref of getElementsByLocalName(doc, "itemref")) {
		const idref = itemref.getAttribute("idref");
		if (idref) spineItems.push(idref);
	}
	return spineItems;
}

function extractEpubTitleFromDoc(doc: Document): string | null {
	const titles = getElementsByLocalName(doc, "title");
	const dcTitle = titles.find(
		(el) => el.namespaceURI === "http://purl.org/dc/elements/1.1/",
	);
	const titleEl = dcTitle ?? titles[0];
	return titleEl?.textContent?.trim() ?? null;
}

function cleanText(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function applyBionicReading(text: string): string {
	return text
		.split(" ")
		.map((word) => {
			const clean = word.replace(/[^\p{L}\p{N}]/gu, "");
			if (clean.length === 0) return escapeHtml(word);
			const leadingPunct = word.match(/^[^\p{L}\p{N}]*/u)?.[0] ?? "";
			const boldLen =
				leadingPunct.length + Math.max(1, Math.ceil(clean.length * 0.4));
			return `<b>${escapeHtml(word.slice(0, boldLen))}</b>${escapeHtml(word.slice(boldLen))}`;
		})
		.join(" ");
}

export function createDocFromText(
	text: string,
	title = "Untitled",
): ParsedDocument {
	const cleaned = cleanText(text);
	return {
		title,
		text: cleaned,
		wordCount: countWords(cleaned),
	};
}
