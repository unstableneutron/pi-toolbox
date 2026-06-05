import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { type Model } from '@earendil-works/pi-ai';

const messages = [
  // Short
  'Schlepping...',
  'Combobulating...',
  'Doing...',
  'Channelling...',
  'Vibing...',
  'Concocting...',
  'Spelunking...',
  'Transmuting...',
  'Imagining...',
  'Pontificating...',
  'Whirring...',
  'Cogitating...',
  'Honking...',
  'Flibbertigibbeting...',
  'Noodling...',
  'Percolating...',
  'Ruminating...',
  'Simmering...',
  'Marinating...',
  'Fermenting...',
  'Gestating...',
  'Hatching...',
  'Brewing...',
  'Steeping...',
  'Contemplating...',
  'Musing...',
  'Pondering...',
  'Mulling...',
  'Daydreaming...',
  'Woolgathering...',
  'Dithering...',
  'Faffing...',
  'Puttering...',
  'Tinkering...',
  'Fiddling...',
  'Noodging...',
  'Finagling...',
  'Wrangling...',
  'Jiggling...',
  'Wiggling...',
  'Shimmying...',
  'Galumphing...',
  'Perambulating...',
  'Meandering...',
  'Traipsing...',
  'Moseying...',
  'Sauntering...',
  'Ambling...',
  'Pottering...',
  'Bumbling...',
  'Futzing...',
  'Schmalzing...',
  'Kerfuffling...',
  'Bamboozling...',
  'Discombobulating...',
  'Recombobulating...',
  'Unbefuddling...',
  'Defenestrating...',
  'Confabulating...',
  'Persnicketing...',
  'Flummoxing...',
  'Befuddling...',
  'Snorkeling...',
  'Yodeling...',
  'Zigzagging...',
  'Ricocheting...',
  'Somersaulting...',
  'Pirouetting...',
  'Canoodling...',
  'Schmoozing...',
  'Kibbitzing...',
  'Skedaddling...',
  'Scampering...',
  'Skittering...',
  'Sashaying...',
  'Swashbuckling...',
  'Oscillating...',
  'Undulating...',
  'Pulsating...',
  'Effervescing...',
  'Fizzing...',
  'Bubbling...',
  'Perplexing...',
  'Mystifying...',
  'Enchanting...',
  'Bewitching...',
  'Beguiling...',
  'Mesmerizing...',
  'Bedazzling...',
  'Sparkling...',
  'Glittering...',
  'Scintillating...',
  'Coruscating...',
  'Phosphorescing...',
  'Luminescing...',
  'Sublimating...',
  'Synthesizing...',
  'Amalgamating...',
  'Procrastinating...',
  'Dillydallying...',
  'Lollygagging...',
  'Dawdling...',
  'Malingering...',
  'Skulking...',
  'Lurking...',
  'Sleuthing...',
  'Rummaging...',
  'Fossicking...',
  'Foraging...',
  'Scavenging...',
  'Absquatulating...',
  'Vamoosing...',
  'Absconding...',
  'Grooving...',
  'Jamming...',
  'Improvising...',
  'Extemporizing...',
  'Freestyling...',
  'Frolicking...',
  'Gamboling...',
  'Blorping...',
  'Flonking...',
  'Snurfling...',
  'Whomping...',
  'Zorping...',
  'Biffing...',
  'Splunging...',
  'Thwacking...',
  'Gonkulating...',
  'Splorfing...',
  'Wibbling...',
  'Wobbling...',
  'Squonking...',
  'Plonking...',
  'Bonking...',
  'Zonking...',
  'Flumping...',
  'Clomping...',
  'Squelching...',
  'Schlurping...',
  'Glurping...',
  'Burbling...',
  'Gurgling...',
  'Splooshing...',
  'Whooshing...',
  'Swooshing...',
  'Kerplunking...',
  'Thunking...',
  'Clunking...',
  'Clanking...',
  'Rattling...',
  'Jostling...',
  'Rustling...',
  'Bustling...',
  'Hustling...',
  'Miffing...',
  'Boffing...',
  'Snazzifying...',
  'Pizzazzing...',
  'Razzmatazzing...',
  'Bedoodling...',
  'Doodling...',
  'Scribbling...',
  'Squiggling...',
  'Wriggling...',
  'Niggling...',
  'Higgling...',
  'Piggling...',
  'Figgling...',
  'Gibbering...',
  'Jabbering...',
  'Blathering...',
  'Blithering...',
  'Withering...',
  'Slithering...',
  'Tethering...',
  'Feathering...',
  'Weathering...',
  'Leathering...',
  'Heathering...',
  'Smoldering...',
  'Moldering...',
  'Shouldering...',
  'Bouldering...',
  'Tottering...',
  'Teetering...',
  'Tittering...',
  'Flittering...',
  'Jittering...',
  'Frittering...',
  'Twittering...',
  'Nattering...',
  'Chattering...',
  'Clattering...',
  'Splattering...',
  'Battering...',
  'Scattering...',
  'Shattering...',
  'Flattering...',
  'Pattering...',
  'Tattering...',
  'Mattering...',
  'Yammering...',
  'Hammering...',
  'Stammering...',
  'Clamoring...',
  'Glamoring...',
  'Enamoring...',
  'Shimmering...',
  'Glimmering...',
  'Brimming...',
  'Skimming...',
  'Trimming...',
  'Primming...',
  'Whimming...',
  'Humming...',
  'Strumming...',
  'Thrumming...',
  'Drumming...',
  'Plumbing...',
  'Thumbing...',
  'Numbing...',
  'Fumbling...',
  'Grumbling...',
  'Mumbling...',
  'Rumbling...',
  'Stumbling...',
  'Tumbling...',
  'Crumbling...',
  'Jumbling...',
  'Humbling...',
  'Bungling...',
  'Jungling...',
  'Mangling...',
  'Wangling...',
  'Dangling...',
  'Tangling...',
  'Jangling...',
  'Angling...',
  'Struggling...',
  'Mingling...',
  'Tingling...',
  'Jingling...',
  'Singling...',
  'Ringling...',
  'Kingling...',

  // Long
  'Consulting the void...',
  'Asking the electrons...',
  'Bribing the compiler...',
  'Negotiating with entropy...',
  'Whispering to the bits...',
  'Tickling the stack...',
  'Massaging the heap...',
  'Appeasing the garbage collector...',
  'Summoning semicolons...',
  'Herding pointers...',
  'Untangling spaghetti...',
  'Polishing the algorithms...',
  'Waxing philosophical...',
  'Consulting ancient scrolls...',
  'Reading tea leaves...',
  'Shaking the magic 8-ball...',
  'Sacrificing to the demo gods...',
  'Warming up the hamsters...',
  'Spinning up the squirrels...',
  'Caffeinating...',
  'Existentially questioning...',
  'Having a little think...',
  'Stroking chin thoughtfully...',
  'Squinting at the problem...',
  'Staring into the abyss...',
  'Abyss staring back...',
  'Achieving enlightenment...',
  'Transcending mere computation...',
  'Ascending to a higher plane...',
  'Communing with the machine spirit...',
  'Performing arcane rituals...',
  'Invoking elder functions...',
  'Consulting the oracle...',
  'Divining the answer...',
  'Scrying the codebase...',
  'Dowsing for bugs...',
  'Rearranging deck chairs...',
  'Shuffling bits around...',
  'Aligning the chakras...',
  'Reticulating splines...',
  'Reversing the polarity...',
  'Calibrating the flux capacitor...',
  'Charging the crystals...',
  'Tuning the vibrations...',
  'Adjusting the cosmic frequency...',
  'Waiting for a sign...',
  'Hoping for the best...',
  'Manifesting solutions...',
  'Willing it into existence...',
  'Believing really hard...',
  'Politely asking the CPU...',
  'Bribing the runtime...',
  'Flirting with the database...',
  'Sweet-talking the API...',
  'Negotiating with deadlines...',
  'Having words with the cache...',
  'Reasoning with the memory...',
  'Pleading with the logs...',
  'Bargaining with fate...',
  'Making offerings to the CI...',
  'Praying to the uptime gods...',
  'Consulting the rubber duck...',
  'Interrogating the stack trace...',
  'Cross-examining the debugger...',
  'Petitioning the kernel...',
  'Lobbying the scheduler...',
  'Schmoozing the network...',
  'Buttering up the firewall...',
  'Wining and dining the servers...',
  'Taking the bytes out for lunch...',
  'Giving the code a pep talk...',
  'Reading the room...',
  'Checking under the hood...',
  'Kicking the tires...',
  'Shaking loose the cobwebs...',
  'Dusting off the neurons...',
  'Greasing the gears...',
  'Oiling the cogs...',
  'Winding up the clockwork...',
  'Stoking the furnace...',
  'Feeding the machine...',
  'Watering the logic tree...',
  'Pruning the decision branches...',
  'Harvesting the outputs...',
  'Planting computational seeds...',
  'Nurturing the algorithm...',
  'Raising the exceptions...',
  'Taming wild pointers...',
  'Herding cats in memory...',
  'Teaching old code new tricks...',
  'Whispering sweet nothings to the compiler...',
  'Serenading the syntax...',
  'Dancing with dependencies...',
  'Waltzing through the codebase...',
  'Tangoing with type errors...',
  'Doing the deployment dance...',
  'Having a moment of clarity...',
  'Experiencing a flash of insight...',
  'Channeling the ancient developers...',
  'Receiving transmissions from the cloud...',
  'Asking the hamsters to run faster...',
  'Convincing the pixels to cooperate...',
  'Teaching electrons new tricks...',
  'Bribing the byte fairies...',
  'Whispering passwords to the void...',
  'Negotiating with cosmic rays...',
  'Flattering the floating points...',
  'Seducing the semicolons...',
  'Wooing the while loops...',
  'Charming the curly braces...',
  'Hypnotizing the hash tables...',
  'Mesmerizing the memory banks...',
  'Enchanting the error handlers...',
  'Bewitching the boolean logic...',
  'Spellbinding the stack frames...',
  'Hexing the hexadecimals...',
  'Jinxing the JSON parsers...',
  'Cursing the cache misses...',
  'Blessing the build process...',
  'Anointing the algorithms...',
  'Consecrating the callbacks...',
  'Sanctifying the source code...',
  'Exorcising the exceptions...',
  'Purifying the parameters...',
  'Cleansing the closures...',
  'Baptizing the binary...',
  'Absolving the abstractions...',
  'Redeeming the recursion...',
  'Forgiving the for loops...',
  'Pardoning the pointers...',
  'Liberating the lambdas...',
  'Emancipating the enums...',
  'Freeing the functions...',
  'Releasing the references...',
  'Unbinding the variables...',
  'Untying the type knots...',
  'Unraveling the regex...',
  'Decoding the mysteries...',
  'Cracking the conundrums...',
  'Solving the riddles of RAM...',
  'Unlocking the secrets of silicon...',
  'Discovering hidden semicolons...',
  'Unearthing buried bugs...',
  'Excavating ancient APIs...',
  'Archeologically analyzing the architecture...',
  'Fossil hunting in the functions...',
  'Spelunking through the stack...',
  'Scuba diving in the data...',
  'Snorkeling through the streams...',
  'Parasailing past the parameters...',
  'Hang gliding through the heap...',
  'Bungee jumping into the backend...',
  'Skydiving through the source...',
  'Surfing the syntax waves...',
  'Skateboarding down the stack trace...',
  'Snowboarding through the schemas...',
  'Mountain climbing the modules...',
  'Hiking through the headers...',
  'Trekking through the trees...',
  'Backpacking through the binaries...',
  'Camping in the codebase...',
  'Glamping in the globals...',
  'Picnicking with the processes...',
  'Barbecuing the bugs...',
  'Roasting the race conditions...',
  'Grilling the glitches...',
  'Sautéing the syntax errors...',
  'Flambéing the failures...',
  'Caramelizing the callbacks...',
  'Braising the breakpoints...',
  'Poaching the pointers...',
  'Blanching the branches...',
  'Searing the segments...',
  'Smoking the subroutines...',
  'Curing the code smells...',
  'Pickling the packages...',
  'Preserving the protocols...',
  'Canning the constants...',
  'Bottling the buffers...',
  'Jarring the JavaScript...',
  'Decanting the data structures...',
  'Aerating the arrays...',
  'Letting the logic breathe...',
  'Aging the algorithms gracefully...',
  'Maturing the methods...',
  'Ripening the results...',
  'Seasoning the solutions...',
  'Spicing up the specs...',
  'Garnishing the getters...',
  'Plating the output nicely...',
  'Presenting with pizzazz...',
  'Adding a dash of elegance...',
  'Sprinkling some magic dust...',
  'Drizzling debug sauce...',
  'Folding in the features...',
  'Whisking the widgets...',
  'Kneading the namespaces...',
  'Rolling out the runtime...',
  'Proofing the promises...',
  'Letting the dough rise...',
  'Baking at 350 kilobytes...',
  'Frosting the functions...',
  'Decorating the deployment...',
  'Icing the interfaces...',
  'Glazing the graphics...',
  'Topping with tests...',
  'Cherry-picking the commits...',
];

