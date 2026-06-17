import { unlink } from 'node:fs/promises';
import net from 'node:net';

import {
  BrowserUseSocketClient,
  DEFAULT_SOCKET_DIR,
  decodeNativeFrames,
  encodeNativeFrame,
  listBrowserUseSockets,
} from './browser-use-protocol.mjs';

const DEFAULT_BRIDGE_SOCKET_PATH = '/tmp/codex-browser-node-repl-bridge.sock';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const X_HOME_URL = 'https://x.com/home';

function errorMessage(error) {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

function compactErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeTurnMetadata(requestMeta = {}) {
  return requestMeta['x-codex-turn-metadata'] ?? requestMeta;
}

function readSessionIds(requestMeta = {}) {
  const turnMetadata = normalizeTurnMetadata(requestMeta);
  const sessionId = turnMetadata?.session_id;
  const turnId = turnMetadata?.turn_id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('Codex browser bridge requires requestMeta.session_id');
  }
  if (typeof turnId !== 'string' || turnId.length === 0) {
    throw new Error('Codex browser bridge requires requestMeta.turn_id');
  }
  return { sessionId, turnId, turnMetadata };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class BrowserUseRawRpc {
  constructor({
    browserSocketDir = DEFAULT_SOCKET_DIR,
    browserSocketPath,
    requestMeta,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {}) {
    const ids = readSessionIds(requestMeta);
    this.browserSocketDir = browserSocketDir;
    this.browserSocketPath = browserSocketPath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.sessionId = ids.sessionId;
    this.turnId = ids.turnId;
    this.backend = null;
  }

  async discover({ force = false } = {}) {
    if (!force && this.backend) return this.backend;
    const failures = [];
    const candidates = this.browserSocketPath
      ? [{ socketPath: this.browserSocketPath }]
      : (await listBrowserUseSockets({ socketDir: this.browserSocketDir })).sockets.slice(0, 20);

    for (const candidate of candidates) {
      try {
        const info = await this.requestAt(candidate.socketPath, 'getInfo', {}, 2_500);
        if (info?.type === 'extension') {
          this.backend = { failures, info, socketPath: candidate.socketPath };
          return this.backend;
        }
        failures.push({
          error: `unexpected backend type ${String(info?.type)}`,
          socketPath: candidate.socketPath,
        });
      } catch (error) {
        failures.push({ error: compactErrorMessage(error), socketPath: candidate.socketPath });
      }
    }

    throw new Error(`No active Browser Use extension socket found: ${JSON.stringify(failures)}`);
  }

  async requestAt(socketPath, method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const client = new BrowserUseSocketClient({
      requestTimeoutMs: timeoutMs,
      sessionId: this.sessionId,
      socketPath,
      turnId: this.turnId,
    });
    try {
      await client.connect(timeoutMs);
      return await client.request(method, params, timeoutMs);
    } finally {
      await client.close().catch(() => {});
    }
  }

  async request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const backend = await this.discover();
    try {
      return await this.requestAt(backend.socketPath, method, params, timeoutMs);
    } catch (error) {
      if (this.browserSocketPath) throw error;
      const refreshed = await this.discover({ force: true });
      return await this.requestAt(refreshed.socketPath, method, params, timeoutMs);
    }
  }
}

async function cdp(rpc, tabId, method, commandParams = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  return await rpc.request(
    'executeCdp',
    {
      commandParams,
      method,
      target: { tabId: Number(tabId) },
      timeoutMs,
    },
    timeoutMs + 1_000,
  );
}

async function attach(rpc, tabId) {
  await rpc.request('attach', { tabId: Number(tabId) }, 10_000).catch(() => {});
}

async function evaluate(rpc, tabId, expression, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const result = await cdp(
    rpc,
    tabId,
    'Runtime.evaluate',
    { awaitPromise: true, expression, returnByValue: true },
    timeoutMs,
  );
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result?.result?.value;
}

async function describeManagedTab(rpc, tabId) {
  const tabs = await rpc.request('getTabs', {}, 10_000).catch(() => []);
  if (!Array.isArray(tabs)) return { id: tabId };
  return tabs.find((tab) => Number(tab.id) === Number(tabId)) ?? { id: tabId };
}

async function gotoTab(rpc, options = {}) {
  let tabId = options.tabId;
  let createdTab = null;
  if (tabId == null) {
    createdTab = await rpc.request('createTab', {}, 10_000);
    tabId = createdTab.id;
  }
  await attach(rpc, tabId);
  const navigation = await cdp(
    rpc,
    tabId,
    'Page.navigate',
    { url: options.url },
    DEFAULT_NAVIGATION_TIMEOUT_MS,
  );

  let state = null;
  for (let index = 0; index < 40; index++) {
    state = await evaluate(
      rpc,
      tabId,
      '({ href: location.href, readyState: document.readyState, title: document.title })',
      5_000,
    ).catch(() => null);
    if (state?.readyState === 'complete' || state?.readyState === 'interactive') break;
    await delay(500);
  }

  return {
    createdTab,
    navigation,
    state,
    tab: await describeManagedTab(rpc, tabId),
    transport: 'node-repl-bridge-raw-rpc',
  };
}

async function runHttpbinFormDemo(rpc) {
  const gotoResult = await gotoTab(rpc, { url: 'http://httpbin.org/forms/post' });
  const tabId = gotoResult.tab.id;
  const fillResult = await evaluate(
    rpc,
    tabId,
    `(() => {
      const setValue = (name, value) => {
        const el = document.querySelector('[name="' + name + '"]');
        if (!el) throw new Error('missing field ' + name);
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const check = (selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error('missing control ' + selector);
        el.checked = true;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setValue('custname', 'Pi Codex Browser');
      setValue('custtel', '555-0100');
      setValue('custemail', 'pi-codex-browser@example.com');
      setValue('delivery', '2026-06-06T12:00');
      setValue('comments', 'POC submission from codex-browser CLI.');
      check('input[name="size"][value="medium"]');
      check('input[name="topping"][value="bacon"]');
      check('input[name="topping"][value="cheese"]');
      document.querySelector('form').requestSubmit();
      return { href: location.href, submitted: true };
    })()`,
    10_000,
  );

  let finalState = null;
  for (let index = 0; index < 40; index++) {
    finalState = await evaluate(
      rpc,
      tabId,
      '({ href: location.href, readyState: document.readyState, title: document.title, text: document.body ? document.body.innerText.slice(0, 4000) : "" })',
      5_000,
    ).catch(() => null);
    if (finalState?.href?.includes('/post') && finalState?.text?.includes('Pi Codex Browser')) {
      break;
    }
    await delay(500);
  }

  return {
    evidence: {
      bodyPreview: finalState?.text?.slice(0, 2_000) ?? '',
      containsCustomerName: finalState?.text?.includes('Pi Codex Browser') === true,
      containsEmail: finalState?.text?.includes('pi-codex-browser@example.com') === true,
    },
    fillResult,
    submitted:
      finalState?.href?.includes('/post') === true &&
      finalState?.text?.includes('Pi Codex Browser') === true,
    tab: await describeManagedTab(rpc, tabId),
    transport: 'node-repl-bridge-raw-rpc',
    url: finalState?.href,
  };
}

function xExtractExpression() {
  return `(() => {
    const normalizeUrl = (href) => {
      try { const url = new URL(href, location.href); url.search = ''; url.hash = ''; return url.href; } catch { return href || ''; }
    };
    const isStatusUrl = (href) => {
      const marker = '/status/';
      const index = href.indexOf(marker);
      if (index < 0) return false;
      const rest = href.slice(index + marker.length);
      return rest.length > 0 && rest.split('').some((ch) => ch >= '0' && ch <= '9');
    };
    const articles = Array.from(document.querySelectorAll('article')).map((article, index) => {
      const text = (article.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
      const statusLinks = Array.from(article.querySelectorAll('a[href*="/status/"]')).map((a) => normalizeUrl(a.href));
      const url = statusLinks.find((href) => isStatusUrl(href));
      const authorLink = Array.from(article.querySelectorAll('a[href^="/"]'))
        .map((a) => a.getAttribute('href'))
        .find((href) => href && !href.includes('/status/') && !href.includes('/photo/') && !href.includes('/analytics'));
      return { author: authorLink || null, index, text: text.slice(0, 1600), url };
    }).filter((item) => item.text && item.url);
    return {
      articleCount: articles.length,
      bodyPreview: (document.body?.innerText || '').slice(0, 1000),
      href: location.href,
      items: articles,
      scrollHeight: document.documentElement.scrollHeight,
      scrollY: window.scrollY,
      title: document.title,
    };
  })()`;
}

function tweetIdFromUrl(url) {
  const match = String(url ?? '').match(/\/status\/(\d+)/);
  return match?.[1] ?? null;
}

function mergeXItems(primary, secondary, limit) {
  const byUrl = new Map();
  for (const item of [...(primary ?? []), ...(secondary ?? [])]) {
    if (item?.url && !byUrl.has(item.url)) byUrl.set(item.url, item);
  }
  return [...byUrl.values()].slice(0, limit);
}

function xGraphqlExpression(action, params = {}) {
  const input = JSON.stringify({ action, ...params });
  return `(async () => {
    const input = ${input};
    const scripts = Array.from(document.scripts).map((script) => script.src).filter(Boolean);
    const mainScript = [...scripts].reverse().find((src) => /\\/main\\.[^/]+\\.js(?:$|\\?)/.test(src));
    if (!mainScript) throw new Error('Could not find current X main bundle');
    const bundle = await fetch(mainScript).then((response) => {
      if (!response.ok) throw new Error('Could not fetch X main bundle: ' + response.status);
      return response.text();
    });
    const bearer = (bundle.match(/Bearer ([A-Za-z0-9%_-]+)/) || [])[1];
    if (!bearer) throw new Error('Could not find X bearer token in main bundle');

    const parseList = (value) => Array.from(value.matchAll(/"([^"]+)"/g)).map((match) => match[1]);
    const operation = (name) => {
      const expression = new RegExp('queryId:"([^"]+)",operationName:"' + name + '",operationType:"query",metadata:\\\\{featureSwitches:\\\\[([^\\\\]]*)\\\\],fieldToggles:\\\\[([^\\\\]]*)\\\\]');
      const match = bundle.match(expression);
      if (!match) throw new Error('Could not find X GraphQL operation ' + name);
      return {
        fieldToggles: Object.fromEntries(parseList(match[3]).map((key) => [key, true])),
        features: Object.fromEntries(parseList(match[2]).map((key) => [key, true])),
        name,
        queryId: match[1],
      };
    };
    const csrf = (document.cookie.match(/(?:^|; )ct0=([^;]+)/) || [])[1] || '';
    const call = async (name, variables) => {
      const op = operation(name);
      const url = '/i/api/graphql/' + op.queryId + '/' + name + '?' + new URLSearchParams({
        fieldToggles: JSON.stringify(op.fieldToggles),
        features: JSON.stringify(op.features),
        variables: JSON.stringify(variables),
      });
      const response = await fetch(url, {
        credentials: 'include',
        headers: {
          authorization: 'Bearer ' + bearer,
          'x-csrf-token': csrf,
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-client-language': 'en',
        },
      });
      const text = await response.text();
      if (!response.ok) {
        return { error: text.slice(0, 2000), ok: false, operation: op, status: response.status };
      }
      return { json: JSON.parse(text), ok: true, operation: op, status: response.status };
    };

    const normalizeTweet = (value) => {
      if (!value || typeof value !== 'object') return null;
      if (value.__typename === 'TweetWithVisibilityResults') return value.tweet ?? null;
      if (value.__typename === 'Tweet') return value;
      return null;
    };
    const tweetToItem = (tweet, source) => {
      const normalized = normalizeTweet(tweet);
      if (!normalized?.legacy) return null;
      const user = normalized.core?.user_results?.result;
      const screenName = user?.core?.screen_name || user?.legacy?.screen_name || '';
      const id = normalized.legacy.id_str || normalized.rest_id;
      if (!id || !screenName) return null;
      const text =
        normalized.note_tweet?.note_tweet_results?.result?.text ||
        normalized.legacy.full_text ||
        '';
      return {
        author: '/' + screenName,
        authorName: user?.core?.name || user?.legacy?.name || screenName,
        bookmarkCount: normalized.legacy.bookmark_count ?? null,
        conversationId: normalized.legacy.conversation_id_str ?? id,
        createdAt: normalized.legacy.created_at ?? null,
        favoriteCount: normalized.legacy.favorite_count ?? null,
        id,
        quoteCount: normalized.legacy.quote_count ?? null,
        replyCount: normalized.legacy.reply_count ?? null,
        retweetCount: normalized.legacy.retweet_count ?? null,
        source,
        text: text.slice(0, 1600),
        url: 'https://x.com/' + screenName + '/status/' + id,
        viewCount: normalized.views?.count ?? null,
      };
    };
    const unique = (items) => {
      const seen = new Set();
      return items.filter((item) => item?.url && !seen.has(item.url) && seen.add(item.url));
    };
    const entriesFromInstructions = (instructions) => {
      const entries = [];
      for (const instruction of instructions ?? []) {
        if (Array.isArray(instruction.entries)) entries.push(...instruction.entries);
        if (Array.isArray(instruction.addEntries?.entries)) {
          entries.push(...instruction.addEntries.entries);
        }
        if (instruction.entry) entries.push(instruction.entry);
        if (instruction.replaceEntry?.entry) entries.push(instruction.replaceEntry.entry);
      }
      return entries;
    };
    const entryTweetResults = (entry) => {
      const content = entry?.content;
      if (!content) return [];
      const component = content.clientEventInfo?.component || '';
      if (/promoted/i.test(component) || content.promotedMetadata) return [];
      const results = [];
      if (content.itemContent?.tweet_results?.result) {
        results.push(content.itemContent.tweet_results.result);
      }
      for (const moduleItem of content.items ?? []) {
        const itemContent = moduleItem.item?.itemContent ?? moduleItem.itemContent;
        if (itemContent?.tweet_results?.result) results.push(itemContent.tweet_results.result);
      }
      return results;
    };
    const visitTweets = (value, tweets) => {
      if (!value || typeof value !== 'object') return;
      const tweet = normalizeTweet(value);
      if (tweet?.legacy) tweets.push(tweet);
      for (const child of Object.values(value)) visitTweets(child, tweets);
    };

    if (input.action === 'home') {
      const response = await call('HomeTimeline', {
        count: Math.max(Number(input.targetCount ?? 20) * 2, 40),
        includePromotedContent: true,
        latestControlAvailable: true,
        requestContext: 'launch',
        withCommunity: true,
      });
      if (!response.ok) return response;
      const instructions = response.json?.data?.home?.home_timeline_urt?.instructions ?? [];
      const entries = entriesFromInstructions(instructions);
      const items = unique(
        entries
          .flatMap(entryTweetResults)
          .map((tweet) => tweetToItem(tweet, 'graphql-home'))
          .filter(Boolean),
      );
      return {
        entryCount: entries.length,
        items: items.slice(0, Number(input.targetCount ?? 20)),
        ok: true,
        operationName: 'HomeTimeline',
        status: response.status,
      };
    }

    if (input.action === 'tweetDetail') {
      const response = await call('TweetDetail', {
        focalTweetId: String(input.tweetId),
        includePromotedContent: true,
        rankingMode: 'Relevance',
        withBirdwatchNotes: true,
        withCommunity: true,
        withQuickPromoteEligibilityTweetFields: true,
        withVoice: true,
        with_rux_injections: false,
      });
      if (!response.ok) return response;
      const instructions =
        response.json?.data?.threaded_conversation_with_injections_v2?.instructions ?? [];
      const entries = entriesFromInstructions(instructions);
      const tweets = [];
      for (const entry of entries) visitTweets(entry, tweets);
      const items = unique(
        tweets.map((tweet) => tweetToItem(tweet, 'graphql-tweet-detail')).filter(Boolean),
      );
      const comments = items.filter(
        (item) => item.conversationId === String(input.tweetId) && item.id !== String(input.tweetId),
      );
      return {
        comments: comments.slice(0, Number(input.commentsPerItem ?? 3)),
        entryCount: entries.length,
        items: items.slice(0, 50),
        ok: true,
        operationName: 'TweetDetail',
        status: response.status,
      };
    }

    throw new Error('Unsupported X GraphQL action: ' + input.action);
  })()`;
}

async function fetchXHomeTimeline(rpc, tabId, targetCount) {
  return await evaluate(rpc, tabId, xGraphqlExpression('home', { targetCount }), 30_000);
}

async function fetchXCommentThread(rpc, tabId, item, commentsPerItem) {
  const tweetId = tweetIdFromUrl(item.url);
  if (!tweetId) return { comments: [], error: 'missing tweet id', ok: false };
  return await evaluate(
    rpc,
    tabId,
    xGraphqlExpression('tweetDetail', { commentsPerItem, tweetId }),
    30_000,
  );
}

async function collectXItems(rpc, tabId, targetCount, maxScrolls) {
  const byUrl = new Map();
  const observations = [];
  for (let scroll = 0; scroll <= maxScrolls && byUrl.size < targetCount; scroll++) {
    const snapshot = await evaluate(rpc, tabId, xExtractExpression(), 10_000).catch((error) => ({
      error: compactErrorMessage(error),
      items: [],
    }));
    observations.push({
      articleCount: snapshot.articleCount,
      error: snapshot.error,
      href: snapshot.href,
      itemCount: snapshot.items?.length ?? 0,
      scroll,
    });
    for (const item of snapshot.items ?? []) {
      if (!byUrl.has(item.url)) byUrl.set(item.url, { ...item, firstSeenScroll: scroll });
    }
    if (byUrl.size >= targetCount) break;
    await evaluate(
      rpc,
      tabId,
      'window.scrollBy(0, Math.max(900, Math.floor(window.innerHeight * 1.1))); ({ scrollY: window.scrollY, scrollHeight: document.documentElement.scrollHeight })',
      5_000,
    ).catch(() => null);
    await delay(1_300);
  }
  return { items: [...byUrl.values()].slice(0, targetCount), observations };
}

async function collectXComments(rpc, item, commentsPerItem) {
  if (!item.url) return { comments: [], error: 'missing url', itemUrl: item.url };
  const gotoResult = await gotoTab(rpc, { url: item.url });
  const tabId = gotoResult.tab.id;
  let snapshot = null;
  for (let attempt = 0; attempt < 14; attempt++) {
    snapshot = await evaluate(rpc, tabId, xExtractExpression(), 10_000).catch((error) => ({
      error: compactErrorMessage(error),
      items: [],
    }));
    if ((snapshot.items ?? []).length > 1) break;
    await evaluate(
      rpc,
      tabId,
      'window.scrollBy(0, Math.max(600, Math.floor(window.innerHeight * 0.8))); ({ scrollY: window.scrollY })',
      5_000,
    ).catch(() => null);
    await delay(1_000);
  }
  const comments = (snapshot?.items ?? [])
    .filter((candidate) => candidate.url !== item.url || candidate.text !== item.text)
    .slice(1, commentsPerItem + 1);
  const graphql = await fetchXCommentThread(rpc, tabId, item, commentsPerItem).catch((error) => ({
    comments: [],
    error: compactErrorMessage(error),
    ok: false,
  }));
  return {
    comments: graphql?.comments?.length > 0 ? graphql.comments : comments,
    graphql: {
      commentCount: graphql?.comments?.length ?? 0,
      entryCount: graphql?.entryCount,
      error: graphql?.error,
      ok: graphql?.ok === true,
      operationName: graphql?.operationName,
      status: graphql?.status,
    },
    itemUrl: item.url,
    snapshot: {
      articleCount: snapshot?.articleCount,
      error: snapshot?.error,
      href: snapshot?.href,
    },
    tab: gotoResult.tab,
  };
}

async function runXFeedTop20(rpc, options = {}) {
  const targetCount = options.items ?? 20;
  const commentItems = options.commentItems ?? 3;
  const commentsPerItem = options.commentsPerItem ?? 3;
  const gotoResult = await gotoTab(rpc, { url: X_HOME_URL });
  const tabId = gotoResult.tab.id;
  await delay(3_000);
  const domCollected = await collectXItems(rpc, tabId, targetCount, 20);
  const graphqlHome = await fetchXHomeTimeline(rpc, tabId, targetCount).catch((error) => ({
    error: compactErrorMessage(error),
    items: [],
    ok: false,
  }));
  const items =
    graphqlHome?.items?.length >= targetCount
      ? graphqlHome.items.slice(0, targetCount)
      : mergeXItems(domCollected.items, graphqlHome?.items ?? [], targetCount);
  const commentThreads = [];
  const commentCandidates = [...items]
    .sort((left, right) => (right.replyCount ?? 0) - (left.replyCount ?? 0))
    .slice(0, commentItems);
  for (const item of commentCandidates) {
    commentThreads.push(
      await collectXComments(rpc, item, commentsPerItem).catch((error) => ({
        comments: [],
        error: compactErrorMessage(error),
        itemUrl: item.url,
      })),
    );
  }
  const finalSnapshot = await evaluate(rpc, tabId, xExtractExpression(), 10_000).catch((error) => ({
    bodyPreview: '',
    error: compactErrorMessage(error),
  }));
  return {
    collectedCount: items.length,
    commentThreads,
    domCollectedCount: domCollected.items.length,
    finalPage: {
      bodyPreview: finalSnapshot.bodyPreview,
      error: finalSnapshot.error,
      href: finalSnapshot.href,
      title: finalSnapshot.title,
    },
    graphqlHome: {
      entryCount: graphqlHome?.entryCount,
      error: graphqlHome?.error,
      itemCount: graphqlHome?.items?.length ?? 0,
      ok: graphqlHome?.ok === true,
      operationName: graphqlHome?.operationName,
      status: graphqlHome?.status,
    },
    items,
    observations: domCollected.observations,
    tab: await describeManagedTab(rpc, tabId),
    targetCount,
    transport: 'node-repl-bridge-raw-rpc',
  };
}

async function executeBrowserCommand(rpc, commandParams) {
  if (!commandParams || typeof commandParams !== 'object') {
    throw new Error('chrome_execute_command requires an object command');
  }
  if (commandParams.type === 'navigate_tab_url') {
    const tabId = commandParams.tab_id ?? commandParams.tabId;
    if (!tabId) throw new Error('navigate_tab_url requires tab_id');
    if (!commandParams.url) throw new Error('navigate_tab_url requires url');
    return await gotoTab(rpc, { tabId, url: commandParams.url });
  }
  if (commandParams.type === 'browser_user_open_tabs') {
    return await rpc.request('getUserTabs', {}, 10_000);
  }
  if (commandParams.type === 'browser_user_claim_tab') {
    const tabId = commandParams.tab_id ?? commandParams.tabId;
    if (!tabId) throw new Error('browser_user_claim_tab requires tab_id');
    return await rpc.request('claimUserTab', { tabId }, 10_000);
  }
  if (commandParams.type === 'create_tab') {
    return await rpc.request('createTab', {}, 10_000);
  }
  if (commandParams.type === 'list_tabs') {
    return await rpc.request('getTabs', {}, 10_000);
  }
  return await rpc.request('executeUnhandledCommand', commandParams);
}

async function runBridgeCommand(command, options, rpc) {
  if (command === 'raw') {
    if (!options.method) throw new Error('raw requires <method>');
    return {
      method: options.method,
      result: await rpc.request(options.method, options.params ?? {}),
      transport: 'node-repl-bridge-raw-rpc',
    };
  }
  if (command === 'chrome_execute_command') {
    if (!options.commandParams) {
      throw new Error('chrome_execute_command requires --command-json');
    }
    return {
      result: await executeBrowserCommand(rpc, options.commandParams),
      transport: 'node-repl-bridge-raw-rpc',
    };
  }
  if (command === 'doctor' || command === 'chrome_backends_list') {
    return {
      backend: await rpc.discover({ force: command === 'chrome_backends_list' }),
      ok: true,
      transport: 'node-repl-bridge-raw-rpc',
    };
  }
  if (command === 'chrome_tabs_list') {
    const tabs = await rpc.request('getUserTabs', {}, 10_000);
    return {
      tabs: Array.isArray(tabs) ? tabs.slice(0, options.limit ?? 100) : tabs,
      totalTabs: Array.isArray(tabs) ? tabs.length : null,
      transport: 'node-repl-bridge-raw-rpc',
    };
  }
  if (command === 'chrome_tab_new') {
    return {
      tab: await rpc.request('createTab', {}, 10_000),
      transport: 'node-repl-bridge-raw-rpc',
    };
  }
  if (command === 'chrome_tab_claim') {
    if (!options.tabId) throw new Error('chrome_tab_claim requires --tab-id');
    return {
      result: await rpc.request('claimUserTab', { tabId: options.tabId }, 10_000),
      transport: 'node-repl-bridge-raw-rpc',
    };
  }
  if (command === 'chrome_tab_goto') {
    if (!options.url) throw new Error('chrome_tab_goto requires <url> or --url');
    return await gotoTab(rpc, options);
  }
  if (command === 'httpbin_form_demo') return await runHttpbinFormDemo(rpc);
  if (command === 'x_feed_top20') return await runXFeedTop20(rpc, options);
  throw new Error(`Unsupported bridge command: ${command}`);
}

/**
 * @param {{
 *   bridgeSocketPath?: string,
 *   browserSocketDir?: string,
 *   browserSocketPath?: string,
 *   requestMeta?: Record<string, unknown>,
 *   requestTimeoutMs?: number,
 * }} options
 * @returns {Promise<{
 *   backend: unknown,
 *   bridgeSocketPath: string,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startCodexBrowserBridge({
  bridgeSocketPath = DEFAULT_BRIDGE_SOCKET_PATH,
  browserSocketDir,
  browserSocketPath,
  requestMeta,
  requestTimeoutMs,
} = {}) {
  const rpc = new BrowserUseRawRpc({
    browserSocketDir,
    browserSocketPath,
    requestMeta,
    requestTimeoutMs,
  });
  await rpc.discover();
  await unlink(bridgeSocketPath).catch(() => {});
  const server = net.createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      let decoded;
      try {
        decoded = decodeNativeFrames(Buffer.concat([pending, chunk]));
        pending = decoded.rest;
      } catch (error) {
        socket.write(encodeNativeFrame({ error: { message: errorMessage(error) }, id: null }));
        return;
      }
      for (const frame of decoded.frames) {
        void (async () => {
          try {
            if (frame.method !== 'command') {
              throw new Error(`Unsupported bridge method: ${String(frame.method)}`);
            }
            const result = await runBridgeCommand(
              frame.params?.command,
              frame.params?.options ?? {},
              rpc,
            );
            socket.write(encodeNativeFrame({ id: frame.id, result }));
          } catch (error) {
            socket.write(
              encodeNativeFrame({ error: { message: errorMessage(error) }, id: frame.id }),
            );
          }
        })();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(bridgeSocketPath, resolve);
  });
  return {
    backend: rpc.backend,
    bridgeSocketPath,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve(undefined)));
      });
      await unlink(bridgeSocketPath).catch(() => {});
    },
  };
}

/**
 * @param {string} bridgeSocketPath
 * @param {string} command
 * @param {Record<string, unknown>} [options]
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
export async function sendBridgeCommand(
  bridgeSocketPath,
  command,
  options = {},
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
) {
  const socket = net.createConnection(bridgeSocketPath);
  let pending = Buffer.alloc(0);
  let settled = false;
  return await new Promise((resolve, reject) => {
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn(value);
      }
    };
    const timer = setTimeout(
      () => settle(reject, new Error(`Bridge request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    socket.once('connect', () => {
      socket.write(encodeNativeFrame({ id: 1, method: 'command', params: { command, options } }));
    });
    socket.on('data', (chunk) => {
      try {
        const decoded = decodeNativeFrames(Buffer.concat([pending, chunk]));
        pending = decoded.rest;
        for (const frame of decoded.frames) {
          if (frame.error) {
            settle(reject, new Error(frame.error.message ?? JSON.stringify(frame.error)));
          } else {
            settle(resolve, frame.result);
          }
        }
      } catch (error) {
        settle(reject, error);
      }
    });
    socket.once('error', (error) => settle(reject, error));
    socket.once('close', () => settle(reject, new Error('Bridge socket closed before response')));
  });
}
