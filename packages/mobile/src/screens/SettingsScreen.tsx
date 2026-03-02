import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { useBackend } from "../context/BackendContext";
import { scheduleNotification } from "../notifications";
import * as Notifications from "expo-notifications";

type Props = NativeStackScreenProps<RootStackParamList, "Settings">;

export default function SettingsScreen({ navigation }: Props) {
  const { backendUrl, setBackendUrl, terminalWsUrl, terminalWsOverride, setTerminalWsOverride } = useBackend();
  const [input, setInput] = useState(backendUrl);
  const [wsInput, setWsInput] = useState(terminalWsOverride);
  const [saving, setSaving] = useState(false);

  const handleTestRespondNotification = async () => {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission denied", "Notification permission is not granted. Enable it in your phone's Settings app.");
      return;
    }
    scheduleNotification(
      {
        id: "ao-test-session",
        projectId: "test",
        status: "needs_input",
        activity: "waiting_input",
        branch: "feat/test",
        issueId: null,
        issueUrl: null,
        issueLabel: "TEST-1",
        issueTitle: "Fix the flaky integration test",
        summary: "Waiting for your decision on the approach",
        summaryIsFallback: false,
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        pr: null,
        metadata: {},
      },
      "respond",
    );
    Alert.alert("Sent", "A test 'respond' notification was fired. Check your notification shade.");
  };

  const handleTestMergeNotification = async () => {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission denied", "Notification permission is not granted. Enable it in your phone's Settings app.");
      return;
    }
    scheduleNotification(
      {
        id: "ao-test-session",
        projectId: "test",
        status: "mergeable",
        activity: "idle",
        branch: "feat/test",
        issueId: null,
        issueUrl: null,
        issueLabel: "TEST-1",
        issueTitle: "Add user authentication flow",
        summary: null,
        summaryIsFallback: false,
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        pr: { number: 42, url: "", title: "Add auth flow", owner: "", repo: "", branch: "feat/test", baseBranch: "main", isDraft: false, state: "open", additions: 120, deletions: 8, ciStatus: "passing", ciChecks: [], reviewDecision: "approved", mergeability: { mergeable: true, ciPassing: true, approved: true, noConflicts: true, blockers: [] }, unresolvedThreads: 0 },
        metadata: {},
      },
      "merge",
    );
    Alert.alert("Sent", "A test 'merge' notification was fired. Check your notification shade.");
  };

  const handleSave = async () => {
    const trimmed = input.trim();
    if (!trimmed) {
      Alert.alert("Invalid URL", "Please enter a valid backend URL.");
      return;
    }
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      Alert.alert("Invalid URL", "URL must start with http:// or https://");
      return;
    }
    setSaving(true);
    try {
      await setBackendUrl(trimmed);
      await setTerminalWsOverride(wsInput.trim());
      Alert.alert("Saved", "Settings updated.", [
        { text: "OK", onPress: () => navigation.goBack() },
      ]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Backend URL</Text>
          <Text style={styles.hint}>
            Local network: enter your Mac's LAN IP.{"\n"}
            ngrok: paste the https:// tunnel URL for port 3000.
          </Text>
          <Text style={styles.fieldLabel}>Dashboard API URL</Text>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="http://192.168.x.x:3000  or  https://abc.ngrok-free.app"
            placeholderTextColor="#8b949e"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="next"
          />
          <Text style={styles.fieldLabel}>
            Terminal WebSocket URL{" "}
            <Text style={styles.fieldLabelMuted}>(leave blank to auto-derive)</Text>
          </Text>
          <TextInput
            style={styles.input}
            value={wsInput}
            onChangeText={setWsInput}
            placeholder="wss://xyz.ngrok-free.app  (only needed for ngrok)"
            placeholderTextColor="#8b949e"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
          />
          <TouchableOpacity
            style={[styles.saveButton, saving && styles.saveButtonDisabled]}
            onPress={handleSave}
            disabled={saving}
          >
            <Text style={styles.saveButtonText}>{saving ? "Saving…" : "Save"}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Active URLs</Text>
          <InfoRow label="Dashboard" value={backendUrl} />
          <InfoRow
            label="Terminal WS"
            value={terminalWsUrl}
            note={terminalWsOverride ? "manual" : "auto"}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Test Notifications</Text>
          <Text style={styles.hint}>Fire a test notification to verify permissions are working.</Text>
          <TouchableOpacity style={[styles.testButton, { borderColor: "#f85149" }]} onPress={handleTestRespondNotification}>
            <Text style={[styles.testButtonText, { color: "#f85149" }]}>Test "Agent needs input" (respond)</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.testButton, { borderColor: "#3fb950", marginTop: 8 }]} onPress={handleTestMergeNotification}>
            <Text style={[styles.testButtonText, { color: "#3fb950" }]}>Test "PR ready to merge" (merge)</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Setup Guide</Text>
          <Step
            n="1"
            text="Find your Mac's LAN IP: System Settings → Wi-Fi → Details → IP Address"
          />
          <Step n="2" text="Make sure the orchestrator is running: pnpm build && pnpm dev" />
          <Step
            n="3"
            text="Enter http://<YOUR_IP>:3000 above (the terminal server is auto-derived on port 14801)"
          />
          <Step n="4" text="Tap Save and go back to see your sessions" />
          <Step n="5" text="Your phone must be on the same Wi-Fi network as your Mac" />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function InfoRow({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <View style={styles.infoRow}>
      <View style={styles.infoLabelRow}>
        <Text style={styles.infoLabel}>{label}</Text>
        {note ? <Text style={styles.infoNote}>{note}</Text> : null}
      </View>
      <Text style={styles.infoValue} numberOfLines={1} ellipsizeMode="middle">
        {value}
      </Text>
    </View>
  );
}

