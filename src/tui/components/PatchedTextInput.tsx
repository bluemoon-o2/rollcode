import RawTextInput, { type Props as RawTextInputProps } from "ink-text-input";
import type { ComponentType } from "react";

type PatchedTextInputRuntimeProps = RawTextInputProps & {
  externalCursorOffset?: number;
  onCursorOffsetChange?: (offset: number) => void;
};

const TextInputAny =
  RawTextInput as unknown as ComponentType<PatchedTextInputRuntimeProps>;

export interface PatchedTextInputProps extends RawTextInputProps {
  cursorPosition?: number;
  onCursorMove?: (position: number) => void;
}

export function PatchedTextInput({
  cursorPosition,
  onCursorMove,
  ...props
}: PatchedTextInputProps) {
  return (
    <TextInputAny
      {...props}
      externalCursorOffset={cursorPosition}
      onCursorOffsetChange={onCursorMove}
    />
  );
}
