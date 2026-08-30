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

### Folds survive edits

Moving, indenting or outdenting an item normally re-expands every collapsed
child, because replacing a range of text drops CodeMirror's fold decorations.
Obdina captures the fold set before each edit and remaps it through the same
transformation the text got, so collapsed subtrees stay collapsed.

### Enter after a folded item

At the end of a collapsed item, `Enter` creates the new item **after the whole
collapsed subtree**, as its sibling — instead of inserting inside the fold,
where it becomes a child.

### Down / Up step onto folded items

A collapsed item and its hidden subtree share one visual row, which can leave
the cursor parked on a hidden line and make arrow keys skip the folded item.
Obdina steps by *visible line* using the fold set instead of screen geometry.

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
| Diagnose | — |

Every feature has a toggle in *Settings → Obdina*.

## Design notes

**Depth is measured in visual columns.** A tab advances to the next tab stop, a
space counts one. Files using tabs, files using spaces, and files mixing both
all parse correctly. Writes preserve whatever convention the file already uses.

**Edits are single operations.** Each command issues one `replaceRange`, so it's
one undo step and the cursor stays on the same text.

**Nothing is half-applied.** With a multi-item selection, every item's move is
resolved before any edit is made. If one can't move, the whole operation is
declined and the note is untouched.

## Internal APIs

Some of what Obdina does has no public API, so it uses undocumented Obsidian and
CodeMirror internals:

| Used for | Internal API |
|---|---|
| Claiming `Tab` / `Enter` / arrows | `@codemirror/view` `keymap` at `Prec.highest` |
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
