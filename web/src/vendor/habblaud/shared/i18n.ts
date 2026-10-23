// Barnacle: stand-in for Habblaud's shared/i18n. The art only uses tr() for a few editor hints,
// which Barnacle doesn't show, so the source text is returned as is.
export function tr(src: string, args?: readonly unknown[]): string {
  if (!args || args.length === 0) return src;
  return src.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));
}
