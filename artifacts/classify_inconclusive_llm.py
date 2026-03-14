#!/usr/bin/env python3
"""
Classify INCONCLUSIVE bug entries using Claude API (claude-sonnet-4-5).
Sends batches of 25 entries per API call for efficiency.
"""

import json
import os
import sys
import time
from pathlib import Path

import anthropic

# --- Config ---
MODEL = "claude-sonnet-4-5-20250514"
BATCH_SIZE = 25
MAX_RETRIES = 5
BASE_DIR = Path("/private/tmp/verify_dashboard")
RESULTS_FILE = BASE_DIR / "results_all.json"
BASELINE_FILE = BASE_DIR / "realbug_baseline.json"
OUTPUT_FILE = BASE_DIR / "inconclusive_llm_classified.json"

CATEGORIES = [
    "raw_response_in_error",
    "raise_for_status_before_custom_handler",
    "missing_conditional_validation",
    "url_path_not_encoded",
    "response_structure_mismatch",
    "response_json_on_non_json",
    "wrong_data_semantics",
    "missing_input_validation",
    "pydantic_type_mismatch",
    "parameter_silently_dropped",
    "wrong_parameter_handling",
    "silent_error_suppression",
    "nested_dict_as_query_param",
    "wrong_url_path",
    "exclude_none_blocks_clearing",
    "graphql_string_injection",
    "wrong_field_name",
    "pydantic_alias_serialization",
    "unhandled_response_format",
    "error_info_leak",
    "default_value_fabrication",
    "wrong_success_check",
    "truthiness_drops_falsy",
    "hardcoded_value_overrides_input",
    "content_type_mismatch",
    "action_noop",
    "hardcoded_region_or_endpoint",
    "wrong_exception_caught",
    "pagination_broken",
    "csv_format_not_implemented",
    "ssl_verification_disabled",
    "substring_operator_detection",
    "auth_handling_error",
    "streaming_not_handled",
    "broken_fallback_logic",
    "wrong_http_method",
    "graphql_incomplete_query",
    "other",
]

CATEGORY_DESCRIPTIONS = """
1. raw_response_in_error — Error handler returns raw response object instead of parsed error message
2. raise_for_status_before_custom_handler — Calls raise_for_status() before custom error handling, bypassing it
3. missing_conditional_validation — Missing validation for required conditional parameters
4. url_path_not_encoded — URL path components not properly encoded (spaces, special chars)
5. response_structure_mismatch — Code assumes wrong response JSON structure (wrong key names, nesting)
6. response_json_on_non_json — Calls .json() on response that may not be JSON (204, text, etc.)
7. wrong_data_semantics — Uses data field with wrong semantic meaning
8. missing_input_validation — Required input parameters not validated before use
9. pydantic_type_mismatch — Pydantic model field type doesn't match actual API data type
10. parameter_silently_dropped — Parameter accepted but never sent to the API
11. wrong_parameter_handling — Parameter processed/transformed incorrectly
12. silent_error_suppression — Errors caught and silently swallowed with no logging
13. nested_dict_as_query_param — Nested dict passed as query parameter (serializes to string)
14. wrong_url_path — URL path is incorrect (wrong endpoint, missing segments)
15. exclude_none_blocks_clearing — exclude_none prevents sending explicit null/empty to clear a field
16. graphql_string_injection — User input interpolated directly into GraphQL query string
17. wrong_field_name — Uses wrong field name in request or response handling
18. pydantic_alias_serialization — Pydantic alias not used during serialization (by_alias=True missing)
19. unhandled_response_format — Response format not handled (pagination, envelope, etc.)
20. error_info_leak — Leaks sensitive info (tokens, keys) in error messages
21. default_value_fabrication — Fabricates default values instead of requiring user input
22. wrong_success_check — Checks wrong field/status for success determination
23. truthiness_drops_falsy — Uses truthiness check that drops valid falsy values (0, "", False)
24. hardcoded_value_overrides_input — Hardcoded value overrides user-provided input
25. content_type_mismatch — Wrong Content-Type header for the request body format
26. action_noop — Action does nothing useful (empty body, returns static data)
27. hardcoded_region_or_endpoint — Region or endpoint URL is hardcoded instead of configurable
28. wrong_exception_caught — Catches wrong exception type, missing the real errors
29. pagination_broken — Pagination logic is broken (wrong cursor, missing loop, etc.)
30. csv_format_not_implemented — CSV/file format handling not properly implemented
31. ssl_verification_disabled — SSL certificate verification is disabled
32. substring_operator_detection — Uses substring matching that can match wrong operators
33. auth_handling_error — Authentication/authorization handling is incorrect
34. streaming_not_handled — Streaming response not properly handled
35. broken_fallback_logic — Fallback/default logic is broken or unreachable
36. wrong_http_method — Uses wrong HTTP method (GET vs POST, etc.)
37. graphql_incomplete_query — GraphQL query missing required fields or fragments
38. other — Does not fit any of the above categories
"""


