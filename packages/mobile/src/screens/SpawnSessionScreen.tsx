import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { useBackend } from "../context/BackendContext";

type Props = NativeStackScreenProps<RootStackParamList, "SpawnSession">;

export default function SpawnSessionScreen({ navigation }: Props) {
  const { spawnSession } = useBackend();
  const [projectId, setProjectId] = useState("");
  const [issueId, setIssueId] = useState("");
  const [spawning, setSpawning] = useState(false);

  const handleSpawn = useCallback(async () => {
    const trimmedProject = projectId.trim();
    if (!trimmedProject) {
      Alert.alert("Invalid", "Project ID is required.");
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedProject)) {
      Alert.alert("Invalid", "Project ID must be alphanumeric (hyphens and underscores allowed).");
      return;
    }
    const trimmedIssue = issueId.trim();
    if (trimmedIssue && !/^[a-zA-Z0-9_-]+$/.test(trimmedIssue)) {
      Alert.alert("Invalid", "Issue ID must be alphanumeric (hyphens and underscores allowed).");
      return;
    }

    setSpawning(true);
    try {
      const session = await spawnSession(trimmedProject, trimmedIssue || undefined);
      navigation.replace("SessionDetail", { sessionId: session.id });
    } catch (err) {
      Alert.alert("Spawn failed", err instanceof Error ? err.message : "Failed to spawn session");
    } finally {
      setSpawning(false);
    }
  }, [projectId, issueId, spawnSession, navigation]);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Spawn New Session</Text>
          <Text style={styles.hint}>
            Create a new agent session. The orchestrator will assign an agent and workspace.
          </Text>

          <Text style={styles.fieldLabel}>Project ID *</Text>
          <TextInput
            style={styles.input}
            value={projectId}
            onChangeText={setProjectId}
            placeholder="e.g. my-project"
            placeholderTextColor="#8b949e"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
          />

          <Text style={styles.fieldLabel}>
            Issue ID{" "}
            <Text style={styles.fieldLabelMuted}>(optional)</Text>
          </Text>
          <TextInput
            style={styles.input}
            value={issueId}
            onChangeText={setIssueId}
            placeholder="e.g. 42 or PROJ-123"
            placeholderTextColor="#8b949e"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
          />

          <TouchableOpacity
            style={[styles.spawnButton, spawning && styles.spawnButtonDisabled]}
            onPress={handleSpawn}
            disabled={spawning}
          >
            <Text style={styles.spawnButtonText}>
              {spawning ? "Spawning..." : "Spawn Session"}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
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
    marginBottom: 16,
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
    marginBottom: 14,
  },
  spawnButton: {
    backgroundColor: "#238636",
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 4,
  },
  spawnButtonDisabled: {
    backgroundColor: "#21262d",
  },
  spawnButtonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
});
