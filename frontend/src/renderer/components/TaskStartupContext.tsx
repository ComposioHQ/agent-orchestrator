import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

const TaskStartupContext = createContext<{ covered: boolean; register: () => () => void } | null>(null);

// Both new-task entry points can own a startup. Reference counting keeps the
// underlying route covered until the last visible startup releases ownership.
export function TaskStartupProvider({ children }: { children: ReactNode }) {
	const [owners, setOwners] = useState(0);
	const register = useCallback(() => {
		setOwners((count) => count + 1);
		return () => setOwners((count) => count - 1);
	}, []);
	const value = useMemo(() => ({ covered: owners > 0, register }), [owners, register]);
	return <TaskStartupContext.Provider value={value}>{children}</TaskStartupContext.Provider>;
}

export function useTaskStartupVisibility(visible: boolean) {
	const register = useContext(TaskStartupContext)?.register;
	useLayoutEffect(() => {
		if (visible) return register?.();
		return undefined;
	}, [visible, register]);
}

export function TaskStartupRoute({ children }: { children: ReactNode }) {
	const covered = useContext(TaskStartupContext)?.covered ?? false;
	return (
		<div
			inert={covered ? true : undefined}
			aria-hidden={covered ? true : undefined}
			className={`min-h-0 flex-1 overflow-x-hidden${covered ? " invisible" : ""}`}
			data-testid="task-startup-underlying-route"
		>
			{children}
		</div>
	);
}
