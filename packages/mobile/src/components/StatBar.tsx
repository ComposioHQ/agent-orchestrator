import React from "react";
import { View, Text, StyleSheet } from "react-native";
import type { DashboardStats } from "../types";

interface Props {
  stats: DashboardStats;
}

export default function StatBar({ stats }: Props) {
  return (
    <View style={styles.container}>
      <StatItem label="Sessions" value={stats.totalSessions} color="#e6edf3" />
      <StatItem label="Working" value={stats.workingSessions} color="#58a6ff" />
      <StatItem label="PRs" value={stats.openPRs} color="#3fb950" />
      <StatItem label="Review" value={stats.needsReview} color="#d29922" />
    </View>
  );
}

function StatItem({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={styles.item}>
      <Text style={[styles.value, { color }]}>{value}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    justifyContent: "space-around",
    backgroundColor: "#161b22",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#30363d",
  },
  item: {
    alignItems: "center",
  },
  value: {
    fontSize: 20,
    fontWeight: "700",
  },
  label: {
    fontSize: 11,
    color: "#8b949e",
    marginTop: 2,
  },
});
