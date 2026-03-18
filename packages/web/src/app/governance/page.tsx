import type { Metadata } from "next";
import { GovernancePanel } from "@/components/governance/GovernancePanel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Governance",
};

export default function GovernancePage() {
  return <GovernancePanel />;
}
