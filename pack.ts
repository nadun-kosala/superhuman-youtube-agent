import * as coda from "@codahq/packs-sdk";

export const pack = coda.newPack();

pack.addNetworkDomain("googleapis.com");

pack.setUserAuthentication({
  type: coda.AuthenticationType.OAuth2,

  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",

  networkDomain: "googleapis.com",

  scopes: [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/youtube.force-ssl",
  ],

  additionalParams: {
    access_type: "offline",
    prompt: "consent",
  },

  getConnectionName: async function (context) {
    return "Sanmark YouTube Connection";
  },
});

function handleYouTubeError(error: any) {
  const reason = error?.body?.error?.errors?.[0]?.reason || error?.reason || "";

  if (error.statusCode === 401 && reason === "youtubeSignupRequired") {
    throw new coda.UserVisibleError(
      "Action failed: Your Google account isn't linked to a YouTube Channel. Please go to https://www.youtube.com/create_channel to set up your channel, then try again.",
    );
  }

  if (error.statusCode === 403 && reason === "quotaExceeded") {
    throw new coda.UserVisibleError(
      "The daily YouTube API limit has been reached. Please try again tomorrow or contact support to upgrade.",
    );
  }

  if (error.statusCode === 403 && reason === "rateLimitExceeded") {
    throw new coda.UserVisibleError(
      "YouTube is receiving too many requests. Please wait a moment and try again.",
    );
  }

  if (error.statusCode === 401) {
    throw new coda.UserVisibleError(
      "Your YouTube connection has expired. Please log out of the Pack and log back in to refresh your access.",
    );
  }

  throw error;
}

const VideoSchema = coda.makeObjectSchema({
  properties: {
    title: { type: coda.ValueType.String },
    thumbnail: {
      type: coda.ValueType.String,
      codaType: coda.ValueHintType.ImageReference,
    },
    player: {
      type: coda.ValueType.String,
      codaType: coda.ValueHintType.Embed,
      force: true,
    } as any,
    videoId: { type: coda.ValueType.String },
    channelId: { type: coda.ValueType.String },
    url: { type: coda.ValueType.String, codaType: coda.ValueHintType.Url },
    description: { type: coda.ValueType.String },
  },
  displayProperty: "title",
  idProperty: "videoId",
  imageProperty: "thumbnail",
  linkProperty: "url",
  titleProperty: "title",
  snippetProperty: "description",
  featuredProperties: ["player"],
});

pack.addSyncTable({
  name: "SearchVideos",
  description:
    "Searches YouTube. Each result has a videoId that can be used with 'LikeVideo' and 'GetVideoContext'.",
  identityName: "Video",
  schema: VideoSchema,
  formula: {
    name: "SyncSearchVideos",
    description: "Syncs the videos based on a search query.",
    onError: handleYouTubeError,
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
        const thumb =
          item.snippet.thumbnails?.maxres?.url ??
          item.snippet.thumbnails?.high?.url ??
          item.snippet.thumbnails?.medium?.url ??
          item.snippet.thumbnails?.default?.url ??
          `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
        return {
          videoId: id,
          channelId: item.snippet.channelId,
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
  resultType: coda.ValueType.Array,
  items: VideoSchema,
  onError: handleYouTubeError,

  execute: async function ([query], context) {
    let baseUrl = "https://www.googleapis.com/youtube/v3/search";
    let url = coda.withQueryParams(baseUrl, {
      part: "snippet",
      q: query,
      type: "video",
      maxResults: "3",
    });

    let response = await context.fetcher.fetch({ method: "GET", url: url });

    let videos = response.body.items.map((item: any) => {
      const id = item.id.videoId;
      const thumb =
        item.snippet.thumbnails?.maxres?.url ??
        item.snippet.thumbnails?.high?.url ??
        item.snippet.thumbnails?.medium?.url ??
        item.snippet.thumbnails?.default?.url ??
        `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
      return {
        videoId: id,
        channelId: item.snippet.channelId,
        title: item.snippet.title,
        description: item.snippet.description,
        thumbnail: thumb,
        url: `https://www.youtube.com/watch?v=${id}`,
        player: `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1`,
      };
    });

    return videos;
  },
});

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
  onError: handleYouTubeError,

  execute: async function ([videoId], context) {
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

    let textToSummarize = `Title: ${video.snippet.title}\n\nDescription: ${video.snippet.description}`;

    return textToSummarize;
  },
});

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
  onError: handleYouTubeError,

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

pack.addFormula({
  name: "LikeVideo",
  description: "Likes a video on the user's YouTube account.",
  isAction: true,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "videoId",
      description: "The ID of the video to like.",
    }),
  ],
  resultType: coda.ValueType.String,
  onError: handleYouTubeError,
  execute: async function ([videoId], context) {
    const url = coda.withQueryParams(
      "https://www.googleapis.com/youtube/v3/videos/rate",
      { id: videoId, rating: "like" },
    );
    await context.fetcher.fetch({ method: "POST", url });
    return "✅ Video liked and saved to your YouTube account!";
  },
});

