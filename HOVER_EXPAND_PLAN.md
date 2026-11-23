# Auto Compact — hover-to-expand (plan handoff)

**Status:** planned, **not implemented**. No code has changed yet.
**Written:** 2026-11-13, at the end of a session with the user.
**Plugin:** `auto-compact@0.1.1`, running, source at `/root/themes/bb-plugin-auto-compact`.
**App:** packaged bb `0.48.1` (`http://127.0.0.1:38886`).
**Theme:** Cloudroom (irrelevant to this change; do not touch it).

Read this file top to bottom before editing. It records the user's own words,
what already exists, the one hard technical constraint, the agreed rules, the
implementation sketch, the test list, and the risks.

---

## 1. The request, in the user's words

> "Clicking on the box every time to get expanded is boring. When I bring my
> cursor onto this compacted composer box, I want it to expand. When I move the
> cursor out, I don't want it to compact. Only scrolling should collapse it.
> The rest of the features stay as they are."

This is a **small addition** to an existing, working plugin. The existing
auto-collapse behaviour is liked and must not be redesigned.

---

## 2. Confirmed decisions (from the Q&A round)

| # | Decision |
|---|----------|
| 1 | When the box is compact and the **mouse moves onto it**, it expands. No click. |
| 2 | When the mouse leaves, **nothing happens**. It stays open. |
| 3 | **Scrolling the thread** still collapses it, exactly as today. |
| 4 | **Sending, an agent run, and a question form** still collapse it. All existing shrink triggers stay. |
| 5 | **Clicking outside** stays as today: the box keeps its size, the green ring fades. |
| 6 | **Scrolling with the mouse sitting on the box** scrolls the thread and does **not** shrink the box (already true today). |
| 7 | While an agent is working or asking a question, hovering **still opens** the box. |
| 8 | While dictating into the green compact bar, hovering opens the big box and the mic session keeps running. |
| 9 | The home / new-thread composer is untouched. No theme or app changes. |
| 10 | Opening uses the existing **~150ms grow animation**; no artificial waiting delay. |

### Two assumptions to confirm in the first reply of the next session

The user answered these in a way that can be read two ways. The plan uses the
**safe** reading. State it in one line and let the user correct it before coding:

1. **Hover does not take the keyboard.** It only grows the box. The blinking
   cursor stays where it was; a click still puts you into typing mode, as
   today. Reason: with the box at the bottom of the screen, stealing focus on
   hover means the next Space / PageDown / letter types into the draft.
2. **Reopen guard.** If the box tucks itself away while the mouse is still on
   it (Send is the common case), it waits until the mouse has left the box and
   come back before hover can open it. Otherwise it reopens the instant it
   closes and never stays small. If the user prefers "any tiny movement
   reopens", it is a one-line change (remove the guard).

---

## 3. How the box opens today (the hard constraint)

The plugin has **no expand path**. It only clicks the app's collapse button.
The app opens the compact composer from **focus**:

- The thread wrapper `[data-follow-up-composer]` has an `onFocusCapture`
  handler that clears the app's "collapsed" flag and expands.
- Focusing the compact editor (`.ProseMirror`) therefore expands the box.
- There is **no visible "Expand" button** in compact mode. The chevron
  (`button[aria-label="Collapse prompt box"]`) only collapses.
- After expanding, **blurring does not re-collapse it on desktop**. The app's
  blur handler only re-collapses on the narrow/coarse-pointer layout.

Evidence, in the installed app (version-specific paths, verify if bb updates):

- Composer plugin:
  `/root/.npm/_npx/614ebd23ff24de90/node_modules/bb-app/server/dist/builtin-plugins/composer/dist/app.js`
  - `ve = M?.when === "always"` → renders `data-promptbox-compact`.
  - The collapse button's `onClick` calls `onCollapse` only (never expand).
- Thread view:
  `/root/.npm/_npx/614ebd23ff24de90/node_modules/bb-app/app/dist/assets/thread-detail-DObhspNc.js`
  - `[data-follow-up-composer]` wrapper carries `onFocusCapture` /
    `onBlurCapture`; focus clears the collapsed state.

**Consequence:** hover must expand by focusing the editor, then hand focus
back. That is a 15-minute spike; see §6 step 1. If the box snaps shut when
focus is handed back, use the fallback described there.

Do **not** try to patch React state, add CSS height rules, or fake a click on
the compact row. The compact layout is native and only the app can render it.

---

## 4. What the plugin does today (do not break these)

File: `content-script.ts` (741 lines). Key map:

