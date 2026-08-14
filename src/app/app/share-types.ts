export type ProjectShareModeCap = "read-only" | "standard" | "trusted";

export type ProjectShareLink = {
  id: string;
  token?: string;
  sessionId?: string;
  status: "active" | "revoked" | string;
  accessScope: "anyone" | "restricted";
  recipients: string[];
  modeCap?: ProjectShareModeCap;
};

export type SharedProject = {
  project: { id: string; orgId: string; displayName: string };
  grant: {
    id: string;
    role: string;
    userEmail?: string;
    userDisplayName?: string;
  };
  sessionId?: string;
  sessionName?: string;
};

export type OrganizationMember = {
  userId: string;
  email: string;
  displayName?: string;
  role: string;
};

export type OrganizationInvitation = {
  id: string;
  email: string;
  role: "member" | "admin" | "owner";
  status: "pending" | "revoked" | string;
  expiresAt: string;
};

export type CreateInvitationInput = {
  email: string;
  role: "member" | "admin";
};
