---
name: auto-compact
description: "Explain or troubleshoot the Auto Compact follow-up composer behaviour in bb threads."
---

# Auto Compact

This plugin is already on by default once installed. It has no command, no
setting, and no visible panel.

## Behaviour

In a **thread** (not the home / new-thread screen), the follow-up composer
collapses to the native 50px compact row when any of these is true:

- you scrolled the thread more than 50px above the bottom (wheel, touch,
  PageUp-style keys, or the scrollbar),
- you sent a message (Enter or send),
- an agent run is active,
- an agent question form is on screen.

Scroll collapse is **live** when you were actually typing, clicking, or
dictating: the compact bar keeps focus, keeps the theme's green focus ring, and
keeps accepting text. The app's automatic focus on thread open does not count.
Run and question collapses are never live and keep the 300ms typing guard.

Scrolling **inside** the composer is normal composer scrolling and never
collapses it. Clicking outside the composer ends the session: it blurs, the
green ring fades, and the size does not change. It never expands by itself;
click the compact row to open it. Sending from the compact bar keeps it compact
and fades the ring; sending from the full composer collapses it.

The home composer, side chats, and the secondary panel are never affected.

Clicking the compact row, typing, or dictating **pins the composer open**. The
pin outranks the run and question triggers, so steering and speech-to-text are
not interrupted. A new scroll gesture away from the bottom (or sending) releases
the pin and collapses it; the draft is preserved. If you were engaged, that
collapse is the live green bar.

## What to tell the person

- "Scroll up and it tucks away but stays live: the green ring means your
  dictation is still going into the small bar."
- "Click outside the box to stop dictating; click the bar to type in the full
  composer again."
- The draft is preserved while compact.
- To turn the behaviour off: `bb plugin disable auto-compact`. To turn it back
  on: `bb plugin enable auto-compact`.

## Troubleshooting

1. `bb plugin list` should show `auto-compact` as `running`.
2. `bb plugin logs auto-compact` should be empty; the content script does not log
   on success.
3. If a bb update changes the composer DOM, the script does nothing instead of
   guessing. Re-check these hooks: `[data-follow-up-composer]`,
   `[data-promptbox-compact]`, `button[aria-label="Collapse prompt box"]`,
   `[data-promptbox-submit-action][aria-label="Stop run"]`,
   `[data-question-form]`, and `[data-promptbox] .ProseMirror`.
4. If scrolling collapses the bar but the green ring or typing stops working,
   the app's expand-on-focus may have changed. Re-test the compact refocus path
   (one-shot document `focus` / `focusin` suppressor).
5. Rebuild and reload after edits:

   ```bash
   bb plugin build /root/themes/bb-plugin-auto-compact
   bb plugin reload auto-compact
   ```
