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
	let lastY: number | null = null;
	let lastX: number | null = null;
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

		const transform = item.transform;
		const x = transform?.[4] ?? 0;
		const y = transform?.[5] ?? 0;
		const fontSize = transform?.[0] ?? 12;

		if (lastY !== null && Math.abs(y - lastY) > fontSize * 0.5) {
			flushLine();
		} else if (
			lastX !== null &&
			x - lastX > fontSize * 0.3 &&
			lineBuffer.length > 0
		) {
			const last = lineBuffer[lineBuffer.length - 1];
			if (last && !last.endsWith(" ")) lineBuffer.push(" ");
		}

		lineBuffer.push(str);
		lineFontSize = Math.max(lineFontSize, fontSize);
		lastY = y;
		lastX = x + str.length * fontSize * 0.5;
	}

	flushLine();
	return lines;
}

function hasStr(item: unknown): item is { str: string; transform?: number[] } {
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
