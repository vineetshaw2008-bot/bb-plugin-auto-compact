/**
 * Auto Compact — trusted content script.
 *
 * Collapses the native follow-up composer while the person is reading a long
 * thread. Scrolling the *thread* is the only trigger that puts the compact bar
 * into "live" mode: the compact editor keeps focus, so dictation continues and
 * the theme's green focus ring stays visible. Clicking outside the composer
 * ends the session; moving the mouse onto the compact bar opens the full
 * composer again with the caret ready to type.
 *
 * Run / question triggers keep the older behaviour: collapse, but never live.
 * The home / new-thread composer is never touched.
 *
 * Scope guards:
 * - only composers inside `[data-follow-up-composer]` are eligible,
 * - the new-thread / home composer is never touched,
 * - secondary panels and side chats are skipped,
 * - a wheel / touch gesture that starts inside the composer is ordinary
 *   composer scrolling and never counts as thread scroll intent.
 */

const SCROLL_THRESHOLD_PX = 50;
const TYPING_WINDOW_MS = 300;
const POINTER_WINDOW_MS = 800;
/** How long a real scroll gesture counts as "the person is scrolling". */
const SCROLL_INTENT_WINDOW_MS = 1200;
/** Fallback if the compact attribute change is missed by the observer. */
const LIVE_FOCUS_FALLBACK_MS = 200;
/**
 * Hover opens with no wait by default. Raise this if the box feels too eager.
 */
const HOVER_DWELL_MS = 0;
/** Ignore hover for a moment after any collapse (send / scroll / run / question). */
const HOVER_COOLDOWN_MS = 400;
/** A real mouse movement, not a layout shift under a still pointer. */
const HOVER_MOVE_PX = 4;
/**
 * Do not shrink for a run / question until the composer has been mounted for a
 * moment. Collapsing before the app has settled leaves its own collapsed flag
 * out of sync, and then neither a click-free hover nor a programmatic focus can
 * reopen the bar for the rest of the session.
 */
const INITIAL_SETTLE_MS = 1200;

const COLLAPSE_LABEL = "Collapse prompt box";
const STOP_LABEL = "Stop run";

const SCROLL_KEYS = new Set([
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "ArrowUp",
  "ArrowDown",
]);

const SECONDARY_PANEL = "[data-secondary-panel-tab-content]";
const FOLLOW_UP = "[data-follow-up-composer]";
const PROMPTBOX = "[data-promptbox]";
const EDITOR = ".ProseMirror";
const INTERACTIVE = 'button, [role="button"], [aria-haspopup]';

type Cleanup = () => void;

function isElement(value: unknown): value is Element {
  return value instanceof Element;
}

function isCompact(form: Element): boolean {
  return form.hasAttribute("data-promptbox-compact");
}

/** The follow-up form owned by this exact scroll viewport, if any. */
function findForm(viewport: HTMLElement): HTMLElement | null {
  const followUps = viewport.querySelectorAll<HTMLElement>(FOLLOW_UP);
  for (const followUp of followUps) {
    if (followUp.closest("[data-page-scroll-viewport]") !== viewport) continue;
    if (followUp.closest('[data-testid^="root-compose"]')) continue;
    const form = followUp.querySelector<HTMLElement>(PROMPTBOX);
    if (!form) continue;
    if (form.closest(SECONDARY_PANEL)) continue;
    return form;
  }
  return null;
}

class PaneController {
  private form: HTMLElement | null = null;
  private formCleanups: Cleanup[] = [];
  private cleanups: Cleanup[] = [];
  private readonly observer: MutationObserver;

  /** Timestamp of the last real scroll gesture (wheel, touch, key, scrollbar). */
  private lastScrollIntentAt = 0;
  private lastTypingAt = 0;
  private lastComposerPointerAt = 0;
  /**
   * The person has actually clicked, typed, pasted, or dictated in the
   * composer. The app's automatic focus on thread open does not count.
   */
  private userEngaged = false;
  /**
   * The person deliberately engaged the composer. This holds the composer open
   * against the run / question triggers until they scroll or send.
   */
  private userPinnedOpen = false;
  /** A scroll collapse should put focus back into the compact editor. */
  private pendingLiveFocus = false;
  /** Last seen compact state, used to reset a stale scroll intent on expand. */
  private wasCompact = false;
  private liveFocusTimer = 0;
  private sendTimer = 0;
  private hoverTimer = 0;
  private frame = 0;
  private recheckTimer = 0;
  private destroyed = false;

