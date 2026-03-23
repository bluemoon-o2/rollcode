import { useSyncExternalStore } from "react";
import { TUI_ANIMATIONS_ENABLED } from "../animation";
import { useAnimation } from "../contexts/AnimationContext";

let tick = 0;
const listeners = new Set<() => void>();
let tickerInterval: ReturnType<typeof setInterval> | null = null;

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  if (!tickerInterval) {
    tickerInterval = setInterval(() => {
      tick += 1;
      for (const listener of listeners) {
        listener();
      }
    }, 120);
  }
  return () => {
    listeners.delete(callback);
    if (listeners.size === 0 && tickerInterval) {
      clearInterval(tickerInterval);
      tickerInterval = null;
    }
  };
}

function getSnapshot(): number {
  return tick;
}

function subscribeIdle(): () => void {
  return () => {};
}

function getStaticSnapshot(): number {
  return 0;
}

export function useAnimationTick(animate: boolean): number {
  const { shouldAnimate } = useAnimation();
  const shouldTick = animate && shouldAnimate && TUI_ANIMATIONS_ENABLED;
  return useSyncExternalStore(
    shouldTick ? subscribe : subscribeIdle,
    shouldTick ? getSnapshot : getStaticSnapshot,
  );
}
