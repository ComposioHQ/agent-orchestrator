import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import {
  getAttentionLevel,
  relativeTime,
  ATTENTION_COLORS,
  type DashboardSession,
} from "../types";
import AttentionBadge from "./AttentionBadge";

interface Props {
  session: DashboardSession;
  onPress: () => void;
}

export default function SessionCard({ session, onPress }: Props) {
  const level = getAttentionLevel(session);
  const color = ATTENTION_COLORS[level];
  const time = relativeTime(session.lastActivityAt);

  return (
    <TouchableOpacity style={[styles.card, { borderLeftColor: color }]} onPress={onPress} activeOpacity={0.75}>
      <View style={styles.header}>
        <Text style={styles.id} numberOfLines={1} ellipsizeMode="middle">
          {session.id}
        </Text>
        <AttentionBadge level={level} />
      </View>

      {session.issueLabel || session.issueTitle ? (
        <Text style={styles.issue} numberOfLines={1}>
          {session.issueLabel ? `${session.issueLabel}: ` : ""}
          {session.issueTitle ?? ""}
        </Text>
      ) : null}

      {session.summary && !session.summaryIsFallback ? (
        <Text style={styles.summary} numberOfLines={2}>
          {session.summary}
        </Text>
      ) : null}

      <View style={styles.footer}>
        {session.branch ? (
          <Text style={styles.branch} numberOfLines={1}>
            {session.branch}
          </Text>
        ) : null}
        <Text style={styles.time}>{time}</Text>
      </View>

      {session.pr ? (
        <View style={styles.prRow}>
          <Text style={styles.prLabel}>PR #{session.pr.number}</Text>
          {session.pr.ciStatus !== "none" && (
            <Text
              style={[
                styles.ciStatus,
                {
                  color:
                    session.pr.ciStatus === "passing"
                      ? "#3fb950"
                      : session.pr.ciStatus === "failing"
                        ? "#f85149"
                        : "#8b949e",
                },
              ]}
            >
              {session.pr.ciStatus.toUpperCase()}
            </Text>
          )}
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#161b22",
    borderLeftWidth: 3,
    borderRadius: 8,
    padding: 14,
    marginHorizontal: 12,
    marginVertical: 5,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  id: {
    color: "#8b949e",
    fontSize: 12,
    fontFamily: "monospace",
    flex: 1,
    marginRight: 8,
  },
  issue: {
    color: "#e6edf3",
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 4,
  },
  summary: {
    color: "#8b949e",
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 6,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  branch: {
    color: "#58a6ff",
    fontSize: 12,
    fontFamily: "monospace",
    flex: 1,
  },
  time: {
    color: "#8b949e",
    fontSize: 12,
  },
  prRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 6,
    gap: 8,
  },
  prLabel: {
    color: "#3fb950",
    fontSize: 12,
    fontWeight: "600",
  },
  ciStatus: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
});
