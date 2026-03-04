import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  Alert,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { useSessions } from "../hooks/useSessions";
import { useSession } from "../hooks/useSession";
import { useBackend } from "../context/BackendContext";
import AttentionBadge from "../components/AttentionBadge";
import {
  getAttentionLevel,
  relativeTime,
  ATTENTION_COLORS,
  type DashboardSession,
} from "../types";

type Props = NativeStackScreenProps<RootStackParamList, "Orchestrator">;

function getZoneCounts(sessions: DashboardSession[]) {
  const counts = { merge: 0, respond: 0, review: 0, pending: 0, working: 0, done: 0 };
  for (const s of sessions) {
    const level = getAttentionLevel(s);
    counts[level]++;
  }
  return counts;
}

export default function OrchestratorScreen({ navigation }: Props) {
  const { sessions, orchestratorId, loading, error, refresh } = useSessions();
  const { sendMessage, terminalWsUrl } = useBackend();
  const { session: orchSession } = useSession(orchestratorId ?? "", { enabled: !!orchestratorId });
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity onPress={() => navigation.navigate("Commands")}>
          <Text style={{ color: "#58a6ff", fontSize: 14, fontWeight: "600" }}>Commands</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation]);

  const zones = getZoneCounts(sessions);

  const handleSend = useCallback(async () => {
    if (!message.trim() || !orchestratorId) return;
    setSending(true);
    try {
      await sendMessage(orchestratorId, message.trim());
      setMessage("");
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }, [message, sendMessage, orchestratorId]);

  if (loading && sessions.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#58a6ff" size="large" />
      </View>
    );
  }

  if (error && sessions.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={refresh}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const orchLevel = orchSession ? getAttentionLevel(orchSession) : null;
  const orchColor = orchLevel ? ATTENTION_COLORS[orchLevel] : "#8b949e";

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Orchestrator Session Details */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Orchestrator</Text>
        {orchestratorId && orchSession ? (
          <View style={[styles.orchDetailCard, { borderLeftColor: orchColor }]}>
            <View style={styles.orchHeaderRow}>
              <View style={styles.orchStatusRow}>
                <View style={[styles.dot, { backgroundColor: "#3fb950" }]} />
                <Text style={styles.orchRunning}>Running</Text>
              </View>
              <AttentionBadge level={orchLevel!} />
            </View>
            <Text style={styles.orchId}>{orchestratorId}</Text>
            <Text style={styles.orchStatus}>
              {orchSession.status}
              {orchSession.activity ? ` · ${orchSession.activity}` : ""}
            </Text>
            {orchSession.summary && !orchSession.summaryIsFallback && (
              <Text style={styles.orchSummary} numberOfLines={3}>{orchSession.summary}</Text>
            )}
            <View style={styles.orchTimingRow}>
              <Text style={styles.orchTiming}>Last activity: {relativeTime(orchSession.lastActivityAt)}</Text>
            </View>

            {/* Actions */}
            <View style={styles.orchActions}>
              <TouchableOpacity
                style={styles.terminalButton}
                onPress={() => navigation.navigate("Terminal", { sessionId: orchestratorId, terminalWsUrl })}
              >
                <Text style={styles.terminalButtonText}>Open Terminal</Text>
              </TouchableOpacity>
            </View>

            {/* Send message */}
            <View style={styles.orchMessageRow}>
              <TextInput
                style={styles.orchMessageInput}
                placeholder="Send message to orchestrator..."
                placeholderTextColor="#8b949e"
                value={message}
                onChangeText={setMessage}
                returnKeyType="send"
                onSubmitEditing={handleSend}
              />
              <TouchableOpacity
                style={[styles.sendButton, (!message.trim() || sending) && styles.sendButtonDisabled]}
                onPress={handleSend}
                disabled={!message.trim() || sending}
              >
                {sending ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.sendButtonText}>Send</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={styles.orchDetailCard}>
            <View style={styles.orchStatusRow}>
              <View style={[styles.dot, { backgroundColor: "#8b949e" }]} />
              <Text style={[styles.orchRunning, { color: "#8b949e" }]}>Not running</Text>
            </View>
            <Text style={styles.orchHint}>Start with: ao start &lt;project&gt;</Text>
          </View>
        )}
      </View>

      {/* Zone Overview */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Session Zones</Text>
        <View style={styles.zonesGrid}>
          <ZoneBadge label="Merge" count={zones.merge} color="#3fb950" />
          <ZoneBadge label="Respond" count={zones.respond} color="#f85149" />
          <ZoneBadge label="Review" count={zones.review} color="#d29922" />
          <ZoneBadge label="Pending" count={zones.pending} color="#e3b341" />
          <ZoneBadge label="Working" count={zones.working} color="#58a6ff" />
          <ZoneBadge label="Done" count={zones.done} color="#8b949e" />
        </View>
      </View>

    </ScrollView>
  );
}

function ZoneBadge({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <View style={styles.zoneBadge}>
      <Text style={[styles.zoneCount, { color }]}>{count}</Text>
      <Text style={styles.zoneLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0d1117",
  },
  content: {
    padding: 14,
    paddingBottom: 32,
    gap: 12,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#0d1117",
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
  // Orchestrator detail card
  orchDetailCard: {
    backgroundColor: "#0d1117",
    borderWidth: 1,
    borderColor: "#30363d",
    borderLeftWidth: 3,
    borderRadius: 8,
    padding: 14,
  },
  orchHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  orchStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  orchRunning: {
    color: "#3fb950",
    fontSize: 15,
    fontWeight: "600",
  },
  orchId: {
    color: "#8b949e",
    fontSize: 12,
    fontFamily: "monospace",
    marginBottom: 4,
  },
  orchStatus: {
    color: "#8b949e",
    fontSize: 13,
    marginBottom: 4,
  },
  orchSummary: {
    color: "#e6edf3",
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 4,
  },
  orchTimingRow: {
    marginBottom: 10,
  },
  orchTiming: {
    color: "#6e7681",
    fontSize: 12,
  },
  orchHint: {
    color: "#6e7681",
    fontSize: 12,
    marginTop: 4,
  },
  orchActions: {
    marginBottom: 10,
  },
  terminalButton: {
    backgroundColor: "#21262d",
    borderWidth: 1,
    borderColor: "#30363d",
    borderRadius: 8,
    padding: 12,
    alignItems: "center",
  },
  terminalButtonText: {
    color: "#e6edf3",
    fontSize: 14,
    fontWeight: "600",
  },
  orchMessageRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  orchMessageInput: {
    flex: 1,
    backgroundColor: "#161b22",
    borderWidth: 1,
    borderColor: "#30363d",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: "#e6edf3",
    fontSize: 14,
  },
  sendButton: {
    backgroundColor: "#238636",
    borderRadius: 8,
    paddingHorizontal: 14,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonDisabled: {
    backgroundColor: "#21262d",
  },
  sendButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
  // Zones grid
  zonesGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  zoneBadge: {
    backgroundColor: "#0d1117",
    borderWidth: 1,
    borderColor: "#30363d",
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: "center",
    minWidth: 90,
    flex: 1,
  },
  zoneCount: {
    fontSize: 22,
    fontWeight: "700",
  },
  zoneLabel: {
    color: "#8b949e",
    fontSize: 11,
    fontWeight: "600",
    marginTop: 2,
  },
  // Error
  errorText: {
    color: "#f85149",
    fontSize: 14,
    textAlign: "center",
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: "#21262d",
    borderWidth: 1,
    borderColor: "#30363d",
    borderRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  retryText: {
    color: "#e6edf3",
    fontSize: 14,
  },
});
