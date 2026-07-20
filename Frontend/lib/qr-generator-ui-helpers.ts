export function getQrSelectionButtonLabel(
  selectedId: string,
  customUrl: string,
  customUrlSelectionId: string,
  items: Array<{ id: string; name: string; type: string }>,
) {
  if (selectedId === customUrlSelectionId) {
    const suffix = customUrl.trim()
      ? ` — ${customUrl.trim().length > 36 ? `${customUrl.trim().slice(0, 36)}…` : customUrl.trim()}`
      : '';
    return { kind: 'custom' as const, suffix };
  }

  if (!selectedId) {
    return { kind: 'placeholder' as const, text: 'Select a form or document...' };
  }

  const sel = items.find((i) => String(i.id) === String(selectedId));
  if (!sel) {
    return { kind: 'placeholder' as const, text: 'Select a form or document...' };
  }

  return { kind: 'item' as const, item: sel };
}
