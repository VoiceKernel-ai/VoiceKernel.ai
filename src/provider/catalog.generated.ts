// ---------------------------------------------------------------------------
// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: vendor/provider-openapi.json
// Regenerate: npm run gen:provider
//
// The provider matrix VoiceKernel exposes for model switching.
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  /** Value sent to the voice provider as `provider`. */
  provider: string;
  /** Human label for the console. */
  label: string;
  /** Known values; empty means the provider accepts any string. */
  options: readonly string[];
  /** Whether a custom value outside `options` is also accepted. */
  freeform: boolean;
}

export const LLM_PROVIDERS: readonly CatalogEntry[] = [
  {
    provider: "anthropic",
    label: "Anthropic",
    options: ["claude-3-opus-20240229","claude-3-sonnet-20240229","claude-3-haiku-20240307","claude-3-5-sonnet-20240620","claude-3-5-sonnet-20241022","claude-3-5-haiku-20241022","claude-3-7-sonnet-20250219","claude-opus-4-20250514","claude-opus-4-5-20251101","claude-opus-4-6","claude-sonnet-4-20250514","claude-sonnet-4-5-20250929","claude-sonnet-4-6","claude-sonnet-5","claude-haiku-4-5-20251001"],
    freeform: false,
  },
  {
    provider: "anthropic-bedrock",
    label: "Anthropic Bedrock",
    options: ["claude-3-opus-20240229","claude-3-sonnet-20240229","claude-3-haiku-20240307","claude-3-5-sonnet-20240620","claude-3-5-sonnet-20241022","claude-3-5-haiku-20241022","claude-3-7-sonnet-20250219","claude-opus-4-20250514","claude-opus-4-5-20251101","claude-opus-4-6","claude-sonnet-4-20250514","claude-sonnet-4-5-20250929","claude-sonnet-4-6","claude-haiku-4-5-20251001","global.anthropic.claude-haiku-4-5-20251001-v1:0"],
    freeform: false,
  },
  {
    provider: "anyscale",
    label: "Anyscale",
    options: [],
    freeform: false,
  },
  {
    provider: "cerebras",
    label: "Cerebras",
    options: ["llama3.1-8b","llama-3.3-70b"],
    freeform: false,
  },
  {
    provider: "custom-llm",
    label: "Custom LLM",
    options: [],
    freeform: false,
  },
  {
    provider: "deep-seek",
    label: "Deep Seek",
    options: ["deepseek-chat","deepseek-reasoner"],
    freeform: false,
  },
  {
    provider: "deepinfra",
    label: "Deep Infra",
    options: [],
    freeform: false,
  },
  {
    provider: "google",
    label: "Google",
    options: ["gemini-3.5-flash","gemini-3.1-flash-lite","gemini-3-flash-preview","gemini-2.5-pro","gemini-2.5-flash","gemini-2.5-flash-lite","gemini-2.0-flash-thinking-exp","gemini-2.0-pro-exp-02-05","gemini-2.0-flash","gemini-2.0-flash-lite","gemini-2.0-flash-exp","gemini-2.0-flash-realtime-exp","gemini-1.5-flash","gemini-1.5-flash-002","gemini-1.5-pro","gemini-1.5-pro-002","gemini-1.0-pro"],
    freeform: false,
  },
  {
    provider: "groq",
    label: "Groq",
    options: ["openai/gpt-oss-20b","openai/gpt-oss-120b","deepseek-r1-distill-llama-70b","llama-3.3-70b-versatile","llama-3.1-405b-reasoning","llama-3.1-8b-instant","llama3-8b-8192","llama3-70b-8192","gemma2-9b-it","moonshotai/kimi-k2-instruct-0905","meta-llama/llama-4-scout-17b-16e-instruct","mistral-saba-24b","compound-beta","compound-beta-mini"],
    freeform: false,
  },
  {
    provider: "inflection-ai",
    label: "Inflection AI",
    options: ["inflection_3_pi"],
    freeform: false,
  },
  {
    provider: "minimax",
    label: "Minimax LLM",
    options: ["MiniMax-M2.7"],
    freeform: false,
  },
  {
    provider: "openai",
    label: "Open AI",
    options: ["gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","gpt-5.5","chat-latest","gpt-5.4","gpt-5.4-mini","gpt-5.4-nano","gpt-5.2","gpt-5.2-chat-latest","gpt-5.1","gpt-5.1-chat-latest","gpt-5","gpt-5-chat-latest","gpt-5-mini","gpt-5-nano","gpt-4.1-2025-04-14","gpt-4.1-mini-2025-04-14","gpt-4.1-nano-2025-04-14","gpt-4.1","gpt-4.1-mini","gpt-4.1-nano","chatgpt-4o-latest","o3","o3-mini","o4-mini","o1-mini","o1-mini-2024-09-12","gpt-4o-realtime-preview-2024-10-01","gpt-4o-realtime-preview-2024-12-17","gpt-4o-mini-realtime-preview-2024-12-17","gpt-realtime-2025-08-28","gpt-realtime-mini-2025-12-15","gpt-realtime-2","gpt-4o-mini-2024-07-18","gpt-4o-mini","gpt-4o","gpt-4o-2024-05-13","gpt-4o-2024-08-06","gpt-4o-2024-11-20","gpt-4-turbo","gpt-4-turbo-2024-04-09","gpt-4-turbo-preview","gpt-4-0125-preview","gpt-4-1106-preview","gpt-4","gpt-4-0613","gpt-3.5-turbo","gpt-3.5-turbo-0125","gpt-3.5-turbo-1106","gpt-3.5-turbo-16k","gpt-3.5-turbo-0613","gpt-4.1-2025-04-14:westus","gpt-4.1-2025-04-14:eastus2","gpt-4.1-2025-04-14:eastus","gpt-4.1-2025-04-14:westus3","gpt-4.1-2025-04-14:northcentralus","gpt-4.1-2025-04-14:southcentralus","gpt-4.1-2025-04-14:westeurope","gpt-4.1-2025-04-14:germanywestcentral","gpt-4.1-2025-04-14:polandcentral","gpt-4.1-2025-04-14:spaincentral","gpt-4.1-mini-2025-04-14:westus","gpt-4.1-mini-2025-04-14:eastus2","gpt-4.1-mini-2025-04-14:eastus","gpt-4.1-mini-2025-04-14:westus3","gpt-4.1-mini-2025-04-14:northcentralus","gpt-4.1-mini-2025-04-14:southcentralus","gpt-4.1-mini-2025-04-14:westeurope","gpt-4.1-mini-2025-04-14:germanywestcentral","gpt-4.1-mini-2025-04-14:polandcentral","gpt-4.1-mini-2025-04-14:spaincentral","gpt-4.1-nano-2025-04-14:westus","gpt-4.1-nano-2025-04-14:eastus2","gpt-4.1-nano-2025-04-14:westus3","gpt-4.1-nano-2025-04-14:northcentralus","gpt-4.1-nano-2025-04-14:southcentralus","gpt-4o-2024-11-20:swedencentral","gpt-4o-2024-11-20:westus","gpt-4o-2024-11-20:eastus2","gpt-4o-2024-11-20:eastus","gpt-4o-2024-11-20:westus3","gpt-4o-2024-11-20:southcentralus","gpt-4o-2024-11-20:westeurope","gpt-4o-2024-11-20:germanywestcentral","gpt-4o-2024-11-20:polandcentral","gpt-4o-2024-11-20:spaincentral","gpt-4o-2024-08-06:westus","gpt-4o-2024-08-06:westus3","gpt-4o-2024-08-06:eastus","gpt-4o-2024-08-06:eastus2","gpt-4o-2024-08-06:northcentralus","gpt-4o-2024-08-06:southcentralus","gpt-4o-mini-2024-07-18:westus","gpt-4o-mini-2024-07-18:westus3","gpt-4o-mini-2024-07-18:eastus","gpt-4o-mini-2024-07-18:eastus2","gpt-4o-mini-2024-07-18:northcentralus","gpt-4o-mini-2024-07-18:southcentralus","gpt-4o-2024-05-13:eastus2","gpt-4o-2024-05-13:eastus","gpt-4o-2024-05-13:northcentralus","gpt-4o-2024-05-13:southcentralus","gpt-4o-2024-05-13:westus3","gpt-4o-2024-05-13:westus","gpt-4-turbo-2024-04-09:eastus2","gpt-4-0125-preview:eastus","gpt-4-0125-preview:northcentralus","gpt-4-0125-preview:southcentralus","gpt-4-1106-preview:australiaeast","gpt-4-1106-preview:canadaeast","gpt-4-1106-preview:france","gpt-4-1106-preview:india","gpt-4-1106-preview:norway","gpt-4-1106-preview:swedencentral","gpt-4-1106-preview:uk","gpt-4-1106-preview:westus","gpt-4-1106-preview:westus3","gpt-4-0613:canadaeast","gpt-3.5-turbo-0125:canadaeast","gpt-3.5-turbo-0125:northcentralus","gpt-3.5-turbo-0125:southcentralus","gpt-3.5-turbo-1106:canadaeast","gpt-3.5-turbo-1106:westus","gpt-4.1:australiaeast","gpt-4o:australiaeast","gpt-5.4-mini:australiaeast"],
    freeform: false,
  },
  {
    provider: "openrouter",
    label: "Open Router",
    options: [],
    freeform: false,
  },
  {
    provider: "perplexity-ai",
    label: "Perplexity AI",
    options: [],
    freeform: false,
  },
  {
    provider: "together-ai",
    label: "Together AI",
    options: [],
    freeform: false,
  },
  {
    provider: "voicekernel",
    label: "VoiceKernel",
    options: [],
    freeform: false,
  },
  {
    provider: "xai",
    label: "Xai",
    options: ["grok-beta","grok-2","grok-3","grok-4-fast-reasoning","grok-4-fast-non-reasoning","grok-4.20-0309-reasoning","grok-4.20-0309-non-reasoning","grok-4.3"],
    freeform: false,
  },
];

