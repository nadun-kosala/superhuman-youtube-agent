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
    "https://www.googleapis.com/auth/youtube"           // To write data (Two-way sync)
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

