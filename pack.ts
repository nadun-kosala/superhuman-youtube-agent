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
    videoId: { type: coda.ValueType.String },
    title: { type: coda.ValueType.String },
    description: { type: coda.ValueType.String },
    url: { type: coda.ValueType.String, codaType: coda.ValueHintType.Url },
    player: { type: coda.ValueType.String, codaType: coda.ValueHintType.Embed },
  },
  displayProperty: "title",
  idProperty: "videoId",
  featuredProperties: ["player", "description"],
});

// --- PHASE 2.2: SYNC TABLES (Place here) ---
// This is the actual "Search" feature.
pack.addSyncTable({
  name: "SearchVideos",
  description: "Search for videos on YouTube.",
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
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
        player: `https://www.youtube.com/embed/${item.id.videoId}`,
      }));

      return { result: videos };
    },
  },
});
