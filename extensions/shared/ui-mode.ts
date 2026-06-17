export type UiModeLike = {
  hasUI?: boolean;
  mode?: string;
};

export function hasTui(ctx: UiModeLike | undefined): boolean {
  if (!ctx) return false;
  if (ctx.mode !== undefined) {
    return ctx.mode === 'tui' && ctx.hasUI !== false;
  }
  return ctx.hasUI === true;
}
