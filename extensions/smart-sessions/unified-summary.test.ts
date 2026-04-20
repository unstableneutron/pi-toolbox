import { describe, expect, test } from 'vitest';

import { parseRollingSummaryResponse } from './unified-summary';

describe('parseRollingSummaryResponse', () => {
  test('accepts structured JSON output with summary bullets and timeline items', () => {
    const parsed = parseRollingSummaryResponse(`
      {
        "shortTitle": "Smart summary",
        "longTitle": "Unify smart-sessions rolling summary and notifications",
        "shortSummary": "Need user approval on map-reduce summary design",
        "summaryBullets": ["In Progress: Designing one rolling summary path."],
        "timelineItems": ["Checked prompts in extensions/smart-sessions/index.ts."]
      }
    `);

    expect(parsed.shortTitle).toBe('Smart summary');
    expect(parsed.summaryBullets).toEqual(['In Progress: Designing one rolling summary path.']);
  });

  test('rejects missing timeline items', () => {
    expect(() =>
      parseRollingSummaryResponse(
        '{"shortTitle":"x","longTitle":"y","shortSummary":"z","summaryBullets":[]}',
      ),
    ).toThrow(/timelineItems/);
  });

  test('rejects non-string summary bullets instead of coercing them', () => {
    expect(() =>
      parseRollingSummaryResponse(`
        {
          "shortTitle": "Smart summary",
          "longTitle": "Reject malformed structured output",
          "shortSummary": "Need retry on malformed summary bullets",
          "summaryBullets": [{"bad":true}],
          "timelineItems": ["Checked the parser."]
        }
      `),
    ).toThrow(/summaryBullets/);
  });
});
