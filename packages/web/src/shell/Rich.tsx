/** Renders a translated message, turning `backticked` spans into <code> (commands, paths). */
export function Rich({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((part, index) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: the split of a fixed string never reorders.
        index % 2 === 1 ? <code key={index}>{part}</code> : part,
      )}
    </>
  );
}