| Lines | What |
|-------|------|
| 21–30 | Constants: 50px scroll threshold, 300ms typing window, 800ms pointer window, 1200ms scroll-intent window, 200ms live-focus fallback. |
| 41–45 | Selectors: `[data-secondary-panel-tab-content]`, `[data-follow-up-composer]`, `[data-promptbox]`, `.ProseMirror`. |
| 53–55 | `isCompact(form)` → `data-promptbox-compact`. |
| 58–69 | `findForm(viewport)` — the one composer owned by this scroll viewport. |
| 71–162 | `PaneController` fields + viewport listeners. Wheel/touch whose target is inside `[data-promptbox]` are ignored (composer scrolling never collapses). |
| 179–258 | `ensureForm()` — rebinds form listeners when React replaces the form. Contains typing/pointer engagement, submit/keydown, and the blur/refocus trick that lets a click expand a *live* compact bar. |
| 265–268 | `markScrollIntent()`. |
| 270–283 | `trackCompactTransition()` — clears scroll intent when the box opens. |
| 296–311 | `handleOutsideClick()` — blurs, clears engagement/pin, keeps size. |
| 361–396 | `evaluate()` — the decision: scroll wins over pin; run/question collapse after the typing guard. |
| 406–432 | `collapseButton()` / `collapse()` — clicks the app's button; live mode refocuses. |
| 434–461 | Live-focus fallback + `maybeFocusLive()`. |
| 511–528 | `finishSend()` — compact stays compact; expanded collapses. |
| 548–724 | `AutoCompactManager` — per-viewport controllers, global keydown, one-shot focus suppressor, outside-click detection, `focusCompactEditor()`. |

**Rules the existing code enforces (all stay):**

- Collapse when the thread is scrolled >50px above the bottom and there was a
  real scroll gesture in the last 1200ms.
- Never collapse on the initial/restored scroll (no real intent).
- Never collapse for a wheel/touch that starts inside the composer.
- Live collapse keeps focus in the compact editor, keeps the green ring, moves
  the caret to the end so dictation appends. A one-shot document `focus` /
  `focusin` suppressor stops the app's expand-on-focus.
- `userPinnedOpen` holds the box open against run/question changes; a new
  scroll gesture or a send releases it.
- Outside click ends the typing session but does not resize.
- Home composer, side chats, secondary panel are never touched.
- `app.css` only retunes the follow-up composer animation to 150ms.
- Nothing logs on success.

---

## 5. The change (design)

**One file:** `content-script.ts`. Optionally `app.css` remains as is (it
already animates expansion). No other source file needs to change.

### New constants

```ts
/** No waiting by default; the user asked for "animation style" opening. */
const HOVER_DWELL_MS = 0;
/** Ignore hover for a moment after any collapse (send/scroll/run/question). */
const HOVER_COOLDOWN_MS = 400;
/** A real mouse movement, not a layout shift under a still pointer. */
const HOVER_MOVE_PX = 4;
```

The dwell constant exists so "it is too eager" is a one-number change later.

### New `PaneController` state

```ts
private hoverTimer = 0;
private hoverDistance = 0;
private hoverPointerInside = false;
private hoverBlocked = false;      // require leave + re-enter after a collapse
private lastCollapseAt = 0;
```

### New listeners (bind in `ensureForm`, next to the existing ones)

On the **form** (`[data-promptbox]` only — not the wrapper, so the surrounding
footer/gap does not trigger it):

- `pointerenter` → `hoverPointerInside = true; hoverDistance = 0;`
  (Do **not** expand here; expansion needs movement, see below.)
- `pointermove` →
  - ignore if `event.pointerType !== "mouse"`, `event.buttons !== 0`
    (dragging a selection), or `!isCompact(form)`;
  - ignore if `hoverBlocked` or `Date.now() - lastCollapseAt < HOVER_COOLDOWN_MS`;
  - add the movement magnitude to `hoverDistance`; return if `< HOVER_MOVE_PX`;
  - if `HOVER_DWELL_MS === 0`, call `expandFromHover(form)`; else start a timer
    that calls it, cancelled on leave.
- `pointerleave` → clear the timer, `hoverPointerInside = false`,
  `hoverBlocked = false` (the pointer has left; the next entry may open).
- `pointercancel` → same as leave.

Cancel timers in `detachForm()`, `destroy()`, `handleOutsideClick()`, and
`finishSend()`.

### `expandFromHover(form)`

