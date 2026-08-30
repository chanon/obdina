/*
 * Copyright 2026 chanon
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

"use strict";

/*
 * Obdina — Dynalist-style outlining for Obsidian.
 *
 * Commands:
 *   fold-branch    fold the item at the cursor and everything under it
 *   fold-children  fold all descendants, keep the item itself open
 *   unfold-branch  expand the whole subtree
 *   indent-item    indent the item AND its subitems one level
 *   outdent-item   outdent the item AND its subitems one level
 *
 * Design rule that runs through the whole file: nesting depth is computed from
 * *visual columns*, never from a specific whitespace character. A tab advances
 * to the next tab stop, a space counts 1. That means a tab-indented file, a
 * 4-space-indented file, and a file that mixes both all parse correctly instead
 * of throwing. Writes go the other way — they preserve whatever convention the
 * file already uses, so we never contaminate a tab file with spaces.
 */

const { Plugin, MarkdownView, Notice, PluginSettingTab, Setting } = require("obsidian");

/* Tab can't be assigned in Obsidian's hotkey UI — it's reserved by the editor.
 * The only way to own it is a CodeMirror keymap registered at highest
 * precedence, ahead of Obsidian's own Tab handling. Obsidian exposes these
 * modules to plugins at runtime, so no bundler is needed; if that ever stops
 * being true we degrade to command-only (Ctrl+] / Ctrl+[) rather than crash. */
let cmKeymap = null;
let cmPrec = null;
let cmEditorView = null;
let cmEditorSelection = null;
let cmFoldedRanges = null;
try {
	const view = require("@codemirror/view");
	const state = require("@codemirror/state");
	cmKeymap = view.keymap;
	cmEditorView = view.EditorView;
	cmPrec = state.Prec;
	cmEditorSelection = state.EditorSelection;
} catch (e) {
	/* CodeMirror not exposed on this build — commands still work */
}
try {
	// The authoritative fold state. Obsidian's getFoldInfo() is a wrapper over
	// this, and going straight to the source avoids depending on its shape.
	cmFoldedRanges = require("@codemirror/language").foldedRanges;
} catch (e) {
	/* fall back to getFoldInfo() */
}

const DEFAULT_SETTINGS = {
	tabIndents: true,
	relocateOnOutdent: false,
	preserveFolds: true,
	snapSelection: true,
	smartEnter: true,
	arrowStepsOverFolds: true,
};

const LIST_RE = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+/;
/* Same shape as LIST_RE but with the pieces captured, plus an optional task
 * checkbox, so a new sibling item can be built from an existing one. */
