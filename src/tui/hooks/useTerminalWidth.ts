import { useEffect, useState } from "react";

const getStdout = () => {
  if (typeof process === "undefined") return undefined;
  const stream = process.stdout as NodeJS.WriteStream | undefined;
  return stream && typeof stream.on === "function" ? stream : undefined;
};

const getTerminalWidth = () => getStdout()?.columns ?? 80;

type WidthListener = (columns: number) => void;

const widthListeners = new Set<WidthListener>();
let resizeHandlerRegistered = false;
let trackedColumns = getTerminalWidth();

const resizeHandler = () => {
  const nextColumns = getTerminalWidth();
  if (nextColumns === trackedColumns) {
    return;
  }
  trackedColumns = nextColumns;
  for (const listener of widthListeners) {
    listener(nextColumns);
  }
};

const ensureResizeHandler = () => {
  if (resizeHandlerRegistered) return;
  const stdout = getStdout();
  if (!stdout) return;
  stdout.on("resize", resizeHandler);
  resizeHandlerRegistered = true;
};

const removeResizeHandlerIfIdle = () => {
  if (!resizeHandlerRegistered || widthListeners.size > 0) {
    return;
  }
  const stdout = getStdout();
  if (!stdout) return;
  stdout.off("resize", resizeHandler);
  resizeHandlerRegistered = false;
};

export function useTerminalWidth(): number {
  const [columns, setColumns] = useState(trackedColumns);

  useEffect(() => {
    ensureResizeHandler();
    const listener: WidthListener = (value) => {
      setColumns(value);
    };
    widthListeners.add(listener);
    return () => {
      widthListeners.delete(listener);
      removeResizeHandlerIfIdle();
    };
  }, []);

  return columns;
}
