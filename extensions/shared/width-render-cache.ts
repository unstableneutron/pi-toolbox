export class WidthRenderCache {
  private entry: { width: number; lines: string[] } | undefined;

  render(width: number, compute: () => string[]): string[] {
    if (this.entry?.width === width) return this.entry.lines;

    const lines = compute();
    this.entry = { width, lines };
    return lines;
  }

  clear(): void {
    this.entry = undefined;
  }
}
