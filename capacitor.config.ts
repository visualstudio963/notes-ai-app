import type { CapacitorConfig } from "@capacitor/cli";

const serverUrl = process.env.CAP_SERVER_URL?.trim();
const useLiveServer = Boolean(serverUrl);

const config: CapacitorConfig = {
  appId: "com.notesai.app",
  appName: "Notes AI",
  webDir: "frontend/public",
  bundledWebRuntime: false,
  /** Matches native splash — avoids flash between splash dismiss and WebView paint */
  backgroundColor: "#0B1228",
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
    Share: {},
    Camera: {
      promptLabelHeader: "Camera access",
      promptLabelPhoto: "Pick from gallery",
      promptLabelPicture: "Take a picture",
      promptLabelCancel: "Cancel"
    },
    Filesystem: {},
    LocalNotifications: {
      smallIcon: "ic_stat_notes_ai",
      iconColor: "#22D3EE"
    },
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      launchFadeOutDuration: 350,
      backgroundColor: "#0B1228",
      androidSplashResourceName: "splash",
      showSpinner: false,
      androidScaleType: "CENTER_CROP"
    }
  }
};

export default config;
