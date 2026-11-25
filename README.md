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

## Install from GitHub

The plugin is published at
`https://github.com/vineetshaw2008-bot/bb-plugin-auto-compact` (private repo —
use an account with access).

```bash
# Pinned to the tagged release (recommended)
bb plugin install git:github.com/vineetshaw2008-bot/bb-plugin-auto-compact@v0.1.1 --yes

# Or track the main branch
bb plugin install git:github.com/vineetshaw2008-bot/bb-plugin-auto-compact@main --yes

bb plugin enable auto-compact
bb plugin list                 # shows auto-compact@0.1.1 running
```

The separate Cloudroom theme repo (install it if you want the matching look):

```bash
git clone https://github.com/vineetshaw2008-bot/bb-themes-custom.git ~/.bb/theme/cloudroom
bb theme set cloudroom
```

Installing the plugin does **not** auto-switch the theme. Activate the theme
once with the command above.

## Installed plugin stack and workflow snapshot (2026-11-25)

Recorded from the live instance: bb `0.49.0`, app `http://127.0.0.1:38886`,
host `host_4detrgykgv`. This section exists so the setup can be rebuilt after a
WSL/environment reset. The two GitHub repos hold **code and notes only** —
threads, projects, settings, and credentials live in the bb server data dir and
must be backed up separately (`bb server export`).

**Snapshot:** 47 plugins installed — 39 `running`, 7 `disabled`, 1 enabled but
`needs-configuration`. All 5 projects and all 37 visible threads were checked.

### Project / thread coverage

| Project (id) | Threads | Provider split |
|--------------|---------|----------------|
| `themes` (`proj_cp6ve23hip`) | 12 | mostly `acp-opencode`, one active thread (`thr_e2rvwamyzj`) |
| `datausagetoday.com` (`proj_yfw2f8zm95`) | 4 | `pi` / `acp-opencode` |
| `Research` (`proj_87rzmcvqw4`) | 1 | `acp-kilo` |
| `cloudroom-bb-custom` (`proj_et4pr6tvn8`) | 0 | — |
| `pdftomdconvert.com` (`proj_6tg8cny3yy`) | 20 | `acp-opencode`, `acp-antigravity`, `pi` |

Providers actually used by threads: `acp-opencode` 25, `acp-kilo` 5, `pi` 4,
`acp-antigravity` 3. Environments: `project-checkout` 36, `git-worktree` 1
(the Astro fix thread `thr_f9xuxkzd85`).

### Plugin inventory (all 47)

Core runtime (built-in and running unless noted):

| Plugin | Role in the workflow |
|--------|----------------------|
| `bb--composer` | The prompt box itself: rich text, `@` mentions, slash commands, send button. Every thread depends on it. |
| `provider-acp` | Supplies `acp-opencode`, `acp-kilo`, `acp-antigravity` — used by 33 of 37 threads. |
| `provider-pi` | Supplies the 4 `pi` threads. |
| `provider-codex`, `provider-claude-code` | Installed and available; no threads in this snapshot used them. |
| `provider-retry` | Retries transient provider overload / limit errors. |
| `environment-project-checkout` | Runs threads in the project's own checkout (36 threads). |
| `environment-git-worktree` | Runs a thread in a fresh worktree (1 thread). |
| `environment-personal-workspace` | Workspace for threads without a project. |
| `navigation`, `thread-list`, `side-chat`, `drafts` | Sidebar navigation, thread list, side chats, saved drafts. |
| `file-tree`, `monaco-editor`, `pdf-preview` | Pinned file tree, file editing, PDF preview. |
| `custom-instructions` | Persistent instructions injected into agent tasks on this host. |
| `concurrency-limit`, `keep-awake`, `push-notifications` | Caps running threads, keeps hosts awake, notifies on attention. |
| `bb-account`, `connect` | getbb.app account/sign-in and remote access link. |
| `bb--provider-usage`, `bb--github-star` | Usage card in settings and the one-time star prompt. |

Working / tooling plugins:

| Plugin | Role in the workflow |
|--------|----------------------|
| `auto-compact` | **This plugin.** Per-pane content script; keeps the follow-up composer compact, hover-to-type, live dictation, `/`/`@` selection fix. Source was `path:/root/themes/bb-plugin-auto-compact`, now published at this repo. |
| `browser-automation` | Used from the CLI for app/theme verification and browser sessions; its skill was invoked in `thr_bxjzh6m8be` and `thr_whxaphrb6h`. |
| `genui` | Inline interactive UI; `check_ui` called twice in `thr_e2rvwamyzj`, `ui_examples` once in `thr_pewqx4y2ys`. |
| `ask-user-question` | Multiple-choice questions; `AskUserQuestion` used in `thr_9b32finecs` and `thr_mxfdd4cuyp`. |
| `theme-preview` | Previewing and validating the Cloudroom theme. |
| `bb--git`, `bb--github-pr-status` | Git status/diff above the composer and PR state for environment branches. |
| `bb--prompt-library`, `bb-guide` | Reusable prompts and bundled agent skills (`bb-plugin-authoring` used in `thr_ms5h6junsx`, `bb-cli`, `skill-creator`). |
| `automations`, `workflows`, `scheduled-send` | Scheduled agent work, durable workflows, send-later drafts. `automations` sweep service is running. |
| `inline-vis`, `agent-annotations` | HTML visualisations in replies; browser annotations as `@` mentions. |
| `secrets` | Secure credential requests into dotenv files. |
| `antigravity` | Catalog plugin, `v0.2.1`; currently `needs-configuration`, but 3 older threads were created with it. |

Disabled in this instance (deliberate, keep them disabled on restore):
`account-pool`, `bb--connect-next`, `bb--mcp`, `bb--storage-retention`,
`bb-ai`, `plugin-api-docs`, `plugin-api-tester`.

### What the logs actually show

- All 37 threads were inspected via `bb thread log --json`. The dominant recorded
  tool calls were `read`/`grep`/`glob`/`exec` (file work), plus the plugin tools
  listed above (`check_ui`, `ui_examples`, `AskUserQuestion`, `skill`).
- A slash-command skill mention (`grill-me`) appears in `thr_qts6firxd2`; that is
  a user skill, not a plugin.
- Plugin ids also appear in many logs inside `bb plugin list` output and agent
  reasoning; those mentions are **not** proof of active use and were not counted
  as usage.
- `auto-compact` ran as a content script in the thread composer, so it does not
  appear as a tool call. Its effect is the compact/focus behaviour in threads.

### Restore this setup in a new environment

```bash
# 1. Same bb line (packaged): plugin engine range is >=0.48; snapshot was 0.49.0
npx bb-app@latest --version

# 2. Built-ins ship with bb. Mirror the explicit choices:
bb plugin disable account-pool bb--connect-next bb--mcp bb--storage-retention bb-ai plugin-api-docs plugin-api-tester
bb plugin enable browser-automation theme-preview

# 3. Catalog plugins used here (with the exact tracked ranges):
bb plugin install antigravity --yes                                  # then configure it
bb plugin install git:github.com/fzrx-ego/bb-plugin-file-tree.git@semver:^0.19.3 --yes
bb plugin install git:github.com/ComicBit/bb-plugin-genui.git@semver:'>=0.3.0 <1.0.0' --yes

# 4. This plugin and the theme:
bb plugin install git:github.com/vineetshaw2008-bot/bb-plugin-auto-compact@v0.1.1 --yes
git clone https://github.com/vineetshaw2008-bot/bb-themes-custom.git ~/.bb/theme/cloudroom
bb theme set cloudroom

# 5. Verify:
bb plugin list        # 47 plugins; auto-compact running
bb provider list      # acp-opencode, acp-kilo, acp-antigravity, pi available
bb theme list
```

`bb plugin disable` accepts one id per invocation; repeat the command for each
id if your bb build does not accept a list. Provider CLIs (`opencode`, `kilo`,
`pi`) and host credentials are **not** in these repos — reinstall/sign in to
them before reopening old threads.

**Caveats:** counts exclude archived/hidden threads and were taken on
2026-11-25 from `bb plugin list`, `bb thread list`, `bb thread show`, and all 37
thread logs. Plugin versions drift (`file-tree` resolved `v0.19.14`, `genui`
`v0.3.2`, `antigravity` `v0.2.1`); pin those tags if exact reproduction matters.