  /** Hover-to-expand state: the mouse is over the form and has really moved. */
  private hoverPointerInside = false;
  private hoverDistance = 0;
  private hoverLastX = 0;
  private hoverLastY = 0;
  /**
   * A collapse happened while the pointer sat on the box. Hover may not reopen
   * it until the pointer leaves and comes back, so Send and scroll collapses
   * do not bounce straight open again.
   */
  private hoverBlocked = false;
  private lastCollapseAt = 0;
  /** When the current form element was bound; used for the initial settle. */
  private formReadyAt = 0;

  constructor(
    readonly viewport: HTMLElement,
    private readonly manager: AutoCompactManager,
  ) {
    this.observer = new MutationObserver(() => {
      this.ensureForm();
      this.trackCompactTransition();
      this.maybeFocusLive();
      this.manager.scheduleAll();
    });
    this.observer.observe(viewport, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "data-promptbox-compact",
        "data-promptbox-collapsed",
        "data-follow-up-composer-expanded",
        "aria-label",
      ],
    });

    this.listen(
      viewport,
      "wheel",
      (event) => {
        // Scrolling inside the composer is normal composer scrolling. It must
        // never collapse the composer or count as thread scroll intent.
        if (this.isInsideComposer(event.target)) return;
        this.markScrollIntent();
      },
      { passive: true },
    );
    this.listen(
      viewport,
      "touchstart",
      (event) => {
        if (this.isInsideComposer(event.target)) return;
        this.markScrollIntent();
      },
      { passive: true },
    );
    this.listen(
      viewport,
      "touchmove",
      (event) => {
        if (this.isInsideComposer(event.target)) return;
        this.markScrollIntent();
      },
      { passive: true },
    );
    this.listen(viewport, "pointerdown", (event) => {
      const target = event.target;
      // Clicks inside the composer are engagement, not scroll intent.
      if (isElement(target) && target.closest(PROMPTBOX)) return;
      // A scrollbar drag targets the scroll container itself.
      if (target === viewport) this.markScrollIntent();
    });
    this.listen(viewport, "scroll", () => this.schedule(), { passive: true });

    this.ensureForm();
  }

  private isInsideComposer(target: EventTarget | null): boolean {
    return isElement(target) && target.closest(PROMPTBOX) !== null;
  }

  private listen(
    target: EventTarget,
    type: string,
    handler: (event: Event) => void,
    options?: AddEventListenerOptions,
  ) {
    target.addEventListener(type, handler, options);
    this.cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  /** Re-query the form and rebind form-scoped listeners when React replaces it. */
  ensureForm(): HTMLElement | null {
    const next = findForm(this.viewport);
    if (next === this.form) return next;

    this.detachForm();
    this.form = next;
    this.wasCompact = next ? isCompact(next) : false;
    this.formReadyAt = next ? Date.now() : 0;
    if (!next) return null;

    const form = next;
    const editor = () => form.querySelector<HTMLElement>(EDITOR);

    const touchTyping = () => {
      this.lastTypingAt = Date.now();
      // Typing (or dictating into) the composer is a request to keep it open.
      this.userEngaged = true;
      this.userPinnedOpen = true;
    };
    const touchPointer = () => {
      this.lastComposerPointerAt = Date.now();
      // A deliberate click cancels a pending scroll collapse.
      this.lastScrollIntentAt = 0;
      this.userEngaged = true;
      this.userPinnedOpen = true;
    };
    const bind = (
      type: string,
      handler: (event: Event) => void,
      options?: AddEventListenerOptions,
    ) => {
      form.addEventListener(type, handler, options);
      this.formCleanups.push(() =>
        form.removeEventListener(type, handler, options),
      );
    };

    bind("keydown", touchTyping);
    bind("input", touchTyping);
    bind("compositionstart", touchTyping);
    bind("compositionupdate", touchTyping);
    bind("pointerdown", touchPointer);
    bind("submit", (event) => this.handleSubmit(event as SubmitEvent));
    bind("keydown", (event) => this.handleKeyDown(event as KeyboardEvent, form), {
      capture: true,
    });

    /*
     * A click on the live compact bar must open the full composer. Because the
     * editor is already focused, the app never sees a new focus event, so its
     * native expand-on-focus does not run. Blur first and refocus on the next
     * tick: that produces the focus event the app needs.
     *
     * Buttons (mic, send, menus) are left alone: the app handles those and
     * must not expand the composer for them.
     */
    bind(
      "pointerdown",
      (event) => {
        if (!isCompact(form)) return;
        const target = event.target;
        if (isElement(target) && target.closest(INTERACTIVE)) return;

        // Opening the box is an explicit request; a stale scroll intent must
        // not immediately collapse it again.
        this.lastScrollIntentAt = 0;
        this.userPinnedOpen = true;

        const ed = editor();
        if (!ed || document.activeElement !== ed) return;
        ed.blur();
        window.setTimeout(() => {
          if (this.destroyed || !form.isConnected || !isCompact(form)) return;
          ed.focus({ preventScroll: true });
        }, 0);
      },
      { capture: true },
    );

    /*
     * Hover opens the compact box: the person asked not to click every time.
     * Only a real mouse movement counts, so a layout shift under a still
     * pointer (or the shift from a scroll collapse) never reopens it. Leaving
     * does nothing; scrolling still collapses it.
     */
    bind("pointerenter", (event) => {
      const pointer = event as PointerEvent;
      if (pointer.pointerType !== "mouse") return;
      this.hoverPointerInside = true;
      this.hoverDistance = 0;
      this.hoverLastX = pointer.clientX;
      this.hoverLastY = pointer.clientY;
      // A genuine return after a collapse releases the re-entry guard.
      if (
        this.hoverBlocked &&
        Date.now() - this.lastCollapseAt >= HOVER_COOLDOWN_MS
      ) {
        this.hoverBlocked = false;
      }
    });

    bind("pointermove", (event) => {
      const pointer = event as PointerEvent;
      // Touch, pen, and a drag (selecting text) are not hover.
      if (pointer.pointerType !== "mouse" || pointer.buttons !== 0) return;
      if (!isCompact(form)) return;

      const dx = pointer.clientX - this.hoverLastX;
      const dy = pointer.clientY - this.hoverLastY;
      this.hoverLastX = pointer.clientX;
      this.hoverLastY = pointer.clientY;

      if (this.hoverBlocked) return;
      if (Date.now() - this.lastCollapseAt < HOVER_COOLDOWN_MS) return;

      this.hoverDistance += Math.hypot(dx, dy);
      if (this.hoverDistance < HOVER_MOVE_PX) return;
      this.hoverDistance = 0;

      if (HOVER_DWELL_MS <= 0) {
        this.expandFromHover(form);
        return;
      }
      this.clearHoverTimer();
      this.hoverTimer = window.setTimeout(() => {
        this.hoverTimer = 0;
        this.expandFromHover(form);
      }, HOVER_DWELL_MS);
    });

    const endHover = () => {
      this.clearHoverTimer();
      this.hoverPointerInside = false;
      this.hoverDistance = 0;
      // `hoverBlocked` is deliberately not cleared here: a collapse can shrink
      // the bar out from under the pointer and fire a synthetic leave. The next
      // real enter clears it once the cooldown has passed.
    };
    bind("pointerleave", endHover);
    bind("pointercancel", endHover);

    return next;
  }

  private detachForm() {
    for (const cleanup of this.formCleanups.splice(0)) cleanup();
    this.clearHoverTimer();
    this.hoverPointerInside = false;
    this.hoverDistance = 0;
    this.form = null;
  }

  private clearHoverTimer() {
    if (!this.hoverTimer) return;
    window.clearTimeout(this.hoverTimer);
    this.hoverTimer = 0;
  }

  /**
   * Open the compact composer because the mouse moved onto it, and put the
   * keyboard in it: hovering is also the start of typing.
   *
   * The app opens its composer from the `onFocusCapture` handler on the
   * `[data-follow-up-composer]` wrapper. A synthetic `focusin` asks for that
   * without touching the keyboard; focusing the editor is the fallback and the
   * final step, so the caret is ready whether the app accepted the event or
   * not. An active dictation session keeps its focus, ring, and caret.
   */
  private expandFromHover(form: HTMLElement) {
    if (this.destroyed || !form.isConnected) return;
    if (!isCompact(form) || !this.hoverPointerInside) return;
    if (this.hoverBlocked) return;
    if (Date.now() - this.lastCollapseAt < HOVER_COOLDOWN_MS) return;

    if (!this.editor(form)) return;

    // Opening is a deliberate request: do not let a stale scroll re-close it,
    // and hold it against run / question until the person scrolls or sends.
    this.lastScrollIntentAt = 0;
    this.userPinnedOpen = true;

    const wrapper = form.closest(FOLLOW_UP) ?? form;
    wrapper.dispatchEvent(
      new FocusEvent("focusin", { bubbles: true, composed: true }),
    );

    // Let the app apply the focus event, then make sure the editor really has
    // the keyboard. A live compact bar has focus already, so the app would see
    // no new focus event: blur and refocus on the next tick instead.
    window.setTimeout(() => {
      if (this.destroyed || !form.isConnected) return;
      const current = this.editor(form);
      if (!current) return;

      if (document.activeElement === current) {
        current.blur();
        window.setTimeout(() => {
          if (this.destroyed || !form.isConnected) return;
          const retry = this.editor(form);
          if (!retry) return;
          retry.focus({ preventScroll: true });
          this.caretToEnd(retry);
        }, 0);
        return;
      }

      current.focus({ preventScroll: true });
      this.caretToEnd(current);
    }, 30);
  }

  /** Put the caret at the end so typing appends to the draft. */
  private caretToEnd(editor: HTMLElement) {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  markScrollIntent() {
    this.lastScrollIntentAt = Date.now();
    this.schedule();
  }

  private trackCompactTransition() {
    const form = this.form;
    if (!form) {
      this.wasCompact = false;
      return;
    }
    const compact = isCompact(form);
    if (this.wasCompact && !compact) {
      // The composer opened: cancel the scroll that caused the old compact
      // state so it is not closed again on the next evaluation.
      this.lastScrollIntentAt = 0;
    }
    this.wasCompact = compact;
  }

  /** True when the target belongs to this pane's composer box. */
  owns(target: EventTarget | null): boolean {
    const form = this.form;
    return !!form && isElement(target) && form.contains(target);
  }

  /**
   * A click outside the composer ends the typing session, in both the expanded
   * and the compact live form: blur the editor, drop the green ring, and keep
   * the composer small.
   */
  handleOutsideClick() {
    const form = this.form;
    if (form) {
      const ed = this.editor(form);
      if (ed && document.activeElement === ed) ed.blur();
    }
    this.userEngaged = false;
    this.userPinnedOpen = false;
    this.pendingLiveFocus = false;
    this.lastTypingAt = 0;
    this.lastComposerPointerAt = 0;
    this.clearHoverTimer();
    this.hoverPointerInside = false;
    this.hoverDistance = 0;
    if (this.liveFocusTimer) {
      window.clearTimeout(this.liveFocusTimer);
      this.liveFocusTimer = 0;
    }
  }

  schedule() {
    if (this.destroyed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.evaluate();
    });
  }

  private distanceFromBottom(): number {
    return (
      this.viewport.scrollHeight -
      this.viewport.scrollTop -
      this.viewport.clientHeight
    );
  }

  private isRunning(form: Element): boolean {
    return Boolean(
      form.querySelector(
        `[data-promptbox-submit-action][aria-label="${STOP_LABEL}"]`,
      ),
    );
  }

  private hasQuestion(): boolean {
    for (const form of document.querySelectorAll("[data-question-form]")) {
      if (!form.closest(SECONDARY_PANEL)) return true;
    }
    return false;
  }

  private engagedFor(): number {
    const now = Date.now();
    return Math.max(
      TYPING_WINDOW_MS - (now - this.lastTypingAt),
      POINTER_WINDOW_MS - (now - this.lastComposerPointerAt),
    );
  }

  private editor(form: Element): HTMLElement | null {
    return form.querySelector<HTMLElement>(EDITOR);
  }

  private isEditorFocused(form: Element): boolean {
    const ed = this.editor(form);
    return !!ed && document.activeElement === ed;
  }

  private evaluate() {
    if (this.destroyed) return;
    const form = this.ensureForm();
    if (!form) return;

    if (isCompact(form)) return;

    const distance = this.distanceFromBottom();
    const scrollWants =
      Date.now() - this.lastScrollIntentAt < SCROLL_INTENT_WINDOW_MS &&
      distance > SCROLL_THRESHOLD_PX;
    const stateWants = this.isRunning(form) || this.hasQuestion();

    // The pin holds against run / question changes. A deliberate scroll is the
    // person asking for the compact live bar, so it wins over the pin.
    if (this.userPinnedOpen && !scrollWants) return;
    if (!scrollWants && !stateWants) return;

    if (scrollWants) {
      // Scrolling collapses immediately. If the person was really engaged and
      // the editor is focused, keep the typing session alive in the compact
      // bar instead of dropping focus.
      const live = this.userEngaged && this.isEditorFocused(form);
      this.userPinnedOpen = false;
      this.collapse(form, live);
      return;
    }

    // Run / question keep the old "do not shrink mid-word" guard.
    const engagedFor = this.engagedFor();
    if (engagedFor > 0) {
      this.scheduleRecheck(engagedFor + 30);
      return;
    }

    // Let the app finish mounting the composer before the first run / question
    // collapse. Collapsing into a half-mounted composer leaves its collapse
    // flag out of sync, and the bar can then no longer open without a click.
    const settleFor = INITIAL_SETTLE_MS - (Date.now() - this.formReadyAt);
    if (settleFor > 0) {
      this.scheduleRecheck(settleFor + 30);
      return;
    }

    this.collapse(form, false);
  }

  private scheduleRecheck(delay: number) {
    if (this.recheckTimer) window.clearTimeout(this.recheckTimer);
    this.recheckTimer = window.setTimeout(() => {
      this.recheckTimer = 0;
      this.manager.scheduleAll();
    }, Math.max(50, delay));
  }

  private collapseButton(form: Element): HTMLButtonElement | null {
    return (
      form.querySelector<HTMLButtonElement>(`[aria-label="${COLLAPSE_LABEL}"]`) ??
      form.querySelector<HTMLButtonElement>(
        "[data-promptbox-standard-actions] button",
      ) ??
      this.viewport.querySelector<HTMLButtonElement>(
        `[aria-label="${COLLAPSE_LABEL}"]`,
      )
    );
  }

  private collapse(form: Element, live: boolean) {
    const button = this.collapseButton(form);
    if (!button) return;

    // Remember the collapse: a pointer parked on the bar must not reopen it on
    // the next pixel of movement. It has to leave and come back.
    this.lastCollapseAt = Date.now();
    if (this.hoverPointerInside) this.hoverBlocked = true;
    this.clearHoverTimer();

    if (live) {
      // Keep focus in the compact editor after the app collapses the form.
      this.pendingLiveFocus = true;
      this.scheduleLiveFocus();
    } else {
      const ed = this.editor(form);
      if (ed && document.activeElement === ed) ed.blur();
    }

    button.click();
  }

  private scheduleLiveFocus() {
    if (this.liveFocusTimer) window.clearTimeout(this.liveFocusTimer);
    this.liveFocusTimer = window.setTimeout(() => {
      this.liveFocusTimer = 0;
      if (!this.pendingLiveFocus) return;
      const form = this.form;
      if (!form || !isCompact(form)) {
        this.pendingLiveFocus = false;
        return;
      }
      this.maybeFocusLive();
    }, LIVE_FOCUS_FALLBACK_MS);
  }

  private maybeFocusLive() {
    if (!this.pendingLiveFocus) return;
    const form = this.form;
    if (!form || !isCompact(form)) return;
    const ed = this.editor(form);
    if (!ed) return;

    this.pendingLiveFocus = false;
    if (this.liveFocusTimer) {
      window.clearTimeout(this.liveFocusTimer);
      this.liveFocusTimer = 0;
    }
    this.manager.focusCompactEditor(ed);
  }

  /**
   * The app sends on plain Enter from the editor, and that path never fires a
   * native `submit` event. Watch for a draft that becomes empty right after the
   * key so the send is detected without guessing at the app's internals.
   */
  private handleKeyDown(event: KeyboardEvent, form: HTMLElement) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    const ed = this.editor(form);
    if (!ed || document.activeElement !== ed) return;
    const text = (ed.textContent ?? "").trim();
    if (text.length === 0) return;

    /*
     * While a `/` or `@` mention is being completed, Enter must select the
     * highlighted suggestion, not submit the prompt. Treating it as a send
     * collapses the composer and discards the in-progress selection. Suppress
     * the browser's default form submission and skip the send bookkeeping so
     * the app's own suggestion handler owns the key.
     */
    if (new RegExp("[/@][^\\s/@]*$").test(text)) {
      // Do not treat this Enter as a send; let the app's suggestion handler
      // select the highlighted item. The submit event (if it fires) is handled
      // in handleSubmit, which cancels the unwanted prompt submission.
      return;
    }

    this.watchForSend();
  }

  /**
   * Sending ends the dictation session. From the compact live bar this is
   * immediate; from the expanded composer the old post-submit collapse is kept.
   *
   * The draft is cleared by the app during its own submit handler, so poll
   * briefly instead of assuming the DOM is already updated.
   */
  private watchForSend() {
    if (this.sendTimer) window.clearTimeout(this.sendTimer);

    const check = (attempt: number) => {
      this.sendTimer = 0;
      if (this.destroyed) return;
      // The app can replace the form while sending, so always act on the
      // current one instead of the element captured at key time.
      const current = this.ensureForm();
      if (!current) return;
      const ed = this.editor(current);
      if (!ed) return;

      if ((ed.textContent ?? "").trim().length > 0) {
        // Blocked send (still uploading, disabled, or just a newline): retry
        // once, then give up so a draft is never collapsed by mistake.
        if (attempt === 0) {
          this.sendTimer = window.setTimeout(() => check(1), 250);
        }
        return;
      }
      this.finishSend(current);
    };

    this.sendTimer = window.setTimeout(() => check(0), 60);
  }

  private finishSend(form: HTMLElement) {
    this.userEngaged = false;
    this.userPinnedOpen = false;
    this.pendingLiveFocus = false;
    this.lastTypingAt = 0;
    this.lastComposerPointerAt = 0;
    this.clearHoverTimer();
    if (this.liveFocusTimer) {
      window.clearTimeout(this.liveFocusTimer);
      this.liveFocusTimer = 0;
    }

    if (isCompact(form)) {
      // Sending leaves the pointer on the send button inside the small bar; it
      // must not reopen until the person has left the bar and returned.
      this.lastCollapseAt = Date.now();
      if (this.hoverPointerInside) this.hoverBlocked = true;
      const ed = this.editor(form);
      if (ed && document.activeElement === ed) ed.blur();
      return;
    }

    this.collapse(form, false);
  }

  private handleSubmit(event?: Event) {
    const form = this.ensureForm();
    if (!form) return;
    const ed = this.editor(form);
    const text = (ed?.textContent ?? "").trim();
    if (new RegExp("[/@][^\\s/@]*$").test(text)) {
      // A mention is still being composed: cancel the submission so the
      // prompt is not sent and the composer is not collapsed.
      event?.preventDefault();
      return;
    }
    this.watchForSend();
  }

  destroy() {
    this.destroyed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.recheckTimer) window.clearTimeout(this.recheckTimer);
    if (this.liveFocusTimer) window.clearTimeout(this.liveFocusTimer);
    if (this.sendTimer) window.clearTimeout(this.sendTimer);
    this.clearHoverTimer();
    this.observer.disconnect();
    this.detachForm();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }
}

