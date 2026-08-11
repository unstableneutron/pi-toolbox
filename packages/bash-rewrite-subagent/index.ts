import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import bashRewriteExtension from '../../extensions/bash-rewrite/index';
import multiEditExtension from '../../extensions/multi-edit/index';
import piFffSearchExtension from '../../extensions/pi-fff-search/index';

export const BASH_REWRITE_SUBAGENT_REQUIRED_TOOLS = [
  'bash',
  'read',
  'ls',
  'fff_grep',
  'fff_find_files',
  'apply_patch',
] as const;

/**
 * Local-only convenience bundle for strict pi-subagents child processes.
 *
 * Provider extensions register first. The single bash host registers last.
 * Provider collection is lazy, so this order is explicit but not required.
 */
export default function bashRewriteSubagentBundle(pi: ExtensionAPI): void {
  piFffSearchExtension(pi);
  multiEditExtension(pi);
  bashRewriteExtension(pi);
}
