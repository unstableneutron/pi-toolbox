import type { ToolInfo } from '@earendil-works/pi-coding-agent';

export interface DeferredToolGroup {
  id: string;
  summary: string;
  aliases: string[];
  tools: string[];
}

export interface DeferredToolGroupMatch {
  group: DeferredToolGroup;
  score: number;
  direct: boolean;
  availableTools: string[];
  activeTools: string[];
}

export const INITIAL_ACTIVE_TOOL_NAMES = new Set([
  'exec_command',
  'apply_patch',
  'fff_grep',
  'fff_find_files',
  'web_search',
  'subagent',
  'todo',
  'search_tools',
  'multi_tool_use.parallel',
]);

const DEFERRED_TOOL_GROUPS: DeferredToolGroup[] = [
  {
    id: 'subagents',
    summary: 'Run and wait for delegated child agents and parallel review or research work.',
    aliases: ['child agent', 'delegate', 'delegation', 'parallel worker', 'reviewer', 'subagent'],
    tools: ['subagent', 'subagent_wait'],
  },
  {
    id: 'subagent-supervisor',
    summary: 'Reply to child subagent requests that need supervisor attention.',
    aliases: ['child decision', 'supervisor reply', 'subagent attention'],
    tools: ['subagent_supervisor'],
  },
  {
    id: 'intercom',
    summary: 'Coordinate with other local Pi sessions.',
    aliases: ['coordinate session', 'message another session', 'pi session communication'],
    tools: ['intercom'],
  },
  {
    id: 'herdr',
    summary: 'Inspect or control Herdr layouts, terminal panes, and coding agents.',
    aliases: ['herdr agent', 'herdr pane', 'terminal topology'],
    tools: ['herdr_layout', 'herdr_pane', 'herdr_agent'],
  },
  {
    id: 'goals',
    summary: 'Create, inspect, or complete a long-running session goal.',
    aliases: ['create goal', 'goal tracking', 'long-running goal', 'update goal'],
    tools: ['get_goal', 'create_goal', 'update_goal'],
  },
  {
    id: 'web',
    summary: 'Search the web, verify claims, fetch URLs, and read stored search content.',
    aliases: ['citation', 'fetch url', 'internet research', 'source check', 'web research'],
    tools: ['web_search', 'source_check', 'fetch_content', 'get_search_content'],
  },
  {
    id: 'memory-read',
    summary: 'Search durable memory and past Pi sessions.',
    aliases: ['earlier discussion', 'memory search', 'past conversation', 'previous session'],
    tools: ['memory_search', 'session_search'],
  },
  {
    id: 'memory-write',
    summary: 'Add, replace, or remove durable memory.',
    aliases: ['correction', 'remember this', 'save preference', 'update memory'],
    tools: ['memory_add', 'memory_replace', 'memory_remove'],
  },
  {
    id: 'skills',
    summary: 'Create, inspect, or update reusable procedural skills.',
    aliases: ['procedural memory', 'reusable procedure', 'skill management'],
    tools: ['skill_manage'],
  },
  {
    id: 'executor-discovery',
    summary: 'Search and use Executor bridge or connected integration capabilities.',
    aliases: ['connected integration', 'executor integration', 'integration tool'],
    tools: ['executor_search_tools', 'executor_describe_tool', 'executor_execute'],
  },
  {
    id: 'executor-guides',
    summary: 'List and read Executor procedural guides.',
    aliases: ['executor guide', 'integration guide'],
    tools: ['executor_list_guides', 'executor_get_guide'],
  },
  {
    id: 'executor-jobs',
    summary: 'Wait for or cancel an active Executor job.',
    aliases: ['cancel executor', 'executor job', 'wait executor'],
    tools: ['executor_get_job', 'executor_cancel_job'],
  },
  {
    id: 'executor-output',
    summary: 'Read more of a truncated Executor result.',
    aliases: ['executor output', 'truncated executor result'],
    tools: ['executor_read_output'],
  },
  {
    id: 'exec-session',
    summary: 'Write to or poll a live exec_command session.',
    aliases: ['poll command', 'stdin', 'terminal session', 'write stdin'],
    tools: ['write_stdin'],
  },
  {
    id: 'image-view',
    summary: 'Inspect a local image file.',
    aliases: ['inspect image', 'local image', 'view image'],
    tools: ['view_image'],
  },
  {
    id: 'follow-up-command',
    summary: 'Queue /answer or prefill a follow-up message after the current turn.',
    aliases: ['answer flow', 'prefill editor', 'queue follow up'],
    tools: ['execute_command'],
  },
  {
    id: 'loop-control',
    summary: 'Signal that the active /loop breakout condition succeeded.',
    aliases: ['break loop', 'loop complete', 'loop success'],
    tools: ['signal_loop_success'],
  },
];

export const DEFERRED_TOOL_NAMES = new Set(DEFERRED_TOOL_GROUPS.flatMap((group) => group.tools));

function normalizedTerms(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function compact(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function scoreGroup(
  group: DeferredToolGroup,
  tools: ToolInfo[],
  query: string,
): { score: number; direct: boolean } {
  const normalizedQuery = compact(query);
  const terms = normalizedTerms(query);
  const directText = compact([group.id, ...group.aliases, ...group.tools].join(' '));
  const descriptionText = compact(
    [group.summary, ...tools.map((tool) => tool.description)].join(' '),
  );
  let score = 0;
  let direct = false;

  if (normalizedQuery && directText.includes(normalizedQuery)) {
    score += 24;
    direct = true;
  }
  for (const term of terms) {
    if (directText.includes(term)) {
      score += 6;
      direct = true;
    } else if (descriptionText.includes(term)) {
      score += 1;
    }
  }
  return { score, direct };
}

export function findDeferredToolGroups(
  allTools: ToolInfo[],
  activeNames: Set<string>,
  query: string,
  limit: number,
): DeferredToolGroupMatch[] {
  const byName = new Map(allTools.map((tool) => [tool.name, tool]));
  return DEFERRED_TOOL_GROUPS.flatMap((group) => {
    const registeredTools = group.tools.filter((name) => byName.has(name));
    if (registeredTools.length === 0) return [];
    const availableTools = registeredTools.filter((name) => !activeNames.has(name));
    const activeTools = registeredTools.filter((name) => activeNames.has(name));
    const tools = registeredTools.flatMap((name) => {
      const tool = byName.get(name);
      return tool ? [tool] : [];
    });
    const { score, direct } = scoreGroup(group, tools, query);
    return score > 0 ? [{ group, score, direct, availableTools, activeTools }] : [];
  })
    .sort((left, right) => right.score - left.score || left.group.id.localeCompare(right.group.id))
    .slice(0, limit);
}