class AutoCompactManager {
  private readonly controllers = new Map<HTMLElement, PaneController>();
  private readonly observer: MutationObserver;
  private readonly onKeyDown: (event: KeyboardEvent) => void;
  private readonly onFocusCapture: (event: Event) => void;
  private readonly onOutsideClick: (event: Event) => void;
  private readonly onDocumentPointerDown: (event: Event) => void;
  /** True when the current gesture started inside a composer. */
  private pointerDownInsideComposer = false;
  /** One-shot: suppress the app's expand-on-focus while we refocus compact. */
  private suppressFocus = false;
  private suppressedEditor: HTMLElement | null = null;
  private frame = 0;

  constructor() {
    this.observer = new MutationObserver(() => this.syncSoon());
    this.observer.observe(document.body, { childList: true, subtree: true });

    this.onKeyDown = (event) => {
      if (!SCROLL_KEYS.has(event.key)) return;
      const target = event.target;
      // Keys typed into the composer are engagement, not scroll intent.
      if (isElement(target) && target.closest(PROMPTBOX)) return;

      const active = document.activeElement;
      let routed = false;
      for (const controller of this.controllers.values()) {
        if (isElement(target) && controller.viewport.contains(target)) {
          controller.markScrollIntent();
          routed = true;
        } else if (isElement(active) && controller.viewport.contains(active)) {
          controller.markScrollIntent();
          routed = true;
        }
      }
      if (!routed) {
        for (const controller of this.controllers.values()) {
          controller.markScrollIntent();
        }
      }
    };
    document.addEventListener("keydown", this.onKeyDown);

    /*
     * The app opens the full composer from its `onFocusCapture`. When we put
     * focus back into the compact editor we must not trigger that, or the bar
     * jumps open again. Stopping the focus event at the document capture phase
     * runs before React's root listener. The suppression is one-shot and only
     * for the exact editor we are focusing.
     */
    this.onFocusCapture = (event) => {
      if (!this.suppressFocus || !this.suppressedEditor) return;
      const target = event.target;
      if (
        target === this.suppressedEditor ||
        (isElement(target) && this.suppressedEditor.contains(target))
      ) {
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener("focus", this.onFocusCapture, true);
    document.addEventListener("focusin", this.onFocusCapture, true);

    /*
     * Remember where the gesture started. The app expands the compact bar on
     * pointerdown, which can detach the node that later receives the click; a
     * detached target must not be mistaken for a click outside.
     */
    this.onDocumentPointerDown = (event) => {
      const target = event.target;
      this.pointerDownInsideComposer = false;
      for (const controller of this.controllers.values()) {
        if (controller.owns(target)) {
          this.pointerDownInsideComposer = true;
          return;
        }
      }
    };
    document.addEventListener("pointerdown", this.onDocumentPointerDown, true);

    /*
     * A real click anywhere outside the composer ends the typing session, in
     * both the expanded and the compact live form. This is what fades the green
     * ring and stops the voice typer from landing in the box.
     *
     * Use `click`, not `pointerdown`: a scrollbar drag or a touch scroll must
     * keep dictation alive. A gesture that scrolls does not produce a click.
     */
    this.onOutsideClick = (event) => {
      const target = event.target;
      const startedInside = this.pointerDownInsideComposer;
      this.pointerDownInsideComposer = false;
      if (startedInside) return;
      if (isElement(target) && !target.isConnected) return;
      for (const controller of this.controllers.values()) {
        if (controller.owns(target)) return;
      }
      for (const controller of this.controllers.values()) {
        controller.handleOutsideClick();
      }
    };
    document.addEventListener("click", this.onOutsideClick, true);

    this.sync();
  }

  /**
   * Focus the compact editor without letting the app expand the composer, then
   * put the caret at the end so dictation appends instead of prepending.
   */
  focusCompactEditor(editor: HTMLElement) {
    this.suppressedEditor = editor;
    this.suppressFocus = true;
    try {
      editor.focus({ preventScroll: true });
    } finally {
      this.suppressFocus = false;
      this.suppressedEditor = null;
    }

    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  syncSoon() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.sync();
    });
  }

