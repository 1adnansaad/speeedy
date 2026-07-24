import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type {
	ParsedDocument,
	ReaderSettings,
	UserProfile,
} from "../models/types.js";
import { audioService } from "../services/audio-service.js";
import { DEFAULT_SETTINGS } from "../services/defaults.js";
import {
	type PlaybackState,
	RSVPEngine,
	tokenize,
	type WordToken,
} from "../services/rsvp-engine.js";
import { recordSession } from "../services/stats-service.js";
import {
	getSavedDocument,
	getSavedDocuments,
	saveDocument,
	updateDocumentProgress,
} from "../services/storage-service.js";
import {
	applyBionicReading,
	extractPdfPageText,
	loadPdfJs,
	type PdfOutlineEntry,
	resolvePdfOutline,
} from "../services/text-parser.js";
import { applyTheme } from "../services/theme-service.js";
import { trackEvent, wpmBracket } from "../utils/analytics.js";
import { emitProfileUpdated, navigate, showToast } from "../utils/events.js";
import { stripCitations } from "../utils/text-utils.js";
import "./settings-panel.ts";
import "./wellness-overlay.ts";

@customElement("rsvp-reader")
export class RsvpReader extends LitElement {
	protected override createRenderRoot() {
		return this;
	}

	@property({ type: Object }) profile!: UserProfile;
	@property({ type: Object }) pendingDoc: ParsedDocument | null = null;
	@property({ type: String }) savedDocId: string | null = null;
	@property({ type: Number }) resumeWordIndex = 0;

	@state() private engine = new RSVPEngine();
	@state() private playbackState: PlaybackState | null = null;
	@state() private settings!: ReaderSettings;
	@state() private showSettings = true;
	@state() private showShortcuts = false;
	@state() private sessionStartTime: number | null = null;
	@state() private wordsAtSessionStart = 0;
	@state() private docTitle = "";
	@state() private totalDocWords = 0;
	@state() private isCountingDown = false;
	@state() private countdownNumber = 0;
	@state() private isProgressHovered = false;
	@state() private isSeeking = false;
	@state() private seekWordIndex: number | null = null;
	@state() private showPdfViewer = false;
	@state() private pdfBlob: Blob | null = null;
	@state() private pdfPageNum = 1;
	@state() private pdfPageCount = 0;
	/** height/width of an unscaled page, used to reserve correct scroll space for pages that haven't rendered yet. */
	@state() private pdfPageAspectRatio = 1.4;
	private pdfDocProxy: PDFDocumentProxy | null = null;
	/** One wide-margin IntersectionObserver per mounted scroll container, used only to prefetch/evict page canvases. */
	private _pdfObservers = new Map<Element, IntersectionObserver>();
	/** One viewport-only IntersectionObserver per mounted scroll container, used to detect the actual current page. */
	private _pdfPageObservers = new Map<Element, IntersectionObserver>();
	/** Intersection ratio of every actually-visible page (no rootMargin), used to pick the "current" page for the pager. */
	private _pdfVisibleRatios = new Map<number, number>();
	/**
	 * True while a deliberate jump's smooth-scroll animation is still in
	 * flight. Pages transiting through the tight viewport mid-animation would
	 * otherwise fight the jump — the visibility observer fires repeatedly on
	 * whatever page briefly fills the screen as it scrolls past, overwriting
	 * pdfPageNum away from the intended target until the scroll finally
	 * settles. Suppressing pdfPageNum updates until settle means a jump always
	 * wins outright instead of racing its own animation.
	 */
	private _pdfProgrammaticScroll = false;
	private _pdfScrollSettleTimer: ReturnType<typeof setTimeout> | null = null;
	@state() private showPageJumpModal = false;
	@state() private pageJumpLoading = false;
	@state() private pageJumpTokens: WordToken[] = [];
	@state() private pageJumpWordTarget = 3;
	@state() private pageJumpAnchorStart: number | null = null;
	@state() private showPdfSearch = false;
	@state() private pdfSearchQuery = "";
	@state() private pdfSearchMatches: number[] = [];
	@state() private pdfSearchActiveIndex = -1;
	@state() private pdfSearchLoading = false;
	@state() private showChaptersPanel = false;
	/** Whether the current PDF has a resolvable outline — drives the Chapters button's disabled state. */
	@state() private pdfHasOutline = false;
	/** Resolved outline for the currently loaded PDF, fetched once per document like _pdfPageTextCache below. */
	private _pdfOutline: PdfOutlineEntry[] = [];
	/** Extracted page text, cached so re-searching or re-opening the jump-to-reader modal doesn't re-extract the same page. */
	private _pdfPageTextCache = new Map<number, string>();
	private _pdfSearchedQuery = "";
	private wasPlayingBeforeSeek = false;
	private countdownTimer: ReturnType<typeof setTimeout> | null = null;
	private seekingPointerId: number | null = null;
	/** Periodic auto-save timer — saves reading position every 15 s while playing. */
	private _autoSaveTimer: ReturnType<typeof setInterval> | null = null;
	/** Stores the raw (unprocessed) document text so we can re-tokenize when settings like removeCitations change. */
	private rawDocText = "";

	// ── Ticker mode bookkeeping ──────────────────────────────────────────────

	private _handleResize = (): void => {
		if (this.settings?.tickerMode && this.playbackState) {
			requestAnimationFrame(() => this._positionTicker());
		} else if (this.playbackState) {
			requestAnimationFrame(() => this._positionMarquee());
		}
	};

	private keyHandler = (e: KeyboardEvent): void => {
		if (
			e.target instanceof HTMLInputElement ||
			e.target instanceof HTMLTextAreaElement
		)
			return;
		switch (e.key) {
			case " ":
				e.preventDefault();
				this.togglePlay();
				break;
			case "ArrowRight":
				this.emit("settings-change", {
					wpm: Math.min(1600, this.settings.wpm + 25),
				});
				break;
			case "ArrowLeft":
				this.emit("settings-change", {
					wpm: Math.max(50, this.settings.wpm - 25),
				});
				break;
			case "ArrowUp":
				this.engine.seekBy(-(this.settings.rewindStep ?? 5));
				break;
			case "ArrowDown":
				this.engine.seekBy(this.settings.rewindStep ?? 5);
				break;
			case "r":
			case "R":
				this.engine.stop();
				break;
			case "Escape":
				void this.handleBack();
				break;
			case "?":
				this.showShortcuts = !this.showShortcuts;
				break;
			case "f":
			case "F":
				e.preventDefault();
				this.emit("settings-change", {
					focusModeEnabled: !this.settings.focusModeEnabled,
				});
				break;
		}
	};

	/**
	 * Intercepts paste events inside the active reader window.
	 * If the user pastes while not focused in an input/textarea, instantly
	 * creates a new document, loads it into the reader, and resets progress.
	 */
	private handleGlobalPaste = async (e: ClipboardEvent): Promise<void> => {
		if (
			e.target instanceof HTMLInputElement ||
			e.target instanceof HTMLTextAreaElement
		)
			return;

		const text = e.clipboardData?.getData("text/plain")?.trim();
		if (!text) return;

		// Stop active playback
		const state = this.engine.getState();
		if (state.playing) {
			this.engine.pause();
			audioService.stopAmbientNoise();
			this._stopAutoSave();
		}

		const wordCount = text.split(/\s+/).filter(Boolean).length;
		if (wordCount === 0) return;

		const saved = await saveDocument({
			title: "Pasted Text",
			text,
			wordCount,
			resumeWordIndex: 0,
			completionPercent: 0,
		});

		this.savedDocId = saved.id;
		this.resumeWordIndex = 0;
		this.loadDoc({
			title: saved.title,
			text: saved.text,
			wordCount: saved.wordCount,
		});

		showToast("Text loaded from clipboard ✓", "success");
		trackEvent("clipboard-paste-reader", { words: wordCount });
	};

	private emit(type: string, detail: Partial<ReaderSettings>): void {
		this.handleSettingsChange(
			new CustomEvent(type, { detail: { ...this.settings, ...detail } }),
		);
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.settings = {
			...DEFAULT_SETTINGS,
			...this.profile.settings,
		};

		this.engine.on("word", (s) => {
			this.playbackState = s;
			if (s.playing) {
				const w = s.currentTokens[0]?.text ?? "";
				if (this.settings.clickSoundEnabled) {
					const type = /[.!?]$/.test(w)
						? "sentence"
						: /[,;:]$/.test(w)
							? "comma"
							: "tick";
					audioService.playTick(type, this.settings.clickSoundPitch ?? 1.0);
				}
			}
		});
		this.engine.on("progress", (s) => {
			this.playbackState = s;
		});
		this.engine.on("stateChange", (s) => {
			this.playbackState = s;
		});
		this.engine.on("complete", (s) => {
			this.playbackState = s;
			this.saveSession(s);
			this.persistProgress(s);
			audioService.stopAmbientNoise();
			if (s.totalWords > 0) {
				const wpm =
					s.elapsedMs > 0 ? Math.round((s.wordIndex / s.elapsedMs) * 60000) : 0;
				trackEvent("reader-completed", {
					wpm_bracket: wpmBracket(wpm),
					words: s.totalWords,
				});
			}
		});

		if (this.pendingDoc) {
			this.loadDoc(this.pendingDoc);
			if (this.savedDocId) {
				localStorage.setItem("speeedy:last-doc-id", this.savedDocId);
			}
			void this._loadPdfSourceIfAny();
		} else {
			void this.restoreLastDocument();
		}

		window.addEventListener("keydown", this.keyHandler);
		window.addEventListener("resize", this._handleResize);
		window.addEventListener("beforeunload", this.handleUnload);
		document.addEventListener("visibilitychange", this.handleVisibilityChange);
		document.addEventListener("paste", this.handleGlobalPaste);
	}

	private async restoreLastDocument() {
		const docs = await getSavedDocuments();
		if (docs.length === 0) return;

		const lastId = localStorage.getItem("speeedy:last-doc-id");
		let docToLoad = docs.find((d) => d.id === lastId);
		if (!docToLoad) {
			docToLoad = docs[0];
			localStorage.setItem("speeedy:last-doc-id", docToLoad.id);
		}

		this.savedDocId = docToLoad.id;
		this.resumeWordIndex = docToLoad.resumeWordIndex;
		this.loadDoc({
			title: docToLoad.title,
			text: docToLoad.text,
			wordCount: docToLoad.wordCount,
			chapters: docToLoad.chapters,
		});
		void this._loadPdfSourceIfAny();
	}

