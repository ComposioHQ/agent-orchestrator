import React from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";

const CLI_COMMANDS = [
  { cmd: "ao start [project]", desc: "Start orchestrator + dashboard" },
  { cmd: "ao stop [project]", desc: "Stop orchestrator + dashboard" },
  { cmd: "ao spawn <project> [issue]", desc: "Spawn a session for an issue" },
  { cmd: "ao batch-spawn <project> <issues...>", desc: "Spawn multiple sessions" },
  { cmd: "ao session ls [-p <project>]", desc: "List all active sessions" },
  { cmd: "ao session kill <session>", desc: "Kill a session" },
  { cmd: "ao session restore <session>", desc: "Restore a crashed session" },
  { cmd: "ao session cleanup [-p <project>]", desc: "Clean up merged/closed sessions" },
  { cmd: "ao send <session> [message]", desc: "Send message to a session" },
  { cmd: "ao status [-p <project>]", desc: "Show sessions with PR/CI status" },
  { cmd: "ao review-check [project]", desc: "Check PRs and trigger agents" },
  { cmd: "ao dashboard [-p <port>]", desc: "Start the web dashboard" },
  { cmd: "ao open [target]", desc: "Open session(s) in terminal" },
  { cmd: "ao init [project]", desc: "Initialize config file" },
];

export default function CommandsScreen() {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <Text style={styles.hint}>Quick reference for managing sessions from terminal.</Text>
        {CLI_COMMANDS.map((c, i) => (
          <View key={i} style={styles.cmdRow}>
            <Text style={styles.cmdText}>{c.cmd}</Text>
            <Text style={styles.cmdDesc}>{c.desc}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
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
  },
  section: {
    backgroundColor: "#161b22",
    borderRadius: 10,
    padding: 16,
  },
  hint: {
    color: "#8b949e",
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  cmdRow: {
    backgroundColor: "#0d1117",
    borderRadius: 6,
    padding: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: "#30363d",
  },
  cmdText: {
    color: "#58a6ff",
    fontSize: 12,
    fontFamily: "monospace",
    marginBottom: 4,
  },
  cmdDesc: {
    color: "#8b949e",
    fontSize: 12,
  },
});
