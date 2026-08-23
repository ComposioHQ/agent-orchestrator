export type CloudCredentialProvider = "claude-code";

/** Renderer-safe metadata. This type cannot represent credential material. */
export interface CloudCredentialStatus {
	connected: boolean;
	provider: CloudCredentialProvider;
	credentialType?: "oauth_token" | "api_key" | "access_token";
	updatedAt?: string;
}