const ITEM_PARTS_RE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(\[[^\]]?\][ \t]+)?/;
const HEADING_RE = /^(#{1,6})[ \t]+/;
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

/* ── whitespace primitives ───────────────────────────────────────────── */

function columnsOf(ws, tabWidth) {
	let col = 0;
	for (let i = 0; i < ws.length; i++) {
		if (ws[i] === "\t") col += tabWidth - (col % tabWidth);
		else col += 1;
	}
	return col;
}

function leadingWs(line) {
	const m = /^[ \t]*/.exec(line);
	return m ? m[0] : "";
}

function indentColumns(line, tabWidth) {
	return columnsOf(leadingWs(line), tabWidth);
}

const isBlank = (line) => line.trim().length === 0;

/* Remove `columns` worth of leading whitespace. If a tab straddles the cut
 * point we'd otherwise delete more than asked, so the overshoot is re-padded
 * with spaces — the line keeps its exact intended depth. */
function stripColumns(ws, columns, tabWidth) {
	let col = 0;
	let i = 0;
	while (i < ws.length && col < columns) {
		col += ws[i] === "\t" ? tabWidth - (col % tabWidth) : 1;
		i++;
	}
	let rest = ws.slice(i);
	if (col > columns) rest = " ".repeat(col - columns) + rest;
	return rest;
}

function makeIndent(columns, useTabs, tabWidth) {
	if (useTabs) return "\t".repeat(Math.max(1, Math.round(columns / tabWidth)));
	return " ".repeat(Math.max(1, columns));
}

/* Fenced code lines are excluded from all structure detection, so a "- item"
 * or "# heading" inside a dataview/tasks block is never treated as real. */
function computeFenced(lines) {
	const fenced = new Array(lines.length).fill(false);
	let openChar = null;
	for (let i = 0; i < lines.length; i++) {
		const m = FENCE_RE.exec(lines[i]);
		if (m) {
			const ch = m[1][0];
			if (openChar === null) openChar = ch;
			else if (ch === openChar) openChar = null;
			fenced[i] = true;
		} else if (openChar !== null) {
			fenced[i] = true;
		}
	}
	return fenced;
}

/* ── structure queries ───────────────────────────────────────────────── */

/* Last line belonging to the list item at `start`. Blank lines never end a
 * branch by themselves — only a later line at or above the base indent does,
 * which keeps loosely-spaced lists intact. */
function listBranchEnd(lines, start, tabWidth) {
	const base = indentColumns(lines[start], tabWidth);
	let end = start;
	for (let i = start + 1; i < lines.length; i++) {
		if (isBlank(lines[i])) continue;
		if (indentColumns(lines[i], tabWidth) > base) end = i;
		else break;
	}
	return end;
}

function headingBranchEnd(lines, start, level, fenced) {
	for (let i = start + 1; i < lines.length; i++) {
		if (fenced[i]) continue;
		const m = HEADING_RE.exec(lines[i]);
		if (m && m[1].length <= level) return i - 1;
	}
	return lines.length - 1;
}

/* Nearest enclosing heading or list item at/above `from` — the cursor is often
 * on a blank line or a wrapped continuation. */
function findBranchRoot(lines, fenced, from) {
	for (let i = Math.min(from, lines.length - 1); i >= 0; i--) {
		if (fenced[i] || isBlank(lines[i])) continue;
		if (HEADING_RE.test(lines[i]) || LIST_RE.test(lines[i])) return i;
	}
	return -1;
}

function findListRoot(lines, fenced, from) {
	for (let i = Math.min(from, lines.length - 1); i >= 0; i--) {
		if (fenced[i] || isBlank(lines[i])) continue;
		if (LIST_RE.test(lines[i])) return i;
		if (HEADING_RE.test(lines[i])) return -1;
	}
	return -1;
}

/* Previous *sibling*: the nearest earlier list item at exactly the same column.
 * Bails out at any shallower line, since that means we've left the parent. */
function prevSiblingLine(lines, fenced, from, col, tabWidth) {
	for (let i = from - 1; i >= 0; i--) {
		if (fenced[i] || isBlank(lines[i])) continue;
		const c = indentColumns(lines[i], tabWidth);
		if (!LIST_RE.test(lines[i])) {
			if (c < col) return -1;
			continue;
		}
		if (c === col) return i;
		if (c < col) return -1;
	}
	return -1;
}

/* Next sibling: the nearest later list item at exactly the same column, without
 * escaping the parent. Mirror of prevSiblingLine. */
function nextSiblingLine(lines, fenced, from, col, tabWidth) {
	for (let i = from; i < lines.length; i++) {
		if (fenced[i] || isBlank(lines[i])) continue;
		const c = indentColumns(lines[i], tabWidth);
		if (!LIST_RE.test(lines[i])) {
			if (c < col) return -1;
			continue;
		}
		if (c === col) return i;
		if (c < col) return -1;
	}
	return -1;
}

function parentLine(lines, fenced, from, col, tabWidth) {
	for (let i = from - 1; i >= 0; i--) {
		if (fenced[i] || isBlank(lines[i])) continue;
		if (!LIST_RE.test(lines[i])) continue;
		const c = indentColumns(lines[i], tabWidth);
		if (c < col) return i;
	}
	return -1;
}

/* Column of the first existing child of the item at `line`, or -1. */
function firstChildColumn(lines, fenced, line, col, tabWidth) {
	for (let i = line + 1; i < lines.length; i++) {
		if (isBlank(lines[i])) continue;
		const c = indentColumns(lines[i], tabWidth);
		if (c <= col) return -1;
		if (!fenced[i] && LIST_RE.test(lines[i])) return c;
		return -1;
	}
	return -1;
}

function collectFolds(lines, fenced, from, to, tabWidth) {
	const folds = [];
	for (let i = from; i <= to; i++) {
		if (fenced[i] || isBlank(lines[i])) continue;
		let end = -1;
		const hm = HEADING_RE.exec(lines[i]);
		if (hm) end = headingBranchEnd(lines, i, hm[1].length, fenced);
		else if (LIST_RE.test(lines[i])) end = listBranchEnd(lines, i, tabWidth);
		if (end < 0) continue;
		end = Math.min(end, to);
		if (end > i) folds.push({ from: i, to: end });
	}
	return folds;
}

/* What indent convention does this document use? Prefer the file's own habit
 * so edits stay internally consistent; fall back to Obsidian's setting only
 * when the file has no indented list items to learn from. */
function detectIndentStyle(lines, fenced, tabWidth, fallbackUseTabs) {
	let tabs = 0;
	let spaces = 0;
	const cols = new Set();
	for (let i = 0; i < lines.length; i++) {
		if (fenced[i] || isBlank(lines[i])) continue;
		const m = LIST_RE.exec(lines[i]);
		if (!m || !m[1]) continue;
		if (m[1].includes("\t")) tabs++;
		if (m[1].includes(" ")) spaces++;
		cols.add(columnsOf(m[1], tabWidth));
	}
	let useTabs = fallbackUseTabs;
	if (tabs > 0 && spaces === 0) useTabs = true;
	else if (spaces > 0 && tabs === 0) useTabs = false;
	else if (tabs > 0 && spaces > 0) useTabs = tabs >= spaces;

	// The indent unit is the shallowest non-zero depth in the file — 4 for a
	// 4-space document, tabWidth for a tab document.
	const positive = Array.from(cols).filter((c) => c > 0).sort((a, b) => a - b);
	const unit = positive.length ? positive[0] : tabWidth;
	return { useTabs, unit: unit > 0 ? unit : tabWidth };
}

/* ── visible-line arithmetic over a fold set ─────────────────────────────
 * Fold entries are {from, to} line numbers where `from` stays visible and
 * from+1 .. to are hidden. */

/* Last line hidden by a fold starting on `line`, or -1 if nothing starts here.
 * Takes the widest when several start on the same line — "fold children"
 * nests folds, so one line can host more than one. */
function foldEndAt(folds, line) {
	let end = -1;
	for (const f of folds) if (f.from === line && f.to > end) end = f.to;
	return end;
}

/* If `line` is hidden, the `from` of the outermost fold hiding it; -1 when the
 * line is already visible. Loops because a hidden line's enclosing fold can
 * itself be hidden inside another one. */
function foldStartCovering(folds, line) {
	let at = line;
	let found = -1;
	for (let guard = 0; guard < 100; guard++) {
		let next = -1;
		for (const f of folds) {
			if (f.from < at && at <= f.to && (next < 0 || f.from < next)) next = f.from;
		}
		if (next < 0) break;
		found = next;
		at = next;
	}
	return found;
}

/* The prefix for a new sibling of `line`: same indentation and bullet, ordered
 * numbers incremented, and a task checkbox reset to unchecked — so Enter after
 * "- [x] done" gives a fresh "- [ ] ", matching Obsidian core. */
function nextItemPrefix(line) {
	const m = ITEM_PARTS_RE.exec(line);
	if (!m) return null;
	const ws = m[1];
	let marker = m[2];
	const gap = m[3];
	const box = m[4];
	const ordered = /^(\d+)([.)])$/.exec(marker);
	if (ordered) marker = String(parseInt(ordered[1], 10) + 1) + ordered[2];
	return ws + marker + gap + (box ? "[ ] " : "");
}

/* ── selection snapping (CodeMirror doc, 1-based lines) ──────────────────
 * These walk CodeMirror's Text object directly instead of splitting the whole
 * document into an array. Selection changes fire on every mousemove during a
 * drag, so touching only the handful of lines around the selection keeps this
 * cheap even in your 4000-line notes. */

function docLine(doc, n) {
	return doc.line(Math.max(1, Math.min(n, doc.lines)));
}

/* Nearest list-item line at or above `n`. Bounded so a selection in ordinary
 * prose can't walk the entire document looking for a list. */
function docItemRoot(doc, n) {
	const limit = Math.max(1, n - 500);
	for (let i = n; i >= limit; i--) {
		const text = docLine(doc, i).text;
		if (LIST_RE.test(text)) return i;
		if (HEADING_RE.test(text)) return -1;
		if (text.trim() === "") return -1;
	}
	return -1;
}

function docSubtreeEnd(doc, rootNo, tabWidth) {
	const base = columnsOf(leadingWs(docLine(doc, rootNo).text), tabWidth);
	let end = rootNo;
	for (let i = rootNo + 1; i <= doc.lines; i++) {
		const text = docLine(doc, i).text;
		if (text.trim() === "") continue;
		if (columnsOf(leadingWs(text), tabWidth) > base) end = i;
		else break;
	}
	return end;
}

/* ── plugin ──────────────────────────────────────────────────────────── */

