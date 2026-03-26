import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Keyboard,
  Platform,
  Linking,
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
  isTerminal,
  isPRRateLimited,
  ATTENTION_COLORS,
  type DashboardCICheck,
  type DashboardUnresolvedComment,
  type DashboardPR,
} from "../types";

type Props = NativeStackScreenProps<RootStackParamList, "SessionDetail">;

type ActionButtonState = "idle" | "sending" | "sent" | "error";

export default function SessionDetailScreen({ route, navigation }: Props) {
  const { sessionId } = route.params;
  const { session, loading, error, refresh } = useSession(sessionId);
  const { sendMessage, killSession, restoreSession, mergePR, terminalWsUrl } = useBackend();
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [merging, setMerging] = useState(false);
  const [ciFixState, setCiFixState] = useState<ActionButtonState>("idle");
  const [commentFixStates, setCommentFixStates] = useState<Record<string, ActionButtonState>>({});
  const scrollRef = useRef<ScrollView>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

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

  const handleRestore = useCallback(() => {
    Alert.alert(
      "Restore Session",
      "This will restore the session and make it active again. Are you sure?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Restore",
          onPress: async () => {
            try {
              await restoreSession(sessionId);
              refresh();
            } catch (err) {
              Alert.alert("Error", err instanceof Error ? err.message : "Failed to restore session");
            }
          },
        },
      ],
    );
  }, [restoreSession, sessionId, refresh]);

  const handleOpenTerminal = useCallback(() => {
    navigation.navigate("Terminal", { sessionId, terminalWsUrl });
  }, [navigation, sessionId, terminalWsUrl]);

  const handleMergePR = useCallback(async (prNumber: number) => {
    setMerging(true);
    try {
      await mergePR(prNumber);
      Alert.alert("Merged", `PR #${prNumber} merged successfully.`);
      refresh();
    } catch (err) {
      Alert.alert("Merge failed", err instanceof Error ? err.message : "Failed to merge PR");
    } finally {
      setMerging(false);
    }
  }, [mergePR, refresh]);

  const handleAskFixCI = useCallback(async (pr: DashboardPR) => {
    setCiFixState("sending");
    try {
      await sendMessage(sessionId, `Please fix the failing CI checks on ${pr.url}`);
      setCiFixState("sent");
      setTimeout(() => setCiFixState("idle"), 3000);
    } catch {
      setCiFixState("error");
      setTimeout(() => setCiFixState("idle"), 3000);
    }
  }, [sendMessage, sessionId]);

  const handleAskFixComment = useCallback(async (comment: DashboardUnresolvedComment) => {
    const key = comment.url;
    setCommentFixStates((prev) => ({ ...prev, [key]: "sending" }));
    try {
      const msg = `Please address this review comment:\n\nFile: ${comment.path}\nComment: ${comment.body}\n\nComment URL: ${comment.url}\n\nAfter fixing, mark the comment as resolved at ${comment.url}`;
      await sendMessage(sessionId, msg);
      setCommentFixStates((prev) => ({ ...prev, [key]: "sent" }));
      setTimeout(() => setCommentFixStates((prev) => ({ ...prev, [key]: "idle" })), 3000);
    } catch {
      setCommentFixStates((prev) => ({ ...prev, [key]: "error" }));
      setTimeout(() => setCommentFixStates((prev) => ({ ...prev, [key]: "idle" })), 3000);
    }
  }, [sendMessage, sessionId]);

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
  const isDone = isTerminal(session);
  const pr = session.pr;
  const isReadyToMerge = pr?.mergeability.mergeable && pr.state === "open" && !isPRRateLimited(pr);
  const failedChecks = pr?.ciChecks.filter((c) => c.status === "failed") ?? [];
  const unresolvedComments = pr?.unresolvedComments ?? [];

  return (
    <View style={styles.root}>
      <ScrollView ref={scrollRef} style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
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

        {/* Alerts */}
        {pr && pr.ciStatus === "failing" && failedChecks.length > 0 && (
          <View style={styles.alertCard}>
            <View style={styles.alertRow}>
              <Text style={styles.alertText}>
                {failedChecks.length} CI check{failedChecks.length > 1 ? "s" : ""} failing
              </Text>
              <ActionButton
                state={ciFixState}
                label="Ask to fix"
                onPress={() => handleAskFixCI(pr)}
              />
            </View>
          </View>
        )}

        {pr && !pr.mergeability.noConflicts && (
          <View style={[styles.alertCard, { borderLeftColor: "#d29922" }]}>
            <Text style={[styles.alertText, { color: "#d29922" }]}>Merge conflict</Text>
          </View>
        )}

        {pr && pr.reviewDecision === "changes_requested" && (
          <View style={[styles.alertCard, { borderLeftColor: "#d29922" }]}>
            <Text style={[styles.alertText, { color: "#d29922" }]}>Changes requested</Text>
          </View>
        )}

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
        {pr && (
          <Section title={`PR #${pr.number}`}>
            <TouchableOpacity onPress={() => Linking.openURL(pr.url)}>
              <Text style={[styles.issueText, { color: "#58a6ff", marginBottom: 8 }]} numberOfLines={2}>
                {pr.title}
              </Text>
            </TouchableOpacity>
            <InfoRow label="CI" value={pr.ciStatus} valueColor={pr.ciStatus === "passing" ? "#3fb950" : pr.ciStatus === "failing" ? "#f85149" : undefined} />
            <InfoRow label="Review" value={pr.reviewDecision} valueColor={pr.reviewDecision === "approved" ? "#3fb950" : pr.reviewDecision === "changes_requested" ? "#f85149" : undefined} />
            <InfoRow label="Mergeable" value={pr.mergeability.mergeable ? "Yes" : "No"} valueColor={pr.mergeability.mergeable ? "#3fb950" : "#f85149"} />
            <InfoRow label="Changes" value={`+${pr.additions} / -${pr.deletions}`} />
            {pr.isDraft && <InfoRow label="Draft" value="Yes" />}
            {pr.mergeability.blockers.length > 0 && (
              <View style={{ marginTop: 6 }}>
                <Text style={styles.blockersLabel}>Blockers:</Text>
                {pr.mergeability.blockers.map((b, i) => (
                  <Text key={i} style={styles.blockerText}>- {b}</Text>
                ))}
              </View>
            )}
          </Section>
        )}

        {/* CI Checks */}
        {pr && pr.ciChecks.length > 0 && (
          <Section title="CI Checks">
            {pr.ciChecks.map((check, i) => (
              <CICheckRow key={i} check={check} />
            ))}
          </Section>
        )}

        {/* Unresolved Comments */}
        {unresolvedComments.length > 0 && (
          <Section title={`Unresolved Comments (${unresolvedComments.length})`}>
            {unresolvedComments.map((comment, i) => (
              <View key={i} style={styles.commentCard}>
                <View style={styles.commentHeader}>
                  <Text style={styles.commentAuthor}>{comment.author}</Text>
                  <Text style={styles.commentPath} numberOfLines={1}>{comment.path}</Text>
                </View>
                <Text style={styles.commentBody} numberOfLines={4}>{comment.body}</Text>
                <View style={styles.commentActions}>
                  <ActionButton
                    state={commentFixStates[comment.url] ?? "idle"}
                    label="Ask Agent to Fix"
                    onPress={() => handleAskFixComment(comment)}
                  />
                  <TouchableOpacity onPress={() => Linking.openURL(comment.url)}>
                    <Text style={styles.viewLink}>View</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </Section>
        )}

        {/* Timestamps */}
        <Section title="Timing">
          <InfoRow label="Created" value={relativeTime(session.createdAt)} />
          <InfoRow label="Last activity" value={relativeTime(session.lastActivityAt)} />
        </Section>

        {/* Actions */}
        <View style={styles.actionsSection}>
          {isReadyToMerge && (
            <TouchableOpacity
              style={[styles.actionButton, styles.mergeButton]}
              onPress={() => handleMergePR(pr.number)}
              disabled={merging}
            >
              {merging ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={[styles.actionButtonText, { color: "#fff" }]}>
                  Merge PR #{pr.number}
                </Text>
              )}
            </TouchableOpacity>
          )}

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
        <View style={[styles.messageBar, { paddingBottom: keyboardHeight > 0 ? keyboardHeight + 48 : 10 }]}>
          <TextInput
            style={styles.messageInput}
            placeholder="Send message to agent..."
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
              <Text style={styles.sendButtonText}>Send</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
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

function InfoRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, valueColor ? { color: valueColor } : undefined]}>{value}</Text>
    </View>
  );
}