	/** Looks up the saved document's original file and, if it's a PDF, keeps the blob around for the PDF viewer sidebar. */
	private async _loadPdfSourceIfAny(): Promise<void> {
		if (!this.savedDocId) return;
		const saved = await getSavedDocument(this.savedDocId);
		if (!saved?.sourceFile) return;
		const isPdf =
			saved.sourceMimeType === "application/pdf" ||
			saved.sourceFileName?.toLowerCase().endsWith(".pdf");
		if (isPdf) this.pdfBlob = saved.sourceFile;
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this._stopAutoSave();
		void this.persistProgress(this.engine.getState());
		this.engine.stop();
		audioService.stopAmbientNoise();
		window.removeEventListener("keydown", this.keyHandler);
		window.removeEventListener("resize", this._handleResize);
		this._rtlResizeObserver?.disconnect();
		this._rtlResizeObserver = null;
		window.removeEventListener("beforeunload", this.handleUnload);
		document.removeEventListener(
			"visibilitychange",
			this.handleVisibilityChange,
		);
		document.removeEventListener("paste", this.handleGlobalPaste);
		this._disconnectPdfObservers();
		this.pdfDocProxy?.destroy();
		this.pdfDocProxy = null;
		this._pdfOutline = [];
		this.pdfHasOutline = false;
	}

	protected override updated(
		changedProperties: Map<string | number | symbol, unknown>,
	): void {
		super.updated(changedProperties);
		if (
			this.playbackState &&
			!this.playbackState.playing &&
			(this.settings.pauseView === "fulltext" ||
				this.settings.pauseView === "context")
		) {
			requestAnimationFrame(() => {
				const activeWord = this.renderRoot.querySelector("#current-pause-word");
				if (activeWord) {
					activeWord.scrollIntoView({ behavior: "smooth", block: "center" });
				}
			});
		}

		// Ticker: position the strip via DOM measurement after every render.
		if (this.settings?.tickerMode && this.playbackState) {
			requestAnimationFrame(() => this._positionTicker());
		} else if (this.playbackState) {
			// Ambient marquee: glide the strip to the new current word after every render.
			requestAnimationFrame(() => this._positionMarquee());
		}

		this.alignRtlPivot();
	}

	/** RTL pivot alignment; updated on resize, not each word. */
	private _rtlPivotOffset = 0;
	private _rtlResizeObserver: ResizeObserver | null = null;

	private alignRtlPivot() {
		const measurer = this.renderRoot.querySelector(
			"#rtl-measurer",
		) as HTMLElement;
		const pivot = this.renderRoot.querySelector("#rtl-pivot") as HTMLElement;
		const shifter = this.renderRoot.querySelector(
			"#rtl-shifter",
		) as HTMLElement;

		if (!measurer || !pivot || !shifter) return;

		if (!this._rtlResizeObserver) {
			this._rtlResizeObserver = new ResizeObserver(() => {
				this._recalcRtlPivot();
			});
			this._rtlResizeObserver.observe(measurer);
		}

		shifter.style.transform = `translateX(${this._rtlPivotOffset}px)`;
	}

	private _recalcRtlPivot() {
		const measurer = this.renderRoot.querySelector(
			"#rtl-measurer",
		) as HTMLElement;
		const pivot = this.renderRoot.querySelector("#rtl-pivot") as HTMLElement;
		const shifter = this.renderRoot.querySelector(
			"#rtl-shifter",
		) as HTMLElement;

		if (!measurer || !pivot || !shifter) return;

		const mRect = measurer.getBoundingClientRect();
		const pRect = pivot.getBoundingClientRect();

		const mCenter = mRect.left + mRect.width / 2;
		const pCenter = pRect.left + pRect.width / 2;
		this._rtlPivotOffset = mCenter - pCenter;
		shifter.style.transform = `translateX(${this._rtlPivotOffset}px)`;
	}

	private static readonly RESUME_LOOKBACK_WORDS = 12;

	private loadDoc(doc: ParsedDocument): void {
		this._disconnectPdfObservers();
		this.pdfDocProxy?.destroy();
		this.pdfDocProxy = null;
		this.pdfBlob = null;
		this.pdfPageCount = 0;
		this.pdfPageNum = 1;
		this.pdfPageAspectRatio = 1.4;
		this.showPdfViewer = false;
		this._closePageJumpModal();
		this._closePdfSearch();
		this._closeChaptersPanel();
		this._pdfPageTextCache.clear();
		this._pdfOutline = [];
		this.pdfHasOutline = false;
		this.docTitle = doc.title;
		this.totalDocWords = doc.wordCount;
		this.rawDocText = doc.text;
		const textToLoad = this.settings.removeCitations
			? stripCitations(doc.text)
			: doc.text;
		this.engine.load(textToLoad, this.settings);
		if (this.resumeWordIndex > 0) {
			const startIndex = Math.max(
				0,
				this.resumeWordIndex - RsvpReader.RESUME_LOOKBACK_WORDS,
			);
			this.engine.seekToWord(startIndex);
			this.wordsAtSessionStart = startIndex;
		} else {
			this.wordsAtSessionStart = this.resumeWordIndex;
		}
		this.sessionStartTime = null;
	}

	private togglePlay(): void {
		const state = this.engine.getState();

		if (this.isCountingDown) {
			this.isCountingDown = false;
			if (this.countdownTimer) {
				clearTimeout(this.countdownTimer);
				this.countdownTimer = null;
			}
			return;
		}

		if (state.playing) {
			this.engine.pause();
			audioService.stopAmbientNoise();
			this._stopAutoSave();
			void this.persistProgress(this.engine.getState());
		} else {
			this.showSettings = false;
			if (!this.sessionStartTime) {
				this.sessionStartTime = Date.now();
				this.wordsAtSessionStart = state.wordIndex;
			}

			if (this.settings.countdownEnabled) {
				this.isCountingDown = true;
				this.countdownNumber = 3;

				const tick = () => {
					if (!this.isCountingDown) return;
					if (this.countdownNumber > 1) {
						this.countdownNumber--;
						this.countdownTimer = setTimeout(tick, 800);
					} else {
						this.isCountingDown = false;
						this.countdownTimer = null;
						this.engine.play(this.settings);
						audioService.setAmbientNoise(
							this.settings.ambientNoise,
							this.settings.ambientVolume,
						);
						this._startAutoSave();
					}
				};
				this.countdownTimer = setTimeout(tick, 800);
			} else {
				this.engine.play(this.settings);
				audioService.setAmbientNoise(
					this.settings.ambientNoise,
					this.settings.ambientVolume,
				);
				this._startAutoSave();
			}
		}
	}

	private handleSettingsChange(e: CustomEvent): void {
		const newSettings = e.detail as ReaderSettings;
		const citationsToggled =
			newSettings.removeCitations !== this.settings.removeCitations;
		this.settings = newSettings;
		this.engine.setWpm(newSettings);
		applyTheme(newSettings.theme);

		// Re-tokenize when the citations toggle changes
		if (citationsToggled && this.rawDocText) {
			const currentIndex = this.engine.getState().wordIndex;
			const textToLoad = newSettings.removeCitations
				? stripCitations(this.rawDocText)
				: this.rawDocText;
			this.engine.load(textToLoad, newSettings);
			this.engine.seekToWord(
				Math.min(currentIndex, this.engine.tokens.length - 1),
			);
		}

		const updatedProfile: UserProfile = {
			...this.profile,
			settings: newSettings,
		};
		emitProfileUpdated(updatedProfile);
	}

	private saveSession(state: PlaybackState): void {
		if (!this.sessionStartTime) return;
		const durationMs = Date.now() - this.sessionStartTime;
		const wordsRead = state.wordIndex - this.wordsAtSessionStart;
		if (wordsRead < 10 || durationMs < 5000) return;

		const wpm = Math.round((wordsRead / durationMs) * 60000);
		const completionPercent = Math.round(
			(state.wordIndex / state.totalWords) * 100,
		);

		const updatedProfile = recordSession(this.profile, {
			date: new Date().toISOString(),
			sourceTitle: this.docTitle,
			wordCount: this.totalDocWords,
			wordsRead,
			wpm,
			durationMs,
			completionPercent,
		});

		emitProfileUpdated(updatedProfile);
		this.sessionStartTime = Date.now();
		this.wordsAtSessionStart = state.wordIndex;
	}

	private async handleBack(): Promise<void> {
		const state = this.engine.getState();
		if (state.playing) {
			this.engine.pause();
			this.saveSession(state);
		}
		this._stopAutoSave();
		// Await the DB write so the library page always reads the correct position.
		await this.persistProgress(state);
		navigate("app");
	}

	private async persistProgress(state: PlaybackState): Promise<void> {
		if (!this.savedDocId || state.totalWords === 0) return;
		const completionPercent = Math.round(
			(state.wordIndex / state.totalWords) * 100,
		);
		await updateDocumentProgress(
			this.savedDocId,
			state.wordIndex,
			completionPercent,
		);
	}

	/** Start saving the reading position every 15 seconds while playing. */
	private _startAutoSave(): void {
		if (this._autoSaveTimer !== null) return; // already running
		this._autoSaveTimer = setInterval(() => {
			void this.persistProgress(this.engine.getState());
		}, 15_000);
	}

	/** Clear the auto-save interval. */
	private _stopAutoSave(): void {
		if (this._autoSaveTimer === null) return;
		clearInterval(this._autoSaveTimer);
		this._autoSaveTimer = null;
	}

	private handleUnload = (): void => {
		this.persistProgress(this.engine.getState());
	};

	private handleVisibilityChange = (): void => {
		if (document.visibilityState === "hidden") {
			this.persistProgress(this.engine.getState());
		}
	};

	/** How many pages beyond the visible range stay rendered, so small scroll jitters don't thrash the canvas cache. */
	private static readonly PDF_KEEP_WINDOW = 6;

	private _togglePdfViewer(): void {
		if (this.showPdfViewer) {
			this._closePdfViewer();
			return;
		}
		this.showSettings = false;
		this.showPdfViewer = true;
		void this._ensurePdfLoaded();
	}

	/** Closing unmounts the mobile sheet's scroll container, so its observer must be torn down too — recreated fresh on next open. */
	private _closePdfViewer(): void {
		this.showPdfViewer = false;
		this._disconnectPdfObservers();
		this._closePageJumpModal();
		this._closePdfSearch();
	}

	private async _ensurePdfLoaded(): Promise<void> {
		if (!this.pdfDocProxy && this.pdfBlob) {
			const { getDocument } = await loadPdfJs();
			const arrayBuffer = await this.pdfBlob.arrayBuffer();
			this.pdfDocProxy = await getDocument({ data: arrayBuffer }).promise;
			this.pdfPageCount = this.pdfDocProxy.numPages;
			this.pdfPageNum = 1;
			const firstPage = await this.pdfDocProxy.getPage(1);
			const unscaled = firstPage.getViewport({ scale: 1 });
			this.pdfPageAspectRatio = unscaled.height / unscaled.width;

			// Fire-and-forget: resolving dest→page for every outline entry must
			// not block first paint or observer setup below.
			void resolvePdfOutline(this.pdfDocProxy)
				.then((outline) => {
					this._pdfOutline = outline;
					this.pdfHasOutline = outline.length > 0;
				})
				.catch(() => {
					this._pdfOutline = [];
					this.pdfHasOutline = false;
				});
		}
		await this.updateComplete;
		this._setupPdfObservers();
	}