function pickRandom(): string {
  return messages[Math.floor(Math.random() * messages.length)];
}

/**
 * Minimum terminal width (in columns) required before the whimsical phrase is
 * shown. On narrower terminals (e.g. mobile SSH sessions, measured around 57
 * columns) the decorative phrase is dropped so the working line keeps the
 * useful suffix (timer, transport, base URL) without spilling onto a second
 * line. The 80-column default is the classic terminal width: it hides mobile
 * sessions while keeping the phrase wrap-free across realistic suffixes,
 * including a custom/proxy `via <host>` label. Override with the
 * `WHIMSICAL_MIN_COLUMNS` environment variable.
 */
export const DEFAULT_MIN_WHIMSY_COLUMNS = 80;

/**
 * Decide whether the whimsical phrase should be injected for the current
 * terminal width. When the width is unknown (non-interactive stdout, e.g. RPC
 * or print mode), the phrase is shown so behaviour matches earlier releases.
 */
export function shouldShowWhimsy(
  columns: number | undefined,
  minColumns: number = DEFAULT_MIN_WHIMSY_COLUMNS,
): boolean {
  if (columns === undefined || !Number.isFinite(columns) || columns <= 0) {
    return true;
  }

  return columns >= minColumns;
}

function resolveMinWhimsyColumns(): number {
  const raw = process.env.WHIMSICAL_MIN_COLUMNS;
  if (raw === undefined) {
    return DEFAULT_MIN_WHIMSY_COLUMNS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIN_WHIMSY_COLUMNS;
}

const DEFAULT_PROVIDER_BASE_URLS: Record<string, string[]> = {
  'amazon-bedrock': ['https://bedrock-runtime.us-east-1.amazonaws.com'],
  anthropic: ['https://api.anthropic.com'],
  cerebras: ['https://api.cerebras.ai/v1'],
  'github-copilot': ['https://api.individual.githubcopilot.com'],
  google: ['https://generativelanguage.googleapis.com/v1beta'],
  'google-vertex': ['https://{location}-aiplatform.googleapis.com'],
  groq: ['https://api.groq.com/openai/v1'],
  huggingface: ['https://router.huggingface.co/v1'],
  'kimi-coding': ['https://api.kimi.com/coding'],
  minimax: ['https://api.minimax.io/anthropic'],
  'minimax-cn': ['https://api.minimaxi.com/anthropic'],
  mistral: ['https://api.mistral.ai'],
  openai: ['https://api.openai.com/v1'],
  'openai-codex': ['https://chatgpt.com/backend-api'],
  opencode: ['https://opencode.ai/zen', 'https://opencode.ai/zen/v1'],
  'opencode-go': ['https://opencode.ai/zen/go', 'https://opencode.ai/zen/go/v1'],
  openrouter: ['https://openrouter.ai/api/v1'],
  'vercel-ai-gateway': ['https://ai-gateway.vercel.sh'],
  xai: ['https://api.x.ai/v1'],
  zai: ['https://api.z.ai/api/coding/paas/v4'],
};

const ASCII_CONTROL_CHARS_RE = /\p{Cc}/gu;

function stripAsciiControlChars(value: string): string {
  return value.replace(ASCII_CONTROL_CHARS_RE, '');
}

function redactUrlUserinfo(value: string): string {
  const schemeMatch = value.match(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)/);

  if (!schemeMatch) {
    return value;
  }

  const [fullMatch, scheme, authority] = schemeMatch;
  const atIndex = authority.lastIndexOf('@');

  if (atIndex === -1) {
    return value;
  }

  return `${scheme}${authority.slice(atIndex + 1)}${value.slice(fullMatch.length)}`;
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;

  try {
    const url = new URL(baseUrl);
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return `${url.origin}${path}`;
  } catch {
    return baseUrl;
  }
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function defaultBaseUrlPatternToRegex(pattern: string): RegExp {
  const normalizedPattern = normalizeBaseUrl(pattern) ?? pattern;
  const segments = normalizedPattern.split(/\{[^}]+\}/g).map(escapeRegexLiteral);
  const placeholderCount = Math.max(0, segments.length - 1);

  if (placeholderCount === 0) {
    return new RegExp(`^${segments[0]}$`);
  }

  const wildcard = '[A-Za-z0-9._-]+';
  let source = segments[0] ?? '';

  for (let index = 0; index < placeholderCount; index += 1) {
    source += wildcard;
    source += segments[index + 1] ?? '';
  }

  return new RegExp(`^${source}$`);
}