```ts
private expandFromHover(form: HTMLElement) {
  if (this.destroyed || !form.isConnected) return;
  if (!isCompact(form) || !this.hoverPointerInside) return;
  if (Date.now() - this.lastCollapseAt < HOVER_COOLDOWN_MS) return;

  const ed = this.editor(form);
  if (!ed) return;

  const wasFocused = document.activeElement === ed;
  const previous = document.activeElement;

  // Opening is a deliberate request: do not let a stale scroll re-close it,
  // and hold it against run/question until the person scrolls or sends.
  this.lastScrollIntentAt = 0;
  this.userPinnedOpen = true;

  // Focus WITHOUT the suppressor: this is the app's own expand path.
  ed.focus({ preventScroll: true });

  // Hover must not take the keyboard. Hand focus back after the expand
  // commit; never disturb a live dictation session.
  if (!wasFocused) {
    window.setTimeout(() => {
      if (this.destroyed || !form.isConnected || !isCompact(form)) return;
      if (previous instanceof HTMLElement && previous !== ed && previous.isConnected) {
        previous.focus({ preventScroll: true });
      } else {
        ed.blur();
      }
    }, 0);
  }

  this.hoverBlocked = true; // after it collapses again, leave + re-enter first
}
```

Notes:

- `wasFocused === true` means **live dictation / live compact bar**. Do not
  blur; leave focus and the caret alone. This preserves the green ring and
  speech-to-text.
- `userEngaged` is **not** set. Hovering must not turn the green ring on.
- `userPinnedOpen` **is** set, so a run/question appearing right after the
  hover cannot slam the box shut. This matches decision 7.
- A scroll gesture still wins over the pin (existing `evaluate()` logic), so
  decision 3 keeps working.

### Record every collapse

In `collapse(form, live)`, set `this.lastCollapseAt = Date.now()` at the top.
Also set `this.hoverBlocked = true` when the collapse was **not** user-initiated
(scroll / send / run / question). The `pointerleave` resets it.

Why: after Send, the pointer is often still over the send button inside the
small bar. Without this guard, the first 1px move reopens the box. Same for a
scroll collapse where the page shifts under a still pointer.

### Keep unchanged

- `evaluate()` — scroll threshold, pin precedence, typing guard.
- `collapse()`, live focus, suppressor, `handleOutsideClick()`,
  `trackCompactTransition()`, `finishSend()`, keydown send detection.
- Wheel/touch filtering inside the composer (decision 6 needs no change).
- All scope guards (`findForm`) and the home composer exclusion.

---

## 6. Step-by-step plan

### Step 1 — 15-minute spike (do this before writing the feature)

1. Scroll a thread up so the box is compact.
2. In DevTools console, with the box compact:

```js
const form = document.querySelector('[data-follow-up-composer] [data-promptbox]');
const ed = form.querySelector('.ProseMirror');
const keep = document.activeElement;
console.log('compact before:', form.hasAttribute('data-promptbox-compact'));
ed.focus({ preventScroll: true });
setTimeout(() => {
  console.log('expanded after focus:', !form.hasAttribute('data-promptbox-compact'));
  if (keep && keep !== ed && keep.isConnected) keep.focus({ preventScroll: true });
  else ed.blur();
  setTimeout(() => {
    console.log('still expanded after handing focus back:',
      !form.hasAttribute('data-promptbox-compact'));
  }, 300);
}, 0);
```

Expected: `true`, then `true`. Also try a narrow window.

**If it snaps shut:** do not force focus. Instead, dispatch the app's own focus
signal on the wrapper while the editor is *not* focused, e.g.
`form.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))` (React maps
`onFocus` / `onFocusCapture` to `focusin`), and verify it expands and stays
expanded. Prefer whichever path is least invasive; record the result at the
top of the next session.

### Step 2 — back up

The folder is **not a git repo**.

```bash
cp /root/themes/bb-plugin-auto-compact/content-script.ts \
   /root/themes/bb-plugin-auto-compact/content-script.ts.bak-2026-11-13
```

### Step 3 — implement

Add the constants, state, listeners, `expandFromHover`, and the collapse
timestamp described in §5. Keep the diff tight; no refactors.

### Step 4 — build and reload

```bash
bb plugin build /root/themes/bb-plugin-auto-compact
bb plugin reload auto-compact
bb plugin list | grep auto-compact      # should say running
bb plugin logs auto-compact             # should stay empty
```

`bb plugin dev /root/themes/bb-plugin-auto-compact` rebuilds on save if useful.

### Step 5 — test matrix