export const VOICE_PROVIDERS: readonly CatalogEntry[] = [
  {
    provider: "11labs",
    label: "Eleven Labs",
    options: ["burt","marissa","andrea","sarah","phillip","steve","joseph","myra","paula","ryan","drew","paul","mrb","matilda","mark"],
    freeform: true,
  },
  {
    provider: "azure",
    label: "Azure",
    options: ["andrew","brian","emma"],
    freeform: true,
  },
  {
    provider: "cartesia",
    label: "Cartesia",
    options: [],
    freeform: false,
  },
  {
    provider: "custom-voice",
    label: "Custom",
    options: [],
    freeform: false,
  },
  {
    provider: "deepgram",
    label: "Deepgram",
    options: ["asteria","luna","stella","athena","hera","orion","arcas","perseus","angus","orpheus","helios","zeus","thalia","andromeda","helena","apollo","arcas","aries","amalthea","asteria","athena","atlas","aurora","callista","cora","cordelia","delia","draco","electra","harmonia","hera","hermes","hyperion","iris","janus","juno","jupiter","luna","mars","minerva","neptune","odysseus","ophelia","orion","orpheus","pandora","phoebe","pluto","saturn","selene","theia","vesta","zeus","celeste","estrella","nestor","sirio","carina","alvaro","diana","aquila","selena","javier","viktoria","kara","fabian","julius","lara","elara","aurelia"],
    freeform: false,
  },
  {
    provider: "hume",
    label: "Hume",
    options: [],
    freeform: false,
  },
  {
    provider: "inworld",
    label: "Inworld",
    options: ["Alex","Ashley","Craig","Deborah","Dennis","Edward","Elizabeth","Hades","Julia","Pixie","Mark","Olivia","Priya","Ronald","Sarah","Shaun","Theodore","Timothy","Wendy","Dominus","Hana","Clive","Carter","Blake","Luna","Yichen","Xiaoyin","Xinyi","Jing","Erik","Katrien","Lennart","Lore","Alain","Hélène","Mathieu","Étienne","Johanna","Josef","Gianni","Orietta","Asuka","Satoshi","Hyunwoo","Minji","Seojun","Yoona","Szymon","Wojciech","Heitor","Maitê","Diego","Lupita","Miguel","Rafael","Svetlana","Elena","Dmitry","Nikolai","Riya","Manoj","Yael","Oren","Nour","Omar"],
    freeform: false,
  },
  {
    provider: "lmnt",
    label: "LMNT",
    options: ["amy","ansel","autumn","ava","brandon","caleb","cassian","chloe","dalton","daniel","dustin","elowen","evander","huxley","james","juniper","kennedy","lauren","leah","lily","lucas","magnus","miles","morgan","natalie","nathan","noah","nyssa","oliver","paige","ryan","sadie","sophie","stella","terrence","tyler","vesper","violet","warrick","zain","zeke","zoe"],
    freeform: true,
  },
  {
    provider: "microsoft",
    label: "Microsoft",
    options: ["de-DE-Klaus:MAI-Voice-2","de-DE-Mia:MAI-Voice-2","en-AU-Lisa:MAI-Voice-2","en-US-Ethan:MAI-Voice-2","en-US-Grant:MAI-Voice-2","en-US-Harper:MAI-Voice-2","en-US-Iris:MAI-Voice-2","en-US-Jasper:MAI-Voice-2","en-US-Olivia:MAI-Voice-2","es-ES-Marta:MAI-Voice-2","es-MX-Alejo:MAI-Voice-2","es-MX-Valeria:MAI-Voice-2","fr-FR-Marc:MAI-Voice-2","fr-FR-Soleil:MAI-Voice-2","hi-IN-Arjun:MAI-Voice-2","hi-IN-Dhruv:MAI-Voice-2","hi-IN-Kavya:MAI-Voice-2","hi-IN-Priya:MAI-Voice-2","hu-HU-Bence:MAI-Voice-2","hu-HU-Levente:MAI-Voice-2","hu-HU-Lilla:MAI-Voice-2","hu-HU-Réka:MAI-Voice-2","it-IT-Luca:MAI-Voice-2","it-IT-Rosa:MAI-Voice-2","ko-KR-Hana:MAI-Voice-2","ko-KR-Junho:MAI-Voice-2","nl-NL-Fleur:MAI-Voice-2","nl-NL-Sander:MAI-Voice-2","pt-BR-Caio:MAI-Voice-2","pt-BR-Luana:MAI-Voice-2","pt-BR-Pedro:MAI-Voice-2","pt-BR-Rafael:MAI-Voice-2","pt-PT-Rui:MAI-Voice-2","ro-RO-Andrei:MAI-Voice-2","ro-RO-Elena:MAI-Voice-2","ro-RO-Ioana:MAI-Voice-2","ro-RO-Radu:MAI-Voice-2","ru-RU-Lev:MAI-Voice-2","ru-RU-Masha:MAI-Voice-2","th-TH-Krit:MAI-Voice-2","th-TH-Nattapong:MAI-Voice-2","tr-TR-Aydin:MAI-Voice-2","tr-TR-Elif:MAI-Voice-2","zh-CN-Bo:MAI-Voice-2","zh-CN-Lan:MAI-Voice-2","zh-CN-Mei:MAI-Voice-2"],
    freeform: false,
  },
  {
    provider: "minimax",
    label: "Minimax",
    options: [],
    freeform: false,
  },
  {
    provider: "neuphonic",
    label: "Neuphonic",
    options: [],
    freeform: true,
  },
  {
    provider: "openai",
    label: "Open AI",
    options: ["alloy","echo","fable","onyx","nova","shimmer","marin","cedar"],
    freeform: true,
  },
  {
    provider: "playht",
    label: "Play HT",
    options: ["jennifer","melissa","will","chris","matt","jack","ruby","davis","donna","michael"],
    freeform: true,
  },
  {
    provider: "rime-ai",
    label: "Rime AI",
    options: ["cove","moon","wildflower","eva","amber","maya","lagoon","breeze","helen","joy","marsh","creek","cedar","alpine","summit","nicholas","tyler","colin","hank","thunder","astra","eucalyptus","moraine","peak","tundra","mesa_extra","talon","marlu","glacier","falcon","luna","celeste","estelle","andromeda","esther","lyra","lintel","oculus","vespera","transom","bond","arcade","atrium","cupola","fern","sirius","orion","masonry","albion","parapet"],
    freeform: true,
  },
  {
    provider: "sesame",
    label: "Sesame",
    options: [],
    freeform: false,
  },
  {
    provider: "smallest-ai",
    label: "Smallest AI",
    options: ["emily","jasmine","arman","james","mithali","aravind","raj","diya","raman","ananya","isha","william","aarav","monika","niharika","deepika","raghav","kajal","radhika","mansi","nisha","saurabh","pooja","saina","sanya"],
    freeform: true,
  },
  {
    provider: "tavus",
    label: "Tavus",
    options: ["r52da2535a"],
    freeform: true,
  },
  {
    provider: "voicekernel",
    label: "VoiceKernel",
    options: ["Clara","Godfrey","Elliot","Savannah","Nico","Kai","Emma","Sagar","Neil","Layla","Sid","Gustavo","Kylie","Rohan","Lily","Hana","Neha","Cole","Harry","Paige","Spencer","Naina","Leah","Tara","Jess","Leo","Dan","Mia","Zac","Zoe"],
    freeform: false,
  },
  {
    provider: "wellsaid",
    label: "Well Said",
    options: [],
    freeform: false,
  },
  {
    provider: "xai",
    label: "Xai",
    options: ["eve","ara","rex","sal","leo"],
    freeform: false,
  },
];