function isDefaultBaseUrl(provider: string | undefined, baseUrl: string): boolean {
  if (!provider) {
    return false;
  }

  const defaults = DEFAULT_PROVIDER_BASE_URLS[provider];
  if (!defaults || defaults.length === 0) {
    return false;
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return false;
  }

  return defaults.some((defaultUrl) => {
    const normalizedDefaultUrl = normalizeBaseUrl(defaultUrl) ?? defaultUrl;
    if (defaultUrl.includes('{')) {
      return defaultBaseUrlPatternToRegex(normalizedDefaultUrl).test(normalizedBaseUrl);
    }
    return normalizedDefaultUrl === normalizedBaseUrl;
  });
}

function formatModelTarget(model: Model<any> | undefined): string | undefined {
  if (!model) return undefined;
  return `${model.provider}/${model.id}`;
}

function shortenBaseUrlLabel(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const pathSegments = url.pathname.split('/').filter(Boolean);
    const host = url.host;

    if (pathSegments.length === 0) {
      return stripAsciiControlChars(host);
    }

    if (pathSegments.length <= 2) {
      return stripAsciiControlChars(`${host}/${pathSegments.join('/')}`);
    }

    return stripAsciiControlChars(`${host}/…/${pathSegments.slice(-2).join('/')}`);
  } catch {
    return stripAsciiControlChars(redactUrlUserinfo(baseUrl));
  }
}

