import React, { useRef, useCallback, useState } from "react";
import { View, StyleSheet, StatusBar, Text } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/RootNavigator";

import { TERMINAL_HTML } from "../terminal/terminal-html";

type Props = NativeStackScreenProps<RootStackParamList, "Terminal">;

type ConnectionStatus = "connecting" | "connected" | "error" | "disconnected";

const STATUS_COLORS: Record<ConnectionStatus, string> = {
  connecting: "#e3b341",
  connected: "#3fb950",
  error: "#f85149",
  disconnected: "#f85149",
};

export default function TerminalScreen({ route }: Props) {
  const { sessionId, terminalWsUrl } = route.params;
  const webViewRef = useRef<WebView>(null);
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  // Inject WS URL and session ID BEFORE xterm.js init runs
  const injectedJS = `
    window.AO_WS_URL = ${JSON.stringify(terminalWsUrl)};
    window.AO_SESSION_ID = ${JSON.stringify(sessionId)};
    true; // required return value
  `;

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as {
        type: string;
        state?: ConnectionStatus;
      };
      if (msg.type === "status" && msg.state) {
        setStatus(msg.state);
      }
    } catch {
      // ignore unparseable messages
    }
  }, []);

  const handleLoad = useCallback(() => {
    // Ask xterm to fit to current viewport
    webViewRef.current?.injectJavaScript(
      'window.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "fit" }) })); true;',
    );
  }, []);

  const dotColor = STATUS_COLORS[status];

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <StatusBar barStyle="light-content" backgroundColor="#0d1117" />

      {/* Status indicator in top-right */}
      <View style={styles.statusDot}>
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
        <Text style={[styles.statusText, { color: dotColor }]}>
          {status}
        </Text>
      </View>

      <WebView
        ref={webViewRef}
        source={{ html: TERMINAL_HTML }}
        injectedJavaScriptBeforeContentLoaded={injectedJS}
        onMessage={handleMessage}
        onLoad={handleLoad}
        style={styles.webView}
        originWhitelist={["*"]}
        // Required for ws:// from about:blank on Android
        mixedContentMode="always"
        allowFileAccess={false}
        javaScriptEnabled={true}
        domStorageEnabled={false}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        keyboardDisplayRequiresUserAction={false}
        // Suppress "Can't open file" logs for blob: URLs
        onError={() => {}}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0d1117",
  },
  webView: {
    flex: 1,
    backgroundColor: "#0d1117",
  },
  statusDot: {
    position: "absolute",
    top: 8,
    right: 12,
    flexDirection: "row",
    alignItems: "center",
    zIndex: 10,
    gap: 4,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 11,
    fontWeight: "600",
  },
});
