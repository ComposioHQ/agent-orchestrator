import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { ATTENTION_COLORS, type AttentionLevel } from "../types";

interface Props {
  level: AttentionLevel;
}

const LABELS: Record<AttentionLevel, string> = {
  merge: "MERGE",
  respond: "RESPOND",
  review: "REVIEW",
  pending: "PENDING",
  working: "WORKING",
  done: "DONE",
};

export default function AttentionBadge({ level }: Props) {
  const color = ATTENTION_COLORS[level];
  return (
    <View style={[styles.badge, { borderColor: color, backgroundColor: color + "22" }]}>
      <Text style={[styles.label, { color }]}>{LABELS[level]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  label: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
});