function shortenWorkingMessageBaseUrlLabel(baseUrl: string): string {
  try {
    return stripAsciiControlChars(new URL(baseUrl).host);
  } catch {
    return stripAsciiControlChars(redactUrlUserinfo(baseUrl));
  }
}

function wrapHyperlink(url: string, label: string): string {
  try {
    const parsedUrl = new URL(url);

    if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
      return `]8;;${stripAsciiControlChars(url)}${stripAsciiControlChars(label)}]8;;`;
    }

    return stripAsciiControlChars(label);
  } catch {
    return stripAsciiControlChars(label);
  }
}

interface CustomBaseUrlDisplay {
  fullUrl: string;
  statusLabel: string;
  workingLabel: string;
}

type StatusUIContext = {
  hasUI: boolean;
  ui: {
    setWorkingMessage(message?: string): void;
    setStatus(key: string, text: string | undefined): void;
    theme: {
      fg(tone: string, text: string): string;
    };
  };
};

type AssistantErrorLikeMessage = {
  role: string;
  stopReason?: string;
  errorMessage?: string;
};

const STATUS_KEY = 'whimsical';
const LONG_RUN_STATUS_THRESHOLD_MS = 30_000;
export type EffectiveTransportKind = 'ws' | 'sse';

export interface EffectiveTransport {
  kind: EffectiveTransportKind;
  connectionId?: string;
  cacheStatus?: string;
  requestUrl?: string;
}