def build_prompt(batch_entries):
    """Build a classification prompt for a batch of entries."""
    entries_text = []
    for i, entry in enumerate(batch_entries):
        scanner = entry.get("scanner_feedback", "") or ""
        explanation = entry.get("explanation", "") or ""
        app = entry.get("app", "unknown")
        action = entry.get("action", "unknown")
        evidence = entry.get("evidence", "") or ""

        # Truncate very long fields
        scanner = scanner[:500]
        explanation = explanation[:500]
        evidence = evidence[:300]

        entries_text.append(
            f"[{i}] app={app} action={action}\n"
            f"  scanner_feedback: {scanner}\n"
            f"  explanation: {explanation}\n"
            f"  evidence: {evidence}"
        )

    entries_block = "\n\n".join(entries_text)

    return f"""You are classifying bug scanner findings into categories. Each entry describes a bug found by an automated scanner in a Composio integration action. The verification agent marked these as INCONCLUSIVE.

Based on the scanner_feedback, explanation, and evidence, classify each entry into exactly ONE of these 38 categories:

{CATEGORY_DESCRIPTIONS}

Here are {len(batch_entries)} entries to classify:

{entries_block}

Return a JSON array of exactly {len(batch_entries)} strings, where each string is the category name for the corresponding entry. Example: ["other", "raw_response_in_error", "missing_input_validation", ...]

Return ONLY the JSON array, no other text."""


def classify_batch(client, batch_entries, batch_num, total_batches):
    """Classify a batch of entries using Claude API with retries."""
    prompt = build_prompt(batch_entries)

    for attempt in range(MAX_RETRIES):
        try:
            response = client.messages.create(
                model=MODEL,
                max_tokens=2048,
                messages=[{"role": "user", "content": prompt}],
            )
            text = response.content[0].text.strip()

            # Parse JSON - handle markdown code blocks
            if text.startswith("```"):
                text = text.split("\n", 1)[1]
                text = text.rsplit("```", 1)[0].strip()

            categories = json.loads(text)

            if not isinstance(categories, list) or len(categories) != len(batch_entries):
                print(f"  WARNING batch {batch_num}: expected {len(batch_entries)} results, got {len(categories) if isinstance(categories, list) else 'non-list'}")
                if isinstance(categories, list) and len(categories) > 0:
                    # Pad or truncate
                    while len(categories) < len(batch_entries):
                        categories.append("other")
                    categories = categories[: len(batch_entries)]
                else:
                    raise ValueError("Invalid response format")

            # Validate categories
            valid = set(CATEGORIES)
            categories = [c if c in valid else "other" for c in categories]

            return categories

        except anthropic.AuthenticationError as e:
            print(f"  FATAL: Authentication error - invalid API key: {e}")
            sys.exit(1)
        except anthropic.RateLimitError:
            wait = 2 ** (attempt + 1)
            print(f"  Rate limited on batch {batch_num}, waiting {wait}s...")
            time.sleep(wait)
        except anthropic.APIStatusError as e:
            if e.status_code == 529:  # Overloaded
                wait = 2 ** (attempt + 1)
                print(f"  API overloaded on batch {batch_num}, waiting {wait}s...")
                time.sleep(wait)
            else:
                print(f"  API error on batch {batch_num}: {e}")
                if attempt == MAX_RETRIES - 1:
                    return ["other"] * len(batch_entries)
                time.sleep(2)
        except (json.JSONDecodeError, ValueError) as e:
            print(f"  Parse error on batch {batch_num} (attempt {attempt+1}): {e}")
            if attempt == MAX_RETRIES - 1:
                return ["other"] * len(batch_entries)
            time.sleep(1)
        except UnicodeEncodeError as e:
            print(f"  FATAL: Unicode encoding error (likely corrupted API key): {e}")
            sys.exit(1)
        except Exception as e:
            print(f"  Unexpected error on batch {batch_num}: {type(e).__name__}: {e}")
            if attempt == MAX_RETRIES - 1:
                return ["other"] * len(batch_entries)
            time.sleep(2)

    return ["other"] * len(batch_entries)


def clean_api_key(key):
    """Strip non-ASCII characters from API key (handles corrupted .env files)."""
    return "".join(c for c in key if ord(c) < 128).strip()