const CI_STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  passed: { icon: "\u2713", color: "#3fb950" },
  failed: { icon: "\u2717", color: "#f85149" },
  running: { icon: "\u25CF", color: "#e3b341" },
  pending: { icon: "\u25CF", color: "#8b949e" },
  skipped: { icon: "\u2014", color: "#6e7681" },
};

function CICheckRow({ check }: { check: DashboardCICheck }) {
  const info = CI_STATUS_ICONS[check.status] ?? CI_STATUS_ICONS.pending;
  return (
    <TouchableOpacity
      style={styles.ciCheckRow}
      onPress={check.url ? () => Linking.openURL(check.url!) : undefined}
      disabled={!check.url}
    >
      <Text style={[styles.ciCheckIcon, { color: info.color }]}>{info.icon}</Text>
      <Text style={styles.ciCheckName} numberOfLines={1}>{check.name}</Text>
      <Text style={[styles.ciCheckStatus, { color: info.color }]}>{check.status}</Text>
    </TouchableOpacity>
  );
}

function ActionButton({ state, label, onPress }: { state: ActionButtonState; label: string; onPress: () => void }) {
  const isDisabled = state === "sending" || state === "sent";
  const bgColor = state === "sent" ? "#1f3a2a" : state === "error" ? "#3d1f20" : "#21262d";
  const borderColor = state === "sent" ? "#3fb950" : state === "error" ? "#f85149" : "#30363d";
  const textColor = state === "sent" ? "#3fb950" : state === "error" ? "#f85149" : "#58a6ff";
  const text = state === "sending" ? "Sending..." : state === "sent" ? "Sent" : state === "error" ? "Failed" : label;

  return (
    <TouchableOpacity
      style={[styles.inlineActionButton, { backgroundColor: bgColor, borderColor }]}
      onPress={onPress}
      disabled={isDisabled}
    >
      {state === "sending" ? (
        <ActivityIndicator color="#58a6ff" size="small" />
      ) : (
        <Text style={[styles.inlineActionText, { color: textColor }]}>{text}</Text>
      )}
    </TouchableOpacity>
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
  // Alerts
  alertCard: {
    backgroundColor: "#3d1f20",
    borderLeftWidth: 3,
    borderLeftColor: "#f85149",
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
  },
  alertRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  alertText: {
    color: "#f85149",
    fontSize: 13,
    fontWeight: "600",
    flex: 1,
  },
  // Sections
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
  blockersLabel: {
    color: "#f85149",
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 4,
  },
  blockerText: {
    color: "#f85149",
    fontSize: 12,
    marginLeft: 4,
    marginBottom: 2,
  },
  // CI Checks
  ciCheckRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    gap: 8,
  },
  ciCheckIcon: {
    fontSize: 14,
    fontWeight: "700",
    width: 18,
    textAlign: "center",
  },
  ciCheckName: {
    color: "#e6edf3",
    fontSize: 13,
    flex: 1,
  },
  ciCheckStatus: {
    fontSize: 11,
    fontWeight: "600",
  },
  // Unresolved Comments
  commentCard: {
    backgroundColor: "#0d1117",
    borderRadius: 6,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#30363d",
  },
  commentHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  commentAuthor: {
    color: "#e6edf3",
    fontSize: 12,
    fontWeight: "600",
  },
  commentPath: {
    color: "#8b949e",
    fontSize: 11,
    fontFamily: "monospace",
    flex: 1,
    textAlign: "right",
    marginLeft: 8,
  },
  commentBody: {
    color: "#8b949e",
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 8,
  },
  commentActions: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  viewLink: {
    color: "#58a6ff",
    fontSize: 13,
    fontWeight: "600",
  },
  // Inline action button (for "Ask to fix", etc.)
  inlineActionButton: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 80,
    alignItems: "center",
  },
  inlineActionText: {
    fontSize: 12,
    fontWeight: "600",
  },
  // Main actions
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
  mergeButton: {
    backgroundColor: "#238636",
    borderColor: "#2ea043",
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
    paddingHorizontal: 16,
    height: 40,
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