export type EffectiveTransportInput = EffectiveTransportKind | EffectiveTransport;

export interface WorkingMessageState {
  turnCount: number;
  toolCount: number;
  lastModelTarget: string | undefined;
  lastCustomBaseUrl: CustomBaseUrlDisplay | undefined;
  lastTransport: EffectiveTransport | undefined;
}

export function createWorkingMessageState(): WorkingMessageState {
  return {
    turnCount: 0,
    toolCount: 0,
    lastModelTarget: undefined,
    lastCustomBaseUrl: undefined,
    lastTransport: undefined,
  };
}

export function recordTurnStart(state: WorkingMessageState): WorkingMessageState {
  return {
    ...state,
    turnCount: state.turnCount + 1,
  };
}

export function recordToolExecutionStart(state: WorkingMessageState): WorkingMessageState {
  return {
    ...state,
    toolCount: state.toolCount + 1,
  };
}

function customBaseUrlDisplay(baseUrl: string): CustomBaseUrlDisplay {
  return {
    fullUrl: normalizeBaseUrl(baseUrl) ?? baseUrl,
    statusLabel: shortenBaseUrlLabel(baseUrl),
    workingLabel: shortenWorkingMessageBaseUrlLabel(baseUrl),
  };
}

function getModelDisplayMetadata(model: Model<any> | undefined): {
  modelTarget: string | undefined;
  customBaseUrl: CustomBaseUrlDisplay | undefined;
} {
  const hasCustomBaseUrl = model?.baseUrl && !isDefaultBaseUrl(model.provider, model.baseUrl);

  return {
    modelTarget: formatModelTarget(model),
    customBaseUrl: hasCustomBaseUrl ? customBaseUrlDisplay(model.baseUrl) : undefined,
  };
}

