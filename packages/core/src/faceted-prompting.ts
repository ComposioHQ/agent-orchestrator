export interface PromptFacet {
  content: string;
  sourcePath?: string;
}

export interface FacetedPromptInput {
  persona?: PromptFacet;
  policies?: PromptFacet[];
  knowledge?: PromptFacet[];
  instruction?: PromptFacet;
  outputContract?: PromptFacet;
  maxFacetChars?: number;
}

export interface FacetedPromptResult {
  systemPrompt: string;
  userMessage: string;
}

function normalizeFacet(facet: PromptFacet, maxChars: number): string {
  if (facet.content.length <= maxChars) return facet.content.trim();
  const sourceHint = facet.sourcePath ? ` (full source: ${facet.sourcePath})` : "";
  return `${facet.content.slice(0, maxChars).trim()}\n...[truncated]${sourceHint}`;
}

function joinFacetBlock(title: string, facets: PromptFacet[] | undefined, maxChars: number): string {
  if (!facets || facets.length === 0) return "";
  const body = facets.map((facet) => normalizeFacet(facet, maxChars)).join("\n\n---\n\n");
  return `## ${title}\n${body}`;
}

export function composeFacetedPrompt(input: FacetedPromptInput): FacetedPromptResult {
  const maxChars = input.maxFacetChars ?? 2000;
  const persona = input.persona ? normalizeFacet(input.persona, maxChars) : "";
  const policies = input.policies ?? [];
  const knowledge = input.knowledge ?? [];

  const policyBlock = joinFacetBlock("Policy", policies, maxChars);
  const knowledgeBlock = joinFacetBlock("Knowledge", knowledge, maxChars);
  const instructionBlock = input.instruction
    ? joinFacetBlock("Instruction", [input.instruction], maxChars)
    : "";
  const outputContractBlock = input.outputContract
    ? joinFacetBlock("Output Contract", [input.outputContract], maxChars)
    : "";

  const middleSections = [knowledgeBlock, instructionBlock, outputContractBlock].filter(Boolean);
  const userParts: string[] = [];
  if (policyBlock) userParts.push(policyBlock);
  if (middleSections.length > 0) userParts.push(...middleSections);
  if (policyBlock) userParts.push(policyBlock);

  return {
    systemPrompt: persona,
    userMessage: userParts.join("\n\n"),
  };
}

