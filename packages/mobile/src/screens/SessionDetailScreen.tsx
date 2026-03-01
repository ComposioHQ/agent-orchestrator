import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { useSession } from "../hooks/useSession";
import { useBackend } from "../context/BackendContext";
import AttentionBadge from "../components/AttentionBadge";
import {
  getAttentionLevel,
  relativeTime,
  isRestorable,
  ATTENTION_COLORS,
} from "../types";

type Props = NativeStackScreenProps<RootStackParamList, "SessionDetail">;

export default function SessionDetailScreen({ route, navigation }: Props) {
  const { sessionId } = route.params;
  const { session, loading, error, refresh } = useSession(sessionId);
  const { sendMessage, killSession, restoreSession, terminalWsUrl } = useBackend();
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(async () => {
    if (!message.trim()) return;
    setSending(true);
    try {
      await sendMessage(sessionId, message.trim());
      setMessage("");
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }, [message, sendMessage, sessionId]);

  const handleKill = useCallback(() => {
    Alert.alert(
      "Kill Session",
      "This will terminate the agent process. Are you sure?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Kill",
          style: "destructive",
          onPress: async () => {
            try {
              await killSession(sessionId);
              refresh();
            } catch (err) {
              Alert.alert("Error", err instanceof Error ? err.message : "Failed to kill session");
            }
          },
        },
      ],
    );
  }, [killSession, sessionId, refresh]);

  const handleRestore = useCallback(async () => {
    try {
      await restoreSession(sessionId);
      refresh();
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to restore session");
    }
  }, [restoreSession, sessionId, refresh]);

  const handleOpenTerminal = useCallback(() => {
    navigation.navigate("Terminal", { sessionId, terminalWsUrl });
  }, [navigation, sessionId, terminalWsUrl]);

  if (loading && !session) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#58a6ff" size="large" />
      </View>
    );
  }

  if (error && !session) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.button} onPress={refresh}>
          <Text style={styles.buttonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!session) return null;

  const level = getAttentionLevel(session);
  const color = ATTENTION_COLORS[level];
  const canRestore = isRestorable(session);
  const isDone =
    session.status === "merged" ||
    session.status === "killed" ||
    session.status === "done" ||
    session.status === "terminated";

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={88}
    >
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Header row */}
        <View style={[styles.headerCard, { borderLeftColor: color }]}>
          <View style={styles.headerRow}>
            <Text style={styles.sessionId} numberOfLines={1} ellipsizeMode="middle">
              {session.id}
            </Text>
            <AttentionBadge level={level} />
          </View>
          <Text style={styles.status}>
            {session.status}
            {session.activity ? ` · ${session.activity}` : ""}
          </Text>
        </View>

        {/* Issue */}
        {(session.issueLabel || session.issueTitle) && (
          <Section title="Issue">
            <Text style={styles.issueText}>
              {session.issueLabel ? `${session.issueLabel}: ` : ""}
              {session.issueTitle ?? ""}
            </Text>
          </Section>
        )}

        {/* Summary */}
        {session.summary && !session.summaryIsFallback && (
          <Section title="Summary">
            <Text style={styles.bodyText}>{session.summary}</Text>
          </Section>
        )}

        {/* Branch */}
        {session.branch && (
          <Section title="Branch">
            <Text style={styles.monoText}>{session.branch}</Text>
          </Section>
        )}

        {/* PR */}
        {session.pr && (
          <Section title={`PR #${session.pr.number}`}>
            <InfoRow label="Title" value={session.pr.title} />
            <InfoRow label="CI" value={session.pr.ciStatus} />
            <InfoRow label="Review" value={session.pr.reviewDecision} />
            <InfoRow label="Mergeable" value={session.pr.mergeability.mergeable ? "Yes" : "No"} />
            {session.pr.additions > 0 && (
              <InfoRow
                label="Changes"
                value={`+${session.pr.additions} / -${session.pr.deletions}`}
              />
            )}
          </Section>
        )}

        {/* Timestamps */}
        <Section title="Timing">
          <InfoRow label="Created" value={relativeTime(session.createdAt)} />
          <InfoRow label="Last activity" value={relativeTime(session.lastActivityAt)} />
        </Section>

        {/* Actions */}
        <View style={styles.actionsSection}>
          <TouchableOpacity style={[styles.actionButton, styles.terminalButton]} onPress={handleOpenTerminal}>
            <Text style={styles.actionButtonText}>Open Terminal</Text>
          </TouchableOpacity>

          {canRestore && (
            <TouchableOpacity style={[styles.actionButton, styles.restoreButton]} onPress={handleRestore}>
              <Text style={styles.actionButtonText}>Restore Session</Text>
            </TouchableOpacity>
          )}

          {!isDone && (
            <TouchableOpacity style={[styles.actionButton, styles.killButton]} onPress={handleKill}>
              <Text style={[styles.actionButtonText, { color: "#f85149" }]}>Kill Session</Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>

      {/* Message input — only show for active sessions */}
      {!isDone && (
        <View style={styles.messageBar}>
          <TextInput
            style={styles.messageInput}
            placeholder="Send message to agent…"
            placeholderTextColor="#8b949e"
            value={message}
            onChangeText={setMessage}
            multiline
            returnKeyType="send"
            onSubmitEditing={handleSend}
            blurOnSubmit={false}
          />
          <TouchableOpacity
            style={[styles.sendButton, (!message.trim() || sending) && styles.sendButtonDisabled]}
            onPress={handleSend}
            disabled={!message.trim() || sending}
          >
            {sending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.sendButtonText}>↑</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
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
    padding: 12,
    paddingBottom: 24,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#0d1117",
  },
  headerCard: {
    backgroundColor: "#161b22",
    borderLeftWidth: 3,
    borderRadius: 8,
    padding: 14,
    marginBottom: 12,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  sessionId: {
    color: "#8b949e",
    fontSize: 13,
    fontFamily: "monospace",
    flex: 1,
    marginRight: 8,
  },
  status: {
    color: "#8b949e",
    fontSize: 13,
  },
  section: {
    backgroundColor: "#161b22",
    borderRadius: 8,
    padding: 14,
    marginBottom: 10,
  },
  sectionTitle: {
    color: "#8b949e",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  bodyText: {
    color: "#e6edf3",
    fontSize: 14,
    lineHeight: 20,
  },
  issueText: {
    color: "#e6edf3",
    fontSize: 14,
    fontWeight: "600",
  },
  monoText: {
    color: "#58a6ff",
    fontSize: 13,
    fontFamily: "monospace",
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  infoLabel: {
    color: "#8b949e",
    fontSize: 13,
  },
  infoValue: {
    color: "#e6edf3",
    fontSize: 13,
    fontWeight: "500",
  },
  actionsSection: {
    gap: 8,
    marginTop: 4,
  },
  actionButton: {
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    borderWidth: 1,
  },
  terminalButton: {
    backgroundColor: "#21262d",
    borderColor: "#30363d",
  },
  restoreButton: {
    backgroundColor: "#1f3a2a",
    borderColor: "#3fb950",
  },
  killButton: {
    backgroundColor: "#21262d",
    borderColor: "#30363d",
  },
  actionButtonText: {
    color: "#e6edf3",
    fontSize: 15,
    fontWeight: "600",
  },
  messageBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 10,
    backgroundColor: "#161b22",
    borderTopWidth: 1,
    borderTopColor: "#30363d",
    gap: 8,
  },
  messageInput: {
    flex: 1,
    backgroundColor: "#0d1117",
    borderWidth: 1,
    borderColor: "#30363d",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: "#e6edf3",
    fontSize: 14,
    maxHeight: 100,
  },
  sendButton: {
    backgroundColor: "#238636",
    borderRadius: 8,
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonDisabled: {
    backgroundColor: "#21262d",
  },
  sendButtonText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
  },
  button: {
    backgroundColor: "#21262d",
    borderWidth: 1,
    borderColor: "#30363d",
    borderRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  buttonText: {
    color: "#e6edf3",
    fontSize: 14,
  },
  errorText: {
    color: "#f85149",
    fontSize: 14,
    textAlign: "center",
    marginBottom: 16,
  },
});