	/** Attaches the prefetch/eviction and current-page observers to each mounted scroll container (desktop sidebar / mobile sheet), skipping ones already wired up. */
	private _setupPdfObservers(): void {
		const containers = this.renderRoot.querySelectorAll<HTMLElement>(
			".pdf-scroll-container",
		);
		for (const container of Array.from(containers)) {
			if (this._pdfObservers.has(container)) continue;
			const slots = Array.from(
				container.querySelectorAll<HTMLElement>(".pdf-page-slot"),
			);

			// Wide margin so nearby pages render/evict before they scroll into
			// view — intentionally NOT used to pick the current page, since a
			// page fully inside this oversized margin reports ratio 1 even
			// when it's nowhere near actually visible.
			const prefetchObserver = new IntersectionObserver(
				(entries) => this._onPdfPagePrefetchIntersect(entries),
				{ root: container, rootMargin: "150% 0px", threshold: [0] },
			);
			for (const slot of slots) prefetchObserver.observe(slot);
			this._pdfObservers.set(container, prefetchObserver);

			// Tight (no) margin, purely to detect which page is actually on
			// screen so the pager stays in sync with what's visible.
			const pageObserver = new IntersectionObserver(
				(entries) => this._onPdfPageVisibilityIntersect(entries),
				{ root: container, threshold: [0, 0.25, 0.5, 0.75, 1] },
			);
			for (const slot of slots) pageObserver.observe(slot);
			this._pdfPageObservers.set(container, pageObserver);
		}
	}

	private _disconnectPdfObservers(): void {
		for (const observer of this._pdfObservers.values()) observer.disconnect();
		this._pdfObservers.clear();
		for (const observer of this._pdfPageObservers.values())
			observer.disconnect();
		this._pdfPageObservers.clear();
		this._pdfVisibleRatios.clear();
		this._pdfProgrammaticScroll = false;
		if (this._pdfScrollSettleTimer) {
			clearTimeout(this._pdfScrollSettleTimer);
			this._pdfScrollSettleTimer = null;
		}
	}

	private _onPdfPagePrefetchIntersect(
		entries: IntersectionObserverEntry[],
	): void {
		for (const entry of entries) {
			const slot = entry.target as HTMLElement;
			const pageNum = Number(slot.dataset.page);
			if (!pageNum) continue;
			if (entry.isIntersecting) {
				void this._renderPdfPageInto(pageNum, slot);
			} else if (
				Math.abs(pageNum - this.pdfPageNum) > RsvpReader.PDF_KEEP_WINDOW
			) {
				this._evictPdfPage(slot);
			}
		}
	}

	private _onPdfPageVisibilityIntersect(
		entries: IntersectionObserverEntry[],
	): void {
		for (const entry of entries) {
			const pageNum = Number((entry.target as HTMLElement).dataset.page);
			if (!pageNum) continue;
			if (entry.isIntersecting) {
				this._pdfVisibleRatios.set(pageNum, entry.intersectionRatio);
			} else {
				this._pdfVisibleRatios.delete(pageNum);
			}
		}

		let bestPage: number | null = null;
		let bestRatio = 0;
		for (const [page, ratio] of this._pdfVisibleRatios) {
			if (ratio > bestRatio) {
				bestRatio = ratio;
				bestPage = page;
			}
		}
		if (bestPage !== null && !this._pdfProgrammaticScroll) {
			this.pdfPageNum = bestPage;
		}
	}

	private async _renderPdfPageInto(
		pageNum: number,
		slot: HTMLElement,
	): Promise<void> {
		const canvas = slot.querySelector<HTMLCanvasElement>(".pdf-canvas");
		const doc = this.pdfDocProxy;
		if (!canvas || !doc) return;
		if (
			canvas.dataset.rendered === "true" ||
			canvas.dataset.rendering === "true"
		)
			return;
		canvas.dataset.rendering = "true";
		try {
			const page = await doc.getPage(pageNum);
			const containerWidth = slot.clientWidth || 320;
			const unscaledViewport = page.getViewport({ scale: 1 });
			const scale = Math.max(0.1, containerWidth / unscaledViewport.width);
			const viewport = page.getViewport({ scale });
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			canvas.width = viewport.width;
			canvas.height = viewport.height;
			await page.render({ canvas, canvasContext: ctx, viewport }).promise;
			canvas.dataset.rendered = "true";
		} finally {
			canvas.dataset.rendering = "false";
		}
	}

	/** Frees a far-off-screen page's canvas bitmap; it re-renders on demand if scrolled back into range. */
	private _evictPdfPage(slot: HTMLElement): void {
		const canvas = slot.querySelector<HTMLCanvasElement>(".pdf-canvas");
		if (!canvas || canvas.dataset.rendered !== "true") return;
		canvas.width = 0;
		canvas.height = 0;
		canvas.dataset.rendered = "false";
	}

	private _jumpToPdfPage(target: number): void {
		const clamped = Math.max(1, Math.min(this.pdfPageCount, target));
		// Set immediately rather than waiting on the IntersectionObserver to
		// notice the scroll has settled — otherwise a quick follow-up action
		// (e.g. opening the jump-to-reader modal right after a search) can
		// read the page we're navigating away from instead of the target.
		this.pdfPageNum = clamped;
		const containers = Array.from(
			this.renderRoot.querySelectorAll<HTMLElement>(".pdf-scroll-container"),
		).filter((container) => container.clientWidth > 0);
		this._suppressPdfPageTrackingUntilSettled(containers, clamped);
		for (const container of containers) {
			const slot = container.querySelector<HTMLElement>(
				`.pdf-page-slot[data-page="${clamped}"]`,
			);
			slot?.scrollIntoView({ behavior: "smooth", block: "start" });
		}
	}

	/**
	 * While the scroll triggered by a jump is animating, pages transiting the
	 * tight viewport would otherwise fight the jump via the visibility
	 * observer (see `_pdfProgrammaticScroll`). Suppress pdfPageNum updates
	 * until the browser reports the scroll has actually settled (`scrollend`,
	 * with a timeout fallback for engines that don't fire it), then
	 * re-assert the intended target once more in case the observer's last
	 * delivered ratios were still mid-transit.
	 */
	private _suppressPdfPageTrackingUntilSettled(
		containers: HTMLElement[],
		target: number,
	): void {
		this._pdfProgrammaticScroll = true;
		if (this._pdfScrollSettleTimer) clearTimeout(this._pdfScrollSettleTimer);

		const settle = () => {
			this._pdfProgrammaticScroll = false;
			this.pdfPageNum = target;
			if (this._pdfScrollSettleTimer) {
				clearTimeout(this._pdfScrollSettleTimer);
				this._pdfScrollSettleTimer = null;
			}
		};
		// Fallback in case `scrollend` isn't supported, or never fires (e.g.
		// the target was already fully in view and nothing actually scrolled).
		this._pdfScrollSettleTimer = setTimeout(settle, 1000);
		for (const container of containers) {
			container.addEventListener("scrollend", settle, { once: true });
		}
	}

	/** Extracts (or reuses a cached copy of) one page's plain text — shared by the jump-to-reader modal and PDF search. */
	private async _getPdfPageText(pageNum: number): Promise<string> {
		const cached = this._pdfPageTextCache.get(pageNum);
		if (cached !== undefined) return cached;
		if (!this.pdfDocProxy) return "";
		const page = await this.pdfDocProxy.getPage(pageNum);
		const text = await extractPdfPageText(page);
		this._pdfPageTextCache.set(pageNum, text);
		return text;
	}

	/** Token indices matching the last-run "Find in PDF" query, so the jump modal can echo the search highlight. */
	private _pdfSearchMatchTokenIndices(): Set<number> {
		const result = new Set<number>();
		const queryWords = this._pdfSearchedQuery
			.trim()
			.toLowerCase()
			.split(/\s+/)
			.filter(Boolean);
		if (queryWords.length === 0) return result;
		const tokens = this.pageJumpTokens;
		for (let start = 0; start <= tokens.length - queryWords.length; start++) {
			let matched = true;
			for (let k = 0; k < queryWords.length; k++) {
				if (!tokens[start + k].text.toLowerCase().includes(queryWords[k])) {
					matched = false;
					break;
				}
			}
			if (matched) {
				for (let k = 0; k < queryWords.length; k++) result.add(start + k);
			}
		}
		return result;
	}

	private async _openPageJumpModal(): Promise<void> {
		if (!this.pdfDocProxy) return;
		this.showPageJumpModal = true;
		this.pageJumpLoading = true;
		this.pageJumpAnchorStart = null;
		try {
			const pageText = await this._getPdfPageText(this.pdfPageNum);
			this.pageJumpTokens = tokenize(pageText, this.settings);
		} finally {
			this.pageJumpLoading = false;
		}
	}

	private _togglePdfSearch(): void {
		this.showPdfSearch = !this.showPdfSearch;
		if (!this.showPdfSearch) return;
		requestAnimationFrame(() => {
			this.renderRoot
				.querySelector<HTMLInputElement>(".pdf-search-input")
				?.focus();
		});
	}

	private _closePdfSearch(): void {
		this.showPdfSearch = false;
		this.pdfSearchQuery = "";
		this.pdfSearchMatches = [];
		this.pdfSearchActiveIndex = -1;
		this._pdfSearchedQuery = "";
	}

	private async _runPdfSearch(): Promise<void> {
		const query = this.pdfSearchQuery.trim().toLowerCase();
		this._pdfSearchedQuery = this.pdfSearchQuery.trim();
		if (!query || !this.pdfDocProxy || this.pdfPageCount === 0) {
			this.pdfSearchMatches = [];
			this.pdfSearchActiveIndex = -1;
			return;
		}
		this.pdfSearchLoading = true;
		const matches: number[] = [];
		try {
			for (let n = 1; n <= this.pdfPageCount; n++) {
				const text = await this._getPdfPageText(n);
				if (text.toLowerCase().includes(query)) matches.push(n);
			}
		} finally {
			this.pdfSearchLoading = false;
		}
		this.pdfSearchMatches = matches;
		this.pdfSearchActiveIndex = matches.length > 0 ? 0 : -1;
		if (matches.length > 0) {
			this._jumpToPdfPage(matches[0]);
		} else {
			showToast("No matches found in this PDF.", "error");
		}
	}

	private _cyclePdfSearchMatch(delta: number): void {
		const count = this.pdfSearchMatches.length;
		if (count === 0) return;
		this.pdfSearchActiveIndex =
			(this.pdfSearchActiveIndex + delta + count) % count;
		this._jumpToPdfPage(this.pdfSearchMatches[this.pdfSearchActiveIndex]);
	}