pack.addFormula({
  name: "DislikeVideo",
  description: "Dislikes a video on the user's YouTube account.",
  isAction: true,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "videoId",
      description: "The ID of the video to dislike.",
    }),
  ],
  resultType: coda.ValueType.String,
  onError: handleYouTubeError,
  execute: async function ([videoId], context) {
    const url = coda.withQueryParams(
      "https://www.googleapis.com/youtube/v3/videos/rate",
      { id: videoId, rating: "dislike" },
    );
    await context.fetcher.fetch({ method: "POST", url });
    return "👎 Video disliked on your YouTube account.";
  },
});

pack.addFormula({
  name: "SubscribeToChannel",
  description:
    "Subscribes the user to a YouTube channel. The channelId is available on every Video card.",
  isAction: true,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "channelId",
      description:
        "The ID of the channel to subscribe to (from the video card's channelId field).",
    }),
  ],
  resultType: coda.ValueType.String,
  onError: handleYouTubeError,
  execute: async function ([channelId], context) {
    const url = coda.withQueryParams(
      "https://www.googleapis.com/youtube/v3/subscriptions",
      { part: "snippet" },
    );
    await context.fetcher.fetch({
      method: "POST",
      url,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snippet: {
          resourceId: {
            kind: "youtube#channel",
            channelId: channelId,
          },
        },
      }),
    });
    return `✅ Successfully subscribed to channel ${channelId}!`;
  },
});

pack.addFormula({
  name: "SaveToPlaylist",
  description:
    "Saves a video to an existing YouTube playlist or creates a new private playlist and saves it there.",
  isAction: true,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "videoId",
      description: "The ID of the video to save.",
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "playlistId",
      description:
        "The ID of an existing playlist. Leave empty to create a new one.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "newPlaylistName",
      description:
        "Name for a new playlist to create. Required if no playlistId is provided.",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.String,
  onError: handleYouTubeError,
  execute: async function ([videoId, playlistId, newPlaylistName], context) {
    let targetPlaylistId = playlistId;
    let playlistName = newPlaylistName ?? "My YouTube Playlist";

    if (!targetPlaylistId) {
      const createUrl = coda.withQueryParams(
        "https://www.googleapis.com/youtube/v3/playlists",
        { part: "snippet,status" },
      );
      const createRes = await context.fetcher.fetch({
        method: "POST",
        url: createUrl,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          snippet: {
            title: playlistName,
            description: "Created by Superhuman YouTube Agent",
          },
          status: { privacyStatus: "private" },
        }),
      });
      targetPlaylistId = createRes.body.id;
      playlistName = createRes.body.snippet?.title ?? playlistName;
    }

    const insertUrl = coda.withQueryParams(
      "https://www.googleapis.com/youtube/v3/playlistItems",
      { part: "snippet" },
    );
    await context.fetcher.fetch({
      method: "POST",
      url: insertUrl,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snippet: {
          playlistId: targetPlaylistId,
          resourceId: { kind: "youtube#video", videoId: videoId },
        },
      }),
    });

    return `Video saved to playlist "${playlistName}" (ID: ${targetPlaylistId}).`;
  },
});

pack.addFormula({
  name: "GenerateShareLinks",
  description:
    "Generates a formatted set of share links for a YouTube video across WhatsApp, Twitter/X, Facebook, LinkedIn, Reddit, Pinterest, and Email.",
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "videoId",
      description: "The ID of the video to share.",
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "title",
      description: "The video title (used in tweet text and email subject).",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async function ([videoId, title], context) {
    const videoUrl = `https://youtu.be/${videoId}`;
    const encodedUrl = encodeURIComponent(videoUrl);
    const encodedTitle = encodeURIComponent(title ?? "Check out this video!");

    return [
      `**🔗 Share: ${title ?? videoUrl}**`,
      ``,
      `**Direct link:** ${videoUrl}`,
      ``,
      `**Share on:**`,
      `- 💬 [WhatsApp](https://api.whatsapp.com/send?text=${encodedTitle}%20${encodedUrl})`,
      `- 🐦 [X / Twitter](https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedTitle})`,
      `- 📘 [Facebook](https://www.facebook.com/sharer/sharer.php?u=${encodedUrl})`,
      `- 💼 [LinkedIn](https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl})`,
      `- 🤖 [Reddit](https://reddit.com/submit?url=${encodedUrl}&title=${encodedTitle})`,
      `- 📌 [Pinterest](https://pinterest.com/pin/create/button/?url=${encodedUrl}&description=${encodedTitle})`,
      `- 📧 [Email](mailto:?subject=${encodedTitle}&body=${encodedUrl})`,
    ].join("\n");
  },
});