function Step({ n, text }: { n: string; text: string }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepBadge}>
        <Text style={styles.stepN}>{n}</Text>
      </View>
      <Text style={styles.stepText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0d1117",
  },
  container: {
    flex: 1,
  },
  content: {
    padding: 14,
    paddingBottom: 32,
    gap: 12,
  },
  section: {
    backgroundColor: "#161b22",
    borderRadius: 10,
    padding: 16,
  },
  sectionTitle: {
    color: "#8b949e",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 12,
  },
  hint: {
    color: "#8b949e",
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  input: {
    backgroundColor: "#0d1117",
    borderWidth: 1,
    borderColor: "#30363d",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#e6edf3",
    fontSize: 14,
    fontFamily: "monospace",
    marginBottom: 12,
  },
  saveButton: {
    backgroundColor: "#238636",
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  saveButtonDisabled: {
    backgroundColor: "#21262d",
  },
  saveButtonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  testButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  testButtonText: {
    fontSize: 14,
    fontWeight: "600",
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  infoLabel: {
    color: "#8b949e",
    fontSize: 13,
    width: 100,
  },
  infoValue: {
    color: "#58a6ff",
    fontSize: 13,
    fontFamily: "monospace",
    flex: 1,
    textAlign: "right",
  },
  infoLabelRow: {
    flexDirection: "column",
    width: 100,
  },
  infoNote: {
    color: "#8b949e",
    fontSize: 10,
    marginTop: 1,
  },
  fieldLabel: {
    color: "#8b949e",
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 6,
  },
  fieldLabelMuted: {
    color: "#6e7681",
    fontWeight: "400",
  },
  step: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 12,
    gap: 10,
  },
  stepBadge: {
    backgroundColor: "#21262d",
    borderRadius: 10,
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  stepN: {
    color: "#58a6ff",
    fontSize: 11,
    fontWeight: "700",
  },
  stepText: {
    color: "#8b949e",
    fontSize: 13,
    lineHeight: 18,
    flex: 1,
  },
});