| # | Situation | Expected |
|---|-----------|----------|
| 1 | Scroll up so the box is compact, move the mouse onto it | It opens with the 150ms glide, no click |
| 2 | Move the mouse away | Stays open, no size change |
| 3 | Scroll the thread (mouse over messages) | Collapses to the 50px bar |
| 4 | Hover it again | Opens again |
| 5 | Send a message, leave the mouse on the send button | Stays collapsed; must leave the bar and come back to reopen |
| 6 | Agent running, box compact | Hover opens it; run ending does not close it |
| 7 | Agent question form on screen | Hover opens the box; question still usable |
| 8 | Dictating into the green compact bar, then hover | Opens; green ring stays; caret at end; words keep appending |
| 9 | Click outside while expanded | Stays open; green ring fades; size unchanged |
| 10 | Click inside after hovering | Focuses and types exactly as before |
| 11 | Scroll with the mouse sitting on the open box | Thread scrolls; box does not shrink |
| 12 | Home / new-thread composer | Completely unchanged |
| 13 | Narrow window / touch | No hover behaviour; click still works |
| 14 | Mouse parked over the bar when a run starts | Does not reopen by itself (cooldown + guard) |
| 15 | Scroll while the pointer is stationary over the compact bar | No open/close flicker (layout-shift entry must be ignored) |

### Step 6 — docs

Update, in the same commit/session:

- `README.md` — the behaviour table and the "Click the compact bar" lines.
- `PLUGIN_OVERVIEW.md` — "opens again when you click it" → "opens when the
  mouse moves onto it; click to type".
- `skills/auto-compact/SKILL.md` — behaviour + "what to tell the person".
- `CLOUDROOM_HANDOFF.md` — the locked decision "Expand rule: click the compact
  row to expand" is superseded. Add a short dated section or a pointer to this
  file; do not silently rewrite history.

### Step 7 — rollback

```bash
cp /root/themes/bb-plugin-auto-compact/content-script.ts.bak-2026-11-13 \
   /root/themes/bb-plugin-auto-compact/content-script.ts
bb plugin build /root/themes/bb-plugin-auto-compact && bb plugin reload auto-compact
# or, immediately:
bb plugin disable auto-compact
```

---

## 7. Risks (the honest list)

1. **Opens when the mouse only crosses the bottom of the screen.** The box sits
   where the mouse travels; with no dwell, passing over it grows it and shifts
   the thread up ~100px. Accepted by the user ("animation style, no waiting").
   Mitigation kept in code: `HOVER_DWELL_MS` is a single number.
2. **Flicker after an auto-collapse.** Page shift under a still pointer can
   look like a hover. Mitigated by requiring a real `pointermove`
   (`HOVER_MOVE_PX`), a cooldown, and the leave-and-return guard.
3. **Reopens immediately after Send.** Mitigated by `hoverBlocked` +
   `lastCollapseAt`.
4. **Keyboard theft / accidental typing.** Avoided by handing focus back and
   never suppressing a live dictation session. This is also the part most
   likely to be misunderstood — confirm the assumption in §2 first.
5. **Layout jump while reading.** Inherent to expanding at the bottom; the
   150ms glide softens it.
6. **"Compact while the agent works" is weakened.** A deliberate hover opens it
   (user's choice). A parked mouse must not — that is what the movement +
   cooldown guards are for.
7. **bb update changes the DOM.** The plugin is matched to 0.48.1. It already
   no-ops when hooks are missing; re-test after every bb upgrade.
8. **Focus hand-back race.** The app may commit the expand asynchronously. The
   spike in Step 1 decides whether a `setTimeout(0)` hand-back is enough or
   whether the fallback focus event is needed. If neither is stable, the
   fallback is to keep focus (i.e. behave like a click) and tell the user.

---

## 8. Guardrails (do not do)

- Do not touch the home / new-thread composer, side chats, or the secondary
  panel.
- Do not add CSS height/layout overrides for the compact state.
- Do not remove or hide the manual chevron.
- Do not change the scroll threshold, the 300ms typing guard, the pin
  semantics, the live green bar, or the send detection.
- Do not make hover set `userEngaged` (it would light the green ring for a
  mouse pass).
- Do not keep the keyboard focused on hover (unless the user explicitly
  overrides the assumption in §2).
- Do not edit anything under `/root/.bb` or the packaged app.

---

## 9. Pointers

- Plugin folder: `/root/themes/bb-plugin-auto-compact/`
- Main file: `content-script.ts` (741 lines)
- Animation: `app.css` (150ms, follow-up composer only)
- Live design record: `/root/themes/CLOUDROOM_HANDOFF.md` Part 2 (§18)
- Long-term native port notes: `/root/themes/bb_imp_github.md`
- Current state check: `bb status`, `bb plugin list`, `bb plugin logs auto-compact`