export const TRANSCRIBER_PROVIDERS: readonly CatalogEntry[] = [
  {
    provider: "11labs",
    label: "Eleven Labs",
    options: ["scribe_v1","scribe_v2","scribe_v2_realtime"],
    freeform: false,
  },
  {
    provider: "assembly-ai",
    label: "Assembly AI",
    options: [],
    freeform: false,
  },
  {
    provider: "azure",
    label: "Azure Speech",
    options: [],
    freeform: false,
  },
  {
    provider: "cartesia",
    label: "Cartesia",
    options: ["ink-whisper","ink-2"],
    freeform: false,
  },
  {
    provider: "custom-transcriber",
    label: "Custom",
    options: [],
    freeform: false,
  },
  {
    provider: "deepgram",
    label: "Deepgram",
    options: ["nova-3","nova-3-general","nova-3-medical","nova-2","nova-2-general","nova-2-meeting","nova-2-phonecall","nova-2-finance","nova-2-conversationalai","nova-2-voicemail","nova-2-video","nova-2-medical","nova-2-drivethru","nova-2-automotive","nova","nova-general","nova-phonecall","nova-medical","enhanced","enhanced-general","enhanced-meeting","enhanced-phonecall","enhanced-finance","base","base-general","base-meeting","base-phonecall","base-finance","base-conversationalai","base-voicemail","base-video","whisper","flux-general-en","flux-general-multi"],
    freeform: true,
  },
  {
    provider: "gladia",
    label: "Gladia",
    options: ["fast","accurate","solaria-1"],
    freeform: false,
  },
  {
    provider: "google",
    label: "Google",
    options: ["gemini-3.5-flash","gemini-3.1-flash-lite","gemini-3-flash-preview","gemini-2.5-pro","gemini-2.5-flash","gemini-2.5-flash-lite","gemini-2.0-flash-thinking-exp","gemini-2.0-pro-exp-02-05","gemini-2.0-flash","gemini-2.0-flash-lite","gemini-2.0-flash-exp","gemini-2.0-flash-realtime-exp","gemini-1.5-flash","gemini-1.5-flash-002","gemini-1.5-pro","gemini-1.5-pro-002","gemini-1.0-pro"],
    freeform: false,
  },
  {
    provider: "openai",
    label: "Open AI",
    options: ["gpt-4o-transcribe","gpt-4o-mini-transcribe"],
    freeform: false,
  },
  {
    provider: "soniox",
    label: "Soniox",
    options: ["stt-rt-v4","stt-rt-v5"],
    freeform: false,
  },
  {
    provider: "speechmatics",
    label: "Speechmatics",
    options: ["default"],
    freeform: false,
  },
  {
    provider: "talkscriber",
    label: "Talkscriber",
    options: ["whisper"],
    freeform: false,
  },
  {
    provider: "voicekernel",
    label: "VoiceKernel",
    options: [],
    freeform: false,
  },
  {
    provider: "xai",
    label: "Xai",
    options: ["default"],
    freeform: false,
  },
];

