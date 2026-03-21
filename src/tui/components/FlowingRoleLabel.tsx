import { memo, useSyncExternalStore } from "react";
import { TUI_ANIMATIONS_ENABLED } from "../animation";
import { useAnimation } from "../contexts/AnimationContext";
import { Text } from "./Text";

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

function withStableCharIds(text: string): Array<{ id: string; char: string }> {
  const seen = new Map<string, number>();
  return Array.from(text).map((char) => {
    const count = (seen.get(char) ?? 0) + 1;
    seen.set(char, count);
    return {
      id: `${char}#${count}`,
      char,
    };
  });
}

export const FlowingRoleLabel = memo(
  ({
    text,
    palette,
    staticColor,
    animate,
  }: {
    text: string;
    palette: readonly string[];
    staticColor: string;
    animate: boolean;
  }) => {
    const { shouldAnimate: shouldAnimateContext } = useAnimation();
    const shouldAnimate =
      animate && shouldAnimateContext && TUI_ANIMATIONS_ENABLED;
    const frameTick = useSyncExternalStore(
      shouldAnimate ? subscribe : subscribeIdle,
      shouldAnimate ? getSnapshot : getStaticSnapshot,
    );
    const chars = withStableCharIds(text);

    if (!shouldAnimate || palette.length === 0) {
      return <Text color={staticColor}>{text}</Text>;
    }

    return (
      <Text>
        {chars.map((item, position) => (
          <Text
            key={item.id}
            color={palette[(frameTick + position) % palette.length]}
          >
            {item.char}
          </Text>
        ))}
      </Text>
    );
  },
);

FlowingRoleLabel.displayName = "FlowingRoleLabel";
