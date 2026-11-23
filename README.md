# bb-plugin-auto-compact

Keeps the bb thread follow-up composer out of the way while you read — without
ending your dictation session.

When you scroll more than 50px above the bottom of a thread, the plugin clicks
bb's own **Collapse prompt box** button. The composer becomes the native 50px
compact row. If you were actually typing, clicking, or dictating, the compact
editor keeps focus, so dictation continues and the theme's green focus ring
stays visible. Clicking outside the composer ends the session. Clicking the
compact bar opens the full composer again.

It never expands by itself, never collapses while you scroll inside the
composer, and never touches the home / new-thread composer.

## What it changes

- `content-script.ts` — the whole feature: a per-pane controller for each
  `[data-page-scroll-viewport]`. It only clicks the app's existing collapse
  button; the compact layout, draft handling, and expand-on-click are native.
  It also refocuses the compact editor with a one-shot focus suppressor so the
  app's own expand-on-focus does not fire, moves the caret to the end so
  dictation appends, and watches for sends (Enter and the send button).
- `app.css` — one scoped animation change: the thread follow-up composer
  expands/collapses in ~150ms with a medium-to-fast ease-out instead of 180ms.
  It is skipped for `prefers-reduced-motion: reduce`.
- `server.ts` — an empty backend factory. bb 0.48 requires a `bb.server` entry
  even for a frontend-only plugin; it registers nothing.

No theme CSS, no packaged-app files, and no React state are modified.

## Build, install, reload

```bash
bb plugin build /root/themes/bb-plugin-auto-compact
bb plugin install /root/themes/bb-plugin-auto-compact --yes
bb plugin list                 # shows auto-compact@0.1.1 running
bb plugin reload auto-compact  # after a rebuild
```

`bb plugin dev /root/themes/bb-plugin-auto-compact` rebuilds and reloads on save.

## Behaviour

| Trigger | Result |
|---------|--------|
| Scroll the **thread** (wheel / touch / scrollbar / PageUp-style keys) more than 50px above the bottom, while engaged | Collapse immediately; the compact editor keeps focus, the green ring stays, and typing/dictation keeps appending |
| Scroll the thread while **not** engaged (for example the app's autofocus on thread open) | Collapse immediately; blur; no green ring |
| Scroll **inside** the composer box | No collapse; it behaves like a normal composer |
| Exactly 50px or less above the bottom | Stay expanded |
| Click outside the composer (expanded or compact) | End the session: blur, green ring fades. The size does not change, so a compact bar stays compact |
| Click the compact bar (not one of its buttons) | Native expand; the editor gets focus |
| Enter or the send button with a valid draft, from expanded | Collapse to the plain compact bar (no green) once the message is accepted |
| Enter or the send button from the compact live bar | Stay compact; blur; green ring fades |
| Agent run active (`aria-label="Stop run"`) | Collapse after the 300ms typing guard; never live |
| Agent question form on screen (`[data-question-form]`) | Collapse; stay compact after it disappears |
| Scroll back to the bottom, run ends, question dismissed | Stay compact (no auto-expand) |
| Home / new-thread composer, side chats, secondary panel | Never touched |

The 150ms is animation only. The scroll check is immediate.

### Live compact mode (scroll only)

Scrolling changes only the size, not the typing session. The compact editor is
still mounted, so the plugin keeps it focused:

- "Engaged" means a real key press, IME composition, paste, or pointer-down in
  the composer. The app's automatic focus on thread open does **not** count.
- If the editor is focused and engaged at the moment of the scroll, the collapse
  is **live**: the app collapses the bar, then the plugin focuses the compact
  editor again with a one-shot document-level `focus` / `focusin` suppressor.
  That runs before React's root listener, so the app's expand-on-focus does not
  fire. Without the suppressor, focusing the compact bar makes the app expand it
  after ~400ms.
- After the refocus the caret is moved to the end, so voice dictation appends
  instead of prepending.
- The theme's existing `[data-promptbox]:focus-within` rule then draws the same
  green ring around the 50px bar. No new ring is added.
- Clicking outside the composer clears engagement and blurs the editor, so the
  ring fades and the voice typer stops landing in the box. The bar stays compact.
- Clicking the compact bar while it is live blurs and refocuses the editor on
  the next tick, which produces the focus event the app needs to expand.

Scrolling **inside** the composer is ordinary composer scrolling. Wheel, touch,
and pointer gestures whose target is inside `[data-promptbox]` are ignored by
the collapse logic, so they can never shrink or reopen the composer.

### Sending

Sending always ends the live session:

- **Send button**: the form's native `submit` event fires; the plugin waits
  briefly for the draft to clear, then blurs (compact) or collapses (expanded).
- **Enter**: bb sends directly from the editor's keydown handler and never
  fires a native `submit` event. The plugin therefore listens on the form in
  the **capture** phase, before bb clears the draft, and polls briefly for the
  empty draft. If the send was blocked (still uploading, disabled), the draft
  stays and nothing is collapsed.

The composer form can be replaced while sending, so the check always re-queries
the current form instead of using the element captured at key time.

### Pinned open while steering

A running agent must never close a composer you deliberately opened. Clicking
the compact row, typing, pasting, or dictating pins the composer open. The pin
survives run start/stop and question changes; it is released only by a **new**
scroll gesture that leaves the bottom, or by sending. This is what makes
steering and speech-to-text usable: you can open the composer, dictate for as
long as you need, and it will not snap shut.

A scroll gesture that leaves the bottom always wins over the pin: it collapses
the composer. If you were engaged and focused at that moment, it collapses to
the live green bar instead of ending the session.

## DOM contract

| Purpose | Selector |
|---------|----------|
| Thread scroll container | `[data-page-scroll-viewport]` |
| Follow-up wrapper | `[data-follow-up-composer]` |
| Composer form | `[data-follow-up-composer] [data-promptbox]` |
| Collapse control | `button[aria-label="Collapse prompt box"]` |
| Compact state | `[data-promptbox][data-promptbox-compact]` |
| Running state | `[data-promptbox-submit-action][aria-label="Stop run"]` |
| Question form | `[data-question-form]` |
| Editor | `[data-promptbox] .ProseMirror` |
| Excluded subtree | `[data-secondary-panel-tab-content]` |

bb 0.48 renders **three** `[data-promptbox-standard-actions]` containers in the
composer, so the collapse button is found by its `aria-label`, not by "the one
button in the container". If a future bb changes these hooks, the script stops
collapsing instead of guessing with CSS classes.

## Notes and limits

- The script ignores programmatic `scrollTop` changes as scroll intent; a real
  wheel, touch, keyboard, or scrollbar gesture is required. This is what keeps
  initial load / scroll restoration from collapsing the composer.
- A scroll gesture counts as intent for 1200ms. Collapsing near the bottom
  shrinks the scroll range by ~100px. The plugin never auto-expands, so the two
  states cannot fight.
- Run and question collapses keep the older 300ms typing guard; scroll collapses
  are immediate.
- The behaviour is a content script, not a native bb feature. Re-verify the DOM
  hooks after a bb upgrade.
- No settings and no CLI command. Enable or disable it with
  `bb plugin enable|disable auto-compact`.
