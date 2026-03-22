import type { Metadata } from "next";

export async function generateMetadata(props: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await props.params;
  return { title: { absolute: `${id} | Session Detail` } };
}

export default function SessionLayout({ children }: { children: React.ReactNode }) {
  return children;
}
