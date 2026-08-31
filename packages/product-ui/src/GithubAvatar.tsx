import { UserAvatar } from "./UserAvatar";

export type GithubAvatarProps = {
	login: string;
	className?: string;
};

export function GithubAvatar({ login, className }: GithubAvatarProps) {
	const normalizedLogin = login.replace(/^@/, "").trim();
	const avatarURL = normalizedLogin
		? `https://avatars.githubusercontent.com/${encodeURIComponent(normalizedLogin)}?size=64`
		: "";
	return <UserAvatar className={className} imageUrl={avatarURL} name={normalizedLogin} />;
}
