import * as coda from "@codahq/packs-sdk";

export const pack = coda.newPack();

// 1. Declare the Network Domains
// This tells Superhuman/Coda that your pack is allowed to talk to Google's servers.
pack.addNetworkDomain("googleapis.com");


// 2. Set up OAuth2 User Authentication
// This triggers the "Sign in with Google" popup for the user.
pack.setUserAuthentication({
  type: coda.AuthenticationType.OAuth2,

  // Google's standard OAuth endpoints
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",

  networkDomain: "googleapis.com",

  // The exact scopes you requested in the Google Cloud Console
  scopes: [
    "https://www.googleapis.com/auth/youtube.readonly", // To read data and transcripts
    "https://www.googleapis.com/auth/youtube", // To write data (Two-way sync)
  ],

  // Force Google to give us a Refresh Token so the user stays logged in
  additionalParams: {
    access_type: "offline",
    prompt: "consent",
  },

  // Optional but recommended: This labels the connected account in the UI
  getConnectionName: async function (context) {
    return "Sanmark YouTube Connection";
  },
});

// --- PHASE 2.1: SCHEMAS (Place here) ---
// This tells the agent what a "Video" object looks like.
const VideoSchema = coda.makeObjectSchema({
  properties: {
    title: { type: coda.ValueType.String },
    // thumbnail: ImageReference hotlinks to YouTube's CDN directly in the browser.
    // The pack server never fetches this URL, so no extra network domain is needed.
    thumbnail: {
      type: coda.ValueType.String,
      codaType: coda.ValueHintType.ImageReference,
    },
    // player: embed field using the YouTube WATCH URL (not /embed/).
    // Coda's Iframely engine converts watch URLs to real iframes.
    // force:true allows embedding even without oEmbed support.
    // The youtube-nocookie.com domain avoids X-Frame-Options blocks.
    player: {
      type: coda.ValueType.String,
      codaType: coda.ValueHintType.Embed,
      force: true,
    } as any,
    videoId: { type: coda.ValueType.String },
    url: { type: coda.ValueType.String, codaType: coda.ValueHintType.Url },
    description: { type: coda.ValueType.String },
  },
  displayProperty: "title",
  idProperty: "videoId",
  // imageProperty: renders the thumbnail on the rich card preview
  imageProperty: "thumbnail",
  // linkProperty: makes the card title a clickable link to YouTube
  linkProperty: "url",
  // titleProperty / snippetProperty: structure the card layout
  titleProperty: "title",
  snippetProperty: "description",
  // featuredProperties: shows the embedded player inline on the card
  featuredProperties: ["player"],
});

// --- PHASE 2.2: SYNC TABLES (Place here) ---
// This is the actual "Search" feature.
pack.addSyncTable({
  name: "SearchVideos",
  description:
    "Searches YouTube. Each result has a videoId that can be used with 'LikeVideo' and 'GetVideoContext'.",
  identityName: "Video",
  schema: VideoSchema,
  formula: {
    name: "SyncSearchVideos",
    description: "Syncs the videos based on a search query.",
    parameters: [
      coda.makeParameter({
        type: coda.ParameterType.String,
        name: "searchQuery",
        description: "What do you want to search for?",
      }),
    ],
    execute: async function ([searchQuery], context) {
      let baseUrl = "https://www.googleapis.com/youtube/v3/search";
      let url = coda.withQueryParams(baseUrl, {
        part: "snippet",
        q: searchQuery,
        type: "video",
        maxResults: "10",
      });

      let response = await context.fetcher.fetch({
        method: "GET",
        url: url,
      });

      let videos = response.body.items.map((item: any) => {
        const id = item.id.videoId;
        // Prefer maxresdefault (1280px), fall back through quality levels
        const thumb =
          item.snippet.thumbnails?.maxres?.url ??
          item.snippet.thumbnails?.high?.url ??
          item.snippet.thumbnails?.medium?.url ??
          item.snippet.thumbnails?.default?.url ??
          `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
        return {
          videoId: id,
          title: item.snippet.title,
          description: item.snippet.description,
          thumbnail: thumb,
          url: `https://www.youtube.com/watch?v=${id}`,
          player: `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1`,
        };
      });

      return { result: videos };
    },
  },
});

