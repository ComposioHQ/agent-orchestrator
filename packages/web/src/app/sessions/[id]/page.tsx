import { notFound } from "next/navigation";
import { getMockSession } from "@/lib/mock-data";
import { SessionDetail } from "@/components/SessionDetail";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function SessionPage({ params }: Props) {
  const { id } = await params;
  const session = getMockSession(id);

  if (!session) {
    notFound();
  }

  return <SessionDetail session={session} />;
}
