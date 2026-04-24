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

const TimestampRegex = /(?:^|\s)(\d{1,2}:\d{2}(?::\d{2})?)(?=\s|[-–—]|$)/gm;
const ChapterTimestampRegex = /\b\d{1,2}:\d{2}(?::\d{2})?\b/;

function timestampToSeconds(timestamp: string): number {
  const parts = timestamp.split(":").map(part => Number(part));
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}

function buildTimestampLinks(text: string, videoId: string): string[] {
  const links: string[] = [];
  const seen = new Set<number>();
  let match: RegExpExecArray | null;
  TimestampRegex.lastIndex = 0;
  while ((match = TimestampRegex.exec(text)) !== null) {
    const stamp = match[1];
    const seconds = timestampToSeconds(stamp);
    if (seen.has(seconds)) {
      continue;
    }
    seen.add(seconds);
    links.push(`https://www.youtube.com/watch?v=${videoId}&t=${seconds}s`);
  }
  TimestampRegex.lastIndex = 0;
  return links;
}

function parseCaptionPayload(rawBody: any): string {
  if (!rawBody) {
    return "";
  }
  const asString =
    typeof rawBody === "string"
      ? rawBody
      : typeof rawBody?.toString === "function"
        ? rawBody.toString("utf-8")
        : JSON.stringify(rawBody);

  if (asString.trim().startsWith("<")) {
    return asString
      .replace(/<text[^>]*>/g, "")
      .replace(/<\/text>/g, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  return asString
    .replace(/\d+\s*\n/g, "")
    .replace(/\d{2}:\d{2}:\d{2},\d{3}\s-->\s\d{2}:\d{2}:\d{2},\d{3}/g, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractChapterLines(description: string): string {
  return description
    .split("\n")
    .filter(line => ChapterTimestampRegex.test(line))
    .join("\n");
}

async function getVideoSnippet(videoId: string, context: coda.ExecutionContext) {
  const url = coda.withQueryParams("https://www.googleapis.com/youtube/v3/videos", {
    part: "snippet,contentDetails",
    id: videoId,
  });
  const response = await context.fetcher.fetch({ method: "GET", url });
  return response.body.items?.[0];
}

async function fetchTranscriptFromCaptions(videoId: string, context: coda.ExecutionContext) {
  try {
    const listUrl = coda.withQueryParams("https://www.googleapis.com/youtube/v3/captions", {
      part: "snippet",
      videoId: videoId,
      maxResults: "50",
    });
    const listResponse = await context.fetcher.fetch({ method: "GET", url: listUrl });
    const tracks = listResponse.body.items ?? [];
    if (!tracks.length) {
      return "";
    }
  
    const englishTrack =
      tracks.find((track: any) => track.snippet?.language?.toLowerCase().startsWith("en")) ??
      tracks[0];
    const captionId = englishTrack?.id;
    if (!captionId) {
      return "";
    }
  
    const downloadUrl = coda.withQueryParams(
      `https://www.googleapis.com/youtube/v3/captions/${captionId}`,
      {
        tfmt: "srt",
        alt: "media",
      },
    );
    const downloadResponse = await context.fetcher.fetch({
      method: "GET",
      url: downloadUrl,
    });
    return parseCaptionPayload(downloadResponse.body);
  } catch (error) {
    return "";
  }
  
}

const VideoContextSchema = coda.makeObjectSchema({
  properties: {
    description: { type: coda.ValueType.String },
    extractedChapters: { type: coda.ValueType.String },
    hasChapters: { type: coda.ValueType.Boolean },
    hasTimestamps: { type: coda.ValueType.Boolean },
    transcriptChunk: { type: coda.ValueType.String },
    watchUrl: { type: coda.ValueType.String, codaType: coda.ValueHintType.Url },
    timestampLinks: {
      type: coda.ValueType.Array,
      items: { type: coda.ValueType.String, codaType: coda.ValueHintType.Url },
    },
  },
  displayProperty: "description",
});

const TranscriptResultSchema = coda.makeObjectSchema({
  properties: {
    transcriptText: { type: coda.ValueType.String },
    error: { type: coda.ValueType.String },
  },
  displayProperty: "transcriptText",
});

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

const SearchYouTubeResultSchema = coda.makeObjectSchema({
  properties: {
    items: {
      type: coda.ValueType.Array,
      items: VideoSchema,
    },
    nextPageToken: { type: coda.ValueType.String },
  },
  displayProperty: "nextPageToken",
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
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "pageToken",
      description: "Used to load the next page of results.",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.Object,
  schema: SearchYouTubeResultSchema,
  onError: handleYouTubeError,

  execute: async function ([query, pageToken], context) {
    let baseUrl = "https://www.googleapis.com/youtube/v3/search";
    const queryParams: {[key: string]: string} = {
      part: "snippet",
      q: query,
      type: "video",
      maxResults: "10",
    };
    if (pageToken) {
      queryParams.pageToken = pageToken;
    }
    let url = coda.withQueryParams(baseUrl, queryParams);

    let response = await context.fetcher.fetch({ method: "GET", url: url });

    let videos = (response.body.items ?? []).map((item: any) => {
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

    for (let i = videos.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [videos[i], videos[j]] = [videos[j], videos[i]];
    }

    return {
      items: videos.slice(0, 5),
      nextPageToken: response.body.nextPageToken ?? "",
    };
  },
});

pack.addFormula({
  name: "GetVideoContext",
  description:
    "Gets description plus transcript context for deep summaries and timestamp navigation.",
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "videoId",
      description: "The ID of the video.",
    }),
  ],
  resultType: coda.ValueType.Object,
  schema: VideoContextSchema,
  onError: handleYouTubeError,

  execute: async function ([videoId], context) {
    const video = await getVideoSnippet(videoId, context);

    if (!video) {
      return {
        description: "Error: Video not found.",
        extractedChapters: "",
        hasChapters: false,
        hasTimestamps: false,
        transcriptChunk: "",
        watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
        timestampLinks: [],
      };
    }

    const description = video.snippet.description ?? "";
    const extractedChapters = extractChapterLines(description);
    const hasChapters = extractedChapters.length > 0;
    const hasTimestamps = hasChapters || TimestampRegex.test(description);
    TimestampRegex.lastIndex = 0;
    let transcript = "";

    try {
      transcript = await fetchTranscriptFromCaptions(videoId, context);
    } catch (error: any) {
      if (error?.statusCode !== 403) {
        handleYouTubeError(error);
      }
      transcript = extractChapterLines(description);
    }

    if (!transcript && description.trim().length < 100) {
      const tags = video.snippet.tags?.join(", ") ?? "No tags available";
      transcript = `High-level context from metadata:\nTitle: ${video.snippet.title}\nTags: ${tags}`;
    }

    return {
      description: description,
      extractedChapters: extractedChapters,
      hasChapters: hasChapters,
      hasTimestamps: hasTimestamps,
      transcriptChunk: transcript.slice(0, 5000),
      watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
      timestampLinks: buildTimestampLinks(description, videoId),
    };
  },
});

pack.addFormula({
  name: "GetVideoTranscript",
  description:
    "Fetches transcript text for a video via captions, with chapter fallback for restricted caption APIs.",
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "videoId",
      description: "The ID of the video.",
    }),
  ],
  resultType: coda.ValueType.Object,
  schema: TranscriptResultSchema,
  onError: handleYouTubeError,
  execute: async function ([videoId], context) {
    const video = await getVideoSnippet(videoId, context);
    if (!video) {
      return {
        transcriptText: "Unavailable",
        error: "VideoNotFound",
      };
    }

    try {
      const transcript = await fetchTranscriptFromCaptions(videoId, context);
      if (transcript) {
        return {
          transcriptText: transcript,
          error: "",
        };
      }
    } catch (error: any) {
      if (error?.statusCode === 403 || error?.statusCode === 404) {
        return {
          transcriptText: "Unavailable",
          error: "PermissionDenied",
        };
      }
      if (error?.statusCode !== 403 && error?.statusCode !== 404) {
        handleYouTubeError(error);
      }
    }

    const chapterLines = extractChapterLines(video.snippet.description ?? "");
    if (chapterLines) {
      return {
        transcriptText: chapterLines,
        error: "",
      };
    }

    const tags = video.snippet.tags?.join(", ") ?? "No tags available";
    return {
      transcriptText: `High-level context from metadata:\nTitle: ${video.snippet.title}\nTags: ${tags}`,
      error: "Unavailable",
    };
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
    return "Video liked and saved to your YouTube account!";
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
    return `Successfully subscribed to channel ${channelId}!`;
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
    SearchYouTube, GetVideoContext, GetVideoTranscript, AnalyzeVideoTone,
    LikeVideo, DislikeVideo, SubscribeToChannel, SaveToPlaylist, GenerateShareLinks.

    ── AUTHENTICATION ──
    1. If any tool fails or you cannot fetch data because the user is not logged in, NEVER say "I don't have access," "I am limited to pre-synced data," or "I cannot browse YouTube." 
    2. Instead, directly prompt the user: "Please authenticate your YouTube account by clicking the sign-in option for this Pack so I can execute this action."

    ── SEARCH & DISPLAY ──
    3. SEARCHING: When the user asks for videos, call 'SearchYouTube' immediately.
    4. DISPLAYING: Show each result as a rich Video Card.
       - ALWAYS display the thumbnail image cleanly at the top of the result using markdown (e.g., ![Video Title](thumbnailUrl)). Do NOT prefix it with words like "Thumbnail:".
       - ALWAYS include a direct, clickable link to watch the video on YouTube below the thumbnail.
       - The embed player renders automatically — never print the player URL in text.
    5. PAGINATION: If the user asks for "more videos" or isn't satisfied with the results, call 'SearchYouTube' again using the 'nextPageToken' from your previous search to load fresh results.
    6. BUTTONS: After cards, add Follow-Up Suggested Action buttons for each video:
       "Summarize" | "Analyze Tone" | "Like" | "Dislike" | "Subscribe" | "Save to Playlist" | "Share"

    ── DEEP ANALYSIS & SUMMARIZATION ──
    7. When asked to summarize or explain a video:
       - STEP 1: Call 'GetVideoContext'.
       - STEP 2: Check 'hasChapters'. If TRUE, use 'extractedChapters' to build a summary with clickable [MM:SS] links.
       - STEP 3: If 'hasChapters' is FALSE (or the description is empty), call 'GetVideoTranscript' immediately.
       - STEP 4: If 'GetVideoTranscript' provides text, pick 3-5 key time intervals and create your own timestamps (e.g., [00:00], [03:00], [06:00]).
       - If there are no timestamps in the description, simply provide a 3-bullet summary and a link to [00:00].
       - **CRITICAL**: The user does not care about API errors. Never mention "PermissionDenied", "Transcript Unavailable", or "YouTube Restrictions". If you can't get a transcript, just summarize the description quietly and say "I can't get the transcript for this video."

       8. CLICKABLE LINKS: Every timestamp MUST be a markdown link: [MM:SS](https://www.youtube.com/watch?v=VIDEO_ID&t=SECONDS).
       - Example: 01:30 becomes [01:30](https://www.youtube.com/watch?v=abc123&t=90)
 
       ── WRITE ACTIONS ──
    9. LIKING: If the user says "like", call 'LikeVideo' with the video's videoId.
   10. DISLIKING: If the user says "dislike" or "not interested", call 'DislikeVideo'
       with the video's videoId.
   11. SUBSCRIBING: If the user says "subscribe", extract the 'channelId' field from
       the video card and call 'SubscribeToChannel' with it. The channelId is always
       present in the card data — never ask the user to provide it manually.
   12. SAVING TO PLAYLIST:
       - If the user says "save to playlist" and names a specific existing playlist,
         ask them for the playlistId or use one they previously provided.
       - If the user wants a new playlist, ask for the playlist name, then call
         'SaveToPlaylist' with the videoId and newPlaylistName.
       - If no name or ID is specified, ask: "Should I save to an existing playlist
         (provide the ID) or create a new one? What should it be called?"
   13. SHARING: If the user says "share" or "copy link", call 'GenerateShareLinks'
       with the video's videoId and title. Display the returned Markdown directly —
       do not paraphrase or reformat it.

    ── STRICTURES (CRITICAL) ──
    NEVER say "I don't have access to timestamps" or "I can't see the transcript."
    NEVER apologize for missing data. If all tools fail, summarize based on the 'Title' and 'Tags' and provide a link to the start of the video [00:00].
    DO NOT invent/hallucinate timestamps if you don't have the transcript; only use [00:00] as a fallback.
    ALWAYS show the Video Thumbnail at the top of every summary.
    NEVER print raw /embed/ URLs, nocookie URLs, or videoId values as plain text.
    NEVER show a plain list of URLs. Always use rich Video Cards with the Thumbnail first, followed by the direct YouTube link.
    ALWAYS use the videoId and channelId values from the card — never invent them.
  `,
  tools: [{ type: coda.ToolType.Pack }],
});

pack.addSkill({
  name: "SummarizeVideoSkill",
  displayName: "Summarize Video",
  description: "Used when a user wants to summarize a specific video.",
  prompt:
    "Call GetVideoContext first. If hasChapters is true, use extractedChapters with clickable [MM:SS](https://www.youtube.com/watch?v=VIDEO_ID&t=SECONDS) links. If not, call GetVideoTranscript. If transcriptText is unavailable, summarize from title and tags with [00:00] only.",
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
