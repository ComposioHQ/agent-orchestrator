import { CloudEntryClient } from "./CloudEntryClient";
import { cloudWebMode } from "@/lib/cloud-config";

export const dynamic = "force-dynamic";

export default function CloudEntryPage() {
  return <CloudEntryClient mode={cloudWebMode()} />;
}