	private _handlePdfSearchEnter(shiftKey: boolean): void {
		if (
			this.pdfSearchMatches.length > 0 &&
			this._pdfSearchedQuery === this.pdfSearchQuery.trim()
		) {
			this._cyclePdfSearchMatch(shiftKey ? -1 : 1);
		} else {
			void this._runPdfSearch();
		}
	}

	private _closePageJumpModal(): void {
		this.showPageJumpModal = false;
		this.pageJumpTokens = [];
		this.pageJumpAnchorStart = null;
	}

	private _confirmPageJump(): void {
		if (this.pageJumpAnchorStart === null) return;
		const words = this.pageJumpTokens
			.slice(
				this.pageJumpAnchorStart,
				this.pageJumpAnchorStart + this.pageJumpWordTarget,
			)
			.map((t) => t.text.trim())
			.filter(Boolean);
		if (words.length === 0) return;

		const engineText = this.settings.removeCitations
			? stripCitations(this.rawDocText)
			: this.rawDocText;
		const idx = this._findAnchorOffset(engineText, words);
		if (idx === -1) {
			showToast(
				"Couldn't find that text in the document — try a different spot.",
				"error",
			);
			return;
		}

		const wordIndex = tokenize(engineText.slice(0, idx), this.settings).length;
		this.engine.seekToWord(wordIndex);
		void this.persistProgress(this.engine.getState());
		showToast(`Jumped to page ${this.pdfPageNum}`, "success");
		this._closePageJumpModal();
	}

	private _openChaptersPanel(): void {
		if (!this.pdfHasOutline) return;
		this.showChaptersPanel = true;
	}

	private _closeChaptersPanel(): void {
		this.showChaptersPanel = false;
	}

	private _jumpToOutlineEntry(entry: PdfOutlineEntry): void {
		if (entry.page === null) return;
		this._jumpToPdfPage(entry.page);
		this._closeChaptersPanel();
	}

	/**
	 * Matches the anchor words with flexible whitespace between them — the
	 * popup's page text and `rawDocText` come from the same pdfjs extraction,
	 * but words that wrap across a PDF line are joined by "\n" in the source
	 * text, not the single space `words.join(" ")` would produce. Searches
	 * near the page's estimated position first, so a short/common phrase
	 * doesn't land on an earlier duplicate occurrence (repeated headers, etc.).
	 */
	private _findAnchorOffset(text: string, words: string[]): number {
		const pattern = words
			.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join("\\s+");
		const regex = new RegExp(pattern);

		const approxOffset =
			this.pdfPageCount > 0
				? Math.floor(((this.pdfPageNum - 1) / this.pdfPageCount) * text.length)
				: 0;
		const windowSize = 30_000;
		const start = Math.max(0, approxOffset - windowSize);
		const end = Math.min(text.length, approxOffset + windowSize);
		const nearbyMatch = text.slice(start, end).match(regex);
		if (nearbyMatch?.index !== undefined) return start + nearbyMatch.index;

		const globalMatch = text.match(regex);
		return globalMatch?.index ?? -1;
	}

	private seekRatioFromPointerEvent(e: PointerEvent): number {
		const bar = e.currentTarget as HTMLElement;
		const rect = bar.getBoundingClientRect();
		return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
	}

	private onSeekStart = (e: PointerEvent): void => {
		e.preventDefault();
		this.isSeeking = true;
		this.isProgressHovered = true;
		this.seekingPointerId = e.pointerId;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

		this.wasPlayingBeforeSeek = this.engine.getState().playing;
		if (this.wasPlayingBeforeSeek) {
			this.engine.pause();
		}

		const s = this.playbackState;
		if (!s || s.totalWords === 0) return;
		const ratio = this.seekRatioFromPointerEvent(e);
		const idx = Math.round(ratio * (s.totalWords - 1));
		this.seekWordIndex = idx;
		this.engine.seekToWord(idx);
	};

	private onSeekMove = (e: PointerEvent): void => {
		if (!this.isSeeking || e.pointerId !== this.seekingPointerId) return;
		e.preventDefault();
		const s = this.playbackState;
		if (!s || s.totalWords === 0) return;
		const ratio = this.seekRatioFromPointerEvent(e);
		const idx = Math.round(ratio * (s.totalWords - 1));
		this.seekWordIndex = idx;
		this.engine.seekToWord(idx);
	};

	private onSeekEnd = (e: PointerEvent): void => {
		if (e.pointerId !== this.seekingPointerId) return;

		if (this.wasPlayingBeforeSeek) {
			this.engine.play(this.settings);
			audioService.setAmbientNoise(
				this.settings.ambientNoise,
				this.settings.ambientVolume,
			);
		}

		this.isSeeking = false;
		this.isProgressHovered = false;
		this.seekWordIndex = null;
		this.seekingPointerId = null;
		this.wasPlayingBeforeSeek = false;
		this.persistProgress(this.engine.getState());
	};

	override render() {
		const s = this.playbackState;
		const playing = s?.playing ?? false;
		const displayWordIndex =
			this.isSeeking && this.seekWordIndex !== null
				? this.seekWordIndex
				: (s?.wordIndex ?? 0);
		const progress = s
			? (displayWordIndex / Math.max(s.totalWords, 1)) * 100
			: 0;
		const wpm = s?.playing
			? (s.currentWpm ?? this.settings.wpm)
			: this.settings.wpm;
		const remainingMs = s
			? this.engine.getEstimatedRemainingMs(this.settings)
			: 0;
		const remainingSeconds = Math.ceil(remainingMs / 1000);
		const remainingLabel = this.formatTimeRemaining(remainingSeconds);

		const hasDoc = (s?.totalWords ?? 0) > 0;
		/** Immersive chrome hidden only when the setting is on and playback (or countdown) is active. Pausing always shows controls again. */
		const focusModeActive =
			hasDoc &&
			(this.settings.focusModeEnabled ?? false) &&
			(playing || this.isCountingDown);

		const irlenOpacity = this.settings.irlenOpacity ?? 0.18;
		const irlenColors: Record<string, string> = {
			peach: `rgba(255, 160, 80, ${irlenOpacity})`,
			mint: `rgba(80, 200, 140, ${irlenOpacity})`,
			parchment: `rgba(210, 185, 110, ${irlenOpacity})`,
		};
		const irlenStyle =
			this.settings.irlenMode !== "none" && irlenColors[this.settings.irlenMode]
				? `background-color: ${irlenColors[this.settings.irlenMode]}; pointer-events: none;`
				: "";

		return html`
			<div
				class="flex h-screen bg-base-100 overflow-hidden relative"
				data-focus-mode="${focusModeActive}"
			>

				<!-- Irlen Mode Overlay -->
				${
					irlenStyle
						? html`<div class="absolute inset-0 z-50" style="${irlenStyle}"></div>`
						: ""
				}

			<!-- Countdown Overlay -->
			${
				this.isCountingDown
					? html`
				<div class="absolute inset-0 z-40 flex items-center justify-center bg-base-100" aria-live="assertive" aria-atomic="true">
					<span class="countdown-number text-9xl font-bold text-primary tabular-nums" key=${this.countdownNumber}>
						${this.countdownNumber > 0 ? this.countdownNumber : "GO"}
					</span>
				</div>
			`
					: ""
			}

				<!-- Main Reader Area -->
				<div class="flex-1 flex flex-col min-w-0 min-h-0">

					<!-- Top Bar -->
					${
						focusModeActive
							? nothing
							: html`
					<div class="flex items-center justify-between px-4 md:px-5 py-3 md:py-4 border-b border-base-200 shrink-0 min-h-[48px]">
						<div class="flex items-center gap-2 md:gap-3 min-w-0">
						<button
							type="button"
							class="btn btn-ghost btn-md btn-circle shrink-0 min-h-[44px] min-w-[44px] touch-manipulation"
							@click=${this.handleBack}
							title="Back to home (Esc)"
							aria-label="Back to home"
						>
							<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"/>
							</svg>
						</button>
							<span class="text-xs md:text-sm text-base-content/70 truncate font-light tracking-wide">${this.docTitle || "No document"}</span>
						</div>
						<div class="flex items-center gap-1 md:gap-2 shrink-0 relative z-50">
							<span class="text-xs md:text-sm text-base-content/55 font-mono hidden md:block mr-2">
								${s?.wordIndex ?? 0}<span class="text-ui-muted-subtle"> / ${s?.totalWords ?? 0}</span>
							</span>
							<wellness-overlay
							.playing=${s?.playing ?? false}
							.settings=${this.settings}
							@pomodoro-break-start=${() => {
								if (s?.playing) this.engine.pause();
								audioService.stopAmbientNoise();
							}}
							@pomodoro-resume=${() => {
								if (!this.engine.getState().playing) this.togglePlay();
							}}
							@settings-change=${(e: CustomEvent) => this.handleSettingsChange(new CustomEvent("settings-change", { detail: { ...this.settings, ...e.detail } }))}
						></wellness-overlay>
						<button
							type="button"
							class="btn btn-ghost btn-md btn-circle min-h-[44px] min-w-[44px] touch-manipulation"
							@click=${() => {
								this.showShortcuts = true;
							}}
							title="Keyboard shortcuts (?)"
							aria-label="Show keyboard shortcuts"
						>
							<svg class="w-5 h-5 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
									d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
							</svg>
						</button>
						${
							this.pdfBlob
								? html`
						<button
							type="button"
							class="btn btn-ghost btn-md btn-circle min-h-[44px] min-w-[44px] touch-manipulation ${this.showPdfViewer ? "bg-base-200" : ""}"
							@click=${() => this._togglePdfViewer()}
							title="View PDF"
							aria-label="${this.showPdfViewer ? "Close PDF viewer" : "Open PDF viewer"}"
							aria-expanded="${this.showPdfViewer}"
						>
							<svg class="w-5 h-5 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
									d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
							</svg>
						</button>
						`
								: ""
						}
						<button
							type="button"
							class="btn btn-ghost btn-md btn-circle min-h-[44px] min-w-[44px] touch-manipulation ${this.showSettings ? "bg-base-200" : ""}"
							data-umami-event="settings-opened"
							@click=${() => {
								this._closePdfViewer();
								this.showSettings = !this.showSettings;
							}}
							title="Settings"
							aria-label="${this.showSettings ? "Close settings" : "Open settings"}"
							aria-expanded="${this.showSettings}"
						>
							<svg class="w-5 h-5 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
									d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
							</svg>
						</button>
						</div>
					</div>
					`
					}

				<!-- Progress / Seek bar -->
				${
					!focusModeActive && this.settings.showProgress
						? html`
					<div
						class="w-full shrink-0 cursor-pointer select-none relative"
						style="height: ${this.isProgressHovered || this.isSeeking ? "10px" : "4px"}; transition: height 0.15s ease; background: oklch(var(--b2));"
						@pointerenter=${() => {
							this.isProgressHovered = true;
						}}
						@pointerleave=${(_e: PointerEvent) => {
							if (!this.isSeeking) this.isProgressHovered = false;
						}}
						@pointerdown=${this.onSeekStart}
						@pointermove=${this.onSeekMove}
						@pointerup=${this.onSeekEnd}
						@pointercancel=${this.onSeekEnd}
					>
						<div
							class="h-full bg-primary pointer-events-none"
							style="width: ${progress}%; transition: width ${this.isSeeking ? "0ms" : "300ms"} ease-out;"
						></div>
						<!-- Seek thumb — visible on hover/drag -->
						${
							this.isProgressHovered || this.isSeeking
								? html`
							<div
								class="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-primary shadow pointer-events-none"
								style="left: calc(${progress}% - 6px);"
							></div>
						`
								: ""
						}
					</div>
				`
						: ""
				}

					<!-- Word Display Area -->
					<div
						id="word-display-area"
						class="flex-1 flex flex-col items-center justify-center cursor-pointer select-none overflow-hidden relative"
						@click=${this.togglePlay}
					>
						${
							!s || s.totalWords === 0
								? this.renderEmptyState()
								: this.settings.tickerMode
									? this.renderTickerDisplay(s)
									: !s.playing &&
											(this.settings.pauseView === "fulltext" ||
												this.settings.pauseView === "context")
										? this.renderFullTextPauseView(s)
										: this.renderWordDisplay(s)
						}
					</div>

					<!-- Ambient Word Marquee -->
					${
						!focusModeActive && s && hasDoc && !this.settings.tickerMode
							? this.renderMarquee(s)
							: ""
					}

					<!-- Bottom Controls -->
					${
						focusModeActive
							? nothing
							: html`
					<div class="border-t border-base-200 px-4 md:px-6 py-4 md:py-5 shrink-0 pb-[max(1rem,env(safe-area-inset-bottom))] relative z-30">
						${this.renderControls(playing, wpm, remainingSeconds, remainingLabel)}
					</div>
					`
					}
				</div>

				<!-- Settings Sidebar (RIGHT, desktop only) -->
			${
				focusModeActive
					? nothing
					: html`
			<div class="hidden md:flex transition-all duration-300 ${this.showSettings ? "w-80 border-l border-base-200" : "w-0"} overflow-hidden shrink-0 bg-base-100 flex-col relative z-40">
				<div class="w-80 flex flex-col h-full overflow-hidden">
					<div class="px-5 py-4 border-b border-base-200 flex items-center justify-between shrink-0">
						<span class="text-sm font-medium text-base-content/70 tracking-wide">Settings</span>
						<button class="btn btn-ghost btn-sm btn-circle" aria-label="Close settings" @click=${() => {
							this.showSettings = false;
						}}>
							<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
							</svg>
						</button>
					</div>
						<div class="flex-1 overflow-y-auto">
							<settings-panel
								.settings=${this.settings}
								@settings-change=${this.handleSettingsChange}
							></settings-panel>
						</div>
					</div>
				</div>
			`
			}

			<!-- PDF Sidebar (RIGHT, desktop only) -->
			${
				focusModeActive
					? nothing
					: html`
			<div class="hidden md:flex transition-all duration-300 ${this.showPdfViewer ? "w-80 border-l border-base-200" : "w-0"} overflow-hidden shrink-0 bg-base-100 flex-col relative z-40">
				<div class="w-80 flex flex-col h-full overflow-hidden">
					${this.renderPdfPanel()}
				</div>
			</div>
			`
			}

			</div>

		<!-- Settings Bottom Sheet (mobile only) -->
		${
			!focusModeActive && this.showSettings
				? html`
			<div class="md:hidden fixed inset-0 z-40 flex flex-col justify-end">
				<!-- Backdrop -->
				<div
					class="absolute inset-0 bg-base-content/40"
					@click=${() => {
						this.showSettings = false;
					}}
					aria-hidden="true"
				></div>
				<!-- Sheet -->
				<div class="relative bg-base-100 rounded-t-2xl max-h-[80vh] flex flex-col shadow-2xl z-10 w-full" role="dialog" aria-label="Reader settings">
					<div class="flex items-center justify-between px-5 py-4 border-b border-base-200 shrink-0">
						<span class="text-sm font-medium text-base-content/70 tracking-wide">Settings</span>
						<button class="btn btn-ghost btn-sm btn-circle" aria-label="Close settings" @click=${() => {
							this.showSettings = false;
						}}>
							<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
							</svg>
						</button>
					</div>
						<div class="flex-1 overflow-y-auto w-full">
							<settings-panel
								.settings=${this.settings}
								@settings-change=${this.handleSettingsChange}
							></settings-panel>
						</div>
					</div>
				</div>
			`
				: ""
		}

		<!-- PDF Bottom Sheet (mobile only) -->
		${
			!focusModeActive && this.showPdfViewer
				? html`
			<div class="md:hidden fixed inset-0 z-40 flex flex-col justify-end">
				<!-- Backdrop -->
				<div
					class="absolute inset-0 bg-base-content/40"
					@click=${() => {
						this._closePdfViewer();
					}}
					aria-hidden="true"
				></div>
				<!-- Sheet -->
				<div class="relative bg-base-100 rounded-t-2xl max-h-[80vh] flex flex-col shadow-2xl z-10 w-full" role="dialog" aria-label="PDF viewer">
					${this.renderPdfPanel()}
				</div>
			</div>
			`
				: ""
		}

			<!-- Shortcuts Modal -->
			${this.showShortcuts ? this.renderShortcutsModal() : ""}
		`;
	}

