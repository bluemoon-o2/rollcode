import { memo, useEffect, useState } from "react";
import { TUI_ANIMATIONS_ENABLED } from "../animation";
import { useAnimation } from "../contexts/AnimationContext";
import { colors } from "./colors";
import { Text } from "./Text";

export const BlinkDot = memo(
  ({
    color = colors.tool.pending,
    symbol = "●",
    shouldAnimate = true,
  }: {
    color?: string;
    symbol?: string;
    shouldAnimate?: boolean;
  }) => {
    const { shouldAnimate: shouldAnimateContext } = useAnimation();
    const animate =
      TUI_ANIMATIONS_ENABLED &&
      shouldAnimateContext &&
      shouldAnimate !== false;
    const [on, setOn] = useState(true);

    useEffect(() => {
      if (!animate) {
        setOn(true);
        return;
      }
      const timer = setInterval(() => setOn((value) => !value), 400);
      return () => clearInterval(timer);
    }, [animate]);

    return <Text color={color}>{on || !animate ? symbol : " "}</Text>;
  },
);

BlinkDot.displayName = "BlinkDot";