def main():
    # Check API key
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        # Try common file locations
        for path in [
            Path.home() / ".anthropic" / "api_key",
            Path.home() / ".config" / "anthropic" / "api_key",
        ]:
            if path.exists():
                api_key = path.read_text().strip()
                break

    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY not found in environment or common locations.")
        print("Set it with: export ANTHROPIC_API_KEY=sk-ant-...")
        sys.exit(1)

    # Clean non-ASCII characters from key
    api_key = clean_api_key(api_key)

    client = anthropic.Anthropic(api_key=api_key)

    # Load data
    print("Loading data...")
    with open(RESULTS_FILE) as f:
        all_data = json.load(f)

    inconclusive = [e for e in all_data if e.get("verdict") == "INCONCLUSIVE"]
    print(f"Total entries: {len(all_data)}, INCONCLUSIVE: {len(inconclusive)}")

    # Load baseline
    with open(BASELINE_FILE) as f:
        baseline = json.load(f)

    # Resume from checkpoint if available
    checkpoint_file = BASE_DIR / "inconclusive_llm_checkpoint.json"
    all_classifications = []
    start_batch = 0

    if checkpoint_file.exists():
        with open(checkpoint_file) as f:
            checkpoint = json.load(f)
        all_classifications = checkpoint.get("classifications", [])
        start_batch = len(all_classifications) // BATCH_SIZE
        print(f"Resuming from checkpoint: {len(all_classifications)} entries already classified (batch {start_batch})")

    # Process in batches
    total_batches = (len(inconclusive) + BATCH_SIZE - 1) // BATCH_SIZE
    print(f"Processing {total_batches} batches of ~{BATCH_SIZE} entries...")

    start_time = time.time()

    for batch_num in range(start_batch, total_batches):
        batch_start = batch_num * BATCH_SIZE
        batch_end = min(batch_start + BATCH_SIZE, len(inconclusive))
        batch = inconclusive[batch_start:batch_end]

        categories = classify_batch(client, batch, batch_num + 1, total_batches)
        all_classifications.extend(categories)

        # Save checkpoint every 10 batches
        if (batch_num + 1) % 10 == 0:
            with open(checkpoint_file, "w") as f:
                json.dump({"classifications": all_classifications}, f)
            print(f"  [checkpoint saved at batch {batch_num+1}]")

        elapsed = time.time() - start_time
        rate = (batch_num + 1) / elapsed * 60 if elapsed > 0 else 0
        print(f"  Batch {batch_num+1}/{total_batches} done ({batch_end}/{len(inconclusive)}) [{rate:.1f} batches/min]")

    # Build results
    print("\nBuilding results...")
    per_entry = []
    category_counts = {}

    for i, entry in enumerate(inconclusive):
        cat = all_classifications[i] if i < len(all_classifications) else "other"
        per_entry.append({
            "app": entry.get("app", "unknown"),
            "action": entry.get("action", "unknown"),
            "predicted_category": cat,
            "scanner_feedback": entry.get("scanner_feedback", ""),
        })
        category_counts[cat] = category_counts.get(cat, 0) + 1

    # Sort distribution
    sorted_dist = sorted(category_counts.items(), key=lambda x: -x[1])
    classified_count = sum(v for k, v in sorted_dist if k != "other")
    other_count = category_counts.get("other", 0)

    # Build baseline comparison
    baseline_dist = {
        item["category"]: item for item in baseline.get("category_distribution", [])
    }

    comparison = []
    for cat, count in sorted_dist:
        bl = baseline_dist.get(cat, {})
        comparison.append({
            "category": cat,
            "inconclusive_count": count,
            "inconclusive_pct": round(count / len(inconclusive) * 100, 2),
            "realbug_count": bl.get("count", 0),
            "realbug_pct": bl.get("pct_of_realbugs", 0),
        })

    output = {
        "total_inconclusive": len(inconclusive),
        "classified_count": classified_count,
        "other_count": other_count,
        "classified_pct": round(classified_count / len(inconclusive) * 100, 2),
        "model": MODEL,
        "batch_size": BATCH_SIZE,
        "predicted_category_distribution": [
            {"category": cat, "count": count, "pct": round(count / len(inconclusive) * 100, 2)}
            for cat, count in sorted_dist
        ],
        "comparison_with_realbug": comparison,
        "per_entry_classifications": per_entry,
    }

    with open(OUTPUT_FILE, "w") as f:
        json.dump(output, f, indent=2)
        f.write("\n")

    # Clean up checkpoint
    if checkpoint_file.exists():
        checkpoint_file.unlink()
        print("Checkpoint file removed.")

    print(f"\nResults saved to {OUTPUT_FILE}")
    print(f"\n{'='*60}")
    print(f"SUMMARY")
    print(f"{'='*60}")
    print(f"Total INCONCLUSIVE:  {len(inconclusive)}")
    print(f"Classified (non-other): {classified_count} ({classified_count/len(inconclusive)*100:.1f}%)")
    print(f"Other:               {other_count} ({other_count/len(inconclusive)*100:.1f}%)")
    print(f"\nTop categories:")
    for cat, count in sorted_dist[:15]:
        pct = count / len(inconclusive) * 100
        bl = baseline_dist.get(cat, {})
        bl_pct = bl.get("pct_of_realbugs", 0)
        bar = "#" * int(pct)
        print(f"  {cat:45s} {count:5d} ({pct:5.1f}%)  real: {bl_pct:5.1f}%  {bar}")

    elapsed = time.time() - start_time
    print(f"\nCompleted in {elapsed:.0f}s ({elapsed/60:.1f} min)")


if __name__ == "__main__":
    main()
