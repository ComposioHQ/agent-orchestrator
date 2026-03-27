# ETag Strategy - Mermaid Dataflow Diagram

```mermaid
flowchart TD
    Start([Start Poll Cycle<br/>Every 30s]) --> GetSessions[Get Active Sessions]

    GetSessions --> CollectPRs[Collect PRs from Sessions]
    CollectPRs --> Deduplicate[Group by Repo<br/>Deduplicate PRs]

    Deduplicate --> Guard1{Guard 1:<br/>PR List ETag Check}

    Guard1 -->|Per Repo| GetRepoETag[GET /repos/owner/repo/pulls<br/>With If-None-Match header]

    GetRepoETag --> RepoETagDecision{Response?}

    RepoETagDecision -->|304 Not Modified| Repo304[Repo ETag: 304<br/>Cost: 0 points ✅]
    RepoETagDecision -->|200 OK| Repo200[Repo ETag: 200<br/>Cost: 1 point<br/>PRs changed]

    Repo304 --> Guard2{Guard 2:<br/>Commit Status Check}
    Repo200 --> Guard2

    Guard2 -->|Per Pending CI PR| GetCommitETag[GET /repos/owner/repo/<br/>commits/sha/status<br/>With If-None-Match header]

    GetCommitETag --> CommitETagDecision{Response?}

    CommitETagDecision -->|304 Not Modified| Commit304[Commit ETag: 304<br/>Cost: 0 points ✅]
    CommitETagDecision -->|200 OK| Commit200[Commit ETag: 200<br/>Cost: 1 point<br/>CI changed]

    Repo304 --> CheckPRList{PR List Changed?}
    Commit304 --> CheckPRList

    Repo200 --> HasPRChanges[Mark PRs as Changed]
    HasPRChanges --> CheckPRList

    Commit200 --> HasCIChanges[Mark PRs with CI Changes]
    HasCIChanges --> CheckPRList

    CheckPRList -->|No Changes| UseCache[SKIP GraphQL<br/>Use Cached Data<br/>Total Cost: 0 points]
    CheckPRList -->|Changes Detected| GraphQL[GraphQL Batch<br/>Only Changed PRs]

    UseCache --> End([End Poll<br/>Continue Sessions])
    GraphQL --> End

    %% Subgraph for detail
    subgraph Guard1Detail["Guard 1: PR List ETag"]
        direction TB
        G1Start[First Poll] --> G1Fetch1[Fetch PR List<br/>Store ETag]
        G1Fetch1 --> G1Wait[Wait 30s]

        G1Wait --> G1Fetch2[Fetch PR List<br/>With If-None-Match]
        G1Fetch2 --> G1Check{Response?}

        G1Check -->|304| G1304[No Change<br/>Cost: 0]
        G1Check -->|200| G1200[PR Metadata Changed<br/>Cost: 1 point]
    end

    subgraph Guard2Detail["Guard 2: Commit Status"]
        direction TB
        G2Start[For each PR<br/>with pending CI] --> G2Fetch[Get Commit Status<br/>With If-None-Match]
        G2Fetch --> G2Check{Response?}

        G2Check -->|304| G2304[CI Unchanged<br/>Cost: 0]
        G2Check -->|200| G2200[CI Status Changed<br/>Cost: 1 point]
    end
```

## Combined Decision Table

```mermaid
graph LR
    subgraph Decision["Decision Logic"]
        D1[Guard 1:<br/>PR List ETag]
        D2[Guard 2:<br/>Commit Status ETag]

        D1 -->|Result|
        D2 -->|Result|

        subgraph Results["Outcomes"]
            R1[Both 304]
            R2[PR 200]
            R3[CI 200]
            R4[Any 200]
        end

        |Result| --> R1
        |Result| --> R2
        |Result| --> R3
        |Result| --> R4

        subgraph Actions["Actions"]
            A1[Skip GraphQL<br/>Cost: 0 points ✅]
            A2[GraphQL Batch PRs<br/>Cost: ~10-50 points]
        end

        R1 --> A1
        R2 --> A2
        R3 --> A2
        R4 --> A2
    end
```

## Cost Flow per Poll Cycle

```mermaid
pie title Cost Distribution (Typical 90% Idle)
    "Free 304 Responses" : 90
    "PR Metadata Changes" : 7
    "CI Status Changes" : 3
```

## Architecture Overview

```mermaid
flowchart LR
    subgraph GitHub["GitHub REST API"]
        direction TB
        REST1["/repos/owner/repo/pulls<br/>PR List"]
        REST2["/repos/owner/repo/<br/>commits/sha/status<br/>CI Status"]
        REST3["/repos/owner/repo/<br/>graphql<br/>GraphQL Batch"]
    end

    subgraph AgentOrchestrator["Agent Orchestrator"]
        direction TB
        Cache[(Persistent ETag Cache)]
        Decision{Decision Engine}
        Sessions[(Active Sessions)]
    end

    Sessions --> Decision
    Cache --> Decision

    Decision -->|Check PR List| REST1
    Decision -->|Check CI Status| REST2
    Decision -->|Fetch PR Data| REST3

    REST1 -->|304| Decision
    REST1 -->|200| Cache

    REST2 -->|304| Decision
    REST2 -->|200| Cache

    REST3 --> Cache
```

## Example Timeline: 4 Poll Cycles

```mermaid
gantt
    title ETag Strategy Poll Cycles (10 Sessions)
    dateFormat X
    axisFormat %s

    section Poll 1 (30s)
    Initial      :done, init1, 30s, GraphQL Batch (10 PRs) :50 pts

    section Poll 2 (60s)
    Guard1       :done, g1, 5 REST calls, All 304 :0 pts
    Guard2       :done, g2, 1 REST call, 304 :0 pts
    Decision     :crit, d1, SKIP GraphQL :0 pts

    section Poll 3 (90s)
    Guard1       :done, g1, 5 REST calls, All 304 :0 pts
    Guard2       :done, g2, 1 REST call, 200 :1 pts
    Decision     :crit, d2, GraphQL Batch (1 PR) :10 pts

    section Poll 4-12 (120-360s)
    Quiet        :active, q, 36 REST calls, All 304 :0 pts each
```

## Guard Coverage Matrix

```mermaid
graph TD
    subgraph Events["Events to Detect"]
        E1[New Commits]
        E2[PR Title Edit]
        E3[Review Submitted]
        E4[CI Check Starts]
        E5[CI Check Passes]
        E6[CI Check Fails]
    end

    subgraph Guards["Guard Detection"]
        G1[Guard 1:<br/>PR List ETag]
        G2[Guard 2:<br/>Commit Status ETag]
    end

    E1 --> G1
    E2 --> G1
    E3 --> G1
    E4 --> G2
    E5 --> G2
    E6 --> G2

    G1 -.->|Misses CI| E4
    G1 -.->|Misses CI| E5
    G1 -.->|Misses CI| E6

    G2 -->|Catches| G1
```