	private renderPdfPanel() {
		return html`
			<div class="px-5 py-4 border-b border-base-200 flex items-center justify-between shrink-0">
				<span class="text-sm font-medium text-base-content/70 tracking-wide truncate">${this.docTitle || "Document"}</span>
				<button class="btn btn-ghost btn-sm btn-circle" aria-label="Close PDF viewer" @click=${() => {
					this._closePdfViewer();
				}}>
					<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
					</svg>
				</button>
			</div>
			<div class="pdf-scroll-container flex-1 overflow-auto bg-base-200/40 px-3 py-3">
				${
					this.pdfPageCount === 0
						? html`<div class="w-full flex justify-center py-8"><span class="loading loading-spinner loading-md"></span></div>`
						: repeat(
								Array.from({ length: this.pdfPageCount }, (_, i) => i + 1),
								(n) => n,
								(n) => html`
							<div
								class="pdf-page-slot w-full mb-2"
								data-page="${n}"
								style="aspect-ratio: ${1 / this.pdfPageAspectRatio};"
							>
								<canvas class="pdf-canvas w-full h-full block shadow"></canvas>
							</div>
						`,
							)
				}
			</div>
			<div class="relative shrink-0">
				<div
					class="pdf-search-drawer absolute bottom-full left-0 right-0 bg-base-100 border-t border-base-200 shadow-lg p-2 flex items-center gap-1.5 z-10 transition-all duration-150 ${
						this.showPdfSearch
							? "translate-y-0 opacity-100"
							: "translate-y-2 opacity-0 pointer-events-none"
					}"
				>
					<svg class="w-4 h-4 opacity-50 shrink-0 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"/>
					</svg>
					<input
						type="text"
						class="pdf-search-input input input-xs input-bordered flex-1 min-w-0"
						placeholder="Find in PDF…"
						.value=${this.pdfSearchQuery}
						@input=${(e: Event) => {
							this.pdfSearchQuery = (e.target as HTMLInputElement).value;
						}}
						@keydown=${(e: KeyboardEvent) => {
							if (e.key === "Enter") {
								e.preventDefault();
								this._handlePdfSearchEnter(e.shiftKey);
							} else if (e.key === "Escape") {
								this._closePdfSearch();
							}
						}}
					/>
					${
						this.pdfSearchLoading
							? html`<span class="loading loading-spinner loading-xs shrink-0"></span>`
							: this.pdfSearchMatches.length > 0
								? html`<span class="text-xs font-mono text-base-content/60 shrink-0 whitespace-nowrap">${this.pdfSearchActiveIndex + 1} of ${this.pdfSearchMatches.length}</span>`
								: this._pdfSearchedQuery
									? html`<span class="text-xs text-base-content/40 shrink-0 whitespace-nowrap">No matches</span>`
									: ""
					}
					<button
						type="button"
						class="btn btn-ghost btn-xs btn-circle shrink-0"
						?disabled=${this.pdfSearchMatches.length === 0}
						@click=${() => this._cyclePdfSearchMatch(-1)}
						aria-label="Previous match"
					>‹</button>
					<button
						type="button"
						class="btn btn-ghost btn-xs btn-circle shrink-0"
						?disabled=${this.pdfSearchMatches.length === 0}
						@click=${() => this._cyclePdfSearchMatch(1)}
						aria-label="Next match"
					>›</button>
					<button
						type="button"
						class="btn btn-ghost btn-xs btn-circle shrink-0"
						@click=${() => this._closePdfSearch()}
						aria-label="Close search"
					>
						<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
						</svg>
					</button>
				</div>
				<div class="flex items-center justify-center gap-2 px-4 py-3 border-t border-base-200 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
					<button
						type="button"
						class="btn btn-ghost btn-sm btn-circle"
						?disabled=${this.pdfPageNum <= 1}
						@click=${() => this._jumpToPdfPage(this.pdfPageNum - 1)}
						aria-label="Previous page"
					>‹</button>
					<input
						type="number"
						class="input input-xs input-bordered w-14 text-center font-mono"
						min="1"
						max="${this.pdfPageCount}"
						.value=${String(this.pdfPageNum)}
						@keydown=${(e: KeyboardEvent) => {
							if (e.key === "Enter") (e.target as HTMLInputElement).blur();
						}}
						@change=${(e: Event) => {
							this._jumpToPdfPage(Number((e.target as HTMLInputElement).value));
						}}
						aria-label="Page number"
					/>
					<span class="text-xs font-mono text-base-content/60">of ${this.pdfPageCount}</span>
					<button
						type="button"
						class="btn btn-ghost btn-sm btn-circle"
						?disabled=${this.pdfPageNum >= this.pdfPageCount}
						@click=${() => this._jumpToPdfPage(this.pdfPageNum + 1)}
						aria-label="Next page"
					>›</button>
					<button
						type="button"
						class="btn btn-ghost btn-sm btn-circle"
						?disabled=${this.pdfPageCount === 0}
						@click=${() => void this._openPageJumpModal()}
						title="Jump reader to this page"
						aria-label="Jump reader to this page"
					>
						<svg class="w-4 h-4 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"/>
						</svg>
					</button>
					<button
						type="button"
						class="btn btn-ghost btn-sm btn-circle ${this.showPdfSearch ? "bg-base-200" : ""}"
						?disabled=${this.pdfPageCount === 0}
						@click=${() => this._togglePdfSearch()}
						title="Find in PDF"
						aria-label="${this.showPdfSearch ? "Close find in PDF" : "Find in PDF"}"
						aria-expanded="${this.showPdfSearch}"
					>
						<svg class="w-4 h-4 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"/>
						</svg>
					</button>
					<button
						type="button"
						class="btn btn-ghost btn-sm btn-circle"
						?disabled=${!this.pdfHasOutline}
						@click=${() => this._openChaptersPanel()}
						title=${this.pdfHasOutline ? "Chapters" : "No chapters found in this PDF"}
						aria-label="Chapters"
					>
						<svg class="w-4 h-4 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 6h16M4 12h9M4 18h9"/>
						</svg>
					</button>
				</div>
			</div>
			${this.showPageJumpModal ? this.renderPageJumpModal() : ""}
			${this.showChaptersPanel ? this.renderChaptersModal() : ""}
		`;
	}

