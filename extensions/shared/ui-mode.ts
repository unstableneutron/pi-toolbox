export type UiModeLike = {
  hasUI?: boolean;
  mode?: string;
};

export function hasTui(ctx: UiModeLike | undefined): boolean {
  return ctx?.mode === 'tui' && ctx.hasUI !== false;
}
