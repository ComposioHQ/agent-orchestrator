import { Profiler, type ReactNode } from "react";
import { recordRenderProfile } from "../lib/render-profiler";

type RenderProfilerProps = {
	id: string;
	children: ReactNode;
};

// Deliberately development-only: React profiling adds measurement overhead and
// the production build should not carry an active profiler boundary.
export function RenderProfiler({ id, children }: RenderProfilerProps) {
	if (!import.meta.env.DEV) return children;
	return (
		<Profiler id={id} onRender={recordRenderProfile}>
			{children}
		</Profiler>
	);
}
