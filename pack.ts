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
    // thumbnail: shown as a rich image preview on the card
    thumbnail: {
      type: coda.ValueType.String,
      codaType: coda.ValueHintType.ImageReference,
    },
    // player: the embeddable URL so the video can play in the sidebar
    player: {
      type: coda.ValueType.String,
      codaType: coda.ValueHintType.Embed,
    },
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
  // featuredProperties: shows the embedded player when the card is expanded
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

      let videos = response.body.items.map((item: any) => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        description: item.snippet.description,
        thumbnail: item.snippet.thumbnails?.high?.url ?? item.snippet.thumbnails?.default?.url ?? "",
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
        player: `https://www.youtube.com/embed/${item.id.videoId}`,
      }));

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

    let videos = response.body.items.map((item: any) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      thumbnail: item.snippet.thumbnails?.high?.url ?? item.snippet.thumbnails?.default?.url ?? "",
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      player: `https://www.youtube.com/embed/${item.id.videoId}`,
    }));

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
  description: "YouTube search, summary, and like agent.",
  prompt: `
    You are an interactive YouTube Assistant with full access to the SearchYouTube, GetVideoContext, and LikeVideo formulas.

    1. SEARCHING: Whenever the user asks for videos, you MUST call the 'SearchYouTube' formula immediately.
    2. DISPLAYING: After receiving results, display each video as a rich Video Card. Each card must include:
       - The 'title' as the card heading.
       - The 'thumbnail' image (use the imageProperty on the card).
       - The 'player' embed URL so the user can watch the video directly in the sidebar without leaving.
       - The 'url' as a clickable link.
    3. BUTTONS: After displaying cards, always generate Follow-Up Suggested Actions (buttons):
       - One button per video: "Summarize: [Title]"
       - One button per video: "Like: [Title]"
    4. SUMMARIZING: If the user clicks a Summarize button or asks for a summary, call 'GetVideoContext' with that video's ID and provide a 3-point bullet summary.
    5. LIKING: If the user clicks a Like button or says "like this", call 'LikeVideo' with that video's ID.

    IMPORTANT: Never return a plain list of URLs. Always render full Video Cards with thumbnail and embedded player.
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
  name: "LikeVideoSkill",
  displayName: "Like Video",
  description: "Used when a user says 'like this' or 'save this'.",
  prompt:
    "Call the LikeVideo formula using the videoId of the video currently being discussed.",
  tools: [{ type: coda.ToolType.Pack }],
});
