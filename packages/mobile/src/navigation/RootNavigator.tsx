import React from "react";
import { NavigationContainer, DarkTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import HomeScreen from "../screens/HomeScreen";
import SessionDetailScreen from "../screens/SessionDetailScreen";
import TerminalScreen from "../screens/TerminalScreen";
import SettingsScreen from "../screens/SettingsScreen";

export type RootStackParamList = {
  Home: undefined;
  SessionDetail: { sessionId: string };
  Terminal: { sessionId: string; terminalWsUrl: string };
  Settings: undefined;
};

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
    <NavigationContainer theme={AoDarkTheme}>
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
      </Stack.Navigator>
    </NavigationContainer>
  );
}
