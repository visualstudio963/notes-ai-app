package com.notesai.app;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    SplashScreen.installSplashScreen(this);
    super.onCreate(savedInstanceState);
    lockWebViewTextZoom();
  }

  @Override
  public void onStart() {
    super.onStart();
    lockWebViewTextZoom();
  }

  @Override
  public void onResume() {
    super.onResume();
    lockWebViewTextZoom();
  }

  /** Keep UI scale identical across devices regardless of Android font-size settings. */
  private void lockWebViewTextZoom() {
    if (getBridge() == null) return;
    WebView webView = getBridge().getWebView();
    if (webView != null && webView.getSettings().getTextZoom() != 100) {
      webView.getSettings().setTextZoom(100);
    }
  }
}
