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

Nesting depth is measured in *visual columns*, never in a specific whitespace
character, so files that mix tabs and spaces are read correctly instead of
throwing.

For **writing**, *Indent with* offers three choices:

| | |
|---|---|
| **Match each file** (default) | A tab-indented note stays tabs, a space-indented note stays spaces — nothing is silently converted |
| **Always tabs** | Predictable, and normalises files as you edit |
| **Always spaces** | Likewise, using your Obsidian tab size |

Matching is the safe default, but a file that mixes both is decided by whichever
style is in the majority — which can flip as you edit. Force one if you want
certainty.

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

**Outside a list** — prose, a blank line, a heading, inside a code block — it
moves that single line, like Obsidian's own *Move line up/down*. So one pair of
hotkeys works everywhere instead of doing nothing half the time. If the
neighbour is a collapsed item, the line moves past the **whole** collapsed
region rather than landing inside it.

### Indent without subitems

`Tab` moves an item **with** its subtree. The *Indent item, leave subitems
behind* command moves only the item — its children keep their columns, which
promotes them to siblings of the line that just moved:

```
- one                    - one
- two          →           - two
  - a                      - a
  - b                      - b
```

Useful whenever you want an item to join a group rather than take its group
with it.

### Nesting completed recurring tasks

With the [Tasks](https://publish.obsidian.md/tasks/) plugin, completing a
recurring task adds the next instance on the line above and leaves the completed
one beside it. Turn on *Nest completed recurring tasks under the new one* and
Obdina tucks the finished line under the live one, so each task carries a
foldable log of itself:

```
- [ ] pay bill  [repeat:: every month]  [due:: 2026-10-25]
  - [x] pay bill  [repeat:: every month]  [due:: 2026-09-25]  [completion:: …]
  - [x] pay bill  [repeat:: every month]  [due:: 2026-08-25]  [completion:: …]
```

It indents **only** the completed line, so earlier history stays flat instead of
sinking a level deeper every time. If the task was collapsed when you completed
it, the fold moves up to the new instance — so it stays one collapsed row rather
than becoming a collapsed row with nothing inside it. Off by default, and deliberately narrow: it
fires only when the line above is an *open* instance of the *same* task at the
*same* indent, and never on undo or redo.

Requires the Tasks setting **“Next recurrence appears on the line below”** to be
**off** (its default), so the new instance lands above the completed one. Obdina
reads that setting and warns you in its own settings if it is on, rather than
quietly doing nothing.

### Delete joins items, not lines

At the end of an item, core's forward-`Delete` joins the raw next **line** on,
dragging its indent, bullet and checkbox into the middle of your text. Obdina
joins the two items' **text** and nothing else, with two rules on top:

- **Completion is sticky.** If either item is done, the merged item is done. An
  open item absorbing a completed one adopts its status character, so `[/]` and
  other custom statuses survive.
- **The merged item takes the shallower indent.** Pulling up a subitem keeps
  this item's level; pulling up an item from a parent or grandparent level
  *promotes* this one out to meet it. Its own subitems stay where they are and
  remain its subitems.

"The next item" means the next *visible* one — at the end of a collapsed item
that is the line after its whole hidden subtree, never the first hidden child.

### Delete item

Deletes the item at the cursor **with its subitems**, and leaves the cursor at
the **end of the previous line** — the outliner convention.

Obsidian's own *Delete paragraph* is CodeMirror's `deleteLine`, which places the
cursor with `moveVertically(range, true)`: it moves *down* a line and maps that
through the deletion, so you land on the following line. It is also geometric,
which makes it unreliable next to a collapsed row. This command works from the
fold set instead, so it behaves around folds, and on a non-list line it deletes
just that line — so you can bind it over *Delete paragraph* without losing
anything in ordinary prose.

The cursor's **own** item is what goes: putting the cursor on a child and
pressing delete removes that child, not the parent branch.

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

### Enter knows where the new item belongs

At the end of an item **with subitems**, `Enter` creates the new item as its
**first subitem**. Obsidian inserts at the parent's own indent, directly above
the existing subitems — and because nesting in Markdown is positional, those
subitems silently become children of the new empty item:

```
- parent            - parent            - parent
  - child1   core     -          Obdina   - (new)
  - child2     →        - child1     →      - child1
                        - child2            - child2
```

At the end of a **collapsed** item, `Enter` instead creates the new item *after
the whole collapsed subtree*, as its sibling — rather than inside the fold,
where it would become a child.

Both have their own toggle.

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

### Drag and drop

Drag an item by its **bullet, fold arrow or checkbox** to move it. Its subitems
come along, and a collapsed item moves as one unit. While dragging, an
indicator shows where it will land and **horizontal position picks the depth** —
move right to make it a subitem, left to outdent it. `Escape` cancels.

Bullets and fold arrows show a grab cursor so it is discoverable, and that hint
disappears if you turn dragging off. The text of an item is never a drag handle,
so selecting text works exactly as before. And a plain click on a task checkbox still ticks the task: the press
only becomes a drag once the pointer has actually moved a few pixels.

### Ctrl/Cmd+A selects by outline level

Each press widens by one level instead of grabbing the whole note at once:

```
1.  the item's text            (without its bullet or checkbox)
2.  the item and its subitems
3.  that item and all its siblings, each with their subitems
4.  the parent, with everything under it
5.  the parent and all its siblings
…   repeating out to the top of the list
n.  the whole contiguous list
n+1 the heading section it sits in, then each enclosing heading
…   and finally the whole note — where Obsidian's Select all begins
```

A list is bounded by anything that isn't part of it: a heading, a flush-left
paragraph, a code fence. Blank lines inside a list don't end it.

There is no hidden sequence state: the next level is simply the smallest one
that fully contains what is already selected. So it continues correctly from a
selection made by dragging or by any other command, and once the whole note is
selected it hands over to Obsidian. Outside a list it does nothing at all.

### Whole-item selection

When a selection spans more than one list item, expand it to whole items and
their subtrees rather than cutting through lines. Selections within a single
line are left alone.

Snapping only ever *grows* a selection, so it steps aside when you are
**shrinking one with the keyboard** — otherwise `Shift+Up` would pull the head
off the last item and the snap would put it straight back, forever. Dragging
snaps in both directions; `Shift+Arrow` grows by whole items and shrinks by
lines.

### Optional outline cosmetics

Two appearance tweaks, both **off by default** — enabling the plugin never
restyles your notes until you ask it to:

- **Make collapsed bullets larger** — Obsidian already recolors a collapsed
  item's bullet; this adds size to that signal. Most useful if you hide the
  “…” fold marker, since the bullet is then the only inline cue.
- **Add space between bullet and text** — Obsidian has no setting for this gap;
  it is just the literal space after the `-` in your note. This adds a visual
  margin without touching the text. Checkboxes get a matching nudge.
- **Tint items while dragging them** (on by default) — wash the dragged item and
  its subitems in neutral grey so it is obvious what is moving. Not the accent
  colour: that already marks where it will land.

Both are driven by CSS variables, so a snippet can retune them without turning
the feature off: `--obdina-collapsed-bullet-size`, `--obdina-bullet-gap`,
`--obdina-checkbox-gap`.

## Commands and hotkeys

`Tab` / `Shift+Tab` are claimed automatically (and can be turned off in
settings). **No other hotkeys are set by default** — assign them under
*Settings → Hotkeys*, search "Obdina".

| Command | Suggested |
|---|---|
| Indent item and subitems | `Ctrl+]` |
| Outdent item and subitems | `Ctrl+[` |
| Indent item, leave subitems behind | — |
| Delete item and subitems | `Ctrl+Shift+Backspace` |
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

**Manually** — download `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/chanon/obdina/releases/latest) into
`<vault>/.obsidian/plugins/obdina/`, then reload Obsidian and enable it under
*Settings → Community plugins*.

## License

[Apache License 2.0](LICENSE)
