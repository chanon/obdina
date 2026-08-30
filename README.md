# Obdina

Dynalist-style outlining for [Obsidian](https://obsidian.md).

Obsidian's built-in list commands operate on **one line**. Obdina operates on the
**item and everything nested under it** — so indenting, outdenting and moving a
list item takes its subitems along, the way a dedicated outliner does.

## Features

### Indent / outdent with subitems

`Tab` and `Shift+Tab` indent and outdent the item at the cursor *together with
its whole subtree*.

Obsidian's core `Tab` is generic text indentation with a list-flavoured name —
it shifts only the cursor's line, so any children silently stop being children.
Obdina moves the branch as a unit.

It also **detects the indent style per file** and preserves it. A tab-indented
note stays tabs, a 4-space note stays spaces. Nesting depth is measured in
*visual columns*, never in a specific whitespace character, so files that mix
both are read correctly instead of throwing.

### Dynalist-style outdent (optional)

When you outdent an item that still has siblings below it, Obdina can move the
item and its subitems *below the old parent* rather than dedenting in place:

```
- P                    - P
  - a                    - a
  - b       →            - c
    - b1               - b
  - c                    - b1
```

Off by default, since it changes more of the document than a plain dedent.
Without it, `c` would become a child of `b`.

### Move items with subitems

Move an item up or down among its siblings, carrying its whole subtree. The
sibling it swaps with moves as a unit too, so nothing gets stranded.

### Recursive folding

- **Fold branch** — collapse the item and everything under it
- **Fold children** — collapse all descendants, keep the item itself open
- **Unfold branch** — expand the whole subtree
- **Toggle fold** — whichever of the two the item currently isn't

Toggle decides from the item's own fold marker, so it is an exact pair with
fold-branch / unfold-branch and repeated presses alternate cleanly instead of
getting stuck in a half-folded state. All four resolve the cursor to the line
you can actually see first, so they work with the cursor anywhere on a collapsed
item's row.

### Folds survive edits

Moving, indenting or outdenting an item normally re-expands every collapsed
child, because replacing a range of text drops CodeMirror's fold decorations.
Obdina captures the fold set before each edit and remaps it through the same
transformation the text got, so collapsed subtrees stay collapsed.

### Enter after a folded item

At the end of a collapsed item, `Enter` creates the new item **after the whole
collapsed subtree**, as its sibling — instead of inserting inside the fold,
where it becomes a child.

### Backspace joins items, not lines

At the **start** of an item, core's `Backspace` joins the line into the one
above and drags the marker with it — `- a` + `- b` becomes `- a- b`. Obdina
joins the *text* and drops the marker, with two rules on top:

- **An item with subitems does nothing.** Core's join would re-parent the whole
  subtree onto a line it was never under, in one keystroke.
- **The text moves to the previous *visible* item** — a sibling, the parent
  (when this is its first child), a deeper item in another branch, or a
  collapsed one. The collapsed case is the one core gets badly wrong: joining
  across a fold's start tears it open and dumps every hidden child on screen.
  Obdina appends to the collapsed item's own line and re-applies the fold, so
  only text moves.

Either way the cursor lands on the seam, before the text it carried up. If the
line above isn't an item — a heading, a blank line, prose — core handles it
as usual, as it does for Backspace anywhere but the start of an item.

### Down / Up step onto folded items

A collapsed item and its hidden subtree share one visual row, which can leave
the cursor parked on a hidden line and make arrow keys skip the folded item.
Obdina steps by *visible line* using the fold set instead of screen geometry.

### The cursor stays out of the bullet

Vertical cursor motion in CodeMirror is geometric and carries a goal column, so
moving from a long line onto a short indented one can drop the cursor into an
item's leading whitespace. Live Preview then reveals the literal `- ` and the
item looks like it un-rendered into plain text.

After `Up` / `Down`, Obdina moves such a cursor to the first character of the
item's text. And when the cursor *starts* on the first character of an item's
text, it lands on the first character of the next item's text — so moving
through a list keeps the cursor on the text, whatever each item's indentation
is, rather than drifting into a deeper item's bullet. Within a soft-wrapped
item, `Up` / `Down` still move between its visual rows as usual.

It corrects the column *after* CodeMirror's own move rather than replacing it,
so goal-column memory, soft-wrapped rows and tables all behave exactly as
before. Clicks, `Home` and `Shift`+arrow selections are untouched.

### Whole-item selection

When a selection spans more than one list item, expand it to whole items and
their subtrees rather than cutting through lines. Selections within a single
line are left alone.

## Commands and hotkeys

`Tab` / `Shift+Tab` are claimed automatically (and can be turned off in
settings). **No other hotkeys are set by default** — assign them under
*Settings → Hotkeys*, search "Obdina".

| Command | Suggested |
|---|---|
| Indent item and subitems | `Ctrl+]` |
| Outdent item and subitems | `Ctrl+[` |
| Move item and subitems up / down | `Ctrl+Shift+↑` / `Ctrl+Shift+↓` |
| Fold children recursively | `Ctrl+Shift+←` |
| Unfold branch recursively | `Ctrl+Shift+→` |
| Fold branch recursively | — |
| Toggle fold recursively | — |
| Diagnose | — |

Every feature has a toggle in *Settings → Obdina*.

## Design notes

**Depth is measured in visual columns.** A tab advances to the next tab stop, a
space counts one. Files using tabs, files using spaces, and files mixing both
all parse correctly. Writes preserve whatever convention the file already uses.

**Edits are single operations.** Each command issues one `replaceRange` — or,
where two distant spans must change together, one editor transaction — so it's
one undo step and the cursor stays on the same text.

**Commands only fire where the cursor actually is.** Every list command
resolves the item the cursor is *inside* — the item's own line, or a
continuation line indented under it. It deliberately does **not** search upward
past unrelated text, so `Tab` in a paragraph written under a list inserts a tab
instead of quietly indenting the last item of that list.

**Nothing is half-applied.** With a multi-item selection, every item's move is
resolved before any edit is made. If one can't move, the whole operation is
declined and the note is untouched.

## Internal APIs

Some of what Obdina does has no public API, so it uses undocumented Obsidian and
CodeMirror internals:

| Used for | Internal API |
|---|---|
| Claiming `Tab` / `Enter` / `Backspace` / arrows | `@codemirror/view` `keymap` at `Prec.highest` |
| Reading the fold set | `@codemirror/language` `foldedRanges` |
| Reading / writing folds | `MarkdownView.currentMode.getFoldInfo()` / `applyFoldInfo()` |
| Indent defaults | `vault.getConfig("tabSize" / "useTab")` |
| Yielding `Tab` to autocomplete | `workspace.editorSuggest.currentSuggest` |
| Scroll and wrap measurement | `editor.cm` |

**Every one is wrapped in `try`/`catch` with a fallback.** If a future Obsidian
release stops exposing one, the affected feature disables itself with an
explanatory notice rather than breaking the plugin — the commands keep working
even if the keymap can't be registered.

If something misbehaves, run the **Obdina: Diagnose** command with the cursor on
the problem line. It reports which condition stopped the last keypress and
copies a full state dump to your clipboard for a bug report.

## Limitations

- Works in **Source mode and Live Preview**, not Reading view.
- Dynalist-style outdent applies to a single item; a multi-item selection falls
  back to dedenting in place, because the destination would be ambiguous.
- `Tab` on the first child of a parent does nothing, matching Dynalist — there's
  no previous sibling to nest under.
- Selection snapping does not exclude fenced code blocks, since computing fence
  positions on every mouse move would be too expensive.

## Installation

**From Obsidian** — *Settings → Community plugins → Browse*, search "Obdina".

**Manually** — download `main.js` and `manifest.json` from the
[latest release](https://github.com/chanon/obdina/releases/latest) into
`<vault>/.obsidian/plugins/obdina/`, then reload Obsidian and enable it under
*Settings → Community plugins*.

## License

[Apache License 2.0](LICENSE)