export function recordProviderRequest(
  state: WorkingMessageState,
  model: Model<any> | undefined,
): WorkingMessageState {
  if (!model) {
    return state;
  }

  const { modelTarget, customBaseUrl } = getModelDisplayMetadata(model);
  return {
    turnCount: state.turnCount,
    toolCount: state.toolCount,
    lastModelTarget: modelTarget,
    lastCustomBaseUrl: customBaseUrl,
    lastTransport: undefined,
  };
}

function normalizeTransport(transport: EffectiveTransportInput): EffectiveTransport {
  return typeof transport === 'string' ? { kind: transport } : transport;
}

export function recordProviderTransport(
  state: WorkingMessageState,
  transport: EffectiveTransportInput,
): WorkingMessageState {
  const normalizedTransport = normalizeTransport(transport);
  return {
    ...state,
    lastCustomBaseUrl: normalizedTransport.requestUrl
      ? customBaseUrlDisplay(normalizedTransport.requestUrl)
      : state.lastCustomBaseUrl,
    lastTransport: normalizedTransport,
  };
}

function formatElapsedLabel(elapsedMs: number | undefined): string | undefined {
  if (elapsedMs === undefined || elapsedMs < 1_000) {
    return undefined;
  }

  const roundedTenths = Math.round(elapsedMs / 100);
  if (roundedTenths < 600) {
    return `${(roundedTenths / 10).toFixed(1)}s`;
  }

  const roundedSeconds = Math.round(elapsedMs / 1_000);
  const hours = Math.floor(roundedSeconds / 3_600);
  const minutes = Math.floor((roundedSeconds % 3_600) / 60);
  const seconds = roundedSeconds % 60;

  if (hours > 0) {
    return `${hours}h${minutes}m${seconds}s`;
  }

  return `${Math.floor(roundedSeconds / 60)}m${seconds}s`;
}

function formatBaseUrlLabel(
  customBaseUrl: CustomBaseUrlDisplay | undefined,
  clickable: boolean,
  variant: 'status' | 'working',
): string | undefined {
  if (!customBaseUrl) {
    return undefined;
  }

  const label = variant === 'working' ? customBaseUrl.workingLabel : customBaseUrl.statusLabel;
  return clickable ? wrapHyperlink(customBaseUrl.fullUrl, label) : label;
}

function responseHeader(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

export function classifyHttpTransport(
  headers: Record<string, string>,
  status?: number,
): EffectiveTransport | undefined {
  const connectionId = responseHeader(headers, 'x-pi-connection-id');
  const cacheStatus = responseHeader(headers, 'x-pi-connection-cache-status');
  const requestUrl = responseHeader(headers, 'x-pi-request-url');
  const connection = responseHeader(headers, 'connection')?.toLowerCase();
  const upgrade = responseHeader(headers, 'upgrade')?.toLowerCase();
  if (upgrade === 'websocket' || (status === 101 && connection?.includes('upgrade'))) {
    return { kind: 'ws', connectionId, cacheStatus, requestUrl };
  }

  const contentType = responseHeader(headers, 'content-type');
  if (contentType?.toLowerCase().includes('text/event-stream')) {
    return { kind: 'sse', connectionId, cacheStatus, requestUrl };
  }

  return undefined;
}

function formatCacheStatusHint(status: string | undefined): string | undefined {
  if (status === 'miss' || status === 'stale') return 'new';
  if (status === 'busy') return 'extra';
  return undefined;
}

function formatConnectionId(kind: EffectiveTransportKind, connectionId: string): string {
  const prefix = `${kind}#`;
  if (connectionId.toLowerCase().startsWith(prefix)) {
    return `${kind.toUpperCase()}#${connectionId.slice(prefix.length)}`;
  }
  return `${kind.toUpperCase()} ${connectionId}`;
}

function formatTransportLabel(transport: EffectiveTransport | undefined): string | undefined {
  if (!transport) {
    return undefined;
  }

  const kind = transport.kind.toUpperCase();
  if (!transport.connectionId) return kind;

  const connectionLabel = formatConnectionId(transport.kind, transport.connectionId);
  const statusHint = formatCacheStatusHint(transport.cacheStatus);
  return statusHint ? `${connectionLabel} (${statusHint})` : connectionLabel;
}

function formatTransportViaLabel(
  state: WorkingMessageState,
  clickable: boolean,
  variant: 'status' | 'working',
): string | undefined {
  const transportLabel = formatTransportLabel(state.lastTransport);
  const baseUrlLabel = formatBaseUrlLabel(state.lastCustomBaseUrl, clickable, variant);

  if (transportLabel && baseUrlLabel) {
    return `${transportLabel} via ${baseUrlLabel}`;
  }

  return transportLabel ?? (baseUrlLabel ? `via ${baseUrlLabel}` : undefined);
}

function formatWorkingMessageMetrics(state: WorkingMessageState): string | undefined {
  const metrics = [
    state.turnCount > 1 ? `↺${state.turnCount}` : undefined,
    state.toolCount > 0 ? `⚒${state.toolCount}` : undefined,
  ].filter((value): value is string => Boolean(value));

  return metrics.length > 0 ? metrics.join(' ') : undefined;
}

function getFinalAssistantErrorLabel(messages: AssistantErrorLikeMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') {
      continue;
    }

    if (message.stopReason !== 'error') {
      return undefined;
    }

    const errorMessage = message.errorMessage ?? '';
    const code = errorMessage.match(/\b([45]\d{2})\b/)?.[1];
    if (code) {
      return `${code} Error`;
    }

    if (/server(?: had)? an error|server error/i.test(errorMessage)) {
      return 'Server Error';
    }

    return 'Error';
  }

  return undefined;
}