	private renderPageJumpModal() {
		const anchorStart = this.pageJumpAnchorStart;
		const anchorEnd =
			anchorStart !== null ? anchorStart + this.pageJumpWordTarget : null;
		const searchMatchIndices = this._pdfSearchMatchTokenIndices();
		return html`
			<div
				class="fixed inset-0 bg-base-content/50 z-50 flex items-center justify-center p-4"
				@click=${() => this._closePageJumpModal()}
				aria-hidden="true"
			>
				<div
					class="card bg-base-100 w-full max-w-lg shadow-xl max-h-[85vh] flex flex-col"
					@click=${(e: Event) => e.stopPropagation()}
					role="dialog"
					aria-label="Jump reader to this page"
				>
					<div class="card-body overflow-hidden flex flex-col">
						<div class="flex items-center justify-between mb-1">
							<h3 class="font-medium text-base-content">Jump reader to page ${this.pdfPageNum}</h3>
							<button class="btn btn-ghost btn-xs btn-circle" aria-label="Close" @click=${() => this._closePageJumpModal()}>
								<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
								</svg>
							</button>
						</div>
						<p class="text-xs text-base-content/50 mb-2">
							Click the first word of a passage below — the reader will jump to where that text appears.
							${
								searchMatchIndices.size > 0
									? html`<span class="ml-1">Highlighted in <span class="bg-warning/40 rounded px-0.5">yellow</span>: your search for "${this._pdfSearchedQuery}".</span>`
									: ""
							}
						</p>
						<div class="flex items-center gap-2 mb-3">
							<label class="text-xs text-base-content/60 shrink-0" for="page-jump-word-count">Match length</label>
							<input
								id="page-jump-word-count"
								type="range"
								min="1"
								max="8"
								class="range range-xs"
								.value=${String(this.pageJumpWordTarget)}
								@input=${(e: Event) => {
									this.pageJumpWordTarget = Number(
										(e.target as HTMLInputElement).value,
									);
								}}
							/>
							<span class="text-xs font-mono text-base-content/60 w-16 shrink-0">${this.pageJumpWordTarget} word${this.pageJumpWordTarget === 1 ? "" : "s"}</span>
						</div>
						<div class="flex-1 overflow-y-auto border border-base-200 rounded-lg p-3 text-sm leading-relaxed" dir="auto">
							${
								this.pageJumpLoading
									? html`<div class="flex justify-center py-8"><span class="loading loading-spinner loading-md"></span></div>`
									: this.pageJumpTokens.map(
											(t, i) => html`<span
												class="cursor-pointer rounded transition-colors duration-100 hover:bg-primary/20 ${
													anchorStart !== null &&
													i >= anchorStart &&
													i < (anchorEnd ?? 0)
														? "bg-primary/30 text-primary font-medium"
														: searchMatchIndices.has(i)
															? "bg-warning/40"
															: ""
												}"
												@click=${() => {
													this.pageJumpAnchorStart = i;
												}}
											>${t.text} </span>`,
										)
							}
						</div>
						<div class="flex justify-end gap-2 mt-3">
							<button class="btn btn-ghost btn-sm" @click=${() => this._closePageJumpModal()}>Cancel</button>
							<button
								class="btn btn-primary btn-sm"
								?disabled=${anchorStart === null}
								@click=${() => this._confirmPageJump()}
							>Jump</button>
						</div>
					</div>
				</div>
			</div>
		`;
	}

	private renderChaptersModal() {
		return html`
			<div
				class="fixed inset-0 bg-base-content/50 z-50 flex items-center justify-center p-4"
				@click=${() => this._closeChaptersPanel()}
				aria-hidden="true"
			>
				<div
					class="card bg-base-100 w-full max-w-lg shadow-xl max-h-[85vh] flex flex-col"
					@click=${(e: Event) => e.stopPropagation()}
					role="dialog"
					aria-label="Chapters"
				>
					<div class="card-body overflow-hidden flex flex-col">
						<div class="flex items-center justify-between mb-1">
							<h3 class="font-medium text-base-content">Chapters</h3>
							<button class="btn btn-ghost btn-xs btn-circle" aria-label="Close" @click=${() => this._closeChaptersPanel()}>
								<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
								</svg>
							</button>
						</div>
						<div class="flex-1 overflow-y-auto border border-base-200 rounded-lg p-2 text-sm">
							${
								this._pdfOutline.length === 0
									? html`<p class="text-xs text-base-content/50 p-2">No chapters found in this PDF.</p>`
									: this._renderOutlineEntries(this._pdfOutline, 0)
							}
						</div>
					</div>
				</div>
			</div>
		`;
	}

	private _renderOutlineEntries(
		entries: PdfOutlineEntry[],
		depth: number,
	): unknown {
		return entries.map(
			(entry) => html`
				<div>
					<div
						class="py-1 px-2 truncate rounded transition-colors duration-100 ${
							entry.page !== null
								? "cursor-pointer hover:bg-primary/20"
								: "opacity-40 cursor-not-allowed"
						}"
						style="padding-left: ${Math.min(depth, 6) * 14 + 8}px"
						title=${entry.page === null ? "This chapter has no linked page." : ""}
						@click=${() => this._jumpToOutlineEntry(entry)}
					>${entry.title}</div>
					${entry.children.length > 0 ? this._renderOutlineEntries(entry.children, depth + 1) : ""}
				</div>
			`,
		);
	}

	private renderEmptyState() {
		return html`
      <div class="text-center">
        <p class="text-base-content/65 text-lg font-light mb-4">No document loaded</p>
        <button class="btn btn-primary btn-sm" @click=${() => navigate("app")}>
          Load a document
        </button>
      </div>
    `;
	}

	private renderFullTextPauseView(s: PlaybackState) {
		const tokens = this.engine.tokens;
		if (!tokens || tokens.length === 0) return this.renderWordDisplay(s);

		const currentIdx = s.displayWordIndex;
		let displayTokens = tokens.map((token, idx) => ({ token, idx }));

		if (this.settings.pauseView === "context") {
			const start = Math.max(0, currentIdx - 40);
			const end = Math.min(tokens.length, currentIdx + 40);
			displayTokens = displayTokens.slice(start, end);
		}

		return html`
      <div
        class="w-full h-full overflow-y-auto px-6 py-4 cursor-text"
        @click=${(e: Event) => e.stopPropagation()}
        style="font-size: ${this.settings.fontSize * 0.45}px; font-family: '${this.settings.fontFamily}', monospace; line-height: 1.8; letter-spacing: 0.02em; word-spacing: 0.1em; max-width: 720px; margin: 0 auto; scroll-behavior: smooth;"
      >
        <p class="text-xs text-base-content/40 mb-3 text-center font-mono">
          Paused — click any word to jump to it, then press play
        </p>
        <p class="text-base-content/80 text-start" dir="auto">
          ${displayTokens.map(
						({ token, idx }) => html`<span
              id="${idx === currentIdx ? "current-pause-word" : ""}"
              class="cursor-pointer rounded transition-colors duration-150 hover:bg-primary/20 whitespace-pre-wrap inline-block max-w-full break-all ${
								idx === currentIdx
									? "bg-primary/30 text-primary font-bold px-1"
									: idx < currentIdx
										? "text-base-content/40 hover:text-base-content/60"
										: "hover:text-base-content/80"
							}"
              @click=${(e: Event) => {
								e.stopPropagation();
								this.engine.seekToWord(idx);
								this.requestUpdate();
								this.persistProgress(this.engine.getState());
							}}
            >${token.text}</span> `,
					)}
        </p>
      </div>
    `;
	}

	/** Display-only; does not affect timing or tokens. */
	private stripTrailingPunctuation(s: string): string {
		return s.replace(/[.,;:!?'")]+$/, "");
	}

	private isRtlText(word: string): boolean {
		return /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(
			word,
		);
	}

	private renderWordDisplay(s: PlaybackState) {
		const word = s.currentTokens.map((t) => t.text).join(" ");
		const orp = s.currentOrp;

		const hidePunct = this.settings.hidePunctuationInDisplay ?? false;
		const displayWord = hidePunct
			? word
					.split(" ")
					.map((w) => this.stripTrailingPunctuation(w))
					.join(" ")
			: word;
		const displayOrp =
			orp && hidePunct
				? {
						before: this.stripTrailingPunctuation(orp.before),
						pivot: orp.pivot,
						after: this.stripTrailingPunctuation(orp.after),
					}
				: orp;

		const isDyslexia = this.settings.dyslexiaMode;
		const fontFamily = isDyslexia
			? "OpenDyslexic"
			: `'${this.settings.fontFamily}', 'Amiri Quran', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', Meiryo, 'PingFang SC', 'Microsoft YaHei', sans-serif`;
		const letterSpacing = isDyslexia
			? Math.max(this.settings.letterSpacing + 0.08, 0.08)
			: this.settings.letterSpacing;
		const wordSpacing = isDyslexia ? "0.2em" : "normal";
		const lineHeight = isDyslexia ? "1.5" : "1";

		const fontWeight = this.settings.fontWeight ?? 400;
		const fontStyle = `font-size: ${this.settings.fontSize}px; font-family: ${fontFamily}; letter-spacing: ${letterSpacing}em; word-spacing: ${wordSpacing}; line-height: ${lineHeight}; font-weight: ${fontWeight}`;
		const peripheralStyle = `font-size: ${this.settings.fontSize * 0.38}px; font-family: ${fontFamily}; letter-spacing: ${letterSpacing}em; word-spacing: ${wordSpacing}; font-weight: ${fontWeight}`;

		const count = this.settings.peripheralContextCount ?? 1;
		const displayIdx = s.displayWordIndex;
		const prevWordsRaw = this.settings.peripheralContext
			? Array.from({ length: count }, (_, i) => {
					const idx = displayIdx - count + i;
					return idx >= 0 ? (this.engine.tokens?.[idx]?.text ?? "") : "";
				}).filter(Boolean)
			: [];
		const nextWordsRaw = this.settings.peripheralContext
			? Array.from({ length: count }, (_, i) => {
					const idx = displayIdx + 1 + i;
					return idx < s.totalWords
						? (this.engine.tokens?.[idx]?.text ?? "")
						: "";
				}).filter(Boolean)
			: [];
		const prevWords = hidePunct
			? prevWordsRaw.map((w) => this.stripTrailingPunctuation(w))
			: prevWordsRaw;
		const nextWords = hidePunct
			? nextWordsRaw.map((w) => this.stripTrailingPunctuation(w))
			: nextWordsRaw;

		const offset = this.settings.pivotOffset ?? 0;
		const translateStyle =
			offset !== 0 ? `transform: translateX(${offset}%)` : "";

		const rtl = this.isRtlText(word);
		const dirAttr = rtl ? "rtl" : "ltr";

		const hasQuotes = s.currentTokens.some((t) => t.context?.inQuotes);
		const hasParens = s.currentTokens.some(
			(t) => t.context?.inParens || t.context?.inBrackets,
		);
		const colorizeQuotes = this.settings.colorizeQuotes ?? false;
		const colorizeParens = this.settings.colorizeParens ?? false;

		const contextColor =
			colorizeQuotes && hasQuotes
				? this.settings.quoteHighlightColor || "oklch(var(--s))"
				: colorizeParens && hasParens
					? this.settings.parenHighlightColor || "oklch(var(--p))"
					: "";

		const wordContent = this.settings.bionicMode
			? this.renderBionicOrpWord(displayWord, displayOrp, contextColor)
			: displayOrp
				? this.renderOrpWord(displayOrp, rtl, contextColor)
				: html`<span class="block text-center" style="${contextColor ? `color: ${contextColor}` : "color: oklch(var(--bc) / 0.8)"}">${displayWord}</span>`;

		return html`
      <div
        class="reading-box flex flex-col gap-3 min-w-0 items-center"
        style="${translateStyle}"
        dir="${dirAttr}"
      >
        ${
					prevWords.length
						? html`
          <span class="peripheral-context text-base-content/15 font-mono select-none leading-none" style="${peripheralStyle}">
            ${prevWords.join(" ")}
          </span>
        `
						: ""
				}

        <div class="word-flash leading-none w-full min-w-0" style="${fontStyle}">
          ${wordContent}
        </div>

        ${
					nextWords.length
						? html`
          <span class="peripheral-context text-base-content/15 font-mono select-none leading-none" style="${peripheralStyle}">
            ${nextWords.join(" ")}
          </span>
        `
						: ""
				}
      </div>
    `;
	}

	/**
	 * Ticker (horizontal scrolling) display mode.
	 *
	 * Renders a sliding window of words as a single `whitespace-nowrap` strip
	 * inside an `overflow:hidden` container. The strip's `translateX` is set
	 * imperatively in `_positionTicker()` after each render, using the real
	 * `offsetLeft` of the current-word span — no pixel estimation.
	 */
	private renderTickerDisplay(s: PlaybackState) {
		const tokens = this.engine.tokens;
		const isDyslexia = this.settings.dyslexiaMode;
		const fontFamily = isDyslexia
			? "OpenDyslexic"
			: `'${this.settings.fontFamily}', 'Amiri Quran', 'Hiragino Sans', sans-serif`;
		const letterSpacing = isDyslexia
			? Math.max(this.settings.letterSpacing + 0.08, 0.08)
			: this.settings.letterSpacing;
		const fontWeight = this.settings.fontWeight ?? 400;
		const fontSize = this.settings.fontSize;

		// On mobile portrait, narrow width makes ticker difficult.
		// Adapt by forcing a maximum font size and centering the anchor to maximize context on both sides.
		const isMobile = window.innerWidth < 768;
		const effectiveFontSize = isMobile ? Math.min(fontSize, 32) : fontSize;
		const anchorPercent = isMobile ? 50 : 30;

		// Sliding window: 30 words behind, 50 ahead of current index.
		const idx = s.displayWordIndex;
		const windowBehind = 30;
		const windowAhead = 50;
		const windowStart = Math.max(0, idx - windowBehind);
		const windowEnd = Math.min(tokens.length, idx + windowAhead);
		const windowTokens = tokens.slice(windowStart, windowEnd);

		const highlightColor = this.settings.highlightColor;

		// Render each word as a span; the current word gets data-ticker-current
		// and the highlight colour so _positionTicker() can find it via querySelector.
		const spans = windowTokens.map((token, wi) => {
			const globalIdx = windowStart + wi;
			const isCurrent = globalIdx === idx;
			const isPast = globalIdx < idx;

			if (isCurrent) {
				return html`<span
					data-ticker-current
					style="color:${highlightColor};font-weight:bold;"
				>${token.text} </span>`;
			}
			const opacity = isPast ? "0.25" : "0.75";
			return html`<span style="opacity:${opacity};">${token.text} </span>`;
		});

		// Font/spacing styles — applied to the strip so they affect offsetLeft measures.
		const stripStyle = [
			`font-size: ${effectiveFontSize}px`,
			`font-family: ${fontFamily}`,
			`letter-spacing: ${letterSpacing}em`,
			`font-weight: ${fontWeight}`,
			`word-spacing: ${isDyslexia ? "0.2em" : "normal"}`,
			`line-height: 1`,
		].join(";");

		// NOTE: transform/transition are NOT set here — they are applied
		// imperatively by _positionTicker() after the DOM has painted.

		return html`
      <div
        id="ticker-container"
        class="w-full h-full flex items-center overflow-hidden relative"
        aria-live="polite"
        aria-label="Reading: ${s.currentTokens.map((t) => t.text).join(" ")}"
      >
        <!-- Right fade mask -->
        <div class="absolute inset-y-0 right-0 w-6 md:w-20 z-10 pointer-events-none"
          style="background: linear-gradient(to right, transparent, oklch(var(--b1) / 0.9))"
        ></div>
        <!-- Left fade mask -->
        <div class="absolute inset-y-0 left-0 w-6 md:w-16 z-10 pointer-events-none"
          style="background: linear-gradient(to left, transparent, oklch(var(--b1) / 0.9))"
        ></div>
        <!-- Central focal reticle -->
        <div class="absolute inset-y-0 z-10 pointer-events-none flex flex-col justify-between py-2" style="left: ${anchorPercent}%; width: 0px;">
          <!-- Top notch -->
          <div class="absolute top-1/2 -mt-6 -ml-px w-[2px] h-2 bg-primary/50"></div>
          <!-- Bottom notch -->
          <div class="absolute top-1/2 mt-4 -ml-px w-[2px] h-2 bg-primary/50"></div>
        </div>
        <!-- Scrolling text strip (transform set imperatively) -->
        <div
          id="ticker-strip"
          class="absolute whitespace-nowrap select-none will-change-transform"
          style="${stripStyle}"
        >
          ${spans}
        </div>
      </div>
    `;
	}

	/**
	 * Imperatively positions the ticker strip so the current word sits at 30%
	 * of the container width. Called from `updated()` via `requestAnimationFrame`
	 * so the DOM has fully painted before we measure.
	 *
	 * Uses `span.offsetLeft` — the real browser-computed position — not any
	 * estimated pixel width, so it's accurate at every font size and screen width.
	 */
	private _positionTicker(): void {
		const container =
			this.renderRoot.querySelector<HTMLElement>("#ticker-container");
		const strip = this.renderRoot.querySelector<HTMLElement>("#ticker-strip");
		const current = strip?.querySelector<HTMLElement>("[data-ticker-current]");
		if (!container || !strip || !current) return;

		const s = this.playbackState;
		if (!s) return;

		// 50% left edge on mobile, 30% otherwise (matching the reticle UI)
		const isMobile = window.innerWidth < 768;
		const anchorX = container.clientWidth * (isMobile ? 0.5 : 0.3);

		// The span's natural offsetLeft within the strip (no transform applied yet).
		// offsetLeft is relative to the offsetParent; since the strip is `position:absolute`
		// and the container is `position:relative`, current.offsetLeft is relative to the strip.
		const wordLeft = current.offsetLeft;

		// We want: strip.translateX + wordLeft === anchorX
		const target = anchorX - wordLeft;

		// We use "stepped" mode (instant snap, no linear transition) instead of
		// smooth scrolling to prevent 'smooth pursuit' eye strain.
		strip.style.transition = "none";
		strip.style.transform = `translateX(${target}px)`;
	}

	/**
	 * Ambient marquee — a thin strip between the Word Display Area and the
	 * bottom controls that shows a window of surrounding words, centered
	 * on the current word. Unlike the ticker (the primary focal display,
	 * which snaps instantly to avoid smooth-pursuit eye strain), this is
	 * a secondary/decorative element, so it glides with a linear CSS
	 * transition timed to the current words-per-minute rate.
	 */
	private renderMarquee(s: PlaybackState) {
		const tokens = this.engine.tokens;
		if (!tokens.length) return "";

		const idx = s.displayWordIndex;
		const windowBehind = 20;
		const windowAhead = 40;
		const windowStart = Math.max(0, idx - windowBehind);
		const windowEnd = Math.min(tokens.length, idx + windowAhead);
		const windowTokens = tokens.slice(windowStart, windowEnd);

		const highlightColor = this.settings.highlightColor;

		const spans = windowTokens.map((token, wi) => {
			const globalIdx = windowStart + wi;
			const isCurrent = globalIdx === idx;
			const isPast = globalIdx < idx;

			if (isCurrent) {
				return html`<span
					data-marquee-current
					style="color:${highlightColor};font-weight:600;"
				>${token.text} </span>`;
			}
			const opacity = isPast ? "0.2" : "0.45";
			return html`<span style="color:#fff;opacity:${opacity};">${token.text} </span>`;
		});

		return html`
			<div
				id="marquee-container"
				class="w-full h-10 md:h-12 shrink-0 flex items-center overflow-hidden relative border-t border-base-200"
				aria-hidden="true"
			>
				<!-- Right fade mask -->
				<div class="absolute inset-y-0 right-0 w-10 md:w-20 z-10 pointer-events-none"
					style="background: linear-gradient(to right, transparent, oklch(var(--b1)))"
				></div>
				<!-- Left fade mask -->
				<div class="absolute inset-y-0 left-0 w-10 md:w-20 z-10 pointer-events-none"
					style="background: linear-gradient(to left, transparent, oklch(var(--b1)))"
				></div>
				<!-- Gliding text strip (transform/transition set imperatively) -->
				<div
					id="marquee-strip"
					class="relative whitespace-nowrap select-none will-change-transform text-sm md:text-base font-mono"
				>
					${spans}
				</div>
			</div>
		`;
	}

	/**
	 * Imperatively positions the marquee strip so the *center* of the
	 * highlighted (current) word always aligns, on the x axis, with the
	 * real on-screen ORP pivot in the main Word Display Area — not just
	 * a fraction of the marquee's own width. This keeps the anchor point
	 * constant even as `pivotOffset` shifts the pivot left/right, and
	 * keeps the highlighted word visually steady regardless of its own
	 * pixel width. Positioning is instant (no transition) — same "stepped"
	 * approach as the ticker — so the strip snaps cleanly to each new word.
	 */
	private _getPivotAnchorX(containerRect: DOMRect): number | null {
		const pivotEl =
			this.renderRoot.querySelector<HTMLElement>(".orp-pivot-col") ??
			this.renderRoot.querySelector<HTMLElement>("#rtl-pivot");
		if (pivotEl) {
			const pivotRect = pivotEl.getBoundingClientRect();
			return pivotRect.left + pivotRect.width / 2 - containerRect.left;
		}
		// Fallback (plain text, no ORP): anchor to the center of the word display area.
		const wordArea =
			this.renderRoot.querySelector<HTMLElement>("#word-display-area");
		if (!wordArea) return null;
		const areaRect = wordArea.getBoundingClientRect();
		return areaRect.left + areaRect.width / 2 - containerRect.left;
	}

	private _positionMarquee(): void {
		const container =
			this.renderRoot.querySelector<HTMLElement>("#marquee-container");
		const strip = this.renderRoot.querySelector<HTMLElement>("#marquee-strip");
		const current = strip?.querySelector<HTMLElement>("[data-marquee-current]");
		if (!container || !strip || !current) return;

		const s = this.playbackState;
		if (!s) return;

		const containerRect = container.getBoundingClientRect();
		const anchorX =
			this._getPivotAnchorX(containerRect) ?? container.clientWidth * 0.5;

		// Center the highlighted word (not just its left edge) under the anchor.
		const wordCenter = current.offsetLeft + current.offsetWidth / 2;
		const target = anchorX - wordCenter;

		strip.style.transition = "none";
		strip.style.transform = `translateX(${target}px)`;
	}

	private renderOrpWord(
		orp: { before: string; pivot: string; after: string },
		rtl = false,
		contextColor = "",
	) {
		const guides = this.settings.showOrpGuides;
		const color = this.settings.highlightColor;

		const { before, pivot, after } = orp;

		const baseColor = contextColor || "oklch(var(--bc) / 0.8)";
		if (rtl) {
			return html`
				<div class="relative w-full flex flex-col items-center justify-center">
					${guides ? html`<div class="w-[2px] h-[0.45em] bg-base-content/30 rounded-[1px] mb-1.5 opacity-60"></div>` : ""}
					
					<div id="rtl-shifter" class="text-center transition-none" dir="rtl" style="font-size: 1.1em; will-change: transform; contain: layout;">
						<span id="rtl-measurer" class="inline-block whitespace-nowrap leading-none transition-none relative z-10 py-1">
							<span style="color:${baseColor}">${before}</span><span id="rtl-pivot" style="color:${color}; font-weight:700;">${pivot}</span><span style="color:${baseColor}">${after}</span>
						</span>
					</div>

					${guides ? html`<div class="w-[2px] h-[0.45em] bg-base-content/30 rounded-[1px] mt-1.5 opacity-60"></div>` : ""}
				</div>
			`;
		}

		return html`
			<div class="orp-container">
				<span class="orp-before" style="color:${baseColor}"><span class="orp-before-inner">${before}</span></span>
				<span class="orp-pivot-col">
					${guides ? html`<span class="orp-guide" style="color:${color}"></span>` : ""}
					<span style="color:${color}; font-weight:700; line-height:1">${pivot}</span>
					${guides ? html`<span class="orp-guide" style="color:${color}"></span>` : ""}
				</span>
				<span class="orp-after" style="color:${baseColor}">${after}</span>
			</div>
		`;
	}

	private renderBionicOrpWord(
		word: string,
		orp: { before: string; pivot: string; after: string } | null,
		contextColor = "",
	) {
		const color = this.settings.highlightColor;
		const guides = this.settings.showOrpGuides;

		if (!orp) {
			return unsafeHTML(
				`<span class="text-base-content/80">${applyBionicReading(word)}</span>`,
			);
		}

		const bionicBefore = applyBionicReading(orp.before.trimEnd());
		const bionicAfter = applyBionicReading(orp.after.trimStart());
		const baseColor = contextColor || "oklch(var(--bc) / 0.8)";

		return html`
      <div class="orp-container">
        <span class="orp-before" style="color:${baseColor}"><span class="orp-before-inner">${unsafeHTML(bionicBefore)}</span></span>
        <span class="orp-pivot-col">
          ${guides ? html`<span class="orp-guide" style="color:${color}"></span>` : ""}
          <span style="color:${color}; font-weight:700; line-height:1">${orp.pivot}</span>
          ${guides ? html`<span class="orp-guide" style="color:${color}"></span>` : ""}
        </span>
        <span class="orp-after" style="color:${baseColor}">${unsafeHTML(bionicAfter)}</span>
      </div>
    `;
	}

	private formatTimeRemaining(seconds: number): string {
		if (seconds <= 0) return "";
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const sec = seconds % 60;
		if (h > 0) return `${h}h ${m}m`;
		if (m > 0) return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
		return `${sec}s`;
	}

	private renderControls(
		playing: boolean,
		wpm: number,
		remainingSeconds: number,
		remainingLabel: string,
	) {
		const step = this.settings.rewindStep ?? 5;
		return html`
      <div class="flex flex-wrap items-center justify-center gap-3 md:gap-4 max-w-2xl mx-auto w-full" role="toolbar" aria-label="Playback controls">

        <!-- Rewind N words -->
        <button
          type="button"
          class="btn btn-ghost btn-md btn-circle min-h-[44px] min-w-[44px] touch-manipulation"
          @click=${() => {
						this.engine.seekBy(-step);
					}}
          title="Back ${step} words (↑)"
          aria-label="Back ${step} words"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M12.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0019 16V8a1 1 0 00-1.6-.8l-5.333 4zM4.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0011 16V8a1 1 0 00-1.6-.8l-5.334 4z"/>
          </svg>
        </button>

        <!-- Play/Pause -->
        <button
          type="button"
          class="btn btn-primary btn-circle btn-lg min-h-[52px] min-w-[52px] touch-manipulation"
          @click=${this.togglePlay}
          title="Play/Pause (Space)"
          aria-label="${playing ? "Pause" : "Play"}"
          aria-pressed="${playing}"
        >
          ${
						playing
							? html`<svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="6" y="4" width="4" height="16" rx="1"/>
                <rect x="14" y="4" width="4" height="16" rx="1"/>
              </svg>`
							: html`<svg class="w-6 h-6 ml-0.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 5v14l11-7z"/>
              </svg>`
					}
        </button>

        <!-- Skip N words -->
        <button
          type="button"
          class="btn btn-ghost btn-md btn-circle min-h-[44px] min-w-[44px] touch-manipulation"
          @click=${() => {
						this.engine.seekBy(step);
					}}
          title="Skip ${step} words (↓)"
          aria-label="Skip ${step} words"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M11.933 12.8a1 1 0 000-1.6L6.6 7.2A1 1 0 005 8v8a1 1 0 001.6.8l5.333-4zM19.933 12.8a1 1 0 000-1.6l-5.333-4A1 1 0 0013 8v8a1 1 0 001.6.8l5.333-4z"/>
          </svg>
        </button>

        <!-- Stop/Reset -->
        <button
          type="button"
          class="btn btn-ghost btn-md btn-circle min-h-[44px] min-w-[44px] touch-manipulation"
          @click=${() => {
						this.engine.stop();
					}}
          title="Restart (R)"
          aria-label="Restart from beginning"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"/>
          </svg>
        </button>

        <!-- Spacer -->
        <div class="flex-1"></div>

        <!-- WPM Controls (desktop only — mobile uses settings panel) -->
        <div class="hidden md:flex items-center gap-1 md:gap-2">
          <button
            type="button"
            class="btn btn-ghost btn-sm min-h-[44px] min-w-[44px] touch-manipulation"
            @click=${() => this.emit("settings-change", { wpm: Math.max(50, wpm - 25) })}
          >−</button>
          <div class="flex flex-col items-center w-14 md:w-16">
            <span class="font-mono text-sm md:text-base font-medium leading-none">${wpm}</span>
            <span class="text-xs text-base-content/60 leading-none mt-0.5">WPM</span>
          </div>
          <button
            type="button"
            class="btn btn-ghost btn-sm min-h-[44px] min-w-[44px] touch-manipulation"
            @click=${() => this.emit("settings-change", { wpm: Math.min(1600, wpm + 25) })}
          >+</button>
        </div>

        <!-- Time remaining -->
        ${
					remainingSeconds > 0 && remainingLabel
						? html`
          <span class="text-sm text-base-content/55 font-mono" title="${remainingSeconds} seconds">
            ${remainingLabel} left
          </span>
        `
						: ""
				}

      </div>
    `;
	}

	private renderShortcutsModal() {
		const shortcuts = [
			["Space", "Play / Pause"],
			["F", "Toggle focus mode (immersive while playing)"],
			["Tap", "Pause — with focus mode on, shows controls again"],
			["←  →", "Speed −/+ 25 WPM"],
			["↑  ↓", "Back / Forward 5 words"],
			["R", "Restart from beginning"],
			["Esc", "Back to home"],
			["?", "Toggle this overlay"],
		];
		return html`
      <div
        class="fixed inset-0 bg-base-content/50 z-50 flex items-center justify-center p-4"
        @click=${() => {
					this.showShortcuts = false;
				}}
        aria-hidden="true"
      >
        <div
          class="card bg-base-100 w-full max-w-sm shadow-xl"
          @click=${(e: Event) => e.stopPropagation()}
          role="dialog"
          aria-label="Keyboard shortcuts"
        >
          <div class="card-body">
            <div class="flex items-center justify-between mb-2">
              <h3 class="font-medium text-base-content">Keyboard Shortcuts</h3>
              <button class="btn btn-ghost btn-xs btn-circle" aria-label="Close shortcuts" @click=${() => {
								this.showShortcuts = false;
							}}>
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>
            <div class="flex flex-col gap-2">
              ${shortcuts.map(
								([key, desc]) => html`
                <div class="flex items-center justify-between">
                  <span class="text-sm text-base-content/60">${desc}</span>
                  <kbd class="kbd kbd-sm font-mono">${key}</kbd>
                </div>
              `,
							)}
            </div>
          </div>
        </div>
      </div>
    `;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"rsvp-reader": RsvpReader;
	}
}