pack.setChatSkill({
  name: "Chat",
  description:
    "Full YouTube intelligent agent: search, summarize, analyze, like, dislike, subscribe, save to playlist, and share.",
  prompt: `
    You are an interactive YouTube Assistant. You have access to these formulas:
    SearchYouTube, GetVideoContext, AnalyzeVideoTone,
    LikeVideo, DislikeVideo, SubscribeToChannel, SaveToPlaylist, GenerateShareLinks.

    ── SEARCH & DISPLAY ──
    1. SEARCHING: When the user asks for videos, call 'SearchYouTube' immediately.
    2. DISPLAYING: Show each result as a rich Video Card (title, thumbnail, link).
       The embed player renders automatically — never print the player URL in text.
    3. BUTTONS: After cards, add Follow-Up Suggested Action buttons for each video:
       "Summarize" | "Analyze Tone" | "Like" | "Dislike" | "Subscribe" | "Save to Playlist" | "Share"

    ── READ ACTIONS ──
    4. SUMMARIZING: Call 'GetVideoContext' → present a 3-bullet summary.
    5. ANALYZING: Call 'AnalyzeVideoTone' → show Category and Difficulty.

    ── WRITE ACTIONS ──
    6. LIKING: If the user says "like", call 'LikeVideo' with the video's videoId.
    7. DISLIKING: If the user says "dislike" or "not interested", call 'DislikeVideo'
       with the video's videoId.
    8. SUBSCRIBING: If the user says "subscribe", extract the 'channelId' field from
       the video card and call 'SubscribeToChannel' with it. The channelId is always
       present in the card data — never ask the user to provide it manually.
    9. SAVING TO PLAYLIST:
       - If the user says "save to playlist" and names a specific existing playlist,
         ask them for the playlistId or use one they previously provided.
       - If the user wants a new playlist, ask for the playlist name, then call
         'SaveToPlaylist' with the videoId and newPlaylistName.
       - If no name or ID is specified, ask: "Should I save to an existing playlist
         (provide the ID) or create a new one? What should it be called?"
   10. SHARING: If the user says "share" or "copy link", call 'GenerateShareLinks'
       with the video's videoId and title. Display the returned Markdown directly —
       do not paraphrase or reformat it.

    ── RULES ──
    NEVER print raw /embed/ URLs, nocookie URLs, or videoId values as plain text.
    NEVER show a plain list of URLs. Always use rich Video Cards for search results.
    ALWAYS use the videoId and channelId values from the card — never invent them.
  `,
  tools: [{ type: coda.ToolType.Pack }],
});

pack.addSkill({
  name: "SummarizeVideoSkill",
  displayName: "Summarize Video",
  description: "Used when a user wants to summarize a specific video.",
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
    "Call AnalyzeVideoTone with the videoId. Present Category and Difficulty clearly.",
  tools: [{ type: coda.ToolType.Pack }],
});

pack.addSkill({
  name: "LikeVideoSkill",
  displayName: "Like Video",
  description: "Used when a user says 'like this'.",
  prompt: "Call LikeVideo with the videoId of the video being discussed.",
  tools: [{ type: coda.ToolType.Pack }],
});

pack.addSkill({
  name: "DislikeVideoSkill",
  displayName: "Dislike Video",
  description:
    "Used when a user says 'dislike' or 'not interested' about a video.",
  prompt: "Call DislikeVideo with the videoId of the video being discussed.",
  tools: [{ type: coda.ToolType.Pack }],
});

pack.addSkill({
  name: "SubscribeSkill",
  displayName: "Subscribe to Channel",
  description: "Used when a user says 'subscribe to this channel'.",
  prompt:
    "Extract the channelId from the current video card and call SubscribeToChannel with it. Never ask the user for the channelId — it is always present in the search result data.",
  tools: [{ type: coda.ToolType.Pack }],
});

pack.addSkill({
  name: "SaveToPlaylistSkill",
  displayName: "Save to Playlist",
  description: "Used when a user wants to save a video to a YouTube playlist.",
  prompt:
    "Ask the user if they want an existing playlist (playlistId) or a new one (name). Then call SaveToPlaylist with the videoId and either playlistId or newPlaylistName.",
  tools: [{ type: coda.ToolType.Pack }],
});

pack.addSkill({
  name: "ShareVideoSkill",
  displayName: "Share Video",
  description: "Used when a user asks to share a video or copy a link.",
  prompt:
    "Call GenerateShareLinks with the videoId and title of the video. Display the returned Markdown exactly as-is without paraphrasing.",
  tools: [{ type: coda.ToolType.Pack }],
});