function buildCompletionStatus(
  state: WorkingMessageState,
  elapsedMs: number | undefined,
  errorLabel?: string,
): string | undefined {
  if (
    !errorLabel &&
    (state.turnCount <= 1 || elapsedMs === undefined || elapsedMs < LONG_RUN_STATUS_THRESHOLD_MS)
  ) {
    return undefined;
  }

  const elapsedLabel = formatElapsedLabel(elapsedMs);
  const transportViaLabel = formatTransportViaLabel(state, false, 'working');
  const metricsLabel = formatWorkingMessageMetrics(state);

  return [
    errorLabel ? `× ${errorLabel}` : '✓ Completed',
    metricsLabel,
    elapsedLabel ? `in ${elapsedLabel}` : undefined,
    transportViaLabel,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

export function buildWorkingMessage(
  whimsy: string | undefined,
  state: WorkingMessageState,
  elapsedMs?: number,
): string {
  const elapsedLabel = formatElapsedLabel(elapsedMs);
  const parts = [
    formatWorkingMessageMetrics(state),
    elapsedLabel,
    formatTransportViaLabel(state, true, 'working'),
  ].filter((value): value is string => Boolean(value));

  const suffix = parts.length > 0 ? parts.join(' · ') : undefined;

  if (whimsy && suffix) {
    return `${whimsy} · ${suffix}`;
  }

  return whimsy ?? suffix ?? '';
}

export default function (pi: ExtensionAPI) {
  let currentWhimsy: string | undefined;
  let workingMessageState = createWorkingMessageState();
  let agentStartedAt: number | undefined;
  let workingMessageTicker: ReturnType<typeof setInterval> | undefined;
  let lastWorkingMessage: string | undefined;
  let lastStatusText: string | undefined;
  let lastUiCtx: StatusUIContext | undefined;
  let workingMessageCtx: StatusUIContext | undefined;
  const minWhimsyColumns = resolveMinWhimsyColumns();

  const getElapsedMs = (): number | undefined => {
    if (agentStartedAt === undefined) {
      return undefined;
    }

    return Math.max(0, Date.now() - agentStartedAt);
  };

  const clearTicker = (): void => {
    if (workingMessageTicker !== undefined) {
      clearInterval(workingMessageTicker);
      workingMessageTicker = undefined;
    }
    workingMessageCtx = undefined;
  };

  const clearStatus = (ctx?: StatusUIContext): void => {
    const targetCtx = ctx ?? lastUiCtx;
    if (!targetCtx?.hasUI || lastStatusText === undefined) {
      return;
    }

    lastStatusText = undefined;
    targetCtx.ui.setStatus(STATUS_KEY, undefined);
  };

  const setStatus = (ctx: StatusUIContext, text: string | undefined): void => {
    if (!ctx.hasUI) {
      return;
    }

    lastUiCtx = ctx;

    if (text === undefined) {
      clearStatus(ctx);
      return;
    }

    lastStatusText = text;

    const theme = ctx.ui.theme;
    const colorized = text
      .replace(/^✓ Completed/, (_match) => theme.fg('success', '✓ Completed'))
      .replace(/^×\s+.+?(?=\s+(?:↺\d+|⚒\d+|in\s|via\s)|$)/, (label: string) =>
        theme.fg('error', label),
      )
      .replace(/\bin\s+([0-9][^ ]*)/, (_match, elapsed: string) => {
        return `${theme.fg('dim', 'in')} ${theme.fg('accent', elapsed)}`;
      })
      .replace(
        /((?:(?:WS|SSE)(?:#[^\s]+)?(?:\s+\([^)]*\))?\s+)?via\s+.+)$/,
        (_match, via: string) => theme.fg('muted', via),
      );

    ctx.ui.setStatus(STATUS_KEY, colorized);
  };

  const updateWorkingMessage = (ctx: StatusUIContext): void => {
    workingMessageCtx = ctx;

    if (!ctx.hasUI || !currentWhimsy) {
      return;
    }

    lastUiCtx = ctx;

    const whimsy = shouldShowWhimsy(process.stdout.columns, minWhimsyColumns)
      ? currentWhimsy
      : undefined;
    const message = buildWorkingMessage(whimsy, workingMessageState, getElapsedMs());
    if (message === lastWorkingMessage) {
      return;
    }

    lastWorkingMessage = message;
    ctx.ui.setWorkingMessage(message);
  };

  const ensureTicker = (): void => {
    if (workingMessageTicker !== undefined) {
      return;
    }

    workingMessageTicker = setInterval(() => {
      if (!workingMessageCtx || !currentWhimsy) {
        return;
      }

      updateWorkingMessage(workingMessageCtx);
    }, 100);
  };

  const recordObservedTransport = (ctx: StatusUIContext, transport: EffectiveTransport): void => {
    workingMessageState = recordProviderTransport(workingMessageState, transport);
    updateWorkingMessage(ctx);
  };

  const clearState = (): void => {
    clearTicker();
    currentWhimsy = undefined;
    workingMessageState = createWorkingMessageState();
    agentStartedAt = undefined;
    lastWorkingMessage = undefined;
  };

  const resetWorkingMessage = (ctx?: StatusUIContext): void => {
    const targetCtx = ctx ?? lastUiCtx;
    clearState();
    if (targetCtx?.hasUI) {
      targetCtx.ui.setWorkingMessage();
    }
  };

  // Whimsical only drives the working-message spinner and status line;
  // every handler is a no-op in print/RPC mode (hasUI === false).
  pi.on('before_agent_start', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    clearStatus(ctx);
  });

  pi.on('agent_start', async (_event, ctx) => {
    if (!ctx.hasUI) {
      resetWorkingMessage();
      clearStatus();
      lastUiCtx = undefined;
      return;
    }
    lastUiCtx = ctx;
    clearStatus(ctx);
    clearState();
    agentStartedAt = Date.now();
    workingMessageCtx = ctx;
    ensureTicker();
  });

  pi.on('turn_start', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    currentWhimsy = pickRandom();
    workingMessageState = recordTurnStart(workingMessageState);
    updateWorkingMessage(ctx);
  });

  pi.on('before_provider_request', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    workingMessageState = recordProviderRequest(workingMessageState, ctx.model);
    updateWorkingMessage(ctx);
  });

  pi.on('after_provider_response', async (event, ctx) => {
    if (!ctx.hasUI) return;
    const transport = classifyHttpTransport(event.headers, event.status);
    if (!transport) return;
    recordObservedTransport(ctx, transport);
  });

  pi.on('tool_execution_start', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    workingMessageState = recordToolExecutionStart(workingMessageState);
    updateWorkingMessage(ctx);
  });

  pi.on('agent_end', async (event, ctx) => {
    if (!ctx.hasUI) return;
    const statusText = buildCompletionStatus(
      workingMessageState,
      getElapsedMs(),
      getFinalAssistantErrorLabel(event.messages as AssistantErrorLikeMessage[]),
    );
    resetWorkingMessage(ctx);
    if (statusText) {
      setStatus(ctx, statusText);
    } else {
      clearStatus(ctx);
    }
  });

  pi.on('session_start', async (_event, ctx) => {
    if (!ctx.hasUI) {
      resetWorkingMessage();
      clearStatus();
      lastUiCtx = undefined;
      return;
    }
    if (lastUiCtx && lastUiCtx !== ctx) {
      resetWorkingMessage(lastUiCtx);
      clearStatus(lastUiCtx);
    }
    lastUiCtx = ctx;
    resetWorkingMessage(ctx);
    clearStatus(ctx);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    const targetCtx = ctx.hasUI ? ctx : lastUiCtx;
    resetWorkingMessage(targetCtx);
    clearStatus(targetCtx);
    lastUiCtx = undefined;
  });
}