// --- THE MISSING TOOL: LIVE SEARCH FORMULA ---
pack.addFormula({
  name: "SearchYouTube",
  description: "Searches YouTube for videos based on the user's chat query.",
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "query",
      description: "The search terms (e.g., 'how to make a cake').",
    }),
  ],
  // We reuse your VideoSchema here so it returns rich cards!
  resultType: coda.ValueType.Array,
  items: VideoSchema,

  execute: async function ([query], context) {
    let baseUrl = "https://www.googleapis.com/youtube/v3/search";
    let url = coda.withQueryParams(baseUrl, {
      part: "snippet",
      q: query,
      type: "video",
      maxResults: "3", // Keep it small for chat UI
    });

    let response = await context.fetcher.fetch({ method: "GET", url: url });

    let videos = response.body.items.map((item: any) => {
      const id = item.id.videoId;
      // Prefer maxresdefault (1280px), fall back through quality levels
      const thumb =
        item.snippet.thumbnails?.maxres?.url ??
        item.snippet.thumbnails?.high?.url ??
        item.snippet.thumbnails?.medium?.url ??
        item.snippet.thumbnails?.default?.url ??
        `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
      return {
        videoId: id,
        title: item.snippet.title,
        description: item.snippet.description,
        thumbnail: thumb,
        url: `https://www.youtube.com/watch?v=${id}`,
        // nocookie embed avoids X-Frame-Options CSP block in the extension sandbox.
        player: `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1`,
      };
    });

    return videos;
  },
});

// --- PHASE 3.1: READ ACTION (AI CONTEXT) ---
pack.addFormula({
  name: "GetVideoContext",
  description: "Gets the detailed text of a video so the AI can summarize it.",
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "videoId",
      description: "The ID of the video.",
    }),
  ],
  resultType: coda.ValueType.String,

  execute: async function ([videoId], context) {
    // Call the YouTube API to get the specific video details
    let url = coda.withQueryParams(
      "https://www.googleapis.com/youtube/v3/videos",
      {
        part: "snippet,contentDetails",
        id: videoId,
      },
    );

    let response = await context.fetcher.fetch({ method: "GET", url: url });
    let video = response.body.items[0];

    if (!video) {
      return "Error: Video not found.";
    }

    // Combine the title and description into a single text block for the AI
    let textToSummarize = `Title: ${video.snippet.title}\n\nDescription: ${video.snippet.description}`;

    return textToSummarize;
  },
});

// --- PHASE 3.1b: SENTIMENT & TOPIC ANALYSIS ---
// Extracts structured data points (tone, category, difficulty) from video metadata
// so the user can understand a video's nature without watching it.
pack.addFormula({
  name: "AnalyzeVideoTone",
  description:
    "Analyzes if a video is a tutorial, a review, or general news, and estimates its technical difficulty.",
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "videoId",
      description: "The ID of the video to analyze.",
    }),
  ],
  resultType: coda.ValueType.String,

  execute: async function ([videoId], context) {
    let url = coda.withQueryParams(
      "https://www.googleapis.com/youtube/v3/videos",
      {
        part: "snippet",
        id: videoId,
      },
    );
    let response = await context.fetcher.fetch({ method: "GET", url: url });
    let item = response.body.items[0];

    if (!item) return "Error: Video not found.";

    const title = item.snippet.title.toLowerCase();
    const desc = item.snippet.description.toLowerCase();
    const combined = `${title} ${desc}`;

    // --- Category detection ---
    let category = "General Content";
    if (
      combined.includes("how to") ||
      combined.includes("tutorial") ||
      combined.includes("step by step") ||
      combined.includes("beginner") ||
      combined.includes("course")
    ) {
      category = "Educational / Step-by-Step Tutorial";
    } else if (
      combined.includes("review") ||
      combined.includes(" vs ") ||
      combined.includes("comparison") ||
      combined.includes("best ") ||
      combined.includes("top ")
    ) {
      category = "Product Review / Comparison";
    } else if (
      combined.includes("news") ||
      combined.includes("breaking") ||
      combined.includes("update") ||
      combined.includes("announced")
    ) {
      category = "News / Current Events";
    } else if (
      combined.includes("vlog") ||
      combined.includes("day in my life") ||
      combined.includes("behind the scenes")
    ) {
      category = "Vlog / Lifestyle";
    }

    // --- Technical difficulty estimation ---
    const techTerms = [
      "api",
      "algorithm",
      "machine learning",
      "neural",
      "typescript",
      "kubernetes",
      "docker",
      "compiler",
      "framework",
      "architecture",
    ];
    const techCount = techTerms.filter((t) => combined.includes(t)).length;
    let difficulty = "Beginner-friendly";
    if (techCount >= 3) difficulty = "Advanced / Technical";
    else if (techCount >= 1) difficulty = "Intermediate";

    return `Category: ${category} | Difficulty: ${difficulty}`;
  },
});