  sync() {
    const viewports = Array.from(
      document.querySelectorAll<HTMLElement>("[data-page-scroll-viewport]"),
    ).filter((viewport) => {
      if (viewport.closest(SECONDARY_PANEL)) return false;
      return findForm(viewport) !== null;
    });
    const present = new Set(viewports);

    for (const [viewport, controller] of this.controllers) {
      if (!present.has(viewport) || !viewport.isConnected) {
        controller.destroy();
        this.controllers.delete(viewport);
      }
    }
    for (const viewport of viewports) {
      if (!this.controllers.has(viewport)) {
        this.controllers.set(viewport, new PaneController(viewport, this));
      }
    }
    this.scheduleAll();
  }

  scheduleAll() {
    for (const controller of this.controllers.values()) controller.schedule();
  }

  dispose() {
    document.removeEventListener("focus", this.onFocusCapture, true);
    document.removeEventListener("focusin", this.onFocusCapture, true);
    document.removeEventListener("click", this.onOutsideClick, true);
    document.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
    document.removeEventListener("keydown", this.onKeyDown);
    this.observer.disconnect();
    if (this.frame) cancelAnimationFrame(this.frame);
    for (const controller of this.controllers.values()) controller.destroy();
    this.controllers.clear();
  }
}

/**
 * Mounts the auto-compact behaviour and returns the disposer the host expects.
 * Every listener, observer, timer, and animation frame is released on dispose.
 */
export function startAutoCompact(signal: AbortSignal): () => void {
  if (!document.body) return () => {};
  const manager = new AutoCompactManager();

  const onAbort = () => manager.dispose();
  signal.addEventListener("abort", onAbort, { once: true });

  return () => {
    signal.removeEventListener("abort", onAbort);
    manager.dispose();
  };
}
