A quieter reading view for long threads: the follow-up composer collapses
itself while you read and opens again when you click it.

## What you get

- Scroll up more than 50px and the composer becomes bb's native 50px compact
  row, with your draft still visible.
- If you were typing or dictating, the compact bar keeps focus, keeps the
  theme's green focus ring, and keeps accepting text. Scrolling changes only
  the size, not the typing session.
- Clicking outside the composer ends that session: the ring fades and dictation
  stops. The bar stays compact.
- Scrolling inside the composer is normal composer scrolling; it never collapses
  it.
- It also stays compact while an agent run is active and while an agent asks
  you a question (never green).
- Sending from the compact bar keeps it compact and fades the ring; sending from
  the full composer collapses it, so the reply has more room.
- Clicking the compact row opens the full composer again with a short, smooth
  ~150ms motion.
- Steering while a run is active is safe: click the composer (or start
  dictation) and it stays open until you scroll away or send. A running agent
  cannot close a composer you deliberately opened.

## What it does not touch

- The home / new-thread composer: full editor, model selector, mic, send, and
  the project / environment row stay exactly as they are.
- Side chats, split-pane siblings, and the secondary panel.
- The Cloudroom theme, the app bundle, or any React state.

## How it works

The plugin runs a trusted content script in the bb app shell. It watches each
thread's scroll viewport and clicks bb's own **Collapse prompt box** button when
one of the triggers is met. The compact layout, the draft, and click-to-expand
are the app's native behaviour, so the plugin adds no new UI and no new data.

For live compact mode it refocuses the compact editor with a one-shot focus
suppressor, so the app's expand-on-focus does not fire, and moves the caret to
the end so dictation appends. The green ring is the theme's existing
`:focus-within` rule, not a new one.

It remembers a real scroll gesture (wheel, touch, keyboard, or scrollbar) so a
thread that opens already scrolled does not collapse before you have moved it.
Scroll collapsing is immediate; the 150ms applies only to the open/close
animation and is disabled when the system asks for reduced motion. The 300ms
typing guard now applies only to the run / question triggers.

## Requirements

bb 0.48 or newer. No account, API key, or external service.
