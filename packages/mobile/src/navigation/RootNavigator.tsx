import React from "react";
import { NavigationContainer, DarkTheme, createNavigationContainerRef } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import HomeScreen from "../screens/HomeScreen";
import SessionDetailScreen from "../screens/SessionDetailScreen";
import TerminalScreen from "../screens/TerminalScreen";
import SettingsScreen from "../screens/SettingsScreen";
import SpawnSessionScreen from "../screens/SpawnSessionScreen";
import OrchestratorScreen from "../screens/OrchestratorScreen";
import CommandsScreen from "../screens/CommandsScreen";

export type RootStackParamList = {
  Home: undefined;
  SessionDetail: { sessionId: string };
  Terminal: { sessionId: string; terminalWsUrl: string };
  Settings: undefined;
  SpawnSession: undefined;
  Orchestrator: undefined;
  Commands: undefined;
};

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

const Stack = createNativeStackNavigator<RootStackParamList>();

const AoDarkTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: "#0d1117",
    card: "#161b22",
    text: "#e6edf3",
    border: "#30363d",
    primary: "#58a6ff",
  },
};

export default function RootNavigator() {
  return (
    <NavigationContainer ref={navigationRef} theme={AoDarkTheme}>
      <Stack.Navigator
        initialRouteName="Home"
        screenOptions={{
          headerStyle: { backgroundColor: "#161b22" },
          headerTintColor: "#e6edf3",
          headerTitleStyle: { fontWeight: "600" },
        }}
      >
        <Stack.Screen
          name="Home"
          component={HomeScreen}
          options={{ title: "Agent Orchestrator" }}
        />
        <Stack.Screen
          name="SessionDetail"
          component={SessionDetailScreen}
          options={{ title: "Session" }}
        />
        <Stack.Screen
          name="Terminal"
          component={TerminalScreen}
          options={{
            title: "Terminal",
            headerStyle: { backgroundColor: "#0d1117" },
          }}
        />
        <Stack.Screen
          name="Settings"
          component={SettingsScreen}
          options={{ title: "Settings" }}
        />
        <Stack.Screen
          name="SpawnSession"
          component={SpawnSessionScreen}
          options={{ title: "New Session" }}
        />
        <Stack.Screen
          name="Orchestrator"
          component={OrchestratorScreen}
          options={{ title: "Orchestrator" }}
        />
        <Stack.Screen
          name="Commands"
          component={CommandsScreen}
          options={{ title: "CLI Commands" }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