// --- PHASE 3.2: WRITE ACTION (TWO-WAY SYNC) ---
pack.addFormula({
  name: "LikeVideo",
  description:
    "Likes a video. Use the videoId found in the SearchVideos table results.",
  // isAction: true is CRITICAL here! It tells the system this modifies data.
  isAction: true,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "videoId",
      description:
        "The ID of the video to like (fetch this from the search results).",
    }),
  ],
  resultType: coda.ValueType.String,

  execute: async function ([videoId], context) {
    // The YouTube API endpoint for rating a video
    let url = coda.withQueryParams(
      "https://www.googleapis.com/youtube/v3/videos/rate",
      {
        id: videoId,
        rating: "like",
      },
    );

    // Notice we use "POST" instead of "GET" because we are writing data
    await context.fetcher.fetch({
      method: "POST",
      url: url,
    });

    return "Success! Video has been liked and saved to your YouTube account.";
  },
});

pack.setChatSkill({
  name: "Chat",
  description: "YouTube search, summary, tone analysis, and like agent.",
  prompt: `
    You are an interactive YouTube Assistant with full access to these formulas:
    SearchYouTube, GetVideoContext, AnalyzeVideoTone, LikeVideo.

    1. SEARCHING: Whenever the user asks for videos, call 'SearchYouTube' immediately.
    2. DISPLAYING: Show each result as a rich Video Card with its title, thumbnail image,
       and a clickable link. The embedded player widget will render automatically from
       the card data — do NOT print the player URL or any embed URL in your text reply.
    3. BUTTONS: After showing cards, always add Follow-Up Suggested Action buttons:
       - "Summarize: [Title]" — one per video
       - "Analyze Tone: [Title]" — one per video
       - "Like: [Title]" — one per video
    4. SUMMARIZING: If asked to summarize, call 'GetVideoContext' with the video's ID
       and present a 3-bullet-point summary.
    5. LIKING: If asked to like a video, call 'LikeVideo' with the video's ID.
    6. ANALYZING: If asked to analyze tone, category, or difficulty, call
       'AnalyzeVideoTone' with the video's ID and present the result clearly.

    NEVER output a raw embed URL, nocookie URL, or any YouTube /embed/ link in your
    text response. Those URLs are for the card widget only and must stay hidden.
    NEVER show a plain list of URLs. Always render full Video Cards.
  `,
  tools: [{ type: coda.ToolType.Pack }],
});

pack.addSkill({
  name: "SummarizeVideoSkill",
  displayName: "Summarize Video",
  description:
    "Used when a user wants to summarize a specific video from the list.",
  prompt:
    "Use GetVideoContext for the requested video ID. Provide a summary in 3 bullet points.",
  tools: [{ type: coda.ToolType.Pack }],
});

pack.addSkill({
  name: "AnalyzeVideoSkill",
  displayName: "Analyze Video Tone",
  description:
    "Used when a user asks about the tone, category, or difficulty of a video.",
  prompt:
    "Call AnalyzeVideoTone with the videoId of the video being discussed. Present the Category and Difficulty clearly.",
  tools: [{ type: coda.ToolType.Pack }],
});

pack.addSkill({
  name: "LikeVideoSkill",
  displayName: "Like Video",
  description: "Used when a user says 'like this' or 'save this'.",
  prompt:
    "Call the LikeVideo formula using the videoId of the video currently being discussed.",
  tools: [{ type: coda.ToolType.Pack }],
});
