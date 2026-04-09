import "./design-system.css";
import { DesignSystemShowcase } from "@/components/DesignSystemShowcase";

export default function DesignSystemPage() {
  return (
    <main className="min-h-screen bg-[var(--color-bg-base)]">
      <DesignSystemShowcase />
    </main>
  );
}
