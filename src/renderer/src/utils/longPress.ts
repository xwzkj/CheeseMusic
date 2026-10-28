import { onBeforeUnmount } from 'vue'

type LongPressOptions = {
  /** How long the pointer must stay down before repeating starts. */
  delay?: number
  /** Delay between repeated actions while held. */
  interval?: number
}

/**
 * Click plus hold-to-repeat for a button.
 *
 * A short click runs the action once from the click handler; holding the
 * pointer runs it after `delay` and then every `interval`. The click that the
 * browser emits after a long press is swallowed so it does not add an extra
 * step, and every click stops propagation so volume buttons can live inside a
 * popover trigger without toggling it.
 */
export function useLongPress(handler: () => void, options: LongPressOptions = {}) {
  const delay = Math.max(0, options.delay ?? 400)
  const interval = Math.max(20, options.interval ?? 90)
  let delayTimer: ReturnType<typeof setTimeout> | null = null
  let repeatTimer: ReturnType<typeof setInterval> | null = null
  let longPressed = false
  let suppressClickUntil = 0

  function clearTimers() {
    if (delayTimer !== null) {
      clearTimeout(delayTimer)
      delayTimer = null
    }
    if (repeatTimer !== null) {
      clearInterval(repeatTimer)
      repeatTimer = null
    }
  }

  function stopPress() {
    clearTimers()
    if (longPressed) {
      longPressed = false
      // The browser dispatches click after pointerup; ignore exactly that one.
      suppressClickUntil = performance.now() + 500
    }
  }

  function onPointerdown(event: PointerEvent) {
    if (event.button !== 0 || event.isPrimary === false) return
    longPressed = false
    suppressClickUntil = 0
    clearTimers()
    delayTimer = setTimeout(() => {
      delayTimer = null
      longPressed = true
      handler()
      repeatTimer = setInterval(handler, interval)
    }, delay)
  }

  function onClick(event?: MouseEvent) {
    event?.stopPropagation()
    if (performance.now() < suppressClickUntil) {
      suppressClickUntil = 0
      event?.preventDefault()
      return
    }
    handler()
  }

  function onContextmenu(event: Event) {
    // Long-pressing on touch devices must not open the browser menu.
    event.preventDefault()
    event.stopPropagation()
  }

  onBeforeUnmount(clearTimers)

  return {
    onPointerdown,
    onPointerup: stopPress,
    onPointerleave: stopPress,
    onPointercancel: stopPress,
    onClick,
    onContextmenu
  }
}