export interface ToolTypeEntry {
  /** Value sent to the voice provider as `type` when creating the tool. */
  type: string;
  label: string;
  /** Console grouping: Telephony | Enterprise systems | Integrations. */
  group: string;
  description: string;
  /** Whether the integrator supplies the behaviour (server URL, code, schema). */
  custom: boolean;
}

export const TOOL_TYPES: readonly ToolTypeEntry[] = [
  {
    type: "apiRequest",
    label: "Api Request",
    group: "Enterprise systems",
    description: "The type of tool. \"apiRequest\" for API request tool.",
    custom: true,
  },
  {
    type: "bash",
    label: "Bash",
    group: "Enterprise systems",
    description: "The type of tool. \"bash\" for Bash tool.",
    custom: true,
  },
  {
    type: "code",
    label: "Code",
    group: "Enterprise systems",
    description: "The type of tool. \"code\" for Code tool.",
    custom: true,
  },
  {
    type: "computer",
    label: "Computer",
    group: "Enterprise systems",
    description: "The type of tool. \"computer\" for Computer tool.",
    custom: true,
  },
  {
    type: "function",
    label: "Function",
    group: "Enterprise systems",
    description: "The type of tool. \"function\" for Function tool.",
    custom: true,
  },
  {
    type: "output",
    label: "Output",
    group: "Enterprise systems",
    description: "The type of tool. \"output\" for Output tool.",
    custom: false,
  },
  {
    type: "query",
    label: "Query",
    group: "Enterprise systems",
    description: "The type of tool. \"query\" for Query tool.",
    custom: false,
  },
  {
    type: "textEditor",
    label: "Text Editor",
    group: "Enterprise systems",
    description: "The type of tool. \"textEditor\" for Text Editor tool.",
    custom: true,
  },
  {
    type: "ghl",
    label: "Ghl",
    group: "Integrations",
    description: "The type of tool. \"ghl\" for GHL tool.",
    custom: false,
  },
  {
    type: "gohighlevel.calendar.availability.check",
    label: "Go High Level Calendar Availability",
    group: "Integrations",
    description: "The type of tool. \"gohighlevel.calendar.availability.check\" for GoHighLevel Calendar Availability Check tool.",
    custom: false,
  },
  {
    type: "gohighlevel.calendar.event.create",
    label: "Go High Level Calendar Event Create",
    group: "Integrations",
    description: "The type of tool. \"gohighlevel.calendar.event.create\" for GoHighLevel Calendar Event Create tool.",
    custom: false,
  },
  {
    type: "gohighlevel.contact.create",
    label: "Go High Level Contact Create",
    group: "Integrations",
    description: "The type of tool. \"gohighlevel.contact.create\" for GoHighLevel Contact Create tool.",
    custom: false,
  },
  {
    type: "gohighlevel.contact.get",
    label: "Go High Level Contact Get",
    group: "Integrations",
    description: "The type of tool. \"gohighlevel.contact.get\" for GoHighLevel Contact Get tool.",
    custom: false,
  },
  {
    type: "google.calendar.availability.check",
    label: "Google Calendar Check Availability",
    group: "Integrations",
    description: "The type of tool. \"google.calendar.availability.check\" for Google Calendar Check Availability tool.",
    custom: false,
  },
  {
    type: "google.calendar.event.create",
    label: "Google Calendar Create Event",
    group: "Integrations",
    description: "The type of tool. \"google.calendar.event.create\" for Google Calendar Create Event tool.",
    custom: false,
  },
  {
    type: "google.sheets.row.append",
    label: "Google Sheets Row Append",
    group: "Integrations",
    description: "The type of tool. \"google.sheets.row.append\" for Google Sheets Row Append tool.",
    custom: false,
  },
  {
    type: "make",
    label: "Make",
    group: "Integrations",
    description: "The type of tool. \"make\" for Make tool.",
    custom: false,
  },
  {
    type: "mcp",
    label: "Mcp",
    group: "Integrations",
    description: "The type of tool. \"mcp\" for MCP tool.",
    custom: true,
  },
  {
    type: "slack.message.send",
    label: "Slack Send Message",
    group: "Integrations",
    description: "The type of tool. \"slack.message.send\" for Slack Send Message tool.",
    custom: false,
  },
  {
    type: "dtmf",
    label: "Dtmf",
    group: "Telephony",
    description: "The type of tool. \"dtmf\" for DTMF tool.",
    custom: false,
  },
  {
    type: "endCall",
    label: "End Call",
    group: "Telephony",
    description: "The type of tool. \"endCall\" for End Call tool.",
    custom: false,
  },
  {
    type: "handoff",
    label: "Handoff",
    group: "Telephony",
    description: "This is the type of the tool. When you're using handoff tool, we recommend adding this to your system prompt --- # System context You are part of a multi-agent system designed to make agent coordination and execution eas",
    custom: false,
  },
  {
    type: "sipRequest",
    label: "Sip Request",
    group: "Telephony",
    description: "The type of tool. \"sipRequest\" for SIP request tool.",
    custom: false,
  },
  {
    type: "sms",
    label: "Sms",
    group: "Telephony",
    description: "The type of tool. \"sms\" for Twilio SMS sending tool.",
    custom: false,
  },
  {
    type: "transferCall",
    label: "Transfer Call",
    group: "Telephony",
    description: "",
    custom: false,
  },
  {
    type: "voicemail",
    label: "Voicemail",
    group: "Telephony",
    description: "The type of tool. \"voicemail\" for Voicemail tool.",
    custom: false,
  },
];

function index(entries: readonly CatalogEntry[]): ReadonlyMap<string, CatalogEntry> {
  return new Map(entries.map((e) => [e.provider, e]));
}

export const LLM_BY_PROVIDER = index(LLM_PROVIDERS);
export const VOICE_BY_PROVIDER = index(VOICE_PROVIDERS);
export const TRANSCRIBER_BY_PROVIDER = index(TRANSCRIBER_PROVIDERS);

/**
 * Validates a {provider, value} pair against the catalog. Returns null when
 * acceptable, or a human-readable reason when not - so a bad model is rejected
 * at save time with a useful message instead of failing mid-call.
 */
export function validateSelection(
  index: ReadonlyMap<string, CatalogEntry>,
  provider: string | undefined,
  value: string | undefined,
  what: string,
): string | null {
  if (!provider) return null;
  const entry = index.get(provider);
  if (!entry) {
    return `Unknown ${what} provider "${provider}". Supported: ${[...index.keys()].join(', ')}.`;
  }
  if (!value) return null;
  if (entry.freeform || entry.options.length === 0) return null;
  if (entry.options.includes(value)) return null;
  return `"${value}" is not a known ${what} for provider "${provider}". Supported: ${entry.options.join(', ')}.`;
}
