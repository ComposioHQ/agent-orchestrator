export interface CloudAccount {
	authProvider: "workos";
	user: {
		id: string;
		email: string;
		displayName: string;
	};
	storedAt: string;
}
