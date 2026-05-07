import type { CapacitorConfig } from "@capacitor/cli";

const serverUrl = process.env.CAP_SERVER_URL?.trim();
const useLiveServer = Boolean(serverUrl);

const config: CapacitorConfig = {
  appId: "com.notesai.app",
  appName: "Notes AI",
  webDir: "frontend/public",
  bundledWebRuntime: false,
  /** Matches default auth shell / splash tone; avoids brief white flash on cold start */
  backgroundColor: "#050814",
  android: {
    allowMixedContent: false
  },
  ios: {
    contentInset: "automatic"
  },
  server: useLiveServer
    ? {
        url: serverUrl,
        cleartext: serverUrl?.startsWith("http://") ?? false,
        allowNavigation: ["*"]
      }
    : undefined,
  plugins: {
    Camera: {
      promptLabelHeader: "Camera access",
      promptLabelPhoto: "Pick from gallery",
      promptLabelPicture: "Take a picture",
      promptLabelCancel: "Cancel"
    },
    Filesystem: {}
  }
};

export default config;
