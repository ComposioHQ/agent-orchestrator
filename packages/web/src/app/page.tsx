import { Dashboard } from "@/components/Dashboard";
import { mockSessions, getMockStats } from "@/lib/mock-data";

export default function Home() {
  return <Dashboard sessions={mockSessions} stats={getMockStats()} />;
}
