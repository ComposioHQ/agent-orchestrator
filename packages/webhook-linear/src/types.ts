export interface LinearLabel {
  id: string;
  name: string;
}

export interface LinearState {
  id: string;
  name: string;
  type: string;
}

export interface LinearWebhookPayload {
  action: "create" | "update" | "remove";
  type: "Issue" | "IssueLabel" | "Comment" | "Project" | string;
  data: {
    id: string;
    identifier: string;
    title: string;
    description?: string;
    state?: LinearState;
    team?: {
      id: string;
      key: string;
      name: string;
    };
    labels?: LinearLabel[];
    labelIds?: string[];
  };
  updatedFrom?: {
    stateId?: string;
    labelIds?: string[];
    state?: LinearState;
  };
}

export type SpawnType = "code" | "test-gen" | "merge";
