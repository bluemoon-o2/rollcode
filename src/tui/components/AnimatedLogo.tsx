import { useSyncExternalStore } from "react";
import { TUI_ANIMATIONS_ENABLED } from "../animation";
import { useAnimation } from "../contexts/AnimationContext";
import { colors } from "./colors";
import { Text } from "./Text";

const MAX_LOGO_HEIGHT = 5;
const SHADOW_CHARSET = /^[ \n▓█░▀]+$/;

const logoFrames = [
  `    ▓████▓    
   ▓█░░░░█▓   
   ▓█░▓▓░█▓   
   ▓██████▓   
    ░░░░░░    `,
  `    ▓████▓    
   ▓█░░░░█▓   
   ▓██████▓   
    ▓████▓    
  ░░░░░░░░░░  `,
  `     ▓██▓     
    ▓████▓    
    ▓█░░█▓    
    ▓████▓    
   ░░░░░░░░   `,
  `      ▓▓      
     ▓██▓     
     ▓██▓     
      ▓▓      
    ░░░░░░    `,
  `     ▓██▓     
    ▓████▓    
    ▓█░░█▓    
    ▓████▓    
   ░░░░░░░░   `,
  `   ▓██████▓   
   ▓█░░░░█▓   
   ▓██████▓   
    ▓████▓    
 ░░░░░░░░░░░░ `,
  `    ▓████▓    
   ▓█░░░░█▓   
   ▓█░▓▓░█▓   
   ▓██████▓   
   ░░░░░░░░   `,
  `    ▓████▓    
   ▓█░▓▓░█▓   
   ▓█░░░░█▓   
   ▓██████▓   
    ░░░░░░    `,
];

function ensureFrameHeight(frame: string, maxHeight: number): string {
  const lineCount = frame.split("\n").length;
  if (lineCount > maxHeight) {
    throw new Error(
      `AnimatedLogo frame exceeds max height: ${lineCount} > ${maxHeight}`,
    );
  }
  return frame;
}

function ensureShadowCharset(frame: string): string {
  if (!SHADOW_CHARSET.test(frame)) {
    throw new Error("AnimatedLogo frame contains non-shadow characters");
  }
  return frame;
}

function withLineIds(frame: string): Array<{ id: string; text: string }> {
  const seen = new Map<string, number>();
  return frame.split("\n").map((line) => {
    const count = (seen.get(line) ?? 0) + 1;
    seen.set(line, count);
    return {
      id: `${line}#${count}`,
      text: line,
    };
  });
}

const normalizedLogoFrames = logoFrames
  .map(ensureShadowCharset)
  .map((frame) => ensureFrameHeight(frame, MAX_LOGO_HEIGHT))
  .map(withLineIds);

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
    }, 100);
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

export function AnimatedLogo(props: { color?: string; animate?: boolean }) {
  const { shouldAnimate: shouldAnimateContext } = useAnimation();
  const shouldAnimate =
    props.animate !== false &&
    TUI_ANIMATIONS_ENABLED &&
    shouldAnimateContext;
  const frameTick = useSyncExternalStore(
    shouldAnimate ? subscribe : subscribeIdle,
    shouldAnimate ? getSnapshot : getStaticSnapshot,
  );
  const frame =
    shouldAnimate ? frameTick % normalizedLogoFrames.length : 0;
  const logoLines = normalizedLogoFrames[frame] ?? [];

  return (
    <>
      {logoLines.map((line) => (
        <Text key={line.id} bold color={props.color ?? colors.welcome.accent}>
          {line.text}
        </Text>
      ))}
    </>
  );
}