class ObdinaPlugin extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.addSettingTab(new ObdinaSettingTab(this.app, this));

		// The keymap reads this.settings at call time rather than being
		// registered conditionally, so toggling the setting takes effect
		// immediately instead of needing a reload.
		if (cmKeymap && cmPrec) {
			this.registerEditorExtension(
				cmPrec.highest(
					cmKeymap.of([
						{ key: "Tab", run: () => this.handleTab("indent") },
						{ key: "Shift-Tab", run: () => this.handleTab("outdent") },
						{ key: "Enter", run: () => this.handleEnter() },
						{ key: "ArrowDown", run: () => this.handleArrow(1) },
						{ key: "ArrowUp", run: () => this.handleArrow(-1) },
					])
				)
			);
		}

		if (cmEditorView && cmEditorSelection) {
			this.registerEditorExtension(cmEditorView.updateListener.of((u) => this.onSelectionUpdate(u)));
		}

		this.addCommand({
			id: "diagnose",
			name: "Diagnose: why didn't Enter / arrows fire here?",
			editorCallback: (editor, ctx) => this.runDiagnose(editor, ctx),
		});
		this.addCommand({
			id: "fold-branch",
			name: "Fold branch recursively (collapse this item and all below it)",
			editorCallback: (editor, ctx) => this.runFold(editor, ctx, "fold", true),
		});
		this.addCommand({
			id: "fold-children",
			name: "Fold children recursively (keep this item open)",
			editorCallback: (editor, ctx) => this.runFold(editor, ctx, "fold", false),
		});
		this.addCommand({
			id: "unfold-branch",
			name: "Unfold branch recursively",
			editorCallback: (editor, ctx) => this.runFold(editor, ctx, "unfold", true),
		});
		this.addCommand({
			id: "indent-item",
			name: "Indent item and subitems",
			editorCallback: (editor) => this.runIndent(editor, "indent"),
		});
		this.addCommand({
			id: "outdent-item",
			name: "Outdent item and subitems",
			editorCallback: (editor) => this.runIndent(editor, "outdent"),
		});
		this.addCommand({
			id: "move-item-up",
			name: "Move item and subitems up",
			editorCallback: (editor) => this.runMove(editor, "up"),
		});
		this.addCommand({
			id: "move-item-down",
			name: "Move item and subitems down",
			editorCallback: (editor) => this.runMove(editor, "down"),
		});
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/*
	 * Outliner-style selection: once a selection spans more than one list item,
	 * snap it to whole items (and their subtrees) instead of cutting through
	 * the middle of lines.
	 *
	 * Runs from an updateListener rather than a transactionFilter, and defers
	 * the dispatch to a microtask — CodeMirror throws "calls to update are not
	 * allowed while an update is in progress" if you dispatch synchronously
	 * from inside one. The deferral also coalesces the burst of selection
	 * events a mouse drag produces.
	 */
	onSelectionUpdate(update) {
		if (!this.settings.snapSelection) return;
		if (!update.selectionSet || update.docChanged) return;
		if (this._snapPending) return;

		const view = update.view;
		this._snapPending = true;
		Promise.resolve().then(() => {
			this._snapPending = false;
			try {
				const next = this.snapSelection(view.state);
				if (next) view.dispatch({ selection: next });
			} catch (e) {
				/* never let a selection tweak break typing */
			}
		});
	}

	/* Returns a corrected EditorSelection, or null when nothing needs changing.
	 * Snapping is idempotent — re-snapping an already-snapped selection returns
	 * null — which is what stops dispatch from looping. */
	snapSelection(state) {
		const doc = state.doc;
		const tabWidth = this.tabWidth();
		let changed = false;

		const ranges = state.selection.ranges.map((r) => {
			if (r.empty) return r;

			const fromLineNo = doc.lineAt(r.from).number;
			let toLineNo = doc.lineAt(r.to).number;
			// A selection ending exactly at a line start visually covers only the
			// line above, so don't drag the next item in.
			if (toLineNo > fromLineNo && r.to === docLine(doc, toLineNo).from) toLineNo--;
			if (fromLineNo === toLineNo) return r; // single line: leave alone

			const startRoot = docItemRoot(doc, fromLineNo);
			const endRoot = docItemRoot(doc, toLineNo);
			if (startRoot < 0 || endRoot < 0) return r; // not a list selection

			const from = docLine(doc, startRoot).from;
			const to = docLine(doc, docSubtreeEnd(doc, endRoot, tabWidth)).to;
			if (from === r.from && to === r.to) return r;

			changed = true;
			// Preserve drag direction so shift-clicking keeps extending the way
			// the user expects.
			return r.anchor <= r.head
				? cmEditorSelection.range(from, to)
				: cmEditorSelection.range(to, from);
		});

		if (!changed) return null;
		return cmEditorSelection.create(ranges, state.selection.mainIndex);
	}

	/*
	 * replaceRange() drops CodeMirror's fold decorations inside the replaced
	 * span, so any collapsed child re-expands after an edit. Every Obdina
	 * structural edit *permutes or re-indents* lines without adding or removing
	 * any, so the fold set is still meaningful afterwards — it just needs its
	 * line numbers pushed through the same transformation the text got.
	 *
	 * Capture before the edit, restore after.
	 */
	captureFolds() {
		if (!this.settings.preserveFolds) return null;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const sub = view && view.currentMode;
		if (!sub || typeof sub.getFoldInfo !== "function" || typeof sub.applyFoldInfo !== "function") return null;
		const info = sub.getFoldInfo();
		const folds = info && Array.isArray(info.folds) ? info.folds.map((f) => ({ from: f.from, to: f.to })) : [];
		if (!folds.length) return null;
		return { sub, folds };
	}

	/*
	 * Only folds *starting* inside the edited span need remapping. One starting
	 * before it is a heading fold whose extent is unchanged — the span keeps its
	 * total line count — so remapping its end would corrupt a fold the edit
	 * never touched.
	 */
	restoreFolds(cap, spanStart, spanEnd, mapLine, lineCount) {
		if (!cap) return;
		const byStart = new Map();
		for (const f of cap.folds) {
			let from = f.from;
			let to = f.to;
			if (f.from >= spanStart && f.from <= spanEnd) {
				from = mapLine(f.from);
				to = f.to >= spanStart && f.to <= spanEnd ? mapLine(f.to) : f.to;
			}
			if (from == null || to == null || to <= from) continue;
			byStart.set(from, { from, to });
		}
		const folds = Array.from(byStart.values()).sort((a, b) => a.from - b.from);
		// Apply immediately to avoid a visible flash, then again once the
		// document change has settled and CodeMirror has re-measured.
		const apply = () => cap.sub.applyFoldInfo({ folds, lines: lineCount });
		apply();
		requestAnimationFrame(apply);
	}

	/* An editor suggest popup (wikilink, tag, natural-language date…) uses Tab
	 * to accept its highlighted entry. Stealing Tab while one is open would
	 * break completion everywhere, so we always yield to it. */
	isSuggestOpen() {
		try {
			const s = this.app.workspace.editorSuggest;
			if (s && s.currentSuggest) return true;
		} catch (e) {
			/* fall through to the DOM probe */
		}
		return !!document.querySelector(".suggestion-container");
	}

	/* Returns true only when Obdina actually owns this keypress. Returning
	 * false lets the event fall through to Obsidian's normal Tab handling, so
	 * Tab still indents inside code blocks, moves between table cells, and
	 * inserts a tab in ordinary prose. */
	handleTab(direction) {
		if (!this.settings.tabIndents) return false;
		if (this.isSuggestOpen()) return false;

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = view && view.editor;
		if (!editor) return false;

		return this.runIndent(editor, direction, true);
	}

	/* Reports every gate handleEnter() checks, so a "nothing happened" can be
	 * traced to one specific condition instead of guessed at. */
	runDiagnose(editor, ctx) {
		const view = ctx instanceof MarkdownView ? ctx : this.app.workspace.getActiveViewOfType(MarkdownView);
		const sub = view && view.currentMode;
		const cur = editor.getCursor();
		const lines = editor.getValue().split("\n");
		const line = lines[cur.line] == null ? "" : lines[cur.line];
		const fenced = computeFenced(lines);
		const m = LIST_RE.exec(line);

		let direct = null;
		let viaWrapper = null;
		try {
			direct = cmFoldedRanges && editor.cm ? this.foldLinesDirect(editor) : null;
		} catch (e) {
			direct = "threw: " + e.message;
		}
		try {
			const info = sub && typeof sub.getFoldInfo === "function" ? sub.getFoldInfo() : null;
			viaWrapper = info && info.folds ? info.folds : null;
		} catch (e) {
			viaWrapper = "threw: " + e.message;
		}
		const folds = this.foldLines(editor, sub);

		const report = {
			// The single most important field: did our keymap binding run at
			// all on your last Enter press, and where did it exit?
			lastEnterPress: this._lastEnter || "handleEnter() has NEVER run — our Enter binding is not reaching the keymap",
			suggestOpenNow: (() => {
				try {
					return {
						result: this.isSuggestOpen(),
						currentSuggest: !!(this.app.workspace.editorSuggest && this.app.workspace.editorSuggest.currentSuggest),
						domProbe: !!document.querySelector(".suggestion-container"),
					};
				} catch (e) {
					return "threw: " + e.message;
				}
			})(),
			pluginVersion: this.manifest && this.manifest.version,
			obsidianMode: sub && sub.type ? sub.type : String(sub && sub.constructor && sub.constructor.name),
			cursor: { line: cur.line, ch: cur.ch },
			lineLength: line.length,
			lineTrimmedLength: line.replace(/\s+$/, "").length,
			atEndOfContent: cur.ch >= line.replace(/\s+$/, "").length,
			lineText: line,
			isListItem: !!m,
			isEmptyItem: m ? !line.slice(m[0].length).trim() : null,
			insideCodeFence: !!fenced[cur.line],
			cmExposed: { keymap: !!cmKeymap, foldedRanges: !!cmFoldedRanges, editorCm: !!editor.cm },
			foldsDirectFromCodeMirror: direct,
			foldsFromObsidianGetFoldInfo: viaWrapper,
			foldsUsed: folds,
			foldStartsOnCursorLine: folds.some((f) => f.from === cur.line),
			subtreeEnd: listBranchEnd(lines, cur.line, this.tabWidth()),
			settings: this.settings,
		};
		// Copy rather than log: a diagnostic is only useful once it's out of the
		// app and into a bug report, and this keeps the plugin off the console
		// entirely in normal use.
		const dump = JSON.stringify(report, null, 2);
		let copied = false;
		try {
			navigator.clipboard.writeText(dump);
			copied = true;
		} catch (e) {
			console.log("[Obdina] diagnose", report); // clipboard blocked — fall back
		}

		const why = !this._lastEnter
			? "handleEnter() has NEVER run — our Enter binding never reached the keymap"
			: this._lastEnter.handled === false
				? "last Enter bailed: " + this._lastEnter.reason + (this._lastEnter.extra ? " [" + this._lastEnter.extra + "]" : "")
				: !cmKeymap
			? "CodeMirror keymap not exposed"
			: !this.settings.smartEnter
				? "smartEnter setting is off"
				: !m
					? "cursor line is not a list item"
					: fenced[cur.line]
						? "cursor is inside a code fence"
						: !report.atEndOfContent
							? "cursor is not at the end of the line"
							: report.isEmptyItem
								? "item is empty (core ends the list)"
								: !report.foldStartsOnCursorLine
									? "no fold starts on this line — folds seen: " + JSON.stringify(folds)
									: report.subtreeEnd <= cur.line
										? "no subtree beneath this item"
										: "all gates pass — Enter should have fired";
		new Notice(
			"Obdina: " + why + "\n\n" + (copied ? "Full report copied to clipboard." : "Full report in the developer console."),
			15000
		);
	}

	/* Fold state read straight from CodeMirror, no Obsidian wrapper. */
	foldLinesDirect(editor) {
		const doc = editor.cm.state.doc;
		const out = [];
		const iter = cmFoldedRanges(editor.cm.state).iter();
		while (iter.value) {
			out.push({ from: doc.lineAt(iter.from).number - 1, to: doc.lineAt(iter.to).number - 1 });
			iter.next();
		}
		return out;
	}

	/* Current folds as 0-based {from, to} line numbers, where `from` stays
	 * visible and from+1 .. to are hidden.
	 *
	 * Reads CodeMirror's fold state directly when @codemirror/language is
	 * exposed. Obsidian's getFoldInfo() is a wrapper over exactly this, but it
	 * exists in two implementations — one for reading view built from rendered
	 * sections, one for the CM6 editor — and which one `view.currentMode`
	 * resolves to isn't guaranteed. The direct read has no such ambiguity. */
	foldLines(editor, sub) {
		const cm = editor && editor.cm;
		if (cmFoldedRanges && cm && cm.state) {
			try {
				const doc = cm.state.doc;
				const out = [];
				const iter = cmFoldedRanges(cm.state).iter();
				while (iter.value) {
					out.push({
						from: doc.lineAt(iter.from).number - 1, // CM lines are 1-based
						to: doc.lineAt(iter.to).number - 1,
					});
					iter.next();
				}
				return out;
			} catch (e) {
				/* fall through to the Obsidian wrapper */
			}
		}
		if (sub && typeof sub.getFoldInfo === "function") {
			const info = sub.getFoldInfo();
			if (info && Array.isArray(info.folds)) return info.folds;
		}
		return [];
	}

	/* ── Down / Up across folded items ──────────────────────────────────
	 * CodeMirror moves the cursor vertically by *geometry*: coordsAtPos on the
	 * current position, add a line height to y, then posAtCoords to see what's
	 * there. A collapsed region is represented by a single replace-widget, and
	 * when that probe misreads the collapsed row the cursor overshoots it and
	 * lands on the next item instead.
	 *
	 * This bypasses geometry entirely and steps by *visible line*, derived from
	 * the fold set. getFoldInfo() reads CodeMirror's real fold state, so this
	 * sees folds made by the gutter arrow exactly as well as Obdina's own.
	 *
	 * Deliberately narrow: it only claims the keypress when folds actually
	 * change the answer. Everywhere else it returns false and CodeMirror's
	 * normal handling — soft-wrapped rows, goal-column memory, tables — is
	 * untouched. */
	handleArrow(dir) {
		if (!this.settings.arrowStepsOverFolds) return false;
		if (this.isSuggestOpen()) return false;

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = view && view.editor;
		const sub = view && view.currentMode;
		if (!editor) return false;

		const sels = editor.listSelections();
		if (sels.length !== 1) return false;
		const sel = sels[0];
		if (sel.anchor.line !== sel.head.line || sel.anchor.ch !== sel.head.ch) return false;
		const cur = sel.head;

		const folds = this.foldLines(editor, sub);
		if (!folds.length) return false;

		// A soft-wrapped line occupies several visual rows, and Down/Up should
		// move between those rows rather than between lines. Only CodeMirror
		// knows the row layout, so hand those back.
		if (this.isWrapped(editor, cur.line)) return false;

		/* Same trap as handleEnter: the cursor may be parked on a hidden line at
		 * the far end of a collapsed range, because that's where the visual row
		 * ends. Resolve to the visible item before doing any line arithmetic —
		 * otherwise "does a fold start here?" is asked about the wrong line and
		 * always answers no. */
		const covering = foldStartCovering(folds, cur.line);
		const here = covering >= 0 ? covering : cur.line;

		let target;
		if (dir > 0) {
			const end = foldEndAt(folds, here);
			if (end < 0) return false; // this line isn't folded — core is correct
			target = end + 1;
		} else {
			const above = here - 1;
			if (above < 0) return false;
			const top = foldStartCovering(folds, above);
			target = top >= 0 ? top : above;
			// If nothing was hidden and we weren't on a hidden line either,
			// core's handling is already right.
			if (top < 0 && covering < 0) return false;
		}
		if (target < 0 || target > editor.lastLine()) return false;

		editor.setCursor({ line: target, ch: Math.min(cur.ch, editor.getLine(target).length) });
		return true;
	}

	isWrapped(editor, line) {
		const cm = editor.cm;
		if (!cm || typeof cm.lineBlockAt !== "function") return false;
		try {
			const block = cm.lineBlockAt(editor.posToOffset({ line, ch: 0 }));
			return block.height > cm.defaultLineHeight * 1.5;
		} catch (e) {
			return false; // undocumented API — assume unwrapped rather than break arrows
		}
	}

	/* ── Enter at the end of a folded item ──────────────────────────────
	 * Obsidian inserts the new line immediately below the cursor line — which
	 * is *inside* the collapsed region. The new item either disappears into the
	 * fold or forces it open, and either way it ends up a child rather than a
	 * sibling. Dynalist instead starts the next item after the whole collapsed
	 * subtree. Returns false in every other situation, so ordinary Enter is
	 * completely untouched. */
	handleEnter() {
		// Every exit is recorded, so "nothing happened" can be traced to one
		// specific line afterwards instead of re-derived and guessed at.
		const bail = (reason, extra) => {
			this._lastEnter = { at: new Date().toISOString(), fired: true, handled: false, reason, extra };
			return false;
		};
		this._lastEnter = { at: new Date().toISOString(), fired: true, handled: null, reason: "started" };

		if (!this.settings.smartEnter) return bail("smartEnter setting is off");
		if (this.isSuggestOpen()) return bail("an editor suggest popup is open");

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = view && view.editor;
		const sub = view && view.currentMode;
		if (!editor) return bail("no active markdown editor");

		const sels = editor.listSelections();
		if (sels.length !== 1) return bail("more than one selection", sels.length);
		const sel = sels[0];
		if (sel.anchor.line !== sel.head.line || sel.anchor.ch !== sel.head.ch)
			return bail("selection is not empty", JSON.stringify(sel));
		const cur = sel.head;

		const lines = editor.getValue().split("\n");
		const line = lines[cur.line];
		if (line == null) return bail("cursor line out of range", cur.line);
		// At the end of the line's content. Trailing whitespace is tolerated so
		// a stray space after the text doesn't silently disable this; splitting
		// a line mid-text is a different operation and belongs to core.
		if (cur.ch < line.replace(/\s+$/, "").length)
			return bail("cursor is not at end of line", "ch=" + cur.ch + " len=" + line.length);

		const fenced = computeFenced(lines);
		if (fenced[cur.line]) return bail("cursor is inside a code fence");

		const folds = this.foldLines(editor, sub);

		/* A fold is a replace decoration, so the collapsed subtree and the item
		 * that owns it share ONE visual row. Pressing End — or clicking past
		 * the fold marker — therefore parks the cursor at the end of that row,
		 * which is the fold's LAST HIDDEN LINE, not the item you can see.
		 *
		 * So resolve the visible item first. foldStartCovering() walks outward
		 * through nested folds and returns the outermost line still on screen;
		 * -1 means the cursor line was already visible. */
		const covering = foldStartCovering(folds, cur.line);
		const root = covering >= 0 ? covering : cur.line;
		const rootLine = lines[root];
		if (rootLine == null) return bail("resolved root line out of range", root);

		const m = LIST_RE.exec(rootLine);
		if (!m) return bail("line is not a list item", JSON.stringify(rootLine));
		// An empty item means "end the list" in Obsidian; leave that to core.
		if (!rootLine.slice(m[0].length).trim()) return bail("item is empty");

		// The item must actually be collapsed — a fold has to start on it.
		const foldEnd = foldEndAt(folds, root);
		if (foldEnd < 0) return bail("no fold starts on line " + root + " (cursor line " + cur.line + ")");

		// Insert past whichever reaches further: the collapsed range or the
		// item's real subtree. They normally agree, but a partially-folded
		// subtree would otherwise drop the new item in the middle of it.
		const end = Math.max(foldEnd, listBranchEnd(lines, root, this.tabWidth()));
		if (end <= root) return bail("no subtree beneath this item");

		this._lastEnter.handled = true;
		this._lastEnter.reason = "handled — item on line " + root + ", inserted after line " + end;

		const prefix = nextItemPrefix(rootLine);
		if (prefix == null) return bail("could not build a sibling prefix");

		editor.replaceRange("\n" + prefix, { line: end, ch: lines[end].length });
		editor.setCursor({ line: end + 1, ch: prefix.length });

		/* This is the one Obdina edit that changes the line count, so it can't
		 * reuse restoreFolds(), which assumes a permutation. The shift is
		 * simple: one line appears after `end`. The fold we just typed past
		 * ends exactly at `end`, so it survives untouched and the new sibling
		 * lands outside it. An enclosing heading fold reaching past `end` grows
		 * by one, to keep containing the same content. */
		if (this.settings.preserveFolds && typeof sub.applyFoldInfo === "function" && folds.length) {
			const remapped = folds
				.map((f) => ({
					from: f.from > end ? f.from + 1 : f.from,
					// Strictly greater: a fold ending exactly at `end` is the
					// subtree we just typed past, and must NOT grow — otherwise
					// it swallows the sibling we just created. One reaching
					// beyond `end` is an enclosing fold and does grow.
					to: f.to > end ? f.to + 1 : f.to,
				}))
				.sort((a, b) => a.from - b.from);
			const apply = () => sub.applyFoldInfo({ folds: remapped, lines: lines.length + 1 });
			apply();
			requestAnimationFrame(apply);
		}
		return true;
	}

	tabWidth() {
		try {
			const n = this.app.vault.getConfig("tabSize");
			if (typeof n === "number" && n > 0) return n;
		} catch (e) {
			/* getConfig is undocumented; fall through to the default */
		}
		return 4;
	}

	usesTabs() {
		try {
			const v = this.app.vault.getConfig("useTab");
			if (typeof v === "boolean") return v;
		} catch (e) {
			/* ignore */
		}
		return true;
	}

	/* ── indent / outdent ───────────────────────────────────────────────
	 * Operates on whole subtrees: the item at the cursor plus every line
	 * nested under it moves together, so relative structure is preserved.
	 * With a multi-line selection, every top-level item in the selection is
	 * shifted (descendants are skipped — they ride along with their parent
	 * rather than being shifted twice). */
	runIndent(editor, direction, quiet) {
		const lines = editor.getValue().split("\n");
		const fenced = computeFenced(lines);
		const tabWidth = this.tabWidth();
		const style = detectIndentStyle(lines, fenced, tabWidth, this.usesTabs());

		const sels = editor.listSelections();
		let selFrom = Infinity;
		let selTo = -Infinity;
		for (const s of sels) {
			selFrom = Math.min(selFrom, s.anchor.line, s.head.line);
			selTo = Math.max(selTo, s.anchor.line, s.head.line);
		}
		if (!isFinite(selFrom)) return false;

		// Inside a fenced block Tab belongs to the code editor, not to us.
		// Without this guard findListRoot would walk *past* the fence and
		// silently indent some unrelated list item above it.
		if (fenced[Math.min(selFrom, lines.length - 1)]) return false;

		// Top-level items within the selection. Anything already covered by a
		// previous root's subtree is skipped so it isn't shifted twice.
		const roots = [];
		for (let i = selFrom; i <= selTo; i++) {
			if (fenced[i] || isBlank(lines[i]) || !LIST_RE.test(lines[i])) continue;
			const last = roots.length ? roots[roots.length - 1] : null;
			if (last && i <= last.end) continue;
			roots.push({ start: i, end: listBranchEnd(lines, i, tabWidth) });
		}
		if (!roots.length) {
			const r = findListRoot(lines, fenced, selFrom);
			if (r < 0) {
				if (!quiet) new Notice("Obdina: no list item at the cursor.");
				return false;
			}
			roots.push({ start: r, end: listBranchEnd(lines, r, tabWidth) });
		}

		// Dynalist-style outdent physically relocates the subtree below its old
		// parent instead of dedenting where it sits. Only meaningful for a
		// single root — with a multi-item selection the destination is
		// ambiguous, so those fall through to the in-place path below.
		if (direction === "outdent" && this.settings.relocateOnOutdent && roots.length === 1) {
			const moved = this.tryRelocateOutdent(editor, lines, fenced, tabWidth, roots[0], sels);
			if (moved !== null) return moved;
		}

		// Resolve every root's shift before touching the document, so a refusal
		// leaves the note completely untouched rather than half-applied.
		const plans = [];
		for (const r of roots) {
			const col = indentColumns(lines[r.start], tabWidth);
			let target;

			if (direction === "indent") {
				const prev = prevSiblingLine(lines, fenced, r.start, col, tabWidth);
				if (prev < 0) {
					// Dynalist parity: the first child of a parent can't indent
					// further. Consume the key anyway so Tab doesn't fall through
					// and inject literal whitespace into the outline.
					if (!quiet) new Notice("Obdina: can't indent — no previous sibling to nest under.");
					return true;
				}
				// Land exactly on the previous sibling's existing children, so we
				// become their sibling rather than nesting a level too deep.
				const childCol = firstChildColumn(lines, fenced, prev, indentColumns(lines[prev], tabWidth), tabWidth);
				target = childCol >= 0 ? childCol : indentColumns(lines[prev], tabWidth) + style.unit;
			} else {
				if (col === 0) {
					if (!quiet) new Notice("Obdina: already at the top level.");
					return true;
				}
				const parent = parentLine(lines, fenced, r.start, col, tabWidth);
				target = parent >= 0 ? indentColumns(lines[parent], tabWidth) : Math.max(0, col - style.unit);
			}

			const delta = target - col;
			if (delta !== 0) plans.push({ ...r, delta });
		}
		if (!plans.length) return true;

		// Apply by adding/removing a prefix rather than rebuilding each line's
		// whitespace. Rebuilding would normalize (and thus silently rewrite) the
		// subtree's internal indentation; prefixing preserves it exactly.
		const out = lines.slice();
		const charDelta = new Map();
		for (const p of plans) {
			for (let l = p.start; l <= p.end; l++) {
				if (isBlank(out[l])) continue;
				const ws = leadingWs(out[l]);
				const rest = out[l].slice(ws.length);
				let newWs;
				if (p.delta > 0) newWs = ws + makeIndent(p.delta, style.useTabs, tabWidth);
				else newWs = stripColumns(ws, -p.delta, tabWidth);
				out[l] = newWs + rest;
				charDelta.set(l, newWs.length - ws.length);
			}
		}

		const first = plans[0].start;
		const last = plans[plans.length - 1].end;

		// In-place indent changes only leading whitespace — no line moves — so
		// folds map back onto themselves.
		const cap = this.captureFolds();

		// One replaceRange over the whole affected span = one undo step.
		editor.replaceRange(
			out.slice(first, last + 1).join("\n"),
			{ line: first, ch: 0 },
			{ line: last, ch: lines[last].length }
		);

		// Shift the cursor by however many characters its own line gained or
		// lost, so it stays on the same text rather than drifting into the
		// indentation.
		editor.setSelections(
			sels.map((s) => ({
				anchor: shiftPos(s.anchor, charDelta),
				head: shiftPos(s.head, charDelta),
			}))
		);
		this.restoreFolds(cap, first, last, (l) => l, lines.length);
		return true;
	}

	/*
	 * Move the item at the cursor up or down among its siblings, carrying its
	 * whole subtree. Depth never changes — this only reorders. At the first or
	 * last sibling position it's a no-op rather than escaping the parent, which
	 * matches Dynalist and keeps the operation reversible.
	 *
	 * Implemented as a permutation: build the list of old line numbers in their
	 * new order, then derive both the replacement text and the cursor mapping
	 * from that single array. Any blank lines separating the two siblings stay
	 * between them instead of being swallowed.
	 */
	runMove(editor, direction) {
		const lines = editor.getValue().split("\n");
		const fenced = computeFenced(lines);
		const tabWidth = this.tabWidth();
		const sels = editor.listSelections();
		const cursorLine = sels.length ? Math.min(sels[0].anchor.line, sels[0].head.line) : editor.getCursor().line;

		const s = findListRoot(lines, fenced, cursorLine);
		if (s < 0) {
			new Notice("Obdina: no list item at the cursor.");
			return;
		}
		const e = listBranchEnd(lines, s, tabWidth);
		const col = indentColumns(lines[s], tabWidth);

		let spanStart;
		let spanEnd;
		const order = [];

		if (direction === "up") {
			const ps = prevSiblingLine(lines, fenced, s, col, tabWidth);
			if (ps < 0) {
				new Notice("Obdina: already the first item at this level.");
				return;
			}
			const prevEnd = listBranchEnd(lines, ps, tabWidth);
			spanStart = ps;
			spanEnd = e;
			for (let i = s; i <= e; i++) order.push(i); // us, first
			for (let i = prevEnd + 1; i < s; i++) order.push(i); // separator
			for (let i = ps; i <= prevEnd; i++) order.push(i); // them, after
		} else {
			const ns = nextSiblingLine(lines, fenced, e + 1, col, tabWidth);
			if (ns < 0) {
				new Notice("Obdina: already the last item at this level.");
				return;
			}
			const nextEnd = listBranchEnd(lines, ns, tabWidth);
			spanStart = s;
			spanEnd = nextEnd;
			for (let i = ns; i <= nextEnd; i++) order.push(i); // them, first
			for (let i = e + 1; i < ns; i++) order.push(i); // separator
			for (let i = s; i <= e; i++) order.push(i); // us, after
		}

		const newLineOf = new Map();
		order.forEach((oldLine, idx) => newLineOf.set(oldLine, spanStart + idx));

		const cap = this.captureFolds();

		editor.replaceRange(
			order.map((i) => lines[i]).join("\n"),
			{ line: spanStart, ch: 0 },
			{ line: spanEnd, ch: lines[spanEnd].length }
		);

		const mapLine = (l) => (newLineOf.has(l) ? newLineOf.get(l) : l);
		const remap = (pos) => ({ line: mapLine(pos.line), ch: pos.ch });
		editor.setSelections(sels.map((x) => ({ anchor: remap(x.anchor), head: remap(x.head) })));
		this.restoreFolds(cap, spanStart, spanEnd, mapLine, lines.length);
	}

	/*
	 * Dynalist-style outdent: lift the subtree out and re-insert it directly
	 * after its old parent's subtree, instead of dedenting it where it sits.
	 *
	 * Why this differs at all: nesting in Markdown is positional, so dedenting
	 * an item that still has siblings *below* it leaves those siblings deeper
	 * than it — they silently become its children. Relocating past them keeps
	 * everyone's parentage intact.
	 *
	 * Returns true if it relocated, or null when relocation doesn't apply
	 * (no parent, or the item is already last) so the caller can fall back to
	 * the simpler in-place dedent, which is equivalent in those cases.
	 */
	tryRelocateOutdent(editor, lines, fenced, tabWidth, root, sels) {
		const s = root.start;
		const e = root.end;
		const col = indentColumns(lines[s], tabWidth);
		if (col === 0) return null;

		const p = parentLine(lines, fenced, s, col, tabWidth);
		if (p < 0) return null;

		const parentEnd = listBranchEnd(lines, p, tabWidth);
		// Already the last thing under the parent — nothing to move past, so an
		// in-place dedent produces an identical document.
		if (e >= parentEnd) return null;

		const delta = indentColumns(lines[p], tabWidth) - col;

		// Dedent the block by prefix-stripping, preserving its internal shape.
		const block = [];
		const blockCharDelta = [];
		for (let l = s; l <= e; l++) {
			if (isBlank(lines[l])) {
				block.push(lines[l]);
				blockCharDelta.push(0);
				continue;
			}
			const ws = leadingWs(lines[l]);
			const rest = lines[l].slice(ws.length);
			const newWs = stripColumns(ws, -delta, tabWidth);
			block.push(newWs + rest);
			blockCharDelta.push(newWs.length - ws.length);
		}

		// Rewriting [s .. parentEnd] as "everything that followed us" + "us"
		// performs the whole move in one edit: the trailing siblings slide up,
		// and the block lands after them at its new depth.
		const trailing = lines.slice(e + 1, parentEnd + 1);
		const cap = this.captureFolds();

		editor.replaceRange(
			trailing.concat(block).join("\n"),
			{ line: s, ch: 0 },
			{ line: parentEnd, ch: lines[parentEnd].length }
		);

		const shift = trailing.length;
		const blockLen = e - s + 1;
		// The block slides down past the siblings; the siblings slide up past it.
		const mapLine = (l) => {
			if (l >= s && l <= e) return l + shift;
			if (l > e && l <= parentEnd) return l - blockLen;
			return l;
		};
		const remap = (pos) => ({
			line: mapLine(pos.line),
			ch: pos.line >= s && pos.line <= e ? Math.max(0, pos.ch + blockCharDelta[pos.line - s]) : pos.ch,
		});
		editor.setSelections(sels.map((x) => ({ anchor: remap(x.anchor), head: remap(x.head) })));
		this.restoreFolds(cap, s, parentEnd, mapLine, lines.length);
		return true;
	}

	/* ── folding ────────────────────────────────────────────────────────── */

	runFold(editor, ctx, mode, includeRoot) {
		const view = ctx instanceof MarkdownView ? ctx : null;
		const subView = view && view.currentMode;
		if (!subView || typeof subView.applyFoldInfo !== "function" || typeof subView.getFoldInfo !== "function") {
			new Notice("Obdina: this Obsidian version doesn't expose the fold API.");
			return;
		}

		const lines = editor.getValue().split("\n");
		const fenced = computeFenced(lines);
		const tabWidth = this.tabWidth();
		const root = findBranchRoot(lines, fenced, editor.getCursor().line);
		if (root < 0) {
			new Notice("Obdina: no heading or list item at the cursor.");
			return;
		}

		const hm = HEADING_RE.exec(lines[root]);
		const branchEnd = hm
			? headingBranchEnd(lines, root, hm[1].length, fenced)
			: listBranchEnd(lines, root, tabWidth);
		if (branchEnd <= root) {
			new Notice("Obdina: nothing beneath this item.");
			return;
		}

		const existing = subView.getFoldInfo();
		const byStart = new Map();
		if (existing && Array.isArray(existing.folds)) {
			for (const f of existing.folds) byStart.set(f.from, f);
		}

		const start = includeRoot ? root : root + 1;
		if (mode === "fold") {
			const found = collectFolds(lines, fenced, start, branchEnd, tabWidth);
			if (found.length === 0) {
				new Notice("Obdina: no foldable children here.");
				return;
			}
			for (const f of found) byStart.set(f.from, f);
		} else {
			for (const key of Array.from(byStart.keys())) {
				if (key >= start && key <= branchEnd) byStart.delete(key);
			}
		}

		const folds = Array.from(byStart.values()).sort((a, b) => a.from - b.from);
		this.applyPreservingScroll(editor, subView, { folds, lines: lines.length }, root);

		if (view.app && view.app.workspace && typeof view.app.workspace.requestSaveLayout === "function") {
			view.app.workspace.requestSaveLayout();
		}
	}

	/* applyFoldInfo() rebuilds the entire fold set rather than diffing it, which
	 * forces a CodeMirror re-measure and leaves the scroller pointing at the
	 * wrong content. Collapsing lines also changes total document height, so
	 * restoring the old scrollTop alone lands somewhere else. Instead anchor on
	 * the branch root: hold its distance from the viewport top constant. */
	applyPreservingScroll(editor, subView, info, anchorLine) {
		const cm = editor.cm;
		const scroller = cm && cm.scrollDOM;

		if (!scroller || typeof cm.lineBlockAt !== "function") {
			const before = editor.getScrollInfo ? editor.getScrollInfo() : null;
			subView.applyFoldInfo(info);
			if (before && typeof editor.scrollTo === "function") {
				requestAnimationFrame(() => editor.scrollTo(before.left || 0, before.top || 0));
			}
			return;
		}

		const anchorPos = editor.posToOffset({ line: anchorLine, ch: 0 });
		const offsetInViewport = cm.lineBlockAt(anchorPos).top - scroller.scrollTop;

		subView.applyFoldInfo(info);

		const restore = () => {
			const top = cm.lineBlockAt(anchorPos).top - offsetInViewport;
			scroller.scrollTop = Math.max(0, top);
		};
		restore();
		requestAnimationFrame(restore);
	}
}

class ObdinaSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Tab / Shift-Tab indent list items")
			.setDesc(
				cmKeymap
					? "Dynalist-style. Tab indents the item and its subitems, Shift-Tab outdents. Falls through to Obsidian's normal Tab outside lists, inside code blocks, and while an autocomplete popup is open."
					: "Unavailable — this Obsidian build doesn't expose CodeMirror to plugins. Use Ctrl+] / Ctrl+[ instead."
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.tabIndents && !!cmKeymap)
					.setDisabled(!cmKeymap)
					.onChange(async (v) => {
						this.plugin.settings.tabIndents = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Dynalist-style outdent")
			.setDesc(
				"When outdenting an item that still has siblings below it, move the item and its subitems below the old parent instead of dedenting in place. " +
					"Off: the item dedents where it sits, which makes those trailing siblings become its children."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.relocateOnOutdent).onChange(async (v) => {
					this.plugin.settings.relocateOnOutdent = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Snap multi-item selection")
			.setDesc(
				cmEditorView
					? "When a selection spans more than one list item, expand it to whole items and their subitems instead of cutting through lines. Selections within a single line are left alone."
					: "Unavailable — this Obsidian build doesn't expose CodeMirror to plugins."
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.snapSelection && !!cmEditorView)
					.setDisabled(!cmEditorView)
					.onChange(async (v) => {
						this.plugin.settings.snapSelection = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Down / Up step onto folded items")
			.setDesc(
				cmKeymap
					? "Move the cursor one visible line at a time, so a collapsed item is a normal stop rather than being skipped over. Only applies when a fold is actually adjacent; ordinary cursor movement is untouched."
					: "Unavailable — this Obsidian build doesn't expose CodeMirror to plugins."
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.arrowStepsOverFolds && !!cmKeymap)
					.setDisabled(!cmKeymap)
					.onChange(async (v) => {
						this.plugin.settings.arrowStepsOverFolds = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Enter after a folded item starts the next item below it")
			.setDesc(
				cmKeymap
					? "At the end of a collapsed item, Enter creates the new item after the whole collapsed subtree, as its sibling. Off: Obsidian's default, which inserts the line inside the collapsed region."
					: "Unavailable — this Obsidian build doesn't expose CodeMirror to plugins."
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.smartEnter && !!cmKeymap)
					.setDisabled(!cmKeymap)
					.onChange(async (v) => {
						this.plugin.settings.smartEnter = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Preserve folds through edits")
			.setDesc(
				"Keep collapsed subitems collapsed when you move, indent or outdent an item. " +
					"Off: Obsidian's default, where any edit expands folded children."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.preserveFolds).onChange(async (v) => {
					this.plugin.settings.preserveFolds = v;
					await this.plugin.saveSettings();
				})
			);
	}
}

function shiftPos(pos, charDelta) {
	const d = charDelta.get(pos.line);
	if (!d) return { line: pos.line, ch: pos.ch };
	return { line: pos.line, ch: Math.max(0, pos.ch + d) };
}

module.exports = ObdinaPlugin;
