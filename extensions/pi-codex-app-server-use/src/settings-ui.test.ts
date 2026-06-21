import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'vitest';

import { CodexAppServerUseSettingsView } from './settings-ui';

function makeTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

describe('CodexAppServerUseSettingsView', () => {
  test('keeps every rendered line within the requested width', () => {
    const width = 57;
    const view = new CodexAppServerUseSettingsView(
      { project: {}, session: {}, user: {} },
      makeTheme(),
      () => {},
    );

    const lines = view.render(width);
    const tooWide = lines.filter((line) => visibleWidth(line) > width);

    expect(tooWide).toEqual([]);
  });
});
