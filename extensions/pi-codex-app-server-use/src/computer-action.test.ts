import { describe, expect, test } from 'vitest';

import { buildComputerActionCall } from './tools';

describe('buildComputerActionCall', () => {
  test('maps click action to Codex native click without the dispatcher field', () => {
    expect(
      buildComputerActionCall({
        action: 'click',
        app: 'Finder',
        element_index: '10',
        click_count: 2,
      }),
    ).toEqual({
      codexTool: 'click',
      arguments: {
        app: 'Finder',
        element_index: '10',
        click_count: 2,
      },
    });
  });

  test('maps secondary_action to Codex native perform_secondary_action', () => {
    expect(
      buildComputerActionCall({
        action: 'secondary_action',
        app: 'Finder',
        element_index: '2',
        secondary_action: 'open',
      }),
    ).toEqual({
      codexTool: 'perform_secondary_action',
      arguments: {
        app: 'Finder',
        element_index: '2',
        action: 'open',
      },
    });
  });
});
