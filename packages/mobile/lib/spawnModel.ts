export type SpawnModelDefaults = {
	selectedAgent: string;
	projectWorkerAgent?: string;
	projectWorkerModel?: string;
	catalogDefault?: string;
};

export function resolveSpawnModel(input: SpawnModelDefaults): string {
	if (input.selectedAgent === input.projectWorkerAgent && input.projectWorkerModel) {
		return input.projectWorkerModel;
	}
	return input.catalogDefault ?? "";
}

export function modelOverride(value: string, resolvedDefault: string, touched: boolean): string | undefined {
	if (!touched) return undefined;
	const clean = value.trim();
	return clean !== resolvedDefault.trim() ? clean || undefined : undefined;
}
