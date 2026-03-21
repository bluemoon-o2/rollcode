import { createContext, type ReactNode, useContext, useMemo } from "react";

interface AnimationContextValue {
  shouldAnimate: boolean;
}

const AnimationContext = createContext<AnimationContextValue>({
  shouldAnimate: true,
});

export function useAnimation(): AnimationContextValue {
  return useContext(AnimationContext);
}

export function AnimationProvider(props: {
  children: ReactNode;
  shouldAnimate: boolean;
}) {
  const value = useMemo(
    () => ({
      shouldAnimate: props.shouldAnimate,
    }),
    [props.shouldAnimate],
  );
  return (
    <AnimationContext.Provider value={value}>
      {props.children}
    </AnimationContext.Provider>
  );
}
