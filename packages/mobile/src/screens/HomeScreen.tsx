import React from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { useSessions } from "../hooks/useSessions";
import { useSessionNotifications } from "../hooks/useSessionNotifications";
import SessionCard from "../components/SessionCard";
import StatBar from "../components/StatBar";
import { getAttentionLevel, type DashboardSession } from "../types";

type Props = NativeStackScreenProps<RootStackParamList, "Home">;

const ATTENTION_ORDER = ["respond", "merge", "review", "pending", "working", "done"] as const;

function sortSessions(sessions: DashboardSession[]): DashboardSession[] {
  return [...sessions].sort((a, b) => {
    const la = getAttentionLevel(a);
    const lb = getAttentionLevel(b);
    const ia = ATTENTION_ORDER.indexOf(la);
    const ib = ATTENTION_ORDER.indexOf(lb);
    if (ia !== ib) return ia - ib;
    return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
  });
}

export default function HomeScreen({ navigation }: Props) {
  const { sessions, stats, loading, error, refresh } = useSessions();
  useSessionNotifications(sessions);

  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity
          onPress={() => navigation.navigate("Settings")}
          style={{ paddingRight: 4 }}
        >
          <Text style={{ color: "#58a6ff", fontSize: 16 }}>⚙</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation]);

  const sorted = sortSessions(sessions);

  if (loading && sessions.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#58a6ff" size="large" />
        <Text style={styles.loadingText}>Connecting…</Text>
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
        <TouchableOpacity
          style={[styles.retryButton, { marginTop: 8 }]}
          onPress={() => navigation.navigate("Settings")}
        >
          <Text style={styles.retryText}>Configure Backend URL</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {stats && <StatBar stats={stats} />}
      <FlatList
        data={sorted}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <SessionCard
            session={item}
            onPress={() => navigation.navigate("SessionDetail", { sessionId: item.id })}
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={refresh}
            tintColor="#58a6ff"
            colors={["#58a6ff"]}
          />
        }
        contentContainerStyle={
          sorted.length === 0 ? styles.emptyContainer : styles.listContent
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyText}>No sessions</Text>
            <Text style={styles.emptySubtext}>Sessions will appear here when agents are running</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0d1117",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  emptyContainer: {
    flex: 1,
  },
  listContent: {
    paddingVertical: 8,
  },
  loadingText: {
    color: "#8b949e",
    marginTop: 12,
    fontSize: 14,
  },
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
  emptyText: {
    color: "#e6edf3",
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 8,
  },
  emptySubtext: {
    color: "#8b949e",
    fontSize: 13,
    textAlign: "center",
  },
});
